/**
 * workspace-mutations.ts 行为测试（design 05 §2.2.1 唯一事实出口）。
 *
 * 接线锁（workspace-echo.test.ts / workspace-funnel-wiring.test.ts）只证明**调用
 * 形状**；这里补的是出口**运行时契约**本身（此前的残余风险）：
 * - 事实在 wire 成功后发布，携带宿主返回的 workspaceId 与 **canonical path**
 *   （不是浏览器侧那条可能含符号链接的请求路径）以及可选锚点；
 * - 装饰（beforePublish）在事实**之前**、同一同步续体里运行——"回声行首帧就是
 *   最终形态"由此成为结构保证，而不是 React 调度巧合；
 * - 装饰抛错被吞掉：宿主上的创建**已经提交**，渲染期装饰绝不能把成功变成 saga
 *   的失败/补偿分支；
 * - 事实是稀疏的：没有锚点时 afterWorkspaceId 字段根本不出现。
 *
 * 打桩方式：`getInstanceClient` 按 instanceId 缓存同一个 InstanceApiClient，直接
 * 替换该缓存对象的 `workspace.create`。真实 wire 在这里是 fetch（node 发不出），
 * 但其余链路——callAndThrow 的错误折叠与 decodeWorkspaceCreateValue 的结构校验
 * ——全部走真代码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge } from '../../src/shared/aggregate-store.ts'
import { getInstanceClient, type UnaryResult, releaseInstanceClient } from '../../src/shared/instance-api.ts'
import { createWorkspaceForSource } from '../../src/shared/workspace-mutations.ts'

/** Replace the cached client's create face with a canned host answer. */
function stubCreate(sourceId: string, value: unknown): { calls: number } {
  const client = getInstanceClient(sourceId)
  const counter = { calls: 0 }
  client.workspace.create = async (): Promise<UnaryResult<unknown>> => {
    counter.calls += 1
    return { ok: true, value }
  }
  return counter
}

function collectFacts(sourceId: string): { facts: Record<string, unknown>[]; off: () => void } {
  const facts: Record<string, unknown>[] = []
  const off = chamberBridge.onWorkspaceCreated((fact) => {
    if (fact.sourceId === sourceId) facts.push({ ...fact })
  })
  return { facts, off }
}

test('the funnel publishes the HOST identity (id + canonical path) with the requested anchor', async () => {
  const sourceId = 'funnel-test-identity'
  const stub = stubCreate(sourceId, { workspace: { workspaceId: 'w1', path: '/canonical/path' }, created: true })
  const { facts, off } = collectFacts(sourceId)
  try {
    const created = await createWorkspaceForSource(sourceId, 'picked/lexical/path', { afterWorkspaceId: 'main' })
    assert.deepEqual(
      created,
      { workspaceId: 'w1', path: '/canonical/path', created: true },
      'the host canonical path wins over the requested spelling (symlinked picks)',
    )
    assert.equal(stub.calls, 1, 'exactly one wire call')
    assert.deepEqual(facts, [{ sourceId, workspaceId: 'w1', path: '/canonical/path', afterWorkspaceId: 'main' }])
  } finally {
    off()
    releaseInstanceClient(sourceId)
  }
})

test('the title hint rides the fact, so the echoed row is born with its final label', async () => {
  const sourceId = 'funnel-test-title'
  stubCreate(sourceId, { workspace: { workspaceId: 'w4', path: '/p/4' }, created: true })
  const { facts, off } = collectFacts(sourceId)
  try {
    await createWorkspaceForSource(sourceId, '/p/4', { title: 'feature/x' })
    assert.deepEqual(facts, [{ sourceId, workspaceId: 'w4', path: '/p/4', title: 'feature/x' }])
  } finally {
    off()
    releaseInstanceClient(sourceId)
  }
})

test('a host-reused registration (created: false) still publishes: the fact is "it exists on that host"', async () => {
  const sourceId = 'funnel-test-reuse'
  stubCreate(sourceId, { workspace: { workspaceId: 'w2', path: '/p/2' }, created: false })
  const { facts, off } = collectFacts(sourceId)
  try {
    const created = await createWorkspaceForSource(sourceId, '/p/2')
    assert.equal(created.created, false)
    assert.equal(facts.length, 1, 'adopting an existing registration is still a fact the projection must hear')
    assert.equal('afterWorkspaceId' in (facts[0] ?? {}), false, 'the fact is sparse without an anchor')
    assert.equal('title' in (facts[0] ?? {}), false, 'the fact is sparse without a title hint')
  } finally {
    off()
    releaseInstanceClient(sourceId)
  }
})

test('decorations run BEFORE the fact, and a throwing decoration never aborts the create', async () => {
  const sourceId = 'funnel-test-decoration'
  stubCreate(sourceId, { workspace: { workspaceId: 'w3', path: '/p/3' }, created: true })
  const order: string[] = []
  const off = chamberBridge.onWorkspaceCreated((fact) => {
    if (fact.sourceId === sourceId) order.push('fact')
  })
  // The swallowed failure must still be loud in the console (silent success is
  // a different bug): capture it here so the runner output stays clean AND the
  // logging contract is asserted.
  const logged: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    const created = await createWorkspaceForSource(sourceId, '/p/3', {
      beforePublish: () => {
        order.push('decorate')
        throw new Error('decoration exploded')
      },
    })
    assert.deepEqual(order, ['decorate', 'fact'], 'the decoration must run first: the row is born in its final shape')
    assert.equal(
      created.workspaceId,
      'w3',
      'a decoration failure is swallowed — a committed host mutation must never become a saga failure',
    )
  } finally {
    console.error = originalError
    off()
    releaseInstanceClient(sourceId)
  }
  assert.equal(logged.length, 1, 'the swallowed decoration failure is logged exactly once, never silent')
  assert.match(String(logged[0]?.[0] ?? ''), /workspace create decoration failed/)
})
