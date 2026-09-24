/**
 * Purged-session row suppression + convergence bookkeeping.
 *
 * WHY: the cleanup purge deletes content and removes the id from the
 * registry-global archived set in ONE write, and the host emits no session-row
 * event. The set reaches the mounted ctx through the workspace follow stream, but
 * the official session summaries only update on a connection generation or an
 * explicit `ctx.sessions.refresh()`. The producer therefore publishes the SHRUNK
 * archive set with rows of sessions that no longer exist — they render as ordinary
 * rows (opening one fails with session/not-found).
 *
 * The App-side convergence machine requests that refresh, but it is a ONE-SHOT
 * transition detector: after a converged view a later re-dirtied push carries ids
 * that already left the set (no new shrink ⇒ no refresh ever again), and a shrink
 * without archive-set provenance is invisible to it. The producer's signature
 * dedupe only compares against its LAST EMITTED push, so every projected change
 * re-emits the stale rows.
 *
 * OWNED BY THE PRODUCER. SUPPRESSION: an id that left the set through a shrink is
 * tombstoned and filtered until the summaries stop listing it (or it is
 * re-archived); the shrink only contains trees whose content deletion SUCCEEDED
 * plus record-less orphan members, so "left the set" ⇔ content gone. CONVERGENCE:
 * the shrink triggers `ctx.sessions.refresh()` and VERIFIES the ids are gone,
 * retrying bounded times (the refresh MUST be invoked as a method on the service
 * object — `ClientSessions.refresh` reads `this.manager`).
 *
 * RELEASE RULE: an id is released when the summaries stop listing it or it
 * re-enters the set. Deliberately NO "the refresh resolved" valve (`refreshList`
 * also resolves on a failed pull / a joined stale caller); a residual non-purge
 * shrink is released by the convergence probe's terminal state.
 */

/** Bounded convergence attempts after one purge (the official refresh is
 *  single-flight: a colliding request resolves with the STALE response and
 *  schedules no trailing run, and a hung pull would be handed on forever). */
export const PURGED_REFRESH_MAX_ATTEMPTS = 3
/** Spacing between convergence attempts (ms). */
export const PURGED_REFRESH_RETRY_MS = 1500

/**
 * One archive-set observation step. `previous` is the last AUTHORITATIVE set
 * observed by this producer (undefined = first observation — a fresh boot must
 * never arm tombstones). Returns the ids that left the set plus the set to
 * remember; `removed` = previous \ next.
 */
export function trackArchiveSetShrink(
  previous: readonly string[] | undefined,
  next: readonly string[],
): { archived: string[]; removed: string[] } {
  const archived = next.map(String)
  if (previous === undefined) return { archived, removed: [] }
  const nextSet = new Set(archived)
  return { archived, removed: previous.filter(id => !nextSet.has(id)) }
}

/**
 * Reconcile the tombstone set against the CURRENT raw projection: an id stays
 * tombstoned only while it is still listed AND still absent from the archive set.
 * A row the official refresh dropped needs no suppression, and a re-archived id
 * must never be hidden by a stale tombstone. Self-terminating.
 * @returns the next tombstone list (order preserved).
 */
export function reconcilePurgedRows(
  purged: readonly string[],
  listedIds: ReadonlySet<string>,
  archivedIds: ReadonlySet<string>,
): string[] {
  return purged.filter(id => listedIds.has(id) && !archivedIds.has(id))
}

/**
 * Filter tombstoned ids out of a projection's session rows. Returns the SAME array
 * reference when nothing is filtered, so the producer's content-signature dedupe
 * and the App's identity-preserving commits keep working.
 * @returns the filtered rows (same reference when nothing matched).
 */
export function filterPurgedRows<T extends { sessionId: string }>(
  rows: readonly T[],
  purged: ReadonlySet<string>,
): readonly T[] {
  if (purged.size === 0) return rows
  const next = rows.filter(row => !purged.has(row.sessionId))
  return next.length === rows.length ? rows : next
}

/**
 * Which tombstoned ids are STILL listed in the live official summaries — the
 * convergence check after one `ctx.sessions.refresh()`. Empty means the official
 * client is clean (or the ids are no longer rendered rows).
 * @returns the ids that must trigger another bounded retry.
 */
export function lingeringPurgedIds(
  purged: readonly string[],
  listedIds: ReadonlySet<string>,
): string[] {
  return purged.filter(id => listedIds.has(id))
}
