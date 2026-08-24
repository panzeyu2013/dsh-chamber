/** 每会话事实（来自 06 §4 运行时事实通道 report.sessions 的行）。 */
export interface SessionFacts {
  running?: boolean
  completed?: boolean
  pending?: 'approval' | 'plan-review' | 'question'
}
export type NotificationKind = 'complete' | 'ask' | 'request'
export interface NotificationEdge { sessionId: string; kind: NotificationKind }

/**
 * 边沿检测：prev 事实 → next 事实 的事件集。
 * - prev 为 undefined（首份上报）：只播种记忆，返回 []（不发事件）。
 * - complete：running true→false 边沿，或 vendor completed 从无到有
 *   （兜底：断连期间完成、从未观察到 running=true 的会话由此补发）。
 *   同一 session 同一 tick 两者同时成立只发一次。
 * - ask：pending 变化到 'question'（含直切：question→approval 等不经
 *   undefined 的切换，vendor 组合选择器会正常产生——每个新值都通知一次）。
 * - request：pending 变化到 'approval' 或 'plan-review'。
 * - 输出顺序：按 next 的插入顺序，同一 session 多事件按 complete/ask/request 顺序。
 *
 * 注意：本函数无跨上报记忆——「同一完成只发一次」由
 * dedupeCompleteEdges（App 层持有 notified 集合）负责：正被查看的会话
 * 完成时 vendor 不武装 completed、先走 running 边沿，用户切走后延迟武装
 * 的 completed 会在此产生第二条 complete 边沿，必须由去重层丢弃。
 */
export function detectNotificationEdges(
  prev: Record<string, SessionFacts> | undefined,
  next: Record<string, SessionFacts>,
): NotificationEdge[] {
  // First report: seed memory only, never emit (sessions already pending /
  // completed at boot must not bombard the user).
  if (prev === undefined) return []

  const edges: NotificationEdge[] = []
  for (const sessionId of Object.keys(next)) {
    const before = prev[sessionId]
    const after = next[sessionId]

    // complete: explicit running true→false, or vendor completed false/absent→true.
    // Missing running is not "false" (only an explicit false closes the edge).
    const runningEdge = before?.running === true && after.running === false
    const completedEdge = before?.completed !== true && after.completed === true
    const complete = runningEdge || completedEdge

    // ask/request: pending VALUE CHANGE to a concrete value. Any transition to
    // a concrete value is an edge — including direct switches (question→approval)
    // that never pass through undefined, which the vendor's combined-selector
    // (manager.ts statuses.find) produces normally. Same-value replay never
    // emits; clearing pending back to undefined never emits either.
    const pendingChanged = before?.pending !== after.pending && after.pending != null
    const ask = pendingChanged && after.pending === 'question'
    const request =
      pendingChanged && (after.pending === 'approval' || after.pending === 'plan-review')

    if (complete) edges.push({ sessionId, kind: 'complete' })
    if (ask) edges.push({ sessionId, kind: 'ask' })
    if (request) edges.push({ sessionId, kind: 'request' })
  }
  return edges
}

/**
 * Complete 去重（App 层调用，跨上报记忆）：同一会话的 complete 只发一次，
 * 直到会话重新 running（running=true 时清除记忆，下次完成重新可发）。
 * 解决「正被查看的会话完成 → running 边沿先发 → 切走后 vendor 延迟武装
 * completed → 第二条 complete 边沿」的双发。PURE：返回过滤后的边沿与
 * 更新后的 notified 集合，由调用方持有。
 */
export function dedupeCompleteEdges(
  edges: readonly NotificationEdge[],
  notified: ReadonlySet<string>,
  runningIds: readonly string[],
): { edges: NotificationEdge[]; notified: Set<string> } {
  const nextNotified = new Set(notified)
  // 重新 running 的会话清除已发记忆（下次完成重新可发）。
  for (const sessionId of runningIds) nextNotified.delete(sessionId)
  const filtered: NotificationEdge[] = []
  for (const edge of edges) {
    if (edge.kind === 'complete') {
      if (nextNotified.has(edge.sessionId)) continue
      nextNotified.add(edge.sessionId)
    }
    filtered.push(edge)
  }
  return { edges: filtered, notified: nextNotified }
}
