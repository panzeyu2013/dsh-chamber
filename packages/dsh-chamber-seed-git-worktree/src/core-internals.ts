/**
 * Internal record/topology types and the per-common-dir mutex.
 */
import type { AgentFact, CreateBranch, CreateResult, PreviewCreateResult, RemoveResult, RollbackCreateResult, WorkspaceFact } from './core-types.ts'

export interface AgentRowDrift {
  readonly sessionId: string
  readonly value: string
}

export interface SourceSnapshot {
  readonly workspaces: readonly WorkspaceFact[]
  /** ALL running session ids (display fact; see blockingRunningIds). */
  readonly runningSessionIds: ReadonlySet<string>
  readonly runningAgents: readonly AgentFact[]
  /** The authoritative archived set (workspaceRegistry). */
  readonly archivedSessionIds: ReadonlySet<string>
  /** child -> parent edges from every loaded agent's session header (fork included). */
  readonly parentBySession: ReadonlyMap<string, string>
  /** Sessions whose header carries `origin: 'subagent'` (delegation children). A parent
   *  edge of any OTHER session is fork lineage and is never walked. */
  readonly subagentOriginSessions: ReadonlySet<string>
  /** Rows whose `origin` is present but neither absent nor `'subagent'` (vendor drift).
   *  Handled PER ROW: not subagent-origin, so the edge terminates and the session keeps
   *  blocking (fail-closed); reported as a diagnostic, never silently and never darkening
   *  the whole domain. */
  readonly originDrift: readonly AgentRowDrift[]
  /** Rows whose `status` is neither `'idle'` nor `'running'` (vendor drift). Read
   *  CONSERVATIVELY per row: unknown liveness is treated as RUNNING so the session keeps
   *  blocking, and the drift is reported as a diagnostic. */
  readonly statusDrift: readonly AgentRowDrift[]
  /** Rows whose `cwd` is present but unusable as a normalized absolute path (vendor
   *  drift). Handled per row: never darkens the source read, and a blocking row among
   *  them has UNKNOWN location, so every removal is refused fail-closed. */
  readonly cwdDrift: readonly AgentRowDrift[]
  /** Running sessions that actually BLOCK a removal: the non-inert ones (an archived
   *  session, or a subagent-origin descendant of an archived ancestor, is inert). */
  readonly blockingRunningIds: ReadonlySet<string>
}

export interface SnapshotRunningLocation {
  readonly sessionId: string
  readonly paths: readonly string[]
}

export interface RawWorktree {
  path: string
  head: string
  branch: string | null
  locked: boolean
  prunable: boolean
  bare: boolean
  /** TRUE when a mutation-path topology listing could not canonicalize the recorded
   *  path: the directory no longer exists and only its admin record survives. Such rows
   *  carry the raw recorded path - no filesystem probe may touch them, and only the
   *  missing-record removal path can clean them. */
  missing?: boolean
}

export interface WorktreeTopology {
  readonly commonDir: string
  readonly mainPath: string
  readonly worktrees: readonly RawWorktree[]
}

export interface PreviewRecord extends PreviewCreateResult {
  readonly branchMode: CreateBranch['kind']
  /** The chosen start point for a NEW branch (undefined = main checkout HEAD). */
  readonly startRef?: string
  readonly sourceWorkspaceId: string
  readonly basename: string
  readonly createdAt: number
}

export interface CreatedFacts {
  readonly repoId: string
  readonly worktreeId: string
  readonly commonDir: string
  readonly mainPath: string
  readonly path: string
  readonly branch: string
  readonly head: string
  readonly branchCreated: boolean
}

export interface CreateOperationRecord {
  readonly previewToken: string
  readonly preview: PreviewRecord
  state: 'ready' | 'creating' | 'uncertain' | 'created'
    | 'rolling-back' | 'rollback-uncertain' | 'rolled-back'
  updatedAt: number
  attemptedCreate: boolean
  /** Provenance boundary: only an observed zero exit may authorize rollback. */
  gitAccepted: boolean
  attemptedRollback: boolean
  createPromise?: Promise<CreateResult>
  createResult?: CreateResult
  facts?: CreatedFacts
  rollbackPromise?: Promise<RollbackCreateResult>
  rollbackResult?: RollbackCreateResult
}

export interface RemoveIntent {
  /** Absent for an UNREGISTERED worktree removal (next: 'none'). */
  readonly workspaceId?: string
  /** Exact normalized registry path captured before the first mutation. */
  readonly workspacePath?: string
  readonly repoId: string
  readonly worktreeId: string
  readonly commonDir: string
  readonly mainPath: string
  readonly path: string
  readonly branch: string | null
  readonly head: string
  readonly sessionIds: readonly string[]

  /** Optional local branch to delete after removal (design 08 §5.3). */
  readonly deleteBranch?: string
  /** User-authorized discard of uncommitted state: dirty worktrees are removed with
   *  `--force`; branch/commits/HEAD are never touched. Carried so replay keeps the same semantics. */
  readonly discardChanges?: boolean
  branchDeleted?: boolean
  branchDeleteFailed?: boolean
  branchDeleteError?: string
}

export interface RemoveOperationRecord {
  readonly fingerprint: string
  state: 'ready' | 'removing' | 'uncertain' | 'removed'
  updatedAt: number
  attemptedRemove: boolean
  /** Optional branch delete was attempted once (design 08 §5.3). */
  branchDeleteAttempted: boolean
  intent?: RemoveIntent
  promise?: Promise<RemoveResult>
  result?: RemoveResult
}

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolvePromise => { release = resolvePromise })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

