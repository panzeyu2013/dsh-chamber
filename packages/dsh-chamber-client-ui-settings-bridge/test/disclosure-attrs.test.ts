/**
 * Disclosure-attribute writer tests (2026-09-11 review-fix F3): plain node, no
 * DOM — the helper takes any `setAttribute`/`removeAttribute` target, so a fake
 * node records exactly what the switch's control element receives.
 *
 * The relationship under test is the one the review found inert: `aria-expanded`
 * on a role-less wrapper (`generic`) is not supported, so it has to be written
 * onto the element that both supports it and unfolds the card — the official
 * `Switch`'s own `role="switch"` button. `aria-controls` must follow the card's
 * existence: the collapsed render has no card element to point at.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDisclosureAttributes } from '../src/client/disclosure-attrs.ts';

/** One fake element recording the attribute writes it receives. */
function fakeNode(): { attrs: Map<string, string>; setAttribute: (n: string, v: string) => void; removeAttribute: (n: string) => void } {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (name, value) => { attrs.set(name, value); },
    removeAttribute: (name) => { attrs.delete(name); },
  };
}

test('F3: the pair is written onto the control, expanded state both ways', () => {
  const node = fakeNode();
  applyDisclosureAttributes(node, true, 'card-1');
  assert.deepEqual([...node.attrs], [['aria-expanded', 'true'], ['aria-controls', 'card-1']]);
  // Collapsing rewrites the state (the attribute is a real state, not an
  // existence flag) and drops the pointer to the now-unrendered card.
  applyDisclosureAttributes(node, false, undefined);
  assert.deepEqual([...node.attrs], [['aria-expanded', 'false']]);
  assert.equal(node.attrs.has('aria-controls'), false, 'a stale id must never survive the collapse');
});

test('F3: a detached control is a no-op, never a crash', () => {
  // The effect runs on mount and on every flip; a null node (unmounted row, or a
  // primitive that has not attached yet) must simply do nothing.
  assert.doesNotThrow(() => { applyDisclosureAttributes(null, true, 'card-1'); });
});
