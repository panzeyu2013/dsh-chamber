/**
 * complete 通知账本内核契约（2026-12 阶段 2 单源化）：武装轨的「直到重新 running」
 * 规则、水位轨的单调与 kind 隔离、撤回只清武装轨（R2）、forget/prune 的两轨收敛。
 * 两轨的裁定规则本体仍在 watermark.ts / notification-edges.ts，这里钉的是账本容器。
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

test('the watermark track is monotonic per (source, session, kind) and survives withdrawal', () => {
  const ledger = createCompleteLedger({ src: { s1: { complete: 100 } } })
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 100)
  ledger.setNotifiedWatermark('src', 's1', 'complete', 101)
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 101)
  assert.equal(ledger.notifiedWatermark('src', 's1', 'ask'), undefined, 'kind 必须隔离')
  ledger.setNotifiedWatermark('src', 's1', 'ask', 7)
  assert.equal(ledger.notifiedWatermark('src', 's1', 'ask'), 7)
  ledger.setArmed('src', new Set(['s1']))
  ledger.forgetArmed('src')
  assert.equal(ledger.armed('src').size, 0, '撤回清武装轨')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 101, '撤回不得清 durable 水位轨（R2）')
})

test('forget drops both tracks; prune removes only absent sources and reports change', () => {
  const ledger = createCompleteLedger({ a: { s: { complete: 1 } }, b: { s: { complete: 2 } } })
  ledger.setArmed('a', new Set(['s']))
  ledger.setArmed('b', new Set(['s']))
  assert.equal(ledger.prune(new Set(['a'])), true)
  assert.equal(ledger.prune(new Set(['a'])), false, '无变化必须返回 false（App 据此避免重建引用）')
  assert.equal(ledger.notifiedWatermark('a', 's', 'complete'), 1)
  assert.equal(ledger.notifiedWatermark('b', 's', 'complete'), undefined)
  assert.equal(ledger.armed('b').size, 0)
  ledger.forget('a')
  assert.equal(ledger.notifiedWatermark('a', 's', 'complete'), undefined)
  assert.equal(ledger.armed('a').size, 0)
})

test('notifiedTable is the persisted v2 shape and older snapshots are never mutated', () => {
  const ledger = createCompleteLedger()
  ledger.setNotifiedWatermark('src', 's1', 'complete', 5)
  assert.deepEqual(ledger.notifiedTable(), { src: { s1: { complete: 5 } } })
  const snapshot = ledger.notifiedTable()
  ledger.setNotifiedWatermark('src', 's1', 'complete', 6)
  assert.equal(snapshot.src.s1.complete, 5, '旧快照冻结在写入时刻')
  assert.equal(ledger.notifiedTable().src.s1.complete, 6)
})
