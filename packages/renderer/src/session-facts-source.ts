/**
 * Gateway session-state facts source。只读、浏览器安全（零 Node import；只用 fetch /
 * ReadableStream / 定时器）。分类**粗粒度且只有一份**：classifySessionFactsProbe 是本
 * 客户端唯一分类器（权威分类器在 control-plane 的 session-state-protocol，状态语义逐条
 * 对齐；本包不能 import 它）；probe 与流恢复重取都调用它，模块内不得再内联判定：
 * 404 ⇒ legacy-gateway；503 + session_state_disabled / mode off ⇒ watcher-disabled；
 * 其余非 ok ⇒ degraded；2xx 且 protocol 命中 ⇒ ok。共享字面量（route 路径 / protocol /
 * session_state_disabled / serviceable / completedAtSource）是跨包单一来源，不得本地改写。
 * mode === 'sse' 消费 SSE 增量（id 单调游标，重连带 Last-Event-ID；心跳只作活性）；
 * mode === 'poll' 按 pollIntervalMs 重取快照；静默超时 ⇒ 关流重订阅并整量重取，期间标
 * stale。ack 上行失败进 unread-store 有界待发表，通道恢复点重放，成功才出队（幂等，
 * 绝不阻塞读推进）。行数据只承载会话元数据，**绝不**带 title/cwd/消息。
 */

/** 快照路由后缀；与 control-plane 的 SESSION_STATE_PATH 逐字节相同（跨包锁步，不得本地改写）。 */
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
 * 流建连/首字节 deadline：与 probe 同预算。到点按「流断开」收口（abort + markStale +
 * 诊断 + 有界重连）——半死隧道下裸 fetch 可能永不落定，否则流会带着 streamStarted=true
 * 永久楔死：无 stale、无重连、未读/通知/行刷新静默冻结。
 */
export const SESSION_FACTS_STREAM_CONNECT_TIMEOUT_MS = SESSION_FACTS_PROBE_TIMEOUT_MS

/**
 * 流断开后的重连退避（固定、有界）。刻意与 source-mux-facts 的 1s→30s 指数退避不同：
 * 本源的载体是 HTTP 快照 + SSE 事件流，断开路径另有 5s 首字节期限与 60s 静默看门狗，
 * 固定 3s 已把重试压到低频；数值差异是载体差异，两侧阈值表同一 owner，退避节奏各自拥有。
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

/** 判定输入；形状与 client-core 的 TurnEndFact 结构兼容（可直接喂 deriveUnread）。 */
export interface SessionFactsTurnEnd {
  kind: SessionFactsTurnEndKind
  cause?: SessionFactsTurnEndCause
  at: number
  seq?: number
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
   * 完成边沿时刻；时钟域见 {@link SessionFactsRow.completedAtDomain}：取到 host
   * `turn/end.time` 时是 host 域，拿不到时是观察者域（降级）。
   */
  completedAt: number | null
  /** observed = 实时观察且带 host 时间戳（可通知）；reconstructed = 缺口重建或拿不到
   *  host 时间的降级戳，两者都只出未读、不发通知。 */
  completedAtSource: SessionFactsCompletedAtSource | null
  /**
   * 完成戳的时钟域：`host` = 可直接与读水位比较；`observer` = 客户端观察者时钟，
   * **只用于武装、不得推进 host 域读标记**；缺席 = host 域。
   */
  completedAtDomain?: 'host' | 'observer' | null
  lastTurnEnd: SessionFactsTurnEnd | null
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
  /** 传输档（gateway 平面）；SSE sync 帧缺失时沿用上一份快照，绝不静默丢档。 */
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
  /** undefined = 当前没有可用事实（legacy/degraded/未连接）。 */
  subscribe(listener: (snapshot: SessionFactsSnapshot | undefined) => void): () => void
  onRowHint(listener: (hint: SessionFactsRowHint) => void): () => void
  getSnapshot(): SessionFactsSnapshot | undefined
  /** 单会话读水位上行（幂等 max；失败只 warn，本地为准）。 */
  ackRead(clientId: string, sessionId: string, readThrough: number): void
  /** 来源级 read-all 水位上行（客户端给 through，服务端不取当下）。 */
  ackAllRead(clientId: string, through: number): void
}


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
    // kind 词汇之外的值按「已知非完成」处理（deriveUnread 语义）；cause 只接受 known 值。
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

/** 行内容签名（变更检测；字段顺序固定，JSON 串即可）。 */
export function sessionFactsRowSignature(row: SessionFactsRow): string {
  return JSON.stringify([
    row.running, row.pendingKind, row.subagentCount, row.updatedAt,
    row.completedAt, row.completedAtSource, row.lastTurnEnd,
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
 * 应用一帧 SSE 增量（纯函数；调用方负责重取与 emit）。cursor <= 当前 ⇒ 幂等丢弃；
 * 行数/内容变化 → hint（added > removed > changed）；坏载荷 ⇒ refetch（丢帧的收敛路径）。
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


interface SourceState {
  fingerprint: string
  /** 化身代际：指纹变化即 +1；在途 probe/stream/refetch 的迟到结果按代作废。 */
  generation: number
  connected: boolean
  running: boolean
  snapshot: SessionFactsSnapshot | undefined
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
   * 有界待发 ack 队列（unread-store.createUnreadAckOutbox）：失败（网络错误 / 5xx）的
   * /read、/read-all 在此等待重放，2xx 才出队；读推进永不等待它。
   */
  const ackOutbox = createUnreadAckOutbox({
    fetchImpl,
    ...(options.ackQueueMax === undefined ? {} : { maxPending: options.ackQueueMax }),
    onError: error => diagnostic('[session-facts] read ack', error),
  })

  /**
   * 既有「通道恢复」钩子：服务端真的回了一帧/一块（probe 快照、SSE sync、增量帧、
   * 心跳注释或 resync 后的整量重取）就是同一条通道恢复的证据，此刻重放待发 ack。
   * 只触发不等待（void），单飞由 outbox 保证。
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
   * 快照构造单一工厂：probe / SSE sync / refetch 三入口共用同形状；verdict /
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
    read: parsed.read,
    lastEventAt: now(),
  })

  /**
   * 无载荷降级快照工厂（legacy / disabled / unversioned / 首次失败）：拿不到协议载荷时
   * 行/游标/read 全空是事实而不是猜测；mode 为 null。stale 默认 true（没有活载体在刷新，
   * 消费者据此降档）；legacy 例外——它按 reconnectMs 有界低频重探，快照会继续更新，按事实标 false。
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
    read: null,
    lastEventAt: now(),
  })

  /** 清掉当前流的静默看门狗（closeStream / clearTimers 共用）。 */
  const clearSilenceTimer = (): void => {
    if (state.silenceTimer !== null) { clearInterval(state.silenceTimer); state.silenceTimer = null }
  }

  /**
   * 清掉当前流的建连 deadline；显式传 timer 时只清「就是它自己」的那只：迟到的旧流
   * 不得清掉后继流的定时器。
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
   * 一次探测 = classifier 的唯一生产消费者，分类 + 发布（全源唯一判定点）：探测与流恢复
   * 重取都经 classifySessionFactsProbe，快照只携带它的 verdict/degradation，模块内不再有
   * 第二份内联分类。发布规则：2xx 且载荷可解析 ⇒ 带该载荷的行/读状态 + 分类判定；
   * unavailable 且已有快照 ⇒ 保留行、标 stale（不擦除既有镜像事实）；其余无载荷结果
   * （legacy / disabled / unversioned / 首次失败）⇒ 发布分类器判定的空快照，能力投影
   * 仍能区分三者而不是静默 undefined。
   */
  const publishProbe = (
    outcome: SessionFactsProbeOutcome,
  ): { probe: SessionFactsProbe; parsed: ReturnType<typeof parseSessionFactsSnapshotValue> } => {
    const probe = classifySessionFactsProbe(outcome)
    const is2xx = probe.status !== null && probe.status >= 200 && probe.status < 300
    const parsed = parseSessionFactsSnapshotValue(is2xx && outcome.kind === 'response' ? outcome.body : undefined)
    if (parsed !== null) {
      state.snapshot = buildSnapshot(parsed, probe.verdict, probe.degradation)
      state.lastEventId = parsed.cursor
      emit()
      noteChannelAlive()
      return { probe, parsed }
    }
    if (probe.degradation === 'unavailable' && state.snapshot !== undefined) {
      markStale()
      return { probe, parsed: null }
    }
    // legacy 是唯一带活重探的 empty 结果：快照会继续刷新，按事实标 non-stale；其余保持 stale。
    state.snapshot = buildEmptySnapshot(probe.verdict, probe.degradation, probe.verdict !== 'legacy-gateway')
    emit()
    return { probe, parsed: null }
  }

  /**
   * 坏答案是否值得**有界重试**（probe 与流恢复重取共用的唯一谓词；只答「是否重试」，
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
   * 静默看门狗在**请求发起时**武装：建连/首字节挂起同样是通道静默，晚武装会让半死隧道
   * 既无 stale 也无重连；真正的收口判据仍是 lastFrameAt。
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
    const outcome = await observeProbe()
    if (state.stopped || generation !== state.generation) return
    const { probe, parsed } = publishProbe(outcome)
    if (probe.verdict === 'ok' && parsed !== null) {
      startDelivery(parsed.mode, parsed.features)
      return
    }
    // 该重取是流收口后的再对账：与 probe 共用 shouldRetryProbe，但恢复动作是重连流；
    // 版本/服务事实不重连假流，也不留静止降级。
    if (shouldRetryProbe(probe)) {
      diagnostic(
        '[session-facts] snapshot refetch failed',
        new Error('session-state probe ' + String(probe.status ?? outcome.kind)),
      )
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
    armSilenceWatchdog()
    // 建连/首字节 deadline：到点按流断开收口。收口动作放定时器里而不是依赖 fetch 因 abort
    // reject——忽略 abort 的 carrier 也必须被收口，且 catch 侧早退不得把这次失败吞成静默。
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
    // 载荷纪律与重放归 unread-store（键白名单/幂等 max/有界待发表/never-throw），源只负责方法、URL 与触发点。
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
