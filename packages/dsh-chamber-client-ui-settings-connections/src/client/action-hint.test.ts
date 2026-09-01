/**
 * actionHintKey / isUserActionPhase unit tests — the repair-direction hint
 * selection for terminal connection failures (2026-08 UI misdirection fix:
 * an instance-level probe failure must never render the SSH auth-failure
 * hint, because the tunnel itself is fine).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SshInstanceSpec, SshStatusProjection, SshPhase } from '../global.d.ts'
import { actionHintKey, isUserActionPhase } from './action-hint.ts'

function spec(overrides: Partial<SshInstanceSpec> = {}): SshInstanceSpec {
  return {
    id: 's1',
    label: 's1',
    kind: 'dsh',
    transport: 'ssh',
    host: 'example.com',
    user: null,
    sshPort: null,
    remotePort: 30800,
    serviceName: null,
    remoteDshHome: null,
    sourceFingerprint: 'test',
    insecureHttp: false,
    ...overrides,
  }
}

function status(overrides: Partial<SshStatusProjection> = {}): SshStatusProjection {
  return {
    kind: 'dsh',
    transport: 'ssh',
    insecureHttp: false,
    phase: 'error',
    localPort: null,
    sshPort: null,
    remotePort: 30800,
    retryAttempt: 0,
    requiresUserAction: true,
    userActionKind: 'endpoint',
    serviceActive: null,
    remoteDshHome: null,
    logSummary: 'the destination answered HTTP 404 to the dsh identity probe',
    ...overrides,
  }
}

test('isUserActionPhase admits only the terminal card phases', () => {
  for (const phase of ['error', 'degraded'] as SshPhase[]) {
    assert.equal(isUserActionPhase(phase), true, `${phase} is a user-action phase`)
  }
  for (const phase of ['idle', 'connecting', 'ready'] as SshPhase[]) {
    assert.equal(isUserActionPhase(phase), false, `${phase} is not a user-action phase`)
  }
  assert.equal(isUserActionPhase(undefined), false)
})

test('no hint without requiresUserAction or on a non-terminal phase', () => {
  assert.equal(actionHintKey(spec(), status({ requiresUserAction: false }), 'error'), null)
  assert.equal(actionHintKey(spec(), status(), 'connecting'), null)
  assert.equal(actionHintKey(spec(), status(), undefined), null)
  assert.equal(actionHintKey(spec(), undefined, 'error'), null)
})

test('dsh over SSH: an endpoint-class failure shows the instance hint, never the SSH auth hint', () => {
  // The exact regression: a deterministic probe failure (e.g. HTTP 404 from
  // a dsh instance with breaking changes) used to render the SSH
  // auth-failure hint although the tunnel was fine.
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

test('http direct and gateway targets keep their own hints regardless of the class', () => {
  const dshHttp = spec({ kind: 'dsh', transport: 'http' })
  assert.equal(actionHintKey(dshHttp, status({ transport: 'http', userActionKind: 'endpoint' }), 'error'), 'directActionHint')
  const gatewaySsh = spec({ kind: 'gateway', transport: 'ssh' })
  assert.equal(actionHintKey(gatewaySsh, status({ kind: 'gateway', transport: 'ssh', userActionKind: 'endpoint' }), 'error'), 'gatewayAuthActionHint')
  const gatewayHttp = spec({ kind: 'gateway', transport: 'http' })
  assert.equal(actionHintKey(gatewayHttp, status({ kind: 'gateway', transport: 'http', userActionKind: 'auth' }), 'error'), 'gatewayAuthActionHint')
})
