/**
 * 视图调度簇：预热资格 / 收割保温 / 保留候选回收 / 后台相位与 view-boot 放弃判定。
 * 判定与账本都在既有纯模块（baseline-harvest / retention / prewarm-ledger /
 * source-readiness）；本 hook 只做装配，并返回最新闭包 ref 给定时器与桥订阅使用。
 */
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import { withoutRemovedSourceIds, withoutRemovedSourceKeys } from '../aggregate-refresh.ts'
import type { ViewStore } from '../host/view-store.ts'
import {
  HARVEST_ABANDON_MS, harvestAbandoned, harvestAttemptStarted, harvestDeadlinePassed, harvestParked,
  harvestParkedRecord, harvestPending, harvestRetryDue, pickPrewarmTarget, prewarmCandidates,
  type HarvestRecord,
} from '../baseline-harvest.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { frameText, readDocumentLocale } from '../locales.ts'
import { recordPrewarm } from '../prewarm-ledger.ts'
import { VIEW_RECLAIM_GRACE_MS, decideReclaimCandidates, shouldRunBackgroundPhase } from '../retention.ts'
import { isDeferredReclaimDue } from '../source-readiness.ts'
import { disposeInstanceShell, isSettledShellState, type ShellState } from '../shell.ts'
import { instanceBasePath, instanceConnected, sourceIdForInstance } from '../transport-source.ts'
import { chamberBridge, intentPrewarmSpent, managedRuntimeUnusable, type IntentPrewarmBudget } from '@dsh-chamber/dsh-chamber-client-core'
import type { HealthResponse } from '../api.ts'
import type { MapLedgerView, SetLedgerView } from '@dsh-chamber/dsh-stream-state'
import type { SshInstanceSpec, SshStatusProjection } from '../global.d.ts'

export interface ViewSchedulerDeps {
  activeView: string
  health: HealthResponse | null
  liveServerIds: ReadonlySet<string>
  managedRuntime: Record<string, string | null>
  mountedViews: string[]
  remoteInstances: SshInstanceSpec[]
  remoteStatus: Record<string, SshStatusProjection>
  shellStates: Record<string, ShellState>
  setMountedViews: Dispatch<SetStateAction<string[]>>
  setRetryTokens: Dispatch<SetStateAction<Record<string, number>>>
  setShellStates: Dispatch<SetStateAction<Record<string, ShellState>>>
  abandonedViewsRef: { current: MapLedgerView }
  autoPrewarmedRef: { current: SetLedgerView }
  deferredBootRef: { current: ReadonlySet<string> }
  degradedRetriedRef: { current: Record<string, boolean> }
  harvestCandidatesRef: { current: Set<string> }
  harvestIntentRef: { current: Set<string> }
  harvestStateRef: { current: Record<string, HarvestRecord> }
  hiddenSinceRef: { current: Record<string, number> }
  intentBudgetRef: { current: IntentPrewarmBudget }
  intentPriorityRef: { current: Set<string> }
  localSettledRef: { current: boolean }
  viewStore: ViewStore
  pendingViewRef: { current: string | null }
  prewarmEligibleRef: { current: Set<string> }
  prewarmInflightRef: { current: string | null }
  prewarmQueueRef: { current: string[] }
  prewarmSuppressedRef: { current: SetLedgerView }
  reclaimViewRef: { current: (id: string, reason?: 'retention' | 'harvest') => void }
  settingsTargetRef: { current: string | undefined }
  viewBootStartedAtRef: { current: Record<string, number> }
  MAX_PREWARMED_REMOTE_VIEWS: number
}

export interface ViewScheduler {
  /** 渲染期镜像的预热资格集（提交推送 effect 读它）。 */
  prewarmEligible: ReadonlySet<string>
  /** 既有后台预热 drain（设置项/定时器 effect 直调）。 */
  drainPrewarm: () => void
  /** 单壳回收（保留/收割），JSX 与 effect 共用。 */
  reclaimView: (id: string, reason?: 'retention' | 'harvest') => void
  /** 周期回收扫描（定时器 effect 直调）。 */
  reclaimHiddenViews: () => void
  handleInstanceSettled: (instanceId: string) => void
  handleShellState: (instanceId: string, state: ShellState) => void
  /** 定时器驱动的最新闭包（reclaim 周期任务读它）。 */
  reclaimHiddenViewsRef: { current: () => void }
  /** 桥订阅（意图预热）与视图调度共享的最新 drain 闭包。 */
  drainPrewarmRef: { current: () => void }
}

export function useViewScheduler(deps: ViewSchedulerDeps): ViewScheduler {
  const {
    activeView, health, liveServerIds, managedRuntime, mountedViews,
    remoteInstances, remoteStatus, shellStates,
    setMountedViews, setRetryTokens, setShellStates,
    abandonedViewsRef, viewStore, autoPrewarmedRef, deferredBootRef, degradedRetriedRef,
    harvestCandidatesRef, harvestIntentRef, harvestStateRef, hiddenSinceRef, intentBudgetRef,
    intentPriorityRef, localSettledRef, pendingViewRef,
    prewarmEligibleRef, prewarmInflightRef, prewarmQueueRef,
    prewarmSuppressedRef, reclaimViewRef, settingsTargetRef, viewBootStartedAtRef,
    MAX_PREWARMED_REMOTE_VIEWS,
  } = deps

  const prewarmEligible = useMemo(() => {
    const liveRemoteIds = new Set(remoteInstances.map(sourceIdForInstance))
    for (const id of autoPrewarmedRef.current) {
      if (!liveRemoteIds.has(id)) autoPrewarmedRef.current.delete(id)
    }
    // 保留槽占用门：RETAINED_HIDDEN_VIEWS=1 被「非自动预热」的隐藏非 local 壳
    // 占用（含正在打开、尚未 settle 的用户壳）时不再启动投机预热——否则超限回收按
    // hiddenSince 排序会先回收用户的温壳、让从未预热过的壳占槽并被抑制（双倍保冷），
    // 违背 retention.ts「最近访问的 1 个」契约；用户点开时 selectView 摘除标记让位，
    // 同窗回收偏好见 decideReclaimCandidates 的 prewarmOriginIds 排序。
    const retentionSlotOccupied = mountedViews.some(id =>
      id !== LOCAL_INSTANCE_ID
      && id !== activeView
      // **从未 settle** 的被推迟视图不持有壳资源，不算占用后台槽（算占用会让
      // warmRemaining 恒 0）；已 settle 后被手动断开的壳仍是真壳，照常占槽与进候选。
      && !(deferredBootRef.current.has(id) && !isSettledShellState(shellStates[id]))
      && !autoPrewarmedRef.current.has(id)
      // 已失败的用户壳（error !== null）不算占用：否则 remaining 恒 0、收割链停摆。
      && shellStates[id]?.error == null)
    // 只统计仍挂载且未失败的预热壳：boot 失败的壳留在 ref 里且不会被回收，计进会让 warmRemaining 恒 0。
    const liveAutoPrewarmed = mountedViews.filter(id =>
      autoPrewarmedRef.current.has(id) && shellStates[id]?.error == null).length
    const warmRemaining = retentionSlotOccupied
      ? 0
      : Math.max(0, MAX_PREWARMED_REMOTE_VIEWS - liveAutoPrewarmed)
    const readyUnmountedIds = remoteInstances
      // `phase === 'ready'` 之外再过一道 instanceConnected：kind 切换后 remoteStatus 可能
      // 残留旧 READY 投影，否则会给其实未就绪的源白烧一次尝试。
      .filter(instance => remoteStatus[instance.id]?.phase === 'ready'
        && instanceConnected(instance.kind, health, remoteStatus, instance.id))
      // 托管 dsh 终态停机的 gateway 源不预热/不收割：boot 必然失败（网关 503），
      // 只会白烧尝试并占唯一后台槽；用户启动托管 dsh 后本门随 15s 探针自动放开。
      .filter(instance => !(instance.kind === 'gateway'
        && managedRuntimeUnusable(managedRuntime[sourceIdForInstance(instance)])))
      .map(sourceIdForInstance)
      .filter(id => !mountedViews.includes(id))
    // 收割优先：还没拿到权威基线的源排最前且**不受**"回收后禁预热"抑制——收割是
    // 这类源的治本臂；抑制只为防 drainPrewarm 立刻重 boot 已回收的温壳。
    const harvestIds = readyUnmountedIds
      .filter(id => harvestPending(harvestStateRef.current[id]))
    harvestCandidatesRef.current = new Set(harvestIds)
    // 保留策略：被回收过的源不自动预热（否则回收=白回收循环），抑制持续到用户
    // 点开或来源删除。另排除尝试耗尽且从未拿到基线的源（harvestParked）：它退回
    // 普通预热会白拿第三次 boot，并长期占用唯一后台槽，此后本会话再无源能预热或收割。
    const warmIds = readyUnmountedIds
      .filter(id => !prewarmSuppressedRef.current.has(id))
      .filter(id => !harvestParked(harvestStateRef.current[id]))
      .filter(id => !harvestIds.includes(id))
    // 收割候选在场时**独占**后台槽：若让温壳顶上，它变成 autoPrewarmed 后不会被
    // retention 回收 ⇒ remaining 恒 0、剩余来源永远拿不到基线。**收割有自己的预算线**：
    // 它瞬时，不能被用户温壳永久挡死，否则后变 ready 的来源永远停在兜底视图。
    const slotBudget = harvestIds.length > 0 ? MAX_PREWARMED_REMOTE_VIEWS : warmRemaining
    return new Set(prewarmCandidates(harvestIds, warmIds, slotBudget))
  }, [remoteInstances, remoteStatus, mountedViews, activeView, managedRuntime, shellStates])
  prewarmEligibleRef.current = prewarmEligible

  const drainPrewarm = useCallback(() => {
    if (prewarmInflightRef.current !== null) return
    if (!localSettledRef.current) return
    // 仅前台推进预热——隐藏期不为"用户没看"的源继续 boot 全量 UI（恢复可见补偿一轮）。
    if (!shouldRunBackgroundPhase(document.visibilityState)) return
    const now = Date.now()
    const pendingOf = (id: string): boolean => harvestPending(harvestStateRef.current[id])
    const dueOf = (id: string): boolean => harvestRetryDue(harvestStateRef.current[id], now)
    // 选取顺序：退避已满的收割候选优先，其次温壳；退避中的收割候选跳过而不挡后面。
    const next = pickPrewarmTarget(prewarmQueueRef.current, prewarmEligibleRef.current, pendingOf, dueOf)
    if (next === undefined) return
    // 这次选取来自 hover 意图 ⇒ 记一次意图 boot：重排不计费，计费只影响后续意图准入。
    if (intentPriorityRef.current.delete(next)) {
      intentBudgetRef.current = intentPrewarmSpent(intentBudgetRef.current, next, now)
    }
    prewarmQueueRef.current = prewarmQueueRef.current.filter(id => id !== next)
    // 这次挂载是否为收割挂载：未满足基线的源都是（提交推送/boot 失败/用户点开
    // 三条路径据此分流）。
    if (pendingOf(next)) {
      harvestIntentRef.current.add(next)
      harvestStateRef.current[next] = harvestAttemptStarted(harvestStateRef.current[next], now)
    }
    prewarmInflightRef.current = next
    autoPrewarmedRef.current.add(next)
    recordPrewarm('attempt', next)
    setMountedViews(prev => (prev.includes(next) ? prev : [...prev, next]))
  }, [])

  const handleInstanceSettled = useCallback((instanceId: string) => {
    delete viewBootStartedAtRef.current[instanceId]
    if (instanceId === LOCAL_INSTANCE_ID) localSettledRef.current = true
    if (prewarmInflightRef.current === instanceId) {
      prewarmInflightRef.current = null
    }
    // 保留策略：settle 完成才起 60s 回收窗（boot 耗时不被白付）；**屏上视图保持
    // 无键**——判据是 paintedView，不是 activeView，屏上那个壳绝不能开始隐藏计时。
    if (instanceId === viewStore.getSnapshot().painted) delete hiddenSinceRef.current[instanceId]
    else hiddenSinceRef.current[instanceId] = Date.now()
    // 无条件 drain：任何 settle 都可能是"在途预热完成"或"本地首次 settle"的触发器。
    drainPrewarm()
  }, [drainPrewarm])

  /** Shell 终态上报（InstanceView onStateChange）：失败覆盖层读取活动视图的 error。 */
  const handleShellState = useCallback((instanceId: string, state: ShellState) => {
    // settle/boot-failed 的 perf 标记由 shell.ts 统一打点；重新进入 booting/idle 即重新计时。
    if (!state.booted && state.error === null) viewBootStartedAtRef.current[instanceId] = Date.now()
    setShellStates(prev => (prev[instanceId] === state ? prev : { ...prev, [instanceId]: state }))
    // 收割挂载 boot 失败：立即释放该壳（失败壳占后台槽，也让来源停在兜底视图）；
    // 重试由退避期满后的 drain 承担。
    if (state.error !== null && harvestIntentRef.current.has(instanceId)) {
      harvestIntentRef.current.delete(instanceId)
      reclaimViewRef.current(instanceId, 'harvest')
    }
  }, [])

  // ---- N-ctx 保留策略（纯函数与语义见 src/retention.ts）----
  // 已 settle（booted 或 error）视图集合；booting/未上报 = 未 settle，不回收。
  const settledViewIds = useMemo(() => {
    const settled = new Set<string>()
    for (const [id, state] of Object.entries(shellStates)) {
      if (isSettledShellState(state)) settled.add(id)
    }
    return settled
  }, [shellStates])

  /** 把"永不 settle 的挂载"标记为失败：让失败覆盖层与重试出现。 */
  const markAbandonedShellFailed = useCallback((id: string) => {
    // 重新计时：否则用户点「重试」后挂载时刻仍是原值，同一轮清扫会立刻再判超时。
    viewBootStartedAtRef.current[id] = Date.now()
    setShellStates(prev => ({
      ...prev,
      [id]: {
        instanceId: id,
        basePath: instanceBasePath(id),
        booted: false,
        booting: false,
        error: frameText(readDocumentLocale(), 'fatal.harvestTimeout', {
          seconds: String(Math.round(HARVEST_ABANDON_MS / 1000)),
        }),
        // 超时是失败态，不是降级态：自愈重挂由失败覆盖层的「重试」负责。
        degraded: null,
      },
    }))
  }, [])

  /**
   * 回收一个超限隐藏壳（幂等）。来源仍在注册表与 liveServerIds 中：不碰数据面
   * 键空间（随 producer 通道撤回自行收敛）、不回退 active/pending 意图、不清在途
   * deep-link/通知交付。dispose 先于 React 卸载（同一提交内），实例进程/隧道/后台
   * 任务不受影响；重开 = selectView 冷 boot + entry 重放。
   * 壳内运行中任务的完成蓝点/通知边沿随 runtime-facts 撤回而暂停，直至该源重开——
   * 60s 安全窗 + RETAINED_HIDDEN_VIEWS=1 限制损失面。
   */
  const reclaimView = useCallback((id: string, reason: 'retention' | 'harvest' = 'retention') => {
    if (id === LOCAL_INSTANCE_ID || !mountedViews.includes(id)) return
    // **屏上的壳永不被回收**——持有窗内 painted 仍是旧视图而 active 已是目标，只查
    // active/pending 会拆掉用户正看的那一屏。守卫放这里覆盖所有调用臂。
    if (id === viewStore.getSnapshot().active || id === viewStore.getSnapshot().painted || id === pendingViewRef.current) return
    // 设置面板正在编辑的来源：拆壳 = 面板当前面消失。守卫放在**唯一拆除入口**上而
    // 不是逐个调用点——135s 放弃臂、收割失败/放弃与遮罩放弃臂都能到达本函数。
    // 命中即**纯 no-op**（连收割槽释放都不做）：保留位里的挂载仍计入占用，本就不起
    // 新的后台 boot；「推迟 + 未结算」另有 135s 放弃臂独立清 prewarmInflightRef，
    // 面板关闭后由下一臂照常恢复。
    if (id === settingsTargetRef.current) return
    // 收割回收时后台槽就是它自己：先释放槽位再回收，否则 prewarmInflight 守卫会挡回。
    if (reason === 'harvest' && prewarmInflightRef.current === id) {
      prewarmInflightRef.current = null
    }
    if (id === prewarmInflightRef.current) return
    harvestIntentRef.current.delete(id)
    autoPrewarmedRef.current.delete(id)
    // 保留策略：回收后禁止自动预热（否则 drainPrewarm 立刻重 boot，回收空转）；
    // 用户点开或注册表删除时清除。收割回收不写抑制键——那会把从未推送的降级源
    // 永久钉在兜底视图里，与收割目的相反。
    if (reason === 'retention') prewarmSuppressedRef.current.add(id)
    prewarmQueueRef.current = withoutRemovedSourceIds(prewarmQueueRef.current, new Set([id]))
    if (prewarmEligibleRef.current.has(id)) {
      const next = new Set(prewarmEligibleRef.current)
      next.delete(id)
      prewarmEligibleRef.current = next
    }
    disposeInstanceShell(id)
    // 诊断收敛：boot-graph 诊断通道没有 ctx 卸载撤回，回收（ctx 拆除而来源仍注册）
    // 必须显式清除，否则旧非 ok 诊断会挂到注册表删除，健康重开反而无上报。
    // 与注册表删除镜像：clearPluginDiagnostic 改变签名 → 重发布。
    chamberBridge.clearPluginDiagnostic(id)
    delete hiddenSinceRef.current[id]
    degradedRetriedRef.current[id] = false
    setMountedViews(prev => withoutRemovedSourceIds(prev, new Set([id])))
    setShellStates(prev => withoutRemovedSourceKeys(prev, new Set([id])))
    setRetryTokens(prev => withoutRemovedSourceKeys(prev, new Set([id])))
  }, [mountedViews])

  // 遮罩「切换来源」的落地臂：切换落地后回收被放弃的视图；reclaimView 自己的
  // 活动/待开守卫**不被绕过**——标记留到真正拆掉为止。
  useEffect(() => {
    if (abandonedViewsRef.current.size === 0) return
    for (const id of [...abandonedViewsRef.current.keys()]) {
      if (!mountedViews.includes(id)) { abandonedViewsRef.current.delete(id); continue }
      if (id === activeView || id === pendingViewRef.current) continue
      reclaimView(id, 'retention')
    }
  }, [activeView, mountedViews, reclaimView])

  useEffect(() => {
    if (abandonedViewsRef.current.size === 0) return
    for (const [from, to] of [...abandonedViewsRef.current]) {
      if (to === LOCAL_INSTANCE_ID || liveServerIds.has(to) || activeView === to) continue
      abandonedViewsRef.current.delete(from)
    }
  }, [liveServerIds, activeView])

  /** 保留策略检查：仅前台执行（隐藏期不拆壳）；同轮承担收割超时清扫（挂载后
   * HARVEST_DEADLINE_MS 内没有权威推送 = 本次尝试失败，释放后台槽）。 */
  const reclaimHiddenViews = useCallback(() => {
    if (!shouldRunBackgroundPhase(document.visibilityState)) return
    const now = Date.now()
    for (const id of [...harvestIntentRef.current]) {
      const record = harvestStateRef.current[id]
      if (record === undefined) continue
      if (harvestDeadlinePassed(record, now) && settledViewIds.has(id)) {
        // 只在壳已 settle 后按截止值判超时：boot 预算 60s 高于截止值，settle 前
        // 只可能是排队/在途 boot。
        harvestIntentRef.current.delete(id)
        reclaimView(id, 'harvest')
        continue
      }
      if (harvestAbandoned(record, now)) {
        // 绝对上限：壳**始终**不 settle 时截止臂不可达，后台槽被 prewarmInflight
        // 永久占住；此时回收并**停用**该源（attempts 打满 → harvestParked）。
        harvestIntentRef.current.delete(id)
        harvestStateRef.current[id] = harvestParkedRecord()
        reclaimView(id, 'harvest')
      }
    }
    // 绝对放弃臂：截止臂只扫 harvestIntentRef，而用户点开/普通温壳/深链挂载的壳都不在
    // 其中——按每个挂载视图的挂载时刻独立兜底，只判仍未 settle 的挂载，超上限后按身份分流。
    for (const id of mountedViews) {
      if (settledViewIds.has(id)) continue
      const startedAt = viewBootStartedAtRef.current[id]
      if (startedAt === undefined || now - startedAt < HARVEST_ABANDON_MS) continue
      const wasHarvest = harvestIntentRef.current.has(id)
      if (wasHarvest) {
        harvestIntentRef.current.delete(id)
        harvestStateRef.current[id] = harvestParkedRecord()
      }
      if (prewarmInflightRef.current === id) {
        prewarmInflightRef.current = null
      }
      if (id === viewStore.getSnapshot().active || id === pendingViewRef.current) {
        // 活动/待开视图不可回收：标记为失败让失败覆盖层 + 重试出现，否则用户
        // 永久停在 boot 蒙层上（无错误、无重试）。
        markAbandonedShellFailed(id)
      } else {
        // 隐藏视图：收割壳不写抑制键（它可能仍需重试），用户/温壳按保留策略回收。
        reclaimView(id, wasHarvest ? 'harvest' : 'retention')
      }
    }
    for (const id of mountedViews) {
      if (!isDeferredReclaimDue({
        deferred: deferredBootRef.current.has(id),
        settled: settledViewIds.has(id),
        busy: id === viewStore.getSnapshot().active || id === pendingViewRef.current,
        settingsTarget: id === settingsTargetRef.current,
        hiddenSinceMs: hiddenSinceRef.current[id],
        nowMs: now,
        graceMs: VIEW_RECLAIM_GRACE_MS,
      })) continue
      reclaimView(id, 'retention')
    }
    // **从未 settle** 的被推迟视图既不占隐藏壳数、也不由 retention 回收（推迟回收臂负责
    // 它）；不排除会让面板选离线来源把 excess 抬到 ≥1、挤掉真正的温壳。已 settle 的是真壳。
    const unsettledDeferredIds = new Set(
      [...deferredBootRef.current].filter(id => !settledViewIds.has(id)),
    )
    const retentionMountedViews = unsettledDeferredIds.size === 0
      ? mountedViews
      : mountedViews.filter(id => !unsettledDeferredIds.has(id))
    const candidates = decideReclaimCandidates({
      mountedViews: retentionMountedViews,
      // 保留判定按 **painted**（"谁在屏上"）——传 active 会把屏上旧视图算成隐藏壳。
      activeViewId: viewStore.getSnapshot().painted,
      hiddenSince: hiddenSinceRef.current,
      settled: settledViewIds,
      pendingViewId: pendingViewRef.current,
      prewarmInflightId: prewarmInflightRef.current,
      localId: LOCAL_INSTANCE_ID,
      // 快照（decide 即读）：自动预热来源先于用户来源被回收（retention.ts 规则 3
      // ——预热壳从未被用户请求，不允许挤掉用户温壳）。
      prewarmOriginIds: new Set(autoPrewarmedRef.current),
      now: Date.now(),
    })
    // 设置面板正在编辑的来源不可回收（拆壳 = 编辑面消失）；过滤而非改判定，
    // 面板关闭后该源重新成为普通保留候选。
    for (const id of candidates) {
      if (id === settingsTargetRef.current) continue
      reclaimView(id)
    }
  }, [mountedViews, reclaimView, settledViewIds])

  // 定时器/事件驱动的检查需要最新闭包：ref 镜像（同 pollAggregatesRef 纪律）。
  const reclaimHiddenViewsRef = useRef<() => void>(() => undefined)
  const drainPrewarmRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    reclaimHiddenViewsRef.current = reclaimHiddenViews
    drainPrewarmRef.current = drainPrewarm
    reclaimViewRef.current = reclaimView
  })
  return {
    prewarmEligible, drainPrewarm, reclaimView, reclaimHiddenViews,
    handleInstanceSettled, handleShellState, reclaimHiddenViewsRef, drainPrewarmRef,
  }
}
