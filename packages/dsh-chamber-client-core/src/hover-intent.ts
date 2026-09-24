/**
 * Row hover-card intent: the dwell/grace state machine behind `RowHoverCard`.
 *
 * THE POINTER-INSIDE FLAG IS THE AUTHORITY, NEVER A COMMITTED RENDER. Two
 * stranding defects come from letting React's last committed state decide:
 *  1. OPEN — the vendored `HoverCard` arms its grace close only `if (open)` from
 *     the last committed render. A shell is one large React root per instance, so
 *     the commit can land tens of ms after the dwell timer; a pointerleave in that
 *     window reads `open === false`, arms no close, and the card mounts with the
 *     pointer gone — no later event targets it. The machine's dwell timer
 *     re-checks `inside` when it fires, and `leave()` arms the grace close
 *     UNCONDITIONALLY (closing is idempotent; an opened card is always closed).
 *  2. CLOSE — a `press` or `setDisabled` handled while the dwell's open is in
 *     flight can commit the close first and the stale open last, so the card mounts
 *     while the machine believes it is closed and later closes no-op. Hence ONE
 *     piece of state, rendered straight from a tiny store
 *     (`useSyncExternalStore`): React re-checks the snapshot after commit, so a
 *     visibility changed mid-render cannot be committed.
 *
 * ONE VISIBLE CARD PER DOCUMENT (the slot below): a second card opening dismisses
 * the first — also the self-healing path for a leave never delivered. Window blur /
 * hidden document dismisses it, and an N-ctx VIEW SWITCH does so through
 * {@link dismissVisibleRowCard}: the card is portaled to `document.body`, so
 * CSS-hiding the owning view hides neither it nor its hit testing.
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('hover-intent')

/**
 * The one visible row card in this document, as its own dismiss callback.
 * Module-global for the same reason `shared/pending-click.ts` is: every N-ctx shell
 * mounts its own sidebar tree, and only one card may be visible on the page.
 */
let visibleCard: (() => void) | null = null

/** Dismiss whatever card currently holds the slot (window blur, hidden page). */
function dismissVisibleCard(): void {
  visibleCard?.()
}

/**
 * Close whatever row card currently holds the page-global slot — the N-ctx
 * hidden-view closer. A card is portaled to `document.body`, so it is NOT a
 * descendant of the view that owns it: hiding that view with
 * `visibility: hidden; opacity: 0; pointer-events: none`
 * (`.instance-hidden` / `.instance-pending`) neither hides the card nor delivers
 * the pointer event that would dismiss it, so it survived a view switch painting
 * over the incoming view. The renderer's view-hide path calls this in the same frame
 * the class lands. Reuses the slot machinery (exactly one card, no handle needed);
 * safe at any time — a no-op with no open card, and after the call the card behaves
 * as if the pointer had left it.
 */
export function dismissVisibleRowCard(): void {
  dismissVisibleCard()
}

/**
 * Page-level dismissal watch: bound lazily by the first card that opens and never
 * unbound — it owns no per-card state, only the slot. Guarded so the module stays
 * importable in the DOM-free node tests.
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
 * Pointer-driven hover lifecycle for one card: the observable store the component
 * renders from.
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
 * Subscribe to visibility changes. @returns the unsubscribe function.
 */
  subscribe(listener: () => void): () => void
}

/**
 * Build the intent machine for one card. @returns the {@link HoverIntent} handle.
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
    // Claim BEFORE dismissing: the previous card's release must not clear the slot we just took.
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
        // The pointer may have left inside the commit window: the synchronous flag decides, not a render.
        if (!inside) return
        setOpen(true)
      }, openDelayMs)
    },
    leave(): void {
      inside = false
      // The armed dwell is deliberately NOT cancelled here: the fire-time check above owns the decision.
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
      // Free the page slot: the owner is unmounting, and a disposed machine must not
      // keep dismissing future cards through a stale slot entry.
      releaseSlot()
    },
    isOpen: () => open,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
