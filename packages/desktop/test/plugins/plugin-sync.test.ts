/**
 * Remote plugin sync orchestration (design 13 M2+M3) unit tests — part 1:
 * localPluginList classification (bundle/client/plain/materialize/unsyncable +
 * path-traversal defense, registry-driven chamber projection, bundleLines) and
 * the spec/dependency classifiers.
 * Sibling part: plugin-sync-apply.test.ts. Round-2 trim merged the remote-read,
 * renderer-projection and seed fail-closed assertions in as part 1b.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARCHIVE_CLEANUP_PACKAGE_NAME, classifyDependencyValue, classifyLocalDependency, classifySpec, CLIENT_GRAPH_INSERT_ID, CLIENT_GRAPH_PACKAGE_NAME, computeCordisPatchUpdate, GIT_WORKTREE_INSERT_ID, GIT_WORKTREE_PACKAGE_NAME, guardPluginMutation, isAllowedLocalFileSpec, localPluginList, MATERIALIZED_VALUE_MASK, packageNameFromSpec, resolveLocalMaterializeDirectory, PLUGIN_SPEC_PATTERN, PLUGIN_NAME_PATTERN, CHAMBER_HOST_PACKAGES, redactLocalPluginManifest, redactRemotePluginManifest, remotePluginList, runLocalDshPlugin, seedRemoteChamberHostPackages, shouldPreferPinnedRuntimeLockfile, sshProtectionFacts } from '../../plugin-sync.ts'
import type { ChamberHostPackageSeed, ExecFn } from '../../plugin-sync.ts'
import { chamberPackageOf, chamberFacts, chamberProjection, chamberStateOf } from '../support/chamber-projection.ts'
import { chamberFact, err, expectedChamberFacts, ok, okBytes, SEED_SPEC, tempDir } from './plugin-sync-fixtures.ts'

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

// ============================================================================
// part 1b — remote read face, renderer boundaries and the seed fail-closed
// matrix. Round-2 trim: the sibling suites plugin-sync-remote-read.test.ts,
// plugin-sync-renderer-projection.test.ts and plugin-sync-seed.test.ts were
// deleted as per-module duplicates; their security / boundary / fail-closed
// assertions are carried over here (net line reduction positive).
// ============================================================================

test('remotePluginList: ENOENT is an absent profile; any other ssh failure is loud', async () => {
  const enoent: ExecFn = async () => err('cat: /home/u/.dsh/profiles/web/package.json: No such file or directory')
  const absent = await remotePluginList(enoent, SEED_SPEC)
  assert.equal(absent.ok, true)
  if (absent.ok) {
    assert.equal(absent.manifest.profileExists, false)
    assert.deepEqual(chamberFacts(absent.manifest.chamber), expectedChamberFacts())
  }
  const sshDown: ExecFn = async () => err('the ssh exec could not reach the host (exit 255)')
  assert.deepEqual(await remotePluginList(sshDown, SEED_SPEC), {
    ok: false, error: 'the ssh exec could not reach the host (exit 255)',
  })
})

test('remotePluginList: a chamber probe ssh failure is loud on both probe files, never a silent "not injected"', async () => {
  const probeFails = (face: 'package.json' | 'dist/index.js'): ExecFn => async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.endsWith('/cordis.patch.yml')) return ok('# comment' + String.fromCharCode(10) + '[]')
      if (face === 'package.json' && path.includes(CLIENT_GRAPH_PACKAGE_NAME + '/package.json')) {
        return err('the ssh exec could not reach the host (exit 255)')
      }
      if (face === 'dist/index.js' && path.includes(CLIENT_GRAPH_PACKAGE_NAME + '/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-chamber-seed-client-graph"}')
      }
      if (face === 'dist/index.js' && path.includes(CLIENT_GRAPH_PACKAGE_NAME + '/dist/index.js')) {
        return err('the ssh exec could not reach the host (exit 255)')
      }
      if (path.includes(GIT_WORKTREE_PACKAGE_NAME + '/dist/index.js')) return ok('export const git = 1')
      if (path.includes(GIT_WORKTREE_PACKAGE_NAME + '/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
    }
    return err('unexpected cat ' + String(payload?.argv?.[0]))
  }
  for (const face of ['package.json', 'dist/index.js'] as const) {
    const result = await remotePluginList(probeFails(face), SEED_SPEC)
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.manifest.chamber.ok, false, face)
      if (result.manifest.chamber.ok === false) assert.match(result.manifest.chamber.error, /dsh-chamber-seed-client-graph probe failed/)
    }
  }
})

test('remotePluginList: a redacted .ssh-home ENOENT is a probe miss, never a loud probe error', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) {
        return err('run command failed (exit 1): cat: [ssh material redacted]: No such file or directory')
      }
      if (path.endsWith('/cordis.patch.yml') || path.includes('@dsh-chamber/dsh-chamber-seed-')) {
        return err('run command failed (exit 1): [ssh material redacted]: No such file or directory')
      }
    }
    return err('unexpected cat ' + String(payload?.argv?.[0]))
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: '/root/.ssh-custom' })
  assert.ok(result.ok, 'a redacted ENOENT is a probe miss, not a loud probe failure')
  if (result.ok) {
    assert.equal(result.manifest.profileExists, false)
    assert.deepEqual(chamberFacts(result.manifest.chamber), expectedChamberFacts())
  }
})

test('remotePluginList: protected means name in P, and the write face refuses the official install (design 21 §6.11.5)', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) {
        return ok(JSON.stringify({
          dependencies: { 'third-party-pkg': '^1.0.0', '@deepseek-ai/dsh-experimental-x': '0.1.5-rc.2', '@deepseek-ai/dsh-session': '^0.1.5-rc.2' },
          dsh: { profile: { bundles: ['third-party-pkg'] } },
        }))
      }
      return err('run command failed (exit 1): cat: ' + path + ': No such file or directory')
    }
    return err('unexpected ' + action)
  }
  const result = await remotePluginList(exec, SEED_SPEC)
  assert.ok(result.ok)
  if (!result.ok) return
  const byName = new Map(result.manifest.rows.map(row => [row.name, row]))
  assert.equal(byName.get('third-party-pkg')?.protected, false)
  assert.equal(byName.get('@deepseek-ai/dsh-experimental-x')?.protected, false, 'the read face never lies about removability')
  const install = guardPluginMutation({ op: 'install', name: '@deepseek-ai/dsh-experimental-x', version: '0.1.5-rc.2', facts: sshProtectionFacts() })
  assert.equal(install.kind, 'refuse')
  assert.equal(install.kind === 'refuse' ? install.code : null, 'protected')
  const remove = guardPluginMutation({ op: 'remove', name: '@deepseek-ai/dsh-experimental-x', version: null, facts: sshProtectionFacts() })
  assert.equal(remove.kind, 'allow', 'removing a stray official copy is restorative')
})

test('isAllowedLocalFileSpec: absolute POSIX/Windows/UNC only — relative and control-char input refused', () => {
  assert.equal(isAllowedLocalFileSpec('file:/Users/x/plugin'), true)
  assert.equal(isAllowedLocalFileSpec('file:C:\\Users\\x\\plugin'), true)
  assert.equal(isAllowedLocalFileSpec('file:\\\\server\\share\\plugin'), true)
  for (const bad of ['file:../relative', 'file:./relative', 'file:', 'file:/tmp/x' + String.fromCharCode(10) + 'rm -rf', 'plain-registry-spec']) {
    assert.equal(isAllowedLocalFileSpec(bad), false, bad)
  }
})

test('runLocalDshPlugin: protected / generation-mismatch / file-pick gates refuse before any CLI lookup', async () => {
  const dir = tempDir()
  const protection = { familyNames: ['@deepseek-ai/dsh-base'], runtimeVersion: '0.1.5-rc.2' }
  const refused = await runLocalDshPlugin(dir, dir, 'remove', '@deepseek-ai/dsh-base', { protection })
  assert.equal(refused.ok, false)
  assert.match(refused.error ?? '', /\[protected\]/)
  const crossGen = await runLocalDshPlugin(dir, dir, 'add', '@deepseek-ai/dsh-experimental-x@0.1.4', { protection })
  assert.equal(crossGen.ok, false)
  assert.match(crossGen.error ?? '', /\[generation-mismatch\]/)
  const noFlag = await runLocalDshPlugin(dir, dir, 'add', 'file:/tmp/picked-folder')
  assert.equal(noFlag.ok, false)
  assert.match(noFlag.error ?? '', /invalid add spec/)
  const gated = await runLocalDshPlugin(dir, dir, 'add', 'file:/tmp/picked-folder', { allowFileSpec: true })
  assert.equal(gated.ok, false)
  assert.match(gated.error ?? '', /no dsh CLI entry found/)
})

test('redactLocalPluginManifest / redactRemotePluginManifest: local paths are masked on every channel, registry values untouched', () => {
  const local = redactLocalPluginManifest({
    dependencies: { 'file-dep': 'file:/Users/x/pkg', 'link-dep': 'link:../pkg', 'registry-dep': '^1.2.3', 'url-dep': 'https://example.com/pkg.tgz' },
    bundles: ['file-dep'],
    rows: [{ name: 'file-dep', spec: 'file:/Users/x/pkg', version: null, role: 'materialized', protected: false, owner: 'user' }],
    clientLines: ['link-dep'], bundleLines: ['file-dep'], unsyncable: [],
    chamber: chamberProjection({ [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: true, version: '1.0.0' } }),
  } as never)
  assert.equal(local.dependencies['file-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(local.dependencies['link-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(local.dependencies['registry-dep'], '^1.2.3')
  assert.equal(local.dependencies['url-dep'], 'https://example.com/pkg.tgz')
  assert.equal(local.rows.find(row => row.name === 'file-dep')?.spec, MATERIALIZED_VALUE_MASK, 'rows[].spec is a second channel for the same value')
  assert.equal(classifyDependencyValue(MATERIALIZED_VALUE_MASK).kind, 'materialize', 'the mask keeps the client isPathSpec parity')
  const remote = redactRemotePluginManifest({
    dependencies: { 'file-dep': 'file:/root/x.tgz', 'uppercase-file': 'FILE:/root/x', 'link-dep': 'link:/root/x', 'registry-dep': '^1.2.3' },
    bundles: ['file-dep'], profileExists: true,
    chamber: chamberProjection({ [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: true } }),
  } as never)
  assert.equal(remote.dependencies['file-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(remote.dependencies['uppercase-file'], MATERIALIZED_VALUE_MASK)
  assert.equal(remote.dependencies['link-dep'], 'link:/root/x', 'link: cannot reach a profile and stays untouched')
  assert.equal(remote.dependencies['registry-dep'], '^1.2.3')
  assert.equal(classifyDependencyValue(remote.dependencies['file-dep']).kind, 'materialize')
})

test('shouldPreferPinnedRuntimeLockfile: only an active runtime equal to the built-in line may use the pin', () => {
  assert.equal(shouldPreferPinnedRuntimeLockfile('0.1.5-rc.2', '0.1.5-rc.2'), true)
  assert.equal(shouldPreferPinnedRuntimeLockfile('0.1.5-rc.3', '0.1.5-rc.2'), false, 'another runtime line uses its own lockfile')
  assert.equal(shouldPreferPinnedRuntimeLockfile(null, '0.1.5-rc.2'), false, 'an unreadable active generation must not guess')
  assert.equal(shouldPreferPinnedRuntimeLockfile('0.1.5-rc.2', null), false, 'an unreadable pinned generation must not guess')
  assert.equal(shouldPreferPinnedRuntimeLockfile(null, null), false)
})

const GRAPH_INSERTS = [{ insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME }]

test('seed: a non-list patch or an uninitialized profile fails loud, never a rewrite', () => {
  const mapping = computeCordisPatchUpdate('system-prompt:\n  persona: hi\n', GRAPH_INSERTS)
  assert.ok('error' in mapping)
  if ('error' in mapping) assert.match(mapping.error, /not a top-level YAML array/)
  const missing = computeCordisPatchUpdate(null, GRAPH_INSERTS)
  assert.ok('error' in missing)
  if ('error' in missing) assert.match(missing.error, /not initialized/)
})

test('seed: crossed / duplicate / mismatched chamber loader rows fail loud before a boot-breaking append', () => {
  const gitInserts = [{ insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME }]
  const cases = [
    "- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n",
    "- insert:\n    - id: git-worktree\n      name: '@example/not-chamber'\n",
    "- insert:\n    - id: user-git-row\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n",
    "- insert:\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n",
    "- insert:\n    - id: git-worktree\n      name: '@example/not-chamber'\n    - name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n      id: another-git-service\n",
    "- insert:\n    - id: git-worktree\n      name: '@example/not-chamber'\n      config:\n        name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n",
    "- insert: [{ id: git-worktree, name: '@example/not-chamber' }, { id: other, name: '@dsh-chamber/dsh-chamber-seed-git-worktree' }]\n",
  ]
  for (const content of cases) {
    const update = computeCordisPatchUpdate(content, gitInserts)
    assert.ok('error' in update, content)
    if ('error' in update) assert.match(update.error, /already bound|already mounted|duplicate chamber loader identity/)
  }
})

function seedExec(overrides: {
  patch?: string | null
  failWrite?: (path: string) => string | null
  failSeedCat?: (path: string) => string | null
} = {}) {
  const calls: string[] = []
  const written: Array<{ path: string; bytes: Buffer }> = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0]
      calls.push('cat:' + String(path))
      if (path !== undefined && path.startsWith('~/.dsh/profiles/node_modules/@dsh-chamber/')) {
        const failure = overrides.failSeedCat?.(path)
        if (failure !== undefined && failure !== null) return err(failure)
        return err('run command failed (exit 1): cat: ' + path + ': No such file or directory')
      }
      if (path === '~/.dsh/profiles/web/cordis.patch.yml') {
        if (overrides.patch === null) return err('run command failed (exit 1): cat: ' + path + ': No such file or directory')
        return ok(overrides.patch)
      }
      return err('run command failed (exit 1): cat: no such file')
    }
    if (action === 'run' && payload?.op === 'write-file') {
      const path = payload.path ?? '?'
      calls.push('write:' + path)
      const failure = overrides.failWrite?.(path)
      if (failure !== undefined && failure !== null) return err(failure)
      written.push({ path, bytes: Buffer.from(payload.contentBase64 ?? '', 'base64') })
      return okBytes(Buffer.from(payload.contentBase64 ?? '', 'base64'))
    }
    calls.push('other:' + action)
    return ok()
  }
  return { exec, calls, written }
}

/** A module A source dir; pkgJson: null omits package.json (the preflight-negative shape). */
function moduleASource(pkgJson: string | null = '{"name":"x"}', distJs: string | null = 'export const graph = 1'): string {
  const dir = join(tempDir(), 'module-a')
  mkdirSync(join(dir, 'dist'), { recursive: true })
  if (pkgJson !== null) writeFileSync(join(dir, 'package.json'), pkgJson)
  if (distJs !== null) writeFileSync(join(dir, 'dist', 'index.js'), distJs)
  return dir
}

const singleGraphSeed = (sourceDir: string): ChamberHostPackageSeed[] =>
  [{ insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME, sourceDir, label: 'host-graph' }]

test('seedRemoteChamberHostPackages: preflight / read / write failures all stop before the patch write', async () => {
  const preflight = seedExec({ patch: '[]\n' })
  const brokenResult = await seedRemoteChamberHostPackages(preflight.exec, SEED_SPEC, singleGraphSeed(moduleASource(null)))
  assert.equal(brokenResult.ok, false)
  if (!brokenResult.ok) assert.match(brokenResult.error, /package\.json missing/)
  assert.deepEqual(preflight.calls, [], 'a broken source is refused before any remote call')
  const readFails = seedExec({
    patch: '[]\n',
    failSeedCat: path => (path.endsWith('/package.json') ? 'the ssh exec could not reach the host (exit 255)' : null),
  })
  const readResult = await seedRemoteChamberHostPackages(readFails.exec, SEED_SPEC, singleGraphSeed(moduleASource()))
  assert.equal(readResult.ok, false)
  if (!readResult.ok) assert.match(readResult.error, /host-graph seed read package\.json failed/)
  assert.equal(readFails.written.length, 0, 'no write is attempted after a non-ENOENT read-back failure')
  const writeFails = seedExec({
    patch: '[]\n',
    failWrite: path => (path.includes('dist/index.js') ? 'write-file target not allowed' : null),
  })
  const writeResult = await seedRemoteChamberHostPackages(writeFails.exec, SEED_SPEC, singleGraphSeed(moduleASource()))
  assert.equal(writeResult.ok, false)
  if (!writeResult.ok) assert.match(writeResult.error, /write-file failed for dist\/index\.js/)
  assert.ok(!writeFails.written.some(entry => entry.path === '~/.dsh/profiles/web/cordis.patch.yml'), 'no patch without the package files')
})
