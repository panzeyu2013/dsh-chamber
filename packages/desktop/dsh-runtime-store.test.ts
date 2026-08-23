/**
 * dsh-runtime-store.ts 目录数据面测试（design 16 §3.2/§3.5）——node:test，
 * 无 electron；baseDir 用 mkdtempSync(os.tmpdir()) 隔离（仿 chamber-settings
 * 测试）。覆盖：current 指针 round-trip / 损坏 / 原子写无残留 tmp；override
 * round-trip / 损坏 → *.corrupt 保留 + null；isProtectedVersion 四类受保护
 * （current / known-good / pending / .failed）与不受保护；listVersionTrees
 * 排除非版本树条目。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  currentPointerPath,
  isProtectedVersion,
  listVersionTrees,
  markKnownGood,
  overridePath,
  readCurrentPointer,
  readOverride,
  writeCurrentPointer,
  writeOverride,
} from './dsh-runtime-store.ts';
import type { OverrideRecord } from './dsh-runtime-store.ts';

const freshBase = (): string => mkdtempSync(path.join(tmpdir(), 'dsh-runtime-store-'));

test('current 指针: 缺失 → null; 写读 round-trip; 切换指针', () => {
  const base = freshBase();
  assert.equal(readCurrentPointer(base), null, '缺失 → null');
  writeCurrentPointer(base, '0.1.1-rc.2');
  assert.equal(readCurrentPointer(base), '0.1.1-rc.2');
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
});

test('override: 损坏 → 保留 *.corrupt 并返回 null（可逆，绝不静默当默认）', () => {
  const base = freshBase();
  mkdirSync(path.dirname(overridePath(base)), { recursive: true });
  writeFileSync(overridePath(base), '{ nope', 'utf8');
  assert.equal(readOverride(base), null);
  assert.ok(existsSync(`${overridePath(base)}.corrupt`), '损坏文件保留为 *.corrupt');
  assert.ok(!existsSync(overridePath(base)), '损坏文件已移走');
  // 形状不合法（缺字段）同样按损坏处理
  writeFileSync(overridePath(base), JSON.stringify({ shellVersion: '0.1.3' }), 'utf8');
  assert.equal(readOverride(base), null);
  assert.ok(existsSync(`${overridePath(base)}.corrupt`), '形状不合法同样保留 *.corrupt');
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
