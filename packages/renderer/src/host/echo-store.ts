/**
 * Echo ledgers as ONE store. Three optimistic-projection ledgers the App keeps
 * while an authoritative view has not caught up:
 *
 * - workspaces: a workspace created through the sidebar's unary client may be
 *   structurally invisible until that source is mounted again (unmounted
 *   sources project workspaces from session cwd, so a new empty workspace has
 *   no row; mounted pushes freeze the workspace set). The echo row is merged in
 *   the projection until an authoritative workspace/follow push covers it.
 * - sessions: the same race for a created session — the mounted push can
 *   replace the aggregate with a store that does not contain it yet, and
 *   unmounted sources have no live channel at all. The echo carries the host id
 *   and retires when the authoritative view (the official session-list refresh
 *   or the next mount) lists it.
 * - archive: local archive tombstones. A session archived through unary on an
 *   unmounted source stays listed otherwise (the frozen mounted
 *   archivedSessionIds and the unary fallback both lack the archive wire). The
 *   tombstone filters the id until the authoritative archive set covers it;
 *   renews by the fallback pull (the lease), converges on authority/retirement/
 *   expiry.
 *
 * The render value and the event-side synchronous read are the SAME snapshot:
 * the previous shape kept a useState and a useRef per ledger, written together
 * by one update callback, because hooks read the latest value outside render.
 * One store removes the mirror and the double write.
 *
 * Updates are identity-preserving by contract: a combinator that returns the
 * same object does not notify (a TTL sweep that expires nothing costs no
 * render).
 */

import { createListenerSet } from '@dsh-chamber/dsh-chamber-client-core'
import type {
  SessionArchiveLedger,
  SessionEchoLedger,
  WorkspaceEchoLedger,
} from '@dsh-chamber/dsh-chamber-client-core'

export interface EchoSnapshot {
  workspace: WorkspaceEchoLedger
  session: SessionEchoLedger
  archive: SessionArchiveLedger
}

export interface EchoStore {
  subscribe(listener: () => void): () => void
  /** Synchronous latest snapshot for event callbacks. */
  getSnapshot(): EchoSnapshot
  updateWorkspace(next: WorkspaceEchoLedger): void
  updateSession(next: SessionEchoLedger): void
  updateArchive(next: SessionArchiveLedger): void
}

export function createEchoStore(seed?: Partial<EchoSnapshot>): EchoStore {
  let snapshot: EchoSnapshot = {
    workspace: seed?.workspace ?? {},
    session: seed?.session ?? {},
    archive: seed?.archive ?? {},
  }
  const listeners = createListenerSet()
  const emit = (next: Partial<EchoSnapshot>): void => {
    const merged = { ...snapshot, ...next }
    if (
      merged.workspace === snapshot.workspace
      && merged.session === snapshot.session
      && merged.archive === snapshot.archive
    ) return
    snapshot = merged
    listeners.notify()
  }
  return {
    subscribe: listeners.subscribe,
    getSnapshot: () => snapshot,
    updateWorkspace(next) { emit({ workspace: next }) },
    updateSession(next) { emit({ session: next }) },
    updateArchive(next) { emit({ archive: next }) },
  }
}
