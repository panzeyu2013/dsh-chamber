/**
 * Per-source registry - behavior contract.
 *
 * The registry's job is the FENCE, so these tests are about identity and epochs:
 * a re-registration with the same fingerprint keeps the record, a fingerprint change
 * is a new epoch (no inherited penalties), and a stale event is dropped. The
 * projections are tested as the exact shapes the App's refs have today.
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
