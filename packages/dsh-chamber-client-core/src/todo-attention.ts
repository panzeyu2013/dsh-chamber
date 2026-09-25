/**
 * 会话待办区派生（sidebar todo area）— the chamberBridge projection's PURE
 * attention view: which sessions currently need the user's attention
 * (completed-but-unread, or an agent interaction waiting: approval /
 * plan-review / question). No state of its own, no memory, no DOM — a plain
 * node:test-runnable derivation over the SAME merged runtime facts the
 * row-level state indicators render (06 §4; the merged `completed` bit is written
 * by the App's completed-unread ledger alone — the channel never carries one).
 *
 * Mirror-of-the-mirror discipline: an entry appears/disappears exactly when
 * the corresponding row indicator would — the rules below replicate the
 * sessionStateDot priority (pending > runningSubagents > completed >
 * running) so the strip can never claim attention the rows themselves do not
 * show, and vice versa.
 *
 * - An entry exists only while its session row is IN the projection. A
 *   disconnected source carries no LIVE runtime facts (unknown ≠ attention);
 *   exactly one door is open: facts the App explicitly marked `stale: true`
 *   ride a disconnected source too, and are rendered (labelled `stale`) while
 *   the rows survive. With `offlineUnread` enabled, a disconnected stale
 *   source whose ROWS ARE GONE still surfaces its completed-unread facts as an
 *   "offline unread" group (sessionId fallback label) — the row-absent half of
 *   the stale-facts branch, opt-in so no consumer is forced onto a new surface.
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
import { goalSuppressesPresentation, subagentActivityOf } from './session-row-state.ts'

/** The attention kinds the strip renders. `completed` = completed-but-unread; the other three are the vendor pending kinds. */
export type TodoAttentionKind = 'approval' | 'plan-review' | 'question' | 'completed'

/** One derived todo entry; `displayTitle` is the official resolved label (never empty), so the component never renders the unnamed fallback for a host-unreadable title. */
export interface TodoAttentionEntry {
  sourceId: string
  sessionId: string
  kind: TodoAttentionKind
  title: string
  /** Official display label — never empty (see derive.ts sessionDisplayTitle). */
  displayTitle: string
  workspaceTitle?: string
  /** Last-activity epoch ms (row fact; absent when the wire gave none). */
  updatedAt?: number
  /**
   * The entry comes from facts of a source that is disconnected right now
   * (the aggregate `runtime.stale` fact) — or, for the offline-unread group,
   * from facts whose rows are gone. Consumers must label it (I13/I2
   * `data-chamber-stale`); absent = live fact, today's semantics.
   */
  stale?: boolean
}

/** Per-kind gates from the chamber-global `sessionTodo` settings block. */
export interface TodoAttentionFilters {
  completed: boolean
  ask: boolean
  request: boolean
}

/** Derive the attention entries over the display-ordered servers projection.
 * `viewingSourceId`/`viewingSessionId` exclude the session being read; `offlineUnread` (opt-in)
 * additionally emits completed-unread facts of a disconnected stale source whose rows are gone.
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
    // 断连来源无实时状态——未知 ≠ 待办；这里只放行显式标 stale 的只读事实（App 是标记的唯一写者，再查一次是防御纵深）。
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
        // completed 与行尾蓝点同一条件：pending 无、子代理不存活、合并 completed 为真（该位来自
        // App 账本）。只有**确证在跑**的子代理压制未读；unknown（stale/索引缺席）不压制。
        if (subagentActivityOf(facts, factsStale) === 'running') continue
        // goal 呈现门（v5 §4）：相位 active（含 activation unknown）压制「完成未读」
        // 条目——与行尾点/文案/仪表/搜索同一单源派生（INV7），否则待办区会为一条
        // 用户看不到完成点的行宣称「完成」。三个 kind 开关语义不变。
        if (goalSuppressesPresentation(facts.goal)) continue
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
    // 行缺席分支（显式选项）：断连 + stale + 行不在投影里的 completed 事实；只出未读，标签用 sessionId 兜底，分组键 entry.stale。
    if (!offline || opts.offlineUnread !== true) continue
    for (const sessionId of Object.keys(runtime.sessions).sort()) {
      if (rowSessionIds.has(sessionId)) continue
      if (server.id === opts.viewingSourceId && sessionId === opts.viewingSessionId) continue
      const facts = runtime.sessions[sessionId]
      if (facts?.completed !== true || !opts.filters.completed) continue
      if (subagentActivityOf(facts, true) === 'running') continue
      // 同一呈现门：行缺席分支也必须与其它五面同拍（active 即压制）。
      if (goalSuppressesPresentation(facts?.goal)) continue
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
  // 等待类（阻塞 agent）在前、完成未读在后；组内保持列表扫描序。
  return [...waiting, ...completed]
}
