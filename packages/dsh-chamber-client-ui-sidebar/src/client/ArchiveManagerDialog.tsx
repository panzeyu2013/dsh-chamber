/**
 * chamber archive manager dialog (design 24 §6, revision 2026-09; delete-all
 * retirement 2026 — see the VIEW MODES note below).
 *
 * Replaces the v1 server-row preview → native confirm → purge-everything
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
 * (indeterminate = part of the group selected). Session rows nest one tree
 * level UNDER their group header (2026 indent revision): the rows of each
 * group render inside a dedicated nesting container (.archiveManagerGroupRows
 * — ancestor padding, so every row class stays level-agnostic), the row
 * title column lands exactly under the workspace title, the checkbox rail
 * steps 8px → 32px — the group header (and the select-all row) keep the
 * outer column, so the parent → child reading matches the nav tree.
 *
 * All deletion runs through the host purge's optional `sessionIds` subset
 * filter (the host intersects the filter with the authoritative archived
 * set, so the dialog can never delete a non-archived session). Every
 * destructive action is confirm-gated by an IN-DIALOG two-stage confirm
 * (2026 refactor, THIS module's scope; the nav's workspace-delete flow carries
 * its own in-app confirm Modal — 2026-09-11 upstream-alignment T2b): no native
 * OS confirm dialog anywhere in this package (an OS-styled dialog cannot ride
 * the alias tokens and reads as an alien chrome layer over this app), and no
 * second Modal layer
 * (the official Modal registers one document-level BUBBLE Escape listener
 * per open instance, so stacking a confirm modal over this dialog would
 * close BOTH layers on a single Escape — no official nested precedent,
 * design 24 §6 item 7). A destructive control therefore ARMS a confirm mode
 * INSIDE this dialog: the rows freeze (checkboxes/trash disabled) and a
 * risk bar renders the counted irreversible copy with 取消 / 确认删除;
 * 取消 or Escape disarm it (Escape never closes the dialog while armed —
 * capture-phase stop, see below), 确认删除 runs the purge. The footer
 * 删除选中 button is hidden while a confirm is armed, and closing the
 * dialog while armed (Esc-when-not-armed / X / mask) simply drops the
 * armed confirm — nothing is ever deleted without 确认删除. Running subtrees
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
 * Single-flight per dialog (one run at a time; all input controls except
 * the view-state group fold toggles are disabled while a run is in flight
 * or a confirm is armed). Closing is allowed at ANY time (Esc / X / mask) —
 * an in-flight purge keeps running host-side (client timeout ≠ host stop)
 * and the UNCONDITIONAL requestRefresh still fires, so a closed dialog never
 * loses the deletion itself, only its outcome note; an ARMED (not yet
 * confirmed) delete is dropped by closing — nothing was deleted. The rows
 * list re-derives from the server prop on every chamberBridge publish:
 * after a successful purge the App-side refresh drops the deleted rows from
 * the aggregate and this dialog's selection is pruned to surviving rows.
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
 * COPY (2026-09-11 upstream-alignment, finding 11): every product-visible
 * string in this dialog rides this package's typed locale dictionaries
 * (upstream packages/client/AGENTS.md), including the two that used to be
 * inline zh literals (the busy-refusal line and the in-flight 正在删除… status).
 * Only wire error text still passes through untranslated, by policy.
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
import type { ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { chamberBridge } from '../shared/aggregate-store.ts'
import { groupArchivedRows, workspaceAccentStyle, type ArchivedSessionGroup } from '../shared/derive.ts'
import { getInstanceClient } from '../shared/instance-api.ts'
import { archivePurgeNote, purgeRemovedContent, runArchivePurge } from '../shared/archive-purge.ts'
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
  // that held focus (per-row delete → refresh → the row disappears), and the
  // two-stage confirm's accept path unmounts the confirm bar that held focus;
  // the browser drops focus to <body> in both cases. While the dialog stays
  // mounted, land focus back on the panel — a loss guard only, not a trap.
  // Deps [rows, busy] cover the refresh-prune path and the accept path (busy
  // flips true as the armed bar unmounts); the guard deliberately does NOT
  // early-return on rows === undefined (an accept over a vanished list view
  // still needs the panel landing). Cancel/Esc need no guard: disarmConfirm
  // defers its own refocus past the commit.
  useEffect(() => {
    if (document.activeElement !== document.body) return
    panelRef.current?.focus()
  }, [rows, busy])

  // ---- In-dialog two-stage confirm (2026 refactor; module doc) ----
  // The confirm is a MODE of this dialog, never a second layer: rows freeze
  // (inputLocked) and a risk bar shows the counted copy with 取消/确认删除.
  // `title` non-null = a single-row message subject (per-row trash); null =
  // the counted selected-set message (footer 删除选中). The id list is
  // frozen at arming — later selection changes cannot alter what the counted
  // copy promised. INVARIANT (2026 review): title !== null ⇔ ids.length === 1
  // — the two arming sites (deleteSingle/deleteSelected) construct it so; a
  // future third caller must keep the subject/count pair in sync.
  const [confirming, setConfirming] = useState<{ ids: readonly string[]; title: string | null } | null>(null)
  // The control that armed the confirm (row trash / footer button): 取消/Esc
  // returns focus to it (deferred — the opener stays `disabled` until the
  // disarm commit lands); accept drops it (the rows refresh after the purge,
  // the busy/focus-loss guards take over).
  const confirmOpenerRef = useRef<HTMLElement | null>(null)
  const confirmBarRef = useRef<HTMLDivElement | null>(null)

  /** Disarm the confirm stage. Esc/取消 never close the dialog — they only
   *  disarm, with `refocus` returning focus to the arming control (fallback:
   *  the panel); accept disarms with `refocus: false` (the busy flip + the
   *  focus-loss guard take over). The refocus is DEFERRED past the disarm
   *  commit (requestAnimationFrame): while armed the opener carries
   *  `disabled` (inputLocked) and `.focus()` on a disabled control is a spec
   *  no-op — by the rAF the commit has re-enabled it. Re-checked inside the
   *  frame so a dialog closed in the window falls back to the panel (itself
   *  a no-op once unmounted). */
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

  // Escape while a confirm is armed must disarm it — NOT close the dialog.
  // The official Modal listens for Escape in the BUBBLE phase on document;
  // this CAPTURE-phase listener runs first and stops propagation, so the
  // modal's own bubble listener never fires while the stage is up. Once
  // disarmed, Escape closes the dialog as usual (no capture listener).
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

  // Keyboard lands on the SAFE default: 取消 is the bar's first button. The
  // risk message itself is announced via its own role="alert" span on arming.
  useEffect(() => {
    if (confirming === null) return
    confirmBarRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [confirming])

  // The shell can pass `server: null` while this dialog stays mounted (its
  // source aggregate disappeared but the dialog is not yet unmounted): an
  // armed confirm must not survive invisibly and resurface over a NEW list
  // with the OLD frozen ids. Disarm without refocus — the caller is closing.
  useEffect(() => {
    if (server === null && confirming !== null) disarmConfirm(false)
  }, [server, confirming, disarmConfirm])

  if (server === null) return null

  /** True only when the snapshot's archive set is authoritative (mounted
   *  baseline); degraded sources (unary fallback) and not-yet-landed
   *  aggregates are unknown — see the module doc's VIEW MODES. */
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

  /** Select / deselect every row of one workspace group (the group header
   *  checkbox; a collapsed group keeps its membership — selection is list
   *  state, not view state). */
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

  /** Purge exactly the listed session ids (host intersects the filter with
   *  the authoritative archived set — never a non-archived target). No
   *  whole-set `undefined` path reaches this call: with delete-all retired,
   *  a purge always stems from an explicit per-row / select-all selection.
   *
   *  2026-09 revision ("已归档的对话应该终止") + 2026-09 protection
   *  amendment: the run STOPS the selected sessions' running turns through the
   *  official `session/cancel` wire (closure-wide, maintenance phases
   *  included), then purges with `force: true` so the host also deletes merely
   *  LOADED (idle, attached) content — an archived session may be waiting on a
   *  question or an approval and must stay deletable. The host still refuses a
   *  RUNNING member (fail-closed), so the stop pass is an accelerator, never
   *  the safety boundary. The session this client is displaying — the LIVE
   *  vendor `current`, re-read from the bridge projection at request time
   *  (`liveViewedSessionId`) — is handed to the host as the run's PROTECTED
   *  id: its whole tree is skipped and reported, while the rest of the
   *  selection is unaffected. All of this is decided in the
   *  pure `runArchivePurge` flow (`shared/archive-purge.ts`), which the node
   *  tests pin. */
  const runPurge = (sessionIds: readonly string[]): void => {
    if (busy) return
    // PROTECTION, NOT PERMISSION (2026-09 protection amendment): the run is
    // never refused for an unknown current session. The LIVE current session
    // is handed to the host as `protectSessionIds`, so its whole tree is
    // skipped; when the client cannot name one the run still proceeds (the
    // host's running guard and the cancel pass are the safety boundary) and
    // the dialog states that fact in the hint line above. The pure
    // `runArchivePurge` owns the stop-then-force orchestration and is
    // node-tested.
    const client = getInstanceClient(server.id)
    setBusy(true)
    setNote(null)
    void (async () => {
      try {
        const run = await runArchivePurge(client, sessionIds, liveViewedSessionId())
        // UNCONDITIONAL refresh (v1 F9 parity): even if this dialog already
        // unmounted, the host purge may have completed and chamberBridge's
        // App-side consumers are global/generation-fenced.
        chamberBridge.requestRefresh(server.id)
        // design 24 §12: additionally ask this source's MOUNTED ctx to
        // re-run its OFFICIAL session-list refresh — the host purge is
        // invisible to the official client summaries (events are no-ops), so
        // without it the deleted rows linger there and resurface in the
        // sidebar once the host removes their ids from the archived set.
        chamberBridge.requestSessionListRefresh(server.id)
        if (!mountedRef.current) return
        // Every outcome line (stop/skip/delete counts, failures) is composed by
        // the pure `archivePurgeNote` as dictionary KEYS + params and rendered
        // here through `t()` — the module itself carries no copy.
        const outcome = archivePurgeNote(run)
        setNote({
          kind: outcome.kind,
          text: outcome.lines.map(line => t(line.key, line.params)).join('\n'),
        })
        if (outcome.kind === 'info' && purgeRemovedContent(run)) {
          // The refreshed aggregate (requestRefresh above) prunes the rows;
          // the selection effect drops ids that no longer exist. Only a run
          // that REMOVED something clears the selection (2026-09 review): a
          // protected/skipped-only run leaves every row in place, and the
          // documented retry must stay one click away.
          setSelected(new Set())
        }
      } catch (error) {
        // A settle of ANY kind may still mean host-side deletions happened
        // (client timeout ≠ host stop; another shell's purge raced this one)
        // — request the official session-list refresh too, so rows deleted by
        // the host drop from the mounted ctx summaries instead of lingering.
        // Fired before the mounted guard: a closed dialog must not lose the
        // convergence request (the host may still have been deleting).
        chamberBridge.requestSessionListRefresh(server.id)
        if (!mountedRef.current) return
        const message = error instanceof Error ? error.message : String(error)
        // 2026-09-11 upstream-alignment（finding 11）：`busy:` 分支的说明文案进
        // 字典（上游 client/AGENTS.md：产品可见文案一律在类型化字典里）；线
        // 协议原文（非 busy 的 message）按政策原样透出，不翻译。
        const friendly = message.startsWith('busy:')
          ? t('archive.manager.busyOther')
          : message
        setNote({ kind: 'error', text: friendly })
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    })()
  }

  /** Arm the two-stage confirm for exactly the given rows (`title` = the
   *  single-row message subject; null = the counted selected-set message).
   *  The arming control is remembered so 取消/Esc can return focus to it. */
  const requestDelete = (opener: HTMLElement | null, ids: readonly string[], title: string | null): void => {
    if (busy || confirming !== null || ids.length === 0) return
    confirmOpenerRef.current = opener
    setConfirming({ ids, title })
  }

  /** Per-row trash: arm the confirm for one session (its resolved title as
   *  the message subject; the untitled fallback rides the dictionary). */
  const deleteSingle = (opener: HTMLElement | null, sessionId: string, title: string): void => {
    requestDelete(opener, [sessionId], title === '' ? t('archive.manager.rowUntitled') : title)
  }

  /** Footer 删除选中: arm the confirm over the current selection — never a
   *  whole-set `undefined` purge (design 24 §6). */
  const deleteSelected = (opener: HTMLElement | null): void => {
    if (selected.size === 0) return
    requestDelete(opener, [...selected], null)
  }

  /** Accept the armed confirm: disarm (no refocus — the purge's busy flip +
   *  the focus-loss guard take over), then purge the frozen id list. */
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

  /**
   * The PROTECTION id, resolved at REQUEST time (2026-09 review). `server` is a
   * render snapshot from the last publish, and the vendor's `current` can move
   * between that publish and the click; asking the bridge for the live
   * projection keeps the protected id as fresh as the wire allows (the same
   * discipline as the confirm copy re-reading the list before a run). The prop
   * stays the fallback for a source that vanished from the snapshot — a retired
   * source displays nothing, so protecting nothing is correct there anyway.
   */
  const liveViewedSessionId = (): string | undefined => {
    const fresh = chamberBridge.getServers().find(entry => entry.id === server.id)
    return (fresh ?? server).runtime?.current
  }

  // Two-stage confirm derived state: while a confirm is ARMED the whole list
  // input freezes (inputLocked = busy OR armed) so the counted copy can never
  // go stale — the selection/checkboxes cannot move under the armed promise.
  const inputLocked = busy || confirming !== null
  // NO PRE-CLICK GATE (2026-09 protection amendment): the delete controls are
  // enabled whenever the list is actionable and no run is in flight. An unknown
  // current session is a PROTECTION degradation, never a capability loss — the
  // host skips RUNNING trees and protects whatever id the client can name; the
  // hint line below states the degradation honestly instead of greying the
  // controls out.
  const unprotected = server.runtime?.current === undefined
  // The armed confirm's message: single-row subject copy (title) or the
  // counted selected-set copy (title null). Rendered only while armed.
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
                {/* 2026-09-11 upstream-alignment（finding 11）：内联 zh 文案进字典。 */}
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
            {/* role="alert" lives on the TEXT span, not the bar container
                (2026 a11y review): the bar's first button takes focus in the
                same commit — an alert on the container races the focus move
                and a screen reader may hear only 取消 or only the risk copy.
                Text-only alert content announces the risk message itself;
                the buttons are reached by Tab as usual. */}
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
                // Partial selection renders the master checkbox as
                // indeterminate (group-header tri-state parity, 2026 review);
                // it still selects everything on the next toggle. Explicit
                // aria-checked="mixed" while partial (2026 a11y review —
                // group-header parity: HTML-AAM does not guarantee that
                // native indeterminate maps to aria-checked="mixed").
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
                      disabled={inputLocked}
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
                  {!isGroupCollapsed && (
                    <div className={cc.archiveManagerGroupRows}>
                      {group.rows.map(row => (
                        <div key={row.sessionId} className={cc.archiveManagerRow}>
                          <input
                            type="checkbox"
                            className={cc.archiveManagerCheck}
                            checked={selected.has(row.sessionId)}
                            aria-label={titleText(row.title)}
                            disabled={inputLocked}
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
