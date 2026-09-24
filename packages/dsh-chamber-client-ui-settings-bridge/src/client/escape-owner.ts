/**
 * Escape ownership for the chamber settings panel.
 *
 * The panel closes on a document-level Escape — the official `SettingsRoot` way. Our
 * guard exists because a modal INSIDE the panel (the official Modal portals into
 * `body` and closes on its OWN document listener) must own that Escape: closing the
 * whole panel underneath it would swallow the user's close intent.
 *
 * A blanket `[aria-modal="true"]` query self-matches the chamber panel ITSELF
 * (`role="dialog" aria-modal="true"`), so Escape would never reach `onClose`; the rule
 * therefore has to EXCLUDE the panel's own node — the only thing this function does.
 * Upstream carries no guard (one Escape closes a nested dialog AND the panel there);
 * with N shells in one page several overlays can be mounted at once, so closing more
 * than the topmost layer on one key press is worse here.
 */

/**
 * Whether an open modal other than our own panel owns this Escape press.
 * @param ownPanel - the settings panel's own node (excluded by identity).
 * @returns true when the panel must NOT close on this press.
 */
export function nestedModalOwnsEscape(openModals: Iterable<unknown>, ownPanel: unknown): boolean {
  for (const node of openModals) {
    if (node !== ownPanel) return true
  }
  return false
}
