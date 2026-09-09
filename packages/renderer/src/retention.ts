/**
 * N-ctx 视图保留策略（chamber 2026 性能整改，对 design 05 §1/§4 的有意偏差）。
 *
 * 背景：每个挂载实例壳承载一份完整官方 dsh UI（独立 cordis ctx、全量 ui-*
 * 树、约 4-5k DOM 节点、全量 store 订阅/React commit），且 boot 后常驻、
 * 切换纯 CSS hide/show。多壳叠加使 DOM/堆/主线程随壳数线性增长。chamber
 * 可控制的一层是"壳的挂载编排"：把"无限常驻"收窄为保留策略——
 *
 * - local 恒留（永不回收）；
 * - 隐藏的非 local 壳最多保留 RETAINED_HIDDEN_VIEWS 个（LRU：最久未
 *   活跃者先回收）；
 * - 回收候选 = 已 settle（booted 或 error）且连续隐藏 ≥ VIEW_RECLAIM_GRACE_MS
 *   的视图——隐藏计时从"settle 完成"或"切走"起算（App 层维护），避免
 *   一个刚 boot 完的壳被立即拆掉（boot 成本白付）；
 * - 回收 = dispose shell + 卸载 UI 壳（App 层动作）；实例进程/隧道/后台
 *   任务不受影响，重开走冷 boot + entry 重放（既有 InstanceView 路径）。
 *
 * 回收后该源的数据面按既有语义自然降级：ctx 卸载触发快照 producer 撤回，
 * App 的 onInstanceSnapshot withdrawal 分支对已推送源保留 mounted marker
 * （保留最后权威分组/归档集），30s unary watchdog 以 mounted 合并持续
 * 刷新其会话行与 running 位（05 §2.3）——侧栏仍可见该源的最新会话。
 * 已知取舍（登记在 App.tsx 回收点与 STATUS）：被回收壳内运行中任务的
 * 完成蓝点/通知边沿随 runtime-facts 通道撤回而暂停，直至该源重开
 * （冷 boot 首报重新播种）；60s 安全窗 + 保留 1 个隐藏壳限制损失面。
 *
 * 本模块纯函数化（无 React/DOM 依赖），供 App.tsx 接线与 node 直跑单测。
 */

/** 隐藏的非 local 壳保留上限（最近访问的 1 个）。内部实现参数——对外无
 * import 消费者（注释/文档以文字引用），不进入公共导出面。 */
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
  /** 自动预热来源的已 settle 视图 id 集合（App 层 autoPrewarmedRef 快照；
   *  缺省 = 无）。回收优先级：用户曾主动打开的壳优先保留——同窗候选里先
   *  收自动预热壳（2026 评审：预热壳 settle 的 hiddenSince 恒晚于用户切走
   *  时间，纯 hiddenSince 排序会把用户的温壳先收掉）。 */
  prewarmOriginIds?: ReadonlySet<string>
  now: number
}

/**
 * 决定本次应回收的视图 id（0..n，幂等、确定性）。规则：
 * 1. 候选 = 挂载中、非 local/active/pending/prewarm-inflight、已 settle、
 *    且 hiddenSince 存在并 ≥ VIEW_RECLAIM_GRACE_MS（恰好等于边界即可回收
 *    ——docs 与 STATUS 一律记「≥60s」，2026 评审对齐措辞，边界有单测钉住）；
 * 2. 隐藏非 local 壳数超过 RETAINED_HIDDEN_VIEWS 才回收，一次只收到上限
 *    （尽力而为：不可回收的占位壳——如仍在 boot——不计入本次回收量，但其
 *    settle 后会自行进入候选窗）；
 * 3. 同窗候选的排序 = **自动预热来源优先于用户来源**，其内按 hiddenSince
 *    升序（最久者先）——预热壳从没被用户请求，占槽时先走（2026 评审：
 *    否则"预热启动早于用户切走"的 straddle 形态会在 60s 后把用户温壳收
 *    掉、把从未点开的预热壳留在槽里）。
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
  // 在途预热/收割壳不计入隐藏壳数（2026-12 复查）：它此刻通常尚未 settle、
  // 本就不在 reclaimable 集合里，若计进 excess，收割窗口内候选就只剩用户的
  // 温壳——它会被回收并写入抑制，用户最近用过的源白白失去温壳。该壳由收割
  // 自身（推送/截止/放弃上限）或 settle 后的下一轮负责回收。
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
    // 自动预热来源先收（其内最久者先）；无 origin 信息时退化为纯
    // hiddenSince 排序（测试夹具与旧行为一致）。
    const aPrewarm = prewarmOriginIds !== undefined && prewarmOriginIds.has(a) ? 0 : 1
    const bPrewarm = prewarmOriginIds !== undefined && prewarmOriginIds.has(b) ? 0 : 1
    if (aPrewarm !== bPrewarm) return aPrewarm - bPrewarm
    return (hiddenSince[a] ?? 0) - (hiddenSince[b] ?? 0)
  })
  return reclaimable.slice(0, Math.min(excess, reclaimable.length))
}

/**
 * 后台相位门控（2026 性能整改）：文档隐藏（Electron 最小化/隐藏到托盘/后台
 * 标签语义）时不推进周期性/后台工作——空闲预热 boot、30s 聚合 watchdog 拉
 * 取与 S2 reconnect、3s 失败重试、保留回收拆壳——这些在用户不可见期没有
 * 收益却持续烧主线程；恢复可见由 App 的 visibilitychange 补偿一轮。
 * 注意：这不门控"已回收源的 30s unary 兜底"——兜底轮询走 watchdog 周期，
 * 隐藏窗暂停、恢复补偿，二者并不冲突；unary 兜底本身只在窗口可见时被调度。
 */
export function shouldRunBackgroundPhase(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === 'visible'
}
