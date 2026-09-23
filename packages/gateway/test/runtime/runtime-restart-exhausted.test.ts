/**
 * /chamber/runtime restart-exhausted (F7) and the known-good window: 24h
 * promotion, quarantine edges, the rollback latch and lease-gated deferral.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Logger } from '@dsh-chamber/control-plane'
import { createGatewayRuntimeManager } from '../../src/runtime-manager.ts'
import {
  listKnownGoodVersions,
  readActivationJournalState,
  readCurrentPointer,
  readOverride,
  recordProbePass,
  writeActivationJournal,
  writeCurrentPointer,
  type ActivationJournal,
} from '@dsh-chamber/dsh-runtime'
import {
  silentLogger,
  config,
  fakePlane,
  waitForSettle,
  waitForMutationSettle,
  probeResultsFor,
  makeValidTree,
  armAppliedCandidate,
  writeOverrideRow,
  writeVersionSwitchIntent,
  runtimeManager,
  derivedProbe,
} from '../support/runtime-routes-harness.ts'

test('manager.status() projects the live plane connectionState (ready/restarting/stopped)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-live-conn-'))
  try {
    const plane = fakePlane()
    const manager = runtimeManager(stateDir, plane)
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
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null, lastOutcome: 'applied' })
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
    writeVersionSwitchIntent(stateDir, '1.0.0')
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: '1.0.0' })
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
    const home = armAppliedCandidate(stateDir)

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
    const manager = runtimeManager(stateDir, plane, { probeCandidate: derivedProbe(stateDir),
      waitBeforeRetry: async () => {}, scheduleKnownGoodPromotion: () => () => {},
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
    armAppliedCandidate(stateDir)

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
    writeOverrideRow(stateDir, { chosenVersion: '2.0.0', pending: null, lastOutcome: 'applied' })
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
    const home = armAppliedCandidate(stateDir)

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
    const manager = runtimeManager(stateDir, plane, { probeCandidate: derivedProbe(stateDir),
      waitBeforeRetry: async () => {}, scheduleKnownGoodPromotion: () => () => {},
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
    const ownerPath = join(stateDir, 'owner.json') // the state-root writer lease
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
    const home = armAppliedCandidate(stateDir)

    let phase: 'initial-apply' | 'f7' | 'cleanup' = 'initial-apply'
    let f7Stops = 0
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    plane.stopLocal = async () => {
      if (phase === 'f7') f7Stops += 1
      plane._state.connectionState = 'stopped'
    }
    plane.startLocal = async () => { plane._state.connectionState = 'ready' }
    const manager = runtimeManager(stateDir, plane, { probeCandidate: derivedProbe(stateDir),
      waitBeforeRetry: async () => {}, scheduleKnownGoodPromotion: () => () => {},
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
    const home = armAppliedCandidate(stateDir)

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
