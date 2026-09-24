/**
 * The view pair as ONE authority: `active` = the committed selection,
 * `painted` = the view actually on screen. The reveal gate keeps them apart on
 * purpose (a switch paints only when the target's first frame is usable), and
 * every event callback, microtask and retention guard must read the latest pair
 * synchronously — they used to read render-time ref mirrors of two useStates.
 *
 * retire() is the load-bearing operation: an authoritative roster removal falls
 * back to `fallback` for BOTH fields in one synchronous beat (before React
 * commits), so a callback firing in between can never act on a retired view.
 */

import { createListenerSet } from '@dsh-chamber/dsh-chamber-client-core'
export interface ViewSnapshot {
  active: string
  painted: string
}

export interface ViewStore {
  subscribe(listener: () => void): () => void
  /** Synchronous latest pair for callbacks, microtasks and guards. */
  getSnapshot(): ViewSnapshot
  /** Commit a selection (the reveal gate paints it later). */
  select(viewId: string): void
  /** Land a view on screen. */
  paint(viewId: string): void
  /** Authoritative retirement: both fields fall back in the same beat. */
  retire(retired: ReadonlySet<string>, fallback: string): void
}

export function createViewStore(initial: string): ViewStore {
  let snapshot: ViewSnapshot = { active: initial, painted: initial }
  const listeners = createListenerSet()
  const emit = (next: ViewSnapshot): void => {
    if (next.active === snapshot.active && next.painted === snapshot.painted) return
    snapshot = next
    listeners.notify()
  }
  return {
    subscribe: listeners.subscribe,
    getSnapshot: () => snapshot,
    select(viewId) { emit({ ...snapshot, active: viewId }) },
    paint(viewId) { emit({ ...snapshot, painted: viewId }) },
    retire(retired, fallback) {
      emit({
        active: retired.has(snapshot.active) ? fallback : snapshot.active,
        painted: retired.has(snapshot.painted) ? fallback : snapshot.painted,
      })
    },
  }
}
