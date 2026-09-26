/**
 * 未读 v4 落盘存储。
 *
 * v4 落盘载荷（身份轨 + goal 结算表）：
 *   - 键：dsh-chamber.unread.v4 = { v:4, read, edge, notifiedRuns, pending, outcomes }；
 *   - read/sourceId/sessionId → host 域读水位（只升不降，max 合并）；
 *   - edge/sourceId/sessionId → true（边沿轨回退账本；重启后立即可渲染未读，不等网络）；
 *   - notifiedRuns/sourceId/sessionId → 最后一次已通知的 SessionRunId（v2 一次性迁移
 *     对旧 notified/事件序表写哨兵 LEGACY_NOTIFIED_RUN_ID，认领后即被真实身份覆盖）；
 *   - pending/sourceId/sessionId → 目标活跃期间被压制的完成结算位（complete-ledger v5）；
 *   - outcomes/sourceId/goalId → 目标/中性标题的一次性身份水位。
 * 载荷**不得出现 title/cwd/消息内容**（隐私条）——键白名单锁在
 * test/session-state/unread-store.test.ts 里钉住。
 *
 * 存储访问器 lazy + never-throw（照 view-prefs.ts 的形状）：私有模式/配额
 * 失败只降级为内存态，绝不影响本地未读。
 *
 * 单例纪律：N 个 ctx 共享一个 localStorage，逐调用点
 * setItem 会 last-writer-wins 丢标记；App 侧只经本模块的 merge/prune/save
 * 三个可组合步骤写盘（App 持有内存权威，v4 是缓存）。
 *
 * 迁移只保留 v2（main 已发布过的载荷）→ v4 的一次性读取；v1/v3 兼容分支已删除。
 *
 * `POST /read` / `/read-all` 的 ack 失败（网络错误 /
 * 5xx）进**有界内存待发表**（UNREAD_PENDING_MAX），facts 源每收到一帧服务端
 * 数据（probe 快照 / SSE sync·增量·心跳）就重放一次；幂等依据（服务端逐条
 * max 合并）写在 createUnreadAckOutbox 头注里。本机内存/落盘仍是权威，
 * 待发表只影响"服务端何时知道"，绝不影响未读判定。
 */

import { createBoundedMap } from './bounded-ledger.ts'
import { isWatermark, maxWatermarkValue } from './watermark.ts'
import { LEGACY_NOTIFIED_RUN_ID, isSessionRunId } from './notification-identity.ts'
import { isPlainRecord } from './plain-record.ts'
import type { GoalOutcomeTable, PendingCompletion, PendingCompletionTable } from './complete-ledger.ts'

/** v4 落盘键（唯一被持续写入的未读键；只有 read / edge / 通知运行身份 / goal 结算表）。 */
export const UNREAD_V4_KEY = 'dsh-chamber.unread.v4'
/** v2 键：唯一的历史读取键，一次性迁移到 v4 后删除（不再保留旧版本兼容分支）。 */
export const UNREAD_V2_KEY = 'dsh-chamber.unread.v2'

/** client-install id 键（首启生成一次；重装 = 新 id，旧标记由服务端 TTL 清理）。 */
export const CLIENT_INSTALL_ID_KEY = 'dsh-chamber.client-install-id.v1'
/** 每来源读标记上限（按水位 LRU）。 */
export const UNREAD_MAX_SESSIONS_PER_SOURCE = 500
/** client-install id 语法（与 control-plane SESSION_STATE_CLIENT_ID_PATTERN 同形）。 */
export const CLIENT_INSTALL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

export interface UnreadV4Payload {
  v: 4
  /** sourceId → sessionId → host 域读水位。 */
  read: Record<string, Record<string, number>>
  /** sourceId → sessionId → true（边沿轨回退账本 / 上次派生未读投影）。 */
  edge: Record<string, Record<string, boolean>>
  /** 身份 spine：sourceId → sessionId → 最后一次已通知的 SessionRunId
   *  （或 v2 迁移哨兵 LEGACY_NOTIFIED_RUN_ID，认领后即被真实身份覆盖）。 */
  notifiedRuns: Record<string, Record<string, string>>
  /** sourceId → sessionId → 被压制的完成结算位（complete-ledger v5 的 durable 状态）。 */
  pending: PendingCompletionTable
  /** sourceId → goalId → 目标/中性标题一次性身份水位。 */
  outcomes: GoalOutcomeTable
}

/** Storage 的结构子集（浏览器 localStorage 或测试假实现）。 */
export interface UnreadStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function emptyUnreadPayload(): UnreadV4Payload {
  return { v: 4, read: {}, edge: {}, notifiedRuns: {}, pending: {}, outcomes: {} }
}

/** pending 表（缺字段 = 空表；sanitize 负责把坏项剥掉并 loud）。 */
export function unreadPendingTable(payload: UnreadV4Payload): PendingCompletionTable {
  return payload.pending ?? {}
}

/** outcomes 表（缺字段 = 空表）。 */
export function unreadOutcomeTable(payload: UnreadV4Payload): GoalOutcomeTable {
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

function warn(message: string, error?: unknown): void {
  console.warn('[unread] ' + message, error ?? '')
}

/** 宽松清洗：只留下合法键值，剥掉坏项（不整包丢弃）。 */
export function sanitizeUnreadPayload(value: unknown): UnreadV4Payload {
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
  const notifiedRuns = isPlainRecord(value.notifiedRuns) ? value.notifiedRuns : {}
  for (const [sourceId, sessions] of Object.entries(notifiedRuns)) {
    if (!isPlainRecord(sessions)) continue
    const table: Record<string, string> = {}
    for (const [sessionId, runId] of Object.entries(sessions)) {
      // Parse/round-trip validation at the restore boundary: a corrupt identity
      // (`host:%`, truncated chamber parts) must never reach the projection.
      if (isSessionRunId(runId)) table[sessionId] = runId
    }
    if (Object.keys(table).length > 0) payload.notifiedRuns[sourceId] = table
  }
  sanitizePendingTables(value, payload)
  return payload
}

/** pending / outcomes（v5 §3.1 增量）：缺字段 = 空 + loud；存在则逐字段校验。 */
function sanitizePendingTables(value: Record<string, unknown>, payload: UnreadV4Payload): void {
  if (value.pending === undefined) {
    warn('unread payload has no pending table; treating it as empty')
  } else if (!isPlainRecord(value.pending)) {
    warn('unread payload.pending is not a table; treating it as empty')
  } else {
    for (const [sourceId, sessions] of Object.entries(value.pending)) {
      if (!isPlainRecord(sessions)) {
        warn('unread payload.pending[' + sourceId + '] is not a table; dropped')
        continue
      }
      const table: Record<string, PendingCompletion> = {}
      for (const [sessionId, entry] of Object.entries(sessions)) {
        if (!isPlainRecord(entry)) {
          warn('unread payload.pending entry ' + sourceId + '/' + sessionId + ' is not an object; dropped')
          continue
        }
        if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) {
          warn('unread payload.pending entry ' + sourceId + '/' + sessionId + ' has no finite at; dropped')
          continue
        }
        const sanitized: PendingCompletion = { at: entry.at }
        if (isWatermark(entry.watermark)) sanitized.watermark = entry.watermark
        else if (entry.watermark !== undefined) warn('unread payload.pending entry ' + sourceId + '/' + sessionId + ' has an invalid watermark; field dropped')
        if (typeof entry.goalId === 'string' && entry.goalId.length > 0) sanitized.goalId = entry.goalId
        else if (entry.goalId !== undefined) warn('unread payload.pending entry ' + sourceId + '/' + sessionId + ' has an invalid goalId; field dropped')
        // G4 延迟来源（评审 F5 阻断项 1）：deferred 是 pending 的 durable 身份，丢了它
        // 同页 reload 后 busy 延迟的完成既不会中性释放、又可能被 #3 静默 drop——严格按
        // 合法值拷贝；非法值只丢该字段，绝不整条丢弃（at 才是条目的成立条件）。
        if (entry.deferred === 'subagent-busy') sanitized.deferred = 'subagent-busy'
        else if (entry.deferred !== undefined) warn('unread payload.pending entry ' + sourceId + '/' + sessionId + ' has an invalid deferred; field dropped')
        table[sessionId] = sanitized
      }
      if (Object.keys(table).length > 0) payload.pending[sourceId] = table
    }
  }
  if (value.outcomes === undefined) {
    warn('unread payload has no outcomes table; treating it as empty')
  } else if (!isPlainRecord(value.outcomes)) {
    warn('unread payload.outcomes is not a table; treating it as empty')
  } else {
    for (const [sourceId, goals] of Object.entries(value.outcomes)) {
      if (!isPlainRecord(goals)) {
        warn('unread payload.outcomes[' + sourceId + '] is not a table; dropped')
        continue
      }
      const table: Record<string, number> = {}
      for (const [goalId, watermark] of Object.entries(goals)) {
        if (isWatermark(watermark)) table[goalId] = watermark
        else warn('unread payload.outcomes entry ' + sourceId + '/' + goalId + ' is not a watermark; dropped')
      }
      if (Object.keys(table).length > 0) payload.outcomes[sourceId] = table
    }
  }
}

/**
 * v4 migration: every (source, session) the pre-v4 tables knew as notified gets
 * the identity sentinel. The projection then adopts the live run id WITHOUT
 * notifying, so no upgrade ever re-shows an already-delivered completion.
 */
function legacyNotifiedSessions(value: Record<string, unknown>): Record<string, Record<string, string>> {
  const runs: Record<string, Record<string, string>> = {}
  const mark = (sourceId: string, sessionId: string): void => {
    runs[sourceId] = { ...(runs[sourceId] ?? {}), [sessionId]: LEGACY_NOTIFIED_RUN_ID }
  }
  const notified = isPlainRecord(value.notified) ? value.notified : {}
  for (const [sourceId, sessions] of Object.entries(notified)) {
    if (!isPlainRecord(sessions)) continue
    for (const [sessionId, kinds] of Object.entries(sessions)) {
      if (isPlainRecord(kinds) && isWatermark(kinds.complete)) mark(sourceId, sessionId)
    }
  }
  const seqs = isPlainRecord(value.notifiedCompletionSeq) ? value.notifiedCompletionSeq : {}
  for (const [sourceId, sessions] of Object.entries(seqs)) {
    if (!isPlainRecord(sessions)) continue
    for (const [sessionId, seq] of Object.entries(sessions)) {
      if (isWatermark(seq)) mark(sourceId, sessionId)
    }
  }
  return runs
}

/** One-shot v2 → v4 conversion (identity sentinel + pending/outcomes tables). */
function migrateLegacyPayload(value: Record<string, unknown>): UnreadV4Payload {
  const payload = sanitizeUnreadPayload(value)
  for (const [sourceId, sessions] of Object.entries(legacyNotifiedSessions(value))) {
    payload.notifiedRuns[sourceId] = { ...(payload.notifiedRuns[sourceId] ?? {}), ...sessions }
  }
  return payload
}

/** 剪除空表（序列化前调用；保证载荷最小、无噪声键）。 */
export function pruneEmptyUnreadTables(payload: UnreadV4Payload): UnreadV4Payload {
  const next = emptyUnreadPayload()
  for (const [sourceId, table] of Object.entries(payload.read)) {
    if (Object.keys(table).length > 0) next.read[sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(payload.edge)) {
    if (Object.keys(table).length > 0) next.edge[sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(payload.notifiedRuns)) {
    if (Object.keys(table).length > 0) next.notifiedRuns[sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(unreadPendingTable(payload))) {
    if (Object.keys(table).length > 0) next.pending![sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(unreadOutcomeTable(payload))) {
    if (Object.keys(table).length > 0) next.outcomes![sourceId] = table
  }
  return next
}

/**
 * 有界化（按水位 LRU）：每来源 read 保留水位最高的 maxPerSource 条；edge/notifiedRuns
 * 与 read 同界（先保留 read 里出现的会话，再按插入序补足），pending 同界，
 * outcomes 按水位 LRU。返回新对象（调用方负责写盘）。
 */
export function pruneUnreadPayload(payload: UnreadV4Payload, maxPerSource = UNREAD_MAX_SESSIONS_PER_SOURCE): UnreadV4Payload {
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
  for (const [sourceId, table] of Object.entries(payload.notifiedRuns)) {
    const read = next.read[sourceId] ?? {}
    const keys = Object.keys(table)
    const kept: Record<string, string> = {}
    for (const sessionId of keys) {
      if (Object.prototype.hasOwnProperty.call(read, sessionId)) kept[sessionId] = table[sessionId]
      if (Object.keys(kept).length >= maxPerSource) break
    }
    for (const sessionId of keys) {
      if (Object.keys(kept).length >= maxPerSource) break
      if (kept[sessionId] !== undefined) continue
      kept[sessionId] = table[sessionId]
    }
    if (Object.keys(kept).length > 0) next.notifiedRuns[sourceId] = kept
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
 * 载入未读账本：
 *   1. v4 可解析且 v===4 ⇒ 逐字段清洗（坏字段就地剥掉）；
 *   2. v4 缺失/损坏且 v2（main 已发布过的唯一历史载荷）存在 ⇒ 一次性迁移：
 *      read/edge/pending/outcomes 携带，旧 notified / notifiedCompletionSeq 表折成
 *      身份哨兵（认领后不重发）；**先写 v4 再删 v2**（写失败保留旧键，下次再试）；
 *   3. 都没有 ⇒ 空载荷（本机内存仍是权威，App 由事实重算）。
 */
export function loadUnread(storage: UnreadStorageLike | undefined): UnreadV4Payload {
  if (storage === undefined) return emptyUnreadPayload()
  const version = (key: string, expected: number): Record<string, unknown> | null => {
    try {
      const raw = storage.getItem(key)
      if (raw === null || raw === '') return null
      const value: unknown = JSON.parse(raw)
      return isPlainRecord(value) && value.v === expected ? value : null
    } catch { return null }
  }
  const current = version(UNREAD_V4_KEY, 4)
  if (current !== null) return sanitizeUnreadPayload(current)
  const previous = version(UNREAD_V2_KEY, 2)
  if (previous !== null) {
    const migrated = migrateLegacyPayload(previous)
    try {
      storage.setItem(UNREAD_V4_KEY, JSON.stringify(pruneUnreadPayload(migrated)))
      storage.removeItem(UNREAD_V2_KEY)
    } catch (error) {
      warn('v2 → v4 migration failed; keeping the previous journal for a later attempt', error)
    }
    return migrated
  }
  return emptyUnreadPayload()
}

/** 写盘（剪空表 + 有界化）；返回是否成功。never-throw。 */
export function saveUnread(storage: UnreadStorageLike | undefined, payload: UnreadV4Payload): boolean {
  if (storage === undefined) return false
  try {
    storage.setItem(UNREAD_V4_KEY, JSON.stringify(pruneUnreadPayload(pruneEmptyUnreadTables(payload))))
    return true
  } catch (error) {
    warn('cannot persist unread v4', error)
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

/**
 * 每会话 host 域内容水位 = max(updatedAt, completedAt)，completedAt **只在非 observer 域参与**。
 *
 * 唯一实现：observer 域的降级戳是客户端墙钟，只武装未读、绝不推进 durable 读水位。域盲的 max
 * 会让一次 observer 戳把源级地板抬到客户端「现在」，之后 host 时间 ≤ 它的真完成被判已读、
 * 点永久不出（读水位只升不降且落盘）。逐行 `viewingReadWatermark`（unread-derivation）与源级
 * `maxWatermark` 共用本函数；非法/缺失值按 watermark 契约回落 0，绝不臆造。
 */
export function hostWatermark(
  updatedAt: number | undefined,
  completedAt: number | null | undefined,
  completedAtDomain: 'host' | 'observer' | null | undefined,
): number {
  const hostCompletion = completedAtDomain === 'observer' ? null : completedAt
  return maxWatermarkValue(updatedAt, hostCompletion)
}

/** 源级内容水位 = 全表逐行 host 域水位的最大（源级地板 / read-all 的 through）。逐行规则见 hostWatermark。 */
export function maxWatermark(
  rows: Readonly<Record<string, { updatedAt?: number; completedAt?: number | null; completedAtDomain?: 'host' | 'observer' | null }>>,
): number {
  let max = 0
  for (const row of Object.values(rows)) {
    const watermark = hostWatermark(row.updatedAt, row.completedAt, row.completedAtDomain)
    if (watermark > max) max = watermark
  }
  return max
}

/**
 * 源级读水位地板镜像：把 through 抬到 rows 里每个会话（单调、只升不降），返回新表。
 * 「全部已读」动作与**首见基线播种**共用这一份实现——两者是同一条语义（把源级上界
 * 认作已读），分开写就会出现两套地板规则。
 */
export function seedReadFloor(
  table: Readonly<Record<string, number>>,
  rows: Readonly<Record<string, unknown>>,
  through: number,
  keepUnread: Readonly<Record<string, boolean>> = {},
): Record<string, number> {
  const next: Record<string, number> = { ...table }
  for (const sessionId of Object.keys(rows)) {
    // 已武装的完成点是**未读账本**的事实，地板不得把它吸收掉（重载后恢复的点必须留）。
    if (keepUnread[sessionId] === true) continue
    // through 不可用（0/NaN/undefined）时 advanceReadMark 返回 undefined：该行保持原值或缺席，
    // 绝不写入坏值（调用方另有 through > 0 守卫）。
    const mark = advanceReadMark(next[sessionId], through)
    if (mark !== undefined) next[sessionId] = mark
  }
  return next
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
