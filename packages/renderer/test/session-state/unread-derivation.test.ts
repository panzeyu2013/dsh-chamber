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
// 唯一判据元组的**生产实现**（测试不得自造第二套规则）：接线层喂给 deriveSourceUnread 的两值
// 必须由它派生，所以这份语料直接以它为准——revert 生产接线时本语料必须变红。
import { factsDecisionInput } from '../../src/session-facts-source.ts'

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

/**
 * 「冻结的未知」回归语料：载体抖动时账本不得在两条通道之间来回重算。
 *
 * 这是生产缺陷的逐拍复现（缺陷形状取自 session-facts-source 的三条出口：
 * legacy-after-history 404 / unversioned 保留行、source-mux 的 degraded 保留行、
 * markStale 的 pass-through）。接线层把这份快照折算成 (facts 行, factsVerified) 二元组：
 *   factsVerified = 快照缺席 || isFactsDecisionUsable(快照)   ← 不可判 ⇒ false
 *   facts 行      = 可判 ? snapshot.rows : undefined
 * 旧写法 factsVerified 恒 true，于是不可判窗口改用通道-only 重算：已武装的完成点被
 * listComplete 的唯一剪枝门删掉，载体恢复时又武装 —— Dock 徽标与行点每次抖动闪一次。
 */
function gatewayFacts(overrides: {
  verdict?: 'ok' | 'degraded' | 'legacy-gateway'
  serviceable?: boolean
  stale?: boolean
  rows?: Record<string, UnreadDerivationFactsRow>
} = {}) {
  const rows = overrides.rows ?? { s1: fact({ completedAt: 100, updatedAt: 100 }) }
  const verdict = overrides.verdict ?? 'ok'
  return {
    verdict,
    serviceable: overrides.serviceable ?? true,
    stale: overrides.stale ?? false,
    rows,
  }
}

/** 接线层的折算 = 生产函数本身（use-unread-notifications 用的就是它）。 */
function wire(snapshot: ReturnType<typeof gatewayFacts> | undefined): {
  facts: Record<string, UnreadDerivationFactsRow> | undefined
  factsVerified: boolean
} {
  const decision = factsDecisionInput(snapshot as never)
  return { facts: decision.rows as never, factsVerified: decision.verified }
}

test('a carrier flap keeps the armed dot armed through the undecidable window (no flicker)', () => {
  // 抖动序列：可判 → legacy-after-history 404（行保留、不可判）→ 恢复。
  const readable = gatewayFacts()
  const legacy = gatewayFacts({ verdict: 'legacy-gateway', serviceable: false, stale: true })
  const channel = {}
  let prevLedger: Record<string, boolean> = {}
  let prevRunning: Record<string, boolean> = {}
  const badges: number[] = []
  for (const snapshot of [readable, legacy, readable, legacy, readable]) {
    const w = wire(snapshot)
    const result = deriveSourceUnread(input({
      facts: w.facts,
      channel,
      // 权威完整列表：唯一的剪枝门 —— 正是它把「改用通道重算」的空结果落成删除。
      listComplete: true,
      prevLedger,
      prevRunning,
      readMarks: { s1: 0 },
      factsVerified: w.factsVerified,
    }), deps)
    prevLedger = result.unread
    prevRunning = result.nextRunning
    badges.push(Object.values(result.unread).filter(Boolean).length)
  }
  // 首拍武装，此后每一拍都必须保持武装：0↔1 的交替就是生产里的闪烁。
  assert.deepEqual(badges, [1, 1, 1, 1, 1], '不可判窗口不得剪掉已武装的完成点')
})

test('a stale-only snapshot (carrier gone, rows kept) is the SAME frozen case — not a second rule', () => {
  // 这是最常见的断连形状：verdict 仍 ok、serviceable 仍 true，只有 stale 翻 true
  // （markStale 是 pass-through）。它必须与 legacy/unversioned 走同一条规则 0；
  // 曾经判定面按 isFactsUsable（不含 stale）把它当可用，于是断连窗口改用 stale 行重算。
  const staleOnly = gatewayFacts({ stale: true })
  const w = wire(staleOnly)
  assert.equal(w.facts, undefined, 'stale 行不得作为判定输入')
  assert.equal(w.factsVerified, false, 'stale 必须落进冻结支')
  const result = deriveSourceUnread(input({
    facts: w.facts,
    // 通道边沿：上一拍 running、这一拍 idle。若按 stale 行重算，这个边沿会被结算掉。
    channel: { s1: { running: false } },
    listComplete: true,
    prevRunning: { s1: true },
    prevLedger: {},
    readMarks: {},
    factsVerified: w.factsVerified,
  }), deps)
  assert.deepEqual(result.unread, {}, '冻结 = 不动（既不用 stale 行武装，也不结算通道边沿）')
  assert.equal(result.changed, false)
})

test('the undecidable window does not re-arm an old completion either (frozen, not recomputed)', () => {
  // 反方向的破法：不可判快照的行仍带旧 completedAt，若被当证据，legacy 拍会把
  // 「上次已完成」重新判成未读 —— 假亮。冻结档必须是「不动」，不是「重算」。
  const legacy = gatewayFacts({ verdict: 'legacy-gateway', serviceable: false, stale: true })
  const w = wire(legacy)
  const result = deriveSourceUnread(input({
    facts: w.facts,
    channel: {},
    listComplete: true,
    prevLedger: {},
    prevRunning: {},
    readMarks: { s1: 0 },
    factsVerified: w.factsVerified,
  }), deps)
  assert.deepEqual(result.unread, {}, '不可判行不得作为武装证据')
  assert.equal(result.changed, false)
})

test('an ABSENT snapshot (no carrier) still derives channel-only — frozen applies to in-place decay only', () => {
  // 缺席 ≠ 不可判：来源未挂载/已退役时通道仍可判，账本必须继续跟随（否则旧未读永久粘住）。
  const w = wire(undefined)
  assert.equal(w.factsVerified, true)
  assert.equal(w.facts, undefined)
  const result = deriveSourceUnread(input({
    facts: w.facts,
    // s2 的通道边沿：上一拍 running，这一拍已 idle ⇒ 照常武装。
    channel: { s1: { running: true }, s2: { running: false } },
    listComplete: true,
    prevRunning: { s2: true },
    readMarks: {},
    factsVerified: w.factsVerified,
  }), deps)
  assert.deepEqual(result.unread, { s2: true }, '通道边沿在缺席快照下照常结算')
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

