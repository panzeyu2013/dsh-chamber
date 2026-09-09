/**
 * Markup helpers (design 17 §18.4.4): stamp the official frame and its three
 * columns with the plugin's `data-mobile-*` attributes so the stylesheet can
 * anchor on stable attributes instead of hashed class names. Pure functions
 * — unit-testable under plain node with a minimal DOM shim.
 *
 * Official DOM (dsh 0.1.5-alpha.2; the ui-layout AppFrame center column is
 * now the keyed `main` slot, the right column is `rightbar`):
 *   #root > div[data-slot="root"] > div.<frame>  (the AppFrame, inline grid)
 *     ├─ div.<sidebarCol> > div[data-slot="sidebar"]   (root scope; outlet
 *     │    present from first paint)
 *     ├─ div.<centerCol>  > div[data-slot="main"]      (keyed main panel; the
 *     │    reserved `conversation` key renders
 *     │      div.root[data-phase] > div[data-slot="conversation.session.header"]
 *     │           └─ <header> (session-gated; children: titleRow [+ tabs]))
 *     ├─ div.<rightbarCol>[data-rightbar-col] (resident SHELL from first paint;
 *     │    its inner [data-slot="rightbar"] outlet is the docking surface)
 *     └─ div.<overlayLayer>[data-shell-overlay="true"] > div[data-slot="shell.overlay"]
 *
 * Re-stamp contract: stamping is idempotent and must converge whenever a
 * structural addition could have changed the stamp set — a root slot, a
 * frame, a column shell, or a slot OUTLET mounting inside a resident column
 * shell (two levels under the frame). The predicate below is the pure
 * decision; index.ts wires it to the MutationObserver. The session-header
 * chrome stamping (session-log capsule) was RETIRED at the alpha.2 replay:
 * upstream renders that control as a 28x28 icon button in the header
 * more-actions menu, so the mobile plugin no longer needs to find it by copy.
 */

export const ROOT_SLOT_SELECTOR = '[data-slot="root"]'
export const MOBILE_FRAME_ATTR = 'data-mobile-frame'
export const MOBILE_ROLE_ATTR = 'data-mobile-role'

export type MobileColumnRole = 'sidebar' | 'conversation' | 'details'

/**
 * The official slot key each mobile role anchors on. The role vocabulary is
 * the plugin's own (drawer/nav/grid CSS reads `data-mobile-role`), while the
 * slot keys track the vendor frame: the centre column became the keyed
 * `main` slot at alpha.2 and the right column is `rightbar`. Keeping the two
 * vocabularies apart means a future vendor rename touches exactly this map.
 */
export const ROLE_SLOT_KEYS: Record<MobileColumnRole, string> = {
  sidebar: 'sidebar',
  conversation: 'main',
  details: 'rightbar',
}

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

/** The frame's three columns by their child slot KEY (see ROLE_SLOT_KEYS).
 *  Null-tolerant. */
export function findColumn(frame: ElementLike, slot: string): ElementLike | null {
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
  for (const role of ['sidebar', 'conversation', 'details'] as const) {
    const column = findColumn(frame, ROLE_SLOT_KEYS[role])
    if (column !== null) column.setAttribute(MOBILE_ROLE_ATTR, role)
  }
  return frame
}

/**
 * Is an added node a structural stamping target? Pure decision for the
 * childList observer (design 17 §18 alpha.2 anchor audit). The stamp set changes
 * when any of these mounts:
 *   1. a root slot itself, or a node directly under a root slot (the frame);
 *   2. an already-stamped frame or column re-appearing (remount recovery);
 *   3. a column shell directly under a stamped frame (the a3-era recorded
 *      shape);
 *   4. a slot OUTLET wrapper mounting inside a resident column shell — two
 *      levels under a stamped frame. Both column shells and their outlet
 *      wrappers are resident from first paint in the alpha.2 frame; this
 *      branch covers the transient/remount shapes (a shell appearing before
 *      its parent is stamped) so a late mount is never left unstamped under
 *      the mobile grid lock. NOTE (coupling): convergence depends on the
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
  // The walk covers the node AND its first four ancestors looking for the
  // root slot / frame / column-role attributes. The bound keeps the streaming
  // filter intact: real chat content mounts under [data-conversation-scroll]
  // at >=6 hops from the frame, so a streaming batch never reaches the frame
  // within the window. (The four-hop reach dates from the retired session-log
  // stamping; it stays as cheap headroom for deeper resident shells.)
  let cursor: StructuralNodeLike | null | undefined = target
  for (let hop = 0; hop <= 4; hop += 1) {
    if (cursor === null || cursor === undefined) return false
    if (
      cursor.matches(ROOT_SLOT_SELECTOR)
      || cursor.matches(`[${MOBILE_FRAME_ATTR}]`)
      || cursor.matches(`[${MOBILE_ROLE_ATTR}]`)
    ) return true
    cursor = cursor.parentElement
  }
  return false
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
