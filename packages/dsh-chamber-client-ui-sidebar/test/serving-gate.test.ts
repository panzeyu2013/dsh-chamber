/**
 * Wait-for-serving gate (2026-09-10, design 09 §3.2): the bounded ladder that
 * separates "the instance is still starting" from "the instance will never
 * serve" — the whole point of the gate is that the second case fails FAST.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isServingWindowFailure, waitForSourceServing } from '../src/shared/serving-gate.ts'
import type { ServingGateSource } from '../src/shared/serving-gate.ts'

const source = (over: Partial<ServingGateSource> = {}): ServingGateSource =>
  ({ id: 'local', phase: 'starting', connected: false, ...over })

/** A projection that walks through `frames`, repeating the last one. */
function sequence(frames: ServingGateSource[]) {
  let index = 0
  return () => {
    const frame = frames[Math.min(index, frames.length - 1)]
    index += 1
    return [frame]
  }
}

test('waitForSourceServing: a serving source resolves without sleeping', async () => {
  let slept = 0
  const served = await waitForSourceServing('local', {
    getSources: () => [source({ phase: 'ready', connected: true })],
    sleep: async () => { slept += 1 },
  })
  assert.equal(served, true)
  assert.equal(slept, 0)
})

test('waitForSourceServing: a cold start resolves once the source connects', async () => {
  const polls: number[] = []
  const served = await waitForSourceServing('local', {
    getSources: sequence([
      source({ phase: 'starting' }),
      source({ phase: 'starting' }),
      source({ phase: 'ready', connected: true }),
    ]),
    sleep: async ms => { polls.push(ms) },
    pollMs: 5,
  })
  assert.equal(served, true)
  assert.deepEqual(polls, [5, 5], 'poll the projection until it connects')
})

test('waitForSourceServing: a terminally down source fails fast', async () => {
  for (const phase of ['error', 'stopped', 'restart-exhausted']) {
    let slept = 0
    const served = await waitForSourceServing('local', {
      getSources: () => [source({ phase })],
      sleep: async () => { slept += 1 },
    })
    assert.equal(served, false, phase)
    assert.equal(slept, 0, `${phase} must never hold the caller`)
  }
})

test('waitForSourceServing: an unknown (retired) source fails fast', async () => {
  let slept = 0
  const served = await waitForSourceServing('ssh-gone', {
    getSources: () => [source()],
    sleep: async () => { slept += 1 },
  })
  assert.equal(served, false)
  assert.equal(slept, 0)
})

test('waitForSourceServing: a source that never serves stops at the deadline', async () => {
  let slept = 0
  const served = await waitForSourceServing('local', {
    getSources: () => [source({ phase: 'connecting' })],
    sleep: async () => { slept += 1 },
    timeoutMs: 0,
  })
  assert.equal(served, false)
  assert.equal(slept, 0, 'a zero budget must not sleep')
})

test('isServingWindowFailure: only the cold-start refusal classes are retryable', () => {
  assert.equal(isServingWindowFailure({ code: 'instance_unavailable', message: 'instance not ready' }), true)
  assert.equal(isServingWindowFailure({ code: 'dsh_not_ready', message: 'dsh is not ready' }), true)
  assert.equal(isServingWindowFailure({ message: 'upstream answered 503' }), true)
  for (const error of [
    { code: 'not_found', message: 'unknown method clientGraph/graph' },
    { code: 'unauthorized', message: 'browser auth required' },
    { code: 'instance-version-conflict', message: 'rev mismatch' },
    { message: 'fetch failed' },
    {},
  ]) {
    assert.equal(isServingWindowFailure(error), false, JSON.stringify(error))
  }
})
