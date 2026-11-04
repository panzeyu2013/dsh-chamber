/**
 * Carrier-retry pacing truth table (chamber fork patch, design 14 §D4).
 * A SECOND carrier failure inside one live connection generation is paced and
 * reopened instead of escaping terminally, so the delay function is the contract:
 * immediate once, then double up to a cap.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  delayRemoteStreamRetry,
  REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS,
  REMOTE_STREAM_RETRY_BASE_MS,
  REMOTE_STREAM_RETRY_FIRST_MS,
  REMOTE_STREAM_RETRY_MAX_MS,
  remoteStreamRetryDelayMs,
  REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS,
  REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS,
  REMOTE_STREAM_REOPEN_JITTER_MAX_MS,
  REMOTE_STREAM_STABLE_CARRIER_MIN_MS,
  remoteStreamReopenJitterMs,
  streamOpeningKey,
} from '../../src/client/remote-retry-policy.ts'
import { DEFAULT_STREAM_STALL_TIMING } from '../../src/client/stream-stall-policy.ts'
import { OPENING_TIMEOUT_MS, SILENT_TEARDOWN_MIN_MS } from '@dsh-chamber/dsh-stream-state'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Single-source tie: this module must stay IMPORT-FREE at runtime, so it cannot
 * read the shared table itself - the opening deadline and the teardown floor are
 * owned by the package table (the reducer arms the deadline, the host consumes the
 * floor), and this source-text tie keeps a second derivation from creeping back in.
 */
test('the opening ladder is the shared table, and this module no longer re-derives it (B4/P3 tie)', () => {
  const source = (relative: string): string =>
    readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
  const client = source('src/client/stream-client.ts')
  // P3: the host reports the opening and takes the budget the reducer arms.
  assert.match(client, /kind: 'openingSent', at: Date\.now\(\), streamId, requestKey/u)
  assert.match(client, /effect\.e === 'armOpeningDeadline'/u)
  // ...and it owns no ledger of its own any more.
  assert.doesNotMatch(client, /openingTimeouts|streamOpeningKeys/u)
  assert.doesNotMatch(source('src/client/remote-retry-policy.ts'), /REMOTE_STREAM_OPENING_TIMEOUT|remoteStreamOpeningTimeoutMs/u)
  assert.match(client, /Date\.now\(\) - sentAt >= SILENT_TEARDOWN_MIN_MS/u)
})

test('the first carrier failure of an episode reopens immediately', () => {
  assert.equal(REMOTE_STREAM_RETRY_FIRST_MS, 0)
  assert.equal(remoteStreamRetryDelayMs(1), 0)
  // The immediate first attempt is a contract, not an RNG draw: a broken injectable
  // RNG must not turn the first reopen into a wait.
  assert.equal(remoteStreamRetryDelayMs(1, () => 0), 0)
  assert.equal(remoteStreamRetryDelayMs(1, () => { throw new Error('rng unavailable') }), 0)
})

/** The capped exponential a later attempt would use WITHOUT jitter. */
function effectiveBackoff(attempt: number): number {
  return Math.min(
    REMOTE_STREAM_RETRY_BASE_MS * 2 ** Math.min(Math.floor(attempt) - 2, 16),
    REMOTE_STREAM_RETRY_MAX_MS,
  )
}

test('the wait for a live generation is bounded (a parked lane cannot park a stream forever)', () => {
  // Above the retry ceiling: one reopen per ceiling is the slowest useful pace,
  // and the bound must not be tighter than that pace.
  assert.ok(REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS >= REMOTE_STREAM_RETRY_MAX_MS)
  // ...and bounded: past a minute the state is not "waiting", it is a dead lane,
  // and the surface must have had at least one reopen attempt by then.
  assert.ok(REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS <= 60_000)
  assert.ok(REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS > 0)
})

test('later failures keep at least half of the doubling backoff and jitter the rest', () => {
  // half-jitter over the CAPPED exponential: [0.5x, 1x] of the effective backoff.
  const cases: ReadonlyArray<readonly [attempt: number, sample: number, expected: number]> = [
    [2, 0, 125],
    [2, 0.5, 187],
    [2, 1, 250],
    [3, 0, 250],
    [3, 0.5, 375],
    [3, 1, 500],
    [4, 0.25, 625],
    [4, 1, 1_000],
    [5, 0, 1_000],
    [5, 1, 2_000],
  ]
  for (const [attempt, sample, expected] of cases) {
    assert.equal(remoteStreamRetryDelayMs(attempt, () => sample), expected,
      'attempt ' + String(attempt) + ' with random()=' + String(sample))
  }
})

test('every jittered delay stays inside its half-open band and is whole milliseconds', () => {
  const samples = [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]
  for (let attempt = 2; attempt <= 40; attempt++) {
    const effective = effectiveBackoff(attempt)
    for (const sample of samples) {
      const delay = remoteStreamRetryDelayMs(attempt, () => sample)
      assert.ok(Number.isInteger(delay), 'attempt ' + String(attempt) + ' must be whole milliseconds')
      assert.ok(delay >= Math.floor(effective * 0.5),
        'attempt ' + String(attempt) + ' must keep at least half the backoff (got ' + String(delay) + ')')
      assert.ok(delay <= effective,
        'attempt ' + String(attempt) + ' must never exceed the effective backoff (got ' + String(delay) + ')')
    }
  }
})

test('the backoff is capped, so a persistent fault settles into one reopen per ceiling', () => {
  for (const attempt of [8, 9, 64, 1_000_000]) {
    // The effective (un-jittered) value has reached the ceiling; jitter may only lower
    // it to half, never above it.
    assert.equal(effectiveBackoff(attempt), REMOTE_STREAM_RETRY_MAX_MS, String(attempt))
    assert.equal(remoteStreamRetryDelayMs(attempt, () => 1), REMOTE_STREAM_RETRY_MAX_MS)
    assert.equal(remoteStreamRetryDelayMs(attempt, () => 0), REMOTE_STREAM_RETRY_MAX_MS / 2)
    assert.ok(remoteStreamRetryDelayMs(attempt) <= REMOTE_STREAM_RETRY_MAX_MS)
  }
})

test('the upper envelope is monotone non-decreasing (jitter never changes the pace)', () => {
  // Per-draw monotonicity is NOT a contract once a random sample is involved; what must
  // stay monotone is the un-jittered ceiling each attempt is drawn under.
  let previous = -1
  for (let attempt = 1; attempt <= 40; attempt++) {
    const upper = remoteStreamRetryDelayMs(attempt, () => 1)
    assert.ok(upper >= previous, 'attempt ' + String(attempt) + ' must not shrink the envelope')
    assert.ok(upper <= REMOTE_STREAM_RETRY_MAX_MS, 'attempt ' + String(attempt) + ' must stay capped')
    previous = upper
  }
})

test('jitter spreads concurrent reopens instead of collapsing them onto one instant', () => {
  // A seeded LCG keeps the distribution assertion deterministic (Math.random() is not
  // injectable in CI). 200 independent reopens of one attempt must land on many
  // distinct millisecond values, all inside the half-jitter band.
  let state = 0x2545f491
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
  const effective = effectiveBackoff(2)
  const seen = new Set<number>()
  let sum = 0
  for (let index = 0; index < 200; index++) {
    const delay = remoteStreamRetryDelayMs(2, random)
    seen.add(delay)
    sum += delay
    assert.ok(delay >= Math.floor(effective * 0.5) && delay <= effective, String(delay))
  }
  assert.ok(seen.size >= 20, 'jitter must spread the herd (distinct delays: ' + String(seen.size) + ')')
  const mean = sum / 200
  assert.ok(mean > effective * 0.6 && mean < effective * 0.9,
    'the mean must sit near the middle of the half-jitter band (got ' + mean.toFixed(1) + ')')
})

test('the fan-out first-reopen spread is bounded and fails safe', () => {
  // The mux attaches one draw per logical stream so a single socket death does not make
  // the whole fan-out re-issue in lockstep; the spread is at most a quarter second.
  assert.equal(REMOTE_STREAM_REOPEN_JITTER_MAX_MS, 250)
  assert.equal(remoteStreamReopenJitterMs(() => 0), 0)
  assert.equal(remoteStreamReopenJitterMs(() => 0.5), 125)
  assert.equal(remoteStreamReopenJitterMs(() => 1), 250)
  // A broken RNG must not throw into the retry lane, and it fails safe to "no extra wait".
  assert.equal(remoteStreamReopenJitterMs(() => { throw new Error('rng rejected') }), 0)
  for (const sample of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(remoteStreamReopenJitterMs(() => sample), 0, String(sample))
  }
  assert.equal(remoteStreamReopenJitterMs(() => -1), 0, 'out-of-range samples clamp')
  assert.equal(remoteStreamReopenJitterMs(() => 2), REMOTE_STREAM_REOPEN_JITTER_MAX_MS)
})

test('a broken or out-of-range injected RNG cannot break pacing', () => {
  const attempt = 3
  const effective = effectiveBackoff(attempt)
  // A throwing RNG must not let a retry become a terminal error: fall back to full backoff.
  assert.equal(remoteStreamRetryDelayMs(attempt, () => { throw new Error('rng rejected') }), effective)
  // Non-finite samples fall back to the un-jittered backoff too.
  for (const sample of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(remoteStreamRetryDelayMs(attempt, () => sample), effective, String(sample))
  }
  // Out-of-range samples clamp into [0, 1] instead of leaving the band.
  assert.equal(remoteStreamRetryDelayMs(attempt, () => -5), effective / 2)
  assert.equal(remoteStreamRetryDelayMs(attempt, () => 2), effective)
})

test('the backoff wait resolves once the delay elapses', async () => {
  const started = Date.now()
  await delayRemoteStreamRetry(6, new AbortController().signal)
  assert.ok(Date.now() - started >= 5, 'the wait must actually hold the reopen back')
})

test('an aborted generation stops waiting instead of reconnecting', async () => {
  const controller = new AbortController()
  const waiting = delayRemoteStreamRetry(60_000, controller.signal)
  controller.abort(new Error('generation replaced'))
  await assert.rejects(waiting, (error: Error) => error.message === 'Remote stream retry aborted')
  // The rejection is what the carrier turns into 'return'/'continue': an aborted
  // generation must not reopen the stream behind the caller's back.
  await delay(5)
})

test('an already-aborted signal never waits at all', async () => {
  const controller = new AbortController()
  controller.abort()
  const started = Date.now()
  await assert.rejects(delayRemoteStreamRetry(60_000, controller.signal))
  assert.ok(Date.now() - started < 1_000, 'an aborted signal must not arm a timer')
})

test('degenerate attempt counts fail safe to the immediate branch', () => {
  for (const attempt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(remoteStreamRetryDelayMs(attempt), 0, String(attempt))
    assert.equal(remoteStreamRetryDelayMs(attempt, () => 0.5), 0, String(attempt))
  }
})

test('the opening deadline is the single table tier, and this module no longer re-derives it (B4/P3 tie)', () => {
  // P3/R2: the budget function is retired - the reducer arms the package table's ONE
  // tier and the host executes it, so the streak can never widen the wait.
  assert.equal(OPENING_TIMEOUT_MS, 30_000)
  // Measured healthy Host answers: session snapshot 57 ms, subagent snapshot 73 ms. The
  // single tier must clear those while remaining a bound a user would still call
  // "stuck for a moment".
  assert.ok(OPENING_TIMEOUT_MS >= 10_000)
  assert.ok(OPENING_TIMEOUT_MS <= 600_000)
})

test('the opening episode key is stable per stream and separates endpoints and payloads', () => {
  const payload = { args: { request: { address: { kind: 'session', sessionId: 'a' } } } }
  assert.equal(streamOpeningKey('session/follow', payload), streamOpeningKey('session/follow', payload))
  assert.notEqual(streamOpeningKey('session/follow', payload), streamOpeningKey('session/follow', { args: {} }))
  assert.notEqual(streamOpeningKey('session/follow', payload), streamOpeningKey('session/control', payload))
  assert.equal(streamOpeningKey('$events', undefined), streamOpeningKey('$events', undefined))
})

test('an unencodable payload still yields a usable key instead of throwing', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.doesNotThrow(() => streamOpeningKey('session/follow', cyclic))
  assert.equal(streamOpeningKey('session/follow', cyclic), streamOpeningKey('session/follow', cyclic))
})

test('the mux self-heal throttle stays a second-scale bound', () => {
  assert.ok(REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS >= 250, 'a flapping network must not hot-loop')
  assert.ok(REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS <= 10_000, 'self-heal must stay useful while the lane is parked')
})

test('only recovery evidence after a real stability window resets the mux cadence', () => {
  // The reset is gated on evidence, so the window has to OUTLIVE every backoff rung:
  // a socket that merely survived one interval is not proof the path recovered, while
  // one that survived a whole flapping cycle is.
  assert.equal(REMOTE_STREAM_STABLE_CARRIER_MIN_MS, 30_000)
  assert.ok(REMOTE_STREAM_STABLE_CARRIER_MIN_MS > REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS)
  assert.ok(REMOTE_STREAM_STABLE_CARRIER_MIN_MS >= 2 * REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS,
    'the window must outlive the widest cadence rung, not just match it')
})


test('the silent-carrier verdict belongs to the reducer, not this module (P3)', () => {
  // The predicate that used to live here is retired: stream-client reports the
  // frame delta with the rebuild request and reads the verdict back off the
  // effects (`socketNoFrame` vs the threshold-gated `openingStall`). The truth
  // table now lives in the package carrier suite; this pins the wiring so the
  // host cannot quietly reintroduce a second verdict.
  const source = (relative: string): string =>
    readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
  assert.doesNotMatch(source('src/client/remote-retry-policy.ts'), /shouldReplaceSilentSocket|framesReceivedSinceSend/u)
  assert.match(source('src/client/stream-client.ts'), /kind: 'openingExpired',/u)
  assert.match(source('src/client/stream-client.ts'), /framesSinceSend: this\.socketFrames - framesAtSend/u)
})

test('the teardown evidence window stays inside every window it must serve', () => {
  // The teardown escalation exists for the journal watchdog's sibling probe, which
  // aborts at probeTimeoutMs — before the mux opening deadline can fire — so the
  // minimum life must sit BELOW that probe window (or the probe teardown it exists
  // for would always be judged too young) and below the opening deadline (anything
  // that waits longer is the deadline path's verdict).
  assert.equal(SILENT_TEARDOWN_MIN_MS, 15_000)
  assert.ok(SILENT_TEARDOWN_MIN_MS < DEFAULT_STREAM_STALL_TIMING.probeTimeoutMs,
    'the watchdog probe window must be able to reach the bound')
  assert.ok(SILENT_TEARDOWN_MIN_MS < OPENING_TIMEOUT_MS,
    'a stream that outlives this bound is judged by the opening deadline instead')
})

