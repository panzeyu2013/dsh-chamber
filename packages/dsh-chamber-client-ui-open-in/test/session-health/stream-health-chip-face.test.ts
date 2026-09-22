/**
 * Behavioural coverage for the chip's VISIBLE recovery surface (design 14 §D4).
 *
 * WHY THIS FILE EXISTS. The chip is a React component and this package has no
 * React/DOM test environment, so the component cannot be driven here; its
 * decisions live in the pure `session-stream-health-chip-face.ts` the component
 * projects, and this suite drives that module directly — source-text locks alone
 * would leave behaviour-reversing mutations (a notice rendered without its
 * reload control, an armed rebuild rendered with no button, a ticker that stops
 * re-planning, a `setPlan` that never de-duplicates) green.
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
const NOTICES: readonly SessionStreamNotice[] = ['loading-stall', 'loading-failed', 'heal-failed', 'carrier-churn']

test('an idle ladder renders nothing, whatever the open state', () => {
  for (const openState of OPEN_STATES) {
    const face = sessionStreamHealthChipFace(planOf('idle', 'none', null), openState)
    assert.equal(face.label, null, openState)
    assert.equal(face.reload, false, openState)
    assert.equal(face.resync, false, openState)
  }
})

test('every notice renders its own label, marker and action set', () => {
  const faceOf = (notice: SessionStreamNotice, action: SessionStreamHealthPlan['action']) =>
    sessionStreamHealthChipFace(planOf('loading-hold', action, notice), 'loading')
  for (const notice of NOTICES) {
    assert.equal(faceOf(notice, 'none').label, notice, 'the notice IS the label')
    assert.equal(faceOf(notice, 'none').marker, notice, 'and the published marker')
  }
  assert.deepEqual(faceOf('loading-stall', 'resync'), {
    label: 'loading-stall', reload: true, resync: true, marker: 'loading-stall',
  })
  // The automatic arm renders the SAME manual control: the user's exit must never
  // disappear behind a rebuild that is already running.
  assert.deepEqual(faceOf('loading-failed', 'auto-resync'), {
    label: 'loading-failed', reload: true, resync: true, marker: 'loading-failed',
  })
  assert.deepEqual(faceOf('heal-failed', 'none'), {
    label: 'heal-failed', reload: true, resync: false, marker: 'heal-failed',
  })
  // Churn is informational: no control may interrupt the reopen in flight.
  assert.deepEqual(faceOf('carrier-churn', 'none'), {
    label: 'carrier-churn', reload: false, resync: false, marker: 'carrier-churn',
  })
})

test('the rebuild control follows exactly the two executing actions', () => {
  for (const action of ['none', 'heal', 'resync', 'auto-resync'] as const) {
    const face = sessionStreamHealthChipFace(planOf('loading-hold', action, 'loading-stall'), 'loading')
    assert.equal(face.resync, action === 'resync' || action === 'auto-resync', action)
    assert.equal(face.reload, true, action)
  }
})

test('a recovery in flight shows the healing label with no controls', () => {
  assert.deepEqual(
    sessionStreamHealthChipFace(planOf('healing', 'heal', null), 'open'),
    { label: 'healing', reload: false, resync: false, marker: 'recovering' },
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
  assert.equal(holds(planOf('idle', 'none', 'carrier-churn'), 'open'), true, 'the churn notice expires from its own timestamp')
  assert.equal(holds(planOf('healing', 'heal', null), 'open'), true, 'an executed arm must settle on the clock')
  assert.equal(holds(planOf('idle', 'none', 'loading-stall'), 'open', false), false, 'a hidden page stops the clock')
})

test('a re-plan is skipped exactly when the visible surface is unchanged', () => {
  const base = planOf('loading-hold', 'resync', 'loading-stall')
  assert.equal(
    sameSessionStreamHealthPlan(base, { ...base, state: { ...base.state, since: 99_999 } }),
    true,
    'the clock alone must not re-render the same surface',
  )
  assert.equal(sameSessionStreamHealthPlan(base, planOf('loading-hold', 'auto-resync', 'loading-stall')), false)
  assert.equal(sameSessionStreamHealthPlan(base, planOf('loading-hold', 'resync', 'loading-failed')), false)
  assert.equal(sameSessionStreamHealthPlan(base, planOf('healing', 'resync', 'loading-stall')), false)
})
