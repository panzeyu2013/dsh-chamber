/**
 * 聚合刷新簇：App.tsx 的「unary 快照拉取 / 有界刷新波 / 边沿轮询 / 陈旧 watchdog +
 * 会话权威升级 ladder」整段抽出。判定内核全在既有纯模块（aggregate-refresh.ts /
 * source-readiness.ts / dsh-stream-state 的 ladder）；本 hook 只做装配与定时器生命周期：
 * refreshAggregate（按实例取序的拉取 + 有界重试）、runBoundedAggregateWave（至多
 * AGGREGATE_POLL_CONCURRENCY 并发一波）、pollAggregates（连接/生产者变化的边沿重估）、
 * runStalenessWatchdogNow（30s 陈旧臂 + http 重连臂 + 权威 ladder）。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  chamberBridge,
  emptyAggregate,
  fetchInstanceSnapshot,
  getInstanceClient,
  instanceSnapshotSignature,
  isInstanceUnavailable,
  reconcilePendingSessions,
  refreshPendingArchives,
  type InstanceAggregate,
  type SessionArchiveLedger,
  type SessionEchoLedger,
} from '@dsh-chamber/dsh-chamber-client-core'
import type { EchoStore } from '../host/echo-store.ts'
import type { FactsStore } from '../host/facts-store.ts'
import type { MountedSourcesStore } from '../host/mounted-sources-store.ts'
import {
  commitAggregateFailure,
  commitAggregatePull,
  planAggregateRefreshes,
  refreshPullStillCurrent,
  isFallbackDerivedView,
  isSnapshotStale,
  reconnectStalenessMsForTransport,
  shouldDropUnverifiedRunningFacts,
  shouldRebaselineFallbackView,
  shouldReconnectStaleMounted,
  shouldRetainPushedAggregate,
  type AggregateRefreshQueue,
} from '../aggregate-refresh.ts'
import type { HealthResponse } from '../api.ts'
import type { SourceOwnershipRegistry } from '../deep-link-activation.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { shouldRunBackgroundPhase } from '../retention.ts'
import { reconnectInstanceConnection } from '../shell.ts'
import { errorMessage } from '../status.ts'
import { instanceConnected, sourceIdForInstance } from '../transport-source.ts'
import type { SshInstanceSpec, SshStatusProjection } from '../global.d.ts'
import { planLadder, type LadderObservation, type LadderRecord } from '@dsh-chamber/dsh-stream-state'

/** Staleness watchdog cadence, also the staleness threshold: a ready source
 *  whose last PUSHED snapshot is older is re-pulled from the authority. */
const AGGREGATE_FALLBACK_POLL_MS = 30_000
/** Bounded wave over whatever edge-triggered refresh set a poll produces. */
const AGGREGATE_POLL_CONCURRENCY = 4
/** First-screen retry: a transient snapshot failure is retried quickly (bounded), not after 30s. */
const AGGREGATE_RETRY_MS = 3_000
const AGGREGATE_RETRY_LIMIT = 5

/** The ready/not-ready partition of all known sources, driven solely by the
 *  authoritative transport state. */
function collectReadySourceIds(
  health: HealthResponse | null,
  remoteStatus: Record<string, SshStatusProjection>,
  remoteInstances: SshInstanceSpec[],
): { ready: string[]; notReady: string[] } {
  const ready: string[] = []
  const notReady: string[] = []
  if (instanceConnected('local', health, remoteStatus, LOCAL_INSTANCE_ID)) ready.push(LOCAL_INSTANCE_ID)
  else notReady.push(LOCAL_INSTANCE_ID)
  for (const instance of remoteInstances) {
    const id = sourceIdForInstance(instance)
    if (instanceConnected(instance.kind, health, remoteStatus, instance.id)) ready.push(id)
    else notReady.push(id)
  }
  return { ready, notReady }
}

export interface AggregateRefreshDeps {
  // values
  aggregates: Record<string, InstanceAggregate>
  health: HealthResponse | null
  remoteInstances: SshInstanceSpec[]
  remoteStatus: Record<string, SshStatusProjection>
  /** 生产者已推送过完整快照的来源集（边沿轮询 effect 的重估依赖）。 */
  snapshotSources: Record<string, true>
  /** 会话权威升级 ladder 实例（App 的模块级单一来源）。 */
  escalationLadder: Parameters<typeof planLadder>[0]
  /** 同一陈旧 MOUNTED 来源两次重连之间的最小间隔（App 模块级常量；JSX 也用）。 */
  reconnectBackoffMs: number
  // setters
  setAggregates: Dispatch<SetStateAction<Record<string, InstanceAggregate>>>
  setHostFacts: Dispatch<SetStateAction<Record<string, { dshVersion?: string } | undefined>>>
  factsStore: FactsStore
  // callbacks
  clearAggregateRetry: (sourceId: string) => void
  refreshHealth: () => Promise<void>
  sweepSessionArchive: () => void
  sweepSessionEcho: () => void
  sweepWorkspaceEcho: () => void
  updateSessionArchive: (next: SessionArchiveLedger) => void
  updateSessionEcho: (next: SessionEchoLedger) => void
  // refs
  aggregateFailuresRef: { current: Record<string, number> }
  aggregatePollRunningRef: { current: boolean }
  aggregatePollSeqRef: { current: Record<string, number> }
  aggregateRefreshQueueRef: { current: AggregateRefreshQueue }
  aggregateRequestOwnersRef: { current: SourceOwnershipRegistry | null }
  aggregateRetryTimersRef: { current: Map<string, ReturnType<typeof setTimeout>> }
  authoritativeArchiveSetRef: { current: Record<string, readonly string[]> }
  factsAtRef: { current: Record<string, number> }
  factsPullInFlightRef: { current: Record<string, number> }
  lastReconnectAtRef: { current: Record<string, number> }
  mutationRefreshSeqRef: { current: Record<string, number> }
  readyAggregateSourcesRef: { current: Set<string> }
  echoStore: EchoStore
  snapshotAtRef: { current: Record<string, number> }
  mountedSources: MountedSourcesStore
  sourceLifecyclesRef: { current: SourceOwnershipRegistry | null }
}

export interface AggregateRefresh {
  refreshAggregate: (instanceId: string, mutationTag?: number) => Promise<void>
  refreshAggregateRef: { current: (instanceId: string, mutationTag?: number) => Promise<void> }
  pollAggregatesRef: { current: () => void }
  runStalenessWatchdogRef: { current: () => void }
  /** 会话停滞横幅（watchdog notice 闩锁）的可见集合。 */
  stalledSources: readonly string[]
  /** 用户已忽略的停滞来源。 */
  dismissedStalls: readonly string[]
  setDismissedStalls: Dispatch<SetStateAction<readonly string[]>>
  /** 事实越界、无法确认会话状态的来源。 */
  unverifiedSources: readonly string[]
  /** 唯一标记写入口（同步更新 ref；失败分支与 dismiss 剪枝共读）。 */
  setUnverified: (updater: (prev: readonly string[]) => readonly string[]) => void
  unverifiedSourcesRef: { current: readonly string[] }
  /** aggregates 的渲染期镜像（桥订阅读最新值，不因每次推送重建订阅）。 */
  watchdogAggregatesRef: { current: Record<string, InstanceAggregate> }
}

export function useAggregateRefresh(deps: AggregateRefreshDeps): AggregateRefresh {
  const {
    aggregates, health, remoteInstances, remoteStatus, snapshotSources,
    escalationLadder, reconnectBackoffMs,
    setAggregates, setHostFacts, factsStore,
    clearAggregateRetry, refreshHealth, sweepSessionArchive, sweepSessionEcho,
    sweepWorkspaceEcho, updateSessionArchive, updateSessionEcho,
    aggregateFailuresRef, aggregatePollRunningRef, aggregatePollSeqRef,
    aggregateRefreshQueueRef, aggregateRequestOwnersRef, aggregateRetryTimersRef,
    authoritativeArchiveSetRef, factsAtRef, factsPullInFlightRef,
    lastReconnectAtRef, mutationRefreshSeqRef, readyAggregateSourcesRef,
    echoStore, snapshotAtRef, mountedSources,
    sourceLifecyclesRef,
  } = deps

/**
 * 拉取一个实例的 workspace/session 快照（失败落 error 态，由轮询重试）。每次调用
 * 按实例取序并递增；resolve/reject 时仅当捕获的序号仍是最新才落 state——避免慢轮询
 * 覆盖拖拽提交后的即时刷新（陈旧排序）。
 */
  const refreshAggregate = useCallback(async (instanceId: string, mutationTag?: number) => {
    const sourceOwner = sourceLifecyclesRef.current!.capture(instanceId)
    if (sourceOwner === null) return
    // 行刷新提示的 inFlight 拒绝输入：计数而不是布尔，最后一个结束才归零。
    factsPullInFlightRef.current[instanceId] = (factsPullInFlightRef.current[instanceId] ?? 0) + 1
    try {
    const startedPollSeq = (aggregatePollSeqRef.current[instanceId] ?? 0) + 1
    aggregatePollSeqRef.current[instanceId] = startedPollSeq
    if (mutationTag !== undefined) aggregateRequestOwnersRef.current!.retire([instanceId])
    const requestOwner = mutationTag === undefined
      ? aggregateRequestOwnersRef.current!.renew(instanceId)
      : null
    const stillOwnsSource = (): boolean => sourceLifecyclesRef.current!.owns(sourceOwner)
    const stillCurrent = (): boolean => stillOwnsSource()
      && refreshPullStillCurrent({
        mutationTag,
        mutationSeq: mutationRefreshSeqRef.current[instanceId],
        pollSeq: aggregatePollSeqRef.current[instanceId] ?? 0,
        startedPollSeq,
      })
      && (requestOwner === null || aggregateRequestOwnersRef.current!.owns(requestOwner))
    const scheduleRetry = (): void => {
      const mutationStillCurrent = mutationTag === undefined
        ? stillCurrent()
        : stillOwnsSource() && mutationRefreshSeqRef.current[instanceId] === mutationTag
      if (!mutationStillCurrent) return
      const failures = aggregateFailuresRef.current[instanceId] ?? 0
      if (failures >= AGGREGATE_RETRY_LIMIT) {
        delete aggregateFailuresRef.current[instanceId]
        return
      }
      aggregateFailuresRef.current[instanceId] = failures + 1
      clearAggregateRetry(instanceId)
      const retryTimer = setTimeout(() => {
        if (aggregateRetryTimersRef.current.get(instanceId) === retryTimer) {
          aggregateRetryTimersRef.current.delete(instanceId)
        }
        // 窗口隐藏期不维持 3s 失败重试链；恢复可见由 visibilitychange 的 watchdog 补偿。
        if (!shouldRunBackgroundPhase(document.visibilityState)) return
        const mayRetry = mutationTag === undefined
          ? stillCurrent()
          : stillOwnsSource() && mutationRefreshSeqRef.current[instanceId] === mutationTag
        if (mayRetry) void refreshAggregate(instanceId, mutationTag)
      }, AGGREGATE_RETRY_MS)
      aggregateRetryTimersRef.current.set(instanceId, retryTimer)
    }
    try {
      const snapshot = await fetchInstanceSnapshot(getInstanceClient(instanceId))
      if (!stillCurrent()) return
      delete aggregateFailuresRef.current[instanceId]
      clearAggregateRetry(instanceId)
      // 工作区回声 TTL 挂在同一条 unary 兜底链上：未挂载来源没有 push，30s 兜底是其
      // 唯一周期时钟，否则永不被权威列表覆盖的回声会一直留在投影里。
      sweepWorkspaceEcho()
      // 会话回声同理；未推送来源在列表归属到该会话时立即收敛。已推送来源刻意不做：
      // mounted merge 保留权威工作区行，用兜底合成行收敛会把行抛进未分组桶（位置跳动）。
      sweepSessionEcho()
      if (mountedSources.getSnapshot()[instanceId] !== true) {
        const reconciled = reconcilePendingSessions(echoStore.getSnapshot().session, instanceId, snapshot.workspaces)
        updateSessionEcho(reconciled)
      }
      // 归档墓碑租约挂同一条兜底时钟：只要视图还在列该会话就继续藏着；权威归档集只
      // 可能来自挂载 push，这里绝不用兜底空集收敛。顺序是契约：**先续租、再回收**——
      // 回收是全账本的，先回收会让离线来源重连后墓碑被别的来源清掉、归档行回浮。
      {
        const listed = new Set(snapshot.sessions.map(session => session.sessionId))
        const leased = refreshPendingArchives(echoStore.getSnapshot().archive, instanceId, listed, Date.now())
        updateSessionArchive(leased)
      }
      sweepSessionArchive()
      // identity-preserving：快照内容未变（兜底/手动刷新常态）则复用旧 state 对象，
      // 避免恒新对象触发全量侧边栏重渲染；错误分支仍无条件覆盖。兜底只贡献 sessions，
      // 工作区分组/归档集保持权威（否则 30s 空闲重拉会造成 archived-resurfacing）。
      setAggregates(prev => {
        const current = prev[instanceId]
        const next = commitAggregatePull(
          current,
          snapshot,
          mountedSources.getSnapshot()[instanceId] === true,
          authoritativeArchiveSetRef.current[instanceId],
        )
        if (current !== undefined && current.state === 'ok'
          && instanceSnapshotSignature(current) === instanceSnapshotSignature(next)) {
          return prev
        }
        return { ...prev, [instanceId]: next }
      })
      // 事实重新可验证：记水位并撤下「无法确认」呈现。
      factsAtRef.current[instanceId] = Date.now()
      setUnverified(prev => (prev.includes(instanceId) ? prev.filter(id => id !== instanceId) : prev))
    } catch (err) {
      if (!stillOwnsSource()) return
      // A push/newer pull supersedes an error fact: a stale failure must never replace a healthy push.
      if ((aggregatePollSeqRef.current[instanceId] ?? 0) !== startedPollSeq) {
        scheduleRetry()
        return
      }
      if (!stillCurrent()) return
      // 失败说明不了推送通道，置 error 只会隐藏权威推送状态（与 withdrawal 窗口同规）；
      // 未推送源维持原 error 态与快速重试。推送与 unary 同时死亡时视图静默冻结在最后
      // 推送状态，比展示劣化/空态诚实。
      const failureAggregate = commitAggregateFailure(
        mountedSources.getSnapshot()[instanceId] === true,
        errorMessage(err),
      )
      if (failureAggregate === null) {
        // 503 仍是权威"未就绪"信号：立即刷新使连接判定尽快翻转。
        if (isInstanceUnavailable(err)) void refreshHealth()
        clearAggregateRetry(instanceId)
        // 卫生：mounted 失败不走 scheduleRetry，残留失败计数一并清掉。
        delete aggregateFailuresRef.current[instanceId]
        // 保留视图有界化：读持续失败到界限后丢掉无法验证的 running 断言（只清 running
        // 位，行/分组照旧保留），并交给会话停滞横幅；下一次成功读取立即恢复。
        const retained = watchdogAggregatesRef.current[instanceId]
        if (retained !== undefined && retained.state === 'ok'
          && retained.sessions.some(session => session.running === true)
          && shouldDropUnverifiedRunningFacts({
            factsAt: factsAtRef.current[instanceId],
            now: Date.now(),
          })) {
          setAggregates(prev => {
            const current = prev[instanceId]
            if (current === undefined || current.state !== 'ok') return prev
            if (!current.sessions.some(session => session.running === true)) return prev
            return {
              ...prev,
              [instanceId]: {
                ...current,
                sessions: current.sessions.map(session => (
                  session.running === true ? { ...session, running: false } : session)),
              },
            }
          })
          setUnverified(prev => (prev.includes(instanceId) ? prev : [...prev, instanceId]))
        }
        return
      }
      setAggregates(prev => ({ ...prev, [instanceId]: failureAggregate }))
      // 反代 503 = 权威"未就绪"信号：立即刷新使连接判定尽快翻转。
      if (isInstanceUnavailable(err)) void refreshHealth()
      // 首屏加速：一次瞬时失败不等到 30s 兜底轮询，限次快速重试。
      scheduleRetry()
    }
    } finally {
      const remaining = (factsPullInFlightRef.current[instanceId] ?? 1) - 1
      if (remaining <= 0) delete factsPullInFlightRef.current[instanceId]
      else factsPullInFlightRef.current[instanceId] = remaining
    }
  }, [clearAggregateRetry, refreshHealth, sweepSessionArchive, sweepSessionEcho, sweepWorkspaceEcho, updateSessionArchive, updateSessionEcho])
  /** facts 提示的稳定入口（lifecycle effect 的闭包只创建一次，取最新 refreshAggregate）。 */
  const refreshAggregateRef = useRef(refreshAggregate)
  refreshAggregateRef.current = refreshAggregate

/** Run a bounded wave: at most AGGREGATE_POLL_CONCURRENCY concurrent pulls, one
 *  wave at a time, shared by the edge poll and the watchdog. */
  const runBoundedAggregateWave = useCallback((sourceIds: string[]) => {
    aggregateRefreshQueueRef.current.enqueue(sourceIds)
    if (aggregateRefreshQueueRef.current.size === 0 || aggregatePollRunningRef.current) return
    aggregatePollRunningRef.current = true
    void (async () => {
      try {
        while (aggregateRefreshQueueRef.current.size > 0) {
          const queuedSourceIds = aggregateRefreshQueueRef.current.take()
          let cursor = 0
          const worker = async () => {
            while (cursor < queuedSourceIds.length) {
              const sourceId = queuedSourceIds[cursor]
              cursor += 1
              await refreshAggregate(sourceId)
            }
          }
          await Promise.all(Array.from(
            { length: Math.min(AGGREGATE_POLL_CONCURRENCY, queuedSourceIds.length) },
            () => worker(),
          ))
        }
      } finally {
        aggregatePollRunningRef.current = false
      }
    })()
  }, [refreshAggregate])

/** 刷新需要兜底/刚重连的就绪实例；未就绪实例落 not-connected（已推送挂载来源除外）。 */
  const pollAggregates = useCallback(() => {
    const { ready, notReady } = collectReadySourceIds(health, remoteStatus, remoteInstances)
    const refreshPlan = planAggregateRefreshes(
      ready,
      readyAggregateSourcesRef.current,
      mountedSources.getSnapshot(),
    )
    // Commit the observed generation synchronously: an overlapping callback must not mint duplicate pulls.
    readyAggregateSourcesRef.current = refreshPlan.nextReady
    runBoundedAggregateWave(refreshPlan.refreshSourceIds)
    if (notReady.length > 0) {
      aggregateRefreshQueueRef.current.delete(notReady)
      // A pull started in the dying generation must never restore an `ok` aggregate.
      aggregateRequestOwnersRef.current!.retire(notReady)
      for (const sourceId of notReady) {
        aggregatePollSeqRef.current[sourceId] = (aggregatePollSeqRef.current[sourceId] ?? 0) + 1
        mutationRefreshSeqRef.current[sourceId] = (mutationRefreshSeqRef.current[sourceId] ?? 0) + 1
      }
      setAggregates(prev => {
        let changed = false
        const next = { ...prev }
        for (const id of notReady) {
          const current = next[id]
          if (current === undefined) {
            next[id] = emptyAggregate('not-connected')
            changed = true
          } else if (current.state !== 'not-connected'
            // 本就以 connected 为门，保留它让重连后的 ready-edge 拉取走 sessions-only
            // merge；未推送/未挂载来源照旧落 not-connected。
            && !shouldRetainPushedAggregate(mountedSources.getSnapshot()[id] === true, current)) {
            next[id] = emptyAggregate('not-connected')
            changed = true
          }
        }
        return changed ? next : prev
      })
      // 断连即清该来源的运行时事实（generation 级事实随断连失效）
      factsStore.setRuntime(prev => {
        let changed = false
        const next = { ...prev }
        for (const id of notReady) {
          if (next[id] !== undefined) {
            delete next[id]
            changed = true
          }
        }
        return changed ? next : prev
      })
      // Host facts are generation-scoped too: a disconnected source keeps no version from the old generation.
      setHostFacts(prev => {
        let changed = false
        const next = { ...prev }
        for (const id of notReady) {
          if (next[id] !== undefined) {
            delete next[id]
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
  }, [health, remoteStatus, remoteInstances, refreshAggregate, runBoundedAggregateWave])

  const pollAggregatesRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    pollAggregatesRef.current = pollAggregates
  })

  // 连接事实或快照生产者变化即重估聚合，避免错误行残留到下一个轮询周期。
  useEffect(() => {
    pollAggregatesRef.current()
  }, [health, remoteStatus, remoteInstances, snapshotSources])

  // Staleness watchdog: the edge logic above only pulls newly-ready or
  // never-pushed sources, so a mounted producer whose push channel silently
  // dies (no withdrawal — aggregate-store clear() never fires) would leave
  // its aggregate stale forever. Every tick, pull any ready source whose
  // last PUSHED snapshot is older than the threshold. Actively pushing
  // sources are never pulled; the bounded wave keeps quiet-fleet cost at a
  // handful of loopback requests per minute and the signature dedup keeps
  // unchanged state churn-free.
  // Render-phase mirror of the aggregates state for this interval (the timer
  // must stay stable across aggregate commits — re-creating it on every push
  // would stretch the cadence under activity; the same single-source discipline
  // host/remotes-store.ts applies to the remote projection).
  const watchdogAggregatesRef = useRef(aggregates)
  watchdogAggregatesRef.current = aggregates
  // 运行位活性守卫：运行时事实直接从 factsStore 快照读（timer 稳定，不因每次
  // 上报重建；事实写入即刻对守卫可见，无渲染期镜像）。
  const escalationRecordsRef = useRef<Record<string, LadderRecord>>({})
  /** 已亮 notice 的来源 → 亮灯时的 progressStamp（健康进展即撤下）。 */
  const noticeProgressRef = useRef<Record<string, number>>({})
  const [stalledSources, setStalledSources] = useState<readonly string[]>([])
  // 用户已「忽略」的停滞来源：同一停滞时段不再重复提示，来源恢复（离开
  // stalled）时自动解除忽略。
  const [dismissedStalls, setDismissedStalls] = useState<readonly string[]>([])
/** 事实已越界无法验证的来源：与 stalledSources 共用停滞横幅，下次成功读取即移除。 */
  const [unverifiedSources, setUnverifiedSources] = useState<readonly string[]>([])
  // 渲染期镜像（与 watchdogAggregatesRef 同纪律）：watchdog 回调不因它重建定时器。
  const unverifiedSourcesRef = useRef(unverifiedSources)
  unverifiedSourcesRef.current = unverifiedSources
/**
 * 唯一标记写入口：除 setState 外**同步**更新 ref——同 tick 的 dismiss 剪枝与失败
 * 分支都读 ref，否则刚被判「无法确认」的来源会被旧快照误判成已恢复。
 */
  const setUnverified = (updater: (prev: readonly string[]) => readonly string[]): void => {
    setUnverifiedSources(prev => {
      const next = updater(prev)
      unverifiedSourcesRef.current = next
      return next
    })
  }
  // A stale MOUNTED direct-http source additionally gets a lightweight connection
  // reconnect (bounded by lastReconnectAtRef) so the ctx's own chain re-establishes
  // the frozen workspace follow — the unary pull only refreshes session rows and
  // cannot heal the push channel. Cadence: a healthy-but-quiet source rebaselines
  // after each reconnect (refreshing snapshotAt, so the next reconnect is one
  // transport threshold later); a truly dead channel retries every backoff window —
  // bounded churn that keeps probing until the channel heals or the source leaves ready.
  // tick 主体抽成可即时调用的回调：周期 interval 与 visibilitychange 恢复补偿共用。
  const runStalenessWatchdogNow = useCallback(() => {
    const now = Date.now()
    const ready = collectReadySourceIds(health, remoteStatus, remoteInstances).ready
    const staleIds = ready
      .filter(id => isSnapshotStale(snapshotAtRef.current[id], now, AGGREGATE_FALLBACK_POLL_MS))
    if (staleIds.length > 0) runBoundedAggregateWave(staleIds)
    // The reconnect arm is scoped to DIRECT-HTTP sources (gateway- and dsh-kind
    // alike); ssh-transport targets are excluded (tunnel keepalive/loopback
    // stability already protect them), and there is no host-loopback exclusion —
    // unlike the transport-keepalive arm, this one also heals ctx-level freezes
    // (e.g. a dsh-restart rebaseline gap), so a local gateway dev target stays
    // covered and merely bounces every ~2min. Threshold by transport: http 120s
    // (no upstream heartbeat), ssh 5min last resort, local/unknown skipped.
    const transportBySourceId = new Map(
      remoteInstances.map(instance => [sourceIdForInstance(instance), instance.transport]),
    )
    // 本 tick 内真正执行过 reconnect 的来源（三条臂共享）：用局部集合而不是墙钟窗口
    // 判断，避免把已到期的 L2 推迟一个退避周期。**每条执行了 reconnect 的臂都必须
    // 登记**——漏登记会让后面的臂对同一来源再重连一次。
    const reconnectedThisTick = new Set<string>()
    for (const id of ready) {
      if (id === LOCAL_INSTANCE_ID) continue
      const stalenessMs = reconnectStalenessMsForTransport(transportBySourceId.get(id))
      if (stalenessMs === null) continue
      // mounted = "the ctx producer pushed at least one snapshot this generation":
      // a channel dead from first boot never pushes and stays on the unary fallback.
      if (!shouldReconnectStaleMounted({
        mounted: mountedSources.getSnapshot()[id] === true,
        lastSnapshotAt: snapshotAtRef.current[id],
        lastReconnectAt: lastReconnectAtRef.current[id],
        now,
        stalenessMs,
        reconnectBackoffMs,
      })) continue
      // Record the attempt synchronously with firing so overlapping ticks cannot
      // double-fire — but only when reconnect() was actually invoked: a no-op must not
      // consume the backoff window. NOTE: each reconnect resets the ctx's official
      // exponential backoff to an immediate retry (MANUAL_RECONNECT), so a ready-but-dead
      // target probes at a fixed ~60s cadence until the main-process reverify flips it to
      // not-connected. Bounded and intended.
      if (reconnectInstanceConnection(id)) {
        lastReconnectAtRef.current[id] = now
        reconnectedThisTick.add(id)
      }
    }
    for (const id of ready) {
      if (id === LOCAL_INSTANCE_ID) continue
      if (!shouldRebaselineFallbackView({
        mounted: mountedSources.getSnapshot()[id] === true,
        fallbackView: isFallbackDerivedView(watchdogAggregatesRef.current[id]),
        lastReconnectAt: lastReconnectAtRef.current[id],
        now,
        reconnectBackoffMs,
      })) continue
      if (reconnectInstanceConnection(id)) {
        lastReconnectAtRef.current[id] = now
        reconnectedThisTick.add(id)
      }
    }
    // 会话事实单一权威：producer 执行端持有 reducer 与 probe cadence，这里只给它一个
    // 30s tick，并在**拿不到权威结论**的 stuck 证据上跑升级 ladder（reconnect → notice）。
    // 绝不按静默时长升级：合法静默与真卡死在本层不可区分，误升级会重放全部 baseline。
    const escalationObservations: Record<string, LadderObservation | undefined> = {}
    for (const id of ready) {
      const report = factsStore.getSnapshot().runtime[id]
      const sessions = report?.sessions ?? {}
      const sticky = Object.values(sessions).some(facts => facts?.running === true)
      if (sticky) chamberBridge.requestSessionListRefresh(id)
      const authority = report?.sessionAuthority
      escalationObservations[id] = {
        sticky,
        symptomSinceMs: authority?.runningSince ?? now,
        progressStamp: authority?.progressStamp ?? 0,
        stuckEvidence: authority?.stuckSince !== undefined,
        // 共享重连账本：挡住时不派遣，也不消耗 ladder 配额。
        escalationBlocked: reconnectedThisTick.has(id)
          || (lastReconnectAtRef.current[id] !== undefined
            && now - lastReconnectAtRef.current[id] < reconnectBackoffMs),
      }
    }
    const escalationPlan = planLadder(
      escalationLadder, escalationRecordsRef.current, escalationObservations, now)
    escalationRecordsRef.current = escalationPlan.records
    for (const action of escalationPlan.actions) {
      // watchdog 绝不向 App 抛错；动作次数由 ladder 自身的冷却/配额封顶，日志有界。
      try {
        if (action.tier === 'reconnect') {
          // 与既有臂共用同一份 per-source 账本：同一 tick（或跨 tick）已重连过的不再重连。
          if (reconnectedThisTick.has(action.sourceId)) continue
          const lastReconnectAt = lastReconnectAtRef.current[action.sourceId]
          if (lastReconnectAt !== undefined && now - lastReconnectAt < reconnectBackoffMs) {
            console.warn(`[renderer] session-authority: ${action.sourceId} was reconnected ${String(Math.round((now - lastReconnectAt) / 1000))}s ago; deferring`)
            continue
          }
          console.warn(`[renderer] session-authority: reconciler stuck for ${action.sourceId}; reconnecting`)
          if (reconnectInstanceConnection(action.sourceId)) {
            lastReconnectAtRef.current = { ...lastReconnectAtRef.current, [action.sourceId]: now }
            reconnectedThisTick.add(action.sourceId)
          }
        } else if (action.tier === 'notice') {
          // notice 是闩锁：记下亮灯时的 progressStamp，健康进展或症状消失才撤下。
          noticeProgressRef.current = {
            ...noticeProgressRef.current,
            [action.sourceId]: escalationObservations[action.sourceId]?.progressStamp ?? 0,
          }
        }
      } catch (error) {
        console.error('[renderer] session-authority escalation failed:', error)
      }
    }
    const stalledNow: string[] = []
    for (const [id, stamp] of Object.entries(noticeProgressRef.current)) {
      const observation = escalationObservations[id]
      const stillStalled = observation?.sticky === true
        && (observation.progressStamp ?? 0) <= stamp
      if (stillStalled) stalledNow.push(id)
      else delete noticeProgressRef.current[id]
    }
    setStalledSources(prev => (prev.length === stalledNow.length
      && prev.every((id, index) => id === stalledNow[index])
      ? prev
      : [...stalledNow]))
    setDismissedStalls(prev => {
      // 只在「既未停滞、也未被判无法验证」时解除忽略：只看 stalledNow 会把
      // 「无法确认」来源的忽略立刻剪掉 ⇒ 横幅反复重现。
      const next = prev.filter(id => stalledNow.includes(id)
        || unverifiedSourcesRef.current.includes(id))
      return next.length === prev.length ? prev : next
    })
  }, [health, remoteStatus, remoteInstances, runBoundedAggregateWave])
  const runStalenessWatchdogRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    runStalenessWatchdogRef.current = runStalenessWatchdogNow
  })

  // Cadence + 文档可见性门控：窗口隐藏（最小化/托盘）期跳过周期 unary 拉取与
  // reconnect 臂；恢复可见立即补偿一轮。回收但仍 ready 的源靠可见期的 30s 兜底检测任务完成。
  useEffect(() => {
    const timer = setInterval(() => {
      if (!shouldRunBackgroundPhase(document.visibilityState)) return
      runStalenessWatchdogRef.current()
    }, AGGREGATE_FALLBACK_POLL_MS)
    return () => { clearInterval(timer) }
  }, [])

  return {
    refreshAggregate,
    refreshAggregateRef,
    pollAggregatesRef,
    runStalenessWatchdogRef,
    stalledSources,
    dismissedStalls,
    setDismissedStalls,
    unverifiedSources,
    setUnverified,
    unverifiedSourcesRef,
    watchdogAggregatesRef,
  }
}
