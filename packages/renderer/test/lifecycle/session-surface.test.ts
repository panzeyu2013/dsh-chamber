/**
 * session-surface.ts（会话面绘制信号）单元测试：纯函数 + 桩 DOM，无浏览器。
 * 释放判定属于共享 arbiter（@dsh-chamber/dsh-stream-state 的 decidePresentation），
 * 其真值表——电平释放、本次持有起点计窗、未 settle / 时钟未建立 / 回拨一律
 * fail-closed——由该包的 presentation 套件覆盖。
 * 本文件保留**仍由本模块拥有**的两件事：DOM 相位读取与相位→上界映射。
 * 钉死的语义：
 * - 相位读取走 `[data-conversation-scroll]` → `closest([data-phase])`，**不**取"容器里第一个
 *   `[data-phase]`"（官方 composer 的 contenteditable 也发该属性、值域不同）；
 *   取不到锚点/祖先 ⇒ `absent`，取值未知 ⇒ `unknown`
 *   （与 absent 同走 2s 兜底，而非 hero 的 70s 外层保险）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readSessionSurfacePhase,
  SESSION_PHASE_ATTRIBUTE, SESSION_SCROLL_ANCHOR,
} from '../../src/session-surface.ts'
import { PRESENTATION_THRESHOLDS } from '@dsh-chamber/dsh-stream-state'

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
  assert.equal(readSessionSurfacePhase(root('inert')), 'unknown', '未知取值（composer 值域）fail-closed 到 unknown，走 2s 兜底而不是 hero 的 70s')
})

test('常量、属性字面量与相位→上界映射都是导出契约', () => {
  // 两个阈值由共享表的 presentation 段持有：单一所有者 + tables.json 锁步
  // （test/tables/tables-parity.test.ts）。
  assert.equal(PRESENTATION_THRESHOLDS.surfaceAbsentFallbackMs, 2_000)
  assert.equal(PRESENTATION_THRESHOLDS.surfaceMaxHoldMs, 70_000)
  // 字面量锁：若测试只用符号拼期望选择器，把 'data-phase' 写成
  // 'dataPhase' 这类漂移会静默全绿——而线上后果是相位恒读 absent、每次 open 都在 2s
  // 兜底揭幕（"不闪空白新会话"整体退化）。
  assert.equal(SESSION_PHASE_ATTRIBUTE, 'data-phase')
  assert.equal(SESSION_SCROLL_ANCHOR, '[data-conversation-scroll]')
  // 相位 → 上界的**唯一**映射属于共享 arbiter（surfaceBoundMs），其完整值域由
  // 该包的 presentation 套件覆盖（absent/unknown 走 2s、hero/settling 走 70s、active 为 0）。
  // 本文件仍钉这两个常量本身：它们是 arbiter 阈值表的输入，改动必须在此显式。
})