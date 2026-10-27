/**
 * Shared gateway session-state types: the store/observer/chamber contracts every
 * module of the split imports. Types only — no runtime code, so this leaf never
 * creates an import cycle with the factories that implement it.
 */
import type {
  ApiRequest, ApiResponse, Logger, MuxKickReason, SessionListBaselineItem,
  SessionMux, SessionStateDelta, SessionStateGoalActivationEvent, SessionStateHostInfo,
  SessionStateHostState, SessionStateMode, SessionStatePendingKind, SessionStateSnapshot,
  SessionStateCompletedAtSource, SessionTurnEnd, createSessionMux,
} from '@dsh-chamber/control-plane'
/** One completion edge requiring exactly one follow read. source='observed' is a
 *  live true->false edge in this observer epoch; 'reconstructed' is a post-restart recovery. */
export interface CompletionEdge {
  sessionId: string
  source: SessionStateCompletedAtSource
}

/** Store diagnostics for logs/routes (never part of the wire rows). */
export interface SessionStateStoreStatus {
  integrity: 'ok' | 'recovered' | 'corrupt'
  recoveryDetail: string | null
  loaded: boolean
  persistedAt: number | null
  cursor: number
  sessions: number
  dropped: { sessions: number; goalActivations: number }
  /** 已结算完成边沿的 turn/end 分类构成（unreadable = 降级武装）。 */
  turnEnds: { completed: number; userStopped: number; neutral: number; unreadable: number }
  /** 本进程成功应用的「成功且完整」基线数（含 poll 档）：wire diagnostics.baselines 的唯一来源。 */
  baselines: number
}

export interface SessionStateStoreDeps {
  stateDir: string
  logger: Logger
  now?: () => number
}

export interface SessionStateStore {
  status(): SessionStateStoreStatus
  host(): SessionStateHostInfo
  setHost(input: { state: SessionStateHostState; serviceable: boolean }): boolean
  mode(): SessionStateMode
  setMode(mode: SessionStateMode): boolean
  /** Full baseline merge. Returns new edges and pending unreadable edges to classify. */
  applyBaseline(items: readonly SessionListBaselineItem[], opts: { at: number }): CompletionEdge[]
  applyStatus(sessionId: string, running: boolean, at: number): CompletionEdge[]
  applyActivity(sessionId: string, updatedAt: number | null, at: number): boolean
  applyAdded(item: SessionListBaselineItem, at: number): boolean
  applyRemoved(sessionId: string, at: number): boolean
  /** Forwarded `goal/activation-changed` edge, bound to its exact goal id
   *  ({@link SessionStateGoalActivationEvent}). A bound edge whose id does not
   *  match the row's projected goal is retained until a baseline/added carries
   *  the matching identity; an `activation: null` edge resolves a known fact
   *  to explicit no-goal. Process-local only — never persisted. */
  applyGoalActivation(event: SessionStateGoalActivationEvent, at: number): boolean
  /** Drop every process-local activation back to unknown (a fresh `$events`
   *  ready after a gap: emit frames have no replay), including retained edges
   *  that have not found their projection yet. */
  clearGoalActivations(at: number): boolean
  applyPending(sessionId: string, kind: SessionStatePendingKind, at: number): boolean
  clearPending(sessionId: string, at: number): boolean
  /** Settle only the still-current completion edge after a bounded follow read. */
  settleCompletion(edge: CompletionEdge, input: {
    at: number
    turnEnd: SessionTurnEnd | null
    unreadable: boolean
  }): boolean
  snapshotFor(mode: SessionStateMode, host: SessionStateHostInfo): SessionStateSnapshot
  subscribe(listener: (delta: SessionStateDelta) => void): () => void
  /** Ring replay after Last-Event-ID; null = cannot satisfy (client refetches). */
  replayFrom(sinceCursor: number): SessionStateDelta[] | null
  flush(): Promise<void>
  dispose(): void
}

export interface SessionStateObserverStatus {
  mode: SessionStateMode
  ready: boolean
  baselineAt: number | null
  lastEventAt: number | null
  /** 下行帧计数与基线次数（丢帧/对账可见，不靠沉默推断）。 */
  eventsReceived: number
  /** mux **自己**的成功基线计数（观察者自诊断）；**不是** wire diagnostics.baselines 的来源
   *  ——wire 的 listComplete 闩锁读 store 的完整基线计数（含 poll 档），mux 计数不参与。 */
  muxBaselines: number
  reconnects: number
  lastError: string | null
  degraded: boolean
  heldWaterfalls: number
  followReads: number
  followFailures: number
  clientId: string | null
}

export interface SessionStateObserverDeps {
  logger: Logger
  store: SessionStateStore
  /** Host origin when the local dsh may be observed (exposed + ready/degraded); null disables baselines. */
  getBaseUrl(): string | null
  /** Normalized plane connection state for the host projection. */
  getHostState(): SessionStateHostState
  /** Another downstream mux client is attached (the waterfall delegate gate). */
  otherMuxClientsAttached(): boolean
  /** Replace the whole mux (the real one is createSessionMux). */
  mux?: SessionMux
  call?: Parameters<typeof createSessionMux>[0]['call']
  openSocket?: Parameters<typeof createSessionMux>[0]['openSocket']
  now?: () => number
  waterfallGraceMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  /** Event-silence window handed to the mux; the mux resubscribes and re-baselines. */
  silenceTimeoutMs?: number
  /** Periodic reconcile interval in sse mode (default 60s). */
  reconcileMs?: number
  /** Baseline interval while the event stream is unavailable (default 15s). */
  pollMs?: number
  /** Observer tick granularity (default 5s; test seam). */
  tickMs?: number
  /** Unary baseline deadline. */
  baselineTimeoutMs?: number
}

export interface SessionStateObserver {
  start(): void
  stop(): void
  kick(reason: MuxKickReason): void
  status(): SessionStateObserverStatus
  hostInfo(): SessionStateHostInfo
}

export interface ChamberSessionState {
  handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean>
  closeAllStreams(): void
}

export interface ChamberSessionStateDeps {
  logger: Logger
  store: SessionStateStore
  observer: Pick<SessionStateObserver, 'status' | 'hostInfo'>
  /** Source-level off switch: every route answers 503 session_state_disabled. */
  enabled: boolean
  maxStreams?: number
  keepaliveMs?: number
}
