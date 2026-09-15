/**
 * plugin-sync — part 2: remotePluginList — cat-output parsing, ENOENT →
 * profileExists:false, loud ssh failures, the registry-driven chamber probe
 * (half-injected states, git-worktree live probe) and manifest row shape.
 *
 * Sibling parts: plugin-sync.test.ts, plugin-sync-apply.test.ts,
 * plugin-sync-seed.test.ts, plugin-sync-renderer-projection.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardPluginMutation, sshProtectionFacts, ARCHIVE_CLEANUP_PACKAGE_NAME, CLIENT_GRAPH_PACKAGE_NAME, GIT_WORKTREE_PACKAGE_NAME, OPEN_IN_PACKAGE_NAME, remotePluginList } from '../../plugin-sync.ts'
import type { ExecFn, ExecResult } from '../../plugin-sync.ts'
import { chamberPackageOf, chamberFacts } from '../support/chamber-projection.ts'

/** Compact projection of a manifest's read-face rows (design 21 §6.11.5):
 *  `name:role:protected[:spec]` order-preserving, so the union semantics stay
 *  visible (composition/seed rows exist even when `dependencies` is empty). */
const rowShape = (rows: readonly { name: string; role: string; protected: boolean; spec: string | null }[]): string[] =>
  rows.map(row => `${row.name}:${row.role}:${row.protected}${row.spec === null ? '' : `:${row.spec}`}`)

/** Assert a remotePluginList result's manifest minus `rows`, plus its rows. */
function assertRemoteManifest(
  result: Awaited<ReturnType<typeof remotePluginList>>,
  expected: { ok: true; manifest: Record<string, unknown> },
  expectedRows: string[],
): void {
  if (!result.ok) assert.fail(`expected ok, got ${result.error}`)
  const { rows, ...manifest } = result.manifest
  assert.deepEqual({ ok: true, manifest }, expected)
  assert.deepEqual(rowShape(rows), expectedRows)
}

function ok(stdout?: string): ExecResult {
  return { ok: true, status: { phase: 'ready' }, stdout }
}

function err(error: string): ExecResult {
  return { ok: false, error }
}

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
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js')) {
        return ok('export const graph = 1\n')
      }
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-chamber-seed-client-graph"}')
      }
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')) {
        return ok('export const git = 1\n')
      }
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
      }
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup')) {
        return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      }
      if (path.endsWith('/cordis.patch.yml')) {
        // A fully-seeded machine: BOTH chamber boot rows present.
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assertRemoteManifest(result, {
    ok: true,
    manifest: {
      dependencies: { foo: '^1.0.0' },
      bundles: ['foo'],
      profileExists: true,
      error: undefined,
      chamber: { ok: true, packages: [
        { insertId: 'client-graph', name: CLIENT_GRAPH_PACKAGE_NAME, probe: 'clientGraph/graph', installed: true, patched: true, version: null, live: null },
        { insertId: 'git-worktree', name: GIT_WORKTREE_PACKAGE_NAME, probe: 'gitWorktree/previewCreate', installed: true, patched: true, version: null, live: null },
        { insertId: 'archive-cleanup', name: ARCHIVE_CLEANUP_PACKAGE_NAME, probe: 'archiveCleanup/probe', installed: false, patched: false, version: null, live: null },
        { insertId: 'open-in', name: OPEN_IN_PACKAGE_NAME, probe: 'openInApp/probe', installed: false, patched: false, version: null, live: null, localOnly: true },
      ] },
    },
  }, [
    // 行集 = 远端 profile 自己的依赖（2026-09 修订）：B₀/S 只分类，不再造行。
    'foo:layer:false:^1.0.0',
  ])
})

test('remotePluginList: ssh rows keep `protected === name ∈ P` (the install conservatism is a write-face/capability fact)', async () => {
  // design 21 §6.11.5 (2026-12 review revision): `protected` means EXACTLY "the write
  // face refuses both directions" (name ∈ P = B₀ ∪ S here). An official-scope row that
  // is NOT in P stays `protected: false` because the ssh REMOVE face allows removing it
  // (remove judges B₀ ∪ S only) — marking it protected would hide a working action and
  // print a false "protected by the composition" hint. The INSTALL conservatism is
  // enforced by the write face (and kept out of the reconcile batch by the UI's ssh
  // transport filter), not by a read-face lie.
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) {
        return ok(JSON.stringify({
          dependencies: {
            'third-party-pkg': '^1.0.0',
            '@deepseek-ai/dsh-experimental-x': '0.1.5-rc.2',
            '@deepseek-ai/dsh-session': '^0.1.5-rc.2',
          },
          dsh: { profile: { bundles: ['third-party-pkg'] } },
        }))
      }
      return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
    }
    return err(`unexpected ${action}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const byName = new Map(result.manifest.rows.map(row => [row.name, row]))
  assert.equal(byName.get('third-party-pkg')?.protected, false, 'third-party rows stay actionable')
  assert.equal(byName.get('third-party-pkg')?.role, 'layer')
  // Official scope, NOT part of B₀ ∪ S ⇒ not protected (removable; install refused).
  assert.equal(byName.get('@deepseek-ai/dsh-experimental-x')?.protected, false)
  assert.equal(byName.get('@deepseek-ai/dsh-session')?.protected, false)
  // The write face is what refuses the official install — asserted here so the
  // asymmetry ("read face offers the remove, write face refuses the install") is
  // pinned rather than implied.
  const install = guardPluginMutation({
    op: 'install', name: '@deepseek-ai/dsh-experimental-x', version: '0.1.5-rc.2', facts: sshProtectionFacts(),
  })
  assert.equal(install.kind, 'refuse')
  assert.equal(install.kind === 'refuse' ? install.code : null, 'protected')
  const remove = guardPluginMutation({
    op: 'remove', name: '@deepseek-ai/dsh-experimental-x', version: null, facts: sshProtectionFacts(),
  })
  assert.equal(remove.kind, 'allow', 'removing a stray official copy is restorative and stays allowed')
})

test('remotePluginList: ENOENT → profileExists:false, ssh failure → {ok:false}', async () => {
  const enoent: ExecFn = async () => err('cat: /home/u/.dsh/profiles/web/package.json: No such file or directory')
  assertRemoteManifest(
    await remotePluginList(enoent, { id: 's1', remoteDshHome: null }),
    {
      ok: true,
      manifest: {
        dependencies: {},
        bundles: [],
        profileExists: false,
        chamber: { ok: true, packages: [
        { insertId: 'client-graph', name: CLIENT_GRAPH_PACKAGE_NAME, probe: 'clientGraph/graph', installed: false, patched: false, version: null, live: null },
        { insertId: 'git-worktree', name: GIT_WORKTREE_PACKAGE_NAME, probe: 'gitWorktree/previewCreate', installed: false, patched: false, version: null, live: null },
        { insertId: 'archive-cleanup', name: ARCHIVE_CLEANUP_PACKAGE_NAME, probe: 'archiveCleanup/probe', installed: false, patched: false, version: null, live: null },
        { insertId: 'open-in', name: OPEN_IN_PACKAGE_NAME, probe: 'openInApp/probe', installed: false, patched: false, version: null, live: null, localOnly: true },
      ] },
      },
    },
    // 未初始化的远端 profile：没有依赖 ⇒ 没有行（2026-09 修订后 B₀/S 不造行）。
    [],
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
  const zhEnoent: ExecFn = async () => err('run command failed (exit 1): cat: /home/zeyu/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-git-worktree/package.json: 没有那个文件或目录')
  assertRemoteManifest(
    await remotePluginList(zhEnoent, { id: 's1', remoteDshHome: null }),
    {
      ok: true,
      manifest: {
        dependencies: {},
        bundles: [],
        profileExists: false,
        chamber: { ok: true, packages: [
        { insertId: 'client-graph', name: CLIENT_GRAPH_PACKAGE_NAME, probe: 'clientGraph/graph', installed: false, patched: false, version: null, live: null },
        { insertId: 'git-worktree', name: GIT_WORKTREE_PACKAGE_NAME, probe: 'gitWorktree/previewCreate', installed: false, patched: false, version: null, live: null },
        { insertId: 'archive-cleanup', name: ARCHIVE_CLEANUP_PACKAGE_NAME, probe: 'archiveCleanup/probe', installed: false, patched: false, version: null, live: null },
        { insertId: 'open-in', name: OPEN_IN_PACKAGE_NAME, probe: 'openInApp/probe', installed: false, patched: false, version: null, live: null, localOnly: true },
      ] },
      },
    },
    // 同上：ENOENT 的远端 profile 没有依赖，行集为空。
    [],
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
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/package.json')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/dist/index.js')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-client-graph"}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
      // initProfile template: comments + empty list → the seed would rewrite it.
      if (path.endsWith('/cordis.patch.yml')) return ok('# comment\n[]')
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(chamberFacts(result.manifest.chamber), {
    [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: false, version: null, live: null },
    [GIT_WORKTREE_PACKAGE_NAME]: { installed: true, patched: false, version: null, live: null },
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [OPEN_IN_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
  })
  }
})

test('remotePluginList: chamber probe ssh failure is loud, never a silent "not injected"', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.endsWith('/cordis.patch.yml')) return ok('# comment\n[]')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/package.json')) {
        return err('the ssh exec could not reach the host (exit 255)')
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.manifest.chamber.ok, false)
    assert.match(result.manifest.chamber.error, /dsh-chamber-seed-client-graph probe failed/)
  }
})

test('remotePluginList: chamber probe — package.json present but dist/index.js missing = NOT installed (two-file definition)', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/package.json')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/dist/index.js')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-client-graph"}')
            if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')) return ok('export const git = 1\n')
            if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
      // dist/index.js genuinely missing: a package.json alone is a
      // half-installed module A (the boot row could not resolve).
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')) {
        return ok('export const git = 1\n')
      }
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
      }
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js')) {
        return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      }
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(chamberFacts(result.manifest.chamber), {
    [CLIENT_GRAPH_PACKAGE_NAME]: { installed: false, patched: true, version: null, live: null },
    [GIT_WORKTREE_PACKAGE_NAME]: { installed: true, patched: false, version: null, live: null },
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [OPEN_IN_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
  })
  }
})

test('remotePluginList: chamber probe ssh failure on dist/index.js is loud, never a silent "not injected"', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.endsWith('/cordis.patch.yml')) return ok('# comment\n[]')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-client-graph"}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js')) {
        return err('the ssh exec could not reach the host (exit 255)')
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null })
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.manifest.chamber.ok, false)
    assert.ok(result.manifest.chamber.ok === false && /dsh-chamber-seed-client-graph probe failed/.test(result.manifest.chamber.error))
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
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph')) {
        return err('run command failed (exit 1): [ssh material redacted]: No such file or directory')
      }
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree')) {
        return err('run command failed (exit 1): [ssh material redacted]: No such file or directory')
      }
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup')) {
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
    assert.deepEqual(chamberFacts(result.manifest.chamber), {
    [CLIENT_GRAPH_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [GIT_WORKTREE_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [OPEN_IN_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
  })
  }
})

test('remotePluginList: chamber probe parses module A version and reports live-effect via liveProbe', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/package.json')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/dist/index.js')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-chamber-seed-client-graph","version":"0.1.2"}')
      }
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const gitSeeded = (live: boolean | null) => ({ installed: true, patched: true, version: null, live })
  // live = true → the RUNNING instance has loaded the module (已生效).
  const live = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, { liveProbe: async () => true })
  assert.ok(live.ok)
  if (live.ok) {
    assert.deepEqual(chamberFacts(live.manifest.chamber), {
    [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: true, version: '0.1.2', live: true },
    [GIT_WORKTREE_PACKAGE_NAME]: gitSeeded(true),
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [OPEN_IN_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
  })
  }
  // live = false → injected but restart still pending (重启后生效).
  const pending = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, { liveProbe: async () => false })
  assert.ok(pending.ok)
  if (pending.ok) {
    assert.deepEqual(chamberFacts(pending.manifest.chamber), {
    [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: true, version: '0.1.2', live: false },
    [GIT_WORKTREE_PACKAGE_NAME]: gitSeeded(false),
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [OPEN_IN_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
  })
  }
  // live = null → the desktop could not classify (no ready tunnel): the UI
  // renders 生效状态未知 — never a guessed claim.
  const unknown = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, { liveProbe: async () => null })
  assert.ok(unknown.ok)
  if (unknown.ok) {
    assert.deepEqual(chamberFacts(unknown.manifest.chamber), {
    [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: true, version: '0.1.2', live: null },
    [GIT_WORKTREE_PACKAGE_NAME]: gitSeeded(null),
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [OPEN_IN_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
  })
  }
  // A version-less seeded package.json → version:null (never a guessed one).
  const versionless: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/package.json')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/dist/index.js')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-client-graph"}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const noVersion = await remotePluginList(versionless, { id: 's1', remoteDshHome: null }, { liveProbe: async () => true })
  assert.ok(noVersion.ok)
  if (noVersion.ok) {
    assert.equal(noVersion.manifest.chamber.ok, true)
    assert.equal(chamberPackageOf(noVersion.manifest.chamber, CLIENT_GRAPH_PACKAGE_NAME).version, null)
  }
})

test('remotePluginList: git-worktree live is probed SEPARATELY — host-graph live does not prove the git row loaded', async () => {
  // The user-reported dead end: host-graph live from an older boot (its row
  // loaded) while the git-worktree row was seeded LATER (files + insert
  // written at ready, but the running instance still boots the old layer) —
  // the git RPC 404s and the sidebar shows no git surface. The probe must
  // report the git-worktree ROW's live === false independently of the
  // client-graph row's live state.
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/package.json')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/dist/index.js')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-client-graph"}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  // host-graph live, git-worktree NOT live → the exact "已生效 + 重启后生效"
  // pair the UI must be able to render (and gate its restart button on).
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, {
    liveProbe: async descriptor => descriptor.insert.name !== GIT_WORKTREE_PACKAGE_NAME,
  })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(chamberFacts(result.manifest.chamber), {
    [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: true, version: null, live: true },
    [GIT_WORKTREE_PACKAGE_NAME]: { installed: true, patched: true, version: null, live: false },
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [OPEN_IN_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
  })
  }
  // Both live → 已生效 for both.
  const bothLive = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, {
    liveProbe: async () => true,
  })
  assert.ok(bothLive.ok)
  if (bothLive.ok) {
    assert.equal(bothLive.manifest.chamber.ok, true)
    assert.equal(chamberPackageOf(bothLive.manifest.chamber, GIT_WORKTREE_PACKAGE_NAME).live, true)
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
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/package.json')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/dist/index.js')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js')) return ok('export const graph = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-client-graph"}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')) return ok('export const git = 1\n')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
      if (path.endsWith('/cordis.patch.yml')) {
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, {
    liveProbe: async descriptor => {
      if (descriptor.insert.name === GIT_WORKTREE_PACKAGE_NAME) throw new Error('must not run: the git row is not patched, so it cannot be live')
      return true
    },
  })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(chamberFacts(result.manifest.chamber), {
    [CLIENT_GRAPH_PACKAGE_NAME]: { installed: true, patched: true, version: null, live: true },
    [GIT_WORKTREE_PACKAGE_NAME]: { installed: true, patched: false, version: null, live: null },
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [OPEN_IN_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
  })
  }
})

test('remotePluginList: liveProbe is NOT consulted when the injection is half-present (cannot be live by definition)', async () => {
  let probed = false
  let gitProbed = false
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path.endsWith('/profiles/web/package.json')) return ok('{}')
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/package.json')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-archive-cleanup/dist/index.js')) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/package.json')) return ok('{"name":"@dsh-chamber/dsh-chamber-seed-client-graph","version":"0.1.2"}')
      // dist/index.js missing → installed:false.
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')) {
        return ok('export const git = 1\n')
      }
      if (path.includes('@dsh-chamber/dsh-chamber-seed-git-worktree/package.json')) {
        return ok('{"name":"@dsh-chamber/dsh-chamber-seed-git-worktree"}')
      }
      if (path.includes('@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js')) {
        return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      }
      if (path.endsWith('/cordis.patch.yml')) {
        // The git-worktree boot row is ALSO absent (a stale patch from before
        // the git package existed): both packages are half-present, so neither
        // live probe may run.
        return ok("- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n")
      }
    }
    return err(`unexpected cat ${payload?.argv?.[0]}`)
  }
  const result = await remotePluginList(exec, { id: 's1', remoteDshHome: null }, {
    liveProbe: async (descriptor) => {
      if (descriptor.insert.name === GIT_WORKTREE_PACKAGE_NAME) gitProbed = true
      else probed = true
      return true
    },
  })
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(chamberFacts(result.manifest.chamber), {
    [CLIENT_GRAPH_PACKAGE_NAME]: { installed: false, patched: true, version: '0.1.2', live: null },
    [GIT_WORKTREE_PACKAGE_NAME]: { installed: true, patched: false, version: null, live: null },
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
    [OPEN_IN_PACKAGE_NAME]: { installed: false, patched: false, version: null, live: null },
  })
  }
  assert.equal(probed, false, 'a half-injected module is never "live" — the probe is skipped')
  assert.equal(gitProbed, false, 'the git probe is skipped while the module is half-present')
})
