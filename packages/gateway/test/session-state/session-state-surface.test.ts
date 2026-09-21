/**
 * Session-state wiring: the /chamber/session-state* prefix is claimed by the
 * existing /chamber/* chamber surface (inside the auth gate) with exact-prefix
 * matching only, and the config kill switch resolves with the warmup-style
 * env discipline (plan W1 / WS-B; blueprint section 6, plan section 11).
 *
 * Run directly:
 *   node --import ./test/session-state/workspace-loader.mjs test/session-state/session-state-surface.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import { GatewayConfigError, parseGatewayConfig } from '../../src/config.ts'
import { createGateway } from '../../src/index.ts'
import { createChamberPlugins } from '../../src/plugins.ts'
import { createChamberInstalled } from '../../src/plugins-installed.ts'
import { createChamberSurface, type ChamberSurfaceDeps } from '../../src/routes.ts'
import { createSessionStateService } from '../../src/session-state.ts'
import { FakeRequest, FakeResponse, stubPluginTasks } from '../support/utils.ts'
import { scratch, silentLogger } from './harness.ts'

const STATE = '/tmp/dsh-gateway-state'
const DSH = '/tmp/dsh-workspace'

function surfaceWithSessionState(stateDir: string, withSessionState: boolean): ReturnType<typeof createChamberSurface> {
  const service = withSessionState
    ? createSessionStateService({
        stateDir,
        logger: silentLogger,
        enabled: true,
        getLocalDshPort: () => null,
        getConnectionState: () => 'stopped',
        canExposeLocal: () => false,
        otherMuxClientsConnected: () => false,
      })
    : null
  return createChamberSurface({
    logger: silentLogger,
    channels: {
      register() {}, async start() {}, async stop() {}, resolve: () => null,
      health: () => 'unknown' as const, list: () => [],
    },
    plugins: createChamberPlugins(stateDir, silentLogger),
    installed: createChamberInstalled(stateDir),
    tasks: stubPluginTasks(),
    stateDir,
    ...(service === null ? {} : { sessionState: service.surface }),
  })
}

async function call(surface: ReturnType<typeof createChamberSurface>, method: string, path: string, stateDir: string): Promise<FakeResponse> {
  void stateDir
  const response = new FakeResponse()
  await surface.handle(new FakeRequest(method, path) as never, response as never, path)
  return response
}

test('the chamber surface claims /chamber/session-state* when the watcher is wired', async t => {
  const stateDir = scratch(t)
  const surface = surfaceWithSessionState(stateDir, true)
  const snapshot = await call(surface, 'GET', '/chamber/session-state', stateDir)
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.json().protocol, 1)
  assert.equal((await call(surface, 'POST', '/chamber/session-state', stateDir)).status, 405)
  assert.equal((await call(surface, 'GET', '/chamber/session-state/other', stateDir)).status, 404)
  // Exact-prefix matching only: a longer path must NOT be swallowed.
  assert.equal((await call(surface, 'GET', '/chamber/session-stateevil', stateDir)).status, 404)
  assert.equal((await call(surface, 'GET', '/chamber/session-states', stateDir)).status, 404)
})

test('without the watcher dep the prefix keeps the existing fallthrough 404', async t => {
  const stateDir = scratch(t)
  const surface = surfaceWithSessionState(stateDir, false)
  const response = await call(surface, 'GET', '/chamber/session-state', stateDir)
  assert.equal(response.status, 404)
  assert.equal(response.json().error, 'not_found')
})

test('DSH_GATEWAY_SESSION_STATE resolves with the lenient-but-loud env boolean', () => {
  const previous = process.env.DSH_GATEWAY_SESSION_STATE
  try {
    delete process.env.DSH_GATEWAY_SESSION_STATE
    assert.equal(parseGatewayConfig({}, STATE, DSH).sessionState, true, 'default ON')
    for (const value of ['1', 'true']) {
      process.env.DSH_GATEWAY_SESSION_STATE = value
      assert.equal(parseGatewayConfig({}, STATE, DSH).sessionState, true)
    }
    for (const value of ['0', 'false']) {
      process.env.DSH_GATEWAY_SESSION_STATE = value
      assert.equal(parseGatewayConfig({}, STATE, DSH).sessionState, false)
    }
    process.env.DSH_GATEWAY_SESSION_STATE = 'banana'
    assert.throws(() => parseGatewayConfig({}, STATE, DSH), GatewayConfigError)
    process.env.DSH_GATEWAY_SESSION_STATE = '1'
    assert.equal(parseGatewayConfig({ sessionState: false }, STATE, DSH).sessionState, false, 'explicit input wins')
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_SESSION_STATE
    else process.env.DSH_GATEWAY_SESSION_STATE = previous
  }
})

// ---------------------------------------------------------------------------
// createGateway composition: the service is constructed, passed to the chamber
// surface, started on the ready edge and flushed/closed before the gateway
// store closes.
// ---------------------------------------------------------------------------

function planeFake(state: { connectionState: string }): PlaneHandle {
  return {
    async start() {},
    async startLocal() { state.connectionState = 'ready' },
    async stop() { state.connectionState = 'stopped' },
    async stopLocal() { state.connectionState = 'stopped' },
    async restartLocal() {},
    onLocalStateChange() { return () => {} },
    refreshLocalExposure() {},
    registerInstanceTransport() {},
    unregisterInstanceTransport() {},
    // No live port: the watcher's observer starts but its mux stays waiting,
    // so no real network access is ever attempted here.
    getLocalDshPort() { return null },
    get port() { return 3000 },
    get connectionState() { return state.connectionState },
    get localProcessAlive() { return false },
    get localWritersQuiescent() { return true },
    get localDshPort() { return null },
    instanceId: 'session-state-test',
    seededProbeDomains: [],
  }
}

test('createGateway constructs the watcher, exposes it on the chamber surface and shuts it down cleanly', async t => {
  const stateDir = scratch(t)
  const state = { connectionState: 'stopped' }
  let captured: ChamberSurfaceDeps | null = null
  const gateway = createGateway({
    config: parseGatewayConfig({}, stateDir, join(stateDir, 'workspace')),
    logger: silentLogger,
    deps: {
      createPlane: (() => planeFake(state)) as never,
      createProxy: (() => ({
        async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {},
        getDiagnostics: () => ({ activeStreams: 0 }),
      })) as never,
      createRuntimeManager: (() => ({
        transactionWorkspace: null,
        resolveWorkspace: () => ({ path: join(stateDir, 'workspace'), version: '1.0.0', source: 'builtin' }),
        startupTransaction: async () => ({ blockedReason: null }),
        activationInProgress: () => false,
        mutationInProgress: () => false,
        internalSpawnActive: () => false,
        profileWriteInFlight: () => false,
        restartInFlight: () => false,
        observeLocalState() {},
        dispose: async () => {},
      })) as never,
      createChamberSurface: ((deps: ChamberSurfaceDeps) => {
        captured = deps
        return createChamberSurface(deps)
      }) as never,
    },
  })
  await gateway.start()
  const deps = captured as ChamberSurfaceDeps | null
  assert.notEqual(deps?.sessionState, undefined, 'the production gateway always wires the watcher surface')
  // The wired surface claims the prefix (mode/features come from the observer).
  const response = new FakeResponse()
  await deps!.sessionState!.handle(
    new FakeRequest('GET', '/chamber/session-state') as never,
    response as never,
    '/chamber/session-state',
  )
  assert.equal(response.status, 200)
  assert.equal(response.json().protocol, 1)
  await gateway.stop()
  // After stop the routes stay pollable with the host gate down (never 5xx).
  const after = new FakeResponse()
  await deps!.sessionState!.handle(
    new FakeRequest('GET', '/chamber/session-state') as never,
    after as never,
    '/chamber/session-state',
  )
  assert.equal(after.status, 200)
  assert.equal(after.json().host.serviceable, false)
})

