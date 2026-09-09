/**
 * Settings sheet section-switch polish (design 17 §18.4.3, phone tier):
 * the official ui-settings-general shell keeps ONE options scroll container
 * across sections — switching chips (nav cells) preserves the previous
 * section's scrollTop, so a long list scrolled mid-way lands the next
 * (shorter) section mid-viewport. A section switch must start the new
 * section at its top, the tab-bar convention.
 *
 * Anchors are the same structural grammar the stylesheet sheet rules use:
 * the settings dialog is `[role="dialog"][aria-modal="true"]` carrying the
 * `settings.header` slot with the section-chip list as its direct `nav`
 * child (rc.1 SettingsPanel shape — dialog > nav + content). Only clicks
 * inside that nav reset; clicks inside the options area never do. The
 * reset walks the [data-slot="settings.section"] outlet's scrollable
 * ancestors up to the dialog (the options scroller and the content-column
 * fallback scroller, per the stylesheet's double-scroller contract) and
 * runs after the section re-render (rAF), so a switch that replaces the
 * outlet content cannot race the reset.
 *
 * Touch-tier only by design (the installer is wired inside the touch-tier
 * behavior effect; desktop keeps the official cross-section scroll
 * behavior). Single-instance document-level effect like the other
 * behavior installers — the gateway deployment is single-shell.
 */

/** The settings dialog face: aria-modal dialog carrying the header seat. */
const SETTINGS_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]'

export function installSettingsSheetScrollReset(active: () => boolean): () => void {
  const onClick = (event: MouseEvent): void => {
    if (!active()) return
    const target = event.target instanceof Element ? event.target : null
    if (target === null) return
    const dialog = target.closest(SETTINGS_DIALOG_SELECTOR)
    if (!(dialog instanceof Element)) return
    if (dialog.querySelector('[data-slot="settings.header"]') === null) return
    const nav = dialog.querySelector(':scope > nav')
    if (!(nav instanceof Element) || !nav.contains(target)) return
    requestAnimationFrame(() => {
      let scroller = dialog.querySelector('[data-slot="settings.section"]')?.parentElement ?? null
      while (scroller instanceof HTMLElement && scroller !== dialog) {
        scroller.scrollTop = 0
        scroller = scroller.parentElement
      }
      // The content column itself is the fallback scroller of the sheet
      // contract — reset it too so a drifted grammar cannot keep a stale
      // offset under the sticky header.
      const content = dialog.lastElementChild
      if (content instanceof HTMLElement) content.scrollTop = 0
    })
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
