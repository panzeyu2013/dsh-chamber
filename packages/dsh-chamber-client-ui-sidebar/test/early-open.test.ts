/**
 * early-open.ts unit tests (plain node:test, no dsh, no DOM): the boot-time
 * early-open arm that preempts the official workspace navigation policy inside
 * the target instance's own ctx (design 05 §2.2 revision 2026-12; 2026-12 field
 * report problem 1).
 *
 * The arm is driven through injected clock/timer seams, so every contract is
 * asserted deterministically: one open per arm, the retry cadence, the live
 * intent read (an intent armed AFTER the first read must still be opened, a
 * replaced one must open the NEWER session), the deadline as the ONLY
 * retirement of an absent slot, the bounded deadline, a missing list face, a
 * THROWING probe (2026-09-11 review F1/F2), and a refused open (warn once,
 * never throw, never report an outcome — the App owns the terminal report).
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
  let scheduled = 0
  let queue: { at: number; callback: () => void }[] = []
  const deps: EarlyOpenArmDeps = {
    instanceId: 'ssh-b',
    readIntent: () => undefined,
    isAddressable: () => false,
    open: (sessionId) => { opened.push(sessionId) },
    warn: (message) => { warnings.push(message) },
    now: () => clock,
    setTimer: (callback, ms) => {
      scheduled += 1
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
    /** Total cadence ticks ever scheduled — the cost of an armed boot. */
    get scheduledTimers() { return scheduled },
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

test('an intent armed AFTER the arm first read the slot is still opened (an absent slot is "not yet")', () => {
  // 2026-09-11 review F1: the first `attempt()` runs synchronously at plugin
  // apply — BEFORE the user can click — so retiring on the first absent read
  // killed the arm for a boot already in flight when the click landed, and the
  // official navigation policy then created a blank session on the host (the
  // exact cost the arm exists to avoid). Design 05 §2.2.1 gate 3 sanctions only
  // two retirements: a successful open and the 8s deadline.
  let intent: string | undefined
  let listed = false
  const h = harness({ readIntent: () => intent, isAddressable: () => listed })
  const dispose = startEarlyOpenArm(h.deps)
  assert.deepEqual(h.opened, [], 'nothing was pending at apply time')
  assert.equal(h.pendingTimers, 1, 'an absent slot keeps the 50ms cadence instead of retiring the arm')
  // The user clicks a session of this source while its boot is still running.
  intent = 's1'
  listed = true
  h.advance(EARLY_OPEN_RETRY_MS)
  assert.deepEqual(h.opened, ['s1'], 'the arm must still preempt for a click that landed after the first read')
  assert.equal(h.pendingTimers, 0, 'one open per arm: no further polling')
  dispose()
})

test('a boot that never receives an intent polls to the deadline, opens nothing, and costs 160 ticks', () => {
  let reads = 0
  const h = harness({ readIntent: () => { reads += 1; return undefined } })
  const dispose = startEarlyOpenArm(h.deps)
  assert.equal(reads, 1, 'the synchronous first attempt')
  h.advance(EARLY_OPEN_BUDGET_MS)
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.warnings, [])
  assert.equal(h.pendingTimers, 0, 'only the 8s deadline retires a boot with no intent')
  assert.equal(
    h.scheduledTimers,
    EARLY_OPEN_BUDGET_MS / EARLY_OPEN_RETRY_MS,
    'the documented cost of the F1 rule: 160 cheap polls per boot',
  )
  assert.equal(reads, h.scheduledTimers + 1, 'one read per tick, plus the first synchronous one')
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

test('the intent is read LIVE: a replaced intent opens the newer session, a released one is "nothing pending"', () => {
  let intent: string | undefined = 's1'
  let listed = false
  const h = harness({ readIntent: () => intent, isAddressable: () => listed })
  const dispose = startEarlyOpenArm(h.deps)
  // The user clicked a second session on the same source while the boot ran.
  intent = 's2'
  listed = true
  h.advance(EARLY_OPEN_RETRY_MS)
  assert.deepEqual(h.opened, ['s2'], 'the arm must follow the last request, never a stale capture')

  // The App's own dispatch settled first and released the slot (2026-09-11
  // review F1): the arm has nothing to preempt, but it is NOT retired — a click
  // that lands later in the same boot window must still be served.
  const released = harness({ readIntent: () => undefined, isAddressable: () => true })
  const disposeReleased = startEarlyOpenArm(released.deps)
  assert.deepEqual(released.opened, [])
  assert.equal(released.pendingTimers, 1, 'an absent slot is "not yet" — only the deadline retires the arm')
  released.advance(EARLY_OPEN_BUDGET_MS)
  assert.deepEqual(released.opened, [], 'nothing was ever requested')
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

test('a THROWING addressability probe retires the arm silently instead of escaping the timer callback', () => {
  // 2026-09-11 review F2: `attempt()` is a timer body — an escaped throw left no
  // tick, no warning and no open, i.e. the arm died with no trace at all.
  let hostile = false
  const h = harness({
    readIntent: () => 's1',
    isAddressable: () => {
      if (hostile) throw new Error('list face is hostile')
      return false
    },
  })
  const dispose = startEarlyOpenArm(h.deps)
  assert.equal(h.pendingTimers, 1, 'the first, non-throwing attempt keeps polling')
  hostile = true
  h.advance(EARLY_OPEN_RETRY_MS)   // the throw happens inside a TIMER callback
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.warnings, [], 'retire silently: the producer owns the loud report for this defect')
  assert.equal(h.pendingTimers, 0, 'the arm retires instead of leaving a dead cadence behind')
  h.advance(EARLY_OPEN_BUDGET_MS)
  assert.deepEqual(h.opened, [])
  dispose()
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
