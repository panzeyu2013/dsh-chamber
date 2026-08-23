import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldPromote, recordProbePass, noteBoot, promoteDueCandidates, removeKnownGoodCandidate, resetCandidateHealthWindow, knownGoodCandidatesPath, DEFAULT_HEALTH_POLICY } from './known-good-monitor.ts';

function makeVersionTree(base: string, version: string) {
  const tree = join(base, 'dsh-runtime', version);
  const bin = join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bin.js'), '// fixture');
  writeFileSync(join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version,
  }));
  const criticalFiles = Object.fromEntries([
    'node_modules/@deepseek-ai/dsh/package.json',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].map(relativePath => [
    relativePath,
    `sha256-${createHash('sha256').update(readFileSync(join(tree, relativePath))).digest('base64')}`,
  ]));
  writeFileSync(join(tree, 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh': version },
    dsh: { platform: `${process.platform}-${process.arch}`, criticalFiles },
  }));
}

function knownGoodVersions(base: string): string[] {
  const file = join(base, 'dsh-runtime', 'known-good.json');
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { versions?: Record<string, string> };
  return Object.keys(parsed.versions ?? {});
}

test('shouldPromote: requires BOTH min uptime AND min boots (§3.4 sustained-health gate)', () => {
  const t0 = 1_000_000_000_000;
  const policy = { minUptimeMs: 1000, minBoots: 2 };
  // Uptime not met, boots not met → false
  assert.equal(shouldPromote({ firstProbePassAt: t0, bootCount: 0, healthWindowStartedAt: t0, healthWindowResetAt: null }, t0 + 500, policy), false);
  // Uptime met, boots not met → false
  assert.equal(shouldPromote({ firstProbePassAt: t0, bootCount: 1, healthWindowStartedAt: t0, healthWindowResetAt: null }, t0 + 2000, policy), false);
  // Uptime not met, boots met → false
  assert.equal(shouldPromote({ firstProbePassAt: t0, bootCount: 2, healthWindowStartedAt: t0, healthWindowResetAt: null }, t0 + 500, policy), false);
  // Both met → true
  assert.equal(shouldPromote({ firstProbePassAt: t0, bootCount: 2, healthWindowStartedAt: t0, healthWindowResetAt: null }, t0 + 2000, policy), true);
  // A closed/legacy window can never be promoted from wall-clock age alone.
  assert.equal(shouldPromote({ firstProbePassAt: t0, bootCount: 2, healthWindowStartedAt: null, healthWindowResetAt: t0 }, t0 + 2000, policy), false);
});

test('recordProbePass → noteBoot → promoteDueCandidates: candidate becomes known-good only when due', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-'));
  const t0 = 1_000_000_000_000;
  makeVersionTree(base, '0.2.0');
  recordProbePass(base, '0.2.0', t0);
  // Not due (0 boots, < 24h) → no promotion
  assert.deepEqual(promoteDueCandidates(base, t0 + 1000), []);
  noteBoot(base, '0.2.0', t0 + 500);
  // Still not due (< 24h) → no promotion
  assert.deepEqual(promoteDueCandidates(base, t0 + 1000), []);
  // After 24h + 1 boot → promoted
  const promoted = promoteDueCandidates(base, t0 + DEFAULT_HEALTH_POLICY.minUptimeMs + 1);
  assert.deepEqual(promoted, ['0.2.0']);
  assert.deepEqual(knownGoodVersions(base), ['0.2.0']);
});

test('offline wall clock: reopening after 24h resets the window and does not promote', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-'));
  const t0 = 1_000_000_000_000;
  makeVersionTree(base, '0.2.0');
  recordProbePass(base, '0.2.0', t0);
  noteBoot(base, '0.2.0', t0 + 1000);

  // The app/host was offline. Main invokes this at the next startup before
  // probing, so the 24h wall-clock gap is not trusted as healthy uptime.
  const reopenedAt = t0 + DEFAULT_HEALTH_POLICY.minUptimeMs + 10_000;
  resetCandidateHealthWindow(base, reopenedAt);
  noteBoot(base, '0.2.0', reopenedAt + 1000);
  assert.deepEqual(promoteDueCandidates(base, reopenedAt + 1001), []);
  assert.deepEqual(knownGoodVersions(base), []);
});

test('continuous healthy window: 24h plus a successful boot promotes', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-'));
  const t0 = 1_000_000_000_000;
  makeVersionTree(base, '0.2.0');
  recordProbePass(base, '0.2.0', t0);
  noteBoot(base, '0.2.0', t0 + 1000);
  assert.deepEqual(promoteDueCandidates(base, t0 + DEFAULT_HEALTH_POLICY.minUptimeMs - 1), []);
  assert.deepEqual(promoteDueCandidates(base, t0 + DEFAULT_HEALTH_POLICY.minUptimeMs), ['0.2.0']);
});

test('failed health window resets both elapsed health and boot qualification', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-'));
  const t0 = 1_000_000_000_000;
  const policy = { minUptimeMs: 10_000, minBoots: 1 };
  makeVersionTree(base, '0.2.0');
  recordProbePass(base, '0.2.0', t0);
  noteBoot(base, '0.2.0', t0 + 1000);

  resetCandidateHealthWindow(base, t0 + 9000);
  assert.deepEqual(promoteDueCandidates(base, t0 + 20_000, policy), []);
  // A fresh successful boot opens a new window, but it must earn the full
  // duration after the failure rather than inheriting the old 9 seconds.
  noteBoot(base, '0.2.0', t0 + 20_000);
  assert.deepEqual(promoteDueCandidates(base, t0 + 29_999, policy), []);
  assert.deepEqual(promoteDueCandidates(base, t0 + 30_000, policy), ['0.2.0']);
});

test('legacy candidate is retained but cannot promote from offline age', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-'));
  const t0 = 1_000_000_000_000;
  makeVersionTree(base, '0.2.0');
  const file = knownGoodCandidatesPath(base);
  mkdirSync(join(base, 'dsh-runtime'), { recursive: true });
  writeFileSync(file, JSON.stringify({ versions: { '0.2.0': { firstProbePassAt: t0, bootCount: 99 } } }));
  assert.deepEqual(promoteDueCandidates(base, t0 + DEFAULT_HEALTH_POLICY.minUptimeMs * 10), []);
  assert.deepEqual(knownGoodVersions(base), []);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    versions: Record<string, { bootCount: number; healthWindowStartedAt: number | null }>;
  };
  assert.equal(parsed.versions['0.2.0']?.bootCount, 0);
  assert.equal(parsed.versions['0.2.0']?.healthWindowStartedAt, null);
});

test('promoteDueCandidates: unsafe version never promoted', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-'));
  const t0 = 1_000_000_000_000;
  makeVersionTree(base, '0.2.0');
  recordProbePass(base, '0.2.0', t0);
  // A second candidate that is unsafe would be written by recordProbePass's
  // assertSafeVersion throwing, so verify that path throws instead.
  assert.throws(() => recordProbePass(base, '../evil', t0));
});

test('candidate requires a complete version tree and invalid tree never promotes', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-'));
  assert.throws(() => recordProbePass(base, '0.2.0', 1000), /无效运行时/);
  makeVersionTree(base, '0.2.0');
  recordProbePass(base, '0.2.0', 1000);
  // Break the tree after probe pass; it must remain diagnostic, not trusted.
  writeFileSync(join(base, 'dsh-runtime', '0.2.0', 'package.json'), '{}');
  noteBoot(base, '0.2.0');
  assert.deepEqual(promoteDueCandidates(base, 100_000_000, { minUptimeMs: 0, minBoots: 0 }), []);
  assert.deepEqual(knownGoodVersions(base), []);
});

test('candidate metadata is owner-only and a failed candidate can be removed', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-'));
  makeVersionTree(base, '0.2.0');
  recordProbePass(base, '0.2.0', 1000);
  assert.equal(statSync(join(base, 'dsh-runtime')).mode & 0o777, 0o700);
  assert.equal(statSync(knownGoodCandidatesPath(base)).mode & 0o777, 0o600);
  removeKnownGoodCandidate(base, '0.2.0');
  const parsed = JSON.parse(readFileSync(knownGoodCandidatesPath(base), 'utf8')) as { versions: Record<string, unknown> };
  assert.deepEqual(parsed.versions, {});
});
