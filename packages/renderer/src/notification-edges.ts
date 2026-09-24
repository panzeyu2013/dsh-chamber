/** 每会话事实（运行时事实通道 report.sessions 的行）。 */
export interface SessionFacts {
  running?: boolean
  completed?: boolean
  pending?: 'approval' | 'plan-review' | 'question'
  /**
   * 运行中子代理计数（>0 稀疏）。边沿检测本身忽略它；notification-projection 用它做
   * 「父回合结束但子代理仍在跑」的完成压制（与官方 Rows 的 pending > runningSubagents > completed 一致）。
   */
  runningSubagents?: number
  /** Host activity time of this row (the run-start ordering key). */
  updatedAt?: number
}
export type NotificationKind = 'complete' | 'ask' | 'request'
export interface NotificationEdge { sessionId: string; kind: NotificationKind }

/**
 * 边沿检测：prev 事实 → next 事实 的事件集。
 * - prev 为 undefined（首份上报）：只播种记忆，返回 []（boot 时已 pending/completed 的会话不得轰炸用户）。
 * - complete：running true→false，或 vendor completed 从无到有（后者只在**边沿记忆已武装**时
 *   有意义——不是断连补发通道：重连首份上报按 prev undefined 纯播种）；同 tick 两者同时成立只发一次。
 * - ask：pending 变化到 'question'（含不经 undefined 的直切）；request：pending 变化到
 *   'approval' 或 'plan-review'。同值重放与清回 undefined 都不发。
 * - 输出顺序：next 插入顺序，同一 session 按 complete/ask/request。
 * 本函数无跨上报记忆——「同一完成只发一次」由 dedupeCompleteEdges（App 层）负责。
 */
export function detectNotificationEdges(
  prev: Record<string, SessionFacts> | undefined,
  next: Record<string, SessionFacts>,
): NotificationEdge[] {
  // First report: seed memory only (sessions already pending/completed at boot must not bombard).
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

    // ask/request: any pending VALUE CHANGE to a concrete value is an edge (including direct
    // switches that never pass undefined); same-value replay / clearing to undefined never emit.
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
 * Complete 跨上报去重：同一会话的 complete 只发一次，直到会话重新 running（running=true 清除记忆）。
 * 解决「正被查看的会话完成 → running 边沿先发 → 切走后 vendor 延迟武装 completed → 第二条边沿」的双发。
 * PURE：返回过滤后的边沿与更新后的 notified 集合，由调用方持有。
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
