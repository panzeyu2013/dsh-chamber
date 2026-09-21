/**
 * mergeRuntimeFacts facts-injection projection (plan §3.3-1) — node:test.
 *
 * Pinned here:
 *  ① overlay-only (no channel report) still yields the overlay rows;
 *  ② a channel pending kind wins over the overlay (same registry, channel first);
 *  ③ completed stays the App-armed ∪ vendor union;
 *  ④ runningSubagents is channel ?? overlay, sparse (an overlay 0 adds no key);
 *  ⑤ stale rides the report and is no-op when absent/false;
 *  ⑥ anti-churn: judgment fields (updatedAt/completedAt) never enter the projection;
 *  ⑦ COMPATIBILITY LOCK: a two-argument call must serialize byte-identically to
 *    the pre-change implementation (reproduced verbatim below), so existing
 *    callers and tests keep their exact output.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeRuntimeFacts } from '../../src/shared/derive.ts'
import type { InstanceRuntimeReport } from '../../src/shared/aggregate-store.ts'

/**
 * The two-argument implementation as it stood before the overlay/stale
 * extension — the compatibility oracle, copied verbatim (this file is the lock,
 * so it must not be "modernized" alongside the function it pins).
 */
function legacyMergeRuntimeFacts(
  runtime: InstanceRuntimeReport | undefined,
  completedBySource: Record<string, boolean> | undefined,
): InstanceRuntimeReport | undefined {
  const chamberCompleted = completedBySource
  const hasArmed = chamberCompleted !== undefined && Object.values(chamberCompleted).some(value => value === true)
  if (runtime === undefined && !hasArmed) {
    return undefined
  }
  const sessions: InstanceRuntimeReport['sessions'] = { ...(runtime?.sessions ?? {}) }
  if (chamberCompleted !== undefined) {
    for (const [sessionId, armed] of Object.entries(chamberCompleted)) {
      if (armed !== true) continue
      const row = sessions[sessionId] ?? {}
      sessions[sessionId] = { ...row, completed: true }
    }
  }
  return { current: runtime?.current, sessions }
}

const RUNTIME: InstanceRuntimeReport = {
  current: 's1',
  sessionFactReconcile: { requestedAt: 1_000, settledAt: 2_000, ok: true, attempts: 1 },
  sessions: {
    s1: { running: true },
    s2: { running: false, pending: 'approval', runningSubagents: 2 },
    s3: { running: false, completed: true },
  },
}
const DOTS: Record<string, boolean> = { s1: true, s4: true, s5: false }

const COMPAT_CASES: [InstanceRuntimeReport | undefined, Record<string, boolean> | undefined][] = [
  [undefined, undefined],
  [undefined, {}],
  [undefined, { x: false }],
  [RUNTIME, undefined],
  [RUNTIME, {}],
  [RUNTIME, { s1: false }],
  [RUNTIME, DOTS],
  [{ current: 's1', sessions: {} }, undefined],
  [{ sessions: { a: { running: false, completed: true, pending: 'question' } } }, { b: true }],
]

test('⑦ 兼容锁：两参调用的序列化与改动前实现逐字节一致', () => {
  for (const [runtime, completed] of COMPAT_CASES) {
    assert.equal(
      JSON.stringify(mergeRuntimeFacts(runtime, completed)),
      JSON.stringify(legacyMergeRuntimeFacts(runtime, completed)),
      'two-argument behaviour (including key order) must not move',
    )
  }
  // One concrete serialization, key order included: current → sessions, report
  // keys in insertion order, armed overlay applied in place, reconcile dropped.
  assert.equal(
    JSON.stringify(mergeRuntimeFacts(RUNTIME, DOTS)),
    '{"current":"s1","sessions":{"s1":{"running":true,"completed":true},'
    + '"s2":{"running":false,"pending":"approval","runningSubagents":2},'
    + '"s3":{"running":false,"completed":true},"s4":{"completed":true}}}',
  )
})

test('① overlay-only yields the overlay rows even without a channel report', () => {
  const merged = mergeRuntimeFacts(undefined, undefined, {
    s9: { pending: 'question', runningSubagents: 2 },
    s10: { pending: 'plan-review' },
  })
  assert.deepEqual(merged, {
    current: undefined,
    sessions: {
      s9: { pending: 'question', runningSubagents: 2 },
      s10: { pending: 'plan-review' },
    },
  })
})

test('② a channel pending kind wins over the overlay (same registry, channel first)', () => {
  const merged = mergeRuntimeFacts(
    { sessions: { s1: { running: false, pending: 'approval' } } },
    undefined,
    { s1: { pending: 'question' } },
  )
  assert.deepEqual(merged?.sessions.s1, { running: false, pending: 'approval' })
  // An absent channel kind is filled by the overlay.
  const filled = mergeRuntimeFacts(
    { sessions: { s1: { running: false } } },
    undefined,
    { s1: { pending: 'question' } },
  )
  assert.deepEqual(filled?.sessions.s1, { running: false, pending: 'question' })
})

test('③ completed stays the App-armed ∪ vendor union with an overlay present', () => {
  const merged = mergeRuntimeFacts(
    { current: 's1', sessions: { s1: { running: false }, s3: { running: false, completed: true } } },
    { s1: true, s2: true, s4: false },
    { s2: { pending: 'question' } },
  )
  assert.deepEqual(merged, {
    current: 's1',
    sessions: {
      s1: { running: false, completed: true },              // App-armed
      s3: { running: false, completed: true },              // vendor-armed
      s2: { completed: true, pending: 'question' },         // armed dot + overlay fill
    },
  })
})

test('④ runningSubagents is channel ?? overlay and stays sparse', () => {
  // Channel absent → overlay fills.
  assert.deepEqual(
    mergeRuntimeFacts({ sessions: { a: { running: false } } }, undefined, { a: { runningSubagents: 3 } })?.sessions.a,
    { running: false, runningSubagents: 3 },
  )
  // Channel present → channel wins (the overlay must not double-count).
  assert.deepEqual(
    mergeRuntimeFacts({ sessions: { a: { running: false, runningSubagents: 1 } } }, undefined, { a: { runningSubagents: 3 } })?.sessions.a,
    { running: false, runningSubagents: 1 },
  )
  // An overlay 0 adds NO key (sparse semantics of the projection shape).
  const zero = mergeRuntimeFacts(undefined, undefined, { a: { runningSubagents: 0 } })
  assert.deepEqual(zero?.sessions.a, {})
  assert.equal('runningSubagents' in (zero?.sessions.a ?? {}), false)
})

test('⑤ stale rides the report; absent/false leaves the two-argument bytes alone', () => {
  const stale = mergeRuntimeFacts(undefined, { s1: true }, undefined, true)
  assert.deepEqual(stale, { current: undefined, sessions: { s1: { completed: true } }, stale: true })
  assert.deepEqual(
    mergeRuntimeFacts(RUNTIME, DOTS, { s1: { pending: 'question' } }, true),
    { ...mergeRuntimeFacts(RUNTIME, DOTS, { s1: { pending: 'question' } }), stale: true },
  )
  // false/absent never materialize the key.
  for (const value of [false, undefined]) {
    assert.equal('stale' in (mergeRuntimeFacts(RUNTIME, DOTS, undefined, value) ?? {}), false)
  }
  // stale alone cannot attach content: the early return is unchanged.
  assert.equal(mergeRuntimeFacts(undefined, undefined, undefined, true), undefined)
})

test('⑥ anti-churn: judgment fields never enter the projected row', () => {
  // The overlay is a narrow RENDER shape; a caller passing extra fields through
  // an untyped object must not smuggle judgment inputs into the projection.
  const merged = mergeRuntimeFacts(
    undefined,
    undefined,
    { s1: { pending: 'question', runningSubagents: 1, updatedAt: 999, completedAt: 999 } as never },
  )
  assert.deepEqual(merged?.sessions.s1, { pending: 'question', runningSubagents: 1 })
  // Overlay-only rows with no rendered fields stay empty rows (nothing invented).
  const empty = mergeRuntimeFacts(undefined, undefined, { s1: {} })
  assert.deepEqual(empty?.sessions.s1, {})
})
