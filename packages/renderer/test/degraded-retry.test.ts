/**
 * Degraded-boot self-heal planner (2026-09-10, sidebarRight 彻底修复).
 *
 * The App's effect must re-boot a degraded mount exactly once per ready
 * epoch — never in a loop, never while the source is still starting (that is
 * what the serving gate covers), and always again after a real restart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planDegradedRetries } from '../src/degraded-retry.ts'

test('planDegradedRetries: a degraded mount on a ready source is re-booted once', () => {
  const first = planDegradedRetries({ degraded: ['local'], phaseOf: () => 'ready', retried: {} })
  assert.deepEqual(first.retry, ['local'])
  assert.deepEqual(first.retried, { local: true })
  // Second pass with the mark carried over: no second re-boot (no loop).
  const second = planDegradedRetries({ degraded: ['local'], phaseOf: () => 'ready', retried: first.retried })
  assert.deepEqual(second.retry, [])
  assert.deepEqual(second.retried, { local: true })
})

test('planDegradedRetries: a source that is not ready yet is left alone and earns a later attempt', () => {
  const starting = planDegradedRetries({ degraded: ['local'], phaseOf: () => 'starting', retried: { local: true } })
  assert.deepEqual(starting.retry, [])
  // The stale mark is dropped while the source is down, so the ready
  // transition that follows retries again (a real restart must re-heal).
  assert.deepEqual(starting.retried, {})
  const ready = planDegradedRetries({ degraded: ['local'], phaseOf: () => 'ready', retried: starting.retried })
  assert.deepEqual(ready.retry, ['local'])
})

test('planDegradedRetries: a retired source (no phase) is never re-booted', () => {
  const plan = planDegradedRetries({ degraded: ['ssh-gone'], phaseOf: () => undefined, retried: {} })
  assert.deepEqual(plan.retry, [])
  assert.deepEqual(plan.retried, {})
})

test('planDegradedRetries: healthy mounts are ignored and the plan is stable', () => {
  const plan = planDegradedRetries({
    degraded: ['ssh-b', 'local', 'ssh-a'],
    phaseOf: (id) => (id === 'ssh-b' ? 'starting' : 'ready'),
    retried: {},
  })
  assert.deepEqual(plan.retry, ['local', 'ssh-a'])
  assert.deepEqual(plan.retried, { local: true, 'ssh-a': true })
})

test('planDegradedRetries: the mark survives the retry\'s own idle reset (no re-boot loop)', () => {
  // boot degrades → App re-boots (mark set) → the mount goes idle while the
  // source still serves → boot degrades AGAIN. The mark must still be there,
  // otherwise a source that answers ready but never serves its graph would be
  // re-booted forever.
  const afterRetry = planDegradedRetries({ degraded: ['local'], phaseOf: () => 'ready', retried: {} })
  assert.deepEqual(afterRetry.retry, ['local'])
  const idle = planDegradedRetries({ degraded: [], phaseOf: () => 'ready', retried: afterRetry.retried })
  assert.deepEqual(idle.retry, [])
  assert.deepEqual(idle.retried, { local: true }, 'the mark is kept while the source still serves')
  const degradedAgain = planDegradedRetries({ degraded: ['local'], phaseOf: () => 'ready', retried: idle.retried })
  assert.deepEqual(degradedAgain.retry, [], 'a second degrade inside the same ready epoch must not re-boot again')
  // …and a real restart (leaving ready) earns the next attempt.
  const left = planDegradedRetries({ degraded: ['local'], phaseOf: () => 'starting', retried: degradedAgain.retried })
  assert.deepEqual(left.retried, {})
  assert.deepEqual(planDegradedRetries({ degraded: ['local'], phaseOf: () => 'ready', retried: left.retried }).retry, ['local'])
})

test('planDegradedRetries: marks of retired sources are dropped', () => {
  const plan = planDegradedRetries({ degraded: [], phaseOf: () => undefined, retried: { gone: true } })
  assert.deepEqual(plan.retried, {})
})
