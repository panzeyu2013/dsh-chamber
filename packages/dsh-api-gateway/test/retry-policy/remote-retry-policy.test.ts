/**
 * Carrier-retry pacing truth table (chamber fork patch, design 14 §D4).
 *
 * A SECOND carrier failure inside one live connection generation is paced and
 * reopened instead of escaping terminally, so the delay function is the contract:
 * immediate once, then double up to a cap.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  delayRemoteStreamRetry,
  REMOTE_STREAM_OPENING_ESCALATION_COOLDOWN_MS,
  REMOTE_STREAM_OPENING_ESCALATION_STREAK,
  REMOTE_STREAM_OPENING_TIMEOUT_MAX_MS,
  REMOTE_STREAM_OPENING_TIMEOUT_MS,
  REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS,
  REMOTE_STREAM_RETRY_BASE_MS,
  REMOTE_STREAM_RETRY_FIRST_MS,
  REMOTE_STREAM_RETRY_MAX_MS,
  remoteStreamOpeningTimeoutMs,
  remoteStreamRetryDelayMs,
  REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS,
  shouldEscalateOpeningStall,
  streamOpeningKey,
} from '../../src/client/remote-retry-policy.ts'
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

test('the opening-item budget starts tight and widens only while timeouts stay consecutive', () => {
  assert.equal(REMOTE_STREAM_OPENING_TIMEOUT_MS, 30_000)
  assert.equal(remoteStreamOpeningTimeoutMs(0), REMOTE_STREAM_OPENING_TIMEOUT_MS)
  assert.equal(remoteStreamOpeningTimeoutMs(1), 60_000)
  assert.equal(remoteStreamOpeningTimeoutMs(2), REMOTE_STREAM_OPENING_TIMEOUT_MAX_MS)
  assert.equal(remoteStreamOpeningTimeoutMs(9), REMOTE_STREAM_OPENING_TIMEOUT_MAX_MS)
})

test('the opening budget is monotone and never leaves its bounds', () => {
  let previous = 0
  for (let streak = 0; streak <= 40; streak++) {
    const budget = remoteStreamOpeningTimeoutMs(streak)
    assert.ok(budget >= REMOTE_STREAM_OPENING_TIMEOUT_MS, 'streak ' + String(streak) + ' stays above the base')
    assert.ok(budget <= REMOTE_STREAM_OPENING_TIMEOUT_MAX_MS, 'streak ' + String(streak) + ' stays capped')
    assert.ok(budget >= previous, 'streak ' + String(streak) + ' must not shrink the budget')
    assert.ok(Number.isInteger(budget), 'streak ' + String(streak) + ' must be whole milliseconds')
    previous = budget
  }
})

test('the opening budget clears the measured healthy Host answer by orders of magnitude', () => {
  // Measured 2026-09 through the control-plane proxy: $events ready 25 ms,
  // session snapshot 57 ms, subagent snapshot 73 ms. The base must be far above
  // those while remaining a bound a user would still call "stuck for a moment".
  assert.ok(REMOTE_STREAM_OPENING_TIMEOUT_MS >= 10_000)
  assert.ok(REMOTE_STREAM_OPENING_TIMEOUT_MAX_MS <= 300_000)
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

test('degenerate opening streaks fail safe to the base budget', () => {
  for (const streak of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(remoteStreamOpeningTimeoutMs(streak), REMOTE_STREAM_OPENING_TIMEOUT_MS, String(streak))
  }
})

test('an unanswered opening escalates to a physical rebuild only after a whole extra budget', () => {
  // The bound must sit strictly above the FIRST timeout: one unanswered deadline
  // is still the retry lane's business (a slow-but-working Host may answer the
  // reopened request inside the widened budget), and strictly below unlimited.
  assert.equal(REMOTE_STREAM_OPENING_ESCALATION_STREAK, 2)
  assert.equal(shouldEscalateOpeningStall(0, undefined, 0), false)
  assert.equal(shouldEscalateOpeningStall(1, undefined, 0), false, 'the first timeout must never rebuild the carrier')
  assert.equal(shouldEscalateOpeningStall(REMOTE_STREAM_OPENING_ESCALATION_STREAK, undefined, 0), true)
  assert.equal(shouldEscalateOpeningStall(9, undefined, 0), true)
})

test('the escalation cooldown bounds carrier rebuilds to one per minute', () => {
  assert.equal(REMOTE_STREAM_OPENING_ESCALATION_COOLDOWN_MS, 60_000)
  const at = 1_000_000
  assert.equal(shouldEscalateOpeningStall(2, at, at), false, 'a rebuild must not repeat inside the cooldown')
  assert.equal(shouldEscalateOpeningStall(2, at, at + REMOTE_STREAM_OPENING_ESCALATION_COOLDOWN_MS - 1), false)
  assert.equal(shouldEscalateOpeningStall(2, at, at + REMOTE_STREAM_OPENING_ESCALATION_COOLDOWN_MS), true)
})

test('degenerate escalation inputs fail safe to no rebuild', () => {
  for (const streak of [Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.equal(shouldEscalateOpeningStall(streak, undefined, 0), false, String(streak))
  }
  assert.equal(shouldEscalateOpeningStall(2, Number.NaN, 0), false, 'an unusable account must not rebuild')
})
