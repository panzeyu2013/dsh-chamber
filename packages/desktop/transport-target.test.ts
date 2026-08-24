/**
 * transportTargetChanged unit tests: a same-kind edit of host/user/ports must
 * be detected so the main process can invalidate provider-held credentials —
 * without this, an edit of host A→B would silently reuse A's SSH password /
 * gateway token against B (P1 regression).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transportTargetChanged } from './transport-provider.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

function spec(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'ssh-1',
    label: 'prod',
    kind: 'ssh',
    host: 'example.com',
    user: 'root',
    sshPort: 22,
    remotePort: 17500,
    serviceName: null,
    remoteDshHome: null,
    ...overrides,
  }
}

test('label-only edits are not target changes', () => {
  assert.equal(transportTargetChanged(spec({ label: 'prod' }), spec({ label: 'renamed' })), false)
})

test('host change is a target change', () => {
  assert.equal(transportTargetChanged(spec(), spec({ host: 'other.example.com' })), true)
})

test('user / sshPort / remotePort / serviceName / remoteDshHome changes are target changes', () => {
  assert.equal(transportTargetChanged(spec(), spec({ user: 'admin' })), true)
  assert.equal(transportTargetChanged(spec(), spec({ sshPort: 2222 })), true)
  assert.equal(transportTargetChanged(spec(), spec({ remotePort: 18000 })), true)
  assert.equal(transportTargetChanged(spec(), spec({ serviceName: 'dsh' })), true)
  assert.equal(transportTargetChanged(spec(), spec({ remoteDshHome: '/srv/dsh' })), true)
})

test('kind change is a target change (caller excludes it from the clear decision)', () => {
  assert.equal(transportTargetChanged(spec({ kind: 'ssh' }), spec({ kind: 'gateway', sshPort: null, user: null, serviceName: null, remoteDshHome: null })), true)
})

test('identical specs are not a target change', () => {
  const a = spec()
  assert.equal(transportTargetChanged(a, { ...a }), false)
})
