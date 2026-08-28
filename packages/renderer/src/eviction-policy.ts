/**
 * Pure idle-eviction policy for auto-prewarmed views (P2, design 05 §4
 * exception clause). Extracted from App.tsx so the 15min/10min boundaries
 * are unit-tested; the App eviction scan applies it per prewarmed view.
 */

/** The runtime-facts projection the policy needs: per-session running/pending
 *  bits only. The design-19 §3.2 notification-edge invariant requires BOTH to
 *  be absent — a running or pending session can still emit an edge (running →
 *  idle completion / pending arming), so such a view must never be evicted. */
export interface EvictionFacts {
  sessions: Record<string, { running?: boolean; completed?: boolean; pending?: unknown } | undefined>
}

/** True when a settled, non-active prewarmed view may be idle-evicted:
 *  settled for at least `idleEvictMs`, not the active view, and holding zero
 *  running/pending sessions (or no facts at all — the disconnected window has
 *  no edges to emit; design 19 §3.2 seeds silently on first report). */
export function isIdleEvictable(input: {
  settledAt: number | undefined
  now: number
  idleEvictMs: number
  isActiveView: boolean
  facts: EvictionFacts | undefined
}): boolean {
  if (input.settledAt === undefined || input.now - input.settledAt < input.idleEvictMs) return false
  if (input.isActiveView) return false
  if (input.facts !== undefined) {
    for (const session of Object.values(input.facts.sessions)) {
      if (session?.running === true || session?.pending !== undefined) return false
    }
  }
  return true
}

/** Evict→re-prewarm churn guard: an evicted id may re-enter the prewarm
 *  eligibility only after the cooldown window (`PREWARM_COOLDOWN_MS`).
 *  `undefined` (never evicted) is never within a cooldown. */
export function isWithinCooldown(evictedAt: number | undefined, now: number, cooldownMs: number): boolean {
  return evictedAt !== undefined && now < evictedAt + cooldownMs
}
