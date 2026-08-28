/**
 * transportTargetChanged unit tests: a same-kind edit of host/user/ports must
 * be detected so the main process can invalidate provider-held credentials —
 * without this, an edit of host A→B would silently reuse A's SSH password /
 * gateway token against B (P1 regression). v2 (design 17 §2/§9.1): the
 * TARGET is {kind, host, user, ports, service, remoteDshHome} — BOTH the
 * transport method (ssh↔http) and the http↔https `insecureHttp` toggle are
 * NOT target changes: the credential is bound to the host:port:kind target,
 * never to the wire mechanism or transport (design 17 §9.1, D3 family), so
 * mechanism switches keep the credential valid. The LIVE transport still
 * restarts on a mechanism switch (transport-manager transportFieldsChanged),
 * but the secret survives — locked here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transportTargetChanged } from './transport-provider.ts'
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
