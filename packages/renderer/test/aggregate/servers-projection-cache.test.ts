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
