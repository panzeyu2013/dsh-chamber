/**
 * N-ctx 视图保留策略：把「无限常驻」收窄为——
 * - local 恒留；隐藏的非 local 壳至多 RETAINED_HIDDEN_VIEWS 个（LRU，最久未活跃者先回收）；
 * - 回收候选 = 已 settle（booted/error）且连续隐藏 ≥ VIEW_RECLAIM_GRACE_MS 的视图
 *   （隐藏计时从 settle 完成或切走起算，避免刚 boot 完的壳被立即拆掉）；
 * - 回收 = dispose shell + 卸载 UI 壳；实例进程/隧道/后台任务不受影响，重开走冷 boot。
 *
 * 本策略只管已 settle 的隐藏壳；从未 settle、收割账本、卡死与显式放弃的视图各由自己的臂接管。
 * 回收后数据面按既有语义降级：快照 producer 撤回，但 mounted marker 保留最后权威分组，
 * 30s unary watchdog 继续刷新会话行；运行中任务的蓝点/通知边沿暂停至该源重开，60s 安全窗限制损失面。
 */

/** 隐藏的非 local 壳保留上限（最近访问的 1 个）；内部实现参数，不进入公共导出面。 */
const RETAINED_HIDDEN_VIEWS = 1

/** 回收候选的连续隐藏安全窗：切走/ settle 后至少停留这么久才可回收。 */
export const VIEW_RECLAIM_GRACE_MS = 60_000

/** App 层回收检查的兜底周期（切换/ settle 变化会提前触发补查）。 */
export const VIEW_RECLAIM_TICK_MS = 20_000

export interface ReclaimDecisionInput {
  /** 当前挂载视图（数组序 = 挂载序；活动视图必在其中）。 */
  mountedViews: readonly string[]
  /** 已落地的活动视图 id（过渡在途时仍是旧视图——回收据此天然避开展示中的壳）。 */
  activeViewId: string
  /** 每视图"连续隐藏计时起点"（ms epoch；活动视图无键）。 */
  hiddenSince: Readonly<Record<string, number>>
  /** 已 settle（booted 或 error）的视图 id 集合；booting/未上报 = 未 settle。 */
  settled: ReadonlySet<string>
  /** 在途/顺延中的切换意图——绝不回收即将展示的视图。 */
  pendingViewId: string | null
  /** 在途预热的视图——不回收（避免取消一次即将完成的 boot）。 */
  prewarmInflightId: string | null
  /** 永不回收的本地实例 id。 */
  localId: string
  /** 自动预热来源的已 settle 视图 id（缺省 = 无）。同窗候选优先收自动预热壳——
   *  其 settle 的 hiddenSince 恒晚于用户切走时间，纯 hiddenSince 排序会先收用户温壳。 */
  prewarmOriginIds?: ReadonlySet<string>
  now: number
}

/**
 * 决定本次应回收的视图 id（0..n，幂等、确定性）。规则：
 * 1. 候选 = 挂载中、非 local/active/pending/prewarm-inflight、已 settle 且 hiddenSince ≥ grace（边界含等号）；
 * 2. 隐藏非 local 壳数超过上限才回收，一次只收到上限（不可回收的占位壳不计入本次回收量）；
 * 3. 同窗候选：自动预热来源优先，其内按 hiddenSince 升序（最久者先）。
 */
export function decideReclaimCandidates(input: ReclaimDecisionInput): string[] {
  const {
    mountedViews,
    activeViewId,
    hiddenSince,
    settled,
    pendingViewId,
    prewarmInflightId,
    localId,
    prewarmOriginIds,
    now,
  } = input
  // 在途预热/收割壳不计入隐藏壳数：它此刻通常尚未 settle，若计进 excess，
  // 收割窗口内候选只剩用户温壳，会被回收并抑制；该壳由收割自身或下一轮回收。
  const hiddenNonLocalCount = mountedViews.filter(
    id => id !== localId && id !== activeViewId && id !== prewarmInflightId,
  ).length
  const excess = hiddenNonLocalCount - RETAINED_HIDDEN_VIEWS
  if (excess <= 0) return []
  const reclaimable = mountedViews.filter(id => {
    if (id === localId || id === activeViewId) return false
    if (id === pendingViewId || id === prewarmInflightId) return false
    if (!settled.has(id)) return false
    const since = hiddenSince[id]
    return since !== undefined && now - since >= VIEW_RECLAIM_GRACE_MS
  })
  if (reclaimable.length === 0) return []
  reclaimable.sort((a, b) => {
    // 自动预热来源先收（其内最久者先）；无 origin 信息时退化为纯 hiddenSince 排序。
    const aPrewarm = prewarmOriginIds !== undefined && prewarmOriginIds.has(a) ? 0 : 1
    const bPrewarm = prewarmOriginIds !== undefined && prewarmOriginIds.has(b) ? 0 : 1
    if (aPrewarm !== bPrewarm) return aPrewarm - bPrewarm
    return (hiddenSince[a] ?? 0) - (hiddenSince[b] ?? 0)
  })
  return reclaimable.slice(0, Math.min(excess, reclaimable.length))
}

/**
 * 后台相位门控：文档隐藏（Electron 最小化/隐藏到托盘/后台标签）时不推进空闲预热 boot、
 * watchdog 拉取/reconnect、失败重试与保留回收；恢复可见由 App 的 visibilitychange 补偿一轮。
 * 不门控已回收源的 30s unary 兜底——兜底走 watchdog 周期，隐藏窗暂停、恢复补偿。
 */
export function shouldRunBackgroundPhase(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === 'visible'
}
