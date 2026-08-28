import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSnapshotStale, planAggregateRefreshes, refreshPullStillCurrent } from './aggregate-refresh.ts'
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
  // The pull starts after the mutation response, so its data always includes
  // the mutation. Frame-driven pushes bump the shared poll seq — the mutation
  // pull must ignore that and check only its own tag.
  assert.equal(refreshPullStillCurrent({
    mutationTag: 7,
    mutationSeq: 7,
    pollSeq: 42, // bumped by an interim host-frame push
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
  // The pull (tag 7) started while the source was ready (startedPollSeq 8);
  // the transport died and the sweep bumped BOTH domains to 9 — the late
  // tunnel answer must never resurrect the ok aggregate.
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
  // App.tsx writes mutationRefreshSeqRef before every tagged pull, so this
  // shape cannot occur — but if a future caller passes a tag without the ref
  // write, the pull must NOT commit (never resurrect a dead generation).
  assert.equal(refreshPullStillCurrent({
    mutationTag: 5,
    mutationSeq: undefined,
    pollSeq: 5,
    startedPollSeq: 5,
  }), false)
})
