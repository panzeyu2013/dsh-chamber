/**
 * plugin-manifest 单一定义（design 21 §3 readManifest / §6.2 掩码纪律）：
 * parse 容错矩阵、dependencies/bundles 投影、版本读取、路径判据、掩码与
 * x-wildcard 版本门——正是 gateway / 客户端 / desktop 三处曾各自实现的那套语义。
 * 单一来源 = @dsh-chamber/dsh-chamber-wire/plugin-manifest；本套件把它钉死，
 * 并断言 control-plane 的公开面（掩码常量、readInstalledVersion 版本判据）消费同源。
 *
 * Run directly: node packages/control-plane/test/plugins/plugin-manifest.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasXWildcard,
  isMaterializedValue,
  maskMaterializedDependencies,
  parsePluginManifest,
  PLUGIN_MATERIALIZED_VALUE_MASK,
  readManifestVersion,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
import {
  PLUGIN_MATERIALIZED_VALUE_MASK as CONTROL_PLANE_MASK,
  readInstalledVersion,
} from '../../src/protected-plugins.ts'

test('parsePluginManifest: valid manifest → string-valued dependencies + string bundles', () => {
  const parsed = parsePluginManifest(JSON.stringify({
    dependencies: { a: '^1.0.0', local: 'file:../pkg', 'object-spec': { nested: true }, 'number-spec': 3, 'null-spec': null },
    dsh: { profile: { bundles: ['b', 5, null, 'c'] } },
  }))
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.deepEqual(parsed.dependencies, { a: '^1.0.0', local: 'file:../pkg' })
    assert.deepEqual(parsed.bundles, ['b', 'c'])
  }
})

test('parsePluginManifest: invalid JSON → invalid-json with the JSON error detail', () => {
  const parsed = parsePluginManifest('{ nope')
  assert.equal(parsed.ok, false)
  if (!parsed.ok) {
    assert.equal(parsed.fault, 'invalid-json')
    assert.ok(parsed.detail.length > 0, 'the JSON error text must be carried for the backend message')
  }
})

test('parsePluginManifest: null / array / primitive → not-an-object (never a guessed model)', () => {
  for (const text of ['null', '[]', '3', '"text"', 'true']) {
    const parsed = parsePluginManifest(text)
    assert.equal(parsed.ok, false, text)
    if (!parsed.ok) {
      assert.equal(parsed.fault, 'not-an-object', text)
      assert.equal(parsed.detail, '', text)
    }
  }
})

test('parsePluginManifest: bundles walk tolerates an absent/misshaped dsh block at every depth', () => {
  for (const manifest of [{}, { dsh: null }, { dsh: 'text' }, { dsh: { profile: 7 } }, { dsh: { profile: { bundles: 'not-an-array' } } }, { dsh: { profile: { bundles: null } } }]) {
    const parsed = parsePluginManifest(JSON.stringify(manifest))
    assert.equal(parsed.ok, true, JSON.stringify(manifest))
    if (parsed.ok) assert.deepEqual(parsed.bundles, [], JSON.stringify(manifest))
  }
})

test('readManifestVersion: non-empty string only; anything else null', () => {
  assert.equal(readManifestVersion({ version: '1.2.3' }), '1.2.3')
  for (const manifest of [
    { version: '' },
    { version: 5 },
    { version: null },
    {},
    null,
    [],
    '1.2.3',
    7,
  ]) {
    assert.equal(readManifestVersion(manifest), null, JSON.stringify(manifest))
  }
})

test('isMaterializedValue: 路径形态才算 materialize，semver 范围/标签绝不算', () => {
  for (const value of ['file:../p', 'FILE:/abs/p', 'link:./p', './p', '../p', '.', '..', '/abs/p', '~/p', '~\\p', '~',
    'C:\\p', '\\\\server\\share', 'c:/p']) {
    assert.equal(isMaterializedValue(value), true, value)
  }
  for (const value of ['~1.2.0', '~1.2', '^1.2.3', '>=1.0.0 <2', '1.x', '*', 'latest', 'next', 'beta',
    'workspace:*', 'npm:alias@1.0.0', 'git+https://x/y.git', 'https://x/y.tgz', '1.2.3', '.foo', '']) {
    assert.equal(isMaterializedValue(value), false, value)
  }
})

test('maskMaterializedDependencies: every path form masked, registry values verbatim, idempotent', () => {
  const masked = maskMaterializedDependencies({
    a: '^1.0.0',
    b: '~2.0.0',
    c: 'file:../pkg',
    d: 'link:./pkg',
    e: '../sibling',
    f: '/abs/pkg',
    g: '~/pkg',
    h: 'C:\\pkg',
    [PLUGIN_MATERIALIZED_VALUE_MASK]: PLUGIN_MATERIALIZED_VALUE_MASK,
  })
  assert.deepEqual(masked, {
    a: '^1.0.0',
    b: '~2.0.0',
    c: PLUGIN_MATERIALIZED_VALUE_MASK,
    d: PLUGIN_MATERIALIZED_VALUE_MASK,
    e: PLUGIN_MATERIALIZED_VALUE_MASK,
    f: PLUGIN_MATERIALIZED_VALUE_MASK,
    g: PLUGIN_MATERIALIZED_VALUE_MASK,
    h: PLUGIN_MATERIALIZED_VALUE_MASK,
    [PLUGIN_MATERIALIZED_VALUE_MASK]: PLUGIN_MATERIALIZED_VALUE_MASK,
  })
  assert.deepEqual(maskMaterializedDependencies(masked), masked, 'the mask is idempotent')
})

test('hasXWildcard: segment-anchored x-wildcards only, dist-tags never trip it', () => {
  for (const value of ['x', '1.x', '1.2.x', '^1.x', '~2.x', 'v1.x']) {
    assert.equal(hasXWildcard(value), true, value)
  }
  for (const value of ['1.2.3', 'latest', 'next', 'beta', 'lexical', '^1.2.3', '~1.2.3']) {
    assert.equal(hasXWildcard(value), false, value)
  }
})

test('single source lockstep: control-plane 的掩码公开面就是 wire 常量', () => {
  assert.equal(CONTROL_PLANE_MASK, PLUGIN_MATERIALIZED_VALUE_MASK)
  assert.equal(PLUGIN_MATERIALIZED_VALUE_MASK, 'file:<hidden>')
})

test('readInstalledVersion: version semantics resolve to the wire definition', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-manifest-'))
  try {
    const profileDir = join(root, 'profiles', 'web')
    const put = (name: string, text: string): void => {
      mkdirSync(join(profileDir, 'node_modules', name), { recursive: true })
      writeFileSync(join(profileDir, 'node_modules', name, 'package.json'), text)
    }
    put('good', JSON.stringify({ name: 'good', version: '1.2.3' }))
    put('empty', JSON.stringify({ name: 'empty', version: '' }))
    put('numeric', JSON.stringify({ name: 'numeric', version: 5 }))
    put('array', '[1]')
    put('broken', '{ nope')
    assert.equal(readInstalledVersion(profileDir, 'good'), '1.2.3')
    for (const name of ['empty', 'numeric', 'array', 'broken', 'missing']) {
      assert.equal(readInstalledVersion(profileDir, name), null, name)
    }
    assert.equal(readInstalledVersion(profileDir, '../escape'), null, 'unsafe names never reach a path join')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
