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
  deriveServerWorkspaces,
  mergeRuntimeFacts,
  projectRuntimeFacts,
  reconcileCompletedFacts,
  reconciledSessionOrder,
  relativeTimeBucket,
  sanitizeSearchQuery,
  SEARCH_QUERY_MAX_CODE_UNITS,
  UNGROUPED_WORKSPACE_ID,
} from '../src/shared/derive.ts'
import type { InstanceSnapshot, SessionRow, WorkspaceRow } from '../src/shared/instance-api.ts'

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
