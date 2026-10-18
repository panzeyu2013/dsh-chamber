/**
 * Bounded "not dispatched" retry schedule (design 08 §5): a refusal earns a short
 * exponential retry, then the 30s tick owns the source again — an unbounded 3s
 * chain would keep loading a saturated page and would outlive detach.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOT_DISPATCHED_RETRY_MAX_ATTEMPTS,
  notDispatchedRetryDelay,
} from '../../src/shared/retry-budget.ts'

test('notDispatchedRetryDelay: 3s, 6s, 12s, then the budget is spent', () => {
  assert.equal(notDispatchedRetryDelay(0), 3_000)
  assert.equal(notDispatchedRetryDelay(1), 6_000)
  assert.equal(notDispatchedRetryDelay(2), 12_000)
  assert.equal(notDispatchedRetryDelay(NOT_DISPATCHED_RETRY_MAX_ATTEMPTS), null)
  assert.equal(notDispatchedRetryDelay(0.9), 3_000, 'a fractional attempt truncates')
})

test('notDispatchedRetryDelay: invalid attempts never schedule', () => {
  assert.equal(notDispatchedRetryDelay(-1), null)
  assert.equal(notDispatchedRetryDelay(Number.NaN), null)
  assert.equal(notDispatchedRetryDelay(Number.POSITIVE_INFINITY), null)
})
