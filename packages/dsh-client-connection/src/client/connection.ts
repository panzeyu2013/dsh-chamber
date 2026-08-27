import type { HostDescription, IApiClient, HostFrame, MuxFrame, RpcRequest } from './api.ts'

/**
 * Reconnect/backoff tunables (deployment-varying — no hardcoded tunables; these become the
 *  future `ctx.connection` plugin's Config). All fields optional; defaults below.
 *
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
 *
 * `basePath` is the added per-instance knob: the browser plugin apply resolves
 * the api-carrier base path from it (falling back to the `window.__DSH_BASE_PATH__`
 * deployment knob at construction — chamber sets it before each sequential
 * instance boot). `/api` is the stock value (no prefix injection — paths are
 * byte-identical to upstream); `/api/i/<id>` routes every RPC/WS path through
 * the control-plane per-instance proxy. Defaults preserve existing behaviour.
 */
export interface ConnectionConfig {
  /** First-retry backoff cap in ms (jittered: actual delay is cap/2..cap). */
  backoffBaseMs?: number
  /** Exponential growth factor per consecutive failed attempt. */
  backoffFactor?: number
  /** Upper bound for the backoff cap in ms. */
  backoffMaxMs?: number
  /** Cap on waiting for both streams' onOpen before onConnected, in ms. The strict handshake
   *  waits for mux+host stream establishment plus describe; a carrier that never
   *  fires onOpen (misbehaving proxy) must not wedge the connection forever — on timeout the
   *  generation proceeds as connected and the live-gap repair path covers stragglers. */
  streamOpenTimeoutMs?: number
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
  streamOpenTimeoutMs: 3_000,
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

/** Frame sink callbacks: the Controller owns the physical streams; business dispatch belongs to
 *  SessionManager. */
export interface ConnectionSinks {
  onMuxEnvelope?: (envelope: RpcRequest<MuxFrame>) => void
  onHostEnvelope?: (envelope: RpcRequest<HostFrame>) => void
  /** After each connection generation is established (both streams open + describe succeeded), first connect included. */
  onConnected?: (description: HostDescription) => void
  /** Coarse state transitions (deduplicated: fires only on change). The initial pre-connect
   *  span reports nothing — the UI treats "no state yet" as connecting, not as an outage. */
  onStateChange?: (state: ConnectionState) => void
}

/**
 * Opens both streams and keeps iterating (pull mode: nothing reads the socket and the tap
 * never fires unless someone for-awaits), reconnecting with exponential backoff on loss.
 * State (generation/attempt) is instance-private, never in the store.
 * The pump body feeds each frame to a sink (sink exceptions must
 * not kill the pump — a broken business layer must not drag down the connection layer).
 */
export class ConnectionController {
  private generation = 0
  private attempt = 0
  private current: AbortController | null = null
  /** The in-flight backoff sleep's controller (2026 round-3 review): stop()
   *  aborts it so a stopped loop never lingers on the retry timer. */
  private retryIdle: AbortController | null = null
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
  private readonly api: IApiClient
  private readonly sinks: ConnectionSinks

  constructor(
    api: IApiClient,
    sinks: ConnectionSinks = {},
    config: ConnectionConfig = {},
  ) {
    // chamber patch (erasableSyntaxOnly): upstream parameter properties are
    // explicit field assignments here so the copy typechecks under the
    // chamber's erasable-only config.
    this.api = api
    this.sinks = sinks
    this.config = { ...CONNECTION_DEFAULTS, ...config }
  }

  /** Idempotent: begin the connect/pump/reconnect loop. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  /** Stop the loop and abort the current generation's streams. */
  stop(): void {
    this.running = false
    // chamber patch (design 14 D4): invalidate any in-flight loop invocation
    // (see loopEpoch) so a later start() can never be overtaken by it.
    this.loopEpoch += 1
    this.current?.abort()
    this.current = null
    // Wake a pending backoff sleep immediately (2026 round-3 review) — the
    // stopped loop must not linger on the retry timer.
    this.retryIdle?.abort()
    this.retryIdle = null
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

      /* v8 ignore next -- initializer placeholder: the Promise executor
       * below runs synchronously and replaces it before anyone can call it. */
      let muxOpened = (): void => {}
      /* v8 ignore next -- same placeholder pattern as muxOpened. */
      let hostOpened = (): void => {}
      const streamsOpen = Promise.all([
        new Promise<void>((resolve) => { muxOpened = resolve }),
        new Promise<void>((resolve) => { hostOpened = resolve }),
      ])

      const failed = new Promise<void>((resolve) => {
        const settle = (): void => {
          if (gen === this.generation && !ac.signal.aborted) ac.abort()
          resolve()
        }
        void this.pumpStream(this.api.events.mux({}, ac.signal, muxOpened), this.sinks.onMuxEnvelope, settle)
        void this.pumpStream(this.api.events.host({}, ac.signal, hostOpened), this.sinks.onHostEnvelope, settle)
      })

      try {
        // Strict readiness handshake: describe proves unary reachability, onOpen
        // proves each physical stream is established before any frame —
        // only then may onConnected fire, so the resync it triggers cannot outrun the
        // subscribed baseline. The timeout guards against a carrier that never fires onOpen
        // (see ConnectionConfig.streamOpenTimeoutMs).
        const timeout = new AbortController()
        const [description] = await Promise.all([
          this.api.host.describe({}),
          Promise.race([streamsOpen, sleep(this.config.streamOpenTimeoutMs, timeout.signal)]),
        ])
        timeout.abort()
        const descriptionResult = description.result
        if (!descriptionResult.ok) {
          throw new Error(`host.describe failed: ${descriptionResult.error.code}: ${descriptionResult.error.message}`)
        }
        if (ac.signal.aborted) throw new Error('generation aborted during readiness handshake')
        this.attempt = 0
        this.emitState('connected')
        // A state sink may synchronously stop this controller. Do not publish
        // a description for a generation that no longer exists afterward.
        if (this.isGenerationActive(ac)) {
          this.callSink(() => { this.sinks.onConnected?.(descriptionResult.value) })
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
      console.warn(`[web-runtime] connection lost, retry #${this.attempt}`)
      this.retryIdle?.abort()
      const idle = new AbortController()
      this.retryIdle = idle
      try {
        await sleep(this.backoffDelay(this.attempt), idle.signal)
      } finally {
        if (this.retryIdle === idle) this.retryIdle = null
      }
    }
  }

  /** Deduplicated state emission (sink isolation applies). */
  private emitState(state: ConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.callSink(() => this.sinks.onStateChange?.(state))
  }

  private async pumpStream<F extends { type: string }>(
    stream: AsyncIterable<RpcRequest<F>>,
    sink: ((envelope: RpcRequest<F>) => void) | undefined,
    onEnd: () => void,
  ): Promise<void> {
    try {
      for await (const envelope of stream) {
        if (envelope.payload.type === 'stream/error') break
        if (sink !== undefined) this.callSink(() => { sink(envelope) })
      }
    } catch {
      // Stream loss: converge on onEnd, which triggers the shared reconnect.
    }
    onEnd()
  }

  /** Sink exception isolation: a business-layer throw is logged only, never affecting pump or reconnect semantics. */
  private callSink(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[web-runtime] connection sink threw:', error)
    }
  }
}
