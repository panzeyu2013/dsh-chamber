/**
 * Veil release wiring (P2) - the renderer must never re-arm a held veil at 0 ms.
 *
 * The package's G-E test pins the arbiter's frame contract; this file pins the
 * WIRING that consumes it: the timer delay comes from the frame's absolute
 * releaseAtMonoMs through planVeilTimer, a held frame always yields a positive
 * delay, and the tenant's visibility is derived from the frame's held fact rather
 * than from a second conjunction in the component.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRESENTATION_THRESHOLDS, decidePresentation, planVeilTimer } from '@dsh-chamber/dsh-stream-state'
import type { PresentationFacts } from '@dsh-chamber/dsh-stream-state'

const HERE = dirname(fileURLToPath(import.meta.url))
const VIEW = readFileSync(join(HERE, '..', '..', 'src', 'components', 'InstanceView.tsx'), 'utf8')

function facts(overrides: Partial<PresentationFacts> = {}): PresentationFacts {
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

test('every held frame the renderer can receive has a positive timer', () => {
  const scenarios: PresentationFacts[] = [
    facts({ settled: false, waitedMs: 0 }),
    facts(),
    facts({ surfacePhase: 'settling' }),
    facts({ surfacePhase: 'absent', holdStartedAtMs: 9_500, absentSinceMs: 9_500 }),
    facts({ surfacePhase: 'unknown', holdStartedAtMs: 9_500, absentSinceMs: 9_500 }),
    facts({ surfacePhase: 'hero', holdStartedAtMs: null }),
    facts({ surfacePhase: 'hero', holdStartedAtMs: 20_000, nowMs: 10_000 }),
  ]
  for (const scenario of scenarios) {
    const frame = decidePresentation(scenario, PRESENTATION_THRESHOLDS)
    assert.equal(frame.veil, 'held', 'scenario must be held: ' + JSON.stringify(scenario))
    assert.ok(Number.isFinite(frame.releaseAtMonoMs), 'held frame needs a finite release moment')
    assert.equal(
      planVeilTimer(frame, frame.releaseAtMonoMs - 1),
      1,
      'the timer must be the distance to the absolute release moment',
    )
  }
})

test('the outer bound reveals the tenant (actionable) instead of re-arming at 0 ms', () => {
  for (const phase of ['hero', 'settling'] as const) {
    const frame = decidePresentation(
      facts({ surfacePhase: phase, holdStartedAtMs: 0, nowMs: PRESENTATION_THRESHOLDS.surfaceMaxHoldMs }),
      PRESENTATION_THRESHOLDS,
    )
    assert.equal(frame.veil, 'actionable', phase + ' at its bound must reveal the tenant')
    assert.equal(frame.actions, true, phase + ' at its bound must still offer the exit')
    assert.equal(planVeilTimer(frame, frame.releaseAtMonoMs), 0, phase + ' needs no timer once actionable')
  }
  const absent = decidePresentation(
    facts({ surfacePhase: 'absent', holdStartedAtMs: 0, absentSinceMs: 0, nowMs: PRESENTATION_THRESHOLDS.surfaceAbsentFallbackMs }),
    PRESENTATION_THRESHOLDS,
  )
  assert.equal(absent.veil, 'released', 'absent at its fallback reveals the shell')
})

test('a fabricated held frame at 0 ms is rejected, not covered up', () => {
  const held = decidePresentation(facts(), PRESENTATION_THRESHOLDS)
  assert.equal(held.veil, 'held')
  assert.throws(() => planVeilTimer({ ...held, releaseAtMonoMs: held.releaseAtMonoMs - 1 }, held.releaseAtMonoMs - 1))
  assert.throws(() => planVeilTimer({ ...held, releaseAtMonoMs: Number.NaN }, 0))
})

test('InstanceView arms the frame timer and derives shell visibility from the frame', () => {
  assert.ok(VIEW.includes("const veilHeld = presentation.veil === 'held'"), 'coverage must come from the frame')
  assert.ok(VIEW.includes('const shellHeld = settled && veilHeld'), 'the tenant is hidden only while held')
  assert.ok(VIEW.includes('const delay = planVeilTimer(presentation, frameNowMs)'), 'the delay must be planVeilTimer of the same frame')
  assert.match(
    VIEW,
    /const delay = planVeilTimer\(presentation, frameNowMs\)[\s\S]*?setTimeout\(/,
    'the planVeilTimer delay must be what setTimeout is armed with',
  )
  assert.equal(VIEW.includes('presentation.reevaluateInMs'), false, 'the old delay field must be gone')
  assert.equal(VIEW.includes('presentation.veilVisible'), false, 'the old visibility field must be gone')
  assert.equal(VIEW.includes('SURFACE_MAX_HOLD_MS'), false, 'the renderer must not keep a copy of the outer bound')
  assert.equal(VIEW.includes('VEIL_ACTIONS_AFTER_MS'), false, 'the renderer must not keep a copy of the feedback window')
})
