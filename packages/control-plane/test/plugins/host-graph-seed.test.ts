/**
 * Todo 09 module B unit tests — the control-plane host-graph seed:
 *   - buildPatchOverlay: canonical content, idempotency (in-sync skip),
 *     0600 perms, and self-heal of a drifted overlay;
 *   - ensureSeedPackage (host graph): first copy, in-sync skip, content-change
 *     overwrite, absent-source skip, 0600 perms, and fail-loud on a source
 *     that passes the caller's dist gate but misses a declared file;
 *   - webProfileArgs: --patch injection (position before the web flags) and
 *     absent/empty handling;
 *   - createLocalConnection: the resolved patchPath reaches the spawnDshFn —
 *     initial spawn AND the restart path (the thunk is re-resolved per
 *     spawn, which is what self-heals a pruned seed);
 *   - createControlPlane.start(): the seed orchestration gate — dist present
 *     → package + overlay materialized; dist absent → v4 baseline (no seed,
 *     no overlay);
 *   - resolveLocalHostGraphOverlay + P5b-0 bundle-row disables: a row an ENABLED
 *     profile bundle mounts (forge-github, and a group-inner id) gets a verified
 *     id-targeted disable; a NOT-enabled bundle skips it with a diagnostic
 *     (idempotent boot); a misspelled id in an enabled bundle is fail-closed.
 * Run directly: node packages/control-plane/test/plugins/host-graph-seed.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostGraphPlane, skipSymlinksUnavailable, tempDir, writeLocalProfileFixture } from '../support/utils.ts'
import {
  CHAMBER_HOST_PACKAGES,
  assertHostSeedEntryNaming,
  assertHostSeedInsertNaming,
  buildPatchOverlay,
  ensureSeedPackage,
  missingHostPackageInserts,
  HOST_ARCHIVE_CLEANUP_INSERT,
  HOST_GIT_WORKTREE_INSERT,
  HOST_ARCHIVE_CLEANUP_PACKAGE_NAME,
  HOST_OPEN_IN_PACKAGE_NAME,
  HOST_GIT_WORKTREE_PACKAGE_NAME,
  HOST_GRAPH_INSERT,
  HOST_GRAPH_PACKAGE_NAME,
  HOST_GRAPH_PATCH_FILENAME,
  HOST_OPEN_IN_INSERT,
  OFFICIAL_OPEN_IN_DISABLE,
} from '../../src/host-graph-seed.ts'
import { webProfileArgs, DEFAULT_DSH_START_PORT } from '../../src/spawn-dsh.ts'
import { createLocalConnection } from '../../src/local-connection.ts'
import { resolveLocalHostGraphOverlay } from '../../src/local-host-seeding.ts'
import { WEB_APP_SKILL_OFFICE_ROW } from '../../src/bundle-row-disables.ts'
import type { SpawnedDsh } from '../../src/local-connection.ts'

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
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
`

const EXPECTED_BOTH_OVERLAY = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
    - id: git-worktree
      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
`

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
    if (skipSymlinksUnavailable(error, t)) return
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
    if (skipSymlinksUnavailable(error, t)) return
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
// ensureSeedPackage (host graph)
// ---------------------------------------------------------------------------

/** Stage a fake module-A package (package.json + dist/index.js). */
function stageSource(t: any, distContent = 'export default {}\n') {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME, version: '0.0.0', main: 'dist/index.js' }) + '\n')
  writeFileSync(join(dir, 'dist', 'index.js'), distContent)
  return dir
}

test('ensureSeedPackage (host-graph) copies package.json + dist/index.js once, then skips in-sync copies', t => {
  const dshHome = tempDir(t)
  const source = stageSource(t, 'export const v = 1\n')
  const first = ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source)
  assert.equal(first, true)
  const target = seedTarget(dshHome)
  assert.equal(
    readFileSync(join(target, 'package.json'), 'utf8'),
    JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME, version: '0.0.0', main: 'dist/index.js' }) + '\n',
  )
  assert.equal(readFileSync(join(target, 'dist', 'index.js'), 'utf8'), 'export const v = 1\n')
  assert.equal(statSync(join(target, 'dist', 'index.js')).mode & 0o777, 0o600)
  const mtime = statSync(join(target, 'dist', 'index.js')).mtimeMs
  const second = ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source)
  assert.equal(second, false)
  assert.equal(statSync(join(target, 'dist', 'index.js')).mtimeMs, mtime, 'an in-sync seed is not rewritten')
})

test('ensureSeedPackage (host-graph) overwrites a drifted dist when the source content changes', t => {
  const dshHome = tempDir(t)
  const source = stageSource(t, 'export const v = 1\n')
  ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source)
  writeFileSync(join(source, 'dist', 'index.js'), 'export const v = 2\n')
  const wrote = ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source)
  assert.equal(wrote, true)
  assert.equal(readFileSync(join(seedTarget(dshHome), 'dist', 'index.js'), 'utf8'), 'export const v = 2\n')
})

test('ensureSeedPackage (host-graph) rejects a symlinked profile node_modules anchor without writing through it', t => {
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
    if (skipSymlinksUnavailable(error, t)) return
    throw error
  }
  assert.throws(() => ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source), /not a real directory/)
  assert.equal(readFileSync(sentinel, 'utf8'), 'DO NOT TOUCH')
  assert.equal(existsSync(join(outside, '@dsh-chamber')), false)
})

test('ensureSeedPackage (host-graph) rejects a symlinked chamber scope without creating the package outside the profile', t => {
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
    if (skipSymlinksUnavailable(error, t)) return
    throw error
  }
  assert.throws(() => ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source), /not a real directory/)
  assert.equal(readFileSync(sentinel, 'utf8'), 'DO NOT TOUCH')
  assert.equal(existsSync(join(outside, 'dsh-chamber-seed-client-graph')), false)
})

test('ensureSeedPackage (host-graph) rejects a symlinked chamber package directory without writing outside the profile', t => {
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
    if (skipSymlinksUnavailable(error, t)) return
    throw error
  }
  assert.throws(() => ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, source), /not a real directory/)
  assert.equal(readFileSync(sentinel, 'utf8'), 'DO NOT TOUCH')
  assert.equal(existsSync(join(outside, 'package.json')), false)
  assert.equal(existsSync(join(outside, 'dist', 'index.js')), false)
})

test('ensureSeedPackage (host-graph) retains the ordinary source boundary for a symlinked package source', t => {
  const dshHome = tempDir(t)
  const source = stageSource(t, 'export const linkedSource = true\n')
  const sourceLink = join(tempDir(t), 'source-link')
  try {
    symlinkSync(source, sourceLink, 'dir')
  } catch (error) {
    if (skipSymlinksUnavailable(error, t)) return
    throw error
  }
  assert.equal(ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, sourceLink), true)
  assert.equal(
    readFileSync(join(seedTarget(dshHome), 'dist', 'index.js'), 'utf8'),
    'export const linkedSource = true\n',
  )
})

test('ensureSeedPackage (host-graph) returns false without touching the profile when the source package is absent', t => {
  const dshHome = tempDir(t)
  assert.equal(ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, join(dshHome, 'no-such-package')), false)
  assert.equal(existsSync(seedTarget(dshHome)), false)
})

test('ensureSeedPackage reuses the seed path for the Git worktree host package', t => {
  const dshHome = tempDir(t)
  const source = tempDir(t)
  mkdirSync(join(source, 'dist'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: HOST_GIT_WORKTREE_PACKAGE_NAME }))
  writeFileSync(join(source, 'dist', 'index.js'), 'export default {}\n')
  assert.equal(ensureSeedPackage(dshHome, HOST_GIT_WORKTREE_PACKAGE_NAME, source), true)
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
      probeHostIdentity: async () => true,
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
  const spawnOptions: Array<{ patchPath?: string | null; pnpmEntry?: string | null }> = []
  const spawnedList: Array<ReturnType<typeof mockSpawnedWithExit>> = []
  let patchValue: string | null = '/tmp/first.yml'
  const connection = createLocalConnection({
    stateDir: dir,
    dshHome: join(dir, 'dsh-home'),
    dshWorkspacePath: join(dir, 'dsh'),
    logger: silentLogger,
    options: { patchPath: () => patchValue, pnpmEntry: '/tmp/spawn-pnpm/pnpm.cjs' },
    deps: {
      spawnDsh: async (options: { patchPath?: string | null; pnpmEntry?: string | null }) => {
        spawnOptions.push(options)
        const spawned = mockSpawnedWithExit()
        spawnedList.push(spawned)
        return spawned
      },
      probeHostIdentity: async () => true,
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
    // Both spawn call sites carry the bundled entry (design 02 §3.1).
    assert.deepEqual(spawnOptions.map(options => options.pnpmEntry), [
      '/tmp/spawn-pnpm/pnpm.cjs',
      '/tmp/spawn-pnpm/pnpm.cjs',
    ])
    assert.equal(connection.getState(), 'ready')
  } finally {
    await connection.stop()
  }
})

// ---------------------------------------------------------------------------
// resolveLocalHostGraphOverlay: the overlay FILE must exist exactly when the
// spawn passes it as `--patch`. The install probe in packages/desktop reads it
// as "this row is mounted", so a leftover file from an earlier spawn that did
// pass it would report a row the current spawn does NOT mount (T20).
// ---------------------------------------------------------------------------

/** A built host-graph source dir (package.json + dist/index.js). */
function writeBuiltSeedSource(dir: string, built: boolean): string {
  const sourceDir = join(dir, 'built-seed-source')
  mkdirSync(join(sourceDir, built ? 'dist' : 'lib'), { recursive: true })
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME }))
  if (built) writeFileSync(join(sourceDir, 'dist', 'index.js'), 'export const graph = 1\n')
  return sourceDir
}

test('resolveLocalHostGraphOverlay: a built artifact + an empty profile patch writes the overlay', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir, true)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: [] }],
    log() {},
    warn() {},
  })
  assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME))
  assert.equal(readFileSync(overlay as string, 'utf8'), EXPECTED_OVERLAY)
  assert.ok(!readFileSync(overlay as string, 'utf8').includes('open-in-app'),
    'no chamber open-in seeded => the official open-in host row is left alone (the gateway/localOnly shape)')
})

/** A built host source dir for an arbitrary registry package name. */
function writeBuiltHostSource(dir: string, packageName: string, label: string, content: string): string {
  const sourceDir = join(dir, `built-${label}-source`)
  mkdirSync(join(sourceDir, 'dist'), { recursive: true })
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: packageName }))
  writeFileSync(join(sourceDir, 'dist', 'index.js'), content)
  return sourceDir
}

/** The exact id-targeted disable row the local overlay appends (audit P2-3). */
const OFFICIAL_OPEN_IN_DISABLE_ROW = `- id: open-in-app
  name: '@deepseek-ai/dsh-host-open-in-app'
  disabled: true
`

/** Both chamber rows a graph+open-in seed inserts, in seed order. */
const EXPECTED_GRAPH_OPEN_IN_OVERLAY = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
    - id: open-in
      name: '${HOST_OPEN_IN_PACKAGE_NAME}'
`

test('resolveLocalHostGraphOverlay: a seeded chamber open-in appends the official host disable (exact row)', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const graphSource = writeBuiltSeedSource(dir, true)
  const openInSource = writeBuiltHostSource(dir, HOST_OPEN_IN_PACKAGE_NAME, 'open-in', 'export const openIn = 1\n')
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [
      { insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir: graphSource, probeDomains: [] },
      { insert: HOST_OPEN_IN_INSERT, kind: 'host', source: 'packaged', sourceDir: openInSource, probeDomains: [] },
    ],
    log() {},
    warn() {},
  })
  assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME))
  assert.equal(
    readFileSync(overlay as string, 'utf8'),
    EXPECTED_GRAPH_OPEN_IN_OVERLAY + OFFICIAL_OPEN_IN_DISABLE_ROW,
    'the disable row rides the same --patch overlay, AFTER every chamber insert row',
  )
  assert.equal(OFFICIAL_OPEN_IN_DISABLE.id, 'open-in-app')
  assert.equal(OFFICIAL_OPEN_IN_DISABLE.name, '@deepseek-ai/dsh-host-open-in-app')
})

test('resolveLocalHostGraphOverlay: a user-owned open-in row still gets the official disable (disable-only overlay)', t => {
  const dir = tempDir(t)
  // The user's own layer already mounts both chamber rows, so there is nothing
  // to insert — but the official host half is still superseded and its disable
  // is not an insert identity, so it must not ride the "no overlay" path.
  const userPatch = `- insert:
    - id: client-graph
      name: '${HOST_GRAPH_PACKAGE_NAME}'
    - id: open-in
      name: '${HOST_OPEN_IN_PACKAGE_NAME}'
`
  const dshHome = writeLocalProfileFixture(dir, userPatch)
  const graphSource = writeBuiltSeedSource(dir, true)
  const openInSource = writeBuiltHostSource(dir, HOST_OPEN_IN_PACKAGE_NAME, 'open-in', 'export const openIn = 1\n')
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [
      { insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir: graphSource, probeDomains: [] },
      { insert: HOST_OPEN_IN_INSERT, kind: 'host', source: 'packaged', sourceDir: openInSource, probeDomains: [] },
    ],
    log() {},
    warn() {},
  })
  assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME), 'the disable still needs a --patch file')
  assert.equal(readFileSync(overlay as string, 'utf8'), OFFICIAL_OPEN_IN_DISABLE_ROW)
})

// ---------------------------------------------------------------------------
// resolveLocalHostGraphOverlay + the P5b-0 bundle-row disable: a row the forge
// BUNDLE mounts (forge-github) is force-disabled only when the bundle is
// enabled, verified against the bundle's own patch, and an enabled bundle whose
// row cannot be proven is fail-closed.
// ---------------------------------------------------------------------------

const FORGE_BUNDLE_NAME = '@deepseek-ai/dsh-experimental-forge-bundle'
const FORGE_GITHUB_ROW = {
  bundle: FORGE_BUNDLE_NAME,
  id: 'forge-github',
  name: '@deepseek-ai/dsh-experimental-forge-github',
}
const FORGE_GITHUB_DISABLE_ROW = `- id: forge-github
  name: '@deepseek-ai/dsh-experimental-forge-github'
  disabled: true
`
const FORGE_PATCH = `- insert:
    - id: worktree
      name: '@deepseek-ai/dsh-experimental-worktree'
    - id: tool-worktree
      name: '@deepseek-ai/dsh-experimental-tool-worktree'
    - id: forge
      name: '@deepseek-ai/dsh-experimental-forge'
    - id: forge-github
      name: '@deepseek-ai/dsh-experimental-forge-github'
    - id: forge-session
      name: '@deepseek-ai/dsh-experimental-forge-session'
    - id: forge-panel
      name: '@deepseek-ai/dsh-experimental-client-ui-forge'
`

/** Enable the forge bundle in the managed profile (manifest layer + installed package). */
function enableForgeBundle(dshHome: string, patch: string = FORGE_PATCH): void {
  const profileDir = join(dshHome, 'profiles', 'web')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', FORGE_BUNDLE_NAME] } },
  }))
  const packageDir = join(profileDir, 'node_modules', FORGE_BUNDLE_NAME)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: FORGE_BUNDLE_NAME,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(packageDir, 'cordis.patch.yml'), patch)
}

test('resolveLocalHostGraphOverlay: an ENABLED forge bundle gets the verified forge-github disable', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir, true)
  enableForgeBundle(dshHome)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: [] }],
    log() {},
    warn() {},
  })
  assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME))
  assert.equal(
    readFileSync(overlay as string, 'utf8'),
    EXPECTED_OVERLAY + FORGE_GITHUB_DISABLE_ROW,
    'the disable rides the same --patch overlay, after every insert row and above every bundle layer',
  )
})

test('resolveLocalHostGraphOverlay: a NOT-enabled forge bundle skips the disable with a diagnostic (idempotent)', t => {
  const dir = tempDir(t)
  // The default fixture (base + web-app) has forge off: the opt-in state must boot normally.
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir, true)
  const logs: string[] = []
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: [] }],
    log: message => { logs.push(message) },
    warn() {},
  })
  assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME))
  assert.equal(readFileSync(overlay as string, 'utf8'), EXPECTED_OVERLAY,
    'the overlay bytes are unchanged while the bundle is off')
  assert.ok(logs.some(message => message.includes(FORGE_BUNDLE_NAME) && message.includes('skipped')),
    `the skip must be diagnosed: ${logs.join(' | ')}`)
})

test('resolveLocalHostGraphOverlay: a RENAMED row id (same package) in an ENABLED bundle is fail-closed', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir, true)
  enableForgeBundle(dshHome)
  assert.throws(
    () => resolveLocalHostGraphOverlay({
      stateDir: dir,
      dshHome,
      entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: [] }],
      bundleRowDisables: [{ ...FORGE_GITHUB_ROW, id: 'forge-githb' }],
      log() {},
      warn() {},
    }),
    /binds package '@deepseek-ai\/dsh-experimental-forge-github'.*instead of 'forge-githb'.*fail-closed/,
  )
})

test('resolveLocalHostGraphOverlay: a panel row id is addressable after the rc.2 flatten', t => {
  // rc.2 removed the optional-forge-panel group: the worktree row is top-level again,
  // so a panel row disable is addressed at that depth.
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir, true)
  enableForgeBundle(dshHome)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: [] }],
    bundleRowDisables: [{
      bundle: FORGE_BUNDLE_NAME,
      id: 'worktree',
      name: '@deepseek-ai/dsh-experimental-worktree',
    }],
    log() {},
    warn() {},
  })
  assert.equal(
    readFileSync(overlay as string, 'utf8'),
    EXPECTED_OVERLAY + `- id: worktree
  name: '@deepseek-ai/dsh-experimental-worktree'
  disabled: true
`,
  )
})

test('resolveLocalHostGraphOverlay: an enabled bundle disable rides a disable-only overlay when the user patch owns the insert', t => {
  const dir = tempDir(t)
  // The user's own layer mounts the chamber row already: there is nothing to insert, but the
  // bundle-row disable is not an insert identity and must still ride a --patch file.
  const dshHome = writeLocalProfileFixture(dir, EXPECTED_OVERLAY)
  const sourceDir = writeBuiltSeedSource(dir, true)
  enableForgeBundle(dshHome)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: [] }],
    log() {},
    warn() {},
  })
  assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME))
  assert.equal(readFileSync(overlay as string, 'utf8'), FORGE_GITHUB_DISABLE_ROW)
})

test('resolveLocalHostGraphOverlay: a row already owned by the profile patch yields no overlay AND clears the leftover file', t => {
  const dir = tempDir(t)
  // A previous spawn DID pass the overlay: its row is still on disk while the
  // user's own patch layer has since taken the row over (the production path
  // omits it from the overlay — duplicate loader identities would fail boot).
  const stale = join(dir, HOST_GRAPH_PATCH_FILENAME)
  writeFileSync(stale, EXPECTED_OVERLAY)
  const dshHome = writeLocalProfileFixture(dir, EXPECTED_OVERLAY)
  const sourceDir = writeBuiltSeedSource(dir, true)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: [] }],
    log() {},
    warn() {},
  })
  assert.equal(overlay, null, 'no --patch is passed when every row is already user-owned')
  assert.equal(existsSync(stale), false,
    'a leftover overlay file must not survive the spawn that passes no --patch — the install probe reads it as a mount fact')
  // The package files are still seeded (the row resolves from the profile patch).
  assert.equal(existsSync(join(seedTarget(dshHome), 'dist', 'index.js')), true)
})

test('resolveLocalHostGraphOverlay: no built artifact yields no overlay, clears the leftover file AND logs the error', t => {
  const dir = tempDir(t)
  const stale = join(dir, HOST_GRAPH_PATCH_FILENAME)
  writeFileSync(stale, EXPECTED_OVERLAY)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir, false)
  const warns: string[] = []
  const errors: string[] = []
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: [] }],
    log() {},
    warn: message => { warns.push(message) },
    error: message => { errors.push(message) },
  })
  assert.equal(overlay, null, 'the v4 baseline spawn passes no --patch')
  assert.equal(existsSync(stale), false,
    'the stale overlay records a mount this spawn does not perform')
  assert.equal(existsSync(join(seedTarget(dshHome), 'package.json')), false, 'nothing is seeded without the artifact')
  // D6a: an existing-but-unbuilt packaged host source is a packaging defect,
  // not a stub — the skip must name the entry, package, artifact and effect.
  assert.ok(!warns.some(message => message.includes('stub')),
    `the unbuilt packaged source is an error, not a stub warn: ${warns.join(' | ')}`)
  assert.equal(errors.length, 1)
  assert.ok(errors[0].includes(`seed entry 'client-graph'`), errors[0])
  assert.ok(errors[0].includes(HOST_GRAPH_PACKAGE_NAME), errors[0])
  assert.ok(errors[0].includes(join(sourceDir, 'dist', 'index.js')), errors[0])
  assert.ok(errors[0].includes('no --patch row for it'), errors[0])
})

// ---------------------------------------------------------------------------
// createControlPlane local spawn: the seed orchestration gate (dist present /
// absent — a fake hostGraphPackageSourceDir covers both branches). plane.start
// only reaps writers; DSH_HOME remains untouched until the fenced spawn path.
// ---------------------------------------------------------------------------

test('seededProbeDomains 按实际 seed 派生（全/部分/空三态；2026-09 二轮 P1）', async t => {
  const dir = tempDir(t)
  const graphSource = stageSource(t, 'export const v = 1\n')
  // 部分 seed：graph 在、git/archive 源缺失
  const partial = hostGraphPlane(dir, {
    hostGraphPackageSourceDir: graphSource,
    hostGitWorktreePackageSourceDir: join(dir, 'no-git'),
    hostArchiveCleanupPackageSourceDir: join(dir, 'no-archive'),
    // open-in 是 localOnly 行，其源码包在仓库里真实存在：不显式指向缺失目录的话
    // 缺省目录会被播种，本用例就不再是"部分 seed"。
    hostOpenInPackageSourceDir: join(dir, 'no-open-in'),
  })
  try {
    await partial.start()
    assert.deepEqual([...partial.seededProbeDomains], [], '未 seed 前为空')
    await partial.startLocal()
    assert.deepEqual([...partial.seededProbeDomains], ['clientGraph/graph'], '只含实际 seed 的域')
  } finally {
    await partial.stop()
  }

  // 空 seed：三源全缺 → 空集（激活期望集退化为无宿主域，不误判失败）
  const emptyDir = tempDir(t)
  const empty = hostGraphPlane(emptyDir, {
    hostGraphPackageSourceDir: join(emptyDir, 'no-graph'),
    hostGitWorktreePackageSourceDir: join(emptyDir, 'no-git'),
    hostArchiveCleanupPackageSourceDir: join(emptyDir, 'no-archive'),
    hostOpenInPackageSourceDir: join(emptyDir, 'no-open-in'),
  })
  try {
    await empty.start()
    await empty.startLocal()
    assert.deepEqual([...empty.seededProbeDomains], [])
  } finally {
    await empty.stop()
  }

  // 三源齐备 → 全三域
  const fullDir = tempDir(t)
  const gitFull = stageSource(t, 'export const v = 3\n')
  const archiveFull = stageSource(t, 'export const v = 4\n')
  const full = hostGraphPlane(fullDir, {
    hostGraphPackageSourceDir: stageSource(t, 'export const v = 5\n'),
    hostGitWorktreePackageSourceDir: gitFull,
    hostArchiveCleanupPackageSourceDir: archiveFull,
    hostOpenInPackageSourceDir: stageSource(t, 'export const v = 6\n'),
  })
  try {
    await full.start()
    await full.startLocal()
    // 期望域从注册表派生（不是手抄清单）：再加宿主包时这里自动跟上，
    // 而"播种集漂移"仍会被下面的相等断言抓住。
    assert.deepEqual(
      [...full.seededProbeDomains].sort(),
      CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.probe.method).sort(),
    )
  } finally {
    await full.stop()
  }
})

test('createControlPlane.startLocal() seeds the host package and materializes the overlay when dist/index.js exists', async t => {
  const dir = tempDir(t)
  const source = stageSource(t, 'export const v = 1\n')
  const plane = hostGraphPlane(dir, {
    hostGraphPackageSourceDir: source,
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


test('createControlPlane.startLocal() seeds ALL FOUR host packages behind one merged overlay (design 24 M3 / design 20 §6 lockstep leg)', async t => {
  const dir = tempDir(t)
  const graphSource = stageSource(t, 'export const graph = 1\n')
  const gitSource = tempDir(t)
  mkdirSync(join(gitSource, 'dist'), { recursive: true })
  writeFileSync(join(gitSource, 'package.json'), JSON.stringify({ name: HOST_GIT_WORKTREE_PACKAGE_NAME }))
  writeFileSync(join(gitSource, 'dist', 'index.js'), 'export const git = 1\n')
  const archiveSource = tempDir(t)
  mkdirSync(join(archiveSource, 'dist'), { recursive: true })
  writeFileSync(join(archiveSource, 'package.json'), JSON.stringify({ name: HOST_ARCHIVE_CLEANUP_PACKAGE_NAME }))
  writeFileSync(join(archiveSource, 'dist', 'index.js'), 'export const archiveCleanup = 1\n')
  const openInSource = tempDir(t)
  mkdirSync(join(openInSource, 'dist'), { recursive: true })
  writeFileSync(join(openInSource, 'package.json'), JSON.stringify({ name: HOST_OPEN_IN_PACKAGE_NAME }))
  writeFileSync(join(openInSource, 'dist', 'index.js'), 'export const openIn = 1\n')
  const plane = hostGraphPlane(dir, {
    hostGraphPackageSourceDir: graphSource,
    hostGitWorktreePackageSourceDir: gitSource,
    hostArchiveCleanupPackageSourceDir: archiveSource,
    hostOpenInPackageSourceDir: openInSource,
  })
  try {
    await plane.start()
    await plane.startLocal()
    const overlay = readFileSync(join(dir, HOST_GRAPH_PATCH_FILENAME), 'utf8')
    assert.equal(
      readFileSync(join(dir, 'dsh-home', 'profiles', 'web', 'node_modules', HOST_GIT_WORKTREE_PACKAGE_NAME, 'dist', 'index.js'), 'utf8'),
      'export const git = 1\n',
      'the git-worktree host package is seeded too (merged from the two-package case)',
    )
    assert.ok(overlay.includes(`- id: archive-cleanup`), 'third insert row present')
    assert.ok(overlay.includes(`name: '${HOST_ARCHIVE_CLEANUP_PACKAGE_NAME}'`), 'third package named')
    // probeDomains is documented pure metadata (never serialized into the
    // overlay) — the activation-contract lockstep (the archiveCleanup probe
    // domain drift) is asserted at the seed
    // SOURCE. Since the seed rows DERIVE from the registry
    // (CHAMBER_HOST_PACKAGES), the probe endpoint lives in the registry row
    // and the call site must carry no parallel literal at all.
    const registrySource = readFileSync(join(process.cwd(), 'src', 'host-graph-seed.ts'), 'utf8')
    assert.ok(registrySource.includes(`probe: { method: 'archiveCleanup/probe'`), 'registry row names the probe endpoint')
    const seedSource = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
    assert.ok(seedSource.includes('CHAMBER_HOST_PACKAGES'), 'the seed derives its rows from the registry, never a parallel row table')
    assert.ok(!/probeDomains: \['/.test(seedSource), 'the seed call site must not hand-write a probe domain literal')
    assert.equal(
      readFileSync(join(dir, 'dsh-home', 'profiles', 'web', 'node_modules', HOST_ARCHIVE_CLEANUP_PACKAGE_NAME, 'dist', 'index.js'), 'utf8'),
      'export const archiveCleanup = 1\n',
    )
    assert.ok(overlay.includes(`- id: open-in`), 'the local-shape-only open-in row is seeded into the local profile')
    assert.ok(overlay.includes(`name: '${HOST_OPEN_IN_PACKAGE_NAME}'`), 'fourth package named')
    assert.ok(registrySource.includes(`probe: { method: 'openInApp/probe'`), 'the open-in registry row names its probe endpoint')
    assert.ok(registrySource.includes('localOnly: true'), 'the open-in row is marked local-shape-only (design 20 §6)')
    // Audit arch-03 P2-3: the same overlay disables the official web-bundle
    // open-in HOST half, so the seeded chamber host package is the only live
    // wire face for the domain.
    assert.ok(
      overlay.endsWith(`- id: open-in-app\n  name: '${OFFICIAL_OPEN_IN_DISABLE.name}'\n  disabled: true\n`),
      `the official open-in host row must be disabled after every insert row: ${overlay}`,
    )
    assert.equal((overlay.match(/- id: open-in-app/g) ?? []).length, 1, 'exactly one disable row')
    assert.equal(
      readFileSync(join(dir, 'dsh-home', 'profiles', 'web', 'node_modules', HOST_OPEN_IN_PACKAGE_NAME, 'dist', 'index.js'), 'utf8'),
      'export const openIn = 1\n',
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
  const plane = hostGraphPlane(dir, {
    hostGraphPackageSourceDir: source,
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
  // missing-file error. It must still be visible in the plane log (D6a).
  const source = tempDir(t)
  const errors: string[] = []
  const plane = hostGraphPlane(dir, {
    hostGraphPackageSourceDir: source,
    logger: { log() {}, warn() {}, error: message => { errors.push(String(message)) } },
  })
  try {
    await plane.start()
    await plane.startLocal()
    assert.equal(existsSync(join(dir, HOST_GRAPH_PATCH_FILENAME)), false)
    assert.equal(existsSync(seedTarget(join(dir, 'dsh-home'))), false)
    assert.ok(errors.some(message => message.includes('client-graph')
      && message.includes('built artifact missing')
      && message.includes('no --patch row for it')), `seed artifact diagnostic missing from: ${errors.join(' | ')}`)
  } finally {
    await plane.stop()
  }
})

test('createControlPlane.startLocal() merges extra seed entries (client plugin) into the overlay and seeds them', async t => {
  // Seed registry: an extra kind 'client' entry rides the same
  // artifact gate, profile seed and overlay as the host packages — the
  // client-plugin seed mechanism (the loader row is id/name only; kind is
  // metadata).
  const dir = tempDir(t)
  const graphSource = stageSource(t, 'export const graph = 1\n')
  const clientSource = tempDir(t)
  mkdirSync(join(clientSource, 'dist'), { recursive: true })
  writeFileSync(join(clientSource, 'package.json'), JSON.stringify({ name: '@dsh-chamber/dsh-chamber-client-ui-test', version: '0.0.0', main: 'dist/index.js' }) + '\n')
  writeFileSync(join(clientSource, 'dist', 'index.js'), 'export const client = 1\n')
  const plane = hostGraphPlane(dir, {
    hostGraphPackageSourceDir: graphSource,
    extraSeedEntries: [{
      insert: { id: 'test-client', name: '@dsh-chamber/dsh-chamber-client-ui-test' },
      kind: 'client',
      source: 'packaged',
      sourceDir: clientSource,
    }],
  })
  try {
    await plane.start()
    await plane.startLocal()
    const overlay = readFileSync(join(dir, HOST_GRAPH_PATCH_FILENAME), 'utf8')
    assert.match(overlay, /- id: test-client/)
    assert.match(overlay, /name: '@dsh-chamber\/dsh-chamber-client-ui-test'/)
    assert.equal(
      readFileSync(join(dir, 'dsh-home', 'profiles', 'web', 'node_modules', '@dsh-chamber', 'dsh-chamber-client-ui-test', 'dist', 'index.js'), 'utf8'),
      'export const client = 1\n',
    )
  } finally {
    await plane.stop()
  }
})

test('createControlPlane.startLocal() skips an absent extra seed entry (stub) with a warn and no overlay row', async t => {
  // Seed registry: a packaged client seed entry can be absent on a branch;
  // until then an absent packaged source is a warned stub skip — the rest of
  // the seed (host packages) proceeds untouched, never a failure.
  const dir = tempDir(t)
  const source = stageSource(t, 'export const graph = 1\n')
  const warns: string[] = []
  const plane = hostGraphPlane(dir, {
    hostGraphPackageSourceDir: source,
    extraSeedEntries: [{
      insert: { id: 'test-client', name: '@dsh-chamber/dsh-chamber-client-ui-test' },
      kind: 'client',
      source: 'packaged',
      sourceDir: join(dir, 'no-test-client-package'),
    }],
    logger: { log() {}, warn: (message: unknown) => { warns.push(String(message)) }, error() {} },
  })
  try {
    await plane.start()
    await plane.startLocal()
    assert.equal(readFileSync(join(dir, HOST_GRAPH_PATCH_FILENAME), 'utf8'), EXPECTED_OVERLAY,
      'the absent stub row must not enter the overlay')
    assert.ok(warns.some(message => message.includes('test-client') && message.includes('stub')),
      'the absent stub entry is warned as a skipped stub')
  } finally {
    await plane.stop()
  }
})

// ---------------------------------------------------------------------------
// ensureSeedPackage (host graph): fail-loud on a source missing a declared file
// ---------------------------------------------------------------------------

test('ensureSeedPackage (host-graph) throws when the source exists but a declared file is missing', t => {
  const dshHome = tempDir(t)
  // dist/index.js present but package.json missing — the caller's gate (dist
  // artifact only) passes, so this is the shipped-but-broken module A case:
  // fail-loud, never a silent skip.
  const distOnly = tempDir(t)
  mkdirSync(join(distOnly, 'dist'), { recursive: true })
  writeFileSync(join(distOnly, 'dist', 'index.js'), 'export const v = 1\n')
  assert.throws(() => ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, distOnly), /missing in package/)
  // package.json present but dist/index.js missing — the same fail-loud
  // contract on the other declared file.
  const manifestOnly = tempDir(t)
  writeFileSync(join(manifestOnly, 'package.json'), JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME, version: '0.0.0', main: 'dist/index.js' }) + '\n')
  assert.throws(() => ensureSeedPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, manifestOnly), /missing in package/)
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
  // The gateway re-declares the synced host packages as
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
  const plane = hostGraphPlane(dir, {
    hostGraphPackageSourceDir: baseSource,
    extraSeedEntries: [{
      insert: HOST_GRAPH_INSERT,
      kind: 'host',
      source: 'desktop-synced',
      sourceDir: syncedSource,
      probeDomains: ['clientGraph/graph'],
    }],
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

// ---------------------------------------------------------------------------
// The fail-loud host-seed namespace pin
// ---------------------------------------------------------------------------

test('assertHostSeedInsertNaming pins the canonical dsh-chamber-seed-<loader-id> namespace', () => {
  assert.doesNotThrow(
    () => assertHostSeedInsertNaming([HOST_GRAPH_INSERT, HOST_GIT_WORKTREE_INSERT, HOST_ARCHIVE_CLEANUP_INSERT]),
  )
  // A pre-rename name under the SAME loader id — the row shape an upgraded
  // remote profile carries. The registry must refuse to seed it, not resolve
  // it silently.
  assert.throws(
    () => assertHostSeedInsertNaming([{ id: 'client-graph', name: '@dsh-chamber/dsh-host-client-graph' }]),
    /dsh-chamber-seed-<loader-id>/,
  )
  // Canonical prefix, wrong loader id: the suffix IS the loader id, so the
  // seeded directory, the overlay row and the activation-probe domain agree.
  assert.throws(
    () => assertHostSeedInsertNaming([{ id: 'git-worktree', name: '@dsh-chamber/dsh-chamber-seed-client-graph' }]),
    /dsh-chamber-seed-<loader-id>/,
  )
})

test('assertHostSeedEntryNaming binds kind host only — the client plugin seed is exempt', () => {
  const host = { insert: HOST_GRAPH_INSERT, kind: 'host' as const, source: 'packaged' as const, sourceDir: null }
  const client = {
    insert: { id: 'test-client', name: '@dsh-chamber/dsh-chamber-client-ui-test' },
    kind: 'client' as const,
    source: 'packaged' as const,
    sourceDir: null,
  }
  assert.doesNotThrow(() => assertHostSeedEntryNaming([host, client]))
  assert.throws(
    () => assertHostSeedEntryNaming([
      { ...host, insert: { id: 'client-graph', name: '@dsh-chamber/dsh-host-client-graph' } },
      client,
    ]),
    /dsh-chamber-seed-<loader-id>/,
  )
})

test('the seed registry refuses a non-canonical host entry before any profile write', async t => {
  const dir = tempDir(t)
  const plane = hostGraphPlane(dir, {
    hostGraphPackageSourceDir: stageSource(t),
    extraSeedEntries: [{
      insert: { id: 'client-graph', name: '@dsh-chamber/dsh-host-client-graph' },
      kind: 'host',
      source: 'desktop-synced',
      sourceDir: null,
    }],
  })
  try {
    // The registry is resolved at plane start (the artifact diagnostic loop)
    // and again per spawn — the non-canonical entry aborts the first of them.
    await assert.rejects(plane.start(), /dsh-chamber-seed-<loader-id>/)
    // Fail-loud happens before the seed writes: no overlay, no profile copy.
    assert.equal(existsSync(join(dir, HOST_GRAPH_PATCH_FILENAME)), false)
    assert.equal(existsSync(seedTarget(join(dir, 'dsh-home'))), false)
  } finally {
    await plane.stop()
  }
})

// ---------------------------------------------------------------------------
// C4 安全模式：DSH_CHAMBER_SAFE_MODE=1 → 不 seed 任何 chamber 宿主包、不传
// --patch、清遗留 overlay（「文件存在 ⟺ 本次 spawn 会传它」不变式）、期望集
// 发空集，且 dsh profile 一个字节都不写。
// ---------------------------------------------------------------------------

test('resolveLocalHostGraphOverlay: 安全模式跳过全部 seeding、清遗留 overlay、期望集为空', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir, true)
  const stale = join(dir, HOST_GRAPH_PATCH_FILENAME)
  writeFileSync(stale, EXPECTED_OVERLAY)
  const logs: string[] = []
  let domains: readonly string[] | null = null
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: ['clientGraph/graph'] }],
    env: { DSH_CHAMBER_SAFE_MODE: '1' },
    log: message => logs.push(message),
    warn() {},
    onSeededProbeDomains: next => { domains = next },
  })
  assert.equal(overlay, null, '安全模式不传 --patch')
  assert.equal(existsSync(stale), false, '遗留 overlay 必须清掉（存在 ⟺ 本次 spawn 会传它）')
  assert.deepEqual(domains === null ? null : [...domains], [],
    '期望集必须发空集（不得按上次的域做 exact-set 裁决）')
  assert.equal(existsSync(join(seedTarget(dshHome), 'package.json')), false, '安全模式一条 seed 都不写')
  assert.ok(logs.some(line => line.includes('安全模式')), '安全模式跳过必须 loud 一行')
})

test('resolveLocalHostGraphOverlay: 安全模式只认字面量 1（=0/缺省照常 seed，下次普通启动自动恢复）', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir, true)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: [] }],
    env: { DSH_CHAMBER_SAFE_MODE: '0' },
    log() {},
    warn() {},
  })
  assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME), '=0 不是安全模式：照常写 overlay')
  assert.equal(existsSync(join(seedTarget(dshHome), 'dist', 'index.js')), true, '照常 seed')
})

test('hostGraphPlane({safeMode:true}).startLocal(): 宿主包 seeding 整体跳过（端到端开关）', async t => {
  const dir = tempDir(t)
  const source = stageSource(t, 'export const v = 1\n')
  // 共享夹具 hostGraphPlane（main 的 test/support/utils.ts）已提供 stateDir/port/四个
  // 缺省 sourceDir/logger/localConnectionDeps；这里只覆盖 seed 源与安全模式开关。
  const plane = hostGraphPlane(dir, { hostGraphPackageSourceDir: source, safeMode: true })
  try {
    await plane.start()
    await plane.startLocal()
    assert.equal(existsSync(join(dir, HOST_GRAPH_PATCH_FILENAME)), false, '安全模式下没有 overlay')
    assert.deepEqual([...plane.seededProbeDomains], [], '安全模式下期望集为空')
    assert.equal(existsSync(seedTarget(join(dir, 'dsh-home'))), false, '安全模式下 dsh profile 不写 seed')
  } finally {
    await plane.stop()
  }
})
// ---------------------------------------------------------------------------
// Swift local startup upstream rows: the rendered startup block is a second
// top-level `- insert:` patch object appended AFTER the chamber rows; the resolver
// composes startup-only / combined overlays and keeps the "file exists ⟺ this spawn
// passes it" invariant when the rows disappear. Pure-module pins (the planner/renderer
// suite owns the gate matrix).
// ---------------------------------------------------------------------------

/** A workspace + payload + office-assets fixture the startup planner accepts. */
interface StartupPluginFixture {
  readonly workspace: string
  readonly primaryRuntimeDir: string
  readonly officeSkillsDir: string
  readonly capabilities: { readonly primaryRuntimeDir: string; readonly officeSkillsDir: string }
}

function writeStartupPluginFixture(dir: string): StartupPluginFixture {
  const workspace = join(dir, 'workspace')
  const primaryRuntimeDir = join(dir, 'primary-runtime')
  const officeSkillsDir = join(dir, 'office-skills')
  mkdirSync(join(primaryRuntimeDir, 'dependencies', 'python', 'bin'), { recursive: true })
  mkdirSync(join(primaryRuntimeDir, 'dependencies', 'python', 'lib', 'python3.12', 'site-packages'), { recursive: true })
  mkdirSync(join(primaryRuntimeDir, 'dependencies', 'node', 'bin'), { recursive: true })
  writeFileSync(join(primaryRuntimeDir, 'runtime.json'), JSON.stringify({ platform: process.platform, arch: process.arch, python: '3.12.14' }))
  writeFileSync(join(primaryRuntimeDir, 'dependencies', 'python', 'bin', 'python3'), '#!/usr/bin/env python3\n')
  writeFileSync(join(primaryRuntimeDir, 'dependencies', 'node', 'bin', 'node'), '#!/usr/bin/env node\n')
  // rc.2: four skill directories (no render/recalculate/export-pdf, no sidecar.md).
  for (const skill of ['office', 'office-docx', 'office-pptx', 'office-xlsx']) {
    mkdirSync(join(officeSkillsDir, skill), { recursive: true })
    writeFileSync(join(officeSkillsDir, skill, 'SKILL.md'), '---\ndescription: ' + skill + '\n---\n')
  }
  for (const name of ['dsh-tool-workspace-dependencies', 'dsh-skill-office']) {
    const packageDir = join(workspace, 'node_modules', '@deepseek-ai', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name }))
  }
  return {
    workspace,
    primaryRuntimeDir,
    officeSkillsDir,
    capabilities: { primaryRuntimeDir, officeSkillsDir },
  }
}

/** The rc.2 web-app office row the local overlay force-disables when mounting its own. */
const WEB_APP_SKILL_OFFICE_DISABLE_ROW = `- id: skill-office
  name: '@deepseek-ai/dsh-skill-office'
  disabled: true
`

/** Install a profile-layer web-app bundle whose patch declares the skill-office row. */
function enableWebAppBundle(
  dshHome: string,
  patch = "- insert:\n    - id: skill-office\n      name: '@deepseek-ai/dsh-skill-office'\n",
): void {
  const packageDir = join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-web-app')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-web-app',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(packageDir, 'cordis.patch.yml'), patch)
}

/** The exact startup block the Swift planner produces for the fixture above. */
function expectedStartupBlock(fixture: StartupPluginFixture, dshHome: string): string {
  return '- insert:\n'
    + "    - id: chamber-workspace-dependencies\n      name: '@deepseek-ai/dsh-tool-workspace-dependencies'\n      config:\n"
    + `        source: '${fixture.primaryRuntimeDir}'\n`
    + `        root: '${join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime')}'\n`
    + "    - id: chamber-office-skills\n      name: '@deepseek-ai/dsh-skill-office'\n      config:\n"
    + `        assetRoot: '${fixture.officeSkillsDir}'\n`
}

test('buildPatchOverlay: the 4th startupOverlayText appends after the chamber rows; 3-arg bytes stay canonical', t => {
  const dir = tempDir(t)
  const path = join(dir, HOST_GRAPH_PATCH_FILENAME)
  const startup = "- insert:\n    - id: chamber-office-skills\n      name: '@deepseek-ai/dsh-skill-office'\n      config:\n        assetRoot: '/tmp/office'\n        cli: false\n"
  buildPatchOverlay(dir, [HOST_GRAPH_INSERT], [], startup)
  assert.equal(readFileSync(path, 'utf8'), EXPECTED_OVERLAY + startup,
    'the startup block is the overlay array\'s second patch object')
  buildPatchOverlay(dir)
  assert.equal(readFileSync(path, 'utf8'), EXPECTED_OVERLAY,
    'the legacy 3-arg call keeps the canonical bytes byte-for-byte')
})

test('buildPatchOverlay: startup-only and disable+startup overlays are valid patch lists', t => {
  const dir = tempDir(t)
  const path = join(dir, HOST_GRAPH_PATCH_FILENAME)
  const startup = "- insert:\n    - id: chamber-workspace-dependencies\n      name: '@deepseek-ai/dsh-tool-workspace-dependencies'\n      config:\n        source: '/tmp/runtime'\n        root: '/tmp/root'\n"
  const startupOnly = buildPatchOverlay(dir, [], [], startup)
  assert.equal(readFileSync(startupOnly, 'utf8'), startup,
    'startup-only: the chamber insert renderer is skipped, not called with an empty list')
  buildPatchOverlay(dir, [], [OFFICIAL_OPEN_IN_DISABLE], startup)
  assert.equal(readFileSync(path, 'utf8'), OFFICIAL_OPEN_IN_DISABLE_ROW + startup,
    'the id-targeted disable stays ahead of the startup insert object')
  assert.throws(
    () => buildPatchOverlay(dir, [], [], ''),
    /overlay requires at least one row/,
    'a wholly empty overlay still fails with the historical message',
  )
})

test('resolveLocalHostGraphOverlay: startup capabilities alone yield a startup-only overlay', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const fixture = writeStartupPluginFixture(dir)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    dshWorkspacePath: fixture.workspace,
    entries: [],
    startupPluginCapabilities: fixture.capabilities,
    // Pin the startup-only composition here; the web-app office-row disable is covered
    // by its own integration case below (an installed bundle package is required to prove it).
    bundleRowDisables: [],
    log() {},
    warn() {},
  })
  assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME))
  assert.equal(readFileSync(overlay as string, 'utf8'), expectedStartupBlock(fixture, dshHome),
    'the startup block is rendered as the overlay\'s second top-level insert object')
  assert.ok(!readFileSync(overlay as string, 'utf8').includes('client-graph'),
    'startup-only: no chamber seed rows are invented')
})

test('resolveLocalHostGraphOverlay: startup rows append after the chamber insert bundle', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const fixture = writeStartupPluginFixture(dir)
  const sourceDir = writeBuiltSeedSource(dir, true)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    dshWorkspacePath: fixture.workspace,
    entries: [{ insert: HOST_GRAPH_INSERT, kind: 'host', source: 'packaged', sourceDir, probeDomains: [] }],
    startupPluginCapabilities: fixture.capabilities,
    bundleRowDisables: [],
    log() {},
    warn() {},
  })
  const text = readFileSync(overlay as string, 'utf8')
  assert.ok(text.startsWith(EXPECTED_OVERLAY), text)
  assert.ok(text.indexOf('client-graph') < text.indexOf('chamber-workspace-dependencies'), text)
  assert.ok(text.includes("id: chamber-office-skills"), text)
})

test('resolveLocalHostGraphOverlay: startup rows disappearing clear the previous overlay', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const fixture = writeStartupPluginFixture(dir)
  const stale = join(dir, HOST_GRAPH_PATCH_FILENAME)
  const first = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    dshWorkspacePath: fixture.workspace,
    entries: [],
    startupPluginCapabilities: fixture.capabilities,
    bundleRowDisables: [],
    log() {},
    warn() {},
  })
  assert.equal(first, stale, 'the startup rows need a --patch file')
  const second = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    dshWorkspacePath: fixture.workspace,
    entries: [],
    log() {},
    warn() {},
  })
  assert.equal(second, null, 'with no capability roots the spawn passes no --patch')
  assert.equal(existsSync(stale), false,
    'a leftover overlay would report rows this spawn does not mount')
})

test('resolveLocalHostGraphOverlay: the rc.2 web-app office row is disabled beside the local office row', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const fixture = writeStartupPluginFixture(dir)
  enableWebAppBundle(dshHome)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    dshWorkspacePath: fixture.workspace,
    entries: [],
    startupPluginCapabilities: fixture.capabilities,
    log() {},
    warn() {},
  })
  assert.equal(
    readFileSync(overlay as string, 'utf8'),
    WEB_APP_SKILL_OFFICE_DISABLE_ROW + expectedStartupBlock(fixture, dshHome),
    'the bundle duplicate is force-disabled ahead of the startup insert object (two live skill-office mounts would throw)',
  )
})

test('resolveLocalHostGraphOverlay: an incomplete office asset tree never over-disables the bundle row', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const fixture = writeStartupPluginFixture(dir)
  rmSync(fixture.officeSkillsDir, { recursive: true, force: true })
  enableWebAppBundle(dshHome)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    dshWorkspacePath: fixture.workspace,
    entries: [],
    startupPluginCapabilities: fixture.capabilities,
    log() {},
    warn() {},
  })
  const text = readFileSync(overlay as string, 'utf8')
  assert.equal(text.includes(`id: ${WEB_APP_SKILL_OFFICE_ROW.id}`), false,
    'the local office row is skipped, so the bundle row must stay enabled (no over-disable)')
  assert.equal(text.includes('chamber-office-skills'), false, 'no half office row is mounted')
  assert.ok(text.includes('chamber-workspace-dependencies'), 'the independent payload row still mounts')
})

test('resolveLocalHostGraphOverlay: a user-layer skill-office row is a live mount and disables the bundle duplicate', t => {
  const dir = tempDir(t)
  const userPatch = "- insert:\n    - id: user-office-skills\n      name: '@deepseek-ai/dsh-skill-office'\n"
  const dshHome = writeLocalProfileFixture(dir, userPatch)
  const fixture = writeStartupPluginFixture(dir)
  enableWebAppBundle(dshHome)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    dshWorkspacePath: fixture.workspace,
    entries: [],
    startupPluginCapabilities: fixture.capabilities,
    log() {},
    warn() {},
  })
  const text = readFileSync(overlay as string, 'utf8')
  assert.ok(text.includes(`- id: ${WEB_APP_SKILL_OFFICE_ROW.id}\n`),
    'a user-mounted skill-office row needs the same duplicate guard as the planner row')
  assert.equal(text.includes('chamber-office-skills'), false,
    'the planner reuses the user identity instead of repeating it')
})

test('resolveLocalHostGraphOverlay: an OLDER runtime without the bundle office row still spawns (rollback safety)', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const fixture = writeStartupPluginFixture(dir)
  // rc.1 web-app mounts only office-to-pdf: no skill-office row to disable.
  enableWebAppBundle(dshHome, "- insert:\n    - id: office-to-pdf\n      name: '@deepseek-ai/dsh-office-to-pdf'\n")
  const logs: string[] = []
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    dshWorkspacePath: fixture.workspace,
    entries: [],
    startupPluginCapabilities: fixture.capabilities,
    log: message => logs.push(message),
    warn() {},
  })
  const text = readFileSync(overlay as string, 'utf8')
  assert.equal(text.includes('- id: skill-office'), false, 'nothing to disable in the older runtime')
  assert.ok(text.includes('chamber-office-skills'), 'the local office row is still mounted')
  assert.ok(logs.some(message => message.includes('nothing to disable')), logs.join(' | '))
})

test('resolveLocalHostGraphOverlay: safe mode suppresses startup rows and clears the overlay', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const fixture = writeStartupPluginFixture(dir)
  const stale = join(dir, HOST_GRAPH_PATCH_FILENAME)
  writeFileSync(stale, expectedStartupBlock(fixture, dshHome))
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    dshWorkspacePath: fixture.workspace,
    entries: [],
    startupPluginCapabilities: fixture.capabilities,
    safeMode: true,
    log() {},
    warn() {},
  })
  assert.equal(overlay, null, '安全模式不传 --patch')
  assert.equal(existsSync(stale), false, '安全模式必须清掉遗留 overlay')
})
