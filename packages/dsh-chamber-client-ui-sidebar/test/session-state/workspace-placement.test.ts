/**
 * workspace-placement.ts unit tests (plain node:test, no dsh, no DOM): the PRE-CREATE half of
 * "新建工作区应立刻可见" (design 05 §2.2 revision).
 *
 * The contract: the host `workspace.create` PREPENDS into the registry order and takes no position,
 * so on a mounted source the authoritative push renders a new worktree at the list HEAD before the
 * create (and any id-keyed echo) exists — these cases pin that the intent holds the row at its
 * anchor from that first frame, that the ledger NEVER invents or loses a row, that it only corrects
 * the create-prepend transient (the head), and that every path out — the authoritative order moving
 * the row, anchor loss, delete, source retirement, TTL — retires or drops the entry. Identity
 * preservation is checked explicitly (the projection publish is signature-gated). The last case is
 * a source-text wiring lock: the funnel, the App and the projection chain cannot be imported by a
 * node test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  forgetPendingPlacements,
  reconcilePendingPlacements,
  recordWorkspacePlacement,
  removePendingPlacement,
  removeUnclaimedPlacements,
  sweepPendingPlacements,
  withWorkspacePlacements,
  type PendingWorkspacePlacement,
  type WorkspacePlacementLedger,
} from '@dsh-chamber/dsh-chamber-client-core'
import { PENDING_PLACEMENT_TTL_MS } from '../../../dsh-chamber-client-core/src/workspace-placement.ts'
import type { InstanceAggregate, SessionRow, WorkspaceRow } from '@dsh-chamber/dsh-chamber-client-core/instance-api'

function row(workspaceId: string, path: string): WorkspaceRow {
  return { workspaceId, path, title: workspaceId, sessionIds: [], createdAt: '', updatedAt: '' }
}

function aggregate(workspaces: WorkspaceRow[], state: InstanceAggregate['state'] = 'ok'): InstanceAggregate {
  const sessions: SessionRow[] = []
  return { state, workspaces, sessions, archivedSessionIds: [], archiveSetKnown: state === 'ok', error: null }
}

const pending: readonly PendingWorkspacePlacement[] = [{ path: '/repo/wt', afterWorkspaceId: 'main', at: 1 }]

test('the create-prepend transient is corrected: the row renders at its anchor from the first frame', () => {
  const before = aggregate([
    row('wt', '/repo/wt'),
    row('other', '/other'),
    row('main', '/repo'),
    row('tail', '/tail'),
  ])
  const after = withWorkspacePlacements(before, pending)
  assert.deepEqual(after.workspaces.map(entry => entry.workspaceId), ['other', 'main', 'wt', 'tail'])
  assert.deepEqual(before.workspaces.map(entry => entry.workspaceId), ['wt', 'other', 'main', 'tail'], 'the aggregate is never mutated')
})

test('only the list HEAD is corrected: an authoritative position other than the prepend wins', () => {
  // The host appended the row (anchor resolution failed in the saga) — the intent must not drag a
  // row the authority has already placed somewhere else.
  const appended = aggregate([row('other', '/other'), row('main', '/repo'), row('wt', '/repo/wt')])
  assert.equal(withWorkspacePlacements(appended, pending), appended, 'identity preserved, no move')
})

test('the projection is identity-preserving whenever no intent applies', () => {
  const placed = aggregate([row('main', '/repo'), row('wt', '/repo/wt')])
  assert.equal(withWorkspacePlacements(placed, pending), placed, 'already immediately after its anchor')
  const elsewhere = aggregate([row('other', '/other'), row('main', '/repo')])
  assert.equal(withWorkspacePlacements(elsewhere, pending), elsewhere, 'the row is not listed at all')
  assert.equal(withWorkspacePlacements(placed, undefined), placed, 'no ledger slice for this source')
  assert.equal(withWorkspacePlacements(placed, []), placed, 'empty ledger')
})

test('a missing anchor is a no-op, never a lost or reordered row', () => {
  const before = aggregate([row('wt', '/repo/wt'), row('other', '/other')])
  assert.equal(withWorkspacePlacements(before, pending), before)
})

test('the ledger matches by host id once the create answered, by canonical path before that', () => {
  const upgraded: readonly PendingWorkspacePlacement[] = [
    { path: '/repo/wt', afterWorkspaceId: 'main', workspaceId: 'host-id', at: 1 },
  ]
  const before = aggregate([row('host-id', '/private/repo/wt'), row('main', '/repo')])
  const after = withWorkspacePlacements(before, upgraded)
  assert.deepEqual(after.workspaces.map(entry => entry.workspaceId), ['main', 'host-id'],
    'the id match survives a host-canonicalized path')
})

test('one entry per action: the pre-create record is upgraded in place and refreshes its TTL', () => {
  let ledger: WorkspacePlacementLedger = {}
  ledger = recordWorkspacePlacement(ledger, 's', { path: '/repo/wt', afterWorkspaceId: 'main' }, 1_000)
  ledger = recordWorkspacePlacement(ledger, 's', { path: '/repo/wt', afterWorkspaceId: 'main' }, 2_000)
  assert.equal(ledger.s?.length, 1, 'a re-record replaces instead of stacking')
  assert.equal(ledger.s?.[0]?.at, 2_000, 'the TTL anchor is refreshed')
  ledger = recordWorkspacePlacement(ledger, 's', { path: '/repo/wt', afterWorkspaceId: 'main', workspaceId: 'host-id' }, 3_000)
  assert.equal(ledger.s?.length, 1, 'the id-keyed upgrade is the same action')
  assert.equal(ledger.s?.[0]?.workspaceId, 'host-id')
  assert.equal(ledger.s?.[0]?.at, 3_000)
  // A host-canonicalized path (symlink resolution) cannot match the pre-create key, so the upgrade
  // lands as a SECOND entry for the same row: the id match does the holding and the path-keyed one
  // stays a projection no-op until its TTL — documented, bounded, never a duplicate row.
  ledger = recordWorkspacePlacement(ledger, 's', { path: '/private/repo/wt', afterWorkspaceId: 'main', workspaceId: 'host-id-2' }, 4_000)
  assert.equal(ledger.s?.length, 2)
  assert.equal(ledger.s?.[1]?.workspaceId, 'host-id-2')
})

test('retirement: the intent lives until the authoritative order moves the row off the head', () => {
  const ledger = recordWorkspacePlacement({}, 's', { path: '/repo/wt', afterWorkspaceId: 'main' }, 1_000)
  const head = [row('wt', '/repo/wt'), row('main', '/repo')]
  assert.equal(reconcilePendingPlacements(ledger, 's', head), ledger, 'still the head = still correcting')
  const notListed = [row('main', '/repo')]
  assert.equal(reconcilePendingPlacements(ledger, 's', notListed), ledger, 'not listed yet = the job is ahead')
  const moved = [row('other', '/other'), row('main', '/repo'), row('wt', '/repo/wt')]
  assert.deepEqual(reconcilePendingPlacements(ledger, 's', moved), {}, 'off the head = the host order moved on')
  const anchorless = [row('wt', '/repo/wt'), row('other', '/other')]
  assert.deepEqual(reconcilePendingPlacements(ledger, 's', anchorless), {}, 'no anchor left to hold the row below')
  assert.equal(reconcilePendingPlacements(ledger, 'other-source', head), ledger, 'per-source')
})

test('升级后的 id 键条目同样按位置退休：宿主路径拼写分歧不影响判定', () => {
  const upgraded = recordWorkspacePlacement({}, 's',
    { path: '/repo/wt', afterWorkspaceId: 'main', workspaceId: 'host-wt' }, 1_000)
  const stillHead = [row('host-wt', '/private/repo/wt'), row('main', '/repo')]
  assert.equal(reconcilePendingPlacements(upgraded, 's', stillHead), upgraded,
    'id 匹配让拼写分歧的宿主 realpath 不影响"仍在头部"的判定；身份保持')
  const moved = [row('other', '/other'), row('main', '/repo'), row('host-wt', '/private/repo/wt')]
  assert.deepEqual(reconcilePendingPlacements(upgraded, 's', moved), {},
    '行被权威序放到别处 ⇒ 退休（id 键不依赖路径写法）')
  assert.deepEqual(reconcilePendingPlacements(upgraded, 's', [row('host-wt', '/private/repo/wt')]), {},
    '锚点消失同样退休')
})

test('合成"未分组"桶在首位时不充当头部：真实头部决定纠正与否', () => {
  const bucket: WorkspaceRow = { ...row('ungrouped', '/ungrouped'), synthetic: true }
  const withBucket = aggregate([bucket, row('wt', '/repo/wt'), row('main', '/repo')])
  assert.deepEqual(withWorkspacePlacements(withBucket, pending).workspaces.map(w => w.workspaceId),
    ['ungrouped', 'main', 'wt'], '合成桶留在原位，真实头部（wt）照常被搬到锚点后')
  const allSynthetic = aggregate([bucket])
  assert.equal(withWorkspacePlacements(allSynthetic, pending), allSynthetic,
    '没有真实行 ⇒ 原样返回（身份保持，绝不发明行）')
})

test('一次投影只纠正一行：同来源两个带锚点意图时第二行等下一次聚合变更', () => {
  const two: readonly PendingWorkspacePlacement[] = [
    { path: '/repo/a', afterWorkspaceId: 'main', at: 1 },
    { path: '/repo/b', afterWorkspaceId: 'main', at: 2 },
  ]
  const first = aggregate([row('A', '/repo/a'), row('B', '/repo/b'), row('main', '/repo')])
  assert.deepEqual(withWorkspacePlacements(first, two).workspaces.map(w => w.workspaceId),
    ['B', 'main', 'A'],
    '只有"原本就是真实头部"的那一行被搬——已登记的边界（UI 的 source.busy 门让该形态实际不可达）')
  const second = aggregate([row('B', '/repo/b'), row('main', '/repo'), row('A', '/repo/a')])
  assert.deepEqual(withWorkspacePlacements(second, two).workspaces.map(w => w.workspaceId),
    ['main', 'B', 'A'], '下一次聚合变更后 B 成为头部 ⇒ 同样被纠正；两行最终都到位')
})

test('withdrawal, TTL and source retirement are the other three ways out', () => {
  let ledger = recordWorkspacePlacement({}, 's', { path: '/repo/wt', afterWorkspaceId: 'main', workspaceId: 'host-id' }, 1_000)
  assert.deepEqual(removePendingPlacement(ledger, 's', { workspaceId: 'host-id' }), {}, 'by host id')
  ledger = recordWorkspacePlacement({}, 's', { path: '/repo/wt', afterWorkspaceId: 'main' }, 1_000)
  assert.deepEqual(removePendingPlacement(ledger, 's', { path: '/repo/wt' }), {}, 'by canonical path')
  assert.deepEqual(removePendingPlacement(ledger, 's', { workspaceId: 'other', path: '/other' }), ledger,
    'identity preserved when nothing matches (the path-keyed entry carries no host id yet)')
  assert.equal(sweepPendingPlacements(ledger, 1_000 + PENDING_PLACEMENT_TTL_MS - 1), ledger, 'inside the TTL')
  assert.deepEqual(sweepPendingPlacements(ledger, 1_000 + PENDING_PLACEMENT_TTL_MS), {}, 'at the TTL')
  assert.deepEqual(forgetPendingPlacements(ledger, new Set(['s'])), {}, 'source leave')
  assert.equal(forgetPendingPlacements(ledger, new Set(['other'])), ledger, 'identity preserved')
})

test('the tail anchor puts the row at the end from the first frame (no-main adopt)', () => {
  // 主 checkout 未注册时 adopt 的宿主落点是**尾部**（insertBefore(id, undefined)），锚点因此取
  // "当前最后一个 workspace"：投影与宿主收敛到同一处，不再"最顶端入场再滑到尾部"。
  const tailAnchor: readonly PendingWorkspacePlacement[] =
    [{ path: '/repo/wt', afterWorkspaceId: 'last', at: 1 }]
  const before = aggregate([row('wt', '/repo/wt'), row('first', '/a'), row('last', '/z')])
  assert.deepEqual(
    withWorkspacePlacements(before, tailAnchor).workspaces.map(w => w.workspaceId),
    ['first', 'last', 'wt'],
  )
  // 已就位（权威序已是尾部）时不复制、不重排：
  const settled = aggregate([row('first', '/a'), row('last', '/z'), row('wt', '/repo/wt')])
  assert.equal(withWorkspacePlacements(settled, tailAnchor), settled)
})

test('unclaimed intents are dropped when a create answers WITHOUT an anchor', () => {
  // 拼写分歧留下的路径条目既认领不到 id、也退不掉 ⇒ 无锚创建（宿主序即最终序）必须清掉它，
  // 否则它会认领同路径的下一次创建并把新行搬到旧锚点后。
  const ledger: WorkspacePlacementLedger = {
    s1: [
      { path: '/repo/wt', afterWorkspaceId: 'main', at: 1 },
      { path: '/repo/wt2', afterWorkspaceId: 'main', workspaceId: 'wt2', at: 1 },
    ],
  }
  const cleaned = removeUnclaimedPlacements(ledger, 's1')
  assert.deepEqual(cleaned.s1, [{ path: '/repo/wt2', afterWorkspaceId: 'main', workspaceId: 'wt2', at: 1 }])
  // 只动该来源 + 只动未被认领的条目；无匹配时保持同一引用。
  assert.equal(removeUnclaimedPlacements(cleaned, 's1'), cleaned)
  assert.equal(removeUnclaimedPlacements(cleaned, 's2'), cleaned)
})

test('an empty authoritative list is not evidence that the anchor is gone', () => {
  // 部分/瞬时基线下判不了 ⇒ 保留（TTL 兜底）；非空列表里锚点缺席才算锚点消失。
  const ledger: WorkspacePlacementLedger = { s1: [{ path: '/repo/wt', afterWorkspaceId: 'main', at: 1 }] }
  assert.equal(reconcilePendingPlacements(ledger, 's1', []), ledger)
  assert.deepEqual(reconcilePendingPlacements(ledger, 's1', [row('a', '/a')]).s1, undefined)
})

test('a failed reposition voids the intent from the failure side only', () => {
  // 失败侧由 Git 插件发布作废事实（宿主序即最终序）；成功侧不发——位置判据收敛在位置已正确的
  // 那一帧，发 settle 反而会与权威 push 抢时序、把行先放回头部。
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\s+/g, ' ')
  const coordinator = read('../../../dsh-chamber-client-ui-git/src/shared/coordinator.ts')
  const failures = coordinator.match(/chamberBridge\.reportWorkspacePlacementFailed\(\{\s*sourceId, workspaceId: result\.workspaceId, path: result\.path,? \}\)/gu) ?? []
  assert.equal(failures.length, 2, 'create + adopt reposition catch blocks void the intent')
  const afterLog = coordinator.split('reposition failed (best-effort):')
  assert.equal(afterLog.length - 1, 2, 'exactly the two best-effort catch logs')
  for (const tail of afterLog.slice(1)) {
    assert.match(tail.slice(0, 240), /reportWorkspacePlacementFailed\(\{/u,
      'each failure log voids the intent right there (the success path has no such log)')
  }
  // 第三处 = create saga 的重排之前中止（create 可能没提交 ⇒ 请求路径是基本键；恢复记录带得出宿主 id 时一并带上，否则回声升级成宿主 realpath 后拼写分歧退不掉）。它也必须在 saga 的失败处理之前、且只在失败侧。
  // 在 saga 的失败处理之前、且只在失败侧。
  assert.match(coordinator,
    /reportWorkspacePlacementFailed\(\{ sourceId, path: preview\.targetPath, \.\.\.\(workspaceId === undefined.{0,160}?if \(error instanceof GitSagaError\)/u,
    'the saga abort voids the intent before the recovery bookkeeping')
  // 第四处 = adopt saga 的中止 catch（workspace 已建、session.create 失败，重排不会再来）：
  // 恢复记录只有 session-create 变体带宿主 id，其它情况按请求路径作键。
  assert.match(coordinator,
    /reportWorkspacePlacementFailed\(\{ sourceId, path, \.\.\.\(workspaceId === undefined/u,
    'the adopt saga abort voids the intent too')
  assert.match(coordinator, /function placementVoidWorkspaceId\(error: unknown\): string \| undefined/u,
    'both saga aborts resolve the host id through one helper (recovery-record kinds, not a single kind)')
  assert.equal(coordinator.match(/placementVoidWorkspaceId\(error\)/gu)?.length, 2,
    'create 与 adopt 两个中止 catch 都经它取宿主 id（只按请求路径会退不掉已升级的 id 键条目）')
  assert.equal(coordinator.match(/reportWorkspacePlacementFailed\(/gu)?.length, 4,
    'exactly the four failure-side sites publish it — the success path never does')
  const subscriptions = read('../../../renderer/src/app-hooks/use-bridge-subscriptions.ts')
  assert.match(subscriptions, /chamberBridge\.onWorkspacePlacementFailed\(/, 'the App voids the entry')
  assert.match(subscriptions, /removePendingPlacement\(/, 'through the ledger withdrawal combinator')
})

test('wiring: the intent is published before the wire, consumed by the App, applied in the projection', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\s+/g, ' ')
  const funnel = read('../../../dsh-chamber-client-core/src/workspace-mutations.ts')
  const intentAt = funnel.indexOf('chamberBridge.reportWorkspacePlacement({')
  const wireAt = funnel.indexOf('await createWorkspace(getInstanceClient(sourceId), path)')
  assert.notEqual(intentAt, -1, 'the funnel publishes the intent (every create site is covered by one producer)')
  assert.ok(intentAt < wireAt, 'BEFORE the wire: the mounted push renders the row before the create answers')
  const subscriptions = read('../../../renderer/src/app-hooks/use-bridge-subscriptions.ts')
  assert.match(subscriptions, /chamberBridge\.onWorkspacePlacement\(/, 'the App records intents')
  assert.match(subscriptions, /reconcilePendingPlacements\(/, 'the mounted push is the convergence point')
  assert.match(subscriptions, /removeUnclaimedPlacements\(/,
    'a no-anchor create drops the unclaimed entries — the spelling-divergence twin\'s only routine retirement')
  const servers = read('../../../renderer/src/host/servers.ts')
  assert.match(servers, /withWorkspacePlacements\(/, 'the single projection pass applies the hold')
  // 缓存键分量不在这里锁：行为测在 renderer/test/aggregate/servers-projection-cache.test.ts
  // （"the placement ledger is a cache-key component"），源文本锁只会多一条跨包耦合。
})
