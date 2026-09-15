/**
 * plugin-sync — part 5: the renderer projection (read-face rows/redaction,
 * confirmation copy, isAllowedLocalFileSpec, runLocalDshPlugin) and the pinned
 * runtime lockfile preference.
 *
 * Sibling parts: plugin-sync.test.ts, plugin-sync-remote-read.test.ts,
 * plugin-sync-apply.test.ts, plugin-sync-seed.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAMBER_SEED_NAMES, shouldPreferPinnedRuntimeLockfile, classifyDependencyValue, CLIENT_GRAPH_PACKAGE_NAME, describeLocalPluginAddConfirmation, describeLocalPluginRemoveConfirmation, describeMaterializeConfirmation, describePluginApplyConfirmation, describeSeedConfirmation, GIT_WORKTREE_PACKAGE_NAME, isAllowedLocalFileSpec, localPluginList, MATERIALIZED_VALUE_MASK, redactLocalPluginManifest, redactRemotePluginManifest, runLocalDshPlugin } from '../../plugin-sync.ts'
import { PROFILE_BUNDLES_SNAPSHOT } from '../../../control-plane/src/protected-plugins.ts'
import { chamberProjection } from '../support/chamber-projection.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-'))
}

// ============================================================================
// 1.5 Renderer projection redaction + confirmation copy (design 09 §4 v1
// mitigations — a remote bundle shares the page and must never see local
// absolute paths, nor drive pack/install/remove silently).
// ============================================================================

test('localPluginList: rows = the profile dependency table, with role/protected classification', async () => {
  const home = mkdtempSync(join(tmpdir(), 'local-list-'))
  try {
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'web', version: '0.0.0',
      dependencies: {
        'third-party-pkg': '^1.0.0',
        'materialized-pkg': 'file:/tmp/x',
        // A baseline name the profile itself declares: it stays a row (and stays
        // protected/read-only) — the classifier half of the 2026-09 row-set rule.
        '@deepseek-ai/dsh-base': '0.1.5-rc.2',
      },
      dsh: { profile: { bundles: ['third-party-pkg', '@deepseek-ai/dsh-base'] } },
    }))
    for (const name of ['third-party-pkg', 'materialized-pkg']) {
      mkdirSync(join(profileDir, 'node_modules', name), { recursive: true })
    }
    writeFileSync(join(profileDir, 'node_modules', 'third-party-pkg', 'package.json'),
      JSON.stringify({ name: 'third-party-pkg', version: '1.2.3', dsh: { bundle: { patch: './p.js' } } }))
    const manifests = localPluginList(home, {
      path: home, version: '0.1.5-rc.2',
      familyNames: ['@deepseek-ai/dsh', '@deepseek-ai/dsh-session'],
      familyComplete: true,
    } as never)
    const rows = new Map(manifests.rows.map(row => [row.name, row]))
    // 行集 = 依赖表一行一条：安装自带组合（B₀）与 chamber 播种物（S）不再凭空出现
    // （chamber 组件在「chamber 受管组件」表里，官方组合是运行时基线）。
    assert.deepEqual([...rows.keys()].sort(),
      ['@deepseek-ai/dsh-base', 'materialized-pkg', 'third-party-pkg'].sort())
    for (const name of [...PROFILE_BUNDLES_SNAPSHOT, ...CHAMBER_SEED_NAMES]) {
      if (name === '@deepseek-ai/dsh-base') continue
      assert.equal(rows.has(name), false, `the baseline must not create a row: ${name}`)
    }
    assert.equal(rows.get('third-party-pkg')?.role, 'layer')
    assert.equal(rows.get('materialized-pkg')?.role, 'materialized')
    assert.equal(rows.get('third-party-pkg')?.protected, false)
    // 自己声明了基线的行：分类与保护照常（只读可见，写面拒绝）。
    assert.equal(rows.get('@deepseek-ai/dsh-base')?.protected, true)
    assert.equal(rows.get('@deepseek-ai/dsh-base')?.role, 'composition')
    assert.equal(rows.get('@deepseek-ai/dsh-base')?.owner, 'installation')
    // A family member that is NOT a direct dependency is not a row (rows come
    // from the dependency table, never from F).
    assert.equal(rows.has('@deepseek-ai/dsh-session'), false)
    // Raw local values are NOT masked on this face (registered deviation: the
    // local list still passes machine paths through; see STATUS).
    assert.equal(rows.get('materialized-pkg')?.spec, 'file:/tmp/x')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

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
    // The read-face rows MUST be masked by the same rule as `dependencies`
    // (2026-12 review): `rows[].spec` is a second channel for the same value.
    rows: [
      { name: 'file-dep', spec: 'file:/Users/x/pkg', version: null, role: 'materialized', protected: false, owner: 'user' },
      { name: 'registry-dep', spec: '^1.2.3', version: '1.2.3', role: 'third-party', protected: false, owner: 'user' },
      { name: '@deepseek-ai/dsh-base', spec: null, version: '0.1.5', role: 'composition', protected: true, owner: 'installation' },
    ],
    clientLines: ['link-dep'],
    bundleLines: ['file-dep'],
    unsyncable: [{ name: 'workspace-dep', reason: 'workspace protocol' }],
    chamber: chamberProjection({
      [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: true, version: '1.0.0' },
      [GIT_WORKTREE_PACKAGE_NAME]: { installed: true, patched: true, version: '1.0.0' },
    }),
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
  // ...and the rows channel carries the SAME masked values (no local path may
  // reach the renderer through `rows[].spec`).
  const rowOf = (name: string) => redacted.rows.find(row => row.name === name)
  assert.equal(rowOf('file-dep')?.spec, MATERIALIZED_VALUE_MASK)
  assert.equal(rowOf('registry-dep')?.spec, '^1.2.3')
  assert.equal(rowOf('@deepseek-ai/dsh-base')?.spec, null)
  assert.equal(rowOf('file-dep')?.role, 'materialized', 'masking must not change the role')
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

test('redactRemotePluginManifest: file: dependency values are masked (file: prefix kept), registry values untouched', () => {
  // Design 21 §6.2/§6.4 readManifest 投影统一掩码 (decision 18): the ssh
  // plugin_list RPC projection masks remote-local `file:` values exactly like
  // the gateway installed route — including remote materialized tarballs.
  const manifest = {
    dependencies: {
      'file-dep': 'file:/root/.dsh/profiles/plugins/x.tgz',
      'tarball-dep': 'file:/root/.dsh-chamber/plugins/@scope-name-1a2b.tgz',
      'uppercase-file': 'FILE:/root/x',
      'registry-dep': '^1.2.3',
      'pinned-dep': '1.2.3',
      'tag-dep': 'latest',
      // link:/relative/absolute values cannot reach a profile through
      // `dsh plugin` (only file: forms do) — gateway parity: left untouched.
      'link-dep': 'link:/root/x',
    },
    bundles: ['file-dep'],
    profileExists: true,
    chamber: chamberProjection({
      [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: true, version: '1.0.0' },
    }),
  }
  const redacted = redactRemotePluginManifest(manifest as never)
  assert.equal(redacted.dependencies['file-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(redacted.dependencies['tarball-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(redacted.dependencies['uppercase-file'], MATERIALIZED_VALUE_MASK)
  assert.equal(redacted.dependencies['registry-dep'], '^1.2.3')
  assert.equal(redacted.dependencies['pinned-dep'], '1.2.3')
  assert.equal(redacted.dependencies['tag-dep'], 'latest')
  assert.equal(redacted.dependencies['link-dep'], 'link:/root/x')
  assert.deepEqual(redacted.bundles, ['file-dep'])
  assert.equal(redacted.profileExists, true)
  assert.equal(redacted.chamber.ok, true)
})

test('redactRemotePluginManifest: the mask keeps materialize classification (name-based diff keeps working)', () => {
  // The client diff keys materialize rows on name + isPathSpec; the mask's
  // kept `file:` prefix must classify identically on both sides.
  assert.equal(classifyDependencyValue(MATERIALIZED_VALUE_MASK).kind, 'materialize')
  assert.equal(classifyDependencyValue(redactRemotePluginManifest({ dependencies: { x: 'file:/a/b.tgz' }, bundles: [], profileExists: true, chamber: chamberProjection({ [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: true } }) } as never).dependencies.x).kind, 'materialize')
})

test('redactRemotePluginManifest: masks only the dependencies projection — error/profile fields untouched', () => {
  const manifest = {
    dependencies: { broken: 'file:/srv/x' },
    bundles: [],
    profileExists: true,
    error: 'failed to parse remote package.json: boom',
    chamber: { ok: false, error: 'probe failed' },
  }
  const redacted = redactRemotePluginManifest(manifest as never)
  assert.equal(redacted.dependencies.broken, MATERIALIZED_VALUE_MASK)
  assert.equal(redacted.error, 'failed to parse remote package.json: boom')
  assert.equal(redacted.chamber.ok, false)
})

// ---------------------------------------------------------------------------
// Local folder-pick add gate (design 21 §6.5 缺陷①, plan 24 小项④)
// ---------------------------------------------------------------------------

test('isAllowedLocalFileSpec: absolute POSIX/Windows/UNC paths only — relative and control-char input refused', () => {
  assert.equal(isAllowedLocalFileSpec('file:/Users/x/plugin'), true, 'POSIX absolute path')
  assert.equal(isAllowedLocalFileSpec('file:C:\\Users\\x\\plugin'), true, 'Windows drive path')
  assert.equal(isAllowedLocalFileSpec('file:\\\\server\\share\\plugin'), true, 'UNC path')
  assert.equal(isAllowedLocalFileSpec('file:../relative'), false, 'relative path')
  assert.equal(isAllowedLocalFileSpec('file:./relative'), false, 'dot-relative path')
  assert.equal(isAllowedLocalFileSpec('file:'), false, 'empty selection')
  assert.equal(isAllowedLocalFileSpec('file:/tmp/x\nrm -rf'), false, 'control characters')
  assert.equal(isAllowedLocalFileSpec('plain-registry-spec'), false, 'no file: prefix')
})

test('runLocalDshPlugin: a deferred (profile-absent) judgement still reaches the CLI — the first add creates the profile', async () => {
  // Regression guard (design 21 §6.11.3 R0): `defer` is NOT a refusal. The
  // defense-in-depth guard inside runLocalDshPlugin used to treat every
  // non-allow outcome as a refusal, which broke the very first install on a
  // machine whose web profile does not exist yet.
  const dir = tempDir()
  try {
    const deferred = await runLocalDshPlugin(dir, dir, 'add', 'third-party-pkg@1.0.0', {
      protection: { familyNames: ['@deepseek-ai/dsh-base'], runtimeVersion: '0.1.5-rc.2', profileState: 'absent' },
    })
    assert.equal(deferred.ok, false)
    assert.match(deferred.error ?? '', /no dsh CLI entry found/,
      'a defer must fall through to the CLI lookup, never be reported as a refusal')

    // A protected name is still stopped BEFORE any CLI lookup.
    const refused = await runLocalDshPlugin(dir, dir, 'remove', '@deepseek-ai/dsh-base', {
      protection: { familyNames: ['@deepseek-ai/dsh-base'], runtimeVersion: '0.1.5-rc.2' },
    })
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /\[protected\]/)
    // ...and so is an official-scope install without an exact same-generation pin.
    const crossGen = await runLocalDshPlugin(dir, dir, 'add', '@deepseek-ai/dsh-experimental-x@0.1.4', {
      protection: { familyNames: ['@deepseek-ai/dsh-base'], runtimeVersion: '0.1.5-rc.2' },
    })
    assert.equal(crossGen.ok, false)
    assert.match(crossGen.error ?? '', /\[generation-mismatch\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runLocalDshPlugin: a file: pick is refused without allowFileSpec and passes the gate with it', async () => {
  // Empty workspace: both CLI entry probes miss, so a value that passed the
  // spec gate deterministically stops at the missing-CLI error — proving the
  // gate opened without spawning anything.
  const dir = tempDir()
  try {
    // Without the capability flag the spec gate refuses every file: value
    // BEFORE any CLI lookup (the renderer-submitted form must never pass).
    const refused = await runLocalDshPlugin(dir, dir, 'add', 'file:/tmp/picked-folder')
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /invalid add spec/)

    // With allowFileSpec (the MAIN-process folder-picker path, desktop_local_
    // plugin_add_file) the same pick passes the gate and proceeds to the
    // workspace's (absent) dsh CLI entry — design 21 §6.5 缺陷① fixed.
    const gated = await runLocalDshPlugin(dir, dir, 'add', 'file:/tmp/picked-folder', { allowFileSpec: true })
    assert.equal(gated.ok, false)
    assert.match(gated.error ?? '', /no dsh CLI entry found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shouldPreferPinnedRuntimeLockfile: 只在活动运行时与内建线同版时才用内建锚（design 18 §3.6 / 21 §6.11.1）', () => {
  // The pin describes the built-in line. A user-selected runtime — or an
  // env-provided tree — is another dsh version whose own lockfile is the right
  // fact source: judging its profile against the pin's versions fails a
  // consistent tree loudly (2026-12 review fixture: rc.3 profile vs rc.2 pin).
  assert.equal(shouldPreferPinnedRuntimeLockfile('0.1.5-rc.2', '0.1.5-rc.2'), true)
  assert.equal(shouldPreferPinnedRuntimeLockfile('0.1.5-rc.3', '0.1.5-rc.2'), false,
    'another runtime line must use its own lockfile closure')
  assert.equal(shouldPreferPinnedRuntimeLockfile('0.1.5-rc.1', '0.1.5-rc.2'), false,
    'a prerelease difference is a different line (string equality, like sameGeneration)')
  assert.equal(shouldPreferPinnedRuntimeLockfile(null, '0.1.5-rc.2'), false,
    'an unreadable active generation must not guess')
  assert.equal(shouldPreferPinnedRuntimeLockfile('0.1.5-rc.2', null), false,
    'an unreadable pinned generation must not guess')
  assert.equal(shouldPreferPinnedRuntimeLockfile(null, null), false)
})
