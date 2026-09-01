/**
 * Drawer-state derivation tests (design 17 §18.4 项 3): the collapsed flag is
 * derived from the layout store snapshot exactly like AppFrame derives the
 * frame attribute — `narrow ? !narrowExpanded : sidebar === 0`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveCollapsed } from '../src/client/markup.ts'

test('wide: collapsed iff sidebar preference is 0', () => {
  assert.equal(deriveCollapsed({ narrow: false, narrowExpanded: false, sidebar: 0 }), true)
  assert.equal(deriveCollapsed({ narrow: false, narrowExpanded: false, sidebar: 280 }), false)
  // narrowExpanded is meaningless wide; the preference decides.
  assert.equal(deriveCollapsed({ narrow: false, narrowExpanded: true, sidebar: 0 }), true)
})

test('narrow: default auto-collapsed, narrowExpanded re-opens', () => {
  assert.equal(deriveCollapsed({ narrow: true, narrowExpanded: false, sidebar: 280 }), true)
  assert.equal(deriveCollapsed({ narrow: true, narrowExpanded: true, sidebar: 0 }), false)
})

test('narrow crossing resets the override (setNarrow semantics)', () => {
  // narrow → wide drops the override; the preference governs again.
  assert.equal(deriveCollapsed({ narrow: false, narrowExpanded: false, sidebar: 280 }), false)
})
