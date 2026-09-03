/**
 * Serial-queue executor for gateway third-party plugin mutations (design 21
 * §6.2/§6.3, A1 write surface; plan Phase 4.3 core).
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
 *   (3) env discipline (design 21 §6.3 upgraded rules): argv is the managed
 *       dsh CLI `plugin --profile web add|remove …`; the child env keeps
 *       ONLY what pnpm/network needs — PATH + the proxy family (the same
 *       canonical whitelist the dsh-runtime installer uses,
 *       INSTALL_ENV_WHITELIST) — every other ambient variable (DSH_GATEWAY_*
 *       control vars, npm_config_* / NPM_* token carriers AND any other secret
 *       carrier such as NODE_AUTH_TOKEN that lifecycle scripts or pnpm could
 *       read) is DROPPED, and DSH_HOME/HOME/XDG_CACHE_HOME/XDG_CONFIG_HOME/
 *       NPM_CONFIG_USERCONFIG are pinned into private stateDir directories
 *       (HOME/XDG_CACHE_HOME/XDG_CONFIG_HOME 0700 — XDG_CONFIG_HOME is the
 *       executor's addition over the runtime-installer precedent, and
 *       NPM_CONFIG_USERCONFIG is an empty 0600 file) — the profile's .npmrc
 *       is never trusted input; lifecycle scripts are allowed (design 21
 *       decision 13 — no ignore-scripts);
 *   (4) spawn with bounded stdout/stderr capture (512 KiB tail default),
 *       process-group kill on timeout (SIGTERM → SIGKILL after 1 s),
 *       sanitized errors (URL userinfo/query capability tokens and named
 *       secrets redacted, absolute paths removed, byte-bounded — the
 *       dsh-runtime sanitizeInstallerOutput family) and the spawned child's
 *       pid durably journaled (markChildPid) so a gateway crash mid-mutation
 *       leaves a reapable record for the next boot's reconcile;
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

import { spawn as spawnCommand } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
} from '@dsh-chamber/control-plane'
import { INSTALL_ENV_WHITELIST, sanitizeInstallerOutput } from '@dsh-chamber/dsh-runtime'
import { INSTALLED_PROFILE_DIR, INSTALLED_MANIFEST_MAX_BYTES, MANAGED_DSH_HOME_DIR } from './plugins-installed.ts'
import { backupDirFor, thirdPartyRoot } from './plugins-journal.ts'
import type { JournalLogger, JournalOp, JournalOpKind, JournalPending, JournalTerminalPatch, PluginsJournal } from './plugins-journal.ts'

/** Queue depth cap (design 21 §6.9: queue depth ≤ 8). */
export const PLUGIN_QUEUE_CAP = 8
/** Single-op timeout default (design 21 §6.9: 10 minutes). */
export const MUTATION_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000
/** Execution-window wait bound (design 21 decision 6/7, F7/activation
 * windows): a dequeued op whose canRun() gate is closed polls for the window
 * to open for up to this long before it is marked blocked ('runtime busy;
 * retry later') — a queued op must never be dropped just because a runtime
 * mutation happened to be in flight at its dequeue instant. */
export const CAN_RUN_WAIT_MAX_MS = 120_000
/** canRun() re-check cadence during the execution-window wait. */
export const CAN_RUN_POLL_MS = 250
/** Default bounded capture ceiling per stream (tail kept). */
export const OUTPUT_CAPTURE_LIMIT_DEFAULT_BYTES = 512 * 1024
/** Grace between SIGTERM and SIGKILL on timeout/dispose. */
export const SIGNAL_GRACE_MS = 1000
/** Marker prepended when captured output was truncated to its tail. */
export const OUTPUT_TRUNCATION_MARKER = '\n...[output truncated]...\n'
/** Bounded read for the profile lockfile copy (manifest bound comes from
 * plugins-installed.ts). */
export const PROFILE_LOCKFILE_MAX_BYTES = 64 * 1024 * 1024
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
export const ERROR_DUPLICATE_PENDING = 'duplicate operation pending'
export const ERROR_TIMED_OUT = 'mutation timed out'

/** StatusProbe states during which a mutation must neither start nor be
 * recorded as ok (design 21 §6.3 pre/post double check). */
function isRefusedProbeState(state: string): boolean {
  return (REFUSED_PROBE_STATES as readonly string[]).includes(state)
}

/** Structural minimal child surface (real ChildProcess or test fake). */
export interface SpawnedProcessStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'end', listener: () => void): unknown
}

export interface SpawnedChild {
  pid: number | undefined
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error' | 'close', listener: (...args: any[]) => void): unknown
  stdout: SpawnedProcessStream | null
  stderr: SpawnedProcessStream | null
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedChild

/** Journal methods the executor drives. markChildPid is optional on the
 * surface so minimal fakes stay compatible; the real journal implements it. */
export type JournalSurface = Pick<PluginsJournal, 'appendPending' | 'recordPreImage' | 'markTerminal'> & {
  markChildPid?(opId: string, pid: number): void
}

/** Terminal callback invoked once per op after its journal terminal state
 * was recorded (including ops blocked by dispose()). Receives the recorded
 * op and the terminal status — the A1 orchestrator releases its per-op
 * profile-write lease here (the executor has no other terminal seam). */
export type OnOpTerminal = (op: JournalOp, terminalStatus: 'ok' | 'failed' | 'blocked') => void

export interface PluginMutationParams {
  dshCliPath: string
  argv: string[]
  env: Record<string, string>
  timeoutMs?: number
  spawn?: SpawnFn
  stdoutLimit?: number
  stderrLimit?: number
  sanitize?: (text: string) => string
  /** Optional argv prefix spliced between the executable and `argv` (the
   * managed dsh CLI is spawned as `node <entry> …`; tests omit it). */
  argvPrefix?: string[]
  /** Optional working directory for the spawned child (the active runtime
   * workspace root; absent inherits the gateway process cwd). */
  cwd?: string
}

export type PluginMutationResult = { ok: true } | { ok: false; error: string }

/** Env discipline (design 21 §6.3): ONLY the variables pnpm/network needs
 * may cross the process boundary — PATH + the proxy family, i.e. the SAME
 * canonical whitelist the dsh-runtime installer applies to its own install
 * children (INSTALL_ENV_WHITELIST, exported by the shared core; design 21
 * §6.3: "白名单 env（PATH+代理族）"). Everything else — DSH_GATEWAY_*
 * control variables, npm_config_* / NPM_* token carriers, and any OTHER
 * ambient secret (NODE_AUTH_TOKEN, GITHUB_TOKEN, SSH_AUTH_SOCK, …) that an
 * arbitrary third-party lifecycle script (allowed by decision 13) or pnpm
 * could read — is DROPPED before the caller's pins apply unconditionally.
 * A denylist cannot enumerate every secret carrier; the whitelist can. */
export function scrubInstallEnv(
  source: Record<string, string | undefined>,
  pins: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (INSTALL_ENV_WHITELIST.test(key)) result[key] = value
  }
  for (const [key, value] of Object.entries(pins)) result[key] = value
  return result
}

/** Pure tail bound used by the capture buffers: over-limit input keeps its
 * last `limit` bytes, prefixed with the truncation marker. */
export function truncateOutputTail(text: string, limit: number): { value: string; truncated: boolean } {
  if (text.length <= limit) return { value: text, truncated: false }
  return { value: `${OUTPUT_TRUNCATION_MARKER}${text.slice(text.length - limit)}`, truncated: true }
}

/** Rolling bounded capture: keeps the last `limit` bytes of pushed chunks. */
class BoundedOutput {
  private parts: string[] = []
  private length = 0
  private dropped = false
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (text.length === 0) return
    this.parts.push(text)
    this.length += text.length
    while (this.parts.length > 1 && this.length - this.parts[0]!.length >= this.limit) {
      this.length -= this.parts.shift()!.length
      this.dropped = true
    }
    if (this.length > this.limit) {
      const excess = this.length - this.limit
      this.parts[0] = this.parts[0]!.slice(excess)
      this.length -= excess
      this.dropped = true
    }
  }

  text(): string {
    const joined = this.parts.join('')
    // push() keeps the retained tail within the limit; when anything was
    // dropped the tail is surfaced with the truncation marker up front.
    return this.dropped ? `${OUTPUT_TRUNCATION_MARKER}${joined}` : joined
  }
}

function lastNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r?\n/u)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (line !== '') return line
  }
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Real spawn: detached child + process-group kill wrapper (POSIX), so a
 * hung install child can be reaped as a group. */
function spawnManagedCommand(command: string, args: string[], options: SpawnOptions): SpawnedChild {
  const child = spawnCommand(command, args, { ...options, detached: process.platform !== 'win32' })
  return {
    pid: child.pid,
    kill(signal) {
      if (process.platform === 'win32' || child.pid === undefined) return child.kill(signal)
      try {
        process.kill(-child.pid, signal)
        return true
      } catch {
        return child.kill(signal)
      }
    },
    once(event, listener) {
      child.once(event as never, listener as never)
    },
    stdout: child.stdout,
    stderr: child.stderr,
  }
}

/** Default error-text sanitizer for every executor/journal error string
 * (design 21 §6.3): registry URLs are reduced to their origin (userinfo /
 * query / path capability tokens removed), named secrets redacted, absolute
 * paths removed, then byte-bounded — the dsh-runtime
 * sanitizeInstallerOutput family, applied before an error can reach the
 * journal (whose tasks projection is served verbatim to clients). */
export const defaultSanitize = (text: string): string =>
  sanitizeInstallerOutput(text, JOURNAL_ERROR_TEXT_MAX_BYTES)

/** Run one managed-dsh plugin CLI mutation with strict env discipline,
 * bounded output capture and group-kill timeouts. Never throws; resolves the
 * terminal outcome. */
export function runDshPluginMutation(params: PluginMutationParams): Promise<PluginMutationResult> {
  const timeoutMs = params.timeoutMs ?? MUTATION_TIMEOUT_DEFAULT_MS
  const stdoutLimit = params.stdoutLimit ?? OUTPUT_CAPTURE_LIMIT_DEFAULT_BYTES
  const stderrLimit = params.stderrLimit ?? OUTPUT_CAPTURE_LIMIT_DEFAULT_BYTES
  const sanitize = params.sanitize ?? defaultSanitize
  const spawnFn = params.spawn ?? spawnManagedCommand

  return new Promise(resolve => {
    let settled = false
    let child: SpawnedChild | null = null
    const stdout = new BoundedOutput(stdoutLimit)
    const stderr = new BoundedOutput(stderrLimit)
    let timedOut = false
    let timeoutHandle: NodeJS.Timeout | undefined
    let graceHandle: NodeJS.Timeout | undefined

    const finish = (result: PluginMutationResult): void => {
      if (settled) return
      settled = true
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      if (graceHandle !== undefined) clearTimeout(graceHandle)
      resolve(result)
    }

    try {
      child = spawnFn(params.dshCliPath, [...(params.argvPrefix ?? []), ...params.argv], {
        env: params.env,
        cwd: params.cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, error: sanitize(`failed to spawn dsh plugin command: ${messageOf(error)}`) })
      return
    }
    const running = child

    timeoutHandle = setTimeout(() => {
      timedOut = true
      try {
        running.kill('SIGTERM')
      } catch {
        // kill is best effort; the grace timer settles the outcome.
      }
      graceHandle = setTimeout(() => {
        try {
          running.kill('SIGKILL')
        } catch {
          // ignore
        }
        finish({ ok: false, error: sanitize(ERROR_TIMED_OUT) })
      }, SIGNAL_GRACE_MS)
    }, timeoutMs)

    running.once('error', error => {
      finish({ ok: false, error: sanitize(`failed to spawn dsh plugin command: ${messageOf(error)}`) })
    })
    running.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish({ ok: false, error: sanitize(ERROR_TIMED_OUT) })
        return
      }
      if (code === 0) {
        finish({ ok: true })
        return
      }
      const line = lastNonEmptyLine(stderr.text()) ?? lastNonEmptyLine(stdout.text())
      let error: string
      if (code === null) {
        error = `dsh plugin command was terminated by ${signal ?? 'unknown signal'}`
      } else if (line === null) {
        error = `dsh plugin command exited with code ${code}`
      } else {
        error = line
      }
      finish({ ok: false, error: sanitize(error) })
    })
    running.stdout?.on('data', chunk => stdout.push(chunk))
    running.stderr?.on('data', chunk => stderr.push(chunk))
  })
}

export type EnqueueRejection = { ok: false; code: 'queue_full' | 'queue_busy' | 'persistence_failed'; error: string }
export type EnqueueResult = { ok: true; opId: string } | EnqueueRejection

interface QueueItem extends JournalPending {
  opId: string
  /** Per-op terminal callback (enqueue-time, BEFORE the worker can process
   * the item — the A1 orchestrator passes its lease release here so a
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
  spawn?: SpawnFn
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
   * (ok/failed/blocked, including dispose-time blocks). The A1 orchestrator
   * passes its lease release PER OP via enqueue() — registration before the
   * worker can process the item is race-free; this fallback serves
   * standalone/test callers. */
  onTerminal?: OnOpTerminal
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
  let current: { item: QueueItem; child: SpawnedChild | null } | null = null
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

  /** Private pnpm home/cache/xdg dirs (0700) + empty NPM_CONFIG_USERCONFIG
   * file (0600); (re)created before every run — the child's HOME and XDG dirs
   * are never the operator's. */
  function ensurePrivateRunEnv(): void {
    const thirdParty = thirdPartyRoot(stateDir)
    ensurePrivateDirectoryNoFollow(thirdParty, 0o700)
    for (const name of ['.pnpm-home', '.pnpm-cache', '.pnpm-xdg']) {
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
  const childSpawn: SpawnFn = (command, args, options) => {
    const child = (deps.spawn ?? spawnManagedCommand)(command, args, options)
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

  async function runMutation(item: QueueItem): Promise<void> {
    const { opId, kind, name, spec } = item
    // (1) Pre-mutation backup BEFORE anything touches the profile.
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
    } catch (error) {
      complete(item, { status: 'failed', error: sanitize(`pre-mutation profile backup failed: ${messageOf(error)}`) })
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
    let env: Record<string, string>
    try {
      ensurePrivateRunEnv()
      const thirdParty = thirdPartyRoot(stateDir)
      env = scrubInstallEnv(process.env, {
        DSH_HOME: join(stateDir, MANAGED_DSH_HOME_DIR),
        HOME: join(thirdParty, '.pnpm-home'),
        XDG_CACHE_HOME: join(thirdParty, '.pnpm-cache'),
        XDG_CONFIG_HOME: join(thirdParty, '.pnpm-xdg'),
        NPM_CONFIG_USERCONFIG: join(thirdParty, '.npmrc-empty'),
      })
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
    const result = await runDshPluginMutation({
      dshCliPath: deps.dshCliPath,
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
