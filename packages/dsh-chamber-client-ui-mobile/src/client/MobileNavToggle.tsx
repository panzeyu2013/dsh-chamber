/**
 * Mobile drawer toggle + backdrop (design 17 §18.4.3): the official sidebar
 * toggle lives inside the sidebar DOM, which the off-canvas transform hides
 * — so the mobile surface needs its own floating entry. Registered into
 * `shell.overlay` (additive list slot). The backdrop dims the conversation
 * behind the open drawer and absorbs stray taps on the live seam right of
 * the drawer (the composer send button must not be hit while the drawer is
 * open). The drawer state is read from the official frame attribute
 * (`data-sidebar-collapsed`) via a scoped observer — the stylesheet drives
 * the visuals, the component only mirrors state for aria/tap semantics.
 */
import { useEffect, useState } from 'react'
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
        aria-haspopup="true"
        onClick={() => toggleSidebar()}
      >
        {/* Three-bar hamburger, pure CSS (no icon dependency). */}
        <span className="dsh-mobile-nav-toggle-bars" aria-hidden="true" />
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
