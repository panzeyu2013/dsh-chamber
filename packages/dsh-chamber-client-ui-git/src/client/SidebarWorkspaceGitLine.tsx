/**
 * Per-workspace Git occupant (design 08 §3.2). The sidebar mounts this seat per
 * occurrence:
 *  - `workspaceId === ''` (source scope): the source-level alert strip —
 *    recovery (retry clears it; a pending recovery blocks every git action on
 *    the source) and action errors. Snapshot/install errors are NOT shown here;
 *  - once per REGISTERED workspace header: only the repository MAIN checkout
 *    renders the create-worktree entry; a registered worktree (or a non-git
 *    workspace) renders nothing;
 *  - once per DERIVED `kind:'checkout'` row: the occurrence carries `checkout`
 *    while `workspaceId` keeps naming the SOURCE main workspace (session root,
 *    I1). A checkout row is not a dsh workspace, so it offers only its own three
 *    actions — new session, path-based removal, copy path — and NEVER a
 *    workspace-management entry.
 *
 * PR3 retired the legacy repo-scope unregistered block and the registered removal
 * path (the old managed pool is a release precondition, not a UI state).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  IconBranchOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular,
  Tag, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { IconCopyOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core'
import {
  clearActionError, createSessionHere, gitCoordinator, retryRecovery,
} from '../shared/coordinator.ts'
import { gitActionErrorTextFor } from '../shared/action-error.ts'
import { gitFactsForWorkspace } from '../shared/git-facts.ts'
import { checkoutDisplayLabel, checkoutRemoveBlockReason, findCheckout } from '../shared/checkout.ts'
import type { GitBusyKind, GitRecovery, GitWorktreeInfo } from '../shared/types.ts'
import type { GitSidebarKey } from '../locales.ts'
import { useCheckoutRemoval } from './useCheckoutRemoval.tsx'
import { CreateWorktreeDialog } from './CreateWorktreeDialog.tsx'
import css from './SidebarGit.module.css'

/** Copy-feedback dwell: how long the checkout row's affordance says "copied". */
const COPY_FEEDBACK_MS = 1000

/** Occurrence context: source scope when workspaceId === '', a registered
 *  workspace header, or a DERIVED checkout row when `checkout` is present
 *  (`workspaceId` stays the SOURCE main workspace id; `repoKey` the repository's
 *  opaque identity). */
export interface WorkspaceGitContext {
  sourceId: string
  workspaceId: string
  repoKey?: string
  /** Derived `kind:'checkout'` occurrence. Its `title` is the row's derived
   *  label (branch, or the directory name when detached); the facts are resolved
   *  by `path` because the checkout has no workspace identity. */
  checkout?: { path: string; branch: string | null; title: string }
}

/** The copy affordance's transient acknowledgement, with the timer owned by the
 *  mount (a copy that lands after unmount must not schedule a state write). */
function useCopyFeedback(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const copy = useCallback(async (text: string): Promise<void> => {
    // A refused write (permission/hostile surface) paints no success: the
    // affordance keeps its plain label instead of lying.
    if (!(await writeClipboard(text))) return
    setCopied(true)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setCopied(false)
    }, COPY_FEEDBACK_MS)
  }, [])
  return { copied, copy }
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
  return recovery.kind === 'git-create' ? t('recoveryGitCreate') : t('recoveryGitRemove')
}

function busyLabel(kind: GitBusyKind, t: SidebarWorkspaceGitInjected['t']): string {
  if (kind === 'preview') return t('busyPreview')
  if (kind === 'create') return t('busyCreate')
  if (kind === 'remove') return t('busyRemove')
  if (kind === 'session-enter') return t('busySessionEnter')
  return t('busyRecovery')
}

/** Localized copy for a hard-blocked checkout removal. `'running'` is deliberately
 *  ABSENT: the caller pre-filters it into the dedicated running title, so a
 *  `'running'` argument would fall through to `undefined` (no dead copy key). */
function blockLabel(
  reason: ReturnType<typeof checkoutRemoveBlockReason>,
  t: SidebarWorkspaceGitInjected['t'],
): string | undefined {
  if (reason === 'current') return t('currentBlocked')
  if (reason === 'locked') return t('lockedBlocked')
  // A MISSING path is not blocked by the checkout guard; it is the leftover-record
  // cleanup and the caller renders that copy before reaching this table. Any other
  // unhealthy state needs repair/prune first.
  if (reason === 'unhealthy') return t('unhealthyInvalidBlocked')
  if (reason === 'dirty') return t('dirtyBlocked')
  if (reason === 'status-unknown') return t('dirtyUnknownBlocked')
  return undefined
}

/** The removal affordance's tooltip for a DERIVED checkout row: the reason while
 *  blocked, the cleanup/discard wording while allowed, the plain label otherwise.
 *  A checkout's only 'current' case is a RUNNING viewed session (an idle one is
 *  removable by design), so the running copy is the honest one there too. */
function checkoutRemoveTitle(
  worktree: GitWorktreeInfo | undefined,
  blocked: ReturnType<typeof checkoutRemoveBlockReason>,
  t: SidebarWorkspaceGitInjected['t'],
): string {
  if (worktree === undefined) return t('worktreeNotFound')
  if (worktree.status === 'missing') return t('unregisteredMissingRemoveTitle')
  if (blocked === 'dirty') return t('unregisteredDirtyRemoveTitle')
  if (blocked === 'running' || blocked === 'current') {
    return worktree.blockingRunningSessionIds === undefined ? t('runningRemoveLegacyTitle') : t('runningRemoveTitle')
  }
  if (blocked === 'main') return t('mainWorktreeBlocked')
  return blockLabel(blocked, t) ?? t('remove')
}

export function SidebarWorkspaceGitLine({
  wide, t, useWorkspaceGitContext,
}: SidebarWorkspaceGitLineProps): ReactNode {
  useSyncExternalStore(gitCoordinator.subscribe, gitCoordinator.getVersion, gitCoordinator.getVersion)
  const context = useWorkspaceGitContext()
  const [createOpen, setCreateOpen] = useState(false)
  // Copy-path feedback for the derived checkout row (a refused clipboard write
  // paints nothing — see useCopyFeedback).
  const { copied: checkoutCopied, copy: copyCheckoutPath } = useCopyFeedback()

  // The current session is per-SOURCE. A RUNNING session in the checkout blocks its
  // removal; an idle one is removable by design (ensure() falls back to the source).
  const runtime = useSyncExternalStore(
    chamberBridge.subscribe,
    () => context === undefined
      ? undefined
      : chamberBridge.getServers().find(server => server.id === context.sourceId)?.runtime,
    () => undefined,
  )
  const currentSessionId = runtime?.current

  const removalSource = context === undefined ? undefined : gitCoordinator.getSource(context.sourceId)
  const removal = useCheckoutRemoval({
    sourceId: context?.sourceId ?? '',
    t,
    disabled: removalSource?.busy !== undefined || removalSource?.recovery !== undefined,
  })

  if (!wide || context === undefined) return null
  const source = gitCoordinator.getSource(context.sourceId)

  // ---- Derived checkout-row mount (design 08 PR2). The row is NOT a dsh
  // workspace (I3): `workspaceId` keeps naming the SOURCE main workspace (the
  // session root, I1) and `repoKey` the repository, while `checkout` carries the
  // derived identity — so facts are resolved by PATH, never by workspace id.
  // Only the three checkout actions live here: new session (directly, no prompt),
  // path-based removal (the host's locked/dirty/running guards re-check fresh
  // facts) and copy path. Workspace management (create worktree, registered
  // removal, rename/kebab/fold) belongs to the sidebar and never appears on this
  // row. Health/title/branch surface through these affordances: the tooltip names
  // the blocking state, the confirmation names the row's derived title.
  const checkout = context.checkout
  if (checkout !== undefined) {
    const snapshot = source.snapshot
    // A source-level snapshot failure hides the possibly-stale facts: every action
    // except copy path then fails closed with "facts unavailable".
    const target = snapshot === undefined || source.sourceError !== undefined
      ? undefined
      : findCheckout(snapshot, checkout.path, context.repoKey)
    const worktree = target?.worktree
    // I9: the session root is the repository MAIN checkout; an unregistered main
    // checkout has no source workspace to create the session in.
    const mainWorkspaceId = target?.repo.worktrees.find(candidate => candidate.isMain)?.workspaceId ?? null
    const actionLocked = source.busy !== undefined || source.recovery !== undefined
    const blocked = worktree === undefined
      ? undefined
      : checkoutRemoveBlockReason(worktree, currentSessionId)
    // A DIRTY checkout stays actionable: its confirmation collects the discard
    // acknowledgement (`discardChanges`). A RUNNING checkout is actionable too:
    // the dialog offers the optional archive step (which stops the work under the
    // user's explicit choice), and without it the host's own running guard is the
    // authority — the client never pre-claims that state.
    const canRemove = worktree !== undefined && !actionLocked
      && (blocked === undefined || blocked === 'dirty' || blocked === 'running')
    const createBlocked = worktree === undefined
      ? t('checkoutFactsUnavailable')
      : worktree.status !== 'ready'
        ? t('unhealthyTarget')
        : mainWorkspaceId === null ? t('checkoutNoMain') : undefined
    // The row's display identity: the branch when it has one (a detached checkout
    // derives the directory name as its title). The confirmation speaks it, the
    // copy affordance shows the canonical path, and the action group names it so
    // the checkout row's identity does not depend on the sidebar's title text.
    const checkoutName = checkoutDisplayLabel(checkout.branch, checkout.title, checkout.path)
    const checkoutLabel = t('title') + ': ' + checkoutName
    const copyLabel = checkoutCopied ? t('checkoutCopied') : t('checkoutCopyPath')
    // Dirty/lock are OCCUPANT facts (design 06 §1.2: they are redrawn from the
    // occupant's own snapshot and never enter an aggregate signature). PATH health
    // (missing/invalid/not-a-repo/unknown) and the branch/HEAD label belong to the
    // sidebar's row-state contract, so they are deliberately NOT duplicated here.
    // Precedence: a locked checkout is the actionable state for removal.
    const checkoutBadge = worktree === undefined || worktree.status !== 'ready'
      ? undefined
      : worktree.locked
        ? t('checkoutLockedBadge')
        : worktree.dirty === true
          ? t('checkoutDirtyBadge')
          : worktree.dirty === null ? t('checkoutStatusUnknownBadge') : undefined
    return (
      <>
        <span className={css.headerGit} data-git-occupant="" role="group" aria-label={checkoutLabel}>
          {checkoutBadge !== undefined && (
            // A REVEAL-CLUSTER member (design 06 §7's hover swap, design 08 §3.2):
            // the state word is deliberately NOT a rest element. The host keeps this
            // container `display: none` at rest and returns it on hover /
            // `.rowActionsVisible` (kebab-open or keyboard focus), so dirty/locked/
            // unknown shows together with the three actions instead of as a permanent
            // row-end label — at rest the row carries only the neutral branch glyph
            // and the count badge (the user-ruled B+C form).
            //
            // The hook is a data attribute — CSS modules hash classes — and it stays
            // this capsule's DOM/test hook. The host no longer swaps the capsule out
            // on its own: the occupant container owns the whole cluster's visibility.
            <span className={css.checkoutStatus} data-git-checkout-status="">
              {/* Upstream `Tag`: a hand-rolled capsule with a neutral fill would
                  vanish into the row's hover fill. */}
              <Tag tone="warning">{checkoutBadge}</Tag>
            </span>
          )}
          <button
            type="button"
            className={css.headerGitAction}
            data-git-action=""
            disabled={actionLocked || source.connected !== true || createBlocked !== undefined}
            aria-label={t('checkoutNewSession')}
            title={createBlocked ?? t('checkoutNewSessionTitle')}
            onClick={() => { void createSessionHere(context.sourceId, checkout.path).catch(() => {}) }}
          >
            <IconPlusOutlineRegular size={16} />
          </button>
          <button
            type="button"
            className={css.headerGitAction}
            data-git-action=""
            aria-label={copyLabel}
            title={checkoutCopied ? copyLabel : copyLabel + ': ' + checkout.path}
            onClick={() => { void copyCheckoutPath(checkout.path) }}
          >
            <IconCopyOutlineRegular size={16} />
          </button>
          <button
            type="button"
            className={css.headerGitAction}
            data-git-action=""
            disabled={!canRemove}
            aria-label={t('remove')}
            title={checkoutRemoveTitle(worktree, blocked, t)}
            onClick={() => {
              if (target === undefined) return
              removal.openRemove({
                repoId: target.repo.repoId,
                worktreeId: target.worktree.worktreeId,
                path: target.worktree.path,
                branch: target.worktree.branch,
                head: target.worktree.head,
                name: checkoutName,
                missing: target.worktree.status === 'missing',
                dirty: target.worktree.dirty === true,
              })
            }}
          >
            <IconTrashOutlineRegular size={16} />
          </button>
        </span>
        {removal.dialog}
      </>
    )
  }

  // ---- Source-scope mount: alert strip. The legacy repo-scope unregistered
  // block is gone (PR3): unregistered checkouts are DERIVED checkout rows now,
  // so this seat never renders a second, registered-workspace-shaped list.
  if (context.workspaceId === '') {
    const recovery = source.recovery
    const actionError = source.actionError
    const notice = source.notice
    if (recovery === undefined && actionError === undefined && notice === undefined) return null
    const busy = source.busy !== undefined
    return (
      <div className={css.wsSourceAlert} role={recovery !== undefined || actionError !== undefined ? 'alert' : 'status'}>
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
        {notice !== undefined && (
          <span className={css.wsSourceAlertText}>{notice}</span>
        )}
        {recovery !== undefined && (
          <button
            type="button"
            className={css.wsRetry}
            disabled={busy}
            onClick={() => { void retryRecovery(context.sourceId).catch(() => {}) }}
          >
            <IconRefreshOutlineRegular size={12} />
            {t('retry')}
          </button>
        )}
        {(actionError !== undefined || notice !== undefined) && (
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

  // ---- Registered-workspace mount: the MAIN checkout's create entry only.
  // A source-level snapshot failure hides the possibly-stale row, and a REGISTERED
  // worktree (or a non-git workspace) renders nothing: the registered removal path
  // is gone (PR3), and a checkout's own row carries its delete action. ----
  const snapshot = source.snapshot
  const rows = snapshot === undefined || source.sourceError !== undefined
    ? []
    : gitFactsForWorkspace(snapshot, context.workspaceId)
  const primary = rows[0]?.worktree
  if (primary === undefined || !primary.isMain) return null
  const createDisabled = source.busy !== undefined || source.recovery !== undefined || source.connected !== true

  return (
    <>
      {/* The occupant's mount is the sidebar `.rowActions` cluster's SIBLING
          inside the workspace header row, and it carries its own cross-package
          hook (`data-git-occupant`): the sidebar keeps it out of the layout at
          rest (`.workspaceHeader [data-git-occupant]`, 0,2,0 — it beats this
          span's own `.headerGit` 0,1,0), because an in-flow zero-width flex item
          still consumes the header's 4px gap: while the mount renders no action
          it stays invisible yet still eats that gap, parking every git row's
          count badge 4px off the shared right column (the session rows' state
          slots / the todo count pill; design 08 §3.2). Placement is a contract —
          the occupant stays before (left of) the cluster, pinned by the git
          package's `test/locks/slot-contract.test.ts`; only its rest-state
          footprint is collapsed here. Revealed by the HOST on the same states as
          `[data-git-action]` (hover / `.rowActionsVisible` — kebab-open or keyboard
          focus, design 06 §7); the plugin brings no reveal of its own: this span's
          action is `display:none` at rest, so a CSS-only `:has(:focus-visible)`
          flip could not even fire — and Blink's Tab navigation would not reach it
          anyway. The sidebar is this repo's only host and declares both states. */}
      <span className={css.headerGit} data-git-occupant="" role="group" aria-label={t('title')}>
        {/* Worktrees are created only from the MAIN checkout (design 08 I1). */}
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
          <IconBranchOutlineRegular size={16} />
        </button>
      </span>
      <CreateWorktreeDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        sourceId={context.sourceId}
        initialWorkspaceId={context.workspaceId}
        initialRepoId={rows[0]!.repoId}
        t={t}
      />
    </>
  )
}