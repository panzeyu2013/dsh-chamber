/**
 * Local-card runtime spawn gate (design 18 §3.6 「applying 相位门控」/ :245-247).
 * Plain node:test, no dsh, no React.
 *
 * The defect this file locks: the local card has TWO entries that spawn the
 * local instance — 「启动」 and 「清理并接管」 (POST
 * /api/connections/local/reclaim clears this state directory's own stale
 * writers and then STARTS the instance; control-plane/src/api.ts:26-28). design
 * 18:245-247 requires EVERY spawn entry to be gated while the dsh runtime is
 * applying / not yet proven safe, but the reclaim entry carried no verdict and
 * its button was disabled only by its own busy flag.
 *
 * Coverage split: local-spawn-gate.ts is exercised as a pure projection; the
 * component wiring (both entries early-return on the ONE shared verdict and
 * both controls carry it) is pinned by a narrow source lock — the same
 * source-wiring discipline plugin-diagnostic.test.ts already uses for this
 * package's un-renderable .tsx surfaces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localSpawnGate, type LocalSpawnGateFacts } from '../../src/client/local-spawn-gate.ts';
import { en, zh } from '../../src/locales.ts';

/** Facts for one card state; nothing is gated unless the caller says so. */
function facts(over: Partial<LocalSpawnGateFacts>): LocalSpawnGateFacts {
  return { blocked: false, hydrating: false, phase: 'idle', runtimeBlockedReason: null, ...over };
}

/* ---- 1. The projection: one verdict for every spawn entry ---- */

test('localSpawnGate: an unblocked runtime gates nothing and renders no reason row', () => {
  assert.deepEqual(localSpawnGate(facts({})), { blocked: false, reasonKey: null, reasonDetail: null });
  // An idle state that happens to carry a stale reason string still renders
  // nothing while the gate is open: the reason rides the blocked verdict only.
  assert.deepEqual(
    localSpawnGate(facts({ runtimeBlockedReason: 'leftover' })),
    { blocked: false, reasonKey: null, reasonDetail: null },
  );
});

test('localSpawnGate: bridge hydration is the first reason (fail closed before any fact)', () => {
  const verdict = localSpawnGate(facts({ blocked: true, hydrating: true }));
  assert.deepEqual(verdict, { blocked: true, reasonKey: 'localRuntimeHydrating', reasonDetail: null });
  assert.match(zh.localRuntimeHydrating, /暂不启动/u);
  assert.match(en.localRuntimeHydrating, /before the local instance can start/u);
});

test('localSpawnGate: applying keeps its own copy', () => {
  const verdict = localSpawnGate(facts({ blocked: true, phase: 'applying' }));
  assert.deepEqual(verdict, { blocked: true, reasonKey: 'localRuntimeApplying', reasonDetail: null });
  assert.match(zh.localRuntimeApplying, /不能启动本地实例/u);
});

test('localSpawnGate: a server-provided block reason is shown verbatim under the shared copy', () => {
  const verdict = localSpawnGate(facts({ blocked: true, runtimeBlockedReason: 'DSH_HOME metadata is being recovered' }));
  assert.deepEqual(verdict, {
    blocked: true,
    reasonKey: 'localRuntimeBlocked',
    reasonDetail: 'DSH_HOME metadata is being recovered',
  });
});

test('localSpawnGate: an absent/blank/whitespace reason falls back to the localized sentence', () => {
  for (const reason of [null, undefined, '', '   ']) {
    const verdict = localSpawnGate(facts({ blocked: true, runtimeBlockedReason: reason }));
    assert.deepEqual(verdict, { blocked: true, reasonKey: 'localRuntimeBlocked', reasonDetail: null }, String(reason));
  }
});

test('localSpawnGate: every residual gate reason still NAMES itself (disabled never without a cause)', () => {
  // runtimeBlocksLocalStart also blocks on canRetryRestore and a half /
  // incomplete data restore. Those states carry no phase and no main-process
  // reason string, so an inline ladder must render a reason row for them:
  // otherwise the entry is disabled with no visible cause. The projection is
  // total — every blocked verdict renders exactly one row.
  for (const residual of [
    { phase: 'idle' as const },
    { phase: 'rollback' as const },
    { phase: undefined },
  ]) {
    const verdict = localSpawnGate(facts({ blocked: true, ...residual }));
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.reasonKey, 'localRuntimeBlocked', JSON.stringify(residual));
    assert.equal(verdict.reasonDetail, null);
  }
});

test('localSpawnGate: every reason key exists in both dictionaries', () => {
  const keys = (['hydrating', 'applying', 'blocked', 'both'] as const).map(kind => localSpawnGate(facts({
    blocked: true,
    hydrating: kind === 'hydrating' || kind === 'both',
    phase: kind === 'applying' || kind === 'both' ? 'applying' : 'idle',
  })).reasonKey);
  for (const key of keys) {
    assert.notEqual(key, null);
    assert.equal(typeof zh[key as keyof typeof zh], 'string', key as string);
    assert.equal(typeof en[key as keyof typeof en], 'string', key as string);
    assert.notEqual(zh[key as keyof typeof zh].trim(), '');
  }
});

/* ---- 2. The wiring: ONE verdict, both spawn entries, both controls ---- */

const shellSource = readFileSync(new URL('../../src/client/ConnectionsSection.tsx', import.meta.url), 'utf8');

test('the card derives the gate once from the authoritative runtime verdict', () => {
  assert.match(shellSource, /const spawnGate = localSpawnGate\(\{/, 'the card must read the shared projection');
  assert.match(shellSource, /blocked: runtimeBlocksLocalStart\(runtimeState, runtimeSurfacePresent\)/,
    'the projection reads the renderer verdict as input — it never re-implements the gate');
  assert.equal(shellSource.match(/runtimeBlocksLocalStart\(/g)?.length, 1,
    'exactly one gate derivation: a second copy could drift');
  assert.doesNotMatch(shellSource, /runtimeStartBlocked/, 'the pre-fix per-entry boolean must not come back');
});

test('both spawn entries early-return on that one verdict', () => {
  const startAt = shellSource.indexOf('const startLocal = useCallback(');
  const reclaimAt = shellSource.indexOf('const reclaimLocal = useCallback(');
  const stopAt = shellSource.indexOf('const stopLocal = useCallback(');
  assert.ok(startAt > 0 && reclaimAt > startAt && stopAt > reclaimAt, 'the two spawn entries must both exist');
  assert.match(shellSource.slice(startAt, reclaimAt), /if \(spawnGate\.blocked\) return/,
    'startLocal must keep its gate');
  const reclaimBody = shellSource.slice(reclaimAt, stopAt);
  assert.match(reclaimBody, /if \(spawnGate\.blocked\) return/,
    'reclaimLocal must not spawn while the runtime gate is closed (P0-4)');
  assert.match(reclaimBody, /await cp\.reclaimLocal\(\)/,
    'the guarded function is the one that reaches the spawn route');
});

test('both controls carry the same verdict (no visible-but-live entry)', () => {
  assert.match(shellSource, /disabled=\{healthy \|\| starting \|\| localBusy \|\| stopping \|\| spawnGate\.blocked\}/,
    'the start button is disabled while gated');
  assert.match(shellSource, /disabled=\{reclaiming \|\| spawnGate\.blocked\}/,
    'the reclaim button is disabled while gated');
  assert.match(shellSource, /spawnGate\.reasonKey !== null/, 'the one reason row renders for every gated entry');
});
