/**
 * Drawer tap self-heal pure-logic tests: the tap/pan discriminator and the
 * heal-target predicate — the DOM-bound installer stays integration-tested
 * on device (repo convention: behavior installers are device-gated, the
 * pure decisions are covered here).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isStableTap, isHealableDrawerTarget, TAP_SLOP_PX, HEAL_GRACE_MS, HEAL_SUPPRESS_MS,
  HEAL_FORM_SELECTOR, type ClosestFace,
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

test('heal timing constants: grace absorbs delayed clicks, suppression eats late real ones', () => {
  // Grace: long enough for the engine to deliver a delayed-but-real click
  // first (so the heal never fires), short enough to feel immediate.
  assert.equal(HEAL_GRACE_MS, 120)
  // Suppression window: a TRUSTED click at the healed coordinates shortly
  // after the heal is the delayed real click — never a second activation.
  assert.equal(HEAL_SUPPRESS_MS, 150)
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
