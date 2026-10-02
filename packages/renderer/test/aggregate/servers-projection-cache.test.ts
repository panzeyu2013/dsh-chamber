/**
 * 服务器投影缓存（性能 A1/A2）回归面：
 *  - 签名片段缓存与纯函数逐字节一致；remember 只对"发布的那一个数组"生效；
 *  - deriveServers 按来源缓存：输入身份不变即复用同一条目，只有变化的来源换对象；
 *  - TTL 到期即重算（按 now 判定的时间分支兜底）；来源消失即释放缓存条目。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cachedServersProjectionSignature,
  createChamberProjectionSignatureCache,
  rememberServersProjectionSignature,
  serversProjectionSignature,
  type ChamberServerAggregate,
  type InstanceAggregate,
  type WorkspacePlacementLedger,
  type WorkspaceRemovalLedger,
} from '@dsh-chamber/dsh-chamber-client-core'
import { createServerProjectionCache, deriveServers, type ServerProjectionCache } from '../../src/host/servers.ts'
import { sourceIdForInstance } from '../../src/transport-source.ts'
import type { HealthResponse } from '../../src/api.ts'
import type { SessionFactsRow, SessionFactsSnapshot } from '../../src/session-facts-source.ts'
import type { SshInstanceSpec, SshStatusProjection } from '../../src/global.d.ts'

const READY_HEALTH = { dsh: { status: 'ready' } } as unknown as HealthResponse

const instance: SshInstanceSpec = {
  id: 'r1', label: 'R1', kind: 'dsh', transport: 'ssh', host: 'h', user: null, sshPort: null,
  remotePort: 1, serviceName: null, remoteDshHome: null, sourceFingerprint: 'b'.repeat(64),
  insecureHttp: false,
}

/** instanceConnected 只读 kind + phase，但投影类型要求全字段，故给一份完整的 ready 投影。 */
const readyStatus: SshStatusProjection = {
  kind: 'dsh', transport: 'ssh', insecureHttp: false, phase: 'ready', localPort: null, sshPort: null,
  remotePort: 1, remoteDshHome: null, retryAttempt: 0, requiresUserAction: false, userActionKind: null,
  serviceActive: null, logSummary: '',
}

/** 一个真实工作区 + 一行会话的 ok 聚合；换 title/updatedAt 即换内容，换对象即换身份。 */
function aggregate(title: string, sessionUpdatedAt = 5): InstanceAggregate {
  return {
    state: 'ok', error: null, archiveSetKnown: true, archivedSessionIds: [],
    workspaces: [{ workspaceId: 'w1', path: '/w1', title, sessionIds: ['s1'], createdAt: '', updatedAt: '' }],
    sessions: [{ sessionId: 's1', title: 'One', displayTitle: 'One', running: false, blank: false, updatedAt: sessionUpdatedAt }],
  }
}

interface Fixture {
  remoteInstances: SshInstanceSpec[]
  aggregates: Record<string, InstanceAggregate>
  remoteStatus: Record<string, SshStatusProjection>
}

/** 远端 aggregate 按 source id（dsh-r1）键控，不是原始实例 id——deriveServers 读的是前者。 */
const REMOTE_SOURCE_ID = sourceIdForInstance(instance)

function fixture(): Fixture {
  return {
    remoteInstances: [instance],
    aggregates: { local: aggregate('Local'), [REMOTE_SOURCE_ID]: aggregate('Remote') },
    remoteStatus: { r1: readyStatus },
  }
}

function derive(f: Fixture, cache?: ServerProjectionCache): ChamberServerAggregate[] {
  return deriveServers(READY_HEALTH, [], f.remoteInstances, f.remoteStatus, f.aggregates,
    {}, {}, {}, 'local', {}, {}, {}, {}, {}, {}, {}, 'zh', {}, cache)
}

test('projection cache: deriveServers reuses unchanged sources and rebuilds only the changed one', () => {
  const f = fixture()
  const cache = createServerProjectionCache()
  const first = derive(f, cache)
  assert.equal(first.length, 2)
  assert.ok(first.every(server => server.connected), 'fixture must be connected so rows are actually derived')
  const second = derive(f, cache)
  assert.equal(second[0], first[0], 'unchanged local entry reuses the same object')
  assert.equal(second[1], first[1], 'unchanged remote entry reuses the same object')

  // store 的真实语义只有变化的来源换对象；原地突变聚合记录本身不算（记录只读）。
  f.aggregates[REMOTE_SOURCE_ID] = aggregate('Remote', 9)
  const third = derive(f, cache)
  assert.equal(third[0], first[0], 'untouched source keeps its identity')
  assert.notEqual(third[1], first[1], 'the changed source is rebuilt')
})

test('projection cache: identity churn with equal content still yields one signature', () => {
  const f = fixture()
  const cache = createServerProjectionCache()
  const signatureCache = createChamberProjectionSignatureCache()
  const first = derive(f, cache)
  const firstSignature = cachedServersProjectionSignature(first, signatureCache)
  const changed = fixture()
  const second = derive(changed, cache)
  assert.notEqual(second[1], first[1], 'a new aggregate identity rebuilds the entry')
  assert.equal(cachedServersProjectionSignature(second, signatureCache), firstSignature,
    'equal content keeps the publish gate closed (identity churn alone must not re-publish)')
})

test('projection cache: TTL expiry recomputes even when every input is identical', () => {
  const f = fixture()
  const cache = createServerProjectionCache(-1) // 恒过期：不依赖同毫秒的时钟巧合
  const first = derive(f, cache)
  const second = derive(f, cache)
  assert.notEqual(second[0], first[0])
  assert.notEqual(second[1], first[1])
  assert.deepEqual(second.map(server => server.workspaces), first.map(server => server.workspaces),
    'fresh objects, same derived rows')
})

test('projection cache: the placement ledger is a cache-key component', () => {
  // 位置意图只改**投影**（把 create-prepend 的头部行搬到锚点后）：账本变化必须让该来源重算，
  // 否则缓存会把旧序当作"输入没变"复用（新参数 workspacePlacements 的键分量回归锁）。
  const cache = createServerProjectionCache()
  const head: InstanceAggregate = {
    state: 'ok', error: null, archiveSetKnown: true, archivedSessionIds: [],
    workspaces: [
      { workspaceId: 'w2', path: '/w2', title: 'WT', sessionIds: [], createdAt: '', updatedAt: '' },
      { workspaceId: 'w1', path: '/w1', title: 'Main', sessionIds: [], createdAt: '', updatedAt: '' },
    ],
    sessions: [],
  }
  const deriveWith = (aggregates: Record<string, InstanceAggregate>, placements?: WorkspacePlacementLedger) =>
    deriveServers(READY_HEALTH, [], [], {}, aggregates,
      {}, {}, {}, 'local', {}, {}, {}, {}, {}, {}, {}, 'zh', {}, cache, placements)
  const placement: WorkspacePlacementLedger = {
    local: [{ path: '/w2', afterWorkspaceId: 'w1', at: 1 }],
  }
  const withoutIntent = deriveWith({ local: head })
  assert.deepEqual(withoutIntent[0].workspaces.map(workspace => workspace.id), ['w2', 'w1'],
    'authority order is the create-prepend transient')
  const withIntent = deriveWith({ local: head }, placement)
  assert.notEqual(withIntent[0], withoutIntent[0], 'a ledger-only change is not a cache hit')
  assert.deepEqual(withIntent[0].workspaces.map(workspace => workspace.id), ['w1', 'w2'])
  // 账本身份不变 ⇒ 缓存命中（不因每次渲染重建账本数组而抖动）。
  assert.equal(deriveWith({ local: head }, placement)[0], withIntent[0])
})

test('projection cache: the removal ledger drops the observed tail sink (and is a cache-key component)', () => {
  // 删除意图（pre-delete 半边，client-core workspace-removal.ts）：宿主删除的 order 帧把被删行
  // 沉到列表尾部（pinned client store 的 unranked-sink），投影在**观察到下沉**的那一帧摘掉它；
  // 证据 = 上一次投影的真实尾部（缓存条目记录）不是它。被删行本来就排在尾部时恒等。
  const cache = createServerProjectionCache()
  const order = (ids: readonly string[]): InstanceAggregate => ({
    state: 'ok', error: null, archiveSetKnown: true, archivedSessionIds: [],
    workspaces: ids.map(id => ({ workspaceId: id, path: '/' + id, title: id, sessionIds: [], createdAt: '', updatedAt: '' })),
    sessions: [],
  })
  const deriveWith = (aggregates: Record<string, InstanceAggregate>, removals?: WorkspaceRemovalLedger, activeCache = cache) =>
    deriveServers(READY_HEALTH, [], [], {}, aggregates,
      {}, {}, {}, 'local', {}, {}, {}, {}, {}, {}, {}, 'zh', {}, activeCache, undefined, undefined, removals)
  const removal: WorkspaceRemovalLedger = { local: [{ workspaceId: 'b', at: 1 }] }

  // 删除在途、但行还在中间：恒等（意图绝不隐藏仍在列表中间的行）。聚合身份复用，才谈得上缓存语义。
  const midOrder = order(['a', 'b', 'c'])
  const before = deriveWith({ local: midOrder }, removal)
  assert.deepEqual(before[0].workspaces.map(workspace => workspace.id), ['a', 'b', 'c'],
    'a pending row still mid-list is never hidden')

  // 宿主 order 帧：b 沉到尾部（[a,c,b]）。上一次投影的尾部是 c ⇒ 观察到下沉 ⇒ 摘掉 b。
  const sunkOrder = order(['a', 'c', 'b'])
  const sunk = deriveWith({ local: sunkOrder }, removal)
  assert.deepEqual(sunk[0].workspaces.map(workspace => workspace.id), ['a', 'c'],
    'the observed sink drops the doomed tail row instead of gliding it to the last line')
  assert.equal(deriveWith({ local: sunkOrder }, removal)[0], sunk[0],
    'an unchanged input set keeps the per-source cache hit')

  // 账本本身是键分量：同一个聚合对象、只是没有账本 ⇒ 重算且不摘行（否则缓存会把旧结果当
  // "输入没变"复用，行又回到尾部）。
  const withoutIntent = deriveWith({ local: sunkOrder })
  assert.notEqual(withoutIntent[0], sunk[0], 'a ledger-only change is not a cache hit')
  assert.deepEqual(withoutIntent[0].workspaces.map(workspace => workspace.id), ['a', 'c', 'b'],
    'without the intent the authority order renders as-is')

  // 被删行本来就是尾部：没有位移要修 ⇒ 恒等，交给权威 remove 帧（失败撤回也不闪）。
  const freshCache = createServerProjectionCache()
  const lastOrder = order(['a', 'b'])
  deriveWith({ local: lastOrder }, removal, freshCache)
  const alreadyLast = deriveWith({ local: lastOrder }, { local: [{ workspaceId: 'b', at: 2 }] }, freshCache)
  assert.notEqual(alreadyLast[0], undefined)
  assert.deepEqual(alreadyLast[0]?.workspaces.map(workspace => workspace.id), ['a', 'b'],
    'a row that was already the tail never moved, so nothing is corrected')
})

test('projection cache: overlapping removals drop together and a rolled-back order restores the rows', () => {
  // 正确性评审 m3 的两条 deriveServers 层用例：①两个 pending 连续下沉一帧摘完；②宿主回滚 order
  // （表删除失败）时行回原位、不误摘（旧尾部匹配证明这一帧没把它推到尾部）。
  const cache = createServerProjectionCache()
  const order = (ids: readonly string[]): InstanceAggregate => ({
    state: 'ok', error: null, archiveSetKnown: true, archivedSessionIds: [],
    workspaces: ids.map(id => ({ workspaceId: id, path: '/' + id, title: id, sessionIds: [], createdAt: '', updatedAt: '' })),
    sessions: [],
  })
  const deriveWith = (aggregates: Record<string, InstanceAggregate>, removals?: WorkspaceRemovalLedger) =>
    deriveServers(READY_HEALTH, [], [], {}, aggregates,
      {}, {}, {}, 'local', {}, {}, {}, {}, {}, {}, {}, 'zh', {}, cache, undefined, undefined, removals)
  const removalB: WorkspaceRemovalLedger = { local: [{ workspaceId: 'b', at: 1 }] }
  const removalBC: WorkspaceRemovalLedger = { local: [{ workspaceId: 'b', at: 1 }, { workspaceId: 'c', at: 2 }] }

  deriveWith({ local: order(['a', 'b', 'c', 'd']) })
  const sinkB = order(['a', 'c', 'd', 'b'])
  assert.deepEqual(deriveWith({ local: sinkB }, removalB)[0].workspaces.map(workspace => workspace.id),
    ['a', 'c', 'd'], 'B sinks alone')
  // C 的 order 帧：C 也沉到尾部（B 的 remove 帧尚未到达，B 仍在 items 里）⇒ 整段一帧摘完。
  const sinkC = order(['a', 'd', 'c', 'b'])
  assert.deepEqual(deriveWith({ local: sinkC }, removalBC)[0].workspaces.map(workspace => workspace.id),
    ['a', 'd'], 'the whole trailing pending run is dropped in one pass')
  // 宿主回滚：order 恢复成原序 ⇒ 旧尾部再次成为尾部 ⇒ 恒等，所有行回到原位。
  const rolledBack = order(['a', 'b', 'c', 'd'])
  assert.deepEqual(deriveWith({ local: rolledBack }, removalBC)[0].workspaces.map(workspace => workspace.id),
    ['a', 'b', 'c', 'd'], 'a rolled-back order restores every row (no wrong drop)')
})

test('projection cache: a non-ok derive invalidates the sink evidence until the authority frame', () => {
  // 评审 A 的 Minor 2（已登记边界）：意图发布后、下沉帧之前若有一次非 ok 派生，缓存条目不再带
  // tailWorkspaceId ⇒ 下一次下沉帧没有证据、不纠正，且该帧成为新基准 ⇒ 纠正被锁到权威 remove 帧
  // 为止（与修复前同形、自愈；不是"只差一帧"）。
  const cache = createServerProjectionCache()
  const order = (ids: readonly string[]): InstanceAggregate => ({
    state: 'ok', error: null, archiveSetKnown: true, archivedSessionIds: [],
    workspaces: ids.map(id => ({ workspaceId: id, path: '/' + id, title: id, sessionIds: [], createdAt: '', updatedAt: '' })),
    sessions: [],
  })
  const deriveWith = (aggregates: Record<string, InstanceAggregate>, removals?: WorkspaceRemovalLedger) =>
    deriveServers(READY_HEALTH, [], [], {}, aggregates,
      {}, {}, {}, 'local', {}, {}, {}, {}, {}, {}, {}, 'zh', {}, cache, undefined, undefined, removals)
  const removal: WorkspaceRemovalLedger = { local: [{ workspaceId: 'b', at: 1 }] }

  deriveWith({ local: order(['a', 'b', 'c']) })
  deriveWith({ local: { state: 'error', error: 'disconnected', workspaces: [], sessions: [], archivedSessionIds: [] } })
  const sunk = deriveWith({ local: order(['a', 'c', 'b']) }, removal)
  assert.deepEqual(sunk[0].workspaces.map(workspace => workspace.id), ['a', 'c', 'b'],
    'no evidence ⇒ one uncorrected frame (the pre-fix shape), self-healed by the authority frame')
})

test('projection cache: a removed source releases its entry', () => {
  const f = fixture()
  const cache = createServerProjectionCache()
  derive(f, cache)
  assert.equal(cache.entries.size, 2)
  derive({ ...f, remoteInstances: [] }, cache)
  assert.equal(cache.entries.size, 1, 'entries follow the live source set')
})

test('projection signature cache: fragments are byte-identical to the pure signature', () => {
  const servers = derive(fixture())
  const cache = createChamberProjectionSignatureCache()
  assert.equal(cachedServersProjectionSignature(servers, cache), serversProjectionSignature(servers))
  assert.equal(cachedServersProjectionSignature(servers), serversProjectionSignature(servers), 'no cache stays pure')
})

test('projection signature cache: remembered signatures serve the published array only', () => {
  const servers = derive(fixture())
  const computed = serversProjectionSignature(servers)
  rememberServersProjectionSignature(servers, 'remembered')
  assert.equal(cachedServersProjectionSignature(servers), 'remembered')
  assert.equal(cachedServersProjectionSignature([...servers]), computed, 'a copy is not remembered')
})

/** facts 通道完整行形（session-facts-source.SessionFactsRow）。 */
function factsRow(over: Partial<SessionFactsRow> = {}): SessionFactsRow {
  return {
    sessionId: 's1', running: false, pendingKind: null, subagentCount: 0, updatedAt: 5,
    completedAt: null, completedAtSource: null, lastTurnEnd: null, factAt: 5, ...over,
  }
}

function factsSnapshot(rows: Record<string, SessionFactsRow>): SessionFactsSnapshot {
  return {
    verdict: 'ok', degradation: null, mode: 'sse', hostState: 'ready', serviceable: true,
    stale: false, cursor: 1, lastEventAt: null, baselines: 1, rows,
  }
}

test('I-12 facts overlay: activity is the lineage classification, never the raw count', () => {
  const f = fixture()
  const servers = deriveServers(READY_HEALTH, [], f.remoteInstances, f.remoteStatus, f.aggregates,
    {}, {}, {}, 'local', {}, {}, {}, {}, {}, {}, {}, 'zh',
    { [REMOTE_SOURCE_ID]: factsSnapshot({
      a: factsRow({ sessionId: 'a', subagentCount: 2, lineageVerified: true }),
      b: factsRow({ sessionId: 'b', lineageVerified: true }),
      c: factsRow({ sessionId: 'c', subagentKnown: true }),
      d: factsRow({ sessionId: 'd', subagentCount: 3 }),
    }) })
  const remote = servers.find(server => server.id === REMOTE_SOURCE_ID)
  const sessions = remote?.runtime?.sessions ?? {}
  assert.equal(sessions.a?.subagentActivity, 'running', 'verified running child = busy')
  assert.equal(sessions.a?.runningSubagents, 2, 'the count still rides for display')
  assert.equal(sessions.b?.subagentActivity, 'none', 'verified zero children = idle')
  assert.equal(sessions.c?.subagentActivity, 'running', 'known durable child fails closed (busy)')
  assert.equal(sessions.c?.runningSubagents, undefined, 'no positive count is invented')
  assert.equal(sessions.d?.subagentActivity, 'unknown', 'unverified presence count is never running')
  assert.equal(sessions.d?.runningSubagents, 3, 'the raw count still rides, but only for display')
})

test('projection signature cache: fragments are keyed by source identity (immutability contract)', () => {
  const servers = derive(fixture())
  const cache = createChamberProjectionSignatureCache()
  const before = cachedServersProjectionSignature(servers, cache)
  const mutated = servers[1] as unknown as { label: string }
  mutated.label = 'renamed-in-place'
  assert.equal(cachedServersProjectionSignature(servers, cache), before, 'identity-keyed fragment reuse')
  assert.notEqual(cachedServersProjectionSignature([servers[0], { ...servers[1] }]), before,
    'a new object recomputes its fragment')
})
