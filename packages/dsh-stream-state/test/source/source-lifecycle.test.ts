/**
 * Source lifecycle reducer - behavior contract.
 *
 * Each test here pins one rule that would otherwise live as a call site comment in
 * App.tsx or use-view-scheduler.ts, so a future edit has to argue with a failing test
 * instead of with a comment nobody reads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initialSourceLifecycle, reduceSource, reduceSourceSequence } from '../../src/source.ts'
import type { SourceEnv, SourceLifecycleState } from '../../src/source.ts'

const INC = { sourceId: 'remote-a', fingerprint: 'fp-1' }
const env: SourceEnv = { retryableGap: (kind) => kind !== 'not-injected' }

function settled(outcome: 'booted' | 'degraded' | 'failed', gapKind?: string): SourceLifecycleState {
  return reduceSource(initialSourceLifecycle(INC), {
    kind: 'bootSettled',
    outcome,
    ...(gapKind === undefined ? {} : { gapKind }),
  }, env).state
}

test('retryForgotten drops the self-heal mark and nothing else', () => {
  // The App's reclaimView forgets the degraded-retry mark; the container counterpart
  // must be equally narrow: a still-settled-degraded view keeps its boot outcome.
  const marked = reduceSourceSequence(initialSourceLifecycle(INC), [
    { kind: 'phaseChanged', phase: 'ready' },
    { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' },
  ], env)
  assert.equal(marked.state.degradedRetried, true, 'ready + retryable degraded settle sets the mark')
  const forgotten = reduceSource(marked.state, { kind: 'retryForgotten' }, env)
  assert.equal(forgotten.state.degradedRetried, false, 'the mark is gone')
  assert.deepEqual(forgotten.state.boot, marked.state.boot, 'the boot outcome is untouched')
  assert.deepEqual(forgotten.effects, [])
})

test('a degraded, retryable mount earns exactly one self-heal, paid by the ready epoch', () => {
  // 结算时相位未到 ready（真实冷启动的常态）：不立即自愈，但把"待自愈"留成事实。
  const settledEarly = settled('degraded', 'graph-unavailable')
  assert.equal(settledEarly.healPending, true, 'the arm survives a settle that precedes ready')
  // ready 世代偿还它：一次 effect + 本世代已用标记。
  const ready = reduceSource(settledEarly, { kind: 'phaseChanged', phase: 'ready' }, env)
  assert.equal(ready.state.degradedRetried, true)
  assert.equal(ready.state.retryToken, 1, 'the heal count lives on the same object')
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

test('harvestRecord accepts the finished record whole and harvestCleared drops it', () => {
  // 收割策略在 baseline-harvest 的纯函数里；容器只存调用方算好的整条记录。
  const record = { attempts: 2, mountedAt: 1_000, retryAt: 121_000, satisfied: true }
  const stored = reduceSource(initialSourceLifecycle(INC), { kind: 'harvestRecord', record }, env)
  assert.deepEqual(stored.state.harvest, record)
  assert.deepEqual(stored.effects, [], 'recording a finished record performs nothing')
  const cleared = reduceSource(stored.state, { kind: 'harvestCleared' }, env)
  assert.equal(cleared.state.harvest, null)
})

test('an unknown event kind is a total no-op', () => {
  const state = initialSourceLifecycle(INC)
  const r = reduceSource(state, { kind: 'nonsense' as never }, env)
  assert.equal(r.state, state)
  assert.deepEqual(r.effects, [])
})
