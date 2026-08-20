/**
 * Decide which ready sources need an authoritative unary aggregate refresh.
 *
 * A mounted producer normally suppresses unary work. The exception is a
 * not-ready -> ready edge: the producer de-duplicates identical snapshots, so
 * it may have nothing new to publish after a reconnect even though the App
 * deliberately replaced the old aggregate with `not-connected`. One pull per
 * connection generation restores the aggregate without reintroducing a timer.
 */
export function planAggregateRefreshes(
  readySourceIds: readonly string[],
  previouslyReady: ReadonlySet<string>,
  snapshotSources: Readonly<Record<string, true>>,
): { refreshSourceIds: string[]; nextReady: Set<string> } {
  const nextReady = new Set(readySourceIds)
  const refreshSourceIds = readySourceIds.filter(sourceId =>
    !previouslyReady.has(sourceId) || snapshotSources[sourceId] !== true,
  )
  return { refreshSourceIds, nextReady }
}

/**
 * Staleness predicate for the aggregate watchdog (the fallback net for a
 * mounted producer whose push channel silently died). A source is stale when
 * it never pushed a snapshot or its last push is older than the threshold —
 * recency is the only liveness signal the App has, since the unary client
 * does not expose per-source connection state.
 */
export function isSnapshotStale(
  lastSnapshotAt: number | undefined,
  now: number,
  stalenessMs: number,
): boolean {
  return lastSnapshotAt === undefined || now - lastSnapshotAt > stalenessMs
}
