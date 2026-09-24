/**
 * Hidden-tab polling gate + injectable visibility face. Dependency-free on
 * purpose: the coordinator imports this module (not the reverse), so the node
 * suite can cover the gate and seam mechanics without pulling the sidebar bridge.
 */

/** Pure hidden-tab polling gate: the 30s refresh only runs while the page is visible. */
export function isPollEligible(visibility: DocumentVisibilityState): boolean {
  return visibility !== 'hidden'
}

/** Browser visibility face the coordinator uses. */
export interface VisibilityEvents {
  read(): DocumentVisibilityState
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onChange(listener: () => void): () => void
}

export const browserVisibility: VisibilityEvents = {
  read: () => document.visibilityState,
  onChange: (listener) => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}

/** Injectable visibility face (default = browser; tests swap a fake and restore by passing undefined). */
export let visibilityEvents: VisibilityEvents = browserVisibility

export function __setVisibilityEventsForTests(events: VisibilityEvents | undefined): void {
  visibilityEvents = events ?? browserVisibility
}
