/** Pure two-domain saga policy. Transport adapters live in coordinator.ts. */
import { errorMessage as errorText } from '@dsh-chamber/dsh-chamber-client-core'
import { collectSessionClosure } from './git-facts.ts'
import { GitWorktreeRpcError } from './git-api.ts'
import type {
  CreateWorktreeResult, GitRecovery, PreviewCreateResult, RemoveWorktreeResult,
} from './types.ts'

/** Prefer a newly established durable recovery; otherwise never erase an older unknown state. */
export function recoveryForFailure(error: unknown, previous?: GitRecovery): GitRecovery | undefined {
  if (error instanceof GitSagaError && error.recovery !== undefined) return error.recovery
  if (previous === undefined || (error instanceof GitSagaError && !error.preservePrevious)) return undefined
  return { ...previous, message: errorText(error) }
}

/** Failure plus the exact durable recovery item, when automatic compensation is unsafe/incomplete. */
export class GitSagaError extends Error {
  readonly recovery: GitRecovery | undefined
  readonly original: unknown
  readonly refreshNeeded: boolean
  /** False only when the saga positively resolved/compensated prior uncertainty. */
  readonly preservePrevious: boolean

  constructor(error: unknown, recovery?: GitRecovery, refreshNeeded = false, preservePrevious = true) {
    super(errorText(error))
    this.name = 'GitSagaError'
    this.recovery = recovery
    this.original = error
    this.refreshNeeded = refreshNeeded
    this.preservePrevious = preservePrevious
  }
}

/** True when a remove failure is a host-PROVEN pre-mutation refusal: the host
 *  serializes explicit `retryable: false` only after proving the target still
 *  exists and nothing was removed, so a pending git-remove recovery replaying this
 *  same removal may be CLEARED instead of retried forever (design 08 §6.2 bounded
 *  exception). Saga-minted recoveries (e.g. workspace-delete, which exists only
 *  after a git-removal receipt) are excluded by the `recovery === undefined` guard
 *  — a future host path must never emit `retryable: false` from a mutated path. */

export function isProvenPreMutationRefusal(error: GitSagaError): boolean {
  return error.recovery === undefined
    && error.original instanceof GitWorktreeRpcError
    && error.original.retryable === false
}

export interface CreateSagaDeps {
  hostCreate(input: { previewToken: string; operationId: string }): Promise<CreateWorktreeResult>
  hostRollback(
    input: { operationId: string },
    expected: Pick<CreateWorktreeResult, 'repoId' | 'worktreeId' | 'commonDir' | 'path' | 'branch' | 'head'>,
  ): Promise<unknown>
  workspaceCreate(path: string): Promise<{ workspaceId: string; path: string; created: boolean }>
  sessionCreate(workspaceId: string, sessionId: string): Promise<string>
  isAmbiguousHostFailure(error: unknown): boolean
}

export interface CreateSagaIds {
  operationId: string
  sessionId: string
}

function assertCreateCorrelation(
  created: CreateWorktreeResult,
  preview: PreviewCreateResult,
  operationId: string,
): void {
  if (
    created.created !== true
    || typeof created.replayed !== 'boolean'
    || typeof created.branchCreated !== 'boolean'
    || typeof created.rollbackAuthorized !== 'boolean'
    || created.operationId !== operationId
    || created.repoId !== preview.repoId
    || created.commonDir !== preview.commonDir
    || created.path !== preview.targetPath
    || created.branch !== preview.branch
    || created.head !== preview.baseHead
  ) throw new Error('gitWorktree/create result does not match the preview')
}

/** Structural correlation of a workspace.create response. NOTE: the returned
 *  `path` is NOT compared against the requested path — the registry canonicalizes
 *  through `fs.realpath` (dsh-workspace paths.ts) while the caller's path may be
 *  lexical (symlinked $DSH_HOME, browser-picked dir). The host guarantees the
 *  returned entity IS the workspace at the requested path; validation stays
 *  structural: non-empty workspaceId + created boolean. */
function assertWorkspaceCorrelation(
  workspace: { workspaceId: string; path: string; created: boolean },
): void {
  if (
    typeof workspace.workspaceId !== 'string'
    || workspace.workspaceId === ''
    || typeof workspace.created !== 'boolean'
  ) throw new Error('workspace.create result does not match the request')
}

async function createExactSession(
  create: (workspaceId: string, sessionId: string) => Promise<string>,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const publishedId = await create(workspaceId, sessionId)
  if (publishedId !== sessionId) throw new Error('session.create returned a different preallocated session id')
}

/**
 * Create policy boundary: workspace adoption failure may rollback only this host
 * operation; once session.create is attempted no durable entity is compensated;
 * the caller opens the committed session separately (opening has no ack).
 */
export async function runCreateSaga(
  deps: CreateSagaDeps,
  preview: PreviewCreateResult,
  ids: CreateSagaIds,
  options: { createSession?: boolean; sourceWorkspaceId?: string } = {},
): Promise<{ sessionId: string; workspaceId: string; path: string }> {
  let created: CreateWorktreeResult
  try {
    created = await deps.hostCreate({ previewToken: preview.previewToken, operationId: ids.operationId })
    assertCreateCorrelation(created, preview, ids.operationId)
  } catch (createError) {
    if (deps.isAmbiguousHostFailure(createError)) {
      throw new GitSagaError(createError, {
        kind: 'git-create',
        preview,
        operationId: ids.operationId,
        sessionId: ids.sessionId,
        message: errorText(createError),
        createSession: options.createSession !== false,
        ...(options.sourceWorkspaceId === undefined ? {} : { sourceWorkspaceId: options.sourceWorkspaceId }),
      }, true)
    }
    throw new GitSagaError(createError)
  }
  let workspace: { workspaceId: string; path: string; created: boolean }
  try {
    workspace = await deps.workspaceCreate(created.path)
    assertWorkspaceCorrelation(workspace)
  } catch (workspaceError) {
    if (!created.rollbackAuthorized) {
      throw new GitSagaError(workspaceError, {
        kind: 'workspace-adopt',
        operationId: ids.operationId,
        path: created.path,
        sessionId: ids.sessionId,
        message: errorText(workspaceError),
      }, true)
    }
    try {
      await deps.hostRollback({ operationId: ids.operationId }, created)
    } catch (rollbackError) {
      throw new GitSagaError(workspaceError, {
        kind: 'rollback-create',
        operationId: ids.operationId,
        repoId: created.repoId,
        worktreeId: created.worktreeId,
        commonDir: created.commonDir,
        path: created.path,
        branch: created.branch,
        head: created.head,
        sessionId: ids.sessionId,
        message: `${errorText(workspaceError)}; rollback also failed: ${errorText(rollbackError)}`,
      }, true)
    }
    // Rollback succeeded: both mutations still require an immediate fresh read.
    throw new GitSagaError(workspaceError, undefined, true, false)
  }

  // OpenChamber-aligned create (design 08 §4.2): an ordinary create registers the
  // workspace WITHOUT committing a session; `createSession: false` skips the
  // session step and the preallocated id is unused. The session step, when taken,
  // keeps its never-compensate boundary.
  if (options.createSession !== false) {
    try {
      await createExactSession(deps.sessionCreate, workspace.workspaceId, ids.sessionId)
    } catch (sessionError) {
      throw new GitSagaError(sessionError, {
        kind: 'session-create',
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        sessionId: ids.sessionId,
        message: errorText(sessionError),
      }, true)
    }
  }
  return { sessionId: ids.sessionId, workspaceId: workspace.workspaceId, path: workspace.path }
}

export interface RollbackRecoveryDeps {
  hostRollback(
    operationId: string,
    expected: Pick<CreateWorktreeResult, 'repoId' | 'worktreeId' | 'commonDir' | 'path' | 'branch' | 'head'>,
  ): Promise<unknown>
  workspaceCreate(path: string): Promise<{ workspaceId: string; path: string; created: boolean }>
  sessionCreate(workspaceId: string, sessionId: string): Promise<string>
  isWorkspaceOwnershipConflict(error: unknown): boolean
}

/**
 * Resolve a failed pre-session compensation: if rollback says a workspace already
 * adopted the path, reacquire that idempotent workspace and finish the original
 * session commit with the same preallocated id.
 */
export async function runRollbackRecovery(
  deps: RollbackRecoveryDeps,
  recovery: Extract<GitRecovery, { kind: 'rollback-create' }>,
): Promise<{ committed: false } | { committed: true; sessionId: string }> {
  try {
    await deps.hostRollback(recovery.operationId, recovery)
    return { committed: false }
  } catch (rollbackError) {
    if (!deps.isWorkspaceOwnershipConflict(rollbackError)) {
      throw new GitSagaError(rollbackError, { ...recovery, message: errorText(rollbackError) }, true)
    }
  }

  let workspace: { workspaceId: string; path: string; created: boolean }
  try {
    workspace = await deps.workspaceCreate(recovery.path)
    assertWorkspaceCorrelation(workspace)
  } catch (workspaceError) {
    throw new GitSagaError(workspaceError, { ...recovery, message: errorText(workspaceError) }, true)
  }
  try {
    await createExactSession(deps.sessionCreate, workspace.workspaceId, recovery.sessionId)
  } catch (sessionError) {
    throw new GitSagaError(sessionError, {
      kind: 'session-create',
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      sessionId: recovery.sessionId,
      message: errorText(sessionError),
    }, true)
  }
  return { committed: true, sessionId: recovery.sessionId }
}

export interface WorkspaceAdoptRecoveryDeps {
  workspaceCreate(path: string): Promise<{ workspaceId: string; path: string; created: boolean }>
  sessionCreate(workspaceId: string, sessionId: string): Promise<string>
}

/** Forward-only recovery when Git provenance cannot safely authorize rollback. */
export async function runWorkspaceAdoptRecovery(
  deps: WorkspaceAdoptRecoveryDeps,
  recovery: Extract<GitRecovery, { kind: 'workspace-adopt' | 'session-adopt' }>,
): Promise<{ sessionId: string }> {
  let workspace: { workspaceId: string; path: string; created: boolean }
  try {
    workspace = await deps.workspaceCreate(recovery.path)
    assertWorkspaceCorrelation(workspace)
  } catch (workspaceError) {
    throw new GitSagaError(workspaceError, { ...recovery, message: errorText(workspaceError) }, true)
  }
  try {
    await createExactSession(deps.sessionCreate, workspace.workspaceId, recovery.sessionId)
  } catch (sessionError) {
    throw new GitSagaError(sessionError, {
      kind: 'session-create',
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      sessionId: recovery.sessionId,
      message: errorText(sessionError),
    }, true)
  }
  return { sessionId: recovery.sessionId }
}

export interface AdoptSessionSagaDeps {
  workspaceCreate(path: string): Promise<{ workspaceId: string; path: string; created: boolean }>
  sessionCreate(workspaceId: string, sessionId: string): Promise<string>
}

/**
 * Session-only adoption of an EXISTING worktree (no Git mutation): register or
 * reuse the workspace at `path`, then commit a preallocated session. Once
 * session.create is attempted nothing is compensated; the caller retries with the
 * same preallocated id.
 */
export async function runAdoptSessionSaga(
  deps: AdoptSessionSagaDeps,
  path: string,
  sessionId: string,
): Promise<{ sessionId: string; workspaceId: string; path: string }> {
  let workspace: { workspaceId: string; path: string; created: boolean }
  try {
    workspace = await deps.workspaceCreate(path)
    assertWorkspaceCorrelation(workspace)
  } catch (workspaceError) {
    throw new GitSagaError(workspaceError, {
      kind: 'session-adopt',
      path,
      sessionId,
      message: errorText(workspaceError),
    }, true)
  }
  try {
    await createExactSession(deps.sessionCreate, workspace.workspaceId, sessionId)
  } catch (sessionError) {
    throw new GitSagaError(sessionError, {
      kind: 'session-create',
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      sessionId,
      message: errorText(sessionError),
    }, true)
  }
  return { sessionId, workspaceId: workspace.workspaceId, path: workspace.path }
}

export interface RemoveSagaDeps {
  hostRemove(): Promise<RemoveWorktreeResult>
  /** Same operation replay: freshly verifies absence + registry identity/liveness. */
  verifyTerminalRemove(): Promise<RemoveWorktreeResult>
  workspaceDelete(workspaceId: string): Promise<void>
  /** The original removal's optional branch deletion — echoed onto the
   *  workspace-delete recovery so a replay fingerprint matches. */
  deleteBranch?: string
  /** The original removal's discard-changes authorization — echoed onto the
   *  workspace-delete recovery so a force-removal replay stays byte-identical. */
  discardChanges?: boolean
  ambiguousRecovery(error: unknown): Extract<GitRecovery, { kind: 'git-remove' }> | undefined
}

export interface PreRemoveArchiveDeps {
  fetchSessions(): Promise<{
    sessions: ReadonlyArray<{ readonly sessionId: string; readonly parentSessionId?: string }>
    /** Sessions already archived; excluded from the archive pass (retry-safe). */
    archivedSessionIds?: ReadonlyArray<string>
  }>
  archiveSession(sessionId: string): Promise<void>
}

/**
 * Optional soft-archive of the whole session tree BEFORE any Git mutation.
 * Returns the archived closure (roots + transitive subsessions via
 * parentSessionId, minus already-archived ids); a failure throws with nothing
 * removed, while earlier archives in the same run are already committed.
 */
export async function runPreRemoveArchive(
  deps: PreRemoveArchiveDeps,
  roots: ReadonlyArray<string>,
): Promise<string[]> {
  const { sessions, archivedSessionIds = [] } = await deps.fetchSessions()
  const archived = new Set(archivedSessionIds)
  const closure = collectSessionClosure(sessions, roots)
  const toArchive = closure.filter(sessionId => !archived.has(sessionId))
  for (const sessionId of toArchive) {
    await deps.archiveSession(sessionId)
  }
  return toArchive
}

/**
 * NO STOP-THEN-REMOVE HERE (design 08 §5.2): a worktree removal never stops,
 * cancels or deletes a session — what blocks is the host's archived-aware running
 * fact (an archived session, or one under an archived ancestor, is inert), so the
 * git plugin needs no cancel loop. The only cancel/wait implementation belongs to
 * the archive manager (`stopSessionsForPurge`, design 24 §5).
 */

/** Git-first removal. A registry failure is retry-only; Git is never recreated. */
export async function runRemoveSaga(deps: RemoveSagaDeps): Promise<RemoveWorktreeResult> {
  let removed: RemoveWorktreeResult
  try {
    removed = await deps.hostRemove()
  } catch (removeError) {
    const recovery = deps.ambiguousRecovery(removeError)
    throw new GitSagaError(removeError, recovery, recovery !== undefined)
  }
  if (removed.next === 'none') return removed
  const deleteRecovery: Extract<GitRecovery, { kind: 'workspace-delete' }> = {
    kind: 'workspace-delete',
    operationId: removed.operationId,
    // next === 'delete-workspace' here (early-returned on 'none' above).
    workspaceId: removed.workspaceId!,
    ...(deps.deleteBranch === undefined ? {} : { deleteBranch: deps.deleteBranch }),
    ...(deps.discardChanges === true ? { discardChanges: true } : {}),
    expected: {
      repoId: removed.repoId,
      worktreeId: removed.worktreeId,
      branch: removed.branch,
      head: removed.head,
    },
    path: removed.path,
    message: '',
  }
  try {
    // The mutation receipt is not authority to delete a registry row: replay it
    // once more so the host can reject a reappeared target or drifted identity.
    await deps.verifyTerminalRemove()
  } catch (verifyError) {
    throw new GitSagaError(verifyError, {
      ...deleteRecovery,
      message: errorText(verifyError),
    }, true)
  }
  try {
    await deps.workspaceDelete(removed.workspaceId!)
  } catch (workspaceError) {
    throw new GitSagaError(workspaceError, {
      ...deleteRecovery,
      message: errorText(workspaceError),
    }, true)
  }
  return removed
}

/** Idempotent registry-delete retry: not-found proves the first delete committed. */
export async function runWorkspaceDeleteRecovery(
  verifyTerminalRemove: () => Promise<RemoveWorktreeResult>,
  removeWorkspace: () => Promise<void>,
  isAlreadyDeleted: (error: unknown) => boolean,
): Promise<'deleted' | 'already-deleted'> {
  // A prior Git receipt is not enough authority to mutate the registry: the host
  // must freshly prove the target absent and the identity/membership undrifted.
  await verifyTerminalRemove()
  try {
    await removeWorkspace()
    return 'deleted'
  } catch (error) {
    if (isAlreadyDeleted(error)) return 'already-deleted'
    throw error
  }
}
