/**
 * dsh-runtime-store.ts 目录数据面测试（design 18 §3.2/§3.5）——node:test，
 * 无 electron；baseDir 用 mkdtempSync(os.tmpdir()) 隔离（仿 chamber-settings
 * 测试）。覆盖：current 指针 round-trip / 损坏 / 原子写无残留 tmp；override
 * round-trip / 损坏 → *.corrupt 保留 + null；isProtectedVersion 四类受保护
 * （current / known-good / pending / .failed）与不受保护；listVersionTrees
 * 排除非版本树条目。
 *
 * Shared fixtures = test/support/store-fixtures.ts. Siblings:
 *   - dsh-runtime-store.test.ts (protection / journal / failure store)
 *   - disk-accounting.test.ts (runtimeDiskSummaryAsync accounting)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  activationJournalPath,
  clearCurrentPointer,
  cleanupStaleInstalls,
  currentPointerPath,
  overridePath,
  readActivationJournalState,
  readCurrentPointer,
  readCurrentPointerState,
  readOverride,
  readOverrideState,
  recordRuntimeFailure,
  writeCurrentPointer,
  writeOverride,
} from '../../src/dsh-runtime-store.ts';
import type { OverrideRecord } from '../../src/dsh-runtime-store.ts';
import {
  atomicWriteRuntimeFileNoFollow,
  createPrivateDirectoryNoFollow,
  createRuntimeFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
  quarantineRuntimeFileNoFollow,
  readPrivateFileNoFollow,
  removeRuntimeFileNoFollow,
} from '../../src/private-fs.ts';
import { freshBase, journalFixture } from '../support/store-fixtures.ts';

/** Skip the case when the platform cannot create symlinks. */
function skipUnlessSymlinks(t: { skip(message: string): void }): boolean {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires platform privileges on Windows');
    return true;
  }
  return false;
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
  if (skipUnlessSymlinks(t)) return;
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
  if (skipUnlessSymlinks(t)) return;
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
  if (skipUnlessSymlinks(t)) return;

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

