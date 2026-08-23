/**
 * apply-phase.ts tests (design 16 §3.3/§3.4) — node:test, injected deps mock
 * snapshot/switchPointer/probe/restore/markKnownGood. Asserts the activation
 * flow: no-snapshot-no-switch, probe-gated pass/fail, and rollback target.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPendingVersion } from './apply-phase.ts';
import type { ApplyDeps } from './apply-phase.ts';
import type { ProbeResult } from './activation-gate.ts';

interface Rec {
  switches: string[]
  knownGood: string[]
  restorePath: string | null
}

function makeDeps(rec: Rec, probes: () => ProbeResult[], restoreOutcome: 'complete' | 'half' | 'incomplete' = 'complete', snapshotThrows = false): ApplyDeps {
  return {
    snapshot: async (v) => {
      if (snapshotThrows) throw new Error('ENOSPC');
      return `/snap/${v}`;
    },
    switchPointer: (v) => { rec.switches.push(v); },
    probe: async () => probes(),
    restore: async (p) => { rec.restorePath = p; return restoreOutcome; },
    recordProbePass: (v) => { rec.knownGood.push(v); },
  };
}

function pass(): ProbeResult[] { return [{ name: 'host.describe', ok: true }]; }
function fail(): ProbeResult[] { return [{ name: 'host.describe', ok: false }]; }

test('snapshot failure aborts — no switchPointer, status failed', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', sourceVersion: '0.1.1-rc.2', knownGoodVersion: null,
    deps: makeDeps(rec, pass, 'complete', true),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(rec.switches.length, 0);
});

test('probe pass → applied, marks known-good, switches to pending', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', sourceVersion: '0.1.1-rc.2', knownGoodVersion: null,
    deps: makeDeps(rec, pass),
  });
  assert.equal(outcome.status, 'applied');
  assert.deepEqual(rec.switches, ['0.2.0']);
  assert.deepEqual(rec.knownGood, ['0.2.0']);
});

test('probe fail → rolled-back, restore called, switch back to source (known-good)', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', sourceVersion: '0.1.1-rc.2', knownGoodVersion: '0.1.1-rc.2',
    deps: makeDeps(rec, fail),
  });
  assert.equal(outcome.status, 'rolled-back');
  assert.equal(rec.restorePath, '/snap/0.1.1-rc.2');
  assert.deepEqual(rec.switches, ['0.2.0', '0.1.1-rc.2']); // pending then rollback to source
});

test('probe observe then fail → still rolled-back (delayed verdict)', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  let calls = 0;
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', sourceVersion: '0.1.1-rc.2', knownGoodVersion: '0.1.1-rc.2',
    deps: makeDeps(rec, () => { calls += 1; return calls === 1 ? fail() : fail(); }),
  });
  assert.equal(outcome.status, 'rolled-back');
  assert.equal(calls, 2); // observe once, then final verdict
});

test('rollback target falls to known-good when source not trusted', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.3.0', sourceVersion: '0.2.0', knownGoodVersion: '0.1.1-rc.2',
    deps: makeDeps(rec, fail),
  });
  assert.equal(outcome.status, 'rolled-back');
  assert.deepEqual(rec.switches, ['0.3.0', '0.1.1-rc.2']); // source not trusted → known-good
});

test('restore incomplete → rolled-back with loud error', async () => {
  const rec: Rec = { switches: [], knownGood: [], restorePath: null };
  const outcome = await applyPendingVersion({
    pendingVersion: '0.2.0', sourceVersion: '0.1.1-rc.2', knownGoodVersion: '0.1.1-rc.2',
    deps: makeDeps(rec, fail, 'incomplete'),
  });
  assert.equal(outcome.status, 'rolled-back');
  assert.match(outcome.error ?? '', /数据恢复未完成/);
});
