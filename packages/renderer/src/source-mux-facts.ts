/**
 * Source mux facts —— SSH / 本地 dsh 来源的**无壳观察者**。
 *
 * WHY：网关来源有只读镜像（/chamber/session-state），而 SSH/本地 dsh 来源没有——它们在
 * 没有挂载壳时**没有任何事实通道**，于是"关壳期间完成"仍会丢。出口判据是
 * 「无壳仍能观察完成；不依赖 gateway 版本」，本模块就是那条通道。
 *
 * 讲的是**实例自己的**远程协议，经控制面既有无鉴权实例代理（v1 /api/i/*，代理注入
 * host 的 browser-auth cookie）——帧契约已实测冻结：
 *   MUX = ws://<origin>/api/i/<id>/api/remote.mux
 *   → {type:'open', streamId, endpoint:'$events', payload:{args:{}}}
 *   ← {type:'item', streamId, value:{type:'ready'|'emit'|'waterfall'|'cancel'}}
 *   unary session/list: POST <origin>/api/i/<id>/api/session/list
 *          ← {type:'server-response', rpcId, result:{ok, value}}
 *   session/follow: MUX {type:'open', streamId, endpoint:'session/follow', payload}
 *          ← {type:'item', streamId, value:{type:'snapshot'|'event', ...}}
 *
 * 两条硬纪律：
 *   1. 观察者**绝不发** `$events/result`——那会把等待中的审批替所有客户端结算掉；
 *      瀑布帧只观察，不回答；
 *   2. 每条 true→false 边沿发起一次有界 `session/follow` 读尾巴 `turn/end.reason`，
 *      据此分类：completed ⇒ 武装；aborted+cause=user ⇒ 用户停止；其余 ⇒ 中立；
 *      读不到 ⇒ 降级（只武装未读、不发通知）；后续基线重试分类。
 *
 * 基线与边沿纪律：
 *   - 基线 true→false（重订阅后唯一证据）走与 status 边沿同一条 readTail 路径；
 *   - 基线只合 running/updatedAt(max)/factAt；新提示水位撤销上一轮完成，
 *     false→false 的新提示须读到严格晚于提示的 turn/end 才能认定新完成；
 *   - 连接代际（generation）——被换掉的 socket 的迟到回调不得改状态或调度重连；
 *   - status 为未知会话建档，added/activity/removed 都被消费；
 *   - completedAt 优先取 host 的 turn/end.time（>= 1e12 才算可用），拿不到就用
 *         观察者戳并标 completedAtSource=reconstructed（诚实降级，不发通知）；
 *   - session/list 与 session/follow 各有 deadline，超时计失败并走既有降级；
 *   - stop() 后在途读取不再 emit，并摘下 __dshChamberSourceMux 本源项。
 *
 * 与 gateway 事实源的**同形**是刻意的：产出的快照直接喂 App 既有的 applySessionFacts
 * 管线，不需要第二条判定路径（同一份事实、同一套未读判定）。
 */
import { isRecord } from '@dsh-chamber/dsh-chamber-client-core'
import type {
  SessionFactsCompletedAtSource, SessionFactsRow, SessionFactsSnapshot, SessionFactsTurnEnd,
} from './session-facts-source.ts'
import { isWatermark } from './watermark.ts'
import { TABLE_SNAPSHOT } from '@dsh-chamber/dsh-stream-state'

export interface MuxSocket {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event?: unknown) => void) | null
  onerror: ((event?: unknown) => void) | null
}

export interface SourceMuxDeps {
  sourceId: string
  /** 页面 origin（控制面窗口同源）——不是 host origin。 */
  origin: string
  /** 测试缝：默认 new WebSocket(url)。 */
  openSocket?: (url: string) => MuxSocket
  fetchImpl?: typeof fetch
  now?: () => number
  /** 快照/增量到达（与 gateway 事实源同形）。 */
  onSnapshot: (snapshot: SessionFactsSnapshot) => void
  /** 事件静默窗口（默认 45s，与 watcher 一致）。 */
  silenceTimeoutMs?: number
  /** session/list 基线 deadline（默认 5s；半死隧道下不得永久挂起）。 */
  baselineTimeoutMs?: number
  /** 每条边沿 session/follow 的 deadline（默认 2s，与 control-plane/session-mux.ts 同预算）。 */
  followTimeoutMs?: number
  /** 与事件静默重连独立的低频对账；即使 socket 持续有帧也能修复丢失的 status。 */
  reconcileIntervalMs?: number
}

export const MUX_PATH = '/api/remote.mux'
export const EVENTS_ENDPOINT = '$events'
export const DEFAULT_FACTS_SILENCE_MS = 45_000
/** 基线 unary deadline——半死隧道下「挂起」必须在预算内变成可数的失败。 */
export const DEFAULT_BASELINE_TIMEOUT_MS = 5_000
/** 完成边沿读尾 deadline（对齐 control-plane/session-mux.ts 的 2s 预算）。 */
export const DEFAULT_FOLLOW_TIMEOUT_MS = 2_000
export const DEFAULT_RECONCILE_INTERVAL_MS = 30_000
/** 可用 host 时间（epoch ms）的下界；小于它的数字不是 host 域观测，绝不臆造。 */
export const HOST_EPOCH_MS_FLOOR = 1e12

/**
 * 一行观察者事实。除 gateway SessionFactsRow 的字段外，多一个**客户端内部**的
 * 时间域标注（不进 wire）：
 *   - 'host'     = completedAt 取自 host 的 turn/end.time（epoch ms，可进 host 域水位）；
 *   - 'observer' = completedAt 是客户端观察者戳（拿不到 host 时间时的降级，只武装未读，
 *                  绝不推进 host 域读水位；见 unread-derivation.ts 的 factsWatermark）。
 * 未标注 = 非本源（gateway 事实源）的行，读水位照旧并入 completedAt。
 */
export type SessionMuxCompletedAtDomain = 'host' | 'observer'
export interface SourceMuxRow extends SessionFactsRow {
  completedAtDomain?: SessionMuxCompletedAtDomain
}

/**
 * An observed status edge can be classified from its tail. A prompt gap is
 * weaker evidence: session/list's updatedAt is the last user prompt time, so
 * only a turn/end strictly AFTER that prompt can establish a new conclusion.
 * Object identity fences an older read when a newer prompt or run supersedes it.
 */
interface PendingTail {
  readonly runVersion: number | undefined
  readonly afterPromptAt: number | null
}

/**
 * Which sources the no-shell observer covers. The mux path is the dsh host's own
 * protocol (`/api/remote.mux`) reached through the instance proxy, so it applies to
 * every dsh-protocol source: remote SSH instances AND the managed LOCAL profile
 * (`/api/i/local/api/remote.mux`). Gateway sources have the read-only
 * /chamber/session-state mirror instead and are excluded here.
 */
export function isMuxObservableSourceKind(kind: string): boolean {
  return kind === 'local' || kind === 'dsh'
}

/** 实例代理基址（v1 /api/i/* 无鉴权边界，代理注入 host cookie）。 */
export function muxBaseFor(origin: string, sourceId: string): string {
  return origin.replace(/\/+$/, '') + '/api/i/' + encodeURIComponent(sourceId)
}

export function muxUrlFor(origin: string, sourceId: string): string {
  return muxBaseFor(origin, sourceId).replace(/^http/, 'ws') + MUX_PATH
}

/** 观察者的开场帧：打开 $events（**不**发 result）。 */
export function openEventsFrame(streamId = 'events'): string {
  return JSON.stringify({ type: 'open', streamId, endpoint: EVENTS_ENDPOINT, payload: { args: {} } })
}

/** turn/end 分类（与 gateway watcher 同规；源文本锁步见测试）。 */
export function classifyTurnEndWire(reason: unknown): 'completed' | 'user-stopped' | 'neutral' {
  if (reason === null || typeof reason !== 'object') return 'neutral'
  const value = reason as { kind?: unknown; cause?: unknown }
  if (value.kind === 'completed') return 'completed'
  if (value.kind === 'aborted') return value.cause === 'user' ? 'user-stopped' : 'neutral'
  return 'neutral'
}

interface ParsedFrame {
  kind: 'ready' | 'emit' | 'waterfall' | 'cancel' | 'other' | 'stream-end' | 'stream-error'
  streamId: string
  event?: string
  args?: unknown
  value?: unknown
}

export function parseMuxFrame(raw: unknown): ParsedFrame | null {
  let message: unknown = raw
  if (typeof raw === 'string') {
    try {
      message = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (message === null || typeof message !== 'object') return null
  const frame = message as { type?: unknown; streamId?: unknown; value?: unknown }
  if (typeof frame.streamId !== 'string') return null
  if (frame.type === 'end') return { kind: 'stream-end', streamId: frame.streamId }
  if (frame.type === 'error') return { kind: 'stream-error', streamId: frame.streamId }
  if (frame.type !== 'item') return null
  const value = frame.value as { type?: unknown; event?: unknown; args?: unknown; clientId?: unknown; eventId?: unknown; agentId?: unknown } | null
  if (value === null || typeof value !== 'object') return { kind: 'other', streamId: frame.streamId }
  if (value.type === 'ready' && typeof value.clientId === 'string'
      && value.clientId.length > 0) return { kind: 'ready', streamId: frame.streamId }
  if (value.type === 'emit' && typeof value.event === 'string' && value.event.length > 0) {
    // args 原样透传：冻结 wire 是数组，但 handler 各自承诺兼容历史对象形
    // （parseStatusArgs 的注释即契约）；在这里归一成 [] 会静默丢掉对象形边沿。
    return { kind: 'emit', streamId: frame.streamId, event: value.event, args: value.args }
  }
  if (value.type === 'waterfall' && typeof value.event === 'string' && value.event.length > 0
      && typeof value.eventId === 'string' && value.eventId.length > 0
      && typeof value.agentId === 'string' && value.agentId.length > 0) return { kind: 'waterfall', streamId: frame.streamId }
  if (value.type === 'cancel' && typeof value.eventId === 'string'
      && value.eventId.length > 0) return { kind: 'cancel', streamId: frame.streamId }
  return { kind: 'other', streamId: frame.streamId, value: frame.value }
}

/** host 域 epoch ms 校验（整数且 >= 1e12 才算可用）；不可用一律 null，绝不臆造。 */
export function hostEpochMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= HOST_EPOCH_MS_FLOOR
    ? value
    : null
}

/** 新行的默认形状（无完成、无等待、无子代理）：后续事件只改它自己的字段。 */
export function emptyRow(sessionId: string, running: boolean, updatedAt: number): SourceMuxRow {
  return {
    sessionId,
    running,
    pendingKind: null,
    subagentCount: 0,
    updatedAt,
    completedAt: null,
    completedAtSource: null,
    lastTurnEnd: null,
    // 本模块的观察时刻由写入点补齐（新建行还没有被观察过 ⇒ 0）。
    factAt: 0,
  }
}

/** 从 unary session/list 的 item 取行（与 watcher 的基线字段同源）。 */
export function rowFromListItem(item: unknown): SourceMuxRow | null {
  if (item === null || typeof item !== 'object') return null
  const value = item as { sessionId?: unknown; running?: unknown; updatedAt?: unknown }
  if (typeof value.sessionId !== 'string' || value.sessionId === '') return null
  // Official SessionSummary requires both fields. Missing `running` must not
  // become false: that would forge a true→false completion during a baseline.
  if (typeof value.running !== 'boolean' || !isWatermark(value.updatedAt)) return null
  return emptyRow(value.sessionId, value.running, value.updatedAt)
}

/**
 * api-session/status 的载荷。冻结 wire 是 [sessionId, running]；
 * 对象形 {sessionId, running} 是历史/测试形，一并接受（绝不因形状漂移丢边沿）。
 */
export function parseStatusArgs(args: unknown): { sessionId: string; running: boolean } | null {
  if (Array.isArray(args)) {
    const sessionId = args[0]
    if (typeof sessionId !== 'string' || sessionId === '' || typeof args[1] !== 'boolean') return null
    return { sessionId, running: args[1] }
  }
  if (isRecord(args)) {
    const sessionId = args.sessionId
    if (typeof sessionId !== 'string' || sessionId === '' || typeof args.running !== 'boolean') return null
    return { sessionId, running: args.running }
  }
  return null
}

/** 完成边沿读尾一次取多少条尾记录（与 control-plane/session-mux.ts 的预算一致）。 */
export const FOLLOW_MAX_MESSAGES = 8

/**
 * session/follow 的载荷：Remote 形参名是 request（载荷写错会得到
 * gateway/arguments-invalid）。与 control-plane/src/session-mux.ts 的
 * buildSessionFollowPayload 同形。
 */
export function followPayload(sessionId: string, maxMessages = FOLLOW_MAX_MESSAGES): unknown {
  return { args: { request: { address: { kind: 'session', sessionId }, maxMessages } } }
}

export interface FollowTailRead {
  /** 原始 tail turn/end（legacy 形原样保存；records 形补齐 at/seq）。 */
  turnEnd: SessionFactsTurnEnd | null
  /** host 域的 turn/end 时间（epoch ms）；null = 拿不到 ⇒ 降级为观察者戳。 */
  hostTime: number | null
}

const EMPTY_FOLLOW_TAIL: FollowTailRead = { turnEnd: null, hostTime: null }

/**
 * 一条 records/event 记录 → tail。冻结 wire（control-plane/session-mux.ts）：
 *   { type:'event', event:{ type:'turn/end', seq, time, data:{ reason } } }
 * event.time 是 SessionEvent.time（host epoch ms）；嵌套的 aborted cause 拍平成
 * SessionFactsTurnEnd.cause（classifyTurnEndWire 读的字段）。
 */
export function turnEndFromRecord(record: unknown): FollowTailRead | null {
  if (!isRecord(record)) return null
  const inner = record.event
  const event: Record<string, unknown> = isRecord(inner) ? inner : record
  if (event.type !== 'turn/end') return null
  const data = isRecord(event.data) ? event.data : null
  const reason = data !== null && isRecord(data.reason) ? data.reason : null
  if (reason === null || typeof reason.kind !== 'string') return null
  const nested = isRecord(reason.reason) ? reason.reason : null
  const rawCause = typeof reason.cause === 'string'
    ? reason.cause
    : nested !== null && typeof nested.kind === 'string' ? nested.kind : undefined
  const hostTime = hostEpochMs(event.time)
  const seq = typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : undefined
  return {
    turnEnd: {
      kind: reason.kind as SessionFactsTurnEnd['kind'],
      ...(rawCause === undefined ? {} : { cause: rawCause as NonNullable<SessionFactsTurnEnd['cause']> }),
      // at 是 host 域诊断位；拿不到 host 时间时 0 = 未知（不臆造观察者钟）。
      at: hostTime ?? 0,
      ...(seq === undefined ? {} : { seq }),
    },
    hostTime,
  }
}

/**
 * 解析 session/follow 的响应值，取最后一条 turn/end。
 * 支持冻结 wire（snapshot.records / event 帧）与历史/测试形
 * snapshot.tail.turn.reason（legacy 原样保存、不添字段）。
 */
export function parseFollowTail(value: unknown): FollowTailRead {
  if (!isRecord(value)) return EMPTY_FOLLOW_TAIL
  const records = value.records
  if (Array.isArray(records)) {
    let last: FollowTailRead | null = null
    for (const record of records) {
      const fact = turnEndFromRecord(record)
      if (fact !== null) last = fact
    }
    if (last !== null) return last
  }
  const direct = turnEndFromRecord(value)
  if (direct !== null) return direct
  const snapshot = value.snapshot
  if (isRecord(snapshot)) {
    const tail = snapshot.tail
    if (isRecord(tail)) {
      const fromTail = turnEndFromRecord(tail)
      if (fromTail !== null) return fromTail
      const turn = tail.turn
      if (isRecord(turn)) {
        const reason = turn.reason
        if (isRecord(reason) && typeof reason.kind === 'string') {
          return { turnEnd: reason as unknown as SessionFactsTurnEnd, hostTime: hostEpochMs(turn.time) }
        }
      }
    }
  }
  return EMPTY_FOLLOW_TAIL
}

/**
 * 基线行合并。普通对账保留既有完成字段；新运行或更新的用户提示
 * 撤销上一轮完成。rowFromListItem 的空完成字段本身不能擦掉真未读。
 */
export function mergeBaselineRow(previous: SourceMuxRow | undefined, row: SourceMuxRow, at: number): SourceMuxRow {
  if (previous === undefined) return { ...row, factAt: at }
  if (row.running) {
    return {
      ...previous,
      running: true,
      updatedAt: Math.max(previous.updatedAt, row.updatedAt),
      completedAt: null,
      completedAtSource: null,
      lastTurnEnd: null,
      factAt: at,
    }
  }
  return {
    ...previous,
    running: false,
    updatedAt: Math.max(previous.updatedAt, row.updatedAt),
    // updatedAt is the host's lastPromptAt. A later prompt invalidates the
    // previous completion even if both list samples say running=false.
    ...(row.updatedAt > previous.updatedAt && !previous.running
      ? { completedAt: null, completedAtSource: null, completedAtDomain: undefined, lastTurnEnd: null }
      : {}),
    factAt: at,
  }
}

/**
 * 观测仪器：把每个来源的观察者状态发布成**函数视图**的页面全局，
 * 使「无壳观察者其实一直失败」在运行中可见，而不是表现为「这段时间没有完成」。
 */
export function publishSourceMuxInstrument(
  sourceId: string,
  status: () => SourceMuxStatus,
  target: unknown = globalThis,
): void {
  const host = target as { __dshChamberSourceMux?: Record<string, () => SourceMuxStatus> }
  if (host.__dshChamberSourceMux === undefined) host.__dshChamberSourceMux = {}
  host.__dshChamberSourceMux[sourceId] = status
}

/**
 * stop() 必须摘下本源仪器项（否则退役的观察者看起来仍在跑）。
 * expected 给定时只删本次发布的那个函数：同 id 的继任观察者不得被前任的 stop() 误摘。
 */
export function unpublishSourceMuxInstrument(
  sourceId: string,
  target: unknown = globalThis,
  expected?: () => SourceMuxStatus,
): void {
  const host = target as { __dshChamberSourceMux?: Record<string, () => SourceMuxStatus> }
  const registry = host.__dshChamberSourceMux
  if (registry === undefined) return
  if (expected !== undefined && registry[sourceId] !== expected) return
  delete registry[sourceId]
}

export interface SourceMuxStatus {
  ready: boolean
  edges: number
  lastEventAt: number | null
  pendingReads: number
  /** 已观察到停止、但仍缺可归属 turn/end 的会话数。 */
  pendingClassifications: number
  reconnects: number
  /** 成功取到基线的次数（每次 (re)connect 都必须重新对账）。 */
  baselines: number
  /** 基线失败 = 本次连接事实不可信（不能静默：否则分不清「没完成」与「观察者坏了」）。 */
  baselineFailures: number
  /** 尾巴读取失败（降级武装路径）次数。 */
  followFailures: number
  /** 套接字层错误次数（与 close 分开计数，便于区分「服务器拒绝」与「网络抖」）。 */
  socketErrors: number
}

export interface SourceMuxFacts {
  start(): void
  stop(): void
  reconcile(): void
  status(): SourceMuxStatus
}

/**
 * 无壳观察者：一次 $events 订阅 + 每条完成边沿一次 session/follow。
 * 所有 I/O 都经注入缝（socket/fetch/now），因此纯 node 可测。
 */
export function createSourceMuxFacts(deps: SourceMuxDeps): SourceMuxFacts {
  const now = deps.now ?? (() => Date.now())
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const openSocket = deps.openSocket ?? ((url: string) => new WebSocket(url) as unknown as MuxSocket)
  const base = muxBaseFor(deps.origin, deps.sourceId)
  const silenceMs = deps.silenceTimeoutMs ?? DEFAULT_FACTS_SILENCE_MS
  const baselineTimeoutMs = deps.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS
  const followTimeoutMs = deps.followTimeoutMs ?? DEFAULT_FOLLOW_TIMEOUT_MS
  const reconcileIntervalMs = deps.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
  const rows = new Map<string, SourceMuxRow>()
  const runningBefore = new Map<string, boolean>()
  // 同一会话的运行轮次。读尾仅能结算它观察到的那次 true→false。
  const runVersions = new Map<string, number>()
  const pendingTails = new Map<string, PendingTail>()
  const readingTails = new Map<string, PendingTail>()
  const follows = new Map<string, { settle: (tail: FollowTailRead) => void; timer: ReturnType<typeof setTimeout>; carrier: MuxSocket }>()
  let followSeq = 0
  // A complete baseline can briefly miss a row during host churn. The gateway
  // mirror also waits for a second complete absence before retiring it.
  const missingBaselines = new Map<string, number>()
  let socket: MuxSocket | null = null
  let stopped = true
  let lifetime = 0
  let socketReady = false
  let baselineTrusted = false
  let eventRevision = 0
  let baselineRequest = 0
  let runVersion = 0
  let edges = 0
  let reconnects = 0
  let lastEventAt: number | null = null
  let pendingReads = 0
  let baselines = 0
  let baselineFailures = 0
  let followFailures = 0
  let socketErrors = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let connectDeadlineTimer: ReturnType<typeof setTimeout> | null = null
/** A carrier that never opens, errors or closes would leave the observer with no
 *  silence evidence and no retry: the missing handshake is itself a carrier failure. */
const clearConnectDeadline = (): void => {
  if (connectDeadlineTimer !== null) clearTimeout(connectDeadlineTimer)
  connectDeadlineTimer = null
}
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null
  let stableTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 连接代际（照 control-plane/src/session-mux.ts 的 generation 纪律）。
   * connect() 主动换掉旧 socket / onclose 确认死亡时代际 +1；旧代际的一切回调
   * （onopen/onmessage/onclose/onerror 与在途基线）不得再改状态或调度重连——
   * 否则旧 socket 的 onclose 会在每次静默重订阅后再排一次 1s 重连（自激洪泛）。
   */
  let generation = 0
  // 重连指数退避（1s 起、30s 封顶）：源长时间不可达时不得变成每秒一次的重试洪流。
  let reconnectDelayMs = 1_000
  const MAX_RECONNECT_DELAY_MS = 30_000
  const RECONNECT_STABLE_MS = 30_000
  const instrument = (): SourceMuxStatus => currentStatus()
  const ready = (): boolean => socketReady && baselineTrusted

  /** **与 gateway 事实源同形**的快照（同一套字段，App 因此走同一条管线）。 */
  function snapshot(): SessionFactsSnapshot {
    const record: Record<string, SessionFactsRow> = {}
    for (const [sessionId, row] of rows) record[sessionId] = row
    return {
      // 观察者自带通道：verdict=ok 表示"这条通道可用"，与网关镜像的版本协商无关
      // （出口判据正是"不依赖 gateway 版本"）。这里是 $events WebSocket 观察者，
      // 全程走 WS mux + unary、从不轮询——'sse'/'poll' 都是 gateway 平面的词，
      // 在这里是谎报；新增 'ws' 需同步 gateway 镜像三处白名单，收益为 0
      // （2026-12 审计 §6.1.3）。快照的 mode 因此诚实报 null，而不是照抄一个
      // 它并不使用的传输档（唯一消费 mode 的 session-facts-source.startDelivery
      // 只读自己 payload 的 mode，不读这里）。
      verdict: ready() ? 'ok' : 'degraded',
      degradation: ready() ? null : 'unavailable',
      mode: null,
      hostState: ready() ? 'ready' : 'unknown',
      serviceable: ready(),
      stale: !ready(),
      cursor: 0,
      rows: record,
      read: null,
      lastEventAt,
    }
  }

  function emit(): void {
    // stop() 之后到达的在途事件（基线/读尾）不得再推快照。
    if (stopped) return
    deps.onSnapshot(snapshot())
  }

  /**
   * unary 带 deadline。半死隧道下 fetch 可能永不落定；到点 abort + reject，
   * 调用方照既有降级路径计数（baselineFailures / followFailures），绝不永久挂起。
   */
  async function rpc(method: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const rpcId = 'mux-' + Math.random().toString(36).slice(2, 12)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(method + ': timeout after ' + String(timeoutMs) + 'ms'))
      }, timeoutMs)
    })
    try {
      const body = await Promise.race([
        (async () => {
          const response = await fetchImpl(base + '/api/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
          signal: controller.signal,
          })
          if (!response.ok) throw new Error(method + ' http ' + response.status)
          return response.json() as Promise<{ type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: unknown } }>
        })(),
        expired,
      ])
      if (body.type !== 'server-response' || body.rpcId !== rpcId) throw new Error(method + ': envelope mismatch')
      if (body.result?.ok !== true) throw new Error(method + ': rpc failed')
      return body.result.value
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  function clearSilence(): void {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }
  }

  function clearReconcile(): void {
    if (reconcileTimer !== null) clearTimeout(reconcileTimer)
    reconcileTimer = null
  }

  function clearStable(): void {
    if (stableTimer !== null) clearTimeout(stableTimer)
    stableTimer = null
  }

  function armStableReconnectReset(): void {
    if (!ready() || stableTimer !== null) return
    const atGeneration = generation
    stableTimer = setTimeout(() => {
      stableTimer = null
      if (!stopped && atGeneration === generation && ready()) reconnectDelayMs = 1_000
    }, RECONNECT_STABLE_MS)
  }

  function armReconcile(): void {
    clearReconcile()
    const atGeneration = generation
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null
      if (stopped || generation !== atGeneration) return
      void baseline()
      armReconcile()
    }, reconcileIntervalMs)
  }

  function nextRunVersion(sessionId: string): number {
    const version = ++runVersion
    runVersions.set(sessionId, version)
    return version
  }

  function markPromptGap(sessionId: string, updatedAt: number): PendingTail {
    const pending: PendingTail = { runVersion: runVersions.get(sessionId), afterPromptAt: updatedAt }
    pendingTails.set(sessionId, pending)
    return pending
  }

  function markObservedEdge(sessionId: string): PendingTail {
    const pending: PendingTail = { runVersion: runVersions.get(sessionId), afterPromptAt: null }
    pendingTails.set(sessionId, pending)
    return pending
  }

  function settleFollow(streamId: string, tail: FollowTailRead): void {
    const follow = follows.get(streamId)
    if (follow === undefined) return
    follows.delete(streamId)
    clearTimeout(follow.timer)
    if (socket === follow.carrier) {
      try { follow.carrier.send(JSON.stringify({ type: 'cancel', streamId })) } catch { /* Carrier may already be closed. */ }
    }
    follow.settle(tail)
  }

  function cancelFollows(): void {
    for (const streamId of [...follows.keys()]) settleFollow(streamId, EMPTY_FOLLOW_TAIL)
  }

  /** session/follow is a stream endpoint. The opening snapshot contains the durable tail. */
  function followTail(sessionId: string): Promise<FollowTailRead> {
    const carrier = socket
    if (carrier === null) return Promise.resolve(EMPTY_FOLLOW_TAIL)
    const streamId = 'chamber-follow-' + ++followSeq
    return new Promise(resolve => {
      const timer = setTimeout(() => settleFollow(streamId, EMPTY_FOLLOW_TAIL), followTimeoutMs)
      follows.set(streamId, { settle: resolve, timer, carrier })
      try {
        carrier.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: followPayload(sessionId) }))
      } catch {
        settleFollow(streamId, EMPTY_FOLLOW_TAIL)
      }
    })
  }

  /** One retirement path for explicit removal and confirmed baseline absence. */
  function retireSession(sessionId: string): boolean {
    const hadRow = rows.delete(sessionId)
    runningBefore.delete(sessionId)
    runVersions.delete(sessionId)
    pendingTails.delete(sessionId)
    readingTails.delete(sessionId)
    missingBaselines.delete(sessionId)
    return hadRow
  }

  /**
   * 基线对账。
   * - 普通基线保留完成字段；host 的新提示水位撤销旧完成；
   * - 基线里 previous.running===true && row.running===false 是重订阅后跨缺口完成的
   *   **唯一证据**（$events 开场不重放 status）⇒ 与 status 边沿同一条 readTail 路径；
   * - 基线也播种 runningBefore：它是缺口边沿的另一半证据。
   */
  async function baseline(): Promise<void> {
    const atGeneration = generation
    const request = ++baselineRequest
    const atRevision = eventRevision
    let value: unknown
    try {
      value = await rpc('session/list', { args: { _request: {} } }, baselineTimeoutMs)
    } catch {
      // 失败 = 本次连接事实不可信（不能静默：必须能区分「没完成」与「观察者坏了」）。
      if (!stopped && atGeneration === generation && request === baselineRequest) {
        baselineFailures += 1
        baselineTrusted = false
        clearStable()
        emit()
      }
      return
    }
    if (stopped || atGeneration !== generation || request !== baselineRequest) return
    if (atRevision !== eventRevision) {
      // 列表的取样点未知；其间收到的事件可能比列表新。重新取样，不用旧列表覆写事件。
      void baseline()
      return
    }
    const envelope = value as { items?: unknown } | null | undefined
    const rawItems = envelope?.items
    if (!Array.isArray(rawItems)) {
      // A successful RPC envelope is not a successful facts baseline when its
      // required items list is absent. Treating null as [] would certify an
      // unobserved source and suppress the runtime completion fallback.
      baselineFailures += 1
      baselineTrusted = false
      clearStable()
      emit()
      return
    }
    const items = rawItems.map(rowFromListItem)
    if (items.some(row => row === null)) {
      // A partial list is not a trustworthy baseline. Reject it atomically so
      // no earlier row in this response can change running state or start a tail.
      baselineFailures += 1
      baselineTrusted = false
      clearStable()
      emit()
      return
    }
    baselines += 1
    const at = now()
    const seen = new Set<string>()
    for (const row of items) {
      if (row === null) continue
      seen.add(row.sessionId)
      missingBaselines.delete(row.sessionId)
      const previous = rows.get(row.sessionId)
      if (row.running && previous?.running !== true) nextRunVersion(row.sessionId)
      if (row.running) pendingTails.delete(row.sessionId)
      runningBefore.set(row.sessionId, row.running)
      rows.set(row.sessionId, mergeBaselineRow(previous, row, at))
      if (previous !== undefined && previous.running === true && row.running === false) {
        edges += 1
        void readTail(row.sessionId, markObservedEdge(row.sessionId))
      } else if (!row.running && previous !== undefined && !previous.running
          && row.updatedAt > previous.updatedAt) {
        // Both status frames can fit between baselines. A newer lastPromptAt
        // proves new activity, but only a newer turn/end may prove completion.
        void readTail(row.sessionId, markPromptGap(row.sessionId, row.updatedAt))
      } else if (!row.running && pendingTails.has(row.sessionId)) {
        // A previously unreadable tail remains pending classification. A later
        // periodic baseline gives it another bounded follow attempt.
        void readTail(row.sessionId, pendingTails.get(row.sessionId)!)
      }
    }
    for (const sessionId of [...rows.keys()]) {
      if (seen.has(sessionId)) continue
      const misses = (missingBaselines.get(sessionId) ?? 0) + 1
      if (misses < 2) missingBaselines.set(sessionId, misses)
      else retireSession(sessionId)
    }
    baselineTrusted = true
    armStableReconnectReset()
    emit()
  }

  /**
   * 对已观察到的 true→false 边沿和可能丢失两帧的提示水位读尾，然后分类。
   * completedAt 优先取 tail 的 host turn/end.time（epoch ms）；拿不到就用观察者戳，
   * 并把 completedAtSource 标为 reconstructed、completedAtDomain 标为 observer——
   * 这是**降级而不是等价**：该时间不在 host 域，绝不能当作 host 水位，App 也因此不发通知
   * （reconstructed = 只出未读，与 gateway 的缺口重建同规）。
   */
  async function readTail(sessionId: string, expected: PendingTail): Promise<void> {
    const atLifetime = lifetime
    // A dropped true/false pair can leave the visible run version unchanged.
    // The host's newer activity watermark then invalidates an older follow
    // result even though both snapshots currently say running=false.
    const expectedUpdatedAt = rows.get(sessionId)?.updatedAt
    if (readingTails.get(sessionId) === expected) return
    readingTails.set(sessionId, expected)
    const currentRow = (): SourceMuxRow | undefined => {
      const row = rows.get(sessionId)
      return row?.running === false && pendingTails.get(sessionId) === expected
        && !missingBaselines.has(sessionId)
        && runVersions.get(sessionId) === expected.runVersion
        && row.updatedAt === expectedUpdatedAt ? row : undefined
    }
    pendingReads += 1
    try {
      const tail = await followTail(sessionId)
      if (stopped || atLifetime !== lifetime) return
      const row = currentRow()
      if (row === undefined) return
      // session/follow returns the most recent tail, which may belong to the
      // preceding run. A status edge is no stronger than a prompt-gap probe
      // when its host prompt watermark is known: the tail must be strictly
      // newer before it can classify this run. A missing host timestamp may
      // still arm reconstructed unread, but must never produce a notification.
      const promptFloor = expected.afterPromptAt ??
        (expectedUpdatedAt !== undefined && expectedUpdatedAt > 0 ? expectedUpdatedAt : null)
      // Unreadable (no turn/end at all), stale (a host time at or below the prompt
      // floor) and — for a prompt-gap probe only — unordered are the cases that must
      // not classify this run. A **status edge** (afterPromptAt === null) saw the
      // running→false transition directly, so a tail without a host time still
      // classifies: a user stop / neutral ending must not arm a false completion,
      // and a completed one stays reconstructed/observer (never a notification).
      const staleByPrompt = promptFloor !== null && tail.hostTime !== null && tail.hostTime <= promptFloor
      const unorderedPromptGap = expected.afterPromptAt !== null && tail.hostTime === null
      if (tail.turnEnd === null || staleByPrompt || unorderedPromptGap) {
        // A stale tail cannot classify this run. Keep the pending read for the
        // next independent baseline instead of settling it as user-stopped or
        // completed.
        if (expected.afterPromptAt !== null) {
          followFailures += 1
          return
        }
        // 期限内没有 turn/end ⇒ **读不到确定性尾巴**：与 gateway 的 followTurnEndOnce 同规判 unreadable 并武装，
        // 而不是判 neutral——后者会让「跨缺口完成」在唯一证据缺失时静默丢失。
        // 若该会话紧接着又开跑，status 的 running=true 分支会照 gateway applyBaseline 结算掉这条旧完成。
        followFailures += 1
        rows.set(sessionId, {
          ...row,
          completedAt: now(),
          completedAtSource: 'reconstructed',
          completedAtDomain: 'observer',
          lastTurnEnd: null,
          factAt: now(),
        })
        emit()
        return
      }
      const disposition = classifyTurnEndWire(tail.turnEnd)
      pendingTails.delete(sessionId)
      if (expected.afterPromptAt !== null) edges += 1
      // 分类与 watcher 同规：completed 武装；用户停止/中立都不武装（但记录尾巴供诊断）。
      const completedAt = disposition === 'completed' ? tail.hostTime ?? now() : null
      const completedAtSource: SessionFactsCompletedAtSource | null = completedAt === null
        ? null
        : tail.hostTime !== null ? 'observed' : 'reconstructed'
      rows.set(sessionId, {
        ...row,
        completedAt,
        completedAtSource,
        ...(completedAtSource === null
          ? {}
          : { completedAtDomain: tail.hostTime !== null ? 'host' as const : 'observer' as const }),
        lastTurnEnd: tail.turnEnd,
        factAt: now(),
      })
      emit()
    } catch {
      if (stopped || atLifetime !== lifetime) return
      // 读不到尾巴 = 降级：仍武装（绝不丢真完成），并标记 unreadable（与 watcher 同规）。
      // 计数而非静默：这是「观察者在跑但读不到尾巴」的唯一可观测信号。
      const row = currentRow()
      if (row !== undefined) {
        followFailures += 1
        if (expected.afterPromptAt !== null) return
        // 没有 host 时间 ⇒ 观察者戳 + reconstructed/observer（诚实标注降级）。
        rows.set(sessionId, {
          ...row,
          completedAt: now(),
          completedAtSource: 'reconstructed',
          completedAtDomain: 'observer',
          lastTurnEnd: null,
          factAt: now(),
        })
        emit()
      }
    } finally {
      if (atLifetime === lifetime) pendingReads -= 1
      if (readingTails.get(sessionId) === expected) readingTails.delete(sessionId)
    }
  }

  /**
   * api-session/status：running 位边沿。未知会话用 emptyRow 建档（否则 readTail
   * 因 row undefined 直接返回，基线后新建会话的完成永久不可见）。
   * running=true 与 gateway applyStatus 同规：新一轮运行结算旧完成（re-run disarms）。
   */
  function handleStatus(args: unknown): void {
    const parsed = parseStatusArgs(args)
    if (parsed === null) return
    const { sessionId, running } = parsed
    missingBaselines.delete(sessionId)
    const previousRunning = runningBefore.get(sessionId)
    if (running && previousRunning !== true) nextRunVersion(sessionId)
    if (running) pendingTails.delete(sessionId)
    runningBefore.set(sessionId, running)
    const previous = rows.get(sessionId) ?? emptyRow(sessionId, running, 0)
    rows.set(sessionId, running
      ? { ...previous, running: true, completedAt: null, completedAtSource: null, lastTurnEnd: null, factAt: now() }
      : { ...previous, running: false, factAt: now() })
    if (previousRunning === true && running === false) {
      edges += 1
      void readTail(sessionId, markObservedEdge(sessionId))
    } else {
      emit()
    }
  }

  /** api-session/added：白名单行直接建/合行（不产边沿；状态边沿仍由 status 负责）。 */
  function handleAdded(args: unknown): void {
    const item = Array.isArray(args) ? args[0] : args
    const row = rowFromListItem(item)
    if (row === null) return
    missingBaselines.delete(row.sessionId)
    const previous = rows.get(row.sessionId)
    if (row.running && previous?.running !== true) nextRunVersion(row.sessionId)
    if (row.running) pendingTails.delete(row.sessionId)
    runningBefore.set(row.sessionId, row.running)
    rows.set(row.sessionId, mergeBaselineRow(previous, row, now()))
    if (previous !== undefined && !previous.running && !row.running && row.updatedAt > previous.updatedAt) {
      markPromptGap(row.sessionId, row.updatedAt)
    }
    emit()
  }

  /** api-session/activity：host 域水位（只升不降）。 */
  function handleActivity(args: unknown): void {
    const pair = Array.isArray(args) ? args : []
    const sessionId = pair[0]
    const updatedAt = pair[1]
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (!isWatermark(updatedAt) || updatedAt === 0) return
    missingBaselines.delete(sessionId)
    const previous = rows.get(sessionId)
    const prior = previous ?? emptyRow(sessionId, false, 0)
    if (updatedAt <= prior.updatedAt) return
    if (previous !== undefined && !previous.running) markPromptGap(sessionId, updatedAt)
    rows.set(sessionId, {
      ...prior, updatedAt, factAt: now(),
      ...(previous !== undefined && !previous.running
        ? { completedAt: null, completedAtSource: null, completedAtDomain: undefined, lastTurnEnd: null }
        : {}),
    })
    emit()
  }

  /** api-session/removed：host 删会话 ⇒ 从行与 running 记忆移除（删除不是完成）。 */
  function handleRemoved(args: unknown): void {
    const sessionId = Array.isArray(args) ? args[0] : args
    if (typeof sessionId !== 'string' || sessionId === '') return
    const hadRow = retireSession(sessionId)
    if (hadRow) emit()
  }

  function handleEmit(event: string | undefined, args: unknown): void {
    if (event?.startsWith('api-session/') === true) eventRevision += 1
    if (event === 'api-session/status') handleStatus(args)
    else if (event === 'api-session/added') handleAdded(args)
    else if (event === 'api-session/activity') handleActivity(args)
    else if (event === 'api-session/removed') handleRemoved(args)
  }

  function armSilence(): void {
    clearSilence()
    const armedGeneration = generation
    silenceTimer = setTimeout(() => {
      silenceTimer = null
      if (stopped || armedGeneration !== generation) return
      // 连接在、事件停 ⇒ 载波恢复：重订阅 + 重取基线。**不**发布内容停顿证据：
      // 来源级 $events 静默不是本会话的内容进度（assistant 文本走独立 session/follow），
      // 长生成与别的会话的事件都会让这个信号说谎。页面内容证据只来自真正观测会话
      // 内容的观察者（gateway facts cursor），见 session-content-stall.ts 注册表。
      reconnects += 1
      connect()
    }, silenceMs)
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) return
    const armedGeneration = generation
    const delay = reconnectDelayMs
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopped || armedGeneration !== generation) return
      reconnects += 1
      connect()
    }, delay)
  }

  function connect(): void {
    if (stopped) return
    // Replacing the carrier invalidates its facts immediately. Waiting for the
    // next onopen leaves a window where callers trust a dead connection.
    socketReady = false
    baselineTrusted = false
    clearStable()
    emit()
    if (socket !== null) {
      // 换代。先 +1 再 close——close 可能同步触发旧 socket 的 onclose。
      generation += 1
      const previous = socket
      cancelFollows()
      socket = null
      clearSilence()
      clearReconcile()
      clearStable()
      try {
        previous.close()
      } catch {
        // 关旧连接失败不影响重连。
      }
    }
    const connectGeneration = generation
    let next: MuxSocket
    try {
      next = openSocket(muxUrlFor(deps.origin, deps.sourceId))
    } catch {
      // 打开失败按断线处理：计数并走退避，绝不把异常抛回事件循环。
      socketErrors += 1
      scheduleReconnect()
      return
    }
    socket = next
    clearConnectDeadline()
    connectDeadlineTimer = setTimeout(() => {
      connectDeadlineTimer = null
      if (stopped || connectGeneration !== generation || socketReady) return
      socketErrors += 1
      failCarrier()
    }, TABLE_SNAPSHOT.handshakeTimeoutMs)
    const failCarrier = (): void => {
      if (stopped || connectGeneration !== generation) return
      clearConnectDeadline()
      generation += 1
      cancelFollows()
      socket = null
      socketReady = false
      baselineTrusted = false
      clearSilence()
      clearReconcile()
      clearStable()
      emit()
      try { next.close() } catch { /* Already closed or broken. */ }
      scheduleReconnect()
    }
    next.onopen = () => {
      if (stopped || connectGeneration !== generation) return
      clearConnectDeadline()
      // 观察者开场：只开 $events；**永不**发 $events/result（不结算任何瀑布）。
      try { next.send(openEventsFrame()) } catch {
        socketErrors += 1
        failCarrier()
        return
      }
      armSilence()
      armReconcile()
      void baseline()
    }
    next.onmessage = event => {
      if (stopped || connectGeneration !== generation) return
      const frame = parseMuxFrame(event?.data)
      if (frame === null) return
      if (frame.streamId !== 'events') {
        if (follows.has(frame.streamId)) {
          if (frame.kind === 'stream-end' || frame.kind === 'stream-error'
              || (isRecord(frame.value) && frame.value.type === 'error')) settleFollow(frame.streamId, EMPTY_FOLLOW_TAIL)
          else {
            const tail = parseFollowTail(frame.value)
            if (tail.turnEnd !== null) settleFollow(frame.streamId, tail)
          }
        }
        return
      }
      if (frame.kind === 'stream-end' || frame.kind === 'stream-error') {
        // The physical socket can remain open after its $events logical stream
        // ends. Degrade now, then use the carrier's bounded reconnect backoff.
        failCarrier()
        return
      }
      if (frame.kind === 'other') return
      lastEventAt = now()
      armSilence()
      if (frame.kind === 'ready') {
        socketReady = true
        // A single ready frame is not a stable connection. Repeated logical
        // stream failures must retain exponential backoff.
        armStableReconnectReset()
        // 握手只证明载波可用；事实基线成功前仍必须让运行时边沿负责完成。
        emit()
        return
      }
      // 瀑布只观察，不回答：这里没有任何 send。
      if (frame.kind === 'emit') handleEmit(frame.event, frame.args)
    }
    next.onclose = failCarrier
    next.onerror = () => {
      if (stopped || connectGeneration !== generation) return
      // Some carriers never deliver onclose after onerror; fail this generation
      // now and let a later close be ignored by the generation guard.
      socketErrors += 1
      failCarrier()
    }
  }

  function currentStatus(): SourceMuxStatus {
    return { ready: ready(), edges, lastEventAt, pendingReads,
      pendingClassifications: pendingTails.size, reconnects, baselines,
      baselineFailures, followFailures, socketErrors }
  }

  return {
    start(): void {
      if (!stopped) return
      stopped = false
      publishSourceMuxInstrument(deps.sourceId, instrument)
      // 基线从连接 open 后取；连接失败时不得宣称已有可信事实。
      connect()
    },
    reconcile(): void {
      if (!stopped) void baseline()
    },
    stop(): void {
      stopped = true
      lifetime += 1
      socketReady = false
      baselineTrusted = false
      // 代际 +1 作废在途回调；在途 baseline/readTail 的 emit 被 stopped 守卫拦下。
      generation += 1
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      clearConnectDeadline()
      clearSilence()
      clearReconcile()
      clearStable()
      reconnectTimer = null
      const current = socket
      cancelFollows()
      socket = null
      try {
        current?.close()
      } catch {
        // 忽略关闭异常（幂等 stop）。
      }
      // stop/start on the same observer object is a new subscription lifetime.
      // Old unary follow replies must not classify rows belonging to it.
      rows.clear()
      runningBefore.clear()
      runVersions.clear()
      pendingTails.clear()
      readingTails.clear()
      missingBaselines.clear()
      pendingReads = 0
      lastEventAt = null
      reconnectDelayMs = 1_000
      // 退役的观察者不得继续以本源的名义出现在观测仪器里。
      unpublishSourceMuxInstrument(deps.sourceId, globalThis, instrument)
    },
    status(): SourceMuxStatus {
      return currentStatus()
    },
  }
}
