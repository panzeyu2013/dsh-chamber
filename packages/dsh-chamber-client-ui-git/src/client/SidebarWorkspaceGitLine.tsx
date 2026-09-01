/**
 * Per-workspace Git occupant (design 08 §11, workspace-centric discovery).
 * The sidebar renders this seat twice per source:
 *  - once with `workspaceId === ''` (source scope) — the source-level alert
 *    strip: recovery (with retry — a pending recovery blocks every git action
 *    on the source and is only cleared by retrying it) and action errors.
 *    Snapshot/install errors are NOT shown here (a missing host degrades to
 *    an ordinary no-worktree source; the injection state lives in the
 *    connections chamber block).
 *  - once per workspace group, INSIDE the workspace header row (OpenChamber-
 *    style: the workspace row IS the git surface, no separate branch line).
 *    A worktree-workspace shows its branch chip (its identity); every git
 *    workspace shows the hover-revealed create-worktree action left of the
 *    row's new-session "+", and worktree workspaces a delete action. Non-git
 *    workspaces render nothing.
 */
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  IconBranchOutline16, IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { chamberBridge } from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import {
  clearActionError, createSessionHere, currentSessionIsBlank, gitCoordinator, removeUnregisteredWorktree, retryRecovery,
} from '../shared/coordinator.ts'
import { gitFactsForWorkspace, removeBlockReason } from '../shared/git-facts.ts'
import type { GitBusyKind, GitRecovery } from '../shared/types.ts'
import type { GitSidebarKey } from '../locales.ts'
import { CreateWorktreeDialog } from './CreateWorktreeDialog.tsx'
import { RemoveWorktreeDialog, type RemoveViewTarget } from './RemoveWorktreeDialog.tsx'
import css from './SidebarGit.module.css'

function pathName(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/** Occurrence context the sidebar passes: source scope when workspaceId === ''
 *  (with an optional repoKey for the repository's UNREGISTERED worktree
 *  block — Plan A). */
export interface WorkspaceGitContext {
  sourceId: string
  workspaceId: string
  repoKey?: string
}

export interface SidebarWorkspaceGitInjected {
  t: (key: GitSidebarKey) => string
}

/** Composed component props: the slot-inject context hook arrives bound. */
export type SidebarWorkspaceGitLineProps = SidebarWorkspaceGitInjected & {
  wide: boolean
  useWorkspaceGitContext: () => WorkspaceGitContext
}

function recoveryLabel(recovery: GitRecovery, t: SidebarWorkspaceGitInjected['t']): string {
  if (recovery.kind === 'git-create') return t('recoveryGitCreate')
  if (recovery.kind === 'rollback-create') return t('recoveryRollback')
  if (recovery.kind === 'workspace-adopt') return t('recoveryWorkspaceAdopt')
  if (recovery.kind === 'session-adopt') return t('recoverySessionAdopt')
  if (recovery.kind === 'session-create') return t('recoverySession')
  if (recovery.kind === 'git-remove') return t('recoveryGitRemove')
  return t('recoveryWorkspaceDelete')
}

function busyLabel(kind: GitBusyKind, t: SidebarWorkspaceGitInjected['t']): string {
  if (kind === 'preview') return t('busyPreview')
  if (kind === 'create') return t('busyCreate')
  if (kind === 'remove') return t('busyRemove')
  if (kind === 'adopt-session') return t('busyAdoptSession')
  return t('busyRecovery')
}

function blockLabel(reason: ReturnType<typeof removeBlockReason>, t: SidebarWorkspaceGitInjected['t']): string | undefined {
  if (reason === 'running') return t('runningBlocked')
  if (reason === 'current') return t('currentBlocked')
  if (reason === 'runtime-unknown') return t('runtimeUnknownBlocked')
  if (reason === 'locked') return t('lockedBlocked')
  if (reason === 'unhealthy') return t('unhealthyBlocked')
  if (reason === 'dirty') return t('dirtyBlocked')
  if (reason === 'status-unknown') return t('dirtyUnknownBlocked')
  return undefined
}

export function SidebarWorkspaceGitLine({
  wide, t, useWorkspaceGitContext,
}: SidebarWorkspaceGitLineProps): ReactNode {
  useSyncExternalStore(gitCoordinator.subscribe, gitCoordinator.getVersion, gitCoordinator.getVersion)
  const context = useWorkspaceGitContext()
  const [createOpen, setCreateOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<RemoveViewTarget | null>(null)

  // The current session is per-SOURCE (this occupant renders inside every
  // source's workspace groups, not only the current instance's). The runtime
  // channel object doubles as the fail-closed presence flag: when it is
  // absent (withdrawn while the shell reconnects/reloads), the current
  // session is UNKNOWN, not "none" — removeBlockReason blocks accordingly.
  const runtime = useSyncExternalStore(
    chamberBridge.subscribe,
    () => context === undefined
      ? undefined
      : chamberBridge.getServers().find(server => server.id === context.sourceId)?.runtime,
    () => undefined,
  )
  const currentSessionId = runtime?.current
  const runtimeKnown = runtime !== undefined

  if (!wide || context === undefined) return null
  const source = gitCoordinator.getSource(context.sourceId)

  // ---- Source-scope mount: the alert strip (recovery / action errors). ----
  // ---- Repository-scope mount (Plan A): the repo's UNREGISTERED worktrees
  // (no dsh workspace). Rendered by the sidebar after the repo's last
  // registered workspace; each row offers register+new-session and removal.
  if (context.workspaceId === '' && context.repoKey !== undefined) {
    if (source.sourceError !== undefined) return null
    const repo = source.snapshot?.repos.find(candidate => candidate.repoId === context.repoKey)
    // The MAIN checkout is never unregistered (user report 2026-08: a main
    // folder was mistaken for an external worktree).
    const unregistered = repo?.worktrees
      .filter(worktree => worktree.workspaceId === null && !worktree.isMain) ?? []
    if (repo === undefined || unregistered.length === 0) return null
    const busy = source.busy !== undefined
    return (
      <div className={css.unregisteredSection} role="group" aria-label={t('unregisteredTitle')}>
        <span className={css.unregisteredHeading}>{t('unregisteredTitle')}</span>
        {unregistered.map((worktree) => {
          // Mirrors removeBlockReason: main checkout / dirty / locked /
          // unhealthy all reject at the host — keep the button honest
          // (review P2-5). Deliberate asymmetry (review 2026-08 P2-2):
          // the REGISTERED occupant offers the discard-changes dialog for
          // dirty worktrees, but this unregistered row's window.confirm flow
          // cannot collect that authorization, so dirty stays hard-blocked.
          const blocked = worktree.status !== 'ready' || worktree.locked
            || worktree.isMain || worktree.dirty === true
          return (
            <div className={css.unregisteredRow} key={worktree.worktreeId} role="group">
              <IconBranchOutline16 size={14} className={css.unregisteredIcon} />
              <span className={css.unregisteredName} title={worktree.path}>
                {worktree.branch ?? pathName(worktree.path)}
              </span>
              {worktree.status !== 'ready' && (
                <span className={`${css.unregisteredStatus} ${css.unregisteredStatusWarn}`}>
                  {worktree.status === 'not-a-repo' ? t('notARepo') : t(worktree.status)}
                </span>
              )}
              <span className={css.unregisteredSpacer} />
              <button
                type="button"
                className={css.unregisteredAction}
                disabled={busy || source.recovery !== undefined
                  // A vanished/missing path cannot host a session — the
                  // adopt would fail at the host anyway (cross-review P3-4).
                  || worktree.status !== 'ready'}
                title={worktree.status === 'ready' ? t('unregisteredAdoptTitle') : t('unregisteredBlocked')}
                aria-label={t('unregisteredAdopt')}
                onClick={() => { void createSessionHere(context.sourceId, worktree.path).catch(() => {}) }}
              >
                <IconPlusOutline16 size={14} />
              </button>
              <button
                type="button"
                className={`${css.unregisteredAction} ${css.unregisteredActionDanger}`}
                disabled={busy || source.recovery !== undefined || blocked}
                title={blocked ? t('unregisteredBlocked') : t('remove')}
                aria-label={t('remove')}
                onClick={() => {
                  if (!window.confirm(t('unregisteredRemoveConfirm').replace('{name}', pathName(worktree.path)))) return
                  void removeUnregisteredWorktree(context.sourceId, {
                    repoId: repo.repoId,
                    worktreeId: worktree.worktreeId,
                    path: worktree.path,
                    branch: worktree.branch,
                    head: worktree.head,
                  }).catch(() => {})
                }}
              >
                <IconTrashOutline16 size={14} />
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  if (context.workspaceId === '') {
    const recovery = source.recovery
    const actionError = source.actionError
    if (recovery === undefined && actionError === undefined) return null
    const busy = source.busy !== undefined
    return (
      <div className={css.wsSourceAlert} role="alert">
        {recovery !== undefined && (
          <span className={css.wsSourceAlertText}>
            {busyLabel(source.busy?.kind ?? 'recovery', t)}{t('busySeparator')}{recoveryLabel(recovery, t)} {recovery.message}
          </span>
        )}
        {actionError !== undefined && (
          <span className={css.wsSourceAlertText}>{t('actionError')} {actionError}</span>
        )}
        {recovery !== undefined && (
          <button
            type="button"
            className={css.wsRetry}
            disabled={busy}
            onClick={() => { void retryRecovery(context.sourceId).catch(() => {}) }}
          >
            <IconRefreshOutline16 size={12} />
            {t('retry')}
          </button>
        )}
        {actionError !== undefined && (
          <button
            type="button"
            className={css.wsRetry}
            onClick={() => clearActionError(context.sourceId)}
          >
            {t('dismiss')}
          </button>
        )}
      </div>
    )
  }

  // ---- Workspace-scope mount: inline content for the workspace header row. ----
  // A source-level snapshot failure (host not loaded / transport) hides the
  // possibly-stale rows: the source degrades to an ordinary no-worktree view.
  const snapshot = source.snapshot
  const rows = snapshot === undefined || source.sourceError !== undefined
    ? []
    : gitFactsForWorkspace(snapshot, context.workspaceId)
  if (rows.length === 0) return null

  const primary = rows[0]!.worktree
  const busy = source.busy !== undefined
  const actionLocked = busy || source.recovery !== undefined
  const blocked = removeBlockReason(primary, currentSessionId, currentSessionIsBlank(context.sourceId, currentSessionId), runtimeKnown)
  // Only worktree workspaces (not the repo's main checkout) can be removed as
  // worktrees; the sidebar's own workspace kebab handles plain deletion.
  const canOfferRemove = !primary.isMain && primary.workspaceId !== null
  const createDisabled = actionLocked || source.connected !== true

  return (
    <>
      <span className={css.headerGit} role="group" aria-label={t('title')}>
        {primary.isMain && (
          // No second-level derivation (OpenChamber parity): worktrees are
          // created only from the repository's MAIN checkout, never from a
          // derived worktree workspace.
          <button
            type="button"
            className={`${css.headerGitAction} git-ws-action`}
            disabled={createDisabled}
            aria-label={t('createBranchWorktree')}
            title={t('createBranchWorktree')}
            onClick={() => setCreateOpen(true)}
          >
            <IconBranchOutline16 size={16} />
          </button>
        )}
        {!primary.isMain && canOfferRemove && (
          <button
            type="button"
            className={`${css.headerGitAction} git-ws-action`}
            // A dirty worktree is NOT disabled: the remove dialog collects an
            // explicit discard-changes checkbox instead (design 08 §6
            // amendment 2026-08). Every other block (running/current/locked/
            // unhealthy/status-unknown) stays a hard disable.
            disabled={actionLocked || (blocked !== undefined && blocked !== 'dirty')}
            aria-label={blocked === 'dirty' ? t('dirtyRemoveTitle') : (blockLabel(blocked, t) ?? t('remove'))}
            title={blocked === 'dirty' ? t('dirtyRemoveTitle') : (blockLabel(blocked, t) ?? t('remove'))}
            onClick={() => setRemoveTarget({
              repoId: rows[0]!.repoId,
              worktreeId: primary.worktreeId,
              path: primary.path,
              branch: primary.branch,
              sessionIds: primary.sessionIds,
              dirty: primary.dirty === true,
            })}
          >
            <IconTrashOutline16 size={16} />
          </button>
        )}
      </span>
      <CreateWorktreeDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        sourceId={context.sourceId}
        initialWorkspaceId={context.workspaceId}
        initialRepoId={rows[0]!.repoId}
        t={t}
      />
      <RemoveWorktreeDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        sourceId={context.sourceId}
        target={removeTarget}
        t={t}
      />
    </>
  )
}
