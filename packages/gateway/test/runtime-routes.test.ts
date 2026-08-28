/**
 * /chamber/runtime controller tests (design 18 §9.3): route behavior matrix —
 * restart 202/409, status pollable while dsh is down, auth gate, registry and
 * body validation, and the runtime manager's resolution chain + single-owner
 * guard. Fakes stand in for the plane; no real dsh, no fixed ports.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { ApiRequest, ApiResponse, Logger, PlaneHandle } from '@dsh-chamber/control-plane'
import type { GatewayConfig } from '../src/config.ts'
import { createGatewayRuntimeManager, readBuiltinVersion } from '../src/runtime-manager.ts'
import {
  REQUIRED_ACTIVATION_PROBES,
  readActivationJournalState,
  readCurrentPointer,
  readOverride,
  recordRuntimeFailure,
  writeActivationIntent,
  writeCurrentPointer,
  writeOverride,
} from '@dsh-chamber/dsh-runtime'
import { createRuntimeRoutes, sanitizeRouteError, type RuntimeRoutes } from '../src/runtime-routes.ts'

const silentLogger: Logger = { log() {}, warn() {}, error() {} }

const TEST_BUILTIN_VERSION = '0.9.0'

function config(stateDir: string): GatewayConfig {
  const anchor = join(stateDir, 'builtin-anchor')
  const packageDir = join(anchor, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(anchor, 'package.json'), JSON.stringify({
    name: 'gateway-test-anchor',
    dependencies: { '@deepseek-ai/dsh': TEST_BUILTIN_VERSION },
  }))
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: TEST_BUILTIN_VERSION,
  }))
  return {
    plane: { host: '127.0.0.1', port: 3000, stateDir, dshWorkspacePath: anchor },
    auth: { kind: 'none' },
    channels: { direct: false, ssh: false },
    corsOrigins: [],
    trustedProxies: [],
  }
}

function fakePlane(overrides: Partial<PlaneHandle> = {}): PlaneHandle & { _state: { connectionState: string; restartError: string | null } } {
  const state = { connectionState: 'stopped', restartError: null as string | null }
  return {
    start: async () => {},
    startLocal: async () => {},
    stop: async () => {},
    stopLocal: async () => {},
    restartLocal: async () => {
      if (state.restartError !== null) throw new Error(state.restartError)
      state.connectionState = 'ready'
    },
    onLocalStateChange: () => () => {},
    registerInstanceTransport: () => {},
    unregisterInstanceTransport: () => {},
    refreshLocalExposure: () => {},
    getLocalDshPort: () => 17510,
    get port() { return 3000 },
    get connectionState() { return state.connectionState },
    get localProcessAlive() { return false },
    get localDshPort() { return 17510 },
    get localWritersQuiescent() { return true },
    get instanceId() { return 'test-gateway' },
    ...overrides,
    _state: state,
  }
}

// ---------------------------------------------------------------------------
// Controller route matrix (fake manager; no plane needed)
// ---------------------------------------------------------------------------
class FakeRequest extends EventEmitter implements Partial<ApiRequest> {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  _body?: string
  _destroyed = false
  socket = { remoteAddress: '127.0.0.1' }
  constructor(method: string = 'GET', url = '/chamber/runtime/status', headers: Record<string, string | string[] | undefined> = {}, body?: string) {
    super()
    this.method = method
    this.url = url
    this.headers = headers
    this._body = body
    if (body !== undefined) {
      setImmediate(() => {
        this.emit('data', Buffer.from(body))
        this.emit('end')
      })
    } else {
      setImmediate(() => this.emit('end'))
    }
  }
  destroy() { this._destroyed = true; return this }
  get destroyed() { return this._destroyed }
}

class FakeResponse {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ''
  writeHead(status: number, headers?: Record<string, string>) { this.statusCode = status; if (headers) Object.assign(this.headers, headers) }
  setHeader(name: string, value: string) { this.headers[name] = value }
  end(data?: string) { this.body = data ?? '' }
}

async function runRoute(routes: RuntimeRoutes, method: string, path: string, body?: string): Promise<{ status: number; json: unknown }> {
  const req = new FakeRequest(method, path, { authorization: 'Bearer x' }, body) as unknown as ApiRequest
  const fakeRes = new FakeResponse()
  const res = fakeRes as unknown as ApiResponse
  const claimed = await routes.handle(req, res, path)
  assert.equal(claimed, true, `${method} ${path} must be claimed`)
  return { status: fakeRes.statusCode, json: fakeRes.body === '' ? null : JSON.parse(fakeRes.body) }
}

test('status is pollable while dsh is stopped (not ready-gated) and reports applying phase', async () => {
  let phase = 'idle'
  const manager = {
    status: async () => ({ kind: 'dsh-chamber-gateway-runtime', activeVersion: '0.9.0', source: 'builtin-anchor', phase, pending: null, connectionState: 'stopped', registry: 'https://registry.npmjs.org', platform: 'darwin', mutationsAllowed: true }),
    listVersions: async () => ({}),
    select: async () => ({ accepted: true, version: 'x' }),
    apply: async () => ({ pending: true }),
    rollback: async () => ({ accepted: true }),
    restoreBuiltin: async () => ({ accepted: true }),
    restart: async () => {},
    getRegistry: () => ({ origin: 'https://registry.npmjs.org' }),
    setRegistry: async (origin: string) => ({ origin }),
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const idle = await runRoute(routes, 'GET', '/chamber/runtime/status')
  assert.equal(idle.status, 200)
  assert.equal((idle.json as { phase: string }).phase, 'idle')
  assert.equal((idle.json as { kind: string }).kind, 'dsh-chamber-gateway-runtime',
    'the async status snapshot is awaited and serialized, never rendered as {}')
  phase = 'applying'
  const applying = await runRoute(routes, 'GET', '/chamber/runtime/status')
  assert.equal((applying.json as { phase: string }).phase, 'applying')
  assert.equal((applying.json as { connectionState: string }).connectionState, 'stopped')
})

test('restart returns 202 when ready, 409 while applying, and 409 when dsh never reached ready', async () => {
  let phase = 'idle'
  let connectionState = 'ready'
  let restarts = 0
  let restarting = false
  const manager = {
    status: () => ({ phase, connectionState }),
    restart: async () => { restarts += 1 },
    restartInFlight: () => restarting,
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const ok = await runRoute(routes, 'POST', '/chamber/runtime/restart')
  assert.equal(ok.status, 202)
  assert.equal((ok.json as { accepted: boolean }).accepted, true)
  assert.equal(restarts, 1)
  restarting = true
  const inflight = await runRoute(routes, 'POST', '/chamber/runtime/restart')
  assert.equal(inflight.status, 409, 'an in-flight restart must 409, not merge silently')
  restarting = false
  phase = 'applying'
  const busy = await runRoute(routes, 'POST', '/chamber/runtime/restart')
  assert.equal(busy.status, 409)
  assert.equal((busy.json as { code: string }).code, 'runtime_busy')
  assert.equal(restarts, 1)
  phase = 'installing'
  const installing = await runRoute(routes, 'POST', '/chamber/runtime/restart')
  assert.equal(installing.status, 409)
  assert.equal((installing.json as { code: string }).code, 'runtime_busy')
  phase = 'pending'
  const pending = await runRoute(routes, 'POST', '/chamber/runtime/restart')
  assert.equal(pending.status, 409)
  assert.equal((pending.json as { code: string }).code, 'runtime_pending')
  phase = 'idle'
  connectionState = 'degraded'
  const degraded = await runRoute(routes, 'POST', '/chamber/runtime/restart')
  assert.equal(degraded.status, 202, 'degraded is serviceable and may be restarted')
  connectionState = 'stopped'
  const notRunning = await runRoute(routes, 'POST', '/chamber/runtime/restart')
  assert.equal(notRunning.status, 409, 'sync refusal must be honest, not a fake 202 (R7)')
  assert.equal(restarts, 2)
})

test('select/rollback require a version body and registry PUT validates the origin', async () => {
  let busy = false
  let readOnly = false
  const manager = {
    status: () => ({ phase: 'idle', mutationsAllowed: !readOnly }),
    activationInProgress: () => busy,
    mutationInProgress: () => busy,
    select: async () => ({ accepted: true, version: 'x' }),
    rollback: async () => ({ accepted: true }),
    setRegistry: async (origin: string) => ({ origin }),
    getRegistry: () => ({ origin: 'https://registry.npmjs.org' }),
    restart: async () => {},
    apply: async () => ({ pending: true }),
    restoreBuiltin: async () => ({ accepted: true }),
    listVersions: async () => ({}),
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const missing = await runRoute(routes, 'POST', '/chamber/runtime/select', '{}')
  assert.equal(missing.status, 400)
  const missingOrigin = await runRoute(routes, 'PUT', '/chamber/runtime/registry', '{}')
  assert.equal(missingOrigin.status, 400)
  const unknown = await runRoute(routes, 'GET', '/chamber/runtime/nope')
  assert.equal(unknown.status, 404)
})

// ---------------------------------------------------------------------------
// S19 sanitization (F5 review fix)
// ---------------------------------------------------------------------------
test('sanitizeRouteError redacts URL userinfo, paths and credential patterns', () => {
  // The shared sanitizeErrorText runs first and strips paths (the trailing
  // [path]); the route sanitizer adds userinfo + credential redaction.
  assert.equal(sanitizeRouteError('failed https://user:pass@host/x?token=abc'), 'failed https://[redacted]@host[path]')
  assert.equal(sanitizeRouteError('bad token=supersecret&password=hunter2'), 'bad token=[redacted]&password=[redacted]')
  assert.equal(sanitizeRouteError('authorization=Bearer xyz'), 'authorization=[redacted] xyz')
  assert.equal(sanitizeRouteError('plain message'), 'plain message')
})

// ---------------------------------------------------------------------------
// Manager: resolution chain + single-owner guard
// ---------------------------------------------------------------------------
test('resolution chain: env → override (valid tree) → builtin anchor', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-resolve-'))
  const oldEnv = process.env.DSH_GATEWAY_DSH_PATH
  try {
    process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.deepEqual(manager.resolveWorkspace(), { path: '/tmp/env-dsh', version: null, source: 'env' })
  } finally {
    if (oldEnv === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = oldEnv
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('resolution falls back to the builtin anchor without env or pointer', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-anchor-'))
  const oldEnv = process.env.DSH_GATEWAY_DSH_PATH
  try {
    delete process.env.DSH_GATEWAY_DSH_PATH
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.deepEqual(manager.resolveWorkspace(), {
      path: join(stateDir, 'builtin-anchor'), version: TEST_BUILTIN_VERSION, source: 'builtin',
    })
  } finally {
    if (oldEnv !== undefined) process.env.DSH_GATEWAY_DSH_PATH = oldEnv
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('single-process guard: a live owner record from another pid fails loud', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-'))
  try {
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, 'dsh-runtime', 'owner.json'), JSON.stringify({ pid: process.ppid }), { mode: 0o600 })
    assert.throws(
      () => createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger }),
      /another gateway process/,
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('registry origin validation lives in the manager (bad origin rejected)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-registry-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await assert.rejects(manager.setRegistry('not a url'), /invalid registry origin/)
    const good = await manager.setRegistry('https://registry.npmmirror.com')
    assert.equal(good.origin, 'https://registry.npmmirror.com')
    assert.equal(manager.getRegistry().origin, 'https://registry.npmmirror.com')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('corrupt registry configuration fails loud, preserves evidence, and never falls back to npmjs', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-registry-corrupt-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.equal(manager.getRegistry().origin, 'https://registry.npmjs.org', 'only a genuinely missing file uses the default')
    const file = join(stateDir, 'dsh-runtime', 'registry.json')
    writeFileSync(file, '{broken-json', { mode: 0o600 })
    const projected = await manager.status()
    assert.equal(projected.registry, null)
    assert.match(projected.registryError ?? '', /corrupt/)
    assert.ok(!existsSync(file), 'the corrupt primary file is quarantined')
    const evidence = readdirSync(join(stateDir, 'dsh-runtime')).find(name => name.startsWith('registry.json.corrupt-'))
    assert.ok(evidence)
    assert.equal(readFileSync(join(stateDir, 'dsh-runtime', evidence!), 'utf8'), '{broken-json')
    assert.throws(() => manager.getRegistry(), /remains quarantined/,
      'quarantine evidence prevents a silent default on subsequent reads')
    assert.deepEqual(await manager.setRegistry('https://registry.npmmirror.com'), { origin: 'https://registry.npmmirror.com' })
    assert.equal(manager.getRegistry().origin, 'https://registry.npmmirror.com')
    assert.ok(existsSync(join(stateDir, 'dsh-runtime', evidence!)), 'recovery never destroys the preserved corrupt bytes')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('quarantining a hard-linked registry never chmods or rewrites the external inode', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-registry-hardlink-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const external = join(stateDir, 'external-registry-bytes')
    writeFileSync(external, '{"origin":"https://registry.npmjs.org"}')
    chmodSync(external, 0o644)
    linkSync(external, join(stateDir, 'dsh-runtime', 'registry.json'))
    const status = await manager.status()
    assert.match(status.registryError ?? '', /corrupt/)
    assert.equal(readFileSync(external, 'utf8'), '{"origin":"https://registry.npmjs.org"}')
    assert.equal(statSync(external).mode & 0o777, 0o644,
      'quarantine must not chmod a multiply-linked inode outside its evidence entry')
    assert.ok(readdirSync(join(stateDir, 'dsh-runtime')).some(name => name.startsWith('registry.json.corrupt-')))
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('offline version listing retains every valid local cache tree', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-offline-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    let fetches = 0
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      fetchMetadata: async () => { fetches += 1; throw new Error('registry offline') },
    })
    const result = await manager.listVersions() as {
      versions: Array<{ version: string; cached: boolean }>
      error: string
    }
    assert.match(result.error, /registry offline/)
    assert.deepEqual(
      result.versions.filter(entry => entry.version === '1.0.0' || entry.version === '2.0.0')
        .map(entry => [entry.version, entry.cached]),
      [['1.0.0', true], ['2.0.0', true]],
    )
    assert.equal(result.versions.find(entry => entry.version === TEST_BUILTIN_VERSION)?.cached, false,
      'the active builtin anchor stays visible but is not mislabeled as an installed cache tree')
    assert.equal((await manager.select(TEST_BUILTIN_VERSION)).accepted, true,
      'selecting the active builtin row is a no-op')
    assert.equal(fetches, 1, 'the builtin no-op never performs another offline registry request')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('fresh installs fail closed at the logical disk soft limit while cached versions remain selectable', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-quota-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const sparse = join(stateDir, 'dsh-runtime', '.pnpm-store', 'logical-10-gib')
    mkdirSync(dirname(sparse), { recursive: true })
    writeFileSync(sparse, '')
    truncateSync(sparse, 10 * 1024 ** 3)
    let fetches = 0
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      fetchMetadata: async () => { fetches += 1; throw new Error('must not fetch above quota') },
    })
    await assert.rejects(manager.select('2.0.0'), (error: unknown) =>
      (error as { code?: string }).code === 'runtime_disk_limit')
    assert.equal(fetches, 0, 'quota is checked before registry/network work')
    assert.equal((await manager.select('1.0.0')).accepted, true,
      'cached recovery/switching remains available above the soft limit')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('status projects effective override selection plus snapshot, failure, and gateway-layout disk facts', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-status-full-'))
  try {
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '2.0.0')
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.2', chosenVersion: '2.0.0', resolvedVersion: '2.0.0',
      pending: null, swapAttempted: false, lastOutcome: 'applied', restoreOutcome: 'complete',
    })
    const snapshotAt = Date.now()
    const snapshotFile = join(stateDir, 'dsh-runtime', 'snapshots', `2.0.0-${snapshotAt}`, 'data')
    mkdirSync(dirname(snapshotFile), { recursive: true })
    writeFileSync(snapshotFile, 'snapshot-bytes')
    const restoreBackup = join(stateDir, 'dsh-home.old-123', 'data')
    mkdirSync(dirname(restoreBackup), { recursive: true })
    writeFileSync(restoreBackup, 'gateway-restore-backup')
    recordRuntimeFailure(stateDir, { version: '3.0.0', phase: 'install', error: 'registry install failed' })
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const status = await manager.status()
    assert.equal(status.kind, 'dsh-chamber-gateway-runtime')
    assert.equal(status.activeVersion, '2.0.0')
    assert.equal(status.builtinVersion, TEST_BUILTIN_VERSION)
    assert.equal(status.currentVersion, '2.0.0')
    assert.equal(status.selectedVersion, '2.0.0')
    assert.equal(status.hasOverride, true)
    assert.equal(status.source, 'user-selected')
    assert.equal(status.restoreOutcome, 'complete')
    assert.equal(status.snapshotCount, 1)
    assert.equal(status.latestSnapshotAt, new Date(snapshotAt).toISOString())
    assert.equal(status.snapshotError, null)
    assert.equal(status.restoreInProgress, false)
    assert.equal(status.preRollbackCount, 0)
    assert.equal(status.preRollbackLatestName, null)
    assert.equal(status.failure?.version, '3.0.0')
    assert.equal(status.failure?.reason, 'registry install failed')
    assert.ok((status.diskUsage?.snapshotBytes ?? 0) > 0)
    assert.ok((status.diskUsage?.restoreBackupBytes ?? 0) > 0,
      'gateway sibling dsh-home.old backups are included in disk accounting')
    assert.equal(status.diskError, null)
    assert.equal(status.diskLimitBytes, 10 * 1024 ** 3)
    assert.equal(status.diskLimitExceeded, false)
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('status reads the real version from an effective env workspace', async () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-status-env-'))
  const envAnchor = join(stateDir, 'env-anchor')
  try {
    const pkg = join(envAnchor, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '4.5.6' }))
    process.env.DSH_GATEWAY_DSH_PATH = envAnchor
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const status = await manager.status()
    assert.equal(status.activeVersion, '4.5.6')
    assert.equal(status.source, 'env')
    assert.equal(status.builtinVersion, TEST_BUILTIN_VERSION)
    await manager.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('same-process duplicate managers cannot share one runtime stateDir', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-same-process-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.throws(
      () => createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger }),
      /already owns/,
    )
    await manager.dispose()
    const replacement = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await replacement.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an owner record with this pid is rejected even without a module-local lease', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-same-pid-record-'))
  try {
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, 'dsh-runtime', 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
    assert.throws(
      () => createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger }),
      /already owns/,
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('registry source changes are fenced while an install is in flight', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-registry-fence-'))
  let rejectFetch!: (error: Error) => void
  try {
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      fetchMetadata: async () => new Promise((_, reject) => { rejectFetch = reject }),
    })
    const install = manager.select('2.0.0')
    assert.equal(manager.mutationInProgress(), true, 'the full install window is single-flight')
    assert.equal(manager.activationInProgress(), false, 'install must not quarantine the already-active runtime')
    const installing = await manager.status()
    assert.equal(installing.phase, 'installing')
    assert.equal(installing.connectionState, 'ready')
    assert.equal(installing.activeVersion, TEST_BUILTIN_VERSION, 'the current runtime stays authoritative while downloading')
    await assert.rejects(
      manager.setRegistry('https://registry.npmmirror.com'),
      (error: unknown) => (error as { code?: string }).code === 'runtime_busy',
    )
    rejectFetch(new Error('test install cancelled'))
    await assert.rejects(install, /test install cancelled/)
    assert.equal(manager.mutationInProgress(), false)
    assert.equal((await manager.status()).phase, 'idle')
    assert.equal(manager.getRegistry().origin, 'https://registry.npmjs.org')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('startup transaction with no pending switches nothing and does not block', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-startup-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const result = await manager.startupTransaction()
    assert.equal(result.blockedReason, null)
    assert.equal((await manager.status()).phase, 'idle')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('select→apply semantics: apply without a selection rejects; rollback rejects an invalid target', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-semantics-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await assert.rejects(manager.apply(), /no runtime version selected/)
    await assert.rejects(manager.rollback('9.9.9'), /no valid version tree/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('ordinary pending is a core+route terminal gate: every action except restore-builtin is 409 and non-mutating', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-pending-gate-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.2', chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async () => REQUIRED_ACTIVATION_PROBES.map(name => ({ name, ok: true })),
    })
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    assert.equal((await manager.status()).phase, 'pending')

    const blocked: Array<[string, string, string | undefined]> = [
      ['select', 'POST', JSON.stringify({ version: '1.0.0' })],
      ['apply', 'POST', undefined],
      ['rollback', 'POST', JSON.stringify({ version: '1.0.0' })],
      ['retry-apply', 'POST', undefined],
      ['retry-restore', 'POST', undefined],
      ['restart', 'POST', undefined],
      ['registry', 'PUT', JSON.stringify({ origin: 'https://registry.npmmirror.com' })],
    ]
    for (const [suffix, method, body] of blocked) {
      const response = await runRoute(routes, method, `/chamber/runtime/${suffix}`, body)
      assert.equal(response.status, 409, `${suffix} must be refused while pending`)
      assert.equal((response.json as { code: string }).code, 'runtime_pending', `${suffix} exposes the stable pending code`)
      assert.equal(readOverride(stateDir)?.pending, '1.0.0', `${suffix} must not clear or rewrite pending`)
    }

    const restored = await runRoute(routes, 'POST', '/chamber/runtime/restore-builtin')
    assert.equal(restored.status, 200, 'restore-builtin is the sole pending escape')
    assert.equal(readOverride(stateDir), null)
    assert.equal((await manager.status()).phase, 'idle')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('single-process guard: a stale owner record from a dead pid is taken over', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-esrch-'))
  try {
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true, mode: 0o700 })
    // A pid that cannot exist on any platform probing kill(pid,0).
    writeFileSync(join(stateDir, 'dsh-runtime', 'owner.json'), JSON.stringify({ pid: 99_999_999 }), { mode: 0o600 })
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.equal(manager.resolveWorkspace().source, 'builtin')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restoreBuiltin runs the full shared activation transaction before deleting override metadata', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restore-journal-'))
  try {
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '2.0.0')
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.2', chosenVersion: '2.0.0', resolvedVersion: '2.0.0',
      pending: null, swapAttempted: false, lastOutcome: 'applied',
    })
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"kept":true}')
    const order: string[] = []
    const plane = fakePlane({
      stopLocal: async () => { order.push('stop') },
      startLocal: async () => { order.push('start') },
    })
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async ({ isBuiltin }) => {
        order.push(`probe:${isBuiltin ? 'builtin' : 'override'}`)
        return REQUIRED_ACTIVATION_PROBES.map(name => ({ name, ok: true }))
      },
      onActivationQuarantineChange: (active) => { order.push(`quarantine:${active ? 'on' : 'off'}`) },
    })
    await manager.restoreBuiltin()
    assert.equal(order[0], 'quarantine:on', 'derived consumers detach before the host is quiesced')
    assert.ok(order.indexOf('stop') < order.indexOf('probe:builtin'), 'DSH_HOME is quiesced before snapshot/switch/probe')
    assert.ok(order.indexOf('probe:builtin') < order.indexOf('quarantine:off'),
      'candidate ready remains quarantined through the complete probe verdict')
    assert.ok(order.includes('probe:builtin'), 'the builtin anchor passes the complete activation gate')
    assert.ok(readdirSync(join(stateDir, 'dsh-runtime', 'snapshots')).some(name => name.startsWith('2.0.0-')),
      'the switching-from DSH_HOME is snapshotted under its real source version')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"kept":true}')
    assert.equal(readCurrentPointer(stateDir), null, 'the pointer clears only inside the activation transaction')
    assert.equal(readOverride(stateDir), null, 'override is deleted only after the builtin probe passes')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'restore-builtin must not leave a mismatching journal behind')
    const status = await manager.status()
    assert.equal(status.kind, 'dsh-chamber-gateway-runtime')
    assert.equal(status.activeVersion, TEST_BUILTIN_VERSION)
    assert.equal(status.builtinVersion, TEST_BUILTIN_VERSION)
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restoreBuiltin preserves the override and rolls data back when the builtin probe fails', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restore-fail-'))
  try {
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '2.0.0')
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.2', chosenVersion: '2.0.0', resolvedVersion: '2.0.0',
      pending: null, swapAttempted: false, lastOutcome: 'applied',
    })
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"preserved"}')
    const probed: string[] = []
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      waitBeforeRetry: async () => {},
      probeCandidate: async ({ isBuiltin }) => {
        probed.push(isBuiltin ? 'builtin' : 'override')
        return REQUIRED_ACTIVATION_PROBES.map(name => ({ name, ok: !isBuiltin, ...(!isBuiltin ? {} : { error: 'rejected' }) }))
      },
    })
    await assert.rejects(manager.restoreBuiltin(), /previous runtime and data were restored/)
    assert.deepEqual(probed, ['builtin', 'builtin', 'override'], 'failed builtin is observed twice, then the source tree is probed')
    assert.equal(readCurrentPointer(stateDir), '2.0.0')
    assert.equal(readOverride(stateDir)?.resolvedVersion, '2.0.0', 'failed reset never deletes the recoverable override')
    assert.equal(readOverride(stateDir)?.lastOutcome, 'rolled-back')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"preserved"}')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('env override is a healthy startup bypass: pending is deferred without blocked/error status', async () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-env-pending-'))
  const errors: string[] = []
  try {
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: { log() {}, warn() {}, error(message) { errors.push(String(message)) } },
    })
    writeOverride(stateDir, { shellVersion: '0.2.0-beta.2', chosenVersion: '1.0.0', resolvedVersion: '1.0.0', pending: '1.0.0', swapAttempted: false })
    assert.deepEqual(await manager.startupTransaction(), { blockedReason: null })
    const status = await manager.status()
    assert.equal(status.pending, null)
    assert.equal(status.phase, 'idle')
    assert.equal(status.startupBlockedReason, null)
    assert.equal(status.source, 'env')
    assert.deepEqual(errors, [], 'env bypass is not logged as a runtime startup error')
    await manager.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the gateway pnpm installer entry resolves to an existing file (R9-R1: exports-hidden subpath regression)', () => {
  const require = createRequire(import.meta.url)
  // Mirror the manager's strategy: pnpm's exports only exposes '.', so join
  // the bin path from the resolved package.json — and assert it exists.
  const pnpmPkg = require.resolve('pnpm')
  assert.ok(pnpmPkg.endsWith('package.json'), `resolved pnpm entry is its package.json (${pnpmPkg})`)
  const entry = join(dirname(pnpmPkg), 'bin', 'pnpm.cjs')
  assert.ok(existsSync(entry), `pnpm CLI entry must exist at ${entry}`)
})

function makeValidTree(stateDir: string, version: string): void {
  const root = join(stateDir, 'dsh-runtime', version)
  const dshPkg = { name: '@deepseek-ai/dsh', version }
  const criticalFiles: Record<string, string> = {}
  const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dshDir, { recursive: true })
  const packagePath = join(dshDir, 'package.json')
  const binPath = join(dshDir, 'lib', 'bin.js')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(packagePath, JSON.stringify(dshPkg))
  writeFileSync(binPath, '#!/usr/bin/env node\nconsole.log("hi")\n')
  for (const rel of ['node_modules/@deepseek-ai/dsh/package.json', 'node_modules/@deepseek-ai/dsh/lib/bin.js']) {
    criticalFiles[rel] = `sha256-${createHash('sha256').update(readFileSync(join(root, rel))).digest('base64')}`
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'runtime-tree',
    version,
    dependencies: { '@deepseek-ai/dsh': version },
    dsh: { platform: `${process.platform}-${process.arch}`, criticalFiles },
  }))
}

test('readBuiltinVersion reads the anchor package version (F1 regression)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-rt-builtin-ver-'))
  try {
    assert.equal(readBuiltinVersion(dir), null, 'missing package.json → null')
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }))
    assert.equal(readBuiltinVersion(dir), '9.9.9')
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    const sourceDir = join(dir, 'apps', 'cli')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '8.8.8' }))
    assert.equal(readBuiltinVersion(dir), '8.8.8', 'a source-checkout anchor reads apps/cli/package.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('activationFacts uses the anchor semver as the builtin snapshot source (F1 regression)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-facts-'))
  const anchorDir = mkdtempSync(join(tmpdir(), 'gw-rt-anchor-'))
  try {
    const pkgDir = join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }))
    const manager = createGatewayRuntimeManager({
      config: { ...config(stateDir), plane: { ...config(stateDir).plane, dshWorkspacePath: anchorDir } },
      plane: fakePlane(),
      logger: silentLogger,
    })
    const facts = manager.activationFacts()
    assert.equal(facts.sourceIsBuiltin, true)
    assert.equal(facts.sourceVersion, '9.9.9', 'the very first install must snapshot the builtin semver, not null')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(anchorDir, { recursive: true, force: true })
  }
})

test('builtin-active cached selection stays staged across restart without weakening pointer loss', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-reselect-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const result = await manager.select('1.0.0')
    assert.equal(result.accepted, true)
    const { readOverride } = await import('@dsh-chamber/dsh-runtime')
    const override = readOverride(stateDir)
    assert.equal(override?.chosenVersion, '1.0.0')
    assert.equal(override?.pending, null)
    assert.equal(override?.selectedOnly, true, 'builtin remains the explicit active authority until apply')
    assert.equal(manager.resolveWorkspace().source, 'builtin')
    await manager.dispose()

    const restarted = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.deepEqual(await restarted.startupTransaction(), { blockedReason: null })
    assert.equal(restarted.resolveWorkspace().source, 'builtin', 'staged selection survives a healthy gateway restart')
    assert.equal((await restarted.status()).selectedVersion, '1.0.0')
    await restarted.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('staging v2 from active user v1 never authorizes builtin if v1 current pointer disappears', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-stage-from-user-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.2', chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: false, lastOutcome: 'applied', selectedOnly: false,
    })
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await manager.select('2.0.0')
    assert.equal(readOverride(stateDir)?.selectedOnly, false)
    assert.equal(manager.resolveWorkspace().version, '1.0.0', 'the active pointer, not the staged choice, remains authoritative')
    rmSync(join(stateDir, 'dsh-runtime', 'current'))
    assert.throws(() => manager.resolveWorkspace(), /missing its authoritative current pointer/,
      'lost active v1 pointer must quarantine instead of falling back to builtin')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an empty DSH_GATEWAY_DSH_PATH counts as unset (resolves builtin)', () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = ''
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-empty-env-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.equal(manager.resolveWorkspace().source, 'builtin')
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('version mutations refuse while the env anchor is active (env always wins)', async () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-env-mutate-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.equal(manager.resolveWorkspace().source, 'env')
    await assert.rejects(manager.select('1.2.3'), /env always wins/)
    await assert.rejects(manager.apply(), /env always wins/)
    await assert.rejects(manager.rollback('1.2.3'), /env always wins/)
    await assert.rejects(manager.restoreBuiltin(), /env always wins/)
    await assert.rejects(manager.setRegistry('https://registry.npmmirror.com'), /env always wins/)
    await manager.restart()
    assert.equal((await manager.status()).restart, 'ok', 'process restart remains available for env-pinned runtimes')
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('manager.status() projects the live plane connectionState (ready/restarting/stopped)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-live-conn-'))
  try {
    const plane = fakePlane()
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    assert.equal((await manager.status()).connectionState, 'stopped')
    plane._state.connectionState = 'restarting'
    assert.equal((await manager.status()).connectionState, 'restarting')
    plane._state.connectionState = 'ready'
    assert.equal((await manager.status()).connectionState, 'ready')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a rejected plane.restartLocal() surfaces as status().operationError (sanitized)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restart-fail-'))
  try {
    const plane = fakePlane()
    plane._state.restartError = 'spawn denied /secret/token=abc'
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    await assert.rejects(manager.restart(), /spawn denied/)
    const operationError = (await manager.status()).operationError
    assert.equal(typeof operationError, 'string')
    assert.ok((operationError as string).includes('spawn denied'))
    assert.ok(!(operationError as string).includes('/secret'), 'paths must be redacted')
    assert.ok(!(operationError as string).includes('token=abc'), 'credentials must be redacted')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() reaps install children and removes the owner record', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-dispose-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    assert.ok(existsSync(ownerPath))
    assert.equal(statSync(ownerPath).mode & 0o777, 0o600, 'owner record created via wx is owner-only')
    await manager.dispose()
    assert.ok(!existsSync(join(stateDir, 'dsh-runtime', 'owner.json')), 'owner record dropped on dispose')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('gateway-owned files land in <stateDir>/dsh-runtime (single nesting, F1 regression)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-layout-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await manager.setRegistry('https://registry.npmmirror.com')
    assert.ok(existsSync(join(stateDir, 'dsh-runtime', 'registry.json')), 'registry.json single-nested')
    assert.equal(statSync(join(stateDir, 'dsh-runtime', 'registry.json')).mode & 0o777, 0o600, 'registry.json owner-only')
    assert.ok(!existsSync(join(stateDir, 'dsh-runtime', 'dsh-runtime')), 'no double-nested state dir')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('env anchor active: /select refuses 409 synchronously, awaited mutations answer 409 with env_override_active', async () => {
  const manager = {
    status: () => ({ phase: 'idle', mutationsAllowed: true, source: 'env' }),
    activationInProgress: () => false,
    mutationInProgress: () => false,
    restartInFlight: () => false,
    select: async () => { throw Object.assign(new Error('env always wins'), { code: 'env_override_active' }) },
    apply: async () => { throw Object.assign(new Error('env always wins'), { code: 'env_override_active' }) },
    rollback: async () => { throw Object.assign(new Error('env always wins'), { code: 'env_override_active' }) },
    restoreBuiltin: async () => { throw Object.assign(new Error('env always wins'), { code: 'env_override_active' }) },
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const select = await runRoute(routes, 'POST', '/chamber/runtime/select', JSON.stringify({ version: '1.2.3' }))
  assert.equal(select.status, 409)
  assert.equal((select.json as { code: string }).code, 'env_override_active')
  const apply = await runRoute(routes, 'POST', '/chamber/runtime/apply', '{}')
  assert.equal(apply.status, 409)
  assert.equal((apply.json as { code: string }).code, 'env_override_active')
  const rollback = await runRoute(routes, 'POST', '/chamber/runtime/rollback', JSON.stringify({ version: '1.2.3' }))
  assert.equal(rollback.status, 409)
  const restore = await runRoute(routes, 'POST', '/chamber/runtime/restore-builtin', '{}')
  assert.equal(restore.status, 409)
})

test('select refuses 409 while activation is in flight and 403 on read-only platforms (honest acceptance)', async () => {
  let busy = false
  let readOnly = false
  let phase = 'idle'
  let selects = 0
  const manager = {
    status: () => ({ phase, pending: phase === 'pending' ? '1.2.3' : null, mutationsAllowed: !readOnly }),
    activationInProgress: () => busy,
    mutationInProgress: () => busy,
    restartInFlight: () => false,
    select: async () => { selects += 1; return { accepted: true, version: 'x' } },
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const ok = await runRoute(routes, 'POST', '/chamber/runtime/select', JSON.stringify({ version: '1.2.3' }))
  assert.equal(ok.status, 202)
  assert.equal(selects, 1)
  busy = true
  const during = await runRoute(routes, 'POST', '/chamber/runtime/select', JSON.stringify({ version: '1.2.3' }))
  assert.equal(during.status, 409)
  assert.equal(selects, 1, 'a refused select must not enqueue')
  busy = false
  phase = 'pending'
  const pending = await runRoute(routes, 'POST', '/chamber/runtime/select', JSON.stringify({ version: '1.2.3' }))
  assert.equal(pending.status, 409)
  assert.equal((pending.json as { code: string }).code, 'runtime_pending')
  assert.equal(selects, 1)
  phase = 'idle'
  readOnly = true
  const ro = await runRoute(routes, 'POST', '/chamber/runtime/select', JSON.stringify({ version: '1.2.3' }))
  assert.equal(ro.status, 403)
  assert.equal(selects, 1)
})

test('restart action delegates to plane.restartLocal() exactly once', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restart-'))
  let restarts = 0
  try {
    const plane = fakePlane()
    plane.restartLocal = async () => {
      restarts += 1
      plane._state.connectionState = 'ready' // a successful restart reaches ready
    }
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
    })
    await manager.restart()
    assert.equal(restarts, 1)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restart outcome lifecycle: status().restart projects running → ok, and failed on rejection', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-outcome-'))
  try {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const plane = fakePlane()
    plane.restartLocal = async () => {
      if (plane._state.restartError !== null) throw new Error(plane._state.restartError)
      plane._state.connectionState = 'ready'
      await gate
    }
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    // 'running' must be visible the moment the 202 poll can read status: a
    // restart accepted but rejected at entry (operationError set, connection
    // state still 'ready') is distinguishable from success by this field.
    const inflight = manager.restart()
    assert.equal((await manager.status()).restart, 'running')
    release()
    await inflight
    assert.equal((await manager.status()).restart, 'ok')
    // Failed restart projects 'failed' + the sanitized operationError.
    plane._state.restartError = 'spawn denied /secret/token=abc'
    await assert.rejects(manager.restart(), /spawn denied/)
    assert.equal((await manager.status()).restart, 'failed')
    const operationError = (await manager.status()).operationError as string
    assert.ok(!operationError.includes('/secret'), 'paths redacted')
    assert.ok(!operationError.includes('token=abc'), 'credentials redacted')
    // RESOLVE ≠ SUCCESS (design 18 §9.3): restartLocal() also resolves from
    // restart-exhausted — that must be 'failed', never 'ok' (review fix).
    plane.restartLocal = async () => { plane._state.connectionState = 'restart-exhausted' }
    await assert.rejects(manager.restart(), /did not reach ready \(restart-exhausted\)/)
    assert.equal((await manager.status()).restart, 'failed')
    assert.ok(((await manager.status()).operationError as string).includes('restart-exhausted'))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('version mutations are refused while a restart is in flight (review fix: both directions fenced)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-fence-'))
  try {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const plane = fakePlane()
    plane.restartLocal = async () => {
      plane._state.connectionState = 'ready'
      await gate
    }
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    const inflight = manager.restart()
    await assert.rejects(manager.select('1.2.3'), /restart is in flight/)
    await assert.rejects(manager.apply(), /restart is in flight/)
    await assert.rejects(manager.rollback('1.2.3'), /restart is in flight/)
    await assert.rejects(manager.restoreBuiltin(), /restart is in flight/)
    // Route level: /select (fire-and-forget 202 path) must ALSO refuse
    // synchronously during a restart, not 'accept' a job the fence rejects.
    const restarting = {
      status: () => ({ phase: 'idle', mutationsAllowed: true, source: 'builtin-anchor' }),
      activationInProgress: () => false,
      mutationInProgress: () => true,
      restartInFlight: () => true,
      select: async () => { throw new Error('must not be called') },
    }
    const routes = createRuntimeRoutes(() => restarting as never, silentLogger)
    const select = await runRoute(routes, 'POST', '/chamber/runtime/select', JSON.stringify({ version: '1.2.3' }))
    assert.equal(select.status, 409)
    assert.equal((select.json as { code: string }).code, 'runtime_busy')
    release()
    await inflight
    // After the restart settles, mutations work again (they reach their own
    // refusals instead of the restart fence — apply without a selection).
    await assert.rejects(manager.apply(), /no runtime version selected/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('retry-apply / retry-restore routes answer 200 with blockedReason, 409 no_retry_target', async () => {
  let retryApplyCalls = 0
  let retryRestoreCalls = 0
  const manager = {
    status: () => ({ phase: 'swap-attempted', mutationsAllowed: true, source: 'builtin-anchor' }),
    retryApply: async () => { retryApplyCalls += 1; return { accepted: true, blockedReason: null } },
    retryRestore: async () => { retryRestoreCalls += 1; return { accepted: true, blockedReason: null } },
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const apply = await runRoute(routes, 'POST', '/chamber/runtime/retry-apply', '{}')
  assert.equal(apply.status, 200)
  assert.equal((apply.json as { blockedReason: unknown }).blockedReason, null)
  const restore = await runRoute(routes, 'POST', '/chamber/runtime/retry-restore', '{}')
  assert.equal(restore.status, 200)
  assert.equal(retryApplyCalls, 1)
  assert.equal(retryRestoreCalls, 1)
  // No matching blocked state → honest 409, never a silent success.
  const refused = {
    status: () => ({ phase: 'idle', mutationsAllowed: true, source: 'builtin-anchor' }),
    retryApply: async () => { throw Object.assign(new Error('no interrupted apply to retry'), { code: 'no_retry_target' }) },
    retryRestore: async () => { throw Object.assign(new Error('no interrupted restore to retry'), { code: 'no_retry_target' }) },
  }
  const refusedRoutes = createRuntimeRoutes(() => refused as never, silentLogger)
  const a = await runRoute(refusedRoutes, 'POST', '/chamber/runtime/retry-apply', '{}')
  assert.equal(a.status, 409)
  assert.equal((a.json as { code: string }).code, 'no_retry_target')
  const r = await runRoute(refusedRoutes, 'POST', '/chamber/runtime/retry-restore', '{}')
  assert.equal(r.status, 409)
})

test('rollback pending cannot be silently superseded by re-select/apply', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-stale-intent-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    // Rollback to 1.0.0 writes an intent journal targeting 1.0.0.
    await manager.rollback('1.0.0')
    const journalAfterRollback = readActivationJournalState(stateDir)
    assert.equal(journalAfterRollback.kind, 'valid')
    if (journalAfterRollback.kind === 'valid') {
      assert.equal(journalAfterRollback.journal.targetVersion, '1.0.0')
    }
    await assert.rejects(manager.select('2.0.0'), (error: unknown) =>
      (error as { code?: string }).code === 'runtime_pending')
    await assert.rejects(manager.apply(), (error: unknown) =>
      (error as { code?: string }).code === 'runtime_pending')
    const journalAfterRefusals = readActivationJournalState(stateDir)
    assert.equal(journalAfterRefusals.kind, 'valid')
    if (journalAfterRefusals.kind === 'valid') {
      assert.equal(journalAfterRefusals.journal.targetVersion, '1.0.0')
      assert.equal(journalAfterRefusals.journal.manualRollback, true)
    }
    const override = readOverride(stateDir)
    assert.equal(override?.pending, '1.0.0')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('real manager: retry-apply/retry-restore refuse without a matching blocked state; retry-apply resumes a swap-attempted override', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-retry-real-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await assert.rejects(manager.retryApply(), /no interrupted apply to retry/)
    await assert.rejects(manager.retryRestore(), /no interrupted restore to retry/)
    // A swap-attempted override: retry-apply clears the marker, re-runs the
    // startup transaction (no pending → not blocked) and brings dsh up.
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.2',
      chosenVersion: '1.2.3',
      resolvedVersion: '1.2.3',
      pending: null,
      swapAttempted: true,
    })
    const result = await manager.retryApply()
    assert.equal(result.accepted, true)
    assert.equal(result.blockedReason, null)
    // The interrupted-switch marker is gone: a second retry refuses.
    await assert.rejects(manager.retryApply(), /no interrupted apply to retry/)
    // snapshot-failed (review fix): a non-destructive recovery exists too —
    // retryApply accepts lastOutcome === 'snapshot-failed', clears it and
    // re-runs the startup transaction (desktop canRetryApply parity).
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.2',
      chosenVersion: '1.2.3',
      resolvedVersion: '1.2.3',
      pending: null,
      swapAttempted: false,
      lastOutcome: 'snapshot-failed',
      lastError: 'snapshot failed',
    })
    const snapshotRetry = await manager.retryApply()
    assert.equal(snapshotRetry.accepted, true)
    assert.equal(snapshotRetry.blockedReason, null)
    await assert.rejects(manager.retryApply(), /no interrupted apply to retry/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('connection_busy maps to 409; oversized bodies release input, write 413, then destroy the socket', async () => {
  const busyManager = {
    status: () => ({ phase: 'idle', mutationsAllowed: true, source: 'builtin-anchor' }),
    rollback: async () => { throw Object.assign(new Error('local restart was invalidated by stop'), { code: 'connection_busy' }) },
  }
  const routes = createRuntimeRoutes(() => busyManager as never, silentLogger)
  const rollback = await runRoute(routes, 'POST', '/chamber/runtime/rollback', JSON.stringify({ version: '1.2.3' }))
  assert.equal(rollback.status, 409)
  assert.equal((rollback.json as { code: string }).code, 'connection_busy')

  // Oversized body: the 413 response must be WRITTEN first, then the request
  // socket destroyed (dispatch.ts ordering; destroy-first drops the response).
  const req = new FakeRequest('POST', '/chamber/runtime/select', { authorization: 'Bearer x' }, JSON.stringify({ version: 'x'.repeat(70 * 1024) })) as unknown as ApiRequest
  const fakeRes = new FakeResponse()
  const claimed = await routes.handle(req, fakeRes as unknown as ApiResponse, '/chamber/runtime/select')
  assert.equal(claimed, true)
  assert.equal(fakeRes.statusCode, 413)
  assert.ok((fakeRes.body ?? '').includes('body too large'))
  assert.equal((req as unknown as { destroyed: boolean }).destroyed, true, 'socket destroyed only after the 413 was written')

  // Streaming regression: once the cap trips, later data is not inspected or
  // retained while the route unwinds to its write-then-destroy error path.
  const streamingReq = new EventEmitter() as EventEmitter & Partial<ApiRequest> & { destroyed: boolean }
  streamingReq.method = 'POST'
  streamingReq.url = '/chamber/runtime/select'
  streamingReq.headers = { authorization: 'Bearer x' }
  streamingReq.destroyed = false
  streamingReq.destroy = () => { streamingReq.destroyed = true; return streamingReq as never }
  const streamingRes = new FakeResponse()
  const handling = routes.handle(
    streamingReq as unknown as ApiRequest,
    streamingRes as unknown as ApiResponse,
    '/chamber/runtime/select',
  )
  streamingReq.emit('data', Buffer.alloc(64 * 1024 + 1))
  const poison = Object.defineProperty({}, 'length', {
    get() { throw new Error('a post-limit runtime chunk was inspected') },
  })
  assert.doesNotThrow(() => streamingReq.emit('data', poison))
  streamingReq.emit('end')
  assert.equal(await handling, true)
  assert.equal(streamingRes.statusCode, 413)
  assert.equal(streamingReq.destroyed, true)
})
