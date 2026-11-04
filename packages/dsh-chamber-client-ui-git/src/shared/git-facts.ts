/** Pure Git-topology derivations shared by the UI and coordinator tests. */
import type { GitWorktreeInfo, GitWorktreeSnapshot } from './types.ts'

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

/** One option per repository whose MAIN checkout is a registered workspace.
 *
 *  PR1/V6: the source must be the main checkout (design 08 I1). A linked
 *  worktree or a subdirectory is no longer offered as a fallback — the host
 *  refuses it with `source-not-main-checkout` because the source-root containment
 *  and the session root would be wrong. A repo whose main is unregistered
 *  (I9) has no create option at all. */
export function createSourceOptions(snapshot: GitWorktreeSnapshot): CreateSourceOption[] {
  const out: CreateSourceOption[] = []
  for (const repo of snapshot.repos) {
    const main = repo.worktrees.find((worktree): worktree is GitWorktreeInfo & { workspaceId: string } => (
      worktree.isMain && worktree.workspaceId !== null
    ))
    if (main === undefined) continue
    out.push({ workspaceId: main.workspaceId, repoId: repo.repoId, label: basename(repo.mainPath) })
  }
  return out
}

/**
 * The snapshot whose facts a refresh round PUBLISHES.
 *
 * A failed round that came back empty (deadline / git-unavailable) must not erase the
 * last complete topology: the previous snapshot stays effective, so branch chips, fold
 * boundaries and drag anchors do not flicker. Its path ERRORS, however, are fresh and
 * topology-independent host verdicts (`path-unavailable` / `workspace-path-failed`) —
 * the very projection the sidebar's orphan badge and cleanup entry ride on. Dropping
 * them would hide a workspace whose path just vanished until some later round succeeds,
 * so the stale window keeps the previous repos and takes this round's errors when it has
 * any. A round WITHOUT a source error, or with repos present, always replaces wholesale
 * (fresh progress beats stale truth).
 */
export function effectiveSnapshot(
  previous: GitWorktreeSnapshot | undefined,
  snapshot: GitWorktreeSnapshot,
): GitWorktreeSnapshot {
  if (previous === undefined) return snapshot
  if (snapshot.sourceError === undefined || snapshot.repos.length > 0) return snapshot
  if (snapshot.errors.length === 0) return previous
  return { ...previous, errors: snapshot.errors }
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

/** All git rows registered to one workspace. The only production caller is the
 *  registered MAIN checkout's create entry (a registered worktree renders no Git
 *  action after PR3); kept as the single workspace-id lookup for that mount. */
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

/** A new session can target a worktree only while the path is healthy. */
export function canTargetSession(worktree: GitWorktreeInfo): boolean {
  return worktree.status === 'ready'
}
