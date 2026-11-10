/**
 * Popup (new-window) rate limit per tab occurrence (design 28 v3 §5③/§8-16).
 *
 * The guest's `createWebViewWith` answers a GET/own-tab request by pushing
 * `openRequested`; a hostile page could open tabs in a loop, so the renderer caps
 * one occurrence at 6 accepted requests per rolling 60 s. Refusals are silent
 * (the upstream panel semantics has no error surface for a dropped popup).
 */

/**
 * Monotonic clock for the limiter (RT-05).
 *
 * `performance.now()` never jumps backwards across wall-clock adjustments; the
 * `Date.now` fallback keeps non-browser hosts working.
 *
 * @returns milliseconds from a monotonic source when available.
 */
export function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** Window and cap for one tab occurrence. */
export const OPEN_REQUEST_LIMIT = 6
export const OPEN_REQUEST_WINDOW_MS = 60_000

/**
 * Record one request and answer whether it is accepted.
 *
 * @param timestamps - accepted request times (mutated: pruned to the window).
 * @param now - current time in ms (injected for tests).
 * @param limit - accepted requests per window.
 * @param windowMs - rolling window length.
 * @returns true when this request may open a tab.
 */
export function allowOpenRequest(
  timestamps: number[],
  now: number,
  limit = OPEN_REQUEST_LIMIT,
  windowMs = OPEN_REQUEST_WINDOW_MS,
): boolean {
  const cutoff = now - windowMs
  while (timestamps.length > 0 && (timestamps[0] as number) <= cutoff) timestamps.shift()
  if (timestamps.length >= limit) return false
  timestamps.push(now)
  return true
}
