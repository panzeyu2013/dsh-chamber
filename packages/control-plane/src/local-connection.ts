/**
 * Local dsh host management (v4): spawn lifecycle, readiness, health
 * monitoring, restart, graceful stop.
 *
 * v4 (connection-manager shape, design 02): the control plane no longer
 * consumes host frames — session business belongs to the dsh frontend runtime
 * (N-ctx), which reaches the instance through the per-instance reverse proxy
 * (/api/i/local/*, design 03 §3). This module therefore owns only the
 * process-level facts:
 *
 * - spawn via spawn-dsh.ts (web profile, fixed port + P+1 retry, pid record);
 * - readiness = the spawn's TCP + session/list probe (spawn-dsh owns it;
 *   the old host.describe readiness handshake was deleted upstream in dsh
 *   0.1.2-alpha.1);
 * - health monitoring (design 02 §3.5): a periodic session/list probe (30s
 *   default, 5s unary timeout, single-flight with a 750ms result cache)
 *   shares one failure counter with the transport triggers (child exit,
 *   probe failures). Failures 1..N-1 land on degraded; the Nth failure
 *   enters the restart sequence. A dead child skips counting and restarts
 *   immediately. Restarts within a window are bounded (backoff 1s → 60s,
 *   max restarts per 10min window) before the machine lands on
 *   restart-exhausted. Any probe success resets the counter and returns to
 *   ready. Probes and restarts are suppressed while stopping and during an
 *   in-flight restart.
 * - state machine (design 02 §3.5):
 *   stopped → starting → ready ⇄ degraded → restarting → restart-exhausted →
 *   stopped; spawn failures land on 'error' (fail-loud; start() respawns);
 * - graceful stop (design 02 §3.7): process-group SIGTERM → 1s → SIGKILL,
 *   pid record removed after confirmed exit, state back to stopped;
 * - the catalog row projection: status/dshPort/error ride the persisted
 *   connection row (design 03 §2.1: runtime facts are projections, the
 *   control plane is never authoritative over host business);
 * - managed-host rolling logs (design 02 §3.8): lifecycle lines are written
 *   to the per-port rolling log so GET /api/host/logs has content even while
 *   the host itself is silent on stdio.
 *
 * External/claim takeover mode (v2 design 02 §3.6.2) is gone: external-claim
 * was deleted with the thin-shell architecture (01 §4/§5) — the local
 * instance is always managed.
 */

import { isWriterQuiescenceUnknown, spawnDsh } from './spawn-dsh.ts'
import { clearAuthCookie } from './browser-auth-cookie.ts'
import { describeCapabilities as describeCapabilitiesFn } from './dsh-client.ts'
import { createHostLogWriter } from './host-logs.ts'
import type { Logger } from './types.ts'

/** The connection state machine vocabulary (the REST dsh.status contract). */
export type ConnectionState =
  | 'stopped' | 'starting' | 'ready' | 'degraded'
  | 'restarting' | 'restart-exhausted' | 'error'

/** The spawned dsh child surface used by this adapter. */
export interface SpawnedDsh {
  child: {
    on(event: string, listener: (...args: any[]) => void): unknown
    exitCode: number | null
    signalCode?: string | null
  }
  port: number
  stop(): Promise<void>
}

/** The catalog face this adapter touches (the single local connection row). */
export interface CatalogLike {
  getConnection(connectionId: string | null): { connectionId: string; status?: string; dshPort?: number | null; error?: string } | null
  upsertConnection(row: { connectionId: string; status?: string; dshPort?: number | null; error?: string }): unknown
}

/** Unary dsh call surface (the deps.call seam, narrowed to what this uses). */
export type DescribeCapabilitiesFn = (
  baseUrl: string,
  options: { generationSignal?: AbortSignal; force?: boolean; timeoutMs?: number },
) => Promise<{ value?: any; cachedAt?: number }>

/** Injectable connection-adapter dependencies (test seams for the wire). */
export interface LocalConnectionDeps {
  spawnDsh?: (options: {
    stateDir: string
    dshHome: string
    dshWorkspacePath: string
    logger: Logger
    /** Optional `--patch` overlay for the dsh launcher (design 09 module B); null/absent when none. */
    patchPath?: string | null
    /** First port attempted (design 17 §3 server override); absent = BASE_DHSPORT. */
    dshPortBase?: number
    /** Aborted by stop() so a readiness wait cannot outlive writer quiescence. */
    signal?: AbortSignal
  }) => Promise<SpawnedDsh>
  describeCapabilities?: DescribeCapabilitiesFn
  /**
   * Test-only scheduling seam. Production leaves this absent; race tests use
   * it to suspend a start after the public entry gate but before any
   * DSH_HOME seed or process spawn.
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
  /** First port attempted for the managed dsh host (design 17 §3 server
   *  deployments; absent = BASE_DHSPORT 17510). */
  dshPortBase?: number
  /**
   * Re-read immediately before DSH_HOME seeding and immediately before the
   * process spawn. This is deliberately dynamic: runtime apply/restore can
   * close the gate after an earlier management-entry check.
   */
  canSpawn?: LocalSpawnGate
  /** Permanently close the owning plane's writer-safety latch on ambiguity. */
  onWriterQuiescenceUnknown?: (error: Error) => void
  /**
   * Optional host-graph patch overlay passed to every spawn as `--patch`
   * (design 09 module B). A function is resolved behind the spawn fence so
   * every initial start/restart can seed the then-current profile safely.
   */
  patchPath?: string | (() => string | null)
}

/** The connection row returned by start(). */
export interface ConnectionRow {
  connectionId: string
  status?: string
  dshPort?: number | null
  error?: string
}

/** The local connection adapter surface (the createLocalConnection return). */
export interface LocalConnection {
  getState(): ConnectionState
  getDshPort(): number | null
  getError(): string | null
  getConsecutiveFailures(): number
  /** 0.1.2 wire: session/list snapshot (host.describe was deleted upstream). */

  /**
   * Whether a real dsh process is currently alive under this connection
   * (state-string independent — the liveness fact for quit-risk decisions).
   */
  hasLiveProcess(): boolean
  start(): Promise<ConnectionRow | null>
  stop(): Promise<void>
  /**
   * Transactional user-triggered dsh restart (design 18 §9.3): refresh
   * mounted plugins without a stop()+start() pairing. Shares the health
   * state machine's restart single-flight, so a user restart never stacks a
   * second respawn on top of an in-flight automatic restart (and an
   * automatic trigger while a user restart is in flight suspends instead of
   * double-spawning). Entry-time differences from the automatic path
   * (connection_busy rejection instead of a silent resolve): an in-progress
   * stop, a closed runtime gate (canStartLocal — applying/restore), or
   * restart-exhausted. The restart transaction itself — process-group
   * SIGTERM → 1s → SIGKILL, same-port/P+1 respawn behind the spawn fence,
   * readiness probe, failure-counter reset, and the shared bounded backoff +
   * restart-exhausted window — is identical for user and health triggers.
   */
  restartLocal(): Promise<void>
  /**
   * Lifecycle-change subscription (the push channel behind GET
   * /api/host/health-events, design 05 §3): every machine transition fires
   * the listener with the /health `dsh` snapshot. The renderer never polls
   * for local status (the remote roster already rides desktop pushes).
   * Listener throws are isolated — a subscriber must never break the state
   * machine. Returns the unsubscribe.
   */
  onStateChange(listener: (snapshot: { status: string; port: number | null; error: string | null }) => void): () => void
}

/** Failure counter throttle: at most one count per window (ms). */
export const FAILURE_THROTTLE_MS = 15_000

/** Periodic health probe interval (design 02 §3.5, ms). */
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
 * Create the local connection adapter.
 * @param options - {stateDir, dshHome, dshWorkspacePath, catalog, logger,
 *   options? {failureThrottleMs?, healthIntervalMs?, healthProbeTimeoutMs?,
 *   healthResultCacheMs?, restartFailureThreshold?, restartBackoffFloorMs?,
 *   restartBackoffCeilMs?, restartWindowMs?, maxRestartsInWindow?},
 *   deps? {spawnDsh?, describeCapabilities?}} — the deps are injectable so
 *   unit tests can mock the wire.
 */
export function createLocalConnection({ stateDir, dshHome, dshWorkspacePath, catalog, logger, options = {}, deps = {} }: {
  stateDir: string
  dshHome: string
  /**
   * Workspace used by the next spawn. Runtime updates switch the active tree
   * without reconstructing the control plane, so the thunk form is resolved
   * for every initial spawn and automatic restart.
   */
  dshWorkspacePath: string | (() => string)
  catalog: CatalogLike
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
  const spawnDshFn = (deps.spawnDsh ?? spawnDsh) as NonNullable<LocalConnectionDeps['spawnDsh']>
  const describeCapabilities = deps.describeCapabilities ?? describeCapabilitiesFn

  function connectionBusy(reason: string): Error & { code: string } {
    const busy = new Error(reason) as Error & { code: string }
    busy.code = 'connection_busy'
    return busy
  }

  function isConnectionBusy(value: unknown): value is Error & { code: string } {
    return value instanceof Error && (value as Error & { code?: string }).code === 'connection_busy'
  }

  /**
   * A failed process-group termination proof is qualitatively different from
   * a port/readiness failure: another start could overlap an unknown writer.
   * Notify the owning plane exactly on that coded path; callback failure is
   * isolated so it cannot replace the lifecycle error being propagated.
   */
  function noteWriterQuiescenceUnknown(value: unknown): value is Error {
    if (!isWriterQuiescenceUnknown(value)) return false
    try {
      options.onWriterQuiescenceUnknown?.(value)
    } catch (callbackError) {
      logger.error(`writer-quiescence latch callback failed: ${String(callbackError)}`)
    }
    return true
  }

  /**
   * Resolve the `--patch` overlay path at spawn time (design 09 module B). The
   * thunk form is resolved lazily behind the spawn fence, so each start and
   * restart sees (and may idempotently repair) the current profile seed.
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
  /** Lifecycle-change subscribers (the health-events push channel, 05 §3). */
  const stateListeners = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()
  let dshPort: number | null = null
  let child: SpawnedDsh | null = null
  let stopping = false
  let startPromise: Promise<ConnectionRow | null> | null = null
  let consecutiveFailures = 0
  let lastFailureAt = 0
  /** The latest session/list probe snapshot (health probe side effect). The
   *  old host.describe capability facts are gone upstream (dsh 0.1.2-alpha.2),
   *  so this surface no longer carries version/capability data. */
  /** Bumped on start()/stop() so stale restart loops abort (see triggerRestart). */
  let epoch = 0
  /** Generation abort for the in-flight health probe: stop()/start() abort it
   *  so a late verdict can never land on a machine that already moved on
   *  (2026 audit H2 — the probe rejects promptly and the failure handlers are
   *  additionally state-guarded). */
  let healthGeneration = new AbortController()
  /** Periodic health probe timer (unref'd); cleared on stop/exhaust. */
  let healthTimer: NodeJS.Timeout | null = null
  /** Single-flight guard for the health probe. */
  let healthInFlight: Promise<void> | null = null
  /** Last health verdict within the result cache window ({at, ok, reason}). */
  let healthResultCache: { at: number; ok: boolean; reason?: string } | null = null
  /** Single-flight restart sequence (design 02 §3.5.3). */
  let restartPromise: Promise<void> | null = null
  /** The spawn/readiness attempt currently capable of writing DSH_HOME. */
  let spawnAbortController: AbortController | null = null
  /** Single-flight stop waits for every in-flight start/restart writer. */
  let stopPromise: Promise<void> | null = null
  /** Timestamps of restarts inside the current sliding window. */
  const restartTimes: number[] = []

  /**
   * Validate the lifecycle epoch and the external runtime gate as one fence.
   * stop() bumps epoch before it awaits anything, so a queued start that had
   * already passed the management-entry check cannot later seed or spawn.
   */
  function assertSpawnAllowed(expectedEpoch: number): void {
    if (stopping || epoch !== expectedEpoch) {
      throw connectionBusy('local start was invalidated by stop')
    }
    const gate = options.canSpawn?.()
    if (gate?.ok === false) throw connectionBusy(gate.reason)
  }

  /**
   * Invoke the spawn dependency under an abortable ownership token. stop()
   * aborts this controller and then awaits the owning start/restart promise;
   * it cannot report quiescence while a child is still booting or being
   * reclaimed after a stale epoch.
   */
  async function spawnWithOwnership(options: {
    stateDir: string
    dshHome: string
    dshWorkspacePath: string
    logger: Logger
    patchPath: string | null
  }): Promise<SpawnedDsh> {
    const controller = new AbortController()
    if (spawnAbortController !== null) {
      throw new Error('local connection invariant violated: concurrent spawn ownership')
    }
    spawnAbortController = controller
    try {
      return await spawnDshFn({
        ...options,
        ...(dshPortBase === undefined ? {} : { dshPortBase }),
        signal: controller.signal,
      })
    } finally {
      if (spawnAbortController === controller) spawnAbortController = null
    }
  }

  /** Per-port rolling-log writer (host-logs.ts): lazy, failure-swallowing —
   * a dead log file must never take the connection state machine down.
   * Tracked by the port it was created for: after a respawn on a new port
   * the old writer is closed and recreated. */
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
        hostLogWriter = createHostLogWriter(stateDir, port)
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

  /** Set machine state, persist the connection row, and log. */
  function setState(next: ConnectionState, nextError: string | null = null) {
    const row = catalog.getConnection('local')
    if (row !== null) {
      row.status = next
      row.dshPort = dshPort
      // Explicit delete on null: JSON.stringify drops undefined keys, so
      // keeping `error: undefined` in memory would diverge from the persisted
      // shape (2026 round-3 review).
      if (nextError !== null && nextError !== undefined) row.error = nextError
      else delete row.error
      // Runtime projections (status/dshPort/error) are persisted BEST-EFFORT
      // (design 03 §2.1: runtime facts are projections, never authoritative):
      // a disk failure must never block the in-memory state machine. The
      // failure is loud in the log; the next transition re-attempts the write
      // and self-heals the persisted projection.
      try {
        catalog.upsertConnection(row)
      } catch (persistError) {
        logger.error(`local connection: catalog persist failed (state still advances): ${String(persistError)}`)
      }
    }
    state = next
    error = nextError
    logger.log(`local connection → ${next}${nextError ? `: ${nextError}` : ''}`)
    // Managed-host rolling log (design 02 §3.8): the host itself stays
    // silent on stdio in the web profile, so lifecycle transitions are the
    // observable content of GET /api/host/logs — always written, value-free.
    noteHostLog(`[control-plane] local connection → ${next}${nextError ? `: ${nextError}` : ''}`)
    // Push channel (05 §3): every transition reaches the renderer instantly;
    // the SSE endpoint also snapshots on subscribe, so a missed event is
    // never a missed state. Subscriber throws are isolated — the state
    // machine must never break on a third-party listener.
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
   * Shared failure handler for every health channel (periodic probe, cached
   * verdicts — design 02 §3.5): a dead child skips counting and restarts
   * immediately; live failures count (throttled) into the shared counter and
   * land on degraded; at the threshold a restart is triggered.
   *
   * State-guarded (2026 audit H2): a verdict that lands after stop()/error
   * must be inert — the machine is no longer running and must not be
   * resurrected or re-counted.
   */
  function noteHealthFailure(reason: string) {
    // A probe that was already in flight when the restart began observes the
    // torn-down child; its verdict must not count into the shared window.
    if (restartPromise !== null) return
    // State-guarded (2026 audit H2): a verdict that lands after stop()/error
    // must be inert — the machine is no longer running and must not be
    // resurrected or re-counted.
    if (stopping || state === 'stopped' || state === 'error') return
    if (child === null || child.child.exitCode !== null || child.child.signalCode != null) {
      // signalCode set = the child was signal-killed (exitCode stays null) —
      // the process is equally dead and must go straight to the restart
      // sequence instead of the failure counter (2026 review).
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
    // A probe that was already in flight when the restart began observes the
    // torn-down child; its verdict must not clear state mid-transaction.
    if (restartPromise !== null) return
    consecutiveFailures = 0
    if (state === 'degraded') setState('ready')
  }

  /**
   * One real health probe (or the cached verdict when within
   * healthResultCacheMs — a burst of triggers shares one probe, design 02
   * §3.5.2). Single-flight via runHealthCheck.
   */
  async function performHealthCheck(source: string): Promise<void> {
    if (healthResultCache !== null && Date.now() - healthResultCache.at < healthResultCacheMs) {
      if (healthResultCache.ok) onHealthSuccess()
      else noteHealthFailure(`health probe (${source}): cached ${healthResultCache.reason}`)
      return
    }
    try {
      await describeCapabilities(`http://127.0.0.1:${dshPort}`, {
        force: true,
        timeoutMs: healthProbeTimeoutMs,
        // The current generation's abort: stop()/start() abort in-flight
        // probes so a late verdict cannot outlive the transition (2026 H2).
        generationSignal: healthGeneration.signal,
      })
      healthResultCache = { at: Date.now(), ok: true }
      onHealthSuccess()
    } catch (probeError) {
      const reason = String(probeError)
      healthResultCache = { at: Date.now(), ok: false, reason }
      noteHealthFailure(`health probe (${source}): ${reason}`)
    }
  }

  /**
   * The health check entry point shared by the periodic timer and any
   * transport trigger: single-flight (concurrent triggers share the in-flight
   * promise) and suppressed while stopping, restarting, or outside
   * ready/degraded.
   */
  async function runHealthCheck(source: string): Promise<void> {
    if (stopping || restartPromise !== null) return
    if (state !== 'ready' && state !== 'degraded') return
    if (healthInFlight !== null) return healthInFlight
    healthInFlight = performHealthCheck(source)
    try {
      await healthInFlight
    } catch (healthError) {
      logger.warn(`health check threw: ${String(healthError)}`)
    } finally {
      healthInFlight = null
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
   * The restart sequence (design 02 §3.5.3/§3.5.4), single-flight: terminate
   * the residual child, respawn through deps.spawnDsh, back to ready. Failed
   * restarts loop with exponential backoff (1s → 60s). The restart count
   * inside the sliding window bounds the loop: at maxRestartsInWindow
   * restarts the machine lands on restart-exhausted and stops automatically
   * until a manual start(). The loop aborts when stop() or start() bumps
   * the epoch.
   */
  function triggerRestart(reason: string): Promise<void> {
    if (stopping) return Promise.resolve()
    // A start() in flight owns the spawn: a late failure (health probe,
    // stale child-exit) must never double-spawn alongside it (2026 H2).
    if (startPromise !== null) return Promise.resolve()
    if (state === 'restart-exhausted' || state === 'stopped' || state === 'error') return Promise.resolve()
    if (restartPromise !== null) return restartPromise
    restartPromise = (async () => {
      const restartEpoch = epoch
      for (;;) {
        if (stopping || epoch !== restartEpoch) return
        const now = Date.now()
        while (restartTimes.length > 0 && restartTimes[0] <= now - restartWindowMs) restartTimes.shift()
        if (restartTimes.length >= maxRestartsInWindow) {
          stopHealthTimer()
          // Stop the residual child before landing on restart-exhausted: the
          // docstring promises "stops automatically" — a hung-but-alive dsh
          // must not keep running and occupying its port, and a dead-but-
          // uncleared reference must not keep liveness/dshPort stale (2026
          // round-3 review).
          if (child !== null) {
            try {
              if (child.child.exitCode === null && child.child.signalCode == null) await child.stop()
            } catch (stopError) {
              logger.log(`restart-exhausted: residual child stop failed: ${String(stopError)}`)
            }
            child = null
          }
          const exhaustedPort = dshPort
          dshPort = null
          // The child is gone — the browser-auth cookie must not linger
          // (review-round8c P2; a later manual start re-mints).
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
        setState('restarting', null)
        try {
          if (child !== null && child.child.exitCode === null) await child.stop()
          child = null
          await deps.beforeSpawnCheckpoint?.('restart')
          // First fence: resolvePatchPath() may seed chamber packages into
          // DSH_HOME, so runtime apply/restore must still be open here.
          assertSpawnAllowed(restartEpoch)
          const resolvedWorkspacePath = resolveDshWorkspacePath()
          const resolvedPatchPath = resolvePatchPath()
          // Second fence: a test seam or future async resolver must never let
          // a gate closed after the seed checkpoint reach the actual spawn.
          assertSpawnAllowed(restartEpoch)
          const spawned = await spawnWithOwnership({
            stateDir,
            dshHome,
            dshWorkspacePath: resolvedWorkspacePath,
            logger,
            patchPath: resolvedPatchPath,
          })
          if (stopping || epoch !== restartEpoch) {
            await spawned.stop()
            return
          }
          child = spawned
          dshPort = spawned.port
          consecutiveFailures = 0
          healthResultCache = null
          spawned.child.on('exit', onChildExit)
          setState('ready')
          startHealthTimer()
          return
        } catch (restartError) {
          child = null
          dshPort = null
          logger.log(`restart failed: ${String(restartError)}`)
          if (noteWriterQuiescenceUnknown(restartError)) {
            stopHealthTimer()
            setState('error', restartError.message)
            return
          }
          if (stopping || epoch !== restartEpoch) return
          if (isConnectionBusy(restartError)) {
            stopHealthTimer()
            setState('stopped', restartError.message)
            return
          }
        }
      }
    })().finally(() => {
      restartPromise = null
    }).catch((error: unknown) => {
      // The only escape path is a synchronous setState/catalog write failure.
      // Never let it reach an unhandled rejection — the desktop treats those
      // as fatal (app.exit(1)); project the honest error state instead.
      try { setState('error', error instanceof Error ? error.message : String(error)) } catch { /* nothing left to write */ }
    })
    return restartPromise
  }

  /**
   * The child exit listener: a dead dsh must not stay ready. Process death
   * skips the failure counter and goes straight into the restart sequence
   * (design 02 §3.5.2 进程死亡分支); during an in-flight restart the sequence
   * itself is driving the teardown, so nothing else is scheduled. A start()
   * in flight also suppresses the pseudo-restart: startImpl tears down the
   * previous child (`await child.stop()`) while `startPromise` is set, and
   * that exit event must not schedule a second spawn alongside the one
   * startImpl is about to perform — it would race the start's spawn and leak
   * a detached dsh process (2026-08 review).
   */
  function onChildExit(code: number | null, sig: string | null): void {
    logger.log(`dsh process exited (${code ?? sig})`)
    if (stopping) return
    if (restartPromise !== null) return
    if (startPromise !== null) return
    if (state === 'ready' || state === 'starting' || state === 'degraded') {
      void triggerRestart(`dsh process exited (${code ?? sig})`)
    }
  }

  /**
   * The start implementation. Single-flight via startPromise; a spawn
   * failure is terminal for this attempt: the machine lands on 'error'
   * (fail-loud) and start() rejects — the caller surfaces the honest error.
   */
  async function startImpl(): Promise<ConnectionRow | null> {
    // A start racing an authoritative stop must fail loudly. Returning the
    // cancelled generation's single-flight promise would resolve with a row
    // while the connection actually lands on `stopped`.
    if (stopping) throw connectionBusy('local connection is stopping')
    if (startPromise !== null) return startPromise
    const ownedStart = (async () => {
      if (state === 'ready') return catalog.getConnection('local')
      epoch += 1
      // Abort any in-flight health probe from the previous generation: its
      // verdict must not land on this new lifecycle (2026 H2).
      healthGeneration.abort()
      healthGeneration = new AbortController()
      // Capture the epoch, not just the mutable `stopping` flag. stop() bumps
      // it before aborting/awaiting this owner, so the start cannot seed after
      // a queued stop or adopt a child returned by a stale readiness attempt.
      // The epoch guard (same as triggerRestart) survives stop() resetting
      // `stopping` in its finally: a late-resolving spawn is torn down
      // instead of adopted. (2026-08 review)
      const startEpoch = epoch
      if (restartPromise !== null) await restartPromise
      if (stopping || epoch !== startEpoch) {
        throw connectionBusy('local start was invalidated by stop')
      }
      if (child !== null && child.child.exitCode === null) {
        await child.stop()
      }
      child = null
      stopHealthTimer()
      consecutiveFailures = 0
      lastFailureAt = 0
      restartTimes.length = 0
      healthResultCache = null
      // A fresh start has no port yet — the old (dead) one must not ride the
      // 'starting' projection (2026 review).
      dshPort = null
      setState('starting')
      let spawnAttempted = false
      try {
        await deps.beforeSpawnCheckpoint?.('start')
        // First fence: patch resolution is the first pre-spawn operation
        // allowed to write DSH_HOME (default/profile seeds).
        assertSpawnAllowed(startEpoch)
        const resolvedWorkspacePath = resolveDshWorkspacePath()
        const resolvedPatchPath = resolvePatchPath()
        // Second fence: re-read both epoch and runtime gate at the actual
        // spawn boundary, not only at the management/API entry.
        assertSpawnAllowed(startEpoch)
        spawnAttempted = true
        const spawned = await spawnWithOwnership({
          stateDir,
          dshHome,
          dshWorkspacePath: resolvedWorkspacePath,
          logger,
          patchPath: resolvedPatchPath,
        })
        if (stopping || epoch !== startEpoch) {
          await spawned.stop()
          return catalog.getConnection('local')
        }
        child = spawned
        dshPort = spawned.port
        spawned.child.on('exit', onChildExit)
        setState('ready')
        startHealthTimer()
        return catalog.getConnection('local')
      } catch (spawnError) {
        if (noteWriterQuiescenceUnknown(spawnError)) {
          setState('error', spawnError.message)
          throw spawnError
        }
        if (stopping || epoch !== startEpoch) {
          // Once spawn ownership was entered, stop() awaits this promise as a
          // writer barrier. An abort-aware or late-failing adapter belongs to
          // the cancelled generation, so resolve with the current row after
          // its cleanup instead of leaking an expected rejection to callers.
          // A pre-spawn fence closure is different: no writer was acquired,
          // and the management caller must receive connection_busy rather
          // than a false successful start acknowledgement.
          if (spawnAttempted) return catalog.getConnection('local')
          if (isConnectionBusy(spawnError)) throw spawnError
          throw connectionBusy('local start was invalidated by stop')
        }
        child = null
        dshPort = null
        if (isConnectionBusy(spawnError)) {
          // An expected fence closure is a stopped lifecycle, not a broken
          // runtime. Preserve a concurrent stop() transition when it won.
          if (state !== 'stopped') setState('stopped', spawnError.message)
          throw spawnError
        }
        setState('error', String(spawnError))
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
    /**
     * Current machine state: 'stopped' | 'starting' | 'ready' | 'degraded' |
     * 'restarting' | 'restart-exhausted' | 'error'.
     */
    getState(): ConnectionState {
      return state
    },

    /** The dsh port this connection serves; null while stopped. */
    getDshPort(): number | null {
      return dshPort
    },

    /**
     * Whether a real dsh process is currently alive under this connection.
     * The machine state alone is NOT a liveness fact: during a restart
     * sequence the state is 'restarting' while the new process has not been
     * spawned yet (backoff 1s→60s), and a dead child can linger on
     * 'ready'/'degraded' until the next health probe notices. Quit-risk and
     * similar "something would be interrupted" decisions must key on this,
     * not on the state string.
     */
    hasLiveProcess(): boolean {
      // exitCode===null alone is NOT enough: a signal-killed child reports
      // exitCode===null with signalCode set (2026 round-3 review). Alive
      // means neither exit code nor signal has been observed.
      return child !== null && child.child.exitCode === null && child.child.signalCode == null
    },

    /** Current error detail; null when healthy. */
    getError(): string | null {
      return error
    },

    /** Consecutive connection failures (probe failures/child exit), reset on connect. */
    getConsecutiveFailures(): number {
      return consecutiveFailures
    },

    /**
     * The latest session/list probe snapshot from the health probe; null
     * before the first success. NOTE (dsh 0.1.2-alpha.1 migration, D2): the
     * host.describe capability endpoint was deleted upstream and the probe is
     * now session/list, so this value is a session list — no host
     * version/cwd/capability facts are available from this surface anymore
     * (the version-chip fact source moved to the runtime version, design 18).
     */
    /**
     * Start (or restart) the connection: terminate a stale child, spawn a
     * fresh dsh web profile, and land on ready. Idempotent while already
     * starting; a ready connection is left untouched. Any in-flight restart
     * sequence is aborted via the epoch bump, and the restart window/counter
     * state is reset.
     * @returns the connection row.
     */
    start: startImpl,

    /**
     * Stop the connection: terminate the child (process-group SIGTERM → 1s →
     * SIGKILL), stop the health probe, and land on 'stopped'. Any in-flight
     * start/restart is invalidated, aborted, and awaited; resolving stop()
     * therefore proves that no managed local writer remains in flight.
     */
    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise
      if (state === 'stopped' && child === null && startPromise === null && restartPromise === null) {
        return Promise.resolve()
      }
      stopping = true
      epoch += 1
      // Abort the in-flight health probe and WAIT for its (promptly
      // rejecting) verdict: a late failure must never land after stop()
      // returned and resurrect the connection (2026 H2). runHealthCheck
      // never rejects, so the await is safe.
      healthGeneration.abort()
      healthGeneration = new AbortController()
      // Capture the owners after bumping the epoch. Neither promise can
      // publish/adopt a spawned child for this lifecycle now.
      const pendingStart = startPromise
      const pendingRestart = restartPromise
      spawnAbortController?.abort()
      const work = (async () => {
        try {
          stopHealthTimer()
          if (healthInFlight !== null) {
            try {
              await healthInFlight
            } catch { /* defensive — runHealthCheck swallows */ }
          }
          // start/restart own cleanup for any process launched before the
          // abort. Await both owners without a timeout: stopLocal is the
          // runtime writer barrier and must not claim quiescence early.
          const ownerResults = await Promise.allSettled([
            ...(pendingStart === null ? [] : [pendingStart]),
            ...(pendingRestart === null ? [] : [pendingRestart]),
          ])
          const unknownOwner = ownerResults.find((result): result is PromiseRejectedResult =>
            result.status === 'rejected' && isWriterQuiescenceUnknown(result.reason))
          if (unknownOwner !== undefined) {
            throw unknownOwner.reason
          }
          // Defensive second look: a promise might have adopted immediately
          // before this stop bumped epoch but after the first child snapshot.
          if (child !== null && child.child.exitCode === null) {
            await child.stop()
          }
          const stoppedPort = dshPort
          child = null
          dshPort = null
          restartTimes.length = 0
          // A failed verdict cached right before stop must not replay after a
          // later start and re-count a failure the new lifecycle never had.
          healthResultCache = null
          // The browser-auth cookie is process-memory only; drop it with the
          // instance (a later start re-mints from the fresh launch token).
          if (stoppedPort !== null) clearAuthCookie(`http://127.0.0.1:${stoppedPort}`)
          // setState writes the final line through the existing per-port
          // writer even though dshPort is now null; close it immediately after.
          setState('stopped', null)
          if (hostLogWriter !== null) {
            await hostLogWriter.close()
            hostLogWriter = null
          }
          hostLogWriterPort = null
        } catch (stopError) {
          if (noteWriterQuiescenceUnknown(stopError)) {
            setState('error', stopError.message)
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
     * Transactional user-triggered dsh restart (design 18 §9.3), serialized
     * on the same single-flight as the health state machine's automatic
     * restart. The entry checks are the only difference from the automatic
     * path: they reject with a coded connection_busy error (instead of
     * silently resolving) when a stop is in progress, when a start is still
     * in flight (a concurrent restart would race the start's spawn ownership
     * and pollute the shared backoff window with pseudo-failures), when the
     * runtime gate is closed (canStartLocal — applying/restore), when the
     * instance was never started, or from restart-exhausted (recovery stays
     * on start()). Otherwise it delegates to triggerRestart — merging into an
     * in-flight restart when one exists, or running the same stop→respawn→
     * ready transaction with the shared bounded backoff and
     * restart-exhausted window.
     *
     * CONTRACT (design 18 §9.3): resolving does NOT promise success. A
     * restart that exhausts the shared window settles into
     * 'restart-exhausted' and resolves — callers must read connectionState
     * (or subscribe to onStateChange) to report an honest outcome.
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
