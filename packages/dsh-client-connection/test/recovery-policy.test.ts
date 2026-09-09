/**
 * Per-source recovery-timing policy unit tests (Batch 2 follow-up, 2026-09):
 * remote transports get the widened readiness deadline, everything else keeps
 * the upstream defaults.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REMOTE_GENERATION_READY_TIMEOUT_MS,
  REMOTE_GENERATION_READY_WARN_MS,
  recoveryOverridesForTransport,
} from '../src/client/recovery-policy.ts'

test('recovery policy: ssh and http sources get the widened readiness window', () => {
  for (const transport of ['ssh', 'http']) {
    assert.deepEqual(recoveryOverridesForTransport(transport), {
      generationReadyWarnMs: REMOTE_GENERATION_READY_WARN_MS,
      generationReadyTimeoutMs: REMOTE_GENERATION_READY_TIMEOUT_MS,
    }, transport)
  }
  assert.equal(REMOTE_GENERATION_READY_TIMEOUT_MS, 45_000)
  assert.equal(REMOTE_GENERATION_READY_WARN_MS, 5_000)
  // The widened deadline must stay strictly larger than the upstream default
  // (15 s) — a smaller value would defeat the whole point of the override.
  assert.ok(REMOTE_GENERATION_READY_TIMEOUT_MS > 15_000)
  assert.ok(REMOTE_GENERATION_READY_WARN_MS > 3_000)
})

test('recovery policy: local and unknown transports keep the upstream defaults', () => {
  for (const transport of ['local', undefined, null, '', 'tcp', 7, {}]) {
    assert.deepEqual(recoveryOverridesForTransport(transport), {}, JSON.stringify(transport) ?? 'undefined')
  }
})

test('recovery policy: the returned override object is a fresh plain object', () => {
  const first = recoveryOverridesForTransport('ssh')
  const second = recoveryOverridesForTransport('ssh')
  assert.notEqual(first, second, 'callers must not share a mutable object across entries')
  assert.deepEqual(first, second)
})
