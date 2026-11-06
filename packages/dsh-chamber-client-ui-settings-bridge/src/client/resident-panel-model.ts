/**
 * 「性能与内存」只读组的纯投影（零 React、零运行时 import）。
 *
 * 状态文案键、隐藏时长/字节格式化、释放按钮的禁用门与两击确认（in-place arm）状态机、
 * 以及「系统内存 / 页面 JS 堆」的可得性投影全部在这里；组件只做「视图模型 → t(...) +
 * className」映射。抽纯函数的理由与 debug-mode-gate.ts / update-gate.ts 同款：真值表
 * 可以 node:test 直测，源码断言只留结构锚，呈现决策不再散落在 JSX 条件里。
 *
 * 数据面两条、都只读：
 *  - client-core 的页面级 residentBridge（D2 契约）——本模块按**结构解码**，未知/
 *    损坏形状降级为 `unknown` 状态 / 空表，绝不臆造（todo-prefs.ts 同规：面板不是
 *    发布端，形状演进只能让它更保守）；
 *  - settings 投影的可选 `system` 快照（D4）——结构读，缺字段 = 不可得。
 *
 * 零运行时 import 是刻意的：单测用 node 直跑 .ts（类型擦除），不需要 workspace 安装；
 * 唯一 import 是 client-core 的**类型**（D2 契约词汇），类型 import 不进运行图。
 */
import type { ResidentShellState } from '@dsh-chamber/dsh-chamber-client-core'

/** 发布端上报的壳状态（D2 契约词汇；单一来源，不在本面板重写一份）。 */
export type ResidentState = ResidentShellState

/** 本面板的行状态：契约词汇 + 对未知形状的诚实哨兵（绝不把坏形状猜成 resident）。 */
export type ResidentRowState = ResidentState | 'unknown'

/** 一个常驻来源的结构子集（D2 ResidentSourceFact 的可选字段按「缺失 = 未知」读）。 */
export interface ResidentFactLike {
  id: string
  label: string
  state: ResidentRowState
  /** 隐藏时长（毫秒，发布端已计好；有则直接格式化）。 */
  hiddenSinceMs?: number
  /** 最近一次活动时刻（**单调钟**毫秒，D2 契约）；hiddenSinceMs 缺席时回退用它算隐藏时长。 */
  lastActiveAt?: number
  /** 该壳的 DOM 节点数（估算口径，不是字节内存）。 */
  domNodes?: number
  /** 设置面板当前目标来源（打开期间排除出释放路径；面板据此禁用释放动作）。 */
  settingsTarget?: boolean
}

/** 常驻快照的只读视图（sources + 最近一次释放事实；counts 本面板不用，故不解码）。 */
export interface ResidentSnapshotView {
  sources: readonly ResidentFactLike[]
  lastRelease?: { sourceId: string; reason: 'manual' | 'cap' | 'pressure'; at: number }
}

/** 契约词汇全集：Record<ResidentState, true> 让 D2 新增状态时**本文件 typecheck 变红**
 *  （强制同步展示词表，而不是让新状态静默降级为 unknown）。 */
const RESIDENT_STATE_SET: Readonly<Record<ResidentState, true>> = Object.freeze({
  active: true,
  resident: true,
  booting: true,
  failed: true,
  released: true,
})
const RESIDENT_STATES: readonly ResidentState[] = Object.keys(RESIDENT_STATE_SET) as ResidentState[]
const RELEASE_REASONS: readonly ('manual' | 'cap' | 'pressure')[] = ['manual', 'cap', 'pressure']

/** 宽松结构守卫（与 todo-prefs / settings 归一同一套私有实现，不引共享库）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 非负有限数；其余（缺失/NaN/负/非数）返回 undefined = 未知。 */
function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function decodeState(value: unknown): ResidentRowState {
  return typeof value === 'string' && (RESIDENT_STATES as readonly string[]).includes(value)
    ? (value as ResidentState)
    : 'unknown'
}

/** 一条来源事实：id 必须是非空字符串（没有身份的行不可操作，直接丢弃）；label 缺失回落空串。 */
function decodeFact(raw: unknown): ResidentFactLike | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') return null
  const fact: ResidentFactLike = {
    id,
    label: typeof raw.label === 'string' ? raw.label : '',
    state: decodeState(raw.state),
  }
  const hidden = nonNegativeFinite(raw.hiddenSinceMs)
  if (hidden !== undefined) fact.hiddenSinceMs = hidden
  const lastActive = nonNegativeFinite(raw.lastActiveAt)
  if (lastActive !== undefined) fact.lastActiveAt = lastActive
  const nodes = nonNegativeFinite(raw.domNodes)
  if (nodes !== undefined) fact.domNodes = nodes
  if (raw.settingsTarget === true) fact.settingsTarget = true
  return fact
}

/** 快照解码：非对象 = 空表；sources 里逐条校验，坏行丢弃（显示面宁可少一行也不摆错）。 */
export function decodeResidentSnapshot(raw: unknown): ResidentSnapshotView {
  if (!isRecord(raw)) return { sources: [] }
  const sources: ResidentFactLike[] = []
  if (Array.isArray(raw.sources)) {
    for (const entry of raw.sources) {
      const fact = decodeFact(entry)
      if (fact !== null) sources.push(fact)
    }
  }
  const view: ResidentSnapshotView = { sources }
  const release = raw.lastRelease
  if (isRecord(release)
    && typeof release.sourceId === 'string' && release.sourceId !== ''
    && typeof release.reason === 'string'
    && (RELEASE_REASONS as readonly string[]).includes(release.reason)) {
    const at = nonNegativeFinite(release.at)
    if (at !== undefined) {
      view.lastRelease = {
        sourceId: release.sourceId,
        reason: release.reason as 'manual' | 'cap' | 'pressure',
        at,
      }
    }
  }
  return view
}

// ---- 时长/字节格式化（locale-neutral 数字单位；列名与说明走 i18n 字典）----

/** 毫秒 → 紧凑时长：`45s` / `2m 05s` / `1h 03m` / `2d 04h`。非法值返回 ''（调用方渲染占位）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return `${hours}h ${String(restMinutes).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, '0')}h`
}

const BYTE_UNITS: readonly string[] = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

/** 字节 → 人类可读（1024 进制）。**格式与 client-core runtime-management.ts 的
 *  `formatRuntimeBytes` 同规**（unit 0 = floor；其余 >=10 取整、<10 一位小数；非法值
 *  '—'）——用户会在「dsh 运行时」段落同时看到两个读数，两种口径并存比重复实现更糟。
 *  该函数是跨包叶子导出；本模块为保持零 import 可单测而保留自有副本，若未来统一，应把
 *  它挪进共享零依赖叶子，而不是再写第三份。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${Math.floor(value)} ${BYTE_UNITS[unit]}`
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[unit]}`
}

/** 隐藏时长：优先用 `lastActiveAt + now` 现算（面板的显示时钟让它随打开时长前进，不冻结在
 *  发布时刻）；`hiddenSinceMs` 只作无 lastActiveAt 时的兜底。**now 必须与 lastActiveAt 同一时基**
 *  （D2 契约 = 单调钟毫秒；组件用 performance.now()，绝不拿 Date.now() 去减它）；无法判定 =
 *  undefined，绝不猜 0。 */
export function hiddenForMs(fact: Pick<ResidentFactLike, 'hiddenSinceMs' | 'lastActiveAt'>, now: number): number | undefined {
  if (typeof fact.lastActiveAt === 'number' && Number.isFinite(fact.lastActiveAt)) {
    const delta = now - fact.lastActiveAt
    if (delta >= 0) return delta
  }
  if (typeof fact.hiddenSinceMs === 'number' && Number.isFinite(fact.hiddenSinceMs) && fact.hiddenSinceMs >= 0) {
    return fact.hiddenSinceMs
  }
  return undefined
}

// ---- 状态文案键 ----

export type ResidentStateKey =
  | 'generalResidentStateActive'
  | 'generalResidentStateResident'
  | 'generalResidentStateBooting'
  | 'generalResidentStateFailed'
  | 'generalResidentStateReleased'
  | 'generalResidentStateUnknown'

/** 行状态 → 词典键（未知形状有独立文案，绝不冒充「后台常驻」）。 */
export function residentStateKey(state: ResidentRowState): ResidentStateKey {
  switch (state) {
    case 'active': return 'generalResidentStateActive'
    case 'resident': return 'generalResidentStateResident'
    case 'booting': return 'generalResidentStateBooting'
    case 'failed': return 'generalResidentStateFailed'
    case 'released': return 'generalResidentStateReleased'
    default: return 'generalResidentStateUnknown'
  }
}

// ---- 行视图 ----

export interface ResidentRowView {
  id: string
  /** 空 label 回落 id（行标识不可为空；与侧栏空 label 回落 id 同规）。 */
  labelText: string
  state: ResidentRowState
  stateKey: ResidentStateKey
  hiddenForMs?: number
  /** '' = 未知 → 组件渲染占位符。 */
  hiddenForText: string
  domNodes?: number
  /** '' = 未知 → 组件渲染占位符。 */
  domNodesText: string
  /** 该行处于两击确认的 arm 窗内。 */
  armed: boolean
  /** 释放请求在途（组件本地态，桥不提供）。 */
  busy: boolean
  /** 设置面板正在使用该来源：释放动作不可用（面板关闭后恢复）。 */
  settingsTarget: boolean
  releaseDisabled: boolean
}

/**
 * 表行投影。禁用门 = 活动/启动中/已释放/释放中（验收面）；其余状态可尝试释放。
 * 隐藏时长只对 state === 'resident' 的行有意义：active（屏上）、booting/failed 与 released
 * 一律渲染占位符——绝不把「屏上」或「已卸载」读成「隐藏了多久」。
 */
export function residentRowViews(input: {
  sources: readonly ResidentFactLike[]
  releasingId: string | null
  armedId: string | null
  now: number
}): ResidentRowView[] {
  return input.sources.map((fact) => {
    const hiddenMs = fact.state === 'resident' ? hiddenForMs(fact, input.now) : undefined
    const busy = input.releasingId === fact.id
    const row: ResidentRowView = {
      id: fact.id,
      labelText: fact.label.trim() !== '' ? fact.label : fact.id,
      state: fact.state,
      stateKey: residentStateKey(fact.state),
      hiddenForText: hiddenMs === undefined ? '' : formatDuration(hiddenMs),
      domNodesText: fact.domNodes === undefined ? '' : String(fact.domNodes),
      armed: input.armedId === fact.id,
      busy,
      settingsTarget: fact.settingsTarget === true,
      releaseDisabled: busy || fact.state === 'active' || fact.state === 'booting'
        || fact.state === 'released' || fact.settingsTarget === true,
    }
    // 可选字段只在已知时出现（缺失 = 未知，组件渲染占位符）——不用 undefined 显式占位。
    if (hiddenMs !== undefined) row.hiddenForMs = hiddenMs
    if (fact.domNodes !== undefined) row.domNodes = fact.domNodes
    return row
  })
}

// ---- 两击确认（in-place arm）状态机 ----

/** 第一次点击 arm 的确认窗；窗内第二次点击 = 释放，超时/点别的行 = 重新 arm。 */
export const RELEASE_CONFIRM_WINDOW_MS = 3_000

export interface ReleaseArmState {
  readonly armedId: string | null
  /** arm 时刻（ms epoch）。 */
  readonly armedAt: number
}

export const NO_RELEASE_ARM: ReleaseArmState = Object.freeze({ armedId: null, armedAt: 0 })

/** 该 arm 是否仍在窗内（时钟回拨按「不在窗内」读 = 保守重来，绝不凭一个逆序时间戳释放）。 */
export function releaseArmed(arm: ReleaseArmState, id: string | null, now: number): boolean {
  if (id === null || arm.armedId !== id || !Number.isFinite(now)) return false
  const elapsed = now - arm.armedAt
  return elapsed >= 0 && elapsed <= RELEASE_CONFIRM_WINDOW_MS
}

/** arm 窗剩余毫秒（无 arm = 0）；组件据此排一个精确的 disarm 定时器而不是轮询。 */
export function releaseArmRemainingMs(arm: ReleaseArmState, now: number): number {
  if (arm.armedId === null || !Number.isFinite(now)) return 0
  const elapsed = now - arm.armedAt
  if (elapsed < 0) return 0
  return Math.max(0, RELEASE_CONFIRM_WINDOW_MS - elapsed)
}

export type ReleaseClickOutcome =
  | { action: 'armed'; next: ReleaseArmState }
  | { action: 'release'; next: ReleaseArmState }

/** 一次「释放 UI」点击：窗内同 id = 释放（并清 arm），否则 arm 本行。 */
export function releaseClick(arm: ReleaseArmState, id: string, now: number): ReleaseClickOutcome {
  if (releaseArmed(arm, id, now)) return { action: 'release', next: NO_RELEASE_ARM }
  return { action: 'armed', next: { armedId: id, armedAt: now } }
}

// ---- 最近一次释放（观察面：来源 + 原因）----

export type ResidentReleaseReasonKey =
  | 'generalResidentReleaseReasonManual'
  | 'generalResidentReleaseReasonCap'
  | 'generalResidentReleaseReasonPressure'

/** 释放原因 → 词典键（契约三值全覆盖；未知原因不展示，绝不猜）。 */
export function releaseReasonKey(reason: 'manual' | 'cap' | 'pressure'): ResidentReleaseReasonKey {
  switch (reason) {
    case 'manual': return 'generalResidentReleaseReasonManual'
    case 'cap': return 'generalResidentReleaseReasonCap'
    case 'pressure': return 'generalResidentReleaseReasonPressure'
  }
}

export interface ResidentLastReleaseView {
  label: string
  reasonKey: ResidentReleaseReasonKey
}

/** 最近释放行：来源标签取快照里该 id 的 label（缺失回落 id）；原因映射成词典键。 */
export function lastReleaseView(snapshot: ResidentSnapshotView): ResidentLastReleaseView | undefined {
  const release = snapshot.lastRelease
  if (release === undefined) return undefined
  const fact = snapshot.sources.find(source => source.id === release.sourceId)
  const label = fact !== undefined && fact.label.trim() !== '' ? fact.label.trim() : release.sourceId
  return { label, reasonKey: releaseReasonKey(release.reason) }
}

// ---- 内存读数投影（D4）----

export type SystemMemorySourceKey =
  | 'generalResidentMemorySourceProcMeminfo'
  | 'generalResidentMemorySourceOsFreemem'
  | 'generalResidentMemorySourceVmStat'
  | 'generalResidentMemorySourceUnknown'

/** 探测来源 → 词典键；未知来源原文不展示（来源名是机制词汇，不是用户可读错误）。 */
export function systemMemorySourceKey(source: string | undefined): SystemMemorySourceKey {
  switch (source) {
    case 'proc-meminfo': return 'generalResidentMemorySourceProcMeminfo'
    case 'os-freemem': return 'generalResidentMemorySourceOsFreemem'
    case 'vm-stat': return 'generalResidentMemorySourceVmStat'
    default: return 'generalResidentMemorySourceUnknown'
  }
}

export type SystemMemoryView =
  | { kind: 'available'; available: string; total: string; sourceKey: SystemMemorySourceKey }
  | { kind: 'unavailable' }

/** 系统内存视图：两个字段都必须是非负有限数且总量 > 0，否则 = 不可得（绝不折 0）。 */
export function systemMemoryView(raw: unknown): SystemMemoryView {
  if (!isRecord(raw)) return { kind: 'unavailable' }
  const total = nonNegativeFinite(raw.totalBytes)
  const available = nonNegativeFinite(raw.availableBytes)
  if (total === undefined || available === undefined || total <= 0) return { kind: 'unavailable' }
  return {
    kind: 'available',
    available: formatBytes(Math.min(available, total)),
    total: formatBytes(total),
    sourceKey: systemMemorySourceKey(typeof raw.source === 'string' ? raw.source : undefined),
  }
}

export type PageHeapView =
  | { kind: 'available'; used: string; limit: string }
  | { kind: 'unavailable' }

/** 页面 JS 堆视图：必须先有 usedJSHeapSize（上限缺失也判不可得，不展示半条读数）。 */
export function pageHeapView(raw: unknown): PageHeapView {
  if (!isRecord(raw)) return { kind: 'unavailable' }
  const used = nonNegativeFinite(raw.usedJSHeapSize)
  const limit = nonNegativeFinite(raw.jsHeapSizeLimit)
  if (used === undefined || limit === undefined || limit <= 0) return { kind: 'unavailable' }
  return { kind: 'available', used: formatBytes(used), limit: formatBytes(limit) }
}
