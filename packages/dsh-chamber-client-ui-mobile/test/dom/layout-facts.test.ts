/**
 * Layout fact source (mobile): the ONLY source is the official frame's
 * `data-sidebar-collapsed` attribute — the chamber layout fork has no
 * cross-plugin layout service, and this plugin never mounts on the desktop
 * renderer. Plain node has no DOM, so the frame/observer/tier surface is faked
 * here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLayoutFactSource, subscribeDrawerOpen } from '../../src/client/layout-facts.ts'
import { FakeNode, attach } from '../support/dom-double.ts'

interface FakeMutation {
  readonly type: string
  readonly addedNodes?: readonly FakeNode[]
  readonly removedNodes?: readonly FakeNode[]
}

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = []
  readonly observed: unknown[] = []
  readonly callback: (records: FakeMutation[]) => void
  disconnected = 0
  constructor(callback: (records: FakeMutation[]) => void) {
    this.callback = callback
    FakeMutationObserver.instances.push(this)
  }
  readonly options: unknown[] = []
  observe(target: unknown, options?: unknown): void { this.observed.push(target); this.options.push(options) }
  disconnect(): void { this.disconnected += 1 }
}

interface FakeTier {
  matches: boolean
  added: number
  removed: number
  listeners: Array<() => void>
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

const GLOBALS = globalThis as unknown as Record<string, unknown>

/** Install the minimal DOM surface layout-facts.ts reads, with test handles. */
function installDom(initialFrame: FakeNode | null) {
  const body = new FakeNode('body')
  let root: FakeNode | null = null
  if (initialFrame !== null) {
    root = new FakeNode('div')
    root.setAttribute('data-slot', 'root')
    attach(root, initialFrame)
  }
  const documentDouble = {
    body,
    querySelector: (selector: string): FakeNode | null =>
      selector === '[data-slot="root"]' ? root : null,
  }
  const tier: FakeTier = {
    matches: true,
    added: 0,
    removed: 0,
    listeners: [],
    addEventListener: (_type, listener) => { tier.added += 1; tier.listeners.push(listener) },
    removeEventListener: (_type, listener) => {
      tier.removed += 1
      const index = tier.listeners.indexOf(listener)
      if (index !== -1) tier.listeners.splice(index, 1)
    },
  }
  const previous = {
    document: GLOBALS.document,
    window: GLOBALS.window,
    MutationObserver: GLOBALS.MutationObserver,
    Element: GLOBALS.Element,
  }
  FakeMutationObserver.instances = []
  GLOBALS.document = documentDouble
  GLOBALS.window = { matchMedia: () => tier }
  GLOBALS.MutationObserver = FakeMutationObserver
  GLOBALS.Element = FakeNode
  return {
    tier,
    mount(frame: FakeNode): void {
      root = new FakeNode('div')
      root.setAttribute('data-slot', 'root')
      attach(root, frame)
    },
    fireTier(): void { for (const listener of [...tier.listeners]) listener() },
    fireBody(added: FakeNode[]): void {
      // creation order: [0] the frame attribute observer, [1] the body observer.
      FakeMutationObserver.instances[1]?.callback([{ type: 'childList', addedNodes: added, removedNodes: [] }])
    },
    fireBodyRemoved(removed: FakeNode[]): void {
      FakeMutationObserver.instances[1]?.callback([{ type: 'childList', addedNodes: [], removedNodes: removed }])
    },
    /** The root slot (and its frame) leave the document. */
    unmount(): void { root = null },
    observers: (): FakeMutationObserver[] => FakeMutationObserver.instances,
    restore(): void {
      GLOBALS.document = previous.document
      GLOBALS.window = previous.window
      GLOBALS.MutationObserver = previous.MutationObserver
      GLOBALS.Element = previous.Element
    },
  }
}

test('layout source: collapsed/narrow come from the official frame attribute and the touch tier', () => {
  const frame = new FakeNode('div')
  const dom = installDom(frame)
  try {
    const notifications: string[] = []
    const source = createLayoutFactSource()
    const unsubscribe = source.subscribe(() => notifications.push(String(source.getCollapsed())))
    assert.deepEqual(notifications, ['false'], 'subscribe fires immediately with the current value')
    assert.equal(source.getCollapsed(), false)
    assert.equal(source.getNarrow(), true, 'the narrow flag is the touch-tier matchMedia result')
    assert.equal(dom.observers()[0]?.observed.length, 1,
      'a frame ALREADY mounted at construction must still be observed (the seeded-frame skip)')
    assert.deepEqual(
      (dom.observers()[0]?.options[0] as { attributeFilter?: readonly string[] } | undefined)?.attributeFilter,
      ['data-sidebar-collapsed', 'data-rightbar-collapsed', 'data-rightbar-fullscreen'],
      'the frame observer must keep listening to the sidebar AND both rightbar flags (panelShown recompute)',
    )

    frame.setAttribute('data-sidebar-collapsed')
    dom.observers()[0]?.callback([{ type: 'attributes', addedNodes: [] }])
    assert.deepEqual(notifications, ['false', 'true'], 'the frame attribute mutation notifies subscribers')
    assert.equal(source.getCollapsed(), true)
    frame.attributes.delete('data-sidebar-collapsed')
    dom.observers()[0]?.callback([{ type: 'attributes', addedNodes: [] }])
    assert.equal(source.getCollapsed(), false, 'expanded is the attribute\'s removal')

    dom.tier.matches = false
    dom.fireTier()
    assert.equal(source.getNarrow(), false, 'the tier change notifies subscribers')
    assert.equal(notifications.length, 4)

    source.dispose()
    assert.equal(dom.observers()[0]?.disconnected, 1, 'dispose disconnects the frame observer')
    assert.equal(dom.observers()[1]?.disconnected, 1, 'dispose disconnects the body observer')
    assert.equal(dom.tier.removed, 1, 'dispose removes the tier listener')
    const settled = notifications.length
    frame.setAttribute('data-sidebar-collapsed')
    dom.fireTier()
    assert.equal(notifications.length, settled, 'a disposed source is inert')
    unsubscribe()
  } finally {
    dom.restore()
  }
})

test('drawer-open subscription follows a REMOUNTED frame (aria freshness)', () => {
  const first = new FakeNode('div')
  const dom = installDom(first)
  try {
    const states: boolean[] = []
    const unsubscribe = subscribeDrawerOpen(open => states.push(open))
    assert.deepEqual(states, [true], 'an expanded frame (no collapsed attribute) reads open')
    first.setAttribute('data-sidebar-collapsed')
    dom.observers()[0]?.callback([{ type: 'attributes', addedNodes: [] }])
    assert.deepEqual(states, [true, false])

    // A frame REMOUNT: the old element is replaced under the root slot. The
    // subscription must read the NEW frame, not freeze on the detached one
    // (the stale aria-expanded bug).
    const second = new FakeNode('div')
    dom.mount(second)
    dom.fireBody([second])
    assert.deepEqual(states, [true, false, true],
      'the remount re-reads the new frame instead of the stale attribute')
    assert.equal(dom.observers()[0]?.observed.length, 2, 'the attribute observer rebound to the new frame')
    second.setAttribute('data-sidebar-collapsed')
    dom.observers()[0]?.callback([{ type: 'attributes', addedNodes: [] }])
    assert.deepEqual(states, [true, false, true, false], 'the NEW frame now drives the state')

    const disconnects = dom.observers()[0]?.disconnected ?? 0
    unsubscribe()
    assert.equal(dom.observers()[0]?.disconnected, disconnects + 1, 'unsubscribe disposes the source')
  } finally {
    dom.restore()
  }
})

test('layout source: no frame is fail-safe collapsed, and a structural mount re-attaches', () => {
  const dom = installDom(null)
  try {
    const source = createLayoutFactSource()
    assert.equal(source.getCollapsed(), true, 'no frame yet reads as collapsed (the safe direction)')
    assert.equal(dom.observers()[0]?.observed.length, 0, 'no frame means no attribute observation')

    const frame = new FakeNode('div')
    dom.mount(frame)
    dom.fireBody([frame])
    assert.equal(source.getCollapsed(), false, 'the mounted frame is observed after the structural mutation')
    assert.equal(dom.observers()[0]?.observed.length, 1, 'the frame observer attached to the new frame')

    frame.setAttribute('data-sidebar-collapsed')
    assert.equal(source.getCollapsed(), true)

    // Streaming content is not structural: an added deep node never re-queries.
    dom.fireBody([new FakeNode('span')])
    assert.equal(dom.observers()[0]?.observed.length, 1, 'a deep content mutation never re-attaches the frame')
    source.dispose()
  } finally {
    dom.restore()
  }
})

test('layout source: a pure frame removal drops to fail-safe collapsed and notifies', () => {
  const frame = new FakeNode('div')
  const dom = installDom(frame)
  try {
    const source = createLayoutFactSource()
    const states: boolean[] = []
    source.subscribe(() => states.push(source.getCollapsed()))
    assert.deepEqual(states, [false])

    // The frame (and its root slot) leave the document. The removed node has
    // no parent chain left, so the removal candidate is the source's own
    // current frame — without this arm the source would stay on the detached
    // element and getCollapsed() would keep reading its stale attributes.
    frame.remove()
    dom.unmount()
    dom.fireBodyRemoved([frame])
    assert.equal(source.getCollapsed(), true,
      'a removed frame reads collapsed (the fail-safe direction)')
    assert.deepEqual(states, [false, true],
      'the removal notifies so consumers do not freeze on the detached frame')
    assert.equal(dom.observers()[0]?.disconnected, 1,
      'the attribute observer detached with the removed frame')

    // A new frame mounting later re-attaches the same source and reads open.
    const next = new FakeNode('div')
    dom.mount(next)
    dom.fireBody([next])
    assert.equal(source.getCollapsed(), false)
    assert.equal(dom.observers()[0]?.observed.at(-1), next, 'the observer rebound to the new frame')
    assert.deepEqual(states, [false, true, false])
    source.dispose()
  } finally {
    dom.restore()
  }
})
