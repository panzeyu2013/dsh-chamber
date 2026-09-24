/**
 * 会话待办区派生（sidebar todo area）— chamberBridge 投影上的纯注意力视图：
 * 哪些会话当前需要用户（完成未读，或等待输入：approval / plan-review /
 * question）。无自有状态、无 DOM，输入与行级状态指示同源（mergeRuntimeFacts）。
 *
 * 镜像纪律：条目出现/消失与行指示完全同步（与 sessionStateDot 同序：
 * pending > 运行中子代理 > completed > running）——待办区绝不声称行本身不显示
 * 的状态。仅当会话行**在投影里**才产生条目；断连来源只放开 App 显式标 `stale`
 * 的事实（`offlineUnread` 选项进一步放开行已消失的未读事实）。正在查看的会话由
 * 调用方 viewing ids 排除。排序确定且跨 ctx 一致：等待类（阻塞 agent）在前、
 * 完成类在后，组内保持投影扫描序；上限由调用方切片。
 */
import type { ChamberServerAggregate } from './aggregate-store.ts'
import { sessionDisplayTitle } from './derive.ts'
import { subagentActivityOf } from './session-row-state.ts'

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
   * The entry comes from facts of a disconnected source (or the offline-unread
   * group's row-less facts). Consumers must label it (`data-chamber-stale`); absent = live fact.
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
        // completed 与行尾蓝点同一条件：pending 无、子代理不存活、合并 completed 为真；vendor-completed
        // 与 wire running 错位窗口内不得漏报。只有**确证在跑**的子代理压制未读；unknown（stale/索引缺席）不压制。
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
    // 行缺席分支（显式选项）：断连 + stale + 行不在投影里的 completed 事实；只出未读，标签用 sessionId 兜底，分组键 entry.stale。
    if (!offline || opts.offlineUnread !== true) continue
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
  // 等待类（阻塞 agent）在前、完成未读在后；组内保持列表扫描序。
  return [...waiting, ...completed]
}
