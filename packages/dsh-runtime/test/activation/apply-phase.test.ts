/**
 * apply-phase.ts tests (design 18 §3.3/§3.4) — the activation transaction at
 * the ApplyDeps seam, driven through the canonical RunPhaseFixture
 * (test/support/run-phase-fixture.ts + test/support/fake-adapter.ts). There is no second
 * hand-rolled deps mock: `fixture.makeApplyDeps()` is the single ApplyDeps
 * implementation shared with apply-now.test.ts (the end-to-end startup-entry
 * layer), and per-test probe scripts inject the candidate/rollback-verification
 * outcomes explicitly.
 *
 * Covered here: no-snapshot-no-switch, probe-gated pass/fail with the
 * observe → delayed-verdict window, rollback target selection, stop-before-
 * rollback ordering, prepared-replay idempotence, nextIntent preservation and
 * manual-rollback journaling.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPendingVersion } from '../../src/apply-phase.ts'
import { activationProbeNamesForDomains, REQUIRED_ACTIVATION_PROBES, type ProbeResult } from '../../src/activation-gate.ts'
import { journalBuilder } from '../support/store-fixtures.ts'
import { RunPhaseFixture, type RunPhaseEvent } from '../support/run-phase-fixture.ts'

const pass = (): ProbeResult[] => REQUIRED_ACTIVATION_PROBES.map(name => ({ name, ok: true }))
const fail = (): ProbeResult[] =>
  pass().map(probe => probe.name === 'session/canOpenWorkspacePath' ? { ...probe, ok: false } : probe)

type ProbeScriptEntry = ProbeResult[] | 'pass' | 'fail'

/** Script probe outcomes per call: 1st/2nd = candidate observe + delayed
 * verdict, 3rd = rollback verification. The last entry repeats forever. */
function scriptProbes(fixture: RunPhaseFixture, script: ProbeScriptEntry[]): void {
  let call = 0
  fixture.setProbe(async () => {
    const entry = script[Math.min(call, script.length - 1)]
    call += 1
    return entry === 'pass' ? pass() : entry === 'fail' ? fail() : entry
  })
}

/** applyPendingVersion over the canonical apply-phase fixture fields; callers
 *  override only the field their case varies. */
function apply(
  fixture: RunPhaseFixture,
  overrides: Partial<Parameters<typeof applyPendingVersion>[0]> = {},
): ReturnType<typeof applyPendingVersion> {
  return applyPendingVersion({
    pendingVersion: '0.2.0',
    builtinVersion: '0.1.1-rc.2',
    sourceVersion: '0.1.1-rc.2',
    knownGoodVersion: null,
    deps: fixture.makeApplyDeps(),
    ...overrides,
  })
}

function switchVersions(fixture: RunPhaseFixture): Array<string | null> {
  return fixture.events
    .filter((e): e is Extract<RunPhaseEvent, { kind: 'switch' }> => e.kind === 'switch')
    .map(e => e.version)
}

const durableJournal = journalBuilder({
  targetVersion: '0.2.0',
  sourceVersion: '0.1.0',
  knownGoodVersion: '0.1.0',
  preSwapSnapshotName: '0.1.0-pre',
})

test('snapshot failure aborts — no switchPointer, status failed', async () => {
  const fixture = new RunPhaseFixture({ snapshotThrows: true, pointer: '0.1.1-rc.2' })
  const outcome = await apply(fixture)
  assert.equal(outcome.status, 'snapshot-failed')
  assert.equal(fixture.switchCalls, 0)
})

test('validateTarget rejection is a loud target-invalid failure — no snapshot, no switch', async () => {
  const fixture = new RunPhaseFixture({ pointer: '0.1.1-rc.2' })
  const deps = fixture.makeApplyDeps()
  deps.validateTarget = () => ({ ok: false, error: 'tree rejected by the host gate' })
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.1.1-rc.2', knownGoodVersion: null,
    deps,
  })
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.failureKind, 'target-invalid')
  assert.equal(outcome.retainPending, true)
  assert.equal(outcome.retryAction, 'apply')
  assert.match(outcome.error ?? '', /待应用运行时树无效/)
  assert.equal(fixture.snapshotCalls, 0)
  assert.equal(fixture.switchCalls, 0)
})

const FULL_SEED_DOMAINS = ['clientGraph/graph', 'gitWorktree/previewCreate', 'archiveCleanup/probe', 'openInApp/probe'] as const
const PARTIAL_SEED_DOMAINS = ['clientGraph/graph', 'archiveCleanup/probe'] as const

/**
 * P0 (2026-12): the verdict's expected name set must be resolved AFTER the
 * probe attempt, because the probe is the landing site of the candidate spawn
 * and the desktop host publishes its seeded chamber domains from inside that
 * spawn (cp.seededProbeDomains is written by the spawn thunk only). A value
 * captured while the ApplyDeps object was built froze the cold-start empty
 * table, so the freshly seeded run (the full 8-name set) never passed the exact-set check
 * and a healthy activation rolled back. These tests drive the real ordering:
 * `probeExpectedNames` is a lazy reader of the host's domain table.
 */
test('P0: expected probe set is resolved after the probe run (cold-start seed refresh)', async () => {
  const fixture = new RunPhaseFixture({ pointer: '0.1.1-rc.2' })
  const deps = fixture.makeApplyDeps()
  // Cold start: the host's seeded-domain table is empty until the candidate
  // spawn inside `probe` refreshes it.
  let seededDomains: readonly string[] = []
  const order: string[] = []
  const expectedSnapshots: string[][] = []
  deps.probe = async () => {
    order.push('probe')
    seededDomains = [...FULL_SEED_DOMAINS]
    return activationProbeNamesForDomains(seededDomains).map(name => ({ name, ok: true }))
  }
  deps.probeExpectedNames = () => {
    order.push('expected')
    const names = activationProbeNamesForDomains(seededDomains)
    expectedSnapshots.push([...names])
    return names
  }
  const outcome = await apply(fixture, { deps })
  assert.equal(outcome.status, 'applied')
  // The stale pre-spawn expectation would have been the 4-name reduced set.
  assert.equal(expectedSnapshots.length, 1)
  assert.deepEqual(expectedSnapshots[0], [...activationProbeNamesForDomains(FULL_SEED_DOMAINS)])
  assert.equal(expectedSnapshots[0].length, REQUIRED_ACTIVATION_PROBES.length)
  assert.deepEqual(order, ['probe', 'expected'])
})

test('P0: rollback verification probes also resolve the expectation after each run', async () => {
  const fixture = new RunPhaseFixture({ pointer: '0.1.1-rc.2' })
  const deps = fixture.makeApplyDeps()
  let seededDomains: readonly string[] = []
  const expectedSnapshots: string[][] = []
  let calls = 0
  deps.probe = async () => {
    calls += 1
    seededDomains = [...PARTIAL_SEED_DOMAINS]
    // Candidate observe (1) → confirm-fail (2); the third attempt is the
    // rollback verification and must pass.
    return activationProbeNamesForDomains(seededDomains).map(name => ({ name, ok: calls >= 3 }))
  }
  deps.probeExpectedNames = () => {
    const names = activationProbeNamesForDomains(seededDomains)
    expectedSnapshots.push([...names])
    return names
  }
  const outcome = await apply(fixture, { deps, knownGoodVersion: '0.1.1-rc.2' })
  // Without the lazy seam the stale 4-name expectation makes the rollback
  // verification fail too, escalating to the builtin-terminal outcome.
  assert.equal(outcome.status, 'rolled-back')
  assert.equal(outcome.runtimeBlocked, false)
  assert.equal(expectedSnapshots.length, 3)
  for (const snapshot of expectedSnapshots) {
    assert.deepEqual(snapshot, [...activationProbeNamesForDomains(PARTIAL_SEED_DOMAINS)])
  }
})

test('P0 control: the stale pre-spawn (empty-table) expectation rolls the same healthy run back', async () => {
  // Reproduces the pre-fix capture: the cold-start table ([]) was frozen into
  // the verdict while the spawned candidate answered the full seeded set.
  // This is the defect the lazy seam removes — keep it as the negative control.
  const fixture = new RunPhaseFixture({ pointer: '0.1.1-rc.2' })
  const deps = fixture.makeApplyDeps()
  deps.probe = async () => activationProbeNamesForDomains(FULL_SEED_DOMAINS).map(name => ({ name, ok: true }))
  deps.probeExpectedNames = () => activationProbeNamesForDomains([])
  const outcome = await apply(fixture, { deps, knownGoodVersion: '0.1.1-rc.2' })
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.runtimeBlocked, true)
  assert.equal(outcome.failureKind, 'terminal')
  assert.equal(fixture.switchCalls > 0, true)
})

test('probe pass → applied, marks known-good, switches to pending', async () => {
  const fixture = new RunPhaseFixture({ probeResults: pass(), pointer: '0.1.1-rc.2' })
  const outcome = await apply(fixture)
  assert.equal(outcome.status, 'applied')
  assert.deepEqual(switchVersions(fixture), ['0.2.0'])
  assert.deepEqual(fixture.knownGoodCalls, ['0.2.0'])
})

test('probe fail → rolled-back, restore called, switch back to source (known-good)', async () => {
  const fixture = new RunPhaseFixture({ pointer: '0.1.1-rc.2' })
  scriptProbes(fixture, ['fail', 'fail', 'pass'])
  const outcome = await apply(fixture, { knownGoodVersion: '0.1.1-rc.2' })
  assert.equal(outcome.status, 'rolled-back')
  assert.equal(fixture.restoreCalls, 1)
  // The rollback restores the resolved pre-swap snapshot of the SOURCE tree
  // (snapshot(sourceVersion) → preSwapSnapshotName → resolved path).
  const restore = fixture.events.find(e => e.kind === 'restore')
  assert.equal(restore?.snapshot, '/snap/0.1.1-rc.2-pre-swap')
  assert.deepEqual(switchVersions(fixture), ['0.2.0', '0.1.1-rc.2']) // pending then rollback to source
})

test('probe failure stops the host before pointer/data rollback', async () => {
  const fixture = new RunPhaseFixture({ pointer: null })
  scriptProbes(fixture, ['fail', 'fail', 'pass'])
  await apply(fixture, { builtinVersion: '0.1.0', sourceVersion: '0.1.0', sourceIsBuiltin: true })
  assert.deepEqual(fixture.events.map(e => e.kind), ['snapshot', 'switch', 'probe', 'probe', 'stop', 'switch', 'restore', 'probe'])
  assert.deepEqual(switchVersions(fixture), ['0.2.0', null])
})

test('failed host stop preserves pointer and snapshot data', async () => {
  const fixture = new RunPhaseFixture({ stopHostThrows: true, pointer: '0.1.0' })
  scriptProbes(fixture, ['fail', 'fail'])
  const outcome = await apply(fixture, { sourceVersion: '0.1.0', knownGoodVersion: '0.1.0' })
  assert.equal(outcome.status, 'failed')
  assert.equal(fixture.switchCalls, 1)
  assert.equal(fixture.restoreCalls, 0)
  assert.match(outcome.error ?? '', /未触碰数据/)
})

test('probe observe then fail → still rolled-back (delayed verdict)', async () => {
  const fixture = new RunPhaseFixture({ pointer: '0.1.1-rc.2' })
  let calls = 0
  fixture.setProbe(async () => {
    calls += 1
    return calls === 3 ? pass() : fail()
  })
  const outcome = await apply(fixture, { knownGoodVersion: '0.1.1-rc.2' })
  assert.equal(outcome.status, 'rolled-back')
  assert.equal(calls, 3) // observe, final candidate verdict, rollback verification
})

test('rollback target probe failure falls to builtin once and ends loud', async () => {
  const fixture = new RunPhaseFixture({ pointer: '0.2.0' })
  fixture.setProbe(async () => fail())
  const outcome = await apply(fixture, { pendingVersion: '0.3.0', sourceVersion: '0.2.0', sourceWasKnownGood: true, knownGoodVersion: '0.2.0' })
  assert.equal(outcome.status, 'failed')
  assert.deepEqual(switchVersions(fixture), ['0.3.0', '0.2.0', null])
  assert.match(outcome.error ?? '', /内建运行时探针均失败/)
  // 2026-09 review: the verdict names the failing probe — "probe failed" with no
  // name is the invisible-failure family the desktop projection fix closed.
  assert.match(outcome.error ?? '', /内建：session\/canOpenWorkspacePath/)
  assert.equal(outcome.retainPending, true)
  assert.equal(outcome.retryAction, 'apply')
  assert.equal(outcome.runtimeBlocked, true)
})

test('a resumed builtin fallback that fails again names the failing probe', async () => {
  // resumed mid-rollback with no trusted target: the fallback probe IS the
  // builtin tree, so a second failure is terminal and must still name the probe
  const journal = durableJournal('rollback-needed', { rollbackTarget: null })
  const fixture = new RunPhaseFixture({ pointer: '0.2.0', journal: { kind: 'valid', journal } })
  fixture.setProbe(async () => fail())
  const outcome = await apply(fixture, { pendingVersion: journal.targetVersion, sourceVersion: '0.2.0', sourceWasKnownGood: true, knownGoodVersion: '0.2.0', journal })
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.failureKind, 'terminal')
  assert.match(outcome.error ?? '', /内建回退运行时探针失败/)
  assert.match(outcome.error ?? '', /session\/canOpenWorkspacePath/)
})

test('rollback target falls to known-good when source not trusted', async () => {
  const fixture = new RunPhaseFixture({ pointer: '0.2.0' })
  scriptProbes(fixture, ['fail', 'fail', 'pass'])
  const outcome = await apply(fixture, { pendingVersion: '0.3.0', sourceVersion: '0.2.0', knownGoodVersion: '0.1.1-rc.2' })
  assert.equal(outcome.status, 'rolled-back')
  assert.deepEqual(switchVersions(fixture), ['0.3.0', '0.1.1-rc.2']) // source not trusted → known-good
})

test('restore incomplete → rolled-back with loud error', async () => {
  const fixture = new RunPhaseFixture({ restoreOutcome: 'incomplete', pointer: '0.1.1-rc.2' })
  scriptProbes(fixture, ['fail', 'fail'])
  const outcome = await apply(fixture, { knownGoodVersion: '0.1.1-rc.2' })
  assert.equal(outcome.status, 'rolled-back')
  assert.match(outcome.error ?? '', /数据恢复未完成/)
  assert.equal(outcome.retainPending, true)
  assert.equal(outcome.retryAction, 'restore')
  assert.equal(outcome.runtimeBlocked, true)
})

test('prepared crash replay at target performs no new snapshot or pointer write', async () => {
  const journal = durableJournal('prepared')
  const fixture = new RunPhaseFixture({ pointer: '0.2.0', journal: { kind: 'valid', journal } })
  fixture.setProbe(async () => pass())
  const outcome = await apply(fixture, { sourceVersion: '0.1.0', sourceWasKnownGood: true, knownGoodVersion: '0.1.0', journal })
  assert.equal(outcome.status, 'applied')
  assert.equal(fixture.snapshotCalls, 0)
  assert.equal(fixture.switchCalls, 0)
  assert.equal(fixture.journalWrites.at(-1)?.phase, 'applied-monitoring')
  assert.equal(fixture.journalWrites.at(-1)?.preSwapSnapshotName, '0.1.0-pre')
})

test('phase writes preserve a concurrently queued reset-builtin intent', async () => {
  const active = durableJournal('prepared')
  const queued = {
    targetVersion: '0.1.1-rc.2', targetIsBuiltin: true, manualRollback: false, intentKind: 'reset-builtin' as const,
  }
  const fixture = new RunPhaseFixture({
    pointer: '0.2.0',
    journal: { kind: 'valid', journal: { ...active, nextIntent: queued } },
  })
  fixture.setProbe(async () => pass())
  const outcome = await apply(fixture, { sourceVersion: '0.1.0', sourceWasKnownGood: true, knownGoodVersion: '0.1.0', journal: active })
  assert.equal(outcome.status, 'applied')
  assert.deepEqual(fixture.journalWrites.at(-1)?.nextIntent, queued)
})

test('manual rollback journals target snapshot and stash before switching, then restores target data', async () => {
  const fixture = new RunPhaseFixture({
    pointer: '0.2.0',
    probeResults: pass(),
    manualRollbackPaths: { snapshotPath: '/snap/0.1.0-historical', stashPath: '/stash/0.1.0-current' },
  })
  const outcome = await apply(fixture, { pendingVersion: '0.1.0', sourceVersion: '0.2.0', sourceWasKnownGood: true, knownGoodVersion: '0.2.0', manualRollback: true })
  assert.equal(outcome.status, 'applied')
  assert.deepEqual(fixture.events.slice(0, 3).map(e => e.kind), ['snapshot', 'prepare-manual', 'switch'])
  assert.deepEqual(fixture.journalWrites.slice(0, 3).map(j => j.phase), ['prepared', 'switched', 'manual-restoring'])
  // Interleaving is load-bearing: the prepared journal is durable before the
  // pointer moves, and the manual-restoring phase is journaled before the
  // target data restore begins.
  const preparedAt = fixture.journalWrites.findIndex(j => j.phase === 'prepared')
  const switchAt = fixture.events.findIndex(e => e.kind === 'switch')
  const manualRestoringAt = fixture.journalWrites.findIndex(j => j.phase === 'manual-restoring')
  const restoreAt = fixture.events.findIndex(e => e.kind === 'restore')
  assert.ok(preparedAt !== -1 && preparedAt < switchAt, 'prepared journal precedes the pointer switch')
  assert.ok(manualRestoringAt !== -1 && manualRestoringAt < restoreAt, 'manual-restoring journal precedes the data restore')
  const restore = fixture.events.find(e => e.kind === 'restore')
  assert.equal(restore?.snapshot, '/snap/0.1.0-historical')
  const last = fixture.journalWrites.at(-1)
  assert.equal(last?.manualDataSnapshotName, '0.1.0-historical')
  assert.equal(last?.preRollbackStashName, '0.1.0-current')
})

test('a timed-out first probe can recover on a fresh, bounded second probe attempt', async () => {
  const fixture = new RunPhaseFixture({ pointer: '0.1.0' })
  let calls = 0
  fixture.setProbe(async () => {
    calls += 1
    if (calls === 1) {
      fixture.adapter.advanceClock(60_001)
      return fail()
    }
    fixture.adapter.advanceClock(1)
    return pass()
  })
  const outcome = await apply(fixture, { sourceVersion: '0.1.0', sourceWasKnownGood: true, knownGoodVersion: '0.1.0' })
  assert.equal(outcome.status, 'applied')
  assert.equal(calls, 2)
  assert.equal(fixture.switchCalls, 1)
  assert.equal(fixture.restoreCalls, 0)
})

test('rollback probe is routed to rollback version, never the adjudicated target', async () => {
  const fixture = new RunPhaseFixture({ pointer: '0.2.0' })
  const calls: Array<[string, boolean]> = []
  let attempt = 0
  fixture.setProbe(async (version, isBuiltin) => {
    calls.push([version, isBuiltin])
    attempt += 1
    return attempt <= 2 ? fail() : pass()
  })
  const outcome = await apply(fixture, { pendingVersion: '0.3.0', sourceVersion: '0.2.0', sourceWasKnownGood: true, knownGoodVersion: '0.2.0' })
  assert.equal(outcome.status, 'rolled-back')
  assert.deepEqual(calls, [
    ['0.3.0', false],
    ['0.3.0', false],
    ['0.2.0', false],
  ])
})
