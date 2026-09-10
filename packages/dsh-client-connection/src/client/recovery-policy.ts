/**
 * chamber patch (2026-09, Batch 2 follow-up): per-source connection-recovery
 * timing.
 *
 * ## Why this exists
 *
 * Upstream resolves the recovery timing ONCE per page from the host-injected
 * `__DSH_CONNECTION_RECOVERY__` global, falling back to the schema defaults
 * (3 s warn / 15 s hard deadline). Under the chamber shell that page global is
 * ABSENT — the frontend page is served by the control plane (only
 * `__DSH_BOOT__` is injected), while the instance's own host half injects the
 * global only into pages it serves. So every chamber instance runs the 15 s
 * deadline, which is tuned for a loopback host: a cold SSH tunnel or a slow
 * remote link can legitimately need longer to complete the generation
 * readiness handshake, and an aborted generation is retried from scratch —
 * a slow-but-working source would livelock below the deadline forever.
 *
 * Upstream's supported seam for this is the per-loop config of
 * `ctx.connection.start(sinks, config)` (it merges over the page-global
 * resolution), so the chamber api-gateway fork passes these overrides for
 * remote sources. Local sources keep the upstream defaults: a loopback host
 * needs no extra patience, and a shorter deadline detects a dead local host
 * sooner.
 *
 * Values: 45 s deadline / 5 s warn for remote sources — 3× the upstream
 * deadline, covering a cold tunnel build plus TLS/webserver startup, while
 * still bounding a genuinely dead path to a retry every ~45 s (the retry
 * itself is immediate, so a recovering link connects as soon as it is up).
 */

/** The recovery-timing subset the chamber overrides per source. */
export interface ConnectionRecoveryOverrides {
  /** Slow-handshake warning delay (log only). */
  readonly generationReadyWarnMs?: number
  /** Hard deadline for generation readiness, including physical setup. */
  readonly generationReadyTimeoutMs?: number
}

/** Slow-handshake warning for remote sources (5 s; upstream default 3 s). */
export const REMOTE_GENERATION_READY_WARN_MS = 5_000
/** Generation-readiness deadline for remote sources (45 s; upstream default 15 s). */
export const REMOTE_GENERATION_READY_TIMEOUT_MS = 45_000

/**
 * Recovery overrides for one entry's transport. `ssh` and `http` sources cross
 * a real network (tunnel or direct remote host) and get the widened deadline;
 * everything else — `local`, unknown or absent transports — keeps the upstream
 * defaults by returning no overrides.
 * @param transport - the per-entry `ctx.chamberTransport` value (untrusted shape).
 * @returns the overrides to hand to `connection.start(sinks, config)`.
 */
export function recoveryOverridesForTransport(transport: unknown): ConnectionRecoveryOverrides {
  if (transport !== 'ssh' && transport !== 'http') return {}
  return {
    generationReadyWarnMs: REMOTE_GENERATION_READY_WARN_MS,
    generationReadyTimeoutMs: REMOTE_GENERATION_READY_TIMEOUT_MS,
  }
}
