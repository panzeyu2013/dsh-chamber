/**
 * The auth-recovery DRIVER (design 27 §3.3) with an injected clock and timer
 * surface: this is the "assembly form" test for the wiring that used to live
 * inline in host-assembly (decision → microtask/timer → attempt), including the
 * same-tick double push and the deferred attempt that must not be dropped.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authRecoveryStillApplies, createAuthRecoveryController } from '../../auth-recovery.ts'

function harness(minIntervalMs = 5_000) {
  let now = 1_000
  const timers: { id: number; at: number; fn: () => void; canceled: boolean }[] = []
  let nextHandle = 0
  const attempts: string[] = []
  const decisions: string[] = []
  const controller = createAuthRecoveryController({
    minIntervalMs,
    now: () => now,
    setTimer: (fn, ms) => {
      nextHandle += 1
      timers.push({ id: nextHandle, at: now + ms, fn, canceled: false })
      return nextHandle as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      const entry = timers.find(timer => timer.id === (handle as unknown as number))
      if (entry !== undefined) entry.canceled = true
    },
    attempt: (id) => { attempts.push(id) },
    onDecision: (_id, decision) => { decisions.push(decision) },
  })
  const advance = (ms: number): void => {
    now += ms
    for (const timer of timers) {
      if (timer.canceled || timer.at > now) continue
      timer.canceled = true
      timer.fn()
    }
  }
  return { controller, attempts, decisions, advance, timers }
}

test('a first auth failure recovers immediately, exactly once per tick', () => {
  const h = harness()
  h.controller.notifyFailure('gw')
  h.controller.notifyFailure('gw') // same tick: the attempt timestamp closes the window
  assert.deepEqual(h.attempts, ['gw'])
  assert.deepEqual(h.decisions, ['now', 'deferred'])
})

test('a failure inside the window is deferred and runs at the edge', () => {
  const h = harness()
  h.controller.notifyFailure('gw') // t=1000
  h.advance(1_000)                // t=2000
  h.controller.notifyFailure('gw') // deferred 4000ms
  assert.deepEqual(h.attempts, ['gw'], 'no second attempt inside the window')
  assert.equal(h.timers.length, 1)
  h.advance(3_999)
  assert.deepEqual(h.attempts, ['gw'], 'still inside the window')
  h.advance(1)
  assert.deepEqual(h.attempts, ['gw', 'gw'], 'the deferred attempt runs at the edge')
})

test('the throttle is measured from the deferred attempt, not from its scheduling', () => {
  const h = harness()
  h.controller.notifyFailure('gw')  // t=1000 immediate
  h.advance(1_000)
  h.controller.notifyFailure('gw')  // deferred to t=6000
  h.advance(5_000)                  // t=6000: deferred attempt
  assert.deepEqual(h.attempts, ['gw', 'gw'])
  h.advance(1_000)                  // t=7000, only 1s after the attempt
  h.controller.notifyFailure('gw')  // must DEFER again, not fire
  assert.deepEqual(h.attempts, ['gw', 'gw'], 'a push right after the deferred attempt does not fire')
})

test('cancel drops the deferred attempt; a later failure is immediate again', () => {
  const h = harness()
  h.controller.notifyFailure('gw')
  h.advance(1_000)
  h.controller.notifyFailure('gw')
  h.controller.cancel('gw')
  h.advance(10_000)
  assert.deepEqual(h.attempts, ['gw'], 'the canceled deferred attempt never runs')
  h.controller.notifyFailure('gw')
  assert.deepEqual(h.attempts, ['gw', 'gw'], 'the window had passed: recover now')
})

test('dispose clears every pending timer', () => {
  const h = harness()
  h.controller.notifyFailure('a') // immediate
  h.advance(1_000)
  h.controller.notifyFailure('b') // immediate (first attempt for b)
  h.controller.notifyFailure('b') // deferred
  h.controller.dispose()
  h.advance(10_000)
  assert.deepEqual(h.attempts, ['a', 'b'], 'a disposed controller never attempts again')
})

test('a recovery attempt only runs for the same ready password gateway', () => {
  const base = {
    phase: 'ready',
    readyUrlMatches: true,
    kind: 'gateway',
    hasPassword: true,
    scopeMatches: true,
  }
  assert.equal(authRecoveryStillApplies(base), true)
  // Fail-closed on every axis: a stale or changed observation must do nothing.
  for (const patch of [
    { phase: 'idle' },
    { phase: 'degraded' },
    { readyUrlMatches: false },
    { kind: 'dsh' },
    { hasPassword: false },
    { scopeMatches: false },
  ]) {
    assert.equal(authRecoveryStillApplies({ ...base, ...patch }), false, JSON.stringify(patch))
  }
})

