/**
 * shared/search-state.ts unit tests (plain node:test, no dsh, no DOM):
 * expand/collapse/clear/setQuery transitions + notifications, sanitized
 * queries, the disconnect prune (a disconnected source drops its search
 * state), and the debounced fetch jobs — driven through the INJECTED
 * `setSearchFetcher`, so jobs arm in node without any wire (success → ready,
 * failure → error, superseded → silent, disconnect aborts the in-flight job).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearSearch,
  collapseSearch,
  expandSearch,
  getSearchStates,
  setSearchFetcher,
  setSearchQuery,
  subscribeSearch,
} from '../src/shared/search-state.ts'
import { chamberBridge, type ChamberServerAggregate } from '../src/shared/aggregate-store.ts'

function server(id: string, connected: boolean): ChamberServerAggregate {
  return {
    id,
    sourceFingerprint: 'a'.repeat(64),
    kind: 'dsh',
    transport: 'ssh',
    label: id,
    connected,
    phase: connected ? 'ready' : 'stopped',
    workspaces: [],
    updatedAt: 0,
  }
}

test('search-state: expand/collapse/clear transitions notify and are idempotent', () => {
  clearSearch('s1') // clean slate
  let notified = 0
  const unsubscribe = subscribeSearch(() => { notified += 1 })
  assert.equal(getSearchStates().get('s1'), undefined)

  expandSearch('s1')
  assert.equal(notified, 1)
  const state = getSearchStates().get('s1')
  assert.ok(state !== undefined)
  assert.equal(state.expanded, true)
  assert.equal(state.query, '')
  assert.equal(state.status, 'idle')

  // Idempotent expand: no duplicate notification, no state churn.
  expandSearch('s1')
  assert.equal(notified, 1)

  collapseSearch('s1')
  assert.equal(notified, 2)
  assert.equal(getSearchStates().get('s1'), undefined)

  unsubscribe()
})

test('search-state: setSearchQuery sanitizes, marks loading, and clear drops the state', () => {
  expandSearch('s1')
  setSearchQuery('s1', '  foo\0bar  ')
  const state = getSearchStates().get('s1')
  assert.ok(state !== undefined)
  assert.equal(state.query, 'foobar') // NULs stripped, trimmed
  assert.equal(state.status, 'loading')
  assert.deepEqual(state.items, [])

  // No-op for the identical sanitized query (no re-notify beyond the above).
  setSearchQuery('s1', '  foobar  ')
  assert.equal(getSearchStates().get('s1')?.query, 'foobar')

  clearSearch('s1')
  assert.equal(getSearchStates().get('s1'), undefined)
})

test('search-state: a disconnected source drops its state on projection publish', () => {
  chamberBridge.publish([server('a', true), server('b', true)])
  expandSearch('a')
  expandSearch('b')
  assert.equal(getSearchStates().get('a')?.expanded, true)
  assert.equal(getSearchStates().get('b')?.expanded, true)

  // b's tunnel drops: the publish prunes b's search state (a reconnect starts
  // from a clean collapsed capsule); a's survives untouched.
  chamberBridge.publish([server('a', true), server('b', false)])
  assert.equal(getSearchStates().get('a')?.expanded, true)
  assert.equal(getSearchStates().get('b'), undefined)

  // Cleanup for later tests.
  chamberBridge.publish([server('a', true), server('b', true)])
  collapseSearch('a')
  assert.equal(getSearchStates().get('a'), undefined)
})

/**
 * Deadline-poll a condition instead of sleeping a fixed wall-clock margin
 * against the 250ms debounce: a stalled event loop (loaded CI) must not
 * flake the assertions (2026-08 audit fix).
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('search-state: one debounced job per expanded connected source, results land via the injected fetcher', async () => {
  chamberBridge.publish([server('a', true)])
  const seen: Array<{ sourceId: string; query: string; aborted: boolean }> = []
  setSearchFetcher(async (sourceId, query, signal) => {
    seen.push({ sourceId, query, aborted: signal.aborted })
    return { items: [{ sessionId: 's1', snippet: 'hit' }], hasMore: false }
  })
  expandSearch('a')
  setSearchQuery('a', 'foo')
  assert.equal(getSearchStates().get('a')?.status, 'loading')
  assert.equal(seen.length, 0) // debounce has not fired yet (assert.equal — no assertion-signature narrowing)

  await waitFor(() => getSearchStates().get('a')?.status === 'ready')
  const state = getSearchStates().get('a')
  assert.equal(state?.status, 'ready')
  assert.deepEqual(state?.items, [{ sessionId: 's1', snippet: 'hit' }])
  assert.deepEqual(seen, [{ sourceId: 'a', query: 'foo', aborted: false }])

  // Re-querying supersedes the finished job: a NEW job is armed for the new
  // query (one fetch total for the new query).
  setSearchQuery('a', 'bar')
  assert.equal(getSearchStates().get('a')?.status, 'loading')
  await waitFor(() => getSearchStates().get('a')?.status === 'ready')
  assert.deepEqual(seen.map(entry => entry.query), ['foo', 'bar'])

  collapseSearch('a')
  assert.equal(getSearchStates().get('a'), undefined)
})

test('search-state: a failing search lands an error state (never lingers on pending)', async () => {
  chamberBridge.publish([server('a', true)])
  setSearchFetcher(async () => { throw new Error('search backend down') })
  expandSearch('a')
  setSearchQuery('a', 'foo')
  await waitFor(() => getSearchStates().get('a')?.status === 'error')
  assert.deepEqual(getSearchStates().get('a')?.items, [])
  collapseSearch('a')
})

test('search-state: a superseded job exits silently while the new job owns the state (P2-6)', async () => {
  chamberBridge.publish([server('a', true)])
  const pending: Array<{
    resolve: (value: { items: { sessionId: string; snippet: string }[]; hasMore: boolean }) => void
    reject: (err: Error) => void
    signal: AbortSignal
  }> = []
  setSearchFetcher((_sourceId, _query, signal) => new Promise((resolve, reject) => {
    pending.push({ resolve, reject, signal })
  }))
  expandSearch('a')
  setSearchQuery('a', 'one')
  await waitFor(() => pending.length === 1) // debounce fired, job one in flight
  const first = pending[0]

  setSearchQuery('a', 'two') // supersedes: aborts + removes job one, arms job two
  assert.equal(first.signal.aborted, true)
  await waitFor(() => pending.length === 2)
  const second = pending[1]

  // Job one rejects AFTER being superseded — its abort must land silently
  // (it no longer owns the state); the state stays on job two's loading.
  first.reject(new Error('Aborted'))
  assert.equal(getSearchStates().get('a')?.status, 'loading')

  second.resolve({ items: [{ sessionId: 's2', snippet: 'hit-2' }], hasMore: false })
  await waitFor(() => getSearchStates().get('a')?.status === 'ready')
  assert.deepEqual(getSearchStates().get('a')?.items, [{ sessionId: 's2', snippet: 'hit-2' }])
  assert.equal(getSearchStates().get('a')?.query, 'two')

  collapseSearch('a')
})

test('search-state: a disconnect aborts the in-flight job and drops the state', async () => {
  chamberBridge.publish([server('a', true)])
  const signals: AbortSignal[] = []
  setSearchFetcher((_sourceId, _query, signal) => new Promise(() => {
    signals.push(signal)
    // Never settles — the disconnect abort is what must clean it up.
  }))
  expandSearch('a')
  setSearchQuery('a', 'foo')
  await waitFor(() => signals.length === 1)
  assert.equal(getSearchStates().get('a')?.status, 'loading')

  chamberBridge.publish([server('a', false)]) // tunnel drops
  assert.equal(signals[0].aborted, true)      // in-flight job aborted
  assert.equal(getSearchStates().get('a'), undefined) // state dropped (clean reconnect)

  chamberBridge.publish([server('a', true)])
})
