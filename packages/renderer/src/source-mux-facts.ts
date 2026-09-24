/**
 * Source mux facts —— SSH / 本地 dsh 来源的**无壳观察者**。
 *
 * 网关来源有只读镜像，而 SSH/本地 dsh 来源在没有挂载壳时没有任何事实通道，"关壳期间
 * 完成"仍会丢；本模块经控制面既有无鉴权实例代理观察**实例自己的**远程协议：$events
 * WebSocket（ws /api/i/<id>/api/remote.mux）+ unary（POST /api/i/<id>/api/<method>）。
 *
 * 硬纪律：①观察者**绝不发** `$events/result`（会替所有客户端结算等待中的审批），瀑布帧
 * 只观察不回答；②每条 true→false 边沿**恰好一次** `session/follow` 读尾 `turn/end.reason`
 * 分类（completed ⇒ 武装；aborted+user ⇒ 用户停止；其余 ⇒ 中立；读不到 ⇒ 降级仍武装）。
 * 基线只合 running/updatedAt(max)/factAt 与 goal 三值事实——只白名单取
 * `item.projections.values.goal` 的 id/revision/phase/updatedAt，objective/blockedReason 等其余
 * 投影键在解析处即丢弃；键缺席/形状不符 = unknown（绝不臆造「无 goal」），null = 宿主明确
 * 无 goal。activation 只来自 `$events` 的 `goal/activation-changed`（emit 帧无重放）：仅进程
 * 内存，绑定 goalId 的边保留待匹配，no-goal 边只即时清已知对象 goal（绝不缓存），新的 ready
 * 代际清回 unknown。连接代际纪律：被换掉 socket 的迟到回调不得改状态或调度重连。快照与
 * gateway 事实源**同形**，直接喂 App 既有的 applySessionFacts 管线。
 */
import { isRecord } from '@dsh-chamber/dsh-chamber-client-core'
import type {
  SessionFactsCompletedAtSource, SessionFactsRow, SessionFactsSnapshot, SessionFactsTurnEnd,
} from './session-facts-source.ts'

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
  /** 事件静默窗口（默认 45s，与 watcher 一致）。 */
  silenceTimeoutMs?: number
  /** session/list 基线 deadline（默认 5s；半死隧道下不得永久挂起）。 */
  baselineTimeoutMs?: number
  /** 每条边沿 session/follow 的 deadline（默认 2s，与 control-plane/session-mux.ts 同预算）。 */
  followTimeoutMs?: number
}

export const MUX_PATH = '/api/remote.mux'
export const EVENTS_ENDPOINT = '$events'
export const DEFAULT_FACTS_SILENCE_MS = 45_000
/** 基线 unary deadline——半死隧道下「挂起」必须在预算内变成可数的失败。 */
export const DEFAULT_BASELINE_TIMEOUT_MS = 5_000
/** 完成边沿读尾 deadline（对齐 control-plane/session-mux.ts 的 2s 预算）。 */
export const DEFAULT_FOLLOW_TIMEOUT_MS = 2_000
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
  kind: 'ready' | 'emit' | 'waterfall' | 'cancel' | 'other'
  streamId: string
  event?: string
  args?: unknown
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
  if (frame.type !== 'item' || typeof frame.streamId !== 'string') return null
  const value = frame.value as { type?: unknown; event?: unknown; args?: unknown } | null
  if (value === null || typeof value !== 'object') return { kind: 'other', streamId: frame.streamId }
  if (value.type === 'ready') return { kind: 'ready', streamId: frame.streamId }
  if (value.type === 'emit') {
    return { kind: 'emit', streamId: frame.streamId, event: typeof value.event === 'string' ? value.event : undefined, args: value.args }
  }
  if (value.type === 'waterfall') return { kind: 'waterfall', streamId: frame.streamId }
  if (value.type === 'cancel') return { kind: 'cancel', streamId: frame.streamId }
  return { kind: 'other', streamId: frame.streamId }
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
  const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
  const row = emptyRow(sessionId, item.running === true, updatedAt)
  // 三值：unknown 时**不写** goal 键（`goal: undefined` 与缺席在快照里无法区分）。
  const goal = parseProjectedGoalFact(item)
  if (goal !== undefined) row.goal = goal
  return row
}

/** api-session/status 载荷：冻结 wire 是 [sessionId, running]，对象形一并接受（不因形状漂移丢边沿）。 */
export function parseStatusArgs(args: unknown): { sessionId: string; running: boolean } | null {
  if (Array.isArray(args)) {
    const sessionId = args[0]
    if (typeof sessionId !== 'string' || sessionId === '') return null
    return { sessionId, running: args[1] === true }
  }
  if (isRecord(args)) {
    const sessionId = args.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return null
    return { sessionId, running: args.running === true }
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
 * 新一轮运行结算旧完成。
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
  status(): SourceMuxStatus
}

/** 无壳观察者：一次 $events 订阅 + 每条完成边沿一次 session/follow；I/O 全经注入缝。 */
export function createSourceMuxFacts(deps: SourceMuxDeps): SourceMuxFacts {
  const now = deps.now ?? (() => Date.now())
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const openSocket = deps.openSocket ?? ((url: string) => new WebSocket(url) as unknown as MuxSocket)
  const base = muxBaseFor(deps.origin, deps.sourceId)
  const silenceMs = deps.silenceTimeoutMs ?? DEFAULT_FACTS_SILENCE_MS
  const baselineTimeoutMs = deps.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS
  const followTimeoutMs = deps.followTimeoutMs ?? DEFAULT_FOLLOW_TIMEOUT_MS
  const rows = new Map<string, SourceMuxRow>()
  const runningBefore = new Map<string, boolean>()
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
  let ready = false
  let edges = 0
  let reconnects = 0
  let lastEventAt: number | null = null
  let pendingReads = 0
  let baselines = 0
  let baselineFailures = 0
  let followFailures = 0
  let socketErrors = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 连接代际：connect() 换掉旧 socket / onclose 确认死亡时代际 +1；旧代际的一切回调
   * （含在途基线）不得再改状态或调度重连——否则旧 socket 的 onclose 会在每次静默
   * 重订阅后再排一次 1s 重连（自激洪泛）。
   */
  let generation = 0
  // 重连指数退避（1s 起、30s 封顶）：源长时间不可达时不得变成每秒一次的重试洪流。
  let reconnectDelayMs = 1_000
  const MAX_RECONNECT_DELAY_MS = 30_000
  const instrument = (): SourceMuxStatus => currentStatus()

  /** **与 gateway 事实源同形**的快照（同一套字段，App 因此走同一条管线）。 */
  function snapshot(): SessionFactsSnapshot {
    const record: Record<string, SessionFactsRow> = {}
    for (const [sessionId, row] of rows) record[sessionId] = row
    return {
      // 观察者自带通道：verdict=ok 表示"这条通道可用"，与网关镜像的版本协商无关。
      // 全程走 WS mux + unary、从不轮询，因此 mode 诚实报 null（'sse'/'poll' 是
      // gateway 平面的词；唯一消费 mode 的 startDelivery 只读自己 payload 的 mode）。
      verdict: ready ? 'ok' : 'degraded',
      degradation: ready ? null : 'unavailable',
      mode: null,
      hostState: ready ? 'ready' : 'unknown',
      serviceable: ready,
      stale: !ready,
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
   * 新的 $events 代际（ready 假→真；含重连与静默重订）：emit 型帧无重放 ⇒ 进程内 activation
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
      const response = await Promise.race([
        fetchImpl(base + '/api/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
          signal: controller.signal,
        }),
        expired,
      ])
      if (!response.ok) throw new Error(method + ' http ' + response.status)
      const body = await response.json() as { type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: unknown } }
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

  /**
   * 基线对账：只合 running/updatedAt(max)/factAt 与 goal 三值事实，保留既有完成字段。
   * previous.running===true && row.running===false 是重订阅后跨缺口完成的**唯一证据**
   * （$events 开场不重放 status）⇒ 与 status 边沿同一条 readTail 路径；基线也播种 runningBefore。
   */
  async function baseline(): Promise<void> {
    const atGeneration = generation
    let value: unknown
    try {
      value = await rpc('session/list', { args: { _request: {} } }, baselineTimeoutMs)
    } catch {
      // 失败 = 本次连接事实不可信（不能静默：必须能区分「没完成」与「观察者坏了」）。
      if (!stopped && atGeneration === generation) baselineFailures += 1
      return
    }
    if (stopped || atGeneration !== generation) return
    const envelope = value as { items?: unknown } | null | undefined
    const rawItems = envelope === null || envelope === undefined ? undefined : envelope.items
    const items: unknown[] = Array.isArray(rawItems) ? rawItems : []
    baselines += 1
    const at = now()
    for (const item of items) {
      const row = rowFromListItem(item)
      if (row === null) continue
      const previous = rows.get(row.sessionId)
      runningBefore.set(row.sessionId, row.running)
      rows.set(row.sessionId, mergeActivationIntoRow(row.sessionId, mergeBaselineRow(previous, row, at)))
      if (previous !== undefined && previous.running === true && row.running === false) {
        edges += 1
        void readTail(row.sessionId)
      }
    }
    emit()
  }

  /**
   * 每条 true→false 边沿（status 或基线）恰好一次 follow 读尾再分类。completedAt
   * 优先取 tail 的 host turn/end.time；拿不到就用观察者戳并标 reconstructed/observer
   * ——这是**降级而不是等价**：该时间不在 host 域，绝不能当作 host 水位，App 也因此
   * 不发通知（reconstructed = 只出未读，与 gateway 的缺口重建同规）。
   */
  async function readTail(sessionId: string): Promise<void> {
    pendingReads += 1
    try {
      const value = await rpc('session/follow', followPayload(sessionId), followTimeoutMs)
      if (stopped) return
      const tail = parseFollowTail(value)
      const row = rows.get(sessionId)
      if (row === undefined) return
      if (tail.turnEnd === null) {
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
      if (stopped) return
      // 读不到尾巴 = 降级：仍武装（绝不丢真完成）并计数——观察者在跑但读不到尾巴的唯一可观测信号。
      followFailures += 1
      const row = rows.get(sessionId)
      if (row !== undefined) {
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
      pendingReads -= 1
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
    const previousRunning = runningBefore.get(sessionId)
    runningBefore.set(sessionId, running)
    const previous = rows.get(sessionId) ?? emptyRow(sessionId, running, 0)
    rows.set(sessionId, running
      ? { ...previous, running: true, completedAt: null, completedAtSource: null, lastTurnEnd: null, factAt: now() }
      : { ...previous, running: false, factAt: now() })
    if (previousRunning === true && running === false) {
      edges += 1
      void readTail(sessionId)
    } else {
      emit()
    }
  }

  /** api-session/added：白名单行直接建/合行（不产边沿；状态边沿仍由 status 负责）。 */
  function handleAdded(args: unknown): void {
    const item = Array.isArray(args) ? args[0] : args
    const row = rowFromListItem(item)
    if (row === null) return
    const previous = rows.get(row.sessionId)
    runningBefore.set(row.sessionId, row.running)
    rows.set(row.sessionId, mergeActivationIntoRow(row.sessionId, mergeBaselineRow(previous, row, now())))
    emit()
  }

  /** api-session/activity：host 域水位（只升不降）。 */
  function handleActivity(args: unknown): void {
    const pair = Array.isArray(args) ? args : []
    const sessionId = pair[0]
    const updatedAt = pair[1]
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return
    const previous = rows.get(sessionId) ?? emptyRow(sessionId, false, 0)
    if (updatedAt <= previous.updatedAt) return
    rows.set(sessionId, { ...previous, updatedAt, factAt: now() })
    emit()
  }

  /** api-session/removed：host 删会话 ⇒ 从行与 running 记忆移除（删除不是完成）。 */
  function handleRemoved(args: unknown): void {
    const sessionId = Array.isArray(args) ? args[0] : args
    if (typeof sessionId !== 'string' || sessionId === '') return
    const hadRow = rows.delete(sessionId)
    runningBefore.delete(sessionId)
    // goal 与 activation 随行消亡：重建的会话不得继承旧 activation。
    goalActivations.delete(sessionId)
    if (hadRow) emit()
  }

  function handleEmit(event: string | undefined, args: unknown): void {
    if (event === 'api-session/status') handleStatus(args)
    else if (event === 'api-session/added') handleAdded(args)
    else if (event === 'api-session/activity') handleActivity(args)
    else if (event === 'api-session/removed') handleRemoved(args)
    else if (event === 'goal/activation-changed') handleGoalActivation(args)
  }

  function armSilence(): void {
    clearSilence()
    const armedGeneration = generation
    silenceTimer = setTimeout(() => {
      silenceTimer = null
      if (stopped || armedGeneration !== generation) return
      // 连接在、事件停 ⇒ 重订阅 + 重取基线。
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
    if (socket !== null) {
      // 换代。先 +1 再 close——close 可能同步触发旧 socket 的 onclose。
      generation += 1
      const previous = socket
      socket = null
      clearSilence()
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
    next.onopen = () => {
      if (stopped || connectGeneration !== generation) return
      ready = false
      // 观察者开场：只开 $events；**永不**发 $events/result（不结算任何瀑布）。
      next.send(openEventsFrame())
      armSilence()
      void baseline()
    }
    next.onmessage = event => {
      if (stopped || connectGeneration !== generation) return
      const frame = parseMuxFrame(event?.data)
      if (frame === null) return
      lastEventAt = now()
      armSilence()
      if (frame.kind === 'ready') {
        // 新的 $events 代际（首连/重连/静默重订；onopen 与 onclose 都置 ready=false）：
        // emit 型帧无重放 ⇒ 进程内 activation 不再可信，表与行一并清回 unknown。
        const freshGeneration = !ready
        ready = true
        // 连上并握手成功 ⇒ 退避复位（下一次断线仍从 1s 起）。
        reconnectDelayMs = 1_000
        if (freshGeneration) clearGoalActivations()
        emit()
        return
      }
      // 瀑布只观察，不回答：这里没有任何 send。
      if (frame.kind === 'emit') handleEmit(frame.event, frame.args)
    }
    next.onclose = () => {
      if (stopped || connectGeneration !== generation) return
      // 本代际死亡：+1 让一切迟到回调与在途基线作废，再由下一次连接重新对账。
      generation += 1
      socket = null
      ready = false
      clearSilence()
      emit()
      scheduleReconnect()
    }
    next.onerror = () => {
      if (stopped || connectGeneration !== generation) return
      // onclose 会跟着来（这里不重复调度），但错误要计数：否则「服务器拒绝」与
      // 「网络抖」在仪表上长得一样。
      socketErrors += 1
    }
  }

  function currentStatus(): SourceMuxStatus {
    return { ready, edges, lastEventAt, pendingReads, reconnects, baselines, baselineFailures, followFailures, socketErrors }
  }

  return {
    start(): void {
      if (!stopped) return
      stopped = false
      publishSourceMuxInstrument(deps.sourceId, instrument)
      // 观察者必须先有行才能判定边沿：基线失败也继续（事件仍会带来状态帧）。
      void baseline()
      connect()
    },
    stop(): void {
      stopped = true
      ready = false
      // 退役即代际终结：进程内 activation 绝不越过一次 stop/start。
      clearGoalActivations()
      // 代际 +1 作废在途回调；在途 baseline/readTail 的 emit 被 stopped 守卫拦下。
      generation += 1
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      clearSilence()
      reconnectTimer = null
      const current = socket
      socket = null
      try {
        current?.close()
      } catch {
        // 忽略关闭异常（幂等 stop）。
      }
      // 退役的观察者不得继续以本源的名义出现在观测仪器里。
      unpublishSourceMuxInstrument(deps.sourceId, globalThis, instrument)
    },
    status(): SourceMuxStatus {
      return currentStatus()
    },
  }
}

