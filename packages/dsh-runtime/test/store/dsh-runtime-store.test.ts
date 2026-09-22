/**
 * dsh-runtime-store.ts 保护判定、激活 journal、失败记录与快照保留测试
 * （design 18 §3.2/§3.5），原名 dsh-runtime-store.test.ts 的主体段（P0 拆分保留）。
 * Shared fixtures: test/support/store-fixtures.ts. Siblings:
 *   - metadata-authority.test.ts (pointer/override/isProtected/listVersionTrees)
 *   - disk-accounting.test.ts (runtimeDiskSummaryAsync accounting)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  activationJournalPath,
  clearActivationJournal,
  clearCurrentPointer,
  clearRuntimeFailure,
  clearStorePruneRequest,
  cleanupExplicitRuntimeVersion,
  cleanupStaleInstalls,
  currentPointerPath,
  deleteOverride,
  evictVersions,
  forgetExplicitInstall,
  isProtectedVersion,
  listExplicitlyInstalledVersions,
  listKnownGoodVersionsState,
  listRuntimeFailuresState,
  listVersionTrees,
  markKnownGood,
  overridePath,
  queueActivationIntent,
  readActivationJournalState,
  readCurrentPointerState,
  readOverrideState,
  readRuntimeFailureState,
  readStorePruneRequest,
  recordExplicitInstall,
  recordRuntimeFailure,
  runtimeFailureSummary,
  runtimeSnapshotRetentionState,
  validateVersionTree,
  writeActivationIntent,
  writeActivationJournal,
  writeCurrentPointer,
  writeOverride,
} from '../../src/dsh-runtime-store.ts';
import type { OverrideRecord } from '../../src/dsh-runtime-store.ts';
import { freshBase, journalFixture, makeVersionTree } from '../support/store-fixtures.ts';

test('isProtectedVersion: 当前指针指向受保护; 其他版本不受保护', () => {
  const base = freshBase();
  writeCurrentPointer(base, '0.1.1-rc.2');
  assert.equal(isProtectedVersion(base, '0.1.1-rc.2'), true);
  assert.equal(isProtectedVersion(base, '1.0.0'), false);
});

test('isProtectedVersion: known-good 标记受保护', () => {
  const base = freshBase();
  assert.equal(isProtectedVersion(base, '0.1.1'), false, '未标记前不受保护');
  makeVersionTree(base, '0.1.1');
  markKnownGood(base, '0.1.1');
  assert.equal(isProtectedVersion(base, '0.1.1'), true);
  assert.equal(isProtectedVersion(base, '0.1.2'), false);
  const kg = JSON.parse(readFileSync(path.join(base, 'dsh-runtime', 'known-good.json'), 'utf8'));
  assert.ok(typeof kg.versions['0.1.1'] === 'string', 'known-good 记录时间戳（M3 持续健康推进用）');
});

test('isProtectedVersion: override.pending 指向受保护; pending 清除后不再受保护', () => {
  const base = freshBase();
  writeOverride(base, {
    shellVersion: '0.1.3',
    chosenVersion: null,
    resolvedVersion: null,
    pending: '1.0.0',
    swapAttempted: false,
  });
  assert.equal(isProtectedVersion(base, '1.0.0'), true, 'pending 指向受保护');
  assert.equal(isProtectedVersion(base, '0.1.1'), false);
  writeOverride(base, {
    shellVersion: '0.1.3',
    chosenVersion: null,
    resolvedVersion: null,
    pending: null,
    swapAttempted: false,
  });
  assert.equal(isProtectedVersion(base, '1.0.0'), false, 'pending 清除后不再受保护');
});

test('isProtectedVersion: .failed 失败现场受保护（failures/<v>.json 与 <v>.failed 树）', () => {
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  mkdirSync(path.join(runtimeDir, 'failures'), { recursive: true });
  writeFileSync(path.join(runtimeDir, 'failures', '0.1.2.json'), JSON.stringify({ version: '0.1.2' }), 'utf8');
  assert.equal(isProtectedVersion(base, '0.1.2'), true, 'failures/<v>.json 现场受保护');
  mkdirSync(path.join(runtimeDir, '1.0.0.failed'), { recursive: true });
  assert.equal(isProtectedVersion(base, '1.0.0'), true, '<v>.failed 树受保护');
  assert.equal(isProtectedVersion(base, '2.0.0'), false);
});

test('isProtectedVersion: 异常版本串恒不受保护（路径安全守卫）', () => {
  const base = freshBase();
  writeCurrentPointer(base, '0.1.1');
  for (const bad of ['../0.1.1', '0.1.1/..', '1.0.0-..', '1.0.0\\x', '..', '']) {
    assert.equal(isProtectedVersion(base, bad), false, `should not protect ${JSON.stringify(bad)}`);
  }
});

test('listVersionTrees: 仅版本树目录，排除非版本条目', () => {
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  for (const name of [
    '0.1.1-rc.2',
    '1.0.0',
    'failures',
    'snapshots',
    'pre-rollback',
    '.pnpm-store',
    'not-a-version',
    '1.0.0.failed',
  ]) {
    mkdirSync(path.join(runtimeDir, name), { recursive: true });
  }
  writeFileSync(path.join(runtimeDir, 'current'), JSON.stringify({ version: '0.1.1-rc.2' }), 'utf8');
  writeFileSync(path.join(runtimeDir, 'override.json'), '{}', 'utf8');
  writeFileSync(path.join(runtimeDir, 'known-good.json'), '{}', 'utf8');
  assert.deepEqual(listVersionTrees(base), ['0.1.1-rc.2', '1.0.0']);
});

test('listVersionTrees: dsh-runtime 目录不存在 → []', () => {
  const base = freshBase();
  assert.deepEqual(listVersionTrees(base), []);
});

test('current/override explicit clear APIs do not conflate pointer and history', () => {
  const base = freshBase();
  const record: OverrideRecord = {
    shellVersion: '0.1.3', chosenVersion: '1.0.0', resolvedVersion: '1.0.0', pending: null, swapAttempted: false,
  };
  writeCurrentPointer(base, '1.0.0');
  writeOverride(base, record);
  clearCurrentPointer(base);
  assert.deepEqual(readCurrentPointerState(base), { kind: 'missing' });
  assert.deepEqual(readOverrideState(base), { kind: 'valid', record }, 'pointer clear preserves override history');
  deleteOverride(base);
  assert.deepEqual(readOverrideState(base), { kind: 'missing' });
});

test('override optional lifecycle evidence round-trips while old five-field shape remains readable', () => {
  const base = freshBase();
  const record: OverrideRecord = {
    shellVersion: '0.1.3',
    chosenVersion: '1.0.0',
    resolvedVersion: '1.0.0',
    pending: null,
    swapAttempted: true,
    invalidatedAt: '2026-08-23T00:00:00.000Z',
    invalidatedReason: 'shell-version-changed',
    lastInvalidatedAt: '2026-08-23T00:00:00.000Z',
    lastInvalidatedReason: 'shell-version-changed',
    lastInvalidatedFromVersion: '1.0.0',
    lastInvalidationRecovered: true,
    lastOutcome: 'rolled-back',
    lastError: 'probe failed',
    restoreOutcome: 'complete',
  };
  writeOverride(base, record);
  assert.deepEqual(readOverrideState(base), { kind: 'valid', record });
  const raw = JSON.parse(readFileSync(overridePath(base), 'utf8'));
  assert.equal(raw.restoreOutcome, 'complete');
});

test('metadata files and directories are tightened to 0700/0600', () => {
  const base = freshBase();
  mkdirSync(path.join(base, 'dsh-runtime'), { recursive: true, mode: 0o777 });
  makeVersionTree(base, '1.0.0');
  writeCurrentPointer(base, '1.0.0');
  writeOverride(base, { shellVersion: '0.1.3', chosenVersion: null, resolvedVersion: null, pending: null, swapAttempted: false });
  markKnownGood(base, '1.0.0');
  recordRuntimeFailure(base, { version: '1.0.0', phase: 'probe', error: 'failed' });
  writeActivationIntent(base, { targetVersion: '1.0.0', manualRollback: false, intentKind: 'version-switch' });
  assert.equal(statSync(path.join(base, 'dsh-runtime')).mode & 0o777, 0o700);
  assert.equal(statSync(currentPointerPath(base)).mode & 0o777, 0o600);
  assert.equal(statSync(overridePath(base)).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(base, 'dsh-runtime', 'known-good.json')).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(base, 'dsh-runtime', 'failures')).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(base, 'dsh-runtime', 'failures', '1.0.0.json')).mode & 0o777, 0o600);
  assert.equal(statSync(activationJournalPath(base)).mode & 0o777, 0o600);
});

test('activation journal round-trips, queues selections through F7 rollback, and clears explicitly', () => {
  const base = freshBase();
  const first = writeActivationIntent(
    base,
    { targetVersion: '2.0.0', manualRollback: false, intentKind: 'version-switch' },
    new Date('2026-08-23T00:00:00.000Z'),
  );
  assert.equal(first.phase, 'intent');
  assert.deepEqual(readActivationJournalState(base), { kind: 'valid', journal: first });

  const monitoring = journalFixture('applied-monitoring');
  writeActivationJournal(base, monitoring);
  const queued = writeActivationIntent(
    base,
    { targetVersion: '3.0.0', manualRollback: true, intentKind: 'version-switch' },
    new Date('2026-08-23T01:00:00.000Z'),
  );
  assert.equal(queued.phase, 'applied-monitoring');
  assert.deepEqual(queued.nextIntent, {
    targetVersion: '3.0.0', targetIsBuiltin: false, manualRollback: true, intentKind: 'version-switch',
  });
  assert.throws(() => writeActivationIntent(base, {
    targetVersion: '4.0.0', manualRollback: false, intentKind: 'version-switch',
  }), /拒绝覆盖/);
  const rollingBack = { ...queued, phase: 'rollback-needed' as const, rollbackTarget: '1.0.0' };
  writeActivationJournal(base, rollingBack);
  assert.deepEqual(readActivationJournalState(base), { kind: 'valid', journal: rollingBack });

  clearActivationJournal(base);
  assert.deepEqual(readActivationJournalState(base), { kind: 'missing' });

  const reset = writeActivationIntent(base, {
    targetVersion: '1.0.0', targetIsBuiltin: true, manualRollback: false, intentKind: 'reset-builtin',
  });
  assert.equal(reset.intentKind, 'reset-builtin');
  assert.throws(() => writeActivationIntent(base, {
    targetVersion: '2.0.0', targetIsBuiltin: true, manualRollback: false, intentKind: 'version-switch',
  }), /组合无效/);
});

test('reset-builtin can be durably queued without overwriting an in-flight activation', () => {
  const base = freshBase();
  const active = writeActivationIntent(base, {
    targetVersion: '2.0.0', manualRollback: false, intentKind: 'version-switch',
  });
  const queued = queueActivationIntent(base, {
    targetVersion: '1.0.0', targetIsBuiltin: true, manualRollback: false, intentKind: 'reset-builtin',
  });
  assert.equal(queued.targetVersion, active.targetVersion);
  assert.deepEqual(queued.nextIntent, {
    targetVersion: '1.0.0', targetIsBuiltin: true, manualRollback: false, intentKind: 'reset-builtin',
  });
  assert.deepEqual(readActivationJournalState(base), { kind: 'valid', journal: queued });
  assert.throws(() => queueActivationIntent(base, {
    targetVersion: '3.0.0', manualRollback: false, intentKind: 'version-switch',
  }), /拒绝覆盖/);
});

test('single-flight: writeActivationIntent refuses to overwrite an in-flight prepared transaction', () => {
  const base = freshBase();
  writeActivationIntent(base, { targetVersion: '2.0.0', manualRollback: false, intentKind: 'version-switch' });
  writeActivationJournal(base, journalFixture('prepared'));
  // A second selection while the activation transaction is already prepared
  // (snapshot taken, pointer about to switch) must never overwrite it.
  assert.throws(() => writeActivationIntent(base, {
    targetVersion: '3.0.0', manualRollback: false, intentKind: 'version-switch',
  }), /已有运行时激活事务，拒绝覆盖/);
  assert.deepEqual(readActivationJournalState(base), { kind: 'valid', journal: journalFixture('prepared') });
});

test('single-flight: queueActivationIntent is idempotent for the same intent and refuses a different one', () => {
  const base = freshBase();
  const monitoring = journalFixture('applied-monitoring');
  writeActivationJournal(base, monitoring);
  const queued = { targetVersion: '3.0.0', targetIsBuiltin: false, manualRollback: true, intentKind: 'version-switch' as const };
  const first = queueActivationIntent(base, queued);
  assert.deepEqual(first.nextIntent, queued);
  // Re-queueing the identical intent returns the existing journal unchanged
  // (no write: updatedAt stays put) instead of throwing.
  const second = queueActivationIntent(base, queued);
  assert.deepEqual(second.nextIntent, queued);
  assert.equal(second.updatedAt, first.updatedAt);
  assert.equal(second.phase, 'applied-monitoring');
  assert.throws(() => queueActivationIntent(base, {
    targetVersion: '4.0.0', manualRollback: false, intentKind: 'version-switch',
  }), /拒绝覆盖用户选择/);
});

test('legacy journal without intentKind defaults only to version-switch', () => {
  const base = freshBase();
  const { intentKind: _legacyOmitted, ...legacy } = journalFixture('prepared');
  mkdirSync(path.dirname(activationJournalPath(base)), { recursive: true });
  writeFileSync(activationJournalPath(base), JSON.stringify(legacy), 'utf8');
  const state = readActivationJournalState(base);
  assert.equal(state.kind, 'valid');
  if (state.kind === 'valid') assert.equal(state.journal.intentKind, 'version-switch');
});

test('corrupt activation journal remains fail-closed and protects every version tree', () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  writeFileSync(activationJournalPath(base), '{ broken', 'utf8');
  assert.deepEqual(readActivationJournalState(base), { kind: 'corrupt' });
  assert.deepEqual(readActivationJournalState(base), { kind: 'corrupt' });
  assert.equal(isProtectedVersion(base, '1.0.0'), true);
});

test('activation journal protects source, target, rollback, known-good, and queued target trees', () => {
  const base = freshBase();
  const protectedVersions = ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0'];
  for (const version of protectedVersions) makeVersionTree(base, version);
  writeActivationJournal(base, journalFixture('rollback-needed', {
    sourceVersion: '1.0.0',
    targetVersion: '2.0.0',
    rollbackTarget: '3.0.0',
    knownGoodVersion: '4.0.0',
    nextIntent: { targetVersion: '5.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch' },
  }));
  for (const version of protectedVersions) assert.equal(isProtectedVersion(base, version), true, version);
});

test('validateVersionTree rejects directory-only, manifest version/platform drift, and missing bin', () => {
  const base = freshBase();
  assert.deepEqual(validateVersionTree(base, '1.0.0'), { ok: false, kind: 'invalid', error: '版本树不存在或不可读' });
  mkdirSync(path.join(base, 'dsh-runtime', '1.0.0'), { recursive: true });
  const missingManifest = validateVersionTree(base, '1.0.0');
  assert.match(missingManifest.ok ? '' : missingManifest.error, /package\.json/);
  makeVersionTree(base, '1.0.0', 'wrong-platform');
  const wrongPlatform = validateVersionTree(base, '1.0.0');
  assert.match(wrongPlatform.ok ? '' : wrongPlatform.error, /平台/);
  makeVersionTree(base, '1.0.0');
  assert.deepEqual(validateVersionTree(base, '1.0.0'), { ok: true, kind: 'valid', path: path.join(base, 'dsh-runtime', '1.0.0') });
  writeFileSync(path.join(base, 'dsh-runtime', '1.0.0', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// tampered');
  const tampered = validateVersionTree(base, '1.0.0');
  assert.match(tampered.ok ? '' : tampered.error, /摘要不匹配/);
  makeVersionTree(base, '1.0.0');
  writeFileSync(path.join(base, 'dsh-runtime', '1.0.0', 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh': '2.0.0' }, dsh: { platform: `${process.platform}-${process.arch}` },
  }));
  const wrongVersion = validateVersionTree(base, '1.0.0');
  assert.match(wrongVersion.ok ? '' : wrongVersion.error, /精确钉住/);
  assert.equal(validateVersionTree(base, '../evil').ok, false);
});

test('explicit install retention survives auto eviction until explicit cleanup', () => {
  const base = freshBase();
  for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) makeVersionTree(base, version);
  // First record seeds all legacy trees: no pre-ledger user install is lost.
  recordExplicitInstall(base, '1.0.3', new Date('2026-08-23T00:00:00.000Z'));
  assert.deepEqual(listExplicitlyInstalledVersions(base), ['1.0.0', '1.0.1', '1.0.2', '1.0.3']);
  assert.deepEqual(evictVersions(base, 1), [], 'explicit installs exceed cache target safely');

  for (const version of ['1.0.0', '1.0.1', '1.0.2']) forgetExplicitInstall(base, version);
  const now = Date.now() / 1000;
  utimesSync(path.join(base, 'dsh-runtime', '1.0.0'), now - 30, now - 30);
  utimesSync(path.join(base, 'dsh-runtime', '1.0.1'), now - 20, now - 20);
  utimesSync(path.join(base, 'dsh-runtime', '1.0.2'), now - 10, now - 10);
  assert.deepEqual(evictVersions(base, 2), ['1.0.0', '1.0.1']);
  assert.ok(existsSync(path.join(base, 'dsh-runtime', '1.0.2')));
  assert.ok(existsSync(path.join(base, 'dsh-runtime', '1.0.3')), 'explicit tree retained');
  assert.ok(readStorePruneRequest(base)?.reasons.some((reason) => reason.startsWith('evicted:')));
  assert.equal(readStorePruneRequest(base)?.reasons.includes('cache-reclaim'), true,
    'eviction of hard-linked trees must ask the store prune to reclaim the private caches');
  clearStorePruneRequest(base);
  assert.equal(readStorePruneRequest(base), null);
});

test('explicit cleanup removes only an otherwise-unprotected immutable tree and preserves protected targets', () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  recordExplicitInstall(base, '1.0.0');
  const tree = path.join(base, 'dsh-runtime', '1.0.0');
  chmodSync(tree, 0o500);
  assert.deepEqual(cleanupExplicitRuntimeVersion(base, '1.0.0'), {
    removed: true, retentionCleared: true, stillProtected: false,
  });
  assert.equal(existsSync(tree), false);
  assert.equal(readStorePruneRequest(base)?.reasons.includes('explicit-cleanup:1.0.0'), true);
  assert.equal(readStorePruneRequest(base)?.reasons.includes('cache-reclaim'), true,
    'explicit cleanup must ask the store prune to reclaim the private caches');

  makeVersionTree(base, '2.0.0');
  recordExplicitInstall(base, '2.0.0');
  writeCurrentPointer(base, '2.0.0');
  assert.deepEqual(cleanupExplicitRuntimeVersion(base, '2.0.0'), {
    removed: false, retentionCleared: false, stillProtected: true,
  });
  assert.equal(existsSync(path.join(base, 'dsh-runtime', '2.0.0')), true);
  assert.equal(listExplicitlyInstalledVersions(base).includes('2.0.0'), true);
});

test('eviction can remove installer-owned read-only immutable trees', { skip: process.platform === 'win32' }, () => {
  const base = freshBase();
  const trees = ['1.0.0', '1.0.1', '1.0.2', '1.0.3'].map(version => makeVersionTree(base, version));
  for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) forgetExplicitInstall(base, version);
  trees.forEach((tree, index) => utimesSync(tree, new Date(1_000 + index), new Date(1_000 + index)));
  const makeReadOnly = (entryPath: string): void => {
    const info = lstatSync(entryPath);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of readdirSync(entryPath)) makeReadOnly(path.join(entryPath, entry));
      chmodSync(entryPath, 0o500);
    } else if (info.isFile()) chmodSync(entryPath, 0o400);
  };
  makeReadOnly(trees[0]);
  assert.deepEqual(evictVersions(base, 3), ['1.0.0']);
  assert.equal(existsSync(trees[0]), false);
});

test('stale-install cleanup preserves live PID/PGID evidence and fails closed', () => {
  const base = freshBase();
  const work = path.join(base, 'dsh-runtime', '.work-live');
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, 'pid'), String(process.pid));
  assert.throws(() => cleanupStaleInstalls(base), /活动写进程/);
  assert.equal(existsSync(work), true);
});

test('stale-install cleanup only removes a proven empty pre-spawn work dir', () => {
  const emptyBase = freshBase();
  const emptyWork = path.join(emptyBase, 'dsh-runtime', '.work-empty');
  mkdirSync(emptyWork, { recursive: true });
  assert.deepEqual(cleanupStaleInstalls(emptyBase), ['.work-empty']);
  assert.equal(existsSync(emptyWork), false);
  assert.equal(readStorePruneRequest(emptyBase)?.reasons.includes('stale-work:1'), true);
  assert.equal(readStorePruneRequest(emptyBase)?.reasons.includes('cache-reclaim'), false,
    'stale-work cleanup must never trigger private-cache reclamation');

  const missingBase = freshBase();
  const missingWork = path.join(missingBase, 'dsh-runtime', '.work-missing-pid');
  mkdirSync(missingWork, { recursive: true });
  writeFileSync(path.join(missingWork, 'package.json'), '{}');
  assert.throws(() => cleanupStaleInstalls(missingBase), /PID\/PGID.*缺失/);
  assert.equal(existsSync(missingWork), true, 'non-empty work without PID evidence is preserved');

  const corruptBase = freshBase();
  const corruptWork = path.join(corruptBase, 'dsh-runtime', '.work-corrupt-pid');
  mkdirSync(corruptWork, { recursive: true });
  writeFileSync(path.join(corruptWork, 'pid'), 'not-a-pid');
  assert.throws(() => cleanupStaleInstalls(corruptBase), /PID\/PGID.*损坏/);
  assert.equal(existsSync(corruptWork), true, 'corrupt PID evidence is preserved');
});

test('stale-install cleanup reclaims a pre-spawn work dir whose state marker is preparing', () => {
  // P1 regression: the installer writes package.json/pnpm-workspace.yaml
  // BEFORE any child exists (the download window is the longest phase), so a
  // hard crash there used to leave a non-empty work dir with no PID evidence
  // and block startup forever with no UI escape. The 'preparing' marker
  // proves no child ever existed and makes the residue reclaimable.
  const base = freshBase();
  const work = path.join(base, 'dsh-runtime', '.work-prepare-crash');
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, 'state'), 'preparing\n');
  writeFileSync(path.join(work, 'package.json'), '{}');
  writeFileSync(path.join(work, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 0\n');
  assert.deepEqual(cleanupStaleInstalls(base), ['.work-prepare-crash']);
  assert.equal(existsSync(work), false);
});

test('stale-install cleanup reclaims a spawn-failure work dir whose state marker is failed', () => {
  const base = freshBase();
  const work = path.join(base, 'dsh-runtime', '.work-spawn-fail');
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, 'state'), 'failed\n');
  writeFileSync(path.join(work, 'package.json'), '{}');
  assert.deepEqual(cleanupStaleInstalls(base), ['.work-spawn-fail']);
  assert.equal(existsSync(work), false);
});

test('stale-install cleanup still blocks post-spawn scenes and legacy/corrupt markers', () => {
  // 'spawned' with lost PID evidence: a child may exist — fail closed.
  const spawnedBase = freshBase();
  const spawnedWork = path.join(spawnedBase, 'dsh-runtime', '.work-spawned');
  mkdirSync(spawnedWork, { recursive: true });
  writeFileSync(path.join(spawnedWork, 'state'), 'spawned\n');
  writeFileSync(path.join(spawnedWork, 'package.json'), '{}');
  assert.throws(() => cleanupStaleInstalls(spawnedBase), /PID\/PGID.*缺失/);
  assert.equal(existsSync(spawnedWork), true, 'post-spawn residue without PID evidence is preserved');

  // 'spawning' with lost PID evidence: same fail-closed rule.
  const spawningBase = freshBase();
  const spawningWork = path.join(spawningBase, 'dsh-runtime', '.work-spawning');
  mkdirSync(spawningWork, { recursive: true });
  writeFileSync(path.join(spawningWork, 'state'), 'spawning\n');
  writeFileSync(path.join(spawningWork, 'package.json'), '{}');
  assert.throws(() => cleanupStaleInstalls(spawningBase), /PID\/PGID.*缺失/);

  // Legacy non-empty work dir without a marker keeps the conservative block.
  const legacyBase = freshBase();
  const legacyWork = path.join(legacyBase, 'dsh-runtime', '.work-legacy');
  mkdirSync(legacyWork, { recursive: true });
  writeFileSync(path.join(legacyWork, 'package.json'), '{}');
  assert.throws(() => cleanupStaleInstalls(legacyBase), /PID\/PGID.*缺失/);
  assert.equal(existsSync(legacyWork), true);

  // A symlinked marker is never read (fail-closed).
  const symlinkBase = freshBase();
  const symlinkWork = path.join(symlinkBase, 'dsh-runtime', '.work-symlink-marker');
  mkdirSync(symlinkWork, { recursive: true });
  symlinkSync('/etc/hosts', path.join(symlinkWork, 'state'));
  writeFileSync(path.join(symlinkWork, 'package.json'), '{}');
  assert.throws(() => cleanupStaleInstalls(symlinkBase), /PID\/PGID.*缺失/);
  assert.equal(existsSync(symlinkWork), true);
});

test('override chosen/resolved are protected after pending clears', () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  // Create a valid ledger that does not mark 1.0.0 explicit.
  recordExplicitInstall(base, '1.0.0');
  forgetExplicitInstall(base, '1.0.0');
  writeOverride(base, {
    shellVersion: '0.1.3', chosenVersion: '1.0.0', resolvedVersion: '1.0.0', pending: null, swapAttempted: false,
  });
  assert.equal(isProtectedVersion(base, '1.0.0'), true);
});

test('known-good ordering returns latest valid tree and supports exclusion', () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  makeVersionTree(base, '1.0.1');
  markKnownGood(base, '1.0.0', new Date('2026-08-22T00:00:00.000Z'));
  markKnownGood(base, '1.0.1', new Date('2026-08-23T00:00:00.000Z'));
  const knownGoodState = listKnownGoodVersionsState(base);
  assert.deepEqual(knownGoodState, { kind: 'ok', versions: ['1.0.1', '1.0.0'] });
  // Production known-good candidate scan: first ledger entry that is not
  // excluded and whose tree passes the platform validation.
  const latestValidKnownGood = (excludeVersion: string | null = null): string | null =>
    knownGoodState.versions.find(version => version !== excludeVersion && validateVersionTree(base, version).ok) ?? null;
  assert.equal(latestValidKnownGood(), '1.0.1');
  assert.equal(latestValidKnownGood('1.0.1'), '1.0.0');
  rmSync(path.join(base, 'dsh-runtime', '1.0.1', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  assert.equal(latestValidKnownGood(), '1.0.0', 'invalid latest marker is skipped');
});

test('failure records are atomic, sanitized, cumulative, summarized, and protect the tree', () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  recordRuntimeFailure(base, {
    version: '1.0.0', phase: 'restore', error: new Error(`failed at ${base}/secret/file`),
    restoreOutcome: 'half', snapshotPath: path.join(base, 'dsh-runtime', 'snapshots', '1.0.0-123'),
  }, new Date('2026-08-22T00:00:00.000Z'));
  const second = recordRuntimeFailure(base, {
    version: '1.0.0', phase: 'restore', error: 'failed again', restoreOutcome: 'incomplete',
  }, new Date('2026-08-23T00:00:00.000Z'));
  assert.equal(second.occurrences, 2);
  assert.equal(second.firstFailedAt, '2026-08-22T00:00:00.000Z');
  assert.equal(second.lastFailedAt, '2026-08-23T00:00:00.000Z');
  assert.equal(second.restoreOutcome, 'incomplete');
  const failureState = readRuntimeFailureState(base, '1.0.0');
  assert.equal(failureState.kind, 'valid');
  if (failureState.kind === 'valid') assert.equal(failureState.record.occurrences, 2);
  assert.deepEqual(runtimeFailureSummary(base), { kind: 'ok', count: 1, latest: second, detail: null });
  assert.equal(isProtectedVersion(base, '1.0.0'), true);
  clearRuntimeFailure(base, '1.0.0');
  assert.deepEqual(readRuntimeFailureState(base, '1.0.0'), { kind: 'missing' });
});

test('corrupt failure evidence continues protecting its version after quarantine', () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  const file = path.join(base, 'dsh-runtime', 'failures', '1.0.0.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{ broken', 'utf8');
  assert.equal(readRuntimeFailureState(base, '1.0.0').kind, 'corrupt');
  assert.deepEqual(listRuntimeFailuresState(base), { kind: 'ok', failures: [] }, 'the set read quarantines the corrupt record and skips it');
  assert.ok(existsSync(`${file}.corrupt`));
  assert.equal(isProtectedVersion(base, '1.0.0'), true);
  assert.deepEqual(runtimeSnapshotRetentionState(base), {
    kind: 'corrupt',
    detail: 'failure evidence 已损坏；拒绝 prune',
  });
});

test('unsafe failure evidence directory fails closed for cleanup and eviction', () => {
  const base = freshBase();
  const tree = makeVersionTree(base, '1.0.0');
  recordExplicitInstall(base, '1.0.0');
  writeFileSync(path.join(base, 'dsh-runtime', 'failures'), 'not a directory');

  assert.equal(isProtectedVersion(base, '1.0.0'), true);
  assert.deepEqual(cleanupExplicitRuntimeVersion(base, '1.0.0'), {
    removed: false, retentionCleared: false, stillProtected: true,
  });
  assert.equal(existsSync(tree), true);
});

test('snapshot retention facts close over pointer/known-good/journal/failure references', () => {
  const base = freshBase();
  for (const version of ['1.0.0', '2.0.0', '3.0.0']) makeVersionTree(base, version);
  writeCurrentPointer(base, '1.0.0');
  markKnownGood(base, '2.0.0');
  writeActivationJournal(base, journalFixture('rollback-needed', {
    targetVersion: '3.0.0',
    rollbackTarget: '1.0.0',
    preSwapSnapshotName: '1.0.0-100',
  }));
  recordRuntimeFailure(base, {
    version: '3.0.0', phase: 'restore', error: 'x', snapshotPath: '/private/hidden/3.0.0-200',
  });
  assert.deepEqual(runtimeSnapshotRetentionState(base), {
    kind: 'valid',
    protectedVersions: ['1.0.0', '2.0.0', '3.0.0'],
    protectedSnapshotNames: ['1.0.0-100', '3.0.0-200'],
  });
});


/** Deterministic EACCES fixture: chmod 000 blocks a non-root POSIX reader,
 *  while root (and win32 mode semantics) cannot express the failure. */
const noPermissionFixture = {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)
    ? 'requires a non-root POSIX host (chmod 000 must block the reader)'
    : false,
}

test('unreadable selection metadata is unknown - never corrupt, never missing', noPermissionFixture, () => {
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  mkdirSync(runtimeDir, { recursive: true });
  chmodSync(runtimeDir, 0o000);
  try {
    const pointer = readCurrentPointerState(base);
    assert.equal(pointer.kind, 'unknown');
    assert.match(pointer.kind === 'unknown' ? pointer.detail : '', /EACCES/);
    const override = readOverrideState(base);
    assert.equal(override.kind, 'unknown');
  } finally {
    chmodSync(runtimeDir, 0o700);
  }
});

test('unreadable failure ledger reports unknown, never a fabricated count 0', noPermissionFixture, () => {
  const base = freshBase();
  const failures = path.join(base, 'dsh-runtime', 'failures');
  mkdirSync(failures, { recursive: true });
  chmodSync(failures, 0o000);
  try {
    const summary = runtimeFailureSummary(base);
    assert.equal(summary.kind, 'unknown');
    assert.equal(summary.count, null);
    assert.equal(summary.latest, null);
    assert.ok(summary.detail !== null);
    assert.equal(runtimeSnapshotRetentionState(base).kind, 'unknown');
  } finally {
    chmodSync(failures, 0o700);
  }
});

test('unreadable known-good ledger is an explicit unknown state, not an empty list', noPermissionFixture, () => {
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const file = path.join(runtimeDir, 'known-good.json');
  writeFileSync(file, JSON.stringify({ versions: { '1.0.0': '2026-08-23T00:00:00.000Z' } }), 'utf8');
  chmodSync(file, 0o000);
  try {
    const state = listKnownGoodVersionsState(base);
    assert.equal(state.kind, 'unknown');
    assert.equal(isProtectedVersion(base, '1.0.0'), true);
  } finally {
    chmodSync(file, 0o600);
  }
});

test('unreadable version tree validates as unknown, not invalid', noPermissionFixture, () => {
  const base = freshBase();
  const tree = path.join(base, 'dsh-runtime', '1.0.0');
  mkdirSync(tree, { recursive: true });
  chmodSync(tree, 0o000);
  try {
    const result = validateVersionTree(base, '1.0.0');
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'unknown');
  } finally {
    chmodSync(tree, 0o700);
  }
});
