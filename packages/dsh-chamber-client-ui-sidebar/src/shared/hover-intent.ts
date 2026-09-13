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
 *     Measured with a CDP probe over the real sidebar (dispatch pointerover on a
 *     row, pointerout 492-570ms later, then count portaled 244px cards): the
 *     dwell-to-paint window is 502-504ms idle and 501-551ms with the main thread
 *     busy, and the vendored atom stranded a card in 7 of 45 loaded trials —
 *     every one of them a leave in the 496-510ms band, i.e. inside that window.
 *     This module's machine stranded none (0/45) under the same probe.
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
