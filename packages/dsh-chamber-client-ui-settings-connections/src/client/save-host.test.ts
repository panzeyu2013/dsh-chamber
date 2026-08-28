import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DesktopSshSurface, SshInstanceInput, SshInstanceSpec } from '../global.d.ts'
import { formatGatewayUrl, parseGatewayUrl } from './gateway-url.ts'
import {
  clearSupersededTransportSecret,
  gatewayPasswordValidationError,
  saveHostWithGatewayCredentials,
  saveHostWithGatewayToken,
  saveHostWithPassword,
  transportTargetChangedSpec,
} from './save-host.ts'

const oldHost: SshInstanceSpec = {
  id: 'old', label: 'Old', kind: 'ssh', transport: 'ssh', host: 'old.example.com', user: null,
  sshPort: null, remotePort: 30800, serviceName: null, remoteDshHome: null, insecureHttp: false,
}
const newHost: SshInstanceInput = { id: 'new', label: 'New', host: 'new.example.com', remotePort: 30800 }
const savedNew: SshInstanceSpec = {
  ...newHost, kind: 'ssh', transport: 'ssh', user: null, sshPort: null, serviceName: null, remoteDshHome: null, insecureHttp: false,
}

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
  const registry = overrides.registry ?? ((next) => next.map(input => ({ ...input, kind: 'ssh' as const, transport: 'ssh' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null, insecureHttp: false })))
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

const oldGateway: SshInstanceSpec = {
  id: 'gw', label: 'Gateway', kind: 'gateway', transport: 'http', host: 'gateway.example.com', user: null,
  sshPort: null, remotePort: 443, serviceName: null, remoteDshHome: null, insecureHttp: false,
}
const newGateway: SshInstanceInput = { id: 'gw2', label: 'Gateway2', kind: 'gateway', host: 'gw2.example.com', remotePort: 443 }
const savedGateway: SshInstanceSpec = {
  ...newGateway, kind: 'gateway', transport: 'http', user: null, sshPort: null, serviceName: null, remoteDshHome: null, insecureHttp: false,
}

type GatewayBridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_gateway_token' | 'set_gateway_password'>
  & { calls: string[]; state: SshInstanceSpec[] }

/**
 * Gateway bridge replicating the MAIN-PROCESS gates: BOTH secret setters
 * REFUSE ids that are not in the current registry ('invalid or unknown
 * instance id') — the new-host registry-first order must never reach a setter
 * before the registry write, and the partial-commit compensation must clear
 * the earlier secret BEFORE the registry rolls back (clearing afterwards
 * would be refused for the now-unregistered id).
 */
function gatewayBridge(overrides: {
  initial?: SshInstanceSpec[]
  registry?: (next: SshInstanceInput[]) => SshInstanceSpec[]
  token?: (id: string) => { ok: true } | { error: string }
  password?: (id: string) => { ok: true } | { error: string }
} = {}): GatewayBridge {
  const calls: string[] = []
  const state: SshInstanceSpec[] = [...(overrides.initial ?? [oldGateway])]
  const registry = overrides.registry ?? ((next) => next.map(input => ({ ...input, kind: 'gateway' as const, transport: 'http' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null, insecureHttp: false })))
  const commit = (name: string, id: string, value: string | null, gate?: (id: string) => { ok: true } | { error: string }): { ok: true } | { error: string } => {
    calls.push(`${name}:${String(value)}`)
    if (!state.some(spec => spec.id === id)) return { error: 'invalid or unknown instance id' }
    if (gate !== undefined) return gate(id)
    return { ok: true }
  }
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
    set_gateway_token: async (id, value) => commit('set_gateway_token', id, value, overrides.token),
    set_gateway_password: async (id, value) => commit('set_gateway_password', id, value, overrides.password),
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

test('same-kind TARGET edit (host changed): registry lands FIRST, then the password (P2 — the main process clears the stale secret inside instances_set)', async () => {
  const bridge = gatedBridge()
  const retargeted = { ...oldHost, host: 'new.example.com' }
  const result = await saveHostWithPassword(bridge, [oldHost], [retargeted], 'old', 'pw')
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['instances_set', 'set_password'], 'registry before password for a same-kind retarget')
  assert.deepEqual(bridge.state, [retargeted])
})

test('same-kind TARGET edit: a password failure rolls the metadata back (new-host compensation)', async () => {
  const bridge = gatedBridge({ password: () => ({ error: 'password denied' }) })
  const retargeted = { ...oldHost, remotePort: 18000 }
  const result = await saveHostWithPassword(bridge, [oldHost], [retargeted], 'old', 'pw')
  assert.deepEqual(result, { ok: false, instances: [oldHost], error: 'password denied', metadataCommitted: false })
  assert.deepEqual(bridge.calls, ['instances_set', 'set_password', 'instances_set'], 'rollback after the password failure')
  assert.deepEqual(bridge.state, [oldHost])
})

test('same-kind TARGET edit: a failed rollback reports metadataCommitted=true', async () => {
  let registryCalls = 0
  const bridge = gatedBridge({
    password: () => ({ error: 'password denied' }),
    registry: (next) => {
      registryCalls += 1
      // First write lands; the ROLLBACK write fails (registry stays committed).
      if (registryCalls >= 2) throw new Error('registry unavailable')
      return next.map(input => ({ ...input, kind: 'ssh' as const, transport: 'ssh' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null, insecureHttp: false }))
    },
  })
  const result = await saveHostWithPassword(bridge, [oldHost], [{ ...oldHost, host: 'new.example.com' }], 'old', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, true)
  assert.ok(result.error.startsWith('password denied'), `password error preserved: ${result.error}`)
  assert.match(result.error, /host metadata rollback failed/)
})

test('label-only edits keep the secrets-first order (no target change — the main process does not clear)', async () => {
  const bridge = gatedBridge()
  const result = await saveHostWithPassword(bridge, [oldHost], [{ ...oldHost, label: 'Renamed' }], 'old', 'pw')
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
      return next.map(input => ({ ...input, kind: 'ssh' as const, transport: 'ssh' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null, insecureHttp: false }))
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
      return next.map(input => ({ ...input, kind: 'ssh' as const, transport: 'ssh' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null, insecureHttp: false }))
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
    ...gatewayInput, kind: 'gateway', transport: 'http', user: null, sshPort: null, serviceName: null, remoteDshHome: null, insecureHttp: false,
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
    ...gatewayInput, kind: 'gateway', transport: 'http', user: null, sshPort: null, serviceName: null, remoteDshHome: null, insecureHttp: false,
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

test('gateway credentials: new host commits registry, then token and password in order', async () => {
  const bridge = gatewayBridge()
  const result = await saveHostWithGatewayCredentials(bridge, [oldGateway], [oldGateway, newGateway], 'gw2', { token: 'secret-token', password: 'correct horse battery' })
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['instances_set', 'set_gateway_token:secret-token', 'set_gateway_password:correct horse battery'], 'registry before BOTH credentials for a NEW id')
  assert.deepEqual(bridge.state, [oldGateway, savedGateway])
  // Neither credential ever rides the result (write-only contract).
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
  assert.equal(JSON.stringify(result).includes('correct horse battery'), false)
})

test('gateway credentials: token-only and password-only commits stay independent', async () => {
  const tokenOnly = gatewayBridge()
  await saveHostWithGatewayCredentials(tokenOnly, [oldGateway], [oldGateway, newGateway], 'gw2', { token: 'secret-token', password: '' })
  assert.deepEqual(tokenOnly.calls, ['instances_set', 'set_gateway_token:secret-token'], 'password untouched when left empty')

  const passwordOnly = gatewayBridge()
  await saveHostWithGatewayCredentials(passwordOnly, [oldGateway], [oldGateway, newGateway], 'gw2', { token: '', password: 'correct horse battery' })
  assert.deepEqual(passwordOnly.calls, ['instances_set', 'set_gateway_password:correct horse battery'], 'token untouched when left empty')
})

test('gateway credentials: both empty skips the setters and commits the registry', async () => {
  const bridge = gatewayBridge()
  const result = await saveHostWithGatewayCredentials(bridge, [oldGateway], [oldGateway, newGateway], 'gw2', { token: '', password: '' })
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['instances_set'])
})

test('gateway credentials: edit commits token and password FIRST, then the registry', async () => {
  const bridge = gatewayBridge()
  const edited = { ...oldGateway, label: 'Gateway edited' }
  const result = await saveHostWithGatewayCredentials(bridge, [oldGateway], [edited], 'gw', { token: 'new-token', password: 'new password' })
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['set_gateway_token:new-token', 'set_gateway_password:new password', 'instances_set'], 'secrets before registry for an EXISTING id')
  assert.deepEqual(bridge.state, [edited])
})

test('gateway credentials: same-kind TARGET edit commits the registry FIRST, then both credentials (P2 — instances_set clears the stale secret)', async () => {
  const bridge = gatewayBridge()
  const retargeted = { ...oldGateway, host: 'gw-new.example.com' }
  const result = await saveHostWithGatewayCredentials(bridge, [oldGateway], [retargeted], 'gw', { token: 'new-token', password: 'new password' })
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['instances_set', 'set_gateway_token:new-token', 'set_gateway_password:new password'], 'registry before BOTH credentials for a same-kind retarget')
  assert.deepEqual(bridge.state, [retargeted])
})

test('gateway credentials: same-kind TARGET edit with a PARTIAL commit scrubs the earlier secret before the rollback', async () => {
  // The registry lands first (the stale secret is cleared inside instances_set);
  // the token lands, the password is refused — the committed token must be
  // scrubbed WHILE the id is still registered, then the metadata rolls back.
  const bridge = gatewayBridge({ password: () => ({ error: 'password denied' }) })
  const retargeted = { ...oldGateway, remotePort: 8443 }
  const result = await saveHostWithGatewayCredentials(bridge, [oldGateway], [retargeted], 'gw', { token: 'secret-token', password: 'correct horse battery' })
  assert.deepEqual(result, { ok: false, instances: [oldGateway], error: 'password denied', metadataCommitted: false })
  assert.deepEqual(bridge.calls, [
    'instances_set',
    'set_gateway_token:secret-token',
    'set_gateway_password:correct horse battery',
    'set_gateway_token:null',
    'instances_set',
  ])
  assert.deepEqual(bridge.state, [oldGateway])
})

test('gateway credentials: edit password failure leaves the registry untouched', async () => {
  const bridge = gatewayBridge({ password: () => ({ error: 'password write failed' }) })
  const result = await saveHostWithGatewayCredentials(bridge, [oldGateway], [{ ...oldGateway, label: 'x' }], 'gw', { token: '', password: 'correct horse battery' })
  assert.deepEqual(result, { ok: false, instances: [oldGateway], error: 'password write failed', metadataCommitted: false })
  assert.deepEqual(bridge.calls, ['set_gateway_password:correct horse battery'], 'instances_set must not run when a secret failed')
  assert.deepEqual(bridge.state, [oldGateway])
})

test('gateway credentials: new-host password failure rolls the registry back', async () => {
  const bridge = gatewayBridge({ password: () => ({ error: 'password denied' }) })
  const result = await saveHostWithGatewayCredentials(bridge, [oldGateway], [oldGateway, newGateway], 'gw2', { token: '', password: 'correct horse battery' })
  assert.deepEqual(result, { ok: false, instances: [oldGateway], error: 'password denied', metadataCommitted: false })
  assert.deepEqual(bridge.calls, ['instances_set', 'set_gateway_password:correct horse battery', 'instances_set'], 'rollback after the password failure')
  assert.deepEqual(bridge.state, [oldGateway])
})

test('gateway credentials: a PARTIAL new-host commit clears the earlier secret before the registry rolls back', async () => {
  // token lands, password is refused — the committed token must be scrubbed
  // WHILE the id is still registered (clearing after the rollback would be
  // refused), so a retried id never silently reuses the orphaned credential.
  const bridge = gatewayBridge({ password: () => ({ error: 'password denied' }) })
  const result = await saveHostWithGatewayCredentials(bridge, [oldGateway], [oldGateway, newGateway], 'gw2', { token: 'secret-token', password: 'correct horse battery' })
  assert.deepEqual(result, { ok: false, instances: [oldGateway], error: 'password denied', metadataCommitted: false })
  assert.deepEqual(bridge.calls, [
    'instances_set',
    'set_gateway_token:secret-token',
    'set_gateway_password:correct horse battery',
    'set_gateway_token:null',
    'instances_set',
  ])
  assert.deepEqual(bridge.state, [oldGateway])
})

test('gateway credentials: a failed rollback reports metadataCommitted=true (round-3 error ordering)', async () => {
  let registryCalls = 0
  const bridge = gatewayBridge({
    password: () => ({ error: 'password denied' }),
    registry: (next) => {
      registryCalls += 1
      if (registryCalls >= 2) throw new Error('registry unavailable')
      return next.map(input => ({ ...input, kind: 'gateway' as const, transport: 'http' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null, insecureHttp: false }))
    },
  })
  const result = await saveHostWithGatewayCredentials(bridge, [oldGateway], [oldGateway, newGateway], 'gw2', { token: '', password: 'correct horse battery' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, true)
  assert.deepEqual(result.instances, [oldGateway, savedGateway])
  // The user-visible error must lead with the PASSWORD error (round-3 rule).
  assert.ok(result.error.startsWith('password denied'), `password error preserved: ${result.error}`)
  assert.match(result.error, /host metadata rollback failed/)
})

test('gateway password validation mirrors the 12-1024 visible-ASCII server gate', () => {
  // '' = the optional field is left empty (no validation).
  assert.equal(gatewayPasswordValidationError(''), null)
  // Length bounds: 12..1024 inclusive.
  assert.equal(gatewayPasswordValidationError('a'.repeat(11)), 'length')
  assert.equal(gatewayPasswordValidationError('a'.repeat(12)), null)
  assert.equal(gatewayPasswordValidationError('correct horse battery'), null)
  assert.equal(gatewayPasswordValidationError('a'.repeat(1024)), null)
  assert.equal(gatewayPasswordValidationError('a'.repeat(1025)), 'length')
  // visible ASCII only: \x20..\x7e — non-ASCII and control bytes are refused.
  assert.equal(gatewayPasswordValidationError('密码太长了密码太长了'), 'ascii')
  assert.equal(gatewayPasswordValidationError('line\nbreak'), 'ascii')
  assert.equal(gatewayPasswordValidationError('tab\there'), 'ascii')
})

test('kind-switch cleanup clears only the previous provider secret', async () => {
  const calls: string[] = []
  const bridge: Pick<DesktopSshSurface, 'set_password' | 'set_gateway_token' | 'set_gateway_password'> = {
    set_password: async (id, value) => { calls.push(`password:${id}:${String(value)}`); return { ok: true } },
    set_gateway_token: async (id, value) => { calls.push(`token:${id}:${String(value)}`); return { ok: true } },
    set_gateway_password: async (id, value) => { calls.push(`gateway-password:${id}:${String(value)}`); return { ok: true } },
  }
  await clearSupersededTransportSecret(bridge, 'one', 'ssh', 'gateway')
  await clearSupersededTransportSecret(bridge, 'two', 'gateway', 'ssh')
  await clearSupersededTransportSecret(bridge, 'three', 'gateway', 'gateway')
  // ssh→gateway clears the ssh password; gateway→other clears BOTH gateway
  // credentials (token AND password — design 17 §7); same-kind is a no-op.
  assert.deepEqual(calls, ['password:one:null', 'token:two:null', 'gateway-password:two:null'])
})

/**
 * transportTargetChangedSpec must agree with the DESKTOP transportTargetChanged
 * (packages/desktop/transport-provider.ts, locked by transport-target.test.ts)
 * — the main process clears provider-held credentials inside instances_set
 * using exactly this rule, so the plugin-side mirror drives the same order.
 */
test('transportTargetChangedSpec mirrors the desktop check (target fields only; label and insecureHttp excluded)', () => {
  // The renderer wire union keeps the legacy 'ssh' kind spelling; the mirror
  // normalizes it to v2 'dsh' exactly like the main process migration.
  const base: SshInstanceSpec = {
    id: 'x', label: 'p', kind: 'ssh', transport: 'ssh', host: 'h.example.com', user: 'u',
    sshPort: 22, remotePort: 30800, serviceName: null, remoteDshHome: null, insecureHttp: false,
  }
  const input = (overrides: Partial<SshInstanceInput> = {}): SshInstanceInput => ({
    id: 'x', label: 'p', kind: 'ssh', transport: 'ssh', host: 'h.example.com', user: 'u', sshPort: 22, remotePort: 30800, ...overrides,
  })
  assert.equal(transportTargetChangedSpec(base, input({ label: 'renamed' })), false)
  assert.equal(transportTargetChangedSpec(base, input({ host: 'other.example.com' })), true)
  assert.equal(transportTargetChangedSpec(base, input({ user: 'admin' })), true)
  assert.equal(transportTargetChangedSpec(base, input({ sshPort: 2222 })), true)
  assert.equal(transportTargetChangedSpec(base, input({ remotePort: 18000 })), true)
  assert.equal(transportTargetChangedSpec(base, input({ serviceName: 'dsh' })), true)
  assert.equal(transportTargetChangedSpec(base, input({ remoteDshHome: '/srv/dsh' })), true)
  assert.equal(transportTargetChangedSpec(base, input({ kind: 'gateway', transport: 'http' })), true)
  assert.equal(transportTargetChangedSpec(base, input({ transport: 'http' })), true)
  // http↔https on the same target keeps the credential (design 17 §9.1, D3).
  assert.equal(transportTargetChangedSpec(base, input({ insecureHttp: true })), false)
  assert.equal(transportTargetChangedSpec(base, input()), false)
})

test('transportTargetChangedSpec normalizes legacy/omitted input fields like the main process', () => {
  const base: SshInstanceSpec = {
    id: 'x', label: 'p', kind: 'ssh', transport: 'ssh', host: 'h.example.com', user: null,
    sshPort: null, remotePort: 30800, serviceName: null, remoteDshHome: null, insecureHttp: false,
  }
  // legacy 'ssh' kind + omitted optional fields normalize to the dsh/ssh spec
  assert.equal(transportTargetChangedSpec(base, { id: 'x', label: 'p', kind: 'ssh', host: 'h.example.com', remotePort: 30800 }), false)
  // gateway kind defaults transport to http when omitted
  assert.equal(transportTargetChangedSpec(
    { ...base, kind: 'gateway', transport: 'http' },
    { id: 'x', label: 'p', kind: 'gateway', host: 'h.example.com', remotePort: 30800 },
  ), false)
})

test('gateway URL parser accepts a credential-free http/https origin (scheme into the result, 80/443 defaults)', () => {
  assert.deepEqual(parseGatewayUrl('https://gateway.example.com'), {
    ok: true, scheme: 'https', host: 'gateway.example.com', port: 443, origin: 'https://gateway.example.com',
  })
  assert.deepEqual(parseGatewayUrl('https://gateway.example.com:8443/'), {
    ok: true, scheme: 'https', host: 'gateway.example.com', port: 8443, origin: 'https://gateway.example.com:8443',
  })
  assert.deepEqual(parseGatewayUrl('https://[::1]:8443'), {
    ok: true, scheme: 'https', host: '[::1]', port: 8443, origin: 'https://[::1]:8443',
  })
  // http plaintext is an explicit user decision (design 17 §9.1/§13.1 S21),
  // never pre-blocked; the http port defaults to 80.
  assert.deepEqual(parseGatewayUrl('http://gateway.example.com'), {
    ok: true, scheme: 'http', host: 'gateway.example.com', port: 80, origin: 'http://gateway.example.com',
  })
  assert.deepEqual(parseGatewayUrl('http://gateway.example.com:8080/'), {
    ok: true, scheme: 'http', host: 'gateway.example.com', port: 8080, origin: 'http://gateway.example.com:8080',
  })
  assert.deepEqual(parseGatewayUrl('https://user:pw@gateway.example.com'), { ok: false, error: 'origin' })
  assert.deepEqual(parseGatewayUrl('https://gateway.example.com/chamber'), { ok: false, error: 'origin' })
  assert.deepEqual(parseGatewayUrl('https://gateway.example.com?token=leak'), { ok: false, error: 'origin' })
  assert.deepEqual(parseGatewayUrl(`https://${'a'.repeat(254)}.example`), { ok: false, error: 'host' })
  assert.deepEqual(parseGatewayUrl('ftp://gateway.example.com'), { ok: false, error: 'origin' })
  // format: https defaults to 443, http defaults to 80; explicit ports carry
  // the scheme; insecureHttp picks the http:// display (design 17 §9.1).
  assert.equal(formatGatewayUrl('gateway.example.com', 443, false), 'https://gateway.example.com')
  assert.equal(formatGatewayUrl('gateway.example.com', 8443, false), 'https://gateway.example.com:8443')
  assert.equal(formatGatewayUrl('gateway.example.com', 80, true), 'http://gateway.example.com')
  assert.equal(formatGatewayUrl('gateway.example.com', 8080, true), 'http://gateway.example.com:8080')
  assert.equal(formatGatewayUrl('[::1]', 8443, false), 'https://[::1]:8443')
})
