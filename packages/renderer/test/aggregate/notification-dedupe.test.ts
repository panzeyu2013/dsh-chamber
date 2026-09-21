/**
 * 通知第二入口的水位去重契约（主计划 §5-16 / R6；蓝图 §2-接线 3）：
 * 首见只播种、同水位不重发、更高水位放行、坏值不臆造。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { completionWatermark, nextNotifiedWatermark, shouldNotifyWatermark } from '../../src/notification-dedupe.ts'

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
})

test('completion watermark = max(completedAt, updatedAt); empty is undefined', () => {
  assert.equal(completionWatermark({ completedAt: 5, updatedAt: 9 }), 9)
  assert.equal(completionWatermark({ completedAt: 9, updatedAt: 5 }), 9)
  assert.equal(completionWatermark({ completedAt: 0, updatedAt: 0 }), undefined)
  assert.equal(completionWatermark({ completedAt: null }), undefined)
  assert.equal(completionWatermark({}), undefined)
})
