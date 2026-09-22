/**
 * Small shared JSX leaves of the chamber sidebar ServerSection subtree: the
 * non-interactive active-Schedule marker and the inline rename form shared by
 * the workspace header and the session rows.
 */
import clsx from 'clsx'
import { IconAlarmClockOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { clearPendingClick } from '../shared/pending-click.ts'
import { useSidebarSection } from './sidebar-context.ts'
import cc from './sidebar-chamber.module.css'

/**
 * Non-interactive active-Schedule marker.
 *
 * Mirrors the official `ActiveScheduleIndicator` verbatim (vendor ui-workspace
 * Rows.tsx:284-296): a `role="img"` span carrying the localized
 * `schedule.active` copy as both its accessible name and its native title,
 * wrapping the 16px alarm-clock glyph — the enclosing row stays the only
 * action. Upstream keeps that component module-local (it is NOT exported from
 * the vendor package), so this is a markup/token mirror of it, not a second
 * behaviour: it renders only where the fact says so
 * (`ChamberServerWorkspace.sessions[].hasActiveSchedule`, projected from the
 * session's `schedule` projection — see `hasActiveScheduleOf`).
 * @param props.label - the localized `schedule.active` copy.
 * @returns the marker element.
 */
export function SessionScheduleIndicator({ label }: { label: string }) {
  return (
    <span className={cc.scheduleIndicator} role="img" aria-label={label} title={label}>
      <IconAlarmClockOutline16 size={16} />
    </span>
  )
}

  // The rename edit UI, rendered in place at the renamed entity:
  // 'sessionRow' swaps a session row's slot (row replaced by the form,
  // indented at the session level); 'workspaceHeader' embeds the form
  // INSIDE the workspace header row in place of the title/orphan-badge/count/git
  // occupant/hover actions (行内编辑 — no extra list row
  // appears; the header keeps its fold toggle/gutter). Enter commits;
  // Escape cancels from anywhere inside the form; 取消 always cancels.
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
        // stopPropagation also stops the native event, so the document-level
        // pending-click canceller never sees this click — every
        // propagation-stopping control clears the pending itself
        // (pending-click.ts INVARIANT).
        event.stopPropagation()
        clearPendingClick()
      }}
      onSubmit={(event) => { event.preventDefault(); commitRename() }}
      // Escape cancels wherever the focus sits inside the form (input, or
      // the save/cancel buttons) — not only while the input is focused.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        setRenaming(null)
      }}
    >
      <input
        className={cc.inlineInput}
        autoFocus
        // The treeitem label (title span) is swapped out while editing, so
        // the input itself carries the rename action as its accessible name
        // (both the session-row and the workspace-header form share this).
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
