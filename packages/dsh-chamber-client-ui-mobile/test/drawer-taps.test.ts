/**
 * Drawer tap self-heal pure-logic tests: the tap/pan discriminator, the
 * heal-target predicate, the real-click clear decision and the
 * late-real-click suppression window — the DOM-bound installer stays
 * integration-tested on device (repo convention: behavior installers are
 * device-gated, the pure decisions are covered here).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isStableTap, isHealableDrawerTarget, TAP_SLOP_PX, HEAL_GRACE_MS, HEAL_SUPPRESS_MS,
  HEAL_FORM_SELECTOR, shouldClearPendingHeal, isSuppressedLateClick,
  type ClosestFace,
} from '../src/client/drawer-taps.ts'

/** A closest() stub: per-selector match answer (an element matches many
 * ancestor selectors; the real DOM resolves the nearest, the predicate only
 * asks yes/no per selector). */
class ClosestStub implements ClosestFace {
  readonly match: Record<string, boolean>
  constructor(match: Record<string, boolean>) { this.match = match }
  closest(selector: string): ClosestFace | null {
    return this.match[selector] === true ? this : null
  }
}

const drawer = () => new ClosestStub({ '[data-mobile-role="sidebar"]': true })

test('isStableTap: within the slop on both axes is a tap', () => {
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: 0, endY: 0 }), true)
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: TAP_SLOP_PX, endY: 0 }), true)
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: 0, endY: -TAP_SLOP_PX }), true)
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: TAP_SLOP_PX, endY: TAP_SLOP_PX }), true)
})

test('isStableTap: beyond the slop is a pan/scroll intent (never healed)', () => {
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: TAP_SLOP_PX + 1, endY: 0 }), false)
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: 0, endY: TAP_SLOP_PX + 1 }), false)
  assert.equal(isStableTap({ startX: 100, startY: 100, endX: 100, endY: 400 }), false)
})

test('heal timing constants stay pinned at the documented values', () => {
  // 常量钉:grace 是「等真实 click 先到」的窗口,抑制窗覆盖 heal 之后的迟到
  // click——两者的「行为」由下方 isSuppressedLateClick 边界测试与实机门禁
  // 覆盖(installer 时序为 device-gated,仓库惯例),这里只防意外改值。
  assert.equal(HEAL_GRACE_MS, 120)
  assert.equal(HEAL_SUPPRESS_MS, 150)
})

test('isSuppressedLateClick: only a same-spot click inside the window is suppressed', () => {
  // 窗口内(含两端边界)且距离在 slop 内 → 抑制。
  assert.equal(isSuppressedLateClick(1_000, 1_000, 0, 0), true)
  assert.equal(isSuppressedLateClick(1_000, 1_150, 0, 0), true)
  assert.equal(isSuppressedLateClick(1_000, 1_050, TAP_SLOP_PX, -TAP_SLOP_PX), true)
  // 超窗 / 负时间(时钟回退、异序事件)→ 不抑制。
  assert.equal(isSuppressedLateClick(1_000, 1_151, 0, 0), false)
  assert.equal(isSuppressedLateClick(1_000, 999, 0, 0), false)
  // 超 slop → 是另一处点击,不抑制。
  assert.equal(isSuppressedLateClick(1_000, 1_050, TAP_SLOP_PX + 1, 0), false)
  assert.equal(isSuppressedLateClick(1_000, 1_050, 0, TAP_SLOP_PX + 1), false)
})

test('shouldClearPendingHeal: a click at/inside the tap target clears (delivered real click)', () => {
  // 到达的兼容 click 落在 row 或其子树内:已激活,heal 必须取消。
  assert.equal(shouldClearPendingHeal({ atOrInsideTapTarget: true, ancestorOfTapTarget: false }), true)
})

test('shouldClearPendingHeal: an ANCESTOR click clears too (hover-reveal retargeting)', () => {
  // iOS 把迟到的合成 click 重定向到 down/up 目标的最近共同祖先;hover-reveal
  // 位移后该祖先行在 pointerup 目标之上,click 已沿祖先冒泡激活 row——同样
  // 不得再 heal(否则双激活)。
  assert.equal(shouldClearPendingHeal({ atOrInsideTapTarget: false, ancestorOfTapTarget: true }), true)
})

test('shouldClearPendingHeal: an unrelated click keeps the heal armed', () => {
  // 与 tap 目标无关的 click(其它行/抽屉外)不清除——heal 语义是「该 tap 的
  // 真实 click 到达则零干预」,别的 click 不取消它。
  assert.equal(shouldClearPendingHeal({ atOrInsideTapTarget: false, ancestorOfTapTarget: false }), false)
})

test('isHealableDrawerTarget: rows inside the drawer heal', () => {
  const row = drawer()
  assert.equal(isHealableDrawerTarget(row), true)
})

test('isHealableDrawerTarget: form fields inside the drawer never heal', () => {
  // The predicate asks closest() with the COMBINED form selector — a field
  // inside a drawer matches both the drawer and the form chain.
  const fieldInDrawer = new ClosestStub({
    '[data-mobile-role="sidebar"]': true,
    [HEAL_FORM_SELECTOR]: true,
  })
  assert.equal(isHealableDrawerTarget(fieldInDrawer), false)
  // Any element whose ancestor chain contains the form selector heals
  // nowhere, even without a drawer (form check runs first).
  const fieldOnly = new ClosestStub({ [HEAL_FORM_SELECTOR]: true })
  assert.equal(isHealableDrawerTarget(fieldOnly), false)
})

test('isHealableDrawerTarget: outside the drawer never heals', () => {
  assert.equal(isHealableDrawerTarget(new ClosestStub({})), false)
  assert.equal(isHealableDrawerTarget(null), false)
})
