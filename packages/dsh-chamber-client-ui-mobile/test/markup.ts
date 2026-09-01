/**
 * Markup helper tests: frame/column stamping against the empirical
 * 0.1.2-alpha.3 DOM shape, exercised with a minimal ElementLike fake
 * (plain node has no DOM).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ElementLike } from '../src/client/markup.ts'
import {
  findFrame, findColumn, stampFrame,
} from '../src/client/markup.ts'

/** Minimal ElementLike fake: tag + attributes + children. */
class FakeElement implements ElementLike {
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly tag: string
  constructor(tag: string) { this.tag = tag }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if (child.tag === selector) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

function column(slot: string): FakeElement {
  const col = new FakeElement('div')
  const inner = new FakeElement('div')
  inner.setAttribute('data-slot', slot)
  col.children.push(inner)
  return col
}

function officialFrame(): { root: FakeElement; frame: FakeElement } {
  const root = new FakeElement('div')
  root.setAttribute('data-slot', 'root')
  const frame = new FakeElement('div')
  frame.children.push(column('sidebar'), column('conversation'), column('details'))
  root.children.push(frame)
  return { root, frame }
}

test('findFrame returns the first element child of the root slot', () => {
  const { root, frame } = officialFrame()
  assert.equal(findFrame(root), frame)
  assert.equal(findFrame(new FakeElement('div')), null)
})

test('findColumn locates columns by their inner data-slot', () => {
  const { frame } = officialFrame()
  assert.equal(findColumn(frame, 'sidebar'), frame.children[0])
  assert.equal(findColumn(frame, 'details'), frame.children[2])
  assert.equal(findColumn(frame, 'sidebar')?.getAttribute('data-mobile-role'), null)
})

test('stampFrame stamps the frame and all three columns (idempotent)', () => {
  const { root, frame } = officialFrame()
  assert.equal(stampFrame(root), frame)
  assert.equal(frame.hasAttribute('data-mobile-frame'), true)
  for (const [index, role] of ['sidebar', 'conversation', 'details'].entries()) {
    assert.equal(frame.children[index].getAttribute('data-mobile-role'), role)
  }
  stampFrame(root)
  assert.equal(frame.children[0].getAttribute('data-mobile-role'), 'sidebar')
})
