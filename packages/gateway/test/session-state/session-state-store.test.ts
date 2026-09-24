/**
 * Session-state store: the per-session state machine and the R12 turn/end
 * classification contract. Pure module tests: every fact is
 * fed through the store API and observed on the frozen wire projection.
 *
 * Run directly:
 *   node --import ./test/session-state/workspace-loader.mjs test/session-state/session-state-store.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_STATE_PATH, SESSION_STATE_READ_ALL_PATH, SESSION_STATE_STREAM_PATH } from '@dsh-chamber/control-plane'
import {
  DEFAULT_EVENT_SILENCE_MS,
  MAX_SSE_PENDING_FRAMES,
  MAX_SSE_STREAMS,
  SSE_KEEPALIVE_MS,
  createSessionStateStore,
  normalizeHostState,
  parseReadAllRequestBody,
  parseReadRequestBody,
} from '../../src/session-state.ts'
import { baselineItem, scratch, silentLogger } from './harness.ts'

function storeFor(t: { after(fn: () => void): void }, now: () => number = () => 1_000): ReturnType<typeof createSessionStateStore> {
  return createSessionStateStore({ stateDir: scratch(t), logger: silentLogger, now })
}

// ---------------------------------------------------------------------------
// Running edge + completion classification (R12)
// ---------------------------------------------------------------------------

test('status true -> false yields one edge and arms nothing before classification', t => {
  const store = storeFor(t)
  assert.deepEqual(store.applyStatus('s1', true, 10), [])
  const edges = store.applyStatus('s1', false, 20)
  assert.deepEqual(edges, [{ sessionId: 's1', source: 'observed' }])
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.running, false)
  assert.equal(row.completedAt, null, 'the raw edge never arms completedAt')
  assert.equal(row.lastRunningAt, 10)
  // A duplicate status(false) cannot produce a second edge (one follow per edge).
  assert.deepEqual(store.applyStatus('s1', false, 21), [])
})

test('a false status without a running edge produces no edge', t => {
  const store = storeFor(t)
  assert.deepEqual(store.applyStatus('s1', false, 10), [])
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions[0].completedAt, null)
})

test('completed arms completedAt with the observed source', t => {
  const store = storeFor(t)
  store.applyStatus('s1', true, 10)
  const [edge] = store.applyStatus('s1', false, 20)
  assert.equal(store.settleCompletion(edge!, {
    at: 20, turnEnd: { kind: 'completed', cause: null, at: 20, seq: 7 }, unreadable: false,
  }), true)
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.completedAt, 20)
  assert.equal(row.completedAtSource, 'observed')
  assert.deepEqual(row.lastTurnEnd, { kind: 'completed', cause: null, at: 20, seq: 7 })
})

test('aborted + user never arms unread (R12) but records the fact', t => {
  const store = storeFor(t)
  store.applyStatus('s1', true, 10)
  const [edge] = store.applyStatus('s1', false, 20)
  store.settleCompletion(edge!, {
    at: 20, turnEnd: { kind: 'aborted', cause: 'user', at: 20, seq: 8 }, unreadable: false,
  })
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.completedAt, null)
  assert.equal(row.completedAtSource, null)
  assert.equal(row.lastTurnEnd?.kind, 'aborted')
  assert.equal(row.lastTurnEnd?.cause, 'user')
})

test('neutral turn-end kinds (blocked/error/max-tokens/interrupted, aborted non-user) arm nothing', t => {
  for (const reason of [
    { kind: 'blocked' },
    { kind: 'error', error: { message: 'boom' } },
    { kind: 'max-tokens' },
    { kind: 'interrupted' },
    { kind: 'aborted', reason: { kind: 'parent' } },
    { kind: 'aborted', reason: { kind: 'legacy' } },
  ]) {
    const store = storeFor(t)
    store.applyStatus('s1', true, 10)
    const [edge] = store.applyStatus('s1', false, 20)
    store.settleCompletion(edge!, {
      at: 20,
      turnEnd: {
        kind: reason.kind as 'blocked',
        cause: reason.kind === 'aborted' ? (reason as { reason: { kind: 'parent' } }).reason.kind as 'parent' : null,
        at: 20,
        seq: 9,
      },
      unreadable: false,
    })
    const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
    assert.equal(row.completedAt, null, reason.kind + ' must not arm unread')
  }
})

test('an unreadable tail falls back to arming with a null lastTurnEnd marker', t => {
  const store = storeFor(t)
  store.applyStatus('s1', true, 10)
  const [edge] = store.applyStatus('s1', false, 20)
  store.settleCompletion(edge!, { at: 20, turnEnd: null, unreadable: true })
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.completedAt, 20)
  assert.equal(row.completedAtSource, 'reconstructed')
  assert.equal(row.lastTurnEnd, null, 'the degraded marker is an absent fact, never a fabricated one')
})

test('a new running edge resolves the previous completion', t => {
  const store = storeFor(t)
  store.applyStatus('s1', true, 10)
  const [edge] = store.applyStatus('s1', false, 20)
  store.settleCompletion(edge!, { at: 20, turnEnd: { kind: 'completed', cause: null, at: 20, seq: 7 }, unreadable: false })
  store.applyStatus('s1', true, 30)
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.completedAt, null)
  assert.equal(row.completedAtSource, null)
  assert.equal(row.lastTurnEnd, null)
})

test('a stale follow cannot settle a newer run or a later prompt', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 100)], { at: 10 })
  const [oldEdge] = store.applyStatus('s1', false, 20)
  store.applyStatus('s1', true, 30)
  assert.equal(store.settleCompletion(oldEdge!, {
    at: 31, turnEnd: { kind: 'completed', cause: null, at: 31, seq: 1 }, unreadable: false,
  }), false)
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions[0]?.running, true)

  const [newEdge] = store.applyStatus('s1', false, 40)
  assert.equal(store.applyActivity('s1', 200.5, 41), false,
    'a fractional host watermark cannot revoke the pending edge')
  store.applyActivity('s1', 200, 41)
  assert.equal(store.settleCompletion(newEdge!, {
    at: 42, turnEnd: { kind: 'completed', cause: null, at: 42, seq: 2 }, unreadable: false,
  }), false)
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row?.completedAt, null)
  assert.equal(row?.updatedAt, 200)
})

test('an unreadable outcome stays pending, then a classified tail settles the same edge', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 100)], { at: 10 })
  const [edge] = store.applyStatus('s1', false, 20)
  assert.equal(store.settleCompletion(edge!, { at: 21, turnEnd: null, unreadable: true }), true)
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions[0]?.completedAtSource, 'reconstructed')
  const retry = store.applyBaseline([baselineItem('s1', false, 100)], { at: 30 })
  assert.equal(retry[0], edge, 'the same edge must be retried, not replaced')
  assert.equal(store.settleCompletion(edge!, { at: 31, turnEnd: null, unreadable: true }), false,
    'a repeated timeout must not move the unread watermark')
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions[0]?.completedAt, 21)
  assert.equal(store.settleCompletion(edge!, {
    at: 40, turnEnd: { kind: 'completed', cause: null, at: 40, seq: 3 }, unreadable: false,
  }), true)
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions[0]?.completedAtSource, 'observed')
  assert.deepEqual(store.applyBaseline([baselineItem('s1', false, 100)], { at: 50 }), [])
})

test('a newer prompt clears an old completion without a false-to-false notification', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 100)], { at: 10 })
  const [edge] = store.applyStatus('s1', false, 20)
  store.settleCompletion(edge!, { at: 21, turnEnd: { kind: 'completed', cause: null, at: 21, seq: 1 }, unreadable: false })
  assert.deepEqual(store.applyBaseline([baselineItem('s1', false, 200)], { at: 30 }), [])
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row?.completedAt, null)
  assert.equal(row?.completedAtSource, null)
  assert.equal(row?.updatedAt, 200)
})

// ---------------------------------------------------------------------------
// Baseline reconciliation + gap reconstruction (R3, section 5.2)
// ---------------------------------------------------------------------------

test('baseline merges rows, tracks subagentCount and the running edge', t => {
  const store = storeFor(t)
  const edges = store.applyBaseline([
    baselineItem('parent', true, 5, { running: true }),
    baselineItem('child', false, 4, { origin: 'subagent', parentSessionId: 'parent' }),
  ], { at: 100 })
  assert.deepEqual(edges, [])
  const rows = store.snapshotFor(null, 'sse', store.host()).sessions
  const parent = rows.find(row => row.sessionId === 'parent')
  assert.equal(parent?.subagentCount, 1)
  assert.equal(parent?.updatedAt, 5)
})

test('a baseline that reports a stopped row emits an observed edge, not a completion', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  const edges = store.applyBaseline([baselineItem('s1', false, 5)], { at: 200 })
  assert.deepEqual(edges, [{ sessionId: 's1', source: 'observed' }])
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.completedAt, null, 'baseline never arms completedAt raw')
})

test('a stored running row found stopped after restart is a reconstructed edge (once)', async t => {
  const stateDir = scratch(t)
  const first = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  first.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  await first.flush()
  first.dispose()
  // Second store = observer restart; the running row is a gap candidate.
  const second = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 200 })
  const edges = second.applyBaseline([baselineItem('s1', false, 5)], { at: 200 })
  assert.deepEqual(edges, [{ sessionId: 's1', source: 'reconstructed' }])
  second.settleCompletion(edges[0]!, { at: 200, turnEnd: { kind: 'completed', cause: null, at: 200, seq: 3 }, unreadable: false })
  const row = second.snapshotFor(null, 'sse', second.host()).sessions[0]
  assert.equal(row.completedAt, 200)
  assert.equal(row.completedAtSource, 'reconstructed', 'gap completions are notification-ineligible')
  // The candidate is consumed: a later baseline transition is a live edge.
  second.applyBaseline([baselineItem('s1', true, 5)], { at: 300 })
  const live = second.applyBaseline([baselineItem('s1', false, 5)], { at: 400 })
  assert.deepEqual(live, [{ sessionId: 's1', source: 'observed' }])
})

test('removed clears completion and never arms unread (R13)', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  const [edge] = store.applyStatus('s1', false, 110)
  store.settleCompletion(edge!, { at: 110, turnEnd: { kind: 'completed', cause: null, at: 110, seq: 1 }, unreadable: false })
  assert.equal(store.applyRemoved('s1', 120), true)
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions.length, 0)
  assert.equal(store.readStateFor(null).marks['s1'], undefined)
})

test('a row missing from one complete baseline is hidden, then pruned on the next (deletion is not a completion)', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  const removed: string[] = []
  store.subscribe(delta => removed.push(...delta.removedSessionIds))
  // First complete baseline without the row: absent, armed nothing.
  const firstEdges = store.applyBaseline([], { at: 200 })
  assert.deepEqual(firstEdges, [], 'a vanished row is not a completion edge')
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions.length, 0)
  assert.deepEqual(removed, [], 'not pruned on the first miss')
  // Second complete baseline without the row: pruned + removal delta.
  store.applyBaseline([], { at: 300 })
  assert.deepEqual(removed, ['s1'])
})

test('pending facts are applied and cleared without touching completion state', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5)], { at: 100 })
  assert.equal(store.applyPending('s1', 'approval', 110), true)
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions[0].pendingKind, 'approval')
  assert.equal(store.clearPending('s1', 120), true)
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions[0].pendingKind, null)
})

// ---------------------------------------------------------------------------
// Read marks (R4/R10/R13/R22)
// ---------------------------------------------------------------------------

test('read marks are per-client, monotonic, idempotent and source-wide effective', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5)], { at: 100 })
  const first = store.markRead('client-a', 's1', 500, 110)
  assert.deepEqual(first, { changed: true, stored: true, readThrough: 500 })
  const repeat = store.markRead('client-a', 's1', 500, 111)
  assert.equal(repeat.changed, false)
  const lower = store.markRead('client-a', 's1', 100, 112)
  assert.deepEqual(lower, { changed: false, stored: true, readThrough: 500 })
  store.markRead('client-b', 's1', 900, 113)
  assert.equal(store.readStateFor('client-b').marks['s1'], 900)
  // A mark for an unknown session is accepted but not stored (no row growth).
  assert.deepEqual(store.markRead('client-a', 'missing', 50, 114), { changed: false, stored: false, readThrough: 0 })
})

test('read-all stores the source floor so late rows below it are read (R13)', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5)], { at: 100 })
  const first = store.markAllRead('phone', 5_000, 110)
  assert.equal(first.changed, true)
  assert.equal(first.through, 5_000)
  assert.equal(store.markAllRead('phone', 4_000, 120).changed, false, 'only-increasing')
  // A late row whose watermark is below the floor is read without any new POST.
  store.applyActivity('s2', 4_000, 130)
  assert.equal(store.readStateFor('phone').floor, 5_000)
})

test('read-all counts rows inside the floor (the visible updated count)', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 10), baselineItem('s2', false, 20)], { at: 100 })
  const outcome = store.markAllRead('client', 15, 110)
  assert.equal(outcome.updated, 1, 'only s1 (watermark 10) is inside floor 15')
})

// ---------------------------------------------------------------------------
// Cursor ring (SSE resume)
// ---------------------------------------------------------------------------

test('replayFrom distinguishes satisfiable, current, future and expired cursors', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5)], { at: 100 })
  const cursor = store.snapshotFor(null, 'sse', store.host()).cursor
  assert.deepEqual(store.replayFrom(cursor), [])
  assert.equal(store.replayFrom(cursor + 1), null, 'a future cursor is not satisfiable')
  assert.equal(store.replayFrom(cursor - 1)?.length, 1)
  // Push the ring past its window, then ask for a cursor it no longer holds.
  for (let index = 0; index < 1_100; index += 1) store.applyActivity('s1', 6 + index, 200 + index)
  assert.equal(store.replayFrom(cursor - 1), null, 'expired cursors fall back to a snapshot')
})

// ---------------------------------------------------------------------------
// Feature advertisement + host mapping
// ---------------------------------------------------------------------------

test('normalizeHostState maps unknown plane states to unknown', () => {
  assert.equal(normalizeHostState('ready'), 'ready')
  assert.equal(normalizeHostState('quarantined'), 'quarantined')
  assert.equal(normalizeHostState('weird-plane-state'), 'unknown')
})

test('host-down keeps rows but flips serviceable false', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  assert.equal(store.setHost({ state: 'stopped', serviceable: false }), true)
  const snapshot = store.snapshotFor(null, 'sse', store.host())
  assert.equal(snapshot.host.serviceable, false)
  assert.equal(snapshot.host.state, 'stopped')
  assert.equal(snapshot.sessions.length, 1, 'rows survive host-down as unknown, not deleted')
})

// ---------------------------------------------------------------------------
// Route constant/body parsing boundaries
// ---------------------------------------------------------------------------

test('protocol paths and gateway SSE limits are pinned', () => {
  assert.equal(SESSION_STATE_PATH, '/chamber/session-state')
  assert.equal(SESSION_STATE_STREAM_PATH, '/chamber/session-state/stream')
  assert.equal(SESSION_STATE_READ_ALL_PATH, '/chamber/session-state/read-all')
  assert.equal(MAX_SSE_STREAMS, 32)
  assert.equal(MAX_SSE_PENDING_FRAMES, 32)
  assert.equal(SSE_KEEPALIVE_MS, 20_000)
  assert.equal(DEFAULT_EVENT_SILENCE_MS, 45_000)
})

test('parseReadRequestBody rejects every malformed shape and accepts the exact one', () => {
  assert.deepEqual(parseReadRequestBody({ clientId: 'install-1', sessionId: 's1', readThrough: 5 }), {
    clientId: 'install-1', sessionId: 's1', readThrough: 5,
  })
  for (const bad of [
    null, [], 'x',
    { clientId: 'bad id', sessionId: 's1', readThrough: 5 },
    { clientId: 'ok', sessionId: '', readThrough: 5 },
    { clientId: 'ok', sessionId: 'a\u0000b', readThrough: 5 },
    { clientId: 'ok', sessionId: 's1', readThrough: -1 },
    { clientId: 'ok', sessionId: 's1', readThrough: 1.5 },
    { clientId: 'ok', sessionId: 's1', readThrough: Number.NaN },
    { clientId: 'ok', sessionId: 's1' },
  ]) {
    assert.equal(parseReadRequestBody(bad), null, JSON.stringify(bad))
  }
})

test('read-all requires the client through watermark (the server never computes now)', () => {
  assert.deepEqual(parseReadAllRequestBody({ clientId: 'install-1', through: 7 }), { clientId: 'install-1', through: 7 })
  assert.equal(parseReadAllRequestBody({ clientId: 'install-1' }), null)
  assert.equal(parseReadAllRequestBody({ clientId: 'install-1', through: -2 }), null)
  assert.equal(parseReadAllRequestBody({ clientId: '', through: 2 }), null)
})
