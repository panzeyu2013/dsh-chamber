/**
 * Markup helpers (design 17 §18.4.4): stamp the official frame and its three
 * columns with the plugin's `data-mobile-*` attributes so the stylesheet can
 * anchor on stable attributes instead of hashed class names. Pure functions
 * — unit-testable under plain node with a minimal DOM shim.
 *
 * Official DOM (dsh 0.1.2-alpha.3, CDP audit):
 *   #root > div[data-slot="root"] > div.<frame>  (the AppFrame, inline grid)
 *     ├─ div.<sidebarCol> > div[data-slot="sidebar"]
 *     ├─ div.<centerCol>  > div[data-slot="conversation"]
 *     ├─ div.<detailsCol> > div[data-slot="details"]
 *     └─ div.<overlayLayer>[data-shell-overlay="true"] > div[data-slot="shell.overlay"]
 */

export const MOBILE_FRAME_ATTR = 'data-mobile-frame'
export const MOBILE_ROLE_ATTR = 'data-mobile-role'

export type MobileColumnRole = 'sidebar' | 'conversation' | 'details'

/**
 * The minimal element face the markup helpers need — satisfied by the real
 * DOM Element at runtime and by the plain-node test fakes. Kept structural
 * so the helpers stay unit-testable without a DOM shim.
 */
export interface ElementLike {
  children: ArrayLike<ElementLike> & Iterable<ElementLike>
  firstElementChild: ElementLike | null
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  querySelectorAll(selector: string): ArrayLike<ElementLike>
}

/** The AppFrame element: the first element child of the root slot. */
export function findFrame(root: ElementLike): ElementLike | null {
  for (const child of root.children) {
    if (child !== null) return child
  }
  return null
}

/** The frame's three columns by their child slot. Null-tolerant. */
export function findColumn(frame: ElementLike, slot: 'sidebar' | 'conversation' | 'details'): ElementLike | null {
  for (const col of frame.children) {
    for (const inner of col.children) {
      if (inner.getAttribute('data-slot') === slot) return col
    }
  }
  return null
}

/** Stamp the frame and columns (idempotent; returns the stamped frame). */
export function stampFrame(root: ElementLike): ElementLike | null {
  const frame = findFrame(root)
  if (frame === null) return null
  frame.setAttribute(MOBILE_FRAME_ATTR, '')
  for (const slot of ['sidebar', 'conversation', 'details'] as const) {
    const column = findColumn(frame, slot)
    if (column !== null) column.setAttribute(MOBILE_ROLE_ATTR, slot)
  }
  return frame
}

/** Derive the collapsed flag from a layout snapshot (design 17 §18.4 项 3:
 *  store preference → the AppFrame derivation). */
export function deriveCollapsed(snapshot: {
  narrow: boolean
  narrowExpanded: boolean
  sidebar: number
}): boolean {
  return snapshot.narrow ? !snapshot.narrowExpanded : snapshot.sidebar === 0
}
