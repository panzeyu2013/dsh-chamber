/**
 * Remote plugin sync orchestration (design 13 M2+M3) unit tests — part 1:
 * localPluginList classification (bundle/client/plain/materialize/unsyncable +
 * path-traversal defense, registry-driven chamber projection, bundleLines) and
 * the spec/dependency classifiers.
 * Sibling parts: plugin-sync-remote-read.test.ts, plugin-sync-apply.test.ts, plugin-sync-seed.test.ts, plugin-sync-renderer-projection.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARCHIVE_CLEANUP_PACKAGE_NAME, classifyDependencyValue, classifyLocalDependency, classifySpec, CLIENT_GRAPH_PACKAGE_NAME, GIT_WORKTREE_PACKAGE_NAME, localPluginList, packageNameFromSpec, resolveLocalMaterializeDirectory, PLUGIN_SPEC_PATTERN, PLUGIN_NAME_PATTERN, CHAMBER_HOST_PACKAGES } from '../../plugin-sync.ts'
import { chamberPackageOf, chamberFacts, chamberStateOf } from '../support/chamber-projection.ts'
import { chamberFact, expectedChamberFacts, tempDir } from './plugin-sync-fixtures.ts'

function writeLocalProfile(root: string, dependencies: Record<string, string>, bundles: string[]): string {
  const profileDir = join(root, 'profiles', 'web')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }, undefined, 2))
  return profileDir
}

function writeDepManifest(profileDir: string, name: string, dsh?: unknown): void {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...(dsh !== undefined ? { dsh } : {}) }))
}

// ============================================================================
// classifySpec / packageNameFromSpec
// ============================================================================

test('classifySpec: registry specs sync, file/link/path materialize, ranges unsyncable', () => {
  assert.deepEqual(classifySpec('foo'), { kind: 'sync' })
  assert.deepEqual(classifySpec('foo@^1.2.3'), { kind: 'sync' })
  assert.deepEqual(classifySpec('@scope/foo@~2.0.0'), { kind: 'sync' })
  assert.deepEqual(classifySpec('foo@latest'), { kind: 'sync' })
  assert.deepEqual(classifySpec('file:../pkg'), { kind: 'materialize' })
  assert.deepEqual(classifySpec('link:./pkg'), { kind: 'materialize' })
  assert.deepEqual(classifySpec('../relative'), { kind: 'materialize' })
  assert.deepEqual(classifySpec('/abs/path'), { kind: 'materialize' })
  const unsyncable = classifySpec('foo@>=1.0.0 <2.0.0')
  assert.equal(unsyncable.kind, 'unsyncable')
  assert.equal(classifySpec('git+https://example.com/x.git').kind, 'unsyncable')
  assert.equal(classifySpec('npm:alias@^1.0.0').kind, 'unsyncable')
})
test('classifySpec / classifyDependencyValue reject semver x-wildcards (ranges)', () => {
  for (const spec of ['foo@1.x', 'foo@1.2.x', 'foo@x', '@scope/foo@1.x', 'foo@^1.x']) {
    assert.equal(classifySpec(spec).kind, 'unsyncable', `spec ${spec} is an x-wildcard range`)
  }
  for (const value of ['1.x', '1.2.x', 'x', '^1.x', '~1.2.x']) {
    assert.equal(classifyDependencyValue(value).kind, 'unsyncable', `value ${value} is an x-wildcard range`)
  }
  // Exact / locked versions still sync.
  assert.deepEqual(classifySpec('foo@1.2.3'), { kind: 'sync' })
  assert.deepEqual(classifyDependencyValue('^1.2.3'), { kind: 'sync' })
})
test('PLUGIN_SPEC_PATTERN / PLUGIN_NAME_PATTERN reject shell metacharacters and file specs', () => {
  for (const bad of ['foo; rm -rf /', 'foo | bar', 'foo@>1.0.0', 'foo@1.0.0 || foo@2.0.0', 'file:/tmp/x.tgz', 'foo@*', '$(whoami)']) {
    assert.equal(PLUGIN_SPEC_PATTERN.test(bad), false, `should reject ${bad}`)
  }
  assert.equal(PLUGIN_NAME_PATTERN.test('../../etc/passwd'), false)
  assert.equal(PLUGIN_NAME_PATTERN.test('@scope/pkg'), true)
  assert.equal(PLUGIN_NAME_PATTERN.test('pkg'), true)
})
test('packageNameFromSpec strips the version suffix', () => {
  assert.equal(packageNameFromSpec('foo'), 'foo')
  assert.equal(packageNameFromSpec('foo@^1.2.3'), 'foo')
  assert.equal(packageNameFromSpec('@scope/foo'), '@scope/foo')
  assert.equal(packageNameFromSpec('@scope/foo@1.0.0'), '@scope/foo')
})
test('classifyDependencyValue: ordinary version VALUES are syncable, never unsyncable', () => {
  // Dependency values are synced as `<name>@<value>` — a bare `^1.0.0` must
  // be judged by the version grammar, not the full name@spec grammar (the
  // old classifySpec mislabeled these as unsyncable → a wrong badge in the
  // local list tab).
  for (const value of ['^1.0.0', '~2.0.0', '1.2.3', 'v1.0.0', '1.0.0-beta.1', 'latest', 'next', '^0.0.1-alpha.2']) {
    assert.deepEqual(classifyDependencyValue(value), { kind: 'sync' }, `value ${value} is syncable`)
  }
  // Materialize specs keep their kind.
  assert.deepEqual(classifyDependencyValue('file:../pkg'), { kind: 'materialize' })
  assert.deepEqual(classifyDependencyValue('link:./pkg'), { kind: 'materialize' })
  assert.deepEqual(classifyDependencyValue('../relative'), { kind: 'materialize' })
  // Genuinely unsyncable values stay unsyncable with a reason.
  for (const value of ['workspace:*', 'npm:alias@^1.0.0', 'git+https://example.com/x.git', '>=1.0.0 <2.0.0', '1.0.0 || 2.0.0', '*']) {
    const cls = classifyDependencyValue(value)
    assert.equal(cls.kind, 'unsyncable', `value ${value} is unsyncable`)
    assert.ok(cls.kind === 'unsyncable' && cls.reason.length > 0, `value ${value} carries a reason`)
  }
})

// ============================================================================
// localPluginList
// ============================================================================

test('classifyLocalDependency: bundle / client / plain', () => {
  assert.equal(classifyLocalDependency({ dsh: { bundle: { patch: './cordis.patch.yml' } } }), 'bundle')
  assert.equal(classifyLocalDependency({ dsh: { client: { inject: [], platform: 'web' } } }), 'client')
  assert.equal(classifyLocalDependency({}), 'plain')
  assert.equal(classifyLocalDependency(null), 'plain')
})
test('localPluginList: classifies bundle/client/plain/materialize/unsyncable', () => {
  const root = tempDir()
  const profileDir = writeLocalProfile(root, {
    'bundle-pkg': '^1.0.0',
    'client-pkg': '1.2.3',
    'plain-pkg': '~2.0.0',
    'local-path-pkg': 'file:../local-pkg',
    'workspace-pkg': 'workspace:*',
  }, ['bundle-pkg'])
  writeDepManifest(profileDir, 'bundle-pkg', { bundle: { patch: './cordis.patch.yml' } })
  writeDepManifest(profileDir, 'client-pkg', { client: { inject: [], platform: 'web' } })
  writeDepManifest(profileDir, 'plain-pkg', {})
  const manifest = localPluginList(root)
  assert.deepEqual(manifest.bundles, ['bundle-pkg'])
  assert.deepEqual(manifest.clientLines, ['client-pkg'])
  assert.ok('bundle-pkg' in manifest.dependencies)
  assert.ok('plain-pkg' in manifest.dependencies)
  assert.equal(manifest.dependencies['local-path-pkg'], 'file:../local-pkg')
  // materialize is NOT unsyncable (syncable via pack+transfer); workspace is;
  // ordinary version-range values are NEVER flagged unsyncable (the value
  // grammar, not the full name@spec grammar, judges `^1.0.0`/`~2.0.0`).
  const unsyncNames = manifest.unsyncable.map(entry => entry.name)
  assert.ok(!unsyncNames.includes('local-path-pkg'))
  assert.ok(!unsyncNames.includes('bundle-pkg'), 'a ^1.0.0 value is syncable, not unsyncable')
  assert.ok(!unsyncNames.includes('client-pkg'))
  assert.ok(!unsyncNames.includes('plain-pkg'), 'a ~2.0.0 value is syncable, not unsyncable')
  assert.ok(unsyncNames.includes('workspace-pkg'))
  const workspaceEntry = manifest.unsyncable.find(entry => entry.name === 'workspace-pkg')
  assert.ok(workspaceEntry !== undefined)
  assert.match(workspaceEntry.reason, /workspace/)
})
test('localPluginList: unsafe dependency name is refused (path traversal defense)', () => {
  const root = tempDir()
  writeLocalProfile(root, { '../../etc/passwd': '^1.0.0' }, [])
  const manifest = localPluginList(root)
  assert.deepEqual(manifest.clientLines, [])
  const entry = manifest.unsyncable.find(item => item.name === '../../etc/passwd')
  assert.ok(entry !== undefined)
  assert.match(entry.reason, /safe registry name/)
})
test('localPluginList: throws on a missing profile manifest', () => {
  assert.throws(() => localPluginList(tempDir()), /cannot read local profile manifest/)
})
test('resolveLocalMaterializeDirectory: MAIN resolves the manifest entry and enforces package identity', () => {
  const root = tempDir()
  writeLocalProfile(root, { 'local-path-pkg': 'file:../local-pkg' }, [])
  const packageDir = join(root, 'profiles', 'local-pkg')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'local-path-pkg' }))
  assert.deepEqual(resolveLocalMaterializeDirectory(root, 'local-path-pkg'), { ok: true, path: realpathSync(packageDir) })
  assert.equal(resolveLocalMaterializeDirectory(root, 'not-in-manifest').ok, false)
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'different-package' }))
  const mismatched = resolveLocalMaterializeDirectory(root, 'local-path-pkg')
  assert.equal(mismatched.ok, false)
  if (!mismatched.ok) assert.match(mismatched.error, /does not match/)
})
test('localPluginList: the chamber projection is REGISTRY-DRIVEN — one row per control-plane host package (never a hardcoded pair)', () => {
  // The user-reported gap (2026-09): the plugin-management page showed only
  // client-graph + git-worktree because the projection hardcoded the pair, so
  // the seeded archive-cleanup package was invisible. The projection now maps
  // the control-plane registry 1:1 — a NEW registry row appears here (and in
  // the page) with no code change.
  const home = join(tempDir(), 'home')
  writeLocalProfile(home, {}, [])
  const manifest = localPluginList(home)
  assert.ok(manifest.chamber.ok)
  if (manifest.chamber.ok) {
    assert.deepEqual(
      manifest.chamber.packages.map(pkg => ({ insertId: pkg.insertId, name: pkg.name, probe: pkg.probe })),
      CHAMBER_HOST_PACKAGES.map(descriptor => ({
        insertId: descriptor.insert.id,
        name: descriptor.insert.name,
        probe: descriptor.probe.method,
      })),
      'the projection must mirror the registry exactly (order included)',
    )
    assert.equal(manifest.chamber.packages.length, CHAMBER_HOST_PACKAGES.length)
    assert.ok(manifest.chamber.packages.some(pkg => pkg.name === ARCHIVE_CLEANUP_PACKAGE_NAME), 'the third host package is projected')
  }
})
test('localPluginList: chamber host-graph state — installed + patched', () => {
  // Nest the dsh home under a base dir so the `--patch` overlay (which lives
  // BESIDE the home: dirname(home)/dsh-chamber-graph.patch.yml) stays inside
  // the temp sandbox.
  const base = tempDir()
  const home = join(base, 'home')
  const profileDir = writeLocalProfile(home, {}, [])
  const moduleADir = join(profileDir, 'node_modules', CLIENT_GRAPH_PACKAGE_NAME)
  mkdirSync(join(moduleADir, 'dist'), { recursive: true })
  writeFileSync(join(moduleADir, 'package.json'), '{"name":"@dsh-chamber/dsh-chamber-seed-client-graph"}')
  writeFileSync(join(moduleADir, 'dist', 'index.js'), 'export const graph = 1\n')
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), "- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n")
  const manifest = localPluginList(home)
  assert.deepEqual(chamberFacts(manifest.chamber), expectedChamberFacts({
    [CLIENT_GRAPH_PACKAGE_NAME]: chamberFact({ installed: true, patched: true }),
  }))
})
test('localPluginList: chamber host-graph state — absent = not injected (honest, never "done")', () => {
  const home = join(tempDir(), 'home')
  writeLocalProfile(home, {}, [])
  const manifest = localPluginList(home)
  assert.deepEqual(chamberFacts(manifest.chamber), expectedChamberFacts())
})
test('localPluginList: chamber host-graph state — package.json alone is a half-injected module A (installed:false)', () => {
  // The LOCAL `installed` uses the same TWO-file definition as the remote
  // probe and the seed writer (SEED_FILES / HOST_GRAPH_SEED_FILES): a
  // package.json without dist/index.js must report 未注入, never "done".
  const base = tempDir()
  const home = join(base, 'home')
  const profileDir = writeLocalProfile(home, {}, [])
  const moduleADir = join(profileDir, 'node_modules', CLIENT_GRAPH_PACKAGE_NAME)
  mkdirSync(moduleADir, { recursive: true })
  writeFileSync(join(moduleADir, 'package.json'), '{"name":"@dsh-chamber/dsh-chamber-seed-client-graph"}')
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), "- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n")
  const manifest = localPluginList(home)
  assert.deepEqual(chamberFacts(manifest.chamber), expectedChamberFacts({
    [CLIENT_GRAPH_PACKAGE_NAME]: chamberFact({ patched: true }),
  }))
})
test('localPluginList: chamber host-graph version is read from the seeded module A manifest', () => {
  const base = tempDir()
  const home = join(base, 'home')
  const profileDir = writeLocalProfile(home, {}, [])
  const moduleADir = join(profileDir, 'node_modules', CLIENT_GRAPH_PACKAGE_NAME)
  mkdirSync(join(moduleADir, 'dist'), { recursive: true })
  writeFileSync(join(moduleADir, 'package.json'), '{"name":"@dsh-chamber/dsh-chamber-seed-client-graph","version":"0.1.2"}')
  writeFileSync(join(moduleADir, 'dist', 'index.js'), 'export const graph = 1\n')
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), '- insert:\n    - id: client-graph\n')
  const manifest = localPluginList(home)
  assert.ok(manifest.chamber.ok)
  if (manifest.chamber.ok) {
    assert.equal(chamberPackageOf(manifest.chamber, CLIENT_GRAPH_PACKAGE_NAME).version, '0.1.2', 'the seeded package version is projected')
    assert.equal(chamberPackageOf(manifest.chamber, CLIENT_GRAPH_PACKAGE_NAME).live, null, 'local side has no separate liveness probe')
  }
})
test('localPluginList: git-worktree patched is CONTENT-aware — a stale overlay without the git row is not "patched"', () => {
  // The overlay regenerates per spawn with only the rows whose built
  // artifacts exist; a stale overlay can carry only the client-graph row
  // even after the git package files were seeded. The LOCAL gitWorktree
  // state must reflect that (files present + row absent = half-injected,
  // never 已注入).
  const base = tempDir()
  const home = join(base, 'home')
  const profileDir = writeLocalProfile(home, {}, [])
  // Both packages' files present.
  for (const name of [CLIENT_GRAPH_PACKAGE_NAME, GIT_WORKTREE_PACKAGE_NAME]) {
    const pkgDir = join(profileDir, 'node_modules', name)
    mkdirSync(join(pkgDir, 'dist'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), `{"name":"${name}"}`)
    writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export const x = 1\n')
  }
  // Stale overlay: only the client-graph row.
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), "- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n")
  const stale = localPluginList(home)
  assert.ok(stale.chamber.ok)
  if (stale.chamber.ok) {
    assert.deepEqual(chamberStateOf(stale.chamber, GIT_WORKTREE_PACKAGE_NAME), { installed: true, patched: false, version: null, live: null })
  }
  // Regenerated overlay with BOTH rows → patched.
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), "- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n")
  const fresh = localPluginList(home)
  assert.ok(fresh.chamber.ok)
  if (fresh.chamber.ok) {
    assert.deepEqual(chamberStateOf(fresh.chamber, GIT_WORKTREE_PACKAGE_NAME), { installed: true, patched: true, version: null, live: null })
  }
  // Absent overlay → not patched.
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), '')
  const none = localPluginList(home)
  assert.ok(none.chamber.ok)
  if (none.chamber.ok) {
    assert.equal(chamberPackageOf(none.chamber, GIT_WORKTREE_PACKAGE_NAME).patched, false)
  }
})

/** Seed one chamber host package's two files into a profile's node_modules. */
function seedChamberPackage(profileDir: string, name: string): void {
  const pkgDir = join(profileDir, 'node_modules', name)
  mkdirSync(join(pkgDir, 'dist'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name }))
  writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export const x = 1\n')
}

/** The canonical client-graph insert row (overlay file and profile patch alike). */
const CLIENT_GRAPH_ROW = "- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n"

test('localPluginList: chamber patched reads BOTH mount sources — the profile patch layer is one (T20 regression)', () => {
  // The probe used to read ONLY the spawn `--patch` overlay file, but app-boot
  // composes the profile's OWN `<profile>/cordis.patch.yml` as the user layer
  // over the empty root, and the control plane deliberately OMITS a row already
  // carried there from the overlay (duplicate loader identities would fail the
  // boot). A machine whose chamber rows live in the profile patch therefore
  // reported patched:false — a permanent false 未注入 for a row that IS in the
  // composed tree.
  const base = tempDir()
  const home = join(base, 'home')
  const profileDir = writeLocalProfile(home, {}, [])
  seedChamberPackage(profileDir, CLIENT_GRAPH_PACKAGE_NAME)
  // The user layer carries the exact insert row; no --patch overlay file exists.
  writeFileSync(join(profileDir, 'cordis.patch.yml'), CLIENT_GRAPH_ROW)
  const manifest = localPluginList(home)
  assert.equal(chamberStateOf(manifest.chamber, CLIENT_GRAPH_PACKAGE_NAME).patched, true,
    'a row carried by the profile patch layer IS mounted — the probe must not require the overlay file')
})
test('localPluginList: chamber patched covers the four mount-source combinations', () => {
  // Mount sources: the profile's own cordis.patch.yml (user layer) and the
  // `--patch` overlay the control plane passes at spawn. The overlay file
  // exists exactly when that spawn passes it — the control plane CLEARS a
  // leftover file when it resolves no overlay (no built artifact, or every row
  // already user-owned in the profile patch), so a stale file can never claim
  // a row the tree does not carry.
  const scenarios = [
    { label: 'profile patch only', profilePatch: true, overlay: false, patched: true },
    { label: 'overlay only (this spawn passes --patch)', profilePatch: false, overlay: true, patched: true },
    { label: 'no overlay passed (the leftover file is cleared by the control plane)', profilePatch: false, overlay: false, patched: false },
    { label: 'both sources carry the row', profilePatch: true, overlay: true, patched: true },
  ] as const
  for (const scenario of scenarios) {
    const base = tempDir()
    const home = join(base, 'home')
    const profileDir = writeLocalProfile(home, {}, [])
    seedChamberPackage(profileDir, CLIENT_GRAPH_PACKAGE_NAME)
    if (scenario.profilePatch) writeFileSync(join(profileDir, 'cordis.patch.yml'), CLIENT_GRAPH_ROW)
    if (scenario.overlay) writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), CLIENT_GRAPH_ROW)
    assert.equal(
      chamberStateOf(localPluginList(home).chamber, CLIENT_GRAPH_PACKAGE_NAME).patched,
      scenario.patched,
      scenario.label,
    )
  }
})

// ============================================================================
// localPluginList: bundleLines
// ============================================================================

test('localPluginList: bundleLines collects bundle-declaring dependency names', () => {
  const root = tempDir()
  const profileDir = writeLocalProfile(root, { 'bundle-pkg': '^1.0.0', 'plain-pkg': '1.0.0' }, ['bundle-pkg'])
  writeDepManifest(profileDir, 'bundle-pkg', { bundle: { patch: './cordis.patch.yml' } })
  writeDepManifest(profileDir, 'plain-pkg', {})
  const manifest = localPluginList(root)
  assert.deepEqual(manifest.bundleLines, ['bundle-pkg'])
})
