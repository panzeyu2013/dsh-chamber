/**
 * Persisted session-state document shape + row codec: the internal row/document types,
 * the goal whitelist/merge rules, the wire projection and the row factory. These are
 * pure functions over a row and a goal fact (no store closure), split out of store.ts
 * so the persisted shape is reviewable on its own (optimality review R1-A).
 */
import {
  SESSION_STATE_SESSION_ID_MAX_CHARS, type SessionStateCompletedAtSource, type SessionStateGoalFact, type SessionStateHostState,
  type SessionStateMode, type SessionStatePendingKind, type SessionStateRow, type SessionTurnEnd,
} from '@dsh-chamber/control-plane'
import { isPlainRecord, isWatermark } from '@dsh-chamber/dsh-chamber-wire/json-guards'
import { normalizeHostState } from './features.ts'
/** Internal row = wire row + persistence/observer-only fields (toWireRow projects it; nothing sensitive is added). */
export interface StoredRow {
  sessionId: string
  running: boolean
  lastRunningAt: number | null
  updatedAt: number
  completedAt: number | null
  completedAtSource: SessionStateCompletedAtSource | null
  lastTurnEnd: SessionTurnEnd | null
  pendingKind: SessionStatePendingKind | null
  subagentCount: number
  /** Legacy 兼容位：S3 单阶段删除后行在即 present（没有任何写入者会置假）；仅
   *  旧文档的 `present: false` 仍按隐藏读，避免把历史隐藏行突然投递。 */
  present: boolean
  observedAt: number
  /** Baseline bookkeeping for the parent/origin subagent count. */
  parentSessionId: string | null
  origin: 'subagent' | null
  /**
   * 该行的 origin 是否已被**列表事实**确认（S1）：只有 applyBaseline/applyAdded 置真，
   * 由 status/activity/pending 首建的行置假。未确认的行一律不投递——它可能其实是子代理，
   * 投递就会为子代理发真横幅；列表事实把身份落定（顶层或子代理）后才可判。
   */
  originKnown: boolean
  /**
   * Projected goal fact (P2a). `undefined` = the projection key was never
   * observed (unknown); `null` = the host explicitly reports no goal; an
   * object = the current goal. `activation` inside it is PROCESS-LOCAL and is
   * stripped before persistence, so a restart clears it back to unknown.
   */
  goal?: SessionStateGoalFact | null
}

/** Persisted host gate (the wire projection adds the current clock). */
export interface StoredHost {
  state: SessionStateHostState
  serviceable: boolean
  since: number
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
  dropped: { sessions: number; goalActivations: number }
  [key: string]: unknown
}



/** Whitelisted clone of one goal fact. Only the five contract fields can
 *  survive, so a smuggled `objective`/`blockedReason` (or any future host
 *  field) can never reach the wire or the persisted document. */
export function cloneGoalFact(goal: SessionStateGoalFact): SessionStateGoalFact {
  const fact: SessionStateGoalFact = { goalId: goal.goalId, revision: goal.revision, phase: goal.phase }
  if (goal.updatedAt !== undefined) fact.updatedAt = goal.updatedAt
  if (goal.activation !== undefined) fact.activation = goal.activation
  return fact
}

/** Persisted projection of one goal fact: `activation` is process-local and
 *  must never reach the snapshot document (v5 §6 P2a: a restart clears it back
 *  to unknown). */
export function persistedGoalFact(goal: SessionStateGoalFact): SessionStateGoalFact {
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
export function mergeGoalFact(row: StoredRow, goal: SessionStateGoalFact | null | undefined): boolean {
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
export function toWireRow(row: StoredRow): SessionStateRow {
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

export function createStoredRow(sessionId: string, at: number): StoredRow {
  return {
    sessionId,
    running: false,
    lastRunningAt: null,
    updatedAt: 0,
    completedAt: null,
    completedAtSource: null,
    lastTurnEnd: null,
    pendingKind: null,
    subagentCount: 0,
    present: true,
    observedAt: at,
    parentSessionId: null,
    origin: null,
    originKnown: false,
  }
}

/** Bumped when the persisted document shape changes; old documents fail loud. */
export const SESSION_STATE_SCHEMA_VERSION = 1

/** The two process-scoped values the validators need (never module state). */
export interface DocumentClock { now: () => number; epoch: string }

/** Persisted projection of one row: the goal fact drops its process-local activation. */
export function persistedRow(row: StoredRow): StoredRow {
  const goal = row.goal
  if (goal === undefined || goal === null) return { ...row }
  return { ...row, goal: persistedGoalFact(goal) }
}

export function emptyDocument(at: number, epoch: string): SessionStateDocument {
  return {
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    revision: 0,
    cursor: 0,
    watcherEpoch: epoch,
    mode: 'poll',
    host: { state: 'unknown', serviceable: false, since: at },
    sessions: [],
    dropped: { sessions: 0, goalActivations: 0 },
  }
}

export function validateDocument(raw: Record<string, unknown>, clock: DocumentClock): { doc: SessionStateDocument; droppedSessions: number } {
  if (raw.schemaVersion !== SESSION_STATE_SCHEMA_VERSION) {
    throw new Error('unsupported session-state schemaVersion ' + String(raw.schemaVersion))
  }
  const normalized = emptyDocument(clock.now(), clock.epoch)
  normalized.revision = isWatermark(raw.revision) ? raw.revision : 0
  normalized.cursor = isWatermark(raw.cursor) ? raw.cursor : 0
  normalized.watcherEpoch = typeof raw.watcherEpoch === 'string' ? raw.watcherEpoch : clock.epoch
  normalized.mode = raw.mode === 'sse' || raw.mode === 'poll' || raw.mode === 'off' ? raw.mode : 'poll'
  if (isPlainRecord(raw.host)) {
    const state = typeof raw.host.state === 'string' ? normalizeHostState(raw.host.state) : 'unknown'
    normalized.host = {
      state,
      serviceable: raw.host.serviceable === true,
      since: isWatermark(raw.host.since) ? raw.host.since : clock.now(),
    }
  }
  let droppedSessions = 0
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
  // Load-time losses ride the document itself (adoptDocument replaces the
  // in-memory counters); a closure-only increment would be silently lost. The
  // process-local goalActivations counter loads as 0: its retained state is
  // never persisted, so adopting a stale value would be a lie.
  normalized.dropped = { sessions: droppedSessions, goalActivations: 0 }
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
    subagentCount: isWatermark(value.subagentCount) ? value.subagentCount : 0,
    present: value.present !== false,
    observedAt: isWatermark(value.observedAt) ? value.observedAt : 0,
    parentSessionId: typeof value.parentSessionId === 'string' ? value.parentSessionId : null,
    origin: value.origin === 'subagent' ? 'subagent' : null,
    // 旧文档（无该字段）按未确认读：保守地等到本进程的首份基线再投递。
    originKnown: value.originKnown === true,
    goal: validateGoalFact(value.goal),
  }
}

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
