/**
 * Pure derive.ts unit tests (plain node:test, no dsh, no React):
 * blank (hidden unless current) / subagent / archived visibility, workspace
 * membership mapping and order, running/updatedAt passthrough, the trailing
 * ungrouped bucket (recency sort + id tiebreak), no-stray and empty-snapshot
 * cases, the ungrouped marker id/flag, and relativeTimeBucket boundaries.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveLocalSearchMatches,
  deriveServerWorkspaces,
  increasedForkTitle,
  instanceSnapshotSignature,
  mergeRuntimeFacts,
  mergeSearchResults,
  orderUngroupedSessions,
  projectRuntimeFacts,
  reconcileCompletedFacts,
  reconciledSessionOrder,
  relativeTimeBucket,
  runningRingVisible,
  runtimeReportSignature,
  sanitizeSearchQuery,
  serversProjectionSignature,
  sortWorkspaceSessions,
  SEARCH_QUERY_MAX_CODE_UNITS,
  UNGROUPED_WORKSPACE_ID,
} from '../src/shared/derive.ts'
import type { InstanceSnapshot, SearchRow, SessionRow, WorkspaceRow } from '../src/shared/instance-api.ts'
import type { ChamberServerAggregate, InstanceRuntimeReport } from '../src/shared/aggregate-store.ts'

function session(
  id: string,
  updatedAt = 0,
  extra: Partial<Pick<SessionRow, 'blank' | 'origin' | 'title' | 'running'>> = {},
): SessionRow {
  return { sessionId: id, updatedAt, running: false, blank: false, ...extra }
}

function workspace(workspaceId: string, title: string, sessionIds: string[] = []): WorkspaceRow {
  return {
    workspaceId,
    path: `/${workspaceId}`,
    title,
    sessionIds,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function snapshot(workspaces: WorkspaceRow[], sessions: SessionRow[]): InstanceSnapshot {
  return { workspaces, sessions, archivedSessionIds: [] }
}

test('blank sessions are hidden from workspaces and from the ungrouped bucket when not current', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { blank: true })],
    ),
    '',
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', running: false, updatedAt: 1 }])
  assert.equal(result[0].ungrouped, undefined)
})

test('a blank session surfaces while it is the current session (official !blank || current rule)', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { blank: true })],
    ),
    '',
    'b',
  )
  assert.deepEqual(result[0].sessions, [
    { id: 'a', title: '', running: false, updatedAt: 1 },
    { id: 'b', title: '', running: false, updatedAt: 2, blank: true },
  ])
})

test('a blank-current session not accounted by any workspace trails in the ungrouped bucket', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a'])],
      [session('a', 1), session('blank', 300, { blank: true })],
    ),
    '',
    'blank',
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[1].sessions, [{ id: 'blank', title: '', running: false, updatedAt: 300, blank: true }])
})

test('blank rows carry the sparse blank flag; ordinary rows never do', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { blank: true })],
    ),
    '',
    'b',
  )
  assert.equal(result[0].sessions[0].blank, undefined)
  assert.equal(result[0].sessions[1].blank, true)
})

test('a non-current blank session stays hidden even when another blank session is current', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['b1', 'b2'])],
      [session('b1', 1, { blank: true }), session('b2', 2, { blank: true })],
    ),
    '',
    'b2',
  )
  assert.deepEqual(result[0].sessions, [{ id: 'b2', title: '', running: false, updatedAt: 2, blank: true }])
})

test('subagent sessions are hidden from workspaces and from the ungrouped bucket', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { origin: 'subagent' })],
    ),
    '',
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', running: false, updatedAt: 1 }])
})

test('workspace membership maps in sessionIds order with titles from the snapshot', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Alpha', ['s3', 's1', 's2'])],
      [
        session('s1', 10, { title: 'One' }),
        session('s2', 20, { title: 'Two' }),
        session('s3', 30, { title: 'Three' }),
      ],
    ),
    '',
  )
  assert.deepEqual(result, [
    {
      id: 'w1',
      title: 'Alpha',
      sessions: [
        { id: 's3', title: 'Three', running: false, updatedAt: 30 },
        { id: 's1', title: 'One', running: false, updatedAt: 10 },
        { id: 's2', title: 'Two', running: false, updatedAt: 20 },
      ],
    },
  ])
})

test('visible sessions not accounted by any workspace trail in one ungrouped bucket, recency then id tiebreak', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a'])],
      [
        session('x', 100),
        session('y', 200),
        session('z', 200),
        session('a', 1),
        session('blank-stray', 300, { blank: true }),
        session('sub-stray', 300, { origin: 'subagent' }),
      ],
    ),
    '',
  )
  assert.equal(result.length, 2)
  const ungrouped = result[1]
  assert.equal(ungrouped.id, UNGROUPED_WORKSPACE_ID)
  assert.equal(ungrouped.title, '')
  assert.equal(ungrouped.ungrouped, true)
  assert.deepEqual(ungrouped.sessions, [
    { id: 'y', title: '', running: false, updatedAt: 200 },
    { id: 'z', title: '', running: false, updatedAt: 200 },
    { id: 'x', title: '', running: false, updatedAt: 100 },
  ])
})

test('the ungrouped bucket carries the caller-provided title', () => {
  const result = deriveServerWorkspaces(
    snapshot([workspace('w1', 'Work', ['a'])], [session('x', 100), session('a', 1)]),
    'Ungrouped',
  )
  assert.equal(result[1].title, 'Ungrouped')
  assert.equal(result[1].ungrouped, true)
})

test('no stray sessions means no ungrouped bucket', () => {
  const result = deriveServerWorkspaces(
    snapshot([workspace('w1', 'Work', ['a', 'b'])], [session('a', 1), session('b', 2)]),
    '',
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'w1')
})

test('empty snapshot derives to an empty list', () => {
  assert.deepEqual(deriveServerWorkspaces(snapshot([], []), ''), [])
})

test('members not present in the session list are skipped without breaking workspace order', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['missing', 'a'])],
      [session('a', 1, { title: 'A' })],
    ),
    '',
  )
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: 'A', running: false, updatedAt: 1 }])
})

test('archived sessions are hidden from workspaces and from the ungrouped bucket', () => {
  const result = deriveServerWorkspaces(
    {
      workspaces: [workspace('w1', 'Work', ['a', 'b'])],
      sessions: [session('a', 1), session('b', 2), session('archived-stray', 3)],
      archivedSessionIds: ['b', 'archived-stray'],
    },
    '',
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', running: false, updatedAt: 1 }])
  assert.equal(result[0].ungrouped, undefined)
})

test('archived members keep their accounting slot: only non-archived strays surface', () => {
  const result = deriveServerWorkspaces(
    {
      workspaces: [workspace('w1', 'Work', ['a', 'archived'])],
      sessions: [session('a', 1), session('archived', 2), session('x', 3)],
      archivedSessionIds: ['archived'],
    },
    '',
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', running: false, updatedAt: 1 }])
  assert.deepEqual(result[1].sessions, [{ id: 'x', title: '', running: false, updatedAt: 3 }])
})

test('running and updatedAt pass through to workspace members and strays', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [
        session('a', 42, { title: 'A', running: true }),
        session('b', 7),
        session('s', 99, { running: true }),
      ],
    ),
    '',
  )
  assert.deepEqual(result[0].sessions, [
    { id: 'a', title: 'A', running: true, updatedAt: 42 },
    { id: 'b', title: '', running: false, updatedAt: 7 },
  ])
  assert.deepEqual(result[1].sessions, [{ id: 's', title: '', running: true, updatedAt: 99 }])
})

test('relativeTimeBucket boundaries mirror the official relativeTime algorithm', () => {
  const now = 1_000_000_000_000
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  assert.deepEqual(relativeTimeBucket(now - (MIN - 1), now), { unit: 'now', n: 0 })
  assert.deepEqual(relativeTimeBucket(now - MIN, now), { unit: 'minutes', n: 1 })
  assert.deepEqual(relativeTimeBucket(now - (HOUR - 1), now), { unit: 'minutes', n: 59 })
  assert.deepEqual(relativeTimeBucket(now - HOUR, now), { unit: 'hours', n: 1 })
  assert.deepEqual(relativeTimeBucket(now - (DAY - 1), now), { unit: 'hours', n: 23 })
  assert.deepEqual(relativeTimeBucket(now - DAY, now), { unit: 'days', n: 1 })
  assert.deepEqual(relativeTimeBucket(now - (30 * DAY - 1), now), { unit: 'days', n: 29 })
  assert.deepEqual(relativeTimeBucket(now - 30 * DAY, now), { unit: 'months', n: 1 })
  assert.deepEqual(relativeTimeBucket(now - (365 * DAY - 1), now), { unit: 'months', n: 12 })
  assert.deepEqual(relativeTimeBucket(now - 365 * DAY, now), { unit: 'years', n: 1 })
  assert.deepEqual(relativeTimeBucket(now + 5000, now), { unit: 'now', n: 0 })
})

test('sanitizeSearchQuery strips NULs and trims', () => {
  assert.equal(sanitizeSearchQuery('a\0b\0c'), 'abc')
  assert.equal(sanitizeSearchQuery('  hello world\0  '), 'hello world')
  assert.equal(sanitizeSearchQuery(''), '')
  assert.equal(sanitizeSearchQuery('\0\0'), '')
  assert.equal(sanitizeSearchQuery('   '), '')
  assert.equal(sanitizeSearchQuery('\0  \0'), '')
})

test('sanitizeSearchQuery clamps to 500 UTF-16 code units without splitting a surrogate pair', () => {
  const plain = 'a'.repeat(600)
  assert.equal(sanitizeSearchQuery(plain).length, 500)
  assert.equal(sanitizeSearchQuery(plain), 'a'.repeat(500))
  const withPair = 'a'.repeat(499) + '\ud83d\ude00' + 'b'
  const sanitized = sanitizeSearchQuery(withPair)
  assert.equal(sanitized, 'a'.repeat(499))
  assert.equal(sanitized.includes('\ud83d'), false)
  const pairAtBoundary = 'a'.repeat(498) + '\ud83d\ude00' + 'b'.repeat(10)
  assert.equal(sanitizeSearchQuery(pairAtBoundary).length, 500)
  assert.equal(sanitizeSearchQuery(pairAtBoundary), 'a'.repeat(498) + '\ud83d\ude00')
})

test('SEARCH_QUERY_MAX_CODE_UNITS matches the wire schema clamp of 500', () => {
  assert.equal(SEARCH_QUERY_MAX_CODE_UNITS, 500)
})

test('sanitizeSearchQuery respects the SEARCH_QUERY_MAX_CODE_UNITS boundary', () => {
  const atBoundary = 'b'.repeat(SEARCH_QUERY_MAX_CODE_UNITS)
  assert.equal(sanitizeSearchQuery(atBoundary), atBoundary)
  assert.equal(sanitizeSearchQuery(atBoundary + 'b'), atBoundary)
  const withPair = 'b'.repeat(SEARCH_QUERY_MAX_CODE_UNITS - 1) + '\ud83d\ude00' + 'c'
  const sanitized = sanitizeSearchQuery(withPair)
  assert.equal(sanitized, 'b'.repeat(SEARCH_QUERY_MAX_CODE_UNITS - 1))
  assert.equal(sanitized.includes('\ud83d'), false)
})

test('reconciledSessionOrder prefers stored order, then unknown-to-stored wire ids in wire order', () => {
  assert.deepEqual(reconciledSessionOrder(['b', 'a'], ['a', 'b', 'c']), ['b', 'a', 'c'])
  assert.deepEqual(reconciledSessionOrder(['a'], ['a', 'b']), ['a', 'b'])
  assert.deepEqual(reconciledSessionOrder([], ['c', 'a', 'b']), ['c', 'a', 'b'])
})

test('reconciledSessionOrder skips stored ids unknown to the wire', () => {
  assert.deepEqual(reconciledSessionOrder(['x', 'a', 'y'], ['a', 'b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(reconciledSessionOrder(['z'], ['a']), ['a'])
})

test('projectRuntimeFacts passes current through and emits every session with its live running bit', () => {
  const report = projectRuntimeFacts({
    current: 's1',
    byId: {
      s1: { running: true, completed: true },
      s2: { running: false, pendingInteraction: 'approval' },
      s3: { running: true, pendingInteraction: 'question' },
      s4: { running: false },
    },
  })
  assert.deepEqual(report, {
    current: 's1',
    sessions: {
      s1: { running: true, completed: true },
      s2: { running: false, pending: 'approval' },
      s3: { running: true, pending: 'question' },
      s4: { running: false },
    },
  })
})

test('projectRuntimeFacts maps every pendingInteraction kind and keeps completed alongside pending', () => {
  const report = projectRuntimeFacts({
    byId: {
      a: { running: false, pendingInteraction: 'plan-review' },
      b: { running: false, pendingInteraction: 'question' },
      c: { running: true, completed: true, pendingInteraction: 'approval' },
    },
  })
  assert.deepEqual(report.sessions, {
    a: { running: false, pending: 'plan-review' },
    b: { running: false, pending: 'question' },
    c: { running: true, completed: true, pending: 'approval' },
  })
  assert.equal(report.current, undefined)
})

test('projectRuntimeFacts returns empty sessions for an empty snapshot', () => {
  assert.deepEqual(projectRuntimeFacts({}), { sessions: {} })
  assert.deepEqual(projectRuntimeFacts({ current: 's1' }), { current: 's1', sessions: {} })
})

test('projectRuntimeFacts treats missing running bits as false (the App edge memory uses === true)', () => {
  const report = projectRuntimeFacts({
    byId: {
      a: {},
      b: { running: undefined },
      c: { completed: false },
    },
  })
  assert.deepEqual(report.sessions, {
    a: { running: false },
    b: { running: false },
    c: { running: false },
  })
})

test('projectRuntimeFacts attaches running subagent counts (sparse, vendor lineage semantics)', () => {
  const subagentRunning = new Map<string, number>([
    ['parent1', 2],
    ['parent2', 1],
  ])
  const report = projectRuntimeFacts({
    current: 'parent1',
    byId: {
      parent1: { running: false },
      parent2: { running: true },
      plain: { running: false },
    },
  }, subagentRunning)
  assert.deepEqual(report, {
    current: 'parent1',
    sessions: {
      parent1: { running: false, runningSubagents: 2 },
      parent2: { running: true, runningSubagents: 1 },
      plain: { running: false },
    },
  })
})

test('projectRuntimeFacts omits runningSubagents without the lineage map or for zero counts', () => {
  const noMap = projectRuntimeFacts({ byId: { a: { running: false } } })
  assert.deepEqual(noMap.sessions.a, { running: false })
  const zero = projectRuntimeFacts({ byId: { a: { running: false } } }, new Map([['a', 0]]))
  assert.deepEqual(zero.sessions.a, { running: false })
  // The count coexists with the sparse completed/pending extras.
  const combined = projectRuntimeFacts(
    { byId: { a: { running: false, completed: true, pendingInteraction: 'approval' } } },
    new Map([['a', 3]]),
  )
  assert.deepEqual(combined.sessions.a, { running: false, completed: true, pending: 'approval', runningSubagents: 3 })
})

// ---- mergeRuntimeFacts (the App's deriveServers runtime union, 06 §4.2) ----

test('mergeRuntimeFacts returns undefined with no report and no armed dots', () => {
  assert.equal(mergeRuntimeFacts(undefined, undefined), undefined)
  assert.equal(mergeRuntimeFacts(undefined, {}), undefined)
  assert.equal(mergeRuntimeFacts(undefined, { x: false }), undefined) // armed=false ignored
})

test('mergeRuntimeFacts passes the report through when no App dots are armed', () => {
  const runtime = {
    current: 's1',
    sessions: {
      s1: { running: true },
      s2: { running: false, completed: true, runningSubagents: 2 },
    },
  }
  assert.deepEqual(mergeRuntimeFacts(runtime, undefined), runtime)
  assert.deepEqual(mergeRuntimeFacts(runtime, {}), runtime)
})

test('mergeRuntimeFacts overlays App-armed dots onto the report rows, preserving live extras', () => {
  const merged = mergeRuntimeFacts(
    {
      current: 's1',
      sessions: {
        s1: { running: false },
        s2: { running: false, pending: 'question', runningSubagents: 1 },
      },
    },
    { s1: true, s3: true, s4: false },
  )
  assert.deepEqual(merged, {
    current: 's1',
    sessions: {
      s1: { running: false, completed: true },              // armed dot overlaid
      s2: { running: false, pending: 'question', runningSubagents: 1 }, // untouched
      s3: { completed: true },                              // armed dot for a session absent from the report
    },
  })
})

test('mergeRuntimeFacts attaches a bare report (empty sessions) even without armed dots', () => {
  assert.deepEqual(mergeRuntimeFacts({ current: 's1', sessions: {} }, undefined), { current: 's1', sessions: {} })
})

// ---- reconcileCompletedFacts (the App-owned completed-dot state machine) ----

function reconcile(
  prevCompleted: Record<string, boolean>,
  prevRunning: Record<string, boolean>,
  sessions: Record<string, { running?: boolean }>,
  readingCurrent: string | undefined,
): { completed: Record<string, boolean>; changed: boolean; running: Record<string, boolean> } {
  const nextRunning: Record<string, boolean> = {}
  for (const [id, row] of Object.entries(sessions)) nextRunning[id] = row?.running === true
  const result = reconcileCompletedFacts({ sessions, nextRunning, prevRunning, prevCompleted, readingCurrent })
  return { ...result, running: nextRunning }
}

test('reconcile arms a running→idle edge of a background session (the vendor stale-selection gap)', () => {
  const out = reconcile({}, { x: true }, { x: { running: false } }, undefined)
  assert.deepEqual(out.completed, { x: true })
  assert.equal(out.changed, true)
})

test('reconcile never arms for a session being read (the active view current)', () => {
  const out = reconcile({}, { x: true }, { x: { running: false } }, 'x')
  assert.deepEqual(out.completed, {})
  assert.equal(out.changed, false)
})

test('reconcile arms other sessions while one is being read', () => {
  const out = reconcile({}, { x: true, y: true }, { x: { running: false }, y: { running: false } }, 'x')
  assert.deepEqual(out.completed, { y: true })
})

test('reconcile first observation only records the running bit (no edge yet)', () => {
  const out = reconcile({}, {}, { x: { running: false } }, undefined)
  assert.deepEqual(out.completed, {})
  assert.equal(out.changed, false)
})

test('reconcile keeps an armed dot across later idle reports (no re-edge, no re-run)', () => {
  const out = reconcile({ x: true }, { x: false }, { x: { running: false } }, undefined)
  assert.deepEqual(out.completed, { x: true })
  assert.equal(out.changed, false)
})

test('reconcile returns the prevCompleted identity when nothing changes', () => {
  const prev = { x: true }
  const out = reconcile(prev, { x: false }, { x: { running: false } }, undefined)
  assert.equal(out.completed, prev)
})

test('reconcile disarms on re-run', () => {
  const out = reconcile({ x: true }, { x: false }, { x: { running: true } }, undefined)
  assert.deepEqual(out.completed, {})
  assert.equal(out.changed, true)
})

test('reconcile disarms when the user starts reading the armed session (active view current)', () => {
  const out = reconcile({ x: true }, { x: false }, { x: { running: false } }, 'x')
  assert.deepEqual(out.completed, {})
  assert.equal(out.changed, true)
})

test('reconcile drops the armed dot and the edge memory when the session leaves the list', () => {
  const out = reconcile({ x: true }, { x: false }, {}, undefined)
  assert.deepEqual(out.completed, {})
  assert.equal(out.changed, true)
  assert.deepEqual(out.running, {})
})

test('reconcile composes across reports without losing earlier arms (the batched-updater race)', () => {
  // Report A: x finishes (arms). Report B: y finishes (arms). Both apply to
  // the same base — the functional-updater composition must keep both.
  const stepA = reconcile({}, { x: true }, { x: { running: false }, y: { running: false } }, undefined)
  assert.deepEqual(stepA.completed, { x: true })
  const stepB = reconcile(stepA.completed, { x: false, y: true }, { x: { running: false }, y: { running: false } }, undefined)
  assert.deepEqual(stepB.completed, { x: true, y: true })
})

test('reconcile keeps sibling arms when one session re-runs', () => {
  const out = reconcile({ x: true, y: true }, { x: false, y: false }, { x: { running: true }, y: { running: false } }, undefined)
  assert.deepEqual(out.completed, { y: true })
})

// ---- content signatures (2026-08 perf pass: identity-preserving state) ----

test('instanceSnapshotSignature is stable for identical content and differs on any row change', () => {
  const base = snapshot(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1, { title: 'A' }), session('b', 2, { running: true })],
  )
  const same = snapshot(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1, { title: 'A' }), session('b', 2, { running: true })],
  )
  assert.equal(instanceSnapshotSignature(base), instanceSnapshotSignature(same))
  // A fresh object with the same content is byte-identical — this is exactly
  // the 10s-poll no-change case the App layer must not turn into a re-render.
  const rerun = snapshot(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1, { title: 'A' }), session('b', 2, { running: true })],
  )
  assert.equal(instanceSnapshotSignature(base), instanceSnapshotSignature(rerun))
  // Any render-relevant change flips the signature.
  assert.notEqual(instanceSnapshotSignature(base), instanceSnapshotSignature(
    snapshot([workspace('w1', 'Work', ['a'])], [session('a', 1, { title: 'A' }), session('b', 2, { running: true })]),
  ))
  assert.notEqual(instanceSnapshotSignature(base), instanceSnapshotSignature(
    snapshot([workspace('w1', 'Work', ['a', 'b'])], [session('a', 1, { title: 'A' }), session('b', 2, { running: false })]),
  ))
  assert.notEqual(instanceSnapshotSignature(base), instanceSnapshotSignature(
    snapshot([workspace('w1', 'Work', ['a', 'b'])], [session('a', 1, { title: 'A' }), session('b', 3, { running: true })]),
  ))
})

test('runtimeReportSignature distinguishes undefined, content, running bits and subagent counts', () => {
  const a: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: true }, s2: { completed: true } } }
  const b: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: true }, s2: { completed: true } } }
  assert.equal(runtimeReportSignature(a), runtimeReportSignature(b))
  assert.equal(runtimeReportSignature(undefined), '')
  assert.notEqual(runtimeReportSignature(undefined), runtimeReportSignature(a))
  // Running bits matter (the App completed-dot reconciliation reads them).
  assert.notEqual(runtimeReportSignature(a), runtimeReportSignature({ current: 's1', sessions: { s1: { running: false }, s2: { completed: true } } }))
  // Insertion order must not matter (the producer emits map order).
  assert.equal(
    runtimeReportSignature({ current: 's1', sessions: { s1: { running: true }, s2: { completed: true } } }),
    runtimeReportSignature({ current: 's1', sessions: { s2: { completed: true }, s1: { running: true } } }),
  )
  // Subagent counts are part of the signature (sparse, but visible as rings).
  assert.notEqual(
    runtimeReportSignature({ sessions: { p: { running: false } } }),
    runtimeReportSignature({ sessions: { p: { running: false, runningSubagents: 2 } } }),
  )
})

test('runningRingVisible is poll-only: the channel running bit never renders the ring', () => {
  // 轮询权威:只要轮询位 true,无论通道如何,都显示运行环。
  assert.equal(runningRingVisible(false, true), true)
  assert.equal(runningRingVisible(true, true), true)
  assert.equal(runningRingVisible(undefined, true), true)
  // 通道不参与渲染:通道 true 而轮询 false 时不显示——陈旧通道不得伪造
  // 运行环(2026-08 误报窗口),代价是运行开始的环延迟 ≤ 一个轮询周期。
  assert.equal(runningRingVisible(true, false), false)
  assert.equal(runningRingVisible(true, undefined), false)
  assert.equal(runningRingVisible(false, false), false)
  assert.equal(runningRingVisible(undefined, undefined), false)
})

test('runtimeReportSignature includeRunning=false drops the running bit (projection path only)', () => {
  const runningA: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: true } } }
  const runningB: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: false } } }
  // Default (App runtimeFacts identity + completed-dot state machine): the
  // running bit stays in the signature — the reconciliation reads it.
  assert.notEqual(runtimeReportSignature(runningA), runtimeReportSignature(runningB))
  // Projection path (serversProjectionSignature): a channel-only running flip
  // is ignored — the ring is poll-driven, nothing rendered changes.
  assert.equal(runtimeReportSignature(runningA, undefined, false), runtimeReportSignature(runningB, undefined, false))
  // Rendered facts (completed) still matter in the projection path.
  assert.notEqual(
    runtimeReportSignature({ current: 's1', sessions: { s1: { completed: true } } }, undefined, false),
    runtimeReportSignature({ current: 's1', sessions: { s1: {} } }, undefined, false),
  )
})

test('runtimeReportSignature onlyIds restricts the signature to the given session subset', () => {
  const a: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: true }, s2: { completed: true } } }
  // A hidden session (absent from onlyIds) flipping its facts does not change
  // the restricted signature — this is what keeps hidden rows (subagent /
  // archived / blank-non-current) from re-rendering the projection.
  assert.equal(
    runtimeReportSignature(a, new Set(['s1'])),
    runtimeReportSignature(
      { current: 's1', sessions: { s1: { running: true }, s2: { completed: true, running: true } } },
      new Set(['s1']),
    ),
  )
  // Different visible subsets yield different signatures.
  assert.notEqual(runtimeReportSignature(a, new Set(['s1'])), runtimeReportSignature(a, new Set(['s2'])))
  // Without onlyIds the full report is compared (the App's runtimeFacts identity).
  assert.notEqual(
    runtimeReportSignature(a),
    runtimeReportSignature({ current: 's1', sessions: { s1: { running: true }, s2: { completed: true, running: true } } }),
  )
})

function server(id: string, overrides: Partial<ChamberServerAggregate> = {}): ChamberServerAggregate {
  return {
    id,
    kind: id === 'local' ? 'local' : 'ssh',
    label: id,
    connected: true,
    phase: 'ready',
    workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', running: false, updatedAt: 1 }] }],
    updatedAt: 0,
    ...overrides,
  }
}

test('serversProjectionSignature ignores the per-call updatedAt stamp but tracks every rendered field', () => {
  const a = [server('local'), server('ssh-r1')]
  const b = [server('local', { updatedAt: 123456789 }), server('ssh-r1', { updatedAt: 987654321 })]
  assert.equal(serversProjectionSignature(a), serversProjectionSignature(b))
  // Session-level updatedAt is excluded too: the sidebar renders no time cell,
  // and the recency sort's only visible effect is the row ORDER (captured
  // positionally). A session's last-activity tick must not re-render the list.
  assert.equal(
    serversProjectionSignature(a),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', running: false, updatedAt: 999 }] }] }),
    ]),
  )
  // Runtime facts of sessions NOT visible in the projection (subagent-origin /
  // archived / blank-non-current rows) never re-render the list.
  assert.equal(
    serversProjectionSignature(a),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { runtime: { sessions: { hidden: { running: true } } } }),
    ]),
  )
  // A visible session's CHANNEL running flip does NOT re-render the sidebar
  // (2026-08 fix): the ring is poll-driven (runningRingVisible), so the
  // projection signature excludes the channel running bit — a report whose
  // only change is the running bit yields the same signature.
  assert.equal(
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { runtime: { sessions: { s1: { running: true } } } }),
    ]),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { runtime: { sessions: { s1: { running: false } } } }),
    ]),
  )
  // A visible session's RENDERED fact change still flips the signature.
  assert.notEqual(
    serversProjectionSignature(a),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { runtime: { sessions: { s1: { completed: true } } } }),
    ]),
  )
  // Connection / phase / workspaces / runtime changes all flip it.
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('local', { connected: false }), server('ssh-r1')]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('local', { phase: 'starting' }), server('ssh-r1')]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([
    server('local'),
    server('ssh-r1', { workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', running: true, updatedAt: 1 }] }] }),
  ]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([
    server('local'),
    server('ssh-r1', { runtime: { current: 's1', sessions: { s1: { completed: true } } } }),
  ]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('local', { aggregateError: 'boom' }), server('ssh-r1')]))
  // Order of servers matters (source groups are ordered).
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('ssh-r1'), server('local')]))
})

test('serversProjectionSignature JSON-encodes titles: user-controlled separators cannot forge equality', () => {
  // Two DISTINCT projections whose titles contain the delimiters a joined
  // encoding would have used — JSON escaping keeps them apart (a collision
  // here would make the publish gate silently skip a real change).
  const twoRows = [server('local', {
    workspaces: [{
      id: 'w1',
      title: 'Work',
      sessions: [
        { id: 's1', title: 'a', running: false },
        { id: 's2', title: 'b', running: false },
      ],
    }],
  })]
  const forgedSingleRow = [server('local', {
    workspaces: [{
      id: 'w1',
      title: 'Work',
      sessions: [{ id: 's1', title: 'a,0:0,0,s2:b', running: false }],
    }],
  })]
  assert.notEqual(serversProjectionSignature(twoRows), serversProjectionSignature(forgedSingleRow))
  // Identical content on fresh objects still yields identical signatures.
  assert.equal(
    serversProjectionSignature(twoRows),
    serversProjectionSignature([server('local', {
      workspaces: [{
        id: 'w1',
        title: 'Work',
        sessions: [
          { id: 's1', title: 'a', running: false },
          { id: 's2', title: 'b', running: false },
        ],
      }],
    })]),
  )
})

// ---- sortWorkspaceSessions (design 06 §3.1 orderBy) ----

test('sortWorkspaceSessions manual keeps the given (wire/override) order', () => {
  const sessions = [
    { id: 'c', updatedAt: 300 },
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 200 },
  ]
  const out = sortWorkspaceSessions(sessions, 'manual')
  assert.deepEqual(out, sessions)
  // PURE: a fresh array, the input untouched.
  assert.notEqual(out, sessions)
})

test('sortWorkspaceSessions updated sorts by updatedAt descending', () => {
  const out = sortWorkspaceSessions(
    [
      { id: 'a', updatedAt: 100 },
      { id: 'b', updatedAt: 300 },
      { id: 'c', updatedAt: 200 },
    ],
    'updated',
  )
  assert.deepEqual(out.map(x => x.id), ['b', 'c', 'a'])
})

test('sortWorkspaceSessions updated treats a missing updatedAt as 0 (sorts last)', () => {
  const out = sortWorkspaceSessions(
    [
      { id: 'old', updatedAt: 5 },
      { id: 'unknown1' },
      { id: 'unknown2' },
    ],
    'updated',
  )
  assert.deepEqual(out.map(x => x.id), ['old', 'unknown1', 'unknown2'])
})

test('sortWorkspaceSessions updated breaks equal updatedAt ties by id ascending', () => {
  const out = sortWorkspaceSessions(
    [
      { id: 'z', updatedAt: 100 },
      { id: 'a', updatedAt: 100 },
      { id: 'm', updatedAt: 100 },
    ],
    'updated',
  )
  assert.deepEqual(out.map(x => x.id), ['a', 'm', 'z'])
})

test('sortWorkspaceSessions manual never mutates and survives repeated calls', () => {
  const sessions = [{ id: 'b' }, { id: 'a' }]
  assert.deepEqual(sortWorkspaceSessions(sessions, 'manual'), sessions)
  assert.deepEqual(sessions, [{ id: 'b' }, { id: 'a' }])
})

// ---- orderUngroupedSessions (P2-9 extraction, design 06 §3.1) ----

test('orderUngroupedSessions updated sorts by recency ignoring the stored order', () => {
  const wire = [
    { id: 'old', updatedAt: 5 },
    { id: 'new', updatedAt: 100 },
    { id: 'mid', updatedAt: 50 },
  ]
  const out = orderUngroupedSessions(wire, ['mid', 'old', 'new'], 'updated')
  assert.deepEqual(out.map(x => x.id), ['new', 'mid', 'old'])
})

test('orderUngroupedSessions updated treats a missing updatedAt as 0 (sorts last)', () => {
  const wire = [
    { id: 'unknown' },
    { id: 'known', updatedAt: 10 },
  ]
  const out = orderUngroupedSessions(wire, ['unknown', 'known'], 'updated')
  assert.deepEqual(out.map(x => x.id), ['known', 'unknown'])
})

test('orderUngroupedSessions manual uses the stored order with wire-id appends', () => {
  const wire = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
  ]
  const out = orderUngroupedSessions(wire, ['c', 'a'], 'manual')
  assert.deepEqual(out.map(x => x.id), ['c', 'a', 'b'])
})

test('orderUngroupedSessions manual skips stored ids unknown to the wire', () => {
  const wire = [
    { id: 'a' },
    { id: 'b' },
  ]
  const out = orderUngroupedSessions(wire, ['ghost', 'b', 'a'], 'manual')
  assert.deepEqual(out.map(x => x.id), ['b', 'a'])
})

test('orderUngroupedSessions manual with no stored order returns the wire order copy', () => {
  const wire = [{ id: 'b' }, { id: 'a' }]
  const out = orderUngroupedSessions(wire, undefined, 'manual')
  assert.deepEqual(out.map(x => x.id), ['b', 'a'])
  assert.notEqual(out, wire)
})

// ---- deriveLocalSearchMatches (design 06 §1.1 local leg) ----

test('deriveLocalSearchMatches hits session titles case-insensitively', () => {
  const result = deriveLocalSearchMatches(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 10, { title: 'DeepSeek R1' }), session('b', 20, { title: 'other' })],
    ),
    'deepseek',
  )
  assert.deepEqual(result, [{ sessionId: 'a', snippet: '' }])
})

test('deriveLocalSearchMatches hits workspace titles (a session with no title still matches)', () => {
  const result = deriveLocalSearchMatches(
    snapshot(
      [workspace('w1', 'Alpha Project', ['a']), workspace('w2', 'Other', ['b'])],
      [session('a', 10), session('b', 20, { title: 'Other' })],
    ),
    'alpha',
  )
  // Session a has NO title (missing titles never hit on title), but its
  // workspace title hit still counts; b sits in a non-matching workspace.
  assert.deepEqual(result, [{ sessionId: 'a', snippet: '' }])
})

test('deriveLocalSearchMatches matches either leg independently', () => {
  const result = deriveLocalSearchMatches(
    snapshot(
      [workspace('w1', 'Work', ['a']), workspace('w2', 'Docs', ['b'])],
      [session('a', 10, { title: 'Notes' }), session('b', 20, { title: 'no-match' })],
    ),
    'docs',
  )
  assert.deepEqual(result, [{ sessionId: 'b', snippet: '' }])
})

test('deriveLocalSearchMatches excludes blank, archived and subagent sessions', () => {
  const result = deriveLocalSearchMatches(
    {
      workspaces: [workspace('w1', 'Match', ['hit', 'blank-hit', 'archived-hit', 'sub-hit'])],
      sessions: [
        session('hit', 10, { title: 'match me' }),
        session('blank-hit', 20, { title: 'match me', blank: true }),
        session('archived-hit', 30, { title: 'match me' }),
        session('sub-hit', 40, { title: 'match me', origin: 'subagent' }),
      ],
      archivedSessionIds: ['archived-hit'],
    },
    'match',
  )
  assert.deepEqual(result, [{ sessionId: 'hit', snippet: '' }])
})

test('deriveLocalSearchMatches orders hits by recency with the id tiebreak', () => {
  const result = deriveLocalSearchMatches(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b', 'c'])],
      [
        session('a', 100, { title: 'hit' }),
        session('b', 300, { title: 'hit' }),
        session('c', 300, { title: 'hit' }),
      ],
    ),
    'hit',
  )
  assert.deepEqual(result.map(row => row.sessionId), ['b', 'c', 'a'])
})

test('deriveLocalSearchMatches returns [] for an empty query (defensive trim)', () => {
  const result = deriveLocalSearchMatches(
    snapshot([workspace('w1', 'Work', ['a'])], [session('a', 1, { title: 'hit' })]),
    '   ',
  )
  assert.deepEqual(result, [])
})

test('deriveLocalSearchMatches returns [] when nothing matches', () => {
  const result = deriveLocalSearchMatches(
    snapshot([workspace('w1', 'Work', ['a'])], [session('a', 1, { title: 'hit' })]),
    'zzz',
  )
  assert.deepEqual(result, [])
})

// ---- mergeSearchResults (design 06 §1.1 merge; P1-2 visible-set filter) ----

// The pre-filter tests simulate a projection where every row is visible.
const ALL_VISIBLE = new Set(['l1', 'l2', 'l3', 'r1', 'r2', 'both', 'x', 'y'])

test('mergeSearchResults leads with local hits then appends remote-only rows', () => {
  const local: SearchRow[] = [
    { sessionId: 'l1', snippet: '' },
    { sessionId: 'l2', snippet: '' },
  ]
  const remote = {
    items: [
      { sessionId: 'r1', snippet: 'remote one' },
      { sessionId: 'r2', snippet: 'remote two' },
    ],
    hasMore: false,
  }
  const merged = mergeSearchResults(local, remote, 20, ALL_VISIBLE)
  assert.deepEqual(merged.items.map(row => row.sessionId), ['l1', 'l2', 'r1', 'r2'])
  assert.equal(merged.hasMore, false)
})

test('mergeSearchResults adopts the remote snippet for sessions hit in both legs', () => {
  const local: SearchRow[] = [
    { sessionId: 'l1', snippet: '' },
    { sessionId: 'both', snippet: '' },
  ]
  const remote = {
    items: [
      { sessionId: 'both', snippet: 'content snippet' },
      { sessionId: 'r1', snippet: 'remote one' },
    ],
    hasMore: false,
  }
  const merged = mergeSearchResults(local, remote, 20, ALL_VISIBLE)
  assert.deepEqual(merged.items, [
    { sessionId: 'l1', snippet: '' },
    { sessionId: 'both', snippet: 'content snippet' },
    { sessionId: 'r1', snippet: 'remote one' },
  ])
})

test('mergeSearchResults dedupes sessionIds within the remote leg', () => {
  const remote = {
    items: [
      { sessionId: 'x', snippet: 'first' },
      { sessionId: 'x', snippet: 'second' },
      { sessionId: 'y', snippet: 'other' },
    ],
    hasMore: false,
  }
  const merged = mergeSearchResults([], remote, 20, ALL_VISIBLE)
  assert.deepEqual(merged.items, [
    { sessionId: 'x', snippet: 'first' },
    { sessionId: 'y', snippet: 'other' },
  ])
})

test('mergeSearchResults sets hasMore from the remote hint', () => {
  const merged = mergeSearchResults(
    [],
    { items: [{ sessionId: 'x', snippet: '' }], hasMore: true },
    20,
    ALL_VISIBLE,
  )
  assert.equal(merged.hasMore, true)
})

test('mergeSearchResults sets hasMore when the merged result exceeds the limit', () => {
  const merged = mergeSearchResults(
    [
      { sessionId: 'l1', snippet: '' },
      { sessionId: 'l2', snippet: '' },
    ],
    { items: [{ sessionId: 'r1', snippet: '' }], hasMore: false },
    2,
    ALL_VISIBLE,
  )
  assert.deepEqual(merged.items.map(row => row.sessionId), ['l1', 'l2'])
  assert.equal(merged.hasMore, true) // 3 merged rows > limit 2
})

test('mergeSearchResults bounds the items to the limit', () => {
  const merged = mergeSearchResults(
    [
      { sessionId: 'l1', snippet: '' },
      { sessionId: 'l2', snippet: '' },
      { sessionId: 'l3', snippet: '' },
    ],
    { items: [{ sessionId: 'r1', snippet: '' }], hasMore: false },
    2,
    ALL_VISIBLE,
  )
  assert.deepEqual(merged.items.map(row => row.sessionId), ['l1', 'l2'])
})

// ---- P1-2: remote hits are filtered by the visible set ----

test('mergeSearchResults drops remote hits outside the visible set (archived/subagent/blank 混入)', () => {
  const remote = {
    items: [
      { sessionId: 'visible-hit', snippet: 'kept' },
      { sessionId: 'archived-hit', snippet: 'dropped' },
      { sessionId: 'subagent-hit', snippet: 'dropped' },
      { sessionId: 'blank-hit', snippet: 'dropped' },
    ],
    hasMore: false,
  }
  const merged = mergeSearchResults([], remote, 20, new Set(['visible-hit']))
  assert.deepEqual(merged.items, [{ sessionId: 'visible-hit', snippet: 'kept' }])
  assert.equal(merged.hasMore, false)
})

test('mergeSearchResults keeps visible remote hits and adopts their snippet for local hits', () => {
  const local: SearchRow[] = [{ sessionId: 'both', snippet: '' }]
  const remote = {
    items: [
      { sessionId: 'both', snippet: 'content snippet' },
      { sessionId: 'visible-only', snippet: 'remote snippet' },
      { sessionId: 'hidden', snippet: 'dropped' },
    ],
    hasMore: false,
  }
  const merged = mergeSearchResults(local, remote, 20, new Set(['both', 'visible-only']))
  assert.deepEqual(merged.items, [
    { sessionId: 'both', snippet: 'content snippet' },
    { sessionId: 'visible-only', snippet: 'remote snippet' },
  ])
})

test('mergeSearchResults keeps remote hits when the visible set is empty (projection not ready)', () => {
  // 断连/投影未就绪：可见集为空必须降级为不过滤——绝不能误杀全部远程命中。
  const remote = {
    items: [
      { sessionId: 'x', snippet: 'kept' },
      { sessionId: 'y', snippet: 'also kept' },
    ],
    hasMore: false,
  }
  const merged = mergeSearchResults([], remote, 20, new Set())
  assert.deepEqual(merged.items, [
    { sessionId: 'x', snippet: 'kept' },
    { sessionId: 'y', snippet: 'also kept' },
  ])
})

test('mergeSearchResults hasMore reflects the post-filter merged result', () => {
  // 被过滤掉的远程行既不出现、也不计入 limit 溢出判断。
  const filtered = mergeSearchResults(
    [],
    {
      items: [
        { sessionId: 'visible', snippet: 'kept' },
        { sessionId: 'hidden', snippet: 'dropped' },
      ],
      hasMore: false,
    },
    1,
    new Set(['visible']),
  )
  assert.deepEqual(filtered.items, [{ sessionId: 'visible', snippet: 'kept' }])
  assert.equal(filtered.hasMore, false) // 1 merged row ≤ limit 1
  // 后端 hasMore 提示基于过滤后的列表保留（官方 content.hasMore 公式）。
  const hinted = mergeSearchResults(
    [],
    { items: [{ sessionId: 'visible', snippet: '' }], hasMore: true },
    20,
    new Set(['visible']),
  )
  assert.equal(hinted.hasMore, true)
})

// ---- increasedForkTitle (P1-4, official runtime service port) ----

test('increasedForkTitle starts an unnumbered title at (1)', () => {
  assert.equal(increasedForkTitle('DeepSeek R1'), 'DeepSeek R1 (1)')
  assert.equal(increasedForkTitle(''), ' (1)')
})

test('increasedForkTitle increments a trailing half-width parenthesized number', () => {
  assert.equal(increasedForkTitle('DeepSeek R1 (1)'), 'DeepSeek R1 (2)')
  assert.equal(increasedForkTitle('a (9)'), 'a (10)')
  assert.equal(increasedForkTitle('a (0)'), 'a (1)')
})

test('increasedForkTitle increments a trailing full-width parenthesized number', () => {
  assert.equal(increasedForkTitle('研究（3）'), '研究（4）')
  assert.equal(increasedForkTitle('计划（1）'), '计划（2）')
})

test('increasedForkTitle appends (1) when the trailing parenthesis is not numeric', () => {
  assert.equal(increasedForkTitle('a (x)'), 'a (x) (1)')
  assert.equal(increasedForkTitle('a (1b)'), 'a (1b) (1)')
  assert.equal(increasedForkTitle('a 1'), 'a 1 (1)')
  assert.equal(increasedForkTitle('a（x）'), 'a（x） (1)')
})

test('increasedForkTitle increments without precision loss (BigInt)', () => {
  assert.equal(increasedForkTitle(`huge (${'9'.repeat(40)})`), `huge (1${'0'.repeat(40)})`)
})
