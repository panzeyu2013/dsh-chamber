import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPurgeTracker } from '../../src/shared/purged-tracker.ts'
import { createPurgedConvergence } from '../../src/shared/purged-convergence.ts'

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * Deterministic timer seam (2026-09-12 CI fix): the chain's retry cadence and
 * per-attempt watchdog are real timers by default, so asserting "exactly one refresh
 * so far" after a `setImmediate` flush raced the 1 ms retry (2 !== 1 on a loaded CI
 * runner). Every test drives time through the injected `schedule`/`cancel` seams.
 */
function makeClock() {
  let nextId = 1
  const timers = new Map<number, { run: () => void; ms: number }>()
  return {
    /** The chain's `schedule` seam. */
    schedule: (run: () => void, ms: number): number => { const id = nextId++; timers.set(id, { run, ms }); return id },
    /** The chain's `cancel` seam. */
    cancel: (id: unknown): void => { timers.delete(id as number) },
    /** Number of armed timers (retries + watchdogs). */
    get pending(): number { return timers.size },
    /** Fire every currently armed timer once, in scheduling order. */
    runPending(): number {
      const batch = [...timers.entries()].sort((a, b) => a[0] - b[0])
      timers.clear()
      for (const [, timer] of batch) timer.run()
      return batch.length
    },
  }
}

/**
 * Tracker harness: a fake official refresh whose outcome/lingering the test controls,
 * plus call/warn recording (`listedSummaryIds` models the official summaries still
 * listing the tombstoned ids). Every harness carries the deterministic clock above.
 */
function tracker(options: {
  refresh?: () => Promise<unknown> | undefined
  listedSummaryIds?: () => ReadonlySet<string>
  probe?: () => Promise<ReadonlySet<string>>
  onRelease?: () => void
  maxAttempts?: number
  retryMs?: number
} = {}) {
  const calls: number[] = []
  const warns: string[] = []
  const clock = makeClock()
  let n = 0
  const handle = createPurgeTracker({
    refresh: options.refresh ?? (() => { calls.push(n++); return Promise.resolve() }),
    listedSummaryIds: options.listedSummaryIds ?? (() => new Set<string>()),
    probe: options.probe,
    onRelease: options.onRelease,
    warn: (message) => { warns.push(message) },
    schedule: clock.schedule,
    cancel: clock.cancel,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
  })
  return { handle, calls, warns, clock }
}

test('tracker: the first observation never arms tombstones', () => {
  const t = tracker()
  assert.deepEqual(t.handle.observeArchive(['a', 'b']), [])
  assert.equal(t.handle.suppressed().size, 0)
  assert.deepEqual(t.calls, [])
})

test('tracker: a strict shrink arms exactly the removed ids and converges once', () => {
  const t = tracker()
  t.handle.observeArchive(['a', 'g1', 'g2'])
  assert.deepEqual(t.handle.observeArchive(['a']), ['g1', 'g2'])
  assert.deepEqual([...t.handle.suppressed()].sort(), ['g1', 'g2'])
  assert.equal(t.calls.length, 1)
})

test('tracker: an unchanged array identity is a no-op (per-push cost short-circuit)', () => {
  const t = tracker()
  const first = ['a', 'g']
  t.handle.observeArchive(first)
  assert.deepEqual(t.handle.observeArchive(first), [])
  assert.deepEqual(t.handle.observeArchive(first), [])
  assert.equal(t.calls.length, 0)
})

test('tracker: growth, non-array shapes and reordering never arm', () => {
  const t = tracker()
  t.handle.observeArchive(['a'])
  assert.deepEqual(t.handle.observeArchive(['a', 'b']), [])
  assert.deepEqual(t.handle.observeArchive(undefined), [])
  assert.deepEqual(t.handle.observeArchive('nope'), [])
  assert.deepEqual(t.handle.observeArchive(null), [])
  assert.deepEqual(t.handle.observeArchive(['b', 'a']), [])
  assert.equal(t.handle.suppressed().size, 0)
})

test('tracker: filter drops suppressed rows and preserves identity otherwise', () => {
  const t = tracker()
  const rows = [{ sessionId: 'live' }, { sessionId: 'g' }]
  assert.equal(t.handle.filter(rows), rows)
  t.handle.observeArchive(['g'])
  assert.deepEqual(t.handle.observeArchive([]), ['g'])
  assert.deepEqual(t.handle.filter(rows), [{ sessionId: 'live' }])
})

test('tracker: reconcile drops ids the official refresh no longer lists', () => {
  const t = tracker()
  t.handle.observeArchive(['g'])
  t.handle.observeArchive([])
  assert.deepEqual([...t.handle.suppressed()], ['g'])
  t.handle.reconcile(new Set(['g', 'live']))
  assert.deepEqual([...t.handle.suppressed()], ['g'])
  t.handle.reconcile(new Set(['live']))
  assert.equal(t.handle.suppressed().size, 0)
})

test('tracker: reconcile releases an id that re-entered the archive set', () => {
  const t = tracker()
  t.handle.observeArchive(['g'])
  t.handle.observeArchive([])
  assert.deepEqual([...t.handle.suppressed()], ['g'])
  // Re-archived: the set grows back through a fresh array identity.
  t.handle.observeArchive(['g'])
  t.handle.reconcile(new Set(['g']))
  assert.equal(t.handle.suppressed().size, 0)
})

test('tracker: a second purge arms its ids without restarting the chain budget', () => {
  const t = tracker({ maxAttempts: 2 })
  t.handle.observeArchive(['g1'])
  t.handle.observeArchive([])
  assert.equal(t.calls.length, 1)
  t.handle.observeArchive(['g1', 'g2'])
  assert.deepEqual(t.handle.observeArchive(['g1']), ['g2'])
  assert.deepEqual([...t.handle.suppressed()].sort(), ['g1', 'g2'])
  // The chain is single-flight: the second arm joined it.
  assert.equal(t.calls.length, 1)
})

test('tracker: converge() drives the chain; dispose() stops it', async () => {
  let resolveRefresh: (() => void) | undefined
  const t = tracker({ refresh: () => new Promise<void>((resolve) => { resolveRefresh = resolve }) })
  t.handle.observeArchive(['g'])
  t.handle.observeArchive([])
  assert.equal(t.handle.active(), true)
  assert.equal(t.clock.pending, 1, 'an in-flight attempt always has its per-attempt watchdog armed')
  t.handle.dispose()
  assert.equal(t.handle.active(), false)
  assert.equal(t.clock.pending, 0, 'dispose() must cancel the armed timer, not merely flip `active`')
  resolveRefresh?.()
  await flush()
  assert.equal(t.handle.active(), false)
})

test('tracker: the chain sees the live suppression set through lingering()', async () => {
  // The official summaries still list g -> the chain retries; once the test stops
  // listing it, the chain converges. The retry rides the injected clock, so
  // "exactly one call so far" is a fact, not a race (2026-09-12 CI fix).
  let listed = new Set(['g'])
  const t = tracker({ listedSummaryIds: () => listed, maxAttempts: 3, retryMs: 1 })
  t.handle.observeArchive(['g'])
  t.handle.observeArchive([])
  await flush()
  assert.equal(t.calls.length, 1, 'the arm publishes exactly one refresh with no timer fired')
  assert.equal(t.clock.pending, 1, 'the retry is parked on the injected clock, never on the wall clock')
  listed = new Set()
  t.clock.runPending()
  await flush()
  assert.equal(t.calls.length, 2, 'the clock-driven retry converges')
  assert.equal(t.handle.active(), false)
})

test('tracker: the suppression SURVIVES chain exhaustion (no release valve)', async () => {
  // The core of the D1 correction: after the bounded chain gives up, the id must still
  // be suppressed and its row still filtered — a resolved-but-untouched refresh proves
  // nothing (failed pulls and joined stale single-flight callers both resolve).
  const t = tracker({ maxAttempts: 2, retryMs: 1, listedSummaryIds: () => new Set(['g', 'live']) })
  t.handle.observeArchive(['g'])
  t.handle.observeArchive([])
  await flush()
  assert.equal(t.calls.length, 1)
  t.clock.runPending()
  await flush()
  assert.equal(t.calls.length, 2, 'the second (final) attempt rides the injected clock')
  assert.deepEqual([...t.handle.suppressed()], ['g'])
  assert.deepEqual(t.handle.filter([{ sessionId: 'live' }, { sessionId: 'g' }]), [{ sessionId: 'live' }])
  assert.equal(t.warns.length, 1)
})

test('tracker: a probe-confirmed live id is released and re-published', async () => {
  let released = 0
  const t = tracker({
    listedSummaryIds: () => new Set(['g']), probe: () => Promise.resolve(new Set(['g'])),
    onRelease: () => { released += 1 }, maxAttempts: 1, retryMs: 1,
  })
  t.handle.observeArchive(['g'])
  t.handle.observeArchive([])
  assert.deepEqual([...t.handle.suppressed()], ['g'])
  t.clock.runPending()
  await flush()
  assert.equal(t.handle.suppressed().size, 0)
  assert.equal(released, 1)
  assert.deepEqual(t.handle.filter([{ sessionId: 'g' }]), [{ sessionId: 'g' }])
})

test('tracker: a probe that does not confirm the id keeps it suppressed', async () => {
  const t = tracker({
    listedSummaryIds: () => new Set(['g']), probe: () => Promise.resolve(new Set(['other'])),
    maxAttempts: 1, retryMs: 1,
  })
  t.handle.observeArchive(['g'])
  t.handle.observeArchive([])
  t.clock.runPending()
  await flush()
  assert.deepEqual([...t.handle.suppressed()], ['g'])
})

test('tracker: suppressed() returns a copy the caller cannot mutate', () => {
  const t = tracker()
  t.handle.observeArchive(['g'])
  t.handle.observeArchive([])
  const view = t.handle.suppressed() as Set<string>
  view.clear()
  assert.deepEqual([...t.handle.suppressed()], ['g'])
})

// =====================================================================
// Convergence-chain fences (consolidated from purged-convergence.test.ts):
// the fail-closed race/watchdog regressions from the 2026-09 scans. The
// tracker's own chain tests above cover the public path; these drive
// createPurgedConvergence directly because the fences are invisible through
// the tracker (late settles, per-probe watchdogs, in-flight suppression).
// =====================================================================

/** Deterministic per-handle clock: timers run only when the test drains the OLDEST one. */
function chainClock() {
  let nextId = 1
  const timers = new Map<number, { run: () => void; ms: number }>()
  return {
    schedule: (run: () => void, ms: number): number => { const id = nextId++; timers.set(id, { run, ms }); return id },
    cancel: (id: unknown): void => { timers.delete(id as number) },
    get pending(): number { return timers.size },
    async drainOldest(): Promise<number> {
      const entry = [...timers.entries()][0]
      if (entry === undefined) throw new Error('no pending timer')
      timers.delete(entry[0])
      entry[1].run()
      await Promise.resolve()
      await Promise.resolve()
      return entry[1].ms
    },
  }
}

/** A convergence chain over inert defaults (the configs these fence tests do not set). */
function chainOf(overrides: Partial<Parameters<typeof createPurgedConvergence>[0]> = {}) {
  return createPurgedConvergence({ refresh: () => Promise.resolve(), lingering: () => [], warn: () => {}, ...overrides })
}

test('chain fence: a hung refresh is bounded by the per-attempt watchdog and gives up honestly', async () => {
  const clock = chainClock()
  const warns: string[] = []
  let calls = 0
  const chain = chainOf({
    refresh: () => { calls += 1; return new Promise<never>(() => {}) },
    lingering: () => ['g'], warn: (message) => { warns.push(message) },
    schedule: clock.schedule, cancel: clock.cancel, maxAttempts: 2, retryMs: 10, attemptTimeoutMs: 5,
  })
  chain.converge()
  await flush()
  assert.equal(await clock.drainOldest(), 5)   // attempt-1 watchdog -> retry
  await flush()
  assert.equal(await clock.drainOldest(), 10)  // retry timer -> attempt 2
  await flush()
  assert.equal(await clock.drainOldest(), 5)   // attempt-2 watchdog -> terminal give-up
  await flush()
  assert.equal(calls, 2)
  assert.match(warns[0] ?? '', /no authoritative answer/)
  assert.equal(chain.active(), false)
})

test('chain fence: a late settle of a timed-out attempt cannot terminate a later attempt', async () => {
  const clock = chainClock()
  const warns: string[] = []
  let resolveFirst: (() => void) | undefined
  let calls = 0
  const chain = chainOf({
    refresh: () => {
      calls += 1
      if (calls === 1) return new Promise<void>((resolve) => { resolveFirst = resolve })
      return new Promise<never>(() => {})
    },
    lingering: () => ['g'], warn: (message) => { warns.push(message) },
    schedule: clock.schedule, cancel: clock.cancel, maxAttempts: 3, retryMs: 10, attemptTimeoutMs: 5,
  })
  chain.converge()
  await flush()
  assert.equal(await clock.drainOldest(), 5)
  await flush()
  assert.equal(await clock.drainOldest(), 10)
  await flush()
  assert.equal(calls, 2)
  resolveFirst?.()
  await flush()
  assert.equal(chain.active(), true, 'attempt 2 is still in flight; the late settle must be ignored')
  assert.equal(await clock.drainOldest(), 5)
  await flush()
  assert.equal(await clock.drainOldest(), 10)
  await flush()
  assert.equal(await clock.drainOldest(), 5)
  await flush()
  assert.equal(chain.active(), false)
  assert.equal(warns.length, 1)
})

test('chain fence: a probe that outlives its watchdog cannot cancel a LATER probe\'s watchdog', async () => {
  const clock = chainClock()
  const resolvers: Array<(present: ReadonlySet<string>) => void> = []
  let probeCalls = 0
  const chain = chainOf({
    refresh: () => new Promise<never>(() => {}), lingering: () => ['g'],
    probe: () => { probeCalls += 1; return new Promise<ReadonlySet<string>>((resolve) => { resolvers.push(resolve) }) },
    schedule: clock.schedule, cancel: clock.cancel, maxAttempts: 1, retryMs: 10, attemptTimeoutMs: 5,
  })
  chain.converge()
  await flush()
  assert.equal(await clock.drainOldest(), 5)   // attempt watchdog -> verify -> probe #1
  await flush()
  assert.equal(probeCalls, 1)
  assert.equal(await clock.drainOldest(), 5)   // probe #1 watchdog -> finish
  await flush()
  assert.equal(chain.active(), false)
  chain.converge()
  await flush()
  assert.equal(await clock.drainOldest(), 5)   // new attempt watchdog -> probe #2
  await flush()
  assert.equal(probeCalls, 2)
  resolvers[0]?.(new Set())
  await flush()
  assert.equal(chain.active(), true, 'late probe #1 may only clear its own handle')
  assert.equal(await clock.drainOldest(), 5)   // probe #2 watchdog still armed
  await flush()
  assert.equal(chain.active(), false)
})

test('chain fence: a tombstone armed while the probe is in flight is NOT released', async () => {
  let lingeringNow = ['g1']
  let resolveProbe: ((present: ReadonlySet<string>) => void) | undefined
  const releases: string[][] = []
  const chain = chainOf({
    lingering: () => lingeringNow,
    probe: () => new Promise<ReadonlySet<string>>((resolve) => { resolveProbe = resolve }),
    release: (ids) => { releases.push([...ids]) }, maxAttempts: 1, attemptTimeoutMs: 0,
  })
  chain.converge()
  await flush()
  lingeringNow = ['g1', 'g2']
  resolveProbe?.(new Set(['g2']))
  await flush()
  assert.deepEqual(releases, [], 'the release decision uses the suppression snapshot taken when the probe STARTED')
  assert.equal(chain.active(), false)
})

test('chain fence: converge() after dispose is inert', () => {
  let calls = 0
  const chain = chainOf({ refresh: () => { calls += 1; return Promise.resolve() } })
  chain.dispose()
  chain.converge()
  assert.equal(calls, 0)
})

