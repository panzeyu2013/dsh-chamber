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
 * - 非交互宿主腿（setBadge/showItemInFolder/showError）→ edge + 有界重试队列
 *   （S2·V1：主线程忙先等，窗口内仍忙则 loud 明确失败，绝不静默丢弃；S2·F7：
 *   setBadge 的同步契约返回值仍是乐观 applied:true——真应答在飞、失败 loud，
 *   见 createNodeEdges 内两处注释与台账登记；P-06 例外：已确证无主窗时同步回
 *   applied:false，绝不假成功）。retireNotificationsForSources 返回本层真实
 *   驱逐的 click 路由数（S2·F7，不再是恒 0）并携带 notificationIds（P-07）。
 * - 通知「已应用」回执（P-06）：showNativeNotification 的 edge 应答按
 *   interpretNativeNotificationReply 折算——Swift 腿显式 {shown:false,error}
 *   （未授权/调度失败/有界超时）会让 core 释放 5s 去重 claim；不再把传输 ok
 *   乐观当成横幅已显示。
 * - 通知 click 回灌 + 退役清除（D1a 线协议，Swift 侧按此消费）：
 *   showNativeNotification 为每条通知分配本地 notificationId，edge payload =
 *   {notificationId, spec, sourceId}——sourceId 取 clickRoute.token.sourceId
 *   （'test' 通知/无路由 = null）。Swift 侧按 sourceId 登记「已投递」通知的
 *   UNUserNotificationCenter identifier，使随后 notify retireNotifications
 *   {sourceIds, notificationIds} 能真正 removeDeliveredNotifications 清横幅
 *   （无登记表时只能 no-op；notificationIds = 逐条 identifier 清除，用于 >16
 *   淘汰与来源退役两个路径，P-07）；点击（先自行 activate/restore/focus，语义 = electron-edges 宿主
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
 *                            webViewContentAlive?, trayAvailable?}
 *   __host.deepLink         {url}      → core enqueueDeepLink（design 25 §4.5：
 *                            Swift application(_:open:) 冷/热启动统一入口）
 *   __host.rendererLifecycle {event}   → core onRendererLifecycle（§5 E19 三事件
 *                            映射：did-start-loading / did-finish-load /
 *                            crashed / closed）
 *   __host.nativeUpdatePhase {phase, version, error} → 装配侧原生更新阶段汇
 *                            （sidecar-entry 接到 update-headless.applyNativePhase：
 *                            Sparkle 状态 → 同一 UpdateState 投影 → 既有
 *                            rendererPush/update-state 消费面。S-19/S-21 冻结接口；
 *                            缺汇 = loud 拒绝，绝不静默丢用户可见的更新阶段）
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
 *   isPackaged / trayAvailable / focusMainWindow / launchApp 与同步
 *   setKeepAwake/setLoginItem——core 的 HostEdges Pick
 *   （shell-core.ts installIpcHandlers）未收窄到它们，本仓也暂无调用方；
 *   electron-edges 的返回 Pick 同样不含（Electron 侧这些动作在 main.ts 直做，
 *   见其 TODO 段）。它们是 design 25 §4.1 v2 字段集这一共享契约面（本文件是
 *   当前唯一实现；focusMainWindow/launchApp/setKeepAwake/setLoginItem 的 Swift
 *   宿主腿已在 SwiftEdgeHostLegs 落位），删除会砍掉契约本身。语义仍须保持诚实
 *   （形状/失败语义与契约一致）；改这些成员时两侧同时核对。
 *   P-03（2026-12 裁决）：notifyClicked 与 resolveResource 例外——两者零消费者
 *   且 Swift 宿主语义本就不同（notifyClicked 经 notify 到达被 loud 忽略、
 *   resolveResource 无缓存恒失败），已连同 hostFacts.resources 消费一起从两侧
 *   删除；见 shell-core.ts HostEdges 头注。
 */
import type {
  HostEdges,
  NativeNotificationSpec,
  NotificationSourceToken,
  HostSetBadgeResult,
  HostPluginSourcePick,
  HostMessageOptions,
} from './shell-core.ts'
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
} as const

/** B 桥单帧（行）字节上限（P-01）。与 Swift 侧 FrameCodec.maxFrameBytes /
 *  TrustGuard.maxMessageBytes 同值（4 MiB）——sidecar 入站门与跨语言锁步测试
 *  都读这一个常量；改值必须同步 macos/Sources/DSHChamberPoc/FrameCodec.swift。 */
export const MAX_INBOUND_FRAME_BYTES = 4 * 1024 * 1024

/** 原生更新阶段（S-19/S-21 冻结接口）：Swift 壳报告 Sparkle 状态，sidecar
 *  映射进既有 UpdateState 投影。'installing' / 'failed' 是原生侧独有相位——
 *  sidecar 分别映射为 UpdateState 的 'installing' / 'error'（见
 *  update-headless.applyNativePhase）。 */
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

/** __host.nativeUpdatePhase 的入站载荷（version/error 可为 null，非 string/null
 *  类型一律 loud 拒绝）。 */
export interface NativeUpdatePhaseInput {
  phase: NativeUpdatePhase
  version: string | null
  error: string | null
}

/** 可空字符串字段的线校验：null/undefined → null；string → 原样；
 *  其他类型 → undefined（非法，调用方 loud 拒绝）。 */
function nullableWireString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : undefined
}

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
  /** 原生更新阶段入站汇（S-19/S-21 冻结接口）：装配侧把它接到更新控制器
   *  （update-headless.applyNativePhase）——Swift 壳的 Sparkle 阶段/失败进与
   *  Electron 同一 UpdateState 投影，页面呈现单一权威。缺省未注入 → 入站
   *  loud 拒绝（绝不静默丢用户可见的更新阶段）。 */
  nativeUpdatePhase?: (input: NativeUpdatePhaseInput) => void
  /** 关窗/退出决策投影（design 25 §5 E1/E9/E20）：输入 = Swift 宿主侧事实
   *  （退出在途 / 恢复入口可用），输出 = core 依据 chamber settings + 本地实例
   *  在跑判据算出的决策。决策逻辑单源在 core（shouldHideToTray /
   *  computeQuitRisk），Swift 不复制。缺省未注入 → 入站 loud 拒绝（宿主拿不到
   *  决策时必须走保守路径，绝不静默放行退出）。 */
  projectQuitFacts?: (input: {
    quitRequested: boolean
    recoveryAvailable: boolean
  }) => { hideOnClose: boolean; quitNeedsConfirm: boolean; quitReasons: string[] }
  /** S2·V1 测试注入：非交互宿主腿有界排队的重试间隔（缺省 5s；测试用短值
   *  确定性覆盖「先等→仍忙→明确失败」与「忙后空出→成功」两分支）。 */
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

/** S2·V1：非交互宿主腿有界排队的发送次数（首送 + 重试）。 */
const NON_INTERACTIVE_LEG_ATTEMPTS = 6
/** S2·V1：有界排队的基础重试间隔——总窗 ≈ (attempts-1)×delay = 25s，落在
 *  非交互 edge 的 30s 预算内（先等主线程空出，仍忙才 loud 放弃）。 */
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
  // ---- 事件订阅槽（installIpcHandlers ① 段调用 onSystemResume/onMainWindowShown） ----
  let onSystemResumeCb: ((timestamp: number) => void) | null = null
  let onMainWindowShownCb: (() => void) | null = null

  // ---- 通知 click 路由表（notificationId → clickRoute） ----
  /** click 路由上限：与 electron-edges 的活跃原生通知上限同一数字（语义见
   *  showNativeNotification——淘汰只丢路由，不动宿主横幅）。 */
  const MAX_PENDING_NOTIFICATION_ROUTES = MAX_ACTIVE_NATIVE_NOTIFICATIONS
  const clickRoutes = new Map<number, { token: NotificationSourceToken; onActivated(): void }>()
  let nextNotificationId = 1

  // ---- S2·V1：非交互宿主腿的有界排队 ----
  // 模态（NSAlert/NSOpenPanel）在屏时 Swift 主线程忙，非交互腿经 performUI 的 1s
  // 有界等待回 'swift-edge-ui-unavailable:<method>:main-thread-busy'
  // （SwiftEdgeHostLegs.swift:203/541-573），模态结束前重发仍撞同一忙态。原实现
  // 这些腿走 notify（无回执——失败只在 Swift stderr）或一发即弃 → 用户操作静默
  // 丢失。本队列改为 edge + 有界重试：同一 method 只保留**最新**载荷（单飞 +
  // 合流——旧载荷绝不晚到覆盖新状态，badge 计数只应用最后一个），主线程空出即
  // 应用；窗口内仍未空出则以明确文案 loud 失败一次，绝不静默丢弃。投递异步，
  // 不阻塞任何调用方；交互腿（showMessage/pickPluginSource）不走本队列，语义不变。
  interface QueuedLeg {
    /** 待送载荷队列。状态型腿（setBadge）恒只保留最新一个（合流——旧值绝不
     *  晚到覆盖新状态）；事件型腿（弹框 / 在 Finder 中显示）按到达顺序排队、
     *  上限内逐条投递（2026-12 审查：Electron 每次调用都会发生，不能合流成
     *  最后一次）。 */
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

  /** 只对「主线程忙」这一瞬时失败重试；确定性失败（no-window/unimplemented/
   *  参数错误/无 bundle）立即 loud 放弃，绝不空转等待。 */
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
        // 只弹出刚送出的这一条：在飞期间到达的新载荷（更新的 badge 计数 / 后续
        // 事件调用）留在队首，下一轮继续送。
        entry.pending.shift()
        if (entry.pending.length > 0) continue
        queuedLegs.delete(method)
        entry.inFlight = false
        return
      } catch (error) {
        entry.attemptsLeft -= 1
        const message = error instanceof Error ? error.message : String(error)
        if (entry.attemptsLeft > 0 && isRetryableLegError(message)) {
          await new Promise<void>((resolve) => {
            entry.timer = setTimeout(resolve, deps.nonInteractiveRetryDelayMs ?? NON_INTERACTIVE_LEG_RETRY_DELAY_MS)
            entry.timer.unref?.()
          })
          entry.timer = null
          if (queuedLegs.get(method) !== entry) return // 已被清理/替换
          continue
        }
        // 队首载荷没送达就放弃时，**绝不静默丢掉队列里的更新值**（2026-12 审查
        // major）：状态型腿的队首可能已被更新过（pending[0] !== payload），
        // 事件型腿后面还排着别的调用——补发一次队首，再记账放弃。
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
      // 交付信号必须诚实（2026-09 模块评审 medium #1）：electron-edges 在无窗
      // 时返回 false，core 据此 hold/rollback/复位 ready 位；Swift flavor 原先
      // 恒 true，会让通知打开/深链/唤醒事件静默丢失。这里按「渲染器存活」事实
      // 返回（未收到 hostFacts 前为 false）。
      // G14：交付门 = 共享 roundtrip 判定（两侧唯一实现，见 shell-core
      // rendererPushDelivered）——crashed 渲染器上的 send 视为未投递。
      const delivered = rendererPushDelivered(facts.mainWindowAlive, facts.webViewContentAlive)
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
        // 有界登记（上限与 electron-edges 的活跃原生通知同源，>16 淘汰最旧一条）。
        // P-07：淘汰必须**同时**丢 click 路由并把 identifier 下发宿主清横幅——
        // 只删路由会让陈旧横幅继续留在系统通知中心，点开也不再打开会话。
        // 淘汰是逐条语义（不按 sourceId 整源退役），故 sourceIds 为空、
        // notificationIds 只带被淘汰的那一条；Swift 侧据 identifier 精确清除。
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
          // D1a：退役清横幅所需的来源标识（Swift 侧 sourceId→identifier 登记表）；
          // 'test' 通知（clickRoute=null）无来源 → null（Swift 侧不登记、不退役）。
          sourceId: clickRoute === null ? null : clickRoute.token.sourceId,
        })
        .then(
          // P-06：应答必须按 honest-show 语义折算——Swift 腿现在可以显式回
          // {shown:false,error}（未授权/调度失败/超时），core 据此释放去重 claim；
          // 只有显式成功（或旧协议的 null 应答）才记 shown:true。
          (reply) => interpretNativeNotificationReply(reply),
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

    setBadge(count: number): HostSetBadgeResult {
      // S2·F7 回执面：Swift 侧 setBadge 是 **edge 可应答腿**
      // （SwiftEdgeHostLegs.swift:328-350 performUI：dockTile 写失败/无窗/
      // 主线程忙都回 ok:false + 错误串）。HostEdges.setBadge 却是**同步**契约
      // （shell-core.ts:708/2045 立即读 {applied}）——跨进程应答无法同步取回，
      // 因此本层只能：① 走 edge + 有界排队（S2·V1），真实失败 loud 落 stderr
      // （原 notify 连失败答案都没有）；② 返回值保持 {applied:true}——这是
      // 同步契约限制下的乐观值，**不是伪造的成功回执**：把未知当失败回
      // {applied:false, reason} 同样不诚实，且会误导 core 的 badge 状态机
      // （applyBadgePresentation 以 !applied 记失败并降级）。回执面要真正
      // 收窄必须先改 HostEdges 契约（异步化），属台账 S2·F7 登记项——本批
      // 不做契约变更，只让失败可观察（loud）+ 注释/台账留证。
      // P-06 补强：**已确证无主窗**时 Swift 腿必以 no-window 拒绝（canShowUI
      // 守卫），这里不再乐观 applied:true——同步可知的失败必须如实回执，
      // core 的 applyBadgePresentation 才会走失败降级而不是假成功。
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
      // S2·F7：返回值不再是恒 0——返回本层**真实驱逐的 click 路由数**
      // （electron-edges.ts:291-300 同款口径：注册表驱逐数；shell-core.ts:737
      // 的契约注记也是「返回驱逐数」）。OS 横幅的实际清除条数只在 Swift 宿主
      // 侧可观察，本层同步拿不到——返回真实可观察量而非把 0 假称成功；Swift
      // 宿主清除失败在该侧 loud（MainWindowController.swift:526-543）。
      // 两个调用方（main.ts / sidecar-ctx.ts）当前丢弃返回值，故无行为变更。
      let retired = 0
      const retiredNotificationIds: number[] = []
      for (const [id, route] of clickRoutes) {
        if (retiredSourceIds.has(route.token.sourceId)) {
          clickRoutes.delete(id)
          retiredNotificationIds.push(id)
          retired += 1
        }
      }
      // P-07：payload 同时携带 sourceIds（整源退役）与 notificationIds（逐条
      // identifier 清除——本次退役实际驱逐的本地 notificationId，Swift 侧映射到
      // 自己的 chamber-edge-* OS identifier）。两个字段并存：旧 Swift 消费端只读
      // sourceIds（忽略多余键），新消费端两者并用。
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
      // S2·V1：Finder 揭示腿同样经 edge + 有界排队（原 notify 无回执——Swift
      // 主线程忙时失败只落在 Swift stderr，node 侧完全静默）。
      queueNonInteractiveLeg('showItemInFolder', { path: p })
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
      // S2·V1/V2：错误框是深链/更新失败路径的可见面——原实现只把 leg 失败
      // catch 成一行 node stderr（主线程忙时错误框根本不弹）。改经有界排队：
      // 模态在屏 = 主线程忙 → 先等，窗口内仍未空出则以明确文案 loud 放弃。
      queueNonInteractiveLeg('showError', { title, detail })
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
      case HOST_INBOUND.nativeUpdatePhase: {
        // S-19/S-21 冻结接口校验：phase 必须是八值枚举；version/error 必须是
        // string 或 null（缺省 = null）。任何非法形状 loud 拒绝，绝不猜测映射。
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
          // 未注入消费方（装配缺失）：loud 拒绝——阶段是用户可见的更新状态，
          // 静默 ok 会让页面与 Sparkle 窗不一致。
          return { ok: false, error: 'sidecar-edges:native-update-phase-sink-unavailable' }
        }
        try {
          deps.nativeUpdatePhase({ phase: phase as NativeUpdatePhase, version, error: errorText })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
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
        // P-03：resources 事实键随 resolveResource 死契约一起不再消费（未知
        // 事实键按前向兼容忽略——Swift 侧继续推送不构成错误）。
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
