/**
 * P3 单通知投影契约：两条证据、一个策略、一个账本键空间。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  planFactsNotifications,
  planRuntimeNotifications,
  type NotificationFactsRow,
} from '../../src/notification-projection.ts'

type Facts = { completedAt: number | null; completedAtSource?: 'observed' | 'reconstructed'; updatedAt: number; subagentCount: number }
const row = (over: Partial<Facts> = {}): NotificationFactsRow => ({
  completedAt: 2_000,
  completedAtSource: 'observed',
  updatedAt: 1_000,
  subagentCount: 0,
  ...over,
})

test('runtime first report seeds without emitting', () => {
  const plan = planRuntimeNotifications({
    prev: undefined,
    next: { s1: { running: true } },
    factsUsable: false,
    armed: new Set(),
  })
  assert.deepEqual(plan.edges, [])
  assert.deepEqual([...plan.armed], [])
})

test('runtime running true->false emits exactly one complete and arms', () => {
  const plan = planRuntimeNotifications({
    prev: { s1: { running: true } },
    next: { s1: { running: false } },
    factsUsable: false,
    armed: new Set(),
  })
  assert.deepEqual(plan.edges, [{ sessionId: 's1', kind: 'complete' }])
  assert.deepEqual([...plan.armed], ['s1'])
})

test('runtime re-running disarms, so the next completion notifies again', () => {
  const first = planRuntimeNotifications({
    prev: { s1: { running: true } },
    next: { s1: { running: false } },
    factsUsable: false,
    armed: new Set(),
  })
  const again = planRuntimeNotifications({
    prev: { s1: { running: false } },
    next: { s1: { running: true } },
    factsUsable: false,
    armed: first.armed,
  })
  assert.deepEqual(again.edges, [])
  assert.deepEqual([...again.armed], [])
  const second = planRuntimeNotifications({
    prev: { s1: { running: true } },
    next: { s1: { running: false } },
    factsUsable: false,
    armed: again.armed,
  })
  assert.deepEqual(second.edges, [{ sessionId: 's1', kind: 'complete' }])
})

test('runtime completes are suppressed when usable facts own the completion', () => {
  const plan = planRuntimeNotifications({
    prev: { s1: { running: true, pending: 'question' } },
    next: { s1: { running: false, pending: 'approval' } },
    factsUsable: true,
    armed: new Set(),
  })
  assert.deepEqual(plan.edges, [{ sessionId: 's1', kind: 'request' }], 'pending still flows; complete does not')
  assert.deepEqual([...plan.armed], [])
})

test('runtime does not complete while a subagent is still running', () => {
  const plan = planRuntimeNotifications({
    prev: { s1: { running: true } },
    next: { s1: { running: false, runningSubagents: 1 } },
    factsUsable: false,
    armed: new Set(),
  })
  assert.deepEqual(plan.edges, [])
  assert.deepEqual([...plan.armed], [])
})

test('runtime vendor completed false->true is a complete edge', () => {
  const plan = planRuntimeNotifications({
    prev: { s1: { running: false } },
    next: { s1: { running: false, completed: true } },
    factsUsable: false,
    armed: new Set(),
  })
  assert.deepEqual(plan.edges, [{ sessionId: 's1', kind: 'complete' }])
})

test('facts first snapshot only seeds the watermark', () => {
  const plan = planFactsNotifications({
    rows: { s1: row({ completedAt: 2_000, updatedAt: 1_500 }) },
    seeded: false,
    watermarks: {},
    armed: new Set(),
  })
  assert.deepEqual(plan.edges, [])
  assert.deepEqual(plan.watermarks, { s1: 2_000 })
})

test('facts emits once when the watermark strictly advances', () => {
  const plan = planFactsNotifications({
    rows: { s1: row({ completedAt: 3_000, updatedAt: 1_500 }) },
    seeded: true,
    watermarks: { s1: 2_000 },
    armed: new Set(),
  })
  assert.deepEqual(plan.edges, [{ sessionId: 's1', kind: 'complete', watermark: 3_000 }])
  assert.deepEqual(plan.watermarks, { s1: 3_000 })
})

test('facts never re-emits the same or a lower watermark', () => {
  const same = planFactsNotifications({
    rows: { s1: row({ completedAt: 2_000 }) },
    seeded: true,
    watermarks: { s1: 2_000 },
    armed: new Set(),
  })
  assert.deepEqual(same.edges, [])
  const lower = planFactsNotifications({
    rows: { s1: row({ completedAt: 1_000, updatedAt: 500 }) },
    seeded: true,
    watermarks: { s1: 2_000 },
    armed: new Set(),
  })
  assert.deepEqual(lower.edges, [])
  assert.deepEqual(lower.watermarks, { s1: 2_000 })
})

test('facts records the watermark but stays silent when already armed', () => {
  const plan = planFactsNotifications({
    rows: { s1: row({ completedAt: 3_000 }) },
    seeded: true,
    watermarks: {},
    armed: new Set(['s1']),
  })
  assert.deepEqual(plan.edges, [])
  assert.deepEqual(plan.watermarks, { s1: 3_000 })
})

test('facts reconstructed and subagent rows never notify', () => {
  const plan = planFactsNotifications({
    rows: {
      observed: row(),
      rebuilt: row({ completedAtSource: 'reconstructed' }),
      child: row({ subagentCount: 1 }),
    },
    seeded: true,
    // the first snapshot already seeded the watermark (seeded=false), so this is a real advance
    watermarks: { observed: 1_000 },
    armed: new Set(),
  })
  assert.deepEqual(plan.edges, [{ sessionId: 'observed', kind: 'complete', watermark: 2_000 }])
  assert.deepEqual(plan.watermarks, { observed: 2_000 })
})
