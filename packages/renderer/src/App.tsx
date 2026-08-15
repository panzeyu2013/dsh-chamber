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
  isInstanceUnavailable,
  type ChamberServerAggregate,
  type InstanceAggregate,
  type InstanceRuntimeReport,
} from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import { openInstanceSession, disposeAllShells, disposeInstanceShell } from './shell.ts'
import { runViewTransition } from './view-transition.ts'
import { errorMessage } from './status.ts'
import type { SshInstanceSpec, SshStatusProjection } from './global.d.ts'
import InstanceView from './components/InstanceView.tsx'

const AGGREGATE_POLL_MS = 10000
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
  activeViewId: string,
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
    if (aggregate !== undefined && aggregate.state === 'ok') {
      // 当前会话事实只给活动来源：blank（新建未首发的）会话行只在正在查看的
      // 来源投影（06 §4.3 全局单选纪律）——否则每个已挂载来源都会冒出它的
      // 空"新建会话"行。其他来源 blank 行照旧不进入导航列表。
      const current = id === activeViewId ? runtimeFacts[id]?.current : undefined
      workspaces = deriveServerWorkspaces(aggregate, '', current)
    }
    const connected = instanceConnected(kind, health, remoteStatus, statusKey)
    const entry: ChamberServerAggregate = {
      id,
      kind,
      label,
      connected,
      phase,
      workspaces,
      updatedAt: now,
    }
    // 运行时事实只在 connected 时附加（断连态不应携带事实，避免死状态翻转）
    if (connected) {
      const runtime = runtimeFacts[id]
      if (runtime !== undefined) entry.runtime = runtime
    }
    if (aggregate !== undefined && aggregate.state === 'error') {
      entry.aggregateError = aggregate.error ?? '未知错误'
    }
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
  // 每实例 workspace/session 聚合（实例 API 轮询结果；控制面不持有会话事实）
  const [aggregates, setAggregates] = useState<Record<string, InstanceAggregate>>({})
  // 每实例运行时事实（06 §4）：来自各来源 ctx 的 chamberBridge 上报，仅附加
  const [runtimeFacts, setRuntimeFacts] = useState<Record<string, InstanceRuntimeReport | undefined>>({})

  // chamberBridge 投影（05 §3）：health/remoteStatus/aggregates 任一变化后
  // 派生并发布；首帧（health 未就绪）即发布 connected=false 的分组。
  const servers = useMemo(
    () => deriveServers(health, connections, remoteInstances, remoteStatus, aggregates, runtimeFacts, activeView),
    [health, connections, remoteInstances, remoteStatus, aggregates, runtimeFacts, activeView],
  )
  useEffect(() => {
    chamberBridge.publish(servers)
  }, [servers])

  // 渲染期注册表 id 镜像（与 commit 同步，微任务/事件回调安全）：selectView
  // 与 openSession 在 apply 时用它拒绝已回收来源（视图生命周期 = 注册表条目
  // 生命周期，05 §4）——效果同 prewarmEligibleRef 的镜像纪律。
  const liveServerIdsRef = useRef<Set<string>>(new Set())
  const liveServerIds = useMemo(() => new Set(servers.map(server => server.id)), [servers])
  liveServerIdsRef.current = liveServerIds

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
      for (const id of removed) disposeInstanceShell(id)
      setMountedViews(prev => {
        const next = prev.filter(id => live.has(id))
        return next.length === prev.length ? prev : next
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
   * （拖拽 commit 前的轮询快照可能晚于 refresh 拉取到达，造成至多 10s 的
   * 陈旧排序）。
   */
  const aggregateSeqRef = useRef<Record<string, number>>({})
  const refreshAggregate = useCallback(async (instanceId: string) => {
    const seq = (aggregateSeqRef.current[instanceId] ?? 0) + 1
    aggregateSeqRef.current[instanceId] = seq
    try {
      const snapshot = await fetchInstanceSnapshot(getInstanceClient(instanceId))
      if (aggregateSeqRef.current[instanceId] !== seq) return
      setAggregates(prev => ({ ...prev, [instanceId]: { state: 'ok', ...snapshot, error: null } }))
    } catch (err) {
      if (aggregateSeqRef.current[instanceId] !== seq) return
      setAggregates(prev => ({ ...prev, [instanceId]: emptyAggregate('error', errorMessage(err)) }))
      // 反代 503 = 权威"未就绪"信号（03 §3.3）：本地 /health 可能还停留在
      // 旧 ready（最多一个健康轮询周期的陈旧窗口），立即刷新使连接判定
      // 尽快翻转（否则错误行要挂到下一个健康轮询才被 not-connected 替换）。
      if (isInstanceUnavailable(err)) void refreshHealth()
    }
  }, [refreshHealth])

  /** 轮询就绪实例的聚合；未就绪实例落 not-connected（不显示陈旧数据）。 */
  const pollAggregates = useCallback(() => {
    const ready: { kind: 'local' | 'ssh'; id: string }[] = []
    const notReady: string[] = []
    if (instanceConnected('local', health, remoteStatus, LOCAL_INSTANCE_ID)) {
      ready.push({ kind: 'local', id: LOCAL_INSTANCE_ID })
    } else {
      notReady.push(LOCAL_INSTANCE_ID)
    }
    for (const instance of remoteInstances) {
      if (instanceConnected('ssh', health, remoteStatus, instance.id)) {
        ready.push({ kind: 'ssh', id: `ssh-${instance.id}` })
      } else {
        notReady.push(`ssh-${instance.id}`)
      }
    }
    for (const entry of ready) void refreshAggregate(entry.id)
    if (notReady.length > 0) {
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
  }, [health, remoteStatus, remoteInstances, refreshAggregate])

  const pollAggregatesRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    pollAggregatesRef.current = pollAggregates
  })

  // 连接事实（health / 隧道相位 / 注册表）变化即重估聚合，不等下一个 10s
  // tick：ready↔degraded 转换瞬间的错误行在下一次状态推送后立即被
  // not-connected/正常数据替换，不残留到轮询周期。
  useEffect(() => {
    pollAggregatesRef.current()
  }, [health, remoteStatus, remoteInstances])

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

    const aggregateTimer = setInterval(() => {
      if (cancelled) return
      pollAggregatesRef.current()
    }, AGGREGATE_POLL_MS)

    window.addEventListener('beforeunload', disposeAllShells)

    return () => {
      cancelled = true
      clearInterval(connectionsTimer)
      clearInterval(remotesTimer)
      clearInterval(aggregateTimer)
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
    return () => {
      unsubscribe()
      unsubscribeInstances()
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
   * 不依赖本地实例。绝不重复 connect 已见过的 id：connect 对 connecting/
   * ready 幂等，但对 degraded（会清零退避计数重启重试周期）与 error（终态，
   * 需用户处置）有副作用，且会 30s 后把用户手动断开的实例重新拉起——「仅
   * 新 id」同时守住有界重试、终态语义与手动断开。id 随注册表删除移出，
   * 重新添加即再次自动连接。
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
    if (viewId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(viewId)) return
    // 镜像查重（非闭包）：在途/顺延中的同一意图直接跳过；已落地视图只有在
    // 无在途意图时才跳过——过渡在途时 UI 仍显示旧视图，点击旧视图 = 撤销
    // 意图（最后一次意图胜出，view-transition.ts），不能按当前态误丢。
    // 被回收来源在 apply 时被守卫否决后 pendingViewRef 已清空，重加后的点击
    // 不被残留意图误吞。
    if (viewId === pendingViewRef.current) return
    if (pendingViewRef.current === null && viewId === activeViewRef.current) return
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
    })
  }, [])

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
    const eligible = new Set(
      remoteInstances
        .filter(instance => remoteStatus[instance.id]?.phase === 'ready')
        .map(instance => `ssh-${instance.id}`),
    )
    for (const id of mountedViews) eligible.delete(id)
    return eligible
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
    setMountedViews(prev => (prev.includes(next) ? prev : [...prev, next]))
  }, [])

  const handleInstanceSettled = useCallback((instanceId: string) => {
    if (instanceId === LOCAL_INSTANCE_ID) localSettledRef.current = true
    if (prewarmInflightRef.current === instanceId) prewarmInflightRef.current = null
    // 无条件 drain：任何 settle 都可能是"在途预热完成"或"本地首次 settle"
    // 的触发器（后者在状态先于本地就绪时不会因依赖变化而触发队列推进）。
    drainPrewarm()
  }, [drainPrewarm])

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
  }, [selectView])

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

  /** 侧边栏动作成功后请求的即时刷新（chamberBridge.requestRefresh）；失败落 error 态由 UI 呈现。 */
  useEffect(() => {
    return chamberBridge.onRefresh((sourceId) => {
      void refreshAggregate(sourceId)
    })
  }, [refreshAggregate])

  /** 每来源 ctx 的运行时事实上报（06 §4）：report 覆盖、clear 删除；无需额外依赖（set 稳定）。 */
  useEffect(() => {
    return chamberBridge.onRuntimeReport((sourceId, report) => {
      setRuntimeFacts(prev => {
        if (report === undefined) {
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        }
        return { ...prev, [sourceId]: report }
      })
    })
  }, [])

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
          />
        ))}
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
