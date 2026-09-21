/**
 * runtimeDiskSummaryAsync 磁盘核算测试（design 18 §3.5），拆分自
 * dsh-runtime-store.test.ts（P0）。共享 fixture：test/support/store-fixtures.ts。
 *
 * 2026-12 单源化：同步孪生 runtimeDiskSummary 已删除，本文件只驱动唯一的异步
 * 单遍实现（含真实布局、硬链接/符号链接、网关布局、错误传播与让渡样本）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  clearActivationJournal,
  recordRuntimeFailure,
  runtimeDiskSummaryAsync,
  writeActivationIntent,
  type RuntimeDiskSummary,
} from '../../src/dsh-runtime-store.ts';
import { freshBase, makeVersionTree } from '../support/store-fixtures.ts';

test('runtimeDiskSummaryAsync accounts every runtime-owned tree, cache, snapshot, and restore backup', async () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  const missing = await runtimeDiskSummaryAsync(base);
  assert.equal(missing.snapshotBytes, 0);
  assert.equal(missing.preRollbackBytes, 0);
  assert.equal(missing.restoreBackupBytes, 0);
  assert.equal(missing.installHomeBytes, 0);
  assert.equal(missing.xdgCacheBytes, 0);
  mkdirSync(path.join(base, 'dsh-runtime', '.pnpm-store'), { recursive: true });
  writeFileSync(path.join(base, 'dsh-runtime', '.pnpm-store', 'x'), 'store');
  mkdirSync(path.join(base, 'dsh-runtime', '.pnpm-cache'), { recursive: true });
  writeFileSync(path.join(base, 'dsh-runtime', '.pnpm-cache', 'x'), 'cache');
  for (const [relative, content] of [
    ['.install-home/home', 'install-home'],
    ['.xdg-cache/cache', 'xdg-cache'],
    ['.work-active/work', 'work'],
    ['snapshots/1.0.0-1/data', 'snapshot'],
    ['pre-rollback/1/data', 'stash'],
  ] as const) {
    const file = path.join(base, 'dsh-runtime', relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  for (const [name, content] of [
    ['dsh-home.old', 'restore-one'],
    ['dsh-home.old-123', 'restore-two'],
  ] as const) {
    const file = path.join(base, 'state', name, 'data');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  recordRuntimeFailure(base, { version: '1.0.0', phase: 'install', error: 'x' });
  const failureBytesBeforeRecovery = (await runtimeDiskSummaryAsync(base)).failureBytes;
  const recoveryEvidence = path.join(base, 'dsh-runtime', 'metadata-recovery-data', 'tx', 'evidence', 'current');
  mkdirSync(path.dirname(recoveryEvidence), { recursive: true });
  writeFileSync(recoveryEvidence, 'metadata-recovery-evidence');
  const rescueEvidence = path.join(base, 'dsh-runtime', 'metadata-recovery-rescue-data', 'tx', 'evidence', 'metadata-recovery.json.prior-corrupt');
  mkdirSync(path.dirname(rescueEvidence), { recursive: true });
  writeFileSync(rescueEvidence, 'opaque-prior-marker-and-stash');
  writeFileSync(path.join(base, 'dsh-runtime', 'metadata-recovery.json'), '{"phase":"finalized"}');
  const publishBackup = path.join(base, 'dsh-runtime', '.1.2.3.publish-backup-deadbeef', 'payload');
  mkdirSync(path.dirname(publishBackup), { recursive: true });
  writeFileSync(publishBackup, Buffer.alloc(1024 * 1024));
  const summary = await runtimeDiskSummaryAsync(base);
  assert.equal(summary.versionTrees, 1);
  assert.ok(summary.versionTreeBytes > 0);
  assert.ok(summary.storeBytes > 0);
  assert.ok(summary.cacheBytes > 0);
  assert.ok(summary.installHomeBytes > 0);
  assert.ok(summary.xdgCacheBytes > 0);
  assert.ok(summary.workBytes > 0);
  assert.ok(summary.failureBytes > 0);
  assert.ok(summary.failureBytes > failureBytesBeforeRecovery + 1024 * 1024,
    'recovery data and a full installer publish backup are quota-visible');
  assert.ok(summary.snapshotBytes > 0);
  assert.ok(summary.preRollbackBytes > 0);
  assert.ok(summary.restoreBackupBytes > 0);
  // This fixture hard-links nothing and every runtime entry falls into a known
  // category, so the deduped total equals the per-path category sum plus the
  // (empty) residue bucket — real totals only ever go BELOW that sum.
  assert.equal(summary.unclassifiedBytes, 0);
  assert.equal(summary.totalBytes,
    summary.versionTreeBytes + summary.storeBytes + summary.cacheBytes
    + summary.installHomeBytes + summary.xdgCacheBytes + summary.workBytes
    + summary.failureBytes + summary.snapshotBytes + summary.preRollbackBytes
    + summary.restoreBackupBytes + summary.unclassifiedBytes);

  const unrelated = path.join(base, 'state', 'dsh-home.oldish', 'data');
  mkdirSync(path.dirname(unrelated), { recursive: true });
  writeFileSync(unrelated, 'must not count');
  assert.equal((await runtimeDiskSummaryAsync(base)).restoreBackupBytes, summary.restoreBackupBytes);

  const unsafeBackupLookalike = path.join(base, 'dsh-runtime', '.1.2.3.publish-backup-not-hex', 'payload');
  mkdirSync(path.dirname(unsafeBackupLookalike), { recursive: true });
  writeFileSync(unsafeBackupLookalike, Buffer.alloc(1024 * 1024));
  assert.equal((await runtimeDiskSummaryAsync(base)).failureBytes, summary.failureBytes,
    'non-installer lookalikes are not claimed as owned failure scenes');
});

test('runtimeDiskSummaryAsync counts a publish-backup symlink itself without following its target', async () => {
  const base = freshBase();
  const outside = path.join(base, 'outside-large');
  writeFileSync(outside, Buffer.alloc(1024 * 1024));
  const link = path.join(base, 'dsh-runtime', '.1.2.3.publish-backup-deadbeef');
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(outside, link, 'file');
  const summary = await runtimeDiskSummaryAsync(base);
  assert.ok(summary.failureBytes > 0);
  assert.ok(summary.failureBytes < 1024 * 1024,
    'quota walk must account the link entry but never follow the external target');
});

test('runtimeDiskSummaryAsync accepts the gateway DSH_HOME layout for restore-backup accounting', async () => {
  const base = freshBase();
  const gatewayHome = path.join(base, 'dsh-home');
  const backup = path.join(base, 'dsh-home.old-123', 'data');
  mkdirSync(path.dirname(backup), { recursive: true });
  writeFileSync(backup, 'gateway-restore-backup');
  assert.equal((await runtimeDiskSummaryAsync(base)).restoreBackupBytes, 0,
    'the desktop default must not claim gateway sibling backups');
  assert.ok((await runtimeDiskSummaryAsync(base, gatewayHome)).restoreBackupBytes > 0,
    'the gateway owner explicitly accounts sibling restore backups');
});

test('runtimeDiskSummaryAsync propagates non-ENOENT accounting errors instead of reporting zero', async () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  // A non-directory state path deterministically makes restore-backup
  // enumeration fail with ENOTDIR on every supported platform.
  writeFileSync(path.join(base, 'state'), 'not a directory');
  await assert.rejects(() => runtimeDiskSummaryAsync(base), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOTDIR');
});

test('runtimeDiskSummaryAsync dedupes hard-linked tree/store bytes in the real total while categories keep per-path sums', async () => {
  const base = freshBase();
  const tree = makeVersionTree(base, '1.0.0');
  const payload = Buffer.alloc(1024 * 1024);
  writeFileSync(path.join(tree, 'shared-payload.bin'), payload);
  const storeDir = path.join(base, 'dsh-runtime', '.pnpm-store');
  mkdirSync(storeDir, { recursive: true });
  linkSync(path.join(tree, 'shared-payload.bin'), path.join(storeDir, 'shared-payload.bin'));
  const summary = await runtimeDiskSummaryAsync(base);
  // Category sums keep the historical per-path semantics: the shared inode is
  // charged to BOTH the version tree and the store.
  assert.ok(summary.storeBytes >= 1024 * 1024);
  assert.ok(summary.versionTreeBytes >= 1024 * 1024);
  // The real total walks by (dev, ino) and charges the shared payload once.
  const categorySum = summary.versionTreeBytes + summary.storeBytes
    + summary.cacheBytes + summary.installHomeBytes + summary.xdgCacheBytes
    + summary.workBytes + summary.failureBytes + summary.snapshotBytes
    + summary.preRollbackBytes + summary.restoreBackupBytes + summary.unclassifiedBytes;
  assert.ok(summary.totalBytes < categorySum, 'the shared payload must not be double charged');
  assert.equal(summary.totalBytes, categorySum - 1024 * 1024);
});

test('runtimeDiskSummaryAsync buckets stray residue and metadata authorities into unclassifiedBytes', async () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  const stray = path.join(base, 'dsh-runtime', 'leftover', 'data.bin');
  mkdirSync(path.dirname(stray), { recursive: true });
  writeFileSync(stray, Buffer.alloc(1024));
  writeFileSync(path.join(base, 'dsh-runtime', 'current'), '{"version":"1.0.0"}', 'utf8');
  const summary = await runtimeDiskSummaryAsync(base);
  assert.ok(summary.unclassifiedBytes > 1024,
    'stray directories and metadata authorities are quota-visible residue');
  assert.equal(summary.totalBytes,
    summary.versionTreeBytes + summary.storeBytes + summary.cacheBytes
    + summary.installHomeBytes + summary.xdgCacheBytes + summary.workBytes
    + summary.failureBytes + summary.snapshotBytes + summary.preRollbackBytes
    + summary.restoreBackupBytes + summary.unclassifiedBytes,
    'without hard links the real total equals the category sum plus the residue bucket');
});

test('runtimeDiskSummaryAsync counts an unclassified symlink itself without following the external target', {
  skip: process.platform === 'win32' ? 'symlink fixture requires Unix permissions' : false,
}, async () => {
  const base = freshBase();
  const outside = path.join(base, 'outside-large');
  writeFileSync(outside, Buffer.alloc(1024 * 1024));
  const link = path.join(base, 'dsh-runtime', 'stray-link');
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(outside, link, 'file');
  const summary = await runtimeDiskSummaryAsync(base);
  assert.ok(summary.unclassifiedBytes > 0, 'the link entry itself is accounted');
  assert.ok(summary.unclassifiedBytes < 1024 * 1024, 'the external target is never charged');
  assert.ok(summary.totalBytes < 1024 * 1024);
});

test('runtimeDiskSummaryAsync charges restore backups in the real total and dedupes hard links across roots', async () => {
  const base = freshBase();
  const runtimeFile = path.join(base, 'dsh-runtime', 'leftover', 'data.bin');
  mkdirSync(path.dirname(runtimeFile), { recursive: true });
  writeFileSync(runtimeFile, Buffer.alloc(4096));
  const backupFile = path.join(base, 'state', 'dsh-home.old', 'data.bin');
  mkdirSync(path.dirname(backupFile), { recursive: true });
  linkSync(runtimeFile, backupFile);
  const summary = await runtimeDiskSummaryAsync(base);
  assert.ok(summary.restoreBackupBytes > 0);
  assert.ok(summary.unclassifiedBytes > 0);
  assert.equal(summary.totalBytes,
    summary.restoreBackupBytes + summary.unclassifiedBytes - 4096,
    'the inode shared by the residue and the restore backup is charged exactly once');
});

function summaryFields(summary: RuntimeDiskSummary): Record<string, number | boolean> {
  const { versionTrees, versionTreeBytes, storeBytes, cacheBytes, installHomeBytes, xdgCacheBytes,
    workBytes, failureBytes, snapshotBytes, preRollbackBytes, restoreBackupBytes,
    unclassifiedBytes, totalBytes, storePruneNeeded } = summary;
  return { versionTrees, versionTreeBytes, storeBytes, cacheBytes, installHomeBytes, xdgCacheBytes,
    workBytes, failureBytes, snapshotBytes, preRollbackBytes, restoreBackupBytes,
    unclassifiedBytes, totalBytes, storePruneNeeded };
}

test('runtimeDiskSummaryAsync on an empty base is all zeros (full 14-key projection shape)', async () => {
  const empty = freshBase();
  const emptyFields = summaryFields(await runtimeDiskSummaryAsync(empty));
  assert.equal(emptyFields.versionTrees, 0);
  assert.equal(Object.keys(emptyFields).length, 14, 'the projection covers the full summary shape');
  for (const [name, value] of Object.entries(emptyFields)) {
    if (typeof value === 'number') assert.equal(value, 0, `${name} must be zero on an empty base`);
  }
  assert.equal(emptyFields.storePruneNeeded, false);
});

test('runtimeDiskSummaryAsync batches: yields to the event loop and reports progress via onVisited', async () => {
  const base = freshBase();
  // 300+ 目录 × 12 文件 ≈ 3.9k 节点：yieldEvery=64 → 确定性多次让渡。
  for (let d = 0; d < 300; d += 1) {
    const dir = path.join(base, 'dsh-runtime', 'leftover', `dir-${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 12; f += 1) writeFileSync(path.join(dir, `f-${f}`), 'x');
  }
  let visited = 0;
  let yields = 0;
  let macrotaskRounds = 0;
  let keepTicking = true;
  setImmediate(function tick() {
    macrotaskRounds += 1;
    if (keepTicking) setImmediate(tick);
  });
  const summary = await runtimeDiskSummaryAsync(base, undefined, {
    yieldEvery: 64,
    onVisited: (n) => { visited = n; yields += 1; },
  });
  keepTicking = false;
  assert.ok(yields >= 10, `yieldEvery=64 下 3.9k 节点应让渡 ≥10 次，实际 ${yields}`);
  assert.ok(visited > 3000);
  assert.ok(macrotaskRounds >= 10, 'macrotask 链在遍历期间取得 ≥10 轮进展（未被冻结）');
  assert.ok(summary.unclassifiedBytes > 0);
  assert.equal(summary.totalBytes, summary.unclassifiedBytes,
    '无硬链接时真实总量 = 去重残渣桶');
});

test('builtin activation intents accept the exact builtin-anchor sentinel (F4 shell-invalidation regression)', () => {
  const base = freshBase();
  // The gateway's F4 fallback passes the sentinel token when a shell upgrade
  // invalidates an existing override (2026-09 release gate: assertSafeVersion
  // used to reject it, crashing gateway startup on any upgrade with an
  // existing override record).
  const sentinel = writeActivationIntent(base, {
    targetVersion: 'builtin-anchor', targetIsBuiltin: true, manualRollback: false, intentKind: 'shell-invalidation',
  });
  assert.equal(sentinel.targetVersion, 'builtin-anchor');
  assert.equal(sentinel.targetIsBuiltin, true);
  // The sentinel stays illegal for non-builtin targets (path-safety gate).
  clearActivationJournal(base);
  assert.throws(() => writeActivationIntent(base, {
    targetVersion: 'builtin-anchor', manualRollback: false, intentKind: 'version-switch',
  }), /不安全/);
});
