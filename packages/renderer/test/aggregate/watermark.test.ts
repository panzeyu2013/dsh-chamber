/**
 * 水位原语单一来源契约（2026-12 阶段 2 单源化）：首见只播种、同水位不重发、
 * 更高水位放行、坏值不臆造；max/completion 组成的负例同样钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  completionWatermark, isWatermark, maxWatermarkValue, nextNotifiedWatermark, shouldNotifyWatermark,
} from '../../src/watermark.ts'

test('isWatermark: only non-negative safe integers are watermarks', () => {
  assert.equal(isWatermark(0), true)
  assert.equal(isWatermark(1_700_000_000_000), true)
  assert.equal(isWatermark(Number.MAX_SAFE_INTEGER), true)
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '5', null, undefined, {}, []]) {
    assert.equal(isWatermark(bad), false, String(bad))
  }
})

test('maxWatermarkValue: max of the valid candidates, 0 when none is valid', () => {
  assert.equal(maxWatermarkValue(5, 9), 9)
  assert.equal(maxWatermarkValue(undefined, 4, null), 4)
  assert.equal(maxWatermarkValue(), 0)
  assert.equal(maxWatermarkValue(Number.NaN, -3, 1.5), 0)
})

test('first observation never notifies (baseline seeds silently)', () => {
  assert.equal(shouldNotifyWatermark(undefined, 100), false)
  assert.equal(shouldNotifyWatermark(undefined, 0), false)
})

test('the same watermark never re-notifies; a strictly higher one does', () => {
  assert.equal(shouldNotifyWatermark(100, 100), false)
  assert.equal(shouldNotifyWatermark(100, 99), false)
  assert.equal(shouldNotifyWatermark(100, 101), true)
  assert.equal(shouldNotifyWatermark(0, 1), true)
})

test('invalid watermarks are refused instead of guessed', () => {
  assert.equal(shouldNotifyWatermark(100, undefined), false)
  assert.equal(shouldNotifyWatermark(100, 1.5), false)
  assert.equal(shouldNotifyWatermark(100, -1), false)
  assert.equal(shouldNotifyWatermark(Number.NaN, 100), false)
})

test('notified watermark memory is monotonic and keeps prev on bad input', () => {
  assert.equal(nextNotifiedWatermark(undefined, 100), 100)
  assert.equal(nextNotifiedWatermark(100, 100), 100)
  assert.equal(nextNotifiedWatermark(100, 99), 100)
  assert.equal(nextNotifiedWatermark(100, 101), 101)
  assert.equal(nextNotifiedWatermark(100, undefined), 100)
  assert.equal(nextNotifiedWatermark(100, -5), 100)
})

test('completion watermark = max(completedAt, updatedAt); empty is undefined', () => {
  assert.equal(completionWatermark({ completedAt: 5, updatedAt: 9 }), 9)
  assert.equal(completionWatermark({ completedAt: 9, updatedAt: 5 }), 9)
  assert.equal(completionWatermark({ completedAt: 0, updatedAt: 0 }), undefined)
  assert.equal(completionWatermark({ completedAt: null }), undefined)
  assert.equal(completionWatermark({}), undefined)
})

test('completion watermark refuses non-integer candidates instead of truncating', () => {
  assert.equal(completionWatermark({ completedAt: 1.5, updatedAt: 9 }), 9)
  assert.equal(completionWatermark({ completedAt: 9, updatedAt: Number.NaN }), 9)
  assert.equal(completionWatermark({ completedAt: -9, updatedAt: 0 }), undefined)
  assert.equal(completionWatermark({ completedAt: null, updatedAt: undefined }), undefined)
})
