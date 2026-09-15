/**
 * Pure derive.ts unit tests, part 1: reconnect-baseline snapshot projection,
 * cwd-derived workspace membership, blank/subagent visibility and the
 * blank-ghost / membership / fork first-observation graces.
 *
 * Siblings in this split (test/session-rows/): workspace-membership.test.ts,
 * completed-dots-signatures.test.ts, source-ordering.test.ts,
 * search-and-archive.test.ts, schedule-label-reuse.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  armBlankGhost,
  armMembershipGrace,
  BLANK_GHOST_GRACE_MS,
  deriveServerWorkspaces,
  MEMBERSHIP_GRACE_MS,
  projectInstanceSnapshot,
  retainMembershipGraceSources,
  __resetBlankGhostsForTests,
  __resetMembershipGracesForTests,
} from '../../src/shared/derive.ts'
import type { WorkspaceRow } from '../../src/shared/instance-api.ts'
import { session, snapshot, workspace } from '../support/derive-fixtures.ts'

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
    sessions: [{ sessionId: 's1', updatedAt: 42, running: true, blank: false, cwd: '/w1', title: 'One', displayTitle: 'One' }],
    archivedSessionIds: ['old'],
    // Mounted baseline = authoritative archive set (2026-09 review round).
    archiveSetKnown: true,
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
    sessions: [{ sessionId: 's1', updatedAt: 42, running: true, blank: false, cwd: '/w1', title: 'One', displayTitle: 'One' }],
    archivedSessionIds: ['old'],
    // Mounted baseline = authoritative archive set (2026-09 review round).
    archiveSetKnown: true,
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
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
  assert.equal(result[0].ungrouped, undefined)
})

test('deriveServerWorkspaces passes the synthetic marker through for cwd-derived fallback groups', () => {
  // fetchInstanceSnapshot marks its `__cwd__:` groups synthetic: true so the
  // sidebar can disable their host-scoped mutations (2026-11 fix). The
  // derive layer must keep the marker; real rows never carry it.
  const syntheticRow: WorkspaceRow = {
    ...workspace('__cwd__:/work/a', 'a', ['s1']),
    synthetic: true,
  }
  const result = deriveServerWorkspaces(
    snapshot([syntheticRow, workspace('w1', 'Work', ['s2'])], [session('s1', 1), session('s2', 2)]),
    'srv-a',
    '',
  )
  assert.equal(result[0].synthetic, true)
  assert.equal(result[1].synthetic, undefined)
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
    { id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 },
    { id: 'b', title: '', displayTitle: 'b', running: false, updatedAt: 2, blank: true },
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
  assert.deepEqual(result[1].sessions, [{ id: 'blank', title: '', displayTitle: 'blank', running: false, updatedAt: 300, blank: true }])
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
  assert.deepEqual(result[0].sessions, [{ id: 'b2', title: '', displayTitle: 'b2', running: false, updatedAt: 2, blank: true }])
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
    { id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 },
    { id: 'b', title: '', displayTitle: 'b', running: false, updatedAt: 2, blank: true },
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
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
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
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
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
  assert.deepEqual(result[1].sessions, [{ id: 'blank', title: '', displayTitle: 'blank', running: false, updatedAt: 300, blank: true }])
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
    { id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 },
    { id: 'b', title: '', displayTitle: 'b', running: false, updatedAt: 2, blank: true },
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
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
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
    { id: 'new', title: '', displayTitle: 'new', running: false, updatedAt: 500 },
    { id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 },
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
  assert.deepEqual(atExpiry[1].sessions, [{ id: 'new', title: '', displayTitle: 'new', running: false, updatedAt: 500 }])
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
  assert.deepEqual(result[1].sessions, [{ id: 'stray', title: '', displayTitle: 'stray', running: false, updatedAt: 500 }])
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
  assert.deepEqual(result[1].sessions, [{ id: 'session-5', title: '', displayTitle: 'session-5', running: false, updatedAt: 500 }])
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
  const expired = deriveServerWorkspaces(
    pendingAttach,
    'srv-a',
    '',
    undefined,
    1000 + MEMBERSHIP_GRACE_MS,
  )
  assert.equal(expired.length, 2)
  assert.equal(expired[1].ungrouped, true)
  assert.deepEqual(expired[1].sessions, [{ id: 'child', title: '', displayTitle: 'child', running: false, updatedAt: 500 }])

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
    { id: 'stray-child', title: '', displayTitle: 'stray-child', running: false, updatedAt: 500 },
    { id: 'stray-parent', title: '', displayTitle: 'stray-parent', running: false, updatedAt: 40 },
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

