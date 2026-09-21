/**
 * Notification decision ledger（仪表 I4，plan §10 与
 * `notes/residual-verifiability-review.md` §5-I4）。
 *
 * WHY：R6/R3 的判据里有**负断言**（"离线完成不补发通知"）——通知路径整体坏掉时负断言
 * 也会通过。同一次运行内的正对照需要「这次实时完成**发了一条**」，而两条断言都必须看到
 * **主进程的诚实结果**（shown / suppressed + 原因），不能只看"我们调用了通知"。
 *
 * 因此本账本记录的是 renderer 组装的**每一次决定**：
 *   - `sent`：主进程回 `shown: true`；
 *   - `suppressed`：主进程回 `shown: false`（去重/焦点豁免/系统权限…），带 error 原文；
 *   - `skipped`：根本没有通知桥，或组装/调用抛错（这时**没有**发生任何投递）。
 *
 * 边界：有界环（默认 200）、只存 id/种类/水位/决定与错误串，不存正文；发布为**函数**的
 * 只读全局（活视图，无周期性对象），供验收仪器/CDP 直接读。
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
  // 有界环走内核（阶段 2 单源化）：尾部入队、超限头部淘汰，语义与旧 splice 版逐字等价。
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
    /**
     * 累计决定数（**不受环形上界影响**）：单组装点锁的读出口——全文件只允许一次
     * bridge.notify( ⇒ 这里应当恰好多一条账，即使更早的条目已被淘汰。
     */
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

/** 徽标回读（I3）：renderer **已派发**的计数（与蓝点集合同源；主进程只做透传/去重）。 */
export function publishBadgeCount(count: number, target: unknown = globalThis): void {
  ;(target as { __dshChamberBadgeCount?: number }).__dshChamberBadgeCount = count
  publishNotificationInstrument(target)
}
