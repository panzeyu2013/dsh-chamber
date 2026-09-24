/**
 * Composer behavior layer: enter-to-newline and a minimal editability
 * recovery. Anchored on the official composer DOM:
 * div[contenteditable="true"][data-composer-input][data-lexical-editor] —
 * a Lexical editor, NO textarea. Editability has ONE writer in the official
 * component: it flips the contentEditable ATTRIBUTE
 * (contenteditable="true|false"); readonly/disabled are never set.
 *
 * All behaviors are touch-tier only: the installer wraps them behind the
 * shared touch-tier media query, mirroring the stylesheet.
 */

const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'
/** The touch tier — shared with the stylesheet tier. */
export const TOUCH_TIER_QUERY = '(max-width: 1023px) and (pointer: coarse)'
/** The phone tier — shared with the stylesheet tier. The settings sheet's
 *  behavior rides THIS tier, not the touch tier: the stacked sheet it resets
 *  is phone-tier CSS only. */
export const PHONE_TIER_QUERY = '(max-width: 768px) and (pointer: coarse)'

/** The editability face the gate reads (a real Element satisfies it). */
export interface EditableFace {
  readonly contentEditable?: string
}

/**
 * Is this the composer's EDITOR (contenteditable="true") rather than the
 * resident node wearing the composer's attributes? The official InputBar
 * keeps ONE div for both states: with no workspace editor = null, so
 * contentEditable renders false while the div still carries
 * [data-composer-input] and the official onKeyDown that opens the workspace
 * picker (Enter/Space, tabIndex=0). The mobile Enter handler stops
 * propagation at capture, so intercepting that state would swallow the
 * picker's own Enter while inserting nothing. Pure — unit-tested.
 */
export function isEditableComposer(input: EditableFace | null | undefined): boolean {
  return input !== null && input !== undefined && input.contentEditable === 'true'
}

/**
 * An open command/model menu with a highlighted option? The official keymap's
 * Enter arbitration picks the highlighted item — enter-to-newline must NOT
 * swallow that. Only intercept when no highlighted menu is open. The trigger
 * menu is the only producer that matters: it keeps focus in the composer and
 * publishes its highlight through aria-activedescendant /
 * role=option[aria-selected] (the ui-primitives Menu renders items without
 * aria-selected and moves focus into the menu, so a menuitem's Enter never
 * reaches this document handler anyway).
 */
function hasHighlightedMenuOpen(): boolean {
  const highlighted = document.querySelector(
    '[data-trigger-menu] [aria-activedescendant], [data-trigger-menu] [role="option"][aria-selected="true"]',
  )
  return highlighted !== null
}

/**
 * Safari composition edge: the official keymap keeps a 10ms recentlyComposing
 * window after compositionend — Safari's final keydown of a composed input
 * carries neither isComposing nor keyCode 229. Mirror the same window so a
 * finishing Enter is never intercepted.
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
 * Enter inserts a line break (touch convention; the official desktop default
 * is Enter=send, which a stray tap would fire). IME composition is never
 * intercepted (isComposing AND keyCode 229, plus the Safari window).
 *
 * Lexical 0.49 gotcha: its root keydown listener does NOT check
 * defaultPrevented and KEY_ENTER_COMMAND (CRITICAL) fires submit regardless —
 * preventDefault alone still SENDS, so the capture-phase handler must
 * stopPropagation. Scope: only the composer's EDITOR; the same div doubles as
 * the no-workspace picker trigger while non-editable and owns Enter there via
 * the official React handler (see isEditableComposer).
 */
export function installEnterToNewline(): () => void {
  const composing = createComposingGuard()
  const detachComposing = composing.attach()
  let warnedOnce = false
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
    if (event.repeat) return
    // The official accelerated submit chord (Ctrl/Cmd+Enter, queue↔steer) is
    // not a newline gesture — pass it through untouched.
    if (event.ctrlKey || event.metaKey) return
    if (composing.isComposingNow()) return
    const input = event.target instanceof Element ? event.target.closest(COMPOSER_INPUT_SELECTOR) : null
    // Editability gate: the no-workspace picker wears the same attribute as
    // non-editable and owns Enter itself (see isEditableComposer).
    if (!(input instanceof HTMLElement) || !isEditableComposer(input)) return
    // A highlighted menu option must keep the official Enter arbitration.
    if (hasHighlightedMenuOpen()) return
    event.preventDefault()
    event.stopPropagation()
    // execCommand is deprecated but the only synchronous way into a Lexical
    // contenteditable; WebKit (iOS Safari) lacks insertLineBreak, so fall
    // back to insertText('\n'). Its boolean only claims "supported", not that
    // the edit happened, so the manual fallback runs ONLY when both commands
    // failed AND the fingerprint is unchanged (never double-insert).
    const fingerprint = composerFingerprint(input)
    const ok = document.execCommand('insertLineBreak')
    if (!ok) {
      const fallbackOk = document.execCommand('insertText', false, '\n')
      if (!fallbackOk && fingerprint === composerFingerprint(input) && !insertLineBreakManually(input)) {
        // The event stays consumed (falling back to Enter=send would SEND);
        // surface the failure once per session, never per keystroke.
        if (!warnedOnce) {
          warnedOnce = true
          console.warn('[dsh-chamber.mobile] composer line-break insertion failed (execCommand + DOM fallback)')
        }
      }
    }
    // This enter bypasses the official pipeline's caret reveal: after a
    // programmatic insert the new line can land below the scrollport fold.
    revealCaretInComposerScroll(input)
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
    detachComposing()
  }
}

/** Cheap composer fingerprint (text + node count): did a false-returning
 *  execCommand actually insert? */
function composerFingerprint(input: Element | null): string {
  if (input === null) return ''
  return `${input.childNodes.length}:${input.textContent ?? ''}`
}

/**
 * Manual contenteditable line-break insertion (Selection/Range, no
 * execCommand): collapse the selection and insert a <br>. Returns false
 * without a usable selection inside an editable composer, or when the DOM
 * insertion throws. Lexical caveat: this bypasses the editor's input
 * pipeline — the root observer reconciles the <br> into the model, but
 * input-event logic and the undo stack do not see it. Last resort only.
 */
function insertLineBreakManually(input: Element | null): boolean {
  if (input === null || !(input instanceof HTMLElement) || input.contentEditable !== 'true') return false
  const selection = document.getSelection()
  if (selection === null || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  // Focus and selection can diverge (menu interaction): never mutate
  // outside the composer.
  if (!input.contains(range.commonAncestorContainer)) return false
  // Folding-selection only: a non-collapsed range would delete model text
  // Lexical does not read back (it would "resurrect" on the next render).
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
 * composer's internal scrollport with a margin. Positive scrolls down,
 * negative up, 0 = already visible. Pure — unit-tested.
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
 * newline insert: native caret scrolling after a programmatic insert is
 * engine-dependent, so the new line can land below the fold. No-op when the
 * composer has no inner overflow.
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
  // Collapsed caret rects can be 0×0 at a node boundary: fall back to the
  // focus node's box, then give up.
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

/** Did an editability mutation flip the composer from non-editable to
 *  editable while it holds focus? recordOldValues are the attribute
 *  before-images; the tracked-state pair is the in-memory fallback.
 *
 *  CALLER CONTRACT: pass before-images of records whose TARGET is the
 *  composer itself — every contenteditable record of the batch would let a
 *  nested Lexical decorator blur+refocus the composer MID-TYPING. Pure. */
export function isEditabilityFlipToEditable(
  editableNow: boolean,
  focused: boolean,
  previousEditable: boolean | null,
  recordOldValues: readonly (string | null)[],
): boolean {
  if (!editableNow || !focused) return false
  return previousEditable === false || recordOldValues.includes('false')
}

/**
 * Minimal editability recovery (IME ladder layer 2): when the composer flips
 * back to editable while still focused, the IME may stay closed (no focus
 * event is re-fired); blur + refocus on the flip restores the keyboard.
 *
 * The flip is read from the mutation's oldValue plus state seeded FROM THE
 * DOM: React writes contenteditable on the detached element, so a composer
 * that mounts non-editable produces no record — a lastEditable = true guess
 * would read the first genuine flip as "no change" and skip recovery.
 */
/** MutationObserver options for the editability-recovery channel: WITHOUT
 *  attributeOldValue the false -> true flip is invisible for a composer the
 *  observer never saw mount. */
export const EDITABILITY_MUTATION_OPTIONS: MutationObserverInit = {
  attributes: true,
  attributeFilter: ['contenteditable'],
  subtree: true,
  attributeOldValue: true,
}

export function installEditabilityRecovery(root: ParentNode = document): () => void {
  let current: HTMLElement | null = null
  let lastEditable: boolean | null = null
  const query = (): HTMLElement | null => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    return input instanceof HTMLElement ? input : null
  }
  const seed = (input: HTMLElement | null): void => {
    current = input
    lastEditable = input === null ? null : input.contentEditable === 'true'
  }
  // Seed from the DOM, never an assumption: the composer may already be mounted.
  seed(query())
  const observer = new MutationObserver(records => {
    const input = query()
    if (input === null) {
      seed(null)
      return
    }
    const editable = input.contentEditable === 'true'
    // A FRESH element re-seeds instead of reporting a flip: never observed.
    const previous = input === current ? lastEditable : editable
    if (isEditabilityFlipToEditable(
      editable,
      input === document.activeElement,
      previous,
      // Only the composer's OWN flip may recover the keyboard.
      records.filter(record => record.target === input).map(record => record.oldValue),
    )) {
      input.blur()
      input.focus({ preventScroll: true })
    }
    seed(input)
  })
  observer.observe(root, EDITABILITY_MUTATION_OPTIONS)
  return () => observer.disconnect()
}

/** Keyboard open when the visual viewport loses more than 120px AND 20% of
 *  the layout viewport height (browser chrome stays below both). Pure. */
export function isKeyboardOpen(layoutHeight: number, visualHeight: number): boolean {
  const gap = layoutHeight - visualHeight
  return gap > 120 && gap > layoutHeight * 0.2
}

/**
 * IME ladder layers 1/3/4 (layer 2 is installEditabilityRecovery; layer 5 is
 * the stylesheet arm plus installComposerVisibilityGuard):
 *   1. programmatic-focus drop loop — a focus that did not come from a
 *      pointer gesture is blurred and re-dropped for up to 12 rAF frames
 *      (the official submit effect re-focuses programmatically, leaving the
 *      IME closed on Android WebView); navigation gestures classify like
 *      programmatic focus (isNavigationGestureTarget).
 *   3. pointerup refocus — a tap inside the composer re-focuses within the
 *      gesture so the IME opens;
 *   4. visualViewport keyboard detection (feeds layer 3's guard and state).
 */

/**
 * Gesture regions that are MOBILE NAVIGATION, not typing intent: the sidebar
 * drawer (its rows switch sessions) and the conversation session header
 * (crumbs navigate sessions; lineage chips open subagent catalogs). A
 * programmatic composer refocus that follows a pointer gesture in these
 * regions (the official InputBar returns focus to the box on session change)
 * must be dropped, or iOS pops the keyboard right after every switch.
 */
export const NAV_GESTURE_SELECTOR = '[data-mobile-role="sidebar"], [data-slot="conversation.session.header"]'

/** The minimal element face the navigation-gesture predicate needs. */
export interface ClosestLike {
  closest(selector: string): ClosestLike | null
}

/** Pure decision: did this pointer gesture start in a navigation region?
 *  Kept exported as the semantic name for drawer/session-header gestures —
 *  layer 1 does not read it (navigation regions are never inside the
 *  composer seat, so the seat test alone classifies typing intent). */
export function isNavigationGestureTarget(target: ClosestLike | null): boolean {
  return target !== null && target.closest(NAV_GESTURE_SELECTOR) !== null
}

export interface ImeLadder {
  attach(): () => void
  isKeyboardOpen(): boolean
}

export function installImeLadder(root: ParentNode = document): ImeLadder {
  let lastPointerDown = 0
  /** The last pointerdown was TYPING INTENT — it started INSIDE the composer
   *  seat. Layer 1's gesture test: a programmatic refocus after a non-seat
   *  gesture (sidebar switch, message-area scroll/tap) must NOT count — it
   *  would pop the iOS keyboard right after navigation. */
  let lastPointerDownInSeat = false
  let keyboardOpen = false

  const syncKeyboard = (): void => {
    const vv = window.visualViewport
    keyboardOpen = vv !== null && isKeyboardOpen(window.innerHeight, vv.height)
  }

  /** Did this pointerdown land inside the composer seat (the input plus its
   *  [data-composer-seat] wrapper)? */
  const gestureInSeat = (event: { target: EventTarget | null }): boolean => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof Element)) return false
    const seat = input.closest('[data-composer-seat]')
    const zone = seat instanceof Element ? seat : input
    return event.target instanceof Node && zone.contains(event.target)
  }

  const onPointerDown = (event: PointerEvent): void => {
    // Every pointer type counts (mouse included): on a coarse-primary device
    // a hardware-mouse click into the composer is still typing intent.
    lastPointerDown = Date.now()
    // Typing intent requires the seat. A mid-window message-area pointerdown
    // is NEITHER navigation NOR typing: it must not reclassify a pending
    // navigation refocus, nor cancel an in-flight drop loop.
    lastPointerDownInSeat = gestureInSeat(event)
  }

  const onFocusIn = (event: FocusEvent): void => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof HTMLElement)) return
    if (event.target !== input && !input.contains(event.target as Node)) return
    // Layer 1: a recent SEAT gesture is typing intent. Anything else is
    // dropped for 12 rAF frames (the official submit effect re-focuses within
    // the commit); a fresh seat pointerdown cancels the drop loop.
    const fromGesture = Date.now() - lastPointerDown < 500 && lastPointerDownInSeat
    if (fromGesture) return
    let frames = 0
    let cancelled = false
    const onGestureCancel = (event: PointerEvent): void => {
      // Only a NEW typing gesture cancels the drop loop — a neutral
      // message-area pointerdown must not interrupt a navigation drop.
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
 * Composer visibility guard (IME ladder layer 5).
 *
 * Do not infer the keyboard — measure the overlap: the scrollport's bottom
 * edge minus the visible bottom (vv.offsetTop + vv.height), in layout
 * coordinates under pan/zoom. The scrollport's flex-sized border box is an
 * ACTUATOR INVARIANT (our writes cannot move it), so the loop has a fixed
 * point. ONE actuator: the seat's sticky bottom plus an in-flow spacer before
 * the seat — never scrollport padding, which shrinks the sticky containing
 * block and double-lifts the seat. Guards: hysteresis and typing intent
 * (editable focus / composer selection / grace window). Triggers:
 * visualViewport resize/scroll, window resize, focusin/out, visibilitychange,
 * [data-phase] observer and a bounded poll while an editable is focused (mobile
 * browsers suspend the missed visualViewport events, so visibilitychange and
 * focus must re-sync).
 * Outcomes are written to data-mobile-kbd / data-mobile-kbd-state (armed |
 * idle | no-seat | no-frame | still-covered); corrections are bounded
 * (KBD_MAX_VERIFY_STEPS, then still-covered), never a ramp. The zoom veto
 * stays for non-composer fields (panning a zoomed page is inert).
 */
export const KBD_OFFSET_QUANTUM_PX = 16
/** Extra lift above the raw covered height so the seat stays clear of the
 *  keyboard top. */
export const KBD_OFFSET_HEADROOM_PX = 8
/** State attribute toggled on the stamped frame (plugin-owned surface). */
export const MOBILE_KBD_ATTR = 'data-mobile-kbd'
/** Offset custom property set on the stamped frame (styles.ts consumes it). */
export const MOBILE_KBD_VAR = '--chamber-mobile-kbd-offset'
/** Recently-focused-editable grace window: keeps the compensation armed
 *  through the keyboard-close animation and the editability-recovery refocus. */
export const KBD_EDITABLE_FOCUS_GRACE_MS = 1_200
/** Arm threshold: the overlap must be clearly keyboard-scale before lifting;
 *  browser-chrome overlap stays well below it (a 60px overlap stays idle). */
export const KBD_ARM_PX = 96
/** Release threshold, below the arm threshold on purpose (hysteresis): once
 *  armed the lift is held until the overlap is effectively gone. */
export const KBD_DISARM_PX = 72
/** Post-write acceptance tolerance before the guard keeps correcting. */
export const KBD_VERIFY_SLACK_PX = 24
/** Bounded post-write corrections per sync: an engine that ignores the sticky
 *  inset must be REPORTED, not chased. */
export const KBD_MAX_VERIFY_STEPS = 2
/** Bounded poll cadence/budget while an editable holds focus (covers engines
 *  that deliver no visualViewport event). */
export const KBD_POLL_MS = 250
export const KBD_POLL_BUDGET_MS = 4_000
/** Diagnosis surface (plugin-owned attribute, never an official one). */
export const MOBILE_KBD_STATE_ATTR = 'data-mobile-kbd-state'
/** The in-flow spacer that supplies the scroll range above the raised seat
 *  (replaces the scrollport padding arm, see above). */
export const MOBILE_KBD_SPACER_ATTR = 'data-mobile-kbd-spacer'
/** The active conversation's sticky composer seat (hero/blank seats are not
 *  sticky — only an active session has the seat the keyboard can cover). */
const ACTIVE_SEAT_SELECTOR = '[data-phase="active"] [data-composer-seat]'

/** Hysteresis + quantization: arm only at keyboard-scale overlap, hold while
 *  armed, then ceil + headroom so the seat never lands under the keyboard
 *  top. Pure — unit-tested. */
export function kbdLiftTarget(
  covered: number,
  armed: boolean,
  armThreshold: number = KBD_ARM_PX,
  disarmThreshold: number = KBD_DISARM_PX,
): number {
  if (covered <= (armed ? disarmThreshold : armThreshold)) return 0
  return nextKbdOffset(covered)
}

/** Quantized (ceil) offset: ≥ covered + headroom, so the seat never sits
 *  under the keyboard top; 0 when nothing is covered. 16px quantum: a 48px
 *  step left an 8-55px dead band (visualViewport events are frame-coalesced,
 *  so extra steps cost nothing). Pure — unit-tested. */
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

/** Does this focus target open a soft keyboard? Covers the Lexical composer
 *  (contenteditable) and plain inputs/textareas (settings sheet, question
 *  cards) — the keyboard's owner, whatever the field. */
function isEditableFocus(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA'
}

/** Is the caret inside the composer's editor/seat? Used as the zoom-policy
 *  discriminator and as a fallback while the editor flips contenteditable off
 *  during submit (the DOM selection survives that flip). */
function isComposerSelection(): boolean {
  const selection = document.getSelection()
  const anchor = selection?.anchorNode ?? null
  if (anchor === null) return false
  const element = anchor instanceof Element ? anchor : anchor.parentElement
  if (!(element instanceof Element)) return false
  return element.closest(COMPOSER_INPUT_SELECTOR) !== null || element.closest('[data-composer-seat]') !== null
}

export function installComposerVisibilityGuard(root: ParentNode = document): () => void {
  let applied = 0
  /** The measured edge moved WITH one of our own writes (see applyLift). */
  let carrierPushed = false
  /** The frame currently carrying the offset (teardown handle: the frame is
   *  replaced by renderer remounts, so disarm must target the live element). */
  let armedFrame: HTMLElement | null = null
  /** The in-flow spacer that gives the conversation its scroll range above
   *  the raised seat (a scrollport padding arm would shrink the sticky
   *  containing block and double-lift the seat). */
  let spacer: HTMLElement | null = null
  let lastEditableFocusAt = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollUntil = 0
  let disposed = false
  let phaseNode: Element | null = null

  /** The visible bottom edge in LAYOUT coordinates (pan + zoom included). */
  const visibleBottom = (): number => {
    const vv = window.visualViewport
    return vv === null ? window.innerHeight : vv.offsetTop + vv.height
  }

  /** Diagnosis surface: every outcome is readable off the frame (and off
   *  <html> so a missing frame is still visible). */
  const setState = (state: string): void => {
    const frame = armedFrame ?? root.querySelector('[data-mobile-frame]')
    if (frame instanceof HTMLElement) frame.setAttribute(MOBILE_KBD_STATE_ATTR, state)
    document.documentElement.setAttribute(MOBILE_KBD_STATE_ATTR, state)
  }

  const removeSpacer = (): void => {
    if (spacer === null) return
    spacer.remove()
    spacer = null
  }

  /** The diagnosis surface is torn down with the actuator: a disposed or
   *  idle guard must not leave a stale data-mobile-kbd-state behind. */
  const clearState = (): void => {
    for (const frame of root.querySelectorAll('[data-mobile-frame]')) {
      if (frame instanceof HTMLElement) frame.removeAttribute(MOBILE_KBD_STATE_ATTR)
    }
    document.documentElement.removeAttribute(MOBILE_KBD_STATE_ATTR)
  }

  const disarm = (): void => {
    if (armedFrame !== null) {
      armedFrame.removeAttribute(MOBILE_KBD_ATTR)
      armedFrame.style.removeProperty(MOBILE_KBD_VAR)
      armedFrame = null
    }
    removeSpacer()
    clearState()
    applied = 0
    carrierPushed = false
  }

  /** The keyboard's owner: an editable focused now, a caret still inside the
   *  composer (the editor flips contenteditable off during submit without
   *  blurring), or either within the grace window. */
  const editableFocused = (): boolean => {
    if (isEditableFocus(document.activeElement)) return true
    if (isComposerSelection()) return true
    return Date.now() - lastEditableFocusAt < KBD_EDITABLE_FOCUS_GRACE_MS
  }

  /** Is the field the COMPOSER's? A keyboard belonging to the settings sheet
   *  or a question card must not move the seat. */
  const composerFocused = (): boolean => {
    const active = document.activeElement
    if (active instanceof Element
      && (active.closest(COMPOSER_INPUT_SELECTOR) !== null || active.closest('[data-composer-seat]') !== null)) {
      return true
    }
    return isComposerSelection()
  }

  /** The active conversation's sticky seat, committed only when its
   *  scrollport is actually laid out: [data-phase="active"] is NOT unique, and
   *  a hidden earlier match would serve a zero-sized scrollport while the real
   *  seat stayed covered. */
  const seatOf = (): Element | null => {
    for (const candidate of root.querySelectorAll(ACTIVE_SEAT_SELECTOR)) {
      if (!(candidate instanceof Element)) continue
      const scroller = candidate.closest('[data-conversation-scroll]')
      if (!(scroller instanceof HTMLElement)) continue
      const rect = scroller.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      return candidate
    }
    return null
  }

  /** THE MEASUREMENT: how far the conversation scrollport's bottom edge sits
   *  below the visible bottom, in layout coordinates. The scrollport's border
   *  box is flex-sized upstream, so the value is invariant under the guard's
   *  own writes. null when the scrollport is absent. That premise is not ours
   *  to enforce, so applyLift probes the edge across the write and latches
   *  (carrierPushed) instead of trusting it. */
  const coveredOf = (seat: Element): number | null => {
    const scroller = seat.closest('[data-conversation-scroll]')
    if (!(scroller instanceof HTMLElement)) return null
    return scroller.getBoundingClientRect().bottom - visibleBottom()
  }

  /** The sticky seat only exists in the active phase: a phase flip must
   *  re-arm (no viewport/focus event follows it). */
  const phaseObserver = new MutationObserver(() => sync())
  const observePhase = (): void => {
    const node = root.querySelector('[data-phase]')
    if (node === phaseNode) return
    phaseObserver.disconnect()
    phaseNode = node
    if (node !== null) phaseObserver.observe(node, { attributes: true, attributeFilter: ['data-phase'] })
  }

  /** Grow the flow above the seat without touching the scrollport's own box
   *  (padding would shrink the sticky containing block — the double-lift). */
  const ensureSpacer = (seat: Element, height: number): void => {
    if (spacer === null || !spacer.isConnected) {
      spacer = document.createElement('div')
      spacer.setAttribute(MOBILE_KBD_SPACER_ATTR, '')
      spacer.style.cssText = 'flex:none;pointer-events:none'
      seat.parentElement?.insertBefore(spacer, seat)
    } else if (spacer.nextElementSibling !== seat) {
      // The renderer rebuilds the seat list on remount: keep the spacer
      // immediately before the seat instead of orphaning it.
      seat.parentElement?.insertBefore(spacer, seat)
    }
    spacer.style.height = `${height}px`
  }

  const sync = (): void => {
    if (disposed) return
    observePhase()
    const seat = seatOf()
    if (seat === null) {
      disarm()
      setState('no-seat')
      return
    }
    const frame = seat.closest('[data-mobile-frame]')
    if (!(frame instanceof HTMLElement)) {
      disarm()
      setState('no-frame')
      return
    }
    const covered = coveredOf(seat)
    if (covered === null) {
      disarm()
      setState('no-seat')
      return
    }
    const target = kbdLiftTarget(covered, applied > 0)
    if (target === 0 || !editableFocused() || !composerFocused()) {
      disarm()
      setState('idle')
      return
    }
    // A re-arm onto a DIFFERENT frame must clean the previous one: the old
    // element would keep its plugin-owned attribute/custom property forever.
    if (armedFrame !== null && armedFrame !== frame) disarm()
    const scroller = seat.closest('[data-conversation-scroll]')
    const wasAtEnd = scroller instanceof HTMLElement
      && isAtScrollEnd(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight)
    /** ONE writer for the actuator: attribute, custom property and spacer
     *  height are never allowed to disagree. */
    const applyLift = (value: number): void => {
      // Self-push probe: read the measured edge immediately before and after
      // THIS write; the window is synchronous, so movement inside it is ours.
      const node = scroller instanceof HTMLElement ? scroller : null
      const before = node === null ? null : node.getBoundingClientRect().bottom
      const increment = value - applied
      frame.setAttribute(MOBILE_KBD_ATTR, String(value))
      frame.style.setProperty(MOBILE_KBD_VAR, `${value}px`)
      ensureSpacer(seat, value)
      if (node !== null && before !== null && increment > 0
          && node.getBoundingClientRect().bottom - before >= increment * 0.5) {
        carrierPushed = true
      }
      applied = value
    }
    armedFrame = frame
    // A latched carrier never grows again; the residue is REPORTED, not chased.
    let lift = carrierPushed && target > applied ? applied : target
    applyLift(lift)
    // If the conversation was pinned to its end, keep the tail glued above
    // the raised seat (the spacer grows the range below the content).
    if (wasAtEnd && scroller instanceof HTMLElement) scroller.scrollTop += lift
    // BOUNDED verification: an engine that ignores the sticky inset or lands
    // short is corrected at most KBD_MAX_VERIFY_STEPS times, then REPORTED —
    // the residual is a fresh TOTAL, not an added delta, so the spacer cannot
    // compound past the measured overlap.
    let steps = 0
    while (!carrierPushed && steps < KBD_MAX_VERIFY_STEPS) {
      const residual = seat.getBoundingClientRect().bottom - visibleBottom()
      if (residual <= KBD_VERIFY_SLACK_PX) break
      const extra = nextKbdOffset(residual) - lift
      if (extra <= 0) break
      lift += extra
      applyLift(lift)
      if (wasAtEnd && scroller instanceof HTMLElement) scroller.scrollTop += extra
      steps += 1
    }
    // FINAL-lift write: attribute, property and spacer all carry this value.
    applyLift(lift)
    const residual = seat.getBoundingClientRect().bottom - visibleBottom()
    setState(residual > KBD_VERIFY_SLACK_PX ? 'still-covered' : 'armed')
  }

  /** Bounded poll while an editable holds focus: engines that deliver NO
   *  visualViewport event still converge; the budget is PER FOCUS ARM (the
   *  deadline is stamped once, a running interval is never extended), so
   *  pointer/focus churn cannot turn it into a permanent 250ms sync loop. */
  const startPoll = (): void => {
    if (pollTimer !== null) return
    pollUntil = Date.now() + KBD_POLL_BUDGET_MS
    pollTimer = setInterval(() => {
      if (disposed || Date.now() > pollUntil || !editableFocused()) {
        if (pollTimer !== null) clearInterval(pollTimer)
        pollTimer = null
        return
      }
      sync()
    }, KBD_POLL_MS)
  }

  const onViewportChange = (): void => sync()
  const onFocusIn = (event: FocusEvent): void => {
    if (isEditableFocus(event.target)) lastEditableFocusAt = Date.now()
    // A seat remount re-arms here even when no visualViewport event follows.
    startPoll()
    sync()
  }
  const onFocusOut = (event: FocusEvent): void => {
    // Stamp the grace window at the MOMENT of the blur — the editability
    // flip, a control taking focus and the keyboard-close animation start here.
    if (isEditableFocus(event.target)) lastEditableFocusAt = Date.now()
  }
  const onPointerDown = (): void => {
    // A tap can raise the keyboard with no viewport event: re-sync ONCE. The
    // poll budget belongs to the focus episode — never re-arm or extend it.
    sync()
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') sync()
  }
  startPoll()
  sync()
  window.visualViewport?.addEventListener('resize', onViewportChange)
  window.visualViewport?.addEventListener('scroll', onViewportChange)
  window.addEventListener('resize', onViewportChange)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    disposed = true
    if (pollTimer !== null) clearInterval(pollTimer)
    phaseObserver.disconnect()
    window.visualViewport?.removeEventListener('resize', onViewportChange)
    window.visualViewport?.removeEventListener('scroll', onViewportChange)
    window.removeEventListener('resize', onViewportChange)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('focusout', onFocusOut, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('visibilitychange', onVisibility)
    disarm()
    clearState()
  }
}

/**
 * Composer self-heal: if the composer stays non-editable INSIDE A SUBMISSION
 * WINDOW for BUSY_STUCK_MS while the user taps it, force a recovery (blur →
 * restore contenteditable → refocus). The official component is editability's
 * only writer, so this fires on a genuine stuck submit; a failed recovery
 * leaves the DOM untouched.
 */
export const BUSY_STUCK_MS = 30_000

/** The composer data-phase values that mean a submission is IN FLIGHT
 *  (official input machine: adjudicating / submitting). */
export const BUSY_COMPOSER_PHASES: readonly string[] = ['adjudicating', 'submitting']

/** Is the composer inside a submission window? Pure — unit-tested. */
export function isComposerSubmitBusy(phase: string | null | undefined): boolean {
  return phase !== null && phase !== undefined && BUSY_COMPOSER_PHASES.includes(phase)
}

/** The official component's own lock marker on the composer node:
 *  aria-disabled (editorDisabled = removed || (locked && !workspaceTrigger)).
 *  It sees what the phase cannot: a block (removed/offline/no session) is
 *  locked INDEPENDENTLY of machineBusy, so it renders non-editable during a
 *  submission too and must never be force-unlocked. Pure — unit-tested. */
export function isOfficiallyDisabled(input: { getAttribute(name: string): string | null }): boolean {
  return input.getAttribute('aria-disabled') === 'true'
}

/**
 * The self-heal clock: 0 unless the composer is non-editable, inside a
 * submission window, AND not officially disabled; otherwise the time that
 * state was FIRST seen. All three halves are load-bearing: the PHASE gate
 * scopes recovery to a stuck SUBMIT; the DISABLED gate covers a block that
 * arrives during a submission (force-unlocking it would fight a live official
 * block and produce a half-editable DOM); seeding from the DOM covers the
 * composer that MOUNTS stuck, where no mutation record exists. Pure.
 */
export function lockClock(
  editable: boolean,
  busy: boolean,
  disabled: boolean,
  since: number,
  now: number,
): number {
  if (editable || !busy || disabled) return 0
  return since === 0 ? now : since
}

/** The recovery decision, re-evaluated against the LIVE state before any DOM
 *  write. Pure — unit-tested. */
export function shouldRecoverStuckComposer(facts: {
  readonly editable: boolean
  readonly busy: boolean
  readonly disabled: boolean
  readonly elapsedMs: number
}): boolean {
  return !facts.editable && facts.busy && !facts.disabled && facts.elapsedMs >= BUSY_STUCK_MS
}

/** MutationObserver options for the self-heal channel: editability + phase +
 *  the official disabled marker together. */
export const SELF_HEAL_MUTATION_OPTIONS: MutationObserverInit = {
  attributes: true,
  attributeFilter: ['contenteditable', 'data-phase', 'aria-disabled'],
  subtree: true,
}

export function installComposerSelfHeal(root: ParentNode = document): () => void {
  let current: HTMLElement | null = null
  let lockedSince = 0
  const query = (): HTMLElement | null => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    return input instanceof HTMLElement ? input : null
  }
  const sync = (input: HTMLElement | null, now = Date.now()): void => {
    if (input === null) {
      current = null
      lockedSince = 0
      return
    }
    // A fresh element restarts the clock: what happened before it appeared is
    // not observable.
    if (input !== current) {
      current = input
      lockedSince = 0
    }
    lockedSince = lockClock(
      input.contentEditable === 'true',
      isComposerSubmitBusy(input.dataset.phase),
      isOfficiallyDisabled(input),
      lockedSince,
      now,
    )
  }
  // Install-time seed + attribute channel (editability, phase AND disabled).
  sync(query())
  const observer = new MutationObserver(() => sync(query()))
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') return
    const input = query()
    if (input === null || !input.contains(event.target as Node)) return
    // A composer that mounted stuck has no mutation to start its clock: the
    // tap that finds it stuck starts it.
    sync(input)
    if (lockedSince === 0) return
    // Re-evaluate against the live state: only a still-stuck submit recovers.
    const recover = shouldRecoverStuckComposer({
      editable: input.contentEditable === 'true',
      busy: isComposerSubmitBusy(input.dataset.phase),
      disabled: isOfficiallyDisabled(input),
      elapsedMs: Date.now() - lockedSince,
    })
    lockedSince = 0
    if (!recover) return
    input.blur()
    input.contentEditable = 'true'
    input.focus({ preventScroll: true })
  }
  observer.observe(root, SELF_HEAL_MUTATION_OPTIONS)
  document.addEventListener('pointerdown', onPointerDown, true)
  return () => {
    observer.disconnect()
    document.removeEventListener('pointerdown', onPointerDown, true)
  }
}
