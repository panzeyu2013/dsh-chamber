import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import { writeOverride } from '@dsh-chamber/dsh-runtime'
import { createGateway } from '../src/index.ts'
import type { GatewayConfig } from '../src/config.ts'
import type { GatewayRuntimeManager, GatewayRuntimeManagerOptions } from '../src/runtime-manager.ts'

const silentLogger = { log() {}, warn() {}, error() {} }
const gatewayPackageVersion = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }).version

/** Minimal plane fake for composition tests: startLocal/stopLocal/restartLocal
 * are no-ops; the real runtime manager's startup transaction drives the state
 * dir, so the blocked/FATAL branches run against real store files. */
function compositionPlane(state: { connectionState: string }, order: string[]): PlaneHandle {
  return {
    async start() { order.push('plane:start') },
    async startLocal() { order.push('local:start'); state.connectionState = 'ready' },
    async stop() { order.push('plane:stop') },
    async stopLocal() { order.push('local:stop') },
    async restartLocal() { order.push('local:restart') },
    onLocalStateChange() { return () => {} },
    refreshLocalExposure() {},
    registerInstanceTransport() {},
    unregisterInstanceTransport() {},
    getLocalDshPort() { return null },
    get port() { return 3000 },
    get connectionState() { return state.connectionState },
    get localProcessAlive() { return false },
    get localWritersQuiescent() { return true },
    get localDshPort() { return null },
    instanceId: 'test',
  }
}

const compositionDeps = (plane: PlaneHandle): never => ({
  createPlane: (() => plane) as never,
  createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
  createFeatures: () => ({ async handle() { return true }, start() {}, stop() {} }),
}) as never

test('gateway start: a swap-attempted block keeps the gateway up with dsh stopped (review fix)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-blocked-'))
  try {
    // Seed the interrupted-switch marker BEFORE start(): runStartupPhase then
    // returns 'swap-attempted' without spawning or exposing the tree.
    writeOverride(stateDir, {
      // Keep the interruption fixture on the current shell generation. A
      // stale hard-coded package version exercises shell invalidation instead
      // of the swap-attempted recovery branch this test owns.
      shellVersion: gatewayPackageVersion,
      chosenVersion: '1.2.3',
      resolvedVersion: '1.2.3',
      pending: '1.2.3',
      swapAttempted: true,
    })
    const order: string[] = []
    const state = { connectionState: 'stopped' }
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: compositionDeps(compositionPlane(state, order)),
    })
    await gateway.start()
    assert.equal(gateway.connectionState, 'stopped', 'managed dsh left stopped')
    assert.ok(!order.includes('local:start'), 'blocked startup must not spawn the unprobed tree')
    // The gateway stays up and stoppable; the runtime controller remains the
    // recovery surface (retry-apply/retry-restore).
    await gateway.stop()
    assert.ok(order.includes('plane:stop'))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('gateway start: metadata corruption fails loud and rolls the plane back (FATAL block)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-fatal-'))
  try {
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true })
    writeFileSync(join(stateDir, 'dsh-runtime', 'activation-journal.json'), '{corrupt', { mode: 0o600 })
    const order: string[] = []
    const state = { connectionState: 'stopped' }
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: compositionDeps(compositionPlane(state, order)),
    })
    await assert.rejects(gateway.start(), /journal-corrupt/)
    assert.ok(order.includes('plane:stop'), 'startup failure rolls the plane back')
    assert.ok(!order.includes('local:start'), 'no dsh spawn on a FATAL block')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})


function config(stateDir: string): GatewayConfig {
  const builtinWorkspace = join(stateDir, 'builtin-dsh')
  mkdirSync(builtinWorkspace, { recursive: true })
  writeFileSync(join(builtinWorkspace, 'package.json'), JSON.stringify({
    private: true,
    dependencies: { '@deepseek-ai/dsh': '1.0.0' },
  }))
  return {
    plane: { host: '127.0.0.1', port: 3000, stateDir, dshWorkspacePath: builtinWorkspace },
    auth: { kind: 'none' },
    channels: { direct: false, ssh: false },
    corsOrigins: [],
    trustedProxies: [],
  }
}

test('gateway forwards plane.dshPort as the control-plane dshPortBase (design 17 §3)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-dshport-'))
  const captured: Array<{ dshPortBase?: number }> = []
  const plane: PlaneHandle = {
    async start() {},
    async startLocal() {},
    async stop() {},
    onLocalStateChange() { return () => {} },
    get port() { return 3000 },
    get connectionState() { return 'stopped' },
    get localProcessAlive() { return false },
    get localWritersQuiescent() { return true },
    get localDshPort() { return null },
    instanceId: 'test',
    getLocalDshPort() { return null },
    async stopLocal() {},
    async restartLocal() {},
    refreshLocalExposure() {},
    registerInstanceTransport() {},
    unregisterInstanceTransport() {},
  }
  const gateway = createGateway({
    config: {
      ...config(stateDir),
      plane: { ...config(stateDir).plane, dshPort: 30800 },
    },
    logger: silentLogger,
    deps: {
      createPlane: ((opts: unknown) => {
        captured.push(opts as { dshPortBase?: number })
        return plane
      }) as never,
      createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
      createFeatures: () => ({ async handle() { return true }, start() {}, stop() {} }),
    },
  })
  await gateway.start()
  assert.equal(captured[0]?.dshPortBase, 30800)
  await gateway.stop()
  rmSync(stateDir, { recursive: true, force: true })
})

test('gateway start owns local readiness and attaches features on ready transitions', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lifecycle-'))
  const order: string[] = []
  const listeners = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()
  let state = 'stopped'
  let port: number | null = null
  const emit = (status: string) => {
    state = status
    for (const listener of listeners) listener({ status, port, error: null })
  }
  const plane: PlaneHandle = {
    async start() { order.push('plane:start') },
    async startLocal() {
      order.push('local:start')
      emit('starting')
      port = 17510
      emit('ready')
    },
    async stop() { order.push('plane:stop'); emit('stopped') },
    onLocalStateChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    get port() { return 3000 },
    get connectionState() { return state },
    get localProcessAlive() { return state === 'ready' },
    get localWritersQuiescent() { return true },
    get localDshPort() { return port },
    instanceId: 'test-instance',
    getLocalDshPort() { return port },
    async stopLocal() {},
    async restartLocal() {},
    refreshLocalExposure() {},
    registerInstanceTransport() {},
    unregisterInstanceTransport() {},
  }
  try {
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: {
        createPlane: (() => plane) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() { order.push('proxy:close') } })) as never,
        createFeatures: () => ({
          async handle() { return true },
          start() { order.push('features:start') },
          stop() { order.push('features:stop') },
        }),
      },
    })
    await gateway.start()
    assert.deepEqual(order.slice(0, 3), ['plane:start', 'local:start', 'features:start'])
    emit('restarting')
    emit('ready')
    assert.deepEqual(order.slice(3, 5), ['features:stop', 'features:start'])
    await gateway.stop()
    assert.deepEqual(order.slice(-3), ['proxy:close', 'features:stop', 'plane:stop'])
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('install single-flight does not quarantine the active proxy exposure seam', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-install-exposure-'))
  let capturedPlaneOptions: { canExposeLocal(): boolean; canStartLocal(): { ok: boolean } } | null = null
  let activation = false
  let mutation = false
  const state = { connectionState: 'stopped' }
  const order: string[] = []
  const plane = compositionPlane(state, order)
  const runtime = {
    transactionWorkspace: null,
    resolveWorkspace: () => ({ path: config(stateDir).plane.dshWorkspacePath, version: '1.0.0', source: 'builtin' }),
    startupTransaction: async () => ({ blockedReason: null }),
    activationInProgress: () => activation,
    mutationInProgress: () => mutation,
    internalSpawnActive: () => false,
    dispose: async () => {},
  } as unknown as GatewayRuntimeManager
  try {
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: {
        createPlane: ((options: unknown) => {
          capturedPlaneOptions = options as typeof capturedPlaneOptions
          return plane
        }) as never,
        createRuntimeManager: (() => runtime) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {} }),
      },
    })
    await gateway.start()
    mutation = true // models manager.phase === installing
    assert.equal(runtime.mutationInProgress(), true)
    assert.equal(runtime.activationInProgress(), false)
    assert.equal(capturedPlaneOptions!.canExposeLocal(), true,
      'a 2–10 minute install must keep the current dsh proxy visible')
    assert.equal(capturedPlaneOptions!.canStartLocal().ok, true,
      'install is a writer fence, not an activation/spawn quarantine')
    activation = true
    assert.equal(capturedPlaneOptions!.canExposeLocal(), false,
      'only the activation verdict window closes exposure')
    activation = false
    await gateway.stop()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('live activation keeps candidate and rollback ready edges detached, then explicitly resyncs after verdict', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-candidate-isolation-'))
  const order: string[] = []
  const listeners = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()
  let connectionState = 'stopped'
  let activation = false
  let quarantineChange: GatewayRuntimeManagerOptions['onActivationQuarantineChange']
  const emit = (status: string) => {
    connectionState = status
    for (const listener of listeners) listener({ status, port: 17510, error: null })
  }
  const plane: PlaneHandle = {
    async start() { order.push('plane:start') },
    async startLocal() { order.push('local:start'); emit('ready') },
    async stop() { order.push('plane:stop'); emit('stopped') },
    async stopLocal() { emit('stopped') },
    async restartLocal() {},
    onLocalStateChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    refreshLocalExposure() {}, registerInstanceTransport() {}, unregisterInstanceTransport() {},
    getLocalDshPort() { return 17510 }, get port() { return 3000 },
    get connectionState() { return connectionState }, get localProcessAlive() { return connectionState === 'ready' },
    get localWritersQuiescent() { return true }, get localDshPort() { return 17510 }, instanceId: 'test',
  }
  const runtime = {
    transactionWorkspace: null,
    resolveWorkspace: () => ({ path: config(stateDir).plane.dshWorkspacePath, version: '1.0.0', source: 'builtin' }),
    startupTransaction: async () => ({ blockedReason: null }),
    activationInProgress: () => activation,
    mutationInProgress: () => activation,
    internalSpawnActive: () => false,
    restoreBuiltin: async () => {
      activation = true
      quarantineChange?.(true)
      order.push('candidate:ready')
      emit('ready')
      order.push('candidate:rejected')
      emit('starting')
      order.push('rollback:ready')
      emit('ready')
      order.push('verdict:rollback-pass')
      activation = false
      quarantineChange?.(false)
      return { accepted: true }
    },
    dispose: async () => {},
  } as unknown as GatewayRuntimeManager
  try {
    const gateway = createGateway({
      config: config(stateDir), logger: silentLogger,
      deps: {
        createPlane: (() => plane) as never,
        createRuntimeManager: ((options: GatewayRuntimeManagerOptions) => {
          quarantineChange = options.onActivationQuarantineChange
          return runtime
        }) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
        createFeatures: () => ({
          async handle() { return true },
          start() { order.push('features:start') },
          stop() { order.push('features:stop') },
        }),
      },
    })
    await gateway.start()
    order.length = 0
    await runtime.restoreBuiltin()
    assert.deepEqual(order, [
      'features:stop',
      'candidate:ready',
      'candidate:rejected',
      'rollback:ready',
      'verdict:rollback-pass',
      'features:start',
    ], 'no ready edge attaches before verdict; end-quarantine callback performs the authoritative resync')
    await gateway.stop()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now keeps candidate ready edges detached and explicitly resyncs features after the verdict', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-applynow-isolation-'))
  const order: string[] = []
  const listeners = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()
  let connectionState = 'stopped'
  let activation = false
  let quarantineChange: GatewayRuntimeManagerOptions['onActivationQuarantineChange']
  const emit = (status: string) => {
    connectionState = status
    for (const listener of listeners) listener({ status, port: 17510, error: null })
  }
  const plane: PlaneHandle = {
    async start() { order.push('plane:start') },
    async startLocal() { order.push('local:start'); emit('ready') },
    async stop() { order.push('plane:stop'); emit('stopped') },
    async stopLocal() { emit('stopped') },
    async restartLocal() {},
    onLocalStateChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    refreshLocalExposure() {}, registerInstanceTransport() {}, unregisterInstanceTransport() {},
    getLocalDshPort() { return 17510 }, get port() { return 3000 },
    get connectionState() { return connectionState }, get localProcessAlive() { return connectionState === 'ready' },
    get localWritersQuiescent() { return true }, get localDshPort() { return 17510 }, instanceId: 'test',
  }
  const runtime = {
    transactionWorkspace: null,
    resolveWorkspace: () => ({ path: config(stateDir).plane.dshWorkspacePath, version: '1.0.0', source: 'builtin' }),
    startupTransaction: async () => ({ blockedReason: null }),
    activationInProgress: () => activation,
    mutationInProgress: () => activation,
    internalSpawnActive: () => false,
    applyNow: async () => {
      activation = true
      quarantineChange?.(true)
      order.push('candidate:ready')
      emit('ready')
      order.push('candidate:applied')
      activation = false
      quarantineChange?.(false)
      return { accepted: true }
    },
    dispose: async () => {},
  } as unknown as GatewayRuntimeManager
  try {
    const gateway = createGateway({
      config: config(stateDir), logger: silentLogger,
      deps: {
        createPlane: (() => plane) as never,
        createRuntimeManager: ((options: GatewayRuntimeManagerOptions) => {
          quarantineChange = options.onActivationQuarantineChange
          return runtime
        }) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
        createFeatures: () => ({
          async handle() { return true },
          start() { order.push('features:start') },
          stop() { order.push('features:stop') },
        }),
      },
    })
    await gateway.start()
    order.length = 0
    await runtime.applyNow()
    assert.deepEqual(order, [
      'features:stop',
      'candidate:ready',
      'candidate:applied',
      'features:start',
    ], 'no ready edge attaches before the apply-now verdict; end-quarantine callback performs the authoritative resync')
    await gateway.stop()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a local startup failure rolls back the listening plane', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lifecycle-fail-'))
  let planeStops = 0
  const plane: PlaneHandle = {
    async start() {},
    async startLocal() { throw new Error('spawn failed') },
    async stop() { planeStops += 1 },
    onLocalStateChange() { return () => {} },
    port: 3000,
    connectionState: 'error',
    localProcessAlive: false,
    localWritersQuiescent: true,
    localDshPort: null,
    instanceId: 'test-instance',
    getLocalDshPort() { return null },
    async stopLocal() {},
    async restartLocal() {},
    refreshLocalExposure() {},
    registerInstanceTransport() {},
    unregisterInstanceTransport() {},
  }
  try {
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: {
        createPlane: (() => plane) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {} }),
      },
    })
    await assert.rejects(() => gateway.start(), /spawn failed/)
    assert.equal(planeStops, 1)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a plane listen failure is also rolled back and remains retryable', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lifecycle-listen-fail-'))
  let planeStarts = 0
  let planeStops = 0
  const plane: PlaneHandle = {
    async start() { planeStarts += 1; throw new Error('listen failed') },
    async startLocal() { throw new Error('must not spawn') },
    async stop() { planeStops += 1 },
    onLocalStateChange() { return () => {} },
    port: null,
    connectionState: 'stopped',
    localProcessAlive: false,
    localWritersQuiescent: true,
    localDshPort: null,
    instanceId: 'test-instance',
    getLocalDshPort() { return null },
    async stopLocal() {},
    async restartLocal() {},
    refreshLocalExposure() {},
    registerInstanceTransport() {},
    unregisterInstanceTransport() {},
  }
  try {
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: {
        createPlane: (() => plane) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {} }),
      },
    })
    await assert.rejects(() => gateway.start(), /listen failed/)
    await assert.rejects(() => gateway.start(), /listen failed/)
    assert.equal(planeStarts, 2)
    assert.equal(planeStops, 2)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the programmatic constructor cannot bypass auth or TLS config guards', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lifecycle-materialized-'))
  try {
    const publicWithoutCredential = config(stateDir)
    publicWithoutCredential.plane.host = '0.0.0.0'
    publicWithoutCredential.auth = { kind: 'token' }
    assert.throws(() => createGateway({ config: publicWithoutCredential }), /does not match its credentials/)

    const proxiedWithoutCredential = config(stateDir)
    proxiedWithoutCredential.publicOrigin = 'https://gateway.example'
    assert.throws(() => createGateway({ config: proxiedWithoutCredential }), /without authentication/)

    const unsupportedTls = config(stateDir)
    unsupportedTls.tls = { cert: '/tmp/cert.pem', key: '/tmp/key.pem' }
    assert.throws(() => createGateway({ config: unsupportedTls }), /TLS config is not implemented/)

    const weakToken = config(stateDir)
    weakToken.auth = { kind: 'token', token: 'guessable' }
    assert.throws(() => createGateway({ config: weakToken }), /materialized token must be 32-4096/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the materialized S1 guard is overridable via allowAnonymousExternal', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lifecycle-anon-'))
  try {
    const anonExternal = config(stateDir)
    anonExternal.plane.host = '0.0.0.0'
    anonExternal.allowAnonymousExternal = true
    assert.doesNotThrow(() => createGateway({
      config: anonExternal,
      logger: silentLogger,
      deps: {
        createPlane: (() => ({})) as never,
        createProxy: (() => ({})) as never,
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {} }),
      },
    }))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the S1 override warns only for anonymous-external, never loopback-only or credential kinds', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lifecycle-warn-'))
  const warnings: string[] = []
  const capturing = { log() {}, warn: (...parts: unknown[]) => warnings.push(parts.join(' ')), error() {} }
  const build = (mutate: (c: ReturnType<typeof config>) => void) => {
    const c = config(stateDir)
    mutate(c)
    createGateway({
      config: c,
      logger: capturing,
      deps: {
        createPlane: (() => ({})) as never,
        createProxy: (() => ({})) as never,
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {} }),
      },
    })
  }
  try {
    // anonymous external → warns exactly once
    build(c => { c.plane.host = '0.0.0.0'; c.allowAnonymousExternal = true })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /SECURITY WARNING/)
    warnings.length = 0

    // loopback + override → silent (not externally reachable)
    build(c => { c.allowAnonymousExternal = true })
    assert.equal(warnings.length, 0)

    // password + override → silent (kind !== none)
    build(c => { c.plane.host = '0.0.0.0'; c.auth = { kind: 'password', password: 'correct-horse-battery' }; c.allowAnonymousExternal = true })
    assert.equal(warnings.length, 0)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
