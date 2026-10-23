/**
 * Browser owner for the Gateway multiplexed Remote stream socket: chamber copy of
 * the upstream client half with the per-entry base-path patch. The upstream route is
 * hardcoded to `/api/remote.mux` on the page origin, while chamber instances sit
 * behind the control-plane proxy prefix, so the socket lands on
 * `${basePath}/api/remote.mux` (an explicit constructor argument, never a page global).
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'

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
// The opening deadline, silent-teardown floor and opening-stall rule are the
// shared stream-state table's/reducer's; this driver reads them, never copies.
import { sessionIdOfPayload, type StreamForensicsDetail, type StreamForensicsKind, type StreamForensicsReporter } from './stream-forensics.ts'
import {
  CARRIER_ENV,
  HANDSHAKE_TIMEOUT_MS,
  SILENT_TEARDOWN_MIN_MS,
  earliestRebuildAt,
  initialCarrierState,
  reduceCarrier,
  withDeadline,
  type CarrierEnv,
  type CarrierEvent,
  type RebuildReason,
  type RecoveryEffect,
} from '@dsh-chamber/dsh-stream-state'

/** The real clock, injected; the bound must not hold the process open, so its handles
 *  are unref'd. Exported so the journal probe rides this same scheduler. */
export const UNREF_SCHEDULER = {
  setTimeout: (run: () => void, ms: number): unknown => {
    const handle = setTimeout(run, ms)
    ;(handle as unknown as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** Floor between two forced replacements of a NON-OPEN carrier: a lane storm must
 *  not turn into a connect/cancel storm (a socket that is not OPEN has no healthy
 *  carrier to preserve, so the reducer's 60s window deliberately does not apply). */
const FORCED_REBUILD_MIN_INTERVAL_MS = 50
/** Fallback delay for a denied rebuild when the reducer state cannot give an
 *  earlier legal time (window/in-flight spacing still wins when it can). */
const THROTTLE_RETRY_FALLBACK_MS = 1_000

const DEADLINE_SCHEDULER = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

const INTERNAL_BASE = 'http://dsh.internal'

/** Physical Remote stream socket failure that may be retried by a domain transport. */
export class RemoteStreamCarrierError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteStreamCarrierError'
  }
}

/**
 * The DOMAIN replaced this generation (a journal stall-watchdog restart, a snapshot
 * restart): a carrier-side teardown, not a consumer departure. The mux marks that
 * episode carrier-initiated so its consecutive-timeout streak survives - a restart
 * must not silently reset the count the stall-escalation threshold reads.
 */
export class RemoteStreamGenerationRestart extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteStreamGenerationRestart'
  }
}

/**
 * A candidate rejection the MUX itself requested (the connection lane asked for a
 * fresh socket): not a connect failure, so it must not widen the self-heal interval.
 */
class RemoteStreamReconnectRequest extends RemoteStreamCarrierError {}

interface SocketWaiter {
  readonly revision: number
  resolve(socket: ConnectionWebSocket): void
  reject(error: unknown): void
}

interface UplinkPump {
  /** Settles once the pump has stopped sending. */
  readonly done: Promise<void>
  /** Interrupt the pump, including a read blocked on the caller's iterator, and release the iterator. */
  stop(): void
}

/** One open logical stream: its downlink frames and, once the `open` frame is out, its uplink pump. */
interface LogicalStream {
  readonly inbox: StreamInbox
  pump: UplinkPump | undefined
}

const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

/** Keep one physical WebSocket, shared among independently cancellable Remote streams. */
export class RemoteStreamMuxClient {
  /** chamber patch: per-entry control-plane base path, normalized (trailing slashes stripped); '' keeps the stock route. */
  private readonly basePath: string
  /** chamber patch: the optional bounded lifecycle reporter. */
  private readonly forensics: StreamForensicsReporter | undefined
  /** The selected authenticated carrier; the default opens `remoteStreamUrl()` for this entry. */
  private readonly openSocket: (path: string) => ConnectionWebSocket
  /** Answering Clients wait for Connection to replace a lost socket; passive Clients fail later opens immediately. */
  private readonly waitForReconnect: boolean
  private socket: ConnectionWebSocket | undefined
  private cancelCandidate: ((error: Error) => void) | undefined
  private keepAlive: Promise<void> | undefined
  private revision = 0
  private readonly streams = new Map<string, LogicalStream>()
  /** Episode release handles, so `reopenLogicalStream` reaches the exact stream
   *  without disturbing teardown order. */
  private readonly pendingOpens = new Map<string, (reason: unknown) => void>()
  private readonly waiters = new Set<SocketWaiter>()
  private readonly socketClosures = new Set<Promise<void>>()
  // The opening streak ledger and stream→request-key registry live in the shared reducer.
  /** chamber patch: frames received on the CURRENT socket — the silent-socket escalation's evidence. Reset when the socket changes. */
  private socketFrames = 0
  /** Carrier lifecycle state, owned by the shared reducer. */
  private carrierState = initialCarrierState()
  /** Table values owned by the package. */
  private readonly carrierEnv: CarrierEnv = CARRIER_ENV
  /** Numeric token: a captured object token does not survive generator suspensions. */
  private decisionCycle: number | undefined
  private decisionEpoch = 0
  /** chamber patch self-heal throttle: last attempt time, current interval (doubles
   *  while attempts fail), and the single pending timer. */
  private lastMaintainAt = 0
  private maintainIntervalMs = REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS
  private healTimer: ReturnType<typeof setTimeout> | undefined
  /** A denied physical rebuild is retried once, at the reducer's earliest legal time.
   *  Without this, a lane reconnect inside the 60s throttle window only re-opens the
   *  logical stream on the SAME (possibly half-open) carrier. */
  private throttleTimer: ReturnType<typeof setTimeout> | undefined
  private throttleRetried = false
  /** Non-OPEN lane reconnects cancel the in-flight attempt; a tight burst must not
   *  turn into a connect/cancel storm. */
  private lastForcedRebuildAt = Number.NEGATIVE_INFINITY
  private running = false
  private disposed = false
  private failure: RemoteStreamCarrierError | undefined

  /**
   * chamber patch: an options object carries the per-entry base path together with the
   * upstream carrier/reconnect selection. `''` (or stock `/api`) restores the stock route,
   * and the default carrier opens this entry's `remoteStreamUrl()` socket, so a supplied
   * `openSocket` can still use upstream's path argument.
   * @param options.basePath - per-entry control-plane prefix; omitted/'' keeps the stock route.
   * @param options.forensics - optional bounded lifecycle reporter.
   * @param options.openSocket - selected authenticated carrier; omission uses the browser socket.
   * @param options.waitForReconnect - answering Clients wait for Connection to replace a lost socket; passive Clients fail later opens immediately.
   */
  constructor(options: {
    basePath?: string
    forensics?: StreamForensicsReporter
    openSocket?: (path: string) => ConnectionWebSocket
    waitForReconnect?: boolean
  } = {}) {
    const normalized = (options.basePath ?? '').replace(/\/+$/, '')
    this.basePath = normalized === '' || normalized === '/api' ? '' : normalized
    this.forensics = options.forensics
    this.openSocket = options.openSocket ?? (() => new WebSocket(this.remoteStreamUrl()))
    this.waitForReconnect = options.waitForReconnect ?? false
  }



  /** Ensure a physical attempt exists, following the current attempt once if needed. */
  start(): void {
    if (this.disposed) return
    this.running = true
    if (this.socket?.readyState === 1) return
    const pending = this.keepAlive
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /** Cancel the current socket or retry wait and start a fresh attempt immediately. */
  reconnect(): void {
    if (!this.running || this.disposed) return
    this.forensics?.('socket-reconnect', 'reconnect requested by the connection lane')
    // A lane-commanded reconnect is its own decision cycle: the guard cannot suppress it.
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

  /** The single replacement path: the reducer gates it (a refusal still yields
   *  `reopenLogicalStream`); `cycle` allows one replacement per decision cycle. */
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
    // A closed/closing socket is not protected by the rebuild window: there is no
    // healthy carrier to preserve, and a lane reconnect must never be swallowed.
    if (this.socket === undefined || this.socket.readyState !== 1) {
      // The burst guard protects an IN-FLIGHT attempt: while CONNECTING the socket
      // is not published on `this.socket` yet, so the attempt itself (keepAlive) —
      // or its cancellable candidate — is the only honest signal. Reading the socket
      // here made the guard a no-op for the whole CONNECTING window.
      const attemptInFlight = this.keepAlive !== undefined || this.cancelCandidate !== undefined
      const now = Date.now()
      if (attemptInFlight && now - this.lastForcedRebuildAt < FORCED_REBUILD_MIN_INTERVAL_MS) return []
      this.lastForcedRebuildAt = now
      // A bypassed replacement is still a replacement: keep it visible in the
      // forensics trace even though it deliberately skips the reducer's ledger.
      this.forensics?.('carrier-rebuild-bypass', reason)
      this.replaceSocket(failure, closeReason)
      return []
    }
    const effects = this.observeCarrier({
      kind: 'rebuildRequested',
      at: Date.now(), // the reducer's window is a time window
      reason,
      streak,
      streamId,
      episodeId: streamId,
      // The frame delta is an OBSERVATION: the reducer owns whether it means a silent carrier.
      framesSinceSend,
    })
    const decided = effects.some((effect) => effect.e === 'rebuildCarrier')
    if (decided) this.replaceSocket(failure, closeReason)
    // A refusal is paired with `reopenLogicalStream`: no exitless spinner.
    this.applyRecoveryEffects(effects, failure)
    if (!decided && effects.some((effect) => effect.e === 'throttled')) {
      this.armThrottleRetry(failure, closeReason, reason, streamId, streak, framesSinceSend)
    }
    return effects
  }

  /**
   * A denied rebuild still must not leave a lane permanently pinned to a suspect
   * carrier. Arm ONE retry at the reducer's earliest legal time (window/in-flight
   * spacing), then give up until the socket is replaced: the next lane event is a
   * fresh decision, not a timer storm.
   */
  private armThrottleRetry(
    failure: RemoteStreamCarrierError,
    closeReason: string,
    reason: RebuildReason,
    streamId?: string,
    streak?: number,
    framesSinceSend?: number,
  ): void {
    if (this.throttleRetried || this.throttleTimer !== undefined) return
    if (!this.running || this.disposed) return
    const at = Date.now()
    if (!Number.isFinite(at)) return
    // The reducer owns the window math; this only schedules at the time it names.
    const earliest = earliestRebuildAt(this.carrierState, this.carrierEnv, at)
    if (!Number.isFinite(earliest)) return
    const retryAt = Math.max(at + THROTTLE_RETRY_FALLBACK_MS, earliest)
    this.throttleRetried = true
    // The frame observation must be FRESH at the window edge: frames that arrive while
    // the retry is parked prove the carrier is no longer silent, and reusing the
    // decision-time delta would rebuild a healthy socket as if nothing arrived.
    const framesAtArm = this.socketFrames
    const timer = setTimeout(() => {
      this.throttleTimer = undefined
      if (!this.running || this.disposed) return
      if (this.socket === undefined || this.socket.readyState !== 1) return
      this.forensics?.('carrier-throttle-expired', reason)
      const arrivedWhileParked = Math.max(0, this.socketFrames - framesAtArm)
      const freshFrames = framesSinceSend === undefined && arrivedWhileParked === 0
        ? undefined
        : (framesSinceSend ?? 0) + arrivedWhileParked
      this.requestCarrierRebuild(
        failure,
        `${closeReason} (throttle expiry)`,
        reason,
        this.nextDecisionCycle(),
        streamId,
        streak,
        freshFrames,
      )
    }, Math.max(0, retryAt - at))
    timer.unref?.()
    this.throttleTimer = timer
  }

  private clearThrottleTimer(): void {
    if (this.throttleTimer === undefined) return
    clearTimeout(this.throttleTimer)
    this.throttleTimer = undefined
  }

  /** Execute the reducer's typed effects; unknown ones are ignored so the package can
   *  add observability-only effects without breaking older executors. */
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
          this.forensics?.('carrier-rebuild', effect.reason)
          break
        case 'throttled':
          this.forensics?.('carrier-throttled', effect.reason)
          break
        default:
          break
      }
    }
  }

  /**
   * chamber patch: throw the CURRENT physical socket away and start a fresh attempt
   * at once, failing every logical stream with a carrier error so their retry lanes
   * re-issue on the replacement. `lost()` owns a socket that announced its own death;
   * this is the same teardown for one the fork decided is unusable while still OPEN
   * (the connection lane's reconnect, or the silent-socket escalation in `open()`).
   * `closeReason` is diagnostic, so the wire trace still names the caller.
   */
  private replaceSocket(failure: RemoteStreamCarrierError, closeReason: string): void {
    if (!this.running || this.disposed) return
    // Every replacement counts against the burst guard, including the reducer's
    // own: otherwise a sanctioned replace followed by a lane event could force a
    // second connect inside the 50ms window.
    this.lastForcedRebuildAt = Date.now()
    this.clearThrottleTimer()
    this.throttleRetried = false
    const pending = this.keepAlive
    this.revision++
    // A deliberate replacement restarts from the base cadence (the reconnect is the attempt).
    this.maintainIntervalMs = REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS
    // The replacement is a fresh decision: a latched attempt failure must not outlive it.
    this.failure = undefined
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
   * After an established socket is lost, answering Clients wait for Connection
   * to reconnect or for their signal to abort; passive Clients reject immediately.
   * An initial socket failure rejects both modes. The opening deadline is armed at
   * send and DISARMED the moment the opening item is delivered to this consumer:
   * transport delivery is the opening's success.
   * @param endpoint - Typert Remote stream endpoint.
   * @param payload - endpoint request encoded on the wire.
   * @param signal - cancellation for this logical stream.
   * @param uplink - the Client's items: each is sent as an `item` frame, its end as `end`; its `return()`
   * runs when the stream finishes, and its failure cancels the stream and fails the downlink.
   * @returns Host items until completion, cancellation, or failure.
   */
  async *open(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ): AsyncGenerator {
    signal.throwIfAborted()
    const streamId = randomUUID()
    // The vendor callback carries only a signal, so the stable token across the retry
    // lane is the request key (endpoint + payload digest); the reducer derives from it.
    const requestKey = streamOpeningKey(endpoint, payload)
    const sessionId = sessionIdOfPayload(payload)
    const inbox = new StreamInbox()
    // Publish this episode's release handle for the reducer's `reopenLogicalStream`.
    // A denied reopen is a carrier decision, so the episode's miss streak survives it.
    this.pendingOpens.set(streamId, (reason: unknown) => { inbox.fail(reason, true) })
    const stream: LogicalStream = { inbox, pump: undefined }
    let carrier: ConnectionWebSocket | undefined
    let opened = false
    let terminal = false
    // Set by the opening-item deadline, read by the finally block.
    let timedOut = false
    // Consecutive unanswered deadlines for this request-episode key: the escalation
    // threshold and the diagnostic wording read it; it never widens the next budget.
    let attemptStreak = 0
    let budgetMs = 0
    // Frames on the socket when THIS stream's open frame was sent; the finally block
    // and the opening deadline share this baseline.
    let framesAtSend = 0
    let sentAt = 0
    // The opening deadline is an ARMED TIMER from send until the opening item is
    // DELIVERED, not a race around the first next(): a lost opening frame leaves this
    // generator suspended at `yield`, where only a timer can still reach the failure.
    // The clock starts when the consumer's FIRST pull runs this body (an async generator
    // is lazy). A generated stream is primed by ClientStreamHandle at construction, so
    // calling the method already arms this deadline even if the holder never iterates;
    // only a raw caller that neither pulls nor disposes owns no deadline (registered
    // boundary), and the handle's dispose covers that case.
    // Opaque to this module: the scheduler's handle type is its own (unknown).
    let deadlineTimer: unknown
    const clearOpeningDeadline = (): void => {
      if (deadlineTimer === undefined) return
      DEADLINE_SCHEDULER.clearTimeout(deadlineTimer)
      deadlineTimer = undefined
    }
    /** One bounded opening fact carrying the endpoint, the attempt and the attribution. */
    const reportOpening = (kind: StreamForensicsKind, waitedMs: number, cause: string): void => {
      const detail: StreamForensicsDetail = {
        endpoint,
        streamId,
        waitedMs,
        ...(sessionId === undefined ? {} : { sessionId }),
      }
      this.forensics?.(kind, cause, detail)
    }
    const abort = (): void => {
      // A domain-driven generation restart is a carrier teardown: the episode keeps its
      // streak (only a consumer departure releases it).
      inbox.fail(signal.reason, signal.reason instanceof RemoteStreamGenerationRestart)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const socket = await this.waitForSocket(signal)
      signal.throwIfAborted()
      // chamber patch: a socket replaced or closing since `waitForSocket` resolved
      // would silently DISCARD the open frame (RFC 6455 throws only for CONNECTING;
      // CLOSING/CLOSED drops the payload), so the guard closes that interleaving
      // window right before the synchronous send.
      if (socket !== this.socket || socket.readyState !== 1) {
        // Even a refused send fails this stream's consumer with a carrier error -
        // nothing may leave the logical opening silently pending.
        const refusal = new RemoteStreamCarrierError(
          'api gateway: Remote stream socket was replaced before its open frame could be sent',
        )
        inbox.fail(refusal, true)
        throw refusal
      }
      carrier = socket
      this.streams.set(streamId, stream)
      this.send(socket, { type: 'open', streamId, endpoint, payload })
      opened = true
      if (uplink !== undefined) stream.pump = this.pumpUplink(socket, streamId, uplink, signal, inbox)
      // chamber patch: the Host MUST answer an open with its opening item, and nothing
      // below has a deadline, so a lost opening frame is indistinguishable from a silent
      // stream. Fail the INBOX (never the generation signal, which would settle the retry
      // lane terminally) so the paced reopen re-issues; that deadline fails the inbox.
      this.observeCarrier({ kind: 'streamOpened', at: Date.now(), streamId })
      const armed = this.observeCarrier({ kind: 'openingSent', at: Date.now(), streamId, requestKey })
      const deadline = armed.find((effect) => effect.e === 'armOpeningDeadline')
      if (deadline === undefined || deadline.e !== 'armOpeningDeadline') {
        throw new RemoteStreamCarrierError('api gateway: carrier reducer refused the opening deadline')
      }
      budgetMs = deadline.budgetMs
      attemptStreak = deadline.streak
      // Liveness baseline for the escalation below: `socketFrames` counts frames on the
      // CURRENT socket, so the subtraction answers "did anything arrive while pending".
      framesAtSend = this.socketFrames
      sentAt = Date.now()
      const deadlineCycle = this.nextDecisionCycle()
      // The deadline verdict. It runs from send time and reaches a stream whose opening
      // item never arrived; the escalating teardown is the reducer's decision, one per
      // decision cycle.
      const onOpeningExpire = (): void => {
        deadlineTimer = undefined
        if (!opened) return
        // A carrier teardown (socket replacement or loss) already failed this inbox: the
        // episode is on the retry lane, not unanswered, so an opening verdict here would
        // contradict the carrier error it carries (review finding 2).
        if (inbox.carrierInitiated) return
        timedOut = true
        const waitedMs = Date.now() - sentAt
        const openingFailure = new RemoteStreamCarrierError(
          `api gateway: Remote stream ${JSON.stringify(endpoint)} delivered no opening item within ${String(budgetMs)}ms`,
        )
        // ONE non-terminal diagnostic per expiry: the episode is failed and the retry lane
        // re-issues; the retired F1 verdict names (orphan / budget exhausted / accepted)
        // have no successor.
        reportOpening(
          'opening-timeout',
          waitedMs,
          `${endpoint} streamId=${streamId} waitedMs=${String(waitedMs)} streak=${String(attemptStreak)}`,
        )
        // TWO evidence paths, ONE teardown: zero frames on this socket across the whole
        // deadline window means the carrier itself is dead (re-issuing can never succeed),
        // while frames arriving for other streams but not this request means the retry lane
        // can only re-issue on the same generation. Both escalate through replaceSocket()
        // on the socket this attempt sent on (one verdict per decision cycle).
        if (socket === this.socket && socket.readyState === 1 && this.decisionCycle !== deadlineCycle) {
          this.decisionCycle = deadlineCycle
          // ONE event: the reducer advances the streak, derives the silent verdict and
          // gates the rebuild; the host only executes the effects.
          const effects = this.observeCarrier({
            kind: 'openingExpired',
            at: Date.now(),
            streamId,
            requestKey,
            framesSinceSend: this.socketFrames - framesAtSend,
          })
          const replacementFailure = new RemoteStreamCarrierError(
            'api gateway: Remote stream carrier rebuilt after an unanswered opening item',
          )
          // The timed-out stream keeps its own deadline error (it was failed first);
          // the sibling must see the REPLACEMENT, so `failAll` gets its own wording.
          inbox.fail(openingFailure)
          const rebuiltNow = effects.some((effect) => effect.e === 'rebuildCarrier')
          if (rebuiltNow) {
            this.replaceSocket(replacementFailure, 'opening stall')
          }
          this.applyRecoveryEffects(effects, replacementFailure)
          // A denied rebuild must not leave this lane pinned to a silent carrier:
          // the same ONE delayed replacement the lane-reconnect refusals arm applies
          // here too (design 27 §3.6 — every refusal gets the window-edge retry).
          if (!rebuiltNow && effects.some((effect) => effect.e === 'throttled')) {
            this.armThrottleRetry(
              replacementFailure,
              'opening stall',
              'openingStall',
              streamId,
              attemptStreak,
              this.socketFrames - framesAtSend,
            )
          }
          const rebuilt = effects.find((effect) => effect.e === 'rebuildCarrier')
          if (rebuilt !== undefined && rebuilt.e === 'rebuildCarrier') {
            if (rebuilt.reason === 'socketNoFrame') {
              this.forensics?.('socket-silent', `${endpoint} timed out with no frame delivered on the current socket`)
            } else {
              this.forensics?.(
                'opening-stall-escalation',
                `${endpoint} unanswered ${String(attemptStreak + 1)}x; rebuilding the physical carrier`,
              )
            }
          }
          return
        }
        // No usable socket to escalate on, but the opening still fails its consumer.
        inbox.fail(openingFailure)
      }
      // Arm the deadline at send time; the first DELIVERED item clears it (the episode
      // ending clears it too), so a stream that never sees its opening item cannot park.
      deadlineTimer = DEADLINE_SCHEDULER.setTimeout(onOpeningExpire, budgetMs)
      let openingSeen = false
      while (true) {
        const frame = await inbox.next()
        signal.throwIfAborted()
        if (frame.type === 'item') {
          if (!openingSeen) {
            openingSeen = true
            // DELIVERY is the opening's success: disarm the deadline BEFORE the consumer
            // sees the item, and tell the reducer to clear the request's miss streak.
            clearOpeningDeadline()
            this.observeCarrier({ kind: 'openingAnswered', at: Date.now(), streamId, requestKey })
          }
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
      clearOpeningDeadline()
      signal.removeEventListener('abort', abort)
      this.streams.delete(streamId)
      this.pendingOpens.delete(streamId)
      // chamber patch: the opening deadline is not the only place a silent carrier can
      // be proved — the journal watchdog aborts its probe before the opening deadline can
      // fire. A stream torn down without ever seeing a frame on its socket during a life
      // of at least SILENT_TEARDOWN_MIN_MS is the same evidence, so it escalates here; the
      // lifetime bound keeps a healthy but not-yet-answered socket safe, and `!timedOut`
      // keeps one verdict per stream.
      if (opened && !terminal && !timedOut
        && Date.now() - sentAt >= SILENT_TEARDOWN_MIN_MS
        && this.running && !this.disposed
        && carrier !== undefined && carrier === this.socket && carrier.readyState === 1) {
        // The frame delta is the observation; the reducer owns the verdict (a socket
        // that delivered can never be proven silent). A teardown is its own decision
        // cycle, so a lane reconnect in the same turn cannot double-replace one socket.
        const effects = this.requestCarrierRebuild(new RemoteStreamCarrierError(
          'api gateway: Remote stream socket delivered no frame for the whole life of a logical stream',
        ), 'silent socket replaced on teardown', 'teardownNoFrame', this.nextDecisionCycle(), streamId, undefined, this.socketFrames - framesAtSend)
        if (effects.some((effect) => effect.e === 'rebuildCarrier')) {
          this.forensics?.('socket-silent', endpoint + ' torn down with no frame delivered on the current socket')
        }
      }
      stream.pump?.stop()
      if (opened && !terminal && carrier?.readyState === 1) {
        this.send(carrier, { type: 'cancel', streamId })
      }
      // The old generation's pump has stopped before a supervisor reopens the next one.
      if (stream.pump !== undefined) await stream.pump.done
      // Close the episode LAST, after the teardown escalation could claim it. The two
      // fields tell the reducer which teardown this was: a carrier-ended or timed-out
      // episode keeps its miss streak for the retry lane; a consumer-ended one releases it.
      this.observeCarrier({
        kind: 'episodeClosed',
        at: Date.now(),
        episodeId: streamId,
        requestKey,
        timedOut,
        carrierInitiated: inbox.carrierInitiated,
      })
    }
  }

  /**
   * Send the caller's uplink items on this generation's socket. `stop()`
   * interrupts a pump blocked on `uplink.next()` and releases the iterator: a
   * handle's queue closes at once, so `send()` throws from then on, and any
   * other iterator's `return()` is invoked without being awaited because a
   * generator blocked in `next()` only completes it once it yields.
   */
  private pumpUplink(
    socket: ConnectionWebSocket,
    streamId: string,
    uplink: AsyncIterable<unknown>,
    signal: AbortSignal,
    inbox: StreamInbox,
  ): UplinkPump {
    let stopped: PromiseWithResolvers<IteratorReturnResult<undefined>> | undefined
    const interruption: IteratorReturnResult<undefined> = { value: undefined, done: true }
    const uplinkIterator = uplink[Symbol.asyncIterator]()
    const state = { stopping: false, exhausted: false, released: false }
    const release = (): void => {
      if (state.released || state.exhausted) return
      state.released = true
      if (uplink instanceof ClientUplinkQueue) uplink.close()
      void Promise.resolve().then(() => uplinkIterator.return?.()).catch(() => undefined)
    }
    const done = (async (): Promise<void> => {
      try {
        while (true) {
          const stoppingBeforeRead = state.stopping
          if (stoppingBeforeRead) return
          // A stop promise belongs to one read, not the whole uplink history.
          stopped = Promise.withResolvers<IteratorReturnResult<undefined>>()
          const next = await Promise.race([uplinkIterator.next(), stopped.promise])
          stopped = undefined
          if (state.stopping || next === interruption || signal.aborted || this.socket !== socket) return
          if (next.done === true) {
            state.exhausted = true
            break
          }
          this.send(socket, { type: 'item', streamId, value: next.value })
        }
        this.send(socket, { type: 'end', streamId })
      } catch (error) {
        inbox.fail(error)
      } finally {
        stopped = undefined
        release()
      }
    })()
    return {
      done,
      stop: () => {
        if (state.stopping) return
        state.stopping = true
        stopped?.resolve(interruption)
        release()
      },
    }
  }

  /**
   * Permanently stop the carrier, close the physical socket, and fail every
   * active logical stream.
   * @returns once the connection attempt and every physical socket have closed.
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
      this.clearThrottleTimer()
      // Disposing the client ends every episode, so the reducer state resets with it.
      this.carrierState = initialCarrierState()
      this.socketFrames = 0
      this.cancelCandidate?.(error)
      const socket = this.socket
      this.socket = undefined
      socket?.close(1000, 'disposed')
    }
    await this.keepAlive
    await Promise.all(this.socketClosures)
  }

  private async connect(): Promise<ConnectionWebSocket> {
    let socket: ConnectionWebSocket
    try {
      socket = this.openSocket(REMOTE_STREAM_MUX_PATH)
    } catch (error) {
      // A synchronous constructor throw (mixed content, invalid URL) must become an
      // ordinary carrier failure, or it would kill the heal timer silently.
      return Promise.reject(new RemoteStreamCarrierError(
        'api gateway: Remote stream WebSocket could not be constructed',
        { cause: error },
      ))
    }
    const closed = new Promise<void>((resolve) => { socket.addEventListener('close', () => { resolve() }, { once: true }) })
    this.socketClosures.add(closed)
    void closed.then(() => { this.socketClosures.delete(closed) })
    // Declared here because the deadline hook runs outside the executor.
    let expireHandshake: (() => void) | undefined
    const connecting = new Promise<ConnectionWebSocket>((resolve, reject) => {
      let settled = false
      const rejectCandidate = (error: Error): void => {
        settled = true
        socket.removeEventListener('open', opened)
        socket.removeEventListener('message', received)
        this.cancelCandidate = undefined
        // Node ws emits error when a connecting socket is closed. Keep its
        // error listener until close even after rejecting the attempt.
        if (socket.readyState < 2) socket.close()
        reject(error)
      }
      const opened = (): void => {
        settled = true
        this.cancelCandidate = undefined
        // chamber patch: an established socket resets the self-heal cadence.
        this.maintainIntervalMs = REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS
        this.stopHealTimer()
        this.clearThrottleTimer()
        this.throttleRetried = false
        this.socket = socket
        this.socketFrames = 0
        this.observeCarrier({ kind: 'carrierOpened', at: Date.now() })
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
        if (socket.readyState < 2) socket.close()
      }
      const closed = (): void => {
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('message', received)
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket closed before opening',
          ))
          return
        }
        this.lost(socket)
      }
      const received = (event: { readonly data: unknown }): void => { this.receive(socket, event.data) }
      this.cancelCandidate = rejectCandidate
      expireHandshake = (): void => {
        rejectCandidate(new RemoteStreamCarrierError(
          'api gateway: Remote stream WebSocket handshake timed out',
        ))
      }
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed)
      socket.addEventListener('message', received)
      socket.addEventListener('close', closed, { once: true })
    })
    // One bound: on expiry the hook rejects `connecting`, and the deadline branch
    // surfaces that rejection by awaiting the same promise.
    const raced = await withDeadline<ConnectionWebSocket | 'expired'>(connecting, {
      ms: HANDSHAKE_TIMEOUT_MS,
      onExpire: () => {
        expireHandshake?.()
        return 'expired' as const
      },
      scheduler: UNREF_SCHEDULER,
    })
    return raced.settled === 'deadline' ? await connecting : (raced.value as ConnectionWebSocket)
  }

  /** chamber patch: instance method so the mux route carries the per-entry base path ('' = stock
   * route). It deliberately ignores `__DSH_TRANSPORT__.streamBaseUrl`: the connection carrier owns
   * that resolution and production always passes `openSocket`, so this fallback is reachable from
   * tests or a carrier-less construction only. */
  private remoteStreamUrl(): string {
    const location = (globalThis as { location?: { origin?: string } }).location
    const base = location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
    const url = new URL(`${this.basePath}${REMOTE_STREAM_MUX_PATH}`, base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.href
  }

  private waitForSocket(signal: AbortSignal): Promise<ConnectionWebSocket> {
    signal.throwIfAborted()
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket)
    if (this.disposed) return Promise.reject(new Error('api gateway: Remote stream client disposed'))
    if (!this.running) return Promise.reject(new Error('api gateway: Remote stream client not started'))
    if (this.failure !== undefined) return Promise.reject(this.failure)
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
          // AbortSignal.reason may intentionally be a non-Error sentinel.
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(error)
        },
      }
      this.waiters.add(waiter)
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  private receive(socket: ConnectionWebSocket, data: unknown): void {
    if (socket !== this.socket) return
    try {
      if (typeof data !== 'string') throw new Error('api gateway: Remote stream WebSocket requires text messages')
      const frame = parseRemoteStreamServerMessage(data)
      // chamber patch: one liveness count per delivered frame — the silent-socket
      // escalation keys on it, never on the frame's content.
      this.socketFrames += 1
      this.observeCarrier({ kind: 'streamFrame', at: Date.now() })
      const stream = this.streams.get(frame.streamId)
      if (stream === undefined) return
      stream.inbox.push(frame)
      // A terminal frame ends the uplink now, not on the consumer's next read.
      if (frame.type !== 'item') stream.pump?.stop()
    } catch (error) {
      const failure = new RemoteStreamCarrierError('api gateway: invalid Remote stream frame', { cause: error })
      this.failAll(failure)
      this.lost(socket, failure)
      socket.close(4002, 'invalid Remote stream frame')
    }
  }

  private lost(
    socket: ConnectionWebSocket,
    error: RemoteStreamCarrierError = new RemoteStreamCarrierError(
      'api gateway: Remote stream WebSocket closed',
    ),
  ): void {
    if (this.socket !== socket) return
    this.socket = undefined
    this.socketFrames = 0
    this.observeCarrier({ kind: 'carrierClosed', at: Date.now() })
    this.forensics?.('socket-lost', error.message)
    if (!this.waitForReconnect) this.failure = error
    this.failAll(error)
    if (!this.waitForReconnect) {
      for (const waiter of [...this.waiters]) waiter.reject(error)
    }
    // chamber patch: the lane's generation source is the $events stream ON THIS MUX, so
    // waiting for the lane to notice a lost socket is circular whenever the loop is parked
    // (offline, between attempts) — self-heal here and RE-SCHEDULE, because one throttled
    // attempt is not enough. Also queued on the MICROTASK: a socket that opens and closes
    // in ONE task leaves `keepAlive` set, so the synchronous call arms nothing; the queued
    // call arms the missing timer or finds one already armed.
    this.scheduleMaintain()
    queueMicrotask(() => { this.scheduleMaintain() })
  }

  /**
   * chamber patch: maintain the mux's own reconnect without ever parking — maintain
   * now when the interval elapsed, otherwise arm exactly one timer for the remainder.
   * Failed attempts widen the interval in maintain()'s rejection path; a successful
   * open resets it.
   */
  private scheduleMaintain(): void {
    // chamber patch: autonomous re-scheduling is the ANSWERING leg's only; a passive
    // client keeps upstream's fail-fast on a lost socket (nothing waits for a rebuild).
    // Scope note: the opening-deadline / silent-teardown escalation above still replaces
    // a socket that provably delivered no frame in either mode — a silent socket is
    // indistinguishable from a lost one, and a passive caller only ever fails its own
    // streams (no lane depends on the rebuild). Registered as a deliberate asymmetry.
    if (!this.running || this.disposed || !this.waitForReconnect) return
    if (this.socket?.readyState === 1 || this.keepAlive !== undefined) return
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
    if (this.socket?.readyState === 1 || this.keepAlive !== undefined) return
    this.lastMaintainAt = Date.now()
    const revision = this.revision
    this.failure = undefined
    const task = this.connect().then(
      () => undefined,
      (error: unknown) => {
        if (!this.running) return
        const failure = error instanceof RemoteStreamCarrierError ? error
          : new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed to open', { cause: error })
        if (this.revision === revision) this.failure = failure
        for (const waiter of [...this.waiters]) {
          if (waiter.revision <= revision) waiter.reject(failure)
        }
        // chamber patch: one failed attempt must not end recovery — widen the interval
        // once per consecutive failure (capped at the lane's backoff ceiling), release
        // OUR in-flight guard (identity-checked) and schedule the next attempt here (this
        // handler consumes the rejection). Self-heal is the ANSWERING leg's only: a
        // passive client keeps upstream's fail-fast semantics.
        if (this.keepAlive === task) this.keepAlive = undefined
        if (this.waitForReconnect) {
          if (!(error instanceof RemoteStreamReconnectRequest)) {
            this.maintainIntervalMs = Math.min(this.maintainIntervalMs * 2, REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS)
            this.forensics?.(
              'socket-attempt-failed',
              'connect attempt failed; next attempt in ' + String(this.maintainIntervalMs) + 'ms',
            )
          }
          this.scheduleMaintain()
        }
      },
    )
    this.keepAlive = task
    void task.then(() => {
      if (this.keepAlive === task) this.keepAlive = undefined
    })
  }

  /** Fail every live logical stream: carrier-initiated, so an unanswered opening keeps
   *  its streak across the replacement instead of restarting its count. */
  private failAll(error: unknown): void {
    for (const stream of this.streams.values()) {
      stream.inbox.fail(error, true)
      stream.pump?.stop()
    }
  }

  private send(socket: ConnectionWebSocket, message: RemoteStreamClientMessage): void {
    socket.send(JSON.stringify(message))
  }
}

class StreamInbox {
  private readonly frames = new Deque<RemoteStreamServerMessage>()
  private wake: (() => void) | undefined
  private failure: Error | undefined
  /** A carrier teardown failed this inbox, so the opening streak survives it. */
  carrierInitiated = false

  push(frame: RemoteStreamServerMessage): void {
    if (this.failure !== undefined) return
    this.frames.pushBack(frame)
    this.wake?.()
    this.wake = undefined
  }

  fail(error: unknown, carrierInitiated = false): void {
    if (carrierInitiated) this.carrierInitiated = true
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

/**
 * Uplink items a stream handle queues for its carrier: the mux pump or the
 * in-process Host decoder iterates it as the stream's uplink. `end()` is the
 * Client half-close; `close()` marks the stream terminated, after which
 * `push()` throws. One consumer reads it, one read at a time.
 */
export class ClientUplinkQueue implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly items = new Deque<unknown>()
  private ended = false
  private closed = false
  private wake: (() => void) | undefined

  /** @param endpoint - canonical Remote endpoint named by failures. */
  constructor(private readonly endpoint: string) {}

  /**
   * Queue one item for the carrier.
   * @param item - item the Host validates against the method's uplink codec.
   * @throws {Error} after `end()` or once the stream has terminated.
   */
  push(item: unknown): void {
    if (this.closed) throw new Error(`client api: ${this.endpoint} stream has terminated`)
    if (this.ended) throw new Error(`client api: ${this.endpoint} uplink was ended`)
    this.items.pushBack(item)
    this.signal()
  }

  /** Half-close: the carrier reads the queued items, then `end`. Idempotent; ignored after termination. */
  end(): void {
    if (this.ended || this.closed) return
    this.ended = true
    this.signal()
  }

  /** The carrier stopped reading: the logical stream terminated or was disposed. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.items.clear()
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }

  /**
   * Take the next queued item, waiting for one; ends after `end()` or `close()`.
   * @returns the next item, or the end of the uplink.
   * @throws {Error} when a read is already pending.
   */
  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.closed) return UPLINK_DONE
      if (this.items.size > 0) return { value: this.items.popFront(), done: false }
      if (this.ended) return UPLINK_DONE
      if (this.wake !== undefined) throw new Error(`client api: ${this.endpoint} uplink has one pending read`)
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /**
   * The carrier is done with the uplink: close it.
   * @returns the end of the uplink.
   */
  return(): Promise<IteratorResult<unknown>> {
    this.close()
    return Promise.resolve(UPLINK_DONE)
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}
