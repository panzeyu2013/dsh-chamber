/**
 * 归档确认对话框：归档唯一会先问一次的场合——宿主因该会话仍有进行中的工作而拒绝。
 * 逐项对照官方 SessionArchiveConfirmDialog（标题/描述句/活动清单/pending 行/框内失败/
 * 取消 + 危险确认）：chamber 拥有 Modal 与打开它的行菜单，停止由宿主完成。
 */
import type { RefObject } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { archiveActivityLines, type SessionArchiveConfirmRequest } from './session-archive-confirm.ts'
import type { SidebarKey } from './locales.ts'
import cc from './sidebar-chamber.module.css'

export type SessionArchiveTranslate = (key: SidebarKey, params?: Record<string, string | number>) => string

export interface SessionArchiveConfirmDialogProps {
  request: SessionArchiveConfirmRequest
  t: SessionArchiveTranslate
  pending: boolean
  error: string | null
  bodyRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  onConfirm: () => void
}

/** One family per row; the names' separator is the dictionary's, never a hard-coded comma. */
export function SessionArchiveConfirmDialog({
  request, t, pending, error, bodyRef, onClose, onConfirm,
}: SessionArchiveConfirmDialogProps) {
  const lines = archiveActivityLines(request.activity, names => names.join(t('archive.confirm.listSeparator')))
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('action.cancel')}
      title={t('archive.confirm.title')}
      description={t('archive.confirm.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="outline"
            className={cc.archiveManagerDanger}
            disabled={pending}
            onClick={onConfirm}
          >
            {t('archive.confirm.action')}
          </Button>
        </>
      )}
    >
      <div ref={bodyRef} tabIndex={-1}>
        <ul className={cc.archiveActivity} aria-label={t('archive.confirm.activity')}>
          {lines.map((line, index) => (
            <li key={request.sessionId + '-' + String(index)}>{t(line.key, line.params)}</li>
          ))}
        </ul>
        {pending && <div className={cc.deleteStatus} role="status">{t('archive.confirm.pending')}</div>}
        {/* 失败留在对话框内（同上：行可能已在拒绝之后卸载，行级 surface 不一定还在）。 */}
        {error !== null && <div className={cc.deleteError} role="alert">{error}</div>}
      </div>
    </Modal>
  )
}
