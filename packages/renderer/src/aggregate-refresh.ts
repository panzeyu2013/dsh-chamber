import type { InstanceAggregate, InstanceSnapshot, SessionRow } from '@dsh-chamber/dsh-chamber-client-core'

/**
 * Decide which ready sources need an authoritative unary aggregate refresh: a
 * mounted producer normally suppresses unary work, but a not-ready -> ready
 * edge must pull once (the producer de-duplicates identical snapshots and may
 * have nothing new after a reconnect; previously-pushed sources keep their view
 * through the outage, never-pushed ones are replaced with `not-connected`).
 * One pull per connection generation restores the aggregate without a timer.
 */

/**
 * Whether an aggregate is the DEGRADED unary-fallback view: ok state plus at
 * least one cwd-derived SYNTHETIC workspace row (only the fallback produces
 * them). An EMPTY workspace set is a legitimate mounted state, never synthetic.
 */
export function isFallbackDerivedView(current: InstanceAggregate | undefined): boolean {
  return current !== undefined && current.state === 'ok'
    && current.workspaces.length > 0
    && current.workspaces.some(workspace => workspace.synthetic === true)
}

/**
 * Carry a session's last KNOWN projection-derived row facts across a row that
 * arrives without them. A connection generation change makes the pinned client
 * clear every session projection store (`handleConnected`), and only the next
 * `session/list` response re-applies the values; in that window the pushed
 * rows carry no durable `title` — the official ladder
 * (`title ?? basename(cwd) ?? id`) falls back to the project directory name —
 * and lose the sparse `hasActiveSchedule` marker, so the sidebar would flash
 * both. The same rule covers a unary fallback row that arrived without its
 * title projection.
 *
 * Semantics: a non-empty incoming `title` ALWAYS wins (rename / new session,
 * and a genuine schedule-off keeps its title too, so the marker is never kept
 * against it); a row with no previous row, or whose previous row also carried
 * no title, passes through untouched; a row that disappeared drops its memory
 * with it (the caller's `previous` IS the memory). Identity-preserving when
 * nothing is carried (an allocation optimization, not the dedupe's cause: the
 * commit gate compares CONTENT signatures, so a push whose only degradation was
 * the transiently missing label dedupes to no commit).
 *
 * BOUND (no timer, no state): the carry stops as soon as the row's `updatedAt`
 * advances past the last known row. An advance is durable new activity, meaning
 * the authority re-read the session and still served no title — keeping the old
 * name past that point would report a fact the authority no longer supports.
 * A dormant row (no advance) keeps its last known facts until it is seen with a
 * title again, retires, or the page reloads; a wall-clock bound would only flip
 * a session we know by name to its directory name, for no informational gain.
 *
 * The carried `displayTitle` is LOAD-BEARING, not decoration: the official
 * ladder reads `displayTitle` FIRST (`session-display.ts`) and `derive.ts`
 * feeds the row's value back into the same ladder, so carrying only `title`
 * would still render the incoming derived basename; when the previous row has
 * none, the carried title becomes the display title.
 */
export function retainSessionLabels(
  previous: readonly SessionRow[] | undefined,
  next: SessionRow[],
): SessionRow[] {
  if (previous === undefined || previous.length === 0 || next.length === 0) return next
  const byId = new Map(previous.map(row => [row.sessionId, row]))
  let carried = false
  const merged = next.map(row => {
    if (typeof row.title === 'string' && row.title !== '') return row
    const prev = byId.get(row.sessionId)
    if (prev === undefined) return row
    const title = prev.title
    if (typeof title !== 'string' || title === '') return row
    // Durable new activity ends the carry (see BOUND above): the authority has
    // re-read this session and still serves no title.
    if (typeof prev.updatedAt === 'number' && typeof row.updatedAt === 'number'
      && row.updatedAt > prev.updatedAt) return row
    carried = true
    // The incoming row has no durable title, so its own `displayTitle` is a
    // DERIVED label (cwd basename / id) — never keep it: it would shadow the
    // carried title in the official ladder (`displayTitle ?? title ?? ...`).
    const prevDisplayTitle = prev.displayTitle
    const displayTitle = typeof prevDisplayTitle === 'string' && prevDisplayTitle !== ''
      ? prevDisplayTitle
      : title
    return {
      ...row,
      title,
      displayTitle,
      // Sparse: only a previously observed active schedule is restored, and only
      // inside the same transient that lost the title.
      ...(prev.hasActiveSchedule === true ? { hasActiveSchedule: true as const } : {}),
    }
  })
  return carried ? merged : next
}

/**
 * Whether a not-ready source's current aggregate may be RETAINED through a
 * transport outage instead of being replaced by `not-connected`.
 *
 * Retaining the last PUSHED view is safe (deriveServers hides rows while the
 * transport is not ready) and makes the ready-edge pull take the merge branch
 * of {@link commitAggregatePull} — workspaces + archive set stay authoritative,
 * only session rows refresh. Replacing an ok view with `not-connected` would
 * instead commit the FULL unary fallback (no archive set, cwd-derived synthetic
 * groups); if the mounted store then stayed silent, that degraded view would be
 * permanent and archived sessions would resurface as openable rows. Never-pushed
 * / unmounted sources are NOT retainable (the fallback is their scope).
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
 * Whether a MOUNTED source STUCK on the degraded fallback view (synthetic rows
 * present) should get a lightweight ctx reconnect, bounded by the same backoff
 * as the stale-channel arm: replaying the workspace follow baseline replaces the
 * fallback with the recovered view (with its archive set). 记录纪律与重连臂一致：
 * 仅在 reconnectInstanceConnection() 返回 true 时记录 lastReconnectAt——no-op 重连
 * （无连接持有者）不消耗退避窗，重试是廉价 no-op。
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
 * Watchdog reconnect threshold per source transport.
 *
 * The watchdog cannot distinguish a FROZEN push channel from a healthy-but-quiet
 * one (mounted producers push only on content changes), and every reconnect
 * costs one baseline replay, so the threshold follows how much INDEPENDENT
 * liveness coverage each transport already has:
 * - `http`: only the control plane's 30s WS ping and ~10min OS TCP keepalive, so
 *   an app-level freeze can stay invisible for minutes — 120s.
 * - `ssh`: the tunnel already has the 30s WS ping, the host mux's 2s/2-miss
 *   heartbeat and ServerAliveInterval=30 × CountMax=3, so 5min is a last resort.
 * - `local` / unknown: null (local is authoritative; unknown is fail-closed).
 */
export const AGGREGATE_RECONNECT_HTTP_STALE_MS = 120_000
/** Last-resort app-level freeze heal for tunnel sources (see above). */
export const AGGREGATE_RECONNECT_SSH_STALE_MS = 300_000

/**
 * The reconnect threshold for one source's transport, or null when this arm must
 * not touch it (local / unknown). `transport` is an untrusted shape.
 */
export function reconnectStalenessMsForTransport(transport: unknown): number | null {
  if (transport === 'http') return AGGREGATE_RECONNECT_HTTP_STALE_MS
  if (transport === 'ssh') return AGGREGATE_RECONNECT_SSH_STALE_MS
  return null
}

/**
 * Commit one unary aggregate pull over the current per-source aggregate.
 *
 * The fallback cannot express workspace identity or the archive set (it carries
 * an EMPTY archive set plus cwd-derived synthetic groups), so a source whose
 * mounted producer already pushed keeps its pushed groups/archive/state — the
 * fallback contributes only live session rows (running bits, new sessions).
 * Without that merge, the watchdog's 30s re-pull of a healthy-but-idle mounted
 * source would commit the degraded fallback, resurfacing archived sessions and
 * synthetic groups. Never-pushed / unmounted sources keep the full fallback
 * commit (first-boot window; KNOWN DEGRADATION scope).
 *
 * The merge applies only when the current workspaces are REAL: ANY synthetic row
 * means the last commit came from the fallback, and freezing that view would
 * keep cwd groups and sessions stale — such currents keep receiving full commits
 * until a real push replaces them, and the App's fallback watchdog arms a ctx
 * reconnect (shouldRebaselineFallbackView). An EMPTY workspace set is never
 * treated as synthetic.
 */
export function commitAggregatePull(
  current: InstanceAggregate | undefined,
  fallback: InstanceSnapshot,
  mounted: boolean,
  rememberedArchiveSet?: readonly string[],
): InstanceAggregate {
  const currentIsFallbackDerived = isFallbackDerivedView(current)
  if (mounted && current !== undefined && current.state === 'ok' && !currentIsFallbackDerived) {
    // Keeps every authoritative pushed field (workspaces + archivedSessionIds +
    // archive-set PROVENANCE) and only the unary's live session rows.
    // archiveSetKnown must ride along: it is the manager's tri-state input, and
    // dropping it would flip an authoritative source into the degraded branch.
    return {
      state: 'ok',
      workspaces: current.workspaces,
      sessions: fallback.sessions,
      archivedSessionIds: current.archivedSessionIds,
      archiveSetKnown: current.archiveSetKnown === true,
      // 置顶集与归档集同权：unary 回退没有该线源，丢掉会让标记在每次兜底拉取时闪没。
      // 稀疏：只对「该面出现之前铸出的 aggregate」生效（今天的每个生产者都会写这两个键）；
      // 键缺席时不产出键，合并对象与 current 逐字节一致，identity 去重门不会因这次落位抖动。
      // ids 与 known **同进同出**：两个独立 spread 能拼出「known:true 而 ids 缺席」的混合态
      // （derive 会把空集当成权威「真无置顶」），一个 spread 从形状上排除它。
      ...(current.pinnedSessionIds === undefined ? {} : { pinnedSessionIds: current.pinnedSessionIds, pinSetKnown: current.pinSetKnown === true }),
      error: null,
    }
  }
  // The fallback carries no archive wire source, so a degraded commit would
  // publish an EMPTY set and archived rows would render as ordinary ones until
  // the next authoritative push. A remembered authoritative set is published
  // with `archiveSetKnown` still FALSE (sidebar filters correctly, manager keeps
  // its honest degraded branch — provenance is not claimed).
  const remembered = rememberedArchiveSet === undefined ? undefined : [...rememberedArchiveSet]
  return {
    state: 'ok',
    ...fallback,
    ...(remembered === undefined ? {} : { archivedSessionIds: remembered }),
    error: null,
  }
}

/**
 * Decide the failure commit for one unary aggregate pull: a mounted source that
 * already pushed keeps its last aggregate (an error row would blank it; the
 * unary probe says nothing about the push channel) and `null` signals that.
 * Never-pushed / unmounted sources keep the error state (first-boot surface).
 */
export function commitAggregateFailure(mounted: boolean, errorText: string): InstanceAggregate | null {
  if (mounted) return null
  return { state: 'error', workspaces: [], sessions: [], archivedSessionIds: [], error: errorText }
}

/**
 * 保留视图的「无法验证」界限。
 *
 * 已推送来源在 unary 拉取失败时保留最后视图，这避免归档回流与整段空白，但也意味着
 * 持续读失败时视图被无限冻结（旧 running 位一直渲染成「运行中」）。本界限把保留有界化：
 * 距最后一次成功验证（push 或 unary 提交）超过 AGGREGATE_UNVERIFIED_FACTS_MS 后，丢掉
 * 无法验证的 running 断言（只清 running 位，行/分组照旧保留），并把来源交给会话停滞
 * 横幅；下一次成功读取立即恢复。环是断言，无法验证却保留等于陈述无证据事实，清位 +
 * 可见提示才是诚实的「不知道」。已知残余：宿主仍在跑而读路径坏时用户会暂时看不到运行
 * 环，由同一条横幅的「重新连接」出口收口。`factsAt === undefined` = 从未验证，无断言可丢。
 */
export const AGGREGATE_UNVERIFIED_FACTS_MS = 90_000

export function shouldDropUnverifiedRunningFacts(opts: {
  factsAt: number | undefined
  now: number
  budgetMs?: number
}): boolean {
  if (opts.factsAt === undefined) return false
  const budgetMs = opts.budgetMs ?? AGGREGATE_UNVERIFIED_FACTS_MS
  return opts.now - opts.factsAt >= budgetMs
}
/**
 * Detect an archived-set SHRINK between the last committed aggregate and an
 * incoming snapshot. A strict shrink is the client's observable "ids left the
 * archive set" signal — a completed purge, or an unarchive (0.1.7 added
 * `workspace/unarchiveSession`; the official undo/filter uses it). Both
 * legitimately mean the mounted list may need the source's official session-list
 * refresh, so the response is the same.
 * The baseline is the committed aggregate when archive-set-authoritative
 * (`state==='ok' && archiveSetKnown===true`), otherwise the caller's `remembered`
 * set (the last authoritative set seen for this source) — otherwise a shrink
 * completed during a degraded window is invisible forever. Returns [] for a
 * non-authoritative `next` and when neither side is authoritative: the unary
 * fallback's empty set is a known-degraded artifact, not a shrink fact.
 * Consumers respond by requesting the source's official session-list refresh:
 * purged rows may still linger in the mounted ctx's summaries and would
 * otherwise resurface as ordinary rows whose opening fails with session/not-found.
 */
export function archiveSetShrink(
  previous: InstanceAggregate | undefined,
  next: Pick<InstanceSnapshot, 'archivedSessionIds' | 'archiveSetKnown'>,
  remembered?: readonly string[],
): string[] {
  if (next.archiveSetKnown !== true) return []
  // Lost provenance (degraded / not-connected / never pushed): fall back to the
  // last AUTHORITATIVE set, or a purge during that window is invisible forever.
  const previousSet = previous !== undefined && previous.state === 'ok' && previous.archiveSetKnown === true
    ? previous.archivedSessionIds
    : remembered
  if (previousSet === undefined) return []
  const nextSet = new Set(next.archivedSessionIds)
  return previousSet.filter(id => !nextSet.has(id))
}

/**
 * Bounded re-request floor for {@link planSessionListRefresh} consumers: a
 * request may go out when `lastRequestedAt` is `undefined` (never requested) or
 * older than the coalescing gap. `0` is an ancient stamp, NOT "never requested".
 */
export function shouldRequestSessionListRefresh(
  lastRequestedAt: number | undefined,
  now: number,
  coalesceMs: number,
): boolean {
  return lastRequestedAt === undefined || now - lastRequestedAt >= coalesceMs
}

/**
 * One plan step of the App-side ghost-row convergence state machine, evaluated
 * on EVERY ready mounted push BEFORE the aggregate commit (against the
 * last-committed aggregate):
 * - "removed" = the archived-set shrink of this push (the purge-completed signal);
 * - ghost candidates = removed ∪ pending ids STILL listed as session rows
 *   (already-gone ids are dropped and never requested);
 * - `request: true` = purged rows are still visible and the official session-list
 *   refresh is outstanding. The caller dispatches at most once per coalescing
 *   gap and re-evaluates on the next push, whose rows clear `pending` — the
 *   machine is self-terminating. Push-only evaluation is COMPLETE: mounted pulls
 *   preserve the archived set and fallback commits are provenance-gated, so a
 *   pull can never first observe a shrink.
 */
export function planSessionListRefresh(
  previous: InstanceAggregate | undefined,
  next: Pick<InstanceSnapshot, 'archivedSessionIds' | 'archiveSetKnown' | 'sessions'>,
  pending: readonly string[] | undefined,
  remembered?: readonly string[],
): { request: boolean; pending: string[] } {
  const removed = archiveSetShrink(previous, next, remembered)
  const rowIds = new Set<string>()
  for (const session of next.sessions) rowIds.add(session.sessionId)
  const kept: string[] = []
  const seen = new Set<string>()
  const consider = (id: string): void => {
    if (seen.has(id) || !rowIds.has(id)) return
    seen.add(id)
    kept.push(id)
  }
  for (const id of removed) consider(id)
  if (pending !== undefined) {
    for (const id of pending) consider(id)
  }
  return { request: kept.length > 0, pending: kept }
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

/** Coalescing queue for aggregate refresh waves: an edge arriving mid-wave stays
 *  pending for the next drain, not silently consumed by App's edge memory. */
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
 * Drain queued aggregate refreshes under a fixed concurrency cap: one wave at a
 * time, at most `concurrency` pulls in flight, every source of a wave pulled
 * exactly once (the queue already dedupes by source id). The drain loops until
 * the queue is empty, so a refresh edge arriving mid-wave is picked up by the
 * successor wave instead of being lost.
 *
 * This is the ONE bounded-wave implementation: the edge poll, the staleness
 * watchdog and the facts row hint all reach it (the row hint enqueues a single
 * source — the cap is shared, never bypassed).
 */
export async function drainAggregateWaves(
  queue: AggregateRefreshQueue,
  concurrency: number,
  pull: (sourceId: string) => Promise<void>,
  onPullFailure?: (sourceId: string, error: unknown) => void,
): Promise<void> {
  while (queue.size > 0) {
    const sourceIds = queue.take()
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < sourceIds.length) {
        const sourceId = sourceIds[cursor]
        cursor += 1
        // 每项独立隔离（S5）：pull 拒绝只丢弃该项（计数走 onPullFailure，绝不重入队——
        // 无界重入队 = 活锁），本波剩余项照常拉完，Promise.all 只在所有 worker 收工后
        // resolve ⇒ 不产生孤儿 worker 与下一波叠加突破并发帽，也不逃成 unhandledRejection。
        // 拉取自身的 deadline 在实例 unary 层（INSTANCE_UNARY_TIMEOUT_MS = 30s），这里不叠第二层。
        try {
          await pull(sourceId)
        } catch (error) {
          // 诊断 sink 必须自隔离：它自己抛错不得把 worker 打 reject——Promise.all 会提前
          // settle，.finally 在其余 worker 仍在飞时复位并发帽，下一波就与残留 worker 叠加
          // （破坏 4-pull 上限）。sink 的失败不改变本波纪律。
          try {
            onPullFailure?.(sourceId, error)
          } catch { /* 诊断失败不影响拉取纪律 */ }
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(Math.max(1, concurrency), sourceIds.length) },
      () => worker(),
    ))
  }
}

/** Staleness predicate for the aggregate watchdog: stale when a source never
 *  pushed or its last push is older than the threshold — recency is the only
 *  liveness signal, since the unary client exposes no connection state. */
export function isSnapshotStale(
  lastSnapshotAt: number | undefined,
  now: number,
  stalenessMs: number,
): boolean {
  return lastSnapshotAt === undefined || now - lastSnapshotAt > stalenessMs
}

/**
 * Reconnect predicate for the staleness watchdog: a MOUNTED source whose push
 * channel went silent gets a lightweight reconnect so the ctx's own reconnect
 * chain re-establishes the workspace follow (a half-open direct-http upstream
 * leg fires no 'error'/'close', so nothing else triggers it). Unmounted sources
 * are excluded (no shell owns their connection), `lastReconnectAt` backoff
 * bounds repeats, and the unary pull keeps running regardless — the reconnect is
 * additional, never a replacement. `mounted` is CALLER-DEFINED: "pushed at least
 * one snapshot this generation" (a channel dead from first boot never pushes and
 * is covered by the unary fallback).
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

/** Whether an aggregate pull still owns its commit: mutation pulls use a
 *  dedicated sequence (a push can expose the mutation's interim cross-section),
 *  ordinary pulls are fenced by the shared poll sequence. */
export function refreshPullStillCurrent(opts: {
  mutationTag?: number
  mutationSeq: number | undefined
  pollSeq: number
  startedPollSeq: number
}): boolean {
  if (opts.mutationTag !== undefined) return opts.mutationSeq === opts.mutationTag
  return opts.pollSeq === opts.startedPollSeq
}

/** Renderer-local facts whose lifetime is one authoritative roster entry, kept
 *  outside React state so a removal invalidates an old unary result synchronously. */
export interface AggregateLifecycleState {
  failuresBySource: Record<string, number>
  snapshotAtBySource: Record<string, number>
  readySources: Set<string>
}

export interface AggregateLifecycleInvalidation extends AggregateLifecycleState {
  removedSourceIds: string[]
}

/** Pure authoritative-roster transition for keyed aggregate facts; async unary
 *  ownership is retired separately, so no historical sequence tombstones here. */
export function invalidateRemovedAggregateSources(
  previousLiveSourceIds: ReadonlySet<string>,
  nextLiveSourceIds: ReadonlySet<string>,
  state: AggregateLifecycleState,
): AggregateLifecycleInvalidation {
  const removedSourceIds = [...previousLiveSourceIds].filter(id => !nextLiveSourceIds.has(id))
  if (removedSourceIds.length === 0) return { ...state, removedSourceIds }

  const failuresBySource = { ...state.failuresBySource }
  const snapshotAtBySource = { ...state.snapshotAtBySource }
  const readySources = new Set(state.readySources)
  for (const sourceId of removedSourceIds) {
    delete failuresBySource[sourceId]
    delete snapshotAtBySource[sourceId]
    readySources.delete(sourceId)
  }
  return {
    removedSourceIds,
    failuresBySource,
    snapshotAtBySource,
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

/** Identity-preserving keyed-state retirement; `hasOwn` also clears keys explicitly set to undefined. */
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

/** Retire an active/pending selection from the trusted lifecycle delta; a
 *  presentation-only same-id edit carries no retired id and is preserved. */
export function retireSelectedSource<T extends string | null>(
  sourceId: T,
  removedSourceIds: ReadonlySet<string>,
  fallback: T,
): T {
  return sourceId !== null && removedSourceIds.has(sourceId) ? fallback : sourceId
}

/** Translate the trusted desktop registry delta into renderer source ids; using
 *  the delta preserves a remove -> same-id re-add edge the final roster hides. */
export function remoteRetiredSourceIds(retiredRawIds: readonly string[]): Set<string> {
  const retired = new Set<string>()
  for (const id of retiredRawIds) {
    retired.add(`dsh-${id}`)
    retired.add(`gateway-${id}`)
    retired.add(`ssh-${id}`)
  }
  return retired
}
