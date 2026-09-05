/**
 * 会话待办区（sidebar todo area, 2026-12）— the pinned attention block
 * between the New Session control and the scroll region (wide only; absent on
 * the rail and while empty). Renders the pure derivation
 * deriveTodoAttention over the SAME chamberBridge projection the list rows
 * render, so it can never claim attention the row indicators do not show:
 * completed-but-unread sessions (blue-dot merged state) and sessions waiting
 * for an interaction (approval / plan-review / question).
 *
 * Interaction contract:
 * - Click = the SAME authoritative open path as a session-row click. The open
 *   itself is owned by the SidebarRoot (prop `requestOpen`), which applies
 *   the drag-end trailing-click guard (suppressClickRef) and the
 *   same-session inline-rename guard — a strip click can never fire an
 *   unintended navigation right after a list drag, nor open the session
 *   whose rename form is on screen. The App switches to the target source's
 *   shell if needed, opens the conversation, and — for completed entries —
 *   the App's read-state machine unarms the dot as soon as the session
 *   becomes the active source's current, so the entry disappears with the
 *   projection (authoritative removal; a failed open keeps the entry).
 *   Pending entries disappear only when the interaction is actually resolved
 *   (the official ui-session pending registry clears).
 * - No auto-expand/scroll of the list: the jump is content-level, and the
 *   strip never mutates the shared fold/view prefs.
 * - The session currently being read (this visible shell's source current)
 *   is excluded by derivation — the same single-selection rule as the
 *   current-session highlight.
 *
 * Geometry: cap 3 rows + a「还有 N 项」toggle; the expanded side is BOUNDED
 * (.todoRows internal scroll, ~8 rows) so a weekend backlog can never
 * squeeze the session list to zero or bury the collapse toggle. Expansion
 * state is local and auto-collapses whenever the entry count returns to the
 * cap or below (a regrowth after a lull starts collapsed again).
 *
 * Accepted risk (documented): the whole strip mounts when the first entry
 * arrives and pushes the scroll list down with no ghost grace (in-list state
 * changes never shift layout; this one does). A press in flight across the
 * mount can land its mouseup on a different row — the consequence is only an
 * extra open of a VALID session through the authoritative path (never a
 * destructive or wrong-source action), and the shift is a one-time per
 * attention-cycle event.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  IconChecklistOutline14, IconQuestionOutline14, IconWarningOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { sourceAccentColor } from '../shared/derive.ts'
import {
  deriveTodoAttention, type TodoAttentionEntry, type TodoAttentionKind,
} from '../shared/todo-attention.ts'
import { getTodoPrefs, subscribeTodoPrefs } from '../shared/todo-prefs.ts'
import type { SidebarKey } from './locales.ts'
import cc from './sidebar-chamber.module.css'

/** Visible rows before the「还有 N 项」toggle (user decision 2026-12). */
const TODO_CAP = 3

/** Translate bound to this plugin's `sidebar` namespace (PropsLocale shape). */
type TodoTranslate = (key: SidebarKey, params?: Record<string, string | number>) => string

export function SessionTodoArea({
  servers,
  chamberInstanceId,
  requestOpen,
  t,
}: {
  /** Display-ordered sources (the projection the shell renders). */
  servers: ChamberServerAggregate[]
  /** The instance id of THIS ctx — the source being viewed when visible. */
  chamberInstanceId: string
  /**
   * The guarded authoritative open (SidebarRoot-owned): applies the
   * drag-end trailing-click suppression and the same-session rename guard,
   * then chamberBridge.requestOpenSession. Removal is projection-driven —
   * never optimistic.
   */
  requestOpen: (sourceId: string, sessionId: string) => void
  t: TodoTranslate
}) {
  // Read-only mirror of the chamber-global sessionTodo settings block
  // (window.dshChamber.settings push; unhydrated = design defaults, all on).
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
  // Auto-collapse whenever the backlog returns to the cap or below — a
  // regrowth after a lull must start collapsed, not pop back fully expanded.
  useEffect(() => {
    if (expanded && !overCap) setExpanded(false)
  }, [expanded, overCap])
  const shown = expanded ? entries : entries.slice(0, TODO_CAP)
  if (shown.length === 0) return null

  const labelOf = (sourceId: string): string =>
    servers.find(server => server.id === sourceId)?.label ?? sourceId

  return (
    // Region name carries the live entry count ({n}) so a screen-reader user
    // hears it without needing the aria-hidden pill.
    <div className={cc.todoArea} role="region" aria-label={t('todo.region.aria', { n: entries.length })}>
      <div className={cc.todoHeader}>
        <span className={cc.todoTitle}>{t('todo.title')}</span>
        <span className={cc.todoCount} aria-hidden="true">{entries.length}</span>
      </div>
      {/* The expanded backlog scrolls INSIDE this bounded box (never squeezes
          the session list); the toggle below stays pinned and reachable. */}
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

/** Status copy key per attention kind — the row indicators' vocabulary. */
function kindStatusKey(kind: TodoAttentionKind): SidebarKey {
  switch (kind) {
    case 'approval': return 'status.waitingApproval'
    case 'plan-review': return 'status.planReview'
    case 'question': return 'status.waitingAnswer'
    case 'completed': return 'status.completed'
  }
}

/** Title fallback: unnamed copy matches the session rows. */
function titleOf(entry: TodoAttentionEntry, t: TodoTranslate): string {
  return entry.title !== undefined && entry.title !== '' ? entry.title : t('list.unnamed')
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
  // Remote sources carry their derived accent; the local source stays in the
  // default ink — the source-header identity discipline (shared palette
  // helper, derive.ts sourceAccentColor).
  const accent = showSourceDot ? sourceAccentColor(entry.sourceId) : undefined
  const dotStyle = accent === undefined
    ? undefined
    : { backgroundColor: accent, opacity: 1 }

  // Tooltip shows the FULL title first (a truncated row title is otherwise
  // unrecoverable — the ellipsized span holds it all) plus the state · source
  // · workspace context; the hover card therefore mirrors a session row's
  // title + meta hover card.
  const hoverLabel = `${title} · ${context}`

  // Row anatomy (2026-12 style fix, user feedback): identity LEADING, state
  // TRAILING — the same order a session row reads in the list (its source
  // group/identity at the left, its state slot at the row end). The trailing
  // slot reuses the session rows' own .sessionStateSlot geometry (10px slot,
  // 14px while a pending interaction shows; the completed dot paints in the
  // same band as the list's completed dots), so strip and list state marks
  // line up in one column. The leading 16px source-dot slot occupies the
  // source-header glyph column (and stays reserved without multiple sources,
  // so the title column never shifts). Both slots are decorative (aria-hidden)
  // — the button's aria-label carries state + title + source, so nothing is
  // announced twice (the hover card itself is not announced: the vendor
  // tooltip has no aria-describedby). Accepted (documented) a11y gap: unlike
  // the list rows' conditional role="status", the strip adds no live
  // announcements when entries appear/disappear (the strip is a pinned
  // projection; live chatter on every projection change was judged worse —
  // the unread state is still announced when a strip row is focused).
  return (
    <Tooltip label={hoverLabel} delayMs={400}>
      <button
        type="button"
        className={cc.todoRow}
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
          {entry.kind === 'approval' && <IconWarningOutline16 className={cc.statePendingApproval} />}
          {entry.kind === 'plan-review' && <IconChecklistOutline14 className={cc.statePendingPlan} />}
          {entry.kind === 'question' && <IconQuestionOutline14 className={cc.statePendingQuestion} />}
          {entry.kind === 'completed' && <span className={cc.stateCompleted} />}
        </span>
      </button>
    </Tooltip>
  )
}
