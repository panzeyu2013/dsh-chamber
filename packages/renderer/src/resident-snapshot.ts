/**
 * 常驻壳页面级快照的纯构建器（N-ctx 壳常驻 v1.1，D2 的投影半边）。
 *
 * 单一职责：把「挂载集合 + 活态视图 + shell 状态 + 标签 + 已释放历史 + 活动时刻」投影成
 * `ResidentSnapshot`（页面级契约在 client-core 的 resident-store.ts）。判定与数据采集都不在这里：
 * DOM 节点数由调用方注入（`domNodes`），时钟由调用方给 `now`。因此本模块零运行期 import，
 * 可直接用 node:test 直测；常驻阀只做接线与订阅。
 *
 * 两条契约（design 05 §4.1 / design 15 §D5）：
 * - 状态词表 active / resident / booting / failed / released 全部**可被产出**：挂载壳按
 *   active/painted/settled/error 投影，已释放但仍在注册表的来源以 `released` 行追加在末尾
 *   （面板据此显示「已释放」，而不是让该行凭空消失）；
 * - 隐藏事实（hiddenSinceMs / lastActiveAt）**只属于 resident 壳**：active（屏上）、booting（未
 *   settle）、failed（失败覆盖层持有）与 released（壳已卸载）都不带隐藏时长，绝不把「屏上」读成
 *   「隐藏了多久」。
 */
import type {
  ResidentReleaseFact,
  ResidentShellState,
  ResidentSnapshot,
  ResidentSourceFact,
} from '@dsh-chamber/dsh-chamber-client-core'

/** 常驻阀需要的最小 shell 状态面（结构兼容 shell.ts 的 ShellState，不引入其运行期依赖）。 */
export interface ResidentShellFactLike {
  readonly booted: boolean
  readonly error: string | null
}

/** 构建输入：全部由调用方从 App 状态/活态视图采集；本模块不读时钟、不碰 DOM、不改入参。 */
export interface ResidentSnapshotInputs {
  /** 挂载序（数组序 = 挂载序，local 在列；mounted 计数含 local）。 */
  readonly mountedIds: readonly string[]
  readonly activeId: string
  readonly paintedId: string
  readonly shellStates: Readonly<Record<string, ResidentShellFactLike>>
  readonly labels: Readonly<Record<string, string>>
  /** 已释放但仍注册的来源（壳与视图均已卸载）；与 mounted 的交集会被防御性剔除。 */
  readonly releasedIds: ReadonlySet<string>
  readonly autoPrewarmed: { has(id: string): boolean }
  readonly lastActiveAt: Readonly<Record<string, number>>
  /** 本次决策的单调钟时刻（同一时基：performance.now 毫秒）。 */
  readonly now: number
  /** 设置面板当前目标来源（面板打开期间该壳不可释放；缺席/null = 无目标）。 */
  readonly settingsTargetId?: string | null
  /** 每壳 DOM 节点数估读（可选；缺席 = 本次不采集或不可得）。 */
  readonly domNodes?: (id: string) => number | undefined
  readonly lastRelease?: ResidentReleaseFact
}

function isSettled(shell: ResidentShellFactLike | undefined): boolean {
  return shell !== undefined && (shell.booted || shell.error !== null)
}

function stateOf(
  id: string,
  activeId: string,
  paintedId: string,
  shellStates: Readonly<Record<string, ResidentShellFactLike>>,
): ResidentShellState {
  if (id === activeId || id === paintedId) return 'active'
  const shell = shellStates[id]
  if (!isSettled(shell)) return 'booting'
  return shell.error !== null ? 'failed' : 'resident'
}

/** 已释放行的来源事实：标签缺失（例如尚未完成 roster 刷新）时跳过该行，绝不臆造身份。 */
function releasedFacts(input: ResidentSnapshotInputs): ResidentSourceFact[] {
  const rows: ResidentSourceFact[] = []
  for (const id of input.releasedIds) {
    if (input.mountedIds.includes(id)) continue
    if (!Object.prototype.hasOwnProperty.call(input.labels, id)) continue
    rows.push({ id, label: input.labels[id], state: 'released' })
  }
  return rows
}

/**
 * 构建页面级常驻快照：先按挂载序投影每个挂载壳，再追加已释放行；counts 由本函数算好
 * （mounted 含 local；released = 追加的已释放行数；active/resident 只统计挂载壳）。
 */
export function buildResidentSnapshot(input: ResidentSnapshotInputs): ResidentSnapshot {
  const sources: ResidentSourceFact[] = []
  let active = 0
  let resident = 0
  for (const id of input.mountedIds) {
    const state = stateOf(id, input.activeId, input.paintedId, input.shellStates)
    if (state === 'active') active += 1
    else if (state === 'resident') resident += 1
    // DOM 节点数只为订阅者采集（调用方已按订阅者存在与否决定是否注入该函数）；
    // 0 个节点与「不可得」同义，都不写字段（面板渲染占位）。
    const domNodes = input.domNodes?.(id)
    const lastActiveAt = input.lastActiveAt[id]
    sources.push({
      id,
      label: input.labels[id] ?? id,
      state,
      ...(state === 'resident' && lastActiveAt !== undefined
        ? { lastActiveAt, hiddenSinceMs: Math.max(0, input.now - lastActiveAt) }
        : {}),
      ...(domNodes === undefined || domNodes <= 0 ? {} : { domNodes }),
      ...(input.autoPrewarmed.has(id) ? { autoPrewarmed: true } : {}),
      ...(input.settingsTargetId !== undefined && input.settingsTargetId !== null && input.settingsTargetId === id
        ? { settingsTarget: true }
        : {}),
    })
  }
  const releasedRows = releasedFacts(input)
  sources.push(...releasedRows)
  const snapshot: ResidentSnapshot = {
    sources,
    counts: { mounted: input.mountedIds.length, active, resident, released: releasedRows.length },
    ...(input.lastRelease === undefined ? {} : { lastRelease: input.lastRelease }),
  }
  return snapshot
}
