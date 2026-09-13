import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionRowDisclosure, sessionRowWindow, SESSION_ROWS_VISIBLE_FIRST,
} from '../src/shared/session-row-window.ts'

// 会话行渲染窗口（2026 性能整改 B2，见 src/shared/session-row-window.ts）：
// 渲染层截断 + "还有 N 个会话"展开条；数据面保持全量（组件接线不在此测）。

const LIMIT = SESSION_ROWS_VISIBLE_FIRST

function window(over: Partial<{
  total: number
  currentIndex: number
  expanded: boolean
  visibleFirst: number
}> = {}) {
  return sessionRowWindow({
    total: over.total ?? 10,
    currentIndex: over.currentIndex ?? -1,
    expanded: over.expanded ?? false,
    visibleFirst: over.visibleFirst ?? LIMIT,
  })
}

test('小于等于上限全量渲染、无隐藏', () => {
  assert.deepEqual(window({ total: LIMIT }), { renderCount: LIMIT, hiddenCount: 0 })
  assert.deepEqual(window({ total: 0 }), { renderCount: 0, hiddenCount: 0 })
  assert.deepEqual(window({ total: 5 }), { renderCount: 5, hiddenCount: 0 })
})

test('超过上限截断到首屏上限', () => {
  const result = window({ total: LIMIT + 300 })
  assert.deepEqual(result, { renderCount: LIMIT, hiddenCount: 300 })
})

test('展开后全量渲染', () => {
  const result = window({ total: LIMIT + 300, expanded: true })
  assert.deepEqual(result, { renderCount: LIMIT + 300, hiddenCount: 0 })
})

test('当前会话行不得被窗口藏匿（在截断区内不影响窗口）', () => {
  assert.deepEqual(
    window({ total: LIMIT + 300, currentIndex: 150 }),
    { renderCount: LIMIT, hiddenCount: 300 },
  )
})

test('当前会话行在截断区外时窗口放大到覆盖它', () => {
  const result = window({ total: LIMIT + 300, currentIndex: LIMIT + 100 })
  assert.deepEqual(result, { renderCount: LIMIT + 101, hiddenCount: 199 })
})

test('当前会话行是最后一行时全量渲染', () => {
  const result = window({ total: LIMIT + 300, currentIndex: LIMIT + 299 })
  assert.deepEqual(result, { renderCount: LIMIT + 300, hiddenCount: 0 })
})

test('无当前会话（-1）与越界下标安全', () => {
  assert.deepEqual(window({ total: LIMIT + 10, currentIndex: -1 }).hiddenCount, 10)
  // 防御：currentIndex >= total 时按全量处理（findIndex 不会越界，纯防御）。
  assert.deepEqual(window({ total: 50, currentIndex: 99 }), { renderCount: 50, hiddenCount: 0 })
})

test('幂等与纯函数（同输入同输出、不共享状态）', () => {
  const a = window({ total: LIMIT + 7 })
  const b = window({ total: LIMIT + 7 })
  assert.deepEqual(a, b)
})

// 2026-09-11 upstream-alignment T11: 展开条自己的窗口与「是否已展开」无关——
// 展开后 sessionRowWindow 返回 hiddenCount 0，而 sessionRowDisclosure 仍给出
// 未展开窗口的隐藏数，展开条因此能留在原地并提供「收起」。
test('展开条窗口与展开态无关：展开态下仍报出隐藏数（可收起）', () => {
  const total = LIMIT + 300
  const collapsed = sessionRowDisclosure({ total, currentIndex: -1, visibleFirst: LIMIT })
  assert.deepEqual(collapsed, { renderCount: LIMIT, hiddenCount: 300 })
  // 展开后的渲染窗口是空的隐藏数（全量渲染）……
  assert.deepEqual(window({ total, expanded: true }), { renderCount: total, hiddenCount: 0 })
  // ……而展开条读的是自己的窗口：同一个控件在展开态仍能报出 300 并可收起。
  assert.deepEqual(
    sessionRowDisclosure({ total, currentIndex: -1, visibleFirst: LIMIT }),
    { renderCount: LIMIT, hiddenCount: 300 },
  )
})

test('展开条窗口继承当前会话的保持可见规则（与渲染窗口同源）', () => {
  assert.deepEqual(
    sessionRowDisclosure({ total: LIMIT + 300, currentIndex: LIMIT + 100, visibleFirst: LIMIT }),
    { renderCount: LIMIT + 101, hiddenCount: 199 },
  )
  assert.deepEqual(
    sessionRowDisclosure({ total: 5, currentIndex: -1, visibleFirst: LIMIT }),
    { renderCount: 5, hiddenCount: 0 },
  )
})
