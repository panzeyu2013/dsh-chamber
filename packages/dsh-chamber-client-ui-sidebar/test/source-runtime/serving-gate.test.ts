/**
 * Wait-for-serving gate (design 09 §3.2): the bounded ladder that separates "the instance is still
 * starting" from "the instance will never serve" — the whole point of the gate is that the second case fails FAST.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForSourceServing } from '@dsh-chamber/dsh-chamber-client-core'
import type { ServingGateSource } from '@dsh-chamber/dsh-chamber-client-core'

const source = (over: Partial<ServingGateSource> = {}): ServingGateSource => ({ id: 'local', phase: 'starting', connected: false, ...over })

/** A projection that walks through `frames`, repeating the last one. */
function sequence(frames: ServingGateSource[]) {
  let index = 0
  return () => [frames[Math.min(index++, frames.length - 1)]]
}

/** Run the gate with a counted sleep: the outcome plus the sleep delays it requested. */
function runGate(
  id: string,
  getSources: () => ServingGateSource[],
  extra: { pollMs?: number; timeoutMs?: number } = {},
): Promise<{ served: boolean; sleeps: number[] }> {
  const sleeps: number[] = []
  return waitForSourceServing(id, { getSources, sleep: async ms => { sleeps.push(ms) }, ...extra })
    .then(served => ({ served, sleeps }))
}

test('waitForSourceServing: a serving source resolves without sleeping', async () => {
  assert.deepEqual(await runGate('local', () => [source({ phase: 'ready', connected: true })]), { served: true, sleeps: [] })
})

test('waitForSourceServing: a cold start resolves once the source connects', async () => {
  const cold = sequence([source({ phase: 'starting' }), source({ phase: 'starting' }), source({ phase: 'ready', connected: true })])
  const { served, sleeps } = await runGate('local', cold, { pollMs: 5 })
  assert.equal(served, true)
  assert.deepEqual(sleeps, [5, 5], 'poll the projection until it connects')
})

test('waitForSourceServing: a terminally down source fails fast', async () => {
  for (const phase of ['error', 'stopped', 'restart-exhausted']) {
    assert.deepEqual(await runGate('local', () => [source({ phase })]), { served: false, sleeps: [] }, phase)
  }
})

test('waitForSourceServing: an unknown (retired) source fails fast', async () => {
  assert.deepEqual(await runGate('ssh-gone', () => [source()]), { served: false, sleeps: [] })
})

test('waitForSourceServing: a source that never serves stops at the deadline', async () => {
  assert.deepEqual(await runGate('local', () => [source({ phase: 'connecting' })], { timeoutMs: 0 }), { served: false, sleeps: [] },
    'a zero budget must not sleep')
})
