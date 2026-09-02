/**
 * mount-retry.ts unit tests (plain node:test, no dsh, no DOM): the
 * settings-shell session-mount bounded-backoff schedule — per-step delays
 * (1s, 2s, 4s, 8s), the ~15s worst-case budget, and budget exhaustion.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MOUNT_RETRY_ATTEMPTS,
  MOUNT_RETRY_BASE_DELAY_MS,
  MOUNT_RETRY_MAX_DELAY_MS,
  mountRetryDelayMs,
  nextMountRetryDelayMs,
} from '../src/client/mount-retry.ts'

test('backoff doubles per consecutive failure, capped per step', () => {
  assert.equal(mountRetryDelayMs(1), 1000)
  assert.equal(mountRetryDelayMs(2), 2000)
  assert.equal(mountRetryDelayMs(3), 4000)
  assert.equal(mountRetryDelayMs(4), 8000)
  assert.equal(mountRetryDelayMs(5), 8000, 'a step never waits past the cap')
  assert.equal(mountRetryDelayMs(99), 8000)
})

test('the worst-case wait across the full retry budget is ~15s', () => {
  let total = 0
  for (let failures = 1; failures < MOUNT_RETRY_ATTEMPTS; failures += 1) {
    const delay = nextMountRetryDelayMs(failures)
    assert.notEqual(delay, null, `failure ${failures} must still be within the budget`)
    total += delay as number
  }
  assert.equal(total, 15000)
})

test('the budget is bounded: no retry once the attempt bound is reached', () => {
  assert.equal(nextMountRetryDelayMs(0), null, 'nothing failed yet — no retry to schedule')
  assert.equal(nextMountRetryDelayMs(MOUNT_RETRY_ATTEMPTS - 1), mountRetryDelayMs(MOUNT_RETRY_ATTEMPTS - 1))
  assert.equal(nextMountRetryDelayMs(MOUNT_RETRY_ATTEMPTS), null, 'budget exhausted — fail loud')
  assert.equal(nextMountRetryDelayMs(MOUNT_RETRY_ATTEMPTS + 5), null, 'never beyond the bound')
})

test('constants pin the intended schedule (1s base, 8s step cap, 5 attempts)', () => {
  assert.equal(MOUNT_RETRY_BASE_DELAY_MS, 1000)
  assert.equal(MOUNT_RETRY_MAX_DELAY_MS, 8000)
  assert.equal(MOUNT_RETRY_ATTEMPTS, 5)
})
