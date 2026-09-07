import type { InstanceAggregate, InstanceSnapshot } from '@dsh-chamber/dsh-client-ui-sidebar/shared'

/**
 * Decide which ready sources need an authoritative unary aggregate refresh.
 *
 * A mounted producer normally suppresses unary work. The exception is a
 * not-ready -> ready edge: the producer de-duplicates identical snapshots, so
 * it may have nothing new to publish after a reconnect (a previously-pushed
 * mounted source keeps its pushed view through the outage —
 * shouldRetainPushedAggregate — and only NEVER-pushed sources were replaced
 * with `not-connected`). One pull per connection generation restores the
 * aggregate without reintroducing a timer.
 */

/**
 * Whether an aggregate is the DEGRADED unary-fallback view: ok state plus at
 * least one cwd-derived SYNTHETIC workspace row. Only the unary fallback ever
 * produces synthetic rows (a mounted push never does), so any synthetic row
 * means the last commit itself came from the fallback. An EMPTY workspace set
 * is never synthetic (a legitimate mounted fresh-instance state).
 */
export function isFallbackDerivedView(current: InstanceAggregate | undefined): boolean {
  return current !== undefined && current.state === 'ok'
    && current.workspaces.length > 0
    && current.workspaces.some(workspace => workspace.synthetic === true)
}

/**
 * Whether a not-ready source's current aggregate may be RETAINED through a
 * transport outage instead of being replaced by `not-connected`.
 *
 * 2026-09 bugfix (sidebar: reconnect resurfaces archived conversations, click
 * dead-ends into the new-session view): the disconnect wipe used to replace
 * EVERY ok aggregate with `not-connected`, so the not-ready -> ready edge
 * committed the FULL unary fallback view — which carries NO archive set and
 * cwd-derived synthetic groups. When the mounted ctx store then stayed
 * silent (nothing changed + producer signature dedupe suppresses an identical
 * rebaseline push), that degraded view became PERMANENT: archived sessions
 * resurfaced as openable rows and clicking one opened an archived current the
 * official runtime immediately clears (empty new-session view). Retaining the
 * last PUSHED view through the outage is safe for rendering (deriveServers
 * hides all rows while the transport is not ready) and makes the ready-edge
 * pull take the merge branch of {@link commitAggregatePull} — workspaces +
 * archive set stay authoritative, only session rows refresh from the unary.
 * Never-pushed / unmounted sources are NOT retainable (the unary fallback is
 * their documented scope).
 */
export function shouldRetainPushedAggregate(
  mounted: boolean,
  current: InstanceAggregate | undefined,
): boolean {
  return mounted === true
    && current !== undefined
    && current.state === 'ok'
    && !isFallbackDerivedView(current)
}

/**
 * Whether a MOUNTED source whose aggregate is STUCK on the degraded fallback
 * view (synthetic rows present) should get a lightweight ctx connection
 * reconnect, bounded by the same backoff as the S2 stale-channel arm. The
 * reconnect replays the workspace follow baseline; the store withdrawal
 * clears the producer's content signature, so the identical recovered
 * baseline is re-published and replaces the fallback view (with its archive
 * set) — the heal for aggregates that degraded before this retention fix (or
 * through any residual full-commit path). Recording discipline（2026 评审校
 * 正，与 S2 臂一致 = M4）：仅在 reconnectInstanceConnection() 实际调用成功
 * （返回 true）时记录 lastReconnectAt——no-op 重连（无连接持有者，如已回收
 * 来源）不消耗退避窗，每可见 tick 的重试是廉价 no-op。
 */
export function shouldRebaselineFallbackView(opts: {
  mounted: boolean
  fallbackView: boolean
  lastReconnectAt: number | undefined
  now: number
  reconnectBackoffMs: number
}): boolean {
  return opts.mounted === true
    && opts.fallbackView === true
    && (opts.lastReconnectAt === undefined || opts.now - opts.lastReconnectAt >= opts.reconnectBackoffMs)
}

/**
 * Commit one unary aggregate pull over the current per-source aggregate.
 *
 * The unary fallback cannot express workspace identity or the archive set
 * (0.1.2 wire: `workspace.list` was deleted upstream — the archive set exists
 * only on the workspace follow baseline, so `fetchInstanceSnapshot` returns
 * an EMPTY archive set plus cwd-derived synthetic groups). A source whose
 * mounted producer already pushed must therefore keep its pushed
 * groups/archive/state — the fallback contributes only its live session rows
 * (running bits, new sessions), exactly the documented "sessions-only
 * fallback never replaces a mounted source's groups/archive/state" contract
 * (derive.ts projectInstanceSnapshot doc). Without this, the staleness
 * watchdog's 30s re-pull of a healthy-but-idle mounted source replaced the
 * aggregate with the degraded fallback: every archived session resurfaced
 * together with synthetic workspace groups (beta 0.2.0 regression —
 * "archived-resurfacing", the exact regression the 2026-09 withdrawal rule
 * was meant to prevent). Never-pushed / unmounted sources keep the full
 * fallback commit (pre-baseline window and unmounted sources are the
 * documented KNOWN DEGRADATION scope).
 *
 * The merge applies only when the current aggregate's workspaces are REAL
 * (a mounted push never produces synthetic rows — only the fallback does).
 * ANY synthetic row means the last commit itself came from the fallback
 * (e.g. the not-connected → ready-edge full commit landed while the
 * post-restart follow baseline never arrived): freezing that degraded view
 * would keep cwd groups and new sessions stale, so such currents continue to
 * receive full commits (sessions AND cwd groups keep refreshing) until a real
 * push replaces them. An EMPTY workspace set is a legitimate mounted state
 * (fresh instance — everything renders ungrouped) and is never treated as
 * synthetic.
 *
 * Reachability of the full-commit degraded view (2026-09 revision): the
 * not-ready → ready-edge full commit only fires when the current aggregate
 * was NOT retained through the outage (see shouldRetainPushedAggregate — a
 * previously-pushed mounted source keeps its pushed view, so the ready-edge
 * pull takes the merge branch and archived sessions never resurface on
 * reconnect). The full commit remains the honest stopgap for never-pushed /
 * unmounted sources (first-boot window, KNOWN DEGRADATION scope) and for
 * previously-degraded currents — those keep receiving full commits until a
 * real push replaces them, and the App's fallback-view watchdog additionally
 * arms a ctx reconnect (shouldRebaselineFallbackView) so a silent mounted
 * channel heals instead of freezing the degraded view forever.
 */
export function commitAggregatePull(
  current: InstanceAggregate | undefined,
  fallback: InstanceSnapshot,
  mounted: boolean,
): InstanceAggregate {
  const currentIsFallbackDerived = isFallbackDerivedView(current)
  if (mounted && current !== undefined && current.state === 'ok' && !currentIsFallbackDerived) {
    // The merge keeps every authoritative pushed field (workspaces +
    // archivedSessionIds + archive-set PROVENANCE) and contributes only the
    // unary's live session rows. archiveSetKnown must ride along: it is the
    // manager's tri-state input ("[] = genuinely nothing archived"), and the
    // unary fallback carries no archive wire source — dropping the flag here
    // would flip an authoritative source into the degraded manager branch on
    // the first mutation pull (2026 dev-QA finding: after archiving a
    // session the requestRefresh pull landed before the producer push and
    // the archive manager showed the degraded tri-state until a reload).
    return {
      state: 'ok',
      workspaces: current.workspaces,
      sessions: fallback.sessions,
      archivedSessionIds: current.archivedSessionIds,
      archiveSetKnown: current.archiveSetKnown === true,
      error: null,
    }
  }
  return { state: 'ok', ...fallback, error: null }
}

/**
 * Decide the failure commit for one unary aggregate pull.
 *
 * A mounted source that already pushed keeps its last aggregate through pull
 * failures — the unary probe says nothing about the push channel, and
 * replacing authoritative pushed state with an error row would blank/hide it
 * (2026-09 beta regression fix; the same keep-last-view rule as the
 * withdrawal window). Returns `null` to signal "keep the current aggregate"
 * (the caller still runs the 503 health refresh and retry bookkeeping).
 * Never-pushed / unmounted sources keep the error state (first-boot error
 * surface, bounded quick retries).
 */
export function commitAggregateFailure(mounted: boolean, errorText: string): InstanceAggregate | null {
  if (mounted) return null
  return { state: 'error', workspaces: [], sessions: [], archivedSessionIds: [], error: errorText }
}
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
 * Coalescing queue for aggregate refresh waves. A readiness edge that arrives
 * while another wave is running stays pending for the next drain instead of
 * being silently consumed by the edge-memory update in App.
 */
export class AggregateRefreshQueue {
  readonly #pending = new Set<string>()

  enqueue(sourceIds: readonly string[]): void {
    for (const sourceId of sourceIds) this.#pending.add(sourceId)
  }

  take(): string[] {
    const sourceIds = [...this.#pending]
    this.#pending.clear()
    return sourceIds
  }

  delete(sourceIds: Iterable<string>): void {
    for (const sourceId of sourceIds) this.#pending.delete(sourceId)
  }

  get size(): number {
    return this.#pending.size
  }
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
 * Reconnect predicate for the staleness watchdog (S2 sidebar stability, 对齐
 * ssh 断链自动恢复): a MOUNTED source whose push channel went silent — stale
 * per {@link isSnapshotStale} — gets a lightweight connection reconnect so
 * the ctx's own healthy reconnect chain re-establishes the workspace follow
 * (a half-open direct-http upstream leg fires no 'error'/'close', so nothing
 * else ever triggers it). Unmounted sources are excluded (no shell owns a
 * connection to reconnect — they stay on the unary fallback), and the
 * `lastReconnectAt` backoff bounds repeat attempts so a reconnect that did
 * not heal (or a healthy-but-quiet producer) is not retried on every tick.
 * The unary pull keeps running regardless — the reconnect is an additional
 * action, never a replacement.
 *
 * `mounted` is CALLER-DEFINED — the App passes "the ctx producer pushed at
 * least one snapshot this generation" (worked-then-went-silent, the S2 target
 * class); a channel dead from its first boot never pushes and is covered by
 * the unary fallback instead (KNOWN DEGRADATION scope, M3 review note). Tests
 * exercise the predicate with explicit `mounted` values.
 */
export function shouldReconnectStaleMounted(opts: {
  mounted: boolean
  lastSnapshotAt: number | undefined
  lastReconnectAt: number | undefined
  now: number
  stalenessMs: number
  reconnectBackoffMs: number
}): boolean {
  return opts.mounted === true
    && isSnapshotStale(opts.lastSnapshotAt, opts.now, opts.stalenessMs)
    && (opts.lastReconnectAt === undefined || opts.now - opts.lastReconnectAt >= opts.reconnectBackoffMs)
}

/**
 * Decide whether an aggregate pull still owns its commit. Mutation-triggered
 * pulls use a dedicated sequence because a producer push can expose the
 * mutation's interim host-frame cross-section; ordinary pulls remain fenced
 * by the shared poll sequence so a newer push cannot be overwritten.
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

/** Renderer-local generation/ownership facts whose lifetime is exactly one
 * authoritative roster entry. Kept separate from React state so a roster
 * removal can invalidate an old unary result synchronously, before the render
 * that eventually removes the source row. */
export interface AggregateLifecycleState {
  failuresBySource: Record<string, number>
  snapshotAtBySource: Record<string, number>
  snapshotSources: Record<string, true>
  readySources: Set<string>
}

export interface AggregateLifecycleInvalidation extends AggregateLifecycleState {
  removedSourceIds: string[]
}

/**
 * Pure authoritative-roster transition for keyed aggregate facts. Async unary
 * ownership is retired separately through the active-only object-token
 * registry, so this state carries no historical sequence tombstones.
 */
export function invalidateRemovedAggregateSources(
  previousLiveSourceIds: ReadonlySet<string>,
  nextLiveSourceIds: ReadonlySet<string>,
  state: AggregateLifecycleState,
): AggregateLifecycleInvalidation {
  const removedSourceIds = [...previousLiveSourceIds].filter(id => !nextLiveSourceIds.has(id))
  if (removedSourceIds.length === 0) return { ...state, removedSourceIds }

  const failuresBySource = { ...state.failuresBySource }
  const snapshotAtBySource = { ...state.snapshotAtBySource }
  const snapshotSources = { ...state.snapshotSources }
  const readySources = new Set(state.readySources)
  for (const sourceId of removedSourceIds) {
    delete failuresBySource[sourceId]
    delete snapshotAtBySource[sourceId]
    delete snapshotSources[sourceId]
    readySources.delete(sourceId)
  }
  return {
    removedSourceIds,
    failuresBySource,
    snapshotAtBySource,
    snapshotSources,
    readySources,
  }
}

/** Identity-preserving source-list retirement used by mounted/prewarm queues. */
export function withoutRemovedSourceIds(
  sourceIds: string[],
  removedSourceIds: ReadonlySet<string>,
): string[] {
  if (removedSourceIds.size === 0) return sourceIds
  const next = sourceIds.filter(sourceId => !removedSourceIds.has(sourceId))
  return next.length === sourceIds.length ? sourceIds : next
}

/** Identity-preserving keyed-state retirement. `hasOwn` also clears keys whose
 * value is explicitly undefined (plugin-diagnostic state has that shape). */
export function withoutRemovedSourceKeys<T>(
  state: Record<string, T>,
  removedSourceIds: ReadonlySet<string>,
): Record<string, T> {
  let next: Record<string, T> | undefined
  for (const sourceId of removedSourceIds) {
    if (!Object.hasOwn(state, sourceId)) continue
    next ??= { ...state }
    delete next[sourceId]
  }
  return next ?? state
}

/** Retire an active/pending source selection from the trusted lifecycle delta.
 * A presentation-only same-id edit carries no retired id and is therefore
 * preserved. `fallback` is local for active selection and null for pending. */
export function retireSelectedSource<T extends string | null>(
  sourceId: T,
  removedSourceIds: ReadonlySet<string>,
  fallback: T,
): T {
  return sourceId !== null && removedSourceIds.has(sourceId) ? fallback : sourceId
}

/** Translate the trusted desktop registry delta into renderer source ids. The
 * delta, rather than a later roster snapshot, preserves a remove -> same-id
 * re-add edge when both overlapping pulls observe only the final roster. */
export function remoteRetiredSourceIds(retiredRawIds: readonly string[]): Set<string> {
  const retired = new Set<string>()
  for (const id of retiredRawIds) {
    retired.add(`dsh-${id}`)
    retired.add(`gateway-${id}`)
    retired.add(`ssh-${id}`)
  }
  return retired
}
