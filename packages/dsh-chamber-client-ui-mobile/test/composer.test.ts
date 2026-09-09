/**
 * Composer behavior pure-logic tests (P1.5 + 2026 review + mobile rounds):
 * the keyboard heuristic, the self-heal constant, the layer-1
 * navigation-gesture predicate, the layer-5 keyboard-compensation geometry
 * (covered height / quantized offset / scroll-end / arm decision) and the
 * Enter-newline caret-reveal delta — the DOM-bound installers stay
 * integration-tested on device, the pure decision functions are covered here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isKeyboardOpen, BUSY_STUCK_MS, TOUCH_TIER_QUERY, PHONE_TIER_QUERY,
  isNavigationGestureTarget, NAV_GESTURE_SELECTOR,
  kbdCoveredHeight, nextKbdOffset, isAtScrollEnd, caretRevealDelta,
  shouldCompensateKeyboard, KBD_EDITABLE_FOCUS_GRACE_MS, KBD_OFFSET_QUANTUM_PX,
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

test('kbdCoveredHeight: layout bottom minus visual viewport bottom (layout coordinates)', () => {
  // No keyboard / layout == visual → nothing covered.
  assert.equal(kbdCoveredHeight(812, 812, 0), 0)
  // iOS style: layout stays 812, visual shrinks to 512 → 300 covered.
  assert.equal(kbdCoveredHeight(812, 512, 0), 300)
  // Panned visual viewport (offsetTop > 0) reduces the covered band.
  assert.equal(kbdCoveredHeight(812, 512, 40), 260)
  // Zoomed-in visual viewport taller than the gap → clamped to 0.
  assert.equal(kbdCoveredHeight(812, 900, 0), 0)
})

test('nextKbdOffset: ceil quantization with headroom, zero when uncovered', () => {
  // Nothing covered → never arm.
  assert.equal(nextKbdOffset(0), 0)
  // 300 covered + 8 headroom → ceil(308/16)=20 → 320 (never under the top).
  assert.equal(nextKbdOffset(300), 320)
  // Small covered heights still get the minimal non-zero lift.
  assert.equal(nextKbdOffset(5), 16)
  // Explicit quantum/headroom for readability.
  assert.equal(nextKbdOffset(100, 16, 8), 112)
  assert.equal(nextKbdOffset(47, 16, 8), 64)
  assert.equal(nextKbdOffset(-1), 0)
  // The default step stays small enough that the dead band above the keyboard
  // cannot grow past ~23px (cross-check: 48px left 8-55px).
  assert.ok(KBD_OFFSET_QUANTUM_PX <= 16)
})

test('isAtScrollEnd: pinned-to-end detection with slack', () => {
  // Empty / non-scrollable containers are trivially at the end.
  assert.equal(isAtScrollEnd(0, 100, 200), true)
  assert.equal(isAtScrollEnd(0, 0, 0), true)
  // Mid-history is not at the end.
  assert.equal(isAtScrollEnd(500, 5000, 1000), false)
  // Exactly at the end (max = scrollHeight - clientHeight).
  assert.equal(isAtScrollEnd(4000, 5000, 1000), true)
  // Within the slack of the end.
  assert.equal(isAtScrollEnd(3995, 5000, 1000), true)
  // Beyond the end (post-clamp transient) is still end-pinned.
  assert.equal(isAtScrollEnd(4100, 5000, 1000), true)
})

test('caretRevealDelta: signed scroll delta to bring the caret into the host viewport', () => {
  // Caret fully visible → no scroll.
  assert.equal(caretRevealDelta(100, 120, 0, 200), 0)
  // Caret below the fold → scroll down by overflow + margin.
  assert.equal(caretRevealDelta(190, 210, 0, 200), 18)
  // Caret above the viewport → scroll up by overflow + margin.
  assert.equal(caretRevealDelta(-20, 0, 0, 200), -28)
  // Bottom edge flush with the fold but inside → no scroll.
  assert.equal(caretRevealDelta(180, 200, 0, 200), 0)
  // Custom margin.
  assert.equal(caretRevealDelta(190, 210, 0, 200, 2), 12)
})

test('shouldCompensateKeyboard: a visual-viewport shrink alone is not enough', () => {
  // No keyboard detected → never arm.
  assert.equal(shouldCompensateKeyboard(false, 1, true, true), false)
  // Keyboard detected but no editable focus (the keyboard belongs elsewhere,
  // or the editor blurred) → do not lift the composer seat.
  assert.equal(shouldCompensateKeyboard(true, 1, false, false), false)
  // Zoom without the composer focused: vetoed — panning a zoomed page must
  // not drive the offset (iOS focus-zooms on the drawer's 13px search).
  assert.equal(shouldCompensateKeyboard(true, 2, true, false), false)
  // Zoom WITH the composer focused: served — covered = layout - offsetTop -
  // vv.height is exactly how far the seat exceeds the visible bottom edge,
  // so the blanket veto would leave the composer behind the keyboard for the
  // rest of a focus-zoomed session (cross-check P1).
  assert.equal(shouldCompensateKeyboard(true, 2, true, true), true)
  // Engine float noise around scale 1 is tolerated.
  assert.equal(shouldCompensateKeyboard(true, 1.005, true, false), true)
  // The real case: keyboard open, no zoom, editor focused.
  assert.equal(shouldCompensateKeyboard(true, 1, true, true), true)
})

test('phone tier query is shared with the stylesheet and distinct from the touch tier', () => {
  assert.equal(PHONE_TIER_QUERY, '(max-width: 768px) and (pointer: coarse)')
  assert.notEqual(PHONE_TIER_QUERY, TOUCH_TIER_QUERY)
  // The grace window must outlast a keyboard-close animation (~250ms) and
  // stay short enough not to hold a stale offset after the user leaves.
  assert.ok(KBD_EDITABLE_FOCUS_GRACE_MS >= 500 && KBD_EDITABLE_FOCUS_GRACE_MS <= 2_000)
})
