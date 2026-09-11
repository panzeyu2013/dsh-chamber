/**
 * Mobile drawer toggle + backdrop (design 17 §18.4.3): the official sidebar
 * toggle lives inside the sidebar DOM, which the off-canvas transform hides
 * — so the mobile surface needs its own floating entry. Registered into
 * `shell.overlay` (additive list slot). The backdrop dims the conversation
 * behind the open drawer and absorbs stray taps on the live seam right of
 * the drawer (the composer send button must not be hit while the drawer is
 * open). The drawer state is read from the official frame attribute
 * (`data-sidebar-collapsed`) via a scoped observer — the stylesheet drives
 * the visuals, the component only mirrors state for the accessible name.
 *
 * 2026-09-11 upstream-alignment T17a: the control is the OFFICIAL glyph
 * (`IconPanelLeftOutline16`, the panel icon the official sidebar toggle
 * draws — ui-sidebar SidebarRoot.tsx) instead of a hand-drawn CSS
 * hamburger, and it carries the official ARIA shape: one state-carrying
 * `aria-label` (the official toggle's own `toggle.open` / `toggle.collapse`
 * label pair) plus the disclosure state. `aria-haspopup="true"` is gone: it
 * claimed an untyped popup, while the drawer is the sidebar itself rendered
 * off-canvas — where upstream has a real popup it names the type
 * (`aria-haspopup="dialog"` on the settings trigger). The touch tier keeps
 * only what the official control cannot give it: the 44px floating box and
 * the tap-absorbing backdrop.
 */
import { useEffect, useState } from 'react'
import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export interface MobileNavToggleInjected {
  toggleSidebar(): void
  t(key: string): string
}

export type MobileNavToggleProps = PropsRuntime<'shell.overlay'> & MobileNavToggleInjected

/** The official frame: first element child of the root slot. */
function findFrame(root: ParentNode): Element | null {
  for (const child of root.children) {
    if (child instanceof Element) return child
  }
  return null
}

export function MobileNavToggle({ toggleSidebar, t }: MobileNavToggleProps) {
  // Mirrors the drawer state for aria/tap semantics (the CSS is driven by
  // the attribute itself). Scoped to the first root slot — N-ctx safe for
  // the single-instance gateway deployment; multi-instance shells would
  // scope by their own ctx root (design 17 §18.4 项 2).
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const root = document.querySelector('[data-slot="root"]')
    if (root === null) return
    const frame = findFrame(root)
    if (frame === null) return
    const sync = (): void => setOpen(!frame.hasAttribute('data-sidebar-collapsed'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <button
        type="button"
        className="dsh-mobile-nav-toggle"
        aria-label={open ? t('dsh-chamber.mobile.drawer.close') : t('dsh-chamber.mobile.drawer.open')}
        aria-expanded={open}
        onClick={() => toggleSidebar()}
      >
        {/* The official panel glyph (18 = the official rail size; the box is
            the 44px touch floor, styles.ts). */}
        <IconPanelLeftOutline16 size={18} />
      </button>
      <button
        type="button"
        className="dsh-mobile-backdrop"
        aria-label={t('dsh-chamber.mobile.drawer.close')}
        tabIndex={-1}
        onClick={() => toggleSidebar()}
      />
    </>
  )
}
