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
  REMOTE_STREAM_RETRY_BASE_MS,
  REMOTE_STREAM_RETRY_FIRST_MS,
  REMOTE_STREAM_RETRY_MAX_MS,
  remoteStreamRetryDelayMs,
} from '../../src/client/remote-retry-policy.ts'
import { setTimeout as delay } from 'node:timers/promises'

test('the first carrier failure of an episode reopens immediately', () => {
  assert.equal(REMOTE_STREAM_RETRY_FIRST_MS, 0)
  assert.equal(remoteStreamRetryDelayMs(1), 0)
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
