/**
 * snapshot-store.ts tests (design 16 §3.7) — node:test, real temp filesystem
 * (mkdtempSync), copyFn injected for the ENOSPC/failure branches. Asserts the
 * data-protection invariants: still-copy snapshot, atomic publish, two-phase
 * restore with idempotent completion, no-snapshot-no-switch (snapshot throw),
 * and the one-stash pre-rollback bound.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshotPaths, snapshotDshHome, restoreSnapshot, stashPreRollback } from './snapshot-store.ts';

function makeDirs() {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-snap-'));
  const dshHome = path.join(base, 'state', 'dsh-home');
  mkdirSync(dshHome, { recursive: true });
  return { base, dshHome };
}

function put(dir: string, file: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), content, 'utf8');
}

test('snapshotDshHome: still-copies dshHome into snapshots/<source>-<ts>, source untouched', async () => {
  const { base, dshHome } = makeDirs();
  put(dshHome, 'settings.yaml', 'x: 1');
  const snap = await snapshotDshHome(base, dshHome, '0.1.1-rc.2');
  assert.ok(snap.startsWith(snapshotPaths(base).snapshotsDir));
  assert.match(path.basename(snap), /^0\.1\.1-rc\.2-\d+$/);
  assert.equal(readFileSync(path.join(snap, 'settings.yaml'), 'utf8'), 'x: 1');
  assert.equal(readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8'), 'x: 1'); // source untouched
});

test('snapshotDshHome: missing dshHome still publishes an (empty) snapshot', async () => {
  const { base, dshHome } = makeDirs();
  // remove dshHome to simulate "source version had no data"
  const { rmSync } = await import('node:fs');
  rmSync(dshHome, { recursive: true, force: true });
  const snap = await snapshotDshHome(base, dshHome, '0.1.1-rc.2');
  assert.ok(existsSync(snap));
  assert.equal(readdirSync(snap).length, 0);
});

test('snapshotDshHome: copy failure throws (no-snapshot-no-switch)', async () => {
  const { base, dshHome } = makeDirs();
  put(dshHome, 'a', 'b');
  await assert.rejects(
    snapshotDshHome(base, dshHome, '0.1.1-rc.2', async () => { throw new Error('ENOSPC'); }),
    /ENOSPC/,
  );
  assert.equal(readdirSync(snapshotPaths(base).snapshotsDir).length, 0);
});

test('restoreSnapshot: complete replaces dshHome, clears marker and .old', async () => {
  const { base, dshHome } = makeDirs();
  put(dshHome, 'current.txt', 'new-data');
  const snap = await snapshotDshHome(base, dshHome, '0.1.1-rc.2');
  // mutate dshHome to represent "bad new version wrote incompatible data"
  put(dshHome, 'bad.txt', 'corrupt');
  const outcome = await restoreSnapshot(base, dshHome, snap);
  assert.equal(outcome, 'complete');
  assert.equal(readFileSync(path.join(dshHome, 'current.txt'), 'utf8'), 'new-data');
  assert.ok(existsSync(`${dshHome}.old`)); // 现场保留：失败前的当前数据留在 .old
  assert.ok(existsSync(path.join(`${dshHome}.old`, 'bad.txt')));
  assert.ok(!existsSync(snapshotPaths(base).restoreMarker));
});

test('restoreSnapshot: idempotent — marker + already-restored dshHome + .old → clear marker only', async () => {
  const { base, dshHome } = makeDirs();
  put(dshHome, 'restored.txt', 'ok');
  // P2-1: the「already restored」state requires the backup step to have run —
  // `.old` exists (the pre-restore data) AND dshHome is non-empty (the copy
  // landed). Without `.old` it is「not started」, not「already restored」.
  put(`${dshHome}.old`, 'backup.txt', 'pre-restore');
  const { restoreMarker } = snapshotPaths(base);
  mkdirSync(path.dirname(restoreMarker), { recursive: true });
  writeFileSync(restoreMarker, JSON.stringify({ snapshotPath: '/none', startedAt: 0 }), 'utf8');
  const outcome = await restoreSnapshot(base, dshHome, '/none');
  assert.equal(outcome, 'complete');
  assert.ok(!existsSync(restoreMarker));
  assert.equal(readFileSync(path.join(dshHome, 'restored.txt'), 'utf8'), 'ok'); // untouched
});

test('restoreSnapshot: idempotent — marker + .old + snapshot present → continue restore', async () => {
  const { base, dshHome } = makeDirs();
  put(dshHome, 'good.txt', 'good');
  const snap = await snapshotDshHome(base, dshHome, '0.1.1-rc.2');
  const { restoreMarker } = snapshotPaths(base);
  // Simulate interruption: dshHome already moved to .old, marker present.
  const { renameSync } = await import('node:fs');
  renameSync(dshHome, `${dshHome}.old`);
  writeFileSync(restoreMarker, JSON.stringify({ snapshotPath: snap, startedAt: 0 }), 'utf8');
  const outcome = await restoreSnapshot(base, dshHome, snap);
  assert.equal(outcome, 'complete');
  assert.equal(readFileSync(path.join(dshHome, 'good.txt'), 'utf8'), 'good');
  assert.ok(!existsSync(restoreMarker));
});

test('restoreSnapshot: marker + snapshot missing + .old → incomplete (keep .old)', async () => {
  const { base, dshHome } = makeDirs();
  put(`${dshHome}.old`, 'old.txt', 'old-data');
  const { restoreMarker } = snapshotPaths(base);
  mkdirSync(path.dirname(restoreMarker), { recursive: true });
  writeFileSync(restoreMarker, JSON.stringify({ snapshotPath: '/missing', startedAt: 0 }), 'utf8');
  const outcome = await restoreSnapshot(base, dshHome, '/missing');
  assert.equal(outcome, 'incomplete');
  assert.ok(existsSync(`${dshHome}.old`)); // .old preserved
});

test('restoreSnapshot: snapshot copy fails → half (current data preserved in .old)', async () => {
  const { base, dshHome } = makeDirs();
  put(dshHome, 'current.txt', 'current');
  const snap = await snapshotDshHome(base, dshHome, '0.1.1-rc.2');
  const outcome = await restoreSnapshot(base, dshHome, snap, async () => { throw new Error('copy fail'); });
  assert.equal(outcome, 'half');
  assert.ok(existsSync(`${dshHome}.old`));
  assert.equal(readFileSync(path.join(`${dshHome}.old`, 'current.txt'), 'utf8'), 'current');
});

test('stashPreRollback: stashes dshHome; second call clears the older stash (bound = 1)', async () => {
  const { base, dshHome } = makeDirs();
  put(dshHome, 'v1.txt', 'one');
  const s1 = await stashPreRollback(base, dshHome);
  assert.ok(existsSync(path.join(s1, 'v1.txt')));
  // recreate dshHome with newer data
  put(dshHome, 'v2.txt', 'two');
  const s2 = await stashPreRollback(base, dshHome);
  assert.ok(existsSync(path.join(s2, 'v2.txt')));
  const entries = readdirSync(snapshotPaths(base).preRollbackDir);
  assert.equal(entries.length, 1); // older stash removed
});
