/**
 * session-mutations.ts 行为测试（design 05 §2.2 唯一事实出口，会话侧）。
 *
 * 出口的运行时契约（原先配对的 renderer source-text 接线锁已按 2026-12 裁决退役）：事实在 wire
 * **成功之后**才发布，携带宿主返回的 session id（权威）与 workspaceId /
 * blank 事实；fork 携带 parentSessionId 与 blank:false（子会话继承内容），标题提示缺省时字段
 * 不出现（稀疏）；归档发布撤下事实；wire 失败（业务失败或抛错）**不发布任何事实**，也不吞掉失败。
 *
 * 打桩方式（沿用原 workspace-mutations.test.ts 的做法）：getInstanceClient 按 instanceId 缓存同一个
 * InstanceApiClient，直接替换该缓存对象的 session/workspace 面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge } from '../../src/shared/aggregate-store.ts'
import { getInstanceClient, releaseInstanceClient, type UnaryResult } from '../../src/shared/instance-api.ts'
import {
  archiveSessionForSource,
  createSessionForSource,
  forkSessionForSource,
} from '../../src/shared/session-mutations.ts'
import { createWorkspaceForSource } from '../../src/shared/workspace-mutations.ts'

interface SessionFacts { created: Record<string, unknown>[]; removed: Record<string, unknown>[]; off(): void }

function collectFacts(sourceId: string): SessionFacts {
  const created: Record<string, unknown>[] = []
  const removed: Record<string, unknown>[] = []
  const offCreated = chamberBridge.onSessionCreated((fact) => { if (fact.sourceId === sourceId) created.push({ ...fact }) })
  const offRemoved = chamberBridge.onSessionRemoved((fact) => { if (fact.sourceId === sourceId) removed.push({ ...fact }) })
  return { created, removed, off: () => { offCreated(); offRemoved() } }
}

function stubCreate(sourceId: string, value: unknown): { calls: unknown[] } {
  const client = getInstanceClient(sourceId)
  const calls: unknown[] = []
  client.session.create = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    calls.push(payload)
    return { ok: true, value }
  }
  return { calls }
}

test('createSessionForSource: the HOST id and the blank fact are published after the wire accepted it', async () => {
  const sourceId = 'session-funnel-create'
  const stub = stubCreate(sourceId, { sessionId: 'host-minted' })
  const facts = collectFacts(sourceId)
  try {
    const sessionId = await createSessionForSource(sourceId, 'w1')
    assert.equal(sessionId, 'host-minted', 'the funnel returns the host id for the caller\'s follow-up open')
    assert.deepEqual(stub.calls, [{ workspaceId: 'w1' }], 'a host-minted id sends no sessionId key')
    assert.deepEqual(facts.created, [{ sourceId, sessionId: 'host-minted', workspaceId: 'w1', blank: true }])
    assert.deepEqual(facts.removed, [], 'a create publishes no removal fact')
  } finally { facts.off(); releaseInstanceClient(sourceId) }
})

test('createSessionForSource: a preallocated id rides the wire and the returned id must match', async () => {
  const sourceId = 'session-funnel-prealloc'
  const stub = stubCreate(sourceId, { sessionId: 's-pre' })
  const facts = collectFacts(sourceId)
  try {
    await createSessionForSource(sourceId, 'w2', { sessionId: 's-pre' })
    assert.deepEqual(stub.calls, [{ workspaceId: 'w2', sessionId: 's-pre' }])
    assert.equal(facts.created[0]?.sessionId, 's-pre')
    assert.equal('title' in (facts.created[0] ?? {}), false, 'the fact stays sparse without a title hint')
  } finally { facts.off(); releaseInstanceClient(sourceId) }
})

test('forkSessionForSource: the child carries its parent and the content (blank:false) fact', async () => {
  const sourceId = 'session-funnel-fork'
  const client = getInstanceClient(sourceId)
  const calls: unknown[] = []
  client.session.fork = async (payload: unknown): Promise<UnaryResult<unknown>> =>
    (calls.push(payload), { ok: true, value: { sessionId: 'child-1' } })
  const facts = collectFacts(sourceId)
  try {
    const childId = await forkSessionForSource(sourceId, 'parent-1', { title: 'parent (1)' })
    assert.equal(childId, 'child-1')
    assert.deepEqual(calls, [{ sessionId: 'parent-1' }], 'fork sends only the parent id (atSeq stays official semantics)')
    assert.deepEqual(facts.created, [{ sourceId, sessionId: 'child-1', parentSessionId: 'parent-1', blank: false, title: 'parent (1)' }])
  } finally { facts.off(); releaseInstanceClient(sourceId) }
})

test('archiveSessionForSource: the withdraw fact is published after the wire accepted it', async () => {
  const sourceId = 'session-funnel-archive'
  const client = getInstanceClient(sourceId)
  const calls: unknown[] = []
  client.workspace.archiveSession = async (payload: unknown): Promise<UnaryResult<unknown>> =>
    (calls.push(payload), { ok: true, value: { archived: true } })
  const facts = collectFacts(sourceId)
  try {
    await archiveSessionForSource(sourceId, 's-1')
    assert.deepEqual(calls, [{ sessionId: 's-1' }])
    assert.deepEqual(facts.removed, [{ sourceId, sessionId: 's-1' }])
    assert.deepEqual(facts.created, [])
  } finally { facts.off(); releaseInstanceClient(sourceId) }
})

test('a failed wire publishes NOTHING (the echo must never outrun the host)', async () => {
  const sourceId = 'session-funnel-failure'
  const client = getInstanceClient(sourceId)
  client.session.create = async (): Promise<UnaryResult<unknown>> =>
    ({ ok: false, error: { code: 'session/agent-busy', message: 'busy', details: {} } })
  const facts = collectFacts(sourceId)
  try {
    await assert.rejects(createSessionForSource(sourceId, 'w1'), /busy/)
    assert.deepEqual(facts.created, [], 'a rejected create leaves no phantom row in the projection')
  } finally { facts.off(); releaseInstanceClient(sourceId) }
})

// ---- workspace create funnel (consolidated from workspace-mutations.test.ts;
//      same stubbing style, so the two funnels share one harness file) ----

test('createWorkspaceForSource publishes the HOST identity (id + canonical path) with the requested anchor', async () => {
  const sourceId = 'funnel-workspace-identity'
  const client = getInstanceClient(sourceId)
  const calls: unknown[] = []
  client.workspace.create = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    calls.push(payload)
    return { ok: true, value: { workspace: { workspaceId: 'w1', path: '/canonical/path' }, created: true } }
  }
  const facts: Record<string, unknown>[] = []
  const off = chamberBridge.onWorkspaceCreated((fact) => { if (fact.sourceId === sourceId) facts.push({ ...fact }) })
  try {
    const created = await createWorkspaceForSource(sourceId, 'picked/lexical/path', { afterWorkspaceId: 'main' })
    assert.deepEqual(created, { workspaceId: 'w1', path: '/canonical/path', created: true },
      'the host canonical path wins over the requested spelling (symlinked picks)')
    assert.equal(calls.length, 1, 'exactly one wire call')
    assert.deepEqual(facts, [{ sourceId, workspaceId: 'w1', path: '/canonical/path', afterWorkspaceId: 'main' }])
  } finally { off(); releaseInstanceClient(sourceId) }
})

test('createWorkspaceForSource: a host-reused registration still publishes and the fact stays sparse', async () => {
  const sourceId = 'funnel-workspace-reuse'
  const client = getInstanceClient(sourceId)
  client.workspace.create = async (): Promise<UnaryResult<unknown>> =>
    ({ ok: true, value: { workspace: { workspaceId: 'w2', path: '/p/2' }, created: false } })
  const facts: Record<string, unknown>[] = []
  const off = chamberBridge.onWorkspaceCreated((fact) => { if (fact.sourceId === sourceId) facts.push({ ...fact }) })
  try {
    const created = await createWorkspaceForSource(sourceId, '/p/2')
    assert.equal(created.created, false)
    assert.equal(facts.length, 1, 'adopting an existing registration is still a fact the projection must hear')
    assert.equal('afterWorkspaceId' in (facts[0] ?? {}), false, 'the fact is sparse without an anchor')
  } finally { off(); releaseInstanceClient(sourceId) }
})

test('createWorkspaceForSource: decorations run BEFORE the fact and a throwing one never aborts the create', async () => {
  const sourceId = 'funnel-workspace-decoration'
  const client = getInstanceClient(sourceId)
  client.workspace.create = async (): Promise<UnaryResult<unknown>> =>
    ({ ok: true, value: { workspace: { workspaceId: 'w3', path: '/p/3' }, created: true } })
  const order: string[] = []
  const off = chamberBridge.onWorkspaceCreated((fact) => { if (fact.sourceId === sourceId) order.push('fact') })
  const logged: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    const created = await createWorkspaceForSource(sourceId, '/p/3', {
      beforePublish: () => { order.push('decorate'); throw new Error('decoration exploded') },
    })
    assert.deepEqual(order, ['decorate', 'fact'], 'the echoed row is born in its final shape')
    assert.equal(created.workspaceId, 'w3', 'a committed host mutation must never become a saga failure')
  } finally { console.error = originalError; off(); releaseInstanceClient(sourceId) }
  assert.equal(logged.length, 1, 'the swallowed decoration failure is logged exactly once, never silent')
  assert.match(String(logged[0]?.[0] ?? ''), /workspace create decoration failed/)
})

test('round-3 restore: the workspace title hint rides the fact (the echoed row is born labeled)', async () => {
  const sourceId = 'funnel-workspace-title'
  const client = getInstanceClient(sourceId)
  client.workspace.create = async (): Promise<UnaryResult<unknown>> =>
    ({ ok: true, value: { workspace: { workspaceId: 'w4', path: '/p/4' }, created: true } })
  const facts: Record<string, unknown>[] = []
  const off = chamberBridge.onWorkspaceCreated((fact) => { if (fact.sourceId === sourceId) facts.push({ ...fact }) })
  try {
    await createWorkspaceForSource(sourceId, '/p/4', { title: 'feature/x' })
    assert.deepEqual(facts, [{ sourceId, workspaceId: 'w4', path: '/p/4', title: 'feature/x' }])
    assert.equal('afterWorkspaceId' in (facts[0] ?? {}), false, 'the fact stays sparse without an anchor')
  } finally { off(); releaseInstanceClient(sourceId) }
})
