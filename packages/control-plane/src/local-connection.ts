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
 * - readiness = the spawn's TCP + host.describe handshake (spawn-dsh owns it);
 * - health monitoring (design 02 §3.5): a periodic host.describe probe (10s
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

import { spawnDsh } from './spawn-dsh.ts'
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
  }) => Promise<SpawnedDsh>
  describeCapabilities?: DescribeCapabilitiesFn
}

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
  /**
   * Optional host-graph patch overlay passed to every spawn as `--patch`
   * (design 09 module B). A function is resolved at spawn time: the seed runs
   * in the plane's start(), after the connection is constructed, so a thunk
   * lets every spawn — initial and restarts — read the then-current path.
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
  getHostDescribe(): any
  /**
   * Whether a real dsh process is currently alive under this connection
   * (state-string independent — the liveness fact for quit-risk decisions).
   */
  hasLiveProcess(): boolean
  start(): Promise<ConnectionRow | null>
  stop(): Promise<void>
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
export const HEALTH_INTERVAL_MS = 10_000

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
  dshWorkspacePath: string
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
  const spawnDshFn = (deps.spawnDsh ?? spawnDsh) as NonNullable<LocalConnectionDeps['spawnDsh']>
  const describeCapabilities = deps.describeCapabilities ?? describeCapabilitiesFn

  /**
   * Resolve the `--patch` overlay path at spawn time (design 09 module B). The
   * thunk form is resolved lazily so the plane's start() seed — which lands
   * after this connection is constructed — is visible to every spawn.
   */
  function resolvePatchPath(): string | null {
    const value = options.patchPath
    return typeof value === 'function' ? value() : value ?? null
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
  /** The latest host.describe snapshot (health probe side effect). */
  let lastDescribe: { value: any; cachedAt?: number } | null = null
  /** Bumped on start()/stop() so stale restart loops abort (see triggerRestart). */
  let epoch = 0
  /** Periodic health probe timer (unref'd); cleared on stop/exhaust. */
  let healthTimer: NodeJS.Timeout | null = null
  /** Single-flight guard for the health probe. */
  let healthInFlight: Promise<void> | null = null
  /** Last health verdict within the result cache window ({at, ok, reason}). */
  let healthResultCache: { at: number; ok: boolean; reason?: string } | null = null
  /** Single-flight restart sequence (design 02 §3.5.3). */
  let restartPromise: Promise<void> | null = null
  /** Timestamps of restarts inside the current sliding window. */
  const restartTimes: number[] = []

  /** Per-port rolling-log writer (host-logs.ts): lazy, failure-swallowing —
   * a dead log file must never take the connection state machine down.
   * Tracked by the port it was created for: after a respawn on a new port
   * the old writer is closed and recreated. */
  let hostLogWriter: { write(line: string, kind?: string): void; close(): void } | null = null
  let hostLogWriterPort: number | null = null
  function noteHostLog(line: string) {
    if (typeof line !== 'string' || line === '') return
    if (dshPort !== null && dshPort > 0 && (hostLogWriter === null || hostLogWriterPort !== dshPort)) {
      if (hostLogWriter !== null) {
        try {
          hostLogWriter.close()
        } catch {
          /* swallow — see note above */
        }
        hostLogWriter = null
      }
      try {
        hostLogWriter = createHostLogWriter(stateDir, dshPort)
        hostLogWriterPort = dshPort
      } catch {
        hostLogWriter = { write() {}, close() {} }
        hostLogWriterPort = dshPort
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
      row.error = nextError ?? undefined
      // Catalog is synchronous write-through: publish the live machine state
      // only after its row commit succeeds. A disk failure therefore leaves
      // both authorities on the previous transition and propagates loudly.
      catalog.upsertConnection(row)
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
   */
  function noteHealthFailure(reason: string) {
    if (child === null || child.child.exitCode !== null) {
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
      const described = await describeCapabilities(`http://127.0.0.1:${dshPort}`, {
        force: true,
        timeoutMs: healthProbeTimeoutMs,
      })
      const value = described?.value
      if (value !== undefined) lastDescribe = { value, cachedAt: described.cachedAt }
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
    if (state === 'restart-exhausted') return Promise.resolve()
    if (restartPromise !== null) return restartPromise
    restartPromise = (async () => {
      const restartEpoch = epoch
      for (;;) {
        if (stopping || epoch !== restartEpoch) return
        const now = Date.now()
        while (restartTimes.length > 0 && restartTimes[0] <= now - restartWindowMs) restartTimes.shift()
        if (restartTimes.length >= maxRestartsInWindow) {
          stopHealthTimer()
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
          const spawned = await spawnDshFn({ stateDir, dshHome, dshWorkspacePath, logger, patchPath: resolvePatchPath() })
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
          if (stopping || epoch !== restartEpoch) return
        }
      }
    })().finally(() => {
      restartPromise = null
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
    if (startPromise !== null) return startPromise
    startPromise = (async () => {
      if (stopping) throw new Error('connection is stopping')
      if (state === 'ready') return catalog.getConnection('local')
      epoch += 1
      // The epoch captured at entry, not the mutable `stopping` flag: stop()
      // resets `stopping` in its finally WITHOUT waiting for this in-flight
      // spawn (it never awaits startPromise), so a post-spawn check on
      // `stopping` alone would let the spawn land AFTER stop() returned and
      // resurrect the connection — leaving a detached dsh orphan on quit.
      // The epoch guard (same as triggerRestart) survives that: stop()
      // bumped the epoch, so a late-resolving spawn is torn down instead of
      // adopted. (2026-08 review)
      const startEpoch = epoch
      if (restartPromise !== null) await restartPromise
      if (child !== null && child.child.exitCode === null) {
        await child.stop()
      }
      child = null
      stopHealthTimer()
      consecutiveFailures = 0
      lastFailureAt = 0
      restartTimes.length = 0
      healthResultCache = null
      setState('starting')
      try {
        const spawned = await spawnDshFn({ stateDir, dshHome, dshWorkspacePath, logger, patchPath: resolvePatchPath() })
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
        child = null
        dshPort = null
        setState('error', String(spawnError))
        throw spawnError
      }
    })()
    try {
      return await startPromise
    } finally {
      startPromise = null
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
      return child !== null && child.child.exitCode === null
    },

    /** Current error detail; null when healthy. */
    getError(): string | null {
      return error
    },

    /** Consecutive connection failures (probe failures/child exit), reset on connect. */
    getConsecutiveFailures(): number {
      return consecutiveFailures
    },

    /** The latest host.describe snapshot from the health probe; null before the first success. */
    getHostDescribe(): any {
      return lastDescribe?.value ?? null
    },

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
     * restart loop is aborted via the epoch bump.
     */
    async stop(): Promise<void> {
      stopping = true
      epoch += 1
      try {
        stopHealthTimer()
        if (child !== null && child.child.exitCode === null) {
          await child.stop()
        }
        child = null
        dshPort = null
        restartTimes.length = 0
        // A failed verdict cached right before stop must not replay after a
        // later start and re-count a failure the new lifecycle never had.
        healthResultCache = null
        lastDescribe = null
        setState('stopped', null)
        if (hostLogWriter !== null) {
          hostLogWriter.close()
          hostLogWriter = null
        }
        hostLogWriterPort = null
      } finally {
        stopping = false
      }
    },

    /** Subscribe to lifecycle transitions (see the interface docblock). */
    onStateChange(listener: (snapshot: { status: string; port: number | null; error: string | null }) => void): () => void {
      stateListeners.add(listener)
      return () => { stateListeners.delete(listener) }
    },
  }
}
