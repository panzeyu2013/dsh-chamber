/**
 * Markup helper tests: frame/column stamping plus the re-stamp predicate
 * (isStructuralTarget/shouldRestamp) against the empirical 0.1.5-alpha.2 DOM
 * shape (the centre column is the keyed `main` slot, the right column is
 * `rightbar`), exercised with the shared plain-node double
 * (test/support/dom-double.ts; plain node has no DOM).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findFrame, findColumn, stampFrame, ROLE_SLOT_KEYS,
  isStructuralTarget, isElementNode, shouldRestamp,
} from '../../src/client/markup.ts'
import { FakeNode as FakeElement, attach } from '../support/dom-double.ts'

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
  attach(frame, columnShell(ROLE_SLOT_KEYS.sidebar))
  attach(frame, columnShell(ROLE_SLOT_KEYS.conversation))
  attach(frame, columnShell(ROLE_SLOT_KEYS.details))
  return { root, frame }
}

/** The alpha.2 boot shape: resident shells; the sidebar and centre (`main`)
 * outlets are present from first paint, the right column shell is EMPTY
 * until its docking surface registers. */
function bootFrame(): { root: FakeElement; frame: FakeElement; detailsCol: FakeElement } {
  const root = new FakeElement('div')
  root.setAttribute('data-slot', 'root')
  const frame = new FakeElement('div')
  attach(root, frame)
  attach(frame, columnShell(ROLE_SLOT_KEYS.sidebar))
  attach(frame, columnShell(ROLE_SLOT_KEYS.conversation))
  const detailsCol = new FakeElement('div')
  attach(frame, detailsCol)
  return { root, frame, detailsCol }
}

test('findFrame returns the first element child of the root slot', () => {
  const { root, frame } = fullFrame()
  assert.equal(findFrame(root), frame)
  assert.equal(findFrame(new FakeElement('div')), null)
})

test('findColumn locates columns by their inner data-slot key', () => {
  const { frame } = fullFrame()
  assert.equal(findColumn(frame, ROLE_SLOT_KEYS.sidebar), frame.children[0])
  assert.equal(findColumn(frame, ROLE_SLOT_KEYS.conversation), frame.children[1])
  assert.equal(findColumn(frame, ROLE_SLOT_KEYS.details), frame.children[2])
  assert.equal(findColumn(frame, ROLE_SLOT_KEYS.sidebar)?.getAttribute('data-mobile-role'), null)
})

test('ROLE_SLOT_KEYS tracks the alpha.2 vendor slot names', () => {
  assert.deepEqual(ROLE_SLOT_KEYS, { sidebar: 'sidebar', conversation: 'main', details: 'rightbar' })
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

test('stampFrame records the roles it actually found', () => {
  const { root, frame } = fullFrame()
  stampFrame(root)
  assert.equal(frame.getAttribute('data-mobile-roles'), 'sidebar conversation details')
  // The alpha.2 boot shape: the details shell is resident but EMPTY, so only
  // two roles are stamped — the diagnostic must not over-report.
  const boot = bootFrame()
  stampFrame(boot.root)
  assert.equal(boot.frame.getAttribute('data-mobile-roles'), 'sidebar conversation')
  assert.equal(boot.detailsCol.getAttribute('data-mobile-role'), null)
})

test('stampFrame refuses to adapt a frame without the conversation column', () => {
  // The 0px-track brake: the grid lock plus a fixed drawer are
  // only sound while the conversation column is pinned by its own role
  // attribute. A vendor rename of the centre key must leave the page in the
  // official narrow layout, not in a clipped 0px transcript.
  const root = new FakeElement('div')
  root.setAttribute('data-slot', 'root')
  const frame = new FakeElement('div')
  attach(root, frame)
  const sidebar = attach(frame, columnShell(ROLE_SLOT_KEYS.sidebar))
  const details = attach(frame, columnShell(ROLE_SLOT_KEYS.details))
  assert.equal(stampFrame(root), null)
  assert.equal(frame.hasAttribute('data-mobile-frame'), false)
  assert.equal(frame.hasAttribute('data-mobile-roles'), false)
  assert.equal(sidebar.getAttribute('data-mobile-role'), null)
  assert.equal(details.getAttribute('data-mobile-role'), null)
})

// ---------------------------------------------------------------------------
// Re-stamp predicate (design 17 §18): a slot outlet mounting inside a
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

test('isStructuralTarget: a right-column outlet mount re-stamps the resident shell', () => {
  const { root, detailsCol } = bootFrame()
  stampFrame(root)
  // Session activates: the [data-slot="details"] outlet mounts INSIDE the
  // resident (unstamped) shell — two levels under the stamped frame.
  const mounted = attach(detailsCol, outlet(ROLE_SLOT_KEYS.details))
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
  // The sidebar arrives first: its outlet mount is structural (the observer
  // must re-stamp), but the all-or-nothing rule refuses to adapt the frame
  // until the conversation column exists.
  const sidebarShell = new FakeElement('div')
  attach(frame, sidebarShell)
  assert.equal(isStructuralTarget(attach(sidebarShell, outlet(ROLE_SLOT_KEYS.sidebar))), true,
    'sidebar outlet mount must be structural')
  assert.equal(stampFrame(root), null)
  assert.equal(sidebarShell.getAttribute('data-mobile-role'), null)
  // The conversation column lands: the same pass stamps BOTH columns.
  const conversationShell = new FakeElement('div')
  attach(frame, conversationShell)
  assert.equal(isStructuralTarget(attach(conversationShell, outlet(ROLE_SLOT_KEYS.conversation))), true,
    'conversation outlet mount must be structural')
  assert.equal(stampFrame(root), frame)
  assert.equal(sidebarShell.getAttribute('data-mobile-role'), 'sidebar')
  assert.equal(conversationShell.getAttribute('data-mobile-role'), 'conversation')
})

test('isStructuralTarget: streaming content under the scroll body is NOT structural (streaming filter)', () => {
  const { root } = fullFrame()
  stampFrame(root)
  // Real conversation depth: outlet > .root[data-phase] > .body >
  // [data-conversation-scroll] > streamed messages — six hops to the frame.
  const frame = findFrame(root) as FakeElement
  const conversationCol = frame.children[1]
  const conversationOutlet = conversationCol.children[0]
  const rootDiv = new FakeElement('div')
  attach(conversationOutlet, rootDiv)
  const bodyDiv = new FakeElement('div')
  attach(rootDiv, bodyDiv)
  const scrollBody = new FakeElement('div')
  scrollBody.setAttribute('data-conversation-scroll', '')
  attach(bodyDiv, scrollBody)
  const streamed = new FakeElement('div')
  attach(scrollBody, streamed)
  const block = new FakeElement('div')
  attach(scrollBody, block)
  // Streaming nodes sit ≥6 hops below the frame: never structural.
  assert.equal(isStructuralTarget(streamed), false, 'deep streamed content never matches')
  assert.equal(isStructuralTarget(block), false, 'content directly inside the scroll body never matches')
  // The CONVERSATION ROOT container mounting under the outlet (three hops to
  // the column role) IS structural — a resident shell gaining its content
  // must be re-stamped (bounded walk covers node + 4 ancestors).
  assert.equal(isStructuralTarget(rootDiv), true, 'the ConversationRoot mount must re-stamp')
})

test('isStructuralTarget: whole-column and frame mounts still trigger (regression)', () => {
  const root = new FakeElement('div')
  root.setAttribute('data-slot', 'root')
  const frame = new FakeElement('div')
  attach(root, frame)
  stampFrame(root)
  // A whole column shell (with outlet) mounting under the stamped frame.
  const wholeColumn = columnShell(ROLE_SLOT_KEYS.details)
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
  const outletNode = attach(detailsCol, outlet(ROLE_SLOT_KEYS.details))
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
