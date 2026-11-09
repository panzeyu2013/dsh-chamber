import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILD_MANIFEST_FILE,
  BUILD_MANIFEST_SCHEMA_VERSION,
  WEB_DIST_ARTIFACT_ID,
  WEB_DIST_INPUT_PACKAGE_DIRS,
  digestEntries,
  hostPackageArtifactId,
  hostPackageInputFiles,
  hostPackageToolVersion,
  sha256File,
  verifyBuildManifest,
  webDistInputFiles,
  webDistToolVersion,
  writeBuildManifest,
  writeHostPackageBuildManifest,
  writeWebDistBuildManifest,
} from './build-manifest.mjs'
import { HOST_PACKAGE_BUILD_ROWS } from './build-host-graph-package.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Write a file (creating its parent dirs). */
function put(root, relativePath, text) {
  const file = join(root, relativePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

/**
 * A minimal workspace-shaped fixture root: every declared dist/web input root
 * exists, a vite version is resolvable through the renderer tree, and the
 * builder files the production rules name are present as stub content.
 */
function webFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-manifest-'))
  for (const packageDir of WEB_DIST_INPUT_PACKAGE_DIRS) {
    put(root, join(packageDir, 'src', 'index.ts'), 'export const value = 1\n')
    put(root, join(packageDir, 'package.json'), JSON.stringify({ name: packageDir.split('/').pop(), version: '0.0.0' }))
  }
  put(root, 'packages/renderer/src/app.tsx', 'export const app = 1\n')
  put(root, 'packages/renderer/scripts/pipeline.mjs', 'export const pipeline = 1\n')
  put(root, 'packages/renderer/index.html', '<!doctype html>\n')
  put(root, 'packages/renderer/vite.config.mjs', 'export default {}\n')
  put(root, 'packages/renderer/node_modules/vite/package.json', JSON.stringify({ version: '6.4.3' }))
  put(root, 'packages/desktop/scripts/build-manifest.mjs', '// fixture builder stub\n')
  put(root, 'packages/desktop/scripts/build-host-graph-package.mjs', '// fixture builder stub\n')
  put(root, 'harness.commit', 'fixture-pin\n')
  const webDist = join(root, 'packages', 'desktop', 'dist', 'web')
  put(root, 'packages/desktop/dist/web/index.html', '<!doctype html><title>fixture</title>\n')
  put(root, 'packages/desktop/dist/web/assets/main-abc.js', 'export const main = 1\n')
  put(root, 'packages/desktop/dist/web/perf-sizes.json', '{}\n')
  return { root, webDist }
}

/** A host package fixture: source seed package (package.json + dist) + target dir name. */
function hostFixture(root) {
  const sourceDir = join(root, 'packages', 'dsh-chamber-seed-fixture')
  const outDir = join(root, 'packages', 'desktop', 'dist', 'host-fixture-package')
  put(root, 'packages/dsh-chamber-seed-fixture/package.json', JSON.stringify({ name: 'seed-fixture' }))
  put(root, 'packages/dsh-chamber-seed-fixture/dist/index.js', 'export const host = 1\n')
  mkdirSync(outDir, { recursive: true })
  const rows = [{ label: 'fixture', sourceDir, outDir }]
  return { sourceDir, outDir, rows }
}

/** Move mtime forward so "modified after build" diagnostics are deterministic. */
function touchFuture(file, seconds = 5) {
  const at = new Date(Date.now() + seconds * 1000)
  utimesSync(file, at, at)
}

test('webDistInputFiles: walks the declared closure and excludes tests/docs/node_modules', () => {
  const { root, webDist } = webFixture()
  try {
    put(root, 'packages/renderer/src/ignored.test.ts', 'test only\n')
    put(root, 'packages/renderer/src/README.md', 'docs\n')
    put(root, 'packages/renderer/node_modules/vite/package.json', JSON.stringify({ version: '6.4.3' }))
    const entries = webDistInputFiles({ root })
    const paths = entries.map((entry) => entry.path)
    assert.ok(paths.includes('packages/renderer/src/app.tsx'), 'renderer source is a build input')
    assert.ok(paths.includes('packages/renderer/scripts/pipeline.mjs'), 'the renderer build pipeline is a build input')
    assert.ok(paths.includes('packages/renderer/index.html'))
    assert.ok(paths.includes('packages/renderer/vite.config.mjs'))
    assert.ok(paths.includes('packages/desktop/scripts/build-manifest.mjs'), 'the manifest rules themselves are an input')
    assert.ok(paths.includes('harness.commit'), 'the declared vendor pin is an input')
    assert.ok(paths.includes('packages/dsh-chamber-client-core/src/index.ts'), 'workspace client kernel sources are inputs')
    assert.ok(!paths.some((path) => path.includes('node_modules')), 'installed dependencies never hash into the input digest')
    assert.ok(!paths.some((path) => path.endsWith('.test.ts')), 'test sources never hash into the input digest')
    assert.ok(!paths.some((path) => path.endsWith('.md')), 'docs never hash into the input digest')
    assert.deepEqual(paths, [...paths].sort(), 'entries are deterministically sorted')
    // every entry carries the content hash + mtime used by the digest/diagnostics
    for (const entry of entries) {
      assert.match(entry.sha256, /^[0-9a-f]{64}$/)
      assert.equal(typeof entry.mtimeMs, 'number')
    }
    assert.ok(existsSync(webDist))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('webDistInputFiles: a declared input root disappearing is a hard error (not "no inputs")', () => {
  const { root } = webFixture()
  try {
    rmSync(join(root, 'packages', 'dsh-chamber-client-ui-git'), { recursive: true, force: true })
    assert.throws(() => webDistInputFiles({ root }), /输入包不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('digestEntries: content-addressed, order independent, set sensitive', () => {
  const a = { path: 'a.ts', sha256: sha256File(put(mkdtempSync(join(tmpdir(), 'dsh-digest-')), 'a.ts', 'a\n')) }
  const b = { path: 'b.ts', sha256: 'b'.repeat(64) }
  assert.equal(digestEntries([a, b]), digestEntries([b, a]), 'input order never changes the digest')
  assert.notEqual(digestEntries([a, b]), digestEntries([a]), 'removing an input changes the digest')
  assert.notEqual(digestEntries([a, b]), digestEntries([{ ...a, sha256: 'c'.repeat(64) }, b]), 'changing one input changes the digest')
})

test('write → verify round trip: ok, outputs exclude the manifest itself, schema is the contract', () => {
  const { root, webDist } = webFixture()
  try {
    const manifest = writeWebDistBuildManifest({ webDistDir: webDist, root })
    assert.equal(manifest.schemaVersion, BUILD_MANIFEST_SCHEMA_VERSION)
    assert.equal(manifest.artifactId, WEB_DIST_ARTIFACT_ID)
    assert.match(String(manifest.inputsHash), /^sha256:[0-9a-f]{64}$/)
    assert.equal(manifest.inputsCount, webDistInputFiles({ root }).length)
    assert.match(String(manifest.toolVersion), /^web-build\/1 /)
    const outputPaths = manifest.outputs.map((entry) => entry.path)
    assert.ok(outputPaths.includes('index.html'))
    assert.ok(outputPaths.includes('assets/main-abc.js'))
    assert.ok(outputPaths.includes('perf-sizes.json'))
    assert.ok(!outputPaths.includes(BUILD_MANIFEST_FILE), 'the manifest never fingerprints itself')
    const stored = JSON.parse(readFileSync(join(webDist, BUILD_MANIFEST_FILE), 'utf8'))
    assert.deepEqual(stored.outputs, manifest.outputs)
    const verdict = verifyBuildManifest(webDist, {
      artifactId: WEB_DIST_ARTIFACT_ID,
      inputs: webDistInputFiles({ root }),
      toolVersion: webDistToolVersion({ root }),
      rebuildCommand: 'pnpm run build:renderer',
    })
    assert.equal(verdict.status, 'ok', verdict.problems.join('; '))
    assert.equal(verdict.problems.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('input content drift after the build is stale and names the drifted input', () => {
  const { root, webDist } = webFixture()
  try {
    writeWebDistBuildManifest({ webDistDir: webDist, root })
    const changed = join(root, 'packages', 'renderer', 'src', 'app.tsx')
    writeFileSync(changed, 'export const app = 2\n')
    touchFuture(changed)
    const verdict = verifyBuildManifest(webDist, {
      artifactId: WEB_DIST_ARTIFACT_ID,
      inputs: webDistInputFiles({ root }),
      toolVersion: webDistToolVersion({ root }),
      rebuildCommand: 'pnpm run build:renderer',
    })
    assert.equal(verdict.status, 'stale')
    assert.ok(verdict.problems.some((problem) => /输入摘要不一致/.test(problem)), verdict.problems.join('; '))
    assert.ok(verdict.problems.some((problem) => problem.includes('packages/renderer/src/app.tsx')), 'the drifted input is named')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('adding a NEW build input after the build is stale (set drift, not just content drift)', () => {
  const { root, webDist } = webFixture()
  try {
    writeWebDistBuildManifest({ webDistDir: webDist, root })
    put(root, 'packages/renderer/src/new-module.ts', 'export const added = 1\n')
    const verdict = verifyBuildManifest(webDist, {
      artifactId: WEB_DIST_ARTIFACT_ID,
      inputs: webDistInputFiles({ root }),
      toolVersion: webDistToolVersion({ root }),
      rebuildCommand: 'pnpm run build:renderer',
    })
    assert.equal(verdict.status, 'stale')
    assert.ok(verdict.problems.some((problem) => /输入摘要不一致/.test(problem)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('output drift is stale: mutated file, extra file and missing file all fail', () => {
  const { root, webDist } = webFixture()
  try {
    writeWebDistBuildManifest({ webDistDir: webDist, root })
    const expected = () => verifyBuildManifest(webDist, {
      artifactId: WEB_DIST_ARTIFACT_ID,
      inputs: webDistInputFiles({ root }),
      toolVersion: webDistToolVersion({ root }),
      rebuildCommand: 'pnpm run build:renderer',
    })
    writeFileSync(join(webDist, 'assets', 'main-abc.js'), 'export const main = 2\n')
    assert.ok(expected().problems.some((problem) => /产物内容与构建时不一致/.test(problem)))
    writeFileSync(join(webDist, 'assets', 'stale-leftover.js'), 'old chunk\n')
    assert.ok(expected().problems.some((problem) => /产物多出文件/.test(problem)))
    rmSync(join(webDist, 'index.html'))
    assert.ok(expected().problems.some((problem) => /产物缺文件/.test(problem)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing / corrupt / wrong-schema / wrong-toolchain manifests are all stale', () => {
  const { root, webDist } = webFixture()
  const expected = () => ({
    artifactId: WEB_DIST_ARTIFACT_ID,
    inputs: webDistInputFiles({ root }),
    toolVersion: webDistToolVersion({ root }),
    rebuildCommand: 'pnpm run build:renderer',
  })
  try {
    writeWebDistBuildManifest({ webDistDir: webDist, root })
    rmSync(join(webDist, BUILD_MANIFEST_FILE))
    assert.ok(verifyBuildManifest(webDist, expected()).problems.some((problem) => /缺少 .build-manifest.json/.test(problem)))
    writeFileSync(join(webDist, BUILD_MANIFEST_FILE), '{ not json')
    assert.equal(verifyBuildManifest(webDist, expected()).status, 'stale')
    const manifest = JSON.parse(JSON.stringify(writeWebDistBuildManifest({ webDistDir: webDist, root })))
    writeFileSync(join(webDist, BUILD_MANIFEST_FILE), JSON.stringify({ ...manifest, schemaVersion: 0 }))
    assert.ok(verifyBuildManifest(webDist, expected()).problems.some((problem) => /schemaVersion/.test(problem)))
    writeFileSync(join(webDist, BUILD_MANIFEST_FILE), JSON.stringify({ ...manifest, toolVersion: 'old-toolchain/0' }))
    assert.ok(verifyBuildManifest(webDist, expected()).problems.some((problem) => /构建工具链不一致/.test(problem)))
    writeFileSync(join(webDist, BUILD_MANIFEST_FILE), JSON.stringify({ ...manifest, artifactId: 'other/artifact' }))
    assert.ok(verifyBuildManifest(webDist, expected()).problems.some((problem) => /artifactId/.test(problem)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing artifact directory reads as "missing", never as stale (fresh-checkout distinction)', () => {
  const { root, webDist } = webFixture()
  try {
    rmSync(webDist, { recursive: true, force: true })
    const verdict = verifyBuildManifest(webDist, {
      artifactId: WEB_DIST_ARTIFACT_ID,
      inputs: webDistInputFiles({ root }),
      toolVersion: webDistToolVersion({ root }),
      rebuildCommand: 'pnpm run build:renderer',
    })
    assert.equal(verdict.status, 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('host package manifest: inputs are the copied seed tree; a rebuilt seed dist goes stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-manifest-host-'))
  try {
    const { sourceDir, outDir } = hostFixture(root)
    put(root, 'packages/desktop/scripts/build-host-graph-package.mjs', '// fixture\n')
    put(root, 'packages/desktop/scripts/build-manifest.mjs', '// fixture\n')
    const inputs = hostPackageInputFiles(sourceDir, { root })
    assert.deepEqual(inputs.map((entry) => entry.path).sort(), [
      'packages/desktop/scripts/build-host-graph-package.mjs',
      'packages/desktop/scripts/build-manifest.mjs',
      'packages/dsh-chamber-seed-fixture/dist/index.js',
      'packages/dsh-chamber-seed-fixture/package.json',
    ])
    const manifest = writeHostPackageBuildManifest({ outDir, sourceDir, root })
    assert.equal(manifest.artifactId, hostPackageArtifactId(outDir))
    assert.equal(manifest.toolVersion, hostPackageToolVersion())
    writeFileSync(join(sourceDir, 'dist', 'index.js'), 'export const host = 2\n')
    const verdict = verifyBuildManifest(outDir, {
      artifactId: hostPackageArtifactId(outDir),
      inputs: hostPackageInputFiles(sourceDir, { root }),
      toolVersion: hostPackageToolVersion(),
      rebuildCommand: 'pnpm --filter @dsh-chamber/desktop run build:host-graph-package',
    })
    assert.equal(verdict.status, 'stale')
    assert.ok(verdict.problems.some((problem) => /输入摘要不一致/.test(problem)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lockstep: every chamber alias target in vite.config.mjs is a declared dist/web input package', () => {
  const config = readFileSync(join(REPO_ROOT, 'packages', 'renderer', 'vite.config.mjs'), 'utf8')
  const aliased = new Set()
  for (const match of config.matchAll(/src\('\.\.\/([a-z0-9-]+)\//gu)) aliased.add('packages/' + match[1])
  assert.ok(aliased.size >= 7, 'the alias scan must find the chamber package aliases (measured ' + aliased.size + ')')
  for (const packageDir of aliased) {
    assert.ok(WEB_DIST_INPUT_PACKAGE_DIRS.includes(packageDir), packageDir + ' is aliased into dist/web but not declared as a manifest input package')
  }
  for (const packageDir of WEB_DIST_INPUT_PACKAGE_DIRS) {
    assert.ok(existsSync(join(REPO_ROOT, packageDir)), 'declared input package is missing on disk: ' + packageDir)
  }
})

test('the declared host package rows are exactly the directories the build publishes', () => {
  assert.equal(HOST_PACKAGE_BUILD_ROWS.length, 4)
  for (const row of HOST_PACKAGE_BUILD_ROWS) {
    assert.equal(hostPackageArtifactId(row.outDir), 'desktop/dist/' + row.outDir.split(/[\\/]/u).pop())
    assert.ok(existsSync(row.sourceDir), 'host package source dir missing: ' + row.sourceDir)
  }
  // the built artifacts are gitignored; when present they must carry the manifest
  const built = HOST_PACKAGE_BUILD_ROWS.filter((row) => existsSync(row.outDir))
  for (const row of built) {
    const files = readdirSync(row.outDir)
    assert.ok(files.includes(BUILD_MANIFEST_FILE), 'built host package without ' + BUILD_MANIFEST_FILE + ': ' + row.outDir + '（重建：pnpm --filter @dsh-chamber/desktop run build:host-graph-package）')
  }
  if (built.length > 0) {
    const stat = statSync(join(built[0].outDir, BUILD_MANIFEST_FILE))
    assert.ok(stat.isFile())
  }
})
