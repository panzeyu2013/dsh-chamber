/**
 * /chamber/runtime controller tests (design 18 §9.3): route behavior matrix —
 * restart 202/409, status pollable while dsh is down, auth gate, registry and
 * body validation, and the runtime manager's resolution chain + single-owner
 * guard. Fakes stand in for the plane; no real dsh, no fixed ports.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { ApiRequest, ApiResponse, Logger, PlaneHandle } from '@dsh-chamber/control-plane'
import type { GatewayConfig } from '../src/config.ts'
import { createGatewayRuntimeManager, readBuiltinVersion } from '../src/runtime-manager.ts'
import { createChamberPlugins, hasSyncedHostSeed } from '../src/plugins.ts'
import {
  PROBE_NAMES_WITHOUT_HOST_DOMAINS,
  REQUIRED_ACTIVATION_PROBES,
  clearActivationJournal,
  listKnownGoodVersions,
  readActivationJournalState,
  readCurrentPointer,
  readOverride,
  recordProbePass,
  recordRuntimeFailure,
  writeActivationIntent,
  writeActivationJournal,
  writeCurrentPointer,
  writeOverride,
  stashPreRollback,
  type ActivationJournal,
} from '@dsh-chamber/dsh-runtime'
import { createRuntimeRoutes, sanitizeRouteError, type RuntimeRoutes } from '../src/runtime-routes.ts'
import { FakeRequest, FakeResponse } from './utils.ts'

const silentLogger: Logger = { log() {}, warn() {}, error() {} }

const TEST_BUILTIN_VERSION = '0.9.0'
const gatewayPackageVersion = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }).version

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
async function runRoute(routes: RuntimeRoutes, method: string, path: string, body?: string): Promise<{ status: number; json: unknown }> {
  const fakeReq = new FakeRequest(method, path, { authorization: 'Bearer x' })
  const req = fakeReq as unknown as ApiRequest
  const fakeRes = new FakeResponse()
  const res = fakeRes as unknown as ApiResponse
  // Start the handler first: readJsonBody attaches its stream listeners
  // synchronously, and the paused-mode FakeRequest buffers bytes emitted
  // before a listener attaches — so this ordering is safe either way.
  const pending = routes.handle(req, res, path)
  if (body !== undefined) fakeReq.emit('data', Buffer.from(body))
  fakeReq.emit('end')
  const claimed = await pending
  assert.equal(claimed, true, `${method} ${path} must be claimed`)
  return { status: fakeRes.statusCode, json: fakeRes.body === '' ? null : JSON.parse(fakeRes.body) }
}

/** Poll until the apply-now async job settles (202 semantics expose no promise
 * handle — the outcome arrives via status()/applyNowInFlight). */
async function waitForSettle(manager: { applyNowInFlight(): boolean }): Promise<void> {
  for (let i = 0; i < 400 && manager.applyNowInFlight(); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function waitForMutationSettle(manager: { mutationInProgress(): boolean }): Promise<void> {
  for (let i = 0; i < 400 && manager.mutationInProgress(); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(manager.mutationInProgress(), false, 'runtime mutation did not settle before the test deadline')
}

/** 2026-12 Phase 3 shape gate: the manager expects the full probe set only
 * when the seed cache holds synced chamber host packages; test stateDirs have
 * no cache, so the reduced set matches. */
function probeResultsFor(stateDir: string): readonly string[] {
  return hasSyncedHostSeed(stateDir) ? REQUIRED_ACTIVATION_PROBES : PROBE_NAMES_WITHOUT_HOST_DOMAINS
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

test('cleanup-version / restore-pre-rollback / recover-metadata route matrix (2026-12 desktop parity)', async () => {
  let phase = 'idle'
  const calls: string[] = []
  const manager = {
    status: () => ({ phase, pending: phase === 'pending' ? '9.9.9' : null }),
    mutationInProgress: () => false,
    cleanupVersion: async (version: string) => {
      calls.push(`cleanup:${version}`)
      return { version, removed: true }
    },
    restorePreRollback: async (stashName: string) => {
      calls.push(`restore:${stashName}`)
      return { accepted: true }
    },
    recoverMetadata: async () => {
      calls.push('recover')
      return { accepted: true }
    },
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  // Body validation: both POST bodies are required.
  assert.equal((await runRoute(routes, 'POST', '/chamber/runtime/cleanup-version', '{}')).status, 400)
  assert.equal((await runRoute(routes, 'POST', '/chamber/runtime/restore-pre-rollback', '{}')).status, 400)
  // The pending terminal gate closes all three (only restore-builtin + its
  // own apply-now window stay open while pending).
  phase = 'pending'
  const cleanupPending = await runRoute(routes, 'POST', '/chamber/runtime/cleanup-version', JSON.stringify({ version: '1.0.0' }))
  assert.equal(cleanupPending.status, 409)
  assert.equal((cleanupPending.json as { code: string }).code, 'runtime_pending')
  const restorePending = await runRoute(routes, 'POST', '/chamber/runtime/restore-pre-rollback', JSON.stringify({ stashName: '1700000000000-deadbeef' }))
  assert.equal(restorePending.status, 409)
  const recoverPending = await runRoute(routes, 'POST', '/chamber/runtime/recover-metadata')
  assert.equal(recoverPending.status, 409)
  // Idle: all three accept synchronously.
  phase = 'idle'
  const cleanup = await runRoute(routes, 'POST', '/chamber/runtime/cleanup-version', JSON.stringify({ version: '1.0.0' }))
  assert.equal(cleanup.status, 200)
  assert.deepEqual(cleanup.json, { version: '1.0.0', removed: true })
  const restore = await runRoute(routes, 'POST', '/chamber/runtime/restore-pre-rollback', JSON.stringify({ stashName: '1700000000000-deadbeef' }))
  assert.equal(restore.status, 200)
  assert.deepEqual(restore.json, { accepted: true })
  const recover = await runRoute(routes, 'POST', '/chamber/runtime/recover-metadata')
  assert.equal(recover.status, 200)
  assert.deepEqual(recover.json, { accepted: true })
  assert.deepEqual(calls, ['cleanup:1.0.0', 'restore:1700000000000-deadbeef', 'recover'])
})

test('cleanup-version maps the manager protection refusal to 409 version_still_protected', async () => {
  const manager = {
    status: () => ({ phase: 'idle', pending: null }),
    mutationInProgress: () => false,
    cleanupVersion: async () => {
      throw Object.assign(new Error('dsh 1.0.0 is still protected (known-good); cleanup refused'), { code: 'version_still_protected' })
    },
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const res = await runRoute(routes, 'POST', '/chamber/runtime/cleanup-version', JSON.stringify({ version: '1.0.0' }))
  assert.equal(res.status, 409)
  assert.equal((res.json as { code: string }).code, 'version_still_protected')
})

test('real manager: cleanup refuses non-ledger versions; metadata corruption is recoverable and probe failure keeps the sentinel', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-cleanup-'))
  const oldEnv = process.env.DSH_GATEWAY_DSH_PATH
  let manager: ReturnType<typeof createGatewayRuntimeManager> | null = null
  try {
    delete process.env.DSH_GATEWAY_DSH_PATH
    manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const healthy = await manager.status()
    assert.equal(healthy.canRecoverMetadata, false)
    assert.ok(['healthy', 'unknown'].includes(healthy.metadataHealth ?? ''), 'an untouched state dir is healthy or unknown')
    // Ledger gate: only explicitly installed trees may be cleaned.
    await assert.rejects(manager.cleanupVersion('9.9.9'), /no explicitly installed version tree/)
    // Corrupt the activation journal (the desktop FATAL fixture shape).
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true })
    writeFileSync(join(stateDir, 'dsh-runtime', 'activation-journal.json'), '{corrupt', { mode: 0o600 })
    const blocked = await manager.status()
    assert.equal(blocked.metadataHealth, 'selection-corrupt')
    assert.ok((blocked.metadataComponents ?? []).includes('activation-journal'))
    assert.equal(blocked.canRecoverMetadata, true, 'FATAL journal corruption opens the recover route')
    // The recovery engine archives evidence and probes the builtin anchor;
    // the fake plane has no dsh listener, so the probe fails and the manager
    // keeps the durable record behind the metadata-probe-failed sentinel.
    await manager.recoverMetadata()
    const after = await manager.status()
    assert.equal(after.startupBlockedReason, 'metadata-probe-failed')
    assert.equal(after.canRecoverMetadata, true, 'a failed probe stays recoverable (resumable engine record)')
  } finally {
    if (oldEnv === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = oldEnv
    await manager?.dispose().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('real manager: cleanup/restore/recover refuse env+win32 and recover refuses non-FATAL blocks and healthy state', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-gate-matrix-'))
  const oldEnv = process.env.DSH_GATEWAY_DSH_PATH
  try {
    // env: cleanup + recover refuse (env pins the runtime); the data-restore
    // escape (restore-pre-rollback) stays env-independent and only fails on
    // its own stash validation.
    process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
    const envManager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await assert.rejects(envManager.cleanupVersion('1.0.0'), /DSH_GATEWAY_DSH_PATH/)
    await assert.rejects(envManager.recoverMetadata(), /DSH_GATEWAY_DSH_PATH/)
    await assert.rejects(envManager.restorePreRollback('1700000000000-deadbeef'), /no longer exists or is untrustworthy/)
    await envManager.dispose()
    // win32: everything is read-only, including the new routes.
    const win32Manager = createGatewayRuntimeManager({
      config: config(stateDir), plane: fakePlane(), logger: silentLogger, platform: 'win32',
    })
    await assert.rejects(win32Manager.cleanupVersion('1.0.0'), { code: 'platform_read_only' })
    await assert.rejects(win32Manager.restorePreRollback('1700000000000-deadbeef'), { code: 'platform_read_only' })
    await assert.rejects(win32Manager.recoverMetadata(), { code: 'platform_read_only' })
    await win32Manager.dispose()
    // Healthy state: recover refuses loudly.
    delete process.env.DSH_GATEWAY_DSH_PATH
    const healthy = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await assert.rejects(healthy.recoverMetadata(), /no corrupt metadata to recover/)
    // Non-FATAL startup block (swap-attempted): recover refuses with the
    // recovery-required code — the swap/restore retry surface owns it.
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.2.3', resolvedVersion: '1.2.3',
      pending: '1.2.3', swapAttempted: true,
    })
    const swap = await healthy.startupTransaction()
    assert.equal(swap.blockedReason, 'swap-attempted')
    await assert.rejects(healthy.recoverMetadata(), { code: 'runtime_recovery_required' })
    // cleanup hits the pending terminal gate BEFORE the block reason (desktop
    // parity: a pending override is a swap awaiting the next startup — the
    // swap/restore retry surface owns the block).
    await assert.rejects(healthy.cleanupVersion('1.2.3'), { code: 'runtime_pending' })
    await healthy.dispose()
  } finally {
    if (oldEnv === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = oldEnv
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('real manager: recoverMetadata finalizes on ok probes and brings the builtin anchor up', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-recover-ok-'))
  const oldEnv = process.env.DSH_GATEWAY_DSH_PATH
  try {
    delete process.env.DSH_GATEWAY_DSH_PATH
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true })
    writeFileSync(join(stateDir, 'dsh-runtime', 'activation-journal.json'), '{corrupt', { mode: 0o600 })
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"preserved"}')
    const order: string[] = []
    const probed: string[] = []
    const plane = fakePlane({
      stopLocal: async () => { order.push('stop') },
      startLocal: async () => { order.push('start') },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async ({ isBuiltin }) => {
        probed.push(isBuiltin ? 'builtin' : 'override')
        return probeResultsFor(stateDir).map(name => ({ name, ok: true }))
      },
    })
    await manager.recoverMetadata()
    const after = await manager.status()
    assert.equal(after.startupBlockedReason, null, 'a finalized recovery clears the block')
    assert.equal(after.canRecoverMetadata, false)
    assert.equal(after.activeVersion, TEST_BUILTIN_VERSION, 'recovery finalizes onto the builtin anchor')
    assert.equal(after.source, 'builtin-anchor')
    assert.ok(probed.includes('builtin'), 'the builtin anchor ran through the full read-only probe gate')
    assert.ok(order.includes('stop'), 'the managed dsh was quiesced before evidence archival')
    assert.ok(order.indexOf('start') > order.indexOf('stop'), 'the verdict winner starts only after the transaction')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"preserved"}')
    await manager.dispose()
  } finally {
    if (oldEnv === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = oldEnv
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('mid-run metadata drift: recover-metadata opens through the free-text block (status/UI/route consistency, 2026 audit R4)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-drift-recover-'))
  const oldEnv = process.env.DSH_GATEWAY_DSH_PATH
  try {
    delete process.env.DSH_GATEWAY_DSH_PATH
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true })
    // A healthy selection whose CURRENT pointer then rots MID-RUN (no boot
    // verdict since the corruption): status projects the resolution error
    // text AND reports canRecoverMetadata — the route gate must classify by
    // the flag, not the free text (the old gate refused the very recovery
    // route it advertised, locking every mutation until a gateway restart).
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: false,
    })
    writeFileSync(join(stateDir, 'dsh-runtime', 'current'), '{corrupt', { mode: 0o600 })
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"preserved"}')
    const order: string[] = []
    const plane = fakePlane({
      stopLocal: async () => { order.push('stop') },
      startLocal: async () => { order.push('start') },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    const before = await manager.status()
    assert.equal(before.phase, 'idle')
    assert.match(before.startupBlockedReason ?? '', /current pointer is corrupt/, 'the drift surfaces as a free-text block')
    assert.equal(before.canRecoverMetadata, true, 'the projection advertises the recovery route')

    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const refused = await runRoute(routes, 'POST', '/chamber/runtime/select', JSON.stringify({ version: '1.0.0' }))
    assert.equal(refused.status, 409)
    assert.equal((refused.json as { code: string }).code, 'runtime_recovery_required')
    assert.match((refused.json as { error: string }).error, /only recover-metadata is allowed/, 'the refusal names the real open route')
    const recovered = await runRoute(routes, 'POST', '/chamber/runtime/recover-metadata')
    assert.equal(recovered.status, 200, 'recover-metadata is reachable through the free-text block (R4)')

    const after = await manager.status()
    assert.equal(after.startupBlockedReason, null, 'a finalized recovery clears the drift block')
    assert.equal(after.canRecoverMetadata, false)
    assert.equal(after.activeVersion, TEST_BUILTIN_VERSION, 'recovery finalizes onto the builtin anchor')
    assert.equal(after.source, 'builtin-anchor')
    assert.ok(order.indexOf('start') > order.indexOf('stop'), 'the verdict winner starts only after the transaction')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"preserved"}')
    await manager.dispose()
  } finally {
    if (oldEnv === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = oldEnv
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('gate: recover-metadata opens when canRecoverMetadata is projected under a pending with no block text (R4 drift variant)', async () => {
  const calls: string[] = []
  const manager = {
    status: () => ({ phase: 'idle', pending: '1.1.0', startupBlockedReason: null, canRecoverMetadata: true }),
    mutationInProgress: () => false,
    select: async () => { calls.push('select'); return { accepted: true } },
    recoverMetadata: async () => { calls.push('recover'); return { accepted: true } },
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const recovered = await runRoute(routes, 'POST', '/chamber/runtime/recover-metadata')
  assert.equal(recovered.status, 200, 'corrupt metadata under an armed pending must not hide recover-metadata behind the pending gate')
  assert.deepEqual(calls, ['recover'])
  const select = await runRoute(routes, 'POST', '/chamber/runtime/select', JSON.stringify({ version: '1.1.0' }))
  assert.equal(select.status, 409)
  assert.equal((select.json as { code: string }).code, 'runtime_pending')
  assert.deepEqual(calls, ['recover'], 'ordinary mutations stay refused by the pending terminal gate')
})

test('gateway runtime ownership fails closed when dsh-runtime root is a symlink', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-root-link-'))
  const externalDir = mkdtempSync(join(tmpdir(), 'gw-rt-root-target-'))
  try {
    const gatewayConfig = config(stateDir)
    const sentinel = join(externalDir, 'sentinel')
    writeFileSync(sentinel, 'outside-state', { mode: 0o644 })
    symlinkSync(externalDir, join(stateDir, 'dsh-runtime'), process.platform === 'win32' ? 'junction' : 'dir')

    assert.throws(
      () => createGatewayRuntimeManager({ config: gatewayConfig, plane: fakePlane(), logger: silentLogger }),
      /不安全|unsafe/i,
    )
    assert.equal(readFileSync(sentinel, 'utf8'), 'outside-state')
    assert.equal(statSync(sentinel).mode & 0o777, 0o644)
    assert.ok(!existsSync(join(externalDir, 'owner.json')), 'owner guard never writes through the linked root')
    assert.ok(!existsSync(join(externalDir, 'registry.json')), 'registry state never writes through the linked root')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(externalDir, { recursive: true, force: true })
  }
})

test('gateway runtime ownership refuses an unsafe owner leaf without touching its target', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-link-'))
  const externalDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-target-'))
  try {
    const gatewayConfig = config(stateDir)
    const stateRoot = join(stateDir, 'dsh-runtime')
    const externalOwner = join(externalDir, 'owner-target')
    mkdirSync(stateRoot, { mode: 0o700 })
    writeFileSync(externalOwner, JSON.stringify({ pid: 99_999_999 }), { mode: 0o644 })
    symlinkSync(externalOwner, join(stateRoot, 'owner.json'), 'file')

    assert.throws(
      () => createGatewayRuntimeManager({ config: gatewayConfig, plane: fakePlane(), logger: silentLogger }),
      /owner record is unsafe or unreadable/,
    )
    assert.equal(readFileSync(externalOwner, 'utf8'), JSON.stringify({ pid: 99_999_999 }))
    assert.equal(statSync(externalOwner).mode & 0o777, 0o644)
    assert.ok(lstatSync(join(stateRoot, 'owner.json')).isSymbolicLink(), 'unsafe owner evidence remains in place')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(externalDir, { recursive: true, force: true })
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

test('stale-owner takeover detects A-move/A-create/B-move and restores the exact fresh owner', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-interleave-'))
  try {
    const stateRoot = join(stateDir, 'dsh-runtime')
    const owner = join(stateRoot, 'owner.json')
    const displacedOld = join(stateRoot, 'owner.old-fixture')
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    writeFileSync(owner, `${JSON.stringify({ pid: 99_999_999, startedAt: 'old' })}\n`, { mode: 0o600 })
    const freshPayload = `${JSON.stringify({ pid: process.pid, startedAt: 'fresh', token: 'a'.repeat(48) })}\n`

    assert.throws(
      () => createGatewayRuntimeManager({
        config: config(stateDir),
        plane: fakePlane(),
        logger: silentLogger,
        ownerTakeoverBeforeRename: () => {
          // A has already read the stale owner. Just after B's final old-inode
          // check, A wins the rename and publishes its fresh token; B's rename
          // therefore moves A's fresh owner and must detect/restore it.
          renameSync(owner, displacedOld)
          writeFileSync(owner, freshPayload, { mode: 0o600 })
        },
      }),
      /replaced the owner during stale takeover|could not be durably claimed/,
    )
    assert.equal(readFileSync(owner, 'utf8'), freshPayload,
      'the losing takeover restores A\'s exact fresh token instead of entering or deleting it')
    assert.ok(existsSync(displacedOld), 'the original dead-owner evidence remains available')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('constructor and scheduler cancellation failures release ownership safely', async () => {
  const constructDir = mkdtempSync(join(tmpdir(), 'gw-rt-scheduler-construct-'))
  try {
    const abandonedTicks: Array<() => void> = []
    assert.throws(() => createGatewayRuntimeManager({
      config: config(constructDir),
      plane: fakePlane(),
      logger: silentLogger,
      scheduleKnownGoodPromotion: callback => {
        abandonedTicks.push(callback)
        throw new Error('scheduler setup failed')
      },
    }), /scheduler setup failed/)
    assert.equal(existsSync(join(constructDir, 'dsh-runtime', 'owner.json')), false,
      'a constructor tail failure releases the exact acquired lease')
    assert.equal(abandonedTicks.length, 1)
    abandonedTicks[0]!()
    assert.equal(existsSync(join(constructDir, 'dsh-runtime', 'owner.json')), false,
      'a scheduler callback retained by a throwing adapter is permanently fenced')
    const replacement = createGatewayRuntimeManager({ config: config(constructDir), plane: fakePlane(), logger: silentLogger })
    await replacement.dispose()
  } finally {
    rmSync(constructDir, { recursive: true, force: true })
  }

  const cancelDir = mkdtempSync(join(tmpdir(), 'gw-rt-scheduler-cancel-'))
  try {
    const manager = createGatewayRuntimeManager({
      config: config(cancelDir),
      plane: fakePlane(),
      logger: silentLogger,
      scheduleKnownGoodPromotion: () => () => { throw new Error('scheduler cancel failed') },
    })
    await manager.dispose()
    assert.equal(existsSync(join(cancelDir, 'dsh-runtime', 'owner.json')), false,
      'a fenced stale callback cannot make cancellation failure skip writer drain/release')
  } finally {
    rmSync(cancelDir, { recursive: true, force: true })
  }
})

test('Windows read-only projection never enters POSIX runtime-root writer primitives', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-win-readonly-'))
  const external = mkdtempSync(join(tmpdir(), 'gw-rt-win-external-'))
  try {
    const gatewayConfig = config(stateDir)
    const sentinel = join(external, 'sentinel')
    writeFileSync(sentinel, 'untouched', { mode: 0o644 })
    symlinkSync(external, join(stateDir, 'dsh-runtime'), process.platform === 'win32' ? 'junction' : 'dir')
    let schedulerCalled = false
    const manager = createGatewayRuntimeManager({
      config: gatewayConfig,
      plane: fakePlane(),
      logger: silentLogger,
      platform: 'win32',
      scheduleKnownGoodPromotion: () => {
        schedulerCalled = true
        return () => {}
      },
    })
    assert.equal(manager.stateRoot(), join(stateDir, 'dsh-runtime'))
    assert.equal(manager.resolveWorkspace().source, 'builtin')
    assert.deepEqual(await manager.startupTransaction(), { blockedReason: null })
    const status = await manager.status()
    assert.equal(status.platform, 'win32')
    assert.equal(status.mutationsAllowed, false)
    assert.equal(status.activeVersion, TEST_BUILTIN_VERSION)
    assert.equal(manager.getRegistry().origin, 'https://registry.npmjs.org')
    await assert.rejects(manager.setRegistry('https://registry.npmmirror.com'), (error: unknown) => (
      (error as Error & { code?: string }).code === 'platform_read_only'
    ))
    assert.equal(schedulerCalled, false, 'the POSIX sustained-health writer is not scheduled on Windows')
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
    assert.equal(statSync(sentinel).mode & 0o777, 0o644)
    assert.equal(existsSync(join(external, 'owner.json')), false)
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
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
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '2.0.0',
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

test('ordinary pending is a core+route terminal gate: apply-now is allowed (202, pending untouched), every other action is 409 and non-mutating', async () => {
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
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    // The apply-now transaction must not race the assertions below: hold the
    // quiesce step until the durable pending/override are verified untouched.
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const plane = fakePlane({ stopLocal: async () => { await stopGate } })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
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

    // apply-now is pending's own semantic premise (design 18 addendum §5.1):
    // allowed with 202, and the durable pending/override stay untouched while
    // the async transaction is held at the quiesce step.
    const now = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(now.status, 202)
    assert.equal((now.json as { accepted: boolean }).accepted, true)
    assert.equal((now.json as { version: string }).version, '1.0.0', 'the 202 body carries the preflighted target')
    assert.equal(readOverride(stateDir)?.pending, '1.0.0', 'the 202 answer must not clear or rewrite pending')
    assert.equal(readOverride(stateDir)?.chosenVersion, '1.0.0')
    assert.equal(readActivationJournalState(stateDir).kind, 'valid', 'the armed intent journal is preserved')
    assert.equal(manager.applyNowInFlight(), true, 'the apply-now job is in flight')
    assert.equal((await manager.status()).phase, 'applying', 'the 202 window polls as applying')
    releaseStop()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.equal((await manager.status()).phase, 'idle')
    assert.equal(readCurrentPointer(stateDir), '1.0.0', 'apply-now committed the armed switch')

    const restored = await runRoute(routes, 'POST', '/chamber/runtime/restore-builtin')
    assert.equal(restored.status, 200, 'restore-builtin remains the recovery escape after apply-now')
    assert.equal(readOverride(stateDir), null)
    assert.equal((await manager.status()).phase, 'idle')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now route matrix: 202 with pending, 409 recovery/busy/env/read-only/no-selection/not-running/in-flight', async () => {
  let phase = 'pending'
  let pending: string | null = '1.0.0'
  let selectedVersion: string | null = '1.0.0'
  let connectionState = 'ready'
  let source = 'user-selected'
  let mutationsAllowed = true
  let mutationBusy = false
  let applyNowBusy = false
  let applyNowCalls = 0
  let preflightCalls = 0
  const manager = {
    status: () => ({ phase, pending, selectedVersion, connectionState, source, mutationsAllowed }),
    mutationInProgress: () => mutationBusy,
    applyNowInFlight: () => applyNowBusy,
    // The real manager's preflight contract: target = ordinary pending, else
    // a valid (non-invalidated) chosenVersion; both empty → no_selection.
    // The route relies on THIS for the no_selection gate now — a status-based
    // precheck can no longer mis-let an invalidated selection through (R3/R5).
    applyNowPreflight: () => {
      preflightCalls += 1
      if (pending === null && selectedVersion === null) {
        throw Object.assign(new Error('no runtime version selected or pending'), { code: 'no_selection' })
      }
      return (pending ?? selectedVersion) as string
    },
    applyNow: async () => { applyNowCalls += 1; return { accepted: true } },
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)

  const ok = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
  assert.equal(ok.status, 202, 'ready + pending is the apply-now semantic premise')
  assert.equal((ok.json as { accepted: boolean }).accepted, true)
  assert.equal((ok.json as { version: string }).version, '1.0.0', 'the 202 body carries the preflighted target')
  assert.equal(applyNowCalls, 1)

  // Recovery phases refuse apply-now (only their exact retry; restore-builtin
  // applies to pending/healthy selections only — 2026 audit R2).
  for (const recoveryPhase of ['snapshot-failed', 'swap-attempted', 'restore-blocked']) {
    phase = recoveryPhase
    const recovery = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(recovery.status, 409, `${recoveryPhase} must refuse apply-now`)
    assert.equal((recovery.json as { code: string }).code, 'runtime_recovery_required')
  }
  phase = 'pending'

  // installing/applying in flight → runtime_busy (single-flight, honest 409).
  for (const busyPhase of ['installing', 'applying']) {
    phase = busyPhase
    mutationBusy = true
    const busy = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(busy.status, 409)
    assert.equal((busy.json as { code: string }).code, 'runtime_busy')
    mutationBusy = false
  }
  phase = 'pending'

  // A restart in flight is the same writer fence.
  mutationBusy = true
  const restarting = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
  assert.equal(restarting.status, 409)
  assert.equal((restarting.json as { code: string }).code, 'runtime_busy')
  mutationBusy = false

  source = 'env'
  const env = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
  assert.equal(env.status, 409)
  assert.equal((env.json as { code: string }).code, 'env_override_active')
  source = 'user-selected'

  mutationsAllowed = false
  const readOnly = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
  assert.equal(readOnly.status, 403)
  assert.equal((readOnly.json as { code: string }).code, 'platform_read_only')
  mutationsAllowed = true

  pending = null
  selectedVersion = null
  phase = 'idle'
  const none = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
  assert.equal(none.status, 409)
  assert.equal((none.json as { code: string }).code, 'no_selection')
  selectedVersion = '1.0.0'
  phase = 'pending'
  pending = '1.0.0'

  connectionState = 'stopped'
  const notRunning = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
  assert.equal(notRunning.status, 409, 'sync refusal must be honest, not a fake 202 (R7)')
  assert.equal((notRunning.json as { code: string }).code, 'runtime_busy')
  connectionState = 'ready'

  applyNowBusy = true
  const inflight = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
  assert.equal(inflight.status, 409)
  assert.equal((inflight.json as { code: string }).code, 'runtime_busy')
  applyNowBusy = false
  assert.equal(applyNowCalls, 1, 'a refused apply-now must not enqueue')
  assert.equal(preflightCalls, 2,
    'preflight runs only where no earlier route gate short-circuits: the initial 202 and the no_selection case')
})

test('apply-now preflight refuses an invalidated (stale-shell) selection synchronously — 409 no_selection, never a fake 202 (R3/R5)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-invalidated-'))
  try {
    makeValidTree(stateDir, '2.0.0')
    // A gateway upgrade invalidates the override (shellVersion mismatch) but
    // RETAINS chosenVersion: status.selectedVersion is still set while
    // status.pending is null (effectivePending filters the invalidation). The
    // old status-based no_selection gate let this through to a fake 202.
    writeOverride(stateDir, {
      shellVersion: '0.0.1', chosenVersion: '2.0.0', resolvedVersion: '2.0.0',
      pending: null, swapAttempted: false,
    })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const status = await manager.status()
    assert.equal(status.selectedVersion, '2.0.0', 'the invalidated record retains its choice')
    assert.equal(status.pending, null, 'effective pending filters the invalidation')
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 409)
    assert.equal((response.json as { code: string }).code, 'no_selection')
    assert.equal(manager.applyNowInFlight(), false, 'a refused apply-now must not arm in-flight state')
    assert.equal(readOverride(stateDir)?.pending, null, 'no pending switch is armed')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'no journal is written')
    await assert.rejects(manager.applyNow(), (error: unknown) =>
      (error as { code?: string }).code === 'no_selection', 'the direct manager call refuses identically')
    assert.equal(manager.applyNowInFlight(), false)
    assert.equal(readCurrentPointer(stateDir), null, 'no transaction was armed')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now preflight refuses a pending target with no valid version tree synchronously — 409 invalid_target, no 202', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-notree-'))
  try {
    // pending points at a version whose tree is gone (e.g. evicted). The old
    // flow 202'd first and only then failed inside the async job — the
    // preflight must refuse before any 202 can go out.
    writeActivationIntent(stateDir, {
      targetVersion: '3.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '3.0.0', resolvedVersion: '3.0.0',
      pending: '3.0.0', swapAttempted: false,
    })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    assert.equal((await manager.status()).phase, 'pending')
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 409)
    assert.equal((response.json as { code: string }).code, 'invalid_target')
    assert.equal(manager.applyNowInFlight(), false, 'a refused apply-now must not arm in-flight state')
    await assert.rejects(manager.applyNow(), (error: unknown) =>
      (error as { code?: string }).code === 'invalid_target', 'the direct manager call refuses identically')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now preflight rejects a no-op re-application of the active runtime — 409 noop_target, nothing armed', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-noop-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: false, lastOutcome: 'applied',
    })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 409)
    assert.equal((response.json as { code: string }).code, 'noop_target')
    assert.equal((response.json as { error: string }).error, 'dsh v1.0.0 is already the active runtime; apply-now has nothing to do')
    assert.equal(manager.applyNowInFlight(), false, 'a no-op rejection arms nothing')
    assert.equal(readOverride(stateDir)?.pending, null, 'no pending switch is armed')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'no journal is written')
    await assert.rejects(manager.applyNow(), (error: unknown) =>
      (error as { code?: string }).code === 'noop_target', 'the direct manager call refuses identically')
    assert.equal(manager.applyNowInFlight(), false)
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('applyNowInFlight fences every other runtime mutation at the manager level (assertMutationIdle, R3/R5)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-fence-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const plane = fakePlane({ stopLocal: async () => { await stopGate } })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    await manager.applyNow()
    assert.equal(manager.applyNowInFlight(), true)
    // The managed profile-write lease is refused for the whole apply-now
    // window (phase 'applying'): a plugin pnpm child must never interleave
    // the stop → snapshot → pointer switch → probe transaction.
    const leased = manager.beginProfileWrite()
    assert.equal(leased.ok, false)
    if (!leased.ok) {
      assert.equal(leased.code, 'runtime_busy')
      assert.match(leased.error, /apply-now transaction is in flight|runtime activation in progress/)
    }
    // applyNowInFlight feeds assertMutationIdle directly — the fence no longer
    // depends on activationDepth's timing coincidence (review R3/R5).
    for (const refuse of [
      () => manager.select('1.0.0'),
      () => manager.apply(),
      () => manager.rollback('1.0.0'),
      () => manager.restoreBuiltin(),
      () => manager.restart(),
    ]) {
      await assert.rejects(refuse(), (error: unknown) =>
        (error as { code?: string }).code === 'runtime_busy', 'apply-now in flight fences every mutation with runtime_busy')
    }
    releaseStop()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.equal(readCurrentPointer(stateDir), '1.0.0', 'the fenced window still committed its own switch')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('applyNow F2 arm mirrors the apply() manualRollback formula: a staged downgrade (chosen < current) arms manualRollback=true', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-f2-downgrade-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '2.0.0')
    // Active v2, staged selection of v1 (a downgrade), no pending yet — the
    // preflight arms the pending switch journal-first and must record the
    // downgrade as a manual rollback, exactly like apply() :1084 (review fix:
    // it used to be hardcoded false).
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: false, selectedOnly: false, lastOutcome: 'applied',
    })
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const plane = fakePlane({ stopLocal: async () => { await stopGate } })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    const accepted = await manager.applyNow()
    assert.equal(accepted.accepted, true)
    const armed = readOverride(stateDir)
    assert.equal(armed?.pending, '1.0.0')
    const journal = readActivationJournalState(stateDir)
    assert.equal(journal.kind, 'valid')
    if (journal.kind === 'valid') {
      assert.equal(journal.journal.manualRollback, true,
        'a staged downgrade arms manualRollback=true (compareRuntimeVersions(target, current) === -1)')
      assert.equal(journal.journal.intentKind, 'version-switch')
      assert.equal(journal.journal.targetVersion, '1.0.0')
    }
    releaseStop()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.equal(readCurrentPointer(stateDir), '1.0.0', 'the downgrade switch committed')
    assert.equal((await manager.status()).activeVersion, '1.0.0')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now 202: the window polls as applying with connectionState stopped, then the switch commits', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-window-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const plane = fakePlane({
      stopLocal: async () => { plane._state.connectionState = 'stopped'; await stopGate },
      startLocal: async () => { plane._state.connectionState = 'ready' },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    assert.equal((await manager.status()).phase, 'pending')
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 202)
    assert.equal((response.json as { accepted: boolean }).accepted, true)
    assert.equal((response.json as { version: string }).version, '1.0.0', 'the 202 body carries the preflighted target')
    const window = await manager.status()
    assert.equal(window.phase, 'applying', 'the 202 window polls as applying (restart-parity)')
    assert.equal(window.connectionState, 'stopped', 'the managed dsh is honestly stopped inside the window')
    releaseStop()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    const settled = await manager.status()
    assert.equal(settled.phase, 'idle')
    assert.equal(settled.connectionState, 'ready')
    assert.equal(settled.activeVersion, '1.0.0')
    assert.equal(readCurrentPointer(stateDir), '1.0.0', 'the apply-now transaction committed the switch')
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
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '2.0.0',
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
        return probeResultsFor(stateDir).map(name => ({ name, ok: true }))
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
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '2.0.0',
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
        return probeResultsFor(stateDir).map(name => ({ name, ok: !isBuiltin, ...(!isBuiltin ? {} : { error: 'rejected' }) }))
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

test('applyNow runs the version-switch activation transaction in stop → transaction → start order', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-order-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    const order: string[] = []
    const plane = fakePlane({
      stopLocal: async () => { order.push('stop') },
      startLocal: async () => { order.push('start') },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async () => {
        order.push('probe:override')
        return probeResultsFor(stateDir).map(name => ({ name, ok: true }))
      },
      onActivationQuarantineChange: (active) => { order.push(`quarantine:${active ? 'on' : 'off'}`) },
    })
    await manager.applyNow()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.equal(order[0], 'quarantine:on', 'derived consumers detach before the host is quiesced')
    assert.ok(order.indexOf('stop') < order.indexOf('probe:override'), 'DSH_HOME is quiesced before snapshot/switch/probe')
    assert.ok(order.indexOf('probe:override') < order.indexOf('quarantine:off'),
      'candidate ready remains quarantined through the complete probe verdict')
    assert.equal(order.filter(entry => entry === 'start').length, 2,
      'one start spawns the candidate inside the transaction (internal spawn), one resumes the verdict winner')
    // P0 regression: the verdict-winner resume must happen AFTER the activation
    // window closes. Inside the window index.ts's canStartLocal gate refuses
    // every non-internal spawn (activationInProgress() && !internalSpawnActive()
    // → connection_busy) — the old apply-now therefore threw on every recovery.
    assert.ok(order.indexOf('quarantine:off') < order.lastIndexOf('start'),
      'the verdict-winner resume happens only after the activation window closes (restoreBuiltin parity)')
    assert.ok(readdirSync(join(stateDir, 'dsh-runtime', 'snapshots')).some(name => name.startsWith(`${TEST_BUILTIN_VERSION}-`)),
      'the switching-from builtin DSH_HOME is snapshotted under its real source version')
    assert.equal(readCurrentPointer(stateDir), '1.0.0', 'the pointer switched inside the activation transaction')
    const journal = readActivationJournalState(stateDir)
    assert.equal(journal.kind, 'valid')
    if (journal.kind === 'valid') {
      assert.equal(journal.journal.phase, 'applied-monitoring',
        'a successful version switch keeps the known-good monitoring journal (unlike reset-builtin)')
    }
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"pending":true}')
    const status = await manager.status()
    assert.equal(status.phase, 'idle')
    assert.equal(status.activeVersion, '1.0.0')
    assert.equal(status.operationError, null, 'a clean apply-now clears the operationError projection')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('2026-12 shape gate: a synced seed cache flips the activation to the FULL probe set — and drift fails closed', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-shape-'))
  try {
    // Seed BOTH host packages into the gateway seed cache, exactly as a
    // connecting desktop would (PUT /chamber/plugins → chamber-plugins cache).
    // The probe shape gate (hasSyncedHostSeed) must now expect the full
    // 7-name set — this is the flow that makes a fresh gateway pick the
    // chamber host layer up after the first desktop sync.
    const plugins = createChamberPlugins(stateDir, silentLogger)
    for (const name of ['@dsh-chamber/dsh-host-client-graph', '@dsh-chamber/dsh-host-git-worktree']) {
      await plugins.put(name, {
        'package.json': JSON.stringify({ name, version: '1.0.0' }),
        'dist/index.js': 'export const ok = 1\n',
      })
    }
    assert.equal(hasSyncedHostSeed(stateDir), true, 'the populated cache must flip the shape gate')
    assert.deepEqual(probeResultsFor(stateDir), [...REQUIRED_ACTIVATION_PROBES],
      'the synced shape expects the FULL probe set, chamber host domains included')

    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: false, selectedOnly: true,
    })

    // Full-set candidate (the synced shape) → activation PASSES.
    const passingPlane = fakePlane()
    passingPlane._state.connectionState = 'ready'
    const passing = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: passingPlane,
      logger: silentLogger,
      waitBeforeRetry: async () => {},
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    await passing.applyNow()
    await waitForSettle(passing)
    assert.equal(readCurrentPointer(stateDir), '1.0.0', 'full-set activation passes once the cache is synced')
    assert.equal((await passing.status()).operationError, null)
    await passing.dispose()

    // Drift: the probe returns the REDUCED set while the verdict expects the
    // FULL set (a mid-transaction cache flip or a desynced shape gate) — the
    // activation must FAIL CLOSED, never pass on a partial probe set.
    clearActivationJournal(stateDir)
    makeValidTree(stateDir, '2.0.0')
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '2.0.0',
      pending: null, swapAttempted: false, lastOutcome: 'applied', selectedOnly: true,
    })
    const driftingPlane = fakePlane()
    driftingPlane._state.connectionState = 'ready'
    const drifting = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: driftingPlane,
      logger: silentLogger,
      waitBeforeRetry: async () => {},
      probeCandidate: async ({ isBuiltin }) => {
        return [...PROBE_NAMES_WITHOUT_HOST_DOMAINS].map(name => ({ name, ok: !isBuiltin, ...(!isBuiltin ? {} : { error: 'rejected' }) }))
      },
    })
    await drifting.applyNow()
    await waitForSettle(drifting)
    // The drift poisons EVERY verdict in the transaction: the candidate fails
    // the exact-set check, and the fallback/builtin verification probes fail
    // the same way — the activation ends 'failed' with the pointer cleared
    // (fail-closed), never a partial 'pass' on a reduced probe set.
    assert.equal(readOverride(stateDir)?.lastOutcome, 'failed',
      'the reduced-set drift must fail the activation (fallback verification included)')
    assert.equal(readCurrentPointer(stateDir), null, 'the drift-failed activation clears the pointer (builtin fallback)')
    assert.notEqual((await drifting.status()).operationError, null, 'the drift failure projects into the operationError')
    await drifting.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('applyNow with only a staged selection (selectedOnly, no pending) arms the pending switch journal-first (F2)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-f2-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: false, selectedOnly: true,
    })
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const order: string[] = []
    const plane = fakePlane({
      stopLocal: async () => { order.push('stop'); await stopGate },
      startLocal: async () => { order.push('start') },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async () => {
        order.push('probe')
        return probeResultsFor(stateDir).map(name => ({ name, ok: true }))
      },
    })
    const accepted = await manager.applyNow()
    assert.equal(accepted.accepted, true)
    // F2: the pending switch is armed journal-first, synchronously, before the
    // transaction — runStartupPhase requires effectivePending === targetVersion.
    const armed = readOverride(stateDir)
    assert.equal(armed?.pending, '1.0.0')
    assert.equal(armed?.chosenVersion, '1.0.0')
    assert.equal(armed?.selectedOnly, false)
    assert.equal(armed?.lastOutcome, null)
    const journal = readActivationJournalState(stateDir)
    assert.equal(journal.kind, 'valid')
    if (journal.kind === 'valid') {
      assert.equal(journal.journal.targetVersion, '1.0.0')
      assert.equal(journal.journal.targetIsBuiltin, false)
      assert.equal(journal.journal.manualRollback, false)
      assert.equal(journal.journal.intentKind, 'version-switch')
    }
    releaseStop()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.equal(readCurrentPointer(stateDir), '1.0.0', 'the armed switch committed')
    assert.ok(order.indexOf('stop') < order.indexOf('probe'), 'host quiesced before the transaction')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('applyNow snapshot failure stays snapshot-failed, resumes the untouched source, and projects operationError (F3)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-snapfail-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    // A regular FILE where the snapshots dir must live makes the snapshot
    // seam throw → shared core projects snapshot-failed (never a pointer touch).
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true })
    writeFileSync(join(stateDir, 'dsh-runtime', 'snapshots'), 'not a directory', { mode: 0o600 })
    const order: string[] = []
    const plane = fakePlane({
      stopLocal: async () => { order.push('stop') },
      startLocal: async () => { order.push('start') },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    const accepted = await manager.applyNow()
    assert.equal(accepted.accepted, true)
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    const status = await manager.status()
    assert.equal(status.phase, 'snapshot-failed', 'the terminal snapshot-failed phase is projected')
    assert.equal(status.startupBlockedReason, 'snapshot-failed')
    assert.equal(typeof status.operationError, 'string', 'F3: the 202 job failure projects into status, not only the log')
    assert.notEqual(status.operationError, '')
    assert.equal(readCurrentPointer(stateDir), null, 'a failed snapshot never touches the pointer')
    assert.equal(readOverride(stateDir)?.pending, '1.0.0', 'snapshot-failed retains the pending switch for retry-apply')
    assert.equal(readOverride(stateDir)?.lastOutcome, 'snapshot-failed')
    assert.deepEqual(order, ['stop', 'start'],
      'the source is quiesced, the snapshot fails without spawning, then the untouched source is resumed (restoreBuiltin :1180-1192 parity)')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('applyNow recovery startLocal runs OUTSIDE the activation window (gate-aware plane): clean switch path (P0 regression)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-gate-clean-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    // Gate-aware fake plane (P0 regression): models index.ts canStartLocal —
    // activationInProgress() && !internalSpawnActive() → connection_busy. The
    // candidate spawn inside the transaction passes (the manager sets
    // internalSpawn during spawnAndProbeCandidate); the OLD recovery
    // startLocal ran INSIDE the window with internalSpawn=false, so the real
    // gate rejected it → every production apply-now recovery threw
    // connection_busy and the managed dsh stayed down.
    let quarantineActive = false
    let managerRef: { internalSpawnActive(): boolean } | null = null
    const order: string[] = []
    let startCalls = 0
    let recoveryEntered!: () => void
    const recoveryStarted = new Promise<void>(resolve => { recoveryEntered = resolve })
    let releaseRecovery!: () => void
    const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve })
    const plane = fakePlane({
      stopLocal: async () => { order.push('stop'); plane._state.connectionState = 'stopped' },
      startLocal: async () => {
        if (quarantineActive && !(managerRef?.internalSpawnActive() ?? false)) {
          throw Object.assign(new Error('dsh runtime activation in progress'), { code: 'connection_busy' })
        }
        order.push('start')
        plane._state.connectionState = 'ready'
        startCalls += 1
        if (startCalls === 2) {
          recoveryEntered()
          await recoveryGate
        }
      },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async () => {
        order.push('probe:override')
        return probeResultsFor(stateDir).map(name => ({ name, ok: true }))
      },
      onActivationQuarantineChange: (active) => {
        order.push(`quarantine:${active ? 'on' : 'off'}`)
        quarantineActive = active
      },
    })
    managerRef = manager
    const accepted = await manager.applyNow()
    assert.equal(accepted.accepted, true)
    await recoveryStarted
    const recovering = await manager.status()
    assert.equal(recovering.phase, 'applying',
      'the status remains applying after quarantine closes until the recovery/outcome tail settles')
    assert.equal(recovering.connectionState, 'ready',
      'a transient ready candidate cannot make the 202 poll report premature completion')
    releaseRecovery()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.ok(order.indexOf('quarantine:off') < order.lastIndexOf('start'),
      'the recovery startLocal runs only after the activation window closes (quarantine:off)')
    assert.deepEqual(order, ['quarantine:on', 'stop', 'start', 'probe:override', 'quarantine:off', 'start'],
      'the candidate spawns inside the window (internal spawn), the verdict-winner resume after it closes')
    const status = await manager.status()
    assert.equal(status.phase, 'idle')
    assert.equal(status.connectionState, 'ready')
    assert.equal(status.activeVersion, '1.0.0')
    assert.equal(status.operationError, null, 'a clean apply-now must not project the canStartLocal refusal')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('applyNow recovery startLocal runs OUTSIDE the activation window (gate-aware plane): snapshot-failure path (P0 regression)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-gate-snapfail-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    // The snapshot seam throws (regular file where the snapshots dir must
    // live) → snapshot-failed → NO candidate spawn happens, so the ONLY
    // startLocal is the recovery one — the gate-aware plane pins that it runs
    // after quarantine:off (the old implementation ran it inside the window,
    // where the real canStartLocal gate throws connection_busy).
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true })
    writeFileSync(join(stateDir, 'dsh-runtime', 'snapshots'), 'not a directory', { mode: 0o600 })
    let quarantineActive = false
    let managerRef: { internalSpawnActive(): boolean } | null = null
    const order: string[] = []
    const plane = fakePlane({
      stopLocal: async () => { order.push('stop'); plane._state.connectionState = 'stopped' },
      startLocal: async () => {
        if (quarantineActive && !(managerRef?.internalSpawnActive() ?? false)) {
          throw Object.assign(new Error('dsh runtime activation in progress'), { code: 'connection_busy' })
        }
        order.push('start')
        plane._state.connectionState = 'ready'
      },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      onActivationQuarantineChange: (active) => {
        order.push(`quarantine:${active ? 'on' : 'off'}`)
        quarantineActive = active
      },
    })
    managerRef = manager
    const accepted = await manager.applyNow()
    assert.equal(accepted.accepted, true)
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.deepEqual(order, ['quarantine:on', 'stop', 'quarantine:off', 'start'],
      'the snapshot fails without spawning; the untouched source resumes only after the window closes')
    const status = await manager.status()
    assert.equal(status.phase, 'snapshot-failed', 'the terminal snapshot-failed phase is projected')
    assert.equal(status.connectionState, 'ready', 'the gate must not reject the recovery: it runs after quarantine:off')
    assert.equal(typeof status.operationError, 'string', 'F3: the snapshot failure projects operationError')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now preflight fails closed on a corrupt activation journal — 409 runtime_busy, no 202, no stop (P2-1)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-corrupt-journal-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    // target === current + corrupt journal: the OLD preflight fell through the
    // no-op check (corrupt is neither missing nor valid-intent) to a 202 →
    // stopLocal → runStartupPhase answers journal-corrupt → the healthy
    // managed dsh was left down with no recovery route armed.
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: false, lastOutcome: 'applied',
    })
    writeFileSync(join(stateDir, 'dsh-runtime', 'activation-journal.json'), '{broken-json', { mode: 0o600 })
    const stops: string[] = []
    const plane = fakePlane({ stopLocal: async () => { stops.push('stop') } })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 409)
    assert.equal((response.json as { code: string }).code, 'runtime_busy')
    assert.equal((response.json as { error: string }).error,
      'runtime activation journal is corrupt; apply-now refused (recovery required)')
    assert.equal(manager.applyNowInFlight(), false, 'a corrupt-journal refusal arms nothing')
    assert.deepEqual(stops, [], 'the healthy managed dsh is never stopped')
    await assert.rejects(manager.applyNow(), (error: unknown) =>
      (error as { code?: string }).code === 'runtime_busy', 'the direct manager call refuses identically')
    assert.deepEqual(stops, [], 'the direct call refuses before any stop')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now preflight rejects an applied-monitoring no-op — 409 noop_target, nothing armed (P2-2)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-applied-noop-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: false, lastOutcome: 'applied',
    })
    // Every successful apply-now/startup leaves the applied-monitoring
    // journal. With no nextIntent, pending stays null and chosen == active —
    // the OLD no-op gate (missing/intent only) let this through to a pointless
    // stop → snapshot → spawn → probe cycle on the ALREADY-ACTIVE version.
    const monitoring: ActivationJournal = {
      schemaVersion: 1,
      phase: 'applied-monitoring',
      targetVersion: '1.0.0',
      targetIsBuiltin: false,
      manualRollback: false,
      intentKind: 'version-switch',
      sourceVersion: TEST_BUILTIN_VERSION,
      sourceIsBuiltin: true,
      sourceWasKnownGood: true,
      knownGoodVersion: '1.0.0',
      preSwapSnapshotName: `${TEST_BUILTIN_VERSION}-123`,
      manualDataSnapshotName: null,
      preRollbackStashName: null,
      rollbackTarget: null,
      nextIntent: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    writeActivationJournal(stateDir, monitoring)
    const stops: string[] = []
    const plane = fakePlane({ stopLocal: async () => { stops.push('stop') } })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 409)
    assert.equal((response.json as { code: string }).code, 'noop_target')
    assert.equal((response.json as { error: string }).error,
      'dsh v1.0.0 is already the active runtime; apply-now has nothing to do')
    assert.equal(manager.applyNowInFlight(), false, 'a no-op rejection arms nothing')
    assert.deepEqual(stops, [], 'no stop/start cycle on the already-active version')
    assert.equal(readOverride(stateDir)?.pending, null, 'no pending switch is armed')
    assert.equal(readActivationJournalState(stateDir).kind, 'valid', 'the monitoring journal is left untouched')
    await assert.rejects(manager.applyNow(), (error: unknown) =>
      (error as { code?: string }).code === 'noop_target', 'the direct manager call refuses identically')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now preflight refuses synchronously while a startup recovery block is in memory — direct manager parity (P2-1)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-recovery-gate-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    // The snapshot seam throws → startupTransaction leaves the in-memory
    // startupBlockReason = 'snapshot-failed' (phase snapshot-failed). The route
    // already refuses apply-now here; the DIRECT manager call must refuse
    // identically (contract parity) instead of arming a 202 that stops the
    // healthy dsh a second time.
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true })
    writeFileSync(join(stateDir, 'dsh-runtime', 'snapshots'), 'not a directory', { mode: 0o600 })
    const stops: string[] = []
    const plane = fakePlane({ stopLocal: async () => { stops.push('stop') } })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    const blocked = await manager.startupTransaction()
    assert.equal(blocked.blockedReason, 'snapshot-failed')
    assert.equal((await manager.status()).phase, 'snapshot-failed')
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 409)
    assert.equal((response.json as { code: string }).code, 'runtime_recovery_required')
    await assert.rejects(manager.applyNow(), (error: unknown) =>
      (error as { code?: string }).code === 'runtime_recovery_required', 'the direct manager call refuses identically')
    assert.equal(manager.applyNowInFlight(), false)
    assert.deepEqual(stops, [], 'no stop is ever issued for a blocked runtime')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now preflight refuses synchronously when the managed dsh never reached ready — direct manager parity (P2-1)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-notready-gate-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    const stops: string[] = []
    // Default fake plane connectionState is 'stopped' — the managed dsh never
    // reached ready, so apply-now cannot switch it in-session (route mirror).
    const plane = fakePlane({ stopLocal: async () => { stops.push('stop') } })
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 409)
    assert.equal((response.json as { code: string }).code, 'runtime_busy')
    assert.match((response.json as { error: string }).error, /managed dsh is not running \(stopped\)/)
    await assert.rejects(manager.applyNow(), (error: unknown) =>
      (error as { code?: string }).code === 'runtime_busy', 'the direct manager call refuses identically')
    assert.equal(manager.applyNowInFlight(), false)
    assert.deepEqual(stops, [], 'no stop is issued for a dsh that is already down')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('applyNow rolled-back runs the rolled-back version and projects operationError (F3)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-rollback-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    // The active v1 source must be known-good (applied + resolvedVersion ===
    // pointer) so the automatic rollback targets v1 instead of falling to the
    // builtin anchor (activation-gate rollbackTarget, §3.4).
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '1.0.0',
      pending: '2.0.0', swapAttempted: false, selectedOnly: false, lastOutcome: 'applied',
    })
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"preserved"}')
    const probed: string[] = []
    const plane = fakePlane({
      stopLocal: async () => {},
      startLocal: async () => {},
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      waitBeforeRetry: async () => {},
      probeCandidate: async ({ version }) => {
        probed.push(version)
        return probeResultsFor(stateDir).map(name => ({ name, ok: version === '1.0.0', ...(version === '1.0.0' ? {} : { error: 'candidate rejected' }) }))
      },
    })
    const accepted = await manager.applyNow()
    assert.equal(accepted.accepted, true)
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.deepEqual(probed, ['2.0.0', '2.0.0', '1.0.0'],
      'failed candidate is observed twice, then the rollback target is probed')
    const status = await manager.status()
    assert.equal(status.activeVersion, '1.0.0', 'the rolled-back version is the running version')
    assert.equal(status.phase, 'idle')
    assert.equal(typeof status.operationError, 'string', 'F3: a rolled-back apply-now projects operationError')
    assert.equal(readCurrentPointer(stateDir), '1.0.0')
    assert.equal(readOverride(stateDir)?.lastOutcome, 'rolled-back')
    assert.equal(readOverride(stateDir)?.pending, null, 'a rolled-back transaction clears the pending switch')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"preserved"}', 'data is restored from the pre-swap snapshot')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('env override is a healthy startup bypass after the activation probe gate (A-U2 parity)', async () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-env-pending-'))
  const errors: string[] = []
  try {
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: { log() {}, warn() {}, error(message) { errors.push(String(message)) } },
      // Desktop parity: env boot only opens after the activation probe set
      // passes against the env runtime. Tests inject the closed probe set
      // (the same seam managed-tree activations use).
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    writeOverride(stateDir, { shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0', pending: '1.0.0', swapAttempted: false })
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

test('env override probe failure keeps the managed dsh stopped with an honest blocked verdict (A-U2 parity)', async () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-env-probe-fail-'))
  const errors: string[] = []
  try {
    const stopped: string[] = []
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane({
        stopLocal: async () => { stopped.push('stopLocal') },
      }),
      logger: { log() {}, warn() {}, error(message) { errors.push(String(message)) } },
      // One probe fails: the env runtime answered the plane health check but
      // lacks a required feature — desktop would refuse to open the gate too.
      probeCandidate: async () => probeResultsFor(stateDir).map((name, index) => ({ name, ok: index !== 0 })),
    })
    const startup = await manager.startupTransaction()
    assert.equal(startup.blockedReason, 'env-probe-failed')
    assert.ok(stopped.includes('stopLocal'), 'the probe-left env process is stopped before exposure')
    const status = await manager.status()
    assert.equal(status.phase, 'idle')
    assert.equal(status.startupBlockedReason, 'env-probe-failed')
    assert.equal(status.source, 'env')
    assert.equal(status.operationError?.includes('env runtime activation probes failed'), true)
    assert.ok(errors.length >= 1 && errors[0].includes('env-override runtime activation probes failed'), 'probe failure is logged loudly')
    await manager.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restore-builtin refuses without an override and route-gates FATAL blocks (A-U4 desktop parity)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restore-no-override-'))
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  try {
    delete process.env.DSH_GATEWAY_DSH_PATH
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    // No override → the builtin anchor is already authoritative: refusing
    // avoids a pointless stop → snapshot → probe cycle (desktop only offers
    // reset-builtin when hasOverride).
    await assert.rejects(manager.restoreBuiltin(), { code: 'runtime_no_override' })
    // The route answers the same refusal as a 409 (not a 500).
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const refused = await runRoute(routes, 'POST', '/chamber/runtime/restore-builtin', '{}')
    assert.equal(refused.status, 409)
    assert.equal((refused.json as { code: string }).code, 'runtime_no_override')
    // With a real override the escape stays open when no block is armed…
    writeOverride(stateDir, { shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0', pending: null, swapAttempted: false })
    // …but a BOOTED FATAL metadata block route-gates it to its own recovery
    // surface instead of running a blind reset against corrupt authority.
    // Fixture (review fix): corrupt the journal FIRST, then run a real
    // startup transaction so the manager arms its in-memory FATAL block —
    // the route gate reads status().startupBlockedReason, which is that
    // memory verdict, not a disk re-read.
    writeFileSync(join(stateDir, 'dsh-runtime', 'activation-journal.json'), '{corrupt', { mode: 0o600 })
    assert.deepEqual(await manager.startupTransaction(), { blockedReason: 'journal-corrupt' })
    const fatal = await runRoute(routes, 'POST', '/chamber/runtime/restore-builtin', '{}')
    assert.equal(fatal.status, 409)
    assert.equal((fatal.json as { code: string }).code, 'runtime_recovery_required')
    assert.match((fatal.json as { error: string }).error, /journal-corrupt/)
    // The matching recovery surface (recover-metadata) stays open for the
    // same blocked state.
    const status = await manager.status()
    assert.equal(status.startupBlockedReason, 'journal-corrupt')
    assert.equal(status.phase, 'idle', 'FATAL projects idle (never pending) so the recovery surface stays reachable')
    assert.equal(status.canRecoverMetadata, true, 'recover-metadata is advertised for the FATAL block')
    await manager.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restore-builtin durable guards: interrupted apply / restore marker / corrupt metadata refuse before any stop or intent (2026 audit R2)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restore-guards-'))
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  const stops: string[] = []
  try {
    delete process.env.DSH_GATEWAY_DSH_PATH
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true })
    const makeManager = () => createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane({ stopLocal: async () => { stops.push('stopLocal') } }),
      logger: silentLogger,
    })

    // (a) Durable interrupted-apply marker (swap-attempted) without any boot:
    //     an armed reset would be re-blocked by the shared core after
    //     stopping the dsh — the guard refuses BEFORE any stop or intent.
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: true,
    })
    const swapManager = makeManager()
    await assert.rejects(swapManager.restoreBuiltin(), {
      code: 'runtime_recovery_required',
      message: /swap-attempted/,
    })
    assert.deepEqual(stops, [], 'a refused reset never stops the managed dsh')
    assert.equal(readOverride(stateDir)?.swapAttempted, true, 'the durable marker is untouched by a refused reset')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'a refused reset writes no intent journal')
    // Route-level parity on the real manager: the recovery gate refuses too.
    const routes = createRuntimeRoutes(() => swapManager, silentLogger)
    const routeRestore = await runRoute(routes, 'POST', '/chamber/runtime/restore-builtin', '{}')
    assert.equal(routeRestore.status, 409)
    assert.equal((routeRestore.json as { code: string }).code, 'runtime_recovery_required')
    await swapManager.dispose()
    stops.length = 0
    rmSync(join(stateDir, 'dsh-runtime', 'override.json'), { force: true })

    // (b) Durable interrupted data restore (restore marker presence is
    //     authoritative, corrupt or not — desktop only offers retry-restore).
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: false,
    })
    writeFileSync(join(stateDir, 'dsh-runtime', 'restore-in-progress'), '{broken', { mode: 0o600 })
    const markerManager = makeManager()
    await assert.rejects(markerManager.restoreBuiltin(), {
      code: 'runtime_recovery_required',
      message: /restore-half/,
    })
    assert.ok(existsSync(join(stateDir, 'dsh-runtime', 'restore-in-progress')), 'a refused reset leaves the restore marker intact')
    assert.deepEqual(stops, [], 'no stop before the marker refusal either')
    await markerManager.dispose()
    stops.length = 0
    rmSync(join(stateDir, 'dsh-runtime', 'restore-in-progress'), { force: true })

    // (c) FATAL corrupt journal without a boot verdict: same refusal class.
    writeFileSync(join(stateDir, 'dsh-runtime', 'activation-journal.json'), '{corrupt', { mode: 0o600 })
    const corruptManager = makeManager()
    await assert.rejects(corruptManager.restoreBuiltin(), {
      code: 'runtime_recovery_required',
      message: /journal-corrupt/,
    })
    assert.deepEqual(stops, [], 'a refused reset never stops the managed dsh (FATAL case)')
    await corruptManager.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restore-pre-rollback complete keeps an env-probe-failed resume verdict (MAJOR-1 regression)', async () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restore-resume-env-'))
  const home = join(stateDir, 'dsh-home')
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"v1"}')
    const stashPath = await stashPreRollback(stateDir, home)
    assert.ok(stashPath.startsWith(join(stateDir, 'dsh-runtime', 'pre-rollback')), 'the stash lives under the pre-rollback dir')
    writeFileSync(join(home, 'settings.json'), '{"source":"v2"}')

    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      // The env probe in the RESUME transaction fails: the runtime answers
      // the plane health check but lacks a required feature (A-U2).
      probeCandidate: async () => probeResultsFor(stateDir).map((name, index) => ({ name, ok: index !== 0 })),
    })
    const res = await manager.restorePreRollback(basename(stashPath))
    assert.deepEqual(res, { accepted: true })
    const s = await manager.status()
    assert.equal(s.startupBlockedReason, 'env-probe-failed', 'the resume verdict must survive the complete branch (the old code cleared it, leaving stopped + clean)')
    assert.match(s.operationError ?? '', /env runtime activation probes failed/)
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"v1"}', 'DSH_HOME was restored from the stash')
    await manager.dispose()

    // Re-probe on the next startup transaction (fix the target → restart the
    // gateway semantics): an all-ok probe manager on the same state clears it.
    const recovered = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    assert.deepEqual(await recovered.startupTransaction(), { blockedReason: null })
    assert.equal((await recovered.status()).startupBlockedReason, null)
    await recovered.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('env-probe-failed closes every mutation route with an explicit no-recovery-route refusal (A-U2 gate coverage)', async () => {
  const manager = {
    status: () => ({ phase: 'idle', pending: null, startupBlockedReason: 'env-probe-failed' }),
    mutationInProgress: () => false,
    restartInFlight: () => false,
    startInFlight: () => false,
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  for (const [suffix, method, payload] of [
    ['select', 'POST', JSON.stringify({ version: '1.0.0' })],
    ['apply', 'POST', undefined],
    ['apply-now', 'POST', undefined],
    ['rollback', 'POST', JSON.stringify({ version: '1.0.0' })],
    ['cleanup-version', 'POST', JSON.stringify({ version: '1.0.0' })],
    ['restore-pre-rollback', 'POST', JSON.stringify({ stashName: '1700000000000-deadbeef' })],
    ['retry-apply', 'POST', undefined],
    ['retry-restore', 'POST', undefined],
    ['restore-builtin', 'POST', undefined],
    ['recover-metadata', 'POST', undefined],
    ['restart', 'POST', undefined],
    ['start', 'POST', undefined],
    ['registry', 'PUT', JSON.stringify({ origin: 'https://registry.npmmirror.com' })],
  ] as const) {
    const response = await runRoute(routes, method, `/chamber/runtime/${suffix}`, payload)
    assert.equal(response.status, 409, `${suffix} must refuse under env-probe-failed`)
    assert.equal((response.json as { code: string }).code, 'runtime_recovery_required', suffix)
    assert.match((response.json as { error: string }).error, /no recovery route applies/, suffix)
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
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
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

test('gateway host state edges maintain and promote the full 24h + one-boot known-good window', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-known-good-host-'))
  try {
    let nowMs = 10_000
    let promotionTick!: () => void
    let schedulerCancelled = 0
    makeValidTree(stateDir, '1.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: null, swapAttempted: false, selectedOnly: false, lastOutcome: 'applied',
    })
    recordProbePass(stateDir, '1.0.0', nowMs)
    const candidatesPath = join(stateDir, 'dsh-runtime', 'known-good-candidates.json')
    const readCandidate = () => (JSON.parse(readFileSync(candidatesPath, 'utf8')) as {
      versions: Record<string, { bootCount: number; healthWindowStartedAt: number | null }>
    }).versions['1.0.0']
    const plane = fakePlane({ localProcessAlive: true })
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      nowMs: () => nowMs,
      scheduleKnownGoodPromotion: callback => {
        promotionTick = callback
        return () => { schedulerCancelled += 1 }
      },
    })

    manager.observeLocalState('ready')
    assert.equal(readCandidate().bootCount, 1, 'the first authoritative ready edge qualifies one boot')
    assert.equal(typeof readCandidate().healthWindowStartedAt, 'number')
    manager.observeLocalState('ready')
    assert.equal(readCandidate().bootCount, 1, 'duplicate ready notifications do not inflate bootCount')

    for (const unhealthy of ['degraded', 'restarting', 'error', 'stopped']) {
      manager.observeLocalState(unhealthy)
      assert.equal(readCandidate().bootCount, 0, `${unhealthy} invalidates the earlier boot qualification`)
      assert.equal(readCandidate().healthWindowStartedAt, null, `${unhealthy} wall time cannot count as healthy uptime`)
      nowMs += 1
      manager.observeLocalState('ready')
      assert.equal(readCandidate().bootCount, 1, `ready after ${unhealthy} opens one fresh qualified window`)
    }

    nowMs += 24 * 60 * 60 * 1_000
    promotionTick()
    assert.deepEqual(listKnownGoodVersions(stateDir), ['1.0.0'], 'the live hourly tick promotes at the exact 24h boundary')
    assert.equal(readCandidate(), undefined, 'promotion consumes the candidate ledger entry')
    await manager.dispose()
    assert.equal(schedulerCancelled, 1, 'dispose cancels the sustained-health timer exactly once')

    recordProbePass(stateDir, '1.0.0', nowMs)
    const afterDisposeCandidate = readFileSync(candidatesPath, 'utf8')
    promotionTick()
    assert.equal(readFileSync(candidatesPath, 'utf8'), afterDisposeCandidate,
      'even a stale queued callback cannot write after runtime ownership is released')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('activation-quarantine ready edges do not count a candidate boot', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-known-good-quarantine-'))
  try {
    const nowMs = 20_000
    makeValidTree(stateDir, '1.0.0')
    recordProbePass(stateDir, '1.0.0', nowMs)
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })
    const candidatesPath = join(stateDir, 'dsh-runtime', 'known-good-candidates.json')
    const bootCount = () => (JSON.parse(readFileSync(candidatesPath, 'utf8')) as {
      versions: Record<string, { bootCount: number }>
    }).versions['1.0.0'].bootCount
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    plane.stopLocal = async () => { plane._state.connectionState = 'stopped' }
    plane.startLocal = async () => { plane._state.connectionState = 'ready' }
    let manager!: ReturnType<typeof createGatewayRuntimeManager>
    manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      nowMs: () => nowMs,
      scheduleKnownGoodPromotion: () => () => {},
      probeCandidate: async () => {
        manager.observeLocalState('ready')
        assert.equal(bootCount(), 0, 'candidate readiness inside quarantine is not an authoritative boot')
        return probeResultsFor(stateDir).map(name => ({ name, ok: true }))
      },
    })

    await manager.applyNow()
    await waitForSettle(manager)
    assert.equal(bootCount(), 0, 'closing quarantine alone does not synthesize a ready edge')
    manager.observeLocalState('ready')
    assert.equal(bootCount(), 1, 'the first post-verdict authoritative ready edge counts exactly once')
    manager.observeLocalState('ready')
    assert.equal(bootCount(), 1)
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('authoritative restart-exhausted rolls an active override back exactly once with a durable pre-effect latch (F7)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-f7-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    writeActivationIntent(stateDir, {
      targetVersion: '2.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '1.0.0',
      pending: '2.0.0', swapAttempted: false, selectedOnly: false, lastOutcome: 'applied',
    })
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"v1"}')

    let phase: 'initial-apply' | 'f7' | 'cleanup' = 'initial-apply'
    let f7Stops = 0
    let durableBeforeFirstEffect = false
    let candidateRemovedBeforeFirstEffect = false
    const candidatesPath = join(stateDir, 'dsh-runtime', 'known-good-candidates.json')
    const candidateExists = (version: string): boolean => {
      if (!existsSync(candidatesPath)) return false
      const parsed = JSON.parse(readFileSync(candidatesPath, 'utf8')) as { versions?: Record<string, unknown> }
      return parsed.versions?.[version] !== undefined
    }
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    plane.stopLocal = async () => {
      if (phase === 'f7') {
        f7Stops += 1
        if (f7Stops === 1) {
          const journal = readActivationJournalState(stateDir)
          durableBeforeFirstEffect = journal.kind === 'valid' && journal.journal.phase === 'rollback-needed'
          candidateRemovedBeforeFirstEffect = !candidateExists('2.0.0')
        }
      }
      plane._state.connectionState = 'stopped'
    }
    plane.startLocal = async () => { plane._state.connectionState = 'ready' }
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      waitBeforeRetry: async () => {},
      scheduleKnownGoodPromotion: () => () => {},
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })

    await manager.applyNow()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    const monitoring = readActivationJournalState(stateDir)
    assert.equal(monitoring.kind, 'valid')
    if (monitoring.kind === 'valid') assert.equal(monitoring.journal.phase, 'applied-monitoring')
    assert.equal(readCurrentPointer(stateDir), '2.0.0')
    assert.equal(candidateExists('2.0.0'), true, 'the validated candidate starts in its monitoring window')

    manager.observeLocalState('restart-exhausted')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(manager.mutationInProgress(), false,
      'a stale callback argument cannot trigger F7 while the authoritative plane state is ready')
    assert.equal(readCurrentPointer(stateDir), '2.0.0')

    // Model data migrated by v2. F7 must restore the pre-v2 snapshot before
    // exposing the old v1 runtime again.
    writeFileSync(join(home, 'settings.json'), '{"source":"v2-migrated"}')
    phase = 'f7'
    plane.restartLocal = async () => {
      plane._state.connectionState = 'restart-exhausted'
      // Model the real control-plane callback synchronously, before the outer
      // manager.restart() promise has reached its trackOperation() wrapper.
      manager.observeLocalState('restart-exhausted')
      manager.observeLocalState('restart-exhausted')
    }
    const failedRestart = manager.restart()
    assert.equal(manager.mutationInProgress(), true, 'the repeated synchronous edge is covered by one armed writer latch')
    await assert.rejects(failedRestart, /did not reach ready \(restart-exhausted\)/)
    await waitForMutationSettle(manager)

    assert.equal(f7Stops, 1, 'duplicate restart-exhausted edges execute one rollback transaction')
    assert.equal(durableBeforeFirstEffect, true, 'rollback-needed is durable before the first host stop')
    assert.equal(candidateRemovedBeforeFirstEffect, true, 'the failed candidate is removed before the first host stop')
    assert.equal(readCurrentPointer(stateDir), '1.0.0')
    assert.equal(readOverride(stateDir)?.resolvedVersion, '1.0.0')
    assert.equal(readOverride(stateDir)?.lastOutcome, 'rolled-back')
    assert.equal(candidateExists('2.0.0'), false)
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"v1"}')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'safe terminal rollback consumes the F7 journal')
    assert.match((await manager.status()).operationError ?? '', /automatically rolled back/)

    // A later duplicate terminal notification cannot replay the transaction:
    // the active version and durable monitoring journal no longer match v2.
    plane._state.connectionState = 'restart-exhausted'
    manager.observeLocalState('restart-exhausted')
    await waitForMutationSettle(manager)
    assert.equal(f7Stops, 1)

    phase = 'cleanup'
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('gateway F7 keeps a failed fallback probe stopped behind a sticky exposure quarantine', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-f7-probe-fail-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    writeActivationIntent(stateDir, {
      targetVersion: '2.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '1.0.0',
      pending: '2.0.0', swapAttempted: false, selectedOnly: false, lastOutcome: 'applied',
    })
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"v1"}')

    let phase: 'initial-apply' | 'f7' = 'initial-apply'
    let starts = 0
    let stops = 0
    const releasedStates: string[] = []
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    plane.startLocal = async () => { starts += 1; plane._state.connectionState = 'ready' }
    plane.stopLocal = async () => { stops += 1; plane._state.connectionState = 'stopped' }
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      waitBeforeRetry: async () => {},
      scheduleKnownGoodPromotion: () => () => {},
      onActivationQuarantineChange: active => {
        if (!active) releasedStates.push(plane.connectionState)
      },
      probeCandidate: async () => probeResultsFor(stateDir).map(name => (
        phase === 'initial-apply'
          ? { name, ok: true }
          : { name, ok: false, error: 'injected fallback probe failure' }
      )),
    })

    await manager.applyNow()
    await waitForSettle(manager)
    assert.equal(readCurrentPointer(stateDir), '2.0.0')
    assert.equal(manager.exposureQuarantined(), false)
    releasedStates.length = 0

    phase = 'f7'
    plane._state.connectionState = 'restart-exhausted'
    manager.observeLocalState('restart-exhausted')
    await waitForMutationSettle(manager)

    const status = await manager.status()
    assert.equal(status.startupBlockedReason, 'swap-attempted')
    assert.equal(plane.connectionState, 'stopped', 'probe-failed fallback is stopped before quarantine release')
    assert.equal(manager.exposureQuarantined(), true, 'unsafe blocked verdict remains quarantined until recovery')
    assert.deepEqual(releasedStates, ['stopped'], 'the open-edge callback never observes the failed probe as ready')
    assert.ok(starts >= 3, 'candidate apply plus the failed known-good and builtin fallback probes ran')
    assert.ok(stops >= 3, 'rollback stops and the final blocked-verdict stop all ran')

    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('F7 journal persistence failure is fail-closed before candidate or host effects', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-f7-journal-fail-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '2.0.0')
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '2.0.0',
      pending: null, swapAttempted: false, selectedOnly: false, lastOutcome: 'applied',
    })
    const monitoring: ActivationJournal = {
      schemaVersion: 1,
      phase: 'applied-monitoring',
      targetVersion: '2.0.0',
      targetIsBuiltin: false,
      manualRollback: false,
      intentKind: 'version-switch',
      sourceVersion: '1.0.0',
      sourceIsBuiltin: false,
      sourceWasKnownGood: true,
      knownGoodVersion: '1.0.0',
      preSwapSnapshotName: '1.0.0-123',
      manualDataSnapshotName: null,
      preRollbackStashName: null,
      rollbackTarget: null,
      nextIntent: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    writeActivationJournal(stateDir, monitoring)
    recordProbePass(stateDir, '2.0.0')

    const journalPath = join(stateDir, 'dsh-runtime', 'activation-journal.json')
    const candidatesPath = join(stateDir, 'dsh-runtime', 'known-good-candidates.json')
    const candidatesBefore = readFileSync(candidatesPath, 'utf8')
    let sabotageNextClockRead = true
    let countStops = true
    let stops = 0
    const plane = fakePlane({
      stopLocal: async () => { if (countStops) stops += 1 },
    })
    plane._state.connectionState = 'restart-exhausted'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      scheduleKnownGoodPromotion: () => () => {},
      nowMs: () => {
        // planRestartExhaustedRollback reads/validates the journal before its
        // clock callback. Replace the authority only at that exact seam so
        // the subsequent rollback-needed atomic write fails deterministically.
        if (sabotageNextClockRead) {
          sabotageNextClockRead = false
          rmSync(journalPath)
          mkdirSync(journalPath)
        }
        return Date.now()
      },
    })

    manager.observeLocalState('restart-exhausted')
    await waitForMutationSettle(manager)
    assert.equal(stops, 0, 'a failed durable latch must not stop the host')
    assert.equal(readCurrentPointer(stateDir), '2.0.0')
    assert.equal(readFileSync(candidatesPath, 'utf8'), candidatesBefore,
      'the failed candidate remains untouched when rollback-needed could not be persisted')
    assert.equal(readActivationJournalState(stateDir).kind, 'corrupt')

    countStops = false
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restart-exhausted on builtin or env runtime never arms F7 or writes runtime selection state', async () => {
  const builtinDir = mkdtempSync(join(tmpdir(), 'gw-rt-f7-builtin-'))
  try {
    let builtinStops = 0
    const builtinPlane = fakePlane({ stopLocal: async () => { builtinStops += 1 } })
    builtinPlane._state.connectionState = 'restart-exhausted'
    const builtin = createGatewayRuntimeManager({
      config: config(builtinDir), plane: builtinPlane, logger: silentLogger,
      scheduleKnownGoodPromotion: () => () => {},
    })
    builtin.observeLocalState('restart-exhausted')
    assert.equal(builtin.mutationInProgress(), false)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(readActivationJournalState(builtinDir).kind, 'missing')
    assert.equal(builtinStops, 0)
    await builtin.dispose()
  } finally {
    rmSync(builtinDir, { recursive: true, force: true })
  }

  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = '/tmp/gateway-f7-env-runtime'
  const envDir = mkdtempSync(join(tmpdir(), 'gw-rt-f7-env-'))
  try {
    let envStops = 0
    const envPlane = fakePlane({ stopLocal: async () => { envStops += 1 } })
    envPlane._state.connectionState = 'restart-exhausted'
    const env = createGatewayRuntimeManager({
      config: config(envDir), plane: envPlane, logger: silentLogger,
      scheduleKnownGoodPromotion: () => () => {},
    })
    env.observeLocalState('restart-exhausted')
    assert.equal(env.mutationInProgress(), false)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(readActivationJournalState(envDir).kind, 'missing')
    assert.equal(envStops, 0)
    await env.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(envDir, { recursive: true, force: true })
  }
})

test('dispose drains a persisted F7 rollback and final-stop fences its fallback probe before owner release', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-f7-dispose-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    writeActivationIntent(stateDir, {
      targetVersion: '2.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '1.0.0',
      pending: '2.0.0', swapAttempted: false, selectedOnly: false, lastOutcome: 'applied',
    })
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"v1"}')

    let phase: 'initial-apply' | 'f7' = 'initial-apply'
    let f7StopEntered!: () => void
    const stopEntered = new Promise<void>(resolve => { f7StopEntered = resolve })
    let releaseF7Stop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseF7Stop = resolve })
    let firstF7Stop = true
    let starts = 0
    let stops = 0
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    plane.startLocal = async () => { starts += 1; plane._state.connectionState = 'ready' }
    plane.stopLocal = async () => {
      stops += 1
      plane._state.connectionState = 'stopped'
      if (phase === 'f7' && firstF7Stop) {
        firstF7Stop = false
        f7StopEntered()
        await stopGate
      }
    }
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      waitBeforeRetry: async () => {},
      scheduleKnownGoodPromotion: () => () => {},
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    await manager.applyNow()
    await waitForSettle(manager)
    assert.equal(readCurrentPointer(stateDir), '2.0.0')
    writeFileSync(join(home, 'settings.json'), '{"source":"v2-migrated"}')

    const startsBeforeF7 = starts
    phase = 'f7'
    plane._state.connectionState = 'restart-exhausted'
    manager.observeLocalState('restart-exhausted')
    await stopEntered
    const latched = readActivationJournalState(stateDir)
    assert.equal(latched.kind, 'valid')
    if (latched.kind === 'valid') assert.equal(latched.journal.phase, 'rollback-needed')
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    assert.ok(existsSync(ownerPath))

    let disposeSettled = false
    const disposal = manager.dispose().then(() => { disposeSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposeSettled, false, 'dispose drains the tracked F7 writer instead of releasing ownership')
    assert.ok(existsSync(ownerPath), 'owner remains while rollback can still write pointer/data/journal state')

    releaseF7Stop()
    await disposal
    assert.equal(readCurrentPointer(stateDir), '1.0.0', 'the already-durable safety rollback is allowed to finish')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"v1"}')
    assert.equal(starts, startsBeforeF7 + 1, 'only the shared fallback probe may start after disposal; the recovery tail is suppressed')
    assert.equal(plane._state.connectionState, 'stopped', 'dispose final-stop fences the fallback probe before owner release')
    assert.ok(stops >= 3, 'initial stop, disposal stop, and final quiescence stop all ran')
    assert.ok(!existsSync(ownerPath))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restart-exhausted rollback holds every write while the profile-write lease is held and completes after release (F7 lease gate)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-f7-lease-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    writeActivationIntent(stateDir, {
      targetVersion: '2.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '1.0.0',
      pending: '2.0.0', swapAttempted: false, selectedOnly: false, lastOutcome: 'applied',
    })
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"v1"}')

    let phase: 'initial-apply' | 'f7' | 'cleanup' = 'initial-apply'
    let f7Stops = 0
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    plane.stopLocal = async () => {
      if (phase === 'f7') f7Stops += 1
      plane._state.connectionState = 'stopped'
    }
    plane.startLocal = async () => { plane._state.connectionState = 'ready' }
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      waitBeforeRetry: async () => {},
      scheduleKnownGoodPromotion: () => () => {},
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })

    await manager.applyNow()
    await waitForSettle(manager)
    assert.equal(readCurrentPointer(stateDir), '2.0.0')
    writeFileSync(join(home, 'settings.json'), '{"source":"v2-migrated"}')

    // A plugin mutation holds the profile-write lease exactly when the host
    // lands on restart-exhausted (the F7 auto-rollback races a pnpm child).
    const lease = manager.beginProfileWrite()
    assert.equal(lease.ok, true)
    if (!lease.ok) return
    phase = 'f7'
    plane._state.connectionState = 'restart-exhausted'
    manager.observeLocalState('restart-exhausted')

    // While the lease is held the armed rollback must not start ANY effect:
    // its restore step writes DSH_HOME before the only lease-aware point
    // (the spawn checkpoint), so it waits for the lease to drain instead.
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(manager.mutationInProgress(), true, 'the F7 writer latch is armed and waiting on the lease')
    assert.equal(f7Stops, 0, 'no host stop while the lease is held')
    const waiting = readActivationJournalState(stateDir)
    assert.equal(waiting.kind, 'valid')
    if (waiting.kind === 'valid') {
      assert.equal(waiting.journal.phase, 'applied-monitoring', 'no durable rollback-needed write while the lease is held')
    }
    assert.equal(readCurrentPointer(stateDir), '2.0.0', 'no pointer switch while the lease is held')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"v2-migrated"}',
      'no DSH_HOME restore while the lease is held')

    // The refusal matrix covers the rollback wait: no NEW lease can start
    // mid-rollback (only the already-held lease can drain).
    const refused = manager.beginProfileWrite()
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.equal(refused.code, 'runtime_busy')
      assert.match(refused.error, /rollback is in flight/)
    }

    // The plugin mutation completes: the wait resolves 'idle' and the
    // rollback transaction runs to its safe terminal state.
    lease.release()
    await waitForMutationSettle(manager)
    assert.equal(f7Stops, 1)
    assert.equal(readCurrentPointer(stateDir), '1.0.0')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"v1"}')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'safe terminal rollback consumes the F7 journal')
    assert.match((await manager.status()).operationError ?? '', /automatically rolled back/)

    phase = 'cleanup'
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restart-exhausted rollback defers with no writes when the lease outlives the wait bound; the next exhausted edge re-arms it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-f7-lease-timeout-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    writeActivationIntent(stateDir, {
      targetVersion: '2.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '2.0.0', resolvedVersion: '1.0.0',
      pending: '2.0.0', swapAttempted: false, selectedOnly: false, lastOutcome: 'applied',
    })
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"v1"}')

    let phase: 'initial-apply' | 'f7' | 'cleanup' = 'initial-apply'
    let f7Stops = 0
    const errors: string[] = []
    const captureLogger: Logger = { log() {}, warn() {}, error(message: string) { errors.push(message) } }
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    plane.stopLocal = async () => {
      if (phase === 'f7') f7Stops += 1
      plane._state.connectionState = 'stopped'
    }
    plane.startLocal = async () => { plane._state.connectionState = 'ready' }
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: captureLogger,
      waitBeforeRetry: async () => {},
      scheduleKnownGoodPromotion: () => () => {},
      // Test-injected bound: the plugin mutation below holds the lease far
      // longer than the rollback is willing to wait.
      rollbackLeaseWaitMs: 60,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })

    await manager.applyNow()
    await waitForSettle(manager)
    assert.equal(readCurrentPointer(stateDir), '2.0.0')
    writeFileSync(join(home, 'settings.json'), '{"source":"v2-migrated"}')

    const lease = manager.beginProfileWrite()
    assert.equal(lease.ok, true)
    if (!lease.ok) return
    phase = 'f7'
    plane._state.connectionState = 'restart-exhausted'
    manager.observeLocalState('restart-exhausted')

    // The lease never drains within the injected bound: the rollback DEFERS.
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.ok(errors.some(text => /plugin mutation lease held too long/.test(text)),
      `the deferral is logged loudly (${errors.join('; ')})`)
    assert.equal(manager.mutationInProgress(), false, 'the deferred rollback releases its writer latch')
    assert.equal(f7Stops, 0, 'no host effect on the deferred path')
    const deferred = readActivationJournalState(stateDir)
    assert.equal(deferred.kind, 'valid')
    if (deferred.kind === 'valid') {
      assert.equal(deferred.journal.phase, 'applied-monitoring', 'no durable write on the deferred path')
    }
    assert.equal(readCurrentPointer(stateDir), '2.0.0', 'no pointer switch on the deferred path')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"v2-migrated"}',
      'no DSH_HOME restore on the deferred path — the instance keeps its honest restart-exhausted projection')

    // The plugin mutation finishes; a later authoritative restart-exhausted
    // edge re-arms the rollback, which now completes normally.
    lease.release()
    plane._state.connectionState = 'restart-exhausted'
    manager.observeLocalState('restart-exhausted')
    await waitForMutationSettle(manager)
    assert.equal(f7Stops, 1, 'the re-armed rollback executes one transaction')
    assert.equal(readCurrentPointer(stateDir), '1.0.0')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"v1"}')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing')

    phase = 'cleanup'
    await manager.dispose()
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
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: unknown }
    assert.equal(typeof owner.token, 'string')
    assert.equal((owner.token as string).length, 48, 'owner release authority is a random exact token')
    await manager.dispose()
    assert.ok(!existsSync(join(stateDir, 'dsh-runtime', 'owner.json')), 'owner record dropped on dispose')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a disposed manager cannot read/quarantine authority owned by its replacement', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-disposed-reader-'))
  try {
    const oldManager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await oldManager.dispose()
    const replacement = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const registry = join(stateDir, 'dsh-runtime', 'registry.json')
    writeFileSync(registry, '{replacement-owned-broken-json', { mode: 0o644 })
    chmodSync(registry, 0o644)

    await assert.rejects(oldManager.status(), (error: unknown) => (
      (error as Error & { code?: string }).code === 'runtime_disposed'
    ))
    assert.throws(() => oldManager.getRegistry(), (error: unknown) => (
      (error as Error & { code?: string }).code === 'runtime_disposed'
    ))
    assert.throws(() => oldManager.resolveWorkspace(), (error: unknown) => (
      (error as Error & { code?: string }).code === 'runtime_disposed'
    ))
    assert.equal(readFileSync(registry, 'utf8'), '{replacement-owned-broken-json')
    assert.equal(statSync(registry).mode & 0o777, 0o644,
      'the old object cannot chmod a new owner\'s authority while pretending to read')
    assert.equal(readdirSync(join(stateDir, 'dsh-runtime')).some(name => name.startsWith('registry.json.corrupt-')), false,
      'the old object cannot quarantine the new owner\'s authority')
    await replacement.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() aborts and drains an apply-now probe before releasing runtime ownership', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-dispose-applynow-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeActivationIntent(stateDir, {
      targetVersion: '1.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
    })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.0.0', resolvedVersion: '1.0.0',
      pending: '1.0.0', swapAttempted: false, selectedOnly: false,
    })

    let probeEntered!: () => void
    const entered = new Promise<void>(resolve => { probeEntered = resolve })
    let releaseProbe!: () => void
    const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
    let probeSignal: AbortSignal | undefined
    let starts = 0
    const quarantineEdges: boolean[] = []
    const plane = fakePlane({
      startLocal: async () => { starts += 1 },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      onActivationQuarantineChange: active => { quarantineEdges.push(active) },
      probeCandidate: async ({ signal }) => {
        probeSignal = signal
        probeEntered()
        await probeGate
        return probeResultsFor(stateDir).map(name => ({ name, ok: true }))
      },
    })
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    await manager.applyNow()
    await entered

    let disposeSettled = false
    const disposal = manager.dispose().then(() => { disposeSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposeSettled, false, 'dispose waits for the complete detached activation job')
    assert.equal(manager.activationInProgress(), true, 'dispose immediately enters a sticky exposure quarantine')
    assert.equal(probeSignal?.aborted, true, 'the manager lifecycle abort reaches the live candidate probe')
    assert.ok(existsSync(ownerPath), 'owner.json remains while an activation writer can still settle')

    releaseProbe()
    await disposal
    assert.equal(manager.activationInProgress(), true, 'a disposed manager can never reopen exposure')
    assert.equal(quarantineEdges.includes(false), false,
      'the rollback activation tail cannot publish an open edge after disposal begins')
    assert.equal(starts, 1, 'dispose prevents the apply-now recovery tail from spawning after abort')
    assert.ok(!existsSync(ownerPath), 'ownership is released only after the activation job and final stop settle')
    const replacement = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await replacement.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() drains the full select promise and forwards abort to registry metadata fetch', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-dispose-select-'))
  try {
    let fetchEntered!: () => void
    const entered = new Promise<void>(resolve => { fetchEntered = resolve })
    let releaseFetch!: () => void
    const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve })
    let fetchSignal: AbortSignal | undefined
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      fetchMetadata: async (_name, options) => {
        fetchSignal = options?.signal
        fetchEntered()
        await fetchGate
        throw new Error('registry fetch released after disposal')
      },
    })
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    const selection = manager.select('2.0.0')
    await entered
    let disposeSettled = false
    const disposal = manager.dispose().then(() => { disposeSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposeSettled, false, 'the registry phase is part of the manager writer promise')
    assert.equal(fetchSignal?.aborted, true)
    assert.ok(existsSync(ownerPath))
    releaseFetch()
    await assert.rejects(selection, /released after disposal/)
    await disposal
    assert.ok(!existsSync(ownerPath))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() retains runtime ownership when final process quiescence cannot be proved', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-dispose-unsafe-'))
  try {
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane({ stopLocal: async () => { throw new Error('stop ownership unsafe') } }),
      logger: silentLogger,
    })
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    await assert.rejects(manager.dispose(), /writers could not be proven quiescent/)
    assert.ok(existsSync(ownerPath), 'failed writer proof retains owner.json')
    assert.throws(
      () => createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger }),
      /already owns/,
      'a replacement manager cannot enter after unsafe disposal',
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() releases only its exact owner token and inode', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-release-token-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    rmSync(ownerPath)
    const replacementPayload = `${JSON.stringify({
      pid: process.pid,
      startedAt: 'replacement',
      token: 'b'.repeat(48),
    })}\n`
    writeFileSync(ownerPath, replacementPayload, { mode: 0o600 })
    await assert.rejects(manager.dispose(), /owner token no longer matches/)
    assert.equal(readFileSync(ownerPath, 'utf8'), replacementPayload,
      'an old manager never unlinks a replacement lease')
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
  let phase = 'swap-attempted'
  const manager = {
    status: () => ({ phase, mutationsAllowed: true, source: 'builtin-anchor' }),
    retryApply: async () => { retryApplyCalls += 1; return { accepted: true, blockedReason: null } },
    retryRestore: async () => { retryRestoreCalls += 1; return { accepted: true, blockedReason: null } },
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const apply = await runRoute(routes, 'POST', '/chamber/runtime/retry-apply', '{}')
  assert.equal(apply.status, 200)
  assert.equal((apply.json as { blockedReason: unknown }).blockedReason, null)
  phase = 'restore-blocked'
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
    // v2 active, rollback to installed v1 = a real downgrade (the rollback
    // direction guard refuses calls without an active pointer).
    writeCurrentPointer(stateDir, '2.0.0')
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
      shellVersion: gatewayPackageVersion,
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
      shellVersion: gatewayPackageVersion,
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

test('rollback direction guard: only an installed version OLDER than the active runtime is accepted (fail-loud otherwise)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-rollback-direction-'))
  try {
    // The fixture anchor exposes builtin v0.9.0 (TEST_BUILTIN_VERSION), so the
    // EFFECTIVE active version is pointer ?? builtin — the same formula the
    // guard, apply() and applyNowPreflight() use (desktop activeVersion()
    // parity): a builtin-active downgrade to an installed tree is a real
    // manual rollback and stays accepted.
    makeValidTree(stateDir, '0.8.0')
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    makeValidTree(stateDir, '3.0.0')
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const directionRefusal = (error: unknown): boolean =>
      (error as { code?: string }).code === 'invalid_target'
      && /not older than the active runtime/.test((error as Error).message)

    // Builtin authority (no pointer, effective active v0.9.0): trees NEWER
    // than the builtin are refusals (select+apply is the switch path); an
    // installed tree OLDER than the builtin is a genuine downgrade and is
    // accepted with full manualRollback semantics.
    await assert.rejects(manager.rollback('1.0.0'), directionRefusal,
      'a target newer than the builtin-active runtime is not a rollback')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'a refused rollback writes no journal')
    assert.equal(readOverride(stateDir), null, 'a refused rollback arms no override')
    const builtinDowngrade = await manager.rollback('0.8.0')
    assert.equal(builtinDowngrade.accepted, true)
    let journal = readActivationJournalState(stateDir)
    assert.equal(journal.kind, 'valid')
    if (journal.kind === 'valid') {
      assert.equal(journal.journal.manualRollback, true,
        'a builtin-active downgrade keeps the data-restore semantics (effective-version formula)')
      assert.equal(journal.journal.targetVersion, '0.8.0')
    }
    assert.equal(readOverride(stateDir)?.pending, '0.8.0')
    // Reset the armed pending before the pointer cases below.
    clearActivationJournal(stateDir)
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion,
      chosenVersion: null,
      resolvedVersion: null,
      pending: null,
      swapAttempted: false,
    })

    // Active v2 (pointer): same-as-active and newer installed targets are
    // refusals; older targets (including older than the builtin) are accepted.
    writeCurrentPointer(stateDir, '2.0.0')
    await assert.rejects(manager.rollback('2.0.0'), directionRefusal, 'rollback to the active version is a no-op, not a rollback')
    await assert.rejects(manager.rollback('3.0.0'), directionRefusal,
      'an upgrade-direction rollback must be refused (select+apply is the upgrade path)')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'refused upgrades still write no journal')

    // Active v2, installed v1: a genuine downgrade is accepted and armed as a
    // manualRollback, exactly like apply()'s formula.
    const accepted = await manager.rollback('1.0.0')
    assert.equal(accepted.accepted, true)
    journal = readActivationJournalState(stateDir)
    assert.equal(journal.kind, 'valid')
    if (journal.kind === 'valid') {
      assert.equal(journal.journal.manualRollback, true)
      assert.equal(journal.journal.targetVersion, '1.0.0')
      assert.equal(journal.journal.intentKind, 'version-switch')
    }
    assert.equal(readOverride(stateDir)?.pending, '1.0.0')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply() journals manualRollback for staged downgrades (pointer and builtin-active cases)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-apply-downgrade-'))
  try {
    makeValidTree(stateDir, '0.8.0')
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    makeValidTree(stateDir, '3.0.0')
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const reset = (): void => {
      clearActivationJournal(stateDir)
      writeOverride(stateDir, {
        shellVersion: gatewayPackageVersion,
        chosenVersion: null,
        resolvedVersion: null,
        pending: null,
        swapAttempted: false,
      })
    }

    // Builtin authority (no pointer, effective active v0.9.0): a staged
    // downgrade to 0.8.0 arms a manualRollback intent on apply().
    await manager.select('0.8.0')
    let result = await manager.apply()
    assert.equal(result.pending, true)
    let journal = readActivationJournalState(stateDir)
    assert.equal(journal.kind, 'valid')
    if (journal.kind === 'valid') {
      assert.equal(journal.journal.manualRollback, true, 'builtin-active staged downgrade keeps data-restore semantics')
      assert.equal(journal.journal.targetVersion, '0.8.0')
    }
    assert.equal(readOverride(stateDir)?.pending, '0.8.0')
    reset()

    // Pointer v2 active: a staged downgrade to 1.0.0 arms manualRollback.
    writeCurrentPointer(stateDir, '2.0.0')
    await manager.select('1.0.0')
    result = await manager.apply()
    assert.equal(result.pending, true)
    journal = readActivationJournalState(stateDir)
    assert.equal(journal.kind, 'valid')
    if (journal.kind === 'valid') {
      assert.equal(journal.journal.manualRollback, true, 'pointer-active staged downgrade arms a manual rollback')
      assert.equal(journal.journal.targetVersion, '1.0.0')
    }
    assert.equal(readOverride(stateDir)?.pending, '1.0.0')
    reset()

    // Pointer v2 active: a staged UPGRADE to 3.0.0 is a plain switch
    // (manualRollback=false — data-restore semantics are downgrade-only).
    await manager.select('3.0.0')
    result = await manager.apply()
    assert.equal(result.pending, true)
    journal = readActivationJournalState(stateDir)
    assert.equal(journal.kind, 'valid')
    if (journal.kind === 'valid') {
      assert.equal(journal.journal.manualRollback, false, 'an upgrade never arms data-restore semantics')
      assert.equal(journal.journal.targetVersion, '3.0.0')
    }
    assert.equal(readOverride(stateDir)?.pending, '3.0.0')
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
  const fakeReq = new FakeRequest('POST', '/chamber/runtime/select', { authorization: 'Bearer x' })
  const req = fakeReq as unknown as ApiRequest
  const fakeRes = new FakeResponse()
  const pending = routes.handle(req, fakeRes as unknown as ApiResponse, '/chamber/runtime/select')
  fakeReq.emit('data', Buffer.from(JSON.stringify({ version: 'x'.repeat(70 * 1024) })))
  fakeReq.emit('end')
  const claimed = await pending
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

test('FATAL idle block refuses ordinary mutations and keeps recover-metadata open (M1/H2 review)', async () => {
  let startupBlockedReason: string | null = 'journal-corrupt'
  let pending: string | null = null
  const calls: string[] = []
  const manager = {
    status: () => ({ phase: 'idle', pending, startupBlockedReason }),
    mutationInProgress: () => false,
    select: async () => { calls.push('select'); return { accepted: true } },
    apply: async () => { calls.push('apply'); return { pending: true } },
    rollback: async () => { calls.push('rollback'); return { accepted: true } },
    cleanupVersion: async () => { calls.push('cleanup'); return { version: 'x', removed: true } },
    restorePreRollback: async () => { calls.push('restore'); return { accepted: true } },
    recoverMetadata: async () => { calls.push('recover'); return { accepted: true } },
    restoreBuiltin: async () => { calls.push('restore-builtin'); return { accepted: true } },
    retryApply: async () => ({ accepted: true, blockedReason: null }),
    retryRestore: async () => ({ accepted: true, blockedReason: null }),
    restart: async () => { calls.push('restart') },
    restartInFlight: () => false,
    getRegistry: () => ({ origin: 'https://registry.npmjs.org' }),
    setRegistry: async (origin: string) => { calls.push('registry'); return { origin } },
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const body = JSON.stringify({ version: '1.0.0' })
  for (const [method, path, payload] of [
    ['POST', '/chamber/runtime/select', body],
    ['POST', '/chamber/runtime/apply', undefined],
    ['POST', '/chamber/runtime/rollback', body],
    ['POST', '/chamber/runtime/cleanup-version', body],
    ['POST', '/chamber/runtime/restore-pre-rollback', JSON.stringify({ stashName: '1700000000000-deadbeef' })],
    ['POST', '/chamber/runtime/restart', undefined],
  ] as const) {
    const res = await runRoute(routes, method, path, payload)
    assert.equal(res.status, 409, `${path} must refuse under a FATAL block`)
    assert.equal((res.json as { code: string }).code, 'runtime_recovery_required', path)
  }
  const registryRefused = await runRoute(routes, 'PUT', '/chamber/runtime/registry', JSON.stringify({ origin: 'https://registry.npmjs.org' }))
  assert.equal(registryRefused.status, 409)
  const recover = await runRoute(routes, 'POST', '/chamber/runtime/recover-metadata')
  assert.equal(recover.status, 200, 'recover-metadata stays open under a FATAL block')
  assert.deepEqual(calls, ['recover'])
  const list = await runRoute(routes, 'GET', '/chamber/runtime/')
  assert.equal(list.status, 200)
  const routesList = (list.json as { routes: string[] }).routes
  assert.equal(routesList.length, 15)
  for (const name of ['cleanup-version', 'restore-pre-rollback', 'recover-metadata']) {
    assert.ok(routesList.includes(name), `route list exposes ${name}`)
  }
  // H2: the same FATAL block with a stale pending must keep the recovery
  // surface open — a startup block OUTRANKS a lingering pending value in the
  // gate itself (2026 audit R3: falling through to the pending terminal gate
  // used to refuse recover-metadata with runtime_pending while
  // restore-builtin was simultaneously refused by the block branch — a fully
  // locked recovery surface). Restore-builtin/ordinary mutations stay
  // refused, labeled by the startup block, never by the stale pending.
  pending = '1.0.0'
  const recoverWithPending = await runRoute(routes, 'POST', '/chamber/runtime/recover-metadata')
  assert.equal(recoverWithPending.status, 200, 'recover stays open even with a stale pending (block outranks pending)')
  assert.deepEqual(calls, ['recover', 'recover'])
  const restoreUnderFatalPending = await runRoute(routes, 'POST', '/chamber/runtime/restore-builtin', '{}')
  assert.equal(restoreUnderFatalPending.status, 409)
  assert.equal((restoreUnderFatalPending.json as { code: string }).code, 'runtime_recovery_required')
  const selectUnderFatalPending = await runRoute(routes, 'POST', '/chamber/runtime/select', body)
  assert.equal(selectUnderFatalPending.status, 409)
  assert.equal((selectUnderFatalPending.json as { code: string }).code, 'runtime_recovery_required', 'a startup block labels refusals, not the stale pending')
  assert.deepEqual(calls, ['recover', 'recover'], 'the refused actions never reach the manager')
})

test('real manager: FATAL journal + stale pending projects idle+blocked with recover eligibility (H2)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-fatal-pending-'))
  const oldEnv = process.env.DSH_GATEWAY_DSH_PATH
  try {
    delete process.env.DSH_GATEWAY_DSH_PATH
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true })
    writeFileSync(join(stateDir, 'dsh-runtime', 'activation-journal.json'), '{corrupt', { mode: 0o600 })
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.2.3', resolvedVersion: '1.2.3',
      pending: '1.2.3', swapAttempted: false,
    })
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const startup = await manager.startupTransaction()
    assert.equal(startup.blockedReason, 'journal-corrupt')
    const status = await manager.status()
    assert.equal(status.phase, 'idle', 'a FATAL block outranks the stale pending phase')
    assert.equal(status.pending, '1.2.3', 'the pending fact stays visible for the recovery transaction')
    assert.equal(status.startupBlockedReason, 'journal-corrupt')
    assert.equal(status.canRecoverMetadata, true, 'the recovery route is advertised and reachable')
    // Route-level parity on the REAL manager: the gate must let
    // recover-metadata through (block outranks the stale pending — 2026
    // audit R3) while restore-builtin stays refused as a startup block.
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const restore = await runRoute(routes, 'POST', '/chamber/runtime/restore-builtin', '{}')
    assert.equal(restore.status, 409)
    assert.equal((restore.json as { code: string }).code, 'runtime_recovery_required')
    const select = await runRoute(routes, 'POST', '/chamber/runtime/select', JSON.stringify({ version: '1.2.3' }))
    assert.equal(select.status, 409)
    assert.equal((select.json as { code: string }).code, 'runtime_recovery_required')
    await manager.dispose()
  } finally {
    if (oldEnv === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = oldEnv
    rmSync(stateDir, { recursive: true, force: true })
  }
})
// ---------------------------------------------------------------------------
// Design 21 decision 12 + §6.3 (Phase 4.1/4.5): start primitive and the
// managed profile-write lease (lifecycle writer barrier)
// ---------------------------------------------------------------------------

test('start route: 202 from stopped/error/restart-exhausted; 409 while running/starting; double start 409', async () => {
  let connectionState = 'stopped'
  let starts = 0
  let starting = false
  const manager = {
    status: () => ({ phase: 'idle', connectionState, startupBlockedReason: null }),
    start: async () => { starts += 1 },
    startInFlight: () => starting,
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const stopped = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(stopped.status, 202)
  assert.equal((stopped.json as { accepted: boolean }).accepted, true)
  assert.equal(starts, 1)
  connectionState = 'error'
  const errored = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(errored.status, 202, 'error is a start window state')
  assert.equal(starts, 2)
  connectionState = 'restart-exhausted'
  const exhausted = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(exhausted.status, 202, 'restart-exhausted is the r1 recovery window (F7 coordination via the manager gate)')
  assert.equal(starts, 3)
  connectionState = 'ready'
  const running = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(running.status, 409)
  assert.equal((running.json as { code: string }).code, 'runtime_busy')
  assert.match((running.json as { error: string }).error, /managed dsh is running \(ready\)/)
  assert.equal(starts, 3, 'a running dsh is not a start target — no fake 202')
  connectionState = 'starting'
  const startingState = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(startingState.status, 409, 'a spawn already in flight is not a start target')
  assert.equal(starts, 3)
  // Double start: the single-flight refusal must answer BEFORE the connection
  // gate can swallow it (a start in flight projects 'starting' on a real plane).
  connectionState = 'stopped'
  starting = true
  const double = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(double.status, 409)
  assert.equal((double.json as { code: string }).code, 'runtime_busy')
  assert.match((double.json as { error: string }).error, /a start is already in flight/)
  assert.equal(starts, 3)
})

test('start route: busy phases, phase-less recovery blocks, pending and profile-write lease refuse 409 before any 202', async () => {
  let phase = 'idle'
  let connectionState = 'stopped'
  let startupBlockedReason: string | null = null
  let profileWrite = false
  let starts = 0
  const manager = {
    status: () => ({ phase, connectionState, startupBlockedReason, pending: null }),
    start: async () => { starts += 1 },
    startInFlight: () => false,
    profileWriteInFlight: () => profileWrite,
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  phase = 'applying'
  const applying = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(applying.status, 409)
  assert.equal((applying.json as { code: string }).code, 'runtime_busy')
  assert.match((applying.json as { error: string }).error, /runtime mutation in progress; start refused/)
  phase = 'installing'
  const installing = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(installing.status, 409)
  assert.equal((installing.json as { code: string }).code, 'runtime_busy')
  assert.equal(starts, 0)
  // Recovery gate is not bypassable: recovery phases only expose their
  // matching retry (decision 12; restore-builtin applies to pending/healthy
  // selections only — 2026 audit R2).
  phase = 'swap-attempted'
  const swap = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(swap.status, 409)
  assert.equal((swap.json as { code: string }).code, 'runtime_recovery_required')
  assert.match((swap.json as { error: string }).error, /only retry-apply is allowed/)
  phase = 'restore-blocked'
  const restore = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(restore.status, 409)
  assert.equal((restore.json as { code: string }).code, 'runtime_recovery_required')
  assert.match((restore.json as { error: string }).error, /only retry-restore is allowed/)
  phase = 'snapshot-failed'
  const snapshot = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(snapshot.status, 409)
  assert.equal((snapshot.json as { code: string }).code, 'runtime_recovery_required')
  phase = 'pending'
  const pending = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(pending.status, 409)
  assert.equal((pending.json as { code: string }).code, 'runtime_pending')
  assert.equal(starts, 0)
  // A phase-less in-memory block (fatal metadata verdicts never surface a
  // recovery phase string) must not leak a raw start past the verdict.
  phase = 'idle'
  startupBlockedReason = 'journal-corrupt'
  const corrupt = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(corrupt.status, 409)
  assert.equal((corrupt.json as { code: string }).code, 'runtime_recovery_required')
  assert.match((corrupt.json as { error: string }).error, /startup block journal-corrupt requires recovery first/)
  startupBlockedReason = null
  profileWrite = true
  const leased = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(leased.status, 409)
  assert.equal((leased.json as { code: string }).code, 'runtime_busy')
  assert.match((leased.json as { error: string }).error, /managed profile write in flight \(plugin mutation\); start refused/)
  profileWrite = false
  const accepted = await runRoute(routes, 'POST', '/chamber/runtime/start')
  assert.equal(accepted.status, 202)
  assert.equal(starts, 1)
})

test('restart and select refuse 409 while the profile-write lease is held (no fake 202)', async () => {
  let profileWrite = true
  let restarts = 0
  const manager = {
    status: () => ({ phase: 'idle', connectionState: 'ready', startupBlockedReason: null }),
    profileWriteInFlight: () => profileWrite,
    restart: async () => { restarts += 1 },
    restartInFlight: () => false,
    select: async () => { throw new Error('must not be called while the lease is held') },
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const restart = await runRoute(routes, 'POST', '/chamber/runtime/restart')
  assert.equal(restart.status, 409)
  assert.equal((restart.json as { code: string }).code, 'runtime_busy')
  assert.match((restart.json as { error: string }).error, /managed profile write in flight \(plugin mutation\); restart refused/)
  const select = await runRoute(routes, 'POST', '/chamber/runtime/select', JSON.stringify({ version: '1.2.3' }))
  assert.equal(select.status, 409)
  assert.equal((select.json as { code: string }).code, 'runtime_busy')
  assert.match((select.json as { error: string }).error, /profile write in flight/)
  assert.equal(restarts, 0)
  profileWrite = false
  const restartOk = await runRoute(routes, 'POST', '/chamber/runtime/restart')
  assert.equal(restartOk.status, 202)
  assert.equal(restarts, 1)
})

test('route inventory lists start and /status passes the start field through', async () => {
  let startField: 'ok' | 'failed' | 'running' | null = 'running'
  const manager = {
    status: async () => ({ kind: 'dsh-chamber-gateway-runtime', phase: 'idle', connectionState: 'stopped', start: startField }),
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  const status = await runRoute(routes, 'GET', '/chamber/runtime/status')
  assert.equal(status.status, 200)
  assert.equal((status.json as { start: string }).start, 'running')
  startField = null
  const cleared = await runRoute(routes, 'GET', '/chamber/runtime/status')
  assert.equal((cleared.json as { start: string | null }).start, null)
  const inventory = await runRoute(routes, 'GET', '/chamber/runtime')
  assert.equal(inventory.status, 200)
  const routesList = (inventory.json as { routes: string[] }).routes
  assert.ok(routesList.includes('start'), `route inventory must include start (${routesList.join(',')})`)
  assert.ok(routesList.includes('restart'))
})

test('profile-write lease: acquisition, projection, nested release, underflow guard and post-dispose refusal', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-lease-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.equal(manager.profileWriteInFlight(), false)
    const first = manager.beginProfileWrite()
    assert.equal(first.ok, true)
    assert.equal(manager.profileWriteInFlight(), true)
    // The count model permits nested acquisition (the A1 queue may hold a
    // drain-wide lease around per-operation leases); the barrier opens only
    // when every holder releases.
    const second = manager.beginProfileWrite()
    assert.equal(second.ok, true)
    assert.equal(manager.profileWriteInFlight(), true, 'one remaining holder keeps the fence closed')
    if (first.ok && second.ok) {
      first.release()
      assert.equal(manager.profileWriteInFlight(), true)
      second.release()
      assert.equal(manager.profileWriteInFlight(), false)
      assert.throws(() => second.release(), /lease underflow/, 'double release must fail loud, never reopen silently')
      assert.equal(manager.profileWriteInFlight(), false)
    }
    await manager.dispose()
    const afterDispose = manager.beginProfileWrite()
    assert.equal(afterDispose.ok, false)
    if (!afterDispose.ok) {
      assert.equal(afterDispose.code, 'runtime_busy')
      assert.match(afterDispose.error, /disposing/)
    }
    assert.equal(manager.profileWriteInFlight(), false, 'a refused acquisition never increments the counter')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('beginProfileWrite refuses while a restart, install or start is in flight and while dsh is starting/restarting', async () => {
  const restartDir = mkdtempSync(join(tmpdir(), 'gw-rt-lease-restart-'))
  try {
    let releaseRestart!: () => void
    const restartGate = new Promise<void>((resolve) => { releaseRestart = resolve })
    const plane = fakePlane()
    plane.restartLocal = async () => { plane._state.connectionState = 'ready'; await restartGate }
    const manager = createGatewayRuntimeManager({ config: config(restartDir), plane, logger: silentLogger })
    const inflight = manager.restart()
    const lease = manager.beginProfileWrite()
    assert.equal(lease.ok, false)
    if (!lease.ok) {
      assert.equal(lease.code, 'runtime_busy')
      assert.match(lease.error, /restart is in flight/)
    }
    releaseRestart()
    await inflight
    const after = manager.beginProfileWrite()
    assert.equal(after.ok, true)
    if (after.ok) after.release()
    await manager.dispose()
  } finally {
    rmSync(restartDir, { recursive: true, force: true })
  }

  const installDir = mkdtempSync(join(tmpdir(), 'gw-rt-lease-install-'))
  try {
    let rejectFetch!: (error: Error) => void
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(installDir),
      plane,
      logger: silentLogger,
      fetchMetadata: async () => new Promise((_, reject) => { rejectFetch = reject }),
    })
    const install = manager.select('2.0.0')
    const lease = manager.beginProfileWrite()
    assert.equal(lease.ok, false)
    if (!lease.ok) {
      assert.equal(lease.code, 'runtime_busy')
      assert.match(lease.error, /install is in flight/)
    }
    rejectFetch(new Error('test install cancelled'))
    await assert.rejects(install, /test install cancelled/)
    await manager.dispose()
  } finally {
    rmSync(installDir, { recursive: true, force: true })
  }

  const startDir = mkdtempSync(join(tmpdir(), 'gw-rt-lease-start-'))
  try {
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    const plane = fakePlane()
    plane.startLocal = async () => { plane._state.connectionState = 'ready'; await startGate }
    const manager = createGatewayRuntimeManager({ config: config(startDir), plane, logger: silentLogger })
    const start = manager.start()
    const lease = manager.beginProfileWrite()
    assert.equal(lease.ok, false)
    if (!lease.ok) {
      assert.equal(lease.code, 'runtime_busy')
      assert.match(lease.error, /start is in flight/)
    }
    releaseStart()
    await start
    await manager.dispose()
  } finally {
    rmSync(startDir, { recursive: true, force: true })
  }

  const windowDir = mkdtempSync(join(tmpdir(), 'gw-rt-lease-window-'))
  try {
    const plane = fakePlane()
    const manager = createGatewayRuntimeManager({ config: config(windowDir), plane, logger: silentLogger })
    for (const state of ['starting', 'restarting'] as const) {
      plane._state.connectionState = state
      const lease = manager.beginProfileWrite()
      assert.equal(lease.ok, false)
      if (!lease.ok) {
        assert.equal(lease.code, 'runtime_busy')
        assert.match(lease.error, new RegExp(`managed dsh is ${state}`))
      }
    }
    plane._state.connectionState = 'ready'
    const lease = manager.beginProfileWrite()
    assert.equal(lease.ok, true)
    if (lease.ok) lease.release()
    await manager.dispose()
  } finally {
    rmSync(windowDir, { recursive: true, force: true })
  }
})

test('beginProfileWrite refuses pending and recovery phases (runtime_pending / runtime_recovery_required)', async () => {
  const pendingDir = mkdtempSync(join(tmpdir(), 'gw-rt-lease-pending-'))
  try {
    writeOverride(pendingDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.2.3', resolvedVersion: '1.2.3',
      pending: '1.2.3', swapAttempted: false,
    })
    const manager = createGatewayRuntimeManager({ config: config(pendingDir), plane: fakePlane(), logger: silentLogger })
    const lease = manager.beginProfileWrite()
    assert.equal(lease.ok, false)
    if (!lease.ok) {
      assert.equal(lease.code, 'runtime_pending')
      assert.match(lease.error, /only restore-builtin is allowed until the next startup/)
    }
    await manager.dispose()
  } finally {
    rmSync(pendingDir, { recursive: true, force: true })
  }

  const recoveryDir = mkdtempSync(join(tmpdir(), 'gw-rt-lease-recovery-'))
  try {
    makeValidTree(recoveryDir, '1.2.3')
    writeOverride(recoveryDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.2.3', resolvedVersion: '1.2.3',
      pending: '1.2.3', swapAttempted: true,
    })
    const plane = fakePlane()
    const manager = createGatewayRuntimeManager({ config: config(recoveryDir), plane, logger: silentLogger })
    // Derive the authoritative in-memory block exactly like gateway boot does.
    const startup = await manager.startupTransaction()
    assert.equal(startup.blockedReason, 'swap-attempted')
    assert.equal(plane.connectionState, 'stopped')
    const lease = manager.beginProfileWrite()
    assert.equal(lease.ok, false)
    if (!lease.ok) {
      assert.equal(lease.code, 'runtime_recovery_required')
      assert.match(lease.error, /resume via the matching retry route \(restore-builtin applies to pending or healthy selections only\)/)
    }
    await manager.dispose()
  } finally {
    rmSync(recoveryDir, { recursive: true, force: true })
  }
})

test('runtime mutations and start/restart refuse while the profile-write lease is held (both directions fenced)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-lease-fence-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const plane = fakePlane()
    plane._state.connectionState = 'stopped'
    plane.restartLocal = async () => { plane._state.connectionState = 'ready' }
    plane.startLocal = async () => { plane._state.connectionState = 'ready' }
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    const lease = manager.beginProfileWrite()
    assert.equal(lease.ok, true)
    const busyRefusal = (error: unknown): boolean =>
      (error as { code?: string }).code === 'runtime_busy'
      && /profile write in flight/.test((error as Error).message)
    if (lease.ok) {
      // Runtime transactions cannot interleave the plugin pnpm child.
      await assert.rejects(manager.restart(), busyRefusal)
      await assert.rejects(manager.start(), busyRefusal)
      await assert.rejects(manager.applyNow(), busyRefusal, 'apply-now preflight refuses synchronously under the lease')
      await assert.rejects(manager.setRegistry('https://registry.npmmirror.com'), busyRefusal)
      assert.equal(manager.mutationInProgress(), false, 'the lease is not a runtime mutation flag — route gates consult profileWriteInFlight')
      lease.release()
    }
    // Released lease: the same actions reach their own gates again.
    await assert.rejects(manager.apply(), /no runtime version selected/)
    await manager.restart()
    assert.equal((await manager.status()).restart, 'ok')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('start() state matrix: stopped/error/restart-exhausted reach ok; running/starting/degraded refuse; failure projects failed + operationError', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-start-matrix-'))
  try {
    const plane = fakePlane()
    plane.startLocal = async () => { plane._state.connectionState = 'ready' }
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    await manager.start()
    assert.equal((await manager.status()).start, 'ok')
    assert.equal((await manager.status()).operationError, null, 'a successful start clears the stale operationError')
    // Running/degraded/starting states are not start targets.
    for (const runningState of ['ready', 'degraded', 'starting', 'restarting']) {
      plane._state.connectionState = runningState
      await assert.rejects(manager.start(), (error: unknown) =>
        (error as { code?: string }).code === 'runtime_busy'
        && (error as Error).message === `managed dsh is running (${runningState}); start applies to stopped/error/restart-exhausted`)
    }
    // error and restart-exhausted are r1 windows.
    plane._state.connectionState = 'error'
    await manager.start()
    assert.equal((await manager.status()).start, 'ok')
    plane._state.connectionState = 'restart-exhausted'
    await manager.start()
    assert.equal((await manager.status()).start, 'ok')
    // RESOLVE ≠ SUCCESS: startLocal() that settles without a live process is
    // 'failed', never a false 'ok'.
    plane._state.connectionState = 'stopped'
    plane.startLocal = async () => { plane._state.connectionState = 'stopped' }
    await assert.rejects(manager.start(), /dsh start did not reach ready \(stopped\)/)
    assert.equal((await manager.status()).start, 'failed')
    assert.match((await manager.status()).operationError ?? '', /did not reach ready \(stopped\)/)
    // A throwing startLocal projects the sanitized failure.
    plane._state.connectionState = 'stopped'
    plane.startLocal = async () => { throw new Error('spawn denied /secret/token=abc') }
    await assert.rejects(manager.start(), /spawn denied/)
    const operationError = (await manager.status()).operationError as string
    assert.ok(!operationError.includes('/secret'), 'paths redacted')
    assert.ok(!operationError.includes('token=abc'), 'credentials redacted')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('start() outcome lifecycle: status().start projects running → ok; double start 409; a fresh start supersedes the restart verdict', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-start-outcome-'))
  try {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const plane = fakePlane()
    plane.startLocal = async () => { plane._state.connectionState = 'ready'; await gate }
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger })
    // A prior restart verdict must not linger across a fresh start epoch.
    await manager.restart()
    assert.equal((await manager.status()).restart, 'ok')
    plane._state.connectionState = 'stopped'
    const inflight = manager.start()
    assert.equal((await manager.status()).start, 'running',
      "'running' must be visible the moment the 202 poll can read status")
    assert.equal((await manager.status()).restart, null, 'the fresh start epoch clears the stale restart verdict')
    await assert.rejects(manager.start(), (error: unknown) =>
      (error as { code?: string }).code === 'runtime_busy'
      && /a start is already in flight/.test((error as Error).message))
    release()
    await inflight
    assert.equal((await manager.status()).start, 'ok')
    // Double-start refusal leaves the outcome fields untouched.
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('start() never bypasses the recovery gate or an ordinary pending', async () => {
  const pendingDir = mkdtempSync(join(tmpdir(), 'gw-rt-start-pending-'))
  try {
    writeOverride(pendingDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.2.3', resolvedVersion: '1.2.3',
      pending: '1.2.3', swapAttempted: false,
    })
    const plane = fakePlane()
    plane.startLocal = async () => { plane._state.connectionState = 'ready' }
    const manager = createGatewayRuntimeManager({ config: config(pendingDir), plane, logger: silentLogger })
    await assert.rejects(manager.start(), (error: unknown) =>
      (error as { code?: string }).code === 'runtime_pending'
      && /only restore-builtin is allowed until the next startup/.test((error as Error).message))
    assert.equal(plane.connectionState, 'stopped', 'a refused start never touches the plane')
    await manager.dispose()
  } finally {
    rmSync(pendingDir, { recursive: true, force: true })
  }

  const recoveryDir = mkdtempSync(join(tmpdir(), 'gw-rt-start-recovery-'))
  try {
    makeValidTree(recoveryDir, '1.2.3')
    writeOverride(recoveryDir, {
      shellVersion: gatewayPackageVersion, chosenVersion: '1.2.3', resolvedVersion: '1.2.3',
      pending: '1.2.3', swapAttempted: true,
    })
    const plane = fakePlane()
    plane.startLocal = async () => { plane._state.connectionState = 'ready' }
    const manager = createGatewayRuntimeManager({ config: config(recoveryDir), plane, logger: silentLogger })
    const startup = await manager.startupTransaction()
    assert.equal(startup.blockedReason, 'swap-attempted')
    await assert.rejects(manager.start(), (error: unknown) =>
      (error as { code?: string }).code === 'runtime_recovery_required'
      && /runtime recovery swap-attempted is required; resume via the matching retry route \(restore-builtin applies to pending or healthy selections only\)/.test((error as Error).message))
    assert.equal(plane.connectionState, 'stopped', 'the recovery gate stops a start cold')
    await manager.dispose()
  } finally {
    rmSync(recoveryDir, { recursive: true, force: true })
  }
})

test('a stranded F4 invalidation (pointer + invalidatedAt, journal lost) self-heals through re-armed shell-invalidation instead of failing boot', async () => {
  // Durable state after an interrupted gateway-update F4 whose intent journal
  // was lost (e.g. the installer rolled back to an older shell that consumed
  // the journal): current pointer still names the old tree, override carries
  // invalidatedAt, no journal, no pending. Before the fix this booted "clean"
  // through startupTransaction and then crashed at the first startLocal with
  // 'gateway runtime current pointer has no matching active override' — a
  // crash loop with no HTTP recovery surface.
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-stranded-f4-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    mkdirSync(join(stateDir, 'dsh-home'), { recursive: true })
    writeFileSync(join(stateDir, 'dsh-home', 'settings.json'), '{"source":"v1"}')
    writeCurrentPointer(stateDir, '1.0.0')
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.8', // the pre-update gateway shell
      chosenVersion: '1.0.0',
      resolvedVersion: '1.0.0',
      pending: null,
      swapAttempted: false,
      selectedOnly: false,
      invalidatedAt: '2026-09-03T07:28:00.000Z',
      invalidatedReason: 'shell-version-changed',
      lastInvalidatedAt: '2026-09-03T07:28:00.000Z',
      lastInvalidatedReason: 'shell-version-changed',
      lastInvalidatedFromVersion: '1.0.0',
      lastInvalidationRecovered: false,
    })
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'the stranded state has no resumable journal')

    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    try {
      const startup = await manager.startupTransaction()
      assert.deepEqual(startup, { blockedReason: null }, 'the re-armed F4 transaction completes cleanly')
      assert.deepEqual(manager.resolveWorkspace(), {
        path: join(stateDir, 'builtin-anchor'),
        version: TEST_BUILTIN_VERSION,
        source: 'builtin',
      }, 'the stranded pointer was cleared through the probe-gated builtin switch — no resolveWorkspace crash')
      assert.equal(readCurrentPointer(stateDir), null, 'current pointer cleared by the builtin switch')
      assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'transaction journal consumed')
      const preserved = readOverride(stateDir)
      assert.equal(preserved?.chosenVersion, '1.0.0', 'the historical selection is preserved for re-selection')
      assert.equal(preserved?.invalidatedAt, '2026-09-03T07:28:00.000Z', 'invalidation record retained')
    } finally {
      await manager.dispose()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a settled F4 invalidation (pointer cleared) is NOT re-armed on later boots', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-settled-f4-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.8',
      chosenVersion: '1.0.0',
      resolvedVersion: '1.0.0',
      pending: null,
      swapAttempted: false,
      selectedOnly: false,
      invalidatedAt: '2026-09-03T07:28:00.000Z',
      invalidatedReason: 'shell-version-changed',
      lastInvalidatedAt: '2026-09-03T07:28:00.000Z',
      lastInvalidatedReason: 'shell-version-changed',
      lastInvalidatedFromVersion: '1.0.0',
      lastInvalidationRecovered: false,
      lastOutcome: 'applied',
    })
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      // Deterministic tripwire: if a re-arm regression ever fires here, the
      // transaction would probe — fail loudly instead of hitting the real
      // 127.0.0.1:17510.
      probeCandidate: async () => { throw new Error('settled state must never probe') },
    })
    try {
      const startup = await manager.startupTransaction()
      assert.deepEqual(startup, { blockedReason: null })
      assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'no transaction was manufactured')
      assert.deepEqual(manager.resolveWorkspace(), {
        path: join(stateDir, 'builtin-anchor'),
        version: TEST_BUILTIN_VERSION,
        source: 'builtin',
      }, 'builtin stays authoritative with no extra snapshot/switch cycle')
    } finally {
      await manager.dispose()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a stranded F4 invalidation carrying stale failure markers still self-heals (markers superseded on re-arm)', async () => {
  // runStartupPhase blocks on override.lastOutcome === 'snapshot-failed' (or
  // swapAttempted) BEFORE consuming the re-armed intent; since snapshot-failed
  // is not a blocked-but-alive reason in index.ts, the gateway would
  // crash-loop at startLocal. Re-arming must clear the stale markers
  // (fresh-transaction-supersedes parity with apply()/applyNowPreflight),
  // while preserving the historical fields.
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-stranded-markers-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    mkdirSync(join(stateDir, 'dsh-home'), { recursive: true })
    writeFileSync(join(stateDir, 'dsh-home', 'settings.json'), '{}')
    writeCurrentPointer(stateDir, '1.0.0')
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.8',
      chosenVersion: '1.0.0',
      resolvedVersion: '1.0.0',
      pending: null,
      swapAttempted: true,
      selectedOnly: false,
      invalidatedAt: '2026-09-03T07:28:00.000Z',
      invalidatedReason: 'shell-version-changed',
      lastInvalidatedAt: '2026-09-03T07:28:00.000Z',
      lastInvalidatedReason: 'shell-version-changed',
      lastInvalidatedFromVersion: '1.0.0',
      lastInvalidationRecovered: false,
      lastOutcome: 'snapshot-failed',
      lastError: 'stale snapshot failure from before the interruption',
    })
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    try {
      const startup = await manager.startupTransaction()
      assert.deepEqual(startup, { blockedReason: null }, 'stale failure markers must not block the re-armed transaction')
      assert.deepEqual(manager.resolveWorkspace(), {
        path: join(stateDir, 'builtin-anchor'),
        version: TEST_BUILTIN_VERSION,
        source: 'builtin',
      })
      assert.equal(readCurrentPointer(stateDir), null, 'pointer cleared through the builtin switch')
      const record = readOverride(stateDir)
      assert.equal(record?.lastOutcome, 'applied', 'the re-armed transaction ran and committed its own verdict (stale snapshot-failed superseded)')
      assert.equal(record?.lastError, null, 'stale lastError superseded')
      assert.equal(record?.swapAttempted, false, 'stale swapAttempted superseded')
      assert.equal(record?.chosenVersion, '1.0.0', 'historical selection preserved')
      assert.equal(record?.invalidatedAt, '2026-09-03T07:28:00.000Z', 'invalidation record preserved')
    } finally {
      await manager.dispose()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an interrupted F4 apply that failed at snapshot (intent journal + stale markers) resumes and heals on the next boot', async () => {
  // The F4 arm wrote the shell-invalidation intent and invalidated the
  // record, but the builtin-switch apply kept failing at the
  // pre-swap snapshot — leaving an intent-phase journal PLUS stale
  // lastOutcome/swapAttempted markers. runStartupPhase blocks on the markers
  // before resuming, and index.ts spawns through 'snapshot-failed' — with an
  // invalidated override + valid pointer the spawn-time resolution throws →
  // permanent crash loop even after the snapshot cause clears. The stale
  // markers must be superseded so the next boot retries and heals.
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-intent-snapshot-fail-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    mkdirSync(join(stateDir, 'dsh-home'), { recursive: true })
    writeFileSync(join(stateDir, 'dsh-home', 'settings.json'), '{"source":"v1"}')
    writeCurrentPointer(stateDir, '1.0.0')
    writeActivationIntent(stateDir, {
      targetVersion: TEST_BUILTIN_VERSION,
      targetIsBuiltin: true,
      manualRollback: false,
      intentKind: 'shell-invalidation',
    })
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.8',
      chosenVersion: '1.0.0',
      resolvedVersion: '1.0.0',
      pending: null,
      swapAttempted: true,
      selectedOnly: false,
      invalidatedAt: '2026-09-03T07:28:00.000Z',
      invalidatedReason: 'shell-version-changed',
      lastInvalidatedAt: '2026-09-03T07:28:00.000Z',
      lastInvalidatedReason: 'shell-version-changed',
      lastInvalidatedFromVersion: '1.0.0',
      lastInvalidationRecovered: false,
      lastOutcome: 'snapshot-failed',
      lastError: 'snapshot kept failing while the cause (disk/DSH_HOME) was present',
    })
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    try {
      const startup = await manager.startupTransaction()
      assert.deepEqual(startup, { blockedReason: null }, 'stale markers must not block the journaled resume')
      assert.deepEqual(manager.resolveWorkspace(), {
        path: join(stateDir, 'builtin-anchor'),
        version: TEST_BUILTIN_VERSION,
        source: 'builtin',
      })
      assert.equal(readCurrentPointer(stateDir), null)
      assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'intent journal consumed')
      const record = readOverride(stateDir)
      assert.equal(record?.lastOutcome, 'applied', 'the resumed transaction committed its own verdict')
      assert.equal(record?.lastError, null)
      assert.equal(record?.swapAttempted, false)
    } finally {
      await manager.dispose()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
