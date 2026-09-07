/**
 * chamber archive manager dialog (design 24 §6, revision 2026-09; delete-all
 * retirement 2026 — see the VIEW MODES note below).
 *
 * Replaces the v1 server-row preview → window.confirm → purge-everything
 * flow: the dialog LISTS what is archived (title + project label per row,
 * sourced from ChamberServerAggregate.archivedSessions — metadata of the
 * source's own snapshot, no session read of its own) and offers
 *
 *   - per-row delete (one archived session's tree),
 *   - multi-select delete (checkbox rows + select all) — the ONLY whole-set
 *     path: no standalone delete-all button (2026 user decision). Deleting
 *     "everything" means explicitly ticking select-all first (and then
 *     confirming the counted 删除选中), so a purge can never cover rows the
 *     dialog could not list.
 *
 * Rows are GROUPED BY WORKSPACE (2026 grouping revision): each row carries
 * its workspace attribution from the App-side derive (authoritative registry
 * membership, cwd==path fallback, else the ungrouped bucket — see
 * derive.ts), and this dialog renders one collapsible group section per
 * workspace. Collapse is dialog-local view state only (default expanded,
 * never persisted, never mirrored to the nav's fold prefs); it hides rows but
 * never changes selection or counts — select-all and the counted 删除选中
 * cover collapsed groups unchanged. Group headers reuse the nav workspace
 * chrome (folder/chevron fold button + workspace accent, same classes/tokens
 * from this package's css module) plus a tri-state group checkbox
 * (indeterminate = part of the group selected).
 *
 * all through the host purge's optional `sessionIds` subset filter (the
 * host intersects the filter with the authoritative archived set, so the
 * dialog can never delete a non-archived session). Every destructive action
 * is confirm-gated (window.confirm, irreversible copy). Running subtrees
 * are skipped by the host and reported here; errors are never silent —
 * per-run status lines (role=status/alert) show completion / skips /
 * partial failures / domain-missing / busy / timeouts.
 *
 * VIEW MODES (review round 2026-09 — archive-set provenance tri-state;
 * 2026 delete-all retirement — deletion surfaces ONLY from the listed view):
 *   - list     rows landed AND the snapshot's archive set is authoritative
 *              (ChamberServerAggregate.archiveSetKnown === true): normal
 *              listing; an empty list is a true "nothing archived" fact.
 *   - degraded rows landed but the snapshot came from the unary fallback
 *              (archiveSetKnown false/missing): the host MAY hold archived
 *              sessions the client cannot classify (documented KNOWN
 *              DEGRADATION — archived rows even resurface in the nav list).
 *              The dialog never claims "nothing archived" and shows no list,
 *              so it offers NO destructive action here — whole-set purge
 *              (`purge(undefined)`) was retired with delete-all, and no
 *              listed row exists to select. When the source's mounted
 *              baseline lands, the bridge publish re-derives the dialog and
 *              the list (self-healing — no reopen needed).
 *   - pending  rows have not landed (aggregate not ok): a snapshot-fetch
 *              error is shown when the aggregate carries one, otherwise a
 *              loading line; no destructive action (same rationale — there
 *              is no trustworthy list to select from).
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
 * ui-git remove-confirm convention). The row list stays bespoke (native
 * checkboxes + title/project rows + per-row delete), and the workspace group
 * headers deliberately reuse the nav workspace chrome — the SAME module's
 * fold-toggle classes (folder glyph + chevron swap, accent var) and the same
 * workspaceAccentStyle helper — so a group stays visually bound to its
 * workspace row in the session list.
 *
 * Error/info text is zh-hardcoded inline (the sidebar's established inline
 * rowError precedent — design 24 §5 decision); buttons and confirms ride
 * the locale dictionaries.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronRightOutline14, IconFolderOpenOutline16, IconLoadingOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import cc from './sidebar-chamber.module.css'
import type { ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { chamberBridge } from '../shared/aggregate-store.ts'
import { groupArchivedRows, workspaceAccentStyle, type ArchivedSessionGroup } from '../shared/derive.ts'
import { getInstanceClient, purgeArchivedSessions } from '../shared/instance-api.ts'
import { getWorkspaceGitFlag, isSourceGitFlagsLoaded } from '../shared/workspace-git-flags.ts'
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

/** Identity-preserving subset prune (2026 review cleanup): returns `prev`
 *  unchanged when nothing dropped, so callers never re-render on no-ops. */
function pruneSet<T>(prev: ReadonlySet<T>, keep: ReadonlySet<T>): ReadonlySet<T> {
  let changed = false
  const next = new Set<T>()
  for (const value of prev) {
    if (keep.has(value)) next.add(value)
    else changed = true
  }
  return changed ? next : prev
}

/** Compact project label from a canonical cwd (last two path segments). */
function projectLabelOf(cwd: string | undefined): string {
  if (cwd === undefined) return ''
  const parts = cwd.split(/[\\/]/).filter(part => part !== '')
  return parts.slice(-2).join('/')
}

export function ArchiveManagerDialog({ server, t, onClose }: ArchiveManagerDialogProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  // Collapsed workspace groups (2026 grouping revision): dialog-local view
  // state only — never persisted, never mirrored to the nav's folded prefs.
  // Collapse hides rows, it never changes selection/counts (a select-all over
  // the list covers collapsed groups too).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
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

  // Grouped listing (2026 grouping revision): pure derive-side grouping
  // (groupArchivedRows — order/attribution live in derive.ts, node-tested).
  const groups = useMemo(() => (rows === undefined ? [] : groupArchivedRows(rows)), [rows])
  const groupById = useMemo(() => {
    const map = new Map<string, ArchivedSessionGroup>()
    for (const group of groups) map.set(group.key, group)
    return map
  }, [groups])

  // Prune the selection to surviving rows whenever the (refreshed) list
  // lands — a purge removes rows through the bridge publish. Accepted race
  // (review round 2026-09): between a refresh publish and this passive prune
  // a fast delete-selected can confirm over ids about to vanish — safe
  // direction only (the host intersects the filter with the authoritative
  // set, so fewer than confirmed get deleted, never more; the outcome note
  // reports actual counts).
  const rowSet = useMemo(() => new Set(rowIds), [rowIds])
  useEffect(() => {
    setSelected(prev => pruneSet(prev, rowSet))
  }, [rowSet])

  // Same passive prune for collapsed group keys: a group that vanished with
  // its rows (purge publish) must not stay collapsed in the state.
  const groupKeySet = useMemo(() => {
    const keys = new Set<string>()
    for (const group of groups) keys.add(group.key)
    return keys
  }, [groups])
  useEffect(() => {
    setCollapsed(prev => pruneSet(prev, groupKeySet))
  }, [groupKeySet])

  // Focus-loss guard (2026 a11y review): a purge publish can unmount the row
  // that held focus (per-row delete → refresh → the row disappears) and the
  // browser then drops focus to <body>. While the dialog stays mounted, land
  // focus back on the panel — a loss guard only, not a focus trap.
  useEffect(() => {
    if (rows === undefined) return
    if (document.activeElement !== document.body) return
    panelRef.current?.focus()
  }, [rows])

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

  /** Select / deselect every row of one workspace group (the group header
   *  checkbox; a collapsed group keeps its membership — selection is list
   *  state, not view state). */
  const toggleGroup = (key: string): void => {
    if (busy) return
    const group = groupById.get(key)
    if (group === undefined) return
    const ids = group.rows.map(row => row.sessionId)
    if (ids.length === 0) return
    setSelected(prev => {
      const allSelected = ids.every(id => prev.has(id))
      const next = new Set(prev)
      if (allSelected) {
        for (const id of ids) next.delete(id)
      } else {
        for (const id of ids) next.add(id)
      }
      return next
    })
  }

  const toggleGroupFold = (key: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Purge exactly the listed session ids (host intersects the filter with
   *  the authoritative archived set — never a non-archived target). No
   *  whole-set `undefined` path reaches this call: with delete-all retired,
   *  a purge always stems from an explicit per-row / select-all selection. */
  const runPurge = (sessionIds: readonly string[]): void => {
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

  const titleText = (title: string | undefined): string => {
    if (title === undefined || title === '') return t('archive.manager.rowUntitled')
    return title
  }

  const countKey: SidebarKey = rowIds.length === 1 ? 'archive.manager.rowCount.one' : 'archive.manager.rowCount.other'
  const selectedCountKey: SidebarKey = selected.size === 1
    ? 'archive.manager.deleteSelected.one'
    : 'archive.manager.deleteSelected.other'

  // View-mode derivation (module doc VIEW MODES). With delete-all retired
  // (2026 user decision) the destructive surface is EXACTLY the listed view:
  // rows only render when the archive set is authoritative and non-empty, so
  // a selection (and therefore a purge) can only ever cover listed rows.
  // Degraded and pending/pull-error views carry no destructive action — an
  // empty authoritative list is the true "nothing archived" fact.
  const landed = rows !== undefined
  const degraded = landed && !archiveSetKnown
  const pullError = !landed && server.aggregateError !== undefined
  const listVisible = landed && !degraded && rows.length > 0

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
                // Partial selection renders the master checkbox as
                // indeterminate (group-header tri-state parity, 2026 review);
                // it still selects everything on the next toggle.
                ref={(element) => {
                  if (element !== null) {
                    element.indeterminate = selected.size > 0 && selected.size < rows.length
                  }
                }}
                onChange={toggleAll}
              />
              <span className={cc.archiveManagerRowTitleSelectAll}>{t('archive.manager.selectAllAria')}</span>
              <span className={cc.archiveManagerRowPath}>{t(countKey, { count: rows.length })}</span>
            </div>
            {groups.map(group => {
              const isGroupCollapsed = collapsed.has(group.key)
              const realWorkspace = group.workspace !== undefined
              // Nav parity accent (same formula/seed the sidebar workspace
              // rows use, incl. the "no accent before git flags load" gate —
              // the group stays visually bound to its workspace row in the
              // session list); undefined for the ungrouped bucket.
              const accent = realWorkspace && isSourceGitFlagsLoaded(server.id)
                ? workspaceAccentStyle(server.id, group.key, getWorkspaceGitFlag(server.id, group.key))
                : undefined
              const groupSelected = group.rows.length > 0 && group.rows.every(row => selected.has(row.sessionId))
              const groupPartial = !groupSelected && group.rows.some(row => selected.has(row.sessionId))
              const groupTitle = realWorkspace ? group.title : t('list.ungrouped')
              const groupCountKey: SidebarKey = group.rows.length === 1
                ? 'archive.manager.rowCount.one'
                : 'archive.manager.rowCount.other'
              return (
                <div key={group.key} className={cc.archiveManagerGroup}>
                  <div
                    className={cc.archiveManagerGroupHeader}
                    style={accent}
                  >
                    <input
                      type="checkbox"
                      className={cc.archiveManagerCheck}
                      checked={groupSelected}
                      aria-label={t('archive.manager.groupSelectAria', { title: groupTitle })}
                      // Explicit mixed state: HTML-AAM does not guarantee that
                      // native `indeterminate` maps to aria-checked="mixed"
                      // (Blink/Gecko expose it; other engines may not), and
                      // the tri-state is the group's key status — say it
                      // aloud. Only rendered while partial so the native
                      // checkedness stays the aria authority otherwise.
                      {...(groupPartial ? { 'aria-checked': 'mixed' as const } : {})}
                      disabled={busy}
                      // Half-checked group = some (not all) members selected;
                      // a native checkbox cannot express tri-state without
                      // imperative indeterminate (ref callback — no effect).
                      ref={(element) => {
                        if (element !== null) element.indeterminate = groupPartial
                      }}
                      onChange={() => { toggleGroup(group.key) }}
                    />
                    <button
                      type="button"
                      className={clsx(
                        cc.foldToggle,
                        isGroupCollapsed && cc.foldToggleFolded,
                        realWorkspace && cc.foldToggleFolder,
                      )}
                      aria-expanded={!isGroupCollapsed}
                      aria-label={isGroupCollapsed ? t('workspace.expand') : t('workspace.collapse')}
                      onClick={() => { toggleGroupFold(group.key) }}
                    >
                      <IconChevronRightOutline14 size={14} className={cc.foldChevron} />
                      {realWorkspace && <IconFolderOpenOutline16 size={14} className={cc.foldFolder} />}
                    </button>
                    <span className={cc.archiveManagerGroupTitle} title={groupTitle}>
                      {groupTitle}
                    </span>
                    <span className={cc.archiveManagerRowPath}>{t(groupCountKey, { count: group.rows.length })}</span>
                  </div>
                  {!isGroupCollapsed && group.rows.map(row => (
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
              )
            })}
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
