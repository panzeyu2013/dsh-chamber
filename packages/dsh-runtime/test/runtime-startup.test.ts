import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeKoffiLoadable,
  runDelayedRollback,
  runStartupPhase,
  shouldProbeEnvWithDormantCorruptSelection,
  type StartupDeps,
} from '../src/runtime-startup.ts'
import { REQUIRED_ACTIVATION_PROBES, type ProbeResult } from '../src/activation-gate.ts'
import type { ActivationJournal, OverrideRecord } from '../src/dsh-runtime-store.ts'
import type { ActivationJournalState } from '../src/dsh-runtime-store.ts'

const record = (pending: string | null): OverrideRecord => ({
  shellVersion: '0.1.4', chosenVersion: pending, resolvedVersion: pending,
  pending, swapAttempted: false,
})
const pass = (): ProbeResult[] => REQUIRED_ACTIVATION_PROBES.map(name => ({ name, ok: true }))
const fail = (): ProbeResult[] => pass().map(item => item.name === 'host.describe' ? { ...item, ok: false } : item)

function journal(
  phase: ActivationJournal['phase'],
  patch: Partial<ActivationJournal> = {},
): ActivationJournal {
  return {
    schemaVersion: 1,
    phase,
    targetVersion: '0.2.0',
    targetIsBuiltin: false,
    manualRollback: false,
    intentKind: 'version-switch',
    sourceVersion: '0.1.0',
    sourceIsBuiltin: false,
    sourceWasKnownGood: true,
    knownGoodVersion: '0.1.0',
    preSwapSnapshotName: '0.1.0-pre-swap',
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: null,
    nextIntent: null,
    startedAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    ...patch,
  }
}

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

function makeDeps(overrides: Partial<StartupDeps> = {}): StartupDeps {
  let override: OverrideRecord | null = null
  let pointer: string | null = '0.1.0'
  let journal: ActivationJournalState = { kind: 'missing' }
  return {
    cleanupStaleInstalls: () => [],
    evict: () => [],
    completeInterruptedRestore: async () => 'none',
    readOverrideState: () => override === null ? { kind: 'missing' } : { kind: 'valid', record: override },
    writeOverride: value => { override = value },
    deleteOverride: () => { override = null },
    readCurrentPointerState: () => pointer === null ? { kind: 'missing' } : { kind: 'valid', version: pointer },
    readActivationJournal: () => journal,
    writeActivationJournal: value => { journal = { kind: 'valid', journal: value } },
    clearActivationJournal: () => { journal = { kind: 'missing' } },
    shellVersion: '0.1.4',
    builtinVersion: '0.1.1-rc.2',
    activationFacts: () => ({ sourceVersion: '0.1.0', sourceIsBuiltin: false, sourceWasKnownGood: true, knownGoodVersion: '0.1.0' }),
    snapshot: async version => `/snap/${version}`,
    resolveSnapshotName: async name => `/snap/${name}`,
    prepareManualRollback: async () => ({ snapshotPath: null, stashPath: null }),
    validateTarget: () => ({ ok: true }),
    switchPointer: version => { pointer = version },
    spawnAndProbe: async () => pass(),
    stopHost: async () => {},
    restore: async () => 'complete',
    recordProbePass: () => {},
    recordFailure: () => {},
    waitBeforeRetry: async () => {},
    ...overrides,
  }
}

test('no pending still completes cleanup/eviction/recovery', async () => {
  const result = await runStartupPhase(makeDeps({
    cleanupStaleInstalls: () => ['.work-a'], evict: () => ['0.0.9'], readOverrideState: () => ({ kind: 'missing' }),
  }))
  assert.equal(result.applyOutcome, null)
  assert.deepEqual(result.cleanedWorkDirs, ['.work-a'])
  assert.deepEqual(result.evicted, ['0.0.9'])
})

test('interrupted restore failure blocks every activation/spawn', async () => {
  let spawned = false
  const result = await runStartupPhase(makeDeps({
    completeInterruptedRestore: async () => 'half',
    readOverrideState: () => ({ kind: 'valid', record: record('0.2.0') }),
    spawnAndProbe: async () => { spawned = true; return pass() },
  }))
  assert.equal(result.blockedReason, 'restore-half')
  assert.equal(spawned, false)
})

test('pending activation uses real source/known-good facts and clears pending atomically', async () => {
  let stored = record('0.2.0')
  let snapshotVersion: string | null = null
  const result = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: stored }),
    writeOverride: next => { stored = next },
    snapshot: async version => { snapshotVersion = version; return `/snap/${version}` },
  }))
  assert.equal(result.applyOutcome?.status, 'applied')
  assert.equal(snapshotVersion, '0.1.0')
  assert.equal(stored.pending, null)
  assert.equal(stored.lastOutcome, 'applied')
})

test('snapshot failure remains pending but becomes an explicit retry gate', async () => {
  let stored = record('0.2.0')
  const result = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: stored }),
    writeOverride: next => { stored = next },
    snapshot: async () => { throw new Error('ENOSPC') },
  }))
  assert.equal(result.applyOutcome?.status, 'snapshot-failed')
  assert.equal(result.blockedReason, 'snapshot-failed')
  assert.equal(stored.pending, '0.2.0')
  assert.equal(stored.lastOutcome, 'snapshot-failed')
})

test('probe failure stops, restores, rolls pointer back, and persists failure evidence', async () => {
  let stored = record('0.2.0')
  const order: string[] = []
  let failurePhase: string | null = null
  let probes = 0
  const deps = makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: stored }),
    writeOverride: next => { stored = next },
    spawnAndProbe: async () => { probes += 1; return probes >= 3 ? pass() : fail() },
    stopHost: async () => { order.push('stop') },
    restore: async () => { order.push('restore'); return 'complete' },
    recordFailure: input => { failurePhase = input.phase },
  })
  const switchPointer = deps.switchPointer
  deps.switchPointer = version => { order.push(`switch:${version ?? 'builtin'}`); switchPointer(version) }
  const result = await runStartupPhase(deps)
  assert.equal(result.applyOutcome?.status, 'rolled-back')
  assert.deepEqual(order, ['switch:0.2.0', 'stop', 'switch:0.1.0', 'restore'])
  assert.equal(stored.pending, null)
  assert.equal(failurePhase, 'rolled-back')
})

test('swap-attempted is not replayed automatically', async () => {
  const pending = { ...record('0.2.0'), swapAttempted: true }
  let spawned = false
  const result = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: pending }),
    spawnAndProbe: async () => { spawned = true; return pass() },
  }))
  assert.equal(result.blockedReason, 'swap-attempted')
  assert.equal(spawned, false)
})

test('applied-monitoring + matching pending completes only the override verdict commit', async () => {
  let stored = record('0.2.0')
  let durable = journal('applied-monitoring')
  let snapshots = 0
  let switches = 0
  let probes = 0
  const result = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: stored }),
    writeOverride: next => { stored = next },
    readCurrentPointerState: () => ({ kind: 'valid', version: '0.2.0' }),
    readActivationJournal: () => ({ kind: 'valid', journal: durable }),
    writeActivationJournal: next => { durable = next },
    snapshot: async () => { snapshots += 1; throw new Error('must not snapshot migrated data') },
    switchPointer: () => { switches += 1 },
    spawnAndProbe: async () => { probes += 1; return pass() },
  }))
  assert.equal(result.applyOutcome, null)
  assert.equal(stored.pending, null)
  assert.equal(stored.lastOutcome, 'applied')
  assert.equal(durable.phase, 'applied-monitoring')
  assert.equal(durable.preSwapSnapshotName, '0.1.0-pre-swap')
  assert.deepEqual({ snapshots, switches, probes }, { snapshots: 0, switches: 0, probes: 0 })
})

test('builtin applied-monitoring crash commit distinguishes reset from shell invalidation', async () => {
  for (const kind of ['reset-builtin', 'shell-invalidation'] as const) {
    let stored: OverrideRecord | null = {
      shellVersion: '0.1.3', chosenVersion: '0.2.0', resolvedVersion: '0.2.0',
      pending: null, swapAttempted: false,
    }
    let durable: ActivationJournalState = {
      kind: 'valid',
      journal: journal('applied-monitoring', {
        targetVersion: '0.1.1-rc.2',
        targetIsBuiltin: true,
        intentKind: kind,
      }),
    }
    let deleted = 0
    let sideEffects = 0
    const result = await runStartupPhase(makeDeps({
      readOverrideState: () => stored === null ? { kind: 'missing' } : { kind: 'valid', record: stored },
      writeOverride: next => { stored = next },
      deleteOverride: () => { deleted += 1; stored = null },
      readCurrentPointerState: () => ({ kind: 'missing' }),
      readActivationJournal: () => durable,
      clearActivationJournal: () => { durable = { kind: 'missing' } },
      snapshot: async () => { sideEffects += 1; return '/snap/unexpected' },
      switchPointer: () => { sideEffects += 1 },
      spawnAndProbe: async () => { sideEffects += 1; return pass() },
    }))
    assert.equal(result.blockedReason, null)
    assert.equal(sideEffects, 0)
    assert.equal(durable.kind, 'missing')
    if (kind === 'reset-builtin') {
      assert.equal(deleted, 1)
      assert.equal(stored, null)
    } else {
      assert.equal(deleted, 0)
      assert.equal(stored?.invalidatedReason, 'shell-version-changed')
      assert.ok(stored?.invalidatedAt)
      assert.equal(stored?.chosenVersion, '0.2.0')
    }
  }
})

test('prepared replay with current already at target reuses pre-swap snapshot and probes only', async () => {
  let stored = record('0.2.0')
  let durable = journal('prepared')
  let snapshots = 0
  let switches = 0
  const probed: Array<[string, boolean]> = []
  const result = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: stored }),
    writeOverride: next => { stored = next },
    readCurrentPointerState: () => ({ kind: 'valid', version: '0.2.0' }),
    readActivationJournal: () => ({ kind: 'valid', journal: durable }),
    writeActivationJournal: next => { durable = next },
    snapshot: async () => { snapshots += 1; throw new Error('must reuse journal snapshot') },
    switchPointer: () => { switches += 1 },
    spawnAndProbe: async (version, isBuiltin) => { probed.push([version, isBuiltin]); return pass() },
  }))
  assert.equal(result.applyOutcome?.status, 'applied')
  assert.equal(stored.pending, null)
  assert.equal(durable.phase, 'applied-monitoring')
  assert.equal(durable.preSwapSnapshotName, '0.1.0-pre-swap')
  assert.deepEqual({ snapshots, switches }, { snapshots: 0, switches: 0 })
  assert.deepEqual(probed, [['0.2.0', false]])
})

test('in-flight journal refuses an unrelated persisted pending before any side effect', async () => {
  let sideEffects = 0
  const result = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: record('0.3.0') }),
    readActivationJournal: () => ({ kind: 'valid', journal: journal('prepared') }),
    snapshot: async () => { sideEffects += 1; return '/snap/unexpected' },
    switchPointer: () => { sideEffects += 1 },
    spawnAndProbe: async () => { sideEffects += 1; return pass() },
  }))
  assert.equal(result.blockedReason, 'journal-mismatch')
  assert.equal(sideEffects, 0)
})

test('restore completion resumes fallback probe and never replays the adjudicated bad target', async () => {
  let stored = record('0.2.0')
  let durableState: ActivationJournalState = {
    kind: 'valid',
    journal: journal('restoring', { rollbackTarget: '0.1.0' }),
  }
  const probed: Array<[string, boolean]> = []
  let snapshots = 0
  let switches = 0
  const result = await runStartupPhase(makeDeps({
    completeInterruptedRestore: async () => 'complete',
    readOverrideState: () => ({ kind: 'valid', record: stored }),
    writeOverride: next => { stored = next },
    readCurrentPointerState: () => ({ kind: 'valid', version: '0.1.0' }),
    readActivationJournal: () => durableState,
    writeActivationJournal: next => { durableState = { kind: 'valid', journal: next } },
    clearActivationJournal: () => { durableState = { kind: 'missing' } },
    snapshot: async () => { snapshots += 1; throw new Error('bad target must not be re-applied') },
    switchPointer: () => { switches += 1 },
    spawnAndProbe: async (version, isBuiltin) => { probed.push([version, isBuiltin]); return pass() },
  }))
  assert.equal(result.applyOutcome?.status, 'rolled-back')
  assert.equal(stored.pending, null)
  assert.deepEqual(probed, [['0.1.0', false]])
  assert.deepEqual({ snapshots, switches }, { snapshots: 0, switches: 0 })
  assert.equal(durableState.kind, 'missing')
})

test('intent commit gaps are discarded without erasing applied-monitoring context', async () => {
  let orphanState: ActivationJournalState = { kind: 'valid', journal: intent() }
  let clearCount = 0
  const orphan = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: record(null) }),
    readActivationJournal: () => orphanState,
    clearActivationJournal: () => { clearCount += 1; orphanState = { kind: 'missing' } },
  }))
  assert.equal(orphan.blockedReason, null)
  assert.equal(clearCount, 1)

  let monitoring = journal('applied-monitoring', {
    nextIntent: { targetVersion: '0.3.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch' },
  })
  const queuedGap = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: record(null) }),
    readCurrentPointerState: () => ({ kind: 'valid', version: '0.2.0' }),
    readActivationJournal: () => ({ kind: 'valid', journal: monitoring }),
    writeActivationJournal: next => { monitoring = next },
  }))
  assert.equal(queuedGap.blockedReason, null)
  assert.equal(monitoring.phase, 'applied-monitoring')
  assert.equal(monitoring.nextIntent, null)
  assert.equal(monitoring.preSwapSnapshotName, '0.1.0-pre-swap')
})

test('old-shell pending and env override are both deferred without side effects', async () => {
  let oldShell = { ...record('0.2.0'), shellVersion: '0.1.3' }
  let sideEffects = 0
  const invalid = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: oldShell }),
    writeOverride: next => { oldShell = next },
    snapshot: async () => { sideEffects += 1; return '/snap/should-not-exist' },
    switchPointer: () => { sideEffects += 1 },
    spawnAndProbe: async () => { sideEffects += 1; return pass() },
  }))
  assert.equal(invalid.applyOutcome, null)
  assert.equal(oldShell.pending, '0.2.0')
  assert.equal(sideEffects, 0)

  const stalePrepared = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: oldShell }),
    readActivationJournal: () => ({ kind: 'valid', journal: journal('prepared') }),
    snapshot: async () => { sideEffects += 1; return '/snap/should-not-exist' },
    switchPointer: () => { sideEffects += 1 },
    spawnAndProbe: async () => { sideEffects += 1; return pass() },
  }))
  assert.equal(stalePrepared.blockedReason, 'journal-mismatch')
  assert.equal(sideEffects, 0)

  let envRecord = record('0.2.0')
  const env = await runStartupPhase(makeDeps({
    envOverrideActive: () => true,
    readOverrideState: () => ({ kind: 'valid', record: envRecord }),
    writeOverride: next => { envRecord = next },
    snapshot: async () => { sideEffects += 1; return '/snap/should-not-exist' },
    switchPointer: () => { sideEffects += 1 },
    spawnAndProbe: async () => { sideEffects += 1; return pass() },
  }))
  assert.equal(env.blockedReason, 'env-override')
  assert.equal(envRecord.pending, '0.2.0')
  assert.equal(sideEffects, 0)
})

test('corrupt current or override metadata blocks cleanup, eviction, and builtin spawn', async () => {
  for (const [expected, overrides] of [
    ['current-corrupt', { readCurrentPointerState: () => ({ kind: 'corrupt' as const }) }],
    ['override-corrupt', { readOverrideState: () => ({ kind: 'corrupt' as const }) }],
  ] as const) {
    let touched = 0
    const result = await runStartupPhase(makeDeps({
      ...overrides,
      cleanupStaleInstalls: () => { touched += 1; return [] },
      evict: () => { touched += 1; return [] },
      spawnAndProbe: async () => { touched += 1; return pass() },
    }))
    assert.equal(result.blockedReason, expected)
    assert.equal(touched, 0)
  }
})

test('corrupt selection metadata still completes an authoritative restore before blocking', async () => {
  const order: string[] = []
  const result = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'corrupt' }),
    completeInterruptedRestore: async () => { order.push('restore'); return 'complete' },
    cleanupStaleInstalls: () => { order.push('cleanup'); return [] },
    evict: () => { order.push('evict'); return [] },
    spawnAndProbe: async () => { order.push('spawn'); return pass() },
  }))
  assert.equal(result.restored, 'complete')
  assert.equal(result.blockedReason, 'override-corrupt')
  assert.deepEqual(order, ['restore'])
})

test('env override remains authoritative after restore even when dormant chamber metadata is corrupt', async () => {
  let restored = 0
  let spawned = 0
  const result = await runStartupPhase(makeDeps({
    envOverrideActive: () => true,
    readCurrentPointerState: () => ({ kind: 'corrupt' }),
    completeInterruptedRestore: async () => { restored += 1; return 'complete' },
    spawnAndProbe: async () => { spawned += 1; return pass() },
  }))
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
  let stored: OverrideRecord = {
    shellVersion: '0.1.3', chosenVersion: '0.2.0', resolvedVersion: '0.2.0', pending: null,
    swapAttempted: false, invalidatedAt: '2026-08-23T00:00:00.000Z', invalidatedReason: 'shell-version-changed',
  }
  let durable: ActivationJournalState = {
    kind: 'valid', journal: intent('0.1.1-rc.2', true, 'shell-invalidation'),
  }
  let pointer: string | null = '0.2.0'
  const switches: Array<string | null> = []
  const probes: Array<[string, boolean]> = []
  let probeCalls = 0
  let snapshotVersion: string | null = null
  const result = await runStartupPhase(makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: stored }),
    writeOverride: next => { stored = next },
    readCurrentPointerState: () => pointer === null ? { kind: 'missing' } : { kind: 'valid', version: pointer },
    readActivationJournal: () => durable,
    writeActivationJournal: next => { durable = { kind: 'valid', journal: next } },
    clearActivationJournal: () => { durable = { kind: 'missing' } },
    activationFacts: () => ({ sourceVersion: '0.2.0', sourceIsBuiltin: false, sourceWasKnownGood: true, knownGoodVersion: '0.2.0' }),
    snapshot: async version => { snapshotVersion = version; return `/snap/${version}-pre` },
    switchPointer: version => { switches.push(version); pointer = version },
    spawnAndProbe: async (version, isBuiltin) => {
      probes.push([version, isBuiltin])
      probeCalls += 1
      return probeCalls < 3 ? fail() : pass()
    },
  }))
  assert.equal(result.applyOutcome?.status, 'rolled-back')
  assert.equal(snapshotVersion, '0.2.0')
  assert.deepEqual(switches, [null, '0.2.0'])
  assert.deepEqual(probes, [
    ['0.1.1-rc.2', true],
    ['0.1.1-rc.2', true],
    ['0.2.0', false],
  ])
  assert.equal(stored.shellVersion, '0.1.4')
  assert.equal(stored.invalidatedAt, null)
  assert.equal(stored.lastInvalidatedAt, '2026-08-23T00:00:00.000Z')
  assert.equal(stored.lastInvalidatedReason, 'shell-version-changed')
  assert.equal(stored.lastInvalidatedFromVersion, '0.2.0')
  assert.equal(stored.lastInvalidationRecovered, true)
  assert.equal(stored.chosenVersion, '0.2.0')
  assert.equal(durable.kind, 'missing')
})

test('reset-builtin applies transactionally and deletes override only after builtin probe passes', async () => {
  let stored: OverrideRecord | null = {
    shellVersion: '0.1.4', chosenVersion: '0.2.0', resolvedVersion: '0.2.0',
    pending: null, swapAttempted: false,
  }
  let durable: ActivationJournalState = {
    kind: 'valid', journal: intent('0.1.1-rc.2', true, 'reset-builtin'),
  }
  let pointer: string | null = '0.2.0'
  let deleted = 0
  const probes: Array<[string, boolean]> = []
  const result = await runStartupPhase(makeDeps({
    readOverrideState: () => stored === null ? { kind: 'missing' } : { kind: 'valid', record: stored },
    writeOverride: next => { stored = next },
    deleteOverride: () => { deleted += 1; stored = null },
    readCurrentPointerState: () => pointer === null ? { kind: 'missing' } : { kind: 'valid', version: pointer },
    readActivationJournal: () => durable,
    writeActivationJournal: next => { durable = { kind: 'valid', journal: next } },
    clearActivationJournal: () => { durable = { kind: 'missing' } },
    activationFacts: () => ({ sourceVersion: '0.2.0', sourceIsBuiltin: false, sourceWasKnownGood: true, knownGoodVersion: '0.2.0' }),
    snapshot: async version => `/snap/${version}-1724371200000`,
    switchPointer: version => { pointer = version },
    spawnAndProbe: async (version, isBuiltin) => { probes.push([version, isBuiltin]); return pass() },
  }))
  assert.equal(result.applyOutcome?.status, 'applied')
  assert.equal(pointer, null)
  assert.deepEqual(probes, [['0.1.1-rc.2', true]])
  assert.equal(deleted, 1)
  assert.equal(stored, null)
  assert.equal(durable.kind, 'missing')
})

test('reset-builtin supersedes and clears an existing pending selection transactionally', async () => {
  let stored: OverrideRecord | null = {
    shellVersion: '0.1.4', chosenVersion: '0.2.0', resolvedVersion: '0.2.0',
    pending: '0.3.0', swapAttempted: false,
  }
  let durable: ActivationJournalState = {
    kind: 'valid', journal: intent('0.1.1-rc.2', true, 'reset-builtin'),
  }
  let pointer: string | null = '0.2.0'
  let deleted = 0
  let snapshots = 0
  const result = await runStartupPhase(makeDeps({
    readOverrideState: () => stored === null ? { kind: 'missing' } : { kind: 'valid', record: stored },
    writeOverride: next => { stored = next },
    deleteOverride: () => { deleted += 1; stored = null },
    readCurrentPointerState: () => pointer === null ? { kind: 'missing' } : { kind: 'valid', version: pointer },
    readActivationJournal: () => durable,
    writeActivationJournal: next => { durable = { kind: 'valid', journal: next } },
    clearActivationJournal: () => { durable = { kind: 'missing' } },
    activationFacts: () => ({ sourceVersion: '0.2.0', sourceIsBuiltin: false, sourceWasKnownGood: true, knownGoodVersion: '0.2.0' }),
    snapshot: async version => { snapshots += 1; return `/snap/${version}-1724371200000` },
    switchPointer: version => { pointer = version },
    spawnAndProbe: async () => pass(),
  }))
  assert.equal(result.applyOutcome?.status, 'applied')
  assert.equal(snapshots, 1)
  assert.equal(pointer, null)
  assert.equal(deleted, 1)
  assert.equal(stored, null)
  assert.equal(durable.kind, 'missing')
})

test('F7 persists rollback-needed before effects and preserves a concurrently queued selection', async () => {
  let stored = record('0.3.0')
  const callerCopy = journal('applied-monitoring')
  let durable = journal('applied-monitoring', {
    nextIntent: { targetVersion: '0.3.0', targetIsBuiltin: false, manualRollback: true, intentKind: 'version-switch' },
  })
  let pointer: string | null = '0.2.0'
  const order: string[] = []
  const deps = makeDeps({
    readOverrideState: () => ({ kind: 'valid', record: stored }),
    writeOverride: next => { stored = next },
    readCurrentPointerState: () => pointer === null ? { kind: 'missing' } : { kind: 'valid', version: pointer },
    readActivationJournal: () => ({ kind: 'valid', journal: durable }),
    writeActivationJournal: next => { durable = next; order.push(`journal:${next.phase}:${next.nextIntent?.targetVersion ?? '-'}`) },
    clearActivationJournal: () => { throw new Error('queued intent must survive') },
    stopHost: async () => { order.push('stop') },
    switchPointer: version => { pointer = version; order.push(`switch:${version ?? 'builtin'}`) },
    restore: async () => { order.push('restore'); return 'complete' },
    spawnAndProbe: async (version, isBuiltin) => { order.push(`probe:${version}:${isBuiltin}`); return pass() },
  })
  const outcome = await runDelayedRollback(deps, callerCopy)
  assert.equal(outcome.status, 'rolled-back')
  assert.equal(order[0], 'journal:rollback-needed:0.3.0')
  assert.deepEqual(order.slice(1, 5), [
    'stop',
    'switch:0.1.0',
    'journal:restoring:0.3.0',
    'restore',
  ])
  assert.ok(order.includes('probe:0.1.0:false'))
  assert.equal(durable.phase, 'intent')
  assert.equal(durable.targetVersion, '0.3.0')
  assert.equal(durable.manualRollback, true)
  assert.equal(stored.pending, '0.3.0')
})

test('probeKoffiLoadable reports the packaged prebuilt directory', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'dsh-koffi-'))
  assert.equal((await probeKoffiLoadable(tree)).ok, false)
  mkdirSync(join(tree, 'node_modules', 'koffi', 'build'), { recursive: true })
  assert.equal((await probeKoffiLoadable(tree)).ok, true)
})
