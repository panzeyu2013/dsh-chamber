/**
 * Optional archive-before-remove for the checkout row (design 08 §5.3-§5.4).
 *
 * The HOST removal never archives a session. This module is the client-side
 * consumer step the user authorizes with a default-OFF checkbox: it plans the
 * sessions whose EFFECTIVE directory sits inside one checkout (plus their fork
 * closure) and archives them through the OFFICIAL archive wire BEFORE the Git
 * removal. Roots deliberately do not depend on host workspace membership: that
 * membership is a polled/degradable view, while the checkout's sessions are
 * exactly the sessions whose headers live in it.
 *
 * Upstream semantics are kept for the archive itself: the first call is plain;
 * a `workspace/session-active` refusal lists the work that would stop, and only
 * the user's confirmation re-sends with `stopActivity`. Nothing here stops work
 * on its own.
 */
import { pathIsWithin } from '@dsh-chamber/dsh-chamber-client-core'

/** One session fact needed to decide whether it belongs to a checkout. */
export interface ArchiveSessionFacts {
  readonly sessionId: string
  readonly workingDirectory?: string
  readonly cwd?: string
  readonly parentSessionId?: string
  readonly title?: string
  /**
   * The host `session.list` provisional blank fact: true until the session's
   * first turn. The "new session" default placeholder has no content and no
   * durable title, so there is nothing to archive; it is never a root and never
   * archived. It still stays in the fork graph, so its content-bearing
   * descendants are reached through it.
   */
  readonly blank: boolean
}

/** One item of an archive-admission family (upstream SessionActivityItem shape). */
export interface ArchiveActivityItem {
  readonly id: string
  readonly label?: string
}

/** One family that keeps a session active (upstream SessionActivity shape). */
export interface ArchiveActivity {
  readonly kind: string
  readonly items: readonly ArchiveActivityItem[]
}

/** One session awaiting the user's stop confirmation, with its activity families. */
export interface ArchiveStopPending {
  readonly sessionId: string
  readonly activities: readonly ArchiveActivity[]
}

/** The deterministic plan for one checkout's archive step. */
export interface CheckoutArchivePlan {
  /**
   * Sessions whose effective directory is inside the checkout. Blank
   * (provisional, first-turn-pending) rows are omitted: no content to archive.
   */
  readonly roots: string[]
  /**
   * Roots plus every transitive fork descendant (parentSessionId edges). Blank
   * rows are omitted even when traversed as fork intermediates.
   */
  readonly closure: string[]
  /** Closure minus already-archived ids when the archive set is known. */
  readonly toArchive: string[]
  /** Display titles for toArchive (untitled rows omit the title). */
  readonly titles: readonly { readonly sessionId: string; readonly title?: string }[]
}

/** True when `path` is the checkout itself or one of its descendants (segment boundary). */
export function isInsideCheckout(path: string | undefined, checkoutPath: string): boolean {
  return pathIsWithin(path, checkoutPath)
}

/**
 * Plan the archive closure for one checkout.
 *
 * Blank (provisional, content-free) rows are never planned for archiving: they
 * are not roots, and they do not enter the closure. The fork graph is still
 * built from every row so a blank intermediate is traversed on the way to its
 * content-bearing descendants, which are archived normally.
 * @param sessions - every non-subagent session row (unary snapshot facts).
 * @param checkoutPath - the derived row's canonical checkout path.
 * @param archived - the authoritative archive set, or undefined when unknown.
 */
export function planCheckoutArchive(
  sessions: readonly ArchiveSessionFacts[],
  checkoutPath: string,
  archived?: ReadonlySet<string>,
): CheckoutArchivePlan {
  const byId = new Map(sessions.map(session => [session.sessionId, session]))
  const roots = sessions
    .filter(session =>
      session.blank !== true
      && isInsideCheckout(session.workingDirectory ?? session.cwd, checkoutPath))
    .map(session => session.sessionId)
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    if (session.parentSessionId === undefined) continue
    const siblings = children.get(session.parentSessionId)
    if (siblings === undefined) children.set(session.parentSessionId, [session.sessionId])
    else siblings.push(session.sessionId)
  }
  // Traversal visits every reached row, but only non-blank rows are included:
  // a blank row is enqueued so its descendants are still walked.
  const visited = new Set<string>()
  const included = new Set<string>()
  const queue: string[] = []
  for (const root of roots) {
    if (visited.has(root)) continue
    visited.add(root)
    included.add(root)
    queue.push(root)
  }
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of children.get(parent) ?? []) {
      if (visited.has(child)) continue
      visited.add(child)
      if (byId.get(child)?.blank !== true) included.add(child)
      queue.push(child)
    }
  }
  const closure = [...included]
  const toArchive = archived === undefined ? closure : closure.filter(sessionId => !archived.has(sessionId))
  const titles = toArchive.map(sessionId => {
    const session = byId.get(sessionId)
    return session === undefined
      ? { sessionId }
      : { sessionId, ...(session.title === undefined ? {} : { title: session.title }) }
  })
  return { roots, closure, toArchive, titles }
}

/** Dependency-injected archive runner (pure orchestration, testable). */
export interface ArchiveBeforeRemoveDeps {
  /** First call: official archive WITHOUT stopActivity. */
  readonly archivePlain: (sessionId: string) => Promise<void>
  /** Confirmed second call: official archive WITH stopActivity. */
  readonly archiveStop: (sessionId: string) => Promise<void>
  /** The host's `workspace/session-active` activity list, or undefined for any other failure. */
  readonly readActivityRefusal: (error: unknown) => readonly ArchiveActivity[] | undefined
  /** Ask the user to confirm stopping the listed sessions/work; false = abort. */
  readonly confirmStop: (pending: readonly ArchiveStopPending[]) => Promise<boolean>
}

/**
 * Archive every id through the upstream two-phase flow.
 * @returns false when the user cancelled the stop confirmation (nothing removed).
 * @throws any non-refusal archive failure (caller must not remove the worktree).
 */
export async function archiveBeforeRemove(
  sessionIds: readonly string[],
  deps: ArchiveBeforeRemoveDeps,
): Promise<boolean> {
  const pending: ArchiveStopPending[] = []
  for (const sessionId of sessionIds) {
    try {
      await deps.archivePlain(sessionId)
    } catch (error) {
      const activities = deps.readActivityRefusal(error)
      if (activities === undefined) throw error
      pending.push({ sessionId, activities })
    }
  }
  if (pending.length === 0) return true
  if (!(await deps.confirmStop(pending))) return false
  for (const item of pending) await deps.archiveStop(item.sessionId)
  return true
}
