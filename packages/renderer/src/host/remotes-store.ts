/**
 * Remote registry projection as ONE store: the authoritative instance list
 * plus the per-raw-id tunnel projections. Replaces the useState + render-time
 * ref mirrors (and the "write ref, then setState" pairs) that let event
 * callbacks read the latest value without re-creating their identity.
 *
 * Reads are synchronous snapshot reads (`getSnapshot()`); writes are store
 * updates, so the rendered value and the callback value can no longer diverge.
 */

import { createListenerSet } from '@dsh-chamber/dsh-chamber-client-core'
import type { SshInstanceSpec, SshStatusProjection } from '../global.d.ts'

export interface RemotesSnapshot {
  instances: SshInstanceSpec[]
  status: Record<string, SshStatusProjection>
}

export interface RemotesStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): RemotesSnapshot
  setInstances(next: SshInstanceSpec[]): void
  setStatus(update: (prev: Record<string, SshStatusProjection>) => Record<string, SshStatusProjection>): void
}

export function createRemotesStore(seed?: Partial<RemotesSnapshot>): RemotesStore {
  let snapshot: RemotesSnapshot = { instances: seed?.instances ?? [], status: seed?.status ?? {} }
  const listeners = createListenerSet()
  const emit = (next: Partial<RemotesSnapshot>): void => {
    const merged = { ...snapshot, ...next }
    if (merged.instances === snapshot.instances && merged.status === snapshot.status) return
    snapshot = merged
    listeners.notify()
  }
  return {
    subscribe: listeners.subscribe,
    getSnapshot: () => snapshot,
    setInstances(next) { emit({ instances: next }) },
    setStatus(update) { emit({ status: update(snapshot.status) }) },
  }
}
