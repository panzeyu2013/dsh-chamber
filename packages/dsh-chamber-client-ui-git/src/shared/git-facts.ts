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

/** One option per repository that currently has at least one registered workspace. */
export function createSourceOptions(snapshot: GitWorktreeSnapshot): CreateSourceOption[] {
  const out: CreateSourceOption[] = []
  for (const repo of snapshot.repos) {
    const source = repo.worktrees.find(worktree => worktree.workspaceId !== null)
    if (source?.workspaceId === null || source === undefined) continue
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

export type RemoveBlockReason =
  | 'main'
  | 'unregistered'
  | 'running'
  | 'current'
  | 'locked'
  | 'unhealthy'
  | 'dirty'
  | 'status-unknown'
  | undefined

/** Safe-remove guard: both fresh running facts and the aggregate current id block removal. */
export function removeBlockReason(worktree: GitWorktreeInfo, currentSessionId?: string): RemoveBlockReason {
  if (worktree.isMain) return 'main'
  if (worktree.workspaceId === null) return 'unregistered'
  if (worktree.runningSessionIds.length > 0) return 'running'
  if (currentSessionId !== undefined && worktree.sessionIds.includes(currentSessionId)) return 'current'
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

/** Stable short head for compact sidebar rows. */
export function shortHead(head: string): string {
  return head.length > 8 ? head.slice(0, 8) : head
}
