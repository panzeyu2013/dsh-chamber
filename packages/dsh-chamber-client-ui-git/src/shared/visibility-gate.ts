/**
 * Hidden-tab polling gate + injectable visibility face (P1, 2026-11).
 *
 * Dependency-free on purpose: the git coordinator imports this module (not
 * the other way around), so the node test suite can cover the gate and the
 * seam mechanics without pulling the sidebar bridge (which imports
 * @deepseek-ai/dsh-client-connection's compiled entry and cannot load under
 * plain node).
 */

/** Pure hidden-tab polling gate: the 30s refresh only runs while the page is
 *  visible — a backgrounded window has no consumer for the facts. */
export function isPollEligible(visibility: DocumentVisibilityState): boolean {
  return visibility !== 'hidden'
}

/** Browser visibility face the coordinator uses (P1). */
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

/** Injectable visibility face (default = browser; tests swap a fake and
 *  restore by passing undefined — see test/visibility-gate.ts). */
export let visibilityEvents: VisibilityEvents = browserVisibility

export function __setVisibilityEventsForTests(events: VisibilityEvents | undefined): void {
  visibilityEvents = events ?? browserVisibility
}
