/**
 * session-mux.ts unit tests (plan of record
 * docs/progress/todo/remote-session-state-and-switch.md §4/W1; blueprints
 * gateway-session-state-blueprint.md §3.2/§5.1/§5.4/§8-3 and
 * remote-state-w0-protocol.md §3): mux framing, the per-connection full
 * baseline reconciliation, emit routing, the waterfall delegate-hold hard rule
 * (never answer unless another downstream mux client is attached AND the 1.5s
 * grace elapsed), reconnect backoff, the one-shot session/follow completion
 * read, and the R21 ready/lastEventAt silence signal.
 *
 * The suite injects a fake socket and a fake unary carrier — it never loads
 * `ws` and needs no node_modules.
 *
 * Run directly: node packages/control-plane/test/protocol/session-mux.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildSessionFollowPayload,
  createSessionMux,
  EVENTS_STREAM_ID,
  muxReconnectDelayMs,
  muxUrlFor,
  parseMuxServerFrame,
  parseRemoteEventFrame,
  parseSessionListBaselineItems,
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_EVENT_STREAM_PAYLOAD,
  REMOTE_STREAM_MUX_PATH,
  type MuxSocket,
  type MuxSocketReadyState,
  type MuxUnaryCall,
  type MuxUnaryResult,
  type SessionListBaselineItem,
  type SessionMux,
  type SessionMuxStatus,
} from '../../src/session-mux.ts'
import { classifyTurnEnd, type SessionStatePendingKind } from '../../src/session-state-protocol.ts'

const wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })
const flush = async () => { await wait(0); await wait(0) }

/** Poll until a predicate holds (bounded), so timer tests are not flaky. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('session-mux test: condition not reached before the deadline')
    await wait(2)
  }
}

class FakeSocket implements MuxSocket {
  readyState: MuxSocketReadyState = 'connecting'
  readonly sent: string[] = []
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = []
  readonly url: string
  readonly cookie: string | undefined
  private readonly openListeners = new Set<() => void>()
  private readonly messageListeners = new Set<(text: string) => void>()
  private readonly closeListeners = new Set<(info: { code: number; reason: string }) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()

  constructor(url: string, cookie: string | undefined) {
    this.url = url
    this.cookie = cookie
  }

  open(): void {
    if (this.readyState !== 'connecting') return
    this.readyState = 'open'
    for (const listener of [...this.openListeners]) listener()
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.serverClose(code ?? 1000, reason ?? '')
  }

  /** Remote end closes without a local close() call. */
  serverClose(code = 1006, reason = ''): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    for (const listener of [...this.closeListeners]) listener({ code, reason })
  }

  deliver(value: unknown, streamId = EVENTS_STREAM_ID): void {
    this.deliverText(JSON.stringify({ type: 'item', streamId, value }))
  }

  deliverFrame(frame: unknown): void {
    this.deliverText(JSON.stringify(frame))
  }

  deliverText(text: string): void {
    for (const listener of [...this.messageListeners]) listener(text)
  }

  frames(): any[] {
    return this.sent.map(text => JSON.parse(text) as unknown)
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener)
    return () => { this.openListeners.delete(listener) }
  }

  onMessage(listener: (text: string) => void): () => void {
    this.messageListeners.add(listener)
    return () => { this.messageListeners.delete(listener) }
  }

  onClose(listener: (info: { code: number; reason: string }) => void): () => void {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

interface RecordedCall { baseUrl: string; method: string; payload: unknown }

interface Harness {
  mux: SessionMux
  sockets: FakeSocket[]
  calls: RecordedCall[]
  order: string[]
  baselines: Array<{ items: readonly SessionListBaselineItem[]; at: number; reason: string }>
  statuses: Array<{ sessionId: string; running: boolean; at: number }>
  activities: Array<{ sessionId: string; updatedAt: number | null; at: number }>
  added: Array<{ item: SessionListBaselineItem; at: number }>
  removed: Array<{ sessionId: string; at: number }>
  pending: Array<{ sessionId: string; kind: SessionStatePendingKind; eventId: string; at: number }>
  cancels: string[]
  silences: number[]
  warnings: string[]
  statusChanges: SessionMuxStatus[]
  results: RecordedCall[]
  setAttached(value: boolean): void
}

function makeHarness(options: {
  baseUrl?: string | null
  attached?: boolean
  items?: unknown[]
  callImpl?: MuxUnaryCall
  graceMs?: number
  now?: () => number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  handshakeTimeoutMs?: number
  silenceTimeoutMs?: number
  followTimeoutMs?: number
} = {}): Harness {
  const sockets: FakeSocket[] = []
  const calls: RecordedCall[] = []
  const order: string[] = []
  const baselines: Harness['baselines'] = []
  const statuses: Harness['statuses'] = []
  const activities: Harness['activities'] = []
  const added: Harness['added'] = []
  const removed: Harness['removed'] = []
  const pending: Harness['pending'] = []
  const cancels: string[] = []
  const silences: number[] = []
  const warnings: string[] = []
  const statusChanges: SessionMuxStatus[] = []
  const results: RecordedCall[] = []
  let base = options.baseUrl === undefined ? 'http://127.0.0.1:17510' : options.baseUrl
  let attached = options.attached ?? false

  const carrier: MuxUnaryCall = async (baseUrl, method, payload) => {
    const record: RecordedCall = { baseUrl, method, payload }
    calls.push(record)
    if (method === REMOTE_EVENT_RESULT_ENDPOINT) results.push(record)
    if (options.callImpl !== undefined) return await options.callImpl(baseUrl, method, payload)
    return { result: { ok: true, value: { items: options.items ?? [] } } }
  }

  const mux = createSessionMux({
    getBaseUrl: () => base,
    authCookieFor: () => 'browser-auth=test-cookie',
    call: carrier,
    otherMuxClientsAttached: () => attached,
    onBaseline: (items, info) => { order.push('baseline'); baselines.push({ items, at: info.at, reason: info.reason }) },
    onBaselineError: () => { order.push('baseline-error') },
    onStatus: (sessionId, running, at) => { order.push('status'); statuses.push({ sessionId, running, at }) },
    onActivity: (sessionId, updatedAt, at) => { order.push('activity'); activities.push({ sessionId, updatedAt, at }) },
    onAdded: (item, at) => { order.push('added'); added.push({ item, at }) },
    onRemoved: (sessionId, at) => { order.push('removed'); removed.push({ sessionId, at }) },
    onPending: (sessionId, kind, eventId, at) => { order.push('pending'); pending.push({ sessionId, kind, eventId, at }) },
    onCancel: (eventId) => { order.push('cancel'); cancels.push(eventId) },
    onStatusChange: (status) => { statusChanges.push(status) },
    onSilence: (at) => { silences.push(at) },
    onWarn: (message) => { warnings.push(message) },
    openSocket: (url, openOptions) => {
      const socket = new FakeSocket(url, openOptions.cookie)
      sockets.push(socket)
      return socket
    },
    waterfallGraceMs: options.graceMs ?? 5,
    ...(options.now === undefined ? {} : { now: options.now }),
    reconnectMinMs: options.reconnectMinMs ?? 5,
    reconnectMaxMs: options.reconnectMaxMs ?? 10,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 0,
    ...(options.silenceTimeoutMs === undefined ? {} : { silenceTimeoutMs: options.silenceTimeoutMs }),
    followTimeoutMs: options.followTimeoutMs ?? 50,
  })

  return {
    mux, sockets, calls, order, baselines, statuses, activities, added, removed, pending,
    cancels, silences, warnings, statusChanges, results,
    setAttached: (value: boolean) => { attached = value },
  }
}

/** start → socket open → ready frame → one full baseline. */
async function startSession(h: Harness, clientId = 'client-1'): Promise<void> {
  h.mux.start()
  h.sockets[0].open()
  h.sockets[0].deliver({ type: 'ready', clientId, host: { home: '/home/user' } })
  await flush()
}

const waterfallFrame = (eventId = 'e1', event = 'approval/request') => ({
  type: 'waterfall', event, eventId, agentId: 's1', request: { tool: 'SECRET-REQUEST-PAYLOAD' },
})

// ---------------------------------------------------------------------------
// 帧 / 常量 lockstep
// ---------------------------------------------------------------------------

test('mux protocol constants stay in lockstep with the api-gateway stream-protocol source', () => {
  const source = readFileSync(new URL('../../../dsh-api-gateway/src/stream-protocol.ts', import.meta.url), 'utf8')
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const [name, value] of [
    ['REMOTE_STREAM_MUX_PATH', REMOTE_STREAM_MUX_PATH],
    ['REMOTE_EVENT_STREAM_ENDPOINT', REMOTE_EVENT_STREAM_ENDPOINT],
    ['REMOTE_EVENT_RESULT_ENDPOINT', REMOTE_EVENT_RESULT_ENDPOINT],
  ] as const) {
    assert.match(source, new RegExp(`export const ${name}\\s*=\\s*'${escape(value)}'`))
  }
  assert.match(source, /export const REMOTE_EVENT_STREAM_PAYLOAD\s*=\s*\{\s*args:\s*\{\}\s*\}\s*as const/)
  assert.equal(REMOTE_STREAM_MUX_PATH, '/api/remote.mux')
  assert.equal(REMOTE_EVENT_STREAM_ENDPOINT, '$events')
  assert.equal(REMOTE_EVENT_RESULT_ENDPOINT, '$events/result')
  assert.deepEqual(REMOTE_EVENT_STREAM_PAYLOAD, { args: {} })
  assert.equal(muxUrlFor('http://127.0.0.1:17510'), 'ws://127.0.0.1:17510/api/remote.mux')
  assert.equal(muxUrlFor('https://gateway.example/'), 'wss://gateway.example/api/remote.mux')
  assert.equal(muxUrlFor('http://127.0.0.1:17510/a/b'), 'ws://127.0.0.1:17510/api/remote.mux')
})

test('parseMuxServerFrame: item/end/error accepted, malformed frames rejected', () => {
  assert.deepEqual(parseMuxServerFrame('{"type":"end","streamId":"events"}'), { type: 'end', streamId: 'events' })
  assert.deepEqual(parseMuxServerFrame('{"type":"item","streamId":"events","value":{"type":"ready","clientId":"c"}}'), {
    type: 'item', streamId: 'events', value: { type: 'ready', clientId: 'c' },
  })
  assert.deepEqual(parseMuxServerFrame('{"type":"item","streamId":"events"}'), { type: 'item', streamId: 'events' })
  assert.deepEqual(parseMuxServerFrame('{"type":"error","streamId":"s","error":{"code":"gateway/arguments-invalid"}}'), {
    type: 'error', streamId: 's', error: { code: 'gateway/arguments-invalid' },
  })
  for (const text of ['not json', '[]', '{"type":"item"}', '{"streamId":"events"}', '{"type":"wat","streamId":"x"}']) {
    assert.equal(parseMuxServerFrame(text), null, text)
  }
})

test('parseRemoteEventFrame: known frames parsed strictly, waterfall request dropped', () => {
  assert.deepEqual(parseRemoteEventFrame({ type: 'ready', clientId: 'c1' }), { type: 'ready', clientId: 'c1' })
  assert.deepEqual(parseRemoteEventFrame({ type: 'emit', event: 'api-session/status', args: ['s', true] }), {
    type: 'emit', event: 'api-session/status', args: ['s', true],
  })
  const waterfall = parseRemoteEventFrame({
    type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 's1', request: { tool: 'SECRET' },
  })
  assert.deepEqual(waterfall, { type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 's1' })
  assert.equal(Object.hasOwn(waterfall as object, 'request'), false)
  assert.deepEqual(parseRemoteEventFrame({ type: 'cancel', eventId: 'e1' }), { type: 'cancel', eventId: 'e1' })
  assert.deepEqual(parseRemoteEventFrame({ type: 'future-frame', payload: 1 }), { type: 'unknown' })
  assert.equal(parseRemoteEventFrame('nope'), null)
})

test('parseSessionListBaselineItems: privacy whitelist projection', () => {
  const items = parseSessionListBaselineItems({
    items: [
      {
        sessionId: 's1', running: true, updatedAt: 42,
        title: 'SECRET TITLE', cwd: '/private', agentPreset: 'x',
        projections: { values: { todos: ['SECRET'] } },
        parent: 'p1', origin: 'subagent',
      },
      { sessionId: 's2', running: false, updatedAt: 7, parentSessionId: 'p2' },
      { sessionId: '', running: true },
      'junk',
    ],
  })
  assert.deepEqual(items, [
    { sessionId: 's1', running: true, updatedAt: 42, parentSessionId: 'p1', origin: 'subagent' },
    { sessionId: 's2', running: false, updatedAt: 7, parentSessionId: 'p2', origin: null },
  ])
  assert.deepEqual(Object.keys(items[0]), ['sessionId', 'running', 'updatedAt', 'parentSessionId', 'origin'])
  assert.deepEqual(parseSessionListBaselineItems({ nope: true }), [])
})

// ---------------------------------------------------------------------------
// 连接 / 基线
// ---------------------------------------------------------------------------

test('start sends exactly one $events open frame, then a full baseline on ready', async () => {
  const h = makeHarness({
    items: [{ sessionId: 's1', running: true, updatedAt: 10, title: 'SECRET TITLE', cwd: '/private' }],
  })
  h.mux.start()
  assert.equal(h.sockets.length, 1)
  assert.equal(h.sockets[0].cookie, 'browser-auth=test-cookie')
  // The injected opener receives the BASE URL; only the real ws opener
  // converts it (muxUrlFor), pinned in the lockstep test above.
  assert.equal(h.sockets[0].url, 'http://127.0.0.1:17510')
  assert.deepEqual(h.sockets[0].frames(), [])
  h.sockets[0].open()
  assert.deepEqual(h.sockets[0].frames(), [
    { type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } },
  ])
  h.sockets[0].deliver({ type: 'ready', clientId: 'client-1', host: { home: '/home/user' } })
  await flush()
  assert.deepEqual(h.calls.map(call => call.method), ['session/list'])
  assert.deepEqual(h.calls[0].payload, { args: { _request: {} } })
  assert.deepEqual(h.baselines.map(baseline => baseline.reason), ['connect'])
  assert.deepEqual(h.baselines[0].items, [
    { sessionId: 's1', running: true, updatedAt: 10, parentSessionId: null, origin: null },
  ])
  const status = h.mux.status()
  assert.equal(status.state, 'live')
  assert.equal(status.ready, true)
  assert.equal(status.clientId, 'client-1')
  assert.equal(status.baselineOk, true)
  assert.equal(typeof status.lastEventAt, 'number')
  assert.equal(typeof status.lastReadyAt, 'number')
  h.mux.stop()
})

test('frames arriving during the baseline are queued and applied after it (snapshot+replay)', async () => {
  const gate = deferred<MuxUnaryResult>()
  const h = makeHarness({
    callImpl: async (_baseUrl, method) => method === 'session/list'
      ? await gate.promise
      : { result: { ok: true, value: {} } },
  })
  h.mux.start()
  h.sockets[0].open()
  h.sockets[0].deliver({ type: 'ready', clientId: 'client-1' })
  h.sockets[0].deliver({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
  await flush()
  assert.deepEqual(h.order, [])
  gate.resolve({ result: { ok: true, value: { items: [{ sessionId: 's1', running: false, updatedAt: 1 }] } } })
  await until(() => h.order.length === 2)
  assert.deepEqual(h.order, ['baseline', 'status'])
  assert.deepEqual(h.statuses, [{ sessionId: 's1', running: true, at: h.statuses[0].at }])
  assert.equal(h.baselines[0].items[0].running, false)
  h.mux.stop()
})

test('emit routing: status/activity/added/removed routed, error text and unknown events dropped', async () => {
  const h = makeHarness()
  await startSession(h)
  h.sockets[0].deliver({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
  h.sockets[0].deliver({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
  h.sockets[0].deliver({ type: 'emit', event: 'api-session/activity', args: ['s1', 1234] })
  h.sockets[0].deliver({
    type: 'emit', event: 'api-session/added',
    args: [{ sessionId: 's2', running: false, updatedAt: 9, title: 'SECRET' }],
  })
  h.sockets[0].deliver({ type: 'emit', event: 'api-session/removed', args: ['s3'] })
  h.sockets[0].deliver({ type: 'emit', event: 'api-session/error', args: ['s1', { message: 'SECRET-ERROR-CHAIN' }] })
  h.sockets[0].deliver({ type: 'emit', event: 'credentials/reference-updated', args: [{ token: 'SECRET-TOKEN' }] })
  h.sockets[0].deliver({ type: 'emit', event: 'api-session/status', args: ['s1', 'not-a-boolean'] })
  await flush()
  assert.deepEqual(h.statuses.map(entry => [entry.sessionId, entry.running]), [['s1', true], ['s1', false]])
  assert.deepEqual(h.activities.map(entry => [entry.sessionId, entry.updatedAt]), [['s1', 1234]])
  assert.deepEqual(h.added.map(entry => entry.item), [
    { sessionId: 's2', running: false, updatedAt: 9, parentSessionId: null, origin: null },
  ])
  assert.deepEqual(h.removed.map(entry => entry.sessionId), ['s3'])
  assert.equal(JSON.stringify([h.warnings, h.order, h.statuses, h.activities]).includes('SECRET'), false)
  h.mux.stop()
})

test('baseline failure surfaces onBaselineError and never fabricates rows', async () => {
  const h = makeHarness({
    callImpl: async (_baseUrl, method) => {
      if (method === 'session/list') throw new Error('connection refused')
      return { result: { ok: true, value: {} } }
    },
  })
  h.mux.start()
  h.sockets[0].open()
  h.sockets[0].deliver({ type: 'ready', clientId: 'client-1' })
  await until(() => h.order.includes('baseline-error'))
  assert.deepEqual(h.baselines, [])
  assert.equal(h.mux.status().baselineOk, false)
  assert.match(h.mux.status().lastError ?? '', /session\/list failed/)
  h.mux.stop()
})

// ---------------------------------------------------------------------------
// waterfall 委派（硬约束）
// ---------------------------------------------------------------------------

test('waterfall: held silently while no downstream mux client is attached (never settles)', async () => {
  const h = makeHarness({ attached: false })
  await startSession(h)
  h.sockets[0].deliver(waterfallFrame())
  await wait(30)
  assert.equal(h.results.length, 0)
  assert.equal(h.mux.status().heldWaterfalls, 1)
  assert.deepEqual(h.pending.map(entry => [entry.sessionId, entry.kind, entry.eventId]), [['s1', 'approval', 'e1']])
  assert.equal(JSON.stringify([h.warnings, h.order]).includes('SECRET-REQUEST-PAYLOAD'), false)
  h.mux.stop()
})

test('waterfall: delegates exactly once only when attached AND past the grace window', async () => {
  // The elapsed check reads the injected mux clock while the grace timer is a
  // real timer, so on a slow runner the real timer can cross graceMs before the
  // "inside the window" assertion below is reached (observed flake on the
  // windows leg). Hold the clock still for that assertion, then step it past
  // graceMs here instead of sleeping and hoping.
  let clock = 1_000
  const h = makeHarness({ attached: false, graceMs: 10, now: () => clock })
  await startSession(h)
  h.sockets[0].deliver(waterfallFrame())
  await flush()
  assert.equal(h.results.length, 0)
  // Inside the grace window, even an attached downstream client is not enough.
  h.setAttached(true)
  h.mux.kick('tick')
  await flush()
  assert.equal(h.results.length, 0)
  // Cross the grace window, then trigger the sweep again.
  clock += 10
  h.mux.kick('tick')
  await until(() => h.results.length === 1)
  assert.deepEqual(h.results[0].payload, {
    args: { clientId: 'client-1', eventId: 'e1', outcome: { kind: 'next' } },
  })
  // A replayed frame with the same eventId must not be answered twice.
  h.sockets[0].deliver(waterfallFrame())
  await wait(30)
  h.mux.kick('tick')
  await flush()
  assert.equal(h.results.length, 1)
  h.mux.stop()
})

test('waterfall: user-questions/request maps to the question kind', async () => {
  const h = makeHarness({ attached: false })
  await startSession(h)
  h.sockets[0].deliver(waterfallFrame('q1', 'user-questions/request'))
  await flush()
  assert.deepEqual(h.pending.map(entry => [entry.sessionId, entry.kind, entry.eventId]), [['s1', 'question', 'q1']])
  h.mux.stop()
})

test('waterfall: a cancel frame releases the hold and is never answered afterwards', async () => {
  const h = makeHarness({ attached: true, graceMs: 10 })
  await startSession(h)
  h.sockets[0].deliver(waterfallFrame())
  h.sockets[0].deliver({ type: 'cancel', eventId: 'e1' })
  await wait(30)
  h.mux.kick('tick')
  await flush()
  assert.equal(h.results.length, 0)
  assert.deepEqual(h.cancels, ['e1'])
  assert.equal(h.mux.status().heldWaterfalls, 0)
  h.mux.stop()
})

// ---------------------------------------------------------------------------
// 重连 / R21 静默 / 握手
// ---------------------------------------------------------------------------

test('reconnect backoff is deterministic exponential with a ceiling', () => {
  assert.equal(muxReconnectDelayMs(1, 500, 15_000), 500)
  assert.equal(muxReconnectDelayMs(2, 500, 15_000), 1_000)
  assert.equal(muxReconnectDelayMs(3, 500, 15_000), 2_000)
  assert.equal(muxReconnectDelayMs(10, 500, 15_000), 15_000)
  assert.equal(muxReconnectDelayMs(0, 500, 15_000), 500)
  assert.equal(muxReconnectDelayMs(4, 10, 25), 25)
})

test('a reconnect performs a full baseline again for the new socket generation', async () => {
  const h = makeHarness({ reconnectMinMs: 5, reconnectMaxMs: 10 })
  await startSession(h)
  assert.equal(h.baselines.length, 1)
  h.sockets[0].serverClose(1006, 'network')
  await until(() => h.sockets.length === 2)
  h.sockets[1].open()
  assert.deepEqual(h.sockets[1].frames(), [
    { type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } },
  ])
  h.sockets[1].deliver({ type: 'ready', clientId: 'client-2' })
  await until(() => h.baselines.length === 2)
  assert.equal(h.baselines[1].reason, 'connect')
  assert.equal(h.mux.status().reconnects, 1)
  assert.equal(h.mux.status().clientId, 'client-2')
  h.mux.stop()
})

test('event silence (R21) fires onSilence and resubscribes with a fresh baseline', async () => {
  const h = makeHarness({ silenceTimeoutMs: 10, reconnectMinMs: 5, reconnectMaxMs: 5 })
  await startSession(h)
  await until(() => h.silences.length === 1)
  await until(() => h.sockets.length === 2)
  assert.equal(h.sockets[0].closes.length, 1)
  h.sockets[1].open()
  h.sockets[1].deliver({ type: 'ready', clientId: 'client-2' })
  await until(() => h.baselines.length === 2)
  assert.equal(h.mux.status().ready, true)
  h.mux.stop()
})

test('a ready frame resets the silence clock (activity is not silence)', async () => {
  // 1s, not 25ms: the emits below are real sleeps and a loaded runner can
  // stretch them past a tighter window, firing the silence timer the test means
  // to prove was reset (observed flake on the windows leg).
  const h = makeHarness({ silenceTimeoutMs: 1_000 })
  await startSession(h)
  for (let index = 0; index < 3; index++) {
    await wait(10)
    h.sockets[0].deliver({ type: 'emit', event: 'api-session/status', args: ['s1', index % 2 === 0] })
  }
  assert.deepEqual(h.silences, [])
  h.mux.stop()
})

test('handshake timeout without a ready frame marks events degraded and reconnects', async () => {
  const h = makeHarness({ handshakeTimeoutMs: 10, reconnectMinMs: 5, reconnectMaxMs: 5 })
  h.mux.start()
  h.sockets[0].open()
  await until(() => h.mux.status().eventsDegraded)
  assert.equal(h.mux.status().lastError, 'events-handshake-timeout')
  await until(() => h.sockets.length >= 2)
  h.mux.stop()
})

// ---------------------------------------------------------------------------
// session/follow 一次性完成边沿取数
// ---------------------------------------------------------------------------

test('followTurnEndOnce: exact session/follow payload, tail turn/end, immediate cancel', async () => {
  const h = makeHarness()
  await startSession(h)
  const pendingFact = h.mux.followTurnEndOnce('s1')
  assert.deepEqual(h.sockets[0].frames().at(-1), {
    type: 'open', streamId: 'follow-1', endpoint: 'session/follow', payload: buildSessionFollowPayload('s1'),
  })
  h.sockets[0].deliver({
    type: 'snapshot',
    cursor: 5,
    records: [
      { event: { seq: 8, type: 'assistant/message', data: {} } },
      { event: { seq: 9, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
    ],
  }, 'follow-1')
  const fact = await pendingFact
  assert.equal(fact?.kind, 'completed')
  assert.equal(fact?.cause, null)
  assert.equal(fact?.seq, 9)
  assert.equal(typeof fact?.at, 'number')
  assert.equal(classifyTurnEnd(fact), 'completed')
  assert.deepEqual(h.sockets[0].frames().at(-1), { type: 'cancel', streamId: 'follow-1' })
  h.mux.stop()
})

test('followTurnEndOnce: aborted+user surfaces the cause and classifies as a user stop', async () => {
  const h = makeHarness()
  await startSession(h)
  const pendingFact = h.mux.followTurnEndOnce('s1')
  h.sockets[0].deliver({
    type: 'event',
    event: { seq: 12, type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  }, 'follow-1')
  const fact = await pendingFact
  assert.equal(fact?.kind, 'aborted')
  assert.equal(fact?.cause, 'user')
  assert.equal(classifyTurnEnd(fact), 'user-stopped')
  h.mux.stop()
})

test('followTurnEndOnce: null before ready and null on timeout (no resident follow stream)', async () => {
  const h = makeHarness({ followTimeoutMs: 10 })
  h.mux.start()
  assert.equal(await h.mux.followTurnEndOnce('s1'), null)
  h.sockets[0].open()
  h.sockets[0].deliver({ type: 'ready', clientId: 'client-1' })
  await flush()
  const late = h.mux.followTurnEndOnce('s2')
  const fact = await late
  assert.equal(fact, null)
  assert.equal(h.sockets[0].frames().filter(frame => frame.type === 'open' && frame.streamId === 'follow-1').length, 1)
  h.mux.stop()
})

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

test('no host base URL ⇒ waiting with no socket; host-ready kick connects when it appears', async () => {
  const h = makeHarness({ baseUrl: null })
  h.mux.start()
  assert.equal(h.sockets.length, 0)
  assert.equal(h.mux.status().state, 'waiting')
  h.mux.kick('host-ready')
  assert.equal(h.sockets.length, 0)
  h.mux.stop()
})

test('stop() closes the socket, drops held waterfalls and stops reconnecting', async () => {
  const h = makeHarness({ attached: false })
  await startSession(h)
  h.sockets[0].deliver(waterfallFrame())
  await flush()
  assert.equal(h.mux.status().heldWaterfalls, 1)
  const baselineCount = h.baselines.length
  h.mux.stop()
  assert.equal(h.sockets[0].closes.length, 1)
  assert.equal(h.mux.status().state, 'stopped')
  assert.equal(h.mux.status().heldWaterfalls, 0)
  await wait(30)
  assert.equal(h.sockets.length, 1)
  assert.equal(h.baselines.length, baselineCount)
})
