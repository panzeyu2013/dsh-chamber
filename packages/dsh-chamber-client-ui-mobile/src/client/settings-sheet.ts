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
 * `settings.header` slot (inside the nav's title cell, rc.1 shape) with the
 * section-chip list as its direct `nav` child (dialog > nav + content). Only
 * a click on a nav CHIP (a `button` inside that nav) resets; the nav title,
 * the options area and the dialog chrome never do. The reset walks the
 * [data-slot="settings.section"] outlet's ancestors up to the dialog (the
 * shared options scroller is its direct parent; the content-column fallback
 * scroller follows) and runs after the section re-render (rAF), so a switch
 * that replaces the outlet content cannot race the reset.
 *
 * Phone tier only: the stacked sheet this resets is phone-tier CSS
 * (`(max-width: 768px) and (pointer: coarse)`), so the caller gates on the
 * PHONE tier, not the touch tier — on a 769-1023px touch tablet the official
 * desktop modal geometry is untouched and keeps the official cross-section
 * scroll behavior. Single-instance document-level effect like the other
 * behavior installers — the gateway deployment is single-shell.
 */

/** The settings dialog face: aria-modal dialog carrying the header seat. */
const SETTINGS_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]'

/** The minimal element face the chip decision needs — satisfied by the real
 *  DOM and by plain-node test fakes (same duck-typed pattern as composer.ts's
 *  ClosestLike). */
export interface ChipTargetLike {
  closest(selector: string): ChipTargetLike | null
}

/** Is this click a settings SECTION-CHIP click? Pure — unit-tested. The
 *  official nav's only buttons are the section chips (rc.1: the navTitle cell
 *  holds a text-only `settings.header` occupant and the Close button lives in
 *  the content header), so requiring a `button` whose nearest nav ancestor is
 *  THE settings nav excludes the title, the options area and the dialog
 *  chrome — only a real section switch resets the shared scroller. */
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
      // contract — reset it too so a drifted grammar cannot keep a stale
      // offset under the sticky header.
      const content = dialog.lastElementChild
      if (content instanceof HTMLElement) content.scrollTop = 0
    })
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
