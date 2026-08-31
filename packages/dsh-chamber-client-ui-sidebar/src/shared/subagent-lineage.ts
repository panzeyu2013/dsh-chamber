/**
 * Local copy of the vendor `dsh-client-ui-workspace`
 * `indexSubagentDescendants` (ui-workspace/src/client/subagent-lineage.ts).
 *
 * WHY a local copy (migration D5 fallback, docs/tmp-dsh-v012-migration-plan.md
 * M4): the original deep-source import pulled vendor ui-workspace sources into
 * chamber typecheck programs, and those sources do not compile under chamber
 * tsconfigs (see ./directory-browse-error.ts header). The function is a pure,
 * self-contained projection; the sidebar's subagent counts reuse it verbatim
 * (client/index.ts), matching the official ui-workspace tree semantics.
 */

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

/**
 * Index uninterrupted subagent descendants under each ancestor.
 * @param summaries - Session summaries keyed by id.
 * @returns descendant totals keyed by possible parent id.
 */
export function indexSubagentDescendants(
  summaries: Readonly<Record<SessionId, LineageEntry>>,
): ReadonlyMap<SessionId, SubagentDescendantSummary> {
  const indexed = new Map<SessionId, { count: number; runningCount: number }>()
  for (const descendant of Object.values(summaries)) {
    if (descendant.origin !== 'subagent') continue
    const seen = new Set<SessionId>()
    let current: LineageEntry | undefined = descendant
    while (current?.origin === 'subagent' && current.parentId !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      const aggregate = indexed.get(current.parentId)
      if (aggregate === undefined) {
        indexed.set(current.parentId, { count: 1, runningCount: descendant.running ? 1 : 0 })
      } else {
        aggregate.count += 1
        if (descendant.running) aggregate.runningCount += 1
      }
      current = summaries[current.parentId]
    }
  }
  return indexed
}
