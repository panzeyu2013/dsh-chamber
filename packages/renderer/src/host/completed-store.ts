/**
 * The completed-unread ledger ("blue dots"): sourceId → sessionId → completed
 * flag, seeded from the persisted unread v4 payload on the first frame. ONE
 * authority: the rendered table, the persisted \`edge\` table and the event-side
 * prevLedger read all come from this snapshot (they used to be a useState plus
 * a ledger ref written together, plus a third read in the persistence closure).
 *
 * setSource is the single write: the derivation's new table replaces a source's
 * entry only when it actually differs (sameBooleanMap), so a re-derived-but-
 * equal table costs no render; a source's row is dropped when the registry
 * retires it, and pruned in the same sweep as the other per-source tables.
 */

import { createListenerSet } from '@dsh-chamber/dsh-chamber-client-core'
import { sameBooleanMap } from '../unread-derivation.ts'

export type CompletedTable = Record<string, Record<string, boolean>>

export interface CompletedStore {
  subscribe(listener: () => void): () => void
  /** Synchronous latest table for event callbacks and persistence. */
  getSnapshot(): CompletedTable
  /** Install the persisted v4 edge table (first frame, before any effect). */
  seed(table: CompletedTable): void
  setSource(sourceId: string, table: Record<string, boolean>): void
  dropSource(sourceId: string): void
  prune(live: ReadonlySet<string>): void
  retire(sourceIds: Iterable<string>): void
}

export function createCompletedStore(): CompletedStore {
  let snapshot: CompletedTable = {}
  const listeners = createListenerSet()
  const emit = (next: CompletedTable): void => {
    if (next === snapshot) return
    snapshot = next
    listeners.notify()
  }
  return {
    subscribe: listeners.subscribe,
    getSnapshot: () => snapshot,
    seed(table) { emit(table) },
    setSource(sourceId, table) {
      if (sameBooleanMap(snapshot[sourceId] ?? {}, table)) return
      emit({ ...snapshot, [sourceId]: table })
    },
    dropSource(sourceId) {
      if (snapshot[sourceId] === undefined) return
      const next = { ...snapshot }
      delete next[sourceId]
      emit(next)
    },
    prune(live) {
      let next: CompletedTable | null = null
      for (const sourceId of Object.keys(snapshot)) {
        if (live.has(sourceId)) continue
        if (next === null) next = { ...snapshot }
        delete next[sourceId]
      }
      if (next !== null) emit(next)
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
  }
}
