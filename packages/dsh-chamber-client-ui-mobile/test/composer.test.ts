/**
 * Composer behavior pure-logic tests (P1.5 + 2026 review round): the
 * keyboard heuristic, the self-heal constant and the layer-1
 * navigation-gesture predicate — the DOM-bound installers stay
 * integration-tested on device, the pure decision functions are covered
 * here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isKeyboardOpen, BUSY_STUCK_MS, TOUCH_TIER_QUERY,
  isNavigationGestureTarget, NAV_GESTURE_SELECTOR,
  type ClosestLike,
} from '../src/client/composer.ts'

/** A closest() stub: per-selector match answer. */
class ClosestStub implements ClosestLike {
  readonly match: Record<string, boolean>
  constructor(match: Record<string, boolean>) { this.match = match }
  closest(selector: string): ClosestLike | null {
    return this.match[selector] === true ? this : null
  }
}

test('keyboard heuristic: >120px AND >20% of layout height', () => {
  // 812 layout, 812 visual → closed
  assert.equal(isKeyboardOpen(812, 812), false)
  // 812 → 700 (112px gap): below the 120px threshold → closed
  assert.equal(isKeyboardOpen(812, 700), false)
  // 812 → 680 (132px gap, 16.3%): over 120px but under 20% → closed
  assert.equal(isKeyboardOpen(812, 680), false)
  // 812 → 640 (172px gap, 21.2%): over both thresholds → open
  assert.equal(isKeyboardOpen(812, 640), true)
  // Small screens: 667 → 500 (167px, 25%) → open
  assert.equal(isKeyboardOpen(667, 500), true)
})

test('composer stuck threshold is pinned at 30 s (recovery fires only on a genuine stuck state)', () => {
  // 常量钉:值本身是防意外改值的回归钉;「30s 后 blur→恢复→refocus」的时序
  // 行为属 device-gated installer(仓库惯例),在实机门禁覆盖。
  assert.equal(BUSY_STUCK_MS, 30_000)
})

test('touch tier query is the single source (shared with layout source and CSS)', () => {
  assert.equal(TOUCH_TIER_QUERY, '(max-width: 1023px) and (pointer: coarse)')
})

test('layer-1 navigation-gesture selector covers drawer and session header', () => {
  assert.ok(NAV_GESTURE_SELECTOR.includes('[data-mobile-role="sidebar"]'))
  assert.ok(NAV_GESTURE_SELECTOR.includes('[data-slot="conversation.session.header"]'))
})

test('isNavigationGestureTarget: drawer/header gestures are navigation', () => {
  // The predicate asks closest() with the COMBINED nav selector — a drawer
  // row or a header crumb matches it (single closest call).
  const drawerRow = new ClosestStub({ [NAV_GESTURE_SELECTOR]: true })
  assert.equal(isNavigationGestureTarget(drawerRow), true)
  const crumb = new ClosestStub({ [NAV_GESTURE_SELECTOR]: true })
  assert.equal(isNavigationGestureTarget(crumb), true)
  const noMatch = new ClosestStub({})
  assert.equal(isNavigationGestureTarget(noMatch), false)
})

test('isNavigationGestureTarget: non-navigation gestures are typing intent', () => {
  // Composer seat, portaled picker menus, message area — none navigates.
  assert.equal(isNavigationGestureTarget(new ClosestStub({})), false)
  assert.equal(isNavigationGestureTarget(null), false)
  // A target inside the seat but NOT inside a nav region (single closest
  // match answered for the nav selector only).
  const seatOnly = new ClosestStub({})
  assert.equal(isNavigationGestureTarget(seatOnly), false)
})
