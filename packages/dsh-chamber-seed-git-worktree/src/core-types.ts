/**
 * core-types.ts — Wire/domain/type surface of the git worktree core.
 *
 * Extracted verbatim from core.ts (B5 split); core.ts re-exports the public
 * names so the package/test import surface is unchanged.
 */

export type MaybePromise<T> = T | Promise<T>

export interface WorkspaceFact {
  readonly workspaceId: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

export interface AgentFact {
  readonly sessionId: string
  readonly status: 'idle' | 'running'
  readonly cwd?: string
  /** The recorded parent session (`session.header.parentSession`). Loaded for
   *  EVERY agent (any status), because the archived-aware running guard walks
   *  the chain from a running descendant up to an archived ancestor (design 08
   *  §6 amendment, 2026-09). The edge MEANS one of two things and only
   *  `origin` tells them apart — see below. */
  readonly parentSessionId?: string
  /** Coarse durable child origin (`session.header.origin`). `'subagent'` marks
   *  a DELEGATION child (`packages/subagent/subagent` sets it); ABSENT means
   *  the `parentSessionId` edge is FORK lineage (upstream `session/fork` and
   *  `SessionStore.fork` set `parentSession` with NO origin). Only
   *  subagent-origin edges are lineage for the archived-aware running guard —
   *  a fork edge TERMINATES the walk, because a fork is an independent session
   *  whose run must never be treated as inert (design 08 §5.2 amendment). */
  readonly origin?: 'subagent'
}

export interface WorktreeStateSource {
  listWorkspaces(): MaybePromise<readonly WorkspaceFact[]>
  listAgents(): MaybePromise<readonly AgentFact[]>
  /** The authoritative archived-session set (`workspaceRegistry.
   *  archivedSessionIds`). A missing/invalid surface must THROW — never read
   *  as an empty set, which would silently turn every archived session back
   *  into a blocking one. */
  listArchivedSessionIds(): MaybePromise<readonly string[]>
}

export interface GitCommandRequest {
  readonly cwd: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export interface GitCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type GitRunner = (request: GitCommandRequest) => Promise<GitCommandResult>

export interface GitChildProcess {
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal: NodeJS.Signals): boolean
}

export type GitSpawner = (
  command: string,
  args: string[],
  options: {
    readonly cwd: string
    readonly shell: false
    readonly stdio: readonly ['ignore', 'pipe', 'pipe']
    readonly windowsHide: true
    readonly env: NodeJS.ProcessEnv
  },
) => GitChildProcess

export interface WorktreeFileSystem {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<{ isDirectory(): boolean }>
  /** Recursive directory creation (the unified worktree root). */
  mkdir(path: string): Promise<void>
  /** True when `path` exists as a file or directory (git-dir state probes). */
  exists(path: string): Promise<boolean>
  /** Read a small UTF-8 file (the worktree `.git` pointer). Rejects when absent/unreadable. */
  readFile(path: string): Promise<string>
}

export interface GitWorktreeCoreOptions {
  readonly source: WorktreeStateSource
  readonly git?: GitRunner
  readonly fs?: WorktreeFileSystem
  readonly now?: () => number
  readonly token?: () => string
  /** Test seam; production retains the fixed MAX_OPERATIONS policy. */
  readonly operationCapacity?: number
  /** Test seam for the non-cancelling snapshot response deadline. */
  readonly snapshotWallTimeoutMs?: number
  /** Unified worktree root (design 08 §2.2): all chamber checkouts live under
   *  the dsh home (`$DSH_HOME/worktrees`, one subdirectory per repository) —
   *  outside any working tree so git status stays clean. Defaults from the
   *  instance's DSH_HOME (fallback: ~/.dsh). */
  readonly worktreesRoot?: string
}

export type CreateBranch =
  | { readonly kind: 'existing'; readonly name: string }
  | { readonly kind: 'new'; readonly name: string }

export interface PreviewCreateInput {
  readonly sourceWorkspaceId: string
  readonly basename: string
  readonly branch: CreateBranch
  /** Optional start point for a NEW branch (OpenChamber sourceBranch):
   *  the new branch is created from this local branch's head instead of the
   *  main checkout HEAD. Ignored for existing branches. */
  readonly startRef?: string
}

export interface PreviewCreateResult {
  readonly previewToken: string
  readonly expiresAt: number
  readonly repoId: string
  readonly commonDir: string
  readonly mainPath: string
  readonly targetPath: string
  readonly branch: string
  readonly baseHead: string
}

export interface CreateInput {
  readonly previewToken: string
  readonly operationId: string
}

export interface CreateResult {
  readonly operationId: string
  readonly created: true
  readonly replayed: boolean
  readonly repoId: string
  readonly worktreeId: string
  readonly commonDir: string
  readonly path: string
  readonly branch: string
  readonly head: string
  /** True only after this process observed `git worktree add` exit zero. */
  readonly rollbackAuthorized: boolean
  readonly branchCreated: boolean
}

export interface RollbackCreateInput {
  readonly operationId: string
}

export interface RollbackCreateResult {
  readonly operationId: string
  readonly removed: true
  readonly replayed: boolean
  readonly repoId: string
  readonly worktreeId: string
  readonly commonDir: string
  readonly path: string
  readonly branch: string
  readonly head: string
  readonly branchPreserved: true
}

export interface RemoveInput {
  readonly operationId: string
  /** Optional: an UNREGISTERED worktree (no dsh workspace) is removed with
   *  this absent — the git-first removal then returns `next: 'none'` and the
   *  client skips workspace.delete (design 08 §3.4, Plan A). */
  readonly workspaceId?: string
  /** Required when `workspaceId` is absent (UNREGISTERED removal): the exact
   *  worktree path — the workspace-based discovery cannot derive it. */
  readonly path?: string
  readonly expected: {
    readonly repoId: string
    readonly worktreeId: string
    readonly branch: string | null
    readonly head: string
  }
  /** Optional local branch to delete AFTER the worktree removal (design 08
   *  §5.3 user decision): best-effort — a failure is reported honestly on the
   *  result and never rolls back the (already gone) worktree. */
  readonly deleteBranch?: string
  /** Explicit user authorization to DISCARD the worktree's uncommitted state
   *  (dirty/untracked files). When true, a dirty worktree is removed with
   *  `git worktree remove --force` instead of being rejected. The branch,
   *  commits and HEAD are never touched — only the working tree files are
   *  discarded. Locked/running/identity guards are unchanged. (design 08 §5.3
   *  amendment, 2026-08 user decision) */
  readonly discardChanges?: boolean
}

export interface RemoveResult {
  readonly operationId: string
  readonly removed: true
  readonly replayed: boolean
  /** Absent when the removed worktree was UNREGISTERED. */
  readonly workspaceId?: string
  readonly repoId: string
  readonly worktreeId: string
  readonly commonDir: string
  readonly path: string
  readonly branch: string | null
  readonly head: string
  /** Fresh membership captured immediately before Git-first removal. */
  readonly sessionIds: readonly string[]
  /** The caller may now delete only this durable workspace registration.
   *  'none' when the removed worktree was UNREGISTERED (no workspace). */
  readonly next: 'delete-workspace' | 'none'
  /** The host never deletes a branch on its own: `branchPreserved` means
   *  "preserved unless the caller explicitly requested deletion" — when
   *  `deleteBranch` was requested, the branchDelete* flags below report the
   *  outcome of that explicit best-effort step. */
  readonly branchPreserved: true
  /** Set when `deleteBranch` was requested and deleted successfully. */
  readonly branchDeleted?: boolean
  /** Set when `deleteBranch` was requested but the branch delete failed —
   *  the worktree removal still stands. */
  readonly branchDeleteFailed?: boolean
  /** Why the optional branch deletion failed (safe, bounded text). */
  readonly branchDeleteError?: string
}

export interface SnapshotError {
  readonly code: string
  readonly operation: 'discover' | 'list' | 'status' | 'associate'
  readonly message: string
  readonly path?: string
  readonly workspaceId?: string
}

export type GitWorktreeState = 'ready' | 'missing' | 'invalid' | 'not-a-repo'

export type GitAttentionReason = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

export interface SnapshotWorktree {
  readonly worktreeId: string
  readonly path: string
  readonly head: string
  readonly branch: string | null
  readonly isMain: boolean
  readonly dirty: boolean | null
  readonly locked: boolean
  /** Path/repository health: ready | missing | invalid | not-a-repo. */
  readonly status: GitWorktreeState
  /** Git HEAD classification: branch | detached | unborn. */
  readonly headState: 'branch' | 'detached' | 'unborn'
  /** Local-ref upstream facts from the status branch header (`## b...u [ahead
   *  N, behind M]`); null/0 when there is no upstream or the status failed. */
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
  /** In-progress Git operations detected in the worktree git dir (best-effort). */
  readonly attention: readonly GitAttentionReason[]
  readonly workspaceId: string | null
  readonly sessionIds: readonly string[]
  /** ALL running associated sessions (display fact). */
  readonly runningSessionIds: readonly string[]
  /** The running sessions that actually BLOCK a removal — runningSessionIds
   *  minus the INERT ones (archived, or under an archived ancestor). An old
   *  client that only knows runningSessionIds stays conservative. */
  readonly blockingRunningSessionIds: readonly string[]
}

export interface SnapshotRepository {
  readonly repoId: string
  readonly commonDir: string
  readonly mainPath: string
  readonly worktrees: readonly SnapshotWorktree[]
  /** Local branch names (`git show-ref --heads`); a convenience for the
   *  create dialog's existing-branch picker. Empty on failure — never a
   *  snapshot error. */
  readonly branches: readonly string[]
}

export interface SnapshotResult {
  readonly repos: readonly SnapshotRepository[]
  readonly errors: readonly SnapshotError[]
  readonly sourceError?: {
    readonly code: 'state-source-unavailable' | 'state-source-capacity'
      | 'git-unavailable' | 'snapshot-capacity' | 'snapshot-deadline'
    readonly message: string
  }
}

export interface GitWorktreeDomainError {
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

/** Explicit business carrier: the dsh gateway does not preserve thrown error fields. */
export type GitWorktreeDomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GitWorktreeDomainError }

/** Stable action error code; Typert transports the Error message to clients.
 *  INVARIANT (2026-09): an explicit `retryable: false` is a host-proven
 *  PRE-MUTATION refusal — the mutation provably did not commit (the
 *  worktree-submodules gate and the commitBoundRemove reclassification are
 *  the only emitters, both after proving the target still exists). Never
 *  throw with explicit `retryable: false` from a path that may have mutated:
 *  the client clears a pending "uncertain outcome" recovery on that signal.
 *  An explicit `retryable: true` and an absent flag (code in RETRYABLE_CODES
 *  ⇒ serialized true) both mean "outcome unverified — same-operation replay
 *  is the safe route". */
