/**
 * complete 通知账本内核契约（D1 身份轨，v4 唯一持久表）：身份幂等、
 * 撤回只清武装轨、runtimeSettled 的归属、forget/prune 的三轨收敛、
 * 快照不可变。裁定规则本体在 notification-projection.ts / notification-edges.ts，
 * 这里钉的是账本容器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompleteLedger } from '../../src/complete-ledger.ts'
import { dedupeCompleteEdges } from '../../src/notification-edges.ts'

test('the armed track drops a repeated complete until the session runs again', () => {
  const ledger = createCompleteLedger()
  const edges = [{ sessionId: 's1', kind: 'complete' as const }]
  const first = dedupeCompleteEdges(edges, ledger.armed('src'), [])
  assert.deepEqual(first.edges, edges, '首见放行并记账')
  ledger.setArmed('src', first.notified)
  assert.deepEqual(dedupeCompleteEdges(edges, ledger.armed('src'), []).edges, [], '未重新 running 的重复边沿被丢弃')
  const rerun = dedupeCompleteEdges([], ledger.armed('src'), ['s1'])
  ledger.setArmed('src', rerun.notified)
  assert.deepEqual(dedupeCompleteEdges(edges, ledger.armed('src'), []).edges, edges, '重新 running 清记忆后重新放行')
})

test('the identity track is keyed by (source, session) and survives a withdrawal', () => {
  const ledger = createCompleteLedger({ src: { s1: 'host:turn%2F7' } })
  assert.equal(ledger.notifiedRun('src', 's1'), 'host:turn%2F7')
  ledger.setNotifiedRun('src', 's1', 'host:turn%2F8')
  assert.equal(ledger.notifiedRun('src', 's1'), 'host:turn%2F8')
  assert.equal(ledger.notifiedRun('src', 's2'), undefined, 'sessions are isolated')
  ledger.setArmed('src', new Set(['s1']))
  ledger.forgetArmed('src')
  assert.equal(ledger.armed('src').size, 0, '撤回清武装轨')
  assert.equal(ledger.notifiedRun('src', 's1'), 'host:turn%2F8', '撤回不得清 durable 身份轨（R2）')
})

test('runtime settlement is distinct from arming and is consumed by an identity write', () => {
  const ledger = createCompleteLedger()
  ledger.setArmed('src', new Set(['s1']))
  assert.equal(ledger.runtimeSettled('src').has('s1'), false)
  ledger.markRuntimeSettled('src', 's1')
  assert.equal(ledger.runtimeSettled('src').has('s1'), true)
  ledger.setNotifiedRun('src', 's1', 'chamber:fp:0:s1:100')
  assert.equal(ledger.runtimeSettled('src').has('s1'), false)
  ledger.markRuntimeSettled('src', 's1')
  assert.equal(ledger.runtimeSettled('src').has('s1'), true, 'a re-settled run keeps its anchor')
})

test('runtime settlement carries the host anchor that keeps adoption run-scoped', () => {
  const ledger = createCompleteLedger()
  ledger.markRuntimeSettled('src', 's1', 1_700_000_000_000)
  assert.equal(ledger.runtimeSettled('src').get('s1'), 1_700_000_000_000)
  // A host-time-less edge is still a marker (legacy fallback), never an anchor.
  ledger.markRuntimeSettled('src', 's2')
  assert.equal(ledger.runtimeSettled('src').has('s2'), true)
  assert.equal(ledger.runtimeSettled('src').get('s2'), undefined)
  // A newer edge for the same session replaces the stale anchor.
  ledger.markRuntimeSettled('src', 's1', 1_700_000_060_000)
  assert.equal(ledger.runtimeSettled('src').get('s1'), 1_700_000_060_000)
})

test('forget drops every track; prune removes only absent sources and reports change', () => {
  const ledger = createCompleteLedger({ a: { s: 'host:turn%2F1' }, b: { s: 'host:turn%2F2' } })
  ledger.setArmed('a', new Set(['s']))
  ledger.setArmed('b', new Set(['s']))
  ledger.markRuntimeSettled('a', 's')
  ledger.markRuntimeSettled('b', 's')
  assert.equal(ledger.prune(new Set(['a'])), true)
  assert.equal(ledger.prune(new Set(['a'])), false, '无变化必须返回 false（App 据此避免重建引用）')
  assert.equal(ledger.notifiedRun('a', 's'), 'host:turn%2F1')
  assert.equal(ledger.notifiedRun('b', 's'), undefined)
  assert.equal(ledger.armed('b').size, 0)
  assert.equal(ledger.runtimeSettled('b').size, 0)
  ledger.forget('a')
  assert.equal(ledger.notifiedRun('a', 's'), undefined)
  assert.equal(ledger.armed('a').size, 0)
  assert.equal(ledger.runtimeSettled('a').size, 0)
})

test('notifiedRunTable is the persisted v4 shape and older snapshots are never mutated', () => {
  const ledger = createCompleteLedger()
  ledger.setNotifiedRun('src', 's1', 'host:turn%2F5')
  assert.deepEqual(ledger.notifiedRunTable(), { src: { s1: 'host:turn%2F5' } })
  const snapshot = ledger.notifiedRunTable()
  ledger.setNotifiedRun('src', 's1', 'host:turn%2F6')
  assert.equal(snapshot.src.s1, 'host:turn%2F5', '旧快照冻结在写入时刻')
  assert.equal(ledger.notifiedRunTable().src.s1, 'host:turn%2F6')
})
