/**
 * Browser-side face of the single session-state wire definition in the neutral wire
 * package (@dsh-chamber/dsh-chamber-wire/session-state). A browser consumer may only
 * import packages it declares, and the renderer's declared kernel is this package, so
 * the contract is re-exported HERE BY NAME: one implementation, one browser face.
 *
 * HARD DISCIPLINE: this file declares nothing. A wire-face change updates this name list
 * and nothing else. No `export *`: verify-no-dead-exports resolves named re-exports only.
 */
export {
  PROTOCOL_VERSION,
  SESSION_STATE_DISABLED_CODE,
  SESSION_STATE_PATH,
  SESSION_STATE_STREAM_PATH,
  classifyTurnEnd,
} from '@dsh-chamber/dsh-chamber-wire/session-state'
export type {
  SessionStateCompletedAtSource,
  SessionStateGoalFact,
  SessionStateMode,
  SessionStatePendingKind,
  SessionStateRow,
  SessionTurnEndCause,
  SessionTurnEndDisposition,
  SessionTurnEndKind,
} from '@dsh-chamber/dsh-chamber-wire/session-state'
