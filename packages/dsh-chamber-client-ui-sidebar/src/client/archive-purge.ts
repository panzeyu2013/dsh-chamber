/**
 * Archive-manager purge orchestration: pure over authoritative facts, locale-free
 * (dictionary KEYS + params, never copy; `SidebarKey` stays a type-only import).
 * Every run is ONE shape: STOP (advisory — cancel the selected trees' running
 * turns, closure members included, minus the viewed session; an unreadable
 * lineage skips only the cancels), then PURGE (`force: true` WITH the viewed
 * session in `protectSessionIds`). The host refuses RUNNING members and skips
 * any tree whose closure holds a protected id; the client never refuses a
 * root, and an UNKNOWN viewed session degrades to an unprotected run, never a
 * dead button. Protection is the LIVE current session at request time — a
 * sticky remembered id would shield the session the user just archived.
 */
import type { SidebarKey } from './locales.ts'
import {
  purgeArchivedSessions,
  stopSessionsForPurge,
  type ArchiveCleanupPurgeResult,
  type StopSessionsResult,
} from '@dsh-chamber/dsh-chamber-client-core/instance-api'

/** Instance client shape the wire calls need (structural — never re-declares the client class). */
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
  /** Override seam; defaults to the real wire implementation. */
  readonly stop?: typeof stopSessionsForPurge
  /** Override seam; defaults to the real wire implementation. */
  readonly purge?: typeof purgeArchivedSessions
}

export interface ArchivePurgeFlowResult {
  /** The roots actually sent to the host (deduplicated selection). */
  readonly roots: readonly string[]
  /** The id this run protected, absent when the client could not name one. */
  readonly protectedSessionId?: string
  /** The stop pass outcome, or null when the pass threw (the purge still ran). */
  readonly stop: StopSessionsResult | null
  /** The purge outcome; always present — this flow has no refusal path. */
  readonly purge: ArchiveCleanupPurgeResult
}

/**
 * Stop the selected trees' running turns, then force-purge exactly those roots
 * with the viewed session protected host-side.
 *
 * STOP is advisory, never fatal: an unreadable lineage skips the cancels —
 * cancelling a tree the host will protect would abort a live turn for nothing —
 * and the host's per-tree running guard remains the boundary (`skippedRunning`).
 * PURGE's `force: true` IS the feature: archived sessions may still be loaded,
 * or waiting on a question/approval that archiving made unanswerable.
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

  // The pass never throws (a failed read is its own `unavailable` outcome), so a
  // throw is a contract violation — and a violation must not block the deletion
  // the user asked for: log it and proceed (the host's running guard binds).
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
 * Did this run actually REMOVE anything? The dialog clears the selection only
 * then: a run that deleted nothing (protected/running/unreadable-skip) leaves
 * every row in place and wiping it would break the documented retry; converged
 * rows are dropped by the passive selection prune on the next publish anyway.
 */
export function purgeRemovedContent(run: ArchivePurgeFlowResult): boolean {
  const { purge } = run
  return purge.deletedSessions > 0 || purge.deletedSubagents > 0 || (purge.clearedOrphanMembers ?? 0) > 0
}

/** One run outcome rendered as dictionary lines; the dialog applies `t()`. */
export function archivePurgeNote(run: ArchivePurgeFlowResult): PurgeNote {
  const { stop, purge: result } = run
  const lines: PurgeNoteLine[] = []
  if (stop !== null && stop.cancelled.length > 0) {
    lines.push({ key: 'archive.purge.note.stopped', params: { count: stop.cancelled.length } })
  }
  if (result.skippedProtected > 0) {
    // Whole trees the host skipped because they hold the live current session.
    lines.push({ key: 'archive.purge.note.protected', params: { count: result.skippedProtected } })
  }
  if (result.deletedSessions > 0 || result.deletedSubagents > 0) {
    lines.push({
      key: 'archive.purge.note.deleted',
      params: { sessions: result.deletedSessions, subagents: result.deletedSubagents },
    })
  }
  if ((result.clearedOrphanMembers ?? 0) > 0) {
    // The run also converged archived-set members with no session record at all
    // (invisible to this list) — report it so a sweep-only run is never silent.
    lines.push({
      key: 'archive.purge.note.orphanMembers',
      params: { count: result.clearedOrphanMembers ?? 0 },
    })
  }
  if (result.residentRetainedRoots !== undefined && result.residentRetainedRoots.length > 0) {
    // RESIDENT RETENTION: content deleted, archived membership KEPT — the session
    // still lives in the instance process and its row would otherwise come back
    // through the live-preferred list. Say exactly that distinction.
    lines.push({
      key: 'archive.purge.note.residentRetained',
      params: { count: result.residentRetainedRoots.length },
    })
  } else if (result.forcedLoaded > 0) {
    // Version skew (host without the resident-retention report): the content WAS
    // force-deleted; that host just cannot say which roots stayed archived.
    lines.push({ key: 'archive.purge.note.forcedLoaded', params: { count: result.forcedLoaded } })
  }
  if (result.skippedRunning > 0) {
    // The host is the running authority: a member still RUNNING skips its whole
    // tree (fail-closed — the stop pass may not have settled it). Retry later.
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
  // `truncated` IS the caps-reached signal (host-side MAX_PURGE_ERROR_RECORDS):
  // re-encoding that constant here would break lockstep and drop the note.
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
    // Another shell may have purged meanwhile — an empty outcome must never be silent.
    lines.push({ key: 'archive.manager.empty' })
  }
  return { kind: 'info', lines }
}
