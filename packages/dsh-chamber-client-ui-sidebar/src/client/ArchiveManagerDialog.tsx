/**
 * Chamber archive manager dialog: lists the source snapshot's archived sessions
 * grouped by workspace (collapse is dialog-local view state, never selection or
 * counts) and deletes per row or as an explicit counted multi-selection — no
 * standalone delete-all, so a purge can never cover rows the dialog could not list.
 * Deletion surfaces ONLY from the listed view (rows landed AND archiveSetKnown):
 * degraded and pending/pull-error views offer no destructive action, since a
 * non-authoritative set may hide archived rows. Destructive actions are
 * confirm-gated by an in-dialog two-stage confirm (never a native OS dialog or a
 * second Modal layer) and single-flight; closing drops an armed confirm, an
 * in-flight purge keeps running, and resident rows stay listed until restart.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconChevronRightOutline14,
  IconFolderOpenOutline16,
  IconLoadingOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import cc from './sidebar-chamber.module.css'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { groupArchivedRows, workspaceAccentStyle, type ArchivedSessionGroup } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { getInstanceClient } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { archivePurgeNote, purgeRemovedContent, runArchivePurge } from './archive-purge.ts'
import { getWorkspaceGitFlag, isSourceGitFlagsLoaded } from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'
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

/** Per-run outcome note kinds. */
type NoteKind = 'info' | 'error'

/** Identity-preserving prune: returns `prev` when nothing dropped, so callers
 *  never re-render on no-ops. */
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
  // Collapsed workspace groups: dialog-local view state only — never persisted,
  // never mirrored to nav prefs. Collapse hides rows but changes no counts
  // (select-all covers collapsed groups too).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: NoteKind; text: string } | null>(null)
  // Rows whose content this dialog deleted while the session stayed resident in
  // the instance process: the host keeps their archived membership, so they stay
  // listed (and hidden in the workspace) until that instance restarts. Purely
  // informational; accumulated across runs and pruned with the rows.
  const [residentPurged, setResidentPurged] = useState<ReadonlySet<string>>(() => new Set())
  const mountedRef = useRef(true)
  // The list panel receives initial focus (tabIndex -1); the official Modal owns
  // Esc/mask/close-button behaviour (no bespoke focus trap — it does not trap).
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Mounted guard: wire continuations must never write state of a closed
  // dialog (the shell unmounts us on close/source-loss).
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  // All hooks must stay above the null-server early return (stable hook order).
  const rows = server?.archivedSessions
  const rowIds = useMemo(() => {
    const ids: string[] = []
    if (rows !== undefined) for (const row of rows) ids.push(row.sessionId)
    return ids
  }, [rows])

  // Grouped listing: pure derive-side grouping (order/attribution live in derive.ts).
  const groups = useMemo(() => (rows === undefined ? [] : groupArchivedRows(rows)), [rows])
  const groupById = useMemo(() => {
    const map = new Map<string, ArchivedSessionGroup>()
    for (const group of groups) map.set(group.key, group)
    return map
  }, [groups])

  // Prune the selection to surviving rows whenever the refreshed list lands.
  // Accepted race: a fast delete-selected can confirm over ids about to vanish —
  // safe direction only (the host intersects the filter with the authoritative
  // set, so fewer than confirmed get deleted, never more).
  const rowSet = useMemo(() => new Set(rowIds), [rowIds])
  useEffect(() => {
    setSelected(prev => pruneSet(prev, rowSet))
    // Residency labels ride the same prune: a labeled row that left the list
    // (instance restarted, or another shell's convergence) drops its label.
    setResidentPurged(prev => pruneSet(prev, rowSet))
  }, [rowSet])

  // Same passive prune for collapsed group keys: a group that vanished must not stay collapsed.
  const groupKeySet = useMemo(() => {
    const keys = new Set<string>()
    for (const group of groups) keys.add(group.key)
    return keys
  }, [groups])
  useEffect(() => {
    setCollapsed(prev => pruneSet(prev, groupKeySet))
  }, [groupKeySet])

  // Focus-loss guard: a purge publish can unmount the row that held focus, and
  // the accept path unmounts the confirm bar that held it; the browser then
  // drops focus to <body>. While the dialog stays mounted, land it back on the
  // panel — a loss guard only, not a trap. Deps [rows, busy] cover the
  // refresh-prune and accept paths; the guard does NOT early-return on
  // rows === undefined (an accept over a vanished view still needs the landing).
  // Cancel/Esc refocus themselves in disarmConfirm.
  useEffect(() => {
    if (document.activeElement !== document.body) return
    panelRef.current?.focus()
  }, [rows, busy])

  // ---- In-dialog two-stage confirm ----
  // The confirm is a MODE of this dialog, never a second layer: rows freeze
  // (inputLocked) and a risk bar shows the counted copy with 取消/确认删除.
  // `title` non-null = single-row subject (per-row trash); null = the counted
  // selected set. The id list is frozen at arming, so later selection changes
  // cannot alter what the counted copy promised. INVARIANT: title !== null ⇔
  // ids.length === 1 — the two arming sites construct it so.
  const [confirming, setConfirming] = useState<{ ids: readonly string[]; title: string | null } | null>(null)
  // The control that armed the confirm: 取消/Esc returns focus to it (deferred);
  // accept drops it — the busy/focus-loss guards take over.
  const confirmOpenerRef = useRef<HTMLElement | null>(null)
  const confirmBarRef = useRef<HTMLDivElement | null>(null)

  /** Disarm the confirm stage. Esc/取消 never close the dialog — they only
   *  disarm, with `refocus` returning focus to the arming control (fallback:
   *  the panel). The refocus is DEFERRED past the commit (requestAnimationFrame)
   *  because a `disabled` opener cannot take focus in the same tick; the frame
   *  re-checks connectivity and falls back to the panel. */
  const disarmConfirm = useCallback((refocus: boolean): void => {
    const opener = confirmOpenerRef.current
    confirmOpenerRef.current = null
    setConfirming(null)
    if (refocus) {
      requestAnimationFrame(() => {
        if (opener !== null && opener.isConnected) opener.focus()
        else panelRef.current?.focus()
      })
    }
  }, [])

  // Escape while armed must disarm, NOT close: the official Modal listens in the
  // BUBBLE phase on document, so this CAPTURE-phase listener runs first and stops
  // propagation, and the modal's listener never fires. Once disarmed, Escape
  // closes the dialog as usual (no capture listener).
  useEffect(() => {
    if (confirming === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      disarmConfirm(true)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [confirming, disarmConfirm])

  // Keyboard lands on the SAFE default (取消 is the bar's first button); the risk
  // message is announced by its own role="alert" span.
  useEffect(() => {
    if (confirming === null) return
    confirmBarRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [confirming])

  // `server: null` while still mounted: an armed confirm must not survive
  // invisibly and resurface over a NEW list with the OLD frozen ids. Disarm
  // without refocus — the caller is closing.
  useEffect(() => {
    if (server === null && confirming !== null) disarmConfirm(false)
  }, [server, confirming, disarmConfirm])

  if (server === null) return null

  /** True only when the snapshot's archive set is authoritative (mounted
   *  baseline); degraded and not-yet-landed aggregates are unknown. */
  const archiveSetKnown = server.archiveSetKnown === true

  const toggle = (id: string): void => {
    if (busy || confirming !== null) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = (): void => {
    if (busy || confirming !== null) return
    setSelected(prev => prev.size === rowIds.length && rowIds.length > 0 ? new Set() : new Set(rowIds))
  }

  /** Select/deselect every row of one workspace group; a collapsed group keeps
   *  its membership — selection is list state, not view state. */
  const toggleGroup = (key: string): void => {
    if (busy || confirming !== null) return
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

  /** Purge exactly the listed session ids; the host intersects the filter with
   *  the authoritative archived set, so a non-archived target is impossible.
   *  A purge always stems from an explicit per-row / select-all selection — no
   *  whole-set `undefined` path reaches this call.
   *  The run STOPS the selected sessions' running turns over `session/cancel`,
   *  then purges with `force: true` so merely LOADED (idle/attached) content is
   *  deleted too — a session waiting on a question or approval must stay
   *  deletable. The host refuses a RUNNING member (fail-closed), so the stop pass
   *  is an accelerator, never the safety boundary. The live viewed session is
   *  passed as the PROTECTED id: its tree is skipped and reported. */
  const runPurge = (sessionIds: readonly string[]): void => {
    if (busy) return
    // PROTECTION, NOT PERMISSION: the run is never refused for an unknown
    // current session. The LIVE current session is handed over as
    // `protectSessionIds`, so its tree is skipped; when the client cannot name
    // one the run still proceeds (the host's running guard and the cancel pass
    // are the safety boundary) and the hint line above states that fact.
    const client = getInstanceClient(server.id)
    setBusy(true)
    setNote(null)
    void (async () => {
      try {
        const run = await runArchivePurge(client, sessionIds, liveViewedSessionId())
        // UNCONDITIONAL refresh: even if this dialog already unmounted, the
        // host purge may have completed and App-side consumers are global.
        chamberBridge.requestRefresh(server.id)
        // Also ask this source's MOUNTED ctx to re-run its official session-list
        // refresh: the host purge is invisible to official client summaries, so
        // without it the deleted rows linger there and resurface in the sidebar.
        chamberBridge.requestSessionListRefresh(server.id)
        if (!mountedRef.current) return
        // Every outcome line (stop/skip/delete counts, failures) is composed by
        // the pure `archivePurgeNote` as dictionary keys + params, rendered
        // here through `t()`.
        const outcome = archivePurgeNote(run)
        setNote({
          kind: outcome.kind,
          text: outcome.lines.map(line => t(line.key, line.params)).join('\n'),
        })
        // Label the rows whose content this run deleted while the session stayed
        // resident: the host keeps their membership, so they legitimately remain
        // listed until that instance restarts.
        const retained = run.purge.residentRetainedRoots
        if (retained !== undefined && retained.length > 0) {
          setResidentPurged(prev => new Set([...prev, ...retained]))
        }
        if (outcome.kind === 'info' && purgeRemovedContent(run)) {
          // The refreshed aggregate prunes the rows; only a run that REMOVED
          // something clears the selection, so a protected/skipped-only run
          // leaves every row in place and the retry stays one click away.
          setSelected(new Set())
        }
      } catch (error) {
        // A settle of ANY kind may still mean host-side deletions (client
        // timeout ≠ host stop; another shell's purge raced this one), so request
        // the official session-list refresh too. Fired before the mounted guard:
        // a closed dialog must not lose the convergence request.
        chamberBridge.requestSessionListRefresh(server.id)
        if (!mountedRef.current) return
        const message = error instanceof Error ? error.message : String(error)
        // `busy:` 分支的说明文案进字典（产品可见文案一律在类型化字典里）；线协议
        // 原文按政策原样透出，不翻译。
        const friendly = message.startsWith('busy:')
          ? t('archive.manager.busyOther')
          : message
        setNote({ kind: 'error', text: friendly })
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    })()
  }

  /** Arm the two-stage confirm for exactly the given rows (`title` = single-row
   *  subject; null = the counted selected set), remembering the arming control
   *  so 取消/Esc can return focus to it. */
  const requestDelete = (opener: HTMLElement | null, ids: readonly string[], title: string | null): void => {
    if (busy || confirming !== null || ids.length === 0) return
    confirmOpenerRef.current = opener
    setConfirming({ ids, title })
  }

  /** Per-row trash: arm the confirm for one session (resolved title as subject). */
  const deleteSingle = (opener: HTMLElement | null, sessionId: string, title: string): void => {
    requestDelete(opener, [sessionId], title === '' ? t('archive.manager.rowUntitled') : title)
  }

  /** Footer 删除选中: arm the confirm over the current selection — never a
   *  whole-set `undefined` purge. */
  const deleteSelected = (opener: HTMLElement | null): void => {
    if (selected.size === 0) return
    requestDelete(opener, [...selected], null)
  }

  /** Accept: disarm without refocus (busy flip + focus-loss guard take over),
   *  then purge the frozen id list. */
  const acceptConfirm = (): void => {
    const pending = confirming
    if (pending === null || busy) return
    disarmConfirm(false)
    runPurge(pending.ids)
  }

  const titleText = (title: string | undefined): string => {
    if (title === undefined || title === '') return t('archive.manager.rowUntitled')
    return title
  }

  /** Accessible name of one row's checkbox: the resolved title plus the
   *  resident-retention state when this dialog deleted that row's content (the
   *  tag span alone is only announced in browse mode). */
  const rowAriaLabel = (row: { readonly sessionId: string; readonly title?: string }): string =>
    residentPurged.has(row.sessionId)
      ? t('archive.manager.rowAriaResidentPurged', { title: titleText(row.title) })
      : titleText(row.title)

  const countKey: SidebarKey = rowIds.length === 1 ? 'archive.manager.rowCount.one' : 'archive.manager.rowCount.other'
  const selectedCountKey: SidebarKey = selected.size === 1
    ? 'archive.manager.deleteSelected.one'
    : 'archive.manager.deleteSelected.other'

  // View-mode derivation: the destructive surface is EXACTLY the listed view —
  // rows only render when the archive set is authoritative and non-empty, so a
  // selection (and therefore a purge) can only ever cover listed rows. An empty
  // authoritative list is the true "nothing archived" fact.
  const landed = rows !== undefined
  const degraded = landed && !archiveSetKnown
  const pullError = !landed && server.aggregateError !== undefined
  const listVisible = landed && !degraded && rows.length > 0

  /**
   * The PROTECTION id, resolved at REQUEST time: the vendor's `current` can move
   * between the last publish and the click, so ask the bridge for the live
   * projection. The prop is the fallback for a source that vanished from the
   * snapshot — a retired source displays nothing, so protecting nothing is fine.
   */
  const liveViewedSessionId = (): string | undefined => {
    const fresh = chamberBridge.getServers().find(entry => entry.id === server.id)
    return (fresh ?? server).runtime?.current
  }

  // While a confirm is ARMED the whole list freezes (inputLocked = busy OR
  // armed), so the selection cannot move under the armed promise and the counted
  // copy can never go stale.
  const inputLocked = busy || confirming !== null
  // NO PRE-CLICK GATE: the delete controls are enabled whenever the list is
  // actionable and no run is in flight. An unknown current session is a
  // PROTECTION degradation, never a capability loss — the host skips RUNNING
  // trees and protects whatever id the client can name; the hint line below
  // states it honestly instead of greying the controls out.
  const unprotected = server.runtime?.current === undefined
  // The armed confirm's message: single-row subject (title) or counted set.
  const armedCountKey: SidebarKey = (confirming?.ids.length ?? 0) === 1
    ? 'archive.manager.confirmSelected.one'
    : 'archive.manager.confirmSelected.other'

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
                {t('archive.manager.deleting')}
              </>
            )}
          </span>
          {listVisible && confirming === null && (
            <Button
              variant="outline"
              className={cc.archiveManagerDanger}
              disabled={inputLocked || selected.size === 0}
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => { deleteSelected(event.currentTarget) }}
            >
              {t(selectedCountKey, { count: selected.size })}
            </Button>
          )}
        </div>
      )}
    >
      <div ref={panelRef} tabIndex={-1} className={cc.archiveManagerPanel}>
        {confirming !== null && (
          <div ref={confirmBarRef} className={cc.archiveManagerConfirmBar}>
            <IconWarningOutline16 size={16} className={cc.archiveManagerConfirmIcon} />
            {/* role="alert" lives on the TEXT span, not the bar container: the
                bar's first button takes focus in the same commit, and an alert
                on the container races that move (AT may hear only 取消 or only
                the risk copy). The buttons are reached by Tab as usual. */}
            <span role="alert" className={cc.archiveManagerConfirmText}>
              {confirming.title !== null
                ? t('archive.manager.confirmSingle', { title: confirming.title })
                : t(armedCountKey, { count: confirming.ids.length })}
            </span>
            <Button variant="outline" size="sm" onClick={() => { disarmConfirm(true) }}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={cc.archiveManagerDanger}
              onClick={acceptConfirm}
            >
              {t('archive.manager.confirmDelete')}
            </Button>
          </div>
        )}
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
            {unprotected && (
              <div className={cc.archiveManagerNoteRow} role="status">{t('archive.manager.unprotected')}</div>
            )}
            <div className={cc.archiveManagerRow}>
              <input
                type="checkbox"
                className={cc.archiveManagerCheck}
                checked={selected.size === rows.length}
                aria-label={t('archive.manager.selectAllAria')}
                disabled={inputLocked}
                // Partial selection renders the master checkbox indeterminate
                // and explicitly aria-checked="mixed" (HTML-AAM does not
                // guarantee the native mapping); the next toggle still selects
                // everything.
                {...(selected.size > 0 && selected.size < rows.length ? { 'aria-checked': 'mixed' as const } : {})}
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
              // Nav parity accent (same formula/seed and the "no accent before
              // git flags load" gate), so the group stays visually bound to its
              // workspace row; undefined for the ungrouped bucket.
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
                      // Explicit mixed state: HTML-AAM does not guarantee native
                      // `indeterminate` maps to aria-checked="mixed", and the
                      // tri-state is the group's key status. Only rendered while
                      // partial, so native checkedness stays authoritative.
                      {...(groupPartial ? { 'aria-checked': 'mixed' as const } : {})}
                      disabled={inputLocked}
                      // Half-checked group = some (not all) members selected; a
                      // native checkbox needs imperative indeterminate for that.
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
                  {!isGroupCollapsed && (
                    <div className={cc.archiveManagerGroupRows}>
                      {group.rows.map(row => (
                        <div key={row.sessionId} className={cc.archiveManagerRow}>
                          <input
                            type="checkbox"
                            className={cc.archiveManagerCheck}
                            checked={selected.has(row.sessionId)}
                            aria-label={rowAriaLabel(row)}
                            disabled={inputLocked}
                            onChange={() => { toggle(row.sessionId) }}
                          />
                          <span
                            className={cc.archiveManagerRowTitle}
                            title={titleText(row.title)}
                          >
                            {titleText(row.title)}
                          </span>
                          {residentPurged.has(row.sessionId) && (
                            <span
                              className={cc.archiveManagerRowTag}
                              title={t('archive.manager.residentPurged')}
                            >
                              {t('archive.manager.residentPurged')}
                            </span>
                          )}
                          {projectLabelOf(row.cwd) !== '' && (
                            <span className={cc.archiveManagerRowPath} title={row.cwd}>
                              {projectLabelOf(row.cwd)}
                            </span>
                          )}
                          <button
                            type="button"
                            className={clsx(cc.actionIcon, cc.actionIconDanger)}
                            aria-label={t('archive.manager.rowDeleteAria', { title: titleText(row.title) })}
                            title={t('archive.manager.rowDeleteAria', { title: titleText(row.title) })}
                            disabled={inputLocked}
                            onClick={(event) => {
                              event.stopPropagation()
                              deleteSingle(event.currentTarget, row.sessionId, titleText(row.title))
                            }}
                          >
                            <IconTrashOutline16 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
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
