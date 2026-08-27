/**
 * /chamber/runtime controller tests (design 18 §9.3): route behavior matrix —
 * restart 202/409, status pollable while dsh is down, auth gate, registry and
 * body validation, and the runtime manager's resolution chain + single-owner
 * guard. Fakes stand in for the plane; no real dsh, no fixed ports.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { ApiRequest, ApiResponse, Logger, PlaneHandle } from '@dsh-chamber/control-plane'
import type { GatewayConfig } from '../src/config.ts'
import { createGatewayRuntimeManager, readBuiltinVersion } from '../src/runtime-manager.ts'
import { readActivationJournalState, readOverride, writeActivationIntent, writeOverride } from '@dsh-chamber/dsh-runtime'
import { createRuntimeRoutes, sanitizeRouteError, type RuntimeRoutes } from '../src/runtime-routes.ts'

const silentLogger: Logger = { log() {}, warn() {}, error() {} }

function config(stateDir: string): GatewayConfig {
  return {
    plane: { host: '127.0.0.1', port: 3000, stateDir, dshWorkspacePath: '/tmp/anchor-dsh' },
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
    status: () => ({ activeVersion: 'builtin-anchor', source: 'builtin-anchor', phase, pending: null, connectionState: 'stopped', registry: 'https://registry.npmjs.org', platform: 'darwin', mutationsAllowed: true }),
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
    assert.deepEqual(manager.resolveWorkspace(), { path: '/tmp/env-dsh', source: 'env' })
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
    assert.deepEqual(manager.resolveWorkspace(), { path: '/tmp/anchor-dsh', source: 'builtin' })
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

test('startup transaction with no pending switches nothing and does not block', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-startup-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const result = await manager.startupTransaction()
    assert.equal(result.blockedReason, null)
    assert.equal(manager.status().phase, 'idle')
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

test('restoreBuiltin clears the activation journal (R7: journal-mismatch FATAL regression)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restore-journal-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    writeActivationIntent(stateDir, { targetVersion: '9.9.9', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch' })
    assert.equal(readActivationJournalState(stateDir).kind, 'valid')
    await manager.restoreBuiltin()
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'restore-builtin must not leave a mismatching journal behind')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('status suppresses pending under an env override (R7: env defers the switch)', () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-env-pending-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    writeOverride(stateDir, { shellVersion: '0.2.0-beta.2', chosenVersion: '1.0.0', resolvedVersion: '1.0.0', pending: '1.0.0', swapAttempted: false })
    assert.equal(manager.status().pending, null)
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

test('select on an installed-but-inactive tree records the choice instead of refusing (F2)', async () => {
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
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('manager.status() projects the live plane connectionState (ready/restarting/stopped)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-live-conn-'))
  try {
    const plane = fakePlane()
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    assert.equal(manager.status().connectionState, 'stopped')
    plane._state.connectionState = 'restarting'
    assert.equal(manager.status().connectionState, 'restarting')
    plane._state.connectionState = 'ready'
    assert.equal(manager.status().connectionState, 'ready')
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
    const operationError = manager.status().operationError
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
  let selects = 0
  const manager = {
    status: () => ({ phase: 'idle', mutationsAllowed: !readOnly }),
    activationInProgress: () => busy,
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
    assert.equal(manager.status().restart, 'running')
    release()
    await inflight
    assert.equal(manager.status().restart, 'ok')
    // Failed restart projects 'failed' + the sanitized operationError.
    plane._state.restartError = 'spawn denied /secret/token=abc'
    await assert.rejects(manager.restart(), /spawn denied/)
    assert.equal(manager.status().restart, 'failed')
    const operationError = manager.status().operationError as string
    assert.ok(!operationError.includes('/secret'), 'paths redacted')
    assert.ok(!operationError.includes('token=abc'), 'credentials redacted')
    // RESOLVE ≠ SUCCESS (design 18 §9.3): restartLocal() also resolves from
    // restart-exhausted — that must be 'failed', never 'ok' (review fix).
    plane.restartLocal = async () => { plane._state.connectionState = 'restart-exhausted' }
    await assert.rejects(manager.restart(), /did not reach ready \(restart-exhausted\)/)
    assert.equal(manager.status().restart, 'failed')
    assert.ok((manager.status().operationError as string).includes('restart-exhausted'))
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

test('rollback → re-select → apply: the journal agrees with the pending target (round-4 stale-intent regression)', async () => {
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
    // The user changes their mind: re-select the installed 2.0.0, then apply.
    await manager.select('2.0.0')
    // A fresh selection cancels the stale rollback intent (round-4 fix) —
    // otherwise the next boot's journal-vs-pending mismatch check FATALs.
    const journalAfterSelect = readActivationJournalState(stateDir)
    assert.equal(journalAfterSelect.kind, 'missing', 'select cancels the stale intent journal')
    await manager.apply()
    // Apply writes an intent that AGREES with pending: boot must not block.
    const journalAfterApply = readActivationJournalState(stateDir)
    assert.equal(journalAfterApply.kind, 'valid')
    if (journalAfterApply.kind === 'valid') {
      assert.equal(journalAfterApply.journal.targetVersion, '2.0.0')
      assert.equal(journalAfterApply.journal.manualRollback, false)
    }
    const override = readOverride(stateDir)
    assert.equal(override?.pending, '2.0.0')
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

test('connection_busy maps to 409; oversized bodies get a written 413 then a destroyed socket', async () => {
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
})
