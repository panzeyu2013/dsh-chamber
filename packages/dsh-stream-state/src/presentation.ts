/**
 * Presentation arbiter - ONE decision for what the user sees; {@link veilUpperBoundMs} is
 * the only total-veil calculator and {@link presentationBoundWithinGoal} proves the 155s
 * invariant.
 *
 * THE FRAME IS AN ABSOLUTE DEADLINE, NOT A DELAY: a delay cannot answer when the veil will
 * be lifted. A frame carries mode, tenant coverage `veil` (held/actionable/released),
 * whether recovery `actions` belong on screen, and `releaseAtMonoMs` - finite for every
 * frame. {@link planVeilTimer} is the only translator to a timer delay.
 *
 * PURITY: no clock reads, no DOM; facts and thresholds arrive as inputs.
 */

import { elapsedSince, normalizeAt } from './time.ts'

/** What the shell reports about the requested session. `unknown` is distinct: an
 * unreadable `data-phase` must not fold into `hero`, which would hold the full bound. */
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

/** Whether the TENANT is covered by the frame. */
export type VeilState =
  | 'released'   // tenant visible, nothing pending
  | 'held'       // tenant covered; releaseAtMonoMs is a finite future moment
  | 'actionable' // tenant visible AND recovery actions belong on screen

export interface PresentationFrame {
  readonly mode: PresentationMode
  /** Coverage of the TENANT, not the boot face: a deferred source has no tenant and is `actionable`. */
  readonly veil: VeilState
  readonly actions: boolean
  /** Absolute monotonic release/evaluation moment. Finite for every frame; for
   * `held` it is strictly in the future relative to the `nowMs` that produced it. */
  readonly releaseAtMonoMs: number
}

/** The bound for one surface phase, from the threshold table. `unknown` shares the
 * absent bound: a phase this build cannot read is not evidence of content, and the
 * shell's own loading surface plus the boot-gap banner beat holding an opaque veil. */
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
 * A threshold set with every unusable value replaced by the largest finite one (0 when
 * none is usable), so an unusable threshold never becomes a NaN deadline that can never
 * be scheduled for release.
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

/** A finite anchor for frames produced while the clock is unusable. */
function anchorOf(nowMs: number): number {
  return Number.isFinite(nowMs) ? nowMs : 0
}

function releasedFrame(mode: PresentationMode, actions: boolean, nowMs: number): PresentationFrame {
  return { mode, veil: 'released', actions, releaseAtMonoMs: anchorOf(nowMs) }
}

function actionableFrame(mode: PresentationMode, nowMs: number): PresentationFrame {
  return { mode, veil: 'actionable', actions: true, releaseAtMonoMs: anchorOf(nowMs) }
}

function heldFrame(mode: PresentationMode, actions: boolean, releaseAtMonoMs: number): PresentationFrame {
  return { mode, veil: 'held', actions, releaseAtMonoMs }
}

/**
 * Translate the frame's absolute deadline into the timer delay the caller arms: a
 * non-held frame needs no timer (0); a held frame with a non-finite clock returns
 * Infinity (the veil holds until the next state change, and a broken clock can never
 * arm an immediate re-arm); a held frame with a finite clock must release in the
 * FUTURE, so a fabricated or stale frame is rejected loudly.
 */
export function planVeilTimer(frame: PresentationFrame, nowMonoMs: number): number {
  if (frame.veil !== 'held') return 0
  if (!Number.isFinite(frame.releaseAtMonoMs)) {
    throw new Error('planVeilTimer: a held frame must carry a finite releaseAtMonoMs')
  }
  if (!Number.isFinite(nowMonoMs)) return Number.POSITIVE_INFINITY
  const delay = frame.releaseAtMonoMs - nowMonoMs
  if (!(delay > 0)) {
    throw new Error(
      'planVeilTimer: a held frame must release in the future (releaseAt=' +
      String(frame.releaseAtMonoMs) + ', now=' + String(nowMonoMs) + ')',
    )
  }
  return delay
}

/**
 * Decide the visible frame. Total function: every input combination returns a mode, a
 * coverage state, an actions flag and an absolute release moment.
 *
 * Precedence (highest first): failure overlay, contents when the surface says so,
 * deferred, then the boot-veil ladder. The surface can only RELEASE - it never invents
 * a hold. Past their bounds hero/settling turn `actionable` and absent/unknown
 * `released`; a deferred source is `actionable` immediately; an unanchored or
 * rolled-back clock HOLDs with a finite future deadline rather than releasing or
 * re-arming at 0 ms.
 */
export function decidePresentation(
  facts: PresentationFacts,
  thresholds: PresentationThresholds,
): PresentationFrame {
  const safe = usableThresholds(thresholds)
  if (facts.failureOverlayVisible) {
    return releasedFrame('failure', false, facts.nowMs)
  }

  if (!facts.settled) {
    if (facts.bootDeferred) {
      // No tenant exists to cover: the connect face with its action IS the exit.
      return actionableFrame('deferred', facts.nowMs)
    }
    const waitedMs = normalizeAt(facts.waitedMs)
    if (waitedMs < safe.veilActionsAfterMs) {
      const releaseAt = anchorOf(facts.nowMs) + Math.max(1, safe.veilActionsAfterMs - waitedMs)
      return heldFrame('loading', false, releaseAt)
    }
    return actionableFrame('loading-stuck', facts.nowMs)
  }

  // Settled: the only reason to keep the veil is an open intent not on screen yet.
  if (!facts.holdForOpenIntent) {
    return releasedFrame('contents', false, facts.nowMs)
  }
  const phase = facts.surfacePhase
  if (phase === null) {
    // No observation yet: hold with a finite outer deadline rather than a 0 ms re-arm -
    // an unanchored clock must never keep the veil forever.
    return heldFrame('loading', false, anchorOf(facts.nowMs) + safe.surfaceMaxHoldMs)
  }
  if (phase === 'active') {
    return releasedFrame('contents', false, facts.nowMs)
  }
  const bound = surfaceBoundMs(phase, safe)
  const base = phase === 'absent' || phase === 'unknown'
    ? (facts.absentSinceMs ?? facts.holdStartedAtMs)
    : facts.holdStartedAtMs
  const elapsed = elapsedSince(base, facts.nowMs)
  if (elapsed === null) {
    // Clock not anchored or rolled back: hold with a finite future deadline (never a 0 ms re-arm).
    return heldFrame('loading', false, anchorOf(facts.nowMs) + bound)
  }
  if (elapsed >= bound) {
    return phase === 'absent' || phase === 'unknown'
      ? releasedFrame('contents', false, facts.nowMs)
      : actionableFrame('loading-stuck', facts.nowMs)
  }
  return heldFrame('loading', false, anchorOf(facts.nowMs) + (bound - elapsed))
}

/** Upper bound of the veil for one attempt: the threshold table plus the two caller-owned
 * budgets - the single answer to "how long can the user be parked". */
export function veilUpperBoundMs(thresholds: PresentationThresholds, extra: {
  readonly bootTimeoutMs: number
  readonly reclaimSweepMs: number
}): number {
  const surfaceWorst = Math.max(thresholds.surfaceMaxHoldMs, thresholds.surfaceAbsentFallbackMs)
  return extra.bootTimeoutMs + extra.reclaimSweepMs + Math.max(surfaceWorst, thresholds.veilActionsAfterMs)
}
