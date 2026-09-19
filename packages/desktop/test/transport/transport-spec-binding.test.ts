/**
 * Transport instance spec semantics — merged suite (2026-12 test
 * reorganization). Both sources pin the SAME contract chain (design 17 §9.1
 * credential ownership): which spec fields make two connections "the same
 * target" and therefore keep or invalidate a stored credential.
 *
 * Sources (both were package-root tests; now one file):
 *   - transport-target.test.ts    — transportTargetChanged compatibility
 *     semantics + canonicalizeTransportInstanceInput.
 *   - credential-binding.test.ts  — the gateway/ssh credential binding keys.
 *
 * Merge note: the two sources each defined an identical-purpose spec()
 * fixture builder with different defaults; both are kept verbatim but named
 * targetSpec() and credentialSpec() so they can coexist. Test titles and
 * assertion semantics are unchanged.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeTransportInstanceInput, transportTargetChanged } from '../../transport-provider.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'
import { gatewayCredentialBinding, sshCredentialBinding } from '../../credential-binding.ts'

// --- merged from test/transport/transport-target.test.ts ---
function targetSpec(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
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
  assert.equal(transportTargetChanged(targetSpec({ label: 'prod' }), targetSpec({ label: 'renamed' })), false)
})
test('host change is a target change', () => {
  assert.equal(transportTargetChanged(targetSpec(), targetSpec({ host: 'other.example.com' })), true)
})
test('user / sshPort / remotePort / serviceName / remoteDshHome changes are target changes', () => {
  assert.equal(transportTargetChanged(targetSpec(), targetSpec({ user: 'admin' })), true)
  assert.equal(transportTargetChanged(targetSpec(), targetSpec({ sshPort: 2222 })), true)
  assert.equal(transportTargetChanged(targetSpec(), targetSpec({ remotePort: 18000 })), true)
  assert.equal(transportTargetChanged(targetSpec(), targetSpec({ serviceName: 'dsh' })), true)
  assert.equal(transportTargetChanged(targetSpec(), targetSpec({ remoteDshHome: '/srv/dsh' })), true)
})
test('kind change is a target change (caller excludes it from the clear decision)', () => {
  assert.equal(transportTargetChanged(
    targetSpec(),
    targetSpec({ kind: 'gateway', transport: 'http', sshPort: null, user: null, serviceName: null, remoteDshHome: null }),
  ), true)
})
test('transport change (ssh↔http) is NOT a target change — the credential binds to the host:port:kind target, not the mechanism (design 17 §9.1)', () => {
  assert.equal(transportTargetChanged(targetSpec(), targetSpec({ transport: 'http' })), false)
  assert.equal(transportTargetChanged(
    targetSpec({ kind: 'gateway', transport: 'http', sshPort: null, user: null, serviceName: null, remoteDshHome: null }),
    targetSpec({ kind: 'gateway', transport: 'ssh', sshPort: null, user: null, serviceName: null, remoteDshHome: null }),
  ), false)
})
test('insecureHttp change (http↔https) is NOT a target change — protocol switch keeps credentials (design 17 §9.1, D3)', () => {
  assert.equal(transportTargetChanged(targetSpec(), targetSpec({ insecureHttp: true })), false)
})
test('identical specs are not a target change', () => {
  const a = targetSpec()
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

// --- merged from test/transport/credential-binding.test.ts ---
function credentialSpec(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'prod', label: 'Prod', kind: 'gateway', transport: 'ssh', host: 'gw.example.com',
    user: 'alice', sshPort: 22, remotePort: 443, serviceName: 'dsh', remoteDshHome: null,
    insecureHttp: false, ...overrides,
  }
}
test('gateway binding follows only kind + host + remotePort', () => {
  const base = gatewayCredentialBinding(credentialSpec())
  assert.equal(gatewayCredentialBinding(credentialSpec({ transport: 'http', user: null, sshPort: null, serviceName: null, insecureHttp: true })), base)
  assert.equal(gatewayCredentialBinding(credentialSpec({ spkiPin: 'ab'.repeat(32) })), base)
  assert.notEqual(gatewayCredentialBinding(credentialSpec({ host: 'other.example.com' })), base)
  assert.notEqual(gatewayCredentialBinding(credentialSpec({ remotePort: 8443 })), base)
  assert.equal(gatewayCredentialBinding(credentialSpec({ kind: 'dsh' })), null)
})
test('SSH binding follows only host + user + sshPort', () => {
  const base = sshCredentialBinding(credentialSpec())
  assert.equal(sshCredentialBinding(credentialSpec({ kind: 'dsh', remotePort: 18000, serviceName: null })), base)
  assert.notEqual(sshCredentialBinding(credentialSpec({ host: 'other.example.com' })), base)
  assert.notEqual(sshCredentialBinding(credentialSpec({ user: 'root' })), base)
  assert.notEqual(sshCredentialBinding(credentialSpec({ sshPort: 2222 })), base)
  assert.equal(sshCredentialBinding(credentialSpec({ transport: 'http' })), null)
})

