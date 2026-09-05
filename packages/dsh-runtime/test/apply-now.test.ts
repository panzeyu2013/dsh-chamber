/**
 * Design 18 addendum · Apply Now — P1 shared-core run-phase tests (design 8.1
 * checklist, shared-core level). The desktop/gateway hosts already own the
 * apply-now orchestration; the shared core only gained an optional AbortSignal
 * on the probe seams (decision S1). These tests pin the runtime-entry
 * semantics the hosts rely on, all driven through the canonical
 * FakeHostAdapter fixture (test/fake-adapter.ts + test/run-phase-fixture.ts):
 *
 *   1. runtime activation sequence (stop → snapshot → switchPointer →
 *      spawnAndProbe → verdict) and the no-snapshot-no-switch invariant;
 *   2. crash injection at the runtime entry — re-entry continues idempotently
 *      from the journal and never takes a second post-migration snapshot;
 *   3. clock advance — probe-window timeout + delayed verdict (observe →
 *      second probe) and the 24h + ≥1 boot known-good gate;
 *   4. the store single-flight matrix lives in dsh-runtime-store.test.ts;
 *   5. restart-exhausted two-layer semantics — the journal phase is the only
 *      F7 latch (no double rollback) and apply-now snapshot failure is a
 *      terminal snapshot-failed state with a retry-apply exit.
 *   6. the S1 host-abort seam — signal forwarding, pre-aborted cancellation
 *      with zero side effects, and abort not poisoning rollback verification.
 *   7. startup-entry abort — runStartupPhase/runDelayedRollback forward the
 *      optional transaction-level signal; a pre-aborted entry cancels with
 *      zero side effects, and a probe-in-flight abort cancels at the rollback
 *      entry (the continueRollback check is load-bearing) while the next
 *      startup resumes the durable journal idempotently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PROBE_WINDOW_MS, REQUIRED_ACTIVATION_PROBES, type ProbeResult } from '../src/activation-gate.ts'
import { applyPendingVersion, beginDelayedRollback } from '../src/apply-phase.ts'
import { runDelayedRollback } from '../src/runtime-startup.ts'
import type { ActivationJournal } from '../src/dsh-runtime-store.ts'
import {
  DEFAULT_HEALTH_POLICY,
  noteBoot,
  promoteDueCandidates,
  recordProbePass,
} from '../src/known-good-monitor.ts'
import {
  monitoringJournal,
  pendingOverride,
  RunPhaseFixture,
  type RunPhaseEvent,
} from './run-phase-fixture.ts'

const passProbes = (): ProbeResult[] => REQUIRED_ACTIVATION_PROBES.map(name => ({ name, ok: true }))
const failProbes = (): ProbeResult[] =>
  passProbes().map(p => p.name === 'session/canOpenWorkspacePath' ? { ...p, ok: false } : p)

const switchVersions = (fixture: RunPhaseFixture): Array<string | null> =>
  fixture.events
    .filter((e): e is Extract<RunPhaseEvent, { kind: 'switch' }> => e.kind === 'switch')
    .map(e => e.version)

const eventCount = (fixture: RunPhaseFixture, kind: RunPhaseEvent['kind']): number =>
  fixture.events.filter(e => e.kind === kind).length

/** Minimal valid version tree for known-good candidate validation. */
function makeVersionTree(base: string, version: string): void {
  const tree = join(base, 'dsh-runtime', version)
  const binDir = join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'bin.js'), '// fixture', 'utf8')
  writeFileSync(join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version,
  }), 'utf8')
  const criticalFiles = Object.fromEntries([
    'node_modules/@deepseek-ai/dsh/package.json',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].map(relativePath => [
    relativePath,
    `sha256-${createHash('sha256').update(readFileSync(join(tree, relativePath))).digest('base64')}`,
  ]))
  writeFileSync(join(tree, 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh': version },
    dsh: { platform: `${process.platform}-${process.arch}`, criticalFiles },
  }), 'utf8')
}

// ---------------------------------------------------------------------------
// 1. Runtime activation sequence (apply-now host orchestration semantics)
// ---------------------------------------------------------------------------

test('runtime activation sequence: stop → snapshot → switchPointer → spawnAndProbe → verdict', async () => {
  const fixture = new RunPhaseFixture({ override: pendingOverride() })
  const result = await fixture.applyNow()
  assert.equal(result.applyOutcome?.status, 'applied')
  // Host orchestration stops the instance before the transaction; the core
  // then runs snapshot → switchPointer → spawnAndProbe → pass verdict.
  assert.deepEqual(fixture.events.map(e => e.kind), ['stop', 'snapshot', 'switch', 'probe', 'known-good'])
  const snapshot = fixture.events.find(e => e.kind === 'snapshot')
  assert.ok(snapshot !== undefined && snapshot.kind === 'snapshot')
  assert.equal(snapshot.version, '0.1.0')
  assert.equal(fixture.currentState().pointer, '0.2.0')
  assert.deepEqual(fixture.knownGoodCalls, ['0.2.0'])
  assert.equal(fixture.adapter.stopCalls, 1)
  const state = fixture.currentState()
  assert.equal(state.journal.kind, 'valid')
  if (state.journal.kind === 'valid') {
    assert.equal(state.journal.journal.phase, 'applied-monitoring')
    assert.equal(state.journal.journal.preSwapSnapshotName, '0.1.0-pre-swap')
  }
})

test('no-snapshot-no-switch holds at the runtime entry: journal never advances', async () => {
  const fixture = new RunPhaseFixture({ override: pendingOverride(), snapshotThrows: true })
  const result = await fixture.runEntry()
  assert.equal(result.applyOutcome?.status, 'snapshot-failed')
  assert.equal(fixture.currentState().pointer, '0.1.0')
  assert.equal(fixture.switchCalls, 0)
  assert.equal(eventCount(fixture, 'probe'), 0)
  assert.equal(fixture.currentState().journal.kind, 'missing')
  assert.equal(fixture.currentState().override?.pending, '0.2.0')
})

// ---------------------------------------------------------------------------
// 2. Crash injection at the runtime entry — journal-idempotent continuation
// ---------------------------------------------------------------------------

test('crash after the pre-swap snapshot: re-entry reuses the journal snapshot, never re-snapshots', async () => {
  const first = new RunPhaseFixture({ override: pendingOverride(), crashAfter: 'snapshot' })
  await first.runEntry()
  const crashed = first.crashed()
  assert.equal(crashed.pointer, '0.1.0')
  assert.equal(crashed.journal.kind, 'valid')
  if (crashed.journal.kind === 'valid') {
    assert.equal(crashed.journal.journal.phase, 'prepared')
    assert.equal(crashed.journal.journal.preSwapSnapshotName, '0.1.0-pre-swap')
  }

  const second = RunPhaseFixture.fromState(crashed)
  const result = await second.runEntry()
  assert.equal(result.applyOutcome?.status, 'applied')
  assert.equal(first.snapshotCalls + second.snapshotCalls, 1)
  assert.equal(second.snapshotCalls, 0)
  // The pointer was never touched before the crash, so the re-entry performs
  // exactly one switch — but never a second snapshot.
  assert.equal(first.switchCalls + second.switchCalls, 1)
  assert.deepEqual(switchVersions(second), ['0.2.0'])
  const state = second.currentState()
  assert.equal(state.journal.kind, 'valid')
  if (state.journal.kind === 'valid') {
    assert.equal(state.journal.journal.phase, 'applied-monitoring')
    assert.equal(state.journal.journal.preSwapSnapshotName, '0.1.0-pre-swap')
  }
})

test('crash right after switchPointer: re-entry skips the re-switch and completes', async () => {
  const first = new RunPhaseFixture({ override: pendingOverride(), crashAfter: 'switch' })
  await first.runEntry()
  const crashed = first.crashed()
  assert.equal(crashed.pointer, '0.2.0')
  assert.equal(crashed.journal.kind, 'valid')
  if (crashed.journal.kind === 'valid') assert.equal(crashed.journal.journal.phase, 'prepared')

  const second = RunPhaseFixture.fromState(crashed)
  const result = await second.runEntry()
  assert.equal(result.applyOutcome?.status, 'applied')
  assert.equal(first.snapshotCalls + second.snapshotCalls, 1)
  assert.equal(first.switchCalls + second.switchCalls, 1)
  assert.equal(second.snapshotCalls, 0)
  assert.equal(second.switchCalls, 0)
})

test('crash during the activation probe: re-entry probes again but never re-snapshots or re-switches', async () => {
  const first = new RunPhaseFixture({ override: pendingOverride(), crashAfter: 'probe' })
  await first.runEntry()
  const crashed = first.crashed()
  assert.equal(crashed.pointer, '0.2.0')
  assert.equal(crashed.journal.kind, 'valid')
  if (crashed.journal.kind === 'valid') assert.equal(crashed.journal.journal.phase, 'switched')

  const second = RunPhaseFixture.fromState(crashed)
  const result = await second.runEntry()
  assert.equal(result.applyOutcome?.status, 'applied')
  assert.equal(first.snapshotCalls + second.snapshotCalls, 1)
  assert.equal(first.switchCalls + second.switchCalls, 1)
  assert.equal(second.snapshotCalls, 0)
  assert.equal(second.switchCalls, 0)
  assert.equal(eventCount(second, 'probe'), 1)
})

test('crash after the rollback stopHost: re-entry continues the same rollback exactly once', async () => {
  const first = new RunPhaseFixture({ override: pendingOverride(), crashAfter: 'stop' })
  first.setProbe(async version => version === '0.2.0' ? failProbes() : passProbes())
  await first.runEntry()
  const crashed = first.crashed()
  assert.equal(crashed.journal.kind, 'valid')
  if (crashed.journal.kind === 'valid') {
    assert.equal(crashed.journal.journal.phase, 'rollback-needed')
    assert.equal(crashed.journal.journal.rollbackTarget, '0.1.0')
  }

  const second = RunPhaseFixture.fromState(crashed)
  const result = await second.runEntry()
  assert.equal(result.applyOutcome?.status, 'rolled-back')
  assert.equal(first.snapshotCalls + second.snapshotCalls, 1)
  assert.equal(first.restoreCalls + second.restoreCalls, 1)
  assert.deepEqual(
    [...switchVersions(first), ...switchVersions(second)],
    ['0.2.0', '0.1.0'],
  )
  assert.equal(second.currentState().journal.kind, 'missing')
  assert.equal(second.currentState().override?.pending, null)
})

// ---------------------------------------------------------------------------
// 3. Clock advance — probe-window timeout + delayed verdict, known-good gate
// ---------------------------------------------------------------------------

test('advanceClock pushes the first probe beyond the window; a fresh second probe recovers (delayed verdict)', async () => {
  const fixture = new RunPhaseFixture()
  let calls = 0
  fixture.setProbe(async () => {
    calls += 1
    if (calls === 1) {
      fixture.adapter.advanceClock(DEFAULT_PROBE_WINDOW_MS + 1)
      return failProbes()
    }
    return passProbes()
  })
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0',
    builtinVersion: fixture.builtinVersion,
    sourceVersion: '0.1.0',
    sourceWasKnownGood: true,
    knownGoodVersion: '0.1.0',
    deps: fixture.makeApplyDeps(),
  })
  assert.equal(outcome.status, 'applied')
  assert.equal(calls, 2)
  assert.equal(eventCount(fixture, 'probe'), 2)
  assert.deepEqual(fixture.knownGoodCalls, ['0.2.0'])
  assert.deepEqual(switchVersions(fixture), ['0.2.0'])
  const state = fixture.currentState()
  assert.equal(state.journal.kind, 'valid')
  if (state.journal.kind === 'valid') {
    assert.equal(state.journal.journal.phase, 'applied-monitoring')
  }
})

test('advanceClock + a still-failing second probe rolls back after the delayed verdict', async () => {
  const fixture = new RunPhaseFixture()
  let calls = 0
  fixture.setProbe(async () => {
    calls += 1
    if (calls <= 2) {
      if (calls === 1) fixture.adapter.advanceClock(DEFAULT_PROBE_WINDOW_MS + 1)
      return failProbes()
    }
    return passProbes()
  })
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0',
    builtinVersion: fixture.builtinVersion,
    sourceVersion: '0.1.0',
    sourceWasKnownGood: true,
    knownGoodVersion: '0.1.0',
    deps: fixture.makeApplyDeps(),
  })
  assert.equal(outcome.status, 'rolled-back')
  assert.equal(calls, 3) // observe, final candidate verdict, rollback-target verification
  assert.equal(fixture.restoreCalls, 1)
  assert.deepEqual(switchVersions(fixture), ['0.2.0', '0.1.0'])
})

test('an all-ok first probe beyond the probe window still observes — the window constrains the pass branch (load-bearing)', async () => {
  // Load-bearing: the first probe returns all-ok, so a 'pass' verdict would
  // need only one probe. Only the window crossing (elapsedMs > windowMs,
  // driven by the fixture clock through deps.nowMs) forces decideVerdict to
  // 'observe' → a fresh second probe → applied. Removing the advanceClock
  // makes this assertion fail (calls would stay 1).
  const fixture = new RunPhaseFixture()
  let calls = 0
  fixture.setProbe(async () => {
    calls += 1
    if (calls === 1) fixture.adapter.advanceClock(DEFAULT_PROBE_WINDOW_MS + 1)
    return passProbes()
  })
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0',
    builtinVersion: fixture.builtinVersion,
    sourceVersion: '0.1.0',
    sourceWasKnownGood: true,
    knownGoodVersion: '0.1.0',
    deps: fixture.makeApplyDeps(),
  })
  assert.equal(outcome.status, 'applied')
  assert.equal(calls, 2)
  assert.equal(eventCount(fixture, 'probe'), 2)
})

test('known-good promotion still requires 24h + at least one boot on the adapter clock', () => {
  const fixture = new RunPhaseFixture()
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-apply-now-'))
  makeVersionTree(base, '0.2.0')
  recordProbePass(base, '0.2.0', fixture.adapter.nowMs)
  // 24h of uptime alone is not enough — the ≥1 boot gate has not been met.
  assert.deepEqual(promoteDueCandidates(base, fixture.adapter.advanceClock(DEFAULT_HEALTH_POLICY.minUptimeMs)), [])
  // A successful boot inside the healthy window completes the gate.
  noteBoot(base, '0.2.0', fixture.adapter.nowMs)
  assert.deepEqual(promoteDueCandidates(base, fixture.adapter.advanceClock(1)), ['0.2.0'])
  // A second run is a no-op (already promoted).
  assert.deepEqual(promoteDueCandidates(base, fixture.adapter.advanceClock(1)), [])
})

// ---------------------------------------------------------------------------
// 5. Restart-exhausted two-layer semantics (F7) + snapshot-failed terminal
// ---------------------------------------------------------------------------

test('beginDelayedRollback accepts only an applied-monitoring journal — the F7 latch', () => {
  const monitoring = monitoringJournal()
  const rollbackNeeded = { ...monitoring, phase: 'rollback-needed' as const, rollbackTarget: '0.1.0' }
  assert.throws(() => beginDelayedRollback(rollbackNeeded, () => {}), /applied-monitoring/)
  const written: { journal: ActivationJournal | null } = { journal: null }
  const started = beginDelayedRollback(monitoring, next => { written.journal = next })
  assert.equal(started.phase, 'rollback-needed')
  assert.equal(started.rollbackTarget, '0.1.0')
  assert.equal(written.journal?.phase, 'rollback-needed')
})

test('F7 rollback runs exactly once; a second runDelayedRollback cannot re-rollback', async () => {
  const fixture = new RunPhaseFixture({
    pointer: '0.2.0',
    journal: { kind: 'valid', journal: monitoringJournal() },
  })
  const first = await runDelayedRollback(fixture.makeStartupDeps(), monitoringJournal())
  assert.equal(first.status, 'rolled-back')
  assert.equal(fixture.restoreCalls, 1)
  assert.equal(fixture.currentState().journal.kind, 'missing')
  // The journal is the only latch: once F7 has run, the durable journal is no
  // longer applied-monitoring, so a duplicate event cannot roll back again.
  await assert.rejects(
    runDelayedRollback(fixture.makeStartupDeps(), monitoringJournal()),
    /applied-monitoring/,
  )
})

test('a normal apply verdict failure rolls back exactly once; a later entry never double-rolls back', async () => {
  const first = new RunPhaseFixture({ override: pendingOverride() })
  first.setProbe(async version => version === '0.2.0' ? failProbes() : passProbes())
  const result = await first.runEntry()
  assert.equal(result.applyOutcome?.status, 'rolled-back')
  assert.equal(first.restoreCalls, 1)
  assert.equal(first.currentState().journal.kind, 'missing')
  assert.equal(first.currentState().override?.pending, null)
  assert.deepEqual(switchVersions(first), ['0.2.0', '0.1.0'])

  const second = RunPhaseFixture.fromState(first.currentState())
  const replay = await second.runEntry()
  assert.equal(replay.applyOutcome, null)
  assert.equal(second.snapshotCalls, 0)
  assert.equal(second.restoreCalls, 0)
  assert.equal(second.switchCalls, 0)
})

test('apply-now snapshot failure is a terminal snapshot-failed state with a retry-apply exit', async () => {
  const fixture = new RunPhaseFixture({ override: pendingOverride(), snapshotThrows: true })
  const first = await fixture.applyNow()
  assert.equal(first.applyOutcome?.status, 'snapshot-failed')
  assert.equal(first.blockedReason, 'snapshot-failed')
  assert.equal(first.applyOutcome?.retryAction, 'apply')
  assert.equal(fixture.currentState().pointer, '0.1.0')
  assert.equal(fixture.switchCalls, 0)
  assert.equal(eventCount(fixture, 'probe'), 0)
  assert.equal(fixture.currentState().journal.kind, 'missing')
  assert.equal(fixture.currentState().override?.lastOutcome, 'snapshot-failed')
  assert.equal(fixture.currentState().override?.pending, '0.2.0')

  // No automatic re-attempt on the next boot.
  const replay = await fixture.runEntry()
  assert.equal(replay.blockedReason, 'snapshot-failed')
  assert.equal(fixture.snapshotCalls, 1)

  // retry-apply exit: the host clears the durable gate flag and re-runs.
  const override = fixture.currentState().override
  assert.ok(override !== null)
  fixture.snapshotThrows = false
  fixture.writeOverride({ ...override, lastOutcome: null, lastError: null })
  const retried = await fixture.runEntry()
  assert.equal(retried.applyOutcome?.status, 'applied')
  assert.equal(fixture.snapshotCalls, 2)
  assert.equal(fixture.currentState().pointer, '0.2.0')
})

// ---------------------------------------------------------------------------
// 6. S1 host-abort seam — signal forwarding + transaction-level cancellation
// ---------------------------------------------------------------------------

test('the ApplyOptions.signal is forwarded verbatim to every candidate probe (S1 seam)', async () => {
  const fixture = new RunPhaseFixture()
  const controller = new AbortController()
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0',
    builtinVersion: fixture.builtinVersion,
    sourceVersion: '0.1.0',
    sourceWasKnownGood: true,
    knownGoodVersion: '0.1.0',
    signal: controller.signal,
    deps: fixture.makeApplyDeps(),
  })
  assert.equal(outcome.status, 'applied')
  // The seam forwards the exact host signal object — never wraps or drops it.
  assert.ok(fixture.probeSignals.length >= 1)
  for (const received of fixture.probeSignals) assert.equal(received, controller.signal)
})

test('a pre-aborted signal cancels the transaction immediately with zero side effects', async () => {
  const fixture = new RunPhaseFixture({ override: pendingOverride() })
  const controller = new AbortController()
  controller.abort()
  const result = await applyPendingVersion({
    pendingVersion: '0.2.0',
    builtinVersion: fixture.builtinVersion,
    sourceVersion: '0.1.0',
    sourceWasKnownGood: true,
    knownGoodVersion: '0.1.0',
    signal: controller.signal,
    deps: fixture.makeApplyDeps(),
  })
  // Defined failure outcome: host-abort message, pending retained, runtime
  // not blocked, no failure kind — the durable journal stays for the next
  // startup to resume idempotently.
  assert.equal(result.status, 'failed')
  assert.equal(result.retainPending, true)
  assert.equal(result.runtimeBlocked, false)
  assert.equal(result.retryAction, null)
  assert.equal(result.failureKind, null)
  assert.ok(result.error !== null && result.error.includes('中止'))
  // Zero side effects: no snapshot, no pointer switch, no probe, no stop, no
  // journal write — durable state is untouched.
  assert.equal(fixture.snapshotCalls, 0)
  assert.equal(fixture.switchCalls, 0)
  assert.equal(eventCount(fixture, 'probe'), 0)
  assert.equal(eventCount(fixture, 'stop'), 0)
  assert.equal(fixture.currentState().journal.kind, 'missing')
  assert.equal(fixture.currentState().pointer, '0.1.0')
  assert.equal(fixture.currentState().override?.pending, '0.2.0')
})

test('an abort after the candidate verdict does not poison the rollback verification probe', async () => {
  const fixture = new RunPhaseFixture({ override: pendingOverride() })
  const controller = new AbortController()
  fixture.setProbe(async version => version === '0.2.0' ? failProbes() : passProbes())
  const deps = fixture.makeApplyDeps()
  const stopHost = deps.stopHost
  // The candidate verdict fails normally, the transaction commits to rollback,
  // and the host aborts at the first rollback side effect — before the
  // rollback target verification probe runs.
  deps.stopHost = async () => {
    controller.abort()
    await stopHost()
  }
  const result = await applyPendingVersion({
    pendingVersion: '0.2.0',
    builtinVersion: fixture.builtinVersion,
    sourceVersion: '0.1.0',
    sourceWasKnownGood: true,
    knownGoodVersion: '0.1.0',
    signal: controller.signal,
    deps,
  })
  // The rollback target is still honestly verified (with an un-aborted signal)
  // and passes: rolled-back — never the "candidate + fallback + builtin all
  // failed" terminal state.
  assert.equal(result.status, 'rolled-back')
  assert.equal(result.rollbackTarget, '0.1.0')
  assert.equal(result.restoreOutcome, 'complete')
  assert.equal(result.error, null)
  assert.equal(fixture.restoreCalls, 1)
  assert.deepEqual(switchVersions(fixture), ['0.2.0', '0.1.0'])
  // Candidate probes saw the host signal (passthrough — abort takes effect at
  // the probe seam); the rollback verification probe saw an un-aborted signal
  // (undefined), never the aborted controller signal.
  const candidateSignals = fixture.probeSignals.slice(0, 2)
  assert.ok(candidateSignals.every(s => s === controller.signal))
  const verificationSignal = fixture.probeSignals[2]
  assert.notEqual(verificationSignal, controller.signal)
  assert.ok((verificationSignal?.aborted ?? false) !== true)
})

// ---------------------------------------------------------------------------
// 7. Startup-entry abort — runStartupPhase/runDelayedRollback signal forwarding
// ---------------------------------------------------------------------------

test('runStartupPhase entry abort: a pre-aborted signal cancels the apply with zero side effects', async () => {
  const fixture = new RunPhaseFixture({ override: pendingOverride() })
  const controller = new AbortController()
  controller.abort()
  const result = await fixture.runEntry(controller.signal)
  // Defined abort failure outcome: host-abort message, pending retained,
  // runtime not blocked, no failure kind — the durable journal stays for the
  // next startup to resume idempotently.
  assert.equal(result.applyOutcome?.status, 'failed')
  assert.ok(result.applyOutcome?.error !== null && result.applyOutcome.error.includes('中止'))
  assert.equal(result.applyOutcome?.retainPending, true)
  assert.equal(result.applyOutcome?.runtimeBlocked, false)
  assert.equal(result.applyOutcome?.retryAction, null)
  assert.equal(result.applyOutcome?.failureKind, null)
  assert.equal(result.blockedReason, null)
  // Zero side effects at the apply entry: no snapshot, no pointer switch, no
  // probe, no stop, no journal write — durable state is untouched apart from
  // the verdict record retaining pending.
  assert.equal(fixture.snapshotCalls, 0)
  assert.equal(fixture.switchCalls, 0)
  assert.equal(eventCount(fixture, 'probe'), 0)
  assert.equal(eventCount(fixture, 'stop'), 0)
  assert.equal(fixture.currentState().journal.kind, 'missing')
  assert.equal(fixture.currentState().pointer, '0.1.0')
  assert.equal(fixture.currentState().override?.pending, '0.2.0')
})

test('runStartupPhase entry abort with no pending: the signal is never consulted and nothing runs', async () => {
  const fixture = new RunPhaseFixture()
  const controller = new AbortController()
  controller.abort()
  const result = await fixture.runEntry(controller.signal)
  assert.equal(result.applyOutcome, null)
  assert.equal(result.blockedReason, null)
  assert.equal(fixture.snapshotCalls, 0)
  assert.equal(fixture.switchCalls, 0)
  assert.equal(eventCount(fixture, 'probe'), 0)
  assert.equal(eventCount(fixture, 'stop'), 0)
  assert.equal(fixture.currentState().journal.kind, 'missing')
  assert.equal(fixture.currentState().pointer, '0.1.0')
})

test('runDelayedRollback forwards the signal: a pre-aborted signal cancels after the durable F7 latch', async () => {
  const fixture = new RunPhaseFixture({
    pointer: '0.2.0',
    journal: { kind: 'valid', journal: monitoringJournal() },
  })
  const controller = new AbortController()
  controller.abort()
  const outcome = await runDelayedRollback(
    fixture.makeStartupDeps(),
    monitoringJournal(),
    controller.signal,
  )
  // The F7 latch is durable before the abort cancels the rollback: the journal
  // advanced to rollback-needed, but no stop/switch/restore/probe ran.
  assert.equal(outcome.status, 'failed')
  assert.ok(outcome.error !== null && outcome.error.includes('中止'))
  assert.equal(outcome.retainPending, true)
  assert.equal(outcome.runtimeBlocked, false)
  const state = fixture.currentState()
  assert.equal(state.journal.kind, 'valid')
  if (state.journal.kind === 'valid') {
    assert.equal(state.journal.journal.phase, 'rollback-needed')
    assert.equal(state.journal.journal.rollbackTarget, '0.1.0')
  }
  assert.equal(fixture.restoreCalls, 0)
  assert.equal(fixture.switchCalls, 0)
  assert.equal(eventCount(fixture, 'stop'), 0)
  assert.equal(eventCount(fixture, 'probe'), 0)
})

test('probe-in-flight abort cancels at the rollback entry; a fresh re-entry resumes idempotently', async () => {
  // Regression (scan P2-2): the continueRollback entry abort check is
  // load-bearing. Without it the first run would skip the abort, complete the
  // rollback and return 'rolled-back' instead of the defined abort failure —
  // this test turns red when that check is deleted.
  const first = new RunPhaseFixture({ override: pendingOverride() })
  const controller = new AbortController()
  first.setProbe(async version => {
    if (version === '0.2.0') {
      controller.abort()
      return failProbes()
    }
    return passProbes()
  })
  const result = await first.runEntry(controller.signal)
  // The candidate verdict failed and the rollback was durably committed
  // (rollback-needed), but the abort arrived at the rollback entry: defined
  // abort failure — pending retained, runtime not blocked.
  assert.equal(result.applyOutcome?.status, 'failed')
  assert.ok(result.applyOutcome?.error !== null && result.applyOutcome.error.includes('中止'))
  assert.equal(result.applyOutcome?.retainPending, true)
  assert.equal(result.applyOutcome?.runtimeBlocked, false)
  // Durable state: journal advanced to rollback-needed with the rollback
  // target; the pointer stayed on the switched candidate.
  const state = first.currentState()
  assert.equal(state.journal.kind, 'valid')
  if (state.journal.kind === 'valid') {
    assert.equal(state.journal.journal.phase, 'rollback-needed')
    assert.equal(state.journal.journal.rollbackTarget, '0.1.0')
  }
  assert.equal(state.pointer, '0.2.0')
  assert.equal(state.override?.pending, '0.2.0')
  assert.equal(first.snapshotCalls, 1)
  assert.equal(first.restoreCalls, 0)

  // Re-enter from the durable state with a fresh, un-aborted signal: the
  // journal continuation completes the rollback exactly once — no second
  // snapshot, no second restore, no repeated rollback.
  const second = RunPhaseFixture.fromState(state)
  const resumeController = new AbortController()
  const resumed = await second.runEntry(resumeController.signal)
  assert.equal(resumed.applyOutcome?.status, 'rolled-back')
  assert.equal(resumed.applyOutcome?.rollbackTarget, '0.1.0')
  assert.equal(resumed.applyOutcome?.restoreOutcome, 'complete')
  assert.equal(first.snapshotCalls + second.snapshotCalls, 1)
  assert.equal(first.restoreCalls + second.restoreCalls, 1)
  assert.deepEqual(
    [...switchVersions(first), ...switchVersions(second)],
    ['0.2.0', '0.1.0'],
  )
  const finalState = second.currentState()
  assert.equal(finalState.journal.kind, 'missing')
  assert.equal(finalState.pointer, '0.1.0')
  assert.equal(finalState.override?.pending, null)
  assert.equal(finalState.override?.chosenVersion, '0.1.0')
})
