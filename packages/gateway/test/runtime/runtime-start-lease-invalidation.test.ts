/**
 * /chamber/runtime start primitive, the profile-write lease and shell
 * invalidation (F4) recovery: start state matrix, lease fencing and stranded /
 * fresh invalidation healing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayRuntimeManager } from '../../src/runtime-manager.ts'
import {
  readActivationJournalState,
  readCurrentPointerState,
  writeActivationIntent,
  writeActivationJournal,
  writeCurrentPointer,
  writeOverride,
  type ActivationJournal,
} from '@dsh-chamber/dsh-runtime'
import { createRuntimeRoutes } from '../../src/runtime-routes.ts'
import {
  silentLogger,
  TEST_BUILTIN_VERSION,
  gatewayPackageVersion,
  config,
  fakePlane,
  runRoute,
  makeValidTree,
  readOverrideRow,
  writeVersionSwitchIntent,
  writeDshHome,
  runtimeManager,
  derivedProbe,
} from '../support/runtime-routes-harness.ts'

// ---------------------------------------------------------------------------
// Design 21 decision 12 + §6.3: start primitive and the
// managed profile-write lease (lifecycle writer barrier)
// ---------------------------------------------------------------------------

/** The stranded/settled F4 invalidation record: the pre-update shell version,
 *  the retained selection and the full lastInvalidated* history. */
function writeF4Override(
  stateDir: string,
  fields: { swapAttempted?: boolean; lastOutcome?: string; lastError?: string | null } = {},
): void {
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
    ...fields,
  })
}

/** The builtin root the probe-gated switch leaves authoritative. */
function assertBuiltinWorkspace(
  manager: { resolveWorkspace(): unknown },
  stateDir: string,
  message?: string,
): void {
  const actual = manager.resolveWorkspace()
  const expected = { path: join(stateDir, 'builtin-anchor'), version: TEST_BUILTIN_VERSION, source: 'builtin' }
  if (message === undefined) assert.deepEqual(actual, expected)
  else assert.deepEqual(actual, expected, message)
}

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
  // selections only).
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
    const manager = runtimeManager(stateDir, fakePlane())
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
    const manager = runtimeManager(restartDir, plane)
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
    let resolveFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => { resolveFetchStarted = resolve })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(installDir),
      plane,
      logger: silentLogger,
      // 磁盘闸口改异步（runtimeDiskSummaryAsync）后 fetchMetadata 不在
      // select() 的同步前缀内启动——测试等待其实际启动再断言 lease 拒绝
      // （installInFlight 仍同步置位，语义不变）。
      fetchMetadata: async () => new Promise((_, reject) => {
        rejectFetch = reject
        resolveFetchStarted()
      }),
    })
    const install = manager.select('2.0.0')
    // race 兜底——若 select() 在到达 fetchMetadata 前 reject/return（回归），
    // 测试立即失败而非因 fetchStarted 永不 resolve 而永挂。
    await Promise.race([
      fetchStarted,
      install.then(
        () => { throw new Error('select settled before fetchMetadata started') },
        (error: unknown) => { throw error },
      ),
    ])
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
    const manager = runtimeManager(startDir, plane)
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
    const manager = runtimeManager(windowDir, plane)
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
    const manager = runtimeManager(pendingDir, fakePlane())
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
    const manager = runtimeManager(recoveryDir, plane)
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
    const manager = runtimeManager(stateDir, plane)
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
    const manager = runtimeManager(stateDir, plane)
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
    const manager = runtimeManager(stateDir, plane)
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
    const manager = runtimeManager(pendingDir, plane)
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
    const manager = runtimeManager(recoveryDir, plane)
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
  // invalidatedAt, no journal, no pending. Without the re-arm this state boots
  // "clean" through startupTransaction and then crashes at the first startLocal
  // with 'gateway runtime current pointer has no matching active override' — a
  // crash loop with no HTTP recovery surface.
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-stranded-f4-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    writeDshHome(stateDir, '{"source":"v1"}')
    writeCurrentPointer(stateDir, '1.0.0')
    writeF4Override(stateDir)
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'the stranded state has no resumable journal')

    const manager = runtimeManager(stateDir, fakePlane())
    try {
      const startup = await manager.startupTransaction()
      assert.deepEqual(startup, { blockedReason: null }, 'the re-armed F4 transaction completes cleanly')
      assertBuiltinWorkspace(manager, stateDir, 'the stranded pointer was cleared through the probe-gated builtin switch — no resolveWorkspace crash')
      assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'missing' }, 'current pointer cleared by the builtin switch')
      assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'transaction journal consumed')
      const preserved = readOverrideRow(stateDir)
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
    writeF4Override(stateDir, { lastOutcome: 'applied' })
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
      assertBuiltinWorkspace(manager, stateDir, 'builtin stays authoritative with no extra snapshot/switch cycle')
    } finally {
      await manager.dispose()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a FRESH shell-version mismatch over an APPLIED override with a settled applied-monitoring journal arms F4 (upgrade no longer crashes resolveWorkspace)', async () => {
  // The fresh-shell-mismatch fingerprint: an upgrade left the override
  // shellVersion on the previous shell with the activation journal settled in
  // applied-monitoring and the pointer on the chosen tree. The new shell must
  // arm the F4 shell-invalidation transaction (desktop parity) instead of
  // crashing at the first resolveWorkspace with 'current pointer has no
  // matching active override' — which would force the installer's health check
  // into an automatic rollback.
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-fresh-f4-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    writeDshHome(stateDir, '{"source":"v1"}')
    writeCurrentPointer(stateDir, '1.0.0')
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.8', // the pre-update gateway shell
      chosenVersion: '1.0.0',
      resolvedVersion: '1.0.0',
      pending: null,
      swapAttempted: false,
      selectedOnly: false,
      lastOutcome: 'applied',
    })
    // The settled post-commit journal of the applied override (F7 context).
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
    assert.equal(readOverrideRow(stateDir)?.invalidatedAt, undefined, 'the override is NOT yet invalidated (fresh mismatch)')

    const manager = runtimeManager(stateDir, fakePlane())
    try {
      const startup = await manager.startupTransaction()
      assert.deepEqual(startup, { blockedReason: null }, 'the armed F4 transaction completes cleanly')
      assertBuiltinWorkspace(manager, stateDir, 'the fresh mismatch resolved through the probe-gated builtin switch — no resolveWorkspace crash')
      assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'missing' }, 'current pointer cleared by the builtin switch')
      assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'transaction journal consumed')
      const preserved = readOverrideRow(stateDir)
      assert.equal(preserved?.chosenVersion, '1.0.0', 'the historical selection is preserved for re-selection')
      assert.ok(preserved?.invalidatedAt !== undefined && preserved?.invalidatedAt !== null,
        'the fresh mismatch invalidated the record (kept, one-click re-selectable)')
    } finally {
      await manager.dispose()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a FRESH shell mismatch with an intent-phase old-shell transaction replaces the intent with shell-invalidation (desktop parity)', async () => {
  // The old shell died mid-apply (phase 'intent') when the update restarted
  // the service. The new shell must NOT leave the stale version-switch
  // intent to be cleared as an orphan (which would strand the pointer and
  // crash resolveWorkspace); it replaces it with the F4 intent — the desktop
  // controller's exact behavior.
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-fresh-f4-intent-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    writeDshHome(stateDir, '{"source":"v1"}')
    writeCurrentPointer(stateDir, '1.0.0')
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.8',
      chosenVersion: '1.0.0',
      resolvedVersion: '1.0.0',
      pending: '1.0.0',
      swapAttempted: false,
      selectedOnly: false,
      lastOutcome: 'applied',
    })
    writeVersionSwitchIntent(stateDir, '1.0.0')
    assert.equal(readOverrideRow(stateDir)?.invalidatedAt, undefined, 'fresh mismatch')

    const manager = runtimeManager(stateDir, fakePlane())
    try {
      const startup = await manager.startupTransaction()
      assert.deepEqual(startup, { blockedReason: null }, 'the replaced F4 transaction completes cleanly')
      assertBuiltinWorkspace(manager, stateDir, 'the old-shell intent was superseded by the probe-gated builtin switch')
      assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'missing' }, 'pointer cleared through the builtin switch')
      const preserved = readOverrideRow(stateDir)
      assert.equal(preserved?.chosenVersion, '1.0.0', 'the historical selection is preserved')
      assert.ok(preserved?.invalidatedAt != null, 'the record was invalidated by the fresh-mismatch F4 arm')
    } finally {
      await manager.dispose()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a FRESH shell mismatch with a LIVE old-shell transaction journal (prepared) is NOT armed — the shared-core journal-mismatch block keeps the old transaction intact (negative gate)', async () => {
  // The negative half of the F4 arming gate (desktop parity): the old shell
  // died mid-apply — its durable journal already advanced past 'intent' to
  // 'prepared' (the pre-swap snapshot was written) — when the gateway update
  // restarted the service. executeStartupTransaction must NOT re-arm this as a
  // shell-invalidation intent: the live transaction keeps its shared-core
  // semantics. runStartupPhase's overrideInvalidated gate (runtime-startup.ts)
  // blocks a fresh-mismatch override carrying a version-switch journal whose
  // phase is NOT a rollback continuation ('prepared'/'switched' are outside
  // ROLLBACK_CONTINUATION_PHASES) with 'journal-mismatch', leaving the old
  // transaction's evidence and the un-invalidated record untouched — never
  // finishing the old shell's apply under the new shell contract. (An
  // intent-phase transaction IS replaced, proven by the sibling positive
  // tests; a restoring/rollback phase continues instead of blocking.)
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-fresh-f4-live-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    writeDshHome(stateDir, '{"source":"v1"}')
    // Builtin (0.9.0) is still the active source — the old shell died BEFORE
    // the pointer switch, so no current pointer exists yet.
    writeOverride(stateDir, {
      shellVersion: '0.2.0-beta.8',
      chosenVersion: '1.0.0',
      resolvedVersion: '1.0.0',
      pending: '1.0.0',
      swapAttempted: false,
      selectedOnly: false,
    })
    // The old shell's durable pre-swap transaction: snapshot completed,
    // pointer not yet switched. Exactly the journal apply-phase persists
    // between the snapshot write and the pointer switch.
    const prepared: ActivationJournal = {
      schemaVersion: 1,
      phase: 'prepared',
      targetVersion: '1.0.0',
      targetIsBuiltin: false,
      manualRollback: false,
      intentKind: 'version-switch',
      sourceVersion: TEST_BUILTIN_VERSION,
      sourceIsBuiltin: true,
      sourceWasKnownGood: true,
      knownGoodVersion: null,
      preSwapSnapshotName: `${TEST_BUILTIN_VERSION}-123`,
      manualDataSnapshotName: null,
      preRollbackStashName: null,
      rollbackTarget: null,
      nextIntent: null,
      startedAt: '2026-09-03T07:28:00.000Z',
      updatedAt: '2026-09-03T07:28:00.000Z',
    }
    writeActivationJournal(stateDir, prepared)
    assert.equal(readOverrideRow(stateDir)?.invalidatedAt, undefined, 'the override is NOT yet invalidated (fresh mismatch)')

    let probes = 0
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      // Deterministic tripwire: if a re-arm regression ever fires on a live
      // transaction, the transaction would spawn/probe — fail loudly instead
      // of hitting the real 127.0.0.1:17510 or faking a pass.
      probeCandidate: async () => { probes += 1; throw new Error('a live old-shell transaction must never be re-armed into a probe') },
    })
    try {
      const startup = await manager.startupTransaction()
      assert.deepEqual(startup, { blockedReason: 'journal-mismatch' },
        'a fresh mismatch over a live old-shell transaction blocks (journal-mismatch), never arms F4')
      // The durable journal is byte-identical — no shell-invalidation intent
      // was written over the live transaction (writeActivationIntent would
      // refuse anyway; the gate must not even try).
      const journalState = readActivationJournalState(stateDir)
      assert.equal(journalState.kind, 'valid', 'the live transaction journal is preserved')
      if (journalState.kind === 'valid') {
        assert.equal(journalState.journal.phase, 'prepared', 'the journal phase is untouched')
        assert.equal(journalState.journal.intentKind, 'version-switch', 'no shell-invalidation intent replaced the old transaction')
        assert.equal(journalState.journal.targetVersion, '1.0.0', 'the old transaction target is untouched')
        assert.equal(journalState.journal.targetIsBuiltin, false)
      }
      // The record is NOT invalidated by the new shell (arming is the only
      // writer of the fresh-mismatch invalidation).
      const preserved = readOverrideRow(stateDir)
      assert.equal(preserved?.invalidatedAt, undefined, 'the live transaction record is not invalidated')
      assert.equal(preserved?.pending, '1.0.0', 'the old transaction pending is preserved')
      assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'missing' }, 'the pointer was never written (pre-swap crash window)')
      assert.equal(probes, 0, 'no spawn/probe was attempted under the blocked verdict')
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
  // while preserving the lastInvalidated* history fields.
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-stranded-markers-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    writeDshHome(stateDir, '{}')
    writeCurrentPointer(stateDir, '1.0.0')
    writeF4Override(stateDir, { swapAttempted: true, lastOutcome: 'snapshot-failed', lastError: 'stale snapshot failure from before the interruption' })
    const manager = runtimeManager(stateDir, fakePlane(), { probeCandidate: derivedProbe(stateDir) })
    try {
      const startup = await manager.startupTransaction()
      assert.deepEqual(startup, { blockedReason: null }, 'stale failure markers must not block the re-armed transaction')
      assertBuiltinWorkspace(manager, stateDir)
      assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'missing' }, 'pointer cleared through the builtin switch')
      const record = readOverrideRow(stateDir)
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
  // record, but the builtin-switch apply keeps failing at the
  // pre-swap snapshot — leaving an intent-phase journal PLUS stale
  // lastOutcome/swapAttempted markers. runStartupPhase blocks on the markers
  // before resuming, and index.ts spawns through 'snapshot-failed' — with an
  // invalidated override + valid pointer the spawn-time resolution throws →
  // permanent crash loop even after the snapshot cause clears. The stale
  // markers must be superseded so the next boot retries and heals.
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-intent-snapshot-fail-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    writeDshHome(stateDir, '{"source":"v1"}')
    writeCurrentPointer(stateDir, '1.0.0')
    writeActivationIntent(stateDir, {
      targetVersion: TEST_BUILTIN_VERSION,
      targetIsBuiltin: true,
      manualRollback: false,
      intentKind: 'shell-invalidation',
    })
    writeF4Override(stateDir, { swapAttempted: true, lastOutcome: 'snapshot-failed', lastError: 'snapshot kept failing while the cause (disk/DSH_HOME) was present' })
    const manager = runtimeManager(stateDir, fakePlane(), { probeCandidate: derivedProbe(stateDir) })
    try {
      const startup = await manager.startupTransaction()
      assert.deepEqual(startup, { blockedReason: null }, 'stale markers must not block the journaled resume')
      assertBuiltinWorkspace(manager, stateDir)
      assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'missing' })
      assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'intent journal consumed')
      const record = readOverrideRow(stateDir)
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