/**
 * Search merge and archive projection (part 5 of the derive split):
 * mergeSearchResults visible-set filtering, deriveArchivedSessions ordering
 * and attribution, groupArchivedRows and the archive-set signature pins.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveArchivedSessions,
  groupArchivedRows,
  instanceSnapshotSignature,
  mergeSearchResults,
  projectInstanceSnapshot,
  serversProjectionSignature,
  UNGROUPED_WORKSPACE_ID,
} from '../../src/shared/derive.ts'
import type { InstanceSnapshot, SearchRow } from '../../src/shared/instance-api.ts'
import { session, snapshot, workspace } from '../support/derive-fixtures.ts'

// ---- mergeSearchResults (design 06 §1.1 merge; P1-2 visible-set filter) ----

// The pre-filter tests simulate a projection where every row is visible.
const ALL_VISIBLE = new Set(['l1', 'l2', 'l3', 'r1', 'r2', 'both', 'x', 'y'])

/** A remote search leg as the wire carries it (hasMore defaults to false). */
const remoteOf = (items: SearchRow[], hasMore = false) => ({ items, hasMore })

/** A minimal aggregate row for the publish-gate probes (overrides carry the fact under test). */
const bareServer = (overrides: Record<string, unknown> = {}) => ({
  id: 'local', sourceFingerprint: 'fp', kind: 'local' as const, transport: 'local' as const,
  label: 'local', connected: true, phase: 'ready', workspaces: [], updatedAt: 1, ...overrides,
})

test('mergeSearchResults leads with local hits then appends remote-only rows', () => {
  const local: SearchRow[] = [{ sessionId: 'l1', snippet: '' }, { sessionId: 'l2', snippet: '' }]
  const remote = remoteOf([{ sessionId: 'r1', snippet: 'remote one' }, { sessionId: 'r2', snippet: 'remote two' }])
  const merged = mergeSearchResults(local, remote, 20, ALL_VISIBLE, true)
  assert.deepEqual(merged.items.map(row => row.sessionId), ['l1', 'l2', 'r1', 'r2'])
  assert.equal(merged.hasMore, false)
})

test('mergeSearchResults adopts the remote snippet for sessions hit in both legs', () => {
  const local: SearchRow[] = [{ sessionId: 'l1', snippet: '' }, { sessionId: 'both', snippet: '' }]
  const remote = remoteOf([{ sessionId: 'both', snippet: 'content snippet' }, { sessionId: 'r1', snippet: 'remote one' }])
  const merged = mergeSearchResults(local, remote, 20, ALL_VISIBLE, true)
  assert.deepEqual(merged.items, [
    { sessionId: 'l1', snippet: '' },
    { sessionId: 'both', snippet: 'content snippet' },
    { sessionId: 'r1', snippet: 'remote one' },
  ])
})

test('mergeSearchResults dedupes sessionIds within the remote leg', () => {
  const remote = remoteOf([{ sessionId: 'x', snippet: 'first' }, { sessionId: 'x', snippet: 'second' }, { sessionId: 'y', snippet: 'other' }])
  const merged = mergeSearchResults([], remote, 20, ALL_VISIBLE, true)
  assert.deepEqual(merged.items, [
    { sessionId: 'x', snippet: 'first' },
    { sessionId: 'y', snippet: 'other' },
  ])
})

test('mergeSearchResults sets hasMore from the remote hint', () => {
  const merged = mergeSearchResults([], remoteOf([{ sessionId: 'x', snippet: '' }], true), 20, ALL_VISIBLE, true)
  assert.equal(merged.hasMore, true)
})

test('mergeSearchResults sets hasMore when the merged result exceeds the limit', () => {
  const merged = mergeSearchResults(
    [{ sessionId: 'l1', snippet: '' }, { sessionId: 'l2', snippet: '' }],
    remoteOf([{ sessionId: 'r1', snippet: '' }]), 2, ALL_VISIBLE, true)
  assert.deepEqual(merged.items.map(row => row.sessionId), ['l1', 'l2'])
  assert.equal(merged.hasMore, true) // 3 merged rows > limit 2
})

test('mergeSearchResults bounds the items to the limit', () => {
  const merged = mergeSearchResults(
    [{ sessionId: 'l1', snippet: '' }, { sessionId: 'l2', snippet: '' }, { sessionId: 'l3', snippet: '' }],
    remoteOf([{ sessionId: 'r1', snippet: '' }]), 2, ALL_VISIBLE, true)
  assert.deepEqual(merged.items.map(row => row.sessionId), ['l1', 'l2'])
})

// ---- P1-2: remote hits are filtered by the visible set ----

test('mergeSearchResults drops remote hits outside the visible set (archived/subagent/blank 混入)', () => {
  const remote = remoteOf([
    { sessionId: 'visible-hit', snippet: 'kept' }, { sessionId: 'archived-hit', snippet: 'dropped' },
    { sessionId: 'subagent-hit', snippet: 'dropped' }, { sessionId: 'blank-hit', snippet: 'dropped' },
  ])
  const merged = mergeSearchResults([], remote, 20, new Set(['visible-hit']), true)
  assert.deepEqual(merged.items, [{ sessionId: 'visible-hit', snippet: 'kept' }])
  assert.equal(merged.hasMore, false)
})

test('mergeSearchResults keeps visible remote hits and adopts their snippet for local hits', () => {
  const local: SearchRow[] = [{ sessionId: 'both', snippet: '' }]
  const remote = remoteOf([
    { sessionId: 'both', snippet: 'content snippet' }, { sessionId: 'visible-only', snippet: 'remote snippet' },
    { sessionId: 'hidden', snippet: 'dropped' },
  ])
  const merged = mergeSearchResults(local, remote, 20, new Set(['both', 'visible-only']), true)
  assert.deepEqual(merged.items, [
    { sessionId: 'both', snippet: 'content snippet' },
    { sessionId: 'visible-only', snippet: 'remote snippet' },
  ])
})

test('mergeSearchResults: a READY projection with an empty visible set filters ALL remote hits (M7 — 合法空集合不再放行隐藏会话)', () => {
  const remote = remoteOf([{ sessionId: 'x', snippet: 'hidden' }, { sessionId: 'y', snippet: 'also hidden' }])
  const merged = mergeSearchResults([], remote, 20, new Set(), true)
  assert.deepEqual(merged.items, [])
})

test('mergeSearchResults: a NOT-ready projection keeps remote hits (degrade — 投影未就绪不误杀命中)', () => {
  const remote = remoteOf([{ sessionId: 'x', snippet: 'kept' }, { sessionId: 'y', snippet: 'also kept' }])
  const merged = mergeSearchResults([], remote, 20, new Set(), false)
  assert.deepEqual(merged.items, [
    { sessionId: 'x', snippet: 'kept' },
    { sessionId: 'y', snippet: 'also kept' },
  ])
})

// deriveArchivedSessions (design 24 revision 2026-09): the archive-manager
// metadata projection — rows of the snapshot that belong to the archived set.
test('deriveArchivedSessions lists archived rows only, newest first, with title/cwd metadata', () => {
  const snapshot: InstanceSnapshot = {
    workspaces: [],
    archivedSessionIds: ['a1', 'a2'],
    sessions: [
      session('v1', 300, { title: 'visible', cwd: '/work/a' }),
      session('a1', 500, { title: 'old archived', cwd: '/work/a' }),
      session('a2', 900, { title: 'recent archived' }),
    ],
  }
  const rows = deriveArchivedSessions(snapshot)
  assert.deepEqual(rows.map(row => row.sessionId), ['a2', 'a1'])
  assert.equal(rows[0]?.title, 'recent archived')
  assert.equal(rows[1]?.title, 'old archived')
  assert.equal(rows[1]?.cwd, '/work/a')
  // A visible (non-archived) row never classifies as archived.
  assert.equal(rows.some(row => row.sessionId === 'v1'), false)
})

test('deriveArchivedSessions omits optional metadata and yields [] for an empty archive set', () => {
  const bare: InstanceSnapshot = {
    workspaces: [],
    archivedSessionIds: ['x1'],
    sessions: [{ sessionId: 'x1', running: false, blank: false }],
  }
  assert.deepEqual(deriveArchivedSessions(bare), [{ sessionId: 'x1' }])
  // Unary-fallback snapshot: empty archive set (KNOWN DEGRADATION) → no rows,
  // never a mislabel of visible sessions as archived.
  const fallback: InstanceSnapshot = {
    workspaces: [],
    archivedSessionIds: [],
    sessions: [session('x1', 1, { title: 'resurfaced' })],
  }
  assert.deepEqual(deriveArchivedSessions(fallback), [])
})

// deriveArchivedSessions workspace attribution (2026 grouping revision): the
// archive manager groups its listing by workspace — the row carries the
// host workspace whose membership accounts for it, with a canonical
// cwd==path fallback, else nothing (the manager's ungrouped bucket).
test('deriveArchivedSessions attributes rows via registry membership', () => {
  const archivedSnapshot: InstanceSnapshot = {
    workspaces: [
      workspace('w1', 'Alpha Project', ['a1', 'conflict', 'v1']),
      workspace('w2', 'Beta', ['a2']),
    ],
    archivedSessionIds: ['a1', 'a2', 'conflict', 'orphan'],
    sessions: [
      session('a1', 300, { title: 'in w1', cwd: '/w1' }),
      session('a2', 100, { title: 'in w2', cwd: '/w2' }),
      // Conflict fixture (2026 review): membership (w1) and cwd (/w2 — the
      // path of ANOTHER live workspace) point at different workspaces — a
      // membership/cwd precedence inversion would attribute this row to w2.
      session('conflict', 250, { title: 'member of w1 but cwd of w2', cwd: '/w2' }),
      session('orphan', 200, { title: 'no workspace', cwd: '/gone' }),
      session('v1', 50, { title: 'visible member' }),
    ],
  }
  const rows = deriveArchivedSessions(archivedSnapshot)
  const byId = new Map(rows.map(row => [row.sessionId, row]))
  // Membership is authoritative: a cwd matching another live workspace path
  // never overrides the registry membership.
  assert.deepEqual(byId.get('a1')?.workspace, { id: 'w1', title: 'Alpha Project' })
  assert.deepEqual(byId.get('conflict')?.workspace, { id: 'w1', title: 'Alpha Project' })
  assert.deepEqual(byId.get('a2')?.workspace, { id: 'w2', title: 'Beta' })
  assert.equal(byId.get('orphan')?.workspace, undefined)
  assert.equal(byId.get('v1'), undefined)
})

test('deriveArchivedSessions falls back to canonical cwd==path attribution when membership never landed', () => {
  const snap: InstanceSnapshot = {
    // w1 carries EMPTY membership (the documented degenerate host index) —
    // attribution must resolve through the session cwd facts instead. w2 has
    // real membership for a2.
    workspaces: [workspace('w1', 'Alpha', []), workspace('w2', 'Beta', ['a2'])],
    archivedSessionIds: ['a1', 'a2', 'a3'],
    sessions: [
      session('a1', 1, { cwd: '/w1' }),
      session('a2', 2, { cwd: '/elsewhere' }),
      session('a3', 3, { cwd: '/w1/' }), // trailing separators normalize
    ],
  }
  const rows = deriveArchivedSessions(snap)
  const byId = new Map(rows.map(row => [row.sessionId, row]))
  assert.deepEqual(byId.get('a1')?.workspace, { id: 'w1', title: 'Alpha' })
  // Membership wins over cwd when both exist (a2's cwd does not match /w2,
  // but its membership row does — the fallback is never consulted).
  assert.deepEqual(byId.get('a2')?.workspace, { id: 'w2', title: 'Beta' })
  assert.deepEqual(byId.get('a3')?.workspace, { id: 'w1', title: 'Alpha' })
})

// groupArchivedRows (2026 grouping revision): the manager's collapsible
// listing — ordered groups (newest member first), recency inside a group,
// and the no-attribution bucket trailing LAST (nav trailing-bucket parity).
test('groupArchivedRows orders workspace groups newest-first and trails the ungrouped bucket last', () => {
  const groups = groupArchivedRows([
    { sessionId: 'o1', updatedAt: 999 },
    { sessionId: 'a2', updatedAt: 100, workspace: { id: 'w2', title: 'Beta' } },
    { sessionId: 'a1b', updatedAt: 200, workspace: { id: 'w1', title: 'Alpha' } },
    { sessionId: 'a1', updatedAt: 300, workspace: { id: 'w1', title: 'Alpha' } },
  ])
  assert.deepEqual(groups.map(group => group.key), ['w1', 'w2', UNGROUPED_WORKSPACE_ID])
  assert.equal(groups[0]?.title, 'Alpha')
  assert.deepEqual(groups[0]?.rows.map(row => row.sessionId), ['a1', 'a1b'])
  assert.deepEqual(groups[1]?.rows.map(row => row.sessionId), ['a2'])
  assert.deepEqual(groups[2]?.title, '')
  assert.equal(groups[2]?.workspace, undefined)
  assert.deepEqual(groups[2]?.rows.map(row => row.sessionId), ['o1'])
})

test('groupArchivedRows yields [] for no rows and is self-contained (unordered input)', () => {
  assert.deepEqual(groupArchivedRows([]), [])
  const groups = groupArchivedRows([
    { sessionId: 'late', workspace: { id: 'w1', title: 'Alpha' } },
    { sessionId: 'early', updatedAt: 5, workspace: { id: 'w1', title: 'Alpha' } },
  ])
  assert.equal(groups.length, 1)
  // updatedAt-missing rows sort last inside their group (0 anchor), stable.
  assert.deepEqual(groups[0]?.rows.map(row => row.sessionId), ['early', 'late'])
})

// Archive-set provenance + projection-signature participation (2026-09
// review round): the purge → requestRefresh → republish chain that updates
// an OPEN archive-manager dialog depends on archivedSessions/archiveSetKnown
// moving serversProjectionSignature — a dropped contribution would silently
// stop dialog-list refresh after a purge.
test('projectInstanceSnapshot marks the mounted archive set as known', () => {
  const workspaces = {
    items: [workspace('w1', 'w1')],
    archivedSessionIds: [] as string[],
    state: 'idle',
    phase: 'ready',
  }
  const sessions = { ids: [], byId: {}, phase: 'ready' }
  const projected = projectInstanceSnapshot(workspaces, sessions)
  assert.ok(projected !== undefined)
  // Even an EMPTY mounted archive set is authoritative (true "nothing
  // archived" fact) — the flag is what separates it from the fallback.
  assert.equal(projected.archiveSetKnown, true)
})

test('instanceSnapshotSignature changes when archiveSetKnown changes', () => {
  const base = snapshot([], [])
  const known = { ...base, archiveSetKnown: true }
  const unknown = { ...base, archiveSetKnown: false }
  assert.notEqual(instanceSnapshotSignature(known), instanceSnapshotSignature(unknown))
  assert.equal(instanceSnapshotSignature({ ...base, archiveSetKnown: true }),
    instanceSnapshotSignature({ ...base, archiveSetKnown: true }))
})

test('serversProjectionSignature: archivedSessions and archiveSetKnown participate in the publish gate', () => {
  const plain = bareServer()
  const withRows = bareServer({ archivedSessions: [{ sessionId: 's1', updatedAt: 5 }] })
  const withoutRows = bareServer({ archivedSessions: [] })
  const degraded = bareServer({ archivedSessions: [], archiveSetKnown: false })
  const authoritative = bareServer({ archivedSessions: [], archiveSetKnown: true })
  // Rows presence/absence and provenance all move the signature…
  assert.notEqual(serversProjectionSignature([plain] as never), serversProjectionSignature([withRows] as never))
  assert.notEqual(serversProjectionSignature([withoutRows] as never), serversProjectionSignature([withRows] as never))
  assert.notEqual(serversProjectionSignature([degraded] as never), serversProjectionSignature([authoritative] as never))
  // …and identical inputs stay identical (null normalization).
  assert.equal(serversProjectionSignature([plain] as never), serversProjectionSignature([bareServer()] as never))
  assert.equal(serversProjectionSignature([degraded] as never),
    serversProjectionSignature([bareServer({ archivedSessions: [], archiveSetKnown: false })] as never))
})

// 2026-09-11 review-fix finding 1: the active-Schedule marker is rendered by
// the sidebar row, and a schedule/change log record moves NOTHING else in the
// projection row (updatedAt is max(createdAt, lastPromptAt), untouched by a
// schedule record) — so the fact must move serversProjectionSignature, which
// BOTH publish gates read (App.tsx before chamberBridge.publish, and this
// shell's own subscription). Without it the marker freezes at its first-seen
// value until an unrelated change re-publishes.
test('serversProjectionSignature: a schedule-only flip republishes, reverting restores identical bytes', () => {
  const makeServer = (hasActiveSchedule: boolean) => bareServer({
    workspaces: [{
      id: 'w1', title: 'Work',
      // Everything else byte-identical: the schedule bit is the only delta.
      sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, blank: false, updatedAt: 5, hasActiveSchedule }],
    }],
  })
  const idle = serversProjectionSignature([makeServer(false)] as never)
  const armed = serversProjectionSignature([makeServer(true)] as never)
  assert.notEqual(idle, armed, 'gaining an active schedule must move the publish gate')
  // ...and losing it again returns the EXACT original bytes, so the gate can
  // never latch on a phantom difference.
  assert.equal(idle, serversProjectionSignature([makeServer(false)] as never))
  // A row that never carries the key at all is the same fact as an explicit
  // false (both are "no active schedule") — the non-sparse form is stable.
  const keyless = serversProjectionSignature([{
    ...makeServer(false),
    workspaces: [{
      id: 'w1',
      title: 'Work',
      sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, blank: false, updatedAt: 5 }],
    }],
  }] as never)
  assert.equal(keyless, idle, 'a key-less row and an explicit false must publish identical bytes')
})

