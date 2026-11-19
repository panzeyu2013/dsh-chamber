/**
 * session-mutations.ts 行为测试（design 05 §2.2 唯一事实出口，会话侧）。
 *
 * 出口的运行时契约：事实在 wire
 * **成功之后**才发布，携带宿主返回的 session id（权威）与 workspaceId /
 * blank 事实；fork 携带 parentSessionId 与 blank:false（子会话继承内容），标题提示缺省时字段
 * 不出现（稀疏）；归档发布撤下事实；恢复（官方 `workspace/unarchiveSession`）发布恢复事实以清本地
 * 归档墓碑；wire 失败（业务失败或抛错）**不发布任何事实**，也不吞掉失败。
 *
 * 打桩方式：getInstanceClient 按 instanceId 缓存同一个
 * InstanceApiClient，直接替换该缓存对象的 session/workspace 面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import {
  getInstanceClient, MutationOutcomeUnknownError, releaseInstanceClient, type UnaryResult,
} from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import {
  archiveSessionForSource,
  createSessionForSource,
  forkSessionForSource,
  pinSessionForSource,
  unarchiveSessionForSource,
  unpinSessionForSource,
} from '@dsh-chamber/dsh-chamber-client-core/session-mutations'
import { onSessionRestored } from '@dsh-chamber/dsh-chamber-client-core/session-restore'
import { createWorkspaceForSource } from '@dsh-chamber/dsh-chamber-client-core/workspace-mutations'
import { session as sessionRow, snapshot as instanceSnapshot, server as serverFixture } from '../support/derive-fixtures.ts'

interface SessionFacts {
  created: Record<string, unknown>[]
  removed: Record<string, unknown>[]
  restored: Record<string, unknown>[]
  off(): void
}

function collectFacts(sourceId: string): SessionFacts {
  const created: Record<string, unknown>[] = []
  const removed: Record<string, unknown>[] = []
  const restored: Record<string, unknown>[] = []
  const offCreated = chamberBridge.onSessionCreated((fact) => { if (fact.sourceId === sourceId) created.push({ ...fact }) })
  const offRemoved = chamberBridge.onSessionRemoved((fact) => { if (fact.sourceId === sourceId) removed.push({ ...fact }) })
  const offRestored = onSessionRestored((fact) => { if (fact.sourceId === sourceId) restored.push({ ...fact }) })
  return {
    created,
    removed,
    restored,
    off: () => { offCreated(); offRemoved(); offRestored() },
  }
}

/** Register one mounted-source raw snapshot (the authoritative taken source). */
function reportSnapshot(sourceId: string, sessions: ReturnType<typeof sessionRow>[]): () => void {
  const producer = chamberBridge.registerInstanceSnapshotProducer(sourceId, 'c'.repeat(64), 1)
  producer.report(instanceSnapshot([], sessions))
  return () => { producer.clear(); releaseInstanceClient(sourceId) }
}

/** Same mounted-source producer, kept open so a test can publish an authority update while
 *  a mutation is in flight (the post-fork re-check window). */
function openSnapshotProducer(sourceId: string): {
  publish(sessions: ReturnType<typeof sessionRow>[]): void
  clear(): void
} {
  const producer = chamberBridge.registerInstanceSnapshotProducer(sourceId, 'c'.repeat(64), 1)
  return {
    publish: (sessions) => { producer.report(instanceSnapshot([], sessions)) },
    clear: () => { producer.clear(); releaseInstanceClient(sourceId) },
  }
}

interface ForkStubs {
  forks: unknown[]
  renames: unknown[]
}

/** Stub one source session wire: fork mints the given child ids, rename records and accepts. */
function stubForkAndRename(sourceId: string, childIds: string[]): ForkStubs {
  const client = getInstanceClient(sourceId)
  const forks: unknown[] = []
  const renames: unknown[] = []
  let minted = 0
  client.session.fork = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    forks.push(payload)
    minted += 1
    return { ok: true, value: { sessionId: childIds[minted - 1] ?? 'child-' + minted } }
  }
  client.session.rename = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    renames.push(payload)
    return { ok: true, value: { title: (payload as { title?: string }).title ?? '', seq: 3 } }
  }
  return { forks, renames }
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

test('archiveSessionForSource: stopActivity rides only the confirmed phase, never as an explicit false', async () => {
  const sourceId = 'session-funnel-archive-stop'
  const client = getInstanceClient(sourceId)
  const calls: unknown[] = []
  client.workspace.archiveSession = async (payload: unknown): Promise<UnaryResult<unknown>> =>
    (calls.push(payload), { ok: true, value: { archivedSessionIds: [] } })
  const facts = collectFacts(sourceId)
  try {
    await archiveSessionForSource(sourceId, 's-plain')
    await archiveSessionForSource(sourceId, 's-stopped', { stopActivity: true })
    await archiveSessionForSource(sourceId, 's-false', { stopActivity: false })
    assert.deepEqual(calls, [
      { sessionId: 's-plain' },
      { sessionId: 's-stopped', stopActivity: true },
      { sessionId: 's-false' },
    ], 'the wire schema has an additive optional field: false must not be sent')
    assert.deepEqual(facts.removed, [
      { sourceId, sessionId: 's-plain' },
      { sourceId, sessionId: 's-stopped' },
      { sourceId, sessionId: 's-false' },
    ], 'both phases publish the withdraw fact (no echo outliving the host archive)')
  } finally { facts.off(); releaseInstanceClient(sourceId) }
})

test('a REFUSED archive publishes no withdraw fact in either phase (the fact never outruns the host)', async () => {
  const sourceId = 'session-funnel-archive-failure'
  const client = getInstanceClient(sourceId)
  client.workspace.archiveSession = async (): Promise<UnaryResult<unknown>> =>
    ({ ok: false, error: { code: 'workspace/session-active', message: 'active', details: {} } })
  const facts = collectFacts(sourceId)
  try {
    await assert.rejects(archiveSessionForSource(sourceId, 's-1'), /active/)
    await assert.rejects(archiveSessionForSource(sourceId, 's-1', { stopActivity: true }), /active/)
    assert.deepEqual(facts.removed, [], 'a refused archive leaves the row in place (no local withdraw)')
  } finally { facts.off(); releaseInstanceClient(sourceId) }
})

test('pinSessionForSource: the wire is the whole exit — one argument, no local fact, refusal rejects', async () => {
  const sourceId = 'session-funnel-pin'
  const client = getInstanceClient(sourceId)
  const calls: unknown[] = []
  client.workspace.pinSession = async (payload: unknown): Promise<UnaryResult<unknown>> =>
    (calls.push(payload), { ok: true, value: { pinnedSessionIds: ['s-1'] } })
  const facts = collectFacts(sourceId)
  try {
    await pinSessionForSource(sourceId, 's-1')
    assert.deepEqual(calls, [{ sessionId: 's-1' }], 'one official argument — the pin set comes back on the push')
    // 刻意无本地事实（无乐观回声）：标记只由权威置顶集落定，三个事实通道都不许动。
    assert.deepEqual([facts.created, facts.removed, facts.restored], [[], [], []],
      'pin publishes no local fact on any channel')
  } finally { facts.off(); releaseInstanceClient(sourceId) }
  const refusing = getInstanceClient(sourceId)
  refusing.workspace.pinSession = async (): Promise<UnaryResult<unknown>> =>
    ({ ok: false, error: { code: 'gateway/bad-request', message: 'archived', details: {} } })
  await assert.rejects(pinSessionForSource(sourceId, 's-1'), /archived/,
    'the archived-session refusal must reject so the row-level error funnel can render it')
  releaseInstanceClient(sourceId)
})

test('unpinSessionForSource: same single exit, and a refusal rejects too', async () => {
  const sourceId = 'session-funnel-unpin'
  const client = getInstanceClient(sourceId)
  const calls: unknown[] = []
  client.workspace.unpinSession = async (payload: unknown): Promise<UnaryResult<unknown>> =>
    (calls.push(payload), { ok: true, value: { pinnedSessionIds: [] } })
  const facts = collectFacts(sourceId)
  try {
    await unpinSessionForSource(sourceId, 's-1')
    assert.deepEqual(calls, [{ sessionId: 's-1' }])
    assert.deepEqual([facts.created, facts.removed, facts.restored], [[], [], []])
  } finally { facts.off(); releaseInstanceClient(sourceId) }
  const refusing = getInstanceClient(sourceId)
  refusing.workspace.unpinSession = async (): Promise<UnaryResult<unknown>> =>
    ({ ok: false, error: { code: 'session/not-found', message: 'missing', details: {} } })
  await assert.rejects(unpinSessionForSource(sourceId, 's-1'), /missing/)
  releaseInstanceClient(sourceId)
})

test('unarchiveSessionForSource: the official wire takes the id and the restore fact follows it', async () => {
  const sourceId = 'session-funnel-unarchive'
  const client = getInstanceClient(sourceId)
  const calls: unknown[] = []
  client.workspace.unarchiveSession = async (payload: unknown): Promise<UnaryResult<unknown>> =>
    (calls.push(payload), { ok: true, value: { unarchived: true } })
  const facts = collectFacts(sourceId)
  try {
    await unarchiveSessionForSource(sourceId, 's-1')
    assert.deepEqual(calls, [{ sessionId: 's-1' }], 'one official argument — no local archive semantics')
    assert.deepEqual(facts.restored, [{ sourceId, sessionId: 's-1' }])
    assert.deepEqual(facts.removed, [], 'a restore is not an archive')
  } finally { facts.off(); releaseInstanceClient(sourceId) }
})

test('a rejected restore publishes no restore fact (the tombstone must not clear early)', async () => {
  const sourceId = 'session-funnel-unarchive-failure'
  const client = getInstanceClient(sourceId)
  client.workspace.unarchiveSession = async (): Promise<UnaryResult<unknown>> =>
    ({ ok: false, error: { code: 'workspace/unknown-session', message: 'gone', details: {} } })
  const facts = collectFacts(sourceId)
  try {
    await assert.rejects(unarchiveSessionForSource(sourceId, 's-1'), /gone/)
    assert.deepEqual(facts.restored, [], 'the frozen view keeps hiding the row it could not restore')
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

// ---- workspace create funnel (same stubbing style, so the two funnels
//      share one harness file) ----

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

// ---- fork title skip-taken (design 05 §2.2): the funnel-owned title policy ----

test('fork title skip-taken: existing (1)/(2) siblings rename the child to (3) and the echo carries it', async () => {
  const sourceId = 'fork-title-mounted'
  const probe = reportSnapshot(sourceId, [
    sessionRow('source-1', 0, { title: '排障' }),
    sessionRow('sib-1', 0, { title: '排障 (1)' }),
    sessionRow('sib-2', 0, { title: '排障 (2)' }),
  ])
  const stubs = stubForkAndRename(sourceId, ['child-1'])
  const facts = collectFacts(sourceId)
  try {
    const childId = await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal(childId, 'child-1')
    assert.deepEqual(stubs.forks, [{ sessionId: 'source-1' }], 'fork payload is unchanged (the wire carries no title)')
    assert.deepEqual(stubs.renames, [{ sessionId: 'child-1', title: '排障 (3)' }])
    assert.deepEqual(facts.created, [{
      sourceId, sessionId: 'child-1', parentSessionId: 'source-1', blank: false, title: '排障 (3)',
    }], 'the echo is published after the rename and carries the final intent')
  } finally { facts.off(); probe() }
})

test('fork title skip-taken: the taken set is really read (a missing sibling changes the number)', async () => {
  const sourceId = 'fork-title-mounted-negative'
  const probe = reportSnapshot(sourceId, [
    sessionRow('source-1', 0, { title: '排障' }),
    sessionRow('sib-2', 0, { title: '排障 (2)' }),
  ])
  const stubs = stubForkAndRename(sourceId, ['child-1'])
  const facts = collectFacts(sourceId)
  try {
    await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.deepEqual(stubs.renames, [{ sessionId: 'child-1', title: '排障 (1)' }],
      'without the (1) sibling the first free number is (1), not a fixed skip')
  } finally { facts.off(); probe() }
})

test('fork title skip-taken: two same-tick forks (double click) reserve distinct numbers', async () => {
  const sourceId = 'fork-title-concurrent'
  const probe = reportSnapshot(sourceId, [sessionRow('source-1', 0, { title: '排障' })])
  const client = getInstanceClient(sourceId)
  const pending: Array<(value: UnaryResult<unknown>) => void> = []
  const renames: unknown[] = []
  client.session.fork = (): Promise<UnaryResult<unknown>> => new Promise(resolve => { pending.push(resolve) })
  client.session.rename = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    renames.push(payload)
    return { ok: true, value: { title: (payload as { title?: string }).title ?? '', seq: 3 } }
  }
  const facts = collectFacts(sourceId)
  try {
    const first = forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    const second = forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal(pending.length, 2, 'both forks are in flight before either rename')
    pending[0]({ ok: true, value: { sessionId: 'child-1' } })
    pending[1]({ ok: true, value: { sessionId: 'child-2' } })
    await Promise.all([first, second])
    const titles = renames.map(payload => (payload as { title?: string }).title).sort()
    assert.deepEqual(titles, ['排障 (1)', '排障 (2)'], 'the synchronous reservation makes double click distinct')
    assert.deepEqual(facts.created.map(fact => fact.title).sort(), ['排障 (1)', '排障 (2)'])
  } finally { facts.off(); probe() }
})

test('fork title skip-taken: the authority listing the reserved title inside the fork RTT bumps the rename (post-fork re-check)', async () => {
  const sourceId = 'fork-title-post-fork-authority'
  const producer = openSnapshotProducer(sourceId)
  producer.publish([sessionRow('source-1', 0, { title: '排障' })])
  const client = getInstanceClient(sourceId)
  const pendingForks: Array<(value: UnaryResult<unknown>) => void> = []
  const renames: unknown[] = []
  client.session.fork = (): Promise<UnaryResult<unknown>> => new Promise(resolve => { pendingForks.push(resolve) })
  client.session.rename = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    renames.push(payload)
    return { ok: true, value: { title: (payload as { title?: string }).title ?? '', seq: 3 } }
  }
  const facts = collectFacts(sourceId)
  try {
    const inFlight = forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal(pendingForks.length, 1, 'the fork is in flight before the authority moves')
    assert.deepEqual(renames, [], 'nothing renames before the fork resolves')
    // A mounted push inside the fork RTT lists the title this window reserved at the
    // synchronous naming step (upstream reads taken AFTER the fork resolves).
    producer.publish([
      sessionRow('source-1', 0, { title: '排障' }),
      sessionRow('sib-authority', 0, { title: '排障 (1)' }),
    ])
    pendingForks[0]({ ok: true, value: { sessionId: 'child-1' } })
    await inFlight
    assert.deepEqual(renames, [{ sessionId: 'child-1', title: '排障 (2)' }],
      'the post-fork authority re-check skips the number the authority now lists')
    assert.deepEqual(facts.created, [{
      sourceId, sessionId: 'child-1', parentSessionId: 'source-1', blank: false, title: '排障 (2)',
    }], 'the echo is published after the rename and matches the re-checked target')
  } finally { facts.off(); producer.clear() }
})

test('fork title skip-taken: a same-tick early failure leaves an n+1 gap that the next fork fills', async () => {
  const sourceId = 'fork-title-concurrent-gap'
  const probe = reportSnapshot(sourceId, [
    sessionRow('source-1', 0, { title: '排障' }),
    sessionRow('sib-1', 0, { title: '排障 (1)' }),
  ])
  const client = getInstanceClient(sourceId)
  const pending: Array<(value: UnaryResult<unknown>) => void> = []
  const renames: unknown[] = []
  client.session.fork = (): Promise<UnaryResult<unknown>> => new Promise(resolve => { pending.push(resolve) })
  client.session.rename = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    renames.push(payload)
    if ((payload as { sessionId?: string }).sessionId === 'child-1') {
      return { ok: false, error: { code: 'session/title-invalid', message: 'rejected', details: {} } }
    }
    return { ok: true, value: { title: (payload as { title?: string }).title ?? '', seq: 3 } }
  }
  const facts = collectFacts(sourceId)
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    const first = forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    const second = forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal(pending.length, 2, 'both forks reserve (2) and (3) before either rename')
    pending[0]({ ok: true, value: { sessionId: 'child-1' } })
    await first
    pending[1]({ ok: true, value: { sessionId: 'child-2' } })
    await second
    assert.deepEqual(renames, [
      { sessionId: 'child-1', title: '排障 (2)' },
      { sessionId: 'child-2', title: '排障 (3)' },
    ], 'the early failure releases (2) while the second fork keeps its reserved (3)')
    assert.equal(facts.created[0]?.title, '排障', 'the failed rename echoes the inherited title')
    assert.equal(facts.created[1]?.title, '排障 (3)')
    client.session.fork = async (): Promise<UnaryResult<unknown>> => ({ ok: true, value: { sessionId: 'child-3' } })
    await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.deepEqual(renames[2], { sessionId: 'child-3', title: '排障 (2)' },
      'the next fork fills the n that the early failure released')
    assert.equal(warnings.length, 1)
  } finally { console.warn = originalWarn; facts.off(); probe() }
})

test('fork title rename failure is non-fatal: inherited-title echo, a warn, and the number is released', async () => {
  const sourceId = 'fork-title-rename-refused'
  const probe = reportSnapshot(sourceId, [
    sessionRow('source-1', 0, { title: '排障' }),
    sessionRow('sib-1', 0, { title: '排障 (1)' }),
    sessionRow('sib-2', 0, { title: '排障 (2)' }),
  ])
  const client = getInstanceClient(sourceId)
  const renames: unknown[] = []
  let minted = 0
  client.session.fork = async (): Promise<UnaryResult<unknown>> => {
    minted += 1
    return { ok: true, value: { sessionId: 'child-' + minted } }
  }
  client.session.rename = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    renames.push(payload)
    return { ok: false, error: { code: 'session/title-invalid', message: 'rejected', details: {} } }
  }
  const facts = collectFacts(sourceId)
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    const childId = await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal(childId, 'child-1', 'the fork stays successful (the design contract is non-fatal)')
    assert.deepEqual(renames, [{ sessionId: 'child-1', title: '排障 (3)' }])
    assert.equal(facts.created[0]?.title, '排障', 'the echo must not claim the rejected increment (inherited title)')
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.[0] ?? ''), /rename failed/)
    await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.deepEqual(renames[1], { sessionId: 'child-2', title: '排障 (3)' },
      'the deterministic failure released the reservation, so (3) is retried')
  } finally { console.warn = originalWarn; facts.off(); probe() }
})

test('fork title rename outcome unknown keeps the intent echo and the reservation', async () => {
  const sourceId = 'fork-title-rename-unknown'
  const probe = reportSnapshot(sourceId, [
    sessionRow('source-1', 0, { title: '排障' }),
    sessionRow('sib-1', 0, { title: '排障 (1)' }),
    sessionRow('sib-2', 0, { title: '排障 (2)' }),
  ])
  const client = getInstanceClient(sourceId)
  const renames: unknown[] = []
  let minted = 0
  client.session.fork = async (): Promise<UnaryResult<unknown>> => {
    minted += 1
    return { ok: true, value: { sessionId: 'child-' + minted } }
  }
  client.session.rename = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    renames.push(payload)
    throw new MutationOutcomeUnknownError('session/rename')
  }
  const facts = collectFacts(sourceId)
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    const childId = await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal(childId, 'child-1')
    assert.equal(facts.created[0]?.title, '排障 (3)', 'an ambiguous rename keeps the intent echo')
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.[0] ?? ''), /outcome unknown/)
    await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.deepEqual(renames[1], { sessionId: 'child-2', title: '排障 (4)' },
      'the ambiguous outcome keeps the reservation, so the next fork skips (3)')
  } finally { console.warn = originalWarn; facts.off(); probe() }
})

test('fork title skip-taken: an unmounted source reads the aggregate nav + archived metadata', async () => {
  const sourceId = 'fork-title-unmounted'
  const previous = chamberBridge.getServers()
  chamberBridge.publish([serverFixture(sourceId, {
    workspaces: [{
      id: 'w1',
      title: 'W',
      path: '/w1',
      sessions: [{ id: 'source-1', title: '排障', displayTitle: '排障', running: false, updatedAt: 1 }],
    }],
    archivedSessions: [{ sessionId: 'a1', title: '排障 (1)' }],
  })])
  const stubs = stubForkAndRename(sourceId, ['child-1', 'child-2'])
  const facts = collectFacts(sourceId)
  try {
    await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.deepEqual(stubs.renames, [{ sessionId: 'child-1', title: '排障 (2)' }],
      'the archived (1) title counts even though the nav filter hides the archived row')
    chamberBridge.publish([serverFixture(sourceId, {
      workspaces: [{
        id: 'w1',
        title: 'W',
        path: '/w1',
        sessions: [{ id: 'source-1', title: '排障', displayTitle: '排障', running: false, updatedAt: 1 }],
      }],
    })])
    await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.deepEqual(stubs.renames[1], { sessionId: 'child-2', title: '排障 (1)' },
      'without the archived title the first free number is (1) — the aggregate source was really read')
  } finally { facts.off(); chamberBridge.publish(previous); releaseInstanceClient(sourceId) }
})

test('fork title skip-taken: titles of another source never count (cross-source negative)', async () => {
  const sourceA = 'fork-title-source-a'
  const sourceB = 'fork-title-source-b'
  const probeA = reportSnapshot(sourceA, [sessionRow('source-a', 0, { title: '排障' })])
  const probeB = reportSnapshot(sourceB, [
    sessionRow('source-b', 0, { title: '排障' }),
    sessionRow('sib-b', 0, { title: '排障 (1)' }),
  ])
  const stubsA = stubForkAndRename(sourceA, ['child-a'])
  const stubsB = stubForkAndRename(sourceB, ['child-b'])
  const facts = collectFacts(sourceA)
  try {
    await forkSessionForSource(sourceA, 'source-a', { increaseTitleFrom: '排障' })
    await forkSessionForSource(sourceB, 'source-b', { increaseTitleFrom: '排障' })
    assert.deepEqual(stubsA.renames, [{ sessionId: 'child-a', title: '排障 (1)' }],
      'B title must never squeeze A number')
    assert.deepEqual(stubsB.renames, [{ sessionId: 'child-b', title: '排障 (2)' }],
      'B keeps its own skip-taken set')
  } finally { facts.off(); probeA(); probeB() }
})

test('plain fork keeps the old contract: immediate echo, no rename; empty increaseTitleFrom is plain too', async () => {
  const sourceId = 'fork-title-plain'
  const stubs = stubForkAndRename(sourceId, ['child-1', 'child-2', 'child-3'])
  const facts = collectFacts(sourceId)
  try {
    await forkSessionForSource(sourceId, 'parent-1')
    await forkSessionForSource(sourceId, 'parent-1', { title: 'parent (1)' })
    await forkSessionForSource(sourceId, 'parent-1', { increaseTitleFrom: '' })
    assert.deepEqual(stubs.renames, [], 'no rename on the plain path')
    assert.deepEqual(facts.created.map(fact => fact.title), [undefined, 'parent (1)', undefined])
  } finally { facts.off(); releaseInstanceClient(sourceId) }
})

test('the sidebar fork action delegates the title policy to the funnel (source lock)', () => {
  const sidebar = readFileSync(new URL('../../src/client/sidebar-root-sessions.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(sidebar, /increasedForkTitle/)
  assert.doesNotMatch(sidebar, /renameSession/)
  assert.match(sidebar, /increaseTitleFrom: session\.title/)
  const funnel = readFileSync(new URL('../../../dsh-chamber-client-core/src/session-mutations.ts', import.meta.url), 'utf8')
  assert.match(funnel, /from '\.\/fork-titles\.ts'/)
})

test('fork title skip-taken: the reservation still holds at 399s (both mutation budgets)', async () => {
  const sourceId = 'fork-title-reservation-window'
  const probe = reportSnapshot(sourceId, [sessionRow('source-1', 0, { title: '排障' })])
  const client = getInstanceClient(sourceId)
  const pending: Array<(value: UnaryResult<unknown>) => void> = []
  const renames: unknown[] = []
  client.session.fork = (): Promise<UnaryResult<unknown>> => new Promise(resolve => { pending.push(resolve) })
  client.session.rename = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    renames.push(payload)
    return { ok: true, value: { title: (payload as { title?: string }).title ?? '', seq: 3 } }
  }
  const facts = collectFacts(sourceId)
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const first = forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal(pending.length, 1)
    now += 399_000 // inside the fork+rename two-budget TTL, just before expiry
    const second = forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal(pending.length, 2, 'the second fork starts while the first RPC is still pending')
    pending[0]({ ok: true, value: { sessionId: 'child-1' } })
    pending[1]({ ok: true, value: { sessionId: 'child-2' } })
    await Promise.all([first, second])
    const titles = renames.map(payload => (payload as { title?: string }).title).sort()
    assert.deepEqual(titles, ['排障 (1)', '排障 (2)'],
      'the reservation must outlive fork RTT + rename RTT (two mutation budgets)')
  } finally { Date.now = originalNow; facts.off(); probe() }
})

test('fork title skip-taken: a reservation covers both fork and rename RTT (100s + 100s, re-fork at t+200s)', async () => {
  const sourceId = 'fork-title-dual-budget'
  const probe = reportSnapshot(sourceId, [sessionRow('source-1', 0, { title: '排障' })])
  const client = getInstanceClient(sourceId)
  const pendingForks: Array<(value: UnaryResult<unknown>) => void> = []
  const pendingRenames: Array<(value: UnaryResult<unknown>) => void> = []
  const renames: unknown[] = []
  const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })
  client.session.fork = (): Promise<UnaryResult<unknown>> => new Promise(resolve => { pendingForks.push(resolve) })
  client.session.rename = (payload: unknown): Promise<UnaryResult<unknown>> => {
    renames.push(payload)
    return new Promise(resolve => { pendingRenames.push(resolve) })
  }
  const facts = collectFacts(sourceId)
  const originalNow = Date.now
  let now = 3_000_000
  Date.now = () => now
  try {
    const first = forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal(pendingForks.length, 1)
    now += 100_000 // the fork RPC stays in flight for one budget
    pendingForks[0]({ ok: true, value: { sessionId: 'child-1' } })
    await tick()
    assert.equal(pendingRenames.length, 1, 'the rename starts after the fork resolves')
    now += 100_000 // the rename RPC stays in flight for one budget
    pendingRenames[0]({ ok: true, value: { title: (renames[0] as { title?: string }).title ?? '', seq: 3 } })
    await first
    // t = t0 + 200s: a second fork lands before the authority lists (1)
    const second = forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal(pendingForks.length, 2, 'the second fork starts at t+200s')
    pendingForks[1]({ ok: true, value: { sessionId: 'child-2' } })
    await tick()
    pendingRenames[1]({ ok: true, value: { title: (renames[1] as { title?: string }).title ?? '', seq: 3 } })
    await second
    assert.deepEqual(facts.created.map(fact => fact.title), ['排障 (1)', '排障 (2)'],
      'the naming→authority window covers fork + rename RTTs')
  } finally { Date.now = originalNow; facts.off(); probe() }
})

test('fork title skip-taken: at 401s the reservation retires and the number is reusable', async () => {
  const sourceId = 'fork-title-reservation-expiry'
  const stubs = stubForkAndRename(sourceId, ['child-1', 'child-2'])
  const probe = reportSnapshot(sourceId, [sessionRow('source-1', 0, { title: '排障' })])
  const facts = collectFacts(sourceId)
  const originalNow = Date.now
  let now = 4_000_000
  Date.now = () => now
  try {
    await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal((stubs.renames[0] as { title?: string }).title, '排障 (1)')
    now += 401_000 // one second past the two-budget TTL
    await forkSessionForSource(sourceId, 'source-1', { increaseTitleFrom: '排障' })
    assert.equal((stubs.renames[1] as { title?: string }).title, '排障 (1)',
      'the expired reservation no longer blocks the number')
  } finally { Date.now = originalNow; facts.off(); probe() }
})
