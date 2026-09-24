/**
 * complete 通知记忆的单一账本内核（D1 身份轨，v4 起唯一持久表）。
 *
 * 完成通知的**触发器是运行身份**（notification-identity.ts 的唯一解析器）：
 *   - 身份轨（notifiedRuns）：每 (source, session) 最后一次已通知的 SessionRunId
 *     ——同一 run 重复观察不重发，新一轮运行铸新 id；裁决在
 *     notification-projection.ts，本模块只存。迁移哨兵
 *     （LEGACY_NOTIFIED_RUN_ID）同样只存在这张表里；
 *   - 壳边沿入口（武装轨）：每 (source, session) 的「已发 complete 直到重新 running」
 *     武装位——规则本体在 notification-edges.ts 的 dedupeCompleteEdges。
 * 无 host 身份的运行时通知收到原生结算后，另留易失的「待归属」标记：
 * 下一份可信 host 完成把它的运行身份认领进身份轨。单纯 armed 仅代表边沿已入队，
 * 绝不能据此宣称原生已经投递。
 * 三轨的键空间、读取、写入与整体清除（forget / prune）只有一处；App 只
 * 持有一个引用，per-source 剪枝不会漏表。本模块不重写任何一轨的裁定规则。
 */
import type { SessionRunId } from '@dsh-chamber/dsh-stream-state'

/** 身份 spine：source → session → 最后一次已通知的 SessionRunId。 */
export type NotifiedRunTable = Record<string, Record<string, SessionRunId>>

/** 身份轨、壳边沿武装位与已结算待归属位的合并账本（App 单例持有）。 */
export interface CompleteLedger {
  /** 身份轨：落盘读出的表（内部对象，调用方只读）。 */
  notifiedRunTable(): NotifiedRunTable
  /** 身份轨：该会话最后一次已通知的运行身份。 */
  notifiedRun(sourceId: string, sessionId: string): SessionRunId | undefined
  /** 身份轨：写入一笔（重发同一 run = 同一 id，天然幂等）。 */
  setNotifiedRun(sourceId: string, sessionId: string, runId: SessionRunId): void
  /** 武装轨：该来源当前武装集合（交给 dedupeCompleteEdges 的 prev）。 */
  armed(sourceId: string): ReadonlySet<string>
  /** 武装轨：写回集合（空集 = 删除该来源的表项）。 */
  setArmed(sourceId: string, sessions: ReadonlySet<string>): void
  /** 无 host 身份的运行时完成已获原生结算；值 = 该边沿已覆盖到的 host updatedAt
   *  锚点（undefined = 边沿没有 host 时间）。命中只允许 adopt 不比锚点新的 facts 完成。 */
  runtimeSettled(sourceId: string): ReadonlyMap<string, number | undefined>
  markRuntimeSettled(sourceId: string, sessionId: string, hostObservedAt?: number): void
  /**
   * A run-start observation: returns true only when it is provably NEWER than any
   * settled edge, and drops that edge. A LATE facts/runtime snapshot can still report
   * running=true for the run whose completion already got its native receipt; treating
   * it as a new run cleared the marker and fenced the pending entry, re-enqueueing the
   * same completion (double banner). Ordering uses the host `updatedAt` on both sides.
   */
  /** 来源退役：三轨同拍删除（同 id 重加 = 新来源代，不得继承上一代判定）。 */
  forget(sourceId: string): void
  /** 通道撤回只清**易失**的武装轨（durable 身份轨不随撤回删除）。 */
  forgetArmed(sourceId: string): void
  /** 按现存来源集合剪枝；返回是否有变化（调用方据此决定是否重建引用）。 */
  prune(liveIds: ReadonlySet<string>): boolean
}

const EMPTY_ARMED: ReadonlySet<string> = new Set()
const EMPTY_SETTLED: ReadonlyMap<string, number | undefined> = new Map()

/**
 * @param initialNotifiedRuns - 持久化的身份表（unread v4 payload.notifiedRuns）；
 *   浅拷贝后写时复制。
 */
export function createCompleteLedger(initialNotifiedRuns: NotifiedRunTable = {}): CompleteLedger {
  let notifiedRuns: NotifiedRunTable = { ...initialNotifiedRuns }
  let armed: Record<string, Set<string>> = {}
  let runtimeSettled: Record<string, Map<string, number | undefined>> = {}
  const clearRuntimeSettled = (sourceId: string, sessionId: string): void => {
    const sessions = runtimeSettled[sourceId]
    if (sessions === undefined || !sessions.has(sessionId)) return
    const nextSessions = new Map(sessions)
    nextSessions.delete(sessionId)
    const next = { ...runtimeSettled }
    if (nextSessions.size === 0) delete next[sourceId]
    else next[sourceId] = nextSessions
    runtimeSettled = next
  }
  return {
    notifiedRunTable() { return notifiedRuns },
    notifiedRun(sourceId, sessionId) { return notifiedRuns[sourceId]?.[sessionId] },
    setNotifiedRun(sourceId, sessionId, runId) {
      const sourceTable = notifiedRuns[sourceId] ?? {}
      if (sourceTable[sessionId] !== runId) {
        notifiedRuns = { ...notifiedRuns, [sourceId]: { ...sourceTable, [sessionId]: runId } }
      }
      clearRuntimeSettled(sourceId, sessionId)
    },
    armed(sourceId) { return armed[sourceId] ?? EMPTY_ARMED },
    setArmed(sourceId, sessions) {
      if (sessions.size === 0) {
        if (armed[sourceId] === undefined) return
        const next = { ...armed }
        delete next[sourceId]
        armed = next
        return
      }
      armed = { ...armed, [sourceId]: new Set(sessions) }
    },
    runtimeSettled(sourceId) { return runtimeSettled[sourceId] ?? EMPTY_SETTLED },
    markRuntimeSettled(sourceId, sessionId, hostObservedAt) {
      const sessions = runtimeSettled[sourceId] ?? EMPTY_SETTLED
      const next = new Map(sessions)
      next.set(sessionId, hostObservedAt)
      runtimeSettled = { ...runtimeSettled, [sourceId]: next }
    },
    forgetArmed(sourceId) {
      if (armed[sourceId] === undefined) return
      const next = { ...armed }
      delete next[sourceId]
      armed = next
    },
    forget(sourceId) {
      if (armed[sourceId] === undefined && runtimeSettled[sourceId] === undefined
          && notifiedRuns[sourceId] === undefined) return
      const nextRuns = { ...notifiedRuns }
      delete nextRuns[sourceId]
      notifiedRuns = nextRuns
      const nextArmed = { ...armed }
      delete nextArmed[sourceId]
      armed = nextArmed
      const nextRuntimeSettled = { ...runtimeSettled }
      delete nextRuntimeSettled[sourceId]
      runtimeSettled = nextRuntimeSettled
    },
    prune(liveIds) {
      let changed = false
      for (const sourceId of Object.keys(notifiedRuns)) {
        if (liveIds.has(sourceId)) continue
        const next = { ...notifiedRuns }
        delete next[sourceId]
        notifiedRuns = next
        changed = true
      }
      for (const sourceId of Object.keys(armed)) {
        if (liveIds.has(sourceId)) continue
        const next = { ...armed }
        delete next[sourceId]
        armed = next
        changed = true
      }
      for (const sourceId of Object.keys(runtimeSettled)) {
        if (liveIds.has(sourceId)) continue
        const next = { ...runtimeSettled }
        delete next[sourceId]
        runtimeSettled = next
        changed = true
      }
      return changed
    },
  }
}
