/**
 * Notification decision ledger：记录 renderer 组装的每一次通知决定。
 *   - `sent`：主进程回 `shown: true`；`suppressed`：`shown: false`（去重/焦点豁免/系统权限…），
 *     带 error 原文；`skipped`：没有通知桥或组装/调用抛错（未发生任何投递）。
 * 有界环（默认 200），只存 id/种类/水位/决定与错误串，不存正文；以函数视图挂全局（活视图）。
 */
import { createBoundedList } from './bounded-ledger.ts'

export type NotificationDecision = 'sent' | 'suppressed' | 'skipped'

export interface NotificationLedgerEntry {
  at: number
  sourceId: string
  sessionId: string
  kind: string
  watermark?: number
  requireHidden: boolean
  decision: NotificationDecision
  error?: string
}

export interface NotificationLedgerCounts {
  sent: number
  suppressed: number
  skipped: number
}

export function createNotificationLedger(options: { limit?: number } = {}) {
  // 有界环走内核：尾部入队、超限头部淘汰。
  const ring = createBoundedList<NotificationLedgerEntry>(options.limit ?? 200)
  const counts: NotificationLedgerCounts = { sent: 0, suppressed: 0, skipped: 0 }
  return {
    record(entry: NotificationLedgerEntry): void {
      ring.push(entry)
      counts[entry.decision] += 1
    },
    entries(): readonly NotificationLedgerEntry[] {
      return ring.toArray()
    },
    counts(): NotificationLedgerCounts {
      return { ...counts }
    },
    /** 累计决定数（**不受环形上界影响**）：全文件只允许一次 bridge.notify(，这里应恰好多一条账。 */
    total(): number {
      return counts.sent + counts.suppressed + counts.skipped
    },
  }
}

/** 进程级单例（所有壳共享；只读仪表）。 */
export const notificationLedger = createNotificationLedger()

/** 幂等挂全局（函数视图，不产生周期性对象）。 */
export function publishNotificationInstrument(target: unknown = globalThis): void {
  const host = target as { __dshChamberNotifications?: unknown }
  if (host.__dshChamberNotifications !== undefined) return
  host.__dshChamberNotifications = {
    entries: () => notificationLedger.entries(),
    counts: () => notificationLedger.counts(),
    total: () => notificationLedger.total(),
  }
}

/** 徽标回读：renderer **已派发**的计数（与蓝点集合同源；主进程只做透传/去重）。 */
export function publishBadgeCount(count: number, target: unknown = globalThis): void {
  ;(target as { __dshChamberBadgeCount?: number }).__dshChamberBadgeCount = count
  publishNotificationInstrument(target)
}
