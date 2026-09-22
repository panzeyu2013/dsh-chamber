/**
 * complete 通知记忆的单一账本内核。
 *
 * 两个入口各有**不同规则**，因此共用同一容器与键空间，而不是共用一套判定：
 *   - facts 入口（watcher 水位轨）：每 (source, session, kind) 的已通知水位，单调只升，
 *     严格更高才允许再通知——规则本体在 watermark.ts（shouldNotifyWatermark /
 *     nextNotifiedWatermark），调用点裁决，本模块只存；
 *   - 壳边沿入口（武装轨）：每 (source, session) 的「已发 complete 直到重新 running」
 *     武装位——规则本体在 notification-edges.ts 的 dedupeCompleteEdges。
 * 两轨的键空间、读取、写入与整体清除（forget / prune）只有一处；App 只
 * 持有一个引用，per-source 剪枝不会漏表。本模块不重写任何一轨的裁定规则。
 */
import type { UnreadKind } from './unread-store.ts'

/** v2 未读 payload 的 notified 段：source → session → kind → 已通知水位。 */
export type NotifiedWatermarkTable = Record<string, Record<string, Partial<Record<UnreadKind, number>>>>

/** 通知水位与壳边沿武装位的合并账本（App 单例持有）。 */
export interface CompleteLedger {
  /** 水位轨：v2 落盘读出的表（内部对象，调用方只读）。 */
  notifiedTable(): NotifiedWatermarkTable
  /** 水位轨：单会话单类别已通知水位。 */
  notifiedWatermark(sourceId: string, sessionId: string, kind: UnreadKind): number | undefined
  /** 水位轨：写入一笔（单调性由调用点的纯函数裁决）。 */
  setNotifiedWatermark(sourceId: string, sessionId: string, kind: UnreadKind, watermark: number): void
  /** 武装轨：该来源当前武装集合（交给 dedupeCompleteEdges 的 prev）。 */
  armed(sourceId: string): ReadonlySet<string>
  /** 武装轨：写回集合（空集 = 删除该来源的表项）。 */
  setArmed(sourceId: string, sessions: ReadonlySet<string>): void
  /** 来源退役：两轨同拍删除（同 id 重加 = 新来源代，不得继承上一代判定）。 */
  forget(sourceId: string): void
  /** 通道撤回只清**易失**的武装轨（durable 水位轨不随撤回删除）。 */
  forgetArmed(sourceId: string): void
  /** 按现存来源集合剪枝；返回是否有变化（调用方据此决定是否重建引用）。 */
  prune(liveIds: ReadonlySet<string>): boolean
}

const EMPTY_ARMED: ReadonlySet<string> = new Set()

/**
 * @param initialNotified - 持久化的水位表（unread v2 payload.notified）；浅拷贝后写时复制。
 */
export function createCompleteLedger(initialNotified: NotifiedWatermarkTable = {}): CompleteLedger {
  let notified: NotifiedWatermarkTable = { ...initialNotified }
  let armed: Record<string, Set<string>> = {}
  return {
    notifiedTable() { return notified },
    notifiedWatermark(sourceId, sessionId, kind) {
      return notified[sourceId]?.[sessionId]?.[kind]
    },
    setNotifiedWatermark(sourceId, sessionId, kind, watermark) {
      const sourceTable = notified[sourceId] ?? {}
      const row = sourceTable[sessionId] ?? {}
      notified = { ...notified, [sourceId]: { ...sourceTable, [sessionId]: { ...row, [kind]: watermark } } }
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
    forgetArmed(sourceId) {
      if (armed[sourceId] === undefined) return
      const next = { ...armed }
      delete next[sourceId]
      armed = next
    },
    forget(sourceId) {
      if (notified[sourceId] === undefined && armed[sourceId] === undefined) return
      const nextNotified = { ...notified }
      delete nextNotified[sourceId]
      notified = nextNotified
      const nextArmed = { ...armed }
      delete nextArmed[sourceId]
      armed = nextArmed
    },
    prune(liveIds) {
      let changed = false
      for (const sourceId of Object.keys(notified)) {
        if (liveIds.has(sourceId)) continue
        const next = { ...notified }
        delete next[sourceId]
        notified = next
        changed = true
      }
      for (const sourceId of Object.keys(armed)) {
        if (liveIds.has(sourceId)) continue
        const next = { ...armed }
        delete next[sourceId]
        armed = next
        changed = true
      }
      return changed
    },
  }
}
