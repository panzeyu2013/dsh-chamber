/**
 * 通知落盘存储（notifiedRuns / pending / outcomes 三表）。
 *
 * 键：dsh-chamber.notifications.v1 = { v:1, notifiedRuns, pending, outcomes }；
 *   - notifiedRuns/sourceId/sessionId → 最后一次已通知的 SessionRunId（旧载荷迁移时
 *     对 v2 的 notified/事件序表写哨兵 LEGACY_NOTIFIED_RUN_ID，认领后即被真实身份覆盖）；
 *   - pending/sourceId/sessionId → 目标活跃期间被压制的完成结算位（complete-ledger v5）；
 *   - outcomes/sourceId/goalId → 目标/中性标题的一次性身份水位。
 * 载荷**不得出现 title/cwd/消息内容**（隐私条）——键白名单锁在
 * test/session-state/notification-store.test.ts 里钉住。
 *
 * 完成未读的旧持久面（read 水位 / edge 账本 / v5 影子 / 读回执待发表 / client-install id）
 * 已整体退役：官方 `uiSession.sessionStatus.completionUnread` 是唯一权威，App 只补一条
 * **内存**修正臂（client-core `completion-arm.ts`）。本模块只为通知 durable 表服务；
 * 一次性迁移从 dsh-chamber.unread.v4 / .v2 取三表并删除旧键（含从未被清理的 v5 影子键）。
 *
 * 存储访问器 lazy + never-throw（照 view-prefs.ts 的形状）：私有模式/配额
 * 失败只降级为内存态，绝不影响通知投递。
 *
 * 单例纪律：N 个 ctx 共享一个 localStorage，逐调用点
 * setItem 会 last-writer-wins 丢身份；App 持有内存权威，本模块只提供
 * load / save / prune 三个可组合步骤。
 */

import { isWatermark } from './watermark.ts'
import { LEGACY_NOTIFIED_RUN_ID, isSessionRunId } from './notification-identity.ts'
import { isPlainRecord } from './plain-record.ts'
import type { GoalOutcomeTable, PendingCompletion, PendingCompletionTable } from './complete-ledger.ts'

/** 通知载荷键（唯一被持续写入的键）。 */
export const NOTIFICATIONS_V1_KEY = 'dsh-chamber.notifications.v1'
/** 旧未读 v4 载荷：一次性迁移的唯一来源（read/edge 丢弃，只取通知三表）。 */
export const LEGACY_UNREAD_V4_KEY = 'dsh-chamber.unread.v4'
/** 旧未读 v2 载荷：历史迁移来源（notified/事件序 → 身份哨兵）。 */
export const LEGACY_UNREAD_V2_KEY = 'dsh-chamber.unread.v2'
/** 旧 v5 影子键：只写不读，迁移/收敛时显式清理（此前从无 removeItem 清它）。 */
export const LEGACY_UNREAD_V5_KEY = 'dsh-chamber.unread.v5'
/** 更老的 v3 / v1 键：v2 之前的历史载荷，随收敛一并清理（不再解析）。 */
export const LEGACY_UNREAD_V3_KEY = 'dsh-chamber.unread.v3'
export const LEGACY_UNREAD_V1_KEY = 'dsh-chamber.unread.v1'
/** 旧读回执的 per-install id：随读回执退役一起清理。 */
export const LEGACY_CLIENT_INSTALL_ID_KEY = 'dsh-chamber.client-install-id.v1'
/** 每来源通知表上限（身份表与 pending 表按插入序保留最近 N 条）。 */
export const NOTIFICATION_MAX_SESSIONS_PER_SOURCE = 500

export interface NotificationPayload {
  v: 1
  /** 身份 spine：sourceId → sessionId → 最后一次已通知的 SessionRunId
   *  （或旧载荷迁移哨兵 LEGACY_NOTIFIED_RUN_ID，认领后即被真实身份覆盖）。 */
  notifiedRuns: Record<string, Record<string, string>>
  /** sourceId → sessionId → 被压制的完成结算位（complete-ledger v5 的 durable 状态）。 */
  pending: PendingCompletionTable
  /** sourceId → goalId → 目标/中性标题一次性身份水位。 */
  outcomes: GoalOutcomeTable
}

/** Storage 的结构子集（浏览器 localStorage 或测试假实现）。 */
export interface NotificationStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function emptyNotificationPayload(): NotificationPayload {
  return { v: 1, notifiedRuns: {}, pending: {}, outcomes: {} }
}

/** pending 表（缺字段 = 空表；sanitize 负责把坏项剥掉并 loud）。 */
export function notificationPendingTable(payload: NotificationPayload): PendingCompletionTable {
  return payload.pending ?? {}
}

/** outcomes 表（缺字段 = 空表）。 */
export function notificationOutcomeTable(payload: NotificationPayload): GoalOutcomeTable {
  return payload.outcomes ?? {}
}

/** 浏览器 localStorage 的安全访问器；不可用时 undefined（降级为纯内存）。 */
export function browserNotificationStorage(): NotificationStorageLike | undefined {
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
  console.warn('[notifications] ' + message, error ?? '')
}

/** 宽松清洗：只留下合法键值，剥掉坏项（不整包丢弃）。read/edge 等旧字段直接忽略。 */
export function sanitizeNotificationPayload(value: unknown): NotificationPayload {
  const payload = emptyNotificationPayload()
  if (!isPlainRecord(value)) return payload
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

/** pending / outcomes：缺字段 = 空 + loud；存在则逐字段校验。 */
function sanitizePendingTables(value: Record<string, unknown>, payload: NotificationPayload): void {
  if (value.pending === undefined) {
    warn('payload has no pending table; treating it as empty')
  } else if (!isPlainRecord(value.pending)) {
    warn('payload.pending is not a table; treating it as empty')
  } else {
    for (const [sourceId, sessions] of Object.entries(value.pending)) {
      if (!isPlainRecord(sessions)) {
        warn('payload.pending[' + sourceId + '] is not a table; dropped')
        continue
      }
      const table: Record<string, PendingCompletion> = {}
      for (const [sessionId, entry] of Object.entries(sessions)) {
        if (!isPlainRecord(entry)) {
          warn('payload.pending entry ' + sourceId + '/' + sessionId + ' is not an object; dropped')
          continue
        }
        if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) {
          warn('payload.pending entry ' + sourceId + '/' + sessionId + ' has no finite at; dropped')
          continue
        }
        const sanitized: PendingCompletion = { at: entry.at }
        if (isWatermark(entry.watermark)) sanitized.watermark = entry.watermark
        else if (entry.watermark !== undefined) warn('payload.pending entry ' + sourceId + '/' + sessionId + ' has an invalid watermark; field dropped')
        if (typeof entry.goalId === 'string' && entry.goalId.length > 0) sanitized.goalId = entry.goalId
        else if (entry.goalId !== undefined) warn('payload.pending entry ' + sourceId + '/' + sessionId + ' has an invalid goalId; field dropped')
        // 身份：turn/end.seq 的数值域与水位同（非负安全整数）；非法只丢字段，绝不整条丢弃。
        if (typeof entry.completionSeq === 'number' && Number.isSafeInteger(entry.completionSeq) && entry.completionSeq >= 0) {
          sanitized.completionSeq = entry.completionSeq
        } else if (entry.completionSeq !== undefined) {
          warn('payload.pending entry ' + sourceId + '/' + sessionId + ' has an invalid completionSeq; field dropped')
        }
        // G4 延迟来源：deferred 是 pending 的 durable 身份，丢了它同页 reload 后 busy 延迟的
        // 完成既不会中性释放、又可能被静默 drop——严格按合法值拷贝。
        if (entry.deferred === 'subagent-busy') sanitized.deferred = 'subagent-busy'
        else if (entry.deferred !== undefined) warn('payload.pending entry ' + sourceId + '/' + sessionId + ' has an invalid deferred; field dropped')
        table[sessionId] = sanitized
      }
      if (Object.keys(table).length > 0) payload.pending[sourceId] = table
    }
  }
  if (value.outcomes === undefined) {
    warn('payload has no outcomes table; treating it as empty')
  } else if (!isPlainRecord(value.outcomes)) {
    warn('payload.outcomes is not a table; treating it as empty')
  } else {
    for (const [sourceId, goals] of Object.entries(value.outcomes)) {
      if (!isPlainRecord(goals)) {
        warn('payload.outcomes[' + sourceId + '] is not a table; dropped')
        continue
      }
      const table: Record<string, number> = {}
      for (const [goalId, watermark] of Object.entries(goals)) {
        if (isWatermark(watermark)) table[goalId] = watermark
        else warn('payload.outcomes entry ' + sourceId + '/' + goalId + ' is not a watermark; dropped')
      }
      if (Object.keys(table).length > 0) payload.outcomes[sourceId] = table
    }
  }
}

/**
 * Legacy migration: every (source, session) the pre-identity tables knew as notified gets
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

/** One-shot v2 → identity conversion (sentinel + pending/outcomes tables). */
function migrateLegacyPayload(value: Record<string, unknown>): NotificationPayload {
  const payload = sanitizeNotificationPayload(value)
  for (const [sourceId, sessions] of Object.entries(legacyNotifiedSessions(value))) {
    payload.notifiedRuns[sourceId] = { ...(payload.notifiedRuns[sourceId] ?? {}), ...sessions }
  }
  return payload
}

/** 剪除空表（序列化前调用；保证载荷最小、无噪声键）。 */
export function pruneEmptyNotificationTables(payload: NotificationPayload): NotificationPayload {
  const next = emptyNotificationPayload()
  for (const [sourceId, table] of Object.entries(payload.notifiedRuns)) {
    if (Object.keys(table).length > 0) next.notifiedRuns[sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(notificationPendingTable(payload))) {
    if (Object.keys(table).length > 0) next.pending![sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(notificationOutcomeTable(payload))) {
    if (Object.keys(table).length > 0) next.outcomes![sourceId] = table
  }
  return next
}

/**
 * 有界化：每来源身份表与 pending 表按插入序保留最近 maxPerSource 条（新增条目总在尾部），
 * outcomes 按水位 LRU。返回新对象（调用方负责写盘）。
 */
export function pruneNotificationPayload(payload: NotificationPayload, maxPerSource = NOTIFICATION_MAX_SESSIONS_PER_SOURCE): NotificationPayload {
  if (maxPerSource <= 0) return emptyNotificationPayload()
  const next = emptyNotificationPayload()
  const tail = <T>(table: Record<string, T>): Record<string, T> | undefined => {
    const keys = Object.keys(table)
    if (keys.length === 0) return undefined
    const kept: Record<string, T> = {}
    for (const key of keys.slice(keys.length > maxPerSource ? keys.length - maxPerSource : 0)) kept[key] = table[key]
    return kept
  }
  for (const [sourceId, table] of Object.entries(payload.notifiedRuns)) {
    const kept = tail(table)
    if (kept !== undefined) next.notifiedRuns[sourceId] = kept
  }
  for (const [sourceId, table] of Object.entries(notificationPendingTable(payload))) {
    const kept = tail(table)
    if (kept !== undefined) next.pending![sourceId] = kept
  }
  // outcomes 以 goalId 为键：每来源按水位 LRU 保留上限条。
  for (const [sourceId, table] of Object.entries(notificationOutcomeTable(payload))) {
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

/**
 * 载入：优先 notifications.v1；缺失时一次性迁移旧 unread.v4 / v2（只取通知三表），
 * 写成功后删除 v4 / v2 / v5 / client-install id；写失败保留旧键等下一轮。never-throw。
 */
export function loadNotifications(storage: NotificationStorageLike | undefined): NotificationPayload {
  if (storage === undefined) return emptyNotificationPayload()
  const version = (key: string, expected: number): Record<string, unknown> | null => {
    try {
      const raw = storage.getItem(key)
      if (raw === null || raw === '') return null
      const value: unknown = JSON.parse(raw)
      return isPlainRecord(value) && value.v === expected ? value : null
    } catch { return null }
  }
  const current = version(NOTIFICATIONS_V1_KEY, 1)
  if (current !== null) {
    // v1 is authoritative: retire every pre-v1 key regardless of whether it ever
    // parsed (a corrupt v4 must not survive forever).
    removeLegacyKeys(storage)
    return sanitizeNotificationPayload(current)
  }
  const legacyV4 = version(LEGACY_UNREAD_V4_KEY, 4)
  const legacyV2 = legacyV4 === null ? version(LEGACY_UNREAD_V2_KEY, 2) : null
  if (legacyV4 !== null || legacyV2 !== null) {
    const migrated = legacyV4 !== null ? sanitizeNotificationPayload(legacyV4) : migrateLegacyPayload(legacyV2!)
    try {
      storage.setItem(NOTIFICATIONS_V1_KEY, JSON.stringify(pruneNotificationPayload(migrated)))
      removeLegacyKeys(storage)
    } catch (error) {
      warn('legacy → notifications.v1 migration failed; keeping the previous journal for a later attempt', error)
    }
    return migrated
  }
  // Nothing to migrate (absent or corrupt): the retired keys still收敛.
  removeLegacyKeys(storage)
  return emptyNotificationPayload()
}

/**
 * Retire every pre-v1 key. Best-effort: a storage that refuses removeItem must
 * not change what we READ (the caller's payload decision is already made), and
 * the next load retries — v1 stays the single authority.
 */
function removeLegacyKeys(storage: NotificationStorageLike): void {
  for (const key of [
    LEGACY_UNREAD_V4_KEY, LEGACY_UNREAD_V3_KEY, LEGACY_UNREAD_V2_KEY, LEGACY_UNREAD_V1_KEY,
    LEGACY_UNREAD_V5_KEY, LEGACY_CLIENT_INSTALL_ID_KEY,
  ]) {
    try { storage.removeItem(key) } catch { /* best effort */ }
  }
}

/** 写盘（剪空表 + 有界化）；返回是否成功。never-throw。 */
export function saveNotifications(storage: NotificationStorageLike | undefined, payload: NotificationPayload): boolean {
  if (storage === undefined) return false
  try {
    storage.setItem(NOTIFICATIONS_V1_KEY, JSON.stringify(pruneNotificationPayload(pruneEmptyNotificationTables(payload))))
    return true
  } catch (error) {
    warn('cannot persist notifications', error)
    return false
  }
}

// ── immediate 落盘合并（热路径：同一 tick 多次 immediate ⇒ 一次全量写盘） ─────

/**
 * immediate 落盘合并器（热路径）：voided / dropped / flushed 这类 durable 结算必须**立即**
 * 落盘（goal-aware v5 §3.5：1s 节流窗口内崩溃重放不得复活已作废的 pending），但一批
 * reconcile 一拍内可产生多次 immediate，每次全量 prune + stringify（208KB 实测约 6.5ms）
 * 会钉住主线程；合并窗口取**微任务**（可注入以测试控时），同一 tick 的 N 次 immediate
 * 收敛成一次落盘，语义顺序由「落盘时读当时最新权威内存」保证（合并只推迟写，不改变
 * 写内容）。flush 是**关键路径**（pagehide / visibilitychange hidden / unmount）：取消待办
 * 并同步落盘一次——不丢、不重复。
 */
export interface NotificationSaveCoalescer {
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
export type NotificationSaveDefer = (run: () => void) => void

/** 创建 immediate 落盘合并器；persist 必须是 never-throw 的落盘出口。 */
export function createNotificationSaveCoalescer(
  persist: () => void,
  defer: NotificationSaveDefer = queueMicrotask,
): NotificationSaveCoalescer {
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
