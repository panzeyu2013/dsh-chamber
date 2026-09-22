/**
 * Source lifecycle reducer - behavior contract.
 *
 * Each test here
 * pins one rule that would otherwise live as a call site comment in App.tsx or
 * use-view-scheduler.ts, so a future edit has to argue with a failing test instead
 * of with a comment nobody reads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initialSourceLifecycle, reduceSource, reduceSourceSequence } from '../../src/source.ts'
import type { SourceEnv, SourceLifecycleState } from '../../src/source.ts'

const INC = { sourceId: 'remote-a', fingerprint: 'fp-1' }
const env: SourceEnv = { reclaimGraceMs: 60000, retryableGap: (kind) => kind !== 'not-injected' }

function settled(outcome: 'booted' | 'degraded' | 'failed', gapKind?: string): SourceLifecycleState {
  return reduceSource(initialSourceLifecycle(INC), {
    kind: 'bootSettled',
    outcome,
    ...(gapKind === undefined ? {} : { gapKind }),
  }, env).state
}

test('mount and unmount track the hidden window', () => {
  const mounted = reduceSource(initialSourceLifecycle(INC), { kind: 'mounted', at: 100 }, env)
  assert.equal(mounted.state.mounted, true)
  assert.equal(mounted.state.hiddenSince, null)
  const hidden = reduceSource(mounted.state, { kind: 'hidden', at: 5000 }, env)
  assert.equal(hidden.state.hiddenSince, 5000)
})

test('a degraded, retryable, ready mount earns exactly one self-heal', () => {
  const ready = reduceSource(settled('degraded', 'graph-unavailable'), { kind: 'phaseChanged', phase: 'ready' }, env)
  const healed = reduceSource(ready.state, { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' }, env)
  assert.equal(healed.state.degradedRetried, true)
  assert.deepEqual(healed.effects, [{ e: 'degradedSelfHeal' }])
  // Once per ready epoch: a second degraded settle does NOT heal again.
  const again = reduceSource(healed.state, { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' }, env)
  assert.deepEqual(again.effects, [])
})

test('a non-retryable gap never earns a self-heal and never marks', () => {
  const ready = reduceSource(settled('degraded', 'not-injected'), { kind: 'phaseChanged', phase: 'ready' }, env)
  const again = reduceSource(ready.state, { kind: 'bootSettled', outcome: 'degraded', gapKind: 'not-injected' }, env)
  assert.deepEqual(again.effects, [])
  assert.equal(again.state.degradedRetried, false)
})

test('leaving ready drops the self-heal mark so a later ready transition earns a fresh attempt', () => {
  const ready = reduceSource(settled('degraded', 'graph-unavailable'), { kind: 'phaseChanged', phase: 'ready' }, env)
  const healed = reduceSource(ready.state, { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' }, env)
  assert.equal(healed.state.degradedRetried, true)
  const left = reduceSource(healed.state, { kind: 'phaseChanged', phase: 'error' }, env)
  assert.equal(left.state.degradedRetried, false)
})

test('a degraded mount that is not ready yet never heals (the ready transition earns it)', () => {
  const notReady = settled('degraded', 'graph-unavailable')
  const attempt = reduceSource(notReady, { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' }, env)
  assert.deepEqual(attempt.effects, [])
})

test('retention reclaims only inside the grace window and only after a settle', () => {
  const mounted = reduceSource(initialSourceLifecycle(INC), { kind: 'mounted', at: 0 }, env)
  // Never settled: the absolute-abandon arm in the App owns this shape.
  const early = reduceSource(mounted.state, { kind: 'reclaimed', at: 100000 }, env)
  assert.deepEqual(early.effects, [])
  const hidden = reduceSourceSequence(mounted.state, [
    { kind: 'bootSettled', outcome: 'booted' },
    { kind: 'unmounted', at: 1000 },
  ], env)
  // Inside the grace: no reclaim.
  assert.deepEqual(reduceSource(hidden.state, { kind: 'reclaimed', at: 30000 }, env).effects, [])
  // Past the grace: reclaim, and the shell teardown is the effect.
  const due = reduceSource(hidden.state, { kind: 'reclaimed', at: 70000 }, env)
  assert.deepEqual(due.effects, [{ e: 'reclaim' }])
  assert.equal(due.state.boot, null)
})

test('a reclaimed incarnation refuses auto-prewarm until a user act clears it', () => {
  const hidden = reduceSourceSequence(initialSourceLifecycle(INC), [
    { kind: 'mounted', at: 0 },
    { kind: 'bootSettled', outcome: 'booted' },
    { kind: 'unmounted', at: 1000 },
    { kind: 'reclaimed', at: 70000 },
  ], env)
  assert.equal(hidden.state.prewarmSuppressed, true)
  // A user selection clears the suppression AND abandons nothing.
  const selected = reduceSource(hidden.state, { kind: 'userSelected', at: 80000 }, env)
  assert.equal(selected.state.prewarmSuppressed, false)
  assert.deepEqual(selected.effects, [{ e: 'mount', reason: 'user' }])
})

test('the reclaim/self-heal interaction is a bounded count, not a loop', () => {
  // The nuance this reducer makes data: reclaiming a degraded mount DOES forget
  // the mark (a fresh mount is a new boot - FIX 5's own reason), so each reclaim
  // cycle may earn one self-heal. What must never happen is a self-heal that
  // reclaims itself: reclaim requires settled+hidden, self-heal requires ready+mark.
  let state = reduceSourceSequence(initialSourceLifecycle(INC), [
    { kind: 'mounted', at: 0 },
    { kind: 'phaseChanged', phase: 'ready' },
    { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' },
  ], env).state
  assert.equal(state.degradedRetried, true)
  // Cycle 1: hide, reclaim, re-mount as a NEW mount. The mark was dropped by the
  // reclaim, so the next degraded settle earns one self-heal again.
  const hidden = reduceSource(state, { kind: 'unmounted', at: 1000 }, env)
  const reclaimed = reduceSource(hidden.state, { kind: 'reclaimed', at: 70000 }, env)
  assert.deepEqual(reclaimed.effects, [{ e: 'reclaim' }])
  const remounted = reduceSource(reclaimed.state, { kind: 'mounted', at: 80000 }, env)
  const settledAgain = reduceSource(remounted.state, { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' }, env)
  assert.deepEqual(settledAgain.effects, [{ e: 'degradedSelfHeal' }])
  // TWO self-heals so far: one on the first mount, one after the reclaim/remount.
  // The count living in the same object is the point - the old layout kept the mark
  // in one ref and the retry counter in another, so "how many times did we re-boot
  // this source" was not answerable anywhere.
  assert.equal(settledAgain.state.retryToken, 2, 'both self-heals are counted')
})

test('harvest bookkeeping is bounded and satisfaction is terminal for the epoch', () => {
  const started = reduceSource(initialSourceLifecycle(INC), { kind: 'harvestStarted', at: 1000, backoffMs: 120000 }, env)
  assert.equal(started.state.harvest?.attempts, 1)
  assert.equal(started.state.autoPrewarmed, true)
  assert.deepEqual(started.effects, [{ e: 'mount', reason: 'harvest' }])
  const second = reduceSource(started.state, { kind: 'harvestStarted', at: 2000, backoffMs: 120000 }, env)
  assert.equal(second.state.harvest?.attempts, 2)
  const satisfied = reduceSource(second.state, { kind: 'harvestSatisfied' }, env)
  assert.equal(satisfied.state.harvest?.satisfied, true)
})

test('being painted clears the hidden window and the prewarm suppression', () => {
  const hidden = reduceSourceSequence(initialSourceLifecycle(INC), [
    { kind: 'mounted', at: 0 },
    { kind: 'bootSettled', outcome: 'booted' },
    { kind: 'unmounted', at: 1000 },
    { kind: 'reclaimed', at: 70000 },
    { kind: 'mounted', at: 80000 },
    { kind: 'hidden', at: 90000 },
  ], env)
  const painted = reduceSource(hidden.state, { kind: 'painted', at: 95000 }, env)
  assert.equal(painted.state.hiddenSince, null)
  assert.equal(painted.state.prewarmSuppressed, false)
  assert.equal(painted.state.autoPrewarmed, false)
})

test('an unknown event kind is a total no-op', () => {
  const state = initialSourceLifecycle(INC)
  const r = reduceSource(state, { kind: 'nonsense' as never }, env)
  assert.equal(r.state, state)
  assert.deepEqual(r.effects, [])
})
