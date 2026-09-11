/**
 * early-open.ts unit tests (plain node:test, no dsh, no DOM): the boot-time
 * early-open arm that preempts the official workspace navigation policy inside
 * the target instance's own ctx (design 05 §2.2 revision 2026-12; 2026-12 field
 * report problem 1).
 *
 * The arm is driven through injected clock/timer seams, so every contract is
 * asserted deterministically: one open per arm, the retry cadence, the live
 * intent read (a released intent must stop the arm, a replaced one must open
 * the NEWER session), the bounded deadline, a missing list face, and a refused
 * open (warn once, never throw, never report an outcome — the App owns the
 * terminal report).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startEarlyOpenArm, type EarlyOpenArmDeps } from '../src/client/early-open.ts'
import { EARLY_OPEN_BUDGET_MS, EARLY_OPEN_RETRY_MS } from '../src/shared/open-intent.ts'

/** Manual clock + timer queue: `advance` runs whatever the cadence scheduled. */
function harness(overrides: Partial<EarlyOpenArmDeps> = {}) {
  const opened: string[] = []
  const warnings: string[] = []
  let clock = 1_000
  let queue: { at: number; callback: () => void }[] = []
  const deps: EarlyOpenArmDeps = {
    instanceId: 'ssh-b',
    readIntent: () => undefined,
    isAddressable: () => false,
    open: (sessionId) => { opened.push(sessionId) },
    warn: (message) => { warnings.push(message) },
    now: () => clock,
    setTimer: (callback, ms) => {
      const handle = { at: clock + ms, callback }
      queue.push(handle)
      queue.sort((left, right) => left.at - right.at)
      return handle as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      queue = queue.filter(entry => entry !== (handle as unknown as { at: number }))
    },
    ...overrides,
  }
  return {
    deps,
    opened,
    warnings,
    get pendingTimers() { return queue.length },
    /** Advance the clock and fire everything due (one pass per due timer). */
    advance(ms: number) {
      const target = clock + ms
      while (true) {
        const due = queue.find(entry => entry.at <= target)
        if (due === undefined) break
        queue = queue.filter(entry => entry !== due)
        clock = due.at
        due.callback()
      }
      clock = target
    },
  }
}

test('no live intent → the arm retires immediately, schedules nothing and opens nothing', () => {
  const h = harness()
  const dispose = startEarlyOpenArm(h.deps)
  assert.deepEqual(h.opened, [])
  assert.equal(h.pendingTimers, 0, 'a background prewarm/harvest boot must cost zero timers')
  h.advance(EARLY_OPEN_BUDGET_MS * 2)
  assert.deepEqual(h.opened, [])
  dispose()
})

test('a live intent whose session is already addressable opens once, immediately', () => {
  const h = harness({ readIntent: () => 's1', isAddressable: () => true })
  const dispose = startEarlyOpenArm(h.deps)
  assert.deepEqual(h.opened, ['s1'], 'the preemption must be synchronous with the first attempt')
  assert.equal(h.pendingTimers, 0, 'one open per arm: no further polling')
  h.advance(EARLY_OPEN_BUDGET_MS)
  assert.deepEqual(h.opened, ['s1'])
  dispose()
})

test('the arm probes the LIVE intent id, never a standalone id set', () => {
  const probed: string[] = []
  let listed = false
  const h = harness({
    readIntent: () => 's7',
    isAddressable: (sessionId) => { probed.push(sessionId); return listed },
  })
  const dispose = startEarlyOpenArm(h.deps)
  assert.deepEqual(probed, ['s7'], 'the probe receives the requested id (no per-tick Set materialization)')
  listed = true
  h.advance(EARLY_OPEN_RETRY_MS)
  assert.deepEqual(h.opened, ['s7'])
  dispose()
})

test('the session list arriving later is picked up on the retry cadence', () => {
  let listed = false
  const h = harness({ readIntent: () => 's7', isAddressable: () => listed })
  const dispose = startEarlyOpenArm(h.deps)
  assert.deepEqual(h.opened, [], 'not addressable yet')
  assert.equal(h.pendingTimers, 1)
  h.advance(EARLY_OPEN_RETRY_MS)
  h.advance(EARLY_OPEN_RETRY_MS)
  assert.deepEqual(h.opened, [], 'still not listed')
  listed = true
  h.advance(EARLY_OPEN_RETRY_MS)
  assert.deepEqual(h.opened, ['s7'])
  dispose()
})

test('the intent is read LIVE: a released intent stops the arm, a replaced one opens the newer session', () => {
  let intent: string | undefined = 's1'
  let listed = false
  const h = harness({ readIntent: () => intent, isAddressable: () => listed })
  const dispose = startEarlyOpenArm(h.deps)
  // The user clicked a second session on the same source while the boot ran.
  intent = 's2'
  listed = true
  h.advance(EARLY_OPEN_RETRY_MS)
  assert.deepEqual(h.opened, ['s2'], 'the arm must follow the last request, never a stale capture')

  const released = harness({ readIntent: () => intent, isAddressable: () => listed })
  intent = undefined  // App released it (its own dispatch settled first)
  const disposeReleased = startEarlyOpenArm(released.deps)
  assert.deepEqual(released.opened, [])
  assert.equal(released.pendingTimers, 0)
  dispose()
  disposeReleased()
})

test('a missing or hostile list face retires the arm silently (the producer owns that warning)', () => {
  const missing = harness({ readIntent: () => 's1', isAddressable: () => undefined })
  const disposeMissing = startEarlyOpenArm(missing.deps)
  assert.deepEqual(missing.opened, [])
  assert.deepEqual(missing.warnings, [], 'best-effort arm: no duplicate warning for the same ctx defect')
  assert.equal(missing.pendingTimers, 0)
  disposeMissing()
})

test('the deadline bounds the arm: a session that never becomes addressable stops polling', () => {
  const h = harness({ readIntent: () => 's1', isAddressable: () => false })
  const dispose = startEarlyOpenArm(h.deps)
  h.advance(EARLY_OPEN_BUDGET_MS - EARLY_OPEN_RETRY_MS)
  assert.equal(h.pendingTimers, 1, 'still inside the budget')
  h.advance(EARLY_OPEN_RETRY_MS)
  assert.equal(h.pendingTimers, 0, 'the deadline retires the arm instead of scheduling another tick')
  h.advance(EARLY_OPEN_BUDGET_MS)
  assert.deepEqual(h.opened, [])
  dispose()
})

test('a refused open warns once, never throws, and never opens again', () => {
  const h = harness({
    readIntent: () => 's1',
    isAddressable: () => true,
    open: () => { throw new Error('sessions.select: unknown session s1') },
  })
  const dispose = startEarlyOpenArm(h.deps)
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0] ?? '', /boot-time early open of s1 on ssh-b was refused: sessions\.select: unknown session s1/)
  assert.equal(h.pendingTimers, 0)
  h.advance(EARLY_OPEN_BUDGET_MS)
  assert.equal(h.warnings.length, 1, 'the arm does not retry a refused open')
  dispose()
})

test('dispose cancels a pending retry (ctx teardown never opens afterwards)', () => {
  let listed = false
  const h = harness({ readIntent: () => 's1', isAddressable: () => listed })
  const dispose = startEarlyOpenArm(h.deps)
  assert.equal(h.pendingTimers, 1)
  dispose()
  assert.equal(h.pendingTimers, 0)
  listed = true
  h.advance(EARLY_OPEN_BUDGET_MS)
  assert.deepEqual(h.opened, [], 'a disposed arm must never reach sessions.open')
})
