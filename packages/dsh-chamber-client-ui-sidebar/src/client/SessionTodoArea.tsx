/**
 * 会话待办区（sidebar todo area）— pinned attention block between the New
 * Session control and the scroll region (wide only; absent on the rail and
 * while empty). Renders deriveTodoAttention over the SAME chamberBridge
 * projection the list rows render: completed-but-unread plus pending
 * interactions (approval / plan-review / question).
 * 交互契约：click 走与 session-row 相同的权威 open 路径（SidebarRoot 的
 * requestOpen 施加拖拽尾随 click 与途中 rename 守卫）；条目只随投影移除，
 * 失败的 open 保留条目；当前阅读的 session 由推导排除。Geometry: cap 3 rows
 * +「还有 N 项」toggle，展开侧 BOUNDED（.todoRows 内部滚动）不挤压列表。
 * Accepted risk: mount 移动布局一次，在途按压可能多打开一个有效 session。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  IconChecklistOutlineRegular, IconQuestionOutlineRegular, IconWarningOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { sourceAccentColor } from '@dsh-chamber/dsh-chamber-client-core/derive'
import {
  deriveTodoAttention, type TodoAttentionEntry, type TodoAttentionKind,
} from '@dsh-chamber/dsh-chamber-client-core/todo-attention'
import { getTodoPrefs, subscribeTodoPrefs } from '@dsh-chamber/dsh-chamber-client-core/todo-prefs'
import type { SidebarKey } from './locales.ts'
import cc from './sidebar-chamber.module.css'

const TODO_CAP = 3

/** Translate bound to this plugin's `sidebar` namespace (PropsLocale shape). */
type TodoTranslate = (key: SidebarKey, params?: Record<string, string | number>) => string

export function SessionTodoArea({
  servers,
  chamberInstanceId,
  requestOpen,
  t,
}: {
  servers: ChamberServerAggregate[]
  /** The instance id of THIS ctx — the source being viewed when visible. */
  chamberInstanceId: string
  /** The guarded authoritative open (SidebarRoot-owned): drag-end trailing
   *  click + same-session rename guards, then requestOpenSession. Removal is
   *  projection-driven — never optimistic. */
  requestOpen: (sourceId: string, sessionId: string) => void
  t: TodoTranslate
}) {
  // chamber-global sessionTodo 设置的只读镜像；未注水 = 默认全开。
  const prefs = useSyncExternalStore(subscribeTodoPrefs, getTodoPrefs, getTodoPrefs)

  const entries = useMemo(() => {
    if (!prefs.enabled) return []
    const own = servers.find(server => server.id === chamberInstanceId)
    return deriveTodoAttention(servers, {
      viewingSourceId: chamberInstanceId,
      viewingSessionId: own?.runtime?.current,
      filters: {
        completed: prefs.onComplete,
        ask: prefs.onAsk,
        request: prefs.onRequest,
      },
    })
  }, [servers, chamberInstanceId, prefs])

  const [expanded, setExpanded] = useState(false)
  const overCap = entries.length > TODO_CAP
  // 计数回到 cap 或以下即折叠：沉寂后重新增长必须重新折叠，而非弹回展开。
  useEffect(() => {
    if (expanded && !overCap) setExpanded(false)
  }, [expanded, overCap])
  const shown = expanded ? entries : entries.slice(0, TODO_CAP)
  if (shown.length === 0) return null

  const labelOf = (sourceId: string): string =>
    servers.find(server => server.id === sourceId)?.label ?? sourceId

  return (
    // 区域名带实时条目数（{n}），屏幕阅读器无需依赖 aria-hidden 的计数 pill。
    <div className={cc.todoArea} role="region" aria-label={t('todo.region.aria', { n: entries.length })}>
      <div className={cc.todoHeader}>
        <span className={cc.todoTitle}>{t('todo.title')}</span>
        <span className={cc.todoCount} aria-hidden="true">{entries.length}</span>
      </div>
      {/* 展开的积压在盒内滚动，不挤压会话列表；下方切换钮保持固定可达。 */}
      <div className={cc.todoRows}>
        {shown.map(entry => (
          <TodoRow
            key={`${entry.sourceId}/${entry.sessionId}/${entry.kind}`}
            entry={entry}
            sourceLabel={labelOf(entry.sourceId)}
            showSourceDot={servers.length > 1}
            requestOpen={requestOpen}
            t={t}
          />
        ))}
      </div>
      {overCap && (
        <button
          type="button"
          className={cc.todoMore}
          onClick={() => setExpanded(current => !current)}
        >
          {expanded ? t('todo.fewer') : t('todo.more', { n: entries.length - TODO_CAP })}
        </button>
      )}
    </div>
  )
}

function kindStatusKey(kind: TodoAttentionKind): SidebarKey {
  switch (kind) {
    case 'approval': return 'status.waitingApproval'
    case 'plan-review': return 'status.planReview'
    case 'question': return 'status.waitingAnswer'
    case 'completed': return 'status.completed'
  }
}

/** Official display label, with the unnamed copy as a defensive fallback for a
 *  pre-revision entry object (host-unreadable titles show the directory name). */
function titleOf(entry: TodoAttentionEntry, t: TodoTranslate): string {
  return entry.displayTitle !== undefined && entry.displayTitle !== ''
    ? entry.displayTitle
    : (entry.title !== undefined && entry.title !== '' ? entry.title : t('list.unnamed'))
}

function TodoRow({
  entry,
  sourceLabel,
  showSourceDot,
  requestOpen,
  t,
}: {
  entry: TodoAttentionEntry
  sourceLabel: string
  showSourceDot: boolean
  requestOpen: (sourceId: string, sessionId: string) => void
  t: TodoTranslate
}) {
  const stateKey = kindStatusKey(entry.kind)
  const status = t(stateKey)
  const title = titleOf(entry, t)
  const context = entry.workspaceTitle !== undefined
    ? `${status} · ${sourceLabel} · ${entry.workspaceTitle}`
    : `${status} · ${sourceLabel}`
  // 远端来源用派生的 accent，本地来源保持默认墨色（source-header 身份纪律）。
  const accent = showSourceDot ? sourceAccentColor(entry.sourceId) : undefined
  const dotStyle = accent === undefined
    ? undefined
    : { backgroundColor: accent, opacity: 1 }

  // Tooltip 先给完整标题（截断的行标题否则不可恢复），再接 state·source·workspace。
  const hoverLabel = `${title} · ${context}`

  // Row anatomy mirrors a session row: identity LEADING, state TRAILING. The
  // trailing slot reuses the rows' .sessionStateSlot geometry (10px, 14px while
  // pending) so strip and list state marks line up; the 16px leading source-dot
  // slot stays reserved even without multiple sources (title column never
  // shifts). Both slots are aria-hidden — the button's aria-label carries
  // state + title + source. Accepted a11y gap: no live announcements on entry
  // change (pinned projection; only the focused row's unread state announces).
  return (
    <Tooltip label={hoverLabel} delayMs={400}>
      <button
        type="button"
        className={cc.todoRow}
        data-chamber-todo={`${entry.sourceId}:${entry.sessionId}:${entry.kind}`}
        data-chamber-stale={entry.stale === true || undefined}
        aria-label={t('todo.row.aria', { state: status, title, source: sourceLabel })}
        onClick={() => {
          requestOpen(entry.sourceId, entry.sessionId)
        }}
      >
        <span className={cc.todoLeadSlot} aria-hidden="true">
          {showSourceDot && (
            <span className={clsx(cc.todoSourceDot, dotStyle === undefined && cc.todoSourceDotLocal)} style={dotStyle} />
          )}
        </span>
        <span className={cc.todoRowTitle}>{title}</span>
        <span
          className={clsx(cc.sessionStateSlot, entry.kind !== 'completed' && cc.sessionStateSlotPending)}
          aria-hidden="true"
        >
          {entry.kind === 'approval' && <IconWarningOutlineRegular className={cc.statePendingApproval} />}
          {entry.kind === 'plan-review' && <IconChecklistOutlineRegular className={cc.statePendingPlan} />}
          {entry.kind === 'question' && <IconQuestionOutlineRegular className={cc.statePendingQuestion} />}
          {/* 复用列表行的状态标记：completed 用 chamber 品牌蓝
              .stateCompleted（官方的 done 绿与 source header 的连接点同色）。 */}
          {entry.kind === 'completed' && <span className={cc.stateCompleted} />}
        </span>
      </button>
    </Tooltip>
  )
}
