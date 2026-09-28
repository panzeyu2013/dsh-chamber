/**
 * Gateway session-state facts source。只读、浏览器安全（零 Node import；unary 面只用
 * fetch / 定时器，增量面走 page-channel 的 `sessionFacts` 逻辑订阅）。
 *
 * 分类**粗粒度且只有一份**：classifySessionFactsProbe 是本客户端唯一分类器（权威分类器在
 * control-plane 的 session-state-protocol，状态语义逐条对齐；本包不能 import 它）；probe
 * 与对账重取都调用它，模块内不得再内联判定：404 ⇒ legacy-gateway（首探从未有过协议行 =
 * 空权威快照；曾有历史后 = 保留旧行 + 标不可用）；503 + session_state_disabled / mode off
 * ⇒ watcher-disabled；其余非 ok ⇒ degraded；2xx 且 protocol 命中 ⇒ ok。共享字面量（route
 * 路径 / protocol / session_state_disabled / serviceable / completedAtSource）是跨包单一
 * 来源，不得本地改写。
 *
 * 两面纪律：**权威面**永远是 unary 快照（探测/对账走 SESSION_FACTS_ROUTE；网关快照是权威
 * 行集，绝不依赖通道）。**增量面**是通道订阅：一条页面 WS 上的逻辑流，事件名 + data 原文与
 * 旧 SSE 同形（sync/snapshot 整量、其余增量、resync 要求整量重取）；carrier 的断开由
 * control-plane 以 error 帧上报，重连与重订阅都归通道（本模块不得再排自己的重连阶梯）。
 * 订阅 OPEN 起武装静默看门狗：静默 ⇒ 标 stale + 一次 unary 对账。mode 非 'sse'（或没有
 * 订阅缝）时按 pollIntervalMs 重取快照。行数据只承载会话元数据（goal 三值事实 = 白名单
 * {goalId, revision, phase, activation?, updatedAt?}，绝不含 objective/blockedReason），
 * **绝不**带 title/cwd/消息。
 */

/** 快照路由后缀；与 control-plane 的 SESSION_STATE_PATH 逐字节相同（跨包锁步，不得本地改写）。 */
export const SESSION_FACTS_ROUTE = '/chamber/session-state'

/** 本客户端支持的接口主版本；与 control-plane 的 PROTOCOL_VERSION 锁步。 */
export const SESSION_FACTS_PROTOCOL_VERSION = 1

/** 503 kill-switch body 的稳定错误码（锁步字面量）。 */
export const SESSION_FACTS_DISABLED_CODE = 'session_state_disabled'

/** 探测超时（一次调用预算 5s；control-plane 的探测路由同预算，两侧各自持有字面量）。 */
export const SESSION_FACTS_PROBE_TIMEOUT_MS = 5_000

/**
 * 坏答案后的有界重探退避（固定、有界）：probe 失败与整量对账失败共用。流载体的重连已归
 * page-channel（错误帧 + 通道阶梯），本值只服务 unary 面；刻意与 source-mux-facts 的
 * 1s→30s 指数退避不同——数值差异是载体差异，两侧阈值表同一 owner，退避节奏各自拥有。
 */
export const SESSION_FACTS_RECONNECT_MS = 3_000

/** 静默窗：订阅 OPEN 后超过该时长没有任何 item 即标 stale 并做一次整量对账。 */
export const SESSION_FACTS_SILENCE_MS = 60_000

/** poll 档的快照重取周期（与 30s unary watchdog 同量级）。 */
export const SESSION_FACTS_POLL_MS = 30_000

/**
 * 化身内「增量帧缺 diagnostics.baselines 时补快照」的上限（S4）：增量帧不带诊断，
 * 若首份快照落在 mux ready 但首个 session/list 基线未成功的窗口，闩锁会停在 0
 * （listComplete=false）。补快照**单飞**（在途期间不叠发），连续 0 会重试、拿到 ≥1
 * 立即停止；每代至多 {@link SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX} 次，计数用尽后
 * 至少再过 {@link SESSION_FACTS_DIAGNOSTICS_REFETCH_MIN_MS} 才允许新的一轮。
 */
export const SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX = 3

/**
 * 诊断补快照的重武装时间下限（S4）：一轮计数用尽仍为 0 时，距上次补快照满 30s 允许
 * 下一轮——首基线可能只是比补快照更晚成功，没有时间下限则 3 次落在首基线前即永久卡 0。
 */
export const SESSION_FACTS_DIAGNOSTICS_REFETCH_MIN_MS = 30_000

import { isWatermark } from './watermark.ts'
import { isPlainRecord } from './plain-record.ts'
import { hadSchedulingGap, recordEvidence } from '@dsh-chamber/dsh-chamber-client-core'
import { isPageChannelKeepaliveItem } from '@dsh-chamber/dsh-chamber-client-core/page-channel'
import { classifyObservation, isAdmissible } from '@dsh-chamber/dsh-stream-state'

export type SessionFactsVerdict = 'ok' | 'legacy-gateway' | 'degraded'
export type SessionFactsDegradation =
  | 'legacy-gateway'
  | 'watcher-disabled'
  | 'unversioned'
  | 'forward-skew'
  | 'unavailable'
  | null
export type SessionFactsMode = 'sse' | 'poll' | 'off'
export type SessionFactsPendingKind = 'approval' | 'question'
export type SessionFactsCompletedAtSource = 'observed' | 'reconstructed'
export type SessionFactsRowHint = 'added' | 'removed' | 'changed'

/** wire turn/end.reason.kind 族（与协议模块的 SessionTurnEndKind 同词汇）。 */
export type SessionFactsTurnEndKind =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted'
/** wire aborted cause 族（缺失 = 字段缺席，绝不臆造 legacy）。 */
export type SessionFactsTurnEndCause = 'user' | 'parent' | 'hook' | 'disposed' | 'legacy'

/** 判定输入；形状与 client-core 的 TurnEndFact 结构兼容（完成观测/通知投影共用）。 */
export interface SessionFactsTurnEnd {
  kind: SessionFactsTurnEndKind
  cause?: SessionFactsTurnEndCause
  at: number
  seq?: number
}

/**
 * 一行的 goal 三值事实（v5 §6 P2a 的 wire 白名单：{goalId,revision,phase,
 * activation?,updatedAt?}）。renderer 侧与 sidebar 的 GoalFact 同形但不 import
 * （本模块保持低层、只吃 wire）；**绝不带 objective/blockedReason**。
 */
export interface SessionFactsGoalFact {
  goalId: string
  revision: number
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  activation?: 'armed' | 'disarmed'
  updatedAt?: number
}

/** 一行会话事实（wire SessionStateRow 的防御性投影）。 */
export interface SessionFactsRow {
  sessionId: string
  running: boolean
  pendingKind: SessionFactsPendingKind | null
  /**
   * I-12 谱系压制表：running 子代理后代数（官方 `session/list` 的 origin/
   * parentSessionId 谱系在**同一份完整基线**上重算；sidebar 口径同源）。只有配着
   * {@link SessionFactsRow.lineageVerified} 才是权威证据。
   */
  subagentCount: number
  /**
   * I-12 完整性：true = 本行 `subagentCount` 来自一份可判的完整谱系基线（每条
   * subagent 行都有可用父边）。缺席 = 无谱系证据（watcher 来源 / 基线不完整 / 世代
   * 未验证）——消费面按 fail-closed 处理，绝不把它读作「无子代理」。
   */
  lineageVerified?: boolean
  /**
   * I-12 压制表命中：本行在**保留的**谱系表里有 ≥1 个 durable 子代理子代（durable
   * 输出 = 仍在官方列表里的 subagent-origin 行，含已结束的）。基线不可判时该表保留
   * ⇒ 消费面抑制完成（fail-closed），直到下一份可判基线证明子代已清空。
   */
  subagentKnown?: boolean
  /** host 域内容水位（epoch ms）；0 = 未知。 */
  updatedAt: number
  /**
   * 完成边沿时刻；时钟域见 {@link SessionFactsRow.completedAtDomain}：取到 host
   * `turn/end.time` 时是 host 域，拿不到时是观察者域（降级）。
   */
  completedAt: number | null
  /** observed = 实时观察且带 host 时间戳（可通知）；reconstructed = 缺口重建或拿不到
   *  host 时间的降级戳，两者都不作通知证据。 */
  completedAtSource: SessionFactsCompletedAtSource | null
  /**
   * 完成戳的时钟域：`host` = 可直接与读水位比较；`observer` = 客户端观察者时钟，
   * **只用于武装、不得推进 host 域读标记**；缺席 = host 域。
   */
  completedAtDomain?: 'host' | 'observer' | null
  lastTurnEnd: SessionFactsTurnEnd | null
  /**
   * 目标投影事实（v5 §2.1/§6 P2a；加法字段，P2a 前的 wire 缺席）。三值语义：
   * **字段缺席 = unknown**（该来源没有 goal 通路）；`null` = 宿主明确报告当前无
   * goal；对象 = 当前 goal 身份/相位（可带进程内 activation）。形状不符 = unknown
   * （warn-once，绝不折叠成 null）。
   */
  goal?: SessionFactsGoalFact | null
  /** 观察者刷新这一行事实的 host 域毫秒（0 = 未知）。 */
  factAt: number
  /**
   * **客户端本地位**（非 wire）：该行首次观察来自**无壳观察者的 status 事件**
   * （source-mux-facts 的 handleStatus 首建；列表播种与网关平面——快照/增量——都不带该位）。
   * 用于无壳来源忠实复现上游 `observeRunning` 的第二支（首见 idle 也武装；且只在列表基数
   * 已知未就绪时启用）；一经写入即粘住（后续基线合并保留），行退役即消失。
   */
  firstSeenByDelta?: boolean
  /**
   * **客户端本地位**（非 wire）：身份是否已由**列表事实**确认（P2b 的 S1 等价门）。
   * 缺席 = 已确认——网关平面（快照/增量）与列表播种的行**永不带该位**，服务端已过滤；
   * 显式 `false` = 仅由无壳观察者的 status/activity/waterfall 首建、尚未在任何列表
   * 事实出现过的行：它可能其实是子代理，**不得进入快照或判定面**，直到某次基线/added
   * 把它确认为顶层（或揭示为子代理后退役）。 */
  identityConfirmed?: boolean
}

export interface SessionFactsSnapshot {
  verdict: SessionFactsVerdict
  degradation: SessionFactsDegradation
  /** 传输档（gateway 平面）；整量帧缺席时沿用上一份快照，绝不静默丢档。 */
  mode: SessionFactsMode | null
  /** host 生命周期（gateway 平面）；serviceable=false 时行只读作未知。 */
  hostState: string
  serviceable: boolean
  /** 订阅断/静默/断连时 true；这些只读事实仍会被渲染并明确标注。 */
  stale: boolean
  cursor: number
  rows: Readonly<Record<string, SessionFactsRow>>
  lastEventAt: number | null
  /**
   * 镜像已应用过的完整基线数（wire `diagnostics.baselines`，进程内计数）。
   * 缺席 = unknown（旧端/无诊断帧）⇒ 消费者按 listComplete=false 处理（保守，绝不由
   * 行数推断「离 ready 列表」）。快照帧闩锁，增量帧不携带该字段时沿用上一份。
   */
  baselines?: number
}

/**
 * The ONE usability rule every consumer of a session-facts snapshot shares:
 * `verdict === 'ok'` AND the host's `serviceable !== false`.
 *
 * Why both: `verdict` is the HTTP/protocol classifier's answer, while
 * `serviceable` is copied verbatim from the host's own lifecycle. `verdict ok +
 * serviceable false` is reachable (host stopped / managed dsh stopped), and such
 * a snapshot's rows are contractually read-only-unknown; treating them as usable
 * let the notification and completion observers act on rows this module calls
 * unknown, while the sidebar overlay suppressed them. The overlay demanded both;
 * the notification consumers checked only `verdict` — one rule, three sites, two
 * answers.
 *
 * RENDER vs DECISION. This predicate answers "may these rows be RENDERED as
 * read-only facts?" and it deliberately keeps a `stale` snapshot usable: the
 * sidebar overlay renders a disconnected source's residual rows and labels them
 * (`mergeRuntimeFacts` ORs the stale bit in). The DECISION surfaces — the
 * completion observation and the notification projection — must not act on a
 * snapshot whose live carrier is gone, so they use {@link isFactsDecisionUsable}
 * instead. Both predicates live here so the chain has one owner; a consumer must
 * never re-spell either rule (the historical defect: an always-true copy of the
 * decision rule in the completion wiring).
 */
export function isFactsUsable(snapshot: SessionFactsSnapshot): boolean {
  return snapshot.verdict === 'ok' && snapshot.serviceable !== false
}

/**
 * The decision gate: may this snapshot's rows be treated as authoritative
 * EVIDENCE (drive the completion observation and the notification projection)?
 * Strictly narrower than {@link isFactsUsable} by
 * `!stale`.
 *
 * Why `stale`: `markStale()` is a pass-through that flips only the `stale` bit,
 * so every "carrier is gone / silent / rejected" window (subscription error/end,
 * silence watchdog, disconnect) reaches consumers WITHOUT touching
 * `verdict` or `serviceable`. Treating such a snapshot as evidence let a
 * completion be observed on rows whose live carrier was already gone (the badge
 * and the row dot flickered once per carrier flap). Rule 0 is the fix, and its
 * scope is the *facts conclusion* only: with a channel present the completion
 * observation still settles by channel edges (arming is never frozen), and
 * `factsVerified === false` means "no facts evidence this tick".
 */
export function isFactsDecisionUsable(snapshot: SessionFactsSnapshot): boolean {
  return snapshot.verdict === 'ok' && snapshot.serviceable !== false && snapshot.stale !== true
}


/** 探测观测（只交事实，HTTP carrier 由本模块拥有）。 */
export type SessionFactsProbeOutcome =
  | { kind: 'response'; status: number; body?: unknown }
  | { kind: 'failure'; reason: 'timeout' | 'network' }

/** 粗分类结果。degradation 是诊断枚举，不是用户文案。 */
export interface SessionFactsProbe {
  verdict: SessionFactsVerdict
  degradation: SessionFactsDegradation
  status: number | null
  protocol: number | null
  mode: SessionFactsMode | null
  features: readonly string[]
}

/** 一条逻辑订阅的句柄；close() 只关闭这一条（通道自身的重连阶梯仍归通道）。 */
export interface SessionFactsSubscription {
  close(): void
}

/** 订阅缝回调：与 page-channel 的 item 同形（event 名 + data 原文，按到达顺序串行）。 */
export interface SessionFactsSubscriptionHandlers {
  onItem(event: string, data: string): void
  /** 本订阅（重新）就绪；之后的 item 属于新的一段。 */
  onOpen?(): void
  /** 订阅级失败（上游结束/报错或通道断开）；通道会自行重订阅，消费方不得再排阶梯。 */
  onError?(code: string, message: string): void
}

export interface SessionFactsSourceOptions {
  sourceId: string
  /** 默认 /api/i/<sourceId>（控制面实例代理剥前缀后原样转发）。 */
  basePath?: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** 静默窗（0 = 关闭探针）；测试注入小值。 */
  silenceMs?: number
  /** poll 档重取周期（0 = 不轮询）。 */
  pollIntervalMs?: number
  /** 坏答案后的有界重探退避（默认 SESSION_FACTS_RECONNECT_MS；测试注入小值）。 */
  reconnectMs?: number
  /**
   * 长连接订阅缝：生产由 App 用 `subscribePageChannel({ family: 'sessionFacts',
   * instanceId })` 构造（重连/重订阅都归通道）；测试注入假件。缺席（或工厂
   * 抛错）时增量面退化为 pollIntervalMs 的 unary 轮询——权威面始终是 SESSION_FACTS_ROUTE 快照。
   */
  subscribeSessionFacts?: (handlers: SessionFactsSubscriptionHandlers) => SessionFactsSubscription
  /** 诊断回调（warn 一次语义由调用方决定；本模块不直接 console）。 */
  onDiagnostic?: (message: string, error?: unknown) => void
}

/** update() 的期望态：指纹变化 = 新化身（判定与订阅必须作废重来）。 */
export interface SessionFactsSourceUpdate {
  fingerprint: string
  connected: boolean
}

export interface SessionFactsSource {
  update(input: SessionFactsSourceUpdate): void
  reconcile(): void
  stop(): void
  /** undefined = 当前没有可用事实（degraded/未连接；legacy 404 两分支均给快照，不在此列）。 */
  subscribe(listener: (snapshot: SessionFactsSnapshot | undefined) => void): () => void
  onRowHint(listener: (hint: SessionFactsRowHint) => void): () => void
  /**
   * **仅测试缝（D4）**：生产零调用——订阅面 {@link subscribe} 是事实的唯一出口，运行时
   * 读面是 App 的 factsStore（判定侧经 completionObservationRef 的状态）。保留给用例做
   * 同步读回（快照相位/闩锁/降级断言）；新生产代码不得以它为接线面。
   */
  getSnapshot(): SessionFactsSnapshot | undefined
}


function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function numberOrZero(value: unknown): number {
  return isWatermark(value) ? value : 0
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * 本模块的一次性 goal 形状警告（与 derive.ts 的 warnGoalShape 同纪律）：生产端
 * 持续吐坏形状时 console 不得刷屏；纯解析函数没有 logger 缝，故由模块级旗标承担。
 */
let warnedGoalRowShape = false

/** Test-only: re-arm the one-shot goal-shape warning (node tests share the module instance). */
export function __resetSessionFactsGoalWarningForTests(): void {
  warnedGoalRowShape = false
}

const GOAL_ROW_PHASES: ReadonlySet<string> = new Set(['active', 'paused', 'blocked', 'complete'])

/**
 * 防御性解析一行的 goal 字段（v5 §6 P2a 白名单）：`undefined` = unknown（字段
 * 缺席 / 形状不符 / 空串 id），对象只保留五个契约字段。**绝不**读 objective /
 * blockedReason / roundsStarted 等其它字段。
 *
 * revision 与 gateway/control-plane/P2b 同规：安全整数且 ≥1（-1 / 0 / 小数 /
 * 不安全整数一律 unknown）；updatedAt 只接受安全整数 ≥0（isWatermark）。
 */
export function parseSessionFactsGoalFact(value: unknown): SessionFactsGoalFact | undefined {
  if (!isPlainRecord(value)) {
    warnGoalRowShape()
    return undefined
  }
  const goalId = value.goalId
  const revision = value.revision
  const phase = value.phase
  if (typeof goalId !== 'string' || goalId === '') return warnGoalRowShape()
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return warnGoalRowShape()
  if (typeof phase !== 'string' || !GOAL_ROW_PHASES.has(phase)) return warnGoalRowShape()
  const fact: SessionFactsGoalFact = { goalId, revision, phase: phase as SessionFactsGoalFact['phase'] }
  const updatedAt = value.updatedAt
  if (isWatermark(updatedAt)) fact.updatedAt = updatedAt
  const activation = value.activation
  if (activation === 'armed' || activation === 'disarmed') fact.activation = activation
  return fact
}

function warnGoalRowShape(): undefined {
  if (warnedGoalRowShape) return undefined
  warnedGoalRowShape = true
  console.warn(
    '[session-facts] row goal has an unexpected shape — treating it as UNKNOWN '
    + '(not as "no goal"); last-known goal facts stay in force',
  )
  return undefined
}

/** 防御性解析一行；无 sessionId 即 null（永不猜）。 */
export function parseSessionFactsRow(value: unknown): SessionFactsRow | null {
  if (!isPlainRecord(value)) return null
  const sessionId = stringOrNull(value.sessionId)
  if (sessionId === null) return null
  const pending = value.pendingKind === 'approval' || value.pendingKind === 'question' ? value.pendingKind : null
  const completedAtSource = value.completedAtSource === 'observed' || value.completedAtSource === 'reconstructed'
    ? value.completedAtSource
    : null
  let lastTurnEnd: SessionFactsTurnEnd | null = null
  if (isPlainRecord(value.lastTurnEnd) && typeof value.lastTurnEnd.kind === 'string') {
    // kind 词汇之外的值按「已知非完成」处理（完成判定语义）；cause 只接受 known 值。
    const rawCause = value.lastTurnEnd.cause
    const cause = rawCause === 'user' || rawCause === 'parent' || rawCause === 'hook'
      || rawCause === 'disposed' || rawCause === 'legacy'
      ? rawCause
      : undefined
    lastTurnEnd = {
      kind: value.lastTurnEnd.kind as SessionFactsTurnEndKind,
      ...(cause !== undefined ? { cause } : {}),
      at: numberOrZero(value.lastTurnEnd.at),
      ...(isWatermark(value.lastTurnEnd.seq) ? { seq: value.lastTurnEnd.seq } : {}),
    }
  }
  // goal 三值（P2a 加法字段）：字段缺席 = unknown（保持稀疏）；null = 明确无
  // goal（保留）；对象经白名单解析，坏形状 = unknown + warn-once。必须先解析再
  // 决定写入：坏形状解析为 undefined 时**不得**写出 own property goal:undefined
  // （那会让未知行带上一个假字段，绕过 Object.hasOwn 判定）。
  const goal = value.goal === undefined
    ? undefined
    : value.goal === null ? null : parseSessionFactsGoalFact(value.goal)
  return {
    sessionId,
    running: value.running === true,
    pendingKind: pending,
    subagentCount: nonNegativeInt(value.subagentCount),
    ...(value.lineageVerified === true ? { lineageVerified: true } : {}),
    ...(value.subagentKnown === true ? { subagentKnown: true } : {}),
    updatedAt: numberOrZero(value.updatedAt),
    // 缺失/非法一律 0（= 未知），绝不臆造时间戳。
    factAt: numberOrZero(value.factAt),
    completedAt: isWatermark(value.completedAt) ? value.completedAt : null,
    completedAtSource,
    lastTurnEnd,
    ...(goal === undefined ? {} : { goal }),
  }
}

function parseRows(value: unknown): Record<string, SessionFactsRow> {
  const rows: Record<string, SessionFactsRow> = {}
  if (!Array.isArray(value)) return rows
  for (const item of value) {
    const row = parseSessionFactsRow(item)
    if (row !== null) rows[row.sessionId] = row
  }
  return rows
}

/** 快照主体解析（200 响应或通道整量帧 data）；非对象/无 protocol 即 null。 */
export function parseSessionFactsSnapshotValue(value: unknown): {
  protocol: number
  mode: SessionFactsMode | null
  features: string[]
  cursor: number
  hostState: string
  serviceable: boolean
  rows: Record<string, SessionFactsRow>
  baselines?: number
} | null {
  if (!isPlainRecord(value)) return null
  if (typeof value.protocol !== 'number' || !Number.isSafeInteger(value.protocol) || value.protocol < 1) return null
  const host = isPlainRecord(value.host) ? value.host : {}
  // 诊断是加法描述字段：只看 baselines（完整基线数），其余键一概不解析。
  const diagnostics = isPlainRecord(value.diagnostics) ? value.diagnostics : null
  const baselines = diagnostics !== null && typeof diagnostics.baselines === 'number'
    && Number.isSafeInteger(diagnostics.baselines) && diagnostics.baselines >= 0
    ? diagnostics.baselines
    : undefined
  return {
    protocol: value.protocol,
    mode: value.mode === 'sse' || value.mode === 'poll' || value.mode === 'off' ? value.mode : null,
    features: Array.isArray(value.features)
      ? value.features.filter((feature): feature is string => typeof feature === 'string' && feature !== '')
      : [],
    cursor: nonNegativeInt(value.cursor),
    hostState: typeof host.state === 'string' && host.state !== '' ? host.state : 'unknown',
    serviceable: host.serviceable !== false,
    rows: parseRows(value.sessions),
    ...(baselines === undefined ? {} : { baselines }),
  }
}

/**
 * 本模块唯一的 abort 来源是 probe 的 deadline 定时器 ⇒ AbortError 即 timeout，
 * 其余 fetch 拒绝都是 network；只喂 classifier 的 outcome.reason（诊断用）。
 */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/**
 * 粗粒度协议分类（顺序即契约，逐条对齐 control-plane 的 classifySessionStateProbe；
 * 只有 404 是版本事实，5xx/超时绝不是「旧网关」）：1) 传输失败 / 5xx ⇒
 * degraded('unavailable')；2) 404 ⇒ legacy-gateway；3) 503 + session_state_disabled ⇒
 * degraded('watcher-disabled')；4) 2xx 无 protocol / 解析失败 ⇒ degraded('unversioned')；
 * 5) protocol > 1 ⇒ degraded('forward-skew')；6) protocol === 1 ⇒ ok（mode==='off' 除外）；
 * 7) mode === 'off' ⇒ degraded('watcher-disabled')。
 */
export function classifySessionFactsProbe(outcome: SessionFactsProbeOutcome): SessionFactsProbe {
  const empty = { status: null, protocol: null, mode: null, features: [] as readonly string[] }
  if (outcome.kind === 'failure') {
    return { verdict: 'degraded', degradation: 'unavailable', ...empty }
  }
  const status = outcome.status
  if (status === 404) {
    return { verdict: 'legacy-gateway', degradation: 'legacy-gateway', ...empty, status }
  }
  if (status < 200 || status >= 300) {
    const disabled = status === 503 && bodyHasDisabledCode(outcome.body)
    return {
      verdict: 'degraded',
      degradation: disabled ? 'watcher-disabled' : 'unavailable',
      ...empty,
      status,
    }
  }
  const parsed = parseSessionFactsSnapshotValue(outcome.body)
  if (parsed === null) {
    return { verdict: 'degraded', degradation: 'unversioned', ...empty, status }
  }
  const base = {
    status,
    protocol: parsed.protocol,
    mode: parsed.mode,
    features: parsed.features,
  }
  if (parsed.mode === 'off') {
    return { verdict: 'degraded', degradation: 'watcher-disabled', ...base }
  }
  if (parsed.protocol > SESSION_FACTS_PROTOCOL_VERSION) {
    return { verdict: 'degraded', degradation: 'forward-skew', ...base }
  }
  return { verdict: 'ok', degradation: null, ...base }
}

/** 503 kill-switch body：{error:'session_state_disabled'} / {code:...} / 嵌套 error.code。 */
function bodyHasDisabledCode(body: unknown): boolean {
  if (!isPlainRecord(body)) return false
  if (body.error === SESSION_FACTS_DISABLED_CODE || body.code === SESSION_FACTS_DISABLED_CODE) return true
  const nested = body.error
  return isPlainRecord(nested) && nested.code === SESSION_FACTS_DISABLED_CODE
}

/**
 * 行内容签名（变更检测；字段顺序固定，JSON 串即可）。goal 三值必须进签名：
 * 只翻相位/activation 的一次增量也要产生 row hint，否则侧栏行与收敛器读不到
 * 新相位（unknown/null/对象三态各自成码）。
 */
export function sessionFactsRowSignature(row: SessionFactsRow): string {
  return JSON.stringify([
    row.running, row.pendingKind, row.subagentCount, row.lineageVerified === true, row.subagentKnown === true, row.updatedAt,
    row.completedAt, row.completedAtSource, row.lastTurnEnd,
    row.goal === undefined ? 'u' : row.goal === null ? 'n' : [
      row.goal.goalId, row.goal.revision, row.goal.phase,
      row.goal.activation ?? null, row.goal.updatedAt ?? null,
    ],
  ])
}

/**
 * 快照行集变化提示：与增量项同一字段集与优先级（added > removed > changed）。
 * 整量帧（探测/通道 sync/snapshot）过去不发提示，只有增量项发——轮询档与重订阅后的
 * 首帧因此没有聚合刷新触发（G1 的真实通路是 提示 → unary，而不是虚拟上报）。
 */
function snapshotRowHint(
  before: SessionFactsSnapshot | undefined,
  after: SessionFactsSnapshot,
): SessionFactsRowHint | null {
  if (before === undefined) return 'added'
  let changed = false
  for (const [sessionId, row] of Object.entries(after.rows)) {
    const previous = before.rows[sessionId]
    if (previous === undefined) return 'added'
    if (!changed && sessionFactsRowSignature(previous) !== sessionFactsRowSignature(row)) changed = true
  }
  for (const sessionId of Object.keys(before.rows)) {
    if (after.rows[sessionId] === undefined) return 'removed'
  }
  return changed ? 'changed' : null
}

export interface SessionFactsDeltaOutcome {
  /** 应用后的快照；null = 幂等丢弃（游标不前进）。 */
  next: SessionFactsSnapshot | null
  /** 服务端要求整量重取（载荷坏；调用方负责）。 */
  refetch: boolean
  hint: SessionFactsRowHint | null
}

/**
 * 应用一条增量项（纯函数；调用方负责重取与 emit）。cursor <= 当前 ⇒ 幂等丢弃；
 * 行数/内容变化 → hint（优先级 added > removed > changed，与 design 06 §4.2 一致：一个
 * 混合帧只要有新行就先拉一次，拉取本身是整量快照，删除/变化同拍收敛）；坏载荷 ⇒ refetch。
 */
export function applySessionFactsDelta(current: SessionFactsSnapshot, value: unknown): SessionFactsDeltaOutcome {
  if (!isPlainRecord(value)) return { next: null, refetch: true, hint: null }
  // 非法/缺失游标一律走重取：降为 0 后会被当「更旧帧」静默丢弃，与「坏载荷 ⇒ refetch」矛盾。
  if (typeof value.cursor !== 'number' || !Number.isInteger(value.cursor) || value.cursor <= 0) {
    return { next: null, refetch: true, hint: null }
  }
  const cursor = value.cursor
  if (cursor <= current.cursor) return { next: null, refetch: false, hint: null }
  const rows = parseRows(value.sessions)
  const removed = Array.isArray(value.removedSessionIds)
    ? value.removedSessionIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  const host = isPlainRecord(value.host) ? value.host : null
  const nextRows: Record<string, SessionFactsRow> = { ...current.rows }
  let added = 0
  let changed = 0
  let removedRows = 0
  for (const [sessionId, row] of Object.entries(rows)) {
    const before = nextRows[sessionId]
    if (before === undefined) added += 1
    else if (sessionFactsRowSignature(before) !== sessionFactsRowSignature(row)) changed += 1
    // 行来源位不在网关平面赋值（P1）：added/activity/tombstone 行都会误带该位；上游
    // observeRunning 的第二支只由 status 事件触发——该位只由无壳观察者的 status 首建
    // （source-mux-facts.handleStatus），增量帧只写 wire 行。
    nextRows[sessionId] = row
  }
  for (const sessionId of removed) {
    if (nextRows[sessionId] !== undefined) {
      delete nextRows[sessionId]
      removedRows += 1
      changed += 1
    }
  }
  const mode = value.mode === 'sse' || value.mode === 'poll' || value.mode === 'off' ? value.mode : null
  const next: SessionFactsSnapshot = {
    ...current,
    mode: mode ?? current.mode,
    cursor,
    rows: nextRows,
    hostState: host !== null && typeof host.state === 'string' && host.state !== '' ? host.state : current.hostState,
    serviceable: host !== null && typeof host.serviceable === 'boolean' ? host.serviceable : current.serviceable,
    stale: false,
    lastEventAt: current.lastEventAt,
  }
  // 删除提示只按「真的删掉了行」判定：removedSessionIds 里的未知 id 不产生任何行集变化，
  // 与行内容签名同规——否则一次幽灵撤回会白触发一次整量重拉（而调用方看到的是空变化）。
  const hint = added > 0 ? 'added' : removedRows > 0 ? 'removed' : changed > 0 ? 'changed' : null
  return { next, refetch: false, hint }
}


interface SourceState {
  fingerprint: string
  /** 化身代际：指纹变化即 +1；在途 probe/refetch 的迟到结果按代作废。 */
  generation: number
  connected: boolean
  running: boolean
  snapshot: SessionFactsSnapshot | undefined
  /**
   * 是否曾投递过协议快照（ok，或带协议载荷的降级档）——即网关曾答过镜像协议。
   * 404 只在它为 false 时才是「首探从未有过行」的空权威快照；曾有历史后转 404
   * 必须保留既有行/游标（在场证据），否则无壳来源被遗忘、held pending 被清。
   */
  protocolFactsSeen: boolean
  /** 当前活跃的通道订阅（通道自己重订阅；只有换代/断连/stop 才 close）。 */
  subscription: SessionFactsSubscription | null
  /** 本次订阅的创建时刻：error 分类的窗口下界（open/item 会把 lastFrameAt 推后）。 */
  subscriptionStartedAt: number
  /** 内容水位：最后一条**带数据**的状态帧（keepalive 不动它）。 */
  lastFrameAt: number
  /** 传输水位：最后一条状态帧**或上游 keepalive**（区分「安静」与「载体已死」）。 */
  lastLivenessAt: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  probeTimer: ReturnType<typeof setTimeout> | null
  pollTimer: ReturnType<typeof setInterval> | null
  silenceTimer: ReturnType<typeof setInterval> | null
  probing: boolean
  stopped: boolean
  /**
   * 「增量帧缺 diagnostics 时补快照」的化身内已用次数与上次触发时刻（S4/T3）：增量帧
   * 不携带 diagnostics.baselines，若首个快照落在 mux ready 但首个 session/list 基线
   * 未成功的窗口，闩锁会停在 0（listComplete=false）。每代至多
   * {@link SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX} 次单飞重试；计数用尽后距上次触发满
   * {@link SESSION_FACTS_DIAGNOSTICS_REFETCH_MIN_MS} 允许新的一轮。代际切换清零。
   */
  diagnosticsRefetchAttempts: number
  lastDiagnosticsRefetchAt: number
  /** 整量补快照单飞门（坏帧/静默恢复与诊断补快照共用；T3①：同一批多条项不得并发再发 GET）。 */
  refetchInFlight: boolean
}

export function createSessionFactsSource(options: SessionFactsSourceOptions): SessionFactsSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const basePath = options.basePath ?? ('/api/i/' + options.sourceId)
  const silenceMs = options.silenceMs ?? SESSION_FACTS_SILENCE_MS
  const pollIntervalMs = options.pollIntervalMs ?? SESSION_FACTS_POLL_MS
  const reconnectMs = options.reconnectMs ?? SESSION_FACTS_RECONNECT_MS
  const listeners = new Set<(snapshot: SessionFactsSnapshot | undefined) => void>()
  const hintListeners = new Set<(hint: SessionFactsRowHint) => void>()
  const state: SourceState = {
    fingerprint: '',
    generation: 0,
    connected: false,
    running: false,
    snapshot: undefined,
    protocolFactsSeen: false,
    subscription: null,
    subscriptionStartedAt: 0,
    lastFrameAt: 0,
    lastLivenessAt: 0,
    reconnectTimer: null,
    probeTimer: null,
    pollTimer: null,
    silenceTimer: null,
    probing: false,
    stopped: false,
    diagnosticsRefetchAttempts: 0,
    lastDiagnosticsRefetchAt: 0,
    refetchInFlight: false,
  }

  const diagnostic = (message: string, error?: unknown): void => {
    options.onDiagnostic?.(message, error)
  }

  const emit = (): void => {
    if (state.stopped) return
    for (const listener of [...listeners]) listener(state.snapshot)
  }

  const emitHint = (hint: SessionFactsRowHint | null): void => {
    if (hint === null || state.stopped) return
    for (const listener of [...hintListeners]) listener(hint)
  }

  /**
   * 快照构造单一工厂：probe / 通道整量帧 / refetch 三入口共用同形状；verdict /
   * degradation 由调用点经唯一分类器传入，mode 也由调用点按入口语义给，本工厂只负责形状。
   */
  const buildSnapshot = (
    parsed: NonNullable<ReturnType<typeof parseSessionFactsSnapshotValue>>,
    verdict: SessionFactsVerdict,
    degradation: SessionFactsDegradation,
    mode: SessionFactsMode | null = parsed.mode,
  ): SessionFactsSnapshot => ({
    verdict,
    degradation,
    mode,
    hostState: parsed.hostState,
    serviceable: parsed.serviceable,
    stale: false,
    cursor: parsed.cursor,
    rows: parsed.rows,
    lastEventAt: now(),
    // 无诊断帧（旧端/增量）沿用上一份闩锁值；绝不回退成「未就绪」而误清臂。
    ...(parsed.baselines === undefined && state.snapshot?.baselines === undefined
      ? {}
      : { baselines: parsed.baselines ?? state.snapshot?.baselines }),
  })

  /**
   * 完整快照的**游标单调发布门**（T3②：probe/refetch 经 publishProbe、通道 sync 帧直接
   * 调用；与 applySessionFactsDelta 的既有 cursor 门同规）：旧游标的整量快照不得覆盖
   * 更新的快照——并发/迟到的补快照响应会把游标、行集与行记忆一起回退。被丢弃时不发
   * emit/hint（没有变化）。
   * @returns 是否真的发布（false = 旧游标，丢弃）。
   */
  const publishCompleteSnapshot = (
    parsed: NonNullable<ReturnType<typeof parseSessionFactsSnapshotValue>>,
    verdict: SessionFactsVerdict,
    degradation: SessionFactsDegradation,
    mode: SessionFactsMode | null = parsed.mode,
  ): boolean => {
    if (state.snapshot !== undefined && parsed.cursor < state.snapshot.cursor) return false
    const before = state.snapshot
    state.snapshot = buildSnapshot(parsed, verdict, degradation, mode)
    emit()
    emitHint(snapshotRowHint(before, state.snapshot))
    return true
  }

  /**
   * 无载荷降级快照工厂（legacy / disabled / unversioned / 首次失败）：拿不到协议载荷时
   * 行/游标全空是事实而不是猜测；mode 为 null。stale 默认 true（没有活载体在刷新，
   * 消费者据此降档）；legacy 例外——它按 reconnectMs 有界低频重探，快照会继续更新，按事实标 false。
   * 曾有历史后的 404 / 已有行的 unversioned 走「保留既有行 + 标不可用」出口，**不得**走本工厂
   * （那会把旧行清成权威空集）。
   */
  const buildEmptySnapshot = (
    verdict: SessionFactsVerdict,
    degradation: SessionFactsDegradation,
    stale = true,
  ): SessionFactsSnapshot => ({
    verdict,
    degradation,
    mode: null,
    hostState: 'unknown',
    serviceable: false,
    stale,
    cursor: 0,
    rows: {},
    lastEventAt: now(),
  })

  /** 清掉当前订阅的静默看门狗（closeSubscription / clearTimers 共用）。 */
  const clearSilenceTimer = (): void => {
    if (state.silenceTimer !== null) { clearInterval(state.silenceTimer); state.silenceTimer = null }
  }

  /**
   * poll 定时器的唯一 owner 是轮询交付路径（startDelivery 的 poll 分支）：订阅档一旦接管
   * 增量面就必须显式停掉它，否则通道与 30s unary 轮询会同时刷新同一来源（双份新鲜度面
   * + 多余 GET）。换代/断连/stop 的整表清理也经本函数，时钟所有权只有这一处。
   */
  const stopPollTimer = (): void => {
    if (state.pollTimer !== null) { clearInterval(state.pollTimer); state.pollTimer = null }
  }

  const clearTimers = (): void => {
    if (state.reconnectTimer !== null) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
    if (state.probeTimer !== null) { clearTimeout(state.probeTimer); state.probeTimer = null }
    stopPollTimer()
    clearSilenceTimer()
  }

  /**
   * 关掉当前逻辑订阅（换代/断连/stop）。通道自己的重连与重订阅不归这里——close() 是
   * 终态，订阅级 error 后必须让句柄继续活着等通道重订阅，绝不在这里收口。
   */
  const closeSubscription = (): void => {
    const subscription = state.subscription
    state.subscription = null
    state.subscriptionStartedAt = 0
    clearSilenceTimer()
    subscription?.close()
  }

  const markStale = (): void => {
    if (state.snapshot === undefined || state.snapshot.stale) return
    state.snapshot = { ...state.snapshot, stale: true }
    emit()
  }

  const urlFor = (suffix: string): string => basePath + suffix

  const withTimeout = (): { signal: AbortSignal; done: () => void } => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SESSION_FACTS_PROBE_TIMEOUT_MS)
    return { signal: controller.signal, done: () => clearTimeout(timer) }
  }

  /**
   * 原始快照响应（**不把 !ok 折成异常**）：HTTP 状态是判定的输入，逐条交给
   * classifySessionFactsProbe；只有传输失败（timeout/network）才走 catch。判定 owner
   * 唯一——本函数只拥有 carrier。非 2xx 与坏 JSON 体以 status/body 交回、**永不 throw**；
   * 超时经 abort 归入 failure('timeout')。
   */
  const observeProbe = async (): Promise<SessionFactsProbeOutcome> => {
    const timeout = withTimeout()
    try {
      const response = await fetchImpl(urlFor(SESSION_FACTS_ROUTE), {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: timeout.signal,
      })
      const body: unknown = await response.json().catch(() => undefined)
      return { kind: 'response', status: response.status, ...(body === undefined ? {} : { body }) }
    } catch (error) {
      // 唯一 abort 来源是 withTimeout 的 deadline ⇒ AbortError 即 timeout，其余是 network。
      return { kind: 'failure', reason: isAbortError(error) ? 'timeout' : 'network' }
    } finally {
      timeout.done()
    }
  }

  /**
   * 一次探测 = classifier 的唯一生产消费者，分类 + 发布（全源唯一判定点）：探测与整量
   * 对账重取都经 classifySessionFactsProbe，快照只携带它的 verdict/degradation，模块内不再有
   * 第二份内联分类。发布规则：2xx 且载荷可解析 ⇒ 带该载荷的行/读状态 + 分类判定并记
   * protocolFactsSeen；无载荷且已有行 ⇒ 保留旧行（在场证据不得清空）：unavailable / 曾有
   * 协议历史后的 404 / unversioned 三档分别标 stale 或 serviceable=false；其余无载荷结果
   * （legacy 首探 / disabled / 首次失败）⇒ 发布分类器判定的空快照，能力投影仍能区分三者
   * 而不是静默 undefined。
   */
  const publishProbe = (
    outcome: SessionFactsProbeOutcome,
  ): { probe: SessionFactsProbe; parsed: ReturnType<typeof parseSessionFactsSnapshotValue> } => {
    const probe = classifySessionFactsProbe(outcome)
    const is2xx = probe.status !== null && probe.status >= 200 && probe.status < 300
    const parsed = parseSessionFactsSnapshotValue(is2xx && outcome.kind === 'response' ? outcome.body : undefined)
    if (parsed !== null) {
      // 内容水位只认**游标前进**，不认「探测成功」：同游标的快照只是来源在复述既有状态，
      // 若把它算作内容进度，静默看门狗会用自己的对账响应重置水位，真实的静默年龄被掩盖
      // （载体的增量面可能早已停摆）。游标门拒绝的迟到快照更不得计数——否则一次迟到拒绝
      // 就清掉正在累积的静默对账。首份观测没有前游标，按基线盖章。
      const priorCursor = state.snapshot?.cursor
      state.protocolFactsSeen = true
      const published = publishCompleteSnapshot(parsed, probe.verdict, probe.degradation)
      if (published && (priorCursor === undefined || parsed.cursor > priorCursor)) state.lastFrameAt = now()
      return { probe, parsed }
    }
    const previous = state.snapshot
    if (previous === undefined) {
      // legacy 是唯一带活重探的 empty 结果：快照会继续刷新，按事实标 non-stale；其余保持 stale。
      state.snapshot = buildEmptySnapshot(probe.verdict, probe.degradation, probe.verdict !== 'legacy-gateway')
      emit()
      return { probe, parsed: null }
    }
    if (probe.verdict === 'legacy-gateway') {
      // 首探从未见过协议行 = 该网关没有镜像协议的权威空集；曾有历史后 404 = 保留旧行/游标
      // 只标不可用（整体清空等于宣告全体会话消失，observeSource 触发遗忘结算、held pending 被清）。
      state.snapshot = state.protocolFactsSeen
        ? {
            ...previous,
            verdict: 'legacy-gateway',
            degradation: 'legacy-gateway',
            serviceable: false,
            stale: true,
          }
        : buildEmptySnapshot('legacy-gateway', 'legacy-gateway')
      emit()
      return { probe, parsed: null }
    }
    if (probe.degradation === 'unavailable') {
      markStale()
      return { probe, parsed: null }
    }
    if (probe.degradation === 'unversioned') {
      // 2xx 非协议载荷：通道不可用（unknown），不是权威空行集；保留既有行 + stale，等有界重探。
      if (previous.verdict === 'degraded' && previous.degradation === 'unversioned' && previous.stale) {
        return { probe, parsed: null }
      }
      state.snapshot = {
        ...previous,
        verdict: 'degraded',
        degradation: 'unversioned',
        serviceable: false,
        stale: true,
      }
      emit()
      return { probe, parsed: null }
    }
    // disabled / forward-skew 等其余无载荷结果：**不是**权威空行集。空行集会让在场集判空 ⇒
    // observeSource 走遗忘结算、held pending 被清、已武装的行被撤（design 19 §3.5）。
    // 与 unversioned 同规：保留既有行 + stale（等有界重探/通道自愈）。
    if (previous.verdict === probe.verdict && previous.degradation === probe.degradation && previous.stale) {
      return { probe, parsed: null }
    }
    state.snapshot = {
      ...previous,
      verdict: probe.verdict,
      degradation: probe.degradation,
      serviceable: false,
      stale: true,
    }
    emit()
    return { probe, parsed: null }
  }

  /**
   * 坏答案是否值得**有界重试**（probe 与整量对账重取共用的唯一谓词；只答「是否重试」，
   * 退避动作归调用路径）：unavailable / unversioned 是 carrier 层可能自愈的答案；404
   * legacy 是版本事实但网关升级后应被自动接回，也给有界低频重探；forward-skew 与
   * watcher-disabled 重试无意义。
   */
  const shouldRetryProbe = (probe: SessionFactsProbe): boolean =>
    probe.degradation === 'unavailable'
    || probe.degradation === 'unversioned'
    || probe.degradation === 'legacy-gateway'

  const probeOnce = async (): Promise<void> => {
    if (state.probing || state.stopped || !state.connected) return
    state.probing = true
    const generation = state.generation
    try {
      const outcome = await observeProbe()
      if (state.stopped || !state.connected || generation !== state.generation) return
      const { probe, parsed } = publishProbe(outcome)
      if (probe.verdict === 'ok' && parsed !== null) {
        startDelivery(parsed.mode, parsed.features)
        return
      }
      // 重试裁决唯一在 shouldRetryProbe（分类语义不变，重试只是 carrier 层兜底）。
      if (shouldRetryProbe(probe)) {
        diagnostic(
          probe.degradation === 'unversioned' ? '[session-facts] probe unversioned' : '[session-facts] probe failed',
          new Error('session-state probe ' + String(probe.status ?? outcome.kind)),
        )
        scheduleProbe(reconnectMs)
      }
    } finally {
      // 只有仍属当前代的 finally 才能释放单飞门：指纹翻转会重置门并由新代另起 probe，
      // 旧代迟到时若照样清零，reconcile 会在新代在途时叠发第三条并发 unary GET。
      if (generation === state.generation) state.probing = false
    }
  }

  const scheduleProbe = (delayMs: number): void => {
    if (state.stopped || !state.connected || state.probeTimer !== null) return
    state.probeTimer = setTimeout(() => {
      state.probeTimer = null
      void probeOnce()
    }, delayMs)
  }

  /**
   * 静默看门狗在订阅 **OPEN** 时武装，两条水位分开看（通道的 keepalive 与内容帧不是一回事）：
   * - **内容水位** `lastFrameAt`：只有带数据的状态帧才推后。窗口内没有内容 ⇒ 一次整量对账
   *   （idle 但健康的来源也要保持新鲜，这就是 sse 模式下唯一的新鲜度面）。
   * - **传输水位** `lastLivenessAt`：内容帧与上游 keepalive item 都推后。传输仍活 ⇒ 只对账、
   *   **不标 stale**——把「安静」误报成降级正是要消灭的假事实；传输也静默 ⇒ 标 stale（活载体
   *   确实消失，直到下一次 admissible success 才清）。
   * **绝不 close 订阅**——close 是终态，关了通道就不再重订阅这条流；半死上游的重建由
   * control-plane 的 error 帧 + 通道阶梯承担，这里只把权威面拉回一致。
   */
  const armSilenceWatchdog = (): void => {
    if (silenceMs <= 0 || state.silenceTimer !== null) return
    state.silenceTimer = setInterval(() => {
      if (state.stopped) return
      const at = now()
      if (at - state.lastFrameAt <= silenceMs) return
      const transportAlive = state.lastLivenessAt > 0 && at - state.lastLivenessAt <= silenceMs
      diagnostic('[session-facts] session-facts channel silent beyond ' + String(silenceMs) + 'ms; reconciling via snapshot'
        + (transportAlive ? ' (transport alive; not marking stale)' : ''))
      if (!transportAlive) markStale()
      void refetchSnapshot()
    }, Math.max(1000, Math.floor(silenceMs / 3)))
  }

  /**
   * 订阅 OPEN：载体重启了一段。刷新活性水位（静默窗从 open 或最后一条 item 起算）并
   * 武装看门狗；stale 不在这里清——它只由一次 admissible success（整量帧/增量帧）清。
   */
  const handleSubscriptionOpen = (): void => {
    const at = now()
    state.lastFrameAt = at
    state.lastLivenessAt = at
    armSilenceWatchdog()
  }

  /**
   * 订阅级失败（上游结束/报错或通道断开）。通道会自行重订阅，这里只做三件事：按唯一
   * 分类器给这次失败定性并记证据账本、把事实标 stale（活载体已消失，直到下一次
   * admissible success）、诊断一行。**绝不自排重连阶梯、也绝不 close 句柄**——close 是
   * 终态，关了通道就不会再重订阅这条流。
   */
  const handleSubscriptionError = (code: string, message: string): void => {
    const windowStart = state.lastFrameAt > 0 ? state.lastFrameAt : state.subscriptionStartedAt
    const at = now()
    // 与旧的建连 deadline 同一分类纪律：窗口内页面确实没被调度过 ⇒ unscheduled，
    // booked=false（页面自身调度的事实不能记成来源故障）；否则 channel/deadline ⇒ booked=true。
    const verdict = classifyObservation({
      outcome: 'error',
      errorName: code,
      errorMessage: message,
      schedulingGap: hadSchedulingGap(windowStart, at),
    })
    const detail = {
      source: options.sourceId,
      topic: 'page-channel sessionFacts',
      code,
      message,
      windowMs: at - windowStart,
    }
    recordEvidence('facts-stream', verdict, detail, isAdmissible(verdict))
    diagnostic(
      '[session-facts] session-facts channel failed (' + code + '); channel resubscribes, awaiting an admissible success',
      new Error(message),
    )
    markStale()
  }

  /**
   * 打开当前代的逻辑订阅（幂等：已有句柄即返回 true）。缝缺席或工厂抛错 ⇒ false，调用
   * 方退回 unary 轮询——权威快照仍是 facts 的唯一行源。
   */
  const ensureSubscription = (): boolean => {
    if (state.subscription !== null) return true
    const factory = options.subscribeSessionFacts
    if (factory === undefined) return false
    state.subscriptionStartedAt = now()
    // 订阅是「期望交付」的开始：两个水位与静默看门狗从这一刻起算，而不是等第一次 open。
    // 否则一条挂起的握手（或整体不可用的通道）会停在 sse 路径上——没有 item 推内容水位、
    // 没有 open 武装看门狗、startDelivery 又把 unary 轮询停掉——事实永远 stale 且无人再试。
    // 看门狗的既有判据正好覆盖这段：内容静默 + 传输不活 ⇒ markStale + unary 权威快照。
    state.lastFrameAt = state.subscriptionStartedAt
    state.lastLivenessAt = state.subscriptionStartedAt
    armSilenceWatchdog()
    try {
      state.subscription = factory({
        onItem: (event, data) => { applyItem(event, data) },
        onOpen: () => { handleSubscriptionOpen() },
        onError: (code, message) => { handleSubscriptionError(code, message) },
      })
      return true
    } catch (error) {
      state.subscriptionStartedAt = 0
      diagnostic('[session-facts] channel subscribe failed; falling back to unary polling', error)
      return false
    }
  }

  const startDelivery = (mode: SessionFactsMode | null, features: readonly string[]): void => {
    if (mode === 'sse' && features.includes('session-state.stream') && ensureSubscription()) {
      // 订阅已接管增量面：两档互斥，停掉旧轮询（ensureSubscription 失败则仍回退轮询档）。
      stopPollTimer()
      return
    }
    if (pollIntervalMs <= 0 || state.pollTimer !== null) return
    state.pollTimer = setInterval(() => { void probeOnce() }, pollIntervalMs)
  }

  /**
   * 应用一条订阅项（event 名 + data 原文；与旧 SSE 帧逐字同规，游标由载荷携带）。
   * 任何一条 item 都是载体活着的观察：先刷新活性水位。data 坏 ⇒ 一次整量对账；
   * resync ⇒ 对账；sync/snapshot 是整量帧（走游标单调门）；其余按增量项应用。
   */
  const applyItem = (event: string, data: string): void => {
    const at = now()
    state.lastLivenessAt = at
    // 上游 keepalive（data 为空）：只是传输活着的证据，不是状态帧——不解析、不动内容水位。
    if (isPageChannelKeepaliveItem(event, data)) return
    state.lastFrameAt = at
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      diagnostic('[session-facts] malformed session-facts item; refetching snapshot')
      void refetchSnapshot()
      return
    }
    if (event === 'resync') {
      void refetchSnapshot()
      return
    }
    if (event === 'sync' || event === 'snapshot') {
      const parsed = parseSessionFactsSnapshotValue(value)
      if (parsed === null) { void refetchSnapshot(); return }
      // 整量帧与 probe/refetch 共用同一道游标单调门：旧 sync 帧不得回退快照。
      publishCompleteSnapshot(parsed, 'ok', null, parsed.mode ?? state.snapshot?.mode ?? 'sse')
      return
    }
    const current = state.snapshot
    if (current === undefined) { void refetchSnapshot(); return }
    const outcome = applySessionFactsDelta(current, value)
    if (outcome.refetch) { void refetchSnapshot(); return }
    if (outcome.next === null) return
    state.snapshot = { ...outcome.next, lastEventAt: now() }
    emit()
    emitHint(outcome.hint)
    // 增量帧不带 diagnostics：闩锁若仍是 0，每代最多补 SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX
    // 次 unary 快照（有界收敛，不动 wire）。一次性去重会被首个「仍是 0」的快照消耗掉，闩锁
    // 永久卡在 0（listComplete=false ⇒ 权威列表清除与 beforeBaseline 支悬空）；连续 0 重试、
    // 拿到 ≥1 立即停，既收敛又不抖动。unknown（旧端从未给过诊断）同样按 0 处理。
    // 单飞：在途补快照不再叠发（同一批多条项只算一次）；计数用尽后距上次触发满
    // SESSION_FACTS_DIAGNOSTICS_REFETCH_MIN_MS 允许新的一轮（首基线可能更晚成功）。
    if ((state.snapshot.baselines ?? 0) === 0 && !state.refetchInFlight) {
      const exhausted = state.diagnosticsRefetchAttempts >= SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX
      if (!exhausted || now() - state.lastDiagnosticsRefetchAt >= SESSION_FACTS_DIAGNOSTICS_REFETCH_MIN_MS) {
        if (exhausted) state.diagnosticsRefetchAttempts = 0
        state.diagnosticsRefetchAttempts += 1
        state.lastDiagnosticsRefetchAt = now()
        void refetchSnapshot()
      }
    }
  }

  const refetchSnapshot = async (): Promise<void> => {
    // 单飞：坏帧/静默恢复与诊断补快照共用这一个在途门，不并发叠发整量 GET。
    if (state.stopped || !state.connected || state.refetchInFlight) return
    state.refetchInFlight = true
    const generation = state.generation
    try {
      const outcome = await observeProbe()
      if (state.stopped || generation !== state.generation) return
      const { probe, parsed } = publishProbe(outcome)
      if (probe.verdict === 'ok' && parsed !== null) {
        startDelivery(parsed.mode, parsed.features)
        return
      }
      // 该重取是坏帧/静默后的再对账：与 probe 共用 shouldRetryProbe，恢复动作是**同一条
      // unary 有界重探**——流载体的重建归通道，本模块不得再排流重连阶梯；版本/服务事实
      // 不重探，也不留静止降级。
      if (shouldRetryProbe(probe)) {
        diagnostic(
          '[session-facts] snapshot refetch failed',
          new Error('session-state probe ' + String(probe.status ?? outcome.kind)),
        )
        scheduleProbe(reconnectMs)
      }
    } finally {
      // 与 probeOnce 同一纪律：旧代迟到不得释放新代的整量对账单飞门。
      if (generation === state.generation) state.refetchInFlight = false
    }
  }

  const resetForFingerprint = (): void => {
    state.generation += 1
    state.running = false
    closeSubscription()
    clearTimers()
    state.snapshot = undefined
    state.protocolFactsSeen = false
    state.lastFrameAt = 0
    state.lastLivenessAt = 0
    state.probing = false
    state.diagnosticsRefetchAttempts = 0
    state.lastDiagnosticsRefetchAt = 0
    state.refetchInFlight = false
    emit()
  }

  const update = (input: SessionFactsSourceUpdate): void => {
    state.stopped = false
    if (input.fingerprint !== state.fingerprint) {
      state.fingerprint = input.fingerprint
      resetForFingerprint()
    }
    if (input.connected === state.connected) {
      if (input.connected && !state.running) {
        state.running = true
        void probeOnce()
      }
      return
    }
    state.connected = input.connected
    if (!input.connected) {
      state.running = false
      closeSubscription()
      clearTimers()
      markStale()
      return
    }
    state.running = true
    void probeOnce()
  }

  const stop = (): void => {
    state.stopped = true
    // stop() 也是代际边界：同一指纹复活时 stopped/connected 会被 update() 翻回，只有代际
    // 比较能拦住旧代在途探测的迟到结果（绝不作为新化身的事实发布）。
    state.generation += 1
    state.connected = false
    state.running = false
    closeSubscription()
    clearTimers()
    state.snapshot = undefined
    state.probing = false
    state.refetchInFlight = false
  }

  return {
    update,
    reconcile() { void probeOnce() },
    stop,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onRowHint(listener) {
      hintListeners.add(listener)
      return () => { hintListeners.delete(listener) }
    },
    /** 仅测试缝（D4）：生产零调用，见接口注释。 */
    getSnapshot() { return state.snapshot },
  }
}
