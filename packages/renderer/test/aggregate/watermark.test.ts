/**
 * 水位原语单一来源契约：合法水位判定、max 组合、完成水位组成。
 * 去重已改为运行身份（notification-identity），本文件不再有单调记忆判定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { completionWatermark, isWatermark, maxWatermarkValue } from '../../src/watermark.ts'

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

test('completion watermark = max(completedAt, updatedAt); empty is undefined', () => {
  assert.equal(completionWatermark({ completedAt: 5, updatedAt: 9 }), 9)
  assert.equal(completionWatermark({ completedAt: 9, updatedAt: 5 }), 9)
  assert.equal(completionWatermark({ completedAt: 0, updatedAt: 0 }), undefined)
  assert.equal(completionWatermark({ completedAt: null }), undefined)
  assert.equal(completionWatermark({}), undefined)
})
