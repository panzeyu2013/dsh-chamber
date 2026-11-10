/**
 * Create-dialog branch-candidate query state (design 08 §2.1/§4.1).
 *
 * The picker's candidates are a POINT-IN-TIME QUERY, not polled facts: the dialog reads them
 * when it opens (and on retry / a preview refusal / a stale Existing tab) because
 * `snapshot.branches` rides the 30s discovery cache and the page's poll wave. Pure and
 * clockless: every function takes the caller's `at`/`now`.
 *
 * Degradation: an old host package does not serve `gitWorktree/branches`; that is
 * `unsupported` (silent fallback to the snapshot list, design 08 §6.3), while every other
 * failure is `error` (snapshot fallback stays usable beside a localized error strip).
 */
import type { BranchCandidatesResult } from './types.ts'
import { sourceBranchChoices } from './git-facts.ts'

export type BranchQueryOutcome =
  | { readonly kind: 'ready'; readonly result: BranchCandidatesResult }
  /** The host does not serve the on-demand method (old seed package): use the snapshot list. */
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly code?: string; readonly message: string; readonly retryable: boolean }

export interface BranchQueryState {
  readonly key: string
  readonly requestId: number
  readonly status: 'loading' | 'ready' | 'unsupported' | 'error'
  readonly result?: BranchCandidatesResult
  /** The outcome's completion time; a loading state carries its launch time. */
  readonly settledAt: number
  readonly error?: { readonly code?: string; readonly message: string; readonly retryable: boolean }
}

/** The Existing tab's freshness arm: a settled candidate list older than this is re-read. */
export const BRANCH_QUERY_STALE_MS = 15_000

/** One query identity: a source and the repository workspace it asks about. */
export function branchQueryKey(sourceId: string, sourceWorkspaceId: string): string {
  return `${sourceId}\u0000${sourceWorkspaceId}`
}

export function beginBranchQuery(key: string, requestId: number, at: number): BranchQueryState {
  return { key, requestId, status: 'loading', settledAt: at }
}

/** Apply one outcome; a late answer from a superseded query (or another key) is dropped. */
export function settleBranchQuery(
  state: BranchQueryState,
  key: string,
  requestId: number,
  outcome: BranchQueryOutcome,
  at: number,
): BranchQueryState {
  if (state.key !== key || state.requestId !== requestId) return state
  if (outcome.kind === 'ready') {
    return { key, requestId, status: 'ready', result: outcome.result, settledAt: at }
  }
  if (outcome.kind === 'unsupported') return { key, requestId, status: 'unsupported', settledAt: at }
  return {
    key,
    requestId,
    status: 'error',
    settledAt: at,
    error: { code: outcome.code, message: outcome.message, retryable: outcome.retryable },
  }
}

/** True when a settled candidate list for this key is older than the TTL. An in-flight read
 *  is never restarted, and an old host is not re-probed on every tab activation (one 404 per
 *  dialog open: closing/reopening the dialog reads once again). */
export function shouldRefetchBranches(
  state: BranchQueryState | undefined,
  key: string,
  now: number,
  ttlMs: number = BRANCH_QUERY_STALE_MS,
): boolean {
  if (state === undefined || state.key !== key) return true
  if (state.status === 'loading') return false
  if (state.status === 'unsupported') return false
  return now - state.settledAt >= ttlMs
}

type BranchReadPlan = 'start' | 'keep' | 'reset'

/**
 * ONE decision for the dialog's single read effect (open / workspace resolution / Existing-tab
 * staleness). A second effect used to race this one on reopen: both called the read in the same
 * commit, aborting and re-dispatching the first request. `reset` also owns the close-abort.
 */
export function planBranchQuery(input: {
  readonly open: boolean
  /** False while the source workspace has not been resolved yet. */
  readonly workspaceReady: boolean
  readonly mode: 'new' | 'existing'
  /** The query identity of the CURRENT repository ('' before a workspace is chosen). */
  readonly key: string
  /** The answer for that key; undefined when none or when it belongs to a previous repo. */
  readonly query: BranchQueryState | undefined
  readonly now: number
  readonly ttlMs?: number
}): BranchReadPlan {
  if (!input.open) return 'reset'
  if (!input.workspaceReady) return 'keep'
  // An answer for a DIFFERENT repository identity is not this repository's answer: the caller
  // normally passes undefined for that case, but the planner owns the decision (a stale wrong
  // repo must never be resolved as 'keep').
  if (input.query !== undefined && input.query.key !== input.key) return 'start'
  if (input.query === undefined) return 'start'
  if (input.query.status === 'loading') return 'keep'
  if (input.mode !== 'existing') return 'keep'
  return shouldRefetchBranches(input.query, input.key, input.now, input.ttlMs) ? 'start' : 'keep'
}

/** The picker candidates: the fresh read once it settled ready, else the snapshot fallback
 *  (the pre-change behaviour: host branch list, then the worktrees' checked-out branches). */
export function branchChoices(
  state: BranchQueryState | undefined,
  snapshotBranches: readonly string[],
  worktreeBranches: readonly (string | null)[],
): readonly string[] {
  if (state?.status === 'ready' && state.result !== undefined) return state.result.branches
  return sourceBranchChoices(snapshotBranches, worktreeBranches)
}

/** Whether one candidate is currently checked out by another worktree. Only the Existing tab
 *  consumes the advisory fact: the NEW-branch `startRef` must keep the main checkout's own
 *  branch selectable (design 08 §4.1). The snapshot fallback cannot answer this (old host's
 *  capability limit, §4.1), so it stays enabled there and the host preview refuses. */
export function branchOptionCheckedOut(
  name: string,
  state: BranchQueryState | undefined,
  mode: 'new' | 'existing',
): boolean {
  if (mode !== 'existing') return false
  if (state?.status !== 'ready' || state.result === undefined) return false
  return state.result.checkedOutBranches.includes(name)
}
