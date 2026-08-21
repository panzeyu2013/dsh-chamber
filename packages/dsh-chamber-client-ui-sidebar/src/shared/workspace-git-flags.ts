/**
 * Neutral per-workspace Git flags (design 08 §11, OpenChamber sidebar
 * alignment, 2026-08): a tiny shared registry the chamber Git plugin
 * publishes and the sidebar reads — the sidebar stays free of Git types,
 * it only consumes booleans. Drives:
 *  - the workspace fold button: a worktree (derived) workspace shows the
 *    git-branch glyph at rest and the collapse chevron on hover
 *    (OpenChamber SessionGroupSection group-header swap);
 *  - create-from-main-only gating (no second-level derivation).
 *
 * The plugin clears a source's flags when it disconnects or its snapshot
 * no longer associates the workspace.
 */

export interface WorkspaceGitFlag {
  /** True when this workspace IS a git worktree (derived workspace). */
  isWorktree: boolean
  /** True when this workspace is the repository's MAIN checkout. */
  isMain: boolean
  /** For a derived worktree: the MAIN checkout workspace id of the same
   *  repository (drag boundary — a derived workspace cannot precede it). */
  mainWorkspaceId?: string
  /** True when the workspace's path no longer exists (externally deleted
   *  worktree left an orphaned registration — Plan A). */
  orphaned?: boolean
  /** The repository's opaque identity (repoId) this workspace belongs to —
   *  published directly so the sidebar can attribute even when the MAIN
   *  checkout itself is unregistered (review P2-4). */
  repoKey?: string
}

/** One UNREGISTERED worktree of a repository (no dsh workspace). */
export interface UnregisteredWorktreeInfo {
  name: string
  worktreeId: string
  branch: string | null
  status: 'ready' | 'missing' | 'invalid' | 'not-a-repo'
  headState: 'branch' | 'detached' | 'unborn'
  attention: string[]
  dirty: boolean | null
  head: string
}

/** Per-repository layout: where the registered workspaces sit + which
 *  unregistered worktrees belong to the group (Plan A rendering). */
export interface RepoGitLayout {
  /** The repository's opaque identity (the snapshot repoId). */
  repoKey: string
  /** The main checkout's workspace id (null when the main is unregistered). */
  mainWorkspaceId: string | null
  unregistered: UnregisteredWorktreeInfo[]
}

const flags = new Map<string, WorkspaceGitFlag>()
const repoLayouts = new Map<string, RepoGitLayout[]>()
const listeners = new Set<() => void>()
/** Monotonic version — the sidebar subscribes via getSnapshot on THIS so a
 *  store change actually re-renders (review P1: a constant snapshot never
 *  triggers React). */
let version = 0

function bump(): void {
  version += 1
  for (const listener of listeners) listener()
}

function keyOf(sourceId: string, workspaceId: string): string {
  return `${sourceId}\u0000${workspaceId}`
}

export function setWorkspaceGitFlag(
  sourceId: string,
  workspaceId: string,
  flag: WorkspaceGitFlag | undefined,
): void {
  const key = keyOf(sourceId, workspaceId)
  if (flag === undefined) {
    if (!flags.delete(key)) return
  } else {
    const existing = flags.get(key)
    if (existing !== undefined
      && existing.isWorktree === flag.isWorktree
      && existing.isMain === flag.isMain
      && existing.mainWorkspaceId === flag.mainWorkspaceId
      && existing.orphaned === flag.orphaned
      && existing.repoKey === flag.repoKey) {
      return
    }
    flags.set(key, flag)
  }
  bump()
}

/** Clear every flag of one source (disconnect / no snapshot). */
export function clearWorkspaceGitFlags(sourceId: string): void {
  let changed = false
  for (const key of flags.keys()) {
    if (key.startsWith(`${sourceId}\u0000`)) {
      flags.delete(key)
      changed = true
    }
  }
  if (repoLayouts.delete(sourceId)) changed = true
  if (changed) bump()
}

export function getWorkspaceGitFlag(sourceId: string, workspaceId: string): WorkspaceGitFlag | undefined {
  return flags.get(keyOf(sourceId, workspaceId))
}

/** Drop this source's flags EXCEPT the given workspace ids (keep). The
 *  refresh publishes fresh flags first, then prunes the stale ones — so a
 *  workspace that vanished from the worktree list (externally deleted
 *  worktree) keeps its PREVIOUS identity flag until the orphan merge runs
 *  on top of it (review: a full clear first would destroy it). */
export function retainSourceWorkspaceFlags(sourceId: string, keep: ReadonlySet<string>): void {
  let changed = false
  for (const key of flags.keys()) {
    if (!key.startsWith(`${sourceId}\u0000`)) continue
    const workspaceId = key.slice(sourceId.length + 1)
    if (keep.has(workspaceId)) continue
    flags.delete(key)
    changed = true
  }
  if (changed) bump()
}

/** Publish the source's full repo layout (Plan A): replaces the previous. */
export function setSourceRepoLayouts(sourceId: string, layouts: RepoGitLayout[]): void {
  const existing = repoLayouts.get(sourceId)
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(layouts)) return
  repoLayouts.set(sourceId, layouts)
  bump()
}

export function getWorkspaceGitFlagsVersion(): number {
  return version
}

export function getSourceRepoLayouts(sourceId: string): RepoGitLayout[] {
  return repoLayouts.get(sourceId) ?? []
}

export function subscribeWorkspaceGitFlags(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
