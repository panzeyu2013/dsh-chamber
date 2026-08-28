/**
 * Pure N-ctx reclamation decisions (design 05 §4, registry-removal reap):
 * which mounted views a registry change removes, whether the active view must
 * fall back, and which dead keys each of the parallel per-instance key spaces
 * must prune to stay converged with the registry. Extracted from App.tsx's
 * reclamation effect so the multi-key-space pruning discipline is unit-tested;
 * App.tsx only applies the decisions (side effects: teardownView + setState /
 * ref pruning). Decision-only: no DOM, no React, no shell calls.
 *
 * Behavior contract (must stay identical to the App.tsx effect it was
 * extracted from): a view's lifetime equals its registry entry's lifetime —
 * only a source REMOVED from the registry reaps its view; connection
 * failure/manual disconnect never reaps (that is eviction-policy.ts's idle
 * prewarm domain, this module is the removal reap). `local` 常驻.
 */

/** View-level reclamation plan for one effect pass over the registry projection. */
export interface ViewRecyclePlan {
  /** Mounted views absent from the live registry projection — tear each down
   *  (dispose shell + release client + drop parallel keys). The fallback view
   *  ('local') is always live, so it can never appear here. */
  removedViews: string[]
}

/** Which mounted views a registry change removes (design 05 §4: view lifetime
 *  = registry entry lifetime). */
export function planViewRecycle(input: {
  mountedViews: readonly string[]
  liveViewIds: ReadonlySet<string>
}): ViewRecyclePlan {
  return { removedViews: input.mountedViews.filter(id => !input.liveViewIds.has(id)) }
}

/** Active-view fallback decision: keep the current view when it IS the
 *  fallback itself (local 常驻) or when it is still live; otherwise fall back
 *  to `fallbackView`. Designed to run INSIDE the setActiveView functional
 *  updater — it reads the latest committed `prev`, never a stale effect
 *  closure (the reclamation effect deliberately omits activeView from its
 *  deps). */
export function nextActiveView(prev: string, liveViewIds: ReadonlySet<string>, fallbackView: string): string {
  if (prev === fallbackView) return prev
  if (liveViewIds.has(prev)) return prev
  return fallbackView
}

/** Keys of `record` absent from `liveKeys` — the dead keys a reaped instance
 *  leaves behind. `undefined` records (no entry yet) have no dead keys. */
export function deadKeys<T>(record: Record<string, T> | undefined, liveKeys: ReadonlySet<string>): string[] {
  if (record === undefined) return []
  return Object.keys(record).filter(id => !liveKeys.has(id))
}

/** Members of a key SET (the readyAggregateSources ref is Set-backed) absent
 *  from `liveKeys` — the same dead-key discipline for Set key spaces. */
export function deadSetKeys(set: ReadonlySet<string>, liveKeys: ReadonlySet<string>): string[] {
  const dead: string[] = []
  for (const id of set) {
    if (!liveKeys.has(id)) dead.push(id)
  }
  return dead
}

/** Identity-preserving prune of ONE per-instance key space: `changed:false`
 *  with `next === record` (same reference) when nothing is dead, so the
 *  caller's setState updater keeps the previous state object and React skips
 *  the re-render; otherwise a fresh record without the dead keys. Collapses
 *  the App updater contract (`return changed ? next : prev`) to
 *  `pruneRecordKeys(prev, live).next`. */
export function pruneRecordKeys<T>(
  record: Record<string, T>,
  liveKeys: ReadonlySet<string>,
): { next: Record<string, T>; changed: boolean } {
  const dead = deadKeys(record, liveKeys)
  if (dead.length === 0) return { next: record, changed: false }
  const next = { ...record }
  for (const id of dead) delete next[id]
  return { next, changed: true }
}

/** The live raw-id set for the remoteStatus projection: status is keyed by the
 *  RAW registry id (deriveServers's statusKey), while the servers projection
 *  carries the `ssh-<id>` PREFIXED view id — strip the 4-char prefix back.
 *  Non-ssh kinds (local) keep their id verbatim. */
export function rawStatusLiveIds(servers: ReadonlyArray<{ id: string; kind: string }>): ReadonlySet<string> {
  const liveRaw = new Set<string>()
  for (const server of servers) {
    liveRaw.add(server.kind === 'local' ? 'local' : server.id.slice(4))
  }
  return liveRaw
}
