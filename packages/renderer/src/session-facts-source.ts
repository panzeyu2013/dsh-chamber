/**
 * Gateway session-state facts source。
 *
 * 只读事实源，**浏览器安全**（零 Node import；只用 fetch / ReadableStream /
 * 定时器；测试全部经注入的 fetchImpl 驱动）：
 *   - 探测 GET  {base}/chamber/session-state（每来源单飞、一次、Abort 超时）；
 *   - 分类**粗粒度**（权威分类器在 packages/control-plane/src/session-state-protocol.ts，
 *     本包不能 import 它：exports map 只有 "." 且 barrel 拉 Node 代码）：
 *       404 ⇒ legacy-gateway（首探从未有过行 = 空权威快照；曾有历史后 = 保留旧行
 *         标不可用）；其余非 ok ⇒ degraded；2xx 且 protocol 命中 ⇒ ok。
 *     共享字面量由 test/session-state/session-facts-source.test.ts 的源文本锁步测试
 *     对着该模块钉住（route 路径 / protocol / session-state_disabled / serviceable /
 *     completedAtSource），两侧不得静默漂移；
 *   - mode === 'sse' 时消费 SSE 增量（sync / session-state / resync，id 单调游标，
 *     重连带 Last-Event-ID；心跳注释帧只用于活性）；
 *   - mode === 'poll' 时按 pollIntervalMs 重取快照（降级不静默）；
 *   - 静默超时（连在、事件停）⇒ 关流重订阅并整量重取快照，期间标 stale。
 *   - ack 上行（/read、/read-all）失败（网络错误 / 5xx）进 unread-store 的
 *     有界待发表；probe 快照 / SSE sync·增量·心跳任一「通道恢复」点重放，
 *     成功才出队。重放幂等（服务端单调 max），且绝不阻塞读推进。
 *
 * 行数据只承载会话元数据（sessionId / running / pendingKind / 水位），**绝不**
 * 带 title/cwd/消息（隐私条）。判定输入（completedAt/updatedAt/
 * lastTurnEnd）刻意留在本模块产物里，不过侧栏投影（derive.ts 的反 churn 纪律）。
 */

/** 快照路由后缀；与 control-plane/src/session-state-protocol.ts 的
 *  SESSION_STATE_PATH 逐字节相同（源文本锁步测试钉住）。 */
export const SESSION_FACTS_ROUTE = '/chamber/session-state'
export const SESSION_FACTS_STREAM_ROUTE = '/chamber/session-state/stream'
export const SESSION_FACTS_READ_ROUTE = '/chamber/session-state/read'
export const SESSION_FACTS_READ_ALL_ROUTE = '/chamber/session-state/read-all'

/** 本客户端支持的接口主版本；与 control-plane 的 PROTOCOL_VERSION 锁步。 */
export const SESSION_FACTS_PROTOCOL_VERSION = 1

/** 503 kill-switch body 的稳定错误码（锁步字面量）。 */
export const SESSION_FACTS_DISABLED_CODE = 'session_state_disabled'

/** 探测超时（对齐协议模块 SESSION_STATE_PROBE_TIMEOUT_MS 的一次调用预算）。 */
export const SESSION_FACTS_PROBE_TIMEOUT_MS = 5_000

/**
 * 流建连/首字节 deadline：同一条 HTTP 通道上的同类等待，与 probe 同预算。
 * 到点按「流断开」收口（abort + markStale + 诊断 + 有界重连）——半死隧道下
 * 裸 fetch 可能永不落定，没有它这条流会带着 streamStarted=true 永久楔死：
 * 无 stale、无重连、该来源未读/通知/行刷新静默冻结。
 */
export const SESSION_FACTS_STREAM_CONNECT_TIMEOUT_MS = SESSION_FACTS_PROBE_TIMEOUT_MS

/**
 * 流断开后的重连退避（固定值，有界）。刻意与 source-mux-facts 的 1s→30s
 * 指数退避不同：本源的载体是 HTTP 快照 + SSE 事件流，断开路径自身另有 5s
 * 首字节期限与 60s 静默看门狗，固定 3s 已把重试压到低频；source-mux 是 WS
 * 基线 + 单飞探针，需要更慢的封顶退避。数值差异是载体差异，两侧的阈值表
 * 同一 owner（LADDER_TABLES），退避节奏各自拥有。
 */
export const SESSION_FACTS_RECONNECT_MS = 3_000

/** 静默探针周期：超过该时长没有任何帧（含心跳注释）即重订阅。 */
export const SESSION_FACTS_SILENCE_MS = 60_000

/** poll 档的快照重取周期（与 30s unary watchdog 同量级）。 */
export const SESSION_FACTS_POLL_MS = 30_000

import { isWatermark } from './watermark.ts'
import { createUnreadAckOutbox, type UnreadAckMethod } from './unread-store.ts'

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

/** 判定输入；形状与 sidebar shared 的 TurnEndFact 结构兼容（可直接喂 deriveUnread）。 */
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
  subagentCount: number
  /** host 域内容水位（epoch ms）；0 = 未知。 */
  updatedAt: number
  /**
   * 完成边沿时刻。**时钟域见 {@link SessionFactsRow.completedAtDomain}**：
   * 取到 host `turn/end.time` 时是 host 域；拿不到时是观察者域（降级）。
   */
  completedAt: number | null
  /**
   * observed = 实时观察且带 host 时间戳（可通知）；reconstructed = **缺口重建**（gateway 跨重启）
   * 或**拿不到 host 时间的降级戳**（无壳观察者），两者都只出未读、不发通知。
   */
  completedAtSource: SessionFactsCompletedAtSource | null
  /**
   * 完成戳的时钟域：`host` = 可直接与读水位比较；`observer` = 客户端观察者时钟，
   * **只用于武装、不得推进 host 域读标记**（`unread-derivation` 的 factsWatermark 据此剔除）。
   * 缺席 = host 域（gateway 行不携带）。
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
}

/** 服务端来源级读状态（本机读标记由 unread-store 持有；此处是跨端权威的那一份）。 */
export interface SessionFactsReadState {
  clientId: string | null
  marks: Readonly<Record<string, number>>
  floor: number
}

export interface SessionFactsSnapshot {
  verdict: SessionFactsVerdict
  degradation: SessionFactsDegradation
  mode: SessionFactsMode | null
  /** host 生命周期（gateway 平面）；serviceable=false 时行只读作未知。 */
  hostState: string
  serviceable: boolean
  /** 流断/静默/断连时 true；这些只读事实仍会被渲染并明确标注。 */
  stale: boolean
  cursor: number
  rows: Readonly<Record<string, SessionFactsRow>>
  read: SessionFactsReadState | null
  lastEventAt: number | null
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
  /** 流建连/首字节 deadline（默认 SESSION_FACTS_STREAM_CONNECT_TIMEOUT_MS；测试注入小值）。 */
  streamConnectTimeoutMs?: number
  /** 重连退避（probe 失败与流断开共用；默认 SESSION_FACTS_RECONNECT_MS；测试注入小值）。 */
  reconnectMs?: number
  /** 待发 ack 队列上限（条目数；默认 UNREAD_PENDING_MAX；测试注入小值）。 */
  ackQueueMax?: number
  /** 诊断回调（warn 一次语义由调用方决定；本模块不直接 console）。 */
  onDiagnostic?: (message: string, error?: unknown) => void
}

/** update() 的期望态：指纹变化 = 新化身（判定与流必须作废重来）。 */
export interface SessionFactsSourceUpdate {
  fingerprint: string
  connected: boolean
}

export interface SessionFactsSource {
  update(input: SessionFactsSourceUpdate): void
  stop(): void
  /** undefined = 当前没有可用事实（degraded/未连接；legacy 404 两分支均给快照，不在此列）。 */
  subscribe(listener: (snapshot: SessionFactsSnapshot | undefined) => void): () => void
  onRowHint(listener: (hint: SessionFactsRowHint) => void): () => void
  getSnapshot(): SessionFactsSnapshot | undefined
  /** 单会话读水位上行（幂等 max；失败只 warn，本地为准）。 */
  ackRead(clientId: string, sessionId: string, readThrough: number): void
  /** 来源级 read-all 水位上行（客户端给 through，服务端不取当下）。 */
  ackAllRead(clientId: string, through: number): void
}

// ── 纯解析 / 判定（node:test 直测） ─────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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
    // 已知 kind 词汇之外的值按「已知非完成」处理（deriveUnread 的语义），
    // 但类型面向已知族收敛；cause 只接受 known 值，其余视为缺席。
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

/** 服务端 read 状态；主体缺失时 null（不是「全已读」）。 */
export function parseSessionFactsReadState(value: unknown): SessionFactsReadState | null {
  if (!isPlainRecord(value)) return null
  const marks: Record<string, number> = {}
  if (isPlainRecord(value.marks)) {
    for (const [sessionId, mark] of Object.entries(value.marks)) {
      if (isWatermark(mark)) marks[sessionId] = mark
    }
  }
  return {
    clientId: stringOrNull(value.clientId),
    marks,
    floor: isWatermark(value.floor) ? value.floor : 0,
  }
}

/** 快照主体解析（200 响应或 SSE sync data）；非对象/无 protocol 即 null。 */
export function parseSessionFactsSnapshotValue(value: unknown): {
  protocol: number
  mode: SessionFactsMode | null
  features: string[]
  cursor: number
  hostState: string
  serviceable: boolean
  rows: Record<string, SessionFactsRow>
  read: SessionFactsReadState | null
} | null {
  if (!isPlainRecord(value)) return null
  if (typeof value.protocol !== 'number' || !Number.isSafeInteger(value.protocol) || value.protocol < 1) return null
  const host = isPlainRecord(value.host) ? value.host : {}
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
    read: parseSessionFactsReadState(value.read),
  }
}

/**
 * 本模块唯一的 abort 来源是 probe 的 deadline 定时器（withTimeout）⇒ AbortError
 * 即 timeout；其余 fetch 拒绝都是 network。只喂 classifier 的 outcome.reason
 * （诊断用），不参与判定。
 */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/**
 * 粗粒度协议分类（顺序即契约，逐条对齐 control-plane 的
 * classifySessionStateProbe；只有 404 是版本事实，5xx/超时绝不是「旧网关」）：
 *   1. 传输失败 / 5xx ⇒ degraded('unavailable')
 *   2. 404            ⇒ legacy-gateway
 *   3. 503 + session_state_disabled ⇒ degraded('watcher-disabled')
 *   4. 2xx 无 protocol / 解析失败  ⇒ degraded('unversioned')
 *   5. protocol > 1   ⇒ degraded('forward-skew')（不静默）
 *   6. protocol === 1 ⇒ ok（mode==='off' 除外）
 *   7. mode === 'off' ⇒ degraded('watcher-disabled')
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
    row.running, row.pendingKind, row.subagentCount, row.updatedAt,
    row.completedAt, row.completedAtSource, row.lastTurnEnd,
    row.goal === undefined ? 'u' : row.goal === null ? 'n' : [
      row.goal.goalId, row.goal.revision, row.goal.phase,
      row.goal.activation ?? null, row.goal.updatedAt ?? null,
    ],
  ])
}

export interface SessionFactsDeltaOutcome {
  /** 应用后的快照；null = 幂等丢弃（游标不前进）。 */
  next: SessionFactsSnapshot | null
  /** 服务端要求整量重取（载荷坏；调用方负责）。 */
  refetch: boolean
  hint: SessionFactsRowHint | null
}

/**
 * 应用一帧 SSE 增量（纯函数；调用方负责重取与 emit）。
 * - cursor <= 当前 cursor ⇒ 幂等丢弃（重复/更旧 id）；
 * - 行数变化 / 行内容变化 → hint（added > removed > changed 优先级）；
 * - 坏载荷 ⇒ refetch（丢帧的收敛路径）。
 */
export function applySessionFactsDelta(current: SessionFactsSnapshot, value: unknown): SessionFactsDeltaOutcome {
  if (!isPlainRecord(value)) return { next: null, refetch: true, hint: null }
  // 非法/缺失游标一律走重取：nonNegativeInt 会把它们降到 0，随后按「更旧帧」**静默丢弃**——
  // 这与本模块「坏载荷 ⇒ refetch」的契约矛盾（真丢帧会被当成重复）。
  if (typeof value.cursor !== 'number' || !Number.isInteger(value.cursor) || value.cursor <= 0) {
    return { next: null, refetch: true, hint: null }
  }
  const cursor = value.cursor
  if (cursor <= current.cursor) return { next: null, refetch: false, hint: null }
  const rows = parseRows(value.sessions)
  const removed = Array.isArray(value.removedSessionIds)
    ? value.removedSessionIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  const read = value.read === undefined || value.read === null ? null : parseSessionFactsReadState(value.read)
  const host = isPlainRecord(value.host) ? value.host : null
  const nextRows: Record<string, SessionFactsRow> = { ...current.rows }
  let added = 0
  let changed = 0
  for (const [sessionId, row] of Object.entries(rows)) {
    const before = nextRows[sessionId]
    if (before === undefined) added += 1
    else if (sessionFactsRowSignature(before) !== sessionFactsRowSignature(row)) changed += 1
    nextRows[sessionId] = row
  }
  for (const sessionId of removed) {
    if (nextRows[sessionId] !== undefined) {
      delete nextRows[sessionId]
      changed += 1
    }
  }
  const mode = value.mode === 'sse' || value.mode === 'poll' || value.mode === 'off' ? value.mode : null
  const next: SessionFactsSnapshot = {
    ...current,
    mode: mode ?? current.mode,
    cursor,
    rows: nextRows,
    read: read ?? current.read,
    hostState: host !== null && typeof host.state === 'string' && host.state !== '' ? host.state : current.hostState,
    serviceable: host !== null && typeof host.serviceable === 'boolean' ? host.serviceable : current.serviceable,
    stale: false,
    lastEventAt: current.lastEventAt,
  }
  const hint = removed.length > 0 ? 'removed' : added > 0 ? 'added' : changed > 0 ? 'changed' : null
  return { next, refetch: false, hint }
}

/** 一帧 SSE 文本块的解析结果；注释块（心跳）返回 null。 */
export interface SessionFactsSseFrame { event: string; id: number | null; data: string }

export function parseSessionFactsSseBlock(block: string): SessionFactsSseFrame | null {
  const lines = block.replace(/\r\n?/g, '\n').split('\n')
  let event = ''
  let id: number | null = null
  const data: string[] = []
  let sawField = false
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const raw = colon === -1 ? '' : line.slice(colon + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'event') { event = value; sawField = true }
    else if (field === 'data') { data.push(value); sawField = true }
    else if (field === 'id') {
      sawField = true
      const parsed = Number(value)
      id = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
    }
  }
  if (!sawField || data.length === 0) return null
  return { event, id, data: data.join('\n') }
}

// ── 事实源实例 ───────────────────────────────────────────────────────────────

interface SourceState {
  fingerprint: string
  /** 化身代际：指纹变化即 +1；在途 probe/stream/refetch 的迟到结果按代作废。 */
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
  streamController: AbortController | null
  streamStarted: boolean
  /** 当前在途流的建连/首字节 deadline 定时器（正常收头或 closeStream 后必须清）。 */
  streamConnectTimer: ReturnType<typeof setTimeout> | null
  lastEventId: number | null
  lastFrameAt: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  probeTimer: ReturnType<typeof setTimeout> | null
  pollTimer: ReturnType<typeof setInterval> | null
  silenceTimer: ReturnType<typeof setInterval> | null
  probing: boolean
  stopped: boolean
}

export function createSessionFactsSource(options: SessionFactsSourceOptions): SessionFactsSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const basePath = options.basePath ?? ('/api/i/' + options.sourceId)
  const silenceMs = options.silenceMs ?? SESSION_FACTS_SILENCE_MS
  const pollIntervalMs = options.pollIntervalMs ?? SESSION_FACTS_POLL_MS
  const streamConnectTimeoutMs = options.streamConnectTimeoutMs ?? SESSION_FACTS_STREAM_CONNECT_TIMEOUT_MS
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
    streamController: null,
    streamStarted: false,
    streamConnectTimer: null,
    lastEventId: null,
    lastFrameAt: 0,
    reconnectTimer: null,
    probeTimer: null,
    pollTimer: null,
    silenceTimer: null,
    probing: false,
    stopped: false,
  }

  const diagnostic = (message: string, error?: unknown): void => {
    options.onDiagnostic?.(message, error)
  }

  /**
   * 有界待发 ack 队列（unread-store.createUnreadAckOutbox）：失败（网络
   * 错误 / 5xx）的 /read、/read-all 在此等待重放，2xx 才出队；读推进永不等待它。
   */
  const ackOutbox = createUnreadAckOutbox({
    fetchImpl,
    ...(options.ackQueueMax === undefined ? {} : { maxPending: options.ackQueueMax }),
    onError: error => diagnostic('[session-facts] read ack', error),
  })

  /**
   * 既有「通道恢复」钩子（不新造轮子）：服务端真的回了一帧/一块——probe 快照、
   * SSE sync、增量帧、心跳注释或 resync 后的整量重取——就是同一条 HTTP/SSE
   * 通道恢复或仍在的证据。此刻重放待发 ack。只触发不等待（void）：待发表
   * 永远不得阻塞读推进或快照投递；单飞由 outbox 自己保证。
   */
  const noteChannelAlive = (): void => {
    if (state.stopped || !state.connected || ackOutbox.size() === 0) return
    void ackOutbox.replay()
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
   * 快照构造单一工厂：probe / SSE sync 帧 / refetch 三个入口共用同形状对象，
   * 字段一旦增删不会漂移。verdict / degradation / mode 仍由调用点
   * 按各自入口语义给（SSE 帧的 mode 缺失时沿用上一份快照），本工厂只负责形状。
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
    read: parsed.read,
    lastEventAt: now(),
  })

  /**
   * 空快照工厂（legacy/degraded 共用）：路由 404 且**从未有过协议行** = 该网关
   * 没有镜像协议，行/游标/read 全空是**事实**而不是猜测；verdict/degradation 由
   * classifier 给。它让 legacy 也走同一个形状出口，不再手写第三份
   * SessionFactsSnapshot。曾有历史后的 404 走「保留既有行 + 标不可用」出口，
   * **不得**走本工厂（那会把旧行清成权威空集）。
   */
  const buildEmptySnapshot = (
    verdict: SessionFactsVerdict,
    degradation: SessionFactsDegradation,
  ): SessionFactsSnapshot => ({
    verdict,
    degradation,
    mode: null,
    hostState: 'unknown',
    serviceable: false,
    stale: false,
    cursor: 0,
    rows: {},
    read: null,
    lastEventAt: now(),
  })

  /** 清掉当前流的静默看门狗（closeStream / clearTimers 共用）。 */
  const clearSilenceTimer = (): void => {
    if (state.silenceTimer !== null) { clearInterval(state.silenceTimer); state.silenceTimer = null }
  }

  /**
   * 清掉当前流的建连 deadline。显式传 timer 时只清「就是它自己」的那只：
   * 一条被 timeout/stop 收口后仍迟到的旧流，不得清掉后继流的定时器。
   */
  const clearStreamConnectTimer = (timer?: ReturnType<typeof setTimeout>): void => {
    if (timer === undefined) {
      if (state.streamConnectTimer === null) return
      timer = state.streamConnectTimer
    } else if (state.streamConnectTimer !== timer) {
      return
    }
    state.streamConnectTimer = null
    clearTimeout(timer)
  }

  const clearTimers = (): void => {
    if (state.reconnectTimer !== null) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
    if (state.probeTimer !== null) { clearTimeout(state.probeTimer); state.probeTimer = null }
    if (state.pollTimer !== null) { clearInterval(state.pollTimer); state.pollTimer = null }
    clearSilenceTimer()
    clearStreamConnectTimer()
  }

  const closeStream = (): void => {
    state.streamStarted = false
    state.streamController?.abort()
    state.streamController = null
    clearSilenceTimer()
    clearStreamConnectTimer()
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
   * classifySessionFactsProbe；只有传输失败（timeout/network）才走 catch。
   * 判定 owner 因此唯一 —— 本函数只拥有 carrier。
   */
  const fetchSnapshotResponse = async (): Promise<Response> => {
    const timeout = withTimeout()
    try {
      return await fetchImpl(urlFor(SESSION_FACTS_ROUTE), {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: timeout.signal,
      })
    } finally {
      timeout.done()
    }
  }

  /**
   * 一次探测 = **classifier 的唯一生产消费者**（2026-12 单源化）：carrier 事实
   * （status/body/failure）先组装成 SessionFactsProbeOutcome，判定只由
   * classifySessionFactsProbe 做，这里只按 verdict 分派既有语义。
   * 404 ⇒ legacy 快照（不再是 undefined）：首探从未有过协议行为空权威集，
   * 曾有历史后保留旧行 + stale/serviceable=false（在场证据不得清空）；
   * 2xx 非协议载荷 ⇒ 保留既有行 + stale（不整体清空）；
   * 降级协议载荷 ⇒ 仍投递降级快照；传输失败/5xx ⇒ stale + 有界重探。
   */
  const probeOnce = async (): Promise<void> => {
    if (state.probing || state.stopped || !state.connected) return
    state.probing = true
    const generation = state.generation
    try {
      let failure: unknown
      let outcome: SessionFactsProbeOutcome
      let parsed: ReturnType<typeof parseSessionFactsSnapshotValue> = null
      try {
        const response = await fetchSnapshotResponse()
        const body = await response.json().catch(() => undefined)
        outcome = { kind: 'response', status: response.status, ...(body === undefined ? {} : { body }) }
        if (response.ok) parsed = parseSessionFactsSnapshotValue(body)
      } catch (error) {
        failure = error
        outcome = { kind: 'failure', reason: isAbortError(error) ? 'timeout' : 'network' }
      }
      if (state.stopped || !state.connected || generation !== state.generation) return
      const classified = classifySessionFactsProbe(outcome)
      if (classified.verdict === 'ok' && parsed !== null) {
        state.snapshot = buildSnapshot(parsed, 'ok', classified.degradation)
        state.protocolFactsSeen = true
        state.lastEventId = parsed.cursor
        emit()
        noteChannelAlive()
        startDelivery(parsed.mode, classified.features)
        return
      }
      if (parsed !== null) {
        // 2xx 协议载荷但降级（protocol > 1 的 forward-skew / mode off 的
        // watcher-disabled）：保留既有语义——仍投递这份降级快照（侧栏档位靠它），
        // 但不启动交付（不轮询、不开流）。协议载荷出现过即记 history（见 404 分支）。
        state.snapshot = buildSnapshot(parsed, classified.verdict, classified.degradation)
        state.protocolFactsSeen = true
        state.lastEventId = parsed.cursor
        emit()
        return
      }
      if (classified.verdict === 'legacy-gateway') {
        // 404 是版本事实，但**只有首探从未见过协议载荷**时才是「该网关没有镜像
        // 协议」的权威空行集：给一份空行 legacy 快照（不再是 undefined）——只有它
        // 能让 session-facts-mode 的 'legacy' 档位可达；网关可能升级，继续低频探测。
        //
        // 曾有历史（此前 ok/降级协议载荷已投递过行）后转 404：网关掉了镜像协议
        // （回滚/路由拆除），行集不再是**权威**，但行本身仍是无壳来源唯一的在场
        // 证据——整体清空等于宣告全体会话消失（observeSource 触发遗忘结算、held
        // pending 被清）。保留既有行/游标/read，只标不可用：stale + serviceable=false、
        // verdict/degradation 仍 legacy-gateway（侧栏 'legacy' 档位语义不变）；
        // 行与水位绝不推进，恢复 ok 时由新快照重新成为权威。
        const previous = state.snapshot
        if (previous === undefined || !state.protocolFactsSeen) {
          state.snapshot = buildEmptySnapshot('legacy-gateway', 'legacy-gateway')
        } else {
          state.snapshot = {
            ...previous,
            verdict: 'legacy-gateway',
            degradation: 'legacy-gateway',
            serviceable: false,
            stale: true,
          }
        }
        emit()
        scheduleProbe(reconnectMs)
        return
      }
      if (outcome.kind === 'response' && outcome.status >= 200 && outcome.status < 300) {
        // 2xx 非协议载荷（classifier: unversioned）：通道**不可用（unknown）**，
        // 不是权威空行集。无壳来源的在场证据就是这些行：整体清空等于宣告全体
        // 会话消失（并触发遗忘结算）。保留既有行 + stale/degradation 标注——
        // 消费侧按 observeSource 的纪律用原始行键判在场、按 factsUsable=false
        // 停止判定；capability 档位因此显示 degraded，而不是沉默（不折成 legacy）。
        // 非协议载荷可能是瞬时（反代/网关升级窗口）：与 404/5xx 同一有界重探
        // 纪律，三条出口（首探空快照 / 已表达同事实 / 保留既有行）都排下一次
        // 探测——否则一次坏载荷就让 facts 永久不可用，只有 connected false→true
        // 或指纹变化才解围。scheduleProbe 自带幂等 guard。
        const previous = state.snapshot
        if (previous === undefined) {
          state.snapshot = { ...buildEmptySnapshot('degraded', 'unversioned'), stale: true }
          emit()
        } else if (previous.verdict === 'degraded' && previous.degradation === 'unversioned' && previous.stale === true) {
          // 已表达过同一事实：不制造快照 churn（重探继续，见下方 scheduleProbe）。
        } else {
          state.snapshot = {
            ...previous,
            verdict: 'degraded',
            degradation: 'unversioned',
            serviceable: false,
            stale: true,
          }
          emit()
        }
        scheduleProbe(reconnectMs)
        return
      }
      markStale()
      diagnostic('[session-facts] probe failed', failure ?? outcome)
      scheduleProbe(reconnectMs)
    } finally {
      state.probing = false
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
   * 静默看门狗：在**请求发起时**武装（而不是响应头到达之后）——建连/首字节
   * 挂起同样是「通道静默」，晚武装会让半死隧道既无 stale 也无重连。间隔保留
   * 1s floor 防高频；真正的收口判据仍是 lastFrameAt。
   */
  const armSilenceWatchdog = (): void => {
    if (silenceMs <= 0 || state.silenceTimer !== null) return
    state.silenceTimer = setInterval(() => {
      if (state.stopped || now() - state.lastFrameAt <= silenceMs) return
      diagnostic('[session-facts] stream silent beyond ' + String(silenceMs) + 'ms; resubscribing')
      closeStream()
      markStale()
      void refetchSnapshot()
    }, Math.max(1000, Math.floor(silenceMs / 3)))
  }

  const startDelivery = (mode: SessionFactsMode | null, features: readonly string[]): void => {
    if (mode === 'sse' && features.includes('session-state.stream')) {
      void streamLoop()
      return
    }
    if (pollIntervalMs <= 0 || state.pollTimer !== null) return
    state.pollTimer = setInterval(() => { void probeOnce() }, pollIntervalMs)
  }

  const applyFrame = (frame: SessionFactsSseFrame): void => {
    state.lastFrameAt = now()
    if (frame.id !== null) state.lastEventId = frame.id
    let data: unknown
    try {
      data = JSON.parse(frame.data)
    } catch {
      diagnostic('[session-facts] malformed SSE data; refetching snapshot')
      void refetchSnapshot()
      return
    }
    if (frame.event === 'resync') {
      void refetchSnapshot()
      return
    }
    if (frame.event === 'sync' || frame.event === 'snapshot') {
      const parsed = parseSessionFactsSnapshotValue(data)
      if (parsed === null) { void refetchSnapshot(); return }
      state.snapshot = buildSnapshot(parsed, 'ok', null, parsed.mode ?? state.snapshot?.mode ?? 'sse')
      state.lastEventId = parsed.cursor
      emit()
      return
    }
    const current = state.snapshot
    if (current === undefined) { void refetchSnapshot(); return }
    const outcome = applySessionFactsDelta(current, data)
    if (outcome.refetch) { void refetchSnapshot(); return }
    if (outcome.next === null) return
    state.snapshot = { ...outcome.next, lastEventAt: now() }
    emit()
    emitHint(outcome.hint)
  }

  const refetchSnapshot = async (): Promise<void> => {
    if (state.stopped || !state.connected) return
    const generation = state.generation
    closeStream()
    state.lastEventId = null
    try {
      const response = await fetchSnapshotResponse()
      // refetch 与 probe 的收口不同：这里没有分类任务，只有"重取成败"，任何非 2xx
      // 都按既有语义走 catch（stale + 有界重连）。
      if (!response.ok) throw new Error('session-state refetch answered ' + String(response.status))
      const body = await response.json()
      if (state.stopped || generation !== state.generation) return
      const parsed = parseSessionFactsSnapshotValue(body)
      if (parsed === null) return
      state.snapshot = buildSnapshot(parsed, 'ok', null)
      state.lastEventId = parsed.cursor
      emit()
      noteChannelAlive()
      startDelivery(parsed.mode, parsed.features)
    } catch (error) {
      markStale()
      diagnostic('[session-facts] snapshot refetch failed', error)
      scheduleStreamReconnect()
    }
  }

  const scheduleStreamReconnect = (): void => {
    if (state.stopped || !state.connected || state.reconnectTimer !== null) return
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
      void streamLoop()
    }, reconnectMs)
  }

  const streamLoop = async (): Promise<void> => {
    if (state.stopped || !state.connected || state.streamStarted) return
    const generation = state.generation
    state.streamStarted = true
    const controller = new AbortController()
    state.streamController = controller
    state.lastFrameAt = now()
    // 静默看门狗在**请求发起时**即武装：建连/首字节挂起同样是「通道静默」。
    armSilenceWatchdog()
    // 建连/首字节 deadline：到点按「流断开」收口。收口动作放在定时器里而不是
    // 依赖 fetch 因 abort 而 reject —— 忽略 abort 的 carrier 也必须被收口，
    // 且 catch 侧对 aborted 的早退不得把这次失败吞成「静默」（半死隧道下
    // 这条流会带着 streamStarted=true 永久楔死）。
    const connectTimer = setTimeout(() => {
      if (state.stopped || state.streamController !== controller) return
      diagnostic('[session-facts] stream connect timed out after ' + String(streamConnectTimeoutMs) + 'ms; reconnecting')
      markStale()
      closeStream()
      scheduleStreamReconnect()
    }, streamConnectTimeoutMs)
    state.streamConnectTimer = connectTimer
    try {
      const headers: Record<string, string> = { accept: 'text/event-stream' }
      if (state.lastEventId !== null) headers['last-event-id'] = String(state.lastEventId)
      const response = await fetchImpl(urlFor(SESSION_FACTS_STREAM_ROUTE), {
        method: 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
      // 响应头到达 = 建连成功：建连 deadline 退场，静默交给看门狗。
      clearStreamConnectTimer(connectTimer)
      if (generation !== state.generation) return
      if (!response.ok) throw new Error('stream answered ' + String(response.status))
      const body = response.body
      if (body === null || typeof body.getReader !== 'function') throw new Error('stream body unavailable')
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        buffer = buffer.replace(/\r\n?/g, '\n')
        let index = buffer.indexOf('\n\n')
        while (index !== -1) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          if (block.trim() !== '') {
            state.lastFrameAt = now()
            // 心跳注释帧也证明通道仍在：同样是一次既有的「通道恢复」信号。
            noteChannelAlive()
            const frame = parseSessionFactsSseBlock(block)
            if (frame !== null) applyFrame(frame)
          }
          index = buffer.indexOf('\n\n')
        }
      }
      throw new Error('stream ended')
    } catch (error) {
      if (state.stopped || controller.signal.aborted) return
      markStale()
      diagnostic('[session-facts] stream closed', error)
      closeStream()
      scheduleStreamReconnect()
    }
  }

  const resetForFingerprint = (): void => {
    state.generation += 1
    state.running = false
    closeStream()
    clearTimers()
    state.snapshot = undefined
    state.protocolFactsSeen = false
    state.lastEventId = null
    state.lastFrameAt = 0
    state.probing = false
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
      closeStream()
      clearTimers()
      markStale()
      return
    }
    state.running = true
    void probeOnce()
  }

  const stop = (): void => {
    state.stopped = true
    state.connected = false
    state.running = false
    closeStream()
    clearTimers()
    state.snapshot = undefined
    state.probing = false
  }

  const ack = (method: UnreadAckMethod, route: string, body: Record<string, unknown>): void => {
    // 载荷纪律与重放归 unread-store（键白名单 / 幂等 max / 有界待发表 /
    // never-throw），源只负责方法、URL 与「通道恢复」触发点。
    ackOutbox.post(options.sourceId, method, urlFor(route), body)
  }

  return {
    update,
    stop,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onRowHint(listener) {
      hintListeners.add(listener)
      return () => { hintListeners.delete(listener) }
    },
    getSnapshot() { return state.snapshot },
    ackRead(clientId, sessionId, readThrough) {
      ack('read', SESSION_FACTS_READ_ROUTE, { clientId, sessionId, readThrough })
    },
    ackAllRead(clientId, through) {
      ack('read-all', SESSION_FACTS_READ_ALL_ROUTE, { clientId, through })
    },
  }
}
