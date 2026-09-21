/**
 * prewarm-intent.ts unit tests (plain node:test, mock timers, no DOM).
 *
 * The machine answers "did the pointer dwell on this source header long enough
 * to report prewarm intent?" — it is NOT the row hover-card machine
 * (hover-intent.ts: 500ms dwell / single page-visible card slot); the two must
 * not be conflated. Pinned here: the 120ms boundary, the fire-time inside
 * check (a leave inside the commit window cancels outright), the 80ms leave
 * grace (a quick exit/re-entry does NOT restart the deadline; an expired grace
 * drops the armed dwell), press cancellation for the current hover cycle,
 * dispose, and the timing overrides.
 */

import { afterEach, beforeEach, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPrewarmIntent,
  emptyIntentPrewarmBudget,
  INTENT_DWELL_MS,
  INTENT_LEAVE_GRACE_MS,
  INTENT_PREWARM_COOLDOWN_MS,
  INTENT_PREWARM_MAX_PER_SESSION,
  intentPrewarmAllowed,
  intentPrewarmSpent,
  prioritizePrewarmSource,
  type PrewarmIntent,
} from '../../src/shared/prewarm-intent.ts'

/** Machines created by the current test; fake timers are installed per test. */
const created: PrewarmIntent[] = []
beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => {
  while (created.length > 0) created.pop()?.dispose()
  mock.timers.reset()
})

/** A machine plus the intents it published. */
function harness(options: { dwellMs?: number; leaveGraceMs?: number } = {}) {
  const intents: number[] = []
  const intent = createPrewarmIntent({ ...options, onIntent: () => { intents.push(1) } })
  created.push(intent)
  return { intent, intents: () => intents.length }
}

test('the dwell fires exactly once at INTENT_DWELL_MS while the pointer stays inside', () => {
  const h = harness()
  h.intent.enter()
  mock.timers.tick(INTENT_DWELL_MS - 1)
  assert.equal(h.intents(), 0, 'the 120ms boundary is exclusive before it')
  mock.timers.tick(1)
  assert.equal(h.intents(), 1, 'exactly at 120ms the intent fires')
  mock.timers.tick(10_000)
  assert.equal(h.intents(), 1, 'a single armed dwell fires at most once')
})

test('leaving before the dwell fires never triggers the intent', () => {
  const h = harness()
  h.intent.enter()
  mock.timers.tick(INTENT_DWELL_MS - 1)
  h.intent.leave()
  mock.timers.tick(10_000)
  assert.equal(h.intents(), 0, 'the pointer flag — not the timer — decides')
})

test('a leave inside the grace preserves the armed dwell across a quick re-entry', () => {
  const h = harness()
  h.intent.enter()
  mock.timers.tick(100)
  h.intent.leave()
  mock.timers.tick(10)
  h.intent.enter()
  mock.timers.tick(INTENT_DWELL_MS - 100 - 10 - 1)
  assert.equal(h.intents(), 0, 'the countdown was NOT restarted by the re-entry')
  mock.timers.tick(1)
  assert.equal(h.intents(), 1, 'the ORIGINAL deadline still fires')
})

test('an expired grace drops the dwell; a later enter starts a fresh full dwell', () => {
  const h = harness()
  h.intent.enter()
  mock.timers.tick(40)
  h.intent.leave()
  // Grace expires at t=120 (40+80) around the dwell deadline; the dwell must
  // not fire (pointer outside) and must be dropped.
  mock.timers.tick(INTENT_LEAVE_GRACE_MS + INTENT_DWELL_MS)
  assert.equal(h.intents(), 0)
  h.intent.enter()
  mock.timers.tick(INTENT_DWELL_MS - 1)
  assert.equal(h.intents(), 0, 'a fresh enter waits the full dwell again')
  mock.timers.tick(1)
  assert.equal(h.intents(), 1)
})

test('press cancels the current hover cycle; a later leave+enter re-arms', () => {
  const h = harness()
  h.intent.enter()
  mock.timers.tick(100)
  h.intent.press()
  mock.timers.tick(10_000)
  assert.equal(h.intents(), 0, 'the activation consumed the intent')
  // The pointer is still inside and no new pointerenter arrives: stay inert.
  h.intent.enter()
  mock.timers.tick(10_000)
  assert.equal(h.intents(), 0)
  // A genuine new hover cycle (leave, then enter) arms again.
  h.intent.leave()
  mock.timers.tick(INTENT_LEAVE_GRACE_MS + 1)
  h.intent.enter()
  mock.timers.tick(INTENT_DWELL_MS)
  assert.equal(h.intents(), 1)
})

test('dispose drops pending timers and every later call is inert', () => {
  const h = harness()
  h.intent.enter()
  mock.timers.tick(100)
  h.intent.dispose()
  mock.timers.tick(10_000)
  assert.equal(h.intents(), 0)
  h.intent.enter()
  h.intent.leave()
  h.intent.press()
  mock.timers.tick(10_000)
  assert.equal(h.intents(), 0, 'a disposed machine never fires')
})

test('repeated enter() while the dwell is armed neither restarts it nor doubles it', () => {
  const h = harness()
  h.intent.enter()
  mock.timers.tick(60)
  h.intent.enter()
  mock.timers.tick(INTENT_DWELL_MS - 60 - 1)
  assert.equal(h.intents(), 0, 'the second enter must not restart the countdown')
  mock.timers.tick(1)
  assert.equal(h.intents(), 1)
  mock.timers.tick(10_000)
  assert.equal(h.intents(), 1)
})

test('timing overrides are honored (tests / future tuning)', () => {
  const h = harness({ dwellMs: 40, leaveGraceMs: 10 })
  h.intent.enter()
  mock.timers.tick(39)
  assert.equal(h.intents(), 0)
  mock.timers.tick(1)
  assert.equal(h.intents(), 1)
  // The leave grace is the override too: a 10ms grace preserves a 40ms dwell.
  h.intent.leave()
  mock.timers.tick(9)
  h.intent.enter()
  mock.timers.tick(40)
  assert.equal(h.intents(), 2, 'each new enter after a completed cycle may fire once')
})

test('the constants are the plan values and distinct from the hover-card machine', () => {
  assert.equal(INTENT_DWELL_MS, 120)
  assert.equal(INTENT_LEAVE_GRACE_MS, 80)
})

/* ------------------------------------------------------------------------- *
 * App-consumer policy (pure): what the intent is worth once it reaches the
 * App's EXISTING prewarm queue. Re-order only, never a bypass.
 * ------------------------------------------------------------------------- */

test('an intent re-orders the existing queue to the front, keeping the rest in order', () => {
  const eligible = new Set(['a', 'b', 'c'])
  assert.deepEqual(prioritizePrewarmSource(['a', 'b', 'c'], 'c', eligible), ['c', 'a', 'b'])
  assert.deepEqual(prioritizePrewarmSource(['a', 'b', 'c'], 'b', eligible), ['b', 'a', 'c'])
  // Already at the head ⇒ the same array reference (no gratuitous churn).
  const queue = ['b', 'a']
  assert.equal(prioritizePrewarmSource(queue, 'b', eligible), queue)
})

test('an eligible source absent from the queue is front-inserted, never duplicated', () => {
  assert.deepEqual(prioritizePrewarmSource(['a'], 'b', new Set(['a', 'b'])), ['b', 'a'])
  assert.deepEqual(
    prioritizePrewarmSource(['a', 'b'], 'b', new Set(['a', 'b'])),
    ['b', 'a'],
    'the moved id is removed from its old position',
  )
})

test('a source outside the eligibility set is never reordered (suppressed / mounted / parked stay put)', () => {
  const eligible = new Set(['a', 'b'])
  const queue = ['a', 'b', 's']
  // 's' models every App-side hold: prewarmSuppressedRef (reclaimed),
  // mounted/active, harvestParked, not-ready, managed-down — all expressed by
  // ABSENCE from prewarmEligible, which this function must never override.
  assert.equal(prioritizePrewarmSource(queue, 's', eligible), queue)
  assert.deepEqual(queue, ['a', 'b', 's'])
})

test('the budget allows the first intent boot and enforces the billed-boot gap', () => {
  const start = 1_000_000
  const empty = emptyIntentPrewarmBudget()
  assert.equal(intentPrewarmAllowed(empty, 'a', start), true)
  const once = intentPrewarmSpent(empty, 'a', start)
  assert.equal(intentPrewarmAllowed(once, 'b', start + INTENT_PREWARM_COOLDOWN_MS - 1), false)
  assert.equal(intentPrewarmAllowed(once, 'b', start + INTENT_PREWARM_COOLDOWN_MS), true)
})

test('an intent buys at most one boot per source and at most the session cap', () => {
  const once = intentPrewarmSpent(emptyIntentPrewarmBudget(), 'a', 0)
  assert.equal(intentPrewarmAllowed(once, 'a', 10_000_000), false, 'per-source once')
  const twice = intentPrewarmSpent(once, 'b', 10_000_000)
  assert.equal(twice.boots, INTENT_PREWARM_MAX_PER_SESSION)
  assert.equal(intentPrewarmAllowed(twice, 'c', 20_000_000), false, 'session cap')
  assert.deepEqual(emptyIntentPrewarmBudget().usedSources, [], 'the empty ledger has no used sources')
  // spent() only RECORDS what the caller already decided to start; the gate is
  // intentPrewarmAllowed — the App calls spent() exactly at the drain point.
  assert.deepEqual(intentPrewarmSpent(twice, 'b', 30_000_000).usedSources, ['a', 'b'])
})

// 接线行为（原 prewarm-intent-wiring.test.ts 的行为面）：意图必须真的到达 App 层
// 订阅者，且取消订阅后不再投递。
test('the intent reaches App-layer bridge subscribers and unsubscribes cleanly', async () => {
  const { chamberBridge } = await import('../../src/shared/aggregate-store.ts')
  const seen: string[] = []
  const unsubscribe = chamberBridge.onIntentPrewarm(({ sourceId }) => { seen.push(sourceId) })
  chamberBridge.requestIntentPrewarm('ssh-a')
  chamberBridge.requestIntentPrewarm('local')
  assert.deepEqual(seen, ['ssh-a', 'local'])
  unsubscribe()
  chamberBridge.requestIntentPrewarm('ssh-b')
  assert.deepEqual(seen, ['ssh-a', 'local'], '取消订阅后不再投递')
})
