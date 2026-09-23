/**
 * Serial-queue executor for gateway third-party plugin mutations (design 21
 * §6.2/§6.3).
 *
 * Enqueue contract: one op per profile mutation, durably journaled (write
 * order ① in plugins-journal.ts) before it is queued; a single worker drains
 * the queue serially — one mutation at a time. Duplicate ops (same kind+name
 * already pending or running) fast-fail with queue_busy; the queue depth is
 * capped (queue_full beyond 8). `canRun()` (the runtime single-writer fence /
 * execution window, design 21 decision 6/7) gates each dequeue: a closed
 * window is polled for up to CAN_RUN_WAIT_MAX_MS (a queued op must never be
 * dropped just because a runtime mutation was in flight at its dequeue
 * instant); only when the window stays closed past the bound is the op marked
 * blocked — never dropped.
 *
 * runMutation per op (design 21 §6.3 write order ②→④):
 *   (1) pre-mutation backup — `<stateDir>/dsh-home/profiles/web/package.json`
 *       (+ pnpm-lock.yaml when present) is copied atomically (0600) into
 *       backups/<op-id>/ and durably referenced via journal.recordPreImage,
 *       BEFORE anything mutates the profile;
 *   (2) statusProbe re-check — 'starting'/'restarting' refuses the mutation
 *       (skips the spawn; recorded failed with 'instance is
 *       starting/restarting');
 *   (3) env discipline (design 21 §6.3): argv is the managed
 *       dsh CLI `plugin --profile web add|remove …`; the child env keeps
 *       ONLY what pnpm/network needs — PATH + the proxy family (the same
 *       canonical whitelist the dsh-runtime installer uses,
 *       INSTALL_ENV_WHITELIST) — every other ambient variable (DSH_GATEWAY_*
 *       control vars, npm_config_* / NPM_* token carriers AND any other secret
 *       carrier such as NODE_AUTH_TOKEN that lifecycle scripts or pnpm could
 *       read) is DROPPED. DSH_HOME and the private XDG_CACHE_HOME /
 *       XDG_CONFIG_HOME dirs (0700) are pinned under stateDir, and both
 *       NPM_CONFIG_USERCONFIG casings (upper + lower) point at one empty
 *       0600 file — the operator's real ~/.npmrc and global pnpm config are
 *       never consulted by install children (profile .npmrc stays untrusted
 *       input; lifecycle scripts are allowed, design 21 decision 13 — no
 *       ignore-scripts). HOME is deliberately NOT pinned: pnpm derives its
 *       DEFAULT store from the effective home, and the managed profile was
 *       provisioned under the same effective home (see ensurePrivateRunEnv /
 *       §6.3 ⑨) — a pinned HOME silently moves the store and pnpm 11 refuses
 *       every mutation against the provisioned profile;
 *   (4) spawn through the SHARED control-plane restricted-mutation executor
 *       (plugin-mutation-executor.ts — the single implementation of the
 *       bounded stdout/stderr capture, timeout TERM→KILL on the process
 *       group and terminal-text vocabulary; design 21 §6.3), with the
 *       gateway's own sanitizer and the spawned child's pid durably journaled
 *       (markChildPid) so a gateway crash mid-mutation leaves a reapable
 *       record for the next boot's reconcile;
 *   (5) post-mutation probe re-check (design 21 §6.3 pre/post double check):
 *       a successful mutation is re-verified before it is recorded ok — an
 *       instance that entered 'starting'/'restarting' mid-mutation fails the
 *       op ('instance (re)started during the mutation; verify plugin state
 *       and retry') instead of pretending success.
 *
 * The spawn seam is injectable; production code never runs a real dsh CLI in
 * unit tests. dispose() stops acceptance, kills the in-flight child and
 * waits for the worker; workerBusy() reports an in-flight mutation.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  atomicWritePrivateFileNoFollow,
  decidePluginMutation,
  describeFamilyFindings,
  registrySpecVersion,
  resolveRuntimeFamily,
  verifyProfileFamilyConsistency,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
  runPluginMutation,
  scrubMutationEnv,
  spawnMutationChild,
} from '@dsh-chamber/control-plane'
import type { MutationChild, MutationSpawnFn } from '@dsh-chamber/control-plane'
import { INSTALL_ENV_WHITELIST, sanitizeInstallerOutput } from '@dsh-chamber/dsh-runtime'
import { sanitizeRouteError } from './sanitize-route-error.ts'
import { messageOf } from './util.ts'
import {
  deriveBootProtectedSet,
  gatewayProtectedSet,
  INSTALLED_PROFILE_DIR,
  INSTALLED_MANIFEST_MAX_BYTES,
  MANAGED_DSH_HOME_DIR,
} from './plugins-installed.ts'
import { backupDirFor, thirdPartyRoot } from './plugins-journal.ts'
import {
  judgeUndo,
  PROFILE_LOCKFILE_MAX_BYTES,
  readUndoPreImage,
  restoreUndoPreImage,
} from './plugins-undo.ts'
import { ensurePnpmOnPath, withPnpmOnPath } from './pnpm-entry.ts'
import type { JournalLogger, JournalOp, JournalOpKind, JournalPending, JournalTerminalPatch, PluginsJournal } from './plugins-journal.ts'
import type { FamilyVersions, PluginRefusalCode } from '@dsh-chamber/control-plane'

/** Queue depth cap (design 21 §6.9: queue depth ≤ 8). */
export const PLUGIN_QUEUE_CAP = 8
/** Execution-window wait bound (design 21 decision 6/7): a dequeued op
 * whose canRun() gate is closed polls for the window
 * to open for up to this long before it is marked blocked ('runtime busy;
 * retry later') — a queued op must never be dropped just because a runtime
 * mutation happened to be in flight at its dequeue instant. */
export const CAN_RUN_WAIT_MAX_MS = 120_000
/** canRun() re-check cadence during the execution-window wait. */
export const CAN_RUN_POLL_MS = 250
/** Grace between SIGTERM and SIGKILL on dispose (the per-mutation timeout
 * grace belongs to the shared control-plane executor). */
export const SIGNAL_GRACE_MS = 1000
/** Byte cap for op/journal error text (design 21 §6.3 sanitize discipline,
 * mirroring the dsh-runtime installer's FAILED_ERROR_LIMIT family): child
 * output and failure detail are sanitized AND bounded before they land in
 * the journal, whose tasks projection is served verbatim to clients. */
export const JOURNAL_ERROR_TEXT_MAX_BYTES = 2_000

/** StatusProbe states that refuse a mutation (skip spawn). */
export const REFUSED_PROBE_STATES = ['starting', 'restarting'] as const

export const ERROR_RUNTIME_BUSY = 'runtime busy; retry later'
export const ERROR_STARTING = 'instance is starting/restarting'
export const ERROR_RESTARTED_DURING_MUTATION = 'instance (re)started during the mutation; verify plugin state and retry'
/** Post-install family verification failure (design 21 §6.11.4). */
export const ERROR_FAMILY_DRIFT = 'installed, but the profile tree no longer matches the instance runtime'
export const ERROR_DUPLICATE_PENDING = 'duplicate operation pending'
/** The undo verb's honest refusal when the journal no longer carries the
 * bound target as an ok op with a preImage backup (design 21 §6.3/§6.8 r2). */
export const ERROR_NO_UNDOABLE_OP = 'no undoable plugin operation is recorded'

/** StatusProbe states during which a mutation must neither start nor be
 * recorded as ok (design 21 §6.3 pre/post double check). */
function isRefusedProbeState(state: string): boolean {
  return (REFUSED_PROBE_STATES as readonly string[]).includes(state)
}

/** Journal methods the executor drives. markChildPid is optional on the
 * surface so minimal fakes stay compatible; the real journal implements it. */
export type JournalSurface = Pick<PluginsJournal, 'appendPending' | 'recordPreImage' | 'markTerminal' | 'recent'> & {
  markChildPid?(opId: string, pid: number): void
}

/** Terminal callback invoked once per op after its journal terminal state
 * was recorded (including ops blocked by dispose()). Receives the recorded
 * op and the terminal status — the orchestrator releases its per-op
 * profile-write lease here (the executor has no other terminal seam). */
export type OnOpTerminal = (op: JournalOp, terminalStatus: 'ok' | 'failed' | 'blocked') => void

/** Default error-text sanitizer for every executor/journal error string
 * (design 21 §6.3): registry URLs are reduced to their origin (userinfo /
 * query / path capability tokens removed), named secrets redacted, absolute
 * paths removed, then byte-bounded — the dsh-runtime
 * sanitizeInstallerOutput family, applied before an error can reach the
 * journal (whose tasks projection is served verbatim to clients). */
export const defaultSanitize = (text: string): string =>
  sanitizeInstallerOutput(text, JOURNAL_ERROR_TEXT_MAX_BYTES)

export type EnqueueRejection = { ok: false; code: 'queue_full' | 'queue_busy' | 'persistence_failed'; error: string }
export type EnqueueResult = { ok: true; opId: string } | EnqueueRejection

interface QueueItem extends JournalPending {
  opId: string
  /** Per-op terminal callback (enqueue-time, BEFORE the worker can process
   * the item — the orchestrator passes its lease release here so a
   * terminal that fires synchronously inside enqueue can never be missed). */
  terminal?: OnOpTerminal
}

export interface PluginExecDeps {
  stateDir: string
  /** Path to the managed dsh CLI executable (resolved by the wiring layer). */
  dshCliPath: string
  journal: JournalSurface
  /** Current connectionState projection; 'starting'/'restarting' refuses. */
  statusProbe: () => string
  logger: JournalLogger
  spawn?: MutationSpawnFn
  timeoutMs?: number
  /** Execution-window gate (design 21 decision 6/7): while it answers false
   * the worker polls it at canRunPollMs for up to canRunWaitMaxMs before the
   * op is marked blocked — a window that opens in time lets the op run. A
   * throwing gate is treated as closed. Defaults to allowing. */
  canRun?: () => boolean
  /** Execution-window wait bound (tests inject a short bound; production
   * keeps CAN_RUN_WAIT_MAX_MS). */
  canRunWaitMaxMs?: number
  /** Execution-window re-check cadence (tests inject a short cadence;
   * production keeps CAN_RUN_POLL_MS). */
  canRunPollMs?: number
  /** Shared terminal fallback: fires once per op (when enqueue was called
   * without a per-op hook) AFTER its journal terminal state was recorded
   * (ok/failed/blocked, including dispose-time blocks). The orchestrator
   * passes its lease release PER OP via enqueue() — registration before the
   * worker can process the item is race-free; this fallback serves
   * standalone/test callers. */
  onTerminal?: OnOpTerminal
  /** Per-op runtime facts (design 21 §6.11.3/§6.11.4): the ACTIVE workspace path
   *  + its effective version. Lazy (resolved per op) so a runtime switch between
   *  ops is honored; the accessor may throw (corrupt override/pointer metadata)
   *  and every call site guards it. Absent ⇒ no family facts (the decision
   *  degrades conservatively, the verification is skipped loudly). */
  runtimeFacts?: () => { path: string; version: string | null } | null
  /** Per-op real-CLI launch resolution (design 21 §6.3): the managed dsh
   * CLI is spawned as `node <entry> plugin …` from the ACTIVE runtime
   * workspace (`resolveWorkspace`). Resolved at every spawn so a runtime
   * version switch between ops can never leave the queue launching a stale
   * entry; null/absent keeps the bare `dshCliPath` argv (standalone use and
   * tests). A throw fails the op loudly (never a silent fallback). */
  cliLaunch?: () => { argvPrefix: string[]; cwd?: string } | null
}

export interface PluginExec {
  /** Journal (①) then queue one mutation. Rejects fast on duplicate ops
   * (queue_busy) or a full queue (queue_full); never blocks on the worker.
   * An optional per-op terminal callback fires exactly once after the op's
   * journal terminal state was recorded (ok/failed/blocked, dispose-time
   * blocks included); without one the shared deps.onTerminal fallback
   * applies. */
  enqueue(input: JournalPending, onTerminal?: OnOpTerminal): Promise<EnqueueResult>
  /** Stop accepting ops, mark queued ops blocked, kill the in-flight child
   * and wait for the worker to settle. Idempotent. */
  dispose(): Promise<void>
  /** True while a mutation is in flight (drain/status seams). */
  workerBusy(): boolean
  /** Live op count (journaled, not yet terminal) — the drain seam uses it to
   * pace multi-wave deferred-intent draining against the queue cap. */
  pendingCount(): number
}

export function createPluginsExec(deps: PluginExecDeps): PluginExec {
  const stateDir = deps.stateDir
  const profileDir = join(stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR)
  const journal = deps.journal
  const statusProbe = deps.statusProbe
  const canRun = deps.canRun ?? (() => true)
  const timeoutMs = deps.timeoutMs
  const sanitize = defaultSanitize
  const log = deps.logger.log.bind(deps.logger)
  const warn = deps.logger.warn.bind(deps.logger)

  let disposed = false
  let killOnSpawn = false
  let wakeResolve: (() => void) | null = null
  const queue: QueueItem[] = []
  /** Ops appended to the journal and not yet terminal (dup + cap source). */
  const liveOps = new Map<string, { kind: JournalOpKind; name: string }>()
  let workerPromise: Promise<void> | null = null
  let current: { item: QueueItem; child: MutationChild | null } | null = null
  /** Wake handle for a pending execution-window poll (dispose() resolves it
   * so shutdown never waits out the poll cadence). */
  let pollWake: (() => void) | null = null

  function kickWorker(): void {
    if (wakeResolve !== null) {
      const resolve = wakeResolve
      wakeResolve = null
      resolve()
    }
  }

  /** Minimal terminal record synthesized when the journal could not record
   * the real one (see complete) — enough for lease-release hooks to run. */
  function terminalOf(item: QueueItem, patch: JournalTerminalPatch): JournalOp {
    const op: JournalOp = {
      id: item.opId,
      ts: Date.now(),
      kind: item.kind,
      name: item.name,
      preImage: null,
      status: patch.status,
    }
    if (item.spec !== undefined) op.spec = item.spec
    if (item.initiator !== undefined) op.initiator = item.initiator
    if (item.undoOf !== undefined) op.undoOf = item.undoOf
    if (patch.error !== undefined) op.error = patch.error
    return op
  }

  /** One op whose terminal state was recorded (or could not be). */
  function complete(item: QueueItem, patch: JournalTerminalPatch): void {
    const opId = item.opId
    let terminal: JournalOp | null = null
    try {
      terminal = journal.markTerminal(opId, patch)
      log(`plugins-exec: op ${opId} ${patch.status}`)
    } catch (error) {
      // The durable terminal record could not be written (ENOSPC/EACCES/
      // …). The op is still TERMINAL in this process, and the terminal hook
      // must fire regardless — a profile-write lease must never outlive its
      // op (design 21 §6.3 decision 6/17). The hook receives a synthesized
      // terminal record; the journal keeps the op pending, so the next
      // boot's reconcile marks it failed with the preImage retained (never
      // a silent success).
      warn(`plugins-exec: could not record terminal state for op ${opId}: ${messageOf(error)}`)
    } finally {
      liveOps.delete(opId)
    }
    // The terminal hook fires even when the journal write failed AND when
    // markTerminal answered null (the record was lost — e.g. the journal was
    // renamed aside as corrupt between the append and the terminal): a lease
    // must never outlive its op (the orchestrator maps the missing journal
    // record to a failed op at the next boot's reconcile).
    const hook = item.terminal ?? deps.onTerminal
    if (hook !== undefined) {
      try {
        hook(terminal ?? terminalOf(item, patch), patch.status)
      } catch (error) {
        warn(`plugins-exec: terminal hook failed for op ${opId}: ${messageOf(error)}`)
      }
    }
  }

  function ensureWorker(): void {
    if (workerPromise === null && !disposed) {
      workerPromise = (async () => {
        try {
          await runWorker()
        } catch (error) {
          warn(`plugins-exec: worker crashed: ${messageOf(error)}`)
        }
      })()
    }
  }

  /** Interruptible poll sleep: resolves at the deadline or as soon as
   * dispose() wakes it (whichever comes first). */
  function pollSleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(wake, ms)
      pollWake = wake
      function wake(): void {
        if (pollWake === wake) pollWake = null
        clearTimeout(timer)
        resolve()
      }
    })
  }

  /** One execution-window evaluation; a throwing gate is treated as closed. */
  function runWindowOpen(): boolean {
    try {
      return canRun() === true
    } catch {
      // A throwing execution-window gate is treated as closed.
      return false
    }
  }

  /**
   * Execution-window dequeue gate (design 21 decision 6/7): reached only
   * with a CLOSED window — the worker re-checks the gate every canRunPollMs
   * until the window opens ('run'), the wait bound elapses ('blocked' — the
   * op is marked blocked, never lost), or dispose() interrupts ('shutdown').
   */
  async function awaitRunWindow(): Promise<'run' | 'blocked' | 'shutdown'> {
    const waitMaxMs = deps.canRunWaitMaxMs ?? CAN_RUN_WAIT_MAX_MS
    const pollMs = Math.min(deps.canRunPollMs ?? CAN_RUN_POLL_MS, waitMaxMs)
    const deadline = Date.now() + waitMaxMs
    for (;;) {
      if (disposed) return 'shutdown'
      if (runWindowOpen()) return 'run'
      const remaining = deadline - Date.now()
      if (remaining <= 0) return 'blocked'
      await pollSleep(Math.min(pollMs, remaining))
    }
  }

  async function runWorker(): Promise<void> {
    while (true) {
      const item = queue.shift() ?? null
      if (item === null) {
        if (disposed) return
        await new Promise<void>(resolve => {
          wakeResolve = resolve
          // Re-check inside the executor so a dispose/enqueue that ran before
          // this promise was created can never be lost.
          if (disposed || queue.length > 0) {
            wakeResolve = null
            resolve()
          }
        })
        continue
      }
      current = { item, child: null }
      try {
        // Dequeue gate: the OPEN-window fast path is synchronous so a worker
        // wake → spawn stays race-free; a closed window is awaited within
        // the bounded poll (never a spawn mid-transaction), then the op is
        // marked blocked — dispose interrupts the wait and blocks the op.
        if (runWindowOpen()) {
          await runMutation(item)
        } else {
          const decision = await awaitRunWindow()
          if (decision === 'run') {
            await runMutation(item)
          } else {
            complete(item, decision === 'blocked'
              ? { status: 'blocked', error: ERROR_RUNTIME_BUSY }
              : { status: 'blocked', error: 'executor shut down before this operation ran' })
          }
        }
      } catch (error) {
        complete(item, { status: 'failed', error: sanitize(`mutation failed: ${messageOf(error)}`) })
      } finally {
        current = null
      }
    }
  }

  /** Private pnpm cache/xdg dirs (0700) + empty NPM_CONFIG_USERCONFIG file
   * (0600); (re)created before every run. HOME is deliberately NOT pinned
   * (and is dropped by the scrub whitelist): pnpm derives its DEFAULT store
   * from the effective home, and the managed profile's node_modules was
   * provisioned under the SAME effective home (the gateway spawns the dsh
   * child without HOME; pnpm falls back to the passwd home). A pinned HOME
   * silently moves pnpm's default store elsewhere, and pnpm 11 then refuses
   * every mutation against the provisioned profile ("pnpm now wants to use
   * the store at …"). Caches/config stay private via the XDG + userconfig
   * pins; the store itself remains the operator-home store the profile was
   * linked against. */
  function ensurePrivateRunEnv(): void {
    const thirdParty = thirdPartyRoot(stateDir)
    ensurePrivateDirectoryNoFollow(thirdParty, 0o700)
    for (const name of ['.pnpm-cache', '.pnpm-xdg']) {
      ensurePrivateDirectoryNoFollow(join(thirdParty, name), 0o700)
    }
    const npmrc = join(thirdParty, '.npmrc-empty')
    if (!existsSync(npmrc)) atomicWritePrivateFileNoFollow(npmrc, '', { mode: 0o600 })
  }

  /** Executor-side spawn seam: captures the child for dispose() kills and
   * durably records its pid on the pending journal op (design 21 §6.3
   * crash-orphan reaping) — a gateway crash mid-mutation leaves the detached
   * child writing DSH_HOME; the next boot's reconcileJournal() kills the
   * recorded pid before any new mutation can start. Best effort: a pid that
   * cannot be recorded only warns (the op itself is unaffected). */
  const childSpawn: MutationSpawnFn = (command, args, options) => {
    const child = (deps.spawn ?? spawnMutationChild)(command, args, options)
    if (current !== null) current.child = child
    const pid = child.pid
    if (pid !== undefined && current !== null) {
      try {
        journal.markChildPid?.(current.item.opId, pid)
      } catch (error) {
        warn(`plugins-exec: could not record child pid ${pid} for op ${current.item.opId}: ${messageOf(error)}`)
      }
    }
    // A mutation that starts while dispose() is already draining must never
    // outlive the shutdown: kill it the moment it appears.
    if (killOnSpawn) {
      try {
        child.kill('SIGTERM')
      } catch {
        // best effort
      }
    }
    return child
  }

  /** Lazy, guarded runtime facts (see PluginExecDeps.runtimeFacts). */
  function readRuntimeFacts(): { path: string; version: string | null } | null {
    if (deps.runtimeFacts === undefined) return null
    try {
      return deps.runtimeFacts()
    } catch (error) {
      warn(`plugins-exec: runtime facts unavailable: ${messageOf(error)}`)
      return null
    }
  }

  /**
   * The active family closure (F) **and** the versions this runtime provides
   * for its names (design 21 §6.11.3) — the post-install verification judges a
   * family member on the runtime's version facts when present, and only falls
   * back to the generation comparison for names without one. null = no facts.
   */
  function activeFamilyFacts(): { names: readonly string[]; versions: FamilyVersions } | null {
    const facts = readRuntimeFacts()
    if (facts === null) return null
    const family = resolveRuntimeFamily(facts.path)
    return family.ok ? { names: family.names, versions: family.versions } : null
  }

  /**
   * Execution-time re-judgement (design 21 §6.11.3): the submission-time
   * judgement used the facts of that moment, while the CLI launch below resolves
   * the workspace PER OP — an op queued behind a `/chamber/runtime` switch would
   * otherwise install a layer pinned to the OLD generation (its own direct dep
   * is exempt from the verifier, so nothing else would catch it). The same
   * single-source decision runs again here with the per-op facts; a refusal
   * fails the op honestly, before the pre-mutation backup.
   */
  function judgeAtExecution(item: QueueItem): { code: PluginRefusalCode; error: string } | null {
    // remove never judges a version; undo judges its own inverse direction
    // inside runUndo (the target's name/spec, not this item's).
    if (item.kind === 'remove' || item.kind === 'undo') return null
    const facts = readRuntimeFacts()
    const set = facts === null ? null : gatewayProtectedSet(facts)
    const decision = decidePluginMutation({
      op: 'install',
      name: item.name,
      version: item.version ?? registrySpecVersion(item.spec ?? null),
      runtimeVersion: facts === null ? null : facts.version,
      derivation: { ok: true, set: set ?? deriveBootProtectedSet() },
      profileState: 'ready',
      familySource: set === null ? 'unavailable' : 'runtime',
    })
    if (decision.kind === 'allow' || decision.kind === 'defer') return null
    return { code: decision.code, error: decision.error }
  }

  /** Write order step ② (design 21 §6.3): atomically copy the CURRENT
   * profile pair into the op's backup dir and durably reference it. Returns
   * the (unsanitized) failure message, or null on success. */
  function backupProfile(opId: string): string | null {
    try {
      const backupDir = backupDirFor(stateDir, opId)
      ensurePrivateDirectoryNoFollow(backupDir, 0o700)
      const manifestText = readPrivateFileNoFollow(join(profileDir, 'package.json'), {
        maxBytes: INSTALLED_MANIFEST_MAX_BYTES,
      }).value
      atomicWritePrivateFileNoFollow(join(backupDir, 'package.json'), manifestText, { mode: 0o600 })
      const lockPath = join(profileDir, 'pnpm-lock.yaml')
      if (existsSync(lockPath)) {
        const lockText = readPrivateFileNoFollow(lockPath, { maxBytes: PROFILE_LOCKFILE_MAX_BYTES }).value
        atomicWritePrivateFileNoFollow(join(backupDir, 'pnpm-lock.yaml'), lockText, { mode: 0o600 })
      }
      journal.recordPreImage(opId)
      return null
    } catch (error) {
      return `pre-mutation profile backup failed: ${messageOf(error)}`
    }
  }

  /**
   * The undo op (design 21 §6.3/§6.8 r2): undo = RESTORE. The target was
   * bound at submit (`item.undoOf`); at execution it must still be an ok op
   * with a preImage backup — when the queue ran other ops in between, the
   * bound change is no longer the latest and the op fails loudly instead of
   * silently restoring a different point in history. The inverse direction is
   * re-judged with the same single decision implementation (protected set /
   * generation coupling), then the CURRENT profile is backed up (the undo is
   * itself undoable) and the pair is restored. */
  async function runUndo(item: QueueItem): Promise<void> {
    if (item.undoOf === undefined) {
      complete(item, { status: 'failed', error: sanitize(ERROR_NO_UNDOABLE_OP) })
      return
    }
    const bound = journal.recent().find(op => op.id === item.undoOf)
    if (bound === undefined || bound.status !== 'ok' || bound.preImage === null) {
      complete(item, {
        status: 'failed',
        error: sanitize(`${ERROR_NO_UNDOABLE_OP} (operation ${item.undoOf} is no longer an ok op with a preImage backup)`),
      })
      return
    }
    const preflight = readUndoPreImage(stateDir, bound)
    if (!preflight.ok) {
      complete(item, { status: 'failed', error: sanitize(`${preflight.error} [${preflight.code}]`) })
      return
    }
    const judged = judgeUndo(preflight.preImage, readRuntimeFacts())
    if (!judged.ok) {
      complete(item, { status: 'failed', error: sanitize(`${judged.error} [${judged.code}]`) })
      return
    }
    const backupError = backupProfile(item.opId)
    if (backupError !== null) {
      complete(item, { status: 'failed', error: sanitize(backupError) })
      return
    }
    // Execution-window double check, exactly like install/remove (design 21
    // §6.3): never restore while the managed instance is mid-(re)start.
    if (isRefusedProbeState(statusProbe())) {
      complete(item, { status: 'failed', error: ERROR_STARTING })
      return
    }
    try {
      restoreUndoPreImage(stateDir, preflight.preImage)
    } catch (error) {
      complete(item, { status: 'failed', error: sanitize(`preImage restore failed: ${messageOf(error)}`) })
      return
    }
    if (isRefusedProbeState(statusProbe())) {
      complete(item, { status: 'failed', error: ERROR_RESTARTED_DURING_MUTATION })
      return
    }
    complete(item, { status: 'ok' })
  }

  async function runMutation(item: QueueItem): Promise<void> {
    const { opId, kind, name, spec } = item
    if (kind === 'undo') {
      await runUndo(item)
      return
    }
    // (0) Execution-time re-judgement (see judgeAtExecution).
    const judged = judgeAtExecution(item)
    if (judged !== null) {
      complete(item, { status: 'failed', error: sanitize(`${judged.error} [${judged.code}]`) })
      return
    }
    // (1) Pre-mutation backup BEFORE anything touches the profile.
    const backupError = backupProfile(opId)
    if (backupError !== null) {
      complete(item, { status: 'failed', error: sanitize(backupError) })
      return
    }
    // (2) Execution-window pre-check: never start a mutation while the
    // managed instance is starting/restarting (design 21 decision 7).
    const state = statusProbe()
    if (isRefusedProbeState(state)) {
      complete(item, { status: 'failed', error: ERROR_STARTING })
      return
    }
    // (3) Strict env discipline + fixed argv (decision 13: scripts allowed).
    // HOME is NOT pinned (see ensurePrivateRunEnv): pnpm's default store must
    // stay the store the managed profile was provisioned against, or pnpm 11
    // refuses every mutation with a store-mismatch error.
    let env: Record<string, string>
    try {
      ensurePrivateRunEnv()
      const thirdParty = thirdPartyRoot(stateDir)
      // PATH carries the gateway's own pnpm shim (design 18 §9.2 D1): the
      // managed `dsh plugin` CLI forwards to a literal `pnpm` on PATH, and a
      // host provisioned with npm alone has none — the op would answer 127
      // even though the gateway ships the pinned pnpm.
      env = withPnpmOnPath(
        scrubMutationEnv(process.env, {
          DSH_HOME: join(stateDir, MANAGED_DSH_HOME_DIR),
          XDG_CACHE_HOME: join(thirdParty, '.pnpm-cache'),
          XDG_CONFIG_HOME: join(thirdParty, '.pnpm-xdg'),
          // Both casings pin one empty userconfig file: pnpm 11's config reader
          // reads `npm_config_userconfig` OR `NPM_CONFIG_USERCONFIG` (exact-case
          // property reads, no case folding), so the empty-file displacement of
          // the operator's real ~/.npmrc must not depend on which casing a pnpm
          // minor honors.
          NPM_CONFIG_USERCONFIG: join(thirdParty, '.npmrc-empty'),
          npm_config_userconfig: join(thirdParty, '.npmrc-empty'),
        }, INSTALL_ENV_WHITELIST),
        ensurePnpmOnPath(thirdParty),
      )
    } catch (error) {
      complete(item, { status: 'failed', error: sanitize(`failed to prepare the private pnpm environment: ${messageOf(error)}`) })
      return
    }
    const verb = kind === 'remove' ? 'remove' : 'add'
    const target = kind === 'remove' ? name : (spec ?? name)
    const argv = ['plugin', '--profile', 'web', verb, target]
    // Per-op CLI launch (active runtime workspace → node + CLI entry); a
    // resolution failure fails the op loudly — the preImage backup is
    // retained for state verification/rollback.
    const launch = deps.cliLaunch === undefined ? null : deps.cliLaunch()
    const result = await runPluginMutation({
      command: deps.dshCliPath,
      argvPrefix: launch?.argvPrefix,
      cwd: launch?.cwd,
      argv,
      env,
      timeoutMs,
      spawn: childSpawn,
      sanitize,
    })
    if (!result.ok) {
      complete(item, { status: 'failed', error: result.error })
      return
    }
    // (5) Post-mutation re-check (design 21 §6.3 pre/post double check): a
    // spawn that returned 0 is only recorded ok if the instance is still in
    // the execution window — a (re)start mid-mutation fails honestly, the
    // preImage stays for state verification/rollback.
    const after = statusProbe()
    if (isRefusedProbeState(after)) {
      complete(item, { status: 'failed', error: ERROR_RESTARTED_DURING_MUTATION })
      return
    }
    // (6) Post-install family verification (design 21 §6.11.4): R2 judges the
    // direct spec only, but the resolved closure can hoist a runtime-family
    // copy into the managed profile (an out-of-release name or another
    // generation) — exactly the composition split no name-level rule can see.
    // A violation fails the op LOUDLY; the preImage stays retained and the
    // op's error carries the finding (design 21 §6.3 verification/rollback
    // discipline).
    if (kind !== 'remove') {
      const family = readRuntimeFacts() === null ? null : activeFamilyFacts()
      const familyNames = family?.names ?? null
      const familyVersions = family?.versions ?? null
      // An EMPTY family is a fact too (the runtime provides no official-scope
      // packages): the verification still runs and then flags every non-direct
      // official copy as outside-family — the tight direction. Only an
      // unavailable fact source (null) skips, and that skip is logged.
      // Read the version ONCE (a runtime switch between the verdict and the
      // message must not produce a mismatched report).
      const execRuntimeVersion = readRuntimeFacts()?.version ?? null
      if (familyNames !== null) {
        // A verifier crash (unreadable tree, racing removal) is an honest
        // failure of THIS op — never a silent pass and never an opaque one.
        const verdict = (() => {
          try {
            return verifyProfileFamilyConsistency({
              profileDir: join(deps.stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR),
              familyNames,
              runtimeVersion: execRuntimeVersion,
              familyVersions,
            })
          } catch (error) {
            return { ok: false as const, findings: [], crash: messageOf(error) }
          }
        })()
        if (verdict.ok && verdict.skipped !== undefined) {
          // Not a pass: the verification could not run. Loud, and the op still
          // succeeds (the mutation itself was fine) — but the log tells the
          // operator the profile tree was never proven consistent.
          warn(`plugins-exec: family verification skipped for ${item.name}: ${verdict.skipped}`)
        }
        if (!verdict.ok) {
          const detail = 'crash' in verdict && verdict.crash !== undefined
            ? `verification could not run: ${verdict.crash}`
            : describeFamilyFindings(verdict.findings, execRuntimeVersion, familyVersions)
          // The finding NAMES are the actionable fact; a scoped package name is
          // path-shaped and the generic sanitizer would redact it to `[path]`,
          // erasing exactly that fact. Keep them explicitly (the same
          // `error.keep` discipline the routes use) and log the raw names
          // host-side so the operator can act on the journal entry.
          warn(`${ERROR_FAMILY_DRIFT} for ${item.name}: ${detail}`)
          const error = new Error(`${ERROR_FAMILY_DRIFT}: ${detail}`)
          ;(error as { keep?: string[] }).keep = verdict.findings.map(finding => finding.name)
          complete(item, {
            status: 'failed',
            error: sanitizeRouteError(error.message, (error as { keep?: string[] }).keep ?? []),
          })
          return
        }
      } else {
        // No family facts on this wiring (tests/legacy): verification cannot
        // run — recorded as a warning, never a silent pass.
        warn('plugins-exec: family verification skipped (no runtime-family facts wired)')
      }
    }
    complete(item, { status: 'ok' })
  }

  return {
    async enqueue(input, onTerminal) {
      if (disposed) {
        return { ok: false, code: 'queue_busy', error: 'executor is disposed' }
      }
      const duplicate = [...liveOps.values()].some(op => op.kind === input.kind && op.name === input.name)
      if (duplicate) {
        return { ok: false, code: 'queue_busy', error: ERROR_DUPLICATE_PENDING }
      }
      if (liveOps.size >= PLUGIN_QUEUE_CAP) {
        return { ok: false, code: 'queue_full', error: `operation queue is full (max ${PLUGIN_QUEUE_CAP})` }
      }
      let opId: string
      try {
        opId = journal.appendPending(input)
      } catch (error) {
        // Persistence failure (journal append threw) is NOT a queue-busy
        // refusal — the client must tell "retry later" from "the gateway
        // cannot write" (design 21 §6.2 persistence_failed 500 family).
        return { ok: false, code: 'persistence_failed', error: sanitize(`cannot record operation in the journal: ${messageOf(error)}`) }
      }
      liveOps.set(opId, { kind: input.kind, name: input.name })
      queue.push({ opId, ...input, ...(onTerminal === undefined ? {} : { terminal: onTerminal }) })
      ensureWorker()
      kickWorker()
      log(`plugins-exec: queued ${input.kind} ${input.name} (op ${opId})`)
      return { ok: true, opId }
    },

    async dispose() {
      if (!disposed) {
        disposed = true
        killOnSpawn = true
        for (const item of queue.splice(0)) {
          complete(item, { status: 'blocked', error: 'executor shut down before this operation ran' })
        }
        const child = current?.child ?? null
        if (child !== null) {
          try {
            child.kill('SIGTERM')
          } catch {
            // best effort
          }
          // Escalate children that ignore SIGTERM so dispose() never waits on
          // the full per-op timeout. Unref'd: if the child already closed the
          // kill is a harmless no-op.
          setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              // ignore
            }
          }, SIGNAL_GRACE_MS).unref()
        }
        kickWorker()
        // Wake a pending execution-window poll (the worker then observes
        // `disposed` and blocks the dequeued op it was waiting on).
        if (pollWake !== null) {
          const wake = pollWake
          pollWake = null
          wake()
        }
      }
      if (workerPromise !== null) await workerPromise
    },

    workerBusy() {
      return current !== null
    },

    pendingCount() {
      return liveOps.size
    },
  }
}
