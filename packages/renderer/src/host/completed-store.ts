/**
 * The App's completion-point store ("blue dots"): sourceId → sessionId → true.
 *
 * Authority is the vendor's own `uiSession.sessionStatus.completionUnread`, carried
 * on the channel row and merged into the runtime facts. This store holds ONLY the
 * App's N-ctx correction arm (client-core `completion-arm.ts`): the unattended (not
 * painted, or painted without page foreground) shelled source's mainView-retained row
 * the vendor rule cannot arm, plus — for a source with no official ctx report
 * (facts-only provenance, `factsOnly`, design 06 §4.1/§4.2) — every row with a fresh
 * host running→idle edge. Attention is the page-side query (painted ∧ pageForeground,
 * design 06 §4.2); `document.hasFocus` is only the missing-`active`-fact fallback.
 * It is memory-only — never seeded from disk, never persisted (reload forgets,
 * exactly like upstream).
 *
 * setSource is the single write: the step's new table replaces a source's entry
 * only when it actually differs, so a re-stepped-but-equal table costs no render;
 * a source's row is dropped when the registry retires it, and pruned in the same
 * sweep as the other per-source tables.
 */

import { createListenerSet, sameTrueTable } from '@dsh-chamber/dsh-chamber-client-core'

export type CompletedTable = Record<string, Record<string, boolean>>

export interface CompletedStore {
  subscribe(listener: () => void): () => void
  /** Synchronous latest table for event callbacks. */
  getSnapshot(): CompletedTable
  setSource(sourceId: string, table: Record<string, boolean>): void
  prune(live: ReadonlySet<string>): void
  retire(sourceIds: Iterable<string>): void
}

/**
 * Drop one session's correction arm: the explicit user read fact path (design 06 §4.9).
 * Row-keyed — never sweeps the source or its siblings. Idempotent: a missing arm is a
 * no-op and reports `false`, so a duplicate mark never churns the store.
 * @param store - the App's arm store.
 * @param sourceId - the session's aggregate source id.
 * @param sessionId - the session whose arm the user marked read.
 * @returns true when an arm existed and the table changed.
 */
export function clearSessionArm(store: CompletedStore, sourceId: string, sessionId: string): boolean {
  const arms = store.getSnapshot()[sourceId]
  if (arms?.[sessionId] !== true) return false
  const next = { ...arms }
  delete next[sessionId]
  store.setSource(sourceId, next)
  return true
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
    setSource(sourceId, table) {
      if (sameTrueTable(snapshot[sourceId] ?? {}, table)) return
      emit({ ...snapshot, [sourceId]: table })
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
