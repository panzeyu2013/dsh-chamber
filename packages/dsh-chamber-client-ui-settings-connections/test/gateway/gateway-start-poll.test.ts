/**
 * Shared gateway readiness poll — the START action (design 21 §6.3 decision 12
 * + §6.8 r1). The poll used to follow `restart` only: the card's「启动实例」
 * flow fed it a start 202 and got restart wording back ("restart failed: …"),
 * never read the contract's `start` outcome field (gateway/runtime-manager.ts
 * GatewayRuntimeStatus.start: 'ok' | 'failed' | 'running' | null), and would
 * have fast-failed a legitimate start at its very first answer — a start BEGINS
 * from connectionState 'stopped', which the restart decision table treats as a
 * terminal failure. Fake fetch, no DOM, no dsh.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollGatewayReady } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

type StatusPayload = Record<string, unknown>

/** A fetch that replays one payload per call (the last one repeats). */
function replayFetch(payloads: StatusPayload[]): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0
  const fetchImpl = (async () => {
    const payload = payloads[Math.min(calls, payloads.length - 1)]!
    calls += 1
    return { status: 200, json: async () => payload }
  }) as unknown as typeof fetch
  return { fetchImpl, calls: () => calls }
}

/** assert.rejects with an anchored message match: 'restart failed:' CONTAINS
 *  'start failed:', so a substring match would accept the old wording. */
async function rejectsWithStartFailure(run: Promise<void>, expected: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    assert.match(message, /^start failed: /u, 'a start failure must never be worded as a restart failure')
    assert.equal(message, `start failed: ${expected}`)
    return true
  })
}

const START = { action: 'start' } as const

test('start: the start outcome field decides — failed is a start failure, ok settles', async () => {
  // A post-202 entry rejection: the manager records start:'failed' +
  // operationError while connectionState can still read 'ready'.
  const entryRejected = replayFetch([
    { connectionState: 'ready', start: 'failed', operationError: 'start-exhausted: recover with start()' },
  ])
  await rejectsWithStartFailure(
    pollGatewayReady('gateway-x', undefined, { ...START, fetchImpl: entryRejected.fetchImpl, pollIntervalMs: 0, timeoutMs: 5_000 }),
    'start-exhausted: recover with start()',
  )

  // start:'ok' settles even when the connectionState projection lags behind.
  const started = replayFetch([{ connectionState: 'starting', start: 'ok' }])
  await pollGatewayReady('gateway-x', undefined, { ...START, fetchImpl: started.fetchImpl, pollIntervalMs: 0, timeoutMs: 5_000 })
})

test('start: a start BEGINS from stopped — that state is not a terminal failure for the start action', async () => {
  // Answer 1 is the honest first read after the 202 (start running, still
  // stopped); the old restart table would have thrown 'restart failed:
  // unknown restart failure' right here.
  const progressing = replayFetch([
    { connectionState: 'stopped', start: 'running', operationError: null },
    { connectionState: 'ready', start: 'ok' },
  ])
  await pollGatewayReady('gateway-x', undefined, { ...START, fetchImpl: progressing.fetchImpl, pollIntervalMs: 0, timeoutMs: 5_000 })
  assert.equal(progressing.calls(), 2, 'the poll waits through the stopped→ready transition')

  // error / restart-exhausted are terminal for a start too.
  for (const terminal of ['error', 'restart-exhausted'] as const) {
    const failed = replayFetch([{ connectionState: terminal, start: 'running', operationError: `landed ${terminal}` }])
    await rejectsWithStartFailure(
      pollGatewayReady('gateway-x', undefined, { ...START, fetchImpl: failed.fetchImpl, pollIntervalMs: 0, timeoutMs: 5_000 }),
      `landed ${terminal}`,
    )
  }
})

test('start: config errors and the timeout are worded for a start', async () => {
  const unauthorized = (async () => ({ status: 401, json: async () => ({}) })) as unknown as typeof fetch
  await rejectsWithStartFailure(
    pollGatewayReady('gateway-x', undefined, { ...START, fetchImpl: unauthorized, pollIntervalMs: 0, timeoutMs: 9_000 }),
    'unauthorized (401) — check the gateway token',
  )

  const stuck = (async () => ({ status: 500, json: async () => ({}) })) as unknown as typeof fetch
  await assert.rejects(
    pollGatewayReady('gateway-x', undefined, { ...START, fetchImpl: stuck, pollIntervalMs: 0, timeoutMs: 10 }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /^start accepted but the gateway did not reach ready in time$/u)
      return true
    },
  )
})

test('restart keeps its own decision table (the start action must not leak into it)', async () => {
  const failedFetch = (async () => ({
    status: 200,
    json: async () => ({ connectionState: 'restart-exhausted', operationError: 'spawn denied' }),
  })) as unknown as typeof fetch
  // Anchored on error.message: `assert.rejects` matches a RegExp against the
  // error's string form ('Error: …'), and 'restart failed' contains
  // 'start failed' — a substring match could not tell the two apart.
  const restartFailed = (error: unknown): boolean => {
    assert.equal(error instanceof Error ? error.message : String(error), 'restart failed: spawn denied')
    return true
  }
  await assert.rejects(
    pollGatewayReady('gateway-x', undefined, { action: 'restart', fetchImpl: failedFetch, pollIntervalMs: 0, timeoutMs: 5_000 }),
    restartFailed,
  )

  // The restart default is unchanged for callers that pass no action at all
  // (PluginDialog, DshRuntimeSection).
  await assert.rejects(
    pollGatewayReady('gateway-x', undefined, { fetchImpl: failedFetch, pollIntervalMs: 0, timeoutMs: 5_000 }),
    restartFailed,
  )
})
