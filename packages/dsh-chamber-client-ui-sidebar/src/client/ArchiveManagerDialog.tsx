/**
 * chamber archive manager dialog (design 24 §6, revision 2026-09).
 *
 * Replaces the v1 server-row preview → window.confirm → purge-everything
 * flow: the dialog LISTS what is archived (title + project label per row,
 * sourced from ChamberServerAggregate.archivedSessions — metadata of the
 * source's own snapshot, no session read of its own) and offers
 *
 *   - per-row delete (one archived session's tree),
 *   - multi-select delete (checkbox rows + select all),
 *   - delete all (whole archived set — the legacy purge),
 *
 * all through the host purge's optional `sessionIds` subset filter (the
 * host intersects the filter with the authoritative archived set, so the
 * dialog can never delete a non-archived session). Every destructive action
 * is confirm-gated (window.confirm, irreversible copy). Running subtrees
 * are skipped by the host and reported here; errors are never silent —
 * per-run status lines (role=status/alert) show completion / skips /
 * partial failures / domain-missing / busy / timeouts.
 *
 * VIEW MODES (review round 2026-09 — archive-set provenance tri-state):
 *   - list     rows landed AND the snapshot's archive set is authoritative
 *              (ChamberServerAggregate.archiveSetKnown === true): normal
 *              listing; an empty list is a true "nothing archived" fact.
 *   - degraded rows landed but the snapshot came from the unary fallback
 *              (archiveSetKnown false/missing): the host MAY hold archived
 *              sessions the client cannot classify (documented KNOWN
 *              DEGRADATION — archived rows even resurface in the nav list).
 *              The dialog never claims "nothing archived"; delete-all stays
 *              available (purge(undefined) is rows-independent) with a
 *              count-free confirm.
 *   - pending  rows have not landed (aggregate not ok): a snapshot-fetch
 *              error is shown when the aggregate carries one, otherwise a
 *              loading line; delete-all is only available in the error case
 *              (the host domain is independent of the list store).
 *
 * Single-flight per dialog (one run at a time; controls disabled while a
 * run is in flight). Closing is allowed at ANY time (Esc / X / mask) — an
 * in-flight purge keeps running host-side (client timeout ≠ host stop) and
 * the UNCONDITIONAL requestRefresh still fires, so a closed dialog never
 * loses the deletion itself, only its outcome note. The rows list re-derives
 * from the server prop on every chamberBridge publish: after a successful
 * purge the App-side refresh drops the deleted rows from the aggregate and
 * this dialog's selection is pruned to surviving rows.
 *
 * CHROME (2026 style pass): the dialog is the OFFICIAL primitives Modal
 * (mask + r24 card + header close — the same shell RemoveWorktreeDialog /
 * PluginDialog render), so mask/Escape/close-button behaviour and the
 * card/radius/colour tokens match every other dialog in the app. Footer
 * actions are the official Button atom (outline + destructive ink, the
 * ui-git remove-confirm convention); only the row list stays bespoke
 * (native checkboxes + title/project rows + per-row delete).
 *
 * Error/info text is zh-hardcoded inline (the sidebar's established inline
 * rowError precedent — design 24 §5 decision); buttons and confirms ride
 * the locale dictionaries.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconLoadingOutline16, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import cc from './sidebar-chamber.module.css'
import type { ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { chamberBridge } from '../shared/aggregate-store.ts'
import { getInstanceClient, purgeArchivedSessions } from '../shared/instance-api.ts'
import type { SidebarKey } from './locales.ts'

/** The dialog's `t`: the shell's translate (sidebar namespace keys). */
export type ArchiveManagerTranslate = (key: SidebarKey, params?: Record<string, string | number>) => string

export interface ArchiveManagerDialogProps {
  /** The manager's source; null = the shell is closing (render nothing). */
  server: ChamberServerAggregate | null
  /** Shell translate (sidebar namespace). */
  t: ArchiveManagerTranslate
  onClose: () => void
}

/** Per-run outcome note kinds (zh-hardcoded copy, §5 discipline). */
type NoteKind = 'info' | 'error'

/** Compact project label from a canonical cwd (last two path segments). */
function projectLabelOf(cwd: string | undefined): string {
  if (cwd === undefined) return ''
  const parts = cwd.split(/[\\/]/).filter(part => part !== '')
  return parts.slice(-2).join('/')
}

export function ArchiveManagerDialog({ server, t, onClose }: ArchiveManagerDialogProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: NoteKind; text: string } | null>(null)
  const mountedRef = useRef(true)
  // The list panel receives initial focus (tabIndex -1) so the keyboard lands
  // inside the dialog on open; the official Modal owns Esc/mask/close-button
  // behaviour (no bespoke focus trap — the Modal family does not trap).
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Mounted guard: wire continuations must never write state of a closed
  // dialog (the shell unmounts us on close/source-loss).
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // The panel receives initial focus (tabIndex -1) so the keyboard lands
  // inside the dialog on open.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  // ---- all hooks above the null-server early return (stable hook order) ----
  const rows = server?.archivedSessions
  const rowIds = useMemo(() => {
    const ids: string[] = []
    if (rows !== undefined) for (const row of rows) ids.push(row.sessionId)
    return ids
  }, [rows])

  // Prune the selection to surviving rows whenever the (refreshed) list
  // lands — a purge removes rows through the bridge publish. Accepted race
  // (review round 2026-09): between a refresh publish and this passive prune
  // a fast delete-selected can confirm over ids about to vanish — safe
  // direction only (the host intersects the filter with the authoritative
  // set, so fewer than confirmed get deleted, never more; the outcome note
  // reports actual counts).
  const rowSet = useMemo(() => new Set(rowIds), [rowIds])
  useEffect(() => {
    setSelected(prev => {
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (rowSet.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [rowSet])

  if (server === null) return null

  /** True only when the snapshot's archive set is authoritative (mounted
   *  baseline); degraded sources (unary fallback) and not-yet-landed
   *  aggregates are unknown — see the module doc's VIEW MODES. */
  const archiveSetKnown = server.archiveSetKnown === true

  const toggle = (id: string): void => {
    if (busy) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = (): void => {
    if (busy) return
    setSelected(prev => prev.size === rowIds.length && rowIds.length > 0 ? new Set() : new Set(rowIds))
  }

  const runPurge = (sessionIds: readonly string[] | undefined): void => {
    if (busy) return
    const client = getInstanceClient(server.id)
    setBusy(true)
    setNote(null)
    void (async () => {
      try {
        const result = await purgeArchivedSessions(client, sessionIds)
        // UNCONDITIONAL refresh (v1 F9 parity): even if this dialog already
        // unmounted, the host purge may have completed and chamberBridge's
        // App-side consumers are global/generation-fenced.
        chamberBridge.requestRefresh(server.id)
        if (!mountedRef.current) return
        const lines: string[] = []
        if (result.deletedSessions > 0 || result.deletedSubagents > 0) {
          lines.push(`清理完成：删除 ${result.deletedSessions} 个会话 / ${result.deletedSubagents} 个子代理内容。`)
        }
        if (result.skippedRunning > 0) {
          // Archived-but-running rows delete as post-hoc skips: the host is
          // the running authority and reports them here (review round
          // 2026-09 decision — no per-row running pre-marking client-side).
          lines.push(`已跳过 ${result.skippedRunning} 项运行中的会话（未删除）。`)
        }
        if (result.truncated === true && result.errors.length >= 1000) {
          lines.push('失败明细过多，仅显示前 1000 项。')
        }
        if (result.errors.length > 0) {
          lines.push(`${result.errors.length} 项失败，可重试（重复执行安全）。`)
          const samples = result.errors.slice(0, 3).map(error => error.message)
          for (const sample of samples) lines.push(`· ${sample}`)
          setNote({ kind: 'error', text: lines.join('\n') })
          return
        }
        if (lines.length === 0) {
          // Another shell may have purged between the list and this run — an
          // empty outcome must never be silent (v1 E-n2 parity).
          lines.push('没有可删除的已归档会话。')
        }
        setNote({ kind: 'info', text: lines.join('\n') })
        // The refreshed aggregate (requestRefresh above) prunes the rows;
        // the selection effect drops ids that no longer exist.
        setSelected(new Set())
      } catch (error) {
        if (!mountedRef.current) return
        const message = error instanceof Error ? error.message : String(error)
        const friendly = message.startsWith('busy:')
          ? '该实例正在执行另一处清理，请稍后重试。'
          : message
        setNote({ kind: 'error', text: friendly })
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    })()
  }

  const deleteSingle = (sessionId: string, title: string): void => {
    if (busy) return
    const confirmTitle = title === '' ? t('archive.manager.rowUntitled') : title
    if (!window.confirm(t('archive.manager.confirmSingle', { title: confirmTitle }))) return
    runPurge([sessionId])
  }

  const deleteSelected = (): void => {
    if (busy || selected.size === 0) return
    const count = selected.size
    const plural = count === 1 ? 'one' : 'other'
    if (!window.confirm(t(`archive.manager.confirmSelected.${plural}` as SidebarKey, { count }))) return
    runPurge([...selected])
  }

  const deleteAll = (): void => {
    if (busy) return
    // Count-free confirm: the host deletes the WHOLE authoritative archived
    // set — which can exceed the current list (subagent-origin members are
    // never listed; rows may be stale), so the copy never promises a count.
    if (!window.confirm(t('archive.manager.confirmAll'))) return
    runPurge(undefined)
  }

  const titleText = (title: string | undefined): string => {
    if (title === undefined || title === '') return t('archive.manager.rowUntitled')
    return title
  }

  const countKey: SidebarKey = rowIds.length === 1 ? 'archive.manager.rowCount.one' : 'archive.manager.rowCount.other'
  const selectedCountKey: SidebarKey = selected.size === 1
    ? 'archive.manager.deleteSelected.one'
    : 'archive.manager.deleteSelected.other'

  // View-mode derivation (module doc VIEW MODES).
  const landed = rows !== undefined
  const degraded = landed && !archiveSetKnown
  const pullError = !landed && server.aggregateError !== undefined
  const listVisible = landed && !degraded && rows.length > 0
  // delete-all is available whenever the host is reachable and the purge is
  // meaningful: on degraded/pull-error views the list cannot be trusted but
  // purge(undefined) hits the authoritative set; on an authoritative empty
  // list there is nothing to delete (v1 parity — no confirm on empty).
  const deleteAllDisabled = busy
    || (!landed && !pullError)
    || (archiveSetKnown && rows !== undefined && rows.length === 0)

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t('archive.manager.title')} · ${server.label}`}
      closeLabel={t('action.cancel')}
      className={cc.archiveManagerDialog}
      footer={(
        <div className={cc.archiveManagerFootBar}>
          <span className={cc.archiveManagerFootStatus} role={busy ? 'status' : undefined}>
            {busy && (
              <>
                <IconLoadingOutline16 className={cc.statusSpinner} size={13} />
                正在删除…
              </>
            )}
          </span>
          {listVisible && (
            <Button
              variant="outline"
              className={cc.archiveManagerDanger}
              disabled={busy || selected.size === 0}
              onClick={deleteSelected}
            >
              {t(selectedCountKey, { count: selected.size })}
            </Button>
          )}
          <Button
            variant="outline"
            className={cc.archiveManagerDanger}
            disabled={deleteAllDisabled}
            onClick={deleteAll}
          >
            {t('archive.manager.deleteAll')}
          </Button>
        </div>
      )}
    >
      <div ref={panelRef} tabIndex={-1} className={cc.archiveManagerPanel}>
        {!landed && pullError ? (
          <div className={cc.archiveManagerNoteRow} role="alert">
            {t('archive.manager.listUnavailable')}
            {server.aggregateError !== '' ? ` ${server.aggregateError}` : ''}
          </div>
        ) : !landed ? (
          <div className={cc.archiveManagerNoteRow} role="status">{t('archive.manager.loading')}</div>
        ) : degraded ? (
          <div className={cc.archiveManagerNoteRow} role="status">{t('archive.manager.degraded')}</div>
        ) : rows.length === 0 ? (
          <div className={cc.archiveManagerEmpty} role="status">{t('archive.manager.empty')}</div>
        ) : (
          <div className={cc.archiveManagerList}>
            <div className={cc.archiveManagerRow}>
              <input
                type="checkbox"
                className={cc.archiveManagerCheck}
                checked={selected.size === rows.length}
                aria-label={t('archive.manager.selectAllAria')}
                disabled={busy}
                onChange={toggleAll}
              />
              <span className={cc.archiveManagerRowTitleSelectAll}>{t('archive.manager.selectAllAria')}</span>
              <span className={cc.archiveManagerRowPath}>{t(countKey, { count: rows.length })}</span>
            </div>
            {rows.map(row => (
              <div key={row.sessionId} className={cc.archiveManagerRow}>
                <input
                  type="checkbox"
                  className={cc.archiveManagerCheck}
                  checked={selected.has(row.sessionId)}
                  aria-label={titleText(row.title)}
                  disabled={busy}
                  onChange={() => { toggle(row.sessionId) }}
                />
                <span
                  className={cc.archiveManagerRowTitle}
                  title={titleText(row.title)}
                >
                  {titleText(row.title)}
                </span>
                {projectLabelOf(row.cwd) !== '' && (
                  <span className={cc.archiveManagerRowPath} title={row.cwd}>
                    {projectLabelOf(row.cwd)}
                  </span>
                )}
                <button
                  type="button"
                  className={cc.archiveManagerRowDelete}
                  aria-label={t('archive.manager.rowDeleteAria', { title: titleText(row.title) })}
                  title={t('archive.manager.rowDeleteAria', { title: titleText(row.title) })}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    deleteSingle(row.sessionId, row.title ?? '')
                  }}
                >
                  <IconTrashOutline16 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {note !== null && (
          <span
            className={note.kind === 'error' ? cc.archiveManagerError : cc.archiveManagerNoteRow}
            role={note.kind === 'error' ? 'alert' : 'status'}
            style={{ whiteSpace: 'pre-line' }}
          >
            {note.text}
          </span>
        )}
      </div>
    </Modal>
  )
}
