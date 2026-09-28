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
 *    水位严格前进；壳候选 = running true→idle（官方 completed 位在通道行上，但**不**构成通知边沿），且
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
import { isFactsDecisionUsable, type SessionFactsSnapshot, type SessionFactsTurnEnd } from './session-facts-source.ts'
import { completionWatermark, maxWatermarkValue } from './watermark.ts'

/** 壳行 pending 种类（InstanceRuntimeReport 的结构子集）。 */
export type ShellObservationPending = 'approval' | 'plan-review' | 'question'
/** 子代理活动三值（与 sidebar session-row-state 同词表）。 */
export type ShellObservationActivity = 'none' | 'running' | 'unknown'

/** 壳运行时行（InstanceRuntimeReport.sessions 的结构子集）。
 *  `completed` 刻意不在此声明：通知边沿只认运行位，官方完成位由呈现面消费
 *  （行为锁见 completion-observation.test.ts 的 CONTROL 用例）。 */
export interface ShellObservationRow {
  running?: boolean
  pending?: ShellObservationPending
  runningSubagents?: number
  subagentActivity?: ShellObservationActivity
  goal?: GoalFact | null
  /** I3 修正 provenance：本行 running 刚被侧栏权威写回压假（非宿主完成）。 */
  corrected?: boolean
}

/** facts 行（session-facts-source.SessionFactsRow 的判定输入子集）。 */
export interface FactsObservationRow {
  sessionId: string
  running: boolean
  completedAt: number | null
  completedAtSource: 'observed' | 'reconstructed' | null
  /** 时钟域（可缺省 = host）：'observer' 的 observed 时刻不在 host 域，不具备通知资格（W2）。 */
  completedAtDomain?: 'host' | 'observer' | null
  updatedAt: number
  subagentCount: number
  /** I-12 谱系认证位（mux 完整基线重算过）：只有它在场，`subagentCount` 才是子代理证据。 */
  lineageVerified?: boolean
  /** I-12 压制表命中（保留谱系表里有 durable 子代）：认证位缺席时按 busy 处理（fail-closed）。 */
  subagentKnown?: boolean
  goal?: GoalFact | null
  /**
   * 宿主 `turn/end`（W2 身份）：**只读判别符**——`seq` 产出运行身份 `host:turn/<seq>`；
   * 不参与可判性、水位或完成证据判定（那些只看 completedAt/updatedAt/completedAtSource）。
   */
  lastTurnEnd?: SessionFactsTurnEnd | null
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
  shellPending?: ShellObservationPending
  factsWatermark: number
  /**
   * 已**见**水位（≠ 已消费水位）：facts 通道在**可用**批里读到过的最高 observed 水位，
   * 含被 I1 挡下、不吸收进 memory.factsWatermark 的那些行。它唯一的用途是给 R2 的
   * 「事件型证据」判新鲜度：一条 raw host 域 observed 行只有严格新于「本批之前已见水位」
   * 才可能是此刻这条边沿的完成——否则它只是把上一轮读过的旧完成再搬出来（旧口径下
   * 这种行正是壳边沿的无水位语义，不能被 facts 侧抢先认领）。
   */
  factsSeenWatermark: number
  /**
   * 已经**消费**过的最高宿主判别符（turn/end.seq）。锚是完成的身份：同一个 seq 只能归属一条
   * 完成。壳边沿块里一条新鲜锚**在场即记账**（无论本批是否真的成边沿）：行停在旧 turn/end
   * （facts 通道持续不可用）时，晚到的下一条壳边沿会再借同一个 seq ⇒ 两轨身份相等 ⇒ 身份门
   * 把真实新完成当"已显示"吞掉（静默漏发）。宁可在没有边沿的批里提前消费，也不复用身份。
   */
  lastAnchoredSeq: number
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

/**
 * facts 快照 → 通道输入（v5 §3.2）。`usable` 走 session-facts-source 拥有的唯一可判谓词
 * （ok && serviceable!==false && !stale）——本文件不再内联第二份规则。
 */
export function factsChannelOf(snapshot: SessionFactsSnapshot | undefined): FactsChannelInput | undefined {
  if (snapshot === undefined) return undefined
  return { rows: snapshot.rows, usable: isFactsDecisionUsable(snapshot) }
}

/** 完成水位的严格前进判定（factsWatermark 记忆只在 observed 行上推进）。 */
function factsWatermarkOf(row: FactsObservationRow): number | undefined {
  if (row.completedAtSource !== 'observed' || row.completedAt === null) return undefined
  return completionWatermark(row)
}

/**
 * W2 完成证据（候选专用）：只有 **host 域、observed 的 turn/end 时刻**才算一次完成。
 *
 * WHY：`factsWatermarkOf` 取 `completionWatermark(row) = max(completedAt, updatedAt)`——它是
 * **内容水位**（记忆/围栏用），把 updatedAt 的活动前进也算成"更高水位"。候选若用它，一条
 * 老完成 + 新活动（或权威运行位抖动）就会重提一次"完成"，实测正是假通知的形状。
 * observer 域的 `reconstructed` 时刻不在 host 域（design 19：不作通知证据），同样不是证据。
 */
function factsCompletionOf(row: FactsObservationRow): number | undefined {
  if (row.completedAtSource !== 'observed' || row.completedAt === null) return undefined
  if (row.completedAtDomain === 'observer') return undefined
  return row.completedAt > 0 ? row.completedAt : undefined
}

/**
 * 壳完成边沿可继承的宿主判别符（R1）：`hostCompletion`（调用点已解析的 host 域 observed
 * 完成水位）与 `seq`（同一行上的 `turn/end.seq`）。带锚 ⇒ 壳轨与 facts 轨产出**同一个**
 * `host:turn/<seq>` 身份（跨通道幂等）；不带锚 ⇒ 候选无 completionSeq，身份层发页内 nonce
 * （唯一、不共享），代价是最坏一次跨通道重复，而不是静默互吞。
 *
 * 两道门都必须过，缺一即漏发：
 * ① 完成水位严格新于「已见水位与已消费水位的较大者」——行上锚点属于**尚未被读过**的那次
 *    完成，才可能是此刻这条边沿的完成；已消费（含 R2 在不可用批的投递）或已见（I1 挡下未
 *    吸收）的旧锚若被借出，会把这次完成误认成上一轮。
 * ② `seq` 严格大于已消费的最高 seq（`memory.lastAnchoredSeq`）——行没有前进时
 *    （facts 持续不可用、turn/end 停在旧值），下一条边沿不得复用同一个宿主事件序：复用会让
 *    两轨身份相等，身份门按"已显示"吞掉真实新完成。宁可无锚发 nonce（最坏重复，不漏）。
 *
 * 调用点收口：本函数只在 `shellEdgeEligible && !factsUsable && !factsContradictsIdle` 的块里
 * 被调用（该块保证行不 running），且 `hostCompletion` 缺席直接短路——行缺席 / 行仍 running
 * 两种情形不在这里重复判定。
 */
function shellEdgeCompletionSeq(
  hostCompletion: number | undefined,
  seq: number | undefined,
  seenWatermark: number,
  lastAnchoredSeq: number,
): number | undefined {
  if (hostCompletion === undefined || hostCompletion <= seenWatermark) return undefined
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined
  return seq > lastAnchoredSeq ? seq : undefined
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
    // 原始 facts 行（不可用时仍在场，评审 B2 的键空间）：反证守卫读最后已知的 host 内容。
    const factsChannelRow = factsChannelRows[sessionId]
    // 本批是否已由 facts（带锚）候选发出该完成：壳边沿不再重复发同一完成。
    let factsCandidatePushed = false
    // 重现会话：本批只播种（候选生成见下）；删除条目即消费这条重现记忆。
    const reappearing = state.forgottenSessions.delete(sessionId)
    const memory: SessionObservationMemory = state.sessions[sessionId] ?? {
      shellRunning: 'unknown',
      factsWatermark: 0,
      factsSeenWatermark: 0,
      lastAnchoredSeq: 0,
      factsSeedPending: false,
      shellNotifiedSinceFacts: false,
    }
    // R2 候选行（design 19 §3.2.3 逐观察可判性）：快照可判时就是普通行；不可判时仍取**原始
    // 行**——只要它带 host 域 observed 的 turn/end（factsCompletionOf 非 undefined），这次完成
    // 就自带判别符，不需要一份可用基线来"背书"。新鲜度门（不是快照门）：这条 raw 行必须严格
    // 新于**本批之前已见水位**，否则它只是上一轮读过的旧完成（I1 挡下未吸收的行、播种批的行
    // 都属此类），此时语义仍是壳边沿。
    const seenBefore = memory.factsSeenWatermark
    // 宿主域完成证据（facts 域 observed 的 `completedAt`）本批**只解析一次**：R2 的原始行准入、
    // I3 修正门与 R1 锚继承同读这一个值——三处判据不会各自漂移，I3/R1 的互斥也是结构性的
    // （无证据 ⇒ corrected 门成立且锚选择短路），不再由注释声明"互斥"。
    const hostCompletion = factsChannelRow === undefined ? undefined : factsCompletionOf(factsChannelRow)
    const factsCandidateRow = factsUsable
      ? factsRow
      : hostCompletion !== undefined && hostCompletion > seenBefore ? factsChannelRow : undefined
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

    // 子代理：壳行按运行证据（stale 降 unknown——残留计数**不是** busy 证据，契约测试钉住）。
    // facts-only（I-12）：只有谱系已认证的行才作证据——认证过的 0 = idle（首次可证明「无
    // 子代理」），认证过的 >0 = busy（抑制完成）；认证位缺席但保留表里有 durable 子代 =
    // fail-closed busy（「列表不完整」不得读成「子代理结束」）；其余（watcher 来源）保持
    // 旧口径：count>0 仅作 presence（unknown），永不作 busy 证据。
    const subagents: SubagentObservation = shellRow !== undefined
      ? (() => {
          const activity = shellActivityOf(shellRow, shellStale)
          return activity === 'running' ? 'busy' : activity === 'none' ? 'idle' : 'unknown'
        })()
      : factsRow !== undefined && factsUsable
        ? (factsRow.lineageVerified === true
            ? (factsRow.subagentCount > 0 ? 'busy' : 'idle')
            : factsRow.subagentKnown === true
              ? 'busy'
              : factsRow.subagentCount > 0 ? 'unknown' : 'idle')
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
    if (!reappearing && !memory.factsSeedPending && factsCandidateRow !== undefined) {
      // W2：候选水位 = host 域 turn/end 时刻；记忆/围栏仍用内容水位（activities 只推记忆）。
      const watermark = factsCompletionOf(factsCandidateRow)
      // W2 身份：宿主 `turn/end.seq` 与完成时刻同为 host 域判别符——带上它，运行身份即可用
      // `host:turn/<seq>`（稳定、可去重）；缺席时回退水位族（现状，无回归）。
      // 顺序：seq 属于「完成边沿」本身，比内容水位更贴近「同一次完成」的身份。
      const turnSeq = factsCandidateRow.lastTurnEnd?.seq
      const completionSeq = typeof turnSeq === 'number' && Number.isSafeInteger(turnSeq) && turnSeq >= 0
        ? turnSeq
        : undefined
      const candidateEligible = state.factsSeeded
        || (state.factsReseedPending && !memory.shellNotifiedSinceFacts)
      if (candidateEligible && watermark !== undefined && watermark > memory.factsWatermark) {
        candidates.push({
          kind: 'complete',
          watermark,
          ...(completionSeq === undefined ? {} : { completionSeq }),
          evidence: 'facts-watermark',
        })
        factsCandidatePushed = true
        if (completionSeq !== undefined) {
          memory.lastAnchoredSeq = Math.max(memory.lastAnchoredSeq, completionSeq)
        }
      }
    }
    // C4-X3：stale 壳快照不得作运行证据——complete 与 ask/request 边沿整体关闭
    // （行记忆照常推进，stale true→false 的同一行不得凭旧位伪造边沿）。
    const shellEdgeEligible = !shellStale && !reappearing && input.shellReport === true && state.shellSeeded
    // W2 反证守卫：在场的 facts 行是最后已知的 host 内容——它说仍在 running 时，壳的 idle
    // 读数不构成完成证据（实测假通知形状：运行位抖动 + facts 载体降级窗口）。facts 行说 idle
    // 或该行不存在（无 facts 通道）时，降级窗口的壳完成语义保持不变（B3-2/COR-1 继续钉住）。
    const factsContradictsIdle = factsChannelRow !== undefined && factsChannelRow.running === true
    if (shellEdgeEligible && shellRow !== undefined && !factsUsable && !factsContradictsIdle) {
      // 唯一合法的壳完成边沿是运行位 true→false。壳行的 `completed`（官方
      // completionUnread，通道现在会携带）不参与判定：通知只认运行位边沿，官方位由
      // 侧栏/徽标呈现面消费。该负向契约由 completion-observation.test.ts
      // 「CONTROL: the official completed bit on a shell row is never notification evidence」
      // 钉住（结构锁 = ShellObservationRow 刻意不声明该位）。
      const runningEdge = memory.shellRunning === 'running' && shellRunning === 'idle'
      // 本块与 R2 同读函数级 `hostCompletion`（上方一次解析）：I3 门与 R1 锚继承因此不可能
      // 各自重算，无证据时 corrected 门成立、锚选择直接短路——互斥是结构性的。
      // I3：修正 provenance。侧栏把权威证伪写回官方 store 造成的 true→false 不是宿主
      // 完成边沿；无独立 host 证据时不得产候选。蓝点仍由修正臂（completed-store）武装，
      // UX 不变；旧壳无标记 ⇒ fail-open。
      const correctedWithoutHostEvidence = shellRow.corrected === true && hostCompletion === undefined
      // R1：本批 facts 已用带锚候选发过同一次完成（factsCandidatePushed）时，壳边沿不再
      // 重复发——同一身份两次 reconcile 只会让事件键与水位消费多走一趟。其余场合壳边沿照常发：
      // 有新鲜且未借出的宿主锚就继承（与 facts 轨同身份），没有就无锚（身份层发 nonce，
      // 最坏一次重复，绝不静默漏发）。
      const anchorSeq = factsCandidatePushed
        ? undefined
        : shellEdgeCompletionSeq(
            hostCompletion,
            factsChannelRow?.lastTurnEnd?.seq,
            Math.max(seenBefore, memory.factsWatermark),
            memory.lastAnchoredSeq,
          )
      // 锚一进本块即记账（无论本批是否成边沿）：行停在旧 seq 时，晚到的边沿不得复用同一身份。
      if (anchorSeq !== undefined) {
        memory.lastAnchoredSeq = Math.max(memory.lastAnchoredSeq, anchorSeq)
      }
      if (runningEdge && !factsCandidatePushed && !correctedWithoutHostEvidence) {
        candidates.push({
          evidence: 'shell-edge',
          ...(anchorSeq === undefined ? {} : { completionSeq: anchorSeq }),
        })
      }
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
      memory.shellPending = shellRow.pending
    } else {
      memory.shellRunning = 'unknown'
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
    } else if ((factsUsable || factsCandidatePushed) && factsCandidateRow !== undefined && running !== 'running') {
      // I1（Wave6）**契约**（design 19 §3.2.3 已落地，与本实现逐字一致）：running 权威为
      // running 时**不得**消费 facts 水位记忆（不推进 memory.factsWatermark、不吸收进
      // pending），候选保持可重提——两通道可能相差一个 commit（facts 已报完成、壳仍停在
      // 上一回合的 running），此刻 reconcile 会按 running 早退丢弃候选；若这里已推进水位，
      // 壳追平 idle 后候选永不重提（丢发）。保持水位不推进 ⇒ 候选在后续观测中持续重提；
      // 真正的新回合以更高水位覆盖它。相邻的 C4-X2 播种块对「被 I1 挡下的水位」只登记
      // 围栏播种补偿（吞一次已由壳边沿通知的同一完成），不改这条不吸收契约。
      // R2：不可判快照上的 host 域 observed 完成（factsCandidateRow 来自原始行）同样消费水位——
      // 否则恢复批会以「水位仍严格前进」把同一次完成再发一遍。
      const watermark = factsWatermarkOf(factsCandidateRow)
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
    // 已见水位：可用批里读到过的最高 observed 水位（含 I1 挡下未吸收的行）。
    if (rowWatermark !== undefined) {
      memory.factsSeenWatermark = maxWatermarkValue(memory.factsSeenWatermark, rowWatermark)
    }
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
 * 壳轨撤回（C1 分域；provenance = 桥面 `report === undefined`，facts 载体未换代）：
 * 只清**壳轨**的转移记忆——壳通道是否已播种（下一次壳报/虚拟批重新播种，首份不产壳
 * 候选）与每会话的壳运行/待决位（旧壳位不得当新边沿的证据）。**facts 轨原样保留**：
 * `factsSeeded`/`factsWatermark`/`factsReseedPending` 与 `forgottenSessions` 都不动——
 * 窗口内到达的 observed 完成必须仍按「水位严格前进」产出候选并恰好通知一次；清掉它们
 * 会让恢复后的首个可用批变成播种批（G2），把窗口内的真完成吸收进水位 **通知与蓝点两面
 * 都丢**（C1 回归）。壳轨的「撤回即播种」语义由 `shellSeeded = false` 精确表达，不需要
 * 删除整份观测状态（删除 = freshState/generation 重置，facts 轨一并作废）。
 *
 * 「事实载体真正换代」的路径（gateway facts teardown / mux 观察者 teardown / aggregate
 * notReady 删 runtime）不走这里：它们删整份状态（`completionObservationRef.delete` +
 * 账本 withdraw 全量），本函数只服务壳轨的分域撤回。
 */
export function withdrawShellTrack(state: SourceObservationState): void {
  state.shellSeeded = false
  for (const memory of Object.values(state.sessions)) {
    memory.shellRunning = 'unknown'
    delete memory.shellPending
  }
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
