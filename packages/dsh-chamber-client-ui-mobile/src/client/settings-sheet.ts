/**
 * Settings sheet section-switch polish (phone tier): the official
 * ui-settings-general shell keeps ONE options scroll container across
 * sections, so switching chips preserves the previous section's scrollTop and
 * a long list lands the next (shorter) section mid-viewport. A section switch
 * must start the new section at its top (the tab-bar convention).
 *
 * Anchors: the settings dialog is [role="dialog"][aria-modal="true"] carrying
 * the settings.header slot, with the section-chip list as its direct nav child
 * (dialog > nav + content). Only a click on a nav CHIP (a button inside that
 * nav) resets. The reset walks the [data-slot="settings.section"] outlet's
 * ancestors up to the dialog (the options scroller is its direct parent; the
 * content-column fallback follows) after the section re-render (rAF).
 *
 * Phone tier only (a 769-1023px touch tablet keeps the official desktop modal
 * geometry). Single-instance document-level effect.
 */

/** The settings dialog face: aria-modal dialog carrying the header seat. */
const SETTINGS_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]'

/** The minimal element face the chip decision needs — satisfied by the real
 *  DOM and by plain-node test fakes. */
export interface ChipTargetLike {
  closest(selector: string): ChipTargetLike | null
}

/** Is this click a settings SECTION-CHIP click? Pure — unit-tested. The
 *  official nav's only buttons are the section chips, so requiring a button
 *  whose nearest nav ancestor is THE settings nav excludes the title, the
 *  options area and the dialog chrome. */
export function isSectionChipClick(target: ChipTargetLike | null, nav: ChipTargetLike | null): boolean {
  if (target === null || nav === null) return false
  const chip = target.closest('button')
  if (chip === null) return false
  return chip.closest('nav') === nav
}

export function installSettingsSheetScrollReset(active: () => boolean): () => void {
  const onClick = (event: MouseEvent): void => {
    if (!active()) return
    const target = event.target instanceof Element ? event.target : null
    if (target === null) return
    const dialog = target.closest(SETTINGS_DIALOG_SELECTOR)
    if (!(dialog instanceof Element)) return
    if (dialog.querySelector('[data-slot="settings.header"]') === null) return
    const nav = dialog.querySelector(':scope > nav')
    if (!(nav instanceof Element)) return
    if (!isSectionChipClick(target, nav)) return
    requestAnimationFrame(() => {
      let scroller = dialog.querySelector('[data-slot="settings.section"]')?.parentElement ?? null
      while (scroller instanceof HTMLElement && scroller !== dialog) {
        scroller.scrollTop = 0
        scroller = scroller.parentElement
      }
      // The content column itself is the fallback scroller of the sheet
      // contract — reset it too, so a drifted grammar cannot keep a stale
      // offset under the sticky header.
      const content = dialog.lastElementChild
      if (content instanceof HTMLElement) content.scrollTop = 0
    })
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
