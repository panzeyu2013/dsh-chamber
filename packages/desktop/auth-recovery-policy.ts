/**
 * The bounded auth-recovery decision (design 27 §3.3): a gateway ready push whose
 * auth material is already dead unregisters the proxy and must re-verify the
 * session. Two rules, pure and testable without a plane:
 *
 * 1. at most one recovery per `minIntervalMs` (a second bad push inside the
 *    window must not hammer the gateway);
 * 2. a throttled attempt is DEFERRED, never dropped — returning into
 *    "ready but unregistered" with no future edge was the bug this replaces.
 */

export interface AuthRecoveryDecision {
  /** 'now' starts the recovery in this turn; 'defer' arms one timer. */
  readonly action: 'now' | 'defer'
  readonly delayMs: number
}

/**
 * @param now           epoch-ms of this observation
 * @param lastAttemptAt epoch-ms of the last started recovery (0 = never)
 * @param minIntervalMs throttle window
 */
export function authRecoveryDecision(now: number, lastAttemptAt: number, minIntervalMs: number): AuthRecoveryDecision {
  // A clock we cannot reason about never blocks recovery: acting once is the safe
  // side (the recovery itself is guarded by phase/url/scope checks).
  if (!Number.isFinite(now) || !Number.isFinite(lastAttemptAt) || !Number.isFinite(minIntervalMs)) {
    return { action: 'now', delayMs: 0 }
  }
  // 0 is the "never attempted" sentinel (a fresh instance), not an epoch-ms value.
  if (lastAttemptAt <= 0) return { action: 'now', delayMs: 0 }
  const elapsed = now - lastAttemptAt
  if (elapsed >= minIntervalMs) return { action: 'now', delayMs: 0 }
  // Also covers a backwards clock (negative elapsed): wait out the full window
  // instead of scheduling a negative/zero timer into a hot loop.
  const delayMs = Math.min(minIntervalMs, Math.max(1, Math.ceil(minIntervalMs - elapsed)))
  return { action: 'defer', delayMs }
}
