import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DesktopSshSurface, SshInstanceInput, SshInstanceSpec } from '../global.d.ts'
import { formatGatewayUrl, parseGatewayUrl } from './gateway-url.ts'
import { clearSupersededTransportSecret, saveHostWithGatewayToken, saveHostWithPassword } from './save-host.ts'

const oldHost: SshInstanceSpec = {
  id: 'old', label: 'Old', kind: 'ssh', host: 'old.example.com', user: null,
  sshPort: null, remotePort: 30800, serviceName: null, remoteDshHome: null,
}
const newHost: SshInstanceInput = { id: 'new', label: 'New', host: 'new.example.com', remotePort: 30800 }
const savedNew: SshInstanceSpec = { ...newHost, kind: 'ssh', user: null, sshPort: null, serviceName: null, remoteDshHome: null }

type Bridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_password'>

test('saveHostWithPassword commits metadata and password on success', async () => {
  let setCalls = 0
  const bridge: Bridge = {
    instances_set: async () => { setCalls += 1; return [oldHost, savedNew] },
    instances_get: async () => [oldHost, savedNew],
    set_password: async () => ({ ok: true }),
  }
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, true)
  assert.equal(setCalls, 1)
})

test('saveHostWithPassword rolls metadata back when password persistence fails', async () => {
  let setCalls = 0
  const bridge: Bridge = {
    instances_set: async () => { setCalls += 1; return setCalls === 1 ? [oldHost, savedNew] : [oldHost] },
    instances_get: async () => [oldHost],
    set_password: async () => ({ error: 'password write failed' }),
  }
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.deepEqual(result, { ok: false, instances: [oldHost], error: 'password write failed', metadataCommitted: false })
  assert.equal(setCalls, 2)
})

test('saveHostWithPassword re-reads authoritative state when rollback rejects after taking effect', async () => {
  let setCalls = 0
  const bridge: Bridge = {
    instances_set: async () => {
      setCalls += 1
      if (setCalls === 1) return [oldHost, savedNew]
      throw new Error('password cleanup failed after registry rollback')
    },
    instances_get: async () => [oldHost],
    set_password: async () => { throw new Error('disk full') },
  }
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, false)
  assert.deepEqual(result.instances, [oldHost])
  assert.match(result.error, /disk full; host metadata rollback failed/)
})

test('saveHostWithPassword reports a real partial commit so a new host is not blindly duplicated', async () => {
  let setCalls = 0
  const bridge: Bridge = {
    instances_set: async () => {
      setCalls += 1
      if (setCalls === 1) return [oldHost, savedNew]
      throw new Error('registry unavailable')
    },
    instances_get: async () => [oldHost, savedNew],
    set_password: async () => ({ error: 'password denied' }),
  }
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, true)
  assert.deepEqual(result.instances, [oldHost, savedNew])
})

test('saveHostWithGatewayToken commits a write-only token after gateway metadata', async () => {
  const gatewayInput: SshInstanceInput = {
    id: 'gateway', label: 'Gateway', kind: 'gateway', host: 'gateway.example.com', remotePort: 443,
  }
  const gatewaySpec: SshInstanceSpec = {
    ...gatewayInput, kind: 'gateway', user: null, sshPort: null, serviceName: null, remoteDshHome: null,
  }
  let observedToken: string | null = null
  const bridge: Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_gateway_token'> = {
    instances_set: async () => [oldHost, gatewaySpec],
    instances_get: async () => [oldHost, gatewaySpec],
    set_gateway_token: async (_id, token) => { observedToken = token; return { ok: true } },
  }
  const result = await saveHostWithGatewayToken(bridge, [oldHost], [oldHost, gatewayInput], 'gateway', 'secret-token')
  assert.equal(result.ok, true)
  assert.equal(observedToken, 'secret-token')
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
})

test('saveHostWithGatewayToken rolls registry metadata back when token persistence fails', async () => {
  const gatewayInput: SshInstanceInput = {
    id: 'gateway', label: 'Gateway', kind: 'gateway', host: 'gateway.example.com', remotePort: 443,
  }
  const gatewaySpec: SshInstanceSpec = {
    ...gatewayInput, kind: 'gateway', user: null, sshPort: null, serviceName: null, remoteDshHome: null,
  }
  let setCalls = 0
  const bridge: Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_gateway_token'> = {
    instances_set: async () => { setCalls += 1; return setCalls === 1 ? [oldHost, gatewaySpec] : [oldHost] },
    instances_get: async () => [oldHost],
    set_gateway_token: async () => ({ error: 'token write failed' }),
  }
  const result = await saveHostWithGatewayToken(bridge, [oldHost], [oldHost, gatewayInput], 'gateway', 'secret-token')
  assert.deepEqual(result, { ok: false, instances: [oldHost], error: 'token write failed', metadataCommitted: false })
})

test('kind-switch cleanup clears only the previous provider secret', async () => {
  const calls: string[] = []
  const bridge: Pick<DesktopSshSurface, 'set_password' | 'set_gateway_token'> = {
    set_password: async (id, value) => { calls.push(`password:${id}:${String(value)}`); return { ok: true } },
    set_gateway_token: async (id, value) => { calls.push(`token:${id}:${String(value)}`); return { ok: true } },
  }
  await clearSupersededTransportSecret(bridge, 'one', 'ssh', 'gateway')
  await clearSupersededTransportSecret(bridge, 'two', 'gateway', 'ssh')
  await clearSupersededTransportSecret(bridge, 'three', 'gateway', 'gateway')
  assert.deepEqual(calls, ['password:one:null', 'token:two:null'])
})

test('gateway URL parser accepts only a credential-free HTTPS origin', () => {
  assert.deepEqual(parseGatewayUrl('https://gateway.example.com'), {
    ok: true, host: 'gateway.example.com', port: 443, origin: 'https://gateway.example.com',
  })
  assert.deepEqual(parseGatewayUrl('https://gateway.example.com:8443/'), {
    ok: true, host: 'gateway.example.com', port: 8443, origin: 'https://gateway.example.com:8443',
  })
  assert.deepEqual(parseGatewayUrl('https://[::1]:8443'), {
    ok: true, host: '[::1]', port: 8443, origin: 'https://[::1]:8443',
  })
  assert.deepEqual(parseGatewayUrl('http://gateway.example.com'), { ok: false, error: 'https' })
  assert.deepEqual(parseGatewayUrl('https://user:pw@gateway.example.com'), { ok: false, error: 'origin' })
  assert.deepEqual(parseGatewayUrl('https://gateway.example.com/chamber'), { ok: false, error: 'origin' })
  assert.deepEqual(parseGatewayUrl('https://gateway.example.com?token=leak'), { ok: false, error: 'origin' })
  assert.deepEqual(parseGatewayUrl(`https://${'a'.repeat(254)}.example`), { ok: false, error: 'host' })
  assert.equal(formatGatewayUrl('[::1]', 8443), 'https://[::1]:8443')
})
