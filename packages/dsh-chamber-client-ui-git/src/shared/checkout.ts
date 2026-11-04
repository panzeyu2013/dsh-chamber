/**
 * Derived checkout-row facts and the removal guard (design 08 PR2,
 * 11-final-design §5.8).
 *
 * A `kind:'checkout'` row is NOT a dsh workspace (I3): it is derived from the
 * published repo layout (one row per unregistered checkout) and its occurrence
 * context carries the SOURCE main workspace id — the session root (I1) — while
 * the checkout identity rides `checkout: { path, branch, title }`. Facts are
 * therefore resolved by PATH, never by workspace id.
 */
import { basenameOf, canonicalPathKey } from '@dsh-chamber/dsh-chamber-client-core'
import type { GitRepoTopology, GitWorktreeInfo, GitWorktreeSnapshot } from './types.ts'

/** The snapshot facts a derived checkout row stands for. */
export interface CheckoutTarget {
  repo: GitRepoTopology
  worktree: GitWorktreeInfo
}

/**
 * Resolve the worktree a checkout row represents: an exact canonical-path match,
 * scoped to the row's repository when the sidebar supplied its opaque `repoKey`
 * (one source can own many repositories; a stale layout must not match a
 * same-named row of another repository).
 * @param snapshot - the source's current (effective) Git facts.
 * @param path - the row's snapshot-canonical checkout path.
 * @param repoKey - the row's repository identity, when the context carries it.
 * @returns the repository + worktree row, or undefined when the checkout is no
 *   longer in the topology (externally removed/moved).
 */
export function findCheckout(
  snapshot: GitWorktreeSnapshot,
  path: string,
  repoKey?: string,
): CheckoutTarget | undefined {
  const key = canonicalPathKey(path)
  for (const repo of snapshot.repos) {
    if (repoKey !== undefined && repo.repoId !== repoKey) continue
    const worktree = repo.worktrees.find(candidate => canonicalPathKey(candidate.path) === key)
    if (worktree !== undefined) return { repo, worktree }
  }
  return undefined
}

/**
 * The derived row's display label: the branch when the checkout has one, else the
 * row's derived title (the sidebar derives `branch ?? directory name`), else the
 * canonical path's basename. A detached/unborn checkout therefore reads by its
 * directory instead of an empty chip — and the contract's optional null branch can
 * never leak the string "null" into copy or accessible names.
 * @param branch - the occurrence context's branch (null/absent when detached).
 * @param title - the derived row title.
 * @param path - the checkout's canonical path (last-resort name).
 * @returns a non-empty label.
 */
export function checkoutDisplayLabel(
  branch: string | null | undefined,
  title: string,
  path: string,
): string {
  if (typeof branch === 'string' && branch !== '') return branch
  if (title !== '') return title
  return basenameOf(path) || path
}

/**
 * Why a derived checkout row's removal is unavailable: `unregistered` is the
 * PRECONDITION of this path-based removal (never a block), and the
 * registered-only `runtime-unknown` leg does not apply (see below).
 */
export type CheckoutRemoveBlockReason =
  | 'main'
  | 'current'
  | 'running'
  | 'locked'
  | 'unhealthy'
  | 'dirty'
  | 'status-unknown'
  | undefined

/**
 * The checkout-row removal guard. It carries only the assumptions that hold for
 * DERIVED checkout rows:
 * - `unregistered` is absent: every checkout row has no dsh workspace — that is
 *   exactly what the path-based host removal requires;
 * - `current`/running read the host's PATH-based running facts
 *   (`runningSessionIds` carries every running session whose effective cwd is this
 *   checkout; the current one is the session on screen). An IDLE viewed session
 *   therefore never blocks removal: the checkout can go and `ensure()` falls back
 *   to the source project on the next message (design 08 §5.8). A running viewed
 *   session is blocked here AND by the host's own `running-agent` refusal.
 * There is deliberately no `runtime-unknown` leg: checkout rows carry no workspace
 * membership (`sessionIds` is empty for them), so the absence of the runtime
 * channel cannot hide a running session — the host re-checks running cwd(s) inside
 * its mutation mutex and fails closed with `running-agent`.
 *
 * `dirty` is returned rather than thrown: the removal confirmation collects the
 * explicit discard acknowledgement and then sends `discardChanges`. A MISSING path
 * is NOT blocked — the removal is then the leftover-record cleanup (`git worktree
 * prune` equivalent).
 * @param worktree - the checkout's fresh snapshot row.
 * @param currentSessionId - the source's current (on-screen) session id; absent
 *   when the runtime channel is unavailable.
 * @returns the block reason, or undefined when the removal may proceed.
 */
export function checkoutRemoveBlockReason(
  worktree: GitWorktreeInfo,
  currentSessionId?: string,
): CheckoutRemoveBlockReason {
  // Defensive only: the layout never derives a row for the main checkout, but a
  // stale layout must never turn the main checkout into a removable row.
  if (worktree.isMain) return 'main'
  if (currentSessionId !== undefined && worktree.runningSessionIds.includes(currentSessionId)) return 'current'
  // The blocking subset is the host's archived-aware fact; an older host omits it
  // and the conservative running set applies (same fallback as the registered row).
  const blockingRunning = worktree.blockingRunningSessionIds ?? worktree.runningSessionIds
  if (blockingRunning.length > 0) return 'running'
  if (worktree.locked) return 'locked'
  // A missing path is the leftover-record cleanup case: the directory is gone, so
  // its dirty bit is null by construction and must not degrade to status-unknown.
  if (worktree.status === 'missing') return undefined
  if (worktree.status !== 'ready') return 'unhealthy'
  if (worktree.dirty === true) return 'dirty'
  if (worktree.dirty === null) return 'status-unknown'
  return undefined
}
