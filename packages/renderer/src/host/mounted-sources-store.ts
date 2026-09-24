/**
 * The "mounted source" table: sources whose ctx has published a complete
 * aggregate snapshot (or whose unary commit is equally authoritative). ONE
 * authority for a fact that used to live in three places: the rendered
 * useState (which fed the aggregate poller's re-plan), the ledger's sync ref
 * mirror (read by event callbacks), and the reducer's lifecycle table.
 *
 * Membership changes are domain operations: mark (a push/commit proved the
 * source mounted), withdraw (a view withdrawn from a source that never
 * pushed), retire (authoritative roster removal; synchronous, so event
 * callbacks see the source gone before React commits) and prune (a sweep
 * against the live set whose dropped ids drive the snapshotAt lockstep).
 */

import { createListenerSet } from '@dsh-chamber/dsh-chamber-client-core'
export type MountedSources = Record<string, true>

export interface MountedSourcesStore {
  subscribe(listener: () => void): () => void
  /** Synchronous latest table for event callbacks and poll planning. */
  getSnapshot(): MountedSources
  mark(sourceId: string): void
  withdraw(sourceId: string): void
  retire(sourceIds: Iterable<string>): void
  /** Identity-preserving sweep; returns the ids it dropped. */
  prune(live: ReadonlySet<string>): ReadonlySet<string>
}

export function createMountedSourcesStore(seed?: MountedSources): MountedSourcesStore {
  let snapshot: MountedSources = seed ?? {}
  const listeners = createListenerSet()
  const emit = (next: MountedSources): void => {
    if (next === snapshot) return
    snapshot = next
    listeners.notify()
  }
  return {
    subscribe: listeners.subscribe,
    getSnapshot: () => snapshot,
    mark(sourceId) {
      if (snapshot[sourceId] === true) return
      emit({ ...snapshot, [sourceId]: true })
    },
    withdraw(sourceId) {
      if (snapshot[sourceId] === undefined) return
      const next = { ...snapshot }
      delete next[sourceId]
      emit(next)
    },
    retire(sourceIds) {
      let next = snapshot
      for (const sourceId of sourceIds) {
        if (next[sourceId] === undefined) continue
        if (next === snapshot) next = { ...snapshot }
        delete next[sourceId]
      }
      emit(next)
    },
    prune(live) {
      const dropped = new Set<string>()
      let next: MountedSources | null = null
      for (const sourceId of Object.keys(snapshot)) {
        if (live.has(sourceId)) continue
        dropped.add(sourceId)
        if (next === null) next = { ...snapshot }
        delete next[sourceId]
      }
      if (next !== null) emit(next)
      return dropped
    },
  }
}
