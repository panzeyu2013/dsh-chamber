/**
 * Structured Git action failures + the code→copy resolver (the i18n boundary).
 * Every user-reachable refusal — coordinator preflight guards and host-domain refusals —
 * reaches the presentation layer (dialogs, alert strip) as an error, and that layer owns no
 * prose: copy lives in locales.ts keyed by GitSidebarKey (design 08 §5.4, design 16 §7.2). The
 * logic layer mints GitActionError with a CODE from the closed union below and
 * gitActionErrorText resolves it through the single code→key table; only an unmapped failure
 * keeps its raw message, and every message this package mints is English by construction.
 * HOST CODES ride the same resolver (gitActionErrorCode walks the saga 'original' chain), so a
 * wrapped GitWorktreeRpcError still resolves. VOCABULARY: a client guard with the same condition
 * as a host refusal REUSES the host spelling (worktree-locked, worktree-dirty, main-worktree).
 */
import type { GitSidebarKey } from '../locales.ts'
import { NOT_DISPATCHED_CODE } from './not-dispatched.ts'
import { describeThrown } from '@dsh-chamber/dsh-chamber-client-core'
import { removeFailureCode, removeFailureCopyKey } from './remove-notes.ts'

/**
 * User-reachable Git action failures with dedicated localized copy. Every member
 * must answer through removeFailureCopyKey (the action-error test rejects a code
 * without copy instead of rendering a raw message); the table additionally
 * localizes host-only refusals that never become a GitActionError.
 */
export type GitActionErrorCode =
  | 'action-in-progress'
  | 'recovery-pending'
  | 'fresh-facts-unavailable'
  | 'worktree-not-found'
  /** A session cannot target an unhealthy worktree. */
  | 'unhealthy-target'
  /** The repository's main checkout is not a registered workspace, so a
   *  source-rooted session cannot be created for this checkout (design 08 I9). */
  | 'source-workspace-missing'
  /** The optional archive-before-remove step failed; no worktree was removed. */
  | 'archive-failed'
  /** Host refusals with dedicated copy (they arrive as GitWorktreeRpcError). */
  | 'main-worktree'
  | 'worktree-locked'
  | 'worktree-dirty'
  | 'running-agent'
  | 'worktree-invalid'
  /** The instance does not serve the gitWorktree Remote (404). */
  | 'git-host-not-loaded'
  /** The shared carrier answered a business-level refusal (`rpc-failed`); its
   *  message can come from the carrier's own fallback, so the code needs copy. */
  | 'rpc-failed'
  /** The page dispatch queue refused the request before it left the page. */
  | typeof NOT_DISPATCHED_CODE

/** A user-facing Git action failure carrying its localizable code. */
export class GitActionError extends Error {
  readonly code: GitActionErrorCode
  /** The underlying failure, kept for diagnostics (never rendered). */
  readonly original: unknown

  constructor(code: GitActionErrorCode, message: string, original?: unknown) {
    super(message)
    this.name = 'GitActionError'
    this.code = code
    this.original = original
  }
}

/**
 * The code behind an action failure: the error's own code, or the first one found
 * along the saga 'original' chain (host refusals). Unmapped/plain failures answer
 * undefined and the caller keeps the raw message.
 */
export function gitActionErrorCode(error: unknown): string | undefined {
  return removeFailureCode(error)
}

/** Stable text for a failure with no localized copy (hostile values safe). */
function rawMessage(error: unknown): string {
  return describeThrown(error, 'unknown Git error')
}

/**
 * Resolve a failure code + raw message to user-facing copy: a mapped code uses the
 * localized string, anything else keeps the message (honest, and English for every
 * message this package mints).
 */
export function gitActionErrorTextFor(
  code: string | undefined,
  message: string,
  t: (key: GitSidebarKey) => string,
): string {
  if (code === undefined) return message
  const key = removeFailureCopyKey(code)
  return key === undefined ? message : t(key)
}

/**
 * Resolve an arbitrary thrown value to user-facing copy (the presentation layer's
 * single entry point).
 */
export function gitActionErrorText(error: unknown, t: (key: GitSidebarKey) => string): string {
  return gitActionErrorTextFor(gitActionErrorCode(error), rawMessage(error), t)
}
