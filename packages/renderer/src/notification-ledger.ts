/**
 * Notification decision ledger。
 *
 * WHY：判据里有**负断言**（"离线完成不补发通知"）——通知路径整体坏掉时负断言
 * 也会通过。同一次运行内的正对照需要「这次实时完成**发了一条**」，而两条断言都必须看到
 * **主进程的诚实结果**（shown / suppressed + 原因），不能只看"我们调用了通知"。
 *
 * 因此本账本记录的是 renderer 组装的**每一次决定**：
 *   - `sent`：主进程回 `shown: true`；
 *   - `suppressed`：主进程回 `shown: false`（去重/焦点豁免/系统权限…），带 error 原文；
 *   - `skipped`：根本没有通知桥，或组装/调用抛错（这时**没有**发生任何投递）。
 *
 * 边界：有界环（默认 200）、只存 id/种类/水位/决定与错误串，不存正文；发布为**函数**的
 * 只读全局（活视图，无周期性对象），供仪器/CDP 直接读。
 */
import { createBoundedList } from './bounded-ledger.ts'

export type NotificationDecision = 'sent' | 'suppressed' | 'skipped'

/**
 * 投影处置（goal-aware v5 §6.5）：与三值决定**独立**的计数。
 *   - held：候选因 goal active+armed/unknown 进 pending（水位吸收）；
 *   - flushed：pending 结算并发出通知（#2 目标 outcome / #4 中性）；
 *   - voided：running 权威为 running ⇒ pending 作废（INV3）；
 *   - dropped：pending 结清但不通知（#3 / 结算守卫 / 静默结清）；
 *   - deferred：子代理 busy 延迟 complete 候选（G4）。
 */
export type NotificationReconcileOutcome = 'held' | 'flushed' | 'voided' | 'dropped' | 'deferred'

export interface NotificationReconcileCounts {
  held: number
  flushed: number
  voided: number
  dropped: number
  deferred: number
}

export interface NotificationLedgerEntry {
  at: number
  sourceId: string
  sessionId: string
  kind: string
  watermark?: number
  requireHidden: boolean
  decision: NotificationDecision
  error?: string
  /** ¤origin¤ 投影诊断（可选；不参与三值计数）。 */
  origin?: string
  /** pending 存续毫秒数诊断（可选；flush/drop 时由投影回执带出）。 */
  pendingAge?: number
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
  const dispositions: NotificationReconcileCounts = { held: 0, flushed: 0, voided: 0, dropped: 0, deferred: 0 }
  return {
    record(entry: NotificationLedgerEntry): void {
      ring.push(entry)
      counts[entry.decision] += 1
    },
    /**
     * 投影处置的独立计数（goal-aware v5 §6.5）：与三值 entries/counts/total 互不影响
     * ——held/flushed 等是**收敛器状态机**的计数，sent/suppressed/skipped 仍只记主进程
     * 回执。
     */
    countReconcile(outcome: NotificationReconcileOutcome): void {
      dispositions[outcome] += 1
    },
    /** 投影处置计数快照（诊断/实机正对照：held≥1 && sent==0）。 */
    reconcileCounts(): NotificationReconcileCounts {
      return { ...dispositions }
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
    // 投影处置计数（goal-aware）：实机断言 held≥1 && sent==0 的读出口。
    reconcile: () => notificationLedger.reconcileCounts(),
    held: () => notificationLedger.reconcileCounts().held,
  }
}

/** 徽标回读：renderer **已派发**的计数（与蓝点集合同源；主进程只做透传/去重）。 */
export function publishBadgeCount(count: number, target: unknown = globalThis): void {
  ;(target as { __dshChamberBadgeCount?: number }).__dshChamberBadgeCount = count
  publishNotificationInstrument(target)
}
