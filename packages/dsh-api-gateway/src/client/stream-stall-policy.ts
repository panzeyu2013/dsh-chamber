/**
 * Silence-watchdog policy for one logical journal stream.
 *
 * `RemoteJournalStream` publishes a window and then waits for the next item with no
 * deadline, so a subscription that goes silently dead while the Host keeps
 * producing freezes the transcript with no visible error, and every heal arm keyed
 * on 'error' is blind to it. Legal silence is real (TTFT tens of seconds; a tool
 * call can run minutes), so the watchdog PROBES instead of timing out blind: the
 * journal opens a sibling follow, and only an actually-advanced Host cursor
 * justifies replacing the generation (no advance = genuine silence, nothing churns).
 * Timing decision only: pure, zero imports.
 */

/** Timing of the silence watchdog for one journal stream. */
export interface StreamStallTiming {
  readonly tickMs: number
  /** Silence (no published item) before the first Host probe. */
  readonly probeAfterMs: number
  readonly probeIntervalMs: number
  readonly probeTimeoutMs: number
  /** Quiet period after a restart before another probe may replace the generation. */
  readonly restartCooldownMs: number
  /** Deadline for one user-initiated `prepend` read: it uses the stream's LIFETIME
   *  signal, so a generation restart cannot abort it and a hung request would stick. */
  readonly readDeadlineMs: number
}

/**
 * Why these numbers: `probeAfterMs` 45 s sits below the 75 s TTFT ceiling, so an
 * actively-producing Host is noticed before a user calls the view stuck (a probe is
 * a read-only sibling follow); `probeIntervalMs` 45 s at `tickMs` 15 s bounds the
 * snapshot cost per silent stream; `probeTimeoutMs` 20 s is generous against a
 * ~25–75 ms proxied answer; `restartCooldownMs` 60 s gives a replacement time to
 * deliver before the next probe may act.
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

/** Probe interval once `quietProbes` consecutive probes found no Host advance: each
 *  doubles the interval up to {@link MAX_STREAM_STALL_PROBE_INTERVAL_MS}, so a dormant
 *  stream stops costing a snapshot read every 45 s. With the shipped base/cap exactly
 *  one doubling is reachable; any published item or generation replacement resets it. */
export function streamStallProbeIntervalMs(quietProbes: number, timing: StreamStallTiming): number {
  if (!Number.isFinite(quietProbes) || quietProbes <= 0) return timing.probeIntervalMs
  const step = Math.min(Math.floor(quietProbes), 5)
  return Math.min(timing.probeIntervalMs * 2 ** step, MAX_STREAM_STALL_PROBE_INTERVAL_MS)
}

/** One watchdog decision. */
export type StreamStallAction = 'wait' | 'probe'

/** Observable watchdog inputs at one tick. */
export interface StreamStallClock {
  readonly now: number
  /** When the journal last published an item (opening included). */
  readonly lastProgressAt: number
  readonly lastProbeAt?: number | undefined
  readonly lastRestartAt?: number | undefined
  /** Never overlap probes. */
  readonly probing: boolean
  /** Consecutive probes that found no Host advance (widens the cadence). */
  readonly quietProbes: number
}

/** Decide whether this tick should probe the Host. `'probe'` means "start exactly
 *  one sibling follow", never "restart": the restart decision belongs to the caller
 *  and requires the probe to prove an advanced cursor. */
export function decideStreamStallAction(clock: StreamStallClock, timing: StreamStallTiming): StreamStallAction {
  if (clock.probing) return 'wait'
  const silenceMs = clock.now - clock.lastProgressAt
  if (!Number.isFinite(silenceMs) || silenceMs < timing.probeAfterMs) return 'wait'
  if (clock.lastRestartAt !== undefined && clock.now - clock.lastRestartAt < timing.restartCooldownMs) return 'wait'
  const intervalMs = streamStallProbeIntervalMs(clock.quietProbes, timing)
  if (clock.lastProbeAt !== undefined && clock.now - clock.lastProbeAt < intervalMs) return 'wait'
  return 'probe'
}
