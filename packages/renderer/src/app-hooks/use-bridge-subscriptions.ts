/**
 * 桥订阅簇——单项数据面之外的全部 chamberBridge
 * 入站订阅与深链：全部已读 / 意图预热 / 打开会话 / 激活来源 / 设置面板目标 /
 * VS Code 深链 / 刷新 / 工作区·会话·归档回声 / 挂载快照 / 插件诊断 / dshVersion /
 * 运行时上报。所有判定与账本内核仍是既有纯模块；本 hook 只做装配与订阅生命周期，
 * 依赖面显式类型化（无 any），App 只负责传入当前 ref/state/回调。
 */
import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import type { SetLedgerView } from '@dsh-chamber/dsh-stream-state'
import { planSessionListRefresh, shouldRequestSessionListRefresh } from '../aggregate-refresh.ts'
import { harvestPending, harvestSatisfied, shouldReclaimHarvestedShell, type HarvestRecord } from '../baseline-harvest.ts'
import {
  deliveryMatchesCurrentSource, routeDeepLinkActivation, SourceOwnershipRegistry,
  type RendererDeliveryCoordinates,
} from '../deep-link-activation.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { errorMessage } from '../status.ts'
import { sourceIdForRawInstance } from '../transport-source.ts'
import {
  applyObservationBatch,
  completionIdentity,
  factsChannelOf,
  observeSource,
  type SourceObservationState,
} from '../completion-observation.ts'
import { notificationLedger } from '../notification-ledger.ts'
import type { NotificationTitleId } from '../notification-projection.ts'
import type { CompleteLedger } from '../complete-ledger.ts'
import type { SessionFactsSnapshot } from '../session-facts-source.ts'
import type { SshInstanceSpec } from '../global.d.ts'
import {
  chamberBridge,
  instanceSnapshotSignature,
  intentPrewarmAllowed,
  prioritizePrewarmSource,
  reconcilePendingArchives,
  reconcilePendingSessions,
  reconcilePendingWorkspaces,
  recordPendingArchive,
  recordPendingSession,
  recordPendingWorkspace,
  removePendingSession,
  removePendingWorkspace,
  renamePendingWorkspace,
  runtimeReportSignature,
  sweepPendingArchives,
  sweepPendingSessions,
  sweepPendingWorkspaces,
  type InstanceAggregate,
  type InstanceRuntimeReport,
  type InstanceSnapshot,
  type IntentPrewarmBudget,
  type PluginGraphDiagnostic,
  type SessionArchiveLedger,
  type SessionEchoLedger,
  type WorkspaceEchoLedger,
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

/** 会话列表刷新合并窗（唯一消费者在本 hook）。 */
const SESSION_LIST_REFRESH_COALESCE_MS = 5_000

/**
 * 桌面桥面探测判定（App 的 500ms 探测 effect 维护，见 App.tsx 的
 * `bridgeVerdict`）：
 * - `'pending'`：探测中——`window.dshChamber` 由桌面 preload 经异步 IPC 后
 *   expose，首帧必然缺席，迟到窗口内无法区分「无桥」与「桥未就绪」；
 * - `'present'`：`desktopSsh` 已 expose，存在远程来源，权威 roster 是异步事实；
 * - `'absent'`：探测预算耗尽仍无 `desktopSsh` = 无桥形态（浏览器/dev 直开、
 *   无桌面 preload）。该形态 `remoteInstances` 恒为 `[]`、`servers` 只含 local，
 *   live={local} 本身就是完整权威集合。
 */
export type DesktopBridgeVerdict = 'pending' | 'present' | 'absent'

/**
 * Durable（v2 落盘）未读账本的剪枝门控。
 *
 * App 首帧**同步**从 localStorage 载入 read/edge（unread-store）与
 * notified/pending/outcomes（complete-ledger），而权威远端 roster 是异步事实：
 * 桥要等 `window.dshChamber` 暴露（500ms 探测），`instances_get` 还要一次 IPC
 * 往返，期间 `remoteInstances` 仍是 `[]`、`servers` 只含 local。若此时按
 * live={local} 剪枝，四类 durable 表里属于远端来源的键会被当成退役来源写盘删除
 * ——pending/outcomes/notified 与 read/edge 全部不可恢复（这正是 F6 回归的写盘
 * 丢失）。因此四类 durable 剪枝统一由本谓词放行：
 * - 有桥（`'present'`）：只有权威 roster 结算
 *   （`remoteRosterSettledRef`：refreshRemotes 成功结算后置位，见 App.tsx）
 *   后 live 才完整；结算那一拍的 `remoteRosterSettled` state 变化使剪枝 effect
 *   重跑，届时再按权威 live 收敛。
 * - 无桥（`'absent'`）：没有远程来源，live={local} 安全，**视同已结算**放行；
 *   否则门恒关，旧 durable 键（磁盘每来源 ≤500，非无限增长）永不收敛。
 * - 探测中（`'pending'`）与有桥未结算同路：未知 ⇒ 关门。缺省参数等价
 *   `'present'`（保持旧行为：假定有桥，只看结算位）。
 * - 注册表降级（`registryDegraded`，F13）：持久化注册表加载失败（损坏保留为
 *   `*.corrupt` 后空启动；或 live 文件缺失而 `.corrupt` 副本仍在）时，
 *   `instances_get` 的空/缺行 roster 不是权威——文件内容未知，live 不完整。
 *   此时**任何剪枝都不得放行**（含无桥形态的防御性组合），否则远端 durable
 *   键会被当退役来源写盘删除；健康位恢复（saveInstances 重建注册表）后由
 *   refreshRemotes 正常结算再收敛。
 * - roster 行级丢弃（`rosterIncomplete`，V5-A）：JSON 数组解析成功但
 *   transport-manager 丢弃了条目（provider validateSpec 拒绝／重复 id；典型
 *   触发面是「新写旧读」的字段漂移）时，磁盘有内容而 roster 只是子集——合法
 *   行仍安装（连接可见），但**任何剪枝同样不得放行**（与 degraded 同档否决，
 *   含无桥形态与陈旧结算位的防御性组合），否则被丢弃来源的 durable 键会被当
 *   退役来源删除；一次无丢弃的成功 load 或 authoritative 保存恢复完整后，
 *   下一拍 `rosterIncomplete=false` 重跑本 effect 正常收敛。
 * 易失轨（prevRunning / 观测状态 / 水位记账）不在此门内。
 *
 * 纯谓词、无副作用，便于存储假实现回归直测。
 */
export function durableUnreadPruneAllowed(
  remoteRosterSettled: boolean,
  bridgeVerdict: DesktopBridgeVerdict = 'present',
  registryDegraded = false,
  rosterIncomplete = false,
): boolean {
  // 注册表降级/roster 不完整 ⇒ 空/缺行 roster 不是权威，任何情况下都不放行
  // （两档优先于结算位：结算只可能来自完整 roster，同真属防御性组合，按未知
  // 处理）。两档保持可区分：诊断文案与来源各自单源（见下方两个纯函数）。
  if (registryDegraded === true) return false
  if (rosterIncomplete === true) return false
  // 已结算 ⇒ live 必然完整，无论桥面判定为何（结算本身就是桥存在的证据）。
  if (remoteRosterSettled === true) return true
  // 未结算：只有确认无桥才能按 live={local} 收敛；'present'/'pending' 都关门。
  return bridgeVerdict === 'absent'
}

/**
 * V5-A（行级丢弃）：loadInstances() 解析出合法数组但丢弃了条目/重复 id 时，
 * roster 是磁盘内容的子集——refreshRemotes 仍安装合法行并结算（连接不能不可
 * 见），但 durable 剪枝门由 `rosterIncomplete` 维度关死。诊断单源，供 App 的
 * warn-once 使用，与 `registryDegraded`、health-unavailable 三角可区分。
 * @param droppedCount 本次 load 丢弃（含重复 id）的条目数。
 */
export function rosterIncompleteDiagnostic(droppedCount: number): string {
  return `roster incomplete: ${droppedCount} persisted instance row(s) were dropped as invalid or duplicate`
}

/**
 * F16/A4（health 探针不可用）：注册表健康位是权威 roster 的门。旧桥/旧 Swift
 * shim 没有 `desktopSsh.instances_health` 方法，或探针 invoke 抛错（IPC/sidecar
 * 未就绪、进程退出）时，**不得**把「读不到健康位」折叠成「健康」：
 * refreshRemotes 保持 fail-closed（不安装 roster、不置结算位、不触发 durable
 * 剪枝），并按下述诊断单源 warn-once——与「注册表降级」和「无桥」三角可区分。
 * 纯函数：实现与 wiring 测试读同一文案，不复制字面量。
 */
export type HealthProbeUnavailableKind = 'missing-method' | 'invoke-failed'

export function healthProbeUnavailableDiagnostic(kind: HealthProbeUnavailableKind): string {
  return kind === 'missing-method'
    ? 'health unavailable: desktopSsh.instances_health is not exposed by this bridge'
    : 'health unavailable: desktopSsh.instances_health() rejected'
}

/** 深链归一化交付（与 App 的 `DeepLinkDelivery` 同形；结构兼容由调用点 tsc 保证）。 */
export type DeepLinkDelivery = RendererDeliveryCoordinates & {
  rawInstanceId: string
  sourceId: string | null
  sourceFingerprint: string
}

/** 通知组装请求（唯一组装点入参；与 App 的 `SessionNotificationRequest` 同形）。 */
export interface BridgeNotificationRequest {
  sourceId: string
  sourceFingerprint: string
  sessionId: string
  kind: 'complete' | 'ask' | 'request'
  watermark?: number
  /** 标题身份（目标标题一次性；缺省 = 会话已完成）。 */
  title?: NotificationTitleId
  /** 收敛器 ¤origin¤ 诊断。 */
  origin?: string
  /** pending 存续毫秒诊断。 */
  pendingAge?: number
}

export interface BridgeSubscriptionsDeps {
  // 回调（App 侧既有实现）
  acknowledgeDeepLink: (delivery: RendererDeliveryCoordinates) => Promise<void>
  emitSessionNotification: (request: BridgeNotificationRequest) => void
  markSourceAllRead: (sourceId: string) => void
  openSession: (instanceId: string, sessionId: string) => Promise<unknown>
  recomputeSourceUnread: (sourceId: string) => void
  refreshAggregate: (instanceId: string, mutationTag?: number) => Promise<unknown>
  reportDeepLinkAckFailure: (delivery: RendererDeliveryCoordinates, error: unknown) => void
  selectView: (viewId: string, onApply?: (applied: boolean) => void) => boolean
  updateSessionArchive: (next: SessionArchiveLedger) => void
  updateSessionEcho: (next: SessionEchoLedger) => void
  updateWorkspaceEcho: (next: WorkspaceEchoLedger) => void
  // refs
  aggregatePollSeqRef: { current: Record<string, number> }
  aggregateRequestOwnersRef: { current: SourceOwnershipRegistry | null }
  authoritativeArchiveSetRef: { current: Record<string, readonly string[]> }
  autoPrewarmedRef: { current: SetLedgerView }
  completeLedgerRef: { current: CompleteLedger }
  drainPrewarmRef: { current: () => void }
  factsAtRef: { current: Record<string, number> }
  harvestCandidatesRef: { current: Set<string> }
  harvestIntentRef: { current: Set<string> }
  harvestStateRef: { current: Record<string, HarvestRecord> }
  intentBudgetRef: { current: IntentPrewarmBudget }
  intentPriorityRef: { current: Set<string> }
  liveServerIdsRef: { current: Set<string> }
  mutationRefreshSeqRef: { current: Record<string, number> }
  pendingDeepLinkDeliveryRef: { current: DeepLinkDelivery | null }
  prevRunningRef: { current: Record<string, Record<string, boolean>> }
  /** 完成观测状态（v5 §3.2；与 App 的 facts 轨共用同一份 Map）。 */
  completionObservationRef: { current: Map<string, SourceObservationState> }
  /** runtime report 的同步权威镜像（App 事件回调/派生读它，不依赖渲染期赋值）。 */
  runtimeFactsRef: { current: Record<string, InstanceRuntimeReport | undefined> }
  /** reconcile 批次的落盘出口（immediate ⇒ 立即 flushUnread）。 */
  persistCompletionLedger: (immediate: boolean) => void
  /** 页代 token 与判定（§3.5；identity 与 reconcile 的 boot 都读它）。 */
  bootToken: string
  bootVerdict: 'same' | 'fresh'
  prewarmEligibleRef: { current: Set<string> }
  prewarmQueueRef: { current: string[] }
  prewarmSuppressedRef: { current: SetLedgerView }
  readyAggregateSourcesRef: { current: Set<string> }
  reclaimViewRef: { current: (id: string, reason?: 'retention' | 'harvest') => void }
  remoteInstancesRef: { current: SshInstanceSpec[] }
  remoteRosterSettledRef: { current: boolean }
  sessionArchiveRef: { current: SessionArchiveLedger }
  sessionEchoRef: { current: SessionEchoLedger }
  sessionFactsRef: { current: Record<string, SessionFactsSnapshot | undefined> }
  sessionListRefreshAtRef: { current: Record<string, number> }
  sessionListRefreshPendingRef: { current: Record<string, string[]> }
  settingsTargetRef: { current: string | undefined }
  snapshotAtRef: { current: Record<string, number> }
  snapshotSourcesRef: { current: Record<string, true> }
  sourceLifecyclesRef: { current: SourceOwnershipRegistry | null }
  watchdogAggregatesRef: { current: Record<string, InstanceAggregate> }
  workspaceEchoRef: { current: WorkspaceEchoLedger }
  // state setters
  setAggregates: Dispatch<SetStateAction<Record<string, InstanceAggregate>>>
  setHostFacts: Dispatch<SetStateAction<Record<string, { dshVersion?: string } | undefined>>>
  setMountedViews: Dispatch<SetStateAction<string[]>>
  setPluginDiagnostics: Dispatch<SetStateAction<Record<string, PluginGraphDiagnostic | undefined>>>
  setRuntimeFacts: Dispatch<SetStateAction<Record<string, InstanceRuntimeReport | undefined>>>
  setSnapshotSources: Dispatch<SetStateAction<Record<string, true>>>
  setUnverified: (updater: (prev: readonly string[]) => readonly string[]) => void
  // 值 / 常量
  sshBridgeReady: boolean
  LISTENER_READY_RETRY_MS: number
  LISTENER_READY_RETRY_LIMIT: number
}

export function useBridgeSubscriptions(deps: BridgeSubscriptionsDeps): void {
  const {
    acknowledgeDeepLink, emitSessionNotification, markSourceAllRead, openSession,
    recomputeSourceUnread, refreshAggregate, reportDeepLinkAckFailure, selectView,
    updateSessionArchive, updateSessionEcho, updateWorkspaceEcho,
    aggregatePollSeqRef, aggregateRequestOwnersRef, authoritativeArchiveSetRef, autoPrewarmedRef,
    completeLedgerRef, drainPrewarmRef, factsAtRef, harvestCandidatesRef, harvestIntentRef,
    harvestStateRef, intentBudgetRef, intentPriorityRef, liveServerIdsRef, mutationRefreshSeqRef,
    pendingDeepLinkDeliveryRef, prevRunningRef, prewarmEligibleRef,
    prewarmQueueRef, prewarmSuppressedRef, readyAggregateSourcesRef, reclaimViewRef,
    remoteInstancesRef, remoteRosterSettledRef, sessionArchiveRef, sessionEchoRef, sessionFactsRef,
    sessionListRefreshAtRef, sessionListRefreshPendingRef, settingsTargetRef, snapshotAtRef,
    snapshotSourcesRef, sourceLifecyclesRef, watchdogAggregatesRef, workspaceEchoRef,
    setAggregates, setHostFacts, setMountedViews, setPluginDiagnostics, setRuntimeFacts,
    setSnapshotSources, setUnverified,
    completionObservationRef, runtimeFactsRef, persistCompletionLedger, bootToken, bootVerdict,
    sshBridgeReady, LISTENER_READY_RETRY_MS, LISTENER_READY_RETRY_LIMIT,
  } = deps

  /** 侧栏「全部已读」请求（插件→App 单向，与 openSession 同一条桥纪律）。 */
  useEffect(() => {
    const unsubscribe = chamberBridge.onMarkAllRead(({ sourceId }) => {
      markSourceAllRead(sourceId)
    })
    return unsubscribe
  }, [markSourceAllRead])

  /**
   * 意图预热：来源头部 hover dwell（插件侧
   * shared/prewarm-intent.ts 的 120ms 机器）到达这里后只做一件事——把该来源
   * 提到**既有**后台预热队列的队首，让既有 drainPrewarm/pickPrewarmTarget
   * 先看到它。绝不代行"点开"：被回收抑制 / 已挂载 / 收割停车 / 未就绪的来源
   * 都不在 prewarmEligible 里，意图在此原样丢弃（不删 prewarmSuppressedRef
   * 的键——否则就是"回收后立刻重新 boot"的空转）；用户明确点开仍走 selectView
   * 原路（清抑制 + 挂载）。每会话预算/冷却见 drainPrewarm 的计费与纯策略。
   */
  useEffect(() => {
    const unsubscribe = chamberBridge.onIntentPrewarm(({ sourceId }) => {
      if (!prewarmEligibleRef.current.has(sourceId)) return
      const now = Date.now()
      if (!intentPrewarmAllowed(intentBudgetRef.current, sourceId, now)) return
      intentPriorityRef.current.add(sourceId)
      prewarmQueueRef.current = prioritizePrewarmSource(
        prewarmQueueRef.current,
        sourceId,
        prewarmEligibleRef.current,
      )
      drainPrewarmRef.current()
    })
    return unsubscribe
  }, [])

  /** 侧边栏插件打开请求（05）：mount 订阅、卸载取消。请求通道单向
   *  （插件→App）；打开终态经 outcome 回报（App→每个 sidebar shell，
   *   行内错误呈现），失败同时 console.error。 */
  useEffect(() => {
    const unsubscribe = chamberBridge.onOpenSession(({ sourceId, sessionId }) => {
      void openSession(sourceId, sessionId).then(
        () => { chamberBridge.reportOpenSessionOutcome({ sourceId, sessionId }) },
        (err) => {
          const message = errorMessage(err)
          console.error(`[renderer] openSession failed (${sourceId}/${sessionId}):`, err)
          chamberBridge.reportOpenSessionOutcome({ sourceId, sessionId, message })
        },
      )
    })
    return unsubscribe
  }, [openSession])

  /** 侧边栏插件点击来源头部的激活请求：切换到该来源 shell（未挂载先挂载，N-ctx）。 */
  useEffect(() => {
    return chamberBridge.onActivateSource((sourceId) => {
      selectView(sourceId)
    })
  }, [selectView])

  /**
   * 设置面板目标来源（design 05）：面板渲染选中来源
   * 自己的 boot ctx 台账，因此该来源的壳必须挂载。这里只做"挂载 + 保留"，绝不
   * 切换 active view——下拉选服务器不等于把用户正在看的视图换掉（与
   * `requestActivateSource` 的分工：后者是用户点了侧栏来源头部）。
   * 未在权威 roster 里的 id 不挂载（已退役来源不得被重新 boot）；面板对离线
   * 来源本就不设目标（它显示不可达占位）。
   */
  useEffect(() => {
    return chamberBridge.onSettingsTarget((sourceId) => {
      settingsTargetRef.current = sourceId
      if (sourceId === undefined) return
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      // 因闲置被回收而被抑制预热的来源，被面板显式选中 = 再次有使用意图。
      prewarmSuppressedRef.current.delete(sourceId)
      autoPrewarmedRef.current.delete(sourceId)
      setMountedViews(prev => (prev.includes(sourceId) ? prev : [...prev, sourceId]))
    })
  }, [])

  /** VS Code OS 深链（design 16 hold/replay）：先注册监听，再以 ready()
   *  通知主进程放行归一化 intent；冷启动/重载期间的成功启动不会丢失来源激活。
   *  raw id → 视图 id 通过当前权威 kind roster 解析为 dsh-/gateway-；
   *  legacy ssh- 只作为输入兼容，绝不由 v2 roster 新产生。
   *  远程来源在首次 authoritative instances_get settle 前进入单槽 pending，
   *  roster 成功后再由上方 effect replay；local 不依赖 roster，立即激活。
   *  VS Code 启动由主进程独立完成，渲染层激活从不阻塞它。桥与 desktopSsh
   *  同一批 expose，sshBridgeReady 即 deepLink 可用。 */
  useEffect(() => {
    if (!sshBridgeReady) return
    const deepLink = window.dshChamber?.deepLink
    if (deepLink === undefined) return
    const unsubscribe = deepLink.onIntent((intent) => {
      if (typeof intent.instanceId !== 'string'
        || typeof intent.sourceFingerprint !== 'string'
        || !Number.isSafeInteger(intent.deliveryId) || intent.deliveryId < 1
        || !Number.isSafeInteger(intent.attempt) || intent.attempt < 1) {
        console.error('[renderer] ignored malformed deep-link activation intent')
        return
      }
      const sourceId = intent.instanceId === 'local'
        ? LOCAL_INSTANCE_ID
        : remoteRosterSettledRef.current
          ? sourceIdForRawInstance(intent.instanceId, remoteInstancesRef.current)
          : null
      if (intent.instanceId !== 'local' && remoteRosterSettledRef.current && sourceId === null) {
        console.warn(`[renderer] ignored deep-link raw source absent from the authoritative roster: ${intent.instanceId}`)
        void acknowledgeDeepLink(intent).catch(error => {
          reportDeepLinkAckFailure(intent, error)
        })
        return
      }
      // If authority for this source is already installed, reject a stale IPC
      // pipe delivery before it can supersede a legitimate held intent. When
      // no owner exists yet, preserve the delivery until the roster settles
      // and perform the same exact-proof check in the replay effect.
      if (
        sourceId !== null
        && sourceLifecyclesRef.current!.capture(sourceId) !== null
        && !deliveryMatchesCurrentSource(
          sourceLifecyclesRef.current!,
          sourceId,
          intent.sourceFingerprint,
        )
      ) {
        console.warn(`[renderer] ignored stale deep-link source proof before routing: ${sourceId}`)
        void acknowledgeDeepLink(intent).catch(error => {
          reportDeepLinkAckFailure(intent, error)
        })
        return
      }
      const previous = pendingDeepLinkDeliveryRef.current
      const current: DeepLinkDelivery = {
        rawInstanceId: intent.instanceId,
        sourceId,
        sourceFingerprint: intent.sourceFingerprint,
        deliveryId: intent.deliveryId,
        attempt: intent.attempt,
      }
      if (sourceId === null) {
        pendingDeepLinkDeliveryRef.current = current
        if (previous !== null && previous.deliveryId !== current.deliveryId) {
          void acknowledgeDeepLink(previous).catch(error => {
            reportDeepLinkAckFailure(previous, error)
          })
        }
        return
      }
      const decision = routeDeepLinkActivation(
        sourceId,
        remoteRosterSettledRef.current,
        liveServerIdsRef.current,
        previous?.sourceId ?? null,
      )
      pendingDeepLinkDeliveryRef.current = decision.pendingSourceId === null ? null : current
      if (previous !== null && previous.deliveryId !== current.deliveryId) {
        // View activation is explicitly last-intent-wins. A newer delivery
        // deliberately supersedes the older held item, so commit the old id
        // instead of leaving main's single-flight key retained forever.
        void acknowledgeDeepLink(previous).catch(error => {
          reportDeepLinkAckFailure(previous, error)
        })
      }
      if (decision.discarded?.reason === 'missing') {
        console.warn(`[renderer] ignored deep-link source absent from the authoritative roster: ${decision.discarded.sourceId}`)
      }
      if (decision.activateSourceId !== null) {
        if (deliveryMatchesCurrentSource(
          sourceLifecyclesRef.current!,
          sourceId,
          current.sourceFingerprint,
        )) {
          selectView(decision.activateSourceId)
        } else {
          console.warn(`[renderer] ignored stale deep-link source proof: ${sourceId}`)
        }
      }
      if (decision.pendingSourceId === null) {
        void acknowledgeDeepLink(current).catch(error => {
          reportDeepLinkAckFailure(current, error)
        })
      }
    })
    // Listener-before-ready is the ordering contract: ready synchronously
    // unlocks the main-process drain, whose first send may happen immediately.
    // Retry a transient IPC failure on a bounded budget; main keeps its intent
    // held until one invocation succeeds.
    let cancelled = false
    let readyAttempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const signalReady = (): void => {
      readyAttempts += 1
      void Promise.resolve()
        .then(() => deepLink.ready())
        .then((ready) => {
          if (ready !== true) throw new Error('deep-link ready returned false')
        })
        .catch((error: unknown) => {
          if (cancelled) return
          if (readyAttempts >= LISTENER_READY_RETRY_LIMIT) {
            console.error('[renderer] deep-link readiness handshake exhausted its retry budget:', error)
            return
          }
          retryTimer = setTimeout(signalReady, LISTENER_READY_RETRY_MS)
        })
    }
    signalReady()
    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      unsubscribe()
    }
  }, [sshBridgeReady, acknowledgeDeepLink, reportDeepLinkAckFailure, selectView])

  /** 侧边栏动作成功后请求的即时刷新（chamberBridge.requestRefresh）；失败落 error 态由 UI 呈现。
   *  Always pull on a mutation: the mounted producer's push can lag the host's
   *  registry reorder (create → prepend → insertBefore), so relying on the
   *  freshness check here would leave new worktrees/sessions stranded at the prepended
   *  head until the next 30s poll. */
  useEffect(() => {
    return chamberBridge.onRefresh((sourceId) => {
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const tag = (mutationRefreshSeqRef.current[sourceId] ?? 0) + 1
      mutationRefreshSeqRef.current[sourceId] = tag
      void refreshAggregate(sourceId, tag)
    })
  }, [refreshAggregate])

  /**
   * 工作区创建回声：
   * 应用内**任一**工作区创建（唯一出口 workspace-mutations.ts：侧栏对话框与
   * Git worktree 插件的 create/adopt/recovery 同走它）建好后上报宿主
   * workspaceId，App 记入渲染端账本并把该行并入投影（deriveServers 的单一
   * 汇合点）。权威收敛点只有两个：
   * - 该来源挂载壳的 push 列出同一 workspaceId / 同一路径的真实 id ⇒ 账本条目
   *   立即清除（reconcilePendingWorkspaces，见 onInstanceSnapshot）；
   * - 来源离开注册表 / TTL 到期 ⇒ 随生命周期收敛。
   * 这里只记录、不拉取：侧栏在自己的 create 成功后照旧 `requestRefresh`，两条
   * 通道职责不重叠（本通道是"我刚刚造了它"的事实，刷新是"其它行要更新"）。
   */
  useEffect(() => {
    return chamberBridge.onWorkspaceCreated((fact) => {
      const { sourceId } = fact
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const owner = sourceLifecyclesRef.current!.capture(sourceId)
      if (owner === null) return
      const now = Date.now()
      let ledger = sweepPendingWorkspaces(workspaceEchoRef.current, now)
      ledger = recordPendingWorkspace(ledger, sourceId, {
        workspaceId: fact.workspaceId,
        path: fact.path,
        // Placement anchor：Git 插件在宿主上把新 worktree
        // 摆在其主 checkout 之后，回声行也必须渲染在那个位置，否则会先出现在
        // 列表末尾、挂载收敛时再跳上去。缺省（其它创建入口）= 追加到尾部。
        ...(fact.afterWorkspaceId === undefined ? {} : { afterWorkspaceId: fact.afterWorkspaceId }),
        // 创作意图标题（Git adopt 的分支名）：回声行生来就是最终
        // 标签，不必先显示路径 basename、等那次 rename 落地再翻转。
        ...(fact.title === undefined ? {} : { title: fact.title }),
      }, now)
      if (ledger !== workspaceEchoRef.current) updateWorkspaceEcho(ledger)
    })
  }, [updateWorkspaceEcho])
  /**
   * 回声的**撤下 / 改写**通道：
   * 只有 create 事实的回声没有退场机制——创建后又在侧栏删掉会留一行幽灵，且
   * **权威挂载 push 也退不掉它**（push 只调和"它列出了什么"，列不出的行无事发生，
   * 幽灵要挂到 10 分钟 TTL；而那一行带真实 host id，工作区级动作在宿主上
   * fail-closed `workspace/not-found`），
   * 重命名则因为账本只按路径生成 title 而看起来像没生效。两条通道都是单向事实，
   * 与 onWorkspaceCreated 同栅栏（活跃来源 + 生命周期捕获），并且经**同一个**
   * updateWorkspaceEcho 写入：App 仍是投影的唯一写者，账本之外没有第二份状态。
   * 纯账本改写（removePendingWorkspace / renamePendingWorkspace）保持同一性——
   * 无匹配条目时返回同一引用，不触发重渲染。
   */
  useEffect(() => {
    return chamberBridge.onWorkspaceRemoved((fact) => {
      const { sourceId } = fact
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const owner = sourceLifecyclesRef.current!.capture(sourceId)
      if (owner === null) return
      // The removal is another tick that can change what that source's list
      // SHOULD contain, so it carries the same TTL sweep as the create fact
      // (whose doc enumerates these ticks): the retired entry itself is dropped
      // eagerly by removePendingWorkspace, the sweep covers the entries whose
      // convergence never came. Identity-preserving, so a no-op costs no render.
      let ledger = sweepPendingWorkspaces(workspaceEchoRef.current, Date.now())
      ledger = removePendingWorkspace(ledger, sourceId, { workspaceId: fact.workspaceId, path: fact.path })
      if (ledger !== workspaceEchoRef.current) updateWorkspaceEcho(ledger)
    })
  }, [updateWorkspaceEcho])
  useEffect(() => {
    return chamberBridge.onWorkspaceRenamed((fact) => {
      const { sourceId } = fact
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const owner = sourceLifecyclesRef.current!.capture(sourceId)
      if (owner === null) return
      const next = renamePendingWorkspace(
        workspaceEchoRef.current,
        sourceId,
        fact.workspaceId,
        fact.title,
      )
      if (next !== workspaceEchoRef.current) updateWorkspaceEcho(next)
    })
  }, [updateWorkspaceEcho])
  /**
   * 会话创建回声的记账端：唯一出口
   * （sidebar shared/session-mutations.ts）在 wire 成功后发布宿主会话 id，这里
   * 把它记入渲染端账本。与会话打开意图同栅栏（活跃来源 + 生命周期捕获），投影的
   * 唯一写者仍是 App。
   * 成员位解析（best-effort，全部来自 App 手里的权威聚合）：
   * ①事实自带 workspaceId（"+" 建会话必然知道）→ 按宿主 id 找到那一行取路径；
   * ②否则按父会话（fork）找到**归属**父会话的工作区——子会话与父会话同属一个
   * 目录；③解析不到也照记：行仍以未分组形态出现，好过整行缺失（TTL 有界）。
   * 记账之后立刻请求该来源挂载壳的官方 session-list 刷新：unary 侧建出来的会话进
   * 挂载壳 summaries 的唯一外源是宿主 api-session/added 的**异步**广播（竞态或丢帧都
   * 可能），刷新则强制 summaries 重读宿主语料——否则回声要独自撑住整段 TTL（且会话
   * 首轮之后仍是 blank 形态）。未挂载来源没有该 seam（广播无人订阅）：回声独自撑住
   * 该行，直到该来源下次挂载时的基线收敛。
   */
  useEffect(() => {
    return chamberBridge.onSessionCreated((fact) => {
      const { sourceId } = fact
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const owner = sourceLifecyclesRef.current!.capture(sourceId)
      if (owner === null) return
      const now = Date.now()
      const aggregate = watchdogAggregatesRef.current[sourceId]
      const workspaces = aggregate !== undefined && aggregate.state === 'ok' ? aggregate.workspaces : []
      const byId = fact.workspaceId === undefined
        ? undefined
        : workspaces.find(workspace => workspace.workspaceId === fact.workspaceId)
      const parentId = fact.parentSessionId
      const byParent = byId === undefined && parentId !== undefined
        ? workspaces.find(workspace => workspace.sessionIds.includes(parentId))
        : undefined
      const target = byId ?? byParent
      const workspaceId = fact.workspaceId ?? target?.workspaceId
      const path = target?.path
      let ledger = sweepPendingSessions(sessionEchoRef.current, now)
      ledger = recordPendingSession(ledger, sourceId, {
        sessionId: fact.sessionId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(path === undefined || path === '' ? {} : { path }),
        ...(fact.title === undefined ? {} : { title: fact.title }),
        blank: fact.blank,
      }, now)
      if (ledger !== sessionEchoRef.current) updateSessionEcho(ledger)
      chamberBridge.requestSessionListRefresh(sourceId)
    })
  }, [updateSessionEcho])
  /**
   * 会话回声的撤下半 + 归档墓碑：归档成功做两件事——①退休该会话的待定
   * 创建回声（创建后又在回声窗内被归档的行不会留到 TTL；挂载推送只能退休它**归属**
   * 的条目，未挂载来源根本不推送）；②记一条本地归档墓碑，让**未挂载来源**上刚归档
   * 的行也立刻从列表消失（权威归档集到达即收敛，见 shared/session-echo.ts 的
   * PendingArchive）。与会话创建事实同栅栏、同账本写入路径。
   */
  useEffect(() => {
    return chamberBridge.onSessionRemoved((fact) => {
      const { sourceId } = fact
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const owner = sourceLifecyclesRef.current!.capture(sourceId)
      if (owner === null) return
      const now = Date.now()
      const withoutPending = removePendingSession(sessionEchoRef.current, sourceId, fact.sessionId)
      if (withoutPending !== sessionEchoRef.current) updateSessionEcho(withoutPending)
      const swept = sweepPendingArchives(sessionArchiveRef.current, now)
      const archived = recordPendingArchive(swept, sourceId, fact.sessionId, now)
      if (archived !== sessionArchiveRef.current) updateSessionArchive(archived)
    })
  }, [updateSessionArchive, updateSessionEcho])
  /**
   * 归档墓碑的权威收敛点：挂载 push 的**权威**归档集命名该 id 即退休（degraded 视图
   * 的空集绝不能传进来——那会把墓碑全撤掉）。与其它两个回声收敛点同位置（ready 门
   * 之前：权威归档集与聚合是否已提交无关）。
   */
  const reconcileArchiveEchoes = useCallback((sourceId: string, archivedSessionIds: readonly string[]): void => {
    const next = reconcilePendingArchives(sessionArchiveRef.current, sourceId, archivedSessionIds)
    if (next !== sessionArchiveRef.current) updateSessionArchive(next)
  }, [updateSessionArchive])
  useEffect(() => {
    return chamberBridge.onInstanceSnapshot((
      sourceId,
      snapshot: InstanceSnapshot | undefined,
      sourceFingerprint,
    ) => {
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const currentSource = sourceLifecyclesRef.current!.capture(sourceId)
      if (currentSource === null || currentSource.fingerprint !== sourceFingerprint) return
      aggregatePollSeqRef.current[sourceId] = (aggregatePollSeqRef.current[sourceId] ?? 0) + 1
      aggregateRequestOwnersRef.current!.retire([sourceId])
      if (snapshot === undefined) {
        // Withdraw ONLY a source that never pushed (nothing to keep); a
        // source with a last push keeps its mounted marker and recency so
        // planAggregateRefreshes never re-enables the unary fallback for it.
        if (snapshotAtRef.current[sourceId] === undefined) {
          delete snapshotSourcesRef.current[sourceId]
          delete snapshotAtRef.current[sourceId]
        }
      } else {
        snapshotSourcesRef.current[sourceId] = true
        snapshotAtRef.current[sourceId] = Date.now()
        // 成功验证：push 与 unary 提交同权，记水位并撤下呈现。
        factsAtRef.current[sourceId] = Date.now()
        setUnverified(prev => (prev.includes(sourceId) ? prev.filter(id => id !== sourceId) : prev))
      }
      setSnapshotSources(prev => {
        if (snapshot === undefined) {
          if (snapshotAtRef.current[sourceId] !== undefined) return prev
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        }
        if (prev[sourceId] === true) return prev
        return { ...prev, [sourceId]: true }
      })
      if (snapshot === undefined) return
      {
        // TTL first, then retire whatever the authoritative list now covers: the
        // mounted push is the echo's convergence signal, so an entry it lists has
        // no job left and must not survive as a duplicate.
        const swept = sweepPendingWorkspaces(workspaceEchoRef.current, Date.now())
        const reconciled = reconcilePendingWorkspaces(swept, sourceId, snapshot.workspaces)
        if (reconciled !== workspaceEchoRef.current) updateWorkspaceEcho(reconciled)
      }
      // 会话创建回声的权威收敛点：挂载壳自己的
      // 会话列表 + 工作区 follow 基线一旦把该会话**归属**到某个工作区（成员位，
      // 含合成行），回声条目立刻退休——权威行从此渲染它。刻意只看成员位、不看
      // sessions 列表：只列出而无所属时退休会把行抛进未分组桶，正是回声要避免的
      // 位置跳动。与工作区收敛同规：放在 ready 门之前（权威归属与聚合是否已提交
      // 无关）。该收敛同时覆盖「官方 session-list 刷新后 id 回来了但基线尚未归
      // 属」的中间态：中间态里回声仍在，行不会消失。
      {
        const swept = sweepPendingSessions(sessionEchoRef.current, Date.now())
        const reconciled = reconcilePendingSessions(swept, sourceId, snapshot.workspaces)
        if (reconciled !== sessionEchoRef.current) updateSessionEcho(reconciled)
      }
      // 归档墓碑的权威收敛：只有挂载壳的 workspace follow 基线才带得出
      // 「宿主归档集」这一事实（archiveSetKnown），因此只认这一条；degraded 视图的
      // 空集绝不能传进去。
      if (snapshot.archiveSetKnown === true) {
        reconcileArchiveEchoes(sourceId, snapshot.archivedSessionIds)
      }
      // A mounted ctx can deliver a late store notification after its
      // transport generation died. Keep producer ownership, but never let
      // that notification overwrite the authoritative not-connected row;
      // the next ready edge performs one unary refresh.
      if (!readyAggregateSourcesRef.current.has(sourceId)) return
      // design 24  (archive-cleanup convergence): an archived-set SHRINK
      // in a mounted push is the client-observable "a purge completed" signal
      // (no unarchive wire — only the cleanup purge removes set members). The
      // purged sessions' rows may still linger in the official client session
      // summaries of this mounted ctx (refreshed only on connection
      // generations; host purge events are documented no-ops), so once the set
      // stops covering them they would render as ordinary rows and open with
      // session/not-found. Convergence state machine (planSessionListRefresh),
      // evaluated on EVERY ready push: removed ids still listed as rows become
      // pending ghosts; the source's ctx is asked to re-run its OFFICIAL
      // session-list refresh (sidebar-plugin subscriber — reconciles the
      // summaries against the server corpus and drops the deleted rows); the
      // resulting producer push then clears the pending set. A refresh that
      // fails transiently is re-requested on a later push (cadence floored by
      // SESSION_LIST_REFRESH_COALESCE_MS so a failing refresh on a busy source
      // cannot stack RPCs); a suppressed dispatch never loses the ids — they
      // stay pending and re-evaluate on the next push. Quiet sources with no
      // further push self-hide within one watchdog cycle (the 30s merge pull
      // replaces the aggregate's session rows with the clean unary list).
      // Remember the last AUTHORITATIVE archive set (see the ref's doc): used
      // as the shrink baseline when the committed aggregate lost provenance,
      // and as the archived-row filter for a degraded commit. ORDER IS
      // LOAD-BEARING: the PRE-update value is the
      // baseline — updating the memory first would make the remembered set
      // equal to the incoming snapshot's own set, so archiveSetShrink could
      // never observe a shrink (the fallback branch would be dead code).
      const rememberedArchiveSet = authoritativeArchiveSetRef.current[sourceId]
      if (snapshot.archiveSetKnown === true) {
        authoritativeArchiveSetRef.current[sourceId] = snapshot.archivedSessionIds
      }
      const decision = planSessionListRefresh(
        watchdogAggregatesRef.current[sourceId],
        snapshot,
        sessionListRefreshPendingRef.current[sourceId],
        rememberedArchiveSet,
      )
      if (decision.pending.length > 0) sessionListRefreshPendingRef.current[sourceId] = decision.pending
      else delete sessionListRefreshPendingRef.current[sourceId]
      if (decision.request) {
        const now = Date.now()
        if (shouldRequestSessionListRefresh(
          sessionListRefreshAtRef.current[sourceId],
          now,
          SESSION_LIST_REFRESH_COALESCE_MS,
        )) {
          sessionListRefreshAtRef.current[sourceId] = now
          chamberBridge.requestSessionListRefresh(sourceId)
        }
      }
      setAggregates(prev => {
        const current = prev[sourceId]
        if (current !== undefined && current.state === 'ok'
          && instanceSnapshotSignature(current) === instanceSnapshotSignature(snapshot)) return prev
        return { ...prev, [sourceId]: { state: 'ok', ...snapshot, error: null } }
      })
      // 收割完成（design 05）：该源的首个挂载推送就是权威基线（真实
      // 工作区分组 + 归档集，`archiveSetKnown:true`）——标记已满足并立即回收
      // 后台壳，来源转入已上线的"已回收来源"态（30s unary merge 刷新会话行）。
      // 非收割挂载的推送同样满足基线需求（用户点开、retention 温壳、退避后
      // 被用户抢先点开）：不标记会让已推送过的源在回收后又被收割白 boot 一次。
      if (harvestIntentRef.current.has(sourceId)) {
        harvestIntentRef.current.delete(sourceId)
        harvestStateRef.current[sourceId] = harvestSatisfied(harvestStateRef.current[sourceId])
        // 保留**最后收割的壳当温壳**：省掉一次完整后台
        // boot，并让该源的运行时状态事实（pending/完成点）保持在线；仅当还有
        // 别的收割候选时才回收，把唯一后台槽让给基线恢复。
        if (shouldReclaimHarvestedShell(
          harvestCandidatesRef.current,
          sourceId,
          id => harvestPending(harvestStateRef.current[id]),
        )) reclaimViewRef.current(sourceId, 'harvest')
      } else {
        harvestStateRef.current[sourceId] = harvestSatisfied(harvestStateRef.current[sourceId])
      }
    })
  }, [])

  useEffect(() => {
    return chamberBridge.onPluginDiagnostic((sourceId, diagnostic) => {
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      setPluginDiagnostics(prev => {
        if (diagnostic === undefined) {
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        }
        return { ...prev, [sourceId]: diagnostic }
      })
    })
  }, [])

  useEffect(() => {
    // 保持一次性读取：Swift shim 只在 info
    // 成功后暴露 dshChamber（与 preload 同序），因此「surface 在、dshVersion 为
    // null」的形态不会出现；此处不做与 Electron 不同的有界重读。
    const version = window.dshChamber?.dshVersion ?? undefined
    if (version === undefined) return
    setHostFacts(prev => {
      const existing = prev[LOCAL_INSTANCE_ID]
      if (existing?.dshVersion === version) return prev
      return { ...prev, [LOCAL_INSTANCE_ID]: { ...(existing ?? {}), dshVersion: version } }
    })
  }, [])

  /** 每来源 ctx 的运行时事实上报（06）：report 覆盖、clear 删除；同时
   *  对账该来源的「完成未读」蓝点（completedBySource）。无需额外依赖。 */
  useEffect(() => {
    return chamberBridge.onRuntimeReport((sourceId, report, sourceFingerprint) => {
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const currentSource = sourceLifecyclesRef.current!.capture(sourceId)
      if (currentSource === null || currentSource.fingerprint !== sourceFingerprint) return
      if (report === undefined) {
        // 通道撤回（shell 重连/重 boot 窗口，来源移除的 clear 已被上方的
        // liveServerIds/指纹检查挡掉，不会到达这里）：清掉 UI 蓝点边沿、观测状态
        // 与通知账本的易失轨（withdraw 清 armed + pending，notified/outcomes 保持
        // durable，R2-D/§3.1）——恢复后首份上报按 G2 纯播种，撤回窗口内的完成
        // 不补发；pending 清理必须立即落盘（§3.5 写点纪律）。
        // 撤回不删来源账本（durable 由事实重算）；prevRunning 是「转移」不是
        // 「状态」，持久化会伪造边沿。
        if (runtimeFactsRef.current[sourceId] !== undefined) {
          const next = { ...runtimeFactsRef.current }
          delete next[sourceId]
          runtimeFactsRef.current = next
          setRuntimeFacts(next)
        }
        delete prevRunningRef.current[sourceId]
        completionObservationRef.current.delete(sourceId)
        completeLedgerRef.current.withdraw(sourceId)
        persistCompletionLedger(true)
        recomputeSourceUnread(sourceId)
        return
      }
      // runtime report 的**同步**权威镜像（v5 §3.2）：先写 ref 再进 state——同一
      // 事件轮里到达的 facts 快照/重算/收敛都读最新壳行，不依赖渲染期赋值。
      const currentReport = runtimeFactsRef.current[sourceId]
      if (currentReport === undefined || runtimeReportSignature(currentReport) !== runtimeReportSignature(report)) {
        const next = { ...runtimeFactsRef.current, [sourceId]: report }
        runtimeFactsRef.current = next
        setRuntimeFacts(next)
      }
      // 单入口收敛（设计 19 + goal-aware v5 §3.2–§3.4）：壳行与当前 facts 快照在
      // observeSource 里做权威合并（新鲜壳行优先 / 非 stale facts / unknown），
      // 候选（壳边沿、ask/request、facts 水位）交唯一 reconcile；本处只接线 + emit。
      const factsSnapshot = sessionFactsRef.current[sourceId]
      const batch = observeSource({
        state: completionObservationRef.current.get(sourceId),
        sourceId,
        identity: completionIdentity(sourceFingerprint, bootToken),
        pageBoot: bootVerdict,
        shell: { rows: report.sessions, ...(report.stale === true ? { stale: true } : {}) },
        shellReport: true,
        facts: factsChannelOf(factsSnapshot),
      })
      completionObservationRef.current.set(sourceId, batch.state)
      applyObservationBatch({
        ledger: completeLedgerRef.current,
        sourceId,
        batch,
        sink: {
          emitNotification: (notification, result) => {
            emitSessionNotification({
              sourceId,
              sourceFingerprint,
              sessionId: notification.sessionId,
              kind: notification.kind,
              ...(notification.watermark === undefined ? {} : { watermark: notification.watermark }),
              ...(notification.title === undefined ? {} : { title: notification.title }),
              ...(notification.origin === undefined ? {} : { origin: notification.origin }),
              ...(result.pendingAge === undefined ? {} : { pendingAge: result.pendingAge }),
            })
          },
          countDisposition: outcome => notificationLedger.countReconcile(outcome),
          persist: immediate => persistCompletionLedger(immediate),
        },
      })
      // 派生账本重算：规则全在纯模块
      // unread-derivation.ts（4 参 deriveUnread + 通道边沿机）；「正在阅读」谓词
      // = paintedView ∩ 该来源 current ∩ hasFocus，listComplete 是唯一剪枝门。
      recomputeSourceUnread(sourceId)
    })
  }, [])
}
