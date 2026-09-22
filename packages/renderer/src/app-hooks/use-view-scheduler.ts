/**
 * 视图调度簇（）：预热资格 / 收割保温 /
 * 保留候选回收 / 后台相位与 view-boot 放弃判定。全部判定与账本仍是既有纯模块
 * （baseline-harvest / retention / prewarm-ledger / source-readiness）；本 hook
 * 只做装配，依赖面显式类型化（无 any），并返回两个最新闭包 ref 给 App 的
 * 定时器与桥订阅簇使用。
 */
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import { withoutRemovedSourceIds, withoutRemovedSourceKeys } from '../aggregate-refresh.ts'
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
import { chamberBridge, intentPrewarmSpent, managedRuntimeUnusable, type IntentPrewarmBudget } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import type { HealthResponse } from '../api.ts'
import type { MapLedgerView, SetLedgerView } from '@dsh-chamber/dsh-stream-state'
import type { SshInstanceSpec, SshStatusProjection } from '../global.d.ts'

export interface ViewSchedulerDeps {
  // values
  activeView: string
  health: HealthResponse | null
  liveServerIds: ReadonlySet<string>
  managedRuntime: Record<string, string | null>
  mountedViews: string[]
  remoteInstances: SshInstanceSpec[]
  remoteStatus: Record<string, SshStatusProjection>
  shellStates: Record<string, ShellState>
  // setters
  setMountedViews: Dispatch<SetStateAction<string[]>>
  setRetryTokens: Dispatch<SetStateAction<Record<string, number>>>
  setShellStates: Dispatch<SetStateAction<Record<string, ShellState>>>
  // refs
  abandonedViewsRef: { current: MapLedgerView }
  activeViewRef: { current: string }
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
  paintedViewRef: { current: string }
  pendingViewRef: { current: string | null }
  prewarmEligibleRef: { current: Set<string> }
  prewarmInflightAtRef: { current: number }
  prewarmInflightRef: { current: string | null }
  prewarmQueueRef: { current: string[] }
  prewarmSuppressedRef: { current: SetLedgerView }
  reclaimViewRef: { current: (id: string, reason?: 'retention' | 'harvest') => void }
  settingsTargetRef: { current: string | undefined }
  viewBootStartedAtRef: { current: Record<string, number> }
  // constants
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
    abandonedViewsRef, activeViewRef, autoPrewarmedRef, deferredBootRef, degradedRetriedRef,
    harvestCandidatesRef, harvestIntentRef, harvestStateRef, hiddenSinceRef, intentBudgetRef,
    intentPriorityRef, localSettledRef, paintedViewRef, pendingViewRef,
    prewarmEligibleRef, prewarmInflightAtRef, prewarmInflightRef, prewarmQueueRef,
    prewarmSuppressedRef, reclaimViewRef, settingsTargetRef, viewBootStartedAtRef,
    MAX_PREWARMED_REMOTE_VIEWS,
  } = deps

  const prewarmEligible = useMemo(() => {
    const liveRemoteIds = new Set(remoteInstances.map(sourceIdForInstance))
    for (const id of autoPrewarmedRef.current) {
      if (!liveRemoteIds.has(id)) autoPrewarmedRef.current.delete(id)
    }
    // 保留槽位占用门（2026 评审 Major-1 修复）：保留槽（RETAINED_HIDDEN_VIEWS
    // = 1）被「非自动预热」的隐藏非 local 壳占用（用户切走的温壳；含正在
    // 打开、尚未 settle 的用户壳——保守视为占用）时，不再启动投机预热。
    // 否则预热壳 settle 的 hiddenSince 恒晚于用户壳的切走时间，超限回收按
    // hiddenSince 排序会把用户的温壳先回收、从未请求的预热壳占据槽位，且
    // 被回收源进入预热抑制（reclaimView）——双倍保冷，违背 retention.ts
    // 头注「最近访问的 1 个」契约（触发形态：睡眠唤醒/实例增删等 idle 边
    // 缘 + 3+ 源；登记见 design 05  注记与 STATUS 性能第二阶段条）。
    // 用户主动点开时 selectView 同步摘除 autoPrewarmed 标记，此门随之为
    // 该壳让位；同窗候选内的回收偏好（预热壳先走）见 decideReclaimCandidates
    // 的 prewarmOriginIds 排序。
    const retentionSlotOccupied = mountedViews.some(id =>
      id !== LOCAL_INSTANCE_ID
      && id !== activeView
      // W2：**从未 settle** 的被推迟视图不持有任何壳资源，不算占用后台槽
      // （与下方"boot 失败的壳不计占用"同源：算占用会让 warmRemaining 恒 0）。
      // 已 settle 后来源才被手动断开的壳仍是一个真壳：照常占槽、照常进 retention
      // 候选（）。
      && !(deferredBootRef.current.has(id) && !isSettledShellState(shellStates[id]))
      && !autoPrewarmedRef.current.has(id)
      // 已失败的用户壳（error !== null）不算占用：它既不会被回收（隐藏 1 壳
      // 时 excess=0）也不是预热壳，若算占用则 remaining 恒 0、收割链整场停摆
      // （）。
      && shellStates[id]?.error == null)
    // 只统计"仍挂载且未失败"的预热壳：一个 boot 失败的预热壳会一直挂在
    // autoPrewarmedRef 里且不会被回收（无收割意图、excess=0），若计进占用则
    // warmRemaining 恒 0（）。
    const liveAutoPrewarmed = mountedViews.filter(id =>
      autoPrewarmedRef.current.has(id) && shellStates[id]?.error == null).length
    const warmRemaining = retentionSlotOccupied
      ? 0
      : Math.max(0, MAX_PREWARMED_REMOTE_VIEWS - liveAutoPrewarmed)
    const readyUnmountedIds = remoteInstances
      // `phase === 'ready'` 之外再过一道 instanceConnected：remoteStatus 以 raw id
      // 为键，kind 切换（ssh↔http）后可能残留旧 READY 投影，status.kind 不匹配时
      // instanceConnected 会拒绝——否则会给其实未就绪的源白烧一次尝试
      // （）。
      .filter(instance => remoteStatus[instance.id]?.phase === 'ready'
        && instanceConnected(instance.kind, health, remoteStatus, instance.id))
      // 托管 dsh 终态停机的 gateway 源不预热/不收割：壳 boot 必然失败（网关
      // 侧 503），只会白烧尝试次数并占用唯一后台槽（问题 B 的投影事实在此
      // 直接作为门控输入；用户启动托管 dsh 后本门随 15s 探针自动放开）。
      .filter(instance => !(instance.kind === 'gateway'
        && managedRuntimeUnusable(managedRuntime[sourceIdForInstance(instance)])))
      .map(sourceIdForInstance)
      .filter(id => !mountedViews.includes(id))
    // 收割优先（design 05  / baseline-harvest.ts）：还没拿到权威基线的源
    // 排在最前，且**不受**"回收后禁预热"抑制——收割正是这类源（从未推送、
    // 或曾降级后被回收）的治本臂；抑制只为防止 drainPrewarm 立刻重 boot 已
    // 回收的温壳，不能反过来把降级源永久钉在兜底视图里。
    const harvestIds = readyUnmountedIds
      .filter(id => harvestPending(harvestStateRef.current[id]))
    harvestCandidatesRef.current = new Set(harvestIds)
    // 保留策略：被回收过的源不再自动预热——否则回收(拆壳)会立即被
    // drainPrewarm 重新 boot(白回收循环)。抑制持续到用户主动点开
    // （selectView 清除）或来源从注册表删除（retireSources 清除）。
    // 另外排除"尝试耗尽且从未拿到基线"的源（harvestParked）：它若退回普通
    // 预热会白拿第三次 boot，并以 autoPrewarmed 身份长期占用唯一后台槽
    // （隐藏 1 壳时 retention 不会回收它）——此后本会话再没有任何源能预热
    // 或收割（）。
    const warmIds = readyUnmountedIds
      .filter(id => !prewarmSuppressedRef.current.has(id))
      .filter(id => !harvestParked(harvestStateRef.current[id]))
      .filter(id => !harvestIds.includes(id))
    // 收割候选在场时**独占**后台槽（prewarmCandidates）：若让温壳顶上来，它会
    // 变成 autoPrewarmed，而隐藏 1 壳时 retention 不会回收它 ⇒ remaining 恒 0、
    // 本会话剩余来源永远拿不到基线（一个失败源阻塞全部——违反正确性不变量；
    // ）。退避期空转槽位是有界代价，收割全部结束/停用后
    // 温壳预热照常恢复。
    // **收割有自己的预算线**：用户保留的隐藏温壳会让 warmRemaining 恒 0
    // （retention 只保 1 个隐藏壳），但收割壳是瞬时的（推送即回收 / 仅最后
    // 一个保留 / 有截止与放弃上限），不能被用户温壳永久挡死——否则用户点开过
    // 任何来源之后，后变 ready 的来源永远停在兜底视图（
    // 的第二形态）。
    const slotBudget = harvestIds.length > 0 ? MAX_PREWARMED_REMOTE_VIEWS : warmRemaining
    return new Set(prewarmCandidates(harvestIds, warmIds, slotBudget))
  }, [remoteInstances, remoteStatus, mountedViews, activeView, managedRuntime, shellStates])
  prewarmEligibleRef.current = prewarmEligible

  const drainPrewarm = useCallback(() => {
    if (prewarmInflightRef.current !== null) return
    if (!localSettledRef.current) return
    // 2026 性能整改：仅前台推进预热——窗口隐藏期不为"用户没看"的源继续
    // boot 全量 UI（恢复可见由 visibilitychange 补偿一轮 drain）。
    if (!shouldRunBackgroundPhase(document.visibilityState)) return
    const now = Date.now()
    const pendingOf = (id: string): boolean => harvestPending(harvestStateRef.current[id])
    const dueOf = (id: string): boolean => harvestRetryDue(harvestStateRef.current[id], now)
    // 选取顺序（baseline-harvest.pickPrewarmTarget）：退避已满的收割候选优先，
    // 其次温壳；退避中的收割候选被跳过而不是挡住它后面的温壳。
    const next = pickPrewarmTarget(prewarmQueueRef.current, prewarmEligibleRef.current, pendingOf, dueOf)
    if (next === undefined) return
    // R8：这次选取来自 hover 意图（队列重排）⇒ 记一次意图 boot。重排本身不
    // 计费；计费发生在"真的启动"这一刻（blueprint ），且只影响后续意图的
    // 准入，绝不回滚/干扰这次既有语义的挂载。
    if (intentPriorityRef.current.delete(next)) {
      intentBudgetRef.current = intentPrewarmSpent(intentBudgetRef.current, next, now)
    }
    prewarmQueueRef.current = prewarmQueueRef.current.filter(id => id !== next)
    // 这次挂载是否为收割挂载：未满足基线的源都是（提交推送/ boot 失败 /
    // 用户点开三条路径据此分流，见 onInstanceSnapshot / handleShellState /
    // selectView）。
    if (pendingOf(next)) {
      harvestIntentRef.current.add(next)
      harvestStateRef.current[next] = harvestAttemptStarted(harvestStateRef.current[next], now)
    }
    prewarmInflightRef.current = next
    prewarmInflightAtRef.current = now
    autoPrewarmedRef.current.add(next)
    // I8：一次后台挂载真的开始。
    recordPrewarm('attempt', next)
    setMountedViews(prev => (prev.includes(next) ? prev : [...prev, next]))
  }, [])

  const handleInstanceSettled = useCallback((instanceId: string) => {
    delete viewBootStartedAtRef.current[instanceId]
    if (instanceId === LOCAL_INSTANCE_ID) localSettledRef.current = true
    if (prewarmInflightRef.current === instanceId) {
      prewarmInflightRef.current = null
      prewarmInflightAtRef.current = 0
    }
    // 保留策略：settle 完成才起 60s 回收窗——隐藏视图（预热完成/切走后
    // settle）从此刻计"可回收时长"，boot 耗时不被白付；**屏上视图保持无键**
    // （W3：判据是 paintedView，不是 activeView——持有窗内"已选中但还没画上屏"
    // 的视图仍是隐藏的，给它起表不会误拆，但屏上那个壳绝不能开始隐藏计时）。
    if (instanceId === paintedViewRef.current) delete hiddenSinceRef.current[instanceId]
    else hiddenSinceRef.current[instanceId] = Date.now()
    // 无条件 drain：任何 settle 都可能是"在途预热完成"或"本地首次 settle"
    // 的触发器（后者在状态先于本地就绪时不会因依赖变化而触发队列推进）。
    drainPrewarm()
  }, [drainPrewarm])

  /** Shell 终态上报（InstanceView onStateChange）：失败覆盖层读取活动视图的 error。 */
  const handleShellState = useCallback((instanceId: string, state: ShellState) => {
    // 注：settle/boot-failed 的 perf 标记由 shell.ts 在 settle 返回点统一打点
    // （本回调只消费状态，避免同名双标记污染 trace）。
    // 重新进入 booting/idle（「重试」复位）即重新计时：否则在放弃后很久才重试的
    // 视图会立刻被同一轮清扫再判超时（）。
    if (!state.booted && state.error === null) viewBootStartedAtRef.current[instanceId] = Date.now()
    setShellStates(prev => (prev[instanceId] === state ? prev : { ...prev, [instanceId]: state }))
    // 收割挂载 boot 失败：本次尝试失败（尝试计数与退避已随 attempt 武装），
    // 立即释放该壳——失败壳占着后台槽，也让来源停在兜底视图；重试由退避
    // 期满后的 drain 承担（attempts 上限见 baseline-harvest.ts）。
    if (state.error !== null && harvestIntentRef.current.has(instanceId)) {
      harvestIntentRef.current.delete(instanceId)
      reclaimViewRef.current(instanceId, 'harvest')
    }
  }, [])

  // ---- N-ctx 保留策略（2026 性能整改，纯函数与语义见 src/retention.ts）----
  // 已 settle（booted 或 error）视图集合：booting/未上报 = 未 settle，不回收
  // （避免取消在途 boot 白付成本）。
  const settledViewIds = useMemo(() => {
    const settled = new Set<string>()
    for (const [id, state] of Object.entries(shellStates)) {
      if (isSettledShellState(state)) settled.add(id)
    }
    return settled
  }, [shellStates])

  /** 把"永不 settle 的挂载"标记为失败：让既有失败覆盖层与重试出现（该壳若是
   * 活动/待开视图则不可回收，见 reclaimHiddenViews 的绝对放弃臂）。 */
  const markAbandonedShellFailed = useCallback((id: string) => {
    // 重新计时（）：否则用户点「重试」后，挂载时刻仍是原值，
    // 同一轮清扫会立刻再次判超时——覆盖层原地复活、新 boot 永远看不到，切走还会
    // 把在途重试的壳按保留策略回收掉。
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
   * 回收一个超限隐藏壳（幂等）。与注册表删除分支（retireSources）的区别：
   * 来源仍在注册表与 liveServerIdsRef 中，因此这里不碰数据面键空间
   * （aggregates/runtimeFacts/通知记忆随 producer 通道撤回自行收敛）、不回退
   * active/pending 意图、不清 deep-link/通知在途交付。dispose 先于 React 卸载
   * （同一提交内），实例进程/隧道/后台任务不受影响；重开 = selectView 重新
   * 挂载 → 冷 boot + entry 重放（shell.ts 同 id 串行 barrier 既有）。
   * 数据面降级按既有语义自然发生：ctx 卸载触发快照 producer clear，App 的
   * onInstanceSnapshot withdrawal 分支对已推送源保留 mounted marker（最后权威
   * 分组/归档集留在侧栏），30s unary watchdog 以 mounted 合并持续刷新其会话行
   * 与 running 位（05 ）。已知取舍：壳内运行中任务的完成蓝点/通知边沿随
   * runtime-facts 通道撤回而暂停，直至该源重开（冷 boot 首报重新播种）——
   * 60s 安全窗 + RETAINED_HIDDEN_VIEWS=1 限制损失面，登记于 STATUS.md。
   */
  const reclaimView = useCallback((id: string, reason: 'retention' | 'harvest' = 'retention') => {
    if (id === LOCAL_INSTANCE_ID || !mountedViews.includes(id)) return
    // W3：**屏上的壳永不被回收**——持有窗内 painted 仍是旧视图而 active 已是目标，
    // 只查 active/pending 会把用户正在看的那一屏拆掉（蓝图 -1；这是本函数
    // 唯一的拆除入口，守卫放这里覆盖推迟/放弃/retention/收割所有调用臂）。
    if (id === activeViewRef.current || id === paintedViewRef.current || id === pendingViewRef.current) return
    // 设置面板正在编辑的来源：拆壳 = 面板当前面消失（design 05  的面板 hold）。
    // 守卫放在**唯一拆除入口**上而不是逐个调用点：推迟臂与 retention 循环各有同名
    // 守卫，但 135s 放弃臂、收割失败/放弃与遮罩放弃落地臂都能到达本函数——任何一条
    // 漏守卫都会把面板钉死在"正在启动该实例的前端"（）。
    // 面板关闭时 SettingsShell 显式 setSettingsTarget(undefined)，hold 不超期；
    // 来源退役的卸载走注册表删除臂（不经本函数），不存在"退役壳拆不掉"。
    // 守卫放在函数最前 = 命中即**纯 no-op**（连收割槽释放都不做）：不会造成
    // 预热调度停滞——保留位里的挂载仍计入占用（`warmRemaining` 为 0，本就不起新的
    // 后台 boot）；而"推迟 + 未结算"这种**不计入占用**的形状另有收口：135s 放弃臂
    // 独立清 `prewarmInflightRef`（abandon 循环不读面板守卫），面板关闭后下一个 tick
    // 由放弃/收割/推迟任一臂照常恢复。
    // 解释所有形状，对 deferred+未结算不成立（结论不变，理由曾错）。
    if (id === settingsTargetRef.current) return
    // 收割回收时后台槽就是它自己：boot 已产出首个推送（或已失败），先释放槽位
    // 再回收，否则 prewarmInflight 守卫会把自己挡回去（保留回收语义不变）。
    if (reason === 'harvest' && prewarmInflightRef.current === id) {
      prewarmInflightRef.current = null
      prewarmInflightAtRef.current = 0
    }
    if (id === prewarmInflightRef.current) return
    harvestIntentRef.current.delete(id)
    autoPrewarmedRef.current.delete(id)
    // 保留策略：回收后禁止自动预热（否则 drainPrewarm 立刻重新 boot 它，
    // 回收空转）；用户主动点开（selectView）或注册表删除（retireSources）时清除。
    // 收割回收不写抑制键：它回收的是"已经拿到基线（或按上限放弃）"的源，
    // 抑制键会把从未推送的降级源永久钉在兜底视图里，与收割目的相反。
    if (reason === 'retention') prewarmSuppressedRef.current.add(id)
    prewarmQueueRef.current = withoutRemovedSourceIds(prewarmQueueRef.current, new Set([id]))
    if (prewarmEligibleRef.current.has(id)) {
      const next = new Set(prewarmEligibleRef.current)
      next.delete(id)
      prewarmEligibleRef.current = next
    }
    disposeInstanceShell(id)
    // 诊断收敛（2026 评审 Minor-2 修复）：boot-graph 诊断通道没有 ctx 卸载
    // 撤回——注册表删除路径之外的唯一清除点是显式 undefined 上报与退役。
    // 回收是新的生命周期类别（ctx 拆除而来源仍注册），不清除会让被拆 ctx
    // 的旧非 ok 诊断（bundle-load-failed / restart-required）挂在源上直到
    // 注册表删除，健康重开反而无上报（shell.ts 只在 graph 失败时上报）。
    // 与注册表删除镜像：clearPluginDiagnostic 改变签名 → 重发布，settings
    // 的 connections 插件面随之更新。聚合/runtimeFacts/通知记忆仍按
    // reclaimView 头注随 producer 通道撤回自行收敛。
    chamberBridge.clearPluginDiagnostic(id)
    delete hiddenSinceRef.current[id]
    degradedRetriedRef.current[id] = false
    setMountedViews(prev => withoutRemovedSourceIds(prev, new Set([id])))
    setShellStates(prev => withoutRemovedSourceKeys(prev, new Set([id])))
    setRetryTokens(prev => withoutRemovedSourceKeys(prev, new Set([id])))
  }, [mountedViews])

  // 遮罩「切换来源」的落地臂（W1）：切换落地（activeView 变化）后回收被放弃的
  // 视图。reclaimView 自己的活动/待开守卫**不被绕过**——标记留到真正拆掉为止；
  // 拆除与 reclaimView 同一条路：dispose + 同 commit 卸载 + 抑制自动预热。
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

  /** 保留策略检查：仅前台执行（窗口隐藏期不拆壳；恢复可见由
   * visibilitychange 补偿一轮）。守卫与上限见 decideReclaimCandidates。
   * 同轮承担收割超时清扫：挂载后 HARVEST_DEADLINE_MS 内没有权威推送 = 本次
   * 尝试失败，释放后台槽（尝试上限与退避已随 attempt 武装）。 */
  const reclaimHiddenViews = useCallback(() => {
    if (!shouldRunBackgroundPhase(document.visibilityState)) return
    const now = Date.now()
    for (const id of [...harvestIntentRef.current]) {
      const record = harvestStateRef.current[id]
      if (record === undefined) continue
      if (harvestDeadlinePassed(record, now) && settledViewIds.has(id)) {
        // 只在壳已 settle 后按截止值判超时：boot 预算 60s（shell.ts
        // BOOT_TIMEOUT_MS），截止值高于它——settle 前只可能是排队/在途 boot。
        harvestIntentRef.current.delete(id)
        reclaimView(id, 'harvest')
        continue
      }
      if (harvestAbandoned(record, now)) {
        // 绝对上限：壳**始终**不 settle（挂死的 loader/fetch）时截止臂永远
        // 不可达，而后台槽被 prewarmInflight 永久占住。此时回收并**停用**
        // 该源（attempts 打满 → harvestParked），否则重试会撞进同一个挂死。
        harvestIntentRef.current.delete(id)
        harvestStateRef.current[id] = harvestParkedRecord()
        reclaimView(id, 'harvest')
      }
    }
    // 绝对放弃臂（）：上面的截止臂只扫 harvestIntentRef，而
    // "用户点开正在收割的壳"会撤销意图、普通温壳预热从不写意图、selectView/深链
    // 挂载的壳更与预热无关——boot 挂死时后台槽/该视图就永久卡住。这里按**每个挂载
    // 视图的挂载时刻**独立兜底：只判仍未 settle 的挂载（已 settle 的走上方的截止
    // 臂），超上限后按身份分流。
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
        prewarmInflightAtRef.current = 0
      }
      if (id === activeViewRef.current || id === pendingViewRef.current) {
        // 活动/待开视图不可回收（reclaimView 会拒绝）。若不标记，用户会永久停在
        // boot 蒙层上（无错误、无重试）——标记为失败让既有失败覆盖层 + 重试出现。
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
        busy: id === activeViewRef.current || id === pendingViewRef.current,
        settingsTarget: id === settingsTargetRef.current,
        hiddenSinceMs: hiddenSinceRef.current[id],
        nowMs: now,
        graceMs: VIEW_RECLAIM_GRACE_MS,
      })) continue
      reclaimView(id, 'retention')
    }
    // W2（F1 复核）：**从未 settle** 的被推迟视图既不占隐藏壳数、也不由 retention
    // 回收——它没有壳可拆（推迟回收臂按隐藏宽限负责它）。不排除会让一次"设置面板选了
    // 离线来源"把 excess 抬到 ≥1，从而把用户真正的温壳挤掉（与 prewarmInflightId 的
    // 同类排除同源）。已 settle 的推迟壳是**真壳**：它照常计数、照常进候选窗。
    const unsettledDeferredIds = new Set(
      [...deferredBootRef.current].filter(id => !settledViewIds.has(id)),
    )
    const retentionMountedViews = unsettledDeferredIds.size === 0
      ? mountedViews
      : mountedViews.filter(id => !unsettledDeferredIds.has(id))
    const candidates = decideReclaimCandidates({
      mountedViews: retentionMountedViews,
      // W3：保留判定按 **painted**（"谁在屏上"）——持有窗内 active 已是目标，传它会把
      // 屏上的旧视图算成隐藏壳、并让 hiddenNonLocalCount 少算一个（蓝图 -2）。
      activeViewId: paintedViewRef.current,
      hiddenSince: hiddenSinceRef.current,
      settled: settledViewIds,
      pendingViewId: pendingViewRef.current,
      prewarmInflightId: prewarmInflightRef.current,
      localId: LOCAL_INSTANCE_ID,
      // 快照（decide 即读）：自动预热来源在候选排序中先于用户来源被回收
      // （retention.ts 规则 3——预热壳从未被用户请求，straddle 形态下不
      // 允许它挤掉用户温壳）。
      prewarmOriginIds: new Set(autoPrewarmedRef.current),
      now: Date.now(),
    })
    // 设置面板正在编辑的来源不可回收（design 05 ，）：
    // 面板渲染的是该来源自己 boot ctx 的台账，拆掉壳 = 正在编辑的设置面消失。
    // 过滤而非改判定：面板关闭后该源重新成为普通保留候选。
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
