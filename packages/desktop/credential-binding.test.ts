import assert from 'node:assert/strict'
import test from 'node:test'
import { gatewayCredentialBinding, sshCredentialBinding } from './credential-binding.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

function spec(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'prod', label: 'Prod', kind: 'gateway', transport: 'ssh', host: 'gw.example.com',
    user: 'alice', sshPort: 22, remotePort: 443, serviceName: 'dsh', remoteDshHome: null,
    insecureHttp: false, ...overrides,
  }
}

test('gateway binding follows only kind + host + remotePort', () => {
  const base = gatewayCredentialBinding(spec())
  assert.equal(gatewayCredentialBinding(spec({ transport: 'http', user: null, sshPort: null, serviceName: null, insecureHttp: true })), base)
  assert.equal(gatewayCredentialBinding(spec({ spkiPin: 'ab'.repeat(32) })), base)
  assert.notEqual(gatewayCredentialBinding(spec({ host: 'other.example.com' })), base)
  assert.notEqual(gatewayCredentialBinding(spec({ remotePort: 8443 })), base)
  assert.equal(gatewayCredentialBinding(spec({ kind: 'dsh' })), null)
})

test('SSH binding follows only host + user + sshPort', () => {
  const base = sshCredentialBinding(spec())
  assert.equal(sshCredentialBinding(spec({ kind: 'dsh', remotePort: 18000, serviceName: null })), base)
  assert.notEqual(sshCredentialBinding(spec({ host: 'other.example.com' })), base)
  assert.notEqual(sshCredentialBinding(spec({ user: 'root' })), base)
  assert.notEqual(sshCredentialBinding(spec({ sshPort: 2222 })), base)
  assert.equal(sshCredentialBinding(spec({ transport: 'http' })), null)
})
