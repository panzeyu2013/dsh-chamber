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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPatchOverlay,
  ensureHostGraphPackage,
  HOST_GRAPH_PACKAGE_NAME,
  HOST_GRAPH_PATCH_FILENAME,
} from '../src/host-graph-seed.ts'
import { webProfileArgs } from '../src/spawn-dsh.ts'
import { createLocalConnection } from '../src/local-connection.ts'
import { createControlPlane } from '../src/index.ts'
import type { SpawnedDsh } from '../src/local-connection.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

/**
 * The canonical overlay content the seed writes (mirror of the module).
 *
 * Validation note (④): the assertions below are byte-exact against the
 * module's single-sourced constant HOST_GRAPH_PATCH_OVERLAY — the strongest
 * check available here, because the overlay's boot-time authority
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

test('ensureHostGraphPackage returns false without touching the profile when the source package is absent', t => {
  const dshHome = tempDir(t)
  assert.equal(ensureHostGraphPackage(dshHome, join(dshHome, 'no-such-package')), false)
  assert.equal(existsSync(seedTarget(dshHome)), false)
})

// ---------------------------------------------------------------------------
// webProfileArgs (--patch injection)
// ---------------------------------------------------------------------------

test('webProfileArgs keeps the v4 flag set when no patch overlay is given', () => {
  assert.deepEqual(webProfileArgs(17510), [
    '--profile', 'web', '--host', '127.0.0.1', '--port', '17510', '--trusted-host', '127.0.0.1:17510',
  ])
  // Empty string is treated as absent (callers may resolve a nullable config).
  assert.deepEqual(webProfileArgs(17510, ''), webProfileArgs(17510))
})

test('webProfileArgs injects --patch before the web app flags when a patch overlay is given', () => {
  assert.deepEqual(webProfileArgs(17511, '/tmp/dsh-chamber-graph.patch.yml'), [
    '--profile', 'web', '--patch', '/tmp/dsh-chamber-graph.patch.yml',
    '--host', '127.0.0.1', '--port', '17511', '--trusted-host', '127.0.0.1:17511',
  ])
})

// ---------------------------------------------------------------------------
// createLocalConnection: the resolved patchPath reaches every spawn
// ---------------------------------------------------------------------------

function mockCatalog() {
  const rows = new Map<string, any>()
  return {
    getConnection: (id: string | null) => rows.get(id ?? 'local') ?? null,
    upsertConnection: (row: any) => { rows.set(row.connectionId, row) },
  }
}

function mockSpawned(): SpawnedDsh {
  return { child: { on() {}, exitCode: null }, port: 17510, stop: async () => {} }
}

test('createLocalConnection passes the resolved patchPath to the spawn fn', async t => {
  const dir = tempDir(t)
  const spawnOptions: Array<{ patchPath?: string | null }> = []
  const connection = createLocalConnection({
    stateDir: dir,
    dshHome: join(dir, 'dsh-home'),
    dshWorkspacePath: join(dir, 'dsh'),
    catalog: mockCatalog(),
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
    port: 17510,
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
    catalog: mockCatalog(),
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
// createControlPlane.start(): the seed orchestration gate (dist present /
// absent — a fake hostGraphPackageSourceDir covers both branches)
// ---------------------------------------------------------------------------

test('createControlPlane.start() seeds the host package and materializes the overlay when dist/index.js exists', async t => {
  const dir = tempDir(t)
  const source = stageSource(t, 'export const v = 1\n')
  const plane = createControlPlane({
    stateDir: dir,
    port: 0,
    dshWorkspacePath: join(dir, 'dsh'),
    hostGraphPackageSourceDir: source,
    logger: silentLogger,
  })
  try {
    await plane.start()
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

test('createControlPlane.start() keeps the v4 baseline when dist/index.js is absent', async t => {
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
    logger: silentLogger,
  })
  try {
    await plane.start()
    assert.equal(existsSync(join(dir, HOST_GRAPH_PATCH_FILENAME)), false)
    assert.equal(existsSync(seedTarget(join(dir, 'dsh-home'))), false)
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
  assert.throws(() => ensureHostGraphPackage(dshHome, distOnly), /missing in module A package/)
  // package.json present but dist/index.js missing — the same fail-loud
  // contract on the other declared file.
  const manifestOnly = tempDir(t)
  writeFileSync(join(manifestOnly, 'package.json'), JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME, version: '0.0.0', main: 'dist/index.js' }) + '\n')
  assert.throws(() => ensureHostGraphPackage(dshHome, manifestOnly), /missing in module A package/)
})
