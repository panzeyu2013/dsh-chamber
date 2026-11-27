/**
 * Persisted session-state document shape + row codec: the internal row/document types,
 * the goal whitelist/merge rules, the wire projection and the row factory. These are
 * pure functions over a row and a goal fact (no store closure), split out of store.ts
 * so the persisted shape is reviewable on its own (optimality review R1-A).
 */
import { evidenceWireFields } from './subagent-evidence.ts'
import {
  type SessionStateCompletedAtSource, type SessionStateGoalFact, type SessionStateHostState,
  type SessionStateMode, type SessionStatePendingKind, type SessionStateRow, type SessionTurnEnd,
} from '@dsh-chamber/control-plane'
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
  /** 运行中的子代理后代数（P2a 谱系证据，与 P2b 的 subagentCount 同义）：只数
   *  origin===subagent、父边在场且 running===true 的子行。 */
  subagentRunningCount: number
  /** I-12 认证位：本进程至少应用过一份完整列表基线（子行谱系可判），没有缺父边的子行；
   *  且仅在**有运行中后代**时置真（wire 兼容门，见 subagent-evidence.ts）；false ⇒ 只作 presence、绝不 busy。 */
  lineageVerified: boolean
  /** I-12 fail-closed 位：认证位缺席但保留表里确有该父的子行（列表可能不完整）
   *  ⇒ 判定侧按 busy 处理，不把「列表不完整」读成「子代理已结束」。 */
  subagentKnown: boolean
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

/** 持久化行：派生谱系证据不落盘（见 persistedRow）。 */
export type PersistedStoredRow = Omit<StoredRow, 'subagentRunningCount' | 'lineageVerified' | 'subagentKnown'>

/** The persisted document (createJsonStore free-form domain doc). */
export interface SessionStateDocument {
  schemaVersion: number
  revision: number
  cursor: number
  watcherEpoch: string
  mode: SessionStateMode
  host: StoredHost
  sessions: PersistedStoredRow[]
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
    subagentRunningCount: row.subagentRunningCount,
    ...evidenceWireFields(row),
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
    subagentRunningCount: 0,
    lineageVerified: false,
    subagentKnown: false,
    present: true,
    observedAt: at,
    parentSessionId: null,
    origin: null,
    originKnown: false,
  }
}

