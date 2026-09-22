/**
 * Browser owner for the Gateway multiplexed Remote stream socket.
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
  REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS,
  REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS,
  streamOpeningKey,
} from './remote-retry-policy.ts'
// The opening-stall rule (streak threshold + 60 s cooldown) lives in the shared
// reducer (@dsh-chamber/dsh-stream-state); the fork-side predicate that used to own it
// was retired with its constants in .
import type { StreamForensicsReporter } from './stream-forensics.ts'
import {
  CARRIER_ENV,
  HANDSHAKE_TIMEOUT_MS,
  SILENT_TEARDOWN_MIN_MS,
  initialCarrierState,
  openingBudgetMs,
  reduceCarrier,
  withDeadline,
  type CarrierEnv,
  type CarrierEvent,
  type RebuildReason,
  type RecoveryEffect,
} from '@dsh-chamber/dsh-stream-state'

/** The real clock, injected (the package imports nothing). W2's bound is the only
 *  timer left on the opening path; its VALUE still comes from the policy module. */
/** W3's bound must not hold the process open: its handles are unref'd exactly as the
 *  retired hand-written timer was. */
const UNREF_SCHEDULER = {
  setTimeout: (run: () => void, ms: number): unknown => {
    const handle = setTimeout(run, ms)
    ;(handle as unknown as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

const DEADLINE_SCHEDULER = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

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
 * chamber patch (): a candidate rejection the MUX itself requested
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
 * Upper bound on the opening-budget ledger (chamber patch, ).
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
  /**  episode release handles, so the reducer's `reopenLogicalStream` can reach
   *  the exact stream it releases without disturbing `streams`' teardown order. */
  private readonly pendingOpens = new Map<string, (reason: unknown) => void>()
  private readonly waiters = new Set<SocketWaiter>()
  /** chamber patch: consecutive opening-item timeouts per logical stream REQUEST (endpoint + payload digest; see remote-retry-policy.ts). */
  private readonly openingTimeouts = new Map<string, number>()

  /**
   * Request key of every LIVE logical stream (chamber patch, ).
   * The opening budget is keyed by endpoint+payload, so it survived the stream that
   * earned it: a rebuilt session (auto/manual resync) re-issues the SAME payload and
   * inherited a widening of up to 300 s. This registry is what lets the finally block
   * below tell "the retry lane is re-issuing the same request" (keep the widening)
   * from "a new logical stream is asking for it" (start at the tight base budget).
   */
  private readonly streamOpeningKeys = new Map<string, string>()
  /** chamber patch (design 14 §D4, ): frames received on the CURRENT socket — the liveness evidence the silent-socket escalation keys on. Reset whenever the current socket changes. */
  private socketFrames = 0
  /**  carrier lifecycle, owned by the shared reducer (see requestCarrierRebuild). */
  private carrierState = initialCarrierState()
  /** Table values; the package owns them. */
  private readonly carrierEnv: CarrierEnv = CARRIER_ENV
  /** Numeric token: a captured object token does not survive generator suspensions. */
  private decisionCycle: number | undefined
  private decisionEpoch = 0
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
    // A lane-commanded reconnect is its own decision cycle: a fresh token means the
    // guard can never suppress it (its old defect was being superseded by, not
    // duplicating, another lever).
    this.requestCarrierRebuild(
      new RemoteStreamReconnectRequest('api gateway: Remote stream reconnect requested'),
      'reconnect requested',
      'laneReconnect',
      this.nextDecisionCycle(),
    )
  }

  /** A fresh decision cycle (one replacement budget per deciding operation). */
  private nextDecisionCycle(): number {
    this.decisionEpoch += 1
    return this.decisionEpoch
  }

  /** Record one carrier event in the shared reducer; its effects are the decision. */
  private observeCarrier(event: CarrierEvent): readonly RecoveryEffect[] {
    const reduction = reduceCarrier(this.carrierState, event, this.carrierEnv)
    this.carrierState = reduction.state
    return reduction.effects
  }

  /** The single replacement path. The gate is the shared reducer's; a refusal still
   *  yields `reopenLogicalStream`. `cycle` = one replacement per decision cycle. */
  private requestCarrierRebuild(
    failure: RemoteStreamCarrierError,
    closeReason: string,
    reason: RebuildReason,
    cycle: number,
    streamId?: string,
    streak?: number,
    framesSinceSend?: number,
  ): readonly RecoveryEffect[] {
    if (this.decisionCycle === cycle) return []
    this.decisionCycle = cycle
    const effects = this.observeCarrier({
      kind: 'rebuildRequested',
      at: Date.now(), // the reducer's window is a time window
      reason,
      streak,
      streamId,
      // P3: the frame delta is an OBSERVATION, not a verdict - the reducer owns
      // whether it means a silent carrier.
      framesSinceSend,
    })
    const decided = effects.some((effect) => effect.e === 'rebuildCarrier')
    if (decided) this.replaceSocket(failure, closeReason)
    // A refusal is paired with `reopenLogicalStream`: no exitless spinner.
    this.applyRecoveryEffects(effects, failure)
    return effects
  }

  /** Execute the reducer's typed effects. Unknown effects are ignored so the package
   *  can add observability-only effects without breaking older executors. */
  private applyRecoveryEffects(effects: readonly RecoveryEffect[], failure: unknown): void {
    for (const effect of effects) {
      switch (effect.e) {
        case 'reopenLogicalStream': {
          const fail = this.pendingOpens.get(effect.streamId)
          if (fail === undefined) break
          this.pendingOpens.delete(effect.streamId)
          fail(failure)
          break
        }
        case 'rebuildCarrier':
          // P5: the replacement is a reducer decision, so the resident tail records
          // the DECISION (and its reason), not only the executor's callback.
          this.forensics?.('carrier-rebuild', effect.reason)
          break
        case 'throttled':
          this.forensics?.('carrier-throttled', effect.reason)
          break
        default:
          // Unknown/observability effects are ignored so the package can add faces
          // without breaking older executors.
          break
      }
    }
  }

  /**
   * chamber patch (design 14 §D4, ): throw the CURRENT physical socket away
   * and start a fresh attempt at once, failing every logical stream with a carrier
   * error so their retry lanes re-issue on the replacement.
   * `lost()` owns a socket that announced its own death; this is the same teardown
   * for a socket the fork itself decided is unusable while the page still sees it
   * OPEN. Two callers: the connection lane's `reconnect()` (deliberate restart) and
   * the silent-socket escalation in `open()` (an opening item timed out on a socket
   * that delivered nothing at all — the reducer owns that verdict).
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
    //  publish this episode's release handle so the reducer's
    // `reopenLogicalStream` effect can reach the exact stream it is releasing.
    this.pendingOpens.set(streamId, (reason: unknown) => { inbox.fail(reason) })
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
    const abort = (): void => { inbox.fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const socket = await this.waitForSocket(signal)
      signal.throwIfAborted()
      // chamber patch (design 14 §D4, ): a
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
      const budgetMs = openingBudgetMs(this.openingTimeouts.get(openingKey) ?? 0)
      // chamber patch (design 14 §D4, ): liveness baseline for the escalation
      // below. `socketFrames` counts frames received on the CURRENT socket, so this
      // subtraction answers exactly "did this socket deliver anything while this
      // attempt's opening item was pending".
      framesAtSend = this.socketFrames
      sentAt = Date.now()
      const deadlineCycle = this.nextDecisionCycle()
      //  (W2): the expiry body becomes the primitive's onExpire. It runs at the
      // same moment the old timer did and returns the sentinel the race reports.
      const onOpeningExpire = (): 'expired' => {
        timedOut = true
        const streak = (this.openingTimeouts.get(openingKey) ?? 0) + 1
        this.openingTimeouts.set(openingKey, streak)
        // Bounded (): this map held one entry per timed-out request
        // and was cleared only by close(), so a page that timed out on many sessions
        // grew it without a limit. Oldest-first eviction is enough — an evicted key
        // merely starts its next attempt at the tight base budget.
        if (this.openingTimeouts.size > OPENING_BUDGET_KEYS_MAX) {
          const oldest = this.openingTimeouts.keys().next().value
          if (oldest !== undefined) this.openingTimeouts.delete(oldest)
        }
        this.forensics?.('opening-timeout', `${endpoint} waited ${String(budgetMs)}ms`)
        inbox.fail(new RemoteStreamCarrierError(
          `api gateway: Remote stream ${JSON.stringify(endpoint)} delivered no opening item within ${String(budgetMs)}ms`,
        ))
        // TWO evidence paths, ONE teardown (design 14 §D4, 2026-09 + 2026-09-21):
        // 1. ZERO frames on this socket across the whole budget window — the carrier
        //    itself is dead (a half-open leg whose FIN never arrived), so re-issuing
        //    into it can never succeed and the widened budget (30 → 60 → 120 → 240 →
        //    300 s) would only stretch the stall. Nothing else in the page can see
        //    it: the connection lane's readiness handshake already succeeded here,
        //    and a per-session rebuild re-issues on this same socket.
        // 2. The socket IS delivering (frames for other streams) but THIS request's
        //    opening item stays unanswered: the retry lane can only re-issue the same
        //    request on the same physical generation, so after a whole extra widened
        //    budget the carrier is rebuilt anyway — at most once per cooldown.
        // Both paths go through replaceSocket() (the lane-commanded reconnect's own
        // teardown) and both are judged on the socket this attempt sent on, so a
        // replacement in the same turn can never borrow another socket's state.
        if (socket === this.socket && socket.readyState === WebSocket.OPEN) {
          // P3: ONE request, no host-side silent branch. The frame delta is the
          // observation; the reducer decides whether it is a dead carrier
          // (socketNoFrame) or a threshold-gated stall, and the forensics label is
          // read back off the effect it authorized.
          const effects = this.requestCarrierRebuild(new RemoteStreamCarrierError(
            'api gateway: Remote stream carrier rebuilt after an unanswered opening item',
          ), 'opening stall', 'openingStall', deadlineCycle, streamId, streak, this.socketFrames - framesAtSend)
          const rebuilt = effects.find((effect) => effect.e === 'rebuildCarrier')
          if (rebuilt !== undefined && rebuilt.e === 'rebuildCarrier') {
            if (rebuilt.reason === 'socketNoFrame') {
              this.forensics?.('socket-silent', `${endpoint} timed out with no frame delivered on the current socket`)
            } else {
              this.forensics?.(
                'opening-stall-escalation',
                `${endpoint} unanswered ${String(streak)}x; rebuilding the physical carrier`,
              )
            }
          }
        }
        return 'expired'
      }
      let awaitingOpeningItem = true
      while (true) {
        //  (W2): the bound must NOT cancel this wait - it fails the inbox, and the
        // frame that failure produces is what the loop still has to receive. So the
        // primitive races the frame's OWN promise, and on the deadline branch we keep
        // awaiting that same promise. (withDeadline is the right primitive precisely
        // because it takes no signal: "timeout does not cancel" is its documented
        // semantic, and it is this site's contract.)
        let frame: RemoteStreamServerMessage
        if (awaitingOpeningItem) {
          const firstFrame = inbox.next()
          const raced = await withDeadline<RemoteStreamServerMessage | 'expired'>(firstFrame, {
            ms: budgetMs,
            onExpire: onOpeningExpire,
            scheduler: DEADLINE_SCHEDULER,
          })
          frame = raced.settled === 'deadline' ? await firstFrame : (raced.value as RemoteStreamServerMessage)
          awaitingOpeningItem = false
          this.openingTimeouts.delete(openingKey)
        } else {
          frame = await inbox.next()
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
      signal.removeEventListener('abort', abort)
      this.streams.delete(streamId)
      this.pendingOpens.delete(streamId)
      const departedKey = this.streamOpeningKeys.get(streamId)
      this.streamOpeningKeys.delete(streamId)
      // A stream that ended WITHOUT an opening timeout left through its consumer (a
      // rebuild, a dispose, a healthy end) — never through the retry lane. The next
      // logical stream for that request is therefore a NEW episode and must start at
      // the tight base budget: keeping a widening earned by the stream it replaced
      // would make the auto/manual resync wait up to 300 s for its first frame
      // (). The widening survives only while a live sibling still
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
      // chamber patch (design 14 §D4, ): the opening deadline is not the only
      // place a silent carrier can be proved. The journal watchdog aborts its sibling
      // probe at 20 s — BEFORE the 30 s opening budget can fire — so a session that had
      // already opened could lose its carrier with no page-level signal at all. A
      // stream torn down (abort, dispose, consumer break) that never saw a single
      // frame on its socket during a life of at least
      // SILENT_TEARDOWN_MIN_MS is the same evidence, and escalates here:
      // receiving this stream's opening item would itself have advanced the socket's
      // frame counter, so a zero delta IS "still unanswered". The lifetime bound is
      // what keeps a healthy socket safe — every reconnect starts a socket whose frame
      // counter is 0, and a stream aborted before the socket could answer must not
      // judge it. `!timedOut`: when the opening deadline already escalated, one
      // verdict per stream is enough.
      if (opened && !terminal && !timedOut
        && Date.now() - sentAt >= SILENT_TEARDOWN_MIN_MS
        && this.running && !this.disposed
        && carrier !== undefined && carrier === this.socket && carrier.readyState === WebSocket.OPEN) {
        // P3: the frame delta is the observation; the reducer owns the verdict (a
        // socket that DID deliver can never be proven silent, so it denies the
        // request instead of replacing a healthy carrier). A teardown is its own
        // decision cycle, so a lane reconnect landing in the same turn can no longer
        // be the SECOND replacement of one socket (the correlated-replacement defect).
        const effects = this.requestCarrierRebuild(new RemoteStreamCarrierError(
          'api gateway: Remote stream socket delivered no frame for the whole life of a logical stream',
        ), 'silent socket replaced on teardown', 'teardownNoFrame', this.nextDecisionCycle(), streamId, undefined, this.socketFrames - framesAtSend)
        if (effects.some((effect) => effect.e === 'rebuildCarrier')) {
          this.forensics?.('socket-silent', endpoint + ' torn down with no frame delivered on the current socket')
        }
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

  private async connect(): Promise<WebSocket> {
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
    //  (W3): declared in THIS scope because the deadline hook below runs outside the
    // executor; the executor assigns it (it needs the executor's cleanup closure).
    let expireHandshake: (() => void) | undefined
    const connecting = new Promise<WebSocket>((resolve, reject) => {
      let settled = false
      const rejectCandidate = (error: Error): void => {
        settled = true
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
      expireHandshake = (): void => {
        rejectCandidate(new RemoteStreamCarrierError(
          'api gateway: Remote stream WebSocket handshake timed out',
        ))
      }
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed, { once: true })
      socket.addEventListener('message', received)
      socket.addEventListener('close', closed, { once: true })
    })
    //  (W3): one bound, owned by the primitive. On expiry the hook above rejects
    // `connecting` (same error, same listener cleanup as the old timer); the deadline
    // branch below then surfaces that rejection by awaiting it, so the caller sees
    // exactly what it saw before.
    const raced = await withDeadline<WebSocket | 'expired'>(connecting, {
      ms: HANDSHAKE_TIMEOUT_MS,
      onExpire: () => {
        expireHandshake?.()
        return 'expired' as const
      },
      scheduler: UNREF_SCHEDULER,
    })
    return raced.settled === 'deadline' ? await connecting : (raced.value as WebSocket)
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
   * chamber patch (): maintain the mux's own reconnect without ever
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
