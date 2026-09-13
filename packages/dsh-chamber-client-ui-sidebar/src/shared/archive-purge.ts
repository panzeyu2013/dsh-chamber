/**
 * Archive-manager purge orchestration (design 24 §5; 2026-09 protection
 * amendment).
 *
 * EXTRACTED from `ArchiveManagerDialog.tsx` so the whole flow is a PURE
 * function of authoritative facts — node-testable without a React render — and
 * so the dialog and the tests can never drift apart.
 *
 * WHAT CHANGED (2026-09 protection amendment). The previous round gated the
 * destructive surface on a client-side proof: "I must know which session is
 * being viewed, and I must be able to resolve its subagent lineage, or I
 * refuse to delete anything". That gate was wrong in two ways:
 *  - it turned an UNKNOWN (no session open, masked list gap, a source whose
 *    shell is not mounted) into a total capability loss, even though the
 *    sessions the user wants gone — archived while still running, e.g. waiting
 *    on a question or an approval — are exactly the ones that need the force
 *    path; and
 *  - it made the CLIENT responsible for a safety invariant the HOST can prove
 *    over its full corpus.
 *
 * The run is now ONE shape, in every state:
 *  1. STOP (advisory): cancel the selected trees' running turns — closure
 *     members included, minus the session being viewed (see
 *     `stopSessionsForPurge`'s CANCEL SCOPE). A failed lineage read skips the
 *     cancels only; it never refuses the run.
 *  2. PURGE (always `force: true`, always with the viewed session in
 *     `protectSessionIds`): the host deletes every selected archived tree,
 *     refuses RUNNING members unconditionally, and skips — whole — any tree
 *     whose closure contains a protected id, reporting it in
 *     `skippedProtected`.
 *
 * Protection is the LIVE current session (the dialog resolves it from the
 * bridge projection at REQUEST time — see `liveViewedSessionId`). It is
 * deliberately NOT remembered across an undefined report: the vendor's public
 * list snapshot cannot distinguish a MASKED current (the selection is
 * transiently absent from the list; the vendor keeps staging it) from a
 * CLEARED one (`sessions.clear()` — which is exactly what the vendor does the
 * moment the current session is ARCHIVED, `ui-workspace.clearArchivedCurrent`).
 * A sticky memory would therefore keep protecting the very session the user
 * just archived and could never be deleted until the app restarted — the same
 * dead end this amendment removes, only narrower. We protect the live fact and
 * register the mask window as a residual (design 24 §13) instead.
 *
 * Protection is only ever an EXTRA exclusion: when it is absent the run still
 * proceeds unprotected (and the UI says so), which is the honest degradation —
 * never a dead button.
 *
 * LOCALE-FREE (2026-09 i18n closure): this module returns dictionary KEYS +
 * params (`PurgeNoteLine`) and never renders copy — the dialog applies `t()`.
 * The only dictionary coupling is the TYPE-ONLY `SidebarKey` import (erased at
 * runtime; `client/locales.ts` has no imports, so no cycle).
 */
import type { SidebarKey } from '../client/locales.ts'
import {
  purgeArchivedSessions,
  stopSessionsForPurge,
  type ArchiveCleanupPurgeResult,
  type StopSessionsResult,
} from './instance-api.ts'

/** The instance client shape the wire calls need (kept structural so this
 *  module never re-declares the client class). */
type PurgeClient = Parameters<typeof stopSessionsForPurge>[0]

/** One user-visible line: a dictionary key plus its params. */
export interface PurgeNoteLine {
  readonly key: SidebarKey
  readonly params?: Record<string, string | number>
}

/** One run outcome: the note kind plus the lines the dialog renders. */
export interface PurgeNote {
  readonly kind: 'info' | 'error'
  readonly lines: readonly PurgeNoteLine[]
}

export interface ArchivePurgeFlowDeps {
  /** Test seam: the stop pass (defaults to the real wire implementation). */
  readonly stop?: typeof stopSessionsForPurge
  /** Test seam: the force purge (defaults to the real wire implementation). */
  readonly purge?: typeof purgeArchivedSessions
}

export interface ArchivePurgeFlowResult {
  /** The roots actually sent to the host (deduplicated selection). */
  readonly roots: readonly string[]
  /** The id this run protected (the session this client may be displaying),
   *  absent when the client could not name one. */
  readonly protectedSessionId?: string
  /** The stop pass outcome, or null when the pass itself failed to run (a
   *  programming error; the purge still ran). */
  readonly stop: StopSessionsResult | null
  /** The purge outcome. Always present: this flow has no refusal path. */
  readonly purge: ArchiveCleanupPurgeResult
}

/**
 * Stop the selected archived trees' running turns, then force-purge exactly
 * those roots with the viewed session protected host-side.
 *
 * STOP LEG (advisory, never fatal): the pass cancels every closure member
 * except the excluded viewed session, waits (bounded) for observed-running
 * members to settle, and reports what it did. An unreadable lineage skips the
 * cancels: without it the client cannot tell which selected roots contain the
 * viewed session, and cancelling a tree the host will protect would abort a
 * live turn for nothing. The purge then proceeds — the HOST's per-tree running
 * guard is the safety boundary, and a tree that is genuinely still running is
 * skipped and reported (`skippedRunning`).
 *
 * PURGE LEG: `force: true` (the force path IS the feature: archived sessions
 * may still be loaded, or waiting on a question/approval that archiving made
 * unanswerable) plus `protectSessionIds` (the viewed session, when known).
 * A protected tree is skipped whole by the host and reported in
 * `skippedProtected` — the client never refuses a root itself anymore.
 */
export async function runArchivePurge(
  client: PurgeClient,
  selection: readonly string[],
  viewedSessionId: string | undefined,
  deps: ArchivePurgeFlowDeps = {},
): Promise<ArchivePurgeFlowResult> {
  const stopPass = deps.stop ?? stopSessionsForPurge
  const purge = deps.purge ?? purgeArchivedSessions
  const roots = [...new Set(selection)]
  const protect = viewedSessionId === undefined ? [] : [viewedSessionId]

  // ADVISORY-NEVER-FATAL, in the flow too (2026-09 review): the pass documents
  // that it never throws (a failed read is its own `unavailable` outcome), so a
  // throw here is a contract violation — the ONE thing a violation must not do
  // is block the deletion the user explicitly asked for. It is logged and the
  // run proceeds: the host's per-tree running guard is the safety boundary.
  let stop: StopSessionsResult | null = null
  try {
    stop = await stopPass(client, roots, {
      ...(viewedSessionId === undefined ? {} : { exclude: [viewedSessionId] }),
      requireCompleteExcludeChain: viewedSessionId !== undefined,
    })
  } catch (error) {
    console.warn('[chamber] archive purge stop pass threw (advisory — purge continues):', error)
  }
  const result = await purge(client, roots, protect)
  return {
    roots,
    ...(viewedSessionId === undefined ? {} : { protectedSessionId: viewedSessionId }),
    stop,
    purge: result,
  }
}

/**
 * Did this run actually REMOVE anything? The dialog clears the user's selection
 * only then (2026-09 review): a run that deleted nothing — a protected tree, a
 * running tree, an unreadable-read skip — leaves every row in place, and wiping
 * the selection would force the user to re-select before the documented retry
 * ("switch away and retry"). A genuinely converged row set is dropped by the
 * passive selection prune on the next publish anyway, so nothing is lost.
 */
export function purgeRemovedContent(run: ArchivePurgeFlowResult): boolean {
  const { purge } = run
  return purge.deletedSessions > 0 || purge.deletedSubagents > 0 || (purge.clearedOrphanMembers ?? 0) > 0
}

/** One run outcome rendered as dictionary lines (keys + params). The dialog
 *  applies `t()`; this module never carries copy. */
export function archivePurgeNote(run: ArchivePurgeFlowResult): PurgeNote {
  const { stop, purge: result } = run
  const lines: PurgeNoteLine[] = []
  if (stop !== null && stop.cancelled.length > 0) {
    lines.push({ key: 'archive.purge.note.stopped', params: { count: stop.cancelled.length } })
  }
  if (result.skippedProtected > 0) {
    // The host skipped whole trees because they hold the session this client is
    // displaying (the live current) — the actionable fact for the user.
    lines.push({ key: 'archive.purge.note.protected', params: { count: result.skippedProtected } })
  }
  if (result.deletedSessions > 0 || result.deletedSubagents > 0) {
    lines.push({
      key: 'archive.purge.note.deleted',
      params: { sessions: result.deletedSessions, subagents: result.deletedSubagents },
    })
  }
  if ((result.clearedOrphanMembers ?? 0) > 0) {
    // design 24 §12 F4: the run also converged archived-set members
    // that have no session record at all (no content, invisible to this list)
    // — report it so a sweep-only run is never silent.
    lines.push({
      key: 'archive.purge.note.orphanMembers',
      params: { count: result.clearedOrphanMembers ?? 0 },
    })
  }
  if (result.forcedLoaded > 0) {
    lines.push({ key: 'archive.purge.note.forcedLoaded', params: { count: result.forcedLoaded } })
  }
  if (result.skippedRunning > 0) {
    // The host is the running authority: a member still RUNNING at deletion
    // time (the stop pass could not settle it, or a run started inside the
    // window) skips its whole tree (fail-closed). Retry after it settles.
    lines.push({ key: 'archive.purge.note.skippedRunning', params: { count: result.skippedRunning } })
  }
  if (result.skippedLoaded > 0) {
    lines.push({ key: 'archive.purge.note.skippedLoaded', params: { count: result.skippedLoaded } })
  }
  if (stop !== null && stop.stillRunning.length > 0) {
    lines.push({ key: 'archive.purge.note.stillRunning', params: { count: stop.stillRunning.length } })
  }
  if (stop !== null) {
    for (const failure of stop.failures.slice(0, 3)) {
      lines.push({
        key: 'archive.purge.note.stopFailure',
        params: { sessionId: failure.sessionId, message: failure.message },
      })
    }
  }
  // `truncated` IS the caps-reached signal (the host sets it from its own
  // MAX_PURGE_ERROR_RECORDS); the old `errors.length >= 1000` re-encoded that
  // host constant here with no lockstep gate, so a host-side change would have
  // silently dropped the note (2026-09 audit).
  if (result.truncated === true) {
    lines.push({ key: 'archive.purge.note.truncated' })
  }
  if (result.errors.length > 0) {
    lines.push({ key: 'archive.purge.note.errors', params: { count: result.errors.length } })
    for (const sample of result.errors.slice(0, 3).map(error => error.message)) {
      lines.push({ key: 'archive.purge.note.errorSample', params: { message: sample } })
    }
    return { kind: 'error', lines }
  }
  if (lines.length === 0) {
    // Another shell may have purged between the list and this run — an empty
    // outcome must never be silent (v1 E-n2 parity).
    lines.push({ key: 'archive.manager.empty' })
  }
  return { kind: 'info', lines }
}
