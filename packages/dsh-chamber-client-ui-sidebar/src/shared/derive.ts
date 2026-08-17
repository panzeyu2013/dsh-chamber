/**
 * Pure sidebar workspace-list derivation from a per-instance snapshot (design
 * 05 §2.3). Mirrors the official dsh workspace browser rules (vendor
 * dsh-client-ui-workspace/src/client/tree.ts sessionVisible/groupByWorkspace/
 * byRecency) into the chamber bridge shape: subagent-origin and archived
 * sessions never surface, blank rows surface only while current (the active
 * source's provisional New Session row), real workspaces keep wire
 * membership order, and sessions outside every workspace trail in one
 * synthetic ungrouped bucket.
 *
 * No React, no DOM — plain-node unit-testable (see test/derive.ts).
 */
import type { InstanceSnapshot } from './instance-api.ts'
import type { ChamberServerWorkspace, InstanceRuntimeReport } from './aggregate-store.ts'

/** Synthetic id of the trailing group that collects sessions outside every workspace. */
export const UNGROUPED_WORKSPACE_ID = '__ungrouped__'

/** Wire search query schema clamp (design 06 §1.1): at most 500 UTF-16 code units. */
export const SEARCH_QUERY_MAX_CODE_UNITS = 500

/**
 * Search input normalization (design 06 §1.1 wire schema): strip NULs, clamp
 * to SEARCH_QUERY_MAX_CODE_UNITS UTF-16 code units without splitting a
 * surrogate pair, trim; '' when empty. Mirrors the wire search query schema
 * (trim, non-empty, ≤500, no '\0').
 */
export function sanitizeSearchQuery(query: string): string {
  let cleaned = query.replace(/\0/g, '')
  if (cleaned.length > SEARCH_QUERY_MAX_CODE_UNITS) {
    const high = cleaned.charCodeAt(SEARCH_QUERY_MAX_CODE_UNITS - 1)
    const low = cleaned.charCodeAt(SEARCH_QUERY_MAX_CODE_UNITS)
    const end =
      high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
        ? SEARCH_QUERY_MAX_CODE_UNITS - 1
        : SEARCH_QUERY_MAX_CODE_UNITS
    cleaned = cleaned.slice(0, end)
  }
  return cleaned.trim()
}

/**
 * Merge a stored ungrouped order with the wire order (design 06 §2/§3.2,
 * official reconciledSessionOrder/orderedUngrouped port): ids known to the
 * wire list come in stored order first, then the remaining wire ids in wire
 * order; ids unknown to the wire are skipped.
 */
export function reconciledSessionOrder(stored: readonly string[], wireIds: readonly string[]): string[] {
  const wire = new Set(wireIds)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const id of stored) {
    if (!wire.has(id) || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  for (const id of wireIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  return ordered
}

/**
 * One reconcile step of the App-owned "completed but unread" dot state
 * machine (design 06 §4.2). PURE — the App layer calls it inside a functional
 * state updater so batched reports compose without losing earlier arms.
 *
 * Rules mirror the vendor reminder, except "being read" is the ACTIVE view's
 * current session (the App's fact) instead of this ctx's possibly-stale
 * `selected`:
 * - arm: a running→idle edge (prevRunning true → now false) of a session the
 *   user is not reading right now (a background source has no reader, so
 *   every completion arms — the exact case the vendor's stale selection
 *   suppresses);
 * - disarm: the session re-runs (running true), leaves the list, or the user
 *   starts reading it (it becomes the active view's current session).
 *
 * @param sessions - the report's per-session rows (live running bits).
 * @param nextRunning - caller-computed pass-through of the new running bits
 *   (used for the leave-the-list sweep; the caller keeps its own ref in sync).
 * @param prevRunning - the source's last-observed running bits (per-report
 *   snapshot — never the shared ref, so batched updaters stay correctly
 *   paired with their own report).
 * @param prevCompleted - the source's armed set before this report.
 * @param readingCurrent - the session being read right now: the ACTIVE view's
 *   current session, or undefined for background sources (nothing is read).
 * @returns the next armed set (identity when unchanged) and whether it changed.
 */
export function reconcileCompletedFacts(params: {
  sessions: Record<string, { running?: boolean }>
  nextRunning: Record<string, boolean>
  prevRunning: Record<string, boolean>
  prevCompleted: Record<string, boolean>
  readingCurrent: string | undefined
}): { completed: Record<string, boolean>; changed: boolean } {
  const next = { ...params.prevCompleted }
  let changed = false
  for (const [sessionId, row] of Object.entries(params.sessions)) {
    if (row?.running === true) {
      // Re-run disarms (vendor same rule).
      if (next[sessionId] === true) {
        delete next[sessionId]
        changed = true
      }
      continue
    }
    // running → idle edge: arm unless the session is being read right now.
    if (params.prevRunning[sessionId] === true && sessionId !== params.readingCurrent && next[sessionId] !== true) {
      next[sessionId] = true
      changed = true
    }
    // Reading disarms: the active view's current session is on screen.
    if (sessionId === params.readingCurrent && next[sessionId] === true) {
      delete next[sessionId]
      changed = true
    }
  }
  // Sessions that left the list: drop their armed dots and edge memory.
  for (const sessionId of Object.keys(params.prevRunning)) {
    if (params.nextRunning[sessionId] !== undefined) continue
    if (next[sessionId] === true) {
      delete next[sessionId]
      changed = true
    }
  }
  return { completed: changed ? next : params.prevCompleted, changed }
}

/**
 * Project one ctx's sessions snapshot into the chamber runtime-facts report
 * (design 06 §4.2). STATELESS pass-through: every listed session carries its
 * live `running` bit (the App layer derives the completed-but-unread dot from
 * running→idle edges itself — it owns the active view and every open request,
 * so it is the single place that knows what "being read" means), while
 * `completed`/`pending` ride the vendor runtime's armed state as sparse
 * extras. `subagentRunning` (the vendor lineage index's RUNNING descendant
 * count per parent, 06 §4.5) is INJECTED by the plugin — this module stays a
 * pure controller with no unbuilt vendor package in its import graph (the
 * renderer shell bundle rides this module through the shared chunk), and the
 * plugin reuses the vendor's `indexSubagentDescendants` verbatim so the
 * aggregation semantics never drift. The loose snapshot param avoids
 * importing runtime store types.
 */
export function projectRuntimeFacts(
  snapshot: {
    current?: string
    byId?: Record<string, {
      running?: boolean
      completed?: boolean
      pendingInteraction?: 'approval' | 'plan-review' | 'question'
    }>
  },
  subagentRunning?: ReadonlyMap<string, number>,
): InstanceRuntimeReport {
  const sessions: InstanceRuntimeReport['sessions'] = {}
  for (const [id, facts] of Object.entries(snapshot.byId ?? {})) {
    const row: {
      running?: boolean
      completed?: boolean
      pending?: 'approval' | 'plan-review' | 'question'
      runningSubagents?: number
    } = {
      running: facts?.running === true,
    }
    if (facts?.completed === true) row.completed = true
    if (facts?.pendingInteraction !== undefined) row.pending = facts.pendingInteraction
    const runningSubagents = subagentRunning?.get(id) ?? 0
    if (runningSubagents > 0) row.runningSubagents = runningSubagents
    sessions[id] = row
  }
  const report: InstanceRuntimeReport = { sessions }
  if (snapshot.current !== undefined) report.current = snapshot.current
  return report
}

/**
 * Merge one source's live runtime-facts report with the App-owned
 * completed-but-unread dots (design 06 §4.2): the UNION of the channel's
 * vendor-armed completed rows and the App-derived dots (the App's
 * running→idle edge state machine is authoritative for background sources;
 * the vendor's completed stays as a fallback), preserving the current
 * session and every other live row (running / pending / runningSubagents).
 * PURE — extracted so the App's deriveServers merge is unit-testable.
 * Returns undefined when there is nothing to attach (no report and no armed
 * dots); the caller attaches runtime only for CONNECTED sources, so a
 * not-connected source never carries facts.
 */
export function mergeRuntimeFacts(
  runtime: InstanceRuntimeReport | undefined,
  completedBySource: Record<string, boolean> | undefined,
): InstanceRuntimeReport | undefined {
  const chamberCompleted = completedBySource
  const hasArmed = chamberCompleted !== undefined && Object.values(chamberCompleted).some(value => value === true)
  if (runtime === undefined && !hasArmed) {
    return undefined
  }
  const sessions: InstanceRuntimeReport['sessions'] = { ...(runtime?.sessions ?? {}) }
  if (chamberCompleted !== undefined) {
    for (const [sessionId, armed] of Object.entries(chamberCompleted)) {
      if (armed !== true) continue
      const row = sessions[sessionId] ?? {}
      sessions[sessionId] = { ...row, completed: true }
    }
  }
  return { current: runtime?.current, sessions }
}

/**
 * Navigation visibility: subagent-origin and archived rows are always hidden;
 * blank rows follow the official rule (!blank || current) — a blank "new
 * session" provisional row shows only while it is the source's CURRENT
 * session (the one being viewed). The App layer passes the current session
 * id only for the ACTIVE source (see App.tsx deriveServers), so no other
 * source's provisional blank row ever enters the projection (design 06 §4.3
 * single-selection discipline: current-session visuals belong to the visible
 * source alone).
 */
function sessionVisible(
  session: { sessionId: string; blank: boolean; origin?: 'subagent' },
  currentSessionId: string | undefined,
  archived: ReadonlySet<string>,
): boolean {
  return session.origin !== 'subagent'
    && !archived.has(session.sessionId)
    && (!session.blank || session.sessionId === currentSessionId)
}

/**
 * Relative time for session rows as a structured bucket the UI localizes
 * ("now"/"5min"/"3h"/"2d"/"4mo"/"1y" in en). Mirrors the official
 * relativeTime() in vendor dsh-client-ui-workspace/src/client/tree.ts
 * exactly: 60s MIN, 60min HOUR, 24h DAY, 30d MONTH, 365d YEAR, n floor,
 * diff clamped at >=0, unit 'now' with n=0.
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms (injected for pure rendering).
 */
export interface RelativeTimeBucket {
  unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'
  n: number
}

export function relativeTimeBucket(updatedAt: number, now: number): RelativeTimeBucket {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - updatedAt)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}

/**
 * Recency comparator: newest first, sessionId ascending as the deterministic
 * tiebreak. A missing wire updatedAt sorts as 0 (behavior identical to the
 * pre-optional coercion of absent wire values to 0).
 */
function byRecency(
  a: { sessionId: string; updatedAt?: number },
  b: { sessionId: string; updatedAt?: number },
): number {
  const atA = a.updatedAt ?? 0
  const atB = b.updatedAt ?? 0
  if (atB !== atA) return atB - atA
  return a.sessionId < b.sessionId ? -1 : 1
}

/**
 * Compute the sidebar workspace list for one instance snapshot.
 * @param snapshot - one InstanceAggregate-like pull (workspaces/sessions).
 * @param ungroupedTitle - display title for the trailing ungrouped bucket;
 *   the sidebar overrides it when `ungrouped` is true; pass '' from App.
 * @param currentSessionId - the source's current session id (from the
 *   per-ctx runtime-facts channel), or undefined for non-active sources.
 *   Blank rows surface only when they carry this id (see sessionVisible).
 * @returns real workspaces in wire order (visible members in sessionIds order),
 *   plus one synthetic trailing ungrouped group when visible stray sessions
 *   exist; [] for an empty snapshot.
 */
export function deriveServerWorkspaces(
  snapshot: InstanceSnapshot,
  ungroupedTitle: string,
  currentSessionId?: string,
): ChamberServerWorkspace[] {
  const sessionsById = new Map(snapshot.sessions.map(session => [session.sessionId, session]))
  const archivedIds = new Set(snapshot.archivedSessionIds)
  const accounted = new Set<string>()
  const workspaces: ChamberServerWorkspace[] = []
  for (const workspace of snapshot.workspaces) {
    const sessions: ChamberServerWorkspace['sessions'] = []
    for (const sessionId of workspace.sessionIds) {
      const session = sessionsById.get(sessionId)
      if (session === undefined) continue
      accounted.add(sessionId)
      if (!sessionVisible(session, currentSessionId, archivedIds)) continue
      sessions.push({
        id: sessionId,
        title: session.title ?? '',
        running: session.running,
        updatedAt: session.updatedAt,
        // Sparse flag: only blank (provisional new-session) rows carry it, so
        // the sidebar can render the localized New Session label instead.
        ...(session.blank ? { blank: true } : {}),
      })
    }
    workspaces.push({ id: workspace.workspaceId, title: workspace.title, sessions })
  }
  const stray = snapshot.sessions
    .filter(session => !accounted.has(session.sessionId) && sessionVisible(session, currentSessionId, archivedIds))
    .sort(byRecency)
  if (stray.length > 0) {
    workspaces.push({
      id: UNGROUPED_WORKSPACE_ID,
      title: ungroupedTitle,
      ungrouped: true,
      sessions: stray.map(session => ({
        id: session.sessionId,
        title: session.title ?? '',
        running: session.running,
        updatedAt: session.updatedAt,
        ...(session.blank ? { blank: true } : {}),
      })),
    })
  }
  return workspaces
}
