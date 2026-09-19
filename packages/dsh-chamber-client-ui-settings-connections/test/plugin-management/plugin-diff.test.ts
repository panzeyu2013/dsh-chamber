/**
 * plugin-diff.ts unit tests (plain node:test, no dsh, no React): the four actionable
 * categories, version comparison, materialize name-matching (local file: vs remote
 * file: judged consistent, never a phantom update), unsyncable classification, the
 * empty-manifest cases, and the §6.11.5 protection boundary (protected/composition/seed
 * rows never reach computePluginDiff's inputs).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySpec,
  computePluginDiff,
  defaultChecked,
  isDifferenceRow,
  rowAddArg,
  type PluginRowKind,
} from '../../src/client/plugin-diff.ts'
import { actionableDependencies, type PluginRowShape } from '../../src/client/plugin-model.ts'
import { pluginRow } from '../support/fixtures.ts'
import type { LocalPluginManifest, RemotePluginManifest } from '../../src/global.d.ts'

/** Fixture projection: the manifest PLUS the additive §6.11.5 `rows` array this
 *  package's structural twin declares. computePluginDiff itself never reads
 *  `rows` — the boundary filter (actionableDependencies) does, and the tests
 *  that exercise it pass rows explicitly; the default is an empty projection. */
type LocalFixture = LocalPluginManifest & { rows: PluginRowShape[] }
type RemoteFixture = RemotePluginManifest & { rows: PluginRowShape[] }

function local(
  dependencies: Record<string, string>,
  bundles: string[] = [],
  clientLines: string[] = [],
  unsyncable: { name: string; reason: string }[] = [],
  bundleLines: string[] = [],
  rows: PluginRowShape[] = [],
): LocalFixture {
  // chamber is orthogonal to the diff — the fixtures use a neutral not-injected
  // state; computePluginDiff never reads it.
  return { dependencies, bundles, clientLines, bundleLines, unsyncable, rows, chamber: { ok: true, packages: [] } }
}

function remote(
  dependencies: Record<string, string>,
  bundles: string[] = [],
  profileExists = true,
  error?: string,
  rows: PluginRowShape[] = [],
): RemoteFixture {
  return {
    dependencies,
    bundles,
    profileExists,
    ...(error === undefined ? {} : { error }),
    rows,
    chamber: { ok: true, packages: [] },
  }
}

function byKind(result: ReturnType<typeof computePluginDiff>, kind: PluginRowKind): string[] {
  return result.rows.filter(row => row.kind === kind).map(row => row.name)
}

test('missing: local registry specs absent on remote, excluding unsyncable and materialize', () => {
  const result = computePluginDiff(
    local({ foo: '^1.0.0', bar: '2.0.0' }),
    remote({}),
  )
  assert.deepEqual(byKind(result, 'missing'), ['bar', 'foo'])
  assert.deepEqual(byKind(result, 'update'), [])
  assert.deepEqual(byKind(result, 'extra'), [])
  assert.deepEqual(byKind(result, 'materialize'), [])
  assert.deepEqual(byKind(result, 'unsyncable'), [])
})

test('update: both sides have a name but registry spec strings differ', () => {
  const result = computePluginDiff(
    local({ foo: '^1.0.0', bar: '~2.0.0' }),
    remote({ foo: '^1.2.0', bar: '~2.0.0' }),
  )
  assert.deepEqual(byKind(result, 'update'), ['foo'])
  assert.deepEqual(byKind(result, 'missing'), [])
  // equal spec → consistent, not update
  const consistent = result.rows.find(row => row.name === 'bar')
  assert.equal(consistent?.kind, 'consistent')
})

test('version comparison: distinct prerelease/build specs count as an update', () => {
  const result = computePluginDiff(
    local({ foo: '1.0.0-beta.1' }),
    remote({ foo: '1.0.0' }),
  )
  assert.deepEqual(byKind(result, 'update'), ['foo'])
})

test('extra: remote-only rows are the remove set (remote bundle layer only)', () => {
  const result = computePluginDiff(
    local({}),
    remote({ legacy: '^1.0.0', active: '2.0.0' }, ['active']),
  )
  assert.deepEqual(byKind(result, 'extra'), ['active', 'legacy'])
  const active = result.extra.find(row => row.name === 'active')
  assert.equal(active?.category, 'bundle')
  assert.equal(active?.localSpec, null)
  const legacy = result.extra.find(row => row.name === 'legacy')
  assert.equal(legacy?.category, 'plain')
})

test('materialize: local path spec absent on remote is materialize (default-checked)', () => {
  const result = computePluginDiff(
    local({ pkg: 'file:../pkg', link: 'link:../link' }),
    remote({}),
  )
  assert.deepEqual(byKind(result, 'materialize'), ['link', 'pkg'])
  assert.deepEqual(byKind(result, 'missing'), [])
  assert.ok(result.materialize.every(row => defaultChecked(row.kind)))
})

test('materialize name-match: local file: and remote file: tarball are consistent (no phantom update)', () => {
  const result = computePluginDiff(
    local({ pkg: 'file:../pkg' }),
    remote({ pkg: 'file:/home/user/.dsh-chamber/plugins/pkg-abc123.tgz' }),
  )
  assert.deepEqual(byKind(result, 'materialize'), [])
  assert.deepEqual(byKind(result, 'update'), [])
  assert.deepEqual(byKind(result, 'missing'), [])
  const row = result.rows.find(r => r.name === 'pkg')
  assert.equal(row?.kind, 'consistent')
})

test('materialize name-match: local file: vs remote registry spec is still materialize (name collision)', () => {
  const result = computePluginDiff(
    local({ pkg: 'file:../pkg' }),
    remote({ pkg: '^1.0.0' }),
  )
  assert.deepEqual(byKind(result, 'materialize'), ['pkg'])
})

test('unsyncable: workspace / git / url / range / alias are refused with a reason', () => {
  const result = computePluginDiff(
    local({
      ws: 'workspace:*',
      git: 'git+https://example.com/x.git',
      url: 'https://example.com/x.tgz',
      range: '>=1.0.0 <2.0.0',
      wildcard: '*',
      alias: 'npm:foo@1.0.0',
    }),
    remote({}),
  )
  assert.deepEqual(byKind(result, 'unsyncable'), ['alias', 'git', 'range', 'url', 'wildcard', 'ws'])
  assert.deepEqual(byKind(result, 'missing'), [])
  assert.deepEqual(byKind(result, 'materialize'), [])
  const reasons = Object.fromEntries(result.unsyncable.map(row => [row.name, row.reason]))
  assert.equal(reasons.ws, 'workspace protocol')
  assert.equal(reasons.git, 'git/URL dependency')
  assert.equal(reasons.url, 'git/URL dependency')
  assert.equal(reasons.range, 'version range / wildcard')
  assert.equal(reasons.wildcard, 'version range / wildcard')
  assert.equal(reasons.alias, 'alias spec')
})

test('unsyncable rows are never actionable and never default-checked', () => {
  const result = computePluginDiff(local({ ws: 'workspace:*' }), remote({}))
  const row = result.unsyncable[0]
  assert.equal(row?.kind, 'unsyncable')
  assert.equal(isDifferenceRow(row.kind), false)
  assert.equal(defaultChecked(row.kind), false)
})

test('category: bundle and client come from the local manifest; remote-only rows are bundle/plain', () => {
  const result = computePluginDiff(
    local({ b: '^1.0.0', c: '^1.0.0', p: '^1.0.0' }, ['b'], ['c']),
    remote({ r: '^1.0.0' }, ['r']),
  )
  const byName = Object.fromEntries(result.rows.map(row => [row.name, row.category]))
  assert.equal(byName.b, 'bundle')
  assert.equal(byName.c, 'client')
  assert.equal(byName.p, 'plain')
  assert.equal(byName.r, 'bundle')
})

test('unlocked: a floating tag flags the "install latest" hint, a pinned range does not', () => {
  const result = computePluginDiff(local({ foo: 'latest', pinned: '^1.0.0' }), remote({}))
  const foo = result.missing.find(row => row.name === 'foo')
  const pinned = result.missing.find(row => row.name === 'pinned')
  assert.equal(foo?.unlocked, true)
  assert.equal(pinned?.unlocked, false)
})

test('rowAddArg: registry rows pin name@spec, bare names pass name', () => {
  const result = computePluginDiff(
    local({ pinned: '^1.2.3', bare: 'bare' }),
    remote({}),
  )
  const byName = Object.fromEntries(result.rows.map(row => [row.name, row]))
  assert.equal(rowAddArg(byName.pinned), 'pinned@^1.2.3')
  assert.equal(rowAddArg(byName.bare), 'bare')
})

test('empty manifests: both empty produce no rows and a no-diff result', () => {
  const result = computePluginDiff(local({}), remote({}))
  assert.equal(result.rows.length, 0)
  assert.equal(result.missing.length, 0)
  assert.equal(result.update.length, 0)
  assert.equal(result.extra.length, 0)
  assert.equal(result.materialize.length, 0)
  assert.equal(result.unsyncable.length, 0)
})

test('classifySpec: pinned/tag specs are registry, paths are materialize, else unsyncable', () => {
  assert.deepEqual(classifySpec('^1.2.3'), { type: 'registry', unlocked: false })
  assert.deepEqual(classifySpec('1.2.3'), { type: 'registry', unlocked: false })
  assert.deepEqual(classifySpec('~1.2.3'), { type: 'registry', unlocked: false })
  assert.deepEqual(classifySpec('1.0.0-beta.1'), { type: 'registry', unlocked: false })
  assert.deepEqual(classifySpec('latest'), { type: 'registry', unlocked: true })
  assert.deepEqual(classifySpec('next'), { type: 'registry', unlocked: true })
  assert.deepEqual(classifySpec('file:../x'), { type: 'materialize' })
  assert.deepEqual(classifySpec('link:../x'), { type: 'materialize' })
  assert.deepEqual(classifySpec('FILE:../x'), { type: 'materialize' }, 'scheme matching is case-insensitive (main-side parity)')
  assert.deepEqual(classifySpec('LINK:../x'), { type: 'materialize' }, 'scheme matching is case-insensitive (main-side parity)')
  assert.deepEqual(classifySpec('./x'), { type: 'materialize' })
  assert.deepEqual(classifySpec('/abs/x'), { type: 'materialize' })
  assert.deepEqual(classifySpec('workspace:*').type, 'unsyncable')
  assert.deepEqual(classifySpec('git+https://x/y.git').type, 'unsyncable')
  assert.deepEqual(classifySpec('>=1.0.0 <2.0.0').type, 'unsyncable')
  // x-wildcards are RANGES: the main-process apply path rejects the whole
  // batch as unsyncable (desktop plugin-sync hasXWildcard) — the UI
  // classifier refuses them up front so no row is offered as actionable
  // (2026 audit R4 parity pin).
  for (const spec of ['x', '1.x', '1.2.x', '^1.x', '~2.x', 'v1.x']) {
    assert.deepEqual(classifySpec(spec), { type: 'unsyncable', reason: 'x-wildcard version is a range, not a locked version (use an exact version)' }, `${spec} is refused like the main process`)
  }
  assert.deepEqual(classifySpec('next'), { type: 'registry', unlocked: true }, 'dist-tags never trip the x-wildcard refusal')
  assert.deepEqual(classifySpec('lexical'), { type: 'registry', unlocked: true }, 'a tag merely CONTAINING x is not an x-wildcard (segment-anchored check)')
})

test('classifySpec: v-prefixed versions are pinned registry specs, never unlocked', () => {
  for (const spec of ['v1.2.3', '^v1.2.3', '~v1.2.3', 'v1']) {
    assert.deepEqual(classifySpec(spec), { type: 'registry', unlocked: false }, spec)
  }
  // A v-prefixed pinned spec round-trips through the diff as a pinned
  // missing row → rowAddArg keeps the pinned spec (no silent "install latest").
  const result = computePluginDiff(local({ foo: 'v1.2.3', bar: '^v2.0.0' }), remote({}))
  const byName = Object.fromEntries(result.rows.map(row => [row.name, row]))
  assert.equal(byName.foo?.kind, 'missing')
  assert.equal(byName.foo?.unlocked, false)
  assert.equal(byName.bar?.unlocked, false)
  assert.equal(rowAddArg(byName.foo), 'foo@v1.2.3')
  assert.equal(rowAddArg(byName.bar), 'bar@^v2.0.0')
})

test('classifySpec: path classification matches the main process (./ ../ only, not any dot-prefix)', () => {
  // Aligned with desktop plugin-sync.ts isMaterializeSpec (/^(file:|link:|\.{1,2}\/|\/|~\/)/i):
  assert.deepEqual(classifySpec('./x'), { type: 'materialize' })
  assert.deepEqual(classifySpec('../x'), { type: 'materialize' })
  assert.deepEqual(classifySpec('~/x'), { type: 'materialize' })
  // A bare dot-name (`.foo`) is NOT a path on either side → unsyncable, never
  // silently passed to `dsh plugin add`.
  assert.equal(classifySpec('.foo').type, 'unsyncable')
  const result = computePluginDiff(local({ dot: '.foo' }), remote({}))
  assert.deepEqual(byKind(result, 'unsyncable'), ['dot'])
  assert.deepEqual(byKind(result, 'materialize'), [])
  assert.deepEqual(byKind(result, 'missing'), [])
})

// ---------------------------------------------------------------------------
// Protection boundary (design 21 §6.11.5 硬要求): computePluginDiff's inputs
// only ever carry actionable rows — unprotected third-party / materialized,
// after the backend's `rows` projection (or the §6.11.7 legacy fallback).
// ---------------------------------------------------------------------------

test('protection boundary: protected/composition/seed names never appear in diff.rows', () => {
  const dependencies = {
    '@deepseek-ai/dsh-base': '^0.1.0',
    '@dsh-chamber/dsh-chamber-seed-client-graph': '^0.1.0',
    'third-party-a': '^1.0.0',
  }
  const rows = [
    pluginRow({ name: '@deepseek-ai/dsh-base', spec: '^0.1.0', role: 'composition', protected: true }),
    pluginRow({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', spec: '^0.1.0', role: 'seed', protected: true }),
    pluginRow({ name: 'third-party-a', spec: '^1.0.0', role: 'third-party', protected: false }),
  ]
  const localProjection = local(dependencies, [], [], [], [], rows)
  const remoteProjection = remote({}, [], true, undefined, rows)

  // 未收窄的输入确实把组合/播种行当 missing（missing 默认勾选 ⇒ doApply 会把
  // 它们变成 add spec 提交，后端整批拒绝）—— 这正是边界必须存在的原因。
  const raw = computePluginDiff(localProjection, remoteProjection)
  assert.deepEqual(byKind(raw, 'missing'), [
    '@deepseek-ai/dsh-base',
    '@dsh-chamber/dsh-chamber-seed-client-graph',
    'third-party-a',
  ])
  assert.equal(defaultChecked(raw.rows.find(row => row.name === '@deepseek-ai/dsh-base')?.kind ?? 'consistent'), true)

  // 收窄后（与 PluginDialog.loadSync 同一调用形状）：受保护/组合/播种名字绝不出现。
  const filtered = computePluginDiff(
    { ...localProjection, dependencies: actionableDependencies(dependencies, rows) },
    { ...remoteProjection, dependencies: actionableDependencies({}, rows) },
  )
  assert.deepEqual(byKind(filtered, 'missing'), ['third-party-a'])
  assert.equal(filtered.rows.length, 1)
  for (const name of ['@deepseek-ai/dsh-base', '@dsh-chamber/dsh-chamber-seed-client-graph']) {
    assert.equal(filtered.rows.some(row => row.name === name), false, `${name} must never appear in diff.rows`)
  }
})

test('protection boundary: a protected REMOTE row never becomes an actionable remove (extra) row', () => {
  const dependencies = { '@deepseek-ai/dsh-base': '^0.1.0', 'third-party-gone': '^1.0.0' }
  const rows = [
    pluginRow({ name: '@deepseek-ai/dsh-base', spec: '^0.1.0', role: 'composition', protected: true }),
    pluginRow({ name: 'third-party-gone', spec: '^1.0.0', role: 'third-party', protected: false }),
  ]
  const filtered = computePluginDiff(
    { ...local({}), dependencies: actionableDependencies({}, rows) },
    { ...remote(dependencies), dependencies: actionableDependencies(dependencies, rows) },
  )
  assert.deepEqual(byKind(filtered, 'extra'), ['third-party-gone'])
})

test('protection boundary: a runtime-family member (protected, third-party role) is dropped too', () => {
  const dependencies = { '@deepseek-ai/dsh-family-member': '^0.1.0', 'third-party-a': '^1.0.0' }
  const rows = [
    // F 成员（运行时线族）角色可能仍是 third-party —— protected 是唯一判据。
    pluginRow({ name: '@deepseek-ai/dsh-family-member', spec: '^0.1.0', role: 'third-party', protected: true }),
    pluginRow({ name: 'third-party-a', spec: '^1.0.0', role: 'third-party', protected: false }),
  ]
  const filtered = computePluginDiff(
    { ...local(dependencies), dependencies: actionableDependencies(dependencies, rows) },
    { ...remote({}), dependencies: actionableDependencies({}, rows) },
  )
  assert.deepEqual(byKind(filtered, 'missing'), ['third-party-a'])
})

test('protection boundary: a legacy (rows absent) projection keeps the legacyProtectedName filter', () => {
  const dependencies = { '@deepseek-ai/dsh': '^0.1.0', 'third-party-a': '^1.0.0' }
  const filtered = computePluginDiff(
    { ...local({}), dependencies: actionableDependencies({}, null) },
    { ...remote(dependencies), dependencies: actionableDependencies(dependencies, null) },
  )
  assert.deepEqual(byKind(filtered, 'extra'), ['third-party-a'])
  assert.equal(filtered.rows.some(row => row.name === '@deepseek-ai/dsh'), false)
})
