/**
 * Time discipline gate (G-B) - an unusable clock only ever holds, never releases.
 *
 * WHY. Every reducer here compares timestamps and durations. NaN makes all
 * comparisons false, which is exactly the shape that can SLIP THROUGH a guard and
 * release a protection: the ladder dispatched its most expensive tier when 'now'
 * was NaN, an Infinity SLA read as 'late', and 'withDeadline(ms: NaN)' armed a
 * zero-delay timer because setTimeout(NaN) fires immediately. A clock that cannot
 * be compared must degrade to conservative inaction (hold the protection), never
 * to an action and never to a 0 ms deadline.
 *
 * The fuzz matrix feeds NaN / +Inf / -Inf / rollback into every waiting decision
 * and asserts that the protection is still held and the deadline is still finite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decideRebuild, reduceCarrier } from '../../src/carrier.ts'
import { initialCarrierState } from '../../src/state.ts'
import { CARRIER_ENV } from '../../src/tables.ts'
import { planLadder, type Ladder } from '../../src/ladder.ts'
import { decidePresentation, type PresentationFacts, type PresentationThresholds } from '../../src/presentation.ts'
import { initialLoadState, loadIsLate, reduceLoadState, type LoadEnv } from '../../src/load-state.ts'
import { waitForCondition, withDeadline, type Scheduler } from '../../src/async-op.ts'

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]

const THRESHOLDS: PresentationThresholds = {
  veilActionsAfterMs: 10_000,
  surfaceMaxHoldMs: 70_000,
  surfaceAbsentFallbackMs: 2_000,
}

const LOAD_ENV: LoadEnv = { probeStrikeLimit: 3, retryLimit: 2, progressSlaMs: 15_000 }

const REAL_SCHEDULER: Scheduler = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
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
    nowMs: 0,
    failureOverlayVisible: false,
    ...overrides,
  }
}

test('a non-finite or rolled-back rebuild clock never authorizes a replacement', () => {
  for (const at of NON_FINITE) {
    assert.equal(decideRebuild(initialCarrierState(), CARRIER_ENV, at), false, 'decideRebuild(' + String(at) + ')')
    const r = reduceCarrier(
      initialCarrierState(),
      { kind: 'rebuildRequested', reason: 'laneReconnect', at, streamId: 's' },
      CARRIER_ENV,
    )
    assert.equal(r.effects.some((effect) => effect.e === 'rebuildCarrier'), false, 'rebuildCarrier at ' + String(at))
    assert.deepEqual(r.state, initialCarrierState(), 'the state must not move on an unusable clock')
  }
  const rolled = { ...initialCarrierState(), phase: 'open' as const, rebuildsAt: [10_000, 20_000] }
  assert.equal(decideRebuild(rolled, CARRIER_ENV, 500), false, 'a clock that went backwards must not rebuild')
})

test('a non-finite ladder clock never dispatches a tier', () => {
  const ladder: Ladder = {
    name: 'g-b',
    quotaWindowMs: 60_000,
    tiers: [{ name: 'probe', afterMs: 0, cooldownMs: 0, quota: 1, requiresStuckEvidence: false }],
  }
  const observation = { sticky: true, symptomSinceMs: 0, stuckEvidence: false, progressStamp: 0, escalationBlocked: false }
  for (const now of NON_FINITE) {
    const plan = planLadder(ladder, {}, { a: observation }, now)
    assert.deepEqual(plan.actions, [], 'planLadder(' + String(now) + ') dispatched ' + JSON.stringify(plan.actions))
  }
  const rolled = planLadder(ladder, {}, { a: observation }, -1)
  assert.deepEqual(rolled.actions, [], 'a clock that went backwards must not dispatch')
  const badSince = planLadder(ladder, {}, { a: { ...observation, symptomSinceMs: Number.NaN } }, 10_000)
  assert.deepEqual(badSince.actions, [], 'a non-finite symptom anchor must not dispatch')
})

test('a non-finite presentation clock holds the veil with a finite deadline', () => {
  for (const nowMs of NON_FINITE) {
    const frame = decidePresentation(facts({ nowMs }), THRESHOLDS)
    assert.equal(frame.veilVisible, true, 'the veil must hold at now=' + String(nowMs))
    assert.notEqual(frame.mode, 'contents', 'an unusable clock must not reveal the tenant')
  }
  const rolled = decidePresentation(facts({ nowMs: 500 }), THRESHOLDS)
  assert.equal(rolled.veilVisible, true, 'a clock that went backwards must hold the veil')
  const nanWait = decidePresentation(facts({ settled: false, waitedMs: Number.NaN }), THRESHOLDS)
  assert.equal(nanWait.veilVisible, true)
  assert.ok(Number.isFinite(nanWait.reevaluateInMs), 'a held frame must carry a finite re-evaluation deadline')
})

test('loadIsLate is false on a non-finite, rolled-back or terminal clock', () => {
  let state = reduceLoadState(initialLoadState(), { kind: 'generationStarted', generation: 1, at: 0 }, LOAD_ENV).state
  state = reduceLoadState(state, { kind: 'loadStarted', generation: 1, at: 1_000 }, LOAD_ENV).state
  for (const now of NON_FINITE) {
    assert.equal(loadIsLate(state, now, LOAD_ENV), false, 'loadIsLate(' + String(now) + ')')
  }
  assert.equal(loadIsLate(state, 0, LOAD_ENV), false, 'a clock that went backwards must not read late')
  const loaded = reduceLoadState(state, { kind: 'contentAlive', generation: 1, at: 2_000 }, LOAD_ENV).state
  assert.equal(loadIsLate(loaded, Number.MAX_SAFE_INTEGER, LOAD_ENV), false, 'a settled shell is never late')
})

test('withDeadline never arms a timer for a non-finite or negative bound', async () => {
  for (const ms of [...NON_FINITE, -1]) {
    // The operation needs a real 20 ms head start: an immediately-resolved promise
    // wins any race regardless of the deadline, which would make this vacuous.
    const operation = new Promise<string>((resolve) => {
      setTimeout(() => resolve('value'), 20)
    })
    const result = await withDeadline(operation, {
      ms,
      onExpire: () => 'expired',
      scheduler: REAL_SCHEDULER,
    })
    assert.equal(result.settled, 'operation', 'withDeadline(ms: ' + String(ms) + ') must not expire immediately')
  }
})

test('a throwing onExpire settles the deadline instead of hanging', async () => {
  // The scheduler wrapper contains the throw so the test can observe the outcome
  // instead of crashing the runner; production must settle it internally.
  const guarding: Scheduler = {
    setTimeout: (run, ms) =>
      setTimeout(() => {
        try {
          run()
        } catch {
          /* the deadline never settles if the implementation lets this escape */
        }
      }, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const outcome = await Promise.race([
    withDeadline(new Promise<never>(() => {}), {
      ms: 1,
      onExpire: () => {
        throw new Error('boom')
      },
      scheduler: guarding,
    }).then(
      () => 'resolved',
      (error) => 'rejected:' + String(error),
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 500)),
  ])
  assert.equal(outcome, 'rejected:Error: boom', 'a throwing onExpire must reject the deadline, not park it')
})

test('waitForCondition rejects a non-finite poll or bound instead of hot-looping', () => {
  const calls: number[] = []
  const inert: Scheduler = {
    setTimeout: (_run, ms) => {
      calls.push(ms)
      return calls.length
    },
    clearTimeout: () => {},
  }
  assert.throws(
    () => {
      void waitForCondition({ pollMs: Number.NaN, boundMs: 1_000, scheduler: inert, isDone: () => false })
    },
    'a non-finite poll interval must be rejected loudly, never scheduled as 0 ms',
  )
  assert.throws(
    () => {
      void waitForCondition({ pollMs: 100, boundMs: Number.POSITIVE_INFINITY, scheduler: inert, isDone: () => false })
    },
    'a non-finite bound is not a deadline and must be rejected',
  )
  assert.deepEqual(calls, [], 'no timer may be armed before validation')
})
