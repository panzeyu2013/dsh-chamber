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
import { describeThrown } from '@dsh-chamber/dsh-chamber-client-core'
import { removeFailureCode, removeFailureCopyKey } from './remove-notes.ts'

/**
 * User-reachable Git action failures with dedicated localized copy. The union is
 * EXACTLY the code set removeFailureCopyKey answers for, so a new member without
 * copy fails the action-error test instead of rendering a raw message.
 */
export type GitActionErrorCode =
  | 'action-in-progress'
  | 'recovery-pending'
  | 'fresh-facts-unavailable'
  | 'worktree-not-found'
  | 'main-worktree'
  /** The row carries no dsh workspace (the unregistered path is required). */
  | 'worktree-unregistered'
  /** The worktree holds the session currently on screen (blank exception aside). */
  | 'worktree-current'
  /** The per-source runtime channel is absent, so the current session is unknown. */
  | 'worktree-runtime-unknown'
  | 'worktree-locked'
  | 'worktree-unhealthy'
  | 'worktree-dirty'
  /** Cleanliness could not be determined (dirty === null). */
  | 'worktree-status-unknown'
  /** A session cannot target an unhealthy worktree (adopt preflight). */
  | 'unhealthy-target'
  | 'archive-failed'
  | 'refresh-failed'
  /** The instance does not serve the gitWorktree Remote (404). */
  | 'git-host-not-loaded'
  /** The shared carrier answered a business-level refusal (`rpc-failed`); its
   *  message can come from the carrier's own fallback, so the code needs copy. */
  | 'rpc-failed'
  /** Host refusals with dedicated copy (they arrive as GitWorktreeRpcError). */
  | 'running-agent'
  | 'worktree-invalid'

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
