/**
 * 事实源生命周期簇：gateway 只读事实源与 SSH/dsh 远端无壳观察者的创建/收敛/退订，
 * 外加 pagehide/hidden 落盘 flush 这条全局监听。
 * 稳定签名（id + 化身指纹 + connected）决定重探/停订阅；判定与状态仍在既有纯模块与 App
 * 的 ref/state 容器里，本 hook 只做订阅生命周期装配。
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core'
import { subscribePageChannel } from '@dsh-chamber/dsh-chamber-client-core/page-channel'
import { shouldRunBackgroundPhase } from '../background-phase.ts'
import type { FactsStore } from '../host/facts-store.ts'
import type { MountedSourcesStore } from '../host/mounted-sources-store.ts'
import { createSessionFactsSource, type SessionFactsSnapshot, type SessionFactsSource } from '../session-facts-source.ts'
import { createSourceMuxFacts, isMuxObservableSourceKind, type SourceMuxFacts } from '../source-mux-facts.ts'
import { createFactsHealthRecorder, createFactsStepGuard, type FactsHealthRecorder, type FactsStepGuard } from '../facts-health.ts'
import { shouldDispatchRefreshHint } from '../source-refresh-hint.ts'
import type { NotificationSaveCoalescer } from '../notification-store.ts'

/**
 * A3 **调试开关**（devtools/测试用，**默认关闭**）：打开后不再为「已挂载壳」的来源创建
 * gateway 事实源 / mux 观察者——挂载壳的官方 ctx 快照已经是行权威，facts 订阅在那类来源
 * 上是冗余的事实面。这里只提供开关，收益由 macOS 真机 A/B 量化。
 *
 * 读取纪律沿用既有页面级 devtools 开关先例（live-graph.ts 的
 * `__DSH_CHAMBER_LIVE_PLUGIN_SYNC__`）：arm/渲染时读取、**无缓存**、不做持久化（刷新即回默认）；
 * 与那个开关相反的方向：那个默认开、只认显式 `false` 关；本开关默认关、只认显式 `true` 开。
 *
 * **风险（只允许调试 A/B，绝不默认启用）**：开关打开时，mounted 表变化会让来源进出 desired
 * 集 ⇒ 走既有 teardown——gateway 侧 `factsStore.dropSession + withdrawSource`（= 事实载体
 * 换代 S2：旧代数行立刻删除、通知账本的易失轨与观测状态撤回），mux 侧 `stop()` 退役快照 +
 * `withdrawSource`。也就是每个「挂载」边沿可能触发一次换代：待结算的完成候选可能被撤回、
 * 完成点会被重新播种，通知完整性必须作为 A/B 的观察指标而不是被假设不变。另：mounted 是 sticky 权威位（壳静默死亡后不撤）——开关打开时若壳静默死亡 >~5min 而 observer 已不存在，该来源只剩 enabled=false 的 gate 与归档动作；A/B 协议必须含「隐藏壳静默死亡 + 恢复」。
 */
const A3_SKIP_MOUNTED_FACTS_GLOBAL = '__DSH_CHAMBER_A3_SKIP_MOUNTED_FACTS__'

/**
 * Arm-time read of the A3 dev flag (no cache, default OFF): only an explicit boolean
 * `true` enables it; a missing key or any other value keeps the shipped behavior
 * (every source subscribes, exactly as before the flag existed).
 * @param scope - default globalThis; tests inject an equivalent object.
 */
export function readA3SkipMountedFacts(scope: unknown = globalThis): boolean {
  if (typeof scope !== 'object' || scope === null) return false
  return (scope as Record<string, unknown>)[A3_SKIP_MOUNTED_FACTS_GLOBAL] === true
}

/** 一个来源在 facts 订阅面的期望态：建哪类实例由 gateway/mux 两个列表分别表达。 */
export interface SessionFactsSourcePlanEntry {
  readonly id: string
  readonly fingerprint: string
  readonly connected: boolean
}

/** facts 订阅面的期望态（顺序 = servers 顺序；spec 字符串依赖它做稳定比较）。 */
export interface SessionFactsSourcePlan {
  /** gateway 只读事实源：全部 `kind === 'gateway'` 来源（connected 只进签名）。 */
  readonly gateway: readonly SessionFactsSourcePlanEntry[]
  /** 无壳观察者：全部 dsh 协议来源（列表事实，connected 过滤由调用方保持原语义）。 */
  readonly mux: readonly SessionFactsSourcePlanEntry[]
}

/**
 * facts 订阅面的**唯一期望态规划器**：spec 签名与两个 effect 的 wanted 收敛共用这一份逻辑
 * （此前两处各自重写过滤条件，A3 开关再复制第三份就会漂移）。
 *
 * `mounted === undefined` = A3 开关关（默认）：**逐字**返回既有行为（每个来源一条订阅）。
 * `mounted` 表在场 = A3 开关开：剔除 `mounted[id] === true` 的已挂载来源。
 * 只读入参、不碰 store，纯函数（单测直接钉两态）。
 */
export function planSessionFactsSources(
  servers: readonly ChamberServerAggregate[],
  mounted?: Readonly<Record<string, true>>,
): SessionFactsSourcePlan {
  const gateway: SessionFactsSourcePlanEntry[] = []
  const mux: SessionFactsSourcePlanEntry[] = []
  for (const server of servers) {
    if (mounted !== undefined && mounted[server.id] === true) continue
    if (server.kind === 'gateway') {
      gateway.push({ id: server.id, fingerprint: server.sourceFingerprint, connected: server.connected })
      continue
    }
    if (isMuxObservableSourceKind(server.kind)) {
      mux.push({ id: server.id, fingerprint: server.sourceFingerprint, connected: server.connected })
    }
  }
  return { gateway, mux }
}

/** 期望态的稳定签名（既有格式逐字保留：`id:fingerprint:connected` 以 `|` 连接）。 */
export function sessionFactsSpecSignature(
  sources: readonly SessionFactsSourcePlanEntry[],
): string {
  return sources.map(source => source.id + ':' + source.fingerprint + ':' + (source.connected ? '1' : '0')).join('|')
}

export interface SessionFactsLifecycleDeps {
  /** deriveServers 的当前投影（签名与收敛都从最新 servers 读）。 */
  servers: ChamberServerAggregate[]
  applySessionFacts: (sourceId: string, snapshot: SessionFactsSnapshot | undefined) => void
  /** 通知落盘合并器（pagehide/hidden/unmount 走它的关键路径 flush；hook 只调用不拥有）。 */
  notificationImmediateSave: NotificationSaveCoalescer
  /** 聚合簇的「无法确认」标记（行刷新提示的 unverified 拒绝输入）。 */
  unverifiedSourcesRef: { current: readonly string[] }
  /** 每来源在途 unary 拉取计数（提示的 inFlight 拒绝输入）。 */
  factsPullInFlightRef: { current: Record<string, number> }
  /** 行刷新提示的 floor 记账（每来源）。 */
  refreshHintAtRef: { current: Record<string, number> }
  /** 聚合拉取的稳定入口，**有界**：单来源入共享刷新波（队列去重 + 4 并发帽）。 */
  refreshAggregateRef: { current: (sourceId: string) => void }
  /** 已发布完整权威快照的来源；这类来源不需要 facts 提示再走 unary 会话列表。 */
  mountedSources: MountedSourcesStore
  /** 已挂载来源的运行时事实（步进/收敛的输入之一）。 */
  factsStore: FactsStore
  /** 活跃事实源实例（gateway 来源；指纹变化 = 新化身重探）。 */
  sessionFactsSourcesRef: { current: Map<string, SessionFactsSource> }
  /** 每个实例的退订 + stop 合成器（来源退役/降级时调用一次）。 */
  sessionFactsTeardownRef: { current: Map<string, () => void> }
  /** 非 gateway 来源的无壳观察者退订与身份表。 */
  sourceMuxTeardownRef: { current: Map<string, () => void> }
  sourceMuxIdentityRef: { current: Map<string, string> }
  /**
   * 来源撤回（facts 源退役 / 观察者换代）：删该来源的 running 边沿记忆与观测状态、
   * 撤回通知账本易失轨；修正臂冻结不误清。与桥面 report=undefined 撤回同语义；没有它，
   * 新化身会继承旧化身的边沿记忆 ⇒ 假完成点（INV-7）。
   */
  withdrawSource: (sourceId: string) => void
}

/** 事实源生命周期装配；无对外返回值（调用面全在 App 的既有 ref/回调上）。 */
export function useSessionFactsLifecycle(deps: SessionFactsLifecycleDeps): void {
  const {
    servers, applySessionFacts, notificationImmediateSave,
    unverifiedSourcesRef, factsPullInFlightRef, refreshHintAtRef, refreshAggregateRef,
    mountedSources,
    factsStore, sessionFactsSourcesRef, sessionFactsTeardownRef,
    sourceMuxTeardownRef, sourceMuxIdentityRef, withdrawSource,
  } = deps

  /** servers 的渲染期镜像（facts effect 闭包不随每次 servers 重建）。 */
  const serversRef = useRef(servers)
  serversRef.current = servers
  const sourceMuxObserversRef = useRef(new Map<string, SourceMuxFacts>())
  /**
   * 事实健康面包屑（本 hook 的记录点：与 use-notifications 各自一个 recorder 实例、
   * 同一权威日志环、记录点不同）：观察者每次快照后采样一次，状态不变不写环。它给「观察者
   * 一直不可判」这类形状留下盘上时间线——没有它，画面外的人只能看到空账本。
   */
  const factsHealthRef = useRef<FactsHealthRecorder | null>(null)
  factsHealthRef.current ??= createFactsHealthRecorder()
  /** 步骤级 never-throw 包装：每个 listener 注册边界（emit 环看不到 chamber listener 抛错）。 */
  const factsStepGuardRef = useRef<FactsStepGuard | null>(null)
  factsStepGuardRef.current ??= createFactsStepGuard(factsHealthRef.current)
  const factsStepGuard = factsStepGuardRef.current

  useEffect(() => {
    const reconcile = (): void => {
      for (const source of sessionFactsSourcesRef.current.values()) source.reconcile()
      for (const observer of sourceMuxObserversRef.current.values()) observer.reconcile()
    }
    window.addEventListener('dsh-chamber:sidecar-ready', reconcile)
    return () => window.removeEventListener('dsh-chamber:sidecar-ready', reconcile)
  }, [])

  /**
   * 行刷新提示：facts 的 session-added/removed/changed ⇒ 该来源一次 unary 聚合拉取
   * （行权威仍在聚合，不做第二行源）。已发布完整快照的 mounted 来源先拒绝；其余四拒：
   * 未连接 / unverified / 在途 / 前台相位不可运行；外加 1s floor。前台相位判定走上游唯一门
   * shouldRunBackgroundPhase（document.visibilityState + 壳可见性事实；WKWebView 在另一
   * Space / 完全遮挡 / orderOut 时页面仍 visible），本 hook 不另开第二判断；隐藏期不发起
   * 拉取，恢复由聚合 watchdog 的 visibilitychange / 宿主壳可见边沿补偿。
   */
  const requestFactsRefresh = useCallback((sourceId: string): void => {
    // Mounted sources already publish their complete rows through the official
    // ctx snapshot path. Fetching session/list again for each facts edge is
    // redundant and can occupy WebKit's per-origin connection pool alongside
    // the independent facts baseline and authority probes. Its weaker unary
    // title projection can also replace a mounted display title with cwd's
    // basename until the next official ctx snapshot arrives.
    if (mountedSources.getSnapshot()[sourceId] === true) return
    const server = serversRef.current.find(candidate => candidate.id === sourceId)
    const now = Date.now()
    if (!shouldDispatchRefreshHint({
      connected: server?.connected === true,
      unverified: unverifiedSourcesRef.current.includes(sourceId),
      inFlight: (factsPullInFlightRef.current[sourceId] ?? 0) > 0,
      visible: shouldRunBackgroundPhase(document.visibilityState),
      lastHintAt: refreshHintAtRef.current[sourceId],
      now,
    })) return
    refreshHintAtRef.current[sourceId] = now
    refreshAggregateRef.current(sourceId)
  }, [mountedSources])

  /**
   * 行刷新提示的唯一 guard 调用点（gateway 事实源与无壳观察者共用）：每步骤恰好一个
   * never-throw 包装，两条生产者不得各包一层。
   */
  const stepRowHint = useCallback((sourceId: string): void => {
    factsStepGuard.guard(sourceId, 'facts-row-hint', () => requestFactsRefresh(sourceId))
  }, [factsStepGuard, requestFactsRefresh])

  // A3 调试开关（默认关）：每次渲染读取，无缓存。关闭时下面的 mounted 订阅是 no-op、
  // 规划器收到 undefined ⇒ 期望态与改动前逐字相同（行为零变化）。
  const a3SkipMountedFacts = readA3SkipMountedFacts()
  // mounted 表只在 A3 开时才驱动重算：关时故意**不订阅**（默认路径不新增 listener）。
  const subscribeMountedFacts = useCallback(
    (onStoreChange: () => void) => (
      a3SkipMountedFacts ? mountedSources.subscribe(onStoreChange) : () => {}
    ),
    [a3SkipMountedFacts, mountedSources],
  )
  const mountedFactsTable = useSyncExternalStore(
    subscribeMountedFacts,
    mountedSources.getSnapshot,
    mountedSources.getSnapshot,
  )
  /** facts 订阅面的期望态（spec 签名与两个 effect 的唯一输入；A3 开时才剔除已挂来源）。 */
  const factsSourcePlan = useMemo(
    () => planSessionFactsSources(servers, a3SkipMountedFacts ? mountedFactsTable : undefined),
    [servers, a3SkipMountedFacts, mountedFactsTable],
  )
  /** facts 生命周期稳定签名：来源 id + 化身指纹 + connected；指纹变化 = 新化身，
   *  connected 边沿 = 重探/停流。A3 开时 mounted 边沿会改签名 ⇒ effect 重算（含 teardown）。 */
  const gatewayFactsSpec = useMemo(() => sessionFactsSpecSignature(factsSourcePlan.gateway), [factsSourcePlan])
  useEffect(() => {
    // 期望态与渲染期 spec 同源（规划器唯一）：effect 只读最新 servers/mounted 事实。
    const plan = planSessionFactsSources(
      serversRef.current,
      a3SkipMountedFacts ? mountedSources.getSnapshot() : undefined,
    )
    const wanted = new Map<string, { fingerprint: string; connected: boolean }>()
    for (const source of plan.gateway) {
      wanted.set(source.id, { fingerprint: source.fingerprint, connected: source.connected })
    }
    for (const [sourceId, teardown] of [...sessionFactsTeardownRef.current]) {
      if (wanted.has(sourceId)) continue
      // teardown 自身负责 facts 行删除（S2 单点）；这里只收敛引用。
      teardown()
      sessionFactsTeardownRef.current.delete(sourceId)
      sessionFactsSourcesRef.current.delete(sourceId)
    }
    for (const [sourceId, input] of wanted) {
      let source = sessionFactsSourcesRef.current.get(sourceId)
      if (source === undefined) {
        const created = createSessionFactsSource({
          sourceId,
          onDiagnostic: (message, error) => console.warn(message, error ?? ''),
          // 增量面 = 页面唯一长连接上的一条逻辑订阅：通道自己重连、重订阅与按字节确认，
          // 事实源只持有代际/指纹门与 close()（不得自排重连阶梯）。
          subscribeSessionFacts: handlers => subscribePageChannel({
            family: 'sessionFacts',
            instanceId: sourceId,
            onItem: handlers.onItem,
            onOpen: () => { handlers.onOpen?.() },
            onError: (code, message) => { handlers.onError?.(code, message) },
          }),
        })
        source = created
        // Single boundary: applySessionFacts IS the 'apply-session-facts' never-throw register boundary.
        const unsubscribeFacts = created.subscribe(snapshot => applySessionFacts(sourceId, snapshot))
        const unsubscribeHint = created.onRowHint(() => stepRowHint(sourceId))
        sessionFactsSourcesRef.current.set(sourceId, created)
        sessionFactsTeardownRef.current.set(sourceId, () => {
          unsubscribeFacts()
          unsubscribeHint()
          created.stop()
          // 退役 = 新来源代：fact 行必须同拍删除（S2）。retireSources 直接调这条
          // teardown（不经过下面「不再需要」循环），缺了它同 id 新化身会继承上一代的
          // facts 快照（旧 overlay/记忆）。mux 观察者 teardown 不 drop：stop() 先发布
          // 「保留最后一批行 + degraded/stale」的退役快照（design 19 §3.5 载体终结纪律），
          // 行的最终删除由 App 注册表收敛的 pruneSourceRecord(factsStore runtime, live)
          // 承担——这里 drop 会把旧化身最后一批行误当权威空集（两侧不对称是既有纪律）。
          factsStore.dropSession(sourceId)
          withdrawSource(sourceId)
        })
      }
      source.update(input)
    }
  }, [gatewayFactsSpec, a3SkipMountedFacts, applySessionFacts, requestFactsRefresh, stepRowHint, factsStepGuard])

  /**
   * SSH / 其它 dsh 远端来源的**无壳观察者**：这些来源没有只读镜像，关壳期间没有事实
   * 通道，完成会丢。观察者讲实例自己的远程协议，产出的快照与 gateway 事实源**同形**，
   * 直接喂同一条 applySessionFacts 管线（同一份事实、同一套通知判定）；只观察，永不结算瀑布。
   */
  const sourceMuxSpec = useMemo(() => sessionFactsSpecSignature(factsSourcePlan.mux), [factsSourcePlan])
  useEffect(() => {
    // 与渲染期 spec 同源（规划器唯一）；mux 观察者仍只对 connected 来源建实例（既有语义）。
    const plan = planSessionFactsSources(
      serversRef.current,
      a3SkipMountedFacts ? mountedSources.getSnapshot() : undefined,
    )
    const wanted = new Map<string, string>()
    for (const source of plan.mux) {
      if (source.connected !== true) continue
      wanted.set(source.id, source.fingerprint)
    }
    for (const [sourceId, teardown] of [...sourceMuxTeardownRef.current]) {
      // 身份变了（同 id 新指纹）也必须拆：旧观察者的 rows/runningBefore 属于旧化身。
      if (wanted.get(sourceId) === sourceMuxIdentityRef.current.get(sourceId)) continue
      teardown()
      sourceMuxTeardownRef.current.delete(sourceId)
      sourceMuxIdentityRef.current.delete(sourceId)
      sourceMuxObserversRef.current.delete(sourceId)
    }
    for (const [sourceId, fingerprint] of wanted) {
      if (sourceMuxTeardownRef.current.has(sourceId)) continue
      // 观察者实例要先有才能采样（onSnapshot 闭包在构造时就存在，只能经 created 拿实例）：
      // createSourceMuxFacts 构造期不 emit，且赋值在 start() 之前 ⇒ 这里必定已赋值，无需恒真守卫。
      let created: SourceMuxFacts | null = null
      const sampleFactsHealth = (): void => {
        const status = created!.status()
        factsHealthRef.current?.record(sourceId, {
          ready: status.ready,
          staleSince: status.staleSince,
          baselines: status.baselines,
          baselineFailures: status.baselineFailures,
          baselineResamples: status.baselineResamples,
          baselineFailureReason: status.baselineFailureReason,
          reconnects: status.reconnects,
          socketErrors: status.socketErrors,
          rows: status.rows,
          lastTrustedBaselineAt: status.lastTrustedBaselineAt,
        })
      }
      const observer = createSourceMuxFacts({
        sourceId,
        origin: window.location.origin,
        onSnapshot: snapshot => {
          factsStepGuard.guard(sourceId, 'mux-snapshot', () => {
            applySessionFacts(sourceId, snapshot)
            sampleFactsHealth()
          })
        },
        // 行刷新提示：与 gateway 事实源同规 ⇒ 该来源一次 unary 聚合拉取（G1 的真实通路）。
        onRowHint: () => stepRowHint(sourceId),
      })
      created = observer
      observer.start()
      sourceMuxObserversRef.current.set(sourceId, observer)
      // The mux observer registers NO content-stall evidence: source-level $events
      // silence is not this session's content progress (see session-content-stall.ts).
      sourceMuxTeardownRef.current.set(sourceId, () => {
        observer.stop()
        sourceMuxObserversRef.current.delete(sourceId)
        withdrawSource(sourceId)
      })
      sourceMuxIdentityRef.current.set(sourceId, fingerprint)
    }
  }, [sourceMuxSpec, a3SkipMountedFacts, applySessionFacts, requestFactsRefresh, stepRowHint, factsStepGuard])

  useEffect(() => {
    // 关键路径 = 合并器的 flush：取消待办的微任务 + 同步落最新状态（不丢、不重复）。
    const flush = (): void => notificationImmediateSave.flush()
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      notificationImmediateSave.flush()
    }
  }, [notificationImmediateSave])
}
