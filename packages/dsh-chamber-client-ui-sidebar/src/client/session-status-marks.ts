/**
 * Page-level unary `sessionStatus/mark` (alpha.1 reading marks; design 06 §4.1).
 *
 * WHY PAGE-LEVEL: the sidebar row of source X may be rendered by the shell of source
 * Y (the page-level aggregate lists every source), so the action cannot borrow the
 * rendering ctx's remote namespace. The chamber page already owns one unary client
 * per source (`instance-api` `getInstanceClient`), the same carrier every other
 * cross-source session mutation uses, so marks take the escape-hatch
 * `callUnary(endpoint, args)` path with the wire's positional argument names
 * (`sessionId`, `action` — the upstream `@Remote mark(sessionId, action)`).
 *
 * READ SEMANTICS: `{ type: 'read', throughTurn: Number.MAX_SAFE_INTEGER }` — the
 * Host clamps the position to its own `completedTurn`
 * (`ui-session-status/src/index.ts` mark: `Math.max(readTurn, Math.min(throughTurn,
 * completedTurn))`), so the page does not need a completion-turn fact to mark read.
 * UNREAD is `{ type: 'unread' }` (readTurn stays, manualUnread arms).
 *
 * Failures: the unary result's business error becomes `InstanceRpcError` (the same
 * vocabulary the rest of the sidebar's action funnel surfaces); a 404 whose body is
 * not `instance_not_found` stays a transport failure. Hosts without the domain
 * answer `capability_not_found` / `domain missing` — the row menu only appears when
 * the source's reading seat says the baseline arrived, so a mark on an old host
 * cannot be offered in the first place.
 */
import { callAndThrow, getInstanceClient } from '@dsh-chamber/dsh-chamber-client-core/instance-api'

/** The host endpoint the alpha.1 session-status service registers (`sessionStatus/mark`). */
export const SESSION_STATUS_MARK_ENDPOINT = 'sessionStatus/mark'

/** The wire action payloads the host's `mark` accepts. */
export type SessionStatusMarkAction =
  | { readonly type: 'unread' }
  | { readonly type: 'read'; readonly throughTurn: number }

/**
 * Build the wire action for one row-menu direction.
 * @param unread - true = mark unread (`manualUnread`), false = mark read (clamped).
 * @returns the exact upstream action object.
 */
export function sessionStatusMarkAction(unread: boolean): SessionStatusMarkAction {
  return unread
    ? { type: 'unread' }
    // Host clamps: readTurn = max(readTurn, min(throughTurn, completedTurn)).
    : { type: 'read', throughTurn: Number.MAX_SAFE_INTEGER }
}

/**
 * Mark one Session read or unread through its source's page-level unary carrier.
 * @param sourceId - the row's aggregate source id (the per-instance proxy key).
 * @param sessionId - the row's session id.
 * @param unread - true marks unread; false marks read.
 * @returns resolves on an ok result; throws the unary vocabulary otherwise.
 */
export async function markSessionForSource(sourceId: string, sessionId: string, unread: boolean): Promise<void> {
  const client = getInstanceClient(sourceId)
  // A mark is a write: classify a lost answer as an unknown mutation, not a safe read retry.
  await callAndThrow(() => client.callUnary(
    SESSION_STATUS_MARK_ENDPOINT,
    { sessionId, action: sessionStatusMarkAction(unread) },
    undefined,
    { mutation: true },
  ))
}
