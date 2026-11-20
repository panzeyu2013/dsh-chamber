/**
 * Local dsh host management: spawn lifecycle, readiness, health monitoring,
 * restart, graceful stop.
 *
 * The control plane consumes no host frames — session business belongs to the dsh
 * frontend runtime, reached through the per-instance reverse proxy. This module
 * owns only process-level facts: spawn (web profile, fixed port + P+1 retry, pid
 * record); health monitoring via a shared failure counter plus transport triggers;
 * the state machine stopped → starting → ready ⇄ degraded → restarting →
 * restart-exhausted → stopped, spawn failures landing on 'error'. status/dshPort/
 * error stay memory projections, never durable catalog facts. The local instance
 * is always managed; there is no external/claim takeover mode.
 */

import { DSH_WRITER_QUIESCENCE_UNKNOWN_CODE, isWriterQuiescenceUnknown, SpawnLifecycleError, spawnDsh } from './spawn-dsh.ts'
import { clearAuthCookie } from './browser-auth-cookie.ts'
import { probeHostIdentity as probeHostIdentityFn } from './dsh-client.ts'
import { createHostLogWriter } from './host-logs.ts'
import { errorMessage } from './error-text.ts'
import type { Logger } from './types.ts'

/** The connection state machine vocabulary (the REST dsh.status contract). */
export type ConnectionState =
  | 'stopped' | 'starting' | 'ready' | 'degraded'
  | 'restarting' | 'restart-exhausted' | 'error'

/**
 * Whether the managed local dsh is alive and still serving. `degraded` means at
 * least one health probe failed but the process was NOT restarted and the host
 * keeps serving (design 02 §3.5); every serving gate — the local and gateway
 * reverse proxies, the warmup prefetch and the renderer aggregate poll — must
 * accept it. `starting`/`restarting` are explicitly NOT serviceable: the port
 * may still name the previous/dead child, and the host is not ready yet.
 */
export function isServiceableLocalState(state: string): boolean {
  return state === 'ready' || state === 'degraded'
}

/** The spawned dsh child surface used by this adapter. */
export interface SpawnedDsh {
  child: {
    on(event: string, listener: (...args: any[]) => void): unknown
    /** Optional listener removal (a real ChildProcess has it): reclamation detaches the
     *  exit hook so a late exit of a superseded generation can never schedule a restart. */
    off?(event: string, listener: (...args: any[]) => void): unknown
    exitCode: number | null
    signalCode?: string | null
  }
  port: number
  /** The managed host pid (the durable ledger identity), when the spawn layer knows it. */
  readonly pid?: number
  stop(): Promise<void>
}

/**
 * Evidence of a managed writer whose process-group termination could NOT be proven. Kept
 * (with the child handle that produced it) so a later stop()/start() retries the same proof
 * instead of reporting quiescence; liveness and diagnosis treat it as possibly alive.
 */
export interface LocalWriterSuspect {
  /** The process identity the unproven termination was about; null when none was known. */
  readonly pid: number | null
  readonly since: number
  readonly lastError: string
}

/** Unified host-identity probe seam. Resolution = the host answered the identity
 *  handshake (both boolean answers and the legacy fallback are healthy); failures throw. */
export type ProbeIdentityFn = (
  baseUrl: string,
  options: { signal?: AbortSignal; generationSignal?: AbortSignal; timeoutMs?: number | null; logger: { warn(line: string): void } },
) => Promise<boolean>

/** Injectable connection-adapter dependencies. */
export interface LocalConnectionDeps {
  spawnDsh?: (options: {
    stateDir: string
    ownerInstanceId?: string
    dshHome: string
    dshWorkspacePath: string
    /** Desktop login-shell merge (value or its early-started promise) handed to the host spawn. */
    hostEnv?: NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>
    logger: Logger
    /** Optional `--patch` overlay for the dsh launcher (design 09 module B); null/absent when none. */
    patchPath?: string | null
    /** Bundled pnpm entry for the host PATH provision (design 02 §3.1); absent = no provisioning. */
    pnpmEntry?: string | null
    /** First port attempted (design 17 §3 server override); absent = BASE_DHSPORT. */
    dshPortBase?: number
    /** Aborted by stop() so a readiness wait cannot outlive writer quiescence. */
    signal?: AbortSignal
  }) => Promise<SpawnedDsh>
  probeHostIdentity?: ProbeIdentityFn
  /**
   * Spawn scheduling seam, invoked on BOTH spawn paths after the public entry gate
   * but before any DSH_HOME seed or process spawn. The gateway wires it in
   * production to refuse the spawn while a managed profile-write lease is held,
   * closing the DSH_HOME TOCTOU; the desktop leaves it absent.
   */
  beforeSpawnCheckpoint?: (kind: 'start' | 'restart') => void | Promise<void>
}

/** A dynamic spawn fence shared by manual starts and automatic restarts. */
export type LocalSpawnGate = () => { ok: true } | { ok: false; reason: string }

/** createLocalConnection tuning options (see the function docblock). */
export interface LocalConnectionOptions {
  failureThrottleMs?: number
  healthIntervalMs?: number
  healthProbeTimeoutMs?: number
  healthResultCacheMs?: number
  restartFailureThreshold?: number
  restartBackoffFloorMs?: number
  restartBackoffCeilMs?: number
  restartWindowMs?: number
  maxRestartsInWindow?: number
  /** First port attempted for the managed dsh host (absent = BASE_DHSPORT 17510). */
  dshPortBase?: number
  /** Stable control-plane UUID carried by every managed-dsh ledger row. */
  ownerInstanceId?: string
  /**
   * Re-read immediately before DSH_HOME seeding and before the process spawn —
   * deliberately dynamic: runtime apply/restore can close the gate after an
   * earlier management-entry check.
   */
  canSpawn?: LocalSpawnGate
  /** Permanently close the owning plane's writer-safety latch on ambiguity. */
  onWriterQuiescenceUnknown?: (error: Error) => void
  /**
   * Optional host-graph patch overlay passed to every spawn as `--patch`. A
   * function is resolved behind the spawn fence so every start/restart can seed the
   * then-current profile safely.
   */
  patchPath?: string | (() => string | null)
  /**
   * Bundled pnpm entry made reachable to every managed host whose own PATH resolves
   * no pnpm (design 02 §3.1). Static for the process lifetime: the packaged layout
   * cannot move under a running shell.
   */
  pnpmEntry?: string | null
  /**
   * Desktop login-shell environment (login-shell-env.ts) every managed host
   * inherits — the early-started read promise or its resolved value. Set only
   * by the two desktop entries; absent keeps process.env.
   */
  hostEnv?: NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>
}

/** The local connection adapter surface (the createLocalConnection return). */
export interface LocalConnection {
  getState(): ConnectionState
  getDshPort(): number | null
  getError(): string | null
  /**
   * Why the LAST start attempt terminally failed before ever reaching ready (null
   * when it succeeded, is in flight, or nothing was attempted). The public /health
   * projection uses this to report a visible failure even while exposure is closed.
   */
  getStartFailure(): string | null
  getConsecutiveFailures(): number

  /**
   * Whether a real dsh process is currently alive (state-string independent — the
   * liveness fact for quit-risk decisions).
   */
  hasLiveProcess(): boolean
  /**
   * The unproven writer record, if any (see LocalWriterSuspect). Non-null ⇒ a managed
   * process group may still be writing DSH_HOME: stop() must not report quiescence.
   */
  getWriterSuspect(): LocalWriterSuspect | null
  /**
   * Whether a NEW request may be admitted to the managed local instance. False only while
   * the SINGLE reclamation primitive is proving the current generation's detached process
   * group gone — the exhaustion/stop windows in which connectionState is still serviceable
   * and the old port is still retained. It is an in-process admission fact, never published
   * on the wire and never folded into ConnectionState: an unproven retire keeps it closed
   * and the failure lands on 'error' (503 without details.state), while a PROVEN retire
   * reopens it before the terminal state is published, so a published restart-exhausted
   * still carries details.state (design 02 §3.6).
   */
  acceptsNewRequests(): boolean
  start(): Promise<void>
  stop(): Promise<void>
  /**
   * Transactional user-triggered dsh restart: refresh mounted plugins without a
   * stop()+start() pairing. Serialized on the same single-flight as the automatic
   * restart, so a user restart never stacks a second respawn and an automatic
   * trigger suspends instead. Entry checks reject with coded connection_busy
   * (instead of resolving silently) when a stop or start is in flight, the runtime
   * gate is closed, the instance was never started, or the machine is
   * restart-exhausted. CONTRACT: resolving does NOT promise success — a restart
   * that exhausts the shared window settles into 'restart-exhausted' and resolves,
   * so callers must read connectionState (or subscribe) to report honestly.
   */
  restartLocal(): Promise<void>
  /**
   * Lifecycle-change subscription (the producer behind the page channel's
   * `health` family, design 26): every transition fires the listener with the
   * /health `dsh` snapshot. Listener throws are isolated. Returns the unsubscribe.
   */
  onStateChange(listener: (snapshot: { status: string; port: number | null; error: string | null }) => void): () => void
}

/** Failure counter throttle: at most one count per window (ms). */
export const FAILURE_THROTTLE_MS = 15_000

/** Periodic health probe interval (ms). */
export const HEALTH_INTERVAL_MS = 30_000

/** Periodic health probe unary timeout (ms). */
export const HEALTH_PROBE_TIMEOUT_MS = 5_000

/** Health probe result cache: bursts within this window reuse the last verdict. */
export const HEALTH_RESULT_CACHE_MS = 750

/** Consecutive failures that force a restart (design 02 §3.5, N=20). */
export const RESTART_FAILURE_THRESHOLD = 20

/** Restart backoff floor (ms). */
export const RESTART_BACKOFF_FLOOR_MS = 1_000

/** Restart backoff ceiling (ms). */
export const RESTART_BACKOFF_CEIL_MS = 60_000

/** Restart window: restart counts inside it bound the restarts (ms). */
export const RESTART_WINDOW_MS = 600_000

/** Restarts allowed within one restart window before restart-exhausted. */
export const MAX_RESTARTS_IN_WINDOW = 5

/**
 * /health-safe reason (no path/port/internal detail) recorded when a restart leg ends on
 * an unproven writer or another terminal loop failure. The quarantine projection may show
 * it while the writer latch is closed; the raw cause stays in the host log.
 */
const RESTART_TERMINAL_FAILURE = 'local dsh restart failed: the host did not reach ready; restart the app to re-prove writer quiescence'

/** Create the local connection adapter (options + injectable deps). */
export function createLocalConnection({ stateDir, dshHome, dshWorkspacePath, logger, options = {}, deps = {} }: {
  stateDir: string
  dshHome: string
  /**
   * Workspace used by the next spawn. Runtime updates switch the active tree
   * without reconstructing the control plane, so the thunk is resolved for every
   * initial spawn and automatic restart.
   */
  dshWorkspacePath: string | (() => string)
  logger: Logger
  options?: LocalConnectionOptions
  deps?: LocalConnectionDeps
}): LocalConnection {
  const failureThrottleMs = options.failureThrottleMs ?? FAILURE_THROTTLE_MS
  const healthIntervalMs = options.healthIntervalMs ?? HEALTH_INTERVAL_MS
  const healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS
  const healthResultCacheMs = options.healthResultCacheMs ?? HEALTH_RESULT_CACHE_MS
  const restartFailureThreshold = options.restartFailureThreshold ?? RESTART_FAILURE_THRESHOLD
  const restartBackoffFloorMs = options.restartBackoffFloorMs ?? RESTART_BACKOFF_FLOOR_MS
  const restartBackoffCeilMs = options.restartBackoffCeilMs ?? RESTART_BACKOFF_CEIL_MS
  const restartWindowMs = options.restartWindowMs ?? RESTART_WINDOW_MS
  const maxRestartsInWindow = options.maxRestartsInWindow ?? MAX_RESTARTS_IN_WINDOW
  const dshPortBase = options.dshPortBase
  const ownerInstanceId = options.ownerInstanceId
  const pnpmEntry = options.pnpmEntry ?? null
  const hostEnv = options.hostEnv
  const spawnDshFn = (deps.spawnDsh ?? spawnDsh) as NonNullable<LocalConnectionDeps['spawnDsh']>
  const probeHostIdentity = deps.probeHostIdentity ?? probeHostIdentityFn

  function connectionBusy(reason: string): Error & { code: string } {
    const busy = new Error(reason) as Error & { code: string }
    busy.code = 'connection_busy'
    return busy
  }

  function isConnectionBusy(value: unknown): value is Error & { code: string } {
    return value instanceof Error && (value as Error & { code?: string }).code === 'connection_busy'
  }

  /** The process identity a spawned child carries (the durable ledger pid). */
  function childPid(value: SpawnedDsh): number | null {
    if (typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0) return value.pid
    const raw = (value.child as { pid?: unknown }).pid
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null
  }

  /** The process identity a coded writer-unknown error carries (spawn-dsh attaches child.pid). */
  function errorPid(value: unknown): number | null {
    if (!(value instanceof Error)) return null
    const raw = (value as Error & { pid?: unknown }).pid
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null
  }

  /** A managed child is alive only when NEITHER an exit code nor a signal was observed. */
  function isChildAlive(value: SpawnedDsh | null): boolean {
    return value !== null && value.child.exitCode === null && value.child.signalCode == null
  }

  /** Coded writer-unknown error built from the recorded suspect (pid/details for the API). */
  function writerUnknownError(suspect: LocalWriterSuspect, cause?: unknown): Error & { code: string } {
    const failure = new SpawnLifecycleError(
      DSH_WRITER_QUIESCENCE_UNKNOWN_CODE,
      `dsh writer quiescence is unknown${suspect.pid === null ? '' : ` (pid ${suspect.pid})`}: ${suspect.lastError}`,
      cause,
      suspect.pid,
    ) as Error & { code: string; details?: unknown }
    failure.details = { pid: suspect.pid, since: suspect.since, reason: suspect.lastError }
    return failure
  }

  /** Attach the fail-closed suspect details a REST error mapping may expose (409 detail). */
  function annotateWriterUnknown(error: Error, pid: number | null): Error {
    const coded = error as Error & { code?: string; details?: unknown }
    if (coded.details === undefined) {
      coded.details = { pid, since: Date.now(), reason: errorMessage(error) }
    }
    return error
  }

  /** Errors already recorded as an unproven writer (a retry rethrows the same object). */
  const recordedWriterUnknowns = new WeakSet<Error>()

  /**
   * Record an unproven process-group termination, latch the owning plane and report whether
   * the value was that coded failure. Evidence rules: a captured child handle is evidence
   * even when no pid is known; a childless failure is evidence only when the spawn layer
   * attached the pid of the group it could not prove gone — an unknown identity still
   * latches/errors, it just cannot claim a named live process.
   */
  function noteWriterQuiescenceUnknown(value: unknown, childRef: SpawnedDsh | null = null): boolean {
    if (!isWriterQuiescenceUnknown(value)) return false
    if (recordedWriterUnknowns.has(value)) return true
    recordedWriterUnknowns.add(value)
    const pid = (childRef === null ? null : childPid(childRef)) ?? errorPid(value)
    const lastError = errorMessage(value)
    const previous = writerSuspect
    if (childRef !== null || pid !== null) {
      writerSuspect = {
        pid,
        since: previous !== null && previous.pid === pid ? previous.since : Date.now(),
        lastError,
      }
    }
    try {
      options.onWriterQuiescenceUnknown?.(writerUnknownError(writerSuspect ?? { pid, since: Date.now(), lastError }, value))
    } catch (callbackError) {
      logger.error(`writer-quiescence latch callback failed: ${String(callbackError)}`)
    }
    return true
  }

  /**
   * The SINGLE reclamation primitive every lifecycle leg uses (start pre-clean, restart
   * loop, exhaustion, stop's second look, cancelled spawns): prove the current
   * generation's detached process group is gone. Resolves null only with that proof;
   * otherwise keeps the child handle + suspect evidence and returns the coded error the
   * caller must propagate. Nothing may clear the reference/state before this returns.
   */
  async function retireCurrentChild(context: string): Promise<Error | null> {
    const current = child
    if (current === null) {
      if (writerSuspect === null) return null
      return writerUnknownError(writerSuspect)
    }
    // Reclamation owns the teardown: detach the exit hook first so a late exit event can
    // neither schedule another restart nor race this proof.
    detachChildExit(current)
    // Admission closes for the ENTIRE proof window: the state machine still reads
    // serviceable (and the old port is still retained) until the group proof returns, so
    // new requests must not be routed into that generation meanwhile.
    acceptingNewRequests = false
    try {
      // Unconditional: an observed leader death (exitCode OR signalCode) says nothing about
      // the detached group — terminateChild's group proof is the only quiescence fact.
      await current.stop()
    } catch (retireError) {
      const pid = childPid(current) ?? errorPid(retireError)
      const typed = annotateWriterUnknown(isWriterQuiescenceUnknown(retireError)
        ? retireError as Error
        : writerUnknownError({ pid, since: Date.now(), lastError: errorMessage(retireError) }, retireError), pid)
      noteWriterQuiescenceUnknown(typed, current)
      logger.error(`local connection: ${context} could not prove the dsh process group is gone: ${errorMessage(typed)}`)
      return typed
    }
    child = null
    writerSuspect = null
    // The proof succeeded: new requests are admitted again BEFORE any terminal state is
    // published (the terminal 503 keeps details.state; an unproven retire stays closed).
    acceptingNewRequests = true
    return null
  }

  /** Prove a child this generation spawned but will not adopt (a cancelled start/restart). */
  async function retireSpawnedChild(spawned: SpawnedDsh, context: string): Promise<Error | null> {
    try {
      await spawned.stop()
    } catch (retireError) {
      const pid = childPid(spawned) ?? errorPid(retireError)
      const typed = annotateWriterUnknown(isWriterQuiescenceUnknown(retireError)
        ? retireError as Error
        : writerUnknownError({ pid, since: Date.now(), lastError: errorMessage(retireError) }, retireError), pid)
      noteWriterQuiescenceUnknown(typed, spawned)
      logger.error(`local connection: ${context} could not prove the dsh process group is gone: ${errorMessage(typed)}`)
      return typed
    }
    return null
  }

  /**
   * Resolve the `--patch` overlay path at spawn time, lazily behind the spawn fence,
   * so each start and restart sees (and may idempotently repair) the current profile seed.
   */
  function resolvePatchPath(): string | null {
    const value = options.patchPath
    return typeof value === 'function' ? value() : value ?? null
  }

  function resolveDshWorkspacePath(): string {
    const value = typeof dshWorkspacePath === 'function' ? dshWorkspacePath() : dshWorkspacePath
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('dsh workspace resolver returned an empty path')
    }
    return value
  }

  let state: ConnectionState = 'stopped'
  let error: string | null = null
  /**
   * Message of a start attempt that TERMINALLY failed before reaching 'ready'
   * (spawn retries exhausted, ledger failure, writer quiescence unknown). This is
   * the fail-loud fact /health may surface through a CLOSED exposure latch: a
   * candidate that never started is a failure the user must see, while one that
   * reached ready and later died stays quarantined. Cleared when a new attempt
   * begins or the connection stops.
   */
  let startFailure: string | null = null
  /** Lifecycle-change subscribers (the page channel's health producer, design 26). */
  const stateListeners = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()
  let dshPort: number | null = null
  let child: SpawnedDsh | null = null
  /** Exit hook of the ADOPTED generation (detached before reclamation; owner-checked). */
  let childExitHook: { owner: SpawnedDsh; listener: (code: number | null, sig: string | null) => void } | null = null
  /** Unproven termination evidence: a later retire must re-prove it, never report stopped. */
  let writerSuspect: LocalWriterSuspect | null = null
  /**
   * New-request admission (design 02 §3.6): closed by the reclamation primitive for the
   * whole exit-proof window and reopened only after the proof succeeds. retireCurrentChild
   * is its ONLY writer — the exhaustion and stop windows are the two cases in which the
   * state machine is still serviceable while a teardown is in flight.
   */
  let acceptingNewRequests = true
  let stopping = false
  let startPromise: Promise<void> | null = null
  let consecutiveFailures = 0
  let lastFailureAt = 0
  /** Bumped on start()/stop() so stale restart loops abort (see triggerRestart). */
  let epoch = 0
  /** Probe generation: every start / restart-entering / stop cancels and bumps it, so a
   *  late verdict can never write the cache/counter/state of a machine that moved on. */
  let healthEpoch = 0
  /** Generation abort for the in-flight health probe (cancelled by cancelProbe). */
  let healthGeneration = new AbortController()
  /** Periodic health probe timer (unref'd); cleared on stop/exhaust. */
  let healthTimer: NodeJS.Timeout | null = null
  /** Single-flight guard for the health probe; only the OWNING probe generation clears it. */
  let healthInFlight: { epoch: number; promise: Promise<void> } | null = null
  /** Last health verdict within the result cache window ({at, ok, reason}). */
  let healthResultCache: { at: number; ok: boolean; reason?: string } | null = null
  /** Single-flight restart sequence. */
  let restartPromise: Promise<void> | null = null
  /** The spawn/readiness attempt currently capable of writing DSH_HOME. */
  let spawnAbortController: AbortController | null = null
  /** Single-flight stop waits for every in-flight start/restart writer. */
  let stopPromise: Promise<void> | null = null
  /** Timestamps of restarts inside the current sliding window. */
  const restartTimes: number[] = []

  /**
   * Validate the lifecycle epoch and the external runtime gate as one fence. stop()
   * bumps epoch before it awaits anything, so a queued start that had already passed
   * the management-entry check cannot later seed or spawn.
   */
  function assertSpawnAllowed(expectedEpoch: number): void {
    if (stopping || epoch !== expectedEpoch) {
      throw connectionBusy('local start was invalidated by stop')
    }
    const gate = options.canSpawn?.()
    if (gate?.ok === false) throw connectionBusy(gate.reason)
  }

  /**
   * Invoke the spawn dependency under an abortable ownership token. stop() aborts
   * this controller and then awaits the owning start/restart promise; it cannot
   * report quiescence while a child is still booting or being reclaimed.
   */
  async function spawnWithOwnership(options: {
    stateDir: string
    dshHome: string
    dshWorkspacePath: string
    logger: Logger
    patchPath: string | null
    pnpmEntry: string | null
  }): Promise<SpawnedDsh> {
    const controller = new AbortController()
    if (spawnAbortController !== null) {
      throw new Error('local connection invariant violated: concurrent spawn ownership')
    }
    spawnAbortController = controller
    try {
      return await spawnDshFn({
        ...options,
        ...(hostEnv === undefined ? {} : { hostEnv }),
        ...(ownerInstanceId === undefined ? {} : { ownerInstanceId }),
        ...(dshPortBase === undefined ? {} : { dshPortBase }),
        signal: controller.signal,
      })
    } finally {
      if (spawnAbortController === controller) spawnAbortController = null
    }
  }

  /** Per-port rolling-log writer: lazy, failure-swallowing — a dead log file must
   *  never take the connection state machine down. Tracked by port: after a respawn
   *  the old writer is closed and recreated. */
  let hostLogWriter: { write(line: string, kind?: string): void; close(): Promise<void> } | null = null
  let hostLogWriterPort: number | null = null
  function noteHostLog(line: string, portOverride: number | null = null) {
    if (typeof line !== 'string' || line === '') return
    const port = portOverride ?? dshPort
    if (port !== null && port > 0 && (hostLogWriter === null || hostLogWriterPort !== port)) {
      if (hostLogWriter !== null) {
        try {
          void hostLogWriter.close()
        } catch {
          /* swallow — see note above */
        }
        hostLogWriter = null
      }
      try {
        // A dropped host-log batch must be visible in the control-plane log: the lane
        // warns once per failure episode through this sink.
        hostLogWriter = createHostLogWriter(stateDir, port, { warn: message => logger.warn(message) })
        hostLogWriterPort = port
      } catch {
        hostLogWriter = { write() {}, async close() {} }
        hostLogWriterPort = port
      }
    }
    try {
      hostLogWriter?.write(line, 'control')
    } catch {
      /* swallow — see note above */
    }
  }

  /** Set the process-local machine state, then log and publish its live projection. */
  function setState(next: ConnectionState, nextError: string | null = null) {
    state = next
    error = nextError
    logger.log(`local connection → ${next}${nextError ? `: ${nextError}` : ''}`)
    // The host itself stays silent on stdio in the web profile, so lifecycle
    // transitions are the observable content of GET /api/host/logs — always written.
    noteHostLog(`[control-plane] local connection → ${next}${nextError ? `: ${nextError}` : ''}`)
    // Push channel: every transition reaches the page channel's health producer
    // instantly; the producer additionally emits the current snapshot when a
    // subscription opens, so a late subscriber is never left on a stale state.
    // Subscriber throws are isolated.
    const snapshot = { status: next, port: dshPort, error: nextError }
    for (const listener of stateListeners) {
      try {
        listener(snapshot)
      } catch (listenerError) {
        logger.warn(`local connection: state-change listener threw: ${String(listenerError)}`)
      }
    }
  }

  /**
   * Count one connection failure (throttled to at most one count per
   * failureThrottleMs so a probe storm cannot skew the restart heuristic).
   */
  function countFailure() {
    const now = Date.now()
    if (consecutiveFailures === 0 || now - lastFailureAt >= failureThrottleMs) {
      consecutiveFailures += 1
      lastFailureAt = now
    }
  }

  /**
   * Shared failure handler for every health channel: a dead child skips counting
   * and restarts immediately; live failures count (throttled) into the shared
   * counter and land on degraded; at the threshold a restart is triggered.
   * State-guarded: a verdict that lands after stop()/error must be inert — the
   * machine must not be resurrected or re-counted.
   */
  function noteHealthFailure(reason: string) {
    // A probe in flight when the restart began observes the torn-down child; its verdict must not count.
    if (restartPromise !== null) return
    // State-guarded: a verdict landing after stop()/error must be inert.
    if (stopping || state === 'stopped' || state === 'error') return
    if (!isChildAlive(child)) {
      // One liveness predicate everywhere: exitCode OR signalCode observed = the leader is
      // dead; the detached group still has to be proven gone by the restart's retire.
      void triggerRestart(`dsh process died: ${reason}`)
      return
    }
    countFailure()
    if (state === 'ready' || state === 'starting') setState('degraded', reason)
    if (consecutiveFailures >= restartFailureThreshold) {
      void triggerRestart(`health failed ${consecutiveFailures} consecutive times (threshold ${restartFailureThreshold}): ${reason}`)
    }
  }

  /** Any probe success clears the counter and returns to ready. */
  function onHealthSuccess() {
    // A probe in flight when the restart began observes the torn-down child; its verdict must not clear state.
    if (restartPromise !== null) return
    consecutiveFailures = 0
    if (state === 'degraded') setState('ready')
  }

  /**
   * One real health probe (or the cached verdict when within
   * healthResultCacheMs — a burst of triggers shares one probe) for ONE probe generation.
   * The epoch is re-checked after every await: a verdict, cache write, failure count or
   * state transition of a superseded generation is dropped, never applied (INV-A5).
   */
  async function performHealthCheck(source: string, probeEpoch: number): Promise<void> {
    if (probeEpoch !== healthEpoch) return
    if (healthResultCache !== null && Date.now() - healthResultCache.at < healthResultCacheMs) {
      if (healthResultCache.ok) onHealthSuccess()
      else noteHealthFailure(`health probe (${source}): cached ${healthResultCache.reason}`)
      return
    }
    try {
      // The unified host-identity probe: fixed-size session/canOpenWorkspacePath boolean,
      // legacy session/list fallback on an identity-method 404. The probe never re-reads
      // session data, so its verdict stays decoupled from session-count growth and its
      // response size is independent of session count.
      await probeHostIdentity(`http://127.0.0.1:${dshPort}`, {
        timeoutMs: healthProbeTimeoutMs,
        generationSignal: healthGeneration.signal,
        logger,
      })
      if (probeEpoch !== healthEpoch) return
      healthResultCache = { at: Date.now(), ok: true }
      onHealthSuccess()
    } catch (probeError) {
      if (probeEpoch !== healthEpoch) return
      const reason = String(probeError)
      healthResultCache = { at: Date.now(), ok: false, reason }
      noteHealthFailure(`health probe (${source}): ${reason}`)
    }
  }

  /**
   * The health check entry point shared by the periodic timer and transport
   * triggers: single-flight per probe generation and suppressed while stopping,
   * restarting, or outside ready/degraded. A stale generation's still-pending probe
   * does not block the current generation's probe, and its late settlement can only
   * release its OWN single-flight slot.
   */
  async function runHealthCheck(source: string): Promise<void> {
    if (stopping || restartPromise !== null) return
    if (state !== 'ready' && state !== 'degraded') return
    const probeEpoch = healthEpoch
    if (healthInFlight !== null && healthInFlight.epoch === probeEpoch) return healthInFlight.promise
    const slot = { epoch: probeEpoch, promise: performHealthCheck(source, probeEpoch) }
    healthInFlight = slot
    try {
      await slot.promise
    } catch (healthError) {
      logger.warn(`health check threw: ${String(healthError)}`)
    } finally {
      if (healthInFlight === slot) healthInFlight = null
    }
  }

  /** Start the periodic probe timer (idempotent, unref'd). */
  function startHealthTimer() {
    if (healthIntervalMs <= 0) return
    if (healthTimer !== null) return
    healthTimer = setInterval(() => void runHealthCheck('periodic'), healthIntervalMs)
    healthTimer.unref?.()
  }

  /** Stop the periodic probe timer. */
  function stopHealthTimer() {
    if (healthTimer !== null) {
      clearInterval(healthTimer)
      healthTimer = null
    }
  }

  /**
   * Cancel the current probe generation: bump the epoch, abort the in-flight signal,
   * drop the timer and the result cache. The in-flight probe's promise is left to settle
   * on its own (its epoch check drops the verdict); stop() is the one caller that awaits it.
   */
  function cancelProbe() {
    healthEpoch += 1
    healthGeneration.abort()
    healthGeneration = new AbortController()
    stopHealthTimer()
    healthResultCache = null
  }

  /** Backoff wait that aborts early when stop() bumps the epoch. */
  function waitForRestartBackoff(ms: number, restartEpoch: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(done, ms)
      const interval = setInterval(() => {
        if (stopping || epoch !== restartEpoch) done()
      }, 100)
      function done() {
        clearTimeout(timer)
        clearInterval(interval)
        resolve()
      }
    })
  }

  /**
   * The restart sequence, single-flight: prove the residual child's process group gone,
   * respawn through deps.spawnDsh, back to ready. Failed restarts loop with exponential
   * backoff (1s → 60s); the restart count inside the sliding window bounds it — at
   * maxRestartsInWindow the machine lands on restart-exhausted ONLY after the retire proof,
   * until a manual start(). The loop aborts when stop() or start() bumps the epoch.
   * CONTRACT: a writer-quiescence-unknown rejection is never folded into resolve — stop()
   * and restartLocal() callers must see the coded failure.
   */
  function triggerRestart(reason: string): Promise<void> {
    if (stopping) return Promise.resolve()
    // A start() in flight owns the spawn: a late failure must never double-spawn alongside it.
    if (startPromise !== null) return Promise.resolve()
    if (state === 'restart-exhausted' || state === 'stopped' || state === 'error') return Promise.resolve()
    if (restartPromise !== null) return restartPromise
    const run = (async () => {
      const restartEpoch = epoch
      try {
        for (;;) {
          if (stopping || epoch !== restartEpoch) return
          const now = Date.now()
          while (restartTimes.length > 0 && restartTimes[0] <= now - restartWindowMs) restartTimes.shift()
          if (restartTimes.length >= maxRestartsInWindow) {
            // The exhaustion reclaim is a probe-generation break too (design 02 §3.6 step 7):
            // no in-flight verdict of the dying generation may outlive this teardown.
            cancelProbe()
            // INV-A2: restart-exhausted triggers the runtime auto-rollback, so it may only be
            // published after this generation's process group is PROVEN gone. An unproven
            // retire lands on 'error' (latch + suspect kept) and never publishes it.
            const retired = await retireCurrentChild('restart-exhausted')
            if (retired !== null) {
              startFailure = RESTART_TERMINAL_FAILURE
              setState('error', retired.message)
              throw retired
            }
            // A stop()/start() that invalidated this generation while the proof was pending
            // owns the outcome: publishing restart-exhausted here would let the desktop
            // auto-rollback run for a lifecycle that already moved on (design 02 §3.6 third
            // criterion). The canceler's continuation publishes the terminal state and clears
            // the port without any I/O await before it, so the transient serviceable-state +
            // retained-port projection cannot admit a request to the proven-gone generation.
            if (stopping || epoch !== restartEpoch) return
            const exhaustedPort = dshPort
            dshPort = null
            // The child is proven gone — the browser-auth cookie must not linger (a later start re-mints).
            if (exhaustedPort !== null) clearAuthCookie(`http://127.0.0.1:${exhaustedPort}`)
            setState('restart-exhausted', `restarted ${restartTimes.length} times within ${restartWindowMs}ms; automatic restarting stopped, manual start() required`)
            return
          }
          restartTimes.push(now)
          const attempt = restartTimes.length
          if (attempt > 1) {
            const delay = Math.min(restartBackoffFloorMs * 2 ** (attempt - 2), restartBackoffCeilMs)
            logger.log(`restart attempt ${attempt} backoff ${delay}ms: ${reason}`)
            await waitForRestartBackoff(delay, restartEpoch)
            if (stopping || epoch !== restartEpoch) return
          }
          // Entering a restart generation invalidates the previous probe generation: its late
          // verdict/cache/counter must not land on the generation about to be spawned.
          cancelProbe()
          setState('restarting', null)
          try {
            const retired = await retireCurrentChild('restart')
            if (retired !== null) {
              startFailure = RESTART_TERMINAL_FAILURE
              setState('error', retired.message)
              throw retired
            }
            await deps.beforeSpawnCheckpoint?.('restart')
            // First fence: resolvePatchPath() may seed packages into DSH_HOME, so runtime apply/restore must still be open.
            assertSpawnAllowed(restartEpoch)
            const resolvedWorkspacePath = resolveDshWorkspacePath()
            const resolvedPatchPath = resolvePatchPath()
            // Second fence: a gate closed after the seed checkpoint must never reach the actual spawn.
            assertSpawnAllowed(restartEpoch)
            const spawned = await spawnWithOwnership({
              stateDir,
              dshHome,
              dshWorkspacePath: resolvedWorkspacePath,
              logger,
              patchPath: resolvedPatchPath,
              pnpmEntry,
            })
            if (stopping || epoch !== restartEpoch) {
              // A cancelled generation must still PROVE the child it just spawned is gone.
              const cancelled = await retireSpawnedChild(spawned, 'restart-cancel')
              if (cancelled !== null) {
                startFailure = RESTART_TERMINAL_FAILURE
                setState('error', cancelled.message)
                throw cancelled
              }
              return
            }
            child = spawned
            dshPort = spawned.port
            consecutiveFailures = 0
            healthResultCache = null
            writerSuspect = null
            attachChildExit(spawned)
            setState('ready')
            startHealthTimer()
            return
          } catch (restartError) {
            dshPort = null
            if (isWriterQuiescenceUnknown(restartError)) {
              // Retire/cancel failures were recorded by the reclamation primitive; a spawn
              // layer writer-unknown arrives unrecorded and is recorded here (its coded pid
              // rides the error). A restart leg never folds this into resolve.
              noteWriterQuiescenceUnknown(restartError)
              startFailure = RESTART_TERMINAL_FAILURE
              stopHealthTimer()
              setState('error', restartError.message)
              throw restartError
            }
            logger.log(`restart failed: ${String(restartError)}`)
            if (stopping || epoch !== restartEpoch) return
            if (isConnectionBusy(restartError)) {
              stopHealthTimer()
              setState('stopped', restartError.message)
              return
            }
          }
        }
      } catch (loopError) {
        // Writer-quiescence unknown must reach stop()/restartLocal() callers; every other
        // loop failure keeps the historical projection (error state, resolved promise).
        if (isWriterQuiescenceUnknown(loopError)) throw loopError
        startFailure = RESTART_TERMINAL_FAILURE
        try { setState('error', errorMessage(loopError)) } catch { /* nothing left to write */ }
      }
    })()
    const tracked = run.finally(() => {
      if (restartPromise === tracked) restartPromise = null
    })
    // Automatic triggers are fire-and-forget; restartLocal()/stop() await the same promise
    // and still observe a writer-unknown rejection (never folded into resolve).
    void tracked.catch(() => {})
    restartPromise = tracked
    return tracked
  }

  /** Generation-scoped exit listener: reclamation detaches it, and the owner check keeps a
   *  late exit of a superseded child inert even on a structural fake without `off` (G10). */
  function attachChildExit(owner: SpawnedDsh): void {
    const listener = (code: number | null, sig: string | null) => onChildExit(owner, code, sig)
    childExitHook = { owner, listener }
    owner.child.on('exit', listener)
  }

  function detachChildExit(owner: SpawnedDsh): void {
    const hook = childExitHook
    if (hook === null || hook.owner !== owner) return
    childExitHook = null
    try {
      owner.child.off?.('exit', hook.listener)
    } catch {
      /* a structural fake without off keeps the inert listener (see the owner check) */
    }
  }

  /**
   * The child exit listener: a dead dsh must not stay ready. Process death skips the
   * failure counter and goes straight into the restart sequence; during an in-flight
   * restart the sequence drives the teardown, so nothing else is scheduled. A start()
   * in flight also suppresses it: startImpl tears down the previous child while
   * startPromise is set, and that exit must not schedule a second spawn alongside the
   * one startImpl is about to perform (it would race the spawn and leak a detached dsh).
   * The generation check makes a late exit of an already-retired child inert.
   */
  function onChildExit(owner: SpawnedDsh, code: number | null, sig: string | null): void {
    if (child !== owner) {
      logger.log(`dsh process exited (${code ?? sig}) from a superseded generation; inert`)
      return
    }
    if (childExitHook !== null && childExitHook.owner === owner) childExitHook = null
    logger.log(`dsh process exited (${code ?? sig})`)
    if (stopping) return
    if (restartPromise !== null) return
    if (startPromise !== null) return
    if (state === 'ready' || state === 'starting' || state === 'degraded') {
      void triggerRestart(`dsh process exited (${code ?? sig})`)
    }
  }

  /**
   * The start implementation. Single-flight via startPromise; a spawn failure is
   * terminal for this attempt: the machine lands on 'error' and start() rejects.
   */
  async function startImpl(): Promise<void> {
    // A start racing an authoritative stop must fail loudly: returning the cancelled
    // generation's promise would resolve with a row while the connection lands on stopped.
    if (stopping) throw connectionBusy('local connection is stopping')
    if (startPromise !== null) return startPromise
    const ownedStart = (async () => {
      // `degraded` is still serving (design 02 §3.5): an idempotent start must
      // not tear down a live child. A real restart goes through restartLocal().
      if (isServiceableLocalState(state)) return
      epoch += 1
      // Invalidate the current probe generation: a late verdict/cache/counter must not land
      // on the generation this start is about to create.
      cancelProbe()
      // Capture the epoch, not just the mutable `stopping` flag: stop() bumps it before
      // aborting/awaiting this owner, so the start cannot seed after a queued stop or adopt
      // a child from a stale readiness attempt. The guard survives stop() resetting
      // `stopping`, so a late-resolving spawn is torn down instead of adopted.
      const startEpoch = epoch
      if (restartPromise !== null) {
        // A prior restart may have ended on an unproven writer; its coded failure must not
        // escape this start leg as an anonymous rejection — the retire below re-proves it and
        // the start reports the same typed failure.
        try { await restartPromise } catch (restartError) { noteWriterQuiescenceUnknown(restartError) }
      }
      if (stopping || epoch !== startEpoch) {
        throw connectionBusy('local start was invalidated by stop')
      }
      // INV-A1: no next generation before this generation's process-group proof. An
      // unproven retire keeps the suspect and surfaces as a coded failure (never silence).
      const retired = await retireCurrentChild('start')
      if (retired !== null) {
        startFailure = errorMessage(retired)
        setState('error', errorMessage(retired))
        throw retired
      }
      stopHealthTimer()
      consecutiveFailures = 0
      lastFailureAt = 0
      restartTimes.length = 0
      healthResultCache = null
      // A fresh start has no port yet — the old (dead) one must not ride the 'starting' projection.
      dshPort = null
      // A new attempt clears the previous terminal failure: health shows 'starting', never a stale error.
      startFailure = null
      setState('starting')
      let spawnAttempted = false
      try {
        await deps.beforeSpawnCheckpoint?.('start')
        // First fence: patch resolution is the first pre-spawn operation allowed to write DSH_HOME.
        assertSpawnAllowed(startEpoch)
        const resolvedWorkspacePath = resolveDshWorkspacePath()
        const resolvedPatchPath = resolvePatchPath()
        // Second fence: re-read epoch and runtime gate at the actual spawn boundary, not only at API entry.
        assertSpawnAllowed(startEpoch)
        spawnAttempted = true
        const spawned = await spawnWithOwnership({
          stateDir,
          dshHome,
          dshWorkspacePath: resolvedWorkspacePath,
          logger,
          patchPath: resolvedPatchPath,
          pnpmEntry,
        })
        if (stopping || epoch !== startEpoch) {
          // A cancelled generation must still PROVE the child it just spawned is gone.
          const cancelled = await retireSpawnedChild(spawned, 'start-cancel')
          if (cancelled !== null) {
            startFailure = errorMessage(cancelled)
            setState('error', errorMessage(cancelled))
            throw cancelled
          }
          return
        }
        child = spawned
        dshPort = spawned.port
        startFailure = null
        writerSuspect = null
        healthResultCache = null
        attachChildExit(spawned)
        setState('ready')
        startHealthTimer()
        return
      } catch (spawnError) {
        const failureMessage = spawnError instanceof Error ? spawnError.message : String(spawnError)
        if (noteWriterQuiescenceUnknown(spawnError)) {
          startFailure = failureMessage
          setState('error', failureMessage)
          throw spawnError
        }
        if (stopping || epoch !== startEpoch) {
          // Once spawn ownership was entered, stop() awaits this promise as a writer barrier,
          // so resolve with the current row after cleanup instead of leaking an expected
          // rejection. A pre-spawn fence closure is different: no writer was acquired and the
          // management caller must receive connection_busy, not a false success.
          if (spawnAttempted) return
          if (isConnectionBusy(spawnError)) throw spawnError
          throw connectionBusy('local start was invalidated by stop')
        }
        child = null
        dshPort = null
        if (isConnectionBusy(spawnError)) {
          // An expected fence closure is a stopped lifecycle, not a broken runtime.
          if (state !== 'stopped') setState('stopped', spawnError.message)
          throw spawnError
        }
        // Terminal for this attempt: record the reason so /health can report it through a closed latch.
        startFailure = failureMessage
        setState('error', failureMessage)
        throw spawnError
      }
    })()
    startPromise = ownedStart
    try {
      return await ownedStart
    } finally {
      // Only the owning generation may release the single-flight slot.
      if (startPromise === ownedStart) startPromise = null
    }
  }

  return {
    /** Current machine state. */
    getState(): ConnectionState {
      return state
    },

    /** The dsh port this connection serves; null while stopped. */
    getDshPort(): number | null {
      return dshPort
    },

    /**
     * Whether a real dsh process is currently alive. The state alone is NOT a
     * liveness fact: during a restart the state is 'restarting' before the new
     * process exists (backoff 1s→60s), and a dead child can linger on
     * 'ready'/'degraded' until the next probe. Quit-risk decisions must key on this.
     */
    hasLiveProcess(): boolean {
      // Fail-safe: alive means neither exit code nor signal was observed on a live child —
      // and an unproven writer termination (suspect) counts as possibly alive, because its
      // detached group may still be writing DSH_HOME.
      return isChildAlive(child) || writerSuspect !== null
    },

    /** The unproven writer record (see LocalWriterSuspect); null when quiescence is proven. */
    getWriterSuspect(): LocalWriterSuspect | null {
      return writerSuspect
    },

    /** Whether a new request may be admitted (see the interface docblock). */
    acceptsNewRequests(): boolean {
      return acceptingNewRequests
    },

    /** Current error detail; null when healthy. */
    getError(): string | null {
      return error
    },

    /** Why the last start/restart attempt terminally failed before reaching ready (null when
     *  none, in flight, or stopped). /health may surface this through a closed latch. */
    getStartFailure(): string | null {
      return startFailure
    },

    /** Consecutive connection failures (probe failures/child exit), reset on connect. */
    getConsecutiveFailures(): number {
      return consecutiveFailures
    },

    /**
     * Start (or restart) the connection: terminate a stale child, spawn a fresh dsh
     * web profile, land on ready. Idempotent while starting; a serviceable
     * connection (`ready` or still-serving `degraded`, design 02 §3.5) is left
     * untouched — use restartLocal() for a real refresh. Any in-flight restart is
     * aborted via the epoch bump, and the restart window/counter state is reset.
     * Returns the connection row.
     */
    start: startImpl,

    /**
     * Stop the connection: prove the child's whole detached process group gone (the spawn
     * layer's SIGTERM → grace → SIGKILL proof), stop the health probe, land on 'stopped'.
     * Any in-flight start/restart is invalidated, aborted and awaited; RESOLVING stop()
     * proves no managed local writer remains — an unproven retire (or a retained suspect,
     * even with no in-memory child) rejects with the coded writer-quiescence error and
     * never reports 'stopped'.
     */
    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise
      if (state === 'stopped' && child === null && startPromise === null && restartPromise === null && writerSuspect === null) {
        return Promise.resolve()
      }
      stopping = true
      epoch += 1
      // Cancel the probe generation before anything is awaited: its late verdict must never
      // land after stop() returned and resurrect the connection.
      cancelProbe()
      // Capture the owners after bumping the epoch; neither can publish a child for this lifecycle now.
      const pendingStart = startPromise
      const pendingRestart = restartPromise
      spawnAbortController?.abort()
      const work = (async () => {
        try {
          // Wait for the cancelled probe to settle (a non-cooperative seam is still awaited;
          // a real probe settles promptly on the aborted generation signal).
          const pendingProbe = healthInFlight
          if (pendingProbe !== null) {
            try {
              await pendingProbe.promise
            } catch { /* defensive — runHealthCheck swallows */ }
          }
          // start/restart own cleanup for any process launched before the abort. Await both
          // owners without a timeout: stopLocal is the writer barrier and must not claim quiescence early.
          const ownerResults = await Promise.allSettled([
            ...(pendingStart === null ? [] : [pendingStart]),
            ...(pendingRestart === null ? [] : [pendingRestart]),
          ])
          const unknownOwner = ownerResults.find((result): result is PromiseRejectedResult =>
            result.status === 'rejected' && isWriterQuiescenceUnknown(result.reason))
          // Second (and final) reclamation through the single primitive: unconditional group
          // proof — a leader already observed dead (exitCode/signalCode) still leaves a group.
          const retired = await retireCurrentChild('stop')
          if (retired !== null) {
            setState('error', retired.message)
            throw retired
          }
          if (unknownOwner !== undefined) {
            // An owner failed to prove its writer gone; even without retained evidence the
            // caller must see the typed failure instead of a 'stopped' row.
            setState('error', errorMessage(unknownOwner.reason))
            throw unknownOwner.reason
          }
          const stoppedPort = dshPort
          child = null
          dshPort = null
          // A stopped connection has no terminal start failure to report.
          startFailure = null
          restartTimes.length = 0
          // A failed verdict cached right before stop must not replay after a later start and re-count.
          healthResultCache = null
          // The browser-auth cookie is process-memory only; drop it with the instance.
          if (stoppedPort !== null) clearAuthCookie(`http://127.0.0.1:${stoppedPort}`)
          // setState writes the final line through the existing per-port writer even though dshPort is null.
          setState('stopped', null)
          if (hostLogWriter !== null) {
            await hostLogWriter.close()
            hostLogWriter = null
          }
          hostLogWriterPort = null
        } catch (stopError) {
          if (noteWriterQuiescenceUnknown(stopError)) {
            setState('error', errorMessage(stopError))
          }
          throw stopError
        } finally {
          stopping = false
        }
      })()
      let tracked: Promise<void>
      tracked = work.finally(() => {
        if (stopPromise === tracked) stopPromise = null
      })
      stopPromise = tracked
      return tracked
    },

    /**
     * Transactional user-triggered dsh restart, serialized on the same single-flight as
     * the automatic restart. The entry checks are the only difference: they reject with
     * coded connection_busy (instead of silently resolving) when a stop or start is in
     * flight, the runtime gate is closed, the instance was never started, or from
     * restart-exhausted (recovery stays on start()). Otherwise it delegates to
     * triggerRestart — merging into an in-flight restart or running the same bounded
     * stop→respawn→ready transaction. CONTRACT: resolving does NOT promise success — a
     * restart that exhausts the shared window settles into 'restart-exhausted' and
     * resolves, so callers must read connectionState (or subscribe) to report honestly.
     * A writer-quiescence-unknown rejection is propagated (never folded into resolve).
     */
    restartLocal(): Promise<void> {
      if (stopping) return Promise.reject(connectionBusy('local restart was invalidated by stop'))
      if (startPromise !== null || state === 'starting') {
        return Promise.reject(connectionBusy('local start in progress; wait for readiness before restarting'))
      }
      // The dynamic spawn gate stays authoritative across every state: an
      // applying/restore window must report its own reason even from stopped.
      const gate = options.canSpawn?.()
      if (gate?.ok === false) return Promise.reject(connectionBusy(gate.reason))
      if (state === 'stopped' || state === 'error') {
        return Promise.reject(connectionBusy('local dsh is not running; start() before restarting'))
      }
      if (restartPromise !== null) return restartPromise
      if (state === 'restart-exhausted') {
        return Promise.reject(connectionBusy('restart-exhausted: automatic restarting stopped; recover with start() before restarting'))
      }
      return triggerRestart('user-requested dsh restart')
    },

    /** Subscribe to lifecycle transitions (see the interface docblock). */
    onStateChange(listener: (snapshot: { status: string; port: number | null; error: string | null }) => void): () => void {
      stateListeners.add(listener)
      return () => { stateListeners.delete(listener) }
    },
  }
}
