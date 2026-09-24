/**
 * Session creation echo — the local half of「侧栏新建的会话立刻可见」 (the
 * session-side sibling of workspace-echo.ts).
 *
 * WHY: the sidebar's "+" and the row menu's fork mint a session over the source's
 * UNARY client, not through the mounted ctx. The mounted push REPLACES that
 * source's aggregate from the official summary store, which learns of the
 * session only through the host's ASYNCHRONOUS `api-session/added` broadcast (an
 * unmounted source never hears it); the 30s unary fallback keeps a pushed
 * source's membership frozen, so the new id can only enter as an UNACCOUNTED
 * stray, hidden while it is a non-current source's provisional blank row.
 *
 * The echo closes that window with the fact the user's action produced: a
 * successful create returns the HOST session id, projected locally while the
 * authoritative view converges (the session-list refresh the App requests on the
 * fact, or the next mount). NOT a second source of truth: an authoritative row
 * that ACCOUNTS the id wins, the merge is defensive (an already-listed id
 * injects no duplicate row, an already-accounted one no membership), and entries
 * expire / retire with their source. The ledger lives in the renderer App layer.
 *
 * It also owns the LOCAL ARCHIVE tombstone ({@link PendingArchive}): the archive
 * verb runs over the unary client too, so an unmounted source's frozen view
 * would keep rendering the archived row.
 */
import type { InstanceAggregate, SessionRow, WorkspaceRow } from './instance-api.ts'
import { basenameOf } from './instance-api.ts'
import { canonicalPathKey, sessionDisplayTitle } from './derive.ts'
import { filterLedgerRows, forgetLedgerSources, mapLedgerRows, setLedgerRows, sweepLedger } from './ledger.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('session-echo')

/**
 * One echoed session creation. `workspaceId`/`path` are optional: the producer
 * knows the host workspace id but not always the path, and a fork child's
 * membership is resolved from its parent. An entry that resolves nothing still
 * renders, as an ungrouped row.
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
   * Whether the session is still the host's provisional blank row (a created
   * session is blank until its first turn; a fork carries content). The official
   * visibility rule is preserved: blank rows render only while they are the
   * source's CURRENT session — the echo makes the row reachable, it does not
   * override upstream semantics.
   */
  blank: boolean
  /** Epoch ms the echo was recorded; the TTL anchor. */
  at: number
}

/** Pending echoes keyed by source id. Absent key = nothing pending. */
export type SessionEchoLedger = Readonly<Record<string, readonly PendingSession[]>>

/**
 * How long an unconfirmed echo may stay in the projection. Convergence (the
 * official session-list refresh / a mount) is unbounded, so the TTL is a leak
 * guard: a session created elsewhere then deleted/moved would otherwise keep a
 * dead row until remount. Same magnitude as the workspace echo's 10 minutes.
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
 * authoritative snapshot would (a blank row renders the New Session copy).
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
 * Record one successful in-app session creation. Idempotent per session id — a
 * saga retry reuses its preallocated id, so an equal re-record replaces the entry
 * (refreshing its TTL anchor) instead of stacking a second row.
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
 * (`sessionIds` of any row, synthetic included): the authoritative row renders
 * it and the echo must not survive as a duplicate. Identity-preserving when
 * nothing is covered. A row merely LISTED but accounted by no workspace is NOT a
 * convergence signal — dropping the echo would re-home the row into the ungrouped
 * bucket, the very jump the echo prevents.
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
 * Retire the echo of one session the user ARCHIVED right after creating it — the
 * withdraw half (a create-only echo has no exit, so a row archived inside the
 * echo window would stay visible until the TTL or the next push).
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
 * Project one aggregate WITH its pending session echoes merged in. Pure — the
 * aggregate is never mutated, so the echo disappears the moment the ledger entry
 * does; identity-preserving when there is nothing to add.
 *
 * The merge contributes BOTH halves a session row needs: the row itself (for an
 * id the aggregate does not list yet) and its workspace MEMBERSHIP (the only
 * route into a workspace group), matched by host workspace id first and by
 * canonical path second (cwd-derived synthetic groups carry no host id). An entry
 * matching neither renders in the trailing ungrouped bucket.
 */
export function withSessionEcho(
  aggregate: InstanceAggregate,
  pending: readonly PendingSession[] | undefined,
): InstanceAggregate {
  if (pending === undefined || pending.length === 0) return aggregate
  // Only a committed ok aggregate carries real rows; error / not-connected render
  // their own state.
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
          // PREPEND, newest echo first: the host's own attachSession puts a new
          // membership at the HEAD and manual (default) order renders that array
          // order — appending would make the row jump to the head on mount.
          return { ...workspace, sessionIds: [...[...extra].reverse(), ...workspace.sessionIds] }
        }),
    sessions: additions.length === 0 ? aggregate.sessions : [...aggregate.sessions, ...additions],
  }
}

/**
 * One locally-ARCHIVED session awaiting an authoritative archive set — the local
 * half of「归档即隐藏」 for a source whose shell is not mounted (see
 * {@link recordPendingArchive}).
 */
export interface PendingArchive {
  sessionId: string
  /**
   * Epoch ms this tombstone was last OBSERVED in that source's (degraded)
   * listing — the lease anchor, refreshed by every listing that still contains
   * the id, so the tombstone lives exactly as long as the wrong view keeps
   * rendering the row; the TTL reaps only tombstones nothing lists any more.
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
 * WHY: a MOUNTED source needs no echo (the follow upsert carries the new archive
 * set and the row hides on its own). An UNMOUNTED one has NO live channel at all:
 * the mounted merge keeps the last PUSHED archive set frozen, and the unary
 * fallback has no archive wire source — so the archived row stays listed,
 * clickable, and opening it dead-ends (the official runtime clears an archived
 * current). The tombstone hides exactly the ids THIS page archived until an
 * AUTHORITATIVE set covers them; the archive manager keeps reading the
 * authoritative set (this is a navigation-visibility fact only).
 *
 * Idempotent per id; a repeat archive refreshes the lease.
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
 * listing STILL lists. Called on each unary fallback pull — the only clock an
 * unmounted source has: as long as the frozen view renders the row, the tombstone
 * must keep hiding it. Identity-preserving when nothing is listed.
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
 * mounted push is the convergence signal). Identity-preserving when nothing is
 * covered. A degraded view's set must NEVER be passed here — the unary
 * fallback's empty set would un-hide everything.
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
 * appended to `archivedSessionIds`, the single field every visibility rule reads
 * (`sessionVisible`, the workspace "+" reuse resolver). Pure and provenance-safe:
 * `archiveSetKnown` is deliberately NOT touched, so a degraded view stays
 * degraded for the manager while its navigation rows filter what this page
 * archived.
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
