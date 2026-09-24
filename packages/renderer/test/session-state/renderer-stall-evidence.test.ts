/**
 * 桌面 stall 证据注册表：push 订阅入口 → 页面证据。形状校验、latest-wins、
 * 过期即视为清除（漏掉的 clear 不能永久授权升级）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RENDERER_STALL_EVIDENCE_VALID_MS,
  publishRendererStallObservation,
  readRendererStallStrikes,
  resetRendererStallEvidence,
} from '../../src/renderer-stall-evidence.ts'

test('renderer stall evidence: validated, latest-wins, expires after the validity window', () => {
  resetRendererStallEvidence()
  assert.deepEqual(readRendererStallStrikes(1_000), { scheduleStrikes: 0, inputBlockStrikes: 0, observedAt: undefined })
  publishRendererStallObservation({ scheduleStrikes: 2, inputBlockStrikes: 0, at: 1_000 })
  assert.deepEqual(readRendererStallStrikes(1_500), { scheduleStrikes: 2, inputBlockStrikes: 0, observedAt: 1_000 })
  publishRendererStallObservation({ scheduleStrikes: 0, inputBlockStrikes: 3, at: 2_000 })
  assert.deepEqual(readRendererStallStrikes(2_100), { scheduleStrikes: 0, inputBlockStrikes: 3, observedAt: 2_000 })
  assert.deepEqual(readRendererStallStrikes(2_000 + RENDERER_STALL_EVIDENCE_VALID_MS + 1),
    { scheduleStrikes: 0, inputBlockStrikes: 0, observedAt: undefined }, 'a missed clear must expire')
  const bad: unknown[] = [null, 'x', {}, { scheduleStrikes: -1, inputBlockStrikes: 0, at: 1 },
    { scheduleStrikes: 0, inputBlockStrikes: 1.5, at: 1 }, { scheduleStrikes: 0, inputBlockStrikes: 0, at: 0 }]
  for (const value of bad) publishRendererStallObservation(value)
  assert.equal(readRendererStallStrikes(2_000).inputBlockStrikes, 3, 'invalid pushes are ignored; the last valid observation stands')
})
