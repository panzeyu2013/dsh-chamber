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
 *     │    └─ div.root[data-phase] > div[data-slot="conversation.session.header"]
 *     │         └─ <header> (session-gated; children: titleRow [+ tabs]))
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
 * is the pure decision; index.ts wires it to the MutationObserver. The
 * session-header chrome stamps (stampSessionLogDismiss) ride the same
 * re-stamp channels with a PRUNED search (the chat scroll body is never
 * walked — the streaming filter applies to the stamp cadence too).
 */

export const ROOT_SLOT_SELECTOR = '[data-slot="root"]'
export const MOBILE_FRAME_ATTR = 'data-mobile-frame'
export const MOBILE_ROLE_ATTR = 'data-mobile-role'

export type MobileColumnRole = 'sidebar' | 'conversation' | 'details'

/** The official per-session conversation header slot outlet (session scope). */
export const CONVERSATION_SESSION_HEADER_SLOT = 'conversation.session.header'

/**
 * The plugin's own dismissal/compact stamp for official header controls that
 * are desktop-first chrome. The "Session 日志" export capsule is the phone
 * victim: 111px+ min-width pill in the header utilities that eats most of a
 * 375px title row (the mobile round of the adaptation surface — design 17
 * §18.4.3, header-row compaction).
 */
export const SESSION_LOG_DISMISS_ATTR = 'data-mobile-dismiss'
export const SESSION_LOG_DISMISS_VALUE = 'session-log-export'

/**
 * Official session-log-export visible label (`header.action` in the
 * `session-log-download` locale NS — zh/en are the only shipped
 * dictionaries at the 0.1.2-rc.1 pin; matching is exact + trim so an
 * upstream copy change fails SOFT (no stamp, the pill keeps its official
 * width) instead of mis-stamping another control). The download icon check
 * is structural: the official capsule is `span(label) + svg(IconDownload)`.
 */
export const SESSION_LOG_EXPORT_LABELS = ['Session 日志', 'Session log'] as const

/** A button whose text is readable for label matching (real Element + fakes). */
export interface ButtonTextLike extends ElementLike {
  readonly textContent: string | null
}

/** Is this button the official session-log export capsule? Pure label + icon test. */
export function isSessionLogExportButton(button: ButtonTextLike): boolean {
  if ((SESSION_LOG_EXPORT_LABELS as readonly string[]).includes((button.textContent ?? '').trim())) {
    // Structural guard: the capsule always pairs the label with the download
    // icon — a stray button reusing the same copy must not be stamped.
    return findDescendant(button, el => el !== button && isSvgElement(el)) !== null
  }
  return false
}

function isSvgElement(el: ElementLike): boolean {
  const tag = (el as { tag?: unknown; tagName?: unknown }).tag
  const tagName = (el as { tagName?: unknown }).tagName
  const name = typeof tag === 'string' ? tag : tagName
  return typeof name === 'string' && name.toLowerCase() === 'svg'
}

/** First descendant (breadth by tree order) satisfying the predicate. */
export function findDescendant(root: ElementLike, test: (el: ElementLike) => boolean): ElementLike | null {
  const stack: ElementLike[] = []
  for (const child of root.children) stack.push(child)
  while (stack.length > 0) {
    const current = stack.shift() as ElementLike
    if (test(current)) return current
    for (const child of current.children) stack.push(child)
  }
  return null
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

/**
 * Stamp the official session-log export capsule for phone-tier compaction
 * (idempotent; returns the stamped button or null). The header DOM carries
 * no stable attribute on the capsule itself (hashed classes only), so the
 * stamp walks the official anchor shape — conversation column → session
 * header slot outlet → buttons — and marks the one whose copy is the
 * official `session-log-download` label (bilingual). Mounts late: the
 * session header outlet is session-gated, so this runs on every re-stamp
 * (the frame-attribute and structural channels in index.ts) and simply
 * finds nothing until a session header exists. Never throws on partial
 * shapes (hero, blank session, header hidden). The search PRUNES the chat
 * scroll body (`[data-conversation-scroll]`, the streaming subtree) and the
 * composer seat — the header slot lives ABOVE them under the conversation
 * root, and the re-stamp cadence (drawer flips) must never rescan
 * thousands of streamed nodes.
 */
export function stampSessionLogDismiss(frame: ElementLike): ElementLike | null {
  const conversation = findColumn(frame, 'conversation')
  if (conversation === null) return null
  const headerSlot = findHeaderSlot(conversation)
  if (headerSlot === null) return null
  const buttons = headerSlot.querySelectorAll('button')
  for (let index = 0; index < buttons.length; index++) {
    const button = buttons[index]
    const candidate = button as ButtonTextLike
    if (isSessionLogExportButton(candidate)) {
      button.setAttribute(SESSION_LOG_DISMISS_ATTR, SESSION_LOG_DISMISS_VALUE)
      return button
    }
  }
  return null
}

/** Deep first-match by slot attribute (the documented column/outlet shape).
 *  Prunes chat-scroll and composer subtrees: the session header outlet is a
 *  shallow ancestor of the conversation column — the deep streaming DOM
 *  must never be walked on the re-stamp cadence. */
function findHeaderSlot(root: ElementLike): ElementLike | null {
  for (const child of root.children) {
    if (child.getAttribute('data-slot') === CONVERSATION_SESSION_HEADER_SLOT) return child
    if (child.hasAttribute('data-conversation-scroll')) continue
    if (child.hasAttribute('data-composer-seat')) continue
    const nested = findHeaderSlot(child)
    if (nested !== null) return nested
  }
  return null
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
  // The stamp set includes the SESSION-header chrome (stampSessionLogDismiss),
  // whose outlet mounts FOUR levels under the frame (frame > col >
  // [data-slot=conversation] > .root[data-phase] >
  // [data-slot=conversation.session.header]) — so the walk covers the node
  // AND its first four ancestors looking for the root slot / frame /
  // column-role attributes. The walk is BOUNDED at four hops, which keeps
  // the streaming filter intact: real chat content mounts under
  // [data-conversation-scroll] at ≥6 hops from the frame, so a streaming
  // batch never reaches the frame within the window.
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
