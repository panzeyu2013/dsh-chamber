/**
 * Presentation arbiter (B3) - ONE decision for what the user sees.
 *
 * WHY. Four independent timers decide visibility today, in four files:
 *   - the App reveal gate holds the OLD view up to 1s (reveal-gate.ts:36);
 *   - InstanceView holds the veil while booting, upgrading to actions at 10s
 *     (source-readiness.ts:164-187);
 *   - the session-surface hold keeps it while the requested session is not on
 *     screen (session-surface.ts:76/82: 2s for a missing root, 70s for hero/settling);
 *   - the App's open lifecycle releases the intent (up to 68s queued).
 * Nothing computes the TOTAL bound, so 'is there a state the user can be parked in
 * forever?' is not answerable from the code. Here it is: {@link veilUpperBoundMs}
 * is the only calculator, and {@link presentationBoundWithinGoal} proves the goal's
 * 155s invariant holds for every phase.
 *
 * PURITY: zero imports, no clock reads, no DOM. All facts and all thresholds
 * arrive as inputs (B3's wiring supplies them from the existing modules), so this
 * file is the single place the composition is defined.
 */

/** What the shell itself reports about the requested session (session-surface.ts).
 * `unknown` is NEW as a distinct state: the old reader folded an unreadable
 * `data-phase` into `hero`, i.e. a version-skewed anchor held the veil for the
 * full outer bound while looking exactly like 'no content yet'. */
import { elapsedSince, normalizeAt } from './time.ts'

export type SessionSurfacePhase = 'absent' | 'hero' | 'settling' | 'active' | 'unknown'

export interface PresentationFacts {
  /** The shell settled (booted or failed) at least once for this view. */
  readonly settled: boolean
  /** The source is not connected: boot is deliberately deferred. */
  readonly bootDeferred: boolean
  /** ms since this boot attempt started. */
  readonly waitedMs: number
  /** An open intent is in flight for a session that is not on screen yet. */
  readonly holdForOpenIntent: boolean
  /** Observed session-root phase, or null before any observation. */
  readonly surfacePhase: SessionSurfacePhase | null
  /** ms since the current hold started (null = clock not anchored yet). */
  readonly holdStartedAtMs: number | null
  /** ms since the session root first went missing in the current streak. */
  readonly absentSinceMs: number | null
  readonly nowMs: number
  /** A modal failure overlay owns the screen (it is opaque; the veil yields). */
  readonly failureOverlayVisible: boolean
}

export interface PresentationThresholds {
  /** Pure spinner before the veil turns into an actionable state. */
  readonly veilActionsAfterMs: number
  /** Outer bound for hero/settling: the session exists but has no content yet. */
  readonly surfaceMaxHoldMs: number
  /** Bound for absent/unknown: nothing readable, so fall back to the shell's own
   * loading surface and the boot-gap banner instead of holding. */
  readonly surfaceAbsentFallbackMs: number
}

/** What the frame should render. One value, not three booleans to combine. */
export type PresentationMode =
  | 'failure'       // the failure overlay owns the screen
  | 'deferred'      // source not connected: show 'connect' + server switch
  | 'loading'       // plain progress face
  | 'loading-stuck' // progress face WITH actions (retry/switch/reload)
  | 'contents'      // the tenant is visible (no veil)

export interface PresentationFrame {
  readonly mode: PresentationMode
  /** Whether the tenant shell must be hidden (veil held). */
  readonly veilVisible: boolean
  /** Whether the progress face must offer actions. */
  readonly actions: boolean
  /** Deadline for THIS frame, in ms from now: the caller re-evaluates then.
   *  Infinity when nothing is pending (contents/failure/deferred). */
  readonly reevaluateInMs: number
}

/** The bound for one surface phase, from the threshold table. `unknown` shares the
 * absent bound on purpose: a phase this build cannot read is not evidence that the
 * session has content, and the shell's own loading surface plus the boot-gap banner
 * are a better answer than holding an opaque veil for a minute. */
/**
 * A threshold set with every unusable value replaced by the largest finite one (0
 * when none is usable). An unusable threshold must not become a NaN deadline: a
 * held veil whose deadline is NaN can never be scheduled for release.
 */
function usableThresholds(thresholds: PresentationThresholds): PresentationThresholds {
  const candidates = [thresholds.veilActionsAfterMs, thresholds.surfaceMaxHoldMs, thresholds.surfaceAbsentFallbackMs]
    .filter((value) => Number.isFinite(value) && value >= 0)
  const fallback = candidates.length > 0 ? Math.max(...candidates) : 0
  const usable = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : fallback)
  return {
    veilActionsAfterMs: usable(thresholds.veilActionsAfterMs),
    surfaceMaxHoldMs: usable(thresholds.surfaceMaxHoldMs),
    surfaceAbsentFallbackMs: usable(thresholds.surfaceAbsentFallbackMs),
  }
}

export function surfaceBoundMs(
  phase: SessionSurfacePhase,
  thresholds: PresentationThresholds,
): number {
  const safe = usableThresholds(thresholds)
  switch (phase) {
    case 'active':
      return 0
    case 'hero':
    case 'settling':
      return safe.surfaceMaxHoldMs
    case 'absent':
    case 'unknown':
      return safe.surfaceAbsentFallbackMs
  }
}

/**
 * Decide the visible frame. Total function: every input combination returns a
 * mode, a veil flag and a re-evaluation deadline.
 *
 * Precedence (highest first): failure overlay, contents when the surface says so,
 * deferred, then the boot-veil ladder. The surface can only RELEASE - it never
 * invents a hold: `holdForOpenIntent === false` means the App has already decided
 * the session is not its business any more.
 */
export function decidePresentation(
  facts: PresentationFacts,
  thresholds: PresentationThresholds,
): PresentationFrame {
  const safe = usableThresholds(thresholds)
  if (facts.failureOverlayVisible) {
    return { mode: 'failure', veilVisible: false, actions: false, reevaluateInMs: Number.POSITIVE_INFINITY }
  }

  if (!facts.settled) {
    if (facts.bootDeferred) {
      return { mode: 'deferred', veilVisible: true, actions: true, reevaluateInMs: Number.POSITIVE_INFINITY }
    }
    const waitedMs = normalizeAt(facts.waitedMs)
    const stuck = waitedMs >= safe.veilActionsAfterMs
    const remaining = Math.max(0, safe.veilActionsAfterMs - waitedMs)
    return {
      mode: stuck ? 'loading-stuck' : 'loading',
      veilVisible: true,
      actions: stuck,
      reevaluateInMs: remaining,
    }
  }

  // Settled. The only reason to keep the veil is an open intent whose target is not
  // on screen yet.
  if (!facts.holdForOpenIntent) {
    return { mode: 'contents', veilVisible: false, actions: false, reevaluateInMs: Number.POSITIVE_INFINITY }
  }
  const phase = facts.surfacePhase
  if (phase === null) {
    // Clock not anchored / no observation yet: hold without releasing, and ask to
    // be re-evaluated as soon as the caller anchors (remaining = 0).
    return { mode: 'loading', veilVisible: true, actions: false, reevaluateInMs: 0 }
  }
  if (phase === 'active') {
    return { mode: 'contents', veilVisible: false, actions: false, reevaluateInMs: Number.POSITIVE_INFINITY }
  }
  const bound = surfaceBoundMs(phase, safe)
  const base = phase === 'absent' || phase === 'unknown' ? (facts.absentSinceMs ?? facts.holdStartedAtMs) : facts.holdStartedAtMs
  const elapsed = elapsedSince(base, facts.nowMs)
  if (elapsed === null) {
    // Clock not anchored (or rolled back): hold, but ask for an immediate retry.
    // Returning "the full bound" here would be a silent lie - the caller would arm a
    // timer for a window that has not started, and an unanchored clock could then
    // keep the veil forever if the caller never anchors it.
    return { mode: 'loading', veilVisible: true, actions: false, reevaluateInMs: 0 }
  }
  if (elapsed >= bound) {
    // Bound reached: reveal and hand the explanation to the shell's own surface and
    // the boot-gap banner. `absent`/`unknown` reveal as 'contents' (the shell is
    // settled, show it); hero/settling reveal as 'loading-stuck' (there is a real
    // loading face inside the shell worth showing with actions).
    return phase === 'absent' || phase === 'unknown'
      ? { mode: 'contents', veilVisible: false, actions: false, reevaluateInMs: Number.POSITIVE_INFINITY }
      : { mode: 'loading-stuck', veilVisible: true, actions: true, reevaluateInMs: 0 }
  }
  return { mode: 'loading', veilVisible: true, actions: false, reevaluateInMs: Math.max(0, bound - elapsed) }
}

/**
 * Upper bound of the veil for one attempt, in ms, from the threshold table alone.
 * This is the single answer to 'how long can the user be parked' - the number G4 in
 * the refactor plan asserts (<= 155s including the boot budget and the abandonment
 * sweep, which live in the caller's tables and are passed in).
 */
export function veilUpperBoundMs(thresholds: PresentationThresholds, extra: {
  readonly bootTimeoutMs: number
  readonly reclaimSweepMs: number
}): number {
  const surfaceWorst = Math.max(thresholds.surfaceMaxHoldMs, thresholds.surfaceAbsentFallbackMs)
  return extra.bootTimeoutMs + extra.reclaimSweepMs + Math.max(surfaceWorst, thresholds.veilActionsAfterMs)
}
