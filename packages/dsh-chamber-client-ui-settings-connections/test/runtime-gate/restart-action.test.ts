/**
 * The single gateway managed-dsh restart action: the connection card and the
 * plugin dialog share the ONE action and its refusal projection; the 202
 * + page-owned poll leg needs a DOM/page harness and is covered by the parity
 * test's classifier lock plus the manual acceptance path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MANAGED_RESTART_REFUSAL_KEYS, runManagedRestart } from '../../src/client/restart-action.ts';
import { en, zh } from '../../src/locales.ts';
import type { RuntimeRefusalKey } from '../../src/client/managed-restart.ts';

const tZh = (key: RuntimeRefusalKey): string => zh[key]
const tEn = (key: RuntimeRefusalKey): string => en[key]

/** A response with a JSON body and the given status. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('runManagedRestart: the shared refusal keys are the restart family', () => {
  assert.deepEqual(MANAGED_RESTART_REFUSAL_KEYS, {
    notRunning: 'restartRefusedNotRunning',
    busy: 'restartRefusedBusy',
  })
})

test('runManagedRestart: a busy 409 renders the localized busy copy, never the server English', async () => {
  const outcome = await runManagedRestart('gateway-x', tZh, {
    fetchImpl: async () => jsonResponse(409, { error: 'a restart is already in flight', code: 'runtime_busy' }),
  })
  assert.deepEqual(outcome, { kind: 'refused', text: zh.restartRefusedBusy.replace('{code}', 'runtime_busy') })
  assert.doesNotMatch((outcome as { text: string }).text, /restart already/iu)
})

test('runManagedRestart: a not-running 409 points at the start action', async () => {
  const outcome = await runManagedRestart('gateway-x', tZh, {
    fetchImpl: async () => jsonResponse(409, {
      error: 'managed dsh is not running (stopped); start the managed dsh first',
      code: 'runtime_busy',
    }),
  })
  assert.deepEqual(outcome, { kind: 'refused', text: zh.restartRefusedNotRunning.replace('{code}', 'runtime_busy') })
})

test('runManagedRestart: a 409 without a code falls back to the numeric status inside the copy', async () => {
  const outcome = await runManagedRestart('gateway-x', tEn, {
    fetchImpl: async () => jsonResponse(409, { error: 'a restart is already in flight' }),
  })
  assert.deepEqual(outcome, { kind: 'refused', text: en.restartRefusedBusy.replace('{code}', '409') })
})

test('runManagedRestart: a non-409 refusal keeps the server reason verbatim (or the status)', async () => {
  const verbatim = await runManagedRestart('gateway-x', tZh, {
    fetchImpl: async () => jsonResponse(500, { error: 'gateway exploded' }),
  })
  assert.deepEqual(verbatim, { kind: 'refused', text: 'gateway exploded' })
  const bare = await runManagedRestart('gateway-x', tZh, {
    fetchImpl: async () => new Response('not json', { status: 503 }),
  })
  assert.deepEqual(bare, { kind: 'refused', text: 'restart refused (503)' })
})

test('runManagedRestart: the POST targets the per-instance proxy route', async () => {
  const calls: Array<{ url: string; method: string | undefined }> = []
  await runManagedRestart('gateway-a/b', tZh, {
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), method: init?.method })
      return jsonResponse(409, { code: 'runtime_busy' })
    },
  })
  assert.deepEqual(calls, [{ url: '/api/i/gateway-a/b/chamber/runtime/restart', method: 'POST' }])
})

test('runManagedRestart: a transport throw becomes a failed arm with its own detail', async () => {
  const outcome = await runManagedRestart('gateway-x', tZh, {
    fetchImpl: async () => { throw new Error('network down') },
  })
  assert.deepEqual(outcome, { kind: 'failed', detail: 'network down' })
})
