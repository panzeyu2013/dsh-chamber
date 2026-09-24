/** Pure Git-topology derivations shared by the UI and coordinator tests. */
import type { GitRepoTopology, GitWorktreeInfo, GitWorktreeSnapshot } from './types.ts'

export interface CreateSourceOption {
  workspaceId: string
  repoId: string
  label: string
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts.at(-1) || path
}

/** One option per repository with at least one registered workspace; the source is
 *  ALWAYS the repo's MAIN checkout (no second-level derivation), falling back to
 *  the first registered workspace only when the main has none. */
export function createSourceOptions(snapshot: GitWorktreeSnapshot): CreateSourceOption[] {
  const out: CreateSourceOption[] = []
  for (const repo of snapshot.repos) {
    const main = repo.worktrees.find((worktree): worktree is GitWorktreeInfo & { workspaceId: string } => (
      worktree.isMain && worktree.workspaceId !== null
    ))
    const source = main ?? repo.worktrees.find((worktree): worktree is GitWorktreeInfo & { workspaceId: string } => (
      worktree.workspaceId !== null
    ))
    if (source === undefined) continue
    out.push({ workspaceId: source.workspaceId, repoId: repo.repoId, label: basename(repo.mainPath) })
  }
  return out
}

export function findWorktree(
  snapshot: GitWorktreeSnapshot,
  repoId: string,
  worktreeId: string,
): { repo: GitRepoTopology; worktree: GitWorktreeInfo } | undefined {
  const repo = snapshot.repos.find(row => row.repoId === repoId)
  const worktree = repo?.worktrees.find(row => row.worktreeId === worktreeId)
  return repo === undefined || worktree === undefined ? undefined : { repo, worktree }
}

/**
 * Base-ref picker options for the create dialog: the host's branch list
 * (`git show-ref --heads`) when non-empty, otherwise the selected repository's
 * worktree branches, deduplicated in row order.
 *
 * The main checkout's branch is deliberately INCLUDED: the host accepts it as
 * `startRef` (`localBranchHead` resolves it to that branch's HEAD), so filtering
 * it out as the implicit default would make it unreachable once another branch had
 * been chosen and would leave a single-branch repository with an empty picker.
 * @returns The picker options, never filtered against the main checkout branch.
 */
export function sourceBranchChoices(
  repoBranches: readonly string[],
  worktreeBranches: readonly (string | null)[],
): string[] {
  if (repoBranches.length > 0) return [...repoBranches]
  const seen = new Set<string>()
  const out: string[] = []
  for (const branch of worktreeBranches) {
    if (branch !== null && !seen.has(branch)) {
      seen.add(branch)
      out.push(branch)
    }
  }
  return out
}

export interface WorktreeWithRepo {
  repoId: string
  worktree: GitWorktreeInfo
}

/** All git rows registered to one workspace (workspace-centric discovery). */
export function gitFactsForWorkspace(
  snapshot: GitWorktreeSnapshot,
  workspaceId: string,
): WorktreeWithRepo[] {
  const out: WorktreeWithRepo[] = []
  for (const repo of snapshot.repos) {
    for (const worktree of repo.worktrees) {
      if (worktree.workspaceId === workspaceId) out.push({ repoId: repo.repoId, worktree })
    }
  }
  return out
}

export type RemoveBlockReason =
  | 'main'
  | 'unregistered'
  | 'running'
  | 'current'
  | 'runtime-unknown'
  | 'locked'
  | 'unhealthy'
  | 'dirty'
  | 'status-unknown'
  | undefined

/**
 * Safe-remove guard: fresh running facts and the aggregate current id both block removal.
 * `runtimeKnown` is the fail-closed half — the per-source `runtime` channel (carrying
 * `current`) withdraws while its shell reconnects, and treating the resulting `undefined`
 * as "not current" would open the removal of a worktree holding the very session being
 * viewed; absent channel + accounted sessions ⇒ 'runtime-unknown'.
 * The RUNNING reason reads the host's ARCHIVED-AWARE fact (design 08 §5.2):
 * `blockingRunningSessionIds` names only sessions that actually gate removal — archived ones
 * (and those under an archived ancestor) are INERT; ABSENT on an older host, where the
 * `runningSessionIds` fallback stays conservative.
 * PRECEDENCE: `current` and `runtime-unknown` are evaluated BEFORE `running`; the RUNNING
 * reason is NOT a hard client block (the row keeps the delete control enabled and the host
 * re-checks with its `running-agent` guard), so letting it win would shadow the two
 * fail-closed refusals and removal could proceed while the current session's cwd is unknown.
 */
export function removeBlockReason(
  worktree: GitWorktreeInfo,
  currentSessionId?: string,
  currentSessionBlank = false,
  runtimeKnown = true,
): RemoveBlockReason {
  if (worktree.isMain) return 'main'
  if (worktree.workspaceId === null) return 'unregistered'
  // A BLANK (never-submitted) current session carries no content worth protecting.
  if (currentSessionId !== undefined && !currentSessionBlank && worktree.sessionIds.includes(currentSessionId)) return 'current'
  // Fail-closed: the runtime channel is absent, so the current session cannot be
  // ruled out of this worktree; blankness is unknown too.
  if (!runtimeKnown && worktree.sessionIds.length > 0) return 'runtime-unknown'
  const blockingRunning = worktree.blockingRunningSessionIds ?? worktree.runningSessionIds
  if (blockingRunning.length > 0) return 'running'
  if (worktree.locked) return 'locked'
  if (worktree.status !== 'ready') return 'unhealthy'
  if (worktree.dirty === true) return 'dirty'
  if (worktree.dirty === null) return 'status-unknown'
  return undefined
}

/** A new session can target a worktree only while the path is healthy. */
export function canTargetSession(worktree: GitWorktreeInfo): boolean {
  return worktree.status === 'ready'
}

/**
 * Session closure over `parentSessionId`: roots plus every session transitively parented
 * under them (cycle-safe, order stable), used to enumerate the tree a worktree removal would
 * orphan. This is the FORK closure over the VISIBLE (non-subagent) session rows: the caller's
 * row source drops subagent-origin rows upstream, so every edge here is a fork edge — and a
 * fork IS a worktree session by construction (it copies the source header's cwd and attaches
 * to the SOURCE's workspace), which is why archiving it is the intended semantics of
 * 「归档工作区中会话」. Do NOT add an `origin === 'subagent'` filter: it would collapse the
 * closure to the roots and silently drop the forks this option must archive (the subagent
 * closure lives in the sidebar's `sessionPurgeClosure`).
 */
export function collectSessionClosure(
  sessions: ReadonlyArray<{ readonly sessionId: string; readonly parentSessionId?: string }>,
  roots: ReadonlyArray<string>,
): string[] {
  const byParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (session.parentSessionId === undefined) continue
    const siblings = byParent.get(session.parentSessionId)
    if (siblings === undefined) byParent.set(session.parentSessionId, [session.sessionId])
    else siblings.push(session.sessionId)
  }
  const seen = new Set<string>(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of byParent.get(parent) ?? []) {
      if (!seen.has(child)) {
        seen.add(child)
        queue.push(child)
      }
    }
  }
  return [...seen]
}
