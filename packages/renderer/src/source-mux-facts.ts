/**
 * Source mux facts —— SSH / 本地 dsh 来源的**无壳观察者**。
 *
 * 网关来源有只读镜像，而 SSH/本地 dsh 来源在没有挂载壳时没有任何事实通道，"关壳期间
 * 完成"仍会丢；本模块经控制面既有无鉴权实例代理观察**实例自己的**远程协议：$events
 * WebSocket（ws /api/i/<id>/api/remote.mux）+ unary（POST /api/i/<id>/api/<method>）。
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
 * 硬纪律：①观察者**绝不发** `$events/result`（会替所有客户端结算等待中的审批），瀑布帧
 * 只观察不回答；②每条 true→false 边沿发起一次有界 `session/follow` 读尾 `turn/end.reason`
 * 分类（completed ⇒ 武装；aborted+user ⇒ 用户停止；其余 ⇒ 中立；读不到 ⇒ 降级仍武装），
 * 后续基线重试分类。基线与边沿：基线 true→false 走同一条读尾路径；基线只合
 * running/updatedAt(max)/factAt 与 goal 三值事实——只白名单取 `item.projections.values.goal`
 * 的 id/revision/phase/updatedAt，objective/blockedReason 等其余投影键在解析处即丢弃；
 * 键缺席/形状不符 = unknown（绝不臆造「无 goal」），null = 宿主明确无 goal。activation 只来自
 * `$events` 的 `goal/activation-changed`（emit 帧无重放）：仅进程内存，绑定 goalId 的边保留待
 * 匹配，no-goal 边只即时清已知对象 goal（绝不缓存），新的 ready 代际清回 unknown。
 * 新提示水位撤销上一轮完成：false→false 的新提示须读到严格晚于提示的 turn/end 才能认定新完成；
 * session/list 与 session/follow 各有 deadline（超时计失败并走既有降级）；连接代际
 * （generation）——被换掉的 socket 的迟到回调不得改状态或调度重连；completedAt 优先取 host
 * 的 turn/end.time（>= 1e12 才算可用），拿不到就用观察者戳并标 reconstructed（诚实降级，
 * 不发通知）；stop() 后在途读取不再 emit，并摘下 __dshChamberSourceMux 本源项。
 * 快照与 gateway 事实源**同形**，直接喂 App 既有的 applySessionFacts 管线（同一份事实、
 * 同一套未读判定）。
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
  openSocket?: (url: string) => MuxSocket
  fetchImpl?: typeof fetch
  now?: () => number
  /** 快照/增量到达（与 gateway 事实源同形）。 */
  onSnapshot: (snapshot: SessionFactsSnapshot) => void
  /** session/list 基线 deadline（默认 5s；半死隧道下不得永久挂起）。 */
  baselineTimeoutMs?: number
  /** 每条边沿 session/follow 的 deadline（默认 2s，与 control-plane/session-mux.ts 同预算）。 */
  followTimeoutMs?: number
  /** 基线因期间事件失效后的重取样最小间隔（默认 250ms）：合并 + 节拍上限。 */
  baselineResampleMinMs?: number
  /** 与载波换代独立的低频对账；即使 socket 持续有帧也能修复丢失的 status。 */
  reconcileIntervalMs?: number
  /** 载波掉线/基线失败后的可判性宽限（默认 3s）：旧基线仍在宽限内即保持可判。 */
  carrierGraceMs?: number
}

export const MUX_PATH = '/api/remote.mux'
export const EVENTS_ENDPOINT = '$events'
/** 基线 unary deadline——半死隧道下「挂起」必须在预算内变成可数的失败。 */
export const DEFAULT_BASELINE_TIMEOUT_MS = 5_000
/** 完成边沿读尾 deadline（对齐 control-plane/session-mux.ts 的 2s 预算）。 */
export const DEFAULT_FOLLOW_TIMEOUT_MS = 2_000
/** 失效基线的重取样节拍（事件密集源上把「事件率 > RPC 周期」变成有界节奏；仲裁者不变）。 */
export const DEFAULT_BASELINE_RESAMPLE_MIN_MS = 250
export const DEFAULT_RECONCILE_INTERVAL_MS = 30_000
/**
 * 空闲关流的恢复宽限：宿主会回收空闲的 `$events` 套接字（实测约 45s 一次），而「可判」表达的是
 * **事实是否可信**，不是**套接字此刻是否连着**。掉线/单次基线失败后在宽限内保持可判，重连成功
 * 时对上层是零变化；宽限内拿不到新基线才降级（真断连仍在 3s 内诚实降级）。没有旧基线可宽限时
 * 一律立即降级——「从来没取到过真相」不是抖动，是故障。
 */
export const DEFAULT_CARRIER_GRACE_MS = 3_000
/** 可用 host 时间（epoch ms）的下界；小于它的数字不是 host 域观测，绝不臆造。 */
export const HOST_EPOCH_MS_FLOOR = 1e12

/**
 * 一行观察者事实。除 gateway SessionFactsRow 字段外，多一个**客户端内部**的时间域
 * 标注（不进 wire）：'host' = completedAt 取自 host turn/end.time（可进 host 域水位）；
 * 'observer' = 客户端观察者戳（拿不到 host 时间时的降级，只武装未读，绝不推进 host 域
 * 读水位）。未标注 = 非本源（gateway 事实源）的行。
 */
export type SessionMuxCompletedAtDomain = 'host' | 'observer'

/** 持久 goal 相位（宿主投影词表；未知词 = 形状不符，绝不猜）。 */
export type SourceMuxGoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/**
 * 进程内 continuation activation（`goal/activation-changed` 唯一来源）。刻意不持久化：
 * 重连后清回 unknown —— 陈旧 armed 不得永久压制完成，陈旧 disarmed 也不得凭空放开。
 */
export type SourceMuxGoalActivation = 'armed' | 'disarmed'

/**
 * goal 白名单事实（与 sidebar GoalFact / session-facts-source 将由 B2 定义的行类型
 * 结构等价；本模块保持自洽，不 import 新符号）。PRIVACY：仅 goalId/revision/phase/
 * updatedAt(+进程内 activation) 允许存在；objective/blockedReason 等其余投影值
 * 在解析处即被丢弃。
 */
export interface SourceMuxGoalFact {
  goalId: string
  revision: number
  phase: SourceMuxGoalPhase
  /** host 域水位（宿主 goal 投影的 updatedAt）；缺席 = 不可用（不臆造）。 */
  updatedAt?: number
  /** 进程内 activation；缺席 = unknown。 */
  activation?: SourceMuxGoalActivation
}

export interface SourceMuxRow extends SessionFactsRow {
  completedAtDomain?: SessionMuxCompletedAtDomain
  /**
   * 目标投影事实（P2b）。三值语义：字段**缺席** = unknown（键缺席/形状不符；
   * 绝不臆造「无 goal」）；`null` = 宿主明确报告当前无 goal；对象 = 当前 goal 事实。
   */
  goal?: SourceMuxGoalFact | null
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

/** turn/end 分类（与 gateway watcher 同规）。 */
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

/** goal 相位白名单（与控制面 P2a 的 GOAL_PHASES 同词表）。 */
const GOAL_PHASES: ReadonlySet<string> = new Set<SourceMuxGoalPhase>(['active', 'paused', 'blocked', 'complete'])

/** goal 水位校验（安全整数且 >= 0；与 control-plane P2a / gateway 同规）。 */
function isGoalWatermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * 从一条 `session/list` item（`api-session/added` 同形）的投影块里**只**取 goal
 * 白名单。冻结 wire：`projections.values.goal =
 * { goal: { id, revision, phase, objective?, blockedReason?, ... }, roundsStarted, createdAt, updatedAt } | null`。
 * 本解析器从不读 objective/blockedReason/maxGoalRounds/roundsStarted，也不触碰
 * title/cwd/todos/inbox 等其余投影键 —— 它们在解析处即被丢弃（隐私白名单）。
 *
 * 校验与控制面 P2a 的 parseProjectedGoalFact 同规：id 非空、revision 安全整数且
 * >= 1、phase 命中词表；任一不符（或嵌套形状不符）= unknown。
 * @returns `undefined` = 键缺席/形状不符（unknown，绝不臆造「无 goal」）；
 *   `null` = 宿主明确无当前 goal；对象 = 白名单事实。
 */
export function parseProjectedGoalFact(item: Record<string, unknown>): SourceMuxGoalFact | null | undefined {
  const projections = item.projections
  if (!isRecord(projections)) return undefined
  const values = projections.values
  if (!isRecord(values) || !Object.hasOwn(values, 'goal')) return undefined
  const raw = values.goal
  if (raw === null) return null
  if (!isRecord(raw) || !isRecord(raw.goal)) return undefined
  const id = raw.goal.id
  const revision = raw.goal.revision
  const phase = raw.goal.phase
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined
  if (typeof phase !== 'string' || !GOAL_PHASES.has(phase)) return undefined
  const fact: SourceMuxGoalFact = { goalId: id, revision, phase: phase as SourceMuxGoalPhase }
  if (isGoalWatermark(raw.updatedAt)) fact.updatedAt = raw.updatedAt
  return fact
}

/** 从 unary session/list 的 item 取行（与 watcher 的基线字段同源）。 */
export function rowFromListItem(item: unknown): SourceMuxRow | null {
  if (!isRecord(item)) return null
  const sessionId = item.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return null
  // Official SessionSummary requires both fields. Missing `running` must not
  // become false: that would forge a true→false completion during a baseline.
  if (typeof item.running !== 'boolean' || !isWatermark(item.updatedAt)) return null
  const row = emptyRow(sessionId, item.running, item.updatedAt)
  // 三值：unknown 时**不写** goal 键（`goal: undefined` 与缺席在快照里无法区分）。
  const goal = parseProjectedGoalFact(item)
  if (goal !== undefined) row.goal = goal
  return row
}

/** api-session/status 载荷：冻结 wire 是 [sessionId, running]，对象形一并接受（不因形状漂移丢边沿）。 */
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

/**
 * `goal/activation-changed` 的 emit 载荷（冻结形 `{sessionId, goal?: {id, revision,
 * activation}}`；数组形 args[0] 与对象形都接受，与 parseStatusArgs 同纪律）。
 * `goal` 缺席 = 宿主当前无 goal ⇒ activation = null；goal 非对象（含显式 null）
 * 或 activation 不是 armed/disarmed = 形状漂移 ⇒ null（丢弃，绝不猜）。
 * `goalId` 供进程内缓存绑定目标身份；id 缺失/非串 = null（未绑定，镜像 P2a 宽松）。
 */
export function parseGoalActivationArgs(args: unknown): { sessionId: string; activation: SourceMuxGoalActivation | null; goalId: string | null } | null {
  const payload = Array.isArray(args) ? args[0] : args
  if (!isRecord(payload)) return null
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const goal = payload.goal
  if (goal === undefined) return { sessionId, activation: null, goalId: null }
  if (!isRecord(goal)) return null
  const activation = goal.activation
  if (activation !== 'armed' && activation !== 'disarmed') return null
  const goalId = typeof goal.id === 'string' && goal.id !== '' ? goal.id : null
  return { sessionId, activation, goalId }
}

/**
 * 进程内 activation 边（armed/disarmed）。刻意绑定事件携带的 goalId：
 * 与 P2a gateway 的 pendingGoalActivations 同规——id 不符时**保留**待投影
 * 匹配，命中的那一刻才消费；旧目标的 armed 绝不能让新目标看起来 armed，
 * 但也不因投影先报出另一个 goal 就丢弃（投影可能只是落后于目标创建）。
 */
interface GoalActivationEdge {
  /** 事件 goal.id；id 缺失/非串 = null（未绑定，按 P2a 的宽松语义作用当前目标）。 */
  goalId: string | null
  activation: SourceMuxGoalActivation
}

/**
 * 把一条进程内 activation 边匹配到一行 goal 上（纯函数，不修改入参）：
 *   - 仅作用于**已知对象** goal：unknown 行（字段缺席）与显式 null 行都保持原样
 *     —— activation 边可能先于基线到达，绝不据此臆造 goal 事实；
 *   - 绑定 goalId 与行不符时**不匹配**（绝不落到当前 goal）；边是否保留由调用方
 *     决定：一律保留待后续 baseline/added 携带匹配 identity（P2a 同规）；
 *   - 未绑定边（goalId === null）作用于当前已知 goal（镜像 P2a 的宽松解析）。
 * @returns null = 不匹配（边必须保留）；命中时返回 { row, changed }（边可消费）。
 */
function matchGoalActivation(row: SourceMuxRow, edge: GoalActivationEdge): { row: SourceMuxRow; changed: boolean } | null {
  const goal = row.goal
  if (goal === undefined || goal === null) return null
  if (edge.goalId !== null && edge.goalId !== goal.goalId) return null
  if (goal.activation === edge.activation) return { row, changed: false }
  return { row: { ...row, goal: { ...goal, activation: edge.activation } }, changed: true }
}

/** 摘掉 activation（新 $events 代际清回 unknown；identity/phase/水位原样保留）。 */
function withoutGoalActivation(goal: SourceMuxGoalFact): SourceMuxGoalFact {
  const next: SourceMuxGoalFact = { goalId: goal.goalId, revision: goal.revision, phase: goal.phase }
  if (goal.updatedAt !== undefined) next.updatedAt = goal.updatedAt
  return next
}

/** 完成边沿读尾一次取多少条尾记录（与 control-plane/session-mux.ts 的预算一致）。 */
export const FOLLOW_MAX_MESSAGES = 8

/** session/follow 载荷：Remote 形参名是 request（写错会得到 gateway/arguments-invalid）。 */
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
 * 一条 records/event 记录 → tail。冻结 wire：
 *   { type:'event', event:{ type:'turn/end', seq, time, data:{ reason } } }
 * event.time 是 host epoch ms；嵌套的 aborted cause 拍平成 SessionFactsTurnEnd.cause。
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
 * 解析 session/follow 的响应值，取最后一条 turn/end；支持冻结 wire
 * （snapshot.records / event 帧）与历史形 snapshot.tail.turn.reason。
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
 * 基线/added 的 goal 三值合并（镜像 gateway session-state 的 mergeGoalFact）：incoming 缺席
 * （unknown）⇒ 保留已知事实；incoming 为 null（宿主明确无 goal）⇒ 清空；incoming 为对象 ⇒
 * 刷新 identity/phase/水位，goalId 不变时**保留**进程内 activation（基线从不携带 activation，
 * 整对象替换会擦掉 activation 事件教给我们的结论）。
 */
function mergeGoalFact(
  previous: SourceMuxGoalFact | null | undefined,
  incoming: SourceMuxGoalFact | null | undefined,
): SourceMuxGoalFact | null | undefined {
  if (incoming === undefined) return previous
  if (incoming === null) return previous === null ? previous : null
  const activation = previous !== undefined && previous !== null && previous.goalId === incoming.goalId
    ? previous.activation
    : undefined
  const next: SourceMuxGoalFact = { goalId: incoming.goalId, revision: incoming.revision, phase: incoming.phase }
  if (incoming.updatedAt !== undefined) next.updatedAt = incoming.updatedAt
  if (activation !== undefined) next.activation = activation
  return next
}

/**
 * 基线行合并：只合 running / updatedAt(max) / factAt 与 goal 事实，保留既有完成字段
 * （completedAt=null 绝不能擦掉真未读）；running=true 与 gateway applyBaseline 同规：
 * 新一轮运行结算旧完成。普通对账保留既有完成字段；更新的用户提示撤销上一轮完成。
 */
export function mergeBaselineRow(previous: SourceMuxRow | undefined, row: SourceMuxRow, at: number): SourceMuxRow {
  if (previous === undefined) return { ...row, factAt: at }
  const goal = mergeGoalFact(previous.goal, row.goal)
  const goalPatch: { goal?: SourceMuxGoalFact | null } = goal === undefined ? {} : { goal }
  if (row.running) {
    return {
      ...previous,
      ...goalPatch,
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
    ...goalPatch,
    running: false,
    updatedAt: Math.max(previous.updatedAt, row.updatedAt),
    // updatedAt 是宿主列表项的派生水位（vendor list.js: max(header.createdAt,
    // projections.values.sessionListMetadata.lastPromptAt ?? 0)），即**最近一次用户内容的时间戳**
    // （本机实测：`session/list` 123/123 行都带真实值）。它证明「有更新」，但**不**证明「有一轮结束」——
    // 故仅当水位推进且此前不在运行时，作废上一次完成声明（活动 ≠ 完成）。
    ...(row.updatedAt > previous.updatedAt && !previous.running
      ? { completedAt: null, completedAtSource: null, completedAtDomain: undefined, lastTurnEnd: null }
      : {}),
    factAt: at,
  }
}

/** 观测仪器：把来源的观察者状态发布成**函数视图**的页面全局，使「观察者其实一直失败」在运行中可见。 */
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
 * stop() 必须摘下本源仪器项；expected 给定时只删本次发布的函数，同 id 的继任观察者
 * 不得被前任的 stop() 误摘。
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
  /** 真实载波换代次数（onclose/onerror、$events 的 end/error 帧、handshakeTimeout）；静默不换代。 */
  reconnects: number
  /** 成功取到基线的次数（每次 (re)connect 都必须重新对账）。 */
  baselines: number
  /** 基线失败 = 本次连接事实不可信（不能静默：否则分不清「没完成」与「观察者坏了」）。 */
  baselineFailures: number
  /** 尾巴读取失败（降级武装路径）次数。 */
  followFailures: number
  /** 套接字层错误次数（与 close 分开计数，便于区分「服务器拒绝」与「网络抖」）。 */
  socketErrors: number
  /** 载波丢失时刻（宽限计时起点）；null = 载波在场，或从未有过可信基线。 */
  carrierLostAt: number | null
  /** 不可判起点；null = 当前可判。生命周期自愈按它判定「多久没有可信事实」。 */
  staleSince: number | null
  /** 最近一次基线失败的原因文本（诊断：静默 catch 变成可读证据）；null = 从未失败。 */
  baselineFailureReason: string | null
  /** 因取样点漂移而主动重取的基线次数（不是失败，但同样推迟可信）。 */
  baselineResamples: number
  /** 最近一次成功基线时刻（诊断：区分「从没有过基线」与「基线正在变旧」）。 */
  lastTrustedBaselineAt: number | null
  /** 当前在册行数（诊断：确认基线真的落过行，而不是只有握手）。 */
  rows: number
}

export interface SourceMuxFacts {
  start(): void
  stop(): void
  reconcile(): void
  status(): SourceMuxStatus
}

/** 无壳观察者：一次 $events 订阅 + 每条完成边沿一次 session/follow；I/O 全经注入缝。 */
export function createSourceMuxFacts(deps: SourceMuxDeps): SourceMuxFacts {
  const now = deps.now ?? (() => Date.now())
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const openSocket = deps.openSocket ?? ((url: string) => new WebSocket(url) as unknown as MuxSocket)
  const base = muxBaseFor(deps.origin, deps.sourceId)
  const baselineTimeoutMs = deps.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS
  const followTimeoutMs = deps.followTimeoutMs ?? DEFAULT_FOLLOW_TIMEOUT_MS
  const baselineResampleMinMs = deps.baselineResampleMinMs ?? DEFAULT_BASELINE_RESAMPLE_MIN_MS
  const reconcileIntervalMs = deps.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
  const carrierGraceMs = deps.carrierGraceMs ?? DEFAULT_CARRIER_GRACE_MS
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
  /**
   * 每会话进程内 activation 边（仅内存；最新边覆盖）。与行的 goal 合并：基线/
   * added 建行时按 identity 匹配（命中即消费；行 goal unknown/null 或绑定 id
   * 不符时保留待匹配）；新的 ready 代际整体清空。no-goal **不进这张表**：
   * 它是即时事实（只清已知对象 goal），缓存它会把在途 baseline 的新 goal 压成
   * null 并挡住后续 armed 事件。
   */
  const goalActivations = new Map<string, GoalActivationEdge>()
  let socket: MuxSocket | null = null
  let stopped = true
  let lifetime = 0
  let socketReady = false
  let baselineTrusted = false
  let carrierLostAt: number | null = null
  let carrierGraceTimer: ReturnType<typeof setTimeout> | null = null
  let staleSince: number | null = null
  let baselineFailureReason: string | null = null
  let baselineResamples = 0
  let lastTrustedBaselineAt: number | null = null
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
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null
  let stableTimer: ReturnType<typeof setTimeout> | null = null
  let baselineResampleTimer: ReturnType<typeof setTimeout> | null = null
  /** A carrier that never opens, errors or closes would leave the observer with no
   *  failure evidence and no retry: the missing handshake is itself a carrier failure. */
  const clearConnectDeadline = (): void => {
    if (connectDeadlineTimer !== null) clearTimeout(connectDeadlineTimer)
    connectDeadlineTimer = null
  }
  /**
   * One pending baseline re-sample (review O1). The list's sampling point is unknown, so an
   * event that arrived while it was in flight makes it stale - re-sample rather than let the old
   * list overwrite newer events. That retry is COALESCED and PACED: one pending re-sample absorbs
   * every invalidation in the window and runs no sooner than `baselineResampleMinMs`, so an
   * event-dense source cannot turn "event rate > list RPC period" into an unbounded stream of
   * full-table fetches. The arbiter is unchanged: a stale sample still never overwrites a newer event.
   */
  const scheduleBaselineResample = (): void => {
    if (stopped || baselineResampleTimer !== null) return
    // The pending re-sample belongs to the generation that invalidated the sample: a
    // carrier turnover re-baselines on its own ready frame, so a stale retry must not
    // fetch a second time (the reconcile timer captures its generation the same way).
    const atGeneration = generation
    baselineResampleTimer = setTimeout(() => {
      baselineResampleTimer = null
      if (stopped || atGeneration !== generation) return
      // 重取不是失败，但持续重取同样意味着「还没有可信基线」⇒ 计数供诊断区分。
      baselineResamples += 1
      void baseline()
    }, baselineResampleMinMs)
  }
  const clearBaselineResample = (): void => {
    if (baselineResampleTimer === null) return
    clearTimeout(baselineResampleTimer)
    baselineResampleTimer = null
  }
  /**
   * 连接代际：connect() 换掉旧 socket / onclose 确认死亡时代际 +1；旧代际的一切回调
   * （含在途基线）不得再改状态或调度重连——否则旧 socket 的 onclose 会在每次真实
   * 换代后再排一次 1s 重连（自激洪泛）。
   */
  let generation = 0
  // 重连指数退避（1s 起、30s 封顶）：源长时间不可达时不得变成每秒一次的重试洪流。
  let reconnectDelayMs = 1_000
  const MAX_RECONNECT_DELAY_MS = 30_000
  const RECONNECT_STABLE_MS = 30_000
  const instrument = (): SourceMuxStatus => currentStatus()
  /** 载波宽限是否仍然成立（掉线后的一小段「旧真相仍然可用」窗口）。 */
  const carrierGraceActive = (): boolean =>
    carrierLostAt !== null && now() - carrierLostAt <= carrierGraceMs
  /**
   * 可判唯一谓词：**不再要求套接字此刻连着**。旧基线 + 掉线宽限内仍可判（宿主的空闲关流不该
   * 变成每个来源每 45s 一次的「既不可判又不可恢复」）；从来没有基线时宽限不成立；退役（stopped）
   * 之后没有任何载体，恒不可判——否则退役快照的采样会一直读到 ready=1，环里看不到这一转折。
   */
  const ready = (): boolean => !stopped && baselineTrusted && (socketReady || carrierGraceActive())

  /**
   * 不可判起点的唯一记账处：任何路径都只经这一个函数同步（snapshot/status 两个出口与
   * carrierOrBaselineLost 的两条降级路径都调它），绝不手写 staleSince，
   * 也从不由「套接字掉了」这类瞬时相位决定。
   */
  function syncStaleSince(): void {
    if (stopped || ready()) {
      staleSince = null
      return
    }
    if (staleSince === null) staleSince = now()
  }

  function clearCarrierGrace(): void {
    if (carrierGraceTimer !== null) clearTimeout(carrierGraceTimer)
    carrierGraceTimer = null
  }

  /** 失败原因文本：诊断面包屑要的是「为什么」，不是「又失败了」。 */
  function failureText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error)
    return text.length > 160 ? text.slice(0, 160) : text
  }

  /**
   * 载波掉线 / 单次基线失败后的**唯一**可判性策略：
   *   - 手上有旧基线 ⇒ 记一次宽限（重连与重取常在同一拍成功，逐次立刻降级会把宿主的
   *     空闲关流变成每个来源每 45s 一次「可判↔不可判」的闪烁）；起点只记一次，连续掉线
   *     不得无限续期；
   *   - 从来没有基线 ⇒ 立即降级：没有旧真相可宽限，「从未取到」是故障不是抖动；
   *   - 宽限到期仍无新基线 ⇒ 清 baselineTrusted 并发布降级（真断连仍在宽限内诚实降级）。
   */
  function carrierOrBaselineLost(): void {
    if (!baselineTrusted) {
      // 没有可信基线时只有基线腿能作判；socketReady 属于套接字腿，只由 connect()/failCarrier()
      // 的换代决定。在这里顺手清掉它，之后成功基线也永远 ready()=false（ready 帧只在换 socket
      // 时来）——那是换条路径重现「在场但不可判」，正是本规则要消灭的形状。
      carrierLostAt = null
      clearCarrierGrace()
      syncStaleSince()
      emit()
      return
    }
    // 只在**第一次**丢失时起表：每次失败都重排会把到期翻转无限推迟（探测：每 100ms 一次
    // reconcile ⇒ t=4s 仍判可判），正是本函数注释与 design 19 都禁止的「无限续期」。
    // 换代（connect/failCarrier）会清 carrierLostAt，新一代的第一次丢失仍会重新起表。
    if (carrierLostAt !== null) return
    carrierLostAt = now()
    clearCarrierGrace()
    const atGeneration = generation
    carrierGraceTimer = setTimeout(() => {
      carrierGraceTimer = null
      if (stopped || generation !== atGeneration) return
      // 宽限内恢复的证据只有一种：**成功基线**（它清 carrierLostAt 并取消本计时器）。计时器
      // 仍挂着（且未恢复）⇒ 这段时间没有任何新证据 ⇒ 必须停止声称可判（socketReady 单独为
      // true 不算证据：unary 可能一直是坏的；ready 帧按设计也不结束宽限）。
      if (carrierLostAt === null) return
      carrierLostAt = null
      baselineTrusted = false
      syncStaleSince()
      emit()
    }, carrierGraceMs)
  }

  /** **与 gateway 事实源同形**的快照（同一套字段，App 因此走同一条管线）。 */
  function snapshot(): SessionFactsSnapshot {
    syncStaleSince()
    // 只算一次：ready() 每次都读 now()，跨宽限边界时多次调用会产出 verdict='ok' + stale=true
    // 的撕裂快照。
    const usable = ready()
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
      verdict: usable ? 'ok' : 'degraded',
      degradation: usable ? null : 'unavailable',
      mode: null,
      hostState: usable ? 'ready' : 'unknown',
      serviceable: usable,
      stale: !usable,
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
   * 进程内 activation 与（基线/added 建出的）行合并：identity 命中即消费；绑定 id 与基线
   * 不同时**保留**这条边，待后续 projection 携带匹配 identity（P2a applyRetainedGoalActivation
   * 同规：投影可能只是慢于目标创建）。
   */
  function mergeActivationIntoRow(sessionId: string, row: SourceMuxRow): SourceMuxRow {
    const edge = goalActivations.get(sessionId)
    if (edge === undefined) return row
    const matched = matchGoalActivation(row, edge)
    if (matched === null) return row
    goalActivations.delete(sessionId)
    return matched.row
  }

  /**
   * `goal/activation-changed` 的 armed/disarmed 值落点：先更新进程内表（最新边覆盖），再尝试
   * 合并当前行；identity 命中即消费，行尚不存在、goal unknown/null 或绑定 id 不符时保留待匹配
   * （activation 边可能先于基线到达）；只有行真的变化才走既有 snapshot emit 路径。
   */
  function applyActivation(sessionId: string, edge: GoalActivationEdge): void {
    goalActivations.set(sessionId, edge)
    const previous = rows.get(sessionId)
    if (previous === undefined) return
    const matched = matchGoalActivation(previous, edge)
    if (matched === null) return
    goalActivations.delete(sessionId)
    if (!matched.changed) return
    rows.set(sessionId, { ...matched.row, factAt: now() })
    emit()
  }

  /**
   * no-goal 边（`goal` 键缺席 = 宿主明确当前无 goal）：先丢弃保留边（目标没了，边是死信息），
   * 只把**已知对象** goal 即时清成 null（unknown 行保持 unknown，绝不据此臆造「无 goal」）；
   * **绝不缓存**——缓存会在在途 baseline/added 报出新 goal 时把新 goal 压成 null，并让后续
   * armed 事件再也落不下来（直到换代/重连），这正是要修的竞态。
   */
  function applyNoGoalActivation(sessionId: string): void {
    goalActivations.delete(sessionId)
    const previous = rows.get(sessionId)
    if (previous === undefined || previous.goal === undefined || previous.goal === null) return
    rows.set(sessionId, { ...previous, goal: null, factAt: now() })
    emit()
  }

  /**
   * 新的 $events 代际（ready 假→真；含换代重连）：emit 型帧无重放 ⇒ 进程内 activation
   * 不再可信，表与行上残留值一并清回 unknown（防陈旧 armed/disarmed）。
   */
  function clearGoalActivations(): void {
    goalActivations.clear()
    for (const [sessionId, row] of rows) {
      const goal = row.goal
      if (goal === undefined || goal === null || goal.activation === undefined) continue
      rows.set(sessionId, { ...row, goal: withoutGoalActivation(goal), factAt: now() })
    }
  }

  /** `goal/activation-changed`：进程内 activation 边与 no-goal 即时清理。 */
  function handleGoalActivation(args: unknown): void {
    const parsed = parseGoalActivationArgs(args)
    if (parsed === null) return
    if (parsed.activation === null) {
      applyNoGoalActivation(parsed.sessionId)
      return
    }
    applyActivation(parsed.sessionId, { goalId: parsed.goalId, activation: parsed.activation })
  }

  /**
   * unary 带 deadline：半死隧道下 fetch 可能永不落定，到点 abort + reject，调用方照
   * 既有降级路径计数，绝不永久挂起。
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
      runBaseline()
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
    // goal 与 activation 随行消亡：重建的会话不得继承旧 activation（显式删除与基线
    // 双缺席退役走同一路径，只改 handleRemoved 会漏）。
    goalActivations.delete(sessionId)
    return hadRow
  }

  /**
   * 基线对账：只合 running/updatedAt(max)/factAt 与 goal 三值事实，保留既有完成字段；
   * host 的新提示水位撤销旧完成。
   * previous.running===true && row.running===false 是换代重连后跨缺口完成的**唯一证据**
   * （$events 开场不重放 status）⇒ 与 status 边沿同一条 readTail 路径；基线也播种
   * runningBefore（缺口边沿的另一半证据）。
   */
  async function baseline(): Promise<void> {
    const atGeneration = generation
    const request = ++baselineRequest
    const atRevision = eventRevision
    let value: unknown
    try {
      value = await rpc('session/list', { args: { _request: {} } }, baselineTimeoutMs)
    } catch (error) {
      // 失败 = 本次连接事实不可信（不能静默：必须能区分「没完成」与「观察者坏了」）。
      if (!stopped && atGeneration === generation && request === baselineRequest) {
        baselineFailures += 1
        baselineFailureReason = failureText(error)
        clearStable()
        carrierOrBaselineLost()
      }
      return
    }
    if (stopped || atGeneration !== generation || request !== baselineRequest) return
    if (atRevision !== eventRevision) {
      // 列表的取样点未知；其间收到的事件可能比列表新。重新取样，不用旧列表覆写事件——
      // 但经 scheduleBaselineResample 合并 + 限速（review O1），不做无间隔递归。
      scheduleBaselineResample()
      return
    }
    const envelope = value as { items?: unknown } | null | undefined
    const rawItems = envelope?.items
    if (!Array.isArray(rawItems)) {
      // A successful RPC envelope is not a successful facts baseline when its
      // required items list is absent. Treating null as [] would certify an
      // unobserved source and suppress the runtime completion fallback.
      baselineFailures += 1
      baselineFailureReason = 'session/list: items missing or not an array'
      clearStable()
      carrierOrBaselineLost()
      return
    }
    const items = rawItems.map(rowFromListItem)
    if (items.some(row => row === null)) {
      // A partial list is not a trustworthy baseline. Reject it atomically so
      // no earlier row in this response can change running state or start a tail.
      baselineFailures += 1
      baselineFailureReason = 'session/list: row shape rejected (' + String(items.filter(row => row === null).length)
        + ' of ' + String(items.length) + ')'
      clearStable()
      carrierOrBaselineLost()
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
      rows.set(row.sessionId, mergeActivationIntoRow(row.sessionId, mergeBaselineRow(previous, row, at)))
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
    lastTrustedBaselineAt = at
    carrierLostAt = null
    clearCarrierGrace()
    armStableReconnectReset()
    emit()
  }

  /**
   * 对已观察到的 true→false 边沿和可能丢失两帧的提示水位读尾，然后分类。每条
   * true→false 边沿（status 或基线）恰好一次 follow 读尾再分类。completedAt
   * 优先取 tail 的 host turn/end.time（epoch ms）；拿不到就用观察者戳并标
   * reconstructed/observer——这是**降级而不是等价**：该时间不在 host 域，
   * 绝不能当作 host 水位，App 也因此不发通知（reconstructed = 只出未读，
   * 与 gateway 的缺口重建同规）。
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
        // 期限内没有 turn/end ⇒ **读不到确定性尾巴**：判 unreadable 并武装（判 neutral
        // 会让跨缺口完成在唯一证据缺失时静默丢失）；紧接着重跑由 running=true 结算。
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
      // 读不到尾巴 = 降级：仍武装（绝不丢真完成）并计数——观察者在跑但读不到尾巴的唯一可观测信号。
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
   * api-session/status：running 位边沿。未知会话用 emptyRow 建档（否则 readTail 因
   * row undefined 直接返回，基线后新建会话的完成永久不可见）；running=true 与
   * gateway applyStatus 同规：新一轮运行结算旧完成。
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
    rows.set(row.sessionId, mergeActivationIntoRow(row.sessionId, mergeBaselineRow(previous, row, now())))
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
    else if (event === 'goal/activation-changed') handleGoalActivation(args)
  }

  /**
   * 这里曾有一条 45s 静默换代看门狗（armSilence）。**已删除**，且不得复活：
   *
   * ① 静默不是内容证据——来源级 $events 静默不是本会话的内容进度（assistant 文本走
   *    独立 session/follow），长生成与别的会话的事件都会让这个信号说谎。页面内容证据
   *    只来自真正观测会话内容的观察者（gateway facts cursor），
   *    见 session-content-stall.ts 注册表。
   * ② 静默也不是载波证据——本机实测：观察者的 $events 逻辑流在整条 socket 的生命期
   *    只收到一帧 ready，**没有任何 emit**，而事实（行/字段）全部来自 30s 一次的 unary
   *    基线 session/list。也就是说这条逻辑流的边沿事实当前不可用，静默只反映"这个
   *    能力没有被实现/没有事件"，而非承载它的 socket 坏了；据此换代等于把唯一可用的
   *    载波周期性换掉（旧行为：9 次/8 分钟、寿命精确 45.0s、被换掉的 socket 每条命
   *    只收到 1 帧 147B = ready）。
   *
   * 结论：socket 活到来源退役为止。换代只由真失败驱动——$events 的 end/error 帧、
   * onclose/onerror、handshakeTimeout——并统一走 scheduleReconnect 的 1s→30s 有界退避。
   */

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
    // 换代即丢套接字，但**不丢真相**：可判性由 carrierOrBaselineLost 在本次代际上裁定
    // （有旧基线 → 宽限；从来没有 → 立即降级），等待下一个 onopen 之前绝不宣称新连接可用。
    socketReady = false
    clearStable()
    if (socket !== null) {
      // 换代。先 +1 再 close——close 可能同步触发旧 socket 的 onclose。
      generation += 1
      const previous = socket
      cancelFollows()
      socket = null
      clearReconcile()
      clearStable()
      try {
        previous.close()
      } catch {
        // 关旧连接失败不影响重连。
      }
    }
    carrierOrBaselineLost()
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
      // 不得在此清 baselineTrusted：手上有旧基线时策略是「记一次宽限」，清掉它会让
      // carrierOrBaselineLost 走「从来没有基线 ⇒ 立即降级」的臂，宽限形同不存在。
      clearReconcile()
      clearStable()
      carrierOrBaselineLost()
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
      armReconcile()
      runBaseline()
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
      if (frame.kind === 'ready') {
        const freshGeneration = !socketReady
        socketReady = true
        // ready 帧只证明**套接字腿**回来了，不证明 unary 基线还能成功：宽限只由成功基线或
        // 到期结束（否则一个迟到的 ready 帧就能无限续期「旧基线仍可用」，而 rows 早已停更）。
        // 旧基线是否仍可用由 baseline() 的结果说话，不由握手说话。
        // A single ready frame is not a stable connection. Repeated logical
        // stream failures must retain exponential backoff.
        armStableReconnectReset()
        // 新的 $events 代际（首连/换代重连；onopen 与 onclose 都置 socketReady=false）：
        // emit 型帧无重放 ⇒ 进程内 activation 不再可信，表与行一并清回 unknown。
        if (freshGeneration) clearGoalActivations()
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

  /**
   * 基线失败必须留证：baseline() 只覆盖预期失败，意外抛错若被 `void` 掉就是静默的
   * unhandled rejection（本缺陷的原始形状）。所有调用点都经这里：按失败记账并按
   * 「有旧基线则进宽限、没有则立刻降级」的同一策略重新判定可判性。
   */
  function runBaseline(): void {
    // 只保证「不静默」+ 重新判定可判性：不做失败记账——内部失败路径已经记过，消费者抛错再记
    // 一次会把一次失败计成两次、并用消费者错误覆盖真正的原因（探针实测 baselineFailures=2）。
    void baseline().catch(() => {
      carrierOrBaselineLost()
    })
  }

  function currentStatus(): SourceMuxStatus {
    syncStaleSince()
    return { ready: ready(), edges, lastEventAt, pendingReads,
      pendingClassifications: pendingTails.size, reconnects, baselines,
      baselineFailures, followFailures, socketErrors,
      carrierLostAt, staleSince, baselineFailureReason, baselineResamples, lastTrustedBaselineAt,
      rows: rows.size }
  }

  return {
    start(): void {
      if (!stopped) return
      stopped = false
      // 新订阅寿命：可判性相位清零（失败/基线计数按观察者对象累计，属于诊断不重置）。
      carrierLostAt = null
      clearCarrierGrace()
      staleSince = null
      publishSourceMuxInstrument(deps.sourceId, instrument)
      // 基线从连接 open 后取；连接失败时不得宣称已有可信事实。
      connect()
    },
    reconcile(): void {
      if (!stopped) runBaseline()
    },
    stop(): void {
      // 退役前的最后一次发布（唯一出口）：观察者停掉后**不再有任何载体刷新**，而
      // `emit()` 也会被 stopped 拦下——若把最后一份 readable 快照留在 store 里，判定面
      // 会继续把死载体的行当证据（`isFactsDecisionUsable` 仍是 true：读水位推进、完成
      // 观测、未读账本都还在用它）。保留最后一批行（在场证据不得清空，design 19 §3.2.4）+
      // 标不可用，与 gateway 事实源「保留既有行 + 标不可用」的两条出口同规。
      // 只在 `ready()` 时发：其余时刻 store 里最后一份快照本就是 degraded（每条降级
      // 出口都 emit 过），再发一份只是噪音。
      // 先记下退役前的可判性、再翻相位：退役快照发布后 status() 必须也报不可判，
      // 否则采样器读到的仍是 ready=1，环里永远不会出现「退役」这一转折。
      const wasReady = ready()
      stopped = true
      if (wasReady) {
        deps.onSnapshot({
          ...snapshot(),
          verdict: 'degraded',
          degradation: 'unavailable',
          hostState: 'unknown',
          serviceable: false,
          stale: true,
        })
      }
      lifetime += 1
      socketReady = false
      baselineTrusted = false
      carrierLostAt = null
      clearCarrierGrace()
      staleSince = null
      // 退役即代际终结：进程内 activation 绝不越过一次 stop/start。
      clearGoalActivations()
      // 代际 +1 作废在途回调；在途 baseline/readTail 的 emit 被 stopped 守卫拦下。
      generation += 1
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      clearConnectDeadline()
      clearReconcile()
      clearStable()
      clearBaselineResample()
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
