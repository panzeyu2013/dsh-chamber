import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOpenInLaunchRequest,
  describeOpenInError,
  parseOpenInApps,
  parseOpenInResult,
  parseOpenInSource,
  parseOpenInSourceFingerprint,
  usableOpenInApps,
  type OpenInApp,
} from '../src/shared/capabilities.ts'

const validApps: OpenInApp[] = [
  { id: 'finder', displayKind: 'file-manager', remoteCapable: false, available: true },
  { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: true },
]

test('parseOpenInApps strictly accepts the capability projection', () => {
  assert.deepEqual(parseOpenInApps(validApps), validApps)
  assert.equal(parseOpenInApps(null), null)
  assert.equal(parseOpenInApps({ apps: validApps }), null)
})

test('parseOpenInApps drops malformed or duplicate entries without erasing valid siblings', () => {
  const hostileEntry = new Proxy({}, {
    get() { throw new Error('capability getter exploded') },
  })
  assert.deepEqual(parseOpenInApps([
    validApps[0],
    null,
    hostileEntry,
    { ...validApps[1], available: 'yes' },
    { ...validApps[1], remoteCapable: 1 },
    { ...validApps[1], displayKind: '' },
    { ...validApps[1], id: '../vscode' },
    validApps[1],
    { ...validApps[1], displayKind: 'future-kind' },
  ]), validApps)
})

test('parseOpenInResult accepts only the documented success/error union', () => {
  assert.deepEqual(parseOpenInResult({ ok: true }), { ok: true })
  assert.deepEqual(parseOpenInResult({ ok: false, error: 'launch failed' }), { ok: false, error: 'launch failed' })
  for (const result of [undefined, null, true, {}, { ok: 'true' }, { ok: false }, { ok: false, error: '' }, { ok: false, error: 42 }]) {
    assert.equal(parseOpenInResult(result), null)
  }

  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error('prototype trap') },
    get() { throw new Error('get trap') },
  })
  assert.equal(parseOpenInResult(hostile), null)
  assert.equal(describeOpenInError(hostile), 'unknown error')
})

test('parseOpenInSource accepts canonical kind × transport pairs plus the legacy ssh source alias', () => {
  assert.deepEqual(parseOpenInSource('local', 'local'), {
    sourceId: 'local',
    instanceId: 'local',
    local: true,
    transport: 'local',
  })
  assert.deepEqual(parseOpenInSource('dsh-dev_01', 'ssh'), {
    sourceId: 'dsh-dev_01',
    instanceId: 'dev_01',
    local: false,
    transport: 'ssh',
  })
  assert.deepEqual(parseOpenInSource('gateway-dev_01', 'http'), {
    sourceId: 'gateway-dev_01',
    instanceId: 'dev_01',
    local: false,
    transport: 'http',
  })
  assert.deepEqual(parseOpenInSource('ssh-dev_01', 'ssh'), {
    sourceId: 'ssh-dev_01',
    instanceId: 'dev_01',
    local: false,
    transport: 'ssh',
  })

  for (const sourceId of [undefined, null, '', 'remote-1', 'ssh-', 'ssh-local', 'ssh-bad/id', 'ssh-a.b', `ssh-${'a'.repeat(65)}`]) {
    assert.equal(parseOpenInSource(sourceId, 'ssh'), null, `expected ${String(sourceId)} to be rejected`)
  }
  assert.equal(parseOpenInSource('local', 'ssh'), null)
  assert.equal(parseOpenInSource('dsh-dev', 'local'), null)
  assert.equal(parseOpenInSource('gateway-dev', undefined), null)
})

test('open-in launch preserves the boot-bound proof across a same-id same-fields re-add', () => {
  const source = parseOpenInSource('dsh-dev', 'ssh')
  assert.ok(source !== null)
  const oldFingerprint = 'a'.repeat(64)
  const replacementFingerprint = 'b'.repeat(64)
  assert.equal(parseOpenInSourceFingerprint(source, oldFingerprint), oldFingerprint)
  assert.equal(parseOpenInSourceFingerprint(source, replacementFingerprint), replacementFingerprint)
  assert.equal(parseOpenInSourceFingerprint(source, 'A'.repeat(64)), null)

  const oldButtonRequest = buildOpenInLaunchRequest('vscode', source, '/workspace', oldFingerprint)
  assert.deepEqual(oldButtonRequest, {
    appId: 'vscode',
    instanceId: 'dev',
    path: '/workspace',
    sourceFingerprint: oldFingerprint,
  })
  assert.notEqual(oldButtonRequest.sourceFingerprint, replacementFingerprint,
    'an old mounted button never reads the replacement roster fingerprint')
  assert.equal(parseOpenInSourceFingerprint(parseOpenInSource('local', 'local')!, 'local'), 'local')
  assert.equal(parseOpenInSourceFingerprint(parseOpenInSource('local', 'local')!, oldFingerprint), null)
})

test('usableOpenInApps filters by transport, independently of dsh/gateway target kind', () => {
  const local = parseOpenInSource('local', 'local')
  const dshSsh = parseOpenInSource('dsh-dev', 'ssh')
  const gatewaySsh = parseOpenInSource('gateway-gw', 'ssh')
  const dshHttp = parseOpenInSource('dsh-direct', 'http')
  const gatewayHttp = parseOpenInSource('gateway-direct', 'http')
  assert.ok(local !== null && dshSsh !== null && gatewaySsh !== null && dshHttp !== null && gatewayHttp !== null)

  const unavailable: OpenInApp = {
    id: 'future',
    displayKind: 'future',
    remoteCapable: true,
    available: false,
  }
  assert.deepEqual(usableOpenInApps([...validApps, unavailable], local), validApps)
  assert.deepEqual(usableOpenInApps([...validApps, unavailable], dshSsh), [validApps[1]])
  assert.deepEqual(usableOpenInApps([...validApps, unavailable], gatewaySsh), [validApps[1]])
  assert.deepEqual(usableOpenInApps([...validApps, unavailable], dshHttp), [])
  assert.deepEqual(usableOpenInApps([...validApps, unavailable], gatewayHttp), [])
  assert.deepEqual(usableOpenInApps(null, local), [])
})
