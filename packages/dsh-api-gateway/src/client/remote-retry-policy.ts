/**
 * Carrier-retry pacing for {@link RemoteStream}: upstream treats a second carrier
 * failure inside one live generation as terminal and the session controller latches
 * it, so the surface never reopens — yet a mux socket can legitimately die several
 * times per generation, so this lane paces and reopens instead of escaping (delay
 * math only, pure). Ceiling = the connection lane's own `backoffMaxMs` default
 * (10_000); base 250 is half its `backoffBaseMs` (500), since a stream reopen is
 * cheaper than a transport restart. The single-tier opening deadline and the
 * silent-teardown floor live in the shared stream-state tables, read by the mux client.
 */

/** First carrier failure of an episode reopens immediately. */
export const REMOTE_STREAM_RETRY_FIRST_MS = 0

/** Backoff base for the second and every later failure inside one live generation. */
export const REMOTE_STREAM_RETRY_BASE_MS = 250

/** Backoff ceiling: a persistent carrier fault reopens at most this slowly. */
export const REMOTE_STREAM_RETRY_MAX_MS = 10_000

/**
 * Upper bound on the retry lane's wait for a live connection generation: upstream
 * waits unbounded when the lane is parked, leaving the surface on
 * `openState='loading'` forever. Past this bound the caller reopens anyway (the
 * one action that can recover on a still-usable mux), keeping the episode's
 * backoff so an unrecoverable lane degrades to one attempt per ceiling.
 */
export const REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS = 30_000

/** Abortable backoff wait (here, not in the carrier, so the abort contract is
 *  exercisable without the vendor graph). Resolves after the delay, rejects on abort. */
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

/** Delay before reopening after carrier failure number `attempt` (1-based, reset per
 *  episode): attempt 1 is immediate; later attempts keep at least HALF of a doubling
 *  backoff and jitter the other half, so a persistent fault settles at one reopen per
 *  ceiling instead of a hot loop while N logical streams failed by one carrier do not
 *  re-issue in lockstep. Jitter never lowers the wait below half the effective
 *  backoff, so it spreads the herd without turning the pace into a hot loop. */
export function remoteStreamRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  if (!Number.isFinite(attempt) || attempt <= 1) return REMOTE_STREAM_RETRY_FIRST_MS
  // Clamp the exponent before the multiplication: the result is capped anyway,
  // and an unbounded shift would lose integer precision on absurd attempt counts.
  const step = Math.min(Math.floor(attempt) - 2, 16)
  const effective = Math.min(REMOTE_STREAM_RETRY_BASE_MS * 2 ** step, REMOTE_STREAM_RETRY_MAX_MS)
  // Half-jitter over the CAPPED backoff (the transport lane's rule, so the whole
  // product keeps one shape). A broken injected RNG must never take the retry lane
  // down: a throw or a non-finite sample falls back to the un-jittered backoff,
  // out-of-range samples are clamped, and the final floor+cap keeps the value an
  // integer <= the ceiling.
  let sample: number
  try {
    sample = random()
  } catch {
    return effective
  }
  const bounded = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 1
  return Math.min(Math.floor(effective * (0.5 + 0.5 * bounded)), effective)
}

/** Maximum extra wait attached to each logical stream's FIRST reopen after one
 *  physical carrier failure. The mux fails every stream on a socket at the same
 *  instant, and attempt 1 has no backoff, so without this spread the whole fan-out
 *  re-issued in lockstep against the replacement socket. The failure itself is still
 *  delivered synchronously — only the reopen is spread, by at most this bound. */
export const REMOTE_STREAM_REOPEN_JITTER_MAX_MS = 250

/** Draw the per-stream first-reopen spread in [0, {@link REMOTE_STREAM_REOPEN_JITTER_MAX_MS}].
 *  A broken injected RNG fails safe to 0 (reopen immediately) instead of throwing into
 *  the retry lane or inventing a wait; out-of-range samples clamp. */
export function remoteStreamReopenJitterMs(random: () => number = Math.random): number {
  let sample: number
  try {
    sample = random()
  } catch {
    return 0
  }
  if (!Number.isFinite(sample)) return 0
  const bounded = Math.min(Math.max(sample, 0), 1)
  return Math.floor(bounded * REMOTE_STREAM_REOPEN_JITTER_MAX_MS)
}

/** Minimum distance between two mux-client connect attempts started by the mux
 *  itself: a lost socket reconnects immediately instead of waiting for the lane,
 *  but a flapping network must not let the mux hot-loop past the lane's backoff. */
export const REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS = 1_000

/** Ceiling of the mux's own reconnect interval: every failed self-heal doubles the
 *  interval up to this bound, so a parked lane is never hammered past its backoff
 *  ceiling while the mux still never parks permanently. */
export const REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS = 10_000

/**
 * How long an OPEN socket must have lived, without delivering a frame, before its
 * mere lifetime counts as recovery evidence and may reset the self-heal cadence.
 * A bare `open` is NOT evidence: a path that accepts the handshake and immediately
 * drops would otherwise reset the widening on every attempt and reconnect at the
 * 1 s floor forever. The window outlives every backoff rung above
 * ({@link REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS}), so only a socket that survived a
 * whole flapping cycle restores the base pace.
 */
export const REMOTE_STREAM_STABLE_CARRIER_MIN_MS = 30_000

/** Stable key for one logical stream's opening-streak episode: endpoint plus a
 *  bounded FNV-1a digest of the request payload. Keying by endpoint alone would let
 *  one slow session reset another's consecutive-miss count (follows share the
 *  endpoint), and a global key let any stream reset it; collisions only share it. */
export function streamOpeningKey(endpoint: string, payload: unknown): string {
  let text: string
  try {
    text = typeof payload === 'string' ? payload : (JSON.stringify(payload) ?? '')
  } catch {
    // Unencodable payload still needs a key; '' only paces retries.
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

