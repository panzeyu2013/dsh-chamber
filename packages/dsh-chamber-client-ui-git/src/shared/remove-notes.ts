/**
 * Pure note/count derivation for the remove-worktree dialog (design 08 §5.2
 * amendment). The two host facts are DIFFERENT things and must never be conflated:
 *  - `runningSessionIds` is the display fact (every running session, archived or not);
 *  - `blockingRunningSessionIds` is the archived-aware guard fact (only the running
 *    sessions that actually gate removal). It is ABSENT on an older host — and
 *    absence means "cannot tell which running sessions are inert", NOT "none are
 *    archived" — so the dialog falls back to NEUTRAL copy there: claiming
 *    archivedness (or non-archivedness) would be a fabricated fact.
 */
import type { GitSidebarKey } from '../locales.ts'

/** The running-session facts the dialog reads from one worktree row. */
export interface RemoveRunningFacts {
  readonly runningSessionIds: readonly string[]
  /** ABSENT on an older host (see the module doc). */
  readonly blockingRunningSessionIds?: readonly string[] | undefined
}

/** Which running-session note the dialog renders. */
export type RemoveRunningNoteKind =
  /** The archived-aware fact is present and N sessions block the removal. */
  | 'blocking'
  /** The archived-aware fact is ABSENT (old host): neutral copy; every running session counts as blocking. */
  | 'legacy'
  | 'none'

export interface RemoveRunningNotes {
  readonly kind: RemoveRunningNoteKind
  /** The count for the note ({count}): 'legacy' = every running session, 'blocking' = the blocking ones. */
  readonly blockingCount: number
  /** Running sessions that are INERT (archived, or under an archived ancestor),
   *  computed as a SET DIFFERENCE — never length subtraction. Always 0 for 'legacy'. */
  readonly inertCount: number
  /** Every running session under the worktree (display fact). */
  readonly runningCount: number
}

/** Derive the dialog's running-session notes from one row's facts. */
export function removeRunningNotes(facts: RemoveRunningFacts): RemoveRunningNotes {
  const running = facts.runningSessionIds
  const blocking = facts.blockingRunningSessionIds
  if (blocking === undefined) {
    return {
      kind: running.length > 0 ? 'legacy' : 'none',
      blockingCount: running.length,
      inertCount: 0,
      runningCount: running.length,
    }
  }
  const blockingSet = new Set(blocking)
  return {
    kind: blocking.length > 0 ? 'blocking' : 'none',
    blockingCount: blocking.length,
    // Set difference: an id the host reports as blocking but not as running (a
    // host defect the decoder rejects) can never make this negative or over-count.
    inertCount: running.filter(id => !blockingSet.has(id)).length,
    runningCount: running.length,
  }
}

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
 * `running-agent` matters most: the row deliberately leaves the delete control
 * enabled while non-archived sessions run, so the host re-checks and refuses and
 * the user must read WHY in their own language.
 */
export function removeFailureCopyKey(code: string | undefined): GitSidebarKey | undefined {
  switch (code) {
    // ---- host-domain refusals (GitWorktreeRpcError) ----
    case 'running-agent': return 'runningAgentBlocked'
    case 'main-worktree': return 'mainWorktreeBlocked'
    case 'worktree-locked': return 'lockedBlocked'
    // A fresh host re-check that found the tree dirty: the same discard authorization the dialog renders.
    case 'worktree-dirty': return 'dirtyDiscardWarning'
    case 'worktree-invalid': return 'unhealthyInvalidBlocked'
    // 404 on the gitWorktree namespace: the host package is absent/inactive.
    case 'git-host-not-loaded': return 'gitHostNotLoaded'
    // Carrier-level refusal: the raw message is the carrier's own fallback.
    case 'rpc-failed': return 'remoteCallFailed'
    // ---- local preflight/guard failures (GitActionError) ----
    case 'action-in-progress': return 'actionInProgress'
    case 'recovery-pending': return 'recoveryPending'
    case 'fresh-facts-unavailable': return 'freshFactsUnavailable'
    case 'worktree-not-found': return 'worktreeNotFound'
    case 'worktree-unregistered': return 'unregisteredBlocked'
    case 'worktree-current': return 'currentBlocked'
    case 'worktree-runtime-unknown': return 'runtimeUnknownBlocked'
    case 'worktree-unhealthy': return 'unhealthyRemoveBlocked'
    case 'worktree-status-unknown': return 'dirtyUnknownBlocked'
    case 'unhealthy-target': return 'unhealthyTarget'
    case 'archive-failed': return 'archiveFailed'
    case 'refresh-failed': return 'refreshFailed'
    default: return undefined
  }
}
