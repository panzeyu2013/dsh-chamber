/**
 * 会话待办区派生（sidebar todo area）— the chamberBridge projection's PURE
 * attention view: which sessions currently need the user's attention
 * (completed-but-unread, or an agent interaction waiting: approval /
 * plan-review / question). No state of its own, no memory, no DOM — a plain
 * node:test-runnable derivation over the SAME merged runtime facts the
 * row-level state indicators render (06 §4; mergeRuntimeFacts union of the
 * App's completed-unread dots and the vendor-armed `completed`).
 *
 * Mirror-of-the-mirror discipline: an entry appears/disappears exactly when
 * the corresponding row indicator would — the rules below replicate the
 * sessionStateDot priority (pending > runningSubagents > completed >
 * running) so the strip can never claim attention the rows themselves do not
 * show, and vice versa.
 *
 * - An entry exists only while its session row is IN the projection and its
 *   source is connected (a disconnected source carries no runtime facts —
 *   unknown ≠ attention; the entry reappears with the true state after
 *   reconnect, or stays gone when it was resolved meanwhile).
 * - The session being read right now (the active view's current session) is
 *   excluded by the caller-provided viewing ids — the same single-selection
 *   rule as the current-session highlight (SidebarRoot chamberInstanceId).
 * - Sorting is deterministic and cross-ctx identical: waiting entries first
 *   (they block the agent), completed after; within each group the scan order
 *   of the projected list (source display order → workspace order → session
 *   order) is preserved. The caller slices the cap (3 +「还有 N 项」).
 */
import type { ChamberServerAggregate } from './aggregate-store.ts'

/** The attention kinds the todo area renders. `completed` = completed-but-
 *  unread (the blue-dot merged state); the other three are the vendor pending
 *  registry kinds (ui-session visiblePendingKind vocabulary). */
export type TodoAttentionKind = 'approval' | 'plan-review' | 'question' | 'completed'

/** One derived todo entry. Presentation fields (title/workspace) ride the
 *  projection rows — the component falls back to its own unnamed copy when
 *  the title is empty. */
export interface TodoAttentionEntry {
  sourceId: string
  sessionId: string
  kind: TodoAttentionKind
  title: string
  workspaceTitle?: string
  /** Last-activity epoch ms (row fact; absent when the wire gave none). */
  updatedAt?: number
}

/** Per-kind gates, fed by the chamber-global settings block
 *  (ChamberSessionTodoSettings: onComplete / onAsk / onRequest). */
export interface TodoAttentionFilters {
  completed: boolean
  ask: boolean
  request: boolean
}

/** Derive the attention entries over the servers projection.
 *
 * @param servers - display-ordered ChamberServerAggregate list (the same the
 *   sidebar renders).
 * @param opts.viewingSourceId - the source owning the visible sidebar ctx
 *   (chamberInstanceId); pass undefined for no exclusion.
 * @param opts.viewingSessionId - that source's runtime current session (only
 *   consulted when the entry's source is the viewing source).
 * @param opts.filters - per-kind gates from the settings block.
 */
export function deriveTodoAttention(
  servers: readonly ChamberServerAggregate[],
  opts: { viewingSourceId?: string; viewingSessionId?: string; filters: TodoAttentionFilters },
): TodoAttentionEntry[] {
  const waiting: TodoAttentionEntry[] = []
  const completed: TodoAttentionEntry[] = []
  for (const server of servers) {
    // 断连来源无实时状态（App 只在 connected 时附加 runtime；此处显式再
    // 查一次作防御纵深）——未知 ≠ 待办，不臆造条目（重连后随真实状态重现）。
    if (!server.connected) continue
    const runtime = server.runtime
    if (runtime === undefined) continue
    for (const workspace of server.workspaces) {
      for (const session of workspace.sessions) {
        // 正在查看的会话不进待办（同高亮单选纪律；内容已在屏幕上）。
        if (server.id === opts.viewingSourceId && session.id === opts.viewingSessionId) continue
        const facts = runtime.sessions[session.id]
        if (facts === undefined) continue
        const pending = facts.pending
        if (pending !== undefined) {
          // 行尾徽章优先级第一位：任何 pending 覆盖其它状态。
          const allowed = pending === 'question' ? opts.filters.ask : opts.filters.request
          if (!allowed) continue
          const entry: TodoAttentionEntry = {
            sourceId: server.id,
            sessionId: session.id,
            kind: pending,
            title: session.title ?? '',
          }
          if (session.updatedAt !== undefined) entry.updatedAt = session.updatedAt
          if (workspace.title !== undefined && workspace.title !== '') entry.workspaceTitle = workspace.title
          waiting.push(entry)
          continue
        }
        // completed 与行尾蓝点同一显示条件与优先级：pending 无、子代理不存活、
        // 合并 completed 为真即出条目——completed 优先于运行环（行指示的
        // sessionStateDot 顺序：pending > 子代理 > completed > 运行环；wire
        // running 只在无 completed 时渲染环），vendor-completed 与 wire
        // running 的通道错位窗口内不得漏报（06 §4.3 同序纪律）。
        const runningSubagents = facts.runningSubagents ?? 0
        if (runningSubagents > 0) continue
        if (facts.completed !== true || !opts.filters.completed) continue
        const entry: TodoAttentionEntry = {
          sourceId: server.id,
          sessionId: session.id,
          kind: 'completed',
          title: session.title ?? '',
        }
        if (session.updatedAt !== undefined) entry.updatedAt = session.updatedAt
        if (workspace.title !== undefined && workspace.title !== '') entry.workspaceTitle = workspace.title
        completed.push(entry)
      }
    }
  }
  // 等待类（阻塞 agent）在前、完成未读在后；组内保持列表扫描序（确定、
  // 跨 ctx 一致）。稳定分区：两次 push 已保序，这里顺序拼接即可。
  return [...waiting, ...completed]
}
