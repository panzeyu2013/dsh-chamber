/**
 * Markup helpers (design 17 §18.4.4): stamp the official frame and its three
 * columns with the plugin's `data-mobile-*` attributes so the stylesheet can
 * anchor on stable attributes instead of hashed class names. Pure functions
 * — unit-testable under plain node with a minimal DOM shim.
 *
 * Official DOM (dsh 0.1.2-alpha.4; the ui-layout AppFrame is byte-identical
 * with the alpha.3 pin — alpha.4 anchor audit, 2026-09):
 *   #root > div[data-slot="root"] > div.<frame>  (the AppFrame, inline grid)
 *     ├─ div.<sidebarCol> > div[data-slot="sidebar"]   (root scope; outlet
 *     │    present from first paint)
 *     ├─ div.<centerCol>  > div[data-slot="conversation"]
 *     ├─ div.<detailsCol> (resident SHELL from first paint; its inner
 *     │    [data-slot="details"] outlet is session-gated — it mounts only
 *     │    once a session activates. a3 and a4 behave identically; the old
 *     │    "details column appears with a session" record was a with-session
 *     │    snapshot, not the boot shape.)
 *     └─ div.<overlayLayer>[data-shell-overlay="true"] > div[data-slot="shell.overlay"]
 *
 * Re-stamp contract: stamping is idempotent and must converge whenever a
 * structural addition could have changed the stamp set — a root slot, a
 * frame, a column shell, or a session-gated slot OUTLET mounting inside a
 * resident column shell (two levels under the frame). The predicate below
 * is the pure decision; index.ts wires it to the MutationObserver.
 */

export const ROOT_SLOT_SELECTOR = '[data-slot="root"]'
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

/**
 * The element face the re-stamp predicate needs on top of ElementLike: a
 * parent chain and selector matching. Distinct so ElementLike stays minimal
 * (the stamp helpers never walk up or match).
 */
export interface StructuralNodeLike {
  parentElement: StructuralNodeLike | null
  matches(selector: string): boolean
}

/** One MutationObserver record in the shape the batch decision reads. */
export interface MutationLike {
  type: string
  addedNodes: ArrayLike<unknown>
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

/**
 * Is an added node a structural stamping target? Pure decision for the
 * childList observer (design 17 §18 alpha.4 audit). The stamp set changes
 * when any of these mounts:
 *   1. a root slot itself, or a node directly under a root slot (the frame);
 *   2. an already-stamped frame or column re-appearing (remount recovery);
 *   3. a column shell directly under a stamped frame (the a3-era recorded
 *      shape);
 *   4. a slot OUTLET mounting inside a resident column shell — two levels
 *      under a stamped frame. This is the real alpha.3/alpha.4 shape for
 *      the details column (shell resident from first paint, session-gated
 *      outlet mounting later); without it the empty shell was never
 *      stamped and a later details outlet stayed invisible under the
 *      mobile grid lock. NOTE (coupling): convergence depends on the
 *      empirical shape where the outlet IS the shell's direct child — the
 *      same one-level shape findColumn() searches. If upstream ever inserts
 *      a wrapper between shell and outlet (col > wrapper > [data-slot=…]),
 *      this branch fires but findColumn() cannot find the outlet and the
 *      column stays unstamped — re-audit the shape then.
 * Deep content mutations (chat streaming) sit deeper than two levels and
 * never match — the streaming filter is preserved.
 */
export function isStructuralTarget(target: StructuralNodeLike | null | undefined): boolean {
  if (target === null || target === undefined) return false
  const parent = target.parentElement
  const grandparent = parent?.parentElement ?? null
  return target.matches(ROOT_SLOT_SELECTOR)
    || target.matches(`[${MOBILE_FRAME_ATTR}]`)
    || target.matches(`[${MOBILE_ROLE_ATTR}]`)
    || parent?.matches(ROOT_SLOT_SELECTOR) === true
    || parent?.matches(`[${MOBILE_FRAME_ATTR}]`) === true
    || grandparent?.matches(`[${MOBILE_FRAME_ATTR}]`) === true
}

/** DOM-side guard: only element-like added nodes can be structural (text and
 * comment nodes never match selectors). Duck-typed so plain-node tests can
 * feed fakes without a MutationObserver shim. */
export function isElementNode(node: unknown): node is StructuralNodeLike {
  return typeof node === 'object' && node !== null
    && typeof (node as { matches?: unknown }).matches === 'function'
}

/** The batch decision: does this childList batch contain a structural
 * addition? Attribute/characterData records never reach it (index.ts keeps
 * the attribute channel on a separate observer). Pure — index.ts only wires
 * it to the MutationObserver callback. */
export function shouldRestamp(mutations: readonly MutationLike[]): boolean {
  return mutations.some(mutation => {
    if (mutation.type !== 'childList') return false
    for (let index = 0; index < mutation.addedNodes.length; index++) {
      const node = mutation.addedNodes[index]
      if (isElementNode(node) && isStructuralTarget(node)) return true
    }
    return false
  })
}
