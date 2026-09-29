import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionRowDisclosure, sessionRowWindow, sessionRowWindowMotionKey, SESSION_ROWS_VISIBLE_FIRST,
} from '@dsh-chamber/dsh-chamber-client-core/session-row-window'

// 会话行渲染窗口（见 src/shared/session-row-window.ts）：
// 渲染层截断 + "还有 N 个会话"展开条；数据面保持全量（组件接线不在此测）。

const LIMIT = SESSION_ROWS_VISIBLE_FIRST

type Over = Partial<{ total: number; currentIndex: number; expanded: boolean; visibleFirst: number }>

const paramsOf = (over: Over) => ({
  total: over.total ?? 10, currentIndex: over.currentIndex ?? -1,
  expanded: over.expanded ?? false, visibleFirst: over.visibleFirst ?? LIMIT,
})
const window = (over: Over = {}) => sessionRowWindow(paramsOf(over))
const disclosure = (over: Over = {}) =>
  sessionRowDisclosure({ total: over.total ?? 10, currentIndex: over.currentIndex ?? -1, visibleFirst: over.visibleFirst ?? LIMIT })

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
  assert.deepEqual(window({ total: LIMIT + 300, currentIndex: 150 }), { renderCount: LIMIT, hiddenCount: 300 })
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

test('幂等与纯函数（同输入同输出、每次返回新对象、不改写入参/不共享状态）', () => {
  const params = paramsOf({ total: LIMIT + 7 })
  const a = sessionRowWindow(params)
  const b = sessionRowWindow(params)
  assert.deepEqual(a, b, '同输入同输出（幂等）')
  assert.notEqual(a, b, '返回新对象：不得把结果对象记忆化后共享给调用方')
  b.renderCount = -1
  assert.equal(sessionRowWindow(params).renderCount, LIMIT, '就地改返回值不得影响下一次调用（无共享状态）')
  assert.deepEqual(params, paramsOf({ total: LIMIT + 7 }), '入参不被改写')
})

// 展开条自己的窗口与「是否已展开」无关——
// 展开后 sessionRowWindow 返回 hiddenCount 0，而 sessionRowDisclosure 仍给出
// 未展开窗口的隐藏数，展开条因此能留在原地并提供「收起」。
test('展开条窗口与展开态无关：展开态下仍报出隐藏数（可收起）', () => {
  const total = LIMIT + 300
  assert.deepEqual(disclosure({ total }), { renderCount: LIMIT, hiddenCount: 300 })
  // 展开后渲染窗口变成全量（hiddenCount 0）——而展开条读的是自己的窗口（不看 expanded），
  // 因此同一个控件在展开态仍报出 300 并可收起（上面第一条断言即该事实；纯函数，无需重复调用）。
  assert.deepEqual(window({ total, expanded: true }), { renderCount: total, hiddenCount: 0 })
})

test('展开条窗口继承当前会话的保持可见规则（与渲染窗口同源）', () => {
  assert.deepEqual(disclosure({ total: LIMIT + 300, currentIndex: LIMIT + 100 }),
    { renderCount: LIMIT + 101, hiddenCount: 199 })
  assert.deepEqual(disclosure({ total: 5 }), { renderCount: 5, hiddenCount: 0 })
})

// 位移动效 resetKey 的窗口分量（sessionRowWindowMotionKey）：只有**被钳制**的组贡献分量。
// 这是「点 + 新建会话要淡入、不能整列瞬移」的回归锁：未钳制组的 renderCount === total，
// 若把行数直接放进键，新行出现的**那一次提交**就会改键 ⇒ AnimatedRows 走视图替换分支
// clear() ⇒ 入场动画被取消（首版写法的缺陷，评审用真模块数值复现）。
const group = (workspaceId: string, total: number, currentIndex = -1, expanded = false) =>
  ({ workspaceId, total, currentIndex, expanded })

test('已登记边界：另一组的放大窗口收缩会在同一提交里让整列 settle', () => {
  // 当前会话换到别处（例如在别的组点 +）会让原放大组的 currentIndex 变 -1 ⇒ 它的分量消失 ⇒
  // 键变 ⇒ AnimatedRows clear()：那次 + 的入场被"窗口收缩"这次真正的视图替换取代。
  // 这是 auto-window（窗口由当前行派生）带来的固有耦合，按上游 sessionLimits 语义选择 settle；
  // 要改成"窗口伸缩只走逐行 fade/exit"，必须先接受大跳转时整批测量的代价（design 06 §7 已登记）。
  assert.notEqual(
    sessionRowWindowMotionKey([group('W', LIMIT + 300, LIMIT + 60), group('V', 10, -1)]),
    sessionRowWindowMotionKey([group('W', LIMIT + 300, -1), group('V', 11, 0)]),
  )
})

test('未钳制的组不贡献分量：行增删、工作区增删、当前会话变化都不改键', () => {
  assert.equal(sessionRowWindowMotionKey([group('w1', 7, 2)]), '',
    '小组永远是空分量（新行出现的那次提交 renderCount 仍 === total）')
  assert.equal(sessionRowWindowMotionKey([group('w1', 8, 0)]), '', '新 blank 行成为 current 后仍为空')
  assert.equal(sessionRowWindowMotionKey([group('w1', 6, 2)]), '', '归档一行后仍为空')
  assert.equal(sessionRowWindowMotionKey([group('w1', LIMIT, 0)]), '', '恰在上限也未被钳制')
  assert.equal(sessionRowWindowMotionKey([group('w1', 3, 0), group('w2', 1, 0)]), '',
    '新增一个工作区（组数/顺序变化）不改键——新 workspace 行照旧淡入')
  assert.equal(sessionRowWindowMotionKey([]), '')
})

test('只有"窗口被放大且放大后仍藏行"的组按 id 记分量：默认上限与数据抖动都不签', () => {
  assert.equal(sessionRowWindowMotionKey([group('w1', LIMIT + 300, 10)]), '',
    '默认上限（renderCount === visibleFirst）本身不是视图替换——它跨 200 边界时不能翻键')
  assert.equal(sessionRowWindowMotionKey([group('w1', LIMIT + 1, 0)]), '',
    '恰好 200→201 的那一提交：新行成为 current，窗口仍是默认 200，键保持空（点 + 的入场不被取消）')
  assert.equal(sessionRowWindowMotionKey([group('w1', LIMIT + 1, 0)]),
    sessionRowWindowMotionKey([group('w1', LIMIT, 0)]), '200 与 201 行同键')
  assert.equal(sessionRowWindowMotionKey([group('w1', LIMIT + 301, 10)]),
    sessionRowWindowMotionKey([group('w1', LIMIT + 300, 10)]), '组内纯行数变化保持稳定')
  const enlarged = sessionRowWindowMotionKey([group('w1', LIMIT + 300, LIMIT + 60)])
  assert.equal(enlarged, JSON.stringify(['w1']),
    '当前行落到截断区外 ⇒ 窗口放大 ⇒ 键变（上游 sessionLimits 的那一半语义）；分量只带 id')
  assert.equal(sessionRowWindowMotionKey([group('w1', LIMIT + 300, LIMIT + 59)]),
    sessionRowWindowMotionKey([group('w1', LIMIT + 300, LIMIT + 60)]),
    '放大态内的下标漂移不改键（归档当前行上面一行会让下标上移，签名不得跟着漂）')
  assert.equal(sessionRowWindowMotionKey([group('w1', LIMIT + 299, LIMIT + 60)]), enlarged,
    '钳制组内的行数变化同样不改键')
  assert.equal(sessionRowWindowMotionKey([group('w1', LIMIT + 300, LIMIT + 60, true)]), '',
    '展开态不钳制；展开本身由 resetKey 的 sessionRowsExpanded 维承担')
  const two = sessionRowWindowMotionKey([group('w1', LIMIT + 300, LIMIT + 60), group('w2', 900, LIMIT + 100)])
  assert.equal(two, JSON.stringify(['w1', 'w2']))
  assert.equal(sessionRowWindowMotionKey([group('w2', 900, LIMIT + 100), group('w1', LIMIT + 300, LIMIT + 60)]),
    JSON.stringify(['w2', 'w1']), '分量跟随 id 而非位置')
  assert.equal(sessionRowWindowMotionKey([group('w1', LIMIT + 300, LIMIT + 60), group('w2', 900, 5)]),
    enlarged, '默认窗口的组不贡献分量，只保留被放大的那个')
})
