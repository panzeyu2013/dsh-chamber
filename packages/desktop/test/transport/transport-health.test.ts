import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  INITIAL_LINK_HEALTH,
  LINK_POLICY,
  classifyProbeFailure,
  reduceLinkHealth,
  type LinkHealthState,
} from '../../transport-health.ts'

const suspect = (state: LinkHealthState = INITIAL_LINK_HEALTH): LinkHealthState =>
  reduceLinkHealth(state, { kind: 'probe-failure', at: 1_000, failureClass: 'network' }).state

test('one network failure only marks suspect', () => {
  const result = reduceLinkHealth(INITIAL_LINK_HEALTH, {
    kind: 'probe-failure', at: 1_000, failureClass: 'network', reason: 'timeout',
  })
  assert.equal(result.state.health, 'suspect')
  assert.equal(result.state.consecutiveNetworkFailures, 1)
  assert.equal(result.becameDown, false)
  assert.equal(result.nextProbeDelayMs, LINK_POLICY.suspectProbeIntervalMs)
})

test('second consecutive network failure marks down and asks for reconnect', () => {
  const result = reduceLinkHealth(suspect(), {
    kind: 'probe-failure', at: 2_000, failureClass: 'network', reason: 'timeout',
  })
  assert.equal(result.state.health, 'down')
  assert.equal(result.state.consecutiveNetworkFailures, 2)
  assert.equal(result.becameDown, true)
  assert.equal(result.nextProbeDelayMs, null)
})

test('a successful probe clears the streak and recovers from down', () => {
  const down = reduceLinkHealth(suspect(), {
    kind: 'probe-failure', at: 2_000, failureClass: 'network',
  }).state
  const result = reduceLinkHealth(down, { kind: 'probe-ok', at: 3_000 })
  assert.equal(result.state.health, 'healthy')
  assert.equal(result.state.consecutiveNetworkFailures, 0)
  assert.equal(result.becameHealthy, true)
  assert.equal(result.nextProbeDelayMs, LINK_POLICY.healthyProbeIntervalMs)
})

test('server/auth failures from healthy are suspect but do not accumulate', () => {
  const server = reduceLinkHealth(INITIAL_LINK_HEALTH, {
    kind: 'probe-failure', at: 1_000, failureClass: 'server', reason: '503',
  })
  assert.equal(server.state.health, 'suspect')
  assert.equal(server.state.consecutiveNetworkFailures, 0)

  const auth = reduceLinkHealth(INITIAL_LINK_HEALTH, {
    kind: 'probe-failure', at: 1_000, failureClass: 'auth', reason: '401',
  })
  assert.equal(auth.state.health, 'suspect')
  assert.equal(auth.state.consecutiveNetworkFailures, 0)
  // A reachable answer re-probes on the slower table cadence, not the suspect one:
  // retrying a busy/rejecting service every 2s adds load for no new information.
  assert.equal(server.nextProbeDelayMs, LINK_POLICY.reachableProbeIntervalMs)
  assert.equal(auth.nextProbeDelayMs, LINK_POLICY.reachableProbeIntervalMs)
})

test('a non-finite clock cannot authorize down', () => {
  const result = reduceLinkHealth(INITIAL_LINK_HEALTH, {
    kind: 'probe-failure', at: Number.NaN, failureClass: 'network',
  })
  assert.equal(result.state.health, 'suspect')
  assert.equal(result.becameDown, false)
  assert.equal(result.nextProbeDelayMs, LINK_POLICY.suspectProbeIntervalMs)
})

test('probe classification separates network, server, auth and protocol', () => {
  assert.equal(classifyProbeFailure({}), 'network')
  for (const statusCode of [500, 502, 503, 504, 408, 425, 429]) {
    assert.equal(classifyProbeFailure({ statusCode }), 'server', String(statusCode))
  }
  assert.equal(classifyProbeFailure({ statusCode: 401 }), 'auth')
  assert.equal(classifyProbeFailure({ statusCode: 404 }), 'protocol')
  assert.equal(classifyProbeFailure({ terminal: true }), 'protocol')
})

test('the policy table is pinned: a value change is a deliberate review, not a test tweak', () => {
  // These numbers ARE the contract (design 27 §3.2): the ordering/structure tests
  // compare against the same table, so only a literal pin can catch a silent value
  // change (a 30s heartbeat quietly becoming 60s would otherwise stay green).
  assert.deepEqual({ ...LINK_POLICY }, {
    probeTimeoutMs: 5_000,
    suspectProbeIntervalMs: 2_000,
    reachableProbeIntervalMs: 10_000,
    failureProbeMinIntervalMs: 2_000,
    healthyProbeIntervalMs: 30_000,
    watchProbeIntervalMs: 10_000,
    watchWindowMs: 120_000,
    failuresBeforeDown: 2,
    downGraceMs: 30_000,
  })
})

