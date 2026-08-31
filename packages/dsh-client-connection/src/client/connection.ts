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

/**
 * Reconnect/backoff tunables (deployment-varying — no hardcoded tunables; these become the
 *  future `ctx.connection` plugin's Config). All fields optional; defaults below.
 *
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
 *
 * `basePath` is the added per-instance parameter: the browser plugin apply
 * resolves the api-carrier base path from it (falling back to the legacy
 * `window.__DSH_BASE_PATH__` deployment knob when an embedder omits it).
 * Chamber supplies it explicitly per entry. `/api` is the stock value (no prefix injection — paths are
 * byte-identical to upstream); `/api/i/<id>` routes every RPC/WS path through
 * the control-plane per-instance proxy. Defaults preserve existing behaviour.
 *
 * Rebased for upstream v0.1.2-alpha.1: `streamOpenTimeoutMs` became
 * `generationReadyTimeoutMs` (the readiness handshake now waits on the
 * registered generation source's ready signal instead of two WebSocket
 * downlinks); the chamber tunables/guards below are re-applied on the new
 * class.
 */
export interface ConnectionConfig {
  /** First-retry backoff cap in ms (jittered: actual delay is cap/2..cap). */
  backoffBaseMs?: number
  /** Exponential growth factor per consecutive failed attempt. */
  backoffFactor?: number
  /** Upper bound for the backoff cap in ms. */
  backoffMaxMs?: number
  /** Maximum wait for the registered generation source's ready signal. */
  generationReadyTimeoutMs?: number
  /** chamber patch: per-instance api base path (`/api` stock; `/api/i/<id>` per instance). */
  basePath?: string
}

/** Upper bound for the reconnect backoff cap in ms (exported: the liveness
 *  trigger debounce aligns to it — see liveness-triggers.ts). */
export const CONNECTION_BACKOFF_MAX_MS = 10_000

const CONNECTION_DEFAULTS: Required<ConnectionConfig> = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: CONNECTION_BACKOFF_MAX_MS,
  generationReadyTimeoutMs: 3_000,
  basePath: '',
}

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

/** Coarse connection state for the UI: 'connected' after each generation's handshake,
 *  'reconnecting' the moment the generation fails (covers the whole backoff+retry span). */
export type ConnectionState = 'connected' | 'reconnecting'

/** Connection-generation callbacks owned by API Gateway. */
export interface ConnectionSinks {
  /** After the generation source reports ready, first connect included. */
  onConnected?: (host: ConnectionHostInfo) => void
  /** Coarse state transitions (deduplicated: fires only on change). The initial pre-connect
   *  span reports nothing — the UI treats "no state yet" as connecting, not as an outage. */
  onStateChange?: (state: ConnectionState) => void
}

/**
 * One long-lived source defining a Connection generation. The source must
 * attach its incremental listeners before calling `ready`, then remain pending
 * until the generation is lost or `signal` aborts.
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
  private running = false
  private lastState: ConnectionState | null = null
  private readonly config: Required<ConnectionConfig>
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
    config: ConnectionConfig = {},
  ) {
    // chamber patch (erasableSyntaxOnly): upstream parameter properties are
    // explicit field assignments here so the copy typechecks under the
    // chamber's erasable-only config.
    this.source = source
    this.sinks = sinks
    this.config = { ...CONNECTION_DEFAULTS, ...config }
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
  }

  private backoffDelay(attempt: number): number {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config
    const cap = Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1))
    return cap / 2 + Math.random() * (cap / 2)
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
    while (this.running && epoch === this.loopEpoch) {
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
        if (sourceReady) return
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
          waitForReady(ready, this.config.generationReadyTimeoutMs, ac.signal),
          sourceLost,
        ])
        if (ac.signal.aborted) throw new Error('generation aborted during readiness handshake')
        this.attempt = 0
        this.emitState('connected')
        // A state sink may synchronously stop this controller.
        if (this.isGenerationActive(ac)) {
          this.callSink(() => { this.sinks.onConnected?.(host) })
        }
      } catch {
        // Transport failure: treat as generation failure, fall through to the shared backoff.
        if (!ac.signal.aborted) ac.abort()
      }

      await failed
      // chamber patch (design 14 D4): epoch guard — a stop()+start() restart
      // retires this loop here instead of falling through into a second pump.
      if (!this.isRunning() || epoch !== this.loopEpoch) return
      this.emitState('reconnecting')
      this.attempt += 1
      console.warn(`[connection] connection lost, retry #${this.attempt}`)
      const idle = new AbortController()
      await sleep(this.backoffDelay(this.attempt), idle.signal)
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

/** Await source readiness without letting a stalled carrier wedge startup forever. */
function waitForReady<T>(ready: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      finish({ error: new Error(`connection generation was not ready within ${String(timeoutMs)}ms`) })
    }, timeoutMs)
    const aborted = (): void => {
      finish({ error: new Error('connection generation aborted', { cause: signal.reason }) })
    }
    const finish = (outcome: { readonly value: T } | { readonly error: Error }): void => {
      if (settled) return
      settled = true
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
