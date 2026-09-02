import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  adjacentTabStopIndex,
  initialMenuIndex,
  menuOwnerAllowsInteraction,
  moveMenuIndex,
  orderedTabStopIndexes,
  type MenuOwnerSnapshot,
} from '../src/client/menu-navigation.ts'

test('initialMenuIndex transfers focus according to the opening intent', () => {
  const ids = ['finder', 'vscode', 'future']
  assert.equal(initialMenuIndex(ids, 'vscode', 'selected'), 1)
  assert.equal(initialMenuIndex(ids, 'missing', 'selected'), 0)
  assert.equal(initialMenuIndex(ids, 'vscode', 'first'), 0)
  assert.equal(initialMenuIndex(ids, 'vscode', 'last'), 2)
  assert.equal(initialMenuIndex([], 'vscode', 'selected'), -1)
})

test('moveMenuIndex implements wrapping Arrow navigation and Home/End', () => {
  assert.equal(moveMenuIndex(3, 0, 'next'), 1)
  assert.equal(moveMenuIndex(3, 2, 'next'), 0)
  assert.equal(moveMenuIndex(3, 2, 'previous'), 1)
  assert.equal(moveMenuIndex(3, 0, 'previous'), 2)
  assert.equal(moveMenuIndex(3, 1, 'first'), 0)
  assert.equal(moveMenuIndex(3, 1, 'last'), 2)
  assert.equal(moveMenuIndex(3, -1, 'next'), 1)
  assert.equal(moveMenuIndex(3, 99, 'previous'), 2)
  assert.equal(moveMenuIndex(0, 0, 'next'), -1)
})

test('menu owner guard fails closed for hidden, pending, or disconnected N-ctx state', () => {
  const active: MenuOwnerSnapshot = {
    triggerConnected: true,
    ownerConnected: true,
    ownerContainsTrigger: true,
    ownerIsInstanceView: true,
    ownerHasInactiveClass: false,
    ownerHidden: false,
    ownerAriaHidden: false,
    rendered: true,
  }
  assert.equal(menuOwnerAllowsInteraction(active), true)

  for (const key of [
    'triggerConnected',
    'ownerConnected',
    'ownerContainsTrigger',
    'ownerIsInstanceView',
    'rendered',
  ] as const) {
    assert.equal(menuOwnerAllowsInteraction({ ...active, [key]: false }), false, key)
  }
  for (const key of ['ownerHasInactiveClass', 'ownerHidden', 'ownerAriaHidden'] as const) {
    assert.equal(menuOwnerAllowsInteraction({ ...active, [key]: true }), false, key)
  }
})

test('Tab order is anchored at the trigger instead of the body portal position', () => {
  // DOM order: ordinary-0, positive-2 trigger, positive-1, ordinary-0,
  // programmatic-only. Browser sequential order is 2 → 1 → 0 → 3.
  const order = orderedTabStopIndexes([0, 2, 1, 0, -1])
  assert.deepEqual(order, [2, 1, 0, 3])
  assert.equal(adjacentTabStopIndex(order, 1, 'backward'), 2)
  assert.equal(adjacentTabStopIndex(order, 1, 'forward'), 0)
  assert.equal(adjacentTabStopIndex(order, 2, 'backward'), -1)
  assert.equal(adjacentTabStopIndex(order, 3, 'forward'), -1)
  assert.equal(adjacentTabStopIndex(order, 4, 'forward'), -1)
})

test('AccessibleAppMenu wires owner loss observation and explicit Tab focus', () => {
  const source = readFileSync(new URL('../src/client/AccessibleAppMenu.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/client/AccessibleAppMenu.module.css', import.meta.url), 'utf8')
  assert.ok(source.includes('return observeOwnerLifetime(trigger, owner, dismissForOwnerLoss)'))
  assert.ok(source.includes("owner.classList.contains('instance-hidden') || owner.classList.contains('instance-pending')"))
  assert.ok(source.includes("menu.setAttribute('inert', '')"))
  assert.ok(source.includes("if (event.key === 'Tab') {\n      event.preventDefault()"))
  assert.ok(source.includes("adjacentTabStop(trigger, menuRef.current, event.shiftKey ? 'backward' : 'forward')"))
  assert.ok(source.includes('if (target !== null) target.focus()'))
  assert.ok(source.includes('if (!ownerAllowsInteraction(trigger, owner))'))
  assert.match(css, /min-width:\s*min\(218px,\s*calc\(100vw - 24px\)\)/)
  assert.match(css, /\.label\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s)
})
