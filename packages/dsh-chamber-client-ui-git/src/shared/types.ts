/** Opaque branch selection accepted by previewCreate. */
export type GitBranchSpec =
  | { kind: 'existing'; name: string }
  | { kind: 'new'; name: string }

/** Explicit host-domain envelope nested inside Typert's transport envelope. */
export type GitWorktreeDomainResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: {
        code: string
        message: string
        retryable?: boolean
        details?: Record<string, unknown>
      }
    }

/** One honest Git/worktree failure. Partial failures coexist with valid repos. */
export interface GitWorktreeError {
  code: string
  operation: string
  repoId?: string
  worktreeId?: string
  path?: string
  workspaceId?: string
  message: string
}

export interface GitSourceError {
  code: string
  message: string
}

/** One worktree row returned by the host-side Git Remote. */
export interface GitWorktreeInfo {
  /** Host-minted opaque identity. Never reconstruct this from `path`. */
  worktreeId: string
  path: string
  head: string
  branch: string | null
  isMain: boolean
  /** null means the host could not determine status; never coerce to clean. */
  dirty: boolean | null
  locked: boolean
  status: 'ready' | 'missing' | 'invalid' | 'not-a-repo'
  headState: 'branch' | 'detached' | 'unborn'
  /** Local-ref upstream facts from the status branch header; null/0 when absent or on an older host. */
  upstream: string | null
  ahead: number
  behind: number
  attention: string[]
  workspaceId: string | null
  sessionIds: string[]
  runningSessionIds: string[]
  /** Running sessions that actually BLOCK a removal: every running session
   *  EXCEPT the INERT ones (archived, or under an archived ancestor). ABSENT on an
   *  older host — callers fall back to `runningSessionIds` (conservative). */
  blockingRunningSessionIds?: string[]
}

/** Repository identity is host-minted; paths below are display facts only. */
export interface GitRepoTopology {
  repoId: string
  commonDir: string
  mainPath: string
  worktrees: GitWorktreeInfo[]
  /** Local branch names for the existing-branch picker; empty when the host is older or the read failed. */
  branches: string[]
}

export interface GitWorktreeSnapshot {
  repos: GitRepoTopology[]
  errors: GitWorktreeError[]
  sourceError?: GitSourceError
}

export interface PreviewCreateInput {
  sourceWorkspaceId: string
  basename: string
  branch: GitBranchSpec
  /** Optional start point for a NEW branch (OpenChamber sourceBranch). */
  startRef?: string
}

export interface PreviewCreateResult {
  previewToken: string
  expiresAt: number
  repoId: string
  commonDir: string
  mainPath: string
  targetPath: string
  branch: string
  baseHead: string
}

export interface CreateWorktreeResult {
  operationId: string
  created: true
  replayed: boolean
  repoId: string
  worktreeId: string
  commonDir: string
  path: string
  branch: string
  head: string
  branchCreated: boolean
}

/** Ask the host to move an existing session's working directory into a checkout
 *  (the ONLY chamber write that sends a session into a checkout; design 08 PR1). */
export interface EnterWorktreeInput {
  sessionId: string
  /** Snapshot-canonical checkout path; the host re-canonicalizes and matches it
   *  against the authoritative worktree topology. */
  path: string
}

/** Enter result correlation: both values must echo the request. */
export interface EnterWorktreeResult {
  sessionId: string
  path: string
}

export interface RemoveWorktreeResult {
  operationId: string
  removed: true
  replayed: boolean
  repoId: string
  worktreeId: string
  workspaceId?: string
  commonDir: string
  path: string
  branch: string | null
  head: string
  sessionIds: string[]
  next: 'delete-workspace' | 'none'
  branchPreserved: true
  branchDeleted?: boolean
  branchDeleteFailed?: boolean
}

export interface UnregisteredWorktreeInfo {
  name: string
  /** The host-minted opaque worktree id — copied verbatim (never reconstructed). */
  worktreeId: string
  branch: string | null
  status: 'ready' | 'missing' | 'invalid' | 'not-a-repo'
  headState: 'branch' | 'detached' | 'unborn'
  attention: string[]
  dirty: boolean | null
  head: string
  /** Snapshot-canonical checkout path: the placement/identity key of the derived
   *  `kind:'checkout'` row and the path-based removal target (design 08 PR2). */
  path: string
  /** `git worktree lock` state — a locked checkout cannot be removed. */
  locked: boolean
}

export type GitBusyKind = 'preview' | 'create' | 'remove' | 'recovery' | 'session-enter'

export interface GitBusyState {
  kind: GitBusyKind
  operationId: string
}

export type GitRecovery =
  | {
      /** Host create may have committed but its response was not trustworthy. */
      kind: 'git-create'
      /** Full preview facts are retained so a same-id replay re-runs the SAME
       *  correlated host create (PR1: the create saga has no workspace/session legs). */
      preview: PreviewCreateResult
      operationId: string
      message: string
    }
  | {
      /** Host remove may have committed; retry the same opaque expectation/id. */
      kind: 'git-remove'
      operationId: string
      expected: {
        repoId: string
        worktreeId: string
        branch: string | null
        head: string
      }
      path: string
      message: string
      /** Optional local branch to delete after the worktree removal. */
      deleteBranch?: string
      /** Original authorization to discard uncommitted state — the replay input MUST
       *  be byte-identical (the host fingerprints it), so a force retry re-sends it. */
      discardChanges?: boolean
    }

export interface GitSourceState {
  sourceId: string
  connected: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot?: GitWorktreeSnapshot
  sourceError?: GitSourceError
  actionError?: string
  /** The failure code behind {@link GitSourceState.actionError}: the source-level
   *  strip localizes it; absent on an unmapped/plain failure (English message shown). */
  actionErrorCode?: string
  busy?: GitBusyState
  recovery?: GitRecovery
  updatedAt?: number
}
