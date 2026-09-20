/**
 * Behavioural coverage for the journal silence watchdog and its sibling probe
 * (chamber fork, design 14 §D4, 2026-09).
 *
 * WHY THIS FILE EXISTS. The gateway fork's other suites are pure-policy truth
 * tables plus source-text locks, and those locks happily pinned a real runtime
 * bug: the probe read a double-wrapped frame (`next.value.value`), which threw
 * on every probe and silently killed the entire restart arm while every lock
 * stayed green (2026-09 independent review, BLOCKER). This suite imports the
 * REAL `RemoteJournalStream` and drives it with a fake logical stream and a fake
 * sibling follow, so the arm's actual behaviour — advance ⇒ replace the
 * generation, no advance ⇒ leave the subscription alone, dispose ⇒ stop — is
 * executed. Vendor leaves are stubbed by test/support/vendor-stub-loader.mjs.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RemoteJournalStream } from '../../src/client/journal-stream.ts'

interface OpenedFrame { readonly type: 'opened'; readonly cursor: number; readonly page: unknown }

/** One logical stream: yields the frames the test wants, then stays open forever. */
function fakeLogicalStream(frames: unknown[]) {
  const controller = new AbortController()
  const calls = { restarts: 0, disposed: 0 }
  const iterator = (async function* () {
    for (const frame of frames) {
      yield { generation: 1, value: frame, signal: controller.signal, accept: (): void => {} }
    }
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  })()
  return {
    calls,
    get signal(): AbortSignal { return controller.signal },
    restart(): void { calls.restarts += 1 },
    async dispose(): Promise<void> {
      calls.disposed += 1
      controller.abort(new Error('disposed'))
    },
    [Symbol.asyncIterator]: () => iterator,
  }
}

/** Concrete journal whose sibling follow yields scripted opening cursors. */
class ScriptedJournal extends RemoteJournalStream<unknown, { readonly seq: number }, number, never> {
  readonly #cursors: number[]
  readonly #fail: boolean
  probeCount = 0
  published: string[] = []

  constructor(remote: unknown, options: unknown, cursors: number[], fail = false) {
    super(remote as never, options as never)
    this.#cursors = cursors
    this.#fail = fail
  }

  async *follow(_request: unknown, signal: AbortSignal): AsyncIterable<OpenedFrame> {
    this.probeCount += 1
    // A broken probe path (a transport that rejects the sibling follow, a vendor
    // shape drift) must widen the cadence exactly like a clean "no advance".
    if (this.#fail) throw new Error('probe path broken')
    const cursor = this.#cursors.shift() ?? -1
    yield { type: 'opened', cursor, page: { entries: [{ seq: cursor }] } }
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }

  async readPage(): Promise<unknown> {
    throw new Error('readPage is not used by these scenarios')
  }

  repairRequest(request: unknown): unknown { return request }
}

/** A sibling follow whose return() never settles (a transport ignoring the abort). */
class StubbornJournal extends ScriptedJournal {
  override follow(): AsyncIterable<OpenedFrame> {
    this.probeCount += 1
    const frame: OpenedFrame = { type: 'opened', cursor: 7, page: { entries: [{ seq: 7 }] } }
    return {
      [Symbol.asyncIterator](): AsyncIterator<OpenedFrame> {
        return {
          next: async () => ({ done: false, value: frame }),
          return: () => new Promise<IteratorResult<OpenedFrame>>(() => {}),
        }
      },
    }
  }
}

const TIMING = {
  tickMs: 2,
  probeAfterMs: 2,
  probeIntervalMs: 2,
  probeTimeoutMs: 100,
  restartCooldownMs: 2,
  readDeadlineMs: 50,
}

function journal(cursors: number[], failProbes = false, stubborn = false) {
  const stream = fakeLogicalStream([{ type: 'opened', cursor: 5, page: { entries: [{ seq: 5 }] } }])
  const published: string[] = []
  const JournalClass = stubborn ? StubbornJournal : ScriptedJournal
  const journalStream = new JournalClass(
    { $stream: () => stream },
    {
      name: 'test journal',
      emptyCursor: -1,
      entries: (page: { entries: unknown[] }) => page.entries,
      hasMore: () => false,
      first: (entry: { seq: number }) => entry.seq,
      last: (entry: { seq: number }) => entry.seq,
      compare: (left: number, right: number) => left - right,
      follows: (left: number, right: number) => right === left + 1,
      publish: (change: { type: string }) => { published.push(change.type) },
      failed: (error: unknown) => { throw error },
      stall: TIMING,
    },
    cursors,
    failProbes,
  )
  journalStream.published = published
  return { journalStream, stream, published }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Poll a predicate with a deadline: the watchdog cadence is real-time, so wait for
 * the condition instead of trusting a fixed sleep on a loaded machine. */
async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(2)
  }
  return predicate()
}

test('opening publishes the window and arms the watchdog', async () => {
  const { journalStream, published } = journal([])
  await journalStream.open({ maxMessages: 10 })
  assert.deepEqual(published, ['replace'])
  assert.ok(await pollUntil(() => journalStream.probeCount >= 1, 1_000), 'a silent opened journal must start probing the Host')
  await journalStream.dispose()
})

test('a probe that finds no Host advance never restarts the generation', async () => {
  const { journalStream, stream } = journal([5, 5, 5])
  await journalStream.open({ maxMessages: 10 })
  assert.ok(await pollUntil(() => journalStream.probeCount >= 2, 1_000), 'the watchdog must keep probing while the stream is silent')
  assert.equal(stream.calls.restarts, 0, 'legal silence must never churn the subscription')
  await journalStream.dispose()
})

test('an advanced Host cursor replaces the generation (regression: frame unwrapping)', async () => {
  const { journalStream, stream } = journal([7])
  await journalStream.open({ maxMessages: 10 })
  assert.ok(await pollUntil(() => stream.calls.restarts >= 1, 1_000), 'a proven advance must replace the physical generation')
  assert.equal(stream.calls.restarts, 1, 'the arm replaces the generation exactly once')
  await journalStream.dispose()
})

test('a broken probe path widens the cadence instead of probing every tick', async () => {
  const { journalStream, stream } = journal([], true)
  await journalStream.open({ maxMessages: 10 })
  assert.ok(await pollUntil(() => journalStream.probeCount >= 2, 1_000), 'the watchdog must keep probing')
  const seen = journalStream.probeCount
  await sleep(120)
  const grown = journalStream.probeCount
  assert.ok(grown >= seen, 'the watchdog must not stop after a failed probe')
  // probeIntervalMs is 2 ms here: a path that forgets to widen after a throw would
  // attempt ~60 probes in this window; the widened path (doubling per no-advance)
  // attempts a handful. Jitter can only make the count LOWER, never higher.
  assert.ok(grown - seen <= 6, 'a failed probe must widen the cadence (saw ' + String(grown - seen) + ' probes)')
  assert.equal(stream.calls.restarts, 0, 'a failed probe is never evidence of an advance')
  await journalStream.dispose()
})

test('a sibling follow whose return never settles does not disable the arm', async () => {
  // The probe aborts the follow before tearing it down, and the teardown itself is
  // bounded: an iterator that ignores both must not leave probing=true forever
  // (that would silently switch this stream's silent-journal arm off).
  const { journalStream, stream } = journal([], false, true)
  await journalStream.open({ maxMessages: 10 })
  assert.ok(await pollUntil(() => journalStream.probeCount >= 2, 2_500), 'the watchdog must keep probing')
  assert.ok(stream.calls.restarts >= 1, 'the first probe found an advance and must have restarted')
  await journalStream.dispose()
})

test('a probe cursor BEHIND the applied one never restarts', async () => {
  // The Host must ADVANCE; a stale/regressed cursor (a replaced generation that
  // has not caught up) would otherwise be restarted into a protocol violation.
  const { journalStream, stream } = journal([3, 3])
  await journalStream.open({ maxMessages: 10 })
  assert.ok(await pollUntil(() => journalStream.probeCount >= 2, 1_000), 'the probe must have run')
  assert.equal(stream.calls.restarts, 0, 'only an advance may replace the generation')
  await journalStream.dispose()
})

test('dispose stops the watchdog and releases the logical stream', async () => {
  const { journalStream, stream } = journal([5])
  await journalStream.open({ maxMessages: 10 })
  assert.ok(await pollUntil(() => journalStream.probeCount >= 1, 1_000))
  await journalStream.dispose()
  const probed = journalStream.probeCount
  await sleep(20)
  assert.equal(journalStream.probeCount, probed, 'a disposed journal must not keep probing')
  assert.ok(stream.calls.disposed >= 1)
})
