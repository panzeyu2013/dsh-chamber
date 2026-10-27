/**
 * Notification boot cluster (design 19 §3.1/§3.5): the durable storage boot, the
 * complete ledger owned by the frame, and the native outbox journal.
 *
 * Extracted from App.tsx so the frame keeps only composition; the hook call order and
 * the one-time initialisation semantics are unchanged (useState initialisers run once,
 * completeLedger's factory still evaluates per render and is kept by useRef).
 */
import { useRef, useState } from 'react'
import { browserBootTokenStorage, loadBootToken } from '../boot-token.ts'
import { createCompleteLedger } from '../complete-ledger.ts'
import { createNotificationOutbox } from '../notification-outbox.ts'
import {
  browserNotificationStorage, loadNotifications, notificationOutcomeTable, notificationPendingTable,
  type NotificationStorageLike,
} from '../notification-store.ts'

export function useNotificationBoot() {
  const [notificationsBoot] = useState(() => {
    const storage = browserNotificationStorage()
    // 通知三表首帧载入（旧 unread.v4/v2 一次性迁移并清理旧键，见 notification-store.ts）。
    const payload = loadNotifications(storage)
    // 页代 token（v5 §3.5）：同 tab reload = same（保留 pending/outcomes），新进程/新窗口 =
    // fresh（丢弃 pending 并 loud；notified/outcomes 仍 durable）。
    const boot = loadBootToken(browserBootTokenStorage())
    return { storage, payload, boot }
  })
  const notificationStorageRef = useRef<NotificationStorageLike | undefined>(notificationsBoot.storage)
  // complete 通知账本（设计 19 + goal-aware v5 §3.1 + v4 身份轨）：身份轨 notifiedRuns 与
  // durable 三表（notified 身份哨兵 / pending 压制结算位 / outcomes 标题一次性身份）从 v4 落盘
  // 恢复；armed/settleFence/generation/goalKnown 易失。fresh 丢弃 pending（loud），same 只做
  // 上界卫生。身份面与水位面并列、互不混写。
  const completeLedgerRef = useRef(createCompleteLedger(notificationsBoot.payload.notifiedRuns, {
    pending: notificationPendingTable(notificationsBoot.payload),
    outcomes: notificationOutcomeTable(notificationsBoot.payload),
    boot: notificationsBoot.boot.verdict,
    onDiagnostic: (message, detail) => console.warn('[renderer] complete-ledger: ' + message, detail ?? ''),
  }))
  // native 投递 journal（唯一 native 调用层）：pending 行 durable，跨 reload 继续投递。
  const [notificationOutbox] = useState(() => createNotificationOutbox(notificationsBoot.storage))
  const notificationOutboxRef = useRef(notificationOutbox)
  return {
    notificationsBoot, notificationStorageRef, completeLedgerRef, notificationOutbox, notificationOutboxRef,
  }
}
