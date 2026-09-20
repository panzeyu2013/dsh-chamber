/**
 * session-surface.ts（P3 会话面绘制信号）单元测试：纯函数 + 桩 DOM，无浏览器。
 *
 * 钉死的语义（2026-12 review 后修订）：
 * - 释放是**电平**：`active` ⇒ 立即；`absent` ⇒ 持有起点 + 2s；`hero`/`settling` ⇒ 保持，
 *   只受 70s 外层保险；
 * - 窗口基准是**本次持有起点**，与 shell 的 settle 时刻无关——温壳上 settle 早已是几分钟
 *   前，用它会让揭示门整体失效（review 复现的 MAJOR；本文件的 warm 用例就是它的回归锁）；
 * - 未 settle / 时钟未建立 / 时钟回拨 ⇒ 一律不释放（fail-closed；有界出口由 App 的 open
 *   生命周期与外层保险给）；
 * - 相位读取走 `[data-conversation-scroll]` → `closest([data-phase])`，**不**取"容器里第一个
 *   `[data-phase]`"（官方 composer 的 contenteditable 也发该属性、值域不同；移动插件曾有
 *   同款 first-match 事故）；取不到锚点/祖先 ⇒ `absent`，取值未知 ⇒ 保守 `hero`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readSessionSurfacePhase, shouldReleaseVeilForSurface, surfaceHoldBoundMs,
  SESSION_PHASE_ATTRIBUTE, SESSION_SCROLL_ANCHOR,
  SURFACE_ABSENT_FALLBACK_MS, SURFACE_MAX_HOLD_MS,
} from '../../src/session-surface.ts'

/** 桩：只实现 leaf 用到的两面——querySelector(滚动锚) → { closest(相位属性) }。 */
const root = (phase: string | null, options: { anchor?: boolean } = {}) => ({
  querySelector(selector: string) {
    assert.equal(selector, SESSION_SCROLL_ANCHOR, '必须从滚动锚反查，而不是取第一个 [data-phase]')
    if (options.anchor === false) return null
    return {
      closest(selector2: string) {
        assert.equal(selector2, `[${SESSION_PHASE_ATTRIBUTE}]`)
        if (phase === null) return null
        return { getAttribute: (name: string) => (name === SESSION_PHASE_ATTRIBUTE ? phase : null) }
      },
    }
  },
})

test('readSessionSurfacePhase：从滚动锚反查相位祖先，缺失/未知一律保守', () => {
  assert.equal(readSessionSurfacePhase(root('active')), 'active')
  assert.equal(readSessionSurfacePhase(root('settling')), 'settling')
  assert.equal(readSessionSurfacePhase(root('hero')), 'hero')
  assert.equal(readSessionSurfacePhase(root(null)), 'absent', '有锚点但没有相位祖先 = 会话根未挂')
  assert.equal(readSessionSurfacePhase(root('active', { anchor: false })), 'absent', '没有滚动锚 = 会话根未挂')
  assert.equal(readSessionSurfacePhase(root('inert')), 'hero', '未知取值（composer 值域）fail-closed 到 hero')
})

const facts = (over: Record<string, unknown> = {}) => ({
  settled: true,
  phase: 'hero',
  holdStartedAtMs: 1_000,
  nowMs: 1_000,
  ...over,
})

test('未 settle 永不释放：boot 期遮罩由 !settled 契约负责', () => {
  for (const phase of ['active', 'hero', 'settling', 'absent'] as const) {
    assert.equal(
      shouldReleaseVeilForSurface(facts({ settled: false, phase, nowMs: 1_000_000 })),
      false,
      phase + '：未 settle 时不得提前揭幕（否则会闪空白新会话）',
    )
  }
})

test('active 立即释放（有真实会话面，历史仍在载入也算）', () => {
  assert.equal(shouldReleaseVeilForSurface(facts({ phase: 'active', nowMs: 1_000 })), true)
})

test('时钟未建立（新持有的第一帧）绝不释放：相位可能是上一代的残留', () => {
  // 第二轮 review 的状态机反例：上一次持有被 active 释放后 surfacePhase 残留 'active'，
  // 新持有上升沿只有被动 effect 才复位相位——若判据让相位先短路，第一帧就会释放遮罩。
  assert.equal(
    shouldReleaseVeilForSurface(facts({ phase: 'active', holdStartedAtMs: null, nowMs: 1 })),
    false,
  )
  assert.equal(
    shouldReleaseVeilForSurface(facts({ phase: 'hero', holdStartedAtMs: null, nowMs: 1 })),
    false,
  )
})

test('absent：持有起点 + 2s 为界，绝不无出口', () => {
  const start = 5_000
  assert.equal(
    shouldReleaseVeilForSurface(facts({ phase: 'absent', holdStartedAtMs: start, nowMs: start + SURFACE_ABSENT_FALLBACK_MS - 1 })),
    false,
  )
  assert.equal(
    shouldReleaseVeilForSurface(facts({ phase: 'absent', holdStartedAtMs: start, nowMs: start + SURFACE_ABSENT_FALLBACK_MS })),
    true,
    '边界（含）即释放：ui-chat 未注册等降级形态不得挂住遮罩',
  )
})

test('hero/settling 保持，只受 70s 外层保险（不闪空白新会话）', () => {
  const start = 7_000
  for (const phase of ['hero', 'settling'] as const) {
    assert.equal(
      shouldReleaseVeilForSurface(facts({ phase, holdStartedAtMs: start, nowMs: start + SURFACE_ABSENT_FALLBACK_MS })),
      false,
      phase + '：2s 边界不释放（窗口不是从 settle 起算的 2s 兜底）',
    )
    assert.equal(
      shouldReleaseVeilForSurface(facts({ phase, holdStartedAtMs: start, nowMs: start + SURFACE_MAX_HOLD_MS - 1 })),
      false,
    )
    assert.equal(
      shouldReleaseVeilForSurface(facts({ phase, holdStartedAtMs: start, nowMs: start + SURFACE_MAX_HOLD_MS })),
      true,
      phase + '：外层保险到期必须释放（有界出口）',
    )
  }
})

test('warm 壳回归：窗口基准是本次持有起点，与 settle 时刻无关', () => {
  // review 复现的 MAJOR：旧实现用"settle 时刻 + 2s"，暖壳（settle 在 10 分钟前）上
  // holdVeil 翻转的那一帧 surfaceRelease 就已是 true ⇒ 遮罩整个持有期从不出现。
  const holdStart = 600_000
  const warm = facts({ phase: 'hero', holdStartedAtMs: holdStart, nowMs: holdStart })
  assert.equal(shouldReleaseVeilForSurface(warm), false, '持有刚开始时不得释放（warm 壳上尤其如此）')
  assert.equal(shouldReleaseVeilForSurface({ ...warm, nowMs: holdStart + 2_000 }), false, 'settled 久远不影响本持有的窗口')
  assert.equal(
    shouldReleaseVeilForSurface({ ...warm, phase: 'absent', absentSinceMs: null, nowMs: holdStart + 2_000 }),
    true,
    'absent 走自己的 2s 上界（根从未出现：连续缺失起点缺省退回持有起点）',
  )
})

test('absent 按"连续缺失起点"计窗：根短暂消失不得立刻揭幕又回遮', () => {
  // 二轮 review MINOR-1：held 到 +60s 时会话根消失一帧，若仍按持有起点算，遮罩会立刻
  // 消失（下一帧根回来又回遮）——用户看到"遮罩→露壳→遮罩"。窗口必须从"缺席开始"算。
  const holdStart = 600_000
  const flicker = absStart => facts({ phase: 'absent', holdStartedAtMs: holdStart, absentSinceMs: absStart, nowMs: absStart })
  assert.equal(shouldReleaseVeilForSurface(flicker(holdStart + 60_000)), false, '刚缺席的那一帧绝不释放')
  assert.equal(
    shouldReleaseVeilForSurface({ ...flicker(holdStart + 60_000), nowMs: holdStart + 61_999 }),
    false,
    '缺席不足 2s 不释放',
  )
  assert.equal(
    shouldReleaseVeilForSurface({ ...flicker(holdStart + 60_000), nowMs: holdStart + 62_000 }),
    true,
    '连续缺席满 2s 才释放（有界出口不变）',
  )
  assert.equal(
    shouldReleaseVeilForSurface(facts({ phase: 'absent', holdStartedAtMs: holdStart, absentSinceMs: null, nowMs: holdStart + 2_000 })),
    true,
    '未给起点时退回持有起点（根从未出现的降级形态）',
  )
  assert.equal(
    shouldReleaseVeilForSurface(facts({ phase: 'absent', holdStartedAtMs: holdStart, absentSinceMs: holdStart + 60_000, nowMs: holdStart + 59_000 })),
    false,
    '缺失起点在未来（时钟异常）同样保守继续持有',
  )
})

test('时钟未建立 / 回拨 / NaN：保守继续持有', () => {
  assert.equal(shouldReleaseVeilForSurface(facts({ phase: 'hero', holdStartedAtMs: null })), false)
  assert.equal(shouldReleaseVeilForSurface(facts({ phase: 'absent', holdStartedAtMs: null })), false)
  assert.equal(shouldReleaseVeilForSurface(facts({ phase: 'hero', holdStartedAtMs: 2_000, nowMs: 1_000 })), false)
  assert.equal(shouldReleaseVeilForSurface(facts({ phase: 'hero', holdStartedAtMs: Number.NaN, nowMs: 1_000 })), false)
})

test('常量、属性字面量与相位→上界映射都是导出契约', () => {
  assert.equal(SURFACE_ABSENT_FALLBACK_MS, 2_000)
  assert.equal(SURFACE_MAX_HOLD_MS, 70_000)
  // 字面量锁（2026-12 二轮 review）：若测试只用符号拼期望选择器，把 'data-phase' 写成
  // 'dataPhase' 这类漂移会静默全绿——而线上后果是相位恒读 absent、每次 open 都在 2s
  // 兜底揭幕（"不闪空白新会话"整体退化）。
  assert.equal(SESSION_PHASE_ATTRIBUTE, 'data-phase')
  assert.equal(SESSION_SCROLL_ANCHOR, '[data-conversation-scroll]')
  // 相位 → 上界的**唯一**映射（组件与判据共用，避免两处手工同步）。
  assert.equal(surfaceHoldBoundMs('absent'), SURFACE_ABSENT_FALLBACK_MS)
  assert.equal(surfaceHoldBoundMs('hero'), SURFACE_MAX_HOLD_MS)
  assert.equal(surfaceHoldBoundMs('settling'), SURFACE_MAX_HOLD_MS)
  assert.equal(surfaceHoldBoundMs('active'), SURFACE_MAX_HOLD_MS)
})