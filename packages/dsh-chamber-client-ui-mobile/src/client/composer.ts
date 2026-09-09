/**
 * Composer behavior layer (design 17 §18.4.4): enter-to-newline and a
 * minimal editability recovery. Anchored on the empirical 0.1.2-alpha.4
 * composer DOM: `div[contenteditable="true"][role="textbox"]
 * [data-composer-input][data-lexical-editor]` — a Lexical editor, NO
 * textarea. Editability has ONE writer in the official component: it flips
 * the `contentEditable` ATTRIBUTE (`contenteditable="true|false"`); the
 * `readonly`/`disabled` attributes are never set.
 *
 * All behaviors are meant for the touch tier only — the installer wraps
 * them behind the shared touch-tier media query (the "PC leak" lesson
 * applied to JS, mirroring the stylesheet).
 */

const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'
/** The touch tier (design 17 §18.4.2) — shared with the stylesheet tier. */
export const TOUCH_TIER_QUERY = '(max-width: 1023px) and (pointer: coarse)'
/** The phone tier (design 17 §18.4.2) — shared with the stylesheet tier; the
 *  settings sheet's behavior (settings-sheet.ts) rides THIS tier, not the
 *  touch tier: the stacked sheet it resets is phone-tier CSS only. */
export const PHONE_TIER_QUERY = '(max-width: 768px) and (pointer: coarse)'

function isComposerInput(target: EventTarget | null): boolean {
  // closest(): the keydown target is usually a leaf node inside the
  // contenteditable (a text span), not the editor element itself.
  return target instanceof Element && target.closest(COMPOSER_INPUT_SELECTOR) !== null
}

/**
 * An open command/model menu with a highlighted option? The official
 * keymap's Enter arbitration picks the highlighted item — the mobile
 * enter-to-newline must NOT swallow that (P2-2). Only intercept when no
 * highlighted menu is open.
 */
function hasHighlightedMenuOpen(): boolean {
  const highlighted = document.querySelector(
    '[data-trigger-menu] [aria-activedescendant], [data-trigger-menu] [role="option"][aria-selected="true"], [role="menu"] [role="menuitem"][aria-selected="true"]',
  )
  return highlighted !== null
}

/**
 * Safari composition edge (P2-3): the official keymap keeps a 10ms
 * `recentlyComposing` window after compositionend — Safari's final keydown
 * of a composed input carries neither isComposing nor keyCode 229. Mirror
 * the same window so a finishing Enter is never intercepted.
 */
function createComposingGuard(): { isComposingNow(): boolean; attach(): () => void } {
  let lastCompositionEnd = 0
  const onStart = (): void => { lastCompositionEnd = 0 }
  const onEnd = (): void => { lastCompositionEnd = Date.now() }
  return {
    isComposingNow: () => Date.now() - lastCompositionEnd < 10,
    attach: () => {
      document.addEventListener('compositionstart', onStart, true)
      document.addEventListener('compositionend', onEnd, true)
      return () => {
        document.removeEventListener('compositionstart', onStart, true)
        document.removeEventListener('compositionend', onEnd, true)
      }
    },
  }
}

/**
 * Enter sends in the official desktop convention; on a touch keyboard a
 * stray Enter tap fires a message. The mobile convention (surveyed in
 * design 17 §18.4.4 — NOT unanimous: the community splits between
 * Enter=newline and Enter=send with enterkeyhint): Enter inserts a line
 * break, the explicit send affordance is the send button. Composition (IME) input is never
 * intercepted (isComposing AND the legacy keyCode 229 guard, plus the
 * Safari 10ms recently-composing window).
 *
 * Lexical 0.49 gotcha (H2): the editor's root keydown listener does NOT
 * check defaultPrevented, and the official KEY_ENTER_COMMAND (CRITICAL)
 * fires the submit handler regardless — so preventDefault alone still
 * SENDS. The capture-phase handler must stopPropagation to keep the event
 * away from Lexical's root listener entirely.
 */
export function installEnterToNewline(): () => void {
  const composing = createComposingGuard()
  const detachComposing = composing.attach()
  let warnedOnce = false
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
    if (event.repeat) return
    if (composing.isComposingNow()) return
    if (!isComposerInput(event.target)) return
    // A highlighted menu option must keep the official Enter arbitration
    // (P2-2): selecting the highlighted item beats inserting a newline.
    if (hasHighlightedMenuOpen()) return
    event.preventDefault()
    event.stopPropagation()
    // execCommand is deprecated but remains the only synchronous way to
    // insert a line break into a Lexical contenteditable from outside its
    // own input pipeline. WebKit (iOS Safari) does NOT support
    // insertLineBreak — fall back to insertText('\n') so Enter never
    // silently dies on the primary mobile platform (P2-1).
    //
    // execCommand's boolean result only promises "supported and enabled",
    // NOT that the edit happened — engines are documented to return false
    // after actually inserting (and true without inserting). So before
    // touching the DOM we fingerprint the composer content; the manual
    // fallback runs ONLY when both commands failed AND the content is
    // byte-identical to the fingerprint (a false-negative command that
    // already inserted must never be double-inserted).
    const input = event.target instanceof Element ? event.target.closest(COMPOSER_INPUT_SELECTOR) : null
    const fingerprint = composerFingerprint(input)
    const ok = document.execCommand('insertLineBreak')
    if (!ok) {
      const fallbackOk = document.execCommand('insertText', false, '\n')
      if (!fallbackOk && fingerprint === composerFingerprint(input) && !insertLineBreakManually(input)) {
        // Keep the event consumed either way: falling back to the official
        // Enter=send convention mid-composition would SEND the message
        // (Lexical ignores defaultPrevented, but the command fires on the
        // untouched event only when propagation was not stopped — we
        // already stopped it, so the keystroke is inert). Surface the
        // failure loudly for real-device triage instead of failing
        // silently — once per session, never per keystroke.
        if (!warnedOnce) {
          warnedOnce = true
          console.warn('[dsh-chamber.mobile] composer line-break insertion failed (execCommand + DOM fallback)')
        }
      }
    }
    // The insert chain bypasses the official keymap pipeline (we stopped the
    // event before Lexical's submit path), so the pipeline's caret reveal
    // never runs for this Enter — when the composer has grown past its max
    // height the new line can land below the visible fold of the composer's
    // internal scrollport with nobody scrolling it. Reveal is a no-op when
    // the caret is already visible (and after a fully failed insert there is
    // nothing to reveal).
    revealCaretInComposerScroll(input)
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
    detachComposing()
  }
}

/** Cheap content fingerprint of the composer (text + node count): used to
 * tell whether an execCommand that returned false actually inserted. */
function composerFingerprint(input: Element | null): string {
  if (input === null) return ''
  return `${input.childNodes.length}:${input.textContent ?? ''}`
}

/**
 * Manual contenteditable line-break insertion (Selection/Range, no
 * execCommand): collapses the current selection and inserts a <br> — the
 * standard contenteditable newline representation. Pure DOM fallback for
 * engines where both execCommand forms fail without inserting; returns false
 * when there is no usable selection, when the selection is not inside the
 * composer, when the composer is not editable, or when the DOM insertion
 * throws. NOTE (Lexical caveat): this path bypasses the editor's input
 * pipeline — the <br> is reconciled back into the model by Lexical's root
 * observer, but input-event-driven editor logic and the undo stack do not
 * see the change. It is a best-effort last resort only.
 */
function insertLineBreakManually(input: Element | null): boolean {
  if (input === null || !(input instanceof HTMLElement) || input.contentEditable !== 'true') return false
  const selection = document.getSelection()
  if (selection === null || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  // Containment guard: focus and selection can diverge (e.g. after menu
  // interaction) — never mutate outside the composer.
  if (!input.contains(range.commonAncestorContainer)) return false
  // Folding-selection only: a non-collapsed range would delete model text
  // that Lexical does not read back from the DOM (it would "resurrect" on
  // the next render).
  if (!range.collapsed) return false
  try {
    const br = document.createElement('br')
    range.insertNode(br)
    range.setStartAfter(br)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  } catch {
    return false
  }
}

/**
 * Signed scroll delta (px) that brings the caret rect fully into the
 * composer's internal scrollport ([data-input-scroll]) with a margin.
 * Positive scrolls down, negative scrolls up, 0 = already visible. Pure —
 * unit-tested.
 */
export function caretRevealDelta(
  rectTop: number,
  rectBottom: number,
  hostTop: number,
  hostBottom: number,
  margin = 8,
): number {
  if (rectBottom > hostBottom) return rectBottom - hostBottom + margin
  if (rectTop < hostTop) return rectTop - hostTop - margin
  return 0
}

/**
 * Reveal the caret inside the composer's own scrollport after an Enter
 * newline insert. Native caret scrolling after a programmatic execCommand
 * insert is engine-dependent, so when the composer has grown past its max
 * height ([data-input-scroll] scrollable) the new line can land below the
 * visible fold with nobody scrolling it. No-op when the caret is already
 * visible or the composer has no inner overflow (everything is visible by
 * construction). DOM-bound — the geometry decision (caretRevealDelta) is
 * the unit-tested pure part.
 */
function revealCaretInComposerScroll(input: Element | null): void {
  if (input === null) return
  const scrollHost = input.closest('[data-input-scroll]')
  if (!(scrollHost instanceof HTMLElement)) return
  // No inner overflow → the caret cannot be below the fold.
  if (scrollHost.scrollHeight <= scrollHost.clientHeight) return
  const selection = document.getSelection()
  if (selection === null || selection.rangeCount === 0) return
  const hostRect = scrollHost.getBoundingClientRect()
  // Collapsed caret rects can be 0×0 at a node boundary (start/end of a
  // line): fall back to the focus node's own box, then give up.
  let rect = selection.getRangeAt(0).getBoundingClientRect()
  if (rect.height === 0 && rect.width === 0) {
    const anchor = selection.focusNode
    const element = anchor instanceof Element ? anchor : anchor?.parentElement
    if (element instanceof Element) rect = element.getBoundingClientRect()
  }
  if (rect.height === 0 && rect.width === 0) return
  const delta = caretRevealDelta(rect.top, rect.bottom, hostRect.top, hostRect.bottom)
  if (delta !== 0) scrollHost.scrollTop += delta
}

/**
 * Minimal editability recovery (IME ladder layer 2): when the composer
 * flips back to editable while still focused, the IME may stay closed (a
 * focus event is not re-fired by the official component). Blur + refocus on
 * the flip restores the keyboard. Anchored on the official
 * `contenteditable` attribute (the ONE writer of editability).
 */
export function installEditabilityRecovery(root: ParentNode = document): () => void {
  let lastEditable = true
  const observer = new MutationObserver(() => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof HTMLElement)) return
    const editable = input.contentEditable === 'true'
    if (editable && !lastEditable && input === document.activeElement) {
      input.blur()
      input.focus({ preventScroll: true })
    }
    lastEditable = editable
  })
  observer.observe(root, { attributes: true, attributeFilter: ['contenteditable'], subtree: true })
  return () => observer.disconnect()
}

/** The keyboard is considered open when the visual viewport loses more than
 *  120px AND 20% of the layout viewport height (community consensus metric,
 *  design 17 §18.4.4). Pure function — unit-testable. */
export function isKeyboardOpen(layoutHeight: number, visualHeight: number): boolean {
  const gap = layoutHeight - visualHeight
  return gap > 120 && gap > layoutHeight * 0.2
}

/**
 * IME ladder layers 1/3/4 (design 17 §18.4.4 — the five-layer ladder,
 * completed in P1.5):
 *   1. programmatic-focus drop loop — a focus that did NOT come from a
 *      pointer gesture is dropped (blur) and re-dropped for up to 12 rAF
 *      frames (the official React submit effect re-focuses programmatically,
 *      which leaves the IME closed on Android WebView). Mobile-navigation
 *      gestures (drawer rows, session header breadcrumbs) are treated like
 *      programmatic focus: the official InputBar returns focus to the box on
 *      session change, and on iOS that would pop the keyboard right after a
 *      drawer-driven switch — see isNavigationGestureTarget below.
 *   3. pointerup refocus — a tap INSIDE the composer with the keyboard
 *      closed re-focuses within the same gesture (focus({preventScroll})
 *      after pointerup is a user gesture, so the IME opens);
 *   4. visualViewport keyboard detection — feeds layer 3's guard and the
 *      keyboard visibility state.
 * Layer 2 (editability flip) lives in installEditabilityRecovery; layer 5
 * (keyboard-visible composer compensation) lives in the stylesheet
 * (interactive-widget=resizes-content where the engine honors it) +
 * installKeyboardCompensation below (the visual-viewport fallback).
 */

/**
 * Gesture regions that are MOBILE NAVIGATION, not typing intent: anything
 * inside the sidebar drawer (its rows are the session switcher) and inside
 * the conversation session header (crumbs/breadcrumbs navigate sessions;
 * the lineage chips open subagent catalogs). A programmatic composer
 * refocus that follows a pointer gesture in these regions (the official
 * InputBar returns focus to the box on session change) must be dropped —
 * otherwise iOS pops the keyboard right after every drawer switch.
 */
export const NAV_GESTURE_SELECTOR = '[data-mobile-role="sidebar"], [data-slot="conversation.session.header"]'

/** The minimal element face the navigation-gesture predicate needs. */
export interface ClosestLike {
  closest(selector: string): ClosestLike | null
}

/** Pure decision: did this pointer gesture start in a navigation region?
 *  Layer 1 (installImeLadder) no longer reads this directly — navigation
 *  regions are never inside the composer seat, so nav gestures classify as
 *  non-typing by construction (the seat test alone decides typing intent;
 *  M2 review narrowing). Kept exported as the semantic name for
 *  drawer/session-header gestures: picker/menu and message-area gestures
 *  are neither navigation NOR typing (a message-area scroll must neither
 *  arm typing intent nor cancel a pending navigation drop). */
export function isNavigationGestureTarget(target: ClosestLike | null): boolean {
  return target !== null && target.closest(NAV_GESTURE_SELECTOR) !== null
}

export interface ImeLadder {
  attach(): () => void
  isKeyboardOpen(): boolean
}

export function installImeLadder(root: ParentNode = document): ImeLadder {
  let lastPointerDown = 0
  /** The gesture that produced the last pointerdown was TYPING INTENT — it
   *  started INSIDE the composer seat. This is layer 1's gesture test: a
   *  programmatic composer refocus after a non-seat gesture (a sidebar
   *  session switch — the official InputBar returns focus to the box on
   *  session change; but also any scroll/tap in the message area) must NOT
   *  count as user-intended typing: it would pop the iOS keyboard right
   *  after navigation. Only a seat pointerdown is typing intent. */
  let lastPointerDownInSeat = false
  let keyboardOpen = false

  const syncKeyboard = (): void => {
    const vv = window.visualViewport
    keyboardOpen = vv !== null && isKeyboardOpen(window.innerHeight, vv.height)
  }

  /** Did this pointerdown land inside the composer seat (the input plus its
   *  `[data-composer-seat]` wrapper — send button etc.)? */
  const gestureInSeat = (event: { target: EventTarget | null }): boolean => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof Element)) return false
    const seat = input.closest('[data-composer-seat]')
    const zone = seat instanceof Element ? seat : input
    return event.target instanceof Node && zone.contains(event.target)
  }

  const onPointerDown = (event: PointerEvent): void => {
    // Every pointer type is tracked (mouse included): on coarse-primary
    // devices with an attached mouse/hardware keyboard a real click into
    // the composer is typing intent and must not be dropped. Navigation
    // gestures (drawer rows, header crumbs — isNavigationGestureTarget)
    // are never inside the seat, so they classify as non-typing by
    // construction.
    lastPointerDown = Date.now()
    // Typing intent requires the pointerdown INSIDE the composer seat. A
    // mid-window pointerdown in the message area (a scroll, a tap on a
    // bubble) is NEITHER navigation NOR typing: it must not reclassify the
    // pending navigation refocus as intended typing, and it must not cancel
    // an in-flight drop loop (review M2: 切会 + 500ms 内滚动仍弹键盘).
    lastPointerDownInSeat = gestureInSeat(event)
  }

  const onFocusIn = (event: FocusEvent): void => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof HTMLElement)) return
    if (event.target !== input && !input.contains(event.target as Node)) return
    // Layer 1: a recent SEAT gesture is user-intended typing (the tap that
    // put the caret there). Programmatic refocus after anything else (a
    // navigation gesture, or a non-seat pointerdown such as a message-area
    // scroll inside the navigation window) is dropped — and kept dropping
    // for 12 rAF frames (the official submit effect re-focuses within the
    // commit). A fresh seat pointerdown cancels the drop loop (the new tap
    // must win).
    const fromGesture = Date.now() - lastPointerDown < 500 && lastPointerDownInSeat
    if (fromGesture) return
    let frames = 0
    let cancelled = false
    const onGestureCancel = (event: PointerEvent): void => {
      // Only a NEW typing gesture (composer seat pointerdown) cancels the
      // drop loop — a neutral pointerdown (message-area scroll mid-window)
      // must not interrupt the ongoing drop of a navigation refocus (review
      // M2), and a navigation gesture starts its own drop instead.
      if (gestureInSeat(event)) cancelled = true
    }
    document.addEventListener('pointerdown', onGestureCancel, true)
    const drop = (): void => {
      frames += 1
      if (frames > 12 || cancelled) {
        document.removeEventListener('pointerdown', onGestureCancel, true)
        return
      }
      if (input === document.activeElement && !keyboardOpen) {
        input.blur()
        requestAnimationFrame(drop)
      } else {
        document.removeEventListener('pointerdown', onGestureCancel, true)
      }
    }
    drop()
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') return
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof HTMLElement)) return
    if (!input.contains(event.target as Node)) return
    if (input === document.activeElement) return
    if (keyboardOpen) return
    // Layer 3: refocus inside the same tap gesture so the IME opens.
    input.focus({ preventScroll: true })
  }

  const onViewportResize = (): void => {
    syncKeyboard()
  }

  return {
    attach: () => {
      syncKeyboard()
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('pointerup', onPointerUp, true)
      window.visualViewport?.addEventListener('resize', onViewportResize)
      window.visualViewport?.addEventListener('scroll', onViewportResize)
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('focusin', onFocusIn, true)
        document.removeEventListener('pointerup', onPointerUp, true)
        window.visualViewport?.removeEventListener('resize', onViewportResize)
        window.visualViewport?.removeEventListener('scroll', onViewportResize)
      }
    },
    isKeyboardOpen: () => keyboardOpen,
  }
}

/**
 * Keyboard-visible composer compensation (IME ladder layer 5, P1.5 +
 * mobile round): with interactive-widget=resizes-content the layout viewport
 * already shrinks; this is the fallback for engines that ignore the token —
 * iOS Safari (the soft keyboard overlays the LAYOUT viewport) and older
 * Android WebViews. The official composer seat is `position: sticky;
 * bottom: 0` and a FLOW child of the conversation scrollport, so it pins to
 * the LAYOUT bottom and ends up BEHIND the keyboard; scrolling the
 * scrollport cannot lift it (sticky re-pins it) and scrollIntoView cannot
 * see the visual viewport — the old pinning attempt was a no-op exactly
 * there. The compensation mirrors resizes-content semantics against the
 * visual viewport instead: while the keyboard is open the seat's sticky
 * bottom is raised to the keyboard top and the scrollport gets an equal
 * bottom padding (both via the frame's `--dsh-mobile-kbd-offset`, see
 * styles.ts), and a bottom-pinned conversation is scrolled down by the same
 * delta so the message tail stays readable right above the raised seat. The
 * official chat already re-glues the OUTER scroll on seat resize (ui-chat's
 * ResizeObserver follows `[data-composer-seat]`), so this installer owns only
 * the keyboard-driven geometry change.
 *
 * Guards (2026-12 review + cross-check round): a visual-viewport shrink is
 * necessary but NOT sufficient — zoom shrinks the visual viewport with no
 * keyboard (the plugin deliberately keeps user-scalable for WCAG 1.4.4), and
 * a keyboard can belong to a field that is not the composer. The community's
 * most developed implementation reached the same conclusion after a
 * foldable/split-screen false-positive round (dsh-meow-smooth's dynamic
 * baseline + editable-focus signal).
 *
 * Zoom policy (cross-check P1): a blanket scale veto is WRONG — iOS
 * focus-zooms on the drawer's 13px search field (ui-workspace:1187) and the
 * page stays zoomed, so vetoing every zoomed state would leave the composer
 * behind the keyboard for the rest of the session. Under zoom the compensation
 * is served for the COMPOSER only: `covered = layout - offsetTop - vv.height`
 * is exactly how far the sticky seat's layout position exceeds the visual
 * viewport's bottom edge, so lifting by it brings the composer back above the
 * keyboard (the browser's own pan usually already zeroes it). Non-composer
 * fields keep the veto — panning a zoomed page must not drive the offset.
 * The focus-zoom trigger itself is also removed at the source (styles.ts
 * gives the drawer's fields the same 16px floor as the composer/dialogs).
 *
 * Re-sync entries beyond visualViewport events: window resize (rotation /
 * browser chrome), visibilitychange (mobile browsers do not deliver the
 * missed visualViewport events while the tab is suspended), focusin (a seat
 * remount — session switch or reconnect settle — re-arms without a viewport
 * event) and focusout (a blur starts the grace window at the moment it
 * happens, not at the last focusin). Arming is IDEMPOTENT per frame element:
 * a renderer remount replaces the AppFrame while the keyboard stays open with
 * unchanged geometry, so the numeric `applied` short-circuit alone would
 * leave the new frame unarmed and the composer behind the keyboard.
 */
export const KBD_OFFSET_QUANTUM_PX = 16
/** Extra lift above the raw covered height (keeps the seat clear of the
 *  keyboard top even when the engine's final geometry lands mid-step). */
export const KBD_OFFSET_HEADROOM_PX = 8
/** State attribute toggled on the stamped frame (plugin-owned surface). */
export const MOBILE_KBD_ATTR = 'data-mobile-kbd'
/** Offset custom property set on the stamped frame (styles.ts consumes it). */
export const MOBILE_KBD_VAR = '--dsh-mobile-kbd-offset'
/** Recently-focused-editable grace window: a blur (or an editability flip
 *  during submit) must keep the compensation armed through the
 *  keyboard-close animation and the editability-recovery refocus instead of
 *  dropping the seat mid-transition. */
export const KBD_EDITABLE_FOCUS_GRACE_MS = 1_200
/** The active conversation's sticky composer seat (phase guard: hero/blank
 *  seats are not sticky — only an active session has the bottom-pinned
 *  seat the keyboard can cover). */
const ACTIVE_SEAT_SELECTOR = '[data-phase="active"] [data-composer-seat]'

/** Height of the layout viewport bottom edge the keyboard covers: layout
 *  bottom minus the visual viewport bottom, both in layout coordinates.
 *  Valid at any zoom: the visual viewport's reported height already accounts
 *  for both the zoom shrink and the keyboard, so the difference is exactly
 *  how far the layout bottom exceeds the visible bottom edge. Pure —
 *  unit-tested. */
export function kbdCoveredHeight(layoutHeight: number, visualHeight: number, visualOffsetTop: number): number {
  return Math.max(0, layoutHeight - visualOffsetTop - visualHeight)
}

/** Quantized (ceil) offset: applied in steps while the keyboard slides,
 *  always ≥ covered + headroom so the seat never sits under the keyboard
 *  top. 0 when nothing is covered. 16px (cross-check: the 48px step left an
 *  8-55px dead band above the keyboard — iPhone 14 48px, SE 45px, Gboard
 *  44px; 16px leaves 8-23px, and visualViewport events are frame-coalesced,
 *  so the extra steps cost nothing measurable). Pure — unit-tested. */
export function nextKbdOffset(
  covered: number,
  quantum: number = KBD_OFFSET_QUANTUM_PX,
  headroom: number = KBD_OFFSET_HEADROOM_PX,
): number {
  if (covered <= 0) return 0
  return Math.ceil((covered + headroom) / quantum) * quantum
}

/** Is the scrollport pinned to its content end (the conversation bottom)?
 *  Pure — unit-tested. */
export function isAtScrollEnd(scrollTop: number, scrollHeight: number, clientHeight: number, slack = 8): boolean {
  if (clientHeight <= 0 || scrollHeight <= clientHeight) return true
  return scrollTop + clientHeight >= scrollHeight - slack
}

/** Should the keyboard compensation arm? Pure — unit-tested. See the zoom
 *  policy above: a shrink alone is not enough, and under zoom only the
 *  composer is served. */
export function shouldCompensateKeyboard(
  keyboardOpen: boolean,
  visualScale: number,
  editableFocused: boolean,
  composerFocused: boolean,
): boolean {
  if (!keyboardOpen || !editableFocused) return false
  // Zoom (pinch or iOS focus-zoom): vv.height shrinks while the layout
  // viewport does not. 1.01 tolerates float noise in the reported scale.
  if (visualScale > 1.01 && !composerFocused) return false
  return true
}

/** Does this focus target open a soft keyboard? Covers the Lexical composer
 *  (contenteditable), plain inputs/textareas (settings sheet, question cards)
 *  — the keyboard's owner, whatever the field. */
function isEditableFocus(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA'
}

/** Is the caret inside the composer's editor/seat? Used as the zoom-policy
 *  discriminator and as a fallback while the official editor flips
 *  `contenteditable` off during submit (`live && !locked && !machineBusy`,
 *  ui-conversation:15371) — the DOM selection survives that flip. */
function isComposerSelection(): boolean {
  const selection = document.getSelection()
  const anchor = selection?.anchorNode ?? null
  if (anchor === null) return false
  const element = anchor instanceof Element ? anchor : anchor.parentElement
  if (!(element instanceof Element)) return false
  return element.closest(COMPOSER_INPUT_SELECTOR) !== null || element.closest('[data-composer-seat]') !== null
}

export function installKeyboardCompensation(root: ParentNode = document): () => void {
  const vv = window.visualViewport
  if (vv === null) return () => {}
  let applied = 0
  /** The frame currently carrying the offset (teardown handle: the frame
   *  persists across seat remounts, so disarm must target the element that
   *  actually carries the attribute). */
  let armedFrame: HTMLElement | null = null
  let lastEditableFocusAt = 0

  const disarm = (): void => {
    if (armedFrame === null) return
    armedFrame.removeAttribute(MOBILE_KBD_ATTR)
    armedFrame.style.removeProperty(MOBILE_KBD_VAR)
    armedFrame = null
  }

  /** The keyboard's owner: an editable element focused right now, a caret
   *  still inside the composer (the editor flips `contenteditable` off during
   *  submit without blurring), or either of those within the grace window
   *  (blur / session-switch refocus). */
  const editableFocused = (): boolean => {
    if (isEditableFocus(document.activeElement)) return true
    if (isComposerSelection()) return true
    return Date.now() - lastEditableFocusAt < KBD_EDITABLE_FOCUS_GRACE_MS
  }

  /** Is the keyboard the COMPOSER's? The zoom policy serves only this case
   *  (cross-check P1). */
  const composerFocused = (): boolean => {
    const active = document.activeElement
    if (active instanceof Element
      && (active.closest(COMPOSER_INPUT_SELECTOR) !== null || active.closest('[data-composer-seat]') !== null)) {
      return true
    }
    return isComposerSelection()
  }

  const sync = (): void => {
    const layoutHeight = window.innerHeight
    const target = shouldCompensateKeyboard(
      isKeyboardOpen(layoutHeight, vv.height),
      vv.scale,
      editableFocused(),
      composerFocused(),
    )
      ? nextKbdOffset(kbdCoveredHeight(layoutHeight, vv.height, vv.offsetTop))
      : 0
    if (target === 0) {
      applied = 0
      disarm()
      return
    }
    // Only the ACTIVE session seat is sticky bottom-pinned; a hero/blank
    // seat must not be lifted (its scrollport can scroll normally).
    // Single-shell deployment: one seat.
    const seat = root.querySelector(ACTIVE_SEAT_SELECTOR)
    if (!(seat instanceof Element)) return
    const frame = seat.closest('[data-mobile-frame]')
    if (!(frame instanceof HTMLElement)) return
    // Idempotent ensure keyed on the FRAME ELEMENT, not on the numeric
    // offset alone: a renderer remount replaces the AppFrame while the
    // keyboard stays open with unchanged geometry, so `target === applied`
    // must not short-circuit — the new frame still needs the attribute
    // (review fix: the old form left the composer behind the keyboard until
    // the geometry happened to change).
    const armed = frame === armedFrame && frame.hasAttribute(MOBILE_KBD_ATTR)
    if (armed && target === applied) return
    // A re-arm onto a DIFFERENT frame must clean the previous one: the old
    // element keeps its plugin-owned attribute/custom property forever
    // otherwise (cross-check: only reachable while detached, but it is
    // plugin state leaking onto a dead node).
    if (armedFrame !== null && armedFrame !== frame) disarm()
    // Was the conversation pinned to its end before this step? If yes, keep
    // the message tail glued above the seat: the scrollport grows by the
    // offset (bottom padding) below the content, so without a matching
    // scroll the last messages would slide behind the keyboard. The end
    // check runs BEFORE the geometry change (the post-change max already
    // includes the new padding).
    const scroller = seat.closest('[data-conversation-scroll]')
    const wasAtEnd = scroller instanceof HTMLElement
      && isAtScrollEnd(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight)
    // A freshly armed frame carries no offset yet: the effective previous
    // offset is 0, so the glue delta is the full target (the alternative —
    // trusting the stale counter — would under-scroll after a remount).
    const delta = armed ? target - applied : target
    frame.setAttribute(MOBILE_KBD_ATTR, '')
    frame.style.setProperty(MOBILE_KBD_VAR, `${target}px`)
    armedFrame = frame
    applied = target
    // The scrollTop write forces layout with the new padding already in
    // place; a pinned scrollport clamps exactly to the new content end.
    if (wasAtEnd && scroller instanceof HTMLElement && delta > 0) {
      scroller.scrollTop += delta
    }
  }

  const onViewportChange = (): void => sync()
  const onFocusIn = (event: FocusEvent): void => {
    if (isEditableFocus(event.target)) lastEditableFocusAt = Date.now()
    // A seat remount (session switch / reconnect settle) re-arms here even
    // when no visualViewport event follows.
    sync()
  }
  const onFocusOut = (event: FocusEvent): void => {
    // Stamp the grace window at the MOMENT of the blur — the editor flipping
    // `contenteditable` off during submit, a keepFocus-less control taking
    // focus and the keyboard-close animation all start here, not at the last
    // focusin (cross-check D2).
    if (isEditableFocus(event.target)) lastEditableFocusAt = Date.now()
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') sync()
  }
  sync()
  vv.addEventListener('resize', onViewportChange)
  vv.addEventListener('scroll', onViewportChange)
  window.addEventListener('resize', onViewportChange)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    vv.removeEventListener('resize', onViewportChange)
    vv.removeEventListener('scroll', onViewportChange)
    window.removeEventListener('resize', onViewportChange)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('focusout', onFocusOut, true)
    document.removeEventListener('visibilitychange', onVisibility)
    applied = 0
    disarm()
  }
}

/**
 * Composer self-heal (design 17 §18.4.4, P1.5): if the composer stays
 * non-editable for BUSY_STUCK_MS while the user actively taps it, force a
 * recovery (blur → restore contenteditable → refocus). The official
 * component is the writer of editability, so this only fires on a genuine
 * stuck state (30s), never during a normal submit; a failed recovery leaves
 * the DOM untouched.
 */
export const BUSY_STUCK_MS = 30_000

export function installComposerSelfHeal(root: ParentNode = document): () => void {
  let lockedSince = 0
  const observer = new MutationObserver(() => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof HTMLElement)) return
    const editable = input.contentEditable === 'true'
    if (!editable) {
      if (lockedSince === 0) lockedSince = Date.now()
    } else {
      lockedSince = 0
    }
  })
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') return
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof HTMLElement)) return
    if (!input.contains(event.target as Node)) return
    if (lockedSince === 0) return
    if (Date.now() - lockedSince < BUSY_STUCK_MS) return
    // User actively tapped a stuck composer — force recovery.
    lockedSince = 0
    const editable = input.contentEditable === 'true'
    if (editable) return
    input.blur()
    input.contentEditable = 'true'
    input.focus({ preventScroll: true })
  }
  observer.observe(root, { attributes: true, attributeFilter: ['contenteditable'], subtree: true })
  document.addEventListener('pointerdown', onPointerDown, true)
  return () => {
    observer.disconnect()
    document.removeEventListener('pointerdown', onPointerDown, true)
  }
}
