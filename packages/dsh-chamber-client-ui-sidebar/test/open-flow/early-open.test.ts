/**
 * Boot-time early-open arm (src/client/early-open.ts): behaviour through injected
 * clock/timer seams, plus the wiring locks on its registration inside client/index.ts
 * (design 05 §2.2 revision).
 *
 * Contracts: one open per arm, the retry cadence, the LIVE intent read (a
 * post-first-read arm still opens; a replacement opens the NEWER session), the
 * deadline as the ONLY retirement of an absent slot, the bounded budget, a
 * missing/THROWING list face, and a refused open
 * (warn once, never throw — the App owns the terminal report).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startEarlyOpenArm, type EarlyOpenArmDeps } from '../../src/client/early-open.ts'
import { EARLY_OPEN_BUDGET_MS, EARLY_OPEN_RETRY_MS } from '@dsh-chamber/dsh-chamber-client-core/open-intent'

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
    clearTimer: (handle) => { queue = queue.filter(entry => entry !== (handle as unknown as { at: number })) },
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
  // The first `attempt()` runs synchronously at plugin apply —
  // BEFORE the user can click — so retiring on the first absent read would kill the arm for a
  // boot in flight (the blank-session cost the arm exists to avoid). Design 05 §2.2.1 gate
  // 3 sanctions only two retirements: a successful open and the 8s deadline.
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
  assert.equal(h.scheduledTimers, EARLY_OPEN_BUDGET_MS / EARLY_OPEN_RETRY_MS, 'the documented cost of the F1 rule: 160 cheap polls per boot')
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

  // The App's own dispatch settled first and released the slot:
  // the arm has nothing to preempt, but it is NOT retired — a click
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
  // `attempt()` is a timer body — an escaped throw would leave no
  // tick, no warning and no open, i.e. the arm would die with no trace at all.
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

/**
 * Wiring contract for the arm inside the sidebar plugin (design 05 §2.2 revision).
 * `client/index.ts` is a cordis plugin body a node test cannot import, so
 * this SHAPE-only lock (comment-stripped source)
 * pins the links that would silently disable or misfire the preemption:
 * 1. arm started inside a `ctx.effect` (ctx teardown must dispose it);
 * 2. intent read LIVE from the shared slot, never captured at apply time;
 * 3. the open goes through THIS ctx's own `sessions.open` (never detached/page-global);
 * 4. the SOURCE IDENTITY is proven before the arm mutates the host (the
 *    page-wide, sourceId-keyed slot would otherwise drive a same-id
 *    boot of another incarnation).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** The `ctx.effect` body that starts the early-open arm (comments stripped). */
function armEffectBody(plugin: string): string {
  const code = stripComments(plugin)
  const effectIndex = code.indexOf("}, 'dsh-chamber: boot-time session open intent')")
  assert.notEqual(effectIndex, -1, 'the arm must be a dedicated ctx effect')
  return code.slice(code.lastIndexOf('ctx.effect(() => {', effectIndex), effectIndex)
}

test('the plugin starts the arm inside a ctx.effect, bound to its own instance id', () => {
  const body = armEffectBody(read('../../src/client/index.ts'))
  assert.match(body, /const chamberInstanceId = \(ctx as any\)\.chamberInstanceId as string \| undefined/)
  assert.match(
    body,
    /if \(typeof chamberInstanceId !== 'string' \|\| chamberInstanceId === ''\) return \(\) => \{\}/,
    'a non-chamber boot must not arm',
  )
  assert.match(body, /return startEarlyOpenArm\(\{/)
  assert.match(body, /instanceId: chamberInstanceId,/)
})

test('the arm proves the source identity before it opens on that host (2026-09-11 review F3)', () => {
  // Deleting this guard re-opens the hole: the arm MUTATES the presented
  // session (`uiWorkspace.openSession`) on a page-wide, sourceId-keyed intent, so
  // a same-id boot of another incarnation could be driven by a previous one's
  // intent.
  const body = armEffectBody(read('../../src/client/index.ts'))
  assert.match(
    body,
    /const chamberSourceFingerprint = \(ctx as any\)\.chamberSourceFingerprint as string \| undefined/,
    'the arm must read the ctx source fingerprint the same way the producer effect does',
  )
  assert.match(
    body,
    /if \(!isValidProducerSourceFingerprint\(chamberInstanceId, chamberSourceFingerprint\)\) return \(\) => \{\}/,
    'an unproven source identity must leave the arm unarmed',
  )
  const guardAt = body.indexOf('isValidProducerSourceFingerprint(chamberInstanceId, chamberSourceFingerprint)')
  const armAt = body.indexOf('return startEarlyOpenArm(')
  assert.ok(guardAt !== -1 && armAt > guardAt, 'the identity proof must precede the arm')
})

test('the arm reads the LIVE intent and presents through this ctx own official view owner', () => {
  const body = armEffectBody(read('../../src/client/index.ts'))
  assert.match(body, /readIntent: \(\) => getOpenIntent\(chamberInstanceId\)/, 'read at attempt time — a captured value opens a stale request')
  assert.match(
    body,
    /open: \(sessionId\) => \{ workspaceNavigation\.openSession\(sessionId\) \}/,
    'the open must be a method call on THIS ctx official view owner (never a detached '
      + 'reference): only ui-workspace.openSession sets mainReference and preempts the '
      + 'official initial-navigation blank',
  )
  assert.doesNotMatch(body, /ctx\.sessions\.open/,
    'the removed rc.1 sessions.open must never return to the arm')
  assert.match(body, /isAddressable: \(sessionId\) => \{/, 'the addressability probe must live at the ctx seam, where a hostile face is caught')
  assert.match(
    body,
    /if \(snapshot\?\.byId === undefined\) return undefined/,
    'an ABSENT face is `undefined` (retire silently, 2026-09-11 review F2); a readable-but-empty face is `false` (keep polling)',
  )
  assert.doesNotMatch(
    body,
    /resolveInstanceListFace/,
    'the probe must stay silent: that helper warns loudly and the same ctx runtime-facts producer already warns for this defect',
  )
})

test('the arm module itself owns the decision logic (no duplicated rules at the seam)', () => {
  const plugin = read('../../src/client/index.ts')
  assert.doesNotMatch(
    plugin,
    /EARLY_OPEN_BUDGET_MS|EARLY_OPEN_RETRY_MS|shouldEarlyOpenSession/,
    'deadline/cadence/predicate belong to shared/open-intent.ts + client/early-open.ts',
  )
  const arm = read('../../src/client/early-open.ts')
  assert.match(arm, /shouldEarlyOpenSession\(intent, addressable\)/)
  assert.match(arm, /deadline = now\(\) \+ EARLY_OPEN_BUDGET_MS/)
  assert.doesNotMatch(
    arm,
    /new Set\(/,
    'the arm must probe per id: materializing an id set every 50ms over a multi-thousand-row list is pure waste',
  )
})
