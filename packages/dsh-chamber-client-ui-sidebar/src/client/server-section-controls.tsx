/** Small shared JSX leaves of the chamber sidebar ServerSection subtree: the
 *  active-Schedule marker and the inline rename form shared by the workspace
 *  header and the session rows. */
import clsx from 'clsx'
import { IconAlarmClockOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { clearPendingClick } from '@dsh-chamber/dsh-chamber-client-core/pending-click'
import { useSidebarSection } from './sidebar-context.ts'
import cc from './sidebar-chamber.module.css'

/**
 * Non-interactive active-Schedule marker: a markup/token mirror of the official
 * `ActiveScheduleIndicator` (module-local upstream, NOT exported) — a `role="img"`
 * span carrying the localized `schedule.active` copy as both accessible name and
 * native title around the 16px alarm-clock glyph; the enclosing row stays the only
 * action. Renders only where `hasActiveSchedule` says so.
 */
export function SessionScheduleIndicator({ label }: { label: string }) {
  return (
    <span className={cc.scheduleIndicator} role="img" aria-label={label} title={label}>
      <IconAlarmClockOutline16 size={16} />
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
