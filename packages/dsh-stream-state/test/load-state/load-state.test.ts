/**
 * Pure core: the shell's load state machine.
 *
 * These cases pin the generation fence and the THREE real-machine failure modes
 * the machine exists to prevent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  contentIsBelievable,
  initialLoadState,
  loadIsLate,
  reduceLoadState,
  type LoadEnv,
  type LoadEvent,
  type LoadState,
} from '../../src/index.ts'

const ENV: LoadEnv = { probeStrikeLimit: 3, retryLimit: 2, progressSlaMs: 15_000 }

function run(state: LoadState, events: readonly LoadEvent[], env: LoadEnv = ENV) {
  let current = state
  const effects: string[] = []
  for (const event of events) {
    const reduction = reduceLoadState(current, event, env)
    current = reduction.state
    for (const effect of reduction.effects) effects.push(effect.e)
  }
  return { state: current, effects }
}

test('defect 1: a NEW generation re-enters cold — the latch has a reset point', () => {
  // The retired boolean latched forever: once didStartLoading was set, a later
  // sidecar generation could never be seen as loading again.
  const first = run(initialLoadState(), [
    { kind: 'generationStarted', generation: 1, at: 0 },
    { kind: 'loadStarted', generation: 1, at: 10 },
    { kind: 'contentAlive', generation: 1, at: 20 },
  ])
  assert.equal(first.state.phase, 'loaded')
  const restarted = run(first.state, [{ kind: 'generationStarted', generation: 2, at: 100 }])
  assert.equal(restarted.state.phase, 'cold', 'a new generation starts over')
  const reloading = run(restarted.state, [{ kind: 'loadStarted', generation: 2, at: 110 }])
  assert.equal(reloading.state.phase, 'loading', 'and it may load again (no permanent latch)')
})

test('the generation fence drops stale events', () => {
  const { state } = run(initialLoadState(), [
    { kind: 'generationStarted', generation: 5, at: 0 },
    { kind: 'probeFailed', generation: 4, at: 10 },
    { kind: 'contentAlive', generation: 4, at: 11 },
  ])
  assert.equal(state.probeStrikes, 0, 'a superseded generation cannot inject a strike')
  assert.equal(state.phase, 'cold', 'nor claim content')
})

test('defect 2: content is only believable through the predicate, not a flag', () => {
  const cold = initialLoadState()
  assert.equal(contentIsBelievable(cold), false, 'cold shell has no believable content')
  const probing = run(cold, [{ kind: 'generationStarted', generation: 1, at: 0 }, { kind: 'loadStarted', generation: 1, at: 1 }]).state
  assert.equal(contentIsBelievable(probing), false, 'a committed load is not content')
  const loaded = run(probing, [{ kind: 'contentAlive', generation: 1, at: 2 }]).state
  assert.equal(contentIsBelievable(loaded), true)
  const retrying = run(loaded, [
    { kind: 'probeFailed', generation: 1, at: 3 },
    { kind: 'probeFailed', generation: 1, at: 4 },
    { kind: 'probeFailed', generation: 1, at: 5 },
  ]).state
  assert.equal(retrying.phase, 'retrying')
  assert.equal(contentIsBelievable(retrying), false, 'retrying is not content')
})

test('defect 3: a failed probe is a strike, never a success', () => {
  const base = run(initialLoadState(), [{ kind: 'generationStarted', generation: 1, at: 0 }]).state
  const one = run(base, [{ kind: 'probeFailed', generation: 1, at: 10 }])
  assert.equal(one.state.phase, 'cold', 'one strike does not make it healthy')
  assert.equal(one.state.probeStrikes, 1)
  const atLimit = run(base, [
    { kind: 'probeFailed', generation: 1, at: 10 },
    { kind: 'probeFailed', generation: 1, at: 11 },
    { kind: 'probeFailed', generation: 1, at: 12 },
  ])
  assert.equal(atLimit.state.phase, 'retrying')
  assert.ok(atLimit.effects.includes('scheduleRecovery'), 'the strike limit schedules recovery')
  const recovered = run(atLimit.state, [{ kind: 'probeSucceeded', generation: 1, at: 20 }])
  assert.equal(recovered.state.probeStrikes, 0, 'a success clears the strikes')
})

test('the give-up gate is one-shot per generation', () => {
  const retrying = run(initialLoadState(), [
    { kind: 'generationStarted', generation: 1, at: 0 },
    { kind: 'recoveryScheduled', generation: 1, at: 10 },
  ]).state
  const first = run(retrying, [{ kind: 'recoveryFailed', generation: 1, at: 20 }])
  assert.equal(first.state.phase, 'failurePage')
  assert.deepEqual(first.effects, ['showFailurePage'])
  const second = run(first.state, [{ kind: 'recoveryFailed', generation: 1, at: 30 }])
  assert.deepEqual(second.effects, ['log'], 'the page is not re-announced (only a log line)')
  const nextGeneration = run(first.state, [
    { kind: 'generationStarted', generation: 2, at: 40 },
    { kind: 'recoveryScheduled', generation: 2, at: 41 },
    { kind: 'recoveryFailed', generation: 2, at: 42 },
  ])
  assert.deepEqual(nextGeneration.effects, ['log', 'showFailurePage'], 'a new generation earns its own gate')
})

test('crash recovery clears only when content is honestly alive', () => {
  const crashed = run(initialLoadState(), [
    { kind: 'generationStarted', generation: 1, at: 0 },
    { kind: 'recoveryScheduled', generation: 1, at: 10 },
  ])
  assert.equal(crashed.state.recoveringFromCrash, true)
  const alive = run(crashed.state, [{ kind: 'contentAlive', generation: 1, at: 20 }])
  assert.equal(alive.state.recoveringFromCrash, false, 'content ends the recovery')
})

test('the progress SLA is a predicate, not an action', () => {
  const loading = run(initialLoadState(), [
    { kind: 'generationStarted', generation: 1, at: 0 },
    { kind: 'loadStarted', generation: 1, at: 1_000 },
  ]).state
  assert.equal(loadIsLate(loading, 1_000 + ENV.progressSlaMs, ENV), false, 'the boundary is not late')
  assert.equal(loadIsLate(loading, 1_001 + ENV.progressSlaMs, ENV), true)
  const idle = initialLoadState()
  assert.equal(loadIsLate(idle, 10_000_000, ENV), false, 'a shell that is not loading is never late')
})
