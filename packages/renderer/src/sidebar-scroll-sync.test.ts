/**
 * sidebar-scroll-sync two-phase restore tests (2026-10 flicker fix).
 *
 * The module is dependency-free and DOM-only, so the tests run under plain
 * node:test against a minimal fake DOM. The behaviour under test:
 *
 * - PARK: the raw `anchor.scrollTop` is copied onto the incoming container on
 *   EVERY attempt, synchronously and BEFORE the checkVisibility gate. A
 *   settled shell's first attempt runs inside the view-transition apply
 *   callback, so the transition's new-state snapshot already captures the
 *   parked position — the incoming sidebar must never reveal at its own
 *   stale/zero scrollTop ("whole sidebar resets to the top, then jumps").
 *   A cold-booted shell's container mounts while hidden; the rAF-tight retry
 *   parks it within a frame of mounting.
 * - REFINE: the row-anchored computation stays gated on checkVisibility
 *   (rects are not trustworthy while hidden) and corrects sub-row content
 *   deltas once visible.
 * - Generation supersession stops a superseded chain; the deadline forces the
 *   raw-scrollTop fallback; clamping bounds every apply.
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { captureSidebarScrollAnchor, restoreSidebarScroll, type SidebarScrollAnchor } from './sidebar-scroll-sync.ts'

const INSTANCE_VIEW_SELECTOR = '.instance-view'
const SCROLL_CONTAINER_SELECTOR = '[data-chamber-sidebar-scroll]'
const ROW_SELECTOR = '[data-chamber-row]'
const FRAME_MS = 16

interface FakeRow {
  dataset: Record<string, string | undefined>
  getBoundingClientRect(): { top: number; bottom: number }
}

interface FakeContainer {
  rows: FakeRow[]
  scrollTop: number
  contentHeight: number
  clientHeight: number
  visible: boolean
  dataset: Record<string, string>
  querySelectorAll(selector: string): FakeRow[]
  getBoundingClientRect(): { top: number; bottom: number }
  checkVisibility(): boolean
  readonly scrollHeight: number
}

interface FakeView {
  dataset: { instance: string }
  container: FakeContainer | null
  querySelector(selector: string): FakeContainer | null
}

function makeRow(id: string | null, top: number, height = 40, ghost = false): FakeRow {
  return {
    dataset: {
      ...(id === null ? {} : { chamberRow: id }),
      ...(ghost ? { chamberGhost: '' } : {}),
    },
    getBoundingClientRect: () => ({ top, bottom: top + height }),
  }
}

function makeContainer(rows: FakeRow[], visible: boolean): FakeContainer {
  return {
    rows,
    scrollTop: 0,
    contentHeight: 1000,
    clientHeight: 400,
    visible,
    dataset: {},
    querySelectorAll(selector: string): FakeRow[] {
      return selector === ROW_SELECTOR ? this.rows : []
    },
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
    checkVisibility(): boolean {
      return this.visible
    },
    get scrollHeight(): number {
      return this.contentHeight
    },
  }
}

function makeView(instanceId: string, container: FakeContainer | null): FakeView {
  return {
    dataset: { instance: instanceId },
    container,
    querySelector(selector: string): FakeContainer | null {
      return selector === SCROLL_CONTAINER_SELECTOR ? this.container : null
    },
  }
}

/** maxScroll of the fake container (contentHeight - clientHeight). */
const MAX_SCROLL = 600

const views: FakeView[] = []
interface FakeDocument {
  visibilityState: string
  querySelectorAll(selector: string): FakeView[]
}
interface FakeWindow {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

function installFakeDom(t: { after: (fn: () => void) => void }): { fakeDocument: FakeDocument } {
  views.length = 0
  // Deterministic timers: rAF is stubbed as a 16ms timer (one frame), so
  // mock.timers drives the retry chain exactly like the real frame loop.
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => {
    mock.timers.reset()
  })
  const fakeWindow: FakeWindow = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
  const fakeDocument: FakeDocument = {
    visibilityState: 'visible',
    querySelectorAll: (selector) => (selector === INSTANCE_VIEW_SELECTOR ? views : []),
  }
  // The module reads these through the DOM-typed globals; the test accesses
  // them through the local handles below (plain objects, not Document/Window).
  ;(globalThis as unknown as { window: FakeWindow }).window = fakeWindow
  ;(globalThis as unknown as { document: FakeDocument }).document = fakeDocument
  globalThis.requestAnimationFrame = (fn: (time: number) => void): number =>
    setTimeout(() => fn(0), FRAME_MS) as unknown as number
  return { fakeDocument }
}

const anchor = (overrides: Partial<SidebarScrollAnchor> = {}): SidebarScrollAnchor => ({
  id: 'a',
  offset: 30,
  scrollTop: 500,
  ...overrides,
})

test('parks the raw scroll synchronously while hidden, then refines once visible', (t) => {
  installFakeDom(t)
  const container = makeContainer([makeRow('a', 100), makeRow('b', 200)], false)
  views.push(makeView('x', container))

  restoreSidebarScroll('x', anchor(), 60_000)
  // PARK is synchronous — no frame may paint the incoming shell at its own
  // stale scrollTop (0), because the view-transition snapshot captures the
  // state right after this call returns.
  assert.equal(container.scrollTop, 500)

  // While hidden the refine stays gated (rects untrustworthy) but the park
  // holds. The retry is on the TIMER cadence now (the container exists), so
  // rAF frames pass without any attempt.
  mock.timers.tick(FRAME_MS * 3)
  assert.equal(container.scrollTop, 500)

  // Once visible, the refine waits for the timer cadence — it must measure
  // settled content (the switch re-published the projection; rects read
  // earlier would stick one row off). At 64ms the timer (80ms) has not fired.
  container.visible = true
  mock.timers.tick(FRAME_MS)
  assert.equal(container.scrollTop, 500)
  // At 80ms the refine positions the anchored row at the same screen offset:
  // rowRect.top(100) - containerRect.top(0) + scrollTop(500) - 30.
  mock.timers.tick(FRAME_MS)
  assert.equal(container.scrollTop, 570)

  // One-shot success: the chain stops; later frames must not re-apply.
  container.scrollTop = 123
  mock.timers.tick(FRAME_MS * 10)
  assert.equal(container.scrollTop, 123)
})

test('parks within a frame of a late-mounted container (cold-booted shell)', (t) => {
  installFakeDom(t)
  const view = makeView('x', null)
  views.push(view)

  restoreSidebarScroll('x', anchor(), 60_000)
  assert.equal(view.container, null)
  mock.timers.tick(FRAME_MS * 3)
  assert.equal(view.container, null)

  // The shell boots: the sidebar container mounts while still hidden under
  // the skeleton; the rAF-tight retry (container-missing phase) parks it
  // within a frame of mounting.
  const container = makeContainer([makeRow('a', 100), makeRow('b', 200)], false)
  view.container = container
  mock.timers.tick(FRAME_MS)
  assert.equal(container.scrollTop, 500)

  // The container now exists — the chain relaxes to the timer cadence; the
  // refine runs at the next timer tick after the view flips visible.
  container.visible = true
  mock.timers.tick(FRAME_MS * 4)
  assert.equal(container.scrollTop, 500)
  mock.timers.tick(FRAME_MS)
  assert.equal(container.scrollTop, 570)
})

test('parks while the anchored row is not rendered yet, refines when it appears', (t) => {
  installFakeDom(t)
  // The container is visible but its server's rows have not landed in the
  // shared projection yet.
  const container = makeContainer([], true)
  views.push(makeView('x', container))

  restoreSidebarScroll('x', anchor(), 60_000)
  assert.equal(container.scrollTop, 500)
  mock.timers.tick(FRAME_MS * 4)
  // No row to anchor to — the park holds the position instead of freezing
  // the old wrong scroll.
  assert.equal(container.scrollTop, 500)

  container.rows.push(makeRow('a', 100))
  mock.timers.tick(FRAME_MS)
  assert.equal(container.scrollTop, 570)
})

test('a newer restore supersedes an in-flight chain', (t) => {
  installFakeDom(t)
  const container = makeContainer([makeRow('a', 100)], false)
  views.push(makeView('x', container))

  restoreSidebarScroll('x', anchor({ scrollTop: 300 }), 60_000)
  restoreSidebarScroll('x', anchor({ scrollTop: 500 }), 60_000)
  // Only the newer anchor drives the chain (500 < MAX_SCROLL — unclamped).
  assert.equal(container.scrollTop, 500)
  container.visible = true
  mock.timers.tick(FRAME_MS * 5)
  assert.equal(container.scrollTop, 100 - 0 + 500 - 30)
})

test('applies are clamped to the container max scroll', (t) => {
  installFakeDom(t)
  const container = makeContainer([makeRow('a', 100)], true)
  views.push(makeView('x', container))

  restoreSidebarScroll('x', anchor({ scrollTop: MAX_SCROLL + 300 }), 60_000)
  assert.equal(container.scrollTop, MAX_SCROLL)
})

test('a null anchor id copies the raw scroll only (no rows visible outgoing)', (t) => {
  installFakeDom(t)
  const container = makeContainer([makeRow('a', 100)], false)
  views.push(makeView('x', container))

  restoreSidebarScroll('x', anchor({ id: null, offset: 0, scrollTop: 500 }), 60_000)
  assert.equal(container.scrollTop, 500)
  container.visible = true
  mock.timers.tick(FRAME_MS)
  // Refine has nothing to anchor to — the raw scroll stays.
  assert.equal(container.scrollTop, 500)
})

test('hidden documents fall back to the timer cadence (rAF never fires)', (t) => {
  const { fakeDocument } = installFakeDom(t)
  const container = makeContainer([makeRow('a', 100)], false)
  views.push(makeView('x', container))
  let rAFCount = 0
  globalThis.requestAnimationFrame = (fn: (time: number) => void): number => {
    rAFCount += 1
    return setTimeout(() => fn(0), FRAME_MS) as unknown as number
  }
  fakeDocument.visibilityState = 'hidden'

  restoreSidebarScroll('x', anchor(), 60_000)
  // The synchronous park still lands (no visibility gate involved).
  assert.equal(container.scrollTop, 500)
  // <80ms: neither rAF (hidden document) nor the timer fallback has fired.
  mock.timers.tick(FRAME_MS * 4)
  assert.equal(rAFCount, 0)
  assert.equal(container.scrollTop, 500)

  // The timer cadence eventually refines once visible.
  container.visible = true
  mock.timers.tick(FRAME_MS * 4)
  assert.equal(container.scrollTop, 570)
})

test('capture picks the topmost visible row and skips ghosts', (t) => {
  installFakeDom(t)
  // Ghost row (only the arming shell renders it) must never be an anchor.
  const container = makeContainer([
    makeRow('ghost', 100, 40, true),
    makeRow('a', 140),
    makeRow('b', 200),
  ], true)
  container.scrollTop = 120
  views.push(makeView('x', container))

  const captured = captureSidebarScrollAnchor('x')
  assert.deepEqual(captured, { id: 'a', offset: 140, scrollTop: 120 })
})

test('capture falls back to a raw scroll when no row is visible', (t) => {
  installFakeDom(t)
  const container = makeContainer([], true)
  container.scrollTop = 42
  views.push(makeView('x', container))

  const captured = captureSidebarScrollAnchor('x')
  assert.deepEqual(captured, { id: null, offset: 0, scrollTop: 42 })
})
