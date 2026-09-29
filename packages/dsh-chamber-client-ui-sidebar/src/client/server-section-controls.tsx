/** Small shared JSX leaves of the chamber sidebar ServerSection subtree: the
 *  active-Schedule marker and the inline rename form shared by the workspace
 *  header and the session rows. */
import clsx from 'clsx'
import { IconAlarmClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { clearPendingClick } from '@dsh-chamber/dsh-chamber-client-core/pending-click'
import { useSidebarSection } from './sidebar-context.ts'
import cc from './sidebar-chamber.module.css'

/**
 * Non-interactive active-Schedule marker: a markup/token mirror of the official
 * occupant of `sidebar.session.row.leading` — `ui-schedule` 的 `SessionScheduleMark.tsx`
 * （旧代锚 `ActiveScheduleIndicator` 已随上游换代退役；本注释与 checklist §4.6 同步复核）。
 * 本仓形态（有意分歧，行首座席内渲染）：`role="img"` span，本地化 `schedule.active` 同时作
 * 无障碍名与原生 title，字形 16px 闹钟；上游是 12px 时钟 + 视觉隐藏计数标签。渲染仍只由
 * `hasActiveSchedule` 决定，外层行仍是唯一动作。
 */
export function SessionScheduleIndicator({ label }: { label: string }) {
  return (
    <span className={cc.scheduleIndicator} role="img" aria-label={label} title={label}>
      <IconAlarmClockOutlineRegular size={16} />
    </span>
  )
}

  // The rename edit UI, rendered in place at the renamed entity: 'sessionRow'
  // swaps a session row's slot; 'workspaceHeader' embeds the form INSIDE the header
  // row in place of the title/orphan-badge/count/git/occupant/hover actions (no extra
  // list row; the header keeps its fold toggle/gutter). Enter commits; Escape cancels from anywhere in the form.
export function ServerSectionRenameForm({ placeholder, mode }: { placeholder: string; mode: 'sessionRow' | 'workspaceHeader' }) {
  const { t, renaming, setRenaming, commitRename } = useSidebarSection()
  return (
    <form
      className={clsx(
        cc.inlineForm,
        mode === 'sessionRow' && cc.sessionNested,
        mode === 'workspaceHeader' && cc.workspaceInlineForm,
      )}
      onClick={(event) => {
        // stopPropagation also stops the native event, so the document-level pending-click
        // canceller never sees this click — every propagation-stopping control clears the pending itself (pending-click.ts INVARIANT).
        event.stopPropagation()
        clearPendingClick()
      }}
      onSubmit={(event) => { event.preventDefault(); commitRename() }}
      // Escape cancels wherever focus sits inside the form (input or the save/cancel buttons), not only on the input.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        setRenaming(null)
      }}
    >
      <input
        className={cc.inlineInput}
        autoFocus
        // The treeitem label (title span) is swapped out while editing, so the input
        // carries the rename action as its accessible name (shared by both form modes).
        aria-label={t('action.rename')}
        placeholder={placeholder}
        value={renaming?.value ?? ''}
        onChange={(event) => setRenaming((prev) => prev === null ? prev : { ...prev, value: event.target.value })}
      />
      <button type="submit" className={cc.actionButton}>{t('action.save')}</button>
      <button type="button" className={cc.actionButton} onClick={() => setRenaming(null)}>{t('action.cancel')}</button>
    </form>
  )
}
