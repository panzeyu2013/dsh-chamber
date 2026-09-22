/**
 * Incarnation fence gate (G-D) - one source id has exactly one live generation.
 *
 * WHY. The container keys records by (sourceId, fingerprint) but nothing ENFORCES
 * that a dispatch uses the current fingerprint: an event carrying a superseded
 * incarnation still reduces the old record and still emits its effects, and every
 * projection walks ALL records of the id - so two incarnations of one source show
 * through as a merged, contradictory view (a flag from the retired life, a hidden
 * window from the new one). The invariant is: only the incarnation the registry
 * currently lists is visible, and an event from any other generation is dropped
 * without an effect.
 *
 * The test drives the PUBLIC container surface. P4 replaces the keyed record with
 * an explicit source registry (sourceId -> { epoch, incarnation, state }); the
 * assertions here are the contract that migration must keep.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  dispatchSource,
  projectAutoPrewarmed,
  projectDegradedRetried,
  projectHiddenSince,
} from '../../src/container.ts'
import type { SourceEnv, SourceIncarnation, SourceLifecycleState } from '../../src/source.ts'

const ENV: SourceEnv = { reclaimGraceMs: 1_000, retryableGap: () => false }

const A: SourceIncarnation = { sourceId: 'remote-1', fingerprint: 'fp-A' }
const B: SourceIncarnation = { sourceId: 'remote-1', fingerprint: 'fp-B' }

function apply(
  states: Readonly<Record<string, SourceLifecycleState>>,
  incarnation: SourceIncarnation,
  event: Parameters<typeof dispatchSource>[2],
): { states: Readonly<Record<string, SourceLifecycleState>>; effects: ReadonlyArray<{ sourceId: string; effect: { e: string } }> } {
  return dispatchSource(states, incarnation, event, ENV)
}

test('only the current incarnation is visible to the projections', () => {
  // The retired life left a mark (autoPrewarmed) and a hidden window behind; the
  // current life is mounted and visible. A merged projection would show both.
  let states: Readonly<Record<string, SourceLifecycleState>> = {}
  states = apply(states, A, { kind: 'prewarmStarted' }).states
  states = apply(states, A, { kind: 'hidden', at: 100 }).states
  states = apply(states, B, { kind: 'mounted', at: 200 }).states
  assert.equal(projectAutoPrewarmed(states).size, 0, 'a flag from the retired life leaked into the current projection')
  assert.deepEqual(projectHiddenSince(states), {}, 'a hidden window from the retired life leaked into the current projection')
  assert.deepEqual(projectDegradedRetried(states), {}, 'a self-heal mark from the retired life leaked into the current projection')
})

test('an event dispatched to a superseded incarnation is dropped', () => {
  let states: Readonly<Record<string, SourceLifecycleState>> = {}
  states = apply(states, A, { kind: 'mounted', at: 10 }).states
  states = apply(states, B, { kind: 'mounted', at: 20 }).states
  // The stale generation asks for a mount: the current generation must not move.
  const stale = apply(states, A, { kind: 'userSelected', at: 30 })
  assert.deepEqual(stale.effects, [], 'an effect from a superseded incarnation escaped the fence')
  assert.equal(projectAutoPrewarmed(stale.states).size, 0)
  // A stale unmount must not hide the current generation either.
  const staleHidden = apply(states, A, { kind: 'hidden', at: 40 })
  assert.deepEqual(projectHiddenSince(staleHidden.states), {}, 'a stale hidden event shadowed the current generation')
})

test('the current incarnation still dispatches and projects normally', () => {
  let states: Readonly<Record<string, SourceLifecycleState>> = {}
  states = apply(states, A, { kind: 'mounted', at: 10 }).states
  const selected = apply(states, A, { kind: 'userSelected', at: 30 })
  assert.deepEqual(selected.effects.map((entry) => entry.effect.e), ['mount'], 'the live generation must dispatch')
  assert.equal(projectAutoPrewarmed(selected.states).size, 0)
})
