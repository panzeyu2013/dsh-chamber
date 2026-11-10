/**
 * Removal-failure code resolution: the code behind an action failure and its
 * localized copy key. The checkout row's removal dialog owns the discard /
 * submodule acknowledgement, so these codes re-arm that dialog's checkbox and
 * the next attempt carries `discardChanges`. Also the code chain the shared
 * action-error resolver reads for every Git failure.
 */
import type { GitSidebarKey } from '../locales.ts'
import { NOT_DISPATCHED_CODE } from './not-dispatched.ts'

/**
 * The RPC error code behind an action failure, following the saga's `original`
 * chain (GitSagaError wraps the host/transport error). An unmapped or absent code
 * stays `undefined` and the caller shows the raw message.
 */
export function removeFailureCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== 'object') return undefined
    const record = current as { code?: unknown; original?: unknown }
    if (typeof record.code === 'string' && record.code !== '') return record.code
    current = record.original
  }
  return undefined
}

/**
 * Localized copy for a refusal/action code, or undefined when the code has no
 * dedicated copy (the caller then shows the raw message). The table serves BOTH
 * vocabularies (see shared/action-error.ts): host-domain codes from
 * `GitWorktreeRpcError` and local preflight/guard codes from `GitActionError`,
 * reusing the host spelling whenever the condition is the same.
 */
export function removeFailureCopyKey(code: string | undefined): GitSidebarKey | undefined {
  switch (code) {
    // ---- host-domain refusals (GitWorktreeRpcError) ----
    case 'running-agent': return 'runningAgentBlocked'
    case 'main-worktree': return 'mainWorktreeBlocked'
    case 'worktree-locked': return 'lockedBlocked'
    // PR1 create/enter refusals (source checkout + session entry).
    case 'source-not-main-checkout': return 'sourceNotMainCheckout'
    case 'not-a-repo': return 'notARepoSource'
    case 'worktree-not-listed': return 'worktreeNotListed'
    case 'outside-writable-root': return 'outsideWritableRoot'
    case 'ignore-unavailable': return 'ignoreUnavailable'
    case 'agent-not-ready': return 'agentNotReady'
    // Picker/self-heal refusals (previewCreate): a localized, actionable answer.
    case 'branch-not-found': return 'branchNotFound'
    case 'branch-checked-out': return 'branchCheckedOutBlocked'
    case 'branch-exists': return 'branchExists'
    // A fresh host re-check that found the tree dirty: the host's own refusal.
    case 'worktree-dirty': return 'dirtyDiscardWarning'
    // Submodule checkouts make Git refuse a plain remove; the retry needs the
    // explicit discard authorization (force).
    case 'worktree-submodules': return 'submoduleDiscardWarning'
    case 'worktree-invalid': return 'unhealthyInvalidBlocked'
    // 404 on the gitWorktree namespace: the host package is absent/inactive.
    case 'git-host-not-loaded': return 'gitHostNotLoaded'
    // Carrier-level refusal: the raw message is the carrier's own fallback.
    case 'rpc-failed': return 'remoteCallFailed'
    // Page-local dispatch refusal: never a source failure, localized retry copy.
    case NOT_DISPATCHED_CODE: return 'notDispatched'
    // ---- local preflight/guard failures (GitActionError) ----
    case 'action-in-progress': return 'actionInProgress'
    case 'recovery-pending': return 'recoveryPending'
    case 'fresh-facts-unavailable': return 'freshFactsUnavailable'
    case 'worktree-not-found': return 'worktreeNotFound'
    case 'unhealthy-target': return 'unhealthyTarget'
    case 'source-workspace-missing': return 'sourceWorkspaceMissing'
    case 'archive-failed': return 'archiveFailed'
    default: return undefined
  }
}
