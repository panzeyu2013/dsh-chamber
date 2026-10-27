/**
 * View selection commands: click-to-reconnect (tunnel), ready-state reverify, the
 * three-part retry, the delayed-reveal selector, the veil switch (abandon intent)
 * and the veil connect.
 *
 * Extracted verbatim from App.tsx; every dependency is an explicit input (the two
 * stores, the ledger views, the pending slot and the four helpers), so the callback
 * identities and their dependency arrays are unchanged.
 */
import { useCallback } from 'react'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { rawInstanceIdFromSourceId } from '../transport-source.ts'
import { PERF_MARKS, perfMark } from '../perf-marks.ts'
import type { recordPrewarm } from '../prewarm-ledger.ts'
import type { harvestSatisfied } from '../baseline-harvest.ts'
import type { captureSidebarScrollAnchor } from '../sidebar-scroll-sync.ts'
import type { createRemotesStore } from '../host/remotes-store.ts'
import type { createViewStore } from '../host/view-store.ts'
import type { useAbandonedViewsView, useAutoPrewarmedView, useHarvestStateView, usePrewarmSuppressedView } from './use-source-ledger-views.ts'

export interface ViewSelectionInputs {
  remotesStore: ReturnType<typeof createRemotesStore>
  viewStore: ReturnType<typeof createViewStore>
  liveServerIdsRef: { current: Set<string> }
  abandonedViewsRef: ReturnType<typeof useAbandonedViewsView>
  autoPrewarmedRef: ReturnType<typeof useAutoPrewarmedView>
  prewarmSuppressedRef: ReturnType<typeof usePrewarmSuppressedView>
  harvestStateRef: ReturnType<typeof useHarvestStateView>
  harvestIntentRef: { current: Set<string> }
  pendingViewRef: { current: string | null }
  setMountedViews: (update: (previous: string[]) => string[]) => void
  setRetryTokens: (update: (previous: Record<string, number>) => Record<string, number>) => void
  recordPrewarm: (event: Parameters<typeof recordPrewarm>[0], sourceId: string) => void
  harvestSatisfied: (record: Parameters<typeof harvestSatisfied>[0]) => ReturnType<typeof harvestSatisfied>
  captureSidebarScrollAnchor: (instanceId: string) => ReturnType<typeof captureSidebarScrollAnchor>
  restoreSidebarScroll: (instanceId: string, anchor: NonNullable<ReturnType<typeof captureSidebarScrollAnchor>>) => void
}

export function useViewSelection(inputs: ViewSelectionInputs) {
  const {
    remotesStore, viewStore, liveServerIdsRef, abandonedViewsRef, autoPrewarmedRef,
    prewarmSuppressedRef, harvestStateRef, harvestIntentRef, pendingViewRef, setMountedViews, setRetryTokens,
    recordPrewarm, harvestSatisfied, captureSidebarScrollAnchor, restoreSidebarScroll,
  } = inputs

  const ensureRemoteConnected = useCallback((viewId: string) => {
    if (viewId === LOCAL_INSTANCE_ID) return
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const rawId = rawInstanceIdFromSourceId(viewId)
    if (rawId === null) return
    const phase = remotesStore.getSnapshot().status[rawId]?.phase
    if (phase !== 'error' && phase !== 'degraded') return
    void ssh.connect(rawId).catch(err => {
      console.error(`[renderer] click-to-reconnect ${rawId} failed:`, err)
    })
  }, [])

  /**
   * 用户意图即时再验证（ready-state heartbeat 的即时加速）：与 ensureRemoteConnected 互补——非 ready 的
   * error/degraded 走隧道重连，**ready 但会话/远端已死**（transport 相位不变）由主进程 reverify 立即探测
   * 一次：终端失败相位翻 error，瞬态失败走有界重连。fire-and-forget：权威状态以相位推送为准；reverify
   * 对非 ready/静默窗内的调用是主进程侧 no-op。
   */
  const probeRemoteReady = useCallback((viewId: string) => {
    if (viewId === LOCAL_INSTANCE_ID) return
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined || ssh.reverify === undefined) return
    const rawId = rawInstanceIdFromSourceId(viewId)
    if (rawId === null) return
    void ssh.reverify(rawId).catch(() => {
      // 探测失败保持现状：权威状态仍由 onStatusChanged 推送/轮询兜底；但失败本身值得留痕（IPC/主进程侧异常）。
      console.warn(`[renderer] ready-state reverify ${rawId} failed`)
    })
  }, [])

  /**
   * 重试一个视图：唯一入口，失败覆盖层与降级提示共用同一套三段式——重挂该视图 + error/degraded
   * 隧道立即再试 + ready 但会话/远端已死的来源立即探测一次（漏掉最后一条会让重试原地失败）。
   * 令牌递增驱动 InstanceView 复位重 boot；来源非 ready 时前两段是 no-op。
   */
  const retryView = useCallback((viewId: string) => {
    probeRemoteReady(viewId)
    ensureRemoteConnected(viewId)
    setRetryTokens(prev => ({ ...prev, [viewId]: (prev[viewId] ?? 0) + 1 }))
  }, [ensureRemoteConnected, probeRemoteReady])

  /** 视图切换（延迟揭示）：**只改选择，不改可见性**。本函数提交 activeView + mountedViews；屏上仍是
   * paintedView 那个视图，直到揭示 effect 判定"目标首帧可用"才经既有 'view' 过渡键收敛。不在这里包 VT：
   * VT 的"新状态渲染就绪后动画才开始"做不到"boot 期保持旧视图"，于是点击后屏上没有任何变化，也就不存在
   * "旧视图输入栏 × 新遮罩"的混色窗口（cut 判据只在揭示节上）。prefers-reduced-motion 仍由
   * view-transition.ts 直通模式接管（揭示即时落地，持有窗不变——持有是内容决策，不是动效）。注册表守卫
   * （视图生命周期 = 注册表条目生命周期）：来源已被删除时不挂载/不切换（点击时与提交时各查一次）。local 常驻。 */
  const selectView = useCallback((viewId: string, onApply?: (applied: boolean) => void): boolean => {
    // 用户又选中这个视图 = 撤回"放弃"意图（否则它下一次离开会跳过保留宽限被立即回收）；切换来源的动作写在**另一个** id 上，不会被误删。
    abandonedViewsRef.current.delete(viewId)
    // 用户点击 = 意图使用该来源：ready 但会话/远端已死的来源立即探测一次（heartbeat 即时加速）。
    probeRemoteReady(viewId)
    // 用户点击 = 意图使用该来源：error/degraded 隧道立即再试（idle 手动断开不触碰，见 ensureRemoteConnected）。
    ensureRemoteConnected(viewId)
    if (viewId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(viewId)) return false
    // 此刻它仍在自动预热集合里 ⇒ 这次用户选中就是一次**命中**（删除之前判定）。
    if (autoPrewarmedRef.current.has(viewId)) recordPrewarm('hit', viewId)
    autoPrewarmedRef.current.delete(viewId)
    // 用户主动点开 = 意图使用：解除"回收后不自动预热"抑制（此后闲置仍会被再次回收并再次抑制）。
    prewarmSuppressedRef.current.delete(viewId)
    // 收割中被点开 = 采用为用户视图：撤销收割意图（绝不回收用户正在看的壳），
    if (harvestIntentRef.current.delete(viewId)) {
      harvestStateRef.current[viewId] = harvestSatisfied(harvestStateRef.current[viewId])
    }
    // 查重（非闭包镜像）：同一次提交内重复登记直接跳过；已选中视图只在**没有在途揭示**时跳过
    // （"在途"由 painted != selected 表达）。pendingViewRef 只是这段同步提交里的意图槽。
    if (viewId === pendingViewRef.current) return true
    if (pendingViewRef.current === null && viewId === viewStore.getSnapshot().active) return true
    // Anchor the outgoing shell's sidebar scroll BEFORE the switch, or the incoming shell's stale
    // scrollTop makes the whole sidebar jump (each N-ctx shell owns its own .chamberList scrollTop).
    // restoreSidebarScroll runs inside the apply: its PARK phase synchronously copies the raw scroll
    // before the transition's new-state snapshot, and the row-anchored REFINE corrects sub-row deltas
    // once the shell is visible (booting / rail-collapsed shells are covered by the retry chain).
    const scrollAnchor = captureSidebarScrollAnchor(viewStore.getSnapshot().active)
    pendingViewRef.current = viewId
    // perf 仪器：switchFrameMs = view-request → view-reveal 两条 mark 之差（纯观测，无业务语义）。
    perfMark(PERF_MARKS.appViewRequest, viewId)
    // 同步提交（不包 VT——头注）。提交与登记同拍（无异步间隙）：pendingViewRef
    // 只是本次同步提交的意图槽，rapid click 由下一次 selectView 覆盖。
    pendingViewRef.current = null
    viewStore.select(viewId)
    // 保留策略：被回收（不在 mountedViews）的 live 来源在此重新挂载——冷 boot + entry 重放
    // （shell.ts 同 id 串行 barrier 保证与回收的异步 teardown 不交错）；hiddenSince 由 painted 落地 effect 清除。
    setMountedViews(prev => (prev.includes(viewId) ? prev : [...prev, viewId]))
    if (scrollAnchor !== null) restoreSidebarScroll(viewId, scrollAnchor)
    onApply?.(true)
    return true
  }, [ensureRemoteConnected, probeRemoteReady])

  /**
   * 遮罩「切换来源」的放弃意图：记下意图后切到目标来源，**等切换落地**再由下方 effect 回收被放弃的
   * 视图。不就地回收：reclaimView 拒绝活动/待开视图，而 selectView 的 apply 经 View Transition 单槽
   * 队列可能延迟，"先拆再切"会在切换失败时留下没有内容的窗口。标记只由这个显式用户动作写入；目标不合法
   * 或同步抛出时立即撤回。
   */
  const switchSourceFromVeil = useCallback((fromViewId: string, targetId: string) => {
    if (fromViewId === targetId) return
    if (targetId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(targetId)) return
    if (fromViewId !== LOCAL_INSTANCE_ID) abandonedViewsRef.current.set(fromViewId, targetId)
    // selectView 的"没落地"**不抛异常**（注册表竞态早退、apply 期目标被删除都只是 return），
    // 所以用"落地即回调"的返回值收口：只有切换真的落地，放弃标记才保留，否则撤回（否则该视图
    // 下一次离开会跳过 60s 保留宽限被立刻拆掉）。
    const revoke = (): void => { abandonedViewsRef.current.delete(fromViewId) }
    try {
      const accepted = selectView(targetId, applied => { if (!applied) revoke() })
      if (!accepted) revoke()
    } catch (error) {
      revoke()
      console.error(`[renderer] veil switch ${fromViewId} -> ${targetId} failed:`, error)
    }
  }, [selectView])

  /**
   * 遮罩「连接」：显式用户意图，与设置页 Connect 同语义。「手动断开不被自动触碰」正是靠"只有
   * 显式动作才连接"守恒，因此这里不像 ensureRemoteConnected 那样按相位过滤。
   */
  const connectSourceFromVeil = useCallback((viewId: string) => {
    const ssh = window.dshChamber?.desktopSsh
    const rawId = rawInstanceIdFromSourceId(viewId)
    if (ssh === undefined || rawId === null) return
    void ssh.connect(rawId).catch(err => {
      console.error(`[renderer] veil connect ${rawId} failed:`, err)
    })
  }, [])
  return { ensureRemoteConnected, probeRemoteReady, retryView, selectView, switchSourceFromVeil, connectSourceFromVeil }
}
