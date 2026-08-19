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
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyPlugins,
  classifyDependencyValue,
  classifyLocalDependency,
  classifySpec,
  CLIENT_GRAPH_PACKAGE_NAME,
  computeCordisPatchUpdate,
  localPluginList,
  materializeAbsolutePath,
  materializeAndAdd,
  materializePluginsDir,
  packageNameFromSpec,
  remotePluginList,
  resetApplyInFlight,
  seedRemoteHostGraph,
  PLUGIN_SPEC_PATTERN,
  PLUGIN_NAME_PATTERN,
} from './plugin-sync.ts'
import type { ExecFn, ExecResult, StatusFn, RemoteSpec, TransportRunPayload } from './plugin-sync.ts'

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
  assert.deepEqual(manifest.chamber, { ok: true, hostGraph: { installed: true, patched: true, version: null, live: null } })
})

test('localPluginList: chamber host-graph state — absent = not injected (honest, never "done")', () => {
  const base = tempDir()
  const home = join(base, 'home')
  writeLocalProfile(home, {}, [])
  const manifest = localPluginList(home)
  assert.deepEqual(manifest.chamber, { ok: true, hostGraph: { installed: false, patched: false, version: null, live: null } })
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
  assert.deepEqual(manifest.chamber, { ok: true, hostGraph: { installed: false, patched: true, version: null, live: null } })
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
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n")
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
      chamber: { ok: true, hostGraph: { installed: true, patched: true, version: null, live: null } },
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
        chamber: { ok: true, hostGraph: { installed: false, patched: false, version: null, live: null } },
      },
    },
  )
  const sshDown: ExecFn = async () => err('the ssh exec could not reach the host (exit 255)')
  assert.deepEqual(
    await remotePluginList(sshDown, { id: 's1', remoteDshHome: null }),
    { ok: false, error: 'the ssh exec could not reach the host (exit 255)' },
  )
})

test('remotePluginList: chamber probe — installed but the boot-layer insert missing (half-injected)', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph"}')
      // initProfile template: comments + empty list → the seed would rewrite it.
      if (path.endsWith('/cordis.patch.yml')) return ok('# comment\n[]')
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.manifest.chamber, { ok: true, hostGraph: { installed: true, patched: false, version: null, live: null } })
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
      // dist/index.js genuinely missing: a package.json alone is a
      // half-installed module A (the boot row could not resolve).
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
    assert.deepEqual(result.manifest.chamber, { ok: true, hostGraph: { installed: false, patched: true, version: null, live: null } })
  }
})

test('remotePluginList: chamber probe ssh failure on dist/index.js is loud, never a silent "not injected"', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph"}')
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
    assert.deepEqual(result.manifest.chamber, { ok: true, hostGraph: { installed: false, patched: false, version: null, live: null } })
  }
})

test('remotePluginList: chamber probe parses module A version and reports live-effect via liveProbe', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-host-client-graph","version":"0.1.2"}')
      }
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  // live = true → the RUNNING instance has loaded the module (已生效).
  const live = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, { liveProbe: async () => true })
  assert.ok(live.ok)
  if (live.ok) {
    assert.deepEqual(live.manifest.chamber, { ok: true, hostGraph: { installed: true, patched: true, version: '0.1.2', live: true } })
  }
  // live = false → injected but restart still pending (重启后生效).
  const pending = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, { liveProbe: async () => false })
  assert.ok(pending.ok)
  if (pending.ok) {
    assert.deepEqual(pending.manifest.chamber, { ok: true, hostGraph: { installed: true, patched: true, version: '0.1.2', live: false } })
  }
  // live = null → the desktop could not classify (no ready tunnel): the UI
  // renders 生效状态未知 — never a guessed claim.
  const unknown = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, { liveProbe: async () => null })
  assert.ok(unknown.ok)
  if (unknown.ok) {
    assert.deepEqual(unknown.manifest.chamber, { ok: true, hostGraph: { installed: true, patched: true, version: '0.1.2', live: null } })
  }
  // A version-less seeded package.json → version:null (never a guessed one).
  const versionless: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph"}')
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n")
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

test('remotePluginList: liveProbe is NOT consulted when the injection is half-present (cannot be live by definition)', async () => {
  let probed = false
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-host-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-host-client-graph","version":"0.1.2"}')
      // dist/index.js missing → installed:false.
      if (path.includes('@dsh-chamber/dsh-host-client-graph/dist/index.js')) {
        return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      }
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, {
    liveProbe: async () => { probed = true; return true },
  })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.manifest.chamber, { ok: true, hostGraph: { installed: false, patched: true, version: '0.1.2', live: null } })
  }
  assert.equal(probed, false, 'a half-injected module is never "live" — the probe is skipped')
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
    const record = { op: payload?.op ?? action }
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
