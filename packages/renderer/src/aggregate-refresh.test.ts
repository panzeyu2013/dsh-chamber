import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AggregateRefreshQueue,
  commitAggregateFailure,
  commitAggregatePull,
  invalidateRemovedAggregateSources,
  isSnapshotStale,
  planAggregateRefreshes,
  refreshPullStillCurrent,
  remoteRetiredSourceIds,
  retireSelectedSource,
  withoutRemovedSourceIds,
  withoutRemovedSourceKeys,
} from './aggregate-refresh.ts'
import { SourceOwnershipRegistry } from './deep-link-activation.ts'
import {
  instanceBasePath,
  isChamberSourceId,
  rawInstanceIdFromSourceId,
  sourceIdForInstance,
  sourceIdForRawInstance,
} from './transport-source.ts'
import type { InstanceAggregate, InstanceSnapshot } from '@dsh-chamber/dsh-client-ui-sidebar/shared'

// ---- commitAggregatePull (2026-09 beta regression: archived-resurfacing) ----

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
  sessions: [{ sessionId: 's1', running: true, blank: false }],
  archivedSessionIds: ['archived-1', 'archived-2'],
  error: null,
}

const fallbackSnapshot: InstanceSnapshot = {
  workspaces: [{ workspaceId: '__cwd__:/real', path: '/real', title: 'Real', sessionIds: ['s1'], createdAt: '', updatedAt: '', synthetic: true }],
  sessions: [{ sessionId: 's1', running: false, blank: false }, { sessionId: 'archived-1', running: false, blank: false }],
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

test('commitAggregatePull: never-pushed / unmounted sources keep the full degraded fallback commit', () => {
  const committed = commitAggregatePull(undefined, fallbackSnapshot, false)
  assert.deepEqual(committed, { state: 'ok', ...fallbackSnapshot, error: null })
  assert.deepEqual(committed.archivedSessionIds, [])
})

test('commitAggregatePull: a mounted source without an ok aggregate falls back to the full commit (not-connected/error are authoritative states)', () => {
  const notConnected: InstanceAggregate = { state: 'not-connected', workspaces: [], sessions: [], archivedSessionIds: [], error: null }
  const committed = commitAggregatePull(notConnected, fallbackSnapshot, true)
  assert.deepEqual(committed, { state: 'ok', ...fallbackSnapshot, error: null })
})

test('commitAggregatePull: mounted × error-state current and mounted × never-committed (undefined) both take the full commit', () => {
  const errorState: InstanceAggregate = {
    state: 'error',
    workspaces: [],
    sessions: [],
    archivedSessionIds: [],
    error: 'transient',
  }
  assert.deepEqual(commitAggregatePull(errorState, fallbackSnapshot, true), { state: 'ok', ...fallbackSnapshot, error: null })
  assert.deepEqual(commitAggregatePull(undefined, fallbackSnapshot, true), { state: 'ok', ...fallbackSnapshot, error: null })
})

test('commitAggregatePull: an all-synthetic current (last commit came from the fallback) keeps receiving full commits — never freezes the degraded view', () => {
  const syntheticCurrent: InstanceAggregate = {
    state: 'ok',
    workspaces: [{ workspaceId: '__cwd__:/real', path: '/real', title: 'Real', sessionIds: ['s1'], createdAt: '', updatedAt: '', synthetic: true }],
    sessions: [{ sessionId: 's1', running: false, blank: false }],
    archivedSessionIds: [],
    error: null,
  }
  const committed = commitAggregatePull(syntheticCurrent, fallbackSnapshot, true)
  assert.deepEqual(committed, { state: 'ok', ...fallbackSnapshot, error: null })
})

test('commitAggregatePull: ANY synthetic row marks the current as fallback-derived (mixed sets — unreachable by construction — stay on full commits)', () => {
  const mixedCurrent: InstanceAggregate = {
    state: 'ok',
    workspaces: [
      { workspaceId: 'w-real', path: '/real', title: 'Real', sessionIds: ['s1'], createdAt: 't0', updatedAt: 't1' },
      { workspaceId: '__cwd__:/other', path: '/other', title: 'Other', sessionIds: ['s2'], createdAt: '', updatedAt: '', synthetic: true },
    ],
    sessions: [{ sessionId: 's1', running: true, blank: false }, { sessionId: 's2', running: false, blank: false }],
    archivedSessionIds: ['archived-1'],
    error: null,
  }
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
  const emptyWorkspaces: InstanceAggregate = {
    state: 'ok',
    workspaces: [],
    sessions: [{ sessionId: 's1', running: true, blank: false }],
    archivedSessionIds: ['archived-1'],
    error: null,
  }
  const committed = commitAggregatePull(emptyWorkspaces, fallbackSnapshot, true)
  assert.deepEqual(committed.workspaces, [])
  assert.deepEqual(committed.archivedSessionIds, ['archived-1'])
})

test('commitAggregatePull: identical sessions keep the aggregate identity stable (watchdog re-pulls cause no churn)', () => {
  const current: InstanceAggregate = {
    state: 'ok',
    workspaces: mountedAggregate.workspaces,
    sessions: [{ sessionId: 's1', running: true, blank: false }],
    archivedSessionIds: mountedAggregate.archivedSessionIds,
    error: null,
  }
  const fallbackWithSameSessions: InstanceSnapshot = {
    ...fallbackSnapshot,
    sessions: [{ sessionId: 's1', running: true, blank: false }],
  }
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
  // commit preserves the mounted groups/archive — the archived-resurfacing
  // regression is impossible end to end.
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

// ---- refresh pull validity domains (2026-10: create/fork latency fix) ----

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
