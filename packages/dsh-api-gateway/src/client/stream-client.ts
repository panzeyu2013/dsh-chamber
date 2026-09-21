/**
 * Browser owner for the Gateway multiplexed Remote stream socket.
 *
 * ## chamber fork (WP3/M3): chamber copy of the upstream
 * `packages/api/gateway` client half with the per-entry base-path patch. The
 * upstream route is hardcoded to `/api/remote.mux` on the page origin; chamber
 * instances live behind the control-plane per-instance proxy prefix
 * (`basePath = /api/i/<id>`), so the stream WebSocket must land on
 * `${basePath}/api/remote.mux`. The base path is an explicit constructor
 * argument (per-entry plugin config, never a page-global knob) and
 * `remoteStreamUrl()` is now an instance method reading it.
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

import {
  parseRemoteStreamServerMessage,
  REMOTE_STREAM_MUX_PATH,
  type RemoteStreamClientMessage,
  type RemoteStreamServerMessage,
} from '../stream-protocol.ts'
import { Deque } from '@deepseek-ai/dsh-deque'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  REMOTE_STREAM_HANDSHAKE_TIMEOUT_MS,
  REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS,
  REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS,
  remoteStreamOpeningTimeoutMs,
  REMOTE_STREAM_SILENT_TEARDOWN_MIN_MS,
  shouldReplaceSilentSocket,
  streamOpeningKey,
} from './remote-retry-policy.ts'
import type { StreamForensicsReporter } from './stream-forensics.ts'

const INTERNAL_BASE = 'http://dsh.internal'

/** Physical Remote stream socket failure that may be retried by a domain transport. */
export class RemoteStreamCarrierError extends Error {
  /**
   * @param message - physical carrier failure description.
   * @param options - optional causal error.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteStreamCarrierError'
  }
}

/**
 * chamber patch (2026-09 review): a candidate rejection the MUX itself requested
 * (the connection lane asked for a fresh socket). It is not a connect failure, so
 * it must not widen the self-heal interval — otherwise the ~20 s page-side socket
 * cycling this change exists to survive would inflate the mux cadence to the cap
 * without a single failed attempt.
 */
class RemoteStreamReconnectRequest extends RemoteStreamCarrierError {}

interface SocketWaiter {
  readonly revision: number
  resolve(socket: WebSocket): void
  reject(error: unknown): void
}

/**
 * Upper bound on the opening-budget ledger (chamber patch, 2026-09-21 review).
 * One entry per timed-out request, cleared only by close() before this bound.
 */
const OPENING_BUDGET_KEYS_MAX = 256

/** Keep one physical WebSocket and share it among independently cancellable Remote streams. */
export class RemoteStreamMuxClient {
  /** chamber patch: per-entry control-plane base path, normalized (trailing slashes stripped); '' keeps the stock route. */
  private readonly basePath: string
  private socket: WebSocket | undefined
  private cancelCandidate: ((error: Error) => void) | undefined
  private keepAlive: Promise<void> | undefined
  private revision = 0
  private readonly streams = new Map<string, StreamInbox>()
  private readonly waiters = new Set<SocketWaiter>()
  /** chamber patch: consecutive opening-item timeouts per logical stream REQUEST (endpoint + payload digest; see remote-retry-policy.ts). */
  private readonly openingTimeouts = new Map<string, number>()

  /**
   * Request key of every LIVE logical stream (chamber patch, 2026-09-21 review).
   * The opening budget is keyed by endpoint+payload, so it survived the stream that
   * earned it: a rebuilt session (auto/manual resync) re-issues the SAME payload and
   * inherited a widening of up to 300 s. This registry is what lets the finally block
   * below tell "the retry lane is re-issuing the same request" (keep the widening)
   * from "a new logical stream is asking for it" (start at the tight base budget).
   */
  private readonly streamOpeningKeys = new Map<string, string>()
  /** chamber patch (design 14 §D4, 2026-09): frames received on the CURRENT socket — the liveness evidence the silent-socket escalation keys on. Reset whenever the current socket changes. */
  private socketFrames = 0
  /** chamber patch: when the mux itself last started a connect attempt (self-heal throttle). */
  private lastMaintainAt = 0
  /** chamber patch: current self-heal interval; doubles while attempts keep failing. */
  private maintainIntervalMs = REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS
  /** chamber patch: the single pending self-heal timer (never a one-shot attempt). */
  private healTimer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private disposed = false

  /**
   * chamber patch: bind the per-entry base path so every Remote stream socket
   * lands under the control-plane proxy prefix. `''` (or the stock `/api`,
   * which the mux route already carries) restores the upstream behavior.
   * @param basePath - per-entry proxy base path (`/api/i/<id>`); a trailing slash is tolerated.
   * @param forensics - chamber patch: bounded lifecycle reporter (design 14 §D4); omitted = no reporting.
   */
  constructor(basePath = '', private readonly forensics?: StreamForensicsReporter) {
    const normalized = basePath.replace(/\/+$/, '')
    this.basePath = normalized === '' || normalized === '/api' ? '' : normalized
  }

  /** Ensure a physical attempt exists, following the current attempt once if needed. */
  start(): void {
    if (this.disposed) return
    this.running = true
    if (this.socket?.readyState === WebSocket.OPEN) return
    const pending = this.keepAlive
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /** Cancel the current socket or retry wait and start a fresh attempt immediately. */
  reconnect(): void {
    if (!this.running || this.disposed) return
    this.forensics?.('socket-reconnect', 'reconnect requested by the connection lane')
    this.replaceSocket(
      new RemoteStreamReconnectRequest('api gateway: Remote stream reconnect requested'),
      'reconnect requested',
    )
  }

  /**
   * chamber patch (design 14 §D4, 2026-09): throw the CURRENT physical socket away
   * and start a fresh attempt at once, failing every logical stream with a carrier
   * error so their retry lanes re-issue on the replacement.
   *
   * `lost()` owns a socket that announced its own death; this is the same teardown
   * for a socket the fork itself decided is unusable while the page still sees it
   * OPEN. Two callers: the connection lane's `reconnect()` (deliberate restart) and
   * the silent-socket escalation in `open()` (an opening item timed out on a socket
   * that delivered nothing at all — see `shouldReplaceSilentSocket`).
   * @param failure - carrier failure every active logical stream observes.
   * @param closeReason - WebSocket close reason (diagnostic; the lane and the
   *   escalation keep their own so the wire trace still names the caller).
   */
  private replaceSocket(failure: RemoteStreamCarrierError, closeReason: string): void {
    if (!this.running || this.disposed) return
    const pending = this.keepAlive
    this.revision++
    // A deliberate replacement starts from the base cadence: the reconnect below is
    // the attempt, not a failure to back off from.
    this.maintainIntervalMs = REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS
    this.cancelCandidate?.(failure)
    const socket = this.socket
    if (socket !== undefined) {
      this.socket = undefined
      this.socketFrames = 0
      this.failAll(failure)
      socket.close(4000, closeReason)
    }
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /**
   * Open one logical stream on the persistent physical connection.
   * If no physical attempt is active, opening waits for Connection to request
   * one or for the signal to abort.
   * @param endpoint - Typert Remote stream endpoint.
   * @param payload - endpoint request encoded on the wire.
   * @param signal - cancellation for this logical stream.
   * @returns Host items until completion, cancellation, or failure.
   */
  async *open(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncGenerator {
    signal.throwIfAborted()
    const streamId = randomUUID()
    const inbox = new StreamInbox()
    let carrier: WebSocket | undefined
    let opened = false
    let terminal = false
    // Set by the opening-item deadline below; read by the finally block. Declared
    // before the try so an early throw can never hit its temporal dead zone.
    let timedOut = false
    // Frames received on the socket when THIS stream's open frame was sent. Declared
    // here (not inside the try) so the finally block can read it too: the teardown
    // escalation below needs the same baseline the opening deadline uses.
    let framesAtSend = 0
    // When that open frame was sent: the teardown escalation's own evidence window.
    let sentAt = 0
    let opening: ReturnType<typeof setTimeout> | undefined
    const abort = (): void => { inbox.fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const socket = await this.waitForSocket(signal)
      signal.throwIfAborted()
      // chamber patch (design 14 §D4, 2026-09 ui-chat freeze investigation): a
      // socket that was replaced, or started closing, since `waitForSocket`
      // resolved would DISCARD the open frame silently — RFC 6455 only throws
      // for CONNECTING; CLOSING/CLOSED drops the payload. The guard closes that
      // interleaving window explicitly (it is the last statement before the
      // synchronous send); the opening deadline below is the durable protection
      // for every other way an open frame or its answer can be lost.
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
        throw new RemoteStreamCarrierError(
          'api gateway: Remote stream socket was replaced before its open frame could be sent',
        )
      }
      carrier = socket
      const openingKey = streamOpeningKey(endpoint, payload)
      this.streams.set(streamId, inbox)
      this.streamOpeningKeys.set(streamId, openingKey)
      this.send(socket, { type: 'open', streamId, endpoint, payload })
      opened = true
      // chamber patch: the Host MUST answer a stream open with its opening item
      // (snapshot/ready). Nothing below this layer has a deadline — `Session.doOpen`
      // awaits this iterator forever — so a lost opening frame is indistinguishable
      // from a live-but-silent stream. Fail the INBOX (never the generation signal:
      // aborting it would settle the retry lane terminally) so the existing paced
      // reopen re-issues the stream, and the page fact/chip report the churn.
      const openingBudgetMs = remoteStreamOpeningTimeoutMs(this.openingTimeouts.get(openingKey) ?? 0)
      // chamber patch (design 14 §D4, 2026-09): liveness baseline for the escalation
      // below. `socketFrames` counts frames received on the CURRENT socket, so this
      // subtraction answers exactly "did this socket deliver anything while this
      // attempt's opening item was pending".
      framesAtSend = this.socketFrames
      sentAt = Date.now()
      opening = setTimeout(() => {
        timedOut = true
        this.openingTimeouts.set(openingKey, (this.openingTimeouts.get(openingKey) ?? 0) + 1)
        // Bounded (2026-09-21 review): this map held one entry per timed-out request
        // and was cleared only by close(), so a page that timed out on many sessions
        // grew it without a limit. Oldest-first eviction is enough — an evicted key
        // merely starts its next attempt at the tight base budget.
        if (this.openingTimeouts.size > OPENING_BUDGET_KEYS_MAX) {
          const oldest = this.openingTimeouts.keys().next().value
          if (oldest !== undefined) this.openingTimeouts.delete(oldest)
        }
        this.forensics?.('opening-timeout', `${endpoint} waited ${String(openingBudgetMs)}ms`)
        inbox.fail(new RemoteStreamCarrierError(
          `api gateway: Remote stream ${JSON.stringify(endpoint)} delivered no opening item within ${String(openingBudgetMs)}ms`,
        ))
        // Re-issuing is only a cure while the socket still delivers: a socket that
        // stayed silent for the whole budget window must be REPLACED, or the widened
        // retry budget (30 → 60 → 120 → 240 → 300 s) only makes the stall longer. Nothing
        // else can see this state: the connection lane's readiness handshake already
        // succeeded against the same socket, and a per-session rebuild re-issues on
        // it as well. Guarded by identity + OPEN so a socket replaced in the same
        // turn can never be judged with another socket's counter.
        if (socket === this.socket && socket.readyState === WebSocket.OPEN
          && shouldReplaceSilentSocket(this.socketFrames - framesAtSend)) {
          this.forensics?.('socket-silent', `${endpoint} timed out with no frame delivered on the current socket`)
          this.replaceSocket(new RemoteStreamCarrierError(
            'api gateway: Remote stream socket delivered no frame while an opening item was pending',
          ), 'silent socket replaced')
        }
      }, openingBudgetMs)
      let awaitingOpeningItem = true
      while (true) {
        const frame = await inbox.next()
        if (awaitingOpeningItem) {
          awaitingOpeningItem = false
          this.openingTimeouts.delete(openingKey)
          clearTimeout(opening)
          opening = undefined
        }
        signal.throwIfAborted()
        if (frame.type === 'item') {
          yield frame.value
          continue
        }
        terminal = true
        if (frame.type === 'error') {
          throw new RemoteError(frame.error.code as never, frame.error.message, frame.error.details as never)
        }
        return
      }
    } finally {
      if (opening !== undefined) clearTimeout(opening)
      signal.removeEventListener('abort', abort)
      this.streams.delete(streamId)
      const departedKey = this.streamOpeningKeys.get(streamId)
      this.streamOpeningKeys.delete(streamId)
      // A stream that ended WITHOUT an opening timeout left through its consumer (a
      // rebuild, a dispose, a healthy end) — never through the retry lane. The next
      // logical stream for that request is therefore a NEW episode and must start at
      // the tight base budget: keeping a widening earned by the stream it replaced
      // would make the auto/manual resync wait up to 300 s for its first frame
      // (2026-09-21 review). The widening survives only while a live sibling still
      // owns the same request key.
      if (!timedOut && departedKey !== undefined) {
        let shared = false
        for (const key of this.streamOpeningKeys.values()) {
          if (key === departedKey) {
            shared = true
            break
          }
        }
        if (!shared) this.openingTimeouts.delete(departedKey)
      }
      // chamber patch (design 14 §D4, 2026-09): the opening deadline is not the only
      // place a silent carrier can be proved. The journal watchdog aborts its sibling
      // probe at 20 s — BEFORE the 30 s opening budget can fire — so a session that had
      // already opened could lose its carrier with no page-level signal at all. A
      // stream torn down (abort, dispose, consumer break) that never saw a single
      // frame on its socket during a life of at least
      // REMOTE_STREAM_SILENT_TEARDOWN_MIN_MS is the same evidence, and escalates here:
      // receiving this stream's opening item would itself have advanced the socket's
      // frame counter, so a zero delta IS "still unanswered". The lifetime bound is
      // what keeps a healthy socket safe — every reconnect starts a socket whose frame
      // counter is 0, and a stream aborted before the socket could answer must not
      // judge it. `!timedOut`: when the opening deadline already escalated, one
      // verdict per stream is enough.
      if (opened && !terminal && !timedOut
        && Date.now() - sentAt >= REMOTE_STREAM_SILENT_TEARDOWN_MIN_MS
        && this.running && !this.disposed
        && carrier !== undefined && carrier === this.socket && carrier.readyState === WebSocket.OPEN
        && shouldReplaceSilentSocket(this.socketFrames - framesAtSend)) {
        this.forensics?.('socket-silent', endpoint + ' torn down with no frame delivered on the current socket')
        this.replaceSocket(new RemoteStreamCarrierError(
          'api gateway: Remote stream socket delivered no frame for the whole life of a logical stream',
        ), 'silent socket replaced on teardown')
      }
      if (opened && !terminal && carrier?.readyState === WebSocket.OPEN) {
        this.send(carrier, { type: 'cancel', streamId })
      }
    }
  }

  /**
   * Permanently stop the carrier, close the physical socket, and fail every
   * active logical stream.
   * @returns once the active connection attempt has stopped.
   */
  async close(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.running = false
      this.forensics?.('socket-disposed', 'mux client disposed')
      const error = new Error('api gateway: Remote stream client disposed')
      this.failAll(error)
      for (const waiter of [...this.waiters]) waiter.reject(error)
      this.stopHealTimer()
      this.openingTimeouts.clear()
      this.streamOpeningKeys.clear()
      this.socketFrames = 0
      this.cancelCandidate?.(error)
      const socket = this.socket
      this.socket = undefined
      socket?.close(1000, 'disposed')
    }
    await this.keepAlive
  }

  private connect(): Promise<WebSocket> {
    let socket: WebSocket
    try {
      socket = new WebSocket(this.remoteStreamUrl())
    } catch (error) {
      // A synchronous constructor throw (mixed content, an invalid URL) must become
      // an ordinary carrier failure: the caller's heal path already handles it, and
      // an uncaught throw inside the heal timer would kill recovery silently.
      return Promise.reject(new RemoteStreamCarrierError(
        'api gateway: Remote stream WebSocket could not be constructed',
        { cause: error },
      ))
    }
    const connecting = new Promise<WebSocket>((resolve, reject) => {
      let settled = false
      // chamber patch (2026-09 review): bound the handshake itself. A socket that
      // never fires open/error/close would otherwise park this attempt until the
      // connection lane's readiness timeout, and the mux's self-heal cannot arm
      // while an attempt is in flight.
      let handshake: ReturnType<typeof setTimeout> | undefined
      const clearHandshake = (): void => {
        if (handshake === undefined) return
        clearTimeout(handshake)
        handshake = undefined
      }
      const rejectCandidate = (error: Error): void => {
        settled = true
        clearHandshake()
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('message', received)
        socket.removeEventListener('close', closed)
        this.cancelCandidate = undefined
        socket.close()
        reject(error)
      }
      const opened = (): void => {
        settled = true
        clearHandshake()
        this.cancelCandidate = undefined
        // chamber patch: an established socket resets the self-heal cadence, so its
        // own loss is healed at once (and no stale timer fires behind it).
        this.maintainIntervalMs = REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS
        this.stopHealTimer()
        this.socket = socket
        this.socketFrames = 0
        for (const waiter of [...this.waiters]) waiter.resolve(socket)
        resolve(socket)
      }
      const failed = (): void => {
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket failed to open',
          ))
          return
        }
        const error = new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed')
        this.lost(socket, error)
        socket.close()
      }
      const closed = (): void => {
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket closed before opening',
          ))
          return
        }
        this.lost(socket)
      }
      const received = (event: MessageEvent): void => { this.receive(socket, event.data) }
      this.cancelCandidate = rejectCandidate
      const candidate = setTimeout(() => {
        rejectCandidate(new RemoteStreamCarrierError(
          'api gateway: Remote stream WebSocket handshake timed out',
        ))
      }, REMOTE_STREAM_HANDSHAKE_TIMEOUT_MS)
      ;(candidate as unknown as { unref?: () => void }).unref?.()
      handshake = candidate
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed, { once: true })
      socket.addEventListener('message', received)
      socket.addEventListener('close', closed, { once: true })
    })
    return connecting
  }

  /** chamber patch: instance method so the mux route carries the per-entry base path ('' = stock route). */
  private remoteStreamUrl(): string {
    const location = (globalThis as { location?: { origin?: string } }).location
    const base = location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
    const url = new URL(`${this.basePath}${REMOTE_STREAM_MUX_PATH}`, base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.href
  }

  private waitForSocket(signal: AbortSignal): Promise<WebSocket> {
    signal.throwIfAborted()
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket)
    if (this.disposed) return Promise.reject(new Error('api gateway: Remote stream client disposed'))
    if (!this.running) return Promise.reject(new Error('api gateway: Remote stream client not started'))
    return new Promise((resolve, reject) => {
      const aborted = (): void => { waiter.reject(signal.reason) }
      const cleanup = (): void => {
        this.waiters.delete(waiter)
        signal.removeEventListener('abort', aborted)
      }
      const waiter: SocketWaiter = {
        revision: this.revision,
        resolve: (socket) => {
          cleanup()
          resolve(socket)
        },
        reject: (error) => {
          cleanup()
          // AbortSignal.reason belongs to the caller and may intentionally be a non-Error sentinel.
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(error)
        },
      }
      this.waiters.add(waiter)
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  private receive(socket: WebSocket, data: unknown): void {
    if (socket !== this.socket) return
    try {
      if (typeof data !== 'string') throw new Error('api gateway: Remote stream WebSocket requires text messages')
      const frame = parseRemoteStreamServerMessage(data)
      // chamber patch: one liveness count per delivered frame — the silent-socket
      // escalation keys on it (this socket answered SOMETHING while an open was
      // pending), never on the frame's content.
      this.socketFrames += 1
      this.streams.get(frame.streamId)?.push(frame)
    } catch (error) {
      const failure = new RemoteStreamCarrierError('api gateway: invalid Remote stream frame', { cause: error })
      this.failAll(failure)
      this.lost(socket, failure)
      socket.close(4002, 'invalid Remote stream frame')
    }
  }

  private lost(
    socket: WebSocket,
    error: RemoteStreamCarrierError = new RemoteStreamCarrierError(
      'api gateway: Remote stream WebSocket closed',
    ),
  ): void {
    if (this.socket !== socket) return
    this.socket = undefined
    this.socketFrames = 0
    this.forensics?.('socket-lost', error.message)
    this.failAll(error)
    // chamber patch (2026-09 review): the connection lane's generation source is
    // the $events stream ON THIS MUX, so waiting for the lane to notice a lost
    // socket is circular whenever the loop is parked (offline gate, between
    // attempts): every open() would wait forever with no error edge. Self-heal
    // here — and RE-SCHEDULE, because a single throttled attempt is not enough:
    // a socket that dies inside the interval, or a replacement connect that fails
    // before opening, would otherwise park the mux forever.
    //
    // Re-scheduled on the MICROTASK QUEUE as well (2026-09-21 review): a socket that
    // opens and closes inside ONE task leaves `keepAlive` still set when the
    // synchronous call below runs (its promise settles in a microtask), so that
    // attempt returns and NOTHING is armed — no socket, no timer, no error — and every
    // later `open()` parks on `waitForSocket`. The queued call either arms the missing
    // timer or finds one already armed.
    this.scheduleMaintain()
    queueMicrotask(() => { this.scheduleMaintain() })
  }

  /**
   * chamber patch (2026-09 review): maintain the mux's own reconnect without ever
   * parking. Maintain now when the current interval has elapsed, otherwise arm
   * exactly one timer for the remainder; failed attempts widen the interval in
   * maintain()'s rejection path, and a successful open resets it.
   */
  private scheduleMaintain(): void {
    if (!this.running || this.disposed) return
    if (this.socket?.readyState === WebSocket.OPEN || this.keepAlive !== undefined) return
    const elapsed = Date.now() - this.lastMaintainAt
    if (elapsed >= this.maintainIntervalMs) {
      this.maintain()
      return
    }
    if (this.healTimer !== undefined) return
    const timer = setTimeout(() => {
      this.healTimer = undefined
      this.scheduleMaintain()
    }, this.maintainIntervalMs - elapsed)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.healTimer = timer
  }

  private stopHealTimer(): void {
    if (this.healTimer === undefined) return
    clearTimeout(this.healTimer)
    this.healTimer = undefined
  }

  private maintain(): void {
    if (!this.running || this.disposed) return
    if (this.socket?.readyState === WebSocket.OPEN || this.keepAlive !== undefined) return
    this.lastMaintainAt = Date.now()
    const revision = this.revision
    const task = this.connect().then(
      () => undefined,
      (error: unknown) => {
        if (!this.running) return
        for (const waiter of [...this.waiters]) {
          if (waiter.revision <= revision) waiter.reject(error)
        }
        // chamber patch: one failed attempt must not end the mux's own recovery —
        // widen the interval once per consecutive failure (capped at the lane's
        // own backoff ceiling), release OUR in-flight guard (identity-checked: a
        // newer attempt's guard must survive) and schedule the next attempt. The
        // re-schedule lives here, not in a task.then handler, because this handler
        // consumes the rejection and so the derived task fulfils.
        if (!(error instanceof RemoteStreamReconnectRequest)) {
          this.maintainIntervalMs = Math.min(this.maintainIntervalMs * 2, REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS)
          // A construction/handshake failure that no logical stream is waiting for
          // would otherwise retry silently forever (2026-09 review): one bounded
          // fact per attempt makes the loop visible without any log channel.
          this.forensics?.(
            'socket-attempt-failed',
            'connect attempt failed; next attempt in ' + String(this.maintainIntervalMs) + 'ms',
          )
        }
        if (this.keepAlive === task) this.keepAlive = undefined
        this.scheduleMaintain()
      },
    )
    this.keepAlive = task
    void task.then(() => {
      if (this.keepAlive === task) this.keepAlive = undefined
    })
  }

  private failAll(error: unknown): void {
    for (const stream of this.streams.values()) stream.fail(error)
  }

  private send(socket: WebSocket, message: RemoteStreamClientMessage): void {
    socket.send(JSON.stringify(message))
  }
}

class StreamInbox {
  private readonly frames = new Deque<RemoteStreamServerMessage>()
  private wake: (() => void) | undefined
  private failure: Error | undefined

  push(frame: RemoteStreamServerMessage): void {
    if (this.failure !== undefined) return
    this.frames.pushBack(frame)
    this.wake?.()
    this.wake = undefined
  }

  fail(error: unknown): void {
    if (this.failure !== undefined) return
    this.failure = error instanceof Error ? error : new Error(String(error), { cause: error })
    this.frames.clear()
    this.wake?.()
    this.wake = undefined
  }

  async next(): Promise<RemoteStreamServerMessage> {
    while (this.frames.size === 0) {
      if (this.failure !== undefined) throw this.failure
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    return this.frames.popFront() as RemoteStreamServerMessage
  }
}
