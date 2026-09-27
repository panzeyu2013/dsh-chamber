/**
 * The single gateway managed-dsh restart action the connection card calls: the
 * refusal projection, the 202 acceptance, and the readiness poll that decides
 * whether the success note is honest. PluginDialog restarts through its own
 * IPC seed path, not this action.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts';
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

test('runManagedRestart: a 202 whose readiness poll settles is served (the seam feeds both legs)', async () => {
  const seen: string[] = []
  const outcome = await runManagedRestart('gateway-x', tZh, {
    fetchImpl: async (_input, init) => {
      seen.push(init?.method ?? 'GET')
      return init?.method === 'POST'
        ? new Response(null, { status: 202 })
        : jsonResponse(200, { connectionState: 'ready', restart: 'ok' })
    },
  })
  assert.deepEqual(outcome, { kind: 'served' })
  assert.deepEqual(seen, ['POST', 'GET'], 'the POST then the readiness poll both ride the injected fetch')
})

test('runManagedRestart: a 202 that never becomes ready is accepted-timeout, not served', async () => {
  let calls = 0
  const outcome = await runManagedRestart('gateway-x', tZh, {
    fetchImpl: async (_input, init) => {
      calls += 1
      return init?.method === 'POST'
        ? new Response(null, { status: 202 })
        : jsonResponse(200, { connectionState: 'connecting' })
    },
    pollIntervalMs: 0,
    timeoutMs: 10,
  })
  assert.deepEqual(outcome, { kind: 'accepted-timeout' })
  assert.ok(calls >= 2, 'the readiness poll must ride the injected fetch (without it this returns slowly and green)')
})

test('ConnectionsSection keeps both 202 legs wired (poll → honest note)', () => {
  const src = stripComments(readFileSync(new URL('../../src/client/ConnectionsSection.tsx', import.meta.url), 'utf8'))
  assert.match(src, /await pollGatewayReady\(id, \{ action: 'start' \}\)/,
    'the start leg readiness poll is gone: a bare 202 would read as success')
  assert.match(src, /outcome\.kind === 'served'/,
    'the restart served→ok note mapping is gone')
  assert.match(src, /outcome\.kind === 'accepted-timeout'/,
    'the restart accepted-timeout note mapping is gone')
  assert.match(src, /cls\.kind === 'accepted-timeout'/,
    'the start accepted-timeout note mapping is gone')
})

test('runManagedRestart: the readiness poll follows the restart table, not the start table', async () => {
  // This payload is where the two tables disagree: restart:'failed' is a failure for a restart,
  // while a start would read `start` (undefined) and resolve on connectionState 'ready' — so a
  // mis-wired action would turn this honest failure into a false 'served'.
  const outcome = await runManagedRestart('gateway-x', tZh, {
    fetchImpl: async (_input, init) => init?.method === 'POST'
      ? new Response(null, { status: 202 })
      : jsonResponse(200, { connectionState: 'ready', restart: 'failed', operationError: 'spawn denied' }),
  })
  assert.deepEqual(outcome, { kind: 'failed', detail: 'restart failed: spawn denied' })
})
