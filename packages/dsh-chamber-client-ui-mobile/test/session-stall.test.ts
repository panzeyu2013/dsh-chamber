/**
 * Session-load stall notice tests. The package has no DOM environment, so the
 * probe is driven by a hand-built DOM double (the markup.test.ts style: plain
 * nodes with a wired parent chain and an attribute-selector engine) and the
 * decisions are pure functions. The double's selector engine speaks EXACTLY
 * the module's anchor grammar — `[attr]`, `[attr="value"]`, a bare tag and
 * `parent > child` — and throws on anything else, so a new anchor in the
 * module fails here loudly instead of passing silently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MobileKey } from '../src/client/locales.ts'
import { en, zh } from '../src/client/locales.ts'
import {
  CHAT_FLOW_QUERY, CHAT_ROW_QUERY, CONVERSATION_PHASE_QUERY,
  SESSION_HEADER_QUERY, STALL_NOTICE_ACTION_CLASS, STALL_NOTICE_CLASS,
  STALL_NOTICE_CSS, STALL_NOTICE_GAP_PX, STALL_NOTICE_MESSAGE_CLASS,
  STALL_NOTICE_MIN_VISIBLE_PX, STALL_POLL_MS, STALL_STYLE_TAG, STALL_THRESHOLD_MS,
  STALL_PHASES, decideStallNotice, installSessionStallNotice, isRendered, isStallPhase, isStallShape,
  noticeTopFor, probeStall,
} from '../src/client/session-stall.ts'
import type { RenderedNodeFace, StallNodeFace } from '../src/client/session-stall.ts'

const SOURCE_URL = new URL('../src/client/session-stall.ts', import.meta.url)

// ---------------------------------------------------------------------------
// The DOM double: a node with attributes, a parent chain, the real
// querySelector/closest semantics (descendants only for queries, self
// included for closest) and the module's anchor grammar.
// ---------------------------------------------------------------------------

interface SimpleSelector {
  readonly tag: string | null
  readonly attr: string | null
  readonly value: string | null
}

/** Parse one compound selector (`tag`, `[attr]`, `[attr="v"]`, `tag[attr="v"]`);
 *  anything outside the anchor grammar throws. */
function parseSimple(selector: string): SimpleSelector {
  const match = /^([a-z][a-z0-9-]*)?(\[([a-z][a-z0-9-]*)(?:="([^"]*)")?\])?$/.exec(selector)
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    throw new Error(`unsupported selector "${selector}": the double speaks attribute anchors only`)
  }
  return { tag: match[1] ?? null, attr: match[3] ?? null, value: match[4] ?? null }
}

function matchesSimple(node: FakeNode, selector: SimpleSelector): boolean {
  if (selector.tag !== null && node.tag !== selector.tag) return false
  if (selector.attr === null) return selector.tag !== null
  if (selector.value === null) return node.hasAttribute(selector.attr)
  return node.getAttribute(selector.attr) === selector.value
}

class FakeNode implements StallNodeFace, RenderedNodeFace {
  readonly children: FakeNode[] = []
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Array<() => void>>()
  readonly tag: string
  parent: FakeNode | null = null
  connected = true
  display = 'block'
  visibility = 'visible'
  rect: { bottom: number } | null = null
  className = ''
  textContent = ''
  type = ''
  readonly style: { top: string; removeProperty(name: string): void } = {
    top: '',
    removeProperty: (name: string): void => { if (name === 'top') this.style.top = '' },
  }
  constructor(tag: string) { this.tag = tag }
  get isConnected(): boolean { return this.connected }
  get parentElement(): FakeNode | null { return this.parent }
  setAttribute(name: string, value = ''): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  addEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  dispatch(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler()
  }
  click(): void { this.dispatch('click') }
  append(...nodes: FakeNode[]): void { for (const node of nodes) attach(this, node) }
  appendChild(node: FakeNode): FakeNode { return attach(this, node) }
  remove(): void {
    const parent = this.parent
    if (parent === null) return
    const index = parent.children.indexOf(this)
    if (index !== -1) parent.children.splice(index, 1)
    this.parent = null
  }
  querySelector(selector: string): FakeNode | null { return this.findAll(selector)[0] ?? null }
  querySelectorAll(selector: string): FakeNode[] { return this.findAll(selector) }
  closest(selector: string): FakeNode | null {
    const simple = parseSimple(selector)
    for (let node: FakeNode | null = this; node !== null; node = node.parent) {
      if (matchesSimple(node, simple)) return node
    }
    return null
  }
  getBoundingClientRect(): { bottom: number } { return this.rect ?? { bottom: 0 } }
  /** Descendants only, document order — the real DOM semantics. */
  findAll(selector: string): FakeNode[] {
    const parts = selector.split(' > ')
    const child = parseSimple(parts[parts.length - 1] as string)
    const parent = parts.length > 1 ? parseSimple(parts[parts.length - 2] as string) : null
    const out: FakeNode[] = []
    const walk = (node: FakeNode): void => {
      for (const candidate of node.children) {
        if (matchesSimple(candidate, child)
          && (parent === null || (candidate.parent !== null && matchesSimple(candidate.parent, parent)))) {
          out.push(candidate)
        }
        walk(candidate)
      }
    }
    walk(this)
    return out
  }
}

function attach(parent: FakeNode, child: FakeNode): FakeNode {
  parent.children.push(child)
  child.parent = parent
  return child
}

/** The production render check, driven by the double's own style fields. */
function renderedInFakes(node: StallNodeFace): boolean {
  return isRendered(node as unknown as FakeNode, current => {
    const fake = current as unknown as FakeNode
    return { display: fake.display, visibility: fake.visibility }
  })
}

interface ConversationTree {
  readonly root: FakeNode
  readonly phase: FakeNode | null
  readonly flow: FakeNode | null
  readonly header: FakeNode | null
  readonly slot: FakeNode | null
}

/**
 * The empirical conversation shape, straight from markup.ts's re-audited DOM
 * map (alpha.2): `[data-slot="main"] > div.root[data-phase] >
 * div[data-slot="conversation.session.header"] > <header>`, with the message
 * column below the same phase node:
 *   root slot > frame > conversation column > main outlet >
 *     .root[data-phase] > (header outlet > header, body > flow > rows).
 * A session-less page renders none of it (the header is session-gated).
 */
function conversation(options: {
  /** The phase value; `null` omits the phase node entirely. */
  phase?: string | null
  header?: 'shown' | 'hidden' | 'absent' | 'nested'
  rows?: number
  flow?: boolean
  /** Extra rows outside the flow (must never count). */
  strayRows?: number
} = {}): ConversationTree {
  const root = new FakeNode('div')
  root.setAttribute('data-slot', 'root')
  const frame = new FakeNode('div')
  attach(root, frame)
  const column = new FakeNode('div')
  column.setAttribute('data-mobile-role', 'conversation')
  attach(frame, column)

  const outlet = new FakeNode('div')
  outlet.setAttribute('data-slot', 'main')
  attach(column, outlet)
  const value = options.phase === undefined ? 'active' : options.phase
  let phase: FakeNode | null = null
  let container = outlet
  if (value !== null) {
    phase = new FakeNode('div')
    phase.setAttribute('data-phase', value)
    attach(outlet, phase)
    container = phase
  }

  let slot: FakeNode | null = null
  let header: FakeNode | null = null
  if (options.header !== 'absent') {
    slot = new FakeNode('div')
    slot.setAttribute('data-slot', 'conversation.session.header')
    attach(container, slot)
    if (options.header === 'nested') {
      const wrapper = new FakeNode('div')
      attach(slot, wrapper)
      header = attach(wrapper, new FakeNode('header'))
    } else {
      header = attach(slot, new FakeNode('header'))
      if (options.header === 'hidden') header.display = 'none'
    }
  }

  let flow: FakeNode | null = null
  if (options.flow !== false) {
    const body = new FakeNode('div')
    attach(container, body)
    flow = new FakeNode('div')
    flow.setAttribute('data-chat-flow', '')
    attach(body, flow)
    for (let index = 0; index < (options.rows ?? 0); index += 1) {
      attach(flow, new FakeNode('div')).setAttribute('data-chat-anchor-key', `k${index}`)
    }
    for (let index = 0; index < (options.strayRows ?? 0); index += 1) {
      attach(column, new FakeNode('div')).setAttribute('data-chat-anchor-key', `stray${index}`)
    }
  }
  return { root, phase, flow, header, slot }
}

/** The end-to-end predicate the installer runs, over one double tree. */
function shapeOf(tree: ConversationTree): boolean {
  return isStallShape(probeStall(tree.root, { isVisible: renderedInFakes }))
}

// ---------------------------------------------------------------------------
// Constants and the anchor discipline (no copy matching, no hash classes).
// ---------------------------------------------------------------------------

test('the stall window is the documented 45s and the poll stays in the low-frequency band', () => {
  assert.equal(STALL_THRESHOLD_MS, 45_000)
  assert.ok(STALL_POLL_MS >= 2_000 && STALL_POLL_MS <= 5_000,
    `poll cadence ${STALL_POLL_MS}ms must stay in the documented 2-5s band`)
})

test('every anchor is an attribute selector — no hashed class, no copy', () => {
  for (const selector of [CONVERSATION_PHASE_QUERY, CHAT_FLOW_QUERY, CHAT_ROW_QUERY, SESSION_HEADER_QUERY]) {
    assert.match(selector, /^\[/, `${selector} must start at an attribute anchor`)
    // Attribute VALUES legitimately carry dots (slot names); the selector
    // SYNTAX must not reach for a class/id anchor.
    const syntax = selector.replace(/"[^"]*"/g, '""')
    assert.ok(!syntax.includes('.') && !syntax.includes('#'), `${selector} must not use a class/id anchor`)
    assert.ok(!/[\u4e00-\u9fff]/.test(selector), `${selector} must not carry copy`)
  }
  assert.deepEqual([...STALL_PHASES], ['active', 'engaging'])
  assert.equal(isStallPhase('engaging'), true)
  assert.equal(isStallPhase('blank'), false)
  assert.equal(isStallPhase(null), false)
  assert.equal(SESSION_HEADER_QUERY, '[data-slot="conversation.session.header"] > header')
})

test('the module matches no copy — the official loading key and CJK text stay out of it', () => {
  const source = readFileSync(fileURLToPath(SOURCE_URL), 'utf8')
  assert.ok(!source.includes('loadingHistory'), 'the official loading-history key must never be matched')
  assert.ok(!source.includes('载入') && !source.includes('加载'), 'the loading copy must never be matched')
  assert.ok(!/[\u4e00-\u9fff]/.test(source),
    'all copy belongs to locales.ts; the matcher module carries none')
})

test('the notice rides its own class family and its own style tag', () => {
  assert.equal(STALL_NOTICE_CLASS, 'dsh-mobile-stall')
  assert.equal(STALL_NOTICE_MESSAGE_CLASS, 'dsh-mobile-stall-message')
  assert.equal(STALL_NOTICE_ACTION_CLASS, 'dsh-mobile-stall-action')
  assert.equal(STALL_STYLE_TAG, 'dsh-chamber-mobile-stall')
  for (const name of [STALL_NOTICE_CLASS, STALL_NOTICE_MESSAGE_CLASS, STALL_NOTICE_ACTION_CLASS]) {
    assert.ok(name.startsWith('dsh-mobile-'), `${name} must join the nav-toggle/backdrop naming family`)
  }
})

test('the notice CSS defaults to hidden OUTSIDE the tier and never blocks taps', () => {
  // The default rule must come before any media query: the desktop face is
  // display:none even if the element ever survived a tier flip.
  const defaultRule = STALL_NOTICE_CSS.indexOf(`.${STALL_NOTICE_CLASS} {`)
  const media = STALL_NOTICE_CSS.indexOf('@media')
  assert.ok(defaultRule !== -1 && media !== -1 && defaultRule < media,
    'the display:none default must precede the tier media query')
  assert.match(STALL_NOTICE_CSS.slice(defaultRule, media), /display:\s*none/)
  assert.ok(STALL_NOTICE_CSS.includes('@media (max-width: 1023px) and (pointer: coarse)'),
    'the notice must ride the byte-identical touch tier')
  // Only the action takes taps; the rest of the notice passes them through.
  const noticeBlock = STALL_NOTICE_CSS.slice(media, STALL_NOTICE_CSS.indexOf(`.${STALL_NOTICE_MESSAGE_CLASS}`))
  assert.match(noticeBlock, /pointer-events:\s*none/)
  assert.match(STALL_NOTICE_CSS.slice(STALL_NOTICE_CSS.indexOf(`.${STALL_NOTICE_ACTION_CLASS}`)),
    /pointer-events:\s*auto/)
})

test('the notice copy exists in both dictionaries and adds no other key', () => {
  const keys = Object.keys(zh)
  assert.deepEqual(keys.filter(key => key.startsWith('dsh-chamber.mobile.stall.')), [
    'dsh-chamber.mobile.stall.message',
    'dsh-chamber.mobile.stall.action',
  ])
  for (const key of keys) assert.equal(typeof en[key as MobileKey], 'string', `${key} must be translated`)
  assert.deepEqual(Object.keys(en), keys, 'en must cover exactly the zh key set')
})

// ---------------------------------------------------------------------------
// The truth table, end to end over the DOM double.
// ---------------------------------------------------------------------------

test('stall shape: an active conversation with a displayed header and no rows is stalled', () => {
  const tree = conversation()
  const probe = probeStall(tree.root, { isVisible: renderedInFakes })
  assert.equal(probe.activeConversation, true)
  assert.equal(probe.headerVisible, true)
  assert.equal(probe.flowPresent, true)
  assert.equal(probe.hasRows, false)
  assert.equal(probe.activeRoot, tree.phase, 'the phase node is the session identity')
  assert.equal(probe.header, tree.header, 'the displayed header is the position anchor')
  assert.equal(isStallShape(probe), true)
})

test('stall truth table: blank / unknown / no phase, rows, hidden header, missing flow are NOT stalled', () => {
  assert.equal(shapeOf(conversation({ phase: 'engaging' })), true,
    'engaging (first prompt attempted, nothing produced yet) is a real conversation too — a stall there leaves the same empty column')
  assert.equal(shapeOf(conversation({ phase: 'blank' })), false, 'the no-conversation face is never a stall')
  assert.equal(shapeOf(conversation({ phase: 'hero' })), false,
    'an unknown phase value (outside the emitted active/engaging/blank space) never qualifies')
  assert.equal(shapeOf(conversation({ phase: null })), false, 'a flow with no phase ancestor is never a stall')
  assert.equal(shapeOf(conversation({ rows: 1 })), false, 'a rendered row disproves the stall')
  assert.equal(shapeOf(conversation({ rows: 40 })), false, 'many rows likewise')
  assert.equal(shapeOf(conversation({ header: 'hidden' })), false, 'a display:none header means no session is shown')
  assert.equal(shapeOf(conversation({ header: 'absent' })), false, 'a missing header means no session is shown')
  assert.equal(shapeOf(conversation({ flow: false })), false, 'no chat column, no chat surface to stall')
  assert.equal(shapeOf(conversation({ strayRows: 2 })), true,
    'rows outside the flow prove nothing about the flow')
})

test('the probe requires the header to be a DIRECT child of its outlet and the phase to be an ANCESTOR of the flow', () => {
  // A nested header inside the outlet is not the audited grammar.
  assert.equal(shapeOf(conversation({ header: 'nested' })), false,
    'only `[data-slot=...] > header` is the audited anchor')

  // An active phase elsewhere in the document must not vouch for this flow.
  const cross = conversation({ phase: null })
  const other = conversation({ phase: 'active' })
  attach(cross.root, other.root)
  const crossProbe = probeStall(cross.root, { isVisible: renderedInFakes })
  assert.equal(crossProbe.activeConversation, false,
    'an unrelated [data-phase="active"] node must not activate a phase-less flow')
  assert.equal(isStallShape(crossProbe), false)
})

test('a hidden ancestor hides the session header (display:none and visibility:hidden both count)', () => {
  const hiddenSlot = conversation()
  if (hiddenSlot.slot !== null) hiddenSlot.slot.display = 'none'
  assert.equal(shapeOf(hiddenSlot), false, 'the outlet itself may be display:none (blank face)')

  const invisibleSlot = conversation()
  if (invisibleSlot.slot !== null) invisibleSlot.slot.visibility = 'hidden'
  assert.equal(shapeOf(invisibleSlot), false, 'a visibility:hidden header is not a presented session')
})

test('the render check walks the whole ancestor chain', () => {
  const visible = new FakeNode('header')
  const parent = new FakeNode('div')
  attach(parent, visible)
  const styleOf = (node: RenderedNodeFace): { display: string; visibility: string } => {
    const fake = node as unknown as FakeNode
    return { display: fake.display, visibility: fake.visibility }
  }
  assert.equal(isRendered(visible, styleOf), true)
  visible.display = 'none'
  assert.equal(isRendered(visible, styleOf), false, 'the node itself')
  visible.display = 'block'
  parent.display = 'none'
  assert.equal(isRendered(visible, styleOf), false, 'an ancestor')
  parent.display = 'block'
  parent.visibility = 'hidden'
  assert.equal(isRendered(visible, styleOf), false, 'an inherited hidden visibility')
  parent.visibility = 'visible'
  parent.setAttribute('hidden')
  assert.equal(isRendered(visible, styleOf), false, 'the HTML hidden attribute on an ancestor')
  parent.attributes.delete('hidden')
  visible.setAttribute('hidden')
  assert.equal(isRendered(visible, styleOf), false, 'the HTML hidden attribute on the node')
  visible.attributes.delete('hidden')
  assert.equal(isRendered(visible, styleOf), true, 'back to rendered')
  visible.connected = false
  assert.equal(isRendered(visible, styleOf), false, 'a detached node is never rendered')
})

// ---------------------------------------------------------------------------
// The clock: continuity, the threshold boundary and the page-visibility gate.
// ---------------------------------------------------------------------------

test('the clock seeds at the first sighting and fires exactly at the threshold', () => {
  const first = decideStallNotice({ shape: true, pageVisible: true, since: 0, now: 1_000 })
  assert.deepEqual(first, { since: 1_000, show: false }, 'the clock starts, the notice does not')
  assert.deepEqual(
    decideStallNotice({ shape: true, pageVisible: true, since: first.since, now: 1_000 + STALL_THRESHOLD_MS - 1 }),
    { since: 1_000, show: false }, 'one millisecond short is not a stall')
  assert.deepEqual(
    decideStallNotice({ shape: true, pageVisible: true, since: first.since, now: 1_000 + STALL_THRESHOLD_MS }),
    { since: 1_000, show: true }, 'the threshold is inclusive')
})

test('the stall must be CONTINUOUS: any break zeroes the clock and restarts the window', () => {
  assert.deepEqual(decideStallNotice({ shape: false, pageVisible: true, since: 40_000, now: 46_000 }),
    { since: 0, show: false }, 'a row arrived (or the shape broke) — the clock resets')
  assert.deepEqual(decideStallNotice({ shape: true, pageVisible: true, since: 0, now: 47_000 }),
    { since: 47_000, show: false }, 'a re-formed stall starts a fresh window')
  // A long-lived shape with a broken middle: 30s + 30s around a reset is never 60s.
  const broken = decideStallNotice({ shape: true, pageVisible: true, since: 0, now: 10_000 })
  const reset = decideStallNotice({ shape: false, pageVisible: true, since: broken.since, now: 40_000 })
  const again = decideStallNotice({ shape: true, pageVisible: true, since: reset.since, now: 40_000 })
  assert.deepEqual(decideStallNotice({ shape: true, pageVisible: true, since: again.since, now: 40_000 + STALL_THRESHOLD_MS - 1 }),
    { since: 40_000, show: false })
})

test('a hidden page never counts and discards the accumulated visible time', () => {
  assert.deepEqual(decideStallNotice({ shape: true, pageVisible: false, since: 40_000, now: 900_000 }),
    { since: 0, show: false }, 'background time is not stall time')
  assert.deepEqual(decideStallNotice({ shape: true, pageVisible: true, since: 0, now: 900_000 }),
    { since: 900_000, show: false }, 'coming back starts a fresh visible window')
  assert.deepEqual(
    decideStallNotice({ shape: true, pageVisible: true, since: 900_000, now: 900_000 + STALL_THRESHOLD_MS }),
    { since: 900_000, show: true })
})

// ---------------------------------------------------------------------------
// Notice geometry and the DOM-free harness path.
// ---------------------------------------------------------------------------

test('noticeTopFor anchors under the header and clamps into the viewport', () => {
  assert.equal(noticeTopFor(null, 800), null, 'no header rect — the CSS fallback anchor holds')
  assert.equal(noticeTopFor({ bottom: 0 }, 800), null, 'a hidden/unlaid-out header reports 0')
  assert.equal(noticeTopFor({ bottom: Number.NaN }, 800), null, 'a degenerate rect is never trusted')
  assert.equal(noticeTopFor({ bottom: -5 }, 800), null)
  assert.equal(noticeTopFor({ bottom: 120 }, 800), 120 + STALL_NOTICE_GAP_PX)
  assert.equal(noticeTopFor({ bottom: 790 }, 800), 800 - STALL_NOTICE_MIN_VISIBLE_PX,
    'clamped to keep the notice on screen')
  assert.equal(noticeTopFor({ bottom: 120 }, Number.NaN), 120 + STALL_NOTICE_GAP_PX,
    'an unknown viewport keeps the unclamped anchor')
})

test('installSessionStallNotice is a DOM-free no-op in the plain-node harness', () => {
  assert.equal(typeof document, 'undefined', 'this package has no DOM environment — that is the point')
  const t = (key: MobileKey): string => zh[key]
  const dispose = installSessionStallNotice(t)
  assert.equal(typeof dispose, 'function')
  dispose()
  dispose()
  assert.equal(typeof en['dsh-chamber.mobile.stall.action'], 'string')
})

// ---------------------------------------------------------------------------
// The installer, driven through an injected fake document/window: the wiring
// (single install, poll, mount/unmount, the reload action, dispose) has no DOM
// base in this package otherwise, and it is the only part that touches the
// page. Time is a controlled clock, the poll is ticked by hand.
// ---------------------------------------------------------------------------

class FakeDocument extends FakeNode {
  readonly head = new FakeNode('head')
  readonly body = new FakeNode('body')
  visibilityState = 'visible'
  private readonly documentListeners = new Map<string, Array<() => void>>()
  constructor() {
    super('document')
    this.append(this.head, this.body)
  }
  createElement(tag: string): FakeNode { return new FakeNode(tag) }
  addEventListener(type: string, handler: () => void): void {
    const list = this.documentListeners.get(type) ?? []
    list.push(handler)
    this.documentListeners.set(type, list)
  }
  removeEventListener(type: string, handler: () => void): void {
    const list = this.documentListeners.get(type) ?? []
    const index = list.indexOf(handler)
    if (index !== -1) list.splice(index, 1)
  }
  setVisibility(state: 'visible' | 'hidden'): void {
    this.visibilityState = state
    for (const handler of this.documentListeners.get('visibilitychange') ?? []) handler()
  }
}

interface StallHarness {
  readonly document: FakeDocument
  /** Advance the controlled clock and run the pending poll once. */
  at(millis: number): void
  /** The mounted notice, or null. */
  notice(): FakeNode | null
  reloads(): number
  intervals(): number
  visibility(state: 'visible' | 'hidden'): void
}

/** Run one installer scenario against a fake browser, restoring the globals.
 *  The clock starts at BASE (never 0: the pure clock uses 0 as its "not
 *  timing" sentinel, exactly like composer.ts's lockClock) and `at()` takes
 *  milliseconds relative to it. */
const BASE_TIME = 1_000_000

function withFakeBrowser(run: (harness: StallHarness) => void): void {
  const document = new FakeDocument()
  const globals = globalThis as unknown as Record<string, unknown>
  const previous = {
    document: globals.document,
    window: globals.window,
    getComputedStyle: globals.getComputedStyle,
    now: Date.now,
  }
  let now = BASE_TIME
  let reloadCount = 0
  const intervals = new Map<number, () => void>()
  let nextInterval = 1
  const fakeWindow = {
    innerHeight: 800,
    location: { reload: (): void => { reloadCount += 1 } },
    setInterval: (handler: () => void): number => {
      const id = nextInterval
      nextInterval += 1
      intervals.set(id, handler)
      return id
    },
    clearInterval: (id: number): void => { intervals.delete(id) },
  }
  globals.document = document
  globals.window = fakeWindow
  globals.getComputedStyle = (node: FakeNode): { display: string; visibility: string } =>
    ({ display: node.display, visibility: node.visibility })
  Date.now = (): number => now
  try {
    run({
      document,
      at: (millis: number): void => {
        now = BASE_TIME + millis
        for (const handler of [...intervals.values()]) handler()
      },
      notice: (): FakeNode | null =>
        document.body.children.find(child => child.className === STALL_NOTICE_CLASS) ?? null,
      reloads: (): number => reloadCount,
      intervals: (): number => intervals.size,
      visibility: (state: 'visible' | 'hidden'): void => document.setVisibility(state),
    })
  } finally {
    globals.document = previous.document
    globals.window = previous.window
    globals.getComputedStyle = previous.getComputedStyle
    Date.now = previous.now
  }
}

test('the installer shows nothing before the threshold, then a role=status notice with ONE reload action', () => {
  withFakeBrowser(harness => {
    const tree = conversation()
    harness.document.body.appendChild(tree.root)
    if (tree.header !== null) tree.header.rect = { bottom: 120 }
    const dispose = installSessionStallNotice(key => zh[key])
    assert.equal(harness.intervals(), 1, 'one low-frequency poll, nothing else')
    assert.equal(harness.notice(), null, 'the install-time seed starts the clock, it does not show')

    harness.at(STALL_THRESHOLD_MS - 1)
    assert.equal(harness.notice(), null, 'one millisecond short is not a stall')

    harness.at(STALL_THRESHOLD_MS)
    const notice = harness.notice()
    assert.ok(notice !== null, 'the stall notice appears exactly at the threshold')
    assert.equal(notice.getAttribute('role'), 'status')
    assert.equal(notice.getAttribute('aria-live'), 'polite')
    assert.equal(notice.getAttribute('hidden'), null, 'the notice is visible')
    assert.equal(notice.style.top, `${120 + STALL_NOTICE_GAP_PX}px`, 'anchored under the session header')
    const [message, action] = notice.children
    assert.equal(message?.textContent, zh['dsh-chamber.mobile.stall.message'])
    assert.equal(action?.tag, 'button')
    assert.equal(action?.type, 'button')
    assert.equal(action?.textContent, zh['dsh-chamber.mobile.stall.action'])
    assert.equal(harness.reloads(), 0, 'the watcher itself NEVER reloads')

    action?.click()
    assert.equal(harness.reloads(), 1, 'the one action reloads the page')

    // A row arrives: the notice goes away and the clock resets.
    if (tree.flow !== null) attach(tree.flow, new FakeNode('div')).setAttribute('data-chat-anchor-key', 'k')
    harness.at(STALL_THRESHOLD_MS + STALL_POLL_MS)
    assert.equal(harness.notice(), null, 'a rendered row disproves the stall')

    dispose()
    assert.equal(harness.intervals(), 0, 'dispose clears the poll')
    assert.equal(harness.document.querySelector(`style[data-plugin="${STALL_STYLE_TAG}"]`), null,
      'dispose removes the style tag it created')
  })
})

test('a background round trip keeps an announced notice (and the clock is discarded while hidden)', () => {
  withFakeBrowser(harness => {
    const tree = conversation()
    harness.document.body.appendChild(tree.root)
    const dispose = installSessionStallNotice(key => zh[key])
    harness.at(STALL_THRESHOLD_MS)
    assert.ok(harness.notice() !== null)

    harness.visibility('hidden')
    harness.at(STALL_THRESHOLD_MS + STALL_POLL_MS)
    assert.ok(harness.notice() !== null, 'hiding the page does not take the notice away')

    harness.visibility('visible')
    harness.at(STALL_THRESHOLD_MS + 2 * STALL_POLL_MS)
    assert.ok(harness.notice() !== null, 'resuming must not restart the wait for a stall already announced')
    dispose()
  })
})

test('a stall that starts while hidden waits for the full visible threshold', () => {
  withFakeBrowser(harness => {
    const tree = conversation()
    harness.document.body.appendChild(tree.root)
    const dispose = installSessionStallNotice(key => zh[key])
    harness.visibility('hidden')
    harness.at(600_000)
    assert.equal(harness.notice(), null, 'background time is not stall time')
    harness.visibility('visible')
    assert.equal(harness.notice(), null, 'coming back starts a fresh visible window')
    harness.at(600_000 + STALL_THRESHOLD_MS - 1)
    assert.equal(harness.notice(), null)
    harness.at(600_000 + STALL_THRESHOLD_MS)
    assert.ok(harness.notice() !== null)
    dispose()
  })
})

test('switching sessions resets the clock and the notice (a new conversation root is a new stall)', () => {
  withFakeBrowser(harness => {
    const first = conversation()
    harness.document.body.appendChild(first.root)
    const dispose = installSessionStallNotice(key => zh[key])
    harness.at(STALL_THRESHOLD_MS)
    assert.ok(harness.notice() !== null)
    first.root.remove()
    const second = conversation()
    harness.document.body.appendChild(second.root)
    harness.at(STALL_THRESHOLD_MS + STALL_POLL_MS)
    assert.equal(harness.notice(), null, 'the new session gets its own window')
    harness.at(STALL_THRESHOLD_MS + STALL_POLL_MS + STALL_THRESHOLD_MS)
    assert.ok(harness.notice() !== null, 'and its own notice once IT is stalled')
    dispose()
  })
})

test('the installer is single-install per page and its disposer is idempotent', () => {
  withFakeBrowser(harness => {
    const tree = conversation()
    harness.document.body.appendChild(tree.root)
    const first = installSessionStallNotice(key => zh[key])
    const second = installSessionStallNotice(key => zh[key])
    assert.equal(harness.intervals(), 1, 'a second install must not add a second watcher')
    second()
    assert.equal(harness.intervals(), 1, 'the no-op disposer must not tear the live watcher down')
    harness.at(STALL_THRESHOLD_MS)
    assert.ok(harness.notice() !== null, 'the first install is still watching')
    first()
    assert.equal(harness.intervals(), 0)
    assert.equal(harness.notice(), null)
    // The guard is cleared with the live disposer: a later tier flip installs
    // a fresh watcher.
    const third = installSessionStallNotice(key => zh[key])
    assert.equal(harness.intervals(), 1)
    third()
  })
})

test('the notice copy follows the locale binding on the next poll', () => {
  withFakeBrowser(harness => {
    const tree = conversation()
    harness.document.body.appendChild(tree.root)
    let language: 'zh' | 'en' = 'zh'
    const dispose = installSessionStallNotice(key => (language === 'zh' ? zh : en)[key])
    harness.at(STALL_THRESHOLD_MS)
    const notice = harness.notice()
    assert.equal(notice?.children[0]?.textContent, zh['dsh-chamber.mobile.stall.message'])
    language = 'en'
    harness.at(STALL_THRESHOLD_MS + STALL_POLL_MS)
    assert.equal(harness.notice()?.children[0]?.textContent, en['dsh-chamber.mobile.stall.message'])
    assert.equal(harness.notice()?.children[1]?.textContent, en['dsh-chamber.mobile.stall.action'])
    dispose()
  })
})
