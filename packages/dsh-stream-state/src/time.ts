/**
 * Time and window arithmetic (P1) - the single owner of the "usable clock" rule.
 *
 * WHY. Every reducer in this package compares timestamps, and each had grown its own
 * opinion about NaN/Infinity/rollback: decideRebuild refused a non-finite clock,
 * planLadder dispatched its most expensive tier on it, and presentation
 * re-derived elapsedSince locally. The I4 discipline is one
 * sentence - a clock we cannot compare may only hold, never release - so it lives
 * here once.
 *
 * PURITY: zero imports, no clock reads. Callers stamp observations; this module only
 * classifies them and keeps rolling ledgers inside their window.
 */

/** Is this a usable observation/decision time? NaN and both infinities are not. */
export function isUsableAt(at: number): boolean {
  return Number.isFinite(at)
}

/** A usable time, or the caller's conservative anchor (default 0). */
export function normalizeAt(at: number, fallback = 0): number {
  return Number.isFinite(at) ? at : fallback
}

/**
 * Elapsed time, or null when it cannot be trusted: an absent anchor, an unusable
 * side, or a clock that went backwards. Callers must HOLD on null - never release,
 * never re-arm at 0 ms.
 */
export function elapsedSince(startedAt: number | null, now: number): number | null {
  if (startedAt === null) return null
  const elapsed = now - startedAt
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null
}

/**
 * Count stamps strictly inside (now - windowMs, now].
 * An unusable window/clock counts everything: for a throttle that is the
 * conservative direction (the window looks full), and for a quota it spends the
 * ledger rather than granting a free dispatch.
 */
export function countWithin(stamps: readonly number[], now: number, windowMs: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(windowMs) || windowMs < 0) return stamps.length
  const start = now - windowMs
  let count = 0
  for (const stamp of stamps) {
    if (stamp > start) count += 1
  }
  return count
}

/**
 * Append `at` and drop every stamp that can no longer satisfy `stamp > now - windowMs`.
 * Returns a NEW array only when the set changed, so a caller can keep reference
 * equality when nothing aged out. An unusable `at` appends nothing.
 */
export function pushWindowed(
  stamps: readonly number[],
  at: number,
  now: number,
  windowMs: number,
): number[] {
  if (!Number.isFinite(at)) return stamps as number[]
  if (!Number.isFinite(now) || !Number.isFinite(windowMs) || windowMs < 0) return stamps as number[]
  const start = now - windowMs
  const next = stamps.filter((stamp) => stamp > start)
  next.push(at)
  return next
}
