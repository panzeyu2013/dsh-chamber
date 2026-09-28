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
import { SESSION_STATE_PATH, SESSION_STATE_STREAM_PATH } from '@dsh-chamber/control-plane'
import {
  DEFAULT_EVENT_SILENCE_MS,
  MAX_PENDING_GOAL_ACTIVATIONS,
  MAX_SESSIONS,
  MAX_SSE_PENDING_FRAMES,
  MAX_SSE_STREAMS,
  SSE_KEEPALIVE_MS,
  createSessionStateStore,
  normalizeHostState,
} from '../../src/session-state.ts'
import { baselineItem, capturingLogger, scratch, silentLogger } from './harness.ts'

function storeFor(t: { after(fn: () => void): void }, now: () => number = () => 1_000): ReturnType<typeof createSessionStateStore> {
  return createSessionStateStore({ stateDir: scratch(t), logger: silentLogger, now })
}

/** 身份已确认的 store：一次成功基线把 s1 确认为顶层。S1 硬门之下，纯 status/activity
 *  用例建的行必须有**列表事实**（基线/added）背书才会投递——「本进程见过基线」不再是门票。 */
function storeWithList(t: { after(fn: () => void): void }, now: () => number = () => 1_000): ReturnType<typeof createSessionStateStore> {
  const store = storeFor(t, now)
  store.applyBaseline([baselineItem('s1', false, 1)], { at: 0 })
  return store
}

// ---------------------------------------------------------------------------
// Running edge + completion classification (R12)
// ---------------------------------------------------------------------------

test('status true -> false yields one edge and arms nothing before classification', t => {
  const store = storeWithList(t)
  assert.deepEqual(store.applyStatus('s1', true, 10), [])
  const edges = store.applyStatus('s1', false, 20)
  assert.deepEqual(edges, [{ sessionId: 's1', source: 'observed' }])
  const row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.running, false)
  assert.equal(row.completedAt, null, 'the raw edge never arms completedAt')
  assert.equal(row.lastRunningAt, 10)
  // A duplicate status(false) cannot produce a second edge (one follow per edge).
  assert.deepEqual(store.applyStatus('s1', false, 21), [])
})

test('a false status without a running edge produces no edge', t => {
  const store = storeWithList(t)
  assert.deepEqual(store.applyStatus('s1', false, 10), [])
  assert.equal(store.snapshotFor('sse', store.host()).sessions[0].completedAt, null)
})

test('completed arms completedAt with the observed source', t => {
  const store = storeWithList(t)
  store.applyStatus('s1', true, 10)
  const [edge] = store.applyStatus('s1', false, 20)
  assert.equal(store.settleCompletion(edge!, {
    at: 20, turnEnd: { kind: 'completed', cause: null, at: 20, seq: 7 }, unreadable: false,
  }), true)
  const row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.completedAt, 20)
  assert.equal(row.completedAtSource, 'observed')
  assert.deepEqual(row.lastTurnEnd, { kind: 'completed', cause: null, at: 20, seq: 7 })
})

test('aborted + user never arms unread (R12) but records the fact', t => {
  const store = storeWithList(t)
  store.applyStatus('s1', true, 10)
  const [edge] = store.applyStatus('s1', false, 20)
  store.settleCompletion(edge!, {
    at: 20, turnEnd: { kind: 'aborted', cause: 'user', at: 20, seq: 8 }, unreadable: false,
  })
  const row = store.snapshotFor('sse', store.host()).sessions[0]
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
    const store = storeWithList(t)
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
    const row = store.snapshotFor('sse', store.host()).sessions[0]
    assert.equal(row.completedAt, null, reason.kind + ' must not arm unread')
  }
})

test('an unreadable tail falls back to arming with a null lastTurnEnd marker', t => {
  const store = storeWithList(t)
  store.applyStatus('s1', true, 10)
  const [edge] = store.applyStatus('s1', false, 20)
  store.settleCompletion(edge!, { at: 20, turnEnd: null, unreadable: true })
  const row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.completedAt, 20)
  assert.equal(row.completedAtSource, 'reconstructed')
  assert.equal(row.lastTurnEnd, null, 'the degraded marker is an absent fact, never a fabricated one')
})

test('a new running edge resolves the previous completion', t => {
  const store = storeWithList(t)
  store.applyStatus('s1', true, 10)
  const [edge] = store.applyStatus('s1', false, 20)
  store.settleCompletion(edge!, { at: 20, turnEnd: { kind: 'completed', cause: null, at: 20, seq: 7 }, unreadable: false })
  store.applyStatus('s1', true, 30)
  const row = store.snapshotFor('sse', store.host()).sessions[0]
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
  assert.equal(store.snapshotFor('sse', store.host()).sessions[0]?.running, true)

  const [newEdge] = store.applyStatus('s1', false, 40)
  assert.equal(store.applyActivity('s1', 200.5, 41), false,
    'a fractional host watermark cannot revoke the pending edge')
  store.applyActivity('s1', 200, 41)
  assert.equal(store.settleCompletion(newEdge!, {
    at: 42, turnEnd: { kind: 'completed', cause: null, at: 42, seq: 2 }, unreadable: false,
  }), false)
  const row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row?.completedAt, null)
  assert.equal(row?.updatedAt, 200)
})

test('an unreadable outcome stays pending, then a classified tail settles the same edge', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 100)], { at: 10 })
  const [edge] = store.applyStatus('s1', false, 20)
  assert.equal(store.settleCompletion(edge!, { at: 21, turnEnd: null, unreadable: true }), true)
  assert.equal(store.snapshotFor('sse', store.host()).sessions[0]?.completedAtSource, 'reconstructed')
  const retry = store.applyBaseline([baselineItem('s1', false, 100)], { at: 30 })
  assert.equal(retry[0], edge, 'the same edge must be retried, not replaced')
  assert.equal(store.settleCompletion(edge!, { at: 31, turnEnd: null, unreadable: true }), false,
    'a repeated timeout must not move the unread watermark')
  assert.equal(store.snapshotFor('sse', store.host()).sessions[0]?.completedAt, 21)
  assert.equal(store.settleCompletion(edge!, {
    at: 40, turnEnd: { kind: 'completed', cause: null, at: 40, seq: 3 }, unreadable: false,
  }), true)
  assert.equal(store.snapshotFor('sse', store.host()).sessions[0]?.completedAtSource, 'observed')
  assert.deepEqual(store.applyBaseline([baselineItem('s1', false, 100)], { at: 50 }), [])
})

test('a newer prompt clears an old completion without a false-to-false notification', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 100)], { at: 10 })
  const [edge] = store.applyStatus('s1', false, 20)
  store.settleCompletion(edge!, { at: 21, turnEnd: { kind: 'completed', cause: null, at: 21, seq: 1 }, unreadable: false })
  assert.deepEqual(store.applyBaseline([baselineItem('s1', false, 200)], { at: 30 }), [])
  const row = store.snapshotFor('sse', store.host()).sessions[0]
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
  const rows = store.snapshotFor('sse', store.host()).sessions
  const parent = rows.find(row => row.sessionId === 'parent')
  assert.equal(parent?.subagentCount, 1)
  assert.equal(parent?.updatedAt, 5)
})

test('subagent rows never ride the wire (snapshot or delta) yet still count', t => {
  const store = storeFor(t)
  const deltaRows: string[][] = []
  store.subscribe(delta => deltaRows.push(delta.sessions.map(row => row.sessionId)))
  store.applyBaseline([
    baselineItem('parent', true, 5, { running: true }),
    baselineItem('child', false, 4, { origin: 'subagent', parentSessionId: 'parent' }),
  ], { at: 100 })
  const rows = store.snapshotFor('sse', store.host()).sessions
  assert.deepEqual(rows.map(row => row.sessionId), ['parent'])
  assert.equal(rows[0]?.subagentCount, 1)
  assert.deepEqual(deltaRows.flat().filter(id => id === 'child'), [], 'the child row must never be delivered')
})

test('a row exposed before its subagent origin is revealed gets an explicit removal', t => {
  const store = storeFor(t)
  const removed: string[] = []
  store.subscribe(delta => removed.push(...delta.removedSessionIds))
  store.applyStatus('child', true, 10)
  // 首基线先把该 id 确认为顶层：门开、行上线（首基线前它会被 S1 门扣下）。
  store.applyBaseline([baselineItem('child', true, 10)], { at: 15 })
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions.map(row => row.sessionId), ['child'])
  store.applyBaseline([baselineItem('child', true, 10, { origin: 'subagent', parentSessionId: 'parent' })], { at: 20 })
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions.map(row => row.sessionId), [])
  assert.ok(removed.includes('child'), 'the transition to subagent retracts the exposed row')
})

test('a first-seen subagent row is never announced as a removal (no phantom retraction)', t => {
  const store = storeFor(t)
  const deltas: Array<{ sessions: string[]; removed: string[] }> = []
  store.subscribe(delta => deltas.push({ sessions: delta.sessions.map(row => row.sessionId), removed: [...delta.removedSessionIds] }))
  store.applyBaseline([
    baselineItem('parent', true, 5, { running: true }),
    baselineItem('child', false, 4, { origin: 'subagent', parentSessionId: 'parent' }),
  ], { at: 100 })
  assert.deepEqual(deltas, [{ sessions: ['parent'], removed: [] }],
    'a row that never rode the wire must not be retracted')
})

test('S1: a status-created row is withheld until the first complete baseline confirms its origin', t => {
  const store = storeFor(t)
  const deltas: Array<{ sessions: string[]; removed: string[] }> = []
  store.subscribe(delta => deltas.push({
    sessions: delta.sessions.map(row => row.sessionId),
    removed: [...delta.removedSessionIds],
  }))
  // ① 首基线前的 status 行：身份未确认（可能是子代理），快照与增量都不可见。
  store.applyStatus('child', true, 10)
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions, [],
    'a pre-baseline status row must not ride the snapshot')
  assert.deepEqual(deltas.flatMap(delta => delta.sessions), [], 'nor any delta')
  // ② 首基线把该 id 确认为顶层：门开，行按真实 running 位上线。
  store.applyBaseline([baselineItem('child', true, 10)], { at: 20 })
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions.map(row => row.sessionId), ['child'])
  assert.deepEqual(deltas.at(-1), { sessions: ['child'], removed: [] })
  // ③ 下一份基线揭示它是 subagent：不投递，并为已上线的行补 removed。
  store.applyBaseline([baselineItem('child', true, 10, { origin: 'subagent', parentSessionId: 'parent' })], { at: 30 })
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions.map(row => row.sessionId), [])
  assert.deepEqual(deltas.at(-1), { sessions: [], removed: ['child'] },
    'the revealed subagent row is retracted with an explicit removal')
  // ④ 首基线之后由 status 新建的行：身份仍未由列表事实确认（added 丢失窗口）⇒ 扣下、
  // 游标不前进（这是 S1 的硬约束：子代理绝不通知；代价是新会话最晚等一次基线）。
  const beforeWithheld = deltas.length
  store.applyStatus('live', true, 40)
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions.map(row => row.sessionId), [])
  assert.equal(deltas.length, beforeWithheld, 'a withheld row must not advance the cursor (no delta at all)')
  // ⑤ added（列表事实的增量形态）确认的同一拍补投该行。
  store.applyAdded(baselineItem('live', true, 40), 41)
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions.map(row => row.sessionId), ['live'])
  assert.deepEqual(deltas.at(-1), { sessions: ['live'], removed: [] },
    'the confirming added must carry the newly-deliverable row in its own delta')
  // ⑥ 基线确认同样立即补投（不只在后续整量快照里可见）。
  store.applyStatus('bg', false, 50)
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions.map(row => row.sessionId), ['live'])
  store.applyBaseline([baselineItem('live', true, 40), baselineItem('bg', false, 50)], { at: 60 })
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions.map(row => row.sessionId).sort(), ['bg', 'live'])
  assert.deepEqual(deltas.at(-1), { sessions: ['bg'], removed: [] },
    'the confirming baseline must carry the newly-deliverable row in its own delta')
})

test('S1: a subagent status->idle with a lost added frame never reaches the wire or a delta (identity unconfirmed)', t => {
  const store = storeFor(t)
  const deltas: Array<{ sessions: string[]; removed: string[] }> = []
  store.subscribe(delta => deltas.push({
    sessions: delta.sessions.map(row => row.sessionId),
    removed: [...delta.removedSessionIds],
  }))
  // added 帧丢失：子代理的 status 先到，身份未知——凭它判就会为子代理发真横幅。
  store.applyStatus('child', true, 10)
  store.applyStatus('child', false, 20)
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions, [],
    'the true->false edge of an unconfirmed row must not ride the snapshot')
  assert.deepEqual(deltas, [], 'no delta may be emitted for a withheld row (the cursor stays put)')
  // 基线揭穿身份：从未上线的行删除时静默（幽灵撤回比沉默更糟）。
  store.applyBaseline([baselineItem('child', false, 20, { origin: 'subagent', parentSessionId: 'parent' })], { at: 30 })
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions, [])
  assert.deepEqual(deltas.at(-1), { sessions: [], removed: [] },
    'a never-delivered row is never announced as a removal')
})

test('S1: a pre-baseline status row missing from the first baseline is deleted silently (never a phantom removal)', t => {
  const store = storeFor(t)
  const deltas: Array<{ sessions: string[]; removed: string[] }> = []
  store.subscribe(delta => deltas.push({
    sessions: delta.sessions.map(row => row.sessionId),
    removed: [...delta.removedSessionIds],
  }))
  store.applyStatus('ghost', false, 10)
  // 从未上线 ⇒ 单阶段删除也绝不补 removed（补 = 幽灵撤回）。
  store.applyBaseline([], { at: 20 })
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions, [])
  assert.deepEqual(deltas.at(-1), { sessions: [], removed: [] })
})

test('S1: the first baseline that confirms a withheld row rides that same delta (the gate opening is a delivery change)', t => {
  const store = storeFor(t)
  const deltas: Array<{ sessions: string[]; removed: string[] }> = []
  store.subscribe(delta => deltas.push({
    sessions: delta.sessions.map(row => row.sessionId),
    removed: [...delta.removedSessionIds],
  }))
  // activity 建行（updatedAt 已就位）⇒ 被门扣下：快照不可见。
  store.applyActivity('quiet', 7, 10)
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions, [])
  // 首基线带同一 id、同一 updatedAt（没有任何字段变化）：门开本身必须让该行上线——
  // 否则它会静默转成可投递，只被后续整量快照看见，delta-only 客户端缺这一行。
  store.applyBaseline([baselineItem('quiet', false, 7)], { at: 20 })
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions.map(row => row.sessionId), ['quiet'])
  assert.deepEqual(deltas.at(-1), { sessions: ['quiet'], removed: [] },
    'the confirming baseline must carry the newly-deliverable row in its own delta')
})

test('a subagent row that becomes top-level again rides the delta even when nothing else changed', t => {
  const store = storeFor(t)
  const deltas: string[][] = []
  store.subscribe(delta => deltas.push(delta.sessions.map(row => row.sessionId)))
  store.applyBaseline([baselineItem('child', false, 4, { origin: 'subagent', parentSessionId: 'parent' })], { at: 100 })
  store.applyBaseline([baselineItem('child', false, 4)], { at: 200 })
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions.map(row => row.sessionId), ['child'])
  assert.deepEqual(deltas.at(-1), ['child'], 'the reverse transition must reach delta-only clients')
})

test('a baseline that reports a stopped row emits an observed edge, not a completion', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  const edges = store.applyBaseline([baselineItem('s1', false, 5)], { at: 200 })
  assert.deepEqual(edges, [{ sessionId: 's1', source: 'observed' }])
  const row = store.snapshotFor('sse', store.host()).sessions[0]
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
  const row = second.snapshotFor('sse', second.host()).sessions[0]
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
  assert.equal(store.snapshotFor('sse', store.host()).sessions.length, 0)
})

test('a row missing from one complete baseline is removed immediately, never delivered as running:false (deletion is not a completion)', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  const deltas: Array<{ sessions: Array<{ sessionId: string; running: boolean }>; removed: string[] }> = []
  store.subscribe(delta => deltas.push({
    sessions: delta.sessions.map(row => ({ sessionId: row.sessionId, running: row.running })),
    removed: [...delta.removedSessionIds],
  }))
  // S3 单阶段删除（上游 ready-即删对齐）：一次**成功且完整**的基线缺席立即离表。删除不是
  // 完成——不发 running:false（wire 行没有 absent 位，那会被无壳判定读成 host running→idle
  // 边沿，产假蓝点）、不产完成边沿，客户端靠 removedSessionIds 清行 + 清臂 + 随行退役记忆。
  const edges = store.applyBaseline([], { at: 200 })
  assert.deepEqual(edges, [], 'a vanished row is not a completion edge')
  assert.equal(store.snapshotFor('sse', store.host()).sessions.length, 0)
  assert.deepEqual(deltas.at(-1), { sessions: [], removed: ['s1'] },
    'the single missing baseline removes the row without ever projecting a stop edge')
  // Re-listed: a fresh row rides the wire with its real running bit (old completion/arm
  // state died with the removed row; nothing is inherited).
  store.applyBaseline([baselineItem('s1', true, 6)], { at: 400 })
  assert.deepEqual(deltas.at(-1), { sessions: [{ sessionId: 's1', running: true }], removed: [] })
})

test('T5: removing a never-delivered row is silent (no phantom removal delta)', t => {
  const store = storeFor(t)
  const removed: string[] = []
  store.subscribe(delta => removed.push(...delta.removedSessionIds))
  // 仅由 status 首建、身份未确认的行从未上线：显式移除不补 removed（幽灵撤回比沉默更糟）。
  store.applyStatus('ghost', true, 10)
  assert.equal(store.applyRemoved('ghost', 20), true, 'the row is still removed from the store')
  assert.deepEqual(removed, [], 'never-delivered ⇒ no removedSessionIds')
  // 曾可投递的行照常补撤回（同一门槛的另一半）。
  store.applyBaseline([baselineItem('live', false, 5)], { at: 30 })
  store.applyRemoved('live', 40)
  assert.deepEqual(removed, ['live'])
})

test('T5: row-cap eviction retracts only ever-delivered rows, never a never-delivered one', async t => {
  const stateDir = scratch(t)
  const logger = capturingLogger()
  const store = createSessionStateStore({ stateDir, logger, now: () => 1_000 })
  const removed: string[] = []
  store.subscribe(delta => removed.push(...delta.removedSessionIds))
  // 一整份基线：这些行曾可投递（observedAt 都是基线时刻 1）。
  const confirmed = Array.from({ length: MAX_SESSIONS }, (_, index) => baselineItem('seen-' + String(index), false, 1))
  store.applyBaseline(confirmed, { at: 1 })
  removed.length = 0
  // 基线之后的 status 行身份未确认、从未上线（observedAt 2..）；再建 2001 行使总行数越界。
  for (let index = 0; index <= MAX_SESSIONS; index += 1) store.applyStatus('ghost-' + String(index), true, 2 + index)
  await store.flush()
  assert.equal(store.status().sessions, MAX_SESSIONS)
  assert.equal(store.status().dropped.sessions, MAX_SESSIONS + 1)
  assert.deepEqual([...removed].sort(), confirmed.map(item => item.sessionId).sort(),
    '曾可投递的 2000 行全部补撤回；最老的未确认行（ghost-0）静默淘汰，不补幽灵撤回')
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
  assert.equal(store.snapshotFor('sse', store.host()).sessions.length, MAX_SESSIONS)
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
  let row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 1, phase: 'active', updatedAt: 5 })

  // The activation edge is process-local and attaches to the known goal.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-1', activation: 'armed' }, 105), true)
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.goal?.activation, 'armed')

  // A refresh with the SAME goalId must keep the activation: the baseline
  // never carries activation, so overwriting would erase what the event taught.
  store.applyBaseline([baselineItem('s1', true, 5, { goal: activeGoal(2, 6) })], { at: 110 })
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 2, phase: 'active', updatedAt: 6, activation: 'armed' })

  // Unknown never overwrites knowledge: a projection-less row keeps the fact.
  store.applyBaseline([baselineItem('s1', true, 5)], { at: 120 })
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 2, phase: 'active', updatedAt: 6, activation: 'armed' })

  // An explicit null is a real fact: the host reports no current goal.
  store.applyBaseline([baselineItem('s1', true, 5, { goal: null })], { at: 130 })
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.goal, null)

  // removed drops the row and with it the goal fact (deltaRemoved, not a
  // silent field wipe).
  assert.equal(store.applyRemoved('s1', 140), true)
  assert.equal(store.snapshotFor('sse', store.host()).sessions.length, 0)
})

test('a changed goalId drops the stale process-local activation; unknown rows are never fabricated', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 100 })
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-1', activation: 'armed' }, 101), true)
  // A NEW goal identity invalidates the activation learned for the old one.
  store.applyBaseline([baselineItem('s1', false, 5, {
    goal: { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7 },
  })], { at: 110 })
  const row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.goal?.goalId, 'goal-2')
  assert.equal(row.goal?.activation, undefined)

  // An activation edge never creates a row or a goal fact.
  assert.equal(store.applyGoalActivation({ sessionId: 'missing', goalId: 'goal-1', activation: 'armed' }, 120), false)
  assert.equal(store.applyGoalActivation({ sessionId: 'missing', goalId: null, activation: null }, 121), false)
  assert.equal(store.snapshotFor('sse', store.host()).sessions.length, 1)
})

test('clearGoalActivations degrades a known fact to unknown and a goal-less edge resolves it to null', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 100 })
  store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-1', activation: 'armed' }, 101)
  assert.equal(store.clearGoalActivations(102), true)
  let row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.goal?.goalId, 'goal-1')
  assert.equal(row.goal?.activation, undefined, 'a fresh epoch clears activation back to unknown')
  assert.equal(store.clearGoalActivations(103), false, 'idempotent')

  // A row whose goal is still UNKNOWN keeps its unknown state on a null edge
  // (never fabricate 'no goal' from an edge that may have outraced the baseline).
  store.applyStatus('s9', false, 104)
  assert.equal(store.applyGoalActivation({ sessionId: 's9', goalId: null, activation: null }, 105), false)
  assert.equal(store.snapshotFor('sse', store.host()).sessions.find(entry => entry.sessionId === 's9')?.goal, undefined)

  // Once the fact is known, the goal-less edge is a real transition to null.
  store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-1', activation: 'armed' }, 106)
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: null, activation: null }, 107), true)
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.goal, null)
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: null, activation: null }, 108), false)

  // A retained edge (goal not yet projected) dies with the epoch as well.
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 109 })
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-5', activation: 'armed' }, 110), false)
  assert.equal(store.clearGoalActivations(111), false, 'a retained-only clear is not a wire change')
  store.applyBaseline([baselineItem('s1', false, 5, {
    goal: { goalId: 'goal-5', revision: 1, phase: 'active', updatedAt: 9 },
  })], { at: 112 })
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-5', revision: 1, phase: 'active', updatedAt: 9 })
})

test('P2a identity binding: a new goal activation never lands on the previous goal row', t => {
  const store = storeFor(t)
  // goal-1 has completed; its durable fact is still the only projection.
  store.applyBaseline([baselineItem('s1', true, 5, { goal: activeGoal() })], { at: 100 })
  const [edge] = store.applyStatus('s1', false, 110)
  store.settleCompletion(edge!, {
    at: 110, turnEnd: { kind: 'completed', cause: null, at: 110, seq: 1 }, unreadable: false,
  })
  assert.equal(store.snapshotFor('sse', store.host()).sessions[0].completedAt, 110)

  // complete -> create: goal-2's armed edge arrives BEFORE the projection
  // catches up. It must not attach to goal-1: that produced the wire's
  // complete+armed row and a permanently unknown new goal.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-2', activation: 'armed' }, 120), false)
  let row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 1, phase: 'active', updatedAt: 5 })
  assert.equal(row.completedAt, 110, 'the previous goal fact is untouched')

  // A refresh still projecting goal-1 (the create has not reached session/list)
  // retains the edge, never applies it to the wrong identity.
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal(2, 6) })], { at: 121 })
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 2, phase: 'active', updatedAt: 6 })

  // The matching identity arrives in a baseline: the retained edge lands.
  store.applyBaseline([baselineItem('s1', true, 7, {
    goal: { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7 },
  })], { at: 122 })
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7, activation: 'armed' })

  // A matching re-edge with the same value is a no-op (the edge was consumed).
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-2', activation: 'armed' }, 123), false)

  // Changing the identity again never inherits the consumed activation.
  store.applyBaseline([baselineItem('s1', false, 8, {
    goal: { goalId: 'goal-3', revision: 1, phase: 'active', updatedAt: 8 },
  })], { at: 124 })
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-3', revision: 1, phase: 'active', updatedAt: 8 })
  assert.equal(row.goal?.activation, undefined)

  // The added path lands a retained edge too (an added frame can be the first
  // projection carrying the new goal).
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-4', activation: 'disarmed' }, 125), false)
  assert.equal(store.applyAdded(baselineItem('s1', false, 9, {
    goal: { goalId: 'goal-4', revision: 1, phase: 'paused', updatedAt: 9 },
  }), 126), true)
  row = store.snapshotFor('sse', store.host()).sessions[0]
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
  let row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7 })

  // Another retained edge, then the host explicitly reports no goal: the known
  // fact resolves to null and the waiting edge dies with that report.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-3', activation: 'armed' }, 140), false)
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: null, activation: null }, 141), true)
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.goal, null)
  store.applyBaseline([baselineItem('s1', false, 5, {
    goal: { goalId: 'goal-3', revision: 1, phase: 'active', updatedAt: 8 },
  })], { at: 142 })
  row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-3', revision: 1, phase: 'active', updatedAt: 8 },
    'the no-goal report dropped the retained goal-3 edge')

  // An unbound edge (the wire carried no usable goal id) acts on the current
  // known goal, mirroring the renderer P2b parser.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: null, activation: 'disarmed' }, 143), true)
  row = store.snapshotFor('sse', store.host()).sessions[0]
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
  const row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.deepEqual(row.goal, { goalId: 'goal-1', revision: 1, phase: 'active', updatedAt: 5 })
})

test('P2a retained edges: a row missing from one complete baseline drops its edge too', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5, { goal: activeGoal() })], { at: 100 })
  // goal-2's edge is retained while the projection still names goal-1.
  assert.equal(store.applyGoalActivation({ sessionId: 's1', goalId: 'goal-2', activation: 'armed' }, 101), false)
  // One complete baseline without the row: single-phase removal; the retained edge must die
  // with the row (the row and its edge leave the store in the same step, S3).
  store.applyBaseline([], { at: 110 })
  assert.equal(store.snapshotFor('sse', store.host()).sessions.length, 0)
  // Re-listed projecting goal-2: no inherited armed.
  store.applyBaseline([baselineItem('s1', false, 6, {
    goal: { goalId: 'goal-2', revision: 1, phase: 'active', updatedAt: 7 },
  })], { at: 130 })
  const row = store.snapshotFor('sse', store.host()).sessions[0]
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
  let row = store.snapshotFor('sse', store.host()).sessions.find(entry => entry.sessionId === 'cap-0')
  assert.equal(row?.goal?.activation, undefined, 'the evicted edge must not land')
  store.applyBaseline([baselineItem('cap-' + String(MAX_PENDING_GOAL_ACTIVATIONS), false, 5, { goal: activeGoal() })], { at: 301 })
  row = store.snapshotFor('sse', store.host()).sessions.find(entry => entry.sessionId === 'cap-' + String(MAX_PENDING_GOAL_ACTIVATIONS))
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
  let row = store.snapshotFor('sse', store.host()).sessions.find(entry => entry.sessionId === 'lru-0')
  assert.equal(row?.goal?.activation, 'disarmed', 'the refreshed edge must not be evicted as the oldest')
  store.applyBaseline([baselineItem('lru-1', false, 5, { goal: activeGoal() })], { at: 6_001 })
  row = store.snapshotFor('sse', store.host()).sessions.find(entry => entry.sessionId === 'lru-1')
  assert.equal(row?.goal?.activation, undefined, 'the new true oldest edge (lru-1) is the one evicted')
  store.applyBaseline([baselineItem('lru-new', false, 5, { goal: activeGoal() })], { at: 6_002 })
  row = store.snapshotFor('sse', store.host()).sessions.find(entry => entry.sessionId === 'lru-new')
  assert.equal(row?.goal?.activation, 'armed', 'the newest registration still lands')
  store.dispose()
})

test('pending facts are applied and cleared without touching completion state', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5)], { at: 100 })
  assert.equal(store.applyPending('s1', 'approval', 110), true)
  assert.equal(store.snapshotFor('sse', store.host()).sessions[0].pendingKind, 'approval')
  assert.equal(store.clearPending('s1', 120), true)
  assert.equal(store.snapshotFor('sse', store.host()).sessions[0].pendingKind, null)
})

// ---------------------------------------------------------------------------
// Cursor ring (SSE resume)
// ---------------------------------------------------------------------------

test('replayFrom distinguishes satisfiable, current, future and expired cursors', t => {
  const store = storeFor(t)
  store.applyBaseline([baselineItem('s1', false, 5)], { at: 100 })
  const cursor = store.snapshotFor('sse', store.host()).cursor
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
  const snapshot = store.snapshotFor('sse', store.host())
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
  assert.equal(MAX_SSE_STREAMS, 32)
  assert.equal(MAX_SSE_PENDING_FRAMES, 32)
  assert.equal(SSE_KEEPALIVE_MS, 20_000)
  assert.equal(DEFAULT_EVENT_SILENCE_MS, 45_000)
})
