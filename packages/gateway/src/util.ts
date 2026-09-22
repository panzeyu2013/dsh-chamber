/**
 * Small gateway-wide helpers, single-sourced rather than copied per module.
 */

/** The error's message, or the stringified non-Error throw. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Stable newest-first order by `ts`; ties (same-ms appends) break toward
 * later insertion, matching the journal/deferred-intent projections. */
export function newestFirst<T extends { ts: number }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.ts - a.item.ts || b.index - a.index)
    .map(entry => entry.item)
}
