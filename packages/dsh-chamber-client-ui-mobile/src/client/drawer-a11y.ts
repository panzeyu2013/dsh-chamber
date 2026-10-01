/**
 * Drawer background accessibility lock (the entry's scroll-lock effect calls
 * this while the off-canvas drawer is open).
 *
 * The open drawer covers the conversation and details columns, so neither may
 * stay reachable by keyboard/screen reader then — the backdrop absorbs taps,
 * not the tab order. The SETTINGS dialog is unaffected either way: upstream
 * body-portals it (rc.2 SettingsPanel createPortal(..., document.body)), so it
 * is not a descendant of these columns and must not be inerted with them.
 *
 * The details column is skipped while a right panel is SHOWN: the stylesheet's
 * drawer-yield arms give a shown panel the whole screen (upstream's fullscreen
 * presentation on this tier) and the drawer goes visibility: hidden, so
 * inerting the panel's own column would make the visible panel dead.
 *
 * The decision is pure and the application takes a query root, so both are
 * testable in the package's plain-node harness. The application OWNS its
 * writes: every inert it sets is paired with MOBILE_INERTED_ATTR, and the
 * unlock pass retracts inert only from nodes carrying that mark — an inert
 * written by any other code is left alone.
 */
import { MOBILE_INERTED_ATTR } from './markup.ts'

export interface DrawerBackgroundTarget {
  readonly selector: string
  readonly role: 'conversation' | 'details'
}

/** The two covered columns, keyed by the plugin's own role attribute. */
export const DRAWER_BACKGROUND_TARGETS: readonly DrawerBackgroundTarget[] = [
  { selector: '[data-mobile-role="conversation"]', role: 'conversation' },
  { selector: '[data-mobile-role="details"]', role: 'details' },
]

/** Pure: does this covered column go inert for this drawer state? The details
 *  column yields while a right panel is shown (the drawer itself is hidden
 *  then, so the panel — not the drawer — owns the accessibility surface). */
export function shouldInertBackground(
  role: DrawerBackgroundTarget['role'],
  locked: boolean,
  panelShown: boolean,
): boolean {
  if (!locked) return false
  return role === 'conversation' || !panelShown
}

/** The attribute face the lock needs (a real Element satisfies it, and the
 *  plain-node test doubles do too — no Element global in those harnesses). */
interface InertElementFace {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
}

function hasInertFace(node: Element): node is Element & InertElementFace {
  const candidate = node as Partial<InertElementFace>
  return typeof candidate.setAttribute === 'function'
    && typeof candidate.removeAttribute === 'function'
    && typeof candidate.hasAttribute === 'function'
}

/** Apply the decision to a query root: locked columns carry `inert` (plus the
 *  ownership mark), unlocked MARKED ones have both removed. Total on every
 *  transition for the lock's own writes, and a no-op for everybody else's: an
 *  inert attribute without the mark is never retracted by this pass. */
export function applyBackgroundInert(root: ParentNode, locked: boolean, panelShown: boolean): void {
  for (const target of DRAWER_BACKGROUND_TARGETS) {
    const inert = shouldInertBackground(target.role, locked, panelShown)
    for (const node of root.querySelectorAll(target.selector)) {
      if (!hasInertFace(node)) continue
      if (inert) {
        node.setAttribute('inert', '')
        node.setAttribute(MOBILE_INERTED_ATTR, '')
      } else if (node.hasAttribute(MOBILE_INERTED_ATTR)) {
        node.removeAttribute('inert')
        node.removeAttribute(MOBILE_INERTED_ATTR)
      }
    }
  }
}
