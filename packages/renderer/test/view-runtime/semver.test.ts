/**
 * SemVer precedence 单一实现契约（2026-12 阶段 2 单源化）。
 * 口径：非法输入 null；build metadata 不参与；prerelease 按规范方向。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver } from '../../src/semver.ts'

test('core triples compare numerically, not lexically', () => {
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0)
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1)
  assert.equal(compareSemver('0.9.9', '0.10.0'), -1)
})

test('prerelease ranks below the release and follows the spec direction', () => {
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10'), -1)
  assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-rc.1'), 0)
})

test('build metadata never affects precedence', () => {
  assert.equal(compareSemver('1.0.0+build1', '1.0.0+build2'), 0)
  assert.equal(compareSemver('1.0.0+build', '1.0.0'), 0)
  assert.equal(compareSemver('1.0.0-rc.1+x', '1.0.0-rc.1+y'), 0)
})

test('unparsable input answers null instead of guessing an order', () => {
  for (const bad of ['1.2', 'v1.2.3', '01.2.3', '1.2.3.4', '1.2.3-', '1.2.3+', '', 'foo']) {
    assert.equal(compareSemver(bad, '1.2.3'), null, bad)
    assert.equal(compareSemver('1.2.3', bad), null, bad)
  }
  assert.equal(compareSemver('1.2.3', 'not-a-version'), null)
})
