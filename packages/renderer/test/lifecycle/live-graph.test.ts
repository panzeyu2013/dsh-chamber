/**
 * Live client-plugin graph sync (live-graph.ts): frame parsing, the pure id-set
 * diff, the reconciler's add/remove/rev/diagnostic behavior, and the
 * disarm/fence contract. The kernel IS the shipped one (page-level state), so
 * every case resets it — mutation of the shared tables must be observable.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'
import {
  clientPluginRowOwner, loadClientPluginRows, resetClientPluginLoaderState,
} from '@dsh-chamber/dsh-chamber-client-core/client-plugin-loader'
import { restartRequiredMessage, type ExtraModuleRow, type HostGraphRow } from '../../src/host-graph.ts'
import { readFile } from 'node:fs/promises'
import {
  diffLiveRows, parsePluginEventFrame,
  readLiveSyncEnabled, startLiveGraphSync,
  type LiveDiagnosticSink, type LiveEventSourceFace, type LiveGraphSyncDeps,
  type LiveLoaderEntryFace, type LiveLoaderFace, type MountedLiveRow,
} from '../../src/live-graph.ts'

const BASE = '/api/i/local'

const row = (id: string, over: Partial<HostGraphRow> = {}): HostGraphRow => ({
  id,
  url: `/plugins/??${id}&rev=abc123`,
  rev: 'abc123',
  ...over,
})

const extra = (id: string, rev = 'abc123'): ExtraModuleRow => {
  const url = `${BASE}/plugins/??${id}&rev=${rev}`
  return { id, url, initialUrl: url, rev, inject: [], external: [] }
}

const graphFrame = (rows: unknown[]): string => JSON.stringify({ type: 'graph', graph: { rev: 'g1', entries: rows } })

/** Fake cordis loader: random-ish entry ids, name-keyed scan, inertia on removal. */
function fakeLoader(seed: { name: string; active?: boolean; fiberAwait?: () => Promise<unknown> }[] = []) {
  let seq = 0
  const entries: LiveLoaderEntryFace[] = seed.map(item => ({
    id: `entry-${++seq}`,
    options: { name: item.name },
    fiber: { state: item.active === false ? 1 : 2, await: item.fiberAwait ?? (async () => undefined) },
  }))
  const removed: string[] = []
  const loader: LiveLoaderFace = {
    entries: () => entries,
    async create({ name }) {
      const id = `entry-${++seq}`
      entries.push({ id, options: { name }, fiber: { state: 2, await: async () => undefined } })
      return id
    },
    remove(id) {
      const index = entries.findIndex(entry => entry.id === id)
      if (index < 0) throw new Error(`cannot resolve entry ${id}`)
      entries.splice(index, 1)
      removed.push(id)
    },
    resolve(id) {
      const entry = entries.find(candidate => candidate.id === id)
      if (entry === undefined) throw new Error(`cannot resolve entry ${id}`)
      return entry
    },
  }
  return { loader, entries, removed }
}

/** Fake EventSource: records the url, exposes the message/error listeners. */
function fakeSource(url: string) {
  const listeners = new Map<string, ((event: { data?: string }) => void)[]>()
  let closed = false
  let readyState = 1
  const source: LiveEventSourceFace = {
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    close() { closed = true; readyState = 2 },
    get readyState() { return readyState },
  }
  return {
    url, source,
    get closed() { return closed },
    emit(data: string) { for (const listener of listeners.get('message') ?? []) listener({ data }) },
    error() { for (const listener of listeners.get('error') ?? []) listener({}) },
    /** The browser failed the connection for good (a non-200 reconnect does exactly that). */
    closeForGood() { readyState = 2 },
  }
}

interface Harness {
  sync: ReturnType<typeof startLiveGraphSync>
  source: ReturnType<typeof fakeSource>
  sink: { record: PluginGraphDiagnostic | undefined; writes: PluginGraphDiagnostic[]; read(): PluginGraphDiagnostic | undefined; write(record: PluginGraphDiagnostic): void }
  loader: ReturnType<typeof fakeLoader>
  chunkOwners: string[]
  chunkRemovals: string[][]
  warns: string[]
  loads: string[]
  sourceUrls: string[]
  setIsCurrent(value: boolean): void
}

function harness(
  t: TestContext,
  over: Partial<LiveGraphSyncDeps> = {},
  options: { resetKernel?: boolean } = {},
): Harness {
  if (options.resetKernel !== false) resetClientPluginLoaderState()
  const loader = fakeLoader()
  const source = fakeSource(`${BASE}/plugins/events`)
  const sink = {
    record: undefined as PluginGraphDiagnostic | undefined,
    writes: [] as PluginGraphDiagnostic[],
    read() { return this.record },
    write(record: PluginGraphDiagnostic) { this.record = record; this.writes.push(record) },
  }
  const chunkOwners: string[] = []
  const chunkRemovals: string[][] = []
  const warns: string[] = []
  const loads: string[] = []
  const sourceUrls: string[] = []
  let current = true
  const deps: LiveGraphSyncDeps = {
    sourceId: 'local',
    basePath: BASE,
    initialRows: [],
    loader: loader.loader,
    registerChunkOwners: rows => { for (const r of rows) chunkOwners.push(r.id) },
    removeChunkOwners: ids => { chunkRemovals.push([...ids]) },
    loadBundle: async url => { loads.push(url) },
    diagnostics: sink as LiveDiagnosticSink,
    isCurrent: () => current,
    fiberIsActive: fiber => fiber?.state === 2,
    fiberIsTerminal: fiber => fiber?.state === 3 || fiber?.state === 4 || fiber?.state === 5,
    createEventSource: url => { sourceUrls.push(url); return source.source },
    now: () => 1_000,
    activationTimeoutMs: 20,
    warn: message => { warns.push(message) },
    ...over,
  }
  const sync = startLiveGraphSync(deps)
  t.after(() => { void sync.disarm(); resetClientPluginLoaderState() })
  return {
    sync, source, sink, loader, chunkOwners, chunkRemovals, warns, loads, sourceUrls,
    setIsCurrent: value => { current = value },
  }
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

test('parsePluginEventFrame: graph frame rows, rebuilt frame, malformed → null', () => {
  const frame = parsePluginEventFrame(graphFrame([row('@scope/a')]))
  assert.deepEqual(frame, { kind: 'graph', rows: [{ id: '@scope/a', url: '/plugins/??@scope/a&rev=abc123', rev: 'abc123' }] })
  assert.deepEqual(parsePluginEventFrame(JSON.stringify({ type: 'rebuilt', id: '@scope/a', rev: 'r2' })),
    { kind: 'rebuilt', id: '@scope/a', rev: 'r2' })
  assert.equal(parsePluginEventFrame('not json'), null)
  assert.equal(parsePluginEventFrame(JSON.stringify({ type: 'rebuilt', id: '@scope/a' })), null)
  assert.equal(parsePluginEventFrame(JSON.stringify({ type: 'graph', graph: {} })), null)
  assert.equal(parsePluginEventFrame(graphFrame([{ id: '@scope/a', url: 3, rev: 'r' }])), null)
  assert.equal(parsePluginEventFrame(graphFrame([{ id: '@scope/a', url: '/x', rev: 'r', inject: 'nope' }])), null)
  // A non-graph/rebuilt type is ignored, never fatal (and never reported as malformed).
  assert.deepEqual(parsePluginEventFrame(JSON.stringify({ type: 'connected' })), { kind: 'ignored' })
  assert.deepEqual(parsePluginEventFrame(JSON.stringify({ type: 3 })), { kind: 'ignored' })
  assert.deepEqual(parsePluginEventFrame(JSON.stringify({ graph: {} })), { kind: 'ignored' })
})

test('diffLiveRows: add/remove/rev/recheck with first-duplicate-wins', () => {
  const mounted = new Map<string, MountedLiveRow>([
    ['@scope/keep', { row: extra('@scope/keep'), entryId: 'entry-1' }],
    ['@scope/gone', { row: extra('@scope/gone'), entryId: 'entry-2' }],
    ['@scope/pending', { row: extra('@scope/pending'), entryId: 'entry-3', pending: true }],
  ])
  const diff = diffLiveRows(mounted, [
    extra('@scope/keep'),
    extra('@scope/new'),
    extra('@scope/new', 'zzz999'),
    extra('@scope/pending'),
  ])
  assert.deepEqual(diff.remove.map(item => item.id), ['@scope/gone'])
  assert.deepEqual(diff.add.map(item => item.id), ['@scope/new'])
  assert.equal(diff.add[0]?.rev, 'abc123', 'the FIRST duplicate wins (not the later rev)')
  assert.deepEqual(diff.revChanged, [])
  assert.deepEqual(diff.recheck.map(item => item.id), ['@scope/pending'])
  // A duplicate id keeps its FIRST occurrence (the kernel's own rule), so a later
  // rev for the same id inside one frame is not a rev change.
  assert.deepEqual(diffLiveRows(mounted, [extra('@scope/keep', 'rev-next')]).revChanged
    .map(item => item.incoming.rev), ['rev-next'])
})

test('a graph frame mounts kept rows once and registers them as chunk owners', async (t) => {
  const h = harness(t)
  h.source.emit(graphFrame([row('@scope/a'), row('@scope/b')]))
  await tick()
  assert.deepEqual(h.loader.entries.map(entry => entry.options?.name), ['@scope/a', '@scope/b'])
  assert.deepEqual(h.chunkOwners, ['@scope/a', '@scope/b'])
  assert.deepEqual(h.loads.map(url => new URL(url, 'http://x').pathname + new URL(url, 'http://x').search),
    [`${BASE}/plugins/??@scope/a&rev=abc123`, `${BASE}/plugins/??@scope/b&rev=abc123`])
  assert.equal(h.sink.record, undefined)
  // The identical frame is a no-op: no second script, no second create.
  h.source.emit(graphFrame([row('@scope/a'), row('@scope/b')]))
  await tick()
  assert.equal(h.loads.length, 2)
  assert.equal(h.chunkOwners.length, 2)
})

test('a removed id drops its entry + chunk owner and keeps the factory (same-rev re-add reuses)', async (t) => {
  const h = harness(t)
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  const entryId = h.loader.entries[0]!.id
  h.source.emit(graphFrame([]))
  await tick()
  assert.deepEqual(h.loader.removed, [entryId])
  assert.deepEqual(h.chunkRemovals, [['@scope/a']])
  assert.equal(h.sink.record, undefined)
  // Re-add at the SAME rev: the kernel still owns the factory, so no new script.
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  assert.equal(h.loads.length, 1)
  assert.equal(h.loader.entries.length, 1)
})

test('a rev change for a mounted id reports restart-required without touching the entry', async (t) => {
  const h = harness(t)
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  const entryId = h.loader.entries[0]!.id
  h.source.emit(graphFrame([row('@scope/a', { rev: 'rev2', url: '/plugins/??@scope/a&rev=rev2' })]))
  await tick()
  assert.equal(h.sink.record?.state, 'restart-required')
  assert.equal(h.sink.record?.pluginId, '@scope/a')
  assert.match(h.sink.record?.message ?? '', /宿主已重建为 rev2/)
  assert.deepEqual(h.loader.entries.map(entry => entry.id), [entryId])
  assert.equal(h.loads.length, 1)
  assert.deepEqual(h.chunkRemovals, [])
})

test('an add on a rev-conflict never creates an entry and reports the boot fact', async (t) => {
  const h = harness(t)
  // Another boot of the SAME source already loaded the id at revA (kernel state).
  await loadClientPluginRows('local', [extra('@scope/a')], { loadBundle: async () => undefined }, {
    ordinary: 'defer', timeout: 'collect',
  })
  h.source.emit(graphFrame([row('@scope/a', { rev: 'rev2', url: '/plugins/??@scope/a&rev=rev2' })]))
  await tick()
  assert.equal(h.sink.record?.state, 'restart-required')
  // Locked to the boot projection's text: both writers share one builder.
  assert.equal(h.sink.record?.message, restartRequiredMessage('@scope/a'))
  assert.equal(h.loader.entries.length, 0)
  assert.equal(h.loads.length, 0)
})

test('covered official rows are filtered, and an answered empty graph is a no-op', async (t) => {
  const h = harness(t)
  h.source.emit(graphFrame([row('@deepseek-ai/dsh-client-hmr'), row('@scope/plain')]))
  await tick()
  // Positive control: the pass really ran — only the COVERED row is filtered out.
  assert.deepEqual(h.loader.entries.map(entry => entry.options?.name), ['@scope/plain'])
  assert.equal(h.sink.record, undefined)
  h.source.emit(graphFrame([]))
  await tick()
  assert.equal(h.warns.length, 0)
})

test('a mounted-but-pending row is re-checked on the next frame and healed to ok', async (t) => {
  const loader = fakeLoader()
  const h = harness(t, {
    loader: loader.loader,
    fiberIsActive: fiber => fiber?.state === 2,
  })
  // Force the create to yield a pending fiber: patch create for this case.
  const original = loader.loader.create
  let pendingFiber: { state?: number } = { state: 1 }
  loader.loader.create = async ({ name }) => {
    const id = await original.call(loader.loader, { name })
    const entry = loader.entries.find(candidate => candidate.id === id)!
    entry.fiber = { state: 1, await: () => new Promise(() => undefined) }
    pendingFiber = entry.fiber
    return id
  }
  h.source.emit(graphFrame([row('@scope/a')]))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(h.sink.record?.state, 'bundle-load-failed')
  assert.equal(h.sink.record?.pluginId, '@scope/a')
  pendingFiber.state = 2
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  assert.equal(h.sink.record?.state, 'ok')
})

test('a fact another plugin id owns is never clobbered', async (t) => {
  const h = harness(t)
  // Positive control: this reconciler CAN write its own fact into an empty slot.
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  h.source.emit(graphFrame([row('@scope/a', { rev: 'rev2', url: '/plugins/??@scope/a&rev=rev2' })]))
  await tick()
  assert.deepEqual(h.sink.writes.map(record => record.state), ['restart-required'])
  // Another writer now owns the slot for a DIFFERENT plugin id.
  h.sink.record = { state: 'restart-required', pluginId: '@other/pkg', message: 'boot fact', updatedAt: 5 }
  h.source.emit(graphFrame([row('@scope/a', { rev: 'rev3', url: '/plugins/??@scope/a&rev=rev3' })]))
  await tick()
  assert.deepEqual(h.sink.record, { state: 'restart-required', pluginId: '@other/pkg', message: 'boot fact', updatedAt: 5 })
  assert.equal(h.sink.writes.length, 1, 'the foreign fact must survive the pass')
})

test('malformed frames warn once and never break the stream', async (t) => {
  const h = harness(t)
  h.source.emit('{oops')
  h.source.emit('{again')
  await tick()
  assert.equal(h.warns.length, 1)
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  assert.equal(h.loader.entries.length, 1)
})

test('after disarm a frame is inert and disarm resolves the in-flight pass', async (t) => {
  const h = harness(t)
  h.source.emit(graphFrame([row('@scope/a')]))
  const idle = h.sync.disarm()
  assert.equal(h.source.closed, true)
  await idle
  h.source.emit(graphFrame([row('@scope/b')]))
  await tick()
  assert.deepEqual(h.loader.entries.map(entry => entry.options?.name), ['@scope/a'])
})

test('a fence that flips mid-pass stops the remaining rows', async (t) => {
  const h = harness(t)
  const original = h.loader.loader.create.bind(h.loader.loader)
  let calls = 0
  h.loader.loader.create = async options => {
    calls += 1
    if (calls === 2) h.setIsCurrent(false)
    return await original(options)
  }
  h.source.emit(graphFrame([row('@scope/a'), row('@scope/b')]))
  await tick()
  // The first row mounted; the fence flipped during the second create, so that entry is
  // rolled back and no further row is attempted.
  assert.deepEqual(h.loader.entries.map(entry => entry.options?.name), ['@scope/a'])
  assert.equal(h.loader.removed.length, 1)
  assert.deepEqual(h.chunkRemovals, [['@scope/b']])
})

test('kill switch: only an explicit boolean false disables, read at arm time', () => {
  const scope = (value: unknown): Record<string, unknown> => ({ __DSH_CHAMBER_LIVE_PLUGIN_SYNC__: value })
  assert.equal(readLiveSyncEnabled(scope(false)), false)
  assert.equal(readLiveSyncEnabled(scope(undefined)), true)
  assert.equal(readLiveSyncEnabled(scope('false')), true)
  assert.equal(readLiveSyncEnabled(scope(true)), true)
  assert.equal(readLiveSyncEnabled({}), true)
  assert.equal(readLiveSyncEnabled(null), true)
})

test('a channel error logs once and never closes the source (the browser owns reconnection)', async (t) => {
  const h = harness(t)
  h.source.error()
  h.source.error()
  assert.equal(h.warns.filter(message => message.includes('dropped')).length, 1)
  assert.equal(h.source.closed, false, 'closing would stop the browser EventSource retry')
})

test('the channel is one EventSource on the instance-prefixed /plugins/events route', async (t) => {
  const h = harness(t)
  assert.deepEqual(h.sourceUrls, [`${BASE}/plugins/events`])
})

test('a permanently-CLOSED socket (non-200 reconnect) is rebuilt with bounded backoff', async (t) => {
  const fakes: ReturnType<typeof fakeSource>[] = []
  const h = harness(t, {
    resubscribeDelaysMs: [0, 0],
    createEventSource: url => { const fake = fakeSource(url); fakes.push(fake); return fake.source },
  })
  assert.equal(fakes.length, 1, 'one socket at arm time')
  fakes[0]!.closeForGood()
  fakes[0]!.error()
  await tick()
  await tick()
  assert.equal(fakes.length, 2, 'a CLOSED socket is re-established')
  assert.equal(fakes[1]!.url, `${BASE}/plugins/events`, 'the rebuild targets the same route')
  // The rebuilt socket still drives the reconciler (a frame mounts a row again).
  fakes[1]!.emit(graphFrame([row('@scope/revived')]))
  const deadline = Date.now() + 1_000
  while (h.loader.entries.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(h.loader.entries.length, 1, 'frames on the rebuilt socket mount rows again')
})

test('the rebuild budget is bounded: it stops and says so once when exhausted', async (t) => {
  const fakes: ReturnType<typeof fakeSource>[] = []
  const warns: string[] = []
  harness(t, {
    resubscribeDelaysMs: [0, 0],
    warn: message => { warns.push(message) },
    createEventSource: url => { const fake = fakeSource(url); fakes.push(fake); return fake.source },
  })
  for (let round = 0; round < 4; round++) {
    fakes.at(-1)!.closeForGood()
    fakes.at(-1)!.error()
    await tick()
    await tick()
  }
  assert.equal(fakes.length, 3, 'one initial socket + one per budget slot, then stop')
  assert.equal(warns.filter(message => message.includes('gave up')).length, 1)
})

test('disarm cancels a pending rebuild', async (t) => {
  const fakes: ReturnType<typeof fakeSource>[] = []
  const h = harness(t, {
    resubscribeDelaysMs: [50],
    createEventSource: url => { const fake = fakeSource(url); fakes.push(fake); return fake.source },
  })
  fakes[0]!.closeForGood()
  fakes[0]!.error()
  await h.sync.disarm()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(fakes.length, 1, 'no socket may be built after disarm')
})

test('a delivered frame resets the rebuild budget (a later drop earns a fresh attempt)', async (t) => {
  const fakes: ReturnType<typeof fakeSource>[] = []
  const h = harness(t, {
    resubscribeDelaysMs: [0],
    createEventSource: url => { const fake = fakeSource(url); fakes.push(fake); return fake.source },
  })
  fakes[0]!.closeForGood()
  fakes[0]!.error()
  await tick()
  await tick()
  assert.equal(fakes.length, 2, 'the single budget slot was spent')
  // A frame on the rebuilt socket is proof the channel works: the budget must re-arm.
  fakes[1]!.emit(graphFrame([row('@scope/revive')]))
  const deadline = Date.now() + 1_000
  while (h.loader.entries.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  fakes[1]!.closeForGood()
  fakes[1]!.error()
  await tick()
  await tick()
  assert.equal(fakes.length, 3, 'a delivered frame re-arms the full budget')
})

test('the shipped rebuild ladder is 2/5/10/20/30/30s and then gives up (97s, the restart window)', async (t) => {
  // Every other case injects the seam; this one pins the DEFAULT the design quotes.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => { t.mock.timers.reset() })
  const fakes: ReturnType<typeof fakeSource>[] = []
  const h = harness(t, {
    createEventSource: url => { const fake = fakeSource(url); fakes.push(fake); return fake.source },
  })
  const ladder = [2_000, 5_000, 10_000, 20_000, 30_000, 30_000]
  for (const [index, delay] of ladder.entries()) {
    fakes.at(-1)!.closeForGood()
    fakes.at(-1)!.error()
    t.mock.timers.tick(delay - 1)
    assert.equal(fakes.length, index + 1, `slot ${index + 1} must not fire before ${delay}ms`)
    t.mock.timers.tick(1)
    assert.equal(fakes.length, index + 2, `slot ${index + 1} fires after ${delay}ms`)
  }
  // Budget exhausted: one more CLOSED error gives up (no socket, exactly one log).
  fakes.at(-1)!.closeForGood()
  fakes.at(-1)!.error()
  t.mock.timers.tick(60_000)
  assert.equal(fakes.length, 1 + ladder.length, 'exactly six slots, then stop')
  assert.equal(h.warns.filter(message => message.includes('gave up')).length, 1)
})

test('a CONNECTING error still leaves reconnection to the browser (no rebuild)', async (t) => {
  const fakes: ReturnType<typeof fakeSource>[] = []
  const h = harness(t, {
    resubscribeDelaysMs: [0],
    createEventSource: url => { const fake = fakeSource(url); fakes.push(fake); return fake.source },
  })
  fakes[0]!.error()
  await tick()
  assert.equal(fakes.length, 1, 'CONNECTING must not trigger our own rebuild')
  assert.equal(h.warns.filter(message => message.includes('the browser will retry')).length, 1)
})

test('rebuilt and unknown frames are consumed without a malformed warning or a pass', async (t) => {
  const h = harness(t)
  // Positive control: a real graph frame DOES mount a row and run the pass.
  h.source.emit(graphFrame([row('@scope/ctrl')]))
  await tick()
  assert.equal(h.loader.entries.length, 1)
  assert.equal(h.loads.length, 1)
  h.source.emit(JSON.stringify({ type: 'rebuilt', id: '@scope/a', rev: 'rev2' }))
  h.source.emit(JSON.stringify({ type: 'connected' }))
  h.source.emit(JSON.stringify({ type: 'future-frame', payload: 1 }))
  h.source.emit(JSON.stringify({ type: 3 }))
  h.source.emit(JSON.stringify({ graph: {} }))
  await tick()
  assert.equal(h.warns.length, 0)
  assert.equal(h.loads.length, 1, 'the no-op frames must not trigger a second pass')
  assert.equal(h.loader.entries.length, 1, 'and must not undo the mounted control row')
  assert.deepEqual(h.sink.writes, [])
})

test('a boot row whose entry never materialized is mounted by the first frame (live baseline)', async (t) => {
  // The boot tolerated a failed create for this row, so nothing is mounted for it; the
  // live baseline scans the loader and must retry it instead of treating it as removed.
  const h = harness(t, { initialRows: [extra('@scope/late')] })
  h.source.emit(graphFrame([row('@scope/late')]))
  await tick()
  assert.deepEqual(h.loader.entries.map(entry => entry.options?.name), ['@scope/late'])
  assert.deepEqual(h.chunkOwners, ['@scope/late'])
  assert.equal(h.sink.record, undefined)
})

test('a boot-mounted row is not re-created by the first frame (baseline from the live loader)', async (t) => {
  const loader = fakeLoader([{ name: '@scope/a', active: true }])
  const h = harness(t, { loader: loader.loader, initialRows: [extra('@scope/a')] })
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  assert.equal(loader.entries.length, 1)
  assert.equal(h.loads.length, 0)
  assert.equal(h.chunkOwners.length, 0)
  assert.equal(h.sink.record, undefined)
})

test('a second source adding an id another source owns reports instance-version-conflict and stays isolated', async (t) => {
  const first = harness(t)
  first.source.emit(graphFrame([row('@scope/shared')]))
  await tick()
  assert.deepEqual(first.loader.entries.map(entry => entry.options?.name), ['@scope/shared'])
  // N-ctx: a second source shares the page-level kernel but has its own loader/sink.
  const second = harness(
    t,
    { sourceId: 'ssh-1', basePath: '/api/i/ssh-1' },
    { resetKernel: false },
  )
  second.source.emit(graphFrame([row('@scope/shared', { rev: 'other-rev', url: '/plugins/??@scope/shared&rev=other-rev' })]))
  await tick()
  assert.equal(second.sink.record?.state, 'instance-version-conflict')
  assert.equal(second.sink.record?.pluginId, '@scope/shared')
  assert.match(second.sink.record?.message ?? '', /实例 local 先加载的版本/)
  assert.equal(second.loader.entries.length, 0)
  assert.deepEqual(second.chunkOwners, [])
  // The first source's own slot and loader are untouched.
  assert.equal(first.sink.record, undefined)
  assert.deepEqual(first.loader.entries.map(entry => entry.options?.name), ['@scope/shared'])
})

test('a failed add reports bundle-load-failed and a later frame retries the load', async (t) => {
  let attempts = 0
  const h = harness(t, {
    loadBundle: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
    },
  })
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  assert.equal(h.sink.record?.state, 'bundle-load-failed')
  assert.equal(h.sink.record?.pluginId, '@scope/a')
  assert.equal(h.loader.entries.length, 0)
  // The kernel cleared the failed combo, so the next frame attempts the script again.
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  assert.equal(attempts, 2)
  assert.equal(h.loader.entries.length, 1)
})

test('a still-inactive mounted row keeps its pending fact across later frames (no false heal)', async (t) => {
  const loader = fakeLoader()
  const h = harness(t, { loader: loader.loader })
  const original = loader.loader.create
  // ONLY '@scope/a' stays inactive; '@scope/b' must activate so the second frame's pass
  // can publish — otherwise the assertion would read the FIRST frame's stale fact and the
  // re-emit branch would not be exercised at all (round-3 F3-1).
  loader.loader.create = async ({ name }) => {
    const id = await original.call(loader.loader, { name })
    if (name === '@scope/a') {
      const entry = loader.entries.find(candidate => candidate.id === id)!
      entry.fiber = { state: 1, await: () => new Promise(() => undefined) }
    }
    return id
  }
  h.source.emit(graphFrame([row('@scope/a')]))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(h.sink.record?.state, 'bundle-load-failed')
  assert.equal(h.sink.record?.pluginId, '@scope/a')
  assert.match(h.sink.record?.message ?? '', /未在窗口内激活/)
  // A later frame (another row appears) must RE-EMIT '@scope/a' pending, not converge to ok.
  h.source.emit(graphFrame([row('@scope/a'), row('@scope/b')]))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(h.sink.record?.state, 'bundle-load-failed')
  assert.equal(h.sink.record?.pluginId, '@scope/a')
  assert.match(h.sink.record?.message ?? '', /未在窗口内激活/)
})

test('a holder that dies while create is in flight rolls the created entry back', async (t) => {
  const h = harness(t)
  const original = h.loader.loader.create.bind(h.loader.loader)
  h.loader.loader.create = async options => {
    const id = await original(options)
    h.setIsCurrent(false)
    return id
  }
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  // The page-level loader must not keep an orphan entry (a successor boot would create
  // a second entry for the same plugin name), and its chunk owner is dropped too.
  assert.equal(h.loader.entries.length, 0)
  assert.equal(h.loader.removed.length, 1)
  assert.deepEqual(h.chunkRemovals, [['@scope/a']])
})

test('a removal still drops the page-level chunk owner when the fence flips mid-removal', async (t) => {
  const h = harness(t)
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  const original = h.loader.loader.remove.bind(h.loader.loader)
  h.loader.loader.remove = id => {
    h.setIsCurrent(false)
    original(id)
  }
  h.source.emit(graphFrame([]))
  await tick()
  assert.deepEqual(h.chunkRemovals, [['@scope/a']])
})


test('a persisting fact is written once under a real clock (fact identity, not the stamp)', async (t) => {
  // No injected now(): every pass derives a fresh updatedAt, so only fact identity can
  // keep a persisting fact from rewriting + re-emitting on every graph frame.
  const before = Date.now()
  const h = harness(t, { now: undefined })
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  h.source.emit(graphFrame([row('@scope/a', { rev: 'rev2', url: '/plugins/??@scope/a&rev=rev2' })]))
  await tick()
  assert.deepEqual(h.sink.writes.map(record => record.state), ['restart-required'])
  assert.ok((h.sink.writes[0]?.updatedAt ?? 0) >= before, 'a real clock, not a constant fallback')
  // The same fact again: no second write, no second emit.
  h.source.emit(graphFrame([row('@scope/a', { rev: 'rev2', url: '/plugins/??@scope/a&rev=rev2' })]))
  await tick()
  assert.deepEqual(h.sink.writes.map(record => record.state), ['restart-required'])
  // The rev matches the mounted row again → the fact clears (one ok write), and a
  // further identical frame must not rewrite that ok record either.
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  assert.deepEqual(h.sink.writes.map(record => record.state), ['restart-required', 'ok'])
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  assert.deepEqual(h.sink.writes.map(record => record.state), ['restart-required', 'ok'])
})

test('a fence that flips during activation rolls the created entry back', async (t) => {
  const loader = fakeLoader()
  const h = harness(t, { loader: loader.loader, activationTimeoutMs: 60 })
  const original = loader.loader.create
  loader.loader.create = async ({ name }) => {
    const id = await original.call(loader.loader, { name })
    const entry = loader.entries.find(candidate => candidate.id === id)!
    entry.fiber = { state: 1, await: () => new Promise(() => undefined) }
    return id
  }
  h.source.emit(graphFrame([row('@scope/g')]))
  // Deterministic: wait until the entry EXISTS before flipping the fence, then poll for
  // the rollback — no fixed margin that a loaded CI could miss.
  const deadline = Date.now() + 1_000
  while (loader.entries.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(loader.entries.length, 1, 'the entry must be created before the fence flips')
  h.setIsCurrent(false)
  while (loader.entries.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(loader.entries.length, 0, 'the dead holder must not leave its entry behind')
  assert.deepEqual(h.chunkRemovals, [['@scope/g']])
})

test('an entry created without a fiber is rolled back and a later frame retries cleanly', async (t) => {
  const h = harness(t)
  const original = h.loader.loader.create.bind(h.loader.loader)
  h.loader.loader.create = async options => {
    const id = await original(options)
    const entry = h.loader.entries.find(candidate => candidate.id === id)!
    delete entry.fiber
    return id
  }
  h.source.emit(graphFrame([row('@scope/nf')]))
  await tick()
  assert.equal(h.loader.entries.length, 0, 'a fiberless entry can never activate')
  assert.equal(h.sink.record?.state, 'bundle-load-failed')
  assert.deepEqual(h.chunkRemovals, [['@scope/nf']])
  // The retry must create exactly one fresh entry, not a duplicate.
  h.loader.loader.create = original
  h.source.emit(graphFrame([row('@scope/nf')]))
  await tick()
  assert.equal(h.loader.entries.length, 1)
  assert.equal(h.sink.record?.state, 'ok')
})

test('a no-op frame never evicts a queued graph snapshot (the slot takes graph frames only)', async (t) => {
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const h = harness(t, {
    loadBundle: async () => {
      calls += 1
      if (calls === 1) await gate
    },
  })
  h.source.emit(graphFrame([row('@scope/first')]))
  await tick()
  assert.equal(h.loader.entries.length, 0, 'the first pass is gated inside loadBundle')
  // While that pass is in flight: a NEW graph snapshot, then frames that are no-ops.
  h.source.emit(graphFrame([row('@scope/first'), row('@scope/queued')]))
  h.source.emit(JSON.stringify({ type: 'rebuilt', id: '@scope/first', rev: 'rev2' }))
  h.source.emit(JSON.stringify({ type: 'future-frame', payload: 1 }))
  h.source.emit(JSON.stringify({ graph: {} }))
  release!()
  const deadline = Date.now() + 1_000
  while (h.loader.entries.length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.deepEqual(
    h.loader.entries.map(entry => entry.options?.name).sort(),
    ['@scope/first', '@scope/queued'],
    'the queued graph frame must survive the no-op frames',
  )
})

test('a fact cleared behind the reconciler is re-published (dedupe checks the slot)', async (t) => {
  const h = harness(t)
  h.source.emit(graphFrame([row('@scope/a')]))
  await tick()
  h.source.emit(graphFrame([row('@scope/a', { rev: 'rev2', url: '/plugins/??@scope/a&rev=rev2' })]))
  await tick()
  assert.deepEqual(h.sink.writes.map(record => record.state), ['restart-required'])
  // An external retire path clears the slot while this holder lives: a memoised
  // lastWrite must NOT swallow the persisting fact.
  h.sink.record = undefined
  h.source.emit(graphFrame([row('@scope/a', { rev: 'rev2', url: '/plugins/??@scope/a&rev=rev2' })]))
  await tick()
  assert.deepEqual(h.sink.writes.map(record => record.state), ['restart-required', 'restart-required'])
  assert.equal(h.sink.writes.at(-1)?.pluginId, '@scope/a')
})

test('a boot-era fiberless entry is dropped, not duplicated, when the row retries', async (t) => {
  const loader = fakeLoader([{ name: '@scope/bootbroken' }])
  delete loader.entries[0]!.fiber
  const h = harness(t, { loader: loader.loader, initialRows: [extra('@scope/bootbroken')] })
  assert.equal(loader.entries.length, 0, 'the dead boot entry is dropped at arm time')
  h.source.emit(graphFrame([row('@scope/bootbroken')]))
  const deadline = Date.now() + 1_000
  while (loader.entries.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(loader.entries.length, 1, 'exactly one fresh entry, no orphan duplicate')
})

test('a disposal phase that installs a second inertia promise is awaited (bounded chain)', async (t) => {
  const loader = fakeLoader()
  const h = harness(t, { loader: loader.loader })
  h.source.emit(graphFrame([row('@scope/i')]))
  await tick()
  assert.equal(loader.entries.length, 1)
  const entry = loader.entries[0]!
  let secondResolved = false
  const second = new Promise<void>(resolve => {
    setTimeout(() => { secondResolved = true; resolve() }, 30)
  })
  const head = new Promise<void>(resolve => {
    setTimeout(() => { entry.fiber!.inertia = second; resolve() }, 5)
  })
  entry.fiber = { state: 2, await: async () => undefined, inertia: head }
  h.source.emit(graphFrame([]))
  // disarm() resolves with the in-flight pass: if the pass stopped after the FIRST
  // inertia promise, it finishes ~25ms before 'second' ever resolves.
  await h.sync.disarm()
  assert.equal(loader.entries.length, 0, 'the row was removed')
  assert.equal(secondResolved, true, 'the pass must await the NEW inertia installed during disposal')
})

test('a rev change owned by another source reports instance-version-conflict, not restart-required', async (t) => {
  const first = harness(t)
  first.source.emit(graphFrame([row('@scope/shared')]))
  await tick()
  assert.equal(clientPluginRowOwner('@scope/shared'), 'local')
  // This source's boot baseline already mounted the shared row (kernel reuse)...
  const loader = fakeLoader([{ name: '@scope/shared' }])
  const second = harness(t, {
    sourceId: 'ssh-1', basePath: '/api/i/ssh-1', loader: loader.loader,
    initialRows: [extra('@scope/shared')],
  }, { resetKernel: false })
  // ...and its host now rebuilds the SAME id: no restart of THIS source can switch it.
  second.source.emit(graphFrame([row('@scope/shared', { rev: 'other-rev', url: '/plugins/??@scope/shared&rev=other-rev' })]))
  await tick()
  assert.equal(second.sink.record?.state, 'instance-version-conflict')
  assert.equal(second.sink.record?.pluginId, '@scope/shared')
  assert.match(second.sink.record?.message ?? '', /实例 local 先加载的版本/)
})

test('a removal never drops a page-level chunk owner another source still holds', async (t) => {
  resetClientPluginLoaderState()
  const first = harness(t)
  first.source.emit(graphFrame([row('@scope/shared-owner')]))
  await tick()
  assert.equal(clientPluginRowOwner('@scope/shared-owner'), 'local')
  // A SECOND source mounts the same id from its boot baseline (kernel reuse)...
  const loader = fakeLoader([{ name: '@scope/shared-owner' }])
  const second = harness(t, {
    sourceId: 'ssh-1', basePath: '/api/i/ssh-1', loader: loader.loader,
    initialRows: [extra('@scope/shared-owner')],
  }, { resetKernel: false })
  // ...and its host drops the row: the shared descriptor belongs to 'local', so it stays.
  second.source.emit(graphFrame([]))
  await tick()
  assert.deepEqual(second.chunkRemovals, [], 'a non-owner remove must not delete the descriptor the owner still needs')
  assert.equal(loader.entries.length, 0, 'the entry itself is still removed for this source')
  // Positive control: the owner's own removal still drops it.
  first.source.emit(graphFrame([]))
  await tick()
  assert.deepEqual(first.chunkRemovals, [['@scope/shared-owner']])
})

test('a boot baseline fiber in a terminal state is dropped and the next frame retries it', async (t) => {
  resetClientPluginLoaderState()
  const loader = fakeLoader([{ name: '@scope/dead' }])
  loader.entries[0]!.fiber!.state = 3
  const h = harness(t, { loader: loader.loader, initialRows: [extra('@scope/dead')] }, { resetKernel: false })
  assert.equal(loader.entries.length, 0, 'a FAILED boot entry is dropped, never reported pending forever')
  h.source.emit(graphFrame([row('@scope/dead')]))
  await tick()
  assert.equal(loader.entries.length, 1, 'the frame retries the row through the ordinary add path')
  assert.ok(!h.sink.writes.some(record => /未在窗口内激活/.test(record.message ?? '')), 'no fabricated pending fact for the dropped baseline')
})

test('a mounted row whose fiber turns terminal is dropped and retried, not reported pending forever', async (t) => {
  resetClientPluginLoaderState()
  const loader = fakeLoader([{ name: '@scope/late-fail', active: false }])
  const h = harness(t, { loader: loader.loader, initialRows: [extra('@scope/late-fail')] }, { resetKernel: false })
  h.source.emit(graphFrame([row('@scope/late-fail')]))
  await tick()
  assert.equal(h.sink.record?.state, 'bundle-load-failed')
  assert.match(h.sink.record?.message ?? '', /未在窗口内激活/)
  loader.entries[0]!.fiber!.state = 3
  h.source.emit(graphFrame([row('@scope/late-fail')]))
  await tick()
  assert.equal(loader.entries.length, 1, 'the terminal entry was dropped and retried once')
  assert.notEqual(loader.entries[0]!.fiber!.state, 3, 'the retry created a fresh entry')
  assert.ok(!/未在窗口内激活/.test(h.sink.writes.at(-1)?.message ?? ''), 'a terminal fiber no longer masquerades as pending')
})

test('disarm joins the in-flight pass (its promise is a real teardown barrier)', async (t) => {
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness(t, { loadBundle: async () => { await gate } })
  h.source.emit(graphFrame([row('@scope/slow')]))
  await tick()
  let settled = false
  const idle = h.sync.disarm().then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(settled, false, 'disarm must not resolve while the in-flight pass is gated')
  release!()
  await idle
  assert.equal(settled, true)
})
test('shell wiring lockstep: boot-entry disarm, settle-time arm gate, dispose disarm', async () => {
  const source = await readFile(new URL('../../src/shell.ts', import.meta.url), 'utf8')
  // A successor boot disarms the predecessor's live sync synchronously, joined into the
  // id-local teardown barrier (design 09 §3.7 lifecycle).
  assert.match(source,
    /if \(predecessorHolder\?\.liveSync !== undefined\) \{\s*registerTeardownBarrier\(instanceId, predecessorHolder\.liveSync\.disarm\(\)\)/)
  // Arm only for an answered graph, in normal mode, on a host with EventSource and the
  // switch on, inside the settle path.
  assert.match(source,
    /graphAnswered && !safeMode && installedModulesSystem !== null\s*&& readLiveSyncEnabled\(\) && typeof EventSource === 'function'/)
  // Disposal disarms through the same barrier.
  assert.match(source,
    /if \(holder\.liveSync !== undefined\) \{\s*registerTeardownBarrier\(instanceId, holder\.liveSync\.disarm\(\)\)/)
  // The arm flag's setter itself (only an ANSWERED graph arms) and the terminal-fiber predicate:
  // source locks, because deleting either still leaves every behavior test green.
  assert.match(source, /onGraphAnswered: \(\) => \{ graphAnswered = true \}/)
  assert.match(source, /fiberIsTerminal: fiber => fiber\?\.state === FIBER_STATE\.FAILED/)
  // The page-level chunk-owner adapters the reconciler drives.
  assert.match(source, /registerChunkOwners: rows => \{ registerExtraChunkOwners\(modules, rows\) \}/)
  assert.match(source, /removeChunkOwners: ids => \{ removeExtraChunkOwners\(modules, ids\) \}/)
})

