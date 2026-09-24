/**
 * 未读 v2 落盘存储。
 *
 * v2 载荷 { v:2, read, edge, notified, pending, outcomes }：read/sourceId/sessionId →
 * host 域读水位（只升不降，max 合并）；edge → true（边沿轨回退账本，重启后立即可渲染
 * 未读）；notified/sourceId/sessionId/kind → 已通知水位（第二入口去重）；pending →
 * 目标活跃期间被压制的完成结算位（watermark/goalId/at，与 notified 同生命周期）；
 * outcomes/sourceId/goalId → 目标/中性标题的一次性身份水位。载荷**不得出现
 * title/cwd/消息内容**（隐私条），键白名单锁在单测里。
 *
 * 存储访问器 lazy + never-throw（照 view-prefs.ts 的形状）：私有模式/配额
 * 失败只降级为内存态，绝不影响本地未读。
 *
 * 单例纪律：N 个 ctx 共享一个 localStorage，逐调用点
 * setItem 会 last-writer-wins 丢标记；App 侧只经本模块的 merge/prune/save
 * 三个可组合步骤写盘（App 持有内存权威，v2 是缓存）。
 *
 * `POST /read` / `/read-all` 的 ack 失败（网络错误 /
 * 5xx）进**有界内存待发表**（UNREAD_PENDING_MAX），facts 源每收到一帧服务端
 * 数据（probe 快照 / SSE sync·增量·心跳）就重放一次；幂等依据（服务端逐条
 * max 合并）写在 createUnreadAckOutbox 头注里。本机内存/落盘仍是权威，
 * 待发表只影响"服务端何时知道"，绝不影响未读判定。
 */

import { createBoundedMap } from './bounded-ledger.ts'
import { isWatermark, maxWatermarkValue } from './watermark.ts'
import type { UnreadKind } from './watermark.ts'
import type { GoalOutcomeTable, PendingCompletion, PendingCompletionTable } from './complete-ledger.ts'

/** v2 落盘键（唯一被读写的未读键）。 */
export const UNREAD_V2_KEY = 'dsh-chamber.unread.v2'

/** client-install id 键（首启生成一次；重装 = 新 id，旧标记由服务端 TTL 清理）。 */
export const CLIENT_INSTALL_ID_KEY = 'dsh-chamber.client-install-id.v1'
/** 每来源读标记上限（按水位 LRU）。 */
export const UNREAD_MAX_SESSIONS_PER_SOURCE = 500
/** client-install id 语法（与 control-plane SESSION_STATE_CLIENT_ID_PATTERN 同形）。 */
export const CLIENT_INSTALL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

export interface UnreadV2Payload {
  v: 2
  /** sourceId → sessionId → host 域读水位。 */
  read: Record<string, Record<string, number>>
  /** sourceId → sessionId → true（边沿轨回退账本 / 上次派生未读投影）。 */
  edge: Record<string, Record<string, boolean>>
  /** sourceId → sessionId → kind → 已通知水位（第二入口去重）。 */
  notified: Record<string, Record<string, Partial<Record<UnreadKind, number>>>>
  /**
   * sourceId → sessionId → 被压制的完成结算位（v5 §3.1）。字段可选以兼容旧写入点
   * （App 未迁移前只写四表）：缺字段 = 空表 + loud（见 sanitizeUnreadPayload）。
   */
  pending?: PendingCompletionTable
  /** sourceId → goalId → 目标/中性标题一次性身份水位。缺字段 = 空表 + loud。 */
  outcomes?: GoalOutcomeTable
}

/** Storage 的结构子集（浏览器 localStorage 或测试假实现）。 */
export interface UnreadStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function emptyUnreadPayload(): UnreadV2Payload {
  return { v: 2, read: {}, edge: {}, notified: {}, pending: {}, outcomes: {} }
}

/** pending 表（缺字段 = 空表；sanitize 负责把坏项剥掉并 loud）。 */
export function unreadPendingTable(payload: UnreadV2Payload): PendingCompletionTable {
  return payload.pending ?? {}
}

/** outcomes 表（缺字段 = 空表）。 */
export function unreadOutcomeTable(payload: UnreadV2Payload): GoalOutcomeTable {
  return payload.outcomes ?? {}
}

/** 浏览器 localStorage 的安全访问器；不可用时 undefined（降级为纯内存）。 */
export function browserUnreadStorage(): UnreadStorageLike | undefined {
  try {
    const storage = globalThis.localStorage
    if (storage === undefined || storage === null) return undefined
    if (typeof storage.getItem !== 'function') return undefined
    return storage
  } catch {
    return undefined
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function warn(message: string, error?: unknown): void {
  console.warn('[unread] ' + message, error ?? '')
}


/** 宽松清洗：只留下合法键值，剥掉坏项（不整包丢弃）。 */
export function sanitizeUnreadPayload(value: unknown): UnreadV2Payload {
  const payload = emptyUnreadPayload()
  if (!isPlainRecord(value)) return payload
  const read = isPlainRecord(value.read) ? value.read : {}
  for (const [sourceId, marks] of Object.entries(read)) {
    if (!isPlainRecord(marks)) continue
    const table: Record<string, number> = {}
    for (const [sessionId, mark] of Object.entries(marks)) {
      if (isWatermark(mark)) table[sessionId] = mark
    }
    if (Object.keys(table).length > 0) payload.read[sourceId] = table
  }
  const edge = isPlainRecord(value.edge) ? value.edge : {}
  for (const [sourceId, sessions] of Object.entries(edge)) {
    if (!isPlainRecord(sessions)) continue
    const table: Record<string, boolean> = {}
    for (const [sessionId, armed] of Object.entries(sessions)) {
      if (armed === true) table[sessionId] = true
    }
    if (Object.keys(table).length > 0) payload.edge[sourceId] = table
  }
  const notified = isPlainRecord(value.notified) ? value.notified : {}
  for (const [sourceId, sessions] of Object.entries(notified)) {
    if (!isPlainRecord(sessions)) continue
    const table: Record<string, Partial<Record<UnreadKind, number>>> = {}
    for (const [sessionId, kinds] of Object.entries(sessions)) {
      if (!isPlainRecord(kinds)) continue
      const row: Partial<Record<UnreadKind, number>> = {}
      for (const kind of ['complete', 'ask', 'request'] as const) {
        if (isWatermark(kinds[kind])) row[kind] = kinds[kind]
      }
      if (Object.keys(row).length > 0) table[sessionId] = row
    }
    if (Object.keys(table).length > 0) payload.notified[sourceId] = table
  }
  // pending / outcomes（v5 §3.1 增量）：缺字段 = 空 + loud；存在则逐字段校验。
  if (value.pending === undefined) {
    warn('v2 payload has no pending table; treating it as empty')
  } else if (!isPlainRecord(value.pending)) {
    warn('v2 payload.pending is not a table; treating it as empty')
  } else {
    for (const [sourceId, sessions] of Object.entries(value.pending)) {
      if (!isPlainRecord(sessions)) {
        warn('v2 payload.pending[' + sourceId + '] is not a table; dropped')
        continue
      }
      const table: Record<string, PendingCompletion> = {}
      for (const [sessionId, entry] of Object.entries(sessions)) {
        if (!isPlainRecord(entry)) {
          warn('v2 payload.pending entry ' + sourceId + '/' + sessionId + ' is not an object; dropped')
          continue
        }
        if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) {
          warn('v2 payload.pending entry ' + sourceId + '/' + sessionId + ' has no finite at; dropped')
          continue
        }
        const sanitized: PendingCompletion = { at: entry.at }
        if (isWatermark(entry.watermark)) sanitized.watermark = entry.watermark
        else if (entry.watermark !== undefined) warn('v2 payload.pending entry ' + sourceId + '/' + sessionId + ' has an invalid watermark; field dropped')
        if (typeof entry.goalId === 'string' && entry.goalId.length > 0) sanitized.goalId = entry.goalId
        else if (entry.goalId !== undefined) warn('v2 payload.pending entry ' + sourceId + '/' + sessionId + ' has an invalid goalId; field dropped')
        // G4 延迟来源（评审 F5 阻断项 1）：deferred 是 pending 的 durable 身份，丢了它
        // 同页 reload 后 busy 延迟的完成既不会中性释放、又可能被 #3 静默 drop——严格按
        // 合法值拷贝；非法值只丢该字段，绝不整条丢弃（at 才是条目的成立条件）。
        if (entry.deferred === 'subagent-busy') sanitized.deferred = 'subagent-busy'
        else if (entry.deferred !== undefined) warn('v2 payload.pending entry ' + sourceId + '/' + sessionId + ' has an invalid deferred; field dropped')
        table[sessionId] = sanitized
      }
      if (Object.keys(table).length > 0) payload.pending![sourceId] = table
    }
  }
  if (value.outcomes === undefined) {
    warn('v2 payload has no outcomes table; treating it as empty')
  } else if (!isPlainRecord(value.outcomes)) {
    warn('v2 payload.outcomes is not a table; treating it as empty')
  } else {
    for (const [sourceId, goals] of Object.entries(value.outcomes)) {
      if (!isPlainRecord(goals)) {
        warn('v2 payload.outcomes[' + sourceId + '] is not a table; dropped')
        continue
      }
      const table: Record<string, number> = {}
      for (const [goalId, watermark] of Object.entries(goals)) {
        if (isWatermark(watermark)) table[goalId] = watermark
        else warn('v2 payload.outcomes entry ' + sourceId + '/' + goalId + ' is not a watermark; dropped')
      }
      if (Object.keys(table).length > 0) payload.outcomes![sourceId] = table
    }
  }
  return payload
}

/** 剪除空表（序列化前调用；保证载荷最小、无噪声键）。 */
export function pruneEmptyUnreadTables(payload: UnreadV2Payload): UnreadV2Payload {
  const next = emptyUnreadPayload()
  for (const [sourceId, table] of Object.entries(payload.read)) {
    if (Object.keys(table).length > 0) next.read[sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(payload.edge)) {
    if (Object.keys(table).length > 0) next.edge[sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(payload.notified)) {
    if (Object.keys(table).length > 0) next.notified[sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(unreadPendingTable(payload))) {
    if (Object.keys(table).length > 0) next.pending![sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(unreadOutcomeTable(payload))) {
    if (Object.keys(table).length > 0) next.outcomes![sourceId] = table
  }
  return next
}

/** 有界化（按水位 LRU）：每来源 read 保留水位最高的 maxPerSource 条；edge/notified 与 read 同界。 */
export function pruneUnreadPayload(payload: UnreadV2Payload, maxPerSource = UNREAD_MAX_SESSIONS_PER_SOURCE): UnreadV2Payload {
  if (maxPerSource <= 0) return emptyUnreadPayload()
  const next = emptyUnreadPayload()
  for (const [sourceId, table] of Object.entries(payload.read)) {
    const entries = Object.entries(table)
    if (entries.length <= maxPerSource) {
      next.read[sourceId] = { ...table }
      continue
    }
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const kept: Record<string, number> = {}
    for (const [sessionId, mark] of entries.slice(0, maxPerSource)) kept[sessionId] = mark
    next.read[sourceId] = kept
  }
  for (const [sourceId, table] of Object.entries(payload.edge)) {
    const read = next.read[sourceId] ?? {}
    const keys = Object.keys(table)
    const kept: Record<string, boolean> = {}
    for (const sessionId of keys) {
      if (Object.prototype.hasOwnProperty.call(read, sessionId)) kept[sessionId] = true
      if (Object.keys(kept).length >= maxPerSource) break
    }
    for (const sessionId of keys) {
      if (Object.keys(kept).length >= maxPerSource) break
      if (kept[sessionId] === true) continue
      kept[sessionId] = true
    }
    if (Object.keys(kept).length > 0) next.edge[sourceId] = kept
  }
  for (const [sourceId, table] of Object.entries(payload.notified)) {
    const read = next.read[sourceId] ?? {}
    const keys = Object.keys(table)
    const kept: Record<string, Partial<Record<UnreadKind, number>>> = {}
    for (const sessionId of keys) {
      if (Object.prototype.hasOwnProperty.call(read, sessionId)) kept[sessionId] = table[sessionId]
      if (Object.keys(kept).length >= maxPerSource) break
    }
    for (const sessionId of keys) {
      if (Object.keys(kept).length >= maxPerSource) break
      if (kept[sessionId] !== undefined) continue
      kept[sessionId] = table[sessionId]
    }
    if (Object.keys(kept).length > 0) next.notified[sourceId] = kept
  }
  // pending 与 read 同界：先保留 read 里出现的会话，再按插入序补足（同 edge/notified）。
  for (const [sourceId, table] of Object.entries(unreadPendingTable(payload))) {
    const read = next.read[sourceId] ?? {}
    const keys = Object.keys(table)
    const kept: Record<string, PendingCompletion> = {}
    for (const sessionId of keys) {
      if (Object.prototype.hasOwnProperty.call(read, sessionId)) kept[sessionId] = table[sessionId]
      if (Object.keys(kept).length >= maxPerSource) break
    }
    for (const sessionId of keys) {
      if (Object.keys(kept).length >= maxPerSource) break
      if (kept[sessionId] !== undefined) continue
      kept[sessionId] = table[sessionId]
    }
    if (Object.keys(kept).length > 0) next.pending![sourceId] = kept
  }
  // outcomes 以 goalId 为键（无法对齐 read 的 session 界）：每来源按水位 LRU 保留上限条。
  for (const [sourceId, table] of Object.entries(unreadOutcomeTable(payload))) {
    const entries = Object.entries(table)
    if (entries.length <= maxPerSource) {
      next.outcomes![sourceId] = { ...table }
      continue
    }
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const kept: Record<string, number> = {}
    for (const [goalId, watermark] of entries.slice(0, maxPerSource)) kept[goalId] = watermark
    next.outcomes![sourceId] = kept
  }
  return next
}

// ── 载入 / 保存 ────────────────────────────────────────────────────────────

/**
 * 载入 v2：可解析且 v===2 ⇒ 逐字段清洗（坏字段就地剥掉）；缺失/整包损坏
 * ⇒ 空载荷（不猜测、不部分解析）。v1 键从来没有写入者，其防御性导入已删除
 * （见头注与 test/session-state/unread-store.test.ts 的"v2 是唯一读取键"锁）。
 */
export function loadUnread(storage: UnreadStorageLike | undefined): UnreadV2Payload {
  if (storage === undefined) return emptyUnreadPayload()
  let raw2: string | null = null
  try {
    raw2 = storage.getItem(UNREAD_V2_KEY)
  } catch {
    raw2 = null
  }
  if (raw2 === null || raw2 === '') return emptyUnreadPayload()
  try {
    const value: unknown = JSON.parse(raw2)
    if (isPlainRecord(value) && value.v === 2) return sanitizeUnreadPayload(value)
  } catch {
    // 整包坏 = 无 v2：空载荷（本机内存仍是权威，App 由事实重算）。
  }
  return emptyUnreadPayload()
}

/** 写盘（剪空表 + 有界化）；返回是否成功。never-throw。 */
export function saveUnread(storage: UnreadStorageLike | undefined, payload: UnreadV2Payload): boolean {
  if (storage === undefined) return false
  try {
    storage.setItem(UNREAD_V2_KEY, JSON.stringify(pruneUnreadPayload(pruneEmptyUnreadTables(payload))))
    return true
  } catch (error) {
    warn('cannot persist unread v2', error)
    return false
  }
}

// ── immediate 落盘合并（热路径：同一 tick 多次 immediate ⇒ 一次全量写盘） ─────

/**
 * immediate 落盘合并器（OPT P1 热路径）：voided / dropped / flushed 这类 durable 结算必须
 * **立即**落盘（goal-aware v5 §3.5：1s 节流窗口内崩溃重放不得复活已作废的 pending），但
 * 一批 reconcile 一拍内可产生多次 immediate，每次全量 prune + stringify（208KB 实测约
 * 6.5ms）会钉住主线程；合并窗口取**微任务**（可注入以测试控时），同一 tick 的 N 次
 * immediate 收敛成一次落盘，语义顺序由「落盘时读当时最新权威内存」保证（合并只推迟写，
 * 不改变写内容）。flush 是**关键路径**（pagehide / visibilitychange hidden / unmount）：
 * 取消待办并同步落盘一次——不丢、不重复；never-throw 由传入的 persist 负责（App 侧就是
 * saveUnread 的 never-throw 出口）。
 */
export interface UnreadSaveCoalescer {
  /** 请求一次落盘；已有待办时合并（同一 tick 多次 request = 一次 persist）。 */
  request(): void
  /** 关键路径同步落盘：取消待办并立即 persist 一次（无待办也照常落盘）。 */
  flush(): void
  /** 取消待办（不落盘；teardown 用）。 */
  cancel(): void
  /** 是否有待办的合并窗口（诊断/测试）。 */
  pending(): boolean
}

/** 合并窗口的调度器（默认微任务；测试注入手动队列）。 */
export type UnreadSaveDefer = (run: () => void) => void

/** 创建 immediate 落盘合并器；persist 必须是 never-throw 的落盘出口。 */
export function createUnreadSaveCoalescer(
  persist: () => void,
  defer: UnreadSaveDefer = queueMicrotask,
): UnreadSaveCoalescer {
  let scheduled = false
  let ticket = 0
  /** 只执行仍属当前待办的那一次调度；flush/cancel 通过 ticket 使其作废。 */
  const runScheduled = (at: number): void => {
    if (!scheduled || at !== ticket) return
    scheduled = false
    persist()
  }
  return {
    request(): void {
      if (scheduled) return
      scheduled = true
      const at = ++ticket
      defer(() => { runScheduled(at) })
    },
    flush(): void {
      scheduled = false
      ticket += 1
      persist()
    },
    cancel(): void {
      scheduled = false
      ticket += 1
    },
    pending(): boolean {
      return scheduled
    },
  }
}

// ── 单调合并 / 推进 ─────────────────────────────────────────────────────────

/** 逐会话 max 合并（只升不降）：remote 缺席/坏值不改变本地；比较只用 host 域整数水位。 */
export function mergeReadMarks(
  local: Readonly<Record<string, number>>,
  remote: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  if (remote === undefined) return local as Record<string, number>
  let changed = false
  const next: Record<string, number> = { ...local }
  for (const [sessionId, mark] of Object.entries(remote)) {
    if (!isWatermark(mark)) continue
    const current = next[sessionId]
    if (current === undefined || mark > current) {
      next[sessionId] = mark
      changed = true
    }
  }
  return changed ? next : (local as Record<string, number>)
}

/** 读标记推进（单调、0/undefined 安全、严格 >）。 */
export function advanceReadMark(current: number | undefined, watermark: number | undefined): number | undefined {
  if (!isWatermark(watermark) || watermark === 0) return current
  if (current === undefined || watermark > current) return watermark
  return current
}

/** 每会话内容水位 = max(updatedAt, completedAt)；返回全表最大（read-all 的 through）。 */
export function maxWatermark(
  rows: Readonly<Record<string, { updatedAt?: number; completedAt?: number | null }>>,
): number {
  let max = 0
  for (const row of Object.values(rows)) {
    const watermark = maxWatermarkValue(row.updatedAt, row.completedAt)
    if (watermark > max) max = watermark
  }
  return max
}


interface CryptoLike {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

/** 生成一次安装 id：randomUUID → getRandomValues hex → Math.random 拼装 + warn。 */
export function createClientInstallId(cryptoImpl?: CryptoLike): string {
  const cryptoValue = cryptoImpl ?? (globalThis.crypto as CryptoLike | undefined)
  try {
    const uuid = cryptoValue?.randomUUID?.()
    if (typeof uuid === 'string' && CLIENT_INSTALL_ID_PATTERN.test(uuid)) return uuid
  } catch { /* fall through */ }
  try {
    if (cryptoValue?.getRandomValues !== undefined) {
      const bytes = cryptoValue.getRandomValues(new Uint8Array(16))
      let hex = ''
      for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
      if (CLIENT_INSTALL_ID_PATTERN.test(hex)) return hex
    }
  } catch { /* fall through */ }
  warn('crypto unavailable; falling back to Math.random for the client-install id')
  let fallback = ''
  for (let index = 0; index < 32; index += 1) fallback += Math.floor(Math.random() * 16).toString(16)
  return fallback
}

/** 读取或首启生成并落盘 client-install id；写失败只降级为内存态。 */
export function loadClientInstallId(
  storage: UnreadStorageLike | undefined,
  create: () => string = createClientInstallId,
): string {
  if (storage !== undefined) {
    try {
      const raw = storage.getItem(CLIENT_INSTALL_ID_KEY)
      if (raw !== null && raw !== '') {
        const value: unknown = JSON.parse(raw)
        if (isPlainRecord(value) && typeof value.id === 'string' && CLIENT_INSTALL_ID_PATTERN.test(value.id)) {
          return value.id
        }
      }
    } catch {
    }
  }
  const id = create()
  if (storage !== undefined) {
    try {
      storage.setItem(CLIENT_INSTALL_ID_KEY, JSON.stringify({ v: 1, id, createdAt: Date.now() }))
    } catch (error) {
      warn('cannot persist the client-install id; staying in-memory', error)
    }
  }
  return id
}


/**
 * 待发 ack 队列上限（条目数；最坏内存 = 上限 × 单条 {sourceId, sessionId, 水位}，
 * 不含任何会话内容）。必须有界：离线/跨端竞态/网关重启期间每次读推进都会产生一条 ack。
 * 淘汰先同键合并（键 = sourceId + 方法 + sessionId；服务端本身单调 max 合并，只保留
 * 水位更高的那条），再 FIFO 丢最久入队的键并报诊断。「内存有界优先于严格送达」的显式
 * 取舍：本机内存/落盘仍是权威，下次读推进会重新入队。
 */
export const UNREAD_PENDING_MAX = 64

/** 上行方法；与 session-facts-source 的两条 ack 路由一一对应。 */
export type UnreadAckMethod = 'read' | 'read-all'

/** 一条待发 ack：url 与 payload 原样保存，重放与首次上行逐字节相同。 */
export interface UnreadAckRequest {
  sourceId: string
  method: UnreadAckMethod
  url: string
  payload: Readonly<Record<string, unknown>>
  key: string
  /** 水位（read 的 readThrough / read-all 的 through）；同键比较与出队核对。 */
  watermark: number
}

/**
 * 单次上行结果：`ok`=2xx（重复投递 no-op）；`retryable`=网络错误/5xx/408/429（重放有意义）；
 * `permanent`=其余非 2xx（重放不可能成功，出队并报诊断，避免毒条目永久占位）。
 */
export type UnreadAckOutcome = 'ok' | 'retryable' | 'permanent'

export interface UnreadAckSendResult {
  outcome: UnreadAckOutcome
  status: number | null
  error?: unknown
}

/** 幂等 max 上行（单发；never-throw）：POST JSON，same-origin，no-store。 */
export async function sendUnreadRequest(
  fetchImpl: typeof fetch,
  url: string,
  payload: Record<string, unknown>,
): Promise<UnreadAckSendResult> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(payload),
    })
    if (response.ok === true) return { outcome: 'ok', status: response.status }
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429
    return { outcome: retryable ? 'retryable' : 'permanent', status: response.status }
  } catch (error) {
    return { outcome: 'retryable', status: null, error }
  }
}

export interface UnreadAckOutboxOptions {
  fetchImpl: typeof fetch
  /** 队列上限（条目数）；默认 UNREAD_PENDING_MAX，0 = 关闭队列。 */
  maxPending?: number
  /** 未确认 / 永久拒绝 / 溢出淘汰的诊断出口（warn 语义由调用方决定）。 */
  onError?: (error: unknown) => void
}

export interface UnreadAckOutbox {
  /** 上行一次：先入队（未确认 = 待发），2xx 后出队；同步返回、绝不抛。 */
  post(sourceId: string, method: UnreadAckMethod, url: string, payload: Record<string, unknown>): void
  /** 通道恢复钩子：FIFO 重放待发表；单飞（在途时返回同一 promise，绝不 reject）。 */
  replay(): Promise<number>
  size(): number
  pending(): readonly UnreadAckRequest[]
}

/**
 * 有界待发 ack 队列（失败重放）。重放幂等安全：`POST /read` 与 `/read-all` 两侧都是逐条
 * max 合并（同值重复写返回 changed:false，会话缺失也只回 200 + stored:false），上界由
 * 服务端 host 时钟 clamp，因此重发同一或更落后的水位在任何顺序/次数下都不改变结果。
 *
 * 出队用**对象身份**核对（在途时同键可能已被更高水位替换，删除会丢新值）；入队先于发送。
 */
export function createUnreadAckOutbox(options: UnreadAckOutboxOptions): UnreadAckOutbox {
  const requested = options.maxPending
  const maxPending = requested === undefined || !Number.isSafeInteger(requested)
    ? UNREAD_PENDING_MAX
    : Math.max(0, requested)
  /** 有界内核：Map 迭代序 = 入队序，同键覆盖移到队尾，FIFO 淘汰丢最久没更新的键并报诊断。 */
  const entries = createBoundedMap<UnreadAckRequest>({
    limit: maxPending,
    replace: (previous, next) => next.watermark > previous.watermark,
    onEvict: key => report(new Error('unread ack pending queue overflow (max ' + String(maxPending) + '); dropped ' + key)),
  })
  let replaying: Promise<number> | null = null

  /** 诊断回调不得反过来打断队列：吞掉回调自身的异常。 */
  const report = (error: unknown): void => {
    try {
      options.onError?.(error)
    } catch {
    }
  }

  const watermarkOf = (method: UnreadAckMethod, payload: Readonly<Record<string, unknown>>): number => {
    const value = method === 'read' ? payload.readThrough : payload.through
    return isWatermark(value) ? value : 0
  }

  const keyOf = (
    sourceId: string,
    method: UnreadAckMethod,
    payload: Readonly<Record<string, unknown>>,
  ): string => {
    const sessionId = method === 'read' && typeof payload.sessionId === 'string' ? payload.sessionId : ''
    return sourceId + '\u0000' + method + '\u0000' + sessionId
  }

  const enqueue = (request: UnreadAckRequest): void => {
    // 同键只保留更高水位（内核 replace 裁决）：max 服务端下旧值被支配，合并是安全的。
    entries.set(request.key, request)
  }

  const settle = (
    request: UnreadAckRequest,
    outcome: UnreadAckOutcome,
    status: number | null,
    error?: unknown,
  ): void => {
    if (entries.get(request.key) === request) {
      if (outcome === 'ok' || outcome === 'permanent') entries.delete(request.key)
    }
    if (outcome === 'ok') return
    if (outcome === 'permanent') {
      report(error ?? new Error('read ack rejected with HTTP ' + String(status)))
      return
    }
    // retryable：条目已在队列里（入队先于发送），只报诊断，等下一次恢复信号。
    report(error ?? new Error('read ack answered ' + String(status)))
  }

  return {
    post(sourceId, method, url, payload) {
      const request: UnreadAckRequest = {
        sourceId,
        method,
        url,
        payload: { ...payload },
        key: keyOf(sourceId, method, payload),
        watermark: watermarkOf(method, payload),
      }
      enqueue(request)
      void sendUnreadRequest(options.fetchImpl, url, request.payload).then(
        result => settle(request, result.outcome, result.status, result.error),
        // sendUnreadRequest 自身 never-throw；这一路只是极防御（诊断回调等）。
        error => settle(request, 'retryable', null, error),
      )
    },
    replay() {
      if (replaying !== null) return replaying
      if (entries.size() === 0) return Promise.resolve(0)
      const run = (async (): Promise<number> => {
        let delivered = 0
        // 快照迭代：重放期间新入队的条目留给下一次恢复信号，绝不为清空而自旋。
        for (const request of [...entries.values()]) {
          if (entries.get(request.key) !== request) continue
          const result = await sendUnreadRequest(options.fetchImpl, request.url, { ...request.payload })
          if (result.outcome === 'ok') delivered += 1
          settle(request, result.outcome, result.status, result.error)
        }
        return delivered
      })()
      const tracked = run.then(
        delivered => { replaying = null; return delivered },
        error => { replaying = null; report(error); return 0 },
      )
      replaying = tracked
      return tracked
    },
    size() { return entries.size() },
    pending() {
      return [...entries.values()].map(entry => ({ ...entry, payload: { ...entry.payload } }))
    },
  }
}
