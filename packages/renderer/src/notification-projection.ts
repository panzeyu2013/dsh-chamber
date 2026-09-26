/**
 * 通知边沿的单一投影（P3，design 14 §D4「会话事实单一权威」/ design 19 §3.2）
 * + 目标活性水平收敛器（design 19 §3.2.1–§3.2.5，P1）。
 *
 * WHY THIS EXISTS. Complete 通知此前有两条独立入口（壳 running 边沿 + facts observed
 * 完成），加上 `usableFacts` 抑制分支与两套去重（武装位与水位），规则散在
 * notification-edges.ts / App.tsx / use-bridge-subscriptions.ts 三处。本模块把
 * **证据归一**为一个策略：
 *
 *  - 有可用 facts 的来源：完成事实由 facts 证据拥有（host 域水位，可跨端收敛）；
 *    壳 running 边沿只贡献 ask/request，不再发 complete（这就是原先的 useFacts 抑制）；
 *  - 无 facts 的来源：完成由壳 running true→false 给出（边沿判定在
 *    completion-observation.ts），以「武装位」去重（重新 running 即解除）；
 *  - facts 证据：`completedAtSource === 'observed'` 且水位严格前进才通知
 *    （reconstructed 只出未读）；首份快照只播种水位（design 19 §3.5），两轨共用
 *    complete-ledger 的键空间。
 *
 * 水位原语复用 watermark.ts；本模块只做「哪条证据作数 + 统一去重」的裁决。
 *
 * ── goal-aware v5 P1（下半部分） ──
 * `reconcile(state, observation)` 把上面两条入口升格为**水平收敛器**：不再依据
 * running 跳变帧，而是每份观测都跑一遍 pending 结算（§3.3），按 G1–G5 前置门与
 * §3.4 的 12 条裁决表决定 hold / flush / void / drop / defer / emit：
 *   - 目标 active+armed（或 activation unknown）期间完成候选进 pending（水位吸收），
 *     零 complete 通知（INV1）；
 *   - 目标 outcome（complete/blocked）到达时 flush 一次，标题按 outcomes 一次性身份
 *     （该 goalId 首见 ⇒ 目标标题，其后一律「会话已完成」，TL1）；
 *   - running 权威为 running ⇒ pending 作废并解除武装（INV3）；unknown 不作废（#5/#8）；
 *   - 子代理 busy 只由运行证据给出，延迟 complete 候选（G4/INV8），ask/request 直通（INV4）；
 *   - 基线（本代首份观测）不 emit（INV5/G2）；首份已知 goal 事实即 outcome/null ⇒
 *     静默结清（§3.5：离线完成不补发）；
 *   - settleFence：无水位消费的 emit 后置栏，boundary = 置栏观测当时该会话已吸收的
 *     facts 水位；栏只吞「≤ boundary」或「播种只到 ≤ boundary 之后的首条更高候选」
 *     一次——否则清栏放行（A2/A3-3/B3-1，语义见 swallowFactsCandidateByFence）。
 *
 * 幂等（INV6）：任何 emit/hold 都会消费候选身份（facts ⇒ notified 单调前进到水位；
 * 壳 ⇒ armed），相同观测重放不再产生第二条通知。
 *
 * 唯一入口（Wave3 迁移已收口）：App.tsx 与 use-bridge-subscriptions.ts 只经
 * completion-observation.ts 的 observeSource/applyObservationBatch 进入 reconcile
 * （wiring 锁见 session-authority-wiring.test.ts）；App/桥内不再有第二 planner，
 * 旧的 planner 导出面与整套只被测试消费的边沿孤岛已删除（无现役等价物的语义
 * 见 design 19 §3.2 的删除注记）。
 */
import { type NotificationEdge, type NotificationKind } from './notification-edges.ts'
import { isWatermark, maxWatermarkValue, nextNotifiedWatermark } from './watermark.ts'
import type { CompletionDecisionState, PendingCompletion, SettleFenceEntry } from './complete-ledger.ts'
import type { SessionRunId } from '@dsh-chamber/dsh-stream-state'

/** 一条待发通知；facts 入口带 host 域水位/事件序与运行身份（壳边沿可缺席）。 */
export interface PlannedNotification extends NotificationEdge {
  readonly watermark?: number
  readonly completionSeq?: number
  /** 本次完成所属的运行身份；缺省 = 调用方入队时解析（壳边沿无 facts）。 */
  readonly runId?: SessionRunId
  /**
   * 标题身份（仅 reconcile 出口设置；缺省 = 「会话已完成」= onComplete 文案）。
   * 目标标题**每个 goal 身份至多一次**（R2-A/TL1）：goal-completed/goal-blocked/
   * goal-stopped 由 outcomes 一次性身份决定，其后回落 session-completed。
   */
  readonly title?: NotificationTitleId
  /** 诊断 origin（可选；与 notification-ledger 的 origin 对应）。 */
  readonly origin?: string
}

// ── goal-aware v5：观测形（§2.1、§3.2） ─────────────────────────────────────

/**
 * goal 三值事实（v5 §2.1 的结构等价输入类型；renderer 不 import sidebar 符号）。
 * 隐私：只带 id/revision/phase/activation/updatedAt，**绝不带 objective/blockedReason**。
 */
export interface GoalFact {
  goalId: string
  revision: number
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  /** §2.2 事件缓存；缺席 = unknown（不自动降级 disarmed，候选走 hold）。 */
  activation?: 'armed' | 'disarmed'
  updatedAt?: number
}

/** 字段缺席 = unknown；null = 明确无 goal；对象 = 有 goal（§2.1）。 */
export type GoalFactObservation = GoalFact | null | 'unknown'
export type RunningObservation = 'running' | 'idle' | 'unknown'
/** 只由运行证据归一；unknown 不压制（INV8）。 */
export type SubagentObservation = 'busy' | 'idle' | 'unknown'

export interface CompletionCandidate {
  /** 候选种类；缺省 = complete（水位/壳边沿主轨）。 */
  kind?: NotificationKind
  /** host 域水位（facts 证据必填；壳边沿缺席）。 */
  watermark?: number
  /**
   * host 域 `turn/end.seq`（W2 身份）：有它时运行身份 = `host:turn/<seq>`（稳定、可去重），
   * 缺席时回退水位族（现状，无回归）。候选与 pending 都必须透传，否则延迟释放会丢身份。
   */
  completionSeq?: number
  evidence: 'shell-edge' | 'facts-watermark'
}

/** 一份 (source, session) 观测（可序列化；§3.2）。 */
export interface CompletionObservation {
  sourceId: string
  sessionId: string
  /** 来源代：G1 代际门（与已记录代不符 ⇒ 整体丢弃）。 */
  generation: number
  running: RunningObservation
  subagents: SubagentObservation
  goal: GoalFactObservation
  candidate?: CompletionCandidate
  /** 该来源本代首份观测（G2：不 emit）。 */
  baseline: boolean
  /** §3.5 页代：fresh ⇒ 不借助上一页会话的 pending（加载期已丢弃；此处防御）。 */
  boot: 'same' | 'fresh'
  /**
   * 该会话**当时观察层已吸收**的 facts 水位（memory.factsWatermark）：无水位消费的
   * emit 置栏时用它作 boundary；播种批把本批刚吸收的水位计入（播种消费的正是被栏
   * 守卫的完成），普通批是「候选自身水位尚未吸收」的下界。不可知 = 0（直接重放
   * reconcile 的调用方无需提供）。
   */
  factsMemory?: number
}

/** 标题身份（对应 locales：notification.goalCompleted/goalBlocked/goalStopped；缺省 = onComplete）。 */
export type NotificationTitleId = 'session-completed' | 'goal-completed' | 'goal-blocked' | 'goal-stopped'

/** 独立计数（notification-ledger 的 held/flushed/voided/dropped/deferred）。 */
export type CompletionDisposition = 'held' | 'flushed' | 'voided' | 'dropped' | 'deferred'

/** 单份观测的裁决回执（每会话至多一条 complete/ask/request 候选）。 */
export interface CompletionReconcileResult {
  /**
   * 主通知（向后兼容的标量出口）：complete 结算通知优先，否则为 ask/request 直发。
   * 同一份观测可同时产出结算通知与 ask/request（#12 直通不再短路 pending 结算），
   * 完整有序列表见 {@link notifications}。
   */
  readonly notification?: PlannedNotification
  /** 本份观测产出的全部通知（有序；调用方按列表逐条 emit）。 */
  readonly notifications?: readonly PlannedNotification[]
  /** 状态变化的处置；keep/无变化时为 undefined。 */
  readonly disposition?: CompletionDisposition
  readonly origin?: string
  /** 既有 pending 的存续毫秒数（诊断；新建 pending 时为 undefined）。 */
  readonly pendingAge?: number
}

/**
 * reconcile 的**批级**选项（不属于可序列化观测；由唯一接线
 * {@link applyObservationBatch} 逐观测传递）。
 */
export interface ReconcileOptions {
  /**
   * 同批 facts 恢复播种证据（C4-X2 / I1 hold 的时序修复）：本批
   * （completion-observation.ts 的 ObservationBatch.fenceSeeds）已为该会话登记播种补偿 ⇒ 本份观测的
   * **#1 running 权威**不得清它的 settleFence。否则「恢复批 + 新回合 running」同批
   * 到达时，先落账的播种补偿会被同一批的清栏整条抹掉，被栏守卫的完成随后从 facts
   * 侧按 rule ③ 二次上报。作用域**严格限本批**（同一观测单独重放不得携带它）——
   * 它不是围栏的通用豁免，只在同一批已经登记补偿时生效。
   */
  readonly keepFence?: boolean
}

// ── reconcile 内部原语（直接读写 CompletionDecisionState；调用方只经 ledger.state()） ──

function pendingOf(state: CompletionDecisionState, sourceId: string, sessionId: string): PendingCompletion | undefined {
  return state.pending[sourceId]?.[sessionId]
}

// 全部写点写时复制（与 complete-ledger 的 setter 同纪律）：旧快照冻结在写入时刻。
function writePending(state: CompletionDecisionState, sourceId: string, sessionId: string, entry: PendingCompletion): void {
  const table = state.pending[sourceId] ?? {}
  state.pending = { ...state.pending, [sourceId]: { ...table, [sessionId]: entry } }
}

function dropPending(state: CompletionDecisionState, sourceId: string, sessionId: string): void {
  const table = state.pending[sourceId]
  if (table === undefined || table[sessionId] === undefined) return
  const next = { ...table }
  delete next[sessionId]
  if (Object.keys(next).length === 0) {
    const sources = { ...state.pending }
    delete sources[sourceId]
    state.pending = sources
  } else {
    state.pending = { ...state.pending, [sourceId]: next }
  }
}

function notifiedComplete(state: CompletionDecisionState, sourceId: string, sessionId: string): number | undefined {
  return state.notified[sourceId]?.[sessionId]?.complete
}

/** 单调推进已通知水位（0/坏值视为缺席；不下调）。 */
function advanceNotified(
  state: CompletionDecisionState,
  sourceId: string,
  sessionId: string,
  kind: NotificationKind,
  watermark: number | undefined,
): void {
  if (!isWatermark(watermark) || watermark === 0) return
  const sourceTable = state.notified[sourceId] ?? {}
  const row = sourceTable[sessionId] ?? {}
  const next = nextNotifiedWatermark(row[kind], watermark)
  if (next === undefined || next === row[kind]) return
  state.notified = { ...state.notified, [sourceId]: { ...sourceTable, [sessionId]: { ...row, [kind]: next } } }
}

function goalOutcome(state: CompletionDecisionState, sourceId: string, goalId: string): number | undefined {
  return state.outcomes[sourceId]?.[goalId]
}

/** 记一次标题身份（该 goalId 首见 ⇒ 目标/中性标题；已见 ⇒ 「会话已完成」）。 */
function recordOutcome(state: CompletionDecisionState, sourceId: string, goalId: string, watermark: number): void {
  if (!isWatermark(watermark)) return
  const table = state.outcomes[sourceId] ?? {}
  const current = table[goalId]
  if (current !== undefined && current >= watermark) return
  state.outcomes = { ...state.outcomes, [sourceId]: { ...table, [goalId]: watermark } }
}

/**
 * 武装并记录水位界（F5 阻断项 2）：`consumed` = 本次消费的 candidate/notified
 * 水位上界（无水位消费 = 0）。armed 门只吞水位 ≤ 界的 facts 候选；更高水位是**新
 * 完成**——facts-only 来源没有 running=true 解除武装的出口，无界武装会永久吞发。
 */
function armSession(state: CompletionDecisionState, sourceId: string, sessionId: string, consumed?: number): void {
  const floor = maxWatermarkValue(armedFloorOf(state, sourceId, sessionId), consumed)
  if (armedFloorOf(state, sourceId, sessionId) !== floor) {
    const table = state.armedFloor[sourceId] ?? {}
    state.armedFloor = { ...state.armedFloor, [sourceId]: { ...table, [sessionId]: floor } }
  }
  const current = state.armed[sourceId]
  if (current?.has(sessionId) === true) return
  state.armed = { ...state.armed, [sourceId]: new Set([...(current ?? []), sessionId]) }
}

function disarmSession(state: CompletionDecisionState, sourceId: string, sessionId: string): void {
  // 水位界随武装位同拍清除：解除武装后重新 arm 的消费水位是新界，旧界不得残留。
  clearArmedFloor(state, sourceId, sessionId)
  const current = state.armed[sourceId]
  if (current?.has(sessionId) !== true) return
  const next = new Set(current)
  next.delete(sessionId)
  const tables = { ...state.armed }
  if (next.size === 0) delete tables[sourceId]
  else tables[sourceId] = next
  state.armed = tables
}

function isArmed(state: CompletionDecisionState, sourceId: string, sessionId: string): boolean {
  return state.armed[sourceId]?.has(sessionId) === true
}

/** arm 时记录的已消费水位上界（undefined = 旧无界武装/无界入口）。 */
function armedFloorOf(state: CompletionDecisionState, sourceId: string, sessionId: string): number | undefined {
  return state.armedFloor[sourceId]?.[sessionId]
}

function clearArmedFloor(state: CompletionDecisionState, sourceId: string, sessionId: string): void {
  const table = state.armedFloor[sourceId]
  if (table === undefined || table[sessionId] === undefined) return
  const next = { ...table }
  delete next[sessionId]
  if (Object.keys(next).length === 0) {
    const sources = { ...state.armedFloor }
    delete sources[sourceId]
    state.armedFloor = sources
  } else {
    state.armedFloor = { ...state.armedFloor, [sourceId]: next }
  }
}

function fenceOf(state: CompletionDecisionState, sourceId: string, sessionId: string): SettleFenceEntry | undefined {
  return state.settleFence[sourceId]?.[sessionId]
}

/**
 * 置栏：一次**无水位消费**的 emit 后，记录该观测当时已吸收的 facts 水位为界。
 * 同一会话再置栏即覆盖（一次性守卫只认最近一次无水位 emit）。
 */
function setFence(state: CompletionDecisionState, sourceId: string, sessionId: string, boundary: number): void {
  const table = state.settleFence[sourceId] ?? {}
  state.settleFence = { ...state.settleFence, [sourceId]: { ...table, [sessionId]: { boundary } } }
}

function clearFence(state: CompletionDecisionState, sourceId: string, sessionId: string): void {
  const table = state.settleFence[sourceId]
  if (table === undefined || table[sessionId] === undefined) return
  const next = { ...table }
  delete next[sessionId]
  if (Object.keys(next).length === 0) {
    const sources = { ...state.settleFence }
    delete sources[sourceId]
    state.settleFence = sources
  } else {
    state.settleFence = { ...state.settleFence, [sourceId]: next }
  }
}

/**
 * 无水位消费的 emit 置栏：boundary = 本观测当时已吸收的 facts 水位（观察层缺席 = 0）；
 * 有水位消费（facts 候选自身的 watermark）不置栏。
 */
function setFenceForNoWatermarkConsumption(
  state: CompletionDecisionState,
  observation: CompletionObservation,
  consumedWatermark: number | undefined,
): void {
  if (consumedWatermark !== undefined) return
  setFence(state, observation.sourceId, observation.sessionId, observation.factsMemory ?? 0)
}

function isGoalKnown(state: CompletionDecisionState, sourceId: string, sessionId: string): boolean {
  return state.goalKnown[sourceId]?.has(sessionId) === true
}

function markGoalKnown(state: CompletionDecisionState, sourceId: string, sessionId: string): void {
  const current = state.goalKnown[sourceId]
  if (current?.has(sessionId) === true) return
  state.goalKnown = { ...state.goalKnown, [sourceId]: new Set([...(current ?? []), sessionId]) }
}

function forgetGoalKnown(state: CompletionDecisionState, sourceId: string, sessionId: string): void {
  const current = state.goalKnown[sourceId]
  if (current?.has(sessionId) !== true) return
  const next = new Set(current)
  next.delete(sessionId)
  const tables = { ...state.goalKnown }
  if (next.size === 0) delete tables[sourceId]
  else tables[sourceId] = next
  state.goalKnown = tables
}

function candidateKind(candidate: CompletionCandidate): NotificationKind {
  return candidate.kind ?? 'complete'
}

/**
 * 栏对 facts 候选的一次性裁决（A2/A3-3/B3-1；返回 true = 吞）。按序：
 *   1. W <= boundary ⇒ 候选不高于置栏时已吸收的水位，必为被守卫的同一完成；
 *   2. seededSince !== undefined && W > seededSince ⇒ 播种只到 ≤ boundary，被守卫
 *      的完成尚未在 facts 侧出现，这条严格更高的候选是它的首次上报；
 *   3. 否则（W > boundary 且无播种补偿）⇒ 真正的新完成：清栏放行正常裁决。
 * 1/2 吞掉时推进 notified（消费候选身份，INV6：否则相同观测重放会第二次穿过栏）。
 * 栏无论如何都清（一次性）。
 */
function swallowFactsCandidateByFence(
  state: CompletionDecisionState,
  sourceId: string,
  sessionId: string,
  watermark: number,
): boolean {
  const fence = fenceOf(state, sourceId, sessionId)
  if (fence === undefined) return false
  clearFence(state, sourceId, sessionId)
  if (watermark <= fence.boundary) {
    advanceNotified(state, sourceId, sessionId, 'complete', watermark)
    return true
  }
  if (fence.seededSince !== undefined && watermark > fence.seededSince) {
    advanceNotified(state, sourceId, sessionId, 'complete', watermark)
    return true
  }
  return false
}

/**
 * G5 + settleFence 归一：返回本份观测真正作数的 complete 候选（否则 undefined）。
 *   - settleFence：无水位消费的 emit 置下的一次性栏（见 swallowFactsCandidateByFence）；
 *   - 壳候选：已 armed 或已有栏 ⇒ 无候选（同一次完成的延迟边沿不得再出）；
 *   - facts 候选：水位必须严格前进（相对 pending 吸收位与已通知位）。
 */
function normalizeCompleteCandidate(
  state: CompletionDecisionState,
  observation: CompletionObservation,
  pending: PendingCompletion | undefined,
): CompletionCandidate | undefined {
  const candidate = observation.candidate
  if (candidate === undefined || candidateKind(candidate) !== 'complete') return undefined
  if (candidate.evidence === 'facts-watermark') {
    if (!isWatermark(candidate.watermark)) return undefined
    if (swallowFactsCandidateByFence(state, observation.sourceId, observation.sessionId, candidate.watermark)) {
      return undefined
    }
    const floor = maxWatermarkValue(
      notifiedComplete(state, observation.sourceId, observation.sessionId),
      pending?.watermark,
    )
    if (candidate.watermark <= floor) return undefined
    // 无 pending 且壳已 armed：该会话的完成已进入过通知/压制（旧 facts planner 的
    // armed 门）。F5 阻断项 2 的界：只有水位 ≤ arm 时记录的「已消费水位上界」的候选
    // 才视为同一次完成的重复上报（不补发，水位照记）；水位严格更高 = 新完成，放行到
    // 正常裁决（消费并 emit）。无界武装（旧 setArmed 入口，未记录界）保持原汇合语义。
    if (pending === undefined && isArmed(state, observation.sourceId, observation.sessionId)) {
      const floor = armedFloorOf(state, observation.sourceId, observation.sessionId)
      if (floor === undefined || candidate.watermark <= floor) {
        advanceNotified(state, observation.sourceId, observation.sessionId, 'complete', candidate.watermark)
        return undefined
      }
    }
    return candidate
  }
  // 壳候选（无水位）到达时已有栏 ⇒ 吞并清栏（延迟到达的同一次壳完成不得双发）；
  // 已 armed ⇒ 无候选（同一次完成的延迟 completed 边沿不得再出）。
  if (fenceOf(state, observation.sourceId, observation.sessionId) !== undefined) {
    clearFence(state, observation.sourceId, observation.sessionId)
    return undefined
  }
  if (isArmed(state, observation.sourceId, observation.sessionId)) return undefined
  return candidate
}

/**
 * 候选并入 pending（水位吸收；已有 pending 的入场时刻不被刷新）。
 *
 * `deferred` 只在**新建** pending 时采纳：已有 pending 保持自己的身份（目标 hold
 * 不得被一次 busy 改写为可释放的延迟；busy 延迟的 pending 再次 busy 时保留标记）。
 */
function absorbCandidate(
  state: CompletionDecisionState,
  sourceId: string,
  sessionId: string,
  candidate: CompletionCandidate,
  goalId: string | undefined,
  now: number,
  deferred?: 'subagent-busy',
): PendingCompletion {
  const existing = pendingOf(state, sourceId, sessionId)
  const watermark = maxWatermarkValue(existing?.watermark, candidate.watermark)
  const deferredMark = existing !== undefined ? existing.deferred : deferred
  // W2 身份：已有 pending 保持自己的身份（与 goalId 同规）——同一次完成的 seq 不得被
  // 后到的观测改写；只有新建时才采纳候选的 seq。
  const completionSeq = existing?.completionSeq ?? candidate.completionSeq
  const entry: PendingCompletion = {
    at: existing?.at ?? now,
    ...(watermark > 0 ? { watermark } : {}),
    ...(completionSeq === undefined ? {} : { completionSeq }),
    ...((existing?.goalId ?? goalId) === undefined ? {} : { goalId: (existing?.goalId ?? goalId) as string }),
    ...(deferredMark === undefined ? {} : { deferred: deferredMark }),
  }
  writePending(state, sourceId, sessionId, entry)
  return entry
}

/**
 * 消费候选身份：notified 单调前进到 max(candidate.watermark, floor)，并 arm——
 * 水位界 = 该次消费上界（F5 阻断项 2）。facts 与壳共用；调用点在 emit 后无需再 arm
 * （臂上记录的就是这次消费的水位，armed 门据此只吞同一次完成的重复上报）。
 */
function consumeCompleteCandidate(
  state: CompletionDecisionState,
  sourceId: string,
  sessionId: string,
  candidate: CompletionCandidate,
  floor: number | undefined,
): void {
  const consumed = maxWatermarkValue(candidate.watermark, floor)
  advanceNotified(state, sourceId, sessionId, 'complete', consumed)
  armSession(state, sourceId, sessionId, consumed)
}

function goalTitle(phase: 'complete' | 'blocked'): NotificationTitleId {
  return phase === 'complete' ? 'goal-completed' : 'goal-blocked'
}

function completeNotification(
  sessionId: string,
  watermark: number | undefined,
  title: NotificationTitleId,
  origin: string,
  completionSeq?: number,
): PlannedNotification {
  return {
    sessionId,
    kind: 'complete',
    ...(watermark === undefined ? {} : { watermark }),
    ...(completionSeq === undefined ? {} : { completionSeq }),
    title,
    origin,
  }
}

/**
 * G4 延迟 pending 的释放（busy 结束）：busy 只延迟、不压制——goal 语境为 null/paused
 * （§3.2.3 #10）或 unknown（#11）时，延迟的完成必须中性「会话已完成」直发一次，
 * 消费 pending 并推进水位；无 facts 水位的释放置 settleFence（同一完成的下一条 facts
 * 候选不得双发）。结算守卫（§3.3/TL3）：水位已被通知过 ⇒ 只清不重发。
 */
function releaseDeferred(
  state: CompletionDecisionState,
  sourceId: string,
  sessionId: string,
  pending: PendingCompletion,
  now: number,
  origin: string,
  factsMemory: number | undefined,
): CompletionReconcileResult {
  const pendingAge = now - pending.at
  const watermark = pending.watermark
  if (watermark !== undefined && maxWatermarkValue(notifiedComplete(state, sourceId, sessionId)) >= watermark) {
    dropPending(state, sourceId, sessionId)
    armSession(state, sourceId, sessionId, notifiedComplete(state, sourceId, sessionId))
    return { disposition: 'dropped', origin: 'settle-guard', pendingAge }
  }
  advanceNotified(state, sourceId, sessionId, 'complete', watermark)
  dropPending(state, sourceId, sessionId)
  armSession(state, sourceId, sessionId, maxWatermarkValue(watermark, notifiedComplete(state, sourceId, sessionId)))
  if (watermark === undefined) setFence(state, sourceId, sessionId, factsMemory ?? 0)
  return {
    notification: completeNotification(sessionId, watermark, 'session-completed', origin, pending.completionSeq),
    disposition: 'flushed',
    origin,
    pendingAge,
  }
}

/**
 * #1 running 权威：pending 作废（结清 notified 到 pending.watermark）、armed 解除、
 * settleFence 清。返回 voided 回执（无 pending 时为空）。
 *
 * `keepFence`（同批 C4-X2 / I1 播种证据，见 {@link ReconcileOptions}）：本批已为
 * 该会话登记 fenceSeed 时保留围栏——播种补偿与本份观测同批落账，清栏会让它失效。
 * 只豁免围栏：pending 作废与解除武装的 #1 语义不变。
 *
 * **已知边界（跨批 C4-X2 / I1；design 19 §3.2.7 第 ⑥ 条已登记）**：清栏豁免只覆盖
 * **同一批**。若新回合的 running 观测在**另一批**先到（facts 恢复批之前），栏在这里按
 * 原语义被清掉，恢复批的 C4-X2 播种登记随无栏可依（seedSettleFence no-op）——facts 侧
 * 迟到的被守卫完成水位（旧 observed / 行 null 后到）会按 rule ③ 判成新完成再通知一次
 * （V5-B 探针：2 个物理完成 / 3 条通知；KNOWN-BOUNDARY 用例钉住）。闭合它需要让围栏跨
 * running 批存活，但 boundary 只有水位、没有完成身份：facts 恢复若直接报出更高水位
 * （被守卫完成从未在 facts 侧出现），同一栏会吞掉真实新完成（丢发）。**消除需要完成
 * 身份（上游只读）**；不得为消例引入计数式启发。
 */
function applyRunningAuthority(
  state: CompletionDecisionState,
  sourceId: string,
  sessionId: string,
  pending: PendingCompletion | undefined,
  now: number,
  keepFence: boolean,
): CompletionReconcileResult {
  let result: CompletionReconcileResult = {}
  if (pending !== undefined) {
    advanceNotified(state, sourceId, sessionId, 'complete', pending.watermark)
    dropPending(state, sourceId, sessionId)
    result = { disposition: 'voided', origin: 'running', pendingAge: now - pending.at }
  }
  disarmSession(state, sourceId, sessionId)
  if (!keepFence) clearFence(state, sourceId, sessionId)
  return result
}

/**
 * 水平收敛器对外入口（v5 §3.2–§3.5）。
 *
 * #12 ask/request 直通**不再短路 pending 结算**：本入口把一份观测拆成两次裁决——
 * 先按「无 complete 候选」跑本体（含 pending 结算，§3.3「每份观测都跑」），再把
 * ask/request 直发（INV4），合并为一份有序通知列表。否则 hold(g1) → 观测(目标
 * outcome + ask) 会只发 ask，pending 要等下一份观测才 flush，期间撤回即丢一次。
 *
 * 幂等（INV6）边界：**complete** 的幂等由候选消费保证（facts ⇒ notified 单调前进；
 * 壳 ⇒ armed），相同 complete 观测重放不产生第二条通知；**ask/request 的幂等不在
 * 本函数内**——它由观测层 `observeSource` 的 shellPending 边沿记忆去重（同值重放
 * 不产生候选，§3.2），生产唯一接线即该入口。直接从导出面重放同一份 ask/request
 * 观测会重复产生通知，调用方不得绕过观测层（design 19 §3.2 的 INV6 措辞仍按
 * complete 单轨叙述，ask/request 的边沿去重属于 §3.2 事实表语义）。
 *
 * **I1 契约**（design 19 §3.2.3 已落地，与本实现逐字一致）：running 权威 = running 时观测层
 * 不吸收 facts 水位、候选保持可重提，本函数按 #1 早退——因此**不消费候选身份**
 * （不推进 notified / 不入 pending），壳追平 idle 后同一候选照常重提，保证「facts
 * 先到、壳仍 running」的完成不丢发。唯一时序例外是同批播种证据（options.keepFence，
 * C4-X2/I1 恢复批）：那只豁免围栏清除，不消费候选。
 *
 * `now` 仅用于 pending 入场时刻与 pendingAge 诊断（测试可注入）；
 * `options` 是批级选项（见 {@link ReconcileOptions}），调用方不得把它当成观测的一部分。
 */
export function reconcile(
  state: CompletionDecisionState,
  observation: CompletionObservation,
  now: number = Date.now(),
  options: ReconcileOptions = {},
): CompletionReconcileResult {
  const candidate = observation.candidate
  if (candidate === undefined || candidateKind(candidate) === 'complete') {
    return reconcileCore(state, observation, now, options)
  }
  // G2：基线仍需跑结算（待结算 pending 可静默结清），只是不 emit ask/request。
  const baseline = observation.baseline === true
  const settled = reconcileCore(state, { ...observation, candidate: undefined }, now, options)
  if (baseline) return settled
  const kind = candidateKind(candidate)
  advanceNotified(state, observation.sourceId, observation.sessionId, kind, candidate.watermark)
  const ask: PlannedNotification = {
    sessionId: observation.sessionId,
    kind,
    ...(candidate.watermark === undefined ? {} : { watermark: candidate.watermark }),
    ...(candidate.completionSeq === undefined ? {} : { completionSeq: candidate.completionSeq }),
    origin: candidate.evidence,
  }
  const settledNotifications = settled.notifications
    ?? (settled.notification === undefined ? [] : [settled.notification])
  return {
    ...settled,
    notification: settled.notification ?? ask,
    notifications: [...settledNotifications, ask],
  }
}

/**
 * 本体结算（complete 轨 + pending 结算）：ask/request 候选已由入口摘除，这里只会
 * 看到 complete 或缺席的候选。G1–G5 前置门与 §3.4 的 12 条裁决逐条实现；
 * pending 结算在每份观测上跑（不依赖跳变帧）。
 */
function reconcileCore(
  state: CompletionDecisionState,
  observation: CompletionObservation,
  now: number = Date.now(),
  options: ReconcileOptions = {},
): CompletionReconcileResult {
  const { sourceId, sessionId } = observation

  // G1 代际门：与已记录代不符 ⇒ 旧代迟到观测，整体丢弃。
  const recordedGeneration = state.generation[sourceId]
  if (recordedGeneration !== undefined && recordedGeneration !== observation.generation) return {}
  if (recordedGeneration === undefined) state.generation[sourceId] = observation.generation

  // boot=fresh 防御：加载期应已丢弃 pending（§3.5）；此处兜底并清结算点记忆。
  if (observation.boot === 'fresh' && pendingOf(state, sourceId, sessionId) !== undefined) {
    dropPending(state, sourceId, sessionId)
    forgetGoalKnown(state, sourceId, sessionId)
  }

  const baseline = observation.baseline === true
  const goal = observation.goal
  const goalFact: GoalFact | null | undefined = goal === 'unknown' ? undefined : goal
  const firstKnownGoalFact = goal !== 'unknown' && !isGoalKnown(state, sourceId, sessionId)
  // §3.5 静默结算点：基线（G2）或本代首份已知 goal 事实 ⇒ pending 结清但不通知。
  const settleSilently = baseline || firstKnownGoalFact

  const pendingBeforeRunning = pendingOf(state, sourceId, sessionId)
  let pending = pendingBeforeRunning

  // #1 running 权威：pending 作废（结清 notified）、armed 解除、settleFence 清
  // （同批播种证据 keepFence 时豁免清栏，见 observeSource C4-X2 / ReconcileOptions）。
  const runningReceipt = observation.running === 'running'
    ? applyRunningAuthority(state, sourceId, sessionId, pendingBeforeRunning, now, options.keepFence === true)
    : {}
  if (goal !== 'unknown' && observation.running === 'running') markGoalKnown(state, sourceId, sessionId)

  // #12 ask/request 已由 reconcile 入口摘除并直发（INV4）；本体只处理 complete 轨。
  // running 权威下 complete 候选不再处理（running 与完成互斥）。
  if (observation.running === 'running') return runningReceipt

  // G4 子代理 busy：complete 候选延迟（不 emit/flush/推进水位）；busy 结束后继续。
  if (observation.subagents === 'busy') {
    if (goal !== 'unknown') markGoalKnown(state, sourceId, sessionId)
    const deferred = normalizeCompleteCandidate(state, observation, pending)
    if (deferred === undefined) return {}
    // 延迟来源标记（评审 A 阻断项）：busy 只延迟「此刻本应直发」的完成——
    // goal null/paused（#10）或 unknown（#11）；goal active 下 pending 是目标压制位，
    // 身份由目标分支接管，不得标记为可释放。已有 pending 保持自己的身份。
    const deferredBy = pending === undefined && (goal === 'unknown' || goal === null || goal.phase === 'paused')
      ? 'subagent-busy' as const
      : undefined
    absorbCandidate(state, sourceId, sessionId, deferred, goalFact?.goalId, now, deferredBy)
    return { disposition: 'deferred', origin: 'subagent-busy' }
  }

  const candidate = normalizeCompleteCandidate(state, observation, pending)

  // G3 goal unknown：不结算 / 不 hold；候选按 #11 直通（**目标语境**的已有 pending
  // 只吸收水位；busy 延迟的 pending 例外，必须释放）。
  if (goal === 'unknown') {
    if (pending !== undefined) {
      if (candidate !== undefined) {
        pending = absorbCandidate(state, sourceId, sessionId, candidate, undefined, now)
      }
      // G4 释放：busy 延迟的 pending 不得被 goal unknown 永久留存——按 #11 fail-open
      // 中性直发一次（消费 pending + 推进水位；无 facts 水位置围栏）。基线同样释放
      // （A1 修复）：延迟标记本身就是「此刻本应直发」的证据，G2 的「不补发」只适用
      // 于基线**候选**（候选无需消费），不得吞掉一条已经由 busy 延迟过一次的完成。
      if (pending.deferred === 'subagent-busy') {
        return releaseDeferred(state, sourceId, sessionId, pending, now, 'subagent-busy-release', observation.factsMemory)
      }
      return {}
    }
    if (candidate === undefined || baseline) return {}
    // I2（Wave6）：goal 未知的直发与 #9/#10 同规 arm——否则 stale 壳 running 记忆恢复
    // 后同一完成的壳边沿会二次通知（主进程 claim 键含 watermark，两条都会显示）。
    // consume 自己带上本次消费水位界（F5 阻断项 2）。
    consumeCompleteCandidate(state, sourceId, sessionId, candidate, undefined)
    setFenceForNoWatermarkConsumption(state, observation, candidate.watermark)
    return {
      notification: completeNotification(
        sessionId,
        candidate.watermark,
        'session-completed',
        'goal-unknown',
        candidate.completionSeq,
      ),
      origin: 'goal-unknown',
    }
  }

  // G3 分支已返回：这里 goal 必为已知事实，TS 收窄为 GoalFact | null。
  const knownGoal: GoalFact | null = goal
  markGoalKnown(state, sourceId, sessionId)
  pending = pendingOf(state, sourceId, sessionId)

  if (pending !== undefined) {
    // 入场时 goal 未知（pending.goalId 缺席）：已知事实到达即采纳身份，后续变化可判。
    if (pending.goalId === undefined && knownGoal !== null) {
      pending = { ...pending, goalId: knownGoal.goalId }
      writePending(state, sourceId, sessionId, pending)
    }
    // 候选先做水位吸收；随后无论有无候选都跑结算（§3.3「每份观测都跑」）。
    if (candidate !== undefined) {
      pending = absorbCandidate(state, sourceId, sessionId, candidate, knownGoal?.goalId, now)
    }
    const pendingAge = now - pending.at

    // 结算守卫（§3.3）：notified ≥ pending.watermark ⇒ 已消费，直接 drop（TL3 双发闭合）。
    if (pending.watermark !== undefined && maxWatermarkValue(notifiedComplete(state, sourceId, sessionId)) >= pending.watermark) {
      dropPending(state, sourceId, sessionId)
      return { disposition: 'dropped', origin: 'settle-guard', pendingAge }
    }

    // G4 释放（评审 A 阻断项）：busy 延迟的 pending 在「无压制」语境（goal null /
    // paused，#10 语义）下中性直发一次——延迟 ≠ 压制，不得被 #3 静默 drop。基线同样
    // 释放（A1 修复，与 G3 unknown 分支同纪律）：延迟位是 durable 身份，跨页重载
    // （boot same）后第一次观测常是基线，若被 G2 吞掉则 busy 延迟的完成再次永久滞留。
    if (pending.deferred === 'subagent-busy' && (knownGoal === null || knownGoal.phase === 'paused')) {
      return releaseDeferred(state, sourceId, sessionId, pending, now, 'subagent-busy-release', observation.factsMemory)
    }

    // #3 goal null / paused / goalId 变化 ⇒ drop（结清，不通知）。
    if (
      knownGoal === null || knownGoal.phase === 'paused'
      || (pending.goalId !== undefined && knownGoal.goalId !== pending.goalId)
    ) {
      advanceNotified(state, sourceId, sessionId, 'complete', pending.watermark)
      dropPending(state, sourceId, sessionId)
      armSession(state, sourceId, sessionId, notifiedComplete(state, sourceId, sessionId))
      return { disposition: 'dropped', origin: goalDropOrigin(knownGoal), pendingAge }
    }

    // #2 pending + goal complete/blocked ⇒ flush 一次（标题按 outcomes 一次性身份）。
    if (knownGoal.phase === 'complete' || knownGoal.phase === 'blocked') {
      const flushWatermark = maxWatermarkValue(pending.watermark, knownGoal.updatedAt)
      if (settleSilently) {
        // §3.5：离线「完成 + outcome 均已发生」⇒ 首份已知 goal 事实即 outcome ⇒ 静默结清。
        advanceNotified(state, sourceId, sessionId, 'complete', flushWatermark)
        recordOutcome(state, sourceId, knownGoal.goalId, flushWatermark)
        dropPending(state, sourceId, sessionId)
        armSession(state, sourceId, sessionId, flushWatermark)
        setFenceForNoWatermarkConsumption(state, observation, pending.watermark)
        return { disposition: 'dropped', origin: 'silent-settle', pendingAge }
      }
      const first = goalOutcome(state, sourceId, knownGoal.goalId) === undefined
      recordOutcome(state, sourceId, knownGoal.goalId, flushWatermark)
      advanceNotified(state, sourceId, sessionId, 'complete', flushWatermark)
      dropPending(state, sourceId, sessionId)
      armSession(state, sourceId, sessionId, flushWatermark)
      setFenceForNoWatermarkConsumption(state, observation, pending.watermark)
      return {
        notification: completeNotification(
          sessionId,
          flushWatermark > 0 ? flushWatermark : undefined,
          first ? goalTitle(knownGoal.phase) : 'session-completed',
          'goal-outcome',
          pending.completionSeq,
        ),
        disposition: 'flushed',
        origin: 'goal-outcome',
        pendingAge,
      }
    }

    // #4 pending + goal active + disarmed ⇒ 中性「目标未继续运行」只随 pending 消费一次。
    if (knownGoal.activation === 'disarmed' && !baseline) {
      const flushWatermark = maxWatermarkValue(pending.watermark, knownGoal.updatedAt)
      const first = goalOutcome(state, sourceId, knownGoal.goalId) === undefined
      recordOutcome(state, sourceId, knownGoal.goalId, flushWatermark)
      advanceNotified(state, sourceId, sessionId, 'complete', flushWatermark)
      dropPending(state, sourceId, sessionId)
      armSession(state, sourceId, sessionId, flushWatermark)
      setFenceForNoWatermarkConsumption(state, observation, pending.watermark)
      return {
        notification: completeNotification(
          sessionId,
          flushWatermark > 0 ? flushWatermark : undefined,
          first ? 'goal-stopped' : 'session-completed',
          'goal-disarmed',
          pending.completionSeq,
        ),
        disposition: 'flushed',
        origin: 'goal-disarmed',
        pendingAge,
      }
    }

    // #5/#6 keep：active + armed / activation unknown（等激活事件或相位变化）；基线 disarmed 也保留。
    return { origin: 'goal-keep' }
  }

  // ── 无 pending：候选直接裁决（#9–#11 与 #10 家族） ──
  if (candidate === undefined) return {}
  if (baseline) return {} // G2：基线不 emit（候选也不消费）

  if (knownGoal !== null && knownGoal.phase === 'active' && (knownGoal.activation === 'armed' || knownGoal.activation === undefined)) {
    // #7/#8 hold（水位吸收）+ arm；activation unknown 与 armed 同出口。
    writePending(state, sourceId, sessionId, {
      ...(candidate.watermark === undefined ? {} : { watermark: candidate.watermark }),
      ...(candidate.completionSeq === undefined ? {} : { completionSeq: candidate.completionSeq }),
      goalId: knownGoal.goalId,
      at: now,
    })
    armSession(state, sourceId, sessionId, maxWatermarkValue(candidate.watermark, notifiedComplete(state, sourceId, sessionId)))
    return {
      disposition: 'held',
      origin: knownGoal.activation === 'armed' ? 'goal-armed' : 'goal-activation-unknown',
    }
  }

  if (knownGoal !== null && (knownGoal.phase === 'complete' || knownGoal.phase === 'blocked')) {
    // #9 首次 outcome ⇒ 目标标题 + 记录；已见 ⇒ 「会话已完成」。
    const first = goalOutcome(state, sourceId, knownGoal.goalId) === undefined
    const watermark = maxWatermarkValue(candidate.watermark, knownGoal.updatedAt)
    recordOutcome(state, sourceId, knownGoal.goalId, watermark)
    consumeCompleteCandidate(state, sourceId, sessionId, candidate, knownGoal.updatedAt)
    setFenceForNoWatermarkConsumption(state, observation, candidate.watermark)
    return {
      notification: completeNotification(
        sessionId,
        candidate.watermark,
        first ? goalTitle(knownGoal.phase) : 'session-completed',
        'goal-outcome-direct',
        candidate.completionSeq,
      ),
      origin: 'goal-outcome-direct',
    }
  }

  // #10 active+disarmed / paused / goal null：中性「会话已完成」（中性/目标标题只随 pending 消费一次）。
  consumeCompleteCandidate(state, sourceId, sessionId, candidate, undefined)
  setFenceForNoWatermarkConsumption(state, observation, candidate.watermark)
  return {
    notification: completeNotification(
      sessionId, candidate.watermark, 'session-completed', 'session-completed', candidate.completionSeq),
    origin: 'session-completed',
  }
}

/** #3 drop 的三个可达 origin 命名：字面量联合把「仅此三名」变成类型事实
 *  （运行时表值由 notification-projection.test.ts 逐项钉住）。 */
type GoalDropOrigin = 'goal-none' | 'goal-paused' | 'goal-changed'

/**
 * #3 drop 的 origin 命名（F14/D3：旧 'goal-drop' 兜底分支不可达，已删除）。
 *
 * 调用点只在 #3 的三项条件（goal null / paused / pending.goalId 已绑定且与当前
 * goalId 不符）至少一项成立时进入；本函数按序判前两项，抵达末尾时第三项必然成立，
 * 因此可达返回值只有三个命名（返回类型即该字面量联合）。调用点若新增 break 条件，
 * 必须同步这里（否则新条件会被错误命名为 goal-changed）。
 */
function goalDropOrigin(knownGoal: GoalFact | null): GoalDropOrigin {
  if (knownGoal === null) return 'goal-none'
  if (knownGoal.phase === 'paused') return 'goal-paused'
  return 'goal-changed'
}

export type { NotificationKind }