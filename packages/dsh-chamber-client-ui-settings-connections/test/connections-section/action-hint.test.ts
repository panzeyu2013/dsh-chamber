/**
 * actionHintKey / isUserActionPhase unit tests — the repair-direction hint
 * selection for terminal connection failures: an instance-level probe failure
 * must never render the SSH auth-failure hint, because the tunnel itself is
 * fine.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SshInstanceSpec, SshStatusProjection, SshPhase } from '../../src/global.d.ts'
import { actionHintKey, isUserActionPhase } from '../../src/client/action-hint.ts'

function spec(overrides: Partial<SshInstanceSpec> = {}): SshInstanceSpec {
  return {
    id: 's1', label: 's1', kind: 'dsh', transport: 'ssh', host: 'example.com',
    user: null, sshPort: null, remotePort: 30800, serviceName: null, remoteDshHome: null,
    sourceFingerprint: 'test', insecureHttp: false, ...overrides,
  }
}

function status(overrides: Partial<SshStatusProjection> = {}): SshStatusProjection {
  return {
    kind: 'dsh', transport: 'ssh', insecureHttp: false, phase: 'error',
    localPort: null, transportSocket: 'tcp', sshPort: null, remotePort: 30800, retryAttempt: 0,
    requiresUserAction: true, userActionKind: 'endpoint', serviceActive: null, remoteDshHome: null,
    logSummary: 'the destination answered HTTP 404 to the dsh identity probe', ...overrides,
  }
}

test('isUserActionPhase admits the terminal card phases plus a terminal re-check', () => {
  // connecting is admitted because a provider-declared retryable terminal verdict
  // re-probes in that phase while keeping requiresUserAction true.
  for (const phase of ['error', 'degraded', 'connecting'] as SshPhase[]) {
    assert.equal(isUserActionPhase(phase), true, `${phase} is a user-action phase`)
  }
  for (const phase of ['idle', 'ready'] as SshPhase[]) {
    assert.equal(isUserActionPhase(phase), false, `${phase} is not a user-action phase`)
  }
  assert.equal(isUserActionPhase(undefined), false)
})

test('no hint without requiresUserAction or on a non-terminal phase', () => {
  assert.equal(actionHintKey(spec(), status({ requiresUserAction: false }), 'error'), null)
  assert.equal(actionHintKey(spec(), status(), 'idle'), null)
  assert.equal(actionHintKey(spec(), status(), undefined), null)
  assert.equal(actionHintKey(spec(), undefined, 'error'), null)
})

test('a terminal re-check in connecting keeps the repair hint', () => {
  // The background re-probe runs in connecting; requiresUserAction stays true so
  // the user still sees what to fix while the probe is in flight.
  assert.equal(actionHintKey(spec(), status(), 'connecting'), 'endpointActionHint')
  assert.equal(actionHintKey(spec({ kind: 'gateway' }), status({ kind: 'gateway', userActionKind: 'endpoint' }), 'connecting'), 'gatewayAuthActionHint')
})

test('dsh over SSH: an endpoint-class failure shows the instance hint, never the SSH auth hint', () => {
  // The case this guards: a deterministic probe failure (e.g. HTTP 404 from a
  // dsh instance with breaking changes) must not render the SSH auth-failure
  // hint when the tunnel is fine.
  const s = status({ userActionKind: 'endpoint' })
  assert.equal(actionHintKey(spec(), s, 'error'), 'endpointActionHint')
  assert.equal(actionHintKey(spec(), s, 'degraded'), 'endpointActionHint')
})

test('dsh over SSH: an auth-class failure keeps the SSH auth hint', () => {
  const s = status({ userActionKind: 'auth' })
  assert.equal(actionHintKey(spec(), s, 'error'), 'authActionHint')
  // Unknown/legacy projections (no userActionKind) keep the conservative
  // auth hint — the previous behavior.
  const legacy = status({ userActionKind: null })
  assert.equal(actionHintKey(spec(), legacy, 'error'), 'authActionHint')
})

test('a spawn-environment failure shows PATH/permission guidance, not an auth hint', () => {
  const s = status({ userActionKind: 'environment' })
  assert.equal(actionHintKey(spec(), s, 'error'), 'environmentActionHint')
  assert.notEqual(actionHintKey(spec(), s, 'error'), 'authActionHint')
})

test('P0-3: a hostkey-class failure shows the fingerprint hint — even on gateway targets', () => {
  const s = status({ userActionKind: 'hostkey', hostKey: { state: 'unknown', fingerprints: ['SHA256:abc'] } })
  assert.equal(actionHintKey(spec(), s, 'error'), 'hostKeyActionHint')
  // The credential repair hint would be a lie: the tunnel never trusted the host key.
  assert.notEqual(actionHintKey(spec(), s, 'error'), 'authActionHint')
  const gatewaySsh = spec({ kind: 'gateway', transport: 'ssh' })
  assert.equal(
    actionHintKey(gatewaySsh, status({ kind: 'gateway', transport: 'ssh', userActionKind: 'hostkey' }), 'error'),
    'hostKeyActionHint',
    'a gateway over ssh must not be told to re-enter its token for a host-key failure',
  )
})

test('http direct and gateway targets keep their own hints regardless of the class', () => {
  const dshHttp = spec({ kind: 'dsh', transport: 'http' })
  assert.equal(actionHintKey(dshHttp, status({ transport: 'http', userActionKind: 'endpoint' }), 'error'), 'directActionHint')
  const gatewaySsh = spec({ kind: 'gateway', transport: 'ssh' })
  assert.equal(actionHintKey(gatewaySsh, status({ kind: 'gateway', transport: 'ssh', userActionKind: 'endpoint' }), 'error'), 'gatewayAuthActionHint')
  const gatewayHttp = spec({ kind: 'gateway', transport: 'http' })
  assert.equal(actionHintKey(gatewayHttp, status({ kind: 'gateway', transport: 'http', userActionKind: 'auth' }), 'error'), 'gatewayAuthActionHint')
})
