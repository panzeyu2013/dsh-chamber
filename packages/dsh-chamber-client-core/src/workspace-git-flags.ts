/**
 * Neutral per-workspace Git flags (OpenChamber sidebar alignment): a tiny shared
 * registry the chamber Git plugin publishes and the sidebar reads — the sidebar
 * stays free of Git types, it consumes booleans only. Drives the workspace fold
 * button (worktree → branch glyph at rest, chevron on hover) and
 * create-from-main-only gating. The plugin clears a source's flags when it
 * disconnects or its snapshot no longer associates the workspace.
 */

export interface WorkspaceGitFlag {
  isWorktree: boolean
  isMain: boolean
  /** For a derived worktree: the MAIN checkout workspace id of the same repository (drag boundary — a derived workspace cannot precede it). */
  mainWorkspaceId?: string
  /** True when the workspace's path no longer exists (externally deleted worktree → orphaned registration; Plan A). */
  orphaned?: boolean
  /** The repository's opaque identity (repoId) this workspace belongs to — published even when the MAIN checkout is unregistered. */
  repoKey?: string
}

/** One UNREGISTERED worktree of a repository (no dsh workspace). */
export interface UnregisteredWorktreeInfo {
  /** Directory name (basename) — the fallback checkout-row title. */
  name: string
  /** Host-minted opaque identity. Never reconstruct this from `path`. */
  worktreeId: string
  /**
   * The checkout's CANONICAL path (host-canonical, as the Git host resolved it).
   * THIS is the checkout row's placement key, dedupe key and `path` fact; the
   * row identity itself is derived (`__checkout__:<canonicalPath>`), never the
   * opaque worktreeId.
   */
  path: string
  branch: string | null
  status: 'ready' | 'missing' | 'invalid' | 'not-a-repo'
  headState: 'branch' | 'detached' | 'unborn'
  attention: string[]
  dirty: boolean | null
  /** Git's own `locked` worktree flag: a locked checkout is never removable. */
  locked: boolean
  head: string
}

/** Per-repository layout: where the registered workspaces sit + the group's unregistered worktrees (Plan A). */
export interface RepoGitLayout {
  repoKey: string
  /** The main checkout's workspace id (null when the main is unregistered). */
  mainWorkspaceId: string | null
  unregistered: UnregisteredWorktreeInfo[]
}

/**
 * The repo-group-collapse predicate: whether a derived workspace row is hidden
 * by its git MAIN workspace's fold. Pure, so the sidebar's render filter and
 * drag-anchor math share one verdict. `mainPresent` guards the stale window
 * after the main's registration vanished while its flags were not re-published:
 * a missing main row offers no expand control, so its derived rows must stay
 * visible instead of being locked behind a fold pref nobody can toggle.
 */
export function hiddenByMainWorkspaceFold(
  flag: WorkspaceGitFlag | undefined,
  foldedMain: boolean,
  mainPresent: boolean,
): boolean {
  return flag?.mainWorkspaceId !== undefined && foldedMain && mainPresent
}

const flags = new Map<string, WorkspaceGitFlag>()
const repoLayouts = new Map<string, RepoGitLayout[]>()
/** Sources whose FIRST git snapshot was published: a source's git identity is
 *  UNKNOWN until then — the sidebar gates the workspace accent on this so a git
 *  workspace never first renders an independent hue that later flips to its
 *  family hue (the one-time startup flash). Cleared on disconnect. */
const loadedSources = new Set<string>()
const listeners = new Set<() => void>()
/** Monotonic version — the sidebar subscribes via getSnapshot on THIS so a store change actually re-renders. */
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
  // The source's identity is unknown again — a reconnect must re-gate the accent.
  if (loadedSources.delete(sourceId)) changed = true
  if (changed) bump()
}

export function getWorkspaceGitFlag(sourceId: string, workspaceId: string): WorkspaceGitFlag | undefined {
  return flags.get(keyOf(sourceId, workspaceId))
}

/** Mark a source's git identity resolved (its first snapshot, even empty, was published). Idempotent; bumps on the transition. */
export function markSourceGitFlagsLoaded(sourceId: string): void {
  if (loadedSources.has(sourceId)) return
  loadedSources.add(sourceId)
  bump()
}

/** Whether the source's git identity is known. Before that every flag is UNKNOWN, not absent — consumers must not render a definitive state from undefined-ness alone. */
export function isSourceGitFlagsLoaded(sourceId: string): boolean {
  return loadedSources.has(sourceId)
}

/** Drop this source's flags EXCEPT `keep`. The refresh publishes fresh flags first, then
 *  prunes — a workspace missing from the worktree list keeps its PREVIOUS identity flag
 *  until the orphan merge runs on top (a full clear would destroy it). */
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Structural equality of two JSON-shaped layout values. The layout dedupe MUST
 * compare every field — including each unregistered worktree's `path` and
 * `locked` facts — or a refresh whose only change is one of them is dropped
 * before the store/version moves (the sidebar never sees it). Key order must
 * not matter: the publisher may build the same rows in a different order, so a
 * substring/JSON.stringify comparison would both miss fields (if scoped) and
 * churn on ordering. Recursive on purpose.
 */
function sameLayoutValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameLayoutValue(value, right[index]))
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(key => Object.hasOwn(right, key) && sameLayoutValue(left[key], right[key]))
}

/**
 * Publish the source's full repo layout (Plan A): replaces the previous.
 *
 * CHECKOUT rows are driven by the DERIVED row fields (`kind/repoKey/
 * familyMainId/path`), never by a synthetic flag published here:
 * {@link retainSourceWorkspaceFlags} prunes every key that is not a registered
 * workspace, so a checkout flag would be dropped on the next refresh anyway.
 */
export function setSourceRepoLayouts(sourceId: string, layouts: RepoGitLayout[]): void {
  const existing = repoLayouts.get(sourceId)
  if (existing !== undefined && sameLayoutValue(existing, layouts)) return
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
