import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import { createGateway } from '../src/index.ts'
import type { GatewayConfig } from '../src/config.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

function config(stateDir: string): GatewayConfig {
  return {
    plane: { host: '127.0.0.1', port: 3000, stateDir, dshWorkspacePath: '/tmp/dsh' },
    auth: { kind: 'none' },
    channels: { direct: false, ssh: false },
    corsOrigins: [],
    trustedProxies: [],
  }
}

test('gateway forwards plane.dshPort as the control-plane dshPortBase (design 17 §3)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-dshport-'))
  let received: { dshPortBase?: number } | null = null
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
      createPlane: ((opts: { dshPortBase?: number }) => {
        received = opts
        return plane
      }) as never,
      createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
      createFeatures: () => ({ async handle() { return true }, start() {}, stop() {} }),
    },
  })
  await gateway.start()
  assert.equal(received?.dshPortBase, 30800)
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
