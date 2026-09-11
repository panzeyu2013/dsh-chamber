/**
 * Escape ownership for the chamber settings panel (2026-09-11 fix).
 *
 * The panel closes on a document-level Escape — the same way the official
 * `SettingsRoot` does (`vendor …/ui-settings-general/src/client/SettingsRoot.tsx`:
 * a plain keydown listener, no guard). Our guard exists because a modal INSIDE
 * the panel (the official Modal primitive portals into `body` and closes on its
 * OWN document listener) must own that Escape: closing the whole panel
 * underneath it would swallow the user's close intent (the 2026 dev-QA
 * observation that introduced the guard).
 *
 * The defect this module fixes: the guard asked
 * `document.querySelector('[aria-modal="true"]') !== null`, and the chamber
 * panel ITSELF is `role="dialog" aria-modal="true"` — so the query always
 * self-matched and Escape never reached `onClose`. The rule therefore has to
 * EXCLUDE the panel's own node; that is the only thing this function does.
 *
 * Deviation note: upstream's `SettingsRoot` carries no guard at all, so one
 * Escape closes a nested dialog AND the settings panel there. We keep the
 * layer-aware rule deliberately (it is the guard's original intent, now
 * actually implemented) — with N shells in one page, several overlays can be
 * mounted at once, and closing more than the topmost layer on one key press is
 * worse here than in upstream's single-shell document.
 */

/**
 * Whether an open modal other than our own panel owns this Escape press.
 * @param openModals - every `[aria-modal="true"]` node currently in the document.
 * @param ownPanel - the settings panel's own node (excluded by identity).
 * @returns true when the panel must NOT close on this press.
 */
export function nestedModalOwnsEscape(openModals: Iterable<unknown>, ownPanel: unknown): boolean {
  for (const node of openModals) {
    if (node !== ownPanel) return true
  }
  return false
}
