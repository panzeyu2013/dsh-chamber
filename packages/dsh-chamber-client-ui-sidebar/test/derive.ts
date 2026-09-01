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
  armBlankGhost,
  armMembershipGrace,
  BLANK_GHOST_GRACE_MS,
  deriveLocalSearchMatches,
  deriveServerWorkspaces,
  hashString,
  increasedForkTitle,
  instanceSnapshotSignature,
  MEMBERSHIP_GRACE_MS,
  mergeRuntimeFacts,
  mergeSearchResults,
  nextServerOrder,
  nextUpdatedOrder,
  orderServersForDisplay,
  orderUngroupedSessions,
  projectRuntimeFacts,
  projectInstanceSnapshot,
  reconcileCompletedFacts,
  reconciledSessionOrder,
  relativeTimeBucket,
  retainMembershipGraceSources,
  runningRingVisible,
  runtimeReportSignature,
  sanitizeSearchQuery,
  serversProjectionSignature,
  SEARCH_QUERY_MAX_CODE_UNITS,
  UNGROUPED_WORKSPACE_ID,
  workspaceAccentStyle,
  __resetBlankGhostsForTests,
  __resetMembershipGracesForTests,
} from '../src/shared/derive.ts'
import type { InstanceSnapshot, SearchRow, SessionRow, WorkspaceRow } from '../src/shared/instance-api.ts'
import type { ChamberServerAggregate, InstanceRuntimeReport } from '../src/shared/aggregate-store.ts'

function session(
  id: string,
  updatedAt = 0,
  extra: Partial<Pick<SessionRow, 'blank' | 'origin' | 'title' | 'running' | 'parentSessionId'>> = {},
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

test('projectInstanceSnapshot requires complete reconnect baselines and maps ctx rows', () => {
  const workspaceState = {
    items: [workspace('w1', 'Work', ['s1', 'sub'])],
    archivedSessionIds: ['old'],
    state: 'idle',
    phase: 'ready',
  }
  const sessionState = {
    ids: ['s1', 'sub'],
    phase: 'ready',
    byId: {
      s1: { id: 's1', title: 'One', cwd: '/w1', running: true, blank: false, updatedAt: 42 },
      sub: { id: 'sub', origin: 'subagent' as const, running: true, blank: false },
    },
  }
  assert.deepEqual(projectInstanceSnapshot(workspaceState, sessionState), {
    workspaces: [workspace('w1', 'Work', ['s1', 'sub'])],
    sessions: [{ sessionId: 's1', updatedAt: 42, running: true, blank: false, cwd: '/w1', title: 'One' }],
    archivedSessionIds: ['old'],
  })
  // v0.1.2-alpha.1: the upstream `baselinesReady` field was removed — the
  // workspace completeness check is `state === 'idle'` + `phase === 'ready'`.
  // The withdrawal on `state` deviation is REQUIRED (2026-09 review): it
  // clears the producer's content signature so an identical recovered
  // baseline re-emits after reconnect; the renderer App keeps the last pushed
  // view through the withdrawal window instead of falling back.
  assert.equal(projectInstanceSnapshot({ ...workspaceState, state: 'loading' }, sessionState), undefined)
  assert.equal(projectInstanceSnapshot({ ...workspaceState, state: 'error' }, sessionState), undefined)
  assert.equal(projectInstanceSnapshot({ ...workspaceState, phase: 'pending' }, sessionState), undefined)
  assert.equal(projectInstanceSnapshot(workspaceState, { ...sessionState, phase: 'pending' }), undefined)

  // Upstream phases are sticky across reconnect, and the workspace store's
  // pull-activity `state` is the single completeness authority (the session
  // store projects only `phase`). A loading workspace projection must withdraw
  // the old report so the same-content idle baseline can be emitted again
  // after the producer resets its signature.
  assert.equal(projectInstanceSnapshot(
    { ...workspaceState, state: 'loading' },
    sessionState,
  ), undefined)
  assert.deepEqual(projectInstanceSnapshot(workspaceState, sessionState), {
    workspaces: [workspace('w1', 'Work', ['s1', 'sub'])],
    sessions: [{ sessionId: 's1', updatedAt: 42, running: true, blank: false, cwd: '/w1', title: 'One' }],
    archivedSessionIds: ['old'],
  })
})

test('projectInstanceSnapshot synthesizes workspace membership from cwd facts when the baseline sessionIds are degenerate', () => {
  // M1 wire-degradation defense (2026-09): the host's canonical-cwd header
  // index can be incomplete at init, so the follow baseline carries workspace
  // rows with EMPTY sessionIds while sessions exist. When every workspace is
  // empty AND at least one session's cwd matches a workspace path, membership
  // is synthesized from the session cwd facts (store identity/order/title
  // preserved).
  const workspaceState = {
    items: [workspace('w1', 'Work', []), workspace('w2', 'Other', [])],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
  }
  const sessionState = {
    ids: ['s1', 's2', 's3'],
    phase: 'ready',
    byId: {
      s1: { id: 's1', title: 'One', cwd: '/w1', running: false, blank: false },
      s2: { id: 's2', title: 'Two', cwd: '/w1', running: false, blank: false },
      s3: { id: 's3', title: 'Three', cwd: '/nowhere', running: false, blank: false },
    },
  }
  const projected = projectInstanceSnapshot(workspaceState, sessionState)
  assert.deepEqual(projected?.workspaces[0].sessionIds, ['s1', 's2'])
  assert.deepEqual(projected?.workspaces[1].sessionIds, [])
  // Sessions with no matching workspace stay ungrouped by the derive layer.
  assert.deepEqual(projected?.sessions.map(row => row.sessionId), ['s1', 's2', 's3'])
})

test('projectInstanceSnapshot does NOT synthesize membership when cwd facts do not match any workspace path', () => {
  // Genuinely-empty workspaces must stay empty: no cwd row matches a
  // workspace path, so the degenerate cross-section guard does not fire.
  const workspaceState = {
    items: [workspace('w1', 'Work', [])],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
  }
  const sessionState = {
    ids: ['s1'],
    phase: 'ready',
    byId: { s1: { id: 's1', title: 'One', cwd: '/elsewhere', running: false, blank: false } },
  }
  const projected = projectInstanceSnapshot(workspaceState, sessionState)
  assert.deepEqual(projected?.workspaces[0].sessionIds, [])
})

test('projectInstanceSnapshot cwd synthesis normalizes trailing separators on both sides', () => {
  // The session cwd may carry a trailing slash while the workspace path is
  // stored canonical without one — both sides normalize before matching.
  const workspaceState = {
    items: [workspace('w1', 'Work', [])],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
  }
  const sessionState = {
    ids: ['s1'],
    phase: 'ready',
    byId: { s1: { id: 's1', title: 'One', cwd: '/w1/', running: false, blank: false } },
  }
  const projected = projectInstanceSnapshot(workspaceState, sessionState)
  assert.deepEqual(projected?.workspaces[0].sessionIds, ['s1'])
})

test('blank sessions are hidden from workspaces and from the ungrouped bucket when not current', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { blank: true })],
    ),
    'srv-a',
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
    'srv-a',
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
    'srv-a',
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
    'srv-a',
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
    'srv-a',
    '',
    'b2',
  )
  assert.deepEqual(result[0].sessions, [{ id: 'b2', title: '', running: false, updatedAt: 2, blank: true }])
})

// ---- blank-row ghost slot (2026-08 review: double-click mis-target fix) ----

test('a departed blank session keeps its layout slot (ghost) while the grace is live', () => {
  __resetBlankGhostsForTests()
  // The sidebar arms the ghost SYNCHRONOUSLY at the transition click (t=1000)
  // — the click that opens real session `a` while blank `b` is current. The
  // App re-derives a moment later with current='a'; within the grace the
  // departed blank row STAYS in the projection (a non-interactive ghost) so
  // every row below keeps its position inside the 350ms double-click window.
  armBlankGhost('srv-a', 'b', 1000)
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { blank: true })],
    ),
    'srv-a',
    '',
    'a',
    1000 + BLANK_GHOST_GRACE_MS - 1,
  )
  assert.deepEqual(result[0].sessions, [
    { id: 'a', title: '', running: false, updatedAt: 1 },
    { id: 'b', title: '', running: false, updatedAt: 2, blank: true },
  ])
})

test('the ghost grace expires at BLANK_GHOST_GRACE_MS: the departed blank row then hides', () => {
  __resetBlankGhostsForTests()
  armBlankGhost('srv-a', 'b', 1000)
  // Boundary is exclusive (expiry > now): exactly BLANK_GHOST_GRACE_MS later
  // the ghost is gone and the list may shift — safely after the window.
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { blank: true })],
    ),
    'srv-a',
    '',
    'a',
    1000 + BLANK_GHOST_GRACE_MS,
  )
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', running: false, updatedAt: 1 }])
})

test('a departed blank row hides immediately when no ghost was armed (pre-grace behavior)', () => {
  __resetBlankGhostsForTests()
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { blank: true })],
    ),
    'srv-a',
    '',
    'a',
  )
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', running: false, updatedAt: 1 }])
})

test('the ghost also holds a departed blank stray in the ungrouped bucket', () => {
  __resetBlankGhostsForTests()
  armBlankGhost('srv-a', 'blank', 1000)
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a'])],
      [session('a', 1), session('blank', 300, { blank: true })],
    ),
    'srv-a',
    '',
    'a',
    1200,
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[1].sessions, [{ id: 'blank', title: '', running: false, updatedAt: 300, blank: true }])
})

test('arming the ghost never surfaces a NON-blank session (the map only affects blank rows)', () => {
  __resetBlankGhostsForTests()
  armBlankGhost('srv-a', 'a', 1000) // `a` is a real session — the arm must be ignored
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { blank: true })],
    ),
    'srv-a',
    '',
    'b',
    1200,
  )
  // Real sessions are always visible regardless of the map; the current blank
  // stays visible through the currentness rule.
  assert.deepEqual(result[0].sessions, [
    { id: 'a', title: '', running: false, updatedAt: 1 },
    { id: 'b', title: '', running: false, updatedAt: 2, blank: true },
  ])
})

test('a refreshed arm extends the ghost (a later real transition wins over an earlier stale arm)', () => {
  __resetBlankGhostsForTests()
  // A click on the blank row itself armed a stale ghost at t=1000 (expires
  // t=1450); the real transition click at t=2000 re-arms with a fresh expiry.
  armBlankGhost('srv-a', 'b', 1000)
  armBlankGhost('srv-a', 'b', 2000)
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { blank: true })],
    ),
    'srv-a',
    '',
    'a',
    2100, // inside the FRESH grace, past the stale one
  )
  assert.deepEqual(result[0].sessions, [
    { id: 'a', title: '', running: false, updatedAt: 1 },
    { id: 'b', title: '', running: false, updatedAt: 2, blank: true },
  ])
})

test('the ghost grace is SOURCE-scoped — a cloned UUID on another source never shares it (L2)', () => {
  __resetBlankGhostsForTests()
  // Source A arms the ghost for its clone row; source B's derive (same UUID,
  // different source) must NOT see the grace — its departed blank row hides.
  armBlankGhost('srv-a', 'clone-uuid', 1000)
  const resultB = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['clone-uuid'])],
      [session('clone-uuid', 2, { blank: true })],
    ),
    'srv-b',
    '',
    undefined,
    1200,
  )
  assert.deepEqual(resultB[0].sessions, [], 'source B must not inherit source A\'s ghost grace')
  const resultA = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['clone-uuid'])],
      [session('clone-uuid', 2, { blank: true })],
    ),
    'srv-a',
    '',
    undefined,
    1200,
  )
  assert.deepEqual(resultA[0].sessions, [{ id: 'clone-uuid', title: '', running: false, updatedAt: 2, blank: true }])
})

// ---- membership grace (create + bounded first-observation fork grace) ----

test('a just-created session is skipped from the ungrouped bucket while the membership grace is live', () => {
  __resetMembershipGracesForTests()
  // The host publishes session-added BEFORE workspace-changed: the interim
  // store cross-section lists the new session while no workspace accounts it.
  // The sidebar armed the grace synchronously after the create resolved; the
  // App's derive must NOT surface the row under 未分类 during the grace.
  armMembershipGrace('srv-a', 'new', 1000)
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a'])],
      [session('a', 1), session('new', 500, { blank: true })],
    ),
    'srv-a',
    '',
    'new',
    1500,
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', running: false, updatedAt: 1 }])
})

test('the membership grace never hides a session its workspace already accounts', () => {
  __resetMembershipGracesForTests()
  armMembershipGrace('srv-a', 'new', 1000)
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['new', 'a'])],
      [session('new', 500), session('a', 1)],
    ),
    'srv-a',
    '',
    undefined,
    1500,
  )
  // Membership landed: the row renders in its workspace even inside the grace
  // window (the grace only suppresses the STRAY placement).
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [
    { id: 'new', title: '', running: false, updatedAt: 500 },
    { id: 'a', title: '', running: false, updatedAt: 1 },
  ])
})

test('the membership grace expires at MEMBERSHIP_GRACE_MS: the stray then surfaces in the ungrouped bucket', () => {
  __resetMembershipGracesForTests()
  armMembershipGrace('srv-a', 'new', 1000)
  const atExpiry = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a'])],
      [session('a', 1), session('new', 500)],
    ),
    'srv-a',
    '',
    undefined,
    1000 + MEMBERSHIP_GRACE_MS,
  )
  assert.equal(atExpiry.length, 2)
  assert.equal(atExpiry[1].ungrouped, true)
  assert.deepEqual(atExpiry[1].sessions, [{ id: 'new', title: '', running: false, updatedAt: 500 }])
})

test('an unarmed session still surfaces as a stray (grace only affects armed ids)', () => {
  __resetMembershipGracesForTests()
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a'])],
      [session('a', 1), session('stray', 500)],
    ),
    'srv-a',
    '',
    undefined,
    1500,
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[1].sessions, [{ id: 'stray', title: '', running: false, updatedAt: 500 }])
})

test('a refreshed arm extends the membership grace (a later mutation wins over an earlier stale arm)', () => {
  __resetMembershipGracesForTests()
  armMembershipGrace('srv-a', 'new', 1000)
  armMembershipGrace('srv-a', 'new', 4000)
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a'])],
      [session('a', 1), session('new', 500)],
    ),
    'srv-a',
    '',
    undefined,
    4100, // past the stale expiry, inside the fresh one
  )
  assert.equal(result.length, 1)
})

test('the membership grace is source-scoped: an arm on one source never suppresses another source strays', () => {
  __resetMembershipGracesForTests()
  // Host session ids mint from per-process counters on some paths
  // (`session-<n>`), so a same-id session legitimately exists on two sources.
  armMembershipGrace('srv-a', 'session-5', 1000)
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a'])],
      [session('a', 1), session('session-5', 500)],
    ),
    'srv-b', // a DIFFERENT source derives: its stray must stay visible
    '',
    undefined,
    1500,
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[1].sessions, [{ id: 'session-5', title: '', running: false, updatedAt: 500 }])
})

test('a fork child of a workspace-accounted parent is initially skipped by a bounded first-observation grace', () => {
  __resetMembershipGracesForTests()
  // The host-minted child can be published before the fork response, so this
  // grace is armed from the first snapshot rather than by the action caller.
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['parent'])],
      [
        session('parent', 10),
        session('child', 500, { parentSessionId: 'parent' }),
      ],
    ),
    'srv-a',
    '',
    undefined,
    1500,
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [{ id: 'parent', title: '', running: false, updatedAt: 10 }])
})

test('a published fork child surfaces ungrouped when workspace attach has not landed by grace expiry', () => {
  __resetMembershipGracesForTests()
  const pendingAttach = snapshot(
    [workspace('w1', 'Work', ['parent'])],
    [
      session('parent', 10),
      session('child', 500, { parentSessionId: 'parent' }),
    ],
  )
  // First observation arms the grace.
  const first = deriveServerWorkspaces(pendingAttach, 'srv-a', '', undefined, 1000)
  assert.equal(first.length, 1)

  // Upstream can return workspace-attach-failed after already publishing the
  // child. The same partial-success snapshot must become discoverable after
  // the bounded grace instead of being hidden forever.
  const expired = deriveServerWorkspaces(
    pendingAttach,
    'srv-a',
    '',
    undefined,
    1000 + MEMBERSHIP_GRACE_MS,
  )
  assert.equal(expired.length, 2)
  assert.equal(expired[1].ungrouped, true)
  assert.deepEqual(expired[1].sessions, [{ id: 'child', title: '', running: false, updatedAt: 500 }])

  // An expired candidate remains expired while present; repeated derives
  // must not silently re-arm another three-second hiding window.
  const later = deriveServerWorkspaces(
    pendingAttach,
    'srv-a',
    '',
    undefined,
    1000 + MEMBERSHIP_GRACE_MS * 2,
  )
  assert.equal(later.length, 2)
  assert.deepEqual(later[1].sessions.map(row => row.id), ['child'])
})

test('the first-observation fork grace is source-scoped for cloned child ids', () => {
  __resetMembershipGracesForTests()
  const pendingAttach = snapshot(
    [workspace('w1', 'Work', ['parent'])],
    [session('parent', 10), session('child', 500, { parentSessionId: 'parent' })],
  )
  deriveServerWorkspaces(pendingAttach, 'srv-a', '', undefined, 1000)
  deriveServerWorkspaces(pendingAttach, 'srv-b', '', undefined, 2000)

  const expiredOnlyOnA = deriveServerWorkspaces(
    pendingAttach,
    'srv-a',
    '',
    undefined,
    1000 + MEMBERSHIP_GRACE_MS,
  )
  const stillHiddenOnB = deriveServerWorkspaces(
    pendingAttach,
    'srv-b',
    '',
    undefined,
    1000 + MEMBERSHIP_GRACE_MS,
  )
  assert.equal(expiredOnlyOnA.length, 2)
  assert.equal(stillHiddenOnB.length, 1)
})

test('removing a source clears its fork grace so a same-id re-add starts a fresh generation', () => {
  __resetMembershipGracesForTests()
  const pendingAttach = snapshot(
    [workspace('w1', 'Work', ['parent'])],
    [session('parent', 10), session('child', 500, { parentSessionId: 'parent' })],
  )
  deriveServerWorkspaces(pendingAttach, 'srv-a', '', undefined, 1000)
  retainMembershipGraceSources(new Set())
  const readded = deriveServerWorkspaces(
    pendingAttach,
    'srv-a',
    '',
    undefined,
    1000 + MEMBERSHIP_GRACE_MS * 2,
  )
  assert.equal(readded.length, 1, 'the re-added source receives a new bounded grace')
})

test('a fork child of an UNACCOUNTED parent stays visible in the ungrouped bucket (genuinely ungrouped)', () => {
  __resetMembershipGracesForTests()
  // Forking a stray: the host skips the attach (workspace-less source), so
  // the child is genuinely ungrouped — the parent-accounted rule must NOT
  // hide it (the flows reviewer's fork-of-stray case).
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a'])],
      [
        session('a', 1),
        session('stray-parent', 40),
        session('stray-child', 500, { parentSessionId: 'stray-parent' }),
      ],
    ),
    'srv-a',
    '',
    undefined,
    1500,
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[1].sessions, [
    { id: 'stray-child', title: '', running: false, updatedAt: 500 },
    { id: 'stray-parent', title: '', running: false, updatedAt: 40 },
  ])
})

test('an accounted fork child renders in its workspace even while an unrelated grace is armed', () => {
  __resetMembershipGracesForTests()
  armMembershipGrace('srv-a', 'other', 1000)
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['parent', 'child'])],
      [
        session('parent', 10),
        session('child', 500, { parentSessionId: 'parent' }),
        session('other', 600),
      ],
    ),
    'srv-a',
    '',
    undefined,
    1500,
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions.map(row => row.id), ['parent', 'child'])
})

test('subagent sessions are hidden from workspaces and from the ungrouped bucket', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { origin: 'subagent' })],
    ),
    'srv-a',
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
    'srv-a',
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
    'srv-a',
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
    'srv-a',
    'Ungrouped',
  )
  assert.equal(result[1].title, 'Ungrouped')
  assert.equal(result[1].ungrouped, true)
})

test('no stray sessions means no ungrouped bucket', () => {
  const result = deriveServerWorkspaces(
    snapshot([workspace('w1', 'Work', ['a', 'b'])], [session('a', 1), session('b', 2)]),
    'srv-a',
    '',
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'w1')
})

test('empty snapshot derives to an empty list', () => {
  assert.deepEqual(deriveServerWorkspaces(snapshot([], []), 'srv-a', ''), [])
})

test('members not present in the session list are skipped without breaking workspace order', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['missing', 'a'])],
      [session('a', 1, { title: 'A' })],
    ),
    'srv-a',
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
    'srv-a',
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
    'srv-a',
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
    'srv-a',
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
      s2: { running: false },
      s3: { running: true },
      s4: { running: false },
    },
  })
  assert.deepEqual(report, {
    current: 's1',
    sessions: {
      s1: { running: true, completed: true },
      s2: { running: false },
      s3: { running: true },
      s4: { running: false },
    },
  })
})

test('projectRuntimeFacts keeps completed alongside running (pending source removed upstream in 0.1.2)', () => {
  const report = projectRuntimeFacts({
    byId: {
      c: { running: true, completed: true },
    },
  })
  assert.deepEqual(report.sessions, {
    c: { running: true, completed: true },
  })
  assert.equal(report.current, undefined)
})

test('projectRuntimeFacts returns empty sessions for an empty snapshot', () => {
  assert.deepEqual(projectRuntimeFacts({}), { sessions: {} })
  assert.deepEqual(projectRuntimeFacts({ current: 's1' }), { current: 's1', sessions: {} })
})

test('projectRuntimeFacts drops subagent-origin rows (no notification edge / no navigation facts)', () => {
  const report = projectRuntimeFacts({
    current: 's1',
    byId: {
      s1: { running: true },
      sub1: { running: true, origin: 'subagent' },
      sub2: { running: false, completed: true, origin: 'subagent' },
      s2: { running: false, completed: true },
    },
  })
  // subagent 行（无论 running/completed/pending 如何）不进入事实报告——
  // 否则通知边沿会对子代理完成/提问发「未命名会话」通知刷屏。
  assert.deepEqual(report.sessions, {
    s1: { running: true },
    s2: { running: false, completed: true },
  })
  assert.equal(report.current, 's1')
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
  // The count coexists with the sparse completed extra (pending is gone in 0.1.2).
  const combined = projectRuntimeFacts(
    { byId: { a: { running: false, completed: true } } },
    new Map([['a', 3]]),
  )
  assert.deepEqual(combined.sessions.a, { running: false, completed: true, runningSubagents: 3 })
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
    sourceFingerprint: id === 'local' ? 'local' : 'a'.repeat(64),
    kind: id === 'local' ? 'local' : 'dsh',
    transport: id === 'local' ? 'local' : 'ssh',
    label: id,
    connected: true,
    phase: 'ready',
    workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', running: false, updatedAt: 1 }] }],
    updatedAt: 0,
    ...overrides,
  }
}

test('serversProjectionSignature ignores the per-call updatedAt stamp but tracks rendered fields and source ownership', () => {
  const a = [server('local'), server('ssh-r1')]
  const b = [server('local', { updatedAt: 123456789 }), server('ssh-r1', { updatedAt: 987654321 })]
  assert.equal(serversProjectionSignature(a), serversProjectionSignature(b))
  // A same-id authoritative replacement must publish even when every visible
  // field is identical, so source-owned child contexts can retire the old
  // incarnation instead of reusing it.
  assert.notEqual(
    serversProjectionSignature(a),
    serversProjectionSignature([server('local'), server('ssh-r1', { sourceFingerprint: 'b'.repeat(64) })]),
  )
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1')]),
    serversProjectionSignature([server('ssh-r1', { kind: 'gateway' })]),
    'gateway remains a first-class kind in the shared aggregate contract',
  )
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1')]),
    serversProjectionSignature([server('ssh-r1', { transport: 'http' })]),
    'transport is independent from target kind',
  )
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1', { rawId: 'r1' })]),
    serversProjectionSignature([server('ssh-r1', { rawId: 'other' })]),
    'raw IPC identity is part of the bridge contract',
  )
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1')]),
    serversProjectionSignature([server('ssh-r1', { dshVersion: '1.2.3' })]),
    'live host version reaches settings consumers',
  )
  // Session-level updatedAt IS part of the signature since the 2026-08
  // updated-mode alignment (updated = manual order + activity promotion): a
  // session's last-activity tick must re-publish the projection so the
  // sidebar's per-account derivation can promote the session.
  assert.notEqual(
    serversProjectionSignature(a),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', running: false, updatedAt: 999 }] }] }),
    ]),
  )
  // The same session with the same updatedAt still signs identically.
  assert.equal(
    serversProjectionSignature(a),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', running: false, updatedAt: 1 }] }] }),
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

// ---- nextUpdatedOrder (design 06 §3.1, 2026-08: updated = manual + activity promotion) ----

function byIdOf(rows: { id: string; updatedAt?: number }[]): Map<string, { id: string; updatedAt?: number }> {
  return new Map(rows.map(row => [row.id, row]))
}

test('nextUpdatedOrder first observation does a full recency sort and records bookkeeping', () => {
  const sessions = [
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 300 },
    { id: 'c', updatedAt: 200 },
  ]
  const first = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: undefined,
    previousUpdatedAt: undefined,
    byId: byIdOf(sessions),
  })
  assert.deepEqual(first.order, ['b', 'c', 'a'])
  assert.deepEqual(first.updatedAt, { a: 100, b: 300, c: 200 })
  assert.equal(first.changed, true)
  // A re-run with the recorded bookkeeping and the recorded order changes nothing.
  const second = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: first.order,
    previousUpdatedAt: first.updatedAt,
    byId: byIdOf(sessions),
  })
  assert.deepEqual(second.order, ['b', 'c', 'a'])
  assert.equal(second.changed, false)
})

test('nextUpdatedOrder preserves the stored (manual) order until activity promotes', () => {
  const sessions = [
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 300 },
    { id: 'c', updatedAt: 200 },
  ]
  const next = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: ['c', 'a', 'b'],
    previousUpdatedAt: { a: 100, b: 300, c: 200 },
    byId: byIdOf(sessions),
  })
  // No session updated since the last observation → the stored order stands.
  assert.deepEqual(next.order, ['c', 'a', 'b'])
  assert.equal(next.changed, false)
})

test('nextUpdatedOrder promotes a freshly-updated session to the top and pins it there', () => {
  const sessions = [
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 350 }, // b updated since bookkeeping (300)
    { id: 'c', updatedAt: 200 },
  ]
  const promoted = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: ['c', 'a', 'b'],
    previousUpdatedAt: { a: 100, b: 300, c: 200 },
    byId: byIdOf(sessions),
  })
  assert.deepEqual(promoted.order, ['b', 'c', 'a'])
  assert.equal(promoted.changed, true)
  // Pinned: with bookkeeping recorded, a later run with unchanged timestamps
  // keeps b at its promoted position instead of falling back to the wire order.
  const pinned = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: promoted.order,
    previousUpdatedAt: promoted.updatedAt,
    byId: byIdOf(sessions),
  })
  assert.deepEqual(pinned.order, ['b', 'c', 'a'])
  assert.equal(pinned.changed, false)
  // A newer promotion outranks the earlier one.
  const superseded = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: promoted.order,
    previousUpdatedAt: promoted.updatedAt,
    byId: byIdOf([
      { id: 'a', updatedAt: 100 },
      { id: 'b', updatedAt: 350 },
      { id: 'c', updatedAt: 500 },
    ]),
  })
  assert.deepEqual(superseded.order, ['c', 'b', 'a'])
})

test('nextUpdatedOrder promotes sessions never observed before (new members)', () => {
  const next = nextUpdatedOrder({
    sessionIds: ['a', 'd', 'b'],
    stored: ['a', 'b'],
    previousUpdatedAt: { a: 100, b: 300 },
    byId: byIdOf([
      { id: 'a', updatedAt: 100 },
      { id: 'd', updatedAt: 900 },
      { id: 'b', updatedAt: 300 },
    ]),
  })
  // d was never observed → promoted to the top; a/b keep the stored order.
  assert.deepEqual(next.order, ['d', 'a', 'b'])
})

test('nextUpdatedOrder drops sessions that left the wire membership', () => {
  const next = nextUpdatedOrder({
    sessionIds: ['a', 'c'],
    stored: ['b', 'a', 'c'],
    previousUpdatedAt: { a: 100, b: 300, c: 200 },
    byId: byIdOf([
      { id: 'a', updatedAt: 100 },
      { id: 'c', updatedAt: 200 },
    ]),
  })
  assert.deepEqual(next.order, ['a', 'c'])
  assert.equal(next.changed, true)
  // Appends new wire members at the end (reconciledSessionOrder semantics).
  const withNew = nextUpdatedOrder({
    sessionIds: ['a', 'c', 'e'],
    stored: ['a', 'c'],
    previousUpdatedAt: { a: 100, c: 200 },
    byId: byIdOf([
      { id: 'a', updatedAt: 100 },
      { id: 'c', updatedAt: 200 },
      { id: 'e', updatedAt: 1 },
    ]),
  })
  // e is new (never observed) → promoted to the top, not appended.
  assert.deepEqual(withNew.order, ['e', 'a', 'c'])
})

test('nextUpdatedOrder recency sorts by updatedAt descending with the id tiebreak', () => {
  const next = nextUpdatedOrder({
    sessionIds: ['z', 'a', 'm'],
    stored: undefined,
    previousUpdatedAt: undefined,
    byId: byIdOf([
      { id: 'z', updatedAt: 100 },
      { id: 'a', updatedAt: 100 },
      { id: 'm', updatedAt: 100 },
    ]),
  })
  assert.deepEqual(next.order, ['a', 'm', 'z'])
})

test('nextUpdatedOrder treats a missing updatedAt as 0: sorts last, then stays promoted (official edge)', () => {
  const first = nextUpdatedOrder({
    sessionIds: ['known', 'unknown1', 'unknown2'],
    stored: undefined,
    previousUpdatedAt: undefined,
    byId: byIdOf([
      { id: 'known', updatedAt: 5 },
      { id: 'unknown1' },
      { id: 'unknown2' },
    ]),
  })
  // First observation: full recency sort, missing updatedAt sorts as 0.
  assert.deepEqual(first.order, ['known', 'unknown1', 'unknown2'])
  // Sessions without an updatedAt are never recorded in the bookkeeping, so
  // they read as "never observed" and are re-promoted on every run (official
  // behavior) — they settle at the top in id order and stay stable.
  const second = nextUpdatedOrder({
    sessionIds: ['known', 'unknown1', 'unknown2'],
    stored: first.order,
    previousUpdatedAt: first.updatedAt,
    byId: byIdOf([
      { id: 'known', updatedAt: 5 },
      { id: 'unknown1' },
      { id: 'unknown2' },
    ]),
  })
  assert.deepEqual(second.order, ['unknown1', 'unknown2', 'known'])
  const third = nextUpdatedOrder({
    sessionIds: ['known', 'unknown1', 'unknown2'],
    stored: second.order,
    previousUpdatedAt: second.updatedAt,
    byId: byIdOf([
      { id: 'known', updatedAt: 5 },
      { id: 'unknown1' },
      { id: 'unknown2' },
    ]),
  })
  assert.deepEqual(third.order, ['unknown1', 'unknown2', 'known'])
  assert.equal(third.changed, false)
})

test('nextUpdatedOrder re-entry (switched to updated): stored account kept, bookkeeping cleared → one full recency sort, then converges', () => {
  // setOrderBy clears the source's bookkeeping while KEEPING updatedOrder
  // (official switchedToUpdated): the trigger is `previousUpdatedAt ===
  // undefined`, NOT `stored === undefined` — a regression to the latter
  // would silently skip the headline one-time recency sort on re-entry.
  const sessions = [
    { id: 'c', updatedAt: 300 },
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 200 },
  ]
  const reentry = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: ['c', 'a', 'b'],       // retained manual arrangement
    previousUpdatedAt: undefined,  // bookkeeping cleared on switch-in
    byId: byIdOf(sessions),
  })
  // Full recency sort over the retained account: c(300), b(200), a(100).
  assert.deepEqual(reentry.order, ['c', 'b', 'a'])
  assert.deepEqual(reentry.updatedAt, { a: 100, b: 200, c: 300 })
  assert.equal(reentry.changed, true)
  // Converges: the re-run with the recorded bookkeeping is a no-op.
  const steady = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: reentry.order,
    previousUpdatedAt: reentry.updatedAt,
    byId: byIdOf(sessions),
  })
  assert.deepEqual(steady.order, ['c', 'b', 'a'])
  assert.equal(steady.changed, false)
})

test('nextUpdatedOrder a timestamp-only decrease refreshes bookkeeping without reordering', () => {
  // The order never depends on a DECREASED updatedAt (nothing to promote),
  // but the bookkeeping must be refreshed — changed=true so the caller
  // persists the new timestamps (a later increase is then measured from
  // the corrected baseline).
  const sessions = [
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 150 }, // decreased from 200 since the last observation
  ]
  const next = nextUpdatedOrder({
    sessionIds: ['a', 'b'],
    stored: ['a', 'b'],
    previousUpdatedAt: { a: 100, b: 200 },
    byId: byIdOf(sessions),
  })
  assert.deepEqual(next.order, ['a', 'b'])
  assert.deepEqual(next.updatedAt, { a: 100, b: 150 })
  assert.equal(next.changed, true)
})

// ---- orderUngroupedSessions (P2-9 extraction, design 06 §3.1, manual mode) ----

test('orderUngroupedSessions uses the stored order with wire-id appends', () => {
  const wire = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
  ]
  const out = orderUngroupedSessions(wire, ['c', 'a'])
  assert.deepEqual(out.map(x => x.id), ['c', 'a', 'b'])
})

test('orderUngroupedSessions skips stored ids unknown to the wire', () => {
  const wire = [
    { id: 'a' },
    { id: 'b' },
  ]
  const out = orderUngroupedSessions(wire, ['ghost', 'b', 'a'])
  assert.deepEqual(out.map(x => x.id), ['b', 'a'])
})

test('orderUngroupedSessions with no stored order returns the wire order copy', () => {
  const wire = [{ id: 'b' }, { id: 'a' }]
  const out = orderUngroupedSessions(wire, undefined)
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
  const merged = mergeSearchResults(local, remote, 20, ALL_VISIBLE, true)
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
  const merged = mergeSearchResults(local, remote, 20, ALL_VISIBLE, true)
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
  const merged = mergeSearchResults([], remote, 20, ALL_VISIBLE, true)
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
    ALL_VISIBLE, true)
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
    ALL_VISIBLE, true)
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
    ALL_VISIBLE, true)
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
  const merged = mergeSearchResults([], remote, 20, new Set(['visible-hit']), true)
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
  const merged = mergeSearchResults(local, remote, 20, new Set(['both', 'visible-only']), true)
  assert.deepEqual(merged.items, [
    { sessionId: 'both', snippet: 'content snippet' },
    { sessionId: 'visible-only', snippet: 'remote snippet' },
  ])
})

test('mergeSearchResults: a READY projection with an empty visible set filters ALL remote hits (M7 — 合法空集合不再放行隐藏会话)', () => {
  const remote = {
    items: [
      { sessionId: 'x', snippet: 'hidden' },
      { sessionId: 'y', snippet: 'also hidden' },
    ],
    hasMore: false,
  }
  const merged = mergeSearchResults([], remote, 20, new Set(), true)
  assert.deepEqual(merged.items, [])
})

test('mergeSearchResults: a NOT-ready projection keeps remote hits (degrade — 投影未就绪不误杀命中)', () => {
  const remote = {
    items: [
      { sessionId: 'x', snippet: 'kept' },
      { sessionId: 'y', snippet: 'also kept' },
    ],
    hasMore: false,
  }
  const merged = mergeSearchResults([], remote, 20, new Set(), false)
  assert.deepEqual(merged.items, [
    { sessionId: 'x', snippet: 'kept' },
    { sessionId: 'y', snippet: 'also kept' },
  ])
})
