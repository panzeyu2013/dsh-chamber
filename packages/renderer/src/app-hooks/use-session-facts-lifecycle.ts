/**
 * 事实源生命周期簇：gateway 只读事实源（session-facts-source）与 SSH/dsh 远端
 * 无壳观察者（source-mux-facts）的创建 / 收敛 / 退订，外加两条与事实账本同域的
 * 全局监听（focus/blur 重算未读、pagehide/hidden 落盘 flush）。整段原样抽出。
 *
 * 稳定签名（id + 化身指纹 + connected）决定重探/停流；所有判定与状态仍在既有
 * 纯模块与 App 的 ref/state 容器里，本 hook 只做订阅生命周期装配。
 * Hook 调用位置、useMemo/useEffect 依赖数组与顺序与抽出前逐字一致。
 */
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import type { ChamberServerAggregate, InstanceRuntimeReport } from '@dsh-chamber/dsh-chamber-client-core'
import { createSessionFactsSource, type SessionFactsSnapshot, type SessionFactsSource } from '../session-facts-source.ts'
import { createSourceMuxFacts, isMuxObservableSourceKind, type SourceMuxFacts } from '../source-mux-facts.ts'
import { shouldDispatchRefreshHint } from '../source-refresh-hint.ts'

export interface SessionFactsLifecycleDeps {
  /** deriveServers 的当前投影（签名与收敛都从最新 servers 读）。 */
  servers: ChamberServerAggregate[]
  applySessionFacts: (sourceId: string, snapshot: SessionFactsSnapshot | undefined) => void
  recomputeSourceUnread: (sourceId: string) => void
  /** 未读落盘入口（focus/pagehide 两处监听读它，hook 只调用不拥有）。 */
  flushUnreadRef: { current: () => void }
  /** 聚合簇的「无法确认」标记（行刷新提示的 unverified 拒绝输入）。 */
  unverifiedSourcesRef: { current: readonly string[] }
  /** 每来源在途 unary 拉取计数（提示的 inFlight 拒绝输入）。 */
  factsPullInFlightRef: { current: Record<string, number> }
  /** 行刷新提示的 floor 记账（每来源）。 */
  refreshHintAtRef: { current: Record<string, number> }
  /** 聚合拉取的稳定入口（lifecycle 闭包只创建一次，取最新 refreshAggregate）。 */
  refreshAggregateRef: { current: (sourceId: string) => Promise<unknown> }
  /** 已挂载来源的运行时事实（focus 重算的键空间之一）。 */
  runtimeFactsRef: { current: Record<string, InstanceRuntimeReport | undefined> }
  sessionFactsRef: { current: Record<string, SessionFactsSnapshot | undefined> }
  /** 活跃事实源实例（gateway 来源；指纹变化 = 新化身重探）。 */
  sessionFactsSourcesRef: { current: Map<string, SessionFactsSource> }
  /** 每个实例的退订 + stop 合成器（来源退役/降级时调用一次）。 */
  sessionFactsTeardownRef: { current: Map<string, () => void> }
  /** 非 gateway 来源的无壳观察者退订与身份表。 */
  sourceMuxTeardownRef: { current: Map<string, () => void> }
  sourceMuxIdentityRef: { current: Map<string, string> }
  setSessionFacts: Dispatch<SetStateAction<Record<string, SessionFactsSnapshot | undefined>>>
}

/** 事实源生命周期装配；无对外返回值（调用面全在 App 的既有 ref/回调上）。 */
export function useSessionFactsLifecycle(deps: SessionFactsLifecycleDeps): void {
  const {
    servers, applySessionFacts, recomputeSourceUnread, flushUnreadRef,
    unverifiedSourcesRef, factsPullInFlightRef, refreshHintAtRef, refreshAggregateRef,
    runtimeFactsRef, sessionFactsRef, sessionFactsSourcesRef, sessionFactsTeardownRef,
    sourceMuxTeardownRef, sourceMuxIdentityRef, setSessionFacts,
  } = deps

  /** servers 的渲染期镜像（facts effect 闭包不随每次 servers 重建）。 */
  const serversRef = useRef(servers)
  serversRef.current = servers
  const sourceMuxObserversRef = useRef(new Map<string, SourceMuxFacts>())

  useEffect(() => {
    const reconcile = (): void => {
      for (const source of sessionFactsSourcesRef.current.values()) source.reconcile()
      for (const observer of sourceMuxObserversRef.current.values()) observer.reconcile()
    }
    window.addEventListener('dsh-chamber:sidecar-ready', reconcile)
    return () => window.removeEventListener('dsh-chamber:sidecar-ready', reconcile)
  }, [])

  /**
   * 行刷新提示：facts 的 session-added/removed/changed
   * ⇒ 该来源一次 unary 聚合拉取（行权威仍在聚合，不做第二行源）。四拒：
   * 未连接 / unverified / 在途 / 1s floor（source-refresh-hint.ts 纯判定）。
   */
  const requestFactsRefresh = useCallback((sourceId: string): void => {
    const server = serversRef.current.find(candidate => candidate.id === sourceId)
    const now = Date.now()
    if (!shouldDispatchRefreshHint({
      connected: server?.connected === true,
      unverified: unverifiedSourcesRef.current.includes(sourceId),
      inFlight: (factsPullInFlightRef.current[sourceId] ?? 0) > 0,
      lastHintAt: refreshHintAtRef.current[sourceId],
      now,
    })) return
    refreshHintAtRef.current[sourceId] = now
    void refreshAggregateRef.current(sourceId)
  }, [])

  /**
   * facts 生命周期的稳定签名：来源 id + 化身指纹 + connected。指纹变化 =
   * 新化身（重探、旧判定作废）；connected 边沿 = 重探 / 停流。
   */
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
      teardown()
      sessionFactsTeardownRef.current.delete(sourceId)
      sessionFactsSourcesRef.current.delete(sourceId)
      setSessionFacts(prev => {
        if (prev[sourceId] === undefined) return prev
        const next = { ...prev }
        delete next[sourceId]
        return next
      })
      delete sessionFactsRef.current[sourceId]
    }
    for (const [sourceId, input] of wanted) {
      let source = sessionFactsSourcesRef.current.get(sourceId)
      if (source === undefined) {
        const created = createSessionFactsSource({
          sourceId,
          onDiagnostic: (message, error) => console.warn(message, error ?? ''),
        })
        source = created
        const unsubscribeFacts = created.subscribe(snapshot => applySessionFacts(sourceId, snapshot))
        const unsubscribeHint = created.onRowHint(() => requestFactsRefresh(sourceId))
        sessionFactsSourcesRef.current.set(sourceId, created)
        sessionFactsTeardownRef.current.set(sourceId, () => {
          unsubscribeFacts()
          unsubscribeHint()
          created.stop()
        })
      }
      source.update(input)
    }
  }, [gatewayFactsSpec, applySessionFacts, requestFactsRefresh])

  /**
   * dsh 协议来源（远端 SSH **与本地托管 profile**）的**无壳观察者**。网关来源有只读
   * 镜像（/chamber/session-state），其它 dsh 来源没有——关壳期间没有任何事实通道，
   * 完成会丢。观察者讲实例自己的协议（经控制面既有无鉴权实例代理，本地为
   * /api/i/local/api/remote.mux），产出的快照与 gateway 事实源**同形**，因此直接喂
   * 同一条 applySessionFacts 管线（同一份事实、同一套未读判定），不需要第二条判定路径。
   * 覆盖规则单源于 isMuxObservableSourceKind：本地漏接曾让 local 会话既无内容证据、
   * 也无关壳完成通道。只观察：永不结算瀑布。
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
      const observer = createSourceMuxFacts({
        sourceId,
        origin: window.location.origin,
        onSnapshot: snapshot => applySessionFacts(sourceId, snapshot),
      })
      observer.start()
      sourceMuxObserversRef.current.set(sourceId, observer)
      // The mux observer registers NO content-stall evidence: source-level $events
      // silence is not this session's content progress (see session-content-stall.ts).
      sourceMuxTeardownRef.current.set(sourceId, () => {
        observer.stop()
        sourceMuxObserversRef.current.delete(sourceId)
      })
      sourceMuxIdentityRef.current.set(sourceId, fingerprint)
    }
  }, [sourceMuxSpec, applySessionFacts])

  // 焦点参与「正在阅读」谓词：focus/blur 只重算来源账本，
  // 不回退读标记（「已读」是单向的）。
  useEffect(() => {
    const onFocusChange = (): void => {
      const ids = new Set<string>([...sessionFactsSourcesRef.current.keys(), ...Object.keys(runtimeFactsRef.current)])
      for (const sourceId of ids) recomputeSourceUnread(sourceId)
    }
    window.addEventListener('focus', onFocusChange)
    window.addEventListener('blur', onFocusChange)
    return () => {
      window.removeEventListener('focus', onFocusChange)
      window.removeEventListener('blur', onFocusChange)
    }
  }, [recomputeSourceUnread])

  useEffect(() => {
    const flush = (): void => flushUnreadRef.current()
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      flushUnreadRef.current()
    }
  }, [])
}
