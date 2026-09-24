/**
 * 聚合刷新簇（design 05/24）：App.tsx 原「unary 快照拉取 / 有界刷新波 /
 * 边沿轮询 / 陈旧 watchdog + 会话权威升级 ladder」整段抽出。
 *
 * 判定内核全部在既有纯模块（aggregate-refresh.ts / source-readiness.ts /
 * dsh-stream-state 的 ladder）；本 hook 只做装配与定时器生命周期：
 *  - refreshAggregate：按实例取序的 unary 快照拉取 + 有界失败重试；
 *  - runBoundedAggregateWave：至多 AGGREGATE_POLL_CONCURRENCY 并发的一波；
 *  - pollAggregates：连接事实 / 快照生产者变化时的边沿重估；
 *  - runStalenessWatchdogNow：30s 陈旧臂 + 直连 http 重连臂 + 会话权威 ladder。
 *
 * Hook 调用位置、useCallback 依赖数组、ref 身份与 effect 顺序与抽出前逐字一致
 * （aggregatePollRunningRef 仍由 App 持有并传入；升级 ladder 实例与
 * AGGREGATE_RECONNECT_BACKOFF_MS 也是 App 的模块级单一来源，经 deps 注入）。
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

/**
 * Staleness watchdog cadence for aggregate snapshots. Also the staleness
 * threshold: a ready source whose last PUSHED snapshot is older than this is
 * presumed to have a dead push channel and is re-pulled from the authority.
 */
const AGGREGATE_FALLBACK_POLL_MS = 30_000
/** Bounded wave over whatever edge-triggered refresh set a poll produces. */
const AGGREGATE_POLL_CONCURRENCY = 4
/** First-screen retry: a transient aggregate snapshot failure (the snapshot
 * derives from session/list cwd facts) is retried quickly (bounded), instead of
 * waiting out the 30s staleness watchdog. */
const AGGREGATE_RETRY_MS = 3_000
const AGGREGATE_RETRY_LIMIT = 5

/**
 * The ready/not-ready partition of all known sources, driven solely by the
 * authoritative transport state. Shared by the edge-triggered aggregate poll
 * and the staleness watchdog.
 */
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
   * 拉取一个实例的 workspace/session 快照（失败落 error 态，由轮询重试）。
   * 每次调用按实例取序并递增；resolve/reject 时仅当捕获的序号仍是最新才
   * 落 state——避免慢轮询在拖拽提交后的即时刷新之后落地、用旧序覆盖新序
   * （拖拽 commit 前的兜底快照可能晚于 refresh 拉取到达，造成陈旧排序）。
   */
  const refreshAggregate = useCallback(async (instanceId: string, mutationTag?: number) => {
    const sourceOwner = sourceLifecyclesRef.current!.capture(instanceId)
    if (sourceOwner === null) return
    // 行刷新提示的 inFlight 拒绝输入：计数而不是布尔，
    // 并发波/提示/看门狗重叠时最后一个结束才归零。
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
        // 窗口隐藏期不维持 3s 失败重试链——恢复可见由
        // visibilitychange 的 watchdog 补偿拉取覆盖（stale 源会被重拉，
        // 失败计数随成功路径清除）。
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
      // 工作区回声的 TTL 也挂在这条 unary 兜底链上：未挂载来源没有
      // 挂载 push 可依，30s 兜底拉取是它唯一的周期时钟——否则一条永远不会被
      // 权威列表覆盖的回声（例如工作区已在别处被删除）会一直留在投影里。
      sweepWorkspaceEcho()
      // 会话回声同理：TTL 挂同一条时钟，并且**未推送**来源（兜底提交
      // 的合成 cwd 分组就是它的投影工作区）在列表归属到该会话时立即收敛。
      // 已推送来源刻意不做这一步：commitAggregatePull 的 mounted merge 保留的是
      // 权威工作区行，用兜底的合成行收敛会把行抛进未分组桶（位置跳动）。
      sweepSessionEcho()
      if (mountedSources.getSnapshot()[instanceId] !== true) {
        const reconciled = reconcilePendingSessions(echoStore.getSnapshot().session, instanceId, snapshot.workspaces)
        updateSessionEcho(reconciled)
      }
      // 归档墓碑：租约挂在同一条兜底时钟上——只要这份（冻结/降级）视图
      // 还在列该会话，就继续藏着它；权威归档集只可能来自挂载 push，所以这里**绝不**
      // 用兜底的空归档集收敛。
      // 顺序是契约：**先续租、再回收**。回收是全账本的（任何来源的一次拉取都会清所有
      // 过期租约），若先回收，一个离线超过租约窗的来源重连后首个列表还没续上租，墓碑
      // 就被别的来源那次拉取清掉了，归档行随即回浮。反过来，只要列表仍列着该 id 就先
      // 续租：TTL 只回收"列表里已经没有"的墓碑（没什么可藏了）。
      {
        const listed = new Set(snapshot.sessions.map(session => session.sessionId))
        const leased = refreshPendingArchives(echoStore.getSnapshot().archive, instanceId, listed, Date.now())
        updateSessionArchive(leased)
      }
      sweepSessionArchive()
      // identity-preserving：快照内容未变（兜底/手动刷新常态）则复用旧 state 对象
      // ——避免恒新对象驱动 servers 重新派生并触发 publish 签名闸后面的全量
      // 侧边栏重渲染。错误分支保持无条件覆盖（error 文本
      // 是权威失败事实，不能因"看起来没变"而吞掉）。
      // 其工作区分组/归档集/state，兜底只贡献 sessions——否则 watchdog 的 30s
      // 空闲重拉会用空归档集替换聚合，全部已归档会话重新出现（archived-
      // resurfacing）。签名比较针对合并结果：合并后内容与当前一致时依旧不换对象。
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
      // A push/newer pull supersedes an error fact. Mutation success may cross
      // an interim push, but a stale failure must never replace that healthy push.
      if ((aggregatePollSeqRef.current[instanceId] ?? 0) !== startedPollSeq) {
        scheduleRetry()
        return
      }
      if (!stillCurrent()) return
      // 失败说明不了推送通道，置空/置 error 只会隐藏权威推送状态（与 withdrawal
      // 窗口保留最后视图同规）。未推送源维持原 error 态与快速重试。
      // 已知取舍：若推送通道与 unary 探针同时死亡，视图静默冻结在最后推送状态
      // （watchdog 每 30s 重探一次，503 仍触发 refreshHealth 翻转连接判定）——
      // 无错误行可看，但比展示劣化/空态诚实；与官方前端同依赖的恢复路径
      // （liveness 触发/整页刷新）一致。
      const failureAggregate = commitAggregateFailure(
        mountedSources.getSnapshot()[instanceId] === true,
        errorMessage(err),
      )
      if (failureAggregate === null) {
        // 503 仍是权威"未就绪"信号：立即刷新使连接判定尽快翻转。
        if (isInstanceUnavailable(err)) void refreshHealth()
        clearAggregateRetry(instanceId)
        // 卫生：mounted 失败不走 scheduleRetry，未推送期残留的失败计数
        // 一并清掉（成功路径与 roster 移除也会清，这里提前清无副作用）。
        delete aggregateFailuresRef.current[instanceId]
        // 保留视图有界化：事实读持续失败到界限后，
        // 不保留**无法验证**的「运行中」断言 —— 只清 running 位（行/分组照旧保留，
        // 不触发归档回流），并把该来源交给既有的会话停滞横幅（文案 = 「无法确认会话状态」）。
        // 下一次成功读取（push 或 unary）立即恢复事实并撤下呈现。
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
      // 反代 503 = 权威"未就绪"信号（design 03）：本地 /health 可能还停留在
      // 旧 ready（最多一个健康轮询周期的陈旧窗口），立即刷新使连接判定
      // 尽快翻转（否则错误行要挂到下一个健康轮询才被 not-connected 替换）。
      if (isInstanceUnavailable(err)) void refreshHealth()
      // 首屏加速：一次瞬时失败不等到 30s 兜底轮询——限次快速重试（工作区
      // 单元冷启动期间快照获取可能短暂 503/超时；git 快照先到会让未注册块
      // 抢在工作区列表前渲染；快照取自
      // session/list cwd 事实）。
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

  /**
   * Run a bounded refresh wave: at most AGGREGATE_POLL_CONCURRENCY concurrent
   * pulls, one wave at a time. Shared by the edge-triggered poll and the
   * staleness watchdog so neither can burst N pulls or overlap each other.
   */
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

  /** 刷新需要兜底/刚重连的就绪实例；未就绪实例落 not-connected——已推送过的
   *  挂载来源除外（保留其最后推送视图）。 */
  const pollAggregates = useCallback(() => {
    const { ready, notReady } = collectReadySourceIds(health, remoteStatus, remoteInstances)
    const refreshPlan = planAggregateRefreshes(
      ready,
      readyAggregateSourcesRef.current,
      mountedSources.getSnapshot(),
    )
    // Commit the observed generation synchronously before starting pulls: an
    // overlapping health/status callback must not mint duplicate reconnect pulls.
    readyAggregateSourcesRef.current = refreshPlan.nextReady
    runBoundedAggregateWave(refreshPlan.refreshSourceIds)
    if (notReady.length > 0) {
      aggregateRefreshQueueRef.current.delete(notReady)
      // A pull started in the dying generation must never restore an `ok`
      // aggregate after the authoritative transport state became not-ready.
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
            // 本就以 connected 为门（断连不显示任何行），保留它让重连后的
            // ready-edge 拉取走 sessions-only merge（工作区/归档集不丢失）。
            // 未推送/未挂载来源照旧落 not-connected（unary 兜底 = 其文档化
            // 范围）。shouldRetainPushedAggregate 单测覆盖（aggregate-refresh.test.ts）。
            && !shouldRetainPushedAggregate(mountedSources.getSnapshot()[id] === true, current)) {
            next[id] = emptyAggregate('not-connected')
            changed = true
          }
        }
        return changed ? next : prev
      })
      // 断连即清该来源的运行时事实（design 06：generation 级事实随断连失效）
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
      // Host facts are generation-scoped too: a disconnected source must
      // not retain a version from the previous connection generation
      // (the local instance's version comes from the desktop bridge).
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

  // 连接事实（health / 隧道相位 / 注册表）或快照生产者变化即重估聚合，
  // tick：ready↔degraded 转换瞬间的错误行在下一次状态推送后立即被
  // not-connected/正常数据替换，不残留到轮询周期。
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
  // P2：App 只跑升级 ladder（reconnect/notice），probe cadence 与写回在执行端。
  const escalationRecordsRef = useRef<Record<string, LadderRecord>>({})
  /** 已亮 notice 的来源 → 亮灯时的 progressStamp（健康进展即撤下）。 */
  const noticeProgressRef = useRef<Record<string, number>>({})
  const [stalledSources, setStalledSources] = useState<readonly string[]>([])
  // 用户已经「忽略」过的停滞来源：同一停滞时段不再重复提示（与 mobile
  // session-stall.ts 的 dismiss 语义一致——误报不得反复打扰），来源恢复
  // （离开 stalled）时自动解除忽略。
  const [dismissedStalls, setDismissedStalls] = useState<readonly string[]>([])
  /** 事实已越界无法验证的来源：与 stalledSources 共用同一条
   *  停滞横幅（文案本身即「无法确认会话状态」），下一次成功读取（push/unary）即移除。 */
  const [unverifiedSources, setUnverifiedSources] = useState<readonly string[]>([])
  // 渲染期镜像（与 watchdogAggregatesRef 同纪律）：watchdog 回调不因它重建定时器。
  const unverifiedSourcesRef = useRef(unverifiedSources)
  unverifiedSourcesRef.current = unverifiedSources
  /**
   * 唯一的标记写入口：除 setState 外**同步**更新 ref ——
   * 同一 tick 的 dismiss 剪枝与失败分支都读 ref，若只等下一次渲染，刚被判「无法确认」
   * 的来源会被旧快照误判成已恢复（忽略被提前剪掉、横幅反复重现）。
   */
  const setUnverified = (updater: (prev: readonly string[]) => readonly string[]): void => {
    setUnverifiedSources(prev => {
      const next = updater(prev)
      unverifiedSourcesRef.current = next
      return next
    })
  }
  // (对齐 ssh 断链自动恢复) a stale MOUNTED direct-http source (registry
  // spec transport === 'http', whatever the target kind) additionally gets a
  // lightweight connection reconnect (bounded by lastReconnectAtRef) so the
  // ctx's own reconnect chain re-establishes the frozen workspace follow —
  // the unary pull only refreshes session rows, it cannot heal the push
  // channel. The reconnect is an ADDITION, never a replacement of the pull.
  // Cadence (two distinct regimes): a HEALTHY-but-quiet
  // source rebaselines after each reconnect, whose baseline push refreshes
  // snapshotAt — the next reconnect fires one transport threshold later
  // (this depends on the producer's withdraw→re-publish chain resurfacing the
  // baseline; if that chain stays silent the regime degrades to the backoff
  // gate below). A TRULY dead channel gets no push after a reconnect, so once
  // stale it retries every AGGREGATE_RECONNECT_BACKOFF_MS — bounded churn
  // that keeps probing until the channel heals or the source leaves ready.
  // tick 主体抽成可即时调用的回调——周期 interval 与
  // visibilitychange 恢复补偿（hidden→visible）共用，隐藏期跳过的 stale 拉取
  // 在恢复后立即收敛（见下方 visibility effect）。
  const runStalenessWatchdogNow = useCallback(() => {
    const now = Date.now()
    const ready = collectReadySourceIds(health, remoteStatus, remoteInstances).ready
    const staleIds = ready
      .filter(id => isSnapshotStale(snapshotAtRef.current[id], now, AGGREGATE_FALLBACK_POLL_MS))
    if (staleIds.length > 0) runBoundedAggregateWave(staleIds)
    // The reconnect arm is scoped to DIRECT-HTTP sources (registry spec
    // transport === 'http' — gateway-kind AND dsh-kind alike); ssh-transport
    // targets (any kind) are excluded: the tunnel's ssh keepalive and
    // loopback stability already protect them, so churning their ctxs would
    // be pure cost (the axis is the transport, not the target
    // kind). No host-loopback exclusion here — unlike the transport-keepalive arm (whose transport
    // keepalive is pointless on a loopback leg that cannot half-open), this
    // arm also heals ctx-level push-channel freezes that are NOT
    // transport-caused (e.g. a dsh-restart rebaseline gap), so a
    // loopback-host direct-http target (local gateway dev) stays covered; a
    // healthy idle one there merely bounces every ~2min (bounded, dev form).
    // Per-source transport decides the threshold: http
    // keeps the 120s tight-heal cadence (no upstream heartbeat), ssh gets the
    // 5min last-resort cadence (three independent tunnel detectors already
    // cover transport-level death; this arm only heals an app-level freeze),
    // and local/unknown sources are skipped entirely.
    const transportBySourceId = new Map(
      remoteInstances.map(instance => [sourceIdForInstance(instance), instance.transport]),
    )
    // 本 tick 内**真正执行过** reconnect 的来源（**三条臂**共享：陈旧臂、
    // fallback-view 重建臂、运行位守卫的 L2）：用局部集合而不是墙钟窗口判断，
    // 避免「先规划改状态、后因窗口命中而跳过」把已到期的 L2 推迟一个退避周期，
    // 也避免时钟抖动带来的误判。**每条执行了 reconnect 的臂
    // 都必须登记**——漏登记就会让后面的臂对同一来源再重连一次（每次都要重放
    // 全部 baseline）。
    const reconnectedThisTick = new Set<string>()
    for (const id of ready) {
      if (id === LOCAL_INSTANCE_ID) continue
      const stalenessMs = reconnectStalenessMsForTransport(transportBySourceId.get(id))
      if (stalenessMs === null) continue
      // mounted here means "the ctx producer pushed at least one snapshot
      // this generation" (snapshotSources) — the target class is a
      // channel that worked and then went silent; a channel dead from its
      // first boot never pushes and stays on the unary fallback, which
      // already covers it (KNOWN DEGRADATION scope).
      if (!shouldReconnectStaleMounted({
        mounted: mountedSources.getSnapshot()[id] === true,
        lastSnapshotAt: snapshotAtRef.current[id],
        lastReconnectAt: lastReconnectAtRef.current[id],
        now,
        stalenessMs,
        reconnectBackoffMs,
      })) continue
      // Record the attempt synchronously with firing so overlapping
      // ticks/effect re-arms cannot double-fire while a reconnect is in
      // flight — but only when reconnect() was actually invoked: a no-op
      // (shell not booted / ctx missing, e.g. a boot-failure retry window)
      // must not consume the backoff window and delay the first effective
      // reconnect.
      // NOTE: each reconnect resets the ctx connection's
      // official exponential backoff to an immediate retry (MANUAL_RECONNECT
      // semantics) — while a target stays ready-but-dead this yields a
      // fixed ~60s probe cadence instead of the official backoff ceiling.
      // Bounded and intended (it is the healing probe); a long-dead target
      // eventually flips to not-connected via the main-process reverify
      // path, which removes it from this arm.
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
    // 会话事实单一权威：producer 执行端持有 reducer（运行位真相 + N=2 + tier-3
    // 写回）与 probe cadence，并把 `runningSince` / `stuckSince` / `progressStamp`
    // 投影进运行时事实。这里只做两件事：给它一个 30s tick，以及在**拿不到权威结论**
    // 的 stuck 证据上跑升级 ladder（reconnect → notice）。绝不按静默时长升级：长工具/
    // 长推理的合法静默与真卡死在本层不可区分，误升级会重放全部 baseline
    // （design 14 §D4 的核心取舍）。
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
        // 共享重连账本（同一 tick 的 fallback 臂已经写过）：挡住时不派遣，
        // 也不消耗 ladder 配额——被 App 丢弃的派遣不得静默吃掉杠杆。
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
          // 与既有臂共用同一份 per-source 账本：同一 tick 内已经重连过的来源不得
          // 被多条臂各重连一次；跨 tick 也要看账本（fallback 可能刚重连过）。
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

  // Staleness watchdog cadence + 文档可见性门控：窗口隐藏
  // （Electron 最小化/隐藏到托盘）期跳过周期 unary 拉取与 reconnect 臂——
  // 用户不可见期不维持 30s 轮询/重连链（含"已回收但仍 ready 的源"的兜底拉
  // 取：隐藏期暂停、恢复可见立即补偿一轮，见 visibility effect；窗口可见时
  // 该兜底照常维持 30s 周期——回收源的任务完成检测依赖它，design 05 语义不
  // 变）。恢复补偿由下方 visibility effect 调 runStalenessWatchdogRef。
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
