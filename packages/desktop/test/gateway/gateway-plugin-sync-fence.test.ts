/** Gateway chamber plugin sync — execute-time target-binding fence + per-id single
 *  flight (design 21 §6.5; D2-1 arbiter §2.2). Production wiring shape: the real
 *  ActiveRegistration commit entry, the real status/verify subscriptions, the real
 *  shared leg (createGatewaySyncLeg) and the real manual IPC registrar over a fake
 *  plane/manager + a fake gateway HTTP server that can HOLD one response.
 *
 *  Pins:
 *   ① a revoke while the status GET is held aborts before ANY upload/restart;
 *   ② a revoke while the upload PUT is held suppresses the restart and still reports
 *      the honest uploaded marker;
 *   ③ a same-target session renewal (recordGen bumps, dial binding does not) must NOT
 *      abort the in-flight pass — the fence axis is the dial binding, not recordGen;
 *   ④ the manual IPC maps a fenced abort to ok:false (never a silent ok:true);
 *   ⑤ auto and manual syncs share ONE in-flight pass (per-id single-flight joins);
 *   ⑥ wiring lock: the composition root wires the ONE leg into both entries and the
 *      sync execution carries the four fence checkpoints; the moved code has no
 *      second implementation left in gateway-provider.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActiveRegistrationRegistry } from '../../active-registration.ts'
import { createGatewaySyncLeg, syncGatewayChamberPlugins } from '../../gateway-plugin-sync.ts'
import { createTransportSubscriptions } from '../../host-transport-subscriptions.ts'
import { registerGatewayPluginHandlers } from '../../shell-ipc-plugins-gateway.ts'
import { IPC_CHANNELS } from '../../ipc-events.ts'
import type { ShellIpcCtx } from '../../shell-ipc-ctx.ts'

const silentLogger = { log() {}, warn() {} }
const PROBE_PKG = '@dsh-chamber/probe-host'
const FENCE_ABORT = 'gateway registration changed; sync aborted'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>(resolveFn => { resolve = resolveFn })
  return { promise, resolve }
}
const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

interface GatewaySeenGates {
  getSeen: { promise: Promise<void>; resolve: () => void }
  putSeen: { promise: Promise<void>; resolve: () => void }
  restartSeen: { promise: Promise<void>; resolve: () => void }
  releaseGet: { promise: Promise<void>; resolve: () => void }
  releasePut: { promise: Promise<void>; resolve: () => void }
}

/** Fake gateway that speaks the three production sync legs and can HOLD one response.
 *  `cacheAfterPut` makes GET answer the uploaded version (the post-upload retry scenario). */
async function fakeGateway(
  hold: 'none' | 'get' | 'put',
  options: { getStatus?: number; putStatus?: number; cacheAfterPut?: boolean } = {},
) {
  const cache = new Map<string, string>()
  const seen: string[] = []
  const headers: Array<Record<string, string | string[] | undefined>> = []
  const gates: GatewaySeenGates = {
    getSeen: deferred(), putSeen: deferred(), restartSeen: deferred(),
    releaseGet: deferred(), releasePut: deferred(),
  }
  const server = createServer((req, res) => {
    const method = req.method ?? ''
    const url = req.url ?? '/'
    seen.push(method + ' ' + url)
    headers.push({ ...req.headers })
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => { void (async () => {
      const json = (payload: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (method === 'GET' && url === '/chamber/plugins') {
        gates.getSeen.resolve()
        if (hold === 'get') await gates.releaseGet.promise
        if (options.getStatus !== undefined && options.getStatus !== 200) {
          res.writeHead(options.getStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'projection failed' }))
          return
        }
        json({ items: [...cache].map(([name, version]) => ({ name, version })) })
        return
      }
      if (method === 'PUT' && url === '/chamber/plugins') {
        gates.putSeen.resolve()
        if (hold === 'put') await gates.releasePut.promise
        if (options.putStatus !== undefined && options.putStatus !== 200) {
          res.writeHead(options.putStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'upload failed' }))
          return
        }
        if (options.cacheAfterPut === true) {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name?: unknown; files?: Record<string, string> }
            const manifest = body.files?.['package.json']
            const version = manifest === undefined ? null : (JSON.parse(manifest) as { version?: unknown }).version
            if (typeof body.name === 'string' && typeof version === 'string') cache.set(body.name, version)
          } catch { /* malformed probe body: the fake only mirrors a real cache */ }
        }
        json({ changed: true })
        return
      }
      if (method === 'POST' && url === '/chamber/runtime/restart') {
        gates.restartSeen.resolve()
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(404)
      res.end()
    })() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  const origin = 'http://127.0.0.1:' + String(typeof address === 'object' && address !== null ? address.port : 0)
  return {
    seen, headers, gates, origin,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function specFor(origin: string) {
  const port = Number(new URL(origin).port)
  return {
    id: 'gw-1', label: 'gateway one', kind: 'gateway', transport: 'http' as const,
    host: '127.0.0.1', user: null, sshPort: null, remotePort: port,
    serviceName: null, remoteDshHome: null, insecureHttp: true,
  }
}

function projectionFor(instance: { spec: { kind: string; transport: string; remotePort: number }; ready: boolean; health: string }) {
  return {
    kind: instance.spec.kind, transport: instance.spec.transport, insecureHttp: true,
    phase: instance.ready ? 'ready' : 'idle',
    localPort: null, transportSocket: 'tcp', sshPort: null, remotePort: instance.spec.remotePort,
    retryAttempt: 0, requiresUserAction: false, userActionKind: null, serviceActive: null,
    remoteDshHome: null, logSummary: '', link: { state: instance.health, linkEpoch: 1 },
  }
}

type SyncResult = { uploaded: boolean; skipped: boolean; failed?: boolean; error?: string }

/** The production assembly shape over fakes: ONE leg instance feeds the auto
 *  subscription AND the manual IPC registrar (the single-flight join premise). */
async function harness(options: { subscribe: boolean; hold?: 'none' | 'get' | 'put' }) {
  const gateway = await fakeGateway(options.hold ?? 'none')
  const packageDir = mkdtempSync(join(tmpdir(), 'gw-sync-fence-'))
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: PROBE_PKG, version: '9.9.9' }))
  writeFileSync(join(packageDir, 'dist-index.js'), 'export {}')
  const instance = { spec: specFor(gateway.origin), state: {}, gen: 1, ready: false, health: 'healthy' }
  const statusListeners: Array<(id: string, status: unknown) => void> = []
  const manager = {
    onStatusChanged: (listener: (id: string, status: unknown) => void) => { statusListeners.push(listener) },
    onVerified: () => {},
    status: () => projectionFor(instance),
    listInstances: () => [instance.spec],
    readyUrl: () => (instance.ready ? gateway.origin : null),
    readySocketPath: () => null,
    getAttemptFacts: () => ({ state: instance.state, tunnelEpoch: instance.gen }),
    appendLog: () => true,
  }
  const plane = {
    registerInstanceTransport() {},
    setInstanceTransportHealth() {},
    unregisterInstanceTransport() {},
  }
  const credentials: { token: string | null } = { token: 'probe-token' }
  const registry = createActiveRegistrationRegistry({
    plane: () => plane as never,
    live: () => ({
      spec: instance.spec, incarnation: instance.state, transportGen: instance.gen,
      transport: 'http' as const,
      ready: instance.ready ? { url: gateway.origin, socketPath: null, health: instance.health as 'healthy' } : null,
    }),
    tokenFor: () => credentials.token,
    passwordFor: () => null,
    sessions: { cachedCookie: () => null, registrationAuthProof: () => null },
  })
  const leg = createGatewaySyncLeg({
    listInstances: () => manager.listInstances(),
    registrations: registry,
    attemptFactsFor: () => manager.getAttemptFacts(),
    packageSources: () => [{
      name: PROBE_PKG,
      packageJsonPath: join(packageDir, 'package.json'),
      distIndexPath: join(packageDir, 'dist-index.js'),
    }],
    logger: silentLogger,
  })
  let autoSync: Promise<SyncResult | null> | null = null
  const syncCalls: string[] = []
  if (options.subscribe) {
    createTransportSubscriptions({
      sm: manager as never,
      registrations: registry,
      edges: { mainWindowAlive: () => true, rendererPush: () => true },
      sessionRefresh: { arm: () => {}, disarm: () => {} },
      readySeedEdges: { observe: () => false },
      startAutomaticHostSeed: () => {},
      syncGatewayChamberPluginsFor: id => {
        syncCalls.push(id)
        autoSync = leg(id)
        return autoSync
      },
      audit: () => {},
      logTag: '[gw-sync-fence]',
      lastAuditedPhase: new Map(),
      auditRegistered: new Set(),
      authRecovery: { notifyFailure: () => {}, cancel: () => {}, dispose: () => {} },
      authRecoveryContext: new Map(),
    })
  }
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
  registerGatewayPluginHandlers({
    deps: {
      ipc: {
        handle(channel: string, handler: (payload: unknown) => Promise<unknown> | unknown) {
          handlers.set(channel, handler as (payload: unknown) => Promise<unknown>)
        },
      },
      ctx: {
        transportManager: { status: () => ({ phase: instance.ready ? 'ready' : 'idle' }) },
        syncGatewayChamberPluginsFor: (id: string) => leg(id),
      },
    },
  } as unknown as ShellIpcCtx)
  const emitStatus = (): void => {
    const status = projectionFor(instance)
    for (const listener of statusListeners) listener('gw-1', status)
  }
  const h = {
    gateway, instance, manager, registry, credentials, leg, syncCalls, handlers,
    get autoSync(): Promise<SyncResult | null> | null { return autoSync },
    goReady: (): void => { instance.ready = true; emitStatus() },
    goIdle: (): void => { instance.ready = false; instance.gen += 1; emitStatus() },
    register: () => {
      instance.ready = true
      return registry.commit({ kind: 'register', id: 'gw-1', transportGen: instance.gen })
    },
    revoke: () => registry.commit({ kind: 'revoke', id: 'gw-1', reason: 'leave-ready' }),
    invokeManual: async (id = 'gw-1'): Promise<unknown> => {
      const handler = handlers.get(IPC_CHANNELS.GATEWAY_PLUGIN_SYNC)
      if (handler === undefined) throw new Error('manual sync handler not registered')
      return await handler({ id })
    },
    close: async (): Promise<void> => {
      await gateway.close()
      rmSync(packageDir, { recursive: true, force: true })
    },
  }
  return h
}

test('① a revoke during the status GET aborts before any upload or restart', async () => {
  const h = await harness({ subscribe: true, hold: 'get' })
  try {
    h.goReady()
    await h.gateway.gates.getSeen.promise
    const pending = h.autoSync
    assert.ok(pending !== null, 'the ready edge started the auto sync')
    h.goIdle() // the real subscription revokes the committed record here
    assert.equal(h.registry.snapshot('gw-1'), undefined, 'record revoked while GET is in flight')
    h.gateway.gates.releaseGet.resolve()
    const result = await pending
    assert.deepEqual(h.gateway.seen, ['GET /chamber/plugins'], 'no upload/restart after the revoke')
    assert.deepEqual(result, { uploaded: false, skipped: false, failed: true, error: FENCE_ABORT })
  } finally { await h.close() }
})

test('② a revoke during the upload PUT suppresses the restart and reports the honest upload marker', async () => {
  const h = await harness({ subscribe: true, hold: 'put' })
  try {
    h.goReady()
    await h.gateway.gates.getSeen.promise
    h.gateway.gates.releaseGet.resolve()
    await h.gateway.gates.putSeen.promise
    const pending = h.autoSync
    assert.ok(pending !== null)
    h.goIdle()
    assert.equal(h.registry.snapshot('gw-1'), undefined)
    h.gateway.gates.releasePut.resolve()
    const result = await pending
    assert.equal(h.gateway.seen.includes('POST /chamber/runtime/restart'), false, 'no restart after the revoke')
    assert.deepEqual(result, { uploaded: true, skipped: false, failed: true, error: FENCE_ABORT })
  } finally { await h.close() }
})

test('③ a same-target session renewal does not abort the in-flight sync (fence axis is the dial binding, not recordGen)', async () => {
  const h = await harness({ subscribe: true, hold: 'get' })
  try {
    h.goReady()
    const recordGenBefore = h.registry.currentRecordGen('gw-1')
    await h.gateway.gates.getSeen.promise
    const pending = h.autoSync
    assert.ok(pending !== null)
    // Same target, rotated credential: a REAL re-registration (session renewal) bumps
    // recordGen, while transportGen/InstanceState/dial binding stay identical.
    h.credentials.token = 'probe-token-rotated'
    const renewed = h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: h.instance.gen })
    assert.equal(renewed.ok, true)
    if (renewed.ok) assert.equal(renewed.action, 'registered')
    assert.notEqual(h.registry.currentRecordGen('gw-1'), recordGenBefore, 'a renewal advances recordGen')
    h.gateway.gates.releaseGet.resolve()
    const result = await pending
    assert.ok(h.gateway.seen.includes('PUT /chamber/plugins'), 'the upload still runs')
    assert.ok(h.gateway.seen.includes('POST /chamber/runtime/restart'), 'the restart still runs')
    assert.deepEqual(result, { uploaded: true, skipped: false })
  } finally { await h.close() }
})

test('④ the manual IPC maps a fence abort to ok:false instead of a silent ok:true', async () => {
  const h = await harness({ subscribe: false, hold: 'get' })
  try {
    assert.equal(h.register().ok, true)
    const pending = h.invokeManual()
    await h.gateway.gates.getSeen.promise
    h.revoke()
    assert.equal(h.registry.snapshot('gw-1'), undefined)
    h.gateway.gates.releaseGet.resolve()
    const result = await pending
    assert.deepEqual(result, { ok: false, error: FENCE_ABORT })
    assert.equal(h.gateway.seen.includes('PUT /chamber/plugins'), false)
    assert.equal(h.gateway.seen.includes('POST /chamber/runtime/restart'), false)
  } finally { await h.close() }
})

test('⑤ auto and manual syncs share one in-flight pass (per-id single-flight joins)', async () => {
  const h = await harness({ subscribe: true, hold: 'get' })
  try {
    h.goReady()
    await h.gateway.gates.getSeen.promise
    const auto = h.autoSync
    assert.ok(auto !== null)
    const manual = h.invokeManual()
    h.gateway.gates.releaseGet.resolve()
    const [autoResult, manualResult] = await Promise.all([auto, manual])
    await tick(50)
    const count = (key: string): number => h.gateway.seen.filter(seen => seen === key).length
    assert.equal(count('GET /chamber/plugins'), 1, 'the manual entry joined the auto pass (no duplicate GET)')
    assert.equal(count('PUT /chamber/plugins'), 1, 'one upload')
    assert.equal(count('POST /chamber/runtime/restart'), 1, 'one restart')
    assert.deepEqual(autoResult, { uploaded: true, skipped: false })
    assert.deepEqual(manualResult, { ok: true, uploaded: true, skipped: false })
    // The committed record's auth headers still ride the outbound sync (the old IPC
    // parameter-mirror assertion was retired with the mirror; the leg is now the ONE source).
    assert.ok(h.gateway.headers.some(record =>
      typeof record.authorization === 'string' && record.authorization.startsWith('Bearer ')),
    'the sync dials the committed record Authorization header')
  } finally { await h.close() }
})

test('C2 is a checkpoint after a FAILED PUT too: no later upload rides the revoked target', async () => {
  const seen: string[] = []
  let revoked = false
  const server = createServer((req, res) => {
    const method = req.method ?? ''
    seen.push(method + ' ' + (req.url ?? '/'))
    req.resume()
    req.on('end', () => {
      if (method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ items: [] }))
        return
      }
      if (method === 'PUT') {
        revoked = true
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'boom' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  const origin = 'http://127.0.0.1:' + String(typeof address === 'object' && address !== null ? address.port : 0)
  try {
    const result = await syncGatewayChamberPlugins({
      origin,
      headers: {},
      spkiPin: null,
      packages: [
        { name: '@dsh-chamber/probe-a', packageJson: JSON.stringify({ version: '1.0.0' }), distIndex: 'a' },
        { name: '@dsh-chamber/probe-b', packageJson: JSON.stringify({ version: '1.0.0' }), distIndex: 'b' },
      ],
      logger: silentLogger,
      fence: () => !revoked,
    })
    assert.deepEqual(result, { uploaded: false, skipped: false, failed: true, error: FENCE_ABORT })
    assert.equal(seen.filter(entry => entry === 'PUT /chamber/plugins').length, 1,
      'the failed PUT aborted before the second upload')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('⑥ wiring lock: both entries consume the ONE leg; the sync execution keeps the fence checkpoints', () => {
  const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')
  const hostAssembly = source('../../host-assembly.ts')
  assert.ok(hostAssembly.includes('createGatewaySyncLeg('), 'host-assembly constructs the ONE leg')
  const hostAssemblyWiringSites = hostAssembly.split('syncGatewayChamberPluginsFor').length - 1
  assert.ok(hostAssemblyWiringSites >= 3, 'the leg feeds the auto subscription AND the manual ctx (declaration + two injections)')
  const ctx = source('../../shell-assembly-ctx.ts')
  assert.ok(ctx.includes('syncGatewayChamberPluginsFor(id: string): Promise<'),
    'the manual ctx passes ONLY the instance id (no URL/header/spki mirror)')
  const syncModule = source('../../gateway-plugin-sync.ts')
  assert.ok(syncModule.includes('if (!fence()) {'), 'pre-network fence after the local package read')
  assert.ok(syncModule.includes('const afterGet = fenceFailure(false)'), 'fence after the status GET')
  assert.ok(syncModule.includes('const afterPut = fenceFailure(uploaded)'), 'fence after EVERY upload PUT')
  assert.ok(syncModule.includes('const beforeRestart = fenceFailure(uploaded)'), 'fence before the controlled restart')
  const provider = source('../../gateway-provider.ts')
  assert.equal(provider.includes('syncGatewayChamberPlugins'), false,
    'the sync execution has ONE owner (gateway-plugin-sync.ts); gateway-provider.ts must not keep a second copy')
})

/** A direct leg over the REAL registry (no subscriptions) with a mutable target incarnation;
 *  the axis probes below need to mutate the live facts without driving a ready edge. */
async function directLegFixture(
  gateway: Awaited<ReturnType<typeof fakeGateway>>,
  packageDir: string,
  options: { transport?: 'http' | 'ssh'; remotePort?: number } = {},
) {
  const spec = {
    ...specFor(gateway.origin),
    transport: options.transport ?? 'http' as const,
    remotePort: options.remotePort ?? Number(new URL(gateway.origin).port),
  }
  let origin = gateway.origin
  let incarnation: object = {}
  let transportGen = 1
  const registry = createActiveRegistrationRegistry({
    plane: () => ({ registerInstanceTransport() {}, setInstanceTransportHealth() {}, unregisterInstanceTransport() {} }) as never,
    live: () => ({
      spec, incarnation, transportGen, transport: spec.transport,
      ready: { url: origin, socketPath: null, health: 'healthy' as const },
    }),
    tokenFor: () => 'probe-token',
    passwordFor: () => null,
    sessions: { cachedCookie: () => null, registrationAuthProof: () => null },
  })
  const leg = createGatewaySyncLeg({
    listInstances: () => [spec],
    registrations: registry,
    attemptFactsFor: () => ({ state: incarnation, tunnelEpoch: transportGen }),
    packageSources: () => [{
      name: PROBE_PKG,
      packageJsonPath: join(packageDir, 'package.json'),
      distIndexPath: join(packageDir, 'dist-index.js'),
    }],
    logger: silentLogger,
  })
  return {
    registry, leg, spec,
    setOrigin: (next: string, nextState: object = incarnation, nextGen: number = transportGen) => {
      origin = next
      incarnation = nextState
      transportGen = nextGen
    },
    setTransportGen: (next: number) => { transportGen = next },
  }
}

function tempPackageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gw-sync-axis-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PROBE_PKG, version: '9.9.9' }))
  writeFileSync(join(dir, 'dist-index.js'), 'export {}')
  return dir
}

test('⑧ a live tunnel generation that no longer matches the committed record refuses the pass before any request', async () => {
  const gateway = await fakeGateway('none')
  const packageDir = tempPackageDir()
  try {
    const h = await directLegFixture(gateway, packageDir)
    assert.equal(h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: 1 }).ok, true)
    h.setTransportGen(2) // no re-registration: the capture's transportGen no longer matches the record
    assert.equal(await h.leg('gw-1'), null, 'a mismatched incarnation capture refuses the pass (null)')
    assert.deepEqual(gateway.seen, [], 'no request is dialled for an unmatched live generation')
  } finally {
    await gateway.close()
    rmSync(packageDir, { recursive: true, force: true })
  }
})

test('⑨ the committed tunnel authority rides the sync as the Host header (no renderer mirror)', async () => {
  const gateway = await fakeGateway('none')
  const packageDir = tempPackageDir()
  try {
    const h = await directLegFixture(gateway, packageDir, { transport: 'ssh', remotePort: 39001 })
    assert.equal(h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: 1 }).ok, true)
    const result = await h.leg('gw-1')
    assert.deepEqual(result, { uploaded: true, skipped: false })
    assert.ok(gateway.headers.some(record => record.host === '127.0.0.1:39001'),
      'the committed tunnel authority is presented as Host (design 17 §9.3)')
  } finally {
    await gateway.close()
    rmSync(packageDir, { recursive: true, force: true })
  }
})

test('⑩ an unexpected pre-network throw resolves as the loud failed result (auto path never unhandled)', async () => {
  const gateway = await fakeGateway('none')
  try {
    const spec = specFor(gateway.origin)
    const leg = createGatewaySyncLeg({
      listInstances: () => [spec],
      registrations: {
        currentRecordGen: () => { throw new Error('registry boom') },
        snapshotForSync: () => undefined,
        snapshot: () => undefined,
      } as never,
      attemptFactsFor: () => null,
      packageSources: () => [],
      logger: silentLogger,
    })
    const result = await leg('gw-1')
    assert.equal(result?.failed, true)
    assert.match(String(result?.error), /gateway plugin sync failed: registry boom/)
    assert.deepEqual(gateway.seen, [], 'the failing pass dialled nothing')
  } finally {
    await gateway.close()
  }
})

test('⑪ a same-binding tunnel-generation change inside the GET window aborts before any PUT (no retry masks it)', async () => {
  const gateway = await fakeGateway('get')
  const packageDir = tempPackageDir()
  try {
    const h = await directLegFixture(gateway, packageDir)
    assert.equal(h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: 1 }).ok, true)
    const pass = h.leg('gw-1')
    await gateway.gates.getSeen.promise
    h.setTransportGen(2) // same dial binding, new live tunnel generation (no re-registration)
    gateway.gates.releaseGet.resolve()
    const result = await pass
    assert.deepEqual(result, { uploaded: false, skipped: false, failed: true, error: FENCE_ABORT })
    assert.equal(gateway.seen.includes('PUT /chamber/plugins'), false, 'no upload rides the changed tunnel generation')
    assert.equal(gateway.seen.filter(entry => entry === 'GET /chamber/plugins').length, 1,
      'a same-binding change is not retried as a moved target')
  } finally {
    gateway.gates.releaseGet.resolve()
    await gateway.close()
    rmSync(packageDir, { recursive: true, force: true })
  }
})

test('⑫ a same-record InstanceState identity change inside the GET window aborts before any PUT', async () => {
  const gateway = await fakeGateway('get')
  const packageDir = tempPackageDir()
  try {
    const h = await directLegFixture(gateway, packageDir)
    assert.equal(h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: 1 }).ok, true)
    const pass = h.leg('gw-1')
    await gateway.gates.getSeen.promise
    h.setOrigin(gateway.origin, { round: 2 }, 1) // delete/re-add style incarnation change, same record
    gateway.gates.releaseGet.resolve()
    const result = await pass
    assert.deepEqual(result, { uploaded: false, skipped: false, failed: true, error: FENCE_ABORT })
    assert.equal(gateway.seen.includes('PUT /chamber/plugins'), false, 'no upload rides the old incarnation record')
  } finally {
    gateway.gates.releaseGet.resolve()
    await gateway.close()
    rmSync(packageDir, { recursive: true, force: true })
  }
})

test('⑬ a wire-failed pass joined after a retarget re-runs once against the new target', async () => {
  const gw1 = await fakeGateway('get', { getStatus: 500 })
  const gw2 = await fakeGateway('none')
  const packageDir = tempPackageDir()
  try {
    const h = await directLegFixture(gw1, packageDir)
    assert.equal(h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: 1 }).ok, true)
    const first = h.leg('gw-1')
    await gw1.gates.getSeen.promise
    h.setOrigin(gw2.origin, { round: 2 }, 2)
    assert.equal(h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: 2 }).ok, true)
    const joined = h.leg('gw-1')
    gw1.gates.releaseGet.resolve()
    const [r1, r2] = await Promise.all([first, joined])
    assert.deepEqual(r1, { uploaded: true, skipped: false })
    assert.deepEqual(r2, r1, 'the joined caller sees the retried result')
    assert.ok(gw2.seen.includes('PUT /chamber/plugins'), 'the new target received the sync')
  } finally {
    gw1.gates.releaseGet.resolve()
    await gw1.close()
    await gw2.close()
    rmSync(packageDir, { recursive: true, force: true })
  }
})

test('⑭ a retry after an aborted pass that already uploaded still restarts the current target', async () => {
  const gateway = await fakeGateway('put', { cacheAfterPut: true })
  const packageDir = tempPackageDir()
  try {
    const h = await directLegFixture(gateway, packageDir)
    assert.equal(h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: 1 }).ok, true)
    const first = h.leg('gw-1')
    await gateway.gates.putSeen.promise
    // The target generation changes while the upload is in flight: the first pass uploaded,
    // then its C2 fence aborts; the retry sees a warm cache and must still restart the target.
    h.setOrigin(gateway.origin, { round: 2 }, 2)
    assert.equal(h.registry.commit({ kind: 'register', id: 'gw-1', transportGen: 2 }).ok, true)
    const joined = h.leg('gw-1')
    gateway.gates.releasePut.resolve()
    const [r1, r2] = await Promise.all([first, joined])
    const count = (entry: string): number => gateway.seen.filter(value => value === entry).length
    assert.equal(count('PUT /chamber/plugins'), 1, 'the retry does not re-upload the warm cache')
    assert.equal(count('POST /chamber/runtime/restart'), 1,
      'the current target is asked to restart after the old pass uploaded')
    assert.deepEqual(r1, { uploaded: true, skipped: false })
    assert.deepEqual(r2, r1, 'the joined caller keeps the honest uploaded marker')
  } finally {
    gateway.gates.releasePut.resolve()
    await gateway.close()
    rmSync(packageDir, { recursive: true, force: true })
  }
})

test('⑦ a fence-aborted single-flight pass re-runs once against the current target (join does not swallow it)', async () => {
  const gw1 = await fakeGateway('get')
  const gw2 = await fakeGateway('none')
  const packageDir = mkdtempSync(join(tmpdir(), 'gw-sync-retarget-'))
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: PROBE_PKG, version: '9.9.9' }))
  writeFileSync(join(packageDir, 'dist-index.js'), 'export {}')
  const spec = specFor(gw1.origin)
  let origin = gw1.origin
  let incarnation: object = {}
  let transportGen = 1
  const registry = createActiveRegistrationRegistry({
    plane: () => ({ registerInstanceTransport() {}, setInstanceTransportHealth() {}, unregisterInstanceTransport() {} }) as never,
    live: () => ({
      spec, incarnation, transportGen, transport: 'http' as const,
      ready: { url: origin, socketPath: null, health: 'healthy' as const },
    }),
    tokenFor: () => 'probe-token',
    passwordFor: () => null,
    sessions: { cachedCookie: () => null, registrationAuthProof: () => null },
  })
  const leg = createGatewaySyncLeg({
    listInstances: () => [spec],
    registrations: registry,
    attemptFactsFor: () => ({ state: incarnation, tunnelEpoch: transportGen }),
    packageSources: () => [{
      name: PROBE_PKG,
      packageJsonPath: join(packageDir, 'package.json'),
      distIndexPath: join(packageDir, 'dist-index.js'),
    }],
    logger: silentLogger,
  })
  try {
    assert.equal(registry.commit({ kind: 'register', id: 'gw-1', transportGen: 1 }).ok, true)
    const first = leg('gw-1')
    await gw1.gates.getSeen.promise
    // Retarget while the old pass holds its GET: the new ready edge's call joins it.
    incarnation = { round: 2 }
    transportGen = 2
    origin = gw2.origin
    assert.equal(registry.commit({ kind: 'register', id: 'gw-1', transportGen: 2 }).ok, true)
    const joined = leg('gw-1')
    gw1.gates.releaseGet.resolve()
    const [r1, r2] = await Promise.all([first, joined])
    assert.ok(gw2.seen.includes('GET /chamber/plugins'), 'the bounded retry dialed the CURRENT target')
    assert.ok(gw2.seen.includes('PUT /chamber/plugins'), 'the current target received its upload')
    assert.deepEqual(r1, { uploaded: true, skipped: false })
    assert.deepEqual(r2, r1, 'the joined caller sees the same resolved result')
  } finally {
    gw1.gates.releaseGet.resolve()
    await gw1.close()
    await gw2.close()
    rmSync(packageDir, { recursive: true, force: true })
  }
})
