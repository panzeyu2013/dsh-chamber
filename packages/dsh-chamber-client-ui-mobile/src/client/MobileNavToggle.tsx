/**
 * Mobile drawer toggle + backdrop: the official sidebar toggle lives inside the
 * sidebar DOM, which the off-canvas transform hides, so the mobile surface
 * needs its own floating entry (registered into the additive shell.overlay
 * slot). The backdrop dims the conversation behind the open drawer and absorbs
 * stray taps on the live seam right of the drawer. The drawer state is read
 * from the official frame attribute (data-sidebar-collapsed) via a scoped
 * observer; the stylesheet drives the visuals, the component only mirrors state
 * for the accessible name.
 *
 * The control draws the OFFICIAL glyph (IconPanelLeftOutlineRegular) and its
 * accessible name is the official toggle.open/toggle.collapse pair. It adds
 * one truthful attribute of its own, aria-expanded; aria-haspopup is omitted
 * (the drawer is the sidebar itself rendered off-canvas, not a popup). The
 * touch tier adds only the 44px floating box and the tap-absorbing backdrop.
 */
import { useEffect, useState } from 'react'
import { IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
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
  // Mirrors the drawer state for aria/tap semantics (the CSS is driven by the
  // attribute itself). Scoped to the first root slot — N-ctx safe.
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
        <IconPanelLeftOutlineRegular size={18} />
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
