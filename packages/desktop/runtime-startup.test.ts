import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStartupPhase, probeKoffiLoadable, type StartupDeps } from './runtime-startup.ts';
import type { ProbeResult } from './activation-gate.ts';

function makeDeps(overrides: Partial<StartupDeps> = {}): StartupDeps {
  return {
    cleanupStaleInstalls: () => [],
    evict: () => [],
    completeInterruptedRestore: async () => 'none',
    readOverride: () => null,
    snapshot: async (v) => `/snap/${v}`,
    switchPointer: () => {},
    spawnAndProbe: async () => [{ name: 'host.describe', ok: true }],
    restore: async () => 'complete',
    recordProbePass: () => {},
    ...overrides,
  };
}

test('runStartupPhase: no pending → skipped (cleanup/evict/restore still run)', async () => {
  const cleaned: string[] = [];
  const evicted: string[] = [];
  const result = await runStartupPhase(makeDeps({
    cleanupStaleInstalls: () => { cleaned.push('.work-abc'); return ['.work-abc']; },
    evict: () => { evicted.push('0.0.9'); return ['0.0.9']; },
    readOverride: () => null,
  }));
  assert.equal(result.applyOutcome, null);
  assert.deepEqual(result.cleanedWorkDirs, ['.work-abc']);
  assert.deepEqual(result.evicted, ['0.0.9']);
});

test('runStartupPhase: pending + probe pass → applied (recordProbePass called)', async () => {
  let passed: string | null = null;
  let switched: string | null = null;
  const result = await runStartupPhase(makeDeps({
    readOverride: () => ({ pending: '0.2.0' }),
    switchPointer: (v) => { switched = v; },
    spawnAndProbe: async () => [{ name: 'host.describe', ok: true }],
    recordProbePass: (v) => { passed = v; },
  }));
  assert.equal(result.applyOutcome?.status, 'applied');
  assert.equal(switched, '0.2.0');
  assert.equal(passed, '0.2.0');
});

test('runStartupPhase: pending + probe fail → rolled-back (restore called, switch back to null target)', async () => {
  let restored: string | null = null;
  const result = await runStartupPhase(makeDeps({
    readOverride: () => ({ pending: '0.2.0' }),
    spawnAndProbe: async () => [{ name: 'host.describe', ok: false, error: 'smoke failed' }],
    restore: async (snap) => { restored = snap; return 'complete'; },
  }));
  assert.equal(result.applyOutcome?.status, 'rolled-back');
  assert.equal(restored, '/snap/unknown');
  assert.equal(result.applyOutcome?.rollbackTarget, null); // no known-good → fall to builtin
});

test('probeKoffiLoadable: missing build dir → not loadable (needs toolchain)', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'dsh-koffi-'));
  const probe = await probeKoffiLoadable(tree);
  assert.equal(probe.ok, false);
  // with a build dir → loadable
  mkdirSync(join(tree, 'node_modules', 'koffi', 'build'), { recursive: true });
  const probe2 = await probeKoffiLoadable(tree);
  assert.equal(probe2.ok, true);
});
