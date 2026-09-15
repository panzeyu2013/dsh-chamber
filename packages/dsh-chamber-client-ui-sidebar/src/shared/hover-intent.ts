/**
 * Row hover-card intent: the dwell/grace state machine behind `RowHoverCard`.
 *
 * THE POINTER-INSIDE FLAG IS THE AUTHORITY, NEVER A COMMITTED RENDER. Two
 * separate defects come from letting React's last committed state decide:
 *
 *  1. OPEN. The vendored `HoverCard` (ui-primitives) opens through
 *     `setTimeout(() => setOpen(true))` and arms its grace close only
 *     `if (open)` — read from the last COMMITTED render. A chamber shell is one
 *     large React root per instance (a streaming conversation plus the sidebar's
 *     poll and per-second `now` ticks, with the N-ctx shells sharing one
 *     scheduler), so React can commit that open tens of milliseconds after the
 *     dwell timer fired. A pointerleave handled inside that window read
 *     `open === false`, armed no close, and the card then mounted with the
 *     pointer already gone: no later pointer event targets that wrapper, so the
 *     card stayed on screen until the row was hovered and left again.
 *
 *     Characterized during the 2026-09 review with a throwaway CDP probe over
 *     the real sidebar (dispatch pointerover on a row, pointerout some tens of
 *     milliseconds after the dwell, then count portaled 244px cards): the
 *     vendored atom stranded a card on a small fraction of trials under load,
 *     always for a leave inside the dwell-to-paint window, while this module's
 *     machine stranded none. That probe was scratch work — its script and its
 *     rate never shipped, so they are deliberately NOT cited as repo evidence.
 *     The committed regression coverage is: the machine cases in
 *     `test/session-rows/hover-intent.test.ts` (a leave inside the window must still close),
 *     the source locks in `test/session-rows/hover-card-wiring.test.ts`, and the real-pointer
 *     acceptance leg `W-4b-race` (`scripts/gui-acceptance/walkthrough.mjs`,
 *     judged by `hoverRaceVerdict` in `checks.mjs`).
 *
 *  2. CLOSE. A state machine that keeps its own flag while React commits a
 *     separate one can diverge the other way: a press (`press`) or an owner
 *     gate (`setDisabled`) handled while the dwell's open is still in flight
 *     commits the close first and the stale open last, so the card mounts while
 *     the machine believes it is closed — and every later close starts by
 *     checking that flag and becomes a no-op. The card is stranded again.
 *
 * The machine is therefore a tiny store with ONE piece of state, and the
 * component renders straight from it (`useSyncExternalStore(intent.subscribe,
 * intent.isOpen)`): React re-checks the snapshot after commit, so a visibility
 * that changed mid-render cannot be committed, and no second copy of the fact
 * exists to drift.
 *
 * Decisions, all taken against the synchronous `inside` flag written by
 * `enter()`/`leave()`:
 *
 *  - the dwell timer re-checks `inside` when it fires, so a leave inside the
 *    commit window cancels the open outright (no card, not even a flash);
 *  - `leave()` arms the grace close UNCONDITIONALLY: closing is idempotent, so
 *    arming it for a closed card is a no-op, while a card that did open is
 *    always closed once the pointer is genuinely gone.
 *
 * Beyond the race, the machine closes the whole "card nobody can dismiss" class:
 *
 *  - ONE VISIBLE CARD PER DOCUMENT (the slot below): a pointer can only be in
 *    one region, so a second card opening dismisses the first. That is also the
 *    self-healing path for a leave that was never delivered at all — the window
 *    lost focus, the shell holding the row was hidden or occluded, the list
 *    moved under a stationary pointer. The next card anywhere in the document,
 *    including another N-ctx shell's sidebar, takes the slot and closes it.
 *  - window blur / hidden document dismisses the visible card, because a
 *    boundary event is not guaranteed when the pointer is parked on a row while
 *    the user switches away.
 *  - an N-ctx VIEW SWITCH dismisses it through {@link dismissVisibleRowCard}: the
 *    card is portaled to `document.body`, so CSS-hiding the view that owns it
 *    hides neither the card nor its hit testing.
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('hover-intent')

/**
 * The one visible row card in this document, as its own dismiss callback.
 *
 * Module-global for the same reason `shared/pending-click.ts` is: every N-ctx
 * shell mounts its own sidebar React tree, and only one card may be visible on
 * the page — a per-tree slot would let a stranded card in shell A survive while
 * the pointer works in shell B.
 */
let visibleCard: (() => void) | null = null

/** Dismiss whatever card currently holds the slot (window blur, hidden page). */
function dismissVisibleCard(): void {
  visibleCard?.()
}

/**
 * Close whatever row card currently holds the page-global slot.
 *
 * The N-ctx hidden-view closer. A card is portaled to `document.body`
 * (`RowHoverCard`), so it is NOT a descendant of the view that owns it: hiding
 * that view with `visibility: hidden; opacity: 0; pointer-events: none`
 * (`packages/renderer/src/styles.css`, `.instance-hidden` / `.instance-pending`)
 * neither hides the card nor delivers it the pointer event that would dismiss
 * it. A card open while the pointer rests on it therefore survived a view
 * switch, painted over the incoming view until the next pointer move (observed
 * during the 2026-09 review with a real-Chrome harness; the lock for it is
 * `packages/renderer/test/wiring/hover-card-view-hide-wiring.test.ts`).
 * The renderer's view-hide path calls this explicitly, in the same frame the
 * class lands.
 *
 * Reuses the slot machinery, so exactly one card can be affected and the caller
 * needs no handle on it. Safe at any time: a no-op when no card is open, and it
 * never touches a machine that does not hold the slot. After the call the
 * dismissed card behaves exactly as if the pointer had left it — a fresh
 * `enter()` opens it again.
 */
export function dismissVisibleRowCard(): void {
  dismissVisibleCard()
}

/**
 * Page-level dismissal watch: bound lazily by the first card that opens and
 * never unbound — it owns no per-card state, only the slot. Guarded so the
 * module stays importable in the DOM-free node tests.
 */
let watchBound = false
function bindDismissWatch(): void {
  if (watchBound) return
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  watchBound = true
  window.addEventListener('blur', dismissVisibleCard)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') dismissVisibleCard()
  })
}

/** Hover dwell before a row card opens (the official HoverCard's default). */
export const HOVER_OPEN_DELAY_MS = 500

/** Grace after the pointer leaves, so it can cross the 8px gap onto the card. */
export const HOVER_CLOSE_GRACE_MS = 200

/** Construction options: timing and the initial owner gate. */
export interface HoverIntentOptions {
  /** Dwell before opening (default {@link HOVER_OPEN_DELAY_MS}). */
  openDelayMs?: number
  /** Grace before closing after a leave (default {@link HOVER_CLOSE_GRACE_MS}). */
  graceMs?: number
  /** Suppress opening and close an open card; mirror the owner's `disabled`. */
  disabled?: boolean
}

/**
 * Pointer-driven hover lifecycle for one card: the observable store the
 * component renders from.
 */
export interface HoverIntent {
  /** The pointer entered the anchor+card region. */
  enter(): void
  /** The pointer left the anchor+card region. */
  leave(): void
  /** A press outside the card: dismiss now, stay closed until the next enter. */
  press(): void
  /** Owner gating (menu open, drag, inline rename): true closes and suppresses. */
  setDisabled(disabled: boolean): void
  /** Drop pending timers. Safe from an effect cleanup (StrictMode re-runs setup). */
  dispose(): void
  /** Whether the card is visible right now — the render authority. */
  isOpen(): boolean
  /**
   * Subscribe to visibility changes.
   * @param listener - called after every open/close transition.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/**
 * Build the intent machine.
 * @param options - timing and the initial owner gate.
 * @returns the {@link HoverIntent} handle for one card.
 */
export function createHoverIntent(options: HoverIntentOptions = {}): HoverIntent {
  const openDelayMs = options.openDelayMs ?? HOVER_OPEN_DELAY_MS
  const graceMs = options.graceMs ?? HOVER_CLOSE_GRACE_MS
  const listeners = new Set<() => void>()
  let inside = false
  let open = false
  let disabled = options.disabled ?? false
  let dwell: ReturnType<typeof setTimeout> | null = null
  let grace: ReturnType<typeof setTimeout> | null = null

  const clearDwell = (): void => {
    if (dwell === null) return
    clearTimeout(dwell)
    dwell = null
  }
  const clearGrace = (): void => {
    if (grace === null) return
    clearTimeout(grace)
    grace = null
  }
  const dismissSelf = (): void => { setOpen(false) }
  /** Take the page slot, dismissing whichever card held it (see the header). */
  const claimSlot = (): void => {
    const previous = visibleCard
    // Claim BEFORE dismissing: the previous card's release must not clear the
    // slot we just took.
    visibleCard = dismissSelf
    if (previous !== null && previous !== dismissSelf) previous()
  }
  const releaseSlot = (): void => {
    if (visibleCard === dismissSelf) visibleCard = null
  }
  /** The only writer of visibility: it publishes exactly the transitions. */
  const setOpen = (next: boolean): void => {
    if (open === next) return
    open = next
    if (next) {
      bindDismissWatch()
      claimSlot()
    } else {
      releaseSlot()
    }
    for (const listener of listeners) listener()
  }

  return {
    enter(): void {
      inside = true
      if (disabled) return
      clearGrace()
      if (open) return
      clearDwell()
      dwell = setTimeout(() => {
        dwell = null
        // The pointer may have left inside the commit window: the flag — not a
        // committed render — decides.
        if (!inside) return
        setOpen(true)
      }, openDelayMs)
    },
    leave(): void {
      inside = false
      // The armed dwell is deliberately NOT cancelled here: the fire-time check
      // above owns that decision, so no open can ever depend on a timer
      // cancellation landing first.
      clearGrace()
      grace = setTimeout(() => {
        grace = null
        setOpen(false)
      }, graceMs)
    },
    press(): void {
      clearDwell()
      clearGrace()
      setOpen(false)
    },
    setDisabled(next: boolean): void {
      disabled = next
      if (!next) return
      clearDwell()
      clearGrace()
      setOpen(false)
    },
    dispose(): void {
      clearDwell()
      clearGrace()
      // Free the page slot if this card held it: the owner is unmounting (the
      // card goes with it), and a disposed machine must not keep dismissing
      // future cards through a stale slot entry. No visibility transition is
      // published — the subscription dies with the same unmount.
      releaseSlot()
    },
    isOpen: () => open,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
