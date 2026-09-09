/**
 * Pure note/count derivation for the remove-worktree dialog (design 08 §6
 * amendment, 2026-09 archived-aware running facts; 2026-12 review G1).
 *
 * The dialog's running-session notes were inline `filter`/length arithmetic in
 * the component and therefore untested. This module owns the derivation so the
 * plain-node suite pins it (test/remove-notes.test.ts) and the component only
 * maps descriptors to localized copy.
 *
 * The two host facts are DIFFERENT things and must never be conflated:
 *   - `runningSessionIds` is the display fact (every running session under the
 *     worktree, archived or not);
 *   - `blockingRunningSessionIds` is the host's archived-aware guard fact
 *     (only the running sessions that actually gate removal). It is ABSENT on
 *     an older host — and absence means "the host cannot tell us which running
 *     sessions are inert", NOT "none are archived". The dialog must therefore
 *     fall back to NEUTRAL copy in that case: claiming archivedness (or
 *     non-archivedness) there would be a fabricated fact.
 */
import type { GitSidebarKey } from '../locales.ts'

/** The running-session facts the dialog reads from one worktree row. */
export interface RemoveRunningFacts {
  readonly runningSessionIds: readonly string[]
  /** ABSENT on an older host (see the module doc). */
  readonly blockingRunningSessionIds?: readonly string[] | undefined
}

/** Which running-session note the dialog renders. */
export type RemoveRunningNoteKind =
  /** The archived-aware fact is present and N sessions block the removal. */
  | 'blocking'
  /** The archived-aware fact is ABSENT (old host): neutral copy, no
   *  archivedness claim, every running session treated as blocking. */
  | 'legacy'
  /** Nothing to say. */
  | 'none'

export interface RemoveRunningNotes {
  readonly kind: RemoveRunningNoteKind
  /** The count for the note (`{count}`). 'legacy': every running session
   *  (the conservative fallback); 'blocking': the blocking ones. */
  readonly blockingCount: number
  /** Running sessions that are INERT (archived, or under an archived
   *  ancestor), computed as a SET DIFFERENCE — never length subtraction, which
   *  would fabricate a count from a non-subset host fact. Always 0 for
   *  'legacy' (unknown, never claimed). */
  readonly inertCount: number
  /** Every running session under the worktree (display fact). */
  readonly runningCount: number
}

/** Derive the dialog's running-session notes from one row's facts. */
export function removeRunningNotes(facts: RemoveRunningFacts): RemoveRunningNotes {
  const running = facts.runningSessionIds
  const blocking = facts.blockingRunningSessionIds
  if (blocking === undefined) {
    return {
      kind: running.length > 0 ? 'legacy' : 'none',
      blockingCount: running.length,
      inertCount: 0,
      runningCount: running.length,
    }
  }
  const blockingSet = new Set(blocking)
  return {
    kind: blocking.length > 0 ? 'blocking' : 'none',
    blockingCount: blocking.length,
    // Set difference: an id the host reports as blocking but not as running
    // (a host defect the snapshot decoder already rejects) can never make this
    // negative or over-count.
    inertCount: running.filter(id => !blockingSet.has(id)).length,
    runningCount: running.length,
  }
}

/**
 * The RPC error code behind an action failure, following the saga's
 * `original` chain (GitSagaError wraps the host/transport error). Only used to
 * look up localized copy for known host refusals; an unmapped or absent code
 * stays `undefined` and the caller shows the raw message.
 */
export function removeFailureCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== 'object') return undefined
    const record = current as { code?: unknown; original?: unknown }
    if (typeof record.code === 'string' && record.code !== '') return record.code
    current = record.original
  }
  return undefined
}

/**
 * Localized copy for a host refusal code, or undefined when the code has no
 * dedicated copy (the dialog then shows the host's own message — honest, but
 * in English; only the refusals a user can actually hit from this dialog are
 * mapped).
 *
 * `running-agent` is the important one: the row deliberately leaves the delete
 * control enabled while non-archived sessions run, so the host re-checks and
 * refuses — the user must read WHY in their own language, not a raw
 * `running-agent: worktree has running associated session(s): …` string.
 */
export function removeFailureCopyKey(code: string | undefined): GitSidebarKey | undefined {
  switch (code) {
    case 'running-agent': return 'runningAgentBlocked'
    case 'main-worktree': return 'mainWorktreeBlocked'
    case 'worktree-locked': return 'lockedBlocked'
    // A fresh host re-check that found the tree dirty: the same discard
    // authorization the dialog already renders.
    case 'worktree-dirty': return 'dirtyDiscardWarning'
    case 'worktree-invalid': return 'unhealthyInvalidBlocked'
    default: return undefined
  }
}
