/**
 * Roster gate: ONE authority for "has the authoritative remote roster landed,
 * and is its listener attached?". Replaces the state+ref boolean pairs the App
 * kept in sync by hand (\`remoteRosterSettled\`/\`remoteRosterSettledRef\`,
 * \`rosterListenerReady\`/\`rosterListenerReadyRef\`) and the two-argument
 * \`canReplayRosterIntents(committed, latest)\` helper that existed only to
 * compare those two copies.
 *
 * The generations are the root-cause shape of the old "committed vs latest"
 * check: an authoritative instance list settles the CURRENT generation, and an
 * instances-changed event opens a new one. A replay may proceed iff the
 * current generation is the settled one, read synchronously at the decision
 * point (\`isSettled()\`) — no committed snapshot to reconcile against.
 */

import { createListenerSet } from '@dsh-chamber/dsh-chamber-client-core'
export interface RosterGateSnapshot {
  /** Monotonic authoritative-roster generation (bumped by invalidation). */
  generation: number
  /** The generation whose authoritative instance list landed (0 = none). */
  settledGeneration: number
  /** The desktop status listener is subscribed (single source). */
  listenerReady: boolean
}

export interface RosterGate {
  subscribe(listener: () => void): () => void
  getSnapshot(): RosterGateSnapshot
  /** Authoritative roster changed: a NEW generation must settle before replay. */
  invalidate(): void
  /** The current generation's authoritative list landed. */
  settle(): void
  setListenerReady(ready: boolean): void
  /** Synchronous single-source read for event callbacks and flush-time vetoes. */
  isSettled(): boolean
  isListenerReady(): boolean
}

/** Is this snapshot's current generation the settled one? */
export function rosterSettled(snapshot: RosterGateSnapshot): boolean {
  return snapshot.generation > 0 && snapshot.settledGeneration === snapshot.generation
}

export function createRosterGate(): RosterGate {
  let snapshot: RosterGateSnapshot = { generation: 1, settledGeneration: 0, listenerReady: false }
  const listeners = createListenerSet()
  const update = (next: RosterGateSnapshot): void => {
    if (
      next.generation === snapshot.generation
      && next.settledGeneration === snapshot.settledGeneration
      && next.listenerReady === snapshot.listenerReady
    ) return
    snapshot = next
    listeners.notify()
  }
  return {
    subscribe: listeners.subscribe,
    getSnapshot: () => snapshot,
    invalidate() { update({ ...snapshot, generation: snapshot.generation + 1 }) },
    settle() {
      if (snapshot.settledGeneration === snapshot.generation) return
      update({ ...snapshot, settledGeneration: snapshot.generation })
    },
    setListenerReady(ready) {
      if (snapshot.listenerReady === ready) return
      update({ ...snapshot, listenerReady: ready })
    },
    isSettled: () => rosterSettled(snapshot),
    isListenerReady: () => snapshot.listenerReady,
  }
}
