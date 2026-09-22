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
 * caller captured for its generation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  dispatchSource,
  epochOf,
  projectAutoPrewarmed,
  projectDegradedRetried,
  projectHiddenSince,
  reincarnate,
} from '../../src/container.ts'
import type { SourceRegistry } from '../../src/container.ts'
import type { SourceEnv, SourceIncarnation } from '../../src/source.ts'

const ENV: SourceEnv = { reclaimGraceMs: 1_000, retryableGap: () => false }

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
  // The retired life left a mark (autoPrewarmed) and a hidden window behind; the
  // current life is mounted and visible. A merged projection would show both.
  let registry = reincarnate({}, A)
  const epochA = epochOf(registry, 'remote-1')
  assert.ok(epochA !== undefined)
  registry = apply(registry, 'remote-1', epochA, { kind: 'prewarmStarted' }).registry
  registry = apply(registry, 'remote-1', epochA, { kind: 'hidden', at: 100 }).registry
  registry = reincarnate(registry, B)
  assert.equal(projectAutoPrewarmed(registry).size, 0, 'a flag from the retired life leaked into the current projection')
  assert.deepEqual(projectHiddenSince(registry), {}, 'a hidden window from the retired life leaked into the current projection')
  assert.deepEqual(projectDegradedRetried(registry), {}, 'a self-heal mark from the retired life leaked into the current projection')
})

test('an event dispatched to a superseded incarnation is dropped', () => {
  let registry = reincarnate({}, A)
  const epochA = epochOf(registry, 'remote-1')
  assert.ok(epochA !== undefined)
  registry = apply(registry, 'remote-1', epochA, { kind: 'mounted', at: 10 }).registry
  registry = reincarnate(registry, B)
  // The stale generation asks for a mount: the current generation must not move.
  const stale = apply(registry, 'remote-1', epochA, { kind: 'userSelected', at: 30 })
  assert.deepEqual(stale.effects, [], 'an effect from a superseded incarnation escaped the fence')
  assert.equal(stale.accepted, false)
  assert.equal(stale.registry, registry, 'a dropped event must not even rewrite the registry')
  assert.equal(projectAutoPrewarmed(stale.registry).size, 0)
  // A stale unmount must not hide the current generation either.
  const staleHidden = apply(registry, 'remote-1', epochA, { kind: 'hidden', at: 40 })
  assert.deepEqual(projectHiddenSince(staleHidden.registry), {}, 'a stale hidden event shadowed the current generation')
})

test('the current incarnation still dispatches and projects normally', () => {
  let registry = reincarnate({}, A)
  const epochA = epochOf(registry, 'remote-1')
  assert.ok(epochA !== undefined)
  registry = apply(registry, 'remote-1', epochA, { kind: 'mounted', at: 10 }).registry
  const selected = apply(registry, 'remote-1', epochA, { kind: 'userSelected', at: 30 })
  assert.deepEqual(selected.effects.map((entry) => entry.effect.e), ['mount'], 'the live generation must dispatch')
  assert.equal(selected.accepted, true)
})

test('an event for an unregistered source is dropped', () => {
  const reduction = apply({}, 'ghost', 1, { kind: 'userSelected', at: 1 })
  assert.equal(reduction.accepted, false)
  assert.deepEqual(reduction.effects, [])
  assert.deepEqual(reduction.registry, {})
})
