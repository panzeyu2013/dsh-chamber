/**
 * Session creation echo — the local half of「侧栏新建的会话立刻可见」
 * (design 05 §2.2 revision 2026-12; the session-side sibling of
 * shared/workspace-echo.ts).
 *
 * WHY an echo exists at all. The sidebar's "+" and the session row menu's fork
 * mint a session over the source's own UNARY client (`session/create` /
 * `session/fork`), not through the mounted ctx's official runtime. The
 * projection that renders the row has exactly two producers, and neither can
 * carry a just-created row on its own:
 *
 * - the mounted ctx's push — the official session-summary store. Its list is
 *   pulled on a connection generation and updated afterwards only by the
 *   host's ASYNCHRONOUS `api-session/added` broadcast (host-wide, one
 *   connection-generation-independent frame per created session). So the store
 *   either does not have the id yet (race: the push that follows the open
 *   request — or any store notification — REPLACES that source's aggregate
 *   from a store without it, erasing the row again) or the source's shell is
 *   not mounted at all and NOBODY ever hears the broadcast. The unmounted case
 *   is the field-report steady state: a post-harvest source keeps its REAL
 *   pushed workspace rows (with the "+" affordance enabled) while its ctx is
 *   gone;
 * - the 30s unary fallback — a fresh `session.list`, but its merge against a
 *   pushed source keeps the pushed WORKSPACE membership frozen
 *   (commitAggregatePull), so a brand-new session can only enter as an
 *   UNACCOUNTED stray — and a stray that is still the provisional blank row of
 *   a non-current source is hidden by the official visibility rule
 *   (sessionVisible).
 *
 * The immediate `requestRefresh` the sidebar fires after a successful create
 * therefore cannot surface the row for either producer: the field report is
 * 「新建的会话不出现，切到那个服务器（挂载 → follow 基线）才刷新出来」.
 *
 * The echo closes that window with a fact the user's own action already
 * produced: a successful create returns the HOST session id. The row is
 * projected locally, in its own workspace, while the authoritative view
 * converges — the official session-list refresh the App requests on the fact
 * (only a MOUNTED ctx has that seam; it forces the summaries to re-read the
 * corpus, covering both a missed broadcast and the race above), or the
 * source's next mount. It is deliberately NOT a second source of truth:
 *
 * - an authoritative row that ACCOUNTS the id (any workspace's `sessionIds`,
 *   real or cwd-derived synthetic) wins and the pending entry is retired
 *   ({@link reconcilePendingSessions});
 * - the projection merge is defensive as well ({@link withSessionEcho}): an id
 *   the aggregate already lists injects no duplicate row, and an id already
 *   accounted injects no membership — a stale ledger entry can never
 *   duplicate or re-home a row;
 * - entries expire ({@link PENDING_SESSION_TTL_MS}) and retire with their
 *   source ({@link forgetPendingSessions}), so a create whose convergence
 *   never arrives cannot pin a phantom row for the rest of the session.
 *
 * The ledger lives in the renderer App layer (never persisted, never polled):
 * renderer-local echo state, exactly like the aggregate it decorates.
 *
 * The module also owns the LOCAL ARCHIVE tombstone ({@link PendingArchive}):
 * the same class of fact in the other direction — the sidebar's archive verb
 * also runs over the unary client, so an unmounted source's frozen view keeps
 * rendering the archived row (see {@link recordPendingArchive}).
 */
import type { InstanceAggregate, SessionRow, WorkspaceRow } from './instance-api.ts'
import { basenameOf } from './instance-api.ts'
import { canonicalPathKey, sessionDisplayTitle } from './derive.ts'
import { filterLedgerRows, forgetLedgerSources, mapLedgerRows, setLedgerRows, sweepLedger } from './ledger.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('session-echo')

/**
 * One echoed session creation. `workspaceId`/`path` are optional on purpose:
 * the producer knows the host workspace id (the create wire takes it) but not
 * always the path, and a fork child's membership is resolved from its parent.
 * The App fills whatever it can resolve before recording (see App.tsx) — an
 * entry that resolves nothing still renders, as an ungrouped row.
 */
export interface PendingSession {
  sessionId: string
  /** Host workspace id the session was created under, when known. */
  workspaceId?: string
  /** Canonical path of that workspace, when known (synthetic-group matching). */
  path?: string
  /** Display-title hint (fork children); absent = the id ladder. */
  title?: string
  /**
   * Whether the session is still the host's provisional blank row. A created
   * session is blank until its first turn; a fork child carries content.
   * The official visibility rule (blank rows render only while they are the
   * source's CURRENT session) is deliberately preserved — the echo makes the
   * row reachable, it does not override upstream semantics.
   */
  blank: boolean
  /** Epoch ms the echo was recorded; the TTL anchor. */
  at: number
}

/** Pending echoes keyed by source id. Absent key = nothing pending. */
export type SessionEchoLedger = Readonly<Record<string, readonly PendingSession[]>>

/**
 * How long an unconfirmed echo may stay in the projection. The authoritative
 * convergence is the official session-list refresh / a mount (both unbounded),
 * so the TTL is a leak guard rather than a convergence budget: a session
 * created elsewhere and then deleted/moved on the host would otherwise keep a
 * dead row until that source is remounted. Same order as the workspace echo's
 * 10 minutes — far beyond any realistic "click the server and look" delay.
 */
export const PENDING_SESSION_TTL_MS = 600_000

/** The fact one successful in-app session creation publishes. */
export interface SessionCreationRecord {
  /** HOST session id — the only trustworthy "this session now exists" proof. */
  sessionId: string
  /** Host workspace id the session belongs to, when the creator knows it. */
  workspaceId?: string
  /** Canonical workspace path, when the creator knows it. */
  path?: string
  /** Display-title hint (fork intent). */
  title?: string
  /** Parent session id (fork), used by the App to resolve the child's workspace. */
  parentSessionId?: string
  /** Official provisional-row fact (see {@link PendingSession.blank}). */
  blank: boolean
}

/**
 * Project one pending echo into the wire row shape the aggregate carries.
 * `displayTitle` is pre-resolved so the row renders the same label the
 * authoritative snapshot would (a blank row renders the localized New Session
 * copy instead, see ServerSection).
 */
export function sessionEchoRow(pending: PendingSession): SessionRow {
  return {
    sessionId: pending.sessionId,
    updatedAt: pending.at,
    running: false,
    blank: pending.blank,
    displayTitle: sessionDisplayTitle({
      ...(pending.title === undefined ? {} : { title: pending.title }),
      ...(pending.path === undefined ? {} : { cwdBasename: basenameOf(pending.path) }),
      sessionId: pending.sessionId,
    }),
    ...(pending.title === undefined ? {} : { title: pending.title }),
    ...(pending.path === undefined ? {} : { cwd: pending.path }),
  }
}

/**
 * Record one successful in-app session creation. Idempotent per session id —
 * a saga retry reuses its preallocated id, so an equal re-record replaces the
 * previous entry (and refreshes its TTL anchor) instead of stacking a second
 * row. Only a create/fork reaches this entry point, never a render.
 */
export function recordPendingSession(
  ledger: SessionEchoLedger,
  sourceId: string,
  created: SessionCreationRecord,
  now: number,
): SessionEchoLedger {
  const rows = ledger[sourceId] ?? []
  const next: PendingSession = {
    sessionId: created.sessionId,
    ...(created.workspaceId === undefined ? {} : { workspaceId: created.workspaceId }),
    ...(created.path === undefined ? {} : { path: created.path }),
    ...(created.title === undefined ? {} : { title: created.title }),
    blank: created.blank === true,
    at: now,
  }
  const kept = rows.filter(row => row.sessionId !== created.sessionId)
  return setLedgerRows(ledger, sourceId, [...kept, next])
}

/** Drop echoes older than the TTL (identity-preserving when nothing expired). */
export function sweepPendingSessions(ledger: SessionEchoLedger, now: number): SessionEchoLedger {
  return sweepLedger(ledger, row => now - row.at >= PENDING_SESSION_TTL_MS)
}

/**
 * Drop every echo the given AUTHORITATIVE workspace list already ACCOUNTS
 * (`sessionIds` of any row, synthetic included): once the host's own
 * membership names the session, the authoritative row renders it and the echo
 * must not survive as a duplicate. Identity-preserving when nothing is
 * covered. A row merely LISTED in `sessions` but accounted by no workspace is
 * deliberately NOT a convergence signal — dropping the echo there would
 * re-home the row into the ungrouped bucket, the very jump the echo prevents.
 */
export function reconcilePendingSessions(
  ledger: SessionEchoLedger,
  sourceId: string,
  authoritative: readonly WorkspaceRow[],
): SessionEchoLedger {
  if (ledger[sourceId] === undefined) return ledger
  const accounted = new Set<string>()
  for (const workspace of authoritative) {
    for (const sessionId of workspace.sessionIds) accounted.add(sessionId)
  }
  return filterLedgerRows(ledger, sourceId, row => !accounted.has(row.sessionId))
}

/**
 * Retire the echo of one session the user ARCHIVED right after creating it —
 * the withdraw half (same reason as the workspace echo's removal fact: a
 * create-only echo has no exit, so a row archived inside the echo window would
 * stay visible until the TTL or the source's next authoritative push).
 * Identity-preserving when the source/id is absent.
 */
export function removePendingSession(
  ledger: SessionEchoLedger,
  sourceId: string,
  sessionId: string,
): SessionEchoLedger {
  return filterLedgerRows(ledger, sourceId, row => row.sessionId !== sessionId)
}

/** Retire the echoes of sources that left the registry (same-id re-add = new generation). */
export function forgetPendingSessions(
  ledger: SessionEchoLedger,
  retired: ReadonlySet<string>,
): SessionEchoLedger {
  return forgetLedgerSources(ledger, retired)
}

/**
 * Project one aggregate WITH its pending session echoes merged in.
 *
 * Pure projection only — the aggregate itself is never mutated, so the
 * authoritative commit paths stay untouched and the echo disappears the moment
 * the ledger entry does. Identity-preserving when there is nothing to add.
 *
 * The merge contributes BOTH halves a session row needs: the row itself (for
 * an id the aggregate does not list yet) and its workspace MEMBERSHIP (the only
 * route into a workspace group — see derive.ts deriveServerWorkspaces), matched
 * by host workspace id first and by canonical path second (the cwd-derived
 * synthetic groups of an unmounted source carry no host id). An entry that
 * matches neither still renders, in the trailing ungrouped bucket.
 */
export function withSessionEcho(
  aggregate: InstanceAggregate,
  pending: readonly PendingSession[] | undefined,
): InstanceAggregate {
  if (pending === undefined || pending.length === 0) return aggregate
  // Only a committed ok aggregate carries real rows; error / not-connected
  // aggregates render their own state and have no list to merge into.
  if (aggregate.state !== 'ok') return aggregate
  const accounted = new Set<string>()
  const byId = new Map<string, WorkspaceRow>()
  const byPath = new Map<string, WorkspaceRow>()
  for (const workspace of aggregate.workspaces) {
    for (const sessionId of workspace.sessionIds) accounted.add(sessionId)
    byId.set(workspace.workspaceId, workspace)
    const key = canonicalPathKey(workspace.path)
    if (!byPath.has(key)) byPath.set(key, workspace)
  }
  if (pending.every(entry => accounted.has(entry.sessionId))) return aggregate
  const listed = new Set(aggregate.sessions.map(session => session.sessionId))
  const membership = new Map<string, string[]>()
  const additions: SessionRow[] = []
  for (const entry of pending) {
    // Authoritative membership always wins: nothing to inject for this id.
    if (accounted.has(entry.sessionId)) continue
    if (!listed.has(entry.sessionId)) additions.push(sessionEchoRow(entry))
    const target = (entry.workspaceId === undefined ? undefined : byId.get(entry.workspaceId))
      ?? (entry.path === undefined ? undefined : byPath.get(canonicalPathKey(entry.path)))
    if (target === undefined) continue
    const extra = membership.get(target.workspaceId)
    if (extra === undefined) membership.set(target.workspaceId, [entry.sessionId])
    else extra.push(entry.sessionId)
  }
  if (additions.length === 0 && membership.size === 0) return aggregate
  return {
    ...aggregate,
    workspaces: membership.size === 0
      ? aggregate.workspaces
      : aggregate.workspaces.map((workspace) => {
          const extra = membership.get(workspace.workspaceId)
          if (extra === undefined) return workspace
          // PREPEND, newest echo first: the host's own `attachSession` puts a
          // new membership at the HEAD (`sessionIds: [sessionId, ...rest]`,
          // dsh-workspace entity), and the manual (default) render order is this
          // very array. Appending would render the row at the tail and make it
          // jump to the head the moment the authoritative baseline lands — the
          // position jump the workspace echo's placement anchor exists to
          // prevent. `extra` is in ledger (oldest-first) order, so reverse it.
          return { ...workspace, sessionIds: [...[...extra].reverse(), ...workspace.sessionIds] }
        }),
    sessions: additions.length === 0 ? aggregate.sessions : [...aggregate.sessions, ...additions],
  }
}

/**
 * One locally-ARCHIVED session awaiting an authoritative archive set — the
 * local half of「归档即隐藏」for a source whose shell is not mounted
 * (design 05 §2.2.1, 2026-12 revision). See {@link recordPendingArchive} for
 * why the archive verb needs an echo of its own.
 */
export interface PendingArchive {
  sessionId: string
  /**
   * Epoch ms this tombstone was last OBSERVED in that source's (degraded)
   * session listing — the lease anchor. Every listing that still contains the
   * id refreshes it ({@link refreshPendingArchives}), so the tombstone lives
   * exactly as long as the wrong view keeps rendering the row; the TTL only
   * reaps tombstones whose session is no longer listed at all (nothing left to
   * hide) or whose source never lists it again.
   */
  at: number
}

/** Pending archive tombstones keyed by source id. Absent key = nothing pending. */
export type SessionArchiveLedger = Readonly<Record<string, readonly PendingArchive[]>>

/** Lease window for a locally-archived id (same magnitude as the other echoes). */
export const PENDING_ARCHIVE_TTL_MS = 600_000

/**
 * Record one successful sidebar-issued `workspace.archiveSession` as a local
 * tombstone (the App applies it by extending that source's
 * `archivedSessionIds`, see {@link withPendingArchives}).
 *
 * WHY the archive verb needs its own echo. A MOUNTED source needs none: the
 * host's workspace-follow upsert carries the new archive set and the producer
 * pushes it, so the row hides on its own. An UNMOUNTED one (the post-harvest
 * steady state — its pushed workspace rows are still real, the row menu is
 * still clickable) has NO live channel at all: `commitAggregatePull`'s mounted
 * merge keeps the last PUSHED `archivedSessionIds` (frozen), and the unary
 * fallback carries no archive wire source at all (documented KNOWN
 * DEGRADATION). The archived row therefore stays in the list — clickable, and
 * opening it dead-ends because the official runtime clears an archived current
 * (the same "archived resurfacing" family the 2026-09 fixes closed for the
 * mounted path). The tombstone hides exactly the ids THIS page archived, until
 * an AUTHORITATIVE set covers them; archives made by another client still need
 * a mount (registered residue), and the archive manager surfaces keep reading
 * the authoritative set (the tombstone is a navigation-visibility fact only).
 *
 * Idempotent per id; a repeat archive refreshes the lease instead of stacking.
 */
export function recordPendingArchive(
  ledger: SessionArchiveLedger,
  sourceId: string,
  sessionId: string,
  now: number,
): SessionArchiveLedger {
  const rows = ledger[sourceId] ?? []
  const kept = rows.filter(row => row.sessionId !== sessionId)
  return setLedgerRows(ledger, sourceId, [...kept, { sessionId, at: now }])
}

/** Drop tombstones whose lease expired (identity-preserving when none did). */
export function sweepPendingArchives(ledger: SessionArchiveLedger, now: number): SessionArchiveLedger {
  return sweepLedger(ledger, row => now - row.at >= PENDING_ARCHIVE_TTL_MS)
}

/**
 * Refresh the lease of every tombstone whose session the given (degraded)
 * listing STILL lists. Called on each unary fallback pull, which is the only
 * clock an unmounted source has: as long as the frozen/stale view keeps
 * rendering the archived row, the tombstone must keep hiding it.
 * Identity-preserving when nothing is listed (or nothing pending).
 */
export function refreshPendingArchives(
  ledger: SessionArchiveLedger,
  sourceId: string,
  listed: ReadonlySet<string>,
  now: number,
): SessionArchiveLedger {
  return mapLedgerRows(ledger, sourceId, row =>
    !listed.has(row.sessionId) || row.at === now ? row : { ...row, at: now })
}

/**
 * Drop every tombstone the given AUTHORITATIVE archive set now covers (the
 * mounted push is the convergence signal: once the real set names the id, the
 * row's visibility is the host's fact and the local tombstone has no job
 * left). Identity-preserving when nothing is covered. A degraded view's set
 * must NEVER be passed here — the unary fallback's empty set would un-hide
 * everything.
 */
export function reconcilePendingArchives(
  ledger: SessionArchiveLedger,
  sourceId: string,
  authoritative: readonly string[],
): SessionArchiveLedger {
  if (ledger[sourceId] === undefined) return ledger
  const covered = new Set(authoritative)
  return filterLedgerRows(ledger, sourceId, row => !covered.has(row.sessionId))
}

/** Retire the tombstones of sources that left the registry (same-id re-add = new generation). */
export function forgetPendingArchives(
  ledger: SessionArchiveLedger,
  retired: ReadonlySet<string>,
): SessionArchiveLedger {
  return forgetLedgerSources(ledger, retired)
}

/**
 * Project one aggregate with the local archive tombstones applied: the ids are
 * appended to `archivedSessionIds`, which is the single field every
 * visibility rule already reads (`sessionVisible` in derive.ts, the workspace
 * "+" reuse resolver). Pure, identity-preserving and provenance-safe: the
 * `archiveSetKnown` flag is deliberately NOT touched, so a degraded view
 * stays degraded for the archive manager while its navigation rows filter
 * what this page itself archived.
 */
export function withPendingArchives(
  aggregate: InstanceAggregate,
  pending: readonly PendingArchive[] | undefined,
): InstanceAggregate {
  if (pending === undefined || pending.length === 0) return aggregate
  if (aggregate.state !== 'ok') return aggregate
  const archived = new Set(aggregate.archivedSessionIds)
  const extra: string[] = []
  for (const entry of pending) {
    if (archived.has(entry.sessionId)) continue
    archived.add(entry.sessionId)
    extra.push(entry.sessionId)
  }
  if (extra.length === 0) return aggregate
  return { ...aggregate, archivedSessionIds: [...aggregate.archivedSessionIds, ...extra] }
}

