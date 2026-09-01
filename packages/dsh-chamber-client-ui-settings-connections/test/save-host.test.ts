import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  ConnectionCredentialMutations,
  DesktopSshSurface,
  SshInstanceInput,
  SshInstanceSpec,
} from '../src/global.d.ts'
import { formatGatewayUrl, parseGatewayUrl } from '../src/client/gateway-url.ts'
import {
  credentialReentryFor,
  gatewayPasswordValidationError,
  saveHostWithConnectionCredentials,
  transportTargetChangedSpec,
} from '../src/client/save-host.ts'

function specGatewaySsh(overrides: Partial<SshInstanceSpec> = {}): SshInstanceSpec {
  return {
    id: 'gateway-ssh',
    label: 'Gateway SSH',
    kind: 'gateway',
    transport: 'ssh',
    host: 'ssh.example.com',
    user: 'alice',
    sshPort: 22,
    remotePort: 30801,
    serviceName: 'gateway',
    remoteDshHome: null,
    insecureHttp: false,
    sourceFingerprint: 'test-proof:gateway-ssh',
    ...overrides,
  }
}

function normalizeConnectionInput(input: SshInstanceInput): SshInstanceSpec {
  const kind = input.kind ?? 'dsh'
  const transport = input.transport ?? (kind === 'gateway' ? 'http' : 'ssh')
  return {
    ...input,
    kind,
    transport,
    user: transport === 'ssh' ? (input.user ?? null) : null,
    sshPort: transport === 'ssh' ? (input.sshPort ?? null) : null,
    serviceName: transport === 'ssh' ? (input.serviceName ?? null) : null,
    remoteDshHome: transport === 'ssh' ? (input.remoteDshHome ?? null) : null,
    insecureHttp: transport === 'http' && input.insecureHttp === true,
    sourceFingerprint: `test-proof:${input.id}`,
  }
}

type ConnectionBridge = Pick<DesktopSshSurface, 'save_connection'> & {
  calls: Array<{ previousId: string | null; input: SshInstanceInput; credentials: ConnectionCredentialMutations }>
  state: SshInstanceSpec[]
}

/** Capture the renderer→main transaction call. Store/rollback behavior lives
 * in desktop/connection-save.test.ts where old secrets stay main-only. */
function connectionBridge(overrides: {
  initial?: SshInstanceSpec[]
  result?: (previousId: string | null, input: SshInstanceInput) => Awaited<ReturnType<DesktopSshSurface['save_connection']>>
} = {}): ConnectionBridge {
  const calls: ConnectionBridge['calls'] = []
  const state = [...(overrides.initial ?? [])]
  return {
    calls,
    state,
    save_connection: async (previousId, input, credentials) => {
      calls.push({ previousId, input, credentials })
      if (overrides.result !== undefined) return overrides.result(previousId, input)
      const normalized = normalizeConnectionInput(input)
      if (previousId === null) state.push(normalized)
      else {
        const index = state.findIndex(row => row.id === previousId)
        if (index >= 0) state[index] = normalized
      }
      return { ok: true, instances: [...state] }
    },
  }
}

test('renderer save filters all four target/transport combinations into one main-owned transaction', async () => {
  const cases: Array<{
    kind: 'dsh' | 'gateway'
    transport: 'ssh' | 'http'
    expected: ConnectionCredentialMutations
  }> = [
    { kind: 'dsh', transport: 'ssh', expected: { sshPassword: 'ssh-secret' } },
    { kind: 'dsh', transport: 'http', expected: {} },
    { kind: 'gateway', transport: 'http', expected: { gatewayToken: 'gateway-token', gatewayPassword: 'gateway-password' } },
    { kind: 'gateway', transport: 'ssh', expected: { sshPassword: 'ssh-secret', gatewayToken: 'gateway-token', gatewayPassword: 'gateway-password' } },
  ]
  for (const entry of cases) {
    const bridge = connectionBridge()
    const input: SshInstanceInput = {
      id: 'combo', label: 'Combo', kind: entry.kind, transport: entry.transport,
      host: 'combo.example.com', remotePort: entry.kind === 'gateway' ? 30801 : 30800,
    }
    const result = await saveHostWithConnectionCredentials(bridge, null, input, {
      sshPassword: 'ssh-secret', token: 'gateway-token', password: 'gateway-password',
    })
    assert.equal(result.ok, true, `${entry.kind}+${entry.transport}`)
    assert.deepEqual(bridge.calls, [{ previousId: null, input, credentials: entry.expected }], `${entry.kind}+${entry.transport}`)
  }
})

test('gateway+ssh edit submits both auth layers once and forwards a loud main rollback result unchanged', async () => {
  const existing = specGatewaySsh({ sshPasswordSet: true, tokenSet: true, passwordSet: true })
  const edited = { ...existing, label: 'Renamed' }
  const bridge = connectionBridge({
    initial: [existing],
    result: () => ({ ok: false, instances: [existing], error: 'main transaction rolled back', metadataCommitted: false }),
  })
  const result = await saveHostWithConnectionCredentials(bridge, existing.id, edited, {
    sshPassword: 'new-ssh', token: 'new-token', password: 'new-gateway-password',
  })
  assert.deepEqual(result, { ok: false, instances: [existing], error: 'main transaction rolled back', metadataCommitted: false })
  assert.deepEqual(bridge.calls, [{
    previousId: existing.id,
    input: edited,
    credentials: { sshPassword: 'new-ssh', gatewayToken: 'new-token', gatewayPassword: 'new-gateway-password' },
  }])
})

test('credential re-entry follows the independent gateway and SSH ownership domains', () => {
  const allStored = specGatewaySsh({ sshPasswordSet: true, tokenSet: true, passwordSet: true })
  assert.deepEqual(credentialReentryFor(allStored, { ...allStored, host: 'new.example.com' }), {
    sshPassword: true, gatewayToken: true, gatewayPassword: true,
  })
  assert.deepEqual(credentialReentryFor(allStored, { ...allStored, user: 'bob' }), {
    sshPassword: true, gatewayToken: false, gatewayPassword: false,
  }, 'SSH user retarget belongs only to SSH auth')
  assert.deepEqual(credentialReentryFor(allStored, { ...allStored, remotePort: 30802 }), {
    sshPassword: false, gatewayToken: true, gatewayPassword: true,
  }, 'gateway port retarget belongs only to gateway auth')
  assert.deepEqual(credentialReentryFor(allStored, {
    ...allStored,
    transport: 'http',
    user: null,
    sshPort: null,
    serviceName: null,
    remoteDshHome: null,
  }), {
    sshPassword: false, gatewayToken: false, gatewayPassword: false,
  }, 'real ssh→http normalization drops SSH-only fields without retargeting gateway auth')

  const keyAndNoAuth = specGatewaySsh({ sshPasswordSet: false, tokenSet: false, passwordSet: false })
  assert.deepEqual(credentialReentryFor(keyAndNoAuth, { ...keyAndNoAuth, host: 'new.example.com' }), {
    sshPassword: false, gatewayToken: false, gatewayPassword: false,
  })
  const dshSsh = { ...allStored, kind: 'dsh' as const, tokenSet: false, passwordSet: false }
  assert.deepEqual(credentialReentryFor(dshSsh, { ...dshSsh, kind: 'gateway' }), {
    sshPassword: false, gatewayToken: false, gatewayPassword: false,
  }, 'kind-only switch on one SSH endpoint preserves its transport password')
  assert.deepEqual(credentialReentryFor(dshSsh, { ...dshSsh, kind: 'gateway', host: 'other.example.com' }), {
    sshPassword: true, gatewayToken: false, gatewayPassword: false,
  })
})

test('gateway password validation mirrors the 12-1024 Unicode-capable server gate', () => {
  assert.equal(gatewayPasswordValidationError(''), null)
  assert.equal(gatewayPasswordValidationError('a'.repeat(11)), 'length')
  assert.equal(gatewayPasswordValidationError('a'.repeat(12)), null)
  assert.equal(gatewayPasswordValidationError('correct horse battery'), null)
  assert.equal(gatewayPasswordValidationError('a'.repeat(1024)), null)
  assert.equal(gatewayPasswordValidationError('a'.repeat(1025)), 'length')
  assert.equal(gatewayPasswordValidationError('正确的网关登录密码🔐很安全'), null)
  assert.equal(gatewayPasswordValidationError('line\nbreak-more'), null)
  assert.equal(gatewayPasswordValidationError('tab\there-more'), null)
})

test('registry target mirror excludes transport/protocol/SPKI/label but includes host/port/kind', () => {
  const previous = specGatewaySsh()
  assert.equal(transportTargetChangedSpec(previous, { ...previous, label: 'Renamed' }), false)
  assert.equal(transportTargetChangedSpec(previous, { ...previous, transport: 'http' }), false)
  assert.equal(transportTargetChangedSpec(previous, { ...previous, insecureHttp: true }), false)
  assert.equal(transportTargetChangedSpec(previous, { ...previous, spkiPin: 'ab'.repeat(32) }), false)
  assert.equal(transportTargetChangedSpec(previous, { ...previous, host: 'other.example.com' }), true)
  assert.equal(transportTargetChangedSpec(previous, { ...previous, remotePort: 443 }), true)
  assert.equal(transportTargetChangedSpec(previous, { ...previous, kind: 'dsh' }), true)
})

test('registry target mirror normalizes omitted input fields like the main process', () => {
  const previous: SshInstanceSpec = {
    id: 'minimal', label: 'Minimal', kind: 'dsh', transport: 'ssh', host: 'host.example.com',
    user: null, sshPort: null, remotePort: 30800, serviceName: null, remoteDshHome: null, insecureHttp: false,
    sourceFingerprint: 'test-proof:minimal',
  }
  assert.equal(transportTargetChangedSpec(previous, {
    id: previous.id, label: previous.label, host: previous.host, remotePort: previous.remotePort,
  }), false)
})

test('gateway URL parser accepts credential-free http/https origins and formatter round-trips defaults', () => {
  assert.deepEqual(parseGatewayUrl('https://gateway.example.com'), {
    ok: true, scheme: 'https', host: 'gateway.example.com', port: 443, origin: 'https://gateway.example.com',
  })
  assert.deepEqual(parseGatewayUrl('http://gateway.example.com'), {
    ok: true, scheme: 'http', host: 'gateway.example.com', port: 80, origin: 'http://gateway.example.com',
  })
  assert.equal(formatGatewayUrl('gateway.example.com', 443, false), 'https://gateway.example.com')
  assert.equal(formatGatewayUrl('gateway.example.com', 80, true), 'http://gateway.example.com')
})
