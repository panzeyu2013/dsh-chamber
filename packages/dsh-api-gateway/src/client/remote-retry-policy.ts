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

/**
 * Opening-item deadline for one logical Remote stream (chamber fork patch,
 * design 14 §D4 2026-09 ui-chat freeze investigation).
 *
 * Every logical stream is answered by its Host with an opening item (a snapshot
 * or a ready frame); the domain consumer awaits that first item with NO deadline
 * anywhere between the socket and the UI. A frame that is lost — discarded by a
 * socket that started closing between `waitForSocket` and `send`, dropped by a
 * revoked splice, or never produced by a stalled Host fiber — therefore hung the
 * conversation forever: `Session.doOpen` stayed pending, the chat view rendered
 * `chat.loadingHistory` (which upstream renders exactly when `openState ===
 * 'loading'`), no error edge ever fired, and every chamber heal arm (all keyed on
 * `'error'`) was blind to it. 30 s is far above the measured Host answer
 * (opening frames arrive in ~25 ms through the control-plane proxy) while staying
 * below a user's "this is stuck" threshold.
 */
export const REMOTE_STREAM_OPENING_TIMEOUT_MS = 30_000

/** Ceiling of the consecutive-timeout widening (4× the base). */
export const REMOTE_STREAM_OPENING_TIMEOUT_MAX_MS = 120_000

/**
 * Minimum distance between two mux-client connect attempts started by the mux
 * itself (chamber patch, 2026-09 review): a lost socket triggers one immediate
 * reconnect instead of waiting for the connection lane, but a flapping network
 * must not let the mux hot-loop faster than the lane's own backoff would.
 */
export const REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS = 1_000

/**
 * Deadline for one WebSocket handshake (TCP + upgrade), chamber patch (2026-09
 * review). Without it a socket that never fires open/error/close parks every
 * open() until the connection lane's own readiness timeout (15 s local / 45 s
 * remote) aborts the generation, and the mux's self-heal cannot arm while that
 * attempt is in flight. Expiring the attempt as a carrier-style failure feeds the
 * same rescheduling heal.
 */
export const REMOTE_STREAM_HANDSHAKE_TIMEOUT_MS = 30_000

/**
 * Ceiling of the mux's own reconnect interval (chamber patch, 2026-09 review).
 * Every failed self-heal attempt doubles the interval up to this bound, so a
 * parked connection lane cannot be hammered faster than its own backoff ceiling
 * (REMOTE_STREAM_RETRY_MAX_MS, the lane's `backoffMaxMs` default) while the mux
 * still never parks permanently.
 */
export const REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS = 10_000

/**
 * Stable key for one logical stream's opening-budget episode: the endpoint plus a
 * bounded FNV-1a digest of its request payload.
 *
 * The opening budget widens per CONSECUTIVE timeout; keying it by endpoint alone
 * would let one slow session reset another's budget (every session follow shares
 * the endpoint), and keying it globally (the first version) let any stream reset
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

/**
 * Opening-item budget for one logical stream REQUEST, widened by that request's
 * own CONSECUTIVE opening timeouts.
 *
 * The widening exists so a genuinely slow-but-working Host — a huge session over
 * a cold link, a loaded disk — is never starved by a deadline tuned for the
 * ordinary case: the request's first attempt waits 30 s, the next 60 s, then
 * 120 s. The budget is keyed by {@link streamOpeningKey}, so a normal answer for
 * THIS request resets only its own key (the mux deletes that key on the first
 * delivered frame) and never another request's: a stream that answers normally
 * always keeps the tight 30 s bound, while one slow request keeps its widening.
 * @param streak - that request's consecutive opening-item timeouts so far (0-based).
 * @returns milliseconds to wait for the opening item before failing the inbox.
 */
export function remoteStreamOpeningTimeoutMs(streak: number): number {
  if (!Number.isFinite(streak) || streak <= 0) return REMOTE_STREAM_OPENING_TIMEOUT_MS
  const step = Math.min(Math.floor(streak), 2)
  return Math.min(REMOTE_STREAM_OPENING_TIMEOUT_MS * 2 ** step, REMOTE_STREAM_OPENING_TIMEOUT_MAX_MS)
}
