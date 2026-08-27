/**
 * Decide which ready sources need an authoritative unary aggregate refresh.
 *
 * A mounted producer normally suppresses unary work. The exception is a
 * not-ready -> ready edge: the producer de-duplicates identical snapshots, so
 * it may have nothing new to publish after a reconnect even though the App
 * deliberately replaced the old aggregate with `not-connected`. One pull per
 * connection generation restores the aggregate without reintroducing a timer.
 */
export function planAggregateRefreshes(
  readySourceIds: readonly string[],
  previouslyReady: ReadonlySet<string>,
  snapshotSources: Readonly<Record<string, true>>,
): { refreshSourceIds: string[]; nextReady: Set<string> } {
  const nextReady = new Set(readySourceIds)
  const refreshSourceIds = readySourceIds.filter(sourceId =>
    !previouslyReady.has(sourceId) || snapshotSources[sourceId] !== true,
  )
  return { refreshSourceIds, nextReady }
}

/**
 * Staleness predicate for the aggregate watchdog (the fallback net for a
 * mounted producer whose push channel silently died). A source is stale when
 * it never pushed a snapshot or its last push is older than the threshold —
 * recency is the only liveness signal the App has, since the unary client
 * does not expose per-source connection state.
 */
export function isSnapshotStale(
  lastSnapshotAt: number | undefined,
  now: number,
  stalenessMs: number,
): boolean {
  return lastSnapshotAt === undefined || now - lastSnapshotAt > stalenessMs
}

/**
 * Whether an in-flight aggregate pull may still commit (2026-10 fix, the
 * create/fork latency report). Two validity domains:
 *
 * - MUTATION-triggered pulls (the sidebar's `chamberBridge.requestRefresh`
 *   after create/fork/rename/archive/drag): the pull starts only AFTER the
 *   mutation response, so its data always includes the mutation — frame-driven
 *   pushes must NOT discard it. The host publishes the mutation as two ordered
 *   frames (`host/session-added` during create, `host/workspace-changed` after
 *   the attach commit), and a push projected between them carries the interim
 *   cross-section (the new session in the list but not yet in any workspace).
 *   The old shared seq let such a push kill the refresh pull, stranding the
 *   session in the ungrouped bucket until the next push — or until the 30s
 *   watchdog when the store went quiet. These pulls check ONLY their own tag
 *   (`mutationSeq`), bumped by later mutation pulls and the not-ready sweep.
 *
 *   Deliberate trade-off (the shared seq used to be the conservative guard):
 *   a mutation pull landing can clobber a NEWER store event whose push arrived
 *   between the pull's start and its commit (a one-RTT window). For the
 *   chamber's mutation set the host commits the mutation BEFORE answering the
 *   mutation RPC, so the pull's data dominates every frame minted before the
 *   response; the exposed window only covers events racing the mutation's own
 *   round trip — far below human event cadence and bounded by one RTT. The
 *   same window also covers an overlapping ORDINARY pull (ready-edge/watchdog)
 *   that started later and resolved earlier: its data is at least as new, and
 *   the mutation pull landing after it could regress the fresher facts. This
 *   variant is practically unreachable for a mounted source — the watchdog
 *   only fires after 30s of push silence, while a mutation pull only runs
 *   right after a user action whose frames keep the push channel fresh.
 *   Healing is NOT immediate for every rendered fact: the sidebar running
 *   ring renders only the aggregate's polled bit, so a running flip clobbered
 *   inside the window can stay wrong until the next push that actually
 *   changes the projected snapshot, the next mutation pull, or the 30s
 *   staleness watchdog (a quiet store pushes nothing in between). This is an
 *   accepted residual — the window itself is the rare part, and the stale bit
 *   self-corrects at the next converge point.
 *
 * - ORDINARY pulls (ready-edge, staleness watchdog): keep the shared seq —
 *   a push (newer store truth) or a newer pull invalidates an older in-flight
 *   pull so it cannot land last and regress the aggregate.
 */
export function refreshPullStillCurrent(opts: {
  mutationTag?: number
  mutationSeq: number | undefined
  pollSeq: number
  startedPollSeq: number
}): boolean {
  if (opts.mutationTag !== undefined) return opts.mutationSeq === opts.mutationTag
  return opts.pollSeq === opts.startedPollSeq
}
