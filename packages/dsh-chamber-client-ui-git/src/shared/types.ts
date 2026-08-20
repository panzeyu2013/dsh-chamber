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
  workspaceId: string | null
  sessionIds: string[]
  runningSessionIds: string[]
}

/** Repository identity is host-minted; paths below are display facts only. */
export interface GitRepoTopology {
  repoId: string
  commonDir: string
  mainPath: string
  worktrees: GitWorktreeInfo[]
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
  /** Only a positively observed `git worktree add` exit 0 authorizes compensation. */
  rollbackAuthorized: boolean
}

export interface RollbackCreateResult {
  operationId: string
  removed: true
  replayed: boolean
  repoId: string
  worktreeId: string
  commonDir: string
  path: string
  branch: string
  head: string
  branchPreserved: true
}

export interface RemoveWorktreeResult {
  operationId: string
  removed: true
  replayed: boolean
  repoId: string
  worktreeId: string
  workspaceId: string
  commonDir: string
  path: string
  branch: string | null
  head: string
  sessionIds: string[]
  next: 'delete-workspace'
  branchPreserved: true
}

export type GitBusyKind = 'preview' | 'create' | 'remove' | 'recovery' | 'adopt-session'

export interface GitBusyState {
  kind: GitBusyKind
  operationId: string
}

export type GitRecovery =
  | {
      /** Host create may have committed but its response was not trustworthy. */
      kind: 'git-create'
      /** Full preview facts are retained so a same-id replay is correlated before adoption. */
      preview: PreviewCreateResult
      operationId: string
      sessionId: string
      message: string
    }
  | {
      kind: 'rollback-create'
      operationId: string
      /** Exact create facts required to correlate a replayed rollback response. */
      repoId: string
      worktreeId: string
      commonDir: string
      path: string
      branch: string
      head: string
      /** Preallocated before the saga, reused if ownership resolves to adopted. */
      sessionId: string
      message: string
    }
  | {
      /** The worktree exists, but its creation provenance does not authorize rollback. */
      kind: 'workspace-adopt'
      operationId: string
      path: string
      sessionId: string
      message: string
    }
  | {
      kind: 'session-create'
      workspaceId: string
      path: string
      sessionId: string
      message: string
    }
  | {
      /** Session-only adoption of an existing worktree; no Git mutation ran. */
      kind: 'session-adopt'
      path: string
      sessionId: string
      message: string
    }
  | {
      /** Host remove may have committed; retry the same opaque expectation/id. */
      kind: 'git-remove'
      operationId: string
      workspaceId: string
      expected: {
        repoId: string
        worktreeId: string
        branch: string | null
        head: string
      }
      path: string
      message: string
    }
  | {
      kind: 'workspace-delete'
      /** Replayed through the host before every registry-delete retry. */
      operationId: string
      workspaceId: string
      expected: {
        repoId: string
        worktreeId: string
        branch: string | null
        head: string
      }
      path: string
      message: string
    }

export interface GitSourceState {
  sourceId: string
  connected: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot?: GitWorktreeSnapshot
  sourceError?: GitSourceError
  actionError?: string
  busy?: GitBusyState
  recovery?: GitRecovery
  updatedAt?: number
}
