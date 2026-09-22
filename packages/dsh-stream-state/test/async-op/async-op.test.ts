/**
 * AsyncOp primitives (B6 core) - behavior contract with a deterministic scheduler.
 *
 * The point of the injected scheduler is here: every timing boundary is asserted
 * without a real clock, so the tests pin the SEMANTICS (one settle, no leaked
 * timer, expiry is recoverable) rather than racing a runtime.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  waitForCondition,
  withDeadline,
} from '../../src/async-op.ts'
import type { Scheduler } from '../../src/async-op.ts'

/** A scheduler that runs nothing until the test advances it. */
function manualScheduler() {
  let nextId = 0
  const pending = new Map<number, { run: () => void; at: number }>()
  let now = 0
  const scheduler: Scheduler = {
    setTimeout: (run, ms) => {
      const id = ++nextId
      pending.set(id, { run, at: now + ms })
      return id
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number)
    },
  }
  return {
    scheduler,
    get armed() {
      return pending.size
    },
    /** The same clock the timers are scheduled against, for `now` (P1). */
    get nowMs() {
      return now
    },
    /** Advance to the next due timer (or past `ms`), running what becomes due. */
    advance(ms: number) {
      now += ms
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id)
          entry.run()
        }
      }
    },
  }
}

test('a supplied clock makes the bound a wall-clock budget (P1)', async () => {
  // The two modes must differ observably - otherwise the option would be a no-op
  // that silently kept the weaker bound. One long tick moves the CLOCK far past the
  // bound while advancing the tick count by exactly one poll.
  const clocked = manualScheduler()
  const byClock = waitForCondition({
    pollMs: 10,
    boundMs: 1_000,
    scheduler: clocked.scheduler,
    isDone: () => false,
    now: () => clocked.nowMs,
  })
  clocked.advance(5_000)
  assert.equal(await byClock, 'expired', 'the clock passed the bound, so the wait must expire')

  const ticked = manualScheduler()
  const byTicks = waitForCondition({
    pollMs: 10,
    boundMs: 1_000,
    scheduler: ticked.scheduler,
    isDone: () => false,
  })
  ticked.advance(5_000)
  assert.equal(ticked.armed, 1, 'without a clock the bound counts ticks, so one long tick does NOT expire it')
  void byTicks
})

test('the operation wins and the deadline timer is cleared', async () => {
  const clock = manualScheduler()
  const result = await withDeadline(Promise.resolve('answer'), {
    ms: 30000,
    onExpire: () => 'timed-out',
    scheduler: clock.scheduler,
  })
  assert.deepEqual(result, { settled: 'operation', value: 'answer' })
  assert.equal(clock.armed, 0, 'the deadline must not stay armed')
})

test('expiry resolves with the caller sentinel and fires exactly once', async () => {
  const clock = manualScheduler()
  let expiries = 0
  const never = new Promise<string>(() => {})
  const pending = withDeadline(never, {
    ms: 30000,
    onExpire: () => {
      expiries += 1
      return 'timed-out'
    },
    scheduler: clock.scheduler,
  })
  assert.equal(clock.armed, 1)
  clock.advance(30000)
  assert.deepEqual(await pending, { settled: 'deadline', value: 'timed-out' })
  // Late-firing the already-ran handle must not settle again.
  clock.advance(30000)
  assert.equal(expiries, 1)
  assert.equal(clock.armed, 0)
})

test('a rejecting operation rejects (the deadline is not a swallow)', async () => {
  const clock = manualScheduler()
  await assert.rejects(
    withDeadline(Promise.reject(new Error('boom')), { ms: 10, onExpire: () => 'x', scheduler: clock.scheduler }),
    /boom/,
  )
  assert.equal(clock.armed, 0)
})

test('a condition that is already true does not pay a poll interval', async () => {
  const clock = manualScheduler()
  const outcome = await waitForCondition({
    pollMs: 500,
    boundMs: 5000,
    scheduler: clock.scheduler,
    isDone: () => true,
  })
  assert.equal(outcome, 'done')
  assert.equal(clock.armed, 0, 'no timer should ever have been armed')
})

test('a bounded wait expires instead of throwing, and stops polling', async () => {
  const clock = manualScheduler()
  let polls = 0
  const pending = waitForCondition({
    pollMs: 500,
    boundMs: 1000,
    scheduler: clock.scheduler,
    isDone: () => {
      polls += 1
      return false
    },
  })
  clock.advance(500)
  clock.advance(500)
  clock.advance(500)
  assert.equal(await pending, 'expired')
  assert.equal(polls, 3, 'checked at start, +500, +1000 then stopped')
  assert.equal(clock.armed, 0)
})

test('an abort wins over a pending poll and clears the timer', async () => {
  const clock = manualScheduler()
  const controller = new AbortController()
  const pending = waitForCondition({
    pollMs: 500,
    boundMs: 5000,
    scheduler: clock.scheduler,
    isDone: () => false,
  }, controller.signal)
  assert.equal(clock.armed, 1)
  controller.abort()
  assert.equal(await pending, 'aborted')
  assert.equal(clock.armed, 0, 'the abort path must clear the timer')
})

test('an already-aborted signal settles immediately without arming a timer', async () => {
  const clock = manualScheduler()
  const controller = new AbortController()
  controller.abort()
  const outcome = await waitForCondition({
    pollMs: 500,
    boundMs: 5000,
    scheduler: clock.scheduler,
    isDone: () => false,
  }, controller.signal)
  assert.equal(outcome, 'aborted')
  assert.equal(clock.armed, 0)
})

