import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGGREGATE_RECONNECT_HTTP_STALE_MS,
  AGGREGATE_RECONNECT_SSH_STALE_MS,
  AGGREGATE_UNVERIFIED_FACTS_MS,
  AggregateRefreshQueue,
  archiveSetShrink,
  commitAggregateFailure,
  commitAggregatePull,
  invalidateRemovedAggregateSources,
  isFallbackDerivedView,
  isSnapshotStale,
  reconnectStalenessMsForTransport,
  planAggregateRefreshes,
  planSessionListRefresh,
  refreshPullStillCurrent,
  remoteRetiredSourceIds,
  retireSelectedSource,
  shouldRebaselineFallbackView,
  shouldReconnectStaleMounted,
  shouldDropUnverifiedRunningFacts,
  shouldRequestSessionListRefresh,
  shouldRetainPushedAggregate,
  withoutRemovedSourceIds,
  withoutRemovedSourceKeys,
} from '../../src/aggregate-refresh.ts'
import { SourceOwnershipRegistry } from '../../src/deep-link-activation.ts'
import {
  instanceBasePath,
  isChamberSourceId,
  rawInstanceIdFromSourceId,
  sourceIdForInstance,
  sourceIdForRawInstance,
} from '../../src/transport-source.ts'
import type { InstanceAggregate, InstanceSnapshot } from '@dsh-chamber/dsh-chamber-client-core'

// ---- commitAggregatePull ----

/** A session row as the aggregate/snapshot wire carries it, with blank defaulting false. */
const sessionRow = (sessionId: string, running = false): InstanceAggregate['sessions'][number] => ({ sessionId, running, blank: false })

/** A fallback (unary-pull) workspace row: '__cwd__:'-prefixed id, marked synthetic. */
const syntheticWorkspace = (path: string, title: string, sessionIds: string[] = []): InstanceSnapshot['workspaces'][number] =>
  ({ workspaceId: '__cwd__:' + path, path, title, sessionIds, createdAt: '', updatedAt: '', synthetic: true })

/** ok aggregate over an empty workspace/session set; `over` carries per-case state/provenance. */
const okAggregate = (archivedSessionIds: string[], archiveSetKnown = true, over: Partial<InstanceAggregate> = {}): InstanceAggregate =>
  ({ state: 'ok', workspaces: [], sessions: [], archivedSessionIds, archiveSetKnown, error: null, ...over })

const mountedAggregate: InstanceAggregate = {
  state: 'ok',
  workspaces: [{
    workspaceId: 'w-real',
    path: '/real',
    title: 'Real',
    sessionIds: ['s1'],
    createdAt: 't0',
    updatedAt: 't1',
  }],
  sessions: [sessionRow('s1', true)],
  archivedSessionIds: ['archived-1', 'archived-2'],
  error: null,
}

const fallbackSnapshot: InstanceSnapshot = {
  workspaces: [syntheticWorkspace('/real', 'Real', ['s1'])],
  sessions: [sessionRow('s1'), sessionRow('archived-1')],
  archivedSessionIds: [],
}

test('commitAggregatePull: a mounted pushed source keeps groups/archive/state; only sessions come from the fallback', () => {
  const committed = commitAggregatePull(mountedAggregate, fallbackSnapshot, true)
  assert.equal(committed.state, 'ok')
  assert.equal(committed.error, null)
  // Workspace identity and the archive set stay authoritative (mounted push).
  assert.deepEqual(committed.workspaces, mountedAggregate.workspaces)
  assert.deepEqual(committed.archivedSessionIds, mountedAggregate.archivedSessionIds)
  // Live session rows (running bits, new sessions) come from the unary pull.
  assert.deepEqual(committed.sessions, fallbackSnapshot.sessions)
})

test('commitAggregatePull: the mounted merge preserves archive-set provenance (archiveSetKnown) — a mutation pull must never flip the archive manager into the degraded branch', () => {
  // The manager's tri-state reads archiveSetKnown; the unary fallback carries
  // no archive wire source (fetchInstanceSnapshot marks the set unknown).
  // The merge preserves the flag: otherwise the first requestRefresh pull
  // after an archive action puts the source in the degraded manager view
  // ("无法列出已归档会话") until a reload.
  const authoritative: InstanceAggregate = {
    ...mountedAggregate,
    archiveSetKnown: true,
  }
  const merged = commitAggregatePull(authoritative, fallbackSnapshot, true)
  assert.equal(merged.archiveSetKnown, true, 'mounted merge keeps the authoritative provenance')
  assert.deepEqual(merged.archivedSessionIds, authoritative.archivedSessionIds)
  // An authoritative-but-EMPTY archive set must also stay "known" — [] is the
  // true "nothing archived" fact, never the degraded unknown state.
  const authoritativeEmpty: InstanceAggregate = okAggregate([], true, {
    workspaces: mountedAggregate.workspaces, sessions: mountedAggregate.sessions,
  })
  const mergedEmpty = commitAggregatePull(authoritativeEmpty, { ...fallbackSnapshot, archivedSessionIds: [] }, true)
  assert.equal(mergedEmpty.archiveSetKnown, true)
  assert.deepEqual(mergedEmpty.archivedSessionIds, [])
  // A legacy current WITHOUT the flag (pre-flag producers / not authoritative)
  // stays unknown after the merge — no provenance is invented.
  const mergedLegacy = commitAggregatePull(mountedAggregate, fallbackSnapshot, true)
  assert.equal(mergedLegacy.archiveSetKnown, false)
})

test('commitAggregatePull: the full fallback commit carries the unary\'s unknown archive-set provenance', () => {
  const committed = commitAggregatePull(undefined, { ...fallbackSnapshot, archiveSetKnown: false }, false)
  assert.equal(committed.archiveSetKnown, false)
})

test('commitAggregatePull: never-pushed / unmounted sources keep the full degraded fallback commit', () => {
  const committed = commitAggregatePull(undefined, fallbackSnapshot, false)
  assert.deepEqual(committed, { state: 'ok', ...fallbackSnapshot, error: null })
  assert.deepEqual(committed.archivedSessionIds, [])
})

test('commitAggregatePull: a mounted source without an ok aggregate falls back to the full commit (not-connected/error are authoritative states)', () => {
  const notConnected: InstanceAggregate = okAggregate([], true, { state: 'not-connected' })
  const committed = commitAggregatePull(notConnected, fallbackSnapshot, true)
  assert.deepEqual(committed, { state: 'ok', ...fallbackSnapshot, error: null })
})

test('commitAggregatePull: mounted × error-state current and mounted × never-committed (undefined) both take the full commit', () => {
  const errorState: InstanceAggregate = okAggregate([], true, { state: 'error', error: 'transient' })
  assert.deepEqual(commitAggregatePull(errorState, fallbackSnapshot, true), { state: 'ok', ...fallbackSnapshot, error: null })
  assert.deepEqual(commitAggregatePull(undefined, fallbackSnapshot, true), { state: 'ok', ...fallbackSnapshot, error: null })
})

test('commitAggregatePull: an all-synthetic current (last commit came from the fallback) keeps receiving full commits — never freezes the degraded view', () => {
  const syntheticCurrent: InstanceAggregate = okAggregate([], true, {
    workspaces: [syntheticWorkspace('/real', 'Real', ['s1'])], sessions: [sessionRow('s1')],
  })
  const committed = commitAggregatePull(syntheticCurrent, fallbackSnapshot, true)
  assert.deepEqual(committed, { state: 'ok', ...fallbackSnapshot, error: null })
})

test('commitAggregatePull: ANY synthetic row marks the current as fallback-derived (mixed sets — unreachable by construction — stay on full commits)', () => {
  const mixedCurrent: InstanceAggregate = okAggregate(['archived-1'], true, {
    workspaces: [mountedAggregate.workspaces[0] as NonNullable<InstanceAggregate['workspaces'][number]>, syntheticWorkspace('/other', 'Other', ['s2'])],
    sessions: [sessionRow('s1', true), sessionRow('s2')],
  })
  const committed = commitAggregatePull(mixedCurrent, fallbackSnapshot, true)
  assert.deepEqual(committed, { state: 'ok', ...fallbackSnapshot, error: null })
})

test('commitAggregateFailure: a mounted pushed source keeps its last aggregate (null = keep; 503 health refresh stays caller-owned)', () => {
  assert.equal(commitAggregateFailure(true, 'boom'), null)
})

test('commitAggregateFailure: never-pushed / unmounted sources get the error aggregate (first-boot error surface)', () => {
  assert.deepEqual(commitAggregateFailure(false, 'boom'), {
    state: 'error',
    workspaces: [],
    sessions: [],
    archivedSessionIds: [],
    error: 'boom',
  })
})

test('commitAggregatePull: an empty workspace set is a legitimate mounted state and is never treated as synthetic', () => {
  const emptyWorkspaces: InstanceAggregate = okAggregate(['archived-1'], true, { sessions: [sessionRow('s1', true)] })
  const committed = commitAggregatePull(emptyWorkspaces, fallbackSnapshot, true)
  assert.deepEqual(committed.workspaces, [])
  assert.deepEqual(committed.archivedSessionIds, ['archived-1'])
})

test('commitAggregatePull: identical sessions keep the aggregate identity stable (watchdog re-pulls cause no churn)', () => {
  const current: InstanceAggregate = { ...mountedAggregate, archiveSetKnown: true }
  const fallbackWithSameSessions: InstanceSnapshot = { ...fallbackSnapshot, sessions: [sessionRow('s1', true)] }
  const merged = commitAggregatePull(current, fallbackWithSameSessions, true)
  // The merged object is byte-identical to the current aggregate, so the
  // App's instanceSnapshotSignature dedupe keeps the same state object —
  // an idle watchdog re-pull never re-renders the sidebar.
  assert.deepEqual(merged, current)
})

test('watchdog × mounted-source invariant: a ready source with a complete producer is never re-pulled, and even if pulled the commit never degrades groups/archive', () => {
  // Edge path: mounted + previously ready → no unary pull at all.
  const plan = planAggregateRefreshes(['local'], new Set(['local']), { local: true })
  assert.deepEqual(plan.refreshSourceIds, [])
  // Watchdog path (recency-driven, App.tsx): the pull DOES run, but the
  // commit preserves the mounted groups/archive — archived conversations
  // cannot resurface end to end.
  const committed = commitAggregatePull(mountedAggregate, fallbackSnapshot, true)
  assert.deepEqual(committed.archivedSessionIds, mountedAggregate.archivedSessionIds)
  assert.deepEqual(committed.workspaces, mountedAggregate.workspaces)
})

test('a stable ready source with a complete producer needs no unary refresh', () => {
  const plan = planAggregateRefreshes(['local'], new Set(['local']), { local: true })
  assert.deepEqual(plan.refreshSourceIds, [])
  assert.deepEqual([...plan.nextReady], ['local'])
})

test('a ready source without a complete producer keeps the unary fallback', () => {
  const plan = planAggregateRefreshes(['local'], new Set(['local']), {})
  assert.deepEqual(plan.refreshSourceIds, ['local'])
})

test('disconnect then reconnect forces one pull even when the producer still owns an identical snapshot', () => {
  const disconnected = planAggregateRefreshes([], new Set(['ssh-a']), { 'ssh-a': true })
  assert.deepEqual([...disconnected.nextReady], [])

  const reconnected = planAggregateRefreshes(['ssh-a'], disconnected.nextReady, { 'ssh-a': true })
  assert.deepEqual(reconnected.refreshSourceIds, ['ssh-a'])

  const stableAgain = planAggregateRefreshes(['ssh-a'], reconnected.nextReady, { 'ssh-a': true })
  assert.deepEqual(stableAgain.refreshSourceIds, [])
})

test('each source is planned independently across mixed connection generations', () => {
  const plan = planAggregateRefreshes(
    ['local', 'ssh-a', 'ssh-b'],
    new Set(['local', 'ssh-a']),
    { local: true, 'ssh-a': true, 'ssh-b': true },
  )
  assert.deepEqual(plan.refreshSourceIds, ['ssh-b'])
})

test('a refresh edge arriving during a wave is retained for the successor wave', () => {
  const queue = new AggregateRefreshQueue()
  queue.enqueue(['local'])
  assert.deepEqual(queue.take(), ['local'])

  // The first wave is now in flight. A newly-ready remote source is queued
  // independently and therefore cannot be consumed by the first take().
  queue.enqueue(['ssh-late', 'ssh-late'])
  assert.equal(queue.size, 1)
  assert.deepEqual(queue.take(), ['ssh-late'])
  assert.equal(queue.size, 0)
})

test('sources that become not-ready before the successor wave are removed', () => {
  const queue = new AggregateRefreshQueue()
  queue.enqueue(['ssh-ready', 'ssh-dropped'])
  queue.delete(['ssh-dropped'])
  assert.deepEqual(queue.take(), ['ssh-ready'])
})

test('isSnapshotStale: never-pushed sources are stale (unmounted / dead push)', () => {
  assert.equal(isSnapshotStale(undefined, 1_000, 30_000), true)
})

test('isSnapshotStale: a recent push is fresh even when the producer is quiet', () => {
  assert.equal(isSnapshotStale(1_000, 30_000, 30_000), false)
  assert.equal(isSnapshotStale(1_000, 30_999, 30_000), false)
})

test('isSnapshotStale: silence past the threshold is stale (push channel presumed dead)', () => {
  assert.equal(isSnapshotStale(1_000, 31_001, 30_000), true)
})

test('transport source ids preserve the registry kind across N-ctx and proxy routing (v2, design 17 §2.1)', () => {
  const instances = [
    { id: 'east', kind: 'dsh' as const },
    { id: 'edge-west', kind: 'gateway' as const },
  ]
  assert.equal(sourceIdForInstance(instances[0]), 'dsh-east')
  assert.equal(sourceIdForInstance(instances[1]), 'gateway-edge-west')
  assert.equal(sourceIdForRawInstance('edge-west', instances), 'gateway-edge-west')
  assert.equal(sourceIdForRawInstance('local', instances), 'local')
  assert.equal(sourceIdForRawInstance('missing', instances), null)
  assert.equal(rawInstanceIdFromSourceId('dsh-east'), 'east')
  assert.equal(rawInstanceIdFromSourceId('gateway-edge-west'), 'edge-west')
  // The legacy ssh-<id> spelling keeps parsing (design 17 §2.2 — deep links
  // and older persisted source ids stay routable).
  assert.equal(rawInstanceIdFromSourceId('ssh-east'), 'east')
  assert.equal(rawInstanceIdFromSourceId('ssh-ssh-east'), 'ssh-east')
  assert.equal(rawInstanceIdFromSourceId('local'), null)
  assert.equal(instanceBasePath('gateway-edge-west'), '/api/i/gateway-edge-west')
  assert.equal(instanceBasePath('dsh-east'), '/api/i/dsh-east')
  assert.equal(instanceBasePath('ssh-east'), '/api/i/ssh-east')
})

test('chamber source-id validation accepts canonical and legacy prefixes but rejects unknown/malformed ones', () => {
  for (const sourceId of [undefined, 'local', 'dsh-east', 'ssh-east', 'gateway-west']) {
    assert.equal(isChamberSourceId(sourceId), true, String(sourceId))
  }
  for (const sourceId of ['', 'ssh-', 'gateway-', 'dsh-', 'gateway-../east', 'dsh-../east', 'http-east', '../gateway-east']) {
    assert.equal(isChamberSourceId(sourceId), false, sourceId)
    assert.throws(() => instanceBasePath(sourceId), /invalid chamber source id/)
  }
  assert.throws(() => instanceBasePath(undefined as never), /invalid chamber source id/)
  assert.throws(
    () => sourceIdForInstance({ id: '../east', kind: 'gateway' }),
    /invalid transport instance id/,
  )
  assert.throws(
    () => sourceIdForInstance({ id: 'east', kind: 'direct' as never }),
    /invalid transport kind/,
  )
})

// ---- disconnect retention + fallback-view heal ----

test('isFallbackDerivedView: only ok aggregates with synthetic rows are the degraded unary view', () => {
  assert.equal(isFallbackDerivedView(undefined), false)
  assert.equal(isFallbackDerivedView({ ...mountedAggregate }), false)
  assert.equal(isFallbackDerivedView(okAggregate([])), false, 'an EMPTY workspace set is a legitimate mounted state, never synthetic')
  assert.equal(isFallbackDerivedView(okAggregate([], true, {
    state: 'not-connected', workspaces: [syntheticWorkspace('/x', 'x')],
  })), false, 'not-connected/error states are not an ok fallback VIEW')
  assert.equal(isFallbackDerivedView(okAggregate([], true, { workspaces: [syntheticWorkspace('/x', 'x')] })), true)
})

test('shouldRetainPushedAggregate: a previously-pushed mounted source keeps its ok aggregate through a transport outage', () => {
  assert.equal(shouldRetainPushedAggregate(true, mountedAggregate), true)
  assert.equal(shouldRetainPushedAggregate(true, { ...mountedAggregate, archiveSetKnown: true }), true)
  // Legitimate empty workspaces (fresh mounted instance) stay retainable.
  assert.equal(shouldRetainPushedAggregate(true, okAggregate([])), true)
})

test('shouldRetainPushedAggregate: never-pushed / unmounted / degraded / non-ok currents are NOT retainable', () => {
  assert.equal(shouldRetainPushedAggregate(false, mountedAggregate), false, 'unmounted sources keep the fallback scope')
  assert.equal(shouldRetainPushedAggregate(true, undefined), false)
  assert.equal(shouldRetainPushedAggregate(true, okAggregate([], true, { state: 'not-connected' })), false)
  assert.equal(shouldRetainPushedAggregate(true, okAggregate([], true, { state: 'error', error: 'x' })), false)
  // A current ALREADY degraded to the fallback view is not retainable — the
  // retention prevents NEW degraded views, it must not freeze existing ones.
  assert.equal(shouldRetainPushedAggregate(true, okAggregate([], true, {
    workspaces: [syntheticWorkspace('/real', 'Real', ['s1'])], sessions: [sessionRow('s1')],
  })), false)
})

test('retention closes the ready-edge full-commit: a retained ok aggregate merges sessions-only (archive set survives the reconnect pull)', () => {
  // End-to-end shape: the aggregate that survived the
  // outage (state ok, real workspaces, archive set) meets the ready-edge
  // unary pull — the commit is the MOUNTED MERGE, never the full fallback.
  const committed = commitAggregatePull(mountedAggregate, fallbackSnapshot, true)
  assert.deepEqual(committed.archivedSessionIds, mountedAggregate.archivedSessionIds)
  assert.deepEqual(committed.workspaces, mountedAggregate.workspaces)
  assert.deepEqual(committed.sessions, fallbackSnapshot.sessions)
})

// ---- shouldRebaselineFallbackView (heal a mounted source whose
// aggregate is stuck on the degraded fallback view via a bounded ctx
// reconnect) ----

const NOW2 = 2_000_000
const BACKOFF2 = 60_000

test('shouldRebaselineFallbackView: a mounted source stuck on the fallback view reconnects when the backoff has elapsed', () => {
  assert.equal(shouldRebaselineFallbackView({
    mounted: true,
    fallbackView: true,
    lastReconnectAt: undefined,
    now: NOW2,
    reconnectBackoffMs: BACKOFF2,
  }), true)
  assert.equal(shouldRebaselineFallbackView({
    mounted: true,
    fallbackView: true,
    lastReconnectAt: NOW2 - BACKOFF2,
    now: NOW2,
    reconnectBackoffMs: BACKOFF2,
  }), true)
})

test('shouldRebaselineFallbackView: a recent reconnect holds off the next attempt (backoff window)', () => {
  assert.equal(shouldRebaselineFallbackView({
    mounted: true,
    fallbackView: true,
    lastReconnectAt: NOW2 - 1,
    now: NOW2,
    reconnectBackoffMs: BACKOFF2,
  }), false)
})

test('shouldRebaselineFallbackView: unmounted sources and healthy (non-fallback) views never arm', () => {
  assert.equal(shouldRebaselineFallbackView({
    mounted: false,
    fallbackView: true,
    lastReconnectAt: undefined,
    now: NOW2,
    reconnectBackoffMs: BACKOFF2,
  }), false, 'unmounted sources have no ctx connection to reconnect — unary fallback is their scope')
  assert.equal(shouldRebaselineFallbackView({
    mounted: true,
    fallbackView: false,
    lastReconnectAt: undefined,
    now: NOW2,
    reconnectBackoffMs: BACKOFF2,
  }), false, 'a real pushed view needs no rebaseline bounce')
})

// ---- refresh pull validity domains (create/fork latency) ----

test('a mutation-triggered pull stays committable across pushes (the interim frame cross-section must not kill it)', () => {
  assert.equal(refreshPullStillCurrent({
    mutationTag: 7,
    mutationSeq: 7,
    pollSeq: 42,
    startedPollSeq: 3,
  }), true)
})

test('a newer mutation pull supersedes an older one (same source, rapid actions)', () => {
  assert.equal(refreshPullStillCurrent({
    mutationTag: 7,
    mutationSeq: 8,
    pollSeq: 8,
    startedPollSeq: 8,
  }), false)
})

test('the not-ready sweep invalidates an in-flight mutation pull (it bumps both domains)', () => {
  assert.equal(refreshPullStillCurrent({
    mutationTag: 7,
    mutationSeq: 9,
    pollSeq: 9,
    startedPollSeq: 8,
  }), false)
})

test('an ordinary pull is still invalidated by a push or a newer pull (shared seq, unchanged semantics)', () => {
  assert.equal(refreshPullStillCurrent({
    mutationTag: undefined,
    mutationSeq: undefined,
    pollSeq: 42,
    startedPollSeq: 3,
  }), false)
  assert.equal(refreshPullStillCurrent({
    mutationTag: undefined,
    mutationSeq: undefined,
    pollSeq: 3,
    startedPollSeq: 3,
  }), true)
})

test('a mutation tag with no recorded mutation seq fails closed (defensive; unreachable in App)', () => {
  assert.equal(refreshPullStillCurrent({
    mutationTag: 5,
    mutationSeq: undefined,
    pollSeq: 5,
    startedPollSeq: 5,
  }), false)
})

test('authoritative removal invalidates a deferred unary result and same-id re-add starts clean', () => {
  const requestOwners = new SourceOwnershipRegistry()
  const oldDeferredOwner = requestOwners.renew('ssh-readd')
  const original = {
    failuresBySource: { 'ssh-readd': 4, 'ssh-keep': 1 },
    snapshotAtBySource: { 'ssh-readd': 1_000, 'ssh-keep': 2_000 },
    snapshotSources: { 'ssh-readd': true, 'ssh-keep': true } as Record<string, true>,
    readySources: new Set(['ssh-readd', 'ssh-keep']),
  }

  const invalidated = invalidateRemovedAggregateSources(
    new Set(['local', 'ssh-readd', 'ssh-keep']),
    new Set(['local', 'ssh-keep']),
    original,
  )
  requestOwners.retire(invalidated.removedSourceIds)

  assert.deepEqual(invalidated.removedSourceIds, ['ssh-readd'])
  assert.equal(requestOwners.owns(oldDeferredOwner), false,
    'the old deferred pull no longer owns a resolve/reject write')
  assert.equal(invalidated.failuresBySource['ssh-readd'], undefined)
  assert.equal(invalidated.snapshotAtBySource['ssh-readd'], undefined)
  assert.equal(invalidated.snapshotSources['ssh-readd'], undefined)
  assert.equal(invalidated.readySources.has('ssh-readd'), false)

  // Unrelated sources survive byte-for-byte, and the helper never mutates the
  // caller's snapshot while deriving the authoritative transition.
  assert.equal(invalidated.failuresBySource['ssh-keep'], 1)
  assert.equal(invalidated.snapshotAtBySource['ssh-keep'], 2_000)
  assert.equal(invalidated.snapshotSources['ssh-keep'], true)
  assert.equal(invalidated.readySources.has('ssh-keep'), true)
  assert.equal(original.readySources.has('ssh-readd'), true)

  // A re-added pull gets a fresh object owner without retaining the removed
  // id in the active table.
  assert.equal(requestOwners.size, 0)
  const readdedOwner = requestOwners.renew('ssh-readd')
  assert.notEqual(readdedOwner, oldDeferredOwner)
  assert.equal(requestOwners.owns(oldDeferredOwner), false)
})

test('authoritative removal retires every keyed/view owner before a rapid same-id re-add', () => {
  const removed = new Set(['ssh-readd'])
  const mounted = ['local', 'ssh-readd', 'ssh-keep']
  const prewarmQueue = ['ssh-readd', 'ssh-keep']
  const keyed = {
    local: { generation: 1 },
    'ssh-readd': { generation: 7 },
    'ssh-keep': { generation: 2 },
  }

  const retiredMounted = withoutRemovedSourceIds(mounted, removed)
  const retiredPrewarm = withoutRemovedSourceIds(prewarmQueue, removed)
  const retiredKeyed = withoutRemovedSourceKeys(keyed, removed)

  assert.deepEqual(retiredMounted, ['local', 'ssh-keep'])
  assert.deepEqual(retiredPrewarm, ['ssh-keep'])
  assert.deepEqual(retiredKeyed, {
    local: { generation: 1 },
    'ssh-keep': { generation: 2 },
  })
  assert.equal(retireSelectedSource('ssh-readd', removed, 'local'), 'local')
  assert.equal(retireSelectedSource('ssh-readd', removed, null), null)

  // The following authoritative re-add only restores roster membership. It
  // cannot resurrect any old state owner; a new mount/producer must do that.
  const readdedRoster = new Set(['local', 'ssh-readd', 'ssh-keep'])
  assert.equal(readdedRoster.has('ssh-readd'), true)
  assert.equal(retiredMounted.includes('ssh-readd'), false)
  assert.equal(Object.hasOwn(retiredKeyed, 'ssh-readd'), false)

  // Inputs are immutable snapshots, so sibling owners and the caller's old
  // generation remain untouched while the transition is derived.
  assert.deepEqual(mounted, ['local', 'ssh-readd', 'ssh-keep'])
  assert.equal(keyed['ssh-readd'].generation, 7)
})

test('presentation-only same-id edit carrying no retired delta preserves renderer owners', () => {
  const noRemoval = new Set<string>()
  const mounted = ['local', 'ssh-edit']
  const keyed = { 'ssh-edit': 3 }

  assert.equal(withoutRemovedSourceIds(mounted, noRemoval), mounted)
  assert.equal(withoutRemovedSourceKeys(keyed, noRemoval), keyed)
  assert.equal(retireSelectedSource('ssh-edit', noRemoval, 'local'), 'ssh-edit')
})

test('authoritative removal delta survives two pulls that both observe the final same-id re-add', () => {
  const liveBefore = new Set(['local', 'ssh-readd'])
  // Pull A (remove) and pull B (re-add) can both resolve with this same final
  // roster, so snapshot differencing alone observes no removal.
  const finalRosterSeenByBothPulls = new Set(['local', 'ssh-readd'])
  assert.deepEqual(
    [...liveBefore].filter(sourceId => !finalRosterSeenByBothPulls.has(sourceId)),
    [],
  )

  const removalDelta = remoteRetiredSourceIds(['readd', 'readd'])
  // A raw registry generation can previously have owned either canonical v2
  // source id, or the legacy ssh-prefixed compatibility view. Retirement must
  // synchronously fence all three owners before a same-id re-add.
  assert.deepEqual([...removalDelta], ['dsh-readd', 'gateway-readd', 'ssh-readd'])
  const invalidated = invalidateRemovedAggregateSources(
    liveBefore,
    new Set([...liveBefore].filter(sourceId => !removalDelta.has(sourceId))),
    {
      failuresBySource: { 'ssh-readd': 2 },
      snapshotAtBySource: { 'ssh-readd': 100 },
      snapshotSources: { 'ssh-readd': true },
      readySources: new Set(['ssh-readd']),
    },
  )
  assert.deepEqual(invalidated.removedSourceIds, ['ssh-readd'])
  assert.equal(invalidated.snapshotSources['ssh-readd'], undefined)

  // Presentation-only edits carry no retired ids and preserve the ctx.
  assert.equal(remoteRetiredSourceIds([]).size, 0)
})

// ---- archiveSetShrink / shouldRequestSessionListRefresh (design 24 §12:
// purge-completed signal + official session-list refresh coalescing) ----

test('archiveSetShrink returns exactly the ids a known ok aggregate lost to the next known snapshot', () => {
  const previous = okAggregate(['a1', 'a2', 'a3'])
  assert.deepEqual(
    archiveSetShrink(previous, { archivedSessionIds: ['a1', 'a3'], archiveSetKnown: true }),
    ['a2'],
  )
  // A full removal and an empty-next case both shrink.
  assert.deepEqual(archiveSetShrink(previous, { archivedSessionIds: [], archiveSetKnown: true }), ['a1', 'a2', 'a3'])
  // Same set or additions only = no shrink (no unarchive wire, but a registry
  // re-seed could re-add; additions must never trigger).
  assert.deepEqual(archiveSetShrink(previous, { archivedSessionIds: ['a1', 'a2', 'a3', 'a4'], archiveSetKnown: true }), [])
  assert.deepEqual(archiveSetShrink(previous, { archivedSessionIds: ['a1', 'a2', 'a3'], archiveSetKnown: true }), [])
})

test('archiveSetShrink never triggers from unknown provenance or non-ok aggregates', () => {
  // The unary fallback's EMPTY unknown set is a known-degraded artifact, never
  // a shrink fact.
  assert.deepEqual(archiveSetShrink(okAggregate(['a1']), { archivedSessionIds: [], archiveSetKnown: false }), [])
  assert.deepEqual(archiveSetShrink(undefined, { archivedSessionIds: ['a1'], archiveSetKnown: true }), [])
  // A legacy aggregate without the provenance flag stays untrusted.
  assert.deepEqual(archiveSetShrink(okAggregate(['a1'], false), { archivedSessionIds: [], archiveSetKnown: true }), [])
  const notConnected: InstanceAggregate = okAggregate([], true, { state: 'not-connected' })
  assert.deepEqual(archiveSetShrink(notConnected, { archivedSessionIds: [], archiveSetKnown: true }), [])
  const errorState: InstanceAggregate = okAggregate([], true, { state: 'error', error: 'x' })
  assert.deepEqual(archiveSetShrink(errorState, { archivedSessionIds: [], archiveSetKnown: true }), [])
})

test('shouldRequestSessionListRefresh opens on absent history and reopens only past the coalescing gap', () => {
  assert.equal(shouldRequestSessionListRefresh(undefined, 1_000, 5_000), true)
  assert.equal(shouldRequestSessionListRefresh(0, 1_000, 5_000), false)
  assert.equal(shouldRequestSessionListRefresh(1_000, 5_999, 5_000), false)
  assert.equal(shouldRequestSessionListRefresh(1_000, 6_000, 5_000), true)
})

// ---- planSessionListRefresh (design 24 §12 ghost-row convergence machine) ----

const snapshotWithRows = (archivedSessionIds: string[], rowIds: string[], archiveSetKnown = true): InstanceSnapshot => ({
  workspaces: [],
  sessions: rowIds.map(sessionId => sessionRow(sessionId)),
  archivedSessionIds,
  archiveSetKnown,
})

test('planSessionListRefresh: a shrink whose rows are still listed requests convergence and keeps them pending', () => {
  const previous = okAggregate(['a1', 'a2', 'a3'])
  const next = snapshotWithRows(['a1', 'a3'], ['s0', 'a2', 'a3', 's1'])
  const decision = planSessionListRefresh(previous, next, undefined)
  assert.equal(decision.request, true)
  assert.deepEqual(decision.pending, ['a2'])
  // Converged push: the rows of a2 are gone → pending cleared, no request.
  const converged = snapshotWithRows(['a1', 'a3'], ['s0', 'a3', 's1'])
  assert.deepEqual(planSessionListRefresh(previous, converged, decision.pending), { request: false, pending: [] })
})

test('planSessionListRefresh: a shrink whose rows are already gone (refreshed elsewhere) never requests', () => {
  const previous = okAggregate(['a1', 'a2'])
  const next = snapshotWithRows(['a1'], ['s0', 'a1'])
  assert.deepEqual(planSessionListRefresh(previous, next, undefined), { request: false, pending: [] })
})

test('planSessionListRefresh: carried pending ids re-request while still listed and clear once gone', () => {
  const previous = okAggregate(['a1']) // shrink already committed in an earlier push
  // No NEW shrink here — the previous push already removed a2 from the set.
  const same = snapshotWithRows(['a1'], ['s0', 'a2'])
  assert.deepEqual(planSessionListRefresh(previous, same, ['a2']), { request: true, pending: ['a2'] })
  assert.deepEqual(planSessionListRefresh(previous, same, ['a2', 'ghost-unknown']), { request: true, pending: ['a2'] })
  // Rows vanished without this push seeing a shrink (generation change /
  // host restart) → converged by observation.
  const gone = snapshotWithRows(['a1'], ['s0'])
  assert.deepEqual(planSessionListRefresh(previous, gone, ['a2']), { request: false, pending: [] })
})

test('planSessionListRefresh: a new shrink unioned with carried pending dedupes and orders removed-first', () => {
  const previous = okAggregate(['a1', 'a2', 'a3', 'a4'])
  const next = snapshotWithRows(['a2', 'a4'], ['a1', 'a2', 's0'])
  // New shrink removes a1 and a3; a2 (pending carried from an earlier run,
  // still listed) rides along; a3 has no row and a4 is still archived.
  const decision = planSessionListRefresh(previous, next, ['a2', 'a3'])
  assert.deepEqual(decision.pending, ['a1', 'a2'])
  assert.equal(decision.request, true)
})

test('planSessionListRefresh: unknown provenance or non-ok previous never requests and drains carried pending only by row absence', () => {
  // Unknown NEXT (degraded full commit) → no shrink contribution, but carried
  // pending still drains when its rows leave the snapshot.
  const degradedNext = { ...snapshotWithRows([], ['s0']), archiveSetKnown: false }
  assert.deepEqual(planSessionListRefresh(okAggregate(['a1']), degradedNext, undefined), { request: false, pending: [] })
  assert.deepEqual(planSessionListRefresh(okAggregate(['a1']), degradedNext, ['a1']), { request: false, pending: [] })
  const degradedWithRow = { ...snapshotWithRows([], ['s0', 'a1']), archiveSetKnown: false }
  assert.deepEqual(planSessionListRefresh(okAggregate(['a1']), degradedWithRow, ['a1']), { request: true, pending: ['a1'] })
  // Legacy previous without the provenance flag: never a shrink source, but
  // carried pending semantics are unaffected (untrusted shrink only).
  const legacy = okAggregate(['a1', 'a2'], false)
  assert.deepEqual(planSessionListRefresh(legacy, snapshotWithRows(['a2'], ['a2']), undefined), { request: false, pending: [] })
  const notConnected: InstanceAggregate = okAggregate([], true, { state: 'not-connected' })
  assert.deepEqual(planSessionListRefresh(notConnected, snapshotWithRows(['a2'], ['s0', 'a2']), ['a2']), { request: true, pending: ['a2'] })
})

// ---- design 24 §12: remembered authoritative archive set ----

test('archiveSetShrink: a remembered authoritative set is the baseline when the committed aggregate lost provenance', () => {
  const fallbackView = okAggregate([], false)
  assert.deepEqual(
    archiveSetShrink(fallbackView, { archivedSessionIds: ['keep'], archiveSetKnown: true }, ['g1', 'g2', 'keep']),
    ['g1', 'g2'],
  )
  // No memory and no provenance -> no shrink (the conservative rule).
  assert.deepEqual(archiveSetShrink(fallbackView, { archivedSessionIds: [], archiveSetKnown: true }), [])
  // A non-authoritative next snapshot never shrinks, memory or not.
  assert.deepEqual(
    archiveSetShrink(fallbackView, { archivedSessionIds: [], archiveSetKnown: false }, ['g1']),
    [],
  )
  // A committed authoritative aggregate still wins over the memory.
  assert.deepEqual(
    archiveSetShrink(okAggregate(['a1', 'a2']), { archivedSessionIds: ['a2'], archiveSetKnown: true }, ['zzz']),
    ['a1'],
  )
})

test('planSessionListRefresh: a remembered baseline makes a shrink observable from a degraded view', () => {
  const degraded = okAggregate([], false)
  const push = { archivedSessionIds: [] as string[], archiveSetKnown: true, sessions: [sessionRow('g1')] }
  assert.deepEqual(planSessionListRefresh(degraded, push, undefined), { request: false, pending: [] })
  assert.deepEqual(
    planSessionListRefresh(degraded, push, undefined, ['g1']),
    { request: true, pending: ['g1'] },
  )
})

test('commitAggregatePull: a degraded full commit carries the remembered archive set without claiming provenance', () => {
  const fallback = { ...fallbackSnapshot, archiveSetKnown: false }
  const committed = commitAggregatePull(undefined, fallback, false, ['archived-1', 'archived-2'])
  assert.equal(committed.state, 'ok')
  assert.deepEqual(committed.archivedSessionIds, ['archived-1', 'archived-2'])
  // Provenance stays FALSE: the remembered set is a rendering aid, never an
  // authority (the archive manager must keep its degraded branch).
  assert.equal(committed.archiveSetKnown, false)
  // The fallback's synthetic groups and rows still ride along.
  assert.deepEqual(committed.sessions, fallback.sessions)
})

test('commitAggregatePull: without a remembered set the degraded commit stays byte-identical to the old behaviour', () => {
  assert.deepEqual(
    commitAggregatePull(undefined, fallbackSnapshot, false),
    { state: 'ok', ...fallbackSnapshot, error: null },
  )
})

test('commitAggregatePull: the remembered set never leaks into the mounted merge branch', () => {
  const authoritative = { ...mountedAggregate, archiveSetKnown: true }
  const merged = commitAggregatePull(authoritative, fallbackSnapshot, true, ['remembered-x'])
  assert.deepEqual(merged.archivedSessionIds, authoritative.archivedSessionIds)
  assert.equal(merged.archiveSetKnown, true)
})

// ---- 保留视图的「无法验证」界限（design 05 §2.3）----

test('shouldDropUnverifiedRunningFacts: 从未验证过就没有断言可丢（fail-open，不误伤首拉）', () => {
  assert.equal(shouldDropUnverifiedRunningFacts({ factsAt: undefined, now: 1_000_000 }), false)
})

test('shouldDropUnverifiedRunningFacts: 界限内不丢（瞬时失败不得清掉运行环）', () => {
  assert.equal(
    shouldDropUnverifiedRunningFacts({ factsAt: 1_000_000, now: 1_000_000 + 89_999 }),
    false,
  )
})

test('shouldDropUnverifiedRunningFacts: 恰好到界即丢（边界含等号，与 90s 文档口径一致）', () => {
  assert.equal(
    shouldDropUnverifiedRunningFacts({ factsAt: 1_000_000, now: 1_000_000 + 90_000 }),
    true,
  )
  assert.equal(AGGREGATE_UNVERIFIED_FACTS_MS, 90_000, '生产界限 = 90s（≈3 个 30s watchdog 周期）')
})

test('shouldDropUnverifiedRunningFacts: budgetMs 可注入（测试与未来调参用）', () => {
  assert.equal(
    shouldDropUnverifiedRunningFacts({ factsAt: 0, now: 5_000, budgetMs: 5_000 }),
    true,
  )
  assert.equal(
    shouldDropUnverifiedRunningFacts({ factsAt: 0, now: 4_999, budgetMs: 5_000 }),
    false,
  )
})

// ---- shouldReconnectStaleMounted (watchdog reconnect of stale MOUNTED
// sources — 对齐 ssh 断链自动恢复; see aggregate-refresh.ts). The predicate
// takes `mounted` as a CALLER-DEFINED flag (the App passes "pushed at least
// once this generation"); these tests exercise the pure predicate with
// explicit values. The App wiring (transport-axis filter, record-then-fire,
// backoff recording only on an actual reconnect) is not unit-tested here —
// see shell.ts reconnectInstanceConnection and the App.tsx watchdog. ----

const STALENESS_MS = 30_000
const BACKOFF_MS = 60_000
const NOW = 1_000_000

function decide(partial: {
  mounted?: boolean
  lastSnapshotAt?: number | undefined
  lastReconnectAt?: number | undefined
  now?: number
  stalenessMs?: number
  reconnectBackoffMs?: number
}): boolean {
  return shouldReconnectStaleMounted({
    mounted: partial.mounted ?? true,
    lastSnapshotAt: partial.lastSnapshotAt,
    lastReconnectAt: partial.lastReconnectAt,
    now: partial.now ?? NOW,
    stalenessMs: partial.stalenessMs ?? STALENESS_MS,
    reconnectBackoffMs: partial.reconnectBackoffMs ?? BACKOFF_MS,
  })
}

test('shouldReconnectStaleMounted: unmounted sources never reconnect (no shell connection to restart — unary fallback owns them)', () => {
  assert.equal(decide({ mounted: false, lastSnapshotAt: undefined }), false)
  assert.equal(decide({ mounted: false, lastSnapshotAt: NOW - STALENESS_MS - 1 }), false)
  // Even with the backoff fully elapsed an unmounted source is excluded.
  assert.equal(decide({ mounted: false, lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: NOW - BACKOFF_MS - 1 }), false)
})

test('shouldReconnectStaleMounted: a mounted source that never pushed is stale and reconnectable', () => {
  assert.equal(decide({ lastSnapshotAt: undefined }), true)
})

test('shouldReconnectStaleMounted: a recent push keeps the source fresh (no reconnect)', () => {
  assert.equal(decide({ lastSnapshotAt: NOW - 1 }), false)
  // Exactly at the staleness threshold is still fresh (isSnapshotStale is strict).
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS }), false)
})

test('shouldReconnectStaleMounted: silence past the threshold reconnects when no attempt is recorded', () => {
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: undefined }), true)
})

test('shouldReconnectStaleMounted: a recent reconnect holds off the next attempt (backoff window)', () => {
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: NOW - 1 }), false)
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: NOW - BACKOFF_MS + 1 }), false)
})

test('shouldReconnectStaleMounted: the backoff elapses at the boundary and reconnects resume', () => {
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: NOW - BACKOFF_MS }), true)
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: NOW - BACKOFF_MS - 1 }), true)
})

test('shouldReconnectStaleMounted: a fresh push after a reconnect clears staleness before the backoff matters', () => {
  // The reconnect healed the push channel: a new snapshot arrived, so the
  // source is fresh even though the last reconnect was recent.
  assert.equal(decide({ lastSnapshotAt: NOW - 1, lastReconnectAt: NOW - 1 }), false)
})

// ---- reconnectStalenessMsForTransport (per-transport
// watchdog thresholds — http tight heal, ssh last-resort heal, local/unknown
// skipped). ----

test('reconnect threshold: http keeps the tight heal, ssh gets the long last-resort heal', () => {
  assert.equal(reconnectStalenessMsForTransport('http'), AGGREGATE_RECONNECT_HTTP_STALE_MS)
  assert.equal(reconnectStalenessMsForTransport('ssh'), AGGREGATE_RECONNECT_SSH_STALE_MS)
  assert.equal(AGGREGATE_RECONNECT_HTTP_STALE_MS, 120_000)
  assert.equal(AGGREGATE_RECONNECT_SSH_STALE_MS, 300_000)
  // The ssh arm exists only as a last resort behind three independent tunnel
  // detectors (proxy 30s WS ping / host mux 2s×2 / ssh keepalive ~90s), so its
  // threshold MUST stay strictly longer than the http one — otherwise idle
  // healthy ssh sources would pay a baseline replay at the http cadence.
  assert.ok(AGGREGATE_RECONNECT_SSH_STALE_MS > AGGREGATE_RECONNECT_HTTP_STALE_MS)
  // Both stay well above the 30s unary pull threshold (the arm is an addition
  // to the pull, never a replacement).
  assert.ok(AGGREGATE_RECONNECT_HTTP_STALE_MS > 30_000)
  assert.ok(AGGREGATE_RECONNECT_SSH_STALE_MS > 30_000)
})

test('reconnect threshold: local and unknown transports are never touched by the arm', () => {
  for (const transport of ['local', undefined, null, '', 'tcp', 7, {}]) {
    assert.equal(reconnectStalenessMsForTransport(transport), null, String(transport))
  }
})
