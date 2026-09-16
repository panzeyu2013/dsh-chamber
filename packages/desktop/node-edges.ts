/**
 * node-edges.ts —— HostEdges 的 Swift-flavor 实现（W-11；design 25 §4.4.2）
 *
 * 与 electron-edges.ts（Electron flavor）对偶：把 shell-core 业务经
 * HostEdges 调用的宿主动作转成 B 桥线协议上的 edge 请求/notify 发给 Swift
 * 壳执行（design 25 §3.1 进程模型：sidecar 无窗口/原生 UI——全部宿主腿在
 * Swift 侧）。本文件与 sidecar-entry.ts 同属 Electron-free core 家族
 * （electron-free-gate 面 A）：零 electron import、零 stdout 直写（协议写
 * 一律经 deps.sendEdge/sendNotify）。
 *
 * 语义策略（与 electron-edges 的差异逐条注记，M3 Swift 侧落地时复核）：
 * - 往返类（异步方法）→ sendEdge(method, payload) 等应答；ok:false → 抛
 *   Error(error)（调用方 loud）；ok → 按方法返回形态折算。
 * - 同步门类（trayAvailable/isFocused/webViewLoading/webViewContentAlive/
 *   mainWindowAlive/badgeCountApiAvailable/notificationSupported）→ 缓存 +
 *   __host.hostFacts 刷新（Swift 侧在窗口/聚焦/加载事实变化时推送）；初始
 *   值经 deps.hostFacts 种子（缺省：trayAvailable true（mac Dock 语义）、
 *   isFocused false、webViewLoading false、webViewContentAlive true、
 *   mainWindowAlive true、badgeCountApiAvailable true、
 *   notificationSupported true）。缓存近似为 v1 语义——同步契约无法跨进程
 *   往返，事实推送在 M3 Swift 侧实现。
 * - rendererPush → sendNotify('rendererPush', {channel,payload}) 并返回 true
 *   （fire-and-forget；Swift 侧 ACK 化前为尽力语义，M3 复核）。
 * - resolveResource（同步 string 契约）→ 同样无法往返：路径缓存经
 *   deps.hostFacts.resources（Swift ready 后推送）；缺失即 loud 抛
 *   'sidecar-edges:resource-not-cached:<kind>'。
 * - 通知 click 回灌 + 退役清除（D1a 线协议，Swift 侧按此消费）：
 *   showNativeNotification 为每条通知分配本地 notificationId，edge payload =
 *   {notificationId, spec, sourceId}——sourceId 取 clickRoute.token.sourceId
 *   （'test' 通知/无路由 = null）。Swift 侧按 sourceId 登记「已投递」通知的
 *   UNUserNotificationCenter identifier，使随后 notify retireNotifications
 *   {sourceIds} 能真正 removeDeliveredNotifications 清横幅（无登记表时只能
 *   no-op）；点击（先自行 activate/restore/focus，语义 = electron-edges 宿主
 *   click 腿）后以入站 __host.notifyClicked {notificationId} 通知本层，命中则
 *   调用该条 clickRoute.onActivated()（core 的 owns+入队闭包）。dispose 注销
 *   映射；来源退役时本层按 sourceId 注销 click 路由，横幅由 Swift 侧按同
 *   sourceId 清（两侧同用这一个标识）。
 *
 * 保留入站 host method（由 sidecar-entry 分派到 handleHostInbound）：
 *   __host.notifyClicked    {notificationId}
 *   __host.systemResume     {timestamp}
 *   __host.mainWindowShown  {}
 *   __host.hostFacts        {focused?, mainWindowAlive?, webViewLoading?,
 *                            webViewContentAlive?, trayAvailable?, resources?}
 *   __host.deepLink         {url}      → core enqueueDeepLink（design 25 §4.5：
 *                            Swift application(_:open:) 冷/热启动统一入口）
 *   __host.rendererLifecycle {event}   → core onRendererLifecycle（§5 E19 三事件
 *                            映射：did-start-loading / did-finish-load /
 *                            crashed / closed）
 *
 * S-E（settings 副作用叶 async 化）：公开面新增 sendEdge 转发（NodeEdges
 * 附加成员，不改 HostEdges 契约）——sidecar-ctx 的 A 组设置副作用叶
 * （ShellAssemblyCtx.setKeepAwake/setLoginItem）改经它 await B 桥应答，leg
 * 失败 = reject（与 Electron 同步失败同一回滚路径）；本文件内 HostEdges 的
 * 同步 setKeepAwake/setLoginItem（fire-and-forget + catch loud）不再被 ctx
 * 设置叶调用（避免双写/乐观假成功），保留供后续 HostEdges 面直接使用——
 * 两叶职责分离注记见下方成员注释。
 *
 * - **共享契约面，core 当前不经 Pick 消费（D1e，保留不删）**：
 *   resolveResource / isPackaged / notifyClicked / trayAvailable /
 *   focusMainWindow / launchApp 与同步 setKeepAwake/setLoginItem——core 的
 *   HostEdges Pick（shell-core.ts installIpcHandlers 1802-1821）未收窄到它们，
 *   本仓也暂无调用方；electron-edges 的返回 Pick 同样不含（Electron 侧这些动作
 *   在 main.ts 直做，见其 TODO 段）。它们是 design 25 §4.1 v2 字段集这一共享
 *   契约面（本文件是当前唯一实现；focusMainWindow/launchApp/setKeepAwake/
 *   setLoginItem 的 Swift 宿主腿已在 SwiftEdgeHostLegs 落位），删除会砍掉契约
 *   本身。语义仍须保持诚实（形状/失败语义与契约一致）；改这些成员时两侧同时核对。
 */
import type {
  HostEdges,
  NativeNotificationSpec,
  NotificationSourceToken,
  NotificationOpenIntent,
  HostSetBadgeResult,
  HostPluginSourcePick,
  HostMessageOptions,
  HostResourceKind,
} from './shell-core.ts'
import { MAX_ACTIVE_NATIVE_NOTIFICATIONS } from './notifications.ts'

/** B 桥 host 侧入站 method 名（sidecar-entry 与 Swift 侧共用同一拼写）。 */
export const HOST_INBOUND = {
  notifyClicked: '__host.notifyClicked',
  systemResume: '__host.systemResume',
  mainWindowShown: '__host.mainWindowShown',
  hostFacts: '__host.hostFacts',
  deepLink: '__host.deepLink',
  rendererLifecycle: '__host.rendererLifecycle',
  quitFacts: '__host.quitFacts',
} as const

/** 退出在途的入站拒绝形状（D1c）：与 Electron trustedIpc 退出围栏
 *  （renderer-trust.ts createTrustedIpc）抛出的错误逐字同形——message
 *  'app is quitting' + code 'app_quitting'。sidecar-entry 在 shuttingDown
 *  开始后对迟到的 invoke 帧回 {ok:false, ...QUIT_INBOUND_ERROR}，让两种
 *  flavor 的 renderer 拿到同一个可判别的退出错误（error 字段承载 message）。 */
export const QUIT_INBOUND_ERROR = {
  error: 'app is quitting',
  code: 'app_quitting',
} as const

/** 渲染器生命周期事件（core `RendererLifecycleEvent` 的 wire 子集；Swift 侧
 *  三事件映射见 design 25 §4.5/§5 E19）。 */
export const HOST_RENDERER_LIFECYCLE_EVENTS = [
  'did-start-loading',
  'did-finish-load',
  'crashed',
  'closed',
] as const

export type HostRendererLifecycleEvent = (typeof HOST_RENDERER_LIFECYCLE_EVENTS)[number]

export interface NodeEdgesDeps {
  /** 发 edge 请求并等 Swift 应答（edgeId 关联由调用方保证唯一）。 */
  sendEdge(method: string, payload: unknown): Promise<unknown>
  /** 发单向 notify（不期待应答）。 */
  sendNotify(event: string, payload: unknown): void
  /** 深链入站汇（design 25 §4.5：Swift application(_:open:) → core
   *  enqueueDeepLink 原逻辑）。缺省未注入 → 入站 loud 拒绝（绝不静默丢弃）。 */
  onDeepLink?: (url: string) => void
  /** 渲染器生命周期入站汇（design 25 §5 E19 三事件映射 → core
   *  onRendererLifecycle：ready 位复位 + in-flight requeue/drain）。
   *  缺省未注入 → 入站 loud 拒绝。 */
  onRendererLifecycle?: (event: HostRendererLifecycleEvent) => void
  /** 关窗/退出决策投影（design 25 §5 E1/E9/E20）：输入 = Swift 宿主侧事实
   *  （退出在途 / 恢复入口可用），输出 = core 依据 chamber settings + 本地实例
   *  在跑判据算出的决策。决策逻辑单源在 core（shouldHideToTray /
   *  computeQuitRisk），Swift 不复制。缺省未注入 → 入站 loud 拒绝（宿主拿不到
   *  决策时必须走保守路径，绝不静默放行退出）。 */
  projectQuitFacts?: (input: {
    quitRequested: boolean
    recoveryAvailable: boolean
  }) => { hideOnClose: boolean; quitNeedsConfirm: boolean; quitReasons: string[] }
  /** 同步门缓存初始种子（可选；hostFacts 推送会覆盖）。 */
  hostFacts?: {
    focused?: boolean
    mainWindowAlive?: boolean
    webViewLoading?: boolean
    webViewContentAlive?: boolean
    trayAvailable?: boolean
    badgeCountApiAvailable?: boolean
    notificationSupported?: boolean
    isPackaged?: boolean
    resources?: Partial<Record<HostResourceKind, string>>
  }
}

interface PendingNotificationRoute {
  dispose(): void
  shown: Promise<{ shown: true } | { shown: false; error: string }>
}

/** 序列化安全化：非 JSON 可序列化值（如函数）剔除——edge payload 必须纯数据。 */
function jsonSafe(value: unknown): unknown {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : JSON.parse(text)
  } catch {
    return null
  }
}

export type NodeEdges = HostEdges & {
  handleHostInbound(method: string, payload: unknown): { ok: boolean; result?: unknown; error?: string }
  /** 公开 edge 转发（S-E：NodeEdges 附加成员，不改 HostEdges 契约）——把 B 桥
   *  edge 请求面暴露给装配方（sidecar-entry → buildHeadlessCtx 的
   *  HeadlessCtxEdges），使 sidecar-ctx 的 A 组设置副作用叶能 await 应答：
   *  resolve = Swift leg 应答 ok；reject = transport {ok:false} / leg 错误
   *  （sidecar-entry 应答分派把 ok:false 折算为 reject）。edgeId 关联由
   *  deps.sendEdge 实现侧（sidecar-entry pendingEdges 表）保证。 */
  sendEdge(method: string, payload: unknown): Promise<unknown>
}

export function createNodeEdges(deps: NodeEdgesDeps): NodeEdges {
  // ---- 同步门缓存（v1 近似；hostFacts 刷新） ----
  // 保守默认（2026-09 模块评审 low #4）：**交付门**相关事实在收到 hostFacts
  // 之前按「未知 = 不可交付」处理（Electron 无窗即 false 的同向语义），
  // 否则 ready 前的 rendererPush 会被当成已投递。能力类事实（托盘/角标/
  // 通知支持）保持乐观默认——它们描述平台能力而非实时存活。
  const facts = {
    focused: deps.hostFacts?.focused ?? false,
    mainWindowAlive: deps.hostFacts?.mainWindowAlive ?? false,
    webViewLoading: deps.hostFacts?.webViewLoading ?? false,
    webViewContentAlive: deps.hostFacts?.webViewContentAlive ?? false,
    trayAvailable: deps.hostFacts?.trayAvailable ?? true,
    badgeCountApiAvailable: deps.hostFacts?.badgeCountApiAvailable ?? true,
    notificationSupported: deps.hostFacts?.notificationSupported ?? true,
  }
  const resources = new Map<string, string>()
  for (const [kind, p] of Object.entries(deps.hostFacts?.resources ?? {})) {
    if (typeof p === 'string') resources.set(kind, p)
  }

  // ---- 事件订阅槽（installIpcHandlers ① 段调用 onSystemResume/onMainWindowShown） ----
  let onSystemResumeCb: ((timestamp: number) => void) | null = null
  let onMainWindowShownCb: (() => void) | null = null

  // ---- 通知 click 路由表（notificationId → clickRoute） ----
  /** click 路由上限：与 electron-edges 的活跃原生通知上限同一数字（语义见
   *  showNativeNotification——淘汰只丢路由，不动宿主横幅）。 */
  const MAX_PENDING_NOTIFICATION_ROUTES = MAX_ACTIVE_NATIVE_NOTIFICATIONS
  const clickRoutes = new Map<number, { token: NotificationSourceToken; onActivated(): void }>()
  let nextNotificationId = 1

  const edges: HostEdges = {
    rendererPush(channel, payload) {
      // 交付信号必须诚实（2026-09 模块评审 medium #1）：electron-edges 在无窗
      // 时返回 false，core 据此 hold/rollback/复位 ready 位；Swift flavor 原先
      // 恒 true，会让通知打开/深链/唤醒事件静默丢失。这里按「渲染器存活」事实
      // 返回（未收到 hostFacts 前为 false）。
      const delivered = facts.mainWindowAlive && facts.webViewContentAlive
      // 与 electron-edges 同向：**未投递就不发送**（返回 false 让 core hold 并在
      // 下次生命周期事件重投；若这里仍发，隐藏/已死窗可能收到重复投递）。
      if (delivered) {
        deps.sendNotify('rendererPush', { channel, payload: jsonSafe(payload) })
      }
      return delivered
    },

    showNativeNotification(spec: NativeNotificationSpec, clickRoute) {
      const notificationId = nextNotificationId
      nextNotificationId += 1
      if (clickRoute !== null) {
        clickRoutes.set(notificationId, clickRoute)
        // 有界登记（上限与 electron-edges 的活跃原生通知同源）：淘汰最旧一条只丢
        // click 路由（横幅本身归宿主，无法从这里收回），保证长期运行不无界增长。
        if (clickRoutes.size > MAX_PENDING_NOTIFICATION_ROUTES) {
          const oldest = clickRoutes.keys().next().value
          if (oldest !== undefined) clickRoutes.delete(oldest)
        }
      }
      const result = deps
        .sendEdge('showNativeNotification', {
          notificationId,
          spec: jsonSafe(spec),
          // D1a：退役清横幅所需的来源标识（Swift 侧 sourceId→identifier 登记表）；
          // 'test' 通知（clickRoute=null）无来源 → null（Swift 侧不登记、不退役）。
          sourceId: clickRoute === null ? null : clickRoute.token.sourceId,
        })
        .then(
          () => ({ shown: true as const }),
          (err: unknown) => ({
            shown: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      const route: PendingNotificationRoute = {
        dispose() {
          clickRoutes.delete(notificationId)
        },
        shown: result,
      }
      // 路由存活到 dispose / 来源退役 / 被淘汰：**显示成功不得注销**——click 必然
      // 晚于 shown 结算（Electron 同语义：通知对象的 click 监听持有 route 直到窗口/
      // 来源生命周期结束，core 从不调 dispose）。只有显示失败（没有可点的横幅）
      // 才即时注销。2026-12 审查：原实现在 shown 结算即删除，导致 Swift flavor 的
      // 通知点击永远命中不到路由、静默返回 ok——「点横幅打开会话」整体失效。
      void route.shown.then((outcome) => {
        if (!outcome.shown) clickRoutes.delete(notificationId)
      })
      return route
    },

    notificationSupported() {
      return facts.notificationSupported
    },

    notifyClicked(openIntent: NotificationOpenIntent) {
      // Swift flavor 路径：click 经 __host.notifyClicked + clickRoute 回灌，
      // 本成员保留契约（未用）；若未来 core 直接调用则原样转发 intent。
      deps.sendNotify('notifyClicked', jsonSafe(openIntent))
    },

    setBadge(count: number): HostSetBadgeResult {
      // 同步契约无法往返：乐观 applied + 显式注记（badge 裁决已在 core；
      // Swift 侧 dock 徽标为尽力 UI。M3 复核 ACK 化）。
      deps.sendNotify('setBadge', { count })
      return { applied: true }
    },

    badgeCountApiAvailable() {
      return facts.badgeCountApiAvailable
    },

    trayAvailable() {
      return facts.trayAvailable
    },

    setKeepAwake(on: boolean) {
      // HostEdges 同步面（fire-and-forget + 失败 loud；Swift 侧应答经
      // sendEdge 回来）。S-E 职责分离：sidecar-ctx 的 A 组设置副作用叶（ctx
      // 面）已改走公开 sendEdge await 应答——不经本成员（避免双写与乐观假
      // 成功：settings-set 的失败回滚语义由 ctx 叶 await 决定）。本成员保留
      // 供后续 HostEdges 面直接调用（core 不经 Pick 触碰前保持预留）。
      deps.sendEdge('setKeepAwake', { on }).catch((err: unknown) => {
        console.error('[node-edges] setKeepAwake edge 失败：' + String(err))
      })
    },

    onSystemResume(cb) {
      onSystemResumeCb = cb
    },

    onMainWindowShown(cb) {
      onMainWindowShownCb = cb
    },

    isFocused() {
      return facts.focused
    },

    async focusMainWindow() {
      await deps.sendEdge('focusMainWindow', {})
    },

    webViewLoading() {
      return facts.webViewLoading
    },

    webViewContentAlive() {
      return facts.webViewContentAlive
    },

    mainWindowAlive() {
      return facts.mainWindowAlive
    },

    retireNotificationsForSources(retiredSourceIds: ReadonlySet<string>): number {
      // 已退役来源的 click 路由随对象消亡（electron-edges 的 close 腿同语义），
      // 且本次退役经 notify 交给 Swift 宿主：宿主按 sourceId→已投递标识登记表
      // 调 removeDeliveredNotifications 真正清横幅（NotificationDeliveryRegistry）。
      // 返回值契约是「关闭的原生通知数」——那只在宿主侧可观察，本层同步拿不到
      // 真实条数，故恒返回 0 = 不虚报（两个调用方 main.ts / sidecar-ctx.ts 都
      // 直接丢弃返回值）。
      for (const [id, route] of clickRoutes) {
        if (retiredSourceIds.has(route.token.sourceId)) clickRoutes.delete(id)
      }
      deps.sendNotify('retireNotifications', { sourceIds: [...retiredSourceIds] })
      return 0
    },

    async openExternal(url: string) {
      await deps.sendEdge('openExternal', { url })
    },

    async openPath(p: string) {
      const result = await deps.sendEdge('openPath', { path: p })
      if (result !== null && typeof result === 'object' && 'error' in result) {
        throw new Error(String((result as { error: unknown }).error))
      }
    },

    showItemInFolder(p: string) {
      deps.sendNotify('showItemInFolder', { path: p })
    },

    async launchApp(appId: string, path: string): Promise<boolean> {
      const result = await deps.sendEdge('launchApp', { appId, path })
      return result !== false
    },

    async pickPluginSource(): Promise<HostPluginSourcePick> {
      const result = await deps.sendEdge('pickPluginSource', {})
      const r = result as { status?: unknown; path?: unknown }
      if (r.status === 'cancelled') return { status: 'cancelled' }
      if (r.status === 'picked' && typeof r.path === 'string') {
        return { status: 'picked', path: r.path }
      }
      throw new Error('sidecar-edges:pickPluginSource-invalid-answer')
    },

    showError(title: string, detail: string) {
      deps.sendEdge('showError', { title, detail }).catch((err: unknown) => {
        console.error('[node-edges] showError edge 失败：' + String(err))
      })
    },

    async showMessage(opts: HostMessageOptions): Promise<number> {
      const result = await deps.sendEdge('showMessage', jsonSafe(opts))
      return typeof result === 'number' ? result : 0
    },

    setLoginItem(enabled: boolean) {
      // HostEdges 同步面（fire-and-forget + 失败 loud）。S-E 职责分离同
      // setKeepAwake：ctx 设置叶走公开 sendEdge await（应答失败 → {ok:false,
      // error} 回滚），不经本成员——本成员保留供后续 HostEdges 面使用。
      deps.sendEdge('setLoginItem', { enabled }).catch((err: unknown) => {
        console.error('[node-edges] setLoginItem edge 失败：' + String(err))
      })
    },

    isPackaged: deps.hostFacts?.isPackaged ?? true,

    resolveResource(kind: HostResourceKind): string {
      const cached = resources.get(kind)
      if (cached !== undefined) return cached
      throw new Error('sidecar-edges:resource-not-cached:' + kind)
    },
  }

  /** sidecar-entry 把 __host.* 入站 method 分派到这里。返回 ok/result/error
   *  （result 仅对请求-应答型保留 method 有意义，如 __host.quitFacts）。 */
  function handleHostInbound(method: string, payload: unknown): { ok: boolean; result?: unknown; error?: string } {
    const p = (payload ?? {}) as Record<string, unknown>
    switch (method) {
      case HOST_INBOUND.notifyClicked: {
        const id = typeof p.notificationId === 'number' ? p.notificationId : -1
        const route = clickRoutes.get(id)
        if (route === undefined) {
          // 未知 id：通知已被 dispose/淘汰——Swift 侧已自行恢复窗口，静默 ok
          return { ok: true }
        }
        route.onActivated()
        return { ok: true }
      }
      case HOST_INBOUND.systemResume: {
        const ts = typeof p.timestamp === 'number' ? p.timestamp : Date.now()
        onSystemResumeCb?.(ts)
        return { ok: true }
      }
      case HOST_INBOUND.mainWindowShown:
        onMainWindowShownCb?.()
        return { ok: true }
      case HOST_INBOUND.deepLink: {
        const url = typeof p.url === 'string' ? p.url : ''
        if (url.length === 0) {
          return { ok: false, error: 'sidecar-edges:deep-link-missing-url' }
        }
        if (deps.onDeepLink === undefined) {
          // 未注入消费方：loud 拒绝（绝不静默丢弃——深链是用户可见动作）。
          return { ok: false, error: 'sidecar-edges:deep-link-sink-unavailable' }
        }
        deps.onDeepLink(url)
        return { ok: true }
      }
      case HOST_INBOUND.rendererLifecycle: {
        const event = typeof p.event === 'string' ? p.event : ''
        if (!(HOST_RENDERER_LIFECYCLE_EVENTS as readonly string[]).includes(event)) {
          return { ok: false, error: 'sidecar-edges:unknown-renderer-lifecycle:' + event }
        }
        if (deps.onRendererLifecycle === undefined) {
          return { ok: false, error: 'sidecar-edges:renderer-lifecycle-sink-unavailable' }
        }
        deps.onRendererLifecycle(event as HostRendererLifecycleEvent)
        return { ok: true }
      }
      case HOST_INBOUND.quitFacts: {
        const quitRequested = p.quitRequested
        const recoveryAvailable = p.recoveryAvailable
        if (typeof quitRequested !== 'boolean' || typeof recoveryAvailable !== 'boolean') {
          return { ok: false, error: 'sidecar-edges:quit-facts-invalid-input' }
        }
        if (deps.projectQuitFacts === undefined) {
          return { ok: false, error: 'sidecar-edges:quit-facts-sink-unavailable' }
        }
        return {
          ok: true,
          result: deps.projectQuitFacts({ quitRequested, recoveryAvailable }),
        }
      }
      case HOST_INBOUND.hostFacts: {
        if (typeof p.focused === 'boolean') facts.focused = p.focused
        if (typeof p.mainWindowAlive === 'boolean') facts.mainWindowAlive = p.mainWindowAlive
        if (typeof p.webViewLoading === 'boolean') facts.webViewLoading = p.webViewLoading
        if (typeof p.webViewContentAlive === 'boolean') {
          facts.webViewContentAlive = p.webViewContentAlive
        }
        if (typeof p.trayAvailable === 'boolean') facts.trayAvailable = p.trayAvailable
        if (p.resources !== null && typeof p.resources === 'object') {
          for (const [kind, path] of Object.entries(p.resources)) {
            if (typeof path === 'string') resources.set(kind, path)
          }
        }
        return { ok: true }
      }
      default:
        return { ok: false, error: 'sidecar-edges:unknown-host-inbound:' + method }
    }
  }

  /** 公开 edge 转发（S-E：见 NodeEdges.sendEdge 注释）——body = deps.sendEdge
   *  直通（edgeId 关联在实现侧）。 */
  function sendEdge(method: string, payload: unknown): Promise<unknown> {
    return deps.sendEdge(method, payload)
  }

  return Object.assign(edges, { handleHostInbound, sendEdge })
}
