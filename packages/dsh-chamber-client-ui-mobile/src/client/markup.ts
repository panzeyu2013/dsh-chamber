/**
 * Markup helpers: stamp the official frame and its three columns with the
 * plugin's data-mobile-* attributes so the stylesheet can anchor on stable
 * attributes instead of hashed class names. Pure — unit-testable under plain
 * node with a minimal DOM shim.
 *
 * Official DOM shape: #root > div[data-slot="root"] > div.<frame>, whose
 * children hold the sidebar column > [data-slot="sidebar"], the center column
 * > keyed [data-slot="main"], the rightbar column [data-rightbar-col] with its
 * docking [data-slot="rightbar"] outlet, and [data-slot="shell.overlay"]; the
 * main key's conversation renders div[data-phase] >
 * [data-slot="conversation.session.header"] > <header>.
 *
 * Re-stamp contract: idempotent, and must converge whenever a root slot, a
 * frame, a column shell, or a slot OUTLET inside a resident column shell can
 * have changed the stamp set; index.ts wires the pure predicate below to the
 * MutationObserver.
 */

export const ROOT_SLOT_SELECTOR = '[data-slot="root"]'
export const MOBILE_FRAME_ATTR = 'data-mobile-frame'
export const MOBILE_ROLE_ATTR = 'data-mobile-role'
/** The roles the probe found on the stamped frame (space-separated). A frame
 *  carrying it always carries the conversation role (see stampFrame). */
export const MOBILE_ROLES_ATTR = 'data-mobile-roles'

export type MobileColumnRole = 'sidebar' | 'conversation' | 'details'

/** The official slot key each mobile role anchors on: the role vocabulary is
 *  the plugin's own (data-mobile-role), the slot keys track the vendor frame —
 *  a vendor rename touches exactly this map. */
export const ROLE_SLOT_KEYS: Record<MobileColumnRole, string> = {
  sidebar: 'sidebar',
  conversation: 'main',
  details: 'rightbar',
}

/** The minimal element face the markup helpers need (real DOM Element and the
 *  plain-node fakes); structural, so the helpers stay testable without a shim. */
export interface ElementLike {
  children: ArrayLike<ElementLike> & Iterable<ElementLike>
  firstElementChild: ElementLike | null
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  querySelectorAll(selector: string): ArrayLike<ElementLike>
}

/** The extra face the re-stamp predicate needs: a parent chain and selector
 *  matching (ElementLike stays minimal). */
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

/**
 * Stamp the frame and columns (idempotent; returns the stamped frame, or null
 * when the frame is not adapted).
 *
 * ALL-OR-NOTHING: the grid lock and fixed drawer are only sound while the
 * conversation column is pinned by its own data-mobile-role. If upstream
 * renames the centre key, the lock would still apply and CSS Grid would drop
 * the transcript into the 0px first track — a silently blank conversation.
 * Refusing to stamp anything degrades to the official narrow layout instead.
 */
export function stampFrame(root: ElementLike): ElementLike | null {
  const frame = findFrame(root)
  if (frame === null) return null
  const columns = new Map<MobileColumnRole, ElementLike>()
  for (const role of ['sidebar', 'conversation', 'details'] as const) {
    const column = findColumn(frame, ROLE_SLOT_KEYS[role])
    if (column !== null) columns.set(role, column)
  }
  if (!columns.has('conversation')) return null
  for (const [role, column] of columns) column.setAttribute(MOBILE_ROLE_ATTR, role)
  frame.setAttribute(MOBILE_FRAME_ATTR, '')
  // Which of the three probe targets the running vendor DOM exposed.
  frame.setAttribute(MOBILE_ROLES_ATTR, [...columns.keys()].join(' '))
  return frame
}

/**
 * Is an added node a structural stamping target? Pure decision for the
 * childList observer. The stamp set changes when any of these mounts: a root
 * slot or a node directly under it (the frame); an already-stamped frame or
 * column re-appearing; a column shell directly under a stamped frame; a slot
 * OUTLET wrapper inside a resident column shell, two levels under a stamped
 * frame (covers transient/remount shapes). COUPLING: convergence depends on
 * the outlet being the shell's direct child — the shape findColumn() searches;
 * a wrapper inserted between shell and outlet would fire this branch but never
 * find the column. Deep content mutations sit deeper and never match.
 */
export function isStructuralTarget(target: StructuralNodeLike | null | undefined): boolean {
  if (target === null || target === undefined) return false
  // Walk the node and its first four ancestors for the root slot / frame /
  // role attributes. The bound keeps the streaming filter: chat content mounts
  // >=6 hops from the frame, so a streaming batch never reaches the frame.
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
 *  comment nodes never match selectors). Duck-typed so plain-node tests can
 *  feed fakes without a MutationObserver shim. */
export function isElementNode(node: unknown): node is StructuralNodeLike {
  return typeof node === 'object' && node !== null
    && typeof (node as { matches?: unknown }).matches === 'function'
}

/** The batch decision: does this childList batch contain a structural
 *  addition? Attribute/characterData records never reach it. Pure. */
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
