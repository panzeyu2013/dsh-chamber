/**
 * Todo 09 module B unit tests — the control-plane host-graph seed:
 *   - buildPatchOverlay: canonical content, idempotency (in-sync skip),
 *     0600 perms, and self-heal of a drifted overlay;
 *   - ensureHostGraphPackage: first copy, in-sync skip, content-change
 *     overwrite, absent-source skip, 0600 perms, and fail-loud on a source
 *     that passes the caller's dist gate but misses a declared file;
 *   - webProfileArgs: --patch injection (position before the web flags) and
 *     absent/empty handling;
 *   - createLocalConnection: the resolved patchPath reaches the spawnDshFn —
 *     initial spawn AND the restart path (the thunk is re-resolved per
 *     spawn, which is what self-heals a pruned seed);
 *   - createControlPlane.start(): the seed orchestration gate — dist present
 *     → package + overlay materialized; dist absent → v4 baseline (no seed,
 *     no overlay).
 * Run directly: node packages/control-plane/test/host-graph-seed.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPatchOverlay,
  ensureHostPackage,
  ensureHostGraphPackage,
  ensureSeedPackage,
  missingHostPackageInserts,
  HOST_GIT_WORKTREE_INSERT,
  HOST_GIT_WORKTREE_PACKAGE_NAME,
  HOST_GRAPH_INSERT,
  HOST_GRAPH_PACKAGE_NAME,
  HOST_GRAPH_PATCH_FILENAME,
} from '../src/host-graph-seed.ts'
import { webProfileArgs, DEFAULT_DSH_START_PORT } from '../src/spawn-dsh.ts'
import { createLocalConnection } from '../src/local-connection.ts'
import { createControlPlane } from '../src/index.ts'
import type { SpawnedDsh } from '../src/local-connection.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

/**
 * The canonical overlay content the seed writes (mirror of the module).
 *
 * Validation note (④): the assertions below are byte-exact against the
 * module's canonical overlay renderer output (renderPatchOverlay over the
 * HOST_GRAPH_INSERT row) — the strongest check available here, because the
 * overlay's boot-time authority
 * (@deepseek-ai/dsh-app-boot loadOverlayPatches → parsePatchList, a YAML
 * parser over the top-level loader-patch array) is NOT importable from this
 * test: control-plane's runtime node graph resolves neither
 * @deepseek-ai/dsh-app-boot nor a yaml package (adding one would violate the
 * no-new-runtime-deps rule), and dsh itself exercises the parser at host
 * boot. The format contract (top-level YAML array of
 * `{insert: [{id, name}]}` entries) is asserted structurally here: one
 * `- insert:` entry carrying exactly the id/name lines.
 */
const EXPECTED_OVERLAY = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-host-client-graph'
`

const EXPECTED_BOTH_OVERLAY = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-host-client-graph'
    - id: git-worktree
      name: '@dsh-chamber/dsh-host-git-worktree'
`

function tempDir(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-host-graph-seed-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The seeded package location inside a managed dsh home. */
function seedTarget(dshHome: string) {
  return join(dshHome, 'profiles', 'web', 'node_modules', HOST_GRAPH_PACKAGE_NAME)
}

// ---------------------------------------------------------------------------
// buildPatchOverlay
// ---------------------------------------------------------------------------

test('buildPatchOverlay writes the canonical overlay once and skips in-sync rewrites', t => {
  const dir = tempDir(t)
  const path = join(dir, HOST_GRAPH_PATCH_FILENAME)
  const first = buildPatchOverlay(dir)
  assert.equal(first, path)
  assert.equal(readFileSync(path, 'utf8'), EXPECTED_OVERLAY)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const mtime = statSync(path).mtimeMs
  const second = buildPatchOverlay(dir)
  assert.equal(second, path)
  assert.equal(statSync(path).mtimeMs, mtime, 'an in-sync overlay is not rewritten')
})

test('buildPatchOverlay self-heals a drifted overlay back to the canonical content', t => {
  const dir = tempDir(t)
  buildPatchOverlay(dir)
  const path = join(dir, HOST_GRAPH_PATCH_FILENAME)
  writeFileSync(path, '- insert: []\n', { mode: 0o600 })
  buildPatchOverlay(dir)
  assert.equal(readFileSync(path, 'utf8'), EXPECTED_OVERLAY)
})

test('buildPatchOverlay rejects a symlinked state root without writing through it', t => {
  const anchor = tempDir(t)
  const outside = tempDir(t)
  const stateDir = join(anchor, 'state')
  try {
    symlinkSync(outside, stateDir, 'dir')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }
  assert.throws(() => buildPatchOverlay(stateDir), /not a real directory/)
  assert.equal(existsSync(join(outside, HOST_GRAPH_PATCH_FILENAME)), false)
})

test('buildPatchOverlay rejects a preplanted leaf symlink and leaves its target untouched', t => {
  const dir = tempDir(t)
  const path = join(dir, HOST_GRAPH_PATCH_FILENAME)
  const victim = join(dir, 'overlay-victim.yml')
  const victimText = EXPECTED_OVERLAY
  writeFileSync(victim, victimText)
  try {
    symlinkSync(victim, path, 'file')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }
  assert.throws(() => buildPatchOverlay(dir), /private state leaf is unsafe/)
  assert.equal(readFileSync(victim, 'utf8'), victimText)
})

test('buildPatchOverlay renders exactly the available host package rows', t => {
  const dir = tempDir(t)
  const path = buildPatchOverlay(dir, [HOST_GRAPH_INSERT, HOST_GIT_WORKTREE_INSERT])
  assert.equal(readFileSync(path, 'utf8'), EXPECTED_BOTH_OVERLAY)
  buildPatchOverlay(dir, [HOST_GIT_WORKTREE_INSERT])
  const gitOnly = readFileSync(path, 'utf8')
  assert.ok(gitOnly.includes('id: git-worktree'))
  assert.ok(!gitOnly.includes('id: client-graph'), 'an unavailable package never leaves a dangling row')
})

test('missingHostPackageInserts reuses one exact profile row and returns only missing rows', () => {
  const profile = `- insert:
    - id: client-graph
      name: '${HOST_GRAPH_PACKAGE_NAME}'
`
  assert.deepEqual(
    missingHostPackageInserts(profile, [HOST_GRAPH_INSERT, HOST_GIT_WORKTREE_INSERT]),
    [HOST_GIT_WORKTREE_INSERT],
  )
})

test('missingHostPackageInserts rejects a loader id bound to another package', () => {
  const profile = `- insert:
    - id: git-worktree
      name: '@dsh-chamber/not-the-git-service'
`
  assert.throws(
    () => missingHostPackageInserts(profile, [HOST_GIT_WORKTREE_INSERT]),
    /already bound to a different package/,
  )
})

test('missingHostPackageInserts rejects a chamber package mounted under another id', () => {
  const profile = `- insert:
    - id: another-git-service
      name: '${HOST_GIT_WORKTREE_PACKAGE_NAME}'
`
  assert.throws(
    () => missingHostPackageInserts(profile, [HOST_GIT_WORKTREE_INSERT]),
    /already mounted under a different loader id/,
  )
})

test('missingHostPackageInserts rejects duplicate exact loader identities', () => {
  const profile = `- insert:
    - id: git-worktree
      name: '${HOST_GIT_WORKTREE_PACKAGE_NAME}'
    - id: git-worktree
      name: '${HOST_GIT_WORKTREE_PACKAGE_NAME}'
`
  assert.throws(
    () => missingHostPackageInserts(profile, [HOST_GIT_WORKTREE_INSERT]),
    /duplicate loader identity/,
  )
})

test('missingHostPackageInserts never pairs id/name across name-first sibling rows', () => {
  const crossed = `- insert:
    - id: git-worktree
      name: '@example/not-chamber'
    - name: '${HOST_GIT_WORKTREE_PACKAGE_NAME}'
      id: another-git-service
`
  assert.throws(
    () => missingHostPackageInserts(crossed, [HOST_GIT_WORKTREE_INSERT]),
    /already bound|already mounted|duplicate loader identity/,
  )
})

test('missingHostPackageInserts accepts an exact name-first row', () => {
  const profile = `- insert:
    - name: '${HOST_GIT_WORKTREE_PACKAGE_NAME}'
      id: git-worktree
`
  assert.deepEqual(missingHostPackageInserts(profile, [HOST_GIT_WORKTREE_INSERT]), [])
})

test('missingHostPackageInserts does not use a nested config name to complete a loader row', () => {
  const nested = `- insert:
    - id: git-worktree
      name: '@example/not-chamber'
      config:
        name: '${HOST_GIT_WORKTREE_PACKAGE_NAME}'
`
  assert.throws(
    () => missingHostPackageInserts(nested, [HOST_GIT_WORKTREE_INSERT]),
    /already bound|duplicate loader identity/,
  )
})

test('missingHostPackageInserts keeps crossed inline-flow mappings separate', () => {
  const crossed = `- insert: [{ id: git-worktree, name: '@example/not-chamber' }, { id: other, name: '${HOST_GIT_WORKTREE_PACKAGE_NAME}' }]
`
  assert.throws(
    () => missingHostPackageInserts(crossed, [HOST_GIT_WORKTREE_INSERT]),
    /already bound|already mounted|duplicate loader identity/,
  )
})

// ---------------------------------------------------------------------------
// ensureHostGraphPackage
// ---------------------------------------------------------------------------

/** Stage a fake module-A package (package.json + dist/index.js). */
function stageSource(t: any, distContent = 'export default {}\n') {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME, version: '0.0.0', main: 'dist/index.js' }) + '\n')
  writeFileSync(join(dir, 'dist', 'index.js'), distContent)
  return dir
}

test('ensureHostGraphPackage copies package.json + dist/index.js once, then skips in-sync copies', t => {
  const dshHome = tempDir(t)
  const source = stageSource(t, 'export const v = 1\n')
  const first = ensureHostGraphPackage(dshHome, source)
  assert.equal(first, true)
  const target = seedTarget(dshHome)
  assert.equal(
    readFileSync(join(target, 'package.json'), 'utf8'),
    JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME, version: '0.0.0', main: 'dist/index.js' }) + '\n',
  )
  assert.equal(readFileSync(join(target, 'dist', 'index.js'), 'utf8'), 'export const v = 1\n')
  assert.equal(statSync(join(target, 'dist', 'index.js')).mode & 0o777, 0o600)
  const mtime = statSync(join(target, 'dist', 'index.js')).mtimeMs
  const second = ensureHostGraphPackage(dshHome, source)
  assert.equal(second, false)
  assert.equal(statSync(join(target, 'dist', 'index.js')).mtimeMs, mtime, 'an in-sync seed is not rewritten')
})

test('ensureHostGraphPackage overwrites a drifted dist when the source content changes', t => {
  const dshHome = tempDir(t)
  const source = stageSource(t, 'export const v = 1\n')
  ensureHostGraphPackage(dshHome, source)
  writeFileSync(join(source, 'dist', 'index.js'), 'export const v = 2\n')
  const wrote = ensureHostGraphPackage(dshHome, source)
  assert.equal(wrote, true)
  assert.equal(readFileSync(join(seedTarget(dshHome), 'dist', 'index.js'), 'utf8'), 'export const v = 2\n')
})

test('ensureHostGraphPackage rejects a symlinked profile node_modules anchor without writing through it', t => {
  const dshHome = tempDir(t)
  const source = stageSource(t, 'export const safe = true\n')
  const outside = tempDir(t)
  const sentinel = join(outside, 'sentinel')
  writeFileSync(sentinel, 'DO NOT TOUCH')
  const modulesDir = join(dshHome, 'profiles', 'web', 'node_modules')
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
  try {
    symlinkSync(outside, modulesDir, 'dir')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }
  assert.throws(() => ensureHostGraphPackage(dshHome, source), /not a real directory/)
  assert.equal(readFileSync(sentinel, 'utf8'), 'DO NOT TOUCH')
  assert.equal(existsSync(join(outside, '@dsh-chamber')), false)
})

test('ensureHostGraphPackage rejects a symlinked chamber scope without creating the package outside the profile', t => {
  const dshHome = tempDir(t)
  const source = stageSource(t, 'export const safe = true\n')
  const outside = tempDir(t)
  const sentinel = join(outside, 'sentinel')
  writeFileSync(sentinel, 'DO NOT TOUCH')
  const modulesDir = join(dshHome, 'profiles', 'web', 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  try {
    symlinkSync(outside, join(modulesDir, '@dsh-chamber'), 'dir')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }
  assert.throws(() => ensureHostGraphPackage(dshHome, source), /not a real directory/)
  assert.equal(readFileSync(sentinel, 'utf8'), 'DO NOT TOUCH')
  assert.equal(existsSync(join(outside, 'dsh-host-client-graph')), false)
})

test('ensureHostGraphPackage rejects a symlinked chamber package directory without writing outside the profile', t => {
  const dshHome = tempDir(t)
  const source = stageSource(t, 'export const safe = true\n')
  const outside = tempDir(t)
  const sentinel = join(outside, 'sentinel')
  writeFileSync(sentinel, 'DO NOT TOUCH')
  const target = seedTarget(dshHome)
  mkdirSync(join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-chamber'), { recursive: true })
  try {
    symlinkSync(outside, target, 'dir')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }
  assert.throws(() => ensureHostGraphPackage(dshHome, source), /not a real directory/)
  assert.equal(readFileSync(sentinel, 'utf8'), 'DO NOT TOUCH')
  assert.equal(existsSync(join(outside, 'package.json')), false)
  assert.equal(existsSync(join(outside, 'dist', 'index.js')), false)
})

test('ensureHostGraphPackage retains the ordinary source boundary for a symlinked package source', t => {
  const dshHome = tempDir(t)
  const source = stageSource(t, 'export const linkedSource = true\n')
  const sourceLink = join(tempDir(t), 'source-link')
  try {
    symlinkSync(source, sourceLink, 'dir')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }
  assert.equal(ensureHostGraphPackage(dshHome, sourceLink), true)
  assert.equal(
    readFileSync(join(seedTarget(dshHome), 'dist', 'index.js'), 'utf8'),
    'export const linkedSource = true\n',
  )
})

test('ensureHostGraphPackage returns false without touching the profile when the source package is absent', t => {
  const dshHome = tempDir(t)
  assert.equal(ensureHostGraphPackage(dshHome, join(dshHome, 'no-such-package')), false)
  assert.equal(existsSync(seedTarget(dshHome)), false)
})

test('ensureHostPackage reuses the seed path for the Git worktree host package', t => {
  const dshHome = tempDir(t)
  const source = tempDir(t)
  mkdirSync(join(source, 'dist'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: HOST_GIT_WORKTREE_PACKAGE_NAME }))
  writeFileSync(join(source, 'dist', 'index.js'), 'export default {}\n')
  assert.equal(ensureHostPackage(dshHome, HOST_GIT_WORKTREE_PACKAGE_NAME, source), true)
  assert.equal(
    readFileSync(join(dshHome, 'profiles', 'web', 'node_modules', HOST_GIT_WORKTREE_PACKAGE_NAME, 'dist', 'index.js'), 'utf8'),
    'export default {}\n',
  )
})

// ---------------------------------------------------------------------------
// webProfileArgs (--patch injection)
// ---------------------------------------------------------------------------

test('webProfileArgs keeps the v4 flag set when no patch overlay is given', () => {
  assert.deepEqual(webProfileArgs(DEFAULT_DSH_START_PORT), [
    '--profile', 'web', '--host', '127.0.0.1', '--port', String(DEFAULT_DSH_START_PORT),
    '--trusted-host', `127.0.0.1:${DEFAULT_DSH_START_PORT}`,
  ])
  // Empty string is treated as absent (callers may resolve a nullable config).
  assert.deepEqual(webProfileArgs(DEFAULT_DSH_START_PORT, ''), webProfileArgs(DEFAULT_DSH_START_PORT))
})

test('webProfileArgs injects --patch before the web app flags when a patch overlay is given', () => {
  assert.deepEqual(webProfileArgs(DEFAULT_DSH_START_PORT + 1, '/tmp/dsh-chamber-graph.patch.yml'), [
    '--profile', 'web', '--patch', '/tmp/dsh-chamber-graph.patch.yml',
    '--host', '127.0.0.1', '--port', String(DEFAULT_DSH_START_PORT + 1),
    '--trusted-host', `127.0.0.1:${DEFAULT_DSH_START_PORT + 1}`,
  ])
})

// ---------------------------------------------------------------------------
// createLocalConnection: the resolved patchPath reaches every spawn
// ---------------------------------------------------------------------------

function mockSpawned(): SpawnedDsh {
  return { child: { on() {}, exitCode: null }, port: DEFAULT_DSH_START_PORT, stop: async () => {} }
}

const healthyLocalConnectionDeps = {
  spawnDsh: async () => mockSpawned(),
  describeCapabilities: async () => ({ value: { attachedSessions: 0 }, cachedAt: Date.now() }),
}

test('createLocalConnection passes the resolved patchPath to the spawn fn', async t => {
  const dir = tempDir(t)
  const spawnOptions: Array<{ patchPath?: string | null }> = []
  const connection = createLocalConnection({
    stateDir: dir,
    dshHome: join(dir, 'dsh-home'),
    dshWorkspacePath: join(dir, 'dsh'),
    logger: silentLogger,
    options: { patchPath: () => '/tmp/dsh-chamber-graph.patch.yml' },
    deps: {
      spawnDsh: async (options: { patchPath?: string | null }) => {
        spawnOptions.push(options)
        return mockSpawned()
      },
      describeCapabilities: async () => ({ value: { attachedSessions: 0 }, cachedAt: Date.now() }),
    },
  })
  try {
    await connection.start()
    assert.equal(spawnOptions.length, 1)
    assert.equal(spawnOptions[0].patchPath, '/tmp/dsh-chamber-graph.patch.yml')
  } finally {
    await connection.stop()
  }
})

/** A mock spawn whose child exposes an exit trigger for the restart path. */
function mockSpawnedWithExit(): SpawnedDsh & { fireExit(): void } {
  let exitListener: ((code: number | null, signal: string | null) => void) | null = null
  const spawned = {
    child: {
      on(event: string, listener: (...args: any[]) => void) {
        if (event === 'exit') exitListener = listener
      },
      exitCode: null,
    },
    port: DEFAULT_DSH_START_PORT,
    stop: async () => {},
    fireExit() {
      exitListener?.(1, null)
    },
  }
  return spawned
}

/** Poll until check() holds; throws on timeout (restart spawns are async). */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met within timeout')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('createLocalConnection re-resolves the patchPath thunk on the restart path', async t => {
  const dir = tempDir(t)
  const spawnOptions: Array<{ patchPath?: string | null }> = []
  const spawnedList: Array<ReturnType<typeof mockSpawnedWithExit>> = []
  let patchValue: string | null = '/tmp/first.yml'
  const connection = createLocalConnection({
    stateDir: dir,
    dshHome: join(dir, 'dsh-home'),
    dshWorkspacePath: join(dir, 'dsh'),
    logger: silentLogger,
    options: { patchPath: () => patchValue },
    deps: {
      spawnDsh: async (options: { patchPath?: string | null }) => {
        spawnOptions.push(options)
        const spawned = mockSpawnedWithExit()
        spawnedList.push(spawned)
        return spawned
      },
      describeCapabilities: async () => ({ value: { attachedSessions: 0 }, cachedAt: Date.now() }),
    },
  })
  try {
    await connection.start()
    assert.equal(spawnOptions.length, 1)
    assert.equal(spawnOptions[0].patchPath, '/tmp/first.yml')
    // A profile-internal pnpm operation pruned the seed between spawns: the
    // thunk's value changes, and the restart must resolve it AGAIN (this is
    // the seed-per-spawn self-heal — the plane re-seeds before every spawn).
    patchValue = '/tmp/second.yml'
    spawnedList[0].fireExit()
    await waitFor(() => spawnOptions.length >= 2)
    assert.equal(spawnOptions[1].patchPath, '/tmp/second.yml')
    assert.equal(connection.getState(), 'ready')
  } finally {
    await connection.stop()
  }
})

// ---------------------------------------------------------------------------
// createControlPlane local spawn: the seed orchestration gate (dist present /
// absent — a fake hostGraphPackageSourceDir covers both branches). plane.start
// only reaps writers; DSH_HOME remains untouched until the fenced spawn path.
// ---------------------------------------------------------------------------

test('createControlPlane.startLocal() seeds the host package and materializes the overlay when dist/index.js exists', async t => {
  const dir = tempDir(t)
  const source = stageSource(t, 'export const v = 1\n')
  const plane = createControlPlane({
    stateDir: dir,
    port: 0,
    dshWorkspacePath: join(dir, 'dsh'),
    hostGraphPackageSourceDir: source,
    hostGitWorktreePackageSourceDir: join(dir, 'no-git-package'),
    logger: silentLogger,
    localConnectionDeps: healthyLocalConnectionDeps,
  })
  try {
    await plane.start()
    assert.equal(existsSync(join(dir, HOST_GRAPH_PATCH_FILENAME)), false, 'plane start leaves DSH_HOME seed-free')
    await plane.startLocal()
    // The --patch overlay materialized under the state root…
    assert.equal(readFileSync(join(dir, HOST_GRAPH_PATCH_FILENAME), 'utf8'), EXPECTED_OVERLAY)
    assert.equal(statSync(join(dir, HOST_GRAPH_PATCH_FILENAME)).mode & 0o777, 0o600)
    // …and module A distributed into the managed local profile.
    const target = seedTarget(join(dir, 'dsh-home'))
    assert.equal(readFileSync(join(target, 'dist', 'index.js'), 'utf8'), 'export const v = 1\n')
    assert.equal(statSync(join(target, 'dist', 'index.js')).mode & 0o777, 0o600)
  } finally {
    await plane.stop()
  }
})

test('createControlPlane.startLocal() seeds both host packages behind one merged overlay', async t => {
  const dir = tempDir(t)
  const graphSource = stageSource(t, 'export const graph = 1\n')
  const gitSource = tempDir(t)
  mkdirSync(join(gitSource, 'dist'), { recursive: true })
  writeFileSync(join(gitSource, 'package.json'), JSON.stringify({ name: HOST_GIT_WORKTREE_PACKAGE_NAME }))
  writeFileSync(join(gitSource, 'dist', 'index.js'), 'export const git = 1\n')
  const plane = createControlPlane({
    stateDir: dir,
    port: 0,
    dshWorkspacePath: join(dir, 'dsh'),
    hostGraphPackageSourceDir: graphSource,
    hostGitWorktreePackageSourceDir: gitSource,
    logger: silentLogger,
    localConnectionDeps: healthyLocalConnectionDeps,
  })
  try {
    await plane.start()
    await plane.startLocal()
    assert.equal(readFileSync(join(dir, HOST_GRAPH_PATCH_FILENAME), 'utf8'), EXPECTED_BOTH_OVERLAY)
    assert.equal(
      readFileSync(join(dir, 'dsh-home', 'profiles', 'web', 'node_modules', HOST_GIT_WORKTREE_PACKAGE_NAME, 'dist', 'index.js'), 'utf8'),
      'export const git = 1\n',
    )
  } finally {
    await plane.stop()
  }
})

test('createControlPlane.startLocal() reuses an exact user profile row without a duplicate overlay', async t => {
  const dir = tempDir(t)
  const source = stageSource(t, 'export const graph = 1\n')
  const profileDir = join(dir, 'dsh-home', 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `- insert:\n    - id: client-graph\n      name: '${HOST_GRAPH_PACKAGE_NAME}'\n`)
  const plane = createControlPlane({
    stateDir: dir,
    port: 0,
    dshWorkspacePath: join(dir, 'dsh'),
    hostGraphPackageSourceDir: source,
    hostGitWorktreePackageSourceDir: join(dir, 'no-git-package'),
    logger: silentLogger,
    localConnectionDeps: healthyLocalConnectionDeps,
  })
  try {
    await plane.start()
    await plane.startLocal()
    assert.equal(existsSync(join(dir, HOST_GRAPH_PATCH_FILENAME)), false)
    assert.equal(
      readFileSync(join(seedTarget(join(dir, 'dsh-home')), 'dist', 'index.js'), 'utf8'),
      'export const graph = 1\n',
    )
  } finally {
    await plane.stop()
  }
})

test('createControlPlane.startLocal() rejects a profile loader collision before package writes', async t => {
  const dir = tempDir(t)
  const source = stageSource(t, 'export const graph = 1\n')
  const profileDir = join(dir, 'dsh-home', 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `- insert:\n    - id: client-graph\n      name: '@dsh-chamber/not-client-graph'\n`)
  const plane = createControlPlane({
    stateDir: dir,
    port: 0,
    dshWorkspacePath: join(dir, 'dsh'),
    hostGraphPackageSourceDir: source,
    hostGitWorktreePackageSourceDir: join(dir, 'no-git-package'),
    logger: silentLogger,
    localConnectionDeps: healthyLocalConnectionDeps,
  })
  try {
    await plane.start()
    await assert.rejects(() => plane.startLocal(), /already bound to a different package/)
    assert.equal(existsSync(seedTarget(join(dir, 'dsh-home'))), false)
  } finally {
    await plane.stop()
  }
})

test('createControlPlane.startLocal() keeps the v4 baseline when dist/index.js is absent', async t => {
  const dir = tempDir(t)
  // A fake source dir that EXISTS but has no built artifact — the gate is the
  // artifact, not the directory: an unbuilt module A must behave exactly like
  // "not shipped" (skip + no overlay), never throw the seed's fail-loud
  // missing-file error.
  const source = tempDir(t)
  const plane = createControlPlane({
    stateDir: dir,
    port: 0,
    dshWorkspacePath: join(dir, 'dsh'),
    hostGraphPackageSourceDir: source,
    hostGitWorktreePackageSourceDir: join(dir, 'no-git-package'),
    logger: silentLogger,
    localConnectionDeps: healthyLocalConnectionDeps,
  })
  try {
    await plane.start()
    await plane.startLocal()
    assert.equal(existsSync(join(dir, HOST_GRAPH_PATCH_FILENAME)), false)
    assert.equal(existsSync(seedTarget(join(dir, 'dsh-home'))), false)
  } finally {
    await plane.stop()
  }
})

test('createControlPlane.startLocal() merges extra seed entries (client plugin) into the overlay and seeds them', async t => {
  // 2026-12 seed registry: an extra kind 'client' entry rides the same
  // artifact gate, profile seed and overlay as the host packages — the
  // gateway mobile slot's mechanism (the loader row is id/name only; kind is
  // metadata).
  const dir = tempDir(t)
  const graphSource = stageSource(t, 'export const graph = 1\n')
  const mobileSource = tempDir(t)
  mkdirSync(join(mobileSource, 'dist'), { recursive: true })
  writeFileSync(join(mobileSource, 'package.json'), JSON.stringify({ name: '@dsh-chamber/dsh-client-ui-mobile', version: '0.0.0', main: 'dist/index.js' }) + '\n')
  writeFileSync(join(mobileSource, 'dist', 'index.js'), 'export const mobile = 1\n')
  const plane = createControlPlane({
    stateDir: dir,
    port: 0,
    dshWorkspacePath: join(dir, 'dsh'),
    hostGraphPackageSourceDir: graphSource,
    hostGitWorktreePackageSourceDir: join(dir, 'no-git-package'),
    extraSeedEntries: [{
      insert: { id: 'mobile', name: '@dsh-chamber/dsh-client-ui-mobile' },
      kind: 'client',
      source: 'packaged',
      sourceDir: mobileSource,
    }],
    logger: silentLogger,
    localConnectionDeps: healthyLocalConnectionDeps,
  })
  try {
    await plane.start()
    await plane.startLocal()
    const overlay = readFileSync(join(dir, HOST_GRAPH_PATCH_FILENAME), 'utf8')
    assert.match(overlay, /- id: mobile/)
    assert.match(overlay, /name: '@dsh-chamber\/dsh-client-ui-mobile'/)
    assert.equal(
      readFileSync(join(dir, 'dsh-home', 'profiles', 'web', 'node_modules', '@dsh-chamber', 'dsh-client-ui-mobile', 'dist', 'index.js'), 'utf8'),
      'export const mobile = 1\n',
    )
  } finally {
    await plane.stop()
  }
})

test('createControlPlane.startLocal() skips an absent extra seed entry (stub) with a warn and no overlay row', async t => {
  // 2026-12 seed registry: the gateway mobile slot ships on the mobile branch;
  // until then an absent packaged source is a warned stub skip — the rest of
  // the seed (host packages) proceeds untouched, never a failure.
  const dir = tempDir(t)
  const source = stageSource(t, 'export const graph = 1\n')
  const warns: string[] = []
  const plane = createControlPlane({
    stateDir: dir,
    port: 0,
    dshWorkspacePath: join(dir, 'dsh'),
    hostGraphPackageSourceDir: source,
    hostGitWorktreePackageSourceDir: join(dir, 'no-git-package'),
    extraSeedEntries: [{
      insert: { id: 'mobile', name: '@dsh-chamber/dsh-client-ui-mobile' },
      kind: 'client',
      source: 'packaged',
      sourceDir: join(dir, 'no-mobile-package'),
    }],
    logger: { log() {}, warn: (message: unknown) => { warns.push(String(message)) }, error() {} },
    localConnectionDeps: healthyLocalConnectionDeps,
  })
  try {
    await plane.start()
    await plane.startLocal()
    assert.equal(readFileSync(join(dir, HOST_GRAPH_PATCH_FILENAME), 'utf8'), EXPECTED_OVERLAY,
      'the absent stub row must not enter the overlay')
    assert.ok(warns.some(message => message.includes('mobile') && message.includes('stub')),
      'the absent stub entry is warned as a skipped stub')
  } finally {
    await plane.stop()
  }
})

// ---------------------------------------------------------------------------
// ensureHostGraphPackage: fail-loud on a source missing a declared file
// ---------------------------------------------------------------------------

test('ensureHostGraphPackage throws when the source exists but a declared file is missing', t => {
  const dshHome = tempDir(t)
  // dist/index.js present but package.json missing — the caller's gate (dist
  // artifact only) passes, so this is the shipped-but-broken module A case:
  // fail-loud, never a silent skip.
  const distOnly = tempDir(t)
  mkdirSync(join(distOnly, 'dist'), { recursive: true })
  writeFileSync(join(distOnly, 'dist', 'index.js'), 'export const v = 1\n')
  assert.throws(() => ensureHostGraphPackage(dshHome, distOnly), /missing in package/)
  // package.json present but dist/index.js missing — the same fail-loud
  // contract on the other declared file.
  const manifestOnly = tempDir(t)
  writeFileSync(join(manifestOnly, 'package.json'), JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME, version: '0.0.0', main: 'dist/index.js' }) + '\n')
  assert.throws(() => ensureHostGraphPackage(dshHome, manifestOnly), /missing in package/)
})

// ---------------------------------------------------------------------------
// ensureSeedPackage: seedFiles override, deep target dirs, validation
// ---------------------------------------------------------------------------

test('ensureSeedPackage seeds a custom seedFiles set with arbitrary-depth real target dirs', t => {
  const dshHome = tempDir(t)
  const source = tempDir(t)
  mkdirSync(join(source, 'dist'), { recursive: true })
  mkdirSync(join(source, 'assets', 'css'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME, version: '0.0.0', main: 'dist/index.js' }) + '\n')
  writeFileSync(join(source, 'dist', 'index.js'), 'export const v = 1\n')
  writeFileSync(join(source, 'assets', 'css', 'app.css'), 'body { color: red }\n')
  // Root file + dist + an arbitrary-depth asset — every non-root component
  // gets its own final-component parent (a real directory, never a symlink).
  assert.equal(
    ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source, ['package.json', 'dist/index.js', 'assets/css/app.css']),
    true,
  )
  const target = join(dshHome, 'profiles', 'web', 'node_modules', HOST_GRAPH_PACKAGE_NAME)
  assert.equal(readFileSync(join(target, 'package.json'), 'utf8'), readFileSync(join(source, 'package.json'), 'utf8'))
  assert.equal(readFileSync(join(target, 'assets', 'css', 'app.css'), 'utf8'), 'body { color: red }\n')
  assert.equal(statSync(join(target, 'assets', 'css')).isDirectory(), true, 'the deep asset dir is a real directory')
  assert.equal(statSync(join(target, 'dist')).isDirectory(), true)
  // Root files create no extra directories — the package root holds exactly
  // the declared entries.
  assert.deepEqual(readdirSync(target).sort(), ['assets', 'dist', 'package.json'])
  // Idempotent second pass: no rewrite.
  assert.equal(
    ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source, ['package.json', 'dist/index.js', 'assets/css/app.css']),
    false,
  )
})

test('ensureSeedPackage returns false for a null sourceDir without touching the profile', t => {
  const dshHome = tempDir(t)
  assert.equal(ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, null), false)
  assert.equal(existsSync(join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-chamber')), false)
})

test('ensureSeedPackage rejects malformed seedFiles entries fail-loud', t => {
  const dshHome = tempDir(t)
  const source = tempDir(t)
  mkdirSync(join(source, 'dist'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME, version: '0.0.0', main: 'dist/index.js' }) + '\n')
  writeFileSync(join(source, 'dist', 'index.js'), 'export const v = 1\n')
  // An empty set would seed nothing yet emit an overlay row — refused.
  assert.throws(() => ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source, []), /must not be empty/)
  // Path traversal and absolute paths must never escape the package dir.
  assert.throws(() => ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source, ['../package.json']), /invalid seed file path/)
  assert.throws(() => ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source, ['/etc/passwd']), /invalid seed file path/)
  assert.throws(() => ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source, ['']), /invalid seed file path/)
  assert.equal(existsSync(join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-chamber')), false)
})

test('createControlPlane.startLocal() lets an extra seed entry shadow the base host package (no duplicate rows)', async t => {
  // 2026-12 regression: the gateway re-declares the two host packages as
  // desktop-synced extra entries. When the synced cache exists, the extra
  // entry must REPLACE the legacy base entry — never produce two overlay
  // rows with the same loader identity (renderCordisInserts would throw
  // 'duplicate overlay row' and the managed dsh could never spawn).
  const dir = tempDir(t)
  const baseSource = stageSource(t, 'export const base = 1\n')
  const syncedSource = tempDir(t)
  mkdirSync(join(syncedSource, 'dist'), { recursive: true })
  writeFileSync(join(syncedSource, 'package.json'), JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME, version: '9.9.9', main: 'dist/index.js' }) + '\n')
  writeFileSync(join(syncedSource, 'dist', 'index.js'), 'export const synced = 1\n')
  const plane = createControlPlane({
    stateDir: dir,
    port: 0,
    dshWorkspacePath: join(dir, 'dsh'),
    hostGraphPackageSourceDir: baseSource,
    hostGitWorktreePackageSourceDir: join(dir, 'no-git-package'),
    extraSeedEntries: [{
      insert: HOST_GRAPH_INSERT,
      kind: 'host',
      source: 'desktop-synced',
      sourceDir: syncedSource,
      probeDomains: ['clientGraph/graph'],
    }],
    logger: silentLogger,
    localConnectionDeps: healthyLocalConnectionDeps,
  })
  try {
    await plane.start()
    await plane.startLocal()
    const overlay = readFileSync(join(dir, HOST_GRAPH_PATCH_FILENAME), 'utf8')
    // Exactly ONE row for the client-graph identity.
    assert.equal((overlay.match(/- id: client-graph/g) ?? []).length, 1, 'the shadowing extra entry must not duplicate the loader row')
    // The synced source wins: its bytes land in the profile, not the base's.
    const seeded = readFileSync(
      join(dir, 'dsh-home', 'profiles', 'web', 'node_modules', HOST_GRAPH_PACKAGE_NAME, 'dist', 'index.js'),
      'utf8',
    )
    assert.equal(seeded, 'export const synced = 1\n')
  } finally {
    await plane.stop()
  }
})
