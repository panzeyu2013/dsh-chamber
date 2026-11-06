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
  /** Sessions whose effective directory is inside the checkout. */
  readonly roots: string[]
  /** Roots plus every transitive fork descendant (parentSessionId edges). */
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
    .filter(session => isInsideCheckout(session.workingDirectory ?? session.cwd, checkoutPath))
    .map(session => session.sessionId)
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    if (session.parentSessionId === undefined) continue
    const siblings = children.get(session.parentSessionId)
    if (siblings === undefined) children.set(session.parentSessionId, [session.sessionId])
    else siblings.push(session.sessionId)
  }
  const seen = new Set(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  const closure = [...seen]
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
