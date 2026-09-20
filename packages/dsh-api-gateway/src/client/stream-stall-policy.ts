/**
 * Silence-watchdog policy for one logical journal stream — chamber fork patch
 * (design 14 §D4, 2026-09 ui-chat freeze investigation).
 *
 * `RemoteJournalStream` publishes a window and then waits for the next item with
 * no deadline of any kind. A subscription that goes silently dead while the
 * Host keeps producing (the "open and no longer delivering" class) therefore
 * freezes the transcript with no visible error, and every chamber heal arm —
 * all keyed on `openState === 'error'` — is blind to it.
 *
 * The decision here is deliberately NOT an idle timeout that restarts the
 * stream: legal silence is real (TTFT is measured in tens of seconds and a
 * single tool call can run for minutes), and design 14 §D4 rejected a blind
 * shape timeout for exactly that reason. Instead the watchdog PROBES: the
 * journal opens a sibling follow and compares its opening cursor with the
 * applied one, and only an actually-advanced Host cursor justifies replacing
 * the generation. No advance means the silence is genuine, so nothing churns.
 *
 * This module owns ONLY the timing decision: pure, zero imports, unit-testable
 * without the vendor dependency graph.
 */

/** Timing of the silence watchdog for one journal stream. */
export interface StreamStallTiming {
  /** Watchdog tick cadence. */
  readonly tickMs: number
  /** Silence (no published item) before the first Host probe. */
  readonly probeAfterMs: number
  /** Minimum distance between two probes while the stream stays silent. */
  readonly probeIntervalMs: number
  /** Deadline for one probe's opening frame. */
  readonly probeTimeoutMs: number
  /** Quiet period after a restart before another probe may replace the generation. */
  readonly restartCooldownMs: number
  /**
   * Deadline for one user-initiated history read (`prepend`). Such a read uses
   * the stream's LIFETIME signal, so a generation restart cannot abort it — a
   * hung page request would leave "load older" stuck forever with no error edge.
   */
  readonly readDeadlineMs: number
}

/**
 * Defaults, and why they are these numbers:
 *
 * - `probeAfterMs` 45 s: below the 75 s TTFT ceiling recorded in design 14 §D4,
 *   so an actively-producing Host is noticed well before a user calls the view
 *   stuck, while a probe is a read-only sibling follow (no visible effect).
 * - `probeIntervalMs` 45 s / `tickMs` 15 s: at most one extra snapshot read per
 *   45 s of silence, sampled at a 15 s granularity — bounded cost per stream.
 * - `probeTimeoutMs` 20 s: a probe opening is mandatory protocol traffic; the
 *   measured Host answer through the proxy is ~25–75 ms, so 20 s is a very
 *   generous cap that only a broken path can hit.
 * - `restartCooldownMs` 60 s: after a generation replacement, give the fresh
 *   subscription time to deliver before the next probe can act.
 */
export const DEFAULT_STREAM_STALL_TIMING: StreamStallTiming = {
  tickMs: 15_000,
  probeAfterMs: 45_000,
  probeIntervalMs: 45_000,
  probeTimeoutMs: 20_000,
  restartCooldownMs: 60_000,
  readDeadlineMs: 60_000,
}

/** Upper bound of the per-stream probe interval while silence persists. */
export const MAX_STREAM_STALL_PROBE_INTERVAL_MS = 90_000

/**
 * Probe interval for a stream whose silence has already survived `quietProbes`
 * probes that found NO Host advance.
 *
 * A stream that is simply dormant (nothing is being produced) must not cost a
 * sibling snapshot read every 45 s forever: each consecutive "no advance" probe
 * doubles the interval, clamped by {@link MAX_STREAM_STALL_PROBE_INTERVAL_MS}.
 * With the shipped base (45 s) and cap (90 s) exactly ONE doubling is reachable —
 * 45 s, then 90 s for as long as the silence lasts; the exponent clamp only keeps
 * a wider custom timing from overflowing. The first probe after real silence
 * stays prompt (45 s), and any published item or a generation replacement resets
 * the streak, so an actively-producing Host is still noticed within one base
 * interval.
 * @param quietProbes - consecutive probes that found no advance (0-based).
 * @param timing - resolved timing.
 * @returns milliseconds before the next probe is allowed.
 */
export function streamStallProbeIntervalMs(quietProbes: number, timing: StreamStallTiming): number {
  if (!Number.isFinite(quietProbes) || quietProbes <= 0) return timing.probeIntervalMs
  const step = Math.min(Math.floor(quietProbes), 5)
  return Math.min(timing.probeIntervalMs * 2 ** step, MAX_STREAM_STALL_PROBE_INTERVAL_MS)
}

/** One watchdog decision. */
export type StreamStallAction = 'wait' | 'probe'

/** Observable watchdog inputs at one tick. */
export interface StreamStallClock {
  /** Wall clock (ms) at this tick. */
  readonly now: number
  /** When the journal last published an item (opening included). */
  readonly lastProgressAt: number
  /** When the last probe started, if any. */
  readonly lastProbeAt?: number | undefined
  /** When the last generation replacement was triggered, if any. */
  readonly lastRestartAt?: number | undefined
  /** Whether a probe is still in flight (never overlap probes). */
  readonly probing: boolean
  /** Consecutive probes that found no Host advance (widens the cadence). */
  readonly quietProbes: number
}

/**
 * Decide whether this tick should probe the Host for newer content.
 *
 * `'probe'` means "start exactly one sibling follow"; it never means "restart":
 * the restart decision belongs to the caller and requires the probe to prove an
 * advanced cursor.
 * @param clock - watchdog inputs for this tick.
 * @param timing - resolved timing (see {@link DEFAULT_STREAM_STALL_TIMING}).
 * @returns `'probe'` when a probe is due and allowed, `'wait'` otherwise.
 */
export function decideStreamStallAction(clock: StreamStallClock, timing: StreamStallTiming): StreamStallAction {
  if (clock.probing) return 'wait'
  const silenceMs = clock.now - clock.lastProgressAt
  if (!Number.isFinite(silenceMs) || silenceMs < timing.probeAfterMs) return 'wait'
  if (clock.lastRestartAt !== undefined && clock.now - clock.lastRestartAt < timing.restartCooldownMs) return 'wait'
  const intervalMs = streamStallProbeIntervalMs(clock.quietProbes, timing)
  if (clock.lastProbeAt !== undefined && clock.now - clock.lastProbeAt < intervalMs) return 'wait'
  return 'probe'
}
