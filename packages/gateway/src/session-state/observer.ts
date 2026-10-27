/**
 * gateway session-state observer: binds one mux to one store. Every baseline/edge/
 * pending fact becomes a store mutation, every true->false edge gets exactly one
 * bounded follow read, and the host gate is refreshed on every mux status change
 * (host-down = unknown, never a fabricated completion). Split out of session-state.ts
 * (B3-2); the four cadence limits it owns live here and are re-exported by the facade.
 */
import {
  DEFAULT_BASELINE_TIMEOUT_MS, DEFAULT_FOLLOW_TIMEOUT_MS, DEFAULT_MUX_RECONNECT_MAX_MS,
  DEFAULT_MUX_RECONNECT_MIN_MS, DEFAULT_WATERFALL_GRACE_MS, SESSION_LIST_MAX_RESPONSE_BYTES,
  SESSION_LIST_PAYLOAD, authCookieFor, call as controlPlaneCall, createSessionMux, parseSessionListBaselineItems,
  type MuxKickReason, type MuxUnaryCall, type SessionListBaselineItem, type SessionMuxStatus,
  type SessionStateHostInfo, type SessionStateHostState, type SessionTurnEnd,
} from '@dsh-chamber/control-plane'

import type {
  CompletionEdge, SessionStateObserver, SessionStateObserverDeps, SessionStateObserverStatus,
} from '../session-state-types.ts'
/** Event-silence window handed to the mux (R21); the mux resubscribes. */
export const DEFAULT_EVENT_SILENCE_MS = 45_000
/** Periodic full baseline in sse mode (correctness component). */
export const DEFAULT_RECONCILE_MS = 60_000
/** Baseline cadence while the live event stream is unavailable (poll mode). */
export const DEFAULT_POLL_MS = 15_000
export const DEFAULT_TICK_MS = 5_000
/**
 * Bind one mux to one store: every baseline/edge/pending fact becomes a store
 * mutation, every true->false edge gets exactly one follow read, and the host
 * gate is refreshed on every mux status change (host-down = unknown, never a
 * fabricated completion).
 */
export function createSessionStateObserver(deps: SessionStateObserverDeps): SessionStateObserver {
  const store = deps.store
  const now = deps.now ?? (() => Date.now())
  const call: MuxUnaryCall = deps.call ?? (controlPlaneCall as unknown as MuxUnaryCall)
  const reconcileMs = deps.reconcileMs ?? DEFAULT_RECONCILE_MS
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS
  const baselineTimeoutMs = deps.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS
  const pendingEvents = new Map<string, string>()

  /**
   * 行退役时按 sessionId 清配对（与 renderer `source-mux-facts.pendingWaterfalls` 同规）：
   * 行已不在，过期 eventId 的 cancel 只应被忽略——留着的配对既让 map 无界增长，又可能在
   * 同 id 重建后清掉**新**待决位（旧 eventId 的迟到 cancel 命中新行）。两条退役路径都必须
   * 清：显式 remove（`applyRemoved`）与基线缺席单阶段删除（`applyBaseline` 的 absent 集）。
   * 已知边界：行上限淘汰（`enforceLimits`，>MAX_SESSIONS，loud 记账）发生在本观察者之外，
   * 该极端形状下配对可残留到下一次基线对账；不引入第二套行生命周期钩子。
   */
  function releasePendingEventsFor(sessionId: string): void {
    for (const [eventId, paired] of pendingEvents) {
      if (paired === sessionId) pendingEvents.delete(eventId)
    }
  }

  /** 基线缺席 = store 已单阶段删除该行 ⇒ 配对随行退役（缺席集与 store 的删除集同源）。 */
  function releasePendingEventsAbsentFrom(items: readonly SessionListBaselineItem[]): void {
    if (pendingEvents.size === 0) return
    const present = new Set(items.map(item => item.sessionId))
    for (const [eventId, sessionId] of pendingEvents) {
      if (!present.has(sessionId)) pendingEvents.delete(eventId)
    }
  }
  let degraded = false
  let lastError: string | null = null
  let followReads = 0
  let followFailures = 0
  let started = false
  let lastHostServiceable = false
  let kicking = false
  let ticker: ReturnType<typeof setInterval> | null = null
  let lastPollBaselineAt = 0
  let pollInFlight: Promise<void> | null = null

  function refreshHost(): void {
    const state: SessionStateHostState = started ? deps.getHostState() : 'stopped'
    const serviceable = started && deps.getBaseUrl() !== null && (state === 'ready' || state === 'degraded')
    // Latch BEFORE the kick and never re-enter it: mux.kick may synchronously
    // emit a status change that re-enters refreshHost (publishes 'connecting'
    // before its socket exists), which would open a second socket.
    const wasServiceable = lastHostServiceable
    lastHostServiceable = serviceable
    store.setHost({ state, serviceable })
    if (serviceable && !wasServiceable && !kicking && mux.status().state !== 'connecting') {
      kicking = true
      try {
        mux.kick('host-ready')
      } finally {
        kicking = false
      }
    }
  }

  // Ready-edge latch: EITHER transition of `ready` is a $events generation
  // boundary (false -> true: first ready, reconnect, R21 resubscribe; true ->
  // false: socket death, host end/error, handshake timeout). Emit-type frames
  // have no replay, so the process-local activation learned from them is not
  // trustworthy across either edge.
  let lastReady = false
  function refreshMode(): void {
    if (!started) return
    const status = mux.status()
    // ANY ready transition opens a NEW $events generation (first ready,
    // reconnect, R21 resubscribe) — and equally closes one (socket death,
    // host end/error, handshake timeout). Emit-type frames have no replay, so
    // the process-local activation learned from them is not trustworthy on
    // EITHER side of the edge: on false -> true the gap invalidates it, and on
    // true -> false the poll window that follows serves stale armed/disarmed
    // values from the dead generation (suppressing/prematurely flushing the
    // renderer's armed semantics). Withdraw on every transition.
    if (status.ready !== lastReady) store.clearGoalActivations(now())
    lastReady = status.ready
    store.setMode(status.ready ? 'sse' : 'poll')
  }

  function applyBaseline(items: readonly SessionListBaselineItem[], at: number, canClassify: boolean): void {
    const edges = store.applyBaseline(items, { at })
    // 同一份权威列表：缺席行已被 store 单阶段删除，其 waterfall 配对同拍退役（见 helper）。
    releasePendingEventsAbsentFrom(items)
    refreshHost()
    // Poll mode has no follow carrier: an unreadable tail there would fabricate
    // unread on every user stop, so offline edges degrade to unknown, not armed.
    if (!canClassify) {
      if (edges.length > 0) degraded = true
      return
    }
    for (const edge of edges) void probeCompletion(edge)
  }

  /**
   * Poll-mode baseline: the mux reconciles only on a ready $events frame, so while
   * the event stream is unavailable the observer owns the unary session/list cadence.
   * Edges are NOT classified here (see applyBaseline).
   */
  async function pollBaseline(): Promise<void> {
    if (pollInFlight !== null) return pollInFlight
    const baseUrl = deps.getBaseUrl()
    if (baseUrl === null) return
    lastPollBaselineAt = now()
    pollInFlight = (async () => {
      try {
        const response = await call(baseUrl, 'session/list', SESSION_LIST_PAYLOAD, {
          timeoutMs: baselineTimeoutMs,
          maxResponseBytes: SESSION_LIST_MAX_RESPONSE_BYTES,
        })
        if (response.result.ok !== true) {
          throw new Error('session/list failed: ' + (response.result.error?.code ?? 'unknown'))
        }
        const items = parseSessionListBaselineItems(response.result.value)
        if (items === null) throw new Error('session/list returned a malformed baseline')
        applyBaseline(items, now(), false)
      } catch (error) {
        onBaselineError(error, now())
      } finally {
        pollInFlight = null
      }
    })()
    return pollInFlight
  }

  function onTick(): void {
    if (!started) return
    const muxStatus = mux.status()
    if (muxStatus.ready) {
      // Periodic reconciliation is a correctness component: forwarded emit events have no retransmission.
      if (now() - (muxStatus.lastBaselineAt ?? 0) >= reconcileMs) mux.kick('tick')
      return
    }
    if (deps.getBaseUrl() === null) return
    if (now() - lastPollBaselineAt >= pollMs) void pollBaseline()
  }

  function onBaselineError(error: unknown, at: number): void {
    void at
    degraded = true
    lastError = error instanceof Error ? error.message : String(error)
    store.setHost({ state: 'unknown', serviceable: false })
  }

  function onStatus(sessionId: string, running: boolean, at: number): void {
    const edges = store.applyStatus(sessionId, running, at)
    for (const edge of edges) void probeCompletion(edge)
  }

  const readingEdges = new Set<CompletionEdge>()

  async function probeCompletion(edge: CompletionEdge): Promise<void> {
    if (readingEdges.has(edge)) return
    readingEdges.add(edge)
    followReads += 1
    let turnEnd: SessionTurnEnd | null = null
    try {
      turnEnd = await mux.followTurnEndOnce(edge.sessionId)
    } catch {
      turnEnd = null
    } finally {
      readingEdges.delete(edge)
    }
    const unreadable = turnEnd === null
    if (unreadable) {
      followFailures += 1
      degraded = true
    }
    store.settleCompletion(edge, { at: now(), turnEnd, unreadable })
  }

  const mux = deps.mux ?? createSessionMux({
    getBaseUrl: deps.getBaseUrl,
    authCookieFor,
    call: deps.call,
    openSocket: deps.openSocket,
    otherMuxClientsAttached: deps.otherMuxClientsAttached,
    onBaseline: (items, info) => { applyBaseline(items, info.at, true) },
    onBaselineError: (error, at) => { onBaselineError(error, at) },
    onStatus: (sessionId, running, at) => { onStatus(sessionId, running, at) },
    onActivity: (sessionId, updatedAt, at) => { store.applyActivity(sessionId, updatedAt, at) },
    onAdded: (item, at) => { store.applyAdded(item, at) },
    onRemoved: (sessionId, at) => {
      store.applyRemoved(sessionId, at)
      releasePendingEventsFor(sessionId)
    },
    onGoalActivation: (event) => {
      store.applyGoalActivation(event, now())
    },
    onPending: (sessionId, kind, eventId, at) => {
      pendingEvents.set(eventId, sessionId)
      store.applyPending(sessionId, kind, at)
    },
    onCancel: (eventId, at) => {
      const sessionId = pendingEvents.get(eventId)
      pendingEvents.delete(eventId)
      if (sessionId !== undefined) store.clearPending(sessionId, at)
    },
    onStatusChange: () => { refreshMode(); refreshHost() },
    onSilence: () => { degraded = true },
    onWarn: (message) => { deps.logger.warn('gateway session-state: ' + message) },
    now,
    waterfallGraceMs: deps.waterfallGraceMs ?? DEFAULT_WATERFALL_GRACE_MS,
    reconnectMinMs: deps.reconnectMinMs ?? DEFAULT_MUX_RECONNECT_MIN_MS,
    reconnectMaxMs: deps.reconnectMaxMs ?? DEFAULT_MUX_RECONNECT_MAX_MS,
    followTimeoutMs: DEFAULT_FOLLOW_TIMEOUT_MS,
    silenceTimeoutMs: deps.silenceTimeoutMs ?? DEFAULT_EVENT_SILENCE_MS,
  })

  return {
    start(): void {
      if (started) return
      started = true
      store.setMode('poll')
      refreshHost()
      mux.start()
      refreshMode()
      if (ticker === null) {
        ticker = setInterval(onTick, tickMs)
        ticker.unref?.()
      }
    },

    stop(): void {
      if (ticker !== null) {
        clearInterval(ticker)
        ticker = null
      }
      if (!started) {
        refreshHost()
        return
      }
      started = false
      mux.stop()
      for (const [eventId, sessionId] of pendingEvents) {
        pendingEvents.delete(eventId)
        store.clearPending(sessionId, now())
      }
      refreshHost()
    },

    kick(reason: MuxKickReason): void {
      if (!started) return
      mux.kick(reason)
      refreshMode()
      // A host-ready kick may find the event stream still unavailable; baseline once instead of waiting a tick.
      if (reason === 'host-ready' && !mux.status().ready) void pollBaseline()
    },

    status(): SessionStateObserverStatus {
      const muxStatus: SessionMuxStatus = mux.status()
      return {
        mode: muxStatus.ready ? 'sse' : store.mode() === 'off' ? 'off' : 'poll',
        ready: muxStatus.ready,
        baselineAt: muxStatus.lastBaselineAt,
        lastEventAt: muxStatus.lastEventAt,
        eventsReceived: muxStatus.eventsReceived,
        muxBaselines: muxStatus.baselines,
        reconnects: muxStatus.reconnects,
        lastError: muxStatus.lastError ?? lastError,
        degraded: degraded || muxStatus.eventsDegraded,
        heldWaterfalls: muxStatus.heldWaterfalls,
        followReads,
        followFailures,
        clientId: muxStatus.clientId,
      }
    },

    hostInfo(): SessionStateHostInfo {
      return {
        now: now(),
        serviceable: started && lastHostServiceable,
        state: started ? deps.getHostState() : 'stopped',
      }
    },
  }
}
