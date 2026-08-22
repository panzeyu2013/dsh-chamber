/**
 * dsh-chamber bridge host（design 05 §1/§3）：页面唯一入口宿主。
 *
 * 首屏 = 本地实例的完整 dsh shell（纯 dsh UI，无 chamber 外壳）；多来源
 * session/workspace 导航在 dsh 原生侧边栏内由 chamber 自研插件承担
 * （05 §2）。本组件只负责数据层与 N-ctx 编排：
 * - 控制面 /health 与 /api/connections 轮询；
 * - 桌面 ssh 实例装载与状态投影订阅（隧道 URL 永不进 renderer）；
 * - 每实例 workspace/session 聚合（instance-api unary，05 §2.3）；
 * - 本地实例自动启动、注册表远程实例自动连接；
 * - N-ctx shell 挂载（local 常驻，其他来源按需挂载/空闲预热；hide/show
 *   切换经 View Transition 包装（view-transition.ts）：旧视图 visibility+
 *   `content-visibility:hidden` 即时隐去（跳过 style/layout/paint 并缓存
 *   渲染状态），切换与骨架→内容过渡由 `startViewTransition` 的静态旧视图
 *   快照遮盖 reveal 重排——无黑帧、无闪烁；见 styles.css `.instance-hidden`）；
 * - chamberBridge 投影发布（05 §3）：轮询状态合并为 ChamberServerAggregate[]
 *   供侧边栏插件消费；onOpenSession 通道驱动会话打开。
 *
 * 会话打开请求来自侧边栏插件（经 chamberBridge，05 §3）：onOpenSession
 * 通道驱动 openSession 切 shell 并分发（插件 requestOpenSession 为单向
 * 通道，失败无处回传，App 侧 console.error 即可见）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import api, { type ConnectionSummary, type HealthResponse } from './api.ts'
import {
  chamberBridge,
  deriveServerWorkspaces,
  emptyAggregate,
  fetchInstanceSnapshot,
  getInstanceClient,
  instanceSnapshotSignature,
  isInstanceUnavailable,
  mergeRuntimeFacts,
  releaseInstanceClient,
  reconcileCompletedFacts,
  runtimeReportSignature,
  serversProjectionSignature,
  type ChamberServerAggregate,
  type InstanceAggregate,
  type InstanceRuntimeReport,
  type InstanceSnapshot,
  type PluginGraphDiagnostic,
} from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import { openInstanceSession, disposeAllShells, disposeInstanceShell, type ShellState } from './shell.ts'
import { runViewTransition } from './view-transition.ts'
import { captureSidebarScrollAnchor, restoreSidebarScroll } from './sidebar-scroll-sync.ts'
import { isSnapshotStale, planAggregateRefreshes } from './aggregate-refresh.ts'
import { errorMessage } from './status.ts'
import type { SshInstanceSpec, SshStatusProjection } from './global.d.ts'
import InstanceView from './components/InstanceView.tsx'

/**
 * Staleness watchdog cadence for aggregate snapshots. Also the staleness
 * threshold: a ready source whose last PUSHED snapshot is older than this is
 * presumed to have a dead push channel and is re-pulled from the authority.
 */
const AGGREGATE_FALLBACK_POLL_MS = 30_000
/** Bounded wave over whatever edge-triggered refresh set a poll produces. */
const AGGREGATE_POLL_CONCURRENCY = 4
/** First-screen retry: a transient workspace.list failure is retried quickly
 *  (bounded), instead of waiting out the 30s staleness watchdog. */
const AGGREGATE_RETRY_MS = 3_000
const AGGREGATE_RETRY_LIMIT = 5
const MAX_PREWARMED_REMOTE_VIEWS = 3
/** 连接行（label/dshPort）低频轮询：状态本身走推送，行字段极少变化。 */
const CONNECTIONS_POLL_MS = 30_000

const LOCAL_INSTANCE_ID = 'local'

function instanceBasePath(instanceId: string): string {
  return `/api/i/${instanceId}`
}

/**
 * 实例可被聚合轮询：对齐反代契约（03 §3.3）——只有 `ready` 才放行，否则
 * 显式 503。starting/degraded/connecting 期间轮询只会收获 503，故一律按
 * 未连接呈现（分组头 + 相位文本，不轮询、无错误刷屏）。
 */
function instanceConnected(
  kind: 'local' | 'ssh',
  health: HealthResponse | null,
  remoteStatus: Record<string, SshStatusProjection>,
  instanceId: string,
): boolean {
  if (kind === 'local') {
    const status = health?.dsh?.status
    return status === 'ready'
  }
  const phase = remoteStatus[instanceId]?.phase
  return phase === 'ready'
}

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
    const id = `ssh-${instance.id}`
    if (instanceConnected('ssh', health, remoteStatus, instance.id)) ready.push(id)
    else notReady.push(id)
  }
  return { ready, notReady }
}

/**
 * 轮询状态 → chamberBridge 投影（05 §3）：local + 每个注册表远程实例一条。
 * connected 只看权威状态（本地 /health dsh；远程隧道 phase）；workspaces
 * 只在对应聚合 state==='ok' 时派生（否则空数组，不显示陈旧数据）；拉取
 * 失败时把错误文本带上 aggregateError（UI 区分「拉取失败」与「无工作区」）。
 */
function deriveServers(
  health: HealthResponse | null,
  connections: ConnectionSummary[] | null,
  remoteInstances: SshInstanceSpec[],
  remoteStatus: Record<string, SshStatusProjection>,
  aggregates: Record<string, InstanceAggregate>,
  runtimeFacts: Record<string, InstanceRuntimeReport | undefined>,
  completedBySource: Record<string, Record<string, boolean>>,
  activeViewId: string,
  pluginDiagnostics: Record<string, PluginGraphDiagnostic | undefined>,
): ChamberServerAggregate[] {
  const servers: ChamberServerAggregate[] = []
  const now = Date.now()
  // The proxy contract is /api/i/ssh-<id>/*, so every remote source id that
  // reaches the sidebar / shell paths carries the 'ssh-' prefix (05 §3);
  // remoteStatus is keyed by the raw registry id (the IPC projection's id).
  const push = (kind: 'local' | 'ssh', id: string, label: string, rawId?: string): void => {
    const statusKey = kind === 'local' ? id : (rawId ?? id)
    const phase = kind === 'local'
      ? (health?.dsh?.status ?? 'unknown')
      : (remoteStatus[statusKey]?.phase ?? 'idle')
    let workspaces: ChamberServerAggregate['workspaces'] = []
    const aggregate = aggregates[id]
    const connected = instanceConnected(kind, health, remoteStatus, statusKey)
    if (connected && aggregate !== undefined && aggregate.state === 'ok') {
      // 当前会话事实只给活动来源：blank（新建未首发的）会话行只在正在查看的
      // 来源投影（06 §4.3 全局单选纪律）——否则每个已挂载来源都会冒出它的
      // 空"新建会话"行。其他来源 blank 行照旧不进入导航列表。
      const current = id === activeViewId ? runtimeFacts[id]?.current : undefined
      workspaces = deriveServerWorkspaces(aggregate, '', current)
    }
    const entry: ChamberServerAggregate = {
      id,
      kind,
      label,
      connected,
      phase,
      workspaces,
      aggregateReady: aggregate !== undefined && aggregate.state === 'ok',
      updatedAt: now,
    }
    // 运行时事实只在 connected 时附加（断连态不应携带事实，避免死状态翻转）。
    // App 自持的完成未读点（completedBySource）与通道上报并集：蓝点以 App
    // 派生的 running→idle 边沿为准（它无视后台来源 shell 的陈旧 selected），
    // vendor 的 completed 作兜底保留。合并为纯函数 mergeRuntimeFacts（shared/
    // derive.ts，单测覆盖）。
    if (connected) {
      const merged = mergeRuntimeFacts(runtimeFacts[id], completedBySource[id])
      if (merged !== undefined) entry.runtime = merged
    }
    if (aggregate !== undefined && aggregate.state === 'error') {
      entry.aggregateError = aggregate.error ?? '未知错误'
    }
    if (pluginDiagnostics[id] !== undefined) entry.pluginDiagnostic = pluginDiagnostics[id]
    servers.push(entry)
  }
  push('local', LOCAL_INSTANCE_ID, (connections ?? [])[0]?.label ?? '本地实例')
  for (const instance of remoteInstances) push('ssh', `ssh-${instance.id}`, instance.label, instance.id)
  return servers
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
    // 用新 entry 覆盖未销毁的旧 ctx（僵尸 ctx，05 §4 无僵尸不变量）。
    disposeAllShells()
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="fatal">
          <div className="fatal-title">界面发生错误</div>
          <div className="fatal-message">{String(this.state.error?.message || this.state.error)}</div>
          <button
            className="btn"
            onClick={() => {
              this.setState({ error: null })
            }}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  // 健康失败首次出现的时间戳：致命屏要求错误**持续**存在（宽容瞬时抖动/
  // SSE 重连窗口），否则首帧成功后的会话中途失联会被陈旧 health 永远掩盖。
  const [healthErrorAt, setHealthErrorAt] = useState<number | null>(null)
  // 连接行初始 null = "尚未拉到首轮"（404 映射空数组 = 权威"无本地行"）；
  // 两种状态区分后，首启（无行）才会触发本地实例自动启动。
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null)
  const [remoteInstances, setRemoteInstances] = useState<SshInstanceSpec[]>([])
  const [remoteStatus, setRemoteStatus] = useState<Record<string, SshStatusProjection>>({})
  // 视图：'local' | 'ssh-<id>'；已挂载过的实例视图保留（N-ctx 常驻，会话保活）
  const [activeView, setActiveView] = useState<string>(LOCAL_INSTANCE_ID)
  const [mountedViews, setMountedViews] = useState<string[]>([LOCAL_INSTANCE_ID])
  // Views mounted only by background prewarm. User selection removes the id
  // from this set, freeing one of the three idle-prewarm slots while keeping
  // the user-opened N-ctx shell resident.
  const autoPrewarmedRef = useRef<Set<string>>(new Set())
  // chamber (2026-08 失败呈现修订, 05 §4)：每视图 shell 终态（InstanceView
  // 经 onStateChange 上报）——活动视图 boot 失败时由 App 渲染统一失败覆盖层
  // （失败报告 + 重试 + 服务器切换）。retryTokens 驱动 InstanceView 的重试
  // 重 boot（令牌递增 → 视图复位 → 重新启动 shell）。
  const [shellStates, setShellStates] = useState<Record<string, ShellState>>({})
  const [retryTokens, setRetryTokens] = useState<Record<string, number>>({})
  // 每实例 workspace/session 聚合（已挂载 ctx 推送 + 未挂载 unary 兜底；控制面不持有会话事实）
  const [aggregates, setAggregates] = useState<Record<string, InstanceAggregate>>({})
  // Complete snapshots reported by mounted ctx stores. A source appears here
  // only while both reconnect baselines are idle + ready; loading/error
  // withdraws ownership so an identical recovered baseline is re-published.
  // Complete sources require no periodic unary aggregation; unmounted/
  // incomplete sources retain the bounded fallback below.
  const [snapshotSources, setSnapshotSources] = useState<Record<string, true>>({})
  // Event callbacks and fallback polls may interleave before React commits the
  // state update above. Keep a synchronous ownership mirror so a producer's
  // first snapshot immediately suppresses any later unary pull in that window.
  const snapshotSourcesRef = useRef<Record<string, true>>({})
  // Last PUSHED-snapshot timestamp per source (ms epoch; absent = never). The
  // staleness watchdog uses recency as its only liveness signal — the unary
  // client exposes no per-source connection state, and a silently dead push
  // channel never fires the producer withdrawal (aggregate-store clear()).
  const snapshotAtRef = useRef<Record<string, number>>({})
  // Synchronous connection-generation edge memory. A mounted producer may
  // suppress an identical post-reconnect snapshot, while the App has already
  // replaced its aggregate with not-connected; one authoritative pull on each
  // not-ready -> ready edge closes that gap without restoring periodic RPCs.
  const readyAggregateSourcesRef = useRef<Set<string>>(new Set())
  const [pluginDiagnostics, setPluginDiagnostics] = useState<Record<string, PluginGraphDiagnostic | undefined>>({})
  // 每实例运行时事实（06 §4）：来自各来源 ctx 的 chamberBridge 上报，仅附加
  const [runtimeFacts, setRuntimeFacts] = useState<Record<string, InstanceRuntimeReport | undefined>>({})
  // chamber (06 §4.1, 2026-08)：App 自持的「完成未读」蓝点（completedBySource）
  // 与边沿记忆（prevRunningRef）。蓝点不依赖各来源 shell 的 selected——后台
  // 来源的陈旧 selected 会让 vendor 提醒错误压制「完成但未读」——而是由 App
  // 从上报里的实时 running 位自行推导 running→idle 边沿，以 App 已知的
  // 「谁在阅读」（activeView + 各来源 current）判定武装/解除。插件侧保持
  // 无状态（纯投影），避免在每 ctx 复制一套状态机。
  const [completedBySource, setCompletedBySource] = useState<Record<string, Record<string, boolean>>>({})
  const prevRunningRef = useRef<Record<string, Record<string, boolean>>>({})

  // chamberBridge 投影（05 §3）：health/remoteStatus/aggregates 任一变化后
  // 派生并发布；首帧（health 未就绪）即发布 connected=false 的分组。
  const servers = useMemo(
    () => deriveServers(health, connections, remoteInstances, remoteStatus, aggregates, runtimeFacts, completedBySource, activeView, pluginDiagnostics),
    [health, connections, remoteInstances, remoteStatus, aggregates, runtimeFacts, completedBySource, activeView, pluginDiagnostics],
  )
  // chamberBridge publish 签名闸（2026-08 perf pass）：servers 在每次依赖变化
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

  // 渲染期注册表 id 镜像（与 commit 同步，微任务/事件回调安全）：selectView
  // 与 openSession 在 apply 时用它拒绝已回收来源（视图生命周期 = 注册表条目
  // 生命周期，05 §4）——效果同 prewarmEligibleRef 的镜像纪律。
  const liveServerIdsRef = useRef<Set<string>>(new Set())
  const liveServerIds = useMemo(() => new Set(servers.map(server => server.id)), [servers])
  liveServerIdsRef.current = liveServerIds

  // 隧道相位镜像（按原始注册表 id 键控，onStatusChanged 推送的 payload.id）：
  // ensureRemoteConnected 经它读最新相位而不进依赖——selectView/openSession 的
  // 身份保持稳定（本文件既有 ref 镜像纪律），相位变化不重建这些回调。
  const remoteStatusRef = useRef(remoteStatus)
  remoteStatusRef.current = remoteStatus

  // 切换意图镜像：activeViewRef = 已落地的当前视图（渲染期镜像），
  // pendingViewRef = 在途/顺延中的最新切换意图（过渡链 apply 前有效）。
  // selectView 的早期返回必须查镜像而非闭包：过渡在途时 UI 仍显示旧视图，
  // 用闭包里的 activeView 会把「切回旧视图」的撤销意图误判为无操作丢弃——
  // 违反 view-transition.ts 的「最后一次意图胜出」性质。
  const activeViewRef = useRef(activeView)
  activeViewRef.current = activeView
  const pendingViewRef = useRef<string | null>(null)

  /**
   * N-ctx 视图回收（设计 05 §4）：视图生命周期 = 注册表条目生命周期。
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
        disposeInstanceShell(id)
        releaseInstanceClient(id)
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
    setActiveView(prev => {
      if (prev === LOCAL_INSTANCE_ID) return prev
      const server = servers.find(candidate => candidate.id === prev)
      if (server !== undefined) return prev
      return LOCAL_INSTANCE_ID
    })
    // 注册表删除的实例同时清掉其数据面残留（聚合/运行时事实/状态投影）——
    // 视图已回收，键空间应随注册表收敛（重加同名 id 由刷新重建）。
    setAggregates(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!servers.some(server => server.id === id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    setRuntimeFacts(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!servers.some(server => server.id === id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    setSnapshotSources(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!servers.some(server => server.id === id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    for (const id of Object.keys(snapshotSourcesRef.current)) {
      if (!servers.some(server => server.id === id)) delete snapshotSourcesRef.current[id]
    }
    setPluginDiagnostics(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!servers.some(server => server.id === id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    setCompletedBySource(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!servers.some(server => server.id === id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    // prevRunning 是 ref：同步裁剪，随注册表收敛（重加同名 id 由刷新重建）。
    for (const id of Object.keys(prevRunningRef.current)) {
      if (!servers.some(server => server.id === id)) delete prevRunningRef.current[id]
    }
    setRemoteStatus(prev => {
      // remoteStatus 按原始注册表 id 键控（deriveServers 的 statusKey），
      // 与 servers 的 ssh-<id> 前缀 id 不同——按前缀剥离还原再比较。
      const liveRaw = new Set<string>()
      for (const server of servers) {
        liveRaw.add(server.kind === 'local' ? 'local' : server.id.slice(4))
      }
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!liveRaw.has(id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
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

  const refreshRemoteStatus = useCallback(async (id: string) => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    try {
      const projection = await ssh.status(id)
      if (projection !== null) setRemoteStatus(prev => ({ ...prev, [id]: projection }))
    } catch {
      // 状态读取失败时保持已有投影（权威状态来自 onStatusChanged 推送）
    }
  }, [])

  const refreshRemotes = useCallback(async () => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    try {
      const instances = await ssh.instances_get()
      setRemoteInstances(instances)
      for (const instance of instances) void refreshRemoteStatus(instance.id)
    } catch {
      // 桌面 SSH 面不可达时保持现状；实例列表由下次刷新重试
    }
  }, [refreshRemoteStatus])

  /**
   * 拉取一个实例的 workspace/session 快照（失败落 error 态，由轮询重试）。
   * 每次调用按实例取序并递增；resolve/reject 时仅当捕获的序号仍是最新才
   * 落 state——避免慢轮询在拖拽提交后的即时刷新之后落地、用旧序覆盖新序
   * （拖拽 commit 前的兜底快照可能晚于 refresh 拉取到达，造成陈旧排序）。
   */
  const aggregateSeqRef = useRef<Record<string, number>>({})
  const aggregatePollRunningRef = useRef(false)
  const aggregateFailuresRef = useRef<Record<string, number>>({})
  const retryTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const refreshAggregate = useCallback(async (instanceId: string) => {
    const seq = (aggregateSeqRef.current[instanceId] ?? 0) + 1
    aggregateSeqRef.current[instanceId] = seq
    try {
      const snapshot = await fetchInstanceSnapshot(getInstanceClient(instanceId))
      if (aggregateSeqRef.current[instanceId] !== seq) return
      // identity-preserving：快照内容未变（兜底/手动刷新常态）则复用旧 state 对象
      // ——避免恒新对象驱动 servers 重新派生并触发 publish 签名闸后面的全量
      // 侧边栏重渲染（2026-08 perf pass）。错误分支保持无条件覆盖（error 文本
      // 是权威失败事实，不能因"看起来没变"而吞掉）。
      setAggregates(prev => {
        const current = prev[instanceId]
        if (current !== undefined && current.state === 'ok'
          && instanceSnapshotSignature(current) === instanceSnapshotSignature(snapshot)) {
          return prev
        }
        return { ...prev, [instanceId]: { state: 'ok', ...snapshot, error: null } }
      })
    } catch (err) {
      if (aggregateSeqRef.current[instanceId] !== seq) return
      setAggregates(prev => ({ ...prev, [instanceId]: emptyAggregate('error', errorMessage(err)) }))
      // 反代 503 = 权威"未就绪"信号（03 §3.3）：本地 /health 可能还停留在
      // 旧 ready（最多一个健康轮询周期的陈旧窗口），立即刷新使连接判定
      // 尽快翻转（否则错误行要挂到下一个健康轮询才被 not-connected 替换）。
      if (isInstanceUnavailable(err)) void refreshHealth()
      // 首屏加速：一次瞬时失败不等到 30s 兜底轮询——限次快速重试（工作区
      // 单元冷启动期间 workspace.list 可能短暂 503/超时；git 快照先到会让
      // 未注册块抢在 workspace 列表前渲染，2026-08 用户反馈）。
      const failures = aggregateFailuresRef.current[instanceId] ?? 0
      if (failures < AGGREGATE_RETRY_LIMIT) {
        aggregateFailuresRef.current[instanceId] = failures + 1
        const retryTimer = setTimeout(() => {
          if (aggregateSeqRef.current[instanceId] === seq) void refreshAggregate(instanceId)
        }, AGGREGATE_RETRY_MS)
        retryTimersRef.current.push(retryTimer)
      } else {
        aggregateFailuresRef.current[instanceId] = 0
      }
    }
  }, [refreshHealth])

  /**
   * Run a bounded refresh wave: at most AGGREGATE_POLL_CONCURRENCY concurrent
   * pulls, one wave at a time. Shared by the edge-triggered poll and the
   * staleness watchdog so neither can burst N pulls or overlap each other.
   */
  const runBoundedAggregateWave = useCallback((sourceIds: string[]) => {
    if (sourceIds.length === 0 || aggregatePollRunningRef.current) return
    aggregatePollRunningRef.current = true
    void (async () => {
      let cursor = 0
      const worker = async () => {
        while (cursor < sourceIds.length) {
          const sourceId = sourceIds[cursor]
          cursor += 1
          await refreshAggregate(sourceId)
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(AGGREGATE_POLL_CONCURRENCY, sourceIds.length) }, () => worker()))
      } finally {
        aggregatePollRunningRef.current = false
      }
    })()
  }, [refreshAggregate])

  /** 刷新需要兜底/刚重连的就绪实例；未就绪实例落 not-connected（不显示陈旧数据）。 */
  const pollAggregates = useCallback(() => {
    const { ready, notReady } = collectReadySourceIds(health, remoteStatus, remoteInstances)
    const refreshPlan = planAggregateRefreshes(
      ready,
      readyAggregateSourcesRef.current,
      snapshotSourcesRef.current,
    )
    // Commit the observed generation synchronously before starting pulls: an
    // overlapping health/status callback must not mint duplicate reconnect pulls.
    readyAggregateSourcesRef.current = refreshPlan.nextReady
    runBoundedAggregateWave(refreshPlan.refreshSourceIds)
    if (notReady.length > 0) {
      // A pull started in the dying generation must never restore an `ok`
      // aggregate after the authoritative transport state became not-ready.
      for (const id of notReady) {
        aggregateSeqRef.current[id] = (aggregateSeqRef.current[id] ?? 0) + 1
      }
      setAggregates(prev => {
        let changed = false
        const next = { ...prev }
        for (const id of notReady) {
          const current = next[id]
          if (current === undefined) {
            next[id] = emptyAggregate('not-connected')
            changed = true
          } else if (current.state !== 'not-connected') {
            next[id] = emptyAggregate('not-connected')
            changed = true
          }
        }
        return changed ? next : prev
      })
      // 断连即清该来源的运行时事实（06 §4.2：generation 级事实随断连失效）
      setRuntimeFacts(prev => {
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
  useEffect(() => {
    const timer = setInterval(() => {
      const staleIds = collectReadySourceIds(health, remoteStatus, remoteInstances).ready
        .filter(id => isSnapshotStale(snapshotAtRef.current[id], Date.now(), AGGREGATE_FALLBACK_POLL_MS))
      if (staleIds.length > 0) runBoundedAggregateWave(staleIds)
    }, AGGREGATE_FALLBACK_POLL_MS)
    return () => { clearInterval(timer) }
  }, [health, remoteStatus, remoteInstances, runBoundedAggregateWave])

  useEffect(() => () => {
    for (const timer of retryTimersRef.current) clearTimeout(timer)
    retryTimersRef.current = []
  }, [])
  useEffect(() => {
    let cancelled = false

    void refreshHealth()
    void refreshConnections()
    void refreshRemotes()
    pollAggregatesRef.current()

    // Local status push channel (设计 05 §3): the control plane streams every
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
    const connectionsTimer = setInterval(() => {
      if (cancelled) return
      void refreshConnections()
    }, CONNECTIONS_POLL_MS)

    // 注册表低频轮询（与连接行同节奏）：兜底桌面侧任何来源的注册表变化
    // （主进程 instances_set 推送通道之外；隧道状态本身走 onStatusChanged
    // 推送，不依赖此轮询）。
    const remotesTimer = setInterval(() => {
      if (cancelled) return
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
   * 桌面桥订阅（05 §7.4）：preload 经异步 dsh-chamber:info 往返后才暴露
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

  useEffect(() => {
    if (!sshBridgeReady) return
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    // 桥到达即装载一次 roster（挂载时的装载可能发生在桥之前）。
    void refreshRemotes()
    const unsubscribe = ssh.onStatusChanged((payload) => {
      setRemoteStatus(prev => ({ ...prev, [payload.id]: payload.status }))
    })
    // 注册表变更推送：设置页增/删/改实例即时重拉 roster（自动连接新 id、
    // 回收已删视图），不等 30s 轮询周期。
    const unsubscribeInstances = ssh.onInstancesChanged(() => {
      void refreshRemotes()
    })
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
    return () => {
      unsubscribe()
      unsubscribeInstances()
      unsubscribeResume?.()
    }
  }, [sshBridgeReady, refreshRemotes])

  /**
   * 本地实例幂等启动（05 §3）：首轮连接行装载后（null = 尚未拉到）行缺失/
   * stopped/error 均触发一次 POST /api/connections（幂等，重复 200 返回既有
   * 状态）。一旦 ready 即不再 POST（后续状态由 /health 呈现）。POST 失败
   * **不置位**——下一个连接行轮询周期（30s）重试，直到成功或出现 ready 行
   * （控制面不可达时应用本就显示致命屏，恢复后本地实例不再被静默放弃）。
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
   * 注册表远程实例自动连接（05 §3）：只对**本渲染会话首次见到的**实例 id
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
   * 用户意图即时重连（2026-08）：点击/打开一个远程来源 = 「现在就想要这个
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
    const rawId = viewId.slice('ssh-'.length)
    const phase = remoteStatusRef.current[rawId]?.phase
    if (phase !== 'error' && phase !== 'degraded') return
    void ssh.connect(rawId).catch(err => {
      console.error(`[renderer] click-to-reconnect ${rawId} failed:`, err)
    })
  }, [])

  /** 视图切换（设计 05 §4）：经 View Transition 包装（view-transition.ts）——
   * 旧视图静态快照保持到新视图渲染就绪，随后短 crossfade；reveal 重排期间
   * 无黑帧；prefers-reduced-motion/不支持时降级即时切换。未就绪目标视图
   * 由 InstanceView 的骨架屏呈现加载中间态。
   *
   * 注册表守卫（05 §4：视图生命周期 = 注册表条目生命周期）：来源已被删除
   * 时不挂载/不切换（点击时与过渡 apply 时各查一次——apply 时可能已迟到，
   * 如过渡在途期间注册表删除）。绝不把已回收的视图重新挂成僵尸：一次完整
   * boot 很贵，且回收 effect 的回滚会造成一闪而过的幽灵骨架屏。local 常驻。
   */
  const selectView = useCallback((viewId: string) => {
    // 用户点击 = 意图使用该来源：error/degraded 隧道立即再试（慢速重探的
    // 即时加速；idle 手动断开不触碰——见 ensureRemoteConnected）。
    ensureRemoteConnected(viewId)
    if (viewId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(viewId)) return
    autoPrewarmedRef.current.delete(viewId)
    // 镜像查重（非闭包）：在途/顺延中的同一意图直接跳过；已落地视图只有在
    // 无在途意图时才跳过——过渡在途时 UI 仍显示旧视图，点击旧视图 = 撤销
    // 意图（最后一次意图胜出，view-transition.ts），不能按当前态误丢。
    // 被回收来源在 apply 时被守卫否决后 pendingViewRef 已清空，重加后的点击
    // 不被残留意图误吞。
    if (viewId === pendingViewRef.current) return
    if (pendingViewRef.current === null && viewId === activeViewRef.current) return
    // chamber (2026-08 scroll sync): anchor the outgoing shell's sidebar
    // scroll BEFORE the switch; the incoming shell's stale scrollTop would
    // otherwise make the whole sidebar jump (each N-ctx shell owns its own
    // .chamberList scrollTop). restoreSidebarScroll runs after the apply —
    // it retries until the incoming shell's container mounts (booting /
    // collapsed-to-rail) and anchors the same rows at the same screen
    // position (sidebar-scroll-sync.ts).
    const scrollAnchor = captureSidebarScrollAnchor(activeViewRef.current)
    pendingViewRef.current = viewId
    runViewTransition(() => {
      if (viewId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(viewId)) {
        // 过渡在途期间来源被删除：放弃本次切换并清掉意图（绝不把已回收的
        // 视图重新挂成僵尸：一次完整 boot 很贵，且回收 effect 的回滚会造成
        // 一闪而过的幽灵骨架屏。local 常驻）。
        if (pendingViewRef.current === viewId) pendingViewRef.current = null
        return
      }
      // 仅当本次意图仍是最新时清掉 pending——更晚的意图（已入过渡链）继续
      // 占用槽位，其 apply 时再清。
      if (pendingViewRef.current === viewId) pendingViewRef.current = null
      setActiveView(viewId)
      setMountedViews(prev => (prev.includes(viewId) ? prev : [...prev, viewId]))
      if (scrollAnchor !== null) restoreSidebarScroll(viewId, scrollAnchor)
    })
  }, [ensureRemoteConnected])

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
      if (instance.label !== '') map[`ssh-${instance.id}`] = instance.label
    }
    return map
  }, [connections, remoteInstances])

  /**
   * 空闲预热（设计 05 §4）：ready 的注册表远程实例按序、一次一个地在后台
   * boot（settle 后推进下一个），使多数首次切换在点击时已就绪——骨架屏只
   * 在预热未覆盖时出现。boot 本身经 shell.ts 的全局串行队列（`__DSH_BASE_PATH__`
   * 旋钮纪律），与用户触发的 boot 共享一条链（用户请求经同一链排队，最坏
   * 等一个在途 boot）。预热视图为 instance-pending 态（仅 visibility 隐藏、
   * 保留 layout——vendor 测量/IntersectionObserver 在 boot 期间正常）。
   */
  const localSettledRef = useRef(false)
  const prewarmQueueRef = useRef<string[]>([])
  const prewarmInflightRef = useRef<string | null>(null)

  /**
   * 渲染期镜像（与 commit 同步，微任务安全）：settle 微任务可能先于 effect
   * flush 到达（如注册表删除后的回收 effect 尚未运行），drain 时必须用它
   * 过滤已失效的队列项——绝不把已删除/已挂载的实例重新挂成僵尸视图。
   * 排除 mounted：用户已点开（或已被别处挂载）的视图不再占用预热槽位。
   */
  const prewarmEligibleRef = useRef<Set<string>>(new Set())
  const prewarmEligible = useMemo(() => {
    const liveRemoteIds = new Set(remoteInstances.map(instance => `ssh-${instance.id}`))
    for (const id of autoPrewarmedRef.current) {
      if (!liveRemoteIds.has(id)) autoPrewarmedRef.current.delete(id)
    }
    const remaining = Math.max(0, MAX_PREWARMED_REMOTE_VIEWS - autoPrewarmedRef.current.size)
    const eligible = remoteInstances
      .filter(instance => remoteStatus[instance.id]?.phase === 'ready')
      .map(instance => `ssh-${instance.id}`)
      .filter(id => !mountedViews.includes(id))
      .slice(0, remaining)
    return new Set(eligible)
  }, [remoteInstances, remoteStatus, mountedViews])
  prewarmEligibleRef.current = prewarmEligible

  const drainPrewarm = useCallback(() => {
    if (prewarmInflightRef.current !== null) return
    if (!localSettledRef.current) return
    let next: string | undefined
    do {
      next = prewarmQueueRef.current.shift()
    } while (next !== undefined && !prewarmEligibleRef.current.has(next))
    if (next === undefined) return
    prewarmInflightRef.current = next
    autoPrewarmedRef.current.add(next)
    setMountedViews(prev => (prev.includes(next) ? prev : [...prev, next]))
  }, [])

  const handleInstanceSettled = useCallback((instanceId: string) => {
    if (instanceId === LOCAL_INSTANCE_ID) localSettledRef.current = true
    if (prewarmInflightRef.current === instanceId) prewarmInflightRef.current = null
    // 无条件 drain：任何 settle 都可能是"在途预热完成"或"本地首次 settle"
    // 的触发器（后者在状态先于本地就绪时不会因依赖变化而触发队列推进）。
    drainPrewarm()
  }, [drainPrewarm])

  /** Shell 终态上报（InstanceView onStateChange）：失败覆盖层读取活动视图的 error。 */
  const handleShellState = useCallback((instanceId: string, state: ShellState) => {
    setShellStates(prev => (prev[instanceId] === state ? prev : { ...prev, [instanceId]: state }))
  }, [])

  useEffect(() => {
    const eligible = prewarmEligibleRef.current
    prewarmQueueRef.current = prewarmQueueRef.current.filter(id => eligible.has(id))
    for (const instance of remoteInstances) {
      const id = `ssh-${instance.id}`
      if (!eligible.has(id)) continue
      const queue = prewarmQueueRef.current
      if (!queue.includes(id)) queue.push(id)
    }
    drainPrewarm()
  }, [remoteInstances, remoteStatus, mountedViews, drainPrewarm])

  /** 打开某来源的会话：切到该来源 shell（未挂载先挂载）并分发到运行时。 */
  const openSession = useCallback(async (instanceId: string, sessionId: string) => {
    // 用户要在这个来源上工作：error/degraded 隧道立即再试（同上）。
    ensureRemoteConnected(instanceId)
    // 与 selectView 同款注册表守卫：来源已删除时拒绝入队——否则 open 会
    // 挂进 pendingOpens 永不分发（视图不再挂载，dispose 已执行），留死键。
    if (instanceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(instanceId)) {
      throw new Error(`打开会话失败：来源 ${instanceId} 已不在注册表`)
    }
    selectView(instanceId)
    try {
      await openInstanceSession(instanceId, sessionId)
    } catch (err) {
      throw new Error(`打开会话失败：${errorMessage(err)}`)
    }
  }, [selectView, ensureRemoteConnected])

  /** 侧边栏插件打开请求（05 §3）：mount 订阅、卸载取消；单向通道，失败仅 console.error。 */
  useEffect(() => {
    const unsubscribe = chamberBridge.onOpenSession(({ sourceId, sessionId }) => {
      void openSession(sourceId, sessionId).catch((err) => {
        console.error(`[renderer] openSession failed (${sourceId}/${sessionId}):`, err)
      })
    })
    return unsubscribe
  }, [openSession])

  /** 侧边栏插件点击来源头部的激活请求：切换到该来源 shell（未挂载先挂载，N-ctx）。 */
  useEffect(() => {
    return chamberBridge.onActivateSource((sourceId) => {
      selectView(sourceId)
    })
  }, [selectView])

  /** VS Code OS 深链（design 16 §2，best-effort）：主进程推送归一化 intent →
   *  激活对应来源 shell。raw id → 视图 id 契约（P1-4）：'local' 原样，
   *  注册表 id 拼 `ssh-` 前缀。窗口未就绪时推送已被主进程跳过（VS Code
   *  启动由主进程独立完成，渲染层激活从不阻塞它）。桥与 desktopSsh 同一批
   *  expose，sshBridgeReady 即 deepLink 可用。 */
  useEffect(() => {
    if (!sshBridgeReady) return
    const deepLink = window.dshChamber?.deepLink
    if (deepLink === undefined) return
    return deepLink.onIntent((intent) => {
      const sourceId = intent.instanceId === 'local' ? 'local' : `ssh-${intent.instanceId}`
      selectView(sourceId)
    })
  }, [sshBridgeReady, selectView])

  /** 侧边栏动作成功后请求的即时刷新（chamberBridge.requestRefresh）；失败落 error 态由 UI 呈现。
   *  Always pull on a mutation: the mounted producer's push can lag the host's
   *  registry reorder (create → prepend → insertBefore), so relying on the
   *  freshness check here left new worktrees/sessions stranded at the prepended
   *  head until the next 30s poll (2026-08 user report). */
  useEffect(() => {
    return chamberBridge.onRefresh((sourceId) => {
      void refreshAggregate(sourceId)
    })
  }, [refreshAggregate])

  /**
   * Mounted source ctxs publish the same complete snapshot shape as the unary
   * fallback. A push invalidates any older in-flight pull before committing;
   * an incomplete/reconnecting producer withdraws its snapshot and the
   * immediate fallback reevaluation above takes over.
   */
  useEffect(() => {
    return chamberBridge.onInstanceSnapshot((sourceId, snapshot: InstanceSnapshot | undefined) => {
      aggregateSeqRef.current[sourceId] = (aggregateSeqRef.current[sourceId] ?? 0) + 1
      if (snapshot === undefined) {
        delete snapshotSourcesRef.current[sourceId]
        delete snapshotAtRef.current[sourceId]
      } else {
        snapshotSourcesRef.current[sourceId] = true
        snapshotAtRef.current[sourceId] = Date.now()
      }
      setSnapshotSources(prev => {
        if (snapshot === undefined) {
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        }
        if (prev[sourceId] === true) return prev
        return { ...prev, [sourceId]: true }
      })
      if (snapshot === undefined) return
      // A mounted ctx can deliver a late store notification after its
      // transport generation died. Keep producer ownership, but never let
      // that notification overwrite the authoritative not-connected row;
      // the next ready edge performs one unary refresh.
      if (!readyAggregateSourcesRef.current.has(sourceId)) return
      setAggregates(prev => {
        const current = prev[sourceId]
        if (current !== undefined && current.state === 'ok'
          && instanceSnapshotSignature(current) === instanceSnapshotSignature(snapshot)) return prev
        return { ...prev, [sourceId]: { state: 'ok', ...snapshot, error: null } }
      })
    })
  }, [])

  useEffect(() => {
    return chamberBridge.onPluginDiagnostic((sourceId, diagnostic) => {
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

  /** 每来源 ctx 的运行时事实上报（06 §4）：report 覆盖、clear 删除；同时
   *  对账该来源的「完成未读」蓝点（completedBySource）。无需额外依赖。 */
  useEffect(() => {
    return chamberBridge.onRuntimeReport((sourceId, report) => {
      setRuntimeFacts(prev => {
        if (report === undefined) {
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        }
        // identity-preserving：同内容上报（store 通知但事实未变的常态）不换
        // state 对象——否则每次上报都触发 servers 重新派生与 publish（2026-08
        // perf pass）。
        const current = prev[sourceId]
        if (current !== undefined && runtimeReportSignature(current) === runtimeReportSignature(report)) {
          return prev
        }
        return { ...prev, [sourceId]: report }
      })
      if (report === undefined) {
        // shell 卸载（来源移除）：清掉该来源的边沿记忆与蓝点。
        delete prevRunningRef.current[sourceId]
        setCompletedBySource(prev => {
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        })
        return
      }
      // 蓝点对账（规则与 vendor 提醒同构，但「正在阅读」取 App 侧事实——
      // 活动视图的 current 会话，而非各来源自己可能陈旧的 selected；纯函数
      // 见 shared/derive.ts reconcileCompletedFacts）。边沿记忆 ref 在本
      // handler 同步推进（幂等），蓝点 state 在函数式 updater 里按序组合
      // ——同来源两次上报落在同一渲染周期也不会互相覆盖丢蓝点。每份上报
      // 各自捕获 prevRunning 快照，保证 updater 与自己的上报正确配对。
      const prevRunningSnapshot = prevRunningRef.current[sourceId] ?? {}
      const nextRunning: Record<string, boolean> = {}
      for (const [sessionId, row] of Object.entries(report.sessions)) {
        nextRunning[sessionId] = row?.running === true
      }
      prevRunningRef.current[sourceId] = nextRunning
      // 活动来源的 current 会话 = 正在阅读；后台来源无阅读者（undefined）。
      const readingCurrent = sourceId === activeViewRef.current ? report.current : undefined
      setCompletedBySource(prev => {
        const result = reconcileCompletedFacts({
          sessions: report.sessions,
          nextRunning,
          prevRunning: prevRunningSnapshot,
          prevCompleted: prev[sourceId] ?? {},
          readingCurrent,
        })
        if (!result.changed) return prev
        return { ...prev, [sourceId]: result.completed }
      })
    })
  }, [])

  /** chamber (06 §4.1)：切到某来源时，其 current 会话立即视为已读——清除
   *  后台期间武装的蓝点（阅读解除在 reconcile 里按上报做，这里兜底「激活但
   *  无新上报」的路径，如点击来源头不打开会话）。 */
  const prevActiveViewRef = useRef(activeView)
  useEffect(() => {
    const previous = prevActiveViewRef.current
    prevActiveViewRef.current = activeView
    if (previous === activeView) return
    const current = runtimeFacts[activeView]?.current
    if (current === undefined) return
    setCompletedBySource(prev => {
      const sourceCompleted = prev[activeView]
      if (sourceCompleted === undefined || sourceCompleted[current] !== true) return prev
      const nextCompleted = { ...sourceCompleted }
      delete nextCompleted[current]
      return { ...prev, [activeView]: nextCompleted }
    })
  }, [activeView])

  // 控制面失联 = 覆盖式致命屏（视图保持挂载、恢复即续会话，05 §4）。判定：
  // 健康错误**持续**存在超过宽容窗才呈现——首帧（health 从未拉到）立即呈现；
  // 会话中途则要求错误持续 HEALTH_ERROR_GRACE_MS（容忍 SSE 重连/瞬时抖动的
  // 一次失败，避免闪烁），否则陈旧 health 会永远掩盖中途失联。ticker 只在该
  // 条件下运行，正常态零开销。
  const HEALTH_ERROR_GRACE_MS = 10_000
  const [healthErrorTick, setHealthErrorTick] = useState(0)
  useEffect(() => {
    if (healthError === null || healthErrorAt === null) return
    const timer = setInterval(() => setHealthErrorTick(tick => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [healthError, healthErrorAt])
  const controlUnreachable =
    healthError !== null &&
    (health === null || (healthErrorAt !== null && Date.now() - healthErrorAt >= HEALTH_ERROR_GRACE_MS))

  // 活动视图的 shell 失败报告（05 §4 失败呈现修订）：boot 失败 settle 后由
  // InstanceView 上报终态；只有失败态（error 非空）触发覆盖层——booting/
  // 成功态由骨架屏/真实 UI 呈现。
  const activeShellError = shellStates[activeView]?.error ?? null

  return (
    <ErrorBoundary>
      <div className="app">
        {/* 视图始终挂载：致命屏改为覆盖层——卸载视图而不 dispose shell 会
            遗留僵尸 ctx（entries 被新 boot 覆盖、旧 ctx 永不清除，违反
            05 §4 无僵尸不变量），且恢复后要重 boot 丢会话连续性。 */}
        {mountedViews.map((viewId) => (
          <InstanceView
            key={viewId}
            instanceId={viewId}
            basePath={instanceBasePath(viewId)}
            active={activeView === viewId}
            label={serverLabels[viewId] ?? (viewId === LOCAL_INSTANCE_ID ? '本地实例' : viewId)}
            onSettled={handleInstanceSettled}
            onStateChange={handleShellState}
            retryToken={retryTokens[viewId]}
          />
        ))}
        {/* chamber (2026-08 失败呈现修订, 05 §4)：活动视图 boot 失败 = 该视图
            的 dsh shell 从未挂载——导航（侧边栏在 shell 内）随之不可用，若不
            提供逃生通道，用户会被失败报告困在当前视图（只能整页刷新）。
            覆盖层 = 失败报告 + 重试 + 服务器切换：失败以 chamber 层呈现，
            绝不阻断切换/重试（正确性不变量：一个实体的失败不得抹除/阻断
            无关的健康实体）。仅活动视图渲染；非活动视图失败在激活时呈现。
            控制面不可达（controlUnreachable）是更高层的全局条件，渲染在其
            之上（下方 JSX 顺序在后）。 */}
        {activeShellError !== null && (
          <div className="fatal fatal-overlay">
            <div role="alert">
              <div className="fatal-title">实例启动失败</div>
              <div className="fatal-message">{activeShellError}</div>
            </div>
            <button
              className="btn primary"
              onClick={() => {
                // 重试 = 重新 boot 该视图；error/degraded 隧道同时立即再试
                // （与 selectView 同语义——boot 失败若由隧道故障引起，不重连
                // 则重试只会再次失败）。
                ensureRemoteConnected(activeView)
                setRetryTokens(prev => ({ ...prev, [activeView]: (prev[activeView] ?? 0) + 1 }))
              }}
            >
              重试
            </button>
            {servers.length > 1 && (
              <div className="fatal-servers">
                <span className="muted small">切换到其他服务器：</span>
                {servers.map(server => (
                  server.id === activeView ? null : (
                    <button
                      key={server.id}
                      className="btn"
                      onClick={() => selectView(server.id)}
                    >
                      {/* 空 label 回退 id，避免出现无标签的切换按钮 */}
                      {server.label !== '' ? server.label : server.id}
                    </button>
                  )
                ))}
              </div>
            )}
          </div>
        )}
        {controlUnreachable && (
          <div className="fatal fatal-overlay">
            <div className="fatal-title">无法连接控制面</div>
            <div className="fatal-message">{healthError}</div>
            <button
              className="btn primary"
              onClick={() => {
                void refreshHealth()
                void refreshConnections()
              }}
            >
              重试
            </button>
          </div>
        )}
      </div>
    </ErrorBoundary>
  )
}
