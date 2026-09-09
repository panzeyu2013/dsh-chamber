/**
 * node-edges.test.ts —— Swift flavor HostEdges 入站面单测（W-11 后续批）
 *
 * 覆盖 design 25 §4.5（深链入队）/§5 E19（渲染器生命周期三事件映射）新增的
 * 两条保留入站 method 的分派契约，以及既有 hostFacts 事实缓存回归：
 *  ① 保留 method 名与 core 侧拼写逐字一致（sidecar-entry 与 Swift 共用同一表）；
 *  ② __host.deepLink 命中注入汇（url 原样透传）——core enqueueDeepLink 的
 *     归一化去重留在 core，本层只做传输层校验；
 *  ③ 缺 url / 未注入汇 → loud 拒绝（绝不静默丢弃用户可见动作）；
 *  ④ __host.rendererLifecycle 命中注入汇，未知事件 → loud；
 *  ⑤ 未注入汇 → loud；
 *  ⑥ hostFacts 仍刷新同步门缓存（回归）；
 *  ⑦ 未知 __host.* → loud。
 * 纯逻辑（无子进程、无 sidecar spawn）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createNodeEdges,
  HOST_INBOUND,
  HOST_RENDERER_LIFECYCLE_EVENTS,
  type HostRendererLifecycleEvent,
} from './node-edges.ts'

function makeEdges(overrides: {
  onDeepLink?: (url: string) => void
  onRendererLifecycle?: (event: HostRendererLifecycleEvent) => void
  projectQuitFacts?: (input: { quitRequested: boolean; recoveryAvailable: boolean }) => {
    hideOnClose: boolean
    quitNeedsConfirm: boolean
    quitReasons: string[]
  }
} = {}) {
  return createNodeEdges({
    sendEdge: async () => null,
    sendNotify: () => {},
    ...overrides,
  })
}

test('① 保留 method 名与 core 拼写一致（含 E13/E19/E20 新增三条）', () => {
  assert.deepEqual(HOST_INBOUND, {
    notifyClicked: '__host.notifyClicked',
    systemResume: '__host.systemResume',
    mainWindowShown: '__host.mainWindowShown',
    hostFacts: '__host.hostFacts',
    deepLink: '__host.deepLink',
    rendererLifecycle: '__host.rendererLifecycle',
    quitFacts: '__host.quitFacts',
  })
  assert.deepEqual([...HOST_RENDERER_LIFECYCLE_EVENTS], [
    'did-start-loading',
    'did-finish-load',
    'crashed',
    'closed',
  ])
})

test('② __host.deepLink 透传 url 到注入汇', () => {
  const seen: string[] = []
  const edges = makeEdges({ onDeepLink: (url) => seen.push(url) })
  const outcome = edges.handleHostInbound(HOST_INBOUND.deepLink, {
    url: 'dsh-chamber://open-vscode?instanceId=abc&path=%2Ftmp',
  })
  assert.deepEqual(outcome, { ok: true })
  assert.deepEqual(seen, ['dsh-chamber://open-vscode?instanceId=abc&path=%2Ftmp'])
})

test('③ __host.deepLink 缺 url / 未注入汇 → loud 拒绝', () => {
  const edges = makeEdges({ onDeepLink: () => {} })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.deepLink, {}), {
    ok: false,
    error: 'sidecar-edges:deep-link-missing-url',
  })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.deepLink, { url: 42 }), {
    ok: false,
    error: 'sidecar-edges:deep-link-missing-url',
  })
  const bare = makeEdges()
  assert.deepEqual(bare.handleHostInbound(HOST_INBOUND.deepLink, { url: 'dsh-chamber://x' }), {
    ok: false,
    error: 'sidecar-edges:deep-link-sink-unavailable',
  })
})

test('④ __host.rendererLifecycle 命中注入汇，未知事件 loud', () => {
  const seen: string[] = []
  const edges = makeEdges({ onRendererLifecycle: (event) => seen.push(event) })
  for (const event of HOST_RENDERER_LIFECYCLE_EVENTS) {
    assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.rendererLifecycle, { event }), { ok: true })
  }
  assert.deepEqual(seen, [...HOST_RENDERER_LIFECYCLE_EVENTS])
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.rendererLifecycle, { event: 'zzz' }), {
    ok: false,
    error: 'sidecar-edges:unknown-renderer-lifecycle:zzz',
  })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.rendererLifecycle, {}), {
    ok: false,
    error: 'sidecar-edges:unknown-renderer-lifecycle:',
  })
})

test('⑤ __host.rendererLifecycle 未注入汇 → loud 拒绝', () => {
  const edges = makeEdges()
  assert.deepEqual(
    edges.handleHostInbound(HOST_INBOUND.rendererLifecycle, { event: 'crashed' }),
    { ok: false, error: 'sidecar-edges:renderer-lifecycle-sink-unavailable' },
  )
})

test('⑥ __host.hostFacts 仍刷新同步门缓存（回归）+ 交付信号诚实', () => {
  const edges = makeEdges()
  // 保守默认（2026-09 模块评审 low #4）：未收到 hostFacts 前，存活类事实按
  // 「未知 = 不可交付」——rendererPush 必须诚实返回 false（core 据此 hold）。
  assert.equal(edges.webViewContentAlive(), false)
  assert.equal(edges.isFocused(), false)
  assert.equal(edges.rendererPush('dsh-chamber:test', {}), false, '未知存活 → 未投递')
  assert.deepEqual(
    edges.handleHostInbound(HOST_INBOUND.hostFacts, {
      focused: true,
      mainWindowAlive: true,
      webViewContentAlive: true,
      webViewLoading: true,
    }),
    { ok: true },
  )
  assert.equal(edges.isFocused(), true)
  assert.equal(edges.webViewContentAlive(), true)
  assert.equal(edges.webViewLoading(), true)
  assert.equal(edges.rendererPush('dsh-chamber:test', {}), true, '存活 → 已投递')

  // 渲染器死掉后交付信号必须回到 false（不静默丢事件）。
  edges.handleHostInbound(HOST_INBOUND.hostFacts, { webViewContentAlive: false })
  assert.equal(edges.rendererPush('dsh-chamber:test', {}), false)
})

test('⑦ 未知 __host.* → loud 拒绝', () => {
  const edges = makeEdges()
  assert.deepEqual(edges.handleHostInbound('__host.zzz', {}), {
    ok: false,
    error: 'sidecar-edges:unknown-host-inbound:__host.zzz',
  })
})

test('⑧ __host.quitFacts 返回注入投影的决策（E1/E9/E20）', () => {
  const seen: Array<{ quitRequested: boolean; recoveryAvailable: boolean }> = []
  const edges = makeEdges({
    projectQuitFacts: (input) => {
      seen.push(input)
      return { hideOnClose: !input.quitRequested, quitNeedsConfirm: true, quitReasons: ['正在运行的本地 dsh 实例'] }
    },
  })
  const outcome = edges.handleHostInbound(HOST_INBOUND.quitFacts, {
    quitRequested: false,
    recoveryAvailable: true,
  })
  assert.deepEqual(outcome, {
    ok: true,
    result: { hideOnClose: true, quitNeedsConfirm: true, quitReasons: ['正在运行的本地 dsh 实例'] },
  })
  assert.deepEqual(seen, [{ quitRequested: false, recoveryAvailable: true }])
})

test('⑨ __host.quitFacts 入参非法 / 未注入汇 → loud 拒绝', () => {
  const edges = makeEdges({
    projectQuitFacts: () => ({ hideOnClose: true, quitNeedsConfirm: false, quitReasons: [] }),
  })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.quitFacts, {}), {
    ok: false,
    error: 'sidecar-edges:quit-facts-invalid-input',
  })
  assert.deepEqual(
    edges.handleHostInbound(HOST_INBOUND.quitFacts, { quitRequested: 'yes', recoveryAvailable: true }),
    { ok: false, error: 'sidecar-edges:quit-facts-invalid-input' },
  )
  const bare = makeEdges()
  assert.deepEqual(
    bare.handleHostInbound(HOST_INBOUND.quitFacts, { quitRequested: false, recoveryAvailable: true }),
    { ok: false, error: 'sidecar-edges:quit-facts-sink-unavailable' },
  )
})
