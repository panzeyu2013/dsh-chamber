/**
 * core-internals.ts — Internal record/topology types and the per-common-dir mutex.
 *
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
  /** child → parent edges from every loaded agent's session header (fork
   *  lineage included — the ORIGIN set below decides which edges are walked). */
  readonly parentBySession: ReadonlyMap<string, string>
  /** Sessions whose header carries `origin: 'subagent'` (delegation children).
   *  A recorded parent edge of any OTHER session is fork lineage and is never
   *  walked (design 08 §5.2 amendment). */
  readonly subagentOriginSessions: ReadonlySet<string>
  /** Rows whose `origin` is present but neither absent nor `'subagent'` (a
   *  pinned-vendor drift). Handled PER ROW — such a session is NOT
   *  subagent-origin, so its edge terminates and it keeps blocking
   *  (fail-closed) — while the drift is reported as a snapshot diagnostic so
   *  it is never silent and never darkens the whole domain (AGENTS: one failed
   *  entity must not erase or block unrelated complete entities). */
  readonly originDrift: readonly AgentRowDrift[]
  /** Rows whose `status` is neither `'idle'` nor `'running'` (a pinned-vendor
   *  drift). Handled PER ROW and read CONSERVATIVELY: an unknown liveness fact
   *  is treated as RUNNING, so the session keeps blocking a removal, and the
   *  drift is reported as a snapshot diagnostic instead of darkening the whole
   *  source read. */
  readonly statusDrift: readonly AgentRowDrift[]
  /** Rows whose `cwd` is present but cannot be used as a normalized absolute
   *  path (a pinned-vendor drift). Handled PER ROW: the row never darkens the
   *  source read, and a BLOCKING running row among them has an UNKNOWN
   *  location — every removal is then refused (`runningAtPath` fail-closed)
   *  rather than assumed to sit outside the target. */
  readonly cwdDrift: readonly AgentRowDrift[]
  /** Running sessions that actually BLOCK a worktree removal: the non-inert
   *  ones (an archived session, or a SUBAGENT-origin descendant of an archived
   *  ancestor, is inert — design 08 §5.2 amendment). */
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
  /** TRUE when a mutation-path topology listing could not canonicalize the
   *  recorded path: the worktree's directory no longer exists (externally
   *  deleted without `git worktree remove`) and only its admin record
   *  survives. Such rows carry the RAW normalized recorded path — no
   *  filesystem probe (dirty/attention/running) may touch them, and they can
   *  only be cleaned as leftover records by the missing-record removal path.
   *  Snapshot listings (listWorktrees) never set this; the snapshot has its
   *  own per-row path-availability handling. */
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
  /** User-authorized discard of uncommitted state (design 08 §5.3 amendment):
   *  dirty worktrees are removed with `git worktree remove --force`; the
   *  branch/commits/HEAD are never touched. Carried so replay/reconcile
   *  paths keep the identical fingerprint and the same force semantics. */
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

