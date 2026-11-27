/**
 * 通知 durable 表内存上界（design 19 §3.2.4「卫生上界」，M1 修复）：
 *  - notification-bounds 的尾截断/水位 LRU helper 与落盘 prune 同规；
 *  - complete-ledger 构造期与四个写点把内存表收敛到同一上界；
 *  - notification-store load 对 v1 载荷只裁内存、不写盘；save 仍幂等兜底。
 * 变异自检：把 helper 改成 no-op（tailSessionTable 恒返回原表）时本文件必须红。
 */
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  NOTIFICATION_MAX_SESSIONS_PER_SOURCE,
  tailOutcomeTable,
  tailSessionTable,
} from '../../src/notification-bounds.ts'
import { createCompleteLedger } from '../../src/complete-ledger.ts'
import { reconcile, type CompletionObservation } from '../../src/notification-projection.ts'
import {
  NOTIFICATIONS_V1_KEY,
  loadNotifications,
  pruneNotificationPayload,
  saveNotifications,
  type NotificationStorageLike,
} from '../../src/notification-store.ts'

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial))
  const writes: string[] = []
  const storage: NotificationStorageLike = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); writes.push(key) },
    removeItem: (key) => { data.delete(key) },
  }
  return { storage, data, writes }
}

const sessionTable = (n: number, prefix = 'session-') => {
  const out: Record<string, string> = {}
  for (let i = 0; i < n; i += 1) out[prefix + i] = 'host:run-' + i
  return out
}

test('the durable-table bound constant is 500 (single shared source)', () => {
  assert.equal(NOTIFICATION_MAX_SESSIONS_PER_SOURCE, 500)
})

test('tailSessionTable keeps the newest tail per source and never reorders', () => {
  const table = { a: sessionTable(4), b: sessionTable(2), empty: {} }
  const bounded = tailSessionTable(table, 2)
  assert.deepEqual(Object.keys(bounded), ['a', 'b'])
  assert.deepEqual(Object.keys(bounded.a!), ['session-2', 'session-3'])
  assert.equal(Object.keys(bounded.b!).length, 2)
  // under the bound returns the SAME reference (no needless churn)
  assert.equal(tailSessionTable(bounded, 2), bounded)
  assert.deepEqual(tailSessionTable(table, 0), {})
})

test('tailOutcomeTable keeps the highest watermarks with goalId ascending tie-break', () => {
  const table = {
    s: { g1: 1, g2: 5, g3: 5, g4: 2 },
  }
  assert.deepEqual(tailOutcomeTable(table, 3), { s: { g2: 5, g3: 5, g4: 2 } })
  assert.deepEqual(tailOutcomeTable({ s: { g1: 1, g2: 5, g3: 5, g4: 5 } }, 2), { s: { g2: 5, g3: 5 } },
    'equal watermarks truncate by goalId ascending, not descending')
  assert.deepEqual(tailOutcomeTable({ s: { a: 1, b: 2 } }, 0), {})
})

test('pruneNotificationPayload keeps its old semantics through the shared helpers', () => {
  const payload = {
    v: 1 as const,
    notifiedRuns: { s: sessionTable(600) },
    pending: { s: { 'session-0': { at: 1 }, 'session-1': { at: 2 }, 'session-2': { at: 3 } } },
    outcomes: { s: { g1: 1, g2: 9, g3: 7 } },
  }
  const pruned = pruneNotificationPayload(payload, 2)
  assert.deepEqual(Object.keys(pruned.notifiedRuns.s!), ['session-598', 'session-599'])
  assert.deepEqual(Object.keys(pruned.pending!.s!), ['session-1', 'session-2'])
  assert.deepEqual(pruned.outcomes!.s, { g2: 9, g3: 7 })
  // prune is pure: input unchanged
  assert.equal(Object.keys(payload.notifiedRuns.s!).length, 600)
})

test('the ledger bounds all four durable tables at every write point', () => {
  const ledger = createCompleteLedger()
  const N = NOTIFICATION_MAX_SESSIONS_PER_SOURCE + 1
  const expected = Array.from({ length: NOTIFICATION_MAX_SESSIONS_PER_SOURCE }, (_unused, index) => 'session-' + (index + 1))
  for (let i = 0; i < N; i += 1) {
    ledger.setNotifiedRun('source-a', 'session-' + i, 'host:run-' + i)
    ledger.setNotifiedWatermark('source-a', 'session-' + i, 'complete', i + 1)
    ledger.setPending('source-a', 'session-' + i, { at: Date.now() })
    ledger.setOutcome('source-a', 'goal-' + i, i + 1)
  }
  assert.deepEqual(Object.keys(ledger.notifiedRunTable()['source-a']!), expected)
  assert.deepEqual(Object.keys(ledger.state().notified['source-a']!), expected)
  assert.deepEqual(Object.keys(ledger.pendingTable()['source-a']!), expected)
  // outcomes keep the 500 highest watermarks: goal-0(watermark 1) is dropped, goal-1..500 survive.
  assert.equal(ledger.outcomesTable()['source-a']!['goal-0'], undefined)
  assert.equal(ledger.outcomesTable()['source-a']!['goal-500'], 501)
  assert.equal(Object.keys(ledger.outcomesTable()['source-a']!).length, NOTIFICATION_MAX_SESSIONS_PER_SOURCE)
  // other sources are independent
  ledger.setNotifiedRun('source-b', 'other', 'host:run-b')
  assert.deepEqual(Object.keys(ledger.notifiedRunTable()['source-b']!), ['other'])
})

test('the ledger trims oversized persisted tables at construction', () => {
  const N = NOTIFICATION_MAX_SESSIONS_PER_SOURCE + 1
  const runs: Record<string, Record<string, string>> = { s: sessionTable(N) }
  const pending: Record<string, Record<string, { at: number }>> = { s: {} }
  const outcomes: Record<string, Record<string, number>> = { s: {} }
  for (let i = 0; i < N; i += 1) {
    pending.s['session-' + i] = { at: Date.now() }
    outcomes.s['goal-' + i] = i + 1
  }
  const ledger = createCompleteLedger(runs, { pending, outcomes })
  assert.equal(Object.keys(ledger.notifiedRunTable().s!).length, NOTIFICATION_MAX_SESSIONS_PER_SOURCE)
  assert.deepEqual(Object.keys(ledger.notifiedRunTable().s!).slice(0, 2), ['session-1', 'session-2'])
  assert.equal(Object.keys(ledger.pendingTable().s!).length, NOTIFICATION_MAX_SESSIONS_PER_SOURCE)
  assert.equal(Object.keys(ledger.outcomesTable().s!).length, NOTIFICATION_MAX_SESSIONS_PER_SOURCE)
  assert.equal(ledger.outcomesTable().s!['goal-0'], undefined)
})

test('the ledger trims oversized persisted watermarks at construction', () => {
  const N = NOTIFICATION_MAX_SESSIONS_PER_SOURCE + 1
  const watermarks: Record<string, Record<string, { complete: number }>> = { s: {} }
  for (let i = 0; i < N; i += 1) watermarks.s['session-' + i] = { complete: i + 1 }
  const ledger = createCompleteLedger(watermarks)
  const kept = ledger.notifiedTable().s ?? {}
  assert.equal(Object.keys(kept).length, NOTIFICATION_MAX_SESSIONS_PER_SOURCE)
  assert.equal(kept['session-0'], undefined, 'oldest watermark row is evicted')
  assert.ok(kept['session-' + (N - 1)] !== undefined, 'newest watermark row is kept')
})

test('loadNotifications bounds the in-memory payload without writing it back', () => {
  const oversized = {
    v: 1,
    notifiedRuns: { s: sessionTable(700) },
    pending: {},
    outcomes: {},
  }
  const { storage, writes, data } = fakeStorage({ [NOTIFICATIONS_V1_KEY]: JSON.stringify(oversized) })
  const loaded = loadNotifications(storage)
  assert.equal(Object.keys(loaded.notifiedRuns.s!).length, NOTIFICATION_MAX_SESSIONS_PER_SOURCE)
  // load must not write the pruned payload back (roster-gate safe: no boot write)
  assert.deepEqual(writes, [])
  assert.equal(JSON.parse(data.get(NOTIFICATIONS_V1_KEY)!).notifiedRuns.s['session-0'], 'host:run-0')
})

test('the projection write points keep the shared bound (behavior + wiring lock)', () => {
  const ledger = createCompleteLedger()
  const obs = (sessionId: string, watermark: number): CompletionObservation => ({
    sourceId: 'source-p',
    sessionId,
    generation: 1,
    running: 'idle',
    subagents: 'idle',
    goal: 'unknown',
    candidate: { watermark, evidence: 'facts-watermark' },
    baseline: false,
    boot: 'same',
  })
  for (let i = 0; i < 600; i += 1) reconcile(ledger.state(), obs('session-' + i, i + 1), 10)
  const notifiedRows = ledger.state().notified['source-p'] ?? {}
  assert.equal(Object.keys(notifiedRows).length, NOTIFICATION_MAX_SESSIONS_PER_SOURCE,
    'reconcile notified table must keep exactly the 500/source window')
  assert.equal(notifiedRows['session-0'], undefined, 'oldest notified session is evicted')
  assert.ok(notifiedRows['session-599'] !== undefined, 'newest notified session is kept')
  const projectionSource = readFileSync(new URL('../../src/notification-projection.ts', import.meta.url), 'utf8')
  for (const needle of ['state.pending = tailSessionTable(', 'state.notified = tailSessionTable(', 'state.outcomes = tailOutcomeTable('] as const) {
    assert.ok(projectionSource.includes(needle), 'projection write point must trim through notification-bounds: ' + needle)
  }
  assert.ok(projectionSource.includes('NOTIFICATION_MAX_SESSIONS_PER_SOURCE'), 'projection must use the shared bound constant')
})

test('forgetSession clears the volatile native-settled attribution for that session', () => {
  const ledger = createCompleteLedger()
  ledger.markRuntimeSettled('s', 'session-x', 123)
  ledger.markRuntimeSettled('s', 'session-y', 456)
  assert.deepEqual([...ledger.runtimeSettled('s').keys()].sort(), ['session-x', 'session-y'])
  ledger.forgetSession('s', 'session-x')
  assert.deepEqual([...ledger.runtimeSettled('s').keys()], ['session-y'])
  // A source without any remaining volatile rows collapses to the shared empty map.
  ledger.forget('s')
  assert.equal(ledger.runtimeSettled('s').size, 0)
  // withdraw (carrier generation change) also drops the volatile anchors.
  ledger.markRuntimeSettled('s', 'session-z', 789)
  ledger.withdraw('s')
  assert.equal(ledger.runtimeSettled('s').size, 0)
})

test('the projection pending/outcome writers keep the same bound', () => {
  const ledger = createCompleteLedger()
  const base = { generation: 1, running: 'idle', subagents: 'idle', baseline: false, boot: 'same' } as const
  for (let i = 0; i < 600; i += 1) {
    reconcile(ledger.state(), {
      ...base, sourceId: 'source-pending', sessionId: 'pending-' + i,
      goal: { goalId: 'goal-p-' + i, revision: 1, phase: 'active', activation: 'armed' },
      candidate: { watermark: i + 1, evidence: 'facts-watermark' },
    }, 10)
  }
  const pendingTable = ledger.pendingTable()['source-pending'] ?? {}
  assert.equal(Object.keys(pendingTable).length, NOTIFICATION_MAX_SESSIONS_PER_SOURCE,
    'reconcile writePending must keep exactly the 500/source window')
  assert.equal(pendingTable['pending-0'], undefined, 'oldest pending session is evicted')
  assert.ok(pendingTable['pending-599'] !== undefined, 'newest pending session is kept')

  const outcomeLedger = createCompleteLedger()
  for (let i = 0; i < 600; i += 1) {
    reconcile(outcomeLedger.state(), {
      ...base, sourceId: 'source-outcome', sessionId: 'outcome-' + i,
      goal: { goalId: 'goal-o-' + i, revision: 1, phase: 'active', activation: 'armed' },
      candidate: { watermark: i + 1, evidence: 'facts-watermark' },
    }, 10)
    reconcile(outcomeLedger.state(), {
      ...base, sourceId: 'source-outcome', sessionId: 'outcome-' + i,
      goal: { goalId: 'goal-o-' + i, revision: 2, phase: 'complete', updatedAt: i + 2 },
    }, 20)
  }
  const outcomeTable = outcomeLedger.outcomesTable()['source-outcome'] ?? {}
  assert.equal(Object.keys(outcomeTable).length, NOTIFICATION_MAX_SESSIONS_PER_SOURCE,
    'reconcile recordOutcome must keep exactly the 500/source window')
  assert.equal(outcomeTable['goal-o-0'], undefined, 'lowest-watermark outcome is evicted')
  assert.ok(outcomeTable['goal-o-599'] !== undefined, 'highest-watermark outcome is kept')
})

test('runtimeSettled keeps the shared per-source window', () => {
  const ledger = createCompleteLedger()
  const N = NOTIFICATION_MAX_SESSIONS_PER_SOURCE + 1
  for (let i = 0; i < N; i += 1) ledger.markRuntimeSettled('source-r', 'session-' + i, i)
  assert.equal(ledger.runtimeSettled('source-r').size, NOTIFICATION_MAX_SESSIONS_PER_SOURCE)
  assert.equal(ledger.runtimeSettled('source-r').has('session-0'), false, 'oldest anchor is evicted')
  assert.equal(ledger.runtimeSettled('source-r').has('session-' + (N - 1)), true)
})

test('runtimeSettled evicts by insertion order, not by the smallest host timestamp', () => {
  const ledger = createCompleteLedger()
  ledger.markRuntimeSettled('source-r', 'old-but-newest-host-time', 999)
  for (let i = 0; i < NOTIFICATION_MAX_SESSIONS_PER_SOURCE - 1; i += 1) {
    ledger.markRuntimeSettled('source-r', 'session-' + i, i)
  }
  ledger.markRuntimeSettled('source-r', 'latest', 1_000)
  const settled = ledger.runtimeSettled('source-r')
  assert.equal(settled.size, NOTIFICATION_MAX_SESSIONS_PER_SOURCE)
  assert.equal(settled.has('old-but-newest-host-time'), false, 'first-inserted entry is evicted regardless of its host time')
  assert.equal(settled.has('session-0'), true, 'smallest host time is not the eviction key')
  assert.equal(settled.has('latest'), true)
})

test('runtimeSettled re-mark does not refresh insertion order', () => {
  const ledger = createCompleteLedger()
  for (let i = 0; i < NOTIFICATION_MAX_SESSIONS_PER_SOURCE; i += 1) ledger.markRuntimeSettled('source-r', 'session-' + i, i)
  ledger.markRuntimeSettled('source-r', 'session-0', 9_999)
  ledger.markRuntimeSettled('source-r', 'latest', 10_000)
  const settled = ledger.runtimeSettled('source-r')
  assert.equal(settled.has('session-0'), false, 're-marking an existing entry must not make it newest')
  assert.equal(settled.has('session-1'), true)
  assert.equal(settled.has('latest'), true)
})

test('the page-local notified watermark is not counted as durable', () => {
  const ledger = createCompleteLedger()
  ledger.setNotifiedWatermark('s', 'session-x', 'complete', 5)
  assert.equal(ledger.hasDurable('s'), false, 'only persisted payload keys count for retirement flushes')
})

test('save stays bounded for an oversized payload', () => {
  const { storage, data } = fakeStorage()
  const ok = saveNotifications(storage, {
    v: 1,
    notifiedRuns: { s: sessionTable(700) },
    pending: {},
    outcomes: {},
  })
  assert.equal(ok, true)
  const persisted = JSON.parse(data.get(NOTIFICATIONS_V1_KEY)!)
  assert.equal(Object.keys(persisted.notifiedRuns.s).length, NOTIFICATION_MAX_SESSIONS_PER_SOURCE)
})
