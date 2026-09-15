/**
 * Schedule fact, display labels and blank reuse (part 6 of the derive split):
 * hasActiveScheduleOf, sessionDisplayTitle/basenameOf ladders,
 * findReusableBlankSession and the signature moves for those facts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  basenameOf,
  deriveLocalSearchMatches,
  deriveServerWorkspaces,
  findReusableBlankSession,
  hasActiveScheduleOf,
  instanceSnapshotSignature,
  projectInstanceSnapshot,
  serversProjectionSignature,
  sessionDisplayTitle,
  UNGROUPED_WORKSPACE_ID,
} from '../../src/shared/derive.ts'
import type { SessionRow } from '../../src/shared/instance-api.ts'
import { server, session, snapshot, workspace } from '../support/derive-fixtures.ts'

// ---------------------------------------------------------------------------
// 2026-09-11 upstream-alignment T7: the active-Schedule fact, end to end
// (session projection → snapshot → signature gate → rendered row).
// ---------------------------------------------------------------------------

test('hasActiveScheduleOf mirrors upstream: any non-empty schedule array means active', () => {
  // vendor ui-workspace tree.ts:161-163 — `(projectionValues?.schedule?.length ?? 0) > 0`.
  assert.equal(hasActiveScheduleOf(undefined), false, 'no projection bag = no active schedule')
  assert.equal(hasActiveScheduleOf({}), false, 'a bag without the key = no active schedule')
  assert.equal(hasActiveScheduleOf({ schedule: [] }), false, 'an empty active set is not active')
  assert.equal(hasActiveScheduleOf({ schedule: [{ id: 'sch1' }] }), true, 'one active schedule is active')
  // Defensive wire shapes: a non-array value (unknown-typed bag) is not a claim.
  assert.equal(hasActiveScheduleOf({ schedule: 'sch1' }), false, 'a non-array value is not an active set')
  assert.equal(hasActiveScheduleOf({ schedule: null }), false, 'null is not an active set')
})

test('projectInstanceSnapshot carries hasActiveSchedule sparsely (present only when active)', () => {
  const workspaceState = {
    items: [workspace('w1', 'Work', ['scheduled', 'plain'])],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
  }
  const sessionState = {
    ids: ['scheduled', 'plain'],
    phase: 'ready',
    byId: {
      scheduled: {
        id: 'scheduled',
        title: 'With schedule',
        running: false,
        blank: false,
        // The mounted store's SessionSummary.projectionValues bag.
        projectionValues: { schedule: [{ id: 'sch1' }] },
      },
      plain: {
        id: 'plain',
        title: 'No schedule',
        running: false,
        blank: false,
        projectionValues: { schedule: [] },
      },
    },
  }
  const projected = projectInstanceSnapshot(workspaceState, sessionState)
  assert.ok(projected !== undefined)
  assert.deepEqual(projected.sessions, [
    {
      sessionId: 'scheduled',
      running: false,
      blank: false,
      hasActiveSchedule: true,
      title: 'With schedule',
      displayTitle: 'With schedule',
    },
    // No key at all: the sparse form keeps every other row's bytes (and the
    // producer's signature gate) exactly as they were before this fact existed.
    { sessionId: 'plain', running: false, blank: false, title: 'No schedule', displayTitle: 'No schedule' },
  ])
})

test('a schedule change republishes: the snapshot signature carries the fact', () => {
  const idle = snapshot(
    [workspace('w1', 'Work', ['s1'])],
    [session('s1', 5, { title: 'One' })],
  )
  const armed = snapshot(
    [workspace('w1', 'Work', ['s1'])],
    [{ ...session('s1', 5, { title: 'One' }), hasActiveSchedule: true }],
  )
  assert.notEqual(
    instanceSnapshotSignature(idle),
    instanceSnapshotSignature(armed),
    'gaining an active schedule must change the signature (else the producer dedupe suppresses the row update)',
  )
  // ...and losing it again returns to the EXACT original bytes (undefined is
  // dropped by JSON.stringify, so schedule-less rows are byte-stable).
  assert.equal(instanceSnapshotSignature(idle), instanceSnapshotSignature(
    snapshot([workspace('w1', 'Work', ['s1'])], [{ ...session('s1', 5, { title: 'One' }), hasActiveSchedule: undefined }]),
  ))
})

test('deriveServerWorkspaces threads the schedule fact into workspace rows and the ungrouped bucket', () => {
  const withSchedule = { ...session('in-ws', 5, { title: 'In workspace' }), hasActiveSchedule: true }
  const strayScheduled = { ...session('stray', 6, { title: 'Stray' }), hasActiveSchedule: true }
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['in-ws'])],
      [withSchedule, strayScheduled],
    ),
    'local',
    '未分组',
    undefined,
    1_000,
  )
  const workspaceRows = result.find(group => group.id === 'w1')?.sessions ?? []
  const ungroupedRows = result.find(group => group.id === UNGROUPED_WORKSPACE_ID)?.sessions ?? []
  assert.equal(workspaceRows[0]?.hasActiveSchedule, true, 'the workspace-member row carries the fact')
  assert.equal(ungroupedRows[0]?.id, 'stray')
  assert.equal(ungroupedRows[0]?.hasActiveSchedule, true, 'the ungrouped stray carries the fact too')
  // A schedule-less session never gains the key (sparse both ways).
  const plain = deriveServerWorkspaces(
    snapshot([workspace('w1', 'Work', ['plain'])], [session('plain', 5, { title: 'Plain' })]),
    'local',
    '未分组',
    undefined,
    1_000,
  )
  assert.equal('hasActiveSchedule' in (plain[0]?.sessions[0] ?? {}), false, 'an ordinary row stays key-free')
})

// --- I3: the official display-label resolver ---------------------------------
// One rule (`sessionDisplayTitle`) replaces the bare durable title at every
// row surface, so "unknown title" can never render 「未命名会话」 again. The
// ladder is upstream's: title → canonical cwd basename → session id.

test('sessionDisplayTitle follows the official ladder and treats empty as absent', () => {
  assert.equal(sessionDisplayTitle({ title: 'Real title', sessionId: 'session-1' }), 'Real title')
  // A predecessor record's title row is an EMPTY string (not undefined): the
  // official label for that row is the project directory name.
  assert.equal(
    sessionDisplayTitle({ title: '', cwdBasename: 'dsh-chamber', sessionId: 'session-1' }),
    'dsh-chamber',
  )
  assert.equal(
    sessionDisplayTitle({ cwdBasename: 'dsh-chamber', sessionId: 'session-1' }),
    'dsh-chamber',
  )
  // Last resort: the raw session id — never an empty string, never the
  // "untitled" copy.
  assert.equal(sessionDisplayTitle({ sessionId: 'session-1' }), 'session-1')
  assert.equal(sessionDisplayTitle({ title: '', cwdBasename: '', sessionId: 'session-1' }), 'session-1')
  // A producer-resolved displayTitle wins outright.
  assert.equal(
    sessionDisplayTitle({ displayTitle: 'Resolved', title: 'Durable', sessionId: 'session-1' }),
    'Resolved',
  )
  // ...but an empty producer value falls through the ladder.
  assert.equal(
    sessionDisplayTitle({ displayTitle: '', title: 'Durable', sessionId: 'session-1' }),
    'Durable',
  )
})

test('basenameOf keeps the trailing-segment contract the echo and cwd groups share', () => {
  assert.equal(basenameOf('/Users/x/project'), 'project')
  assert.equal(basenameOf('/Users/x/project/'), 'project')
  assert.equal(basenameOf('C:\\Users\\x\\project'), 'project')
  assert.equal(basenameOf('/'), '/')
})

test('deriveServerWorkspaces labels an unreadable-title row with its directory name', () => {
  // The I3 regression: a session whose title projection is unreadable (a
  // predecessor cache record) used to arrive as title === '' and every surface
  // rendered 「未命名会话」. The derived row must carry the cwd basename.
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['untitled'])],
      [session('untitled', 5, { cwd: '/Users/x/dsh-chamber' })],
    ),
    'local',
    '未分组',
    undefined,
    1_000,
  )
  const row = result.find(group => group.id === 'w1')?.sessions[0]
  assert.equal(row?.title, '', 'the durable title stays empty — rename/fork copy must not see a fallback')
  assert.equal(row?.displayTitle, 'dsh-chamber', 'the official label is the directory name')
})

test('deriveServerWorkspaces falls back to the session id when even the cwd is unknown', () => {
  const result = deriveServerWorkspaces(
    snapshot([workspace('w1', 'Work', ['nowhere'])], [session('nowhere', 5)]),
    'local',
    '未分组',
    undefined,
    1_000,
  )
  assert.equal(result[0]?.sessions[0]?.displayTitle, 'nowhere')
})

test('the ungrouped bucket applies the same official label', () => {
  const result = deriveServerWorkspaces(
    snapshot([], [session('stray', 5, { cwd: '/Users/x/project' })]),
    'local',
    '未分组',
    undefined,
    1_000,
  )
  assert.equal(result[0]?.sessions[0]?.displayTitle, 'project')
})

test('the mounted projection carries the vendor displayTitle verbatim', () => {
  const workspaceState = {
    items: [workspace('w1', 'Work', ['s1'])],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
  }
  const sessionState = {
    ids: ['s1'],
    phase: 'ready',
    // The mounted store resolves the label itself; the chamber carries it.
    byId: { s1: { id: 's1', title: 'One', cwd: '/w1', running: false, blank: false, displayTitle: 'Vendor label' } },
  }
  const projected = projectInstanceSnapshot(workspaceState, sessionState)
  assert.equal(projected?.sessions[0]?.displayTitle, 'Vendor label')
})

test('a displayTitle-only change republishes: the label rides the signature', () => {
  const before = snapshot(
    [workspace('w1', 'Work', ['s1'])],
    [{ ...session('s1', 5), displayTitle: 'a' }],
  )
  const after = snapshot(
    [workspace('w1', 'Work', ['s1'])],
    [{ ...session('s1', 5), displayTitle: 'b' }],
  )
  assert.notEqual(
    instanceSnapshotSignature(before),
    instanceSnapshotSignature(after),
    'a label flip (e.g. the title projection landing, or a healed predecessor record) must republish',
  )
})

// --- I2: reuse-or-create for "+" ---------------------------------------------
// The chamber's "+" always issued session/create; upstream resolves the
// workspace's existing blank row first (connectWorkspace) and only creates when
// there is none. These tests pin the copied predicate and its derive wiring.

test('findReusableBlankSession mirrors the official connectWorkspace predicate', () => {
  const workspace = { path: '/w1', sessionIds: ['blank', 'other'] }
  const blank = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({
    sessionId: id,
    running: false,
    blank: true,
    cwd: '/w1',
    ...extra,
  })
  // The reusable row.
  assert.equal(findReusableBlankSession(workspace, [blank('blank')], new Set()), 'blank')
  // Non-blank, foreign cwd, non-member, archived, subagent and fork-child rows
  // are all skipped — in upstream's order.
  assert.equal(findReusableBlankSession(workspace, [{ ...blank('blank'), blank: false }], new Set()), undefined)
  assert.equal(findReusableBlankSession(workspace, [blank('blank', { cwd: '/elsewhere' })], new Set()), undefined)
  assert.equal(findReusableBlankSession({ path: '/w1', sessionIds: [] }, [blank('blank')], new Set()), undefined)
  assert.equal(findReusableBlankSession(workspace, [blank('blank')], new Set(['blank'])), undefined)
  assert.equal(findReusableBlankSession(workspace, [blank('blank', { origin: 'subagent' })], new Set()), undefined)
  assert.equal(findReusableBlankSession(workspace, [blank('blank', { parentSessionId: 'p' })], new Set()), undefined)
  // FIRST match wins (wire order), like upstream.
  assert.equal(
    findReusableBlankSession(workspace, [blank('blank'), blank('other', { cwd: '/w1' })], new Set()),
    'blank',
  )
})

test('the derived workspace carries the reuse resolution over the RAW snapshot', () => {
  // The blank row is NOT visible in navigation (it is not current), so the
  // reuse candidate can only come from the raw snapshot — the whole point.
  const reused = deriveServerWorkspaces(
    {
      ...snapshot([workspace('w1', 'Work', ['blank'])], [session('blank', 5, { blank: true, cwd: '/w1' })]),
      archiveSetKnown: true,
    },
    'local',
    '未分组',
    undefined,
    1_000,
  )
  const row = reused.find(group => group.id === 'w1')
  assert.equal(row?.reusableBlankSessionId, 'blank')
  assert.deepEqual(row?.sessions, [], 'the reusable row stays hidden while it is not the current session')
})

test('reuse is withheld when the archive set is unknown (unary fallback)', () => {
  const unknown = deriveServerWorkspaces(
    snapshot([workspace('w1', 'Work', ['blank'])], [session('blank', 5, { blank: true, cwd: '/w1' })]),
    'local',
    '未分组',
    undefined,
    1_000,
  )
  assert.equal(
    'reusableBlankSessionId' in (unknown[0] ?? {}),
    false,
    'an unknown archive set could make an archived row look reusable — create instead',
  )
})

test('reuse never picks an archived blank row', () => {
  const archived = deriveServerWorkspaces(
    {
      ...snapshot([workspace('w1', 'Work', ['blank'])], [session('blank', 5, { blank: true, cwd: '/w1' })]),
      archivedSessionIds: ['blank'],
      archiveSetKnown: true,
    },
    'local',
    '未分组',
    undefined,
    1_000,
  )
  assert.equal(archived[0]?.reusableBlankSessionId, undefined)
})

test('reuse is not offered for synthetic cwd-derived groups', () => {
  const synthetic = deriveServerWorkspaces(
    {
      ...snapshot(
        [{ ...workspace('__cwd__:/w1', 'w1', ['blank']), synthetic: true }],
        [session('blank', 5, { blank: true, cwd: '/w1' })],
      ),
      archiveSetKnown: true,
    },
    'local',
    '未分组',
    undefined,
    1_000,
  )
  assert.equal('reusableBlankSessionId' in (synthetic[0] ?? {}), false)
})

// ---- 2026-09 review fixes: label/reuse facts must move the projection gate ----

test('serversProjectionSignature moves for a label-only change (healed row must republish)', () => {
  // The sidebar's own subscription drops updates whose projection signature is
  // unchanged (SidebarRoot.tsx), so any RENDERED fact must be signed. The row
  // renders `displayTitle`, and a healed predecessor row can flip id → project
  // directory with no durable-title change: that flip must republish.
  const base = server('local')
  const relabeled = server('local', {
    workspaces: [{
      id: 'w1',
      title: 'Work',
      sessions: [{ id: 's1', title: 'One', displayTitle: 'dsh-chamber', running: false, updatedAt: 1 }],
    }],
  })
  assert.notEqual(serversProjectionSignature([base]), serversProjectionSignature([relabeled]))
})

test('serversProjectionSignature moves for a reuse-only change ("+" must see the new candidate)', () => {
  // A blank non-current row is INVISIBLE in navigation, so a reuse candidate can
  // appear/disappear without changing any other signed byte. Without this the
  // sidebar would keep a stale resolution and mint a duplicate empty session.
  const base = server('local')
  const reusable = server('local', {
    workspaces: [{
      id: 'w1',
      title: 'Work',
      reusableBlankSessionId: 'blank-1',
      sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, updatedAt: 1 }],
    }],
  })
  assert.notEqual(serversProjectionSignature([base]), serversProjectionSignature([reusable]))
  // Sparse on the wire, stable in the signature: absent and explicit-null are
  // the same fact.
  const explicitNull = server('local', {
    workspaces: [{
      id: 'w1',
      title: 'Work',
      reusableBlankSessionId: undefined,
      sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, updatedAt: 1 }],
    }],
  })
  assert.equal(serversProjectionSignature([base]), serversProjectionSignature([explicitNull]))
})

test('deriveLocalSearchMatches matches the DISPLAY label the row renders (2026-09 review)', () => {
  // Upstream matches the display title (ui-workspace tree.ts). A row labeled by
  // its project directory — the motivating case of the label fix — must be findable
  // by that directory, not only by its durable title.
  const rows = snapshot(
    [workspace('w1', 'Other', ['a'])],
    [session('a', 10, { cwd: '/Users/me/dsh-chamber', displayTitle: 'dsh-chamber' })],
  )
  assert.deepEqual(deriveLocalSearchMatches(rows, 'dsh-chamber'), [{ sessionId: 'a', snippet: '' }])
  // The durable title is still matched when present.
  const titled = snapshot(
    [workspace('w1', 'Other', ['a'])],
    [session('a', 10, { cwd: '/x', title: 'My Session', displayTitle: 'My Session' })],
  )
  assert.deepEqual(deriveLocalSearchMatches(titled, 'my session'), [{ sessionId: 'a', snippet: '' }])
})

test('sessionDisplayTitle: separator-only cwd and null fields fall through to the id', () => {
  // Upstream `workspaceTitleOf('/')` is '' and `displayTitleOf` then returns the
  // session id — never the raw separators.
  assert.equal(sessionDisplayTitle({ cwdBasename: '/', sessionId: 'sid' }), 'sid')
  assert.equal(sessionDisplayTitle({ cwdBasename: '///', sessionId: 'sid' }), 'sid')
  assert.equal(sessionDisplayTitle({ cwdBasename: '\\', sessionId: 'sid' }), 'sid')
  // A JSON producer can deliver null; it is not a label.
  assert.equal(sessionDisplayTitle({ displayTitle: null as never, title: null as never, sessionId: 'sid' }), 'sid')
  assert.equal(sessionDisplayTitle({ cwdBasename: 'proj', sessionId: 'sid' }), 'proj')
})
