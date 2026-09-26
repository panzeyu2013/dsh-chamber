/**
 * 未读派生仪表契约（W0）：行样本 top-N 与定序、有界环容量、幂等挂全局且不夺回既有全局。
 * 仪表是只读旁路：这些断言只锁「读数可解释」，不锁任何判定行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createUnreadInstrument,
  publishUnreadInstrument,
  recordUnreadShadowReport,
  sampleUnreadRows,
  unreadShadowReport,
  unreadVerdict,
  type UnreadDeriveRecord,
  type UnreadDeriveRecordInput,
} from '../../src/unread-instrument.ts'

function entry(at: number, overrides: Partial<UnreadDeriveRecordInput> = {}): UnreadDeriveRecordInput {
  return {
    at,
    sourceId: 'local',
    branch: 'facts',
    factsVerified: true,
    rows: 113,
    maxWatermark: at,
    sample: [],
    readMarks: 0,
    seed: { through: at, consumed: false, keepUnread: 0 },
    unread: 0,
    running: 0,
    changed: false,
    ...overrides,
  }
}

test('sampleUnreadRows: top-N by watermark with a deterministic sessionId tie-break', () => {
  const rows = {
    slow: { running: false, updatedAt: 1, completedAt: null, completedAtDomain: undefined },
    newest: { running: false, updatedAt: 9, completedAt: 9, completedAtDomain: 'host' as const },
    b: { running: true, updatedAt: 5, completedAt: null, completedAtDomain: undefined },
    a: { running: false, updatedAt: 5, completedAt: null, completedAtDomain: 'observer' as const },
  }
  const sample = sampleUnreadRows(rows, 3)
  assert.deepEqual(sample.map(row => row.sessionId), ['newest', 'a', 'b'])
  assert.equal(sample[0]?.completedAtDomain, 'host')
  assert.equal(sample[1]?.completedAtDomain, 'observer')
  assert.equal(sample[2]?.running, true)
  assert.deepEqual(sampleUnreadRows(undefined), [])
  assert.deepEqual(sampleUnreadRows(rows, 0), [], 'limit<=0 不产样本')
})

test('instrument: bounded ring keeps the newest records and clear() empties it', () => {
  const instrument = createUnreadInstrument(2)
  instrument.record(entry(1))
  instrument.record(entry(2))
  instrument.record(entry(3))
  assert.deepEqual(instrument.entries().map(item => item.at), [2, 3])
  assert.equal(instrument.last()?.at, 3)
  assert.equal(instrument.entries().length, 2)
  instrument.clear()
  assert.equal(instrument.last(), undefined)
  assert.deepEqual(instrument.entries(), [])
})

test('publishUnreadInstrument: idempotent function view, never clobbers an existing global', () => {
  const target: Record<string, unknown> = {}
  publishUnreadInstrument(target)
  const first = target.__dshChamberUnread
  assert.equal(typeof first, 'object')
  publishUnreadInstrument(target)
  assert.equal(target.__dshChamberUnread, first, '重复发布必须复用同一函数视图')

  const sentinel = { entries: () => [] }
  const occupied: Record<string, unknown> = { __dshChamberUnread: sentinel }
  publishUnreadInstrument(occupied)
  assert.equal(occupied.__dshChamberUnread, sentinel, '既有全局不得被夺回')
})

test('unreadVerdict: the reading decides M1/M2 itself instead of leaving it to code reading (W1)', () => {
  const base = { factsVerified: true, maxWatermark: 9, seed: { through: 9, consumed: true }, unread: 2, readMarks: 1, rows: 5 }
  assert.equal(unreadVerdict(base), 'ok')
  assert.equal(unreadVerdict({ ...base, factsVerified: false }), 'no-verified-facts', 'facts 不可判 ⇒ 读数不结论')
  assert.equal(unreadVerdict({ ...base, factsVerified: false, maxWatermark: 0 }), 'no-verified-facts', '不可判优先于 M1')
  assert.equal(unreadVerdict({ ...base, maxWatermark: 0, seed: { through: 0, consumed: false } }), 'm1-zero-watermark')
  assert.equal(unreadVerdict({ ...base, seed: { through: 9, consumed: false } }), 'm2-seed-not-consumed')
  assert.equal(unreadVerdict({ ...base, unread: 0, readMarks: 3 }), 'read-marks-only')
  assert.equal(unreadVerdict({ ...base, unread: 0, readMarks: 0 }), 'ok', '没有读标记时 0 未读就是真实结果')
  // 实测形状（2026-09-26 本机）：123 行全未读 + `read:{}` ⇒ Dock 数字非常大。
  assert.equal(unreadVerdict({ ...base, rows: 123, unread: 123, readMarks: 0 }), 'all-rows-unread')
  assert.equal(unreadVerdict({ ...base, rows: 0, unread: 0, readMarks: 0 }), 'ok', '空表不是全表武装')
})

test('record computes the verdict from its own inputs (callers cannot disagree with the ring)', () => {
  const instrument = createUnreadInstrument(3)
  instrument.record(entry(1, { maxWatermark: 0, seed: { through: 0, consumed: false, keepUnread: 0 } }))
  instrument.record(entry(2, { maxWatermark: 7, seed: { through: 7, consumed: false, keepUnread: 0 } }))
  instrument.record(entry(3, { maxWatermark: 7, seed: { through: 7, consumed: true, keepUnread: 0 }, unread: 1 }))
  assert.deepEqual(instrument.entries().map(item => item.verdict), [
    'm1-zero-watermark', 'm2-seed-not-consumed', 'ok',
  ])
  assert.equal(instrument.last()?.verdict, 'ok')
})

test('shadow report: the W3 先锁 verdict is recorded and exposed through the published view', () => {
  assert.equal(unreadShadowReport(), null, '未写过影子时不造值')
  recordUnreadShadowReport({ phase: 'startup', written: true, ok: false, differences: ['unread:a/s v4=true v5=false'] })
  const report = unreadShadowReport()
  assert.equal(report?.phase, 'startup')
  assert.equal(report?.written, true)
  assert.equal(report?.ok, false)
  assert.deepEqual(report?.differences, ['unread:a/s v4=true v5=false'])
  assert.equal(typeof report?.at, 'number')
  const target: Record<string, unknown> = {}
  publishUnreadInstrument(target)
  const view = target.__dshChamberUnread as { shadow: () => typeof report }
  assert.deepEqual(view.shadow(), report, '发布视图必须能读到同一份报告（无第二权威）')
})

test('published view reflects the singleton ring (read-only instrument)', () => {
  const target: Record<string, unknown> = {}
  publishUnreadInstrument(target)
  const view = target.__dshChamberUnread as { last: () => UnreadDeriveRecord | undefined }
  assert.equal(typeof view.last, 'function')
  assert.equal(view.last(), undefined, '空环时 last() 必须诚实回 undefined（不得造值）')
})
