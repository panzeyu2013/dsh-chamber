/**
 * 事实源生命周期簇：gateway 只读事实源与 SSH/dsh 远端无壳观察者的创建/收敛/退订，
 * 外加 focus/blur 重算未读与 pagehide/hidden 落盘 flush 两条全局监听。
 * 稳定签名（id + 化身指纹 + connected）决定重探/停流；判定与状态仍在既有纯模块与 App
 * 的 ref/state 容器里，本 hook 只做订阅生命周期装配。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core'
import type { FactsStore } from '../host/facts-store.ts'
import { createSessionFactsSource, type SessionFactsSnapshot, type SessionFactsSource } from '../session-facts-source.ts'
import { createSourceMuxFacts } from '../source-mux-facts.ts'
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
  factsStore: FactsStore
  /** 活跃事实源实例（gateway 来源；指纹变化 = 新化身重探）。 */
  sessionFactsSourcesRef: { current: Map<string, SessionFactsSource> }
  /** 每个实例的退订 + stop 合成器（来源退役/降级时调用一次）。 */
  sessionFactsTeardownRef: { current: Map<string, () => void> }
  /** 非 gateway 来源的无壳观察者退订与身份表。 */
  sourceMuxTeardownRef: { current: Map<string, () => void> }
  sourceMuxIdentityRef: { current: Map<string, string> }
}

/** 事实源生命周期装配；无对外返回值（调用面全在 App 的既有 ref/回调上）。 */
export function useSessionFactsLifecycle(deps: SessionFactsLifecycleDeps): void {
  const {
    servers, applySessionFacts, recomputeSourceUnread, flushUnreadRef,
    unverifiedSourcesRef, factsPullInFlightRef, refreshHintAtRef, refreshAggregateRef,
    factsStore, sessionFactsSourcesRef, sessionFactsTeardownRef,
    sourceMuxTeardownRef, sourceMuxIdentityRef,
  } = deps

  /** servers 的渲染期镜像（facts effect 闭包不随每次 servers 重建）。 */
  const serversRef = useRef(servers)
  serversRef.current = servers

  /**
   * 行刷新提示：facts 的 session-added/removed/changed ⇒ 该来源一次 unary 聚合拉取
   * （行权威仍在聚合，不做第二行源）。四拒：未连接 / unverified / 在途 / 1s floor。
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
      teardown()
      sessionFactsTeardownRef.current.delete(sourceId)
      sessionFactsSourcesRef.current.delete(sourceId)
      factsStore.dropSession(sourceId)
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
   * SSH / 其它 dsh 远端来源的**无壳观察者**：这些来源没有只读镜像，关壳期间没有事实
   * 通道，完成会丢。观察者讲实例自己的远程协议，产出的快照与 gateway 事实源**同形**，
   * 直接喂同一条 applySessionFacts 管线（同一份事实、同一套未读判定）；只观察，永不结算瀑布。
   */
  const sourceMuxSpec = useMemo(
    () => servers
      .filter(server => server.kind === 'dsh')
      .map(server => server.id + ':' + server.sourceFingerprint + ':' + (server.connected ? '1' : '0'))
      .join('|'),
    [servers],
  )
  useEffect(() => {
    const wanted = new Map<string, string>()
    for (const server of serversRef.current) {
      if (server.kind !== 'dsh' || server.connected !== true) continue
      wanted.set(server.id, server.sourceFingerprint)
    }
    for (const [sourceId, teardown] of [...sourceMuxTeardownRef.current]) {
      // 身份变了（同 id 新指纹）也必须拆：旧观察者的 rows/runningBefore 属于旧化身。
      if (wanted.get(sourceId) === sourceMuxIdentityRef.current.get(sourceId)) continue
      teardown()
      sourceMuxTeardownRef.current.delete(sourceId)
      sourceMuxIdentityRef.current.delete(sourceId)
    }
    for (const [sourceId, fingerprint] of wanted) {
      if (sourceMuxTeardownRef.current.has(sourceId)) continue
      const observer = createSourceMuxFacts({
        sourceId,
        origin: window.location.origin,
        onSnapshot: snapshot => applySessionFacts(sourceId, snapshot),
      })
      observer.start()
      sourceMuxTeardownRef.current.set(sourceId, () => observer.stop())
      sourceMuxIdentityRef.current.set(sourceId, fingerprint)
    }
  }, [sourceMuxSpec, applySessionFacts])

  // 焦点参与「正在阅读」谓词：focus/blur 只重算账本，不回退读标记（已读单向）。
  useEffect(() => {
    const onFocusChange = (): void => {
      const ids = new Set<string>([...sessionFactsSourcesRef.current.keys(), ...Object.keys(factsStore.getSnapshot().runtime)])
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
