/**
 * Carrier-retry pacing for {@link RemoteStream} (design 14 §D4).
 * Upstream's `waitForRemoteStreamRetry` treats a SECOND carrier failure inside
 * one LIVE connection generation as terminal (`throw error`); the gateway wraps
 * that carrier error as `gateway/internal` and the session controller latches it
 * on `failEventStream()`, so the conversation surface never reopens. A mux
 * socket can legitimately die several times inside one live generation (protocol
 * proxy churn, missed heartbeats, upstream close under load), so the retry lane
 * paces and reopens instead of escaping.
 * This module owns ONLY the delay math: pure, no imports, so the policy is
 * unit-testable without the vendor dependency graph.
 * The numbers are not arbitrary: the ceiling equals the connection lane's own
 * `backoffMaxMs` default (10_000, `dsh-client-connection/src/recovery-config.ts`,
 * restated as `DEFAULT_MIN_RESTART_INTERVAL_MS` in its `liveness-triggers.ts`), so
 * a keep-failing carrier reopens no faster than the lane would restart the
 * transport itself. The base is half that lane's `backoffBaseMs` (500): a stream
 * reopen is cheaper than a transport restart and restores the event stream
 * sooner, while staying far from a hot loop.
 */

/** First carrier failure of an episode reopens immediately. */
export const REMOTE_STREAM_RETRY_FIRST_MS = 0

/** Backoff base for the second and every later failure inside one live generation. */
export const REMOTE_STREAM_RETRY_BASE_MS = 250

/** Backoff ceiling: a persistent carrier fault reopens at most this slowly. */
export const REMOTE_STREAM_RETRY_MAX_MS = 10_000

/**
 * Upper bound on the retry lane's wait for a live connection generation.
 * Upstream's wait subscribes to the generation source and resolves only when a
 * generation appears — with the lane parked (offline suspension, or a lane that
 * stopped restarting) that is an UNBOUNDED wait with no timer, no error edge and
 * no reopen attempt: the conversation surface sits on `openState='loading'`
 * forever while every other stream on the same mux keeps working. Past this
 * bound the wait resolves so the caller reopens the stream; a reopen is the one
 * action that can recover when the mux itself is still usable (measured: opening
 * a stream works even while the lane reports no generation). The reopen keeps the
 * episode's backoff, so an unrecoverable lane degrades to one attempt per
 * retry-ceiling instead of a hot loop.
 */
export const REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS = 30_000

/**
 * Abortable backoff wait for the carrier's live-generation retry branch.
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

/**
 * Minimum distance between two mux-client connect attempts started by the mux
 * itself: a lost socket triggers one immediate
 * reconnect instead of waiting for the connection lane, but a flapping network
 * must not let the mux hot-loop faster than the lane's own backoff would.
 */
export const REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS = 1_000

/**
 * Ceiling of the mux's own reconnect interval.
 * Every failed self-heal attempt doubles the interval up to this bound, so a
 * parked connection lane cannot be hammered faster than its own backoff ceiling
 * (REMOTE_STREAM_RETRY_MAX_MS, the lane's `backoffMaxMs` default) while the mux
 * still never parks permanently.
 */
export const REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS = 10_000

/**
 * Stable key for one logical stream's opening-budget episode: the endpoint plus a
 * bounded FNV-1a digest of its request payload.
 * The opening budget widens per CONSECUTIVE timeout; keying it by endpoint alone
 * would let one slow session reset another's budget (every session follow shares
 * the endpoint), and keying it globally let any stream reset
 * it — in both cases a genuinely slow Host session is retried every 30 s, each
 * retry cancelling the subscription it was waiting for. The digest is only an
 * episode marker: collisions merely share a widening budget, never behaviour.
 * @param endpoint - Typert Remote stream endpoint.
 * @param payload - endpoint request encoded on the wire.
 * @returns a stable key for this logical stream's request.
 */
export function streamOpeningKey(endpoint: string, payload: unknown): string {
  let text: string
  try {
    text = typeof payload === 'string' ? payload : (JSON.stringify(payload) ?? '')
  } catch {
    // A cyclic or otherwise unencodable payload still needs a key: shared '' is
    // acceptable because the key only paces retries.
    text = ''
  }
  let hash = 0x811c9dc5
  const input = endpoint + '\u0000' + text
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return endpoint + '#' + hash.toString(16)
}

