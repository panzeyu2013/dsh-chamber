/**
 * workspace-echo.ts unit tests (plain node:test, no dsh, no DOM): the local
 * echo of a sidebar-issued `workspace.create` (design 05 §2.2 revision
 * 2026-12; 2026-12 field report problem 2 — "新建工作区后要手动点一下那个
 * 服务器才刷新出来").
 *
 * The contract under test is the whole reason the echo is safe to render:
 * local facts are echoed, authoritative facts always win, a same-path synthetic
 * group is REPLACED in place (never rendered twice, and keeping its members),
 * and every path out (convergence, the sidebar's own delete/rename facts,
 * retirement, TTL) retires or patches the entry. Identity preservation is
 * checked explicitly — the projection publish is signature-gated, and a
 * needlessly rebuilt aggregate would drive a full sidebar re-render per derive.
 * The last case is a source-text contract for the single funnel that publishes
 * the facts (SidebarRoot.tsx and the Git coordinator cannot be imported by a
 * node test): per-call-site publishing is the failure mode the funnel removes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  forgetPendingWorkspaces,
  PENDING_WORKSPACE_TTL_MS,
  reconcilePendingWorkspaces,
  recordPendingWorkspace,
  removePendingWorkspace,
  renamePendingWorkspace,
  sweepPendingWorkspaces,
  withWorkspaceEcho,
  workspaceEchoRow,
  type PendingWorkspace,
  type WorkspaceEchoLedger,
} from '../src/shared/workspace-echo.ts'
import { deriveServerWorkspaces } from '../src/shared/derive.ts'
import type { InstanceAggregate, SessionRow, WorkspaceRow } from '../src/shared/instance-api.ts'

function aggregate(
  workspaces: WorkspaceRow[],
  state: InstanceAggregate['state'] = 'ok',
  sessions: SessionRow[] = [],
): InstanceAggregate {
  return { state, workspaces, sessions, archivedSessionIds: [], archiveSetKnown: state === 'ok', error: null }
}

function sessionRow(sessionId: string, cwd?: string): SessionRow {
  return { sessionId, running: false, blank: false, title: sessionId, ...(cwd === undefined ? {} : { cwd }) }
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

test('recordPendingWorkspace: a producer title hint wins over the path basename', () => {
  // Git adopt 随后会把宿主标题改成分支名；标题提示让回声行生来就是最终标签
  // （否则先用 basename 出生、几个 RPC 之后再翻转）。
  const hinted = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'w1', path: '/p/feature-dir', title: 'feature/x' }, 1)
  assert.equal(hinted['ssh-b']?.[0]?.title, 'feature/x')
  const plain = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'w1', path: '/p/feature-dir' }, 1)
  assert.equal(plain['ssh-b']?.[0]?.title, 'feature-dir', 'no hint = the path-basename rule')
})

test('recordPendingWorkspace: an identical re-record refreshes the TTL anchor, a changed id for the same path replaces in place', () => {
  const first = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'w1', path: '/p/a' }, 10)
  const refreshed = recordPendingWorkspace(first, 'ssh-b', { workspaceId: 'w1', path: '/p/a' }, 20)
  // The anchor is refreshed unconditionally, including for a byte-identical
  // re-record: the host reuses an existing registration (`created: false`) and
  // returns the same id, and a stale anchor would make a FRESH action's echo —
  // the row the user just asked for — expire seconds later. Only a create
  // reaches this entry point, so the rebuilt identity costs one publish.
  assert.deepEqual(refreshed['ssh-b'], [{ workspaceId: 'w1', path: '/p/a', title: 'a', at: 20 }])
  const pastTheFirstAnchor = 10 + PENDING_WORKSPACE_TTL_MS
  assert.equal(
    sweepPendingWorkspaces(refreshed, pastTheFirstAnchor)['ssh-b']?.length,
    1,
    'the refreshed anchor is what keeps the entry alive past the ORIGINAL TTL',
  )
  assert.equal(
    sweepPendingWorkspaces(first, pastTheFirstAnchor)['ssh-b'],
    undefined,
    'control: the un-refreshed anchor would have expired at that same clock',
  )
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

test('withWorkspaceEcho: an anchored creation lands right after its anchor, never at the tail', () => {
  // 2026-12 第二入口（Git worktree create）：宿主把新 worktree 摆在其主 checkout
  // 之后（coordinator 的 insertWorkspaceBefore），投影必须同序——否则该行先出现
  // 在列表末尾、挂载收敛时再跳上去；design 08 §3.3 的连续家族不变式正是按
  // 渲染序成立的（拖拽裁决器读它）。
  const base = aggregate([realWorkspace('main', '/repo'), realWorkspace('other', '/other')])
  const ledger = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'wt', path: '/wt/feat', afterWorkspaceId: 'main' }, 1_000)
  const next = withWorkspaceEcho(base, ledger['ssh-b'])
  assert.deepEqual(next.workspaces.map(row => row.workspaceId), ['main', 'wt', 'other'])
})

test('withWorkspaceEcho: repeated anchors keep ledger order, an unknown anchor degrades to the tail', () => {
  let ledger = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'wt1', path: '/wt/a', afterWorkspaceId: 'main' }, 1)
  ledger = recordPendingWorkspace(ledger, 'ssh-b', { workspaceId: 'wt2', path: '/wt/b', afterWorkspaceId: 'main' }, 2)
  const ordered = withWorkspaceEcho(
    aggregate([realWorkspace('main', '/repo'), realWorkspace('other', '/other')]),
    ledger['ssh-b'],
  )
  assert.deepEqual(ordered.workspaces.map(row => row.workspaceId), ['main', 'wt1', 'wt2', 'other'])
  const orphan = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'wt3', path: '/wt/c', afterWorkspaceId: 'gone' }, 3)
  const fallback = withWorkspaceEcho(aggregate([realWorkspace('main', '/repo')]), orphan['ssh-b'])
  assert.deepEqual(fallback.workspaces.map(row => row.workspaceId), ['main', 'wt3'], 'an unknown anchor must not drop the row')
})

test('withWorkspaceEcho: interleaved anchors place each block after its own row', () => {
  // 真机可达形态：同一来源有两个仓库，用户交替给各自的主 checkout 新建 worktree。
  // 旧实现用"上次插入下标"做游标，另一次插入会把游标顶偏，第三个条目因此落到第
  // 一个条目之前（顺序错乱）。这里钉住：每个锚点独立定位、块内保持账本序。
  const base = aggregate([realWorkspace('main-a', '/repo-a'), realWorkspace('main-b', '/repo-b')])
  let ledger = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'e1', path: '/a/1', afterWorkspaceId: 'main-b' }, 1)
  ledger = recordPendingWorkspace(ledger, 'ssh-b', { workspaceId: 'e2', path: '/b/2', afterWorkspaceId: 'main-a' }, 2)
  ledger = recordPendingWorkspace(ledger, 'ssh-b', { workspaceId: 'e3', path: '/a/3', afterWorkspaceId: 'main-b' }, 3)
  const next = withWorkspaceEcho(base, ledger['ssh-b'])
  assert.deepEqual(next.workspaces.map(row => row.workspaceId), ['main-a', 'e2', 'main-b', 'e1', 'e3'])
})

test('recordPendingWorkspace: the anchor is sparse — an anchor-less create keeps the pre-anchor entry shape', () => {
  const plain = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'w1', path: '/p/a' }, 1)
  assert.equal('afterWorkspaceId' in (plain['ssh-b']?.[0] ?? {}), false)
  const anchored = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'w1', path: '/p/a', afterWorkspaceId: 'main' }, 1)
  assert.equal(anchored['ssh-b']?.[0]?.afterWorkspaceId, 'main')
})

test('withWorkspaceEcho: a same-path synthetic group is REPLACED in place by the real id (never two rows)', () => {
  const base = aggregate([syntheticGroup('/p/a', ['s1']), realWorkspace('w9', '/p/other')])
  const next = withWorkspaceEcho(base, [pending('w1', '/p/a')])
  assert.deepEqual(next.workspaces.map(row => row.workspaceId), ['w1', 'w9'], 'the synthetic slot is reused (no jump)')
  assert.equal(next.workspaces[0]?.synthetic, undefined)
  // B1 (2026-09-11 review): the replacement carries the replaced group's
  // MEMBERSHIP. Sessions reach a group only through `workspace.sessionIds`
  // (derive.ts), so an echo row with `sessionIds: []` dropped the directory's
  // sessions into 未分组 for the echo's whole 10-minute TTL.
  assert.deepEqual(next.workspaces[0]?.sessionIds, ['s1'], 'the replaced synthetic row keeps its members')
})

test('withWorkspaceEcho: a session-carrying aggregate keeps that session in the echoed group (no 未分组 detour)', () => {
  const base = aggregate(
    [syntheticGroup('/p/a', ['s1']), realWorkspace('w9', '/p/other')],
    'ok',
    [sessionRow('s1', '/p/a')],
  )
  const groups = deriveServerWorkspaces(
    withWorkspaceEcho(base, [pending('w1', '/p/a')]),
    'ssh-b',
    '未分组',
    undefined,
    1_000,
  )
  assert.deepEqual(groups.map(group => group.id), ['w1', 'w9'], 'exactly one group per directory')
  assert.deepEqual(groups[0]?.sessions.map(session => session.id), ['s1'], 'the session stays in its directory group')
  assert.equal(
    groups.some(group => group.ungrouped === true),
    false,
    'no 未分组 bucket: the membership survived the identity swap',
  )
})

test('withWorkspaceEcho: synthetic replacement outranks the anchor (the directory never jumps)', () => {
  // 两条位置规则同时命中时的优先级：同 path 合成组被**原位替换**（design 05
  // §2.2.1 既有规则，目录不跳动），锚点只对"新增行"生效。测试里合成组刻意放在
  // 尾部：锚点若生效，wt 会插到 main 之后——期望它在原位（other 之后）。
  const base = aggregate([
    realWorkspace('main', '/repo'),
    realWorkspace('other', '/other'),
    syntheticGroup('/wt/feat', ['s1']),
  ])
  const ledger = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'wt', path: '/wt/feat', afterWorkspaceId: 'main' }, 1_000)
  const next = withWorkspaceEcho(base, ledger['ssh-b'])
  assert.deepEqual(next.workspaces.map(row => row.workspaceId), ['main', 'other', 'wt'])
  assert.deepEqual(next.workspaces[2]?.sessionIds, ['s1'], 'the replaced group keeps its members')
})

test('withWorkspaceEcho: canonical-path matching means a trailing separator cannot render the directory twice', () => {
  // The create path is host-CANONICAL, the synthetic group's path is a session
  // cwd spelling: `canonicalPathKey` is what lets the replacement fire instead
  // of appending a second row for the same directory.
  const base = aggregate([syntheticGroup('/p/a/', ['s1'])])
  const next = withWorkspaceEcho(base, [pending('w1', '/p/a')])
  assert.deepEqual(next.workspaces.map(row => row.workspaceId), ['w1'], 'one row for the directory, not two')
  assert.deepEqual(next.workspaces[0]?.sessionIds, ['s1'])
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

test('removePendingWorkspace: a delete retires the echo by host id, identity-preserving when nothing matches', () => {
  // 2026-09-11 review S3 (the withdraw half): an unmounted source's baseline
  // never lists the workspace, so `reconcilePendingWorkspaces` cannot match it —
  // without this fact the deleted row stayed a GHOST with real-id actions
  // enabled until the TTL.
  const ledger: WorkspaceEchoLedger = {
    'ssh-b': [pending('w1', '/p/a'), pending('w2', '/p/b')],
    'ssh-c': [pending('w9', '/p/z')],
  }
  // An unmounted source has no path to publish (the sidebar projection carries
  // none): the id match alone must retire the row.
  const removed = removePendingWorkspace(ledger, 'ssh-b', { workspaceId: 'w1', path: '' })
  assert.deepEqual(removed['ssh-b'], [pending('w2', '/p/b')], 'only the matching id is retired')
  assert.equal(removed['ssh-c'], ledger['ssh-c'], 'other sources keep their entries by reference')
  assert.equal(
    removePendingWorkspace(ledger, 'ssh-b', { workspaceId: 'w-unknown', path: '' }),
    ledger,
    'nothing matched → identity (the publish signature gate must stay quiet)',
  )
  assert.equal(removePendingWorkspace(ledger, 'ssh-missing', { workspaceId: 'w1', path: '/p/a' }), ledger)
  const emptied = removePendingWorkspace({ 'ssh-b': [pending('w1', '/p/a')] }, 'ssh-b', { workspaceId: 'w1', path: '/p/a' })
  assert.deepEqual(emptied, {}, 'the emptied source key is dropped, not left as an empty array')
})

test('removePendingWorkspace: the canonical path matches too (trailing separator), and an empty path never does', () => {
  const ledger: WorkspaceEchoLedger = { 'ssh-b': [pending('w1', '/p/a')] }
  assert.deepEqual(removePendingWorkspace(ledger, 'ssh-b', { workspaceId: 'w-other', path: '/p/a/' }), {})
  // `path: ''` means "the caller does not know the path" — it must not be read
  // as a path that matches some other unknown-path row.
  const unknownPaths: WorkspaceEchoLedger = { 'ssh-b': [pending('w1', ''), pending('w2', '/p/b')] }
  const next = removePendingWorkspace(unknownPaths, 'ssh-b', { workspaceId: 'w-other', path: '' })
  assert.deepEqual(next['ssh-b'], [pending('w1', ''), pending('w2', '/p/b')], 'an empty path carries no match')
})

test('removePendingWorkspace: the removal fact retires a create → delete ghost even when the baseline omits it', () => {
  // The exact reviewed sequence: create (echo lands), delete, then an
  // authoritative push that does NOT list the workspace (the host registration
  // is gone — an unmounted source, or a baseline that never carried it). The
  // reconcile pass keeps the echo by design, so only the removal fact can
  // retire it.
  const created = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'w1', path: '/p/a' }, 1_000)
  const afterDelete = removePendingWorkspace(created, 'ssh-b', { workspaceId: 'w1', path: '/p/a' })
  const afterPush = reconcilePendingWorkspaces(afterDelete, 'ssh-b', [realWorkspace('other', '/p/other')])
  assert.equal(afterPush, afterDelete, 'the push alone cannot retire this echo — it must already be gone')
  assert.deepEqual(afterPush, {}, 'no ghost row survives the delete')
  const projection = withWorkspaceEcho(aggregate([realWorkspace('other', '/p/other')]), afterPush['ssh-b'])
  assert.deepEqual(projection.workspaces.map(row => row.workspaceId), ['other'], 'the deleted directory is not rendered')
})

test('renamePendingWorkspace: patches the echo title, identity-preserving when the id is absent or the title matches', () => {
  const ledger: WorkspaceEchoLedger = {
    'ssh-b': [pending('w1', '/p/a'), pending('w2', '/p/b')],
    'ssh-c': [pending('w9', '/p/z')],
  }
  const renamed = renamePendingWorkspace(ledger, 'ssh-b', 'w1', '我的项目')
  assert.deepEqual(renamed['ssh-b'], [{ ...pending('w1', '/p/a'), title: '我的项目' }, pending('w2', '/p/b')])
  assert.equal(renamed['ssh-c'], ledger['ssh-c'])
  assert.equal(ledger['ssh-b']?.[0]?.title, 'a', 'the input ledger is never mutated')
  assert.equal(
    renamePendingWorkspace(ledger, 'ssh-b', 'w-unknown', 'x'),
    ledger,
    'an absent id changes nothing (identity)',
  )
  assert.equal(
    renamePendingWorkspace(renamed, 'ssh-b', 'w1', '我的项目'),
    renamed,
    'the title already matches → identity, no needless publish',
  )
  assert.equal(renamePendingWorkspace(ledger, 'ssh-missing', 'w1', 'x'), ledger)
})

test('integration: the rename fact patches the row the user sees before the source mounts', () => {
  const created = recordPendingWorkspace({}, 'ssh-b', { workspaceId: 'w1', path: '/p/a' }, 1_000)
  const renamed = renamePendingWorkspace(created, 'ssh-b', 'w1', '项目 A')
  const groups = deriveServerWorkspaces(
    withWorkspaceEcho(aggregate([]), renamed['ssh-b']),
    'ssh-b',
    '未分组',
    undefined,
    1_000,
  )
  assert.deepEqual(groups.map(group => group.title), ['项目 A'], 'the path basename is not re-derived over the rename')
})

test('wiring: the single funnel publishes every workspace fact right after its wire call', () => {
  // Source-text contract (the package's `probe-*.test.ts` / `panel-wiring.ts`
  // precedent): these publishes are silent no-ops when they go missing — the
  // pure helpers above would then never be called and the reviewed
  // invisible-row/ghost/no-op bugs return. 2026-09-11 review S3.
  //
  // 2026-12 收口（第二入口真机反馈）：事实不再由每个调用点各发一次，而是由
  // shared/workspace-mutations.ts 的单一出口随 wire 调用发布。逐点发布正是
  // Git worktree create/adopt sage 漏发、行要等用户点开那个服务器才出现的成因。
  const funnel = readFileSync(new URL('../src/shared/workspace-mutations.ts', import.meta.url), 'utf8')
  const code = funnel.replace(/\s+/g, ' ')
  const createWire = code.indexOf('await createWorkspace(getInstanceClient(sourceId), path)')
  const decorate = code.indexOf('try { options.beforePublish(created) } catch (error) {')
  const createdFact = code.indexOf('chamberBridge.reportWorkspaceCreated({')
  assert.notEqual(createWire, -1, 'the create funnel performs the wire call')
  assert.notEqual(decorate, -1, 'the pre-publish decoration hook must stay (Git worktree shape facts, abort-proof)')
  assert.ok(createdFact > decorate, 'decorations run BEFORE the fact: the echoed row must be born in its final shape')
  assert.ok(createdFact > createWire, 'the create fact is published only after the host accepted the create')
  assert.match(code, /afterWorkspaceId: options\.afterWorkspaceId/, 'the placement anchor rides the fact (Git worktree sits below its main checkout)')
  const deleteWire = code.indexOf('await deleteWorkspace(getInstanceClient(sourceId), workspaceId)')
  const removedFact = code.indexOf('chamberBridge.reportWorkspaceRemoved({ sourceId, workspaceId, path })')
  assert.notEqual(deleteWire, -1, 'the delete funnel performs the wire call')
  assert.ok(removedFact > deleteWire, 'the removal fact is published only after the host accepted the delete')
  const renameWire = code.indexOf('await renameWorkspace(getInstanceClient(sourceId), workspaceId, title)')
  const renamedFact = code.indexOf('chamberBridge.reportWorkspaceRenamed({ sourceId, workspaceId, title })')
  assert.notEqual(renameWire, -1, 'the rename funnel performs the wire call')
  assert.ok(renamedFact > renameWire, 'the rename fact is published only after the host accepted the rename')

  // The sidebar's three call sites go THROUGH the funnel and publish nothing
  // themselves — one producer per fact, so no future entry point can forget.
  // 2026-09-11 upstream-alignment T2b: the delete call lives in the ACCEPTED
  // in-app confirm (the armed subject is `deleteTarget`, addressed through its
  // own `target` fields) — the ordering contract is unchanged, and the extra
  // assertion pins that nothing deletes before the user accepts.
  const sidebar = readFileSync(new URL('../src/client/SidebarRoot.tsx', import.meta.url), 'utf8')
  const root = sidebar.replace(/\s+/g, ' ')
  const acceptAt = root.indexOf('const confirmDeleteWorkspace = ()')
  const deleteAt = root.indexOf('await deleteWorkspaceForSource(target.sourceId, target.workspaceId, path)')
  assert.notEqual(acceptAt, -1, 'the accepted-confirm handler must exist')
  assert.notEqual(deleteAt, -1, 'the delete must go through the funnel')
  assert.ok(deleteAt > acceptAt, 'the delete must run only inside the accepted confirm (never at arm time)')
  assert.ok(
    root.indexOf('chamberBridge.requestRefresh(target.sourceId)', deleteAt) > deleteAt,
    'the refresh that owns every other row stays',
  )
  const renameAt = root.indexOf('await renameWorkspaceForSource(target.sourceId, target.id, target.value)')
  assert.notEqual(renameAt, -1, 'the workspace rename must go through the funnel')
  assert.ok(
    root.indexOf('chamberBridge.requestRefresh(target.sourceId)', renameAt) > renameAt,
    'the shared rename path keeps its refresh for both kinds',
  )
  assert.notEqual(root.indexOf('createWorkspaceForSource(sourceId, path)'), -1, 'the add-workspace dialog must go through the funnel')
  assert.doesNotMatch(root, /chamberBridge\.reportWorkspace(Created|Removed|Renamed)/, 'no call site publishes the facts itself')
})
