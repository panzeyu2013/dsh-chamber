/**
 * Chamber dialog layers:
 * the add-workspace directory browser, the per-source archive manager and the
 * armed workspace-delete confirm. One hook owns the state, the openers and the
 * single-dialog-layer predicate; one component renders the three layers.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { DirectoryBrowser } from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client/DirectoryBrowser.tsx'
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { createHostDirectory, getInstanceClient, listHostDirectory } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { createWorkspaceForSource, deleteWorkspaceForSource } from '@dsh-chamber/dsh-chamber-client-core/workspace-mutations'
import { getWorkspaceGitFlag } from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'
import { ArchiveManagerDialog } from './ArchiveManagerDialog.tsx'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import type { RunActionWithOutcome } from './sidebar-root-actions.ts'
import cc from './sidebar-chamber.module.css'

/**
 * One armed workspace-delete confirmation.
 * The subject is resolved at ARM time (the row may unmount while the
 * confirmation is up — upstream's own reason for keeping the delete dialog
 * separate from the row, vendor ui-workspace WorkspaceBrowser.tsx:1088-1090).
 */
interface WorkspaceDeleteTarget {
  /** Source owning the workspace row. */
  sourceId: string
  workspaceId: string
  /** Row title, used in the dialog copy. */
  title: string
  /** The workspace's path is gone: only its registration is deleted. */
  orphaned: boolean
}

export function useSidebarDialogs({ servers, runActionWithOutcome, setRowErrors }: {
  servers: readonly ChamberServerAggregate[]
  runActionWithOutcome: RunActionWithOutcome
  setRowErrors: Dispatch<SetStateAction<Record<string, string>>>
}) {
  const [addingWorkspace, setAddingWorkspace] = useState<string | null>(null)
  const [addingWorkspaceBusy, setAddingWorkspaceBusy] = useState(false)
  // chamber (design 24): the ARCHIVE MANAGER dialog — one
  // per source. The manager lists the source's archived sessions (metadata
  // rides ChamberServerAggregate.archivedSessions; the dialog issues NO
  // session read of its own) and offers per-row and multi-select purges
  // through the optional sessionIds purge filter. Whole-set deletion has NO
  // standalone button: "delete everything" means
  // ticking the select-all checkbox and confirming the counted
  // delete-selected, so a purge never covers rows the dialog could not list.
  // Destructive calls stay confirm-gated INSIDE the dialog.
  const [archiveCleanupServerId, setArchiveCleanupServerId] = useState<string | null>(null)
  // Focus restore: the manager's opener trash button
  // regains focus when the dialog closes — keyboard users otherwise land on
  // <body> after the dialog unmounts.
  const archiveCleanupOpenerRef = useRef<HTMLElement | null>(null)

  /**
   * SYMMETRIC closure: at most ONE
   * chamber-owned Modal layer may be up at a time, in whichever ORDER the user
   * reaches it. The official Modal has no focus trap (vendor ui-primitives
   * Modal.tsx: a mask + one document-level BUBBLE Escape listener per open
   * instance), so every mask leaves the rest of the shell tabbable — the
   * always-rendered orphan badge (ServerSection `cc.orphanBadge`, outside the
   * hover cluster) and the source-header controls are all reachable behind any
   * of them. Two open layers would each register their own document Escape
   * listener and ONE Escape would close BOTH (design 24 §6 item 7 — the hazard
   * the archive manager refuses a second layer for).
   *
   * ONE predicate owns the rule and EVERY opener consults it — gating only the
   * delete arm would leave the reverse order open (Tab behind the delete confirm's
   * mask → archive manager / add-workspace browser on top):
   *   - `onDeleteWorkspace`     arms the workspace-delete confirm,
   *   - `onOpenArchiveCleanup`  opens the archive manager,
   *   - `openWorkspaceBrowser`  opens the add-workspace directory browser.
   * Nothing is lost by refusing: each layer is dismissible (cancel / X / mask /
   * Escape), so the refused control works again the moment it is gone.
   *
   * Declared as a hoisted `function` on purpose: the two openers below and the
   * arm handler further down all consult ONE rule, and the `deleteTarget` state
   * it reads is declared later in this component (function declarations hoist,
   * so source order never decides whether the rule is in scope).
   */
  function otherChamberDialogOpen(self: 'delete' | 'archive' | 'browser'): boolean {
    return (self !== 'delete' && deleteTarget !== null)
      || (self !== 'archive' && archiveCleanupServerId !== null)
      || (self !== 'browser' && addingWorkspace !== null)
  }

  /** Symmetric closure: the add-workspace
   *  entry (the source header's `+`, ServerSection) goes through THIS opener
   *  instead of exposing the raw setter to the section — the single
   *  one-dialog-layer rule must be enforced where the layer is opened, not at
   *  each call site. */
  const openWorkspaceBrowser = (sourceId: string): void => {
    if (otherChamberDialogOpen('browser')) return
    setAddingWorkspace(sourceId)
  }

  const onOpenArchiveCleanup = (server: ChamberServerAggregate): void => {
    // The reverse direction. Reachable from the
    // source header while the delete confirm's mask is up (no focus trap), so
    // it must refuse exactly like the other two openers.
    if (otherChamberDialogOpen('archive')) return
    archiveCleanupOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setArchiveCleanupServerId(server.id)
  }
  const closeArchiveCleanup = (): void => {
    setArchiveCleanupServerId(null)
    // Focus after the close render commits (the opener may have unmounted —
    // a collapsed rail or source removal — focus() is a safe no-op then).
    requestAnimationFrame(() => {
      archiveCleanupOpenerRef.current?.focus()
      archiveCleanupOpenerRef.current = null
    })
  }
  // The manager may only stay open over a live source: a source that
  // vanishes or disconnects mid-session closes it (a confirm against a dead
  // instance would fail into the void). Mirrors the sort-menu cleanup.
  useEffect(() => {
    if (archiveCleanupServerId === null) return
    const server = servers.find(candidate => candidate.id === archiveCleanupServerId)
    if (server === undefined || !server.connected) {
      setArchiveCleanupServerId(null)
    }
  }, [servers, archiveCleanupServerId])

  /**
   * Best-effort workspace path for a withdraw fact. The
   * sidebar projection (`ChamberServerWorkspace`) carries no path, so the only
   * local source is the mounted ctx's own snapshot report on the bridge — read
   * BEFORE the wire call, while the row is still listed. An unmounted source has
   * none and needs none: `removePendingWorkspace` matches the echo by
   * `workspaceId`, which the row's delete action carries.
   */
  const workspacePathForFact = (sourceId: string, workspaceId: string): string =>
    chamberBridge.getInstanceSnapshots()[sourceId]?.workspaces
      .find(row => row.workspaceId === workspaceId)?.path ?? ''

  /**
   * The ARMED workspace-delete confirm.
   * Upstream renders this as an in-app Modal (vendor ui-workspace
   * WorkspaceBrowser.tsx:1393-1418 — outline cancel + outline destructive
   * confirm, a description sentence, and a role="status" pending line), never
   * as an OS-styled native confirm, which cannot ride the alias tokens. The
   * state lives on the SHELL (not per row) for upstream's own reason: the
   * deleted row may unmount while the confirmation is still in flight.
   *
   * The nav rows ARE reachable behind an open Modal's mask: the orphan badge
   * is an always-rendered, tabbable button OUTSIDE the hover cluster
   * (ServerSection.tsx `cc.orphanBadge`), and the official Modal has no focus
   * trap (vendor ui-primitives Modal.tsx: mask + one document Escape listener
   * only), so a keyboard user can Tab behind any open chamber dialog's mask
   * and arm this confirm on top of it. Both layers would then register their
   * own document Escape listener and ONE Escape would close BOTH (design 24
   * §6 item 7 — the hazard the archive manager refuses a second layer for).
   * The real invariant therefore lives in the openers, NOT in the mask:
   * `otherChamberDialogOpen` is consulted by all three of them (this arm
   * handler, the archive manager's opener, the add-workspace browser's opener),
   * so at most one chamber Modal layer can ever be up in EITHER order.
   */
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceDeleteTarget | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  /** The last failed delete's message, shown
   *  INSIDE the dialog (role="alert", upstream WorkspaceBrowser.tsx:1418) —
   *  the row-keyed rowErrors line has no surface once the deleted row has
   *  unmounted, which is exactly why `deleteTarget` lives on the shell. */
  const [deleteError, setDeleteError] = useState<string | null>(null)
  /** Keyboard focus lands inside the dialog on arm (the official Modal moves no
   *  focus itself); the opener is remembered so closing hands focus back —
   *  otherwise a keyboard user would be stranded behind the mask. */
  const deleteBodyRef = useRef<HTMLDivElement | null>(null)
  const deleteOpenerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (deleteTarget === null) return
    deleteBodyRef.current?.focus()
  }, [deleteTarget])
  /** The confirm may only stay armed over a live source (mirrors the archive
   *  manager's guard): a source that vanishes or disconnects drops it — a
   *  delete against a dead instance would fail into the void. The auto-drop is
   *  SUSPENDED while a reported failure
   *  is on screen — a delete that failed because its source vanished must not
   *  have its one visible explanation (the in-dialog `role="alert"`) unmounted
   *  with it; that alert stays until the user dismisses the dialog. */
  useEffect(() => {
    if (deleteTarget === null || deletePending || deleteError !== null) return
    const server = servers.find(candidate => candidate.id === deleteTarget.sourceId)
    if (server === undefined || !server.connected) setDeleteTarget(null)
  }, [servers, deleteTarget, deletePending, deleteError])

  const onDeleteWorkspace = (server: ChamberServerAggregate, workspaceId: string, title: string): void => {
    // Arming the confirm is the ONLY effect here — the wire call happens in
    // confirmDeleteWorkspace, so nothing destructive can run before the user
    // accepts the dialog.
    if (deletePending) return
    // Refuse to ARM over another chamber
    // dialog. Both the archive manager and the add-workspace browser render the
    // official Modal, which has no focus trap: this handler is reachable from
    // the always-rendered orphan badge (tabbable behind either mask), and two
    // open Modal layers each register a document Escape listener, so one
    // Escape would close BOTH. The rule lives in `otherChamberDialogOpen` (the
    // single predicate every opener consults, both directions).
    if (otherChamberDialogOpen('delete')) return
    deleteOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // A failed run's message belongs to its own attempt: arming a new target
    // must never show the previous failure inside the fresh dialog.
    setDeleteError(null)
    setDeleteTarget({
      sourceId: server.id,
      workspaceId,
      title,
      // An ORPHANED workspace (path gone) only loses its durable registration
      // — its own description sentence states that, behind the same single
      // confirm.
      orphaned: getWorkspaceGitFlag(server.id, workspaceId)?.orphaned === true,
    })
  }

  /** Unconditional dismissal (the confirm path already cleared the pending
   *  flag in the same batch, so it cannot consult the render-closure value).
   *  Drops any reported failure with the dialog it was shown in. */
  const dismissDeleteWorkspace = (): void => {
    setDeleteTarget(null)
    setDeleteError(null)
    requestAnimationFrame(() => {
      const opener = deleteOpenerRef.current
      deleteOpenerRef.current = null
      if (opener !== null && opener.isConnected) opener.focus()
    })
  }

  const closeDeleteWorkspace = (): void => {
    if (deletePending) return
    dismissDeleteWorkspace()
  }

  /** Accept the armed confirm: run the SAME keyed action (identical
   *  rowErrors reporting), keep the dialog pending while the wire call is in
   *  flight, and — on success — close it once the action settled. A FAILURE
   *  does not close the dialog (upstream WorkspaceBrowser.tsx:1117-1120,
   *  :1417-1418). The row-keyed rowErrors line stays
   *  (harmless, and the only surface when the row is still mounted), but it has
   *  no surface at all once the deleted row unmounted — precisely the case the
   *  shell-level `deleteTarget` exists for — so the message is also rendered
   *  inside the dialog as a `role="alert"` and the dialog stays up until the
   *  user dismisses it (cancel / X / mask / Escape). */
  const confirmDeleteWorkspace = (): void => {
    const target = deleteTarget
    if (target === null || deletePending) return
    setDeletePending(true)
    setDeleteError(null)
    void runActionWithOutcome(`${target.sourceId}/workspace/${target.workspaceId}/delete`, async () => {
      try {
        const path = workspacePathForFact(target.sourceId, target.workspaceId)
        // chamber (design 05 §2.2.1): the
        // WITHDRAW half of the workspace echo rides the single funnel — the
        // wire call and the fact publish together, for the ROW's own source
        // (never for the publishing shell). An unmounted source has no
        // authoritative baseline listing this workspace, so
        // `reconcilePendingWorkspaces` cannot retire the echoed row: without
        // this fact a create → delete left a ghost row with real-id actions
        // enabled until the TTL.
        await deleteWorkspaceForSource(target.sourceId, target.workspaceId, path)
        chamberBridge.requestRefresh(target.sourceId)
      } catch (reason) {
        // The dialog's own copy of the failure. Rethrown so the
        // keyed rowErrors line keeps reporting it.
        setDeleteError(reason instanceof Error ? reason.message : String(reason))
        throw reason
      }
    }).then((ok) => {
      setDeletePending(false)
      // Success: the removal fact + refresh already
      // ran inside the action, and the dialog closes.
      if (ok) dismissDeleteWorkspace()
    })
  }

  // Add-workspace directory browser (05 §4, unified in-app dialog): the
  // dialog drives the browsing source's own unary client (directoryPicker.list
  // / directoryPicker.createDirectory — the browse capability every managed
  // host serves, v0.1.2-alpha.1 namespace). The browse calls are
  // useCallback-stabilized: the vendor dialog
  // resets its whole navigation on every change of its `navigate` closure,
  // and this shell re-renders on chamberBridge publishes (status/snapshot
  // pushes + fallback refreshes), so an inline arrow would wipe the user's
  // browsing on refresh. A
  // confirmed path commits workspace.create against that source; failures
  // close the dialog and surface inline (never hidden behind the modal
  // mask), never silently.
  const browseClient = useMemo(
    () => (addingWorkspace === null ? null : getInstanceClient(addingWorkspace)),
    [addingWorkspace],
  )
  const browseListDirectory = useCallback(
    (path: string | undefined, signal?: AbortSignal) => {
      if (browseClient === null) return Promise.reject(new Error('no instance'))
      return listHostDirectory(browseClient, path, signal)
    },
    [browseClient],
  )
  const browseCreateDirectory = useCallback(
    (path: string, name: string) => {
      if (browseClient === null) return Promise.reject(new Error('no instance'))
      return createHostDirectory(browseClient, path, name)
    },
    [browseClient],
  )
  const browsePick = useCallback(
    (path: string) => {
      const sourceId = addingWorkspace
      if (sourceId === null || browseClient === null) return
      setAddingWorkspaceBusy(true)
      const key = `${sourceId}/add-workspace`
      setRowErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      // chamber (design 05 §2.2): the HOST workspace identity
      // is published by the single funnel together with the wire call — the
      // only trustworthy "this workspace exists on that host" fact reachable
      // without a mounted shell. The unary fallback derives its groups from
      // session cwds (a brand-new workspace has none yet) and a previously-
      // pushed source keeps its workspace set frozen, so without the echo the
      // row appears only after the user clicks that server. The App echoes it
      // immediately; the mounted follow baseline converges later.
      createWorkspaceForSource(sourceId, path)
        .then(() => {
          setAddingWorkspace(null)
          chamberBridge.requestRefresh(sourceId)
        })
        .catch((reason: unknown) => {
          const message = reason instanceof Error ? reason.message : String(reason)
          setRowErrors((prev) => ({ ...prev, [key]: message }))
          setAddingWorkspace(null)
        })
        .finally(() => {
          setAddingWorkspaceBusy(false)
        })
    },
    [addingWorkspace, browseClient],
  )
  const browseClose = useCallback(() => {
    setAddingWorkspace(null)
    setAddingWorkspaceBusy(false)
  }, [])
  return {
    addingWorkspace, addingWorkspaceBusy, archiveCleanupServerId,
    deleteTarget, deletePending, deleteError, deleteBodyRef,
    openWorkspaceBrowser, onOpenArchiveCleanup, onDeleteWorkspace,
    closeArchiveCleanup, closeDeleteWorkspace, confirmDeleteWorkspace,
    browseListDirectory, browseCreateDirectory, browsePick, browseClose,
  }
}

/** The three dialog layers, rendered at the shell root. */
export function SidebarRootDialogs({ dialogs, servers, t, directoryBrowserT }: {
  dialogs: ReturnType<typeof useSidebarDialogs>
  servers: readonly ChamberServerAggregate[]
  t: SidebarRootComponentProps['t']
  directoryBrowserT: SidebarRootComponentProps['directoryBrowserT']
}) {
  const {
    addingWorkspace, addingWorkspaceBusy, archiveCleanupServerId,
    deleteTarget, deletePending, deleteError, deleteBodyRef,
    closeArchiveCleanup, closeDeleteWorkspace, confirmDeleteWorkspace,
    browseListDirectory, browseCreateDirectory, browsePick, browseClose,
  } = dialogs
  return (
    <>
      {/* Add-workspace directory browser (single instance; mounted only while
          a target source is chosen — a fresh mount resets the dialog). */}
      {addingWorkspace !== null && (
        <DirectoryBrowser
          open
          listDirectory={browseListDirectory}
          createDirectory={browseCreateDirectory}
          busy={addingWorkspaceBusy}
          t={directoryBrowserT}
          onOpen={browsePick}
          onClose={browseClose}
        />
      )}
      {/* chamber (design 24): the per-source archive
          manager — lists what is archived (grouped by workspace, §6) and
          deletes per-row / selected rows (whole set only via the explicit
          select-all checkbox — no standalone delete-all, §6). Mounted only
          while a target source is chosen. */}
      {archiveCleanupServerId !== null && (
        <ArchiveManagerDialog
          server={servers.find(candidate => candidate.id === archiveCleanupServerId) ?? null}
          t={t}
          onClose={closeArchiveCleanup}
        />
      )}
      {/* chamber: the workspace-delete confirmation — the in-app Modal
          (upstream chrome: outline cancel + outline destructive confirm, a
          description sentence, a role="status" pending line and a role="alert"
          failure line, vendor ui-workspace WorkspaceBrowser.tsx:1393-1418).
          Mounted only
          while a target is armed; the row that opened it may already be gone.
          Single-dialog-layer invariant: this confirm is
          never mounted over another chamber dialog and never under one — all
          three openers (this arm handler, the archive manager's, the
          add-workspace browser's) consult `otherChamberDialogOpen`, so only one
          layer can be up whichever order the user reaches them in. */}
      <Modal
        open={deleteTarget !== null}
        onClose={closeDeleteWorkspace}
        closeLabel={t('action.cancel')}
        title={t('delete.workspace')}
        {...deleteTarget === null
          ? {}
          : {
            description: deleteTarget.orphaned
              // The orphan case keeps its own
              // copy, but the DIALOG needs a statement (the long-standing
              // `confirm.deleteOrphan` question with its trailing "？" reads as a
              // question under a "删除工作区" title, and that key is still the
              // orphan badge's native title in the nav — unchanged there).
              ? t('delete.descOrphan', { name: deleteTarget.title })
              : t('delete.desc', { name: deleteTarget.title }),
          }}
        footer={(
          <>
            <Button variant="outline" disabled={deletePending} onClick={closeDeleteWorkspace}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="outline"
              className={cc.archiveManagerDanger}
              disabled={deletePending}
              onClick={confirmDeleteWorkspace}
            >
              {t('delete.workspace')}
            </Button>
          </>
        )}
      >
        <div ref={deleteBodyRef} tabIndex={-1}>
          {deletePending && <div className={cc.deleteStatus} role="status">{t('delete.pending')}</div>}
          {/* The failure stays INSIDE the dialog (and the dialog
              stays open) — upstream WorkspaceBrowser.tsx:1418. */}
          {deleteError !== null && <div className={cc.deleteError} role="alert">{deleteError}</div>}
        </div>
      </Modal>
    </>
  )
}
