/**
 * Session-load stall notice tests. The package has no DOM environment, so the
 * probe is driven by the shared plain-node DOM double
 * (`test/support/dom-double.ts`, attribute-anchor grammar only) and the
 * decisions are pure functions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MobileKey } from '../../src/client/locales.ts'
import { en, zh } from '../../src/client/locales.ts'
import {
  CHAT_FLOW_QUERY, CHAT_ROW_QUERY, CONVERSATION_PHASE_QUERY,
  SESSION_HEADER_QUERY, STALL_NOTICE_ACTION_CLASS, STALL_NOTICE_CLASS,
  STALL_NOTICE_CSS, STALL_NOTICE_DISMISS_CLASS, STALL_NOTICE_GAP_PX, STALL_NOTICE_MESSAGE_CLASS,
  STALL_NOTICE_MIN_VISIBLE_PX, STALL_STYLE_TAG,
  STALL_PHASES,
  decideStallNotice, installSessionStallNotice, isRendered, isStallPhase, isStallShape,
  markStallResync, noticeTopFor, probeStall, sessionStallFace, stallMessageKey, stallResyncAvailable,
} from '../../src/client/session-stall.ts'
import type { RenderedNodeFace, StallNodeFace } from '../../src/client/session-stall.ts'
//  the six ladder thresholds now belong to the shared table, so the test reads them
// from there. Keeping the same local names means every behavioural assertion below is
// unchanged - only the values' owner moved.
import { LADDER_TABLES } from '@dsh-chamber/dsh-stream-state'

// Named `mobileTable` because this file has a local `mobile(...)` helper further down.
const mobileTable = LADDER_TABLES.mobile
import {
  createSessionStreamHealthState, planSessionStreamHealth, SESSION_STREAM_HEALTH_DEFAULTS,
} from '../../../dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts'
import { FakeNode, attach } from '../support/dom-double.ts'

const SOURCE_URL = new URL('../../src/client/session-stall.ts', import.meta.url)

/**
 * The legacy decision projection (clock + notice) used by the assertions below.
 * The automatic arm's `resync`/`resyncStamps` fields are asserted by
 * their own tests below, so these keep pinning exactly what they always pinned.
 */
function decide(input: Parameters<typeof decideStallNotice>[0]): { since: number; show: boolean } {
  const { since, show } = decideStallNotice(input)
  return { since, show }
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
 * The empirical conversation shape, straight from markup.ts's DOM map:
 * `[data-slot="main"] > div.root[data-phase] >
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
  assert.equal(mobileTable.thresholdMs, 45_000)
  assert.ok(mobileTable.pollMs >= 2_000 && mobileTable.pollMs <= 5_000,
    `poll cadence ${mobileTable.pollMs}ms must stay in the documented 2-5s band`)
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
  // The DOM value space is settling|hero|active (upstream ConversationRoot's
  // `phase`); `engaging`/`blank` are internal contract names that never reach
  // the attribute.
  assert.deepEqual([...STALL_PHASES], ['settling', 'active'])
  assert.equal(isStallPhase('settling'), true)
  assert.equal(isStallPhase('hero'), false)
  assert.equal(isStallPhase('engaging'), false, 'engaging never reaches data-phase')
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
  assert.equal(STALL_NOTICE_DISMISS_CLASS, 'dsh-mobile-stall-dismiss')
  assert.equal(STALL_STYLE_TAG, 'dsh-chamber-mobile-stall')
  for (const name of [STALL_NOTICE_CLASS, STALL_NOTICE_MESSAGE_CLASS, STALL_NOTICE_ACTION_CLASS, STALL_NOTICE_DISMISS_CLASS]) {
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
  const controls = STALL_NOTICE_CSS.slice(STALL_NOTICE_CSS.indexOf(`.${STALL_NOTICE_ACTION_CLASS}`))
  assert.match(controls, /pointer-events:\s*auto/)
  // Both controls are tap targets: the reload action AND the dismiss half.
  assert.match(STALL_NOTICE_CSS.slice(STALL_NOTICE_CSS.indexOf(`.${STALL_NOTICE_DISMISS_CLASS}`)),
    /pointer-events:\s*auto/)
  for (const control of [STALL_NOTICE_ACTION_CLASS, STALL_NOTICE_DISMISS_CLASS]) {
    const block = STALL_NOTICE_CSS.slice(STALL_NOTICE_CSS.indexOf(`.${control} {`))
    assert.match(block.slice(0, block.indexOf('}')), /min-height:\s*44px/,
      `${control} must carry the package's 44px touch floor`)
  }
})

test('the notice copy exists in both dictionaries and adds no other key', () => {
  const keys = Object.keys(zh)
  assert.deepEqual(keys.filter(key => key.startsWith('dsh-chamber.mobile.stall.')), [
    'dsh-chamber.mobile.stall.message',
    'dsh-chamber.mobile.stall.messageFailed',
    'dsh-chamber.mobile.stall.action',
    'dsh-chamber.mobile.stall.dismiss',
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
  assert.equal(probe.activeRoot, tree.phase, 'the active conversation root is the phase node')
  assert.equal(probe.header, tree.header, 'the displayed header is the position anchor')
  assert.equal(isStallShape(probe), true)
})

test('stall truth table: hero / unknown / no phase, rows, hidden header, missing flow are NOT stalled', () => {
  assert.equal(shapeOf(conversation({ phase: 'settling' })), true,
    'settling is a real-session face (value-space assertion; which of its upstream arms can reach here is the header gate\'s business, not this predicate\'s)')
  assert.equal(shapeOf(conversation({ phase: 'engaging' })), false,
    'engaging is an internal contract name and never reaches the attribute')
  assert.equal(shapeOf(conversation({ phase: 'blank' })), false, 'the no-conversation face is never a stall')
  assert.equal(shapeOf(conversation({ phase: 'hero' })), false,
    'hero (no session presented) is never a stall')
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
  const first = decide({ shape: true, pageVisible: true, since: 0, now: 1_000, dismissed: false })
  assert.deepEqual(first, { since: 1_000, show: false }, 'the clock starts, the notice does not')
  assert.deepEqual(
    decide({ shape: true, pageVisible: true, since: first.since, now: 1_000 + mobileTable.thresholdMs - 1, dismissed: false }),
    { since: 1_000, show: false }, 'one millisecond short is not a stall')
  assert.deepEqual(
    decide({ shape: true, pageVisible: true, since: first.since, now: 1_000 + mobileTable.thresholdMs, dismissed: false }),
    { since: 1_000, show: true }, 'the threshold is inclusive')
})

test('the stall must be CONTINUOUS: any break zeroes the clock and restarts the window', () => {
  assert.deepEqual(decide({ shape: false, pageVisible: true, since: 40_000, now: 46_000, dismissed: false }),
    { since: 0, show: false }, 'a row arrived (or the shape broke) — the clock resets')
  assert.deepEqual(decide({ shape: true, pageVisible: true, since: 0, now: 47_000, dismissed: false }),
    { since: 47_000, show: false }, 'a re-formed stall starts a fresh window')
  // A long-lived shape with a broken middle: 30s + 30s around a reset is never 60s.
  const broken = decide({ shape: true, pageVisible: true, since: 0, now: 10_000, dismissed: false })
  const reset = decide({ shape: false, pageVisible: true, since: broken.since, now: 40_000, dismissed: false })
  const again = decide({ shape: true, pageVisible: true, since: reset.since, now: 40_000, dismissed: false })
  assert.deepEqual(decide({ shape: true, pageVisible: true, since: again.since, now: 40_000 + mobileTable.thresholdMs - 1, dismissed: false }),
    { since: 40_000, show: false })
})

test('a hidden page never counts and discards the accumulated visible time', () => {
  assert.deepEqual(decide({ shape: true, pageVisible: false, since: 40_000, now: 900_000, dismissed: false }),
    { since: 0, show: false }, 'background time is not stall time')
  assert.deepEqual(decide({ shape: true, pageVisible: true, since: 0, now: 900_000, dismissed: false }),
    { since: 900_000, show: false }, 'coming back starts a fresh visible window')
  assert.deepEqual(
    decide({ shape: true, pageVisible: true, since: 900_000, now: 900_000 + mobileTable.thresholdMs, dismissed: false }),
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

    harness.at(mobileTable.thresholdMs - 1)
    assert.equal(harness.notice(), null, 'one millisecond short is not a stall')

    harness.at(mobileTable.thresholdMs)
    const notice = harness.notice()
    assert.ok(notice !== null, 'the stall notice appears exactly at the threshold')
    assert.equal(notice.getAttribute('role'), 'status')
    assert.equal(notice.getAttribute('aria-live'), 'polite')
    assert.equal(notice.getAttribute('hidden'), null, 'the notice is visible')
    assert.equal(notice.style.top, `${120 + STALL_NOTICE_GAP_PX}px`, 'anchored under the session header')
    const [message, dismiss, action] = notice.children
    assert.equal(message?.textContent, zh['dsh-chamber.mobile.stall.message'])
    assert.equal(dismiss?.tag, 'button')
    assert.equal(dismiss?.className, STALL_NOTICE_DISMISS_CLASS)
    assert.equal(dismiss?.textContent, zh['dsh-chamber.mobile.stall.dismiss'])
    assert.equal(action?.tag, 'button')
    assert.equal(action?.type, 'button')
    assert.equal(action?.textContent, zh['dsh-chamber.mobile.stall.action'])
    assert.equal(harness.reloads(), 0, 'the watcher itself NEVER reloads')

    action?.click()
    assert.equal(harness.reloads(), 1, 'the one action reloads the page')

    // A row arrives: the notice goes away and the clock resets.
    if (tree.flow !== null) attach(tree.flow, new FakeNode('div')).setAttribute('data-chat-anchor-key', 'k')
    harness.at(mobileTable.thresholdMs + mobileTable.pollMs)
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
    harness.at(mobileTable.thresholdMs)
    assert.ok(harness.notice() !== null)

    harness.visibility('hidden')
    harness.at(mobileTable.thresholdMs + mobileTable.pollMs)
    assert.ok(harness.notice() !== null, 'hiding the page does not take the notice away')

    harness.visibility('visible')
    harness.at(mobileTable.thresholdMs + 2 * mobileTable.pollMs)
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
    harness.at(600_000 + mobileTable.thresholdMs - 1)
    assert.equal(harness.notice(), null)
    harness.at(600_000 + mobileTable.thresholdMs)
    assert.ok(harness.notice() !== null)
    dispose()
  })
})

test('switching sessions resets the clock and the notice (a new conversation root is a new stall)', () => {
  withFakeBrowser(harness => {
    const first = conversation()
    harness.document.body.appendChild(first.root)
    const dispose = installSessionStallNotice(key => zh[key])
    harness.at(mobileTable.thresholdMs)
    assert.ok(harness.notice() !== null)
    first.root.remove()
    const second = conversation()
    harness.document.body.appendChild(second.root)
    harness.at(mobileTable.thresholdMs + mobileTable.pollMs)
    assert.equal(harness.notice(), null, 'the new session gets its own window')
    harness.at(mobileTable.thresholdMs + mobileTable.pollMs + mobileTable.thresholdMs)
    assert.ok(harness.notice() !== null, 'and its own notice once IT is stalled')
    dispose()
  })
})

test('a session switch that keeps the phase node still resets (the header node is the session identity)', () => {
  withFakeBrowser(harness => {
    // The production transition: ui-layout's `main` slot is keyed by ENTRY
    // identity, so `div.root[data-phase]` is re-rendered in place for the next
    // session; only the session-scoped header subtree is replaced. A watcher
    // keyed on the phase node alone would carry session A's 45s into session B.
    const tree = conversation()
    harness.document.body.appendChild(tree.root)
    const dispose = installSessionStallNotice(key => zh[key])
    harness.at(mobileTable.thresholdMs)
    assert.ok(harness.notice() !== null)

    // Session B: same phase node, a NEW header element under the same outlet.
    const slot = tree.slot
    assert.ok(slot !== null)
    const oldHeader = tree.header
    assert.ok(oldHeader !== null)
    oldHeader.remove()
    const replacement = attach(slot, new FakeNode('header'))
    replacement.rect = { bottom: 120 }
    harness.at(mobileTable.thresholdMs + mobileTable.pollMs)
    assert.equal(harness.notice(), null, 'the switched-to session gets its own window')
    harness.at(mobileTable.thresholdMs + mobileTable.pollMs + mobileTable.thresholdMs)
    assert.ok(harness.notice() !== null, 'and its own notice once IT is stalled')
    dispose()
  })
})

test('the dismissal keeps waiting: it hides the notice for THIS stall and re-arms for the next', () => {
  withFakeBrowser(harness => {
    const tree = conversation()
    harness.document.body.appendChild(tree.root)
    const dispose = installSessionStallNotice(key => zh[key])
    harness.at(mobileTable.thresholdMs)
    const notice = harness.notice()
    assert.ok(notice !== null)
    assert.equal(harness.reloads(), 0)

    // The user answers a false positive ("keep waiting") instead of aborting a
    // load that is still progressing.
    const dismiss = notice.children[1]
    assert.equal(dismiss?.className, STALL_NOTICE_DISMISS_CLASS)
    dismiss?.click()
    assert.equal(harness.notice(), null, 'the notice goes away')
    assert.equal(harness.reloads(), 0, 'dismissing never reloads')

    // The same continuous stall must NOT bring it back on the next polls.
    harness.at(mobileTable.thresholdMs + mobileTable.pollMs)
    harness.at(mobileTable.thresholdMs + 90 * mobileTable.pollMs)
    assert.equal(harness.notice(), null, 'a dismissed stall stays dismissed while it lasts')

    // A background round trip ends the episode too (the clock restarts on
    // resume), so the dismissal must not outlive it — otherwise a resumed app
    // onto a still-stalled session would never be told again.
    harness.visibility('hidden')
    harness.at(mobileTable.thresholdMs + 91 * mobileTable.pollMs)
    harness.visibility('visible')
    const resumedBase = mobileTable.thresholdMs + 92 * mobileTable.pollMs
    harness.at(resumedBase)
    assert.equal(harness.notice(), null, 'the resumed episode still waits its full threshold')
    harness.at(resumedBase + mobileTable.thresholdMs)
    assert.ok(harness.notice() !== null, 'a resumed stall is announced again after a dismissal')

    // Progress (a row) ends the stall episode; the next one re-arms.
    const episodeBreak = resumedBase + mobileTable.thresholdMs + mobileTable.pollMs
    if (tree.flow !== null) attach(tree.flow, new FakeNode('div')).setAttribute('data-chat-anchor-key', 'k')
    harness.at(episodeBreak)
    if (tree.flow !== null) tree.flow.children.pop()
    const rearmBase = episodeBreak + mobileTable.pollMs
    harness.at(rearmBase)
    harness.at(rearmBase + mobileTable.thresholdMs - 1)
    assert.equal(harness.notice(), null, 'the fresh window still waits its full threshold')
    harness.at(rearmBase + mobileTable.thresholdMs)
    assert.ok(harness.notice() !== null, 'a new stall is announced again after a dismissal')
    dispose()
  })
})

test('installations share one watcher and the LAST disposer tears it down', () => {
  withFakeBrowser(harness => {
    const tree = conversation()
    harness.document.body.appendChild(tree.root)
    const first = installSessionStallNotice(key => zh[key])
    const second = installSessionStallNotice(key => zh[key])
    assert.equal(harness.intervals(), 1, 'a second install must not add a second watcher')
    // Dispose the FIRST holder first: each install after the first must share
    // the live disposer, so releasing the first must not stop watching for a
    // context that is still alive. Disposing the second first would pass even
    // when that sharing is broken.
    first()
    assert.equal(harness.intervals(), 1, 'releasing the first reference keeps the watcher alive')
    harness.at(mobileTable.thresholdMs)
    assert.ok(harness.notice() !== null, 'the surviving holder is still watching')
    harness.at(mobileTable.thresholdMs + mobileTable.pollMs)
    assert.ok(harness.notice() !== null)
    // Idempotent: a double release must not consume the other holder's count.
    first()
    assert.equal(harness.intervals(), 1)
    second()
    assert.equal(harness.intervals(), 0, 'the last reference stops the watcher')
    assert.equal(harness.notice(), null)
    // The guard is cleared with the last release: a later tier flip installs
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
    harness.at(mobileTable.thresholdMs)
    const notice = harness.notice()
    assert.equal(notice?.children[0]?.textContent, zh['dsh-chamber.mobile.stall.message'])
    language = 'en'
    harness.at(mobileTable.thresholdMs + mobileTable.pollMs)
    assert.equal(harness.notice()?.children[0]?.textContent, en['dsh-chamber.mobile.stall.message'])
    assert.equal(harness.notice()?.children[1]?.textContent, en['dsh-chamber.mobile.stall.dismiss'])
    assert.equal(harness.notice()?.children[2]?.textContent, en['dsh-chamber.mobile.stall.action'])
    dispose()
  })
})
test('the automatic arm fires only on PROVEN loading-with-no-open, and the ledger bounds it', () => {
  const base = { shape: true, pageVisible: true, since: 0, now: BASE_TIME, dismissed: false }
  const parked = { ...base, loading: true, openInFlight: false }
  const first = decideStallNotice(parked)
  assert.equal(first.resync, false, 'the hold must age first, exactly like the notice')
  const stalledAt = BASE_TIME + mobileTable.thresholdMs
  const stalled = decideStallNotice({ ...parked, since: first.since, now: stalledAt })
  assert.equal(stalled.resync, true)
  assert.equal(stalled.show, true, 'the notice still rides along')
  // An open IN FLIGHT is a slow Host being waited on: never interrupted.
  assert.equal(decideStallNotice({ ...parked, since: first.since, now: stalledAt, openInFlight: true }).resync, false)
  // Unknown evidence fails closed on BOTH axes: a missing liveness bit and a missing
  // open state. A healthy `open` session with a slow first turn shares the stall
  // SHAPE (empty transcript), so `openPromise === null` alone would rebuild it.
  assert.equal(decideStallNotice({ ...base, loading: true, since: first.since, now: stalledAt }).resync, false)
  assert.equal(decideStallNotice({ ...base, openInFlight: false, since: first.since, now: stalledAt }).resync, false)
  assert.equal(decideStallNotice({ ...parked, loading: false, since: first.since, now: stalledAt }).resync, false, 'a healthy open session is never rebuilt')
  let stamps = markStallResync(stalled.resyncStamps, stalledAt)
  assert.equal(stallResyncAvailable(stamps, stalledAt + mobileTable.resyncCooldownMs - 1), false)
  assert.equal(stallResyncAvailable(stamps, stalledAt + mobileTable.resyncCooldownMs), true)
  for (let index = 1; index < 3; index++) {
    stamps = markStallResync(stamps, stalledAt + index * mobileTable.resyncCooldownMs)
  }
  assert.equal(stamps.length, 3)
  assert.equal(stallResyncAvailable(stamps, stalledAt + 3 * mobileTable.resyncCooldownMs), false, 'the rolling budget caps it inside the window')
  const last = stamps.at(-1) as number
  assert.equal(stallResyncAvailable(stamps, last + mobileTable.resyncWindowMs), true, 'the window releases the budget')
  // A backwards clock step (NTP correction, VM restore) settles the ledger instead
  // of parking the automatic arm until the wall clock catches up.
  assert.equal(stallResyncAvailable(stamps, last - 3_600_000), true)
  const pruned = decideStallNotice({ ...base, now: last + mobileTable.resyncWindowMs, resyncStamps: stamps, openInFlight: true })
  assert.equal(pruned.resyncStamps.length, 0)
})

test('the notice copy switches to the failure wording after the failure bound', () => {
  assert.equal(stallMessageKey(0), 'dsh-chamber.mobile.stall.message')
  assert.equal(stallMessageKey(mobileTable.failedMs - 1), 'dsh-chamber.mobile.stall.message')
  assert.equal(stallMessageKey(mobileTable.failedMs), 'dsh-chamber.mobile.stall.messageFailed')
  assert.equal(typeof zh[stallMessageKey(mobileTable.failedMs)], 'string')
  assert.equal(typeof en[stallMessageKey(mobileTable.failedMs)], 'string')
})

test('sessionStallFace is fail-closed on every drifted shape and resolves late services', () => {
  const pending = Promise.resolve()
  const faceOf = (session: Record<string, unknown> | undefined) => sessionStallFace({
    reflect: {
      get: (name: string) => (name === 'sessions'
        ? { list: { getSnapshot: () => ({ current: 'a' }) }, resolve: () => (session === undefined ? undefined : { session }) }
        : undefined),
    },
  })
  assert.equal(faceOf({ resync: () => {}, openPromise: pending, openState: 'loading' })?.openInFlight(), true)
  assert.equal(faceOf({ resync: () => {}, openPromise: null, openState: 'loading' })?.openInFlight(), false)
  assert.equal(faceOf({ resync: () => {}, openPromise: undefined, openState: 'loading' })?.openInFlight(), undefined, 'an empty slot is unknown, never parked')
  assert.equal(faceOf({ resync: () => {} })?.openInFlight(), undefined, 'a missing member is unknown, never parked')
  assert.equal(faceOf({ resync: () => {}, openPromise: null, openState: 'loading' })?.loading(), true)
  assert.equal(faceOf({ resync: () => {}, openPromise: null, openState: 'open' })?.loading(), false)
  assert.equal(faceOf({ resync: () => {}, openPromise: null })?.loading(), undefined, 'a missing openState is unknown')
  assert.equal(sessionStallFace(undefined), undefined)
  assert.equal(sessionStallFace({}), undefined)
  assert.equal(sessionStallFace({ reflect: {} }), undefined, 'a ctx without reflect.get gets no arm')
  // The service is resolved PER CALL: an install that happens
  // before the session controller registers must not disable the arm forever.
  let service: unknown
  const late = sessionStallFace({ reflect: { get: () => service } })
  assert.ok(late !== undefined, 'the arm is built from the ctx, not from the service being ready')
  assert.equal(late?.loading(), undefined)
  assert.equal(late?.openInFlight(), undefined)
  service = { list: { getSnapshot: () => ({ current: 'a' }) }, resolve: () => ({ session: { resync: () => {}, openPromise: null, openState: 'loading' } }) }
  assert.equal(late?.loading(), true, 'a service registered later is picked up')
  assert.equal(late?.openInFlight(), false)
  // A hostile service must neither throw at build time nor at call time.
  const hostile = new Proxy({}, { get: () => { throw new Error('hostile') } })
  assert.doesNotThrow(() => {
    const face = sessionStallFace({ reflect: { get: () => hostile } })
    assert.equal(face?.loading(), undefined)
    assert.equal(face?.openInFlight(), undefined)
  })
  const hostileSession = new Proxy({}, { get: () => { throw new Error('hostile openPromise') } }) as Record<string, unknown>
  const hostileFace = faceOf(hostileSession)
  assert.doesNotThrow(() => {
    assert.equal(hostileFace?.openInFlight(), undefined)
    hostileFace?.resync()
  })
})

test('the shipped automatic-arm limits are the documented ones', () => {
  assert.equal(mobileTable.resyncCooldownMs, 120_000)
  assert.equal(mobileTable.resyncWindowMs, 600_000)
  assert.equal(mobileTable.resyncMax, 3)
  // Aligned with the desktop ladder's loadingFailedMs (design 14 §D4); the
  // cross-tier lockstep assertions live below in this file (CROSS-TIER RECOVERY LOCKSTEP).
  assert.equal(mobileTable.failedMs, 90_000)
})

test('a parked open is rebuilt automatically once, and the copy turns into the failure wording', () => {
  withFakeBrowser(harness => {
    const tree = conversation()
    harness.document.body.appendChild(tree.root)
    if (tree.header !== null) tree.header.rect = { bottom: 120 }
    let resyncs = 0
    const dispose = installSessionStallNotice(key => zh[key], {
      openInFlight: () => false,
      loading: () => true,
      resync: () => { resyncs += 1 },
    })
    harness.at(mobileTable.thresholdMs - 1)
    assert.equal(resyncs, 0, 'nothing before the threshold')
    harness.at(mobileTable.thresholdMs)
    assert.equal(resyncs, 1, 'the parked open is rebuilt exactly once at the threshold')
    assert.equal(harness.notice()?.children[0]?.textContent, zh['dsh-chamber.mobile.stall.message'])
    // Still stalled inside the cooldown: the ledger holds the automatic arm back.
    harness.at(mobileTable.thresholdMs + mobileTable.resyncCooldownMs - 1)
    assert.equal(resyncs, 1)
    harness.at(mobileTable.thresholdMs + mobileTable.resyncCooldownMs)
    assert.equal(resyncs, 2, 'the automatic lever returns after the cooldown')
    // Past the failure bound the copy says the content is not loaded.
    harness.at(mobileTable.thresholdMs + mobileTable.failedMs)
    assert.equal(harness.notice()?.children[0]?.textContent, zh['dsh-chamber.mobile.stall.messageFailed'])
    dispose()
  })
})

/**
 * CROSS-TIER RECOVERY LOCKSTEP.
 * The mobile stall observer and the desktop open-in stream-health ladder
 * implement the SAME recovery contract (design 14 §D4) on two tiers. These
 * assertions import BOTH pure decision modules and pin the shared ledger, the
 * ONE intentional threshold deviation and the evidence rule: the automatic
 * rebuild fires on one tier exactly when it fires on the other, and an
 * unreadable face fails closed on both. Any drift on either side turns red.
 */
const PARITY_NOW = 1_000_000

/** Desktop ladder state parked in the loading hold since `heldMs` ago. */
function desktopLoadingHold(heldMs: number) {
  return { phase: 'loading-hold' as const, since: PARITY_NOW - heldMs, healStamps: [] }
}

test('parity: the shared ledger and the failure bound are equal across tiers', () => {
  assert.equal(mobileTable.resyncCooldownMs, SESSION_STREAM_HEALTH_DEFAULTS.healCooldownMs)
  assert.equal(mobileTable.resyncWindowMs, SESSION_STREAM_HEALTH_DEFAULTS.healBudgetWindowMs)
  assert.equal(mobileTable.resyncMax, SESSION_STREAM_HEALTH_DEFAULTS.healBudgetMax)
  assert.equal(mobileTable.failedMs, SESSION_STREAM_HEALTH_DEFAULTS.loadingFailedMs)
})

test('parity: the notice threshold is the ONE documented deviation (mobile is DOM-only)', () => {
  assert.equal(SESSION_STREAM_HEALTH_DEFAULTS.loadingStallMs, 20_000)
  assert.equal(mobileTable.thresholdMs, 45_000)
  assert.ok(mobileTable.thresholdMs > SESSION_STREAM_HEALTH_DEFAULTS.loadingStallMs,
    'the mobile tier has no openState channel and must stay conservative')
  assert.ok(mobileTable.thresholdMs < mobileTable.failedMs, 'the failure wording must not precede the notice')
})

test('parity: the automatic-rebuild evidence rule agrees on every in-flight value', () => {
  const desktop = (openInFlight: boolean | undefined): boolean => planSessionStreamHealth(
    desktopLoadingHold(SESSION_STREAM_HEALTH_DEFAULTS.loadingStallMs),
    { openState: 'loading', presented: true, neighborAvailable: false, resyncAvailable: true, openInFlight },
    PARITY_NOW,
  ).action === 'auto-resync'
  const mobile = (openInFlight: boolean | undefined): boolean => decideStallNotice({
    shape: true, pageVisible: true, since: PARITY_NOW - mobileTable.thresholdMs, now: PARITY_NOW,
    dismissed: false, loading: true, openInFlight, resyncStamps: [],
  }).resync
  for (const openInFlight of [false, true, undefined]) {
    assert.equal(desktop(openInFlight), mobile(openInFlight),
      'automatic rebuild verdict drifted for openInFlight=' + String(openInFlight))
  }
  assert.equal(desktop(false), true, 'a parked open is rebuilt automatically on both tiers')
  assert.equal(desktop(true), false, 'an in-flight open is never interrupted')
  assert.equal(desktop(undefined), false, 'an unreadable face fails closed')
})

test('parity: the loading evidence is required on both tiers (the shape alone is not enough)', () => {
  assert.equal(decideStallNotice({
    shape: true, pageVisible: true, since: PARITY_NOW - mobileTable.thresholdMs, now: PARITY_NOW,
    dismissed: false, loading: false, openInFlight: false, resyncStamps: [],
  }).resync, false)
  assert.equal(decideStallNotice({
    shape: true, pageVisible: true, since: PARITY_NOW - mobileTable.thresholdMs, now: PARITY_NOW,
    dismissed: false, openInFlight: false, resyncStamps: [],
  }).resync, false, 'an unreadable loading state fails closed')
  const errorArm = planSessionStreamHealth(
    createSessionStreamHealthState(),
    { openState: 'error', presented: true, neighborAvailable: true, resyncAvailable: true, openInFlight: false },
    PARITY_NOW,
  )
  assert.notEqual(errorArm.action, 'auto-resync', 'an error state may arm the manual control but never executes on its own')
})

