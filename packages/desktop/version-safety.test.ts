/**
 * version-safety.ts 纯逻辑测试（design 16 §4 路径安全）——node:test，无
 * electron。合法 semver（含 prerelease/build）通过；`..`、`/`、`\`、非 semver、
 * 空串拒绝；assertSafeVersion 不安全即 throw（错误信息含原始串）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXACT_SEMVER, assertSafeVersion, isSafeVersion } from './version-safety.ts';

test('EXACT_SEMVER: 与 bundle-dsh.mjs 第 69 行同口径（精确 semver，含 prerelease/build）', () => {
  assert.equal(EXACT_SEMVER.test('0.1.1'), true);
  assert.equal(EXACT_SEMVER.test('0.1.1-rc.2'), true);
  assert.equal(EXACT_SEMVER.test('1.2.3-beta.1+build.5'), true);
  assert.equal(EXACT_SEMVER.test('latest'), false);
  assert.equal(EXACT_SEMVER.test('1.0'), false);
  assert.equal(EXACT_SEMVER.test('1.0.0-'), false);
  assert.equal(EXACT_SEMVER.test('01.0.0'), false);
  assert.equal(EXACT_SEMVER.test('1.0.0-01'), false);
});

test('isSafeVersion: 合法 semver（含 prerelease / build metadata / 首尾空白）通过', () => {
  for (const ok of [
    '0.1.1',
    '1.2.3',
    '10.20.30',
    '0.0.0',
    '0.1.1-rc.2',
    '1.2.3-alpha.1',
    '1.2.3-beta.1+build.5',
    '1.0.0+build.meta',
    '1.0.0-rc.1+build.1',
    ' 0.1.1 ',
    '\t0.1.1-rc.2\n',
  ]) {
    assert.equal(isSafeVersion(ok), true, `should accept ${JSON.stringify(ok)}`);
  }
});

test('isSafeVersion: 含 .. 拒绝（prerelease/build 段的 `..` 能过正则，纵深防御必须拦）', () => {
  for (const bad of ['1.0.0-..', '1.0.0-..a', '../0.1.1', '0.1.1/..', 'a/../0.1.1']) {
    assert.equal(isSafeVersion(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('isSafeVersion: 含 / 或 \\ 拒绝（路径穿越面）', () => {
  for (const bad of ['1.0.0/evil', '1.0.0\\evil', '/1.0.0', '1.0.0-rc.2/../x']) {
    assert.equal(isSafeVersion(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('isSafeVersion: 非 semver / 空串拒绝', () => {
  for (const bad of ['', '   ', 'latest', 'v1.0.0', '1.0', '1', '0.1', '1.0.0-', '1.0.0.1', '0.1.1_rc2']) {
    assert.equal(isSafeVersion(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('assertSafeVersion: 安全版本返回 trim 后的版本串', () => {
  assert.equal(assertSafeVersion('0.1.1-rc.2'), '0.1.1-rc.2');
  assert.equal(assertSafeVersion(' 1.2.3+build '), '1.2.3+build');
  assert.equal(assertSafeVersion(' 0.1.1 '), '0.1.1');
});

test('assertSafeVersion: 不安全版本 throw，错误信息含原始串', () => {
  for (const bad of ['../0.1.1', '1.0.0/..', '1.0.0-..', '1.0.0\\x', 'latest', '', '   ']) {
    assert.throws(
      () => assertSafeVersion(bad),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'must throw an Error');
        assert.ok(
          error.message.includes(JSON.stringify(bad)),
          `message must mention the original raw ${JSON.stringify(bad)}: ${error.message}`,
        );
        return true;
      },
      `assertSafeVersion should throw for ${JSON.stringify(bad)}`,
    );
  }
});
