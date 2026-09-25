/**
 * Chamber's own subagent-descendant index (a deep vendor import would pull vendor sources into
 * chamber typecheck programs that do not compile under chamber tsconfigs).
 *
 * MIRRORED from the official ui-workspace tree: the running bit's RESOLUTION — the official nav
 * reads a child as running through `statuses.get(child.id)?.running ?? list.byId[child.id]?.running`
 * (live status projection first, list row as fallback), so the count goes through
 * {@link resolveSessionRunning}; an omitted map (unmounted source) keeps the row's own bit.
 *
 * NOT mirrored (deliberate, see design 06 §4.5 + STATUS ⑮): the official `runningChildCount` sums
 * `list.projectionsBySession[parentId].values.subagentCatalog` — the parent's DIRECT children —
 * while this index walks the `parentId` chain and attributes every descendant to ALL ancestors.
 * For nested delegation the ancestor count is therefore a superset of the official one.
 */
import { resolveSessionRunning, type SessionRunningStatus } from './session-row-state.ts'

/** Session id (wire string; kept local to avoid vendor subpath imports). */
export type SessionId = string

/** Minimal summary row shape the projection walks (subset of SessionSummary). */
interface LineageEntry {
  readonly id: SessionId
  readonly parentId?: SessionId
  readonly origin?: 'subagent'
  readonly running: boolean
}

/** Descendant counts for one possible parent Session. */
export interface SubagentDescendantSummary {
  readonly count: number
  readonly runningCount: number
}

/** Index uninterrupted subagent descendants under each ancestor (totals keyed by possible parent id). */
export function indexSubagentDescendants(
  summaries: Readonly<Record<SessionId, LineageEntry>>,
  statusRunning?: SessionRunningStatus,
): ReadonlyMap<SessionId, SubagentDescendantSummary> {
  const indexed = new Map<SessionId, { count: number; runningCount: number }>()
  for (const descendant of Object.values(summaries)) {
    if (descendant.origin !== 'subagent') continue
    const descendantRunning = resolveSessionRunning(statusRunning, descendant.id, descendant.running)
    const seen = new Set<SessionId>()
    let current: LineageEntry | undefined = descendant
    while (current?.origin === 'subagent' && current.parentId !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      const aggregate = indexed.get(current.parentId)
      if (aggregate === undefined) {
        indexed.set(current.parentId, { count: 1, runningCount: descendantRunning ? 1 : 0 })
      } else {
        aggregate.count += 1
        if (descendantRunning) aggregate.runningCount += 1
      }
      current = summaries[current.parentId]
    }
  }
  return indexed
}
