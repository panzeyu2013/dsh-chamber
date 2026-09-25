/**
 * node-edges.ts —— HostEdges 的 Swift-flavor 实现（sidecar 无窗口，宿主腿全在 Swift
 * 侧），与 electron-edges.ts 对偶：把 shell-core 宿主动作折算成 B 桥 edge 请求/notify
 * （electron-free：零 electron import、零 stdout 直写）。
 * - 往返类经 sendEdge，ok:false → 抛 Error（loud）；同步门类只读缓存，__host.hostFacts
 *   推送刷新，种子值能力类 true、交付门 false（未投递的 rendererPush 不发且返回 false）。
 * - 非交互腿（setBadge/showItemInFolder/showError）走 edge + 有界重试：主线程忙先等、
 *   仍忙则 loud 失败；setBadge 同步契约只在已确证无主窗时回 applied:false。
 * - 通知按 interpretNativeNotificationReply 折算；notificationId/sourceId 登记须存活到退役，
 *   显示成功不得注销 click 路由；入站 __host.* 未注入消费方一律 loud 拒绝。
 * - 共享契约面（isPackaged/focusMainWindow/launchApp/同步 setKeepAwake/setLoginItem 等）core 未 Pick、暂无调用方，但删除会砍掉契约本身。
 */
import type {
  HostEdges,
  NativeNotificationSpec,
  NotificationSourceToken,
  HostSetBadgeResult,
  HostMessageOptions,
} from './shell-core.ts'
import { describeError } from './describe-error.ts'
import { rendererPushDelivered } from './shell-core.ts'
import { MAX_ACTIVE_NATIVE_NOTIFICATIONS, interpretNativeNotificationReply } from './notifications.ts'

/** B 桥 host 侧入站 method 名（sidecar-entry 与 Swift 侧共用同一拼写）。 */
export const HOST_INBOUND = {
  notifyClicked: '__host.notifyClicked',
  systemResume: '__host.systemResume',
  mainWindowShown: '__host.mainWindowShown',
  hostFacts: '__host.hostFacts',
  deepLink: '__host.deepLink',
  rendererLifecycle: '__host.rendererLifecycle',
  quitFacts: '__host.quitFacts',
  nativeUpdatePhase: '__host.nativeUpdatePhase',
  /** 调试模式启动期回读（shell→sidecar 单向事实）：Swift 在启动 reconcile 里按
   *  持久值应用 isInspectable 后，把实测回读报给 sidecar，供 settings 投影在
   *  用户打开设置页之前就带上 debugRuntime（否则首帧只能显示「未知」）。 */
  debugModeApplied: '__host.debugModeApplied',
} as const

/** B 桥协议帧（行）字节上限，**双向**：与 Swift 侧 FrameCodec.maxFrameBytes /
 *  TrustGuard.maxMessageBytes 同值（4 MiB）——两侧门与跨语言锁步测试都读这一个
 *  常量。出站侧一个超限结果帧会把 Swift LineReader 推入溢出重同步并 fail-closed
 *  作废全部未决请求，故在源头对称拒绝。 */
export const MAX_PROTOCOL_FRAME_BYTES = 4 * 1024 * 1024

export const MAX_INBOUND_FRAME_BYTES = MAX_PROTOCOL_FRAME_BYTES

/** 原生更新阶段（冻结接口）：'installing' / 'failed' 是原生侧独有相位，sidecar
 *  映射为 UpdateState 的 'installing' / 'error'（update-headless.applyNativePhase）。 */
export const NATIVE_UPDATE_PHASES = [
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'downloaded',
  'installing',
  'failed',
] as const

export type NativeUpdatePhase = (typeof NATIVE_UPDATE_PHASES)[number]

/** __host.nativeUpdatePhase 载荷（version/error 可为 null，非 string/null 一律 loud 拒绝）。 */
export interface NativeUpdatePhaseInput {
  phase: NativeUpdatePhase
  version: string | null
  error: string | null
}

/** 可空字符串字段的线校验：null/undefined → null；string 原样；其他 → undefined（非法）。 */
function nullableWireString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : undefined
}

/** 退出在途的入站拒绝形状：与 Electron trustedIpc 退出围栏抛出的错误逐字同形
 *  （message 'app is quitting' + code 'app_quitting'），让两种 flavor 的 renderer
 *  拿到同一个可判别退出错误。 */
export const QUIT_INBOUND_ERROR = {
  error: 'app is quitting',
  code: 'app_quitting',
} as const

/** 渲染器生命周期事件（core RendererLifecycleEvent 的 wire 子集）。 */
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
  /** 深链入站汇；缺省未注入 → 入站 loud 拒绝（绝不静默丢弃）。 */
  onDeepLink?: (url: string) => void
  /** 渲染器生命周期入站汇 → core onRendererLifecycle；缺省未注入 → loud 拒绝。 */
  onRendererLifecycle?: (event: HostRendererLifecycleEvent) => void
  /** 原生更新阶段入站汇（冻结接口）：接到 update-headless.applyNativePhase，使
   *  Swift Sparkle 阶段与 Electron 走同一 UpdateState 投影；缺省 → loud 拒绝。 */
  nativeUpdatePhase?: (input: NativeUpdatePhaseInput) => void
  /** 关窗/退出决策投影：输入 Swift 宿主事实，输出 core 依 chamber settings +
   *  本地实例在跑判据的决策（shouldHideToTray / computeQuitRisk 单源在 core）；
   *  缺省未注入 → loud 拒绝（宿主必须走保守路径，绝不静默放行退出）。 */
  projectQuitFacts?: (input: {
    quitRequested: boolean
    recoveryAvailable: boolean
  }) => { hideOnClose: boolean; quitNeedsConfirm: boolean; quitReasons: string[] }
  /** 调试模式启动期回读汇（__host.debugModeApplied）：Swift 启动 reconcile 应用
   *  isInspectable 后的实测回读 → core 的 debugRuntime holder。缺省未注入 →
   *  loud 拒绝（绝不静默丢弃：丢掉它设置页整场只显示「未知」）。 */
  debugModeApplied?: (input: { enabled: boolean; inspectable: boolean; apiAvailable: boolean; reason?: string }) => void
  /** 测试注入：非交互腿有界排队的重试间隔（缺省 5s）。 */
  nonInteractiveRetryDelayMs?: number
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
  }
}

interface PendingNotificationRoute {
  dispose(): void
  shown: Promise<{ shown: true } | { shown: false; error: string }>
}

/** 非交互宿主腿有界排队的发送次数（首送 + 重试）。 */
const NON_INTERACTIVE_LEG_ATTEMPTS = 6
/** 有界排队基础重试间隔——总窗 ≈ (attempts-1)×delay = 25s，落在非交互 edge 的 30s 预算内。 */
const NON_INTERACTIVE_LEG_RETRY_DELAY_MS = 5_000

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
  /** 公开 edge 转发（NodeEdges 附加成员，不改 HostEdges 契约）：resolve = Swift
   *  leg 应答 ok；reject = transport {ok:false} / leg 错误；edgeId 关联由
   *  deps.sendEdge 实现侧（sidecar-entry pendingEdges 表）保证。 */
  sendEdge(method: string, payload: unknown): Promise<unknown>
}

export function createNodeEdges(deps: NodeEdgesDeps): NodeEdges {
  // ---- 同步门缓存（v1 近似；hostFacts 刷新） ----
  // 保守默认：交付门相关事实在收到 hostFacts 前按「未知 = 不可交付」处理，
  // 否则 ready 前的 rendererPush 会被当成已投递；能力类默认乐观（平台能力）。
  const facts = {
    focused: deps.hostFacts?.focused ?? false,
    mainWindowAlive: deps.hostFacts?.mainWindowAlive ?? false,
    webViewLoading: deps.hostFacts?.webViewLoading ?? false,
    webViewContentAlive: deps.hostFacts?.webViewContentAlive ?? false,
    trayAvailable: deps.hostFacts?.trayAvailable ?? true,
    badgeCountApiAvailable: deps.hostFacts?.badgeCountApiAvailable ?? true,
    notificationSupported: deps.hostFacts?.notificationSupported ?? true,
  }
  let onSystemResumeCb: ((timestamp: number) => void) | null = null
  let onMainWindowShownCb: (() => void) | null = null

  /** click 路由上限与 electron-edges 的活跃原生通知上限同源（淘汰只丢路由，不动横幅）。 */
  const MAX_PENDING_NOTIFICATION_ROUTES = MAX_ACTIVE_NATIVE_NOTIFICATIONS
  const clickRoutes = new Map<number, { token: NotificationSourceToken; onActivated(): void }>()
  let nextNotificationId = 1

  // ---- 非交互宿主腿的有界排队 ----
  // 模态（NSAlert/NSOpenPanel）在屏时 Swift 主线程忙，非交互腿经 performUI 的有界
  // 等待回 'swift-edge-ui-unavailable:<method>:main-thread-busy'，模态结束前重发仍
  // 撞同一忙态。只走 notify（无回执）或一发即弃会让用户操作静默丢失；本队列经
  // edge + 有界重试：同一状态型 method 只保留最新载荷（单飞 + 合流），窗口内仍忙则
  // loud 失败一次。交互腿（showMessage）不走本队列。
  interface QueuedLeg {
    /** 待送载荷队列（状态型恒只留最新；事件型按到达顺序排队、上限内逐条投递）。 */
    pending: unknown[]
    /** true = 状态型（只保留最新）；false = 事件型（逐条投递）。 */
    coalesce: boolean
    attemptsLeft: number
    /** 当前是否已有一次 sendEdge 在飞（单飞门）。 */
    inFlight: boolean
    /** 下一次重试的定时器（unref——绝不阻止退出）。 */
    timer: NodeJS.Timeout | null
  }
  const queuedLegs = new Map<string, QueuedLeg>()

  /** 只对「主线程忙」这一瞬时失败重试；确定性失败（no-window/unimplemented/参数错误/无 bundle）立即 loud 放弃。 */
  function isRetryableLegError(message: string): boolean {
    return message.includes('main-thread-busy')
  }

  /** 事件型腿：语义是「每次都发生」，不合流（Electron 每次调用都会弹/都会显示）。 */
  const LEG_EVENT_METHODS = new Set(['showError', 'showItemInFolder'])
  /** 事件型腿的排队上限（超出只 loud 丢弃并记账，绝不无限增长）。 */
  const NON_INTERACTIVE_LEG_PENDING_MAX = 8

  function queueNonInteractiveLeg(method: string, payload: unknown): void {
    const coalesce = !LEG_EVENT_METHODS.has(method)
    const existing = queuedLegs.get(method)
    if (existing !== undefined) {
      if (coalesce) {
        existing.pending[0] = payload
      } else if (existing.pending.length < NON_INTERACTIVE_LEG_PENDING_MAX) {
        existing.pending.push(payload)
      } else {
        console.error(
          `[node-edges] ${method} 排队已满（${NON_INTERACTIVE_LEG_PENDING_MAX}）——本次调用未能排队（S2·V1）`,
        )
      }
      return
    }
    const entry: QueuedLeg = {
      pending: [payload],
      coalesce,
      attemptsLeft: NON_INTERACTIVE_LEG_ATTEMPTS,
      inFlight: false,
      timer: null,
    }
    queuedLegs.set(method, entry)
    void flushNonInteractiveLeg(method, entry)
  }

  async function flushNonInteractiveLeg(method: string, entry: QueuedLeg): Promise<void> {
    entry.inFlight = true
    for (;;) {
      const payload = entry.pending[0]
      try {
        await deps.sendEdge(method, payload)
        // 只弹出刚送出的这一条：在飞期间到达的新载荷留在队首，下一轮继续送。
        entry.pending.shift()
        if (entry.pending.length > 0) continue
        queuedLegs.delete(method)
        entry.inFlight = false
        return
      } catch (error) {
        entry.attemptsLeft -= 1
        const message = describeError(error)
        if (entry.attemptsLeft > 0 && isRetryableLegError(message)) {
          await new Promise<void>((resolve) => {
            entry.timer = setTimeout(resolve, deps.nonInteractiveRetryDelayMs ?? NON_INTERACTIVE_LEG_RETRY_DELAY_MS)
            entry.timer.unref?.()
          })
          entry.timer = null
          if (queuedLegs.get(method) !== entry) return // 已被清理/替换
          continue
        }
        // 队首没送达就放弃时绝不静默丢掉队列里的更新值：队首可能已被更新过
        // （状态型）或后面还排着别的调用（事件型）——补发一次队首，再记账放弃。
        if (entry.pending[0] !== payload) {
          entry.attemptsLeft = Math.max(entry.attemptsLeft, 1)
          continue
        }
        const dropped = entry.pending.length - 1
        queuedLegs.delete(method)
        entry.inFlight = false
        console.error(
          `[node-edges] ${method} 宿主腿失败（S2·V1 有界排队 ${NON_INTERACTIVE_LEG_ATTEMPTS - entry.attemptsLeft}/${NON_INTERACTIVE_LEG_ATTEMPTS} 次后放弃）：${message}`
          + (dropped > 0 ? `；另有 ${dropped} 条排队载荷未能投递` : ''),
        )
        return
      }
    }
  }

  const edges: HostEdges = {
    rendererPush(channel, payload) {
      // 交付信号必须诚实：无窗时必须返回 false，core 据此 hold/rollback/复位
      // ready 位；恒 true 会让通知打开/深链/唤醒事件静默丢失。
      // 交付门 = 共享 roundtrip 判定（rendererPushDelivered，两侧唯一实现）；
      // 未投递就**不发**，否则隐藏/已死窗会收到重复投递。
      const delivered = rendererPushDelivered(facts.mainWindowAlive, facts.webViewContentAlive)
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
        // 有界登记（上限与 electron-edges 活跃原生通知同源，>16 淘汰最旧一条）。
        // 淘汰必须同时丢 click 路由并把 identifier 下发宿主清横幅——只删路由会让
        // 陈旧横幅留在通知中心；淘汰是逐条语义（sourceIds 空，只带该条）。
        if (clickRoutes.size > MAX_PENDING_NOTIFICATION_ROUTES) {
          const oldest = clickRoutes.keys().next().value
          if (oldest !== undefined) {
            clickRoutes.delete(oldest)
            deps.sendNotify('retireNotifications', { sourceIds: [], notificationIds: [oldest] })
          }
        }
      }
      const result = deps
        .sendEdge('showNativeNotification', {
          notificationId,
          spec: jsonSafe(spec),
          // D1a：退役清横幅所需来源标识（'test' 通知 clickRoute=null → null，Swift 侧不登记）。
          sourceId: clickRoute === null ? null : clickRoute.token.sourceId,
        })
        .then(
          // 应答必须按 honest-show 语义折算——Swift 腿可显式回 {shown:false,error}
          // （未授权/调度失败/超时），core 据此释放去重 claim；旧协议 null 应答记 shown。
          (reply) => interpretNativeNotificationReply(reply),
          (err: unknown) => ({
            shown: false as const,
            error: describeError(err),
          }),
        )
      const route: PendingNotificationRoute = {
        dispose() {
          clickRoutes.delete(notificationId)
        },
        shown: result,
      }
      // 路由存活到 dispose / 来源退役 / 被淘汰：显示成功不得注销——click 必然晚于
      // shown 结算，若在结算即删除，Swift flavor 的点击将命中不到路由而静默返回
      // ok，「点横幅打开会话」整体失效。只有显示失败才即时注销。
      void route.shown.then((outcome) => {
        if (!outcome.shown) clickRoutes.delete(notificationId)
      })
      return route
    },

    notificationSupported() {
      return facts.notificationSupported
    },

    setBadge(count: number): HostSetBadgeResult {
      // HostEdges.setBadge 是**同步**契约，而 Swift setBadge 是 edge 可应答腿（写失败/
      // 无窗/主线程忙都回 ok:false）——跨进程应答无法同步取回。因此只能走 edge + 有界
      // 排队让真实失败 loud 落 stderr，返回值保持 {applied:true} 的乐观值（不是伪造成功：
      // 回 {applied:false} 同样不诚实，且会误导 core 的 badge 状态机降级）。
      // 例外：**已确证无主窗**时如实回 applied:false，让 core 走失败降级。
      if (!facts.mainWindowAlive) {
        return { applied: false, reason: 'swift-edge-ui-unavailable:setBadge:no-window' }
      }
      queueNonInteractiveLeg('setBadge', { count })
      return { applied: true }
    },

    badgeCountApiAvailable() {
      return facts.badgeCountApiAvailable
    },

    trayAvailable() {
      return facts.trayAvailable
    },

    setKeepAwake(on: boolean) {
      // HostEdges 同步面（fire-and-forget + 失败 loud）。职责分离：ctx 设置叶走公开
      // sendEdge await 应答（不经本成员——避免双写与乐观假成功），本成员保留供后续
      // HostEdges 面直接调用。
      deps.sendEdge('setKeepAwake', { on }).catch((err: unknown) => {
        console.error('[node-edges] setKeepAwake edge 失败：' + String(err))
      })
    },

    nativeThemeSet(_source: 'light' | 'dark' | 'system') {
      // 显式 no-op（2026-09 裁决 + §12.6 坑①）：Swift 壳的外观已由页面事实承担
      // （ShellPageFacts → applyAppearance，design 25 §5.3），再转一条边等于给同一
      // 事实加第二个调色板源。保留成员只为共享 HostEdges 面完整与 A/B 桥载荷锁步；
      // Electron 腿的真实现见 electron-edges.ts（nativeTheme.themeSource）。
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
      // 已退役来源的 click 路由随对象消亡，且经 notify 交 Swift 宿主按 sourceId 登记表
      // 清横幅。返回值 = 本层**真实驱逐的 click 路由数**（OS 横幅实际清除数只有 Swift
      // 侧可观察，本层同步拿不到——绝不把 0 假称成功）；两个调用方当前丢弃返回值。
      let retired = 0
      const retiredNotificationIds: number[] = []
      for (const [id, route] of clickRoutes) {
        if (retiredSourceIds.has(route.token.sourceId)) {
          clickRoutes.delete(id)
          retiredNotificationIds.push(id)
          retired += 1
        }
      }
      // payload 同时携带 sourceIds（整源退役）与 notificationIds（逐条清——本次实际
      // 驱逐的本地 id，Swift 侧映射到 chamber-edge-* OS identifier）；旧消费端只读前者。
      deps.sendNotify('retireNotifications', {
        sourceIds: [...retiredSourceIds],
        notificationIds: retiredNotificationIds,
      })
      return retired
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
      // Finder 揭示腿同样经 edge + 有界排队（notify 无回执，主线程忙时失败会静默）。
      queueNonInteractiveLeg('showItemInFolder', { path: p })
    },

    async launchApp(appId: string, path: string): Promise<boolean> {
      const result = await deps.sendEdge('launchApp', { appId, path })
      return result !== false
    },

    // 2026-09 C 分层：插件源 pick 叶随写面整族移除（Swift 侧同名宿主腿同批删除）。

    showError(title: string, detail: string) {
      // 错误框是深链/更新失败路径的可见面：只把 leg 失败 catch 成一行 stderr 会让主线程
      // 忙时错误框根本不弹，故经有界排队（先等，仍忙则 loud 放弃）。
      queueNonInteractiveLeg('showError', { title, detail })
    },

    async showMessage(opts: HostMessageOptions): Promise<number> {
      const result = await deps.sendEdge('showMessage', jsonSafe(opts))
      return typeof result === 'number' ? result : 0
    },

    setLoginItem(enabled: boolean) {
      // HostEdges 同步面（fire-and-forget + 失败 loud）；职责分离同 setKeepAwake：
      // ctx 设置叶走公开 sendEdge await，本成员保留供后续 HostEdges 面使用。
      deps.sendEdge('setLoginItem', { enabled }).catch((err: unknown) => {
        console.error('[node-edges] setLoginItem edge 失败：' + String(err))
      })
    },

    isPackaged: deps.hostFacts?.isPackaged ?? true,
  }

  /** sidecar-entry 把 __host.* 入站 method 分派到这里（result 仅请求-应答型有意义）。 */
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
      case HOST_INBOUND.debugModeApplied: {
        const enabled = p.enabled
        const inspectable = p.inspectable
        const apiAvailable = p.apiAvailable
        if (typeof enabled !== 'boolean' || typeof inspectable !== 'boolean' || typeof apiAvailable !== 'boolean') {
          return { ok: false, error: 'sidecar-edges:debug-mode-invalid-input' }
        }
        // 可选 reason：缺省 = 无原因；**非字符串是协议违例 → loud 拒绝**（同文件
        // nativeUpdatePhase 对 version/error 的纪律）。静默归一成 undefined 会让宿主
        // 失败原文无声消失，UI 只剩通用「不可用」文案。载荷先验完再查汇，双坏帧时报
        // 更具体的那个错。
        if (p.reason !== undefined && typeof p.reason !== 'string') {
          return { ok: false, error: 'sidecar-edges:debug-mode-invalid-reason' }
        }
        if (deps.debugModeApplied === undefined) {
          // 生产装配恒注入该汇（sidecar-entry 的入站表）；本分支只在「装配未完成」
          // 的异构/测试场景可达——保留为 loud 防御，绝不放行半装配的静默丢弃。
          return { ok: false, error: 'sidecar-edges:debug-mode-sink-unavailable' }
        }
        const reason = typeof p.reason === 'string' && p.reason !== '' ? p.reason : undefined
        deps.debugModeApplied({ enabled, inspectable, apiAvailable, reason })
        return { ok: true }
      }
      case HOST_INBOUND.nativeUpdatePhase: {
        // 冻结接口校验：phase 必须八值枚举，version/error 必须 string/null（缺省 null）；非法形状 loud 拒绝。
        const phase = typeof p.phase === 'string' ? p.phase : ''
        if (!(NATIVE_UPDATE_PHASES as readonly string[]).includes(phase)) {
          // 回显截断（帧本身 <=4MiB）：拒绝文案不得把整段任意载荷放大成响应帧。
          return { ok: false, error: 'sidecar-edges:native-update-phase-invalid-phase:' + phase.slice(0, 64) }
        }
        const version = nullableWireString(p.version)
        if (version === undefined) {
          return { ok: false, error: 'sidecar-edges:native-update-phase-invalid-version' }
        }
        const errorText = nullableWireString(p.error)
        if (errorText === undefined) {
          return { ok: false, error: 'sidecar-edges:native-update-phase-invalid-error' }
        }
        if (deps.nativeUpdatePhase === undefined) {
          // 未注入消费方（装配缺失）：loud 拒绝——静默 ok 会让页面与 Sparkle 窗不一致。
          return { ok: false, error: 'sidecar-edges:native-update-phase-sink-unavailable' }
        }
        try {
          deps.nativeUpdatePhase({ phase: phase as NativeUpdatePhase, version, error: errorText })
        } catch (err) {
          const message = describeError(err)
          return { ok: false, error: 'sidecar-edges:native-update-phase-failed:' + message }
        }
        return { ok: true }
      }
      case HOST_INBOUND.hostFacts: {
        if (typeof p.focused === 'boolean') facts.focused = p.focused
        if (typeof p.mainWindowAlive === 'boolean') facts.mainWindowAlive = p.mainWindowAlive
        if (typeof p.webViewLoading === 'boolean') facts.webViewLoading = p.webViewLoading
        if (typeof p.webViewContentAlive === 'boolean') {
          facts.webViewContentAlive = p.webViewContentAlive
        }
        if (typeof p.trayAvailable === 'boolean') facts.trayAvailable = p.trayAvailable
        // resources 事实键（resolveResource 死契约）不消费；未知事实键按前向兼容忽略。
        return { ok: true }
      }
      default:
        return { ok: false, error: 'sidecar-edges:unknown-host-inbound:' + method }
    }
  }

/** 公开 edge 转发（见 NodeEdges.sendEdge 注释）——body = deps.sendEdge 直通。 */
  function sendEdge(method: string, payload: unknown): Promise<unknown> {
    return deps.sendEdge(method, payload)
  }

  return Object.assign(edges, { handleHostInbound, sendEdge })
}
