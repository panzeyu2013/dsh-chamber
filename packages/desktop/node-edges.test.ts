/**
 * node-edges.test.ts —— Swift flavor HostEdges 入站面单测
 *
 * 覆盖 design 25 §4.5（深链入队）/§5 E19（渲染器生命周期三事件映射）
 * 两条保留入站 method 的分派契约，以及既有 hostFacts 事实缓存回归：
 *  ① 保留 method 名与 core 侧拼写逐字一致（sidecar-entry 与 Swift 共用同一表）；
 *  ② __host.deepLink 命中注入汇（url 原样透传）——core enqueueDeepLink 的
 *     归一化去重留在 core，本层只做传输层校验；
 *  ③ 缺 url / 未注入汇 → loud 拒绝（绝不静默丢弃用户可见动作）；
 *  ④ __host.rendererLifecycle 命中注入汇，未知事件 → loud；
 *  ⑤ 未注入汇 → loud；
 *  ⑥ hostFacts 仍刷新同步门缓存（回归）；
 *  ⑦ 未知 __host.* → loud；
 *  ⑩ 通知 click 路由生命周期（shown 后仍可激活 / 显示失败即注销 / 来源退役即注销 /
 *     未知 id 静默 ok）；
 *  ⑪ showNativeNotification edge 载荷 {notificationId, spec, sourceId}（D1a 线
 *     协议：sourceId 与 retireNotifications 用的是同一个标识）；
 *  ⑫ retireNotificationsForSources 返回真实驱逐数；
 *  ⑬ setBadge 走 edge 回执面（失败 loud、主线程忙有界重试，同步返回
 *     乐观 applied 的契约限制注记）；
 *  ⑭ 非交互腿有界队列（合流最新载荷 / 确定性失败不空转 / 放弃时明确 loud）；
 *  ⑮ 退出在途拒绝形状与 Electron renderer-trust 的 app_quitting 围栏逐字同形（D1c）。
 * 纯逻辑（无子进程、无 sidecar spawn）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createNodeEdges,
  HOST_INBOUND,
  HOST_RENDERER_LIFECYCLE_EVENTS,
  NATIVE_UPDATE_PHASES,
  QUIT_INBOUND_ERROR,
  type HostRendererLifecycleEvent,
} from './node-edges.ts'
import { rendererPushDelivered } from './shell-core.ts'
import { createTrustedIpc } from './renderer-trust.ts'

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
    nativeUpdatePhase: '__host.nativeUpdatePhase',
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
  // 保守默认：未收到 hostFacts 前，存活类事实按
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

test('⑩ 通知 click 路由：shown 后仍可激活、显示失败/来源退役即注销、未知 id 静默 ok', async () => {
  const activated: number[] = []
  const token = { sourceId: 'src-1', fingerprint: 'f'.repeat(64), generation: 1 }
  let failShow = false
  const edges = createNodeEdges({
    sendEdge: async (method: string) => {
      if (method === 'showNativeNotification') {
        if (failShow) throw new Error('show failed')
        return { shown: true }
      }
      return null
    },
    sendNotify: () => {},
  })
  // 显示成功：click 路由必须存活到 click（Electron 同语义；core 从不调 dispose）。
  const shown = edges.showNativeNotification({ title: 't', body: 'b' }, {
    token,
    onActivated: () => activated.push(1),
  })
  await shown.shown
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 1 }), { ok: true })
  assert.deepEqual(activated, [1], 'shown 之后的点击必须回灌 onActivated（原缺陷：shown 即注销）')
  // 显示失败：没有可点的横幅 → 路由立即注销（点击静默 ok，绝不误激活）。
  failShow = true
  const failed = edges.showNativeNotification({ title: 't2', body: 'b2' }, {
    token,
    onActivated: () => activated.push(2),
  })
  await failed.shown
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 2 }), { ok: true })
  assert.deepEqual(activated, [1], '显示失败的通知不得保留 click 路由')
  // 来源退役：该来源的路由随对象消亡（OS 横幅清除在 Swift 侧，本层只注销回灌）。
  const retired = edges.showNativeNotification({ title: 't3', body: 'b3' }, {
    token,
    onActivated: () => activated.push(3),
  })
  await retired.shown
  edges.retireNotificationsForSources(new Set(['src-1']))
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 3 }), { ok: true })
  assert.deepEqual(activated, [1], '退役来源的通知点击不再回灌')
  // 未知 id：横幅已被系统/淘汰回收——静默 ok（Swift 侧已自行恢复窗口）。
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 99 }), { ok: true })
  assert.deepEqual(activated, [1])
})

test('⑪ showNativeNotification edge 载荷含 {notificationId, spec, sourceId}（D1a 线协议）', async () => {
  const edgesSent: Array<{ method: string; payload: Record<string, unknown> }> = []
  const notifies: Array<{ event: string; payload: unknown }> = []
  const edges = createNodeEdges({
    sendEdge: async (method, payload) => {
      edgesSent.push({ method, payload: payload as Record<string, unknown> })
      return null
    },
    sendNotify: (event, payload) => notifies.push({ event, payload }),
  })
  const token = { sourceId: 'src-d1a', fingerprint: 'f'.repeat(64), generation: 3 }
  const routed = edges.showNativeNotification({ title: 't', body: 'b' }, {
    token,
    onActivated: () => {},
  })
  await routed.shown
  assert.deepEqual(edgesSent, [{
    method: 'showNativeNotification',
    payload: {
      notificationId: 1,
      spec: { title: 't', body: 'b' },
      sourceId: 'src-d1a',
    },
  }], 'Swift 侧据 sourceId 建 sourceId→identifier 登记表（retireNotifications 清横幅）')
  // 'test' 通知（clickRoute=null）：无来源 → sourceId 必须为 null（Swift 侧不登记）。
  const bare = edges.showNativeNotification({ title: 't2', body: 'b2' }, null)
  await bare.shown
  assert.deepEqual(edgesSent[1], {
    method: 'showNativeNotification',
    payload: { notificationId: 2, spec: { title: 't2', body: 'b2' }, sourceId: null },
  })
  // 同一标识回链：退役通知用的 sourceIds 与已投递 payload 的 sourceId 逐字一致。
  edges.retireNotificationsForSources(new Set([edgesSent[0]!.payload.sourceId as string]))
  assert.deepEqual(notifies, [{
    event: 'retireNotifications',
    payload: { sourceIds: ['src-d1a'], notificationIds: [1] },
  }])
})

test('⑫ S2·F7 retireNotificationsForSources 返回真实驱逐数（不再是恒 0）', async () => {
  const notifies: Array<{ event: string; payload: unknown }> = []
  const activated: string[] = []
  const edges = createNodeEdges({
    sendEdge: async () => null,
    sendNotify: (event, payload) => notifies.push({ event, payload }),
  })
  const token = (sourceId: string) => ({ sourceId, fingerprint: 'f'.repeat(64), generation: 1 })
  let nextId = 0
  for (const sourceId of ['src-retire-1', 'src-retire-2', 'src-keep']) {
    nextId += 1
    const id = nextId
    const route = edges.showNativeNotification({ title: 't', body: 'b' }, {
      token: token(sourceId),
      onActivated: () => activated.push(sourceId),
    })
    await route.shown
    // 记录 notificationId（showNativeNotification 自增：1、2、3）
    assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: id }), { ok: true })
  }
  assert.deepEqual(activated, ['src-retire-1', 'src-retire-2', 'src-keep'], '退役前三条路由都可点击')

  const retired = edges.retireNotificationsForSources(new Set(['src-retire-1', 'src-retire-2']))
  // 契约口径 = 驱逐数（shell-core.ts:737 / electron-edges.ts:291-300 同款）：
  // 必须返回本层真实驱逐的 click 路由数，而不是恒 0。
  assert.equal(retired, 2, '必须返回真实驱逐的 click 路由数')
  assert.deepEqual(notifies, [{
    event: 'retireNotifications',
    payload: {
      sourceIds: ['src-retire-1', 'src-retire-2'],
      // 本次退役实际驱逐的本地 notificationId（1、2）一并下发，Swift 侧
      // 按 identifier 精确清横幅（sourceIds 供旧消费端/整源退役路径）。
      notificationIds: [1, 2],
    },
  }], 'Swift 宿主按 sourceId + identifier 清横幅')

  activated.length = 0
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 1 }), { ok: true })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 2 }), { ok: true })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 3 }), { ok: true })
  assert.deepEqual(activated, ['src-keep'], '只驱逐退役来源的 click 路由；保留来源仍可点击')
})

test('⑬ S2·F7/V1 setBadge 走 edge 回执面：乐观返回不变、失败 loud、主线程忙有界重试', async () => {
  const logged: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
  try {
    const attempts: Array<{ method: string; payload: unknown }> = []
    let busyRemaining = 2
    const edges = createNodeEdges({
      nonInteractiveRetryDelayMs: 5,
      // setBadge 在已确证无主窗时同步回 applied:false；正常路径需要
      // hostFacts 声明主窗存活（sidecar-entry 装配种子同值）。
      hostFacts: { mainWindowAlive: true },
      sendEdge: async (method, payload) => {
        attempts.push({ method, payload })
        if (busyRemaining > 0) {
          busyRemaining -= 1
          throw new Error('swift-edge-ui-unavailable:setBadge:main-thread-busy')
        }
        return null
      },
      sendNotify: () => { throw new Error('setBadge 不得再走 notify（原实现无任何失败答案）') },
    })
    // HostEdges.setBadge 是同步契约：立即返回乐观 applied（真应答在飞）。
    assert.deepEqual(edges.setBadge(3), { applied: true })
    assert.deepEqual(attempts, [{ method: 'setBadge', payload: { count: 3 } }], '首送立即发生且走 edge')
    // 2 次 main-thread-busy（每次间隔 5ms 注入）→ 第 3 次成功；成功不得 loud。
    await new Promise<void>((resolve) => setTimeout(resolve, 120))
    assert.equal(attempts.length, 3, '主线程忙必须重试到成功（有界排队）')
    assert.deepEqual(attempts.every((a) => a.method === 'setBadge' && (a.payload as { count: number }).count === 3), true)
    assert.deepEqual(logged, [], '重试成功不得 loud')

    // 有界窗口内始终忙 → 明确文案 loud 一次（绝不静默丢弃）。
    const alwaysBusy: number[] = []
    const failing = createNodeEdges({
      nonInteractiveRetryDelayMs: 2,
      sendEdge: async () => {
        alwaysBusy.push(1)
        throw new Error('swift-edge-ui-unavailable:showError:main-thread-busy')
      },
      sendNotify: () => {},
    })
    failing.showError('打开失败', 'detail')
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    assert.equal(alwaysBusy.length, 6, '有界队列 = 6 次尝试后放弃（不无限重试）')
    assert.equal(logged.length, 1, '放弃时 loud 一次')
    assert.match(logged[0]!, /showError 宿主腿失败（S2·V1 有界排队 6\/6 次后放弃）：swift-edge-ui-unavailable:showError:main-thread-busy/)
  } finally {
    console.error = originalError
  }
})

test('⑭ S2·V1 非交互队列：合流只应用最新载荷；确定性失败不空转、立即 loud', async () => {
  const logged: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
  try {
    // 合流：首送在飞期间 badge 计数被更新 → 重试必须送最新值（旧载荷绝不晚到覆盖）。
    let releaseFirst!: () => void
    const firstInFlight = new Promise<void>((resolve) => { releaseFirst = resolve })
    const attempts: unknown[] = []
    const edges = createNodeEdges({
      nonInteractiveRetryDelayMs: 2,
      hostFacts: { mainWindowAlive: true },
      sendEdge: async (_method, payload) => {
        attempts.push(payload)
        if (attempts.length === 1) {
          await firstInFlight
          throw new Error('swift-edge-ui-unavailable:setBadge:main-thread-busy')
        }
        return null
      },
      sendNotify: () => {},
    })
    edges.setBadge(1)
    edges.setBadge(9) // 合流：替换排队载荷
    releaseFirst()
    await new Promise<void>((resolve) => setTimeout(resolve, 120))
    assert.equal(attempts.length, 2, '首送 + 一次重试')
    assert.deepEqual(attempts, [{ count: 1 }, { count: 9 }], '重试携带最新载荷（badge 计数只应用最后一个）')

    // 确定性失败（no-window 等）：不重试、立即 loud。
    const deterministicAttempts: number[] = []
    const deterministic = createNodeEdges({
      nonInteractiveRetryDelayMs: 2,
      sendEdge: async () => {
        deterministicAttempts.push(1)
        throw new Error('swift-edge-ui-unavailable:showItemInFolder:no-window')
      },
      sendNotify: () => {},
    })
    deterministic.showItemInFolder('/tmp/x')
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    assert.equal(deterministicAttempts.length, 1, '确定性失败绝不空转等待（忙态才重试）')
    assert.equal(logged.length, 1)
    assert.match(logged[0]!, /showItemInFolder 宿主腿失败（S2·V1 有界排队 1\/6 次后放弃）：swift-edge-ui-unavailable:showItemInFolder:no-window/)
  } finally {
    console.error = originalError
  }
})


// --- dual-flavor parity ---

test('P-03: the dead notifyClicked/resolveResource members are gone from the contract and both flavors', () => {
  // The outbound notifyClicked/resolveResource members have no consumer and
  // DIVERGENT Swift semantics (the Swift
  // host ignores an outbound notifyClicked notify loudly; resolveResource always
  // fails without a cache), so the contract drops them rather than keeping an
  // unsyncable face; deleting only one side would silently resurrect a member.
  // The inbound __host.notifyClicked click-feedback
  // method is NOT the outbound member and must survive.
  const edges = makeEdges() as unknown as Record<string, unknown>
  assert.equal('notifyClicked' in edges, false, 'outbound notifyClicked member must be gone')
  assert.equal('resolveResource' in edges, false, 'resolveResource member must be gone')

  const core = readFileSync(new URL('./shell-core.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(core, /notifyClicked\(openIntent/, 'HostEdges must not declare the outbound member')
  assert.doesNotMatch(core, /resolveResource\(kind/, 'HostEdges must not declare resolveResource')
  assert.doesNotMatch(core, /HostResourceKind/, 'the resource-kind contract type goes with the member')

  const electron = readFileSync(new URL('./electron-edges.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(electron, /notifyClicked\(openIntent/, 'Electron must not implement the removed member')
  assert.doesNotMatch(electron, /resolveResource\(kind/, 'Electron must not implement the removed member')

  // The live inbound click feedback (Swift -> core) still dispatches.
  assert.equal(typeof edges.handleHostInbound, 'function')
  const bound = edges.handleHostInbound as (method: string, payload: unknown) => unknown
  assert.deepEqual(bound(HOST_INBOUND.notifyClicked, { notificationId: 999 }), { ok: true })
})

test('G14: the delivered gate is one shared predicate in both flavor implementations', () => {
  // Both flavors must fold the delivered gate through the shared
  // rendererPushDelivered predicate: a flavor that checks only whether the
  // window object exists marks a crashed renderer "delivered" while the other
  // does not, so core hold/rollback/ready-reset
  // could silently diverge. The
  // Electron webViewContentAlive fact carries the isCrashed predicate.
  assert.equal(rendererPushDelivered(true, true), true)
  assert.equal(rendererPushDelivered(false, true), false, 'no window -> not delivered')
  assert.equal(rendererPushDelivered(true, false), false, 'crashed renderer -> not delivered')
  assert.equal(rendererPushDelivered(false, false), false)

  const node = readFileSync(new URL('./node-edges.ts', import.meta.url), 'utf8')
  assert.match(node, /const delivered = rendererPushDelivered\(facts\.mainWindowAlive, facts\.webViewContentAlive\)/)
  const electron = readFileSync(new URL('./electron-edges.ts', import.meta.url), 'utf8')
  assert.match(electron, /rendererPushDelivered\(windowAlive, webContentsAlive\(win\)\)/)
  assert.match(electron, /!win\.webContents\.isCrashed\(\)/)
})
test('⑮ 退出在途拒绝形状与 Electron app_quitting 围栏逐字同形（D1c）', () => {
  assert.deepEqual(QUIT_INBOUND_ERROR, { error: 'app is quitting', code: 'app_quitting' })
  // 单一事实源断言：Electron 侧 trustedIpc 的退出围栏（renderer-trust.ts）抛出的
  // 错误 message/code 必须与 sidecar 帧里回的字面量一致（镜像而非复制漂移）。
  const fence = createTrustedIpc({ isTrustedSender: () => true, isQuitting: () => true })
  assert.throws(
    () => fence(() => 'handler-must-not-run')({ sender: null }),
    (error: unknown) => {
      assert.equal((error as Error).message, QUIT_INBOUND_ERROR.error)
      assert.equal((error as { code?: string }).code, QUIT_INBOUND_ERROR.code)
      return true
    },
  )
})

test('⑯ __host.nativeUpdatePhase：八值相位 + 可空 version/error 校验，合法即入汇（S-19/S-21）', () => {
  const seen: Array<{ phase: string; version: string | null; error: string | null }> = []
  const edges = createNodeEdges({
    sendEdge: async () => null,
    sendNotify: () => {},
    nativeUpdatePhase: (input) => seen.push(input),
  })
  for (const phase of NATIVE_UPDATE_PHASES) {
    assert.deepEqual(
      edges.handleHostInbound(HOST_INBOUND.nativeUpdatePhase, { phase, version: '0.3.0', error: null }),
      { ok: true },
      `合法相位 ${phase} 必须入汇`,
    )
  }
  assert.deepEqual(seen.map(i => i.phase), [...NATIVE_UPDATE_PHASES])
  // version/error 缺省 = null（合法）；string 原样透传。
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.nativeUpdatePhase, { phase: 'failed', error: 'boom' }), { ok: true })
  assert.deepEqual(seen.at(-1), { phase: 'failed', version: null, error: 'boom' })
  // 非法相位 / 非 string|null 类型 → loud 拒绝，绝不猜测映射。
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.nativeUpdatePhase, { phase: 'nope' }), {
    ok: false,
    error: 'sidecar-edges:native-update-phase-invalid-phase:nope',
  })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.nativeUpdatePhase, {}), {
    ok: false,
    error: 'sidecar-edges:native-update-phase-invalid-phase:',
  })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.nativeUpdatePhase, { phase: 'failed', version: 42 }), {
    ok: false,
    error: 'sidecar-edges:native-update-phase-invalid-version',
  })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.nativeUpdatePhase, { phase: 'failed', error: { oops: true } }), {
    ok: false,
    error: 'sidecar-edges:native-update-phase-invalid-error',
  })
  // 未注入汇 → loud；汇抛错 → loud 且不击穿入站帧。
  const bare = makeEdges()
  assert.deepEqual(bare.handleHostInbound(HOST_INBOUND.nativeUpdatePhase, { phase: 'idle' }), {
    ok: false,
    error: 'sidecar-edges:native-update-phase-sink-unavailable',
  })
  const throwing = createNodeEdges({
    sendEdge: async () => null,
    sendNotify: () => {},
    nativeUpdatePhase: () => { throw new Error('ctx not ready') },
  })
  assert.deepEqual(throwing.handleHostInbound(HOST_INBOUND.nativeUpdatePhase, { phase: 'idle' }), {
    ok: false,
    error: 'sidecar-edges:native-update-phase-failed:ctx not ready',
  })
})

test('⑰ P-06：showNativeNotification 按 honest-show 应答折算；显式失败注销 click 路由', async () => {
  let reply: unknown = null
  const edges = createNodeEdges({
    sendEdge: async () => reply,
    sendNotify: () => {},
  })
  const activated: number[] = []
  const token = { sourceId: 'src-p06', fingerprint: 'f'.repeat(64), generation: 1 }
  // 显式失败（未授权 / 调度失败 / 有界超时）→ shown:false，core 据此释放去重 claim。
  reply = { shown: false, error: 'not authorized' }
  const denied = edges.showNativeNotification({ title: 't', body: 'b' }, { token, onActivated: () => activated.push(1) })
  assert.deepEqual(await denied.shown, { shown: false, error: 'not authorized' })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 1 }), { ok: true })
  // 注意：不能 deepEqual(activated, [])——node:assert 的断言签名会把数组窄化成
  // never[]，后续 push 会误报类型错误。长度断言表达同一事实。
  assert.equal(activated.length, 0, '失败通知不得保留 click 路由')
  // 显式成功 / 旧协议 null 应答仍是 shown:true。
  reply = { shown: true }
  const ok = edges.showNativeNotification({ title: 't', body: 'b' }, { token, onActivated: () => activated.push(2) })
  assert.deepEqual(await ok.shown, { shown: true })
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 2 }), { ok: true })
  assert.deepEqual(activated, [2])
  reply = null
  const legacy = edges.showNativeNotification({ title: 't', body: 'b' }, null)
  assert.deepEqual(await legacy.shown, { shown: true }, '旧线协议的 null 应答保持 shown:true')
  // 不认识的形状绝不采信为成功。
  reply = { ok: true }
  const weird = edges.showNativeNotification({ title: 't', body: 'b' }, null)
  assert.deepEqual(await weird.shown, {
    shown: false,
    error: 'native notification leg returned an unrecognized outcome',
  })
})

test('⑱ P-07：>16 淘汰逐条按 identifier 清横幅（retire payload 携带 notificationIds）', async () => {
  const notifies: Array<{ event: string; payload: unknown }> = []
  const activated: string[] = []
  const edges = createNodeEdges({
    sendEdge: async () => null,
    sendNotify: (event, payload) => notifies.push({ event, payload }),
  })
  const token = (sourceId: string) => ({ sourceId, fingerprint: 'f'.repeat(64), generation: 1 })
  for (let i = 1; i <= 16; i += 1) {
    const route = edges.showNativeNotification({ title: 't', body: 'b' }, {
      token: token(`src-${i}`),
      onActivated: () => activated.push(`src-${i}`),
    })
    await route.shown
  }
  assert.deepEqual(notifies, [], '16 条恰好满员，不触发淘汰/退役')
  // 第 17 条：淘汰最旧（本地 notificationId=1）→ 逐条 identifier 清除；淘汰是
  // 逐条语义，绝不按 sourceId 整源退役（那会误清同源的新横幅）。
  const seventeenth = edges.showNativeNotification({ title: 't', body: 'b' }, {
    token: token('src-17'),
    onActivated: () => activated.push('src-17'),
  })
  await seventeenth.shown
  assert.deepEqual(notifies, [{
    event: 'retireNotifications',
    payload: { sourceIds: [], notificationIds: [1] },
  }])
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 1 }), { ok: true })
  assert.deepEqual(activated, [], '被淘汰通知的 click 路由必须失效')
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.notifyClicked, { notificationId: 17 }), { ok: true })
  assert.deepEqual(activated, ['src-17'], '新通知照常可点击')
})

test('⑲ P-06：已确证无主窗时 setBadge 同步回 applied:false（不再乐观假成功）', async () => {
  const attempts: Array<{ method: string; payload: unknown }> = []
  const edges = createNodeEdges({
    sendEdge: async (method, payload) => {
      attempts.push({ method, payload })
      return null
    },
    sendNotify: () => {},
  })
  // 默认 hostFacts（未声明主窗）→ Swift 腿必以 no-window 拒绝：同步失败且绝不
  // 发起注定失败的 edge。
  assert.deepEqual(edges.setBadge(4), {
    applied: false,
    reason: 'swift-edge-ui-unavailable:setBadge:no-window',
  })
  assert.deepEqual(attempts, [], '无窗失败不得入队/发 edge')
  // hostFacts 声明主窗存活（sidecar-entry 装配种子同值）→ 恢复乐观回执 + 排队。
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.hostFacts, { mainWindowAlive: true }), { ok: true })
  assert.deepEqual(edges.setBadge(4), { applied: true })
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(attempts, [{ method: 'setBadge', payload: { count: 4 } }])
})
