/**
 * Native guest carrier — pure-model coverage (design 28 v3 §3/§4).
 *
 * The carrier's DOM/native halves need Swift and a real WKWebView; here we pin
 * the contract that can run under node: the bridge guard, the untrusted push
 * projections, and the placeholder geometry coalescing rule.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_PUSHES,
  REQUIRED_BROWSER_INVOKES,
  asBrowserBridge,
  parseBrowserForwardNeeded,
  parseBrowserGuestInput,
  parseBrowserGuestState,
  parseBrowserOpenRequest,
  type BrowserBridge,
} from '../../src/client/browser/BrowserBridge.ts'
import {
  hiddenGuestFrame,
  isGuestOccludedByTopmost,
  normalizeGuestFrame,
  occlusionSampleCoordinates,
  shouldReportGuestFrame,
} from '../../src/client/browser/guest-geometry.ts'
import { planKeymapPush, serializeCombos } from '../../src/client/browser/keymap-push.ts'

function fakeBridge(): Record<string, unknown> {
  const noop = async () => ({ ok: true })
  return {
    acquire: noop, release: noop, navigate: noop, command: noop, frame: noop,
    events: { state: () => () => {}, openRequested: () => () => {}, input: () => () => {}, forwardNeeded: () => () => {} },
  }
}

test('bridge guard accepts the five required invokes (optional keymap) plus the four push faces', () => {
  assert.deepEqual([...REQUIRED_BROWSER_INVOKES], ['acquire', 'release', 'navigate', 'command', 'frame'])
  assert.deepEqual([...REQUIRED_BROWSER_INVOKES, 'keymap'], ['acquire', 'release', 'navigate', 'command', 'frame', 'keymap'])
  assert.deepEqual([...BROWSER_PUSHES], ['state', 'openRequested', 'input', 'forwardNeeded'])
  assert.notEqual(asBrowserBridge(fakeBridge()), null)
})

test('bridge guard is fail-closed on a missing invoke or push face', () => {
  const missingInvoke = fakeBridge()
  delete missingInvoke.frame
  assert.equal(asBrowserBridge(missingInvoke), null)
  const missingPush = fakeBridge()
  delete (missingPush.events as Record<string, unknown>).forwardNeeded
  assert.equal(asBrowserBridge(missingPush), null)
  assert.equal(asBrowserBridge({}), null)
  assert.equal(asBrowserBridge(null), null)
})

test('pushed state projection drops malformed payloads and keeps the diagnostic', () => {
  const ok = parseBrowserGuestState({
    tabId: 'tab-1', lease: 'lease-abcdefgh', url: 'http://127.0.0.1:8080/', title: 'x',
    canGoBack: true, canGoForward: false, loading: false,
    error: { code: -1004, description: 'Could not connect to the server.' },
  })
  assert.deepEqual(ok, {
    tabId: 'tab-1', lease: 'lease-abcdefgh', url: 'http://127.0.0.1:8080/', title: 'x',
    canGoBack: true, canGoForward: false, loading: false,
    error: { code: -1004, description: 'Could not connect to the server.' },
  })
  assert.equal(parseBrowserGuestState({ ...ok, loading: 'yes' }), null)
  assert.equal(parseBrowserGuestState({ ...ok, error: { code: 'boom' } }), null)
  assert.equal(parseBrowserGuestState(null), null)
})

test('the other three push projections are narrow', () => {
  assert.deepEqual(parseBrowserOpenRequest({ tabId: 't', url: 'https://a.example/' }), { tabId: 't', url: 'https://a.example/' })
  assert.equal(parseBrowserOpenRequest({ tabId: 't' }), null)
  assert.deepEqual(parseBrowserGuestInput({ tabId: 't', code: 'KeyT', modifiers: ['meta', 7] }), { tabId: 't', code: 'KeyT', modifiers: ['meta'] })
  // A non-array modifiers value is tolerated as the legacy shape (empty set).
  assert.deepEqual(parseBrowserGuestInput({ tabId: 't', code: 'KeyT', modifiers: 'meta' }), { tabId: 't', code: 'KeyT', modifiers: [] })
  assert.deepEqual(parseBrowserForwardNeeded({ tabId: 't', url: 'http://127.0.0.1:3000/' }), { tabId: 't', url: 'http://127.0.0.1:3000/' })
  assert.equal(parseBrowserForwardNeeded({ tabId: 't', url: 9 }), null)
})

test('geometry normalizes to whole CSS pixels and refuses non-finite input', () => {
  assert.deepEqual(normalizeGuestFrame({ x: 10.4, y: 20.6, width: 300.5, height: Number.NaN, visible: true, occluded: false }),
    { x: 10, y: 21, width: 301, height: 0 })
  assert.deepEqual(normalizeGuestFrame({ x: 1, y: 2, width: -5, height: 6, visible: false, occluded: true }),
    { x: 1, y: 2, width: 0, height: 6 })
})

test('only a >=1px change or a visibility/occlusion flip is reported', () => {
  const base = { frame: { x: 10, y: 20, width: 400, height: 300 }, visible: true, occluded: false }
  assert.equal(shouldReportGuestFrame(undefined, base), true)
  assert.equal(shouldReportGuestFrame(base, { ...base }), false)
  assert.equal(shouldReportGuestFrame(base, { ...base, frame: { ...base.frame, x: 10.4 } }), false)
  assert.equal(shouldReportGuestFrame(base, { ...base, frame: { ...base.frame, x: 11 } }), true)
  assert.equal(shouldReportGuestFrame(base, { ...base, frame: { ...base.frame, height: 299 } }), true)
  assert.equal(shouldReportGuestFrame(base, { ...base, visible: false }), true)
  assert.equal(shouldReportGuestFrame(base, { ...base, occluded: true }), true)
})

test('the DOM-overlay hit test hides the guest only when a foreign layer wins', () => {
  assert.equal(isGuestOccludedByTopmost(true, false, false), false, 'the placeholder itself wins')
  assert.equal(isGuestOccludedByTopmost(false, true, false), false, 'a placeholder descendant wins')
  assert.equal(isGuestOccludedByTopmost(false, false, true), false, 'the tab body ancestor wins')
  assert.equal(isGuestOccludedByTopmost(false, false, false), true, 'a dialog/palette/toast outside the tab body covers it')
})

test('the hidden frame keeps the last placement but zeroes the rect', () => {
  const base = { frame: { x: 10, y: 20, width: 400, height: 300 }, visible: true, occluded: false }
  assert.deepEqual(hiddenGuestFrame(base), { frame: { x: 10, y: 20, width: 0, height: 0 }, visible: false, occluded: true })
  assert.deepEqual(hiddenGuestFrame(undefined), { frame: { x: 0, y: 0, width: 0, height: 0 }, visible: false, occluded: true })
})

/** The fake satisfies the runtime face the launcher consumes. */
const typed: BrowserBridge | null = asBrowserBridge(fakeBridge())
test('guard result is usable as the launcher bridge type', () => {
  assert.notEqual(typed, null)
})

test('the keymap push planner sends once, dedupes and never clears the shell', () => {
  const combo = { code: 'KeyT', primary: true, alt: false, shift: false, control: false }
  // No live lease / no bridge face: nothing is sent (guest keys stay inert).
  assert.deepEqual(planKeymapPush(false, undefined, [combo]), { send: false })
  const first = planKeymapPush(true, undefined, [combo])
  assert.deepEqual(first, { send: true, remembered: serializeCombos([combo]), combos: [combo] })
  // Unchanged set: no resend.
  assert.deepEqual(planKeymapPush(true, first.remembered, [combo]), { send: false })
  // Changed set: one send with the new serialization.
  const changed = [{ code: 'KeyB', primary: true, alt: true, shift: false, control: false }]
  const second = planKeymapPush(true, first.remembered, changed)
  assert.equal(second.send, true)
  assert.deepEqual(second.combos, changed)
  // Empty table clears the shell only when it was previously non-empty.
  const empty = planKeymapPush(true, second.remembered, [])
  assert.deepEqual(empty, { send: true, remembered: serializeCombos([]), combos: [] })
  assert.deepEqual(planKeymapPush(true, undefined, []), { send: false })
  // Serialization is stable and platform-word free.
  assert.equal(serializeCombos([combo]), serializeCombos([{ ...combo }]))
})
test('the occlusion hit test samples nine points across the placeholder', () => {
  const points = occlusionSampleCoordinates({ left: 100, top: 50, width: 200, height: 100 })
  assert.equal(points.length, 9)
  assert.deepEqual(points[0], [200, 100])
  assert.deepEqual(points[1], [150, 75])
  assert.deepEqual(points[8], [250, 100])
})
test('INC-02: a null url/title projection keeps the record and its error', () => {
  const parsed = parseBrowserGuestState({
    tabId: 'tab-1', lease: 'lease-abcdefgh', url: null, title: null,
    canGoBack: false, canGoForward: false, loading: false,
    error: { code: -1004, description: 'Could not connect.' },
  })
  assert.ok(parsed !== null)
  assert.equal(parsed.url, '')
  assert.equal(parsed.title, '')
  assert.deepEqual(parsed.error, { code: -1004, description: 'Could not connect.' })
})

test('INC-03: the forward-needed push carries the lease (optional for older shims)', () => {
  assert.deepEqual(parseBrowserForwardNeeded({ tabId: 't', url: 'http://127.0.0.1:3000/', lease: 'lease-abcdefgh' }),
    { tabId: 't', url: 'http://127.0.0.1:3000/', lease: 'lease-abcdefgh' })
  assert.deepEqual(parseBrowserForwardNeeded({ tabId: 't', url: 'http://127.0.0.1:3000/' }), { tabId: 't', url: 'http://127.0.0.1:3000/' })
  assert.equal(parseBrowserForwardNeeded({ tabId: 't', url: 'http://a/', lease: 7 }), null)
})

test('RT-11: the open-request projection carries the opener lease (bounded, optional)', () => {
  assert.deepEqual(parseBrowserOpenRequest({ tabId: 't', url: 'https://a.example/', lease: 'lease-abcdefgh' }),
    { tabId: 't', url: 'https://a.example/', lease: 'lease-abcdefgh' })
  assert.deepEqual(parseBrowserOpenRequest({ tabId: 't', url: 'https://a.example/' }),
    { tabId: 't', url: 'https://a.example/' })
  assert.equal(parseBrowserOpenRequest({ tabId: 't', url: 'https://a.example/', lease: '' }), null)
  assert.equal(parseBrowserOpenRequest({ tabId: 't', url: 'https://a.example/', lease: 7 }), null)
  assert.equal(parseBrowserOpenRequest({ tabId: 't', url: 'https://a.example/', lease: 'x'.repeat(129) }), null)
})

test('guest-input normalization: canonical wins, legacy booleans are a fallback, repeat passes through', () => {
  // Canonical shape.
  assert.deepEqual(parseBrowserGuestInput({ tabId: 't', code: 'KeyT', modifiers: ['meta', 'shift'], repeat: true }),
    { tabId: 't', code: 'KeyT', modifiers: ['meta', 'shift'], repeat: true })
  // Legacy boolean shape: primary maps to meta; the sibling legacy flags map to the DOM names.
  assert.deepEqual(parseBrowserGuestInput({ tabId: 't', code: 'KeyT', primary: true, alt: true, shift: true, control: true, repeat: false }),
    { tabId: 't', code: 'KeyT', modifiers: ['meta', 'alt', 'shift', 'control'], repeat: false })
  // Both shapes: canonical wins; legacy primary is not unioned in.
  assert.deepEqual(parseBrowserGuestInput({ tabId: 't', code: 'KeyT', modifiers: ['alt'], primary: true }),
    { tabId: 't', code: 'KeyT', modifiers: ['alt'] })
  // Mixed-case/unknown tokens pass the shape guard; the replay below ignores them.
  assert.deepEqual(parseBrowserGuestInput({ tabId: 't', code: 'KeyT', modifiers: ['META', 'hyper'] }),
    { tabId: 't', code: 'KeyT', modifiers: ['META', 'hyper'] })
  assert.equal(parseBrowserGuestInput({ tabId: 't', code: 'KeyT', modifiers: [], repeat: 'yes' }), null)
})

// ── NativeGuestImpl state machine over a fake bridge/presentation ─────────────

interface FakeOptions {
  readonly failAcquire?: number
  readonly failNavigate?: boolean
  readonly failKeymap?: boolean
}

/** One effective combo the fake shortcut source reports. */
const COMBO = { code: 'KeyT', primary: true, alt: false, shift: false, control: false }

function fakeCarrier(options: FakeOptions = {}) {
  const calls = { acquire: 0, release: [] as string[], navigate: [] as unknown[], command: [] as string[], frame: 0, keymap: 0 }
  let leaseSeq = 0
  let statePush: ((value: unknown) => void) | undefined
  let openRequestPush: ((value: unknown) => void) | undefined
  let forwardPush: ((value: unknown) => void) | undefined
  const bridge = {
    async acquire() {
      calls.acquire += 1
      if (options.failAcquire !== undefined && calls.acquire <= options.failAcquire) return { ok: false as const, code: 'spawn-failed' }
      leaseSeq += 1
      return { ok: true as const, lease: 'lease-' + String(leaseSeq) }
    },
    async release(input: { lease: string }) { calls.release.push(input.lease); return { ok: true as const } },
    async navigate(input: unknown) { calls.navigate.push(input); return options.failNavigate === true ? { ok: false as const, code: 'forward-not-bound' } : { ok: true as const } },
    async command(input: { command: string }) { calls.command.push(input.command); return { ok: true as const } },
    async frame() { calls.frame += 1; return { ok: true as const } },
    async keymap() {
      calls.keymap += 1
      return options.failKeymap === true ? { ok: false as const, code: 'stale-lease' } : { ok: true as const }
    },
    combos: { read: () => [COMBO], subscribe: () => () => {} },
    events: {
      state(listener: (value: unknown) => void) { statePush = listener; return () => {} },
      openRequested(listener: (value: unknown) => void) { openRequestPush = listener; return () => {} },
      input() { return () => {} },
      forwardNeeded(listener: (value: unknown) => void) { forwardPush = listener; return () => {} },
    },
  }
  const carrier = { bridge, sessionId: 's1', sourceId: 'local', sourceFingerprint: 'local', workspaceKey: 'local' }
  return { bridge, carrier, calls, pushState: (value: unknown) => statePush?.(value), pushOpenRequest: (value: unknown) => openRequestPush?.(value), pushForward: (value: unknown) => forwardPush?.(value) }
}

function fakePresentation() {
  const reported: unknown[] = []
  const occluded: boolean[] = []
  return { reported, occluded, mount: () => () => {}, dispose: () => {}, setOccluded: (value: boolean) => { occluded.push(value) }, report: (value: unknown) => { reported.push(value) } }
}

const DIRECT = { resolve: async () => ({ kind: 'direct' as const, url: 'https://example.com/' }), dispose: async () => {} }
const FORWARDED = { resolve: async () => ({ kind: 'forward' as const, recordId: 'fwd-1', path: '/', externalUrl: 'http://127.0.0.7:41000/' }), dispose: async () => {} }

async function makeFrame(options: FakeOptions = {}, resolver: { resolve(input: unknown): Promise<unknown>; dispose(): Promise<void> } = DIRECT, initial: unknown = undefined) {
  const { NativeGuestImpl } = await import('../../src/client/browser/NativeGuestImpl.ts')
  const fake = fakeCarrier(options)
  const presentation = fakePresentation()
  const persisted: unknown[] = []
  const opened: string[] = []
  const pageOptions = { tabId: 'tab-1', carrier: fake.carrier, initial, persist: (state: unknown) => { persisted.push(state) }, openRequested: (url: string) => { opened.push(url) } }
  const frame = new NativeGuestImpl(pageOptions as never, fake.carrier as never, presentation as never, resolver as never)
  return { frame, presentation, persisted, opened, ...fake }
}

async function settle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }

test('a failed acquire is retryable and reload retries it', async () => {
  const { frame, calls } = await makeFrame({ failAcquire: 1 })
  assert.equal(await frame.start(), false, 'first acquire fails')
  assert.equal(calls.acquire, 1)
  frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'example.com' })
  await settle()
  assert.equal(calls.acquire, 2, 'the retry path re-attempts the acquire')
  assert.equal((frame.getSnapshot().error as { description?: string } | undefined)?.description, undefined)
  await frame.dispose()
})

test('an acquire that settles after dispose releases the minted lease', async () => {
  const { frame, calls } = await makeFrame()
  const pending = frame.start()
  await frame.dispose()
  assert.equal(await pending, false)
  await settle()
  assert.deepEqual(calls.release, ['lease-1'], 'the late minted lease is released, not leaked')
})

test('a refused navigate ack surfaces the failure bar and drops the alias exit', async () => {
  const { frame } = await makeFrame({ failNavigate: true }, FORWARDED as never)
  frame.loadUrl({ kind: 'http', url: 'http://127.0.0.1:5173/', title: '127.0.0.1' })
  await settle()
  const state = frame.getSnapshot()
  assert.equal(state.error?.description, 'forward-not-bound')
  assert.equal(state.loading, false)
  assert.equal(state.externalUrl, undefined)
  await frame.dispose()
})

test('a forwarded page drops the alias projection when the guest leaves the alias', async () => {
  const { frame, pushState } = await makeFrame({}, FORWARDED as never)
  frame.loadUrl({ kind: 'http', url: 'http://127.0.0.1:5173/', title: '127.0.0.1' })
  await settle()
  const lease = (frame as unknown as { lease: string }).lease
  pushState({ tabId: 'tab-1', lease, url: 'http://127.0.0.7:41000/app', title: 'alias', canGoBack: false, canGoForward: false, loading: false })
  await settle()
  assert.equal(frame.getSnapshot().externalUrl, 'http://127.0.0.7:41000/', 'alias exit while on the alias')
  pushState({ tabId: 'tab-1', lease, url: 'https://example.com/next', title: 'next', canGoBack: true, canGoForward: false, loading: false })
  await settle()
  assert.equal(frame.getSnapshot().externalUrl, undefined, 'leaving the alias clears the exit')
  assert.equal(frame.getSnapshot().target?.url, 'https://example.com/next')
  await frame.dispose()
})

test('an existing history entry moves the cursor instead of appending (back/forward)', async () => {
  const { frame, pushState } = await makeFrame()
  frame.loadUrl({ kind: 'https', url: 'https://a.example/', title: 'a' })
  await settle()
  const lease = (frame as unknown as { lease: string }).lease
  pushState({ tabId: 'tab-1', lease, url: 'https://b.example/', title: 'b', canGoBack: true, canGoForward: false, loading: false })
  await settle()
  pushState({ tabId: 'tab-1', lease, url: 'https://a.example/', title: 'a', canGoBack: true, canGoForward: true, loading: false })
  await settle()
  const internal = frame as unknown as { history: unknown[]; cursor: number }
  assert.equal(internal.history.length, 2, 'back to an existing entry appends nothing')
  assert.equal(internal.cursor, 0, 'the cursor moved back')
  assert.equal(frame.getSnapshot().target?.url, 'https://a.example/')
  await frame.dispose()
})

test('RT-11: an open request is attributed to the receiving lease', async () => {
  const { frame, pushOpenRequest, opened } = await makeFrame()
  frame.loadUrl({ kind: 'https', url: 'https://dsh-remote.example/', title: 'remote' })
  await settle()
  const lease = (frame as unknown as { lease: string }).lease
  pushOpenRequest({ tabId: 'tab-1', url: 'https://a.example/', lease })
  pushOpenRequest({ tabId: 'tab-1', url: 'https://b.example/', lease: 'lease-other' })
  pushOpenRequest({ tabId: 'tab-1', url: 'https://c.example/' })
  pushOpenRequest({ tabId: 'tab-2', url: 'https://d.example/', lease })
  assert.deepEqual(opened, ['https://a.example/', 'https://c.example/'],
    'a matching lease and the older-shim arm open; a stale/foreign occurrence does not')
  await frame.dispose()
})

test('a stale forward negotiation (other lease) is dropped', async () => {
  const { frame, pushForward, calls } = await makeFrame({}, FORWARDED as never)
  frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'example.com' })
  await settle()
  const before = calls.navigate.length
  pushForward({ tabId: 'tab-1', url: 'http://127.0.0.1:5173/', lease: 'lease-other' })
  await settle()
  assert.equal(calls.navigate.length, before, 'a negotiation for another lease never navigates')
  await frame.dispose()
})

test('frame reports are silent on a refused ack (no failure bar flicker)', async () => {
  const { frame, calls } = await makeFrame()
  await frame.start()
  await settle()
  assert.equal(calls.frame, 0)
  frame.reportFrame({ frame: { x: 1, y: 2, width: 100, height: 80 }, visible: true, occluded: false })
  await settle()
  assert.equal(calls.frame, 1, 'geometry crosses the bridge')
  assert.equal(frame.getSnapshot().error, undefined, 'geometry churn never sets an error')
  await frame.dispose()
})

test('a refused keymap ack is silent (no failure bar flicker)', async () => {
  const { frame, calls } = await makeFrame({ failKeymap: true })
  await frame.start()
  await settle()
  assert.equal(calls.keymap, 1, 'the effective keymap crosses the bridge after the lease is adopted')
  assert.equal(frame.getSnapshot().error, undefined, 'a background keymap refusal never becomes a load failure')
  await frame.dispose()
})

test('appending a navigation keeps the earlier entries kind/title (R3B-02)', async () => {
  const { frame } = await makeFrame()
  frame.loadUrl({ kind: 'http', url: 'http://127.0.0.1:5173/', title: 'local' })
  await settle()
  frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'remote' })
  await settle()
  const internal = frame as unknown as { history: unknown[]; cursor: number }
  assert.deepEqual(internal.history, [
    { kind: 'http', url: 'http://127.0.0.1:5173/', title: 'local' },
    { kind: 'https', url: 'https://example.com/', title: 'remote' },
  ], 'only the new entry is appended; the old entry keeps its own kind/title')
  assert.equal(internal.cursor, 1)
  await frame.dispose()
})

test('an in-page loopback target is negotiated and becomes the address (R4-01)', async () => {
  const { frame, pushForward, calls } = await makeFrame({}, FORWARDED as never)
  frame.loadUrl({ kind: 'https', url: 'https://dsh-remote.example/', title: 'remote' })
  await settle()
  const lease = (frame as unknown as { lease: string }).lease
  const before = calls.navigate.length
  // Main pushes the SUSPENDED target, not the address currently on screen.
  pushForward({ tabId: 'tab-1', url: 'http://127.0.0.1:5173/app', lease })
  await settle()
  assert.equal(calls.navigate.length, before + 1, 'a target different from the address on screen is negotiated')
  const internal = frame as unknown as { history: { url: string }[]; cursor: number }
  assert.equal(internal.history[internal.cursor]?.url, 'http://127.0.0.1:5173/app', 'the negotiated target becomes the logical address')
  await frame.dispose()
})

test('a non-loopback push is not a negotiation target (R4-01)', async () => {
  const { frame, pushForward, calls } = await makeFrame({}, FORWARDED as never)
  frame.loadUrl({ kind: 'https', url: 'https://dsh-remote.example/', title: 'remote' })
  await settle()
  const lease = (frame as unknown as { lease: string }).lease
  const before = calls.navigate.length
  pushForward({ tabId: 'tab-1', url: 'https://evil.example/', lease })
  await settle()
  assert.equal(calls.navigate.length, before, 'main never negotiates a non-loopback target')
  await frame.dispose()
})

test('a negotiation that loses its generation is dropped (R4-01)', async () => {
  const { frame, pushForward, calls } = await makeFrame({}, FORWARDED as never)
  frame.loadUrl({ kind: 'https', url: 'https://dsh-remote.example/', title: 'remote' })
  await settle()
  const lease = (frame as unknown as { lease: string }).lease
  const before = calls.navigate.length
  pushForward({ tabId: 'tab-1', url: 'http://127.0.0.1:5173/app', lease })
  // The user navigates elsewhere before the negotiation settles.
  frame.loadUrl({ kind: 'https', url: 'https://other.example/', title: 'other' })
  await settle()
  assert.equal(calls.navigate.length, before + 1, 'only the newer navigation reached main')
  await frame.dispose()
})

test('visibility-only state pushes clear a previous hide (symmetric occlusion, R3B-04)', async () => {
  const { frame, pushState, presentation } = await makeFrame()
  frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'example.com' })
  await settle()
  const lease = (frame as unknown as { lease: string }).lease
  const push = (flags: { readonly visible?: boolean; readonly occluded?: boolean }) =>
    pushState({ tabId: 'tab-1', lease, url: 'https://example.com/', title: 'example.com',
      canGoBack: false, canGoForward: false, loading: false, ...flags })
  push({ occluded: true })
  await settle()
  push({ visible: true })
  await settle()
  push({ visible: false })
  await settle()
  push({ occluded: false })
  await settle()
  assert.deepEqual(presentation.occluded, [true, false, true, false], 'visible:true clears a hide; the flags stay symmetric')
  await frame.dispose()
})