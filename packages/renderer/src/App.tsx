/**
 * dsh-chamber bridge host（design 05）：页面唯一入口宿主。
 * 首屏 = 本地实例的完整 dsh shell（纯 dsh UI，无 chamber 外壳）；多来源
 * session/workspace 导航在 dsh 原生侧边栏内由 chamber 自研插件承担
 * （design 05）。本组件只负责数据层与 N-ctx 编排：
 * - 控制面 /health 与 /api/connections 轮询；
 * - 桌面 ssh 实例装载与状态投影订阅（隧道 URL 永不进 renderer）；
 * - 每实例 workspace/session 聚合（instance-api unary，design 05）；
 * - 本地实例自动启动、注册表远程实例自动连接；
 * - N-ctx shell 挂载（local 常驻，其他来源按需挂载/空闲预热；hide/show
 *   切换经 View Transition 包装（view-transition.ts）：旧视图 visibility+
 *   `content-visibility:hidden` 即时隐去（跳过 style/layout/paint 并缓存
 *   渲染状态），切换与骨架→内容过渡由 `startViewTransition` 的静态旧视图
 *   快照遮盖 reveal 重排——无黑帧、无闪烁；见 styles.css `.instance-hidden`）。
 *   **保留策略（design 05 / 偏差）**：隐藏壳不无限常驻——
 *   除 local 恒留外至多保留 RETAINED_HIDDEN_VIEWS 个，超限回收已 settle 且
 *   连续隐藏 ≥60s 的最久者（retention.ts）；回收仅拆 UI 壳（dispose shell），
 *   实例进程/连接/后台任务不受影响，重开走冷 boot；
 * - chamberBridge 投影发布（design 05）：轮询状态合并为 ChamberServerAggregate[]
 *   供侧边栏插件消费；onOpenSession 通道驱动会话打开。
 * 会话打开请求来自侧边栏插件（经 chamberBridge，design 05）：onOpenSession
 * 通道驱动 openSession 切 shell 并分发；打开终态（成功或预算耗尽失败）经
 * reportOpenSessionOutcome 回报每个侧边栏 shell——失败落在被点击的会话
 * 行内呈现，不是单向通道的 console-only 盲区。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  dispatchSource,
  epochOf,
  reincarnate,
  retainSourceIds,
  waitForCondition,
  type SourceEvent,
  type SourceRegistry,
  LADDER_TABLES,
  sessionAuthorityEscalationLadder,
} from '@dsh-chamber/dsh-stream-state'
import api, { type ConnectionSummary, type HealthResponse } from './api.ts'
import {
  armOpenIntent,
  chamberBridge,
  clearOpenIntents,
  // 意图预热：纯策略函数，接线在下方 drainPrewarm / 订阅 effect。
  emptyIntentPrewarmBudget,
  forgetPendingArchives,
  forgetPendingSessions,
  forgetPendingWorkspaces,
  getOpenIntentsSnapshot,
  releaseInstanceClient,
  releaseOpenIntent,
  serversProjectionSignature,
  shouldHoldViewVeil,
  subscribeOpenIntent,
  sweepPendingArchives,
  sweepPendingSessions,
  sweepPendingWorkspaces,
  type InstanceAggregate,
  type IntentPrewarmBudget,
  type PluginGraphDiagnostic,
} from '@dsh-chamber/dsh-chamber-client-core'
import { createCompleteLedger } from './complete-ledger.ts'
// 预热命中率仪表（attempt/hit/cancelled）。
import { recordPrewarm } from './prewarm-ledger.ts'
// gateway session-state 只读事实源的快照/实例类型（装配在
// app-hooks/use-session-facts-lifecycle.ts）；全部浏览器安全、无 Node import。
import type { SessionFactsSource } from './session-facts-source.ts'
// 生产端：probe 判定 → 侧栏档位（无快照即缺席 = 未知）。
import {
  advanceReadMark,
  browserUnreadStorage,
  loadClientInstallId,
  loadUnread,
  maxWatermark,
  type UnreadStorageLike,
} from './unread-store.ts'
import { pruneSourceList, pruneSourceRecord } from './source-registry.ts'
import { LOCAL_INSTANCE_ID } from './local-instance.ts'
import {
  acknowledgeRendererDelivery,
  authoritativeSourceRetirements,
  classifyRosterGatedSource,
  deliveryMatchesCurrentSource,
  enqueueBoundedRosterIntent,
  parseAuthoritativeSourceFingerprint,
  SerialIntentRunner,
  SourceOwnershipRegistry,
  settlePendingDeepLinkActivation,
  subscribeRosterBeforeRefresh,
  type RendererDeliveryCoordinates,
  type SourceOwnershipToken,
} from './deep-link-activation.ts'
import { openInstanceSession, reconnectInstanceConnection, disposeAllShells, disposeInstanceShell, isSettledShellState, type ShellState } from './shell.ts'
// The official Button atom (ui-primitives/src/Button.tsx) replaces the
// chamber's own `.btn` chrome in every frame-level failure screen. Imported BY
// DEEP SOURCE PATH, the form the chamber ui-layout / ui-sidebar /
// settings-bridge tables already use for an internal module: the package BARREL
// also carries the primitives' markdown / CodeBlock families (~87 KB), which a
// barrel import moves into the MAIN graph while the deep path leaves them in the
// chamber entry. The main graph evaluates before App mount, which is exactly
// what the C3 note in chamber-entry.ts keeps ui-primitives out of.
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import {
  frameText, readDocumentLocale, subscribeDocumentLocale,
  type FrameKey,
} from './locales.ts'
import {
  AGGREGATE_RECONNECT_BACKOFF_MS,
  CONNECTIONS_POLL_MS,
  HEALTH_ERROR_GRACE_MS,
  LISTENER_READY_RETRY_LIMIT,
  LISTENER_READY_RETRY_MS,
  MAX_PENDING_ROSTER_NOTIFICATION_OPENS,
  MAX_PREWARMED_REMOTE_VIEWS,
  REMOTE_ROSTER_RETRY_LIMIT,
  REMOTE_ROSTER_RETRY_MS,
  SERVING_POLL_MS,
  SERVING_WAIT_MS,
} from './host/budgets.ts'
import { deriveServers, type HostFacts } from './host/servers.ts'
import { createSourceLedger, pruneSourceLedger } from './host/source-ledger.ts'
import { useDeadline } from './host/use-deadline.ts'
import { createEchoStore } from './host/echo-store.ts'
import { createCompletedStore } from './host/completed-store.ts'
import { createFactsStore } from './host/facts-store.ts'
import { createMountedSourcesStore } from './host/mounted-sources-store.ts'
import { createRemotesStore } from './host/remotes-store.ts'
import { createRosterGate } from './host/roster-gate.ts'
import { createViewStore } from './host/view-store.ts'
import { useManagedRuntime } from './host/use-managed-runtime.ts'
import { WAIT_SCHEDULER } from './wait-scheduler.ts'
// The self-heal decision lives in the shared container (see dispatchLifecycle);
// test/lifecycle/degraded-retry-decision.test.ts covers its rules against the container.
// Settled-boot gap → render decision (design 05 「降级呈现」). The pure module
// owns the copy key, the retry verdict and the "will the self-heal re-mount
// this?" rule; the frame only maps its keys through `t`.
import { bootGapNotice, isRetryableBootGap, type ShellDegradedKind } from './boot-gap.ts'
import { setPageActiveSource } from './page-language.ts'
import { runViewTransition, type PaintIntent } from './view-transition.ts'
// 揭示门（纯叶子，node 直测）：持有窗/立即揭示的全部规则都在那里，本文件只做接线。
import { revealHoldRemainingMs, revealHoldStartedAt, shouldReveal } from './reveal-gate.ts'
import { captureSidebarScrollAnchor, restoreSidebarScroll } from './sidebar-scroll-sync.ts'
import {
  AggregateRefreshQueue,
  invalidateRemovedAggregateSources,
  remoteRetiredSourceIds,
  retireSelectedSource,
  withoutRemovedSourceIds,
  withoutRemovedSourceKeys,
} from './aggregate-refresh.ts'
// P2 单一权威链：App 侧不再持有 liveness planner/state（ladder 实例见下方；
// tick 与 reconnect/notice 执行端在 app-hooks/use-aggregate-refresh.ts）。
import { errorMessage } from './status.ts'
import {
  instanceBasePath,
  rawInstanceIdFromSourceId,
  sourceIdForInstance,
  sourceIdForRawInstance,
  sourceIdForTransport,
} from './transport-source.ts'
import {
  shouldRunBackgroundPhase,
  VIEW_RECLAIM_TICK_MS,
} from './retention.ts'
import { decideServingGate, servingGatePhase, shouldDeferBootForSource } from './source-readiness.ts'
import { harvestSatisfied } from './baseline-harvest.ts'
import InstanceView from './components/InstanceView.tsx'
import { useAggregateRefresh } from './app-hooks/use-aggregate-refresh.ts'
import { useBadgeCount } from './app-hooks/use-badge-count.ts'
import { useBridgeSubscriptions } from './app-hooks/use-bridge-subscriptions.ts'
import { useSessionFactsLifecycle } from './app-hooks/use-session-facts-lifecycle.ts'
import { useUnreadNotifications } from './app-hooks/use-unread-notifications.ts'
import {
  useAbandonedViewsView,
  useAutoPrewarmedView,
  useDegradedRetriedView,
  useHarvestStateView,
  useHiddenSinceView,
  usePrewarmSuppressedView,
} from './app-hooks/use-source-ledger-views.ts'
import { useViewScheduler } from './app-hooks/use-view-scheduler.ts'
import { PERF_MARKS, perfMark } from './perf-marks.ts'

/**
 * 会话事实权威的升级 ladder：一个引擎实例，数值来自
 * `LADDER_TABLES.authority`（tables.json 的 ladders.authority）。探针 cadence 在
 * producer 执行端；本文件只持有实例，tick 与 reconnect/notice 的执行端在
 * app-hooks/use-aggregate-refresh.ts，且两者都要求 stuck 证据。
 */
const SESSION_AUTHORITY_ESCALATION_LADDER = sessionAuthorityEscalationLadder(LADDER_TABLES.authority)


/** Stable empty list for boots whose failure carries no loader entries. */
const NO_FAILED_ENTRIES: readonly string[] = []

type DeepLinkDelivery = RendererDeliveryCoordinates & {
  /** Raw id is retained while the first authoritative v2 kind roster is unavailable. */
  rawInstanceId: string
  /** Canonical source id once resolved through the authoritative roster. */
  sourceId: string | null
  sourceFingerprint: string
}
type NotificationOpenDelivery = RendererDeliveryCoordinates & {
  sourceId: string
  sourceFingerprint: string
  sessionId: string
}

interface ErrorBoundaryState {
  error: Error | null
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[renderer] component error:', error, info)
    // 崩溃屏替换 children = 所有视图卸载，但 AppWebEntry ctx 不随之消失：
    // 必须在此 dispose 全部 shell（entries 清空），重试后的重 boot 才不会
    // 用新 entry 覆盖未销毁的旧 ctx（僵尸 ctx，design 05 无僵尸不变量）。
    disposeAllShells()
  }

  render(): React.ReactNode {
    if (this.state.error) {
      // Frame copy rides the typed locale
      // dictionary; a class component reads the locale through the module
      // reader (it cannot own a hook).
      const locale = readDocumentLocale()
      return (
        <div className="fatal">
          <div className="fatal-title">{frameText(locale, 'error.ui.title')}</div>
          <div className="fatal-message">{String(this.state.error?.message || this.state.error)}</div>
          {/* The official Button atom; the chamber-invented `.btn` chrome (and
              its own palette entry) is not used. */}
          <Button
            variant="outline"
            onClick={() => {
              this.setState({ error: null })
            }}
          >
            {frameText(locale, 'action.retry')}
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * 单调时基（揭示门；照 InstanceView.tsx:65-75 的既有理由与实现）：持有窗只做差值
 * 比较，绝不能受墙钟步进影响——NTP 校时/休眠唤醒把 `Date.now()` 拉回 10 分钟，会让
 * "已持有 1s"的算术算出负 elapsed，一次性到期定时器就可能不再重臂。`performance.now()`
 * 在渲染器里恒在，缺失时退回墙钟（测试/异常环境）。
 */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

export default function App() {
  // The frame owns no `t` seat, so it
  // renders its own copy from the typed dictionary in locales.ts, in the locale
  // the DOCUMENT declares — `<html lang>` is written by the booted shell's
  // official locale service (syncDocumentLanguage), and the subscription makes a
  // locale change inside dsh re-render the frame chrome (the same value
  // readDocumentLocale() reads, so out-of-render copy cannot drift from it).
  const locale = useSyncExternalStore(subscribeDocumentLocale, readDocumentLocale)
  const t = useCallback((key: FrameKey, params?: Readonly<Record<string, string>>) =>
    frameText(locale, key, params), [locale])
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  // 健康失败首次出现的时间戳：致命屏要求错误**持续**存在（宽容瞬时抖动/
  // SSE 重连窗口），否则首帧成功后的会话中途失联会被陈旧 health 永远掩盖。
  const [healthErrorAt, setHealthErrorAt] = useState<number | null>(null)
  // 连接行初始 null = "尚未拉到首轮"（404 映射空数组 = 权威"无本地行"）；
  // 两种状态区分后，首启（无行）才会触发本地实例自动启动。
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null)
  // 注册表投影（实例表 + 每 raw id 隧道相位）为单一 store：事件回调经
  // getSnapshot() 读最新值，渲染与回调不再各持一份（host/remotes-store.ts）。
  const [remotesStore] = useState(createRemotesStore)
  const remotes = useSyncExternalStore(remotesStore.subscribe, remotesStore.getSnapshot, remotesStore.getSnapshot)
  const remoteInstances = remotes.instances
  // 注册表闸门（单一权威）：generation/settledGeneration/listenerReady 都在
  // host/roster-gate.ts，渲染值与事件回调同步读同一份快照（无 state/ref 镜像）。
  const [rosterGate] = useState(createRosterGate)
  const roster = useSyncExternalStore(rosterGate.subscribe, rosterGate.getSnapshot, rosterGate.getSnapshot)
  // At most one renderer activation is useful: view switching is
  // last-intent-wins. This fixed-size slot prevents a failed roster from
  // growing a second unbounded queue behind main's already-bounded queue.
  const pendingDeepLinkDeliveryRef = useRef<DeepLinkDelivery | null>(null)
  // Notification opens carry a session id and cannot collapse to a source-only
  // last intent. Preserve them in order, but mirror main's 64-entry bound.
  const pendingRosterNotificationOpensRef = useRef<NotificationOpenDelivery[]>([])
  // Last-started roster pull wins. An instances-changed event increments this
  // generation before the replacement pull so an older response cannot revive
  // a removed source or prematurely settle the new generation.
  const remoteRosterRefreshSeqRef = useRef(0)
  // Async work that has left the roster-pending FIFO captures an exact object
  // owner. Only active sources occupy the registry; retirement deletes the
  // current object and an authoritative re-add activates a fresh one.
  const sourceLifecyclesRef = useRef<SourceOwnershipRegistry | null>(null)
  sourceLifecyclesRef.current ??= new SourceOwnershipRegistry([LOCAL_INSTANCE_ID])

  const acknowledgeDeepLink = useCallback(async (delivery: RendererDeliveryCoordinates): Promise<void> => {
    const deepLink = window.dshChamber?.deepLink
    if (deepLink === undefined) throw new Error('deep-link ACK bridge unavailable')
    const acknowledged = await acknowledgeRendererDelivery(
      delivery,
      (deliveryId, attempt) => deepLink.ack(deliveryId, attempt),
    )
    if (!acknowledged) {
      console.warn(`[renderer] ignored stale deep-link ACK ${delivery.deliveryId}/${delivery.attempt}`)
    }
  }, [])

  const acknowledgeNotificationOpen = useCallback(async (delivery: RendererDeliveryCoordinates): Promise<void> => {
    const notifications = window.dshChamber?.notifications
    if (notifications === undefined) throw new Error('notification ACK bridge unavailable')
    const acknowledged = await acknowledgeRendererDelivery(
      delivery,
      (deliveryId, attempt) => notifications.ack(deliveryId, attempt),
    )
    if (!acknowledged) {
      console.warn(`[notifications] ignored stale open ACK ${delivery.deliveryId}/${delivery.attempt}`)
    }
  }, [])

  const reportDeepLinkAckFailure = useCallback((delivery: RendererDeliveryCoordinates, error: unknown): void => {
    console.error(`[renderer] deep-link ACK exhausted retries (${delivery.deliveryId}/${delivery.attempt}):`, error)
  }, [])

  const reportNotificationAckFailure = useCallback((delivery: RendererDeliveryCoordinates, error: unknown): void => {
    console.error(`[notifications] open ACK exhausted retries (${delivery.deliveryId}/${delivery.attempt}):`, error)
  }, [])
  const remoteStatus = remotes.status
  // 视图：'local' | '<kind>-<id>'。N-ctx 常驻语义（design 05）就是保留策略
  // （retention.ts）：local 恒留；隐藏非 local 壳最多
  // 保留 RETAINED_HIDDEN_VIEWS 个，超限回收"已 settle + 连续隐藏 ≥60s"的
  // 最久者（回收 = dispose shell + 卸载壳；实例进程/连接/后台任务不受影响，
  // 重开走冷 boot + entry 重放——见 reclaimView）。会话保活由实例侧承担，
  // UI 壳不无限常驻。
  // 视图对（active=选择 / painted=屏上）单一权威：host/view-store.ts。事件回调、
  // 微任务与保留/揭示守卫读 store 快照（旧的两条渲染期 ref 镜像删除）。
  const [viewStore] = useState(() => createViewStore(LOCAL_INSTANCE_ID))
  const view = useSyncExternalStore(viewStore.subscribe, viewStore.getSnapshot, viewStore.getSnapshot)
  const activeView = view.active
  /**
   * 延迟揭示：**屏上真正可见的那个视图**。与 activeView（选择）
   * 分离——点击只改选择，painted 由下方揭示 effect 在「目标首帧可用」时经既有
   * 'view' 过渡键收敛。为什么必须分离（事实）：`view-transition.ts:6-11` 的语义是
   * "新状态渲染就绪后动画才开始"，冷 boot 的"新状态首帧"就是遮罩本身——VT 单独
   * 做不到"boot 期保持旧视图"。两者相等 = 稳态；不等 = 一次在途揭示（至多一个）。
   * 判定规则见纯叶子 `reveal-gate.ts`（node 直测）。
   * 驱动面（只有这些消费者读 painted，其余一律读选择语义的 activeView）：
   * `InstanceView active=`（可见性）、hover 卡关闭、保留回收的"展示中"保护、
   * `deriveServers.projectableCurrent`（侧栏高亮跟随屏上来源）、hiddenSince 起表。
   */
  const paintedView = view.painted
  const [mountedViews, setMountedViews] = useState<string[]>([LOCAL_INSTANCE_ID])
  // Views mounted only by background prewarm. User selection removes the id
  // from this set, freeing one of the idle-prewarm slots while keeping
  // the user-opened N-ctx shell resident.
  // The incarnation fence uses the ownership registry's REAL fingerprint (the registry
  // tracks it per view), so a re-registered source gets a fresh record and a
  // reclaim/re-mount cycle keeps its history - the distinction this container exists to
  // express. `undefined` (the registry has not captured the view yet) falls back to the
  // id, matching "one record per view" until the registry catches up.
  // Declared BEFORE the ledger views below: they close over it, and their useMemo
  // dependency arrays read it during render, so a later declaration would be a TDZ
  // error in a real browser (the node suites strip types and never render App).
  const dispatchLifecycle = useCallback((viewId: string, event: SourceEvent, capturedEpoch?: number) => {
    let registry = sourceLedgerStoreRef.current
    let epoch = capturedEpoch ?? epochOf(registry, viewId)
    if (epoch === undefined) {
      // The authoritative roster refresh pre-registers every source through
      // reincarnate(), so this lazy path only covers an event that beats that refresh
      // (or a local view). It is the ONLY place the ownership fingerprint is read -
      // an event no longer recomputes it, and it must never resurrect a retired
      // generation.
      const fingerprint = sourceLifecyclesRef.current?.capture(viewId)?.fingerprint ?? viewId
      registry = reincarnate(registry, { sourceId: viewId, fingerprint })
      epoch = epochOf(registry, viewId)
    }
    if (epoch === undefined) return undefined
    // `retryableGap` is passed as data from `isRetryableBootGap`: the registry
    // owns the decision, the App keeps owning the table it supplies.
    const reduction = dispatchSource(
      registry,
      viewId,
      { ...event, epoch },
      { reclaimGraceMs: 0, retryableGap: (kind) => isRetryableBootGap(kind as ShellDegradedKind) },
    )
    // A dropped event (superseded epoch / unregistered source) returns the SAME
    // registry reference, so this write cannot resurrect or mutate a retired life.
    sourceLedgerStoreRef.current = reduction.registry
    return reduction.effects[0]?.effect
  }, [])
  //  a Set LEDGER view - reads project the container, and each add/delete becomes
  // one event. The Set shape is why this cannot be the assignment-translating view the
  // record ledgers use: add/delete are method calls. Iteration is snapshot-based, so
  // the three sweep loops that delete while iterating stay safe (see the adapter).
  const autoPrewarmedRef = useAutoPrewarmedView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })
  // 保留策略：被回收（闲置隐藏壳超限回收）的源禁止自动预热，直到用户主动
  // 点开（selectView 清除）或来源从注册表删除（retireSources 清除）——否则
  // prewarmEligible 会立刻把刚回收的源重新 boot，回收空转（见 reclaimView）。
  const prewarmSuppressedRef = usePrewarmSuppressedView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })
  // 设置面板目标来源（design 05）：面板渲染的是**选中
  // 来源自己的 boot ctx 台账**，所以该来源的壳必须挂载着。面板打开期间由 App
  // 保证两件事——未挂载则后台挂载（不切 active view），已挂载则排除出保留策略
  // 回收候选（否则隐藏 60s 后壳被拆，面板正在编辑的设置面随之消失）。面板关闭
  // (`undefined`) 即撤除这两条保证。
  const settingsTargetRef = useRef<string | undefined>(undefined)
  // 首屏基线收割（design 05 / baseline-harvest.ts）：ready 但从未挂载过的
  // 来源在后台预热槽里挂一次，拿到首个权威推送即回收——否则它稳态停留在
  // unary 兜底视图（合成分组 + 空归档集）直到用户点击。harvestStateRef 是
  // 每源账本（尝试次数/退避/是否已满足），harvestIntentRef 记录"当前这次挂载
  // 是收割挂载"（提交推送、boot 失败、用户点开三条路径据此分流）。
  //  the harvest slots are container-backed. Every call site reads a whole record,
  // runs a baseline-harvest PURE function, and stores the result back, so the view
  // accepts the finished record (the policy functions stay where they are; storage
  // has one owner).
  const harvestStateRef = useHarvestStateView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })
  const harvestIntentRef = useRef<Set<string>>(new Set())
  // 仍需收割的来源（prewarmEligible 的渲染期镜像）：提交推送时据此决定"保留
  // 最后收割的壳当温壳"还是"回收让位给下一个候选"。
  const harvestCandidatesRef = useRef<Set<string>>(new Set())
  // reclaimView 的 ref 镜像：定义在下方（依赖 mountedViews），而
  // handleShellState / onInstanceSnapshot 是 [] 依赖的回调——它们只能经此
  // 拿到最新闭包（同 reclaimHiddenViewsRef 纪律）。
  const reclaimViewRef = useRef<(id: string, reason?: 'retention' | 'harvest') => void>(() => undefined)
  // 保留策略计时：每视图"连续隐藏"起点（ms epoch；**屏上视图无键**）。settle
  // 完成或离开屏时置 now，重新画上屏删除，随 mountedViews 收敛清理（回收 effect
  // 内统一处理）。previousActiveViewRef 供 paintedView 落地 effect 对比
  // （起表/清表都按 painted——活跃判定 activeView 会让持有窗内的屏上壳被计时）。
  // The hidden-window ledger lives in ONE per-source state object. The ref
  // below is a LIVE VIEW, not a store: reads project the
  // container, and the scheduler's direct writes (delete/timestamp) are translated
  // into reducer events. That keeps the call sites unchanged while leaving
  // exactly one owner.
  const sourceLedgerStoreRef = useRef<SourceRegistry>({})
  // The incarnation fence uses the ownership registry's REAL fingerprint (the
  // registry above already tracks it per view), so a re-registered source gets a
  // fresh record and a reclaim/re-mount cycle keeps its history - the distinction
  // this container exists to express. `undefined` (registry has not captured the
  // view yet) falls back to the id, matching "one record per view" until the
  // registry catches up.
  // A LIVE VIEW, not a store: reads project the container on every access (so the
  // scheduler's momentary reads can never observe a stale render), and the
  // scheduler's direct writes are translated back into reducer events. The call
  // sites stay unchanged while there is exactly one owner.
  const hiddenSinceRef = useHiddenSinceView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })
  const previousActiveViewRef = useRef<string | null>(paintedView)
  // chamber：每视图 shell 终态（InstanceView
  // 经 onStateChange 上报）——活动视图 boot 失败时由 App 渲染统一失败覆盖层
  // （失败报告 + 重试 + 服务器切换）。retryTokens 驱动 InstanceView 的重试
  // 重 boot（令牌递增 → 视图复位 → 重新启动 shell）。
  const [shellStates, setShellStates] = useState<Record<string, ShellState>>({})
  /**
   * 来源就绪门 + 降级自愈：
   * ① 实例仍启动时让取图等它就绪（冷启动 / 重启跨越窗口不丢整套 profile
   *    客户端插件；`ui-chat` 依赖的 `sidebarRight` 只由其中的 ui-sidebar-right
   *    行提供）；
   * ② boot 以降级收尾（无图 / 必需 extra-row 服务缺席）而来源随后 ready 时，
   *    自动重挂一次。每个 ready 世代一次。
   * 相位从 servers 的渲染期镜像读取，门自身带绝对上限，来源被移除即放弃。
   */
  const serversPhaseRef = useRef<Record<string, string | undefined>>({})
  const waitForServing = useCallback(async (instanceId: string): Promise<boolean> => {
    // 终态宽限：用户点来源时 App 会先触发一次即时重连，相位需要一两个
    // tick 才翻到 connecting——终态必须**持续**一段时间才判"不可服务"，
    // 否则会把正在恢复的来源误报成未连接。
    let terminalSince: number | null = null
    // The wait is the shared primitive. The bound is passed as a
    // WALL-CLOCK budget (`now`): the primitive itself must not
    // count TICKS, or a delayed event loop would overrun the 60s boot budget.
    // Order is preserved: the gate is judged first, the bound second.
    let verdict: boolean | null = null
    const outcome = await waitForCondition({
      pollMs: SERVING_POLL_MS,
      boundMs: SERVING_WAIT_MS,
      scheduler: WAIT_SCHEDULER,
      now: () => Date.now(),
      isDone: () => {
        const phase = serversPhaseRef.current[instanceId]
        // undefined（投影未到）交给纯判定：事实未到不是"未连接"，预算内继续等。
        if (phase === 'ready') { verdict = true; return true }
        // 相位感知：`error`（快速重试耗尽）与
        // idle（手动断开）不烧满整个 boot 预算；`connecting`/`degraded`
        // （恢复中）继续在预算内等。判定是纯逻辑（source-readiness），本处只接线。
        const decision = decideServingGate({ phase, nowMs: Date.now(), terminalSinceMs: terminalSince })
        if (decision.action === 'serve') { verdict = true; return true }
        if (decision.action === 'unavailable') { verdict = false; return true }
        terminalSince = decision.terminalSinceMs
        return false
      },
    })
    // Expiry: the budget ran out and the source never served.
    return outcome === 'expired' ? false : verdict === true
  }, [])
  // The once-per-ready-epoch self-heal mark, projected from the SAME container.
  // The scheduler's clear (`[id] = false`) translates to the container's
  // `retryForgotten` at the view's write point, so the mark's lifecycle has one owner.
  const degradedRetriedRef = useDegradedRetriedView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })
  const [retryTokens, setRetryTokens] = useState<Record<string, number>>({})
  // 每实例 workspace/session 聚合（已挂载 ctx 推送 + 未挂载 unary 兜底；控制面不持有会话事实）
  const [aggregates, setAggregates] = useState<Record<string, InstanceAggregate>>({})
  // Complete snapshots reported by mounted ctx stores. A source appears here
  // only while both reconnect baselines are idle + ready; loading/error
  // withdraws ownership so an identical recovered baseline is re-published.
  // Complete sources require no periodic unary aggregation; unmounted/
  // incomplete sources retain the bounded fallback below.
  // mounted 表单一权威：host/mounted-sources-store.ts（渲染值与事件侧同步读同一份）。
  const [mountedSources] = useState(createMountedSourcesStore)
  const snapshotSources = useSyncExternalStore(mountedSources.subscribe, mountedSources.getSnapshot, mountedSources.getSnapshot)
  // 完成未读账本（蓝点）单一权威：渲染表 = 落盘 edge 表 = 事件侧 prevLedger 读。
  const [completedStore] = useState(createCompletedStore)
  const completedBySource = useSyncExternalStore(completedStore.subscribe, completedStore.getSnapshot, completedStore.getSnapshot)
  // 每来源记账账本：字段表与单一 prune 清单都在 host/source-ledger.ts。
  // 以下别名保持既有接线（app-hooks 收到的是同一批 ref 盒，形状不变）。
  const [sourceLedger] = useState(createSourceLedger)
  const {
    snapshotAt: snapshotAtRef,
    factsAt: factsAtRef,
    lastReconnectAt: lastReconnectAtRef,
    sessionListRefreshAt: sessionListRefreshAtRef,
    sessionListRefreshPending: sessionListRefreshPendingRef,
    authoritativeArchiveSet: authoritativeArchiveSetRef,
    prevRunning: prevRunningRef,
    prevRuntimeFacts: prevRuntimeFactsRef,
    readMarks: readMarksRef,
    factsSeeded: factsSeededRef,
    refreshHintAt: refreshHintAtRef,
    factsPullInFlight: factsPullInFlightRef,
  } = sourceLedger
  // Synchronous connection-generation edge memory. A mounted producer may
  // suppress an identical post-reconnect snapshot, while the App has already
  // replaced its aggregate with not-connected; one authoritative pull on each
  // not-ready -> ready edge closes that gap without restoring periodic RPCs.
  const readyAggregateSourcesRef = useRef<Set<string>>(new Set())
  // Unary aggregate pulls and bounded retries use latest-owner object tokens.
  // The table is active-only: retirement/disconnect deletes ownership, while
  // a later same-id pull receives a never-reused object.
  const aggregateRequestOwnersRef = useRef<SourceOwnershipRegistry | null>(null)
  aggregateRequestOwnersRef.current ??= new SourceOwnershipRegistry()
  const aggregatePollSeqRef = useRef<Record<string, number>>({})
  const mutationRefreshSeqRef = useRef<Record<string, number>>({})
  const aggregateFailuresRef = useRef<Record<string, number>>({})
  const aggregateRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const aggregateRefreshQueueRef = useRef(new AggregateRefreshQueue())
  const clearAggregateRetry = useCallback((sourceId: string): void => {
    const timer = aggregateRetryTimersRef.current.get(sourceId)
    if (timer === undefined) return
    clearTimeout(timer)
    aggregateRetryTimersRef.current.delete(sourceId)
  }, [])
  const [pluginDiagnostics, setPluginDiagnostics] = useState<Record<string, PluginGraphDiagnostic | undefined>>({})
  // 工作区创建回声：侧栏在某来源上用 unary
  // `workspace.create` 建好工作区后，把宿主 workspaceId 上报到这里；App 在
  // **投影那一个**汇合点（deriveServers）把该行并入，直到权威 `workspace/follow`
  // push 覆盖它。为什么需要：未挂载来源只有 unary 兜底（工作区靠会话 cwd 反推，
  // 新空工作区没有会话 ⇒ 结构上不可见），已推送来源的工作区集又被冻结
  // （commitAggregatePull 的 mounted merge），所以 requestRefresh 无论哪条分支
  // 都刷不出这一行——表现为"必须手动点一下那个服务器"。
  // 账本是单一 store（host/echo-store.ts）：渲染与事件侧读同一份快照。
  // 三本回声账本（workspace/session/archive）合并为单一 store：渲染快照与事件侧
  // 同步读是同一份（见 host/echo-store.ts），没有 state+ref 镜像与双写回调。
  const [echoStore] = useState(createEchoStore)
  const echoes = useSyncExternalStore(echoStore.subscribe, echoStore.getSnapshot, echoStore.getSnapshot)
  const {
    updateWorkspace: updateWorkspaceEcho,
    updateSession: updateSessionEcho,
    updateArchive: updateSessionArchive,
  } = echoStore
  // 会话创建回声：侧栏的 "+" 与
  // 行菜单 fork 都经**该来源自己的 unary client** 建会话。挂载壳的官方 summaries
  // 只有一条异步外源（宿主的 api-session/added 广播）：竞态窗内随后那次挂载推送
  // 会拿还不含它的 store 替换整份聚合，行随即消失；而未挂载来源（收割后的稳态，
  // 工作区行仍是真实推送行）根本收不到广播，30s unary 兜底的 mounted merge 又冻结
  // 工作区成员位——新会话只能以未归属散落行出现，且仍是暂存 blank 行时不进导航。
  // 表现：新建的会话要切到那个服务器（挂载 → follow 基线）才出现。账本记录
  // 宿主 id 并立刻并入投影，权威视图（App 在事实到达时请求的官方 session-list
  // 刷新——只有挂载壳有这条 seam，它强制 summaries 重读语料——或该来源下次挂载）
  // 到达即退场（reconcilePendingSessions）。与会话打开意图同纪律：单一 store。
  // 会话归档墓碑：侧栏的归档动词同样走 unary，未挂载来源
  // （收割后的稳态）没有任何活通道——mounted merge 冻结上次推送的 archivedSessionIds、
  // unary 兜底根本没有归档 wire，于是刚归档的行照样留在列表里且可点（点开即空视图：
  // 官方运行时会把 archived current 清掉）。本账本把**本页自己归档**的 id 过滤掉，直到
  // 权威归档集覆盖它；别处（另一个客户端）归档的仍需挂载（已知残余）。租约由
  // 兜底拉取续期（只要那份错视图还在列它，就继续藏）；权威集覆盖 / 来源退役 / 租约到期
  // 收敛。与会话回声同纪律：同一 store。
  /**
   * Expire echoes past their TTL. Called from every tick that can change what a
   * source's workspace list SHOULD contain — a new creation, an authoritative
   * mount push, and each fallback pull — because an echo whose convergence never
   * arrives (a source that is never mounted again, a workspace deleted on the
   * host by another client) has no other clock: sweeping only inside the create
   * handler would let such an entry live for the rest of the session. Identity
   * preserving, so a sweep that expires nothing costs no re-render.
   */
  const sweepWorkspaceEcho = useCallback((): void => {
    updateWorkspaceEcho(sweepPendingWorkspaces(echoStore.getSnapshot().workspace, Date.now()))
  }, [updateWorkspaceEcho, echoStore])
  /**
   * Session-echo TTL tick (same three clocks as the workspace echo: a new
   * creation — where the recording handler sweeps before it records — an
   * authoritative mount push, and each fallback pull). The TTL is a leak guard,
   * not a convergence budget: a create whose convergence never arrives (a
   * source that is never mounted again, a session deleted on the host by
   * another client) must still expire. Identity preserving.
   */
  const sweepSessionEcho = useCallback((): void => {
    updateSessionEcho(sweepPendingSessions(echoStore.getSnapshot().session, Date.now()))
  }, [updateSessionEcho, echoStore])
  /** Lease-expiry tick for the local archive tombstones (the fallback pull clock, plus
   *  the archive fact tick which sweeps before recording). */
  const sweepSessionArchive = useCallback((): void => {
    updateSessionArchive(sweepPendingArchives(echoStore.getSnapshot().archive, Date.now()))
  }, [updateSessionArchive, echoStore])
  // 会话打开意图：App 是唯一写者
  // （openSession 的 arm/release），槽位本身在 sidebar 包的 shared/open-intent.ts
  // ——它是跨 ctx 单例，因为 boot 期早开臂要在**目标实例自己的 ctx 内**读它。
  // 这里经 useSyncExternalStore 绑定：快照在无变化时保持同一引用，一次 arm /
  // 一次 release 各触发一次重渲染，投影门与揭示门同时生效。
  const openIntents = useSyncExternalStore(subscribeOpenIntent, getOpenIntentsSnapshot)
  // 每实例运行时事实 + 每来源 facts 快照合并为一个 store（host/facts-store.ts）：
  // 渲染快照与事件回调的同步读是同一份，没有 ref 渲染期镜像。
  const [factsStore] = useState(createFactsStore)
  const facts = useSyncExternalStore(factsStore.subscribe, factsStore.getSnapshot, factsStore.getSnapshot)
  const runtimeFacts = facts.runtime
  const [hostFacts, setHostFacts] = useState<Record<string, HostFacts | undefined>>({})
  // gateway 来源的托管 dsh connectionState（探针见下方
  // managed-runtime.ts）。null = 探不到（fail open），键随来源生命周期收敛。
  // 托管 dsh 探针簇（状态 + 15s 前台探针 + 退役收敛）在 host/use-managed-runtime.ts。
  const { managedRuntime, probeRef: probeManagedRuntimeRef, retireManagedRuntime } = useManagedRuntime(remoteInstances)
  // chamber (design 06)：App 自持的「完成未读」蓝点（completedBySource）
  // 与边沿记忆（prevRunningRef）。蓝点不依赖各来源 shell 的 selected——后台
  // 来源的陈旧 selected 会让 vendor 提醒错误压制「完成但未读」——而是由 App
  // 从上报里的实时 running 位自行推导 running→idle 边沿，以 App 已知的
  // 「谁在阅读」（**屏上来源** paintedView + 各来源 current + 焦点）判定武装/解除。
  // 插件侧保持无状态（纯投影），避免在每 ctx 复制一套状态机。
  // facts wiring：completedBySource 是 deriveSourceUnread 的
  // **派生投影**；durable 回退账本
  // （completedStore）与读水位（readMarksRef）在首帧从 v2 落盘载入，
  // 撤回/同代重挂/重启后由事实重算。
  const [unreadBoot] = useState(() => {
    const storage = browserUnreadStorage()
    const payload = loadUnread(storage)
    return { storage, payload }
  })
  const unreadStorageRef = useRef<UnreadStorageLike | undefined>(unreadBoot.storage)
  // 落盘载荷在首帧装进账本（在任何 effect 之前）。
  readMarksRef.current = unreadBoot.payload.read
  completedStore.seed(unreadBoot.payload.edge)
  // complete 通知账本（设计 19）：水位轨（facts 入口，
  // 单调只升）与武装轨（壳边沿入口，直到重新 running）共用一个容器与键空间，规则
  // 本体仍在 watermark.ts / notification-edges.ts；初始表来自 v2 落盘。
  const completeLedgerRef = useRef(createCompleteLedger(unreadBoot.payload.notified))
  const clientInstallIdRef = useRef('')
  if (clientInstallIdRef.current === '') clientInstallIdRef.current = loadClientInstallId(unreadBoot.storage)
  /** 每来源 facts 快照（判定输入：completedAt/updatedAt/lastTurnEnd/pendingKind）。 */
  const sessionFacts = facts.session
  /** 活跃事实源实例（gateway 来源；指纹变化 = 新化身重探）。 */
  const sessionFactsSourcesRef = useRef<Map<string, SessionFactsSource>>(new Map())
  /** 每个实例的退订 + stop 合成器（来源退役/降级时调用一次）。 */
  const sessionFactsTeardownRef = useRef<Map<string, () => void>>(new Map())
  // 非 gateway 来源的无壳观察者（SSH/dsh 远端没有只读镜像可依赖）。
  const sourceMuxTeardownRef = useRef<Map<string, () => void>>(new Map())
  // 观察者必须按**身份**（sourceId + sourceFingerprint）收敛——只按 id 去重会让
  // 「同 id 新指纹」（身份编辑/重连后的新化身）复用旧观察者，rows/runningBefore 跨化身串味。
  const sourceMuxIdentityRef = useRef<Map<string, string>>(new Map())
  /** 读标记落盘节流（≤1 次/秒；pagehide/hidden 立即 flush）。 */
  const unreadSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushUnreadRef = useRef<() => void>(() => undefined)

  // chamberBridge 投影（design 05）：health/remoteStatus/aggregates 任一变化后
  // 派生并发布；首帧（health 未就绪）即发布 connected=false 的分组。
  const servers = useMemo(
    // current 投影（侧栏高亮）跟随 **paintedView**（屏上是谁），不是选择——
    // 持有窗内用户点向 B 时屏上仍是 A，A 的当前会话高亮摘掉再装回是纯闪烁；
    // 揭示完成那一拍 painted 变化（本 memo 依赖）自然把高亮交棒给 B。
    () => deriveServers(health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts, completedBySource, paintedView, pluginDiagnostics, shellStates, managedRuntime, echoes.workspace, echoes.session, echoes.archive, openIntents, locale, sessionFacts),
    [health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts, completedBySource, paintedView, pluginDiagnostics, shellStates, managedRuntime, echoes, openIntents, locale, sessionFacts],
  )
  // chamberBridge publish 签名闸：servers 在每次依赖变化
  // 时都会重建（含聚合快照上报/兜底、30s 注册表轮询、状态推送的恒新对象），但
  // 只有**渲染相关内容**变化才值得通知订阅方——否则每个 shell 的侧边栏都会
  // 周期性兜底触发全量重渲染。签名排除无人消费的 server.updatedAt 时间戳。设置桥的
  // subscribeServers 早已做了同类去重（本闸是对 publish 源头的收口）。
  const lastServersSignatureRef = useRef('')
  useEffect(() => {
    const signature = serversProjectionSignature(servers)
    if (signature === lastServersSignatureRef.current) return
    lastServersSignatureRef.current = signature
    chamberBridge.publish(servers)
  }, [servers])

  // 相位镜像（waitForServing 读它；effect 里写，避免渲染期改 ref）。远端来源取
  // **原始 transport 投影**的相位（与 deferredBootIds 同源）：deriveServers 把
  // "投影未到达"发布成 SOURCE_PHASE_UNKNOWN（'unknown'），那是缺失事实的合成值——
  // 折叠值当输入会让一次投影延迟被就绪门快判成"未连接"。本地来源没有 transport 投影，
  // 用派生相位；undefined = 事实未到，门在预算内继续等。
  useEffect(() => {
    const phases: Record<string, string | undefined> = {}
    for (const server of servers) {
      if (server.id === LOCAL_INSTANCE_ID) { phases[server.id] = server.phase; continue }
      const rawId = rawInstanceIdFromSourceId(server.id)
      // 纯函数决定语义（可单测）：原始投影缺席 → undefined（等）；在场 → 派生相位
      // （含托管折叠的终态词表）。
      phases[server.id] = rawId === null
        ? server.phase
        : servingGatePhase(server.phase, remoteStatus[rawId] !== undefined)
    }
    serversPhaseRef.current = phases
  }, [servers, remoteStatus])

  /**
   * boot 推迟集合：**手动断开**（idle）的来源不
   * 启动 shell——一次注定吃满 503 预算的 boot 只会白烧，还会把用户丢进加载态。
   * 遮罩此时呈现「未连接」+「连接」，点连接后相位离开 idle，正常 boot 开始。
   * 未知相位（投影未到）不推迟；本判定是渲染期事实（`servers`），不用 ref 镜像。
   */
  const deferredBootIds = useMemo(() => {
    const ids = new Set<string>()
    for (const server of servers) {
      if (server.id === LOCAL_INSTANCE_ID) continue
      // 事实源必须是**原始 transport 投影**（remoteStatus 以 raw id 为键）：
      // deriveServers 把"投影未到达"发布成 `SOURCE_PHASE_UNKNOWN`（`remoteStatus[...]?.phase ?? SOURCE_PHASE_UNKNOWN`），
      // 那不是手动断开事实——拿折叠值当输入会把一次投影延迟/状态拉取失败变成
      // "该来源未连接、拒绝 boot"，而纯契约明确要求 undefined 绝不推迟。
      const rawId = rawInstanceIdFromSourceId(server.id)
      if (rawId === null) continue
      if (shouldDeferBootForSource(remoteStatus[rawId]?.phase)) ids.add(server.id)
    }
    return ids
  }, [servers, remoteStatus])
  /** 推迟集合的稳定签名：让"起表/豁免"的 effect 只在成员变化时重跑。 */
  const deferredBootSignature = useMemo(
    () => [...deferredBootIds].sort().join('\u0000'),
    [deferredBootIds],
  )
  /** 渲染期镜像（effect 与清理臂读它，避免把它们挂到 servers 的依赖上）。 */
  const deferredBootRef = useRef<ReadonlySet<string>>(new Set<string>())
  deferredBootRef.current = deferredBootIds

  useEffect(() => {
    // Feed the facts into the container BEFORE planning, so the self-heal mark
    // has one owner. The dispatch is idempotent: `bootSettled` spreads the previous state (the mark survives a
    // repeat), and `phaseChanged` away from ready drops the mark (a fresh ready
    // transition earns the next attempt). `isRetryableBootGap` is the table the
    // reducer receives, so retryability still has a single source.
    for (const server of servers) dispatchLifecycle(server.id, { kind: 'phaseChanged', phase: server.phase })
    for (const [instanceId, state] of Object.entries(shellStates)) {
      if (state.degraded === null) continue
      dispatchLifecycle(instanceId, {
        kind: 'bootSettled',
        outcome: 'degraded',
        gapKind: state.degraded.kind,
      })
    }
    // The re-boot list comes from the container's typed effect. The mark is
    // written by the same reduction that decides, so
    // "who decided" and "who remembers" are one place; the carry-forward is
    // reproduced by dispatching the same facts every pass (see the note above).
    const retry: string[] = []
    for (const [instanceId, state] of Object.entries(shellStates)) {
      if (state.degraded === null) continue
      const effect = dispatchLifecycle(instanceId, {
        kind: 'bootSettled',
        outcome: 'degraded',
        gapKind: state.degraded.kind,
      })
      if (effect?.e === 'degradedSelfHeal') retry.push(instanceId)
    }
    if (retry.length === 0) return
    console.warn(`[app] degraded shell(s) re-booting after the source became ready: ${retry.join(', ')}`)
    setRetryTokens(prev => {
      const next = { ...prev }
      for (const instanceId of retry) next[instanceId] = (next[instanceId] ?? 0) + 1
      return next
    })
  }, [servers, shellStates])

  // 托管 dsh 探针 effect（15s/仅前台/单飞+超时/退役收敛）见
  // host/use-managed-runtime.ts；probeManagedRuntimeRef 由该 hook 返回。
  // 注册表 id 的命令式权威集合：selectView 与 openSession 在 apply 时用它拒绝
  // 已回收来源（视图生命周期 = 注册表条目生命周期，design 05）。This is not a render
  // mirror. Event-side invalidate/success edges must not be overwritten by a
  // concurrent or stale render. refreshRemotes replaces it synchronously when
  // the matching registry generation succeeds; local is always authoritative.
  const liveServerIdsRef = useRef<Set<string>>(new Set([LOCAL_INSTANCE_ID]))
  const liveServerIds = useMemo(() => new Set(servers.map(server => server.id)), [servers])

  // 隧道相位与实例表（按原始注册表 id 键控，onStatusChanged 推送的 payload.id）：
  // ensureRemoteConnected 经 remotesStore.getSnapshot() 读最新相位而不进依赖——
  // selectView/openSession 的身份保持稳定，相位变化不重建这些回调。

  // pendingViewRef = 在途/顺延中的最新切换意图（过渡链 apply 前有效）。
  // selectView 的早期返回必须查已落地的 active（store 快照，永远最新）而非闭包：
  // 过渡在途时 UI 仍显示旧视图，用闭包里的 activeView 会把「切回旧视图」的撤销
  // 意图误判为无操作丢弃——违反 view-transition.ts 的「最后一次意图胜出」性质。
  /**
   * 揭示门的持有窗起点（单调钟 ms；null = 当前稳态）。`revealHoldStartedAt` 推进它：
   * 一次在途揭示从分叉那一拍起算，回到稳态即清空（见 reveal-gate.ts 头注）。
   */
  const revealHoldStartedAtRef = useRef<number | null>(null)
  /** 持有窗到期的一次性重算触发器（照 InstanceView 的 surfaceFallbackTick 形态）。 */
  const [revealTick, setRevealTick] = useState(0)
  const pendingViewRef = useRef<string | null>(null)
  /**
   * 用户在遮罩上显式放弃的视图：只由遮罩的「切换来源」写入，由
   * `selectView`（用户又点回它 = 撤回意图）或落地回收删除。声明位置必须在
   * `selectView` 之前——撤回就发生在那里。
   */
  // 放弃标记：被放弃的视图 → 当时要切去的目标。记目标是为了能在"切换没落地"
  // （目标退役/被删）时撤回标记。
  //  Map LEDGER view - reads project the container, set/delete become events.
  // The sweeps iterate a snapshot, so deleting inside the loop stays safe.
  const abandonedViewsRef = useAbandonedViewsView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })

  /**
   * N-ctx 视图回收（设计 05）：视图生命周期 = 注册表条目生命周期。
   * 只有来源从注册表删除时才卸载其视图并 dispose shell——连接失败/手动
   * 断开是瞬时事实（投影为图标/徽标），不回收视图：设置页卡片与侧边栏
   * 分组都锚定注册表，视图若随瞬时状态消失会造成三面不匹配（如侧边栏
   * 分组头仍可激活一个立即被回收的视图），且与「会话保活」的 N-ctx
   * 设计意图相悖。local 常驻。被回收的视图若是当前视图则回落到 local。
   * identity-preserving：无变化时两个 setter 都返回原值（servers 每轮
   * 轮询/推送都重建，不能借此触发无谓重渲染）。
   */
  useEffect(() => {
    const live = new Set(servers.map(server => server.id))
    // dispose 是副作用，不能放进 setState updater（React 19 渲染期可能急切
    // 求值 updater，StrictMode 还会双调用）——先从当前 mountedViews 算出
    // 被回收的 id 再统一处置；setMountedViews 保持 identity-preserving。
    const removed = mountedViews.filter(id => !live.has(id))
    if (removed.length > 0) {
      for (const id of removed) {
        autoPrewarmedRef.current.delete(id)
        // 保留策略：注册表删除 = 生命周期终结，抑制键随视图一起收敛。
        prewarmSuppressedRef.current.delete(id)
        // 收割账本同源收敛：同 id 重新注册 = 新来源代，账本从零开始。
        delete harvestStateRef.current[id]
        harvestIntentRef.current.delete(id)
        disposeInstanceShell(id)
        chamberBridge.clearPluginDiagnostic(id)
      }
      setMountedViews(prev => {
        const next = prev.filter(id => live.has(id))
        return next.length === prev.length ? prev : next
      })
      // 视图已回收：失败覆盖层状态与重试令牌随视图收敛（重加同名 id 由新
      // boot 重建）。
      setShellStates(prev => {
        const next = { ...prev }
        for (const id of removed) delete next[id]
        return next
      })
      setRetryTokens(prev => {
        const next = { ...prev }
        for (const id of removed) delete next[id]
        return next
      })
    }
    const currentActive = viewStore.getSnapshot().active
    if (currentActive !== LOCAL_INSTANCE_ID && !servers.some(candidate => candidate.id === currentActive)) {
      viewStore.select(LOCAL_INSTANCE_ID)
    }
    // 注册表删除的实例同时清掉其数据面残留（聚合/运行时事实/状态投影）——
    // 视图已回收，键空间应随注册表收敛（重加同名 id 由刷新重建）。
    // 全部走 source-registry.ts 内核（live 外删除 + identity-preserving）。
    setAggregates(prev => pruneSourceRecord(prev, live) ?? prev)
    factsStore.setRuntime(prev => pruneSourceRecord(prev, live) ?? prev)
    // 每来源账本一次收敛（字段表在 host/source-ledger.ts）；mounted 表由 store
    // 自洁，其 dropped ids 承接 snapshotAt 的 lockstep：same-id 重加必须从
    // 「从未推送」开始（首启窗口回退），不得继承被删来源的最后推送时刻。
    for (const id of mountedSources.prune(live)) delete snapshotAtRef.current[id]
    pruneSourceLedger(sourceLedger, live)
    setUnverified(prev => pruneSourceList(prev, live) ?? prev)
    // 用户忽略（dismiss）也随来源退役：否则 same-id 再挂载的**新**代际会在下一个
    // liveness tick 之前被旧忽略静默压住。
    setDismissedStalls(prev => pruneSourceList(prev, live) ?? prev)
    setPluginDiagnostics(prev => pruneSourceRecord(prev, live) ?? prev)
    completedStore.prune(live)
    // complete 通知两轨（水位 + 武装）与注册表同拍收敛（一次调用覆盖两张表）。
    completeLedgerRef.current.prune(live)
    // facts wiring 数据面：退役来源的读水位 / 回退账本 / 通知水位 /
    // 播种集 / 提示记账 / 在途计数与 facts state 一并清（same-id 重加 = 新来源代，
    // 不得继承上一代的已读/已通知判定）。
    if (pruneSourceRecord(factsStore.getSnapshot().session, live) !== null) {
      factsStore.setSession(prev => pruneSourceRecord(prev, live) ?? prev)
    }
    remotesStore.setStatus(prev => {
      // remoteStatus 按原始注册表 id 键控（deriveServers 的 statusKey），
      // 与 servers 的 <kind>-<id> 不同——按 kind 前缀还原再比较。
      const liveRaw = new Set<string>()
      for (const server of servers) {
        const rawId = server.kind === 'local' ? 'local' : rawInstanceIdFromSourceId(server.id)
        if (rawId !== null) liveRaw.add(rawId)
      }
      return pruneSourceRecord(prev, liveRaw) ?? prev
    })
  }, [servers, mountedViews])

  const refreshConnections = useCallback(async () => {
    try {
      setConnections(await api.connections.list())
    } catch {
      // 控制面不可达由 /health 轮询的 healthError 呈现；连接行保持现状
    }
  }, [])

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.host.health())
      setHealthError(null)
      setHealthErrorAt(null)
    } catch (err) {
      setHealthError(errorMessage(err))
      setHealthErrorAt(prev => prev ?? Date.now())
    }
  }, [])

  const refreshRemoteStatus = useCallback(async (id: string, expectedSourceId?: string) => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const sourceId = expectedSourceId ?? sourceIdForRawInstance(id, remotesStore.getSnapshot().instances)
    if (sourceId === null) return
    const sourceOwner = sourceLifecyclesRef.current!.capture(sourceId)
    if (sourceOwner === null) return
    try {
      const projection = await ssh.status(id)
      if (
        projection !== null
        && sourceIdForTransport(projection.kind, id) === sourceId
        && liveServerIdsRef.current.has(sourceId)
        && sourceLifecyclesRef.current!.owns(sourceOwner)
      ) {
        remotesStore.setStatus(prev => ({ ...prev, [id]: projection }))
      }
    } catch {
      // 状态读取失败时保持已有投影（权威状态来自 onStatusChanged 推送）
    }
  }, [])

  /** Invalidate the roster synchronously before an instances-changed refresh:
   * the gate opens a NEW generation, so an event-side push can never observe
   * the previous generation as settled (the store read is synchronous). */
  const invalidateRemoteRoster = useCallback(() => {
    remoteRosterRefreshSeqRef.current += 1
    rosterGate.invalidate()
  }, [rosterGate])

  /** Synchronously retire every renderer owner of an authoritative lifecycle
   * edge (deletion or transport-identity edit). This is event-side on purpose:
   * passive effects can be skipped when React batches a same-id replacement. */
  const retireSources = useCallback((sourceIds: ReadonlySet<string>): void => {
    const retired = new Set([...sourceIds].filter(sourceId => sourceId !== LOCAL_INSTANCE_ID))
    if (retired.size === 0) return
    sourceLifecyclesRef.current!.retire(retired)
    // P4: a retired source's generation leaves the registry with it, so a same-id
    // re-add starts from a clean epoch instead of inheriting the retired life.
    const liveSourceIds = new Set(
      Object.keys(sourceLedgerStoreRef.current).filter((sourceId) => !retired.has(sourceId)),
    )
    sourceLedgerStoreRef.current = retainSourceIds(sourceLedgerStoreRef.current, liveSourceIds)
    aggregateRequestOwnersRef.current!.retire(retired)
    for (const sourceId of retired) {
      delete aggregatePollSeqRef.current[sourceId]
      delete mutationRefreshSeqRef.current[sourceId]
      // Last-reconnect recency retires with the source (same-id re-add
      // starts a fresh backoff window; the state-backed aggregate maps are
      // covered by the pure invalidation below, this keyed ref retires here).
      delete lastReconnectAtRef.current[sourceId]
    }

    // Force the supplied authoritative delta through the aggregate generation
    // transition even when a newer roster snapshot already contains the same
    // id. That is the exact two-pull remove/re-add race the delta closes.
    const previousLive = new Set(liveServerIdsRef.current)
    const nextLive = new Set(liveServerIdsRef.current)
    for (const sourceId of retired) {
      previousLive.add(sourceId)
      nextLive.delete(sourceId)
    }
    const aggregateInvalidation = invalidateRemovedAggregateSources(
      previousLive,
      nextLive,
      {
        failuresBySource: aggregateFailuresRef.current,
        snapshotAtBySource: snapshotAtRef.current,
        readySources: readyAggregateSourcesRef.current,
      },
    )
    aggregateFailuresRef.current = aggregateInvalidation.failuresBySource
    snapshotAtRef.current = aggregateInvalidation.snapshotAtBySource
    mountedSources.retire(aggregateInvalidation.removedSourceIds)
    readyAggregateSourcesRef.current = aggregateInvalidation.readySources
    // Event authority is immediate: delayed view/deep-link callbacks must see
    // the source absent before the replacement instances_get resolves.
    liveServerIdsRef.current = nextLive

    // Record shell.ts's async teardown barrier before any replacement mount.
    // Identity edits deliberately reach this path even though the registry id
    // remains present; label/service/home-only edits do not retire the shell.
    for (const sourceId of retired) {
      clearAggregateRetry(sourceId)
      aggregateRefreshQueueRef.current.delete([sourceId])
      autoPrewarmedRef.current.delete(sourceId)
      // 保留策略：注册表删除的源不占用"回收后不自动预热"键（与其它
      // ref 键空间同纪律随生命周期收敛）。
      prewarmSuppressedRef.current.delete(sourceId)
      // 收割账本/意图随来源生命周期收敛（同 id 重新注册 = 新来源代）。
      delete harvestStateRef.current[sourceId]
      harvestIntentRef.current.delete(sourceId)
      chamberBridge.retireInstanceProducers(sourceId)
      disposeInstanceShell(sourceId)
      releaseInstanceClient(sourceId)
      chamberBridge.clearPluginDiagnostic(sourceId)
      delete prevRunningRef.current[sourceId]
      delete prevRuntimeFactsRef.current[sourceId]
      completeLedgerRef.current.forget(sourceId)
      // facts wiring：事实源实例与全部未读数据面键随退役同拍收敛（reclaimView
      // 刻意不碰这些——拆壳不等于来源消失）。
      sessionFactsTeardownRef.current.get(sourceId)?.()
      sessionFactsTeardownRef.current.delete(sourceId)
      sessionFactsSourcesRef.current.delete(sourceId)
      // 无壳观察者与身份记录同样随退役收敛（只拆 gateway 事实源会留下孤观察者）。
      sourceMuxTeardownRef.current.get(sourceId)?.()
      sourceMuxTeardownRef.current.delete(sourceId)
      sourceMuxIdentityRef.current.delete(sourceId)
      delete readMarksRef.current[sourceId]
      completedStore.dropSource(sourceId)
      delete refreshHintAtRef.current[sourceId]
      delete factsPullInFlightRef.current[sourceId]
      factsSeededRef.current.delete(sourceId)
    }
    // 工作区创建回声账本随来源生命周期收敛（同纪律：同 id 重新注册 = 新来源代，
    // 上一代的回声不得在新代里残留成幽灵工作区行）。
    updateWorkspaceEcho(forgetPendingWorkspaces(echoStore.getSnapshot().workspace, retired))
    // 会话创建回声同纪律：上一代记账的会话不得在新来源代的列表里幽灵复现。
    updateSessionEcho(forgetPendingSessions(echoStore.getSnapshot().session, retired))
    // 归档墓碑同纪律：新一代来源必须是干净的（旧代的本地归档不得藏住新代的会话）。
    updateSessionArchive(forgetPendingArchives(echoStore.getSnapshot().archive, retired))
    // 打开意图同纪律：被删除来源的在途意图必须撤掉，否则新一代会在投影门/揭示门
    // 上被上一代的 open 永久压住（那是两个"永远不释放"的闸门）。
    clearOpenIntents(retired)
    const pendingDeepLink = pendingDeepLinkDeliveryRef.current
    if (
      pendingDeepLink !== null
      && pendingDeepLink.sourceId !== null
      && retired.has(pendingDeepLink.sourceId)
    ) {
      pendingDeepLinkDeliveryRef.current = null
      void acknowledgeDeepLink(pendingDeepLink).catch(error => {
        reportDeepLinkAckFailure(pendingDeepLink, error)
      })
    }
    const retainedNotificationOpens: NotificationOpenDelivery[] = []
    for (const open of pendingRosterNotificationOpensRef.current) {
      if (!retired.has(open.sourceId)) {
        retainedNotificationOpens.push(open)
        continue
      }
      void acknowledgeNotificationOpen(open).catch(error => {
        reportNotificationAckFailure(open, error)
      })
    }
    pendingRosterNotificationOpensRef.current = retainedNotificationOpens
    pendingViewRef.current = retireSelectedSource(pendingViewRef.current, retired, null)
    // 屏上视图随注册表退役**同帧**回落 local（第一道；揭示门的 unmountable
    // 分支是第二道保险）。回落 local 而不是 selected：选择可能是同一来源、也可能
    // 尚未 settle——直接画上去会露出 pending（不可见）壳，即一帧无可见视图。
    prewarmQueueRef.current = withoutRemovedSourceIds(prewarmQueueRef.current, retired)
    prewarmEligibleRef.current = new Set(
      [...prewarmEligibleRef.current].filter(sourceId => !retired.has(sourceId)),
    )
    if (prewarmInflightRef.current !== null && retired.has(prewarmInflightRef.current)) {
      // 在途预热随来源退役作废（还没被任何人用上）。
      recordPrewarm('cancelled', prewarmInflightRef.current)
      prewarmInflightRef.current = null
    }

    // Queue every React owner deletion before any roster render. A replacement
    // id only returns through a fresh view mount/producer generation.
    setMountedViews(prev => withoutRemovedSourceIds(prev, retired))
    viewStore.retire(retired, LOCAL_INSTANCE_ID)
    setShellStates(prev => withoutRemovedSourceKeys(prev, retired))
    setRetryTokens(prev => withoutRemovedSourceKeys(prev, retired))
    setAggregates(prev => withoutRemovedSourceKeys(prev, retired))
    mountedSources.retire(retired)
    factsStore.setRuntime(prev => withoutRemovedSourceKeys(prev, retired))
    setPluginDiagnostics(prev => withoutRemovedSourceKeys(prev, retired))
    // 托管 dsh 状态同源收敛：轮询 effect 的 roster 差分
    // 是异步的，同 id 重新注册在那一拍之前会读到上一代的 stopped/error。
    retireManagedRuntime(retired)
    completedStore.retire(retired)
    const removedRawIds = new Set([...retired]
      .map(rawInstanceIdFromSourceId)
      .filter((rawId): rawId is string => rawId !== null))
    for (const rawId of removedRawIds) knownRemoteIdsRef.current.delete(rawId)
    remotesStore.setStatus(prev => withoutRemovedSourceKeys(prev, removedRawIds))
  }, [
    acknowledgeDeepLink,
    acknowledgeNotificationOpen,
    clearAggregateRetry,
    reportDeepLinkAckFailure,
    reportNotificationAckFailure,
  ])

  const refreshRemotes = useCallback(async (): Promise<boolean> => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return false
    const seq = remoteRosterRefreshSeqRef.current + 1
    remoteRosterRefreshSeqRef.current = seq
    try {
      const instances = await ssh.instances_get()
      if (remoteRosterRefreshSeqRef.current !== seq) return false
      const acceptedInstances = instances.flatMap((instance) => {
        const sourceId = sourceIdForInstance(instance)
        const fingerprint = parseAuthoritativeSourceFingerprint(sourceId, instance.sourceFingerprint)
        if (fingerprint === null) {
          console.error(`[renderer] remote source ${sourceId} omitted: invalid authoritative lifecycle proof`)
          return []
        }
        return [{ instance, sourceId, fingerprint }]
      })
      const nextSources = [
        { sourceId: LOCAL_INSTANCE_ID, fingerprint: 'local' },
        ...acceptedInstances.map(({ sourceId, fingerprint }) => ({ sourceId, fingerprint })),
      ]
      const nextLiveServerIds = new Set(nextSources.map(source => source.sourceId))
      const retired = authoritativeSourceRetirements(
        liveServerIdsRef.current,
        sourceLifecyclesRef.current!,
        nextSources,
      )
      retireSources(retired)
      sourceLifecyclesRef.current!.activate(LOCAL_INSTANCE_ID, 'local')
      // P4: the authoritative roster is the one place a fingerprint change is
      // observed; registering it here is what turns a re-registration into an epoch
      // bump. Events never recompute the fingerprint.
      sourceLedgerStoreRef.current = reincarnate(
        sourceLedgerStoreRef.current,
        { sourceId: LOCAL_INSTANCE_ID, fingerprint: 'local' },
      )
      for (const { sourceId, fingerprint } of acceptedInstances) {
        sourceLifecyclesRef.current!.activate(sourceId, fingerprint)
        sourceLedgerStoreRef.current = reincarnate(sourceLedgerStoreRef.current, { sourceId, fingerprint })
      }
      liveServerIdsRef.current = nextLiveServerIds
      const acceptedSpecs = acceptedInstances.map(({ instance }) => instance)
      remotesStore.setInstances(acceptedSpecs)
      rosterGate.settle()
      for (const { instance, sourceId } of acceptedInstances) {
        void refreshRemoteStatus(instance.id, sourceId)
      }
      return true
    } catch {
      // 桌面 SSH 面不可达时保持现状；首次权威结果前 settled 仍为 false，
      // deep-link intent 继续 held，并由快速重试/30s 稳态轮询再次拉取。
      return false
    }
  }, [refreshRemoteStatus, retireSources])

  /**
   * 聚合刷新簇（unary 快照拉取 / 有界刷新波 / 边沿轮询 / 陈旧 watchdog + 会话
   * 权威升级 ladder）是命名 hook（use-aggregate-refresh.ts）；App 只保留
   * aggregatePollRunningRef（有界波的串行闸，也是既有接线锁的切片锚点）并注入
   * 全部状态容器与常量，取回 11 个调用面继续接线。
   */
  const aggregatePollRunningRef = useRef(false)
  const {
    refreshAggregate, refreshAggregateRef, pollAggregatesRef, runStalenessWatchdogRef,
    stalledSources, dismissedStalls, setDismissedStalls, unverifiedSources, setUnverified,
    unverifiedSourcesRef, watchdogAggregatesRef,
  } = useAggregateRefresh({
    aggregates, health, remoteInstances, remoteStatus, snapshotSources,
    escalationLadder: SESSION_AUTHORITY_ESCALATION_LADDER,
    reconnectBackoffMs: AGGREGATE_RECONNECT_BACKOFF_MS,
    setAggregates, setHostFacts, factsStore,
    clearAggregateRetry, refreshHealth, sweepSessionArchive, sweepSessionEcho,
    sweepWorkspaceEcho, updateSessionArchive, updateSessionEcho,
    aggregateFailuresRef, aggregatePollRunningRef, aggregatePollSeqRef,
    aggregateRefreshQueueRef, aggregateRequestOwnersRef, aggregateRetryTimersRef,
    authoritativeArchiveSetRef, factsAtRef, factsPullInFlightRef,
    lastReconnectAtRef, mutationRefreshSeqRef, readyAggregateSourcesRef,
    echoStore, snapshotAtRef, mountedSources,
    sourceLifecyclesRef,
  })
  // 前台恢复补偿：hidden → visible 立即推进一轮聚合
  // watchdog（隐藏期暂停的 30s 兜底/stale 拉取在此收敛，含已回收源）、
  // 空闲预热队列与保留回收检查，以及两条 30s 兜底轮询（连接行/注册表，
  // 五个目标都是 ref 镜像的最新闭包。
  const refreshConnectionsRef = useRef(refreshConnections)
  const refreshRemotesRef = useRef(refreshRemotes)
  useEffect(() => {
    refreshConnectionsRef.current = refreshConnections
    refreshRemotesRef.current = refreshRemotes
  })
  useEffect(() => {
    let compensationTimer: number | undefined
    let disposed = false
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      runStalenessWatchdogRef.current()
      void refreshConnectionsRef.current()
      void refreshRemotesRef.current()
      // 托管 dsh 状态**先刷新完再** drain：隐藏期探针被跳过，若并行 drain 会
      // 读到期前的 managedRuntime 投影，把一个已停机的 gateway 源拿去收割/预热
      // （白烧一次尝试）。
      // 探针 promise 在微任务里 resolve，而 React 要到下一个宏任务才提交
      // setManagedRuntime——直接 drain 会读到探针前的投影。延后一个宏任务，
      // 让补偿真正看到新事实；定时器随卸载清理，
      // 探针 reject 也不能让补偿整条腿消失。
      probeManagedRuntimeRef.current().then(() => {
        if (disposed) return
        compensationTimer = window.setTimeout(() => {
          compensationTimer = undefined
          if (document.visibilityState !== 'visible') return
          drainPrewarmRef.current()
          reclaimHiddenViewsRef.current()
        }, 0)
      }).catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      if (compensationTimer !== undefined) window.clearTimeout(compensationTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => () => {
    for (const timer of aggregateRetryTimersRef.current.values()) clearTimeout(timer)
    aggregateRetryTimersRef.current.clear()
  }, [])

  // perf 埋点（User Timing；标记注册表见 perf-marks.ts）：页面壳挂载与
  // 本地实例 ready 首达。settle/boot-failed 由 shell.ts 在 settle 返回点
  // 统一打点，本组件不重复。
  const appMountMarkedRef = useRef(false)
  useEffect(() => {
    if (appMountMarkedRef.current) return
    appMountMarkedRef.current = true
    perfMark(PERF_MARKS.appMount)
  }, [])
  const firstLocalReadyMarkedRef = useRef(false)
  useEffect(() => {
    if (health?.dsh?.status !== 'ready' || firstLocalReadyMarkedRef.current) return
    firstLocalReadyMarkedRef.current = true
    perfMark(PERF_MARKS.appLocalReady)
  }, [health])

  useEffect(() => {
    let cancelled = false

    void refreshHealth()
    void refreshConnections()
    pollAggregatesRef.current()

    // Local status push channel (设计 05): the control plane streams every
    // machine transition — starting → ready 即时翻转，没有周期性健康轮询。
    // EventSource 自带重连，重连后先收到当前快照；流建立失败时做一次性
    // /health 兜底（承载 controlUnreachable 判定与首帧收敛）。
    const healthEvents = api.host.healthEvents()
    healthEvents.onmessage = (event) => {
      if (cancelled) return
      try {
        const payload = JSON.parse(event.data) as HealthResponse
        if (payload?.ok === true && payload?.dsh !== undefined) {
          setHealth(payload)
          setHealthError(null)
          setHealthErrorAt(null)
        }
      } catch {
        // 畸形帧忽略——流的下一帧快照会覆盖
      }
    }
    healthEvents.onerror = () => {
      if (cancelled) return
      void refreshHealth()
    }

    // 连接行低频刷新（label/dshPort 极少变化；行状态在启动判定后不再敏感）。
    // 隐藏期跳过：恢复可见时由上方 visibility effect 立即补偿一轮。
    const connectionsTimer = setInterval(() => {
      if (cancelled) return
      if (!shouldRunBackgroundPhase(document.visibilityState)) return
      void refreshConnections()
    }, CONNECTIONS_POLL_MS)

    // 注册表低频轮询（与连接行同节奏）：兜底桌面侧任何来源的注册表变化
    // （主进程 save/delete 的 instances_changed 推送之外；隧道状态本身走 onStatusChanged
    // 推送，不依赖此轮询）。隐藏期跳过与恢复补偿同连接行轮询。
    const remotesTimer = setInterval(() => {
      if (cancelled) return
      if (!rosterGate.isListenerReady()) return
      if (!shouldRunBackgroundPhase(document.visibilityState)) return
      void refreshRemotes()
    }, CONNECTIONS_POLL_MS)

    window.addEventListener('beforeunload', disposeAllShells)

    return () => {
      cancelled = true
      clearInterval(connectionsTimer)
      clearInterval(remotesTimer)
      healthEvents.close()
      window.removeEventListener('beforeunload', disposeAllShells)
    }
  }, [refreshHealth, refreshConnections, refreshRemotes])

  /**
   * 桌面桥订阅（design 05）：preload 经异步 dsh-chamber:info 往返后才暴露
   * window.dshChamber——桥可能在挂载 effect 之后才出现，一次性订阅会静默
   * 丢失状态/注册表推送（退化为 30s 轮询自愈）。机制：500ms 探测直到桥出现，
   * 出现即装载 roster 并订阅 onStatusChanged / onInstancesChanged（设置页
   * 同款 bridgeUp 守卫）。卸载时退订。
   */
  const [sshBridgeReady, setSshBridgeReady] = useState(false)
  useEffect(() => {
    if (sshBridgeReady) return
    const timer = setInterval(() => {
      if (window.dshChamber?.desktopSsh !== undefined) {
        clearInterval(timer)
        setSshBridgeReady(true)
      }
    }, 500)
    return () => { clearInterval(timer) }
  }, [sshBridgeReady])

  /** First authoritative roster acquisition: retry transient IPC failures on
   * a short bounded cadence. Exhaustion keeps the one pending activation held;
   * the existing 30s registry poll remains the long-tail recovery path. */
  useEffect(() => {
    if (
      !sshBridgeReady
      || !rosterGate.isListenerReady()
      || rosterGate.isSettled()
    ) return
    let cancelled = false
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const attempt = (): void => {
      attempts += 1
      void refreshRemotes().then((settled) => {
        if (cancelled || settled) return
        if (attempts >= REMOTE_ROSTER_RETRY_LIMIT) {
          console.error('[renderer] remote instances roster unavailable; pending deep-link activation remains held')
          return
        }
        retryTimer = setTimeout(attempt, REMOTE_ROSTER_RETRY_MS)
      })
    }
    attempt()
    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
  }, [sshBridgeReady, roster, refreshRemotes])

  useEffect(() => {
    if (!sshBridgeReady) return
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const unsubscribe = ssh.onStatusChanged((payload) => {
      // A removed transport may emit one final phase while main tears it down.
      // The delta already retired this incarnation; refreshRemoteStatus after
      // a real re-add supplies the replacement's first accepted projection.
      const sourceId = sourceIdForRawInstance(payload.id, remotesStore.getSnapshot().instances)
      if (sourceId === null
        || sourceIdForTransport(payload.status.kind, payload.id) !== sourceId
        || !liveServerIdsRef.current.has(sourceId)) return
      remotesStore.setStatus(prev => ({ ...prev, [payload.id]: payload.status }))
    })
    // 注册表变更推送：设置页增/删/改实例即时重拉 roster（自动连接新 id、
    // 回收已删视图），不等 30s 轮询周期。
    const refreshAuthoritativeRoster = (): void => {
      invalidateRemoteRoster()
      void refreshRemotes()
    }
    // Listener-before-snapshot closes the bridge-hydration lost-update window:
    // a registry mutation cannot land between a successful initial
    // instances_get and onInstancesChanged subscription while the old roster
    // remains marked authoritative.
    const unsubscribeInstances = subscribeRosterBeforeRefresh(
      listener => ssh.onInstancesChanged(({ retiredIds }) => {
        // The trusted desktop delta is the only observation that survives two
        // overlapping pulls both seeing the final same-id re-add. Retirement
        // must happen before invalidating/refreshing the roster generation.
        retireSources(remoteRetiredSourceIds(retiredIds))
        listener()
      }),
      refreshAuthoritativeRoster,
    )
    rosterGate.setListenerReady(true)
    // OS 唤醒分发（design 14 D4）：主进程 push system-resume → 本页面所有
    // dsh 前端连接（N-ctx 单页共享 window）立即重连——dsh-client-connection
    // 的 chamber 补丁监听该 window 事件。事件名以该包的共享常量
    // `SYSTEM_RESUME_EVENT`（client/index.ts，值为 'dsh-chamber:system-resume'）
    // 为唯一权威，本处字面量必须与之保持一致（renderer tsconfig 无法解析该
    // 包的深路径导出，故用字面量 + 此注释锁定同步）。桥与 desktopSsh 同一批
    // expose，desktopSsh 存在则 systemResume 必存在。
    const unsubscribeResume = window.dshChamber?.systemResume?.onResume(() => {
      window.dispatchEvent(new Event('dsh-chamber:system-resume'))
    })
    // 通知点击打开（design 19）：主进程推送 notification-open →
    // openSession（既有路径：切 shell → ensureRemoteConnected →
    // openInstanceSession）。桥与 desktopSsh 同一批 expose，desktopSsh 存在
    // 则 notifications 必存在（与上方 SYSTEM_RESUME_EVENT 同款锁定纪律）。
    // 监听注册后立即发就绪信号：主进程只在就绪后放行推送（did-finish-load
    // 早于本监听注册，窗口重建路径的事件不能丢）。
    const notifications = window.dshChamber?.notifications
    const unsubscribeNotifications = notifications?.onOpen((open) => {
      const { sourceId } = open
      const classification = classifyRosterGatedSource(
        sourceId,
        rosterGate.isSettled(),
        liveServerIdsRef.current,
      )
      // A successful roster pull updates the imperative authority ref before
      // React commits the replay effect. Keep a later remote click behind any
      // already-held payloads during that small window; local remains immediate
      // per the roster-gate contract.
      if (
        classification === 'hold'
        || (sourceId !== LOCAL_INSTANCE_ID && pendingRosterNotificationOpensRef.current.length > 0)
      ) {
        const queued = enqueueBoundedRosterIntent(
          pendingRosterNotificationOpensRef.current,
          open,
          MAX_PENDING_ROSTER_NOTIFICATION_OPENS,
        )
        pendingRosterNotificationOpensRef.current = queued.pending
        if (queued.dropped !== null) {
          console.warn(`[notifications] roster pending queue full; dropped oldest open (${queued.dropped.sourceId}/${queued.dropped.sessionId})`)
          void acknowledgeNotificationOpen(queued.dropped).catch(error => {
            reportNotificationAckFailure(queued.dropped!, error)
          })
        }
        return
      }
      if (classification === 'missing') {
        console.warn(`[notifications] ignored source absent from the authoritative roster: ${sourceId}`)
        void acknowledgeNotificationOpen(open).catch(error => {
          reportNotificationAckFailure(open, error)
        })
        return
      }
      void enqueueNotificationOpen(open, 'live')
    })
    // Listener-before-ready mirrors the deep-link contract. A transient
    // sender-fence/navigation race must not leave main's click queue held for
    // the lifetime of the renderer, so retry on a small bounded budget and
    // make final exhaustion loud.
    let notificationReadyCancelled = false
    let notificationReadyAttempts = 0
    let notificationReadyRetryTimer: ReturnType<typeof setTimeout> | null = null
    const signalNotificationReady = (): void => {
      if (notifications?.ready === undefined) return
      notificationReadyAttempts += 1
      void Promise.resolve()
        .then(() => notifications.ready())
        .then((ready) => {
          if (ready !== true) throw new Error('notifications ready returned false')
        })
        .catch((error: unknown) => {
          if (notificationReadyCancelled) return
          if (notificationReadyAttempts >= LISTENER_READY_RETRY_LIMIT) {
            console.error('[notifications] readiness handshake exhausted its retry budget:', error)
            return
          }
          notificationReadyRetryTimer = setTimeout(signalNotificationReady, LISTENER_READY_RETRY_MS)
        })
    }
    if (unsubscribeNotifications !== undefined) {
      signalNotificationReady()
    }
    return () => {
      rosterGate.setListenerReady(false)
      notificationReadyCancelled = true
      if (notificationReadyRetryTimer !== null) clearTimeout(notificationReadyRetryTimer)
      unsubscribe()
      unsubscribeInstances()
      unsubscribeResume?.()
      unsubscribeNotifications?.()
    }
    // openSession 依赖链稳定到 []（selectView/ensureRemoteConnected 均
    // useCallback([])），enqueueNotificationOpen 仅包装该稳定引用与页面级
    // serial tail；effect 单次订阅捕获的闭包永不过期。两者都声明在其后，
    // 不能列入此处立即求值的 deps（会触发 TDZ）。
  }, [
    sshBridgeReady,
    acknowledgeNotificationOpen,
    invalidateRemoteRoster,
    refreshRemotes,
    reportNotificationAckFailure,
  ])

  /**
   * 本地实例幂等启动（design 05）：首轮连接行装载后（null = 尚未拉到）行缺失/
   * stopped/error 均触发一次 POST /api/connections（幂等，重复 200 返回既有
   * 状态）。一旦 ready 即不再 POST（后续状态由 /health 呈现）。POST 失败
   * **不置位**——下一个连接行轮询周期（30s）重试，直到成功或出现 ready 行
   * （控制面不可达时应用本就显示致命屏，恢复后本地实例不会被静默放弃）。
   * 远程实例的自动连接独立于本地启动（见下个 effect），互不阻塞。
   */
  const localBootedRef = useRef(false)
  useEffect(() => {
    if (connections === null) return
    if (localBootedRef.current) return
    const local = connections.find(c => c.connectionId === LOCAL_INSTANCE_ID && c.kind === 'local')
    if (local !== undefined && local.status === 'ready') {
      localBootedRef.current = true
      return
    }
    void api.connections.createLocal().then(() => {
      localBootedRef.current = true
    }).catch(err => {
      console.error('[renderer] auto-start local failed (will retry on the next connections poll):', err)
    })
  }, [connections])

  /**
   * 注册表远程实例自动连接（design 05）：只对**本渲染会话首次见到的**实例 id
   * connect——应用启动装载 / 设置页新增都在下一个注册表轮询周期内生效，
   * 不依赖本地实例。绝不重复 connect 已见过的 id：否则该轮询会把用户手动
   * 断开的实例重新拉起（30s 后）——「仅新 id」守住手动断开语义。error/
   * degraded 的**自动恢复**不在这里（那是 transport-manager 的慢速重探 +
   * 下方 ensureRemoteConnected 的用户点击即时重连——两者都尊重手动断开：
   * 慢速重探被 disconnect 取消，点击重连只对 error/degraded 生效、不触碰
   * idle）。id 随注册表删除移出，重新添加即再次自动连接。
   */
  const knownRemoteIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const known = knownRemoteIdsRef.current
    for (const instance of remoteInstances) {
      if (known.has(instance.id)) continue
      known.add(instance.id)
      // connect 对未知 id 会经 IPC 拒绝（注册表在 get 与 connect 之间被删）：
      // 显式吞掉并记录，绝不产生未处理的 rejection。
      void ssh.connect(instance.id).catch(err => {
        console.error(`[renderer] auto-connect ${instance.id} failed:`, err)
      })
    }
    for (const id of [...known]) {
      if (!remoteInstances.some(instance => instance.id === id)) known.delete(id)
    }
  }, [remoteInstances])

  /**
   * 用户意图即时重连：点击/打开一个远程来源 = 「现在就想要这个
   * server」。侧边栏点击来源头只做视图切换（requestActivateSource →
   * selectView），从不触发隧道 connect——error（快速重试耗尽，transport-
   * manager 已进入慢速周期重探）与 degraded（重试在途）的来源需要点击即
   * 立刻再试一次，不等慢速重探周期（该周期是自动兜底，这里是即时加速 +
   * 用户能动性）。idle（手动断开）绝不触碰——保持手动断开语义，设置页
   * Connect 是显式恢复路径；requiresUserAction 终态同样放行（用户显式意图
   * 与设置页 Connect 同语义，connect() 会重置该标志）。connect 对
   * connecting/ready 幂等，故重复点击无副作用。
   */
  const ensureRemoteConnected = useCallback((viewId: string) => {
    if (viewId === LOCAL_INSTANCE_ID) return
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const rawId = rawInstanceIdFromSourceId(viewId)
    if (rawId === null) return
    const phase = remotesStore.getSnapshot().status[rawId]?.phase
    if (phase !== 'error' && phase !== 'degraded') return
    void ssh.connect(rawId).catch(err => {
      console.error(`[renderer] click-to-reconnect ${rawId} failed:`, err)
    })
  }, [])

  /**
   * 用户意图即时再验证（ready-state heartbeat 的即时加速）：点击/打开一个
   * 远程来源 = 「现在就想要这个 server」。与 ensureRemoteConnected 互补——
   * 非 ready 的 error/degraded 来源走隧道重连（connecting 已在途、idle 手动
   * 断开不触碰）；**ready 但会话/远端已死**（远端改密吊销 gateway 会话、远端
   * 进程掉线等，transport 相位不变、心跳要等最多一个周期）由主进程 reverify
   * 立即探测一次：终端失败（401 重登被拒等）相位翻 error（红点 + 连接页错误
   * 指引），瞬态失败走有界重连。fire-and-forget：权威状态以相位推送为准；
   * reverify 对非 ready/静默窗内的调用是主进程侧 no-op，故重复点击无副作用。
   */
  const probeRemoteReady = useCallback((viewId: string) => {
    if (viewId === LOCAL_INSTANCE_ID) return
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined || ssh.reverify === undefined) return
    const rawId = rawInstanceIdFromSourceId(viewId)
    if (rawId === null) return
    void ssh.reverify(rawId).catch(() => {
      // 探测失败保持现状：权威状态仍由 onStatusChanged 推送/轮询兜底；
      // 但失败本身值得留痕（IPC/主进程侧异常，非实例状态）。
      console.warn(`[renderer] ready-state reverify ${rawId} failed`)
    })
  }, [])

  /**
   * 重试一个视图（design 05）：唯一入口，失败覆盖层与降级提示共用同一套
   * 三段式——重挂该视图 + error/degraded 隧道立即再试 + ready 但会话/远端已死
   * 的来源立即探测一次。自己写一套会漏掉最后那条探测臂（重试会因隧道故障或
   * 死会话原地失败）。令牌递增驱动 InstanceView 复位重 boot；来源非 ready 时
   * 前两段是 no-op，语义仍正确。
   */
  const retryView = useCallback((viewId: string) => {
    probeRemoteReady(viewId)
    ensureRemoteConnected(viewId)
    setRetryTokens(prev => ({ ...prev, [viewId]: (prev[viewId] ?? 0) + 1 }))
  }, [ensureRemoteConnected, probeRemoteReady])

  /** 视图切换（设计 05；延迟揭示）：**只改选择，不改可见性**。
   * 本函数提交 activeView + mountedViews；屏上仍是 paintedView 那个视图，直到
   * 揭示 effect 判定"目标首帧可用"才经既有 'view' 过渡键收敛（view-transition.ts
   * 不改）。为什么不在这里包 VT：VT 的语义是"新状态渲染就绪后动画才开始"
   * （view-transition.ts:6-11），冷 boot 的"新状态首帧"就是遮罩本身——VT 单独
   * 做不到"boot 期保持旧视图"。因此这里连过渡节都不需要：点击后屏上没有任何变化，
   * 也就不存在"旧视图输入栏 × 新遮罩"的混色窗口（cut 判据随之只在揭示节上）。
   * prefers-reduced-motion 仍由 view-transition.ts 的直通模式接管（揭示即时落地，
   * 持有窗不变——持有是内容决策，不是动效）。
   * 注册表守卫（design 05：视图生命周期 = 注册表条目生命周期）：来源已被删除
   * 时不挂载/不切换（点击时与提交时各查一次）。绝不把已回收的视图重新挂成僵尸：
   * 一次完整 boot 很贵，且回收 effect 的回滚会造成一闪而过的幽灵骨架屏。local 常驻。
   */
  const selectView = useCallback((viewId: string, onApply?: (applied: boolean) => void): boolean => {
    // 用户又选中这个视图 = 撤回"放弃"意图（否则它下一次离开会跳过保留宽限被
    // 立即回收）。切换来源的动作把标记写在**另一个** id 上，不会被这里误删。
    abandonedViewsRef.current.delete(viewId)
    // 用户点击 = 意图使用该来源：ready 但会话/远端已死的来源立即探测一次
    //（heartbeat 的即时加速；fire-and-forget，见 probeRemoteReady）。
    probeRemoteReady(viewId)
    // 用户点击 = 意图使用该来源：error/degraded 隧道立即再试（慢速重探的
    // 即时加速；idle 手动断开不触碰——见 ensureRemoteConnected）。
    ensureRemoteConnected(viewId)
    if (viewId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(viewId)) return false
    // 此刻它仍在自动预热集合里 ⇒ 这次用户选中就是一次**命中**（删除之前判定）。
    if (autoPrewarmedRef.current.has(viewId)) recordPrewarm('hit', viewId)
    autoPrewarmedRef.current.delete(viewId)
    // 用户主动点开 = 意图使用：解除"回收后不自动预热"抑制（此后闲置仍会被
    // 再次回收并再次抑制）。
    prewarmSuppressedRef.current.delete(viewId)
    // 收割中被点开 = 采用为用户视图：撤销收割意图（绝不回收用户正在看的壳），
    if (harvestIntentRef.current.delete(viewId)) {
      harvestStateRef.current[viewId] = harvestSatisfied(harvestStateRef.current[viewId])
    }
    // 查重（非闭包镜像）：同一次提交内重复登记直接跳过；已选中视图只在**没有
    // 在途揭示**时跳过。"在途"由 painted != selected 表达（揭示门持有旧视图
    // 的这 1s 内点击屏上那个视图 = 撤销：activeView 改回它，揭示门随即稳态），
    // pendingViewRef 只是这段同步提交里的意图槽（不跨越异步边界）。
    if (viewId === pendingViewRef.current) return true
    if (pendingViewRef.current === null && viewId === viewStore.getSnapshot().active) return true
    // Anchor the outgoing shell's sidebar
    // scroll BEFORE the switch; the incoming shell's stale scrollTop would
    // otherwise make the whole sidebar jump (each N-ctx shell owns its own
    // .chamberList scrollTop). restoreSidebarScroll runs inside the apply —
    // its PARK phase synchronously copies the raw scroll onto the incoming
    // container before the transition's new-state snapshot, so the incoming
    // sidebar never reveals at its own stale/zero position; the row-anchored
    // REFINE then corrects sub-row content deltas once the shell is visible
    // (booting / collapsed-to-rail shells are covered by the retry chain,
    // sidebar-scroll-sync.ts).
    const scrollAnchor = captureSidebarScrollAnchor(viewStore.getSnapshot().active)
    pendingViewRef.current = viewId
    // perf 仪器：switchFrameMs = view-request → view-reveal 两条 mark 之差
    // （scripts/perf/switch-frame-probe.mjs 消费；纯观测，无业务语义）。
    perfMark(PERF_MARKS.appViewRequest, viewId)
    // 同步提交（不包 VT——头注）。提交与登记同拍（无异步间隙）：pendingViewRef
    // 只是本次同步提交的意图槽，rapid click 由下一次 selectView 覆盖。
    pendingViewRef.current = null
    viewStore.select(viewId)
    // 保留策略：被回收（不在 mountedViews）的 live 来源在此重新挂载——
    // 冷 boot + entry 重放（shell.ts 同 id 串行 barrier 保证与回收的异步
    // teardown 不交错）；本视图的 hiddenSince 由 painted 落地 effect 清除。
    setMountedViews(prev => (prev.includes(viewId) ? prev : [...prev, viewId]))
    if (scrollAnchor !== null) restoreSidebarScroll(viewId, scrollAnchor)
    onApply?.(true)
    return true
  }, [ensureRemoteConnected, probeRemoteReady])

  /**
   * 遮罩「切换来源」的放弃意图：记下意图后
   * 切换到目标来源，**等切换落地**再由下方 effect 回收被放弃的视图。
   * 为什么不就地回收：reclaimView 拒绝活动/待开视图（既有守卫），而 selectView
   * 的 apply 经 View Transition 单槽队列可能延迟——反过来"先拆再切"会在切换
   * 失败时留下没有内容的窗口。标记只由这个显式用户动作写入；目标不合法或
   * selectView 同步抛出时立即撤回，绝不让一个"没落地的放弃"污染后续回收
   * （否则该视图下一次离开会跳过保留宽限被立刻拆掉）。
   */
  const switchSourceFromVeil = useCallback((fromViewId: string, targetId: string) => {
    if (fromViewId === targetId) return
    if (targetId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(targetId)) return
    if (fromViewId !== LOCAL_INSTANCE_ID) abandonedViewsRef.current.set(fromViewId, targetId)
    // selectView 的"没落地"**不抛异常**（注册表竞态早退、apply 期目标被删除都只是
    // return），所以同步 try/catch 撤不掉标记：用一个"落地即回调"的返回值收口——
    // 只有切换真的被接受/落地，放弃标记才保留，否则撤回
    // （一次没落地的切换会让该视图下一次离开跳过 60s 保留宽限被立刻拆掉）。
    const revoke = (): void => { abandonedViewsRef.current.delete(fromViewId) }
    try {
      const accepted = selectView(targetId, applied => { if (!applied) revoke() })
      if (!accepted) revoke()
    } catch (error) {
      revoke()
      console.error(`[renderer] veil switch ${fromViewId} -> ${targetId} failed:`, error)
    }
  }, [selectView])

  /**
   * 遮罩「连接」：显式用户意图，与设置页 Connect 同语义。idle 的
   * 「手动断开不被自动触碰」纪律正是靠"只有显式动作才连接"守恒，因此这里不像
   * ensureRemoteConnected 那样按相位过滤。
   */
  const connectSourceFromVeil = useCallback((viewId: string) => {
    const ssh = window.dshChamber?.desktopSsh
    const rawId = rawInstanceIdFromSourceId(viewId)
    if (ssh === undefined || rawId === null) return
    void ssh.connect(rawId).catch(err => {
      console.error(`[renderer] veil connect ${rawId} failed:`, err)
    })
  }, [])

  /** Replay the one cold-start remote activation only after the first
   * authoritative instances_get result committed the same roster generation.
   * A missing target is an authoritative removal/nonexistence decision, so it
   * is dropped instead of bypassing selectView's zombie-view guard. */
  useEffect(() => {
    // The state schedules this passive effect; the imperative ref is the final
    // authority check. An instances-changed event can invalidate the roster
    // after commit but before this effect flushes, in which case the intent
    // must remain held for the replacement generation.
    if (!rosterGate.isSettled()) return
    const pending = pendingDeepLinkDeliveryRef.current
    if (pending === null) return
    const sourceId = pending.sourceId
      ?? sourceIdForRawInstance(pending.rawInstanceId, remotesStore.getSnapshot().instances)
    if (sourceId === null) {
      pendingDeepLinkDeliveryRef.current = null
      console.warn(`[renderer] deep-link raw source is absent from the authoritative roster: ${pending.rawInstanceId}`)
      void acknowledgeDeepLink(pending).catch(error => {
        reportDeepLinkAckFailure(pending, error)
      })
      return
    }
    const decision = settlePendingDeepLinkActivation(
      sourceId,
      liveServerIdsRef.current,
    )
    pendingDeepLinkDeliveryRef.current = null
    if (decision.discarded?.reason === 'missing') {
      console.warn(`[renderer] deep-link source is no longer in the authoritative roster: ${decision.discarded.sourceId}`)
    }
    if (decision.activateSourceId !== null) {
      if (deliveryMatchesCurrentSource(
        sourceLifecyclesRef.current!,
        sourceId,
        pending.sourceFingerprint,
      )) {
        selectView(decision.activateSourceId)
      } else {
        console.warn(`[renderer] ignored stale deep-link source proof: ${sourceId}`)
      }
    }
    void acknowledgeDeepLink(pending).catch(error => {
      reportDeepLinkAckFailure(pending, error)
    })
  }, [
    roster,
    liveServerIds,
    acknowledgeDeepLink,
    reportDeepLinkAckFailure,
  ])

  /** 服务器显示名（骨架屏文案；缺失回落 instanceId）。 */
  const serverLabels = useMemo(() => {
    const map: Record<string, string> = {}
    if (connections !== null) {
      for (const conn of connections) {
        if (conn.kind === 'local' && conn.label !== undefined && conn.label !== '') {
          map[LOCAL_INSTANCE_ID] = conn.label
        }
      }
    }
    // 空 label 不入表（与本地行同规）：InstanceView 的 `?? viewId` 回落
    // 只认 undefined——空串会渲染出无名的骨架标题。
    for (const instance of remoteInstances) {
      if (instance.label !== '') map[sourceIdForInstance(instance)] = instance.label
    }
    return map
  }, [connections, remoteInstances])

  // ── 事实源生命周期 / 派生账本 / 通知第二入口 ──
  // 通知 / 未读投影簇（写盘、未读派生、通知唯一组装点、facts 应用）是命名
  // hook（use-unread-notifications.ts）；App 只传入状态容器与 setter，取回
  // 调用面继续接线（pagehide flush 经 App 自己的 flushUnreadRef，ref 由 hook 写入）。
  const {
    schedulePersistUnread, recomputeSourceUnread, emitSessionNotification, applySessionFacts,
  } = useUnreadNotifications({
    aggregates, serverLabels, viewStore, factsStore, liveServerIdsRef,
    sessionFactsSourcesRef, sourceLifecyclesRef, prevRunningRef,
    readMarksRef, completeLedgerRef, factsSeededRef,
    unreadStorageRef, unreadSaveTimerRef, flushUnreadRef, clientInstallIdRef,
    completedStore,
  })

  // ── 事实源生命周期（facts source / SSE / watch） ──
  // servers 渲染期镜像、行刷新提示、gateway 事实源与 dsh 无壳观察者的
  // 创建/收敛/退订、focus 重算与 pagehide 落盘是命名 hook
  // （use-session-facts-lifecycle.ts）；App 只注入状态容器与投影回调。
  useSessionFactsLifecycle({
    servers, applySessionFacts, recomputeSourceUnread, flushUnreadRef,
    unverifiedSourcesRef, factsPullInFlightRef, refreshHintAtRef, refreshAggregateRef,
    factsStore, sessionFactsSourcesRef, sessionFactsTeardownRef,
    sourceMuxTeardownRef, sourceMuxIdentityRef,
  })


  /**
   * 空闲预热（设计 05）：ready 的注册表远程实例按序、一次一个地在后台
   * boot（settle 后推进下一个），使多数首次切换在点击时已就绪——骨架屏只
   * 在预热未覆盖时出现。boot 本身经 shell.ts 的全局串行队列，与用户触发的
   * boot 共享一条链（用户请求经同一链排队，最坏等一个在途 boot）；每个 entry
   * 的实例事实独立注入，不随队列超时后的重叠而串线。预热视图为 instance-pending 态（仅 visibility 隐藏、
   * 保留 layout——vendor 测量/IntersectionObserver 在 boot 期间正常）。
   */
  const localSettledRef = useRef(false)
  const prewarmQueueRef = useRef<string[]>([])
  const prewarmInflightRef = useRef<string | null>(null)
  // 每个挂载视图的挂载时刻：绝对放弃上限按**视图**判定，不能只看预热在途
  // （用户点开/深链挂载的壳同样可能挂死）。
  const viewBootStartedAtRef = useRef<Record<string, number>>({})

  /**
   * 意图预热的 App 侧账本。hover 意图的**唯一**作用是"该
   * 来源优先"：把 id 提前到既有队列头，让既有 pickPrewarmTarget 先看到它。它
   * 不新增槽位、不提高 MAX_PREWARMED_REMOTE_VIEWS、不放宽
   * prewarmEligible/prewarmSuppressed/收割预留中的任何一道门。
   * - intentPriorityRef：已被意图提前、尚未被 drainPrewarm 真正选中的来源。
   * - intentBudgetRef：只记"真的因意图起了一次 boot"（队列重排不计费）——
   *   每次 boot 可能新建一个远端 blank 会话，故每会话有上限与 60s 冷却
   *   （shared/prewarm-intent.ts 的纯策略）。
   */
  const intentPriorityRef = useRef<Set<string>>(new Set())
  const intentBudgetRef = useRef<IntentPrewarmBudget>(emptyIntentPrewarmBudget())

  /**
   * 渲染期镜像（与 commit 同步，微任务安全）：settle 微任务可能先于 effect
   * flush 到达（如注册表删除后的回收 effect 尚未运行），drain 时必须用它
   * 过滤已失效的队列项——绝不把已删除/已挂载的实例重新挂成僵尸视图。
   * 排除 mounted：用户已点开（或已被别处挂载）的视图不再占用预热槽位。
   */
  const prewarmEligibleRef = useRef<Set<string>>(new Set())
  // 视图调度簇（预热资格 / 收割保温 / 保留回收 / 后台相位）是命名 hook
  // （use-view-scheduler.ts）；依赖面类型化，App 取回 8 个调用面继续接线。
  const {
    prewarmEligible, drainPrewarm, reclaimView, reclaimHiddenViews,
    handleInstanceSettled, handleShellState, reclaimHiddenViewsRef, drainPrewarmRef,
  } = useViewScheduler({
    activeView, health, liveServerIds, managedRuntime,
    mountedViews, remoteInstances, remoteStatus, shellStates,
    setMountedViews, setRetryTokens, setShellStates, abandonedViewsRef,
    viewStore, autoPrewarmedRef, deferredBootRef, degradedRetriedRef,
    harvestCandidatesRef, harvestIntentRef, harvestStateRef, hiddenSinceRef,
    intentBudgetRef, intentPriorityRef, localSettledRef,
    pendingViewRef, prewarmEligibleRef, prewarmInflightRef,
    prewarmQueueRef, prewarmSuppressedRef, reclaimViewRef, settingsTargetRef,
    viewBootStartedAtRef, MAX_PREWARMED_REMOTE_VIEWS,
  })

  // 共享文档的主题投影归属（N-ctx 硬化，design 06）：文档级 color-scheme /
  // body 调色板属性是 DOCUMENT-global 的，而本形态把 N 个实例壳挂在同一份
  // 文档里——每个挂载中的视图都跑自己的 ui-layout theme presenter。App 是
  // 「谁在屏上」的唯一权威，把它发布到 page-wide chamberBridge；ui-layout
  // fork 的 document-theme 投影器据此只让活动视图写文档（详见
  // packages/dsh-chamber-client-ui-layout/src/client/document-theme.ts）。
  // useLayoutEffect：必须在切换视图的那一帧**绘制前**发布，否则主题不同的两个
  // 视图互切会先画一帧旧调色板。
  // 同一份「谁在屏上」的权威也是文档级 `<html lang>` 的归属来源（design 06
  // 「页面语言归属」）：每个实例壳的官方 locale 服务都无条件写这个属性且无 teardown，
  // page-language 归属器只让**屏上来源、且其宿主设置已回答**的语言落地——默认
  // 进入只有本地实例的设置能决定页面语言，后台/预热的壳一律被就地回写；尚未
  // 加载的来源在它报出自己的语言之前保持当前页面语言。
  useLayoutEffect(() => {
    chamberBridge.setActiveSource(activeView)
    setPageActiveSource(activeView)
  }, [activeView])

  /**
   * 揭示门（延迟揭示）：painted 收敛到 selected 的**唯一入口**。
   * 判定全在纯叶子 reveal-gate.ts（node 直测）；这里只提供事实并走既有 'view'
   * 过渡键：
   *  - shellStates：目标 settle（成功或失败）就是"首帧可用"的信号；
   *  - revealTick：持有窗到期的一次性重算（单调钟；照 InstanceView 的
   *    surfaceFallbackTick 形态）；
   *  - 回调内必须重验 `viewStore.getSnapshot().active === target`：揭示意图可能已过期
   *    （用户点了 B 又点回 A；或来源被退役）——过期揭示绝不能把已撤销的目标画回
   *    屏上（selectView 的 pendingViewRef 守卫
   *    是同一族纪律）。
   * flushSync 出场方式：runViewTransition 在直通模式（reduced-motion / 无
   * startViewTransition）会**同步** flushSync，而 React 不允许在 commit 相位内
   * flushSync（它自己给的处置就是"挪到 microtask"）；microtask 仍在下一帧绘制前
   * 执行，揭示时机与 layout effect 直调等价，且非直通模式下浏览器本来就在下一帧
   * 才回调 update。
   */
  useLayoutEffect(() => {
    const selected = activeView
    const nowMs = monotonicNow()
    revealHoldStartedAtRef.current = revealHoldStartedAt(revealHoldStartedAtRef.current, {
      inFlight: selected !== paintedView,
      nowMs,
    })
    const targetState = shellStates[selected]
    const verdict = shouldReveal({
      selectedViewId: selected,
      paintedViewId: paintedView,
      targetMountable: selected === LOCAL_INSTANCE_ID
        || (mountedViews.includes(selected) && liveServerIdsRef.current.has(selected)),
      targetSettled: isSettledShellState(targetState),
      targetFailed: (targetState?.error ?? null) !== null,
      holdStartedAtMs: revealHoldStartedAtRef.current,
      nowMs,
    })
    if (!verdict.reveal) {
      if (verdict.reason !== 'painted') return
      const handle = setTimeout(
        () => setRevealTick(tick => tick + 1),
        revealHoldRemainingMs(revealHoldStartedAtRef.current, nowMs),
      )
      return () => { clearTimeout(handle) }
    }
    queueMicrotask(() => {
      // 排队期间屏上目标可能已被改写/该壳已画上：揭示前重验（与回调内重验同纪律）。
      if (viewStore.getSnapshot().active !== selected) return
      const mountable = selected === LOCAL_INSTANCE_ID
        || (mountedViews.includes(selected) && liveServerIdsRef.current.has(selected))
      // 目标不可挂载（退役/被删的竞态）：绝不把死视图留在屏上——回落 local
      // （唯一恒挂载视图），与 activeView 的退役回落同一条语义。
      const target = mountable ? selected : LOCAL_INSTANCE_ID
      if (viewStore.getSnapshot().painted === target) return
      // 目标落地后是否显示遮罩的 DOM 事实（判据不变）：在场 ⇒ 'cut'（旧视图
      // 快照不与新遮罩交叉混色），否则 'crossfade'。判不出来（无 CSS.escape /
      // 选择器抛错）就地保守取 'cut'。
      const paint = (): PaintIntent => {
        try {
          const el = document.querySelector(`.instance-view[data-instance="${CSS.escape(target)}"]`)
          return el !== null && el.querySelector('.instance-loading') === null ? 'crossfade' : 'cut'
        } catch {
          return 'cut'
        }
      }
      runViewTransition(() => {
        if (viewStore.getSnapshot().active !== selected) return
        if (selected !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(selected)) return
        viewStore.paint(target)
        perfMark(PERF_MARKS.appViewReveal, target)
      }, 'view', paint)
    })
  }, [activeView, paintedView, shellStates, mountedViews, revealTick])

  // **屏上视图**落地即重计隐藏窗（判据是 paintedView，不是 activeView）：
  // 离开屏的旧视图开始计时，新屏上视图清计时。覆盖揭示落地、注册表删除回落
  // （fallback 到 local）等一切路径；持有窗内旧视图仍在屏上，不会因本 effect 被计时
  // ——否则 1s 持有期给屏上壳起表，保留策略会把"用户正在看的温壳"当隐藏壳回收。
  useEffect(() => {
    if (previousActiveViewRef.current === paintedView) return
    const previous = previousActiveViewRef.current
    previousActiveViewRef.current = paintedView
    delete hiddenSinceRef.current[paintedView]
    if (previous !== null) hiddenSinceRef.current[previous] = Date.now()
  }, [paintedView])

  // hiddenSince 键随挂载收敛（覆盖注册表删除分支与回收两条移除路径）+
  // 挂载/回收/激活变化后尽快补查一轮回收（60s 安全窗外的兜底由周期 tick 承担）。
  useEffect(() => {
    const live = new Set(mountedViews)
    for (const id of Object.keys(hiddenSinceRef.current)) {
      if (!live.has(id)) delete hiddenSinceRef.current[id]
    }
    // 挂载时刻（绝对放弃上限的基准；settle 时清除）。**被推迟的 boot 不起表**：
    // 还没有在途 boot，绝不能被放弃臂判成"永不 settle"；相位离开 idle
    // 后本 effect 因签名变化重跑，那一刻才起表（新尝试有自己的预算）。
    // 刻意**只跳过起表、绝不删除已有表**：boot 已经开始、来源随后被手动断开时，
    // 在途的那次 boot 仍需放弃臂看管（删表会让它失去唯一的兜底）。
    const now = Date.now()
    for (const id of mountedViews) {
      if (deferredBootRef.current.has(id)) {
        // 生命周期：被推迟的视图**永不 settle**，所以它拿不到 handleInstanceSettled
        // 的 hiddenSince——后台挂载（设置面板选来源）又不会经过 activeView 变化臂。
        // 没有计时键，下面的推迟回收臂与 retention 都看不见它（视图泄漏 +
        // 误占预热槽/隐藏壳数）。这里按挂载时刻起表，与"隐藏即计时"同一条语义。
        if (id !== viewStore.getSnapshot().active && id !== pendingViewRef.current
          && hiddenSinceRef.current[id] === undefined) {
          hiddenSinceRef.current[id] = now
        }
        continue
      }
      if (viewBootStartedAtRef.current[id] === undefined) viewBootStartedAtRef.current[id] = now
    }
    for (const id of Object.keys(viewBootStartedAtRef.current)) {
      if (!live.has(id)) delete viewBootStartedAtRef.current[id]
    }
    reclaimHiddenViews()
  }, [mountedViews, deferredBootSignature, reclaimHiddenViews])

  // 周期回收检查（settle/切换以外的主要驱动）；visibilitychange 恢复补偿的
  // 回收臂在下方 aggregate 段 visibility effect 中统一处理（与预热/聚合补偿
  // 同源，避免重复监听）。
  useEffect(() => {
    const timer = setInterval(() => {
      reclaimHiddenViewsRef.current()
      // 退避期满的重试不能只靠 30s roster 轮询带来的重渲染驱动（轮询失败时
      // 后台槽会无限空转）：同一 tick 补一次 drain。
      drainPrewarmRef.current()
    }, VIEW_RECLAIM_TICK_MS)
    return () => { clearInterval(timer) }
  }, [])

  // 温壳为收割让位：把最后收割的壳留在温壳位省了一次 boot，
  // 但该壳（autoPrewarmed + 隐藏）会占住唯一后台槽且不被 retention 回收——一旦
  // 出现新的收割候选，它必须让位，否则后变 ready 的来源永远拿不到基线（与
  // "一个失败实体不得阻塞其它"同源）。已有权威聚合，回收只是拆壳。
  useEffect(() => {
    if (!shouldRunBackgroundPhase(document.visibilityState)) return
    if (harvestCandidatesRef.current.size === 0) return
    const warm = mountedViews.find(id =>
      id !== LOCAL_INSTANCE_ID
      && id !== activeView
      && autoPrewarmedRef.current.has(id)
      && harvestStateRef.current[id]?.satisfied === true)
    if (warm !== undefined) reclaimView(warm, 'harvest')
  }, [mountedViews, activeView, prewarmEligible, reclaimView])

  useEffect(() => {
    const eligible = prewarmEligibleRef.current
    prewarmQueueRef.current = prewarmQueueRef.current.filter(id => eligible.has(id))
    // 已不再 eligible 的意图优先级键（被点开而挂载、被回收抑制、退役、
    // harvest 停车）就地作废——悬停不得让一道已经落下的 App 纪律复活。
    for (const id of [...intentPriorityRef.current]) {
      if (!eligible.has(id)) intentPriorityRef.current.delete(id)
    }
    for (const instance of remoteInstances) {
      const id = sourceIdForInstance(instance)
      if (!eligible.has(id)) continue
      const queue = prewarmQueueRef.current
      if (!queue.includes(id)) queue.push(id)
    }
    drainPrewarm()
    // activeView 依赖：保留槽可经「纯激活」释放——
    // 用户点开一个已挂载的隐藏温壳（mountedViews 不变、无 settle/roster/
    // 可见性事件）——eligible 随 activeView 变化增长，但队列补种与 drain 都
    // 在此 effect；缺该依赖会静默饿死下一次投机预热直到无关事件到来。
  }, [remoteInstances, remoteStatus, mountedViews, activeView, drainPrewarm])

  /** 打开某来源的会话：切到该来源 shell（未挂载先挂载）并分发到运行时。
   *  chamber：进入时 arm 一条打开意图、settle 时
   *  按 sessionId 守卫地释放——它是"这次打开还没落地"的唯一事实源，同时驱动
   *  ①投影门（该来源在此窗口内不投影 current，blank"新会话"行不可能进列表）
   *  ②揭示门（目标壳干净 settle 后遮罩继续留到本次 open 落定）
   *  ③boot 期早开（目标 ctx 内的侧栏插件读活槽位，抢在运行时初始导航之前）。
   *  守卫式释放保证"点 X 后马上点 Y"时，X 的迟到 finally 不会撤掉 Y 的闸门。 */
  const openSession = useCallback(async (instanceId: string, sessionId: string) => {
    // 用户要在这个来源上工作：error/degraded 隧道立即再试（同上）。
    ensureRemoteConnected(instanceId)
    // 与 selectView 同款注册表守卫：来源已删除时拒绝入队——否则 open 会
    // 挂进 pendingOpens 永不分发（视图不再挂载，dispose 已执行），留死键。
    if (instanceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(instanceId)) {
      // The open-failure texts are thrown
      // across the frame→plugin boundary (the sidebar renders whatever text the
      // rejected promise carries), so the FRAME-OWNED part is dictionary copy in
      // the document locale; read at throw time, since no render scope owns it
      // (locales.ts readDocumentLocale — the module's out-of-render reader).
      throw new Error(frameText(readDocumentLocale(), 'open.failed.sourceGone', { source: instanceId }))
    }
    try {
      armOpenIntent(instanceId, sessionId)
      selectView(instanceId)
      await openInstanceSession(instanceId, sessionId)
    } catch (err) {
      // Dictionary copy around a raw cause —
      // `{detail}` is the underlying error text, which stays whatever the
      // crossing boundary produced. BOUNDARY (deliberate, open work for the docs
      // lane): that text is assembled BELOW the frame — shell.ts's open-failure
      // diagnostics (`实例 … 无法打开会话：…`, the list/open deadlines) and the
      // dsh runtime's own errors — and none of those sites owns a locale seat, so
      // an English document still sees a Chinese detail clause here. The frame's
      // half is dictionary copy; translating another module's error text would be
      // a second, drifting copy of it.
      throw new Error(frameText(readDocumentLocale(), 'open.failed.detail', { detail: errorMessage(err) }))
    } finally {
      releaseOpenIntent(instanceId, sessionId)
    }
  }, [selectView, ensureRemoteConnected])

  type NotificationOpen = NotificationOpenDelivery & {
    phase: 'live' | 'held'
    sourceOwner: SourceOwnershipToken | null
  }
  const notificationOpenRunnerRef = useRef<SerialIntentRunner<NotificationOpen> | null>(null)
  notificationOpenRunnerRef.current ??= new SerialIntentRunner<NotificationOpen>()
  const enqueueNotificationOpen = useCallback((delivery: NotificationOpenDelivery, phase: NotificationOpen['phase']) => {
    const sourceOwner = sourceLifecyclesRef.current!.capture(delivery.sourceId)
    if (!deliveryMatchesCurrentSource(
      sourceLifecyclesRef.current!,
      delivery.sourceId,
      delivery.sourceFingerprint,
    )) {
      console.warn(`[notifications] ignored stale source proof (${delivery.sourceId}/${delivery.sessionId})`)
      return acknowledgeNotificationOpen(delivery).catch(error => {
        reportNotificationAckFailure(delivery, error)
      })
    }
    const settled = notificationOpenRunnerRef.current!.enqueue(
      {
        ...delivery,
        phase,
        sourceOwner,
      },
      open => {
        if (!sourceLifecyclesRef.current!.owns(open.sourceOwner)) {
          // Same dictionary rule as the two
          // open-failure texts above — the notification runner's rejection text
          // is surfaced by the sidebar, so the frame's half is dictionary copy.
          throw new Error(frameText(readDocumentLocale(), 'open.failed.sourceRebuilt', { source: open.sourceId }))
        }
        return openSession(open.sourceId, open.sessionId)
      },
      (error, open) => {
        console.error(`[notifications] 打开 ${open.phase} 会话失败 (${open.sourceId}/${open.sessionId}):`, error)
      },
    )
    return settled.then(async () => {
      try {
        await acknowledgeNotificationOpen(delivery)
      } catch (error) {
        reportNotificationAckFailure(delivery, error)
      }
    })
  }, [acknowledgeNotificationOpen, openSession, reportNotificationAckFailure])

  /** Notification clicks can be released by main before the initial remote
   * roster arrives, just like deep-link activation. Replay their full payloads
   * after authority settles; a removed source is loud-dropped and never enters
   * shell.ts's pending-open queue. */
  useEffect(() => {
    if (
      !rosterGate.isSettled()
      || pendingRosterNotificationOpensRef.current.length === 0
    ) return
    const pending = pendingRosterNotificationOpensRef.current
    pendingRosterNotificationOpensRef.current = []
    for (const open of pending) {
      const classification = classifyRosterGatedSource(open.sourceId, true, liveServerIdsRef.current)
      if (classification === 'missing') {
        console.warn(`[notifications] pending source is no longer in the authoritative roster: ${open.sourceId}`)
        void acknowledgeNotificationOpen(open).catch(error => {
          reportNotificationAckFailure(open, error)
        })
        continue
      }
      void enqueueNotificationOpen(open, 'held')
    }
  }, [
    roster,
    liveServerIds,
    acknowledgeNotificationOpen,
    enqueueNotificationOpen,
    reportNotificationAckFailure,
  ])

  /**
   * 「全部已读」：读水位与落盘都在 App 手里（读数纪律），所以侧栏只发意图、
   * 动作在此执行——一次性把该来源的读标记抬到**源级上界**（maxWatermark：
   * max(updatedAt, completedAt) 的全表最大值），落盘并通知镜像（ackAllRead 的
   * read-all 地板），然后重算派生（蓝点/todo 立即清空，单调提升绝不回退）。
   */
  const markSourceAllRead = useCallback((sourceId: string): void => {
    if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
    const snapshot = factsStore.getSnapshot().session[sourceId]
    const rows = snapshot !== undefined && snapshot.verdict === 'ok' ? snapshot.rows : undefined
    if (rows === undefined) return
    const through = maxWatermark(rows)
    // 没有可用水位（全是 0）时什么都不做：绝不写一个凭空的"已读"读数。
    if (through <= 0) return
    const table = readMarksRef.current[sourceId] ?? {}
    const next: Record<string, number> = { ...table }
    for (const sessionId of Object.keys(rows)) {
      next[sessionId] = advanceReadMark(next[sessionId], through) ?? through
    }
    readMarksRef.current = { ...readMarksRef.current, [sourceId]: next }
    schedulePersistUnread()
    sessionFactsSourcesRef.current.get(sourceId)?.ackAllRead(clientInstallIdRef.current, through)
    recomputeSourceUnread(sourceId)
  }, [recomputeSourceUnread, schedulePersistUnread])

  // 桥订阅簇（全部已读 / 深链 / 回声 / 挂载快照 / 运行时上报…）是命名
  // hook；依赖面类型化，App 只负责传入当前 ref/state/回调与预算常量。
  useBridgeSubscriptions({
    acknowledgeDeepLink, emitSessionNotification, markSourceAllRead, openSession,
    recomputeSourceUnread, refreshAggregate, reportDeepLinkAckFailure, selectView,
    updateSessionArchive, updateSessionEcho, updateWorkspaceEcho, aggregatePollSeqRef,
    aggregateRequestOwnersRef, authoritativeArchiveSetRef, autoPrewarmedRef, completeLedgerRef,
    drainPrewarmRef, factsAtRef, harvestCandidatesRef, harvestIntentRef,
    harvestStateRef, intentBudgetRef, intentPriorityRef, liveServerIdsRef,
    mutationRefreshSeqRef, pendingDeepLinkDeliveryRef, prevRunningRef, prevRuntimeFactsRef,
    prewarmEligibleRef, prewarmQueueRef, prewarmSuppressedRef, readyAggregateSourcesRef,
    reclaimViewRef, remotesStore, isRosterSettled: () => rosterGate.isSettled(), echoStore,
    factsStore, sessionListRefreshAtRef, sessionListRefreshPendingRef,
    settingsTargetRef, snapshotAtRef, mountedSources, sourceLifecyclesRef,
    watchdogAggregatesRef, setAggregates, setHostFacts,
    setMountedViews, setPluginDiagnostics,
    setUnverified, sshBridgeReady, LISTENER_READY_RETRY_MS, LISTENER_READY_RETRY_LIMIT,
  })

  /** chamber (design 06)：**屏上**来源（paintedView，
   *  非选择——持有窗内 active 已是目标而屏上仍是旧视图）的 current 会话立即视为
   *  已读：清除后台期间武装的蓝点；读水位推进 + 派生重算在同一拍
   *  （recomputeSourceUnread 内完成，覆盖「激活但无新上报」的路径，如点击来源头
   *  不打开会话）。谓词与通知 requireHidden / readingCurrent 完全同一份
   *  （paintedView ∩ current ∩ hasFocus）。 */
  const prevPaintedViewRef = useRef(paintedView)
  useEffect(() => {
    const previous = prevPaintedViewRef.current
    prevPaintedViewRef.current = paintedView
    if (previous === paintedView) return
    recomputeSourceUnread(paintedView)
    recomputeSourceUnread(previous)
  }, [paintedView, recomputeSourceUnread])

  // 未读徽标 effect 簇（推送 / 桥迟到兜底 / reject 重推与卸载清理）是
  // 命名 hook；事实源与预算显式传入，桥面由 hook 内读 window 单例。
  useBadgeCount({
    completedBySource,
    runtimeFacts,
    retryMs: LISTENER_READY_RETRY_MS,
    retryLimit: LISTENER_READY_RETRY_LIMIT,
  })


  // 控制面失联 = 覆盖式致命屏（视图保持挂载、恢复即续会话，design 05）。判定：
  // 健康错误**持续**存在超过宽容窗才呈现——首帧（health 从未拉到）立即呈现。
  // 截止时刻一次性触发（host/use-deadline.ts）：不再用 1 Hz 计数强制重渲染。
  const healthGraceOver = useDeadline(
    healthError === null || healthErrorAt === null ? null : healthErrorAt + HEALTH_ERROR_GRACE_MS,
  )
  const controlUnreachable = healthError !== null && (health === null || healthGraceOver)

  // 活动视图的 shell 失败报告（design 05 失败呈现修订）：boot 失败 settle 后由
  // InstanceView 上报终态；只有失败态（error 非空）触发覆盖层——booting/
  // 成功态由骨架屏/真实 UI 呈现。
  const activeShellState = shellStates[activeView]
  const activeShellError = activeShellState?.error ?? null
  // 失败/控制面不可达的**强制揭示**：这两条路径继续用 selected
  // （用户选的那个失败必须立刻可见），并且不等待揭示门——覆盖层是模态且不透明的，
  // 没有白帧风险；但屏上不能停在旧视图上等一个永远不会到来的"目标首帧"。直接
  // viewStore.paint（不走过渡节）：它在同一提交里把 painted 收敛到 selected，覆盖层
  // 随之独占屏幕。揭示门的 failed/settled 分支是常规路径，这里是兜底（含控制面
  // 不可达这种与壳状态无关的全局条件）。
  useEffect(() => {
    if (activeShellError === null && !controlUnreachable) return
    if (viewStore.getSnapshot().painted === activeView) return
    revealHoldStartedAtRef.current = null
    viewStore.paint(activeView)
  }, [activeShellError, controlUnreachable, activeView])
  // The failed boot's plugin ids, as the
  // official report lists them (shell.ts collectFailedEntries reads the failed
  // boot's own loader sweep). Empty for failures that produced no loader entry
  // (module-system/manifest), which keeps today's report-only overlay.
  const activeShellFailedEntries = activeShellState?.failedEntries ?? NO_FAILED_ENTRIES
  // 降级呈现：活动视图 boot 成功但已知缺口时，给出现场说明。
  // 只有 error 为空的降级态才渲染——boot 失败覆盖层已独占失败态（结构互斥，
  // 见 shell.ts：settled 的 degraded 蕴含 booted && error === null）。**但控制面
  // 不可达覆盖层与壳状态无关**，上面的条件管不住它，故渲染处再加一道
  // `!controlUnreachable`：否则横幅会被那张不透明覆盖层盖住却仍可聚焦/播报。
  // 「会自动重挂吗」由 boot-gap.ts 的纯判定给出：来源 ready 且本 ready 世代
  // 还没重挂过，才允许承诺自动重挂（self-heal 从不触碰非 ready 来源）。
  const activeShellGap = activeShellState !== undefined && activeShellState.error === null
    ? activeShellState.degraded
    : null
  const activeBootGap = activeShellGap === null
    ? null
    : bootGapNotice(activeShellGap, {
        phase: servers.find(server => server.id === activeView)?.phase,
        retried: degradedRetriedRef.current[activeView] === true,
        // Keyed on the frame fact (local runtime management is read-only on
        // Windows), never on the producer's diagnostic sentence.
        instanceId: activeView,
      })

  // 停滞提示的可见集合（用户已忽略的来源不再提示；来源恢复即自动解除忽略）。
  // 停滞来源与「事实无法验证」来源共用同一横幅（文案 = 「无法确认会话状态」）。
  const visibleStalls = [...new Set([...stalledSources, ...unverifiedSources])]
    .filter(id => !dismissedStalls.includes(id))
  return (
    <ErrorBoundary>
      <div className="app">
        {/* 运行位活性守卫的 L3：L1 对账（含权威写回）与 L2 有界
            reconnect 都没能收敛时，只给用户两个选择——轻恢复（重新连接，不丢页面状态）与
            重恢复（重新加载应用页面）。绝不自动重载：与 mobile 的
            session-stall.ts 同纪律（观测者只呈现，动作由用户决定）。 */}
        {visibleStalls.length > 0 && !controlUnreachable && activeShellError === null && (
          <div className="session-stall-layer">
            <div className="session-stall">
              {/* role=status 只包**文本**：交互后代放进 live region 会在整区
                  变化时被读屏整体重播（与 boot-gap 横幅同规）。 */}
              <div className="session-stall-text" role="status">
                {t('sessionStall.text', {
                  sources: visibleStalls
                    .map(id => servers.find(server => server.id === id)?.label ?? id)
                    // 分隔符按语言（en 用 ', '，zh 用 '、'）：硬写 '、' 会让英文
                    // 文案里出现中文顿号。
                    .join(t('sessionStall.separator')),
                })}
              </div>
              <div className="session-stall-actions">
                <Button
                  variant="outline"
                  onClick={() => {
                    // 与自动臂用同一记账（返回值 + 共享账本）：否则用户点一次之后
                    // 自动臂看不到、守卫预算也没消耗，会在同一窗口再自动重连一次
                    // （每次重连都要重放全部 baseline）。
                    // 手动动作也要**有界**：连点/多按钮会各自
                    // 重放一份完整 baseline，所以沿用自动臂的 60s per-source 退避——
                    // 窗口内只记账不重连（但记账仍需发生，否则自动臂会马上补一次）。
                    const at = Date.now()
                    for (const id of visibleStalls) {
                      const lastReconnectAt = lastReconnectAtRef.current[id]
                      if (lastReconnectAt !== undefined && at - lastReconnectAt < AGGREGATE_RECONNECT_BACKOFF_MS) continue
                      if (!reconnectInstanceConnection(id)) continue
                      lastReconnectAtRef.current = { ...lastReconnectAtRef.current, [id]: at }
                    }
                  }}
                >
                  {t('sessionStall.reconnect')}
                </Button>
                <Button variant="outline" onClick={() => { window.location.reload() }}>
                  {t('sessionStall.reload')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setDismissedStalls(prev => [...prev, ...visibleStalls]) }}
                >
                  {t('sessionStall.dismiss')}
                </Button>
              </div>
            </div>
          </div>
        )}
        {/* 视图始终挂载：致命屏改为覆盖层——卸载视图而不 dispose shell 会
            遗留僵尸 ctx（entries 被新 boot 覆盖、旧 ctx 永不清除，违反
            design 05 §4 无僵尸不变量），且恢复后要重 boot 丢会话连续性。 */}
        {mountedViews.map((viewId) => {
          const sourceFingerprint = sourceLifecyclesRef.current!.capture(viewId)?.fingerprint
          const transport = servers.find(server => server.id === viewId)?.transport
          if (sourceFingerprint === undefined || transport === undefined) return null
          /**
           * reveal gate. Read from data this view ALREADY has — the RAW runtime
           * current (never the gated projection, which the veil itself hides) and
           * the source's own aggregate, whose session rows carry the runtime's
           * `blank` flag (`InstanceAggregate.sessions`, projected by
           * projectInstanceSnapshot). No extra fetch: the mounted ctx pushes that
           * snapshot, and the unary fallback fills it for unmounted sources.
           * UNKNOWN ⇒ true on purpose: a session the aggregate does not list yet
           * (cold boot, the push has not landed) must keep the veil. Only a KNOWN
           * non-blank current session makes this false — a warm shell showing a
           * real session needs no veil.
           */
          const currentSessionId = runtimeFacts[viewId]?.current
          const blankCurrent = currentSessionId === undefined
            || (aggregates[viewId]?.sessions.find(session => session.sessionId === currentSessionId)?.blank ?? true)
          return (
            <InstanceView
              key={viewId}
              instanceId={viewId}
              basePath={instanceBasePath(viewId)}
              sourceFingerprint={sourceFingerprint}
              transport={transport}
              // 可见性由 **paintedView**（屏上是谁）驱动，不是选择——点击后旧视图
              // 保持可见到揭示门放行，目标壳（未 settle 时仍是 instance-pending）绝不
              // 在持有窗内提前露出。选择语义仍走 activeView（失败面/横幅/侧栏导航）。
              active={paintedView === viewId}
              label={serverLabels[viewId] ?? (viewId === LOCAL_INSTANCE_ID ? t('source.local') : viewId)}
              locale={locale}
              onSettled={handleInstanceSettled}
              onStateChange={handleShellState}
              retryToken={retryTokens[viewId]}
              waitForServing={waitForServing}
              // 遮罩的事实输入与动作（导航/回收顺序仍由 App 拥有）。
              sourcePhase={servers.find(server => server.id === viewId)?.phase}
              bootDeferred={deferredBootIds.has(viewId)}
              // App 的全局失败覆盖层是模态的：覆盖层在场时遮罩退出 DOM（否则
              // 其按钮仍可聚焦/被读屏播报）。
              // 两种模态覆盖层都要算：boot 失败（activeShellError）与控制面不可达
              // （controlUnreachable 的 .fatal-overlay，同样不透明）。
              failureOverlayVisible={activeShellError !== null || controlUnreachable}
              switchTargets={servers
                .filter(server => server.id !== viewId)
                .map(server => ({ id: server.id, label: server.label }))}
              onSwitchSource={targetId => switchSourceFromVeil(viewId, targetId)}
              onConnectSource={() => connectSourceFromVeil(viewId)}
              onRequestRetry={() => retryView(viewId)}
              // The reveal gate. The
              // boot window is covered by the view's own `!settled` veil; this
              // boolean extends the hold past a clean settle for exactly as long
              // as the shell would NOT show the requested session. Every input
              // lives in the App: the shell's settled/failed mirror, the RAW
              // runtime current (never the gated projection value — the gate
              // exists to hide that very value) and that view's own blank flag
              // (blankCurrent, below).
              // Deliberately NOT "any pending open": a view that already shows
              // the requested session (idempotent re-open, or the boot-ctx
              // early-open arm having preempted the runtime's initial selection)
              // must not veil at all, and a warm visible shell that is switching
              // between two REAL sessions resolves synchronously — holding a veil
              // there would hide a working UI for no reason.
              // "shows nothing legitimate" is a REQUIRED
              // input of the shared rule (blankCurrent) — the hold is
              // `pendingIntent && !failed && !showsRequestedSession &&
              // blankCurrent`, i.e. the veil covers only a blank (cold "新会话")
              // or unknown current session, never a warm shell showing a real one.
              holdVeil={shouldHoldViewVeil({
                failed: (shellStates[viewId]?.error ?? null) !== null,
                pendingIntent: openIntents[viewId] !== undefined,
                blankCurrent,
                // `openIntents[viewId] !== undefined` is spelled out here on
                // purpose: without it, "no current AND no intent" would read as
                // "already showing the requested session" (undefined ===
                // undefined). The rule short-circuits on pendingIntent today, but
                // the comparison must not depend on that for its meaning.
                showsRequestedSession: openIntents[viewId] !== undefined
                  && shellStates[viewId]?.booted === true
                  && runtimeFacts[viewId]?.current === openIntents[viewId],
              })}
              // 持有窗的请求身份：同视图 A→B 换代时窗口必须
              // 重新起算，否则新请求会继承 A 的起点（极端时窗口立即过期）。
              openIntentId={openIntents[viewId]}
            />
          )
        })}
        {/* chamber (失败呈现修订, design 05 §4)：活动视图 boot 失败 = 该视图
            的 dsh shell 从未挂载——导航（侧边栏在 shell 内）随之不可用，若不
            提供逃生通道，用户会被失败报告困在当前视图（只能整页刷新）。
            覆盖层 = 失败报告 + 重试 + 服务器切换：失败以 chamber 层呈现，
            绝不阻断切换/重试（正确性不变量：一个实体的失败不得抹除/阻断
            无关的健康实体）。仅活动视图渲染；非活动视图失败在激活时呈现。
            控制面不可达（controlUnreachable）是更高层的全局条件，渲染在其
            之上（下方 JSX 顺序在后）。 */}
        {activeBootGap !== null && !controlUnreachable && (
          <div className="boot-gap-layer">
            {/* 降级呈现（design 05 §4）：boot 成功但整个面缺席时的现场说明。
                非模态、不阻断——侧栏/会话头/composer/切换来源全部照常，命中测试
                只落在卡片本身（层 pointer-events:none）。role="status" 而非
                "alert"：本通知不夺焦点也不打断读屏，且 kind 并不能判定"暂时"
                还是"结构性"（图通道竞态与结构性缺行同 kind），用 alert 会把
                几秒的竞态当成事故播报。文案全部来自框架字典；产出方的原文只作
                诊断行（跨边界诊断文案规则）。 */}
            <div className="boot-gap" role="status">
              <div className="boot-gap-title">{t('bootGap.title')}</div>
              <div className="boot-gap-body">{t(activeBootGap.bodyKey)}</div>
              {activeBootGap.services.length > 0 && (
                <div className="boot-gap-facts">
                  {t('bootGap.services')}: {activeBootGap.services.join(', ')}
                  {activeBootGap.injectedBy.length > 0
                    ? ` · ${t('bootGap.injectedBy')}: ${activeBootGap.injectedBy.join(', ')}`
                    : ''}
                </div>
              )}
              {activeBootGap.failedIds.length > 0 && (
                <div className="boot-gap-facts">
                  {t('bootGap.failedPlugins')}: {activeBootGap.failedIds.join(', ')}
                </div>
              )}
              <div className="boot-gap-action">
                {/* The manual half is decided by boot-gap.ts (kind + source id);
                    autoRetryArmed keeps its own honest promise. Local and remote
                    sources get DIFFERENT manual copy: the local runtime
                    is a read-only projection on Windows. */}
                {t(activeBootGap.autoRetryArmed ? 'bootGap.action.autoRetry' : activeBootGap.manualKey)}
              </div>
              {activeBootGap.detail !== '' && (
                <div className="boot-gap-detail">{t('bootGap.detail')}: {activeBootGap.detail}</div>
              )}
              {activeBootGap.retryable && (
                <Button variant="outline" onClick={() => retryView(activeView)}>
                  {t('action.retry')}
                </Button>
              )}
            </div>
          </div>
        )}
        {activeShellError !== null && (
          <div className="fatal fatal-overlay">
            {/* The failure report carries
                the SAME content the official report does — a title, the boot
                failure text, and the plugin ids that did not activate (the
                shell reads them off the failed boot's own loader sweep and the
                ids ride ShellState, never a new channel). The chamber cover
                itself stays (design 05 §2.2.1 gate 2 + §4: navigation lives
                inside the shell, so a failed boot needs this escape hatch). */}
            <div role="alert">
              <div className="fatal-title">{t('fatal.boot.title')}</div>
              <div className="fatal-message">{activeShellError}</div>
              {activeShellFailedEntries.length > 0 && (
                <div className="fatal-entries">
                  <div className="fatal-entries-title">{t('fatal.entries.title')}</div>
                  {activeShellFailedEntries.map(entryId => (
                    <div key={entryId} className="fatal-entry">{entryId}</div>
                  ))}
                </div>
              )}
            </div>
            <Button
              variant="primary"
              onClick={() => {
                // 重试 = 重新 boot 该视图；error/degraded 隧道同时立即再试，
                // ready 但会话/远端已死的来源立即探测一次（与 selectView
                // 同语义——boot 失败若由隧道故障或死会话引起，不重连/不探测
                // 则重试只会再次失败）。与降级提示共用唯一入口 retryView。
                retryView(activeView)
              }}
            >
              {t('action.retry')}
            </Button>
            {servers.length > 1 && (
              <div className="fatal-servers">
                <span className="muted small">{t('action.switchServer')}</span>
                {servers.map(server => (
                  server.id === activeView ? null : (
                    <Button
                      key={server.id}
                      variant="outline"
                      onClick={() => selectView(server.id)}
                    >
                      {/* 空 label 回退 id，避免出现无标签的切换按钮 */}
                      {server.label !== '' ? server.label : server.id}
                    </Button>
                  )
                ))}
              </div>
            )}
          </div>
        )}
        {controlUnreachable && (
          <div className="fatal fatal-overlay">
            {/* a11y: the
                fatal overlay is an alert like its boot-failure sibling — a
                screen reader must announce the control-plane loss without a
                focus move. */}
            <div role="alert">
              <div className="fatal-title">{t('fatal.controlPlane.title')}</div>
              <div className="fatal-message">{healthError}</div>
            </div>
            <Button
              variant="primary"
              onClick={() => {
                void refreshHealth()
                void refreshConnections()
              }}
            >
              {t('action.retry')}
            </Button>
          </div>
        )}
      </div>
    </ErrorBoundary>
  )
}
