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

/**
 * A bridge replicating the MAIN-PROCESS gate (main.ts desktop_ssh_set_password):
 * set_password REFUSES ids that are not in the current registry
 * ('invalid or unknown instance id') — the new-host password-first order must
 * therefore never reach set_password before the registry write.
 */
function gatedBridge(overrides: {
  initial?: SshInstanceSpec[]
  registry?: (next: SshInstanceInput[]) => SshInstanceSpec[]
  password?: (id: string) => { ok: true } | { error: string } | never
} = {}): Bridge & { calls: string[]; state: SshInstanceSpec[] } {
  const calls: string[] = []
  const state: SshInstanceSpec[] = [...(overrides.initial ?? [oldHost])]
  const registry = overrides.registry ?? ((next) => next.map(input => ({ ...input, kind: 'ssh' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null })))
  return {
    calls,
    state,
    instances_get: async () => [...state],
    instances_set: async (next) => {
      calls.push('instances_set')
      // Compute BEFORE mutating state: a throwing registry must leave the
      // committed state intact (the rollback-failure test relies on it).
      const nextState = registry(next)
      state.length = 0
      state.push(...nextState)
      return [...state]
    },
    set_password: async (id) => {
      calls.push('set_password')
      // Main-process gate: unknown ids are refused, never stored.
      if (!state.some(spec => spec.id === id)) return { error: 'invalid or unknown instance id' }
      if (overrides.password !== undefined) return overrides.password(id)
      return { ok: true }
    },
  }
}

test('edit: password commits FIRST, then the registry (M9 — password failure leaves the registry untouched)', async () => {
  const bridge = gatedBridge({ password: () => ({ error: 'password write failed' }) })
  const result = await saveHostWithPassword(bridge, [oldHost], [{ ...oldHost, label: 'Old2' }], 'old', 'pw')
  assert.deepEqual(result, { ok: false, instances: [oldHost], error: 'password write failed', metadataCommitted: false })
  assert.deepEqual(bridge.calls, ['set_password'], 'instances_set must not run when the password failed')
  assert.deepEqual(bridge.state, [oldHost])
})

test('edit: success commits password then registry, in that order', async () => {
  const bridge = gatedBridge()
  const edited = { ...oldHost, label: 'Old2' }
  const result = await saveHostWithPassword(bridge, [oldHost], [edited], 'old', 'pw')
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['set_password', 'instances_set'])
})

test('new host: the registry lands FIRST (set_password refuses unknown ids), then the password (M9)', async () => {
  const bridge = gatedBridge()
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['instances_set', 'set_password'], 'registry before password for a NEW id')
  assert.deepEqual(bridge.state, [oldHost, savedNew])
})

test('new host: a password failure rolls the registry back (design 05 §8 compensation)', async () => {
  const bridge = gatedBridge({ password: () => ({ error: 'password denied' }) })
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.deepEqual(result, { ok: false, instances: [oldHost], error: 'password denied', metadataCommitted: false })
  assert.deepEqual(bridge.calls, ['instances_set', 'set_password', 'instances_set'], 'rollback after the password failure')
  assert.deepEqual(bridge.state, [oldHost])
})

test('new host: a failed rollback reports metadataCommitted=true so the form turns the row into an edit target', async () => {
  let registryCalls = 0
  const bridge = gatedBridge({
    password: () => { throw new Error('disk full') },
    registry: (next) => {
      registryCalls += 1
      // First write lands; the ROLLBACK write fails (registry stays committed).
      if (registryCalls >= 2) throw new Error('registry unavailable')
      return next.map(input => ({ ...input, kind: 'ssh' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null }))
    },
  })
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, true)
  assert.deepEqual(result.instances, [oldHost, savedNew])
  assert.match(result.error, /disk full; host metadata rollback failed/)
})

test('empty password skips set_password entirely and commits the registry', async () => {
  const bridge = gatedBridge()
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', '')
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['instances_set'])
})

test('new host: a ROLLBACK throw must never masquerade as the password error (round-3 review)', async () => {
  let registryCalls = 0
  const bridge = gatedBridge({
    password: () => ({ error: 'password denied' }),
    registry: (next) => {
      registryCalls += 1
      if (registryCalls >= 2) throw new Error('registry unavailable')
      return next.map(input => ({ ...input, kind: 'ssh' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null }))
    },
  })
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  // The user-visible error must lead with the PASSWORD error, not the
  // rollback error (the pre-fix code swapped them).
  assert.ok(result.error.startsWith('password denied'), `password error preserved: ${result.error}`)
  assert.match(result.error, /host metadata rollback failed/)
  assert.equal(result.metadataCommitted, true)
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
