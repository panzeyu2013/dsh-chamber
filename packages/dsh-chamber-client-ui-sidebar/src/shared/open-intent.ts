/**
 * Open-session intent — the page-wide slot recording "the user asked to open
 * session X on source S" (design 05 §2.2 revision 2026-12; 2026-12 field report
 * problem 1: switching to a session of a REMOTE server flashed a brand-new
 * "新会话" first, then switched to the requested one).
 *
 * WHY this state must be page-wide instead of App-local React state. The App
 * owns the request (`App.openSession` is the single funnel for the sidebar
 * click, notification clicks, deep links, the todo strip and the git plugin),
 * but three different layers have to agree on "an open is in flight":
 *
 * 1. the App's projection gate ({@link projectableCurrent}) — the sidebar is a
 *    chamber plugin that renders EVERY source; while the target source carries
 *    an open intent, its runtime-facts `current` must not be projected, so the
 *    blank "New Session" row the runtime self-selects during a cold boot can
 *    never enter the navigation list (design 05 §2.2's `(!blank || current)`
 *    rule);
 * 2. the incoming view's reveal gate ({@link shouldHoldViewVeil}) — the boot
 *    veil used to lift at boot settle, i.e. BEFORE the queued open was
 *    dispatched (the dispatch needs the session-controller child fiber and
 *    commonly retries once at 400ms), so the user saw the target shell's
 *    self-selected blank session for that whole window;
 * 3. the boot-ctx early-open arm (the sidebar plugin's own effect, design 05
 *    §2.2) — it runs inside the target instance's ctx and reads the LIVE intent
 *    to preempt the runtime's initial-selection policy before the workspace
 *    follow baseline lands.
 *
 * Layer 3 is why this is a module singleton rather than App state: the plugin
 * lives in another React tree (another instance's ctx) and cannot see App
 * state, while the App cannot see the plugin. The module rides the same vite
 * shared chunk as chamberBridge / pending-click (`singleton.ts`), so every
 * shell and the App share ONE slot — the same pattern `pending-click.ts`
 * established for the cross-shell double-click pending.
 *
 * Lifecycle (the only writer is `App.openSession`, the only clearer is its
 * `finally`):
 * - arm on request; the value is the session id the user asked for;
 * - release on settle — success OR terminal failure — guarded by session id,
 *   because a second click on the same source REPLACES the intent and the older
 *   dispatch's `finally` must not clear the newer one;
 * - retirement clears the source's slot (a same-id re-add is a new generation).
 * The slot is never persisted and never polled: it exists exactly as long as one
 * open request is in flight.
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('open-intent')

type OpenIntentListener = () => void

/** sourceId → the session id the user asked to open (absent = nothing pending). */
const intents = new Map<string, string>()
const listeners = new Set<OpenIntentListener>()
/**
 * Immutable snapshot of {@link intents}, rebuilt on every change. The App's
 * React binding reads it through `useSyncExternalStore`, which requires the
 * snapshot identity to stay stable while nothing changed (a fresh object per
 * read would re-render forever) — so the rebuild happens inside {@link notify}
 * and nowhere else.
 */
let snapshot: Readonly<Record<string, string>> = {}

function notify(): void {
  snapshot = Object.fromEntries(intents)
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      // Per-listener isolation (chamberBridge.setActiveSource's discipline): a
      // throwing subscriber must not abort the fan-out for its siblings.
      console.error('[dsh-chamber] open-intent subscriber threw:', error)
    }
  }
}

/**
 * Record (or replace) the pending open of `sourceId`. Returns whether the slot
 * actually changed — a repeated arm for the same session is a no-op, so the
 * idempotent re-open path (a misjudged slow double click) cannot churn the
 * projection.
 */
export function armOpenIntent(sourceId: string, sessionId: string): boolean {
  if (intents.get(sourceId) === sessionId) return false
  intents.set(sourceId, sessionId)
  notify()
  return true
}

/**
 * Release the pending open of `sourceId`. With `sessionId` the release is
 * conditional: a newer click that replaced the intent keeps it (the older
 * dispatch's `finally` must never clear the newer request's gate). Only the
 * LAST release of the current intent notifies.
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
 * The immutable snapshot of every pending intent. Stable identity while nothing
 * changed (see {@link snapshot}) — the App binds this with
 * `useSyncExternalStore` so both the projection gate and the per-view reveal
 * gate re-render exactly when an open starts or settles.
 */
export function getOpenIntentsSnapshot(): Readonly<Record<string, string>> {
  return snapshot
}

/**
 * Retire the intents of sources that left the registry (same discipline as the
 * App's other per-source refs: a same-id re-add is a new generation and must
 * not inherit the previous one's pending open).
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
 * Current-session projection gate (design 05 §2.2 revision).
 *
 * The runtime-facts `current` may only reach the navigation list when the
 * source is the ACTIVE view (design 06 §4.3 single-selection discipline) AND
 * the projection would not show a session OTHER than the one being opened.
 * While an open is in flight the source's runtime still reports whatever
 * session it happened to select — during a cold boot that is the blank session
 * the official initial-navigation policy just minted, and projecting it renders
 * a highlighted "新会话" row that vanishes one dispatch later.
 *
 * The `pendingSessionId !== current` qualifier matters in both directions:
 * - the blank-row flash IS `current !== pending` (the whole point of the gate);
 * - an IDEMPOTENT re-open (`current === pending`, e.g. re-clicking the session
 *   already on screen, or a notification for it) must keep its highlight: the
 *   projection is already correct, and un-highlighting it for the duration of
 *   the dispatch would be a pure flicker with no information in it.
 *
 * @param activeViewId - the source whose shell is on screen.
 * @param sourceId - the source being projected.
 * @param current - the source's reported current session id.
 * @param pendingSessionId - the session an in-flight open targets, or undefined.
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
 * Reveal gate for the incoming view (design 05 §2.2 revision; 2026-09-11
 * review S1).
 *
 * The shell must not be revealed until it shows what the user asked for. The
 * boot window itself is already covered by the existing boot veil
 * (`InstanceView`: `!settled || holdVeil`); this rule extends the hold past a
 * clean settle for exactly as long as the view would show NOTHING legitimate
 * while an open is in flight.
 *
 * The exact rule: hold iff an open is in flight AND the shell did not fail AND
 * it does not already show the requested session AND the view is blank
 * (`blankCurrent`). Three deliberate exclusions:
 *
 * - a FAILED shell never holds (the App's failure overlay owns that
 *   presentation, and an open queued behind a boot that never settles would
 *   otherwise pin the veil for the whole 68s queued-open budget);
 * - a view that already shows the requested session never holds — that covers
 *   the idempotent re-open AND the case where the boot-ctx early-open arm
 *   preempted the runtime's initial selection (the requested session is current
 *   from the moment the shell settles, so the veil lifts immediately);
 * - a WARM shell showing a legitimate session never holds, even while an open
 *   for another session is still in flight: that view's `blankCurrent` is false.
 *   Without this input the rule covered a rendered, working view with the opaque
 *   loading veil for up to the 8s dispatch budget — design 05 §2.2.1 gate 2
 *   promises the opposite (一个已经渲染出正确内容的温壳不会被盖). The cold-boot
 *   case keeps its veil: the runtime has not selected the requested session yet
 *   and its current session is undefined/blank, so `blankCurrent` is true and
 *   the hold hides exactly the blank "新会话" row the gate exists for.
 *
 * @param opts.failed - the shell settled with a boot failure.
 * @param opts.pendingIntent - an open request for this view is in flight.
 * @param opts.showsRequestedSession - the shell is settled AND its current
 *   session is the requested one (the raw runtime fact, never the gated
 *   projection value).
 * @param opts.blankCurrent - the view shows nothing legitimate: its current
 *   session is undefined or blank. The App passes `true` when that is UNKNOWN,
 *   so the cold-boot window fails closed toward holding the veil.
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
 * Budget of the boot-time early-open arm (design 05 §2.2 revision) — the same
 * order as the App's own dispatch budget (`OPEN_WAIT_MS` in renderer/shell.ts).
 * Past it the arm stops: the App's post-settle dispatch is the authority for the
 * open's terminal outcome, and the arm exists only to preempt the runtime's
 * initial-navigation policy, which decides within the first baseline window.
 */
export const EARLY_OPEN_BUDGET_MS = 8_000

/**
 * Cadence of the early-open arm. Deliberately much tighter than the App
 * dispatch's 400ms retry (`OPEN_RETRY_MS`): the arm competes with the official
 * `watchNavigation()` policy, which reacts to the session-list baseline
 * synchronously, so it must observe "the session is addressable" as early as
 * possible. The win condition is a later workspace-follow baseline (the policy
 * needs BOTH baselines), which over a tunnel is commonly tens to hundreds of ms
 * after the session list — a 400ms tick would miss most of that window.
 */
export const EARLY_OPEN_RETRY_MS = 50

/**
 * Whether the arm may open now: the intent is still live (the App has not
 * released it — a newer click replaces the value, a settle clears it) AND the
 * session is addressable in this ctx's own list (an unknown id would make the
 * official controller throw `sessions.select: unknown session`).
 */
export function shouldEarlyOpenSession(intentId: string | undefined, listed: boolean): boolean {
  return intentId !== undefined && listed
}
