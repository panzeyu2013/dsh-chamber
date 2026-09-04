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
  stampSessionLogDismiss, isSessionLogExportButton,
  SESSION_LOG_DISMISS_ATTR, SESSION_LOG_DISMISS_VALUE,
  CONVERSATION_SESSION_HEADER_SLOT,
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
  /** Text copy for label matching (real DOM: Element.textContent). */
  textContent = ''
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
  // the column role) IS structural — it carries the session header outlet;
  // without it the header chrome stamp could miss a late header mount
  // (2026 review widening: bounded walk covers node + 4 ancestors).
  assert.equal(isStructuralTarget(rootDiv), true, 'the ConversationRoot mount must re-stamp')
  const headerOutlet = outlet(CONVERSATION_SESSION_HEADER_SLOT)
  attach(rootDiv, headerOutlet)
  assert.equal(isStructuralTarget(headerOutlet), true,
    'the session header slot outlet mounting four levels under the frame is structural')
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

// ---------------------------------------------------------------------------
// Session-header chrome stamps: the "Session 日志" export capsule
// (official session-log-export, header utilities) gets the phone-tier
// compact mark. The stamp walks the anchor shape (conversation column →
// session-header slot outlet → buttons) and matches the bilingual official
// copy + the structural download-icon guard.
// ---------------------------------------------------------------------------

/** The with-session header DOM shape: resident conversation column with the
 * session-gated header outlet mounted (session open). */
function headerFrame(labels: Array<{ text: string; svg: boolean }>): { root: FakeElement; buttons: FakeElement[] } {
  const { root, frame } = fullFrame()
  const conversationCol = frame.children[1]
  const conversationOutlet = conversationCol.children[0]
  const rootDiv = new FakeElement('div')
  attach(conversationOutlet, rootDiv)
  const headerSlot = new FakeElement('div')
  headerSlot.setAttribute('data-slot', CONVERSATION_SESSION_HEADER_SLOT)
  attach(rootDiv, headerSlot)
  const header = new FakeElement('header')
  attach(headerSlot, header)
  const titleRow = new FakeElement('div')
  attach(header, titleRow)
  const utilities = new FakeElement('div')
  attach(titleRow, utilities)
  const buttons: FakeElement[] = []
  for (const { text, svg } of labels) {
    const button = new FakeElement('button')
    button.textContent = text
    if (svg) attach(button, new FakeElement('svg'))
    attach(utilities, button)
    buttons.push(button)
  }
  return { root, buttons }
}

test('stampSessionLogDismiss: no session header (hero/boot) stamps nothing', () => {
  const { root } = fullFrame()
  assert.equal(stampSessionLogDismiss(findFrame(root) as FakeElement), null)
  const { root: boot } = bootFrame()
  assert.equal(stampSessionLogDismiss(findFrame(boot) as FakeElement), null)
})

test('stampSessionLogDismiss: zh capsule is stamped (idempotent)', () => {
  const { root, buttons } = headerFrame([{ text: 'Session 日志', svg: true }])
  const frame = findFrame(root) as FakeElement
  const stamped = stampSessionLogDismiss(frame)
  assert.equal(stamped, buttons[0])
  assert.equal(buttons[0].getAttribute(SESSION_LOG_DISMISS_ATTR), SESSION_LOG_DISMISS_VALUE)
  // Idempotent: a second stamp keeps the single button marked.
  assert.equal(stampSessionLogDismiss(frame), buttons[0])
  assert.equal(buttons[0].getAttribute(SESSION_LOG_DISMISS_ATTR), SESSION_LOG_DISMISS_VALUE)
})

test('stampSessionLogDismiss: en capsule copy matches too', () => {
  const { root, buttons } = headerFrame([{ text: 'Session log', svg: true }])
  const stamped = stampSessionLogDismiss(findFrame(root) as FakeElement)
  assert.equal(stamped, buttons[0])
  assert.equal(buttons[0].getAttribute(SESSION_LOG_DISMISS_ATTR), SESSION_LOG_DISMISS_VALUE)
})

test('stampSessionLogDismiss: trailing whitespace does not defeat the match', () => {
  const { root } = headerFrame([{ text: '  Session 日志  ', svg: true }])
  assert.notEqual(stampSessionLogDismiss(findFrame(root) as FakeElement), null)
})

test('stampSessionLogDismiss: same copy without the download icon is NOT the capsule', () => {
  const { root } = headerFrame([{ text: 'Session 日志', svg: false }])
  assert.equal(stampSessionLogDismiss(findFrame(root) as FakeElement), null)
})

test('stampSessionLogDismiss: unrelated header buttons never match', () => {
  const { root, buttons } = headerFrame([
    { text: '3 个子代理', svg: true },
    { text: 'Session 日誌', svg: true }, // close but not the official copy
    { text: '设置', svg: false },
  ])
  const frame = findFrame(root) as FakeElement
  assert.equal(stampSessionLogDismiss(frame), null)
  for (const button of buttons) {
    assert.equal(button.hasAttribute(SESSION_LOG_DISMISS_ATTR), false)
  }
})

test('isSessionLogExportButton: pure label + icon decision', () => {
  const zh = new FakeElement('button')
  zh.textContent = 'Session 日志'
  attach(zh, new FakeElement('svg'))
  assert.equal(isSessionLogExportButton(zh), true)
  const plain = new FakeElement('button')
  plain.textContent = 'Session 日志'
  assert.equal(isSessionLogExportButton(plain), false)
  const other = new FakeElement('button')
  other.textContent = '下载'
  attach(other, new FakeElement('svg'))
  assert.equal(isSessionLogExportButton(other), false)
})
