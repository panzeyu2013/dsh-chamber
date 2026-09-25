/**
 * derive.ts unit tests: reconnect-baseline snapshot projection, cwd-derived
 * workspace membership, blank/subagent visibility, the blank-ghost /
 * membership / fork first-observation graces, plus the consolidated projection
 * contracts (facts merge, ordering, labels/reuse, search/archive and the
 * publish signatures).
 *
 * The publish-signature identity and the separator-forgery negative live
 * below. Sibling: derive-unread.test.ts (the shared unread predicate,
 * referenced by the remote-state injection matrix).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import {
  armBlankGhost,
  advanceRunIdentities,
  basenameOf,
  BLANK_GHOST_GRACE_MS,
  deriveArchivedSessions,
  deriveLocalSearchMatches,
  deriveServerWorkspaces,
  groupArchivedRows,
  hasActiveScheduleOf,
  instanceSnapshotSignature,
  mergeRuntimeFacts,
  mergeSearchResults,
  nextServerOrder,
  nextUpdatedOrder,
  orderServersForDisplay,
  orderUngroupedSessions,
  projectInstanceSnapshot,
  projectRuntimeFacts,
  reconcileCompletedFacts,
  reconciledSessionOrder,
  relativeTimeBucket,
  runningRingVisible,
  runtimeReportSignature,
  sanitizeSearchQuery,
  SEARCH_QUERY_MAX_CODE_UNITS,
  serversProjectionSignature,
  sessionDisplayTitle,
} from '@dsh-chamber/dsh-chamber-client-core/derive'
import { chamberRunId } from '@dsh-chamber/dsh-stream-state'
import {
  armMembershipGrace,
  findReusableBlankSession,
  MEMBERSHIP_GRACE_MS,
  retainMembershipGraceSources,
  UNGROUPED_WORKSPACE_ID,
  __resetBlankGhostsForTests,
  __resetMembershipGracesForTests,
} from '../../../dsh-chamber-client-core/src/derive.ts'
import type { InstanceRuntimeReport } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import type { InstanceSnapshot, SearchRow, SessionRow, WorkspaceRow } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { server, session, snapshot, workspace } from '../support/derive-fixtures.ts'

/** Workspace-store projection fixture (idle/ready) for the projectInstanceSnapshot cases. */
function wsState(archivedSessionIds: string[] = [], items = [workspace('w1', 'Work', ['s1', 'sub'])]) {
  return { items, archivedSessionIds, state: 'idle', phase: 'ready' }
}

/** deriveServerWorkspaces over a fixture snapshot (label '', source srv-a unless overridden). */
function deriveOf(
  workspaces: WorkspaceRow[],
  sessions: SessionRow[],
  options: { current?: string; now?: number; sourceId?: string } = {},
) {
  const { current, now, sourceId = 'srv-a' } = options
  return deriveServerWorkspaces(snapshot(workspaces, sessions), sourceId, '', current, now)
}

test('projectInstanceSnapshot requires complete reconnect baselines and maps ctx rows', () => {
  const workspaceState = wsState(['old'])
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
    sessions: [{ sessionId: 's1', updatedAt: 42, running: true, blank: false, cwd: '/w1', title: 'One', displayTitle: 'One' }],
    archivedSessionIds: ['old'],
    // Mounted baseline = authoritative archive set.
    archiveSetKnown: true,
  })
  // The workspace completeness check is `state === 'idle'` + `phase === 'ready'`.
  // The withdrawal on `state` deviation is REQUIRED: it
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
    sessions: [{ sessionId: 's1', updatedAt: 42, running: true, blank: false, cwd: '/w1', title: 'One', displayTitle: 'One' }],
    archivedSessionIds: ['old'],
    archiveSetKnown: true,
  })
})

test('projectInstanceSnapshot synthesizes workspace membership from cwd facts when the baseline sessionIds are degenerate', () => {
  // Wire-degradation defense: the host's canonical-cwd header
  // index can be incomplete at init, so the follow baseline carries workspace
  // rows with EMPTY sessionIds while sessions exist. When every workspace is
  // empty AND at least one session's cwd matches a workspace path, membership
  // is synthesized from the session cwd facts (store identity/order/title
  // preserved).
  const workspaceState = wsState([], [workspace('w1', 'Work', []), workspace('w2', 'Other', [])])
  const sessionState = {
    ids: ['s1', 's2', 's3'],
    phase: 'ready',
    byId: {
      s1: { id: 's1', title: 'One', cwd: '/w1', running: false, blank: false, updatedAt: 3 },
      s2: { id: 's2', title: 'Two', cwd: '/w1', running: false, blank: false, updatedAt: 2 },
      s3: { id: 's3', title: 'Three', cwd: '/nowhere', running: false, blank: false, updatedAt: 1 },
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
  const workspaceState = wsState([], [workspace('w1', 'Work', [])])
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
  const workspaceState = wsState([], [workspace('w1', 'Work', [])])
  const sessionState = {
    ids: ['s1'],
    phase: 'ready',
    byId: { s1: { id: 's1', title: 'One', cwd: '/w1/', running: false, blank: false } },
  }
  const projected = projectInstanceSnapshot(workspaceState, sessionState)
  assert.deepEqual(projected?.workspaces[0].sessionIds, ['s1'])
})

test('blank sessions are hidden from workspaces and from the ungrouped bucket when not current', () => {
  const result = deriveOf([workspace('w1', 'Work', ['a', 'b'])], [session('a', 1), session('b', 2, { blank: true })])
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
  assert.equal(result[0].ungrouped, undefined)
})

test('deriveServerWorkspaces passes the synthetic marker through for cwd-derived fallback groups', () => {
  // fetchInstanceSnapshot marks its `__cwd__:` groups synthetic: true so the
  // sidebar can disable their host-scoped mutations. The
  // derive layer must keep the marker; real rows never carry it.
  const syntheticRow: WorkspaceRow = {
    ...workspace('__cwd__:/work/a', 'a', ['s1']),
    synthetic: true,
  }
  const result = deriveOf([syntheticRow, workspace('w1', 'Work', ['s2'])], [session('s1', 1), session('s2', 2)])
  assert.equal(result[0].synthetic, true)
  assert.equal(result[1].synthetic, undefined)
  assert.equal(result[0].ungrouped, undefined)
})

test('a blank session surfaces while it is the current session (official !blank || current rule)', () => {
  const result = deriveOf(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1), session('b', 2, { blank: true })],
    { current: 'b' },
  )
  assert.deepEqual(result[0].sessions, [
    { id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 },
    { id: 'b', title: '', displayTitle: 'b', running: false, updatedAt: 2, blank: true },
  ])
})

test('a blank-current session not accounted by any workspace trails in the ungrouped bucket', () => {
  const result = deriveOf(
    [workspace('w1', 'Work', ['a'])],
    [session('a', 1), session('blank', 300, { blank: true })],
    { current: 'blank' },
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[1].sessions, [{ id: 'blank', title: '', displayTitle: 'blank', running: false, updatedAt: 300, blank: true }])
})

test('blank rows carry the sparse blank flag; ordinary rows never do', () => {
  const result = deriveOf(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1), session('b', 2, { blank: true })],
    { current: 'b' },
  )
  assert.equal(result[0].sessions[0].blank, undefined)
  assert.equal(result[0].sessions[1].blank, true)
})

test('a non-current blank session stays hidden even when another blank session is current', () => {
  const result = deriveOf(
    [workspace('w1', 'Work', ['b1', 'b2'])],
    [session('b1', 1, { blank: true }), session('b2', 2, { blank: true })],
    { current: 'b2' },
  )
  assert.deepEqual(result[0].sessions, [{ id: 'b2', title: '', displayTitle: 'b2', running: false, updatedAt: 2, blank: true }])
})

// ---- blank-row ghost slot (double-click mis-target guard) ----

test('a departed blank session keeps its layout slot (ghost) while the grace is live', () => {
  __resetBlankGhostsForTests()
  // The sidebar arms the ghost SYNCHRONOUSLY at the transition click (t=1000)
  // — the click that opens real session `a` while blank `b` is current. The
  // App re-derives a moment later with current='a'; within the grace the
  // departed blank row STAYS in the projection (a non-interactive ghost) so
  // every row below keeps its position inside the 350ms double-click window.
  armBlankGhost('srv-a', 'b', 1000)
  const result = deriveOf(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1), session('b', 2, { blank: true })],
    { current: 'a', now: 1000 + BLANK_GHOST_GRACE_MS - 1 },
  )
  assert.deepEqual(result[0].sessions, [
    { id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 },
    { id: 'b', title: '', displayTitle: 'b', running: false, updatedAt: 2, blank: true },
  ])
})

test('the ghost grace expires at BLANK_GHOST_GRACE_MS: the departed blank row then hides', () => {
  __resetBlankGhostsForTests()
  armBlankGhost('srv-a', 'b', 1000)
  // Boundary is exclusive (expiry > now): exactly BLANK_GHOST_GRACE_MS later
  // the ghost is gone and the list may shift — safely after the window.
  const result = deriveOf(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1), session('b', 2, { blank: true })],
    { current: 'a', now: 1000 + BLANK_GHOST_GRACE_MS },
  )
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
})

test('a departed blank row hides immediately when no ghost was armed (pre-grace behavior)', () => {
  __resetBlankGhostsForTests()
  const result = deriveOf(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1), session('b', 2, { blank: true })],
    { current: 'a' },
  )
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
})

test('the ghost also holds a departed blank stray in the ungrouped bucket', () => {
  __resetBlankGhostsForTests()
  armBlankGhost('srv-a', 'blank', 1000)
  const result = deriveOf(
    [workspace('w1', 'Work', ['a'])],
    [session('a', 1), session('blank', 300, { blank: true })],
    { current: 'a', now: 1200 },
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[1].sessions, [{ id: 'blank', title: '', displayTitle: 'blank', running: false, updatedAt: 300, blank: true }])
})

test('arming the ghost never surfaces a NON-blank session (the map only affects blank rows)', () => {
  __resetBlankGhostsForTests()
  armBlankGhost('srv-a', 'a', 1000) // `a` is a real session — the arm must be ignored
  const result = deriveOf(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1), session('b', 2, { blank: true })],
    { current: 'b', now: 1200 },
  )
  // Real sessions are always visible regardless of the map; the current blank
  // stays visible through the currentness rule.
  assert.deepEqual(result[0].sessions, [
    { id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 },
    { id: 'b', title: '', displayTitle: 'b', running: false, updatedAt: 2, blank: true },
  ])
})

test('a refreshed arm extends the ghost (a later real transition wins over an earlier stale arm)', () => {
  __resetBlankGhostsForTests()
  // A click on the blank row itself armed a stale ghost at t=1000 (expires
  // t=1450); the real transition click at t=2000 re-arms with a fresh expiry.
  armBlankGhost('srv-a', 'b', 1000)
  armBlankGhost('srv-a', 'b', 2000)
  const result = deriveOf(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1), session('b', 2, { blank: true })],
    { current: 'a', now: 2100 },
  )
  assert.deepEqual(result[0].sessions, [
    { id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 },
    { id: 'b', title: '', displayTitle: 'b', running: false, updatedAt: 2, blank: true },
  ])
})

test('the ghost grace is SOURCE-scoped — a cloned UUID on another source never shares it (L2)', () => {
  __resetBlankGhostsForTests()
  // Source A arms the ghost for its clone row; source B's derive (same UUID,
  // different source) must NOT see the grace — its departed blank row hides.
  armBlankGhost('srv-a', 'clone-uuid', 1000)
  const resultB = deriveOf(
    [workspace('w1', 'Work', ['clone-uuid'])],
    [session('clone-uuid', 2, { blank: true })],
    { now: 1200, sourceId: 'srv-b' },
  )
  assert.deepEqual(resultB[0].sessions, [], 'source B must not inherit source A\'s ghost grace')
  const resultA = deriveOf(
    [workspace('w1', 'Work', ['clone-uuid'])],
    [session('clone-uuid', 2, { blank: true })],
    { now: 1200 },
  )
  assert.deepEqual(resultA[0].sessions, [{ id: 'clone-uuid', title: '', displayTitle: 'clone-uuid', running: false, updatedAt: 2, blank: true }])
})

// ---- membership grace (create + bounded first-observation fork grace) ----

test('a just-created session is skipped from the ungrouped bucket while the membership grace is live', () => {
  __resetMembershipGracesForTests()
  // The host publishes session-added BEFORE workspace-changed: the interim
  // store cross-section lists the new session while no workspace accounts it.
  // The sidebar armed the grace synchronously after the create resolved; the
  // App's derive must NOT surface the row under 未分类 during the grace.
  armMembershipGrace('srv-a', 'new', 1000)
  const result = deriveOf(
    [workspace('w1', 'Work', ['a'])],
    [session('a', 1), session('new', 500, { blank: true })],
    { current: 'new', now: 1500 },
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
})

test('the membership grace never hides a session its workspace already accounts', () => {
  __resetMembershipGracesForTests()
  armMembershipGrace('srv-a', 'new', 1000)
  const result = deriveOf([workspace('w1', 'Work', ['new', 'a'])], [session('new', 500), session('a', 1)], { now: 1500 })
  // Membership landed: the row renders in its workspace even inside the grace
  // window (the grace only suppresses the STRAY placement).
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [
    { id: 'new', title: '', displayTitle: 'new', running: false, updatedAt: 500 },
    { id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 },
  ])
})

test('the membership grace expires at MEMBERSHIP_GRACE_MS: the stray then surfaces in the ungrouped bucket', () => {
  __resetMembershipGracesForTests()
  armMembershipGrace('srv-a', 'new', 1000)
  const atExpiry = deriveOf(
    [workspace('w1', 'Work', ['a'])],
    [session('a', 1), session('new', 500)],
    { now: 1000 + MEMBERSHIP_GRACE_MS },
  )
  assert.equal(atExpiry.length, 2)
  assert.equal(atExpiry[1].ungrouped, true)
  assert.deepEqual(atExpiry[1].sessions, [{ id: 'new', title: '', displayTitle: 'new', running: false, updatedAt: 500 }])
})

test('an unarmed session still surfaces as a stray (grace only affects armed ids)', () => {
  __resetMembershipGracesForTests()
  const result = deriveOf([workspace('w1', 'Work', ['a'])], [session('a', 1), session('stray', 500)], { now: 1500 })
  assert.equal(result.length, 2)
  assert.deepEqual(result[1].sessions, [{ id: 'stray', title: '', displayTitle: 'stray', running: false, updatedAt: 500 }])
})

test('a refreshed arm extends the membership grace (a later mutation wins over an earlier stale arm)', () => {
  __resetMembershipGracesForTests()
  armMembershipGrace('srv-a', 'new', 1000)
  armMembershipGrace('srv-a', 'new', 4000)
  const result = deriveOf([workspace('w1', 'Work', ['a'])], [session('a', 1), session('new', 500)], { now: 4100 })
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
  assert.deepEqual(result[1].sessions, [{ id: 'session-5', title: '', displayTitle: 'session-5', running: false, updatedAt: 500 }])
})

test('a fork child of a workspace-accounted parent is initially skipped by a bounded first-observation grace', () => {
  __resetMembershipGracesForTests()
  // The host-minted child can be published before the fork response, so this
  // grace is armed from the first snapshot rather than by the action caller.
  const result = deriveOf(
    [workspace('w1', 'Work', ['parent'])],
    [ session('parent', 10), session('child', 500, { parentSessionId: 'parent' }), ],
    { now: 1500 },
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [{ id: 'parent', title: '', displayTitle: 'parent', running: false, updatedAt: 10 }])
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
  const expired = deriveServerWorkspaces(pendingAttach, 'srv-a', '', undefined, 1000 + MEMBERSHIP_GRACE_MS)
  assert.equal(expired.length, 2)
  assert.equal(expired[1].ungrouped, true)
  assert.deepEqual(expired[1].sessions, [{ id: 'child', title: '', displayTitle: 'child', running: false, updatedAt: 500 }])

  // An expired candidate remains expired while present; repeated derives
  // must not silently re-arm another three-second hiding window.
  const later = deriveServerWorkspaces(pendingAttach, 'srv-a', '', undefined, 1000 + MEMBERSHIP_GRACE_MS * 2)
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

  const expiredOnlyOnA = deriveServerWorkspaces(pendingAttach, 'srv-a', '', undefined, 1000 + MEMBERSHIP_GRACE_MS)
  const stillHiddenOnB = deriveServerWorkspaces(pendingAttach, 'srv-b', '', undefined, 1000 + MEMBERSHIP_GRACE_MS)
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
  const readded = deriveServerWorkspaces(pendingAttach, 'srv-a', '', undefined, 1000 + MEMBERSHIP_GRACE_MS * 2)
  assert.equal(readded.length, 1, 'the re-added source receives a new bounded grace')
})

test('a fork child of an UNACCOUNTED parent stays visible in the ungrouped bucket (genuinely ungrouped)', () => {
  __resetMembershipGracesForTests()
  // Forking a stray: the host skips the attach (workspace-less source), so
  // the child is genuinely ungrouped — the parent-accounted rule must NOT
  // hide it (the fork-of-stray case).
  const result = deriveOf(
    [workspace('w1', 'Work', ['a'])],
    [ session('a', 1), session('stray-parent', 40), session('stray-child', 500, { parentSessionId: 'stray-parent' }), ],
    { now: 1500 },
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[1].sessions, [
    { id: 'stray-child', title: '', displayTitle: 'stray-child', running: false, updatedAt: 500 },
    { id: 'stray-parent', title: '', displayTitle: 'stray-parent', running: false, updatedAt: 40 },
  ])
})

test('an accounted fork child renders in its workspace even while an unrelated grace is armed', () => {
  __resetMembershipGracesForTests()
  armMembershipGrace('srv-a', 'other', 1000)
  const result = deriveOf(
    [workspace('w1', 'Work', ['parent', 'child'])],
    [ session('parent', 10), session('child', 500, { parentSessionId: 'parent' }), session('other', 600), ],
    { now: 1500 },
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions.map(row => row.id), ['parent', 'child'])
})

// =====================================================================
// Consolidated projection contracts: the key invariants of
// merge-runtime-facts / workspace-membership / schedule-label-reuse /
// source-ordering / search-and-archive. The retained assertions are the
// fail-closed, cross-source and upstream-alignment ones.
// =====================================================================

// ---- mergeRuntimeFacts: two-argument compatibility lock + overlay/stale ----

/** Verbatim two-argument oracle for the compatibility lock. */
function legacyMergeRuntimeFacts(
  runtime: InstanceRuntimeReport | undefined,
  completedBySource: Record<string, boolean> | undefined,
): InstanceRuntimeReport | undefined {
  const chamberCompleted = completedBySource
  const hasArmed = chamberCompleted !== undefined && Object.values(chamberCompleted).some(value => value === true)
  if (runtime === undefined && !hasArmed) return undefined
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

const RUNTIME_FACTS: InstanceRuntimeReport = {
  current: 's1',
  sessionAuthority: { requestedAt: 1_000, settledAt: 2_000, ok: true, progressStamp: 1, probes: 0, corrections: 0, recent: [] },
  sessions: {
    s1: { running: true },
    s2: { running: false, pending: 'approval', runningSubagents: 2 },
    s3: { running: false, completed: true },
  },
}
const ARMED_DOTS: Record<string, boolean> = { s1: true, s4: true, s5: false }
const COMPAT_CASES: [InstanceRuntimeReport | undefined, Record<string, boolean> | undefined][] = [
  [undefined, undefined], [undefined, {}], [undefined, { x: false }], [RUNTIME_FACTS, undefined],
  [RUNTIME_FACTS, {}], [RUNTIME_FACTS, { s1: false }], [RUNTIME_FACTS, ARMED_DOTS],
  [{ current: 's1', sessions: {} }, undefined],
  [{ sessions: { a: { running: false, completed: true, pending: 'question' } } }, { b: true }],
]

test('mergeRuntimeFacts: the two-argument call stays byte-identical to the pre-overlay implementation', () => {
  for (const [runtime, completed] of COMPAT_CASES) {
    assert.equal(JSON.stringify(mergeRuntimeFacts(runtime, completed)), JSON.stringify(legacyMergeRuntimeFacts(runtime, completed)),
      'two-argument behaviour (including key order) must not move')
  }
  assert.equal(JSON.stringify(mergeRuntimeFacts(RUNTIME_FACTS, ARMED_DOTS)),
    '{"current":"s1","sessions":{"s1":{"running":true,"completed":true},'
    + '"s2":{"running":false,"pending":"approval","runningSubagents":2},'
    + '"s3":{"running":false,"completed":true},"s4":{"completed":true}}}')
})

test('mergeRuntimeFacts: overlay-only content, channel precedence, stale and anti-churn', () => {
  assert.deepEqual(mergeRuntimeFacts(undefined, undefined, { s9: { pending: 'question', runningSubagents: 2 } }),
    { current: undefined, sessions: { s9: { pending: 'question', runningSubagents: 2 } } })
  assert.deepEqual(mergeRuntimeFacts({ sessions: { s1: { running: false, pending: 'approval' } } }, undefined, { s1: { pending: 'question' } })?.sessions.s1,
    { running: false, pending: 'approval' }, 'the channel pending kind wins over the overlay')
  assert.deepEqual(mergeRuntimeFacts({ sessions: { s1: { running: false } } }, undefined, { s1: { pending: 'question' } })?.sessions.s1,
    { running: false, pending: 'question' }, 'an absent channel kind is filled by the overlay')
  assert.deepEqual(mergeRuntimeFacts({ sessions: { a: { running: false, runningSubagents: 1 } } }, undefined, { a: { runningSubagents: 3 } })?.sessions.a,
    { running: false, runningSubagents: 1 }, 'runningSubagents is channel ?? overlay (never double-counted)')
  const zero = mergeRuntimeFacts(undefined, undefined, { a: { runningSubagents: 0 } })
  assert.equal('runningSubagents' in (zero?.sessions.a ?? {}), false, 'a zero overlay count stays sparse')
  assert.deepEqual(mergeRuntimeFacts(undefined, { s1: true }, undefined, true),
    { current: undefined, sessions: { s1: { completed: true } }, stale: true })
  for (const value of [false, undefined]) {
    assert.equal('stale' in (mergeRuntimeFacts(RUNTIME_FACTS, ARMED_DOTS, undefined, value) ?? {}), false)
  }
  assert.equal(mergeRuntimeFacts(undefined, undefined, undefined, true), undefined,
    'stale alone is not content: the two-argument early return is preserved')
  const merged = mergeRuntimeFacts(undefined, undefined, { s1: { pending: 'question', runningSubagents: 1, updatedAt: 999, completedAt: 999 } as never })
  assert.deepEqual(merged?.sessions.s1, { pending: 'question', runningSubagents: 1 }, 'judgment fields never enter the projected row')
})

test('mergeRuntimeFacts: a stale channel report keeps its stale bit and the P5 subagent guard (M3)', () => {
  // 通道报告自身的 stale 位（断连来源的只读事实）必须透传：调用方只透传第四参
  // （App 的 connected 闸 / 观测的 shell.stale），在这里丢掉会让六面与徽标把断连
  // 残留的子代理计数当新鲜事实（badge/sessionRowState 守卫失效）。
  const staleRuntime: InstanceRuntimeReport = {
    current: 'a',
    sessions: {
      a: { running: false, completed: true, runningSubagents: 2 },
      b: { running: true },
    },
    stale: true,
  }
  assert.deepEqual(mergeRuntimeFacts(staleRuntime, undefined), {
    current: 'a',
    sessions: {
      a: { running: false, completed: true, runningSubagents: 2, subagentActivity: 'unknown' },
      b: { running: true },
    },
    stale: true,
  })
  // overlay 补进来的稀疏计数走同一守卫（不留旁路）。
  assert.deepEqual(
    mergeRuntimeFacts({ sessions: { a: { running: false } }, stale: true }, undefined, { a: { runningSubagents: 2 } })?.sessions.a,
    { running: false, runningSubagents: 2, subagentActivity: 'unknown' },
  )
  // 显式第四参与报告位是 OR；报告无该位时两参/四参行为不变（兼容锁的另一半）。
  assert.equal(mergeRuntimeFacts({ sessions: { a: { running: true } }, stale: true }, undefined, undefined, false)?.stale, true)
  assert.equal(mergeRuntimeFacts(RUNTIME_FACTS, ARMED_DOTS)?.stale, undefined)
  assert.equal(mergeRuntimeFacts({ sessions: { a: { running: true } } }, undefined, undefined, true)?.stale, true)
})

test('mergeRuntimeFacts: facts-overlay goal fills unknown channel rows and never overrides a known fact (P2a)', () => {
  // 无壳来源（facts-only）唯一的 goal 通路：overlay 行本身必须成为可附加内容，
  // 且仅填补通道行 goal **缺席**（unknown）的位置——显式 null 也照填，绝不折叠。
  const goal = { goalId: 'g1', revision: 2, phase: 'active' as const }
  assert.deepEqual(mergeRuntimeFacts(undefined, undefined, { s1: { goal } })?.sessions.s1, { goal },
    'an overlay-only goal row is attachable content (no shell report needed)')
  assert.deepEqual(mergeRuntimeFacts({ sessions: { s1: { running: false } } }, undefined, { s1: { goal } })?.sessions.s1,
    { running: false, goal }, 'an absent channel goal is filled by the overlay')
  assert.deepEqual(mergeRuntimeFacts({ sessions: { s1: { running: false } } }, undefined, { s1: { goal: null } })?.sessions.s1,
    { running: false, goal: null }, 'an explicit overlay null fills an unknown channel row')
  // 通道行已给出（对象或显式 null）= 权威；overlay 的已知值绝不覆盖。
  const channelGoal = { goalId: 'g9', revision: 1, phase: 'complete' as const }
  assert.deepEqual(mergeRuntimeFacts({ sessions: { s1: { goal: channelGoal } } }, undefined, { s1: { goal } })?.sessions.s1,
    { goal: channelGoal }, 'the channel goal is authoritative')
  assert.deepEqual(mergeRuntimeFacts({ sessions: { s1: { goal: null } } }, undefined, { s1: { goal } })?.sessions.s1,
    { goal: null }, 'a channel explicit no-goal is authoritative too')
  // overlay 缺席 = unknown：不写字段（绝不臆造 null）。
  assert.deepEqual(mergeRuntimeFacts(undefined, undefined, { s1: {} })?.sessions.s1, {})
  // stale 重建路径只降子代理运行证据，goal 呈现门的事实原样保留（断连不自愈）。
  assert.deepEqual(
    mergeRuntimeFacts({ sessions: { s1: { goal, runningSubagents: 2 } } }, undefined, undefined, true)?.sessions.s1,
    { goal, runningSubagents: 2, subagentActivity: 'unknown' },
  )
})

// ---- membership / un-grouped bucket / hidden rows ----

test('deriveServerWorkspaces hides subagent and archived rows and trails one ungrouped bucket', () => {
  const result = deriveOf(
    [workspace('w1', 'Work', ['a'])],
    [session('x', 100), session('y', 200), session('a', 1), session('sub', 300, { origin: 'subagent' })],
  )
  assert.equal(result.length, 2)
  assert.equal(result[1].id, UNGROUPED_WORKSPACE_ID)
  assert.equal(result[1].ungrouped, true)
  assert.deepEqual(result[1].sessions.map(row => row.id), ['y', 'x'], 'recency then id tiebreak')
  const archived = deriveServerWorkspaces({
    ...snapshot([workspace('w1', 'Work', ['a', 'b'])], [session('a', 1), session('b', 2), session('stray', 3)]),
    archivedSessionIds: ['b', 'stray'],
  }, 'srv-a', '')
  assert.equal(archived.length, 1)
  assert.deepEqual(archived[0].sessions.map(row => row.id), ['a'], 'archived members and strays are hidden')
})

test('sanitizeSearchQuery strips NULs and clamps to 500 UTF-16 units without splitting a surrogate pair', () => {
  assert.equal(sanitizeSearchQuery('  a\0b\0  '), 'ab')
  assert.equal(sanitizeSearchQuery('a'.repeat(600)), 'a'.repeat(SEARCH_QUERY_MAX_CODE_UNITS))
  const sanitized = sanitizeSearchQuery('a'.repeat(499) + '\ud83d\ude00' + 'b')
  assert.equal(sanitized, 'a'.repeat(499))
  assert.equal(sanitized.includes('\ud83d'), false, 'the pair is never split at the clamp boundary')
})

test('reconciledSessionOrder/orderUngroupedSessions keep stored-known ids first and append the wire remainder', () => {
  assert.deepEqual(reconciledSessionOrder(['b', 'a'], ['a', 'b', 'c']), ['b', 'a', 'c'])
  assert.deepEqual(reconciledSessionOrder(['x', 'a'], ['a', 'b']), ['a', 'b'], 'stored ids unknown to the wire are skipped')
  assert.deepEqual(reconciledSessionOrder([], []), [])
  const wire = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(orderUngroupedSessions(wire, ['c', 'a']).map(x => x.id), ['c', 'a', 'b'])
  assert.deepEqual(orderUngroupedSessions(wire, ['ghost', 'b']).map(x => x.id), ['b', 'a', 'c'])
  const copy = orderUngroupedSessions(wire, undefined)
  assert.notEqual(copy, wire, 'no stored order returns a wire-order copy')
})

test('projectRuntimeFacts: live bits, pending kinds, subagent and sparse lineage discipline', () => {
  // The real client store row (post-`projectList`) carries NO `completed` field — the
  // official completion-unread fact is `sessionStatus.completionUnread`, which the
  // mounted store never mirrors. A fixture with `completed` would model a field that
  // cannot exist, so the completed bit here can only come from the App ledger.
  const report = projectRuntimeFacts({
    // rc.2: `current` is the official main view's retained row, not a list field.
    byId: { s1: { running: true, retainedBy: { mainView: 1 } }, sub1: { running: false, origin: 'subagent' }, s2: { running: false }, c: {} },
  }, new Map([['s1', 2], ['c', 0]]), new Map([
    ['s1', { kind: 'question' }], ['sub1', { kind: 'approval' }], ['c', { kind: 'unknown-future-kind' }],
  ]))
  assert.deepEqual(report, {
    current: 's1',
    sessions: {
      s1: { running: true, pending: 'question', runningSubagents: 2, subagentActivity: 'running' },
      s2: { running: false, subagentActivity: 'none' },
      c: { running: false, subagentActivity: 'none' },
    },
  }, 'subagent rows and unknown kinds never enter the report; zero counts stay sparse')
  assert.deepEqual(projectRuntimeFacts({}), { sessions: {} })
  // Only the row the OFFICIAL main view retains is current: a sidebar-only or
  // subagent-only retention must not become the source's current session.
  assert.equal(projectRuntimeFacts({ byId: { s1: { retainedBy: { sidebarView: 1 } } } }).current, undefined)
  assert.equal(projectRuntimeFacts({ byId: { s1: { retainedBy: { mainView: 0 } } } }).current, undefined)
})

test('run identity: the producer mints one chamber id per observed COMPLETION', () => {
  const fp = 'a'.repeat(64)
  const generation = 7_000
  const running1 = advanceRunIdentities({ previous: new Map(), running: new Set(['s1']), live: new Set(['s1']), sourceFingerprint: fp, generation })
  // The completion tick mints the notified identity: the host emits running BEFORE
  // the run's prompt activity, so a start-tick mint would anchor on the previous run.
  const completed1 = advanceRunIdentities({ previous: running1.identities, running: new Set(), live: new Set(['s1']), sourceFingerprint: fp, generation, episodes: running1.episodes, activity: new Map([['s1', 5_000]]) })
  const runOne = completed1.identities.get('s1')!.runId
  assert.match(runOne, /^chamber:/)
  assert.equal(completed1.identities.get('s1')?.running, false)
  // A replayed completion with the SAME host activity keeps the identity; that is
  // what lets the durable receipt suppress the duplicate banner.
  const replay = advanceRunIdentities({ previous: completed1.identities, running: new Set(), live: new Set(['s1']), sourceFingerprint: fp, generation, episodes: completed1.episodes, activity: new Map([['s1', 5_000]]) })
  assert.equal(replay.identities.get('s1')?.runId, runOne, 'the same completion is one identity')
  // A genuinely later run: its prompt advances the activity, even though the
  // running flag was observed first and carried the previous identity.
  const running2 = advanceRunIdentities({ previous: replay.identities, running: new Set(['s1']), live: new Set(['s1']), sourceFingerprint: fp, generation, episodes: replay.episodes, activity: new Map([['s1', 5_000]]) })
  assert.equal(running2.identities.get('s1')?.runId, runOne, 'a start tick carries the previous identity')
  const completed2 = advanceRunIdentities({ previous: running2.identities, running: new Set(), live: new Set(['s1']), sourceFingerprint: fp, generation, episodes: running2.episodes, activity: new Map([['s1', 9_000]]) })
  assert.notEqual(completed2.identities.get('s1')?.runId, runOne, 'a newer completion mints the next run')
  const pruned = advanceRunIdentities({ previous: completed2.identities, running: new Set(), live: new Set(), sourceFingerprint: fp, generation, episodes: completed2.episodes })
  assert.equal(pruned.identities.size, 0, 'ids that left the store are dropped (bounded growth)')
  // The high-water survives the drop: re-adding the session must not restart at
  // episode 1 with the same run id (two real runs would share one banner receipt).
  const readded = advanceRunIdentities({ previous: pruned.identities, running: new Set(['s1']), live: new Set(['s1']), sourceFingerprint: fp, generation, episodes: pruned.episodes })
  const readdedDone = advanceRunIdentities({ previous: readded.identities, running: new Set(), live: new Set(['s1']), sourceFingerprint: fp, generation, episodes: readded.episodes, activity: new Map([['s1', 12_000]]) })
  assert.notEqual(readdedDone.identities.get('s1')?.runId, runOne, 'a live drop must not reset the episode namespace')
})

test('run identity: a producer remount can never re-mint a previous lifetime id (regression)', () => {
  // The blocking review scenario: run 1 of s1 completes and is notified, the
  // sidebar ctx remounts, run 2 of the SAME session completes. Episode numbers
  // restart at 1 in the new lifetime, so the lifetime nonce is the only thing that
  // keeps the two ids apart; a shared generation makes the native receipt treat
  // run 2 as already shown (missed notification).
  const fp = 'b'.repeat(64)
  const lifetimeA = advanceRunIdentities({ previous: new Map(), running: new Set(['s1']), live: new Set(['s1']), sourceFingerprint: fp, generation: 11_000 })
  const doneA = advanceRunIdentities({ previous: lifetimeA.identities, running: new Set(), live: new Set(['s1']), sourceFingerprint: fp, generation: 11_000, episodes: lifetimeA.episodes, activity: new Map([['s1', 1_000]]) })
  const runOne = doneA.identities.get('s1')!.runId
  const lifetimeB = advanceRunIdentities({ previous: new Map(), running: new Set(['s1']), live: new Set(['s1']), sourceFingerprint: fp, generation: 12_000 })
  const doneB = advanceRunIdentities({ previous: lifetimeB.identities, running: new Set(), live: new Set(['s1']), sourceFingerprint: fp, generation: 12_000, episodes: lifetimeB.episodes, activity: new Map([['s1', 1_500]]) })
  const runTwo = doneB.identities.get('s1')!.runId
  assert.notEqual(runTwo, runOne, 'two real runs must never share a run id')
  assert.notEqual(runTwo, chamberRunId({ sourceFingerprint: fp, generation: 11_000, sessionId: 's1', episode: 1 }))
})

test('run identity: projectRuntimeFacts carries the producer id sparsely', () => {
  const report = projectRuntimeFacts(
    { byId: { s1: { running: false }, s2: { running: false } } },
    undefined,
    undefined,
    new Map([['s1', 'chamber:fp:0:s1:1']]),
  )
  assert.equal(report.sessions.s1?.runId, 'chamber:fp:0:s1:1')
  assert.equal(report.sessions.s2?.runId, undefined)
})

test('P5: subagent activity is tri-state, and a stale report downgrades running to unknown', () => {
  const snapshot = {
    byId: {
      s1: { running: false },
      sub1: { running: true, origin: 'subagent' as const, parentId: 's1' },
    },
  }
  // The lineage index is absent: honest answer is unknown, never "none".
  assert.deepEqual(projectRuntimeFacts(snapshot).sessions.s1, { running: false, subagentActivity: 'unknown' })
  const withIndex = projectRuntimeFacts(snapshot, new Map([['s1', 1]]))
  assert.deepEqual(withIndex.sessions.s1, { running: false, runningSubagents: 1, subagentActivity: 'running' })
  // A disconnected source's leftover count is not evidence of live work: the merge
  // downgrades the claim (neutral), while the count itself stays for diagnosis.
  const merged = mergeRuntimeFacts(withIndex, undefined, undefined, true)
  assert.deepEqual(merged?.sessions.s1, { running: false, runningSubagents: 1, subagentActivity: 'unknown' })
  assert.equal(merged?.stale, true)
})

// ---- labels / schedule / blank reuse ----

test('sessionDisplayTitle follows title → cwd basename → id; basenameOf keeps the trailing-segment contract', () => {
  assert.equal(sessionDisplayTitle({ title: 'Real', sessionId: 'sid' }), 'Real')
  assert.equal(sessionDisplayTitle({ title: '', cwdBasename: 'dsh-chamber', sessionId: 'sid' }), 'dsh-chamber')
  assert.equal(sessionDisplayTitle({ displayTitle: 'Resolved', title: 'Durable', sessionId: 'sid' }), 'Resolved')
  assert.equal(sessionDisplayTitle({ cwdBasename: '/', sessionId: 'sid' }), 'sid', 'separator-only basenames fall through')
  assert.equal(basenameOf('/Users/x/project/'), 'project')
  assert.equal(basenameOf('C:\\Users\\x\\project'), 'project')
  assert.equal(basenameOf('/'), '/')
})

test('hasActiveScheduleOf is true only for a non-empty schedule array', () => {
  assert.equal(hasActiveScheduleOf(undefined), false)
  assert.equal(hasActiveScheduleOf({}), false)
  assert.equal(hasActiveScheduleOf({ schedule: [] }), false)
  assert.equal(hasActiveScheduleOf({ schedule: [{ id: 'sch1' }] }), true)
  assert.equal(hasActiveScheduleOf({ schedule: 'sch1' }), false)
  assert.equal(hasActiveScheduleOf({ schedule: null }), false)
})

test('findReusableBlankSession mirrors connectWorkspace and reuse stays off without an authoritative archive set', () => {
  const ws = { path: '/w1', sessionIds: ['blank', 'other'] }
  const blank = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ sessionId: id, running: false, blank: true, cwd: '/w1', ...extra })
  assert.equal(findReusableBlankSession(ws, [blank('blank')], new Set()), 'blank')
  assert.equal(findReusableBlankSession(ws, [{ ...blank('blank'), blank: false }], new Set()), undefined)
  assert.equal(findReusableBlankSession(ws, [blank('blank', { cwd: '/elsewhere' })], new Set()), undefined)
  assert.equal(findReusableBlankSession(ws, [blank('blank')], new Set(['blank'])), undefined)
  assert.equal(findReusableBlankSession(ws, [blank('blank', { parentSessionId: 'p' })], new Set()), undefined)
  const withKnown = deriveServerWorkspaces({
    ...snapshot([workspace('w1', 'Work', ['blank'])], [session('blank', 5, { blank: true, cwd: '/w1' })]), archiveSetKnown: true,
  }, 'srv-a', '', undefined, 1_000)
  assert.equal(withKnown[0]?.reusableBlankSessionId, 'blank')
  assert.deepEqual(withKnown[0]?.sessions, [], 'the reusable row stays hidden while it is not current')
  const unknown = deriveOf([workspace('w1', 'Work', ['blank'])], [session('blank', 5, { blank: true, cwd: '/w1' })])
  assert.equal('reusableBlankSessionId' in (unknown[0] ?? {}), false, 'an unknown archive set could make an archived row look reusable')
})

// ---- ordering: sources, updated mode, local search ----

test('orderServersForDisplay leads with stored-known ids and nextServerOrder keeps the drop math exact', () => {
  const servers = [server('local'), server('ssh-r1'), server('ssh-r2')]
  assert.equal(orderServersForDisplay(servers, undefined), servers)
  assert.deepEqual(orderServersForDisplay(servers, ['ssh-r2', 'local', 'ssh-r2', 'ssh-r1']).map(s => s.id), ['ssh-r2', 'local', 'ssh-r1'])
  assert.deepEqual(orderServersForDisplay(servers, ['ghost-a', 'ssh-r2', 'ghost-b']).map(s => s.id), ['ssh-r2', 'local', 'ssh-r1'], 'no ghost groups')
  assert.equal(nextServerOrder(['a', 'b', 'c'], 'a', { id: 'ghost', half: 'before' }), null)
  assert.equal(nextServerOrder(['a', 'b', 'c'], 'b', { id: 'b', half: 'before' }), null, 'a no-op drop is null')
  assert.deepEqual(nextServerOrder(['a', 'b', 'c', 'd'], 'd', { id: 'b', half: 'before' }), ['a', 'd', 'b', 'c'])
  assert.deepEqual(nextServerOrder(['a', 'b', 'c', 'd'], 'a', { id: 'b', half: 'after' }), ['b', 'a', 'c', 'd'])
  const rendered = ['a', 'b', 'c', 'd']
  const moved = nextServerOrder(rendered, 'd', { id: 'b', half: 'after' })
  assert.ok(moved)
  assert.deepEqual([...moved].sort(), [...rendered].sort(), 'membership is preserved')
  assert.deepEqual(rendered, ['a', 'b', 'c', 'd'], 'the rendered input is never mutated')
})

test('nextUpdatedOrder promotes fresh activity and preserves the stored order otherwise', () => {
  const byId = new Map([['a', { id: 'a', updatedAt: 100 }], ['b', { id: 'b', updatedAt: 300 }], ['c', { id: 'c', updatedAt: 200 }]])
  const first = nextUpdatedOrder({ sessionIds: ['a', 'b', 'c'], stored: undefined, previousUpdatedAt: undefined, byId })
  assert.deepEqual(first.order, ['b', 'c', 'a'])
  assert.equal(first.changed, true)
  const steady = nextUpdatedOrder({ sessionIds: ['a', 'b', 'c'], stored: ['c', 'a', 'b'], previousUpdatedAt: { a: 100, b: 300, c: 200 }, byId })
  assert.deepEqual(steady.order, ['c', 'a', 'b'], 'no activity since the last observation -> the stored order stands')
  assert.equal(steady.changed, false)
  const promotedById = new Map([['a', { id: 'a', updatedAt: 100 }], ['b', { id: 'b', updatedAt: 350 }], ['c', { id: 'c', updatedAt: 200 }]])
  const promoted = nextUpdatedOrder({ sessionIds: ['a', 'b', 'c'], stored: ['c', 'a', 'b'], previousUpdatedAt: { a: 100, b: 300, c: 200 }, byId: promotedById })
  assert.deepEqual(promoted.order, ['b', 'c', 'a'])
  assert.equal(promoted.changed, true)
})

test('deriveLocalSearchMatches matches the display label and excludes hidden rows', () => {
  const rows = snapshot(
    [workspace('w1', 'Alpha Project', ['a'])],
    [session('a', 10, { cwd: '/Users/me/dsh-chamber', displayTitle: 'dsh-chamber' }), session('b', 20, { title: 'other', origin: 'subagent' })],
  )
  assert.deepEqual(deriveLocalSearchMatches(rows, 'dsh-chamber'), [{ sessionId: 'a', snippet: '' }])
  assert.deepEqual(deriveLocalSearchMatches(rows, '   '), [])
  assert.deepEqual(deriveLocalSearchMatches(rows, 'zzz'), [])
})

// ---- search merge / archive projection / archive-set signatures ----

test('mergeSearchResults: local lead, remote-snippet adoption, dedupe, limit and visible-set filtering', () => {
  const local: SearchRow[] = [{ sessionId: 'l1', snippet: '' }, { sessionId: 'both', snippet: '' }]
  const remote = { items: [{ sessionId: 'both', snippet: 'content' }, { sessionId: 'r1', snippet: 'remote' }, { sessionId: 'r1', snippet: 'dup' }], hasMore: true }
  const merged = mergeSearchResults(local, remote, 20, new Set(['l1', 'both', 'r1']), true)
  assert.deepEqual(merged.items, [
    { sessionId: 'l1', snippet: '' }, { sessionId: 'both', snippet: 'content' }, { sessionId: 'r1', snippet: 'remote' },
  ])
  assert.equal(merged.hasMore, true)
  assert.deepEqual(mergeSearchResults(local, { items: [{ sessionId: 'r1', snippet: '' }], hasMore: false }, 2, new Set(['l1', 'both', 'r1']), true).items.map(row => row.sessionId), ['l1', 'both'])
  const hidden = { items: [{ sessionId: 'visible-hit', snippet: 'kept' }, { sessionId: 'archived-hit', snippet: 'dropped' }], hasMore: false }
  assert.deepEqual(mergeSearchResults([], hidden, 20, new Set(['visible-hit']), true).items, [{ sessionId: 'visible-hit', snippet: 'kept' }])
  assert.deepEqual(mergeSearchResults([], { items: [{ sessionId: 'x', snippet: 'hidden' }], hasMore: false }, 20, new Set(), true).items, [],
    'M7: a READY empty visible set must not let hidden sessions flow back in')
  assert.deepEqual(mergeSearchResults([], { items: [{ sessionId: 'x', snippet: 'kept' }], hasMore: false }, 20, new Set(), false).items,
    [{ sessionId: 'x', snippet: 'kept' }], 'a NOT-ready projection degrades to no filtering')
})

test('deriveArchivedSessions/groupArchivedRows: newest-first, membership then canonical cwd, ungrouped last', () => {
  const snap: InstanceSnapshot = {
    workspaces: [workspace('w1', 'Alpha', []), workspace('w2', 'Beta', ['a2'])],
    archivedSessionIds: ['a1', 'a2', 'orphan'],
    sessions: [
      session('a1', 100, { cwd: '/w1' }), session('a2', 300, { cwd: '/elsewhere' }),
      session('orphan', 200, { cwd: '/gone' }), session('v1', 999, { title: 'visible' }),
    ],
  }
  const rows = deriveArchivedSessions(snap)
  assert.deepEqual(rows.map(row => row.sessionId), ['a2', 'orphan', 'a1'])
  const byId = new Map(rows.map(row => [row.sessionId, row]))
  assert.deepEqual(byId.get('a1')?.workspace, { id: 'w1', title: 'Alpha' }, 'membership never landed -> canonical cwd fallback')
  assert.deepEqual(byId.get('a2')?.workspace, { id: 'w2', title: 'Beta' }, 'membership wins over a non-matching cwd')
  assert.equal(byId.get('orphan')?.workspace, undefined)
  assert.equal(byId.has('v1'), false)
  assert.deepEqual(deriveArchivedSessions({ workspaces: [], archivedSessionIds: [], sessions: [session('x', 1)] }), [])
  const groups = groupArchivedRows([
    { sessionId: 'o1', updatedAt: 999 },
    { sessionId: 'a1', updatedAt: 300, workspace: { id: 'w1', title: 'Alpha' } },
  ])
  assert.deepEqual(groups.map(group => group.key), ['w1', UNGROUPED_WORKSPACE_ID])
  assert.deepEqual(groupArchivedRows([]), [])
})

test('archiveSetKnown and archivedSessions participate in the publish signatures', () => {
  const base = snapshot([], [])
  assert.notEqual(instanceSnapshotSignature({ ...base, archiveSetKnown: true }), instanceSnapshotSignature({ ...base, archiveSetKnown: false }))
  const plain = { id: 'local', sourceFingerprint: 'fp', kind: 'local' as const, transport: 'local' as const, label: 'local', connected: true, phase: 'ready', workspaces: [], updatedAt: 1 }
  assert.notEqual(serversProjectionSignature([plain] as never),
    serversProjectionSignature([{ ...plain, archivedSessions: [{ sessionId: 's1', updatedAt: 5 }] }] as never))
  assert.notEqual(serversProjectionSignature([{ ...plain, archivedSessions: [], archiveSetKnown: false }] as never),
    serversProjectionSignature([{ ...plain, archivedSessions: [], archiveSetKnown: true }] as never))
})

// ---- completed-dot state machine + report signatures (the separator-forgery
//      negative is retained verbatim because a signature collision silently
//      skips a real republish) ----

function reconcile(
  prevCompleted: Record<string, boolean>,
  prevRunning: Record<string, boolean>,
  sessions: Record<string, { running?: boolean }>,
  readingCurrent: string | undefined,
) {
  const nextRunning: Record<string, boolean> = {}
  for (const [id, row] of Object.entries(sessions)) nextRunning[id] = row?.running === true
  return reconcileCompletedFacts({ sessions, nextRunning, prevRunning, prevCompleted, readingCurrent })
}

test('reconcileCompletedFacts: a background edge arms, the read session never arms, a re-run disarms', () => {
  const armed = reconcile({}, { x: true }, { x: { running: false } }, undefined)
  assert.deepEqual(armed.completed, { x: true })
  assert.equal(armed.changed, true)
  assert.deepEqual(reconcile({}, { x: true }, { x: { running: false } }, 'x').completed, {}, 'the active view never arms')
  assert.deepEqual(reconcile({}, { x: true, y: true }, { x: { running: false }, y: { running: false } }, 'x').completed, { y: true })
  assert.deepEqual(reconcile({}, {}, { x: { running: false } }, undefined).completed, {}, 'first observation records no edge')
  const prev = { x: true }
  assert.equal(reconcile(prev, { x: false }, { x: { running: false } }, undefined).completed, prev, 'no re-edge, identity kept')
  assert.equal(reconcile(prev, { x: false }, { x: { running: false } }, undefined).changed, false, 'an unchanged arm must not churn the state')
  assert.deepEqual(reconcile({ x: true }, { x: false }, { x: { running: true } }, undefined).completed, {}, 'a re-run disarms')
  assert.deepEqual(reconcile({ x: true }, { x: false }, { x: { running: false } }, 'x').completed, {}, 'starting to read disarms')
  assert.deepEqual(reconcile({ x: true, y: true }, { x: false, y: false }, { x: { running: true }, y: { running: false } }, undefined).completed, { y: true })
})

test('runtimeReportSignature: the L1 receipt, onlyIds and listComplete identity discipline', () => {
  const receipt: InstanceRuntimeReport = { sessions: { p: { running: true } }, sessionAuthority: { requestedAt: 1_000, settledAt: 2_000, ok: true, progressStamp: 1, probes: 0, corrections: 0, recent: [] } }
  assert.notEqual(runtimeReportSignature({ sessions: { p: { running: true } } }), runtimeReportSignature(receipt),
    'a receipt-only settlement must re-sign, or the liveness guard never sees the verdict')
  assert.equal(runtimeReportSignature(receipt), runtimeReportSignature({ ...receipt, sessionAuthority: { requestedAt: 1_000, settledAt: 2_000, ok: true, progressStamp: 1, probes: 0, corrections: 0, recent: [] } }))
  const hidden = { current: 's1', sessions: { s1: { running: true }, s2: { completed: true } } }
  assert.equal(runtimeReportSignature(hidden, new Set(['s1'])),
    runtimeReportSignature({ ...hidden, sessions: { s1: { running: true }, s2: { completed: true, running: true } } }, new Set(['s1'])),
    'a hidden session flipping its facts must not re-render the projection')
  assert.notEqual(runtimeReportSignature({ sessions: {} }), runtimeReportSignature({ sessions: {}, listComplete: true }))
  assert.equal(runtimeReportSignature({ sessions: {}, listComplete: true }, undefined, false),
    runtimeReportSignature({ sessions: {}, listComplete: false }, undefined, false),
    'the projection path ignores listComplete (nothing rendered reads it)')
})

test('runningRingVisible is poll-only: the channel running bit never renders the ring', () => {
  assert.equal(runningRingVisible(false, true), true)
  assert.equal(runningRingVisible(true, true), true)
  assert.equal(runningRingVisible(undefined, true), true, 'the poll bit alone renders the ring')
  assert.equal(runningRingVisible(true, false), false, 'a stale channel bit must not fake a running ring')
  assert.equal(runningRingVisible(true, undefined), false)
  assert.equal(runningRingVisible(undefined, undefined), false)
})

test('serversProjectionSignature JSON-encodes titles: user-controlled separators cannot forge equality', () => {
  const twoRows = [server('local', { workspaces: [{ id: 'w1', title: 'Work', sessions: [
    { id: 's1', title: 'a', displayTitle: 'a', running: false },
    { id: 's2', title: 'b', displayTitle: 'b', running: false },
  ] }] })]
  const forged = [server('local', { workspaces: [{ id: 'w1', title: 'Work', sessions: [
    { id: 's1', title: 'a,0:0,0,s2:b', displayTitle: 'a,0:0,0,s2:b', running: false },
  ] }] })]
  assert.notEqual(serversProjectionSignature(twoRows), serversProjectionSignature(forged))
  assert.equal(serversProjectionSignature(twoRows), serversProjectionSignature([server('local', { workspaces: [{ id: 'w1', title: 'Work', sessions: [
    { id: 's1', title: 'a', displayTitle: 'a', running: false },
    { id: 's2', title: 'b', displayTitle: 'b', running: false },
  ] }] })]))
})

test('producer projects listComplete from the official list store phase (source wiring lock)', () => {
  const producer = stripComments(readFileSync(fileURLToPath(new URL('../../src/client/index.ts', import.meta.url)), 'utf8'))
  assert.match(producer, /baseReport\.listComplete = snapshot\.phase === 'ready'/)
  assert.match(producer, /const snapshot = sessionsList\.getSnapshot\(\)/)
})

test('round-3 restore: the schedule fact reaches the snapshot, the signature and the rows', () => {
  const projected = projectInstanceSnapshot(
    { items: [workspace('w1', 'Work', ['scheduled', 'plain'])], archivedSessionIds: [], state: 'idle', phase: 'ready' },
    {
      ids: ['scheduled', 'plain'],
      phase: 'ready',
      byId: {
        scheduled: { id: 'scheduled', title: 'With schedule', running: false, blank: false, projectionValues: { schedule: [{ id: 'sch1' }] } },
        plain: { id: 'plain', title: 'No schedule', running: false, blank: false, projectionValues: { schedule: [] } },
      },
    },
  )
  assert.deepEqual(projected?.sessions.map(row => row.hasActiveSchedule), [true, undefined], 'sparse: present only when active')
  const idle = snapshot([workspace('w1', 'Work', ['s1'])], [session('s1', 5, { title: 'One' })])
  const armed = snapshot([workspace('w1', 'Work', ['s1'])], [{ ...session('s1', 5, { title: 'One' }), hasActiveSchedule: true }])
  assert.notEqual(instanceSnapshotSignature(idle), instanceSnapshotSignature(armed), 'a schedule change must republish')
  const derived = deriveOf(
    [workspace('w1', 'Work', ['in-ws'])],
    [{ ...session('in-ws', 5, { title: 'In workspace' }), hasActiveSchedule: true }, { ...session('stray', 6, { title: 'Stray' }), hasActiveSchedule: true }],
  )
  assert.equal(derived[0]?.sessions[0]?.hasActiveSchedule, true, 'workspace rows carry the fact')
  assert.equal(derived[1]?.sessions[0]?.hasActiveSchedule, true, 'the ungrouped stray carries the fact too')
  const plainRow = deriveOf([workspace('w1', 'Work', ['plain'])], [session('plain', 5, { title: 'Plain' })])
  assert.equal('hasActiveSchedule' in (plainRow[0]?.sessions[0] ?? {}), false, 'an ordinary row stays key-free')
})

test('round-3 restore: label fallbacks, vendor displayTitle and label/reuse signature moves', () => {
  const untitled = deriveOf([workspace('w1', 'Work', ['untitled'])], [session('untitled', 5, { cwd: '/Users/x/dsh-chamber' })])
  assert.equal(untitled[0]?.sessions[0]?.title, '', 'the durable title stays empty')
  assert.equal(untitled[0]?.sessions[0]?.displayTitle, 'dsh-chamber', 'the official label is the directory name')
  const nowhere = deriveOf([workspace('w1', 'Work', ['nowhere'])], [session('nowhere', 5)])
  assert.equal(nowhere[0]?.sessions[0]?.displayTitle, 'nowhere', 'the id is the last resort')
  const stray = deriveOf([], [session('stray', 5, { cwd: '/Users/x/project' })])
  assert.equal(stray[0]?.sessions[0]?.displayTitle, 'project', 'the ungrouped bucket applies the same label')
  const mounted = projectInstanceSnapshot(
    { items: [workspace('w1', 'Work', ['s1'])], archivedSessionIds: [], state: 'idle', phase: 'ready' },
    { ids: ['s1'], phase: 'ready', byId: { s1: { id: 's1', title: 'One', cwd: '/w1', running: false, blank: false, displayTitle: 'Vendor label' } } },
  )
  assert.equal(mounted?.sessions[0]?.displayTitle, 'Vendor label', 'the mounted projection carries the vendor label verbatim')
  assert.equal(sessionDisplayTitle({ sessionId: 'sid' }), 'sid')
  assert.equal(sessionDisplayTitle({ displayTitle: '', title: 'Durable', sessionId: 'sid' }), 'Durable', 'an empty producer label falls through')
  assert.equal(sessionDisplayTitle({ displayTitle: null as never, title: null as never, sessionId: 'sid' }), 'sid', 'a JSON null is not a label')
  assert.equal(sessionDisplayTitle({ cwdBasename: '///', sessionId: 'sid' }), 'sid')
  const before = snapshot([workspace('w1', 'Work', ['s1'])], [{ ...session('s1', 5), displayTitle: 'a' }])
  const after = snapshot([workspace('w1', 'Work', ['s1'])], [{ ...session('s1', 5), displayTitle: 'b' }])
  assert.notEqual(instanceSnapshotSignature(before), instanceSnapshotSignature(after), 'a displayTitle-only change republishes')
  const base = server('local')
  const relabeled = server('local', { workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', displayTitle: 'dsh-chamber', running: false, updatedAt: 1 }] }] })
  assert.notEqual(serversProjectionSignature([base]), serversProjectionSignature([relabeled]), 'a healed label must republish')
  const reusable = server('local', { workspaces: [{ id: 'w1', title: 'Work', reusableBlankSessionId: 'blank-1', sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, updatedAt: 1 }] }] })
  assert.notEqual(serversProjectionSignature([base]), serversProjectionSignature([reusable]), 'a reuse-only change must republish')
  const explicitNull = server('local', { workspaces: [{ id: 'w1', title: 'Work', reusableBlankSessionId: undefined, sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, updatedAt: 1 }] }] })
  assert.equal(serversProjectionSignature([base]), serversProjectionSignature([explicitNull]), 'absent and explicit-null are the same reuse fact')
})

test('round-3 restore: workspace membership order, accounting slots and passthrough', () => {
  const byOrder = deriveOf(
    [workspace('w1', 'Alpha', ['s3', 's1', 's2'])],
    [session('s1', 10, { title: 'One' }), session('s2', 20, { title: 'Two' }), session('s3', 30, { title: 'Three' })],
  )
  assert.deepEqual(byOrder[0]?.sessions.map(row => [row.id, row.title, row.displayTitle]),
    [['s3', 'Three', 'Three'], ['s1', 'One', 'One'], ['s2', 'Two', 'Two']], 'membership maps in sessionIds order')
  assert.deepEqual(deriveOf([], []), [], 'empty snapshot -> empty list')
  const noStray = deriveOf([workspace('w1', 'Work', ['a', 'b'])], [session('a', 1), session('b', 2)])
  assert.equal(noStray.length, 1, 'no strays means no ungrouped bucket')
  const missing = deriveOf([workspace('w1', 'Work', ['missing', 'a'])], [session('a', 1, { title: 'A' })])
  assert.deepEqual(missing[0]?.sessions.map(row => row.id), ['a'], 'missing members are skipped without breaking order')
  const titled = deriveServerWorkspaces(snapshot([workspace('w1', 'Work', ['a'])], [session('x', 100), session('a', 1)]), 'srv-a', 'Ungrouped')
  assert.equal(titled[1]?.title, 'Ungrouped', 'the caller-provided bucket title is carried')
  const archivedSlot = deriveServerWorkspaces({
    ...snapshot([workspace('w1', 'Work', ['a', 'archived'])], [session('a', 1), session('archived', 2), session('x', 3)]),
    archivedSessionIds: ['archived'],
  }, 'srv-a', '')
  assert.deepEqual(archivedSlot[0]?.sessions.map(row => row.id), ['a'])
  assert.deepEqual(archivedSlot[1]?.sessions.map(row => row.id), ['x'], 'an archived member keeps its accounting slot')
  const passing = deriveOf([workspace('w1', 'Work', ['a', 'b'])], [session('a', 42, { title: 'A', running: true }), session('b', 7), session('s', 99, { running: true })])
  assert.equal(passing[0]?.sessions[0]?.running, true)
  assert.equal(passing[0]?.sessions[0]?.updatedAt, 42)
  assert.equal(passing[1]?.sessions[0]?.running, true, 'running/updatedAt pass through to strays')
})

test('round-3 restore: relativeTimeBucket boundaries and the search clamp', () => {
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
  assert.deepEqual(relativeTimeBucket(now - 30 * DAY, now), { unit: 'months', n: 1 })
  assert.deepEqual(relativeTimeBucket(now - 365 * DAY, now), { unit: 'years', n: 1 })
  assert.deepEqual(relativeTimeBucket(now + 5000, now), { unit: 'now', n: 0 }, 'future stamps clamp to now')
  assert.equal(SEARCH_QUERY_MAX_CODE_UNITS, 500, 'the wire schema clamp')
  const atBoundary = 'b'.repeat(SEARCH_QUERY_MAX_CODE_UNITS)
  assert.equal(sanitizeSearchQuery(atBoundary), atBoundary)
  assert.equal(sanitizeSearchQuery(atBoundary + 'b'), atBoundary)
  const pair = 'b'.repeat(SEARCH_QUERY_MAX_CODE_UNITS - 1) + '\ud83d\ude00' + 'c'
  assert.equal(sanitizeSearchQuery(pair), 'b'.repeat(SEARCH_QUERY_MAX_CODE_UNITS - 1))
  assert.equal(sanitizeSearchQuery(pair).includes('\ud83d'), false)
})

test('round-3 restore: findReusableBlankSession skip rules and derive-side exclusions', () => {
  const ws = { path: '/w1', sessionIds: ['blank', 'other'] }
  const blank = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ sessionId: id, running: false, blank: true, cwd: '/w1', ...extra })
  assert.equal(findReusableBlankSession({ path: '/w1', sessionIds: [] }, [blank('blank')], new Set()), undefined, 'a non-member row is skipped')
  assert.equal(findReusableBlankSession(ws, [blank('blank', { origin: 'subagent' })], new Set()), undefined, 'a subagent blank is skipped')
  assert.equal(findReusableBlankSession(ws, [blank('blank'), blank('other', { cwd: '/w1' })], new Set()), 'blank', 'wire order decides')
  const archived = deriveServerWorkspaces({
    ...snapshot([workspace('w1', 'Work', ['blank'])], [session('blank', 5, { blank: true, cwd: '/w1' })]),
    archivedSessionIds: ['blank'], archiveSetKnown: true,
  }, 'srv-a', '', undefined, 1_000)
  assert.equal(archived[0]?.reusableBlankSessionId, undefined, 'an archived blank is never reusable')
  const synthetic = deriveServerWorkspaces({
    ...snapshot([{ ...workspace('__cwd__:/w1', 'w1', ['blank']), synthetic: true }], [session('blank', 5, { blank: true, cwd: '/w1' })]),
    archiveSetKnown: true,
  }, 'srv-a', '', undefined, 1_000)
  assert.equal('reusableBlankSessionId' in (synthetic[0] ?? {}), false, 'synthetic cwd groups offer no reuse')
})

test('round-3 restore: orderServersForDisplay/nextServerOrder remaining drop-math edges', () => {
  const servers = [server('local'), server('ssh-r1'), server('ssh-r2')]
  assert.deepEqual(orderServersForDisplay(servers, ['ssh-r2', 'local']).map(s => s.id), ['ssh-r2', 'local', 'ssh-r1'], 'unlisted ids keep projection position')
  assert.deepEqual(orderServersForDisplay(servers, ['ssh-r1']).map(s => s.id), ['ssh-r1', 'local', 'ssh-r2'])
  const rendered = ['a', 'b', 'c']
  assert.equal(nextServerOrder(rendered, 'ghost', { id: 'b', half: 'before' }), null)
  assert.equal(nextServerOrder(rendered, 'ghost', { id: 'b', half: 'after' }), null)
  assert.equal(nextServerOrder(rendered, 'b', { id: 'b', half: 'after' }), null)
  assert.equal(nextServerOrder(rendered, 'b', { id: 'a', half: 'after' }), null, 'already directly after the target')
  assert.equal(nextServerOrder(rendered, 'a', { id: 'b', half: 'before' }), null, 'already directly before the target')
  assert.equal(nextServerOrder(rendered, 'c', { id: 'b', half: 'after' }), null)
  assert.equal(nextServerOrder(rendered, 'c', { id: 'c', half: 'after' }), null)
  assert.deepEqual(nextServerOrder(['a', 'b', 'c'], 'a', { id: 'c', half: 'before' }), ['b', 'a', 'c'])
  assert.deepEqual(nextServerOrder(['a', 'b', 'c'], 'c', { id: 'a', half: 'after' }), ['a', 'c', 'b'])
  assert.deepEqual(nextServerOrder(['a', 'b', 'c'], 'a', { id: 'c', half: 'after' }), ['b', 'c', 'a'])
  const input = ['a', 'b', 'c', 'd']
  const moved = nextServerOrder(input, 'd', { id: 'b', half: 'after' })
  assert.notEqual(moved, input, 'a real move mints a new array')
})

test('round-3 restore: nextUpdatedOrder membership changes, missing timestamps and re-entry', () => {
  const byIdOf = (rows: { id: string; updatedAt?: number }[]) => new Map(rows.map(row => [row.id, row]))
  const step = (
    sessionIds: string[],
    stored: string[] | undefined,
    previousUpdatedAt: Record<string, number> | undefined,
    rows: { id: string; updatedAt?: number }[],
  ) => nextUpdatedOrder({ sessionIds, stored, previousUpdatedAt, byId: byIdOf(rows) })
  const newMember = step(['a', 'd', 'b'], ['a', 'b'], { a: 100, b: 300 }, [{ id: 'a', updatedAt: 100 }, { id: 'd', updatedAt: 900 }, { id: 'b', updatedAt: 300 }])
  assert.deepEqual(newMember.order, ['d', 'a', 'b'], 'an unobserved member is promoted')
  const dropped = step(['a', 'c'], ['b', 'a', 'c'], { a: 100, b: 300, c: 200 }, [{ id: 'a', updatedAt: 100 }, { id: 'c', updatedAt: 200 }])
  assert.deepEqual(dropped.order, ['a', 'c'])
  assert.equal(dropped.changed, true, 'leaving the wire membership must persist')
  const tie = step(['z', 'a', 'm'], undefined, undefined, [{ id: 'z', updatedAt: 100 }, { id: 'a', updatedAt: 100 }, { id: 'm', updatedAt: 100 }])
  assert.deepEqual(tie.order, ['a', 'm', 'z'], 'recency then id tiebreak')
  const missing = [{ id: 'known', updatedAt: 5 }, { id: 'unknown1' }, { id: 'unknown2' }]
  const first = step(['known', 'unknown1', 'unknown2'], undefined, undefined, missing)
  assert.deepEqual(first.order, ['known', 'unknown1', 'unknown2'])
  const second = step(['known', 'unknown1', 'unknown2'], first.order, first.updatedAt, missing)
  assert.deepEqual(second.order, ['unknown1', 'unknown2', 'known'], 'a missing updatedAt reads as never-observed and re-promotes')
  const third = step(['known', 'unknown1', 'unknown2'], second.order, second.updatedAt, missing)
  assert.deepEqual(third.order, ['unknown1', 'unknown2', 'known'])
  assert.equal(third.changed, false, 'the re-promotion settles')
  const reentry = step(['a', 'b', 'c'], ['c', 'a', 'b'], undefined, [{ id: 'c', updatedAt: 300 }, { id: 'a', updatedAt: 100 }, { id: 'b', updatedAt: 200 }])
  assert.deepEqual(reentry.order, ['c', 'b', 'a'], 'switched-to-updated keeps the stored account and recency-sorts once')
  assert.deepEqual(reentry.updatedAt, { a: 100, b: 200, c: 300 })
  const decreased = step(['a', 'b'], ['a', 'b'], { a: 100, b: 200 }, [{ id: 'a', updatedAt: 100 }, { id: 'b', updatedAt: 150 }])
  assert.deepEqual(decreased.order, ['a', 'b'])
  assert.deepEqual(decreased.updatedAt, { a: 100, b: 150 })
  assert.equal(decreased.changed, true, 'a timestamp decrease refreshes the baseline')
})

test('round-3 restore: deriveLocalSearchMatches title/workspace legs, hidden rows and recency', () => {
  const search = (query: string, ws: Parameters<typeof snapshot>[0], rows: Parameters<typeof snapshot>[1]) =>
    deriveLocalSearchMatches(snapshot(ws, rows), query)
  assert.deepEqual(search('deepseek', [workspace('w1', 'Work', ['a', 'b'])], [session('a', 10, { title: 'DeepSeek R1' }), session('b', 20, { title: 'other' })]),
    [{ sessionId: 'a', snippet: '' }], 'session titles match case-insensitively')
  assert.deepEqual(search('alpha', [workspace('w1', 'Alpha Project', ['a']), workspace('w2', 'Other', ['b'])], [session('a', 10), session('b', 20, { title: 'Other' })]),
    [{ sessionId: 'a', snippet: '' }], 'a workspace-title hit needs no session title')
  assert.deepEqual(search('docs', [workspace('w1', 'Work', ['a']), workspace('w2', 'Docs', ['b'])], [session('a', 10, { title: 'Notes' }), session('b', 20, { title: 'no-match' })]),
    [{ sessionId: 'b', snippet: '' }], 'either leg matches independently')
  const hidden = deriveLocalSearchMatches({
    workspaces: [workspace('w1', 'Match', ['hit', 'blank-hit', 'archived-hit', 'sub-hit'])],
    sessions: [
      session('hit', 10, { title: 'match me' }), session('blank-hit', 20, { title: 'match me', blank: true }),
      session('archived-hit', 30, { title: 'match me' }), session('sub-hit', 40, { title: 'match me', origin: 'subagent' }),
    ],
    archivedSessionIds: ['archived-hit'],
  }, 'match')
  assert.deepEqual(hidden, [{ sessionId: 'hit', snippet: '' }], 'blank/archived/subagent rows are excluded')
  const recency = search('hit', [workspace('w1', 'Work', ['a', 'b', 'c'])], [session('a', 100, { title: 'hit' }), session('b', 300, { title: 'hit' }), session('c', 300, { title: 'hit' })])
  assert.deepEqual(recency.map(row => row.sessionId), ['b', 'c', 'a'], 'hits order by recency with the id tiebreak')
})

test('round-3 restore: archive metadata, overflow hasMore and the schedule-only signature flip', () => {
  const overflow = mergeSearchResults(
    [{ sessionId: 'l1', snippet: '' }, { sessionId: 'l2', snippet: '' }],
    { items: [{ sessionId: 'r1', snippet: '' }], hasMore: false }, 2, new Set(['l1', 'l2', 'r1']), true)
  assert.deepEqual(overflow.items.map(row => row.sessionId), ['l1', 'l2'])
  assert.equal(overflow.hasMore, true, 'a merged result over the limit sets hasMore')
  const meta = deriveArchivedSessions({
    workspaces: [], archivedSessionIds: ['a1', 'a2'],
    sessions: [session('v1', 300, { title: 'visible' }), session('a1', 500, { title: 'old archived', cwd: '/work/a' }), session('a2', 900, { title: 'recent archived' })],
  })
  assert.deepEqual(meta.map(row => row.sessionId), ['a2', 'a1'])
  assert.equal(meta[0]?.title, 'recent archived')
  assert.equal(meta[1]?.cwd, '/work/a')
  assert.deepEqual(deriveArchivedSessions({ workspaces: [], archivedSessionIds: ['x1'], sessions: [{ sessionId: 'x1', running: false, blank: false }] }), [{ sessionId: 'x1' }])
  const conflict = deriveArchivedSessions({ workspaces: [workspace('w1', 'Alpha', ['conflict'])], archivedSessionIds: ['conflict'], sessions: [session('conflict', 250, { cwd: '/w2' })] })
  assert.deepEqual(conflict[0]?.workspace, { id: 'w1', title: 'Alpha' }, 'membership wins over another workspace cwd')
  const trailing = deriveArchivedSessions({ workspaces: [workspace('w1', 'Alpha', [])], archivedSessionIds: ['a3'], sessions: [session('a3', 3, { cwd: '/w1/' })] })
  assert.deepEqual(trailing[0]?.workspace, { id: 'w1', title: 'Alpha' }, 'the cwd fallback normalizes trailing separators')
  const groups = groupArchivedRows([
    { sessionId: 'o1', updatedAt: 999 },
    { sessionId: 'a2', updatedAt: 100, workspace: { id: 'w2', title: 'Beta' } },
    { sessionId: 'a1', updatedAt: 300, workspace: { id: 'w1', title: 'Alpha' } },
  ])
  assert.deepEqual(groups.map(group => group.key), ['w1', 'w2', UNGROUPED_WORKSPACE_ID])
  assert.deepEqual(groups[2]?.rows.map(row => row.sessionId), ['o1'])
  const unordered = groupArchivedRows([
    { sessionId: 'late', workspace: { id: 'w1', title: 'Alpha' } },
    { sessionId: 'early', updatedAt: 5, workspace: { id: 'w1', title: 'Alpha' } },
  ])
  assert.deepEqual(unordered[0]?.rows.map(row => row.sessionId), ['early', 'late'])
  const mounted = projectInstanceSnapshot({ items: [workspace('w1', 'w1')], archivedSessionIds: [], state: 'idle', phase: 'ready' }, { ids: [], byId: {}, phase: 'ready' })
  assert.equal(mounted?.archiveSetKnown, true, 'an empty mounted archive set is authoritative')
  const scheduleSig = (armed: boolean) => serversProjectionSignature([server('local', {
    workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, blank: false, updatedAt: 5, hasActiveSchedule: armed }] }],
  })] as never)
  assert.notEqual(scheduleSig(false), scheduleSig(true), 'a schedule-only flip moves the publish gate')
  assert.equal(scheduleSig(false), scheduleSig(false), 'reverting restores identical bytes')
})

test('round-3 restore: mergeRuntimeFacts overlay keeps the armed union and sparse fills', () => {
  const merged = mergeRuntimeFacts(
    { current: 's1', sessions: { s1: { running: false }, s3: { running: false, completed: true } } },
    { s1: true, s2: true, s4: false },
    { s2: { pending: 'question' } },
  )
  assert.deepEqual(merged, {
    current: 's1',
    sessions: {
      s1: { running: false, completed: true },
      s3: { running: false, completed: true },
      s2: { completed: true, pending: 'question' },
    },
  }, 'an overlay row still receives its armed dot')
  assert.deepEqual(mergeRuntimeFacts({ sessions: { a: { running: false } } }, undefined, { a: { runningSubagents: 3 } })?.sessions.a,
    { running: false, runningSubagents: 3 }, 'an absent channel count is filled by the overlay')
  assert.deepEqual(mergeRuntimeFacts(undefined, undefined, { s1: {} })?.sessions.s1, {}, 'an empty overlay row invents nothing')
})

test('round-3 restore: reconcile composition, replaced receipt variants and report signatures', () => {
  const left = reconcile({ x: true }, { x: false }, {}, undefined)
  assert.deepEqual(left.completed, {}, 'a departed session drops its armed dot')
  assert.equal(left.changed, true)
  const stepA = reconcile({}, { x: true }, { x: { running: false }, y: { running: false } }, undefined)
  assert.deepEqual(stepA.completed, { x: true })
  const stepB = reconcile(stepA.completed, { x: false, y: true }, { x: { running: false }, y: { running: false } }, undefined)
  assert.deepEqual(stepB.completed, { x: true, y: true }, 'two batched updaters keep both arms')
  assert.deepEqual(reconcile({ x: true }, { x: false }, { x: { running: false } }, 'x').completed, {}, 'reading the armed session disarms')
  assert.equal(runtimeReportSignature(undefined), '')
  const a: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: true }, s2: { completed: true } } }
  assert.equal(runtimeReportSignature(a), runtimeReportSignature({ current: 's1', sessions: { s2: { completed: true }, s1: { running: true } } }), 'insertion order is normalized')
  assert.notEqual(runtimeReportSignature(a), runtimeReportSignature({ current: 's1', sessions: { s1: { running: false }, s2: { completed: true } } }), 'running bits matter')
  assert.notEqual(runtimeReportSignature({ sessions: { p: { running: false } } }), runtimeReportSignature({ sessions: { p: { running: false, runningSubagents: 2 } } }), 'subagent counts matter')
  assert.notEqual(runtimeReportSignature({ sessions: { p: { running: false } } }), runtimeReportSignature({ sessions: { p: { running: false, pending: 'approval' } } }), 'pending kinds matter')
  assert.notEqual(runtimeReportSignature({ sessions: { p: { pending: 'approval' } } }, undefined, false), runtimeReportSignature({ sessions: { p: { pending: 'question' } } }, undefined, false))
  assert.notEqual(runtimeReportSignature({ sessions: {}, sessionAuthority: { requestedAt: 1_000, settledAt: 2_000, ok: true, progressStamp: 1, probes: 0, corrections: 0, recent: [] } }), '', 'a receipt-only report is content')
  assert.equal(runtimeReportSignature({ sessions: {} }), '', 'a truly empty report stays empty')
  assert.equal(runtimeReportSignature({ current: 's1', sessions: { s1: { running: true } } }, undefined, false), runtimeReportSignature({ current: 's1', sessions: { s1: { running: false } } }, undefined, false), 'the projection path drops the running bit')
  assert.notEqual(runtimeReportSignature({ sessions: { s1: { completed: true } } }, undefined, false), runtimeReportSignature({ sessions: { s1: {} } }, undefined, false), 'rendered facts still matter in the projection path')
  assert.notEqual(runtimeReportSignature(a, new Set(['s1'])), runtimeReportSignature(a, new Set(['s2'])), 'different visible subsets differ')
  // factAt 是渲染字段（行的 data-chamber-fact-at 证据锚），必须像其他渲染字段一样动签名：
  // 漏签时「行不变、只有观察者时钟前进」的上报被去重丢弃，锚点冻结在首见值。
  assert.notEqual(
    runtimeReportSignature({ sessions: { s1: { running: false, factAt: 1_000 } } }),
    runtimeReportSignature({ sessions: { s1: { running: false, factAt: 2_000 } } }),
    'factAt-only change must republish on the identity path',
  )
  assert.notEqual(
    runtimeReportSignature({ sessions: { s1: { running: false, factAt: 1_000 } } }, undefined, false),
    runtimeReportSignature({ sessions: { s1: { running: false, factAt: 2_000 } } }, undefined, false),
    'factAt is rendered, so the projection path signs it too',
  )
  assert.equal(
    runtimeReportSignature({ sessions: { s1: { running: false } } }),
    runtimeReportSignature({ sessions: { s1: { running: false, factAt: 0 } } }),
    '0/absent both mean "no observer fact" — no churn invented',
  )
})

test('F6 regression: report.stale is signed on BOTH paths so a stale-only flip is never deduped away', () => {
  const live: InstanceRuntimeReport = { sessions: { s1: { running: false, completed: true } } }
  const stale: InstanceRuntimeReport = { ...live, stale: true }
  // 身份路径（App 的 runtimeFactsRef 去重守卫）：行不变、仅 stale 翻转必须移动签名，
  // 否则 use-bridge-subscriptions 不提交新 report，mergeRuntimeFacts 的 stale OR
  // 永远看不到断连标记（残留子代理计数被当 live）。
  assert.notEqual(runtimeReportSignature(live), runtimeReportSignature(stale))
  // 投影路径（侧栏 publish 去重）：server.runtime?.stale 是渲染事实
  // （data-chamber-stale / sessionStateLabel 的离线读数），同样必须移动签名。
  assert.notEqual(runtimeReportSignature(live, undefined, false), runtimeReportSignature(stale, undefined, false))
  // false = 缺席（no-op 旗标），不得制造 churn。
  assert.equal(runtimeReportSignature({ ...live, stale: false }), runtimeReportSignature(live))
  assert.equal(runtimeReportSignature({ ...live, stale: false }, undefined, false), runtimeReportSignature(live, undefined, false))
  // 只有 stale 的报告仍是内容（离线标记不得与「无 runtime」混同）；空报告的 '' 语义保留。
  assert.notEqual(runtimeReportSignature({ sessions: {}, stale: true }), '')
  assert.notEqual(runtimeReportSignature({ sessions: {}, stale: true }, undefined, false), '')
  assert.equal(runtimeReportSignature({ sessions: {} }), '')
  // 去重链端到端对拍：签名相同才吞——落地的 stale report 必须让 merge OR 到合并报告。
  const committed = runtimeReportSignature(live) === runtimeReportSignature(stale) ? live : stale
  assert.equal(mergeRuntimeFacts(committed, { s1: true })?.stale, true)
})

test('round-3 restore: serversProjectionSignature tracks render-relevant fields and ignores stamps', () => {
  const a = [server('local'), server('ssh-r1')]
  assert.equal(serversProjectionSignature(a), serversProjectionSignature([server('local', { updatedAt: 123456789 }), server('ssh-r1', { updatedAt: 987654321 })]), 'the per-call updatedAt stamp is ignored')
  const remoteOnly = (overrides: Parameters<typeof server>[1] = {}) => serversProjectionSignature([server('ssh-r1', overrides)])
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('local'), server('ssh-r1', { sourceFingerprint: 'b'.repeat(64) })]), 'a same-id replacement republishes')
  assert.notEqual(remoteOnly(), remoteOnly({ kind: 'gateway' }))
  assert.notEqual(remoteOnly(), remoteOnly({ transport: 'http' }))
  assert.notEqual(remoteOnly(), remoteOnly({ managedRuntimeDown: true }))
  assert.notEqual(remoteOnly({ rawId: 'r1' }), remoteOnly({ rawId: 'other' }))
  assert.notEqual(remoteOnly(), remoteOnly({ bootGap: { kind: 'graph-unavailable' } }))
  assert.equal(remoteOnly({ bootGap: { kind: 'graph-unavailable' } }), remoteOnly({ bootGap: { kind: 'graph-unavailable', services: [], injectedBy: [], failedIds: [] } }), 'absent and empty structured fields are the same fact')
  assert.notEqual(remoteOnly({ bootGap: { kind: 'graph-unavailable' } }), remoteOnly({ bootGap: { kind: 'required-services-missing', services: ['sidebarRight'] } }))
  assert.notEqual(remoteOnly(), remoteOnly({ dshVersion: '1.2.3' }))
  const withSession = (updatedAt: number) => serversProjectionSignature([server('local'), server('ssh-r1', { workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, updatedAt }] }] })])
  assert.notEqual(serversProjectionSignature(a), withSession(999), 'session updatedAt moves the gate')
  assert.equal(serversProjectionSignature(a), withSession(1), 'identical session bytes sign identically')
  assert.equal(serversProjectionSignature(a), serversProjectionSignature([server('local'), server('ssh-r1', { runtime: { sessions: { hidden: { running: true } } } })]), 'hidden runtime rows never re-render')
  assert.equal(serversProjectionSignature([server('local'), server('ssh-r1', { runtime: { sessions: { s1: { running: true } } } })]), serversProjectionSignature([server('local'), server('ssh-r1', { runtime: { sessions: { s1: { running: false } } } })]), 'the channel running bit is excluded')
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('local'), server('ssh-r1', { runtime: { sessions: { s1: { completed: true } } } })]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('local', { connected: false }), server('ssh-r1')]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('local', { phase: 'starting' }), server('ssh-r1')]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('ssh-r1'), server('local')]), 'source order matters')
})

test('round-3 restore: InstanceRuntimeReport declares the optional judgment facts', () => {
  const store = stripComments(readFileSync(fileURLToPath(new URL('../../../dsh-chamber-client-core/src/aggregate-store.ts', import.meta.url)), 'utf8'))
  assert.match(store, /listComplete\?: boolean/, 'listComplete is an optional additive field')
  assert.match(store, /stale\?: boolean/, 'the stale marker is optional')
})



