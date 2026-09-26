/**
 * The logical opening's phase machine (F1) - behavioural coverage.
 *
 * WHY THIS FILE EXISTS. A 3.65 MB opening snapshot that reached the page but was never
 * accepted used to leave the session at chat.loadingHistory forever: the reducer cleared
 * the widening ledger when the first FRAME arrived (delivery), not when the consumer
 * ACCEPTED, so the 30/60/120/240/300 s ladder never fired and no verdict existed. This
 * suite drives the REAL mux/RemoteStream pair through a fake socket and clock and pins
 * the phase machine: requested -> sent -> itemReceived -> accepted | failed, a budget
 * that survives carrier replacement, a bounded verdict for an orphaned opening, and a
 * TERMINAL failure once the ladder is spent.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RemoteJournalStream, type RemoteJournalFrame } from '../../src/client/journal-stream.ts'
import { RemoteSnapshotStream } from '../../src/client/snapshot-stream.ts'
import { apply } from '../../src/client/index.ts'
import { STREAM_FORENSICS_EVENT } from '../../src/client/stream-forensics.ts'
import { RemoteStream } from '../../src/client/remote-stream.ts'
import {
  OpeningTicket,
  RemoteStreamGenerationRestart,
  RemoteStreamMuxClient,
  RemoteStreamOpeningBudgetError,
  openingTicketOf,
} from '../../src/client/stream-client.ts'
import { openingBudgetMs, CARRIER_ENV } from '@dsh-chamber/dsh-stream-state'

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

  /** Test helper: the streamId of the last open frame this socket carried. */
  lastOpenStreamId(): string {
    const frames = this.sent.filter(entry => entry.includes('"type":"open"'))
    const frame = JSON.parse(frames[frames.length - 1] ?? '{}') as { streamId?: string }
    assert.equal(typeof frame.streamId, 'string', 'an open frame must have reached this socket')
    return frame.streamId as string
  }

  /** Test helper: deliver one raw Host text frame on this socket. */
  messageNow(text: string): void {
    this.#dispatch('message', { type: 'message', data: text })
  }

  /** Test helper: deliver one item frame for a stream on this socket. */
  itemNow(streamId: string, value: unknown): void {
    this.messageNow(JSON.stringify({ type: 'item', streamId, value }))
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

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 50; index++) await Promise.resolve()
}

interface Fact {
  readonly kind: string
  readonly cause: string
  readonly endpoint?: string | undefined
  readonly streamId?: string | undefined
  readonly waitedMs?: number | undefined
  readonly sessionId?: string | undefined
}

const factRecorder = (facts: Fact[]) =>
  (kind: string, cause: string, detail?: { endpoint?: string; streamId?: string; waitedMs?: number; sessionId?: string }): void => {
    facts.push({ kind, cause, ...detail })
  }

/** The socket the mux must be using right now, opened on demand. */
async function openSocket(): Promise<FakeSocket> {
  await flushMicrotasks()
  const socket = FakeSocket.instances.at(-1)
  assert.ok(socket !== undefined, 'the mux must have started an attempt')
  if (socket.readyState === FakeSocket.CONNECTING) socket.openNow()
  await flushMicrotasks()
  assert.equal(socket.readyState, FakeSocket.OPEN, 'the attempt must be open before the test drives it')
  return socket
}

/** Park the socket while nothing is delivered (the mux retries the whole life of the test). */
function connection() {
  return { generation: { getSnapshot: () => ({ id: 1 }), subscribe: () => () => {} } }
}

/**
 * One logical stream wired EXACTLY like index.ts's openRemoteStream: the ticket the
 * RemoteStream attached to the generation's signal is handed to the mux with the same
 * call, so the consumer's accept() reaches the attempt that delivered its item.
 */
function logicalStream(client: RemoteStreamMuxClient, endpoint: string, payload: unknown): RemoteStream<unknown> {
  return new RemoteStream(connection() as never, {
    name: endpoint,
    open: signal => client.open(endpoint, payload, signal, openingTicketOf(signal)),
    ended: accepted => new Error('ended: ' + String(accepted)),
  })
}

const follow = { args: { request: { address: { kind: 'session', sessionId: 's-phase' } } } }

test('F1/d: a single multi-megabyte opening item is delivered, accepted and never orphaned', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  const socket = await openSocket()
  const stream = logicalStream(client, 'session/follow', follow)
  const iterator = stream[Symbol.asyncIterator]()
  const pending = iterator.next()
  await flushMicrotasks()
  const streamId = socket.lastOpenStreamId()
  const payload = 'x'.repeat(3_200_000)
  socket.itemNow(streamId, { payload })
  const item = await pending
  assert.equal(item.done, false)
  const yielded = item.value as { value: { payload: string }; accept(): void }
  assert.equal(yielded.value.payload.length, 3_200_000, 'the big item must arrive intact')
  yielded.accept()
  const accepted = facts.filter(fact => fact.kind === 'opening-accepted')
  assert.equal(accepted.length, 1, 'accept() is the acceptance observation')
  assert.equal(accepted[0]?.endpoint, 'session/follow')
  assert.equal(accepted[0]?.streamId, streamId)
  assert.equal(accepted[0]?.sessionId, 's-phase', 'best-effort session attribution from the request payload')
  assert.equal(typeof accepted[0]?.waitedMs, 'number')
  // The stream keeps flowing and the disarmed deadline can never orphan it.
  const second = iterator.next()
  await flushMicrotasks()
  socket.itemNow(streamId, { n: 2 })
  const secondItem = (await second).value as { value: unknown }
  assert.deepEqual(secondItem.value, { n: 2 })
  t.mock.timers.tick(openingBudgetMs(0) + 1_000)
  await flushMicrotasks()
  assert.equal(facts.filter(fact => fact.kind === 'opening-orphaned').length, 0)
  await stream.dispose()
  await client.close()
})

test('F1/j: an unaccepted opening is never silently cancelled - the cancel frame follows the EPISODE, not the deadline', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  const socket = await openSocket()
  const ticket = new OpeningTicket()
  const iterator = client.open('session/follow', follow, new AbortController().signal, ticket)
  const pending = iterator.next()
  await flushMicrotasks()
  const streamId = socket.lastOpenStreamId()
  // Delivered but NOT accepted: itemReceived with the deadline still armed.
  socket.itemNow(streamId, { n: 1 })
  await pending
  const cancels = (): string[] => socket.sent.filter(entry => entry.includes('"type":"cancel"'))
  assert.deepEqual(cancels(), [], 'an unaccepted opening must not be cancelled')
  // Waiting INSIDE the budget adds no cancel either: the armed deadline watches this
  // stream (its expiry is a bounded verdict, F1/a) and never tears it down quietly.
  t.mock.timers.tick(openingBudgetMs(0) - 1_000)
  await flushMicrotasks()
  assert.deepEqual(cancels(), [], 'an armed deadline must not cancel the stream it is watching')
  assert.equal(
    facts.filter(fact => fact.kind === 'opening-miss' || fact.kind === 'opening-orphaned' || fact.kind === 'opening-budget-exhausted').length,
    0,
    'no verdict exists before the deadline',
  )
  // The episode ends (consumer departure): exactly then, ONE cancel for THIS stream.
  await iterator.return(undefined as never)
  const after = cancels()
  assert.equal(after.length, 1, 'the episode close is the only cancel')
  assert.deepEqual(JSON.parse(after[0] as string), { type: 'cancel', streamId })
  await client.close()
})
test('F1/l: an accept arriving after the episode closed publishes nothing', async (t) => {
  // acceptOpening's "episode already ended" guard is the ONLY boundary that keeps a dead
  // episode's late accept from publishing `opening-accepted` - the fact the page ledger treats
  // as recovery evidence and retires BOTH terminal facts with. Deleting the guard left the
  // shipped suite green (review finding F1-GUARD), so this case is the discriminator.
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  const socket = await openSocket()
  const ticket = new OpeningTicket()
  const iterator = client.open('session/follow', follow, new AbortController().signal, ticket)
  const pending = iterator.next()
  await flushMicrotasks()
  const streamId = socket.lastOpenStreamId()
  socket.itemNow(streamId, { n: 1 })
  const item = await pending
  assert.equal(item.done, false, 'the opening item is parked at yield')
  // The episode ends FIRST (the consumer abandons its iterator), and only then does the
  // consumer call the stale accept its ticket still holds.
  await iterator.return(undefined as never)
  ticket.accepted()
  await flushMicrotasks()
  assert.equal(
    facts.filter(fact => fact.kind === 'opening-accepted').length,
    0,
    'an accept from a closed episode must not publish an acceptance fact',
  )
  await client.close()
})
test('F1/a: an item the consumer never accepts is orphaned and the spent ladder is TERMINAL', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  await openSocket()
  let terminal: unknown
  let attempts = 0
  for (; attempts < CARRIER_ENV.openingBudgetMaxMisses && terminal === undefined; attempts++) {
    const socket = await openSocket()
    const ticket = new OpeningTicket()
    const iterator = client.open('session/follow', follow, new AbortController().signal, ticket)
    const pending = iterator.next()
    await flushMicrotasks()
    const streamId = socket.lastOpenStreamId()
    // The opening item IS delivered; the consumer simply never accepts it.
    socket.itemNow(streamId, { type: 'opened', payload: 'x'.repeat(64) })
    const item = await pending
    assert.equal(item.done, false)
    const parked = iterator.next()
    // Each non-terminal rung publishes a MISS diagnostic, never a verdict (review finding 1).
    const misses = facts.filter(fact => fact.kind === 'opening-miss').length
    t.mock.timers.tick(openingBudgetMs(misses))
    const outcome = await parked.then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    )
    if ('error' in outcome) {
      const error = outcome.error as Error
      if (error instanceof RemoteStreamOpeningBudgetError) terminal = error
      else assert.equal(error.name, 'RemoteStreamCarrierError', 'a non-terminal miss re-enters the retry lane')
    }
  }
  assert.ok(terminal instanceof RemoteStreamOpeningBudgetError,
    'the budget must end the opening with a terminal failure, never hang')
  assert.match((terminal as Error).message, /opening budget exhausted/)
  const missed = facts.filter(fact => fact.kind === 'opening-miss')
  assert.equal(missed.length, CARRIER_ENV.openingBudgetMaxMisses - 1,
    'every rung BEFORE the terminal is a miss diagnostic, not a verdict')
  assert.equal(missed[0]?.endpoint, 'session/follow')
  assert.equal(missed[0]?.sessionId, 's-phase')
  assert.equal(typeof missed[0]?.waitedMs, 'number')
  const orphaned = facts.filter(fact => fact.kind === 'opening-orphaned')
  assert.equal(orphaned.length, 1, 'only the terminal verdict names the orphan')
  assert.equal(orphaned[0]?.sessionId, 's-phase', 'the verdict carries the best-effort session attribution')
  assert.equal(typeof orphaned[0]?.streamId, 'string')
  const exhausted = facts.filter(fact => fact.kind === 'opening-budget-exhausted')
  assert.equal(exhausted.length, 1, 'the terminal verdict is published exactly once')
  assert.equal(exhausted[0]?.sessionId, 's-phase')
  assert.match(exhausted[0]?.cause ?? '', /streak=/u)
  // A manual reopen after the terminal gets a FRESH ladder: the spent widening was
  // released, so the first expiry lands on rung 0 instead of the maxed-out 300 s rung
  // (which would have made the next verdict terminal immediately).
  await openSocket()
  const reopenedFacts = facts.filter(fact => fact.kind === 'opening-miss').length
  const reopened = client.open('session/follow', follow, new AbortController().signal, new OpeningTicket()).next()
  await flushMicrotasks()
  t.mock.timers.tick(openingBudgetMs(0))
  await assert.rejects(
    reopened,
    (error: unknown) => error instanceof Error
      && error.name === 'RemoteStreamCarrierError'
      && error.message.includes('within ' + String(openingBudgetMs(0)) + 'ms'),
    'the reopened episode arms rung 0, not the spent ladder',
  )
  assert.equal(facts.filter(fact => fact.kind === 'opening-miss').length, reopenedFacts + 1,
    'the reopened episode miss is a diagnostic on rung 0')
  assert.equal(facts.filter(fact => fact.kind === 'opening-budget-exhausted').length, 1,
    'the reopen is a normal episode, not another immediate terminal')
  await client.close()
})

test('F1/f: an accept that arrives after the deadline is inert (no acceptance fact, no retraction)', async (t) => {
  // The generator parks at `yield` (not on the inbox), so a consumer that maps its
  // opening item slowly can call accept() AFTER the deadline published the verdict.
  // Letting that through used to release the successor widening and publish a second,
  // contradictory opening-accepted fact (review finding).
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  const socket = await openSocket()
  const stream = logicalStream(client, 'session/follow', follow)
  const iterator = stream[Symbol.asyncIterator]()
  const pending = iterator.next()
  await flushMicrotasks()
  const streamId = socket.lastOpenStreamId()
  socket.itemNow(streamId, { payload: 'x' })
  const yielded = (await pending).value as { accept(): void }
  // The deadline fires first: one verdict, and the consumer is failed with it.
  t.mock.timers.tick(openingBudgetMs(0) + 1)
  await flushMicrotasks()
  assert.equal(facts.filter(fact => fact.kind === 'opening-miss').length, 1,
    'the expired rung is a miss diagnostic while the retry lane continues')
  assert.equal(facts.filter(fact => fact.kind === 'opening-orphaned').length, 0,
    'one rung is not a verdict: only the spent ladder may name an orphan')
  // The late accept must be inert.
  yielded.accept()
  await flushMicrotasks()
  assert.equal(facts.filter(fact => fact.kind === 'opening-accepted').length, 0,
    'a late accept must not publish an acceptance fact after the deadline')
  assert.equal(facts.filter(fact => fact.kind === 'opening-orphaned').length, 0,
    'and it must not produce a verdict either')
  await stream.dispose()
  await client.close()
})

test('F1/h: a carrier failure already settled the inbox - the stale deadline stays silent', async (t) => {
  // The generator can be parked at `yield` when a socket replacement fails its inbox.
  // Its armed deadline is still running; firing there must not publish an opening
  // verdict for an episode the carrier already failed (review finding 2).
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  const socket = await openSocket()
  const stream = logicalStream(client, 'session/follow', follow)
  const iterator = stream[Symbol.asyncIterator]()
  const pending = iterator.next()
  await flushMicrotasks()
  const streamId = socket.lastOpenStreamId()
  socket.itemNow(streamId, { payload: 'x' })
  const yielded = (await pending).value as { accept(): void }
  assert.ok(yielded !== undefined, 'the item was delivered and is still unaccepted')
  client.reconnect()
  await flushMicrotasks()
  t.mock.timers.tick(openingBudgetMs(0) + 1)
  await flushMicrotasks()
  assert.deepEqual(
    facts.filter(fact => fact.streamId === streamId && fact.kind.startsWith('opening-')),
    [],
    'a carrier-failed episode must not publish an opening verdict from its stale deadline',
  )
  await stream.dispose()
  await client.close()
})

test('F1/i: a bit-silent ladder ends terminally, names a timeout and still replaces the socket', async (t) => {
  // Zero frames on every attempt: the reducer classes each miss as socketNoFrame and
  // replaces the socket. The TERMINAL rung must do the same - otherwise a proven-silent
  // carrier stays for the siblings and each of them burns a fresh ladder (review finding 3).
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  let terminal: unknown
  for (let attempt = 0; attempt < CARRIER_ENV.openingBudgetMaxMisses && terminal === undefined; attempt++) {
    await openSocket()
    const pending = client.open('session/follow', follow, new AbortController().signal, new OpeningTicket()).next()
    await flushMicrotasks()
    const socketsBefore = FakeSocket.instances.length
    t.mock.timers.tick(openingBudgetMs(attempt))
    const outcome = await pending.then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    )
    assert.ok('error' in outcome, 'an unanswered opening always fails its consumer')
    const error = (outcome as { error: Error }).error
    if (error instanceof RemoteStreamOpeningBudgetError) {
      terminal = error
      assert.equal(FakeSocket.instances.length, socketsBefore + 1,
        'the terminal verdict must still replace a socket that never delivered a frame')
    } else {
      assert.equal(error.name, 'RemoteStreamCarrierError', 'a non-terminal miss re-enters the retry lane')
    }
  }
  assert.ok(terminal instanceof RemoteStreamOpeningBudgetError, 'a bit-silent ladder still ends terminally')
  assert.equal(facts.filter(fact => fact.kind === 'opening-timeout').length, 1,
    'the no-frame verdict is named a timeout, not an orphan')
  assert.equal(facts.filter(fact => fact.kind === 'opening-orphaned').length, 0)
  assert.equal(facts.filter(fact => fact.kind === 'opening-budget-exhausted').length, 1)
  assert.equal(facts.filter(fact => fact.kind === 'opening-miss').length, CARRIER_ENV.openingBudgetMaxMisses - 1)
  await client.close()
})

test('F1/b: a teardown before acceptance rejects the consumer instead of parking it', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  const socket = await openSocket()
  const ticket = new OpeningTicket()
  const iterator = client.open('session/follow', follow, new AbortController().signal, ticket)
  const pending = iterator.next()
  await flushMicrotasks()
  assert.ok(socket.sent.some(frame => frame.includes('"type":"open"')), 'the open frame was sent and left unanswered')
  // The connection lane replaces the socket while the opening is still unanswered.
  client.reconnect()
  const outcome = await pending.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  )
  assert.ok('error' in outcome, 'the deferred opening must REJECT, not stay pending forever')
  assert.equal((outcome.error as Error).name, 'RemoteStreamCarrierError')
  assert.equal(facts.filter(fact => fact.kind === 'opening-orphaned').length, 0, 'nothing arrived, so this is not an orphan')
  await client.close()
})

test('F1/b: a socket wait interrupted by disposal rejects instead of parking', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const client = new RemoteStreamMuxClient()
  client.start()
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 1)
  // No socket yet: the open is waiting for the attempt. Disposal must fail the waiter.
  const pending = client.open('session/follow', follow, new AbortController().signal, new OpeningTicket()).next()
  await flushMicrotasks()
  await client.close()
  await assert.rejects(pending, (error: unknown) => error instanceof Error, 'a disposed mux must reject the waiter')
})

test('F1/c: a socket replacement does not reset the opening budget or streak', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  await openSocket()
  // Attempt 1 spends the base rung and times out, earning the 60 s widening.
  const first = client.open('session/follow', follow, new AbortController().signal, new OpeningTicket()).next()
  await flushMicrotasks()
  t.mock.timers.tick(openingBudgetMs(0))
  await assert.rejects(first, (error: unknown) => (error as Error).name === 'RemoteStreamCarrierError')
  // The lane replaces the physical socket BEFORE any acceptance.
  client.reconnect()
  const socket = await openSocket()
  const second = client.open('session/follow', follow, new AbortController().signal, new OpeningTicket()).next()
  await flushMicrotasks()
  assert.equal(FakeSocket.instances.length, 2, 'the replacement attempt is the live socket')
  assert.ok(socket.lastOpenStreamId().length > 0)
  // 30 s on: NOT expired. The earned widening survived the replacement.
  t.mock.timers.tick(openingBudgetMs(0))
  await flushMicrotasks()
  let settled = false
  void second.then(() => { settled = true }, () => { settled = true })
  await flushMicrotasks()
  assert.equal(settled, false, 'a replaced socket may not reset the budget to the base rung')
  t.mock.timers.tick(openingBudgetMs(1) - openingBudgetMs(0))
  await assert.rejects(second, (error: unknown) => error instanceof Error
    && error.name === 'RemoteStreamCarrierError'
    && error.message.includes('within ' + String(openingBudgetMs(1)) + 'ms'),
  'the successor times out on the inherited rung')
  await client.close()
})

test('F1/g: a domain generation restart keeps the spent budget (restart is a carrier teardown)', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  await openSocket()
  // Attempt 1 spends the base rung and times out, earning the 60 s widening.
  const first = client.open('session/follow', follow, new AbortController().signal, new OpeningTicket()).next()
  await flushMicrotasks()
  t.mock.timers.tick(openingBudgetMs(0))
  await assert.rejects(first, (error: unknown) => (error as Error).name === 'RemoteStreamCarrierError')
  // The zero-frame timeout replaced the physical socket; open the replacement before the
  // next attempt so its own deadline (not a handshake window) is what the test drives.
  await openSocket()
  // A DOMAIN restart (RemoteStream.restart: the journal stall watchdog replaced the
  // physical generation) aborts before acceptance. It is a carrier teardown, not a
  // consumer departure, so the earned widening must survive it.
  const controller = new AbortController()
  const interrupted = client.open('session/follow', follow, controller.signal, new OpeningTicket()).next()
  await flushMicrotasks()
  controller.abort(new RemoteStreamGenerationRestart('journal generation restarted'))
  await assert.rejects(interrupted, (error: unknown) => error instanceof Error)
  const successor = client.open('session/follow', follow, new AbortController().signal, new OpeningTicket()).next()
  await flushMicrotasks()
  t.mock.timers.tick(openingBudgetMs(0))
  await flushMicrotasks()
  let settled = false
  void successor.then(() => { settled = true }, () => { settled = true })
  await flushMicrotasks()
  assert.equal(settled, false, 'a domain restart may not reset the budget to the base rung')
  t.mock.timers.tick(openingBudgetMs(1) - openingBudgetMs(0))
  await assert.rejects(successor, (error: unknown) => error instanceof Error
    && error.message.includes('within ' + String(openingBudgetMs(1)) + 'ms'),
  'the successor times out on the inherited rung')
  await client.close()
})

test('F1/e: an accept from a superseded generation never settles the live attempt', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  const socket = await openSocket()
  const stream = logicalStream(client, 'session/follow', follow)
  const iterator = stream[Symbol.asyncIterator]()
  const firstPending = iterator.next()
  await flushMicrotasks()
  const firstStreamId = socket.lastOpenStreamId()
  socket.itemNow(firstStreamId, { generation: 1 })
  const first = await firstPending
  // The generation is replaced before its consumer accepted: the old accept is now stale.
  stream.restart()
  const secondPending = iterator.next()
  await flushMicrotasks()
  const secondStreamId = socket.lastOpenStreamId()
  assert.notEqual(secondStreamId, firstStreamId, 'the replacement issues a fresh open frame')
  socket.itemNow(secondStreamId, { generation: 2 })
  const second = await secondPending
  const secondItem = second.value as { value: unknown }
  assert.deepEqual(secondItem.value, { generation: 2 })
  ;(first.value as { accept(): void }).accept()
  // The stale accept must NOT disarm the live attempt: its budget still expires, the live
  // opening is still judged an orphan, and the retry lane re-issues on a fresh attempt.
  const parked = iterator.next()
  void parked.catch(() => undefined)
  await flushMicrotasks()
  const opensBefore = socket.sent.filter(frame => frame.includes('"type":"open"')).length
  t.mock.timers.tick(openingBudgetMs(0))
  await flushMicrotasks()
  assert.equal(facts.filter(fact => fact.kind === 'opening-miss').length, 1,
    'the live opening still expires even though the old generation accepted')
  assert.equal(facts.filter(fact => fact.kind === 'opening-accepted').length, 0,
    "a superseded generation's accept is never a valid acceptance")
  assert.ok(
    socket.sent.filter(frame => frame.includes('"type":"open"')).length > opensBefore,
    'the orphaned live attempt is re-issued instead of being settled by the stale accept',
  )
  // The logical stream's public teardown; a raw iterator.return() while a source read is
  // pending cannot break its own await (RemoteStream.dispose() aborts first).
  await stream.dispose()
  await client.close()
})

test('F1/snapshot: the snapshot face accepts through the same ticket channel', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const client = new RemoteStreamMuxClient('', factRecorder(facts))
  client.start()
  const socket = await openSocket()
  const stream = logicalStream(client, 'session/control', { args: {} })
  const replaced: unknown[] = []
  const snapshots = new RemoteSnapshotStream<{ type: 'baseline'; n: number }, { type: 'delta'; n: number }>(
    stream as never,
    {
      name: 'session control stream',
      isSnapshot: (value): value is { type: 'baseline'; n: number } => value.type === 'baseline',
      replace: (snapshot) => { replaced.push(snapshot) },
      update: () => {},
      failed: () => {},
    },
  )
  snapshots.start()
  await flushMicrotasks()
  const streamId = socket.lastOpenStreamId()
  socket.itemNow(streamId, { type: 'baseline', n: 1 })
  await flushMicrotasks()
  assert.deepEqual(replaced, [{ type: 'baseline', n: 1 }], 'the opening snapshot reaches the domain model')
  assert.equal(facts.filter(fact => fact.kind === 'opening-accepted').length, 1,
    'RemoteSnapshotStream.accept() is the snapshot face acceptance signal')
  t.mock.timers.tick(openingBudgetMs(0) + 1_000)
  await flushMicrotasks()
  assert.equal(facts.filter(fact => fact.kind === 'opening-orphaned').length, 0,
    'an accepted snapshot opening is never orphaned')
  await snapshots.dispose()
  await client.close()
})

/* ---- the generated path: the per-generation ticket crosses prepareInvocation ---- */

/** One strict codec; the client only calls create().parse(value). */
function passThroughCodec(): { mode: 'strict'; typeSymbol: string; create: () => { parse(value: unknown): unknown } } {
  return { mode: 'strict', typeSymbol: '@fixture#Topic', create: () => ({ parse: (value: unknown): unknown => value }) }
}

/** The generated stream method fixture: direct, one topic parameter, cancellation. */
function attachDescriptor(): Record<string, unknown> {
  return {
    id: '@fixture/probe#probe/attach',
    service: 'probe',
    namespace: 'probe',
    method: 'attach',
    mode: 'stream',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'topic', wire: 'topic', source: 'json', codec: passThroughCodec() }],
    cancellation: { parameter: 'signal' },
    result: passThroughCodec(),
  }
}

/**
 * The smallest Cordis Context the client service drives (same shape as the
 * uplink-rejection suite): a service registry, the effect/plugin lifecycle, and
 * the Typert registry seam. The connection has NO `rpc.open`, so the WebSocket mux
 * is this page's carrier - exactly the production web profile.
 */
function createFakeContext(connection: unknown): Record<string, unknown> {
  const fake = {} as Record<string, unknown>
  const services: Record<string, unknown> = { connection }
  const provide = (name: string, service: unknown): void => {
    const parts = name.split('.')
    let target: Record<string, unknown> = fake
    for (const part of parts.slice(0, -1)) {
      const next = target[part]
      if (next === undefined || typeof next !== 'object') target[part] = {}
      target = target[part] as Record<string, unknown>
    }
    target[parts[parts.length - 1] as string] = service
  }
  const effect = (execute: () => unknown): (() => Promise<unknown>) & { then?: unknown } => {
    const disposers: Array<() => unknown> = []
    const result = execute()
    if (typeof result === 'function') disposers.push(result as () => unknown)
    const dispose = async (): Promise<void> => {
      for (const disposer of disposers.splice(0).reverse()) await disposer()
    }
    ;(dispose as { then?: unknown }).then = (onFulfilled?: (value: unknown) => unknown) =>
      Promise.resolve(result).then(() => onFulfilled?.(undefined))
    return dispose
  }
  Object.assign(fake, {
    reflect: { props: {}, provide },
    get: (name: string) => services[name],
    effect,
    plugin: (definition: { apply(ctx: unknown): void }) => {
      const child = Object.create(fake) as Record<string, unknown>
      definition.apply(child)
      return { dispose: async () => {}, then: (onFulfilled?: (value: unknown) => unknown) => Promise.resolve(undefined).then(() => onFulfilled?.(undefined)) }
    },
    emit: () => {},
    on: () => () => {},
    typert: {
      remotes: { register: () => () => {} },
      contexts: { getClient: () => undefined },
    },
  })
  return fake
}

test('F1/wiring: the generated call hands its generation ticket to the mux through prepareInvocation', async (t) => {
  installFakeSocket()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const facts: Fact[] = []
  const page = globalThis as { CustomEvent?: unknown; dispatchEvent?: unknown }
  const saved = { custom: page.CustomEvent, dispatch: page.dispatchEvent }
  page.CustomEvent = class {
    readonly type: string
    readonly detail: Fact
    constructor(type: string, init: { detail: Fact }) {
      this.type = type
      this.detail = init.detail
    }
  }
  page.dispatchEvent = (event: { type: string; detail: Fact }): boolean => {
    if (event.type === STREAM_FORENSICS_EVENT) facts.push(event.detail)
    return true
  }
  t.after(() => {
    page.CustomEvent = saved.custom
    page.dispatchEvent = saved.dispatch
  })
  const connection = {
    rpc: {},
    generation: { subscribe: () => () => {}, getSnapshot: () => ({ id: 1 }) },
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
    isLoopback: true,
  }
  const ctx = createFakeContext(connection)
  apply(ctx as never)
  const remote = ctx.remote as {
    $mount(contribution: { package: string; descriptors: readonly unknown[] }): Promise<() => Promise<void>>
    $stream<Item>(options: unknown): RemoteStream<Item>
    probe: { attach(topic: string, signal?: AbortSignal): AsyncIterable<unknown> }
  }
  await remote.$mount({ package: '@fixture/probe', descriptors: [attachDescriptor()] })
  const stream = remote.$stream<unknown>({
    name: 'probe attach',
    open: (signal: AbortSignal) => remote.probe.attach('topic', signal),
    ended: () => new Error('ended'),
  })
  const iterator = stream[Symbol.asyncIterator]()
  const pending = iterator.next()
  await flushMicrotasks()
  const socket = FakeSocket.instances.at(-1)
  assert.ok(socket !== undefined, 'the mux must own the transport when connection.rpc.open is absent')
  socket.openNow()
  await flushMicrotasks()
  const streamId = socket.lastOpenStreamId()
  socket.itemNow(streamId, { ready: true })
  const item = await pending
  assert.equal(item.done, false)
  // NO accept: with the ticket crossing prepareInvocation the mux keeps its deadline
  // armed, so the delivered-but-unaccepted opening is judged an orphan. Without the
  // copy the mux would see a ticket-less opening, accept on delivery, and stay silent.
  void iterator.next().catch(() => undefined)
  await flushMicrotasks()
  t.mock.timers.tick(openingBudgetMs(0))
  await flushMicrotasks()
  assert.equal(facts.filter(fact => fact.kind === 'opening-miss').length, 1,
    'the generated call must hand the generation ticket to the mux (prepareInvocation copy)')
  assert.equal(facts.find(fact => fact.kind === 'opening-miss')?.endpoint, 'probe/attach')
  assert.equal(facts.filter(fact => fact.kind === 'opening-accepted').length, 0,
    'a ticket-less opening would have accepted on delivery; the ticket keeps it unanswered')
  await stream.dispose()
  await connection.generation.getSnapshot()
})

/* ---- the domain face's own bound (the discrimination test the freeze required) ---- */

interface Page { readonly records: readonly number[]; readonly hasMore: boolean }
type ProbeFrame = RemoteJournalFrame<number, number, Page, void>

class ProbeJournal extends RemoteJournalStream<Page, number, number, void> {
  constructor(
    remote: { $stream: <Item>(options: never) => RemoteStream<Item> },
    source: () => AsyncGenerator<ProbeFrame>,
  ) {
    super(remote as never, {
      name: 'probe journal',
      emptyCursor: -1,
      entries: page => page.records,
      hasMore: page => page.hasMore,
      first: entry => entry,
      last: entry => entry,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: () => {},
      failed: () => {},
    })
    // The subclass's follow() is the transport-visible leg of the REAL class: the test
    // controls exactly what the carrier delivers to the domain face.
    this.deliver = source
  }

  private readonly deliver: () => AsyncGenerator<ProbeFrame>

  protected follow(): AsyncIterable<ProbeFrame> {
    return this.deliver()
  }

  protected readPage(): Promise<Page> {
    return Promise.resolve({ records: [], hasMore: false })
  }

  protected repairRequest(): void {
    return undefined
  }
}

test('domain discrimination: a carrier item the domain face never accepts still rejects within its bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const transport = new RemoteStream(connection() as never, {
    name: 'probe journal',
    // The mux delivered its first frame, but this leg stops there: the domain face
    // can never reach its opening()/accept(). The domain's own deadline must fire.
    open: () => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {})
      },
    }),
    ended: () => new Error('ended'),
  })
  const journal = new ProbeJournal({ $stream: () => transport } as never, () => (async function *empty() { /* no frame */ })())
  const opening = journal.open({} as never)
  await flushMicrotasks()
  t.mock.timers.tick(90_000)
  await flushMicrotasks()
  t.mock.timers.tick(2_000)
  await assert.rejects(
    opening,
    (error: unknown) => error instanceof Error && /delivered no opening item within 90000ms/u.test(error.message),
    'the domain face must reject on its own bound instead of parking at loadingHistory',
  )
})

test('domain discrimination: a first domain frame that is not the opening rejects at once', async (t) => {
  const transport = new RemoteStream(connection() as never, {
    name: 'probe journal',
    open: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'entry', entry: 1 }
      },
    }),
    ended: () => new Error('ended'),
  })
  const journal = new ProbeJournal({ $stream: () => transport } as never, () => (async function *empty() { /* unused */ })())
  await assert.rejects(
    journal.open({} as never),
    (error: unknown) => error instanceof Error && /emitted an entry before its opening cursor/u.test(error.message),
    'a misordered first frame is a protocol failure, never a pending open',
  )
})
