/**
 * /chamber/runtime controller tests (design 18 §9.3): route behavior matrix —
 * restart 202/409, status pollable while dsh is down, auth gate, registry and
 * body validation, and the runtime manager's resolution chain + single-owner
 * guard. Fakes stand in for the plane; no real dsh, no fixed ports.
 *
 * P0 split siblings: runtime-ownership.test.ts, runtime-registry-status.test.ts,
 * runtime-apply-now-preflight.test.ts, runtime-activation-probes.test.ts,
 * runtime-apply-now-recovery.test.ts, runtime-builtin-selection.test.ts,
 * runtime-restart-exhausted.test.ts, runtime-route-gates.test.ts and
 * runtime-start-lease-invalidation.test.ts; shared helpers live in
 * test/support/runtime-routes-harness.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayRuntimeManager } from '../../src/runtime-manager.ts'
import { createRuntimeRoutes } from '../../src/runtime-routes.ts'
import { sanitizeRouteError } from '../../src/sanitize-route-error.ts'
import {
  silentLogger,
  TEST_BUILTIN_VERSION,
  config,
  fakePlane,
  runRoute,
  probeResultsFor,
  writeOverrideRow,
  writeDshHome,
  runtimeManager,
  derivedProbe,
} from '../support/runtime-routes-harness.ts'

// ---------------------------------------------------------------------------
// Controller route matrix (fake manager; no plane needed)
// ---------------------------------------------------------------------------

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

test('sanitizeRouteError keep tokens never widen path or credential redaction', () => {
  // Moved from boundary/sanitize-route-error.test.ts: the kept scoped-package
  // name already has route-level coverage (feature-lifecycle.test.ts, the
  // /chamber/plugins refusal), so only the keep-safety half is preserved here.
  const kept = '@dsh-chamber/dsh-chamber-seed-client-graph'
  const message = `unsyncable package ${JSON.stringify(kept)} while reading /Users/alice/private/state.json token=abc123`
  const out = sanitizeRouteError(message, [kept])
  assert.match(out, /@dsh-chamber\/dsh-chamber-seed-client-graph/)
  assert.doesNotMatch(out, /\/Users\/alice/)
  assert.match(out, /\[path\]/)
  assert.match(out, /token=\[redacted\]/)
  // An empty or non-string keep entry never widens the output, and without the
  // keep token the scoped name falls back to the pre-fix [path] shape.
  assert.match(sanitizeRouteError(message, ['']), /\[path\]/)
  assert.match(sanitizeRouteError(message, []), /@dsh-chamber\[path\]/)
})

// ---------------------------------------------------------------------------
// Manager: resolution chain + single-owner guard
// ---------------------------------------------------------------------------
test('resolution chain: env → override (valid tree) → builtin anchor', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-resolve-'))
  const oldEnv = process.env.DSH_GATEWAY_DSH_PATH
  try {
    process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
    const manager = runtimeManager(stateDir, fakePlane())
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
    const manager = runtimeManager(stateDir, fakePlane())
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
    // No probe seam: the fake plane has no dsh listener, so the builtin-anchor
    // probe fails for real and the metadata-probe-failed sentinel is pinned.
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
    const envManager = runtimeManager(stateDir, fakePlane())
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
    const healthy = runtimeManager(stateDir, fakePlane())
    await assert.rejects(healthy.recoverMetadata(), /no corrupt metadata to recover/)
    // Non-FATAL startup block (swap-attempted): recover refuses with the
    // recovery-required code — the swap/restore retry surface owns it.
    writeOverrideRow(stateDir, { chosenVersion: '1.2.3', pending: '1.2.3', swapAttempted: true })
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
    const home = writeDshHome(stateDir, '{"source":"preserved"}')
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
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null })
    writeFileSync(join(stateDir, 'dsh-runtime', 'current'), '{corrupt', { mode: 0o600 })
    const home = writeDshHome(stateDir, '{"source":"preserved"}')
    const order: string[] = []
    const plane = fakePlane({
      stopLocal: async () => { order.push('stop') },
      startLocal: async () => { order.push('start') },
    })
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane, { probeCandidate: derivedProbe(stateDir) })
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
