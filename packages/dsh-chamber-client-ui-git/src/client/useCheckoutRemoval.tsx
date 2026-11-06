/**
 * The checkout-row removal flow (design 08 §5.3-§5.4), extracted from the
 * occupant so the row file stays about facts/actions. Owns:
 *  - the custom confirmation's state (path/branch identity, delete-branch,
 *    archive choice, dirty/submodule acknowledgement, errors/notice);
 *  - the archive preview + confirm-time re-plan (generation/abort; physical
 *    sessions, not polled workspace membership);
 *  - the upstream two-phase archive with the activity-list stop dialog;
 *  - the host's dirty/submodule refusals that re-arm the discard authorization.
 * The HOST removal never archives; the checkbox is an explicit client step.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { archiveSessionForSource } from '@dsh-chamber/dsh-chamber-client-core'
import { sessionArchiveRefusal } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { GitActionError, gitActionErrorText } from '../shared/action-error.ts'
import { archiveBeforeRemove, type ArchiveStopPending } from '../shared/checkout-archive.ts'
import { removeUnregisteredWorktree, reportBranchDeleteFailure } from '../shared/coordinator.ts'
import { unregisteredRemoveOptions } from '../shared/remove-input.ts'
import { removeFailureCode } from '../shared/remove-notes.ts'
import type { GitSidebarKey } from '../locales.ts'
import { fetchCheckoutArchiveFacts, type CheckoutArchiveFacts } from './checkout-archive-facts.ts'
import { CheckoutRemoveDialog } from './CheckoutRemoveDialog.tsx'
import { CheckoutArchiveStopDialog } from './CheckoutArchiveStopDialog.tsx'

/** One derived checkout row awaiting removal authorization. */
export interface RowRemoveTarget {
  readonly repoId: string
  readonly worktreeId: string
  readonly path: string
  readonly branch: string | null
  readonly head: string
  /** Row label substituted into the confirmation copy (`{name}`). */
  readonly name: string
  /** The snapshot reported the directory as gone: the copy then explains the
   *  leftover-record cleanup instead of a plain removal. */
  readonly missing: boolean
  /** The snapshot reports uncommitted changes: the confirmation collects the
   *  discard acknowledgement and the request then carries `discardChanges`. */
  readonly dirty: boolean
}

type CheckoutRemovalTranslate = (key: GitSidebarKey) => string

export interface UseCheckoutRemovalOptions {
  readonly sourceId: string
  readonly t: CheckoutRemovalTranslate
  /** Source busy/recovery: the dialog cannot mutate while a Git action runs. */
  readonly disabled: boolean
}

export interface CheckoutRemoval {
  readonly openRemove: (target: RowRemoveTarget) => void
  readonly dialog: ReactNode
}

/** One localized line per pending session/activity family for the stop dialog. */
function archiveStopLines(
  pending: readonly ArchiveStopPending[],
  titles: readonly { readonly sessionId: string; readonly title?: string }[],
  t: CheckoutRemovalTranslate,
): string[] {
  const titlesById = new Map(titles.map(row => [row.sessionId, row.title]))
  const lines: string[] = []
  for (const item of pending) {
    const title = titlesById.get(item.sessionId) ?? t('archiveUntitledSession')
    for (const activity of item.activities) {
      const names = activity.items.map(entry => entry.label ?? entry.id).join(t('archiveActivityNamesSeparator'))
      const n = activity.items.length
      let line: string
      switch (activity.kind) {
        case 'turn':
          line = t('archiveActivityTurn')
          break
        case 'subagent':
          line = (n === 1 ? t('archiveActivitySubagentsOne') : t('archiveActivitySubagentsOther')).replace('{n}', String(n)).replace('{names}', names)
          break
        case 'job':
          line = (n === 1 ? t('archiveActivityJobsOne') : t('archiveActivityJobsOther')).replace('{n}', String(n)).replace('{names}', names)
          break
        case 'schedule':
          line = (n === 1 ? t('archiveActivitySchedulesOne') : t('archiveActivitySchedulesOther')).replace('{n}', String(n)).replace('{names}', names)
          break
        default:
          line = t('archiveActivityOther').replace('{n}', String(n)).replace('{kind}', activity.kind)
          break
      }
      lines.push(title + t('archiveActivitySessionSeparator') + line)
    }
  }
  return lines
}

export function useCheckoutRemoval({ sourceId, t, disabled }: UseCheckoutRemovalOptions): CheckoutRemoval {
  // Per-target authorization; reset on every close so a second removal can never
  // inherit a previous consent.
  const [rowRemove, setRowRemove] = useState<RowRemoveTarget | null>(null)
  const [rowAcknowledged, setRowAcknowledged] = useState(false)
  const [rowDeleteBranch, setRowDeleteBranch] = useState(false)
  const [rowArchive, setRowArchive] = useState(false)
  const [archiveFacts, setArchiveFacts] = useState<CheckoutArchiveFacts>({ state: 'loading' })
  const [removeError, setRemoveError] = useState<string | undefined>(undefined)
  const [removeNotice, setRemoveNotice] = useState<string | undefined>(undefined)
  // A host refusal that needs a NEW discard authorization (dirty raced in, or a
  // submodule checkout): the dialog re-arms the acknowledgement and the next
  // attempt carries `discardChanges`.
  const [rowForce, setRowForce] = useState(false)
  const [rowForceReason, setRowForceReason] = useState<'dirty' | 'submodules' | null>(null)
  // The upstream two-phase archive needs one user confirmation after the host's
  // `workspace/session-active` refusal. The activity families are shown by the
  // dedicated stop dialog; the promise is resolved by that dialog/unmount.
  const [stopPending, setStopPending] = useState<readonly ArchiveStopPending[] | null>(null)
  const [stopAcknowledged, setStopAcknowledged] = useState(false)
  const [removing, setRemoving] = useState(false)
  // A late archive-plan resolve for an older checkout must never overwrite the
  // current one. One abort controller + generation pair covers the dialog-open
  // preview and the confirm-time re-plan.
  const archiveRequest = useRef(0)
  const archiveAbort = useRef<AbortController | null>(null)
  const removingRef = useRef(false)
  const stopResolveRef = useRef<((ok: boolean) => void) | null>(null)

  useEffect(() => () => {
    archiveAbort.current?.abort()
    stopResolveRef.current?.(false)
    stopResolveRef.current = null
  }, [])

  const loadArchiveFacts = async (target: RowRemoveTarget): Promise<void> => {
    const requestId = archiveRequest.current + 1
    archiveRequest.current = requestId
    archiveAbort.current?.abort()
    if (target.missing) {
      setArchiveFacts({ state: 'ready', ids: [], count: 0, known: true, titles: [] })
      return
    }
    setArchiveFacts({ state: 'loading' })
    const controller = new AbortController()
    archiveAbort.current = controller
    try {
      const facts = await fetchCheckoutArchiveFacts(sourceId, target.path, controller.signal)
      if (archiveRequest.current !== requestId || controller.signal.aborted) return
      setArchiveFacts({ state: 'ready', ids: facts.ids, count: facts.count, known: facts.known, titles: facts.titles })
    } catch (error) {
      if (archiveRequest.current !== requestId || controller.signal.aborted) return
      setArchiveFacts({ state: 'error', error: gitActionErrorText(error, t) })
    }
  }

  const resolveStop = (ok: boolean): void => {
    const resolve = stopResolveRef.current
    stopResolveRef.current = null
    setStopPending(null)
    setStopAcknowledged(false)
    resolve?.(ok)
  }

  const openRemove = (target: RowRemoveTarget): void => {
    setRowRemove(target)
    setRowAcknowledged(false)
    setRowDeleteBranch(false)
    setRowArchive(false)
    setRowForce(false)
    setRowForceReason(null)
    setRemoving(false)
    removingRef.current = false
    setRemoveError(undefined)
    setRemoveNotice(undefined)
    void loadArchiveFacts(target)
  }

  const closeRemove = (): void => {
    // Invalidate any in-flight plan and resolve a pending stop confirmation; the
    // dialog itself refuses user-initiated closes while a removal is running.
    archiveRequest.current += 1
    archiveAbort.current?.abort()
    archiveAbort.current = null
    resolveStop(false)
    setRowRemove(null)
    setRowAcknowledged(false)
    setRowDeleteBranch(false)
    setRowArchive(false)
    setRowForce(false)
    setRowForceReason(null)
    setRemoving(false)
    removingRef.current = false
    setRemoveError(undefined)
    setRemoveNotice(undefined)
  }

  const confirmStop = (pending: readonly ArchiveStopPending[]): Promise<boolean> => new Promise<boolean>(resolve => {
    stopResolveRef.current = resolve
    setStopAcknowledged(false)
    setStopPending(pending)
  })

  const runRemoval = (): void => {
    const target = rowRemove
    if (target === null || removingRef.current) return
    removingRef.current = true
    setRemoving(true)
    setRemoveError(undefined)
    setRemoveNotice(undefined)
    void (async () => {
      // Re-plan at confirm: the dialog-open preview can be stale (a session was
      // created in the checkout since the last poll, or the archive set changed).
      // The roots are the sessions physically in the checkout, not a polled
      // workspace membership.
      let archiveIds: readonly string[] = []
      if (rowArchive) {
        archiveAbort.current?.abort()
        const controller = new AbortController()
        archiveAbort.current = controller
        try {
          const facts = await fetchCheckoutArchiveFacts(sourceId, target.path, controller.signal)
          archiveIds = facts.ids
          setArchiveFacts({ state: 'ready', ids: facts.ids, count: facts.count, known: facts.known, titles: facts.titles })
        } catch (error) {
          throw new GitActionError('archive-failed', 'Archiving sessions failed; no worktree was removed', error)
        }
      }
      if (archiveIds.length > 0) {
        const proceeded = await archiveBeforeRemove(archiveIds, {
          archivePlain: sessionId => archiveSessionForSource(sourceId, sessionId),
          archiveStop: sessionId => archiveSessionForSource(sourceId, sessionId, { stopActivity: true }),
          readActivityRefusal: error => sessionArchiveRefusal(error),
          confirmStop,
        })
        if (!proceeded) {
          removingRef.current = false
          setRemoving(false)
          setRemoveNotice(t('archiveStopCancelled'))
          return
        }
      }
      const discard = target.dirty || rowForce
      const result = await removeUnregisteredWorktree(sourceId, {
        repoId: target.repoId,
        worktreeId: target.worktreeId,
        path: target.path,
        branch: target.branch,
        head: target.head,
      }, unregisteredRemoveOptions(discard, rowDeleteBranch ? target.branch : undefined))
      if (result.branchDeleteFailed === true) reportBranchDeleteFailure(sourceId, t('branchDeleteFailedNote'))
      closeRemove()
    })().catch(error => {
      const code = removeFailureCode(error)
      if (code === 'worktree-dirty' || code === 'worktree-submodules') {
        setRowForce(true)
        setRowForceReason(code === 'worktree-submodules' ? 'submodules' : 'dirty')
        setRowAcknowledged(false)
      }
      removingRef.current = false
      setRemoving(false)
      setRemoveError(gitActionErrorText(error, t))
    })
  }

  // The acknowledgement depends on the host refusal that armed it: a fresh dirty
  // refusal or a submodule refusal requires the corresponding discard
  // authorization, which the retry sends as `discardChanges`.
  const forceReason = rowForceReason ?? (rowRemove?.dirty === true ? 'dirty' : null)
  const acknowledgeLabel = rowRemove === null
    ? undefined
    : rowRemove.missing
      ? t('unregisteredRemoveAck')
      : forceReason === 'submodules'
        ? t('submoduleDiscardAck')
        : forceReason === 'dirty'
          ? t('unregisteredDirtyDiscardAck')
          : undefined
  const archiveTitles = archiveFacts.titles?.map(row => row.title ?? t('archiveUntitledSession'))
  const stopLines = stopPending === null
    ? []
    : archiveStopLines(stopPending, archiveFacts.titles ?? [], t)

  const dialog = (
    <>
      <CheckoutRemoveDialog
        open={rowRemove !== null}
        title={t('removeTitle')}
        description={rowRemove === null
          ? ''
          : (rowRemove.missing
            ? t('unregisteredMissingRemoveConfirm')
            : rowRemove.dirty || forceReason === 'dirty'
              ? t('unregisteredDirtyRemoveConfirm')
              : t('unregisteredRemoveConfirm')).replace('{name}', rowRemove.name)}
        acknowledgeLabel={acknowledgeLabel}
        path={rowRemove?.path ?? ''}
        branch={rowRemove?.branch ?? null}
        missing={rowRemove?.missing === true}
        deleteBranchLabel={t('deleteBranchLabel')}
        archiveLabel={t('archiveSessionsLabel')}
        archiveNote={t('archiveSessionsNote')}
        {...(archiveFacts.state === 'ready' && archiveFacts.count !== undefined
          ? { archiveCount: t(archiveFacts.known === true ? 'archiveSessionsCount' : 'archiveSessionsCountUnknown').replace('{n}', String(archiveFacts.count)) }
          : {})}
        archiveAvailable={archiveFacts.state === 'ready'}
        archiveLoading={archiveFacts.state === 'loading'}
        archiveLoadingLabel={t('archiveLoading')}
        archiveRetryLabel={t('archiveRetry')}
        onArchiveRetry={() => {
          if (rowRemove !== null) void loadArchiveFacts(rowRemove)
        }}
        {...(archiveFacts.state === 'error' && archiveFacts.error !== undefined
          ? { archiveError: archiveFacts.error }
          : {})}
        {...(archiveTitles === undefined ? {} : { archiveTitles })}
        archiveMoreLabel={t('archiveSessionsMore')}
        {...(removeNotice === undefined ? {} : { notice: removeNotice })}
        {...(removeError === undefined ? {} : { error: removeError })}
        cancelLabel={t('cancel')}
        closeLabel={t('close')}
        confirmLabel={t('removeConfirm')}
        acknowledged={rowAcknowledged}
        deleteBranch={rowDeleteBranch}
        archive={rowArchive}
        disabled={removing || disabled}
        onAcknowledgedChange={setRowAcknowledged}
        onDeleteBranchChange={setRowDeleteBranch}
        onArchiveChange={setRowArchive}
        onCancel={closeRemove}
        onConfirm={runRemoval}
      />
      <CheckoutArchiveStopDialog
        open={stopPending !== null}
        title={t('archiveStopTitle')}
        description={t('archiveStopConfirm').replace('{n}', String(stopPending?.length ?? 0))}
        activityLead={t('archiveActivityLead')}
        lines={stopLines}
        acknowledgeLabel={t('archiveStopAck')}
        cancelLabel={t('cancel')}
        closeLabel={t('close')}
        confirmLabel={t('archiveStopAction')}
        acknowledged={stopAcknowledged}
        onAcknowledgedChange={setStopAcknowledged}
        onCancel={() => resolveStop(false)}
        onConfirm={() => resolveStop(true)}
      />
    </>
  )

  return { openRemove, dialog }
}
