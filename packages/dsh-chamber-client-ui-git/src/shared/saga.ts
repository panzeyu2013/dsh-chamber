/** Pure saga policy for the checkout lifecycle. Transport adapters live in coordinator.ts. */
import { errorMessage as errorText } from '@dsh-chamber/dsh-chamber-client-core'
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
 *  exception). */
export function isProvenPreMutationRefusal(error: GitSagaError): boolean {
  return error.recovery === undefined
    && error.original instanceof GitWorktreeRpcError
    && error.original.retryable === false
}

/** The recovery to keep after a remove failure. A host-proven pre-mutation
 *  refusal resolves a pending replay as "not removed", so the entry is cleared
 *  instead of retrying the same doomed operationId; everything else preserves the
 *  previous unknown state with the new message. */
export function recoveryAfterSagaFailure(
  error: GitSagaError,
  previous?: GitRecovery,
): GitRecovery | undefined {
  if (previous?.kind === 'git-remove' && isProvenPreMutationRefusal(error)) return undefined
  return recoveryForFailure(error, previous)
}

export interface CreateSagaDeps {
  hostCreate(input: { previewToken: string; operationId: string }): Promise<CreateWorktreeResult>
  isAmbiguousHostFailure(error: unknown): boolean
}

export interface CreateSagaIds {
  operationId: string
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
    || created.operationId !== operationId
    || created.repoId !== preview.repoId
    || created.commonDir !== preview.commonDir
    || created.path !== preview.targetPath
    || created.branch !== preview.branch
    || created.head !== preview.baseHead
  ) throw new Error('gitWorktree/create result does not match the preview')
}

/**
 * Create policy boundary (PR1): the create saga is the host `create` ALONE.
 * The checkout is not a dsh workspace and no session is committed here — the
 * follow-up refresh publishes the derived checkout row, and a session is created
 * by `createSessionHere` (source-workspace session + `enter`). There is therefore
 * no workspace/session/rollback leg to compensate: an ambiguous response retains
 * exactly the preview + operation id for one same-id replay, and a correlated
 * success ends the saga.
 */
export async function runCreateSaga(
  deps: CreateSagaDeps,
  preview: PreviewCreateResult,
  ids: CreateSagaIds,
): Promise<CreateWorktreeResult> {
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
        message: errorText(createError),
      }, true)
    }
    throw new GitSagaError(createError)
  }
  return created
}

export interface RemoveSagaDeps {
  hostRemove(): Promise<RemoveWorktreeResult>
  ambiguousRecovery(error: unknown): Extract<GitRecovery, { kind: 'git-remove' }> | undefined
}

/**
 * Path-based (unregistered checkout) removal: Git-first, no registry lifecycle.
 * The host answers `next: 'none'`; a `delete-workspace` receipt would mean the
 * target is still a REGISTERED workspace, a state PR3 retired from the client —
 * the saga refuses closed instead of deleting a host registry row.
 */
export async function runRemoveSaga(deps: RemoveSagaDeps): Promise<RemoveWorktreeResult> {
  let removed: RemoveWorktreeResult
  try {
    removed = await deps.hostRemove()
  } catch (removeError) {
    const recovery = deps.ambiguousRecovery(removeError)
    throw new GitSagaError(removeError, recovery, recovery !== undefined)
  }
  if (removed.next !== 'none') {
    // The worktree WAS removed (the receipt proves it); only the retired registry
    // leg is refused, so the failure is final — never keep a replay entry alive.
    throw new GitSagaError(
      new Error('the host reported a registered workspace; the checkout removal never deletes a workspace'),
      undefined,
      true,
      false,
    )
  }
  return removed
}
