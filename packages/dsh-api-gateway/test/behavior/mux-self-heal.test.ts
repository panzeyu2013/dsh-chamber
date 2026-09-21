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
import {
  REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS,
  REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS,
  REMOTE_STREAM_OPENING_TIMEOUT_MS,
  REMOTE_STREAM_SILENT_TEARDOWN_MIN_MS,
} from '../../src/client/remote-retry-policy.ts'

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

  /** Test helper: the Host answers one logical stream's open with its opening item. */
  answerNow(streamId: string): void {
    this.#dispatch('message', {
      type: 'message',
      data: JSON.stringify({ type: 'item', streamId, value: { type: 'opened' } }),
    })
  }

  /** Test helper: the streamId of the n-th open frame sent on this socket (0-based). */
  openStreamId(index = 0): string {
    const frame = this.sent.filter(entry => entry.includes('"type":"open"'))[index]
    assert.ok(frame !== undefined, 'the open frame must have reached the socket')
    return (JSON.parse(frame) as { streamId: string }).streamId
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
  // Date is mocked as well: the teardown escalation is bounded by a minimum life, so
  // the 20 s tick below must move the clock that guard reads (2026-09-21 review).
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
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

/** Sentinel for an iterator step that has not settled yet. */
const PENDING = Symbol('pending')

/**
 * Attach a settling observer to one pending iterator step. The outcome is readable
 * after `flushMicrotasks()`; a step that is still parked stays {@link PENDING}, so a
 * broken escalation fails the assertion instead of hanging the suite.
 * @param pending - the pending `iterator.next()` call.
 * @returns the outcome reader.
 */
function observe(pending: Promise<unknown>): { read(): unknown } {
  let outcome: unknown = PENDING
  void pending.then(
    (value) => { outcome = value },
    (error: unknown) => { outcome = error },
  )
  return { read: () => outcome }
}

/** A settled failure, or a hard test failure when the step did not fail at all. */
function asError(outcome: unknown): Error {
  assert.ok(outcome instanceof Error, 'expected the step to fail with an Error')
  return outcome
}

/** The carrier-error message must name the budget the stream was actually given. */
function budgetError(ms: number): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof Error
    && error.name === 'RemoteStreamCarrierError'
    && error.message.includes('within ' + String(ms) + 'ms')
}

// ---------------------------------------------------------------------------
// The teardown escalation's TWO bounds (design 14 §D4, 2026-09). The positive case
// — the journal watchdog's sibling probe aborting at 20 s, before the 30 s opening
// budget — is the test above; these pin the guards that keep the same evidence from
// churning a healthy carrier: a minimum life, and zero frames on the socket.
// ---------------------------------------------------------------------------

test('a stream aborted inside the evidence window never judges the socket', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const facts: Array<{ kind: string; cause: string }> = []
  const client = new RemoteStreamMuxClient('', (kind, cause) => { facts.push({ kind, cause }) })
  client.start()
  await flushMicrotasks()
  FakeSocket.instances[0].openNow()
  await flushMicrotasks()
  const deadline = new AbortController()
  const iterator = client.open('session/follow', { args: {} }, deadline.signal)
  const pending = iterator.next()
  await flushMicrotasks()
  // A consumer that gives up inside the evidence window (a session switch, an
  // aborted unary-style read) must not churn a carrier that may simply be young.
  t.mock.timers.tick(REMOTE_STREAM_SILENT_TEARDOWN_MIN_MS - 1)
  deadline.abort(new Error('consumer gave up'))
  await assert.rejects(pending)
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 1, 'a young stream must not replace the socket')
  assert.deepEqual(facts, [])
  await client.close()
  t.mock.timers.reset()
})

test('a teardown on a socket that delivered a frame in the meantime leaves it alone', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const facts: Array<{ kind: string; cause: string }> = []
  const client = new RemoteStreamMuxClient('', (kind, cause) => { facts.push({ kind, cause }) })
  client.start()
  await flushMicrotasks()
  FakeSocket.instances[0].openNow()
  await flushMicrotasks()
  const deadline = new AbortController()
  const iterator = client.open('session/follow', { args: {} }, deadline.signal)
  const pending = iterator.next()
  await flushMicrotasks()
  // Any frame on the socket — here for another stream — is liveness evidence.
  t.mock.timers.tick(10_000)
  FakeSocket.instances[0].deliverNow()
  t.mock.timers.tick(10_000)
  deadline.abort(new Error('journal stall probe deadline'))
  await assert.rejects(pending)
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 1, 'a socket that served another stream is alive')
  assert.deepEqual(facts, [])
  await client.close()
  t.mock.timers.reset()
})

test('a stream answered with its opening item clears the opening budget key', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const client = new RemoteStreamMuxClient()
  client.start()
  await flushMicrotasks()
  const socket = FakeSocket.instances[0]
  socket.openNow()
  await flushMicrotasks()

  // 1) The first episode earns one widening step (30 s → 60 s) while the socket
  //    stays alive: a frame lands inside the window, so no replacement fires.
  const first = client.open('session/follow', { args: { same: true } }, new AbortController().signal)
  const firstSeen = observe(first.next())
  await flushMicrotasks()
  t.mock.timers.tick(10_000)
  socket.deliverNow()
  t.mock.timers.tick(20_000)
  await flushMicrotasks()
  assert.ok(budgetError(REMOTE_STREAM_OPENING_TIMEOUT_MS)(firstSeen.read()), 'the first episode must time out on the base budget')

  // 2) The SAME request re-issued and answered. The answered stream stays LIVE: a
  //    teardown would clear the key too, so only a live sibling can prove that the
  //    DELIVERED FRAME is what reset it.
  const answered = client.open('session/follow', { args: { same: true } }, new AbortController().signal)
  const answeredSeen = observe(answered.next())
  await flushMicrotasks()
  socket.answerNow(socket.openStreamId(1))
  await flushMicrotasks()
  assert.deepEqual(
    answeredSeen.read(),
    { done: false, value: { type: 'opened' } },
    "the opening item is the stream's first yield",
  )

  // 3) A further stream for that request (a rebuild) starts at the tight base budget
  //    while the answered sibling is STILL live: the widening died with the frame.
  const next = client.open('session/follow', { args: { same: true } }, new AbortController().signal)
  const nextSeen = observe(next.next())
  await flushMicrotasks()
  t.mock.timers.tick(10_000)
  socket.deliverNow()
  t.mock.timers.tick(20_000)
  await flushMicrotasks()
  assert.ok(
    budgetError(REMOTE_STREAM_OPENING_TIMEOUT_MS)(nextSeen.read()),
    'a stream opened beside the answered one must start at the base budget',
  )
  await answered.return(undefined)
  await next.return(undefined)
  await client.close()
  t.mock.timers.reset()
})

test('replacing a silent socket fails EVERY logical stream, not only the timed-out one', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const client = new RemoteStreamMuxClient()
  client.start()
  await flushMicrotasks()
  FakeSocket.instances[0].openNow()
  await flushMicrotasks()
  const first = client.open('session/follow', { args: { a: 1 } }, new AbortController().signal)
  const firstSeen = observe(first.next())
  await flushMicrotasks()
  // The sibling opens 25 s later, so its OWN 30 s deadline cannot fire in the same
  // tick: any failure it observes here can only come from the replacement.
  t.mock.timers.tick(25_000)
  const second = client.open('$events', { args: { b: 2 } }, new AbortController().signal)
  const secondSeen = observe(second.next())
  await flushMicrotasks()
  t.mock.timers.tick(5_000)
  await flushMicrotasks()
  assert.ok(
    budgetError(REMOTE_STREAM_OPENING_TIMEOUT_MS)(firstSeen.read()),
    'the timed-out stream reaches its retry lane',
  )
  const secondError = asError(secondSeen.read())
  assert.equal(secondError.name, 'RemoteStreamCarrierError')
  assert.ok(
    !secondError.message.includes('delivered no opening item'),
    'the sibling was failed BY the replacement, not by its own deadline',
  )
  assert.equal(FakeSocket.instances.length, 2, 'the silent socket is replaced exactly once')
  await client.close()
  t.mock.timers.reset()
})

test('an open frame is refused when the socket was replaced before the send', async () => {
  installFakeSocket()
  const client = new RemoteStreamMuxClient()
  client.start()
  await flushMicrotasks()
  FakeSocket.instances[0].openNow()
  await flushMicrotasks()
  const iterator = client.open('$events', { args: {} }, new AbortController().signal)
  const pending = iterator.next()
  // The waiter already resolved with socket 1; the lane restarts before the
  // continuation runs. RFC 6455 would DISCARD the open frame on a CLOSED socket
  // (only CONNECTING throws), so the guard must turn it into a carrier failure.
  client.reconnect()
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error
      && error.name === 'RemoteStreamCarrierError'
      && error.message.includes('replaced before its open frame'),
  )
  assert.equal(FakeSocket.instances.length, 2, 'the replacement attempt must still start')
  await client.close()
})

test('consecutive genuine failures double the self-heal cadence up to its cap', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const client = new RemoteStreamMuxClient()
  client.start()
  await flushMicrotasks()
  FakeSocket.instances[0].openNow()
  await flushMicrotasks()
  FakeSocket.instances[0].dieNow()
  await flushMicrotasks()
  /**
   * Advance to the next attempt and fail it: the cadence doubles once per genuine
   * failure, so attempt N+1 must start exactly at the expected interval.
   * @param expectedMs - the interval the failed attempt before it earned.
   * @param index - index of the attempt instance that must appear.
   */
  const nextAttempt = async (expectedMs: number, index: number): Promise<void> => {
    t.mock.timers.tick(expectedMs - 1)
    await flushMicrotasks()
    assert.equal(FakeSocket.instances.length, index, 'attempt ' + String(index + 1) + ' must not start before ' + String(expectedMs) + 'ms')
    t.mock.timers.tick(1)
    await flushMicrotasks()
    assert.equal(FakeSocket.instances.length, index + 1, 'attempt ' + String(index + 1) + ' must start after ' + String(expectedMs) + 'ms')
    FakeSocket.instances[index].failNow()
    await flushMicrotasks()
  }
  await nextAttempt(REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS, 1)
  await nextAttempt(REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS * 2, 2)
  await nextAttempt(REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS * 4, 3)
  await nextAttempt(REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS * 8, 4)
  // Doubling stops at the ceiling: 8 s → 16 s would exceed it.
  await nextAttempt(REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS, 5)
  await nextAttempt(REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS, 6)
  await client.close()
  t.mock.timers.reset()
})
