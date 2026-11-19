/** ActiveRegistration wiring (C slice): the real status/verify subscription pair +
 *  the ONE commit registry + the manual-sync IPC entry, over fake plane/manager.
 *  Pins: ready → commit (five-tuple lockstep), health-only zero re-registration,
 *  leave-ready revoke, W5 fail-closed revoke WITH the committed status push, the
 *  tombstone refusing a late register, refresh → commit → snapshotForSync giving
 *  the SAME renewed cookie to the manual sync, and the non-throwing refresh leg. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import type { AuditEvent } from '../../audit-log.ts'
import {
  bindActiveRegistrationRegistry,
  createActiveRegistrationRegistry,
  createRegistrationLiveFacts,
  type ActiveRegistrationRegistry,
  type RegistrationHealth,
} from '../../active-registration.ts'
import {
  GATEWAY_SESSION_EXPIRY_SKEW_MS, GATEWAY_SESSION_TTL_MS, gatewaySessionScopeForConnection,
  type GatewayRegistrationAuthProof, type GatewaySessionOrigin,
} from '../../gateway-session.ts'
import {
  createGatewaySessionRefresh, GATEWAY_SESSION_REFRESH_LEAD_MS, gatewayTunnelAuthority,
} from '../../gateway-session-refresh.ts'
import { createTransportSubscriptions } from '../../host-transport-subscriptions.ts'
import { IPC_CHANNELS } from '../../ipc-events.ts'
import { registerGatewayPluginHandlers } from '../../shell-ipc-plugins-gateway.ts'
import type { ShellIpcCtx } from '../../shell-ipc-ctx.ts'
import type { TransportManager } from '../../transport-manager.ts'
import type { TransportInstanceSpec, TransportStatusProjection } from '../../transport-provider.ts'

const COOKIE = 'dsh_gateway_session=cookie-1'
const COOKIE_2 = 'dsh_gateway_session=cookie-2'
const PASSWORD = 'stored-password'
const READY_URL = 'http://127.0.0.1:55001'

function present<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error('expected ' + label)
  return value
}

function gatewaySpec(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'gw-1', label: 'gateway one', kind: 'gateway', transport: 'ssh', host: 'dev.example',
    user: 'me', sshPort: 22, remotePort: 39001, serviceName: null, remoteDshHome: null,
    insecureHttp: true, ...overrides,
  }
}

function dshSpec(): TransportInstanceSpec {
  return {
    id: 'dsh-1', label: 'dsh one', kind: 'dsh', transport: 'ssh', host: 'dev.example',
    user: 'me', sshPort: 22, remotePort: 39002, serviceName: null, remoteDshHome: null,
    insecureHttp: true,
  }
}

interface FakeInstance {
  spec: TransportInstanceSpec
  state: object
  gen: number
  ready: boolean
  url: string
  socketPath: string | null
  health: RegistrationHealth
}

function projectionFor(instance: FakeInstance): TransportStatusProjection {
  return {
    kind: instance.spec.kind,
    transport: instance.spec.transport,
    insecureHttp: instance.spec.insecureHttp,
    phase: instance.ready ? 'ready' : 'idle',
    localPort: instance.socketPath === null ? 55001 : null,
    transportSocket: instance.socketPath === null ? 'tcp' : 'unix',
    sshPort: instance.spec.sshPort,
    remotePort: instance.spec.remotePort,
    retryAttempt: 0,
    requiresUserAction: false,
    userActionKind: null,
    serviceActive: null,
    remoteDshHome: instance.spec.remoteDshHome,
    logSummary: '',
    link: { state: instance.health, linkEpoch: 1 },
  }
}

function fakeManager() {
  const instances = new Map<string, FakeInstance>()
  const statusListeners: Array<(id: string, status: TransportStatusProjection) => void> = []
  const verifiedListeners: Array<(id: string) => void> = []
  const logLines: Array<{ id: string; level: string; message: string }> = []
  const sm = {
    onStatusChanged(listener: (id: string, status: TransportStatusProjection) => void) {
      statusListeners.push(listener)
    },
    onVerified(listener: (id: string) => void) {
      verifiedListeners.push(listener)
    },
    status(id: string): TransportStatusProjection | null {
      const instance = instances.get(id)
      return instance === undefined ? null : projectionFor(instance)
    },
    listInstances(): TransportInstanceSpec[] {
      return [...instances.values()].map(instance => instance.spec)
    },
    readyUrl(id: string): string | null {
      const instance = instances.get(id)
      return instance !== undefined && instance.ready ? instance.url : null
    },
    readySocketPath(id: string): string | null {
      const instance = instances.get(id)
      return instance !== undefined && instance.ready ? instance.socketPath : null
    },
    getAttemptFacts(id: string): { state: object; tunnelEpoch: number } | null {
      const instance = instances.get(id)
      return instance === undefined ? null : { state: instance.state, tunnelEpoch: instance.gen }
    },
    appendLog(id: string, level: string, message: string): boolean {
      logLines.push({ id, level, message })
      return true
    },
  }
  const emitStatus = (id: string): void => {
    const instance = instances.get(id)
    if (instance === undefined) return
    const status = projectionFor(instance)
    for (const listener of statusListeners) listener(id, status)
  }
  const emitVerified = (id: string): void => {
    for (const listener of verifiedListeners) listener(id)
  }
  return { instances, sm, emitStatus, emitVerified, logLines }
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

function wiringHarness(spec: TransportInstanceSpec = gatewaySpec()) {
  const manager = fakeManager()
  const plane = fakePlane()
  const sessions: SessionsState = { cookie: COOKIE, proof: 'cookie' }
  const credentials = { password: PASSWORD as string | null, token: null as string | null }
  const instance: FakeInstance = {
    spec, state: {}, gen: 1, ready: false, url: READY_URL, socketPath: null, health: 'healthy',
  }
  manager.instances.set(spec.id, instance)
  const registry: ActiveRegistrationRegistry = createActiveRegistrationRegistry({
    plane: () => plane.plane,
    live: createRegistrationLiveFacts(manager.sm, transport => (transport === 'ssh' ? 'ssh' : 'http')),
    tokenFor: id => (id === spec.id ? credentials.token : null),
    passwordFor: id => (id === spec.id ? credentials.password : null),
    sessions: fakeSessions(sessions),
  })
  const refreshCalls: Array<{ id: string; action: 'arm' | 'disarm' }> = []
  const sessionRefresh = {
    arm: (id: string) => { refreshCalls.push({ id, action: 'arm' }) },
    disarm: (id: string) => { refreshCalls.push({ id, action: 'disarm' }) },
  }
  const recoveryCalls: string[] = []
  const authRecovery = {
    notifyFailure: (id: string) => { recoveryCalls.push('notify:' + id) },
    cancel: (id: string) => { recoveryCalls.push('cancel:' + id) },
    dispose: () => {},
  }
  const authRecoveryContext = new Map<string, { url: string; scope: string | undefined }>()
  const pushes: Array<{ channel: string; payload: unknown }> = []
  const syncCalls: string[] = []
  const audits: AuditEvent[] = []
  createTransportSubscriptions({
    sm: manager.sm as unknown as TransportManager,
    registrations: registry,
    edges: {
      mainWindowAlive: () => true,
      rendererPush: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); return true },
    },
    sessionRefresh,
    readySeedEdges: { observe: () => false },
    startAutomaticHostSeed: () => {},
    syncGatewayChamberPluginsFor: id => {
      syncCalls.push(id)
      return Promise.resolve({ uploaded: true, skipped: false })
    },
    audit: event => audits.push(event),
    logTag: '[wiring-test]',
    lastAuditedPhase: new Map(),
    auditRegistered: new Set(),
    authRecovery,
    authRecoveryContext,
  })
  const goReady = (): void => { instance.ready = true; manager.emitStatus(spec.id) }
  const goIdle = (): void => { instance.ready = false; instance.gen += 1; manager.emitStatus(spec.id) }
  const currentRecord = () => {
    const recordGen = registry.currentRecordGen(spec.id)
    return recordGen === undefined ? undefined : registry.snapshotForSync(spec.id, recordGen)
  }
  return {
    spec, manager, plane, sessions, credentials, instance, registry, refreshCalls, recoveryCalls,
    authRecoveryContext, pushes, syncCalls, audits, goReady, goIdle, currentRecord,
  }
}

test('a ready edge commits one registration; a health flap never re-registers', () => {
  const h = wiringHarness()
  h.goReady()
  assert.equal(h.plane.calls.register.length, 1)
  assert.equal(h.plane.calls.register[0].connectionId, 'gateway:gw-1')
  assert.deepEqual(h.syncCalls, ['gw-1'], 'a real registration edge runs the seed sync')
  assert.deepEqual(h.refreshCalls, [{ id: 'gw-1', action: 'arm' }])
  assert.equal(h.pushes.length, 1)
  assert.equal(h.pushes[0].channel, IPC_CHANNELS.SSH_STATUS_CHANGED)
  assert.equal(h.audits.filter(event => event.event === 'transport_registered').length, 1)
  // The committed record and the plane registration are the same dial tuple.
  const record = present(h.currentRecord(), 'committed record')
  const accepted = h.plane.calls.register[0]
  assert.equal(record.facts.url, accepted.url)
  assert.equal(record.facts.authority, accepted.opts.authority)
  assert.equal(record.facts.headers?.cookie, accepted.headers?.cookie)
  // Health-only projection changes keep the ONE registration.
  h.instance.health = 'suspect'
  h.manager.emitStatus('gw-1')
  h.instance.health = 'down'
  h.manager.emitStatus('gw-1')
  assert.equal(h.plane.calls.register.length, 1)
  assert.equal(h.plane.calls.health.length, 2)
  assert.deepEqual(h.syncCalls, ['gw-1'], 'health-only must not re-run the seed sync')
})

test('leave-ready revokes once and clears the committed record', () => {
  const h = wiringHarness()
  h.goReady()
  h.goIdle()
  assert.deepEqual(h.plane.calls.unregister, ['gateway:gw-1'])
  assert.equal(h.registry.snapshot('gw-1'), undefined)
  assert.equal(h.audits.filter(event => event.event === 'transport_unregistered').length, 1)
  assert.equal(h.pushes.length, 2, 'the idle status push still lands')
})

test('auto-recovery re-registers in the bumped generation (P0 regression)', () => {
  const h = wiringHarness()
  h.goReady()
  assert.equal(h.plane.calls.register.length, 1, 'the first ready edge registers')
  // The auto-recovery leg bumps the tunnel generation BEFORE it pushes the non-ready
  // phase; the subscription must revoke only the committed (old-generation) record and
  // fence THAT generation, never the live one, or the following ready edge is refused.
  h.instance.ready = false
  h.instance.gen += 1
  h.manager.emitStatus('gw-1')
  assert.equal(h.registry.snapshot('gw-1'), undefined, 'the non-ready push withdraws the record')
  h.goReady()
  assert.equal(h.plane.calls.register.length, 2, 'the ready edge re-registers the bumped generation')
  const record = present(h.currentRecord(), 're-registered record')
  assert.equal(record.transportGen, h.instance.gen)
})

test('W5 fail-closed: an auth-failed ready edge revokes AND still pushes the status', () => {
  const h = wiringHarness()
  h.goReady()
  assert.equal(h.plane.calls.register.length, 1)
  // The session died between verify and registration: password target with no proven cookie.
  h.sessions.cookie = null
  h.manager.emitStatus('gw-1')
  assert.equal(h.plane.calls.register.length, 1, 'no headerless / dead-session registration')
  assert.deepEqual(h.plane.calls.unregister, ['gateway:gw-1'], 'the live registration is revoked')
  assert.equal(h.registry.snapshot('gw-1'), undefined)
  assert.ok(h.refreshCalls.some(call => call.action === 'disarm'))
  assert.ok(h.recoveryCalls.includes('notify:gw-1'))
  assert.deepEqual(h.authRecoveryContext.get('gw-1'), {
    url: READY_URL,
    scope: gatewaySessionScopeForConnection(h.spec),
  })
  // C7: the fail-closed branch no longer early-returns over the committed status push.
  assert.equal(h.pushes.length, 2)
  assert.equal(h.pushes[0].channel, IPC_CHANNELS.SSH_STATUS_CHANGED)
})

test('an auth-failed re-verification revokes the live registration instead of riding a dead cookie', () => {
  const h = wiringHarness()
  h.goReady()
  h.sessions.cookie = null
  h.manager.emitVerified('gw-1')
  assert.deepEqual(h.plane.calls.unregister, ['gateway:gw-1'])
  assert.equal(h.registry.snapshot('gw-1'), undefined)
  assert.ok(h.recoveryCalls.includes('notify:gw-1'))
})

test('a revoke fences the revoked record generation; the recovered generation registers', () => {
  const h = wiringHarness()
  h.goReady()
  const revokedGen = h.instance.gen
  h.goIdle() // disconnect bumps the tunnel generation, then the idle edge revokes the record
  assert.equal(h.instance.gen, revokedGen + 1)
  // The recovery transport is ready again, but a late refresh for the REVOKED generation is
  // refused (the live generation already moved).
  h.instance.ready = true
  const late = h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: revokedGen })
  assert.equal(late.ok, false)
  if (late.ok) return
  assert.equal(late.reason, 'stale-generation')
  assert.equal(h.plane.calls.register.length, 1)
  // The auto-recovery ready edge in the NEW generation must register: fencing the live
  // generation here is exactly the P0 that left the proxy unregistered after a reconnect.
  const recovered = h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: h.instance.gen })
  assert.equal(recovered.ok, true)
  assert.equal(h.plane.calls.register.length, 2)
})

test('a session refresh commits the renewed cookie into the same record the manual sync reads', () => {
  const h = wiringHarness()
  h.goReady()
  const firstGen = present(h.registry.currentRecordGen('gw-1'), 'first record generation')
  // The refresh login rotated the session cache; the refresh leg's commit is the ONLY
  // place the new cookie enters the proxy + the sync read face.
  h.sessions.cookie = COOKIE_2
  const outcome = h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: h.instance.gen })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.action, 'registered')
  const secondGen = present(h.registry.currentRecordGen('gw-1'), 'second record generation')
  assert.notEqual(secondGen, firstGen)
  assert.equal(h.registry.snapshotForSync('gw-1', firstGen), undefined)
  const record = present(h.registry.snapshotForSync('gw-1', secondGen), 'renewed record')
  assert.equal(record.facts.headers?.cookie, COOKIE_2)
  // The late ready/verified edges now see the same target and stay health-only.
  h.manager.emitStatus('gw-1')
  h.manager.emitVerified('gw-1')
  assert.equal(h.plane.calls.register.length, 2, 'no duplicate re-registration after the renewal')
})

function manualSyncHarness(registry: ActiveRegistrationRegistry) {
  bindActiveRegistrationRegistry(registry)
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
  const calls: Array<{ id: string; url: string; headers: Record<string, string>; spkiPin: string | null }> = []
  const ctx = {
    deps: {
      ipc: {
        handle(channel: string, handler: (payload: unknown) => Promise<unknown> | unknown) {
          handlers.set(channel, handler as (payload: unknown) => Promise<unknown>)
        },
      },
      ctx: {
        transportManager: { status: () => ({ phase: 'ready' }) },
        syncGatewayChamberPluginsFor: (
          id: string,
          url: string,
          headers: Record<string, string>,
          spkiPin: string | null,
        ) => {
          calls.push({ id, url, headers, spkiPin })
          return Promise.resolve({ uploaded: true, skipped: false })
        },
      },
    },
  }
  registerGatewayPluginHandlers(ctx as unknown as ShellIpcCtx)
  const invoke = async (id: string): Promise<unknown> => {
    const handler = present(handlers.get(IPC_CHANNELS.GATEWAY_PLUGIN_SYNC), 'manual sync handler')
    return await handler({ id })
  }
  return { calls, invoke }
}

test('the manual sync IPC dials the renewed committed record; no record is a loud refusal', async () => {
  const h = wiringHarness()
  h.goReady()
  h.sessions.cookie = COOKIE_2
  assert.equal(h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: h.instance.gen }).ok, true)
  const manual = manualSyncHarness(h.registry)
  try {
    assert.deepEqual(await manual.invoke('gw-1'), { ok: true, uploaded: true, skipped: false })
    assert.equal(manual.calls.length, 1)
    assert.equal(manual.calls[0].url, READY_URL)
    assert.equal(manual.calls[0].headers.cookie, COOKIE_2, 'the renewed cookie, not the previous session')
    assert.equal(manual.calls[0].spkiPin, null)
    // Leaving ready revokes the record: the entry refuses loudly and dials nothing.
    h.goIdle()
    assert.deepEqual(await manual.invoke('gw-1'), { ok: false, error: 'no active gateway registration' })
    assert.equal(manual.calls.length, 1)
  } finally {
    bindActiveRegistrationRegistry(null)
  }
})

test('a proxy rejection during a session refresh is a refused commit, never an unhandled rejection', async () => {
  const h = wiringHarness()
  h.goReady()
  h.plane.failure.next = new TypeError('proxy refused the replacement registration')
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  const nowMs = 1_000_000_000
  let scheduled: (() => void) | null = null
  const refresh = createGatewaySessionRefresh({
    sessionManager: {
      ensureSession: () => Promise.resolve({ ok: true, cookie: COOKIE_2 }),
      expiresAt: () => nowMs + GATEWAY_SESSION_TTL_MS - GATEWAY_SESSION_EXPIRY_SKEW_MS,
    },
    passwordFor: () => PASSWORD,
    tokenFor: () => null,
    readyUrlFor: () => h.instance.url,
    socketPathFor: () => null,
    tlsPinFor: () => null,
    authorityFor: () => gatewayTunnelAuthority(h.spec.remotePort),
    scopeFor: () => gatewaySessionScopeForConnection(h.spec),
    // The host-assembly leg: the commit boundary is non-throwing.
    register: id => { h.registry.commit({ kind: 'register', id, transportGen: h.instance.gen }) },
    reconnect: () => {},
    warn: () => {},
    now: () => nowMs,
    schedule: (fn: () => void) => { scheduled = fn; return 1 },
    cancel: () => {},
  })
  try {
    refresh.arm('gw-1')
    assert.ok(scheduled !== null)
    h.sessions.cookie = COOKIE_2
    const fire = present(scheduled as (() => void) | null, 'scheduled refresh')
    fire()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(unhandled, [], 'a refused refresh commit must never become an unhandled rejection')
    assert.equal(h.plane.calls.register.length, 1, 'the rejected replacement is not published')
    assert.equal(present(h.currentRecord(), 'previous record').facts.headers?.cookie, COOKIE)
    // The commit's proxy-rejection branch is pinned by the module test as ok:false (never throw).
    assert.equal(
      h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: h.instance.gen }).ok,
      false,
    )
    assert.ok(GATEWAY_SESSION_REFRESH_LEAD_MS > 0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    refresh.dispose()
  }
})

test('a dsh ready edge registers headerless and never arms the gateway refresh', () => {
  const h = wiringHarness(dshSpec())
  h.goReady()
  assert.equal(h.plane.calls.register.length, 1)
  const accepted = h.plane.calls.register[0]
  assert.equal(accepted.connectionId, 'dsh:dsh-1')
  assert.equal(accepted.headers, undefined)
  assert.equal(accepted.opts.authority, undefined)
  assert.deepEqual(h.syncCalls, [])
  assert.deepEqual(h.refreshCalls, [])
  h.goIdle()
  assert.deepEqual(h.plane.calls.unregister, ['dsh:dsh-1'])
})
