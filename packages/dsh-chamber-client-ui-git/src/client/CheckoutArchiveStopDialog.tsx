/**
 * The upstream stop confirmation for the optional archive step: the host's
 * `workspace/session-active` refusal is shown as the concrete work families
 * that will stop, and only an explicit acknowledgement re-sends with
 * `stopActivity`. The dialog owns no prose: every line is a caller-resolved
 * localized string.
 */
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SidebarGit.module.css'

export interface CheckoutArchiveStopDialogProps {
  open: boolean
  title: string
  description: string
  activityLead: string
  /** One localized line per activity family (already joined with the locale separator). */
  lines: readonly string[]
  acknowledgeLabel: string
  cancelLabel: string
  closeLabel: string
  confirmLabel: string
  acknowledged: boolean
  disabled?: boolean
  onAcknowledgedChange: (acknowledged: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}

export function CheckoutArchiveStopDialog({
  open, title, description, activityLead, lines, acknowledgeLabel,
  cancelLabel, closeLabel, confirmLabel, acknowledged, disabled = false,
  onAcknowledgedChange, onCancel, onConfirm,
}: CheckoutArchiveStopDialogProps): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      closeLabel={closeLabel}
      className={css.dialog}
      footer={(
        <>
          <Button variant="outline" disabled={disabled} onClick={onCancel}>{cancelLabel}</Button>
          <Button
            variant="outline"
            className={css.danger}
            disabled={disabled || !acknowledged}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div className={css.removeFacts}>
        <p className={css.removeDescription}>{description}</p>
        {lines.length > 0 && (
          <>
            <p className={css.removeDescription}>{activityLead}</p>
            <ul className={css.archiveActivityList}>
              {lines.map((line, index) => <li key={String(index)}>{line}</li>)}
            </ul>
          </>
        )}
        <label className={css.rowCheckbox}>
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={disabled}
            onChange={event => onAcknowledgedChange(event.target.checked)}
          />
          <span>{acknowledgeLabel}</span>
        </label>
      </div>
    </Modal>
  )
}
