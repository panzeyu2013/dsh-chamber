/**
 * Session-state observer: the store is driven end-to-end through the REAL
 * control-plane mux (createSessionMux) with injected socket/unary seams, so
 * these tests lock the plan's hard edges: one follow read per true->false edge,
 * the turn/end classification outcomes, gap reconstruction, waterfall holding
 * and the 0-downstream rule, event-silence resubscription (R21) and host-down
 * semantics (plan W1 / WS-B; blueprint sections 5.1-5.4, 9-R1/R21).
 *
 * Run directly:
 *   node --import ./test/session-state/workspace-loader.mjs test/session-state/session-state-observer.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSessionStateObserver, createSessionStateStore } from '../../src/session-state.ts'
import {
  OPEN_EVENTS_FRAME,
  baselineItem,
  delay,
  fakeCall,
  fakeSocketFactory,
  settle,
  silentLogger,
  scratch,
} from './harness.ts'

interface ObserverHarness {
  store: ReturnType<typeof createSessionStateStore>
  observer: ReturnType<typeof createSessionStateObserver>
  sockets: ReturnType<typeof fakeSocketFactory>
  calls: ReturnType<typeof fakeCall>
  setItems(items: unknown[]): void
  setAttached(value: boolean): void
  setBase(value: string | null): void
  clock: number
}

function harnessFor(
  t: { after(fn: () => void): void },
  options: {
    stateDir?: string
    attached?: boolean
    base?: string | null
    silenceTimeoutMs?: number
    waterfallGraceMs?: number
    reconcileMs?: number
    pollMs?: number
    tickMs?: number
    items?: unknown[]
  } = {},
): ObserverHarness {
  const realStart = Date.now()
  let clock = 1_000
  const now = (): number => clock + (Date.now() - realStart)
  let items: unknown[] = options.items ?? []
  let attached = options.attached ?? false
  let base: string | null = options.base === undefined ? 'http://127.0.0.1:1234' : options.base
  const store = createSessionStateStore({ stateDir: options.stateDir ?? scratch(t), logger: silentLogger, now })
  const sockets = fakeSocketFactory()
  const calls = fakeCall(() => items)
  const observer = createSessionStateObserver({
    logger: silentLogger,
    store,
    getBaseUrl: () => base,
    getHostState: () => 'ready',
    otherMuxClientsAttached: () => attached,
    openSocket: sockets.openSocket,
    call: calls.call,
    now,
    silenceTimeoutMs: options.silenceTimeoutMs ?? 60_000,
    waterfallGraceMs: options.waterfallGraceMs,
    reconcileMs: options.reconcileMs,
    pollMs: options.pollMs,
    tickMs: options.tickMs,
  })
  t.after(() => { observer.stop(); store.dispose() })
  return {
    store,
    observer,
    sockets,
    calls,
    get clock() { return now() },
    setItems(next) { items = next },
    setAttached(value) { attached = value },
    setBase(value) { base = value },
  }
}

async function connect(harness: ObserverHarness, clientId = 'mux-client-1'): Promise<void> {
  harness.observer.start()
  const socket = harness.sockets.sockets[0]
  socket.emitOpen()
  socket.emitItem('events', { type: 'ready', clientId })
  await settle()
}

function followFrames(harness: ObserverHarness): Array<Record<string, unknown>> {
  return harness.sockets.sockets
    .flatMap(socket => socket.parsed() as Array<Record<string, unknown>>)
    .filter(frame => frame['endpoint'] === 'session/follow')
}

// ---------------------------------------------------------------------------
// Connection + baseline protocol
// ---------------------------------------------------------------------------

test('start sends the exact $events open frame and reconciles a full baseline on ready', async t => {
  const harness = harnessFor(t, { items: [baselineItem('s1', true, 5)] })
  harness.observer.start()
  const socket = harness.sockets.sockets[0]
  socket.emitOpen()
  assert.deepEqual(socket.parsed()[0], OPEN_EVENTS_FRAME, 'the open frame is the frozen {open,$events,{args:{}}} shape')
  assert.equal(harness.calls.calls.length, 0, 'no baseline before the ready frame')
  socket.emitItem('events', { type: 'ready', clientId: 'mux-client-1' })
  await settle()
  const baseline = harness.calls.calls.find(entry => entry.method === 'session/list')
  assert.deepEqual(baseline?.payload, { args: { _request: {} } }, 'zero-argument session/list payload')
  assert.equal(harness.observer.status().mode, 'sse')
  assert.equal(harness.observer.status().ready, true)
  assert.equal(harness.observer.status().clientId, 'mux-client-1')
  assert.equal(harness.store.snapshotFor(null, 'sse', harness.observer.hostInfo()).sessions.length, 1)
})

test('suspend: host-down reports serviceable false and stop() closes the watcher', async t => {
  const harness = harnessFor(t, { base: null })
  const hostDeltas: number[] = []
  harness.store.subscribe(delta => { if (delta.host !== null) hostDeltas.push(delta.host.serviceable ? 1 : 0) })
  harness.observer.start()
  assert.equal(harness.sockets.sockets.length, 0, 'a null base URL opens no socket')
  assert.equal(harness.observer.hostInfo().serviceable, false)
  assert.equal(harness.observer.status().mode, 'poll')
  harness.setBase('http://127.0.0.1:1234')
  harness.observer.kick('host-ready')
  assert.equal(harness.sockets.sockets.length, 1, 'a recovered host opens the mux')
  assert.equal(harness.observer.hostInfo().serviceable, true)
  harness.observer.stop()
  assert.equal(harness.observer.hostInfo().serviceable, false)
  assert.equal(harness.observer.hostInfo().state, 'stopped')
  assert.equal(hostDeltas.includes(0), true, 'the host gate flip is a delta, never a silent change')
})

// ---------------------------------------------------------------------------
// Completion edges: exactly one follow read, classified (R12)
// ---------------------------------------------------------------------------

test('each true->false edge opens exactly one session/follow and a completed tail arms completedAt', async t => {
  const harness = harnessFor(t, { items: [baselineItem('s1', true, 5)] })
  await connect(harness)
  const socket = harness.sockets.sockets[0]
  socket.emitItem('events', { type: 'emit', event: 'api-session/status', args: ['s1', false] })
  const follows = followFrames(harness)
  assert.equal(follows.length, 1, 'one follow read per edge, never N resident follow streams')
  assert.deepEqual(follows[0]['payload'], {
    args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 8 } },
  })
  const rowBefore = harness.store.snapshotFor(null, 'sse', harness.observer.hostInfo()).sessions[0]
  assert.equal(rowBefore.running, false)
  assert.equal(rowBefore.completedAt, null, 'the raw edge arms nothing until the read settles')
  // Duplicate edge before the read settles must not open a second follow.
  socket.emitItem('events', { type: 'emit', event: 'api-session/status', args: ['s1', false] })
  assert.equal(followFrames(harness).length, 1)
  socket.emitItem('follow-1', {
    type: 'snapshot',
    records: [{ type: 'event', event: { type: 'turn/end', seq: 7, time: 9, data: { turn: 1, reason: { kind: 'completed' } } } }],
  })
  await settle()
  const row = harness.store.snapshotFor(null, 'sse', harness.observer.hostInfo()).sessions[0]
  // 观察者用**结算时刻**的时钟打戳，而 harness.clock 是持续走的真实时钟：精确相等
  // 只在"恰好同一毫秒"时成立（负载下的偶发红，2026-12 修）。断言落在本次交互的
  // 时间窗内：既排除 0/陈旧戳，也不依赖同毫秒。
  assert.ok((row.completedAt ?? 0) >= 1_000 && (row.completedAt ?? 0) <= harness.clock,
    `completedAt 必须在本次运行的时间窗内（得到 ${row.completedAt}，窗上限 ${harness.clock}）`)
  assert.equal(row.completedAtSource, 'observed')
  assert.equal(row.lastTurnEnd?.kind, 'completed')
  assert.equal(row.lastTurnEnd?.seq, 7)
  assert.equal(harness.observer.status().followReads, 1)
  assert.equal(harness.observer.status().degraded, false)
})

test('an aborted+user tail never arms unread but is recorded as lastTurnEnd', async t => {
  const harness = harnessFor(t, { items: [baselineItem('s1', true, 5)] })
  await connect(harness)
  const socket = harness.sockets.sockets[0]
  socket.emitItem('events', { type: 'emit', event: 'api-session/status', args: ['s1', false] })
  socket.emitItem('follow-1', {
    type: 'snapshot',
    records: [{ type: 'event', event: { type: 'turn/end', seq: 8, time: 1, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } } }],
  })
  await settle()
  const row = harness.store.snapshotFor(null, 'sse', harness.observer.hostInfo()).sessions[0]
  assert.equal(row.completedAt, null)
  assert.equal(row.completedAtSource, null)
  assert.equal(row.lastTurnEnd?.kind, 'aborted')
  assert.equal(row.lastTurnEnd?.cause, 'user')
})

test('a neutral (blocked) tail arms nothing', async t => {
  const harness = harnessFor(t, { items: [baselineItem('s1', true, 5)] })
  await connect(harness)
  const socket = harness.sockets.sockets[0]
  socket.emitItem('events', { type: 'emit', event: 'api-session/status', args: ['s1', false] })
  socket.emitItem('follow-1', {
    type: 'snapshot',
    records: [{ type: 'event', event: { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'blocked' } } } }],
  })
  await settle()
  const row = harness.store.snapshotFor(null, 'sse', harness.observer.hostInfo()).sessions[0]
  assert.equal(row.completedAt, null)
  assert.equal(row.lastTurnEnd?.kind, 'blocked')
})

test('an unreadable follow falls back to arming with the degraded marker', async t => {
  const harness = harnessFor(t, { items: [baselineItem('s1', true, 5)] })
  await connect(harness)
  const socket = harness.sockets.sockets[0]
  socket.emitItem('events', { type: 'emit', event: 'api-session/status', args: ['s1', false] })
  socket.emitEnd('follow-1')
  await settle()
  const row = harness.store.snapshotFor(null, 'sse', harness.observer.hostInfo()).sessions[0]
  // 同 169 行的竞态修正：真实完成不得丢，但戳记是结算时刻而非 harness.clock 的读数。
  assert.ok((row.completedAt ?? 0) >= 1_000 && (row.completedAt ?? 0) <= harness.clock,
    `a real completion must not be lost（得到 ${row.completedAt}）`)
  assert.equal(row.lastTurnEnd, null, 'but it is never fabricated as a completed reason')
  assert.equal(harness.observer.status().degraded, true)
  assert.equal(harness.observer.status().followFailures, 1)
})

test('a baseline-found stop after a restart is re-classified (gap reconstruction, R3)', async t => {
  const stateDir = scratch(t)
  const seed = harnessFor(t, { stateDir, items: [baselineItem('s1', true, 5)] })
  await connect(seed)
  await seed.store.flush()
  seed.observer.stop()
  seed.store.dispose()

  const restart = harnessFor(t, { stateDir, items: [baselineItem('s1', false, 5)] })
  await connect(restart)
  assert.equal(followFrames(restart).length, 1, 'the stored running candidate is re-read, never armed raw')
  restart.sockets.sockets[0].emitItem('follow-1', {
    type: 'snapshot',
    records: [{ type: 'event', event: { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } }],
  })
  await settle()
  const row = restart.store.snapshotFor(null, 'sse', restart.observer.hostInfo()).sessions[0]
  assert.equal(row.completedAtSource, 'reconstructed')
  assert.equal(row.completedAt !== null, true)
})

// ---------------------------------------------------------------------------
// Waterfall observer discipline (blueprint section 5.4)
// ---------------------------------------------------------------------------

test('a waterfall is held while no downstream mux client exists (never settled)', async t => {
  const stateDir = scratch(t)
  const harness = harnessFor(t, { stateDir, items: [baselineItem('s1', false, 5)], attached: false, waterfallGraceMs: 0 })
  await connect(harness)
  harness.sockets.sockets[0].emitItem('events', {
    type: 'waterfall', event: 'approval/request', eventId: 'w1', agentId: 's1', request: { question: 'TOP-SECRET-QUESTION' },
  })
  await settle()
  const row = harness.store.snapshotFor(null, 'sse', harness.observer.hostInfo()).sessions[0]
  assert.equal(row.pendingKind, 'approval')
  assert.equal(harness.calls.calls.some(entry => entry.method === '$events/result'), false,
    'no downstream client: never answer next (that would settle the approval as unavailable)')
  assert.equal(harness.observer.status().heldWaterfalls, 1)
  // The request payload is never stored: flush and scan the snapshot bytes.
  await harness.store.flush()
  const text = readFileSync(join(stateDir, 'session-state', 'state.json'), 'utf8')
  assert.equal(text.includes('TOP-SECRET-QUESTION'), false, 'waterfall request payloads never reach the snapshot')
  assert.equal(text.includes('TOP-SECRET'), false)
})

test('a held waterfall is delegated with next once a downstream client exists and the grace elapsed', async t => {
  const harness = harnessFor(t, { items: [baselineItem('s1', false, 5)], attached: true, waterfallGraceMs: 0 })
  await connect(harness)
  harness.sockets.sockets[0].emitItem('events', {
    type: 'waterfall', event: 'user-questions/request', eventId: 'w2', agentId: 's1', request: { question: 'x' },
  })
  await settle()
  const resultCalls = harness.calls.calls.filter(entry => entry.method === '$events/result')
  assert.equal(resultCalls.length, 1)
  assert.deepEqual(resultCalls[0].payload, {
    args: { clientId: 'mux-client-1', eventId: 'w2', outcome: { kind: 'next' } },
  })
  harness.sockets.sockets[0].emitItem('events', { type: 'cancel', eventId: 'w2' })
  await settle()
  assert.equal(harness.store.snapshotFor(null, 'sse', harness.observer.hostInfo()).sessions[0].pendingKind, null)
})

test('the grace window is honoured: no delegation before waterfallGraceMs', async t => {
  const harness = harnessFor(t, { items: [baselineItem('s1', false, 5)], attached: true, waterfallGraceMs: 120 })
  await connect(harness)
  harness.sockets.sockets[0].emitItem('events', {
    type: 'waterfall', event: 'approval/request', eventId: 'w3', agentId: 's1', request: {},
  })
  harness.observer.kick('tick')
  await settle()
  assert.equal(harness.calls.calls.some(entry => entry.method === '$events/result'), false)
  // The mux grace timer is a real timer (120 ms here). A fixed 200 ms sleep
  // races it under load (observed flake, 2026-12): poll for the delegation
  // instead. The assertions are unchanged — none before the window, exactly one
  // after it.
  // 5 s, not 1 s: the mux grace timer is real and the suite runs its files
  // concurrently, so a loaded machine can push the first tick past a tighter
  // deadline (observed flake). A genuinely stuck observer still fails here.
  const deadline = Date.now() + 5_000
  let resultCalls: typeof harness.calls.calls = []
  do {
    await delay(20)
    resultCalls = harness.calls.calls.filter(entry => entry.method === '$events/result')
  } while (resultCalls.length === 0 && Date.now() < deadline)
  assert.equal(resultCalls.length, 1, 'the mux grace timer delegates after the window')
  assert.equal((resultCalls[0].payload as { args: { eventId: string } }).args.eventId, 'w3')
})

// ---------------------------------------------------------------------------
// Poll-mode cadence (R18/R20)
// ---------------------------------------------------------------------------

test('poll mode owns the unary baseline cadence while $events never becomes ready (R18)', async t => {
  const harness = harnessFor(t, { items: [baselineItem('s1', false, 5)], tickMs: 10, pollMs: 20 })
  harness.observer.start()
  harness.sockets.sockets[0].emitOpen() // socket open, ready frame never arrives
  await delay(70)
  assert.equal(harness.observer.status().mode, 'poll')
  assert.equal(harness.calls.calls.filter(entry => entry.method === 'session/list').length >= 1, true,
    'the observer polls session/list while the event stream is unavailable')
  assert.equal(harness.store.snapshotFor(null, 'poll', harness.observer.hostInfo()).sessions.length, 1)
})

test('a poll-mode running edge degrades to unknown instead of fabricating unread (R20)', async t => {
  const stateDir = scratch(t)
  const seed = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  seed.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  await seed.flush()
  seed.dispose()
  const harness = harnessFor(t, { stateDir, items: [baselineItem('s1', false, 5)], tickMs: 10, pollMs: 15 })
  harness.observer.start()
  harness.sockets.sockets[0].emitOpen()
  await delay(70)
  const row = harness.store.snapshotFor(null, 'poll', harness.observer.hostInfo()).sessions[0]
  assert.equal(row.running, false)
  assert.equal(row.completedAt, null, 'no completion classification without a session/follow carrier')
  assert.equal(followFrames(harness).length, 0)
  assert.equal(harness.observer.status().degraded, true)
})

// ---------------------------------------------------------------------------
// R21 event silence
// ---------------------------------------------------------------------------

test('event silence triggers a resubscribe and a fresh baseline (R21)', async t => {
  const harness = harnessFor(t, { items: [baselineItem('s1', false, 5)], silenceTimeoutMs: 40 })
  await connect(harness)
  assert.equal(harness.sockets.sockets.length, 1)
  await delay(120)
  assert.equal(harness.sockets.sockets.length >= 2, true, 'silence resubscribes')
  assert.equal(harness.observer.status().degraded, true)
  assert.equal(harness.observer.status().ready, false, 'the new socket has not seen a ready frame yet')
  // The resubscribed socket reconciles a full baseline on its own ready frame.
  const second = harness.sockets.sockets[1]
  second.emitOpen()
  second.emitItem('events', { type: 'ready', clientId: 'mux-client-2' })
  await settle()
  assert.equal(harness.calls.calls.filter(entry => entry.method === 'session/list').length >= 2, true,
    'full reconciliation on every (re)connect')
})
