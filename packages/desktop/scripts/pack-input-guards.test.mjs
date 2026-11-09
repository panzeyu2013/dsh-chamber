import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PACK_INPUT_REBUILD_COMMANDS,
  assertPackArtifactsFresh,
  inspectPackArtifacts,
} from './pack-input-guards.mjs'
import {
  WEB_DIST_INPUT_PACKAGE_DIRS,
  hostPackageArtifactId,
  hostPackageInputFiles,
  hostPackageToolVersion,
  writeBuildManifest,
  writeWebDistBuildManifest,
} from './build-manifest.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SIDECAR_SCRIPT = join(REPO_ROOT, 'packages', 'desktop', 'scripts', 'build-sidecar.mjs')
const BEFORE_PACK_SCRIPT = join(REPO_ROOT, 'packages', 'desktop', 'scripts', 'before-pack.mjs')

const put = (root, relativePath, text) => {
  const file = join(root, relativePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}
const setMtime = (file, ms) => utimesSync(file, new Date(ms), new Date(ms))

/**
 * A complete fixture: every declared fresh-check input exists, and all four
 * artifacts are written AFTER their inputs (with G3 manifests where the writer
 * owns them). Returns the paths the assertions reuse to make one artifact stale.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-inputs-'))
  const desktopDir = join(root, 'packages', 'desktop')
  // ---- dist/web inputs (same closure rules the production builder uses) ----
  for (const packageDir of WEB_DIST_INPUT_PACKAGE_DIRS) {
    put(root, join(packageDir, 'src', 'index.ts'), 'export const value = 1\n')
    put(root, join(packageDir, 'package.json'), JSON.stringify({ name: packageDir.split('/').pop() }))
  }
  put(root, 'packages/renderer/src/app.tsx', 'export const app = 1\n')
  put(root, 'packages/renderer/scripts/pipeline.mjs', 'export const pipeline = 1\n')
  put(root, 'packages/renderer/index.html', '<!doctype html>\n')
  put(root, 'packages/renderer/vite.config.mjs', 'export default {}\n')
  put(root, 'packages/renderer/node_modules/vite/package.json', JSON.stringify({ version: '6.4.3' }))
  put(root, 'packages/desktop/scripts/build-manifest.mjs', '// fixture\n')
  put(root, 'packages/desktop/scripts/build-host-graph-package.mjs', '// fixture\n')
  put(root, 'harness.commit', 'fixture-pin\n')
  // ---- preload / control-plane inputs (mtime freshness) ----
  for (const file of [
    'packages/desktop/electron/preload.cts',
    'packages/desktop/transport-provider.ts',
    'packages/desktop/ssh-config.ts',
    'packages/desktop/updater.ts',
    'packages/desktop/dsh-runtime-controller.ts',
    'packages/desktop/ipc-events.ts',
    'packages/desktop/scripts/build-preload.mjs',
    'packages/desktop/tsconfig.preload.build.json',
    'packages/control-plane/src/index.ts',
    'packages/dsh-chamber-wire/src/index.ts',
    'packages/desktop/scripts/build-control-plane.mjs',
    'packages/desktop/tsconfig.control-plane.build.json',
    'tsconfig.json',
  ]) put(root, file, '// fixture\n')
  // ---- artifacts, written after their inputs ----
  put(root, 'packages/desktop/dist/web/index.html', '<!doctype html><title>fixture</title>\n')
  put(root, 'packages/desktop/dist/web/assets/main.js', 'export const main = 1\n')
  writeWebDistBuildManifest({ webDistDir: join(desktopDir, 'dist', 'web'), root })
  put(root, 'packages/desktop/dist/control-plane/index.js', 'export const controlPlane = 1\n')
  put(root, 'packages/desktop/dist/preload.cjs', 'exports.preload = 1\n')
  // ---- host package rows (fixture rows: the production rows name real dirs) ----
  const sourceDir = join(root, 'packages', 'dsh-chamber-seed-fixture')
  const outDir = join(desktopDir, 'dist', 'host-fixture-package')
  put(root, 'packages/dsh-chamber-seed-fixture/package.json', JSON.stringify({ name: 'seed-fixture' }))
  put(root, 'packages/dsh-chamber-seed-fixture/dist/index.js', 'export const host = 1\n')
  mkdirSync(outDir, { recursive: true })
  put(root, 'packages/desktop/dist/host-fixture-package/package.json', JSON.stringify({ name: 'seed-fixture' }))
  put(root, 'packages/desktop/dist/host-fixture-package/dist/index.js', 'export const host = 1\n')
  writeBuildManifest(outDir, {
    artifactId: hostPackageArtifactId(outDir),
    inputs: hostPackageInputFiles(sourceDir, { root }),
    toolVersion: hostPackageToolVersion(),
  })
  const rows = [{ label: 'fixture', sourceDir, outDir }]
  return { root, desktopDir, rows, sourceDir, outDir }
}

const guardOptions = (fixtureValue, extra = {}) => ({ root: fixtureValue.root, desktopDir: fixtureValue.desktopDir, rows: fixtureValue.rows, ...extra })

test('electron-pack mode: all four artifacts fresh', () => {
  const f = fixture()
  try {
    const verdicts = inspectPackArtifacts(guardOptions(f, { mode: 'electron-pack' }))
    assert.deepEqual(verdicts.map((verdict) => verdict.id), [
      'dist/web',
      'dist/preload.cjs',
      'dist/control-plane',
      'desktop/dist/host-*-package',
    ])
    for (const verdict of verdicts) assert.equal(verdict.status, 'fresh', verdict.id + ': ' + verdict.detail)
    assert.doesNotThrow(() => assertPackArtifactsFresh(guardOptions(f, { mode: 'electron-pack', log: () => {} })))
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('sidecar mode only judges the artifacts the shipped leg consumes (web + control-plane)', () => {
  const f = fixture()
  try {
    const verdicts = inspectPackArtifacts(guardOptions(f, { mode: 'sidecar' }))
    assert.deepEqual(verdicts.map((verdict) => verdict.id), ['dist/web', 'dist/control-plane'])
    // an Electron-only artifact being stale must not block the Swift leg
    setMtime(join(f.desktopDir, 'dist', 'preload.cjs'), Date.now() - 7 * 24 * 3600 * 1000)
    put(f.root, 'packages/dsh-chamber-seed-fixture/dist/index.js', 'export const host = 2\n')
    assert.doesNotThrow(() => assertPackArtifactsFresh(guardOptions(f, { mode: 'sidecar', log: () => {} })))
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('stale dist/web input fails the guard and the message names the rebuild command', () => {
  const f = fixture()
  try {
    const changed = join(f.root, 'packages', 'renderer', 'src', 'app.tsx')
    writeFileSync(changed, 'export const app = 2\n')
    const future = new Date(Date.now() + 5000)
    utimesSync(changed, future, future)
    assert.throws(
      () => assertPackArtifactsFresh(guardOptions(f, { mode: 'sidecar', log: () => {} })),
      (error) => error instanceof Error
        && /dist\/web/.test(error.message)
        && error.message.includes(PACK_INPUT_REBUILD_COMMANDS.web)
        && /输入摘要不一致/.test(error.message),
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('stale control-plane mtime fails the guard with the control-plane rebuild command', () => {
  const f = fixture()
  try {
    setMtime(join(f.desktopDir, 'dist', 'control-plane', 'index.js'), Date.now() - 3600 * 1000)
    assert.throws(
      () => assertPackArtifactsFresh(guardOptions(f, { mode: 'sidecar', log: () => {} })),
      (error) => error instanceof Error
        && /dist\/control-plane/.test(error.message)
        && error.message.includes(PACK_INPUT_REBUILD_COMMANDS.controlPlane),
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('stale preload and stale host package fail the strict electron-pack mode', () => {
  const f = fixture()
  try {
    setMtime(join(f.desktopDir, 'dist', 'preload.cjs'), Date.now() - 3600 * 1000)
    writeFileSync(join(f.sourceDir, 'dist', 'index.js'), 'export const host = 3\n')
    assert.throws(
      () => assertPackArtifactsFresh(guardOptions(f, { mode: 'electron-pack', log: () => {} })),
      (error) => error instanceof Error
        && error.message.includes(PACK_INPUT_REBUILD_COMMANDS.preload)
        && error.message.includes(PACK_INPUT_REBUILD_COMMANDS.hostPackages)
        && /dist\/preload\.cjs/.test(error.message)
        && /host-\*-package/.test(error.message),
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('the host package row set cannot shrink silently (one missing directory = stale)', () => {
  const f = fixture()
  try {
    // A second row stays present, so the aggregate verdict cannot degrade to
    // "all missing" — the vanished row must be reported as stale.
    const source2 = join(f.root, 'packages', 'dsh-chamber-seed-fixture2')
    const out2 = join(f.desktopDir, 'dist', 'host-other-package')
    put(f.root, 'packages/dsh-chamber-seed-fixture2/package.json', JSON.stringify({ name: 'seed-fixture2' }))
    put(f.root, 'packages/dsh-chamber-seed-fixture2/dist/index.js', 'export const host2 = 1\n')
    put(f.root, 'packages/desktop/dist/host-other-package/package.json', JSON.stringify({ name: 'seed-fixture2' }))
    put(f.root, 'packages/desktop/dist/host-other-package/dist/index.js', 'export const host2 = 1\n')
    writeBuildManifest(out2, {
      artifactId: hostPackageArtifactId(out2),
      inputs: hostPackageInputFiles(source2, { root: f.root }),
      toolVersion: hostPackageToolVersion(),
    })
    const rows = [...f.rows, { label: 'other', sourceDir: source2, outDir: out2 }]
    rmSync(f.outDir, { recursive: true, force: true })
    const verdict = inspectPackArtifacts({ ...guardOptions(f), rows, mode: 'electron-pack' }).find((entry) => entry.id === 'desktop/dist/host-*-package')
    assert.equal(verdict.status, 'stale')
    assert.match(verdict.detail, /缺/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('fresh-checkout absence: default is a loud SKIP, requirePresence turns it into a red', () => {
  const f = fixture()
  const logs = []
  try {
    rmSync(join(f.desktopDir, 'dist'), { recursive: true, force: true })
    const verdicts = inspectPackArtifacts(guardOptions(f, { mode: 'electron-pack' }))
    assert.deepEqual(verdicts.map((verdict) => verdict.status), ['missing', 'missing', 'missing', 'missing'])
    assert.doesNotThrow(() => assertPackArtifactsFresh(guardOptions(f, { mode: 'electron-pack', log: (line) => logs.push(line) })))
    assert.ok(logs.filter((line) => /SKIP/.test(line)).length === 4, logs.join('\n'))
    assert.ok(logs.every((line) => /重建：/.test(line)), 'every SKIP names the rebuild command')
    assert.throws(
      () => assertPackArtifactsFresh(guardOptions(f, { mode: 'electron-pack', requirePresence: true, log: () => {} })),
      /打包前输入断言失败（4 项）/,
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('unknown mode is rejected instead of silently judging nothing', () => {
  const f = fixture()
  try {
    assert.throws(() => inspectPackArtifacts(guardOptions(f, { mode: 'wishful' })), /未知 mode/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('wiring lock: the shipped sidecar CLI runs the guard after a successful assembly; before-pack stays untouched (frozen)', () => {
  const sidecar = readFileSync(SIDECAR_SCRIPT, 'utf8')
  assert.match(sidecar, /import \{ assertPackArtifactsFresh \} from '\.\/pack-input-guards\.mjs'/)
  const wrapper = sidecar.indexOf('const result = await runBuildSidecar(options)')
  const guardCall = sidecar.indexOf("assertPackArtifactsFresh({ mode: 'sidecar' })")
  assert.ok(wrapper !== -1, 'the CLI run wrapper must call runBuildSidecar')
  assert.ok(guardCall > wrapper, 'the guard must run AFTER a successful assembly (non-dry-run only)')
  assert.match(sidecar, /result\.dryRun !== true/, 'dry-run must not be judged (it does not write or package anything)')
  // Electron freeze (docs/progress/electron-frozen.md §2/§5.1): before-pack.mjs is
  // archived read-only; G5 must not be wired there without a user scope reopening.
  const beforePack = readFileSync(BEFORE_PACK_SCRIPT, 'utf8')
  assert.ok(!beforePack.includes('pack-input-guards'), 'before-pack.mjs is frozen — do not wire G5 into it without a scope reopening')
  assert.ok(existsSync(join(REPO_ROOT, 'docs', 'progress', 'electron-frozen.md')))
})
