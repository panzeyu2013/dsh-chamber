/**
 * Transport instance spec semantics. Pins the contract chain (design 17 §9.1
 * credential ownership): which spec fields make two connections "the same
 * target" and therefore keep or invalidate a stored credential. The
 * credential-ownership decision is carried by the binding fingerprints
 * asserted below.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gatewayCredentialTargetChanged,
  liveTransportIdentityChanged,
  sshCredentialEndpointChanged,
} from '../../credential-identity.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'
import { gatewayCredentialBinding, sshCredentialBinding } from '../../credential-binding.ts'

// --- gateway/ssh credential binding keys ---
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
test('identity predicates are single-sourced with the credential fingerprints (stage-2 lockstep)', () => {
  const base = credentialSpec()
  const livePatches: Array<Partial<TransportInstanceSpec>> = [
    { kind: 'dsh' }, { transport: 'http' }, { host: 'other.example.com' }, { user: 'bob' },
    { sshPort: 2222 }, { remotePort: 8443 }, { serviceName: 'other' }, { remoteDshHome: '/srv/dsh' },
    { insecureHttp: true }, { spkiPin: 'ab'.repeat(32) },
  ]
  for (const patch of livePatches) {
    assert.equal(liveTransportIdentityChanged(base, credentialSpec(patch)), true,
      'live transport identity must include ' + JSON.stringify(patch))
  }
  assert.equal(liveTransportIdentityChanged(base, credentialSpec({ label: 'renamed' })), false,
    'presentation-only fields never restart the transport')
  const sshPatches: Array<Partial<TransportInstanceSpec>> = [{ host: 'other.example.com' }, { user: 'bob' }, { sshPort: 2222 }]
  for (const patch of sshPatches) {
    const other = credentialSpec(patch)
    assert.equal(sshCredentialEndpointChanged(base, other),
      sshCredentialBinding(base) !== sshCredentialBinding(other),
      'the SSH predicate must agree with the SSH fingerprint for ' + JSON.stringify(patch))
  }
  assert.equal(sshCredentialEndpointChanged(base, credentialSpec({
    remotePort: 1, serviceName: null, remoteDshHome: '/x', label: 'x',
  })), false, 'forwarded port / service / home never retarget the password')
  const gatewayPatches: Array<Partial<TransportInstanceSpec>> = [{ host: 'other.example.com' }, { remotePort: 8443 }, { kind: 'dsh' }]
  for (const patch of gatewayPatches) {
    const other = credentialSpec(patch)
    assert.equal(gatewayCredentialTargetChanged(base, other),
      gatewayCredentialBinding(base) !== gatewayCredentialBinding(other),
      'the gateway predicate must agree with the gateway fingerprint for ' + JSON.stringify(patch))
  }
  assert.equal(gatewayCredentialTargetChanged(base, credentialSpec({
    insecureHttp: true, spkiPin: 'ab'.repeat(32), user: null, sshPort: null,
  })), false, 'scheme / pin / ssh-only metadata never retarget the gateway credential')
})

