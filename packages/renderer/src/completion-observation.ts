/**
 * 观测组装（design 19 §3.2.3，Wave3-B2 单点接线）。
 *
 * WHY：reconcile（notification-projection.ts）只吃**一份** (source, session) 的
 * CompletionObservation——可序列化、每会话至多一个候选。桥侧的壳运行时
 * report 与 facts 快照是两个**独立到达**的事实通道，两者的 running / goal /
 * pending / completed 证据必须先用 v5 §3.2 的权威合并规则归一，再喂同一个收敛器。
 * 本模块就是那条归一缝：纯函数、显式调用方状态（无 React/DOM/全局），node 直测。
 *
 * 组装规则（逐条对齐 v5）：
 *  - running 权威：同代**新鲜壳行**（report 非 stale 且该行带显式 running 位）
 *    优先；否则非 stale 且 serviceable 的 facts 行；否则 unknown（不作废、不产候选，INV3）；
 *  - goal 三值：壳行 goal 优先（生产者已按来源代回填最后已知值），facts 行 goal 兜底
 *    （P2a；网关侧同样已回填）；两者都缺席 = 'unknown'。**null 与 unknown 绝不折叠**
 *    （null 是「明确无 goal」，unknown 是不结算/不降级）；
 *  - 子代理（R2-G）：只认运行证据——壳行 subagentActivity（stale 时 running 降为
 *    unknown）；**facts-only 行的 subagentCount（在场子会话数）不作为 busy 证据**
 *    （对 06 §4.5 的有意修正：在场不等于在干活），按 idle/unknown 语义处理；
 *  - candidate：facts 候选要求 completedAtSource==='observed'、该来源本代已播种、
 *    水位严格前进；壳候选 = running true→idle 或 vendor completed 从无到有，且
 *    **factsUsable（verdict ok && serviceable && !stale）为真时壳 complete 不是候选**
 *    （一完成一轨，归属过滤）；ask/request 是 candidate.kind，走同一 reconcile
 *    （v5 #12/INV4：只受 G2 基线播种约束，与 goal 状态无关）。**stale 壳快照不得作
 *    运行证据（C4-X3）：stale=true 时 complete 与 ask/request 候选整体关闭；行记忆
 *    照常推进，使 stale true→false 的同一行状态不再伪造一次边沿**；
 *  - baseline：**每来源本代首批有内容的观测**（G2 不 emit；§3.5 的结算点由
 *    reconcile 的 goalKnown 记忆承担）；
 *  - 会话消失（两条通道都不再列出）⇒ 记入 forgotten，调用方清 pending（§3.1）。
 *
 * 每份观测每会话至多一个候选（§3.3）：同一次壳上报里 complete + ask/request 同时
 * 成立时，本模块为同一会话产出**多份**观测（各有自己的候选），保持旧 planner
 * 「complete 先、ask/request 后」的事件顺序，一个都不丢。
 *
 * generation（G1 代际门）：调用方给 identity（来源生命周期指纹 + 页代 boot token）；
 * identity 变化 = 新来源代，generation 递增，调用方据此撤回旧 pending 并清掉账本
 * 已记录的代（same-id 重建不得继承上一代的判定）。
 */
import type {
  CompletionCandidate,
  CompletionDisposition,
  CompletionObservation,
  CompletionReconcileResult,
  GoalFact,
  GoalFactObservation,
  NotificationKind,
  PlannedNotification,
  RunningObservation,
  SubagentObservation,
} from './notification-projection.ts'
import { reconcile } from './notification-projection.ts'
import type { CompleteLedger } from './complete-ledger.ts'
import type { SessionFactsSnapshot } from './session-facts-source.ts'
import { completionWatermark, maxWatermarkValue } from './watermark.ts'

/** 壳行 pending 种类（InstanceRuntimeReport 的结构子集）。 */
export type ShellObservationPending = 'approval' | 'plan-review' | 'question'
/** 子代理活动三值（与 sidebar session-row-state 同词表）。 */
export type ShellObservationActivity = 'none' | 'running' | 'unknown'

/** 壳运行时行（InstanceRuntimeReport.sessions 的结构子集）。 */
export interface ShellObservationRow {
  running?: boolean
  completed?: boolean
  pending?: ShellObservationPending
  runningSubagents?: number
  subagentActivity?: ShellObservationActivity
  goal?: GoalFact | null
}

/** facts 行（session-facts-source.SessionFactsRow 的判定输入子集）。 */
export interface FactsObservationRow {
  sessionId: string
  running: boolean
  completedAt: number | null
  completedAtSource: 'observed' | 'reconstructed' | null
  updatedAt: number
  subagentCount: number
  goal?: GoalFact | null
}

/** 壳通道输入；stale = 断连来源上仍附加的只读事实（不得作运行证据）。 */
export interface ShellChannelInput {
  readonly rows: Readonly<Record<string, ShellObservationRow>>
  readonly stale?: boolean
}

/** facts 通道输入；usable = verdict ok && serviceable && !stale（v5 §3.2）。 */
export interface FactsChannelInput {
  readonly rows: Readonly<Record<string, FactsObservationRow>>
  readonly usable: boolean
}

/**
 * 每会话的转移记忆（本代内）：壳边沿位、facts 水位。
 * 水位在会话暂时离开壳列表时保留（facts 通道仍可推进），壳位则清空——
 * 行消失即遗忘，重新出现不得从旧 running 位伪造一次完成边沿。
 */
interface SessionObservationMemory {
  shellRunning: RunningObservation
  shellCompleted: boolean
  shellPending?: ShellObservationPending
  factsWatermark: number
  /**
   * 重现待决位（F5 重要项 4）：会话重现时没有可用的 facts 水位行（通道不可用 /
   * 行缺席 / 非 observed）⇒ 第一个可用的 facts 行只播种（不产候选、水位入 memory）
   * 后清除。没有它时，消失前已由壳通知的同一完成会在 facts 后到时水位 100 > memory 0
   * 且 armed 已被遗忘清掉 ⇒ 二次通知。
   */
  factsSeedPending: boolean
  /**
   * COR-1 精度（易失）：自上次可用 facts 批以来，本会话的壳轨**确实 emit 过**一次
   * 无水位 complete（由 applyObservationBatch 依 reconcile 结果置位，任何可用 facts
   * 批清位）。只有它为真的会话在「复位后的恢复批」里重新播种；壳轨在场 / 首报只
   * 播种 / 仅 stale（C4-X3 无边沿）/ 会话不在壳行都不置位——它们没有任何壳通知可吞。
   */
  shellNotifiedSinceFacts: boolean
}

/** 每来源观测状态（App 以 Map<sourceId, state> 持有；本模块只管其中一份）。 */
export interface SourceObservationState {
  identity: string
  generation: number
  /**
   * 本代首份批次已发生（D4 合并）：G2 基线与 boot 值闩锁同初始（false）、同置位
   * （每批末尾置 true），原 bootReported 与之机械同拍，只保留一个字段——baseline =
   * !baselineDone，boot = baselineDone ? 'same' : pageBoot。identity 变化时整代重建。
   */
  baselineDone: boolean
  /** 壳通道是否已播种（该来源首份壳 report 只播种边沿记忆，绝不 emit——旧 planner 的 prev===undefined 语义）。 */
  shellSeeded: boolean
  factsSeeded: boolean
  /**
   * COR-1 复位旗标（易失）：自上次可用 facts 批以来，壳轨**确实 emit 过**一次
   * 无水位 complete。applyObservationBatch 依 reconcile 结果置位（complete 通知 +
   * 本次新置的 settleFence——置栏正是「无水位消费 emit」的标记），任何**可用**
   * facts 批清位，identity 换代/重建归 false。只有它为真时，显式不可用的 facts 批
   * 才把 factsSeeded 复位成「恢复批必须重新播种」：壳轨在场 / 首报只播种 / 仅 stale
   * （C4-X3 无 complete/ask 边沿）/ 会话不在壳行，都没有壳通知可吞，复位会吸收掉
   * 从未通知过的 observed 水位（COR-1 丢发）。
   */
  shellCompleteSinceFacts: boolean
  /**
   * factsSeeded 因壳侧通知而复位、恢复批尚未到达（易失）：恢复批里仅
   * {@link SessionObservationMemory.shellNotifiedSinceFacts} 为真的会话重新播种，
   * 其余事实轨会话照常按「水位严格前进」产候选——复位不得株连从未通知过的会话。
   */
  factsReseedPending: boolean
  sessions: Record<string, SessionObservationMemory>
  /**
   * 已遗忘（两条通道都不再列出）且尚未重现的会话（易失、FIFO 有界）。重现会话的
   * **首份观测只播种**（不产候选）——§3.2「撤回后的首份上报只播种」的同纪律：
   * forgotten 已清掉该会话的 armed/settleFence/pending（§3.1），若不在观测层播种，
   * 消失前已通知的同一次完成会经壳 completed 边沿或 facts 水位二次通知；播种后
   * **之后的新完成**（重新 running 后的边沿 / 水位严格前进）照常通知。
   * 重现批无可用 facts 水位行的场合，播种被推迟到该会话第一个可用 facts 行
   * （memory.factsSeedPending，F5 重要项 4）。FIFO 淘汰后的重现不播种可能是
   * 一次重复通知（rememberForgotten；F5 次要项 5，有界性优先）。
   */
  forgottenSessions: Set<string>
}

/** 「已遗忘会话」的 FIFO 上界（防长活来源记忆缓慢增长；超限丢最旧键）。 */
export const FORGOTTEN_SESSION_LIMIT = 500

export interface ObservationBatch {
  /** 更新后的状态（调用方写回）。 */
  state: SourceObservationState
  generation: number
  /** identity 与上一代不同（同一来源代内为 false）；true ⇒ 调用方撤回旧 pending。 */
  generationChanged: boolean
  /** 本来源本代的首份状态（账本加载期 pending 的结算点；不做撤回）。 */
  freshState: boolean
  /**
   * 本批**显式携带** facts 输入且不可用（COR-1 同批复位点；手工构造的直测批可
   * 省略 = 不复位）：批末若壳通知旗标为真，把 factsSeeded 复位为「恢复批重新播种」。
   */
  factsUnusable?: boolean
  observations: CompletionObservation[]
  /** 两条通道都不再列出的会话（调用方清 pending，§3.1）。 */
  forgotten: string[]
  /**
   * 本批被播种消费（observed 水位已入 memory）的会话及其吸收水位（F5 重要项 3；
   * A2/A3-3/B3-1 边界化）：播种 = 对「被栏守卫的完成」的等价消费，调用方把它交给
   * complete-ledger.seedSettleFence，按围栏 boundary 裁决清栏 / 记 seededSince
   * （易失轨，不落盘；无栏会话是 no-op）。
   */
  fenceSeeds: FenceSeed[]
}

/** 一次 facts 播种消费：会话 + 本批吸收的 observed 水位。 */
export interface FenceSeed {
  readonly sessionId: string
  readonly watermark: number
}

/** 壳行子代理活动（与 sidebar subagentActivityOf 同规；stale 的 running 降 unknown）。 */
function shellActivityOf(row: ShellObservationRow, stale: boolean): ShellObservationActivity {
  const declared = row.subagentActivity
  const activity = declared !== undefined
    ? declared
    : (row.runningSubagents ?? 0) > 0
      ? 'running'
      : 'none'
  if (stale && activity === 'running') return 'unknown'
  return activity
}

/**
 * 来源代身份：生命周期指纹（壳通道的 fingerprint，也就是 facts 源的化身指纹）+
 * 页代 boot token。两条通道必须用**同一个** identity，否则 generation 会在通道
 * 之间来回跳（G1 会把对方整批丢弃）。
 */
export function completionIdentity(fingerprint: string | undefined, bootToken: string): string {
  return (fingerprint ?? '') + '\u0000' + bootToken
}

/** facts 快照 → 通道输入（v5 §3.2 factsUsable = ok && serviceable && !stale）。 */
export function factsChannelOf(snapshot: SessionFactsSnapshot | undefined): FactsChannelInput | undefined {
  if (snapshot === undefined) return undefined
  return {
    rows: snapshot.rows,
    usable: snapshot.verdict === 'ok' && snapshot.serviceable !== false && snapshot.stale !== true,
  }
}

/** 完成水位的严格前进判定（factsWatermark 记忆只在 observed 行上推进）。 */
function factsWatermarkOf(row: FactsObservationRow): number | undefined {
  if (row.completedAtSource !== 'observed' || row.completedAt === null) return undefined
  return completionWatermark(row)
}

/**
 * 记一个已遗忘会话（同键移到队尾；超限 FIFO 淘汰最旧键）。
 *
 * 有界性优先（F5 次要项 5）：极端 churn（同一来源在记忆窗口内遗忘超过 500 个不同
 * 会话）下最旧键被淘汰，该会话重现时不再播种——若它消失前已由壳边沿通知、facts
 * 之后又报告同一完成（水位 > 0 且 armed 已被遗忘清掉），会重复通知一次。这是
 * 「有界易失记忆」换来的已登记极端取舍（design 会登记）：不做无界水位缓存；
 * 正常 churn 下（同一来源同时遗忘会话数 < 500）不会触发。
 */
function rememberForgotten(sessions: Set<string>, sessionId: string): void {
  sessions.delete(sessionId)
  sessions.add(sessionId)
  while (sessions.size > FORGOTTEN_SESSION_LIMIT) {
    const oldest = sessions.values().next()
    if (oldest.done === true) break
    sessions.delete(oldest.value)
  }
}

/**
 * 组装一份来源观测批次。
 *
 * @param input.state - 上一次的观测状态（无 = 本来源本代首见；freshState=true）。
 * @param input.identity - 来源代身份（生命周期指纹 + 页代 boot token）。
 * @param input.pageBoot - 页代判定（'fresh' 只随本代首份观测下发：reconcile 的
 *   §3.5 防御分支只在“加载期本应已丢弃 pending”的场合生效，绝不吞本页新建的 pending）。
 * @param input.shellReport - 本批是否由**新的壳 report** 触发（false = 只是 facts
 *   更新时复用当前壳行做权威合并）。壳边沿只在 report 批上裁决，且该来源首份
 *   report 只播种（见 {@link SourceObservationState.shellSeeded}）。
 */
export function observeSource(input: {
  state?: SourceObservationState
  sourceId: string
  identity: string
  pageBoot: 'same' | 'fresh'
  shell?: ShellChannelInput
  shellReport?: boolean
  facts?: FactsChannelInput
}): ObservationBatch {
  const freshState = input.state === undefined
  const generationChanged = !freshState && input.state!.identity !== input.identity
  const state: SourceObservationState = freshState || generationChanged
    ? {
        identity: input.identity,
        generation: (freshState ? 0 : input.state!.generation) + 1,
        baselineDone: false,
        shellSeeded: false,
        factsSeeded: false,
        shellCompleteSinceFacts: false,
        factsReseedPending: false,
        sessions: {},
        forgottenSessions: new Set<string>(),
      }
    : input.state!

  const baseline = !state.baselineDone
  const boot: 'same' | 'fresh' = state.baselineDone ? 'same' : input.pageBoot
  const shellStale = input.shell?.stale === true
  const shellRows = input.shell?.rows ?? {}
  // facts 不可用（stale / degraded / serviceable=false）只是 unknown 维度，绝不等价于
  // 缺席：在场判定必须用**原始通道行键**，否则断连/降级时全部会话被当作消失，held 的
  // 目标完成被静默清掉（评审 B2）。
  const factsChannelRows = input.facts?.rows ?? {}
  const factsUsable = input.facts?.usable === true
  const factsRows = factsUsable ? factsChannelRows : {}
  // 恢复批重播种（B3-2）与 COR-1 复位精度：本批**显式携带** facts 输入但不可用
  // （stale / degraded / serviceable=false），且**壳轨确实已 emit 过**一次无水位
  // complete（state.shellCompleteSinceFacts，由 applyObservationBatch 依 reconcile
  // 结果置位）⇒ factsSeeded 复位，恢复后的首个可用批重新成为播种批（吸收水位、
  // 不产候选）。不可用窗口内壳轨已通知的完成，facts 追平时水位会严格前进；不重
  // 播种就会以「已播种 + 水位前进」产出候选 ⇒ 二次通知（B3-2 吞发语义保持）。
  // 复位条件**只看旗标**，不再看「壳轨在场 / shellSeeded」（COR-1 精度）：壳轨在
  // 场但从未通知的三种形态都不得复位——①壳轨首报恰落在 stale 窗口与恢复之间
  // （首报只播种）；②壳轨仅 stale（C4-X3 关闭 complete/ask 边沿）；③会话只在
  // facts 行、不在壳行。无壳轨（facts-only）同样不复位，保留候选资格：恢复批照常
  // 按「水位严格前进」产出候选并通知。纯壳批（facts undefined）与可用批都不得
  // 复位；**同批**壳通知的复位由 applyObservationBatch 在批末补做（observeSource
  // 是纯函数，看不到本批 reconcile 结果）。
  if (input.facts !== undefined && !factsUsable && state.shellCompleteSinceFacts) {
    // 只有确实复位了「已播种」状态才挂恢复播种位：从未播种（factsSeeded 本为 false）
    // 的来源，恢复批仍是本代首份可用批次，G2 对全体会话照常播种（不得被 per-session
    // 候选资格越过——那会把离线旧完成当窗口内新完成补发）。
    if (state.factsSeeded) state.factsReseedPending = true
    state.factsSeeded = false
  }
  // 本代 facts 播种批（factsSeeded false→true 的那一批）：该批吸收的水位就是
  // 「播种 = 对同一完成的等价消费」，其 settleFence 必须随播种清除（F5 重要项 3）。
  const factsSeedingNow = factsUsable && !state.factsSeeded
  const present = new Set<string>([...Object.keys(shellRows), ...Object.keys(factsChannelRows)])

  // §3.1：两条通道都不再列出的会话 ⇒ 遗忘（调用方清 armed/fence/pending，并在
  // 重现时按 forgottenSessions 播种首观测）。
  const forgotten: string[] = []
  for (const sessionId of Object.keys(state.sessions)) {
    if (present.has(sessionId)) continue
    delete state.sessions[sessionId]
    rememberForgotten(state.forgottenSessions, sessionId)
    forgotten.push(sessionId)
  }

  const observations: CompletionObservation[] = []
  const fenceSeeds: FenceSeed[] = []
  for (const sessionId of [...present].sort()) {
    const shellRow = shellRows[sessionId]
    const factsRow = factsRows[sessionId]
    // 重现会话：本批只播种（候选生成见下）；删除条目即消费这条重现记忆。
    const reappearing = state.forgottenSessions.delete(sessionId)
    const memory: SessionObservationMemory = state.sessions[sessionId] ?? {
      shellRunning: 'unknown',
      shellCompleted: false,
      factsWatermark: 0,
      factsSeedPending: false,
      shellNotifiedSinceFacts: false,
    }
    // goal 三值：壳行优先（生产者已回填最后已知），facts 行兜底；全缺席 = unknown。
    const goal: GoalFactObservation = shellRow?.goal !== undefined
      ? shellRow.goal
      : factsRow?.goal !== undefined
        ? factsRow.goal
        : 'unknown'

    // running 权威（v5 §3.2）：新鲜壳行 ⇒ 壳；否则非 stale facts ⇒ facts；否则 unknown。
    const shellRunning: RunningObservation = shellRow === undefined
      ? 'unknown'
      : shellRow.running === true
        ? 'running'
        : shellRow.running === false
          ? 'idle'
          : 'unknown'
    const factsRunning: RunningObservation = factsRow === undefined
      ? 'unknown'
      : factsRow.running ? 'running' : 'idle'
    const shellFresh = !shellStale && shellRunning !== 'unknown'
    const running: RunningObservation = shellFresh
      ? shellRunning
      : factsRow !== undefined && factsUsable
        ? factsRunning
        : 'unknown'

    // 本会话本批吸收的 facts 水位（播种/常规同一口径；I1 running 权威下不吸收——
    // 候选必须保持可重提）。emit 的 factsMemory 用它：播种批把本批刚吸收的水位计入
    // （播种消费的正是被栏守卫的完成），普通批是「候选自身水位尚未吸收」的下界。
    const rowWatermark = factsUsable && factsRow !== undefined ? factsWatermarkOf(factsRow) : undefined
    const factsMemory = rowWatermark !== undefined && (reappearing || memory.factsSeedPending || running !== 'running')
      ? maxWatermarkValue(memory.factsWatermark, rowWatermark)
      : memory.factsWatermark

    // 子代理：壳行按运行证据（stale 降 unknown）；facts-only 忽略 subagentCount。
    const subagents: SubagentObservation = shellRow !== undefined
      ? (() => {
          const activity = shellActivityOf(shellRow, shellStale)
          return activity === 'running' ? 'busy' : activity === 'none' ? 'idle' : 'unknown'
        })()
      : factsRow !== undefined && factsUsable
        ? (factsRow.subagentCount > 0 ? 'unknown' : 'idle')
        : 'unknown'

    // 候选：complete 至多一个（归属过滤），ask/request 各自独立。重现会话的首份观测
    // 只播种（§3.2 首报语义）：消失前已通知的同一完成不得双发；之后的新完成照常
    // （facts 水位在下面按本行推进，下一份更高水位才成候选；壳边沿记忆同步刷新）。
    const candidates: CompletionCandidate[] = []
    // 重现待决位（F5 重要项 4）：第一个可用 facts 行只播种，绝不再产候选——否则消失前
    // 已由壳通知的同一完成会二次通知。
    // COR-1 精度：复位后的恢复批是播种批（state.factsSeeded=false），但只对**确实
    // 通知过**的会话重新播种（per-session 旗标）；其余会话从未有壳通知可吞，照常按
    // 水位严格前进产候选——复位不得株连它们（facts-only 会话的完成不得被永久丢发）。
    if (!reappearing && !memory.factsSeedPending && factsUsable && factsRow !== undefined) {
      const watermark = factsWatermarkOf(factsRow)
      const candidateEligible = state.factsSeeded
        || (state.factsReseedPending && !memory.shellNotifiedSinceFacts)
      if (candidateEligible && watermark !== undefined && watermark > memory.factsWatermark) {
        candidates.push({ kind: 'complete', watermark, evidence: 'facts-watermark' })
      }
    }
    // C4-X3：stale 壳快照不得作运行证据——complete 与 ask/request 边沿整体关闭
    // （行记忆照常推进，stale true→false 的同一行不得凭旧位伪造边沿）。
    const shellEdgeEligible = !shellStale && !reappearing && input.shellReport === true && state.shellSeeded
    if (shellEdgeEligible && shellRow !== undefined && !factsUsable) {
      const runningEdge = memory.shellRunning === 'running' && shellRunning === 'idle'
      const completedEdge = memory.shellCompleted !== true && shellRow.completed === true
      if (runningEdge || completedEdge) candidates.push({ evidence: 'shell-edge' })
    }
    if (shellEdgeEligible && shellRow !== undefined && shellRow.pending !== undefined && memory.shellPending !== shellRow.pending) {
      candidates.push({
        kind: shellRow.pending === 'question' ? 'ask' : 'request',
        evidence: 'shell-edge',
      })
    }

    const emit = (candidate?: CompletionCandidate): void => {
      observations.push({
        sourceId: input.sourceId,
        sessionId,
        generation: state.generation,
        running,
        subagents,
        goal,
        ...(candidate === undefined ? {} : { candidate }),
        baseline,
        boot,
        factsMemory,
      })
    }
    if (candidates.length === 0) emit()
    else for (const candidate of candidates) emit(candidate)

    // 记忆推进（行消失的壳位清空：重新出现不得从旧位伪造完成边沿）。
    if (shellRow !== undefined) {
      memory.shellRunning = shellRunning
      memory.shellCompleted = shellRow.completed === true
      memory.shellPending = shellRow.pending
    } else {
      memory.shellRunning = 'unknown'
      memory.shellCompleted = false
      delete memory.shellPending
    }
    if (reappearing) {
      // 重现播种：本行在场的完成水位记为已见（窗口内完成不补发，且不依赖 notified
      // 水位——壳证据的通知没有水位可依）；running 也不保留重提空间（与 I1 相反：
      // 那条完成属于消失窗口，之后的新完成必然是更高水位）。
      // 若无可用 facts 水位行（通道不可用 / 行缺席 / 非 observed），挂 per-session
      // 播种待决位（F5 重要项 4）：facts 后到的同一完成只播种，不二次通知。
      // 取舍（design 19 §3.2.4 已接受，F5 次要项 6）：播种会吞掉消失窗口内真正的新
      // 完成——离线不补发；本修复不改变该语义。
      const watermark = factsUsable && factsRow !== undefined ? factsWatermarkOf(factsRow) : undefined
      if (watermark !== undefined) {
        memory.factsWatermark = maxWatermarkValue(memory.factsWatermark, watermark)
        memory.factsSeedPending = false
        fenceSeeds.push({ sessionId, watermark })
      } else {
        memory.factsSeedPending = true
      }
    } else if (memory.factsSeedPending) {
      // 重现后的首个可用 facts 行：只播种（不产候选），水位入 memory 后清除待决位。
      // **只有真正吸收 observed 水位的那一行才算播种消费**（A3-1 修复）：行可用但
      // completedAt=null / 无 observed 水位时待决位必须保留——否则下一行 100 会以
      // 「已播种 + 水位严格前进」产出候选，消失前已由壳通知的同一完成二次通知。
      // 播种 = 对同一完成的等价消费，围栏一并清（携带被吸收的水位）。
      if (factsUsable && factsRow !== undefined) {
        const watermark = factsWatermarkOf(factsRow)
        if (watermark !== undefined) {
          memory.factsWatermark = maxWatermarkValue(memory.factsWatermark, watermark)
          memory.factsSeedPending = false
          fenceSeeds.push({ sessionId, watermark })
        }
      }
    } else if (factsUsable && factsRow !== undefined && running !== 'running') {
      // I1（Wave6）**契约**（design 19 §3.2.3 已落地，与本实现逐字一致）：running 权威为
      // running 时**不得**消费 facts 水位记忆（不推进 memory.factsWatermark、不吸收进
      // pending），候选保持可重提——两通道可能相差一个 commit（facts 已报完成、壳仍停在
      // 上一回合的 running），此刻 reconcile 会按 running 早退丢弃候选；若这里已推进水位，
      // 壳追平 idle 后候选永不重提（丢发）。保持水位不推进 ⇒ 候选在后续观测中持续重提；
      // 真正的新回合以更高水位覆盖它。相邻的 C4-X2 播种块对「被 I1 挡下的水位」只登记
      // 围栏播种补偿（吞一次已由壳边沿通知的同一完成），不改这条不吸收契约。
      const watermark = factsWatermarkOf(factsRow)
      if (watermark !== undefined) {
        memory.factsWatermark = maxWatermarkValue(memory.factsWatermark, watermark)
        // 本代首份可用 facts 批的推进 = 播种（F5 重要项 3；A2/A3-3/B3-1 边界化）：
        // 把吸收水位交给调用方按围栏 boundary 裁决（清栏 / 记 seededSince）。
        if (factsSeedingNow) fenceSeeds.push({ sessionId, watermark })
      }
    }
    // C4-X2：恢复播种批（factsSeeded false→true）里「本批没有可吸收 observed 水位」的
    // 在场会话也要登记围栏播种——两种形态都算：(a) 行的 completedAt 仍 null / 非 observed
    // （在途快照），(b) 行带 observed 水位但被 I1 挡下（running 权威 = running，本批不
    // 吸收）。反例：facts 不可用期间壳边沿通知完成（置栏）→ 恢复批含该行但水位尚不可
    // 消费 → 不登记时同一完成的水位 100 到达会被围栏按「无播种补偿」判成新完成（rule ③）
    // ⇒ 二次通知。这里没有可吸收的 observed 水位，播种水位取本批之前的
    // memory.factsWatermark（= 置栏后已吸收水位；恒 ≤ 栏 boundary，见 seedFenceSession），
    // 语义是「被栏守卫的完成尚未在 facts 侧被消费」；之后首个严格更高的 observed 水位按
    // 围栏 seededSince 规则吞一次。无栏会话是 no-op（seedSettleFence 无栏即返回），
    // 正常新完成（无论有无围栏）不受影响。
    // 边界（实现口径）：facts 行**完全缺席**（会话仅经壳在场）同样落到 rowWatermark
    // === undefined，按上面同一语义登记；文档 §3.2.3 的「行在场但 completedAt 非 observed
    // / 无水位行」按「该会话本批无可用水位」读，含行缺席。正/负用例见
    // completion-observation.test.ts 的 REGRESSION(C4-X2 行缺席)。
    if (factsSeedingNow && !reappearing && !memory.factsSeedPending && (rowWatermark === undefined || running === 'running')) {
      fenceSeeds.push({ sessionId, watermark: memory.factsWatermark })
    }
    // 已知边界（跨批 C4-X2 / I1；design 19 §3.2.7 第 ⑥ 条已登记）：播种登记只对
    // **同一批**的 #1 running 有 keepFence 豁免。若新回合的 running 观测在另一批先到，
    // 栏已在那里被清掉，本批登记无栏可依（seedSettleFence no-op）——facts 侧迟到的被守卫
    // 完成水位会二次通知（V5-B：2 个物理完成 / 3 条通知，KNOWN-BOUNDARY 用例钉住）。
    // 闭合需要围栏跨 running 批存活，但没有完成身份时同一栏可能吞掉真实新完成；
    // **消除需要完成身份（上游只读）**，见 notification-projection.applyRunningAuthority 注释。
    state.sessions[sessionId] = memory
  }

  if (input.shellReport === true) state.shellSeeded = true
  if (factsUsable) {
    // COR-1：可用 facts 批是壳通知旗标的清点（不可用窗口结束）。恢复批的候选/播种
    // 判定已经用掉当时的旗标，此处统一回到「已播种」。
    state.factsSeeded = true
    state.factsReseedPending = false
    state.shellCompleteSinceFacts = false
    for (const memory of Object.values(state.sessions)) memory.shellNotifiedSinceFacts = false
  }
  // 本代第一份**批次**即为该来源的基线（即便本批零行）：per-channel 播种
  // （shellSeeded/factsSeeded）已在候选发现前生效，首份带行报告里的既存
  // completed 不会产生候选；空首帧之后**在线**完成的会话（本批首见即
  // completed）不得被 G2 误吞——原 shell 边沿语义在此放行。
  state.baselineDone = true
  return {
    state,
    generation: state.generation,
    generationChanged,
    freshState,
    factsUnusable: input.facts !== undefined && !factsUsable,
    observations,
    forgotten,
    fenceSeeds,
  }
}

/** 一条通知 + 独立处置计数 + 落盘需求的收敛出口（App/桥各实现一份，语义同一）。 */
export interface CompletionSink {
  emitNotification(notification: PlannedNotification, result: CompletionReconcileResult): void
  countDisposition(outcome: CompletionDisposition): void
  /** immediate=true ⇒ flushUnread（flush/清 pending 立即持久化，TL3）。 */
  persist(immediate: boolean): void
}

/** 清掉账本已记录的来源代（写时复制；G1 门放行新一代）。 */
function resetRecordedGeneration(ledger: CompleteLedger, sourceId: string): void {
  const state = ledger.state()
  if (state.generation[sourceId] === undefined) return
  const next = { ...state.generation }
  delete next[sourceId]
  state.generation = next
}

/**
 * 把一批观测交给唯一收敛器（INV6：每份观测都跑 pending 结算），并统一处置：
 *  - generationChanged ⇒ withdraw(sourceId)（清 armed + pending，notified/outcomes durable）
 *    并放行新一代；
 *  - forgotten ⇒ 逐会话 forgetSession（armed + settleFence + pending，评审 A 重要项）；
 *  - notification(s) ⇒ 唯一 emit 出口（一份观测可同时产出结算与 ask/request 两条）；
 *  - disposition ⇒ notificationLedger 的独立计数（held/flushed/voided/dropped/deferred）；
 *  - 有变更就落盘；flush/撤回/会话消失**立即** flush，voided/dropped 这类「pending
 *    已作废/静默结清」的 durable 结算同样立即（§3.5 写点纪律；1s 节流窗口内的崩溃
 *    重放不得复活已作废的 pending）。
 */
export function applyObservationBatch(input: {
  ledger: CompleteLedger
  sourceId: string
  batch: ObservationBatch
  sink: CompletionSink
  now?: number
}): void {
  const { ledger, sourceId, batch, sink } = input
  let immediate = false
  if (batch.generationChanged) {
    ledger.withdraw(sourceId)
    resetRecordedGeneration(ledger, sourceId)
    immediate = true
  }
  if (batch.freshState) {
    // 调用方已丢失转移记忆（通道撤回 completionObservationRef.delete / 来源退役重建）：
    // 账本里的上一份代际记录不得把新一代观测整批丢在 G1 门外——否则同 id 恢复后
    // reconcile 永远收不到候选（freshState 的代际号从 1 重新起算，旧记录可能是 2+）。
    resetRecordedGeneration(ledger, sourceId)
  }
  if (batch.forgotten.length > 0) {
    // 会话从两条通道消失与来源撤回同纪律（只收窄到单会话）：只清 pending 会让残留的
    // armed/settleFence 在会话重现后静默吞掉新完成（评审 A 重要项）。
    for (const sessionId of batch.forgotten) ledger.forgetSession(sourceId, sessionId)
    immediate = true
  }
  if (batch.fenceSeeds.length > 0) {
    // facts 播种 = 对同一完成的等价消费（F5 重要项 3；A2/A3-3/B3-1 边界化）：把本批
    // 吸收的水位交给账本按围栏 boundary 裁决——> boundary 清栏（播种已吸收被守卫的
    // 完成），否则记 seededSince 并保留（其后首条更高候选吞一次）。易失轨，无需落盘。
    for (const seed of batch.fenceSeeds) ledger.seedSettleFence(sourceId, seed.sessionId, seed.watermark)
  }
  // 同批播种证据（C4-X2 / I1 hold）：本批为这些会话登记了 fenceSeed，其观测的
  // `#1 running 权威` 清栏必须跳过它们——播种批的落账先于观测结算，否则同一批的
  // 「facts 恢复 + 新回合 running」会把刚登记播种补偿的栏整条清掉（栏等同于没种，
  // 被守卫的完成随后从 facts 侧二次上报）。keepFence 只随本批播种集传递：同一观测
  // 单独重放时没有它，running 清栏语义不变。
  const fenceSeedSessions = new Set(batch.fenceSeeds.map(seed => seed.sessionId))
  let dirty = immediate
  for (const observation of batch.observations) {
    const state = ledger.state()
    // §3.5 写点纪律：reconcile 的**每次 durable 变更**都必须落盘——包括不产生
    // disposition 的纯吸收（#5/#6 keep 时的水位吸收、G5 armed 门的单调记事、
    // ask/request 的 notified 推进）。三张 durable 表全部写时复制，引用变化即
    // 变更证据；只按 disposition 记账会让这些写点丢到页面关闭才落盘（TL3）。
    const notifiedBefore = state.notified
    const pendingBefore = state.pending
    const outcomesBefore = state.outcomes
    // COR-1 精度（结果可达路径）：置栏是**无水位消费 emit** 的标记——reconcile 的
    // setFenceForNoWatermarkConsumption 只在 consumedWatermark === undefined 时写栏
    // （facts 候选消费水位不置栏），releaseDeferred 亦只在 pending.watermark 缺席时
    // 置栏。前后引用对比即「本次 reconcile 新置/覆盖了栏」。
    const fenceBefore = state.settleFence[sourceId]?.[observation.sessionId]
    const result = reconcile(
      state,
      observation,
      input.now,
      fenceSeedSessions.has(observation.sessionId) ? { keepFence: true } : undefined,
    )
    if (state.notified !== notifiedBefore || state.pending !== pendingBefore || state.outcomes !== outcomesBefore) {
      dirty = true
    }
    // 一份观测可产出两条通知（ask/request 直通 + pending 结算）；单通知结果保持原样。
    const notifications = result.notifications
      ?? (result.notification === undefined ? [] : [result.notification])
    for (const notification of notifications) sink.emitNotification(notification, result)
    // COR-1 复位旗标：本份观测产出了 complete 通知，且本次 reconcile 新置/覆盖了该
    // 会话的 settleFence ⇒ 一次无水位（壳证据）的完成确实被通知（hold/void/drop/
    // 静默结清都不 emit，不置旗标）。只置旗标；把 factsSeeded 复位留到批末——
    // observeSource 是纯函数，看不到本批 reconcile 结果（B3-2 同批形态）。手工
    // 构造的直测批可无 state，跳过（它们的壳语义由 reconcile 直测钉住）。
    const completeEmitted = notifications.some(notification => notification.kind === 'complete')
    const fenceAfter = state.settleFence[sourceId]?.[observation.sessionId]
    if (completeEmitted && fenceAfter !== undefined && fenceAfter !== fenceBefore && batch.state !== undefined) {
      batch.state.shellCompleteSinceFacts = true
      const memory = batch.state.sessions[observation.sessionId]
      if (memory !== undefined) memory.shellNotifiedSinceFacts = true
    }
    if (result.disposition !== undefined) {
      sink.countDisposition(result.disposition)
      // flush/撤回/会话消失已由各自分支置 immediate；voided（#1 作废）与 dropped
      // （#3/静默结清/结算守卫）同样删除 pending 并推进 notified——若落在 1s 节流
      // 窗口内崩溃，重放会复活已作废的 pending，必须立即落盘。
      if (
        result.disposition === 'flushed'
        || result.disposition === 'voided'
        || result.disposition === 'dropped'
      ) {
        immediate = true
      }
      dirty = true
    }
  }
  // COR-1 同批复位（B3-2 语义保持）：本批显式携带不可用 facts 且旗标此刻为真
  // （含本批刚置位）⇒ 批末复位播种位，恢复批重新播种；确实通知过的会话不双发。
  // 旗标为本批之前置位的形态已由 observeSource 的复位块处理，这里幂等补做。
  if (batch.factsUnusable === true && batch.state !== undefined && batch.state.shellCompleteSinceFacts) {
    if (batch.state.factsSeeded) batch.state.factsReseedPending = true
    batch.state.factsSeeded = false
  }
  if (dirty) sink.persist(immediate)
}

/**
 * 观测状态删除（调用方从 completionObservationRef 删除该来源时的同拍收敛）。
 *
 * WHY（FINAL-C）：观测状态删除 = 该来源的观测代终结（下一批 freshState 从代际 1
 * 重新起算），但账本里的旧代易失轨与 pending 不随状态删除消失——门关窗口
 * （未结算 / degraded / rosterIncomplete）下 durable 剪枝不会执行，残留的旧 pending
 * 会被重建的新代首个 outcome 以旧 watermark flush。删除路径必须同步 **scoped
 * withdraw**：armed / armedFloor / settleFence / goalKnown / pending 同拍清；
 * notified / outcomes 保持 durable（与通道撤回同语义——来源可能只是门关窗口内的
 * roster 缺口，不是退役，故不能走 forget 删 durable）。
 *
 * 注意：**不能**把清理挂到 batch.freshState 上——页面重载（boot='same'）时观测
 * 状态本就是 fresh，而账本 pending 是从磁盘载入的合法待结算身份（TL3），清掉即丢
 * 一次完成。清理只属于「状态被主动删除」这一调用面（App 剪枝 effect / retireSources
 * 的易失轨纪律；后者已走 ledger.forget）。
 *
 * @returns pending 是否存在（true ⇒ 调用方必须排一次落盘，否则旧 pending 会从磁盘复活）。
 */
export function withdrawObservationState(ledger: CompleteLedger, sourceId: string): boolean {
  const hadPending = ledger.pendingTable()[sourceId] !== undefined
  ledger.withdraw(sourceId)
  return hadPending
}

export type { NotificationKind }
