/**
 * 常驻壳策略纯核心（N-ctx 壳常驻重构 v1.1）——把 v1.0 的「隐藏壳最多 1 个」收窄为：
 * - 硬上限：挂载壳总数（local 计入挂载数）超过 RESIDENT_HARD_CAP 时，每轮只挑一个可释放
 *   的壳（调用方负责错峰与 settle 延迟）；
 * - 输入保护：最近 INPUT_GRACE_MS 内有过输入的壳不释放——用户正在用的壳不拆；
 * - 内存压力阀：可用内存比例**按档位**连续 2 次低于 8% = critical（释放全部可释放常驻壳），
 *   **按档位**连续 2 次低于 15% = constrained（保留至多 1 个最近使用的常驻壳，其余释放）；
 *   档位交替（如同一次 constrained 后一次 critical）会重置计数，绝不凭单次读数动作。
 *
 * 本模块是零 import 叶子：不读时钟、不碰 DOM、无副作用。调用方把单调钟 `now`、挂载表与
 * 观察表作为纯输入传进来，本模块只回答「该释放谁」；回收本身（dispose shell + 卸载 UI 壳 +
 * 写预热抑制标记）由 App 的 reclaimView 执行。
 *
 * 保护面（硬上限与压力阀完全共用）：active / painted / pending / settingsTarget / booting /
 * 非 resident（例如 local 与尚未 settle 的壳）/ 最近输入窗内的壳——任何一条命中都不释放。
 * local 由调用方以「不在 residentIds 里」排除：本模块不认来源语义，只认调用方给出的集合。
 */

/** 常驻壳硬上限（挂载总数，local 计入）：超过后每轮最多释放一个。 */
export const RESIDENT_HARD_CAP = 12

/** 输入保护窗：最近一次输入距今不足该值的壳不参与任何释放（= 10 分钟）。 */
export const INPUT_GRACE_MS = 10 * 60_000

/** 内存压力分档：critical 需要连续 2 次观测（避免一次瞬时抖动拆壳）。 */
const PRESSURE_STRIKES = 2
/** critical 阈值：可用/总量比例低于 8%。 */
const CRITICAL_FREE_RATIO = 0.08
/** constrained 阈值：可用/总量比例低于 15%。 */
const CONSTRAINED_FREE_RATIO = 0.15

/** 内存压力档位（normal = 不动作）。 */
export type PressureBand = 'normal' | 'constrained' | 'critical'

/**
 * 一次释放决策的输入快照。字段全部由调用方（常驻阀）从 App 状态构建：
 * - `mountedIds` 是挂载序（数组序 = 挂载序，local 在列）；
 * - `activeId`/`paintedId` 是已落地/已绘制的活动壳（过渡在途时二者可能不同）；
 * - `pendingId`/`settingsTargetId` 是在途切换与设置面目标（绝不回收）；
 * - `bootingIds` 是未 settle 的壳；`residentIds` 是已 settle 的非 local 壳（回收池）；
 * - `autoPrewarmedIds` 是系统自动预热的壳（同窗优先释放）；
 * - `lastActiveAt`/`lastInputAt` 是单调钟毫秒，缺席 = 无记录；
 * - `now` 是本次决策的单调钟时刻；`cap` 缺省 = RESIDENT_HARD_CAP。
 */
export interface ReleaseContext {
  mountedIds: readonly string[]
  activeId: string
  paintedId: string
  pendingId: string | null
  settingsTargetId: string | null
  bootingIds: ReadonlySet<string>
  autoPrewarmedIds: ReadonlySet<string>
  residentIds: ReadonlySet<string>
  lastActiveAt: Readonly<Record<string, number>>
  lastInputAt: Readonly<Record<string, number>>
  now: number
  cap?: number
}

/** 压力判定的上一次结果（阀在采样间保存，下次作为 previous 传回）。 */
export interface PressureDecision {
  band: PressureBand
  strikes: number
  /** band === 'normal' 时遗留的一击所属档位（下一轮同档且连续才升级；异档即重置）。 */
  pendingBand?: PressureBand
}

/** 压力判定输入：freeRatio = availableBytes/totalBytes（null = 平台答不出）。 */
export interface PressureInput {
  freeRatio: number | null
  /** 上一次判定；首轮为 null。 */
  previous: PressureDecision | null
  /** 单调钟毫秒。当前规则不依赖时间（确定性），保留给调用方的上下文与未来 dwell 判据。 */
  now: number
}

/** 最近一次输入是否仍在保护窗内（缺记录 = 从未输入 = 不保护）。 */
function inputProtected(ctx: ReleaseContext, id: string): boolean {
  const lastInput = ctx.lastInputAt[id]
  return lastInput !== undefined && ctx.now - lastInput < INPUT_GRACE_MS
}

/** 一个壳是否命中任一保护面（见模块头的保护面清单）。 */
function isProtected(ctx: ReleaseContext, id: string): boolean {
  if (id === ctx.activeId || id === ctx.paintedId) return true
  if (ctx.pendingId !== null && id === ctx.pendingId) return true
  if (ctx.settingsTargetId !== null && id === ctx.settingsTargetId) return true
  if (ctx.bootingIds.has(id)) return true
  if (!ctx.residentIds.has(id)) return true
  return inputProtected(ctx, id)
}

/**
 * 可释放候选（挂载序过滤 + 释放优先级排序）：自动预热壳先（系统投机挂载让位用户温壳），
 * 同窗内按 `lastActiveAt` 升序（最久未活跃者先，缺席按 0）；同键保持挂载序（稳定排序）。
 * 返回新数组，绝不改写入参。
 */
function releaseCandidates(ctx: ReleaseContext): string[] {
  return ctx.mountedIds
    .filter(id => !isProtected(ctx, id))
    .sort((a, b) => {
      const aPrewarm = ctx.autoPrewarmedIds.has(a) ? 0 : 1
      const bPrewarm = ctx.autoPrewarmedIds.has(b) ? 0 : 1
      if (aPrewarm !== bPrewarm) return aPrewarm - bPrewarm
      return (ctx.lastActiveAt[a] ?? 0) - (ctx.lastActiveAt[b] ?? 0)
    })
}

/**
 * 硬上限释放：只在挂载总数 > cap（缺省 RESIDENT_HARD_CAP）时返回 **一个** 可释放 id；
 * 无可释放候选（全部受保护）返回 null。重复调用幂等（同输入同输出）。
 */
export function pickHardCapRelease(ctx: ReleaseContext): string | null {
  const cap = ctx.cap ?? RESIDENT_HARD_CAP
  if (ctx.mountedIds.length <= cap) return null
  const candidates = releaseCandidates(ctx)
  return candidates.length === 0 ? null : candidates[0]
}

/**
 * 内存压力释放：band = normal 返回空；constrained 返回「至多保留 1 个最近使用的常驻壳」
 * 之后的候选；critical 返回全部可释放候选。顺序与 {@link pickHardCapRelease} 相同
 * （自动预热壳先，再按最久未活跃），调用方按返回序错峰释放。纯函数、幂等、不改入参。
 */
export function pickPressureReleases(ctx: ReleaseContext, band: PressureBand): string[] {
  if (band === 'normal') return []
  const candidates = releaseCandidates(ctx)
  if (band === 'critical') return candidates
  // constrained：释放序的最后一个 = 最近使用的候选（自动预热壳永远排在用户温壳之前），保留它。
  return candidates.slice(0, Math.max(0, candidates.length - 1))
}

/** 无压力观测的确定性结果（每次返回新对象，调用方可以安全持有）。 */
function normalDecision(): PressureDecision {
  return { band: 'normal', strikes: 0 }
}

/**
 * 内存压力分档（**按档位**连续 2 次观测才升级，确定性、无时钟依赖）：
 * - freeRatio === null 或非有限值 → normal（平台答不出 = 不动作）；
 * - 比例 < 8% → critical 条件，< 15% → constrained 条件，否则 normal；
 * - 同一档位连续观测 2 次才把 band 升到该档（`strikes` 饱和在 2）；第一击返回
 *   `{ band: 'normal', strikes: 1, pendingBand }`，即「已记一击但尚不动作」；
 * - **档位交替即重置**（例如 12% → 7%）：上一击属于另一个档位时，本次只记新档位的第一击，
 *   绝不让「一次 constrained + 一次 critical」升成 critical——单次瞬时低水位不释放全部壳；
 * - 任何一次 normal 观测立即清零（strikes 0、band normal，pendingBand 缺席）。
 *
 * 阀只消费 `band`：它已经是去抖后的可执行档位（不需要再看 strikes）。
 */
export function classifyPressure(input: PressureInput): PressureDecision {
  const { freeRatio, previous } = input
  if (freeRatio === null || !Number.isFinite(freeRatio)) return normalDecision()
  const band: PressureBand = freeRatio < CRITICAL_FREE_RATIO
    ? 'critical'
    : freeRatio < CONSTRAINED_FREE_RATIO
      ? 'constrained'
      : 'normal'
  if (band === 'normal') return normalDecision()
  if (previous !== null && previous.band === band) {
    return { band, strikes: Math.min(PRESSURE_STRIKES, previous.strikes + 1) }
  }
  // 上一轮是同一档位的 pending 一击：连续第二次同档观测，升级到可执行档位。
  if (previous !== null && previous.pendingBand === band) {
    return { band, strikes: PRESSURE_STRIKES }
  }
  // 异档（或首次）观测：只记新档位的第一击，绝不跨档升级。
  return { band: 'normal', strikes: 1, pendingBand: band }
}
