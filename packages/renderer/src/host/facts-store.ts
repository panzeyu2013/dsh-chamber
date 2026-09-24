/**
 * Per-source FACT tables as ONE store. The rendered snapshot and the
 * event-side synchronous read are the same object, replacing the
 * useState + `ref.current = state` render-time mirrors for session facts and
 * runtime reports (including the direct ref mutations that wrote behind
 * React's back).
 *
 * Writes are updater-style (setSession/setRuntime) so every existing
 * functional combinator keeps its shape; dropSession is the single
 * implementation of "a retired source's fact row disappears" (a same-id
 * re-add must start from nothing).
 */

import { createListenerSet } from '@dsh-chamber/dsh-chamber-client-core'
import type { InstanceRuntimeReport } from '@dsh-chamber/dsh-chamber-client-core'
import type { SessionFactsSnapshot } from '../session-facts-source.ts'

export type SessionFactsTable = Record<string, SessionFactsSnapshot | undefined>
export type RuntimeFactsTable = Record<string, InstanceRuntimeReport | undefined>

export interface FactsSnapshot {
  session: SessionFactsTable
  runtime: RuntimeFactsTable
}

export interface FactsStore {
  subscribe(listener: () => void): () => void
  /** Synchronous latest snapshot for event callbacks and derived reads. */
  getSnapshot(): FactsSnapshot
  setSession(update: (prev: SessionFactsTable) => SessionFactsTable): void
  setRuntime(update: (prev: RuntimeFactsTable) => RuntimeFactsTable): void
  dropSession(sourceId: string): void
}

export function createFactsStore(seed?: Partial<FactsSnapshot>): FactsStore {
  let snapshot: FactsSnapshot = { session: seed?.session ?? {}, runtime: seed?.runtime ?? {} }
  const listeners = createListenerSet()
  const emit = (next: Partial<FactsSnapshot>): void => {
    const merged = { ...snapshot, ...next }
    if (merged.session === snapshot.session && merged.runtime === snapshot.runtime) return
    snapshot = merged
    listeners.notify()
  }
  return {
    subscribe: listeners.subscribe,
    getSnapshot: () => snapshot,
    setSession(update) { emit({ session: update(snapshot.session) }) },
    setRuntime(update) { emit({ runtime: update(snapshot.runtime) }) },
    dropSession(sourceId) {
      if (!Object.hasOwn(snapshot.session, sourceId)) return
      const next = { ...snapshot.session }
      delete next[sourceId]
      emit({ session: next })
    },
  }
}
