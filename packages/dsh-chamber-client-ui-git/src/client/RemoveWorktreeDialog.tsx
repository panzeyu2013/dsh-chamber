/** Remove-worktree dialog shared by the per-workspace Git occupant. */
import { useEffect, useState } from 'react'
import { Button, Modal, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import { chamberBridge, errorMessage, fetchInstanceSnapshot, getInstanceClient } from '@dsh-chamber/dsh-chamber-client-core'
import { gitCoordinator, removeWorktree, WorktreeDirtyError } from '../shared/coordinator.ts'
import { GitSagaError } from '../shared/saga.ts'
import { GitWorktreeRpcError } from '../shared/git-api.ts'
import { collectSessionClosure } from '../shared/git-facts.ts'
import { gitActionErrorCode, gitActionErrorText } from '../shared/action-error.ts'
import { removeRunningNotes } from '../shared/remove-notes.ts'
import { discardAuthorized, nextDiscardGate } from '../shared/discard-gate.ts'
import type { DiscardGateFacts, DiscardGateKind } from '../shared/discard-gate.ts'
import type { WorkspaceGitInjected } from './injected.ts'
import css from './SidebarGit.module.css'

export interface RemoveViewTarget {
  repoId: string
  worktreeId: string
  path: string
  branch: string | null
  sessionIds: string[]
  /** The snapshot reports uncommitted state; a dirty worktree requires explicit
   *  user authorization to discard those files (design 08 §5.3). */
  dirty: boolean
  /** Sessions the snapshot reports RUNNING under this worktree (display fact):
   *  a removal NEVER stops/cancels/deletes them; whether they BLOCK is the host's
   *  archived-aware fact (`blockingRunningSessionIds`) — these ids drive the note. */
  runningSessionIds: string[]
  /** The running sessions that actually block (non-inert: not archived and not
   *  under an archived ancestor). ABSENT on an older host → `runningSessionIds`. */
  blockingRunningSessionIds?: string[]
}

interface RemoveSessionFacts {
  direct: number
  closure: number
  /** Direct sessions (id + title, up to the render cap); the rest are counted. */
  directTitles: Array<{ id: string; title: string }>
}
/** The host refusal `worktree-submodules` is a DETERMINISTIC pre-mutation
 *  rejection (target still exists, nothing removed, no recovery minted): the dialog
 *  states the warning and arms the discard authorization; the NEXT `Remove` click
 *  opens the acknowledgement. */
function isSubmoduleRefusal(error: unknown): boolean {
  const original = error instanceof GitSagaError ? error.original : error
  return original instanceof GitWorktreeRpcError && original.code === 'worktree-submodules'
}

export interface RemoveWorktreeDialogProps {
  open: boolean
  onClose: () => void
  /** The source whose instance runs the removal saga. */
  sourceId: string
  target: RemoveViewTarget | null
  /** The source's per-source `runtime` channel is present (current session KNOWN);
   *  absent → the fail-closed runtime-unknown guard applies. */
  runtimeKnown: boolean
  t: WorkspaceGitInjected['t']
}

/** One source-scoped remove dialog; session-closure facts are fetched on open. */
export function RemoveWorktreeDialog({
  open, onClose, sourceId, target, runtimeKnown, t,
}: RemoveWorktreeDialogProps): React.ReactNode {
  const source = gitCoordinator.getSource(sourceId)
  const [sessionFacts, setSessionFacts] = useState<RemoveSessionFacts | null>(null)
  const [sessionFactsError, setSessionFactsError] = useState<string | null>(null)
  const [archiveSessions, setArchiveSessions] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  /** Explicit authorization to DISCARD the worktree's uncommitted files. The
   *  branch and its commits are never touched (design 08 §5.3). */
  const [discardChanges, setDiscardChanges] = useState(false)
  /** Set when the host refused with `worktree-submodules`: the row fact cannot
   *  know submodule presence, so the refusal arms a dedicated discard authorization. */
  const [submoduleBlock, setSubmoduleBlock] = useState(false)
  const [discardSubmodules, setDiscardSubmodules] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  /** Set when the removal succeeded but the optional branch delete failed. */
  const [branchDeleteFailed, setBranchDeleteFailed] = useState(false)
  /** The discard authorization the official `RiskConfirmation` is currently
   *  collecting, holding the KIND chosen when `Remove` opened it (null = no gate).
   *  Deliberately NOT derived from `pendingDiscardAuthorization`: that derivation
   *  returns to null the instant the box is ticked, so a gate opened from it would
   *  dismiss itself before its confirm could run. */
  const [discardGateOpen, setDiscardGateOpen] = useState<DiscardGateKind | null>(null)

  const busy = source?.busy !== undefined
  const actionLocked = busy || source?.recovery !== undefined
  /** Set when the FRESH preflight reported dirty although the row fact was
   *  stale-clean: states the warning and arms the acknowledgement for the next click. */
  const [freshDirty, setFreshDirty] = useState(false)
  /** A dirty worktree needs the discard acknowledgement before sending `discardChanges`. */
  const needsDiscardConfirmation = target?.dirty === true || freshDirty
  /** Informational only: a removal never stops/deletes running sessions, so the
   *  note distinguishes the ARCHIVED ones (inert; their stop/purge belongs to the
   *  archive manager) from the NON-ARCHIVED ones (these block). Neither gates the
   *  confirm; on an OLD host the copy stays NEUTRAL (no fabricated archivedness). */
  const runningNotes = removeRunningNotes({
    runningSessionIds: target?.runningSessionIds ?? [],
    ...(target?.blockingRunningSessionIds === undefined
      ? {}
      : { blockingRunningSessionIds: target.blockingRunningSessionIds }),
  })
  /** Fail-closed pre-hint: while the runtime channel is absent the current session
   *  is UNKNOWN, so a worktree accounting sessions must not be removable — the
   *  confirm is disabled up front, mirroring the row's runtime-unknown hard block. */
  const runtimeUnknownBlock = !runtimeKnown && target !== null && target.sessionIds.length > 0
  /** Which discard authorization a `Remove` click still has to collect (the pure
   *  `nextDiscardGate`): the dirty working tree (design 08 §5.3) or submodule
   *  checkouts Git refuses without force. Read at CLICK time only; the gate itself
   *  renders from the held `discardGateOpen` kind. */
  const gateFacts: DiscardGateFacts = {
    needsDiscardConfirmation,
    discardChanges,
    submoduleBlock,
    discardSubmodules,
  }
  const pendingDiscardAuthorization = nextDiscardGate(gateFacts)
  const confirmDisabled = actionLocked || target === null || branchDeleteFailed
    // Unknown session impact must block a destructive delete — the user might unknowingly drop unarchived sessions.
    || sessionFactsError !== null
    || runtimeUnknownBlock

  // Enumerate the full session tree the removal would orphan, for explicit confirmation copy.
  const [factsAttempt, setFactsAttempt] = useState(0)
  useEffect(() => {
    setArchiveSessions(false)
    setDeleteBranch(false)
    setDiscardChanges(false)
    setFreshDirty(false)
    setSubmoduleBlock(false)
    setDiscardSubmodules(false)
    setDiscardGateOpen(null)
    setSessionFacts(null)
    setSessionFactsError(null)
    setRemoveError(null)
    setBranchDeleteFailed(false)
    if (target === null) return
    let cancelled = false
    void (async () => {
      try {
        const snapshot = await fetchInstanceSnapshot(getInstanceClient(sourceId))
        if (cancelled) return
        // Count ONLY the VISIBLE sessions: the raw row sessionIds still list
        // ARCHIVED sessions and subagent rows, which the sidebar hides.
        const archivedIds = new Set(snapshot.archivedSessionIds)
        const visible = (id: string): boolean => {
          const session = snapshot.sessions.find(candidate => candidate.sessionId === id)
          return session !== undefined && session.origin !== 'subagent'
            && !archivedIds.has(id) && !session.blank
        }
        const visibleRoots = target.sessionIds.filter(visible)
        const closure = collectSessionClosure(snapshot.sessions, visibleRoots).filter(visible)
        // Titles come from the sidebar aggregate (instance wire rows do not carry
        // them): match visible direct ids against the source's workspace sessions.
        const server = chamberBridge.getServers().find(candidate => candidate.id === sourceId)
        const titles = server === undefined
          ? []
          : server.workspaces.flatMap(workspace => workspace.sessions)
            .filter(session => visibleRoots.includes(session.id))
            // The RESOLVED label (design 05 §2.1), never the durable title alone:
            // session ids as keys (titles repeat constantly).
            .map(session => ({ id: session.id, title: session.displayTitle }))
        setSessionFacts({
          direct: visibleRoots.length,
          closure: closure.length,
          directTitles: titles,
        })
      } catch (error) {
        if (cancelled) return
        setSessionFactsError(errorMessage(error))
      }
    })()
    return () => { cancelled = true }
  }, [target, sourceId, factsAttempt])

  const close = (): void => {
    if (busy) return
    // Both dialogs listen for Escape on the document: without this the ack's dismissal would close this dialog too and lose the pending authorization.
    if (discardGateOpen !== null) return
    onClose()
  }

  const runRemove = async (): Promise<void> => {
    if (target === null) return
    setRemoveError(null)
    try {
      // Both authorizations map to the same `discardChanges` wire flag: --force
      // only under explicit consent; branch/commits/HEAD untouched.
      const result = await removeWorktree(sourceId, target, {
        archiveSessions,
        ...(deleteBranch && target.branch !== null ? { deleteBranch: target.branch } : {}),
        ...(discardAuthorized(gateFacts) ? { discardChanges: true } : {}),
      })
      // Honest outcome: a failed branch delete keeps the dialog open with an explanation.
      if (result.branchDeleteFailed === true) {
        setBranchDeleteFailed(true)
        return
      }
      onClose()
    } catch (error) {
      // Surface in-dialog; recovery also renders on the per-workspace line so the
      // source never stays locked. A dirty rejection or `worktree-submodules`
      // refusal arms the matching authorization for the NEXT click.
      if (isSubmoduleRefusal(error)) {
        setSubmoduleBlock(true)
        setDiscardSubmodules(false)
      } else {
        // Both the local preflight marker and the host's refusal carry the SAME
        // `worktree-dirty` code, so one check arms the discard acknowledgement.
        if (error instanceof WorktreeDirtyError || gitActionErrorCode(error) === 'worktree-dirty') setFreshDirty(true)
        // Every user-reachable refusal resolves its code to localized copy
        // (shared/action-error.ts); an unmapped failure keeps the raw message.
        setRemoveError(gitActionErrorText(error, t))
      }
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={close}
        title={t('removeTitle')}
        closeLabel={t('close')}
        className={css.dialog}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
            <Button
              variant="outline"
              className={css.danger}
              disabled={confirmDisabled}
              onClick={() => {
                // While a discard authorization is missing, `Remove` OPENS the
                // official acknowledgement for that kind; the removal runs from its confirm.
                if (pendingDiscardAuthorization !== null) {
                  setDiscardGateOpen(pendingDiscardAuthorization)
                  return
                }
                void runRemove()
              }}
            >
              {busy ? t('removing') : t('removeConfirm')}
            </Button>
          </>
        )}
      >
        {target !== null && (
          <div className={css.removeFacts}>
            <code>{target.path}</code>
            <span>{target.branch ?? t('detached')}</span>
            {sessionFacts !== null && sessionFacts.closure > 0 && (
              <span className={css.removeSessions}>
                {t('removeSessions')} {sessionFacts.direct}
                {sessionFacts.closure > sessionFacts.direct
                  && t('removeSubsessionsCount').replace('{count}', String(sessionFacts.closure - sessionFacts.direct))}
              </span>
            )}
            {sessionFactsError !== null && (
              <span className={css.formError} role="alert">
                {sessionFactsError}
                <button
                  type="button"
                  className={css.factsRetry}
                  onClick={() => { setFactsAttempt(attempt => attempt + 1) }}
                >
                  {t('retry')}
                </button>
              </span>
            )}
            {sessionFacts !== null && sessionFacts.directTitles.length > 0 && (
              <ul className={css.sessionTitles}>
                {sessionFacts.directTitles.slice(0, 5).map(session => (
                  <li key={session.id} title={session.title}>{session.title}</li>
                ))}
                {sessionFacts.directTitles.length > 5 && (
                  <li className={css.sessionTitlesMore}>{t('sessionTitlesMore').replace('{n}', String(sessionFacts.directTitles.length - 5))}</li>
                )}
              </ul>
            )}
            {removeError !== null && <span className={css.formError} role="alert">{removeError}</span>}
            {branchDeleteFailed && (
              <span className={css.formError} role="alert">{t('branchDeleteFailedNote')}</span>
            )}
            {/* The discard FACTS stay stated in place — the RiskConfirmation below is the gate. */}
            {needsDiscardConfirmation && (
              <div className={css.dirtyWarning}>
                <span role="alert">{t('dirtyDiscardWarning')}</span>
              </div>
            )}
            {submoduleBlock && (
              <div className={css.dirtyWarning}>
                <span role="alert">{t('submoduleDiscardWarning')}</span>
              </div>
            )}
            {runtimeUnknownBlock && (
              <div className={css.dirtyWarning}>
                <span role="alert">{t('runtimeUnknownBlocked')}</span>
              </div>
            )}
            {runningNotes.kind === 'blocking' && (
              <div className={css.dirtyWarning}>
                <span role="alert">{t('runningRemoveBlockNote').replace('{count}', String(runningNotes.blockingCount))}</span>
              </div>
            )}
            {runningNotes.kind === 'legacy' && (
              <div className={css.dirtyWarning}>
                <span role="alert">{t('runningRemoveLegacyNote').replace('{count}', String(runningNotes.blockingCount))}</span>
              </div>
            )}
            {runningNotes.inertCount > 0 && (
              <div className={css.dirtyWarning}>
                <span>{t('runningRemoveArchivedNote').replace('{count}', String(runningNotes.inertCount))}</span>
              </div>
            )}
            <label className={css.archiveToggle}>
              <input
                type="checkbox"
                checked={archiveSessions}
                disabled={actionLocked}
                onChange={event => setArchiveSessions(event.target.checked)}
              />
              <span>{t('archiveSessionsLabel')}</span>
            </label>
            {target.branch !== null && (
              <label className={css.archiveToggle}>
                <input
                  type="checkbox"
                  checked={deleteBranch}
                  disabled={actionLocked}
                  onChange={event => setDeleteBranch(event.target.checked)}
                />
                <span>{t('deleteBranchLabel')}</span>
              </label>
            )}
          </div>
        )}
      </Modal>
      {/* Official risk acknowledgement: warning icon + autofocused checkbox and a
          confirm unavailable until checked. Both discard authorizations ride it; the
          KIND in `discardGateOpen` decides copy/box, and confirming retries the
          same removal through the single `discardChanges` flag. */}
      <RiskConfirmation
        open={discardGateOpen !== null}
        title={discardGateOpen === 'submodule' ? t('submoduleDiscardTitle') : t('dirtyDiscardTitle')}
        description={discardGateOpen === 'submodule' ? t('submoduleDiscardWarning') : t('dirtyDiscardWarning')}
        acknowledgeLabel={discardGateOpen === 'submodule' ? t('submoduleDiscardLabel') : t('dirtyDiscardLabel')}
        cancelLabel={t('cancel')}
        closeLabel={t('close')}
        confirmLabel={t('removeConfirm')}
        acknowledged={discardGateOpen === 'submodule' ? discardSubmodules : discardChanges}
        disabled={actionLocked}
        onAcknowledgedChange={(acknowledged) => {
          if (discardGateOpen === 'submodule') setDiscardSubmodules(acknowledged)
          else setDiscardChanges(acknowledged)
        }}
        onCancel={() => {
          // Cancel/close/mask/Escape revokes the acknowledgement: the removal
          // stays gated, so the next `Remove` click re-opens the same gate.
          if (discardGateOpen === 'submodule') setDiscardSubmodules(false)
          else setDiscardChanges(false)
          setDiscardGateOpen(null)
        }}
        onConfirm={() => {
          setDiscardGateOpen(null)
          void runRemove()
        }}
      />
    </>
  )
}
