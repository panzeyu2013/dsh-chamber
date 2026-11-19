/** active-registration (C slice, design 17 §9.3 / design 27 §3.3): ONE commit
 *  entry for the sidecar's proxy registration — two-phase accept→publish, the
 *  five-tuple lockstep, health-only zero re-registration, fail-closed auth revoke
 *  and the tombstone that refuses a late same/older-generation register.
 *  Pure injection: no plane/session/manager reality. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import {
  createActiveRegistrationRegistry,
  type ActiveRegistrationRegistry,
  type LiveRegistrationState,
  type RegistrationFacts,
  type RegistrationHealth,
} from '../../active-registration.ts'
import {
  gatewaySessionScopeForConnection,
  type GatewayRegistrationAuthProof,
  type GatewaySessionOrigin,
} from '../../gateway-session.ts'
import { gatewayTunnelAuthority } from '../../gateway-session-refresh.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'

const COOKIE = 'dsh_gateway_session=cookie-1'
const COOKIE_2 = 'dsh_gateway_session=cookie-2'
const PASSWORD = 'stored-password'
const PIN = 'a'.repeat(64)
const SOCKET_PATH = '/tmp/dsh-chamber/gw-1.sock'
const READY_URL = 'http://127.0.0.1:55001'

/** Narrow a value the test just proved exists (assert.ok does not narrow). */
function present<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error('expected ' + label)
  return value
}

function gatewaySpec(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'gw-1',
    label: 'gateway one',
    kind: 'gateway',
    transport: 'ssh',
    host: 'dev.example',
    user: 'me',
    sshPort: 22,
    remotePort: 39001,
    serviceName: null,
    remoteDshHome: null,
    insecureHttp: true,
    ...overrides,
  }
}

function dshSpec(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'dsh-1',
    label: 'dsh one',
    kind: 'dsh',
    transport: 'ssh',
    host: 'dev.example',
    user: 'me',
    sshPort: 22,
    remotePort: 39002,
    serviceName: null,
    remoteDshHome: null,
    insecureHttp: true,
    ...overrides,
  }
}

interface RegisterCall {
  connectionId: string
  url: string
  headers: Record<string, string> | undefined
  opts: Record<string, unknown>
}

interface HealthCall {
  connectionId: string
  health: RegistrationHealth
}

function fakePlane() {
  const calls = {
    register: [] as RegisterCall[],
    health: [] as HealthCall[],
    unregister: [] as string[],
  }
  const failure: { next: Error | null } = { next: null }
  const plane = {
    registerInstanceTransport(
      connectionId: string,
      url: string,
      headers?: Record<string, string>,
      opts?: Record<string, unknown>,
    ) {
      if (failure.next !== null) throw failure.next
      calls.register.push({ connectionId, url, headers, opts: opts ?? {} })
    },
    setInstanceTransportHealth(connectionId: string, health: RegistrationHealth) {
      calls.health.push({ connectionId, health })
    },
    unregisterInstanceTransport(connectionId: string) {
      calls.unregister.push(connectionId)
    },
  } as unknown as PlaneHandle
  return { calls, failure, plane }
}

function liveHarness(spec: TransportInstanceSpec) {
  const state = {
    incarnation: {} as object,
    transportGen: 1,
    readyOn: true,
    url: READY_URL,
    socketPath: null as string | null,
    health: 'healthy' as RegistrationHealth,
  }
  const snapshot = (): LiveRegistrationState => ({
    spec,
    incarnation: state.incarnation,
    transportGen: state.transportGen,
    transport: spec.transport === 'ssh' ? 'ssh' : 'http',
    ready: state.readyOn
      ? { url: state.url, socketPath: state.socketPath, health: state.health }
      : null,
  })
  return { state, snapshot }
}

interface SessionsState {
  cookie: string | null
  proof: GatewayRegistrationAuthProof | null
}

function fakeSessions(sessions: SessionsState) {
  return {
    cachedCookie: (_origin: GatewaySessionOrigin) => sessions.cookie,
    registrationAuthProof: (_origin: GatewaySessionOrigin) => sessions.proof,
  }
}

function harness(options: {
  spec?: TransportInstanceSpec
  password?: string | null
  token?: string | null
} = {}) {
  const spec = options.spec ?? gatewaySpec()
  const live = liveHarness(spec)
  const plane = fakePlane()
  const sessions: SessionsState = { cookie: COOKIE, proof: 'cookie' }
  const credentials = {
    password: options.password === undefined ? PASSWORD : options.password,
    token: options.token ?? null,
  }
  const registry: ActiveRegistrationRegistry = createActiveRegistrationRegistry({
    plane: () => plane.plane,
    live: id => (id === spec.id ? live.snapshot() : null),
    tokenFor: id => (id === spec.id ? credentials.token : null),
    passwordFor: id => (id === spec.id ? credentials.password : null),
    sessions: fakeSessions(sessions),
  })
  const commitRegister = (transportGen = live.state.transportGen) =>
    registry.commit({ kind: 'register', id: spec.id, transportGen })
  const syncRecord = (): RegistrationFacts | undefined => {
    const recordGen = registry.currentRecordGen(spec.id)
    return recordGen === undefined ? undefined : registry.snapshotForSync(spec.id, recordGen)?.facts
  }
  return { spec, live, plane, sessions, credentials, registry, commitRegister, syncRecord }
}

test('commit publishes exactly the tuple the proxy accepted (two-phase, single read surface)', () => {
  const h = harness({ spec: gatewaySpec({ spkiPin: PIN }) })
  h.live.state.socketPath = SOCKET_PATH
  const outcome = h.commitRegister()
  if (!outcome.ok) assert.fail('commit must be accepted: ' + outcome.reason)
  assert.equal(outcome.action, 'registered')
  assert.equal(h.plane.calls.register.length, 1)
  const accepted = h.plane.calls.register[0]
  const facts = present(h.syncRecord(), 'published record facts')
  // The five-tuple lockstep: the record is what the proxy was given, field by field.
  assert.equal(facts.url, accepted.url)
  assert.equal(facts.url, READY_URL)
  assert.equal(facts.socketPath, accepted.opts.socketPath)
  assert.equal(facts.socketPath, SOCKET_PATH)
  assert.equal(facts.authority, accepted.opts.authority)
  assert.equal(facts.authority, gatewayTunnelAuthority(h.spec.remotePort))
  assert.equal(facts.spkiPin, (accepted.opts.tls as { spkiPin?: string } | undefined)?.spkiPin)
  assert.equal(facts.spkiPin, PIN)
  assert.equal(facts.headers?.cookie, accepted.headers?.cookie)
  assert.equal(facts.headers?.cookie, COOKIE)
  assert.equal(accepted.opts.transport, 'ssh')
  assert.equal(accepted.connectionId, 'gateway:' + h.spec.id)
  // The non-secret snapshot is the only view without the credential field.
  const view = present(h.registry.snapshot(h.spec.id), 'registration view')
  assert.equal(Object.hasOwn(view.facts, 'headers'), false)
})

test('a proxy rejection publishes nothing, keeps the previous record and never throws', () => {
  const h = harness()
  assert.equal(h.commitRegister().ok, true)
  const before = h.registry.currentRecordGen(h.spec.id)
  h.sessions.cookie = COOKIE_2
  h.plane.failure.next = new TypeError('register refused: header not allowed')
  const outcome = h.commitRegister()
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'proxy-rejected')
  assert.match(outcome.error ?? '', /header not allowed/)
  assert.equal(h.registry.currentRecordGen(h.spec.id), before, 'the old record stays published')
  assert.equal(h.plane.calls.register.length, 1)
})

test('same target is health-only: zero registrations and the sync generation is kept', () => {
  const h = harness()
  assert.equal(h.commitRegister().ok, true)
  const firstGen = h.registry.currentRecordGen(h.spec.id)
  h.live.state.health = 'suspect'
  for (let round = 0; round < 4; round += 1) {
    const outcome = h.commitRegister()
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.action, 'health-only')
  }
  assert.equal(h.plane.calls.register.length, 1, 'no re-registration (it would revoke in-flight traffic)')
  assert.equal(h.plane.calls.health.length, 4)
  assert.equal(h.plane.calls.health[0].health, 'suspect')
  assert.equal(h.registry.currentRecordGen(h.spec.id), firstGen, 'health-only must not invalidate an in-flight sync')
  assert.equal(h.registry.snapshot(h.spec.id)?.health, 'suspect')
})

test('auth failure revokes the live registration and tombstones the generation', () => {
  const h = harness()
  assert.equal(h.commitRegister().ok, true)
  assert.equal(h.plane.calls.register.length, 1)
  h.sessions.cookie = null
  const failed = h.commitRegister()
  assert.equal(failed.ok, true)
  if (!failed.ok) return
  assert.equal(failed.action, 'revoked')
  if (failed.action !== 'revoked') return
  assert.equal(failed.reason, 'auth-failed')
  assert.deepEqual(h.plane.calls.unregister, ['gateway:' + h.spec.id])
  assert.equal(h.registry.snapshot(h.spec.id), undefined)
  assert.deepEqual(failed.recovery, {
    url: READY_URL,
    scope: gatewaySessionScopeForConnection(h.spec),
  })
  // A late same-generation register (the in-flight refresh landing after the revoke)
  // is refused by the tombstone: the proxy must not be revived on a dead session.
  const late = h.commitRegister()
  assert.equal(late.ok, false)
  if (late.ok) return
  assert.equal(late.reason, 'stale-generation')
  assert.equal(h.plane.calls.register.length, 1)
  // A NEWER tunnel generation (reconnect → fresh verifyUp session) is accepted.
  h.sessions.cookie = COOKIE_2
  h.live.state.transportGen += 1
  const recovered = h.commitRegister()
  assert.equal(recovered.ok, true)
  if (!recovered.ok) return
  assert.equal(recovered.action, 'registered')
  assert.equal(h.plane.calls.register.length, 2)
})

test('revoke is idempotent: one unregister, no second effect, record gone', () => {
  const h = harness()
  assert.equal(h.commitRegister().ok, true)
  h.live.state.readyOn = false
  const first = h.registry.commit({ kind: 'revoke', id: h.spec.id, reason: 'leave-ready' })
  const second = h.registry.commit({ kind: 'revoke', id: h.spec.id, reason: 'leave-ready' })
  assert.equal(first.ok && second.ok, true)
  assert.deepEqual(h.plane.calls.unregister, ['gateway:' + h.spec.id])
  assert.equal(h.registry.snapshot(h.spec.id), undefined)
})

test('a same-id re-add (new incarnation) is not blocked by the old tombstone', () => {
  const h = harness()
  assert.equal(h.commitRegister().ok, true)
  h.live.state.readyOn = false
  assert.equal(h.registry.commit({ kind: 'revoke', id: h.spec.id, reason: 'removed' }).ok, true)
  // Removal drops the manager state; a same-id re-add starts a NEW state object whose
  // numeric generation legitimately restarts lower than the retired one.
  h.live.state.incarnation = {}
  h.live.state.transportGen = 1
  h.live.state.readyOn = true
  const outcome = h.commitRegister()
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.action, 'registered')
  assert.equal(h.plane.calls.register.length, 2)
})

test('snapshotForSync hands out the record only at the caller generation', () => {
  const h = harness()
  assert.equal(h.commitRegister().ok, true)
  const firstGen = present(h.registry.currentRecordGen(h.spec.id), 'first generation')
  assert.equal(h.registry.snapshotForSync(h.spec.id, firstGen)?.facts.headers?.cookie, COOKIE)
  h.sessions.cookie = COOKIE_2
  assert.equal(h.commitRegister().ok, true)
  const secondGen = present(h.registry.currentRecordGen(h.spec.id), 'second generation')
  assert.notEqual(secondGen, firstGen)
  assert.equal(h.registry.snapshotForSync(h.spec.id, firstGen), undefined, 'a replaced registration must abort the sync')
  const record = present(h.registry.snapshotForSync(h.spec.id, secondGen), 'sync record')
  assert.equal(record.facts.headers?.cookie, COOKIE_2)
  // Defensive copy: callers cannot mutate the published credential.
  const headers = present(record.facts.headers, 'record headers')
  headers.cookie = 'mutated'
  assert.equal(h.registry.snapshotForSync(h.spec.id, secondGen)?.facts.headers?.cookie, COOKIE_2)
})

test('the pure health request never re-registers and refuses a stale generation', () => {
  const h = harness()
  assert.equal(h.commitRegister().ok, true)
  h.live.state.health = 'down'
  const outcome = h.registry.commit({ kind: 'health', id: h.spec.id, transportGen: h.live.state.transportGen })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.action, 'health-only')
  assert.deepEqual(h.plane.calls.health, [{ connectionId: 'gateway:' + h.spec.id, health: 'down' }])
  assert.equal(h.plane.calls.register.length, 1)
  h.live.state.transportGen += 1
  const stale = h.registry.commit({ kind: 'health', id: h.spec.id, transportGen: h.live.state.transportGen - 1 })
  assert.equal(stale.ok, false)
  if (stale.ok) return
  assert.equal(stale.reason, 'stale-generation')
  // Without a committed record the pure health path has nothing to apply.
  assert.equal(h.registry.commit({ kind: 'revoke', id: h.spec.id, reason: 'leave-ready' }).ok, true)
  const absent = h.registry.commit({ kind: 'health', id: h.spec.id, transportGen: h.live.state.transportGen })
  assert.equal(absent.ok, false)
})

test('a dsh target registers headerless without authority/pin', () => {
  const h = harness({ spec: dshSpec() })
  assert.equal(h.commitRegister().ok, true)
  const accepted = h.plane.calls.register[0]
  assert.equal(accepted.connectionId, 'dsh:' + h.spec.id)
  assert.equal(accepted.headers, undefined)
  assert.equal(accepted.opts.authority, undefined)
  assert.equal(accepted.opts.tls, undefined)
  const facts = present(h.syncRecord(), 'published record facts')
  assert.equal(facts.headers, undefined)
  assert.equal(facts.authority, undefined)
  // A repeated ready push degrades to health-only, exactly like a gateway.
  const again = h.commitRegister()
  assert.equal(again.ok, true)
  if (!again.ok) return
  assert.equal(again.action, 'health-only')
  assert.equal(h.plane.calls.register.length, 1)
})

test('an internal derivation failure is a refused commit, never a throw', () => {
  const h = harness({ spec: gatewaySpec({ remotePort: 0 }) })
  const outcome = h.commitRegister()
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'internal-error')
  assert.equal(h.plane.calls.register.length, 0)
  assert.equal(h.registry.snapshot(h.spec.id), undefined)
})

test('dispose clears records and tombstones', () => {
  const h = harness()
  assert.equal(h.commitRegister().ok, true)
  h.registry.dispose()
  assert.equal(h.registry.snapshot(h.spec.id), undefined)
  assert.equal(h.registry.currentRecordGen(h.spec.id), undefined)
  // A disposed registry is empty, so the old tombstone can no longer refuse a commit.
  const outcome = h.commitRegister()
  assert.equal(outcome.ok, true)
})
