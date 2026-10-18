/**
 * Freshness gate for ACTION preflights (design 08 §5 / design 26 §D7).
 *
 * An action that demands "refresh first, then act on fresh facts" cannot rely on
 * the refresh rejecting: a page-dispatch-budget refusal deliberately keeps the
 * last snapshot and RESOLVES with the previous state (coordinator's
 * not-dispatched branch). That is the right polling behaviour and the wrong
 * action behaviour — a silent old state would let a removal/adopt run on facts up
 * to `ceil(N/2) × 30s` stale.
 *
 * The only reliable proof that THIS pull produced facts is the state's own
 * timestamp: a completed pull bumps `updatedAt` (coordinator success path), a
 * refusal does not touch it. Pure, clockless (the caller supplies `startedAt`).
 */
export interface RefreshFreshnessState {
  readonly updatedAt?: number
}

/** True when `state` carries facts produced at or after `startedAt`.
 *  Equal is fresh (a pull may complete inside the same millisecond).
 *
 *  RESIDUAL: `updatedAt` is the pull's COMPLETION time, not its observation start,
 *  so a single-flight join on a pull launched just before the action still passes.
 *  The window is bounded by one in-flight pull and closing it would need a launch
 *  mark the state does not expose; the gates pair this check with the older
 *  snapshot/sourceError checks so a dead source never passes on it alone. */
export function refreshedSince(state: RefreshFreshnessState | undefined, startedAt: number): boolean {
  return state?.updatedAt !== undefined && state.updatedAt >= startedAt
}
