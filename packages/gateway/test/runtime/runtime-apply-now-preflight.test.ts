/**
 * /chamber/runtime apply-now preflight and route matrix: terminal pending gates,
 * synchronous 409 refusals and the applyNowInFlight mutation fence.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayRuntimeManager } from '../../src/runtime-manager.ts'
import {
  readActivationJournalState,
  readCurrentPointerState,
  writeCurrentPointer,
} from '@dsh-chamber/dsh-runtime'
import { createRuntimeRoutes } from '../../src/runtime-routes.ts'
import {
  silentLogger,
  TEST_BUILTIN_VERSION,
  config,
  fakePlane,
  runRoute,
  waitForSettle,
  probeResultsFor,
  makeValidTree,
  armPendingSwitch,
  readOverrideRow,
  writeOverrideRow,
  writeVersionSwitchIntent,
  runtimeManager,
  derivedProbe,
} from '../support/runtime-routes-harness.ts'

test('ordinary pending is a core+route terminal gate: apply-now is allowed (202, pending untouched), every other action is 409 and non-mutating', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-pending-gate-'))
  try {
    armPendingSwitch(stateDir, '1.0.0')
    // The apply-now transaction must not race the assertions below: hold the
    // quiesce step until the durable pending/override are verified untouched.
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const plane = fakePlane({ stopLocal: async () => { await stopGate } })
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane, { probeCandidate: derivedProbe(stateDir) })
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
      assert.equal(readOverrideRow(stateDir)?.pending, '1.0.0', `${suffix} must not clear or rewrite pending`)
    }

    // apply-now is pending's own semantic premise (design 18 addendum §5.1):
    // allowed with 202, and the durable pending/override stay untouched while
    // the async transaction is held at the quiesce step.
    const now = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(now.status, 202)
    assert.equal((now.json as { accepted: boolean }).accepted, true)
    assert.equal((now.json as { version: string }).version, '1.0.0', 'the 202 body carries the preflighted target')
    assert.equal(readOverrideRow(stateDir)?.pending, '1.0.0', 'the 202 answer must not clear or rewrite pending')
    assert.equal(readOverrideRow(stateDir)?.chosenVersion, '1.0.0')
    assert.equal(readActivationJournalState(stateDir).kind, 'valid', 'the armed intent journal is preserved')
    assert.equal(manager.applyNowInFlight(), true, 'the apply-now job is in flight')
    assert.equal((await manager.status()).phase, 'applying', 'the 202 window polls as applying')
    releaseStop()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.equal((await manager.status()).phase, 'idle')
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'valid', version: '1.0.0' }, 'apply-now committed the armed switch')

    const restored = await runRoute(routes, 'POST', '/chamber/runtime/restore-builtin')
    assert.equal(restored.status, 200, 'restore-builtin remains the recovery escape after apply-now')
    assert.equal(readOverrideRow(stateDir), null)
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
    // The route relies on THIS for the no_selection gate: a status-based
    // precheck would mis-let an invalidated selection through (R3/R5).
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
  // applies to pending/healthy selections only).
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
    // status.pending is null (effectivePending filters the invalidation).
    writeOverrideRow(stateDir, { shellVersion: '0.0.1', chosenVersion: '2.0.0', pending: null })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane)
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const status = await manager.status()
    assert.equal(status.selectedVersion, '2.0.0', 'the invalidated record retains its choice')
    assert.equal(status.pending, null, 'effective pending filters the invalidation')
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 409)
    assert.equal((response.json as { code: string }).code, 'no_selection')
    assert.equal(manager.applyNowInFlight(), false, 'a refused apply-now must not arm in-flight state')
    assert.equal(readOverrideRow(stateDir)?.pending, null, 'no pending switch is armed')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'no journal is written')
    await assert.rejects(manager.applyNow(), (error: unknown) =>
      (error as { code?: string }).code === 'no_selection', 'the direct manager call refuses identically')
    assert.equal(manager.applyNowInFlight(), false)
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'missing' }, 'no transaction was armed')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now preflight refuses a pending target with no valid version tree synchronously — 409 invalid_target, no 202', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-notree-'))
  try {
    // pending points at a version whose tree is gone (e.g. evicted). The
    // preflight must refuse before any 202 can go out.
    writeVersionSwitchIntent(stateDir, '3.0.0')
    writeOverrideRow(stateDir, { chosenVersion: '3.0.0', pending: '3.0.0' })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane)
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
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null, lastOutcome: 'applied' })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane)
    const routes = createRuntimeRoutes(() => manager, silentLogger)
    const response = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(response.status, 409)
    assert.equal((response.json as { code: string }).code, 'noop_target')
    assert.equal((response.json as { error: string }).error, 'dsh v1.0.0 is already the active runtime; apply-now has nothing to do')
    assert.equal(manager.applyNowInFlight(), false, 'a no-op rejection arms nothing')
    assert.equal(readOverrideRow(stateDir)?.pending, null, 'no pending switch is armed')
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
    armPendingSwitch(stateDir, '1.0.0')
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const plane = fakePlane({ stopLocal: async () => { await stopGate } })
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane, { probeCandidate: derivedProbe(stateDir) })
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
    // applyNowInFlight feeds assertMutationIdle directly — the fence does not
    // depend on activationDepth's timing coincidence (R3/R5).
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
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'valid', version: '1.0.0' }, 'the fenced window still committed its own switch')
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
    // downgrade as a manual rollback, exactly like apply().
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null, lastOutcome: 'applied' })
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const plane = fakePlane({ stopLocal: async () => { await stopGate } })
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane, { probeCandidate: derivedProbe(stateDir) })
    const accepted = await manager.applyNow()
    assert.equal(accepted.accepted, true)
    const armed = readOverrideRow(stateDir)
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
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'valid', version: '1.0.0' }, 'the downgrade switch committed')
    assert.equal((await manager.status()).activeVersion, '1.0.0')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('apply-now 202: the window polls as applying with connectionState stopped, then the switch commits', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-window-'))
  try {
    armPendingSwitch(stateDir, '1.0.0')
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const plane = fakePlane({
      stopLocal: async () => { plane._state.connectionState = 'stopped'; await stopGate },
      startLocal: async () => { plane._state.connectionState = 'ready' },
    })
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane, { probeCandidate: derivedProbe(stateDir) })
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
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'valid', version: '1.0.0' }, 'the apply-now transaction committed the switch')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restoreBuiltin runs the full shared activation transaction before deleting override metadata', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restore-journal-'))
  try {
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '2.0.0')
    writeOverrideRow(stateDir, { chosenVersion: '2.0.0', pending: null, lastOutcome: 'applied' })
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
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'missing' }, 'the pointer clears only inside the activation transaction')
    assert.equal(readOverrideRow(stateDir), null, 'override is deleted only after the builtin probe passes')
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
    writeOverrideRow(stateDir, { chosenVersion: '2.0.0', pending: null, lastOutcome: 'applied' })
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
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'valid', version: '2.0.0' })
    assert.equal(readOverrideRow(stateDir)?.resolvedVersion, '2.0.0', 'failed reset never deletes the recoverable override')
    assert.equal(readOverrideRow(stateDir)?.lastOutcome, 'rolled-back')
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"preserved"}')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})