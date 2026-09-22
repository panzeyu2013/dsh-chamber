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
 * - An entry exists only while its session row is IN the projection. A
 *   disconnected source carries no LIVE runtime facts (unknown ≠ attention);
 *   R14 opens exactly one door: facts the App explicitly marked `stale: true`
 *   ride a disconnected source too, and are rendered (labelled `stale`) while
 *   the rows survive. With `offlineUnread` enabled, a disconnected stale
 *   source whose ROWS ARE GONE still surfaces its completed-unread facts as an
 *   "offline unread" group (sessionId fallback label) — the row-absent half of
 *   R14, opt-in so no consumer is forced onto a new surface.
 * - The session being read right now (the active view's current session) is
 *   excluded by the caller-provided viewing ids — the same single-selection
 *   rule as the current-session highlight (SidebarRoot chamberInstanceId).
 * - Sorting is deterministic and cross-ctx identical: waiting entries first
 *   (they block the agent), completed after; within each group the scan order
 *   of the projected list (source display order → workspace order → session
 *   order) is preserved. The caller slices the cap (3 +「还有 N 项」).
 */
import type { ChamberServerAggregate } from './aggregate-store.ts'
import { sessionDisplayTitle } from './derive.ts'
import { subagentActivityOf } from './session-row-state.ts'

/** The attention kinds the todo area renders. `completed` = completed-but-
 *  unread (the blue-dot merged state); the other three are the vendor pending
 *  registry kinds (ui-session visiblePendingKind vocabulary). */
export type TodoAttentionKind = 'approval' | 'plan-review' | 'question' | 'completed'

/** One derived todo entry. Presentation fields (title/workspace) ride the
 *  projection rows; `displayTitle` is the official resolved label (I3), so the
 *  component never falls back to the unnamed copy for a session whose title the
 *  host could not read. */
export interface TodoAttentionEntry {
  sourceId: string
  sessionId: string
  kind: TodoAttentionKind
  /** Durable title projection ('' when the session has none). */
  title: string
  /** Official display label — never empty (see derive.ts sessionDisplayTitle). */
  displayTitle: string
  workspaceTitle?: string
  /** Last-activity epoch ms (row fact; absent when the wire gave none). */
  updatedAt?: number
  /**
   * R14: the entry comes from facts of a source that is disconnected right now
   * (the aggregate `runtime.stale` fact) — or, for the offline-unread group,
   * from facts whose rows are gone. Consumers must label it (I13/I2
   * `data-chamber-stale`); absent = live fact, today's semantics.
   */
  stale?: boolean
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
 * @param opts.offlineUnread - R14 row-absent branch (opt-in): also emit the
 *   completed-unread facts of a DISCONNECTED stale source whose rows are gone,
 *   as an offline-unread group. Absent = today's row-bound semantics exactly.
 */
export function deriveTodoAttention(
  servers: readonly ChamberServerAggregate[],
  opts: {
    viewingSourceId?: string
    viewingSessionId?: string
    filters: TodoAttentionFilters
    offlineUnread?: boolean
  },
): TodoAttentionEntry[] {
  const waiting: TodoAttentionEntry[] = []
  const completed: TodoAttentionEntry[] = []
  for (const server of servers) {
    const runtime = server.runtime
    // 断连来源无实时状态（App 只在 connected 或「有只读事实」时附加 runtime）
    // ——未知 ≠ 待办，不臆造条目（重连后随真实状态重现）。R14 放开的是**显式
    // 标 stale 的只读事实**：未标 stale 的断连 runtime 保持旧行为（App 是标记
    // 的唯一写者；这里再查一次是防御纵深）。
    const offline = server.connected !== true
    if (offline && runtime?.stale !== true) continue
    if (runtime === undefined) continue
    // 事实是否 stale 只信事实本身（连接态也可能带着一份标注过期的快照）。
    const factsStale = runtime.stale === true
    const rowSessionIds = new Set<string>()
    for (const workspace of server.workspaces) {
      for (const session of workspace.sessions) {
        rowSessionIds.add(session.id)
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
            displayTitle: sessionDisplayTitle({
              displayTitle: session.displayTitle,
              title: session.title,
              sessionId: session.id,
            }),
          }
          if (session.updatedAt !== undefined) entry.updatedAt = session.updatedAt
          if (workspace.title !== undefined && workspace.title !== '') entry.workspaceTitle = workspace.title
          if (factsStale) entry.stale = true
          waiting.push(entry)
          continue
        }
        // completed 与行尾蓝点同一显示条件与优先级：pending 无、子代理不
        // 存活、合并 completed 为真即出条目——completed 优先于运行环（行
        // 指示的 sessionStateDot 顺序：pending > 子代理 > completed > 运行
        // 环；wire running 只在无 completed 时渲染环），vendor-completed 与
        // wire running 的通道错位窗口内不得漏报（06 §4.3 同序纪律）。
        // P5：只有确证在跑的子代理才压制「完成未读」条目；unknown（stale/索引缺席）
        // 不压制——用不可信的计数压掉用户可见面，正是这次要消除的形态。
        if (subagentActivityOf(facts, factsStale) === 'running') continue
        if (facts.completed !== true || !opts.filters.completed) continue
        const entry: TodoAttentionEntry = {
          sourceId: server.id,
          sessionId: session.id,
          kind: 'completed',
          title: session.title ?? '',
          displayTitle: sessionDisplayTitle({
            displayTitle: session.displayTitle,
            title: session.title,
            sessionId: session.id,
          }),
        }
        if (session.updatedAt !== undefined) entry.updatedAt = session.updatedAt
        if (workspace.title !== undefined && workspace.title !== '') entry.workspaceTitle = workspace.title
        if (factsStale) entry.stale = true
        completed.push(entry)
      }
    }
    // R14 行缺席分支（显式选项）：断连 + stale + 行不在投影里的 completed 事实
    // ——待办区是唯一还能承载它的面（遍历行的旧实现无基底）。只出未读（completed
    // 且子代理压制同规则），标签用 sessionId 兜底（derive.ts sessionDisplayTitle），
    // 分组键是 entry.stale；不新增桥接面 / 不改 kind 联合。
    if (!offline || opts.offlineUnread !== true) continue
    // 确定序：sessionId 升序（跨 ctx 一致，与配置无关）。
    for (const sessionId of Object.keys(runtime.sessions).sort()) {
      if (rowSessionIds.has(sessionId)) continue
      if (server.id === opts.viewingSourceId && sessionId === opts.viewingSessionId) continue
      const facts = runtime.sessions[sessionId]
      if (facts?.completed !== true || !opts.filters.completed) continue
      if (subagentActivityOf(facts, true) === 'running') continue
      completed.push({
        sourceId: server.id,
        sessionId,
        kind: 'completed',
        title: '',
        displayTitle: sessionDisplayTitle({ sessionId }),
        stale: true,
      })
    }
  }
  // 等待类（阻塞 agent）在前、完成未读在后；组内保持列表扫描序（确定、
  // 跨 ctx 一致）。两次 push 已保序，这里顺序拼接即可。
  return [...waiting, ...completed]
}
