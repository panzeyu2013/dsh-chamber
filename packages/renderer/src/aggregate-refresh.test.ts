import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  invalidateRemovedAggregateSources,
  isSnapshotStale,
  planAggregateRefreshes,
  remoteRetiredSourceIds,
  retireSelectedSource,
  withoutRemovedSourceIds,
  withoutRemovedSourceKeys,
} from './aggregate-refresh.ts'
import { SourceOwnershipRegistry } from './deep-link-activation.ts'

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
  assert.deepEqual([...removalDelta], ['ssh-readd'])
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
