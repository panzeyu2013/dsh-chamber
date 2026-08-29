/**
 * Remote plugin sync orchestration (design 13 M2+M3) unit tests.
 *
 * Pure-Node tests (no electron, no real SSH host): localPluginList
 * classification (bundle/client/plain/materialize/unsyncable + path-traversal
 * defense), remotePluginList (parse / ENOENT → profileExists:false / ssh
 * failure), applyPlugins (whitelist re-validation rejection, remove-before-add
 * ordering, single-flight), and the cordis.patch.yml seed merge (dedup /
 * deterministic template rewrite / append-without-clobber / non-list
 * fail-loud).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyPlugins,
  classifyDependencyValue,
  classifyLocalDependency,
  classifySpec,
  CLIENT_GRAPH_INSERT_ID,
  CLIENT_GRAPH_PACKAGE_NAME,
  computeCordisPatchUpdate,
  describeLocalPluginAddConfirmation,
  describeLocalPluginRemoveConfirmation,
  describeMaterializeConfirmation,
  describePluginApplyConfirmation,
  describeSeedConfirmation,
  ExactOwnershipRegistry,
  GIT_WORKTREE_INSERT_ID,
  GIT_WORKTREE_PACKAGE_NAME,
  localPluginList,
  localPluginWriterLedgerPath,
  MATERIALIZED_VALUE_MASK,
  materializeAbsolutePath,
  materializeAndAdd,
  materializePluginsDir,
  packageNameFromSpec,
  redactLocalPluginManifest,
  remotePluginList,
  ReadyPhaseEdges,
  reapStaleLocalPluginWriters,
  resolveLocalMaterializeDirectory,
  resetApplyInFlight,
  scopeExecToOwnership,
  runWithFinalOwnership,
  seedRemoteChamberHostPackages,
  seedRemoteHostGraph,
  PLUGIN_SPEC_PATTERN,
  PLUGIN_NAME_PATTERN,
} from './plugin-sync.ts'
import type { ChamberHostPackageSeed, ExecFn, ExecResult, StatusFn, RemoteSpec } from './plugin-sync.ts'
import type { TransportRunPayload } from './transport-provider.ts'
import { NotificationSourceIncarnations } from './notifications.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-'))
}

function ok(stdout?: string): ExecResult {
  return { ok: true, status: { phase: 'ready' }, stdout }
}

/** A `cat` read-back carrying the RAW bytes (byte-domain consumers). */
function okBytes(bytes: Buffer): ExecResult {
  return { ok: true, status: { phase: 'ready' }, stdout: bytes.toString('utf8'), stdoutBytes: bytes }
}

function err(error: string): ExecResult {
  return { ok: false, error }
}

const readyStatus: StatusFn = () => ({ phase: 'ready' })

test('exact ownership lets a changed incarnation supersede and stale finally cannot clear it', () => {
  const owners = new ExactOwnershipRegistry()
  const first = owners.begin('same', 'host-a')
  assert.equal(first.accepted, true)
  const duplicate = owners.begin('same', 'host-a')
  assert.equal(duplicate.accepted, false, 'same incarnation remains single-flight')
  const replacement = owners.begin('same', 'host-b')
  assert.equal(replacement.accepted, true, 'changed incarnation starts immediately')
  assert.equal(owners.owns(first.token), false)
  assert.equal(owners.finish(first.token), false, 'old finally cannot delete new ownership')
  assert.equal(owners.owns(replacement.token), true)
  assert.equal(owners.finish(replacement.token), true)

  const removed = owners.begin('same', 'host-b')
  assert.equal(removed.accepted, true)
  assert.equal(owners.revoke('same'), true)
  assert.equal(owners.owns(removed.token), false)
  assert.equal(owners.begin('same', 'host-b').accepted, true, 'remove/re-add gets fresh ownership even with same fingerprint')
})

test('scoped exec checks exact ownership before and after every remote step', async () => {
  let owner = true
  let calls = 0
  let settle!: (result: ReturnType<typeof ok>) => void
  const underlying: ExecFn = async () => {
    calls += 1
    return await new Promise(resolve => { settle = resolve })
  }
  const scoped = scopeExecToOwnership(underlying, 'same', () => owner)
  const inFlight = scoped('same', 'run', { op: 'exec', command: 'cat', argv: ['/tmp/x'] })
  owner = false
  settle(ok())
  assert.deepEqual(await inFlight, { ok: false, error: 'ssh instance changed while operation was in progress' })
  assert.deepEqual(await scoped('same', 'restart'), { ok: false, error: 'ssh instance changed while operation was in progress' })
  assert.deepEqual(await scoped('other', 'restart'), { ok: false, error: 'ssh instance changed while operation was in progress' })
  assert.equal(calls, 1, 'stale ownership never starts another saga step')
})

test('remote saga ownership cannot revive after byte-identical same-id re-add', async () => {
  const sources = new NotificationSourceIncarnations()
  const sourceId = 'ssh-same'
  const fingerprint = 'a'.repeat(64)
  sources.replaceRemoteSources([{ sourceId, fingerprint }])
  const sourceToken = sources.capture(sourceId)!
  const operationalFingerprint = 'same-operational-fields'
  let currentOperationalFingerprint = operationalFingerprint
  const owns = (): boolean =>
    sources.owns(sourceToken) && currentOperationalFingerprint === operationalFingerprint

  let calls = 0
  let settle!: (result: ExecResult) => void
  const scoped = scopeExecToOwnership(async () => {
    calls += 1
    return await new Promise<ExecResult>(resolve => { settle = resolve })
  }, 'same', owns)
  const firstStep = scoped('same', 'run', { op: 'exec', command: 'cat', argv: ['first'] })

  sources.replaceRemoteSources([])
  sources.replaceRemoteSources([{ sourceId, fingerprint }])
  assert.equal(currentOperationalFingerprint, operationalFingerprint)
  assert.equal(owns(), false, 'reusable fields do not restore exact lifecycle ownership')
  settle(ok())
  assert.deepEqual(await firstStep, { ok: false, error: 'ssh instance changed while operation was in progress' })
  assert.deepEqual(
    await scoped('same', 'run', { op: 'exec', command: 'cat', argv: ['second'] }),
    { ok: false, error: 'ssh instance changed while operation was in progress' },
  )
  assert.equal(calls, 1, 'a later saga step never runs on the replacement host')
})

test('final ownership fence rejects a deferred completion after same-id replacement', async () => {
  let owner = true
  let settle!: (value: { ok: true; manifest: string }) => void
  const pending = runWithFinalOwnership(
    () => owner,
    () => new Promise(resolve => { settle = resolve }),
  )
  owner = false
  settle({ ok: true, manifest: 'old-host' })
  assert.deepEqual(await pending, { ok: false, error: 'ssh instance changed while operation was in progress' })
})

test('ready edge tracker fires only non-ready to ready and forgets removed ids', () => {
  const edges = new ReadyPhaseEdges()
  assert.equal(edges.observe('same', 'connecting'), false)
  assert.equal(edges.observe('same', 'ready'), true)
  assert.equal(edges.observe('same', 'ready'), false, 'service/status projections while ready never reseed')
  assert.equal(edges.observe('same', 'degraded'), false)
  assert.equal(edges.observe('same', 'ready'), true)
  edges.forget('same')
  assert.equal(edges.activeCount, 0)
  assert.equal(edges.observe('same', 'ready'), true, 'same-id re-add has a fresh edge history')
})

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

test('localPluginList: chamber host-graph state — installed + patched', () => {
  // Nest the dsh home under a base dir so the `--patch` overlay (which lives
  // BESIDE the home: dirname(home)/dsh-chamber-graph.patch.yml) stays inside
  // the temp sandbox.
  const base = tempDir()
  const home = join(base, 'home')
  const profileDir = writeLocalProfile(home, {}, [])
  const moduleADir = join(profileDir, 'node_modules', CLIENT_GRAPH_PACKAGE_NAME)
  mkdirSync(join(moduleADir, 'dist'), { recursive: true })
  writeFileSync(join(moduleADir, 'package.json'), '{"name":"@dsh-chamber/dsh-host-client-graph"}')
  writeFileSync(join(moduleADir, 'dist', 'index.js'), 'export const graph = 1\n')
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), '- insert:\n    - id: client-graph\n')

  const manifest = localPluginList(home)
  assert.deepEqual(manifest.chamber, { ok: true, hostGraph: { installed: true, patched: true, version: null, live: null }, gitWorktree: { installed: false, patched: false, version: null, live: null } })
})

test('localPluginList: chamber host-graph state — absent = not injected (honest, never "done")', () => {
  const base = tempDir()
  const home = join(base, 'home')
  writeLocalProfile(home, {}, [])
  const manifest = localPluginList(home)
  assert.deepEqual(manifest.chamber, { ok: true, hostGraph: { installed: false, patched: false, version: null, live: null }, gitWorktree: { installed: false, patched: false, version: null, live: null } })
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
  writeFileSync(join(moduleADir, 'package.json'), '{"name":"@dsh-chamber/dsh-host-client-graph"}')
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), '- insert:\n    - id: client-graph\n')

  const manifest = localPluginList(home)
  assert.deepEqual(manifest.chamber, { ok: true, hostGraph: { installed: false, patched: true, version: null, live: null }, gitWorktree: { installed: false, patched: false, version: null, live: null } })
})

test('localPluginList: chamber host-graph version is read from the seeded module A manifest', () => {
  const base = tempDir()
  const home = join(base, 'home')
  const profileDir = writeLocalProfile(home, {}, [])
  const moduleADir = join(profileDir, 'node_modules', CLIENT_GRAPH_PACKAGE_NAME)
  mkdirSync(join(moduleADir, 'dist'), { recursive: true })
  writeFileSync(join(moduleADir, 'package.json'), '{"name":"@dsh-chamber/dsh-host-client-graph","version":"0.1.2"}')
  writeFileSync(join(moduleADir, 'dist', 'index.js'), 'export const graph = 1\n')
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), '- insert:\n    - id: client-graph\n')

  const manifest = localPluginList(home)
  assert.ok(manifest.chamber.ok)
  if (manifest.chamber.ok) {
    assert.equal(manifest.chamber.hostGraph.version, '0.1.2', 'the seeded package version is projected')
    assert.equal(manifest.chamber.hostGraph.live, null, 'local side has no separate liveness probe')
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
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), "- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n")
  const stale = localPluginList(home)
  assert.ok(stale.chamber.ok)
  if (stale.chamber.ok) {
    assert.deepEqual(stale.chamber.gitWorktree, { installed: true, patched: false, version: null, live: null })
  }
  // Regenerated overlay with BOTH rows → patched.
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), "- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-host-git-worktree'\n")
  const fresh = localPluginList(home)
  assert.ok(fresh.chamber.ok)
  if (fresh.chamber.ok) {
    assert.deepEqual(fresh.chamber.gitWorktree, { installed: true, patched: true, version: null, live: null })
  }
  // Absent overlay → not patched.
  writeFileSync(join(base, 'dsh-chamber-graph.patch.yml'), '')
  const none = localPluginList(home)
  assert.ok(none.chamber.ok)
  if (none.chamber.ok) {
    assert.equal(none.chamber.gitWorktree.patched, false)
  }
})

// ============================================================================
// remotePluginList
// ============================================================================

test('remotePluginList: parses dependencies + bundles from cat output', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) {
        return ok(JSON.stringify({ dependencies: { foo: '^1.0.0' }, dsh: { profile: { bundles: ['foo'] } } }))
      }
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) {
        return ok('export const graph = 1\n')
      }
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-host-client-graph"}')
      }
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/dist/index.js')) {
        return ok('export const git = 1\n')
      }
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-host-git-worktree"}')
      }
      if (path.endsWith('/cordis.patch.yml')) {
        // A fully-seeded machine: BOTH chamber boot rows present.
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-host-git-worktree'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.deepEqual(result, {
    ok: true,
    manifest: {
      dependencies: { foo: '^1.0.0' },
      bundles: ['foo'],
      profileExists: true,
      error: undefined,
      chamber: { ok: true, hostGraph: { installed: true, patched: true, version: null, live: null }, gitWorktree: { installed: true, patched: true, version: null, live: null } },
    },
  })
})

test('remotePluginList: ENOENT → profileExists:false, ssh failure → {ok:false}', async () => {
  const enoent: ExecFn = async () => err('cat: /home/u/.dsh/profiles/web/package.json: No such file or directory')
  assert.deepEqual(
    await remotePluginList(enoent, { id: 's1', remoteDshHome: null }),
    {
      ok: true,
      manifest: {
        dependencies: {},
        bundles: [],
        profileExists: false,
        chamber: { ok: true, hostGraph: { installed: false, patched: false, version: null, live: null }, gitWorktree: { installed: false, patched: false, version: null, live: null } },
      },
    },
  )
  const sshDown: ExecFn = async () => err('the ssh exec could not reach the host (exit 255)')
  assert.deepEqual(
    await remotePluginList(sshDown, { id: 's1', remoteDshHome: null }),
    { ok: false, error: 'the ssh exec could not reach the host (exit 255)' },
  )
})

test('remotePluginList: a zh_CN-locale remote ENOENT ("没有那个文件或目录") is a probe miss, never a loud failure', async () => {
  // Real-world case (2026-08 user report): the remote host runs coreutils in
  // the zh_CN locale, so an absent chamber package cats `没有那个文件或目录`
  // instead of `No such file or directory`. Before the locale-broadened
  // ENOENT_PATTERN this surfaced as "git-worktree probe failed: run command
  // failed (exit 1): cat: …: 没有那个文件或目录" instead of 未注入.
  const zhEnoent: ExecFn = async () => err('run command failed (exit 1): cat: /home/zeyu/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-git-worktree/package.json: 没有那个文件或目录')
  assert.deepEqual(
    await remotePluginList(zhEnoent, { id: 's1', remoteDshHome: null }),
    {
      ok: true,
      manifest: {
        dependencies: {},
        bundles: [],
        profileExists: false,
        chamber: { ok: true, hostGraph: { installed: false, patched: false, version: null, live: null }, gitWorktree: { installed: false, patched: false, version: null, live: null } },
      },
    },
  )
  // The ssh-provider's redaction re-attach path keeps the marker working for
  // a redacted zh_CN line too.
  const redactedZh: ExecFn = async () => err('run command failed (exit 1): [ssh material redacted]: 没有那个文件或目录')
  const redactedResult = await remotePluginList(redactedZh, { id: 's1', remoteDshHome: '/root/.ssh-custom' })
  assert.ok(redactedResult.ok, 'a redacted zh_CN ENOENT is a probe miss, not a loud probe failure')
  if (redactedResult.ok) {
    assert.equal(redactedResult.manifest.chamber.ok, true)
  }
})

test('remotePluginList: chamber probe — installed but the boot-layer insert missing (half-injected)', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph"}')
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-git-worktree"}')
      // initProfile template: comments + empty list → the seed would rewrite it.
      if (path.endsWith('/cordis.patch.yml')) return ok('# comment\n[]')
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.manifest.chamber, { ok: true, hostGraph: { installed: true, patched: false, version: null, live: null }, gitWorktree: { installed: true, patched: false, version: null, live: null } })
  }
})

test('remotePluginList: chamber probe ssh failure is loud, never a silent "not injected"', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) {
        return err('the ssh exec could not reach the host (exit 255)')
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.manifest.chamber.ok, false)
    assert.ok(result.manifest.chamber.ok === false && /host-graph probe failed/.test(result.manifest.chamber.error))
  }
})

test('remotePluginList: chamber probe — package.json present but dist/index.js missing = NOT installed (two-file definition)', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph"}')
            if (path.includes('@dsh-chamber/dsh-host-git-worktree/dist/index.js')) return ok('export const git = 1\n')
            if (path.includes('@dsh-chamber/dsh-host-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-git-worktree"}')
      // dist/index.js genuinely missing: a package.json alone is a
      // half-installed module A (the boot row could not resolve).
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/dist/index.js')) {
        return ok('export const git = 1\n')
      }
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-host-git-worktree"}')
      }
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) {
        return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      }
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.manifest.chamber, { ok: true, hostGraph: { installed: false, patched: true, version: null, live: null }, gitWorktree: { installed: true, patched: false, version: null, live: null } })
  }
})

test('remotePluginList: chamber probe ssh failure on dist/index.js is loud, never a silent "not injected"', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph"}')
            if (path.includes('@dsh-chamber/dsh-host-git-worktree/dist/index.js')) return ok('export const git = 1\n')
            if (path.includes('@dsh-chamber/dsh-host-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-git-worktree"}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) {
        return err('the ssh exec could not reach the host (exit 255)')
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.manifest.chamber.ok, false)
    assert.ok(result.manifest.chamber.ok === false && /host-graph probe failed/.test(result.manifest.chamber.error))
  }
})

test('remotePluginList: a `.ssh`-named home whose probe cat ENOENTs under redaction still classifies as absent (never a loud probe error)', async () => {
  // The ssh provider replaces a `.ssh*`-home ENOENT line with the redacted
  // summary and re-attaches the marker — the error text a fixed provider
  // yields for e.g. remoteDshHome=/root/.ssh-custom. The orchestration must
  // still read "file absent" (installed:false), not a loud probe failure, so
  // the UI shows 未注入 instead of an error.
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) {
        return err('run command failed (exit 1): cat: [ssh material redacted]: No such file or directory')
      }
      if (path.includes('@dsh-chamber/dsh-host-client-graph')) {
        return err('run command failed (exit 1): [ssh material redacted]: No such file or directory')
      }
      if (path.includes('@dsh-chamber/dsh-host-git-worktree')) {
        return err('run command failed (exit 1): [ssh material redacted]: No such file or directory')
      }
      if (path.endsWith('/cordis.patch.yml')) {
        return err('run command failed (exit 1): [ssh material redacted]: No such file or directory')
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: '/root/.ssh-custom' })
  assert.ok(result.ok, 'a redacted ENOENT is a probe miss, not a loud probe failure')
  if (result.ok) {
    assert.equal(result.manifest.profileExists, false)
    assert.deepEqual(result.manifest.chamber, { ok: true, hostGraph: { installed: false, patched: false, version: null, live: null }, gitWorktree: { installed: false, patched: false, version: null, live: null } })
  }
})

test('remotePluginList: chamber probe parses module A version and reports live-effect via liveProbe', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-git-worktree"}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-host-client-graph","version":"0.1.2"}')
      }
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-host-git-worktree'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const fullySeeded = { installed: true, patched: true, version: null, live: null }
  // live = true → the RUNNING instance has loaded the module (已生效).
  const live = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, { liveProbe: async () => true })
  assert.ok(live.ok)
  if (live.ok) {
    assert.deepEqual(live.manifest.chamber, { ok: true, hostGraph: { installed: true, patched: true, version: '0.1.2', live: true }, gitWorktree: fullySeeded })
  }
  // live = false → injected but restart still pending (重启后生效).
  const pending = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, { liveProbe: async () => false })
  assert.ok(pending.ok)
  if (pending.ok) {
    assert.deepEqual(pending.manifest.chamber, { ok: true, hostGraph: { installed: true, patched: true, version: '0.1.2', live: false }, gitWorktree: fullySeeded })
  }
  // live = null → the desktop could not classify (no ready tunnel): the UI
  // renders 生效状态未知 — never a guessed claim.
  const unknown = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, { liveProbe: async () => null })
  assert.ok(unknown.ok)
  if (unknown.ok) {
    assert.deepEqual(unknown.manifest.chamber, { ok: true, hostGraph: { installed: true, patched: true, version: '0.1.2', live: null }, gitWorktree: fullySeeded })
  }
  // A version-less seeded package.json → version:null (never a guessed one).
  const versionless: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph"}')
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-git-worktree"}')
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-host-git-worktree'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const noVersion = await remotePluginList(versionless, { id: 's1', remoteDshHome: null }, { liveProbe: async () => true })
  assert.ok(noVersion.ok)
  if (noVersion.ok) {
    assert.equal(noVersion.manifest.chamber.ok, true)
    if (noVersion.manifest.chamber.ok) assert.equal(noVersion.manifest.chamber.hostGraph.version, null)
  }
})

test('remotePluginList: git-worktree live is probed SEPARATELY — host-graph live does not prove the git row loaded', async () => {
  // The user-reported dead end: host-graph live from an older boot (its row
  // loaded) while the git-worktree row was seeded LATER (files + insert
  // written at ready, but the running instance still boots the old layer) —
  // the git RPC 404s and the sidebar shows no git surface. The probe must
  // report gitWorktree.live === false independently of hostGraph.live.
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph"}')
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-git-worktree"}')
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-host-git-worktree'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  // host-graph live, git-worktree NOT live → the exact "已生效 + 重启后生效"
  // pair the UI must be able to render (and gate its restart button on).
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, {
    liveProbe: async () => true,
    gitWorktreeLiveProbe: async () => false,
  })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.manifest.chamber, { ok: true, hostGraph: { installed: true, patched: true, version: null, live: true }, gitWorktree: { installed: true, patched: true, version: null, live: false } })
  }
  // Both live → 已生效 for both.
  const bothLive = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, {
    liveProbe: async () => true,
    gitWorktreeLiveProbe: async () => true,
  })
  assert.ok(bothLive.ok)
  if (bothLive.ok) {
    assert.equal(bothLive.manifest.chamber.ok, true)
    if (bothLive.manifest.chamber.ok) assert.equal(bothLive.manifest.chamber.gitWorktree.live, true)
  }
})

test('remotePluginList: the git-worktree INSERT missing from the patch is its own half-injected state (files present, row absent)', async () => {
  // A machine seeded before the git package existed: package files present,
  // but cordis.patch.yml carries ONLY the client-graph row. The host-graph
  // row is genuinely patched; the git-worktree row is NOT — the UI must
  // offer 注入 (not claim 已注入) and never report gitWorktree.live.
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph"}')
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-git-worktree"}')
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, {
    liveProbe: async () => true,
    gitWorktreeLiveProbe: async () => { throw new Error('must not run: the git row is not patched, so it cannot be live') },
  })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.manifest.chamber, { ok: true, hostGraph: { installed: true, patched: true, version: null, live: true }, gitWorktree: { installed: true, patched: false, version: null, live: null } })
  }
})

test('remotePluginList: liveProbe is NOT consulted when the injection is half-present (cannot be live by definition)', async () => {
  let probed = false
  let gitProbed = false
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph","version":"0.1.2"}')
      // dist/index.js missing → installed:false.
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/dist/index.js')) {
        return ok('export const git = 1\n')
      }
      if (path.includes('@dsh-chamber/dsh-host-git-worktree/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-host-git-worktree"}')
      }
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) {
        return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      }
      if (path.endsWith('/cordis.patch.yml')) {
        // The git-worktree boot row is ALSO absent (a stale patch from before
        // the git package existed): both packages are half-present, so neither
        // live probe may run.
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, {
    liveProbe: async () => { probed = true; return true },
    gitWorktreeLiveProbe: async () => { gitProbed = true; return true },
  })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.manifest.chamber, { ok: true, hostGraph: { installed: false, patched: true, version: '0.1.2', live: null }, gitWorktree: { installed: true, patched: false, version: null, live: null } })
  }
  assert.equal(probed, false, 'a half-injected module is never "live" — the probe is skipped')
  assert.equal(gitProbed, false, 'the git probe is skipped while the module is half-present')
})

// ============================================================================
// applyPlugins
// ============================================================================

test('applyPlugins: re-validates add/remove against the whitelist (untrusted renderer)', async () => {
  const noop: ExecFn = async () => ok()
  const spec: RemoteSpec = { id: 's1', remoteDshHome: null }
  assert.deepEqual(
    await applyPlugins(noop, readyStatus, spec, { add: ['file:/tmp/x.tgz'], remove: [] }),
    { ok: false, error: 'invalid add spec: "file:/tmp/x.tgz"' },
  )
  assert.deepEqual(
    await applyPlugins(noop, readyStatus, spec, { add: ['foo; rm -rf /'], remove: [] }),
    { ok: false, error: 'invalid add spec: "foo; rm -rf /"' },
  )
  assert.deepEqual(
    await applyPlugins(noop, readyStatus, spec, { add: [], remove: ['../evil'] }),
    { ok: false, error: 'invalid remove name: "../evil"' },
  )
})

test('applyPlugins: remove runs before add, serial, per-item isolation, restart + verify', async () => {
  const order: string[] = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      const verb = payload.argv?.[0] === 'plugin' ? payload.argv[3] : '?'
      order.push(`${verb}:${payload.argv?.[4]}`)
      return ok()
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      // verification read-back: `new-pkg` present, `old-pkg` absent
      return ok(JSON.stringify({ dependencies: { 'new-pkg': '^1.0.0' }, dsh: { profile: { bundles: [] } } }))
    }
    if (action === 'restart') return ok()
    return err(`unexpected ${action}`)
  }
  const result = await applyPlugins(exec, readyStatus, { id: 's1', remoteDshHome: null }, {
    add: ['new-pkg@^1.0.0'],
    remove: ['old-pkg'],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.applied, 2)
    assert.equal(result.result.restarted, true)
    assert.equal(result.result.deferred, false)
    assert.equal(result.result.verified, true)
    assert.equal(result.result.ready, true)
    assert.deepEqual(result.result.failed, [])
  }
  assert.deepEqual(order, ['remove:old-pkg', 'add:new-pkg@^1.0.0'])
})

test('applyPlugins: restart===false defers and skips the ready recheck', async () => {
  const actions: string[] = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') { actions.push('dsh'); return ok() }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      return ok(JSON.stringify({ dependencies: { pkg: '^1.0.0' }, dsh: { profile: { bundles: [] } } }))
    }
    actions.push(action)
    return ok()
  }
  const result = await applyPlugins(exec, readyStatus, { id: 's1', remoteDshHome: null }, { add: ['pkg@^1.0.0'], remove: [], restart: false })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.deferred, true)
    assert.equal(result.result.restarted, false)
    assert.equal(result.result.ready, null)
  }
  assert.ok(!actions.includes('restart'))
})

test('applyPlugins: single-flight refuses a concurrent apply for the same instance', async () => {
  resetApplyInFlight()
  const pending: Array<(r: ExecResult) => void> = []
  let auto = false
  const exec: ExecFn = () => {
    if (auto) return Promise.resolve(ok())
    return new Promise(resolve => { pending.push(resolve) })
  }
  const spec: RemoteSpec = { id: 's1', remoteDshHome: null }
  const first = applyPlugins(exec, readyStatus, spec, { add: ['x@1.0.0'], remove: [] })
  const second = await applyPlugins(exec, readyStatus, spec, { add: ['y@1.0.0'], remove: [] })
  assert.deepEqual(second, { ok: false, error: 'apply in progress' })
  auto = true
  for (const resolve of pending) resolve(ok())
  await first
  resetApplyInFlight()
})

test('applyPlugins: a changed operational owner is not blocked by the reusable id', async () => {
  resetApplyInFlight()
  const pending: Array<(r: ExecResult) => void> = []
  let auto = false
  const exec: ExecFn = () => auto
    ? Promise.resolve(ok('{}'))
    : new Promise(resolve => { pending.push(resolve) })
  const spec: RemoteSpec = { id: 'same', remoteDshHome: null }
  const oldApply = applyPlugins(exec, readyStatus, spec, { add: ['old@1.0.0'], remove: [] }, { ownershipKey: 'host-a' })
  const newApply = applyPlugins(exec, readyStatus, spec, { add: ['new@1.0.0'], remove: [] }, { ownershipKey: 'host-b' })
  await Promise.resolve()
  assert.equal(pending.length, 2, 'replacement owner starts immediately')
  assert.deepEqual(
    await applyPlugins(exec, readyStatus, spec, { add: ['duplicate@1.0.0'], remove: [] }, { ownershipKey: 'host-b' }),
    { ok: false, error: 'apply in progress' },
  )
  auto = true
  for (const resolve of pending) resolve(ok())
  await Promise.all([oldApply, newApply])
  resetApplyInFlight()
})

// ============================================================================
// computeCordisPatchUpdate (seed cordis.patch.yml)
// ============================================================================

const TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

test('seed: initProfile template is deterministically rewritten with the insert', () => {
  const update = computeCordisPatchUpdate(TEMPLATE)
  assert.equal('error' in update, false)
  if ('error' in update) return
  assert.equal(update.write, true)
  if (!update.write) return
  assert.ok(update.content.includes('- insert:'))
  assert.ok(update.content.includes("name: '@dsh-chamber/dsh-host-client-graph'"))
  assert.ok(!update.content.includes('[]'), 'empty list marker is replaced')
  // comments preserved
  assert.ok(update.content.includes('Your patch layer'))
})

test('seed: an existing insert is deduped (no write)', () => {
  const already = TEMPLATE.replace('[]', `[\n  - insert: { id: client-graph, name: '@dsh-chamber/dsh-host-client-graph' }\n]`)
  assert.deepEqual(computeCordisPatchUpdate(already), { write: false })
})

test('seed: a user block list is appended to, never clobbered', () => {
  const userList = `- id: system-prompt\n  config:\n    persona: hi\n`
  const update = computeCordisPatchUpdate(userList)
  assert.equal('error' in update, false)
  if ('error' in update) return
  assert.equal(update.write, true)
  if (!update.write) return
  assert.ok(update.content.startsWith('- id: system-prompt'), 'user rows preserved')
  assert.ok(update.content.includes('- insert:'))
  assert.ok(update.content.includes("name: '@dsh-chamber/dsh-host-client-graph'"))
})

test('seed: a non-list file fails loud', () => {
  const mapping = 'system-prompt:\n  persona: hi\n'
  const update = computeCordisPatchUpdate(mapping)
  assert.ok('error' in update)
  if ('error' in update) assert.match(update.error, /not a top-level YAML array/)
})

test('seed: a missing cordis.patch.yml (uninitialized profile) fails loud', () => {
  const update = computeCordisPatchUpdate(null)
  assert.ok('error' in update)
  if ('error' in update) assert.match(update.error, /not initialized/)
})

test('seed: a similar-but-different entry does NOT dedup (client-graph-foo id is not the client-graph entry)', () => {
  // The OLD substring dedup matched `id: client-graph` inside
  // `id: client-graph-foo` and wrongly skipped the insert; the line-level
  // boundary check must not.
  const similar = `- id: client-graph-foo
  config:
    x: 1
`
  const update = computeCordisPatchUpdate(similar)
  assert.equal('error' in update, false)
  if ('error' in update) return
  assert.equal(update.write, true, 'a client-graph-foo id must not count as the client-graph entry')
})

test('seed: two chamber host rows merge together and only a missing row is appended', () => {
  const inserts = [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME },
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ]
  const first = computeCordisPatchUpdate(TEMPLATE, inserts)
  assert.equal('error' in first, false)
  if ('error' in first || !first.write) return
  assert.ok(first.content.includes('id: client-graph'))
  assert.ok(first.content.includes('id: git-worktree'))
  assert.deepEqual(computeCordisPatchUpdate(first.content, inserts), { write: false })

  const graphSeed = computeCordisPatchUpdate(TEMPLATE, [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME },
  ])
  assert.equal('error' in graphSeed, false)
  if ('error' in graphSeed || !graphSeed.write) return
  const graphOnly = graphSeed.content
  const second = computeCordisPatchUpdate(graphOnly, inserts)
  assert.equal('error' in second, false)
  if ('error' in second || !second.write) return
  assert.equal((second.content.match(/id: client-graph/g) ?? []).length, 1)
  assert.equal((second.content.match(/id: git-worktree/g) ?? []).length, 1)
})

test('seed: crossed id/name rows fail loud before appending a boot-breaking duplicate', () => {
  const crossed = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-host-git-worktree'
    - id: git-worktree
      name: '@dsh-chamber/dsh-host-client-graph'
`
  const update = computeCordisPatchUpdate(crossed, [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME },
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already bound|already mounted|duplicate chamber loader identity/)
})

test('seed: same chamber id with a different package fails loud', () => {
  const update = computeCordisPatchUpdate(`- insert:\n    - id: git-worktree\n      name: '@example/not-chamber'\n`, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already bound/)
})

test('seed: same chamber package under a different id fails loud', () => {
  const update = computeCordisPatchUpdate(`- insert:\n    - id: user-git-row\n      name: '@dsh-chamber/dsh-host-git-worktree'\n`, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already mounted/)
})

test('seed: duplicate exact chamber rows fail loud instead of accepting the next boot failure', () => {
  const duplicate = `- insert:\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-host-git-worktree'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-host-git-worktree'\n`
  const update = computeCordisPatchUpdate(duplicate, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /duplicate chamber loader identity/)
})

test('seed: name-first sibling rows cannot be cross-paired into a false exact match', () => {
  const crossed = `- insert:
    - id: git-worktree
      name: '@example/not-chamber'
    - name: '@dsh-chamber/dsh-host-git-worktree'
      id: another-git-service
`
  const update = computeCordisPatchUpdate(crossed, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already bound|already mounted|duplicate chamber loader identity/)
})

test('seed: an exact name-first loader row is reused', () => {
  const exact = `- insert:
    - name: '@dsh-chamber/dsh-host-git-worktree'
      id: git-worktree
`
  assert.deepEqual(computeCordisPatchUpdate(exact, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ]), { write: false })
})

test('seed: a nested config name cannot complete the parent loader identity', () => {
  const nested = `- insert:
    - id: git-worktree
      name: '@example/not-chamber'
      config:
        name: '@dsh-chamber/dsh-host-git-worktree'
`
  const update = computeCordisPatchUpdate(nested, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already bound|duplicate chamber loader identity/)
})

test('seed: crossed inline-flow mappings stay separate', () => {
  const crossed = `- insert: [{ id: git-worktree, name: '@example/not-chamber' }, { id: other, name: '@dsh-chamber/dsh-host-git-worktree' }]
`
  const update = computeCordisPatchUpdate(crossed, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already bound|already mounted|duplicate chamber loader identity/)
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
// applyPlugins: failure isolation / verification / restart semantics
// ============================================================================

test('applyPlugins: per-item failure isolation — one failing add never blocks the rest', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      const specArg = payload.argv?.[4]
      if (specArg === 'bad@1.0.0') return err('pnpm error: 404 Not Found')
      return ok()
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      return ok(JSON.stringify({ dependencies: { good: '^1.0.0' }, dsh: { profile: { bundles: [] } } }))
    }
    return err(`unexpected ${action}`)
  }
  const result = await applyPlugins(exec, readyStatus, { id: 's1', remoteDshHome: null }, {
    add: ['good@^1.0.0', 'bad@1.0.0'],
    remove: [],
    restart: false,
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.applied, 1, 'only the successful add counts')
    assert.equal(result.result.failed.length, 1)
    assert.equal(result.result.failed[0].spec, 'bad@1.0.0')
    assert.match(result.result.failed[0].error, /404/)
    assert.equal(result.result.verified, true, 'failed items are excluded from the assertion')
  }
})

test('applyPlugins: verified:false when an add did not land in the remote manifest (fail-loud)', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') return ok()
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      // The add "succeeded" on the wire but never reached dependencies.
      return ok(JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
    }
    return err(`unexpected ${action}`)
  }
  const result = await applyPlugins(exec, readyStatus, { id: 's1', remoteDshHome: null }, {
    add: ['pkg@^1.0.0'],
    remove: [],
    restart: false,
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.applied, 1)
    assert.equal(result.result.verified, false)
  }
})

test('applyPlugins: restart failure → {restarted:false, ready:null}, honest report, never a fake success', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') return ok()
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      return ok(JSON.stringify({ dependencies: { pkg: '^1.0.0' }, dsh: { profile: { bundles: [] } } }))
    }
    if (action === 'restart') return err('systemctl restart failed (exit 5)')
    return err(`unexpected ${action}`)
  }
  const result = await applyPlugins(exec, readyStatus, { id: 's1', remoteDshHome: null }, {
    add: ['pkg@^1.0.0'],
    remove: [],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.restarted, false)
    assert.equal(result.result.ready, null)
    assert.equal(result.result.deferred, false)
  }
})

test('applyPlugins: ready recheck failure after a restart → {ready:false}', async () => {
  // The instance is CONNECTED before the apply (ready), then the restart
  // leaves it down and it never recovers — the bounded recheck must time out.
  let phase: 'ready' | 'error' = 'ready'
  const status: StatusFn = () => ({ phase })
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') return ok()
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      return ok(JSON.stringify({ dependencies: { pkg: '^1.0.0' }, dsh: { profile: { bundles: [] } } }))
    }
    if (action === 'restart') { phase = 'error'; return ok() }
    return err(`unexpected ${action}`)
  }
  const result = await applyPlugins(exec, status, { id: 's1', remoteDshHome: null }, {
    add: ['pkg@^1.0.0'],
    remove: [],
  }, { verifyReadyTimeoutMs: 20, verifyReadyIntervalMs: 5 })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.restarted, true)
    assert.equal(result.result.ready, false)
  }
})

test('applyPlugins: restart on a NOT-connected instance reports ready:null + readyNote, never a misleading ready:false', async () => {
  const idleStatus: StatusFn = () => ({ phase: 'idle' })
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') return ok()
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      return ok(JSON.stringify({ dependencies: { pkg: '^1.0.0' }, dsh: { profile: { bundles: [] } } }))
    }
    if (action === 'restart') return ok()
    return err(`unexpected ${action}`)
  }
  const result = await applyPlugins(exec, idleStatus, { id: 's1', remoteDshHome: null }, {
    add: ['pkg@^1.0.0'],
    remove: [],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.restarted, true)
    assert.equal(result.result.ready, null)
    assert.ok(result.result.readyNote !== undefined)
    assert.match(result.result.readyNote, /not connected/)
  }
})

test('applyPlugins: a non-boolean restart is refused (string "false" must never trigger a restart)', async () => {
  const exec: ExecFn = async () => { throw new Error('no exec may run for an invalid apply') }
  const result = await applyPlugins(exec, readyStatus, { id: 's1', remoteDshHome: null }, {
    add: ['pkg@^1.0.0'],
    remove: [],
    restart: 'false' as unknown as boolean,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /restart must be a boolean/)
})

test('applyPlugins: a known bundle add missing from the remote bundles layer → verified:false (design 13 §4.5 ④)', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') return ok()
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      // dependency present but the bundle activation layer is empty.
      return ok(JSON.stringify({ dependencies: { 'bundle-pkg': '^1.0.0' }, dsh: { profile: { bundles: [] } } }))
    }
    if (action === 'restart') return ok()
    return err(`unexpected ${action}`)
  }
  const result = await applyPlugins(exec, readyStatus, { id: 's1', remoteDshHome: null }, {
    add: ['bundle-pkg@^1.0.0'],
    remove: [],
    restart: false,
  }, { knownBundles: ['bundle-pkg'] })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.result.verified, false)
})

test('applyPlugins: a known bundle add in dependencies AND bundles → verified:true', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') return ok()
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      return ok(JSON.stringify({ dependencies: { 'bundle-pkg': '^1.0.0' }, dsh: { profile: { bundles: ['bundle-pkg'] } } }))
    }
    if (action === 'restart') return ok()
    return err(`unexpected ${action}`)
  }
  const result = await applyPlugins(exec, readyStatus, { id: 's1', remoteDshHome: null }, {
    add: ['bundle-pkg@^1.0.0'],
    remove: [],
    restart: false,
  }, { knownBundles: ['bundle-pkg'] })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.result.verified, true)
})

// ============================================================================
// seedRemoteHostGraph (design 13 §4.6)
// ============================================================================

function makeSeedExec(overrides: {
  seedFiles?: Map<string, Buffer>
  patchContent?: string | null
  failWrite?: (path: string) => string | null
  failSeedCat?: (path: string) => string | null
} = {}) {
  const calls: string[] = []
  const written: Array<{ path: string; bytes: Buffer }> = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0]
      calls.push(`cat:${path}`)
      if (path !== undefined && path.startsWith('~/.dsh/profiles/node_modules/@dsh-chamber/')) {
        if (overrides.failSeedCat !== undefined) {
          const message = overrides.failSeedCat(path)
          if (message !== null) return err(message)
        }
        const bytes = overrides.seedFiles?.get(path)
        if (bytes !== undefined) return okBytes(bytes)
        return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      }
      if (path === '~/.dsh/profiles/web/cordis.patch.yml') {
        if (overrides.patchContent === null) {
          return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
        }
        return ok(overrides.patchContent)
      }
      return err('run command failed (exit 1): cat: no such file')
    }
    if (action === 'run' && payload?.op === 'write-file') {
      const path = payload.path ?? '?'
      calls.push(`write:${path}`)
      if (overrides.failWrite !== undefined) {
        const message = overrides.failWrite(path)
        if (message !== null) return err(message)
      }
      written.push({ path, bytes: Buffer.from(payload.contentBase64 ?? '', 'base64') })
      return ok()
    }
    calls.push(`other:${action}`)
    return ok()
  }
  return { exec, calls, written }
}

function writeModuleA(root: string, pkgJson: string | Buffer, distJs: string | Buffer): string {
  const sourceDir = join(root, 'module-a')
  mkdirSync(join(sourceDir, 'dist'), { recursive: true })
  writeFileSync(join(sourceDir, 'package.json'), pkgJson)
  writeFileSync(join(sourceDir, 'dist', 'index.js'), distJs)
  return sourceDir
}

const SEED_SPEC: RemoteSpec = { id: 's1', remoteDshHome: null }

function writeHostSeedPackage(root: string, dirName: string, packageName: string, distJs: string): string {
  const sourceDir = join(root, dirName)
  mkdirSync(join(sourceDir, 'dist'), { recursive: true })
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0' }))
  writeFileSync(join(sourceDir, 'dist', 'index.js'), distJs)
  return sourceDir
}

function dualHostSeeds(root: string): ChamberHostPackageSeed[] {
  return [
    {
      insertId: CLIENT_GRAPH_INSERT_ID,
      packageName: CLIENT_GRAPH_PACKAGE_NAME,
      sourceDir: writeHostSeedPackage(root, 'graph', CLIENT_GRAPH_PACKAGE_NAME, 'export const graph = 1\n'),
      label: 'host-graph',
    },
    {
      insertId: GIT_WORKTREE_INSERT_ID,
      packageName: GIT_WORKTREE_PACKAGE_NAME,
      sourceDir: writeHostSeedPackage(root, 'git', GIT_WORKTREE_PACKAGE_NAME, 'export const git = 1\n'),
      label: 'git-worktree',
    },
  ]
}

test('seedRemoteChamberHostPackages: seeds two packages before one merged patch write', async () => {
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, dualHostSeeds(tempDir()))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.packages.length, 2)
  assert.equal(result.wrote, true)
  assert.equal(result.patched, true)
  assert.equal(remote.written.length, 5, 'four package files + one merged patch')
  const patchWrites = remote.written.filter(entry => entry.path === '~/.dsh/profiles/web/cordis.patch.yml')
  assert.equal(patchWrites.length, 1)
  const patch = patchWrites[0].bytes.toString('utf8')
  assert.ok(patch.includes('id: client-graph'))
  assert.ok(patch.includes('id: git-worktree'))
  assert.equal(remote.calls.at(-1), 'write:~/.dsh/profiles/web/cordis.patch.yml', 'patch is committed after every package file')
})

test('seedRemoteChamberHostPackages: broken second source fails preflight before any remote call', async () => {
  const root = tempDir()
  const seeds = dualHostSeeds(root)
  const broken = join(root, 'broken-git')
  mkdirSync(join(broken, 'dist'), { recursive: true })
  writeFileSync(join(broken, 'dist', 'index.js'), 'export default {}\n')
  seeds[1] = { ...seeds[1], sourceDir: broken }
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, seeds)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /package\.json missing/)
  assert.deepEqual(remote.calls, [])
  assert.deepEqual(remote.written, [])
})

test('seedRemoteChamberHostPackages: second-package read failure happens before every write', async () => {
  const remote = makeSeedExec({
    patchContent: TEMPLATE,
    failSeedCat: path => path.includes(GIT_WORKTREE_PACKAGE_NAME) ? 'ssh transport failed (exit 255)' : null,
  })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, dualHostSeeds(tempDir()))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /git-worktree seed read/)
  assert.deepEqual(remote.written, [], 'all remote probes finish before the first write')
})

test('seedRemoteChamberHostPackages: an unbuilt package is omitted from files and loader rows', async () => {
  const root = tempDir()
  const seeds = dualHostSeeds(root)
  seeds[1] = { ...seeds[1], sourceDir: join(root, 'not-built') }
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, seeds)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.packages.map(entry => entry.insertId), [CLIENT_GRAPH_INSERT_ID])
  const patch = remote.written.find(entry => entry.path.endsWith('/cordis.patch.yml'))?.bytes.toString('utf8') ?? ''
  assert.ok(patch.includes('id: client-graph'))
  assert.ok(!patch.includes('id: git-worktree'))
  assert.ok(!remote.calls.some(call => call.includes(GIT_WORKTREE_PACKAGE_NAME)))
})

test('seedRemoteHostGraph: module A absent = not shipped → no files AND no patch (never a broken insert)', async () => {
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteHostGraph(remote.exec, SEED_SPEC, join(tempDir(), 'does-not-exist'))
  assert.deepEqual(result, { ok: true, wrote: false, patched: false })
  assert.deepEqual(remote.calls, [], 'no remote exec at all when module A is absent')
  assert.equal(remote.written.length, 0)
})

test('seedRemoteHostGraph: writes both seed files and appends the patch insert', async () => {
  const root = tempDir()
  const sourceDir = writeModuleA(root, JSON.stringify({ name: '@dsh-chamber/dsh-host-client-graph', version: '1.0.0' }), 'export const graph = 1\n')
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteHostGraph(remote.exec, SEED_SPEC, sourceDir)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.wrote, true)
  assert.equal(result.patched, true)
  assert.equal(remote.written.length, 3, 'package.json + dist/index.js + patch')
  const patchWrite = remote.written.find(entry => entry.path === '~/.dsh/profiles/web/cordis.patch.yml')
  assert.ok(patchWrite !== undefined)
  assert.ok(patchWrite.bytes.toString('utf8').includes('- insert:'))
  assert.ok(remote.calls.some(call => call === 'write:~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/dist/index.js'))
})

test('seedRemoteHostGraph: hash-identical seed files are skipped in the BYTE domain, patch still ensured', async () => {
  const root = tempDir()
  // dist/index.js carries invalid UTF-8 bytes — the old string-domain hash
  // would have false-mismatched (U+FFFD) and rewritten; the byte-domain
  // comparison must skip.
  const distJs = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x81, 0x00, 0x01])
  const pkgJson = Buffer.from('{"name":"x"}')
  const sourceDir = writeModuleA(root, pkgJson, distJs)
  const seedFiles = new Map<string, Buffer>()
  seedFiles.set('~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json', pkgJson)
  seedFiles.set('~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/dist/index.js', distJs)
  const remote = makeSeedExec({ patchContent: TEMPLATE, seedFiles })
  const result = await seedRemoteHostGraph(remote.exec, SEED_SPEC, sourceDir)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.wrote, false, 'identical bytes are skipped (no rewrite)')
  assert.equal(remote.written.length, 1, 'only the patch write remains')
  assert.equal(remote.written[0].path, '~/.dsh/profiles/web/cordis.patch.yml')
})

test('seedRemoteHostGraph: an uninitialized remote profile (patch ENOENT) fails loud', async () => {
  const root = tempDir()
  const sourceDir = writeModuleA(root, '{"name":"x"}', 'export const graph = 1\n')
  const remote = makeSeedExec({ patchContent: null })
  const result = await seedRemoteHostGraph(remote.exec, SEED_SPEC, sourceDir)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not initialized/)
  assert.equal(remote.written.length, 0, 'the patch probe runs FIRST — no package files are left behind by the fail-loud path')
})

test('seedRemoteHostGraph: a seed write failure fails loud and never reaches the patch', async () => {
  const root = tempDir()
  const sourceDir = writeModuleA(root, '{"name":"x"}', 'export const graph = 1\n')
  const remote = makeSeedExec({
    patchContent: TEMPLATE,
    failWrite: path => (path.includes('dist/index.js') ? 'write-file target not allowed' : null),
  })
  const result = await seedRemoteHostGraph(remote.exec, SEED_SPEC, sourceDir)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /write-file failed for dist\/index\.js/)
  assert.ok(!remote.written.some(entry => entry.path === '~/.dsh/profiles/web/cordis.patch.yml'), 'no patch without the package files')
})

test('seedRemoteHostGraph: a NON-ENOENT seed-file cat failure fails loud WITHOUT attempting the write', async () => {
  const root = tempDir()
  const sourceDir = writeModuleA(root, '{"name":"x"}', 'export const graph = 1\n')
  const remote = makeSeedExec({
    patchContent: TEMPLATE,
    // The FIRST seed-file probe (package.json) dies with an ssh failure —
    // not an ENOENT — so the seed must fail loud before any write, exactly
    // like the patch probe's discipline (never mask a dead ssh behind a
    // misleading "write-file failed").
    failSeedCat: path => (path.endsWith('/package.json') ? 'the ssh exec could not reach the host (exit 255)' : null),
  })
  const result = await seedRemoteHostGraph(remote.exec, SEED_SPEC, sourceDir)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /host-graph seed read package\.json failed/)
  assert.equal(remote.written.length, 0, 'no write is attempted after a non-ENOENT read-back failure')
  assert.ok(!remote.calls.some(call => call.startsWith('write:')), 'the failing cat is never papered over by a write')
})

test('seedRemoteHostGraph: every probe cat is marked quiet (expected ENOENT on a first seed)', async () => {
  const root = tempDir()
  const sourceDir = writeModuleA(root, '{"name":"x"}', 'export const graph = 1\n')
  const payloads: TransportRunPayload[] = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (payload !== undefined) payloads.push(payload)
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path === '~/.dsh/profiles/web/cordis.patch.yml') return ok(TEMPLATE)
      return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
    }
    if (action === 'run' && payload?.op === 'write-file') return ok()
    return ok()
  }
  const result = await seedRemoteHostGraph(exec, SEED_SPEC, sourceDir)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const probes = payloads.filter(p => p.op === 'exec' && p.command === 'cat')
  assert.equal(probes.length, 3, 'two seed-file probes + the patch probe')
  assert.ok(probes.every(p => p.quiet === true), 'every probe cat carries quiet: true')
  // A write-file is never quiet: a failed write is a real error, always loud.
  assert.ok(payloads.filter(p => p.op === 'write-file').every(p => p.quiet !== true), 'write-file payloads are never quiet')
})

// ============================================================================
// materializeAndAdd (design 13 §4.6)
// ============================================================================

test('materializePluginsDir is the stable literal dir for every remoteDshHome (design 13 §4.6)', () => {
  assert.equal(materializePluginsDir(null), '~/.dsh-chamber/plugins')
  assert.equal(materializePluginsDir('~/.dsh'), '~/.dsh-chamber/plugins')
  assert.equal(materializePluginsDir('/opt/dsh'), '~/.dsh-chamber/plugins')
})

test('materializeAbsolutePath resolves ~ via the REMOTE $HOME (printf), never the local home', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'printf') {
      assert.deepEqual(payload.argv, ['%s', '$HOME'])
      return ok('/home/remote-user')
    }
    return err(`unexpected ${action}`)
  }
  const resolved = await materializeAbsolutePath(exec, SEED_SPEC, '~/.dsh-chamber/plugins/pkg-a1b2.tgz')
  assert.deepEqual(resolved, { ok: true, path: '/home/remote-user/.dsh-chamber/plugins/pkg-a1b2.tgz' })
})

test('materializeAbsolutePath: absolute paths pass through; an unsafe remote $HOME fails loud', async () => {
  const passthrough = await materializeAbsolutePath(async () => err('unexpected'), SEED_SPEC, '/opt/x.tgz')
  assert.deepEqual(passthrough, { ok: true, path: '/opt/x.tgz' })
  const unsafeExec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'printf') return ok('bad home with spaces; rm -rf /')
    return err(`unexpected ${action}`)
  }
  const fail = await materializeAbsolutePath(unsafeExec, SEED_SPEC, '~/.dsh-chamber/plugins/x.tgz')
  assert.equal(fail.ok, false)
  if (!fail.ok) assert.match(fail.error, /not an absolute, shell-safe path/)
})

function makeMaterializeExec() {
  const calls: Array<{ op: string; argv?: string[] }> = []
  const written: Array<{ path: string; bytes: Buffer }> = []
  const exec: ExecFn = async (_id, action, payload) => {
    const record: { op: string; argv?: string[] } = { op: payload?.op ?? action }
    calls.push(record)
    if (action === 'run' && payload?.op === 'write-file') {
      written.push({ path: payload.path ?? '?', bytes: Buffer.from(payload.contentBase64 ?? '', 'base64') })
      return ok()
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'printf') {
      record.argv = payload.argv
      return ok('/home/u')
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      record.argv = payload.argv
      return ok()
    }
    return err(`unexpected ${action}`)
  }
  return { exec, calls, written }
}

test('materializeAndAdd: pack → write-file → remote $HOME → add file:<absolute> (scoped name normalized)', async () => {
  const root = tempDir()
  const pkgDir = join(root, 'pkg')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@scope/my-plugin', version: '1.0.0' }))
  const tarball = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x01])
  const remote = makeMaterializeExec()
  const result = await materializeAndAdd(remote.exec, SEED_SPEC, pkgDir, () => ({ bytes: tarball }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  // write target: the stable literal dir + the NORMALIZED scoped filename.
  assert.equal(remote.written.length, 1)
  const writePath = remote.written[0].path
  assert.ok(writePath.startsWith('~/.dsh-chamber/plugins/scope-my-plugin-'), `normalized filename, got ${writePath}`)
  assert.ok(writePath.endsWith('.tgz'))
  assert.ok(remote.written[0].bytes.equals(tarball), 'the tarball bytes are preserved verbatim')
  // add spec: absolute file: under the remote $HOME — never a local path.
  const addCall = remote.calls.find(entry => entry.op === 'exec' && entry.argv?.[0] === 'plugin')
  assert.ok(addCall !== undefined)
  const addSpec = addCall.argv?.[4] ?? ''
  assert.match(addSpec, /^file:\/home\/u\/\.dsh-chamber\/plugins\/scope-my-plugin-[0-9a-f]{16}\.tgz$/)
  assert.equal(result.remotePath, writePath)
  assert.equal(result.spec, addSpec)
})

test('materializeAndAdd: an unresolvable remote $HOME fails loud (never the LOCAL home path)', async () => {
  const root = tempDir()
  const pkgDir = join(root, 'pkg')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }))
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'write-file') return ok()
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'printf') {
      return err('run command failed (exit 255): the ssh exec could not reach the host')
    }
    return err(`unexpected ${action}`)
  }
  const result = await materializeAndAdd(exec, SEED_SPEC, pkgDir, () => ({ bytes: Buffer.from('x') }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /cannot resolve the remote \$HOME/)
})

test('materializeAndAdd: a write-file failure fails loud before the add', async () => {
  const root = tempDir()
  const pkgDir = join(root, 'pkg')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }))
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'write-file') return err('write-file verification failed: remote SHA-256 mismatch')
    return err(`unexpected ${action}`)
  }
  const result = await materializeAndAdd(exec, SEED_SPEC, pkgDir, () => ({ bytes: Buffer.from('x') }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /write-file failed/)
})
test('local plugin writer reaper fail-closes on PID identity reuse', async () => {
  const root = tempDir()
  const home = join(root, 'state', 'dsh-home')
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(localPluginWriterLedgerPath(home), JSON.stringify({
    schemaVersion: 1,
    pid: 41001,
    ownerPid: 41000,
    ownerStartToken: 'old-owner',
    childStartToken: 'old-child',
    childCommandHash: 'old-command',
    createdAt: new Date().toISOString(),
  }))
  const signals: string[] = []
  const result = await reapStaleLocalPluginWriters(home, {
    inspectProcess: pid => pid === 41001
      ? { startToken: 'reused-child', commandHash: 'different-command' }
      : null,
    processAlive: pid => pid === 41001,
    signalGroup: (_pid, signal) => { signals.push(signal) },
    wait: async () => {},
  })
  assert.deepEqual(result, { ok: false, error: 'local plugin writer PID identity changed; refusing to signal it' })
  assert.deepEqual(signals, [])
  assert.equal(existsSync(localPluginWriterLedgerPath(home)), true)
})

test('local plugin writer reaper kills a daemonized descendant after its group leader exited', {
  skip: process.platform === 'win32',
  timeout: 15_000,
}, async () => {
  const root = tempDir()
  const home = join(root, 'state', 'dsh-home')
  mkdirSync(join(root, 'state'), { recursive: true })
  const leader = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref()",
    "process.stdout.write(String(child.pid))",
  ].join(';')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  leader.stdout?.setEncoding('utf8')
  leader.stdout?.on('data', chunk => { output += chunk })
  await new Promise<void>((resolve, reject) => {
    leader.once('close', () => resolve())
    leader.once('error', reject)
  })
  const descendantPid = Number(output)
  assert.ok(Number.isInteger(leader.pid) && leader.pid! > 0)
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0)
  writeFileSync(localPluginWriterLedgerPath(home), JSON.stringify({
    schemaVersion: 1,
    pid: leader.pid,
    ownerPid: 2_000_000_000,
    ownerStartToken: null,
    childStartToken: 'leader-exited',
    childCommandHash: 'leader-exited',
    createdAt: new Date().toISOString(),
  }))
  try {
    const result = await reapStaleLocalPluginWriters(home)
    assert.deepEqual(result, { ok: true, reaped: true })
    assert.equal(existsSync(localPluginWriterLedgerPath(home)), false)
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/)
  } finally {
    try { process.kill(-leader.pid!, 'SIGKILL') } catch { /* already reaped */ }
    rmSync(root, { recursive: true, force: true })
  }
})

// ============================================================================
// 1.5 Renderer projection redaction + confirmation copy (design 09 §4 v1
// mitigations — a remote bundle shares the page and must never see local
// absolute paths, nor drive pack/install/remove silently).
// ============================================================================

test('redactLocalPluginManifest: local-path spec values are masked, registry values untouched', () => {
  const manifest = {
    dependencies: {
      'file-dep': 'file:/Users/x/pkg',
      'link-dep': 'link:../pkg',
      'rel-dep': './pkg',
      'abs-dep': '/opt/pkg',
      'home-dep': '~/pkg',
      'registry-dep': '^1.2.3',
      'pinned-dep': '1.2.3',
      'tag-dep': 'latest',
      'workspace-dep': 'workspace:*',
      'npm-dep': 'npm:some-alias',
      'git-dep': 'git+ssh://git@example.com/x/y.git',
      'github-dep': 'github:user/repo',
      'url-dep': 'https://example.com/pkg.tgz',
    },
    bundles: ['file-dep'],
    clientLines: ['link-dep'],
    bundleLines: ['file-dep'],
    unsyncable: [{ name: 'workspace-dep', reason: 'workspace protocol' }],
    chamber: { ok: true, hostGraph: { installed: true, patched: true, version: '1.0.0', live: null }, gitWorktree: { installed: true, patched: true, version: '1.0.0', live: null } },
  }
  const redacted = redactLocalPluginManifest(manifest as never)
  assert.equal(redacted.dependencies['file-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(redacted.dependencies['link-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(redacted.dependencies['rel-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(redacted.dependencies['abs-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(redacted.dependencies['home-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(redacted.dependencies['registry-dep'], '^1.2.3')
  assert.equal(redacted.dependencies['pinned-dep'], '1.2.3')
  assert.equal(redacted.dependencies['tag-dep'], 'latest')
  // Unsyncable values pass through (their reason carries no path) — npm
  // aliases, git/URL specs and workspaces are never masked.
  assert.equal(redacted.dependencies['workspace-dep'], 'workspace:*')
  assert.equal(redacted.dependencies['npm-dep'], 'npm:some-alias')
  assert.equal(redacted.dependencies['git-dep'], 'git+ssh://git@example.com/x/y.git')
  assert.equal(redacted.dependencies['github-dep'], 'github:user/repo')
  assert.equal(redacted.dependencies['url-dep'], 'https://example.com/pkg.tgz')
  // Non-dependency fields are untouched.
  assert.deepEqual(redacted.bundles, ['file-dep'])
  assert.deepEqual(redacted.clientLines, ['link-dep'])
  assert.deepEqual(redacted.bundleLines, ['file-dep'])
  assert.deepEqual(redacted.unsyncable, [{ name: 'workspace-dep', reason: 'workspace protocol' }])
  assert.equal(redacted.chamber.ok, true)
})

test('redactLocalPluginManifest: the mask still classifies as materialize on both sides (client isPathSpec parity)', () => {
  // The client-side diff (plugin-diff.ts isPathSpec) keys on the `file:`
  // prefix — the mask must keep classification identical to the raw path.
  assert.equal(classifyDependencyValue(MATERIALIZED_VALUE_MASK).kind, 'materialize')
})

test('describeMaterializeConfirmation carries the plugin name, resolved path and target', () => {
  const copy = describeMaterializeConfirmation({ pluginName: '@scope/pkg', pluginPath: '/Users/x/pkg', targetLabel: 'prod-server', targetId: 'ssh-1' })
  assert.match(copy.message, /@scope\/pkg/)
  assert.match(copy.detail, /\/Users\/x\/pkg/)
  assert.match(copy.detail, /prod-server/)
  const fallback = describeMaterializeConfirmation({ pluginName: 'pkg', pluginPath: '/p', targetLabel: null, targetId: 'ssh-2' })
  assert.match(fallback.detail, /ssh-2/, 'target falls back to the instance id')
})

test('describeLocalPluginAddConfirmation / describeLocalPluginRemoveConfirmation name the action', () => {
  const add = describeLocalPluginAddConfirmation('some-pkg@^1.2.3')
  assert.match(add.message, /some-pkg@\^1\.2\.3/)
  assert.match(add.detail, /本地 dsh profile/)
  const remove = describeLocalPluginRemoveConfirmation('some-pkg')
  assert.match(remove.message, /some-pkg/)
  assert.match(remove.detail, /卸载/)
})

test('describePluginApplyConfirmation names the target and the add/remove/restart parts', () => {
  const copy = describePluginApplyConfirmation({
    targetLabel: 'prod-server', targetId: 'ssh-1',
    add: ['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d'], remove: ['old-pkg'], restart: true,
  })
  assert.match(copy.message, /prod-server/)
  assert.match(copy.detail, /安装 4 个插件（pkg-a、pkg-b、pkg-c 等）/)
  assert.match(copy.detail, /移除 1 个插件（old-pkg）/)
  assert.match(copy.detail, /重启远端 dsh/)
  const fallback = describePluginApplyConfirmation({ targetLabel: null, targetId: 'ssh-2', add: ['x'], remove: [], restart: false })
  assert.match(fallback.message, /ssh-2/, 'target falls back to the instance id')
})

test('describeSeedConfirmation names the target and the write/restart effect', () => {
  const copy = describeSeedConfirmation({ targetLabel: 'prod-server', targetId: 'ssh-1' })
  assert.match(copy.message, /prod-server/)
  assert.match(copy.detail, /写入 chamber host 包/)
  const fallback = describeSeedConfirmation({ targetLabel: null, targetId: 'ssh-2' })
  assert.match(fallback.message, /ssh-2/, 'target falls back to the instance id')
})
