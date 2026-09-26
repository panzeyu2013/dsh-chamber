/**
 * 通知身份（W2 读数面）：分支顺序 + `identitySource` 分类。
 *
 * WHY：幻影通知 / 静默漏发的归因需要「这条通知用的是哪条身份分支」当场可读。诊断只读、
 * 不参与判定；分类与 `notificationRunId` 必须**同一处产出**（包装函数委托分类函数）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSessionRunId,
  notificationIdentityOf,
  notificationRunId,
} from '../../src/notification-identity.ts'
import { parseChamberRunId } from '@dsh-chamber/dsh-stream-state'

const base = { sourceFingerprint: 'fp1', sessionId: 's1' }

test('identity source: host event id wins, then the watermark episode, then the constant fallback (W2)', () => {
  const live = notificationRunId({ ...base, watermark: 5 })
  assert.deepEqual(notificationIdentityOf({ ...base, runId: live }), { runId: live, source: 'run-id' })
  assert.deepEqual(notificationIdentityOf({ ...base, completionSeq: 7 }), { runId: 'host:turn%2F7', source: 'host-turn' })
  assert.equal(notificationIdentityOf({ ...base, watermark: 42 }).source, 'watermark')
  assert.equal(notificationIdentityOf({ ...base, watermark: 0 }).source, 'watermark', '水位 0 是合法水位')
  const constant = notificationIdentityOf(base)
  assert.equal(constant.source, 'constant', '无任何 host 域判别符 ⇒ 兜底常量（最可疑，W2 目标）')
  assert.equal(constant.runId, notificationRunId(base), '包装函数与分类函数同一处产出')
  assert.ok(isSessionRunId(constant.runId))
})

test('identity source: ask/request keep the per-event nonce, and completionSeq outranks kind (W2)', () => {
  const ask = notificationIdentityOf({ ...base, kind: 'ask' })
  assert.equal(ask.source, 'event-nonce')
  const second = notificationIdentityOf({ ...base, kind: 'ask' })
  assert.notEqual(second.runId, ask.runId, '同一页内的两次 ask 必须不同身份（第二次提问不是重放）')
  const sequenced = notificationIdentityOf({ ...base, kind: 'complete', completionSeq: 3 })
  assert.equal(sequenced.source, 'host-turn', '宿主事件 id 优先于 kind 分支')
  assert.deepEqual(sequenced, notificationIdentityOf({ ...base, kind: 'complete', completionSeq: 3 }))
})

test('event-nonce generation: CSPRNG page generation stays a positive safe integer (no clock)', () => {
  const ask = notificationIdentityOf({ ...base, kind: 'ask' })
  const parts = parseChamberRunId(ask.runId)
  assert.notEqual(parts, null, '页内非事件身份必须可解析')
  assert.ok(Number.isSafeInteger(parts!.generation), 'generation 必须是安全整数（53 位算术不得溢出）')
  assert.ok(parts!.generation > 0, 'generation 必须为正：0 是水位族/常量族的保留 generation（实现已把抽到 0 归一为 1）')
  // 同一页内两次 ask 只差 episode（计数），generation 恒为同一页代。
  const ask2 = notificationIdentityOf({ ...base, kind: 'ask' })
  assert.equal(parseChamberRunId(ask2.runId)!.generation, parts!.generation, '页代在页内稳定')
  assert.notEqual(ask2.runId, ask.runId, '页内两次 ask 身份必须不同')
})

test('page generation: a fresh page instance draws a different generation (cross-page uniqueness)', async () => {
  const here = notificationIdentityOf({ ...base, kind: 'ask' })
  // 换 URL（query 变体）让 ESM 重新求值一次模块 = 模拟下一页；页代必须与上一页不同。
  const specifier = '../../src/notification-identity.ts?page=b'
  const other = await import(specifier) as { notificationIdentityOf: typeof notificationIdentityOf }
  const there = other.notificationIdentityOf({ ...base, kind: 'ask' })
  assert.notEqual(parseChamberRunId(there.runId)!.generation, parseChamberRunId(here.runId)!.generation,
    '页代跨页必须不同（CSPRNG 抽取；碰撞概率 2⁻⁵³）')
})

test('identity canonicality: every classified id is a loadable session run id', () => {
  const inputs = [
    base,
    { ...base, kind: 'request' as const },
    { ...base, watermark: 5 },
    { ...base, completionSeq: 0 },
  ]
  for (const input of inputs) assert.ok(isSessionRunId(notificationRunId(input)), JSON.stringify(input))
})
