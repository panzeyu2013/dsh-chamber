import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPurgedConvergence,
  nextConvergenceStep,
  releasableAfterProbe,
  type ConvergenceOutcome,
} from '../src/shared/purged-convergence.ts'
import { PURGED_REFRESH_MAX_ATTEMPTS, PURGED_REFRESH_RETRY_MS } from '../src/shared/purged-rows.ts'

/** Let every queued microtask (and the chain's promise plumbing) settle. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Deterministic scheduler: timers run only when the test drains them. */
function fakeTimers() {
  let nextId = 1
  const pending = new Map<number, { run: () => void; ms: number }>()
  return {
    schedule: (run: () => void, ms: number): unknown => {
      const id = nextId++
      pending.set(id, { run, ms })
      return id
    },
    cancel: (handle: unknown): void => { pending.delete(handle as number) },
    /** Run the oldest pending timer (FIFO by insertion). */
    async drain(): Promise<number> {
      const entry = [...pending.entries()][0]
      if (entry === undefined) throw new Error('no pending timer')
      pending.delete(entry[0])
      entry[1].run()
      await Promise.resolve()
      await Promise.resolve()
      return entry[1].ms
    },
    size: (): number => pending.size,
  }
}

/** Minimal harness recording refresh calls and warns. */
function harness(options: {
  /** Outcomes for successive attempts; the last entry repeats. */
  outcomes: ConvergenceOutcome[]
  /** Lingering ids per attempt (last repeats). */
  lingering: string[][]
  /** Authoritative probe result (undefined = probe unavailable). */
  probe?: () => Promise<ReadonlySet<string> | undefined> | undefined
  maxAttempts?: number
}) {
  const timers = fakeTimers()
  const refreshes: number[] = []
  const warns: string[] = []
  const releases: string[][] = []
  let attemptIndex = 0
  const chain = createPurgedConvergence({
    refresh: () => {
      const index = attemptIndex++
      refreshes.push(index)
      const outcome = options.outcomes[Math.min(index, options.outcomes.length - 1)] ?? 'resolved'
      if (outcome === 'rejected') return Promise.reject(new Error('rpc failed'))
      if (outcome === 'timeout') return new Promise<never>(() => {})
      return Promise.resolve()
    },
    // Index by the attempt that just settled (attemptIndex already points at the next one).
    lingering: () => options.lingering[Math.min(Math.max(attemptIndex - 1, 0), options.lingering.length - 1)] ?? [],
    warn: (message) => { warns.push(message) },
    schedule: timers.schedule,
    cancel: timers.cancel,
    attemptTimeoutMs: 0,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    release: (ids) => { releases.push([...ids]) },
  })
  return { chain, timers, refreshes, warns, releases }
}

test('nextConvergenceStep: converged as soon as nothing lingers', () => {
  assert.deepEqual(
    nextConvergenceStep({ attempt: 1, maxAttempts: 3, lingering: [] }),
    { action: 'converged' },
  )
})

test('nextConvergenceStep: retries while attempts remain', () => {
  assert.deepEqual(
    nextConvergenceStep({ attempt: 1, maxAttempts: 3, lingering: ['g'] }),
    { action: 'retry' },
  )
  assert.deepEqual(
    nextConvergenceStep({ attempt: 2, maxAttempts: 3, lingering: ['g'] }),
    { action: 'retry' },
  )
})

test('nextConvergenceStep: exhausting the bound moves to the authoritative probe', () => {
  // `refreshList` resolving does not prove the summaries are authoritative
  // (failed pulls and joined stale single-flight responses also resolve), so
  // the terminal step consults the independent probe instead of releasing.
  assert.deepEqual(
    nextConvergenceStep({ attempt: 3, maxAttempts: 3, lingering: ['g'] }),
    { action: 'verify' },
  )
})

test('releasableAfterProbe: only ids the authoritative source still lists', () => {
  assert.deepEqual(releasableAfterProbe(['a', 'b', 'c'], new Set(['c', 'a', 'x'])), ['a', 'c'])
  assert.deepEqual(releasableAfterProbe(['a'], new Set()), [])
})

test('chain: one successful refresh that drops the rows converges without a retry', async () => {
  const h = harness({ outcomes: ['resolved'], lingering: [[]] })
  h.chain.converge()
  await flush()
  assert.deepEqual(h.refreshes, [0])
  assert.deepEqual(h.warns, [])
  assert.equal(h.chain.active(), false)
  assert.equal(h.timers.size(), 0)
})

test('chain: a stale single-flight response retries and converges on the fresh one', async () => {
  // Attempt 1 resolves with the PRE-purge list (rows still listed), attempt 2
  // resolves with the clean corpus — exactly the official single-flight hole.
  const h = harness({ outcomes: ['resolved', 'resolved'], lingering: [['g'], []] })
  h.chain.converge()
  await flush()
  assert.deepEqual(h.refreshes, [0])
  assert.equal(h.timers.size(), 1)
  assert.equal(await h.timers.drain(), PURGED_REFRESH_RETRY_MS)
  await flush()
  assert.deepEqual(h.refreshes, [0, 1])
  assert.deepEqual(h.warns, [])
  assert.equal(h.chain.active(), false)
})

test('chain: a REJECTED refresh is retried (transient RPC failure)', async () => {
  const h = harness({ outcomes: ['rejected', 'resolved'], lingering: [['g'], []] })
  h.chain.converge()
  await flush()
  assert.equal(h.timers.size(), 1)
  await h.timers.drain()
  await flush()
  assert.deepEqual(h.refreshes, [0, 1])
  assert.equal(h.chain.active(), false)
})

test('chain: a resolved-but-untouched refresh is retried, never released', async () => {
  // The manager RESOLVES on a failed pull with the summaries untouched, so a
  // resolved outcome with lingering rows must NOT end the chain early.
  const h = harness({ outcomes: ['resolved'], lingering: [['g1', 'g2']] })
  h.chain.converge()
  for (let i = 0; i < PURGED_REFRESH_MAX_ATTEMPTS; i += 1) {
    await flush()
    if (h.timers.size() > 0) await h.timers.drain()
  }
  await flush()
  assert.equal(h.refreshes.length, PURGED_REFRESH_MAX_ATTEMPTS)
  assert.equal(h.warns.length, 1)
  assert.match(h.warns[0] ?? '', /stay suppressed/)
  assert.deepEqual(h.releases, [])
  assert.equal(h.chain.active(), false)
})

test('chain: a hung refresh is bounded by the attempt watchdog', async () => {
  const timers = fakeTimers()
  const refreshes: number[] = []
  const warns: string[] = []
  let attempt = 0
  const chain = createPurgedConvergence({
    refresh: () => { refreshes.push(attempt++); return new Promise<never>(() => {}) },
    lingering: () => ['g'],
    warn: (message) => { warns.push(message) },
    schedule: timers.schedule,
    cancel: timers.cancel,
    maxAttempts: 2,
    retryMs: 10,
    attemptTimeoutMs: 5,
  })
  chain.converge()
  await flush()
  // Attempt 1 watchdog fires -> retry scheduled.
  assert.equal(await timers.drain(), 5)
  await flush()
  assert.equal(await timers.drain(), 10)
  await flush()
  // Attempt 2 watchdog fires -> terminal give-up (no authoritative answer).
  assert.equal(await timers.drain(), 5)
  await flush()
  assert.deepEqual(refreshes, [0, 1])
  assert.equal(warns.length, 1)
  assert.match(warns[0] ?? '', /no authoritative answer/)
  assert.equal(chain.active(), false)
})

test('chain: the default per-attempt watchdog is 2x the retry interval', async () => {
  const timers = fakeTimers()
  const chain = createPurgedConvergence({
    refresh: () => new Promise<never>(() => {}),
    lingering: () => ['g'],
    warn: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  chain.converge()
  await flush()
  assert.equal(await timers.drain(), PURGED_REFRESH_RETRY_MS * 2)
})

test('chain: a late settle of a timed-out attempt cannot terminate a later attempt', async () => {
  // Attempt 1 times out; its promise resolves while attempt 2 is running.
  // The late settle must be ignored (attempt fence), so the chain keeps its
  // own attempt-2 watchdog and bound.
  const timers = fakeTimers()
  const warns: string[] = []
  let resolveFirst: (() => void) | undefined
  let calls = 0
  const chain = createPurgedConvergence({
    refresh: () => {
      calls += 1
      if (calls === 1) return new Promise<void>((resolve) => { resolveFirst = resolve })
      return new Promise<never>(() => {})
    },
    lingering: () => ['g'],
    warn: (message) => { warns.push(message) },
    schedule: timers.schedule,
    cancel: timers.cancel,
    maxAttempts: 3,
    retryMs: 10,
    attemptTimeoutMs: 5,
  })
  chain.converge()
  await flush()
  assert.equal(await timers.drain(), 5)      // attempt-1 watchdog -> retry
  await flush()
  assert.equal(await timers.drain(), 10)     // retry timer -> attempt 2 starts
  await flush()
  assert.equal(calls, 2)
  assert.equal(chain.active(), true)
  resolveFirst?.()                            // late settle of attempt 1
  await flush()
  // Attempt 2 is still in flight: the late settle must not have terminated it.
  assert.equal(chain.active(), true)
  assert.deepEqual(warns, [])
  assert.equal(await timers.drain(), 5)      // attempt-2 watchdog still armed
  await flush()
  assert.equal(await timers.drain(), 10)     // -> attempt 3
  await flush()
  assert.equal(await timers.drain(), 5)      // attempt-3 watchdog -> terminal
  await flush()
  assert.equal(warns.length, 1)
  assert.equal(chain.active(), false)
})

test('chain: repeated rejection gives up after the bound and keeps the suppression', async () => {
  const h = harness({ outcomes: ['rejected'], lingering: [['g']] })
  h.chain.converge()
  for (let i = 0; i < PURGED_REFRESH_MAX_ATTEMPTS; i += 1) {
    await flush()
    if (h.timers.size() > 0) await h.timers.drain()
  }
  await flush()
  assert.equal(h.refreshes.length, PURGED_REFRESH_MAX_ATTEMPTS)
  assert.equal(h.warns.length, 1)
  assert.match(h.warns[0] ?? '', /no authoritative answer/)
})

test('chain: a second converge() joins the running chain instead of restarting the bound', async () => {
  const h = harness({ outcomes: ['resolved'], lingering: [['g']] })
  h.chain.converge()
  h.chain.converge()
  h.chain.converge()
  await flush()
  assert.deepEqual(h.refreshes, [0])
  assert.equal(h.timers.size(), 1)
  for (let i = 1; i < PURGED_REFRESH_MAX_ATTEMPTS; i += 1) {
    await h.timers.drain()
    await flush()
  }
  assert.equal(h.refreshes.length, PURGED_REFRESH_MAX_ATTEMPTS)
})

test('chain: dispose cancels the pending retry and issues nothing further', async () => {
  const h = harness({ outcomes: ['rejected'], lingering: [['g']] })
  h.chain.converge()
  await flush()
  assert.equal(h.timers.size(), 1)
  h.chain.dispose()
  assert.equal(h.timers.size(), 0)
  assert.equal(h.chain.active(), false)
  h.chain.converge()
  assert.deepEqual(h.refreshes, [0])
})

test('chain: an unavailable official refresh face warns and keeps the suppression', () => {
  const warns: string[] = []
  const chain = createPurgedConvergence({
    refresh: () => undefined,
    lingering: () => ['g'],
    warn: (message) => { warns.push(message) },
  })
  chain.converge()
  assert.equal(warns.length, 1)
  assert.match(warns[0] ?? '', /unavailable/)
  assert.equal(chain.active(), false)
})

test('chain: converge() after the source is disposed is inert', () => {
  const refreshes: number[] = []
  const chain = createPurgedConvergence({
    refresh: () => { refreshes.push(1); return Promise.resolve() },
    lingering: () => [],
    warn: () => {},
  })
  chain.dispose()
  chain.converge()
  assert.deepEqual(refreshes, [])
})

test('chain: the authoritative probe releases ONLY the ids it still lists', async () => {
  const h = harness({
    outcomes: ['resolved'],
    lingering: [['g1', 'g2']],
    maxAttempts: 1,
    probe: () => Promise.resolve(new Set(['g2', 'live'])),
  })
  h.chain.converge()
  await flush()
  await flush()
  assert.deepEqual(h.releases, [['g2']])
  // One warn for the released id, one for the id the probe did NOT confirm.
  assert.equal(h.warns.length, 2)
  assert.match(h.warns[0] ?? '', /released/)
  assert.match(h.warns[1] ?? '', /stay suppressed/)
})

test('chain: a probe that omits the id keeps the suppression', async () => {
  const h = harness({
    outcomes: ['resolved'],
    lingering: [['g1']],
    maxAttempts: 1,
    probe: () => Promise.resolve(new Set(['live'])),
  })
  h.chain.converge()
  await flush()
  await flush()
  assert.deepEqual(h.releases, [])
  assert.equal(h.warns.length, 1)
  assert.match(h.warns[0] ?? '', /stay suppressed/)
})

test('chain: a rejecting probe keeps the suppression (no authoritative answer)', async () => {
  const h = harness({
    outcomes: ['resolved'],
    lingering: [['g1']],
    maxAttempts: 1,
    probe: () => Promise.reject(new Error('probe failed')),
  })
  h.chain.converge()
  await flush()
  await flush()
  assert.deepEqual(h.releases, [])
  assert.equal(h.warns.length, 1)
  assert.match(h.warns[0] ?? '', /no authoritative answer/)
})

test('chain: a hung probe is bounded by the watchdog and keeps the suppression', async () => {
  const timers = fakeTimers()
  const warns: string[] = []
  const releases: string[][] = []
  let refreshes = 0
  const chain = createPurgedConvergence({
    refresh: () => { refreshes += 1; return Promise.resolve() },
    lingering: () => ['g'],
    probe: () => new Promise<never>(() => {}),
    release: (ids) => { releases.push([...ids]) },
    warn: (message) => { warns.push(message) },
    schedule: timers.schedule,
    cancel: timers.cancel,
    maxAttempts: 1,
    retryMs: 10,
    attemptTimeoutMs: 5,
  })
  chain.converge()
  await flush()
  // Attempt 1 resolves with the row still listed -> verify -> probe watchdog.
  assert.equal(await timers.drain(), 5)
  await flush()
  assert.equal(refreshes, 1)
  assert.deepEqual(releases, [])
  assert.equal(warns.length, 1)
  assert.match(warns[0] ?? '', /no authoritative answer/)
  assert.equal(chain.active(), false)
})

test('chain: a probe that outlives its watchdog cannot cancel a later attempt\'s watchdog', async () => {
  // 2026-09 scan MAJOR-1: the probe phase must own its watchdog. A late
  // resolution of an already-timed-out probe must not clear the NEXT chain
  // attempt's watchdog (that would wedge the chain active forever).
  const timers = fakeTimers()
  let resolveProbe: ((present: ReadonlySet<string>) => void) | undefined
  let probeCalls = 0
  let refreshCalls = 0
  const chain = createPurgedConvergence({
    refresh: () => { refreshCalls += 1; return new Promise<never>(() => {}) },
    lingering: () => ['g'],
    probe: () => { probeCalls += 1; return new Promise<ReadonlySet<string>>((resolve) => { resolveProbe = resolve }) },
    warn: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
    maxAttempts: 1,
    retryMs: 10,
    attemptTimeoutMs: 5,
  })
  chain.converge()
  await flush()
  assert.equal(await timers.drain(), 5)      // attempt-1 watchdog -> verify
  await flush()
  assert.equal(probeCalls, 1)
  assert.equal(await timers.drain(), 5)      // probe watchdog -> terminal
  await flush()
  assert.equal(chain.active(), false)
  // A new chain starts; the previous probe resolves late.
  chain.converge()
  await flush()
  assert.equal(chain.active(), true)
  assert.equal(refreshCalls, 2)
  resolveProbe?.(new Set())
  await flush()
  // The new attempt must still be armed: its watchdog has not been cancelled.
  assert.equal(chain.active(), true)
  assert.equal(await timers.drain(), 5)
  await flush()
  // The second chain reached its own terminal probe; resolve it so the chain
  // can finish (the point of the test is that it got here at all).
  assert.equal(chain.active(), true)
  resolveProbe?.(new Set())
  await flush()
  assert.equal(chain.active(), false)
})

test('chain: a tombstone armed while the probe is in flight is NOT released', async () => {
  // 2026-09 scan MINOR-3: the release decision uses the suppression snapshot
  // taken when the probe STARTED; an id armed during the flight is judged by
  // its own convergence run, never by a probe answer that predates it.
  let lingeringNow = ['g1']
  let resolveProbe: ((present: ReadonlySet<string>) => void) | undefined
  const releases: string[][] = []
  const chain = createPurgedConvergence({
    refresh: () => Promise.resolve(),
    lingering: () => lingeringNow,
    probe: () => new Promise<ReadonlySet<string>>((resolve) => { resolveProbe = resolve }),
    release: (ids) => { releases.push([...ids]) },
    warn: () => {},
    maxAttempts: 1,
    attemptTimeoutMs: 0,
  })
  chain.converge()
  await flush()
  // A second purge arms g2 while the probe is in flight.
  lingeringNow = ['g1', 'g2']
  resolveProbe?.(new Set(['g2']))
  await flush()
  assert.deepEqual(releases, [])
  assert.equal(chain.active(), false)
})

test('chain: a late probe settle cannot cancel a LATER probe\'s watchdog', async () => {
  // Final-verify finding 3: the probe watchdog must be PER PROBE. Sequence:
  // probe #1 hangs -> its watchdog fires (chain finishes) -> a new chain turn
  // reaches probe #2 and hangs -> probe #1 settles late. That late settlement
  // may only clear its own handle; probe #2's watchdog must still fire.
  const timers = fakeTimers()
  const resolvers: Array<(present: ReadonlySet<string>) => void> = []
  let probeCalls = 0
  const chain = createPurgedConvergence({
    refresh: () => new Promise<never>(() => {}),
    lingering: () => ['g'],
    probe: () => { probeCalls += 1; return new Promise<ReadonlySet<string>>((resolve) => { resolvers.push(resolve) }) },
    warn: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
    maxAttempts: 1,
    retryMs: 10,
    attemptTimeoutMs: 5,
  })
  chain.converge()
  await flush()
  assert.equal(await timers.drain(), 5)      // attempt watchdog -> verify -> probe #1
  await flush()
  assert.equal(probeCalls, 1)
  assert.equal(await timers.drain(), 5)      // probe #1 watchdog -> finish
  await flush()
  assert.equal(chain.active(), false)
  chain.converge()
  await flush()
  assert.equal(await timers.drain(), 5)      // new attempt watchdog -> verify -> probe #2
  await flush()
  assert.equal(probeCalls, 2)
  assert.equal(chain.active(), true)
  // probe #1 settles LATE while probe #2 is outstanding.
  resolvers[0]?.(new Set())
  await flush()
  assert.equal(chain.active(), true)
  // probe #2's own watchdog must still be armed and must terminate the chain.
  assert.equal(await timers.drain(), 5)
  await flush()
  assert.equal(chain.active(), false)
})
