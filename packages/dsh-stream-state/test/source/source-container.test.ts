/**
 * Per-source registry - behavior contract.
 *
 * The registry's job is the FENCE, so these tests are about identity and epochs:
 * a re-registration with the same fingerprint keeps the record, a fingerprint change
 * is a new epoch (no inherited penalties), and a stale event is dropped. The epoch is
 * monotone per source id even across a retire -> re-entry cycle: the registry value
 * carries the high-water mark, so a retired generation's epoch can never come back and
 * pass the fence into a different generation. The projections are tested as the exact
 * shapes the App's refs have today.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  dispatchSource,
  epochOf,
  reincarnate,
  retainSourceIds,
  projectAbandonedTargets,
  projectAutoPrewarmed,
  projectDegradedRetried,
  projectPrewarmSuppressed,
} from '../../src/index.ts'
import type { SourceEnv, SourceIncarnation, SourceRegistry } from '../../src/index.ts'

const ENV: SourceEnv = { retryableGap: () => true }
const V1: SourceIncarnation = { sourceId: 'remote-1', fingerprint: 'fp-A' }

/** Omit that distributes over the SourceEvent union (plain Omit collapses it). */
type WithoutEpoch<T> = T extends unknown ? Omit<T, 'epoch'> : never
type Event = WithoutEpoch<Parameters<typeof dispatchSource>[2]>

/** Register the incarnation and replay events under its captured epoch. */
function run(registry: SourceRegistry, incarnation: SourceIncarnation, events: Event[]): SourceRegistry {
  let next = reincarnate(registry, incarnation)
  const epoch = epochOf(next, incarnation.sourceId)
  assert.ok(epoch !== undefined)
  for (const event of events) {
    next = dispatchSource(next, incarnation.sourceId, { ...event, epoch }, ENV).registry
  }
  return next
}

test('the key is the source id, and a new fingerprint bumps the epoch', () => {
  const first = reincarnate({}, V1)
  assert.equal(epochOf(first, 'remote-1'), 1)
  const second = reincarnate(first, { sourceId: 'remote-1', fingerprint: 'fp-B' })
  assert.equal(Object.keys(second).length, 1, 'one source id has exactly one live generation')
  assert.equal(second['remote-1']?.incarnation.fingerprint, 'fp-B')
  assert.equal(epochOf(second, 'remote-1'), 2)
  assert.equal(reincarnate(second, { sourceId: 'remote-1', fingerprint: 'fp-B' }), second, 'same fingerprint = same generation')
})

test('a same-fingerprint re-registration keeps the SAME record (the rules keep their meaning)', () => {
  const registry = run({}, V1, [
    { kind: 'bootSettled', outcome: 'booted' },
    { kind: 'phaseChanged', phase: 'ready' },
    { kind: 'prewarmStarted' },
  ])
  assert.equal(Object.keys(registry).length, 1, 'no second record for the same generation')
  const again = reincarnate(registry, V1)
  assert.equal(again, registry, 'same fingerprint = same registry reference and same state')
  assert.equal(again['remote-1']?.state.autoPrewarmed, true)
})

test('a NEW fingerprint starts clean (no inherited penalties)', () => {
  const first = run({}, V1, [
    { kind: 'prewarmStarted' },
    { kind: 'prewarmSuppressed' },
  ])
  assert.equal(first['remote-1']?.state.prewarmSuppressed, true)
  const second = reincarnate(first, { sourceId: 'remote-1', fingerprint: 'fp-B' })
  const fresh = second['remote-1']?.state
  assert.equal(fresh?.prewarmSuppressed, false, 'the new incarnation inherits nothing')
  assert.equal(fresh?.autoPrewarmed, false)
})

test('the projections are the EXACT shapes the App refs have today', () => {
  const registry = run({}, V1, [
    // The self-heal arm needs the source to be READY when a retryable degraded
    // settle lands (a degraded boot on a source that is still connecting must not
    // earn an automatic re-boot), so the phase comes first here on purpose.
    { kind: 'phaseChanged', phase: 'ready' },
    { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' },
    { kind: 'prewarmStarted' },
  ])
  assert.deepEqual(projectDegradedRetried(registry), { 'remote-1': true })
  assert.deepEqual([...projectAutoPrewarmed(registry)], ['remote-1'])
  assert.deepEqual([...projectPrewarmSuppressed(registry)], [])
  const suppressed = run({}, V1, [{ kind: 'prewarmSuppressed' }])
  assert.deepEqual([...projectPrewarmSuppressed(suppressed)], ['remote-1'])
})

test('the abandoned-target projection reproduces the VALUE, not just membership', () => {
  const marked = run({}, V1, [{ kind: 'abandoned', target: 'remote-9' }])
  assert.deepEqual([...projectAbandonedTargets(marked)], [['remote-1', 'remote-9']])
  const cleared = run(marked, V1, [{ kind: 'abandonmentCleared' }])
  assert.deepEqual([...projectAbandonedTargets(cleared)], [])
})

test('a stale-epoch event is dropped without rewriting the registry', () => {
  let registry = reincarnate({}, V1)
  const epoch = epochOf(registry, 'remote-1')
  assert.ok(epoch !== undefined)
  const reduction = dispatchSource(registry, 'remote-1', { kind: 'phaseChanged', phase: 'ready', epoch: epoch + 1 }, ENV)
  assert.equal(reduction.accepted, false)
  assert.equal(reduction.registry, registry, 'a dropped event must not even rewrite the registry')
  assert.deepEqual(reduction.effects, [])
})

test('retainSourceIds drops unregistered sources and keeps identity when nothing changed', () => {
  const registry = run({}, V1, [{ kind: 'phaseChanged', phase: 'ready' }])
  assert.equal(retainSourceIds(registry, new Set(['remote-1'])), registry, 'no change = same reference')
  const pruned = retainSourceIds(registry, new Set())
  assert.deepEqual(pruned, {})
})

test('a same-id re-entry after retirement does NOT reuse the retired epoch (new fingerprint)', () => {
  const born = reincarnate({}, V1)
  const oldEpoch = epochOf(born, 'remote-1')
  assert.ok(oldEpoch !== undefined)
  const retired = retainSourceIds(born, new Set())
  assert.deepEqual(retired, {}, 'the retired source leaves the public table')
  const reborn = reincarnate(retired, { sourceId: 'remote-1', fingerprint: 'fp-B' })
  const newEpoch = epochOf(reborn, 'remote-1')
  assert.ok(newEpoch !== undefined && newEpoch > oldEpoch,
    'the replacement must continue the source-id sequence: ' + String(oldEpoch) + ' -> ' + String(newEpoch))
  const stale = dispatchSource(reborn, 'remote-1', { kind: 'prewarmSuppressed', epoch: oldEpoch }, ENV)
  assert.equal(stale.accepted, false, "the retired generation's epoch must not pass the fence into the replacement")
  assert.equal(stale.registry, reborn, 'a rejected late event must not rewrite the registry')
  assert.deepEqual(stale.effects, [])
  assert.equal(reborn['remote-1']?.state.prewarmSuppressed, false, 'the late event must not land as a fact of the replacement')
})

test('a same-id re-entry after retirement advances the epoch even with the SAME fingerprint', () => {
  const born = run({}, V1, [{ kind: 'prewarmStarted' }])
  const oldEpoch = epochOf(born, 'remote-1')
  assert.ok(oldEpoch !== undefined)
  const retired = retainSourceIds(born, new Set())
  const reborn = reincarnate(retired, V1)
  const newEpoch = epochOf(reborn, 'remote-1')
  assert.ok(newEpoch !== undefined && newEpoch > oldEpoch,
    'the same fingerprint after retirement is a new life, and its epoch never goes backwards')
  assert.equal(reborn['remote-1']?.state.autoPrewarmed, false, 'the re-entry starts clean')
  assert.equal(dispatchSource(reborn, 'remote-1', { kind: 'prewarmSuppressed', epoch: oldEpoch }, ENV).accepted, false)
})

test('the high-water mark rides the registry value through dispatch and every retire cycle', () => {
  let registry = reincarnate({}, V1)
  const firstEpoch = epochOf(registry, 'remote-1')
  assert.ok(firstEpoch !== undefined)
  registry = dispatchSource(registry, 'remote-1', { kind: 'phaseChanged', phase: 'ready', epoch: firstEpoch }, ENV).registry
  const second = reincarnate(retainSourceIds(registry, new Set()), { sourceId: 'remote-1', fingerprint: 'fp-B' })
  const secondEpoch = epochOf(second, 'remote-1')
  assert.ok(secondEpoch !== undefined && secondEpoch > firstEpoch, 'a dispatch-created value must still carry the mark')
  const third = reincarnate(retainSourceIds(second, new Set()), { sourceId: 'remote-1', fingerprint: 'fp-C' })
  const thirdEpoch = epochOf(third, 'remote-1')
  assert.ok(thirdEpoch !== undefined && thirdEpoch > secondEpoch, 'each retire -> re-entry cycle continues the sequence')
  const unrelated = reincarnate(third, { sourceId: 'remote-2', fingerprint: 'fp-X' })
  assert.equal(epochOf(unrelated, 'remote-2'), 1, 'a source id keeps its own sequence')
})

test('the mark is the highest epoch EVER issued, including fingerprint bumps inside one live generation', () => {
  const first = reincarnate({}, V1)
  const second = reincarnate(first, { sourceId: 'remote-1', fingerprint: 'fp-B' })
  assert.equal(epochOf(second, 'remote-1'), 2)
  const third = reincarnate(retainSourceIds(second, new Set()), { sourceId: 'remote-1', fingerprint: 'fp-C' })
  assert.equal(epochOf(third, 'remote-1'), 3, 'the highest issued epoch is remembered, not just the retired entry')
})

test('the mark is carried by the value, not by module state', () => {
  const first = reincarnate({}, V1)
  const advanced = reincarnate(retainSourceIds(first, new Set()), V1)
  assert.equal(epochOf(advanced, 'remote-1'), 2)
  const independent = reincarnate({}, V1)
  assert.equal(epochOf(independent, 'remote-1'), 1,
    'a fresh registry value starts its own sequence: no module-level counter (purity)')
})

test('the hidden high-water mark never changes the public registry shape', () => {
  const registry = run({}, V1, [{ kind: 'phaseChanged', phase: 'ready' }])
  const pruned = retainSourceIds(registry, new Set())
  assert.deepEqual(pruned, {}, 'deepStrictEqual sees the empty live table')
  assert.deepEqual(Object.keys(pruned), [])
  assert.equal(JSON.stringify(pruned), '{}')
  assert.deepEqual(Object.keys({ ...pruned }), [], 'a spread copies the live table only')
  const live = retainSourceIds(registry, new Set(['remote-1']))
  assert.equal(live, registry, 'no change = same reference, mark included')
})

test('effects are returned with their source attached', () => {
  const registry = run({}, V1, [{ kind: 'phaseChanged', phase: 'ready' }])
  const epoch = epochOf(registry, 'remote-1')
  assert.ok(epoch !== undefined)
  const reduction = dispatchSource(registry, 'remote-1', {
    kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable', epoch,
  }, ENV)
  assert.deepEqual(reduction.effects, [{ sourceId: 'remote-1', effect: { e: 'degradedSelfHeal' } }])
  assert.equal(reduction.accepted, true)
})
