/**
 * update-confirmation.ts — the confirmation wire shape for the two update actions
 * (design 11 §4 stale-answer guard), kept as a dependency-free leaf so the wire shape is
 * unit-testable under plain node and shareable by the shell wiring and its execution-level
 * IPC test without pulling the IPC/transport graph into either.
 *
 * A confirmation carries `{ revision }` — the state generation the renderer answered
 * from. A malformed payload fails CLOSED (never "no expectation"): the shell must always
 * echo a revision, so a missing/wrong-typed one is a protocol error, not silent consent.
 */

/** Refusal for a malformed confirmation payload (loud, never {ok:true}). */
export const INVALID_CONFIRMATION_ERROR = 'invalid update confirmation payload (expected { revision })'

/**
 * Parse `{ revision }` out of a confirmation payload → non-negative safe integer, or
 * null when the payload is malformed. Pure: preload.cts and the Swift shim both send
 * exactly this object, and the controller refuses a revision that is not current.
 */
export function parseConfirmationRevision(payload: unknown): number | null {
  if (payload === null || typeof payload !== 'object') return null
  const revision = (payload as { revision?: unknown }).revision
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : null
}
