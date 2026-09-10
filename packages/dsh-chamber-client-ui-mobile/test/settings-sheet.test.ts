/**
 * Settings-sheet chip predicate tests: the section-switch scroll reset must
 * fire only on a CHIP click (a button whose nearest nav ancestor is the
 * settings nav) — never on the nav title, the options area or the dialog
 * chrome. The DOM-bound installer stays device-gated (§18.6); the decision is
 * pure and duck-typed, so it is covered here without a DOM (same pattern as
 * composer.test.ts's ClosestStub).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSectionChipClick, type ChipTargetLike } from '../src/client/settings-sheet.ts'

/** closest() stub: `chain` maps a selector to the node it resolves to. */
class NodeStub implements ChipTargetLike {
  readonly chain: Record<string, NodeStub>
  constructor(chain: Record<string, NodeStub> = {}) { this.chain = chain }
  closest(selector: string): ChipTargetLike | null {
    return this.chain[selector] ?? null
  }
}

test('isSectionChipClick: a chip button inside the settings nav resets', () => {
  // The click target is the chip's inner <svg>/<span>: closest('button')
  // walks up to the official navCell, whose closest('nav') is the settings nav.
  const nav = new NodeStub()
  const chip = new NodeStub({ nav })
  const target = new NodeStub({ button: chip })
  assert.equal(isSectionChipClick(target, nav), true)
})

test('isSectionChipClick: the nav title (no button ancestor) never resets', () => {
  const nav = new NodeStub()
  const title = new NodeStub({ nav })
  assert.equal(isSectionChipClick(title, nav), false)
})

test('isSectionChipClick: a button OUTSIDE the settings nav (Close/actions) never resets', () => {
  const nav = new NodeStub()
  const dialog = new NodeStub()
  const close = new NodeStub({ dialog })
  const target = new NodeStub({ button: close })
  assert.equal(isSectionChipClick(target, nav), false)
})

test('isSectionChipClick: a chip inside a NESTED nav is not the settings nav', () => {
  // closest() returns the nearest nav, so a nested nav cannot impersonate the
  // settings nav (contains() would have accepted it).
  const nav = new NodeStub()
  const nested = new NodeStub({ nav })
  const chip = new NodeStub({ nav: nested })
  const target = new NodeStub({ button: chip })
  assert.equal(isSectionChipClick(target, nav), false)
})

test('isSectionChipClick: null-tolerant on both sides', () => {
  assert.equal(isSectionChipClick(null, new NodeStub()), false)
  assert.equal(isSectionChipClick(new NodeStub(), null), false)
})
