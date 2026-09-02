/**
 * Composer behavior layer (design 17 §18.4.4): enter-to-newline and a
 * minimal editability recovery. Anchored on the empirical 0.1.2-alpha.3
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
 * stray Enter tap fires a message. The mobile convention (community
 * consensus, design 17 §18.4.4): Enter inserts a line break, the explicit
 * send affordance is the send button. Composition (IME) input is never
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
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
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
    const ok = document.execCommand('insertLineBreak')
    if (!ok) document.execCommand('insertText', false, '\n')
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
    detachComposing()
  }
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
 *      which leaves the IME closed on Android WebView);
 *   3. pointerup refocus — a tap INSIDE the composer with the keyboard
 *      closed re-focuses within the same gesture (focus({preventScroll})
 *      after pointerup is a user gesture, so the IME opens);
 *   4. visualViewport keyboard detection — feeds layer 3's guard and the
 *      keyboard visibility state.
 * Layer 2 (editability flip) lives in installEditabilityRecovery; layer 5
 * (keyboard-visible composer pinning) lives in the stylesheet
 * (interactive-widget=resizes-content) + installKeyboardPinning below.
 */
export interface ImeLadder {
  attach(): () => void
  isKeyboardOpen(): boolean
}

export function installImeLadder(root: ParentNode = document): ImeLadder {
  let lastPointerDown = 0
  let keyboardOpen = false

  const syncKeyboard = (): void => {
    const vv = window.visualViewport
    keyboardOpen = vv !== null && isKeyboardOpen(window.innerHeight, vv.height)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') return
    lastPointerDown = Date.now()
  }

  const onFocusIn = (event: FocusEvent): void => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof HTMLElement)) return
    if (event.target !== input && !input.contains(event.target as Node)) return
    const fromGesture = Date.now() - lastPointerDown < 500
    if (fromGesture) return
    // Layer 1: drop the programmatic focus and keep dropping for 12 rAF
    // frames (the official submit effect re-focuses within the commit).
    // A fresh pointer gesture cancels the drop loop (the tap must win).
    let frames = 0
    let cancelled = false
    const onGestureCancel = (): void => { cancelled = true }
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
 * Keyboard-visible composer pinning (IME ladder layer 5, P1.5): with
 * interactive-widget=resizes-content the layout viewport already shrinks;
 * this is the fallback for engines that ignore the token — when the
 * keyboard opens and the composer seat is below the visual viewport, scroll
 * it into view (nearest, no jarring jumps).
 */
export function installKeyboardPinning(root: ParentNode = document): () => void {
  let keyboardOpen = false
  const onResize = (): void => {
    const vv = window.visualViewport
    const next = vv !== null && isKeyboardOpen(window.innerHeight, vv.height)
    if (next === keyboardOpen) return
    keyboardOpen = next
    if (!keyboardOpen) return
    const seat = root.querySelector('[data-composer-seat]')
    if (seat instanceof Element) {
      const rect = seat.getBoundingClientRect()
      const vvBottom = vv !== null ? vv.height : window.innerHeight
      if (rect.bottom > vvBottom) {
        seat.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
  }
  window.visualViewport?.addEventListener('resize', onResize)
  return () => window.visualViewport?.removeEventListener('resize', onResize)
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
