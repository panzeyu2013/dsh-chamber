import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SshInstanceSpec, TransportKind, TransportMethod } from '../global.d.ts'
import {
  changeDraftEndpointUrl,
  changeDraftKind,
  changeDraftTransport,
  credentialCapabilitiesFor,
  draftFromSpec,
  draftToInput,
  EMPTY_DRAFT,
  nextDefaultedRemotePort,
  SERVICE_NAME_PATTERN,
  spkiPinEligible,
  spkiPinValidationError,
  TRANSPORT_FORM_OPTIONS,
  transportFormSchema,
  transportSupportsTarget,
  type HostDraft,
} from './connection-form.ts'

const PIN = 'A1'.repeat(32)

function draft(overrides: Partial<HostDraft>): HostDraft {
  return { ...EMPTY_DRAFT, id: 'one', label: 'One', ...overrides }
}

function spec(overrides: Partial<SshInstanceSpec>): SshInstanceSpec {
  return {
    id: 'one',
    label: 'One',
    kind: 'dsh',
    transport: 'ssh',
    host: 'host.example.com',
    user: null,
    sshPort: null,
    remotePort: 30800,
    serviceName: null,
    remoteDshHome: null,
    insecureHttp: false,
    ...overrides,
  }
}

test('transport schema registry exposes both shipped field groups to both target kinds', () => {
  assert.deepEqual(TRANSPORT_FORM_OPTIONS.map(schema => schema.method), ['ssh', 'http'])
  assert.equal(transportFormSchema('ssh').fieldGroup, 'ssh')
  assert.equal(transportFormSchema('http').fieldGroup, 'url')
  for (const kind of ['dsh', 'gateway'] as const) {
    for (const method of ['ssh', 'http'] as const) {
      assert.equal(transportSupportsTarget(method, kind), true, `${kind}+${method}`)
    }
  }
  assert.deepEqual(transportFormSchema('ssh').defaultRemotePort, { dsh: 30800, gateway: 30801 })
})

test('service unit input rejects option-shaped names and accepts normal systemd units', () => {
  assert.equal(SERVICE_NAME_PATTERN.test('-x'), false)
  assert.equal(SERVICE_NAME_PATTERN.test('--user'), false)
  assert.equal(SERVICE_NAME_PATTERN.test('my-unit.service'), true)
})

test('credential capability matrix keeps gateway target auth and SSH transport auth independent', () => {
  const matrix: Array<[TransportKind, TransportMethod, { sshPassword: boolean; gatewayAuth: boolean }]> = [
    ['dsh', 'ssh', { sshPassword: true, gatewayAuth: false }],
    ['dsh', 'http', { sshPassword: false, gatewayAuth: false }],
    ['gateway', 'ssh', { sshPassword: true, gatewayAuth: true }],
    ['gateway', 'http', { sshPassword: false, gatewayAuth: true }],
  ]
  for (const [kind, method, expected] of matrix) {
    assert.deepEqual(credentialCapabilitiesFor(kind, method), expected, `${kind}+${method}`)
  }
})

test('draftToInput derives all four target/transport combinations without leaking inapplicable fields', () => {
  const dshSsh = draftToInput(draft({
    kind: 'dsh', transport: 'ssh', host: 'ssh.example.com', user: 'alice', sshPort: '2222', remotePort: '30800',
    gatewayToken: 'must-not-leak', gatewayPassword: 'must-not-leak', spkiPin: PIN,
  }))
  assert.deepEqual(dshSsh, {
    kind: 'dsh', transport: 'ssh', id: 'one', label: 'One', host: 'ssh.example.com',
    user: 'alice', sshPort: 2222, remotePort: 30800,
  })

  const dshHttp = draftToInput(draft({
    kind: 'dsh', transport: 'http', gatewayUrl: 'https://dsh.example.com:30800',
    gatewayToken: 'must-not-leak', gatewayPassword: 'must-not-leak', password: 'must-not-leak', spkiPin: PIN,
  }))
  assert.deepEqual(dshHttp, {
    kind: 'dsh', transport: 'http', id: 'one', label: 'One', host: 'dsh.example.com',
    remotePort: 30800, insecureHttp: false,
  })

  const gatewaySsh = draftToInput(draft({
    kind: 'gateway', transport: 'ssh', host: 'tunnel.example.com', remotePort: '30801', spkiPin: PIN,
  }))
  assert.deepEqual(gatewaySsh, {
    kind: 'gateway', transport: 'ssh', id: 'one', label: 'One', host: 'tunnel.example.com', remotePort: 30801,
  })

  const gatewayHttps = draftToInput(draft({
    kind: 'gateway', transport: 'http', gatewayUrl: 'https://gateway.example.com', spkiPin: PIN,
  }))
  assert.deepEqual(gatewayHttps, {
    kind: 'gateway', transport: 'http', id: 'one', label: 'One', host: 'gateway.example.com',
    remotePort: 443, insecureHttp: false, spkiPin: PIN.toLowerCase(),
  })
})

test('SPKI is HTTPS-gateway-only and explicit plaintext editing clears the draft pin', () => {
  const https = draft({ kind: 'gateway', transport: 'http', gatewayUrl: 'https://gateway.example.com', spkiPin: PIN })
  assert.equal(spkiPinEligible(https), true)
  assert.equal(spkiPinValidationError(PIN), null)
  assert.equal(spkiPinValidationError('ab12'), 'format')

  const plaintext = changeDraftEndpointUrl(https, 'http://gateway.example.com')
  assert.equal(plaintext.spkiPin, '')
  assert.equal(spkiPinEligible(plaintext), false)
  assert.equal('spkiPin' in draftToInput({ ...plaintext, spkiPin: PIN }), false, 'stale hidden pin must not be submitted')
  assert.equal('spkiPin' in draftToInput({ ...https, kind: 'dsh' }), false, 'non-gateway pin must not be submitted')
  assert.equal('spkiPin' in draftToInput({ ...https, transport: 'ssh', host: 'gateway.example.com', remotePort: '30801' }), false, 'SSH pin must not be submitted')
})

test('edit backfill round-trips dsh+http and preserves a gateway HTTPS pin on label-only saves', () => {
  const directDsh = draftFromSpec(spec({ kind: 'dsh', transport: 'http', host: 'dsh.example.com', remotePort: 30800 }))
  assert.equal(directDsh.gatewayUrl, 'https://dsh.example.com:30800')
  assert.equal(directDsh.spkiPin, '')

  const pinned = spec({
    kind: 'gateway', transport: 'http', host: 'gateway.example.com', remotePort: 443, spkiPin: PIN.toLowerCase(),
  })
  const edited = draftFromSpec(pinned)
  assert.equal(edited.spkiPin, PIN.toLowerCase())
  assert.equal(edited.gatewayUrl, 'https://gateway.example.com')
  assert.deepEqual(draftToInput({ ...edited, label: 'Renamed' }), {
    kind: 'gateway', transport: 'http', id: 'one', label: 'Renamed', host: 'gateway.example.com',
    remotePort: 443, insecureHttp: false, spkiPin: PIN.toLowerCase(),
  })
  assert.equal('spkiPin' in draftToInput({ ...edited, spkiPin: '' }), false, 'explicit clear removes the registry pin')
})

test('edit backfill covers all four target/transport combinations with write-only fields empty', () => {
  const cases: Array<[SshInstanceSpec, Partial<HostDraft>]> = [
    [spec({ kind: 'dsh', transport: 'ssh', remotePort: 30800 }), { kind: 'dsh', transport: 'ssh', gatewayUrl: '' }],
    [spec({ kind: 'dsh', transport: 'http', host: 'dsh.example.com', remotePort: 30800 }), { kind: 'dsh', transport: 'http', gatewayUrl: 'https://dsh.example.com:30800' }],
    [spec({ kind: 'gateway', transport: 'ssh', remotePort: 30801 }), { kind: 'gateway', transport: 'ssh', gatewayUrl: '' }],
    [spec({ kind: 'gateway', transport: 'http', host: 'gateway.example.com', remotePort: 443, spkiPin: PIN.toLowerCase() }), {
      kind: 'gateway', transport: 'http', gatewayUrl: 'https://gateway.example.com', spkiPin: PIN.toLowerCase(),
    }],
  ]
  for (const [entry, expected] of cases) {
    const editDraft = draftFromSpec(entry)
    assert.deepEqual({
      kind: editDraft.kind,
      transport: editDraft.transport,
      gatewayUrl: editDraft.gatewayUrl,
      ...(editDraft.spkiPin === '' ? {} : { spkiPin: editDraft.spkiPin }),
    }, expected, `${entry.kind}+${entry.transport}`)
    assert.equal(editDraft.password, '', 'SSH password remains write-only')
    assert.equal(editDraft.gatewayToken, '', 'gateway token remains write-only')
    assert.equal(editDraft.gatewayPassword, '', 'gateway password remains write-only')
    const roundTripped = draftToInput(editDraft)
    assert.equal(roundTripped.kind, entry.kind)
    assert.equal(roundTripped.transport, entry.transport)
    assert.equal(roundTripped.host, entry.host)
    assert.equal(roundTripped.remotePort, entry.remotePort)
  }
})

test('kind and transport changes stay orthogonal, clear only transiently inapplicable fields, and preserve custom ports', () => {
  const initial = draft({
    kind: 'dsh', transport: 'http', remotePort: '30800', gatewayUrl: 'https://dsh.example.com:30800',
    password: 'ssh-secret', gatewayToken: 'token', gatewayPassword: 'password', spkiPin: PIN,
  })
  const gateway = changeDraftKind(initial, 'gateway')
  assert.equal(gateway.transport, 'http', 'kind change must preserve transport')
  assert.equal(gateway.remotePort, '443')
  assert.equal(gateway.password, '')
  assert.equal(gateway.gatewayToken, '')
  assert.equal(gateway.gatewayPassword, '')
  assert.equal(gateway.spkiPin, '')

  const tunneled = changeDraftTransport({ ...gateway, gatewayToken: 'new-token', gatewayPassword: 'new-password', spkiPin: PIN }, 'ssh')
  assert.equal(tunneled.kind, 'gateway', 'transport change must preserve target')
  assert.equal(tunneled.remotePort, '30801')
  assert.equal(tunneled.gatewayToken, 'new-token', 'gateway target auth survives a transport choice change')
  assert.equal(tunneled.gatewayPassword, 'new-password')
  assert.equal(tunneled.spkiPin, '', 'SPKI cannot survive leaving direct HTTPS')

  assert.equal(nextDefaultedRemotePort('9443', 'gateway', 'http', 'dsh', 'ssh'), '9443', 'custom port survives')
})
