/**
 * The Git plugin's LAYOUT projection of one worktree snapshot (design 08 PR2,
 * 11-final-design §5.1). Kept pure and separate from the coordinator so the
 * published shape — including the placement keys `path`/`locked` — is testable
 * without the coordinator's singletons, timers and bridge wiring.
 *
 * The snapshot is the authority (I7): one layout entry per repository, carrying
 * the host-minted opaque `repoId` as `repoKey`, the MAIN checkout's workspace id
 * (`null` while unregistered — the consumer then derives NO checkout row, I9) and
 * the repository's UNREGISTERED non-main checkouts. A REGISTERED worktree is
 * never a layout entry: its row is the workspace row, and a second derived row
 * would render the same path twice and split its sessions (dedupe, §5.2).
 */
import { basenameOf } from '@dsh-chamber/dsh-chamber-client-core'
import type { GitWorktreeSnapshot, UnregisteredWorktreeInfo } from './types.ts'

/** One repository's derived checkout layout (the shape published to the
 *  sidebar's neutral registry as client-core's `RepoGitLayout`). */
export interface RepoLayoutPlan {
  repoKey: string
  mainWorkspaceId: string | null
  unregistered: UnregisteredWorktreeInfo[]
}

/**
 * Project one snapshot onto the layout entries the sidebar/core consume to
 * derive `kind:'checkout'` rows.
 * @param snapshot - the EFFECTIVE snapshot the round publishes (a stale round's
 *   previous topology must be projected verbatim, never a partial merge).
 * @returns one entry per repository, in snapshot order.
 */
export function repoLayouts(snapshot: GitWorktreeSnapshot): RepoLayoutPlan[] {
  return snapshot.repos.map((repo) => {
    const mainWorkspaceId = repo.worktrees.find(worktree => worktree.isMain)?.workspaceId ?? null
    const unregistered: UnregisteredWorktreeInfo[] = []
    for (const worktree of repo.worktrees) {
      // The MAIN checkout is never an unregistered row (its row is the source
      // workspace), and a registered worktree already owns one.
      if (worktree.isMain || worktree.workspaceId !== null) continue
      unregistered.push({
        name: basenameOf(worktree.path) || worktree.path,
        worktreeId: worktree.worktreeId,
        branch: worktree.branch,
        status: worktree.status,
        headState: worktree.headState,
        attention: [...worktree.attention],
        dirty: worktree.dirty,
        head: worktree.head,
        // Placement key + the locked fact the occupant's removal guard reads
        // (the derived row is the checkout's only UI, §5.1).
        path: worktree.path,
        locked: worktree.locked,
      })
    }
    return { repoKey: repo.repoId, mainWorkspaceId, unregistered }
  })
}
