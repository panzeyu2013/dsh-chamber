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
  // Painting closes the window; a later departure opens a NEW one from that departure
  // (the earlier start must never be reused).
  const painted = reduceSource(hidden.state, { kind: 'painted', at: 9000 }, env)
  assert.equal(painted.state.hiddenSince, null)
  const hiddenAgain = reduceSource(painted.state, { kind: 'hidden', at: 20_000 }, env)
  assert.equal(hiddenAgain.state.hiddenSince, 20_000)
  // A remount is a new mount: the window of the mount that ended must not leak into it.
  const remounted = reduceSource(hiddenAgain.state, { kind: 'mounted', at: 30_000 }, env)
  assert.equal(remounted.state.hiddenSince, null)
})

test('retryForgotten drops the self-heal mark and nothing else', () => {
  // The App's reclaimView forgets the degraded-retry mark; the container counterpart
  // must be equally narrow: a still-settled-degraded view keeps its boot outcome.
  const marked = reduceSourceSequence(initialSourceLifecycle(INC), [
    { kind: 'mounted', at: 0 },
    { kind: 'phaseChanged', phase: 'ready' },
    { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' },
  ], env)
  assert.equal(marked.state.degradedRetried, true, 'ready + retryable degraded settle sets the mark')
  const forgotten = reduceSource(marked.state, { kind: 'retryForgotten' }, env)
  assert.equal(forgotten.state.degradedRetried, false, 'the mark is gone')
  assert.deepEqual(forgotten.state.boot, marked.state.boot, 'the boot outcome is untouched')
  assert.equal(forgotten.state.mounted, marked.state.mounted)
})

test('a degraded, retryable mount earns exactly one self-heal, paid by the ready epoch', () => {
  // 结算时相位未到 ready（真实冷启动的常态）：不立即自愈，但把"待自愈"留成事实。
  const settledEarly = settled('degraded', 'graph-unavailable')
  assert.equal(settledEarly.healPending, true, 'the arm survives a settle that precedes ready')
  // ready 世代偿还它：一次 effect + 本世代已用标记。
  const ready = reduceSource(settledEarly, { kind: 'phaseChanged', phase: 'ready' }, env)
  assert.equal(ready.state.degradedRetried, true)
  assert.deepEqual(ready.effects, [{ e: 'degradedSelfHeal' }])
  // Once per ready epoch: a repeat settle does NOT heal again.
  const again = reduceSource(ready.state, { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' }, env)
  assert.deepEqual(again.effects, [])
  assert.equal(again.state.healPending, false)
})

test('a degraded, retryable mount that is ready at the settle still heals on the settle', () => {
  const readyAtSettle = reduceSource(settled('degraded', 'graph-unavailable'), { kind: 'phaseChanged', phase: 'ready' }, env)
  const healed = reduceSource(readyAtSettle.state, { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' }, env)
  assert.deepEqual(healed.effects, [], 'the ready transition already paid for this epoch')
  const fresh = reduceSourceSequence(initialSourceLifecycle(INC), [
    { kind: 'phaseChanged', phase: 'ready' },
    { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' },
  ], env)
  assert.deepEqual(fresh.effects, [{ e: 'degradedSelfHeal' }])
  assert.equal(fresh.state.degradedRetried, true)
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

test('an unready source never heals while it stays unready, and only a NEW settle re-arms it', () => {
  const notReady = settled('degraded', 'graph-unavailable')
  const attempt = reduceSource(notReady, { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' }, env)
  assert.deepEqual(attempt.effects, [], 'never heals while the source is unready')
  assert.equal(attempt.state.healPending, true)
  const leaving = reduceSource(attempt.state, { kind: 'phaseChanged', phase: 'starting' }, env)
  assert.deepEqual(leaving.effects, [])
  // 消费之后仅靠相位往返不再自愈（防止"每个 ready 都重挂一次"的松紧误读）。
  const ready = reduceSource(leaving.state, { kind: 'phaseChanged', phase: 'ready' }, env)
  assert.deepEqual(ready.effects, [{ e: 'degradedSelfHeal' }])
  const back = reduceSource(ready.state, { kind: 'phaseChanged', phase: 'starting' }, env)
  const readyAgain = reduceSource(back.state, { kind: 'phaseChanged', phase: 'ready' }, env)
  assert.deepEqual(readyAgain.effects, [], 'a consumed arm needs a new settle')
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
