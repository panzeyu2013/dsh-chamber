import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REVEAL_HOLD_MAX_MS,
  revealHoldRemainingMs,
  revealHoldStartedAt,
  shouldReveal,
  type RevealFacts,
} from '../../src/reveal-gate.ts'

// 揭示门（见 src/reveal-gate.ts 头注）：选择（activeView）与绘制（paintedView）分离后，
// 本纯函数回答"这一拍该收敛 painted 还是继续持有旧视图"。规则顺序即优先级，用例逐条钉住；
// 时钟必须单调（墙钟回拨不得提前揭示）。

const LOCAL = 'local'
const NOW = 500_000

function facts(over: Partial<RevealFacts>): RevealFacts {
  return {
    selectedViewId: 'gateway-b',
    paintedViewId: LOCAL,
    targetMountable: true,
    targetSettled: false,
    holdStartedAtMs: NOW - 10,
    nowMs: NOW,
    ...over,
  }
}

test('稳态：selected === painted ⇒ 无事可做（最高优先级，压过其它事实）', () => {
  assert.deepEqual(
    shouldReveal(facts({ selectedViewId: LOCAL, paintedViewId: LOCAL, targetMountable: false })),
    { reveal: false, reason: 'steady' },
  )
})

test('不可挂载：立即收敛（绝不把死视图留在屏上），压过持有窗', () => {
  assert.deepEqual(
    shouldReveal(facts({ targetMountable: false, holdStartedAtMs: NOW })),
    { reveal: true, reason: 'unmountable' },
  )
})

test('失败：立即揭示（失败覆盖层要立刻可见），先于 settled 归类', () => {
  assert.deepEqual(
    shouldReveal(facts({ targetFailed: true, targetSettled: true, holdStartedAtMs: null })),
    { reveal: true, reason: 'failed' },
  )
})

test('已 settle：立即揭示（≤1 帧，温壳互切与今天逐帧等价）', () => {
  assert.deepEqual(
    shouldReveal(facts({ targetSettled: true, holdStartedAtMs: NOW })),
    { reveal: true, reason: 'settled' },
  )
})

test('未 settle：持有窗内保持旧视图', () => {
  assert.deepEqual(
    shouldReveal(facts({ holdStartedAtMs: NOW - 400 })),
    { reveal: false, reason: 'painted' },
  )
})

test('到期：经过 REVEAL_HOLD_MAX_MS 即揭示（边界恰好到期算到期）', () => {
  assert.deepEqual(
    shouldReveal(facts({ holdStartedAtMs: NOW - REVEAL_HOLD_MAX_MS })),
    { reveal: true, reason: 'expired' },
  )
})

test('未锚定（holdStartedAtMs === null）不提前揭示：由调用方在同一拍锚定', () => {
  assert.deepEqual(
    shouldReveal(facts({ holdStartedAtMs: null })),
    { reveal: false, reason: 'painted' },
  )
})

test('时钟回拨：nowMs < holdStartedAtMs 按未到期处理（宁可多持有，绝不提前揭示）', () => {
  assert.deepEqual(
    shouldReveal(facts({ holdStartedAtMs: NOW + 60_000, nowMs: NOW })),
    { reveal: false, reason: 'painted' },
  )
})

test('持有窗推进：稳态清空；分叉锚定一次；换目标不重置（共享同一段墙钟）', () => {
  assert.equal(revealHoldStartedAt(123, { inFlight: false, nowMs: NOW }), null)
  assert.equal(revealHoldStartedAt(null, { inFlight: true, nowMs: NOW }), NOW)
  assert.equal(revealHoldStartedAt(NOW - 700, { inFlight: true, nowMs: NOW }), NOW - 700)
})

test('重臂算术：未锚定给满窗；已走过部分扣除；到期/回拨钳到 [0, MAX]', () => {
  assert.equal(revealHoldRemainingMs(null, NOW), REVEAL_HOLD_MAX_MS)
  assert.equal(revealHoldRemainingMs(NOW - 400, NOW), REVEAL_HOLD_MAX_MS - 400)
  assert.equal(revealHoldRemainingMs(NOW - REVEAL_HOLD_MAX_MS - 5_000, NOW), 0)
  assert.equal(revealHoldRemainingMs(NOW + 60_000, NOW), REVEAL_HOLD_MAX_MS)
})
