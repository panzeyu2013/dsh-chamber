import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deleteConnectionTransaction,
  deleteConnectionsTransaction,
  saveConnectionTransaction,
  validateDeleteOnlyReplacement,
  type DeleteConnectionsTransactionDeps,
  type SaveConnectionRequest,
  type SaveConnectionTransactionDeps,
} from './connection-save.ts'
import type { TransportInstanceInput, TransportInstanceSpec } from './transport-provider.ts'

function spec(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'one',
    label: 'One',
    kind: 'gateway',
    transport: 'ssh',
    host: 'one.example.com',
    user: 'alice',
    sshPort: 22,
    remotePort: 30801,
    serviceName: 'dsh-gateway',
    remoteDshHome: null,
    insecureHttp: false,
    ...overrides,
  }
}

function normalize(input: TransportInstanceInput): TransportInstanceSpec | null {
  if (typeof input.id !== 'string' || input.id === '' || typeof input.label !== 'string' || input.label === '') return null
  if (input.kind !== 'dsh' && input.kind !== 'gateway') return null
  if (input.transport !== 'ssh' && input.transport !== 'http') return null
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    transport: input.transport,
    host: input.host,
    user: input.user ?? null,
    sshPort: input.sshPort ?? null,
    remotePort: input.remotePort,
    serviceName: input.serviceName ?? null,
    remoteDshHome: input.remoteDshHome ?? null,
    insecureHttp: input.transport === 'http' && input.insecureHttp === true,
    ...(input.spkiPin === undefined ? {} : { spkiPin: input.spkiPin }),
  }
}

interface FakeOptions {
  initial?: TransportInstanceSpec[]
  sshPassword?: string | null
  gatewayToken?: string | null
  gatewayPassword?: string | null
  active?: boolean
  failGatewayWrite?: number
  failGatewayAfterWrite?: number
  failSshWrite?: number
  failSshAfterWrite?: number
  failMetadataWrite?: number
  failMetadataAfterWrite?: number
  mismatchMetadataWrite?: number
  failConnect?: number
  hideCredentials?: boolean
}

function fakeDeps(options: FakeOptions = {}) {
  let instances = (options.initial ?? []).map(entry => ({ ...entry }))
  let sshPassword = options.sshPassword ?? null
  let gatewayToken = options.gatewayToken ?? null
  let gatewayPassword = options.gatewayPassword ?? null
  let active = options.active ?? false
  let gatewayWrites = 0
  let sshWrites = 0
  let metadataWrites = 0
  let connects = 0
  let invalidations = 0
  const calls: string[] = []
  const deps: SaveConnectionTransactionDeps = {
    listInstances: () => instances.map(entry => ({ ...entry })),
    normalize,
    saveInstances: next => {
      metadataWrites += 1
      calls.push(`metadata:${metadataWrites}`)
      if (options.failMetadataWrite === metadataWrites) throw new Error(`metadata write ${metadataWrites} failed`)
      instances = next.map(entry => normalize(entry)!).filter(Boolean)
      if (options.failMetadataAfterWrite === metadataWrites) throw new Error(`metadata write ${metadataWrites} failed after commit`)
      if (options.mismatchMetadataWrite === metadataWrites) instances = instances.slice(0, -1)
      return instances.map(entry => ({ ...entry }))
    },
    getSshPassword: () => options.hideCredentials ? null : sshPassword,
    getGatewayToken: () => options.hideCredentials ? null : gatewayToken,
    getGatewayPassword: () => options.hideCredentials ? null : gatewayPassword,
    setSshPassword: (_id, value) => {
      sshWrites += 1
      calls.push(`ssh:${String(value)}`)
      if (options.failSshWrite === sshWrites) throw new Error(`SSH write ${sshWrites} failed`)
      sshPassword = value
      if (options.failSshAfterWrite === sshWrites) throw new Error(`SSH write ${sshWrites} failed after commit`)
    },
    setGatewaySecrets: (_id, token, password) => {
      gatewayWrites += 1
      calls.push(`gateway:${String(token)}:${String(password)}`)
      if (options.failGatewayWrite === gatewayWrites) throw new Error(`gateway write ${gatewayWrites} failed`)
      gatewayToken = token
      gatewayPassword = password
      if (options.failGatewayAfterWrite === gatewayWrites) throw new Error(`gateway write ${gatewayWrites} failed after commit`)
    },
    invalidateGatewaySessions: () => { invalidations += 1 },
    isActive: () => active,
    disconnect: () => { calls.push('disconnect'); active = false },
    connect: () => {
      connects += 1
      calls.push('connect')
      if (options.failConnect === connects) throw new Error(`connect ${connects} failed`)
      active = true
    },
  }
  return {
    deps,
    calls,
    state: () => ({ instances, sshPassword, gatewayToken, gatewayPassword, active }),
    invalidations: () => invalidations,
  }
}

function addRequest(kind: 'dsh' | 'gateway', transport: 'ssh' | 'http'): SaveConnectionRequest {
  return {
    previousId: null,
    input: {
      id: 'added', label: 'Added', kind, transport, host: 'added.example.com',
      remotePort: kind === 'gateway' ? 30801 : 30800,
    },
    credentials: {
      sshPassword: transport === 'ssh' ? 'new-ssh' : undefined,
      gatewayToken: kind === 'gateway' ? 'new-token' : undefined,
      gatewayPassword: kind === 'gateway' ? 'new-gateway-password' : undefined,
    },
  }
}

test('main transaction accepts all four target/transport additions without credential leakage', () => {
  for (const [kind, transport, expected] of [
    ['dsh', 'ssh', { sshPassword: 'new-ssh', gatewayToken: null, gatewayPassword: null }],
    ['dsh', 'http', { sshPassword: null, gatewayToken: null, gatewayPassword: null }],
    ['gateway', 'http', { sshPassword: null, gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' }],
    ['gateway', 'ssh', { sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' }],
  ] as const) {
    const fake = fakeDeps()
    const result = saveConnectionTransaction(fake.deps, addRequest(kind, transport))
    assert.equal(result.ok, true, `${kind}+${transport}`)
    const state = fake.state()
    assert.deepEqual({
      sshPassword: state.sshPassword,
      gatewayToken: state.gatewayToken,
      gatewayPassword: state.gatewayPassword,
    }, expected, `${kind}+${transport}`)
  }
})

test('add and credential-domain entry scrub hidden crash-half secrets instead of reviving them', () => {
  const blankGateway = addRequest('gateway', 'http')
  blankGateway.credentials = {}
  const recreated = fakeDeps({
    hideCredentials: true,
    sshPassword: 'raw-old-ssh', gatewayToken: 'raw-old-token', gatewayPassword: 'raw-old-password',
  })
  assert.equal(saveConnectionTransaction(recreated.deps, blankGateway).ok, true)
  assert.deepEqual(recreated.state(), {
    instances: [normalize(blankGateway.input)!], sshPassword: null,
    gatewayToken: null, gatewayPassword: null, active: false,
  }, 'same id/domain blank add explicitly clears every hidden raw credential')
  assert.equal(recreated.invalidations(), 1, 'gateway generation entry invalidates historical sessions')

  const oldHttp = spec({ kind: 'dsh', transport: 'http', user: null, sshPort: null, serviceName: null })
  const enteringGateway = fakeDeps({
    initial: [oldHttp], hideCredentials: true, gatewayToken: 'raw-B-token', gatewayPassword: 'raw-B-password',
  })
  const nextGateway = { ...oldHttp, kind: 'gateway' as const, host: 'B.example.com' }
  assert.equal(saveConnectionTransaction(enteringGateway.deps, {
    previousId: oldHttp.id, input: nextGateway, credentials: {},
  }).ok, true)
  assert.equal(enteringGateway.state().gatewayToken, null, 'dsh→gateway blank entry cannot revive a hidden B token')
  assert.equal(enteringGateway.state().gatewayPassword, null)

  const enteringSsh = fakeDeps({ initial: [oldHttp], hideCredentials: true, sshPassword: 'raw-B-ssh' })
  const nextSsh = { ...oldHttp, transport: 'ssh' as const, host: 'B.example.com', user: 'alice', sshPort: 22 }
  assert.equal(saveConnectionTransaction(enteringSsh.deps, {
    previousId: oldHttp.id, input: nextSsh, credentials: {},
  }).ok, true)
  assert.equal(enteringSsh.state().sshPassword, null, 'http→ssh blank entry cannot revive a hidden B SSH password')

  const gatewayA = spec({ transport: 'http', user: null, sshPort: null, serviceName: null })
  const gatewayRetarget = fakeDeps({
    initial: [gatewayA], hideCredentials: true, gatewayToken: 'raw-B-token', gatewayPassword: 'raw-B-password',
  })
  assert.equal(saveConnectionTransaction(gatewayRetarget.deps, {
    previousId: gatewayA.id,
    input: { ...gatewayA, host: 'B.example.com', remotePort: 8443 },
    credentials: {},
  }).ok, true)
  assert.equal(gatewayRetarget.state().gatewayToken, null, 'gateway A→B blank retarget scrubs hidden B auth')
  assert.equal(gatewayRetarget.state().gatewayPassword, null)

  const sshA = spec({ kind: 'dsh' })
  const sshRetarget = fakeDeps({ initial: [sshA], hideCredentials: true, sshPassword: 'raw-B-ssh' })
  assert.equal(saveConnectionTransaction(sshRetarget.deps, {
    previousId: sshA.id,
    input: { ...sshA, host: 'B.example.com', user: 'bob', sshPort: 2222 },
    credentials: {},
  }).ok, true)
  assert.equal(sshRetarget.state().sshPassword, null, 'SSH endpoint A→B blank retarget scrubs hidden B password')
})

test('unchanged gateway+ssh edit commits both credential layers and restarts one live transport', () => {
  const existing = spec()
  const fake = fakeDeps({
    initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', active: true,
  })
  const result = saveConnectionTransaction(fake.deps, {
    previousId: existing.id,
    input: { ...existing, label: 'Renamed' },
    credentials: { sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(fake.state(), {
    instances: [{ ...existing, label: 'Renamed' }],
    sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password', active: true,
  })
  assert.deepEqual(fake.calls, [
    'disconnect', 'gateway:new-token:new-gateway-password', 'ssh:new-ssh', 'metadata:1', 'connect',
  ])
})

test('an idle-projected generation is torn down before target metadata changes and is not auto-connected', () => {
  const existing = spec()
  const fake = fakeDeps({ initial: [existing], active: false })
  const result = saveConnectionTransaction(fake.deps, {
    previousId: existing.id,
    input: { ...existing, host: 'replacement.example.com' },
    credentials: {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(fake.calls, [
    'disconnect', 'gateway:null:null', 'ssh:null', 'metadata:1',
  ], 'disconnect is a generation fence even when phase/isActive is idle')
  assert.equal(fake.state().active, false, 'exec-only teardown never auto-connects a tunnel')
})

test('gateway-store partial failure happens before SSH/metadata and restores every old value', () => {
  const existing = spec()
  const fake = fakeDeps({
    initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', failGatewayAfterWrite: 1,
  })
  const result = saveConnectionTransaction(fake.deps, {
    previousId: existing.id,
    input: { ...existing, label: 'Renamed' },
    credentials: { sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(fake.state(), {
    instances: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', active: false,
  })
  assert.deepEqual(fake.calls, [
    'disconnect', 'gateway:new-token:new-gateway-password', 'gateway:old-token:old-gateway-password',
  ])
})

test('SSH-store partial failure restores both secret stores from main-only snapshots', () => {
  const existing = spec()
  const fake = fakeDeps({
    initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', failSshAfterWrite: 1,
  })
  const result = saveConnectionTransaction(fake.deps, {
    previousId: existing.id,
    input: { ...existing, label: 'Renamed' },
    credentials: { sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(fake.state(), {
    instances: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', active: false,
  })
  assert.deepEqual(fake.calls, [
    'disconnect', 'gateway:new-token:new-gateway-password', 'ssh:new-ssh', 'gateway:old-token:old-gateway-password',
    'ssh:old-ssh',
  ])
})

test('metadata partial failure after both secret stores restores metadata and all old write-only values', () => {
  const existing = spec()
  const fake = fakeDeps({
    initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', failMetadataAfterWrite: 1,
  })
  const result = saveConnectionTransaction(fake.deps, {
    previousId: existing.id,
    input: { ...existing, host: 'retarget.example.com' },
    credentials: { sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(fake.state(), {
    instances: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', active: false,
  })
  assert.deepEqual(fake.calls, [
    'disconnect', 'gateway:new-token:new-gateway-password', 'ssh:new-ssh', 'metadata:1',
    'disconnect', 'metadata:2',
    'gateway:old-token:old-gateway-password', 'ssh:old-ssh',
  ])
})

test('replacement reconnect failure rolls metadata and both credential stores back, then restores the old live connection', () => {
  const existing = spec()
  const fake = fakeDeps({
    initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', active: true, failConnect: 1,
  })
  const result = saveConnectionTransaction(fake.deps, {
    previousId: existing.id,
    input: { ...existing, host: 'other.example.com' },
    credentials: { sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' },
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /connect 1 failed/)
    assert.doesNotMatch(result.error, /compensation failed/)
  }
  assert.deepEqual(fake.state(), {
    instances: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', active: true,
  })
  assert.deepEqual(fake.calls, [
    'disconnect', 'gateway:new-token:new-gateway-password', 'ssh:new-ssh', 'metadata:1', 'connect',
    'disconnect', 'metadata:2', 'gateway:old-token:old-gateway-password', 'ssh:old-ssh', 'connect',
  ])
})

test('same-kind retarget requires each stored credential independently before any write', () => {
  const existing = spec()
  for (const [credentials, expected] of [
    [{ gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' }, /SSH password/],
    [{ sshPassword: 'new-ssh', gatewayPassword: 'new-gateway-password' }, /gateway token/],
    [{ sshPassword: 'new-ssh', gatewayToken: 'new-token' }, /gateway password/],
  ] as const) {
    const fake = fakeDeps({
      initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password',
    })
    const result = saveConnectionTransaction(fake.deps, {
      previousId: existing.id,
      input: { ...existing, host: 'other.example.com' },
      credentials,
    })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.match(result.error, expected)
    assert.deepEqual(fake.calls, [])
  }
})

test('same-kind retarget replaces all applicable credentials without exposing old values', () => {
  const existing = spec()
  const fake = fakeDeps({
    initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password',
  })
  const result = saveConnectionTransaction(fake.deps, {
    previousId: existing.id,
    input: { ...existing, host: 'other.example.com' },
    credentials: { sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' },
  })
  assert.equal(result.ok, true)
  assert.equal(fake.state().instances[0].host, 'other.example.com')
  assert.deepEqual(fake.state(), {
    instances: [{ ...existing, host: 'other.example.com' }],
    sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password', active: false,
  })
})

test('SSH endpoint retarget requires only SSH password and rolls it back without touching gateway auth', () => {
  const existing = spec()
  const missing = fakeDeps({
    initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password',
  })
  const movedUser = { ...existing, user: 'bob' }
  const refused = saveConnectionTransaction(missing.deps, {
    previousId: existing.id, input: movedUser, credentials: {},
  })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.error, /SSH password/)
  assert.deepEqual(missing.calls, [])

  const failing = fakeDeps({
    initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password',
    failMetadataWrite: 1,
  })
  const failed = saveConnectionTransaction(failing.deps, {
    previousId: existing.id, input: movedUser, credentials: { sshPassword: 'new-ssh' },
  })
  assert.equal(failed.ok, false)
  assert.deepEqual(failing.state(), {
    instances: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', active: false,
  })
  assert.equal(failing.calls.some(call => call.startsWith('gateway:')), false, 'SSH-only retarget never rewrites gateway auth')
})

test('gateway host/remotePort retarget requires token and password separately while preserving SSH password on rollback', () => {
  const existing = spec()
  const movedGateway = { ...existing, remotePort: 30802 }
  for (const [credentials, expected] of [
    [{}, /gateway token/],
    [{ gatewayToken: 'new-token' }, /gateway password/],
  ] as const) {
    const fake = fakeDeps({
      initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password',
    })
    const result = saveConnectionTransaction(fake.deps, {
      previousId: existing.id, input: movedGateway, credentials,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, expected)
    assert.deepEqual(fake.calls, [])
  }

  const failing = fakeDeps({
    initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password',
    failMetadataWrite: 1,
  })
  const failed = saveConnectionTransaction(failing.deps, {
    previousId: existing.id,
    input: movedGateway,
    credentials: { gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' },
  })
  assert.equal(failed.ok, false)
  assert.deepEqual(failing.state(), {
    instances: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token',
    gatewayPassword: 'old-gateway-password', active: false,
  })
  assert.equal(failing.calls.some(call => call.startsWith('ssh:')), false, 'gateway-only retarget never rewrites SSH password')
})

test('transport-only gateway ssh↔http preserves gateway auth and handles SSH as its own transport credential', () => {
  // A real SSH row carries a user/daemon/service configuration. HTTP
  // normalization drops those SSH-only fields; gateway auth must still stay
  // bound to the unchanged gateway host+remotePort.
  const ssh = spec()
  const toHttp = fakeDeps({
    initial: [ssh], sshPassword: 'old-ssh', gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password',
  })
  const httpInput = { ...ssh, transport: 'http' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null }
  const httpResult = saveConnectionTransaction(toHttp.deps, {
    previousId: ssh.id, input: httpInput, credentials: {},
  })
  assert.equal(httpResult.ok, true)
  assert.deepEqual(toHttp.state(), {
    instances: [httpInput], sshPassword: null, gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password', active: false,
  })

  const toSsh = fakeDeps({
    initial: [httpInput], gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password',
  })
  const sshResult = saveConnectionTransaction(toSsh.deps, {
    previousId: ssh.id, input: ssh, credentials: { sshPassword: 'fresh-ssh' },
  })
  assert.equal(sshResult.ok, true)
  assert.deepEqual(toSsh.state(), {
    instances: [ssh], sshPassword: 'fresh-ssh', gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password', active: false,
  })
})

test('dsh↔gateway on one SSH endpoint preserves SSH password and clears only gateway-owned auth when leaving', () => {
  const gateway = spec()
  const dsh = { ...gateway, kind: 'dsh' as const }
  const leaving = fakeDeps({
    initial: [gateway], sshPassword: 'old-ssh', gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password',
  })
  assert.equal(saveConnectionTransaction(leaving.deps, {
    previousId: gateway.id, input: dsh, credentials: {},
  }).ok, true)
  assert.deepEqual(leaving.state(), {
    instances: [dsh], sshPassword: 'old-ssh', gatewayToken: null, gatewayPassword: null, active: false,
  })

  const entering = fakeDeps({ initial: [dsh], sshPassword: 'old-ssh' })
  assert.equal(saveConnectionTransaction(entering.deps, {
    previousId: dsh.id, input: gateway, credentials: { gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' },
  }).ok, true)
  assert.deepEqual(entering.state(), {
    instances: [gateway], sshPassword: 'old-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password', active: false,
  })
})

test('kind and transport switch metadata failures restore the credentials each switch temporarily superseded', () => {
  const gatewaySsh = spec({ user: null, sshPort: null, serviceName: null, remoteDshHome: null })
  const cases: TransportInstanceSpec[] = [
    { ...gatewaySsh, kind: 'dsh' },
    { ...gatewaySsh, transport: 'http' },
  ]
  for (const input of cases) {
    const fake = fakeDeps({
      initial: [gatewaySsh], sshPassword: 'old-ssh', gatewayToken: 'old-token',
      gatewayPassword: 'old-gateway-password', failMetadataWrite: 1,
    })
    const result = saveConnectionTransaction(fake.deps, {
      previousId: gatewaySsh.id, input, credentials: {},
    })
    assert.equal(result.ok, false, `${input.kind}+${input.transport}`)
    assert.deepEqual(fake.state(), {
      instances: [gatewaySsh], sshPassword: 'old-ssh', gatewayToken: 'old-token',
      gatewayPassword: 'old-gateway-password', active: false,
    }, `${input.kind}+${input.transport}`)
  }
})

test('metadata compensation failure is loud, scrubs all credentials, and never reconnects uncertain state', () => {
  const existing = spec()
  const fake = fakeDeps({
    initial: [existing], sshPassword: 'old-ssh', gatewayToken: 'old-token', gatewayPassword: 'old-gateway-password',
    active: true, mismatchMetadataWrite: 1, failMetadataWrite: 2,
  })
  const result = saveConnectionTransaction(fake.deps, {
    previousId: existing.id,
    input: { ...existing, host: 'other.example.com' },
    credentials: { sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, true)
  assert.match(result.error, /compensation failed/)
  assert.match(result.error, /restoring connection metadata failed/)
  assert.equal(fake.state().sshPassword, null)
  assert.equal(fake.state().gatewayToken, null)
  assert.equal(fake.state().gatewayPassword, null)
  assert.equal(fake.state().active, false)
})

test('delete transaction invalidates sessions and clears both bound stores before metadata deletion', () => {
  const existing = spec()
  let instances = [existing]
  let ssh: string | null = 'old-ssh'
  let token: string | null = 'old-token'
  let password: string | null = 'old-password'
  let active = true
  const calls: string[] = []
  const deps: DeleteConnectionsTransactionDeps = {
    listInstances: () => [...instances],
    saveInstances: next => {
      calls.push('metadata')
      instances = [...next] as TransportInstanceSpec[]
      return [...instances]
    },
    getSshPassword: () => ssh,
    getGatewayToken: () => token,
    getGatewayPassword: () => password,
    setSshPassword: (_id, value) => { calls.push(`ssh:${value}`); ssh = value },
    setGatewaySecrets: (_id, nextToken, nextPassword) => {
      calls.push(`gateway:${nextToken}:${nextPassword}`)
      token = nextToken
      password = nextPassword
    },
    invalidateGatewaySessions: () => { calls.push('invalidate') },
    isActive: () => active,
    disconnect: () => { calls.push('disconnect'); active = false },
    connect: () => { calls.push('connect'); active = true },
  }
  const result = deleteConnectionsTransaction(deps, [])
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['disconnect', 'invalidate', 'gateway:null:null', 'ssh:null', 'metadata'])
  assert.deepEqual(instances, [])
  assert.equal(ssh, null)
  assert.equal(token, null)
  assert.equal(password, null)
})

test('delete tears down an idle-projected generation before session, secret, and metadata mutation', () => {
  const existing = spec()
  const calls: string[] = []
  const deps: DeleteConnectionsTransactionDeps = {
    listInstances: () => [existing],
    saveInstances: () => { calls.push('metadata'); return [] },
    getSshPassword: () => null,
    getGatewayToken: () => null,
    getGatewayPassword: () => null,
    setSshPassword: () => { calls.push('ssh') },
    setGatewaySecrets: () => { calls.push('gateway') },
    invalidateGatewaySessions: () => { calls.push('invalidate') },
    isActive: () => false,
    disconnect: () => { calls.push('disconnect') },
    connect: () => { calls.push('connect') },
  }
  assert.equal(deleteConnectionsTransaction(deps, []).ok, true)
  assert.deepEqual(calls, ['disconnect', 'invalidate', 'gateway', 'ssh', 'metadata'])
})

test('delete session invalidation failure is fail-closed before secrets/metadata and reconnects the old row', () => {
  const existing = spec()
  let active = true
  const calls: string[] = []
  const deps: DeleteConnectionsTransactionDeps = {
    listInstances: () => [existing],
    saveInstances: () => { calls.push('metadata'); return [] },
    getSshPassword: () => 'old-ssh',
    getGatewayToken: () => 'old-token',
    getGatewayPassword: () => 'old-password',
    setSshPassword: () => { calls.push('ssh') },
    setGatewaySecrets: () => { calls.push('gateway') },
    invalidateGatewaySessions: () => { calls.push('invalidate'); throw new Error('cache refused') },
    isActive: () => active,
    disconnect: () => { calls.push('disconnect'); active = false },
    connect: () => { calls.push('connect'); active = true },
  }
  const result = deleteConnectionsTransaction(deps, [])
  assert.equal(result.ok, false)
  assert.deepEqual(calls, ['disconnect', 'invalidate', 'connect'])
  assert.equal(active, true)
  if (!result.ok) assert.equal(result.metadataCommitted, false)
})

test('delete credential-clear failure restores all main-only snapshots and leaves metadata intact', () => {
  const existing = spec()
  let ssh: string | null = 'old-ssh'
  let token: string | null = 'old-token'
  let password: string | null = 'old-password'
  let sshWrites = 0
  const calls: string[] = []
  const deps: DeleteConnectionsTransactionDeps = {
    listInstances: () => [existing],
    saveInstances: () => { calls.push('metadata'); return [] },
    getSshPassword: () => ssh,
    getGatewayToken: () => token,
    getGatewayPassword: () => password,
    setGatewaySecrets: (_id, nextToken, nextPassword) => {
      calls.push(`gateway:${nextToken}:${nextPassword}`)
      token = nextToken
      password = nextPassword
    },
    setSshPassword: (_id, value) => {
      sshWrites += 1
      calls.push(`ssh:${value}`)
      if (sshWrites === 1) throw new Error('SSH clear failed')
      ssh = value
    },
    invalidateGatewaySessions: () => { calls.push('invalidate') },
    isActive: () => false,
    disconnect: () => {},
    connect: () => {},
  }
  const result = deleteConnectionsTransaction(deps, [])
  assert.equal(result.ok, false)
  assert.deepEqual(calls, [
    'invalidate', 'gateway:null:null', 'ssh:null',
    'gateway:old-token:old-password', 'ssh:old-ssh',
  ])
  assert.equal(ssh, 'old-ssh')
  assert.equal(token, 'old-token')
  assert.equal(password, 'old-password')
  if (!result.ok) assert.equal(result.metadataCommitted, false)
})

test('legacy instances_set accepts only an exact deeply unchanged no-op roster', () => {
  const one = spec({ id: 'one' })
  const two = spec({ id: 'two', host: 'two.example.com' })
  assert.equal(validateDeleteOnlyReplacement([one, two], [
    { ...two, tokenSet: true, passwordSet: false, secretStorage: 'plaintext' },
  ], normalize), null, 'even a one-row deletion is refused on the roster compatibility channel')
  assert.equal(validateDeleteOnlyReplacement([one], [{ ...one, label: 'edited' }], normalize), null, 'edit refused')
  assert.equal(validateDeleteOnlyReplacement([one], [one, spec({ id: 'added' })], normalize), null, 'add refused')
  assert.equal(validateDeleteOnlyReplacement([one, two], [two, one], normalize), null, 'reorder refused')
  assert.equal(validateDeleteOnlyReplacement([one], [one, one], normalize), null, 'duplicate refused')
  assert.deepEqual(validateDeleteOnlyReplacement([one, two], [
    { ...one, sshPasswordSet: true },
    { ...two, tokenSet: true },
  ], normalize), [one, two], 'non-secret projections are ignored on an otherwise exact no-op')
})

test('exact-id delete is immune to stale delete-A plus concurrent delete-A/add-C roster replacement', () => {
  const two = spec({ id: 'two', host: 'two.example.com' })
  const concurrent = spec({ id: 'concurrent', host: 'concurrent.example.com' })
  // The renderer's old snapshot was [A, B] and it intends to delete A. By
  // invocation time another actor has already deleted A and added C, so the
  // current authoritative roster is [B, C]. Exact-id delete(A) is a no-op;
  // a stale retained-roster [B] would incorrectly delete C.
  let instances = [two, concurrent]
  const calls: string[] = []
  const deps: DeleteConnectionsTransactionDeps = {
    listInstances: () => [...instances],
    saveInstances: next => { calls.push('metadata'); instances = [...next] as TransportInstanceSpec[]; return [...instances] },
    getSshPassword: () => null,
    getGatewayToken: () => null,
    getGatewayPassword: () => null,
    setSshPassword: () => { calls.push('ssh') },
    setGatewaySecrets: () => { calls.push('gateway') },
    invalidateGatewaySessions: () => { calls.push('invalidate') },
    isActive: () => false,
    disconnect: () => { calls.push('disconnect') },
    connect: () => { calls.push('connect') },
  }
  const result = deleteConnectionTransaction(deps, 'one')
  assert.equal(result.ok, true)
  assert.deepEqual(result.instances, [two, concurrent])
  assert.deepEqual(calls, [], 'idempotent missing-id delete cannot mutate concurrent C')
})
