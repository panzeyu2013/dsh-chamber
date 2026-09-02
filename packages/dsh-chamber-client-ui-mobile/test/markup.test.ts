/**
 * Markup helper tests: frame/column stamping plus the re-stamp predicate
 * (isStructuralTarget/shouldRestamp) against the empirical 0.1.2-alpha.4 DOM
 * shape (a3/a4 ui-layout AppFrame byte-identical — alpha.4 anchor audit),
 * exercised with a minimal ElementLike/StructuralNodeLike fake (plain node
 * has no DOM).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ElementLike } from '../src/client/markup.ts'
import {
  findFrame, findColumn, stampFrame,
  isStructuralTarget, isElementNode, shouldRestamp,
} from '../src/client/markup.ts'

/**
 * Minimal ElementLike/StructuralNodeLike fake: tag + attributes + children
 * with a wired parent chain and attribute-selector matching.
 */
class FakeElement implements ElementLike {
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly tag: string
  parent: FakeElement | null = null
  constructor(tag: string) { this.tag = tag }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null }
  get parentElement(): FakeElement | null { return this.parent }
  matches(selector: string): boolean {
    // Only the plugin's own attribute selectors are ever evaluated on fakes:
    // '[attr]' presence and '[attr="value"]' equality.
    const parsed = /^\[([a-z][a-z-]*)(?:="([^"]*)")?\]$/.exec(selector)
    if (parsed === null) return false
    const [, name, value] = parsed
    if (value === undefined) return this.attributes.has(name)
    return this.attributes.get(name) === value
  }
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

/** Attach child to parent, wiring the parent chain (matches() needs it). */
function attach(parent: FakeElement, child: FakeElement): FakeElement {
  parent.children.push(child)
  child.parent = parent
  return child
}

/** The inner [data-slot] outlet container (slot scope outlet). */
function outlet(slot: string): FakeElement {
  const inner = new FakeElement('div')
  inner.setAttribute('data-slot', slot)
  return inner
}

/** A resident column shell WITH its outlet mounted. */
function columnShell(slot: string): FakeElement {
  const col = new FakeElement('div')
  attach(col, outlet(slot))
  return col
}

/** The with-session DOM shape used by the original tests: every column
 * shell already carries its outlet. */
function fullFrame(): { root: FakeElement; frame: FakeElement } {
  const root = new FakeElement('div')
  root.setAttribute('data-slot', 'root')
  const frame = new FakeElement('div')
  attach(root, frame)
  attach(frame, columnShell('sidebar'))
  attach(frame, columnShell('conversation'))
  attach(frame, columnShell('details'))
  return { root, frame }
}

/** The real alpha.4 boot shape: resident shells; sidebar/conversation
 * outlets present from first paint, the details shell EMPTY (its outlet is
 * session-gated and mounts only when a session activates). */
function bootFrame(): { root: FakeElement; frame: FakeElement; detailsCol: FakeElement } {
  const root = new FakeElement('div')
  root.setAttribute('data-slot', 'root')
  const frame = new FakeElement('div')
  attach(root, frame)
  attach(frame, columnShell('sidebar'))
  attach(frame, columnShell('conversation'))
  const detailsCol = new FakeElement('div')
  attach(frame, detailsCol)
  return { root, frame, detailsCol }
}

test('findFrame returns the first element child of the root slot', () => {
  const { root, frame } = fullFrame()
  assert.equal(findFrame(root), frame)
  assert.equal(findFrame(new FakeElement('div')), null)
})

test('findColumn locates columns by their inner data-slot', () => {
  const { frame } = fullFrame()
  assert.equal(findColumn(frame, 'sidebar'), frame.children[0])
  assert.equal(findColumn(frame, 'details'), frame.children[2])
  assert.equal(findColumn(frame, 'sidebar')?.getAttribute('data-mobile-role'), null)
})

test('stampFrame stamps the frame and all three columns (idempotent)', () => {
  const { root, frame } = fullFrame()
  assert.equal(stampFrame(root), frame)
  assert.equal(frame.hasAttribute('data-mobile-frame'), true)
  for (const [index, role] of ['sidebar', 'conversation', 'details'].entries()) {
    assert.equal(frame.children[index].getAttribute('data-mobile-role'), role)
  }
  stampFrame(root)
  assert.equal(frame.children[0].getAttribute('data-mobile-role'), 'sidebar')
})

// ---------------------------------------------------------------------------
// Re-stamp predicate (alpha.4 anchor audit): a slot outlet mounting inside a
// resident column shell must count as structural, while deep content stays
// filtered out of the streaming hot path.
// ---------------------------------------------------------------------------

test('isStructuralTarget: a boot-time stamp skips the empty details shell', () => {
  const { root, frame, detailsCol } = bootFrame()
  stampFrame(root)
  assert.equal(frame.hasAttribute('data-mobile-frame'), true)
  assert.equal(frame.children[0].getAttribute('data-mobile-role'), 'sidebar')
  assert.equal(frame.children[1].getAttribute('data-mobile-role'), 'conversation')
  assert.equal(detailsCol.hasAttribute('data-mobile-role'), false,
    'the resident empty details shell must NOT be stamped at boot')
})

test('isStructuralTarget: session activation outlet mount re-stamps details (alpha.4 regression)', () => {
  const { root, detailsCol } = bootFrame()
  stampFrame(root)
  // Session activates: the [data-slot="details"] outlet mounts INSIDE the
  // resident (unstamped) shell — two levels under the stamped frame.
  const mounted = attach(detailsCol, outlet('details'))
  assert.equal(isStructuralTarget(mounted), true,
    'an outlet mounting inside a resident column shell is structural')
  stampFrame(root)
  assert.equal(detailsCol.getAttribute('data-mobile-role'), 'details',
    're-stamp after the outlet mount must converge the details role')
})

test('isStructuralTarget: the same late-outlet shape works for sidebar/conversation', () => {
  const root = new FakeElement('div')
  root.setAttribute('data-slot', 'root')
  const frame = new FakeElement('div')
  attach(root, frame)
  stampFrame(root)
  for (const slot of ['sidebar', 'conversation'] as const) {
    const shell = new FakeElement('div')
    attach(frame, shell)
    const mounted = attach(shell, outlet(slot))
    assert.equal(isStructuralTarget(mounted), true, `${slot} outlet mount must be structural`)
    stampFrame(root)
    assert.equal(shell.getAttribute('data-mobile-role'), slot)
  }
})

test('isStructuralTarget: deep content under a stamped column is NOT structural (streaming filter)', () => {
  const { root } = fullFrame()
  stampFrame(root)
  // Chat streaming mounts content inside the conversation outlet — several
  // levels below the frame: outlet > block > node.
  const frame = findFrame(root) as FakeElement
  const conversationCol = frame.children[1]
  const conversationOutlet = conversationCol.children[0]
  const block = new FakeElement('div')
  attach(conversationOutlet, block)
  const streamed = new FakeElement('div')
  attach(block, streamed)
  assert.equal(isStructuralTarget(streamed), false, 'deep content never matches')
  assert.equal(isStructuralTarget(block), false, 'one level inside the outlet never matches')
  // Even a DIRECT child of the stamped outlet container is not structural:
  // its grandparent is the stamped COLUMN, not the frame.
  const direct = new FakeElement('div')
  attach(conversationOutlet, direct)
  assert.equal(isStructuralTarget(direct), false)
})

test('isStructuralTarget: whole-column and frame mounts still trigger (regression)', () => {
  const root = new FakeElement('div')
  root.setAttribute('data-slot', 'root')
  const frame = new FakeElement('div')
  attach(root, frame)
  stampFrame(root)
  // A whole column shell (with outlet) mounting under the stamped frame.
  const wholeColumn = columnShell('details')
  attach(frame, wholeColumn)
  assert.equal(isStructuralTarget(wholeColumn), true)
  // A brand-new root slot (N-ctx second instance).
  assert.equal(isStructuralTarget(root), true)
  // A frame mounting directly under a root slot.
  const secondRoot = new FakeElement('div')
  secondRoot.setAttribute('data-slot', 'root')
  const secondFrame = new FakeElement('div')
  attach(secondRoot, secondFrame)
  assert.equal(isStructuralTarget(secondFrame), true)
  // A previously stamped frame reappearing (remount) is caught by its own
  // attribute.
  assert.equal(isStructuralTarget(frame), true)
})

test('isStructuralTarget: an already-stamped column reappearing (remount) is caught by its own role', () => {
  const { root, frame } = fullFrame()
  stampFrame(root)
  const sidebarCol = frame.children[0]
  assert.equal(sidebarCol.getAttribute('data-mobile-role'), 'sidebar')
  assert.equal(isStructuralTarget(sidebarCol), true,
    'a remounted stamped column carries data-mobile-role and must re-trigger')
})

test('shouldRestamp: batch decision — childList additions only, attribute records never reach it', () => {
  // A session-activation outlet mount inside a resident shell (full parent
  // chain, frame already stamped — the real shape the observer sees).
  const { root, detailsCol } = bootFrame()
  stampFrame(root)
  const outletNode = attach(detailsCol, outlet('details'))
  assert.equal(shouldRestamp([{ type: 'childList', addedNodes: [outletNode] }]), true)
  // Deep content: an element-like node that is NOT structural (no frame
  // ancestor within two levels).
  const deep = new FakeElement('div')
  assert.equal(shouldRestamp([{ type: 'childList', addedNodes: [deep] }]), false)
  // Text/comment nodes have no matches() — never structural.
  assert.equal(shouldRestamp([{ type: 'childList', addedNodes: ['text' as unknown] }]), false)
  // Attribute records are a separate channel — the childList batch decision
  // must ignore them even when bundled into the same callback batch.
  assert.equal(shouldRestamp([{ type: 'attributes', addedNodes: [] }]), false)
  assert.equal(shouldRestamp([
    { type: 'attributes', addedNodes: [] },
    { type: 'childList', addedNodes: [outletNode] },
  ]), true)
  assert.equal(shouldRestamp([]), false)
})

test('isElementNode guards non-element additions', () => {
  assert.equal(isElementNode(new FakeElement('div')), true)
  assert.equal(isElementNode({ matches: () => true }), true)
  assert.equal(isElementNode('text'), false)
  assert.equal(isElementNode(null), false)
  assert.equal(isElementNode(undefined), false)
  assert.equal(isElementNode({}), false)
})
