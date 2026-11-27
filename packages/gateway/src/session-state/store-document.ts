/**
 * Persisted session-state DOCUMENT: shape, schema version, the document clock and the
 * load-time validators (R1-A + validation layer). Split from store-codec.ts so the row
 * codec stays one screen; store.ts is this module's only importer (it imports both).
 */
import { SESSION_STATE_SESSION_ID_MAX_CHARS, type SessionStateGoalFact, type SessionTurnEnd } from '@dsh-chamber/control-plane'
import { persistedGoalFact } from './store-codec.ts'
import { isPlainRecord, isWatermark } from '@dsh-chamber/dsh-chamber-wire/json-guards'
import { normalizeHostState } from './features.ts'
import type { PersistedStoredRow, SessionStateDocument, StoredRow } from './store-codec.ts'

export const SESSION_STATE_SCHEMA_VERSION = 1

/** The two process-scoped values the validators need (never module state). */
export interface DocumentClock { now: () => number; epoch: string }

/** 持久化投影：派生谱系证据（运行数/认证位/保留位）不落盘——它们由行集重建，且认证位是
 *  进程内结论（重启后等首份基线）；goal 只留 durable 白名单。 */
export function persistedRow(row: StoredRow): PersistedStoredRow {
  const { subagentRunningCount: _running, lineageVerified: _verified, subagentKnown: _known, ...durable } = row
  return row.goal === undefined || row.goal === null ? durable : { ...durable, goal: persistedGoalFact(row.goal) }
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
    // 派生谱系证据不落盘也不采信（旧/篡改文档里即使出现也按「未认证、无证据」重建）。
    subagentRunningCount: 0,
    lineageVerified: false,
    subagentKnown: false,
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
