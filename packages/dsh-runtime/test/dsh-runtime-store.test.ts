/**
 * dsh-runtime-store.ts 目录数据面测试（design 18 §3.2/§3.5）——node:test，
 * 无 electron；baseDir 用 mkdtempSync(os.tmpdir()) 隔离（仿 chamber-settings
 * 测试）。覆盖：current 指针 round-trip / 损坏 / 原子写无残留 tmp；override
 * round-trip / 损坏 → *.corrupt 保留 + null；isProtectedVersion 四类受保护
 * （current / known-good / pending / .failed）与不受保护；listVersionTrees
 * 排除非版本树条目。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  activationJournalPath,
  clearActivationJournal,
  currentPointerPath,
  clearCurrentPointer,
  clearRuntimeFailure,
  clearStorePruneRequest,
  cleanupStaleInstalls,
  deleteOverride,
  evictVersions,
  forgetExplicitInstall,
  latestKnownGood,
  listExplicitlyInstalledVersions,
  listKnownGoodVersions,
  isProtectedVersion,
  listVersionTrees,
  markKnownGood,
  overridePath,
  queueActivationIntent,
  readCurrentPointer,
  readCurrentPointerState,
  readActivationJournalState,
  readOverride,
  readOverrideState,
  readRuntimeFailure,
  readStorePruneRequest,
  recordExplicitInstall,
  recordRuntimeFailure,
  runtimeDiskSummary,
  cleanupExplicitRuntimeVersion,
  runtimeFailureSummary,
  runtimeSnapshotRetentionState,
  validateVersionTree,
  writeCurrentPointer,
  writeActivationIntent,
  writeActivationJournal,
  writeOverride,
} from '../src/dsh-runtime-store.ts';
import type { ActivationJournal, OverrideRecord } from '../src/dsh-runtime-store.ts';
import {
  atomicWriteRuntimeFileNoFollow,
  createPrivateDirectoryNoFollow,
  createRuntimeFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
  quarantineRuntimeFileNoFollow,
  readPrivateFileNoFollow,
  removeRuntimeFileNoFollow,
} from '../src/private-fs.ts';

const freshBase = (): string => mkdtempSync(path.join(tmpdir(), 'dsh-runtime-store-'));

function makeVersionTree(base: string, version: string, platform = `${process.platform}-${process.arch}`): string {
  const tree = path.join(base, 'dsh-runtime', version);
  const binDir = path.join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'bin.js'), '// fixture', 'utf8');
  writeFileSync(path.join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version,
  }), 'utf8');
  const criticalFiles = Object.fromEntries([
    'node_modules/@deepseek-ai/dsh/package.json',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].map(relativePath => [
    relativePath,
    `sha256-${createHash('sha256').update(readFileSync(path.join(tree, relativePath))).digest('base64')}`,
  ]));
  writeFileSync(path.join(tree, 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh': version },
    dsh: { platform, criticalFiles },
  }), 'utf8');
  return tree;
}

function journalFixture(
  phase: ActivationJournal['phase'] = 'prepared',
  patch: Partial<ActivationJournal> = {},
): ActivationJournal {
  return {
    schemaVersion: 1,
    phase,
    targetVersion: '2.0.0',
    targetIsBuiltin: false,
    manualRollback: false,
    intentKind: 'version-switch',
    sourceVersion: '1.0.0',
    sourceIsBuiltin: false,
    sourceWasKnownGood: true,
    knownGoodVersion: '1.0.0',
    preSwapSnapshotName: '1.0.0-1724371200000',
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: null,
    nextIntent: null,
    startedAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    ...patch,
  };
}

test('private filesystem namespace commits fsync the pinned parent after mkdir/rename/create/unlink', () => {
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');

  let mkdirParentSyncs = 0;
  createPrivateDirectoryNoFollow(runtimeDir, {
    fsync(fd) {
      const opened = fstatSync(fd);
      const parent = statSync(base);
      assert.equal(opened.isDirectory(), true);
      assert.equal(opened.dev, parent.dev);
      assert.equal(opened.ino, parent.ino, 'mkdir syncs the exact held parent inode');
      assert.equal(existsSync(runtimeDir), true, 'mkdir is visible before parent fsync');
      mkdirParentSyncs += 1;
    },
  });
  assert.equal(mkdirParentSyncs, 1);

  const atomicFile = path.join(runtimeDir, 'atomic.json');
  const atomicEvents: string[] = [];
  atomicWriteRuntimeFileNoFollow(base, atomicFile, 'atomic', {
    fsync(fd) {
      const opened = fstatSync(fd);
      if (opened.isFile()) {
        assert.equal(existsSync(atomicFile), false, 'temporary contents sync before publish');
        atomicEvents.push('file-before-publish');
        return;
      }
      assert.equal(opened.isDirectory(), true);
      if (existsSync(atomicFile)) {
        const parent = statSync(runtimeDir);
        assert.equal(opened.dev, parent.dev);
        assert.equal(opened.ino, parent.ino, 'rename syncs the exact destination parent inode');
        atomicEvents.push('parent-after-publish');
      } else {
        atomicEvents.push('directory-before-publish');
      }
    },
  });
  assert.equal(readFileSync(atomicFile, 'utf8'), 'atomic');
  assert.equal(atomicEvents.filter(event => event === 'file-before-publish').length, 1);
  assert.equal(atomicEvents.at(-1), 'parent-after-publish');
  assert.ok(atomicEvents.indexOf('file-before-publish') < atomicEvents.indexOf('parent-after-publish'));

  const ownerFile = path.join(runtimeDir, 'owner.json');
  const exclusiveEvents: string[] = [];
  createRuntimeFileExclusiveNoFollow(base, ownerFile, 'owner', {
    fsync(fd) {
      const opened = fstatSync(fd);
      if (opened.isFile()) {
        assert.equal(existsSync(ownerFile), true);
        assert.equal(readFileSync(ownerFile, 'utf8'), 'owner');
        exclusiveEvents.push('file-after-create');
        return;
      }
      assert.equal(opened.isDirectory(), true);
      exclusiveEvents.push(existsSync(ownerFile) ? 'parent-after-create' : 'directory-before-create');
    },
  });
  assert.equal(statSync(ownerFile).mode & 0o777, 0o600);
  assert.equal(exclusiveEvents.filter(event => event === 'file-after-create').length, 1);
  assert.equal(exclusiveEvents.at(-1), 'parent-after-create');
  assert.ok(exclusiveEvents.indexOf('file-after-create') < exclusiveEvents.indexOf('parent-after-create'));
  assert.throws(
    () => createRuntimeFileExclusiveNoFollow(base, ownerFile, 'other', { fsync() {} }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
    'the exclusive primitive preserves raw O_EXCL contention evidence',
  );

  let unlinkParentSyncs = 0;
  removeRuntimeFileNoFollow(base, atomicFile, {
    fsync(fd) {
      const opened = fstatSync(fd);
      const parent = statSync(runtimeDir);
      assert.equal(opened.isDirectory(), true);
      assert.equal(opened.dev, parent.dev);
      assert.equal(opened.ino, parent.ino, 'unlink syncs the exact held parent inode');
      assert.equal(existsSync(atomicFile), false, 'unlink is visible before parent fsync');
      unlinkParentSyncs += 1;
    },
  });
  assert.equal(unlinkParentSyncs, 1);
  assert.equal(existsSync(atomicFile), false);
});

test('private filesystem never reports a namespace mutation successful when parent fsync fails', () => {
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  mkdirSync(runtimeDir, { mode: 0o700 });

  const atomicFile = path.join(runtimeDir, 'atomic.json');
  assert.throws(() => atomicWriteRuntimeFileNoFollow(base, atomicFile, 'published-before-error', {
    fsync(fd) {
      if (fstatSync(fd).isDirectory() && existsSync(atomicFile)) {
        throw new Error('injected rename parent fsync failure');
      }
    },
  }), /injected rename parent fsync failure/);
  assert.equal(readFileSync(atomicFile, 'utf8'), 'published-before-error',
    'the visible rename is retained as ambiguous evidence while the caller sees failure');

  assert.throws(() => removeRuntimeFileNoFollow(base, atomicFile, {
    fsync(fd) {
      if (fstatSync(fd).isDirectory() && !existsSync(atomicFile)) {
        throw new Error('injected unlink parent fsync failure');
      }
    },
  }), /injected unlink parent fsync failure/);
  assert.equal(existsSync(atomicFile), false, 'the caller sees failure even though unlink became visible');

  const child = path.join(runtimeDir, 'fresh-child');
  assert.throws(() => createPrivateDirectoryNoFollow(child, {
    fsync(fd) {
      assert.equal(fstatSync(fd).isDirectory(), true);
      if (existsSync(child)) throw new Error('injected mkdir parent fsync failure');
    },
  }), /injected mkdir parent fsync failure/);
  assert.equal(lstatSync(child).isDirectory(), true);
  let retrySyncs = 0;
  ensurePrivateDirectoryNoFollow(child, {
    fsync(fd) {
      assert.equal(fstatSync(fd).isDirectory(), true);
      retrySyncs += 1;
    },
  });
  assert.equal(retrySyncs, 1, 'EEXIST retry re-establishes the parent durability proof');

  const ownerFile = path.join(runtimeDir, 'owner.json');
  let exclusiveFileSynced = false;
  assert.throws(() => createRuntimeFileExclusiveNoFollow(base, ownerFile, 'owner-before-error', {
    fsync(fd) {
      const opened = fstatSync(fd);
      if (opened.isFile()) {
        exclusiveFileSynced = true;
      } else if (existsSync(ownerFile)) {
        throw new Error('injected exclusive parent fsync failure');
      }
    },
  }), /injected exclusive parent fsync failure/);
  assert.equal(exclusiveFileSynced, true, 'exclusive payload is synced before its parent');
  assert.equal(readFileSync(ownerFile, 'utf8'), 'owner-before-error');
  assert.throws(
    () => createRuntimeFileExclusiveNoFollow(base, ownerFile, 'second-owner', { fsync() {} }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
    'ambiguous exclusive-create evidence remains fail-closed after fsync failure',
  );
});

test('private filesystem reads a stable snapshot and avoids chmod side effects when modes already match', () => {
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  mkdirSync(runtimeDir, { mode: 0o700 });
  const file = path.join(runtimeDir, 'stable.json');
  writeFileSync(file, 'A'.repeat(256), { mode: 0o600 });
  chmodSync(runtimeDir, 0o700);
  chmodSync(file, 0o600);

  const parentBefore = statSync(runtimeDir, { bigint: true }).ctimeNs;
  const fileBefore = statSync(file, { bigint: true }).ctimeNs;
  const stable = readPrivateFileNoFollow(file, 1024);
  assert.equal(stable.kind, 'valid');
  assert.equal(statSync(runtimeDir, { bigint: true }).ctimeNs, parentBefore,
    'an already-private parent is not chmodded on read');
  assert.equal(statSync(file, { bigint: true }).ctimeNs, fileBefore,
    'an already-private file is not chmodded on read');

  let firstRead = true;
  const raced = readPrivateFileNoFollow(file, 1024, {
    read(fd, buffer, offset, length, position) {
      const count = readSync(fd, buffer, offset, length, position);
      if (firstRead) {
        firstRead = false;
        writeFileSync(file, 'B'.repeat(256));
        utimesSync(file, new Date('2000-01-01T00:00:00.000Z'), new Date('2000-01-01T00:00:00.000Z'));
      }
      return count;
    },
  });
  assert.deepEqual(raced, { kind: 'unsafe' },
    'same-inode/same-size mutation during the read is rejected as a torn snapshot');
});

test('private filesystem treats an absent remove as a side-effect-free no-op and durably quarantines evidence', () => {
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  mkdirSync(runtimeDir, { mode: 0o700 });

  removeRuntimeFileNoFollow(base, path.join(runtimeDir, 'already-gone.json'), {
    fsync() {
      throw new Error('absent remove must not fsync');
    },
  });

  const source = path.join(runtimeDir, 'override.json');
  const evidence = `${source}.corrupt`;
  writeFileSync(source, '{broken', { mode: 0o600 });
  let quarantineParentSyncs = 0;
  quarantineRuntimeFileNoFollow(base, source, evidence, {
    fsync(fd) {
      assert.equal(fstatSync(fd).isDirectory(), true);
      assert.equal(existsSync(source), false);
      assert.equal(readFileSync(evidence, 'utf8'), '{broken');
      quarantineParentSyncs += 1;
    },
  });
  assert.equal(quarantineParentSyncs, 1);
  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(evidence, 'utf8'), '{broken');
});

test('private filesystem detects a replaced parent and never follows it during temporary-file cleanup', t => {
  if (process.platform === 'win32') {
    t.skip('directory symlink race fixture requires POSIX rename semantics');
    return;
  }
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  const displacedRuntimeDir = path.join(base, 'dsh-runtime-displaced');
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-cleanup-outside-'));
  mkdirSync(runtimeDir, { mode: 0o700 });
  const destination = path.join(runtimeDir, 'authority.json');
  let tmpName: string | null = null;

  assert.throws(() => atomicWriteRuntimeFileNoFollow(base, destination, 'private-temp', {
    fsync(fd) {
      if (!fstatSync(fd).isFile()) return;
      tmpName = readdirSync(runtimeDir).find(name => name.startsWith('.authority.json.tmp-')) ?? null;
      assert.notEqual(tmpName, null);
      renameSync(runtimeDir, displacedRuntimeDir);
      symlinkSync(outsideDir, runtimeDir, 'dir');
      writeFileSync(path.join(outsideDir, tmpName!), 'outside-must-survive');
    },
  }), /身份复验失败/);

  assert.notEqual(tmpName, null);
  assert.equal(readFileSync(path.join(outsideDir, tmpName!), 'utf8'), 'outside-must-survive',
    'error cleanup never traverses the replacement parent symlink');
  assert.equal(readFileSync(path.join(displacedRuntimeDir, tmpName!), 'utf8'), 'private-temp',
    'unproved cleanup retains the exact private temporary evidence fail-closed');
});

test('current 指针: 缺失 → null; 写读 round-trip; 切换指针', () => {
  const base = freshBase();
  assert.equal(readCurrentPointer(base), null, '缺失 → null');
  assert.deepEqual(readCurrentPointerState(base), { kind: 'missing' });
  writeCurrentPointer(base, '0.1.1-rc.2');
  assert.equal(readCurrentPointer(base), '0.1.1-rc.2');
  assert.deepEqual(readCurrentPointerState(base), { kind: 'valid', version: '0.1.1-rc.2' });
  const raw = JSON.parse(readFileSync(currentPointerPath(base), 'utf8'));
  assert.deepEqual(raw, { version: '0.1.1-rc.2' }, '指针文件 = 普通 JSON {version}');
  writeCurrentPointer(base, '1.0.0');
  assert.equal(readCurrentPointer(base), '1.0.0');
});

test('current 指针: 损坏 → null（不误判、不写坏数据参与判定）', () => {
  const base = freshBase();
  mkdirSync(path.dirname(currentPointerPath(base)), { recursive: true });
  writeFileSync(currentPointerPath(base), '{ not json !!!', 'utf8');
  assert.equal(readCurrentPointer(base), null);
  assert.deepEqual(readCurrentPointerState(base), { kind: 'corrupt' });
  writeFileSync(currentPointerPath(base), '["nope"]', 'utf8');
  assert.equal(readCurrentPointer(base), null);
  writeFileSync(currentPointerPath(base), '{}', 'utf8');
  assert.equal(readCurrentPointer(base), null);
  writeFileSync(currentPointerPath(base), JSON.stringify({ version: '../evil' }), 'utf8');
  assert.equal(readCurrentPointer(base), null, '不安全版本串按损坏处理');
});

test('current 指针: 原子写（tmp + rename）后无残留 tmp; rename 失败时清理 tmp', () => {
  const base = freshBase();
  writeCurrentPointer(base, '0.1.1');
  assert.equal(readCurrentPointer(base), '0.1.1');
  assert.ok(!existsSync(`${currentPointerPath(base)}.tmp`), '成功写后 tmp 已由 rename 清理');
  // 用非空目录占据 dest → rename 必败（EISDIR/ENOTEMPTY）→ tmp 必须被清理
  rmSync(currentPointerPath(base), { force: true });
  mkdirSync(currentPointerPath(base), { recursive: true });
  writeFileSync(path.join(currentPointerPath(base), 'x'), 'x', 'utf8');
  assert.throws(() => writeCurrentPointer(base, '1.0.0'));
  assert.ok(!existsSync(`${currentPointerPath(base)}.tmp`), '异常后 tmp 已清理');
});

test('override: 缺失 → null; 写读 round-trip（含 null 字段）; 原子写无残留 tmp', () => {
  const base = freshBase();
  assert.equal(readOverride(base), null, '缺失 → null');
  const record: OverrideRecord = {
    shellVersion: '0.1.3',
    chosenVersion: '0.1.1-rc.2',
    resolvedVersion: '0.1.1-rc.2',
    pending: '1.0.0',
    swapAttempted: false,
    selectedOnly: true,
  };
  writeOverride(base, record);
  assert.deepEqual(readOverride(base), record);
  assert.ok(!existsSync(`${overridePath(base)}.tmp`), '成功写后 tmp 已由 rename 清理');
  const noPending: OverrideRecord = {
    shellVersion: '0.1.3',
    chosenVersion: null,
    resolvedVersion: null,
    pending: null,
    swapAttempted: true,
  };
  writeOverride(base, noPending);
  assert.deepEqual(readOverride(base), noPending);
  assert.throws(
    () => writeOverride(base, { ...noPending, selectedOnly: 'yes' as never }),
    /selectedOnly/,
    'the staged-selection authority marker is strictly boolean',
  );
});

test('override: 损坏 → 保留 *.corrupt 并返回 null（可逆，绝不静默当默认）', () => {
  const base = freshBase();
  mkdirSync(path.dirname(overridePath(base)), { recursive: true });
  writeFileSync(overridePath(base), '{ nope', 'utf8');
  assert.equal(readOverride(base), null);
  assert.ok(existsSync(`${overridePath(base)}.corrupt`), '损坏文件保留为 *.corrupt');
  assert.ok(!existsSync(overridePath(base)), '损坏文件已移走');
  assert.deepEqual(readOverrideState(base), { kind: 'corrupt' }, '后续启动仍 fail closed，不降级为 missing');
  // 形状不合法（缺字段）同样按损坏处理
  writeFileSync(overridePath(base), JSON.stringify({ shellVersion: '0.1.3' }), 'utf8');
  assert.equal(readOverride(base), null);
  assert.ok(existsSync(`${overridePath(base)}.corrupt`), '形状不合法同样保留 *.corrupt');
});

test('authority readers reject symlink leaves without reading, chmodding, or quarantining their targets', t => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires platform privileges on Windows');
    return;
  }
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-store-outside-'));
  const fixtures = [
    [currentPointerPath(base), JSON.stringify({ version: '1.0.0' }), () => readCurrentPointerState(base)],
    [overridePath(base), JSON.stringify({ shellVersion: '1.0.0', chosenVersion: null, resolvedVersion: null, pending: null, swapAttempted: false }), () => readOverrideState(base)],
    [activationJournalPath(base), JSON.stringify(journalFixture()), () => readActivationJournalState(base)],
  ] as const;
  for (const [leaf, bytes, read] of fixtures) {
    const target = path.join(outsideDir, path.basename(leaf));
    writeFileSync(target, bytes, { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, leaf);
    const before = statSync(target);
    assert.deepEqual(read(), { kind: 'corrupt' });
    const after = statSync(target);
    assert.equal(after.mode, before.mode);
    assert.equal(after.nlink, before.nlink);
    assert.deepEqual(readFileSync(target), Buffer.from(bytes));
    assert.equal(lstatSync(leaf).isSymbolicLink(), true);
    assert.equal(existsSync(`${leaf}.corrupt`), false);
  }
});

test('authority readers reject multiply linked leaves without mutating old evidence', () => {
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const evidenceDir = path.join(runtimeDir, 'metadata-recovery-data', 'old', 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const fixtures = [
    [currentPointerPath(base), JSON.stringify({ version: '1.0.0' }), () => readCurrentPointerState(base)],
    [overridePath(base), JSON.stringify({ shellVersion: '1.0.0', chosenVersion: null, resolvedVersion: null, pending: null, swapAttempted: false }), () => readOverrideState(base)],
    [activationJournalPath(base), JSON.stringify(journalFixture()), () => readActivationJournalState(base)],
  ] as const;
  for (const [leaf, bytes, read] of fixtures) {
    const evidence = path.join(evidenceDir, path.basename(leaf));
    writeFileSync(evidence, bytes, { mode: 0o640 });
    chmodSync(evidence, 0o640);
    linkSync(evidence, leaf);
    const before = statSync(evidence);
    assert.deepEqual(read(), { kind: 'corrupt' });
    const after = statSync(evidence);
    assert.equal(after.mode, before.mode);
    assert.equal(after.nlink, before.nlink);
    assert.equal(after.ctimeMs, before.ctimeMs);
    assert.deepEqual(readFileSync(evidence), Buffer.from(bytes));
    assert.equal(existsSync(leaf), true);
    assert.equal(existsSync(`${leaf}.corrupt`), false);
  }
});

test('authority readers reject a symlinked runtime directory without touching external metadata', t => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires platform privileges on Windows');
    return;
  }
  const base = freshBase();
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-store-parent-outside-'));
  const outsideFiles = [
    ['current', JSON.stringify({ version: '1.0.0' })],
    ['override.json', JSON.stringify({ shellVersion: '1.0.0', chosenVersion: null, resolvedVersion: null, pending: null, swapAttempted: false })],
    ['activation-journal.json', JSON.stringify(journalFixture())],
  ] as const;
  for (const [name, bytes] of outsideFiles) {
    writeFileSync(path.join(outsideDir, name), bytes, { mode: 0o644 });
    chmodSync(path.join(outsideDir, name), 0o644);
  }
  symlinkSync(outsideDir, path.join(base, 'dsh-runtime'));
  assert.deepEqual(readCurrentPointerState(base), { kind: 'corrupt' });
  assert.deepEqual(readOverrideState(base), { kind: 'corrupt' });
  assert.deepEqual(readActivationJournalState(base), { kind: 'corrupt' });
  for (const [name, bytes] of outsideFiles) {
    const file = path.join(outsideDir, name);
    assert.equal(statSync(file).mode & 0o777, 0o644);
    assert.deepEqual(readFileSync(file), Buffer.from(bytes));
  }
  assert.equal(readdirSync(outsideDir).some(name => name.includes('.corrupt')), false);
});

test('all metadata mutations reject symlinked runtime roots and critical leaves without touching targets', t => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires platform privileges on Windows');
    return;
  }

  const rootBase = freshBase();
  const outsideRoot = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-store-write-outside-'));
  const outsideCurrent = path.join(outsideRoot, 'current');
  writeFileSync(outsideCurrent, 'outside-root-sentinel', { mode: 0o644 });
  chmodSync(outsideCurrent, 0o644);
  symlinkSync(outsideRoot, path.join(rootBase, 'dsh-runtime'));
  const rootBefore = statSync(outsideCurrent);

  assert.throws(() => writeCurrentPointer(rootBase, '1.0.0'), /不安全/);
  assert.throws(() => clearCurrentPointer(rootBase), /不安全|拒绝/);
  assert.throws(() => recordRuntimeFailure(rootBase, {
    version: '1.0.0', phase: 'probe', error: 'must not escape',
  }), /不安全/);
  assert.throws(() => cleanupStaleInstalls(rootBase), /不安全/);
  const rootAfter = statSync(outsideCurrent);
  assert.equal(rootAfter.mode, rootBefore.mode);
  assert.equal(rootAfter.ctimeMs, rootBefore.ctimeMs);
  assert.equal(readFileSync(outsideCurrent, 'utf8'), 'outside-root-sentinel');
  assert.deepEqual(readdirSync(outsideRoot), ['current']);

  const leafBase = freshBase();
  const runtimeDir = path.join(leafBase, 'dsh-runtime');
  mkdirSync(path.join(runtimeDir, 'failures'), { recursive: true });
  const outsideLeafDir = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-store-leaf-outside-'));
  const pointerTarget = path.join(outsideLeafDir, 'pointer-target');
  const failureTarget = path.join(outsideLeafDir, 'failure-target');
  writeFileSync(pointerTarget, 'pointer-sentinel', { mode: 0o644 });
  writeFileSync(failureTarget, 'failure-sentinel', { mode: 0o644 });
  symlinkSync(pointerTarget, currentPointerPath(leafBase));
  symlinkSync(failureTarget, path.join(runtimeDir, 'failures', '1.0.0.json'));
  const pointerBefore = statSync(pointerTarget);
  const failureBefore = statSync(failureTarget);

  assert.throws(() => writeCurrentPointer(leafBase, '1.0.0'), /单链接普通文件/);
  assert.throws(() => clearCurrentPointer(leafBase), /不安全|拒绝/);
  assert.throws(() => recordRuntimeFailure(leafBase, {
    version: '1.0.0', phase: 'probe', error: 'must not escape',
  }), /不安全|拒绝/);
  assert.equal(lstatSync(currentPointerPath(leafBase)).isSymbolicLink(), true);
  assert.equal(lstatSync(path.join(runtimeDir, 'failures', '1.0.0.json')).isSymbolicLink(), true);
  assert.deepEqual(statSync(pointerTarget), pointerBefore);
  assert.deepEqual(statSync(failureTarget), failureBefore);
  assert.equal(readFileSync(pointerTarget, 'utf8'), 'pointer-sentinel');
  assert.equal(readFileSync(failureTarget, 'utf8'), 'failure-sentinel');
});

test('authority readers bound metadata reads and fail closed on oversized files', () => {
  const base = freshBase();
  const runtimeDir = path.join(base, 'dsh-runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const oversized = Buffer.alloc(129 * 1024, 0x20);
  writeFileSync(currentPointerPath(base), oversized);
  writeFileSync(overridePath(base), oversized);
  writeFileSync(activationJournalPath(base), oversized);
  assert.deepEqual(readCurrentPointerState(base), { kind: 'corrupt' });
  assert.deepEqual(readOverrideState(base), { kind: 'corrupt' });
  assert.deepEqual(readActivationJournalState(base), { kind: 'corrupt' });
  assert.equal(existsSync(`${overridePath(base)}.corrupt`), false, 'oversized unsafe input is never quarantined');
});

test('override: 写入前校验（不安全版本串拒绝，不落盘）', () => {
  const base = freshBase();
  assert.throws(() =>
    writeOverride(base, {
      shellVersion: '0.1.3',
      chosenVersion: '../evil',
      resolvedVersion: null,
      pending: null,
      swapAttempted: false,
    }),
  );
  assert.throws(() =>
    writeOverride(base, {
      shellVersion: '0.1.3',
      chosenVersion: null,
      resolvedVersion: null,
      pending: '1.0.0/..',
      swapAttempted: false,
    }),
  );
  assert.throws(() =>
    writeOverride(base, {
      shellVersion: '',
      chosenVersion: null,
      resolvedVersion: null,
      pending: null,
      swapAttempted: false,
    }),
  );
  assert.equal(readOverride(base), null, '拒绝后 override 未写入');
});

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
  assert.equal(readCurrentPointer(base), null);
  assert.deepEqual(readOverride(base), record, 'pointer clear preserves override history');
  deleteOverride(base);
  assert.equal(readOverride(base), null);
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
  assert.deepEqual(readOverride(base), record);
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
  assert.deepEqual(validateVersionTree(base, '1.0.0'), { ok: false, error: '版本树不存在或不可读' });
  mkdirSync(path.join(base, 'dsh-runtime', '1.0.0'), { recursive: true });
  const missingManifest = validateVersionTree(base, '1.0.0');
  assert.match(missingManifest.ok ? '' : missingManifest.error, /package\.json/);
  makeVersionTree(base, '1.0.0', 'wrong-platform');
  const wrongPlatform = validateVersionTree(base, '1.0.0');
  assert.match(wrongPlatform.ok ? '' : wrongPlatform.error, /平台/);
  makeVersionTree(base, '1.0.0');
  assert.deepEqual(validateVersionTree(base, '1.0.0'), { ok: true, path: path.join(base, 'dsh-runtime', '1.0.0') });
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
  assert.deepEqual(listKnownGoodVersions(base), ['1.0.1', '1.0.0']);
  assert.equal(latestKnownGood(base), '1.0.1');
  assert.equal(latestKnownGood(base, '1.0.1'), '1.0.0');
  rmSync(path.join(base, 'dsh-runtime', '1.0.1', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  assert.equal(latestKnownGood(base), '1.0.0', 'invalid latest marker is skipped');
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
  assert.equal(readRuntimeFailure(base, '1.0.0')?.occurrences, 2);
  assert.deepEqual(runtimeFailureSummary(base), { count: 1, latest: second });
  assert.equal(isProtectedVersion(base, '1.0.0'), true);
  clearRuntimeFailure(base, '1.0.0');
  assert.equal(readRuntimeFailure(base, '1.0.0'), null);
});

test('corrupt failure evidence continues protecting its version after quarantine', () => {
  const base = freshBase();
  makeVersionTree(base, '1.0.0');
  const file = path.join(base, 'dsh-runtime', 'failures', '1.0.0.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{ broken', 'utf8');
  assert.equal(readRuntimeFailure(base, '1.0.0'), null);
  assert.ok(existsSync(`${file}.corrupt`));
  assert.equal(isProtectedVersion(base, '1.0.0'), true);
  assert.deepEqual(runtimeSnapshotRetentionState(base), { kind: 'corrupt' });
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
  assert.equal(summary.totalBytes,
    summary.versionTreeBytes + summary.storeBytes + summary.cacheBytes
    + summary.installHomeBytes + summary.xdgCacheBytes + summary.workBytes
    + summary.failureBytes + summary.snapshotBytes + summary.preRollbackBytes
    + summary.restoreBackupBytes);

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
