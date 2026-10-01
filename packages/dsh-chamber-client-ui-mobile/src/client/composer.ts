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

/**
 * Double-install guard for the document-level behavior installers. The tier
 * effect can re-enter on a fast tier flip, and a duplicate install registers a
 * SECOND listener: two Enter intercepts (two newlines), two spacers, two heal
 * timers. The module-level key set holds one seat per key: while a key is live
 * a second install() is a no-op returning a no-op disposer, and only after the
 * original disposer ran can the key be installed again.
 */
const ACTIVE_INSTALLS = new Set<string>()

/** The install keys (ONE seat per key; drawer-taps/settings-sheet import this
 *  table so the keys stay unique across modules). */
export const INSTALL_KEYS = {
  enterToNewline: 'mobile.composer.enter-to-newline',
  editabilityRecovery: 'mobile.composer.editability-recovery',
  imeLadder: 'mobile.composer.ime-ladder',
  composerVisibilityGuard: 'mobile.composer.visibility-guard',
  composerSelfHeal: 'mobile.composer.self-heal',
  drawerTapHeal: 'mobile.drawer.tap-heal',
  settingsSheetScrollReset: 'mobile.settings.sheet-scroll-reset',
} as const

export function installOnce(key: string, install: () => () => void): () => void {
  if (ACTIVE_INSTALLS.has(key)) return () => {}
  // The key is claimed only AFTER the install returned: a throwing installer
  // must not poison the seat for every later attempt.
  const release = install()
  ACTIVE_INSTALLS.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    ACTIVE_INSTALLS.delete(key)
    release()
  }
}

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
 * Composition state for the Enter gate. TWO arms:
 *   - the LIVE flag (compositionstart -> true, compositionend -> false): an
 *     engine whose final keydown already reports isComposing=false while the
 *     composition session is still open must not be intercepted;
 *   - the Safari trailing window: the official keymap keeps a 10ms
 *     recentlyComposing window after compositionend, because Safari's final
 *     keydown of a composed input carries neither isComposing nor keyCode 229.
 */
function createComposingGuard(): { isComposingNow(): boolean; attach(): () => void } {
  let composing = false
  let lastCompositionEnd = 0
  const onStart = (): void => { composing = true; lastCompositionEnd = 0 }
  const onEnd = (): void => { composing = false; lastCompositionEnd = Date.now() }
  return {
    isComposingNow: () => composing || Date.now() - lastCompositionEnd < 10,
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
 * intercepted (isComposing OR keyCode 229 OR the live composition flag, plus
 * the Safari trailing window), and neither is an Alt/AltGr chord.
 *
 * Lexical 0.49 gotcha: its root keydown listener does NOT check
 * defaultPrevented and KEY_ENTER_COMMAND (CRITICAL) fires submit regardless —
 * preventDefault alone still SENDS, so the capture-phase handler must
 * stopPropagation. Scope: only the composer's EDITOR; the same div doubles as
 * the no-workspace picker trigger while non-editable and owns Enter there via
 * the official React handler (see isEditableComposer).
 */
function installEnterToNewlineInner(): () => void {
  const composing = createComposingGuard()
  const detachComposing = composing.attach()
  let warnedOnce = false
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return
    if (event.repeat) return
    // The official accelerated submit chord (Ctrl/Cmd+Enter, queue↔steer) is
    // not a newline gesture — pass it through untouched. AltGr (reported as
    // Alt, as Ctrl+Alt, or through the AltGraph modifier state) types a
    // character: that Enter belongs to the composition path, not to us.
    if (event.ctrlKey || event.metaKey || event.getModifierState?.('AltGraph') === true) return
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
    // back to insertText('\n'). An execCommand boolean only claims
    // "supported", never that the edit happened, so the FINGERPRINT gates
    // every escalation: insertText runs only while the document is still
    // unchanged after insertLineBreak (a lying `false` that actually inserted
    // must never be doubled), and the manual fallback only when the text
    // command left the document unchanged too — even when it claimed success.
    const fingerprint = composerFingerprint(input)
    const lineBreakOk = document.execCommand('insertLineBreak')
    if (!lineBreakOk && fingerprint === composerFingerprint(input)) {
      document.execCommand('insertText', false, '\n')
    }
    if (!lineBreakOk && fingerprint === composerFingerprint(input) && !insertLineBreakManually(input)) {
      // The event stays consumed (falling back to Enter=send would SEND);
      // surface the failure once per session, never per keystroke.
      if (!warnedOnce) {
        warnedOnce = true
        console.warn('[dsh-chamber.mobile] composer line-break insertion failed (execCommand + DOM fallback)')
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

/** Single-seat entry point: a duplicate install while the first is live is a
 *  no-op — two handlers would insert TWO newlines for one Enter. */
export function installEnterToNewline(): () => void {
  return installOnce(INSTALL_KEYS.enterToNewline, installEnterToNewlineInner)
}

/** Cheap composer fingerprint (text + node count): did the execCommand
 *  ladder actually write the document? Its booleans only claim "supported". */
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

/** The self-heal recovery write (blur -> contenteditable=true -> focus) is a
 *  genuine false->true flip by every observable definition, so the
 *  editability recovery channel would answer it with a SECOND blur/refocus on
 *  the same element — the double focus dance that strands the IME. The writer
 *  marks the element; the reader CONSUMES the mark on the flip record that
 *  follows. The window only has to survive the observer microtask of the same
 *  task, and one-shot consumption keeps a LATER genuine flip recoverable. */
const SELF_HEAL_WRITE_MARKER_MS = 1_000

let selfHealWrite: { readonly element: HTMLElement; readonly at: number } | null = null

/** Consume the self-heal writer's mark for this element, when still live. */
function consumeSelfHealWrite(element: HTMLElement, now: number): boolean {
  if (selfHealWrite === null || selfHealWrite.element !== element) return false
  if (now - selfHealWrite.at > SELF_HEAL_WRITE_MARKER_MS) return false
  selfHealWrite = null
  return true
}

function installEditabilityRecoveryInner(root: ParentNode): () => void {
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
      // The self-heal channel's own write is self-identified: it must not be
      // answered with a second blur/refocus (the double focus dance).
      if (!consumeSelfHealWrite(input, Date.now())) {
        input.blur()
        input.focus({ preventScroll: true })
      }
    }
    seed(input)
  })
  observer.observe(root, EDITABILITY_MUTATION_OPTIONS)
  return () => observer.disconnect()
}

/** Single-seat entry point (installed by index.ts once per touch-tier entry). */
export function installEditabilityRecovery(root: ParentNode = document): () => void {
  return installOnce(INSTALL_KEYS.editabilityRecovery, () => installEditabilityRecoveryInner(root))
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
 *   1. programmatic-focus drop loop — a focus that follows a NAVIGATION
 *      gesture is blurred and re-dropped for up to 12 rAF frames (the
 *      official submit effect re-focuses programmatically, leaving the IME
 *      closed on Android WebView). The classification is persistent (the last
 *      pointerdown stands until the next one) but the drop has an EXECUTABLE
 *      WINDOW (IME_NAV_DROP_WINDOW_MS): only a refocus that lands while the
 *      navigation intent is still fresh is dropped, so a late official refocus
 *      (or a stale classification from an old tap) never pops the keyboard
 *      away from the user. Keyboard navigation (Tab/Arrow) keeps its own short
 *      window and preserves.
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
export const NAV_QUERY = '[data-mobile-role="sidebar"], [data-slot="conversation.session.header"]'

/** The minimal element face the navigation-gesture predicate needs. */
export interface ClosestLike {
  closest(selector: string): ClosestLike | null
}

/** Pure decision: did this pointer gesture start in a navigation region?
 *  Kept exported as the semantic name for drawer/session-header gestures. */
export function isNavigationGestureTarget(target: ClosestLike | null): boolean {
  return target !== null && target.closest(NAV_QUERY) !== null
}

/** The persistent classification of one pointerdown: 'nav' = the gesture
 *  landed in a navigation region; 'preserve' = anything else (the composer
 *  seat, portaled menus, the message area). The value is replaced only by the
 *  NEXT pointerdown; the drop DECISION additionally reads its age (see
 *  IME_NAV_DROP_WINDOW_MS). */
export type ImeGesture = 'nav' | 'preserve'

/** Pure: classify one pointerdown target. */
export function classifyImeGesture(target: ClosestLike | null): ImeGesture {
  return isNavigationGestureTarget(target) ? 'nav' : 'preserve'
}

/** Keyboard-navigation intent window: a Tab/Arrow keydown this close to a
 *  focusin marks that focus as keyboard navigation, never as a programmatic
 *  refocus. */
export const IME_KEYBOARD_INTENT_MS = 500

/** How long a NAVIGATION gesture may still authorize a drop. The official
 *  submit/commit effect re-focuses within the same gesture, so a focus that
 *  arrives later is NOT the refocus this layer exists for — dropping it would
 *  steal a deliberate focus (after a long read, or from an unrelated control).
 *  45s outlasts any plausible submit round-trip and stays far inside the
 *  session-switch interaction, while a stale classification can no longer
 *  blur the composer minutes later. */
export const IME_NAV_DROP_WINDOW_MS = 45_000

/** Pure: should the drop loop run for this focusin? Only a NAVIGATION gesture
 *  still inside IME_NAV_DROP_WINDOW_MS drops; a fresh Tab/Arrow keyboard intent
 *  and every seat/portal gesture (typing intent) preserve. */
export function shouldDropImeRefocus(
  gesture: ImeGesture,
  gestureAt: number,
  keyboardIntentAt: number,
  now: number,
): boolean {
  if (now - keyboardIntentAt < IME_KEYBOARD_INTENT_MS) return false
  if (gesture !== 'nav') return false
  const age = now - gestureAt
  return age >= 0 && age <= IME_NAV_DROP_WINDOW_MS
}

export interface ImeLadder {
  /** Install the ladder. Single-seat (installOnce): a second attach while the
   *  first is live returns a no-op disposer; the returned disposer detaches
   *  every listener AND cancels an in-flight drop loop. */
  attach(): () => void
}

export function installImeLadder(root: ParentNode = document): ImeLadder {
  /** The persistent classification of the LAST pointerdown AND when it
   *  happened: the drop decision expires it after IME_NAV_DROP_WINDOW_MS. */
  let lastGesture: ImeGesture = 'preserve'
  let lastGestureAt = 0
  /** The last Tab/Arrow keydown: a focusin inside IME_KEYBOARD_INTENT_MS of it
   *  is keyboard navigation and must be preserved. */
  let keyboardIntentAt = 0
  let keyboardOpen = false
  /** The in-flight drop loop: its pending rAF id, its cancel-listener removal
   *  and the cancellation flag the disposer sets. At most ONE loop runs. */
  let dropFrame = 0
  let dropCleanup: (() => void) | null = null
  let dropCancelled = false

  const syncKeyboard = (): void => {
    const vv = window.visualViewport
    keyboardOpen = vv !== null && isKeyboardOpen(window.innerHeight, vv.height)
  }

  /** Stop the drop loop: cancel the pending frame and drop its cancel
   *  listener. Idempotent. */
  const stopDropLoop = (): void => {
    if (dropFrame !== 0) {
      cancelAnimationFrame(dropFrame)
      dropFrame = 0
    }
    dropCleanup?.()
    dropCleanup = null
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
    // a hardware-mouse click into the composer is still typing intent. BOTH
    // halves — kind and time — are replaced by every pointerdown.
    lastGesture = classifyImeGesture(event.target instanceof Element ? event.target : null)
    lastGestureAt = Date.now()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    // Tab and the arrow keys move focus: the focus they cause (or that the
    // commit effect restores) is keyboard navigation, not a programmatic
    // refocus.
    if (event.key === 'Tab' || event.key.startsWith('Arrow')) keyboardIntentAt = Date.now()
  }

  const onFocusIn = (event: FocusEvent): void => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof HTMLElement)) return
    if (event.target !== input && !input.contains(event.target as Node)) return
    // Layer 1: only a NAVIGATION gesture still inside its executable window
    // drops the focus (for 12 rAF frames; the official submit effect
    // re-focuses within the commit). A seat/portal gesture is typing intent
    // and a fresh Tab/Arrow keydown is keyboard navigation — both preserve. A
    // fresh seat pointerdown cancels a drop loop already in flight
    // (onGestureCancel below).
    if (!shouldDropImeRefocus(lastGesture, lastGestureAt, keyboardIntentAt, Date.now())) return
    // A new focusin (the official refocus itself re-enters here) REPLACES the
    // previous loop instead of stacking timers and listeners.
    dropCancelled = false
    stopDropLoop()
    let frames = 0
    const onGestureCancel = (event: PointerEvent): void => {
      // Only a NEW typing gesture cancels the drop loop — a neutral
      // message-area pointerdown must not interrupt a navigation drop.
      if (gestureInSeat(event)) dropCancelled = true
    }
    document.addEventListener('pointerdown', onGestureCancel, true)
    dropCleanup = () => document.removeEventListener('pointerdown', onGestureCancel, true)
    const drop = (): void => {
      dropFrame = 0
      frames += 1
      if (frames > 12 || dropCancelled) {
        stopDropLoop()
        return
      }
      if (input === document.activeElement && !keyboardOpen) {
        input.blur()
        dropFrame = requestAnimationFrame(drop)
      } else {
        stopDropLoop()
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
    attach: () => installOnce(INSTALL_KEYS.imeLadder, () => {
      syncKeyboard()
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('pointerup', onPointerUp, true)
      window.visualViewport?.addEventListener('resize', onViewportResize)
      window.visualViewport?.addEventListener('scroll', onViewportResize)
      return () => {
        // A pending drop frame must not fire after detach (it would blur a
        // composer nobody asked this layer to touch any more).
        dropCancelled = true
        stopDropLoop()
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('focusin', onFocusIn, true)
        document.removeEventListener('pointerup', onPointerUp, true)
        window.visualViewport?.removeEventListener('resize', onViewportResize)
        window.visualViewport?.removeEventListener('scroll', onViewportResize)
      }
    }),
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

function installComposerVisibilityGuardInner(root: ParentNode): () => void {
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

  /** Is this element inside the composer seat (the editor or its wrapper)? */
  const inComposerSeat = (node: Element): boolean =>
    node.closest(COMPOSER_INPUT_SELECTOR) !== null || node.closest('[data-composer-seat]') !== null

  /** The DOM selection is a composer proxy ONLY while focus is not owned
   *  elsewhere: a STALE selection inside the composer (the editor keeps its
   *  DOM selection while another field takes focus) must not move the seat
   *  while the settings sheet / a question card holds the keyboard. The
   *  fallback is therefore allowed only when nothing (body/null) or the seat
   *  itself owns focus. */
  const selectionFallbackAllowed = (): boolean => {
    const active = document.activeElement
    if (active === null || active === document.body) return true
    return active instanceof Element && inComposerSeat(active)
  }

  /** The keyboard's owner: an editable focused now, a caret still inside the
   *  composer (the editor flips contenteditable off during submit without
   *  blurring), or either within the grace window. */
  const editableFocused = (): boolean => {
    if (isEditableFocus(document.activeElement)) return true
    if (selectionFallbackAllowed() && isComposerSelection()) return true
    return Date.now() - lastEditableFocusAt < KBD_EDITABLE_FOCUS_GRACE_MS
  }

  /** Is the field the COMPOSER's? A keyboard belonging to the settings sheet
   *  or a question card must not move the seat — even when a stale composer
   *  selection survives that focus change (see selectionFallbackAllowed). */
  const composerFocused = (): boolean => {
    const active = document.activeElement
    if (active instanceof Element && inComposerSeat(active)) return true
    return selectionFallbackAllowed() && isComposerSelection()
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
   *  re-arm (no viewport/focus event follows it). [data-phase] is NOT unique
   *  AND renderer remounts REPLACE the node, so watching only the current
   *  first match left a replacement unobserved. Observe the root subtree
   *  instead (subtree + attributeFilter): every current AND future
   *  [data-phase] node reports, including one that mounts after install.
   *  Idempotent — the root never changes for one installer. */
  const phaseObserver = new MutationObserver(() => sync())
  let phaseObserved = false
  const observePhase = (): void => {
    if (phaseObserved) return
    phaseObserved = true
    phaseObserver.observe(root, { attributes: true, attributeFilter: ['data-phase'], subtree: true })
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

/** Single-seat entry point: a duplicate install would create a SECOND spacer
 *  before the seat and run a second 250ms poll. */
export function installComposerVisibilityGuard(root: ParentNode = document): () => void {
  return installOnce(INSTALL_KEYS.composerVisibilityGuard, () => installComposerVisibilityGuardInner(root))
}

/**
 * Composer self-heal: if the composer stays non-editable INSIDE A SUBMISSION
 * WINDOW for BUSY_STUCK_MS, force a recovery (blur → restore contenteditable →
 * refocus). The clock SEMANTICS: the first tap that finds the composer stuck
 * starts it (or the install-time seed, for a composer that mounted stuck);
 * a later tap ≥ BUSY_STUCK_MS after that sighting recovers; an EARLIER tap
 * never restarts the window — only a genuine recovery clears the clock. The
 * official component is editability's only writer, so this fires on a genuine
 * stuck submit; a failed recovery leaves the DOM untouched.
 *
 * REAL-DEVICE STATUS (STATUS 真机项, referenced by the F3 lane): this recovery
 * writes the DOM contenteditable ATTRIBUTE only. Lexical's own `editable`
 * editor state is NOT driven here (the plugin owns no editor handle — no
 * editor.setEditable()/editor.update()), so whether the DOM write actually
 * re-opens the Lexical input pipeline is UNVERIFIED on a real device. The DOM
 * attribute is the only interface this layer owns.
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

function installComposerSelfHealInner(root: ParentNode): () => void {
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
    // tap that finds it stuck starts it. The clock is NOT cleared here — an
    // early tap must not restart the 30s window (that made every tap a fresh
    // "mounted stuck" and the recovery unreachable).
    sync(input)
    if (lockedSince === 0) return
    // Re-evaluate against the live state: only a still-stuck submit recovers.
    const recover = shouldRecoverStuckComposer({
      editable: input.contentEditable === 'true',
      busy: isComposerSubmitBusy(input.dataset.phase),
      disabled: isOfficiallyDisabled(input),
      elapsedMs: Date.now() - lockedSince,
    })
    if (!recover) return
    // Only a genuine recovery clears the clock: the writes below recuse the
    // stuck state (and the mutation observer re-syncs it to 0 anyway).
    lockedSince = 0
    // Mark the write as OURS before the mutation is queued: the editability
    // recovery channel must not answer it with a second blur/refocus.
    selfHealWrite = { element: input, at: Date.now() }
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

/** Single-seat entry point (the recovery clock is module-visible state: a
 *  duplicate install would double-sync the same tick). */
export function installComposerSelfHeal(root: ParentNode = document): () => void {
  return installOnce(INSTALL_KEYS.composerSelfHeal, () => installComposerSelfHealInner(root))
}
