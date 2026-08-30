import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlPlaneOptions, PlaneHandle } from '@dsh-chamber/control-plane'
import { writeOverride } from '@dsh-chamber/dsh-runtime'
import { createGateway } from '../src/index.ts'
import { createFeatureHost } from '../src/routes.ts'
import type { GatewayConfig } from '../src/config.ts'
import type { GatewayRuntimeManager, GatewayRuntimeManagerOptions } from '../src/runtime-manager.ts'
import { createGatewayStore, hashCredential } from '../src/store.ts'

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
  createFeatures: () => ({ async handle() { return true }, start() {}, stop() {}, async quiesce() {} }),
}) as never

type GatewayMiddleware = NonNullable<ControlPlaneOptions['middleware']>

class LifecycleRequest extends EventEmitter {
  readonly method = 'PUT'
  readonly url = '/chamber/settings'
  readonly headers = { host: '127.0.0.1:3000', 'content-type': 'application/json' }
  readonly socket = { remoteAddress: '127.0.0.1' }
  readonly bodyReaderStarted: Promise<void>
  destroyed = false
  private markBodyReaderStarted: () => void = () => {}

  constructor() {
    super()
    this.bodyReaderStarted = new Promise(resolve => { this.markBodyReaderStarted = resolve })
  }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener)
    if (event === 'data') this.markBodyReaderStarted()
    return this
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('aborted')
    this.emit('close')
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {}
}

class LifecycleResponse extends EventEmitter {
  status = 0
  body = ''
  headersSent = false
  writableEnded = false
  destroyed = false
  private readonly headers: Record<string, unknown> = {}

  setHeader(name: string, value: unknown): void { this.headers[name.toLowerCase()] = value }
  writeHead(status: number, headers: Record<string, unknown> = {}): this {
    this.status = status
    this.headersSent = true
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    return this
  }
  write(chunk: unknown): boolean { this.body += String(chunk); return true }
  end(chunk?: unknown): void {
    if (chunk !== undefined) this.body += String(chunk)
    if (this.writableEnded) return
    this.writableEnded = true
    this.emit('finish')
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  }
}

function beginFeatureMutation(middleware: GatewayMiddleware): {
  request: LifecycleRequest
  response: LifecycleResponse
  pending: Promise<boolean | void>
} {
  const request = new LifecycleRequest()
  const response = new LifecycleResponse()
  const pending = Promise.resolve(middleware(
    request as never,
    response as never,
    new URL(request.url, 'http://127.0.0.1:3000'),
    {} as never,
  ))
  return { request, response, pending }
}

async function settleWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

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

test('gateway start quarantines and stops a blocked verdict that left its probe process ready', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-blocked-ready-'))
  let state = 'stopped'
  let localStops = 0
  let featureStarts = 0
  let planeOptions: { canExposeLocal(): boolean; canStartLocal(): { ok: boolean } } | null = null
  let proxyOptions: { canExposeLocal(): boolean } | null = null
  const plane: PlaneHandle = {
    async start() {},
    async startLocal() { throw new Error('normal readiness must not run after a blocked verdict') },
    async stop() { state = 'stopped' },
    async stopLocal() { localStops += 1; state = 'stopped' },
    async restartLocal() {},
    onLocalStateChange() { return () => {} },
    refreshLocalExposure() {}, registerInstanceTransport() {}, unregisterInstanceTransport() {},
    getLocalDshPort() { return state === 'ready' ? 17510 : null },
    get port() { return 3000 }, get connectionState() { return state },
    get localProcessAlive() { return state === 'ready' }, get localWritersQuiescent() { return true },
    get localDshPort() { return state === 'ready' ? 17510 : null }, instanceId: 'blocked-ready',
  }
  let blocked = false
  const runtime = {
    transactionWorkspace: null,
    resolveWorkspace: () => ({ path: config(stateDir).plane.dshWorkspacePath, version: '2.0.0', source: 'override' }),
    startupTransaction: async () => {
      state = 'ready' // model a fallback probe that failed after startLocal()
      blocked = true
      return { blockedReason: 'swap-attempted' }
    },
    activationInProgress: () => false,
    exposureQuarantined: () => blocked,
    mutationInProgress: () => false,
    internalSpawnActive: () => false,
    dispose: async () => {},
  } as unknown as GatewayRuntimeManager
  try {
    const gateway = createGateway({
      config: config(stateDir), logger: silentLogger,
      deps: {
        createPlane: ((options: unknown) => {
          planeOptions = options as typeof planeOptions
          return plane
        }) as never,
        createRuntimeManager: (() => runtime) as never,
        createProxy: ((options: unknown) => {
          proxyOptions = options as typeof proxyOptions
          return { async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} }
        }) as never,
        createFeatures: () => ({
          async handle() { return true },
          start() { featureStarts += 1 },
          stop() {},
          async quiesce() {},
        }),
      },
    })
    await gateway.start()
    assert.equal(state, 'stopped')
    assert.equal(localStops, 1, 'composition boundary proves a blocked probe process is stopped')
    assert.equal(featureStarts, 0, 'blocked ready must not attach dsh-derived consumers')
    assert.equal(planeOptions!.canExposeLocal(), false)
    assert.equal(proxyOptions!.canExposeLocal(), false)
    assert.equal(planeOptions!.canStartLocal().ok, false, 'automatic host starts remain fenced until recovery')
    await gateway.stop()
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
      createFeatures: () => ({ async handle() { return true }, start() {}, stop() {}, async quiesce() {} }),
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
          async quiesce() {},
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

test('gateway stop drains an entered feature side effect before releasing its lock and restart reopens admission', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-feature-drain-'))
  const state = { connectionState: 'stopped' }
  const order: string[] = []
  let middleware!: GatewayMiddleware
  let markWriteEntered!: () => void
  const writeEntered = new Promise<void>(resolve => { markWriteEntered = resolve })
  let releaseWrite!: () => void
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })

  try {
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: {
        createPlane: ((options: ControlPlaneOptions) => {
          middleware = options.middleware!
          return compositionPlane(state, order)
        }) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
        createFeatures: options => {
          const mutateSettings = options.store.settings.mutate.bind(options.store.settings)
          options.store.settings.mutate = async mutator => {
            markWriteEntered()
            await writeGate
            await mutateSettings(mutator)
          }
          return createFeatureHost(options)
        },
      },
    })
    await gateway.start()

    // Cross the body boundary and enter the durable side effect. Shutdown may
    // close this request's client leg, but must continue tracking the saga.
    const admitted = beginFeatureMutation(middleware)
    await admitted.request.bodyReaderStarted
    admitted.request.emit('data', Buffer.from(JSON.stringify({ git: { enabled: true } })))
    admitted.request.emit('end')
    await writeEntered
    let stopSettled = false
    const stopping = gateway.stop().then(() => { stopSettled = true })

    assert.equal(admitted.request.destroyed, true, 'shutdown closes the admitted request downstream')
    assert.equal(admitted.response.destroyed, true, 'shutdown closes the admitted response downstream')
    const fenced = beginFeatureMutation(middleware)
    await fenced.pending
    assert.equal(fenced.response.status, 503)
    assert.equal(JSON.parse(fenced.response.body).code, 'gateway_stopping')
    assert.throws(
      () => createGatewayStore(stateDir, silentLogger),
      (error: unknown) => (error as { code?: string }).code === 'gateway_locked',
      'the outer state lock remains held while the entered side effect is draining',
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(stopSettled, false)

    releaseWrite()
    await admitted.pending
    await stopping

    const afterStop = createGatewayStore(stateDir, silentLogger)
    assert.equal(afterStop.settings.get().git?.enabled, true, 'the entered mutation commits before lock release')
    afterStop.close()

    await gateway.start()
    const restarted = beginFeatureMutation(middleware)
    await restarted.request.bodyReaderStarted
    restarted.request.emit('data', Buffer.from(JSON.stringify({ schedule: { enabled: true } })))
    restarted.request.emit('end')
    await restarted.pending
    assert.equal(restarted.response.status, 200, 'a later gateway start reopens feature mutations')
    await gateway.stop()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('gateway stop aborts an authenticated slow feature body instead of hanging quiescence', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-feature-slow-body-'))
  const state = { connectionState: 'stopped' }
  const order: string[] = []
  let middleware!: GatewayMiddleware

  try {
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: {
        createPlane: ((options: ControlPlaneOptions) => {
          middleware = options.middleware!
          return compositionPlane(state, order)
        }) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
        createFeatures: options => createFeatureHost(options),
      },
    })
    await gateway.start()

    const slow = beginFeatureMutation(middleware)
    await slow.request.bodyReaderStarted
    // Deliberately never emit data/end. The lifecycle traffic snapshot must
    // destroy this authenticated request after the feature admission fence.
    const stopping = gateway.stop()
    assert.equal(slow.request.destroyed, true)
    assert.equal(slow.response.destroyed, true)

    await settleWithin(slow.pending, 'slow feature handler')
    await settleWithin(stopping, 'gateway stop')
    const reopened = createGatewayStore(stateDir, silentLogger)
    assert.notEqual(reopened.settings.get().git?.enabled, true, 'an aborted pre-body request performs no mutation')
    reopened.close()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stop() begins runtime quiescence before a deferred startup transaction settles', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-start-cancel-'))
  let startupEntered!: () => void
  const entered = new Promise<void>(resolve => { startupEntered = resolve })
  let releaseStartup!: () => void
  const startupGate = new Promise<void>(resolve => { releaseStartup = resolve })
  let disposalEntered!: () => void
  const disposing = new Promise<void>(resolve => { disposalEntered = resolve })
  let disposal: Promise<void> | null = null
  let disposalBegins = 0
  const order: string[] = []
  const state = { connectionState: 'stopped' }
  const plane = compositionPlane(state, order)
  const runtime = {
    transactionWorkspace: null,
    resolveWorkspace: () => ({ path: config(stateDir).plane.dshWorkspacePath, version: '1.0.0', source: 'builtin' }),
    startupTransaction: async () => {
      order.push('runtime:startup')
      startupEntered()
      await startupGate
      return { blockedReason: null }
    },
    activationInProgress: () => false,
    mutationInProgress: () => false,
    internalSpawnActive: () => false,
    dispose: () => {
      if (disposal === null) {
        disposalBegins += 1
        disposal = (async () => {
          order.push('runtime:dispose')
          disposalEntered()
          await startupGate
        })()
      }
      return disposal
    },
  } as unknown as GatewayRuntimeManager
  try {
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: {
        createPlane: (() => plane) as never,
        createRuntimeManager: (() => runtime) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() { order.push('proxy:close') } })) as never,
        createFeatures: () => ({
          async handle() { return true },
          start() { order.push('features:start') },
          stop() { order.push('features:stop') },
          async quiesce() {},
        }),
      },
    })
    const starting = gateway.start()
    await entered

    const stopping = gateway.stop()
    await disposing
    assert.equal(disposalBegins, 1, 'stop invokes the runtime abort/barrier without awaiting startPromise')
    assert.ok(!order.includes('local:start'), 'the cancelled startup cannot advance to normal local readiness')

    releaseStartup()
    await assert.rejects(
      starting,
      (error: unknown) => (error as { code?: string }).code === 'gateway_start_cancelled',
    )
    await stopping
    assert.ok(!order.includes('features:start'), 'a cancelled startup cannot attach derived consumers')

    const reopened = createGatewayStore(stateDir, silentLogger)
    reopened.close()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stop keeps proxy and features quarantined when a rollback finishes during disposal', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-stop-quarantine-'))
  const order: string[] = []
  const listeners = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()
  let state = 'stopped'
  let planeOptions: { canExposeLocal(): boolean; canStartLocal(): { ok: boolean } } | null = null
  let proxyOptions: { canExposeLocal(): boolean } | null = null
  let quarantineChange: GatewayRuntimeManagerOptions['onActivationQuarantineChange']
  let activation = false
  let releaseRollback!: () => void
  const rollbackGate = new Promise<void>(resolve => { releaseRollback = resolve })
  let rollbackEntered!: () => void
  const rollingBack = new Promise<void>(resolve => { rollbackEntered = resolve })
  let disposal: Promise<void> | null = null
  const emit = (status: string) => {
    state = status
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
    get connectionState() { return state }, get localProcessAlive() { return state === 'ready' },
    get localWritersQuiescent() { return true }, get localDshPort() { return 17510 }, instanceId: 'test',
  }
  const runtime = {
    transactionWorkspace: null,
    resolveWorkspace: () => ({ path: config(stateDir).plane.dshWorkspacePath, version: '1.0.0', source: 'builtin' }),
    startupTransaction: async () => ({ blockedReason: null }),
    activationInProgress: () => activation,
    mutationInProgress: () => activation,
    internalSpawnActive: () => false,
    dispose: () => {
      if (disposal === null) {
        disposal = (async () => {
          activation = true
          quarantineChange?.(true)
          rollbackEntered()
          await rollbackGate
          // Model the old manager behavior that published an open edge when a
          // rollback verdict completed after stop had already begun.
          activation = false
          quarantineChange?.(false)
        })()
      }
      return disposal
    },
  } as unknown as GatewayRuntimeManager
  try {
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: {
        createPlane: ((options: unknown) => {
          planeOptions = options as typeof planeOptions
          return plane
        }) as never,
        createRuntimeManager: ((options: GatewayRuntimeManagerOptions) => {
          quarantineChange = options.onActivationQuarantineChange
          return runtime
        }) as never,
        createProxy: ((options: unknown) => {
          proxyOptions = options as typeof proxyOptions
          return { async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() { order.push('proxy:close') } }
        }) as never,
        createFeatures: () => ({
          async handle() { return true },
          start() { order.push('features:start') },
          stop() { order.push('features:stop') },
          async quiesce() {},
        }),
      },
    })
    await gateway.start()
    assert.equal(order.filter(item => item === 'features:start').length, 1)

    const stopping = gateway.stop()
    await rollingBack
    assert.equal(planeOptions!.canExposeLocal(), false)
    assert.equal(proxyOptions!.canExposeLocal(), false)
    assert.equal(planeOptions!.canStartLocal().ok, false, 'external starts stay fenced during quiescence')

    releaseRollback()
    await stopping
    assert.equal(order.filter(item => item === 'features:start').length, 1,
      'a late rollback-open callback must not resurrect feature consumers')
    assert.equal(planeOptions!.canExposeLocal(), false)
    assert.equal(proxyOptions!.canExposeLocal(), false)
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
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {}, async quiesce() {} }),
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
          async quiesce() {},
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
          async quiesce() {},
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
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {}, async quiesce() {} }),
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
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {}, async quiesce() {} }),
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
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {}, async quiesce() {} }),
      },
    }))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the S1 override warns only for anonymous-external, never loopback-only or credential kinds', () => {
  const warnings: string[] = []
  const capturing = { log() {}, warn: (...parts: unknown[]) => warnings.push(parts.join(' ')), error() {} }
  const build = (mutate: (c: ReturnType<typeof config>) => void) => {
    // Phase 1: each build owns a fresh stateDir — createGatewayStore holds an
    // exclusive .gateway.lock for the process lifetime, so reusing one dir
    // across builds would fail the live-owner lock.
    const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lifecycle-warn-'))
    try {
      const c = config(stateDir)
      mutate(c)
      createGateway({
        config: c,
        logger: capturing,
        deps: {
          createPlane: (() => ({})) as never,
          createProxy: (() => ({})) as never,
          createFeatures: () => ({ async handle() { return true }, start() {}, stop() {}, async quiesce() {} }),
        },
      })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  }
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
})

test('--no-auth with a persisted runtime credential is authenticated in effect: no SECURITY WARNING (Phase 2)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-runtime-cred-'))
  const warnings: string[] = []
  const logs: string[] = []
  const capturing = {
    log: (message: unknown) => logs.push(String(message)),
    warn: (message: unknown) => warnings.push(String(message)),
    error() {},
  }
  try {
    // Seed a runtime-managed password credential (source 'runtime'), then
    // build a gateway whose config has NO credentials at all: the effective
    // kind comes from the persisted store, so --no-auth is authenticated in
    // effect and the S1 SECURITY WARNING must not fire.
    {
      const seedStore = createGatewayStore(stateDir, silentLogger)
      seedStore.setPasswordCredential(hashCredential('runtime-correct-password'), 'runtime')
      seedStore.close()
    }
    const c = config(stateDir)
    c.plane.host = '0.0.0.0'
    c.allowAnonymousExternal = true
    createGateway({
      config: c,
      logger: capturing,
      deps: {
        createPlane: (() => ({})) as never,
        createProxy: (() => ({})) as never,
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {}, async quiesce() {} }),
      },
    })
    assert.equal(warnings.length, 0, 'a runtime credential makes the --no-auth deployment authenticated (no SECURITY WARNING)')
    assert.equal(
      logs.some(message => message.includes('authentication is enabled by a runtime-managed credential')),
      true,
      'an informational line reports the runtime-managed authentication',
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stop() releases the stateDir lock even when the plane stop fails', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-stop-lock-'))
  try {
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: {
        createPlane: (() => ({
          async start() {},
          async stop() { throw new Error('plane stop failed') },
          get port() { return 3000 },
          get connectionState() { return 'stopped' },
          get localProcessAlive() { return false },
          get localWritersQuiescent() { return true },
          get localDshPort() { return null },
          getLocalDshPort() { return null },
          async startLocal() {},
          async stopLocal() {},
          async restartLocal() {},
          onLocalStateChange() { return () => {} },
          refreshLocalExposure() {},
          registerInstanceTransport() {},
          unregisterInstanceTransport() {},
          instanceId: 'test',
        })) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {}, async quiesce() {} }),
      },
    })
    await assert.rejects(() => gateway.stop(), /plane stop failed/)
    // The exclusive lock must be released despite the failed plane stop.
    const reopened = createGatewayStore(stateDir, silentLogger)
    reopened.close()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stop() retains the stateDir lock when runtime writer disposal is unsafe', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-stop-writer-lock-'))
  try {
    const state = { connectionState: 'stopped' }
    const order: string[] = []
    const plane = compositionPlane(state, order)
    const runtime = {
      transactionWorkspace: null,
      resolveWorkspace: () => ({ path: config(stateDir).plane.dshWorkspacePath, version: '1.0.0', source: 'builtin' }),
      startupTransaction: async () => ({ blockedReason: null }),
      activationInProgress: () => false,
      mutationInProgress: () => false,
      internalSpawnActive: () => false,
      dispose: async () => { throw new Error('runtime writer unsafe') },
    } as unknown as GatewayRuntimeManager
    const gateway = createGateway({
      config: config(stateDir),
      logger: silentLogger,
      deps: {
        createPlane: (() => plane) as never,
        createRuntimeManager: (() => runtime) as never,
        createProxy: (() => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} })) as never,
        createFeatures: () => ({ async handle() { return true }, start() {}, stop() {}, async quiesce() {} }),
      },
    })
    await gateway.start()
    await assert.rejects(gateway.stop(), /runtime writer unsafe/)
    assert.throws(
      () => createGatewayStore(stateDir, silentLogger),
      (error: unknown) => (error as { code?: string }).code === 'gateway_locked',
      'the outer stateDir lock is the fail-closed backstop when runtime ownership cannot be released',
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
