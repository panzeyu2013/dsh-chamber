/**
 * Drawer background accessibility lock: the pure per-column decision and the
 * attribute application (driven through the shared plain-node element double).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAWER_BACKGROUND_TARGETS, applyBackgroundInert, shouldInertBackground,
} from '../../src/client/drawer-a11y.ts'
import { MOBILE_INERTED_ATTR } from '../../src/client/markup.ts'
import { FakeElement } from '../support/guard-harness.ts'

test('shouldInertBackground: locked covers both columns; a SHOWN right panel keeps its own column live', () => {
  assert.equal(shouldInertBackground('conversation', true, false), true)
  assert.equal(shouldInertBackground('details', true, false), true)
  assert.equal(shouldInertBackground('conversation', true, true), true,
    'the conversation column is covered by the drawer in either panel state')
  assert.equal(shouldInertBackground('details', true, true), false,
    'the fullscreen panel lives in this column — inerting it would make the visible panel dead')
  assert.equal(shouldInertBackground('conversation', false, false), false)
  assert.equal(shouldInertBackground('details', false, false), false)
  assert.equal(shouldInertBackground('details', false, true), false)
})

test('applyBackgroundInert sets and clears the inert attribute (total on every transition)', () => {
  const root = new FakeElement('div')
  const conversation = new FakeElement('div')
  conversation.setAttribute('data-mobile-role', 'conversation')
  const details = new FakeElement('div')
  details.setAttribute('data-mobile-role', 'details')
  root.append(conversation, details)

  applyBackgroundInert(root as unknown as ParentNode, true, false)
  assert.equal(conversation.hasAttribute('inert'), true)
  assert.equal(details.hasAttribute('inert'), true)

  // Closing the drawer retracts BOTH (a leftover inert would lock the page).
  applyBackgroundInert(root as unknown as ParentNode, false, false)
  assert.equal(conversation.hasAttribute('inert'), false)
  assert.equal(details.hasAttribute('inert'), false)

  // Drawer open + right panel shown: the panel's column stays live.
  applyBackgroundInert(root as unknown as ParentNode, true, true)
  assert.equal(conversation.hasAttribute('inert'), true)
  assert.equal(details.hasAttribute('inert'), false)

  // ... and the transition back to a hidden panel re-inerts it.
  applyBackgroundInert(root as unknown as ParentNode, true, false)
  assert.equal(details.hasAttribute('inert'), true)
  // Every lock write is MARKED, so the unlock pass can prove ownership.
  assert.equal(conversation.getAttribute(MOBILE_INERTED_ATTR), '')
  assert.equal(details.getAttribute(MOBILE_INERTED_ATTR), '')
})

test('unlock retracts only the lock own marked writes (foreign inert survives)', () => {
  const root = new FakeElement('div')
  const owned = new FakeElement('div')
  owned.setAttribute('data-mobile-role', 'conversation')
  const foreign = new FakeElement('div')
  foreign.setAttribute('data-mobile-role', 'details')
  // Another mechanism (or a future official one) inerts the details column
  // while a SHOWN panel keeps the lock off it: the lock must not claim that
  // write by marking it, and the unlock pass must leave it alone.
  foreign.setAttribute('inert', '')
  root.append(owned, foreign)

  applyBackgroundInert(root as unknown as ParentNode, true, true)
  assert.equal(owned.hasAttribute('inert'), true)
  assert.equal(owned.hasAttribute(MOBILE_INERTED_ATTR), true)
  assert.equal(foreign.hasAttribute(MOBILE_INERTED_ATTR), false,
    'the lock must not mark a write it did not make')
  assert.equal(foreign.hasAttribute('inert'), true)
  applyBackgroundInert(root as unknown as ParentNode, false, false)
  assert.equal(owned.hasAttribute('inert'), false)
  assert.equal(owned.hasAttribute(MOBILE_INERTED_ATTR), false)
  assert.equal(foreign.hasAttribute('inert'), true,
    'the lock must not retract an inert attribute it never wrote')
})

test('the column table stays attribute-anchored on the plugin role attribute', () => {
  assert.deepEqual(DRAWER_BACKGROUND_TARGETS.map(target => target.role), ['conversation', 'details'])
  for (const target of DRAWER_BACKGROUND_TARGETS) {
    assert.match(target.selector, /^\[data-mobile-role="(conversation|details)"\]$/,
      'the lock must use the plugin\'s own role attribute, never a hashed class')
  }
})
