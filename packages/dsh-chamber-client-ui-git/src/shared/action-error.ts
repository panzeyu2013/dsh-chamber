/**
 * Structured Git action failures + the code→copy resolver (the i18n boundary).
 *
 * WHY THIS MODULE. Every user-reachable refusal of the Git client — the
 * coordinator's preflight guards and the host-domain refusals — crosses the
 * presentation layer (the two dialogs and the source-level alert strip) as an
 * error, and that layer owns no prose: copy lives in locales.ts keyed by a
 * GitSidebarKey (design 08 §5.4, design 16 §7.2). The logic layer therefore
 * mints GitActionError with a CODE from the closed union below, and
 * gitActionErrorText resolves it through the single code→key table
 * (removeFailureCopyKey). Only a genuinely unmapped failure keeps its raw
 * message — and every message this package mints is English by construction,
 * so the en dictionary can never fall back to Chinese
 * (test/shared/action-error.test.ts locks both halves).
 *
 * HOST CODES ride the same resolver: gitActionErrorCode walks the saga
 * 'original' chain (removeFailureCode), so a GitWorktreeRpcError wrapped by
 * GitSagaError still resolves to its localized copy.
 *
 * VOCABULARY. Where a client guard is the same condition as a host refusal the
 * code REUSES the host spelling (worktree-locked, worktree-dirty,
 * main-worktree), so the two halves share one code→copy entry instead of
 * growing parallel names for one user-facing situation.
 */
import type { GitSidebarKey } from '../locales.ts'
import { removeFailureCode, removeFailureCopyKey } from './remove-notes.ts'

/**
 * User-reachable Git action failures with dedicated localized copy. The union
 * is EXACTLY the code set removeFailureCopyKey answers for, so a new member
 * without copy fails test/shared/action-error.test.ts instead of rendering a
 * raw message.
 */
export type GitActionErrorCode =
  /** Another Git mutation already holds this source's lease. */
  | 'action-in-progress'
  /** A durable recovery item must be retried/completed before new actions. */
  | 'recovery-pending'
  /** The fresh snapshot needed by the preflight could not be read. */
  | 'fresh-facts-unavailable'
  /** The target worktree is no longer in the source's topology. */
  | 'worktree-not-found'
  /** The main checkout can never be removed as a linked worktree. */
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
  /** The optional pre-remove archive pass failed; no Git mutation was made. */
  | 'archive-failed'
  /** The unregistered-removal fresh refresh failed. */
  | 'refresh-failed'
  /** The instance does not serve the gitWorktree Remote (404). */
  | 'git-host-not-loaded'
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
 * The code behind an action failure: the error's own code, or the first one
 * found along the saga 'original' chain (host refusals). Unmapped/plain
 * failures answer undefined and the caller keeps the raw message.
 * @param error - any thrown value.
 * @returns the failure code, when one is present.
 */
export function gitActionErrorCode(error: unknown): string | undefined {
  return removeFailureCode(error)
}

/** Stable text for a failure with no localized copy (hostile values safe). */
function rawMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = typeof error.message === 'string' ? error.message : ''
      if (message !== '') return message
      const name = typeof error.name === 'string' ? error.name : ''
      if (name !== '') return name
    }
  } catch {
    // Fall through to the guarded primitive conversion.
  }
  try {
    const text = String(error)
    return text === '' ? 'unknown Git error' : text
  } catch {
    return 'unknown Git error'
  }
}

/**
 * Resolve a failure code + raw message to user-facing copy: a mapped code uses
 * the localized string, anything else keeps the message (honest, and English
 * for every message this package mints).
 * @param code - the failure code, when known (GitActionError/GitWorktreeRpcError).
 * @param message - the raw failure message.
 * @param t - the bound translator for the git namespace.
 * @returns the text the presentation layer renders.
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
 * Resolve an arbitrary thrown value to user-facing copy (the presentation
 * layer's single entry point).
 * @param error - the thrown value.
 * @param t - the bound translator for the git namespace.
 * @returns the localized copy for a mapped code, else the raw message.
 */
export function gitActionErrorText(error: unknown, t: (key: GitSidebarKey) => string): string {
  return gitActionErrorTextFor(gitActionErrorCode(error), rawMessage(error), t)
}
