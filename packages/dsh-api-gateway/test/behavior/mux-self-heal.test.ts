/**
 * Behavioural coverage for the mux's own recovery (chamber fork, design 14 §D4,
 * 2026-09).
 *
 * WHY THIS FILE EXISTS. The connection lane's generation source is the $events
 * logical stream ON THIS MUX, so when the lane is parked (browser offline, or
 * between attempts) the mux must heal itself — and a single throttled attempt is
 * not enough: a socket that opens and dies inside the interval, or a replacement
 * connect that fails before opening, would park the mux (and every session) with
 * no error edge. The 2026-09 independent review proved that with its own fake
 * socket harness while every suite stayed green, so this suite drives the REAL
 * `RemoteStreamMuxClient` through a fake WebSocket and asserts the recovery.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RemoteStreamMuxClient } from '../../src/client/stream-client.ts'

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeSocket[] = []

  readyState: number = FakeSocket.CONNECTING
  readonly sent: string[] = []
  #listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener as (event: unknown) => void)
    this.#listeners.set(type, list)
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    const list = this.#listeners.get(type)
    if (list === undefined) return
    this.#listeners.set(type, list.filter(entry => entry !== listener))
  }

  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('FakeSocket.send on a non-open socket')
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
  }

  /** Test helper: complete the handshake. */
  openNow(): void {
    this.readyState = FakeSocket.OPEN
    this.#dispatch('open')
  }

  /** Test helper: the Host delivers one frame on this socket (any frame is liveness evidence). */
  deliverNow(): void {
    this.#dispatch('message', { type: 'message', data: JSON.stringify({ type: 'item', streamId: 'liveness', value: {} }) })
  }

  /** Test helper: the socket dies after a successful handshake. */
  dieNow(): void {
    this.readyState = FakeSocket.CLOSED
    this.#dispatch('close')
  }

  /** Test helper: the socket fails BEFORE opening. */
  failNow(): void {
    this.readyState = FakeSocket.CLOSED
    this.#dispatch('error')
    this.#dispatch('close')
  }

  #dispatch(type: string, event: unknown = { type }): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event)
  }
}

const installFakeSocket = (): void => {
  FakeSocket.instances = []
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket
  ;(globalThis as { location?: unknown }).location = { origin: 'http://127.0.0.1:17500' }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

async function poll(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return predicate()
}

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 50; index++) await Promise.resolve()
}

test('a socket that dies inside the heal interval is still replaced', async () => {
  installFakeSocket()
  const client = new RemoteStreamMuxClient()
  client.start()
  assert.ok(await poll(() => FakeSocket.instances.length === 1, 1_000), 'the first attempt must start')
  FakeSocket.instances[0].openNow()
  // The death lands well inside REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS: a one-shot
  // throttle would drop the heal entirely and park the mux (2026-09 BLOCKER).
  await sleep(20)
  FakeSocket.instances[0].dieNow()
  assert.ok(await poll(() => FakeSocket.instances.length >= 2, 2_500), 'the mux must reschedule its own reconnect')
  await client.close()
})

test('a reconnect that fails before opening is retried', async () => {
  installFakeSocket()
  const client = new RemoteStreamMuxClient()
  client.start()
  assert.ok(await poll(() => FakeSocket.instances.length === 1, 1_000))
  FakeSocket.instances[0].openNow()
  await sleep(20)
  FakeSocket.instances[0].dieNow()
  assert.ok(await poll(() => FakeSocket.instances.length === 2, 2_500), 'the heal attempt must start')
  FakeSocket.instances[1].failNow()
  assert.ok(await poll(() => FakeSocket.instances.length >= 3, 4_000), 'a failed attempt must not end the recovery')
  await client.close()
})

test('close disposes the mux and stops the self-heal', async () => {
  installFakeSocket()
  const client = new RemoteStreamMuxClient()
  client.start()
  assert.ok(await poll(() => FakeSocket.instances.length === 1, 1_000))
  FakeSocket.instances[0].openNow()
  await sleep(20)
  FakeSocket.instances[0].dieNow()
  await client.close()
  await sleep(1_500)
  assert.equal(FakeSocket.instances.length, 1, 'a disposed mux must not keep reconnecting')
})

test('a handshake that never settles is abandoned on its own deadline', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = new RemoteStreamMuxClient()
  client.start()
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 1)
  const iterator = client.open('$events', { args: {} }, new AbortController().signal)
  const pending = iterator.next()
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 1)
  // The socket never fires open/error/close. Without a handshake deadline the
  // waiting stream would park until the connection lane's readiness timeout
  // (15 s/45 s) — and no carrier error would ever reach its retry lane.
  t.mock.timers.tick(30_000)
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === 'RemoteStreamCarrierError',
  )
  await client.close()
  t.mock.timers.reset()
})

test('a lane-commanded reconnect does not widen the mux heal cadence', async () => {
  installFakeSocket()
  const client = new RemoteStreamMuxClient()
  client.start()
  assert.ok(await poll(() => FakeSocket.instances.length === 1, 1_000))
  // The connection lane restarts the socket while the FIRST attempt is still
  // connecting: that cancellation is not a connect failure (2026-09 review).
  client.reconnect()
  assert.ok(await poll(() => FakeSocket.instances.length === 2, 1_000), 'reconnect must start a fresh attempt')
  const failedAt = Date.now()
  FakeSocket.instances[1].failNow()
  assert.ok(await poll(() => FakeSocket.instances.length >= 3, 6_000), 'a genuine failure must be retried')
  const waited = Date.now() - failedAt
  // Base 1 s; ONE genuine failure doubles to 2 s. If the cancelled attempt had
  // also widened (the pre-fix shape), this would be ~4 s.
  assert.ok(waited < 3_500, 'the cancelled attempt must not widen the cadence (waited ' + String(waited) + 'ms)')
  await client.close()
})

test('a synchronous socket construction failure still recovers', async () => {
  installFakeSocket()
  let attempts = 0
  class ThrowingSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    constructor() {
      attempts += 1
      throw new Error('constructor refused')
    }
  }
  ;(globalThis as { WebSocket?: unknown }).WebSocket = ThrowingSocket
  const client = new RemoteStreamMuxClient()
  // A constructor throw must not escape into the caller (an uncaught throw inside
  // the heal timer would kill recovery silently) and must still schedule retries.
  assert.doesNotThrow(() => { client.start() }, 'a construction failure must not escape the mux')
  assert.ok(await poll(() => attempts >= 2, 4_000), 'recovery must keep retrying after a construction failure')
  await client.close()
})

test('a silent socket is REPLACED when an opening item times out on it', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const facts: Array<{ kind: string; cause: string }> = []
  const client = new RemoteStreamMuxClient('', (kind, cause) => { facts.push({ kind, cause }) })
  client.start()
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 1)
  FakeSocket.instances[0].openNow()
  await flushMicrotasks()
  const iterator = client.open('session/follow', { args: {} }, new AbortController().signal)
  const pending = iterator.next()
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 1, 'no replacement happens before the deadline')
  t.mock.timers.tick(30_000)
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === 'RemoteStreamCarrierError',
  )
  // Re-issuing the request is only a cure while the socket still delivers: a socket
  // that stayed silent through the whole window is dead, so the mux must drop it and
  // start a fresh attempt (the old behaviour re-issued on the same socket forever,
  // which is exactly the permanent chat.loadingHistory state).
  assert.equal(FakeSocket.instances.length, 2, 'the silent socket must be replaced at once')
  assert.equal(FakeSocket.instances[0].readyState, FakeSocket.CLOSED)
  assert.deepEqual(facts.map(fact => fact.kind), ['opening-timeout', 'socket-silent'])
  await client.close()
  t.mock.timers.reset()
})

test('a logical stream torn down on a socket that never delivered a frame replaces it', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const facts: Array<{ kind: string; cause: string }> = []
  const client = new RemoteStreamMuxClient('', (kind, cause) => { facts.push({ kind, cause }) })
  client.start()
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 1)
  FakeSocket.instances[0].openNow()
  await flushMicrotasks()
  const controller = new AbortController()
  const iterator = client.open('session/follow', { args: {} }, controller.signal)
  const pending = iterator.next()
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 1, 'nothing is replaced while the stream is live')
  // The journal watchdog aborts its sibling follow at 20 s — BEFORE the 30 s opening
  // budget can fire — so that abort is the only teardown signal this attempt gets.
  // A socket that delivered nothing for the whole life of the stream is dead even
  // though no opening deadline ever expired; the teardown must escalate it exactly
  // like the deadline path does, or an already-open session keeps a dead carrier
  // until the transport watchdog (http ~120 s / ssh ~300 s) notices.
  t.mock.timers.tick(20_000)
  controller.abort(new Error('sibling probe gave up'))
  await pending.then(
    () => { throw new Error('the torn-down stream must reject') },
    () => undefined,
  )
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 2, 'the silent socket must be replaced on teardown')
  assert.equal(FakeSocket.instances[0].readyState, FakeSocket.CLOSED)
  assert.deepEqual(facts.map(fact => fact.kind), ['socket-silent'])
  await client.close()
  t.mock.timers.reset()
})
test('a socket that delivered a frame keeps the request retry instead of being replaced', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = new RemoteStreamMuxClient()
  client.start()
  await flushMicrotasks()
  FakeSocket.instances[0].openNow()
  await flushMicrotasks()
  const iterator = client.open('session/follow', { args: {} }, new AbortController().signal)
  const pending = iterator.next()
  await flushMicrotasks()
  assert.ok(
    FakeSocket.instances[0].sent.some(frame => frame.includes('"type":"open"')),
    'the open frame must reach the socket before its liveness is judged',
  )
  // The socket proves it is alive mid-window (any frame, addressed to any stream).
  FakeSocket.instances[0].deliverNow()
  t.mock.timers.tick(30_000)
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === 'RemoteStreamCarrierError',
  )
  assert.equal(
    FakeSocket.instances.length,
    1,
    'a live socket is retried (and keeps its widening) — a slow Host is never interrupted',
  )
  await client.close()
  t.mock.timers.reset()
})

test('an unanswered stream open fails as a carrier error once the deadline fires', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = new RemoteStreamMuxClient()
  client.start()
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 1)
  FakeSocket.instances[0].openNow()
  await flushMicrotasks()
  const iterator = client.open('$events', { args: {} }, new AbortController().signal)
  const pending = iterator.next()
  await flushMicrotasks()
  assert.ok(
    FakeSocket.instances[0].sent.some(frame => frame.includes('"type":"open"')),
    'the open frame must reach the socket',
  )
  t.mock.timers.tick(30_000)
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === 'RemoteStreamCarrierError',
  )
  await client.close()
  t.mock.timers.reset()
})
