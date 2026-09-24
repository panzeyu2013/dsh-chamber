/**
 * P3 单通知投影契约：两条证据、一个策略、一个身份账本（v4 无水位表）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  planFactsNotifications,
  planRuntimeNotifications,
  type NotificationFactsRow,
} from '../../src/notification-projection.ts'
import { chamberRunId } from '@dsh-chamber/dsh-stream-state'
import { LEGACY_NOTIFIED_RUN_ID, isSessionRunId, isStaleRunIdentity } from '../../src/notification-identity.ts'

type Facts = {
  completedAt: number | null
  completedAtSource?: 'observed' | 'reconstructed'
  updatedAt: number
  subagentCount: number
  lastTurnEnd?: { seq?: number | null } | null
}
const row = (over: Partial<Facts> = {}): NotificationFactsRow => ({
  completedAt: 2_000,
  completedAtSource: 'observed',
  updatedAt: 1_000,
  subagentCount: 0,
  ...over,
})

/** Every facts plan shares one source fingerprint, so identity is deterministic. */
const planFacts = (input: Omit<Parameters<typeof planFactsNotifications>[0], 'sourceFingerprint'>) =>
  planFactsNotifications({ sourceFingerprint: 'host-1', ...input })

const sharp = (plan: { edges: readonly { sessionId: string; kind: string; watermark?: number }[] }) =>
  plan.edges.map(edge => ({ sessionId: edge.sessionId, kind: edge.kind, watermark: edge.watermark }))

test('a late running flag with the same host activity never re-arms the completed edge', () => {
  const completed = { s1: { running: false, completed: true, updatedAt: 1_000 } }
  const stale = planRuntimeNotifications({
    prev: completed,
    next: { s1: { running: true, updatedAt: 1_000 } },
    factsUsable: false,
    armed: new Set(['s1']),
  })
  assert.equal(stale.armed.has('s1'), true,
    'the replayed running flag belongs to the run that already completed: keep the armed memory')
  const genuine = planRuntimeNotifications({
    prev: completed,
    next: { s1: { running: true, updatedAt: 2_000 } },
    factsUsable: false,
    armed: new Set(['s1']),
  })
  assert.equal(genuine.armed.has('s1'), false, 'a genuinely newer run re-arms the completed edge')
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

test('facts first snapshot only seeds the identity', () => {
  const plan = planFacts({
    rows: { s1: row({ completedAt: 2_000, updatedAt: 1_500 }) },
    seeded: false,
    armed: new Set(),
  })
  assert.deepEqual(plan.edges, [])
  assert.deepEqual(plan.runs, { s1: 'chamber:host-1:0:s1:2000' })
})

test('a new run emits once with its identity', () => {
  const plan = planFacts({
    rows: { s1: row({ completedAt: 3_000, updatedAt: 1_500 }) },
    seeded: true,
    notifiedRuns: {},
    armed: new Set(),
  })
  assert.deepEqual(sharp(plan), [{ sessionId: 's1', kind: 'complete', watermark: 3_000 }])
  assert.equal(plan.edges[0]?.runId, 'chamber:host-1:0:s1:3000')
  assert.deepEqual(plan.runs, {}, 'a dispatched edge is accounted only after the native receipt')
})

test('the same run never re-emits, and a regressed observation is not a new run', () => {
  const notifiedRuns = { s1: 'chamber:host-1:0:s1:2000' }
  const same = planFacts({ rows: { s1: row({ completedAt: 2_000 }) }, seeded: true, notifiedRuns, armed: new Set() })
  assert.deepEqual(same.edges, [])
  const lower = planFacts({ rows: { s1: row({ completedAt: 1_000, updatedAt: 500 }) }, seeded: true, notifiedRuns, armed: new Set() })
  assert.deepEqual(lower.edges, [], 'a stale lower watermark cannot mint a fresh identity')
})

test('facts attributes a runtime edge to its identity only after native settlement', () => {
  const plan = planFacts({
    rows: { s1: row({ completedAt: 3_000 }) },
    seeded: true,
    notifiedRuns: {},
    armed: new Set(['s1']),
    runtimeSettled: new Map([['s1', undefined]]),
  })
  assert.deepEqual(plan.edges, [])
  assert.deepEqual(plan.runs, { s1: 'chamber:host-1:0:s1:3000' }, 'the adopted identity is recorded, never notified')
})

test('facts reconstructed and subagent rows never notify', () => {
  const plan = planFacts({
    rows: {
      observed: row(),
      rebuilt: row({ completedAtSource: 'reconstructed' }),
      child: row({ subagentCount: 1 }),
    },
    seeded: true,
    notifiedRuns: {},
    armed: new Set(),
  })
  assert.deepEqual(sharp(plan), [{ sessionId: 'observed', kind: 'complete', watermark: 2_000 }])
  assert.equal(plan.edges[0]?.runId, 'chamber:host-1:0:observed:2000')
})

test('a pending runtime completion is not settled by facts until delivery succeeds', () => {
  const pending = planFacts({
    rows: { s1: row({ completedAt: 3_000 }) }, seeded: true,
    notifiedRuns: {}, armed: new Set(['s1']), pendingSessions: new Set(['s1']),
  })
  assert.deepEqual(pending.edges, [])
  assert.deepEqual(pending.runs, {})
  // The outbox attaches the host watermark while pending; once the shown receipt
  // lands, the settlement writes the identity and the facts snapshot is inert.
  const delivered = planFacts({
    rows: { s1: row({ completedAt: 3_000 }) }, seeded: true,
    notifiedRuns: { s1: 'chamber:host-1:0:s1:3000' }, armed: new Set(['s1']), pendingSessions: new Set(),
  })
  assert.deepEqual(delivered.edges, [])
})

test('identity: a host turn seq moves the run into the host family', () => {
  const seqRow = row({ completedAt: 3_000, lastTurnEnd: { seq: 7 } })
  const first = planFacts({ rows: { s1: seqRow }, seeded: true, notifiedRuns: {}, armed: new Set() })
  assert.equal(first.edges[0]?.runId, 'host:turn%2F7')
  const replay = planFacts({
    rows: { s1: seqRow }, seeded: true,
    notifiedRuns: { s1: 'host:turn%2F7' }, armed: new Set(),
  })
  assert.deepEqual(replay.edges, [])
  const regressed = planFacts({
    rows: { s1: seqRow }, seeded: true,
    notifiedRuns: { s1: 'host:turn%2F9' }, armed: new Set(),
  })
  assert.deepEqual(regressed.edges, [], 'a host turn that did not advance is stale evidence')
})

test('identity: a remount generation change is a new run, never a stale episode', () => {
  const previous = chamberRunId({ sourceFingerprint: 'host-1', generation: 11_000, sessionId: 's1', episode: 3 })
  const next = chamberRunId({ sourceFingerprint: 'host-1', generation: 12_000, sessionId: 's1', episode: 1 })
  assert.equal(isStaleRunIdentity(previous, next), false,
    'folding generations together suppresses the new lifetime run 2 notification')
  assert.equal(isStaleRunIdentity(next, previous), false)
  const sameLifetime = chamberRunId({ sourceFingerprint: 'host-1', generation: 11_000, sessionId: 's1', episode: 2 })
  assert.equal(isStaleRunIdentity(previous, sameLifetime), true, 'within one lifetime the episode order still holds')
})

test('identity: a corrupt persisted id is inert, never an exception', () => {
  assert.equal(isStaleRunIdentity('host:turn%2F1', 'host:%'), false)
  assert.equal(isStaleRunIdentity('host:%', 'host:turn%2F1'), false)
  assert.equal(isStaleRunIdentity('chamber:x', 'chamber:y'), false)
})

test('isSessionRunId: the restore boundary accepts real identities only', () => {
  assert.equal(isSessionRunId('host:turn%2F7'), true)
  assert.equal(isSessionRunId(chamberRunId({ sourceFingerprint: 'fp', generation: 12_000, sessionId: 's1', episode: 1 })), true)
  assert.equal(isSessionRunId(LEGACY_NOTIFIED_RUN_ID), true)
  const bad: unknown[] = [
    'host:%', 'host:', 'host:turn%2f7', 'chamber:fp:0:s1', 'chamber:fp:x:s1:1',
    // Non-canonical components parse equal to a live id; negatives are not ids.
    'chamber:fp:1:s%31:5', 'chamber:fp:1:s1:-1', 'chamber:fp:1:s1:1.5',
    '', 'garbage', 'x'.repeat(257), 42, null,
  ]
  for (const value of bad) assert.equal(isSessionRunId(value), false, String(value))
})

test('identity: a v4 journal sentinel is adopted without notifying', () => {
  const seqRow = row({ completedAt: 3_000, lastTurnEnd: { seq: 7 } })
  const plan = planFacts({
    rows: { s1: seqRow }, seeded: true,
    notifiedRuns: { s1: LEGACY_NOTIFIED_RUN_ID }, armed: new Set(),
  })
  assert.deepEqual(plan.edges, [], 'the pre-spine journal must not re-show an already-delivered completion')
  assert.deepEqual(plan.runs, { s1: 'host:turn%2F7' }, 'the sentinel is replaced by the live identity')
})
