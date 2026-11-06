/**
 * Checkout-row removal dialog (design 08 §5.3-§5.4). One Modal states the
 * identity, the optional "also delete the local branch", the optional
 * "archive these sessions" choice (default OFF; the caller runs the official
 * two-phase archive), and the acknowledgement that arms the destructive
 * confirm. The dialog owns no prose: every label is a prop resolved by the
 * caller's single i18n boundary.
 */
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SidebarGit.module.css'

export interface CheckoutRemoveDialogProps {
  open: boolean
  title: string
  description: string
  /** Required acknowledgement (dirty/missing); omitted for a clean row. */
  acknowledgeLabel?: string
  path: string
  branch: string | null
  /** Leftover-record cleanup: no branch/file action applies. */
  missing: boolean
  deleteBranchLabel: string
  /** Optional archive choice; disabled while facts are unknown/unavailable. */
  archiveLabel: string
  archiveNote: string
  archiveCount?: string
  archiveAvailable: boolean
  archiveLoading?: boolean
  archiveLoadingLabel?: string
  archiveRetryLabel?: string
  onArchiveRetry?: () => void
  archiveError?: string
  /** Localized display titles for the archive closure (≤5 shown + “more”). */
  archiveTitles?: readonly string[]
  archiveMoreLabel?: string
  /** A neutral status (e.g. the user cancelled the stop confirmation). */
  notice?: string
  /** A removal/archive failure to state in place (the dialog stays open). */
  error?: string
  cancelLabel: string
  closeLabel: string
  confirmLabel: string
  acknowledged: boolean
  deleteBranch: boolean
  archive: boolean
  disabled?: boolean
  onAcknowledgedChange: (acknowledged: boolean) => void
  onDeleteBranchChange: (deleteBranch: boolean) => void
  onArchiveChange: (archive: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}

export function CheckoutRemoveDialog({
  open, title, description, acknowledgeLabel, path, branch, missing, deleteBranchLabel,
  archiveLabel, archiveNote, archiveCount, archiveAvailable, archiveLoading, archiveLoadingLabel,
  archiveRetryLabel, onArchiveRetry, archiveError, archiveTitles, archiveMoreLabel, notice, error,
  cancelLabel, closeLabel, confirmLabel, acknowledged, deleteBranch, archive, disabled = false,
  onAcknowledgedChange, onDeleteBranchChange, onArchiveChange, onCancel, onConfirm,
}: CheckoutRemoveDialogProps): ReactNode {
  const confirmDisabled = disabled || (acknowledgeLabel !== undefined && !acknowledged)
  // A confirmed removal cannot be dismissed by the X/Escape/mask: the async step
  // would otherwise continue after an apparent cancel. The footer button is
  // disabled too; this guard covers the Modal's own close path.
  const requestClose = (): void => {
    if (disabled) return
    onCancel()
  }
  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={title}
      closeLabel={closeLabel}
      className={css.dialog}
      footer={(
        <>
          <Button variant="outline" disabled={disabled} onClick={requestClose}>{cancelLabel}</Button>
          <Button
            variant="outline"
            className={css.danger}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div className={css.removeFacts}>
        <code>{path}</code>
        {branch !== null && <span>{branch}</span>}
        <p className={css.removeDescription}>{description}</p>
        {!missing && branch !== null && (
          <label className={css.rowCheckbox}>
            <input
              type="checkbox"
              checked={deleteBranch}
              disabled={disabled}
              onChange={event => onDeleteBranchChange(event.target.checked)}
            />
            <span>{deleteBranchLabel}</span>
          </label>
        )}
        {!missing && (
          <label className={css.rowCheckbox}>
            <input
              type="checkbox"
              checked={archive}
              disabled={disabled || !archiveAvailable}
              onChange={event => onArchiveChange(event.target.checked)}
            />
            <span>{archiveLabel}</span>
          </label>
        )}
        {!missing && archiveLoading === true && (
          <div className={css.archiveNote} role="status">{archiveLoadingLabel}</div>
        )}
        {!missing && archive && (
          <div className={css.archiveNote}>
            <span>{archiveNote}{archiveCount === undefined ? '' : ' ' + archiveCount}</span>
            {archiveTitles !== undefined && archiveTitles.length > 0 && (
              <ul className={css.archiveSessionList}>
                {archiveTitles.slice(0, 5).map((title, index) => <li key={title + String(index)}>{title}</li>)}
                {archiveTitles.length > 5 && (
                  <li>{archiveMoreLabel?.replace('{n}', String(archiveTitles.length - 5))}</li>
                )}
              </ul>
            )}
          </div>
        )}
        {archiveError !== undefined && (
          <span className={css.formError} role="alert">
            {archiveError}
            {onArchiveRetry !== undefined && (
              <button type="button" className={css.archiveRetry} disabled={disabled} onClick={onArchiveRetry}>{archiveRetryLabel}</button>
            )}
          </span>
        )}
        {notice !== undefined && <div className={css.removeNotice} role="status">{notice}</div>}
        {error !== undefined && <span className={css.formError} role="alert">{error}</span>}
        {acknowledgeLabel !== undefined && (
          <label className={css.rowCheckbox}>
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={disabled}
              onChange={event => onAcknowledgedChange(event.target.checked)}
            />
            <span>{acknowledgeLabel}</span>
          </label>
        )}
      </div>
    </Modal>
  )
}
