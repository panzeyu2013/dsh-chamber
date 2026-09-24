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
  MAX_PENDING_GOAL_ACTIVATIONS,
  MAX_SESSIONS,
  MAX_SSE_PENDING_FRAMES,
  MAX_SSE_STREAMS,
  SSE_KEEPALIVE_MS,
  createSessionStateStore,
  normalizeHostState,
  parseReadAllRequestBody,
  parseReadRequestBody,
} from '../../src/session-state.ts'
import { baselineItem, capturingLogger, scratch, silentLogger } from './harness.ts'

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
  store.applyStatus('s1', false, 20)
  assert.equal(store.settleCompletion('s1', {
    at: 20, turnEnd: { kind: 'completed', cause: null, at: 20, seq: 7 }, source: 'observed', unreadable: false,
  }), true)
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.completedAt, 20)
  assert.equal(row.completedAtSource, 'observed')
  assert.deepEqual(row.lastTurnEnd, { kind: 'completed', cause: null, at: 20, seq: 7 })
})

test('aborted + user never arms unread (R12) but records the fact', t => {
  const store = storeFor(t)
  store.applyStatus('s1', true, 10)
  store.applyStatus('s1', false, 20)
  store.settleCompletion('s1', {
    at: 20, turnEnd: { kind: 'aborted', cause: 'user', at: 20, seq: 8 }, source: 'observed', unreadable: false,
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
    store.applyStatus('s1', false, 20)
    store.settleCompletion('s1', {
      at: 20,
      turnEnd: {
        kind: reason.kind as 'blocked',
        cause: reason.kind === 'aborted' ? (reason as { reason: { kind: 'parent' } }).reason.kind as 'parent' : null,
        at: 20,
        seq: 9,
      },
      source: 'observed',
      unreadable: false,
    })
    const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
    assert.equal(row.completedAt, null, reason.kind + ' must not arm unread')
  }
})

test('an unreadable tail falls back to arming with a null lastTurnEnd marker', t => {
  const store = storeFor(t)
  store.applyStatus('s1', true, 10)
  store.applyStatus('s1', false, 20)
  store.settleCompletion('s1', { at: 20, turnEnd: null, source: 'observed', unreadable: true })
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.completedAt, 20)
  assert.equal(row.completedAtSource, 'observed')
  assert.equal(row.lastTurnEnd, null, 'the degraded marker is an absent fact, never a fabricated one')
})

test('a new running edge resolves the previous completion', t => {
  const store = storeFor(t)
  store.applyStatus('s1', true, 10)
  store.applyStatus('s1', false, 20)
  store.settleCompletion('s1', { at: 20, turnEnd: { kind: 'completed', cause: null, at: 20, seq: 7 }, source: 'observed', unreadable: false })
  store.applyStatus('s1', true, 30)
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.completedAt, null)
  assert.equal(row.completedAtSource, null)
  assert.equal(row.lastTurnEnd, null)
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
  second.settleCompletion('s1', { at: 200, turnEnd: { kind: 'completed', cause: null, at: 200, seq: 3 }, source: 'reconstructed', unreadable: false })
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
  store.applyStatus('s1', false, 110)
  store.settleCompletion('s1', { at: 110, turnEnd: { kind: 'completed', cause: null, at: 110, seq: 1 }, source: 'observed', unreadable: false })
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

test('the row-cap eviction announces a removal delta (an SSE client never keeps a phantom row)', async t => {
  const stateDir = scratch(t)
  const logger = capturingLogger()
  const store = createSessionStateStore({ stateDir, logger, now: () => 1_000 })
  const upserts: string[] = []
  const removed: string[] = []
  store.subscribe(delta => {
    upserts.push(...delta.sessions.map(row => row.sessionId))
    removed.push(...delta.removedSessionIds)
  })
  const items = Array.from({ length: MAX_SESSIONS + 1 }, (_, index) => baselineItem('cap-' + String(index), false, index + 1))
  store.applyBaseline(items, { at: 100 })
  assert.deepEqual(removed, [], 'the cap is enforced at persistence time, not in the baseline batch')
  await store.flush()
  assert.equal(store.status().sessions, MAX_SESSIONS)
  assert.equal(store.status().dropped.sessions, 1)
  assert.equal(logger.lines.some(line => line.includes('cap reached')), true)
  // 淘汰是删除而不是静默抹掉：客户端必须收到 removedSessionIds，否则留幻影行。
  assert.deepEqual(removed, ['cap-0'], 'the evicted oldest row is announced as removed')
  assert.equal(upserts.includes('cap-0'), true, 'the same client had seen the row before (delta, not snapshot fallback)')
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions.length, MAX_SESSIONS)
  // 该删除也进 replay ring：Last-Event-ID 续传同样拿到它。
  const cursor = store.status().cursor
  const replay = store.replayFrom(cursor - 1) ?? []
  assert.deepEqual(replay.flatMap(delta => delta.removedSessionIds), ['cap-0'])
  store.dispose()
})

// ---------------------------------------------------------------------------
// Goal facts (P2a): baseline refresh, removed cleanup, process-local activation
// ---------------------------------------------------------------------------

const activeGoal = (revision = 1, updatedAt = 5) => ({ goalId: 'goal-1', revision, phase: 'active' as const, updatedAt })

test('goal facts merge from the baseline, survive refreshes with their activation, and die with the row', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 5, { goal: activeGoal() })], { at: 100 })
  let row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 1, phase: 'active', updatedAt: 5 })

  // The activation edge is process-local and attaches to the known goal.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-1', activation: 'armed' }, 105), true)
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.goal?.activation, 'armed')

  // A refresh with the SAME goalId must keep the activation: the baseline
  // never carries activation, so overwriting would erase what the event taught.
  store.applyBaseline([baselineItem('s1', true, 5, { goal: activeGoal(2, 6) })], { at: 110 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 2, phase: 'active', updatedAt: 6, activation: 'armed' })

  // Unknown never overwrites knowledge: a projection-less row keeps the fact.
  store.applyBaseline([baselineItem('s1', true, 5)], { at: 120 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 2, phase: 'active', updatedAt: 6, activation: 'armed' })

  // An explicit null is a real fact: the host reports no current goal.
  store.applyBaseline([baselineItem('s1', true, 5, { goal: null })], { at: 130 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.goal, null)

  // removed drops the row and with it the goal fact (deltaRemoved, not a
  // silent field wipe).
  assert.equal(store.applyRemoved('s1', 140), true)
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions.length, 0)
})

test('a changed goalId drops the stale process-local activation; unknown rows are never fabricated', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 100 })
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-1', activation: 'armed' }, 101), true)
  // A NEW goal identity invalidates the activation learned for the old one.
  store.applyBaseline([baselineItem('s1', false, 5, {
    goal: { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7 },
  })], { at: 110 })
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.goal?.goalId, 'goal-2')
  assert.equal(row.goal?.activation, undefined)

  // An activation edge never creates a row or a goal fact.
  assert.equal(store.applyGoalActivation({ sessionId: 'missing', goalId: 'goal-1', activation: 'armed' }, 120), false)
  assert.equal(store.applyGoalActivation({ sessionId: 'missing', goalId: null, activation: null }, 121), false)
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions.length, 1)
})

test('clearGoalActivations degrades a known fact to unknown and a goal-less edge resolves it to null', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 100 })
  store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-1', activation: 'armed' }, 101)
  assert.equal(store.clearGoalActivations(102), true)
  let row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.goal?.goalId, 'goal-1')
  assert.equal(row.goal?.activation, undefined, 'a fresh epoch clears activation back to unknown')
  assert.equal(store.clearGoalActivations(103), false, 'idempotent')

  // A row whose goal is still UNKNOWN keeps its unknown state on a null edge
  // (never fabricate 'no goal' from an edge that may have outraced the baseline).
  store.applyStatus('s9', false, 104)
  assert.equal(store.applyGoalActivation({ sessionId: 's9', goalId: null, activation: null }, 105), false)
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions.find(entry => entry.sessionId === 's9')?.goal, undefined)

  // Once the fact is known, the goal-less edge is a real transition to null.
  store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-1', activation: 'armed' }, 106)
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: null, activation: null }, 107), true)
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.goal, null)
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: null, activation: null }, 108), false)

  // A retained edge (goal not yet projected) dies with the epoch as well.
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 109 })
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-5', activation: 'armed' }, 110), false)
  assert.equal(store.clearGoalActivations(111), false, 'a retained-only clear is not a wire change')
  store.applyBaseline([baselineItem('s1', false, 5, {
    goal: { goalId: 'goal-5', revision: 1, phase: 'active', updatedAt: 9 },
  })], { at: 112 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-5', revision: 1, phase: 'active', updatedAt: 9 })
})

test('P2a identity binding: a new goal activation never lands on the previous goal row', t => {
  const store = storeFor(t)
  // goal-1 has completed; its durable fact is still the only projection.
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 100 })
  store.applyStatus('s1', false, 110)
  store.settleCompletion('s1', {
    at: 110, turnEnd: { kind: 'completed', cause: null, at: 110, seq: 1 }, source: 'observed', unreadable: false,
  })
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions[0].completedAt, 110)

  // complete -> create: goal-2's armed edge arrives BEFORE the projection
  // catches up. It must not attach to goal-1: that produced the wire's
  // complete+armed row and a permanently unknown new goal.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-2', activation: 'armed' }, 120), false)
  let row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 1, phase: 'active', updatedAt: 5 })
  assert.equal(row.completedAt, 110, 'the previous goal fact is untouched')

  // A refresh still projecting goal-1 (the create has not reached session/list)
  // retains the edge, never applies it to the wrong identity.
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal(2, 6) })], { at: 121 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 2, phase: 'active', updatedAt: 6 })

  // The matching identity arrives in a baseline: the retained edge lands.
  store.applyBaseline([baselineItem('s1', true, 7, {
    goal: { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7 },
  })], { at: 122 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7, activation: 'armed' })

  // A matching re-edge with the same value is a no-op (the edge was consumed).
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-2', activation: 'armed' }, 123), false)

  // Changing the identity again never inherits the consumed activation.
  store.applyBaseline([baselineItem('s1', false, 8, {
    goal: { goalId: 'goal-3', revision: 1, phase: 'active', updatedAt: 8 },
  })], { at: 124 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-3', revision: 1, phase: 'active', updatedAt: 8 })
  assert.equal(row.goal?.activation, undefined)

  // The added path lands a retained edge too (an added frame can be the first
  // projection carrying the new goal).
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-4', activation: 'disarmed' }, 125), false)
  assert.equal(store.applyAdded(baselineItem('s1', false, 9, {
    goal: { goalId: 'goal-4', revision: 1, phase: 'paused', updatedAt: 9 },
  }), 126), true)
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-4', revision: 1, phase: 'paused', updatedAt: 9, activation: 'disarmed' })
})

test('P2a identity binding: removed and an explicit no-goal report drop retained edges', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 100 })
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-2', activation: 'armed' }, 110), false)

  // removed drops the row and the retained edge with it; a re-created session
  // projecting the same goal id never inherits the edge.
  assert.equal(store.applyRemoved('s1', 120), true)
  store.applyBaseline([baselineItem('s1', false, 5, {
    goal: { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7 },
  })], { at: 130 })
  let row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7 })

  // Another retained edge, then the host explicitly reports no goal: the known
  // fact resolves to null and the waiting edge dies with that report.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-3', activation: 'armed' }, 140), false)
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: null, activation: null }, 141), true)
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.goal, null)
  store.applyBaseline([baselineItem('s1', false, 5, {
    goal: { goalId: 'goal-3', revision: 1, phase: 'active', updatedAt: 8 },
  })], { at: 142 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-3', revision: 1, phase: 'active', updatedAt: 8 },
    'the no-goal report dropped the retained goal-3 edge')

  // An unbound edge (the wire carried no usable goal id) acts on the current
  // known goal, mirroring the renderer P2b parser.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: null, activation: 'disarmed' }, 143), true)
  row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.equal(row.goal?.activation, 'disarmed')
})

test('P2a retained edges: applyRemoved clears an edge whose row never existed (re-list never inherits)', t => {
  const store = storeFor(t)
  // An activation edge that outraced its create: no row exists, edge retained.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-1', activation: 'armed' }, 100), false)
  // removed arrives for that same still-unknown session id: the early return
  // (no row, no removal delta) must still drop the retained edge.
  assert.equal(store.applyRemoved('s1', 110), false, 'no row means no removal delta')
  // Re-listed projecting the same goal id: the stale edge must NOT land.
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 120 })
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 1, phase: 'active', updatedAt: 5 })
})

test('P2a retained edges: a row pruned by the second missing baseline drops its edge too', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 100 })
  // goal-2's edge is retained while the projection still names goal-1.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-2', activation: 'armed' }, 101), false)
  // First complete baseline without the row: hidden (present=false), edge kept.
  store.applyBaseline([], { at: 110 })
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions.length, 0)
  // Second miss: pruned; the retained edge must die with the row.
  store.applyBaseline([], { at: 120 })
  // Re-listed projecting goal-2: no inherited armed.
  store.applyBaseline([baselineItem('s1', false, 6, {
    goal: { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7 },
  })], { at: 130 })
  const row = store.snapshotFor(null, 'sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7 })
  assert.equal(row.goal?.activation, undefined, 'the pruned row must not leak its old edge into the re-created id')
})

test('P2a retained edges are capped: the oldest eviction is counted and warned (never unbounded)', t => {
  const stateDir = scratch(t)
  const logger = capturingLogger()
  const store = createSessionStateStore({ stateDir, logger, now: () => 1_000 })
  for (let index = 0; index <= MAX_PENDING_GOAL_ACTIVATIONS; index += 1) {
    assert.equal(store.applyGoalActivation({ sessionId: 'cap-' + String(index), goalId: 'goal-1', activation: 'armed' }, 100 + index), false)
  }
  assert.equal(store.status().dropped.goalActivations, 1, 'the cap eviction is counted')
  assert.equal(logger.lines.some(line => line.includes('goal-activation cap reached')), true, 'the cap eviction is loud')
  // The oldest edge (cap-0) was evicted; the newest survives.
  store.applyBaseline([baselineItem('cap-0', false, 5, { goal: activeGoal() })], { at: 300 })
  let row = store.snapshotFor(null, 'sse', store.host()).sessions.find(entry => entry.sessionId === 'cap-0')
  assert.equal(row?.goal?.activation, undefined, 'the evicted edge must not land')
  store.applyBaseline([baselineItem('cap-' + String(MAX_PENDING_GOAL_ACTIVATIONS), false, 5, { goal: activeGoal() })], { at: 301 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions.find(entry => entry.sessionId === 'cap-' + String(MAX_PENDING_GOAL_ACTIVATIONS))
  assert.equal(row?.goal?.activation, 'armed', 'the newest retained edge still lands')
})

test('P2a retained edges: updating an existing edge refreshes its retention order (LRU, not first-seen)', t => {
  const stateDir = scratch(t)
  const logger = capturingLogger()
  const store = createSessionStateStore({ stateDir, logger, now: () => 1_000 })
  for (let index = 0; index < MAX_PENDING_GOAL_ACTIVATIONS; index += 1) {
    assert.equal(
      store.applyGoalActivation({ sessionId: 'lru-' + String(index), goalId: 'goal-1', activation: 'armed' }, 100 + index),
      false,
    )
  }
  assert.equal(store.status().dropped.goalActivations, 0, 'filling to the cap evicts nothing')
  // 覆盖已有键必须刷新保留顺序：Map.set 不改插入序，首见的 lru-0 会被当成最旧。
  assert.equal(store.applyGoalActivation({ sessionId: 'lru-0', goalId: 'goal-1', activation: 'disarmed' }, 5_000), false)
  assert.equal(store.status().dropped.goalActivations, 0, 'an update is not an eviction and must not be counted as one')
  assert.equal(store.applyGoalActivation({ sessionId: 'lru-new', goalId: 'goal-1', activation: 'armed' }, 5_001), false)
  assert.equal(store.status().dropped.goalActivations, 1, 'only the true least-recently-updated edge is evicted')
  assert.equal(logger.lines.some(line => line.includes('goal-activation cap reached')), true, 'the eviction stays loud')
  // cap-0 的最新边存活；cap-1（刷新后真正最旧）成为淘汰对象；新登记键也存活。
  store.applyBaseline([baselineItem('lru-0', false, 5, { goal: activeGoal() })], { at: 6_000 })
  let row = store.snapshotFor(null, 'sse', store.host()).sessions.find(entry => entry.sessionId === 'lru-0')
  assert.equal(row?.goal?.activation, 'disarmed', 'the refreshed edge must not be evicted as the oldest')
  store.applyBaseline([baselineItem('lru-1', false, 5, { goal: activeGoal() })], { at: 6_001 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions.find(entry => entry.sessionId === 'lru-1')
  assert.equal(row?.goal?.activation, undefined, 'the new true oldest edge (lru-1) is the one evicted')
  store.applyBaseline([baselineItem('lru-new', false, 5, { goal: activeGoal() })], { at: 6_002 })
  row = store.snapshotFor(null, 'sse', store.host()).sessions.find(entry => entry.sessionId === 'lru-new')
  assert.equal(row?.goal?.activation, 'armed', 'the newest registration still lands')
  store.dispose()
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
