/**
 * transportTargetChanged compatibility-semantic tests. The helper compares
 * the old whole execution target (kind, host, user, ports, service and home)
 * while excluding transport/scheme/SPKI. Credential ownership no longer uses
 * it: the main save transaction has independent gateway and SSH fingerprints.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeTransportInstanceInput, transportTargetChanged } from './transport-provider.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

function spec(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'ssh-1',
    label: 'prod',
    kind: 'dsh',
    transport: 'ssh',
    host: 'example.com',
    user: 'root',
    sshPort: 22,
    remotePort: 17500,
    serviceName: null,
    remoteDshHome: null,
    insecureHttp: false,
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
  assert.equal(transportTargetChanged(
    spec(),
    spec({ kind: 'gateway', transport: 'http', sshPort: null, user: null, serviceName: null, remoteDshHome: null }),
  ), true)
})

test('transport change (ssh↔http) is NOT a target change — the credential binds to the host:port:kind target, not the mechanism (design 17 §9.1)', () => {
  assert.equal(transportTargetChanged(spec(), spec({ transport: 'http' })), false)
  assert.equal(transportTargetChanged(
    spec({ kind: 'gateway', transport: 'http', sshPort: null, user: null, serviceName: null, remoteDshHome: null }),
    spec({ kind: 'gateway', transport: 'ssh', sshPort: null, user: null, serviceName: null, remoteDshHome: null }),
  ), false)
})

test('insecureHttp change (http↔https) is NOT a target change — protocol switch keeps credentials (design 17 §9.1, D3)', () => {
  assert.equal(transportTargetChanged(spec(), spec({ insecureHttp: true })), false)
})

test('identical specs are not a target change', () => {
  const a = spec()
  assert.equal(transportTargetChanged(a, { ...a }), false)
})

test('canonical input normalization keeps the typed optional-transport IPC contract', () => {
  assert.deepEqual(canonicalizeTransportInstanceInput({ id: 'a', kind: 'dsh' }), {
    id: 'a', kind: 'dsh', transport: 'ssh',
  })
  assert.deepEqual(canonicalizeTransportInstanceInput({ id: 'b', kind: 'gateway' }), {
    id: 'b', kind: 'gateway', transport: 'http',
  })
  assert.deepEqual(canonicalizeTransportInstanceInput({ id: 'c', kind: 'ssh' }), {
    id: 'c', kind: 'dsh', transport: 'ssh',
  })
  assert.deepEqual(canonicalizeTransportInstanceInput({ id: 'd' }), {
    id: 'd', kind: 'dsh', transport: 'ssh',
  })
  assert.deepEqual(canonicalizeTransportInstanceInput({ id: 'e', kind: 'future-target' }), {
    id: 'e', kind: 'future-target', transport: undefined,
  }, 'future kinds stay unclaimed until a provider defines their default transport')
})
