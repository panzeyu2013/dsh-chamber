/**
 * runtime-startup.ts tests (design 18 §9.1 startup phase) — driven through the
 * canonical RunPhaseFixture (test/support/run-phase-fixture.ts + test/support/fake-adapter.ts),
 * the same fixture apply-now.test.ts uses; there is no second hand-rolled
 * StartupDeps mock. Per-test deviations (cleanup/evict results, corrupt
 * metadata reads, env-override probes, recording wrappers) are applied as
 * post-hoc overrides on `fixture.makeStartupDeps()`.
 *
 * This file keeps the startup-specific surface:
 * cleanup/eviction ordering, interrupted-restore blocking, swap-attempted /
 * old-shell / env-override deferrals, corrupt-metadata routes, applied-
 * monitoring commit paths, rollback evidence and intent preservation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runDelayedRollback,
  runStartupPhase,
  shouldProbeEnvWithDormantCorruptSelection,
} from '../../src/runtime-startup.ts'
import { activationProbeNamesForDomains, REQUIRED_ACTIVATION_PROBES, type ProbeResult } from '../../src/activation-gate.ts'
import { journalBuilder } from '../support/store-fixtures.ts'
import type { ActivationJournal, OverrideRecord } from '../../src/dsh-runtime-store.ts'
import { RunPhaseFixture, type RunPhaseEvent } from '../support/run-phase-fixture.ts'

const record = (pending: string | null): OverrideRecord => ({
  shellVersion: '0.1.4', chosenVersion: pending, resolvedVersion: pending,
  pending, swapAttempted: false,
})
/** makeStartupDeps with deleteOverride instrumented: reports how often the
 *  re-arm cleared the durable override. */
function countingStartupDeps(fixture: RunPhaseFixture): { deps: ReturnType<RunPhaseFixture['makeStartupDeps']>; deleted: () => number } {
  let deleted = 0
  const deps = fixture.makeStartupDeps()
  const clear = deps.deleteOverride
  deps.deleteOverride = () => { deleted += 1; clear() }
  return { deps, deleted: () => deleted }
}

const pass = (): ProbeResult[] => REQUIRED_ACTIVATION_PROBES.map(name => ({ name, ok: true }))
const fail = (): ProbeResult[] => pass().map(item => item.name === 'session/canOpenWorkspacePath' ? { ...item, ok: false } : item)

const journal = journalBuilder({
  targetVersion: '0.2.0',
  sourceVersion: '0.1.0',
  knownGoodVersion: '0.1.0',
  preSwapSnapshotName: '0.1.0-pre-swap',
})

function intent(
  targetVersion = '0.2.0',
  targetIsBuiltin = false,
  intentKind: ActivationJournal['intentKind'] = targetIsBuiltin ? 'reset-builtin' : 'version-switch',
): ActivationJournal {
  return journal('intent', {
    targetVersion,
    targetIsBuiltin,
    intentKind,
    sourceVersion: null,
    sourceIsBuiltin: null,
    sourceWasKnownGood: null,
    knownGoodVersion: null,
    preSwapSnapshotName: null,
  })
}

function switchVersions(fixture: RunPhaseFixture): Array<string | null> {
  return fixture.events
    .filter((e): e is Extract<RunPhaseEvent, { kind: 'switch' }> => e.kind === 'switch')
    .map(e => e.version)
}

function probeEvents(fixture: RunPhaseFixture): Array<[string, boolean]> {
  return fixture.events
    .filter((e): e is Extract<RunPhaseEvent, { kind: 'probe' }> => e.kind === 'probe')
    .map(e => [e.version, e.isBuiltin])
}

test('no pending still completes cleanup/eviction/recovery', async () => {
  const fixture = new RunPhaseFixture()
  const deps = fixture.makeStartupDeps()
  deps.cleanupStaleInstalls = () => ['.work-a']
  deps.evict = () => ['0.0.9']
  const result = await runStartupPhase(deps)
  assert.equal(result.applyOutcome, null)
  assert.deepEqual(result.cleanedWorkDirs, ['.work-a'])
  assert.deepEqual(result.evicted, ['0.0.9'])
})

test('interrupted restore failure blocks every activation/spawn', async () => {
  const fixture = new RunPhaseFixture({ override: record('0.2.0') })
  const deps = fixture.makeStartupDeps()
  deps.completeInterruptedRestore = async () => 'half'
  let spawned = false
  deps.spawnAndProbe = async () => { spawned = true; return pass() }
  const result = await runStartupPhase(deps)
  assert.equal(result.blockedReason, 'restore-half')
  assert.equal(spawned, false)
})

test('pending activation uses real source/known-good facts and clears pending atomically', async () => {
  const fixture = new RunPhaseFixture({ override: record('0.2.0') })
  const result = await runStartupPhase(fixture.makeStartupDeps())
  assert.equal(result.applyOutcome?.status, 'applied')
  const snapshot = fixture.events.find(e => e.kind === 'snapshot')
  assert.equal(snapshot?.version, '0.1.0')
  assert.equal(fixture.currentState().override?.pending, null)
  assert.equal(fixture.currentState().override?.lastOutcome, 'applied')
})

test('P0: cold-start pending derives the expected set after the spawn refreshes the seed table', async () => {
  // Desktop cold-start model: `seededProbeDomains` starts empty and is written
  // only by the spawn thunk inside `spawnAndProbe`. The expectation must be a
  // lazy read taken after that run; an eagerly captured value would freeze the
  // empty table and roll back a healthy activation.
  const fixture = new RunPhaseFixture({ override: record('0.2.0'), pointer: '0.1.0' })
  const deps = fixture.makeStartupDeps()
  const partialSeed = ['clientGraph/graph', 'archiveCleanup/probe'] as const
  let seededDomains: readonly string[] = []
  const order: string[] = []
  deps.spawnAndProbe = async () => {
    order.push('probe')
    seededDomains = [...partialSeed]
    return activationProbeNamesForDomains(seededDomains).map(name => ({ name, ok: true }))
  }
  deps.probeExpectedNames = () => {
    order.push('expected')
    return activationProbeNamesForDomains(seededDomains)
  }
  const result = await runStartupPhase(deps)
  assert.equal(result.applyOutcome?.status, 'applied')
  assert.equal(result.blockedReason, null)
  // Partial seed = base four + the two mounted chamber domains, not the
  // 4-name reduced set and not the full host-domain set (both other chambers'
  // domains are absent, so REQUIRED minus those two).
  assert.deepEqual(order, ['probe', 'expected'])
  assert.equal(activationProbeNamesForDomains(seededDomains).length, REQUIRED_ACTIVATION_PROBES.length - 2)
})

test('probe failure stops, restores, rolls pointer back, and persists failure evidence', async () => {
  const fixture = new RunPhaseFixture({ override: record('0.2.0'), pointer: '0.1.0' })
  let probes = 0
  fixture.setProbe(async () => { probes += 1; return probes >= 3 ? pass() : fail() })
  const result = await runStartupPhase(fixture.makeStartupDeps())
  assert.equal(result.applyOutcome?.status, 'rolled-back')
  const order = fixture.events.filter(e => e.kind !== 'probe')
  assert.deepEqual(order.map(e => e.kind), ['snapshot', 'switch', 'stop', 'switch', 'restore'])
  assert.deepEqual(switchVersions(fixture), ['0.2.0', '0.1.0'])
  assert.equal(fixture.currentState().override?.pending, null)
  assert.equal(fixture.failureRecords[0]?.phase, 'rolled-back')
})

test('swap-attempted is not replayed automatically', async () => {
  const fixture = new RunPhaseFixture({ override: { ...record('0.2.0'), swapAttempted: true } })
  let spawned = false
  const deps = fixture.makeStartupDeps()
  deps.spawnAndProbe = async () => { spawned = true; return pass() }
  const result = await runStartupPhase(deps)
  assert.equal(result.blockedReason, 'swap-attempted')
  assert.equal(spawned, false)
})

test('applied-monitoring + matching pending completes only the override verdict commit', async () => {
  const fixture = new RunPhaseFixture({
    override: record('0.2.0'),
    pointer: '0.2.0',
    journal: { kind: 'valid', journal: journal('applied-monitoring') },
  })
  const result = await runStartupPhase(fixture.makeStartupDeps())
  assert.equal(result.applyOutcome, null)
  assert.equal(fixture.currentState().override?.pending, null)
  assert.equal(fixture.currentState().override?.lastOutcome, 'applied')
  const durable = fixture.currentState().journal
  assert.equal(durable.kind, 'valid')
  if (durable.kind === 'valid') {
    assert.equal(durable.journal.phase, 'applied-monitoring')
    assert.equal(durable.journal.preSwapSnapshotName, '0.1.0-pre-swap')
  }
  assert.deepEqual({ snapshots: fixture.snapshotCalls, switches: fixture.switchCalls, probes: probeEvents(fixture).length }, { snapshots: 0, switches: 0, probes: 0 })
})

test('builtin applied-monitoring crash commit distinguishes reset from shell invalidation', async () => {
  for (const kind of ['reset-builtin', 'shell-invalidation'] as const) {
    const fixture = new RunPhaseFixture({
      override: {
        shellVersion: '0.1.3', chosenVersion: '0.2.0', resolvedVersion: '0.2.0',
        pending: null, swapAttempted: false,
      },
      pointer: null,
      journal: {
        kind: 'valid',
        journal: journal('applied-monitoring', {
          targetVersion: '0.1.1-rc.2',
          targetIsBuiltin: true,
          intentKind: kind,
        }),
      },
    })
    const { deps, deleted } = countingStartupDeps(fixture)
    const result = await runStartupPhase(deps)
    assert.equal(result.blockedReason, null)
    assert.equal(fixture.snapshotCalls, 0)
    assert.equal(fixture.switchCalls, 0)
    assert.equal(probeEvents(fixture).length, 0)
    assert.equal(fixture.currentState().journal.kind, 'missing')
    if (kind === 'reset-builtin') {
      assert.equal(deleted(), 1)
      assert.equal(fixture.currentState().override, null)
    } else {
      assert.equal(deleted(), 0)
      const stored = fixture.currentState().override
      assert.equal(stored?.invalidatedReason, 'shell-version-changed')
      assert.ok(stored?.invalidatedAt)
      assert.equal(stored?.chosenVersion, '0.2.0')
    }
  }
})

test('in-flight journal refuses an unrelated persisted pending before any side effect', async () => {
  const fixture = new RunPhaseFixture({
    override: record('0.3.0'),
    journal: { kind: 'valid', journal: journal('prepared') },
  })
  const result = await runStartupPhase(fixture.makeStartupDeps())
  assert.equal(result.blockedReason, 'journal-mismatch')
  assert.equal(fixture.snapshotCalls, 0)
  assert.equal(fixture.switchCalls, 0)
  assert.equal(probeEvents(fixture).length, 0)
})

test('restore completion resumes fallback probe and never replays the adjudicated bad target', async () => {
  const fixture = new RunPhaseFixture({
    override: record('0.2.0'),
    pointer: '0.1.0',
    journal: { kind: 'valid', journal: journal('restoring', { rollbackTarget: '0.1.0' }) },
  })
  const deps = fixture.makeStartupDeps()
  deps.completeInterruptedRestore = async () => 'complete'
  const probed: Array<[string, boolean]> = []
  deps.spawnAndProbe = async (version, isBuiltin) => { probed.push([version, isBuiltin]); return pass() }
  const result = await runStartupPhase(deps)
  assert.equal(result.applyOutcome?.status, 'rolled-back')
  assert.equal(fixture.currentState().override?.pending, null)
  assert.deepEqual(probed, [['0.1.0', false]])
  assert.equal(fixture.snapshotCalls, 0)
  assert.equal(fixture.switchCalls, 0)
  assert.equal(fixture.currentState().journal.kind, 'missing')
})

test('intent commit gaps are discarded without erasing applied-monitoring context', async () => {
  const orphanFixture = new RunPhaseFixture({
    override: record(null),
    journal: { kind: 'valid', journal: intent() },
  })
  const orphanDeps = orphanFixture.makeStartupDeps()
  let clearCount = 0
  const clear = orphanDeps.clearActivationJournal
  orphanDeps.clearActivationJournal = () => { clearCount += 1; clear() }
  const orphan = await runStartupPhase(orphanDeps)
  assert.equal(orphan.blockedReason, null)
  assert.equal(clearCount, 1)

  const monitoring = journal('applied-monitoring', {
    nextIntent: { targetVersion: '0.3.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch' },
  })
  const queuedFixture = new RunPhaseFixture({
    override: record(null),
    pointer: '0.2.0',
    journal: { kind: 'valid', journal: monitoring },
  })
  const queuedGap = await runStartupPhase(queuedFixture.makeStartupDeps())
  assert.equal(queuedGap.blockedReason, null)
  const durable = queuedFixture.currentState().journal
  assert.equal(durable.kind, 'valid')
  if (durable.kind === 'valid') {
    assert.equal(durable.journal.phase, 'applied-monitoring')
    assert.equal(durable.journal.nextIntent, null)
    assert.equal(durable.journal.preSwapSnapshotName, '0.1.0-pre-swap')
  }
})

test('old-shell pending and env override are both deferred without side effects', async () => {
  const oldShellFixture = new RunPhaseFixture({
    override: { ...record('0.2.0'), shellVersion: '0.1.3' },
  })
  const invalid = await runStartupPhase(oldShellFixture.makeStartupDeps())
  assert.equal(invalid.applyOutcome, null)
  assert.equal(oldShellFixture.currentState().override?.pending, '0.2.0')
  assert.equal(oldShellFixture.snapshotCalls, 0)
  assert.equal(oldShellFixture.switchCalls, 0)
  assert.equal(probeEvents(oldShellFixture).length, 0)

  const staleFixture = new RunPhaseFixture({
    override: { ...record('0.2.0'), shellVersion: '0.1.3' },
    journal: { kind: 'valid', journal: journal('prepared') },
  })
  const stalePrepared = await runStartupPhase(staleFixture.makeStartupDeps())
  assert.equal(stalePrepared.blockedReason, 'journal-mismatch')
  assert.equal(staleFixture.snapshotCalls, 0)
  assert.equal(staleFixture.switchCalls, 0)
  assert.equal(probeEvents(staleFixture).length, 0)

  const envFixture = new RunPhaseFixture({ override: record('0.2.0') })
  const envDeps = envFixture.makeStartupDeps()
  envDeps.envOverrideActive = () => true
  const env = await runStartupPhase(envDeps)
  assert.equal(env.blockedReason, 'env-override')
  assert.equal(envFixture.currentState().override?.pending, '0.2.0')
  assert.equal(envFixture.snapshotCalls, 0)
  assert.equal(envFixture.switchCalls, 0)
  assert.equal(probeEvents(envFixture).length, 0)
})

test('corrupt current or override metadata blocks cleanup, eviction, and builtin spawn', async () => {
  for (const [expected, mutate] of [
    ['current-corrupt', (deps: ReturnType<RunPhaseFixture['makeStartupDeps']>) => { deps.readCurrentPointerState = () => ({ kind: 'corrupt' as const }) }],
    ['override-corrupt', (deps: ReturnType<RunPhaseFixture['makeStartupDeps']>) => { deps.readOverrideState = () => ({ kind: 'corrupt' as const }) }],
  ] as const) {
    const fixture = new RunPhaseFixture()
    const deps = fixture.makeStartupDeps()
    mutate(deps)
    let touched = 0
    deps.cleanupStaleInstalls = () => { touched += 1; return [] }
    deps.evict = () => { touched += 1; return [] }
    deps.spawnAndProbe = async () => { touched += 1; return pass() }
    const result = await runStartupPhase(deps)
    assert.equal(result.blockedReason, expected)
    assert.equal(touched, 0)
  }
})

test('corrupt selection metadata still completes an authoritative restore before blocking', async () => {
  const fixture = new RunPhaseFixture()
  const deps = fixture.makeStartupDeps()
  const order: string[] = []
  deps.readOverrideState = () => ({ kind: 'corrupt' })
  deps.completeInterruptedRestore = async () => { order.push('restore'); return 'complete' }
  deps.cleanupStaleInstalls = () => { order.push('cleanup'); return [] }
  deps.evict = () => { order.push('evict'); return [] }
  deps.spawnAndProbe = async () => { order.push('spawn'); return pass() }
  const result = await runStartupPhase(deps)
  assert.equal(result.restored, 'complete')
  assert.equal(result.blockedReason, 'override-corrupt')
  assert.deepEqual(order, ['restore'])
})

test('env override remains authoritative after restore even when dormant chamber metadata is corrupt', async () => {
  const fixture = new RunPhaseFixture()
  const deps = fixture.makeStartupDeps()
  let restored = 0
  let spawned = 0
  deps.envOverrideActive = () => true
  deps.readCurrentPointerState = () => ({ kind: 'corrupt' })
  deps.completeInterruptedRestore = async () => { restored += 1; return 'complete' }
  deps.spawnAndProbe = async () => { spawned += 1; return pass() }
  const result = await runStartupPhase(deps)
  assert.equal(restored, 1)
  assert.equal(result.blockedReason, 'env-override')
  assert.equal(spawned, 0)
})

test('production metadata route probes env only for dormant selection corruption', () => {
  assert.equal(shouldProbeEnvWithDormantCorruptSelection('selection-corrupt', true), true)
  assert.equal(shouldProbeEnvWithDormantCorruptSelection('selection-corrupt', false), false)
  assert.equal(shouldProbeEnvWithDormantCorruptSelection('recovery-in-progress', true), false)
  assert.equal(shouldProbeEnvWithDormantCorruptSelection('recovery-marker-corrupt', true), false)
})

test('F4 builtin activation snapshots the old override and restores it when builtin probe fails', async () => {
  const fixture = new RunPhaseFixture({
    override: {
      shellVersion: '0.1.3', chosenVersion: '0.2.0', resolvedVersion: '0.2.0', pending: null,
      swapAttempted: false, invalidatedAt: '2026-08-23T00:00:00.000Z', invalidatedReason: 'shell-version-changed',
    },
    pointer: '0.2.0',
    journal: { kind: 'valid', journal: intent('0.1.1-rc.2', true, 'shell-invalidation') },
  })
  const deps = fixture.makeStartupDeps()
  deps.activationFacts = () => ({ sourceVersion: '0.2.0', sourceIsBuiltin: false, sourceWasKnownGood: true, knownGoodVersion: '0.2.0' })
  let probeCalls = 0
  fixture.setProbe(async () => { probeCalls += 1; return probeCalls < 3 ? fail() : pass() })
  const result = await runStartupPhase(deps)
  assert.equal(result.applyOutcome?.status, 'rolled-back')
  const snapshot = fixture.events.find(e => e.kind === 'snapshot')
  assert.equal(snapshot?.version, '0.2.0')
  assert.deepEqual(switchVersions(fixture), [null, '0.2.0'])
  assert.deepEqual(probeEvents(fixture), [
    ['0.1.1-rc.2', true],
    ['0.1.1-rc.2', true],
    ['0.2.0', false],
  ])
  const stored = fixture.currentState().override
  assert.equal(stored?.shellVersion, '0.1.4')
  assert.equal(stored?.invalidatedAt, null)
  assert.equal(stored?.lastInvalidatedAt, '2026-08-23T00:00:00.000Z')
  assert.equal(stored?.lastInvalidatedReason, 'shell-version-changed')
  assert.equal(stored?.lastInvalidatedFromVersion, '0.2.0')
  assert.equal(stored?.lastInvalidationRecovered, true)
  assert.equal(stored?.chosenVersion, '0.2.0')
  assert.equal(fixture.currentState().journal.kind, 'missing')
})

test('reset-builtin applies transactionally and deletes override only after builtin probe passes', async () => {
  const fixture = new RunPhaseFixture({
    override: {
      shellVersion: '0.1.4', chosenVersion: '0.2.0', resolvedVersion: '0.2.0',
      pending: null, swapAttempted: false,
    },
    pointer: '0.2.0',
    journal: { kind: 'valid', journal: intent('0.1.1-rc.2', true, 'reset-builtin') },
  })
  const { deps, deleted } = countingStartupDeps(fixture)
  deps.activationFacts = () => ({ sourceVersion: '0.2.0', sourceIsBuiltin: false, sourceWasKnownGood: true, knownGoodVersion: '0.2.0' })
  const result = await runStartupPhase(deps)
  assert.equal(result.applyOutcome?.status, 'applied')
  assert.equal(fixture.currentState().pointer, null)
  assert.deepEqual(probeEvents(fixture), [['0.1.1-rc.2', true]])
  assert.equal(deleted(), 1)
  assert.equal(fixture.currentState().override, null)
  assert.equal(fixture.currentState().journal.kind, 'missing')
})

test('reset-builtin supersedes and clears an existing pending selection transactionally', async () => {
  const fixture = new RunPhaseFixture({
    override: {
      shellVersion: '0.1.4', chosenVersion: '0.2.0', resolvedVersion: '0.2.0',
      pending: '0.3.0', swapAttempted: false,
    },
    pointer: '0.2.0',
    journal: { kind: 'valid', journal: intent('0.1.1-rc.2', true, 'reset-builtin') },
  })
  const { deps, deleted } = countingStartupDeps(fixture)
  deps.activationFacts = () => ({ sourceVersion: '0.2.0', sourceIsBuiltin: false, sourceWasKnownGood: true, knownGoodVersion: '0.2.0' })
  const result = await runStartupPhase(deps)
  assert.equal(result.applyOutcome?.status, 'applied')
  assert.equal(fixture.snapshotCalls, 1)
  assert.equal(fixture.currentState().pointer, null)
  assert.equal(deleted(), 1)
  assert.equal(fixture.currentState().override, null)
  assert.equal(fixture.currentState().journal.kind, 'missing')
})

test('F7 persists rollback-needed before effects and preserves a concurrently queued selection', async () => {
  const callerCopy = journal('applied-monitoring')
  const fixture = new RunPhaseFixture({
    override: record('0.3.0'),
    pointer: '0.2.0',
    journal: {
      kind: 'valid',
      journal: journal('applied-monitoring', {
        nextIntent: { targetVersion: '0.3.0', targetIsBuiltin: false, manualRollback: true, intentKind: 'version-switch' },
      }),
    },
  })
  const deps = fixture.makeStartupDeps()
  deps.clearActivationJournal = () => { throw new Error('queued intent must survive') }
  const outcome = await runDelayedRollback(deps, callerCopy)
  assert.equal(outcome.status, 'rolled-back')
  const firstWrite = fixture.journalWrites[0]
  assert.equal(firstWrite?.phase, 'rollback-needed')
  assert.equal(firstWrite?.nextIntent?.targetVersion, '0.3.0')
  const restoringAt = fixture.journalWrites.findIndex(j => j.phase === 'restoring')
  const restoreAt = fixture.events.findIndex(e => e.kind === 'restore')
  assert.ok(restoringAt !== -1 && restoringAt < restoreAt, 'restoring journal precedes the data restore')
  assert.deepEqual(fixture.events.filter(e => e.kind !== 'probe').map(e => e.kind), ['stop', 'switch', 'restore'])
  assert.ok(probeEvents(fixture).some(([version, isBuiltin]) => version === '0.1.0' && isBuiltin === false))
  const durable = fixture.currentState().journal
  assert.equal(durable.kind, 'valid')
  if (durable.kind === 'valid') {
    assert.equal(durable.journal.phase, 'intent')
    assert.equal(durable.journal.targetVersion, '0.3.0')
    assert.equal(durable.journal.manualRollback, true)
  }
  assert.equal(fixture.currentState().override?.pending, '0.3.0')
})
