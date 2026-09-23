/**
 * Source-header hover PREWARM intent: a
 * dwell machine that reports "the user
 * is deliberately heading for this source" so the App can re-order its
 * EXISTING single prewarm slot — it never opens a card and never takes a slot.
 *
 * Deliberately NOT `hover-intent.ts`: that machine owns the row hover-card's
 * visibility (500ms dwell, 200ms close grace, a page-global single visible
 * card slot, dismissal watches). Reusing it would drag card visibility
 * semantics into a navigation signal: opening no card, dismissing no card, and
 * one machine per source header instead of one visible card per document. This
 * leaf is DOM-free, slot-free and state-free beyond its own timers.
 *
 * Semantics (all decisions against the synchronous `inside` flag, never a
 * committed render):
 *
 * - `enter()` arms the dwell ({@link INTENT_DWELL_MS}, 120ms). The intent
 *   fires AT MOST once per armed dwell, and only while the pointer is still
 *   inside at fire time — a pointer that left before the dwell never fires.
 * - `leave()` starts the leave grace ({@link INTENT_LEAVE_GRACE_MS}, 80ms)
 *   instead of cancelling immediately: a quick exit / re-entry (pointer
 *   brushing a child control, a sub-frame layout shift) does NOT restart the
 *   dwell, so the deadline stays ">= dwellMs after the first enter". Once the
 *   grace expires the armed dwell is dropped and a later `enter()` starts a
 *   fresh full dwell.
 * - `press()` (a click or keyboard activation) cancels the current hover
 *   cycle: the activation itself handles the switch, and no intent may fire
 *   afterwards until the pointer leaves and enters again.
 * - `dispose()` drops every timer and makes the machine permanently inert.
 *
 * Queue/priority/billing discipline (re-order only, per-session budget, 60s
 * cooldown, harvest-parked sources untouched) lives in the App consumer — this
 * machine only answers "did the pointer dwell here?". Pure leaf: no React, no
 * DOM, no module state, plain-node unit-testable (test/session-rows/
 * prewarm-intent.test.ts).
 */

/** Dwell before a hover reports prewarm intent (120ms). */
export const INTENT_DWELL_MS = 120

/**
 * Grace after the pointer leaves, during which the armed dwell is preserved: a
 * quick exit/re-entry must not restart the countdown (pointer brushing a child
 * control). After the grace the dwell is dropped.
 */
export const INTENT_LEAVE_GRACE_MS = 80

/** Construction options (timing overrides are for tests / future tuning). */
export interface PrewarmIntentOptions {
  /** Dwell before the intent fires (default {@link INTENT_DWELL_MS}). */
  dwellMs?: number
  /** Grace that preserves an armed dwell across a leave (default {@link INTENT_LEAVE_GRACE_MS}). */
  leaveGraceMs?: number
  /**
   * Called exactly once per armed dwell that survives to `dwellMs` with the
   * pointer inside. The consumer decides what an intent is worth (queue
   * re-order, budget); this machine never re-fires without a new enter.
   */
  onIntent: () => void
}

/** One source header's pointer-driven prewarm lifecycle. */
export interface PrewarmIntent {
  /** The pointer entered the source header region. */
  enter(): void
  /** The pointer left the source header region. */
  leave(): void
  /** A press (click / keyboard) consumed this hover cycle: cancel, no intent. */
  press(): void
  /** Drop pending timers; the machine is inert afterwards. Safe from an effect cleanup. */
  dispose(): void
}

/**
 * Build the dwell machine for one source header.
 * @param options - timing overrides and the intent callback.
 * @returns the {@link PrewarmIntent} handle for that header.
 */
export function createPrewarmIntent(options: PrewarmIntentOptions): PrewarmIntent {
  const dwellMs = options.dwellMs ?? INTENT_DWELL_MS
  const leaveGraceMs = options.leaveGraceMs ?? INTENT_LEAVE_GRACE_MS
  const onIntent = options.onIntent
  let inside = false
  let pressed = false
  let disposed = false
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

  return {
    enter(): void {
      if (disposed) return
      inside = true
      // A press already consumed this hover cycle: the pointer is still inside,
      // so no new pointerenter will arrive — stay inert until leave()+enter().
      if (pressed) return
      // Re-entry inside the leave grace keeps the ORIGINAL dwell deadline: the
      // grace exists exactly so a brush does not restart the countdown.
      clearGrace()
      if (dwell !== null) return
      dwell = setTimeout(() => {
        dwell = null
        // The flag — not a committed render — decides: a leave inside the
        // commit window (or a press) cancels the open outright.
        if (!inside || pressed || disposed) return
        onIntent()
      }, dwellMs)
    },
    leave(): void {
      if (disposed) return
      inside = false
      // The hover cycle ended: a later enter is a fresh intent, even after a press.
      pressed = false
      clearGrace()
      grace = setTimeout(() => {
        grace = null
        // The pointer never came back: drop the armed dwell (a stale deadline
        // must not fire on a later accidental re-entry).
        clearDwell()
      }, leaveGraceMs)
    },
    press(): void {
      if (disposed) return
      pressed = true
      clearDwell()
      clearGrace()
    },
    dispose(): void {
      disposed = true
      inside = false
      clearDwell()
      clearGrace()
    },
  }
}

/* ------------------------------------------------------------------------- *
 * App-consumer policy (pure)
 *
 * The machine above only answers "did the pointer dwell here?". What an intent
 * is WORTH is decided here and consumed by the App's EXISTING prewarm queue:
 * re-order only — never a new slot, never a bypass of the App's
 * eligibility/suppression/harvest gates.
 * ------------------------------------------------------------------------- */

/**
 * Intent boots per page session. A hover may re-order the ONE existing
 * background slot, but every boot can create one remote blank session (the
 * official initial navigation, design 06 §5), so the signal is billed.
 */
export const INTENT_PREWARM_MAX_PER_SESSION = 2

/**
 * Minimum gap between two intent boots. Queue re-ordering is free; only a boot
 * that actually starts is billed, and two billed boots must not land together.
 */
export const INTENT_PREWARM_COOLDOWN_MS = 60_000

/** One intent boot per source per session. */
const INTENT_PREWARM_PER_SOURCE = 1

/** Billing ledger for intent-caused boots (renderer-local, never persisted). */
export interface IntentPrewarmBudget {
  /** Intent boots already started this session. */
  boots: number
  /** Epoch ms of the last intent boot; 0 before the first. */
  lastBootAt: number
  /** Sources whose one intent boot is already spent. */
  usedSources: readonly string[]
}

/**
 * The empty ledger (session start).
 * @returns A fresh budget with nothing spent.
 */
export function emptyIntentPrewarmBudget(): IntentPrewarmBudget {
  return { boots: 0, lastBootAt: 0, usedSources: [] }
}

/**
 * Whether a hover intent for `sourceId` may still buy a priority boot now.
 *
 * This gates the RE-ORDER, not the boot: an intent refused here never touches
 * the queue at all, so the source keeps its ordinary seeding order and the
 * ordinary prewarm machinery remains its only path to a mount.
 * @param budget - Billing ledger so far.
 * @param sourceId - The hovered source.
 * @param now - Epoch ms.
 * @returns True when the intent may take priority.
 */
export function intentPrewarmAllowed(
  budget: IntentPrewarmBudget,
  sourceId: string,
  now: number,
): boolean {
  const usedForSource = budget.usedSources.filter(id => id === sourceId).length
  if (usedForSource >= INTENT_PREWARM_PER_SOURCE) return false
  if (budget.boots >= INTENT_PREWARM_MAX_PER_SESSION) return false
  return budget.boots === 0 || now - budget.lastBootAt >= INTENT_PREWARM_COOLDOWN_MS
}

/**
 * Bill one intent boot that actually started (called when the existing
 * `drainPrewarm` selection lands on an intent-prioritised source).
 * @param budget - Billing ledger.
 * @param sourceId - The source that took the background slot.
 * @param now - Epoch ms.
 * @returns The next ledger.
 */
export function intentPrewarmSpent(
  budget: IntentPrewarmBudget,
  sourceId: string,
  now: number,
): IntentPrewarmBudget {
  return {
    boots: budget.boots + 1,
    lastBootAt: now,
    usedSources: budget.usedSources.includes(sourceId) ? budget.usedSources : [...budget.usedSources, sourceId],
  }
}

/**
 * The ONLY thing an intent does to the existing queue: move the hovered source
 * to the head so the App's existing `pickPrewarmTarget` reaches it first.
 *
 * Re-order only — deliberately not a bypass:
 *  - a source outside `eligible` (reclaimed/suppressed, mounted, active,
 *    harvest-parked, not ready, managed-down) returns the queue UNCHANGED, so a
 *    hover can never re-boot a source the App's discipline holds back;
 *  - the harvest reservation in `prewarmCandidates` is untouched: while any
 *    harvest candidate is pending, warm ids are not eligible at all, so a
 *    hovered warm source stays parked behind baseline recovery.
 * @param queue - Current pending queue (`prewarmQueueRef.current`).
 * @param sourceId - The hovered source.
 * @param eligible - Current eligibility set (`prewarmEligibleRef.current`).
 * @returns The re-ordered queue; the same array reference when nothing changes.
 */
export function prioritizePrewarmSource(
  queue: string[],
  sourceId: string,
  eligible: ReadonlySet<string>,
): string[] {
  if (!eligible.has(sourceId)) return queue
  if (queue[0] === sourceId) return queue
  return [sourceId, ...queue.filter(id => id !== sourceId)]
}
