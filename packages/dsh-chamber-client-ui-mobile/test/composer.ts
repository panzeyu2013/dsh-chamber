/**
 * Composer behavior pure-logic tests (P1.5): the keyboard heuristic and the
 * self-heal constant — the DOM-bound installers stay integration-tested on
 * device, the pure decision functions are covered here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isKeyboardOpen, BUSY_STUCK_MS, TOUCH_TIER_QUERY } from '../src/client/composer.ts'

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

test('self-heal threshold is 30 seconds', () => {
  assert.equal(BUSY_STUCK_MS, 30_000)
})

test('touch tier query is the single source (shared with layout source and CSS)', () => {
  assert.equal(TOUCH_TIER_QUERY, '(max-width: 1023px) and (pointer: coarse)')
})
