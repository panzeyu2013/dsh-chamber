import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPurgeTracker } from '../src/shared/purged-tracker.ts'

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * Tracker harness: a fake official refresh whose outcome/lingering the test
 * controls, plus call/warn recording. `lingeringIds` models the official
 * summaries still listing the tombstoned ids.
 */
function tracker(options: {
  refresh?: () => Promise<unknown> | undefined
  listedSummaryIds?: () => ReadonlySet<string>
  maxAttempts?: number
  retryMs?: number
} = {}) {
  const calls: number[] = []
  const warns: string[] = []
  let n = 0
  const handle = createPurgeTracker({
    refresh: options.refresh ?? (() => { calls.push(n++); return Promise.resolve() }),
    listedSummaryIds: options.listedSummaryIds ?? (() => new Set<string>()),
    warn: (message) => { warns.push(message) },
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
  })
  return { handle, calls, warns }
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
  // stops listing it, the chain converges without a release valve.
  let listed = new Set(['g'])
  const calls: number[] = []
  const handle = createPurgeTracker({
    refresh: () => { calls.push(1); return Promise.resolve() },
    listedSummaryIds: () => listed,
    warn: () => {},
    maxAttempts: 3,
    retryMs: 1,
  })
  handle.observeArchive(['g'])
  handle.observeArchive([])
  await flush()
  assert.equal(calls.length, 1)
  listed = new Set()
  await new Promise(resolve => setTimeout(resolve, 5))
  await flush()
  assert.equal(calls.length, 2)
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
  await new Promise(resolve => setTimeout(resolve, 12))
  await flush()
  assert.equal(t.calls.length, 2)
  assert.deepEqual([...t.handle.suppressed()], ['g'])
  assert.deepEqual(t.handle.filter([{ sessionId: 'live' }, { sessionId: 'g' }]), [{ sessionId: 'live' }])
  assert.equal(t.warns.length, 1)
})

test('tracker: a probe-confirmed live id is released and re-published', async () => {
  let released = 0
  const handle = createPurgeTracker({
    refresh: () => Promise.resolve(),
    listedSummaryIds: () => new Set(['g']),
    probe: () => Promise.resolve(new Set(['g'])),
    onRelease: () => { released += 1 },
    warn: () => {},
    maxAttempts: 1,
    retryMs: 1,
  })
  handle.observeArchive(['g'])
  handle.observeArchive([])
  assert.deepEqual([...handle.suppressed()], ['g'])
  await new Promise(resolve => setTimeout(resolve, 8))
  await flush()
  assert.equal(handle.suppressed().size, 0)
  assert.equal(released, 1)
  assert.deepEqual(handle.filter([{ sessionId: 'g' }]), [{ sessionId: 'g' }])
})

test('tracker: a probe that does not confirm the id keeps it suppressed', async () => {
  const handle = createPurgeTracker({
    refresh: () => Promise.resolve(),
    listedSummaryIds: () => new Set(['g']),
    probe: () => Promise.resolve(new Set(['other'])),
    warn: () => {},
    maxAttempts: 1,
    retryMs: 1,
  })
  handle.observeArchive(['g'])
  handle.observeArchive([])
  await new Promise(resolve => setTimeout(resolve, 8))
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
