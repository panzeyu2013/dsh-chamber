/**
 * Host mux wire contracts shared by the control-plane session mux and the browser
 * fact sources: the remote.mux path, the $events endpoint, the one-shot follow
 * payload, and the two privacy-whitelisted parsers (projected goal fact, goal
 * activation edge). Pure data — no transport, no clock, no state.
 *
 * Moved here because both halves of the protocol parsed the same upstream shapes
 * with copy-pasted rules (privacy whitelist, identity binding, unknown-vs-null).
 */
import { isRecord } from './json-guards.ts'
import type { SessionStateGoalActivation, SessionStateGoalFact } from './session-state.ts'

/** Host gateway stream path carrying the mux (design 26). */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'

/** Logical stream carrying the forwarded event family. */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'

/** How many tail messages a completion-edge follow asks for. */
export const FOLLOW_MAX_MESSAGES = 8

/** One-shot `session/follow` request for a completion edge. */
export function buildSessionFollowPayload(sessionId: string, maxMessages = FOLLOW_MAX_MESSAGES): unknown {
  return { args: { request: { address: { kind: 'session', sessionId }, maxMessages } } }
}

/** goal phase whitelist of the pinned host projection. */
const GOAL_PHASES: ReadonlySet<string> = new Set(['active', 'paused', 'blocked', 'complete'])

/**
 * Project the `goal` key out of one `session/list` item's projection block.
 * ONLY id/revision/phase/updatedAt survive — objective, blockedReason,
 * maxGoalRounds and roundsStarted are dropped here by construction.
 * @returns `undefined` = key absent or shape unparsable (unknown; never
 *   silently "no goal"), `null` = explicit no current goal, an object = the
 *   whitelisted fact.
 */
export function parseProjectedGoalFact(value: Record<string, unknown>): SessionStateGoalFact | null | undefined {
  const projections = value.projections
  if (!isRecord(projections)) return undefined
  const values = projections.values
  if (!isRecord(values) || !Object.hasOwn(values, 'goal')) return undefined
  const raw = values.goal
  if (raw === null) return null
  if (!isRecord(raw) || !isRecord(raw.goal)) return undefined
  const id = raw.goal.id
  const revision = raw.goal.revision
  const phase = raw.goal.phase
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined
  if (typeof phase !== 'string' || !GOAL_PHASES.has(phase)) return undefined
  const fact: SessionStateGoalFact = { goalId: id, revision, phase: phase as SessionStateGoalFact['phase'] }
  if (typeof raw.updatedAt === 'number' && Number.isSafeInteger(raw.updatedAt) && raw.updatedAt >= 0) {
    fact.updatedAt = raw.updatedAt
  }
  return fact
}

/** One normalized `goal/activation-changed` edge (identity binding included). */
export interface GoalActivationFact {
  sessionId: string
  /** null = the host reported no current goal (`goal` absent). */
  activation: SessionStateGoalActivation | null
  /** `goal.id` when the payload carried a usable one; null = unbound edge. */
  goalId: string | null
}

/**
 * Parse one `goal/activation-changed` payload (frozen wire
 * `{ sessionId, goal?: { id, revision, activation } }`).
 * `goal` absent = no current goal; a present non-record goal, or an activation
 * outside armed/disarmed = shape drift (null, never a guess); a missing id keeps
 * the edge unbound (null).
 */
export function parseGoalActivationFact(value: unknown): GoalActivationFact | null {
  if (!isRecord(value)) return null
  const sessionId = value.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const goal = value.goal
  if (goal === undefined) return { sessionId, activation: null, goalId: null }
  if (!isRecord(goal)) return null
  const activation = goal.activation
  if (activation !== 'armed' && activation !== 'disarmed') return null
  const goalId = typeof goal.id === 'string' && goal.id.length > 0 ? goal.id : null
  return { sessionId, activation, goalId }
}
