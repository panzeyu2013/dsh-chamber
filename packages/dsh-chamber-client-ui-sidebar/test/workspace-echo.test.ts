/**
 * workspace-echo.ts unit tests (plain node:test, no dsh, no DOM): the local
 * echo of a sidebar-issued `workspace.create` (design 05 §2.2 revision
 * 2026-12; 2026-12 field report problem 2 — "新建工作区后要手动点一下那个
 * 服务器才刷新出来").
 *
 * The contract under test is the whole reason the echo is safe to render:
 * local facts are echoed, authoritative facts always win, a same-path synthetic
 * group is REPLACED in place (never rendered twice), and every path out
 * (convergence, retirement, TTL) retires the entry. Identity preservation is
 * checked explicitly — the projection publish is signature-gated, and a
 * needlessly rebuilt aggregate would drive a full sidebar re-render per derive.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  forgetPendingWorkspaces,
  PENDING_WORKSPACE_TTL_MS,
  reconcilePendingWorkspaces,
  recordPendingWorkspace,
  sweepPendingWorkspaces,
  withWorkspaceEcho,
  workspaceEchoRow,
  type PendingWorkspace,
  type WorkspaceEchoLedger,
} from '../src/shared/workspace-echo.ts'
import { deriveServerWorkspaces } from '../src/shared/derive.ts'
import type { InstanceAggregate, WorkspaceRow } from '../src/shared/instance-api.ts'

function aggregate(workspaces: WorkspaceRow[], state: InstanceAggregate['state'] = 'ok'): InstanceAggregate {
  return { state, workspaces, sessions: [], archivedSessionIds: [], archiveSetKnown: state === 'ok', error: null }
}

function syntheticGroup(path: string, sessionIds: string[] = []): WorkspaceRow {
  return {
    workspaceId: `__cwd__:${path}`,
    path,
    title: path.slice(path.lastIndexOf('/') + 1),
    sessionIds,
    createdAt: '',
    updatedAt: '',
    synthetic: true,
  }
}

function realWorkspace(workspaceId: string, path: string): WorkspaceRow {
  return { workspaceId, path, title: path.slice(path.lastIndexOf('/') + 1), sessionIds: [], createdAt: '', updatedAt: '' }
}

function pending(workspaceId: string, path: string, at = 0): PendingWorkspace {
  return { workspaceId, path, title: path.slice(path.lastIndexOf('/') + 1), at }
}

test('recordPendingWorkspace: records the host id with a path-basename title', () => {
  const ledger = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'w1', path: '/home/u/proj' }, 1000)
  assert.deepEqual(ledger, { 'ssh-b': [{ workspaceId: 'w1', path: '/home/u/proj', title: 'proj', at: 1000 }] })
})

test('recordPendingWorkspace: the title follows the shared basename rule (both separators, design 23)', () => {
  const ledger = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'w1', path: 'C:\\Users\\u\\proj\\' }, 0)
  assert.equal(ledger['ssh-b']?.[0]?.title, 'proj')
})

test('recordPendingWorkspace: an identical re-record is identity-preserving, a changed id for the same path replaces in place', () => {
  const first = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'w1', path: '/p/a' }, 10)
  const again = recordPendingWorkspace(first, 'ssh-b', { workspaceId: 'w1', path: '/p/a' }, 10)
  assert.equal(again, first, 'an equal re-record must not rebuild the ledger')
  const replaced = recordPendingWorkspace(first, 'ssh-b', { workspaceId: 'w2', path: '/p/a' }, 20)
  assert.deepEqual(replaced['ssh-b'], [{ workspaceId: 'w2', path: '/p/a', title: 'a', at: 20 }])
})

test('recordPendingWorkspace: distinct paths accumulate in creation order (host creation-order tail)', () => {
  let ledger: WorkspaceEchoLedger = {}
  ledger = recordPendingWorkspace(ledger, 'ssh-b', { workspaceId: 'w1', path: '/p/a' }, 1)
  ledger = recordPendingWorkspace(ledger, 'ssh-b', { workspaceId: 'w2', path: '/p/b' }, 2)
  assert.deepEqual(ledger['ssh-b']?.map(row => row.workspaceId), ['w1', 'w2'])
})

test('sweepPendingWorkspaces: expires past the TTL, keeps fresh entries, and drops the emptied source key', () => {
  const ledger: WorkspaceEchoLedger = {
    'ssh-b': [pending('w1', '/p/a', 1000), pending('w2', '/p/b', 1000 + PENDING_WORKSPACE_TTL_MS)],
    'ssh-c': [pending('w3', '/p/c', 1000)],
  }
  const swept = sweepPendingWorkspaces(ledger, 1000 + PENDING_WORKSPACE_TTL_MS)
  // w1 is exactly at the TTL boundary → expired (strict `<` in the predicate);
  // w2 was recorded at the boundary → fresh; ssh-c's w3 expired with it.
  assert.deepEqual(swept['ssh-b']?.map(row => row.workspaceId), ['w2'])
  assert.equal(swept['ssh-c'], undefined)
  assert.equal(sweepPendingWorkspaces(swept, 1000 + PENDING_WORKSPACE_TTL_MS), swept, 'nothing expired → identity')
})

test('reconcilePendingWorkspaces: the authoritative workspace id retires the echo', () => {
  const ledger: WorkspaceEchoLedger = { 'ssh-b': [pending('w1', '/p/a')] }
  const next = reconcilePendingWorkspaces(ledger, 'ssh-b', [realWorkspace('w1', '/p/a')])
  assert.deepEqual(next, {})
})

test('reconcilePendingWorkspaces: a REAL row on the same path under another id wins too (host identity)', () => {
  const ledger: WorkspaceEchoLedger = { 'ssh-b': [pending('w1', '/p/a')] }
  const next = reconcilePendingWorkspaces(ledger, 'ssh-b', [realWorkspace('other', '/p/a')])
  assert.deepEqual(next, {})
})

test('reconcilePendingWorkspaces: a cwd-derived SYNTHETIC group never retires an echo (it carries no host identity)', () => {
  const ledger: WorkspaceEchoLedger = { 'ssh-b': [pending('w1', '/p/a')] }
  const next = reconcilePendingWorkspaces(ledger, 'ssh-b', [syntheticGroup('/p/a', ['s1'])])
  assert.equal(next, ledger, 'a synthetic match must leave the ledger untouched')
})

test('reconcilePendingWorkspaces: unrelated authoritative rows and untouched sources change nothing', () => {
  const ledger: WorkspaceEchoLedger = {
    'ssh-b': [pending('w1', '/p/a')],
    'ssh-c': [pending('w9', '/p/z')],
  }
  const next = reconcilePendingWorkspaces(ledger, 'ssh-b', [realWorkspace('x', '/p/x')])
  assert.equal(next, ledger)
  assert.equal(reconcilePendingWorkspaces(ledger, 'ssh-missing', [realWorkspace('w1', '/p/a')]), ledger)
})

test('forgetPendingWorkspaces: retires exactly the removed sources', () => {
  const ledger: WorkspaceEchoLedger = { 'ssh-b': [pending('w1', '/p/a')], 'ssh-c': [pending('w2', '/p/b')] }
  const next = forgetPendingWorkspaces(ledger, new Set(['ssh-b', 'ssh-unknown']))
  assert.deepEqual(Object.keys(next), ['ssh-c'])
  assert.equal(forgetPendingWorkspaces(ledger, new Set(['ssh-unknown'])), ledger, 'no match → identity')
})

test('withWorkspaceEcho: an absent/empty ledger or a non-ok aggregate returns the aggregate by reference', () => {
  const ok = aggregate([syntheticGroup('/p/a')])
  assert.equal(withWorkspaceEcho(ok, undefined), ok)
  assert.equal(withWorkspaceEcho(ok, []), ok)
  const error = aggregate([], 'error')
  assert.equal(withWorkspaceEcho(error, [pending('w1', '/p/a')]), error)
  const notConnected = aggregate([], 'not-connected')
  assert.equal(withWorkspaceEcho(notConnected, [pending('w1', '/p/a')]), notConnected)
})

test('withWorkspaceEcho: a brand-new workspace appends a real wire row at the tail', () => {
  const base = aggregate([realWorkspace('w0', '/p/base')])
  const next = withWorkspaceEcho(base, [pending('w1', '/p/new')])
  assert.notEqual(next, base)
  assert.deepEqual(next.workspaces.map(row => row.workspaceId), ['w0', 'w1'])
  assert.deepEqual(next.workspaces[1], workspaceEchoRow(pending('w1', '/p/new')))
  assert.equal(next.workspaces[1]?.synthetic, undefined, 'the echo row carries a REAL host id — never synthetic')
  assert.deepEqual(next.workspaces[1]?.sessionIds, [], 'no sessions yet: the row is legitimately empty')
})

test('withWorkspaceEcho: a same-path synthetic group is REPLACED in place by the real id (never two rows)', () => {
  const base = aggregate([syntheticGroup('/p/a', ['s1']), realWorkspace('w9', '/p/other')])
  const next = withWorkspaceEcho(base, [pending('w1', '/p/a')])
  assert.deepEqual(next.workspaces.map(row => row.workspaceId), ['w1', 'w9'], 'the synthetic slot is reused (no jump)')
  assert.equal(next.workspaces[0]?.synthetic, undefined)
  assert.deepEqual(next.workspaces[0]?.sessionIds, [])
})

test('withWorkspaceEcho: an authoritative row already covering the id or the path keeps the aggregate by reference', () => {
  const sameId = aggregate([realWorkspace('w1', '/p/a')])
  assert.equal(withWorkspaceEcho(sameId, [pending('w1', '/p/a')]), sameId)
  const samePathOtherId = aggregate([realWorkspace('other', '/p/a')])
  assert.equal(
    withWorkspaceEcho(samePathOtherId, [pending('w1', '/p/a')]),
    samePathOtherId,
    'host identity is authoritative — the echo must not duplicate the directory',
  )
})

test('withWorkspaceEcho: a second derive pass over its own output is identity-stable (publish signature gate)', () => {
  const base = aggregate([syntheticGroup('/p/a', ['s1'])])
  const once = withWorkspaceEcho(base, [pending('w1', '/p/a')])
  const twice = withWorkspaceEcho(once, [pending('w1', '/p/a')])
  assert.equal(twice, once, 'the already-echoed row must not be appended a second time')
})

test('integration: an echoed workspace reaches the sidebar projection as a real, EMPTY group', () => {
  // The whole fix rests on one property of the derive that must never silently
  // change: `deriveServerWorkspaces` pushes every workspace of the snapshot,
  // including one with no sessions. If it ever started filtering empty groups,
  // the echo row would vanish and the field bug would come back with all tests
  // green — so it is pinned HERE, end to end (echo → union → derive).
  const base = aggregate([syntheticGroup('/p/a', ['s1'])])
  const union = withWorkspaceEcho(base, [pending('w-new', '/p/work')])
  const groups = deriveServerWorkspaces(union, 'ssh-b', '未分组', undefined, 1_000)
  const echoed = groups.find(group => group.id === 'w-new')
  assert.ok(echoed !== undefined, 'the echoed workspace must render as a group')
  assert.deepEqual(echoed.sessions, [], 'a brand-new workspace legitimately has no rows')
  assert.equal(echoed.synthetic, undefined, 'its id is real: workspace-scoped actions stay enabled')
  assert.equal(echoed.title, 'work', 'title follows the path-basename rule of the cwd-derived groups')
  assert.equal(echoed.ungrouped, undefined, 'an echoed workspace is never the ungrouped bucket')
  // The pre-existing synthetic group is untouched (only same-path echoes replace).
  assert.equal(groups.find(group => group.id === '__cwd__:/p/a')?.synthetic, true)
})

test('integration: the authoritative push retires the echo and the group survives under its own id', () => {
  const base = aggregate([syntheticGroup('/p/work', ['s9'])])
  const union = withWorkspaceEcho(base, [pending('w-new', '/p/work')])
  assert.deepEqual(
    deriveServerWorkspaces(union, 'ssh-b', '未分组', undefined, 1_000).map(group => group.id),
    ['w-new'],
    'the echo replaces the same-path synthetic group in place (one row per directory)',
  )
  const ledger = reconcilePendingWorkspaces({ 'ssh-b': [pending('w-new', '/p/work')] }, 'ssh-b', [realWorkspace('w-new', '/p/work')])
  assert.deepEqual(ledger, {}, 'the push retires the local echo')
  const authoritative = aggregate([realWorkspace('w-new', '/p/work')])
  const afterPush = deriveServerWorkspaces(withWorkspaceEcho(authoritative, ledger['ssh-b']), 'ssh-b', '未分组', undefined, 1_000)
  assert.deepEqual(afterPush.map(group => group.id), ['w-new'], 'the authoritative row takes over seamlessly')
})
