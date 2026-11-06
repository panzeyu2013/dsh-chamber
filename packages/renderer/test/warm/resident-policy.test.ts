/**
 * resident-policy 纯策略核心的单测（N-ctx 壳常驻重构 v1.1）：硬上限/输入保护/压力分档
 * （按档位连续 2 次、异档不合并）/LRU 顺序/幂等/空集。策略是零 import、无时钟、无 DOM 的纯函数，
 * 所以本套件在纯 node 下跑，不依赖 React/DOM。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  INPUT_GRACE_MS,
  RESIDENT_HARD_CAP,
  classifyPressure,
  pickHardCapRelease,
  pickPressureReleases,
  type PressureDecision,
  type ReleaseContext,
} from '../../src/resident-policy.ts'

const set = (...ids: string[]): ReadonlySet<string> => new Set(ids)

function context(overrides: Partial<ReleaseContext> = {}): ReleaseContext {
  return {
    mountedIds: ['local', 'active', 'warm-a', 'warm-b'],
    activeId: 'active',
    paintedId: 'active',
    pendingId: null,
    settingsTargetId: null,
    bootingIds: new Set<string>(),
    autoPrewarmedIds: new Set<string>(),
    residentIds: set('active', 'warm-a', 'warm-b'),
    lastActiveAt: {},
    lastInputAt: {},
    now: 1_000_000,
    ...overrides,
  }
}

test('constants: hard cap 12, input grace 10 minutes', () => {
  assert.equal(RESIDENT_HARD_CAP, 12)
  assert.equal(INPUT_GRACE_MS, 600_000)
})

test('hard cap: at or under the cap nothing is released; over the cap exactly one id', () => {
  const atCap = context({
    mountedIds: Array.from({ length: RESIDENT_HARD_CAP }, (_, index) => (index === 0 ? 'local' : `s${index}`)),
    residentIds: set('active', ...Array.from({ length: RESIDENT_HARD_CAP - 1 }, (_, index) => `s${index + 1}`)),
  })
  assert.equal(pickHardCapRelease(atCap), null, 'mounted === cap is not over the cap')

  const overCap = context({
    mountedIds: ['local', 'active', ...Array.from({ length: 11 }, (_, index) => `w${index}`)],
    residentIds: set('active', ...Array.from({ length: 11 }, (_, index) => `w${index}`)),
    lastActiveAt: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`w${index}`, index + 1])),
  })
  assert.equal(overCap.mountedIds.length, RESIDENT_HARD_CAP + 1)
  assert.equal(pickHardCapRelease(overCap), 'w0', 'the least recently active candidate goes first')
  assert.equal(pickHardCapRelease(overCap), 'w0', 'deterministic: same input, same verdict')
})

test('hard cap: cap override changes the trigger point', () => {
  const ctx = context({ cap: 3, mountedIds: ['local', 'active', 'warm-a', 'warm-b'] })
  assert.equal(pickHardCapRelease(ctx), 'warm-a', 'mounted 4 > cap 3 releases one shell')
  assert.equal(pickHardCapRelease(context({ cap: 4, mountedIds: ['local', 'active', 'warm-a', 'warm-b'] })), null)
})

test('hard cap: every protection面 wins individually (active/painted/pending/settings/booting/non-resident)', () => {
  // 挂载 3（local + active + x），cap 2：只有 x 可释放；逐个把它放进保护面，结果必须是 null。
  const base = (overrides: Partial<ReleaseContext> = {}): ReleaseContext => context({
    cap: 2,
    mountedIds: ['local', 'active', 'x'],
    residentIds: set('active', 'x'),
    ...overrides,
  })
  assert.equal(pickHardCapRelease(base()), 'x', 'control: x is releasable')
  assert.equal(pickHardCapRelease(base({ paintedId: 'x' })), null, 'painted shell never releases')
  assert.equal(pickHardCapRelease(base({ pendingId: 'x' })), null, 'pending switch target never releases')
  assert.equal(pickHardCapRelease(base({ settingsTargetId: 'x' })), null, 'settings target never releases')
  assert.equal(pickHardCapRelease(base({ bootingIds: set('x') })), null, 'unsettled (booting) shell never releases')
  assert.equal(pickHardCapRelease(base({ residentIds: set('active') })), null, 'non-resident (e.g. local) never releases through this pool')
  assert.equal(pickHardCapRelease(base({ activeId: 'x', paintedId: 'x', residentIds: set('x') })), null,
    'the active shell never releases (it is the only resident here)')
  // local 由调用方以「不在 residentIds 里」排除：即使它最久未活跃也不是候选。
  assert.equal(pickHardCapRelease(context({
    cap: 2,
    mountedIds: ['local', 'active', 'x', 'y'],
    residentIds: set('active', 'x', 'y'),
    lastActiveAt: { local: 1, x: 5, y: 9 },
  })), 'x', 'local is never a release candidate: the caller keeps it out of residentIds')
})

test('hard cap: recent input protects a shell for the full INPUT_GRACE_MS window (strict <)', () => {
  const now = 10_000_000
  const base = (lastInputAt: Record<string, number>): ReleaseContext => context({
    cap: 2,
    mountedIds: ['local', 'active', 'x'],
    residentIds: set('active', 'x'),
    lastInputAt,
    now,
  })
  assert.equal(pickHardCapRelease(base({ x: now })), null, 'input just now protects')
  assert.equal(pickHardCapRelease(base({ x: now - INPUT_GRACE_MS + 1 })), null, 'one ms inside the window protects')
  assert.equal(pickHardCapRelease(base({ x: now - INPUT_GRACE_MS })), 'x', 'the window boundary itself is unprotected')
  assert.equal(pickHardCapRelease(base({ x: now + 5 })), null, 'clock skew (future stamp) must protect, never release')
  assert.equal(pickHardCapRelease(base({})), 'x', 'no input record = never typed here = unprotected')
})

test('hard cap: auto-prewarmed shells release before user-warm ones, then LRU; absent activity = 0', () => {
  const prewarmFirst = context({
    mountedIds: ['local', 'active', 'user-old', 'user-new', 'auto-old', 'auto-new'],
    cap: 4,
    residentIds: set('active', 'user-old', 'user-new', 'auto-old', 'auto-new'),
    autoPrewarmedIds: set('auto-old', 'auto-new'),
    lastActiveAt: { 'user-old': 10, 'user-new': 900, 'auto-old': 500, 'auto-new': 800 },
  })
  assert.equal(pickHardCapRelease(prewarmFirst), 'auto-old',
    'the auto-prewarm arm is released first even though user-old is older; among autos, LRU')

  const lru = context({
    mountedIds: ['local', 'active', 'never', 'older', 'newer'],
    cap: 4,
    residentIds: set('active', 'never', 'older', 'newer'),
    lastActiveAt: { older: 10, newer: 900 },
  })
  assert.equal(pickHardCapRelease(lru), 'never', 'a shell without a lastActiveAt record sorts as 0 (oldest)')
})

test('pressure: normal band releases nothing', () => {
  assert.deepEqual(pickPressureReleases(context(), 'normal'), [])
  assert.deepEqual(pickPressureReleases(context({ mountedIds: [] }), 'normal'), [])
})

test('pressure: constrained keeps the single most recently used resident, releases the rest', () => {
  const ctx = context({
    mountedIds: ['local', 'active', 'old', 'mid', 'recent'],
    residentIds: set('active', 'old', 'mid', 'recent'),
    lastActiveAt: { old: 10, mid: 50, recent: 90 },
  })
  assert.deepEqual(pickPressureReleases(ctx, 'constrained'), ['old', 'mid'])
})

test('pressure: constrained lets auto-prewarmed shells go before the most recent user shell', () => {
  const ctx = context({
    mountedIds: ['local', 'active', 'auto', 'old', 'recent'],
    residentIds: set('active', 'auto', 'old', 'recent'),
    autoPrewarmedIds: set('auto'),
    lastActiveAt: { auto: 999, old: 10, recent: 90 },
  })
  assert.deepEqual(pickPressureReleases(ctx, 'constrained'), ['auto', 'old'],
    'order = auto-prewarm first then LRU; the kept one is the least releasable (recent user shell)')
})

test('pressure: constrained with at most one candidate keeps it (never below one resident)', () => {
  assert.deepEqual(pickPressureReleases(context({
    mountedIds: ['local', 'active', 'only'],
    residentIds: set('active', 'only'),
  }), 'constrained'), [])
  assert.deepEqual(pickPressureReleases(context({
    mountedIds: ['local', 'active'],
    residentIds: set('active'),
  }), 'constrained'), [])
})

test('pressure: critical releases every releasable resident in the shared order', () => {
  const ctx = context({
    mountedIds: ['local', 'active', 'auto', 'old', 'recent'],
    residentIds: set('active', 'auto', 'old', 'recent'),
    autoPrewarmedIds: set('auto'),
    lastActiveAt: { auto: 999, old: 10, recent: 90 },
  })
  assert.deepEqual(pickPressureReleases(ctx, 'critical'), ['auto', 'old', 'recent'])
})

test('pressure: protections and the input window apply to the valve too', () => {
  const now = 1_000_000
  const ctx = context({
    mountedIds: ['local', 'active', 'pending', 'settings', 'booting', 'typed', 'free'],
    residentIds: set('active', 'pending', 'settings', 'typed', 'free'),
    pendingId: 'pending',
    settingsTargetId: 'settings',
    bootingIds: set('booting'),
    lastInputAt: { typed: now - 1 },
    now,
  })
  assert.deepEqual(pickPressureReleases(ctx, 'critical'), ['free'])
  assert.deepEqual(pickPressureReleases(ctx, 'constrained'), [])
})

test('pressure: empty candidate set and idempotence (pure, no input mutation)', () => {
  const ctx = context({
    mountedIds: ['local', 'active', 'warm-a', 'warm-b'],
    residentIds: set('active', 'warm-a', 'warm-b'),
    autoPrewarmedIds: set('warm-a'),
    lastActiveAt: { 'warm-a': 5, 'warm-b': 9 },
  })
  const before = JSON.stringify({ mounted: ctx.mountedIds, lastActiveAt: ctx.lastActiveAt, auto: [...ctx.autoPrewarmedIds] })
  assert.deepEqual(pickPressureReleases(ctx, 'critical'), ['warm-a', 'warm-b'])
  assert.deepEqual(pickPressureReleases(ctx, 'critical'), ['warm-a', 'warm-b'], 'idempotent')
  assert.deepEqual(pickPressureReleases(ctx, 'constrained'), ['warm-a'])
  assert.equal(pickHardCapRelease(ctx), null, 'under the cap: no hard-cap release')
  assert.equal(JSON.stringify({ mounted: ctx.mountedIds, lastActiveAt: ctx.lastActiveAt, auto: [...ctx.autoPrewarmedIds] }), before,
    'the pure policy never mutates its input')
})

test('classifyPressure: null (platform cannot answer) is normal and resets the strikes', () => {
  const previous: PressureDecision = { band: 'critical', strikes: 2 }
  assert.deepEqual(classifyPressure({ freeRatio: null, previous, now: 1 }), { band: 'normal', strikes: 0 })
  assert.deepEqual(classifyPressure({ freeRatio: null, previous: null, now: 1 }), { band: 'normal', strikes: 0 })
})

test('classifyPressure: thresholds are strict at 8% and 15% (a single reading only arms a strike)', () => {
  // 15% 本身不是 constrained（严格 <），8% 本身不是 critical（严格 <，但它仍是 constrained 条件）。
  assert.deepEqual(classifyPressure({ freeRatio: 0.15, previous: null, now: 0 }), { band: 'normal', strikes: 0 })
  assert.deepEqual(classifyPressure({ freeRatio: 0.08, previous: null, now: 0 }), { band: 'normal', strikes: 1, pendingBand: 'constrained' })
  assert.deepEqual(classifyPressure({ freeRatio: 0.1499, previous: null, now: 0 }), { band: 'normal', strikes: 1, pendingBand: 'constrained' })
  assert.deepEqual(classifyPressure({ freeRatio: 0.0799, previous: null, now: 0 }), { band: 'normal', strikes: 1, pendingBand: 'critical' })
  // 8% 的第一击连续两次升级到 constrained（不是 critical），7.99% 才升级到 critical。
  const boundary = classifyPressure({ freeRatio: 0.08, previous: null, now: 0 })
  assert.deepEqual(classifyPressure({ freeRatio: 0.08, previous: boundary, now: 1 }), { band: 'constrained', strikes: 2 })
  const belowCritical = classifyPressure({ freeRatio: 0.0799, previous: null, now: 0 })
  assert.deepEqual(classifyPressure({ freeRatio: 0.0799, previous: belowCritical, now: 1 }), { band: 'critical', strikes: 2 })
})

test('classifyPressure: two consecutive same-band constrained readings escalate, and stay there', () => {
  const first = classifyPressure({ freeRatio: 0.12, previous: null, now: 1 })
  assert.deepEqual(first, { band: 'normal', strikes: 1, pendingBand: 'constrained' }, 'one reading is only a pending strike')
  const second = classifyPressure({ freeRatio: 0.11, previous: first, now: 2 })
  assert.deepEqual(second, { band: 'constrained', strikes: 2 })
  assert.deepEqual(classifyPressure({ freeRatio: 0.1, previous: second, now: 3 }), { band: 'constrained', strikes: 2 },
    'strikes saturate at 2 while the band remains active')
})

test('classifyPressure: two consecutive critical readings escalate to critical', () => {
  const first = classifyPressure({ freeRatio: 0.05, previous: null, now: 1 })
  assert.deepEqual(first, { band: 'normal', strikes: 1, pendingBand: 'critical' })
  assert.deepEqual(classifyPressure({ freeRatio: 0.04, previous: first, now: 2 }), { band: 'critical', strikes: 2 })
})

test('classifyPressure: a normal reading resets the pending strike immediately', () => {
  const pending = classifyPressure({ freeRatio: 0.05, previous: null, now: 1 })
  assert.deepEqual(pending, { band: 'normal', strikes: 1, pendingBand: 'critical' })
  assert.deepEqual(classifyPressure({ freeRatio: 0.5, previous: pending, now: 2 }), { band: 'normal', strikes: 0 })
  assert.deepEqual(classifyPressure({ freeRatio: 0.05, previous: { band: 'normal', strikes: 0 }, now: 3 }),
    { band: 'normal', strikes: 1, pendingBand: 'critical' }, 'the next pressure reading starts a new strike')
})

test('classifyPressure: different bands never combine (12% then 7% must not release every shell)', () => {
  // 设计 05 §4.1：<8% 要“连续 2 次 critical”；一次 constrained + 一次 critical 不能升成 critical。
  const constrained = classifyPressure({ freeRatio: 0.12, previous: null, now: 1 })
  assert.deepEqual(constrained, { band: 'normal', strikes: 1, pendingBand: 'constrained' })
  assert.deepEqual(classifyPressure({ freeRatio: 0.07, previous: constrained, now: 2 }),
    { band: 'normal', strikes: 1, pendingBand: 'critical' },
    'a single <8% reading after a constrained one only arms a critical strike (宁滞后不误杀)')
  assert.deepEqual(classifyPressure({ freeRatio: 0.06, previous: { band: 'normal', strikes: 1, pendingBand: 'critical' }, now: 3 }),
    { band: 'critical', strikes: 2 }, 'the second consecutive critical reading is actionable')
})

test('classifyPressure: a single better reading drops to pending and re-arms at the new band', () => {
  const afterOneBetter = classifyPressure({ freeRatio: 0.14, previous: { band: 'critical', strikes: 2 }, now: 1 })
  assert.deepEqual(afterOneBetter, { band: 'normal', strikes: 1, pendingBand: 'constrained' })
  assert.deepEqual(classifyPressure({ freeRatio: 0.13, previous: afterOneBetter, now: 2 }), { band: 'constrained', strikes: 2 })
})

test('classifyPressure: deterministic and clockless (same pressure, same verdict at any now)', () => {
  const previous: PressureDecision = { band: 'normal', strikes: 1, pendingBand: 'critical' }
  const early = classifyPressure({ freeRatio: 0.07, previous, now: 1 })
  const late = classifyPressure({ freeRatio: 0.07, previous, now: 999_999 })
  assert.deepEqual(early, { band: 'critical', strikes: 2 })
  assert.deepEqual(late, early)
})

test('valve composition: the first low sample releases nothing, the second releases (band is actionable)', () => {
  const ctx = context({
    mountedIds: ['local', 'active', 'a', 'b', 'c'],
    residentIds: set('active', 'a', 'b', 'c'),
    lastActiveAt: { a: 1, b: 2, c: 3 },
  })
  let previous: PressureDecision | null = null
  previous = classifyPressure({ freeRatio: 0.05, previous, now: 0 })
  assert.deepEqual(pickPressureReleases(ctx, previous.band), [], 'one strike: no release')
  previous = classifyPressure({ freeRatio: 0.04, previous, now: 1 })
  assert.deepEqual(pickPressureReleases(ctx, previous.band), ['a', 'b', 'c'], 'critical: release all releasable residents')
})
