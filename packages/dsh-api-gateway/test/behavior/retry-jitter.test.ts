/**
 * P1-4 retry jitter — the cross-cutting acceptance suite (plan §4.8).
 *
 * WHY THIS FILE EXISTS. The carrier retry lane is the one place a single physical
 * failure fans out to every logical stream, so the pacing math must both widen (no
 * hot loop) and SPREAD (no stampede). The truth table lives in
 * test/retry-policy/remote-retry-policy.test.ts; this suite pins the cross-cutting
 * contract the mux fork relies on:
 *
 *  - attempt 1 stays immediate, so a lost socket still reopens without waiting;
 *  - every later wait is drawn from [half, full] of the capped doubling backoff, so
 *    jitter can never turn the pacing into a hot loop or exceed the ceiling;
 *  - a broken/out-of-range injected RNG fails safe instead of throwing into the retry
 *    lane (a non-carrier escape there would become terminal);
 *  - the mux resets its OWN self-heal cadence only on recovery evidence (a delivered
 *    frame, or an open socket outliving the stability window), never on a bare
 *    handshake or a lane-driven replacement.
 *
 * The last item is structural here and behavioural in test/behavior/mux-self-heal.test.ts
 * (virtual clock): deleting the evidence gate makes that suite's "open socket that never
 * delivered a frame does not reset the self-heal cadence" test red. This file stays
 * dependency-free on purpose, so it runs with plain `node <file>` (the acceptance
 * command) even in a checkout without the vendor tree.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS,
  REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS,
  REMOTE_STREAM_REOPEN_JITTER_MAX_MS,
  REMOTE_STREAM_RETRY_BASE_MS,
  REMOTE_STREAM_RETRY_FIRST_MS,
  REMOTE_STREAM_RETRY_MAX_MS,
  REMOTE_STREAM_STABLE_CARRIER_MIN_MS,
  remoteStreamReopenJitterMs,
  remoteStreamRetryDelayMs,
} from '../../src/client/remote-retry-policy.ts'

/** The capped exponential a later attempt is drawn under. */
function effectiveBackoff(attempt: number): number {
  return Math.min(
    REMOTE_STREAM_RETRY_BASE_MS * 2 ** Math.min(Math.floor(attempt) - 2, 16),
    REMOTE_STREAM_RETRY_MAX_MS,
  )
}

/** Deterministic uniform sample (LCG): distribution tests must not flake in CI. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

test('the first failure of an episode is immediate, not a jitter draw', () => {
  assert.equal(REMOTE_STREAM_RETRY_FIRST_MS, 0)
  assert.equal(remoteStreamRetryDelayMs(1), 0)
  assert.equal(remoteStreamRetryDelayMs(1, () => 0), 0)
  assert.equal(remoteStreamRetryDelayMs(1, () => 1), 0)
  assert.equal(remoteStreamRetryDelayMs(1, () => { throw new Error('rng down') }), 0)
})

test('later reopens are half-jittered inside [half, full] of the capped backoff', () => {
  const random = seededRandom(0x5eed_1234)
  for (let attempt = 2; attempt <= 40; attempt++) {
    const effective = effectiveBackoff(attempt)
    for (let draw = 0; draw < 32; draw++) {
      const delay = remoteStreamRetryDelayMs(attempt, random)
      assert.ok(Number.isInteger(delay), 'attempt ' + String(attempt) + ' must be whole milliseconds')
      assert.ok(delay >= Math.floor(effective * 0.5),
        'attempt ' + String(attempt) + ' must keep at least half the backoff (got ' + String(delay) + ')')
      assert.ok(delay <= effective,
        'attempt ' + String(attempt) + ' must never exceed the effective backoff (got ' + String(delay) + ')')
    }
  }
})

test('the injected extremes pin the band edges exactly', () => {
  for (const attempt of [2, 3, 4, 5]) {
    const effective = effectiveBackoff(attempt)
    assert.equal(remoteStreamRetryDelayMs(attempt, () => 0), Math.floor(effective / 2), 'attempt ' + String(attempt))
    assert.equal(remoteStreamRetryDelayMs(attempt, () => 1), effective, 'attempt ' + String(attempt))
  }
})

test('jitter spreads one failure fan-out instead of collapsing it', () => {
  // 128 logical streams reopened by ONE carrier failure: the distinct millisecond values
  // are the anti-stampede property. All equal would mean the jitter is not wired.
  const random = seededRandom(0xc0ff_ee11)
  const delays = new Set<number>()
  for (let index = 0; index < 128; index++) delays.add(remoteStreamRetryDelayMs(2, random))
  assert.ok(delays.size >= 30, 'expected a spread of reopen times, got ' + String(delays.size) + ' distinct values')
  for (const delay of delays) assert.ok(delay >= 125 && delay <= 250, String(delay))
})

test('a persistent fault still settles at the ceiling, never past it', () => {
  for (const attempt of [8, 9, 32, 1_000_000]) {
    assert.equal(effectiveBackoff(attempt), REMOTE_STREAM_RETRY_MAX_MS, 'attempt ' + String(attempt))
    assert.equal(remoteStreamRetryDelayMs(attempt, () => 1), REMOTE_STREAM_RETRY_MAX_MS)
    assert.equal(remoteStreamRetryDelayMs(attempt, () => 0), REMOTE_STREAM_RETRY_MAX_MS / 2)
  }
})

test('a broken injected RNG fails safe to the un-jittered backoff', () => {
  const attempt = 4
  const effective = effectiveBackoff(attempt)
  assert.equal(remoteStreamRetryDelayMs(attempt, () => { throw new Error('rng rejected') }), effective)
  for (const sample of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(remoteStreamRetryDelayMs(attempt, () => sample), effective, String(sample))
  }
  assert.equal(remoteStreamRetryDelayMs(attempt, () => -1), effective / 2, 'out-of-range samples clamp')
  assert.equal(remoteStreamRetryDelayMs(attempt, () => 2), effective, 'out-of-range samples clamp')
})

test('the failure fan-out gets its own bounded per-stream spread', () => {
  // One socket death fails every logical stream in the same tick, and attempt 1 has no
  // backoff; this draw is the only thing that separates their first reopens.
  assert.equal(REMOTE_STREAM_REOPEN_JITTER_MAX_MS, 250)
  assert.equal(remoteStreamReopenJitterMs(() => 0), 0)
  assert.equal(remoteStreamReopenJitterMs(() => 0.5), 125)
  assert.equal(remoteStreamReopenJitterMs(() => 1), 250)
  assert.equal(remoteStreamReopenJitterMs(() => { throw new Error('rng rejected') }), 0,
    'a broken RNG must fail safe to an immediate reopen, never throw into the retry lane')
  for (const sample of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    assert.equal(remoteStreamReopenJitterMs(() => sample), 0, String(sample))
  }
  assert.equal(remoteStreamReopenJitterMs(() => 2), REMOTE_STREAM_REOPEN_JITTER_MAX_MS)
})

test('the mux threads ONE injectable RNG into the failure fan-out', () => {
  const client = clientSource()
  assert.match(client, /random\?: \(\) => number/u)
  assert.match(client, /this\.random = options\.random \?\? Math\.random/u)
  assert.match(client, /remoteStreamReopenJitterMs\(this\.random\)/u)
  assert.match(client, /jittered\.reopenJitterMs = spread/u)
  // The failure is still delivered synchronously: the spread is a field on the error,
  // consumed by RemoteStream's attempt-1 wait — never a delayed inbox fail.
  const failAll = bodyBetween(client, 'private failAll(', 'private send(')
  assert.doesNotMatch(failAll, /setTimeout|queueMicrotask/u, 'failAll must not delay delivery')
})

/* ---------------------------------------------------------------------------
 * The mux self-heal cadence: a reset needs recovery EVIDENCE.
 * ------------------------------------------------------------------------- */

const clientSource = (): string =>
  readFileSync(new URL('../../src/client/stream-client.ts', import.meta.url), 'utf8')

/** Slice one source block; a refactor that drops a marker fails loudly here. */
function bodyBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0, 'expected block ' + JSON.stringify(start) + ' to be locatable')
  assert.ok(to > from, 'expected block ' + JSON.stringify(start) + ' to be closed by ' + JSON.stringify(end))
  return source.slice(from, to)
}

test('the stability window is a real window: wider than every self-heal rung', () => {
  assert.equal(REMOTE_STREAM_STABLE_CARRIER_MIN_MS, 30_000)
  assert.ok(REMOTE_STREAM_STABLE_CARRIER_MIN_MS >= 2 * REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS,
    'a stable socket must outlive the widest cadence rung before its life is evidence')
  assert.ok(REMOTE_STREAM_STABLE_CARRIER_MIN_MS > REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS)
})

test('the mux resets its cadence only through the one evidence-gated method', () => {
  const client = clientSource()
  // ONE reset site, and it is the named evidence helper.
  assert.equal([...client.matchAll(/this\.maintainIntervalMs = REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS/gu)].length, 1,
    'exactly one assignment to the cadence may exist')
  const note = bodyBetween(client, 'private noteStableCarrier(): void {', '  private maintain()')
  assert.match(note, /this\.maintainIntervalMs = REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS/u)
  // The bare handshake no longer resets it (the regression this gate removes).
  const opened = bodyBetween(client, 'const opened = (): void => {', 'const failed = (): void => {')
  assert.match(opened, /this\.socketOpenedAt = Date\.now\(\)/u, 'an open starts the stability clock')
  assert.doesNotMatch(opened, /maintainIntervalMs/u, 'a bare open must not reset the cadence')
  // The two evidence arms: a delivered frame, and an open socket outliving the window.
  const receive = bodyBetween(client, 'private receive(socket: ConnectionWebSocket, data: unknown): void {', 'private lost(')
  assert.match(receive, /this\.socketFrames === 1 && socket\.readyState === 1\) this\.noteStableCarrier\(\)/u)
  const lost = bodyBetween(client, 'private lost(', 'private scheduleMaintain')
  assert.match(lost, /Date\.now\(\) - this\.socketOpenedAt >= REMOTE_STREAM_STABLE_CARRIER_MIN_MS/u)
  assert.match(lost, /this\.noteStableCarrier\(\)/u)
  // A lane-driven replacement (or a silent-socket verdict) is NOT recovery evidence; the
  // reset must not creep back into replaceSocket.
  const replace = bodyBetween(client, 'private replaceSocket(', '  /**\n   * Open one logical stream on the persistent physical connection.')
  assert.doesNotMatch(replace, /maintainIntervalMs/u, 'replaceSocket must not reset the cadence')
})

test('the mux imports the shared stability constant instead of a second copy', () => {
  const client = clientSource()
  assert.match(client, /REMOTE_STREAM_STABLE_CARRIER_MIN_MS,/u)
  assert.doesNotMatch(client, /30_000|30000/u, 'a literal 30 s copy must not reappear in the mux')
})
