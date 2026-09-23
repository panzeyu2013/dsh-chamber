/**
 * 派生未读账本的**行为**契约。
 *
 * 判定函数来自 client-core 的导出（与 App 接线喂进去的是同一对函数，
 * 反作弊：不得自造第二套）。覆盖：facts 水位、读水位解除、aborted+user
 * 抑制、ABSENT turn-end 武装、channel-only 边沿、listComplete
 * 唯一剪枝门、factsVerified=false 不 clobber、阅读抑制、水位推进。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveUnread, reconcileCompletedFacts } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { deriveSourceUnread, sameBooleanMap, viewingReadWatermark } from '../../src/unread-derivation.ts'
import type { UnreadDerivationInput, UnreadDerivationFactsRow } from '../../src/unread-derivation.ts'

const deps = { deriveUnread, reconcileCompletedFacts }

test('sameBooleanMap: 同形布尔表比较（App 的账本 identity 闸与模块内部共用同一实现）', () => {
  assert.equal(sameBooleanMap({}, {}), true)
  assert.equal(sameBooleanMap({ a: true }, { a: true }), true)
  assert.equal(sameBooleanMap({ a: true, b: false }, { a: true, b: false }), true)
  assert.equal(sameBooleanMap({ a: true }, { a: false }), false)
  assert.equal(sameBooleanMap({ a: true }, {}), false, '键数不同即不同')
  assert.equal(sameBooleanMap({}, { a: true }), false, '右侧多键也即不同')
  assert.equal(sameBooleanMap({ a: true, b: false }, { a: true, b: true }), false)
  // 语义是「真值位相同」：非 true 的一切（false/undefined）等价。
  assert.equal(sameBooleanMap({ a: false } as Record<string, boolean>, { a: undefined } as unknown as Record<string, boolean>), true)
})

function input(overrides: Partial<UnreadDerivationInput> = {}): UnreadDerivationInput {
  return {
    facts: undefined,
    channel: undefined,
    listComplete: false,
    prevRunning: {},
    prevLedger: {},
    readMarks: {},
    readingSessionId: undefined,
    factsVerified: true,
    ...overrides,
  }
}

function fact(overrides: Partial<UnreadDerivationFactsRow> = {}): UnreadDerivationFactsRow {
  return {
    sessionId: 's1',
    running: false,
    updatedAt: 0,
    completedAt: 0,
    lastTurnEnd: null,
    completedAtSource: 'observed',
    ...overrides,
  }
}

test('facts completion above the read mark is unread; at/below is read', () => {
  const completed = deriveSourceUnread(input({ facts: { s1: fact({ completedAt: 100 }) } }), deps)
  assert.deepEqual(completed.unread, { s1: true })
  assert.equal(completed.changed, true)
  const at = deriveSourceUnread(input({ facts: { s1: fact({ completedAt: 100 }) }, readMarks: { s1: 100 } }), deps)
  assert.deepEqual(at.unread, {})
  const above = deriveSourceUnread(input({ facts: { s1: fact({ completedAt: 100 }) }, readMarks: { s1: 200 } }), deps)
  assert.deepEqual(above.unread, {})
})

test('updatedAt alone (user content elsewhere) is a watermark on the edge track', () => {
  const unread = deriveSourceUnread(input({ facts: { s1: fact({ completedAt: 0, updatedAt: 50 }) } }), deps)
  assert.deepEqual(unread.unread, { s1: true })
  const read = deriveSourceUnread(input({ facts: { s1: fact({ completedAt: 0, updatedAt: 50 }) }, readMarks: { s1: 50 } }), deps)
  assert.deepEqual(read.unread, {})
})

test('R12: aborted + cause user never arms — even when the channel edge fired', () => {
  const result = deriveSourceUnread(input({
    channel: { s1: { running: false } },
    prevRunning: { s1: true },
    prevLedger: {},
    facts: { s1: fact({ completedAt: 100, lastTurnEnd: { kind: 'aborted', cause: 'user' } }) },
  }), deps)
  assert.deepEqual(result.unread, {})
})

test('ABSENT/degraded turn-end still arms (Lead-fixed rule, not re-implemented here)', () => {
  const result = deriveSourceUnread(input({ facts: { s1: fact({ completedAt: 100, lastTurnEnd: null }) } }), deps)
  assert.deepEqual(result.unread, { s1: true })
  const unknownKind = deriveSourceUnread(input({
    facts: { s1: fact({ completedAt: 100, lastTurnEnd: { kind: 'blocked', cause: undefined } }) },
  }), deps)
  assert.deepEqual(unknownKind.unread, {})
})

test('channel-only: running true -> false edge arms the durable ledger', () => {
  const result = deriveSourceUnread(input({
    channel: { s1: { running: false } },
    prevRunning: { s1: true },
  }), deps)
  assert.deepEqual(result.unread, { s1: true })
  assert.deepEqual(result.nextRunning, { s1: false })
})

test('listComplete is the ONLY prune gate: absent sessions survive an unfinished list', () => {
  const retained = deriveSourceUnread(input({
    channel: {},
    prevRunning: { gone: true },
    prevLedger: { gone: true },
    listComplete: false,
  }), deps)
  assert.deepEqual(retained.unread, { gone: true })
  assert.deepEqual(retained.nextRunning, { gone: true })
  const pruned = deriveSourceUnread(input({
    channel: {},
    prevRunning: { gone: true },
    prevLedger: { gone: true },
    listComplete: true,
  }), deps)
  assert.deepEqual(pruned.unread, {})
  assert.deepEqual(pruned.nextRunning, {})
})

test('facts take over a channel-edged session; a settled read mark disarms it', () => {
  const armed = deriveSourceUnread(input({
    channel: { s1: { running: false } },
    prevRunning: { s1: true },
    facts: { s1: fact({ completedAt: 0, updatedAt: 0 }) },
  }), deps)
  // facts 结算了通道边沿（无水位 = 无法确认完成）⇒ 不假武装。
  assert.deepEqual(armed.unread, {})
  const read = deriveSourceUnread(input({
    facts: { s1: fact({ completedAt: 100 }) },
    readMarks: { s1: 100 },
  }), deps)
  assert.deepEqual(read.unread, {})
})

test('reading suppresses the facts arm without touching the stored watermark', () => {
  const result = deriveSourceUnread(input({
    facts: { s1: fact({ completedAt: 100 }) },
    readingSessionId: 's1',
  }), deps)
  assert.deepEqual(result.unread, {})
})

test('factsVerified=false keeps prevLedger untouched (no clobber, no prune)', () => {
  const result = deriveSourceUnread(input({
    facts: { s1: fact({ completedAt: 100 }) },
    prevLedger: { s1: true },
    prevRunning: { s1: false },
    listComplete: true,
    factsVerified: false,
  }), deps)
  assert.deepEqual(result.unread, { s1: true })
  assert.deepEqual(result.nextRunning, { s1: false })
  assert.equal(result.changed, false)
})

test('viewingReadWatermark = max(updatedAt, completedAt); 0/absent is never invented', () => {
  assert.equal(viewingReadWatermark(fact({ updatedAt: 5, completedAt: 9 })), 9)
  assert.equal(viewingReadWatermark(fact({ updatedAt: 9, completedAt: 5 })), 9)
  assert.equal(viewingReadWatermark(fact({ updatedAt: 0, completedAt: 0 })), undefined)
  assert.equal(viewingReadWatermark(undefined), undefined)
})

test('ledger identity: an unchanged derivation reports changed=false', () => {
  const first = deriveSourceUnread(input({ facts: { s1: fact({ completedAt: 100 }) } }), deps)
  const second = deriveSourceUnread(input({
    facts: { s1: fact({ completedAt: 100 }) },
    prevLedger: first.unread,
    prevRunning: first.nextRunning,
  }), deps)
  assert.deepEqual(second.unread, first.unread)
  assert.equal(second.changed, false)
})
/**
 * observer 域的完成事实（客户端降级戳）只用于**武装**未读，
 * 不并入 host 域读水位（「禁止客户端墙钟」/「时钟 +1h 零假未读」）。
 * 未标注 domain 的行（gateway 事实源）保持原判据；reconstructed 在网关侧是 host 域时间，
 * 故不能用 completedAtSource 当域判据。
 */
test('B5: an observer-domain completion arms but never advances the host read mark', () => {
  // observer 域（客户端降级戳）不推进读水位。
  assert.equal(viewingReadWatermark(fact({ updatedAt: 5, completedAt: 9, completedAtDomain: 'observer' })), 5)
  assert.equal(viewingReadWatermark(fact({ updatedAt: 0, completedAt: 9, completedAtDomain: 'observer' })), undefined)
  // host 域（或未标注 = gateway 事实源）照旧并入。
  assert.equal(viewingReadWatermark(fact({ updatedAt: 5, completedAt: 9, completedAtDomain: 'host' })), 9)
  // 武装不受影响：读水位停在 host updatedAt，完成事实仍高于它 ⇒ 未读仍亮。
  const armed = deriveSourceUnread(input({
    facts: { s1: fact({ updatedAt: 5, completedAt: 9, completedAtSource: 'reconstructed', completedAtDomain: 'observer' }) },
    readMarks: { s1: 5 },
  }), deps)
  assert.deepEqual(armed.unread, { s1: true })
})

