/**
 * 一次 roster 刷新（health + instances_get 快照对）的提交规划。
 *
 * 只有**健康且完整**的快照是权威快照：只有它能退役、覆盖身份（activate/reincarnate）、
 * 结算 roster 闸门、替换 last-known live 并安装/刷新整份权威行。rosterIncomplete（行级丢弃）
 * 与 degraded 注册表答案是**部分提交**：只安装并激活此前未确认的**新来源 id**（V5-A 可见性），
 * 对已确认来源（owner registry 里已有 fingerprint 的来源）保留当前显示行与身份——包括 partial
 * 清单里缺失的行、以及同 id 但指纹改变的行（后者是候选，等完整快照再提交并恰好退役一次）。
 *
 * 规划只读入参、不碰 store；执行顺序由 app-hooks/use-roster-commit.ts 的 commitRosterPlan 落地
 * （retire → activate/reincarnate → install → settle → live → refreshStatus）。
 */
import {
  authoritativeSourceRetirements,
  parseAuthoritativeSourceFingerprint,
  type AuthoritativeSourceFingerprint,
} from '../deep-link-activation.ts'
import type { SshInstanceSpec } from '../global.d.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { sourceIdForInstance } from '../transport-source.ts'

/** 健康探针里决定提交模式的两个位（droppedCount 只进诊断文案，不影响规划）。 */
export interface RosterHealth {
  degraded: boolean
  rosterIncomplete: boolean
}

/** 一次提交要 activate（owner registry）并 reincarnate（生命周期账本）的来源化身。 */
export interface RosterActivation {
  sourceId: string
  fingerprint: string
}

/** 一次提交安装的行需要从主进程刷新一次隧道状态投影（原始 registry id + source id）。 */
export interface RosterStatusRefresh {
  instance: SshInstanceSpec
  sourceId: string
}

interface RosterCommitPlanBase {
  /** 交给 remotesStore.setInstances 的显示行（partial 下已确认行复用 prior 的同一行对象）。 */
  instances: SshInstanceSpec[]
  /** 需要 activate + reincarnate 的化身（完整快照 = 全部合法行；partial = 仅新来源 id）。 */
  activate: RosterActivation[]
  /** 需要同步退役的来源 id（退役删 owner，因此同一来源不会出现两次）。 */
  retire: Set<string>
  /** 是否允许 settle rosterGate。 */
  settle: boolean
  /** 需要 refreshRemoteStatus 的行。 */
  refreshStatus: RosterStatusRefresh[]
}

/**
 * 提交计划（discriminated union）：
 * - `degraded`：注册表加载失败，答案根本不是 roster——不安装、不激活、不退役、不结算；
 * - `partial`：健康但只是子集（行级丢弃）——只安装/激活新来源 id，已确认行与身份原样保留；
 * - `complete`：健康且完整的权威快照——退役、覆盖身份、安装权威行、结算并替换 live。
 * 只有 complete 携带 `live`（唯一允许替换 last-known live 的模式），partial/degraded 没有该字段。
 */
export type RosterCommitPlan =
  | ({ mode: 'degraded' } & RosterCommitPlanBase)
  | ({ mode: 'partial' } & RosterCommitPlanBase)
  | ({ mode: 'complete' } & RosterCommitPlanBase & {
    /** 新的权威 live 集合（仅 complete 存在：partial/degraded 不写 live）。 */
    live: Set<string>
  })

export interface RosterCommitInput {
  health: RosterHealth
  /** instances_get 的原始数组（合法 proof 过滤在规划器内完成）。 */
  instances: readonly SshInstanceSpec[]
  /** remotesStore 当前显示行（partial 复用其中的同一行对象）。 */
  priorInstances: SshInstanceSpec[]
  /** liveServerIdsRef 的当前值（含 local）。 */
  live: ReadonlySet<string>
  /** owner registry 已确认的 fingerprint 表（partial 的身份保留依据）。 */
  fingerprints: ReadonlyMap<string, string>
}

interface AcceptedInstance {
  instance: SshInstanceSpec
  sourceId: string
  fingerprint: string
}

/**
 * 合法 proof 的行。非法 proof 行在任何模式下都不安装：没有可验证的化身证明就没有身份，
 * 以既有诊断文案 loud 一次（生命周期权威不得由可编辑字段推导/修复）。
 */
function acceptRosterInstances(instances: readonly SshInstanceSpec[]): AcceptedInstance[] {
  const accepted: AcceptedInstance[] = []
  for (const instance of instances) {
    const sourceId = sourceIdForInstance(instance)
    const fingerprint = parseAuthoritativeSourceFingerprint(sourceId, instance.sourceFingerprint)
    if (fingerprint === null) {
      console.error(`[renderer] remote source ${sourceId} omitted: invalid authoritative lifecycle proof`)
      continue
    }
    accepted.push({ instance, sourceId, fingerprint })
  }
  return accepted
}

/** 逐项同一对象且同序：partial 无变化时让 setInstances 收到 prior 数组引用（不触发订阅通知）。 */
function sameRows(next: readonly SshInstanceSpec[], prior: readonly SshInstanceSpec[]): boolean {
  if (next.length !== prior.length) return false
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== prior[index]) return false
  }
  return true
}

/**
 * 部分提交（health 健康但 roster 只是子集）：已确认来源的**当前显示行**（同一行对象、同序）
 * 原样保留，清单里缺失的行也一样——缺行不是退役权威。partial 清单里此前未确认的行分两种：
 * 新来源 id 安装并激活（V5-A 可见性）；已确认但当前无显示行的来源只安装该行、保持身份。
 * 同 id 新指纹属于候选：已确认来源一律保留 prior 行与旧身份，不 activate、不 reincarnate。
 */
function planPartialCommit(
  accepted: readonly AcceptedInstance[],
  priorInstances: SshInstanceSpec[],
  fingerprints: ReadonlyMap<string, string>,
): RosterCommitPlan {
  const display: SshInstanceSpec[] = []
  const listed = new Set<string>()
  // 1) 已确认来源的当前显示行先按 prior 顺序原样保留（含 partial 清单里缺失的行）。
  for (const row of priorInstances) {
    const sourceId = sourceIdForInstance(row)
    if (!fingerprints.has(sourceId)) continue
    display.push(row)
    listed.add(sourceId)
  }
  const activate: RosterActivation[] = []
  const refreshStatus: RosterStatusRefresh[] = []
  // 2) partial 清单里尚未显示的行：新来源 id 安装并激活；已确认来源只装行、不重新激活。
  for (const { instance, sourceId, fingerprint } of accepted) {
    if (listed.has(sourceId)) continue
    listed.add(sourceId)
    display.push(instance)
    if (fingerprints.has(sourceId)) continue
    activate.push({ sourceId, fingerprint })
    refreshStatus.push({ instance, sourceId })
  }
  return {
    mode: 'partial',
    instances: sameRows(display, priorInstances) ? priorInstances : display,
    activate,
    retire: new Set<string>(),
    settle: false,
    refreshStatus,
  }
}

/**
 * 完整提交（健康且完整 = 权威快照）：按 owner 旧指纹与缺失 id 计算一次退役，全部合法行
 * activate + reincarnate（同指纹幂等；候选的新指纹在退役后 mint 新化身），安装权威行以替换
 * partial 期间被推迟的候选行，结算并替换 live。已确认集合 = 上次权威 live ∪ owner registry：
 * partial 里刚激活的新来源若不再出现，同样在这里一次性退役。
 */
function planCompleteCommit(
  accepted: readonly AcceptedInstance[],
  live: ReadonlySet<string>,
  fingerprints: ReadonlyMap<string, string>,
): RosterCommitPlan {
  const nextSources: AuthoritativeSourceFingerprint[] = [
    { sourceId: LOCAL_INSTANCE_ID, fingerprint: 'local' },
    ...accepted.map(({ sourceId, fingerprint }) => ({ sourceId, fingerprint })),
  ]
  const confirmed = new Set<string>([...live, ...fingerprints.keys()])
  return {
    mode: 'complete',
    instances: accepted.map(({ instance }) => instance),
    activate: accepted.map(({ sourceId, fingerprint }) => ({ sourceId, fingerprint })),
    retire: authoritativeSourceRetirements(confirmed, fingerprints, nextSources),
    live: new Set(nextSources.map(source => source.sourceId)),
    settle: true,
    refreshStatus: accepted.map(({ instance, sourceId }) => ({ instance, sourceId })),
  }
}

/** 规划一次 roster 提交。health 的 degraded 位优先于 rosterIncomplete（后者只可能伴随健康答案）。 */
export function planRosterCommit(input: RosterCommitInput): RosterCommitPlan {
  const { health, instances, priorInstances, live, fingerprints } = input
  if (health.degraded) {
    return {
      mode: 'degraded',
      instances: priorInstances,
      activate: [],
      retire: new Set<string>(),
      settle: false,
      refreshStatus: [],
    }
  }
  const accepted = acceptRosterInstances(instances)
  return health.rosterIncomplete
    ? planPartialCommit(accepted, priorInstances, fingerprints)
    : planCompleteCommit(accepted, live, fingerprints)
}
