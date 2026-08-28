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

/** Renderer-local generation/ownership facts whose lifetime is exactly one
 * authoritative roster entry. Kept separate from React state so a roster
 * removal can invalidate an old unary result synchronously, before the render
 * that eventually removes the source row. */
export interface AggregateLifecycleState {
  failuresBySource: Record<string, number>
  snapshotAtBySource: Record<string, number>
  snapshotSources: Record<string, true>
  readySources: Set<string>
}

export interface AggregateLifecycleInvalidation extends AggregateLifecycleState {
  removedSourceIds: string[]
}

/**
 * Pure authoritative-roster transition for keyed aggregate facts. Async unary
 * ownership is retired separately through the active-only object-token
 * registry, so this state carries no historical sequence tombstones.
 */
export function invalidateRemovedAggregateSources(
  previousLiveSourceIds: ReadonlySet<string>,
  nextLiveSourceIds: ReadonlySet<string>,
  state: AggregateLifecycleState,
): AggregateLifecycleInvalidation {
  const removedSourceIds = [...previousLiveSourceIds].filter(id => !nextLiveSourceIds.has(id))
  if (removedSourceIds.length === 0) return { ...state, removedSourceIds }

  const failuresBySource = { ...state.failuresBySource }
  const snapshotAtBySource = { ...state.snapshotAtBySource }
  const snapshotSources = { ...state.snapshotSources }
  const readySources = new Set(state.readySources)
  for (const sourceId of removedSourceIds) {
    delete failuresBySource[sourceId]
    delete snapshotAtBySource[sourceId]
    delete snapshotSources[sourceId]
    readySources.delete(sourceId)
  }
  return {
    removedSourceIds,
    failuresBySource,
    snapshotAtBySource,
    snapshotSources,
    readySources,
  }
}

/** Identity-preserving source-list retirement used by mounted/prewarm queues. */
export function withoutRemovedSourceIds(
  sourceIds: string[],
  removedSourceIds: ReadonlySet<string>,
): string[] {
  if (removedSourceIds.size === 0) return sourceIds
  const next = sourceIds.filter(sourceId => !removedSourceIds.has(sourceId))
  return next.length === sourceIds.length ? sourceIds : next
}

/** Identity-preserving keyed-state retirement. `hasOwn` also clears keys whose
 * value is explicitly undefined (plugin-diagnostic state has that shape). */
export function withoutRemovedSourceKeys<T>(
  state: Record<string, T>,
  removedSourceIds: ReadonlySet<string>,
): Record<string, T> {
  let next: Record<string, T> | undefined
  for (const sourceId of removedSourceIds) {
    if (!Object.hasOwn(state, sourceId)) continue
    next ??= { ...state }
    delete next[sourceId]
  }
  return next ?? state
}

/** Retire an active/pending source selection from the trusted lifecycle delta.
 * A presentation-only same-id edit carries no retired id and is therefore
 * preserved. `fallback` is local for active selection and null for pending. */
export function retireSelectedSource<T extends string | null>(
  sourceId: T,
  removedSourceIds: ReadonlySet<string>,
  fallback: T,
): T {
  return sourceId !== null && removedSourceIds.has(sourceId) ? fallback : sourceId
}

/** Translate the trusted desktop registry delta into renderer source ids. The
 * delta, rather than a later roster snapshot, preserves a remove -> same-id
 * re-add edge when both overlapping pulls observe only the final roster. */
export function remoteRetiredSourceIds(retiredRawIds: readonly string[]): Set<string> {
  return new Set(retiredRawIds.map(id => `ssh-${id}`))
}
