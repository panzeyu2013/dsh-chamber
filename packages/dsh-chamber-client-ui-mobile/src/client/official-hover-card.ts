/**
 * Stranded official hover-card watchdog (design 17 §18.4.5; coarse/no-hover
 * tier only).
 *
 * THE DEFECT. The official `ui-primitives` HoverCard atom arms its 200ms close
 * grace from the last COMMITTED `open` state: in the pinned build the
 * wrapper's leave handler is `() => { clearOpenTimer(); open && armGrace() }`
 * (served bundle: `onPointerLeave:()=>{P(),b&&B()}`, grace
 * `setTimeout(...,200)`). A leave that lands inside the commit window (the
 * dwell timer already fired, the card not yet committed) arms nothing, and the
 * card then mounts with the pointer already gone — no later boundary event
 * ever targets that wrapper. On touch the boundary event is missing outright:
 * a tap synthesizes the hover, the finger leaves, and no pointerleave that
 * "leaves the region" is delivered. The card is portaled to `document.body`
 * with `position: fixed` (244px wide, z-index 100), so hiding the host view —
 * or any host-scoped CSS — cannot hide it.
 *
 * THE TIER. This package is the ONLY chamber-owned code in the instance's own
 * frontend tier (the gateway seeds exactly one client plugin — this one), and
 * the vendored official package is read-only, so the recovery has to be a
 * document-level watchdog that drives the atom through an event it already
 * handles. It runs only under the same coarse-pointer/no-hover gate as the
 * stylesheet's sticky-tooltip rule: a hover-capable pointer does not exist
 * there, so "a legitimately hovered card" cannot exist in the CSS sense
 * either — every card on this tier comes from a tap (or a stale tap-hover).
 *
 * THE LEVER. The atom's wrapper is a real React-rendered element and its
 * `onPointerLeave` runs off React's ROOT-DELEGATED `pointerout` listener.
 * Dispatching a bubbling `pointerout` ON THE WRAPPER with no related target
 * makes React's enter/leave plugin read `from = wrapper, to = null` (it reads
 * `nativeEvent.relatedTarget || nativeEvent.fromElement`, then resolves the
 * target's fiber) and dispatch `onPointerLeave` along the wrapper's fiber
 * chain — the same path a real "pointer left the window" takes. A card in the
 * DOM means the atom's committed `open` is true (the card element only exists
 * then), so that leave ARMS the grace close; a genuine `pointerenter` inside
 * the grace cancels it (`cancel()` runs first in the atom's enter handler), so
 * every dismissal the watchdog triggers stays cancellable by real user input.
 * No other DOM effect: the served official bundle registers NO native
 * `pointerout`/`pointerleave` listener, so the dispatched event reaches only
 * React's delegated listener and the atom's own handler.
 *
 * GUARDS (pure decisions below, unit-tested without a DOM):
 *  - only a MATCHED wrapper/card pair is ever touched — the card carries the
 *    HoverCard CSS-module card token, the wrapper its root token, and the
 *    geometry is the atom's own anchoring relation (`card.left =
 *    wrapper.right + 8`; `card.top = wrapper.top`, or the bottom-clamped
 *    `card.bottom = innerHeight - 8` variant). Exactly one wrapper must match,
 *    a degenerate anchor rect (hidden row) never matches, and a document with
 *    no card is a no-op before any wrapper is even queried;
 *  - gestures: `pointerdown` (capture) only, and only when BOTH the event
 *    target and the pointer coordinates are outside the wrapper AND the card,
 *    each inflated by a 2px safety margin. A press on the row or on the card
 *    is left entirely to the atom's own handlers (the card's copy button stays
 *    usable);
 *  - page state: `window.blur` and `visibilitychange -> hidden`, where the
 *    page the card belongs to is not being looked at. Residual, documented:
 *    with the pointer physically parked on a row across a blur the card closes
 *    and reopens only after the pointer leaves and re-enters the row — the
 *    same trade the chamber's own hover-intent fix takes on the composite tier;
 *  - ONE event kind is ever dispatched (`pointerout`, bubbling, no related
 *    target). Never click/pointerdown/key/touch: the watchdog cannot activate,
 *    navigate or move focus;
 *  - no timers of its own, `try`/`catch` fail-closed on anything unexpected,
 *    and one `Symbol.for` window guard so a double install cannot install two
 *    listener sets.
 *
 * NOT COVERED: the instance-origin frontend opened DIRECTLY (e.g. :17510) has
 * no chamber client plugin at all, and the chamber composite page renders the
 * chamber-owned `RowHoverCard` instead of the official atom — see the package
 * README "Residual reality".
 *
 * Anchor-version note: both class tokens are the pinned build's CSS-module
 * names (`_root_1b2ny_3` / `_card_1b2ny_13` in the served bundle; the
 * `1b2ny` segment is the module hash). They must be re-audited when the
 * vendored dsh pin moves — like every other anchor in this package. A stale
 * token makes the watchdog a silent no-op (fail closed), never a misfire.
 */

/** The tier this watchdog may run on — byte-identical to the stylesheet's
 *  coarse-pointer chrome tier (width-independent: a landscape tablet taps
 *  too, while attaching a mouse flips `hover` and restores official
 *  behavior). */
export const COARSE_NO_HOVER_QUERY = '(pointer: coarse) and (hover: none)'

/** The official HoverCard module's root token (`_root_<hash>_<line>`). */
export const OFFICIAL_CARD_ROOT_CLASS_TOKEN = '_root_1b2ny_'

/** The official HoverCard module's card token (`_card_<hash>_<line>`). */
export const OFFICIAL_CARD_CLASS_TOKEN = '_card_1b2ny_'

/** Candidate prefilter selectors (attribute substring), validated by token. */
export const CARD_QUERY = `[class*="${OFFICIAL_CARD_CLASS_TOKEN}"]`
export const CARD_ROOT_QUERY = `[class*="${OFFICIAL_CARD_ROOT_CLASS_TOKEN}"]`

/** The atom anchors the card this far right of the wrapper (px). */
export const CARD_ANCHOR_GAP_PX = 8

/** Geometry tolerance (px): sub-pixel layout rounding only. */
export const CARD_ANCHOR_TOLERANCE_PX = 2

/** Safety inflation (px) for "the pointer is not on it" tests: an inflated
 *  rect means MORE "inside", i.e. fewer dismissals — the fail-closed way. */
export const POINTER_OUTSIDE_MARGIN_PX = 2

/** The one window property this module owns (double-install guard). */
const WATCHDOG_GUARD: unique symbol = Symbol.for('dsh-chamber.dsh-client-ui-mobile.stranded-hover-card')

/** The minimal rect face (real `DOMRect` satisfies it; fakes in tests). */
export interface RectLike {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** The minimal element face the scan needs (real `Element` satisfies it). */
export interface ElementFace {
  getAttribute(name: string): string | null
  getBoundingClientRect(): RectLike
}

/** The minimal query root face (real `Document` satisfies it). */
export interface QueryRootFace<E extends ElementFace> {
  querySelectorAll(selector: string): ArrayLike<E>
}

/** One stranded card and the wrapper whose leave boundary dismisses it. */
export interface StrandedCardPair<E> {
  card: E
  wrapper: E
}

/**
 * Does this `class` attribute carry the given CSS-module token as a WHOLE
 * token — `_card_1b2ny_13` yes, a foreign hash, a longer word or a substring
 * inside another class no? The build appends the module line, so only digits
 * may follow the token. Pure — unit-tested.
 * @param classAttr - the raw `class` attribute.
 * @param token - the token including its trailing underscore.
 * @returns whether the attribute carries that exact module class.
 */
export function hasModuleClassToken(classAttr: string | null | undefined, token: string): boolean {
  if (typeof classAttr !== 'string' || classAttr === '') return false
  for (const part of classAttr.split(/\s+/)) {
    if (part.length <= token.length || !part.startsWith(token)) continue
    if (/^[0-9]+$/.test(part.slice(token.length))) return true
  }
  return false
}

/** Finite rect numbers (a detached or un-laid-out node can report NaN). */
function isFiniteRect(rect: RectLike): boolean {
  return Number.isFinite(rect.left) && Number.isFinite(rect.top)
    && Number.isFinite(rect.right) && Number.isFinite(rect.bottom)
}

/**
 * A rect that can anchor a card: finite and with real width. A hidden or
 * un-laid-out row reports an all-zero rect, which must never be mistaken for
 * "the card sits at left 8, top 0". Pure — unit-tested.
 * @param rect - the candidate wrapper rect.
 * @returns whether the rect is usable as a card anchor.
 */
export function isUsableAnchorRect(rect: RectLike): boolean {
  return isFiniteRect(rect) && rect.right > rect.left
}

/**
 * Is this card hung off this wrapper by the atom's own anchoring relation
 * (`left = wrapper.right + 8`; `top = wrapper.top`, or the bottom-clamped
 * `bottom = innerHeight - 8` with the card above the wrapper)? Pure —
 * unit-tested.
 * @param wrapper - the candidate wrapper's rect.
 * @param card - the candidate card's rect.
 * @param viewportHeight - `window.innerHeight` at scan time.
 * @returns whether the two rects form the atom's anchor relation.
 */
export function matchesCardAnchor(wrapper: RectLike, card: RectLike, viewportHeight: number): boolean {
  if (!isUsableAnchorRect(wrapper) || !isFiniteRect(card)) return false
  if (Math.abs(card.left - (wrapper.right + CARD_ANCHOR_GAP_PX)) > CARD_ANCHOR_TOLERANCE_PX) return false
  if (Math.abs(card.top - wrapper.top) <= CARD_ANCHOR_TOLERANCE_PX) return true
  // Bottom-clamped: top = innerHeight - cardHeight - 8, i.e. bottom =
  // innerHeight - 8, and then the card necessarily starts above the wrapper.
  return Number.isFinite(viewportHeight)
    && Math.abs(card.bottom - (viewportHeight - CARD_ANCHOR_GAP_PX)) <= CARD_ANCHOR_TOLERANCE_PX
    && card.top <= wrapper.top
}

/**
 * Is the point outside the rect, with a margin that only ever makes the test
 * MORE conservative (an inflated rect swallows near-misses, and a non-finite
 * point reads as "not provably outside"). Pure — unit-tested.
 * @param x - pointer client x.
 * @param y - pointer client y.
 * @param rect - the rect to test against.
 * @param margin - safety inflation in px.
 * @returns whether the pointer is provably outside the rect.
 */
export function isOutsideRect(
  x: number,
  y: number,
  rect: RectLike,
  margin: number = POINTER_OUTSIDE_MARGIN_PX,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !isFiniteRect(rect)) return false
  return x < rect.left - margin || x > rect.right + margin
    || y < rect.top - margin || y > rect.bottom + margin
}

/** What a press says about one matched pair (both channels must agree). */
export interface GestureFacts {
  /** The event target is inside the wrapper (the row itself). */
  targetInWrapper: boolean
  /** The event target is inside the card (its copy affordance included). */
  targetInCard: boolean
  /** The pointer coordinates are inside the wrapper rect. */
  pointInWrapper: boolean
  /** The pointer coordinates are inside the card rect. */
  pointInCard: boolean
}

/**
 * Is this press demonstrably away from BOTH the wrapper and its card — by
 * target AND by coordinates? Only then may the pair be dismissed: a press on
 * the row belongs to the atom's own handler, a press on the card must keep
 * working. Pure — unit-tested.
 * @param facts - the per-pair press facts.
 * @returns whether the press is provably elsewhere.
 */
export function isGestureOutside(facts: GestureFacts): boolean {
  return !facts.targetInWrapper && !facts.targetInCard && !facts.pointInWrapper && !facts.pointInCard
}

/**
 * Find the document's stranded cards, each with the single wrapper that
 * anchors it. A card with zero or several geometric parents is skipped (an
 * ambiguous relation must never be dismissed through the wrong wrapper), and
 * a document without cards returns before the wrapper query. Fails closed:
 * any unexpected DOM shape simply yields no pair.
 * @param root - the query root (the real `document`).
 * @param viewportHeight - `window.innerHeight` at scan time.
 * @returns the matched pairs, in card order.
 */
export function scanStrandedCards<E extends ElementFace>(
  root: QueryRootFace<E>,
  viewportHeight: number,
): Array<StrandedCardPair<E>> {
  const pairs: Array<StrandedCardPair<E>> = []
  const cards = Array.from(root.querySelectorAll(CARD_QUERY)).filter(
    candidate => hasModuleClassToken(candidate.getAttribute('class'), OFFICIAL_CARD_CLASS_TOKEN),
  )
  // The no-card short circuit is part of the contract: no card, no action.
  if (cards.length === 0) return pairs
  const wrappers = Array.from(root.querySelectorAll(CARD_ROOT_QUERY)).filter(
    candidate => hasModuleClassToken(candidate.getAttribute('class'), OFFICIAL_CARD_ROOT_CLASS_TOKEN),
  )
  for (const card of cards) {
    const cardRect = card.getBoundingClientRect()
    const matches = wrappers.filter(
      wrapper => matchesCardAnchor(wrapper.getBoundingClientRect(), cardRect, viewportHeight),
    )
    if (matches.length !== 1) continue
    pairs.push({ card, wrapper: matches[0] as E })
  }
  return pairs
}

/** The minimal dispatch face (real `Element` satisfies it). */
export interface DispatchFace {
  dispatchEvent(event: Event): boolean
}

/**
 * Drive the atom's own close path: one bubbling `pointerout` with no related
 * target, dispatched on the wrapper. React resolves `from = wrapper,
 * to = null` and runs the wrapper's `onPointerLeave`, which — with the card
 * in the DOM, i.e. committed open — arms the atom's 200ms grace close.
 * @param wrapper - the matched wrapper element.
 * @returns whether a boundary event was dispatched (false when unsupported).
 */
export function dispatchBoundaryLeave(wrapper: DispatchFace): boolean {
  try {
    const init: PointerEventInit = { bubbles: true, cancelable: false, composed: true, relatedTarget: null }
    // PointerEvent everywhere pointer events exist; the fallbacks keep a
    // plain-node harness (and any exotic engine) on the same code path.
    const EventCtor: typeof PointerEvent = typeof PointerEvent === 'function'
      ? PointerEvent
      : typeof MouseEvent === 'function'
        ? (MouseEvent as unknown as typeof PointerEvent)
        : (Event as unknown as typeof PointerEvent)
    return wrapper.dispatchEvent(new EventCtor('pointerout', init))
  } catch {
    // Fail closed: a watchdog must never break the page it watches.
    return false
  }
}

/** The guarded window property's shape. */
interface GuardedWindow {
  [WATCHDOG_GUARD]?: () => void
}

/**
 * Install the stranded-card watchdog. Idempotent: a second install while one
 * is live returns a no-op disposer (the first one keeps watching). The
 * returned disposer removes every listener, clears the guard, and is itself
 * idempotent.
 * @param active - live tier gate, read at event time (matchMedia result).
 * @returns the disposer.
 */
export function installStrandedHoverCardWatchdog(active: () => boolean): () => void {
  // DOM-free harness (the package's plain-node test files) and any
  // non-browser scope: nothing to watch, nothing installed.
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const guard = window as unknown as GuardedWindow
  if (guard[WATCHDOG_GUARD] !== undefined) return () => {}

  /** The page-state path: the page is not being looked at. */
  const dismissAll = (): void => {
    try {
      if (!active()) return
      for (const pair of scanStrandedCards(document, window.innerHeight)) dispatchBoundaryLeave(pair.wrapper)
    } catch {
      // Fail closed.
    }
  }

  const onBlur = (): void => { dismissAll() }

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') dismissAll()
  }

  const onPointerDown = (event: PointerEvent): void => {
    try {
      if (!active()) return
      const target = event.target
      if (!(target instanceof Element)) return
      const x = event.clientX
      const y = event.clientY
      for (const pair of scanStrandedCards(document, window.innerHeight)) {
        const facts: GestureFacts = {
          targetInWrapper: pair.wrapper.contains(target),
          targetInCard: pair.card.contains(target),
          pointInWrapper: !isOutsideRect(x, y, pair.wrapper.getBoundingClientRect()),
          pointInCard: !isOutsideRect(x, y, pair.card.getBoundingClientRect()),
        }
        if (!isGestureOutside(facts)) continue
        dispatchBoundaryLeave(pair.wrapper)
      }
    } catch {
      // Fail closed.
    }
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('blur', onBlur)

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('blur', onBlur)
    if (guard[WATCHDOG_GUARD] === dispose) delete guard[WATCHDOG_GUARD]
  }
  guard[WATCHDOG_GUARD] = dispose
  return dispose
}
