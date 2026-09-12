import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPurgeTracker } from '../src/shared/purged-tracker.ts'

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * Deterministic timer seam for the convergence chain (2026-09-12 CI fix).
 *
 * WHY: the chain's retry cadence (`retryMs`) and per-attempt watchdog are real
 * timers by default, so a test that asserted "exactly one refresh so far" after
 * a `setImmediate` flush raced the 1 ms retry — it passed on a fast machine and
 * failed on a loaded CI runner (`purged-tracker.test.ts`, run 34668100002:
 * `2 !== 1`). The tracker already accepts `schedule`/`cancel` ("tests inject fake
 * timers"), so every test in this file now drives time explicitly instead of
 * waiting on wall-clock milliseconds.
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
 * Tracker harness: a fake official refresh whose outcome/lingering the test
 * controls, plus call/warn recording. `lingeringIds` models the official
 * summaries still listing the tombstoned ids. Every harness carries the
 * deterministic clock above, so no test in this file depends on wall-clock ms.
 */
function tracker(options: {
  refresh?: () => Promise<unknown> | undefined
  listedSummaryIds?: () => ReadonlySet<string>
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
  t.handle.dispose()
  assert.equal(t.handle.active(), false)
  resolveRefresh?.()
  await flush()
  assert.equal(t.handle.active(), false)
})

test('tracker: the chain sees the live suppression set through lingering()', async () => {
  // The official summaries still list g -> the chain retries; once the test
  // stops listing it, the chain converges without a release valve. The retry is
  // fired through the injected clock, so "exactly one call so far" is a fact,
  // not a race (2026-09-12 CI fix).
  const clock = makeClock()
  let listed = new Set(['g'])
  const calls: number[] = []
  const handle = createPurgeTracker({
    refresh: () => { calls.push(1); return Promise.resolve() },
    listedSummaryIds: () => listed,
    warn: () => {},
    schedule: clock.schedule,
    cancel: clock.cancel,
    maxAttempts: 3,
    retryMs: 1,
  })
  handle.observeArchive(['g'])
  handle.observeArchive([])
  await flush()
  assert.equal(calls.length, 1, 'the arm publishes exactly one refresh with no timer fired')
  listed = new Set()
  clock.runPending()
  await flush()
  assert.equal(calls.length, 2, 'the clock-driven retry converges')
  assert.equal(handle.active(), false)
})

test('tracker: the suppression SURVIVES chain exhaustion (no release valve)', async () => {
  // The core of the D1 correction: after the bounded chain gives up, the id
  // must still be suppressed and its row must still be filtered — a
  // resolved-but-untouched refresh proves nothing (the manager resolves on
  // failed pulls and for joined stale single-flight callers).
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
  const clock = makeClock()
  let released = 0
  const handle = createPurgeTracker({
    refresh: () => Promise.resolve(),
    listedSummaryIds: () => new Set(['g']),
    probe: () => Promise.resolve(new Set(['g'])),
    onRelease: () => { released += 1 },
    warn: () => {},
    schedule: clock.schedule,
    cancel: clock.cancel,
    maxAttempts: 1,
    retryMs: 1,
  })
  handle.observeArchive(['g'])
  handle.observeArchive([])
  assert.deepEqual([...handle.suppressed()], ['g'])
  clock.runPending()
  await flush()
  assert.equal(handle.suppressed().size, 0)
  assert.equal(released, 1)
  assert.deepEqual(handle.filter([{ sessionId: 'g' }]), [{ sessionId: 'g' }])
})

test('tracker: a probe that does not confirm the id keeps it suppressed', async () => {
  const clock = makeClock()
  const handle = createPurgeTracker({
    refresh: () => Promise.resolve(),
    listedSummaryIds: () => new Set(['g']),
    probe: () => Promise.resolve(new Set(['other'])),
    warn: () => {},
    schedule: clock.schedule,
    cancel: clock.cancel,
    maxAttempts: 1,
    retryMs: 1,
  })
  handle.observeArchive(['g'])
  handle.observeArchive([])
  clock.runPending()
  await flush()
  assert.deepEqual([...handle.suppressed()], ['g'])
})

test('tracker: suppressed() returns a copy the caller cannot mutate', () => {
  const t = tracker()
  t.handle.observeArchive(['g'])
  t.handle.observeArchive([])
  const view = t.handle.suppressed() as Set<string>
  view.clear()
  assert.deepEqual([...t.handle.suppressed()], ['g'])
})
