/**
 * session-echo.ts unit tests (plain node:test, no dsh, no DOM): the local echo of a
 * sidebar-issued `session.create` / `session.fork` (design 05 §2.2 revision; the
 * session-side sibling of the workspace echo).
 *
 * The contract: local facts are echoed, authoritative membership always wins, the row is projected
 * INTO its workspace (never the trailing ungrouped bucket), a listed row is never duplicated, and
 * every path out (accounting, archive, retirement, TTL) retires the entry. Identity preservation
 * is checked explicitly — the publish is signature-gated. The projection block is the
 * regression lock (a post-create push that does not list the id renders the row only because of
 * the echo), and the final block covers the archive tombstone: an archive over a NOT-mounted
 * source has no other channel (frozen pushed archive set + archive-wire-less fallback), so the row
 * would stay listed and open into the official cleared-current view.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  forgetPendingArchives,
  forgetPendingSessions,
  reconcilePendingArchives,
  reconcilePendingSessions,
  recordPendingArchive,
  recordPendingSession,
  refreshPendingArchives,
  removePendingSession,
  sweepPendingArchives,
  sweepPendingSessions,
  withPendingArchives,
  withSessionEcho,
  type PendingSession,
  type SessionArchiveLedger,
  type SessionEchoLedger,
} from '@dsh-chamber/dsh-chamber-client-core'
import {
  PENDING_ARCHIVE_TTL_MS,
  PENDING_SESSION_TTL_MS,
  sessionEchoRow,
} from '../../../dsh-chamber-client-core/src/session-echo.ts'
import { deriveServerWorkspaces } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { __resetMembershipGracesForTests } from '../../../dsh-chamber-client-core/src/derive.ts'
import type { InstanceAggregate, SessionRow, WorkspaceRow } from '@dsh-chamber/dsh-chamber-client-core/instance-api'

function aggregate(
  workspaces: WorkspaceRow[],
  sessions: SessionRow[] = [],
  state: InstanceAggregate['state'] = 'ok',
): InstanceAggregate {
  return { state, workspaces, sessions, archivedSessionIds: [], archiveSetKnown: state === 'ok', error: null }
}

const sessionRow = (sessionId: string, cwd?: string, blank = false): SessionRow =>
  ({ sessionId, running: false, blank, title: sessionId, ...(cwd === undefined ? {} : { cwd }) })

const realWorkspace = (workspaceId: string, path: string, sessionIds: string[] = []): WorkspaceRow =>
  ({ workspaceId, path, title: path.slice(path.lastIndexOf('/') + 1), sessionIds, createdAt: '', updatedAt: '' })

const syntheticGroup = (path: string, sessionIds: string[] = []): WorkspaceRow =>
  ({ ...realWorkspace(`__cwd__:${path}`, path, sessionIds), synthetic: true })

const pending = (sessionId: string, workspaceId?: string, path?: string, at = 0, blank = true): PendingSession =>
  ({ sessionId, ...(workspaceId === undefined ? {} : { workspaceId }), ...(path === undefined ? {} : { path }), blank, at })

// Projection helpers: one derive per call (membership graces are module state), source 'ssh-b'.
const derive = (agg: InstanceAggregate, current?: string) => deriveServerWorkspaces(agg, 'ssh-b', '', current, 1000)
const shape = (groups: ReturnType<typeof derive>): [string, string[]][] =>
  groups.map(workspace => [workspace.id, workspace.sessions.map(session => session.id)])

test('recordPendingSession: records the host id, its workspace and the blank fact (sparse title)', () => {
  const ledger = recordPendingSession({}, 'ssh-b', { sessionId: 's-1', workspaceId: 'w1', blank: true }, 1000)
  assert.deepEqual(ledger, { 'ssh-b': [{ sessionId: 's-1', workspaceId: 'w1', blank: true, at: 1000 }] })
  const hinted = recordPendingSession({}, 'ssh-b', {
    sessionId: 's-2', parentSessionId: 's-1', title: 'parent (1)', blank: false,
  }, 5)
  assert.deepEqual(hinted['ssh-b'], [{ sessionId: 's-2', title: 'parent (1)', blank: false, at: 5 }],
    'the parent is not a ledger field (the App resolves membership before recording)')
})

test('recordPendingSession: a saga retry reuses the id slot and refreshes the TTL anchor', () => {
  const first = recordPendingSession({}, 'ssh-b', { sessionId: 's-1', workspaceId: 'w1', blank: true }, 10)
  const refreshed = recordPendingSession(first, 'ssh-b', { sessionId: 's-1', workspaceId: 'w1', blank: true }, 20)
  assert.deepEqual(refreshed['ssh-b'], [{ sessionId: 's-1', workspaceId: 'w1', blank: true, at: 20 }])
  assert.equal(sweepPendingSessions(refreshed, 10 + PENDING_SESSION_TTL_MS)['ssh-b']?.length, 1,
    'the refreshed anchor is what keeps a retried create visible past its original TTL')
  assert.equal(sweepPendingSessions(first, 10 + PENDING_SESSION_TTL_MS)['ssh-b'], undefined,
    'control: the un-refreshed anchor would have expired at that same clock')
})

test('sweepPendingSessions: expires past the TTL, drops the emptied key, keeps identity when nothing expires', () => {
  let ledger: SessionEchoLedger = {}
  ledger = recordPendingSession(ledger, 'ssh-b', { sessionId: 's-1', workspaceId: 'w1', blank: true }, 0)
  ledger = recordPendingSession(ledger, 'ssh-c', { sessionId: 's-9', workspaceId: 'w2', blank: true }, PENDING_SESSION_TTL_MS)
  assert.equal(sweepPendingSessions(ledger, PENDING_SESSION_TTL_MS - 1), ledger, 'nothing expired = same reference')
  const swept = sweepPendingSessions(ledger, PENDING_SESSION_TTL_MS + 1)
  assert.deepEqual(Object.keys(swept), ['ssh-c'], 'the emptied source key is dropped, the fresh one survives')
})

test('reconcilePendingSessions: only AUTHORITATIVE ACCOUNTING converges — a listed row keeps its echo', () => {
  const ledger = { 'ssh-b': [pending('s-1', 'w1'), pending('s-2', 'w1')] }
  const partly = reconcilePendingSessions(ledger, 'ssh-b', [realWorkspace('w1', '/p/a', ['s-1'])])
  assert.deepEqual(partly['ssh-b'], [pending('s-2', 'w1')],
    'only the ACCOUNTED id retires — the other echo stays (a membership that does not name it is no signal)')
  assert.equal(reconcilePendingSessions(ledger, 'ssh-zzz', [realWorkspace('w1', '/p/a', ['s-1'])]), ledger,
    'an unknown source changes nothing, by reference')
  const accounted = reconcilePendingSessions(ledger, 'ssh-b', [realWorkspace('w1', '/p/a', ['s-1', 's-2'])])
  assert.equal(accounted['ssh-b'], undefined, 'both accounted = the ledger entry is retired')
})

test('removePendingSession / forgetPendingSessions: the withdraw halves are identity-preserving', () => {
  const ledger: SessionEchoLedger = { 'ssh-b': [pending('s-1', 'w1'), pending('s-2', 'w1')] }
  assert.equal(removePendingSession(ledger, 'ssh-b', 's-9'), ledger, 'an unknown id changes nothing')
  assert.deepEqual(removePendingSession(ledger, 'ssh-b', 's-1')['ssh-b'], [pending('s-2', 'w1')])
  assert.equal(forgetPendingSessions(ledger, new Set(['ssh-zzz'])), ledger)
  assert.deepEqual(forgetPendingSessions(ledger, new Set(['ssh-b'])), {})
})

test('withSessionEcho: injects the row AND its workspace membership, keeping existing members', () => {
  const before = aggregate([realWorkspace('w1', '/p/a', ['old'])], [sessionRow('old', '/p/a')])
  const after = withSessionEcho(before, [pending('new', 'w1', '/p/a', 42)])
  // PREPENDED, not appended: the host's attachSession puts a new membership at the head
  // (`[sessionId, ...rest]`) and the default render order IS this array — appending would make
  // the row render last and jump to the head on convergence (see the ordering test below).
  assert.deepEqual(after.workspaces[0]?.sessionIds, ['new', 'old'], 'membership is the only route into a workspace group')
  assert.deepEqual(after.sessions.map(session => session.sessionId), ['old', 'new'],
    'the row list itself is a lookup list (render order comes from membership)')
  const injected = after.sessions[1]!
  assert.equal(injected.blank, true)
  assert.equal(injected.cwd, '/p/a')
  assert.equal(injected.updatedAt, 42, 'recency ordering puts the fresh row first')
  assert.equal(injected.displayTitle, 'a', 'the label ladder resolves from the workspace path')
  assert.equal(before.sessions.length, 1, 'the input aggregate is never mutated')
  assert.equal(before.workspaces[0]?.sessionIds.length, 1)
})

test('withSessionEcho: matches a cwd-derived synthetic group by canonical path (trailing separator)', () => {
  const before = aggregate([syntheticGroup('/p/a', ['old'])], [sessionRow('old', '/p/a')])
  const after = withSessionEcho(before, [pending('new', 'w-host-id', '/p/a/')])
  assert.equal(after.workspaces.length, 1, 'no second group for the same directory')
  assert.deepEqual(after.workspaces[0]?.sessionIds, ['new', 'old'], 'the host workspace id is unknown on this view — the path matches')
})

test('withSessionEcho: a listed row gets membership only — never a duplicate', () => {
  const before = aggregate([realWorkspace('w1', '/p/a', [])], [sessionRow('new', '/p/a', true)])
  const after = withSessionEcho(before, [pending('new', 'w1', '/p/a')])
  assert.equal(after.sessions.length, 1, 'the unary fallback already listed it; the echo must not duplicate the row')
  assert.deepEqual(after.workspaces[0]?.sessionIds, ['new'])
})

test('withSessionEcho: authoritative membership wins, unusable aggregates and no-ops keep their reference', () => {
  const accounted = aggregate([realWorkspace('w1', '/p/a', ['new'])], [sessionRow('new', '/p/a', true)])
  assert.equal(withSessionEcho(accounted, [pending('new', 'w1', '/p/a')]), accounted)
  const error = aggregate([], [], 'error')
  assert.equal(withSessionEcho(error, [pending('new', 'w1', '/p/a')]), error)
  const noPending = aggregate([realWorkspace('w1', '/p/a')])
  assert.equal(withSessionEcho(noPending, undefined), noPending)
  assert.equal(withSessionEcho(noPending, []), noPending)
})

test('withSessionEcho: an unresolvable entry still renders, as an ungrouped row', () => {
  const before = aggregate([realWorkspace('w1', '/p/a')], [])
  const after = withSessionEcho(before, [pending('new')])
  assert.deepEqual(after.sessions.map(session => session.sessionId), ['new'])
  assert.equal(after.workspaces[0]?.sessionIds.length, 0, 'no membership is invented')
})

test('sessionEchoRow: a title hint wins over the id ladder, an absent path keeps the row sparse', () => {
  const hinted = sessionEchoRow({ sessionId: 's-9', title: 'parent (1)', blank: false, at: 7 })
  assert.equal(hinted.displayTitle, 'parent (1)')
  assert.equal(hinted.title, 'parent (1)')
  assert.equal('cwd' in hinted, false)
})

// ---- projection-level integration ----------------

test('integration: the mounted push without the created session renders NOTHING for it — the echo is the fix', () => {
  __resetMembershipGracesForTests()
  // The failing field-report state: the official summary store did not have the out-of-band session
  // when this push was produced (it learns it only from the host's ASYNC api-session/added
  // broadcast), so the push — which REPLACES the aggregate — lists neither the row nor its membership.
  const pushedWithoutNew = aggregate([realWorkspace('w1', '/p/a', ['old'])], [sessionRow('old', '/p/a')])
  assert.deepEqual(shape(derive(pushedWithoutNew, 'new')), [['w1', ['old']]],
    'control: neither the row nor its membership is present — the sidebar shows nothing for the session just created on that server')
  const withEcho = withSessionEcho(pushedWithoutNew, [pending('new', 'w1', '/p/a', 900)])
  const derived = derive(withEcho, 'new')
  assert.deepEqual(shape(derived), [['w1', ['new', 'old']]],
    'the echoed row lands INSIDE its workspace at the host creation order (head), not in the ungrouped bucket')
  const echoedRow = derived[0]?.sessions.find(session => session.id === 'new')
  assert.equal(echoedRow?.blank, true, 'the provisional New Session shape is preserved (upstream semantics)')
  assert.equal(echoedRow?.displayTitle, 'a')
})

test('integration: a stray the unary merge already lists is RE-HOMED into its workspace by the echo', () => {
  __resetMembershipGracesForTests()
  // Mid-flight state: the immediate requestRefresh merge contributed the new session's row (fresh
  // session.list) while keeping the pushed workspace membership frozen — the row belongs to none.
  const merged = aggregate([realWorkspace('w1', '/p/a', ['old'])], [sessionRow('old', '/p/a'), sessionRow('new', '/p/a', true)])
  assert.deepEqual(shape(derive(merged, 'new')), [['w1', ['old']], ['__ungrouped__', ['new']]],
    'control: without the echo the row drifts into the trailing ungrouped bucket')
  const withEcho = withSessionEcho(merged, [pending('new', 'w1', '/p/a', 900)])
  assert.deepEqual(shape(derive(withEcho, 'new')), [['w1', ['new', 'old']]],
    'the echo contributes only the missing membership — no duplicate row, no ungrouped copy')
})

test('integration: authoritative accounting converges the echo and the row does not jump', () => {
  __resetMembershipGracesForTests()
  let ledger: SessionEchoLedger = recordPendingSession({}, 'ssh-b', { sessionId: 'new', workspaceId: 'w1', path: '/p/a', blank: true }, 900)
  const projected = withSessionEcho(aggregate([realWorkspace('w1', '/p/a', ['old'])], [sessionRow('old', '/p/a')]), ledger['ssh-b'])
  const before = derive(projected, 'new')
  assert.deepEqual(before[0]?.sessions.map(session => session.id), ['new', 'old'])

  // The authoritative push now accounts the session — with the HOST's own order (attachSession prepends).
  const pushed: InstanceAggregate = aggregate([realWorkspace('w1', '/p/a', ['new', 'old'])],
    [sessionRow('old', '/p/a'), sessionRow('new', '/p/a', true)])
  ledger = reconcilePendingSessions(ledger, 'ssh-b', pushed.workspaces)
  assert.equal(ledger['ssh-b'], undefined, 'the echo retires on the authoritative membership')
  const after = derive(withSessionEcho(pushed, ledger['ssh-b']), 'new')
  assert.deepEqual(shape(after), [['w1', ['new', 'old']]],
    'same position and same rows before and after convergence — the row never jumps')
})

test('integration: an unmounted source carries the new id in its cwd-derived group and converges on the pull', () => {
  __resetMembershipGracesForTests()
  // Unary fallback view of an unmounted source: synthetic cwd group listing the new session (it
  // has a cwd on the host), and NOTHING to attach it to yet.
  const fallback = aggregate([syntheticGroup('/p/a', [])], [sessionRow('new', '/p/a', true)])
  assert.deepEqual(shape(derive(fallback, 'new')), [['__cwd__:/p/a', []], ['__ungrouped__', ['new']]],
    'control: the freshly created row is unaccounted, so it renders in the trailing bucket (the position jump the echo removes)')
  const ledger = { 'ssh-b': [pending('new', 'w1', '/p/a', 900)] }
  const echoed = derive(withSessionEcho(fallback, ledger['ssh-b']), 'new')
  assert.deepEqual(echoed[0]?.sessions.map(session => session.id), ['new'], 'the echo puts it in the directory group by path')
  // The listing pull's synthetic rows ARE this view's workspaces: reconcile there.
  const reconciled = reconcilePendingSessions(ledger, 'ssh-b', [
    syntheticGroup('/p/a', ['new']),
    syntheticGroup('/p/other', []),
  ])
  assert.equal(reconciled['ssh-b'], undefined)
})

test('integration: upstream blank visibility is preserved (no override by the echo)', () => {
  __resetMembershipGracesForTests()
  const view = withSessionEcho(aggregate([realWorkspace('w1', '/p/a', ['old'])], [sessionRow('old', '/p/a')]),
    [pending('new', 'w1', '/p/a', 900)])
  const withoutCurrent = derive(view)
  assert.deepEqual(withoutCurrent[0]?.sessions.map(session => session.id), ['old'], 'a non-current source keeps its provisional row hidden')
  const nonBlank = withSessionEcho(aggregate([realWorkspace('w1', '/p/a', ['old'])], [sessionRow('old', '/p/a')]),
    [pending('forked', 'w1', '/p/a', 900, false)])
  const withoutCurrentFork = derive(nonBlank)
  assert.deepEqual(withoutCurrentFork[0]?.sessions.map(session => session.id), ['forked', 'old'],
    'a fork child carries content, so it renders like any other row (at the head, like the host attach order)')
})

// ---- local archive tombstones (design 05 §2.2.1) -------------------

test('archive ledger: a repeat archive refreshes the lease per id, sweep drops only expired leases', () => {
  let ledger: SessionArchiveLedger = recordPendingArchive({}, 'ssh-b', 's-1', 10)
  ledger = recordPendingArchive(ledger, 'ssh-b', 's-1', 20)
  assert.deepEqual(ledger['ssh-b'], [{ sessionId: 's-1', at: 20 }], 'idempotent per id: replace, never stack')
  ledger = recordPendingArchive(ledger, 'ssh-b', 's-2', PENDING_ARCHIVE_TTL_MS)
  assert.equal(sweepPendingArchives(ledger, 20 + PENDING_ARCHIVE_TTL_MS - 1), ledger, 'nothing expired = same reference')
  assert.deepEqual(Object.keys(sweepPendingArchives(ledger, PENDING_ARCHIVE_TTL_MS + 21)), ['ssh-b'],
    'only the expired id is reaped; a fresh lease in the same source keeps the key alive')
  assert.deepEqual(sweepPendingArchives(ledger, PENDING_ARCHIVE_TTL_MS + 21)['ssh-b'], [{ sessionId: 's-2', at: PENDING_ARCHIVE_TTL_MS }])
})

test('archive ledger: the lease is refreshed only while the degraded listing still lists the id', () => {
  const ledger = recordPendingArchive({}, 'ssh-b', 's-1', 10)
  assert.equal(refreshPendingArchives(ledger, 'ssh-b', new Set(['other']), 50), ledger,
    'a listing that no longer shows the row changes nothing (identity-preserving)')
  assert.equal(refreshPendingArchives(ledger, 'ssh-zzz', new Set(['s-1']), 50), ledger)
  assert.deepEqual(refreshPendingArchives(ledger, 'ssh-b', new Set(['s-1']), 50)['ssh-b'], [{ sessionId: 's-1', at: 50 }],
    'as long as the stale view keeps rendering it, the tombstone keeps hiding it')
})

test('archive ledger: only an AUTHORITATIVE set converges — the degraded empty set must not', () => {
  const ledger = { 'ssh-b': [{ sessionId: 's-1', at: 10 }] }
  assert.equal(reconcilePendingArchives(ledger, 'ssh-b', []), ledger, 'the unary fallback carries NO archive set — [] is not "nothing archived"')
  assert.equal(reconcilePendingArchives(ledger, 'ssh-zzz', ['s-1']), ledger, 'unknown source = identity')
  assert.equal(reconcilePendingArchives(ledger, 'ssh-b', ['s-1', 's-9'])['ssh-b'], undefined,
    'the authoritative set now names the id: the host owns its visibility again')
  assert.deepEqual(reconcilePendingArchives({ 'ssh-b': [{ sessionId: 's-1', at: 10 }, { sessionId: 's-2', at: 11 }] }, 'ssh-b', ['s-1'])['ssh-b'],
    [{ sessionId: 's-2', at: 11 }], 'only the covered id retires')
})

test('archive ledger: forget retires with the source generation', () => {
  const ledger: SessionArchiveLedger = { 'ssh-b': [{ sessionId: 's-1', at: 1 }], 'ssh-c': [{ sessionId: 's-2', at: 2 }] }
  assert.equal(forgetPendingArchives(ledger, new Set(['ssh-zzz'])), ledger)
  assert.deepEqual(forgetPendingArchives(ledger, new Set(['ssh-b'])), { 'ssh-c': [{ sessionId: 's-2', at: 2 }] })
})

test('withPendingArchives: extends archivedSessionIds, identity-preserving when covered, unusable or absent', () => {
  const base = aggregate([realWorkspace('w1', '/p/a', ['old', 's-1'])], [sessionRow('old', '/p/a'), sessionRow('s-1', '/p/a')])
  assert.equal(withPendingArchives(base, undefined), base)
  assert.equal(withPendingArchives(base, []), base)
  const covered = aggregate([realWorkspace('w1', '/p/a', ['s-1'])], [sessionRow('s-1', '/p/a')])
  covered.archivedSessionIds = ['s-1']
  assert.equal(withPendingArchives(covered, [{ sessionId: 's-1', at: 1 }]), covered, 'an id the set already names changes nothing')
  const applied = withPendingArchives(base, [{ sessionId: 's-1', at: 7 }])
  assert.deepEqual(applied.archivedSessionIds, ['s-1'], 'the tombstone is merged into the one visibility field')
  assert.deepEqual(base.archivedSessionIds, [], 'the input aggregate is never mutated')
  const error = aggregate([], [], 'error')
  assert.equal(withPendingArchives(error, [{ sessionId: 's-1', at: 1 }]), error)
})

test('integration: an archive on a NOT-mounted source hides the row only because of the tombstone', () => {
  __resetMembershipGracesForTests()
  // A previously-pushed (harvested) source whose shell is
  // gone. Its aggregate keeps the last pushed membership and archive set — the mutation pull's
  // mounted merge KEEPS that frozen set while the unary fallback carries no archive wire at all —
  // so the row the user just archived is still listed as an ordinary, openable row.
  const staleView = aggregate([realWorkspace('w1', '/p/a', ['old', 'target'])], [sessionRow('old', '/p/a'), sessionRow('target', '/p/a')])
  assert.deepEqual(shape(derive(staleView)), [['w1', ['old', 'target']]],
    'control: without the tombstone the archived row stays in the navigation list')
  const withTombstone = withPendingArchives(staleView, [{ sessionId: 'target', at: 900 }])
  assert.deepEqual(shape(derive(withTombstone)), [['w1', ['old']]],
    'the local tombstone hides exactly the row this page archived')
  // The mounted push finally carries the authoritative set -> the tombstone retires; no flicker.
  const authoritative = withPendingArchives(
    { ...staleView, archivedSessionIds: ['target'], archiveSetKnown: true },
    reconcilePendingArchives({ 'ssh-b': [{ sessionId: 'target', at: 900 }] }, 'ssh-b', ['target'])['ssh-b'],
  )
  assert.deepEqual(authoritative.archivedSessionIds, ['target'], 'the retirement leaves the host set in charge')
  assert.deepEqual(shape(derive(authoritative)), [['w1', ['old']]], 'the authoritative set takes over seamlessly')
})

test('integration: the tombstone also hides a pending creation row (create → archive in one window)', () => {
  __resetMembershipGracesForTests()
  const view = withPendingArchives(
    withSessionEcho(aggregate([realWorkspace('w1', '/p/a', ['old'])], [sessionRow('old', '/p/a')]), [pending('new', 'w1', '/p/a', 900)]),
    [{ sessionId: 'new', at: 901 }],
  )
  assert.deepEqual(shape(derive(view, 'new')), [['w1', ['old']]],
    'an archived creation must not survive through its own echo (the App also retires that entry)')
})

test('ledger plumbing: a TTL sweep never releases a tombstone early and preserves identity when nothing changes', () => {
  const base: SessionArchiveLedger = { 'ssh-a': [{ sessionId: 'a', at: 100 }, { sessionId: 'b', at: 900 }] }
  // Identity discipline: a sweep that expires nothing returns the SAME ledger
  // and the same row array (the App's publish signature depends on it).
  const intact = sweepPendingArchives(base, 100 + PENDING_ARCHIVE_TTL_MS - 1)
  assert.equal(intact, base)
  assert.equal(intact['ssh-a'], base['ssh-a'])
  // One tick later only the expired row goes; the live tombstone stays suppressed.
  const swept = sweepPendingArchives(base, 100 + PENDING_ARCHIVE_TTL_MS)
  assert.deepEqual(swept, { 'ssh-a': [{ sessionId: 'b', at: 900 }] })
  assert.notEqual(swept, base)
  // A whole-source expiry removes the key — never an empty-array tombstone slot.
  assert.deepEqual(sweepPendingArchives(base, 900 + PENDING_ARCHIVE_TTL_MS), {})
  // Filter/forget identity: nothing covered / nothing retired => the same ledger.
  assert.equal(reconcilePendingArchives(base, 'ssh-a', []), base)
  // A covered tombstone retires (the authoritative set takes over), and the
  // emptied source key disappears instead of lingering as an empty array.
  assert.deepEqual(reconcilePendingArchives(base, 'ssh-a', ['a', 'b']), {})
  assert.equal(forgetPendingArchives(base, new Set()), base)
})

