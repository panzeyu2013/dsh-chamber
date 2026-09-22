/**
 * /chamber/runtime apply-now recovery: journal-first arming, snapshot/recovery
 * failure paths, env-override parity and restore-builtin durable guards. Split
 * from runtime-routes.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayRuntimeManager } from '../../src/runtime-manager.ts'
import {
  readActivationJournalState,
  readCurrentPointerState,
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
  waitForSettle,
  probeResultsFor,
  makeValidTree,
  armPendingSwitch,
  readOverrideRow,
  writeOverrideRow,
  runtimeManager,
} from '../support/runtime-routes-harness.ts'

test('applyNow with only a staged selection (selectedOnly, no pending) arms the pending switch journal-first (F2)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-f2-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null, selectedOnly: true })
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
    const armed = readOverrideRow(stateDir)
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
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'valid', version: '1.0.0' }, 'the armed switch committed')
    assert.ok(order.indexOf('stop') < order.indexOf('probe'), 'host quiesced before the transaction')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('applyNow snapshot failure stays snapshot-failed, resumes the untouched source, and projects operationError (F3)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-snapfail-'))
  try {
    armPendingSwitch(stateDir, '1.0.0')
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
    const manager = runtimeManager(stateDir, plane)
    const accepted = await manager.applyNow()
    assert.equal(accepted.accepted, true)
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    const status = await manager.status()
    assert.equal(status.phase, 'snapshot-failed', 'the terminal snapshot-failed phase is projected')
    assert.equal(status.startupBlockedReason, 'snapshot-failed')
    assert.equal(typeof status.operationError, 'string', 'F3: the 202 job failure projects into status, not only the log')
    assert.notEqual(status.operationError, '')
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'missing' }, 'a failed snapshot never touches the pointer')
    assert.equal(readOverrideRow(stateDir)?.pending, '1.0.0', 'snapshot-failed retains the pending switch for retry-apply')
    assert.equal(readOverrideRow(stateDir)?.lastOutcome, 'snapshot-failed')
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
    armPendingSwitch(stateDir, '1.0.0')
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
    armPendingSwitch(stateDir, '1.0.0')
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
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null, lastOutcome: 'applied' })
    writeFileSync(join(stateDir, 'dsh-runtime', 'activation-journal.json'), '{broken-json', { mode: 0o600 })
    const stops: string[] = []
    const plane = fakePlane({ stopLocal: async () => { stops.push('stop') } })
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane)
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
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null, lastOutcome: 'applied' })
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
    const manager = runtimeManager(stateDir, plane)
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 409)
    assert.equal((response.json as { code: string }).code, 'noop_target')
    assert.equal((response.json as { error: string }).error,
      'dsh v1.0.0 is already the active runtime; apply-now has nothing to do')
    assert.equal(manager.applyNowInFlight(), false, 'a no-op rejection arms nothing')
    assert.deepEqual(stops, [], 'no stop/start cycle on the already-active version')
    assert.equal(readOverrideRow(stateDir)?.pending, null, 'no pending switch is armed')
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
    armPendingSwitch(stateDir, '1.0.0')
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
    const manager = runtimeManager(stateDir, plane)
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
    armPendingSwitch(stateDir, '1.0.0')
    const stops: string[] = []
    // Default fake plane connectionState is 'stopped' — the managed dsh never
    // reached ready, so apply-now cannot switch it in-session (route mirror).
    const plane = fakePlane({ stopLocal: async () => { stops.push('stop') } })
    const manager = runtimeManager(stateDir, plane)
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
    writeOverrideRow(stateDir, { chosenVersion: '2.0.0', resolvedVersion: '1.0.0', pending: '2.0.0', lastOutcome: 'applied' })
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
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'valid', version: '1.0.0' })
    assert.equal(readOverrideRow(stateDir)?.lastOutcome, 'rolled-back')
    assert.equal(readOverrideRow(stateDir)?.pending, null, 'a rolled-back transaction clears the pending switch')
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
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null, swapAttempted: true })
    const swapManager = makeManager()
    await assert.rejects(swapManager.restoreBuiltin(), {
      code: 'runtime_recovery_required',
      message: /swap-attempted/,
    })
    assert.deepEqual(stops, [], 'a refused reset never stops the managed dsh')
    assert.equal(readOverrideRow(stateDir)?.swapAttempted, true, 'the durable marker is untouched by a refused reset')
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
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null })
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