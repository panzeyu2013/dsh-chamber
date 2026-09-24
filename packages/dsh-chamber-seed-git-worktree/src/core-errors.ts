/**
 * Typed domain error, retryable set and the domain carrier.
 */
import type { GitWorktreeDomainResult } from './core-types.ts'

export class GitWorktreeError extends Error {
  readonly code: string
  readonly retryable?: boolean
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: string,
    message: string,
    options: {
      readonly retryable?: boolean
      readonly details?: Readonly<Record<string, unknown>>
    } = {},
  ) {
    super(message)
    this.name = 'GitWorktreeError'
    this.code = code
    this.retryable = options.retryable
    this.details = options.details
  }
}

/**
 * Host error codes whose outcome the host could NOT verify: `domainResult` serializes an
 * absent `retryable` flag as `true` for them, telling the client to replay the SAME
 * operation. A code absent here with no explicit flag is a definitive refusal.
 *
 * LOCKSTEP: the client's classification (client-ui-git git-api.ts
 * `DETERMINISTIC_GIT_REJECTION_CODES` / `DETERMINISTIC_HOST_RETRYABLE_OVERRIDES`) must
 * mirror this set; codes added or renamed on either side must be mirrored on the other.
 */
export const RETRYABLE_CODES = new Set([
  'git-timeout',
  'git-output-limit',
  'git-spawn-failed',
  'git-command-failed',
  'git-protocol-error',
  'path-unavailable',
  'path-check-failed',
  'postcondition-failed',
  'operation-busy',
  'state-source-unavailable',
  'state-source-invalid',
  'state-source-capacity',
  'snapshot-deadline',
  'workspace-path-unavailable',
  'running-agent-cwd-unavailable',
])

/** Actionable message for the typed submodule refusal (pre-mutation gate and
 *  reclassification upgrade). Plain `git submodule deinit` does NOT clear git's guard -
 *  the worktree admin gitdir keeps its `modules` dir; the reliable in-UI path is the
 *  discard authorization (--force), which touches only re-cloneable checkouts. */
export const SUBMODULE_REFUSAL_MESSAGE =
  'worktrees containing submodule checkouts cannot be removed directly: '
  + 'delete the leftover submodule gitdirs under the worktree admin git dir '
  + '(<worktree .git pointer target>/modules) first — plain git submodule '
  + 'deinit does not clear them — or re-run with discardChanges to authorize '
  + 'a --force removal (the reliable path; the submodule checkouts are '
  + 're-cloneable from their committed gitlinks)'

/** Convert only known domain failures; unexpected programming failures remain internal throws. */
export async function domainResult<T>(operation: () => Promise<T>): Promise<GitWorktreeDomainResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (!(error instanceof GitWorktreeError)) throw error
    // Explicit true/false is the host's own classification and is serialized as-is. An
    // explicit false is a host-proven PRE-MUTATION refusal (nothing changed) and must
    // reach the client distinct from "not in RETRYABLE_CODES"; such codes default to true.
    const retryable = error.retryable ?? (RETRYABLE_CODES.has(error.code) ? true : undefined)
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(retryable === undefined ? {} : { retryable }),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }
  }
}
