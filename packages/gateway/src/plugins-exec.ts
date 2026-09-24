/**
 * Serial-queue executor for gateway third-party plugin mutations: a single
 * worker drains one at a time. Duplicate pending/running kind+name fast-fails
 * queue_busy; depth past PLUGIN_QUEUE_CAP is queue_full. `canRun()` (the
 * runtime single-writer window) gates each dequeue: a closed window is polled
 * up to CAN_RUN_WAIT_MAX_MS, then marked blocked — never dropped.
 * runMutation: pre-mutation backup (0600, journaled preImage) BEFORE anything
 * mutates; probe refusal of 'starting'/'restarting' before AND after the spawn;
 * a child env limited to PATH + INSTALL_ENV_WHITELIST (the operator's ~/.npmrc
 * displaced, HOME deliberately NOT pinned so pnpm's default store stays the one
 * the profile was provisioned against); a journaled child pid.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  atomicWritePrivateFileNoFollow,
  decidePluginMutation,
  describeFamilyFindings,
  registrySpecVersion,
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
  INSTALLED_PROFILE_DIR,
  INSTALLED_MANIFEST_MAX_BYTES,
  MANAGED_DSH_HOME_DIR,
  resolveJudgementInputs,
  type JudgementInputs,
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
import type { PluginRefusalCode } from '@dsh-chamber/control-plane'

export const PLUGIN_QUEUE_CAP = 8
/** Execution-window wait bound: a dequeued op whose canRun() gate is closed
 * polls this long before it is marked blocked ('runtime busy; retry later') —
 * a queued op is never dropped just because a runtime mutation was in flight. */
export const CAN_RUN_WAIT_MAX_MS = 120_000
/** canRun() re-check cadence during the execution-window wait. */
export const CAN_RUN_POLL_MS = 250
/** Grace between SIGTERM and SIGKILL on dispose. */
export const SIGNAL_GRACE_MS = 1000
/** Byte cap for op/journal error text: child output and failure detail are
 * sanitized AND bounded before they land in the journal, whose tasks
 * projection is served verbatim to clients. */
export const JOURNAL_ERROR_TEXT_MAX_BYTES = 2_000

/** StatusProbe states that refuse a mutation (skip spawn). */
export const REFUSED_PROBE_STATES = ['starting', 'restarting'] as const

export const ERROR_RUNTIME_BUSY = 'runtime busy; retry later'
export const ERROR_STARTING = 'instance is starting/restarting'
export const ERROR_RESTARTED_DURING_MUTATION = 'instance (re)started during the mutation; verify plugin state and retry'
/** Post-install family verification failure. */
export const ERROR_FAMILY_DRIFT = 'installed, but the profile tree no longer matches the instance runtime'
export const ERROR_DUPLICATE_PENDING = 'duplicate operation pending'
/** The undo verb's honest refusal when the journal no longer carries the
 * bound target as an ok op with a preImage backup. */
export const ERROR_NO_UNDOABLE_OP = 'no undoable plugin operation is recorded'

/** Probe states during which a mutation must neither start nor be recorded ok. */
function isRefusedProbeState(state: string): boolean {
  return (REFUSED_PROBE_STATES as readonly string[]).includes(state)
}

/** Journal methods the executor drives (markChildPid optional for minimal fakes). */
export type JournalSurface = Pick<PluginsJournal, 'appendPending' | 'recordPreImage' | 'markTerminal' | 'recent'> & {
  markChildPid?(opId: string, pid: number): void
}

/** Terminal callback invoked once per op after its journal terminal state was
 * recorded (including dispose-time blocks): the orchestrator releases its
 * per-op profile-write lease here (the executor has no other terminal seam). */
export type OnOpTerminal = (op: JournalOp, terminalStatus: 'ok' | 'failed' | 'blocked') => void

/** Default error-text sanitizer: registry URLs reduced to their origin, named
 * secrets redacted, absolute paths removed, then byte-bounded — applied before
 * an error can reach the journal (served verbatim to clients). */
export const defaultSanitize = (text: string): string =>
  sanitizeInstallerOutput(text, JOURNAL_ERROR_TEXT_MAX_BYTES)

export type EnqueueRejection = { ok: false; code: 'queue_full' | 'queue_busy' | 'persistence_failed'; error: string }
export type EnqueueResult = { ok: true; opId: string } | EnqueueRejection

interface QueueItem extends JournalPending {
  opId: string
  /** Per-op terminal callback registered at enqueue time, BEFORE the worker can
   * process the item, so a terminal that fires inside enqueue is never missed. */
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
  /** Execution-window gate: while false the worker polls it at canRunPollMs up
   * to canRunWaitMaxMs, then blocks the op; a throwing gate counts as closed. */
  canRun?: () => boolean
  canRunWaitMaxMs?: number
  canRunPollMs?: number
  /** Shared terminal fallback: fires once per op after its terminal state is
   * recorded, when enqueue was called without a per-op hook. */
  onTerminal?: OnOpTerminal
  /** Per-op runtime facts: the ACTIVE workspace path + its effective version,
   *  resolved lazily so a runtime switch is honored. A thrown accessor is
   *  guarded at every call site; absent ⇒ no family facts (skip is logged). */
  runtimeFacts?: () => { path: string; version: string | null } | null
  /** Per-op CLI launch resolution (`node <entry> plugin …` from the ACTIVE
   * runtime workspace), resolved at every spawn so a version switch cannot
   * launch a stale entry; null/absent keeps the bare `dshCliPath` argv. */
  cliLaunch?: () => { argvPrefix: string[]; cwd?: string } | null
}

export interface PluginExec {
  /** Journal then queue one mutation. Rejects fast on a duplicate op
   * (queue_busy) or full queue (queue_full); never blocks on the worker. The
   * optional per-op terminal callback fires once after the terminal record. */
  enqueue(input: JournalPending, onTerminal?: OnOpTerminal): Promise<EnqueueResult>
  /** Stop accepting ops, mark queued ops blocked, kill the in-flight child and wait for the worker. Idempotent. */
  dispose(): Promise<void>
  workerBusy(): boolean
  /** Live op count (journaled, not yet terminal). */
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
  /** Wake handle for a pending execution-window poll (dispose() resolves it). */
  let pollWake: (() => void) | null = null

  function kickWorker(): void {
    if (wakeResolve !== null) {
      const resolve = wakeResolve
      wakeResolve = null
      resolve()
    }
  }

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

  function complete(item: QueueItem, patch: JournalTerminalPatch): void {
    const opId = item.opId
    let terminal: JournalOp | null = null
    try {
      terminal = journal.markTerminal(opId, patch)
      log(`plugins-exec: op ${opId} ${patch.status}`)
    } catch (error) {
      // The durable terminal record could not be written: the op is still
      // TERMINAL here and the hook must fire — a lease never outlives its op.
      // The journal keeps the op pending for the next boot's reconcile.
      warn(`plugins-exec: could not record terminal state for op ${opId}: ${messageOf(error)}`)
    } finally {
      liveOps.delete(opId)
    }
    // The hook fires even when markTerminal answered null (the record was lost
    // between append and terminal): a lease never outlives its op.
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

  /** Interruptible poll sleep: resolves at the deadline or when dispose() wakes it. */
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

  function runWindowOpen(): boolean {
    try {
      return canRun() === true
    } catch {
      return false
    }
  }

  /** Execution-window dequeue gate, reached only with a CLOSED window: polls
   * canRunPollMs until the window opens ('run'), the bound elapses ('blocked' —
   * never lost), or dispose() interrupts ('shutdown'). */
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
          // Re-check inside the executor: a dispose/enqueue racing this promise must not be lost.
          if (disposed || queue.length > 0) {
            wakeResolve = null
            resolve()
          }
        })
        continue
      }
      current = { item, child: null }
      try {
        // Dequeue gate: the OPEN-window fast path is synchronous (a wake →
        // spawn stays race-free); a closed window is awaited within the bounded
        // poll — never a spawn mid-transaction.
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
   * (0600), (re)created before every run. HOME is deliberately NOT pinned: pnpm
   * derives its default store from the effective home, and a pinned HOME moves
   * it — pnpm 11 then refuses every mutation against the provisioned profile. */
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
   * durably records its pid (crash-orphan reaping at the next boot's reconcile).
   * Best effort: an unrecordable pid only warns. */
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
    // A mutation starting while dispose() drains must never outlive it: kill it on sight.
    if (killOnSpawn) {
      try {
        child.kill('SIGTERM')
      } catch {
        // best effort
      }
    }
    return child
  }

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
   * Execution-time re-judgement: the CLI launch below resolves the workspace
   * PER OP, so an op queued behind a `/chamber/runtime` switch would otherwise
   * install a layer pinned to the OLD generation. The same single-source
   * decision runs again with the per-op facts; a refusal fails the op before
   * the pre-mutation backup.
   *
   * Returns the refusal (null = allowed) AND the fact snapshot the post-mutation
   * family verification reuses — one resolveJudgementInputs per install op, so
   * judgement, verification and message describe the SAME runtime; remove/undo
   * take no snapshot and read no facts.
   */
  function judgeAtExecution(item: QueueItem): {
    refusal: { code: PluginRefusalCode; error: string } | null
    inputs: JudgementInputs | null
  } {
    if (item.kind === 'remove' || item.kind === 'undo') return { refusal: null, inputs: null }
    const inputs = resolveJudgementInputs(readRuntimeFacts)
    const decision = decidePluginMutation({
      op: 'install',
      name: item.name,
      version: item.version ?? registrySpecVersion(item.spec ?? null),
      runtimeVersion: inputs.runtimeVersion,
      derivation: inputs.derivation,
      profileState: 'ready',
      familySource: inputs.familySource,
    })
    const refusal = decision.kind === 'allow' || decision.kind === 'defer'
      ? null
      : { code: decision.code, error: decision.error }
    return { refusal, inputs }
  }

  /** Atomically copy the CURRENT profile pair into the op's backup dir and
   * durably reference it. Returns the (unsanitized) failure message, or null. */
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
   * The undo op: undo = RESTORE. The target was bound at submit; at execution it
   * must still be an ok op with a preImage backup — when the queue ran other ops
   * in between it fails loudly instead of silently restoring a different point.
   * The inverse direction is re-judged with the same single decision
   * implementation, then the CURRENT profile is backed up (undo is undoable) and
   * the pair is restored.
   */
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
    // Execution-window double check, exactly like install/remove.
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
    // (0) Execution-time re-judgement (see judgeAtExecution); its snapshot is the
    // SAME one the post-mutation verification below consumes, so the facts are
    // read once and judgement/verification/message can never disagree.
    const { refusal: judged, inputs: judgementInputs } = judgeAtExecution(item)
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
    // (2) Execution-window pre-check: never mutate while the instance is (re)starting.
    const state = statusProbe()
    if (isRefusedProbeState(state)) {
      complete(item, { status: 'failed', error: ERROR_STARTING })
      return
    }
    // (3) Strict env discipline + fixed argv (lifecycle scripts allowed).
    // HOME is NOT pinned (see ensurePrivateRunEnv) so pnpm keeps the store the
    // profile was provisioned against.
    let env: Record<string, string>
    try {
      ensurePrivateRunEnv()
      const thirdParty = thirdPartyRoot(stateDir)
      // PATH carries the gateway's own pnpm shim: the managed `dsh plugin`
      // CLI forwards to a literal `pnpm` on PATH, absent on an npm-only host.
      env = withPnpmOnPath(
        scrubMutationEnv(process.env, {
          DSH_HOME: join(stateDir, MANAGED_DSH_HOME_DIR),
          XDG_CACHE_HOME: join(thirdParty, '.pnpm-cache'),
          XDG_CONFIG_HOME: join(thirdParty, '.pnpm-xdg'),
          // Both casings pin one empty userconfig file: pnpm's config reader does
          // exact-case reads, so displacing the operator's real ~/.npmrc must not
          // depend on which casing it honors.
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
    // Per-op CLI launch (active runtime workspace → node + CLI entry); a failing
    // resolution fails the op loudly, preImage retained.
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
    // (5) Post-mutation re-check: a 0 return is only recorded ok if the instance
    // is still in the execution window — a (re)start fails honestly, preImage
    // retained.
    const after = statusProbe()
    if (isRefusedProbeState(after)) {
      complete(item, { status: 'failed', error: ERROR_RESTARTED_DURING_MUTATION })
      return
    }
    // (6) Post-install family verification: the direct spec is judged, but the
    // resolved closure can hoist a runtime-family copy into the profile (an
    // out-of-release name or another generation) — a split no name-level rule can
    // see. A violation fails the op LOUDLY, preImage retained.
    if (kind !== 'remove') {
      const familyNames = judgementInputs?.familyNames ?? null
      const familyVersions = judgementInputs?.familyVersions ?? null
      // An EMPTY family is a fact too: verification still runs and flags every
      // non-direct official copy as outside-family — the tight direction. Only a
      // null fact source skips, and that skip is logged.
      // Version comes from the SAME snapshot the judgement used: a switch between
      // verdict and message must not produce a mismatched report.
      const execRuntimeVersion = judgementInputs?.runtimeVersion ?? null
      if (familyNames !== null) {
        // A verifier crash is an honest failure of THIS op, never a silent pass.
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
          // Not a pass: verification could not run. The op still succeeds (the
          // mutation was fine) but the log says the tree was never proven.
          warn(`plugins-exec: family verification skipped for ${item.name}: ${verdict.skipped}`)
        }
        if (!verdict.ok) {
          const detail = 'crash' in verdict && verdict.crash !== undefined
            ? `verification could not run: ${verdict.crash}`
            : describeFamilyFindings(verdict.findings, execRuntimeVersion, familyVersions)
          // The finding NAMES are the actionable fact; a scoped package name is
          // path-shaped and the sanitizer would redact it to `[path]`. Keep them
          // explicitly via `error.keep` (the route discipline) and log them.
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
        // No family facts on this wiring: verification cannot run — a warning.
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
        // A journal append failure is NOT a queue-busy refusal: "retry later" vs "cannot write".
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
          // Escalate children that ignore SIGTERM, unref'd, so dispose() never
          // waits on the full per-op timeout.
          setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              // ignore
            }
          }, SIGNAL_GRACE_MS).unref()
        }
        kickWorker()
        // Wake a pending execution-window poll; the worker then blocks the op.
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
