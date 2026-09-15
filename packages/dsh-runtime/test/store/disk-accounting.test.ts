/**
 * runtimeDiskSummary / runtimeDiskSummaryAsync 磁盘核算测试（design 18 §3.5），
 * 拆分自 dsh-runtime-store.test.ts（P0）。共享 fixture：
 * test/support/store-fixtures.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  clearActivationJournal,
  recordRuntimeFailure,
  runtimeDiskSummary,
  runtimeDiskSummaryAsync,
  writeActivationIntent,
} from '../../src/dsh-runtime-store.ts';
import { freshBase, makeVersionTree } from '../support/store-fixtures.ts';

test('runtimeDiskSummary accounts every runtime-owned tree, cache, snapshot, and restore backup', () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  const missing = runtimeDiskSummary(base);
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
  const failureBytesBeforeRecovery = runtimeDiskSummary(base).failureBytes;
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
  const summary = runtimeDiskSummary(base);
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
  assert.equal(runtimeDiskSummary(base).restoreBackupBytes, summary.restoreBackupBytes);

  const unsafeBackupLookalike = path.join(base, 'dsh-runtime', '.1.2.3.publish-backup-not-hex', 'payload');
  mkdirSync(path.dirname(unsafeBackupLookalike), { recursive: true });
  writeFileSync(unsafeBackupLookalike, Buffer.alloc(1024 * 1024));
  assert.equal(runtimeDiskSummary(base).failureBytes, summary.failureBytes,
    'non-installer lookalikes are not claimed as owned failure scenes');
});

test('runtimeDiskSummary counts a publish-backup symlink itself without following its target', () => {
  const base = freshBase();
  const outside = path.join(base, 'outside-large');
  writeFileSync(outside, Buffer.alloc(1024 * 1024));
  const link = path.join(base, 'dsh-runtime', '.1.2.3.publish-backup-deadbeef');
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(outside, link, 'file');
  const summary = runtimeDiskSummary(base);
  assert.ok(summary.failureBytes > 0);
  assert.ok(summary.failureBytes < 1024 * 1024,
    'quota walk must account the link entry but never follow the external target');
});

test('runtimeDiskSummary accepts the gateway DSH_HOME layout for restore-backup accounting', () => {
  const base = freshBase();
  const gatewayHome = path.join(base, 'dsh-home');
  const backup = path.join(base, 'dsh-home.old-123', 'data');
  mkdirSync(path.dirname(backup), { recursive: true });
  writeFileSync(backup, 'gateway-restore-backup');
  assert.equal(runtimeDiskSummary(base).restoreBackupBytes, 0,
    'the desktop default must not claim gateway sibling backups');
  assert.ok(runtimeDiskSummary(base, gatewayHome).restoreBackupBytes > 0,
    'the gateway owner explicitly accounts sibling restore backups');
});

test('runtimeDiskSummary propagates non-ENOENT accounting errors instead of reporting zero', () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  // A non-directory state path deterministically makes restore-backup
  // enumeration fail with ENOTDIR on every supported platform.
  writeFileSync(path.join(base, 'state'), 'not a directory');
  assert.throws(() => runtimeDiskSummary(base), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOTDIR');
});

test('runtimeDiskSummary dedupes hard-linked tree/store bytes in the real total while categories keep per-path sums', () => {
  const base = freshBase();
  const tree = makeVersionTree(base, '1.0.0');
  const payload = Buffer.alloc(1024 * 1024);
  writeFileSync(path.join(tree, 'shared-payload.bin'), payload);
  const storeDir = path.join(base, 'dsh-runtime', '.pnpm-store');
  mkdirSync(storeDir, { recursive: true });
  linkSync(path.join(tree, 'shared-payload.bin'), path.join(storeDir, 'shared-payload.bin'));
  const summary = runtimeDiskSummary(base);
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

test('runtimeDiskSummary buckets stray residue and metadata authorities into unclassifiedBytes', () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  const stray = path.join(base, 'dsh-runtime', 'leftover', 'data.bin');
  mkdirSync(path.dirname(stray), { recursive: true });
  writeFileSync(stray, Buffer.alloc(1024));
  writeFileSync(path.join(base, 'dsh-runtime', 'current'), '{"version":"1.0.0"}', 'utf8');
  const summary = runtimeDiskSummary(base);
  assert.ok(summary.unclassifiedBytes > 1024,
    'stray directories and metadata authorities are quota-visible residue');
  assert.equal(summary.totalBytes,
    summary.versionTreeBytes + summary.storeBytes + summary.cacheBytes
    + summary.installHomeBytes + summary.xdgCacheBytes + summary.workBytes
    + summary.failureBytes + summary.snapshotBytes + summary.preRollbackBytes
    + summary.restoreBackupBytes + summary.unclassifiedBytes,
    'without hard links the real total equals the category sum plus the residue bucket');
});

test('runtimeDiskSummary counts an unclassified symlink itself without following the external target', {
  skip: process.platform === 'win32' ? 'symlink fixture requires Unix permissions' : false,
}, () => {
  const base = freshBase();
  const outside = path.join(base, 'outside-large');
  writeFileSync(outside, Buffer.alloc(1024 * 1024));
  const link = path.join(base, 'dsh-runtime', 'stray-link');
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(outside, link, 'file');
  const summary = runtimeDiskSummary(base);
  assert.ok(summary.unclassifiedBytes > 0, 'the link entry itself is accounted');
  assert.ok(summary.unclassifiedBytes < 1024 * 1024, 'the external target is never charged');
  assert.ok(summary.totalBytes < 1024 * 1024);
});

test('runtimeDiskSummary charges restore backups in the real total and dedupes hard links across roots', () => {
  const base = freshBase();
  const runtimeFile = path.join(base, 'dsh-runtime', 'leftover', 'data.bin');
  mkdirSync(path.dirname(runtimeFile), { recursive: true });
  writeFileSync(runtimeFile, Buffer.alloc(4096));
  const backupFile = path.join(base, 'state', 'dsh-home.old', 'data.bin');
  mkdirSync(path.dirname(backupFile), { recursive: true });
  linkSync(runtimeFile, backupFile);
  const summary = runtimeDiskSummary(base);
  assert.ok(summary.restoreBackupBytes > 0);
  assert.ok(summary.unclassifiedBytes > 0);
  assert.equal(summary.totalBytes,
    summary.restoreBackupBytes + summary.unclassifiedBytes - 4096,
    'the inode shared by the residue and the restore backup is charged exactly once');
});

// ---- perf T3（2026-09）：runtimeDiskSummaryAsync 与同步版逐字段对等 ----

/** 组装覆盖全部类别的真实形态 fixture（版本树/store/缓存/工作目录/失败族/
 *  快照/预回滚/恢复备份/发布备份/未分类残渣/元数据权威），硬链接 + 符号链接
 *  面齐备。返回 base。 */
function makeRichAccountingFixture(base: string): void {
  const tree = makeVersionTree(base, '1.0.0');
  writeFileSync(path.join(tree, 'payload-shared.bin'), Buffer.alloc(1024 * 1024));
  mkdirSync(path.join(base, 'dsh-runtime', '.pnpm-store', 'pkg', 'x'), { recursive: true });
  writeFileSync(path.join(base, 'dsh-runtime', '.pnpm-store', 'pkg', 'x', 'index.js'), 'store-content');
  // 版本树 ↔ store 硬链接：totalBytes 只计一次，类别逐路径和两处都计。
  linkSync(path.join(tree, 'payload-shared.bin'), path.join(base, 'dsh-runtime', '.pnpm-store', 'payload-shared.bin'));
  writeFileSync(path.join(base, 'dsh-runtime', '.pnpm-store', 'pkg', 'x', 'bin'), 'store-bin');
  mkdirSync(path.join(base, 'dsh-runtime', '.pnpm-cache'), { recursive: true });
  writeFileSync(path.join(base, 'dsh-runtime', '.pnpm-cache', 'meta.json'), 'cache');
  for (const [relative, content] of [
    ['.install-home/home/pnpm.cjs', 'install-home'],
    ['.xdg-cache/cache/data', 'xdg-cache'],
    ['.work-active/work/pid', 'work'],
    // >1 KiB so the quota-visibility assertion below is filesystem-independent
    // (directory st_size is 4096 on ext4 but near zero on ZFS/tmpfs).
    ['.3.0.0.failed/tree/payload', Buffer.alloc(2048, 7)],
    ['failures/1.0.0.json', '{"count":1}'],
    ['.9.9.9.publish-backup-cafebabe/payload', 'publish-backup'],
    ['metadata-recovery-data/tx/evidence/current', 'recovery'],
    ['metadata-recovery-rescue-data/tx/evidence/stash', 'rescue'],
    ['metadata-recovery.json', '{"phase":"finalized"}'],
    ['snapshots/1.0.0-1/data', 'snapshot'],
    ['pre-rollback/1.0.0-2/data', 'stash'],
    ['leftover/stray-dir/data.bin', Buffer.alloc(2048)],
  ] as const) {
    const file = path.join(base, 'dsh-runtime', relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  writeFileSync(path.join(base, 'dsh-runtime', 'current'), '{"version":"1.0.0"}', 'utf8');
  const outside = path.join(base, 'outside-large.bin');
  writeFileSync(outside, Buffer.alloc(1024 * 1024));
  symlinkSync(outside, path.join(base, 'dsh-runtime', 'leftover', 'stray-link'), 'file');
  for (const [name, content] of [
    ['dsh-home.old', 'restore-one'],
    ['dsh-home.old-123', 'restore-two'],
  ] as const) {
    const file = path.join(base, 'state', name, 'data.bin');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const backupLink = path.join(base, 'state', 'dsh-home.old', 'hardlinked.bin');
  linkSync(path.join(base, 'dsh-runtime', '.pnpm-store', 'pkg', 'x', 'index.js'), backupLink);
}

function summaryFields(summary: ReturnType<typeof runtimeDiskSummary>): Record<string, number | boolean> {
  const { versionTrees, versionTreeBytes, storeBytes, cacheBytes, installHomeBytes, xdgCacheBytes,
    workBytes, failureBytes, snapshotBytes, preRollbackBytes, restoreBackupBytes,
    unclassifiedBytes, totalBytes, storePruneNeeded } = summary;
  return { versionTrees, versionTreeBytes, storeBytes, cacheBytes, installHomeBytes, xdgCacheBytes,
    workBytes, failureBytes, snapshotBytes, preRollbackBytes, restoreBackupBytes,
    unclassifiedBytes, totalBytes, storePruneNeeded };
}

test('runtimeDiskSummaryAsync is field-for-field identical to the sync walk on a rich fixture', async () => {
  const base = freshBase();
  makeRichAccountingFixture(base);
  const syncSummary = runtimeDiskSummary(base);
  const asyncSummary = await runtimeDiskSummaryAsync(base);
  assert.deepEqual(summaryFields(asyncSummary), summaryFields(syncSummary));
  // 富 fixture 必须真的覆盖到各面（防对等测试空转）：类别与残渣都非零。
  assert.ok(syncSummary.versionTreeBytes > 0 && syncSummary.storeBytes > 0);
  assert.ok(syncSummary.unclassifiedBytes > 0 && syncSummary.restoreBackupBytes > 0);
  assert.ok(syncSummary.failureBytes > 1024, 'failure family incl. publish backup is quota-visible');
});

test('runtimeDiskSummaryAsync matches the sync walk on an empty and a gateway-layout base', async () => {
  const empty = freshBase();
  assert.deepEqual(summaryFields(await runtimeDiskSummaryAsync(empty)), summaryFields(runtimeDiskSummary(empty)));
  const gatewayBase = freshBase();
  const gatewayHome = path.join(gatewayBase, 'dsh-home');
  const backup = path.join(gatewayBase, 'dsh-home.old-123', 'data');
  mkdirSync(path.dirname(backup), { recursive: true });
  writeFileSync(backup, 'gateway-restore-backup');
  const gatewayExpected = runtimeDiskSummary(gatewayBase, gatewayHome);
  assert.ok(gatewayExpected.restoreBackupBytes > 0);
  assert.deepEqual(summaryFields(await runtimeDiskSummaryAsync(gatewayBase, gatewayHome)),
    summaryFields(gatewayExpected));
});

test('runtimeDiskSummaryAsync propagates the same non-ENOENT accounting errors as the sync walk', async () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  writeFileSync(path.join(base, 'state'), 'not a directory');
  await assert.rejects(() => runtimeDiskSummaryAsync(base), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOTDIR');
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
