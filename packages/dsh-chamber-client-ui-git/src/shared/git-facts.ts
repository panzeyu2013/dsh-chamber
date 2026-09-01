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

/** One option per repository that currently has at least one registered
 *  workspace. The source is ALWAYS the repository's MAIN checkout (no
 *  second-level derivation — OpenChamber parity), falling back to the first
 *  registered workspace only when the main checkout has none. */
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
 * Safe-remove guard: both fresh running facts and the aggregate current id
 * block removal. `runtimeKnown` is the fail-closed half (2026-09 scan): the
 * per-source `runtime` channel (which carries `current`) withdraws while its
 * shell reconnects/reloads — treating the resulting `undefined` current as
 * "not current" would silently open the removal of a worktree holding the
 * very session the user is viewing. When the runtime channel is absent AND
 * the worktree accounts sessions, removal is blocked ('runtime-unknown')
 * until the channel returns.
 */
export function removeBlockReason(
  worktree: GitWorktreeInfo,
  currentSessionId?: string,
  currentSessionBlank = false,
  runtimeKnown = true,
): RemoveBlockReason {
  if (worktree.isMain) return 'main'
  if (worktree.workspaceId === null) return 'unregistered'
  if (worktree.runningSessionIds.length > 0) return 'running'
  // A BLANK (never-submitted) current session carries no content worth
  // protecting, so it must not block removal (2026-08 user report: clicking
  // "new session" on a worktree and removing it before typing).
  if (currentSessionId !== undefined && !currentSessionBlank && worktree.sessionIds.includes(currentSessionId)) return 'current'
  // Fail-closed: the runtime channel is absent (withdrawn/not-yet-ready), so
  // we cannot rule the current session out of this worktree. Blank-current
  // leniency cannot apply — blankness is unknown too.
  if (!runtimeKnown && worktree.sessionIds.length > 0) return 'runtime-unknown'
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
 * Session closure over `parentSessionId`: the roots plus every session
 * transitively parented under them (cycle-safe, order stable). Used to
 * enumerate the full session tree a worktree removal would orphan.
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
