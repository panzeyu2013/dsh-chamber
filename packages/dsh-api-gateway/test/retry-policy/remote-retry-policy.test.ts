/**
 * Carrier-retry pacing truth table (chamber fork patch, design 14 §D4).
 * A SECOND carrier failure inside one live connection generation is paced and
 * reopened instead of escaping terminally, so the delay function is the contract:
 * immediate once, then double up to a cap.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  delayRemoteStreamRetry,
  REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS,
  REMOTE_STREAM_RETRY_BASE_MS,
  REMOTE_STREAM_RETRY_FIRST_MS,
  REMOTE_STREAM_RETRY_MAX_MS,
  remoteStreamRetryDelayMs,
  REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS,
  shouldReplaceSilentSocket,
  streamOpeningKey,
} from '../../src/client/remote-retry-policy.ts'
import { DEFAULT_STREAM_STALL_TIMING } from '../../src/client/stream-stall-policy.ts'
// The opening-budget ladder and the silent-teardown floor are the SHARED table's now
// (retry policy no longer owns a copy): the widening truth is pinned by
// packages/dsh-stream-state/test/carrier/carrier-lifecycle.test.ts:139-152.
import { openingBudgetMs, SILENT_TEARDOWN_MIN_MS } from '@dsh-chamber/dsh-stream-state'
import { setTimeout as delay } from 'node:timers/promises'

test('the first carrier failure of an episode reopens immediately', () => {
  assert.equal(REMOTE_STREAM_RETRY_FIRST_MS, 0)
  assert.equal(remoteStreamRetryDelayMs(1), 0)
})

test('the wait for a live generation is bounded (a parked lane cannot park a stream forever)', () => {
  // Above the retry ceiling: one reopen per ceiling is the slowest useful pace,
  // and the bound must not be tighter than that pace.
  assert.ok(REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS >= REMOTE_STREAM_RETRY_MAX_MS)
  // ...and bounded: past a minute the state is not "waiting", it is a dead lane,
  // and the surface must have had at least one reopen attempt by then.
  assert.ok(REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS <= 60_000)
  assert.ok(REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS > 0)
})

test('later failures double from the base', () => {
  assert.equal(remoteStreamRetryDelayMs(2), REMOTE_STREAM_RETRY_BASE_MS)
  assert.equal(remoteStreamRetryDelayMs(3), REMOTE_STREAM_RETRY_BASE_MS * 2)
  assert.equal(remoteStreamRetryDelayMs(4), REMOTE_STREAM_RETRY_BASE_MS * 4)
  assert.equal(remoteStreamRetryDelayMs(5), REMOTE_STREAM_RETRY_BASE_MS * 8)
})

test('the backoff is capped, so a persistent fault settles into one reopen per ceiling', () => {
  assert.ok(remoteStreamRetryDelayMs(8) === REMOTE_STREAM_RETRY_MAX_MS, 'attempt 8 reaches the ceiling')
  assert.equal(remoteStreamRetryDelayMs(9), REMOTE_STREAM_RETRY_MAX_MS)
  assert.equal(remoteStreamRetryDelayMs(64), REMOTE_STREAM_RETRY_MAX_MS)
  assert.equal(remoteStreamRetryDelayMs(1_000_000), REMOTE_STREAM_RETRY_MAX_MS)
})

test('the delay is monotone non-decreasing and never exceeds the ceiling', () => {
  let previous = -1
  for (let attempt = 1; attempt <= 40; attempt++) {
    const delay = remoteStreamRetryDelayMs(attempt)
    assert.ok(delay >= previous, 'attempt ' + attempt + ' must not shrink the delay')
    assert.ok(delay <= REMOTE_STREAM_RETRY_MAX_MS, 'attempt ' + attempt + ' must stay capped')
    assert.ok(Number.isInteger(delay), 'attempt ' + attempt + ' must be whole milliseconds')
    previous = delay
  }
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
  }
})

test('the opening budget clears the measured healthy Host answer by orders of magnitude', () => {
  // Measured Host answers: session snapshot 57 ms, subagent snapshot 73 ms. The
  // exact rungs are the shared table's (carrier-lifecycle.test.ts pins them); this
  // pins the SHAPE the deadline depends on — far above a healthy answer, still a
  // bound a user would call "stuck for a moment".
  const base = openingBudgetMs(0)
  const ceiling = openingBudgetMs(Number.MAX_SAFE_INTEGER)
  assert.ok(base >= 10_000)
  assert.ok(ceiling >= 240_000,
    'the ceiling is the widest single Host load the retry ladder can ever complete')
  assert.ok(ceiling <= 600_000)
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

test('a socket that delivered nothing across the opening window must be replaced', () => {
  // A healthy socket answers every open (measured ~25 ms through the proxy), so a
  // socket that produced ZERO frames through a ≥30 s window while an open was
  // pending is dead, not slow: re-issuing on it can never succeed and the widened
  // budget only makes the stall longer.
  assert.equal(shouldReplaceSilentSocket(0), true)
  assert.equal(shouldReplaceSilentSocket(1), false)
  assert.equal(shouldReplaceSilentSocket(37), false)
})

test('an unknown frame baseline never churns the carrier', () => {
  for (const frames of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(shouldReplaceSilentSocket(frames), false, String(frames))
  }
})

test('the teardown evidence window stays inside every window it must serve', () => {
  // The teardown escalation exists for the journal watchdog's sibling probe, which
  // aborts at probeTimeoutMs — before the mux opening budget can fire — so the
  // minimum life must sit BELOW that probe window (or the probe teardown it exists
  // for would always be judged too young) and below the opening budget (anything
  // that waits longer is the deadline path's verdict).
  // Both values are the shared table's now; this is the cross-module ordering the
  // fork depends on.
  assert.equal(SILENT_TEARDOWN_MIN_MS, 15_000)
  assert.ok(SILENT_TEARDOWN_MIN_MS < DEFAULT_STREAM_STALL_TIMING.probeTimeoutMs,
    'the watchdog probe window must be able to reach the bound')
  assert.ok(SILENT_TEARDOWN_MIN_MS < openingBudgetMs(0),
    'a stream that outlives this bound is judged by the opening deadline instead')
})

