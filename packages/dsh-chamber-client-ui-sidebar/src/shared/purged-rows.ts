/**
 * Purged-session row suppression + convergence bookkeeping (design 24 §12
 * 修正轮, 2026-09 实机复核).
 *
 * WHY THIS EXISTS (实机根因，2026-09 复核): the cleanup purge deletes a
 * session's content and then removes its id from the registry-global archived
 * set in ONE write (host-archive-cleanup core.ts `clearIds`), and the host
 * emits no session-row event for either step (documented no-op). The archived
 * set DOES reach the mounted ctx promptly through the official workspace
 * follow stream (`{type:'archived'}`), but the official client's session
 * summaries (`SessionManager.summaries`) only update on a connection
 * generation or an explicit `ctx.sessions.refresh()`. The sidebar producer
 * therefore publishes a snapshot that pairs the SHRUNK archive set with rows
 * of sessions that no longer exist; the archived-set visibility gate stops
 * covering them and they render as ordinary rows (opening one fails with
 * session/not-found).
 *
 * The App-side convergence machine (renderer aggregate-refresh
 * `planSessionListRefresh`) requests that official refresh, but it is a
 * ONE-SHOT transition detector: it only fires while a shrink is newly
 * observed against an archive-set-authoritative previous aggregate, and its
 * request is a fire-and-forget page-wide broadcast. Two proven gaps make the
 * ghosts return indefinitely:
 *   1. after a converged (or pull-cleaned) view, any later re-dirtied push
 *      carries rows whose ids already left the set — `archiveSetShrink`
 *      returns [] (both sides equal) so no refresh is ever requested again;
 *   2. a shrink observed while the committed aggregate lacks archive-set
 *      provenance (`archiveSetKnown !== true`, e.g. the unary fallback view)
 *      is invisible to the machine forever.
 * Meanwhile the producer's own signature dedupe only compares against its
 * LAST EMITTED push, so every projected change (running bit on task
 * completion, activity, title, blank, membership) re-emits the stale rows
 * over the App's clean unary pull — the reported appear/disappear flicker.
 *
 * The fix has two halves, both owned by the source's own producer (this
 * module is the pure, node-testable core):
 *   - SUPPRESSION (F1): an id that left the archive set through a shrink is
 *     tombstoned and filtered out of the emitted snapshot until the raw
 *     summaries stop listing it (or it is re-archived). This is honest:
 *     `clearIds` only ever contains trees whose content deletion SUCCEEDED
 *     plus orphan members with no session record, so "left the archive set"
 *     ⇔ "the content is gone"; a failed archive-set write leaves the ids in
 *     the set and therefore never arms a tombstone.
 *   - CONVERGENCE (F2): the same shrink triggers the official
 *     `ctx.sessions.refresh()` in place and then VERIFIES the ids are gone
 *     from the summaries, retrying a bounded number of times
 *     (`purged-convergence.ts` owns the chain: retry on resolve-with-lingering,
 *     on rejection AND on a hung attempt; the terminal step KEEPS the
 *     suppression). That repairs the official client itself (no dead-end
 *     opens) and covers the single-flight/stale-response and
 *     transient-RPC-error holes of `refreshList()`. NOTE (2026-09 review
 *     BLOCKER): the refresh MUST be invoked as a method on the service object
 *     — `ClientSessions.refresh` is a prototype method reading `this.manager`,
 *     so the detached call the §12 seam used threw TypeError and never issued
 *     an RPC at all.
 *
 * TOMBSTONE RELEASE RULE: an id is released when the raw summaries stop
 * listing it (the official refresh converged) or when it re-enters the archive
 * set. There is deliberately NO "release because the refresh resolved" valve:
 * `refreshList` also resolves on a failed pull (summaries untouched) and for a
 * joined stale single-flight caller, so a resolve proves nothing — releasing
 * on it re-opened the very ghost-row bug this module exists to close (2026-09
 * closure review). The residual — a shrink that was NOT a content purge
 * leaving a row suppressed — is released by the F2 convergence probe's terminal
 * state, which drops every tombstoned id the authoritative list still enumerates
 * (see purged-convergence.ts). Do NOT delete that probe believing the residual
 * is unreachable: without it a non-purge shrink keeps a LIVE row hidden, which
 * is the 2026-09 ghost-row regression this family exists to close.
 */

/** Bounded convergence attempts after one purge (the official refresh is
 *  single-flight: a request that collides with an in-flight pre-purge list
 *  resolves with the STALE response and schedules no trailing run, and a hung
 *  pull would otherwise be handed to every later caller forever). */
export const PURGED_REFRESH_MAX_ATTEMPTS = 3
/** Spacing between convergence attempts (ms). */
export const PURGED_REFRESH_RETRY_MS = 1500

/**
 * One archive-set observation step. `previous` is the last AUTHORITATIVE set
 * observed by this producer (undefined = first observation — a fresh boot
 * must never arm tombstones, and its summaries are clean anyway). Returns the
 * ids that left the set (the purge signal) plus the set to remember.
 * @param previous - last observed authoritative archived ids, if any.
 * @param next - current authoritative archived ids (caller must have already
 *   established authority: ready projection + an array-shaped field).
 * @returns `removed` = previous \ next (empty on first observation);
 *   `archived` = the next set to remember.
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
 * tombstoned only while it is still listed AND still absent from the archive
 * set. A row the official refresh finally dropped (no longer listed) needs no
 * suppression, and a re-archived id must never be hidden by a stale
 * tombstone. Self-terminating: once the summaries converge the set drains.
 * @param purged - currently tombstoned ids.
 * @param listedIds - session ids of the raw (unfiltered) projection.
 * @param archivedIds - the current authoritative archive set.
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
 * Filter tombstoned ids out of a projection's session rows. Returns the SAME
 * array reference when nothing is filtered, so the producer's
 * content-signature dedupe and the App's identity-preserving commits keep
 * working unchanged.
 * @param rows - projected session rows.
 * @param purged - tombstoned ids (empty = no-op).
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
 * convergence check after one `ctx.sessions.refresh()`. Empty means the
 * official client is clean (or the ids are no longer rendered rows).
 * @param purged - tombstoned ids.
 * @param listedIds - current raw summary ids (`ctx.sessions.list.byId` keys).
 * @returns the ids that must trigger another bounded retry.
 */
export function lingeringPurgedIds(
  purged: readonly string[],
  listedIds: ReadonlySet<string>,
): string[] {
  return purged.filter(id => listedIds.has(id))
}
