/**
 * version-safety.ts 纯逻辑测试（design 18 §4 路径安全）——node:test，无
 * electron。合法 semver（含 prerelease/build）通过；`..`、`/`、`\`、非 semver、
 * 空串拒绝；assertSafeVersion 不安全即 throw（错误信息含原始串）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXACT_SEMVER, assertSafeVersion, compareSemverAsc, isSafeVersion } from '../../src/version-safety.ts';

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

test('compareSemverAsc: semver §11 预发布优先级全序', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '2.0.0',
  ];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      const expected = i < j ? -1 : i > j ? 1 : 0;
      assert.equal(
        Math.sign(compareSemverAsc(ordered[i], ordered[j])),
        expected,
        `${ordered[i]} vs ${ordered[j]}`,
      );
    }
  }
});

test('compareSemverAsc: build metadata 不参与优先级', () => {
  assert.equal(compareSemverAsc('1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.equal(compareSemverAsc('1.0.0-rc.1+x', '1.0.0-rc.1'), 0);
  assert.equal(compareSemverAsc('1.0.0-rc.1+9', '1.0.0-rc.2'), -1);
});

test('compareSemverAsc: 数字标识符精确比较（无 Number 精度损失）且数字 < 字母数字', () => {
  assert.equal(compareSemverAsc('1.0.0-9007199254740992', '1.0.0-9007199254740993'), -1);
  assert.equal(compareSemverAsc('1.0.0-1', '1.0.0-alpha'), -1, 'numeric identifiers sort below alphanumeric');
  assert.equal(compareSemverAsc('1.0.0-alpha.1', '1.0.0-alpha'), 1, 'longer prerelease list has higher precedence');
});

test('compareSemverAsc: 非法串恒排在合法串之后，彼此相等（稳定总序）', () => {
  assert.equal(compareSemverAsc('latest', '1.0.0'), 1);
  assert.equal(compareSemverAsc('1.0.0', 'latest'), -1);
  assert.equal(compareSemverAsc('junk', 'nope'), 0);
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
