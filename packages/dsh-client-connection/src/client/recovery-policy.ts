/**
 * Per-source connection-recovery timing: upstream resolves it once per page from
 * the host-injected `__DSH_CONNECTION_RECOVERY__` global, which the chamber shell
 * does not carry, so every instance would run the loopback-tuned 15 s deadline and
 * a working-but-slow remote source (cold SSH tunnel) would livelock below it.
 * The fork widens `ssh`/`http`; local/unknown keep upstream defaults. 45 s/5 s =
 * 3× upstream, bounding a genuinely dead path to one retry per ~45 s.
 */

/** The recovery-timing subset the chamber overrides per source. */
export interface ConnectionRecoveryOverrides {
  readonly generationReadyWarnMs?: number
  /** Hard deadline for generation readiness, including physical setup. */
  readonly generationReadyTimeoutMs?: number
}

/** Slow-handshake warning for remote sources (5 s; upstream default 3 s). */
export const REMOTE_GENERATION_READY_WARN_MS = 5_000
/** Generation-readiness deadline for remote sources (45 s; upstream default 15 s). */
export const REMOTE_GENERATION_READY_TIMEOUT_MS = 45_000

/** Overrides for one entry's transport: `ssh`/`http` get the widened deadline;
 *  `local`, unknown or absent transports keep the upstream defaults. */
export function recoveryOverridesForTransport(transport: unknown): ConnectionRecoveryOverrides {
  if (transport !== 'ssh' && transport !== 'http') return {}
  return {
    generationReadyWarnMs: REMOTE_GENERATION_READY_WARN_MS,
    generationReadyTimeoutMs: REMOTE_GENERATION_READY_TIMEOUT_MS,
  }
}
