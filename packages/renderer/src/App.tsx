/**
 * dsh-chamber bridge host：页面唯一入口宿主。首屏 = 本地实例的完整 dsh shell（纯 dsh UI，
 * 无 chamber 外壳）；多来源 session/workspace 导航在 dsh 原生侧边栏内由 chamber 插件承担。
 * 本组件只负责数据层与 N-ctx 编排：控制面 /health 与 /api/connections 轮询；桌面 ssh 实例
 * 装载与状态投影订阅（隧道 URL 永不进 renderer）；每实例 workspace/session 聚合；本地实例
 * 自动启动、注册表远程实例自动连接。
 * N-ctx shell 挂载：local 常驻，其他来源按需挂载/空闲预热；隐藏壳不无限常驻——除 local 恒留
 * 外至多保留 RETAINED_HIDDEN_VIEWS 个，超限回收已 settle 且连续隐藏 ≥60s 的最久者
 * （retention.ts）；回收仅拆 UI 壳，实例进程/连接/后台任务不受影响，重开走冷 boot。
 * chamberBridge 投影发布（design 05）：轮询状态合并为 ChamberServerAggregate[] 供侧边栏消费；
 * onOpenSession 驱动 openSession 切 shell 并分发，打开终态经 reportOpenSessionOutcome 回报。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  reincarnate,
  retainSourceIds,
  waitForCondition,
  LADDER_TABLES,
  sessionAuthorityEscalationLadder,
} from '@dsh-chamber/dsh-stream-state'
import { type ConnectionSummary, type HealthResponse } from './api.ts'
import {
  armOpenIntent,
  chamberBridge,
  clearOpenIntents,

  configurePageChannelLink,
  emptyIntentPrewarmBudget,
  forgetPendingArchives,
  forgetPendingPlacements,
  forgetPendingRemovals,
  forgetPendingSessions,
  forgetPendingWorkspaces,
  getOpenIntentsSnapshot,
  linkEpochOf,
  linkReady,
  releaseInstanceClient,
  releaseOpenIntent,
  shouldHoldViewVeil,
  subscribeOpenIntent,
  sweepPendingArchives,
  sweepPendingPlacements,
  sweepPendingRemovals,
  sweepPendingSessions,
  sweepPendingWorkspaces,
  type InstanceAggregate,
  type InstanceRuntimeReport,
  type IntentPrewarmBudget,
  type PluginGraphDiagnostic,
} from '@dsh-chamber/dsh-chamber-client-core'
// Desktop-observed stall evidence：桌面帧/输入探针的打击计数进页内注册表，供恢复阶梯同源消费。
import { publishRendererStallObservation } from './renderer-stall-evidence.ts'
// native 投递 journal（唯一 native 调用层的 durable 队列；run 身份 key + 稳定 eventKey）。
import { monotonicNow } from './monotonic-now.ts'
// 观测状态（goal-aware v5 §3.2）：App 持有每来源观测代状态，裁决在 useNotifications
// 与桥 hook 的 observeSource/applyObservationBatch 接线里。
import { withdrawObservationState, type SourceObservationState } from './completion-observation.ts'
// 页代 token（sessionStorage）：区分 reload 与新进程/新窗口（§3.5）。
// 预热命中率仪表（attempt/hit/cancelled）。
import { recordPrewarm } from './prewarm-ledger.ts'
// gateway session-state 只读事实源的快照/实例类型 + 唯一可判谓词（读水位推进门）。
import type { SessionFactsSource } from './session-facts-source.ts'
// probe 判定 → 侧栏档位：无快照即缺席 = 未知。
import { pruneSourceList, pruneSourceRecord } from './source-registry.ts'
import { LOCAL_INSTANCE_ID } from './local-instance.ts'
import {authoritativeSourceRetirements, classifyRosterGatedSource, deliveryMatchesCurrentSource, enqueueBoundedRosterIntent, parseAuthoritativeSourceFingerprint, SerialIntentRunner, SourceOwnershipRegistry, subscribeRosterBeforeRefresh, type SourceOwnershipToken} from './deep-link-activation.ts'
import { useAppRegistry } from './app-hooks/use-app-registry.ts'
import { useRemoteRefresh } from './app-hooks/use-remote-refresh.ts'
import { useViewSelection } from './app-hooks/use-view-selection.ts'
import { useDeepLinkDelivery, type PendingDeepLinkDelivery } from './app-hooks/use-deep-link-delivery.ts'
import { useNotificationOpenReplay, type NotificationOpenDelivery as ReplayNotificationOpenDelivery } from './app-hooks/use-notification-open-replay.ts'
import { useMountedViewClocks } from './app-hooks/use-mounted-view-clocks.ts'
import { useRosterAcquisition } from './app-hooks/use-roster-acquisition.ts'
import { useVisibilityCompensation } from './app-hooks/use-visibility-compensation.ts'
import { usePageChannelLinkNotify } from './app-hooks/use-page-channel-link-notify.ts'
import { useSessionFactsLifecycle } from './app-hooks/use-session-facts-lifecycle.ts'
import { useConnectionBootstrap } from './app-hooks/use-connection-bootstrap.ts'
import { useServingGatePhases } from './app-hooks/use-serving-gate-phases.ts'
import { usePrewarmQueue } from './app-hooks/use-prewarm-queue.ts'
import { useHostHealthStream } from './app-hooks/use-host-health-stream.ts'
import { useProjectionPublish } from './app-hooks/use-projection-publish.ts'
import { useDeliveryAcks } from './app-hooks/use-delivery-acks.ts'
import { useSourceLifecycle } from './app-hooks/use-source-lifecycle.ts'
import { useNotificationBoot } from './app-hooks/use-notification-boot.ts'
import { openInstanceSession, reconnectInstanceConnection, disposeAllShells, disposeInstanceShell, isSettledShellState, type ShellState } from './shell.ts'
// 官方 Button atom，按 DEEP SOURCE PATH 导入：package BARREL 还会把 primitives 的
// markdown / CodeBlock 家族带进 main graph（它在 App mount 前求值），deep path 只把
// 它们留在 chamber entry。
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import {
  frameText, readDocumentLocale, subscribeDocumentLocale,
  type FrameKey,
} from './locales.ts'
import {AGGREGATE_RECONNECT_BACKOFF_MS, HEALTH_ERROR_GRACE_MS, LISTENER_READY_RETRY_LIMIT, LISTENER_READY_RETRY_MS, MAX_PENDING_ROSTER_NOTIFICATION_OPENS, MAX_PREWARMED_REMOTE_VIEWS, SERVING_POLL_MS, SERVING_WAIT_MS} from './host/budgets.ts'
import type { HostFacts } from './host/servers.ts'
import { createSourceLedger, pruneSourceLedger } from './host/source-ledger.ts'
import { useDeadline } from './host/use-deadline.ts'
import { createEchoStore } from './host/echo-store.ts'
import { createCompletedStore } from './host/completed-store.ts'
import { createFactsStore } from './host/facts-store.ts'
import { createMountedSourcesStore } from './host/mounted-sources-store.ts'
import { createViewStore } from './host/view-store.ts'
import { useManagedRuntime } from './host/use-managed-runtime.ts'
import { WAIT_SCHEDULER } from './wait-scheduler.ts'
// Settled-boot gap → render decision: the pure module owns the copy key, the retry verdict
// and the "will the self-heal re-mount this?" rule; the frame only maps its keys through `t`.
import { bootGapNotice } from './boot-gap.ts'
import { setPageActiveSource } from './page-language.ts'
import { runViewTransition, type PaintIntent } from './view-transition.ts'
// 揭示门（纯叶子）：持有窗/立即揭示的全部规则在那里，本文件只做接线。
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
import { errorMessage } from './status.ts'
import type { SshInstancesHealth } from './global.d.ts'
import {
  instanceBasePath,
  isServiceableLocalStatus,
  rawInstanceIdFromSourceId,
  sourceIdForInstance,
  sourceIdForRawInstance,
  sourceIdForTransport,
} from './transport-source.ts'
import {shouldRunBackgroundPhase} from './retention.ts'
import { decideServingGate, shouldDeferBootForSource } from './source-readiness.ts'
import { harvestSatisfied } from './baseline-harvest.ts'
import InstanceView from './components/InstanceView.tsx'
import { ReloadPageButton } from './components/ReloadPageButton.tsx'
import { useAggregateRefresh } from './app-hooks/use-aggregate-refresh.ts'
import { useShellRetry } from './app-hooks/use-shell-retry.ts'
import { useBadgeCount } from './app-hooks/use-badge-count.ts'
import {
  durableUnreadPruneAllowed, healthProbeUnavailableDiagnostic, rosterIncompleteDiagnostic,
  useBridgeSubscriptions,
  type HealthProbeUnavailableKind,
} from './app-hooks/use-bridge-subscriptions.ts'
import { useSshBridgeProbe } from './app-hooks/use-ssh-bridge-probe.ts'

import { useNotifications } from './app-hooks/use-notifications.ts'
import { useAbandonedViewsView, useDegradedRetriedView } from './app-hooks/use-source-ledger-views.ts'
import { useViewScheduler } from './app-hooks/use-view-scheduler.ts'
import { PERF_MARKS, perfMark } from './perf-marks.ts'

/** 会话事实权威升级 ladder 的引擎实例；tick 与 reconnect/notice 执行端在
 *  app-hooks/use-aggregate-refresh.ts，两者都要求 stuck 证据。 */
const SESSION_AUTHORITY_ESCALATION_LADDER = sessionAuthorityEscalationLadder(LADDER_TABLES.authority)

/**
 * Health probe payload as consumed by refreshRemotes. preload.cts is the authoritative wire
 * contract and carries the V5-A roster-incomplete fields; read them structurally (an absent flag
 * from an older producer means "complete", the pre-V5-A semantics).
 */
type SshInstancesHealthProbe = SshInstancesHealth & {
  rosterIncomplete?: boolean
  droppedCount?: number
}

// 桥面探测常量与 effect：app-hooks/use-ssh-bridge-probe.ts（App.tsx 行数棘轮，逻辑已抽出）。


/** Stable empty list for boots whose failure carries no loader entries. */
const NO_FAILED_ENTRIES: readonly string[] = []

type DeepLinkDelivery = PendingDeepLinkDelivery
type NotificationOpenDelivery = ReplayNotificationOpenDelivery


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
    // 崩溃屏替换 children = 所有视图卸载，但 AppWebEntry ctx 不随之消失：必须在此 dispose 全部
    // shell（entries 清空），重试后的重 boot 才不会覆盖未销毁的旧 ctx（无僵尸不变量）。
    disposeAllShells()
  }

  render(): React.ReactNode {
    if (this.state.error) {
      // A class component cannot own a hook, so it reads the locale via the module reader.
      const locale = readDocumentLocale()
      return (
        <div className="fatal">
          <div className="fatal-title">{frameText(locale, 'error.ui.title')}</div>
          <div className="fatal-message">{String(this.state.error?.message || this.state.error)}</div>
          {/* The official Button atom; the chamber's `.btn` chrome is not used. */}
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

export default function App() {
  // The frame owns no `t` seat, so it renders its own copy from the typed dictionary in
  // locales.ts, in the locale the DOCUMENT declares (`<html lang>`, written by the booted
  // shell's official locale service); the subscription re-renders the frame chrome on change.
  const locale = useSyncExternalStore(subscribeDocumentLocale, readDocumentLocale)
  const t = useCallback((key: FrameKey, params?: Readonly<Record<string, string>>) =>
    frameText(locale, key, params), [locale])
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  // 健康失败首次出现的时间戳：致命屏要求错误**持续**存在（宽容瞬时抖动/SSE 重连），否则中途失联会被陈旧 health 永远掩盖。
  const [healthErrorAt, setHealthErrorAt] = useState<number | null>(null)
  // 连接行初始 null = "尚未拉到首轮"（404 = 权威"无本地行"）；首启（无行）才触发本地实例自动启动。
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null)
  // 注册表投影 + 闸门 + 两个降级位 + 桥面判定：实现在 app-hooks/use-app-registry.ts。
  const {
    remotesStore, remotes, remoteInstances, rosterGate, roster,
    registryDegraded, setRegistryDegraded, registryDegradedWarnedRef,
    rosterIncomplete, setRosterIncomplete, rosterIncompleteWarnedRef,
    healthUnavailableWarnedRef, bridgeVerdict, setBridgeVerdict,
  } = useAppRegistry()

  // At most one renderer activation is useful (view switching is last-intent-wins), so this
  // fixed-size slot stops a failed roster from growing a second queue behind main's bounded one.
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

  // 投递 ACK（deep link / notification open）与失败上报的稳定回调：实现在
  // app-hooks/use-delivery-acks.ts（空依赖列表，逐次投递语义不变）。
  const {
    acknowledgeDeepLink, acknowledgeNotificationOpen,
    reportDeepLinkAckFailure, reportNotificationAckFailure,
  } = useDeliveryAcks()
  const remoteStatus = remotes.status
  // 视图：'local' | '<kind>-<id>'。N-ctx 常驻语义就是保留策略（retention.ts）：local 恒留；
  // 隐藏非 local 壳最多保留 RETAINED_HIDDEN_VIEWS 个，超限回收"已 settle + 连续隐藏 ≥60s"的
  // 最久者（回收 = dispose shell + 卸载壳；实例进程/连接/后台任务不受影响，重开走冷 boot +
  // entry 重放——见 reclaimView）。会话保活由实例侧承担，UI 壳不无限常驻。
  // 视图对（active=选择 / painted=屏上）单一权威：host/view-store.ts。事件回调、
  // 微任务与保留/揭示守卫读 store 快照（旧的两条渲染期 ref 镜像删除）。
  const [viewStore] = useState(() => createViewStore(LOCAL_INSTANCE_ID))
  const view = useSyncExternalStore(viewStore.subscribe, viewStore.getSnapshot, viewStore.getSnapshot)
  const activeView = view.active
  /**
   * 延迟揭示：**屏上真正可见的那个视图**，与 activeView（选择）分离——点击只改选择，painted 由揭示
   * effect 在「目标首帧可用」时经 'view' 过渡键收敛。两者相等 = 稳态；不等 = 一次在途揭示（至多一个）。
   * 必须分离：View Transition 只有"新状态渲染就绪后"才开始，而冷 boot 的"新状态首帧"就是遮罩本身。
   * 驱动面（只有这些消费者读 painted，其余读选择语义的 activeView）：`InstanceView active=`、hover 卡
   * 关闭、保留回收的"展示中"保护、`projectableCurrent` 高亮、hiddenSince 起表。
   */
  const paintedView = view.painted
  const [mountedViews, setMountedViews] = useState<string[]>([LOCAL_INSTANCE_ID])
  // 来源生命周期账本 + 派发 + 四个 live view（预热抑制 / 收割 / 隐藏窗）：实现在
  // app-hooks/use-source-lifecycle.ts；hook 次序与内部声明次序不变。
  const {
    sourceLedgerStoreRef, dispatchLifecycle, autoPrewarmedRef, prewarmSuppressedRef,
    settingsTargetRef, harvestStateRef, harvestIntentRef, harvestCandidatesRef, hiddenSinceRef,
  } = useSourceLifecycle(sourceLifecyclesRef)
  // reclaimView 的 ref 镜像：定义在下方（依赖 mountedViews），而 handleShellState / onInstanceSnapshot
  // 是 [] 依赖的回调——它们只能经此拿到最新闭包（同 reclaimHiddenViewsRef 纪律）。
  const reclaimViewRef = useRef<(id: string, reason?: 'retention' | 'harvest') => void>(() => undefined)
  // 保留策略计时：每视图"连续隐藏"起点（ms epoch；**屏上视图无键**）。settle 完成或离开屏时置 now，
  // 重新画上屏删除，随 mountedViews 收敛清理。previousActiveViewRef 供 paintedView 落地 effect 对比
  // （起表/清表都按 painted）。The hidden-window ledger is a LIVE VIEW over ONE per-source object.
  const previousActiveViewRef = useRef<string | null>(paintedView)
  // chamber：每视图 shell 终态（InstanceView 经 onStateChange 上报）——活动视图 boot 失败时由 App
  // 渲染统一失败覆盖层（失败报告 + 重试 + 服务器切换）。retryTokens 递增驱动 InstanceView 重 boot。
  const [shellStates, setShellStates] = useState<Record<string, ShellState>>({})
  /**
   * 来源就绪门 + 降级自愈：① 实例仍启动时让取图等它就绪（冷启动/重启跨越窗口不丢整套 profile 客户端
   * 插件）；② boot 以降级收尾而来源随后 ready 时自动重挂一次，每个 ready 世代一次；③ 干净 boot 但没取到
   * 图的壳在宿主后来才有图时重检 + 重挂一次（图回归，graph-return.ts）。相位从 servers 的
   * 渲染期镜像读取，门带绝对上限，来源被移除即放弃。
   */
  const serversPhaseRef = useRef<Record<string, string | undefined>>({})
  const waitForServing = useCallback(async (instanceId: string): Promise<boolean> => {
    // 终态宽限：用户点来源时 App 会先触发一次即时重连，相位要一两个 tick 才翻到 connecting——
    // 终态必须**持续**一段时间才判"不可服务"，否则会把正在恢复的来源误报成未连接。
    let terminalSince: number | null = null
    // The wait is the shared primitive; the bound is a WALL-CLOCK budget (`now`), because counting
    // TICKS would let a delayed event loop overrun the boot budget. Gate judged first, bound second.
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
        // 相位感知：`error`（快速重试耗尽）与 idle（手动断开）不烧满整个 boot 预算；
        // `connecting`/`degraded`（恢复中）继续在预算内等。判定是纯逻辑，本处只接线。
        const decision = decideServingGate({ phase, nowMs: Date.now(), terminalSinceMs: terminalSince })
        if (decision.action === 'serve') { verdict = true; return true }
        if (decision.action === 'unavailable') { verdict = false; return true }
        terminalSince = decision.terminalSinceMs
        return false
      },
    })
    return outcome === 'expired' ? false : verdict === true
  }, [])
  // The once-per-ready-epoch self-heal mark, projected from the SAME container: the scheduler's
  // clear (`[id] = false`) translates to the container's `retryForgotten`, so it has one owner.
  const degradedRetriedRef = useDegradedRetriedView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })
  const [retryTokens, setRetryTokens] = useState<Record<string, number>>({})
  // 每实例 workspace/session 聚合（已挂载 ctx 推送 + 未挂载 unary 兜底；控制面不持有会话事实）
  const [aggregates, setAggregates] = useState<Record<string, InstanceAggregate>>({})
  // Complete snapshots reported by mounted ctx stores. A source appears here only while both
  // reconnect baselines are idle + ready; loading/error withdraws ownership so an identical
  // recovered baseline is re-published. Complete sources need no periodic unary aggregation.
  // mounted 表单一权威：host/mounted-sources-store.ts（渲染值与事件侧同步读同一份）。
  const [mountedSources] = useState(createMountedSourcesStore)
  const snapshotSources = useSyncExternalStore(mountedSources.subscribe, mountedSources.getSnapshot, mountedSources.getSnapshot)
  // 完成点修正臂（唯一 App 侧状态）：官方位走通道行；这里放有壳 current 行 ∪ 无壳（facts-only provenance）逐行边沿的补臂（design 06 §4.2）。
  const [completedStore] = useState(createCompletedStore)
  const correctionArms = useSyncExternalStore(completedStore.subscribe, completedStore.getSnapshot, completedStore.getSnapshot)
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
    refreshHintAt: refreshHintAtRef,
    factsPullInFlight: factsPullInFlightRef,
  } = sourceLedger
  // Synchronous connection-generation edge memory: a mounted producer may suppress an identical
  // post-reconnect snapshot while the App already replaced its aggregate with not-connected; one
  // authoritative pull on each not-ready → ready edge closes that gap without restoring periodic RPCs.
  const readyAggregateSourcesRef = useRef<Set<string>>(new Set())
  // Unary aggregate pulls and bounded retries use latest-owner object tokens; the table is
  // active-only, so a later same-id pull receives a never-reused object.
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
  // 回声账本（placement/removal/workspace/session/archive）合并为单一 store：渲染快照与事件侧
  // 同步读是同一份（见 host/echo-store.ts），没有 state+ref 镜像与双写回调。
  const [echoStore] = useState(createEchoStore)
  const echoes = useSyncExternalStore(echoStore.subscribe, echoStore.getSnapshot, echoStore.getSnapshot)
  const {
    updatePlacement,
    updateRemoval,
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
  /** Expire echoes past their TTL on the 30s unary fallback clock (this callback's ONLY caller): an
   * echo whose convergence never arrives has no other clock here; the create/removal/push clocks
   * sweep inline in use-bridge-subscriptions.ts. Identity preserving. */
  const sweepWorkspaceEcho = useCallback((): void => {
    updateWorkspaceEcho(sweepPendingWorkspaces(echoStore.getSnapshot().workspace, Date.now()))
    // 位置意图用同一批时钟（同一 TTL 语义）：创建/推送/兜底拉取都可能让它退休。
    updatePlacement(sweepPendingPlacements(echoStore.getSnapshot().placement, Date.now()))
    // 删除意图同理（时钟：删除意图事实、挂载 push 的收敛、这条兜底；成功事实刻意不撤，失败事实按 id 撤下）。
    updateRemoval(sweepPendingRemovals(echoStore.getSnapshot().removal, Date.now()))
  }, [updatePlacement, updateRemoval, updateWorkspaceEcho, echoStore])
  /**
   * Session-echo TTL tick (three clocks: the create fact, the authoritative push, the 30s unary
   * fallback — the workspace echo adds the removal fact and therefore sweeps on four). The TTL is a leak guard, not
   * a convergence budget: a create whose convergence never arrives must still expire.
   */
  const sweepSessionEcho = useCallback((): void => {
    updateSessionEcho(sweepPendingSessions(echoStore.getSnapshot().session, Date.now()))
  }, [updateSessionEcho, echoStore])
  /** Lease-expiry tick for the local archive tombstones (the fallback pull clock, plus the archive fact tick). */
  const sweepSessionArchive = useCallback((): void => {
    updateSessionArchive(sweepPendingArchives(echoStore.getSnapshot().archive, Date.now()))
  }, [updateSessionArchive, echoStore])
  // 会话打开意图：App 是唯一写者（openSession 的 arm/release），槽位是 sidebar 包的跨 ctx 单例
  // （boot 期早开臂要在**目标实例自己的 ctx 内**读它）。经 useSyncExternalStore 绑定：快照在无变化
  // 时保持同一引用，一次 arm / 一次 release 各触发一次重渲染，投影门与揭示门同时生效。
  const openIntents = useSyncExternalStore(subscribeOpenIntent, getOpenIntentsSnapshot)
  // 每实例运行时事实 + 每来源 facts 快照合并为一个 store（host/facts-store.ts）：
  // 渲染快照与事件回调的同步读是同一份，没有 ref 渲染期镜像。
  const [factsStore] = useState(createFactsStore)
  const facts = useSyncExternalStore(factsStore.subscribe, factsStore.getSnapshot, factsStore.getSnapshot)
  const runtimeFacts = facts.runtime
  const [hostFacts, setHostFacts] = useState<Record<string, HostFacts | undefined>>({})
  // gateway 来源的托管 dsh connectionState（managed-runtime.ts）。null = 探不到（fail open），键随来源生命周期收敛。
  // 托管 dsh 探针簇（状态 + 15s 前台探针 + 退役收敛）在 host/use-managed-runtime.ts。
  const { managedRuntime, probeRef: probeManagedRuntimeRef, retireManagedRuntime } = useManagedRuntime(remoteInstances)
  // 完成未读的唯一权威是官方 uiSession.sessionStatus.completionUnread（vendor 内存 Set，
  // 经 sidebar 生产者进通道行 completed）。App 只补一条 N-ctx 修正臂（client-core
  // completion-arm.ts）：有壳隐藏来源的 current 行 ∪ 无壳 facts-only 来源的逐行 host
  // 运行边沿（design 06 §4.1/§4.2、design 19 §3.2）；纯内存、不落盘、无水位、无播种。
  // Desktop-observed stall evidence: the shell's frame/input probe pushes strike
  // counters; the page registry feeds the delivery owner the same evidence.
  useEffect(() => {
    const unsubscribeStall = window.dshChamber?.rendererStall?.onEvidence(observation => {
      publishRendererStallObservation(observation)
    })
    return () => { unsubscribeStall?.() }
  }, [])
  // 通知引导簇（持久存储 / complete 账本 / native outbox）：实现在
  // app-hooks/use-notification-boot.ts，调用次序与一次性初始化语义不变。
  const {
    notificationsBoot, notificationStorageRef, completeLedgerRef, notificationOutboxRef,
  } = useNotificationBoot()


  /** 每来源 facts 快照（判定输入：completedAt/updatedAt/lastTurnEnd/pendingKind）。 */
  const sessionFacts = facts.session
  /** 活跃事实源实例（gateway 来源；指纹变化 = 新化身重探）。 */
  const sessionFactsSourcesRef = useRef<Map<string, SessionFactsSource>>(new Map())
  /** 每个实例的退订 + stop 合成器（来源退役/降级时调用一次）。 */
  const sessionFactsTeardownRef = useRef<Map<string, () => void>>(new Map())
  // 非 gateway 来源的无壳观察者（SSH/dsh 远端没有只读镜像可依赖）。
  const sourceMuxTeardownRef = useRef<Map<string, () => void>>(new Map())
  // 观察者必须按**身份**（sourceId + sourceFingerprint）收敛——只按 id 去重会让「同 id 新指纹」复用旧观察者，rows/runningBefore 跨化身串味。
  const sourceMuxIdentityRef = useRef<Map<string, string>>(new Map())
  /**
   * 完成观测状态（v5 §3.2，每来源一份）：壳边沿位、facts 水位、
   * baseline/shellSeeded/factsSeeded 播种位。与 prevRunningRef（蓝点机）并存互不耦合：
   * 蓝点带「正在阅读」解除，通知收敛不受解除影响；随来源生命周期收敛（撤回/退役/剪枝与
   * prevRunningRef 同纪律）。
   */
  const completionObservationRef = useRef<Map<string, SourceObservationState>>(new Map())
  /** 通知落盘节流（≤1 次/秒；immediate 走微任务合并，pagehide/hidden/unmount 同步 flush）。 */
  const notificationSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushNotificationsRef = useRef<() => void>(() => undefined)
  /**
   * 落盘调度（≤1 次/秒节流）的 ref 镜像：早期 effect（来源剪枝 / 退役）在 useNotifications
   * 返回 schedulePersistNotifications 之前声明，靠这个 ref 在运行期拿到稳定实现。
   * durable 三表被 prune/forget 改动却漏落盘，重启后会用磁盘上的旧表复活已退役来源的判定。
   */
  const schedulePersistNotificationsRef = useRef<() => void>(() => undefined)

  // 投影输入（归档筛选）→ 派生 servers → chamberBridge 发布：实现在
  // app-hooks/use-projection-publish.ts（输入类型取自 deriveServers 本身）。
  const { servers } = useProjectionPublish({
    health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts,
    correctionArms, paintedView, pluginDiagnostics, shellStates, managedRuntime, echoes,
    openIntents, locale, sessionFacts,
  })

  // 就绪门相位镜像（waitForServing 读它；语义见 app-hooks/use-serving-gate-phases.ts）。
  useServingGatePhases({ servers, remoteStatus, serversPhaseRef })

  /**
   * boot 推迟集合：**手动断开**（idle）的来源不启动 shell——一次注定吃满 503 预算的 boot 只会
   * 白烧。遮罩此时呈现「未连接」+「连接」，点连接后相位离开 idle，正常 boot 开始；未知相位
   * （投影未到）不推迟。本判定是渲染期事实（`servers`），不用 ref 镜像。
   */
  const deferredBootIds = useMemo(() => {
    const ids = new Set<string>()
    for (const server of servers) {
      if (server.id === LOCAL_INSTANCE_ID) continue
      // 事实源必须是**原始 transport 投影**（remoteStatus 以 raw id 为键）：折叠值不是手动断开
      // 事实，拿它当输入会把一次投影延迟/状态拉取失败变成"拒绝 boot"，而纯契约要求 undefined 绝不推迟。
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

  // 两条「来源 ready 后重挂该实例」的政策（降级自愈 + 图回归）在 use-shell-retry.ts：容器仍是
  // 降级自愈的唯一判定者，本处只传状态容器与 App 唯一的重挂 sink（retryTokens）。
  useShellRetry({ servers, shellStates, pluginDiagnostics, dispatchLifecycle, setRetryTokens })


  // 托管 dsh 探针 effect（15s/仅前台/单飞+超时/退役收敛）见
  // host/use-managed-runtime.ts；probeManagedRuntimeRef 由该 hook 返回。
  // 注册表 id 的命令式权威集合：selectView 与 openSession 在 apply 时用它拒绝已回收来源
  // （视图生命周期 = 注册表条目生命周期）。这不是 render mirror：事件侧的 invalidate/success
  // 边沿不得被并发/陈旧渲染覆盖；refreshRemotes 在世代成功时同步替换它，local 恒权威。
  const liveServerIdsRef = useRef<Set<string>>(new Set([LOCAL_INSTANCE_ID]))
  const liveServerIds = useMemo(() => new Set(servers.map(server => server.id)), [servers])

  // 隧道相位与实例表（按原始注册表 id 键控，onStatusChanged 推送的 payload.id）：
  // ensureRemoteConnected 经 remotesStore.getSnapshot() 读最新相位而不进依赖——
  // selectView/openSession 的身份保持稳定，相位变化不重建这些回调。

  // pendingViewRef = 在途/顺延中的最新切换意图（过渡链 apply 前有效）。
  // selectView 的早期返回必须查已落地的 active（store 快照，永远最新）而非闭包：
  // 过渡在途时 UI 仍显示旧视图，用闭包里的 activeView 会把「切回旧视图」的撤销
  // 意图误判为无操作丢弃——违反 view-transition.ts 的「最后一次意图胜出」性质。
  /** 揭示门的持有窗起点（单调钟 ms；null = 当前稳态）：一次在途揭示从分叉那一拍起算，
   *  回到稳态即清空（见 reveal-gate.ts）。 */
  const revealHoldStartedAtRef = useRef<number | null>(null)
  /** 持有窗到期的一次性重算触发器（照 InstanceView 的 surfaceFallbackTick 形态）。 */
  const [revealTick, setRevealTick] = useState(0)
  const pendingViewRef = useRef<string | null>(null)
  /**
   * 用户在遮罩上显式放弃的视图：只由遮罩的「切换来源」写入，由 `selectView`（用户又点回 =
   * 撤回意图）或落地回收删除。记目标是为了在"切换没落地"（目标退役/被删）时撤回标记。
   * A Map LEDGER view: reads project the container, set/delete become events; sweeps snapshot.
   */
  const abandonedViewsRef = useAbandonedViewsView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })

  /**
   * N-ctx 视图回收：视图生命周期 = 注册表条目生命周期。只有来源从注册表删除时才卸载视图并 dispose
   * shell——连接失败/手动断开是瞬时事实，不回收视图，否则设置页卡片与侧边栏分组会随瞬时状态消失。
   * local 常驻；被回收的视图若是当前视图则回落 local。identity-preserving：无变化时两个 setter 都返回原值。
   */
  useEffect(() => {
    const live = new Set(servers.map(server => server.id))
    // dispose 是副作用，不能放进 setState updater（渲染期可能急切求值，StrictMode 还会双调用）——先从当前 mountedViews 算出被回收的 id 再统一处置。
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
      // 视图已回收：失败覆盖层状态与重试令牌随视图收敛（重加同名 id 由新 boot 重建）。
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
    // 注册表删除的实例同时清掉数据面残留（聚合/运行时事实/状态投影）：键空间随注册表收敛；全部走 source-registry.ts 内核。
    setAggregates(prev => pruneSourceRecord(prev, live) ?? prev)
    factsStore.setRuntime(prev => pruneSourceRecord(prev, live) ?? prev)
    // 每来源账本一次收敛（字段表在 host/source-ledger.ts）；mounted 表由 store
    // 自洁，其 dropped ids 承接 snapshotAt 的 lockstep：same-id 重加必须从
    // 「从未推送」开始（首启窗口回退），不得继承被删来源的最后推送时刻。
    for (const id of mountedSources.prune(live)) delete snapshotAtRef.current[id]
    setUnverified(prev => pruneSourceList(prev, live) ?? prev)
    // 用户忽略（dismiss）也随来源退役：否则 same-id 再挂载的新代际会在下一个 liveness tick 前被旧忽略静默压住。
    setDismissedStalls(prev => pruneSourceList(prev, live) ?? prev)

    setPluginDiagnostics(prev => pruneSourceRecord(prev, live) ?? prev)
    // 完成观测状态同款收敛（v5 §3.2）：与 prevRunningRef 对称，重加同名 id 由刷新重建
    // （freshState 播种）。观测状态删除 = 该来源观测代终结：账本里的旧代易失轨
    // （armed/armedFloor/settleFence/goalKnown）与 pending 必须同拍 scoped withdraw——门关窗口
    // （未结算/degraded/rosterIncomplete）下 durable 剪枝不执行，残留旧 pending 会被重建的新代
    // 首个 outcome 以旧 watermark flush。notified/outcomes 保持 durable；pending 有内容时落盘。
    for (const sourceId of [...completionObservationRef.current.keys()]) {
      if (live.has(sourceId)) continue
      completionObservationRef.current.delete(sourceId)
      if (withdrawObservationState(completeLedgerRef.current, sourceId)) {
        schedulePersistNotificationsRef.current()
      }
    }
    // ── durable（旧载荷载入）四类剪枝：权威 roster / 无桥形态门控（F6+F11） ────
    // complete 通知账本的 notified/pending/outcomes 在 App 首帧
    // **同步**载入，而权威远端 roster 是异步事实（桥探测 + IPC 往返）：未结算前按 live={local}
    // 剪枝会把远端来源的 durable 键当退役来源写盘删除。只放行结算后（或确认无桥）的剪枝；
    // 有桥但未结算严格关门。易失轨（prevRunning / 观测状态 / 水位记账）不受此门约束。
    if (durableUnreadPruneAllowed(rosterGate.isSettled(), bridgeVerdict, registryDegraded, rosterIncomplete)) {
      completedStore.prune(live)
      // 剪掉的 durable 表项必须落盘（否则重启后旧判决复活）。
      if (completeLedgerRef.current.prune(live)) schedulePersistNotificationsRef.current()
      // native 投递 journal 的退役来源同拍收敛（durable，与账本同受本门约束）。
      notificationOutboxRef.current.pruneSources(live)
      // 每来源账本一次收敛（字段表在 host/source-ledger.ts）：易失字段随同一次 prune 收敛。
      pruneSourceLedger(sourceLedger, live)
      // facts wiring 数据面：退役来源的 facts state 一并清（same-id 重加 = 新来源代）。
      if (pruneSourceRecord(factsStore.getSnapshot().session, live) !== null) {
        factsStore.setSession(prev => pruneSourceRecord(prev, live) ?? prev)
      }
    }
    remotesStore.setStatus(prev => {
      // remoteStatus 按原始注册表 id 键控（deriveServers 的 statusKey），与 servers 的 <kind>-<id> 不同——按 kind 前缀还原再比较。
      const liveRaw = new Set<string>()
      for (const server of servers) {
        const rawId = server.kind === 'local' ? 'local' : rawInstanceIdFromSourceId(server.id)
        if (rawId !== null) liveRaw.add(rawId)
      }
      return pruneSourceRecord(prev, liveRaw) ?? prev
    })
    // roster 结算 / 无桥判定 / 两档否决位任一翻到放行态的那一拍必须重跑本 effect，
    // durable 四类剪枝才按完整 live / 无桥形态收敛（见上方门控注释）。
  }, [servers, mountedViews, roster, bridgeVerdict, registryDegraded, rosterIncomplete])

  // 连接行 / 健康探针 / 单条隧道状态 / roster 失效：实现在 app-hooks/use-remote-refresh.ts。
  const { refreshConnections, refreshHealth, refreshRemoteStatus, invalidateRemoteRoster } = useRemoteRefresh({
    setConnections, setHealth, setHealthError, setHealthErrorAt,
    remotesStore, sourceLifecyclesRef, liveServerIdsRef, rosterGate, remoteRosterRefreshSeqRef,
  })


  /** Synchronously retire every renderer owner of an authoritative lifecycle edge (deletion or
   *  transport-identity edit), event-side on purpose: passive effects may be skipped on a same-id replacement. */
  const retireSources = useCallback((sourceIds: ReadonlySet<string>): void => {
    const retired = new Set([...sourceIds].filter(sourceId => sourceId !== LOCAL_INSTANCE_ID))
    if (retired.size === 0) return
    sourceLifecyclesRef.current!.retire(retired, { evict: true })
    // A retired source's generation leaves the registry with it, so a same-id re-add starts from a clean epoch.
    const liveSourceIds = new Set(
      Object.keys(sourceLedgerStoreRef.current).filter((sourceId) => !retired.has(sourceId)),
    )
    sourceLedgerStoreRef.current = retainSourceIds(sourceLedgerStoreRef.current, liveSourceIds)
    aggregateRequestOwnersRef.current!.retire(retired)
    for (const sourceId of retired) {
      delete aggregatePollSeqRef.current[sourceId]
      delete mutationRefreshSeqRef.current[sourceId]
      // Last-reconnect recency retires with the source (same-id re-add starts a fresh backoff window).
      delete lastReconnectAtRef.current[sourceId]
    }

    // Force the supplied authoritative delta through the aggregate generation transition even when
    // a newer roster snapshot already contains the same id: the exact two-pull remove/re-add race.
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
    // Event authority is immediate: delayed view/deep-link callbacks must see the source absent before the replacement resolves.
    liveServerIdsRef.current = nextLive

    // Record shell.ts's async teardown barrier before any replacement mount. Identity edits reach
    // this path even though the registry id remains present; label/service/home-only edits do not.
    for (const sourceId of retired) {
      clearAggregateRetry(sourceId)
      aggregateRefreshQueueRef.current.delete([sourceId])
      autoPrewarmedRef.current.delete(sourceId)
      // 保留策略：注册表删除的源不占用"回收后不自动预热"键（ref 键空间随生命周期收敛）。
      prewarmSuppressedRef.current.delete(sourceId)
      // 收割账本/意图随来源生命周期收敛（同 id 重新注册 = 新来源代）。
      delete harvestStateRef.current[sourceId]
      harvestIntentRef.current.delete(sourceId)
      chamberBridge.retireInstanceProducers(sourceId)
      disposeInstanceShell(sourceId)
      releaseInstanceClient(sourceId)
      chamberBridge.clearPluginDiagnostic(sourceId)
      delete prevRunningRef.current[sourceId]
      completionObservationRef.current.delete(sourceId)
      // 退役 = 四表同拍删除；durable 三表（notified/pending/outcomes）有内容时必须落盘
      // （易失轨不入盘）。先查再删，避免给空账本白排一次写。
      const ledger = completeLedgerRef.current
      const ledgerHadDurable = ledger.notifiedTable()[sourceId] !== undefined
        || ledger.pendingTable()[sourceId] !== undefined
        || ledger.outcomesTable()[sourceId] !== undefined
      ledger.forget(sourceId)
      if (ledgerHadDurable) schedulePersistNotificationsRef.current()
      // native 投递 journal 中该来源的未完成条目同拍退役（durable；重加 = 新来源代）。
      notificationOutboxRef.current.forgetSource(sourceId)
      // facts wiring：事实源实例与完成点/通知数据面键随退役同拍收敛（reclaimView 刻意不碰——拆壳不等于来源消失）。
      sessionFactsTeardownRef.current.get(sourceId)?.()
      sessionFactsTeardownRef.current.delete(sourceId)
      sessionFactsSourcesRef.current.delete(sourceId)
      // 无壳观察者与身份记录同样随退役收敛（只拆 gateway 事实源会留下孤观察者）。
      sourceMuxTeardownRef.current.get(sourceId)?.()
      sourceMuxTeardownRef.current.delete(sourceId)
      sourceMuxIdentityRef.current.delete(sourceId)
      delete refreshHintAtRef.current[sourceId]
      delete factsPullInFlightRef.current[sourceId]
    }
    // 工作区创建回声账本随来源生命周期收敛：同 id 重新注册 = 新来源代，上一代的回声不得残留成幽灵行。
    updateWorkspaceEcho(forgetPendingWorkspaces(echoStore.getSnapshot().workspace, retired))
    // 位置意图同纪律：上一代的意图不得在新来源代的列表里搬动行。
    updatePlacement(forgetPendingPlacements(echoStore.getSnapshot().placement, retired))
    // 删除意图同纪律：上一代的删除不得在新来源代的列表里摘掉同 id 的行。
    updateRemoval(forgetPendingRemovals(echoStore.getSnapshot().removal, retired))
    // 会话创建回声同纪律：上一代记账的会话不得在新来源代的列表里幽灵复现。
    updateSessionEcho(forgetPendingSessions(echoStore.getSnapshot().session, retired))
    // 归档墓碑同纪律：新一代来源必须是干净的（旧代的本地归档不得藏住新代的会话）。
    updateSessionArchive(forgetPendingArchives(echoStore.getSnapshot().archive, retired))
    // 打开意图同纪律：被删除来源的在途意图必须撤掉，否则新一代会在投影门/揭示门上被上一代的 open 永久压住。
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
    // 屏上视图随注册表退役**同帧**回落 local（揭示门的 unmountable 分支是第二道保险）。
    // 回落 local 而不是 selected：选择可能是同一来源、也可能尚未 settle，直接画上去会露出 pending 壳。
    prewarmQueueRef.current = withoutRemovedSourceIds(prewarmQueueRef.current, retired)
    prewarmEligibleRef.current = new Set(
      [...prewarmEligibleRef.current].filter(sourceId => !retired.has(sourceId)),
    )
    if (prewarmInflightRef.current !== null && retired.has(prewarmInflightRef.current)) {
      // 在途预热随来源退役作废（还没被任何人用上）。
      recordPrewarm('cancelled', prewarmInflightRef.current)
      prewarmInflightRef.current = null
    }

    // Queue every React owner deletion before any roster render; a replacement id only returns through a fresh view mount.
    setMountedViews(prev => withoutRemovedSourceIds(prev, retired))
    viewStore.retire(retired, LOCAL_INSTANCE_ID)
    setShellStates(prev => withoutRemovedSourceKeys(prev, retired))
    setRetryTokens(prev => withoutRemovedSourceKeys(prev, retired))
    setAggregates(prev => withoutRemovedSourceKeys(prev, retired))
    mountedSources.retire(retired)
    factsStore.setRuntime(prev => withoutRemovedSourceKeys(prev, retired))
    setPluginDiagnostics(prev => withoutRemovedSourceKeys(prev, retired))
    // 托管 dsh 状态同源收敛：轮询 effect 的 roster 差分是异步的，同 id 重新注册在那一拍前会读到上一代状态。
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

  /** F16/A4 健康探针不可用的 warn-once（按诊断文案去重）：缺失/抛错都不是「健康」，
   *  refreshRemotes 保持 fail-closed（不安装 roster、不置结算位）。 */
  const warnHealthProbeUnavailable = useCallback((kind: HealthProbeUnavailableKind): void => {
    const diagnostic = healthProbeUnavailableDiagnostic(kind)
    if (healthUnavailableWarnedRef.current === diagnostic) return
    healthUnavailableWarnedRef.current = diagnostic
    console.warn(`[renderer] ${diagnostic}; the remote roster is NOT installed or settled (fail-closed)`)
  }, [])

  const refreshRemotes = useCallback(async (): Promise<boolean> => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) {
      // 无桥形态的收敛不在这里放行：本分支可能被可见性补偿在**桥迟到窗口**内提前调用
      // （desktopSsh 尚未 expose ≠ 无桥），置结算位会把远端 durable 键当退役来源剪掉。
      // 无桥收敛由 500ms 探测预算得出的 bridgeVerdict='absent' 在 durable 剪枝门完成；
      // 本函数保持「有桥才拉取」语义。
      return false
    }
    const seq = remoteRosterRefreshSeqRef.current + 1
    remoteRosterRefreshSeqRef.current = seq
    // F16/A4：健康探针不可用 ≠ 健康。旧桥/旧 shim 没有 desktopSsh.instances_health，探针
    // invoke 也可能抛错（IPC/sidecar 不可达）。两种形态都保持 fail-closed（不安装 roster、
    // 不置结算位），warn-once 明确 'health unavailable'，绝不静默折叠成健康。
    if (typeof ssh.instances_health !== 'function') {
      warnHealthProbeUnavailable('missing-method')
      return false
    }
    let health: SshInstancesHealthProbe
    try {
      health = await ssh.instances_health() as SshInstancesHealthProbe
    } catch {
      warnHealthProbeUnavailable('invoke-failed')
      return false
    }
    if (remoteRosterRefreshSeqRef.current !== seq) return false
    try {
      // 注册表健康位先于 roster 读取（F13）：加载降级时空 roster 不是权威——不安装、不结算
      // （保持「有桥但未结算」，剪枝门恒关），warn 一次；健康恢复后走原有结算路径。
      if (health.degraded === true) {
        const reason = health.reason ?? 'registry load failed'
        if (registryDegradedWarnedRef.current !== reason) {
          registryDegradedWarnedRef.current = reason
          console.warn(
            `[renderer] SSH instance registry is degraded (${reason}); the empty roster is NOT authoritative — durable notification state is retained until the registry is rebuilt`,
          )
        }
        setRegistryDegraded(true)
        return false
      }
      setRegistryDegraded(false)
      // V5-A 行级丢弃：load 成功但 drop 了行时磁盘有内容而 roster 只是子集。合法行**照常安装
      // 并结算**（连接不能不可见），但 durable 剪枝门由 rosterIncomplete 关死（与 degraded 同档）。
      const incomplete = health.rosterIncomplete === true
      if (incomplete) {
        const diagnostic = rosterIncompleteDiagnostic(health.droppedCount ?? 0)
        if (rosterIncompleteWarnedRef.current !== diagnostic) {
          rosterIncompleteWarnedRef.current = diagnostic
          console.warn(
            `[renderer] SSH instance registry roster is incomplete (${diagnostic}); valid rows are installed but durable notification state is retained until the roster is complete`,
          )
        }
      }
      setRosterIncomplete(incomplete)
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
      // The authoritative roster is the one place a fingerprint change is observed: registering it here turns a re-registration into an epoch bump.
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
      // 桌面 SSH 面不可达时保持现状；首次权威结果前 settled 仍为 false，deep-link intent 继续 held，由快速重试/30s 轮询再拉。
      return false
    }
  }, [refreshRemoteStatus, retireSources, warnHealthProbeUnavailable])

  /**
   * 聚合刷新簇（unary 快照拉取 / 有界刷新波 / 边沿轮询 / 陈旧 watchdog + 会话权威升级
   * ladder）是命名 hook（use-aggregate-refresh.ts）；App 只注入状态容器与常量，取回调用面接线。
   */
  const aggregatePollRunningRef = useRef(false)
  const {
    refreshAggregate, refreshAggregateRef, pollAggregatesRef, runStalenessWatchdogRef, stalledSources, dismissedStalls, setDismissedStalls, unverifiedSources, setUnverified, unverifiedSourcesRef, watchdogAggregatesRef, withdrawSourceRef,
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
  // 前台恢复补偿：hidden → visible 立即推进一轮聚合 watchdog（隐藏期暂停的 30s 兜底/stale 拉取
  // 在此收敛，含已回收源）、空闲预热队列与保留回收检查，以及两条 30s 兜底轮询（连接行/注册表）；
  // 目标都是 ref 镜像的最新闭包。
  const refreshConnectionsRef = useRef(refreshConnections)
  const refreshRemotesRef = useRef(refreshRemotes)
  useEffect(() => {
    refreshConnectionsRef.current = refreshConnections
    refreshRemotesRef.current = refreshRemotes
  })

  useEffect(() => () => {
    for (const timer of aggregateRetryTimersRef.current.values()) clearTimeout(timer)
    aggregateRetryTimersRef.current.clear()
  }, [])

  // perf 埋点（User Timing；标记注册表见 perf-marks.ts）：页面壳挂载与本地实例 ready 首达；
  // settle/boot-failed 由 shell.ts 统一打点，本组件不重复。
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

  // 宿主健康流 + 连接行/注册表低频轮询：实现在 app-hooks/use-host-health-stream.ts。
  useHostHealthStream({
    refreshHealth, refreshConnections, refreshRemotes, pollAggregatesRef,
    setHealth, setHealthError, setHealthErrorAt, rosterGate, disposeAllShells,
  })

  /**
   * 桌面桥订阅：preload 经异步 info 往返后才暴露 window.dshChamber，桥可能在挂载 effect 之后
   * 才出现——一次性订阅会静默丢失状态/注册表推送（退化为 30s 轮询自愈）。探测 effect 在
   * app-hooks/use-ssh-bridge-probe.ts：500ms 直到预算耗尽，之后 30s 长尾；桥出现即装载 roster
   * 并订阅 onStatusChanged / onInstancesChanged，卸载时退订。
   */
  const [sshBridgeReady, setSshBridgeReady] = useState(false)
  useSshBridgeProbe({
    ready: sshBridgeReady, setReady: setSshBridgeReady, setVerdict: setBridgeVerdict,
  })

  // 首次权威 roster 获取的有界重试：实现在 app-hooks/use-roster-acquisition.ts（依赖显式入参）。
  useRosterAcquisition({ sshBridgeReady, rosterGate, refreshRemotes, roster })

  useEffect(() => {
    if (!sshBridgeReady) return
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const unsubscribe = ssh.onStatusChanged((payload) => {
      // A removed transport may emit one final phase while main tears it down; the delta already
      // retired this incarnation, and a real re-add supplies the replacement's first projection.
      const sourceId = sourceIdForRawInstance(payload.id, remotesStore.getSnapshot().instances)
      if (sourceId === null
        || sourceIdForTransport(payload.status.kind, payload.id) !== sourceId
        || !liveServerIdsRef.current.has(sourceId)) return
      remotesStore.setStatus(prev => ({ ...prev, [payload.id]: payload.status }))
    })
    // 注册表变更推送：设置页增/删/改实例即时重拉 roster（自动连接新 id、回收已删视图），不等 30s 轮询。
    const refreshAuthoritativeRoster = (): void => {
      invalidateRemoteRoster()
      void refreshRemotes()
    }
    // Listener-before-snapshot closes the bridge-hydration lost-update window: a registry mutation
    // cannot land between a successful initial instances_get and the onInstancesChanged subscription.
    const unsubscribeInstances = subscribeRosterBeforeRefresh(
      listener => ssh.onInstancesChanged(({ retiredIds }) => {
        // The trusted desktop delta is the only observation that survives two overlapping pulls both
        // seeing the final same-id re-add; retirement must precede invalidating/refreshing the roster.
        retireSources(remoteRetiredSourceIds(retiredIds))
        listener()
      }),
      refreshAuthoritativeRoster,
    )
    rosterGate.setListenerReady(true)
    // OS 唤醒分发：主进程 push system-resume → 本页面所有 dsh 前端连接（N-ctx 单页共享 window）
    // 立即重连——dsh-client-connection 的补丁监听该 window 事件。事件名以该包的共享常量
    // `SYSTEM_RESUME_EVENT`（值为 'dsh-chamber:system-resume'）为唯一权威，本处字面量必须与之一致
    // （tsconfig 无法解析该包深路径导出，故用字面量 + 此注释锁定同步）。桥与 desktopSsh 同一批 expose。
    const unsubscribeResume = window.dshChamber?.systemResume?.onResume(() => {
      window.dispatchEvent(new Event('dsh-chamber:system-resume'))
    })
    // Browser online is the only network-change signal available to the page in
    // all flavors. It re-verifies READY remote transports (not just page sockets),
    // closing the ready-but-half-open gap after Wi-Fi/cellular switches.
    const reverifyOnOnline = (): void => {
      const ssh = window.dshChamber?.desktopSsh
      if (ssh === undefined) return
      for (const instance of remotesStore.getSnapshot().instances) {
        void ssh.reverify(instance.id, 'online').catch(() => {
          // A reverify is best-effort; a closed window/IPC race must not surface
          // as an unhandled rejection on the online event.
        })
      }
    }
    window.addEventListener('online', reverifyOnOnline)
    // 通知点击打开：主进程推送 notification-open → openSession（切 shell → ensureRemoteConnected →
    // openInstanceSession）。桥与 desktopSsh 同一批 expose，存在则 notifications 必存在。
    // 监听注册后立即发就绪信号：主进程只在就绪后放行推送（did-finish-load 早于本监听注册，事件不能丢）。
    const notifications = window.dshChamber?.notifications
    const unsubscribeNotifications = notifications?.onOpen((open) => {
      const { sourceId } = open
      const classification = classifyRosterGatedSource(
        sourceId,
        rosterGate.isSettled(),
        liveServerIdsRef.current,
      )
      // A successful roster pull updates the imperative authority ref before React commits the replay
      // effect; keep a later remote click behind already-held payloads during that window (local stays immediate).
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
    // Listener-before-ready mirrors the deep-link contract: a transient sender-fence/navigation race
    // must not leave main's click queue held forever, so retry on a small bounded budget and fail loud.
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
    const onSidecarReady = (): void => {
      notificationReadyAttempts = 0
      if (notificationReadyRetryTimer !== null) clearTimeout(notificationReadyRetryTimer)
      notificationReadyRetryTimer = null
      if (unsubscribeNotifications !== undefined) signalNotificationReady()
    }
    window.addEventListener('dsh-chamber:sidecar-ready', onSidecarReady)
    return () => {
      window.removeEventListener('dsh-chamber:sidecar-ready', onSidecarReady)
      rosterGate.setListenerReady(false)
      notificationReadyCancelled = true
      if (notificationReadyRetryTimer !== null) clearTimeout(notificationReadyRetryTimer)
      unsubscribe()
      window.removeEventListener('online', reverifyOnOnline)
      unsubscribeInstances()
      unsubscribeResume?.()
      unsubscribeNotifications?.()
    }
    // openSession 依赖链稳定到 []，enqueueNotificationOpen 仅包装该稳定引用与页面级 serial tail；
    // effect 单次订阅捕获的闭包永不过期。两者声明在其后，不能列入此处立即求值的 deps（TDZ）。
  }, [
    sshBridgeReady,
    acknowledgeNotificationOpen,
    invalidateRemoteRoster,
    refreshRemotes,
    reportNotificationAckFailure,
  ])

  // Page-channel source-link selector: a subscription must not burn its 3/5/10/20/30s
  // ladder while the transport is down; a link epoch clears the ladder and
  // re-subscribes immediately. The actual writer is the desktop status projection.
  const pageChannelLinkListenersRef = useRef(new Set<(sourceId: string) => void>())
  const localLinkEpochRef = useRef(0)
  /** The epoch the page channel was last told about (local source). */
  const localNotifiedEpochRef = useRef(-1)
  const localReadyRef = useRef(false)
  const healthRef = useRef(health)
  useEffect(() => { healthRef.current = health }, [health])
  useEffect(() => {
    const link = {
      ready(sourceId: string): boolean {
        // `rawInstanceIdFromSourceId('local')` is null by contract: check the local
        // id BEFORE the null fallback, or this branch is unreachable and a local
        // dsh restart never parks/releases its page subscriptions.
        // A serving local dsh includes `degraded` (design 02 §3.5); the predicate is the
        // control-plane's table, re-exported by transport-source.ts.
        if (sourceId === LOCAL_INSTANCE_ID) return isServiceableLocalStatus(healthRef.current?.dsh?.status)
        const rawId = rawInstanceIdFromSourceId(sourceId)
        if (rawId === null) return true
        // ONE owner for the projection reading (client-core/link-projection):
        // ready = phase ready && link.state !== 'down' (suspect forwards).
        return linkReady(remotesStore.getSnapshot().status[rawId])
      },
      epoch(sourceId: string): number {
        if (sourceId === LOCAL_INSTANCE_ID) return localLinkEpochRef.current
        const rawId = rawInstanceIdFromSourceId(sourceId)
        if (rawId === null) return 0
        return linkEpochOf(remotesStore.getSnapshot().status[rawId])
      },
      subscribe(listener: (sourceId: string) => void): () => void {
        pageChannelLinkListenersRef.current.add(listener)
        return () => { pageChannelLinkListenersRef.current.delete(listener) }
      },
    }
    configurePageChannelLink(link)
    return () => { configurePageChannelLink(null) }
  }, [])
  // Reference-diff the status map: one instance's health push must reconcile only
  // that source, not every subscription of every source (O(N×S) per push).
  const notifiedStatusRef = useRef<Record<string, unknown>>({})
  // 页面通道链路通知（状态/健康引用差投影）：实现在 app-hooks/use-page-channel-link-notify.ts。
  usePageChannelLinkNotify({
    notifiedStatusRef, remotesStore, pageChannelLinkListenersRef, remoteStatus, health,
    localReadyRef, localLinkEpochRef, localNotifiedEpochRef,
  })

  // 首触连接引导持两个 ref：本地幂等启动（可服务 = ready|degraded，失败不置位、下个轮询重试）
  // 与远程首次 connect 的语义见 app-hooks/use-connection-bootstrap.ts。
  const localBootedRef = useRef(false)
  const knownRemoteIdsRef = useRef<Set<string>>(new Set())
  // 首触连接引导（本地幂等启动 + 远程新实例自动 connect）：实现在 app-hooks/use-connection-bootstrap.ts。
  useConnectionBootstrap({ connections, remoteInstances, localBootedRef, knownRemoteIdsRef })

  /**
   * 用户意图即时重连：点击/打开一个远程来源 = 「现在就想要这个 server」。侧边栏点击来源头只做视图切换，
   * 从不触发隧道 connect——error/degraded 的来源需要点击立刻再试，不等慢速重探周期。idle（手动断开）
   * 绝不触碰；requiresUserAction 终态同样放行。connect 对 connecting/ready 幂等，重复点击无副作用。
   */
  // 视图选择/重试/遮罩切换：实现在 app-hooks/use-view-selection.ts（依赖全部显式入参）。
  const {
    ensureRemoteConnected, retryView, selectView, switchSourceFromVeil, connectSourceFromVeil,
  } = useViewSelection({
    remotesStore, viewStore, liveServerIdsRef, abandonedViewsRef, autoPrewarmedRef,
    prewarmSuppressedRef, harvestStateRef, harvestIntentRef, pendingViewRef, setMountedViews, setRetryTokens,
    recordPrewarm, harvestSatisfied, captureSidebarScrollAnchor, restoreSidebarScroll,
  })


  // 冷启动 deep-link 的一次性重放：实现在 app-hooks/use-deep-link-delivery.ts（依赖显式入参）。
  useDeepLinkDelivery({
    rosterGate, pendingDeepLinkDeliveryRef, remotesStore, liveServerIdsRef, sourceLifecyclesRef,
    selectView, acknowledgeDeepLink, reportDeepLinkAckFailure, roster, liveServerIds,
  })

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
    for (const instance of remoteInstances) {
      // 空 label 不写映射：渲染/通知标题的 `?? id` 回退依赖映射缺席。
      if (instance.label !== '') map[sourceIdForInstance(instance)] = instance.label
    }
    return map
  }, [connections, remoteInstances])

  /** 通知簇（完成观测 / 完成账本 / native 投递 / 预读点消解）是命名 hook；App 只注入状态容器与回调。 */
  const {
    schedulePersistNotifications, stepCompletionArmFor, emitSessionNotification,
    persistCompletionLedger, guardStep, withdrawSource, applySessionFacts, notificationImmediateSave,
  } = useNotifications({
    aggregates, serverLabels, viewStore, liveServerIdsRef, factsStore, sourceLifecyclesRef,
    openIntents, prevRunningRef, completedStore, completeLedgerRef, notificationOutboxRef,
    completionObservationRef, notificationStorageRef, notificationSaveTimerRef,
    flushNotificationsRef, bootToken: notificationsBoot.boot.token, bootVerdict: notificationsBoot.boot.verdict,
  })

  // 聚合簇的撤回入口回填（该 hook 先于 useNotifications 调用，只能走 ref）：notReady 分支
  // 用它同拍撤回归档/观测轨与边沿记忆，否则断连窗口会把旧壳记忆当虚拟证据（INV-7）。
  withdrawSourceRef.current = withdrawSource

  // 事实源生命周期簇：gateway 只读事实源与无壳观察者的创建/收敛/退订、
  // pagehide/hidden 落盘 flush（无返回值；调用面全在既有 ref/回调上）。
  useSessionFactsLifecycle({
    servers, applySessionFacts, notificationImmediateSave,
    unverifiedSourcesRef, factsPullInFlightRef, refreshHintAtRef, refreshAggregateRef,
    mountedSources, factsStore, sessionFactsSourcesRef, sessionFactsTeardownRef,
    sourceMuxTeardownRef, sourceMuxIdentityRef, withdrawSource,
  })

  // 落盘节流的 ref 镜像：来源剪枝/退役的早期 effect 在 hook 返回之前声明，靠它拿到稳定实现。
  schedulePersistNotificationsRef.current = schedulePersistNotifications
  const localSettledRef = useRef(false)
  const prewarmQueueRef = useRef<string[]>([])
  const prewarmInflightRef = useRef<string | null>(null)
  // 每个挂载视图的挂载时刻：绝对放弃上限按**视图**判定，不能只看预热在途（用户点开/深链挂载的壳同样可能挂死）。
  const viewBootStartedAtRef = useRef<Record<string, number>>({})

  /**
   * 意图预热的 App 侧账本。hover 意图的**唯一**作用是"该来源优先"：把 id 提前到既有队列头，让
   * pickPrewarmTarget 先看到它；不新增槽位、不提高 MAX_PREWARMED_REMOTE_VIEWS、不放宽任何一道预热门。
   * intentPriorityRef = 已被意图提前、尚未被选中的来源；intentBudgetRef 只记"真的因意图起了一次 boot"
   * （队列重排不计费），每会话有上限与 60s 冷却（shared/prewarm-intent.ts 的纯策略）。
   */
  const intentPriorityRef = useRef<Set<string>>(new Set())
  const intentBudgetRef = useRef<IntentPrewarmBudget>(emptyIntentPrewarmBudget())

  /**
   * 渲染期镜像（与 commit 同步，微任务安全）：settle 微任务可能先于 effect flush 到达，drain
   * 时必须用它过滤已失效的队列项——绝不把已删除/已挂载的实例重新挂成僵尸视图；排除 mounted
   * 意味着用户已点开的视图不占预热槽位。
   */
  const prewarmEligibleRef = useRef<Set<string>>(new Set())
  // 视图调度簇（预热资格 / 收割保温 / 保留回收 / 后台相位）是命名 hook（use-view-scheduler.ts）；App 取回调用面接线。
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

  // 前台恢复补偿（hidden → visible）：实现在 app-hooks/use-visibility-compensation.ts（ref 注入）。
  useVisibilityCompensation({
    runStalenessWatchdogRef, refreshConnectionsRef, refreshRemotesRef,
    probeManagedRuntimeRef, drainPrewarmRef, reclaimHiddenViewsRef,
  })

  // 共享文档的主题投影归属：文档级 color-scheme / body 调色板属性是 DOCUMENT-global 的，而 N 个实例壳
  // 挂在同一份文档里，每个挂载视图都跑自己的 ui-layout theme presenter。App 是「谁在屏上」的唯一权威，
  // 把它发布到 page-wide chamberBridge，document-theme 投影器据此只让活动视图写文档。useLayoutEffect：
  // 必须在切换视图那一帧**绘制前**发布，否则两个主题不同的视图互切会先画一帧旧调色板。同一份权威也是
  // 文档级 `<html lang>` 的归属来源：page-language 归属器只让**屏上来源、且其宿主设置已回答**的语言落地。
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
      // revealTick is this effect's own dependency and revealHoldRemainingMs clamps to
      // [0, REVEAL_HOLD_MAX_MS]: a clamped 0 means "nothing to wait for", never a 0 ms arm.
      const remainingMs = revealHoldRemainingMs(revealHoldStartedAtRef.current, nowMs)
      if (!(remainingMs > 0)) return
      const handle = setTimeout(
        () => setRevealTick(tick => tick + 1),
        remainingMs,
      )
      return () => { clearTimeout(handle) }
    }
    queueMicrotask(() => {
      // 排队期间屏上目标可能已被改写/该壳已画上：揭示前重验（与回调内重验同纪律）。
      if (viewStore.getSnapshot().active !== selected) return
      const mountable = selected === LOCAL_INSTANCE_ID
        || (mountedViews.includes(selected) && liveServerIdsRef.current.has(selected))
      // 目标不可挂载（退役/被删的竞态）：绝不把死视图留在屏上——回落 local（唯一恒挂载视图）。
      const target = mountable ? selected : LOCAL_INSTANCE_ID
      if (viewStore.getSnapshot().painted === target) return
      // 目标落地后是否显示遮罩的 DOM 事实：在场 ⇒ 'cut'（旧视图快照不与新遮罩交叉混色），否则
      // 'crossfade'。判不出来（无 CSS.escape / 选择器抛错）保守取 'cut'。
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

  // **屏上视图**落地即重计隐藏窗（判据是 paintedView，不是 activeView）：离开屏的旧视图开始计时，
  // 新屏上视图清计时；覆盖揭示落地、注册表删除回落等一切路径。持有窗内旧视图仍在屏上，不会因本
  // effect 被计时——否则保留策略会把"用户正在看的温壳"当隐藏壳回收。
  useEffect(() => {
    if (previousActiveViewRef.current === paintedView) return
    const previous = previousActiveViewRef.current
    previousActiveViewRef.current = paintedView
    delete hiddenSinceRef.current[paintedView]
    if (previous !== null) hiddenSinceRef.current[previous] = Date.now()
  }, [paintedView])

  // 挂载视图的保持时钟（hiddenSince / boot 起表 / 周期回收 tick）是命名 hook；App 只注入 ref 与选择面。
  useMountedViewClocks({
    mountedViews, deferredBootSignature, deferredBootRef, hiddenSinceRef, viewBootStartedAtRef,
    viewStore, pendingViewRef, reclaimHiddenViews, reclaimHiddenViewsRef, drainPrewarmRef,
  })

  // 温壳为收割让位：最后收割的壳留在温壳位省一次 boot，但它（autoPrewarmed + 隐藏）会占住唯一
  // 后台槽且不被 retention 回收——新收割候选一出现就必须让位，否则后变 ready 的来源永远拿不到基线。
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

  // 预热队列补种 + 意图优先级作废 + drain：实现在 app-hooks/use-prewarm-queue.ts。
  usePrewarmQueue({
    remoteInstances, remoteStatus, mountedViews, activeView, drainPrewarm,
    prewarmEligibleRef, prewarmQueueRef, intentPriorityRef,
  })

  /** 打开某来源的会话：切到该来源 shell（未挂载先挂载）并分发到运行时。进入时 arm 一条打开意图、
   *  settle 时按 sessionId 守卫地释放——它是"这次打开还没落地"的唯一事实源，同时驱动①投影门
   *  （该窗口内不投影 current）②揭示门（遮罩留到本次 open 落定）③boot 期早开（目标 ctx 内的
   *  侧栏插件读活槽位）。守卫式释放保证"点 X 后马上点 Y"时 X 的迟到 finally 不会撤掉 Y 的闸门。 */
  const openSession = useCallback(async (instanceId: string, sessionId: string) => {
    // 用户要在这个来源上工作：error/degraded 隧道立即再试（同上）。
    ensureRemoteConnected(instanceId)
    // 与 selectView 同款注册表守卫：来源已删除时拒绝入队——否则 open 会挂进 pendingOpens 永不分发，留死键。
    if (instanceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(instanceId)) {
      // The open-failure texts cross the frame→plugin boundary (the sidebar renders whatever text the
      // rejected promise carries), so the FRAME-OWNED part is dictionary copy in the document locale,
      // read at throw time through the module's out-of-render reader.
      throw new Error(frameText(readDocumentLocale(), 'open.failed.sourceGone', { source: instanceId }))
    }
    try {
      armOpenIntent(instanceId, sessionId)
      selectView(instanceId)
      await openInstanceSession(instanceId, sessionId)
    } catch (err) {
      // Dictionary copy around a raw cause: `{detail}` is the underlying error text, still whatever
      // the crossing boundary produced (shell.ts's open-failure diagnostics and the dsh runtime's own
      // errors have no locale seat, so an English document can still see a Chinese detail clause here).
      // The frame's half is dictionary copy; translating another module's error text would drift.
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
          // Same dictionary rule as the open-failure texts above: the notification runner's rejection text is surfaced by the sidebar, so the frame's half is dictionary copy.
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

  // 通知点击在权威 roster 结算后重放：实现在 app-hooks/use-notification-open-replay.ts（依赖显式入参）。
  useNotificationOpenReplay({
    rosterGate, pendingRosterNotificationOpensRef, liveServerIdsRef,
    acknowledgeNotificationOpen, enqueueNotificationOpen, reportNotificationAckFailure,
    roster, liveServerIds,
  })

  // 桥订阅簇（深链 / 回声 / 挂载快照 / 运行时上报…）是命名 hook；App 只传当前 ref/state/回调与预算常量。
  useBridgeSubscriptions({
    acknowledgeDeepLink, emitSessionNotification, openSession,
    stepCompletionArmFor, withdrawSource, guardStep, refreshAggregate, reportDeepLinkAckFailure, selectView,
    updatePlacement, updateRemoval, updateSessionArchive, updateSessionEcho, updateWorkspaceEcho, aggregatePollSeqRef,
    aggregateRequestOwnersRef, authoritativeArchiveSetRef, autoPrewarmedRef, completeLedgerRef,
    drainPrewarmRef, factsAtRef, harvestCandidatesRef, harvestIntentRef,
    harvestStateRef, intentBudgetRef, intentPriorityRef, liveServerIdsRef,
    mutationRefreshSeqRef, pendingDeepLinkDeliveryRef,
    prewarmEligibleRef, prewarmQueueRef, prewarmSuppressedRef, readyAggregateSourcesRef,
    reclaimViewRef, remotesStore, isRosterSettled: () => rosterGate.isSettled(), echoStore,
    factsStore, sessionListRefreshAtRef, sessionListRefreshPendingRef,
    settingsTargetRef, snapshotAtRef, mountedSources, sourceLifecyclesRef,
    watchdogAggregatesRef, setAggregates, setHostFacts,
    setMountedViews, setPluginDiagnostics,
    setUnverified, sshBridgeReady, LISTENER_READY_RETRY_MS, LISTENER_READY_RETRY_LIMIT,
    // goal-aware v5：观测状态/落盘出口 + 页代判定（reconcile 迁移件）。
    completionObservationRef, persistCompletionLedger,
    bootToken: notificationsBoot.boot.token, bootVerdict: notificationsBoot.boot.verdict,
  })

  /** chamber：**屏上**来源（paintedView，非选择）的已读边沿 ⇒ 步进修正臂做清除。
   *  有壳读 `current` 行；无壳（facts-only provenance）读 App 打开意图（design 06 §4.2）。
   *  官方位由 vendor 在 retain/ready 时清除；进入屏上的一拍重跑一次，覆盖「激活但无新上报」。 */
  const prevPaintedViewRef = useRef(paintedView)
  useEffect(() => {
    const previous = prevPaintedViewRef.current
    prevPaintedViewRef.current = paintedView
    if (previous === paintedView) return
    stepCompletionArmFor(paintedView)
  }, [paintedView, stepCompletionArmFor])

  /**
   * 徽标输入 = **合并后**的 runtime 投影（与侧栏六面同一份事实，INV7）：deriveServers 已经把
   * 通道报告 ∪ 蓝点 ∪ facts overlay（含 P2a goal）∪ stale 合并进 server.runtime；徽标不再读
   * 原始通道报告——否则无壳来源的 goal 压制在 Dock 上缺席（点/待办/徽标分叉）。
   */
  const badgeRuntime = useMemo(() => {
    const record: Record<string, InstanceRuntimeReport | undefined> = {}
    for (const server of servers) record[server.id] = server.runtime
    return record
  }, [servers])

  // 未读徽标 effect 簇（推送 / 桥迟到兜底 / reject 重推与卸载清理）是命名 hook；事实源与预算显式传入。
  useBadgeCount({
    correctionArms,
    runtimeFacts: badgeRuntime,
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

  // 活动视图的 shell 失败报告：boot 失败 settle 后由 InstanceView 上报终态；只有失败态（error 非空）
  // 触发覆盖层——booting/成功态由骨架屏/真实 UI 呈现。
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
  // The failed boot's plugin ids as the official report lists them (shell.ts collectFailedEntries reads
  // the failed boot's own loader sweep); empty for failures with no loader entry (module-system/manifest).
  const activeShellFailedEntries = activeShellState?.failedEntries ?? NO_FAILED_ENTRIES
  // 降级呈现：活动视图 boot 成功但已知缺口时给出现场说明。只有 error 为空的降级态才渲染——boot
  // 失败覆盖层已独占失败态（settled 的 degraded 蕴含 booted && error === null）。控制面不可达覆盖层
  // 与壳状态无关，故渲染处再加一道 `!controlUnreachable`，否则横幅会被不透明覆盖层盖住却仍可聚焦/播报。
  // 「会自动重挂吗」由 boot-gap.ts 的纯判定给出（来源 ready 且本 ready 世代还没重挂过）。
  const activeShellGap = activeShellState !== undefined && activeShellState.error === null
    ? activeShellState.degraded
    : null
  const activeBootGap = activeShellGap === null
    ? null
    : bootGapNotice(activeShellGap, {
        phase: servers.find(server => server.id === activeView)?.phase,
        retried: degradedRetriedRef.current[activeView] === true,
        // Keyed on the frame fact (local runtime management is read-only on Windows), never on the producer's diagnostic sentence.
        instanceId: activeView,
      })

  // 停滞提示的可见集合（用户已忽略的来源不再提示；来源恢复即自动解除忽略）；停滞来源与「事实无法验证」来源共用同一横幅。
  const visibleStalls = [...new Set([...stalledSources, ...unverifiedSources])]
    .filter(id => !dismissedStalls.includes(id))
  return (
    <ErrorBoundary>
      <div className="app">
        {/* 运行位活性守卫的 L3：L1 对账与 L2 有界 reconnect 都没能收敛时，只给用户两个选择——轻恢复
            （重新连接，不丢页面状态）与重恢复（重新加载应用页面）。绝不自动重载：观测者只呈现，动作由用户决定。 */}
        {visibleStalls.length > 0 && !controlUnreachable && activeShellError === null && (
          <div className="session-stall-layer">
            <div className="session-stall">
              {/* role=status 只包**文本**：交互后代放进 live region 会在整区变化时被读屏整体重播。 */}
              <div className="session-stall-text" role="status">
                {t('sessionStall.text', {
                  sources: visibleStalls
                    .map(id => servers.find(server => server.id === id)?.label ?? id)
                    // 分隔符按语言（en 用 ', '，zh 用 '、'）：硬写 '、' 会让英文文案里出现中文顿号。
                    .join(t('sessionStall.separator')),
                })}
              </div>
              <div className="session-stall-actions">
                <Button
                  variant="outline"
                  onClick={() => {
                    // 与自动臂用同一记账（返回值 + 共享账本）：否则用户点一次后自动臂看不到、守卫预算
                    // 也没消耗，会在同一窗口再自动重连一次（每次重连都重放全部 baseline）。手动动作也要
                    // **有界**：沿用自动臂的 60s per-source 退避——窗口内只记账不重连（记账仍需发生）。
                    const at = Date.now()
                    for (const id of visibleStalls) {
                      const lastReconnectAt = lastReconnectAtRef.current[id]
                      if (lastReconnectAt !== undefined && at - lastReconnectAt < AGGREGATE_RECONNECT_BACKOFF_MS) continue
                      if (!reconnectInstanceConnection(id, 'manual')) continue
                      lastReconnectAtRef.current = { ...lastReconnectAtRef.current, [id]: at }
                    }
                  }}
                >
                  {t('sessionStall.reconnect')}
                </Button>
                <ReloadPageButton label={t('sessionStall.reload')} />
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
        {/* 视图始终挂载：致命屏改为覆盖层——卸载视图而不 dispose shell 会遗留僵尸 ctx
            （entries 被新 boot 覆盖、旧 ctx 永不清除），且恢复后要重 boot 丢会话连续性。 */}
        {mountedViews.map((viewId) => {
          const sourceFingerprint = sourceLifecyclesRef.current!.capture(viewId)?.fingerprint
          const transport = servers.find(server => server.id === viewId)?.transport
          if (sourceFingerprint === undefined || transport === undefined) return null
          /** reveal gate: read from data this view ALREADY has — the RAW runtime current (never the
           *  gated projection, which the veil itself hides) and the source's own aggregate, whose
           *  session rows carry the runtime's `blank` flag. No extra fetch. UNKNOWN ⇒ true on purpose
           *  (a session not listed yet must keep the veil); a KNOWN non-blank current needs no veil. */
          const currentSessionId = runtimeFacts[viewId]?.current
          const currentSummary = aggregates[viewId]?.sessions.find(session => session.sessionId === currentSessionId)
          const blankCurrent = currentSessionId === undefined
            || (currentSummary?.blank ?? true)
          return (
            <InstanceView
              key={viewId}
              instanceId={viewId}
              basePath={instanceBasePath(viewId)}
              sourceFingerprint={sourceFingerprint}
              transport={transport}
              // 可见性由 **paintedView**（屏上是谁）驱动，不是选择——点击后旧视图保持可见到揭示门
              // 放行，目标壳（未 settle 时仍是 instance-pending）绝不在持有窗内提前露出。activeView 仍管选择语义。
              active={paintedView === viewId}
              label={serverLabels[viewId] ?? (viewId === LOCAL_INSTANCE_ID ? t('source.local') : viewId)}
              locale={locale}
              currentSessionId={currentSessionId}
              currentSessionKnownBlank={currentSummary?.blank === true}
              onSettled={handleInstanceSettled}
              onStateChange={handleShellState}
              retryToken={retryTokens[viewId]}
              onRebootInstance={retryView}
              waitForServing={waitForServing}
              // 遮罩的事实输入与动作（导航/回收顺序仍由 App 拥有）。
              sourcePhase={servers.find(server => server.id === viewId)?.phase}
              bootDeferred={deferredBootIds.has(viewId)}
              // App 的全局失败覆盖层是模态的：覆盖层在场时遮罩退出 DOM（否则其按钮仍可聚焦/被播报）。
              // 两种模态覆盖层都要算：boot 失败（activeShellError）与控制面不可达（controlUnreachable）。
              failureOverlayVisible={activeShellError !== null || controlUnreachable}
              switchTargets={servers
                .filter(server => server.id !== viewId)
                .map(server => ({ id: server.id, label: server.label }))}
              onSwitchSource={targetId => switchSourceFromVeil(viewId, targetId)}
              onConnectSource={() => connectSourceFromVeil(viewId)}
              onRequestRetry={() => retryView(viewId)}
              // The reveal gate. The boot window is covered by the view's own `!settled` veil; this boolean
              // extends the hold past a clean settle for exactly as long as the shell would NOT show the
              // requested session. Every input lives in the App: the shell's settled/failed mirror, the RAW
              // runtime current (never the gated projection, which this gate hides) and that view's blank
              // flag. Deliberately NOT "any pending open": a view already showing the requested session must
              // not veil. The hold is `pendingIntent && !failed && !showsRequestedSession && blankCurrent`.
              holdVeil={shouldHoldViewVeil({
                failed: (shellStates[viewId]?.error ?? null) !== null,
                pendingIntent: openIntents[viewId] !== undefined,
                blankCurrent,
                // `openIntents[viewId] !== undefined` is spelled out on purpose: without it, "no current
                // AND no intent" would read as "already showing the requested session" (undefined ===
                // undefined). The rule short-circuits on pendingIntent today; this must not depend on it.
                showsRequestedSession: openIntents[viewId] !== undefined
                  && shellStates[viewId]?.booted === true
                  && runtimeFacts[viewId]?.current === openIntents[viewId],
              })}
              // 持有窗的请求身份：同视图 A→B 换代时窗口必须重新起算，否则新请求会继承 A 的起点（极端时立即过期）。
              openIntentId={openIntents[viewId]}
            />
          )
        })}
        {/* 活动视图 boot 失败 = 该视图的 dsh shell 从未挂载——导航（侧边栏在 shell 内）随之不可用，
            必须提供逃生通道。覆盖层 = 失败报告 + 重试 + 服务器切换，绝不阻断切换/重试（一个实体的
            失败不得抹除/阻断无关的健康实体）。仅活动视图渲染；非活动视图失败在激活时呈现。
            控制面不可达是更高层的全局条件，渲染在其之上（下方 JSX 顺序在后）。 */}
        {activeBootGap !== null && !controlUnreachable && (
          <div className="boot-gap-layer">
            {/* 降级呈现：boot 成功但整个面缺席时的现场说明。非模态、不阻断——侧栏/会话头/composer/
                切换来源全部照常，命中测试只落在卡片本身。role="status" 而非 "alert"：不夺焦点也不打断
                读屏，且 kind 分不出"暂时"还是"结构性"，用 alert 会把几秒竞态当成事故播报。
                文案全部来自框架字典；产出方的原文只作诊断行。 */}
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
                {/* The manual half is decided by boot-gap.ts (kind + source id) and autoRetryArmed
                    keeps its own honest promise; local and remote get DIFFERENT manual copy because
                    the local runtime is a read-only projection on Windows. */}
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
            {/* The failure report carries the SAME content the official report does — a title, the
                boot failure text, and the plugin ids that did not activate (read off the failed
                boot's loader sweep, riding ShellState). The chamber cover stays because navigation
                lives inside the shell, so a failed boot needs this escape hatch. */}
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
                // 重试 = 重新 boot 该视图 + error/degraded 隧道立即再试 + ready 但会话/远端已死的来源
                // 立即探测一次（与 selectView 同语义；否则隧道故障/死会话引起的失败会原地复现）。
                retryView(activeView)
              }}
            >
              {t('action.retry')}
            </Button>
            <ReloadPageButton label={t('sessionStall.reload')} />
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
            {/* a11y: the fatal overlay is an alert like its boot-failure sibling, so a screen reader announces the control-plane loss without a focus move. */}
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
