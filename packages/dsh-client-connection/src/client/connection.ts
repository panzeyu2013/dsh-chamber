/** Connection generation readiness, cancellation, and continuous recovery. */
import { resolveConnectionConfig, type ConnectionRecoveryConfig } from '../recovery-config.ts'

export type { ConnectionRecoveryConfig } from '../recovery-config.ts'

/*
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6 / design 14 D4)
 *
 * Upstream moved the whole ConnectionConfig/backoff block into
 * `recovery-config.ts` (v0.1.3-alpha.2). The chamber deltas below are
 * re-applied on the upstream copy:
 *
 * - `basePath` (the former per-instance controller-config member) now lives
 *   only in the chamber apply config of `src/client/index.ts` — the
 *   controller never read it, so nothing controller-side is lost.
 * - `CONNECTION_BACKOFF_MAX_MS` stays exported: `liveness-triggers.ts`
 *   re-exports it as `DEFAULT_MIN_RESTART_INTERVAL_MS` and tests pin
 *   10_000 == the recovery-config schema default (backoffMaxMs).
 * - loopEpoch guards #1/#3 + the while condition + the stop() bump (design
 *   14 D4) are kept; guard #2 (the final-backoff-tier wait block) is dropped
 *   because upstream `isRetryInterrupted` + the `isRunning()` rechecks now
 *   supersede it.
 * - the readiness handshake gained upstream semantics: a 3 s warn
 *   (`generationReadyWarnMs`) then a 15 s hard deadline
 *   (`generationReadyTimeoutMs`) that aborts the generation.
 *
 * Rebased for upstream v0.1.2-alpha.2: the recovery policy is now
 * network-aware — `reconnect()` (immediate manual retry) and
 * `setNetworkAvailable()` (offline suspension / online restart, three-state
 * ConnectionState 'connected' | 'disconnected' | 'connecting') landed
 * upstream; the chamber tunables/guards below are re-applied on the new
 * class unchanged.
 *
 * Rebased for upstream v0.1.2-alpha.3 (tolerate stalled hosts): the
 * readiness-handshake timeout no longer cancels the generation — a slow
 * Host only logs a warning and the handshake keeps waiting (source
 * settlement / controller cancellation remain the abort paths); the chamber
 * loopEpoch guard below is unaffected. v0.1.2-alpha.4 baseline: upstream
 * changed only fixture.ts (SessionSeq branding) — no connection.ts changes.
 *
 * v0.1.2-alpha.5 baseline: upstream changed only package.json (version) —
 * no connection.ts changes.
 *
 * v0.1.2-rc.1 baseline: upstream changed only package.json (version) —
 * no connection.ts changes.
 *
 * v0.1.3-alpha.1 baseline: upstream added host-side streaming-body fetch
 * routes (http-bridge/rpc/rpc-host/index replayed as pure upstream copies)
 * and reworked fixture.ts (session format v2 + live assistant-stream frames,
 * chunk-rows dropped); src/client/index.ts upstream delta was doc-only and
 * is not re-synced (chamber prose kept). No connection.ts changes.
 *
 * v0.1.3-alpha.2 baseline: recovery-config extraction above.
 */

/** Stable Host facts delivered by one established Remote event generation. */
export interface ConnectionHostInfo {
  /** Host account home used only to abbreviate displayed filesystem paths. */
  readonly home: string
}

/** One successfully established Host generation. */
export interface ConnectionGeneration {
  /** Monotone generation number within this Client runtime. */
  readonly id: number
  /** Host facts carried by this generation's opening frame. */
  readonly host: ConnectionHostInfo
}

/** Upper bound for the reconnect backoff cap in ms (chamber export: the
 *  liveness trigger debounce aligns to it — see liveness-triggers.ts, which
 *  re-exports this as DEFAULT_MIN_RESTART_INTERVAL_MS). The value matches the
 *  recovery-config schema default (backoffMaxMs = 10_000); the recovery
 *  defaults themselves live upstream in recovery-config.ts. */
export const CONNECTION_BACKOFF_MAX_MS = 10_000

const MANUAL_RECONNECT = new Error('connection: manual reconnect requested')
const NETWORK_STATE_CHANGED = new Error('connection: browser network state changed')

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

/** Connection lifecycle state published after the first attempt has an outcome. */
export type ConnectionState =
  | 'connected'
  | 'disconnected'
  | 'connecting'

/** Connection-generation callbacks owned by API Gateway. */
export interface ConnectionSinks {
  /** After the generation source reports ready, first connect included. */
  onConnected?: (host: ConnectionHostInfo) => void
  /** State transitions after the initial attempt has an outcome. Equivalent states are deduplicated. */
  onStateChange?: (state: ConnectionState) => void
  /** Start one fresh physical-carrier attempt before each logical retry. */
  onReconnectRequested?: () => void
}

/**
 * One long-lived source defining a Connection generation. The source must
 * attach its incremental listeners before calling `ready`, then remain pending
 * until the generation is lost or `signal` aborts. On abort it must stop
 * delivery, release its resources, and settle before a replacement can start.
 * @param signal - cancellation for the current generation.
 * @param ready - one-shot report that incremental delivery is attached.
 * @returns a promise settling only when this generation ends or fails.
 */
export type ConnectionGenerationSource = (
  signal: AbortSignal,
  ready: (host: ConnectionHostInfo) => void,
) => Promise<void>

/**
 * Opens the registered generation source, reconnecting with exponential backoff on loss.
 * State (generation/attempt) is instance-private, never in the store.
 * Sink exceptions do not kill the generation loop.
 */
export class ConnectionController {
  private generation = 0
  private attempt = 0
  private current: AbortController | null = null
  private retryDelay: AbortController | null = null
  private running = false
  private immediateRetry = false
  private networkAvailable = true
  private lastState: ConnectionState | undefined
  private readonly config: Required<ConnectionRecoveryConfig>
  // chamber patch (design 14 D4): loop epoch. stop() bumps it so an in-flight
  // loop invocation from a PREVIOUS start() can never survive a synchronous
  // stop()+start() restart: the official `isRunning()` check alone is racy —
  // start() re-sets `running` before the old loop reaches its post-`failed`
  // check, which would spawn a second concurrent pump loop (double streams,
  // duplicated onConnected resync, leaked generations).
  private loopEpoch = 0
  private readonly source: ConnectionGenerationSource
  private readonly sinks: ConnectionSinks

  constructor(
    source: ConnectionGenerationSource,
    sinks: ConnectionSinks = {},
    config: ConnectionRecoveryConfig = {},
  ) {
    // chamber patch (erasableSyntaxOnly): upstream parameter properties are
    // explicit field assignments here so the copy typechecks under the
    // chamber's erasable-only config.
    this.source = source
    this.sinks = sinks
    this.config = resolveConnectionConfig(config)
  }

  /** Idempotent: begin the connect/pump/reconnect loop. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  /** Stop the loop and abort the current generation source. */
  stop(): void {
    this.running = false
    // chamber patch (design 14 D4): invalidate any in-flight loop invocation
    // (see loopEpoch) so a later start() can never be overtaken by it.
    this.loopEpoch += 1
    this.current?.abort()
    this.current = null
    this.retryDelay?.abort()
    this.retryDelay = null
  }

  /** Reset the retry sequence and replace the current generation or retry delay immediately. */
  reconnect(): void {
    if (!this.running) return
    this.attempt = 0
    this.immediateRetry = true
    this.emitState('connecting')
    if (!this.isRunning()) return
    this.current?.abort(MANUAL_RECONNECT)
    this.retryDelay?.abort(MANUAL_RECONNECT)
  }

  /**
   * Suspend automatic retries while offline and restart backoff when the network returns.
   * @param available - whether the browser reports network access.
   */
  setNetworkAvailable(available: boolean): void {
    if (this.networkAvailable === available) return
    this.networkAvailable = available
    this.attempt = 0
    this.immediateRetry = false
    if (!this.running) return
    this.emitState(available ? 'connecting' : 'disconnected')
    if (!this.isRunning()) return
    this.current?.abort(NETWORK_STATE_CHANGED)
    this.retryDelay?.abort(NETWORK_STATE_CHANGED)
  }

  private backoffCap(attempt: number): number {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config
    return Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1))
  }

  private backoffDelay(attempt: number): number {
    const cap = this.backoffCap(attempt)
    return cap / 2 + Math.random() * (cap / 2)
  }

  /** Re-read retry inputs after a potentially reentrant state sink. */
  private isRetryInterrupted(immediate: boolean): boolean {
    return this.immediateRetry || (!this.networkAvailable && !immediate)
  }

  /** Read through a method: stop() flips the flag across awaits, so narrowing from the loop condition must not stick. */
  private isRunning(): boolean {
    return this.running
  }

  /** Re-read both mutable liveness guards after a potentially reentrant sink. */
  private isGenerationActive(controller: AbortController): boolean {
    return this.isRunning() && !controller.signal.aborted
  }

  private async loop(): Promise<void> {
    // chamber patch (design 14 D4): this loop invocation is tied to the epoch
    // captured at entry — a stop() (which bumps loopEpoch) retires it even if
    // a subsequent start() re-set `running`.
    const epoch = this.loopEpoch
    let retry = false
    while (this.running && epoch === this.loopEpoch) {
      if (!this.networkAvailable && !this.immediateRetry) {
        const retryDelay = new AbortController()
        this.retryDelay = retryDelay
        this.emitState('disconnected')
        await waitForAbort(retryDelay.signal)
        if (this.retryDelay === retryDelay) this.retryDelay = null
        if (!this.isRunning() || epoch !== this.loopEpoch) return
        retry = true
        continue
      }

      let manualAttempt = false
      if (retry) {
        const immediate = this.immediateRetry
        this.immediateRetry = false
        if (immediate) this.attempt = 0
        manualAttempt = immediate
        const attempt = ++this.attempt
        this.emitState('connecting')
        if (!this.isRunning() || epoch !== this.loopEpoch) return
        if (this.isRetryInterrupted(immediate)) continue
        if (!immediate) {
          const retryDelay = new AbortController()
          this.retryDelay = retryDelay
          await sleep(this.backoffDelay(attempt), retryDelay.signal)
          if (this.retryDelay === retryDelay) this.retryDelay = null
          if (!this.isRunning() || epoch !== this.loopEpoch) return
          if (retryDelay.signal.aborted) continue
        }
        console.warn(`[connection] connection lost, retry #${String(attempt)}`)
        this.callSink(() => { this.sinks.onReconnectRequested?.() })
        if (!this.isRunning() || epoch !== this.loopEpoch) return
      }

      const gen = ++this.generation
      const ac = new AbortController()
      this.current = ac

      let sourceReady = false
      let resolveReady!: (host: ConnectionHostInfo) => void
      let rejectReady!: (error: Error) => void
      let rejectSourceLost!: (error: Error) => void
      const ready = new Promise<ConnectionHostInfo>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const sourceLost = new Promise<never>((_resolve, reject) => {
        rejectSourceLost = reject
      })
      const reportReady = (host: ConnectionHostInfo): void => {
        if (sourceReady || gen !== this.generation || !this.isGenerationActive(ac)) return
        sourceReady = true
        resolveReady(host)
      }

      const failed = new Promise<void>((resolve) => {
        const settle = (): void => {
          if (gen === this.generation && !ac.signal.aborted) ac.abort()
          resolve()
        }
        void Promise.resolve()
          .then(() => this.source(ac.signal, reportReady))
          .then(
            () => {
              const error = new Error('connection generation ended')
              if (!sourceReady) rejectReady(error)
              rejectSourceLost(error)
              settle()
            },
            (error: unknown) => {
              const failure = error instanceof Error
                ? error
                : new Error('connection generation failed', { cause: error })
              if (!sourceReady) rejectReady(failure)
              rejectSourceLost(failure)
              settle()
            },
          )
      })

      try {
        const host = await Promise.race([
          waitForReady(ready, this.config, ac.signal),
          sourceLost,
        ])
        if (ac.signal.aborted) throw new Error('generation aborted during readiness handshake')
        this.attempt = 0
        this.emitState('connected')
        // A state sink may synchronously stop this controller.
        if (this.isGenerationActive(ac)) {
          this.callSink(() => { this.sinks.onConnected?.(host) })
        }
      } catch (error) {
        if (!ac.signal.aborted) ac.abort(error)
      }

      await failed
      // chamber patch (design 14 D4): epoch guard — a stop()+start() restart
      // retires this loop here instead of falling through into a second pump.
      if (!this.isRunning() || epoch !== this.loopEpoch) return
      if (manualAttempt) this.attempt = 0
      retry = true
    }
  }

  /** Deduplicated state emission (sink isolation applies). */
  private emitState(state: ConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.callSink(() => this.sinks.onStateChange?.(state))
  }

  /** Sink exception isolation: a business-layer throw is logged only, never affecting pump or reconnect semantics. */
  private callSink(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[connection] connection sink threw:', error)
    }
  }
}

/** Report a slow handshake before the hard deadline ends its generation. */
function waitForReady<T>(
  ready: Promise<T>,
  config: Required<ConnectionRecoveryConfig>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const warning = setTimeout(() => {
      console.warn(`[connection] generation is still not ready after ${String(config.generationReadyWarnMs)}ms`)
    }, config.generationReadyWarnMs)
    const timeout = setTimeout(() => {
      const error = new Error(`connection generation was not ready within ${String(config.generationReadyTimeoutMs)}ms`)
      console.warn(`[connection] ${error.message}; cancelling generation`)
      finish({ error })
    }, config.generationReadyTimeoutMs)
    const aborted = (): void => {
      finish({ error: new Error('connection generation aborted', { cause: signal.reason }) })
    }
    const finish = (outcome: { readonly value: T } | { readonly error: Error }): void => {
      if (settled) return
      settled = true
      clearTimeout(warning)
      clearTimeout(timeout)
      signal.removeEventListener('abort', aborted)
      if ('error' in outcome) reject(outcome.error)
      else resolve(outcome.value)
    }
    signal.addEventListener('abort', aborted, { once: true })
    void ready.then(
      (value) => { finish({ value }) },
      (error: unknown) => {
        finish({ error: error as Error })
      },
    )
  })
}
