/** Remove-worktree dialog shared by the per-workspace Git occupant. */
import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { chamberBridge, fetchInstanceSnapshot, getInstanceClient } from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import { gitCoordinator, removeWorktree } from '../shared/coordinator.ts'
import { collectSessionClosure } from '../shared/git-facts.ts'
import type { WorkspaceGitInjected } from './injected.ts'
import css from './SidebarGit.module.css'

export interface RemoveViewTarget {
  repoId: string
  worktreeId: string
  path: string
  branch: string | null
  sessionIds: string[]
}

interface RemoveSessionFacts {
  direct: number
  closure: number
  /** Direct sessions (id + title, up to the render cap); the rest are counted. */
  directTitles: Array<{ id: string; title: string }>
}

export interface RemoveWorktreeDialogProps {
  open: boolean
  onClose: () => void
  /** The source whose instance runs the removal saga. */
  sourceId: string
  target: RemoveViewTarget | null
  t: WorkspaceGitInjected['t']
}

/** One source-scoped remove dialog; session-closure facts are fetched on open. */
export function RemoveWorktreeDialog({
  open, onClose, sourceId, target, t,
}: RemoveWorktreeDialogProps): React.ReactNode {
  const source = gitCoordinator.getSource(sourceId)
  const [sessionFacts, setSessionFacts] = useState<RemoveSessionFacts | null>(null)
  const [sessionFactsError, setSessionFactsError] = useState<string | null>(null)
  const [archiveSessions, setArchiveSessions] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  /** Set when the removal succeeded but the optional branch delete failed. */
  const [branchDeleteFailed, setBranchDeleteFailed] = useState(false)

  const busy = source?.busy !== undefined
  const actionLocked = busy || source?.recovery !== undefined

  // Enumerate the full session tree (direct + transitive subsessions) the
  // removal would orphan, for explicit confirmation copy.
  const [factsAttempt, setFactsAttempt] = useState(0)
  useEffect(() => {
    setArchiveSessions(false)
    setDeleteBranch(false)
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
        // Count ONLY the VISIBLE sessions: the raw worktree row sessionIds
        // come from the wire's workspace.sessionIds, which still lists
        // ARCHIVED sessions (and subagent rows) — the sidebar hides them, so
        // the removal count must too (2026-08 user report: "关联会话 2" with
        // nothing visible). Roots and their transitive subsessions are both
        // filtered to the visible set.
        const archivedIds = new Set(snapshot.archivedSessionIds)
        const visible = (id: string): boolean => {
          const session = snapshot.sessions.find(candidate => candidate.sessionId === id)
          return session !== undefined && session.origin !== 'subagent'
            && !archivedIds.has(id) && !session.blank
        }
        const visibleRoots = target.sessionIds.filter(visible)
        const closure = collectSessionClosure(snapshot.sessions, visibleRoots).filter(visible)
        // Titles come from the sidebar aggregate (the instance wire rows do
        // not carry them): match visible direct session ids against the
        // source's workspace sessions.
        const server = chamberBridge.getServers().find(candidate => candidate.id === sourceId)
        const titles = server === undefined
          ? []
          : server.workspaces.flatMap(workspace => workspace.sessions)
            .filter(session => visibleRoots.includes(session.id))
            // Session ids as keys: titles repeat constantly (P2-3).
            .map(session => ({ id: session.id, title: session.title }))
        setSessionFacts({
          direct: visibleRoots.length,
          closure: closure.length,
          directTitles: titles,
        })
      } catch (error) {
        if (cancelled) return
        setSessionFactsError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { cancelled = true }
  }, [target, sourceId, factsAttempt])

  const close = (): void => {
    if (busy) return
    onClose()
  }

  const runRemove = async (): Promise<void> => {
    if (target === null) return
    setRemoveError(null)
    try {
      const result = await removeWorktree(sourceId, target, {
        archiveSessions,
        ...(deleteBranch && target.branch !== null ? { deleteBranch: target.branch } : {}),
      })
      // Honest outcome (2026-08 client review): a failed branch delete keeps
      // the dialog open with an explanation — the worktree removal stands.
      if (result.branchDeleteFailed === true) {
        setBranchDeleteFailed(true)
        return
      }
      onClose()
    } catch (error) {
      // Surface the failure in-dialog; recovery (ambiguous failures) also
      // renders on the per-workspace line so the source can never stay locked.
      setRemoveError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('removeTitle')}
      closeLabel={t('close')}
      className={css.dialog}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className={css.danger} disabled={actionLocked || target === null || branchDeleteFailed
            // Unknown session impact must block a destructive delete — the
            // user might unknowingly drop unarchived sessions (review P2-6).
            || sessionFactsError !== null} onClick={() => { void runRemove() }}>
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
  )
}
