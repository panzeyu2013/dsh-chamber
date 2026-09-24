/**
 * 桥订阅簇：chamberBridge 全部入站订阅与深链（已读 / 预热 / 打开会话 / 激活来源 /
 * 设置面板目标 / VS Code 深链 / 刷新 / 工作区·会话·归档回声 / 挂载快照 / 插件诊断 /
 * dshVersion / 运行时上报）。判定与账本都在既有纯模块；本 hook 只做装配与订阅生命周期，
 * 依赖面显式类型化（无 any）。
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
import { type SessionFacts } from '../notification-edges.ts'
import { planRuntimeNotifications } from '../notification-projection.ts'
import { errorMessage } from '../status.ts'
import { sourceIdForRawInstance } from '../transport-source.ts'
import { completionWatermark } from '../watermark.ts'
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
} from '@dsh-chamber/dsh-chamber-client-core'

/** 会话列表刷新合并窗（唯一消费者在本 hook）。 */
const SESSION_LIST_REFRESH_COALESCE_MS = 5_000

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
  prevRuntimeFactsRef: { current: Record<string, Record<string, SessionFacts>> }
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
    pendingDeepLinkDeliveryRef, prevRunningRef, prevRuntimeFactsRef, prewarmEligibleRef,
    prewarmQueueRef, prewarmSuppressedRef, readyAggregateSourcesRef, reclaimViewRef,
    remoteInstancesRef, remoteRosterSettledRef, sessionArchiveRef, sessionEchoRef, sessionFactsRef,
    sessionListRefreshAtRef, sessionListRefreshPendingRef, settingsTargetRef, snapshotAtRef,
    snapshotSourcesRef, sourceLifecyclesRef, watchdogAggregatesRef, workspaceEchoRef,
    setAggregates, setHostFacts, setMountedViews, setPluginDiagnostics, setRuntimeFacts,
    setSnapshotSources, setUnverified,
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
   * 意图预热：把 hover 意图的来源提到**既有**后台预热队列队首；绝不代行"点开"
   * ——被回收抑制 / 已挂载 / 收割停车 / 未就绪的来源都不在 prewarmEligible 里，
   * 意图在此原样丢弃（不删 prewarmSuppressedRef 的键，否则是"回收后立刻重新
   * boot"的空转）。用户明确点开仍走 selectView 原路（清抑制 + 挂载）。
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

  /** 侧边栏插件打开请求：请求单向（插件→App），终态经 outcome 回报（行内错误呈现）。 */
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
   * 设置面板目标来源：只做"挂载 + 保留"、绝不切换 active view（面板渲染选中来源
   * 自己的 boot ctx 台账）；未在权威 roster 里的 id 不挂载。
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

  /** VS Code OS 深链（hold/replay）：先注册监听再 ready() 放行主进程 drain；raw id
   *  经当前权威 kind roster 解析，远程来源在 roster settle 前进入单槽 pending，
   *  local 立即可激活。sshBridgeReady 即 deepLink 可用。 */
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
      // Reject a stale IPC pipe delivery when authority is installed; with no owner
      // yet, hold it for the roster-settle replay, which repeats the exact-proof check.
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
        // View activation is last-intent-wins: commit the superseded id instead
        // of leaving main's single-flight key retained forever.
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
    // Listener-before-ready is the ordering contract: ready synchronously unlocks the
    // main-process drain; retry a transient IPC failure on a bounded budget.
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

  /** 侧边栏动作成功后的即时刷新；失败落 error 态由 UI 呈现。
   *  Always pull on a mutation: the producer's push can lag the host's registry reorder. */
  useEffect(() => {
    return chamberBridge.onRefresh((sourceId) => {
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const tag = (mutationRefreshSeqRef.current[sourceId] ?? 0) + 1
      mutationRefreshSeqRef.current[sourceId] = tag
      void refreshAggregate(sourceId, tag)
    })
  }, [refreshAggregate])

  /**
   * 工作区创建回声：任一创建出口（侧栏对话框 / Git worktree 插件）上报宿主
   * workspaceId 后记入渲染端账本并并入投影（deriveServers 单一汇合点）。收敛点：
   * 挂载 push 列出同一 workspaceId / 路径（reconcilePendingWorkspaces）、来源离开
   * 注册表或 TTL 到期。这里只记录、不拉取——刷新通道负责"其它行要更新"。
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
        // Placement anchor：回声行必须渲染在主 checkout 之后，否则会先出现在列表
        // 末尾、挂载收敛时再跳上去；缺省（其它创建入口）= 追加到尾部。
        ...(fact.afterWorkspaceId === undefined ? {} : { afterWorkspaceId: fact.afterWorkspaceId }),
        // 创作意图标题（Git adopt 的分支名）：回声行生来就是最终标签。
        ...(fact.title === undefined ? {} : { title: fact.title }),
      }, now)
      if (ledger !== workspaceEchoRef.current) updateWorkspaceEcho(ledger)
    })
  }, [updateWorkspaceEcho])
  /**
   * 回声的**撤下 / 改写**通道：create 回声没有退场机制——删除会留幽灵行，且
   * **权威挂载 push 也退不掉它**（push 只调和"它列出了什么"；带真实 host id 的行
   * 工作区级动作在宿主上 fail-closed）；重命名则因账本只按路径生成 title 而像没
   * 生效。纯账本改写保持同一性：无匹配条目时返回同一引用，不触发重渲染。
   */
  useEffect(() => {
    return chamberBridge.onWorkspaceRemoved((fact) => {
      const { sourceId } = fact
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const owner = sourceLifecyclesRef.current!.capture(sourceId)
      if (owner === null) return
      // The removal can change what that source's list SHOULD contain, so it carries
      // the same TTL sweep as the create fact. Identity-preserving: a no-op costs no render.
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
   * 会话创建回声：唯一出口在 wire 成功后发布宿主会话 id，这里记入渲染端账本
   * （与打开意图同栅栏）。成员位解析 best-effort，全部来自 App 手里的权威聚合：
   * ①事实自带 workspaceId → 按宿主 id 找行取路径；②否则按父会话找到**归属**的
   * 工作区；③解析不到也照记（未分组好过缺行，TTL 有界）。记账后立刻请求挂载壳的
   * 官方 session-list 刷新：unary 侧建出的会话进挂载壳 summaries 的唯一外源是宿主
   * 的**异步**广播（竞态或丢帧都可能），未挂载来源则回声独自撑到下次基线收敛。
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
   * 会话回声的撤下半 + 归档墓碑：归档成功做两件事——①退休该会话的待定创建回声；
   * ②记一条本地归档墓碑，让**未挂载来源**上刚归档的行也立刻从列表消失（权威归档
   * 集到达即收敛）。与会话创建事实同栅栏、同账本写入路径。
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
   * 的空集绝不能传进来）。与其它两个回声收敛点同位置（ready 门之前）。
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
        // Withdraw ONLY a source that never pushed; a source with a last push
        // keeps its mounted marker and recency, so the unary fallback for it is
        // never re-enabled.
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
        // TTL first, then retire what the authoritative list covers: an entry it lists has no job left.
        const swept = sweepPendingWorkspaces(workspaceEchoRef.current, Date.now())
        const reconciled = reconcilePendingWorkspaces(swept, sourceId, snapshot.workspaces)
        if (reconciled !== workspaceEchoRef.current) updateWorkspaceEcho(reconciled)
      }
      // 会话回声的权威收敛点：挂载壳的 follow 基线把该会话**归属**到某工作区（成员位，
      // 含合成行）即退休；刻意只看成员位（只列出而无所属时退休会把行抛进未分组桶）。
      {
        const swept = sweepPendingSessions(sessionEchoRef.current, Date.now())
        const reconciled = reconcilePendingSessions(swept, sourceId, snapshot.workspaces)
        if (reconciled !== sessionEchoRef.current) updateSessionEcho(reconciled)
      }
      // 归档墓碑收敛只认挂载壳 follow 的 archiveSetKnown 事实；degraded 的空集绝不能传进去。
      if (snapshot.archiveSetKnown === true) {
        reconcileArchiveEchoes(sourceId, snapshot.archivedSessionIds)
      }
      // A mounted ctx can deliver a late notification after its transport died: keep
      // producer ownership, but never overwrite the authoritative row; next ready edge refreshes.
      if (!readyAggregateSourcesRef.current.has(sourceId)) return
      // archive-cleanup convergence: an archived-set SHRINK in a mounted push is the
      // client-observable "a purge completed" signal; purged rows can linger in this
      // ctx's official summaries and would open with session/not-found once the set
      // stops covering them. planSessionListRefresh runs on EVERY ready push:
      // removed-but-listed ids become pending ghosts and the ctx re-runs its OFFICIAL
      // session-list refresh (coalesced by SESSION_LIST_REFRESH_COALESCE_MS), whose
      // push clears them. Remember the PRE-update authoritative archive set as the
      // shrink baseline — ORDER IS LOAD-BEARING (updating first hides the shrink).
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
      // 收割完成：该源的首个挂载推送就是权威基线，标记已满足并立即回收后台壳；非收割
      // 挂载的推送同样满足基线需求——不标记会让已推送过的源在回收后又被收割白 boot 一次。
      if (harvestIntentRef.current.has(sourceId)) {
        harvestIntentRef.current.delete(sourceId)
        harvestStateRef.current[sourceId] = harvestSatisfied(harvestStateRef.current[sourceId])
        // 保留最后收割的壳当温壳：省掉一次完整后台 boot，并让该源的运行时状态
        // 事实保持在线；仅当还有别的收割候选时才回收，把唯一后台槽让给基线恢复。
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
    // 保持一次性读取：Swift shim 与 preload 同序，surface 在则 dshVersion 非
    // null；此处不做与 Electron 不同的有界重读。
    const version = window.dshChamber?.dshVersion ?? undefined
    if (version === undefined) return
    setHostFacts(prev => {
      const existing = prev[LOCAL_INSTANCE_ID]
      if (existing?.dshVersion === version) return prev
      return { ...prev, [LOCAL_INSTANCE_ID]: { ...(existing ?? {}), dshVersion: version } }
    })
  }, [])

  /** 每来源 ctx 的运行时事实上报：report 覆盖、clear 删除；同时重算该来源完成未读。 */
  useEffect(() => {
    return chamberBridge.onRuntimeReport((sourceId, report, sourceFingerprint) => {
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const currentSource = sourceLifecyclesRef.current!.capture(sourceId)
      if (currentSource === null || currentSource.fingerprint !== sourceFingerprint) return
      setRuntimeFacts(prev => {
        if (report === undefined) {
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        }
        // identity-preserving：同内容上报不换 state 对象，避免每次上报重派生 servers。
        const current = prev[sourceId]
        if (current !== undefined && runtimeReportSignature(current) === runtimeReportSignature(report)) {
          return prev
        }
        return { ...prev, [sourceId]: report }
      })
      if (report === undefined) {
        // 通道撤回（shell 重连/重 boot 窗口）：清掉 UI 蓝点与通知边沿的 prev 记忆，
        // 恢复后的首报是纯播种。wire 只有 running 位，窗口内被手动停止的会话会误报
        // 「完成」，故不补发（窗口仅到重连完成，状态在 UI 可见）。
        delete prevRunningRef.current[sourceId]
        delete prevRuntimeFactsRef.current[sourceId]
        completeLedgerRef.current.forgetArmed(sourceId)
        // 撤回不删来源账本，只清易失的转移记忆（prevRunning 是「转移」不是
        // 「状态」，持久化会伪造边沿）；durable 账本由事实重算——同代重挂/撤回后
        // 未读仍在（派生投影，账本不是唯一来源）。
        recomputeSourceUnread(sourceId)
        return
      }
      // 通知边沿单入口：两条证据（壳 running 边沿 + facts 水位）的裁决全在
      // notification-projection.ts；有可用 facts 的 complete 归 facts 入口，壳边沿只发 ask/request。
      const prevFacts = prevRuntimeFactsRef.current[sourceId]
      prevRuntimeFactsRef.current[sourceId] = report.sessions
      const factsSnapshot = sessionFactsRef.current[sourceId]
      const usableFacts = factsSnapshot !== undefined && factsSnapshot.verdict === 'ok' ? factsSnapshot : undefined
      const plan = planRuntimeNotifications({
        prev: prevFacts,
        next: report.sessions,
        factsUsable: usableFacts !== undefined,
        armed: completeLedgerRef.current.armed(sourceId),
      })
      completeLedgerRef.current.setArmed(sourceId, plan.armed)
      for (const edge of plan.edges) {
        const row = usableFacts?.rows[edge.sessionId]
        const watermark = edge.kind === 'complete'
          ? completionWatermark(row ?? {})
          : row !== undefined && row.updatedAt > 0 ? row.updatedAt : undefined
        emitSessionNotification({
          sourceId,
          sourceFingerprint,
          sessionId: edge.sessionId,
          kind: edge.kind,
          ...(watermark !== undefined ? { watermark } : {}),
        })
      }
      // 派生账本重算：规则全在纯模块 unread-derivation.ts；「正在阅读」谓词 =
      // paintedView ∩ 该来源 current ∩ hasFocus，listComplete 是唯一剪枝门。
      recomputeSourceUnread(sourceId)
    })
  }, [])
}
