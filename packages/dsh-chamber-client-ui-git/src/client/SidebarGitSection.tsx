import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconBranchOutline16, IconLoadingOutline16, IconPlusOutline16,
  IconRefreshOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { chamberBridge } from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import {
  clearActionError, createFromPreview, createSessionHere, gitCoordinator, previewCreate,
  refreshSource, removeWorktree, retryRecovery,
} from '../shared/coordinator.ts'
import { canTargetSession, createSourceOptions, removeBlockReason, shortHead } from '../shared/git-facts.ts'
import type {
  GitBranchSpec, GitBusyKind, GitRecovery, GitWorktreeInfo, PreviewCreateResult,
} from '../shared/types.ts'
import type { GitSidebarKey } from '../locales.ts'
import css from './SidebarGitSection.module.css'

export interface SidebarGitInjected {
  t: (key: GitSidebarKey) => string
  chamberInstanceId?: string
}

export type SidebarGitSectionProps = SidebarGitInjected & { wide: boolean }

interface RemoveViewTarget {
  repoId: string
  worktreeId: string
  path: string
  branch: string | null
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).at(-1) || path
}

function busyLabel(kind: GitBusyKind, t: SidebarGitInjected['t']): string {
  if (kind === 'preview') return t('busyPreview')
  if (kind === 'create') return t('busyCreate')
  if (kind === 'remove') return t('busyRemove')
  if (kind === 'adopt-session') return t('busyAdoptSession')
  return t('busyRecovery')
}

function recoveryLabel(recovery: GitRecovery, t: SidebarGitInjected['t']): string {
  if (recovery.kind === 'git-create') return t('recoveryGitCreate')
  if (recovery.kind === 'rollback-create') return t('recoveryRollback')
  if (recovery.kind === 'workspace-adopt') return t('recoveryWorkspaceAdopt')
  if (recovery.kind === 'session-adopt') return t('recoverySessionAdopt')
  if (recovery.kind === 'session-create') return t('recoverySession')
  if (recovery.kind === 'git-remove') return t('recoveryGitRemove')
  return t('recoveryWorkspaceDelete')
}

function blockLabel(reason: ReturnType<typeof removeBlockReason>, t: SidebarGitInjected['t']): string | undefined {
  if (reason === 'running') return t('runningBlocked')
  if (reason === 'current') return t('currentBlocked')
  if (reason === 'locked') return t('lockedBlocked')
  if (reason === 'unhealthy') return t('unhealthyBlocked')
  if (reason === 'dirty') return t('dirtyBlocked')
  if (reason === 'status-unknown') return t('dirtyUnknownBlocked')
  return undefined
}

function WorktreeRow({
  repoId, worktree, currentSessionId, busy, t, onRemove, onNewSession,
}: {
  repoId: string
  worktree: GitWorktreeInfo
  currentSessionId?: string
  busy: boolean
  t: SidebarGitInjected['t']
  onRemove: (target: RemoveViewTarget) => void
  onNewSession: (worktree: GitWorktreeInfo) => void
}): ReactNode {
  const blocked = removeBlockReason(worktree, currentSessionId)
  const blockedLabel = blockLabel(blocked, t)
  const canOfferRemove = !worktree.isMain && worktree.workspaceId !== null
  const sessionTargetable = canTargetSession(worktree)
  const isCurrent = currentSessionId !== undefined && worktree.sessionIds.includes(currentSessionId)
  const attentionLabels: Record<string, GitSidebarKey> = {
    merge: 'attentionMerge',
    rebase: 'attentionRebase',
    'cherry-pick': 'attentionCherryPick',
    revert: 'attentionRevert',
    bisect: 'attentionBisect',
  }
  return (
    <li className={css.worktree}>
      <div className={css.worktreeHead}>
        <span className={css.branch} title={worktree.branch ?? t('detached')}>
          <IconBranchOutline16 size={14} />
          <span>{worktree.branch ?? t('detached')}</span>
        </span>
        <code className={css.head}>{shortHead(worktree.head)}</code>
        <button
          type="button"
          className={css.iconButton}
          disabled={busy || !sessionTargetable}
          aria-label={t('newSessionHere')}
          title={sessionTargetable ? t('newSessionHere') : t('unhealthyTarget')}
          onClick={() => onNewSession(worktree)}
        >
          <IconPlusOutline16 size={14} />
        </button>
        {canOfferRemove && (
          <button
            type="button"
            className={css.iconButton}
            disabled={busy || blocked !== undefined}
            aria-label={t('remove')}
            title={blockedLabel ?? t('remove')}
            onClick={() => onRemove({
              repoId, worktreeId: worktree.worktreeId, path: worktree.path, branch: worktree.branch,
            })}
          >
            <IconTrashOutline16 size={14} />
          </button>
        )}
      </div>
      <div className={css.path} title={worktree.path}>{worktree.path}</div>
      <div className={css.badges}>
        {worktree.isMain && <span className={css.badge}>{t('main')}</span>}
        {worktree.status === 'missing' && <span className={`${css.badge} ${css.badgeError}`}>{t('missing')}</span>}
        {worktree.status === 'invalid' && <span className={`${css.badge} ${css.badgeError}`}>{t('invalid')}</span>}
        {worktree.status === 'not-a-repo' && <span className={`${css.badge} ${css.badgeError}`}>{t('notARepo')}</span>}
        {worktree.headState === 'unborn' && <span className={`${css.badge} ${css.badgeWarn}`}>{t('unborn')}</span>}
        {worktree.headState === 'detached' && <span className={css.badge}>{t('detached')}</span>}
        {worktree.attention.map(reason => (
          <span className={`${css.badge} ${css.badgeWarn}`} key={reason}>
            {t(attentionLabels[reason] ?? 'attentionMerge')}
          </span>
        ))}
        <span className={css.badge}>
          {worktree.dirty === true ? t('dirty') : worktree.dirty === false ? t('clean') : t('dirtyUnknown')}
        </span>
        {worktree.locked && <span className={css.badge}>{t('locked')}</span>}
        {isCurrent && <span className={`${css.badge} ${css.badgeLive}`}>{t('current')}</span>}
        {worktree.sessionIds.length > 0 && (
          <span className={css.badge}>{t('sessions')} {worktree.sessionIds.length}</span>
        )}
        {worktree.runningSessionIds.length > 0 && (
          <span className={`${css.badge} ${css.badgeLive}`}>{t('running')} {worktree.runningSessionIds.length}</span>
        )}
      </div>
    </li>
  )
}

/** One instance-scoped occupant. Every durable/action fact comes from the page singleton. */
export function SidebarGitSection({ wide, chamberInstanceId, t }: SidebarGitSectionProps): ReactNode {
  useSyncExternalStore(gitCoordinator.subscribe, gitCoordinator.getVersion, gitCoordinator.getVersion)
  const currentSessionId = useSyncExternalStore(
    chamberBridge.subscribe,
    () => chamberBridge.getServers().find(server => server.id === chamberInstanceId)?.runtime?.current,
    () => undefined,
  )
  const source = chamberInstanceId === undefined ? undefined : gitCoordinator.getSource(chamberInstanceId)
  const [createOpen, setCreateOpen] = useState(false)
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState('')
  const [basenameDraft, setBasenameDraft] = useState('')
  const [branchMode, setBranchMode] = useState<GitBranchSpec['kind']>('new')
  const [branchName, setBranchName] = useState('')
  const [preview, setPreview] = useState<PreviewCreateResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<RemoveViewTarget | null>(null)

  const options = useMemo(
    () => source?.snapshot === undefined ? [] : createSourceOptions(source.snapshot),
    [source?.snapshot],
  )
  const busy = source?.busy !== undefined
  const actionLocked = busy || source?.recovery !== undefined

  // Dialog source options can change after an explicit/poll refresh. Keep a
  // valid selection, or move to the first repository without inventing one.
  useEffect(() => {
    if (!createOpen) return
    if (!options.some(option => option.workspaceId === sourceWorkspaceId)) {
      setSourceWorkspaceId(options[0]?.workspaceId ?? '')
      setPreview(null)
    }
  }, [createOpen, options, sourceWorkspaceId])

  if (!wide) return null
  if (chamberInstanceId === undefined || source === undefined) return null

  const openCreate = (): void => {
    setSourceWorkspaceId(options[0]?.workspaceId ?? '')
    setBasenameDraft('')
    setBranchMode('new')
    setBranchName('')
    setPreview(null)
    setFormError(null)
    setCreateOpen(true)
  }

  const closeCreate = (): void => {
    if (busy) return
    setCreateOpen(false)
    setPreview(null)
    setFormError(null)
  }

  const runPreview = async (): Promise<void> => {
    const cleanBasename = basenameDraft.trim()
    const cleanBranch = branchName.trim()
    if (sourceWorkspaceId === '' || cleanBasename === '' || cleanBranch === '') return
    setFormError(null)
    setPreview(null)
    try {
      setPreview(await previewCreate(chamberInstanceId, {
        sourceWorkspaceId,
        basename: cleanBasename,
        branch: { kind: branchMode, name: cleanBranch },
      }))
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    }
  }

  const runCreate = async (): Promise<void> => {
    if (preview === null) return
    if (preview.expiresAt <= Date.now()) {
      setPreview(null)
      setFormError(t('previewExpired'))
      return
    }
    setFormError(null)
    try {
      await createFromPreview(chamberInstanceId, preview)
      setCreateOpen(false)
      setPreview(null)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    }
  }

  const runRemove = async (): Promise<void> => {
    if (removeTarget === null) return
    try {
      await removeWorktree(chamberInstanceId, removeTarget)
      setRemoveTarget(null)
    } catch {
      // The coordinator owns the page-wide actionable error/recovery state.
    }
  }

  const runNewSession = async (worktree: GitWorktreeInfo): Promise<void> => {
    try {
      await createSessionHere(chamberInstanceId, worktree.path)
    } catch {
      // The coordinator owns the page-wide actionable error/recovery state.
    }
  }

  const snapshot = source.snapshot
  const sourceError = source.sourceError ?? snapshot?.sourceError
  const formReady = sourceWorkspaceId !== '' && basenameDraft.trim() !== '' && branchName.trim() !== ''

  return (
    <section className={css.root} aria-label={t('title')}>
      <div className={css.sectionHead}>
        <span className={css.title}><IconBranchOutline16 size={16} />{t('title')}</span>
        {source.busy !== undefined && (
          <span className={css.busy}><IconLoadingOutline16 size={13} />{busyLabel(source.busy.kind, t)}</span>
        )}
        <button
          type="button"
          className={css.iconButton}
          disabled={!source.connected || busy}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { void refreshSource(chamberInstanceId, true) }}
        >
          <IconRefreshOutline16 size={14} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          disabled={!source.connected || actionLocked || options.length === 0}
          aria-label={t('create')}
          title={options.length === 0 ? t('noRegisteredRepo') : t('create')}
          onClick={openCreate}
        >
          <IconPlusOutline16 size={14} />
        </button>
      </div>

      {source.recovery !== undefined && (
        <div className={css.recovery} role="alert">
          <strong>{t('recoveryTitle')}</strong>
          <span>{recoveryLabel(source.recovery, t)} {source.recovery.message}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void retryRecovery(chamberInstanceId).catch(() => {}) }}>
            {t('retry')}
          </Button>
        </div>
      )}

      {source.actionError !== undefined && (
        <div className={css.error} role="alert">
          <span>{source.actionError}</span>
          <button type="button" className={css.dismiss} onClick={() => clearActionError(chamberInstanceId)}>{t('dismiss')}</button>
        </div>
      )}

      {!source.connected
        ? <p className={css.placeholder}>{t('unavailable')}</p>
        : source.status === 'loading' && snapshot === undefined
          ? <p className={css.placeholder}>{t('loading')}</p>
          : (
            <div className={css.scroll}>
              {sourceError !== undefined && <p className={css.error} role="alert">{sourceError.message}</p>}
              {snapshot !== undefined && snapshot.errors.length > 0 && (
                <details className={css.partial}>
                  <summary>{t('partialError')} ({snapshot.errors.length})</summary>
                  <ul>{snapshot.errors.map((error, index) => <li key={`${error.code}-${index}`}>{error.message}</li>)}</ul>
                </details>
              )}
              {snapshot !== undefined && snapshot.repos.length === 0 && sourceError === undefined && (
                <p className={css.placeholder}>{t('empty')}</p>
              )}
              {snapshot?.repos.map(repo => (
                <section className={css.repo} key={repo.repoId}>
                  <div className={css.repoHead}>
                    <strong title={repo.mainPath}>{basename(repo.mainPath)}</strong>
                    <span>{repo.worktrees.length}</span>
                  </div>
                  <ul className={css.worktrees}>
                    {repo.worktrees.map(worktree => (
                      <WorktreeRow
                        key={worktree.worktreeId}
                        repoId={repo.repoId}
                        worktree={worktree}
                        currentSessionId={currentSessionId}
                        busy={actionLocked}
                        t={t}
                        onRemove={setRemoveTarget}
                        onNewSession={worktree => { void runNewSession(worktree) }}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title={t('createTitle')}
        closeLabel={t('close')}
        className={css.dialog}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={closeCreate}>{t('cancel')}</Button>
            {preview === null
              ? <Button disabled={actionLocked || !formReady} onClick={() => { void runPreview() }}>{busy ? t('previewing') : t('preview')}</Button>
              : <Button disabled={actionLocked} onClick={() => { void runCreate() }}>{busy ? t('creating') : t('createConfirm')}</Button>}
          </>
        )}
      >
        <div className={css.fields}>
          <label>
            <span>{t('sourceWorkspace')}</span>
            <select value={sourceWorkspaceId} disabled={actionLocked} onChange={event => { setSourceWorkspaceId(event.target.value); setPreview(null) }}>
              {options.map(option => <option value={option.workspaceId} key={option.repoId}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span>{t('basename')}</span>
            <input value={basenameDraft} disabled={actionLocked} placeholder={t('basenamePlaceholder')} onChange={event => { setBasenameDraft(event.target.value); setPreview(null) }} />
          </label>
          <label>
            <span>{t('branchMode')}</span>
            <select value={branchMode} disabled={actionLocked} onChange={event => { setBranchMode(event.target.value as GitBranchSpec['kind']); setPreview(null) }}>
              <option value="new">{t('branchNew')}</option>
              <option value="existing">{t('branchExisting')}</option>
            </select>
          </label>
          <label>
            <span>{t('branchName')}</span>
            <input value={branchName} disabled={actionLocked} placeholder={t('branchPlaceholder')} onChange={event => { setBranchName(event.target.value); setPreview(null) }} />
          </label>
          <p className={css.securityHint}>{t('createFilterWarning')}</p>
          {preview !== null && (
            <div className={css.preview}>
              <div><span>{t('previewTarget')}</span><code>{preview.targetPath}</code></div>
              <div><span>{t('previewBranch')}</span><code>{preview.branch}</code></div>
              <div><span>{t('previewBase')}</span><code>{shortHead(preview.baseHead)}</code></div>
            </div>
          )}
          {formError !== null && <p className={css.formError} role="alert">{formError}</p>}
        </div>
      </Modal>

      <Modal
        open={removeTarget !== null}
        onClose={() => { if (!busy) setRemoveTarget(null) }}
        title={t('removeTitle')}
        closeLabel={t('close')}
        description={t('removeDescription')}
        className={css.dialog}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => setRemoveTarget(null)}>{t('cancel')}</Button>
            <Button variant="outline" className={css.danger} disabled={actionLocked} onClick={() => { void runRemove() }}>
              {busy ? t('removing') : t('removeConfirm')}
            </Button>
          </>
        )}
      >
        {removeTarget !== null && (
          <div className={css.removeFacts}>
            <code>{removeTarget.path}</code>
            <span>{removeTarget.branch ?? t('detached')}</span>
          </div>
        )}
      </Modal>
    </section>
  )
}
