/**
 * Open-session intent — the page-wide slot recording "the user asked to open
 * session X on source S". Switching to a session of a REMOTE server must not
 * flash a brand-new "新会话" first, then switch to the requested one.
 *
 * This must be page-wide, not App-local state, because three layers agree on
 * "an open is in flight": the App's projection gate ({@link
 * projectableCurrent}) keeps the runtime's self-selected blank row out of the
 * sidebar; the view's reveal gate ({@link shouldHoldViewVeil}) holds the boot
 * veil until the queued open is dispatched; and the target instance's own
 * boot-ctx early-open arm reads the live intent to preempt the runtime's initial
 * selection. The last one lives in another React tree, so the slot is a module
 * singleton on the same vite shared chunk as chamberBridge / pending-click —
 * every shell and the App share ONE slot.
 *
 * Lifecycle: armed by `App.openSession` (the only writer), released on settle
 * (success or terminal failure) guarded by session id, because a second click
 * REPLACES the intent and the older dispatch's `finally` must not clear the
 * newer one; retirement clears the source's slot. Never persisted, never polled.
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('open-intent')

type OpenIntentListener = () => void

/** sourceId → the session id the user asked to open (absent = nothing pending). */
const intents = new Map<string, string>()
const listeners = new Set<OpenIntentListener>()
/**
 * Immutable snapshot of {@link intents}, rebuilt on every change. The App's
 * `useSyncExternalStore` binding requires a stable identity while nothing
 * changed, so the rebuild happens inside {@link notify} and nowhere else.
 */
let snapshot: Readonly<Record<string, string>> = {}

function notify(): void {
  snapshot = Object.fromEntries(intents)
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      // Per-listener isolation (chamberBridge.setActiveSource's discipline).
      console.error('[dsh-chamber] open-intent subscriber threw:', error)
    }
  }
}

/**
 * Record (or replace) the pending open of `sourceId`. Returns whether the slot
 * changed — a repeated arm for the same session is a no-op, so an idempotent
 * re-open cannot churn the projection.
 */
export function armOpenIntent(sourceId: string, sessionId: string): boolean {
  if (intents.get(sourceId) === sessionId) return false
  intents.set(sourceId, sessionId)
  notify()
  return true
}

/**
 * Release the pending open of `sourceId`. With `sessionId` the release is
 * conditional: a newer click that replaced the intent keeps it. Only the LAST
 * release of the current intent notifies.
 */
export function releaseOpenIntent(sourceId: string, sessionId?: string): boolean {
  const current = intents.get(sourceId)
  if (current === undefined) return false
  if (sessionId !== undefined && current !== sessionId) return false
  intents.delete(sourceId)
  notify()
  return true
}

/** The live intent for one source (read by the boot-ctx early-open arm). */
export function getOpenIntent(sourceId: string): string | undefined {
  return intents.get(sourceId)
}

/** Subscribe to intent changes; returns the unsubscribe. */
export function subscribeOpenIntent(listener: OpenIntentListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The immutable snapshot of every pending intent, with a stable identity while
 * nothing changed — the App binds it with `useSyncExternalStore` so both gates
 * re-render exactly when an open starts or settles.
 */
export function getOpenIntentsSnapshot(): Readonly<Record<string, string>> {
  return snapshot
}

/**
 * Retire the intents of sources that left the registry: a same-id re-add is a new
 * generation and must not inherit the previous one's pending open.
 */
export function clearOpenIntents(sourceIds: Iterable<string>): boolean {
  let changed = false
  for (const sourceId of sourceIds) {
    if (intents.delete(sourceId)) changed = true
  }
  if (changed) notify()
  return changed
}

/**
 * Current-session projection gate.
 *
 * The runtime-facts `current` may only reach the navigation list when the source
 * is the ACTIVE view AND the projection would not show a session OTHER than the
 * one being opened. While an open is in flight the runtime still reports whatever
 * it selected — during a cold boot the blank session the official
 * initial-navigation policy just minted, which would render a highlighted
 * "新会话" row that vanishes one dispatch later.
 *
 * `pendingSessionId !== current` matters in both directions: the blank-row flash
 * IS `current !== pending`, while an IDEMPOTENT re-open (`current === pending`)
 * must keep its highlight — the projection is already correct, and
 * un-highlighting it during the dispatch would be a pure flicker.
 */
export function projectableCurrent(
  activeViewId: string,
  sourceId: string,
  current: string | undefined,
  pendingSessionId: string | undefined,
): string | undefined {
  if (sourceId !== activeViewId) return undefined
  if (pendingSessionId !== undefined && pendingSessionId !== current) return undefined
  return current
}

/**
 * Reveal gate for the incoming view: the shell must not be revealed until it
 * shows what the user asked for.
 *
 * The rule: hold iff an open is in flight AND the shell did not fail AND it does
 * not already show the requested session AND the view is blank (`blankCurrent`).
 * Three deliberate exclusions: a FAILED shell never holds (the failure overlay
 * owns that presentation); a view already showing the requested session never
 * holds (idempotent re-open, or the boot-ctx arm preempted the runtime's initial
 * selection); a WARM shell showing a legitimate session never holds even while
 * another open is in flight (`blankCurrent` false) — an already-rendered view
 * must not be covered by the loading veil.
 *
 * `blankCurrent` is the cold-boot case, and the App passes `true` when it is
 * unknown so that window fails closed toward holding.
 */
export function shouldHoldViewVeil(opts: {
  failed: boolean
  pendingIntent: boolean
  showsRequestedSession: boolean
  blankCurrent: boolean
}): boolean {
  if (opts.pendingIntent !== true) return false
  if (opts.failed === true) return false
  if (opts.showsRequestedSession === true) return false
  return opts.blankCurrent === true
}

/** Test-only: drop every slot (node tests share the module instance). */
export function __resetOpenIntentsForTests(): void {
  intents.clear()
  listeners.clear()
  snapshot = {}
}

/**
 * Budget of the boot-time early-open arm, same order as the App's own dispatch
 * budget. Past it the arm stops: the post-settle dispatch is the authority for
 * the open's terminal outcome, and the arm only preempts the runtime's
 * initial-navigation policy.
 */
export const EARLY_OPEN_BUDGET_MS = 8_000

/**
 * Cadence of the early-open arm, deliberately much tighter than the App
 * dispatch's 400ms retry: the arm competes with the official
 * `watchNavigation()` policy, which reacts to the session-list baseline
 * synchronously, and its win condition (a later workspace-follow baseline)
 * commonly lands tens to hundreds of ms later.
 */
export const EARLY_OPEN_RETRY_MS = 50

/**
 * Whether the arm may open now: the intent is still live (a newer click replaces
 * the value, a settle clears it) AND the session is addressable in this ctx's own
 * list (an unknown id would make the official controller throw).
 */
export function shouldEarlyOpenSession(intentId: string | undefined, listed: boolean): boolean {
  return intentId !== undefined && listed
}
