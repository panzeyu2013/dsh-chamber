/**
 * Archive-manager purge decisions (design 24 §21).
 *
 * Extracted from `ArchiveManagerDialog.tsx` (2026-09 fix round) so every
 * fail-closed rule is a PURE function of authoritative facts — node-testable
 * without a React render — and so the dialog and the tests can never drift
 * apart:
 *
 *  - `purgeRefusalReason` is the pre-flight gate (used BOTH at render time to
 *    disable the delete controls and inside the run as belt-and-braces): the
 *    force path requires a KNOWN current session, because that exclusion is
 *    the only protection against a deleted writer recreating a header-less
 *    artifact.
 *  - `runArchivePurge` is the stop-then-purge flow: every way it can decline
 *    to purge is a NAMED refusal (`PurgeRefusalReason`), never an inferred
 *    cause; the stop pass's read failure is caught (never thrown) but an
 *    unknown closure, an unknown current session, or an unresolvable upward
 *    lineage REFUSES the run.
 *
 * LOCALE-FREE (2026-09 i18n closure): this module returns dictionary KEYS +
 * params (`PurgeNoteLine`) and never renders copy — the dialog applies `t()`.
 * The only dictionary coupling is the TYPE-ONLY `SidebarKey` import (erased at
 * runtime; `client/locales.ts` has no imports, so no cycle), which keeps the
 * returned keys compile-time checked against the zh key-set source of truth
 * while `shared/` stays free of dictionary values.
 */
import type { SidebarKey } from '../client/locales.ts'
import {
  purgeArchivedSessions,
  stopSessionsForPurge,
  upwardChainComplete,
  type ArchiveCleanupPurgeResult,
  type StopSessionsResult,
} from './instance-api.ts'

/** The instance client shape both wire calls need (kept structural so this
 *  module never re-declares the client class). */
type PurgeClient = Parameters<typeof stopSessionsForPurge>[0]

/** The runtime view the gate needs from a source aggregate. */
export interface PurgeRuntimeSource {
  /** The per-source runtime report; absent/`undefined` = producer not
   *  registered yet or source reconnecting — the current session is then
   *  UNKNOWN (optional so an aggregate type with `runtime?:` satisfies it). */
  readonly runtime?: { readonly current?: string } | undefined
}

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

/**
 * The pre-flight runtime gate (design 24 §21 residual risk): the force purge
 * may delete a merely LOADED session, and the only protection against the
 * deleted writer recreating a header-less artifact is excluding the session
 * this client is currently viewing. The gate therefore requires the runtime
 * report AND a known current id:
 *  - absent report / absent source → refuse (fail-closed, never permissive);
 *  - present report with `current === undefined` → refuse: the vendor masks
 *    `current` during a transient list gap (`SessionListSnapshot.current` doc,
 *    api-session-controller `client/sessions/manager.ts`; `followCurrent` in
 *    `client/sessions/service.ts` treats that gap as "the stage holds"), so an
 *    absent id is UNKNOWN — never "nothing is being viewed".
 * @returns the refusal KEY, or null only when a known current session exists.
 */
export function purgeRefusalReason(server: PurgeRuntimeSource | null | undefined): SidebarKey | null {
  if (server === null || server === undefined) return 'archive.purge.refusal.runtimeUnknown'
  if (server.runtime === undefined) return 'archive.purge.refusal.runtimeUnknown'
  const current = server.runtime.current
  if (typeof current !== 'string' || current === '') return 'archive.purge.refusal.currentUnknown'
  return null
}

/** Why a purge run declined to delete anything. `null` (on the result) means
 *  the purge actually ran; the type makes "refused without a reason"
 *  unrepresentable. */
export type PurgeRefusalReason =
  /** The current session id is unknown (no runtime report, or a masked gap). */
  | 'current-unknown'
  /** The lineage read failed with a known current: the closure is unknown. */
  | 'closure-unknown'
  /** The viewed session's upward subagent chain is not fully resolvable. */
  | 'lineage-incomplete'
  /** Every selected root's closure contains the currently viewed session. */
  | 'current-in-closure'
  /** The whole selection WAS the currently viewed session. */
  | 'current-only'

/** The honest per-reason line for roots refused by the current-session rule. */
export function currentInClosureLine(refusedCount: number): PurgeNoteLine {
  return { key: 'archive.purge.refusal.currentInClosure', params: { count: refusedCount } }
}

/** Neutral line for the unrepresentable "purge ran but its facts are missing"
 *  state. It asserts NO cause (N5): an outcome without a named refusal must
 *  never borrow the wording of a refusal it cannot prove. */
export const PURGE_INDETERMINATE_LINE: PurgeNoteLine = { key: 'archive.purge.note.indeterminate' }

/** The refusal's honest lines, driven ONLY by the named refusal. */
function refusalLines(run: ArchivePurgeFlowResult): readonly PurgeNoteLine[] {
  switch (run.refusal) {
    case 'current-unknown':
      return [{ key: 'archive.purge.refusal.currentUnknown' }]
    case 'closure-unknown':
      return [{ key: 'archive.purge.refusal.closureUnknown' }]
    case 'lineage-incomplete':
      return [{ key: 'archive.purge.refusal.lineageIncomplete' }]
    case 'current-only':
      return [{ key: 'archive.purge.refusal.currentOnly' }]
    case 'current-in-closure': {
      const lines: PurgeNoteLine[] = [currentInClosureLine(run.refusedRoots.length)]
      if (run.skippedCurrent) lines.push({ key: 'archive.purge.refusal.currentOnly' })
      return lines
    }
    default:
      // Unreachable (`refusal !== null` narrows to the four literals): the
      // neutral line never claims a cause it cannot know.
      return [PURGE_INDETERMINATE_LINE]
  }
}

/** One run outcome rendered as dictionary lines (keys + params). The dialog
 *  applies `t()`; this module never carries copy. */
export function archivePurgeNote(run: ArchivePurgeFlowResult): PurgeNote {
  if (run.refusal !== null) {
    // Fail-closed: nothing was cancelled and nothing was purged. The lines are
    // the refusal's own, never an inferred one.
    return { kind: 'error', lines: refusalLines(run) }
  }
  const { stop, purge: result } = run
  if (stop === null || result === null) {
    // Unrepresentable for a real run (`refusal === null` ⇒ the purge ran).
    return { kind: 'error', lines: [PURGE_INDETERMINATE_LINE] }
  }
  const lines: PurgeNoteLine[] = []
  if (stop.cancelled.length > 0) {
    lines.push({ key: 'archive.purge.note.stopped', params: { count: stop.cancelled.length } })
  }
  if (run.refusedRoots.length > 0) {
    lines.push(currentInClosureLine(run.refusedRoots.length))
  }
  if (result.deletedSessions > 0 || result.deletedSubagents > 0) {
    lines.push({
      key: 'archive.purge.note.deleted',
      params: { sessions: result.deletedSessions, subagents: result.deletedSubagents },
    })
  }
  if (result.forcedLoaded > 0) {
    lines.push({ key: 'archive.purge.note.forcedLoaded', params: { count: result.forcedLoaded } })
  }
  if (result.forceUnsupported && result.skippedLoaded > 0) {
    // HONEST LEGACY-HOST LINE (design 24 §21 compatibility leg): the host
    // refused the force flag, so this run repeated with the legacy shape. The
    // clause is GATED on an actual skip — without it the note would claim a
    // loss that did not happen.
    lines.push({ key: 'archive.purge.note.legacyHost' })
  }
  if (result.skippedRunning > 0) {
    // The host is the running authority: a member that is STILL running
    // (stop not yet effective, or a running subagent descendant) skips its
    // whole tree (fail-closed). Retry after it settles.
    lines.push({ key: 'archive.purge.note.skippedRunning', params: { count: result.skippedRunning } })
  }
  if (result.skippedLoaded > 0) {
    lines.push({ key: 'archive.purge.note.skippedLoaded', params: { count: result.skippedLoaded } })
  }
  if (run.skippedCurrent) {
    lines.push({ key: 'archive.purge.note.skippedCurrent' })
  }
  if (stop.stillRunning.length > 0) {
    lines.push({ key: 'archive.purge.note.stillRunning', params: { count: stop.stillRunning.length } })
  }
  for (const failure of stop.failures.slice(0, 3)) {
    lines.push({
      key: 'archive.purge.note.stopFailure',
      params: { sessionId: failure.sessionId, message: failure.message },
    })
  }
  if (result.truncated === true && result.errors.length >= 1000) {
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

export interface ArchivePurgeFlowDeps {
  /** Test seam: the stop pass (defaults to the real wire implementation). */
  readonly stop?: typeof stopSessionsForPurge
  /** Test seam: the force purge (defaults to the real wire implementation). */
  readonly purge?: typeof purgeArchivedSessions
}

export interface ArchivePurgeFlowResult {
  /** Roots actually force-purged (roots minus current-session refusals). */
  readonly roots: readonly string[]
  /** True when the frozen selection contained the viewed session (roots leg). */
  readonly skippedCurrent: boolean
  /** Roots refused because the viewed session is in their CLOSURE. */
  readonly refusedRoots: readonly string[]
  /** The stop pass outcome, or null when it was never attempted. */
  readonly stop: StopSessionsResult | null
  /** The purge outcome, or null when nothing was purged. */
  readonly purge: ArchiveCleanupPurgeResult | null
  /** Why nothing was purged; `null` ⟺ `purge !== null`. The discriminated
   *  reason makes "refused without a cause" unrepresentable (N5). */
  readonly refusal: PurgeRefusalReason | null
}

/**
 * Stop the selected archived trees' running turns, then force-purge exactly
 * the roots that survived both exclusions.
 *
 * KNOWN CURRENT REQUIRED (N1, 2026-09): the force path only runs with a KNOWN
 * `currentId`. The vendor MASKS `current` to undefined while the selected
 * session is transiently off the list, so an absent id is UNKNOWN — the run
 * refuses (`current-unknown`) instead of purging with no exclusion.
 *
 * ROOTS LEG: the viewed session is dropped from the selection (it can never be
 * a purge target). CLOSURE LEG: a root whose closure contains the viewed
 * session is refused whole — skipped, never cancelled, never purged — because
 * the host deletes the root's whole subagent-origin tree.
 *
 * FAIL-CLOSED ON AN UNKNOWN CLOSURE OR LINEAGE: a failed `session/list` read
 * (`closure-unknown`) or an upward subagent chain the read cannot resolve
 * (`lineage-incomplete`, e.g. a cwd-less cold row dropped an intermediate
 * ancestor) refuses the whole run — nothing cancelled, nothing purged. The
 * stop pass never throws, but it never "proceeds anyway" either.
 */
export async function runArchivePurge(
  client: PurgeClient,
  selection: readonly string[],
  currentId: string | undefined,
  deps: ArchivePurgeFlowDeps = {},
): Promise<ArchivePurgeFlowResult> {
  const stopPass = deps.stop ?? stopSessionsForPurge
  const purge = deps.purge ?? purgeArchivedSessions
  const unique = [...new Set(selection)]
  // N1: no known current session ⇒ no force path (belt-and-braces mirror of
  // `purgeRefusalReason`, so the flow itself can never purge unguarded).
  if (typeof currentId !== 'string' || currentId === '') {
    return {
      roots: [],
      skippedCurrent: false,
      refusedRoots: [],
      stop: null,
      purge: null,
      refusal: 'current-unknown',
    }
  }
  const targets = unique.filter(id => id !== currentId)
  const skippedCurrent = targets.length !== unique.length
  if (targets.length === 0) {
    return {
      roots: [],
      skippedCurrent,
      refusedRoots: [],
      stop: null,
      purge: null,
      refusal: 'current-only',
    }
  }
  const stop = await stopPass(client, targets, { exclude: [currentId] })
  if (stop.unavailable || stop.lineage === null) {
    // Unknown closure + a viewed session that must be protected ⇒ refuse.
    return {
      roots: [],
      skippedCurrent,
      refusedRoots: [],
      stop,
      purge: null,
      refusal: 'closure-unknown',
    }
  }
  if (!upwardChainComplete(currentId, stop.lineage)) {
    // PARTIAL-LINEAGE HOLE (E-#1): an intermediate ancestor row is missing, so
    // the client cannot prove the viewed session is outside the selected
    // trees — while the HOST (full corpus) would still delete it. Refuse.
    return {
      roots: [],
      skippedCurrent,
      refusedRoots: [],
      stop,
      purge: null,
      refusal: 'lineage-incomplete',
    }
  }
  const roots = targets.filter(id => !stop.refusedRoots.includes(id))
  if (roots.length === 0) {
    return {
      roots,
      skippedCurrent,
      refusedRoots: stop.refusedRoots,
      stop,
      purge: null,
      refusal: 'current-in-closure',
    }
  }
  const result = await purge(client, roots, true)
  return {
    roots,
    skippedCurrent,
    refusedRoots: stop.refusedRoots,
    stop,
    purge: result,
    refusal: null,
  }
}
