/**
 * Behavioural coverage for the chip's VISIBLE recovery surface (design 14 §D4).
 *
 * WHY THIS FILE EXISTS. The chip is a React component and this package has no
 * React/DOM test environment, so the component cannot be driven here; its
 * decisions live in the pure `session-stream-health-chip-face.ts` the component
 * projects, and this suite drives that module directly — source-text locks alone
 * would leave behaviour-reversing mutations (a notice rendered as nothing, a
 * label that ignores the notice, a ticker that stops re-planning, a `setPlan`
 * that never de-duplicates) green.
 *
 * The manual reload/rebuild controls were retired (user ruling: upstream has no
 * such control), so the face is a two-field REPORT (label + marker) and this
 * suite pins that it has no action surface at all.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  sameSessionStreamHealthPlan,
  sessionStreamHealthChipFace,
  sessionStreamHealthChipHoldsTick,
} from '../../src/client/session-stream-health-chip-face.ts'
import {
  createSessionStreamHealthState,
  type SessionOpenState,
  type SessionStreamHealthPlan,
  type SessionStreamNotice,
  type SessionStreamPhase,
} from '../../src/client/session-stream-health.ts'

/** One plan with an explicit phase/action/notice over the idle state's clocks. */
function planOf(
  phase: SessionStreamPhase,
  action: SessionStreamHealthPlan['action'],
  notice: SessionStreamNotice | null,
): SessionStreamHealthPlan {
  return { state: { ...createSessionStreamHealthState(), phase }, action, notice }
}

const OPEN_STATES: readonly SessionOpenState[] = ['cold', 'loading', 'open', 'error']
const NOTICES: readonly SessionStreamNotice[] = ['loading-stall', 'loading-failed', 'heal-failed']

test('an idle ladder renders nothing, whatever the open state', () => {
  for (const openState of OPEN_STATES) {
    const face = sessionStreamHealthChipFace(planOf('idle', 'none', null), openState)
    assert.deepEqual(face, { label: null, marker: 'recovering' }, openState)
  }
})

test('every notice IS the label and the marker, and nothing else is rendered', () => {
  const faceOf = (notice: SessionStreamNotice, action: SessionStreamHealthPlan['action']) =>
    sessionStreamHealthChipFace(planOf('loading-hold', action, notice), 'loading')
  for (const notice of NOTICES) {
    assert.deepEqual(
      faceOf(notice, 'none'),
      { label: notice, marker: notice },
      'the visible surface is exactly the notice',
    )
  }
})

test('the face never depends on the plan action (no user control exists)', () => {
  for (const action of ['none', 'heal'] as const) {
    assert.deepEqual(
      sessionStreamHealthChipFace(planOf('loading-hold', action, 'loading-stall'), 'loading'),
      { label: 'loading-stall', marker: 'loading-stall' },
      action,
    )
  }
})

test('a recovery in flight shows the healing label', () => {
  assert.deepEqual(
    sessionStreamHealthChipFace(planOf('healing', 'heal', null), 'open'),
    { label: 'healing', marker: 'recovering' },
  )
  // The error arm's grace/retry hold is the same visible state ...
  assert.equal(sessionStreamHealthChipFace(planOf('error-hold', 'heal', null), 'error').label, 'healing')
  // ... but an error-hold the vendor already left is not a recovery: nothing
  // renders, rather than a stale "recovering…" line over a healthy session.
  assert.equal(sessionStreamHealthChipFace(planOf('error-hold', 'heal', null), 'open').label, null)
})

test('the ticker holds while an arm, a non-open stream or a notice needs re-planning', () => {
  const holds = (plan: SessionStreamHealthPlan, openState: SessionOpenState, visible = true): boolean =>
    sessionStreamHealthChipHoldsTick(plan, openState, visible)
  assert.equal(holds(planOf('idle', 'none', null), 'open'), false, 'an open session is quiet')
  assert.equal(holds(planOf('idle', 'none', null), 'cold'), false, 'a cold session is quiet')
  assert.equal(holds(planOf('idle', 'none', null), 'loading'), true, 'a waiting open must keep planning')
  assert.equal(holds(planOf('idle', 'none', null), 'error'), true, 'an error must keep planning')
  assert.equal(holds(planOf('healing', 'heal', null), 'open'), true, 'an executed arm must settle on the clock')
  assert.equal(holds(planOf('idle', 'none', 'loading-stall'), 'open', false), false, 'a hidden page stops the clock')
})

test('a re-plan is skipped exactly when the visible surface is unchanged', () => {
  const base = planOf('loading-hold', 'none', 'loading-stall')
  assert.equal(
    sameSessionStreamHealthPlan(base, { ...base, state: { ...base.state, since: 99_999 } }),
    true,
    'the clock alone must not re-render the same surface',
  )
  assert.equal(sameSessionStreamHealthPlan(base, planOf('loading-hold', 'heal', 'loading-stall')), true,
    'an action change the chip never renders must not re-render it')
  assert.equal(sameSessionStreamHealthPlan(base, planOf('loading-hold', 'none', 'loading-failed')), false)
  assert.equal(sameSessionStreamHealthPlan(base, planOf('healing', 'none', 'loading-stall')), false)
})
