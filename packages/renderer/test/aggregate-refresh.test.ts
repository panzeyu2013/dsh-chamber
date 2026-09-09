import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AggregateRefreshQueue,
  archiveSetShrink,
  commitAggregateFailure,
  commitAggregatePull,
  invalidateRemovedAggregateSources,
  isFallbackDerivedView,
  isSnapshotStale,
  planAggregateRefreshes,
  planSessionListRefresh,
  refreshPullStillCurrent,
  remoteRetiredSourceIds,
  retireSelectedSource,
  shouldRebaselineFallbackView,
  shouldRequestSessionListRefresh,
  shouldRetainPushedAggregate,
  withoutRemovedSourceIds,
  withoutRemovedSourceKeys,
} from '../src/aggregate-refresh.ts'
import { SourceOwnershipRegistry } from '../src/deep-link-activation.ts'
import {
  instanceBasePath,
  isChamberSourceId,
  rawInstanceIdFromSourceId,
  sourceIdForInstance,
  sourceIdForRawInstance,
} from '../src/transport-source.ts'
import type { InstanceAggregate, InstanceSnapshot } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

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

test('commitAggregatePull: the mounted merge preserves archive-set provenance (archiveSetKnown) — a mutation pull must never flip the archive manager into the degraded branch', () => {
  // Regression (2026 dev-QA): the manager's tri-state reads archiveSetKnown;
  // the unary fallback carries no archive wire source (fetchInstanceSnapshot
  // marks the set unknown). The merge used to drop the flag, so the first
  // requestRefresh pull after an archive action landed the source in the
  // degraded manager view ("无法列出已归档会话") until a reload.
  const authoritative: InstanceAggregate = {
    ...mountedAggregate,
    archiveSetKnown: true,
  }
  const merged = commitAggregatePull(authoritative, fallbackSnapshot, true)
  assert.equal(merged.archiveSetKnown, true, 'mounted merge keeps the authoritative provenance')
  assert.deepEqual(merged.archivedSessionIds, authoritative.archivedSessionIds)
  // An authoritative-but-EMPTY archive set must also stay "known" — [] is the
  // true "nothing archived" fact, never the degraded unknown state.
  const authoritativeEmpty: InstanceAggregate = {
    state: 'ok',
    workspaces: mountedAggregate.workspaces,
    sessions: [{ sessionId: 's1', running: true, blank: false }],
    archivedSessionIds: [],
    archiveSetKnown: true,
    error: null,
  }
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
    archiveSetKnown: true,
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

// ---- disconnect retention + fallback-view heal (2026-09: reconnect
// resurfaces archived conversations / clicks dead-end into the new-session
// view) ----

test('isFallbackDerivedView: only ok aggregates with synthetic rows are the degraded unary view', () => {
  assert.equal(isFallbackDerivedView(undefined), false)
  assert.equal(isFallbackDerivedView({ ...mountedAggregate }), false)
  assert.equal(isFallbackDerivedView({
    state: 'ok',
    workspaces: [],
    sessions: [],
    archivedSessionIds: [],
    error: null,
  }), false, 'an EMPTY workspace set is a legitimate mounted state, never synthetic')
  assert.equal(isFallbackDerivedView({
    state: 'not-connected',
    workspaces: [{ workspaceId: '__cwd__:/x', path: '/x', title: 'x', sessionIds: [], createdAt: '', updatedAt: '', synthetic: true }],
    sessions: [],
    archivedSessionIds: [],
    error: null,
  }), false, 'not-connected/error states are not an ok fallback VIEW')
  assert.equal(isFallbackDerivedView({
    state: 'ok',
    workspaces: [{ workspaceId: '__cwd__:/x', path: '/x', title: 'x', sessionIds: [], createdAt: '', updatedAt: '', synthetic: true }],
    sessions: [],
    archivedSessionIds: [],
    error: null,
  }), true)
})

test('shouldRetainPushedAggregate: a previously-pushed mounted source keeps its ok aggregate through a transport outage', () => {
  assert.equal(shouldRetainPushedAggregate(true, mountedAggregate), true)
  assert.equal(shouldRetainPushedAggregate(true, { ...mountedAggregate, archiveSetKnown: true }), true)
  // Legitimate empty workspaces (fresh mounted instance) stay retainable.
  assert.equal(shouldRetainPushedAggregate(true, {
    state: 'ok',
    workspaces: [],
    sessions: [],
    archivedSessionIds: [],
    error: null,
  }), true)
})

test('shouldRetainPushedAggregate: never-pushed / unmounted / degraded / non-ok currents are NOT retainable', () => {
  assert.equal(shouldRetainPushedAggregate(false, mountedAggregate), false, 'unmounted sources keep the fallback scope')
  assert.equal(shouldRetainPushedAggregate(true, undefined), false)
  assert.equal(shouldRetainPushedAggregate(true, { state: 'not-connected', workspaces: [], sessions: [], archivedSessionIds: [], error: null }), false)
  assert.equal(shouldRetainPushedAggregate(true, { state: 'error', workspaces: [], sessions: [], archivedSessionIds: [], error: 'x' }), false)
  // A current ALREADY degraded to the fallback view is not retainable — the
  // retention fix prevents NEW degraded views, it must not freeze existing ones.
  assert.equal(shouldRetainPushedAggregate(true, {
    state: 'ok',
    workspaces: [{ workspaceId: '__cwd__:/real', path: '/real', title: 'Real', sessionIds: ['s1'], createdAt: '', updatedAt: '', synthetic: true }],
    sessions: [{ sessionId: 's1', running: false, blank: false }],
    archivedSessionIds: [],
    error: null,
  }), false)
})

test('retention closes the ready-edge full-commit: a retained ok aggregate merges sessions-only (archive set survives the reconnect pull)', () => {
  // End-to-end shape of the 2026-09 fix: the aggregate that survived the
  // outage (state ok, real workspaces, archive set) meets the ready-edge
  // unary pull — the commit is the MOUNTED MERGE, never the full fallback.
  const committed = commitAggregatePull(mountedAggregate, fallbackSnapshot, true)
  assert.deepEqual(committed.archivedSessionIds, mountedAggregate.archivedSessionIds)
  assert.deepEqual(committed.workspaces, mountedAggregate.workspaces)
  assert.deepEqual(committed.sessions, fallbackSnapshot.sessions)
})

// ---- shouldRebaselineFallbackView (2026-09: heal a mounted source whose
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

// ---- archiveSetShrink / shouldRequestSessionListRefresh (design 24 §20:
// purge-completed signal + official session-list refresh coalescing) ----

const okAggregate = (archivedSessionIds: string[], archiveSetKnown = true): InstanceAggregate => ({
  state: 'ok',
  workspaces: [],
  sessions: [],
  archivedSessionIds,
  archiveSetKnown,
  error: null,
})

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
  const notConnected: InstanceAggregate = { state: 'not-connected', workspaces: [], sessions: [], archivedSessionIds: [], error: null }
  assert.deepEqual(archiveSetShrink(notConnected, { archivedSessionIds: [], archiveSetKnown: true }), [])
  const errorState: InstanceAggregate = { state: 'error', workspaces: [], sessions: [], archivedSessionIds: [], error: 'x' }
  assert.deepEqual(archiveSetShrink(errorState, { archivedSessionIds: [], archiveSetKnown: true }), [])
})

test('shouldRequestSessionListRefresh opens on absent history and reopens only past the coalescing gap', () => {
  assert.equal(shouldRequestSessionListRefresh(undefined, 1_000, 5_000), true)
  assert.equal(shouldRequestSessionListRefresh(0, 1_000, 5_000), false)
  assert.equal(shouldRequestSessionListRefresh(1_000, 5_999, 5_000), false)
  assert.equal(shouldRequestSessionListRefresh(1_000, 6_000, 5_000), true)
})

// ---- planSessionListRefresh (design 24 §20 ghost-row convergence machine) ----

const snapshotWithRows = (archivedSessionIds: string[], rowIds: string[], archiveSetKnown = true): InstanceSnapshot => ({
  workspaces: [],
  sessions: rowIds.map(sessionId => ({ sessionId, running: false, blank: false })),
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
  const notConnected: InstanceAggregate = { state: 'not-connected', workspaces: [], sessions: [], archivedSessionIds: [], error: null }
  assert.deepEqual(planSessionListRefresh(notConnected, snapshotWithRows(['a2'], ['s0', 'a2']), ['a2']), { request: true, pending: ['a2'] })
})
