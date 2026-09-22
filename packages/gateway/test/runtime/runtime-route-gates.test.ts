/**
 * /chamber/runtime route gates: env/read-only fencing, restart verdicts,
 * retry-apply/retry-restore targets and FATAL block handling.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { type ApiRequest, type ApiResponse } from '@dsh-chamber/control-plane'
import { createGatewayRuntimeManager } from '../../src/runtime-manager.ts'
import {
  clearActivationJournal,
  readActivationJournalState,
  readOverride,
  writeCurrentPointer,
} from '@dsh-chamber/dsh-runtime'
import { createRuntimeRoutes } from '../../src/runtime-routes.ts'
import { FakeRequest, FakeResponse } from '../support/utils.ts'
import {
  silentLogger,
  config,
  fakePlane,
  runRoute,
  makeValidTree,
  writeOverrideRow,
  runtimeManager,
} from '../support/runtime-routes-harness.ts'

test('a rejected plane.restartLocal() surfaces as status().operationError (sanitized)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restart-fail-'))
  try {
    const plane = fakePlane()
    plane._state.restartError = 'spawn denied /secret/token=abc'
    const manager = runtimeManager(stateDir, plane)
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

test('gateway-owned files land in <stateDir>/dsh-runtime (single nesting, F1 regression)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-layout-'))
  try {
    const manager = runtimeManager(stateDir, fakePlane())
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
    const manager = runtimeManager(stateDir, plane)
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
    // restart-exhausted — that must be 'failed', never 'ok'.
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
    const manager = runtimeManager(stateDir, plane)
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
    const manager = runtimeManager(stateDir, fakePlane())
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
    const manager = runtimeManager(stateDir, fakePlane())
    await assert.rejects(manager.retryApply(), /no interrupted apply to retry/)
    await assert.rejects(manager.retryRestore(), /no interrupted restore to retry/)
    // A swap-attempted override: retry-apply clears the marker, re-runs the
    // startup transaction (no pending → not blocked) and brings dsh up.
    writeOverrideRow(stateDir, { chosenVersion: '1.2.3', pending: null, swapAttempted: true })
    const result = await manager.retryApply()
    assert.equal(result.accepted, true)
    assert.equal(result.blockedReason, null)
    // The interrupted-switch marker is gone: a second retry refuses.
    await assert.rejects(manager.retryApply(), /no interrupted apply to retry/)
    // snapshot-failed: a non-destructive recovery exists too —
    // retryApply accepts lastOutcome === 'snapshot-failed', clears it and
    // re-runs the startup transaction (desktop canRetryApply parity).
    writeOverrideRow(stateDir, { chosenVersion: '1.2.3', pending: null, lastOutcome: 'snapshot-failed', lastError: 'snapshot failed' })
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
    const manager = runtimeManager(stateDir, fakePlane())
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
    writeOverrideRow(stateDir, { chosenVersion: null, pending: null })

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
    const manager = runtimeManager(stateDir, fakePlane())
    const reset = (): void => {
      clearActivationJournal(stateDir)
      writeOverrideRow(stateDir, { chosenVersion: null, pending: null })
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

  // Once the cap trips, later data is not inspected or retained while the route
  // unwinds to its write-then-destroy error path.
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
  // The same FATAL block with a stale pending must keep the recovery surface
  // open — a startup block OUTRANKS a lingering pending value in the gate
  // itself; if the pending terminal gate won, recover-metadata would be refused
  // with runtime_pending while restore-builtin stays refused by the block
  // branch — a fully locked recovery surface. Restore-builtin/ordinary
  // mutations stay refused, labeled by the startup block, never by the stale
  // pending.
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
    writeOverrideRow(stateDir, { chosenVersion: '1.2.3', pending: '1.2.3' })
    const manager = runtimeManager(stateDir, fakePlane())
    const startup = await manager.startupTransaction()
    assert.equal(startup.blockedReason, 'journal-corrupt')
    const status = await manager.status()
    assert.equal(status.phase, 'idle', 'a FATAL block outranks the stale pending phase')
    assert.equal(status.pending, '1.2.3', 'the pending fact stays visible for the recovery transaction')
    assert.equal(status.startupBlockedReason, 'journal-corrupt')
    assert.equal(status.canRecoverMetadata, true, 'the recovery route is advertised and reachable')
    // Route-level parity on the REAL manager: the gate must let
    // recover-metadata through (block outranks the stale pending) while
    // restore-builtin stays refused as a startup block.
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
