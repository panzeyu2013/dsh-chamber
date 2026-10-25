/**
 * Local serviceability gate: `degraded` is still serving (design 02 §3.5) and
 * must keep local aggregate polling alive; `starting`/`restarting` must not.
 * The remote transport arm stays strict (`ready` only): its `degraded` phase is
 * a reconnect state, not a serving fact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { instanceConnected, isServiceableLocalStatus } from '../../src/transport-source.ts'
import type { HealthResponse } from '../../src/api.ts'

const health = (status: string): HealthResponse => ({ ok: true, dsh: { status, port: 17510 } }) as HealthResponse

test('isServiceableLocalStatus: ready and degraded only', () => {
  assert.equal(isServiceableLocalStatus('ready'), true)
  assert.equal(isServiceableLocalStatus('degraded'), true)
  for (const state of ['starting', 'restarting', 'stopped', 'error', 'restart-exhausted']) {
    assert.equal(isServiceableLocalStatus(state), false, state)
  }
  assert.equal(isServiceableLocalStatus(undefined), false)
})

test('instanceConnected: local degraded still polls; local starting does not', () => {
  assert.equal(instanceConnected('local', health('degraded'), {}, 'local'), true)
  assert.equal(instanceConnected('local', health('ready'), {}, 'local'), true)
  assert.equal(instanceConnected('local', health('starting'), {}, 'local'), false)
})

test('instanceConnected: remote transport degraded is still not connected', () => {
  assert.equal(instanceConnected('gateway', null, { gw: { kind: 'gateway', phase: 'degraded' } } as never, 'gw'), false)
  assert.equal(instanceConnected('gateway', null, { gw: { kind: 'gateway', phase: 'ready' } } as never, 'gw'), true)
})
