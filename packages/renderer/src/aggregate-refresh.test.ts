import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSnapshotStale, planAggregateRefreshes } from './aggregate-refresh.ts'
import {
  instanceBasePath,
  isChamberSourceId,
  rawInstanceIdFromSourceId,
  sourceIdForInstance,
  sourceIdForRawInstance,
} from './transport-source.ts'

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

test('transport source ids preserve the registry kind across N-ctx and proxy routing', () => {
  const instances = [
    { id: 'ssh-east', kind: 'ssh' as const },
    { id: 'edge-west', kind: 'gateway' as const },
  ]
  assert.equal(sourceIdForInstance(instances[0]), 'ssh-ssh-east')
  assert.equal(sourceIdForInstance(instances[1]), 'gateway-edge-west')
  assert.equal(sourceIdForRawInstance('edge-west', instances), 'gateway-edge-west')
  assert.equal(sourceIdForRawInstance('local', instances), 'local')
  assert.equal(sourceIdForRawInstance('missing', instances), null)
  assert.equal(rawInstanceIdFromSourceId('ssh-ssh-east'), 'ssh-east')
  assert.equal(rawInstanceIdFromSourceId('gateway-edge-west'), 'edge-west')
  assert.equal(rawInstanceIdFromSourceId('local'), null)
  assert.equal(instanceBasePath('gateway-edge-west'), '/api/i/gateway-edge-west')
})

test('chamber source-id validation accepts gateway but rejects unknown/malformed prefixes', () => {
  for (const sourceId of [undefined, 'local', 'ssh-east', 'gateway-west']) {
    assert.equal(isChamberSourceId(sourceId), true, String(sourceId))
  }
  for (const sourceId of ['', 'ssh-', 'gateway-', 'gateway-../east', 'http-east', '../gateway-east']) {
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
