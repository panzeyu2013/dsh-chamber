/**
 * Incarnation fence gate (G-D) - one source id has exactly one live generation.
 *
 * WHY. The first container keyed records by (sourceId, fingerprint) but never
 * enforced that a dispatch used the current fingerprint: an event carrying a
 * superseded incarnation still reduced the old record and still emitted its
 * effects, and every projection walked ALL records of the id - so two incarnations
 * of one source showed through as a merged, contradictory view. The invariant is:
 * only the incarnation the registry currently lists is visible, and an event from
 * any other generation is dropped without an effect.
 *
 * The test drives the PUBLIC registry surface: reincarnate() is the only way a new
 * generation appears (it bumps the epoch), and dispatchSource() takes the epoch the
 * caller captured for its generation. Retirement does not weaken the fence: the epoch
 * is monotone per source id across a retire -> re-entry cycle (the registry value carries
 * the high-water mark), so a superseded generation cannot come back by numeric reuse.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  dispatchSource,
  epochOf,
  projectAutoPrewarmed,
  projectDegradedRetried,
  reincarnate,
  retainSourceIds,
} from '../../src/container.ts'
import type { SourceRegistry } from '../../src/container.ts'
import type { SourceEnv, SourceIncarnation } from '../../src/source.ts'

const ENV: SourceEnv = { retryableGap: (kind) => kind === 'graph-unavailable' }

const A: SourceIncarnation = { sourceId: 'remote-1', fingerprint: 'fp-A' }
const B: SourceIncarnation = { sourceId: 'remote-1', fingerprint: 'fp-B' }

/** Omit that distributes over the SourceEvent union (plain Omit collapses it). */
type WithoutEpoch<T> = T extends unknown ? Omit<T, 'epoch'> : never
type Event = WithoutEpoch<Parameters<typeof dispatchSource>[2]>

function apply(
  registry: SourceRegistry,
  sourceId: string,
  epoch: number,
  event: Event,
) {
  return dispatchSource(registry, sourceId, { ...event, epoch }, ENV)
}

test('only the current incarnation is visible to the projections', () => {
  // The retired life left a mark (autoPrewarmed) behind; the current life is clean.
  // A merged projection would show both.
  let registry = reincarnate({}, A)
  const epochA = epochOf(registry, 'remote-1')
  assert.ok(epochA !== undefined)
  registry = apply(registry, 'remote-1', epochA, { kind: 'prewarmStarted' }).registry
  registry = reincarnate(registry, B)
  assert.equal(projectAutoPrewarmed(registry).size, 0, 'a flag from the retired life leaked into the current projection')
  assert.deepEqual(projectDegradedRetried(registry), {}, 'a self-heal mark from the retired life leaked into the current projection')
})

test('an event dispatched to a superseded incarnation is dropped', () => {
  let registry = reincarnate({}, A)
  const epochA = epochOf(registry, 'remote-1')
  assert.ok(epochA !== undefined)
  registry = apply(registry, 'remote-1', epochA, { kind: 'phaseChanged', phase: 'ready' }).registry
  registry = reincarnate(registry, B)
  // The stale generation reports a retryable degraded settle: if it were accepted it
  // would emit a self-heal for the NEW generation.
  const stale = apply(registry, 'remote-1', epochA, {
    kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable',
  })
  assert.deepEqual(stale.effects, [], 'an effect from a superseded incarnation escaped the fence')
  assert.equal(stale.accepted, false)
  assert.equal(stale.registry, registry, 'a dropped event must not even rewrite the registry')
  assert.equal(projectAutoPrewarmed(stale.registry).size, 0)
})

test('retirement does not resurrect a superseded incarnation: the epoch is never reused', () => {
  // The fence must hold across a retire -> re-entry cycle too. The retired generation's
  // epoch is remembered (high-water mark carried by the registry value), so a late event
  // carrying it can never coincide numerically with the replacement's epoch.
  let registry = reincarnate({}, A)
  const epochA = epochOf(registry, 'remote-1')
  assert.ok(epochA !== undefined)
  registry = apply(registry, 'remote-1', epochA, { kind: 'prewarmStarted' }).registry
  registry = retainSourceIds(registry, new Set())
  assert.deepEqual(registry, {}, 'retirement empties the public table')
  registry = reincarnate(registry, B)
  const epochB = epochOf(registry, 'remote-1')
  assert.ok(epochB !== undefined && epochB > epochA,
    'the replacement epoch must be greater than the retired one: ' + String(epochA) + ' -> ' + String(epochB))
  const late = apply(registry, 'remote-1', epochA, {
    kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable',
  })
  assert.equal(late.accepted, false, 'a retired generation must not pass the fence into its replacement')
  assert.deepEqual(late.effects, [], 'a superseded incarnation must not emit effects for the replacement')
  assert.equal(late.registry, registry, 'a dropped event must not even rewrite the registry')
  assert.equal(projectAutoPrewarmed(late.registry).size, 0, 'the retired life is not visible through the replacement')
})

test('a re-entry with the SAME fingerprint is a new epoch, not a resurrected one', () => {
  let registry = reincarnate({}, A)
  const epochA = epochOf(registry, 'remote-1')
  assert.ok(epochA !== undefined)
  registry = apply(registry, 'remote-1', epochA, { kind: 'prewarmStarted' }).registry
  const same = reincarnate(retainSourceIds(registry, new Set()), A)
  const epochAgain = epochOf(same, 'remote-1')
  assert.ok(epochAgain !== undefined && epochAgain > epochA)
  assert.equal(same['remote-1']?.state.autoPrewarmed, false, 'the re-entry starts clean')
  assert.equal(apply(same, 'remote-1', epochA, { kind: 'prewarmStarted' }).accepted, false,
    'the pre-retirement epoch is fenced off from the clean re-entry')
})

test('the current incarnation still dispatches and projects normally', () => {
  let registry = reincarnate({}, A)
  const epochA = epochOf(registry, 'remote-1')
  assert.ok(epochA !== undefined)
  registry = apply(registry, 'remote-1', epochA, { kind: 'phaseChanged', phase: 'ready' }).registry
  const healed = apply(registry, 'remote-1', epochA, {
    kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable',
  })
  assert.deepEqual(healed.effects.map((entry) => entry.effect.e), ['degradedSelfHeal'], 'the live generation must dispatch')
  assert.equal(healed.accepted, true)
})

test('an event for an unregistered source is dropped', () => {
  const reduction = apply({}, 'ghost', 1, { kind: 'phaseChanged', phase: 'ready' })
  assert.equal(reduction.accepted, false)
  assert.deepEqual(reduction.effects, [])
  assert.deepEqual(reduction.registry, {})
})
