/**
 * Composer behavior layer (design 17 §18.4.4): enter-to-newline and a
 * minimal editability recovery. Anchored on the empirical 0.1.5-alpha.2
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

/** The editability face the gate reads (real `Element` satisfies it). */
export interface EditableFace {
  readonly contentEditable?: string
}

/**
 * Is this the composer's EDITOR — `contenteditable="true"` — rather than the
 * resident node wearing the composer's attributes? The official InputBar keeps
 * ONE div for both states: with no workspace it binds `editor = null`, so
 * `contentEditable` renders false while the div still carries
 * `[data-composer-input]` and, while the workspace-trigger branch is active
 * (`workspaceTrigger = inert && !removed && onRequestWorkspace !== undefined`),
 * `tabIndex=0` plus the official React `onKeyDown`
 * that opens the workspace picker (`onWorkspaceKeyDown`, which accepts Enter or
 * Space). The mobile Enter
 * handler runs at document capture and stops propagation, so intercepting that
 * state swallowed the picker's own keyboard activation (Enter) while inserting
 * nothing — the editability gate keeps the interception on the real editor
 * only. Pure — unit-tested (2026-09-13 review-fix).
 */
export function isEditableComposer(input: EditableFace | null | undefined): boolean {
  return input !== null && input !== undefined && input.contentEditable === 'true'
}

/**
 * An open command/model menu with a highlighted option? The official
 * keymap's Enter arbitration picks the highlighted item — the mobile
 * enter-to-newline must NOT swallow that (P2-2). Only intercept when no
 * highlighted menu is open.
 *
 * The trigger menu is the only producer that matters: it keeps focus in the
 * composer and publishes its highlight through `aria-activedescendant` /
 * `role=option[aria-selected]`. The retired `[role="menu"]
 * [role="menuitem"][aria-selected]` arm could never match — the ui-primitives
 * Menu renders its items WITHOUT `aria-selected` (Menu.tsx) and moves focus
 * into the menu, so a menuitem's Enter never reaches this document handler at
 * all (2026-09-13 review-fix).
 */
function hasHighlightedMenuOpen(): boolean {
  const highlighted = document.querySelector(
    '[data-trigger-menu] [aria-activedescendant], [data-trigger-menu] [role="option"][aria-selected="true"]',
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
 *
 * Scope: only the composer's EDITOR (`contenteditable="true"`) is
 * intercepted. The same div doubles as the no-workspace picker trigger while
 * it renders non-editable, and that state owns Enter through the official
 * React handler — stopping the event there broke the picker instead of
 * inserting a line (see isEditableComposer).
 */
export function installEnterToNewline(): () => void {
  const composing = createComposingGuard()
  const detachComposing = composing.attach()
  let warnedOnce = false
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
    if (event.repeat) return
    // The official ACCELERATED chord is Ctrl/Cmd+Enter — the keymap calls
    // `submit(event.ctrlKey || event.metaKey)` and the submission policy flips
    // queue↔steer on it (input/editor/keymap.ts, input/submission-policy.ts).
    // A newline is not what that gesture means, so it passes through
    // untouched; the chord only exists with a hardware keyboard, which on
    // iOS means an iPad with one attached.
    if (event.ctrlKey || event.metaKey) return
    if (composing.isComposingNow()) return
    const input = event.target instanceof Element ? event.target.closest(COMPOSER_INPUT_SELECTOR) : null
    // Editability gate: the no-workspace picker state wears the same attribute
    // with `contenteditable="false"` and owns Enter itself (see
    // isEditableComposer). Interception without an editor inserts nothing and
    // would swallow that activation.
    if (!(input instanceof HTMLElement) || !isEditableComposer(input)) return
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

/** Did an editability mutation flip the composer from non-editable to
 *  editable, while it holds focus? `recordOldValues` carries the observed
 *  attribute before-images (`attributeOldValue`), the tracked-state pair the
 *  in-memory fallback.
 *
 *  CALLER CONTRACT (2026-09 measured/review fix): pass the before-images of
 *  records whose TARGET is the composer element itself. Passing every
 *  `contenteditable` record of the batch makes any nested Lexical decorator
 *  that flips its own attribute blur+refocus the composer MID-TYPING (the
 *  observer watches the whole document subtree). Pure — unit-tested. */
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
 * Minimal editability recovery (IME ladder layer 2): when the composer
 * flips back to editable while still focused, the IME may stay closed (a
 * focus event is not re-fired by the official component). Blur + refocus on
 * the flip restores the keyboard. Anchored on the official
 * `contenteditable` attribute (the ONE writer of editability).
 *
 * The flip is read from the mutation's `oldValue` plus a state seeded FROM
 * THE DOM: React writes `contenteditable` on the detached element, so a
 * composer that mounts non-editable produces no record at all — the earlier
 * `lastEditable = true` guess then read the first genuine flip as "no
 * change" and skipped the recovery (2026-09-13 review-fix).
 */
/** MutationObserver options for the editability-recovery channel, exported so
 *  a test can pin the load-bearing option: WITHOUT `attributeOldValue` the
 *  `false -> true` flip is invisible for any composer the observer never saw
 *  mount, and the layer silently does nothing (2026-09-13 review-fix). */
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
  // Seed from what is on screen, never from an assumption: the composer may
  // already be mounted (and locked) when this installer runs.
  seed(query())
  const observer = new MutationObserver(records => {
    const input = query()
    if (input === null) {
      seed(null)
      return
    }
    const editable = input.contentEditable === 'true'
    // A FRESH element (session switch, keyed remount) re-seeds instead of
    // reporting a flip: its previous state was never observed.
    const previous = input === current ? lastEditable : editable
    if (isEditabilityFlipToEditable(
      editable,
      input === document.activeElement,
      previous,
      // Only the composer's OWN attribute flip may recover the keyboard: a
      // nested decorator's flip used to blur+refocus the composer mid-typing.
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
 * (composer visibility guard) lives in the stylesheet
 * (interactive-widget=resizes-content where the engine honors it) +
 * installComposerVisibilityGuard below (the measured-overlap fallback).
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
 * Composer visibility guard (IME ladder layer 5, measured revision).
 *
 * THE MEASURED DEFECT the earlier form carried (Chrome 152 rig with the real
 * upstream CSS + this bundle, 390x844, keyboard top at 508): the installer
 * inferred the keyboard from `window.innerHeight` vs the visual viewport and
 * wrote the lift BOTH as the seat's sticky `bottom` AND as a scrollport
 * `padding-bottom`. The scrollport is the sticky containing block, so its own
 * padding moved the sticky threshold up by the same amount and the seat was
 * lifted TWICE: measured seat [40..140] where [392..492] was intended — the
 * composer flew 368px above the keyboard. And because the arm decision was a
 * heuristic fed by events engines do not guarantee, a missing/late
 * visualViewport event left the composer BEHIND the keyboard (measured
 * `kbd=false, covered=+336` with the keyboard open).
 *
 * THE MEASURED FORM: do not infer the keyboard — measure the overlap.
 * `covered = scrollport.getBoundingClientRect().bottom - (vv.offsetTop +
 * vv.height)`, both in layout coordinates at any pan/zoom, and the scrollport's
 * border box is flex-sized (ui-layout/conversation CSS: `height:100%` +
 * `flex:1; min-height:0`), so it is an ACTUATOR INVARIANT: our own padding /
 * scrollTop / seat-inset writes cannot move it and the loop has a fixed point
 * instead of oscillating. One actuator only — the seat's sticky `bottom`
 * (styles.ts); the scroll range the tail needs comes from an in-flow spacer
 * inserted just before the seat, which does NOT shrink the sticky containing
 * block (this is why the scrollport padding arm is gone).
 *
 * Guards: hysteresis (arm at >= KBD_ARM_PX, release below KBD_DISARM_PX) keeps
 * browser-chrome overlap from micro-lifting the seat; typing intent (editable
 * focus / composer selection / grace window) keeps the guard off fields that
 * are not the composer. Triggers: visualViewport resize/scroll, window resize,
 * focusin/focusout, visibilitychange, a `[data-phase]` observer (the sticky
 * seat only exists in the active phase) and a BOUNDED poll while an editable is
 * focused, so an engine that delivers no viewport event still converges.
 * Every outcome is written to the frame as `data-mobile-kbd` (applied px) and
 * `data-mobile-kbd-state` (armed | idle | no-seat | no-frame | still-covered)
 * — the guard can no longer fail silently.
 *
 * Verdicts are bounded: after writing the offset the guard re-measures at
 * most KBD_MAX_VERIFY_STEPS times (KBD_VERIFY_SLACK_PX tolerance) and then
 * reports `still-covered` instead of ramping up forever if an engine ignores
 * the sticky inset. The official chat already re-glues the OUTER scroll on
 * seat resize (ui-chat's ResizeObserver follows `[data-composer-seat]`), so
 * this installer owns only the keyboard-driven geometry change.
 *
 * Why the measurement replaced the inference: the old arm signal
 * (`innerHeight` vs the visual viewport = "keyboard open") is a guess about a
 * field the plugin does not own, and it needed extra guards against its own
 * false positives — a pinch/FOCUS zoom shrinks the visual viewport with no
 * keyboard (the plugin deliberately keeps user-scalable for WCAG 1.4.4), and a
 * keyboard can belong to a field that is not the composer (settings sheet,
 * question cards). The measured overlap needs no keyboard inference at all:
 * "the conversation's bottom edge is below the visible bottom" is exactly the
 * property the guard must fix, whatever caused it, and it is only actionable
 * while the composer is the focused field — so the TYPE-GATED intent check
 * stays (editable focus / composer selection / grace window, plus
 * composer-only under zoom), and the keyboard heuristic is gone from this
 * path.
 *
 * Zoom policy (cross-check P1): a blanket scale veto is WRONG — iOS
 * focus-zooms on the drawer's 13px search field (ui-workspace:1187) and the
 * page stays zoomed, so vetoing every zoomed state would leave the composer
 * behind the keyboard for the rest of the session. With the measured overlap
 * the zoom case needs no special branch: the pan/zoom is already inside
 * `vv.offsetTop + vv.height`, so the value is exactly how far the scrollport's
 * bottom edge exceeds the visible bottom (measured: 2x zoom → 400px lift,
 * 18px dead band). Non-composer fields keep the veto — panning a zoomed page
 * must not drive the offset. The focus-zoom trigger itself is also removed at
 * the source (styles.ts gives the drawer's fields the same 16px floor as the
 * composer/dialogs).
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
export const MOBILE_KBD_VAR = '--chamber-mobile-kbd-offset'
/** Recently-focused-editable grace window: a blur (or an editability flip
 *  during submit) must keep the compensation armed through the
 *  keyboard-close animation and the editability-recovery refocus instead of
 *  dropping the seat mid-transition. */
export const KBD_EDITABLE_FOCUS_GRACE_MS = 1_200
/** Arm threshold: the overlap must be clearly keyboard-scale before the guard
 *  lifts the composer. Chrome/Firefox bottom-bar overlap sits well below this,
 *  so browser chrome alone never micro-lifts the seat (measured: a 60px
 *  overlap stays idle). */
export const KBD_ARM_PX = 96
/** Release threshold, below the arm threshold on purpose (hysteresis): once
 *  armed the lift is held until the overlap is effectively gone, so a
 *  sliding keyboard (or a 1-2px wobble) cannot flap the seat. */
export const KBD_DISARM_PX = 72
/** Post-write acceptance tolerance: how far the seat's bottom may still sit
 *  below the visible bottom before the guard keeps correcting. */
export const KBD_VERIFY_SLACK_PX = 24
/** Bounded post-write corrections per sync (never an unbounded ramp: an engine
 *  that ignores the sticky inset must be REPORTED, not chased). */
export const KBD_MAX_VERIFY_STEPS = 2
/** Bounded poll cadence/budget while an editable holds focus. Engines that
 *  deliver no visualViewport event on keyboard open (Android WebView) are
 *  covered by this, and it stops as soon as focus leaves. */
export const KBD_POLL_MS = 250
export const KBD_POLL_BUDGET_MS = 4_000
/** Diagnosis surface (plugin-owned attribute, never an official one). */
export const MOBILE_KBD_STATE_ATTR = 'data-mobile-kbd-state'
/** The in-flow spacer that supplies the scroll range above the raised seat
 *  (replaces the scrollport padding arm, see the section doc). */
export const MOBILE_KBD_SPACER_ATTR = 'data-mobile-kbd-spacer'
/** The active conversation's sticky composer seat (phase guard: hero/blank
 *  seats are not sticky — only an active session has the bottom-pinned
 *  seat the keyboard can cover). */
const ACTIVE_SEAT_SELECTOR = '[data-phase="active"] [data-composer-seat]'

/** Hysteresis + quantization for the visibility guard: arm only when the
 *  measured overlap is keyboard-scale, hold while armed until it is
 *  effectively gone, then quantize (ceil + headroom) so the seat never lands
 *  under the keyboard top. Pure — unit-tested. */
export function kbdLiftTarget(
  covered: number,
  armed: boolean,
  armThreshold: number = KBD_ARM_PX,
  disarmThreshold: number = KBD_DISARM_PX,
): number {
  if (covered <= (armed ? disarmThreshold : armThreshold)) return 0
  return nextKbdOffset(covered)
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

export function installComposerVisibilityGuard(root: ParentNode = document): () => void {
  let applied = 0
  /** The frame currently carrying the offset (teardown handle: the frame
   *  persists across seat remounts, so disarm must target the element that
   *  actually carries the attribute). */
  let armedFrame: HTMLElement | null = null
  /** The in-flow spacer that gives the conversation its scroll range above
   *  the raised seat (the scrollport padding arm was removed: it shrank the
   *  sticky containing block and double-lifted the seat — see the section
   *  doc). */
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

  /** The diagnosis surface is torn down with the actuator: a disposed guard
   *  (or one that has just gone idle) must not leave `data-mobile-kbd-state`
   *  behind, on the frame OR on <html> — the acceptance walkthrough reads
   *  both, and a stale 'armed' after dispose reported a live offset that no
   *  longer existed. */
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

  /** Is the field the COMPOSER's? Only this case is served: a keyboard that
   *  belongs to the settings sheet or a question card must not move the seat
   *  (and panning a zoomed page must not drive the offset). */
  const composerFocused = (): boolean => {
    const active = document.activeElement
    if (active instanceof Element
      && (active.closest(COMPOSER_INPUT_SELECTOR) !== null || active.closest('[data-composer-seat]') !== null)) {
      return true
    }
    return isComposerSelection()
  }

  /** The active conversation's sticky seat. Only an ACTIVE session has the
   *  bottom-pinned seat the keyboard can cover (hero/blank seats are not
   *  sticky, and `settling` hides this one). Single-shell deployment: one
   *  seat — but the phase attribute is NOT unique: a second, hidden
   *  `[data-phase="active"]` root earlier in DOM order used to win the
   *  first-match query and the guard served a seat whose scrollport is
   *  zero-sized while the real seat stayed covered. A candidate is only
   *  committed when its scrollport is actually laid out. */
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
   *  below the visible bottom edge, in layout coordinates. The scrollport's
   *  border box is flex-sized (never content- or padding-driven), so this
   *  value is invariant under the guard's own writes — the loop has a fixed
   *  point instead of oscillating. `null` when the scrollport is absent. */
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

  /** Grow the flow above the seat by the lift, without touching the
   *  scrollport's own box (a scrollport padding would shrink the sticky
   *  containing block — the measured double-lift defect). */
  const ensureSpacer = (seat: Element, height: number): void => {
    if (spacer === null || !spacer.isConnected) {
      spacer = document.createElement('div')
      spacer.setAttribute(MOBILE_KBD_SPACER_ATTR, '')
      spacer.style.cssText = 'flex:none;pointer-events:none'
      seat.parentElement?.insertBefore(spacer, seat)
    } else if (spacer.nextElementSibling !== seat) {
      // The renderer rebuilds the seat list on remount: keep the spacer
      // immediately before the seat instead of leaving it orphaned between
      // other children (the offset would otherwise space the wrong gap).
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
    // element keeps its plugin-owned attribute/custom property forever
    // otherwise (a renderer remount replaces the AppFrame while the keyboard
    // stays open).
    if (armedFrame !== null && armedFrame !== frame) disarm()
    const scroller = seat.closest('[data-conversation-scroll]')
    const wasAtEnd = scroller instanceof HTMLElement
      && isAtScrollEnd(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight)
    /** ONE writer for the whole actuator: the frame attribute (which activates
     *  the stylesheet arm), the custom property and the spacer height are
     *  never allowed to disagree — the attribute used to be stamped from the
     *  pre-verify target while the property/spacer ended higher (measured:
     *  attr=352 / var=1056 / spacer=1056 with an engine that ignores the
     *  inset). */
    const applyLift = (value: number): void => {
      frame.setAttribute(MOBILE_KBD_ATTR, String(value))
      frame.style.setProperty(MOBILE_KBD_VAR, `${value}px`)
      ensureSpacer(seat, value)
      applied = value
    }
    armedFrame = frame
    let lift = target
    applyLift(lift)
    // Was the conversation pinned to its end before this step? If yes, keep
    // the message tail glued above the raised seat: the spacer grows the
    // scroll range below the content, so the pinned scrollport must follow.
    if (wasAtEnd && scroller instanceof HTMLElement) scroller.scrollTop += lift
    // BOUNDED verification: an engine that ignores the sticky inset, or a
    // geometry that landed short, is corrected at most
    // KBD_MAX_VERIFY_STEPS times and then REPORTED — never chased. The
    // residual is measured AFTER the lift was applied, so it is a fresh TOTAL
    // requirement: subtracting the already-applied lift turns it into the
    // missing delta. A residual the applied lift already covers therefore
    // adds nothing — an engine that ignores the sticky inset can never
    // compound the spacer past the lift the measured overlap called for
    // (measured 3x overshoot before this).
    let steps = 0
    while (steps < KBD_MAX_VERIFY_STEPS) {
      const residual = seat.getBoundingClientRect().bottom - visibleBottom()
      if (residual <= KBD_VERIFY_SLACK_PX) break
      const extra = nextKbdOffset(residual) - lift
      if (extra <= 0) break
      lift += extra
      applyLift(lift)
      if (wasAtEnd && scroller instanceof HTMLElement) scroller.scrollTop += extra
      steps += 1
    }
    // FINAL-lift write: after the loop the attribute carries the same value as
    // the custom property and the spacer.
    applyLift(lift)
    const residual = seat.getBoundingClientRect().bottom - visibleBottom()
    setState(residual > KBD_VERIFY_SLACK_PX ? 'still-covered' : 'armed')
  }

  /** Bounded poll while an editable holds focus: engines that deliver NO
   *  visualViewport event on keyboard open (Android WebView) still converge,
   *  and the poll stops on budget expiry or when focus leaves the editable.
   *
   *  The budget is PER FOCUS ARM, never per event: the deadline is stamped
   *  once when the interval is created and a running interval is never
   *  extended. Document-wide pointerdown/focusin churn used to reset
   *  `pollUntil` before the early return, so 4Hz synthetic taps kept the
   *  interval alive across the whole 4s window and beyond (measured: it never
   *  cleared over 6.5s) — the convergence aid became a permanent 250ms sync
   *  loop. Re-arming is refused while the timer runs; a pointerdown only
   *  re-syncs once and focusin starts the next genuine focus episode. */
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
    // A seat remount (session switch / reconnect settle) re-arms here even
    // when no visualViewport event follows.
    startPoll()
    sync()
  }
  const onFocusOut = (event: FocusEvent): void => {
    // Stamp the grace window at the MOMENT of the blur — the editor flipping
    // `contenteditable` off during submit, a keepFocus-less control taking
    // focus and the keyboard-close animation all start here, not at the last
    // focusin (cross-check D2).
    if (isEditableFocus(event.target)) lastEditableFocusAt = Date.now()
  }
  const onPointerDown = (): void => {
    // A tap can raise the keyboard with no viewport event: re-sync ONCE. The
    // poll budget belongs to the focus episode (onFocusIn) — a pointerdown
    // must never re-arm or extend it.
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
 * Composer self-heal (design 17 §18.4.4, P1.5): if the composer stays
 * non-editable INSIDE A SUBMISSION WINDOW for BUSY_STUCK_MS while the user
 * actively taps it, force a recovery (blur → restore contenteditable →
 * refocus). The official component is the writer of editability, so this only
 * fires on a genuine stuck submit; a failed recovery leaves the DOM untouched.
 */
export const BUSY_STUCK_MS = 30_000

/** The composer's own phase values that mean a submission is IN FLIGHT — the
 *  official input machine's `adjudicating` / `submitting` (`input/machine.ts`,
 *  the same pair `machineBusy` is built from), published by the composer node
 *  as `data-phase` (its other values are `inert`, `plain` and `claimed`). */
export const BUSY_COMPOSER_PHASES: readonly string[] = ['adjudicating', 'submitting']

/** Is the composer inside a submission window? Pure — unit-tested. */
export function isComposerSubmitBusy(phase: string | null | undefined): boolean {
  return phase !== null && phase !== undefined && BUSY_COMPOSER_PHASES.includes(phase)
}

/** The official component's own lock marker on the composer node:
 *  `aria-disabled={editorDisabled || undefined}` where
 *  `editorDisabled = removed || (locked && !workspaceTrigger)`. It is the
 *  discriminator the phase cannot see — a block (`blocked`, `parentOffline`,
 *  `removed`, no session) is `locked` INDEPENDENTLY of `machineBusy`, so it
 *  renders non-editable *during* a submission too, and must never be
 *  force-unlocked. Pure over the element face — unit-tested. */
export function isOfficiallyDisabled(input: { getAttribute(name: string): string | null }): boolean {
  return input.getAttribute('aria-disabled') === 'true'
}

/**
 * The self-heal clock: 0 unless the composer is non-editable, inside a
 * submission window, AND not officially disabled; otherwise the time that
 * state was FIRST seen.
 *
 * All three halves are load-bearing:
 *  - the PHASE gate scopes the recovery to a stuck SUBMIT (what it exists for);
 *  - the DISABLED gate covers the overlap the phase alone cannot see: upstream
 *    keeps `locked = removed || inert || !live || blocked || parentOffline`
 *    INDEPENDENT of `machineBusy`, so an owner block or an offline parent that
 *    arrives during a submission renders non-editable + busy — and a
 *    force-unlock there would fight a live official block (Lexical's own
 *    `setEditable(false)` gate stays closed, so it produces a half-editable
 *    DOM). `aria-disabled` is the official component's own expression of that
 *    lock (`editorDisabled = removed || (locked && !workspaceTrigger)`);
 *  - seeding from the DOM rather than from a mutation covers the composer that
 *    MOUNTS stuck (React writes `contenteditable` before insertion, so no
 *    record exists).
 * Pure — unit-tested.
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
 *  write: the composer must still be non-editable, still inside a submission
 *  window, still not officially disabled, and the clock must have run for the
 *  full window. Pure — unit-tested (the installer used to inline this). */
export function shouldRecoverStuckComposer(facts: {
  readonly editable: boolean
  readonly busy: boolean
  readonly disabled: boolean
  readonly elapsedMs: number
}): boolean {
  return !facts.editable && facts.busy && !facts.disabled && facts.elapsedMs >= BUSY_STUCK_MS
}

/** MutationObserver options for the self-heal channel, exported so a test can
 *  pin all three load-bearing attributes: a stuck submit is editability +
 *  phase + the official disabled marker together, and dropping any one of them
 *  either misses the state or fires against a legitimate lock. */
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
    // A fresh element restarts the clock from its own state: what happened
    // before it appeared is not observable.
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
  // Install-time seed + attribute channel (editability, phase AND the official
  // disabled marker: a stuck submit is the three of them together).
  sync(query())
  const observer = new MutationObserver(() => sync(query()))
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') return
    const input = query()
    if (input === null || !input.contains(event.target as Node)) return
    // A composer that mounted stuck has no mutation to start its clock: the
    // tap that finds it stuck starts it, so the NEXT tap past the window
    // recovers instead of never.
    sync(input)
    if (lockedSince === 0) return
    // Re-evaluate against the live state: only a state that is still a stuck
    // submit may be recovered (2026-09-13 review-fix).
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
