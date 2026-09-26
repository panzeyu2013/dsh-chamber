/**
 * Veil release gate (G-E) - a held veil always has an absolute deadline.
 *
 * WHY. The old arbiter answered 'how long until re-evaluation' and several paths
 * returned 0 while the veil was still visible: the caller re-armed immediately, the
 * tenant stayed hidden, and nothing in the code said when it would ever be shown.
 * The contract is now expressed as an ABSOLUTE monotonic release time on the frame:
 * a released frame reveals, an actionable frame offers the user an exit, and a held
 * frame must carry a finite releaseAtMonoMs strictly in the future. planVeilTimer
 * is the only translator from that absolute deadline to a timer delay, and it
 * refuses to arm a zero-delay timer for a held frame.
 *
 * G4 (the refactor plan's total-bound test) lives in presentation-arbiter.test.ts;
 * this file is the release-deadline half.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  decidePresentation,
  planVeilTimer,
  type PresentationFacts,
  type PresentationFrame,
  type PresentationThresholds,
} from '../../src/presentation.ts'

const THRESHOLDS: PresentationThresholds = {
  veilActionsAfterMs: 10_000,
  surfaceMaxHoldMs: 70_000,
  surfaceAbsentFallbackMs: 2_000,
}

function facts(overrides: Partial<PresentationFacts>): PresentationFacts {
  return {
    settled: true,
    bootDeferred: false,
    waitedMs: 0,
    holdForOpenIntent: true,
    surfacePhase: 'hero',
    holdStartedAtMs: 1_000,
    absentSinceMs: null,
    nowMs: 10_000,
    failureOverlayVisible: false,
    ...overrides,
  }
}

function heldScenarios(): Array<{ name: string; frame: PresentationFrame; now: number }> {
  return [
    { name: 'boot progress', frame: decidePresentation(facts({ settled: false, waitedMs: 0 }), THRESHOLDS), now: 10_000 },
    { name: 'hero inside its bound', frame: decidePresentation(facts({ nowMs: 10_000 }), THRESHOLDS), now: 10_000 },
    { name: 'settling inside its bound', frame: decidePresentation(facts({ surfacePhase: 'settling', nowMs: 10_000 }), THRESHOLDS), now: 10_000 },
    { name: 'absent inside its fallback', frame: decidePresentation(facts({ surfacePhase: 'absent', holdStartedAtMs: 9_500, absentSinceMs: 9_500, nowMs: 10_000 }), THRESHOLDS), now: 10_000 },
    {
      name: 'unanchored clock',
      frame: decidePresentation(facts({ surfacePhase: 'hero', holdStartedAtMs: null, nowMs: Number.NaN }), THRESHOLDS),
      now: 10_000,
    },
  ]
}

test('every held frame carries a finite absolute release deadline', () => {
  for (const scenario of heldScenarios()) {
    assert.equal(scenario.frame.veil, 'held', scenario.name + ' must be held')
    assert.ok(
      Number.isFinite(scenario.frame.releaseAtMonoMs),
      scenario.name + ': a held frame must have a finite releaseAtMonoMs',
    )
    assert.ok(
      scenario.frame.releaseAtMonoMs > scenario.now,
      scenario.name + ': a held frame must release in the future, not now',
    )
  }
})

test('planVeilTimer refuses to arm a zero-delay timer for a held frame', () => {
  for (const scenario of heldScenarios()) {
    const delay = planVeilTimer(scenario.frame, scenario.now)
    assert.ok(typeof delay === 'number' && delay > 0, scenario.name + ': a held frame must arm a positive timer, never a 0 ms one')
    assert.equal(delay, scenario.frame.releaseAtMonoMs - scenario.now, scenario.name + ': the delay must be the distance to the deadline')
  }
  const held = heldScenarios()[1].frame
  assert.throws(() => planVeilTimer({ ...held, releaseAtMonoMs: 10_000 }, 10_000), /held/i, 'a fabricated held frame at 0 ms must be rejected')
  assert.throws(() => planVeilTimer({ ...held, releaseAtMonoMs: Number.NaN }, 10_000), /held|finite/i, 'a held frame with a NaN deadline must be rejected')
})

test('hero and settling past the outer bound become actionable, not silently held', () => {
  for (const phase of ['hero', 'settling'] as const) {
    const frame = decidePresentation(
      facts({ surfacePhase: phase, holdStartedAtMs: 1_000, nowMs: 1_000 + THRESHOLDS.surfaceMaxHoldMs }),
      THRESHOLDS,
    )
    assert.equal(frame.veil, 'actionable', phase + ' at its bound must offer an exit')
    assert.equal(frame.actions, true, phase + ' at its bound must expose actions')
    assert.ok(Number.isFinite(frame.releaseAtMonoMs))
    assert.equal(planVeilTimer(frame, frame.releaseAtMonoMs), null, 'an actionable frame arms no timer')
  }
})

test('absent and unknown release at the fallback, active releases immediately', () => {
  for (const phase of ['absent', 'unknown'] as const) {
    const frame = decidePresentation(
      facts({ surfacePhase: phase, holdStartedAtMs: 1_000, absentSinceMs: 1_000, nowMs: 1_000 + THRESHOLDS.surfaceAbsentFallbackMs }),
      THRESHOLDS,
    )
    assert.equal(frame.veil, 'released', phase + ' at its fallback must reveal the tenant')
    assert.ok(Number.isFinite(frame.releaseAtMonoMs), phase + ' released frame must still carry a finite stamp')
  }
  assert.equal(decidePresentation(facts({ surfacePhase: 'active' }), THRESHOLDS).veil, 'released')
  assert.equal(decidePresentation(facts({ holdForOpenIntent: false }), THRESHOLDS).veil, 'released')
  assert.equal(decidePresentation(facts({ failureOverlayVisible: true }), THRESHOLDS).veil, 'released')
  assert.equal(decidePresentation(facts({ bootDeferred: true, settled: false }), THRESHOLDS).veil, 'actionable')
})
