/**
 * Bounded retry budget for a page-budget ("not dispatched") refresh (design 08 §5).
 *
 * A refusal is transient and worth one short retry, but an UNBOUNDED 3s chain
 * would keep loading a saturated page (each retry also occupies queue capacity)
 * and would outlive the coordinator's detach. This module owns the schedule:
 * 3s, 6s, 12s, then stop — the 30s tick keeps covering the source afterwards.
 */
export const NOT_DISPATCHED_RETRY_BASE_MS = 3_000
export const NOT_DISPATCHED_RETRY_MAX_ATTEMPTS = 3

/** Delay before retry number `attempt` (0-based), or null when the budget is spent. */
export function notDispatchedRetryDelay(attempt: number): number | null {
  if (!Number.isFinite(attempt) || attempt < 0) return null
  if (attempt >= NOT_DISPATCHED_RETRY_MAX_ATTEMPTS) return null
  return NOT_DISPATCHED_RETRY_BASE_MS * 2 ** Math.trunc(attempt)
}
