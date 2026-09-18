/**
 * Carrier-retry pacing for {@link RemoteStream} — chamber fork patch (design 14 §D4).
 *
 * Upstream's `waitForRemoteStreamRetry` treats a SECOND carrier failure inside
 * one LIVE connection generation as terminal (`throw error`); the gateway wraps
 * that carrier error as `gateway/internal` and the session controller latches it
 * on `failEventStream()`, so the conversation surface never reopens. A mux
 * socket can legitimately die several times inside one live generation (protocol
 * proxy churn, missed heartbeats, upstream close under load), so the retry lane
 * paces and reopens instead of escaping.
 *
 * This module owns ONLY the delay math: pure, no imports, so the policy is
 * unit-testable without the vendor dependency graph.
 *
 * The numbers are not arbitrary: the ceiling equals the connection lane's own
 * `backoffMaxMs` default (10_000, `dsh-client-connection/src/recovery-config.ts`,
 * restated as `DEFAULT_MIN_RESTART_INTERVAL_MS` in its `liveness-triggers.ts`), so
 * a keep-failing carrier reopens no faster than the lane would restart the
 * transport itself. The base is half that lane's `backoffBaseMs` (500): a stream
 * reopen is cheaper than a transport restart and restores the event stream
 * sooner, while staying far from a hot loop.
 */

/** First carrier failure of an episode reopens immediately (upstream behaviour kept). */
export const REMOTE_STREAM_RETRY_FIRST_MS = 0

/** Backoff base for the second and every later failure inside one live generation. */
export const REMOTE_STREAM_RETRY_BASE_MS = 250

/** Backoff ceiling: a persistent carrier fault reopens at most this slowly. */
export const REMOTE_STREAM_RETRY_MAX_MS = 10_000

/**
 * Abortable backoff wait for the carrier's live-generation retry branch.
 *
 * It lives HERE rather than in the carrier so the abort contract is exercised in
 * plain Node: the carrier module cannot be imported without the vendor graph, and
 * a source lock alone cannot prove that an aborted generation stops waiting.
 * @param delayMs - milliseconds to wait before the reopen.
 * @param signal - generation/lifetime cancellation signal.
 * @returns a promise that resolves after the delay and rejects on abort.
 */
export function delayRemoteStreamRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const aborted = (): void => {
      clearTimeout(timer)
      reject(new Error('Remote stream retry aborted', { cause: signal.reason }))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

/**
 * Delay before reopening after carrier failure number `attempt` (1-based, counted
 * per episode: it resets whenever the opening baseline/cursor is accepted or the
 * stream is explicitly restarted).
 *
 * Attempt 1 is immediate; later attempts double from the base up to the ceiling,
 * so a persistently failing carrier settles into one reopen per ceiling interval
 * instead of a hot loop — and never becomes a terminal stream error.
 * @param attempt - 1-based consecutive carrier-failure count for this episode.
 * @returns milliseconds to wait before the next reopen.
 */
export function remoteStreamRetryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 1) return REMOTE_STREAM_RETRY_FIRST_MS
  // Clamp the exponent before the multiplication: the result is capped anyway,
  // and an unbounded shift would lose integer precision on absurd attempt counts.
  const step = Math.min(Math.floor(attempt) - 2, 16)
  return Math.min(REMOTE_STREAM_RETRY_BASE_MS * 2 ** step, REMOTE_STREAM_RETRY_MAX_MS)
}
