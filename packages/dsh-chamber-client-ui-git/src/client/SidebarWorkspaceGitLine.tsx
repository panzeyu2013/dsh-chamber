/**
 * Per-workspace Git occupant (design 08 §3.2, workspace-centric discovery). The
 * sidebar renders this seat twice per source:
 *  - `workspaceId === ''` (source scope): the source-level alert strip —
 *    recovery (retry clears it; a pending recovery blocks every git action on
 *    the source) and action errors. Snapshot/install errors are NOT shown here;
 *  - once per workspace group, INSIDE the header row: a worktree shows its
 *    branch chip, every git workspace the create-worktree action, worktree
 *    workspaces a delete action; non-git workspaces render nothing.
 */
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  IconBranchOutline16, IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16,
  RiskConfirmation, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core'
import {
  clearActionError, createSessionHere, currentSessionIsBlank, gitCoordinator, removeUnregisteredWorktree, retryRecovery,
} from '../shared/coordinator.ts'
import { gitActionErrorTextFor } from '../shared/action-error.ts'
import { gitFactsForWorkspace, removeBlockReason } from '../shared/git-facts.ts'
import { removeRunningNotes } from '../shared/remove-notes.ts'
import type { GitBusyKind, GitRecovery, GitWorktreeInfo } from '../shared/types.ts'
import type { GitSidebarKey } from '../locales.ts'
import { CreateWorktreeDialog } from './CreateWorktreeDialog.tsx'
import { RemoveWorktreeDialog, type RemoveViewTarget } from './RemoveWorktreeDialog.tsx'
import css from './SidebarGit.module.css'

function pathName(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/** Occurrence context: source scope when workspaceId === '' (with an optional
 *  repoKey for the repository's UNREGISTERED worktree block — Plan A). */
export interface WorkspaceGitContext {
  sourceId: string
  workspaceId: string
  repoKey?: string
}

/** One unregistered worktree row awaiting removal authorization; the destructive
 *  action rides the in-app `RiskConfirmation` (a native prompt cannot use alias tokens). */
interface UnregisteredRemoveTarget {
  repoId: string
  worktreeId: string
  path: string
  branch: string | null
  head: string
  /** Row label substituted into the confirmation copy (`{name}`). */
  name: string
  /** The snapshot reported the directory as gone: the copy then explains the
   *  leftover-record cleanup instead of a plain removal. */
  missing: boolean
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

/** Localized copy for a hard-blocked remove action. `'running'` is deliberately
 *  ABSENT: both call sites pre-filter it into the dedicated running title, so a
 *  `'running'` argument would fall through to `undefined` (no dead copy key). */
function blockLabel(
  reason: ReturnType<typeof removeBlockReason>,
  status: GitWorktreeInfo['status'],
  t: SidebarWorkspaceGitInjected['t'],
): string | undefined {
  if (reason === 'current') return t('currentBlocked')
  if (reason === 'runtime-unknown') return t('runtimeUnknownBlocked')
  if (reason === 'locked') return t('lockedBlocked')
  if (reason === 'unhealthy') {
    // Actionable guidance instead of a dead end: a MISSING path has an in-app
    // registration-only exit; a present-but-broken path needs repair/prune first.
    return status === 'missing' ? t('unhealthyMissingBlocked') : t('unhealthyInvalidBlocked')
  }
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
  // The unregistered row's authorization is per pending target and reset on every
  // close, so a second removal can never inherit a previous consent.
  const [unregisteredRemove, setUnregisteredRemove] = useState<UnregisteredRemoveTarget | null>(null)
  const [unregisteredAcknowledged, setUnregisteredAcknowledged] = useState(false)

  // The current session is per-SOURCE. The runtime channel doubles as the
  // fail-closed presence flag: absent ⇒ UNKNOWN, not "none".
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

  // ---- Source-scope mount: alert strip. Repo-scope mount (Plan A): the repo's
  // UNREGISTERED worktrees, rendered after its last registered workspace. ----
  if (context.workspaceId === '' && context.repoKey !== undefined) {
    if (source.sourceError !== undefined) return null
    const repo = source.snapshot?.repos.find(candidate => candidate.repoId === context.repoKey)
    // The MAIN checkout is never unregistered.
    const unregistered = repo?.worktrees
      .filter(worktree => worktree.workspaceId === null && !worktree.isMain) ?? []
    if (repo === undefined || unregistered.length === 0) return null
    const busy = source.busy !== undefined
    return (
      <div className={css.unregisteredSection} role="group" aria-label={t('unregisteredTitle')}>
        <span className={css.unregisteredHeading}>{t('unregisteredTitle')}</span>
        {unregistered.map((worktree) => {
          // Mirrors removeBlockReason: main/dirty/locked/unhealthy reject at the
          // host. Asymmetry: this row has no discard authorization to collect, so
          // dirty stays hard-blocked. A MISSING path is the deliberate exception —
          // its directory is gone, so removal is a leftover-record cleanup.
          const status = worktree.status
          const missing = status === 'missing'
          const blockedReason: ReturnType<typeof removeBlockReason> = worktree.isMain
            ? 'main'
            : worktree.locked
              ? 'locked'
              : missing
                ? undefined
                : status !== 'ready'
                  ? 'unhealthy'
                  : worktree.dirty === true
                    ? 'dirty'
                    : undefined
          const rowName = pathName(worktree.path)
          return (
            <div className={css.unregisteredRow} key={worktree.worktreeId} role="group">
              <IconBranchOutline16 size={14} className={css.unregisteredIcon} />
              <span className={css.unregisteredName} title={worktree.path}>
                {worktree.branch ?? pathName(worktree.path)}
              </span>
              {worktree.status !== 'ready' && (
                // Upstream `Tag` instead of a hand-rolled capsule whose neutral
                // fill would equal the row's hover fill and vanish under the pointer.
                <Tag tone="warning" className={css.unregisteredStatus}>
                  {worktree.status === 'not-a-repo' ? t('notARepo') : t(worktree.status)}
                </Tag>
              )}
              <span className={css.unregisteredSpacer} />
              <button
                type="button"
                className={css.unregisteredAction}
                disabled={busy || source.recovery !== undefined
                  // A vanished/missing path cannot host a session.
                  || worktree.status !== 'ready'}
                title={worktree.status === 'ready' ? t('unregisteredAdoptTitle') : t('unhealthyTarget')}
                aria-label={t('unregisteredAdopt')}
                onClick={() => { void createSessionHere(context.sourceId, worktree.path).catch(() => {}) }}
              >
                <IconPlusOutline16 size={14} />
              </button>
              <button
                type="button"
                className={`${css.unregisteredAction} ${css.unregisteredActionDanger}`}
                disabled={busy || source.recovery !== undefined || blockedReason !== undefined}
                title={blockedReason === undefined
                  // A missing row's removal IS the cleanup the blocked copy would point at.
                  ? (missing ? t('unregisteredMissingRemoveTitle') : t('remove'))
                  : (blockLabel(blockedReason, status, t) ?? t('remove'))}
                aria-label={t('remove')}
                onClick={() => {
                  // Collected by the in-app RiskConfirmation below, never a native prompt.
                  setUnregisteredAcknowledged(false)
                  setUnregisteredRemove({
                    repoId: repo.repoId,
                    worktreeId: worktree.worktreeId,
                    path: worktree.path,
                    branch: worktree.branch,
                    head: worktree.head,
                    name: rowName,
                    missing,
                  })
                }}
              >
                <IconTrashOutline16 size={14} />
              </button>
            </div>
          )
        })}
        {/* Destructive and irreversible: runs only behind the official risk
            acknowledgement (primary action unavailable until the box is checked). */}
        <RiskConfirmation
          open={unregisteredRemove !== null}
          title={t('removeTitle')}
          description={unregisteredRemove === null
            ? ''
            : (unregisteredRemove.missing
              ? t('unregisteredMissingRemoveConfirm')
              : t('unregisteredRemoveConfirm')).replace('{name}', unregisteredRemove.name)}
          acknowledgeLabel={t('unregisteredRemoveAck')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
          confirmLabel={t('removeConfirm')}
          acknowledged={unregisteredAcknowledged}
          disabled={busy || source.recovery !== undefined}
          onAcknowledgedChange={setUnregisteredAcknowledged}
          onCancel={() => {
            setUnregisteredRemove(null)
            setUnregisteredAcknowledged(false)
          }}
          onConfirm={() => {
            const target = unregisteredRemove
            setUnregisteredRemove(null)
            setUnregisteredAcknowledged(false)
            if (target === null) return
            void removeUnregisteredWorktree(context.sourceId, {
              repoId: target.repoId,
              worktreeId: target.worktreeId,
              path: target.path,
              branch: target.branch,
              head: target.head,
            }).catch(() => {})
          }}
        />
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
          <span className={css.wsSourceAlertText}>
            {t('actionError')} {gitActionErrorTextFor(source.actionErrorCode, actionError, t)}
          </span>
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

  // ---- Workspace-scope mount. A source-level snapshot failure hides the
  // possibly-stale rows: the source degrades to an ordinary no-worktree view. ----
  const snapshot = source.snapshot
  const rows = snapshot === undefined || source.sourceError !== undefined
    ? []
    : gitFactsForWorkspace(snapshot, context.workspaceId)
  if (rows.length === 0) return null

  const primary = rows[0]!.worktree
  const busy = source.busy !== undefined
  const actionLocked = busy || source.recovery !== undefined
  const blocked = removeBlockReason(primary, currentSessionId, currentSessionIsBlank(context.sourceId, currentSessionId), runtimeKnown)
  /** The running title must not claim archivedness on an OLD host (neutral copy is
   *  the honest one); derived through the SAME pure helper the dialog uses. */
  const runningNotes = removeRunningNotes({
    runningSessionIds: primary.runningSessionIds,
    ...(primary.blockingRunningSessionIds === undefined
      ? {}
      : { blockingRunningSessionIds: primary.blockingRunningSessionIds }),
  })
  const runningTitle = runningNotes.kind === 'legacy'
    ? t('runningRemoveLegacyTitle')
    : t('runningRemoveTitle')
  // Only worktree workspaces (not the main checkout) can be removed as worktrees.
  const canOfferRemove = !primary.isMain && primary.workspaceId !== null
  const createDisabled = actionLocked || source.connected !== true

  return (
    <>
      <span className={css.headerGit} role="group" aria-label={t('title')}>
        {primary.isMain && (
          // No second-level derivation: worktrees are created only from the MAIN checkout.
          <button
            type="button"
            className={css.headerGitAction}
            // The hover-reveal hook is a `data-*` attribute, never a literal class:
            // styling hooks are attributes (no second styling vocabulary).
            data-git-action=""
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
            className={css.headerGitAction}
            data-git-action=""
            // A dirty worktree is NOT disabled (the dialog collects the discard
            // checkbox); a running one is not either — there is no wire flag to opt
            // out of the host's RUNNING guard, so the row stays clickable and the
            // dialog explains. Every other block stays a hard disable; current and
            // runtime-unknown are evaluated BEFORE running, so a stale running fact
            // cannot shadow them.
            disabled={actionLocked || (blocked !== undefined && blocked !== 'dirty' && blocked !== 'running')}
            aria-label={blocked === 'dirty'
              ? t('dirtyRemoveTitle')
              : blocked === 'running'
                ? runningTitle
                : (blockLabel(blocked, primary.status, t) ?? t('remove'))}
            title={blocked === 'dirty'
              ? t('dirtyRemoveTitle')
              : blocked === 'running'
                ? runningTitle
                : (blockLabel(blocked, primary.status, t) ?? t('remove'))}
            onClick={() => setRemoveTarget({
              repoId: rows[0]!.repoId,
              worktreeId: primary.worktreeId,
              path: primary.path,
              branch: primary.branch,
              sessionIds: primary.sessionIds,
              dirty: primary.dirty === true,
              runningSessionIds: [...primary.runningSessionIds],
              ...(primary.blockingRunningSessionIds === undefined
                ? {}
                : { blockingRunningSessionIds: [...primary.blockingRunningSessionIds] }),
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
        runtimeKnown={runtimeKnown}
        t={t}
      />
    </>
  )
}
