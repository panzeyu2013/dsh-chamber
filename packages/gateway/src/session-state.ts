/**
 * Gateway-side session-state watcher: a READ-ONLY mirror of dsh session facts
 * over the control-plane mux client: per-session state machine with a monotonic
 * cursor, one snapshot at <stateDir>/session-state/state.json, and the four
 * /chamber/session-state routes inside the /chamber/* auth gate.
 *
 * It never writes to dsh, never answers a waterfall on its own (the mux holds the
 * frame until ANOTHER downstream client attaches AND the grace elapses), and never
 * stores title/cwd/message/approval payloads. A completion = the status true->false
 * edge plus ONE follow read of turn/end.reason: completed arms completedAt, an
 * unreadable tail still arms with lastTurnEnd null as the degraded marker, and
 * restart-recovered rows arm completedAtSource='reconstructed'; snapshots persist on a
 * 1s debounce/shutdown/flush in a bounded delta ring that a restart invalidates (no JSONL). */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  DEFAULT_BASELINE_TIMEOUT_MS,
  DEFAULT_FOLLOW_TIMEOUT_MS,
  DEFAULT_MUX_RECONNECT_MAX_MS,
  DEFAULT_MUX_RECONNECT_MIN_MS,
  DEFAULT_WATERFALL_GRACE_MS,
  SESSION_LIST_MAX_RESPONSE_BYTES,
  SESSION_LIST_PAYLOAD,
  SESSION_STATE_CLIENT_ID_PATTERN,
  SESSION_STATE_FEATURES,
  SESSION_STATE_PATH,
  SESSION_STATE_PROTOCOL_VERSION,
  SESSION_STATE_READ_ALL_PATH,
  SESSION_STATE_READ_BODY_MAX_BYTES,
  SESSION_STATE_READ_PATH,
  SESSION_STATE_SESSION_ID_MAX_CHARS,
  SESSION_STATE_STREAM_PATH,
  authCookieFor,
  call as controlPlaneCall,
  clampReadThrough,
  classifyTurnEnd,
  createJsonStore,
  createSessionMux,
  ensurePrivateDirectoryNoFollow,
  mergeReadMark,
  parseSessionListBaselineItems,
  type ApiRequest,
  type ApiResponse,
  type JsonStore,
  type Logger,
  type MuxKickReason,
  type MuxUnaryCall,
  type SessionListBaselineItem,
  type SessionMux,
  type SessionMuxStatus,
  type SessionStateCompletedAtSource,
  type SessionStateDelta,
  type SessionStateFeature,
  type SessionStateGoalActivation,
  type SessionStateGoalActivationEvent,
  type SessionStateGoalFact,
  type SessionStateHostInfo,
  type SessionStateHostState,
  type SessionStateMode,
  type SessionStatePendingKind,
  type SessionStateReadState,
  type SessionStateRow,
  type SessionStateSnapshot,
  type SessionTurnEnd,
  type ReadAllRequest,
  type ReadRequest,
} from '@dsh-chamber/control-plane'
import { jsonResponse, readBoundedBody } from './http-utils.ts'

// Gateway-owned limits; protocol constants are imported, never re-declared.

export const SESSION_STATE_DIR_NAME = 'session-state'
export const SESSION_STATE_FILE_NAME = 'state.json'
export const SESSION_STATE_SCHEMA_VERSION = 1
/** Hard row cap; the excess is evicted by observedAt and counted in dropped. */
export const MAX_SESSIONS = 2_000
/**
 * Cap of process-local retained goal-activation edges (P2a). A host can emit
 * edges for session ids no projection ever carries, so the map must stay
 * bounded: eviction is oldest-first and counted in `dropped.goalActivations`.
 */
export const MAX_PENDING_GOAL_ACTIVATIONS = MAX_SESSIONS
export const MAX_READ_CLIENTS = 64
export const MAX_MARKS_PER_CLIENT = 5_000
/** Read-mark client TTL (old marks are cleaned by the server). */
export const READ_MARK_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** In-memory SSE resume window (deltas, not bytes). */
export const SSE_RING_MAX = 1_024
/** Concurrent SSE streams per surface. */
export const MAX_SSE_STREAMS = 32
/** Queued frames for one backpressured SSE stream. */
export const MAX_SSE_PENDING_FRAMES = 32
/** SSE keepalive cadence. */
export const SSE_KEEPALIVE_MS = 20_000
export const PERSIST_DEBOUNCE_MS = 1_000
/** Event-silence window handed to the mux (R21); the mux resubscribes. */
export const DEFAULT_EVENT_SILENCE_MS = 45_000
/** Periodic full baseline in sse mode (correctness component). */
export const DEFAULT_RECONCILE_MS = 60_000
/** Baseline cadence while the live event stream is unavailable (poll mode). */
export const DEFAULT_POLL_MS = 15_000
export const DEFAULT_TICK_MS = 5_000

const SESSION_STATE_DIR_MODE = 0o700
const SESSION_STATE_FILE_MODE = 0o600

/** Features unavailable without the live $events subscription (the per-mode descriptor tells the truth). */
const EVENT_ONLY_FEATURES: ReadonlySet<SessionStateFeature> = new Set<SessionStateFeature>([
  'session-state.dsh-events',
  'session-state.pending-graph',
])

/** Features advertised for one runtime mode. */
export function featuresForMode(mode: SessionStateMode): readonly SessionStateFeature[] {
  if (mode === 'off') return []
  if (mode === 'sse') return SESSION_STATE_FEATURES
  return SESSION_STATE_FEATURES.filter(feature => !EVENT_ONLY_FEATURES.has(feature))
}

/** Map the plane connectionState string onto the frozen host-state union. */
export function normalizeHostState(state: string): SessionStateHostState {
  switch (state) {
    case 'ready':
    case 'degraded':
    case 'starting':
    case 'stopped':
    case 'error':
    case 'restart-exhausted':
    case 'quarantined':
      return state
    default:
      return 'unknown'
  }
}


/** One completion edge requiring exactly one follow read. source='observed' is a
 *  live true->false edge in this observer epoch; 'reconstructed' is a post-restart recovery. */
export interface CompletionEdge {
  sessionId: string
  source: SessionStateCompletedAtSource
}

/** Internal row = wire row + persistence/observer-only fields (toWireRow projects it; nothing sensitive is added). */
interface StoredRow {
  sessionId: string
  running: boolean
  lastRunningAt: number | null
  updatedAt: number
  completedAt: number | null
  completedAtSource: SessionStateCompletedAtSource | null
  lastTurnEnd: SessionTurnEnd | null
  pendingKind: SessionStatePendingKind | null
  pendingSince: number | null
  subagentCount: number
  /** Last complete baseline contained this id. */
  present: boolean
  /** An api-session/error was seen (boolean only - never the message). */
  error: boolean
  observedAt: number
  /** Baseline bookkeeping for the parent/origin subagent count. */
  parentSessionId: string | null
  origin: 'subagent' | null
  /**
   * Projected goal fact (P2a). `undefined` = the projection key was never
   * observed (unknown); `null` = the host explicitly reports no goal; an
   * object = the current goal. `activation` inside it is PROCESS-LOCAL and is
   * stripped before persistence, so a restart clears it back to unknown.
   */
  goal?: SessionStateGoalFact | null
}

/** Per-client read marks (stored per client, judged source-wide). */
interface StoredReadClient {
  at: number
  marks: Map<string, { readThrough: number; at: number }>
}

/** Persisted host gate (the wire projection adds the current clock). */
interface StoredHost {
  state: SessionStateHostState
  serviceable: boolean
  since: number
  lastBaselineAt: number | null
  baselineOk: boolean
}

/** The persisted document (createJsonStore free-form domain doc). */
export interface SessionStateDocument {
  schemaVersion: number
  revision: number
  cursor: number
  watcherEpoch: string
  mode: SessionStateMode
  host: StoredHost
  sessions: StoredRow[]
  readMarks: Record<string, { at: number; marks: Record<string, { readThrough: number; at: number }> }>
  readFloor: number
  dropped: { sessions: number; readClients: number; readMarks: number; goalActivations: number }
  [key: string]: unknown
}

/** Store diagnostics for logs/routes (never part of the wire rows). */
export interface SessionStateStoreStatus {
  integrity: 'ok' | 'recovered' | 'corrupt'
  recoveryDetail: string | null
  loaded: boolean
  persistedAt: number | null
  cursor: number
  sessions: number
  readClients: number
  dropped: { sessions: number; readClients: number; readMarks: number; goalActivations: number }
  /** 已结算完成边沿的 turn/end 分类构成（unreadable = 降级武装）。 */
  turnEnds: { completed: number; userStopped: number; neutral: number; unreadable: number }
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
  /** Full baseline merge. Returns the true->false edges requiring classification. */
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
  /** Settle one completion edge after its single follow read. */
  settleCompletion(sessionId: string, input: {
    at: number
    turnEnd: SessionTurnEnd | null
    source: SessionStateCompletedAtSource
    unreadable: boolean
  }): boolean
  markRead(clientId: string, sessionId: string, readThrough: number, at: number): { changed: boolean; stored: boolean; readThrough: number }
  markAllRead(clientId: string, through: number, at: number): { changed: boolean; through: number; updated: number }
  readStateFor(clientId: string | null): SessionStateReadState
  snapshotFor(clientId: string | null, mode: SessionStateMode, host: SessionStateHostInfo): SessionStateSnapshot
  subscribe(listener: (delta: SessionStateDelta) => void): () => void
  /** Ring replay after Last-Event-ID; null = cannot satisfy (client refetches). */
  replayFrom(sinceCursor: number): SessionStateDelta[] | null
  flush(): Promise<void>
  dispose(): void
}

function isWatermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Whitelisted clone of one goal fact. Only the five contract fields can
 *  survive, so a smuggled `objective`/`blockedReason` (or any future host
 *  field) can never reach the wire or the persisted document. */
function cloneGoalFact(goal: SessionStateGoalFact): SessionStateGoalFact {
  const fact: SessionStateGoalFact = { goalId: goal.goalId, revision: goal.revision, phase: goal.phase }
  if (goal.updatedAt !== undefined) fact.updatedAt = goal.updatedAt
  if (goal.activation !== undefined) fact.activation = goal.activation
  return fact
}

/** Persisted projection of one goal fact: `activation` is process-local and
 *  must never reach the snapshot document (v5 §6 P2a: a restart clears it back
 *  to unknown). */
function persistedGoalFact(goal: SessionStateGoalFact): SessionStateGoalFact {
  const fact: SessionStateGoalFact = { goalId: goal.goalId, revision: goal.revision, phase: goal.phase }
  if (goal.updatedAt !== undefined) fact.updatedAt = goal.updatedAt
  return fact
}

/** Exact equality of two goal facts (undefined/null are distinct values). */
function sameGoalFact(
  left: SessionStateGoalFact | null | undefined,
  right: SessionStateGoalFact | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return left === right
  return left.goalId === right.goalId
    && left.revision === right.revision
    && left.phase === right.phase
    && left.updatedAt === right.updatedAt
    && left.activation === right.activation
}

/**
 * Merge one baseline/add goal fact into a row.
 *  - absent (`undefined`) keeps the last known fact: a missing projection key
 *    is unknown and must never overwrite knowledge with ignorance;
 *  - `null` clears the fact (the host explicitly reports no goal);
 *  - an object refreshes identity/phase/watermark while PRESERVING the
 *    process-local activation when the goalId is unchanged (the baseline never
 *    carries activation; overwriting would erase what the event taught us).
 * @returns whether the stored fact changed (delta emission input).
 */
function mergeGoalFact(row: StoredRow, goal: SessionStateGoalFact | null | undefined): boolean {
  if (goal === undefined) return false
  const previous = row.goal
  if (goal === null) {
    if (previous === null) return false
    row.goal = null
    return true
  }
  const activation = previous !== undefined && previous !== null && previous.goalId === goal.goalId
    ? previous.activation
    : undefined
  const next = cloneGoalFact(goal)
  if (activation !== undefined) next.activation = activation
  if (sameGoalFact(previous, next)) return false
  row.goal = next
  return true
}

/** Wire projection of one internal row (exact frozen field set/order; `goal`
 *  is a post-freeze additive field and stays ABSENT while unknown). */
function toWireRow(row: StoredRow): SessionStateRow {
  return {
    sessionId: row.sessionId,
    running: row.running,
    pendingKind: row.pendingKind,
    subagentCount: row.subagentCount,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    completedAtSource: row.completedAtSource,
    lastRunningAt: row.lastRunningAt,
    lastTurnEnd: row.lastTurnEnd,
    ...(row.goal === undefined
      ? {}
      : { goal: row.goal === null ? null : cloneGoalFact(row.goal) }),
    // 这一行事实的观察时刻（观察者时钟，host 域）。
    factAt: row.observedAt,
  }
}

function createStoredRow(sessionId: string, at: number): StoredRow {
  return {
    sessionId,
    running: false,
    lastRunningAt: null,
    updatedAt: 0,
    completedAt: null,
    completedAtSource: null,
    lastTurnEnd: null,
    pendingKind: null,
    pendingSince: null,
    subagentCount: 0,
    present: true,
    error: false,
    observedAt: at,
    parentSessionId: null,
    origin: null,
  }
}

/**
 * Create the session-state store. Loading is loud: a corrupt main falls back to
 * the backup with an explicit recovery state; a double corruption stays sticky
 * integrity='corrupt', starts cold and REFUSES to persist (the damaged evidence
 * is never overwritten).
 */
export function createSessionStateStore(deps: SessionStateStoreDeps): SessionStateStore {
  const now = deps.now ?? (() => Date.now())
  // Observer epoch id; a fresh one per process (gap reconstruction input).
  const epoch = randomUUID()

  /** Persisted projection of one row: the goal fact is written without its
   *  process-local `activation` (and without any unknown field). */
  function persistedRow(row: StoredRow): StoredRow {
    const goal = row.goal
    if (goal === undefined || goal === null) return { ...row }
    return { ...row, goal: persistedGoalFact(goal) }
  }
  const sessionStateDir = join(deps.stateDir, SESSION_STATE_DIR_NAME)
  const filePath = join(sessionStateDir, SESSION_STATE_FILE_NAME)
  ensurePrivateDirectoryNoFollow(sessionStateDir, SESSION_STATE_DIR_MODE)

  const rows = new Map<string, StoredRow>()
  const readClients = new Map<string, StoredReadClient>()
  const ring: SessionStateDelta[] = []
  const listeners = new Set<(delta: SessionStateDelta) => void>()
  const gapCandidates = new Set<string>()
  /**
   * Process-local activation edges whose goal id has not matched a projected
   * row yet (the create raced a lagging session/list projection) — P2a
   * identity binding. At most one edge per session (the latest wins); never
   * persisted, cleared with the epoch and with the row's removal/prune.
   * Bounded by {@link MAX_PENDING_GOAL_ACTIVATIONS}: a host can emit edges for
   * ids no baseline ever carries, so the oldest retained edge is evicted and
   * counted in `dropped.goalActivations` (never silent).
   */
  const pendingGoalActivations = new Map<string, { goalId: string | null; activation: SessionStateGoalActivation }>()

  /** Retain one edge (latest wins) under the map cap. */
  function retainPendingGoalActivation(
    sessionId: string,
    edge: { goalId: string | null; activation: SessionStateGoalActivation },
  ): void {
    const retained = pendingGoalActivations.has(sessionId)
    if (!retained && pendingGoalActivations.size >= MAX_PENDING_GOAL_ACTIVATIONS) {
      const oldest = pendingGoalActivations.keys().next()
      if (oldest.done !== true) pendingGoalActivations.delete(oldest.value)
      dropped.goalActivations += 1
      warn('pending goal-activation cap reached; dropped the oldest retained edge (never silent)')
    }
    // Map.set on an existing key does NOT move it to the end: an updated edge
    // would keep its first-seen position and be evicted as "oldest" on the next
    // overflow. Delete-then-set refreshes the retention order (LRU: eviction is
    // least-recently-updated, never least-recently-first-seen).
    if (retained) pendingGoalActivations.delete(sessionId)
    pendingGoalActivations.set(sessionId, edge)
  }
  let firstBaselineDone = false

  let cursor = 0
  let readFloor = 0
  let mode: SessionStateMode = 'poll'
  let host: StoredHost = { state: 'unknown', serviceable: false, since: now(), lastBaselineAt: null, baselineOk: false }
  let dropped = { sessions: 0, readClients: 0, readMarks: 0, goalActivations: 0 }
  // 每条完成边沿的 turn/end 分类构成（与 follow 读取一一对应）。
  const turnEnds = { completed: 0, userStopped: 0, neutral: 0, unreadable: 0 }
  let integrity: SessionStateStoreStatus['integrity'] = 'ok'
  let recoveryDetail: string | null = null
  let loaded = false
  let persistBlocked = false
  let persistedAt: number | null = null
  let doc: SessionStateDocument = emptyDocument(now())

  // Accumulated delta changes (one cursor step per committed batch).
  const deltaSessions = new Map<string, SessionStateRow>()
  const deltaRemoved = new Set<string>()
  let deltaRead = false
  let deltaHost = false
  let deltaMode = false
  let revision = 0
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let flushing: Promise<void> | null = null

  function emptyDocument(at: number): SessionStateDocument {
    return {
      schemaVersion: SESSION_STATE_SCHEMA_VERSION,
      revision: 0,
      cursor: 0,
      watcherEpoch: epoch,
      mode: 'poll',
      host: { state: 'unknown', serviceable: false, since: at, lastBaselineAt: null, baselineOk: false },
      sessions: [],
      readMarks: {},
      readFloor: 0,
      dropped: { sessions: 0, readClients: 0, readMarks: 0, goalActivations: 0 },
    }
  }

  function warn(message: string): void {
    deps.logger.warn('gateway session-state: ' + message)
  }


  function validateDocument(raw: Record<string, unknown>): { doc: SessionStateDocument; droppedSessions: number } {
    if (raw.schemaVersion !== SESSION_STATE_SCHEMA_VERSION) {
      throw new Error('unsupported session-state schemaVersion ' + String(raw.schemaVersion))
    }
    const normalized = emptyDocument(now())
    normalized.revision = isWatermark(raw.revision) ? raw.revision : 0
    normalized.cursor = isWatermark(raw.cursor) ? raw.cursor : 0
    normalized.watcherEpoch = typeof raw.watcherEpoch === 'string' ? raw.watcherEpoch : epoch
    normalized.mode = raw.mode === 'sse' || raw.mode === 'poll' || raw.mode === 'off' ? raw.mode : 'poll'
    if (isPlainRecord(raw.host)) {
      const state = typeof raw.host.state === 'string' ? normalizeHostState(raw.host.state) : 'unknown'
      normalized.host = {
        state,
        serviceable: raw.host.serviceable === true,
        since: isWatermark(raw.host.since) ? raw.host.since : now(),
        lastBaselineAt: isWatermark(raw.host.lastBaselineAt) ? raw.host.lastBaselineAt : null,
        baselineOk: raw.host.baselineOk === true,
      }
    }
    normalized.readFloor = isWatermark(raw.readFloor) ? raw.readFloor : 0
    let droppedSessions = 0
    let droppedClients = 0
    const sessions: StoredRow[] = []
    if (Array.isArray(raw.sessions)) {
      for (const value of raw.sessions) {
        const row = validateRow(value)
        if (row === null) {
          droppedSessions += 1
          continue
        }
        sessions.push(row)
      }
    }
    normalized.sessions = sessions
    const marks: SessionStateDocument['readMarks'] = {}
    if (isPlainRecord(raw.readMarks)) {
      for (const [clientId, value] of Object.entries(raw.readMarks)) {
        if (!SESSION_STATE_CLIENT_ID_PATTERN.test(clientId) || !isPlainRecord(value)) continue
        const at = isWatermark(value.at) ? value.at : 0
        if (now() - at > READ_MARK_TTL_MS) {
          droppedClients += 1
          continue
        }
        const clientMarks: Record<string, { readThrough: number; at: number }> = {}
        if (isPlainRecord(value.marks)) {
          for (const [sessionId, mark] of Object.entries(value.marks)) {
            if (!isPlainRecord(mark) || !isWatermark(mark.readThrough)) continue
            clientMarks[sessionId] = { readThrough: mark.readThrough, at: isWatermark(mark.at) ? mark.at : at }
          }
        }
        marks[clientId] = { at, marks: clientMarks }
      }
    }
    normalized.readMarks = marks
    // Load-time losses ride the document itself (adoptDocument replaces the
    // in-memory counters); a closure-only increment would be silently lost. The
    // process-local readMarks/goalActivations counters load as 0: their retained
    // state is never persisted, so adopting a stale value would be a lie.
    normalized.dropped = { sessions: droppedSessions, readClients: droppedClients, readMarks: 0, goalActivations: 0 }
    return { doc: normalized, droppedSessions }
  }

  function validateRow(value: unknown): StoredRow | null {
    if (!isPlainRecord(value)) return null
    const sessionId = value.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > SESSION_STATE_SESSION_ID_MAX_CHARS) return null
    const completedAtSource = value.completedAtSource === 'observed' || value.completedAtSource === 'reconstructed'
      ? value.completedAtSource
      : null
    return {
      sessionId,
      running: value.running === true,
      lastRunningAt: isWatermark(value.lastRunningAt) ? value.lastRunningAt : null,
      updatedAt: isWatermark(value.updatedAt) ? value.updatedAt : 0,
      completedAt: isWatermark(value.completedAt) ? value.completedAt : null,
      completedAtSource: completedAtSource !== null && isWatermark(value.completedAt) ? completedAtSource : null,
      lastTurnEnd: validateTurnEnd(value.lastTurnEnd),
      pendingKind: value.pendingKind === 'approval' || value.pendingKind === 'question' ? value.pendingKind : null,
      pendingSince: isWatermark(value.pendingSince) ? value.pendingSince : null,
      subagentCount: isWatermark(value.subagentCount) ? value.subagentCount : 0,
      present: value.present !== false,
      error: value.error === true,
      observedAt: isWatermark(value.observedAt) ? value.observedAt : 0,
      parentSessionId: typeof value.parentSessionId === 'string' ? value.parentSessionId : null,
      origin: value.origin === 'subagent' ? 'subagent' : null,
      goal: validateGoalFact(value.goal),
    }
  }

  /**
   * Validate one persisted goal fact. A persisted `activation` is deliberately
   * IGNORED: activation is a process-local value, so a restart must clear it
   * back to unknown (never adopt a stale edge from disk). Unknown extra fields
   * are dropped by construction (whitelist), matching the wire projector.
   */
  function validateGoalFact(value: unknown): SessionStateGoalFact | null | undefined {
    if (value === null) return null
    if (!isPlainRecord(value)) return undefined
    const goalId = value.goalId
    const revision = value.revision
    const phase = value.phase
    if (typeof goalId !== 'string' || goalId.length === 0) return undefined
    if (!isWatermark(revision) || revision < 1) return undefined
    if (phase !== 'active' && phase !== 'paused' && phase !== 'blocked' && phase !== 'complete') return undefined
    const fact: SessionStateGoalFact = { goalId, revision, phase }
    if (isWatermark(value.updatedAt)) fact.updatedAt = value.updatedAt
    return fact
  }

  function validateTurnEnd(value: unknown): SessionTurnEnd | null {
    if (!isPlainRecord(value)) return null
    const kind = value.kind
    if (kind !== 'completed' && kind !== 'aborted' && kind !== 'blocked' && kind !== 'error'
      && kind !== 'max-tokens' && kind !== 'interrupted') return null
    const cause = value.cause
    return {
      kind,
      cause: cause === 'user' || cause === 'parent' || cause === 'hook' || cause === 'disposed' || cause === 'legacy' ? cause : null,
      at: isWatermark(value.at) ? value.at : 0,
      seq: isWatermark(value.seq) ? value.seq : null,
    }
  }


  let jsonStore: JsonStore | null = null
  try {
    jsonStore = createJsonStore({
      filePath,
      logger: deps.logger,
      initial: emptyDocument(now()),
      fileMode: SESSION_STATE_FILE_MODE,
      onLoadValidate: (raw) => {
        const result = validateDocument(raw as Record<string, unknown>)
        if (result.droppedSessions > 0) {
          warn('dropped ' + result.droppedSessions + ' unreadable session row(s) while loading; never silent')
        }
        return { doc: result.doc, dropped: { connections: 0, projects: 0 } }
      },
    })
    const loadedDoc = jsonStore.load() as unknown as SessionStateDocument
    const storeStatus = jsonStore.getStatus()
    integrity = storeStatus.recoveryState === null ? 'ok' : 'recovered'
    recoveryDetail = storeStatus.recoveryState === null
      ? null
      : 'recovered session-state snapshot from ' + storeStatus.recoveryState.source
    if (integrity === 'recovered') warn(recoveryDetail + '; loading the last durable read/completion state')
    adoptDocument(loadedDoc)
    loaded = true
  } catch (error) {
    integrity = 'corrupt'
    recoveryDetail = error instanceof Error ? error.message : String(error)
    // Corrupt is never a fake-empty AND never an overwrite: serve cold, refuse persistence, stay loud.
    warn('session-state snapshot is corrupt and will NOT be overwritten (' + recoveryDetail
      + '); starting cold - unread may be lost, never fabricated')
    doc = emptyDocument(now())
    persistBlocked = true
    loaded = false
  }

  function adoptDocument(loadedDoc: SessionStateDocument): void {
    doc = loadedDoc
    cursor = isWatermark(doc.cursor) ? doc.cursor : 0
    readFloor = isWatermark(doc.readFloor) ? doc.readFloor : 0
    mode = doc.mode === 'sse' || doc.mode === 'poll' || doc.mode === 'off' ? doc.mode : 'poll'
    host = doc.host
    dropped = {
      sessions: isWatermark(doc.dropped?.sessions) ? doc.dropped.sessions : 0,
      readClients: isWatermark(doc.dropped?.readClients) ? doc.dropped.readClients : 0,
      // readMarks / goalActivations 是进程内累计计数：validateDocument 在加载时
      // 已按契约把它们归 0（保留边不落盘，重启本就不继承），这里从 0 起算。
      // 绝不按持久值读——那是 validateDocument 永不产生非零值的死分支。
      readMarks: 0,
      goalActivations: 0,
    }
    revision = isWatermark(doc.revision) ? doc.revision : 0
    for (const row of doc.sessions) {
      rows.set(row.sessionId, row)
      if (row.running) gapCandidates.add(row.sessionId)
    }
    for (const [clientId, value] of Object.entries(doc.readMarks ?? {})) {
      if (!isPlainRecord(value) || !isPlainRecord(value.marks)) continue
      const marks = new Map<string, { readThrough: number; at: number }>()
      for (const [sessionId, mark] of Object.entries(value.marks as Record<string, unknown>)) {
        if (!isPlainRecord(mark) || !isWatermark(mark.readThrough)) continue
        marks.set(sessionId, { readThrough: mark.readThrough, at: isWatermark(mark.at) ? mark.at : 0 })
      }
      readClients.set(clientId, { at: isWatermark(value.at) ? value.at : 0, marks })
    }
  }

  // --- persistence ---------------------------------------------------------

  function markDirty(): void {
    if (persistBlocked) return
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      void flush()
    }, PERSIST_DEBOUNCE_MS)
    persistTimer.unref?.()
  }

  function enforceLimits(): void {
    if (rows.size <= MAX_SESSIONS) return
    const ordered = [...rows.values()].sort((a, b) => a.observedAt - b.observedAt)
    for (const row of ordered.slice(0, rows.size - MAX_SESSIONS)) {
      rows.delete(row.sessionId)
      // Eviction is a deletion, not a quiet field wipe: the client must be told
      // (applyRemoved discipline), or an SSE client keeps a phantom row forever.
      deltaSessions.delete(row.sessionId)
      deltaRemoved.add(row.sessionId)
      if (pendingGoalActivations.delete(row.sessionId)) dropped.goalActivations += 1
      dropped.sessions += 1
    }
    warn('session cap reached; dropped ' + dropped.sessions + ' oldest row(s) (never silent)')
    commitDelta()
  }

  function trimReadClients(): void {
    const at = now()
    for (const [clientId, client] of readClients) {
      if (at - client.at > READ_MARK_TTL_MS) {
        readClients.delete(clientId)
        dropped.readClients += 1
      }
    }
    if (readClients.size <= MAX_READ_CLIENTS) return
    const ordered = [...readClients.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [clientId] of ordered.slice(0, readClients.size - MAX_READ_CLIENTS)) {
      readClients.delete(clientId)
      dropped.readClients += 1
    }
  }

  async function flush(): Promise<void> {
    if (flushing !== null) return flushing
    const run = (async () => {
      try {
        // The row/read-client caps are in-memory invariants, NOT persistence
        // concerns: they must hold even when persistence is refused (double
        // corruption early-returns below). Enforce them BEFORE the
        // persistBlocked gate, or a 2005-row baseline would be served over the
        // cap with dropped.sessions stuck at 0 in exactly the state where the
        // snapshot is the only evidence left.
        enforceLimits()
        trimReadClients()
        if (persistBlocked) return
        revision += 1
        doc.schemaVersion = SESSION_STATE_SCHEMA_VERSION
        doc.revision = revision
        doc.cursor = cursor
        doc.watcherEpoch = epoch
        doc.mode = mode
        doc.host = host
        doc.sessions = [...rows.values()].map(persistedRow)
        const marks: SessionStateDocument['readMarks'] = {}
        for (const [clientId, client] of readClients) {
          const clientMarks: Record<string, { readThrough: number; at: number }> = {}
          for (const [sessionId, mark] of client.marks) clientMarks[sessionId] = { readThrough: mark.readThrough, at: mark.at }
          marks[clientId] = { at: client.at, marks: clientMarks }
        }
        doc.readMarks = marks
        doc.readFloor = readFloor
        doc.dropped = { ...dropped }
        if (jsonStore !== null) await jsonStore.persist(doc)
        persistedAt = now()
      } catch (error) {
        // Never fatal: the in-memory state stays authoritative until the next
        // successful flush, and the failure is loud.
        warn('snapshot persist failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    })()
    flushing = run
    try {
      await run
    } finally {
      flushing = null
    }
  }

  // --- delta emission ------------------------------------------------------

  function readState(): SessionStateReadState {
    const marks: Record<string, number> = {}
    for (const row of rows.values()) {
      let mark = 0
      for (const client of readClients.values()) {
        const value = client.marks.get(row.sessionId)
        if (value !== undefined && value.readThrough > mark) mark = value.readThrough
      }
      if (mark > 0) marks[row.sessionId] = mark
    }
    return { clientId: null, marks, floor: readFloor }
  }

  function hostInfo(): SessionStateHostInfo {
    return { now: now(), serviceable: host.serviceable, state: host.state }
  }

  function commitDelta(): void {
    if (deltaSessions.size === 0 && deltaRemoved.size === 0 && !deltaRead && !deltaHost && !deltaMode) return
    cursor += 1
    const delta: SessionStateDelta = {
      cursor,
      sessions: [...deltaSessions.values()],
      removedSessionIds: [...deltaRemoved],
      read: deltaRead ? readState() : null,
      host: deltaHost ? hostInfo() : null,
      mode: deltaMode ? mode : null,
    }
    deltaSessions.clear()
    deltaRemoved.clear()
    deltaRead = false
    deltaHost = false
    deltaMode = false
    ring.push(delta)
    if (ring.length > SSE_RING_MAX) ring.splice(0, ring.length - SSE_RING_MAX)
    for (const listener of [...listeners]) {
      try {
        listener(delta)
      } catch (error) {
        warn('delta listener failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    markDirty()
  }

  function recomputeSubagentCounts(): void {
    const counts = new Map<string, number>()
    for (const row of rows.values()) {
      if (!row.present || row.origin !== 'subagent' || row.parentSessionId === null) continue
      counts.set(row.parentSessionId, (counts.get(row.parentSessionId) ?? 0) + 1)
    }
    for (const row of rows.values()) {
      const next = counts.get(row.sessionId) ?? 0
      if (next !== row.subagentCount) {
        row.subagentCount = next
        deltaSessions.set(row.sessionId, toWireRow(row))
      }
    }
  }

  function getOrCreate(sessionId: string, at: number): StoredRow {
    let row = rows.get(sessionId)
    if (row === undefined) {
      row = createStoredRow(sessionId, at)
      rows.set(sessionId, row)
      deltaSessions.set(sessionId, toWireRow(row))
    }
    return row
  }

  /**
   * Apply a retained activation edge after a baseline/added merged a goal fact
   * into the row. The edge is consumed only when the projected goal identity
   * matches (an unbound edge matches the current known goal); a mismatching edge
   * stays retained for a later projection and never touches the previous goal's
   * row. An absent/unknown/null projection keeps the edge too: the create may
   * still be racing this baseline.
   * @returns whether the row's fact changed (delta emission input).
   */
  function applyRetainedGoalActivation(row: StoredRow, at: number): boolean {
    const goal = row.goal
    if (goal === undefined || goal === null) return false
    const edge = pendingGoalActivations.get(row.sessionId)
    if (edge === undefined) return false
    if (edge.goalId !== null && edge.goalId !== goal.goalId) return false
    pendingGoalActivations.delete(row.sessionId)
    if (goal.activation === edge.activation) return false
    const next = cloneGoalFact(goal)
    next.activation = edge.activation
    row.goal = next
    row.observedAt = at
    return true
  }

  return {
    status(): SessionStateStoreStatus {
      return {
        integrity,
        recoveryDetail,
        loaded,
        persistedAt,
        cursor,
        sessions: rows.size,
        readClients: readClients.size,
        dropped: { ...dropped },
        turnEnds: { ...turnEnds },
      }
    },

    host: hostInfo,

    setHost(input): boolean {
      const serviceable = input.serviceable === true
      if (host.state === input.state && host.serviceable === serviceable) return false
      const stateChanged = host.state !== input.state
      host = { ...host, state: input.state, serviceable, since: stateChanged ? now() : host.since }
      deltaHost = true
      commitDelta()
      return true
    },

    mode(): SessionStateMode {
      return mode
    },

    setMode(next): boolean {
      if (mode === next) return false
      mode = next
      deltaMode = true
      commitDelta()
      return true
    },

    applyBaseline(items, opts): CompletionEdge[] {
      const seen = new Set<string>()
      const edges: CompletionEdge[] = []
      for (const item of items) {
        seen.add(item.sessionId)
        const row = getOrCreate(item.sessionId, opts.at)
        const wasPresent = row.present
        const previousRunning = row.running
        const previousUpdatedAt = row.updatedAt
        row.updatedAt = Math.max(row.updatedAt, item.updatedAt)
        row.present = true
        row.observedAt = opts.at
        row.parentSessionId = item.parentSessionId
        row.origin = item.origin
        // Baseline refresh is the phase/watermark authority; activation (if any)
        // survives an unchanged goalId, and a retained edge for THIS goal id
        // lands the moment the create reaches the projection.
        const mergedGoal = mergeGoalFact(row, item.goal)
        const retainedGoal = applyRetainedGoalActivation(row, opts.at)
        const goalChanged = mergedGoal || retainedGoal
        if (item.running) {
          const resolves = row.completedAt !== null || row.completedAtSource !== null || row.lastTurnEnd !== null
          row.running = true
          row.lastRunningAt = opts.at
          row.completedAt = null
          row.completedAtSource = null
          row.lastTurnEnd = null
          gapCandidates.delete(item.sessionId)
          if (!wasPresent || !previousRunning || resolves || row.updatedAt !== previousUpdatedAt || goalChanged) {
            deltaSessions.set(item.sessionId, toWireRow(row))
          }
        } else if (previousRunning) {
          // The edge is armed by the observer after ONE classified follow read; the baseline never arms completedAt raw.
          row.running = false
          const source: SessionStateCompletedAtSource = gapCandidates.has(item.sessionId) ? 'reconstructed' : 'observed'
          gapCandidates.delete(item.sessionId)
          edges.push({ sessionId: item.sessionId, source })
          deltaSessions.set(item.sessionId, toWireRow(row))
        } else {
          if (!wasPresent || row.running !== false || row.updatedAt !== previousUpdatedAt || goalChanged) {
            row.running = false
            deltaSessions.set(item.sessionId, toWireRow(row))
          }
        }
      }
      for (const row of [...rows.values()]) {
        if (seen.has(row.sessionId)) continue
        if (row.present) {
          // Deletion is not a completion: mark absent, arm nothing, and prune on the next complete baseline that still misses it.
          row.present = false
          row.running = false
          row.observedAt = opts.at
          deltaSessions.set(row.sessionId, toWireRow(row))
        } else {
          rows.delete(row.sessionId)
          // The retained edge dies with the pruned row: a re-listed session id
          // must never inherit it (same rule as applyRemoved / the row cap).
          pendingGoalActivations.delete(row.sessionId)
          deltaRemoved.add(row.sessionId)
          deltaSessions.delete(row.sessionId)
          for (const client of readClients.values()) client.marks.delete(row.sessionId)
        }
      }
      recomputeSubagentCounts()
      // Every persisted candidate gets exactly one chance: the first complete baseline after load classifies it.
      if (!firstBaselineDone) {
        gapCandidates.clear()
        firstBaselineDone = true
      }
      host = { ...host, lastBaselineAt: opts.at, baselineOk: true }
      deltaHost = true
      commitDelta()
      return edges
    },

    applyStatus(sessionId, running, at): CompletionEdge[] {
      const row = getOrCreate(sessionId, at)
      const wasPresent = row.present
      row.observedAt = at
      row.present = true
      if (running) {
        const changed = row.running !== true || row.completedAt !== null || row.completedAtSource !== null
          || row.lastTurnEnd !== null || row.pendingKind !== null
        row.running = true
        row.lastRunningAt = at
        row.completedAt = null
        row.completedAtSource = null
        row.lastTurnEnd = null
        row.pendingKind = null
        row.pendingSince = null
        gapCandidates.delete(sessionId)
        if (changed) deltaSessions.set(sessionId, toWireRow(row))
        commitDelta()
        return []
      }
      if (row.running) {
        row.running = false
        const source: SessionStateCompletedAtSource = gapCandidates.has(sessionId) ? 'reconstructed' : 'observed'
        gapCandidates.delete(sessionId)
        deltaSessions.set(sessionId, toWireRow(row))
        commitDelta()
        return [{ sessionId, source }]
      }
      // Already stopped: only a row that just became present is a change (a duplicate status(false) must not advance the cursor).
      if (!wasPresent) deltaSessions.set(sessionId, toWireRow(row))
      commitDelta()
      return []
    },

    applyActivity(sessionId, updatedAt, at): boolean {
      if (updatedAt === null) return false
      const row = getOrCreate(sessionId, at)
      row.observedAt = at
      row.present = true
      if (updatedAt <= row.updatedAt) return false
      row.updatedAt = updatedAt
      deltaSessions.set(sessionId, toWireRow(row))
      commitDelta()
      return true
    },

    applyAdded(item, at): boolean {
      const row = getOrCreate(item.sessionId, at)
      row.observedAt = at
      row.present = true
      row.parentSessionId = item.parentSessionId
      row.origin = item.origin
      row.updatedAt = Math.max(row.updatedAt, item.updatedAt)
      mergeGoalFact(row, item.goal)
      // An added frame can be the first projection that carries the new goal:
      // the retained activation edge lands with the row itself.
      applyRetainedGoalActivation(row, at)
      if (item.running) {
        row.running = true
        row.lastRunningAt = at
        row.completedAt = null
        row.completedAtSource = null
        row.lastTurnEnd = null
      }
      recomputeSubagentCounts()
      deltaSessions.set(item.sessionId, toWireRow(row))
      commitDelta()
      return true
    },

    applyRemoved(sessionId): boolean {
      // The retained edge dies with the session even when no row ever existed
      // (an activation edge that outraced its create): a re-created session id
      // must never inherit it. Delete BEFORE the early return.
      pendingGoalActivations.delete(sessionId)
      if (!rows.has(sessionId)) return false
      // The goal fact dies with the row.
      rows.delete(sessionId)
      deltaSessions.delete(sessionId)
      deltaRemoved.add(sessionId)
      for (const client of readClients.values()) client.marks.delete(sessionId)
      recomputeSubagentCounts()
      commitDelta()
      return true
    },

    applyGoalActivation(event, at): boolean {
      const { sessionId } = event
      if (event.activation === null) {
        // The host explicitly reports no current goal; a retained edge for a
        // goal that no longer exists is dead information now.
        pendingGoalActivations.delete(sessionId)
        // Only a KNOWN fact is resolved to `null`: an unknown row stays unknown
        // (we never fabricate "no goal" from an activation edge that may have
        // outraced the baseline).
        const row = rows.get(sessionId)
        if (row === undefined || row.goal === undefined || row.goal === null) return false
        row.goal = null
        row.observedAt = at
        deltaSessions.set(sessionId, toWireRow(row))
        commitDelta()
        return true
      }
      const row = rows.get(sessionId)
      const goal = row === undefined ? undefined : row.goal
      // Identity binding (P2a): a bound edge lands ONLY on the projected goal
      // with the same id; an unbound edge acts on the current known goal
      // (mirroring the renderer P2b parser). An unknown row, an unknown
      // projection, or a create that outran the baseline retains the edge until
      // a baseline/added brings the matching identity — never guessed onto the
      // previous goal's row (that produced complete+armed).
      if (row === undefined || goal === undefined || goal === null
        || (event.goalId !== null && event.goalId !== goal.goalId)) {
        retainPendingGoalActivation(sessionId, { goalId: event.goalId, activation: event.activation })
        return false
      }
      // The latest event for this session supersedes any earlier retained edge.
      pendingGoalActivations.delete(sessionId)
      if (goal.activation === event.activation) return false
      const next = cloneGoalFact(goal)
      next.activation = event.activation
      row.goal = next
      row.observedAt = at
      deltaSessions.set(sessionId, toWireRow(row))
      commitDelta()
      return true
    },

    clearGoalActivations(at): boolean {
      // A new $events generation invalidates every process-local edge — both the
      // applied values below and edges still waiting for their projection.
      pendingGoalActivations.clear()
      let changed = false
      for (const row of rows.values()) {
        const goal = row.goal
        if (goal === undefined || goal === null || goal.activation === undefined) continue
        row.goal = persistedGoalFact(goal)
        row.observedAt = at
        deltaSessions.set(row.sessionId, toWireRow(row))
        changed = true
      }
      if (changed) commitDelta()
      return changed
    },

    applyPending(sessionId, kind, at): boolean {
      const row = getOrCreate(sessionId, at)
      if (row.pendingKind === kind) return false
      row.pendingKind = kind
      row.pendingSince = at
      row.observedAt = at
      deltaSessions.set(sessionId, toWireRow(row))
      commitDelta()
      return true
    },

    clearPending(sessionId, at): boolean {
      const row = rows.get(sessionId)
      if (row === undefined || row.pendingKind === null) return false
      row.pendingKind = null
      row.pendingSince = null
      row.observedAt = at
      deltaSessions.set(sessionId, toWireRow(row))
      commitDelta()
      return true
    },

    settleCompletion(sessionId, input): boolean {
      const row = rows.get(sessionId)
      if (row === undefined) return false
      const disposition = classifyTurnEnd(input.turnEnd)
      if (input.unreadable) turnEnds.unreadable += 1
      else if (disposition === 'completed') turnEnds.completed += 1
      else if (disposition === 'user-stopped') turnEnds.userStopped += 1
      else turnEnds.neutral += 1
      // completed arms unread; a user stop / neutral conclusion arms nothing. An
      // unreadable tail arms with lastTurnEnd null as the degraded marker.
      const completed = disposition === 'completed' || input.unreadable
      const nextCompletedAt = completed ? input.at : null
      const nextSource = completed ? input.source : null
      const changed = row.completedAt !== nextCompletedAt
        || row.completedAtSource !== nextSource
        || row.lastTurnEnd !== input.turnEnd
      row.completedAt = nextCompletedAt
      row.completedAtSource = nextSource
      row.lastTurnEnd = input.turnEnd
      row.observedAt = input.at
      if (!changed) return false
      deltaSessions.set(sessionId, toWireRow(row))
      commitDelta()
      return true
    },

    markRead(clientId, sessionId, readThrough, at): { changed: boolean; stored: boolean; readThrough: number } {
      if (!rows.has(sessionId)) return { changed: false, stored: false, readThrough: 0 }
      trimReadClients()
      let client = readClients.get(clientId)
      if (client === undefined) {
        client = { at, marks: new Map() }
        readClients.set(clientId, client)
      }
      client.at = at
      const previous = client.marks.get(sessionId)?.readThrough ?? 0
      const next = mergeReadMark(previous, readThrough)
      if (next === previous) return { changed: false, stored: true, readThrough: next }
      if (!client.marks.has(sessionId) && client.marks.size >= MAX_MARKS_PER_CLIENT) {
        const oldest = [...client.marks.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest !== undefined) {
          client.marks.delete(oldest[0])
          dropped.readMarks += 1
        }
      }
      client.marks.set(sessionId, { readThrough: next, at })
      deltaRead = true
      commitDelta()
      return { changed: true, stored: true, readThrough: next }
    },

    markAllRead(clientId, through, at): { changed: boolean; through: number; updated: number } {
      trimReadClients()
      let client = readClients.get(clientId)
      if (client === undefined) {
        client = { at, marks: new Map() }
        readClients.set(clientId, client)
      }
      client.at = at
      const next = mergeReadMark(readFloor, through)
      if (next === readFloor) return { changed: false, through: readFloor, updated: 0 }
      readFloor = next
      // updated counts rows whose watermark is now inside the floor; the late-row
      // guarantee comes from the source floor, not from per-row marks.
      let updated = 0
      for (const row of rows.values()) {
        if (!row.present) continue
        const watermark = Math.max(row.updatedAt, row.completedAt ?? 0)
        if (watermark > 0 && watermark <= next) updated += 1
      }
      deltaRead = true
      commitDelta()
      return { changed: true, through: next, updated }
    },

    readStateFor(clientId): SessionStateReadState {
      const state = readState()
      return { clientId, marks: state.marks, floor: state.floor }
    },

    snapshotFor(clientId, snapshotMode, snapshotHost): SessionStateSnapshot {
      const sessions = [...rows.values()]
        .filter(row => row.present)
        .sort((a, b) => {
          const aw = Math.max(a.updatedAt, a.completedAt ?? 0, a.observedAt)
          const bw = Math.max(b.updatedAt, b.completedAt ?? 0, b.observedAt)
          return bw - aw || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
        })
        .map(toWireRow)
      const read = readState()
      return {
        protocol: SESSION_STATE_PROTOCOL_VERSION,
        features: featuresForMode(snapshotMode),
        mode: snapshotMode,
        cursor,
        host: snapshotHost,
        sessions,
        read: { clientId, marks: read.marks, floor: read.floor },
      }
    },

    subscribe(listener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    replayFrom(sinceCursor): SessionStateDelta[] | null {
      if (!isWatermark(sinceCursor) || sinceCursor > cursor) return null
      if (sinceCursor === cursor) return []
      const events = ring.filter(delta => delta.cursor > sinceCursor)
      if (events.length === 0) return null
      if (events[0].cursor !== sinceCursor + 1) return null
      return events
    },

    flush,

    dispose(): void {
      if (persistTimer !== null) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
    },
  }
}


export interface SessionStateObserverStatus {
  mode: SessionStateMode
  ready: boolean
  baselineAt: number | null
  lastEventAt: number | null
  /** 下行帧计数与基线次数（丢帧/对账可见，不靠沉默推断）。 */
  eventsReceived: number
  baselines: number
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
        applyBaseline(parseSessionListBaselineItems(response.result.value), now(), false)
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

  async function probeCompletion(edge: CompletionEdge): Promise<void> {
    followReads += 1
    let turnEnd: SessionTurnEnd | null = null
    try {
      turnEnd = await mux.followTurnEndOnce(edge.sessionId)
    } catch {
      turnEnd = null
    }
    const unreadable = turnEnd === null
    if (unreadable) {
      followFailures += 1
      degraded = true
    }
    store.settleCompletion(edge.sessionId, { at: now(), turnEnd, source: edge.source, unreadable })
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
    onRemoved: (sessionId, at) => { store.applyRemoved(sessionId, at) },
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
        baselines: muxStatus.baselines,
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
  now?: () => number
  maxStreams?: number
  keepaliveMs?: number
}

/** Session-id bound (control characters rejected; the id is never a path). */
function isSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= SESSION_STATE_SESSION_ID_MAX_CHARS
    && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Parse one read body (strict; unknown fields ignored). */
export function parseReadRequestBody(value: unknown): ReadRequest | null {
  if (!isPlainRecord(value)) return null
  const clientId = value.clientId
  const sessionId = value.sessionId
  const readThrough = value.readThrough
  if (typeof clientId !== 'string' || !SESSION_STATE_CLIENT_ID_PATTERN.test(clientId)) return null
  if (!isSessionId(sessionId)) return null
  if (!isWatermark(readThrough)) return null
  return { clientId, sessionId, readThrough }
}

/** Parse a read-all body; `through` is REQUIRED — the server never computes "now". */
export function parseReadAllRequestBody(value: unknown): ReadAllRequest | null {
  if (!isPlainRecord(value)) return null
  const clientId = value.clientId
  const through = value.through
  if (typeof clientId !== 'string' || !SESSION_STATE_CLIENT_ID_PATTERN.test(clientId)) return null
  if (!isWatermark(through)) return null
  return { clientId, through }
}

/**
 * The /chamber/session-state surface, mirroring the control-plane SSE discipline:
 * a bounded per-stream backpressure queue, keepalive comments that never carry an
 * id, close on response teardown, a 32-stream cap and an idempotent closeAllStreams.
 * The SSE id is the store cursor: a satisfiable Last-Event-ID resumes from the ring,
 * anything else (expired, ahead, forged) falls back to a snapshot.
 */
export function createChamberSessionState(deps: ChamberSessionStateDeps): ChamberSessionState {
  const enabled = deps.enabled
  const clock = deps.now ?? (() => Date.now())
  const maxStreams = deps.maxStreams ?? MAX_SSE_STREAMS
  const keepaliveMs = deps.keepaliveMs ?? SSE_KEEPALIVE_MS
  const activeStreams = new Set<() => void>()
  let streamCount = 0

  function mode(): SessionStateMode {
    return deps.observer.status().mode
  }

  function snapshot(clientId: string | null): SessionStateSnapshot {
    const base = deps.store.snapshotFor(clientId, mode(), deps.observer.hostInfo())
    const observer = deps.observer.status()
    const storeStatus = deps.store.status()
    // 只读自诊断骑在描述符的加法字段上：丢帧/重连/follow 失败可见，不必从沉默推断。
    return {
      ...base,
      diagnostics: {
        eventsReceived: observer.eventsReceived,
        lastEventAt: observer.lastEventAt ?? 0,
        baselines: observer.baselines,
        reconnects: observer.reconnects,
        followReads: observer.followReads,
        followFailures: observer.followFailures,
        heldWaterfalls: observer.heldWaterfalls,
        mode: observer.mode,
        degraded: observer.degraded,
        turnEnds: storeStatus.turnEnds,
        dropped: storeStatus.dropped,
        cursor: storeStatus.cursor,
      },
    }
  }

  function readClientId(req: ApiRequest): { ok: true; clientId: string | null } | { ok: false } {
    const url = new URL(req.url ?? '/', 'http://gateway.invalid')
    const raw = url.searchParams.get('clientId')
    if (raw === null || raw === '') return { ok: true, clientId: null }
    return SESSION_STATE_CLIENT_ID_PATTERN.test(raw) ? { ok: true, clientId: raw } : { ok: false }
  }

  function parseLastEventId(req: ApiRequest): number | null {
    const headers = req.headers ?? {}
    const raw = headers['last-event-id'] ?? headers['Last-Event-ID']
    const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined
    if (value === undefined) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }

  function openStream(req: ApiRequest, res: ApiResponse): boolean {
    if (streamCount >= maxStreams) {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'resource_exhausted', code: 'resource_exhausted' }))
      return true
    }
    const lastEventId = parseLastEventId(req)
    streamCount += 1
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      ...((res as ApiResponse & { _corsHeaders?: Record<string, string> })._corsHeaders ?? {}),
    })
    let tornDown = false
    let backpressured = false
    let keepalive: ReturnType<typeof setInterval> | null = null
    let release: (() => void) | null = null
    let live = false
    let overflow = false
    const buffered: SessionStateDelta[] = []
    const pendingFrames: string[] = []
    const teardown = (): void => {
      if (tornDown) return
      tornDown = true
      streamCount = Math.max(0, streamCount - 1)
      activeStreams.delete(teardown)
      if (keepalive !== null) clearInterval(keepalive)
      pendingFrames.length = 0
      buffered.length = 0
      res.removeListener('drain', flushPending)
      const unsubscribe = release
      release = null
      try {
        unsubscribe?.()
      } catch { /* subscriber cleanup is isolated */ }
      try {
        res.end()
      } catch { /* already gone */ }
    }
    const writeFrame = (frame: string): void => {
      if (tornDown) return
      if (backpressured) {
        if (pendingFrames.length >= MAX_SSE_PENDING_FRAMES) teardown()
        else pendingFrames.push(frame)
        return
      }
      try {
        // Node accepted this frame even when write() returns false; pause only
        // subsequent frames until drain.
        if (!res.write(frame)) {
          backpressured = true
          res.once('drain', flushPending)
        }
      } catch {
        teardown()
      }
    }
    function flushPending(): void {
      if (tornDown) return
      backpressured = false
      while (!tornDown && !backpressured && pendingFrames.length > 0) {
        const frame = pendingFrames.shift()
        if (frame === undefined) break
        writeFrame(frame)
      }
    }
    const frameFor = (delta: SessionStateDelta): string =>
      'id: ' + delta.cursor + '\nevent: delta\ndata: ' + JSON.stringify(delta) + '\n\n'
    const snapshotFrame = (body: SessionStateSnapshot): string =>
      'id: ' + body.cursor + '\nevent: snapshot\ndata: ' + JSON.stringify(body) + '\n\n'
    // Subscribe BEFORE the snapshot/replay so no delta can fall between the two; newer buffered deltas flush after.
    release = deps.store.subscribe(delta => {
      if (live) {
        writeFrame(frameFor(delta))
        return
      }
      if (buffered.length >= MAX_SSE_PENDING_FRAMES) {
        overflow = true
        return
      }
      buffered.push(delta)
    })
    // Node 16+: the request close event fires once the body is consumed, so detect disconnects on the response leg.
    res.on('close', () => { if (!res.writableEnded) teardown() })
    const client = readClientId(req)
    if (!client.ok) {
      writeFrame('event: error\ndata: ' + JSON.stringify({ error: 'bad_request', code: 'bad_request' }) + '\n\n')
      teardown()
      return true
    }
    let deliveredCursor = -1
    const replay = lastEventId === null ? null : deps.store.replayFrom(lastEventId)
    if (replay !== null) {
      for (const delta of replay) {
        writeFrame(frameFor(delta))
        deliveredCursor = delta.cursor
      }
      // replay !== null implies lastEventId !== null; this guard only keeps the narrowing local.
      if (deliveredCursor < 0 && lastEventId !== null) deliveredCursor = lastEventId
    } else {
      const body = snapshot(client.clientId)
      writeFrame(snapshotFrame(body))
      deliveredCursor = body.cursor
    }
    if (overflow) {
      teardown()
      return true
    }
    for (const delta of buffered) {
      if (delta.cursor > deliveredCursor) {
        writeFrame(frameFor(delta))
        deliveredCursor = delta.cursor
      }
    }
    buffered.length = 0
    live = true
    if (tornDown) return true
    keepalive = setInterval(() => {
      // Keepalives carry no state and must not consume the bounded queue while real frames wait for drain.
      if (!tornDown && !backpressured) writeFrame(': keepalive\n\n')
    }, keepaliveMs)
    keepalive.unref?.()
    activeStreams.add(teardown)
    return true
  }

  async function readJsonBody(req: ApiRequest): Promise<
    { kind: 'body'; value: unknown } | { kind: 'oversize' } | { kind: 'aborted' } | { kind: 'invalid' }
  > {
    const outcome = await readBoundedBody(req, SESSION_STATE_READ_BODY_MAX_BYTES)
    if (outcome.kind === 'oversize') return { kind: 'oversize' }
    if (outcome.kind === 'aborted' || outcome.kind === 'closed' || outcome.kind === 'stream-error') return { kind: 'aborted' }
    try {
      return { kind: 'body', value: outcome.buffer.length === 0 ? {} : JSON.parse(outcome.buffer.toString('utf8')) }
    } catch {
      return { kind: 'invalid' }
    }
  }

  function methodNotAllowed(res: ApiResponse): true {
    return jsonResponse(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
  }

  async function handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    if (!enabled) {
      // The desktop distinguishes 404 (no surface) from 503 session_state_disabled (this exact body).
      return jsonResponse(res, 503, { error: 'session_state_disabled', code: 'session_state_disabled' })
    }
    if (pathname === SESSION_STATE_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
      const client = readClientId(req)
      if (!client.ok) return jsonResponse(res, 400, { error: 'bad_request', code: 'bad_request' })
      return jsonResponse(res, 200, snapshot(client.clientId))
    }
    if (pathname === SESSION_STATE_STREAM_PATH) {
      if (req.method !== 'GET') return methodNotAllowed(res)
      return openStream(req, res)
    }
    if (pathname === SESSION_STATE_READ_PATH || pathname === SESSION_STATE_READ_ALL_PATH) {
      if (req.method !== 'POST') return methodNotAllowed(res)
      const body = await readJsonBody(req)
      if (body.kind === 'oversize') {
        const result = jsonResponse(res, 413, { error: 'body_too_large', code: 'body_too_large' })
        req.destroy?.()
        return result
      }
      if (body.kind === 'aborted') return true
      if (body.kind === 'invalid') return jsonResponse(res, 400, { error: 'bad_request', code: 'bad_request' })
      if (pathname === SESSION_STATE_READ_PATH) {
        const parsed = parseReadRequestBody(body.value)
        if (parsed === null) return jsonResponse(res, 400, { error: 'bad_request', code: 'bad_request' })
        // Clamp a client clock ahead of the host: it must not buy a permanent read mark in the host's future.
        const at = clock()
        const outcome = deps.store.markRead(parsed.clientId, parsed.sessionId, clampReadThrough(parsed.readThrough, at), at)
        return jsonResponse(res, 200, {
          ok: true,
          clientId: parsed.clientId,
          sessionId: parsed.sessionId,
          readThrough: outcome.readThrough,
          changed: outcome.changed,
          stored: outcome.stored,
        })
      }
      const parsed = parseReadAllRequestBody(body.value)
      if (parsed === null) return jsonResponse(res, 400, { error: 'bad_request', code: 'bad_request' })
      const at = clock()
      const outcome = deps.store.markAllRead(parsed.clientId, clampReadThrough(parsed.through, at), at)
      return jsonResponse(res, 200, {
        ok: true,
        clientId: parsed.clientId,
        through: outcome.through,
        floor: outcome.through,
        changed: outcome.changed,
        updated: outcome.updated,
      })
    }
    return jsonResponse(res, 404, { error: 'not_found', code: 'not_found' })
  }

  return {
    handle,
    closeAllStreams(): void {
      for (const teardown of [...activeStreams]) teardown()
    },
  }
}

export interface SessionStateServiceDeps {
  stateDir: string
  logger: Logger
  /** Config kill switch (DSH_GATEWAY_SESSION_STATE=0 / sessionState:false). */
  enabled: boolean
  getLocalDshPort(): number | null
  /** Plane connectionState string (runtime-manager / control-plane). */
  getConnectionState(): string
  /** The exposure gate (never observe a quarantined candidate tree). */
  canExposeLocal(): boolean
  /** gateway-proxy.getDiagnostics().activeStreams > 0 (the delegate gate). */
  otherMuxClientsConnected(): boolean
}

export interface SessionStateService {
  readonly surface: ChamberSessionState
  readonly store: SessionStateStore
  start(): void
  /** Host-edge pause (keeps the routes serving the last snapshot). */
  stop(): void
  /** Gateway shutdown: close SSE -> stop the observer -> flush the snapshot. */
  shutdown(): Promise<void>
}

/**
 * Assemble store + observer + routes. start/stop follow the host readiness edge;
 * shutdown is the gateway stop path and must run BEFORE the gateway store closes.
 */
export function createSessionStateService(deps: SessionStateServiceDeps): SessionStateService {
  const baseUrl = (): string | null => {
    const port = deps.getLocalDshPort()
    if (port === null || !deps.canExposeLocal()) return null
    const state = normalizeHostState(deps.getConnectionState())
    if (state !== 'ready' && state !== 'degraded') return null
    return 'http://127.0.0.1:' + port
  }
  const store = createSessionStateStore({ stateDir: deps.stateDir, logger: deps.logger })
  const observer = createSessionStateObserver({
    logger: deps.logger,
    store,
    getBaseUrl: baseUrl,
    getHostState: () => normalizeHostState(deps.getConnectionState()),
    otherMuxClientsAttached: deps.otherMuxClientsConnected,
  })
  const surface = createChamberSessionState({
    logger: deps.logger,
    store,
    observer,
    enabled: deps.enabled,
  })
  if (!deps.enabled) store.setMode('off')
  return {
    surface,
    store,
    start(): void {
      if (!deps.enabled) return
      observer.start()
    },
    stop(): void {
      if (!deps.enabled) return
      observer.stop()
      store.setMode('poll')
    },
    async shutdown(): Promise<void> {
      surface.closeAllStreams()
      observer.stop()
      if (deps.enabled) store.setMode('poll')
      await store.flush()
      store.dispose()
    },
  }
}
