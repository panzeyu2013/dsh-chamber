/**
 * apply-phase.ts tests (design 18 §3.3/§3.4) — node:test, injected deps mock
 * snapshot/switchPointer/probe/restore/markKnownGood. Asserts the activation
 * flow: no-snapshot-no-switch, probe-gated pass/fail, and rollback target.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPendingVersion } from '../src/apply-phase.ts';
import type { ApplyDeps } from '../src/apply-phase.ts';
import type { ProbeResult } from '../src/activation-gate.ts';
import { REQUIRED_ACTIVATION_PROBES } from '../src/activation-gate.ts';
import type { ActivationJournal } from '../src/dsh-runtime-store.ts';

interface Rec {
  switches: string[]
  knownGood: string[]
  restorePath: string | null
  pointer?: string | null
  journal?: ActivationJournal | null
}

function makeDeps(rec: Rec, probes: () => ProbeResult[], restoreOutcome: 'complete' | 'half' | 'incomplete' = 'complete', snapshotThrows = false): ApplyDeps {
  let probeCalls = 0;
  return {
    snapshot: async (v) => {
      if (snapshotThrows) throw new Error('ENOSPC');
      if (rec.pointer === undefined) rec.pointer = v;
      return `/snap/${v}`;
    },
    resolveSnapshotName: async (name) => `/snap/${name}`,
    prepareManualRollback: async () => ({ snapshotPath: null, stashPath: null }),
    readCurrentPointerState: () => rec.pointer == null
      ? { kind: 'missing' }
      : { kind: 'valid', version: rec.pointer },
    validateTarget: () => ({ ok: true }),
    switchPointer: (v) => { rec.switches.push(v ?? 'builtin'); rec.pointer = v; },
    probe: async () => {
      probeCalls += 1;
      const result = probes();
      // Calls 1/2 are the candidate observation window; call 3 is the
      // rollback target verification and succeeds unless a test overrides it.
      return probeCalls >= 3 && result.some(item => !item.ok) ? pass() : result;
    },
    restore: async (p) => { rec.restorePath = p; return restoreOutcome; },
    stopHost: async () => {},
    waitBeforeRetry: async () => {},
    recordProbePass: (v) => { rec.knownGood.push(v); },
    writeActivationJournal: (journal) => { rec.journal = journal; },
  };
}

function pass(): ProbeResult[] { return REQUIRED_ACTIVATION_PROBES.map(name => ({ name, ok: true })); }
function fail(): ProbeResult[] {
  return pass().map(probe => probe.name === 'session/list' ? { ...probe, ok: false } : probe);
}

function durableJournal(
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
    preSwapSnapshotName: '0.1.0-pre',
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: null,
    nextIntent: null,
    startedAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    ...patch,
  };
}

test('snapshot failure aborts — no switchPointer, status failed', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null, pointer: null };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.1.1-rc.2', knownGoodVersion: null,
    deps: makeDeps(rec, pass, 'complete', true),
  });
  assert.equal(outcome.status, 'snapshot-failed');
  assert.equal(rec.switches.length, 0);
});

test('probe pass → applied, marks known-good, switches to pending', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.1.1-rc.2', knownGoodVersion: null,
    deps: makeDeps(rec, pass),
  });
  assert.equal(outcome.status, 'applied');
  assert.deepEqual(rec.switches, ['0.2.0']);
  assert.deepEqual(rec.knownGood, ['0.2.0']);
});

test('probe fail → rolled-back, restore called, switch back to source (known-good)', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.1.1-rc.2', knownGoodVersion: '0.1.1-rc.2',
    deps: makeDeps(rec, fail),
  });
  assert.equal(outcome.status, 'rolled-back');
  assert.equal(rec.restorePath, '/snap/0.1.1-rc.2');
  assert.deepEqual(rec.switches, ['0.2.0', '0.1.1-rc.2']); // pending then rollback to source
});

test('probe failure stops the host before pointer/data rollback', async () => {
  const order: string[] = [];
  const rec: Rec = { switches: [], knownGood: [], restorePath: null, pointer: null };
  const deps = makeDeps(rec, fail);
  deps.stopHost = async () => { order.push('stop'); };
  deps.switchPointer = (v) => { order.push(`switch:${v ?? 'builtin'}`); rec.pointer = v; };
  deps.restore = async () => { order.push('restore'); return 'complete'; };
  await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.0', sourceVersion: '0.1.0', sourceIsBuiltin: true, knownGoodVersion: null, deps,
  });
  assert.deepEqual(order, ['switch:0.2.0', 'stop', 'switch:builtin', 'restore']);
});

test('failed host stop preserves pointer and snapshot data', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const deps = makeDeps(rec, fail);
  deps.stopHost = async () => { throw new Error('still alive'); };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.1.0', knownGoodVersion: '0.1.0', deps,
  });
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(rec.switches, ['0.2.0']);
  assert.equal(rec.restorePath, null);
  assert.match(outcome.error ?? '', /未触碰数据/);
});

test('probe observe then fail → still rolled-back (delayed verdict)', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  let calls = 0;
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.1.1-rc.2', knownGoodVersion: '0.1.1-rc.2',
    deps: makeDeps(rec, () => { calls += 1; return calls === 1 ? fail() : fail(); }),
  });
  assert.equal(outcome.status, 'rolled-back');
  assert.equal(calls, 3); // observe, final candidate verdict, rollback verification
});

test('rollback target probe failure falls to builtin once and ends loud', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const deps = makeDeps(rec, fail);
  deps.probe = async () => fail();
  const outcome = await applyPendingVersion({
    pendingVersion: '0.3.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.2.0', sourceWasKnownGood: true,
    knownGoodVersion: '0.2.0', deps,
  });
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(rec.switches, ['0.3.0', '0.2.0', 'builtin']);
  assert.match(outcome.error ?? '', /内建运行时探针均失败/);
  assert.equal(outcome.retainPending, true);
  assert.equal(outcome.retryAction, 'apply');
  assert.equal(outcome.runtimeBlocked, true);
});

test('rollback target falls to known-good when source not trusted', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.3.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.2.0', knownGoodVersion: '0.1.1-rc.2',
    deps: makeDeps(rec, fail),
  });
  assert.equal(outcome.status, 'rolled-back');
  assert.deepEqual(rec.switches, ['0.3.0', '0.1.1-rc.2']); // source not trusted → known-good
});

test('restore incomplete → rolled-back with loud error', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.1.1-rc.2', knownGoodVersion: '0.1.1-rc.2',
    deps: makeDeps(rec, fail, 'incomplete'),
  });
  assert.equal(outcome.status, 'rolled-back');
  assert.match(outcome.error ?? '', /数据恢复未完成/);
  assert.equal(outcome.retainPending, true);
  assert.equal(outcome.retryAction, 'restore');
  assert.equal(outcome.runtimeBlocked, true);
});

test('prepared crash replay at target performs no new snapshot or pointer write', async () => {
  const rec: Rec = {
    switches: [], knownGood: [], restorePath: null, pointer: '0.2.0',
    journal: durableJournal('prepared'),
  };
  const deps = makeDeps(rec, pass);
  let snapshots = 0;
  deps.snapshot = async () => { snapshots += 1; throw new Error('must not resnapshot'); };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.1.0',
    sourceWasKnownGood: true, knownGoodVersion: '0.1.0', journal: rec.journal, deps,
  });
  assert.equal(outcome.status, 'applied');
  assert.equal(snapshots, 0);
  assert.deepEqual(rec.switches, []);
  assert.equal(rec.journal?.phase, 'applied-monitoring');
  assert.equal(rec.journal?.preSwapSnapshotName, '0.1.0-pre');
});

test('phase writes preserve a concurrently queued reset-builtin intent', async () => {
  const active = durableJournal('prepared');
  const queued = {
    targetVersion: '0.1.1-rc.2', targetIsBuiltin: true, manualRollback: false, intentKind: 'reset-builtin' as const,
  };
  const rec: Rec = { switches: [], knownGood: [], restorePath: null, pointer: '0.2.0', journal: active };
  const deps = makeDeps(rec, pass);
  deps.readActivationJournal = () => ({ kind: 'valid', journal: { ...active, nextIntent: queued } });
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.1.0',
    sourceWasKnownGood: true, knownGoodVersion: '0.1.0', journal: active, deps,
  });
  assert.equal(outcome.status, 'applied');
  assert.deepEqual(rec.journal?.nextIntent, queued);
});

test('manual rollback journals target snapshot and stash before switching, then restores target data', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null, pointer: '0.2.0' };
  const deps = makeDeps(rec, pass);
  const order: string[] = [];
  deps.snapshot = async version => { order.push(`snapshot:${version}`); return `/snap/${version}-pre`; };
  deps.prepareManualRollback = async version => {
    order.push(`prepare-manual:${version}`);
    return { snapshotPath: `/snap/${version}-historical`, stashPath: `/stash/${version}-current` };
  };
  deps.writeActivationJournal = next => { rec.journal = next; order.push(`journal:${next.phase}`); };
  deps.switchPointer = version => { rec.pointer = version; rec.switches.push(version ?? 'builtin'); order.push(`switch:${version}`); };
  deps.restore = async path => { rec.restorePath = path; order.push(`restore:${path}`); return 'complete'; };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.1.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.2.0',
    sourceWasKnownGood: true, knownGoodVersion: '0.2.0', manualRollback: true, deps,
  });
  assert.equal(outcome.status, 'applied');
  assert.deepEqual(order.slice(0, 6), [
    'snapshot:0.2.0',
    'prepare-manual:0.1.0',
    'journal:prepared',
    'switch:0.1.0',
    'journal:switched',
    'journal:manual-restoring',
  ]);
  assert.ok(order.includes('restore:/snap/0.1.0-historical'));
  assert.equal(rec.journal?.manualDataSnapshotName, '0.1.0-historical');
  assert.equal(rec.journal?.preRollbackStashName, '0.1.0-current');
});

test('a timed-out first probe can recover on a fresh, bounded second probe attempt', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const deps = makeDeps(rec, pass);
  let calls = 0;
  deps.probe = async () => { calls += 1; return calls === 1 ? fail() : pass(); };
  const ticks = [0, 60_001, 70_000, 70_001];
  deps.nowMs = () => ticks.shift() ?? 70_001;
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.1.0',
    sourceWasKnownGood: true, knownGoodVersion: '0.1.0', deps,
  });
  assert.equal(outcome.status, 'applied');
  assert.equal(calls, 2);
  assert.deepEqual(rec.switches, ['0.2.0']);
  assert.equal(rec.restorePath, null);
});

test('rollback probe is routed to rollback version, never the adjudicated target', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const deps = makeDeps(rec, pass);
  const calls: Array<[string, boolean]> = [];
  let attempt = 0;
  deps.probe = async (version, isBuiltin) => {
    calls.push([version, isBuiltin]);
    attempt += 1;
    return attempt <= 2 ? fail() : pass();
  };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.3.0', builtinVersion: '0.1.1-rc.2', sourceVersion: '0.2.0',
    sourceWasKnownGood: true, knownGoodVersion: '0.2.0', deps,
  });
  assert.equal(outcome.status, 'rolled-back');
  assert.deepEqual(calls, [
    ['0.3.0', false],
    ['0.3.0', false],
    ['0.2.0', false],
  ]);
});
