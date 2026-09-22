/**
 * Presentation arbiter (B3 core) - behavior contract.
 *
 * Each test pins one rule that used to live in a different file's timer. The last
 * test is the one the refactor plan calls G4: there is NO input combination in which
 * the veil has no deadline. P2 restated the frame as an ABSOLUTE release moment
 * (\`veil\` + \`releaseAtMonoMs\`), so the same property is now asserted directly:
 * every frame carries a finite release moment, and a held frame is always in the
 * future (never a 0 ms re-arm).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  decidePresentation,
  planVeilTimer,
  surfaceBoundMs,
  veilUpperBoundMs,
} from '../../src/presentation.ts'
import type { PresentationFacts, PresentationThresholds } from '../../src/presentation.ts'

// Production thresholds (now the shared table's presentation section). The reducer
// takes them as data so this file can exercise the boundaries.
const TH: PresentationThresholds = {
  veilActionsAfterMs: 10000,
  surfaceMaxHoldMs: 70000,
  surfaceAbsentFallbackMs: 2000,
}

function facts(overrides: Partial<PresentationFacts> = {}): PresentationFacts {
  return {
    settled: false,
    bootDeferred: false,
    waitedMs: 0,
    holdForOpenIntent: false,
    surfacePhase: null,
    holdStartedAtMs: null,
    absentSinceMs: null,
    nowMs: 0,
    failureOverlayVisible: false,
    ...overrides,
  }
}

test('the failure overlay outranks everything, including a held veil', () => {
  const frame = decidePresentation(facts({
    failureOverlayVisible: true,
    settled: false,
    waitedMs: 999999,
    holdForOpenIntent: true,
    surfacePhase: 'hero',
  }), TH)
  assert.deepEqual(frame, { mode: 'failure', veil: 'released', actions: false, releaseAtMonoMs: 0 })
})

test('a deferred source is actionable immediately (no 10s wait)', () => {
  const frame = decidePresentation(facts({ bootDeferred: true }), TH)
  assert.equal(frame.mode, 'deferred')
  assert.equal(frame.actions, true)
  assert.equal(frame.veil, 'actionable')
  assert.equal(frame.releaseAtMonoMs, 0)
})

test('the boot veil upgrades to actions exactly at the feedback window', () => {
  const early = decidePresentation(facts({ waitedMs: 9999 }), TH)
  assert.equal(early.mode, 'loading')
  assert.equal(early.actions, false)
  assert.equal(early.veil, 'held')
  assert.equal(early.releaseAtMonoMs, 1, 'the held deadline is the remaining feedback window')
  assert.equal(planVeilTimer(early, 0), 1)
  const late = decidePresentation(facts({ waitedMs: 10000 }), TH)
  assert.equal(late.mode, 'loading-stuck')
  assert.equal(late.actions, true)
  assert.equal(late.veil, 'actionable', 'past the feedback window the boot face is the exit, not an opaque hold')
})

test('a settled shell with no open intent shows contents', () => {
  const frame = decidePresentation(facts({ settled: true, holdForOpenIntent: false }), TH)
  assert.deepEqual(frame, { mode: 'contents', veil: 'released', actions: false, releaseAtMonoMs: 0 })
})

test('an active surface releases the veil immediately', () => {
  const frame = decidePresentation(facts({
    settled: true,
    holdForOpenIntent: true,
    surfacePhase: 'active',
    holdStartedAtMs: 0,
    nowMs: 1,
  }), TH)
  assert.equal(frame.mode, 'contents')
  assert.equal(frame.veil, 'released')
})

test('hero and settling are bounded by the outer hold, not the absent fallback', () => {
  assert.equal(surfaceBoundMs('hero', TH), 70000)
  assert.equal(surfaceBoundMs('settling', TH), 70000)
  assert.equal(surfaceBoundMs('absent', TH), 2000)
  // The version-skew case: a phase this build cannot read shares the SHORT bound.
  assert.equal(surfaceBoundMs('unknown', TH), 2000)
  assert.equal(surfaceBoundMs('active', TH), 0)
})

test('an unreadable phase no longer holds for the hero bound (the P4 fix)', () => {
  // Before B3, readSessionSurfacePhase folded an unknown attribute into 'hero', so a
  // version-skewed anchor parked the user on the veil for the full 70s outer bound.
  const at1999 = decidePresentation(facts({
    settled: true,
    holdForOpenIntent: true,
    surfacePhase: 'unknown',
    holdStartedAtMs: 0,
    nowMs: 1999,
  }), TH)
  assert.equal(at1999.mode, 'loading', 'still holding inside the fallback window')
  assert.equal(at1999.veil, 'held')
  assert.equal(at1999.releaseAtMonoMs, 2000)
  const at2000 = decidePresentation(facts({
    settled: true,
    holdForOpenIntent: true,
    surfacePhase: 'unknown',
    holdStartedAtMs: 0,
    nowMs: 2000,
  }), TH)
  assert.equal(at2000.mode, 'contents', 'released at the fallback bound, not at 70s')
  assert.equal(at2000.veil, 'released')
})

test('hero past the outer bound becomes actionable and reveals the tenant', () => {
  const frame = decidePresentation(facts({
    settled: true,
    holdForOpenIntent: true,
    surfacePhase: 'hero',
    holdStartedAtMs: 0,
    nowMs: 70000,
  }), TH)
  assert.equal(frame.mode, 'loading-stuck')
  assert.equal(frame.actions, true)
  assert.equal(frame.veil, 'actionable', 'the b73bce74 70s reveal: the exit is offered, the tenant is not left covered')
  assert.equal(frame.releaseAtMonoMs, 70000)
  assert.equal(planVeilTimer(frame, 70000), 0, 'an actionable frame needs no timer')
})

test('absent uses its own streak start, so a one-frame disappearance cannot reset the hold', () => {
  // The root vanished at t=60000 after a long hold: the absent window must start
  // there, not at the hold start (session-surface.ts MINOR-1's rule).
  const frame = decidePresentation(facts({
    settled: true,
    holdForOpenIntent: true,
    surfacePhase: 'absent',
    holdStartedAtMs: 0,
    absentSinceMs: 60000,
    nowMs: 61000,
  }), TH)
  assert.equal(frame.mode, 'loading', 'inside the absent fallback measured from the streak')
  assert.equal(frame.veil, 'held')
  assert.equal(frame.releaseAtMonoMs, 62000)
  assert.equal(planVeilTimer(frame, 61000), 1000)
})

test('an unanchored clock holds with a finite future deadline instead of a 0 ms re-arm', () => {
  const frame = decidePresentation(facts({
    settled: true,
    holdForOpenIntent: true,
    surfacePhase: 'hero',
    holdStartedAtMs: null,
    nowMs: 5000,
  }), TH)
  assert.equal(frame.veil, 'held')
  assert.equal(frame.releaseAtMonoMs, 75000, 'the outer bound measured from the evaluation moment')
  assert.equal(planVeilTimer(frame, 5000), 70000)
})

test('a clock rollback never releases the veil', () => {
  const frame = decidePresentation(facts({
    settled: true,
    holdForOpenIntent: true,
    surfacePhase: 'hero',
    holdStartedAtMs: 10000,
    nowMs: 5000,
  }), TH)
  assert.equal(frame.veil, 'held')
  assert.equal(frame.mode, 'loading')
  assert.equal(frame.releaseAtMonoMs, 75000)
})

test('the phase to bound mapping is total and lives here (one copy)', () => {
  // Ported from the renderer's session-surface test when the renderer stopped owning
  // this mapping (B3 step 3): each phase has a bound, and only absent/unknown take the
  // short fallback. A phase this build cannot name shares the absent bound ON PURPOSE.
  assert.equal(surfaceBoundMs('absent', TH), TH.surfaceAbsentFallbackMs)
  assert.equal(surfaceBoundMs('unknown', TH), TH.surfaceAbsentFallbackMs)
  assert.equal(surfaceBoundMs('hero', TH), TH.surfaceMaxHoldMs)
  assert.equal(surfaceBoundMs('settling', TH), TH.surfaceMaxHoldMs)
  assert.equal(surfaceBoundMs('active', TH), 0, 'active releases immediately')
})

test('the absent boundary is INCLUSIVE, and hero/settling never use the 2s window', () => {
  // Ported from the retired shouldReleaseVeilForSurface truth table: the degraded
  // absent shape must not hang the veil past its bound, while hero/settling must NOT
  // release at 2s (their window is the outer hold, not the absent fallback).
  const start = 5_000
  const at = (phase: 'absent' | 'hero' | 'settling', nowMs: number) => decidePresentation(facts({
    settled: true,
    holdForOpenIntent: true,
    surfacePhase: phase,
    holdStartedAtMs: start,
    absentSinceMs: start,
    nowMs,
  }), TH)
  assert.equal(at('absent', start + 1_999).veil, 'held', 'inside the bound: hold')
  assert.equal(at('absent', start + 2_000).veil, 'released', 'boundary is inclusive: release')
  for (const phase of ['hero', 'settling'] as const) {
    assert.equal(at(phase, start + 2_000).veil, 'held', phase + ': the 2s window is not its bound')
    assert.equal(at(phase, start + 69_999).veil, 'held', phase + ': still inside the outer hold')
    const past = at(phase, start + 70_000)
    assert.equal(past.mode, 'loading-stuck', phase + ': the outer hold is the bounded exit')
    assert.equal(past.veil, 'actionable', phase + ': releasing the hold reveals the tenant')
  }
})

test('G4: the veil bound is computable and within the 155s goal', () => {
  const bound = veilUpperBoundMs(TH, { bootTimeoutMs: 60000, reclaimSweepMs: 20000 })
  assert.equal(bound, 150000, '60s boot + 20s sweep + max(70s surface, 10s feedback)')
  assert.ok(bound <= 155000, 'the goal invariant: no unbounded spinner')
  // Every phase has a finite bound, so no phase can wait forever by construction.
  for (const phase of ['absent', 'hero', 'settling', 'active', 'unknown'] as const) {
    const each = surfaceBoundMs(phase, TH)
    assert.ok(Number.isFinite(each), 'phase ' + phase + ' must have a finite bound')
  }
})

test('planVeilTimer refuses a fabricated held frame at or before now', () => {
  const held = decidePresentation(facts({ settled: true, holdForOpenIntent: true, surfacePhase: 'hero', holdStartedAtMs: 0, nowMs: 1 }), TH)
  assert.equal(held.veil, 'held')
  assert.throws(() => planVeilTimer({ ...held, releaseAtMonoMs: 1 }, 1), /held/i)
  assert.throws(() => planVeilTimer({ ...held, releaseAtMonoMs: Number.NaN }, 1), /finite/i)
  assert.equal(planVeilTimer(held, Number.NaN), Number.POSITIVE_INFINITY, 'a broken clock holds, it never arms 0 ms')
})

test('every frame has a finite release moment, and every held frame releases in the future', () => {
  // The no-exitless-spinner property over the whole input space, restated on the
  // absolute deadline.
  for (const settled of [false, true]) {
    for (const phase of [null, 'absent', 'hero', 'settling', 'active', 'unknown'] as const) {
      for (const hold of [false, true]) {
        const frame = decidePresentation(facts({
          settled,
          holdForOpenIntent: hold,
          surfacePhase: phase,
          holdStartedAtMs: 0,
          nowMs: 1,
        }), TH)
        assert.ok(
          Number.isFinite(frame.releaseAtMonoMs),
          'release moment is not finite: settled=' + String(settled) + ' phase=' + String(phase) + ' hold=' + String(hold),
        )
        if (frame.veil === 'held') {
          assert.ok(
            planVeilTimer(frame, 1) > 0,
            'held frame with a 0 ms re-arm: settled=' + String(settled) + ' phase=' + String(phase) + ' hold=' + String(hold),
          )
          assert.ok(frame.releaseAtMonoMs > 1, 'held frames must release in the future')
        }
      }
    }
  }
})
