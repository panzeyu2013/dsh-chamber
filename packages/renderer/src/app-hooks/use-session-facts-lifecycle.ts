/**
 * 事实源生命周期簇：gateway 只读事实源与 SSH/dsh 远端无壳观察者的创建/收敛/退订，
 * 外加 focus/blur 步进完成臂与 pagehide/hidden 落盘 flush 两条全局监听。
 * 稳定签名（id + 化身指纹 + connected）决定重探/停流；判定与状态仍在既有纯模块与 App
 * 的 ref/state 容器里，本 hook 只做订阅生命周期装配。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core'
import type { FactsStore } from '../host/facts-store.ts'
import { createSessionFactsSource, type SessionFactsSnapshot, type SessionFactsSource } from '../session-facts-source.ts'
import { createSourceMuxFacts, isMuxObservableSourceKind, type SourceMuxFacts } from '../source-mux-facts.ts'
import { createFactsHealthRecorder, createFactsStepGuard, type FactsHealthRecorder, type FactsStepGuard } from '../facts-health.ts'
import { shouldDispatchRefreshHint } from '../source-refresh-hint.ts'
import type { NotificationSaveCoalescer } from '../notification-store.ts'

export interface SessionFactsLifecycleDeps {
  /** deriveServers 的当前投影（签名与收敛都从最新 servers 读）。 */
  servers: ChamberServerAggregate[]
  applySessionFacts: (sourceId: string, snapshot: SessionFactsSnapshot | undefined) => void
  /** 完成点步进（focus/blur 的重算入口；臂本体在 use-notifications）。 */
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
  /** 已挂载来源的运行时事实（focus 重算的键空间之一）。 */
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
   * （行权威仍在聚合，不做第二行源）。四拒：未连接 / unverified / 在途 / 页面不可见；
   * 外加 1s floor。可见性直接读 document（本 hook 没有可复用的可见性 ref/监听，也不新增；
   * 隐藏期不发起拉取，恢复可见由聚合 watchdog 的 visibilitychange 补偿）。
   */
  const requestFactsRefresh = useCallback((sourceId: string): void => {
    const server = serversRef.current.find(candidate => candidate.id === sourceId)
    const now = Date.now()
    if (!shouldDispatchRefreshHint({
      connected: server?.connected === true,
      unverified: unverifiedSourcesRef.current.includes(sourceId),
      inFlight: (factsPullInFlightRef.current[sourceId] ?? 0) > 0,
      visible: document.visibilityState === 'visible',
      lastHintAt: refreshHintAtRef.current[sourceId],
      now,
    })) return
    refreshHintAtRef.current[sourceId] = now
    refreshAggregateRef.current(sourceId)
  }, [])

  /**
   * 行刷新提示的唯一 guard 调用点（gateway 事实源与无壳观察者共用）：每步骤恰好一个
   * never-throw 包装，两条生产者不得各包一层。
   */
  const stepRowHint = useCallback((sourceId: string): void => {
    factsStepGuard.guard(sourceId, 'facts-row-hint', () => requestFactsRefresh(sourceId))
  }, [factsStepGuard, requestFactsRefresh])

  /** facts 生命周期稳定签名：来源 id + 化身指纹 + connected；指纹变化 = 新化身，
   *  connected 边沿 = 重探/停流。 */
  const gatewayFactsSpec = useMemo(
    () => servers
      .filter(server => server.kind === 'gateway')
      .map(server => server.id + ':' + server.sourceFingerprint + ':' + (server.connected ? '1' : '0'))
      .join('|'),
    [servers],
  )
  useEffect(() => {
    const wanted = new Map<string, { fingerprint: string; connected: boolean }>()
    for (const server of serversRef.current) {
      if (server.kind !== 'gateway') continue
      wanted.set(server.id, { fingerprint: server.sourceFingerprint, connected: server.connected })
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
  }, [gatewayFactsSpec, applySessionFacts, requestFactsRefresh, stepRowHint, factsStepGuard])

  /**
   * SSH / 其它 dsh 远端来源的**无壳观察者**：这些来源没有只读镜像，关壳期间没有事实
   * 通道，完成会丢。观察者讲实例自己的远程协议，产出的快照与 gateway 事实源**同形**，
   * 直接喂同一条 applySessionFacts 管线（同一份事实、同一套通知判定）；只观察，永不结算瀑布。
   */
  const sourceMuxSpec = useMemo(
    () => servers
      .filter(server => isMuxObservableSourceKind(server.kind))
      .map(server => server.id + ':' + server.sourceFingerprint + ':' + (server.connected ? '1' : '0'))
      .join('|'),
    [servers],
  )
  useEffect(() => {
    const wanted = new Map<string, string>()
    for (const server of serversRef.current) {
      if (!isMuxObservableSourceKind(server.kind) || server.connected !== true) continue
      wanted.set(server.id, server.sourceFingerprint)
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
  }, [sourceMuxSpec, applySessionFacts, requestFactsRefresh, stepRowHint, factsStepGuard])

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
