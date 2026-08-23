import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldPromote, recordProbePass, noteBoot, promoteDueCandidates, DEFAULT_HEALTH_POLICY } from './known-good-monitor.ts';

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
  assert.equal(shouldPromote({ firstProbePassAt: t0, bootCount: 0 }, t0 + 500, policy), false);
  // Uptime met, boots not met → false
  assert.equal(shouldPromote({ firstProbePassAt: t0, bootCount: 1 }, t0 + 2000, policy), false);
  // Uptime not met, boots met → false
  assert.equal(shouldPromote({ firstProbePassAt: t0, bootCount: 2 }, t0 + 500, policy), false);
  // Both met → true
  assert.equal(shouldPromote({ firstProbePassAt: t0, bootCount: 2 }, t0 + 2000, policy), true);
});

test('recordProbePass → noteBoot → promoteDueCandidates: candidate becomes known-good only when due', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-'));
  const t0 = 1_000_000_000_000;
  recordProbePass(base, '0.2.0', t0);
  // Not due (0 boots, < 24h) → no promotion
  assert.deepEqual(promoteDueCandidates(base, t0 + 1000), []);
  noteBoot(base, '0.2.0');
  // Still not due (< 24h) → no promotion
  assert.deepEqual(promoteDueCandidates(base, t0 + 1000), []);
  // After 24h + 1 boot → promoted
  const promoted = promoteDueCandidates(base, t0 + DEFAULT_HEALTH_POLICY.minUptimeMs + 1);
  assert.deepEqual(promoted, ['0.2.0']);
  assert.deepEqual(knownGoodVersions(base), ['0.2.0']);
});

test('promoteDueCandidates: unsafe version never promoted', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-kg-'));
  const t0 = 1_000_000_000_000;
  recordProbePass(base, '0.2.0', t0);
  // A second candidate that is unsafe would be written by recordProbePass's
  // assertSafeVersion throwing, so verify that path throws instead.
  assert.throws(() => recordProbePass(base, '../evil', t0));
});
