/**
 * plugin-diff.ts unit tests (plain node:test, no dsh, no React): the four
 * actionable categories, version comparison, materialize name-matching
 * (local file: vs remote file: judged consistent, never a phantom update),
 * unsyncable classification, and the empty-manifest cases.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySpec,
  computePluginDiff,
  defaultChecked,
  isDifferenceRow,
  materializeLocalDir,
  rowAddArg,
  type PluginRowKind,
} from './plugin-diff.ts'
import type { LocalPluginManifest, RemotePluginManifest } from '../global.d.ts'

function local(
  dependencies: Record<string, string>,
  bundles: string[] = [],
  clientLines: string[] = [],
  unsyncable: { name: string; reason: string }[] = [],
  bundleLines: string[] = [],
): LocalPluginManifest {
  // chamber is orthogonal to the diff — the fixtures use a neutral not-injected
  // state; computePluginDiff never reads it.
  return { dependencies, bundles, clientLines, bundleLines, unsyncable, chamber: { ok: true, hostGraph: { installed: false, patched: false, version: null, live: null } } }
}

function remote(
  dependencies: Record<string, string>,
  bundles: string[] = [],
  profileExists = true,
  error?: string,
): RemotePluginManifest {
  return {
    dependencies,
    bundles,
    profileExists,
    ...(error === undefined ? {} : { error }),
    chamber: { ok: true, hostGraph: { installed: false, patched: false, version: null, live: null } },
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

test('materializeLocalDir: absolute forms resolve, relative/home forms are unresolvable in the renderer', () => {
  assert.equal(materializeLocalDir('/abs/x'), '/abs/x')
  assert.equal(materializeLocalDir('file:/abs/x'), '/abs/x')
  assert.equal(materializeLocalDir('link:/abs/x'), '/abs/x')
  // Relative (./ ../) and home-relative (~/) specs are anchored to the local
  // profile/home that only the main process knows — the renderer must fail
  // loud, never fall back to a registry install.
  assert.equal(materializeLocalDir('file:../pkg'), null)
  assert.equal(materializeLocalDir('link:./pkg'), null)
  assert.equal(materializeLocalDir('./x'), null)
  assert.equal(materializeLocalDir('../x'), null)
  assert.equal(materializeLocalDir('~/x'), null)
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
  assert.deepEqual(classifySpec('./x'), { type: 'materialize' })
  assert.deepEqual(classifySpec('/abs/x'), { type: 'materialize' })
  assert.equal(classifySpec('workspace:*').type, 'unsyncable')
  assert.equal(classifySpec('git+https://x/y.git').type, 'unsyncable')
  assert.equal(classifySpec('>=1.0.0 <2.0.0').type, 'unsyncable')
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
