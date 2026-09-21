/**
 * core-errors.ts — Typed domain error, retryable set and the domain carrier.
 *
 * Extracted verbatim from core.ts (B5 split); core.ts re-exports the public
 * names so the package/test import surface is unchanged.
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
 * Host error codes whose outcome the host could NOT verify: `domainResult`
 * serializes an absent `retryable` flag as `true` for them, which tells the
 * client that replaying the SAME operation is the safe route. A code that is
 * absent here and carries no explicit flag is a definitive refusal.
 *
 * LOCKSTEP POINT (client classification): `DETERMINISTIC_GIT_REJECTION_CODES`
 * in `packages/dsh-chamber-client-ui-git/src/shared/git-api.ts` decides which
 * codes the browser refuses to replay. The two sets may overlap ONLY where
 * that file declares a `DETERMINISTIC_HOST_RETRYABLE_OVERRIDES` entry — the
 * cross-package test `packages/dsh-chamber-client-ui-git/test/
 * host-client-lockstep.test.ts` fails when they drift any other way, so a code
 * added or renamed on either side must be mirrored on the other.
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
 *  the reclassification upgrade). NOTE (2026-09 review, empirically verified
 *  on git 2.50.1): plain `git submodule deinit` does NOT clear git's guard —
 *  git keeps the submodule gitdirs under the worktree admin git dir
 *  (`<wt gitdir>/modules`) and keeps refusing until they are gone. The
 *  reliable in-UI path is the discard authorization (--force), which
 *  discards only re-cloneable submodule checkouts; branch/commits/HEAD are
 *  never touched. */
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
    // Explicit true/false is the host's own classification and is serialized
    // as-is; an EXPLICIT false is a host-proven PRE-MUTATION refusal (nothing
    // was changed — only the commitBoundRemove gate/reclassification emit it
    // after proving the target still exists) and must reach the client
    // distinct from "not in RETRYABLE_CODES", which simply omits the flag:
    // the client clears a pending "uncertain outcome" recovery on this
    // signal. Codes in RETRYABLE_CODES without an explicit flag default to
    // true (an outcome the host could not verify).
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
