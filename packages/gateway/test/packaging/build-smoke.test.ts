/**
 * Build-level smoke test (design 17 §9.4 regression): the gateway esbuild
 * bundle must carry the createRequire banner and import cleanly. The ws-based
 * session-index / approval-stream transports are not part of the bundle;
 * `ws` itself is present for the gateway's
 * read-only session-state watcher (design 17 §10.7), which attaches the local
 * dsh mux through control-plane's session-mux — that module and none of the
 * stripped transports must be present. The banner stays as belt-and-braces for
 * any remaining bundled CJS dep with static requires.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const distIndex = join(packageDir, 'dist', 'index.js')

test('gateway dist bundle carries the createRequire banner and imports cleanly', async () => {
  // dist/ is gitignored: build on demand so the smoke test works from a
  // clean checkout (the build is a fast esbuild step).
  if (!existsSync(distIndex)) {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: packageDir, stdio: 'ignore' })
  }
  const source = await readFile(distIndex, 'utf8')
  // The banner (scripts/build.mjs) installs a module-scoped require shim so
  // any bundled CJS dep's static requires resolve node builtins normally.
  assert.match(source, /import \{ createRequire \} from 'node:module';/, 'the createRequire banner import is present')
  assert.match(source, /const require = createRequire\(import\.meta\.url\);/, 'the banner require shim is installed')
  // The session-index / approval-stream transports must stay out of the
  // bundle. `ws` ITSELF is expected — the
  // gateway's session-state watcher attaches the local dsh mux through
  // control-plane's session-mux, whose real opener lazily imports `ws`, and the
  // shipped tarball carries no node_modules (design 18 §9.2), so the library
  // must be bundled. Assert the mux is present and the stripped transports are
  // not.
  assert.equal(source.includes('control-plane/src/session-mux.ts'), true,
    'the session-state mux transport must be bundled')
  for (const removed of ['session-index', 'approval-stream']) {
    assert.equal(source.includes(removed), false, `the stripped orchestration transport ${removed} must not be bundled`)
  }
  // And the bundle must import cleanly (no "Dynamic require") and expose the
  // public API surface the control plane consumes.
  const module = await import(pathToFileURL(distIndex).href)
  assert.equal(typeof module.createGateway, 'function')
  assert.equal(typeof module.createChamberSurface, 'function')
  assert.equal(typeof module.createGatewayStore, 'function')
})

test('dist bundles the pinned pnpm the installer local path relies on (design 18 §9.2 D1)', async () => {
  // dist/ is gitignored: build on demand so the smoke test works from a
  // clean checkout (same as the banner test above).
  const pnpmBin = join(packageDir, 'dist', 'pnpm', 'bin', 'pnpm.cjs')
  if (!existsSync(pnpmBin)) {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: packageDir, stdio: 'ignore' })
  }
  assert.ok(existsSync(pnpmBin), 'scripts/build.mjs must copy the pinned pnpm into dist/pnpm')
  // Dynamic assertion: the bundled pnpm version must equal the gateway
  // manifest's dependencies.pnpm (build.mjs enforces the same guard at build
  // time; re-asserting here keeps a stale dist from slipping through the
  // smoke). The alternative (hardcoding 11.21.0) would drift from
  // package.json, which is the single source of truth.
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
    dependencies: { pnpm: string }
  }
  const bundled = JSON.parse(await readFile(join(packageDir, 'dist', 'pnpm', 'package.json'), 'utf8')) as {
    name: string
    version: string
  }
  assert.equal(bundled.name, 'pnpm')
  assert.equal(bundled.version, manifest.dependencies.pnpm,
    'bundled pnpm version must match the gateway dependencies.pnpm pin')
  // And the bundled pnpm must actually run from the unpacked tree shape —
  // that is exactly how the installer local path spawns it (plain `node
  // pnpm.cjs`, no npm-installed dependency tree).
  const run = spawnSync(process.execPath, [pnpmBin, '--version'], { cwd: packageDir, encoding: 'utf8' })
  assert.equal(run.status, 0, `node dist/pnpm/bin/pnpm.cjs --version failed: ${run.stderr}`)
  assert.ok(run.stdout.includes(manifest.dependencies.pnpm),
    `--version output ${JSON.stringify(run.stdout)} must report the pinned version`)
})

// ---- mobile seed artifact contract (design 17 §18.3) ----

test('host-packages carries the mobile seed set, aligned with exports and seedFiles', () => {
  // host-packages/ is generated by scripts/build.mjs; build on demand so the
  // smoke test works from a clean checkout.
  const hostDir = join(packageDir, 'host-packages', 'dsh-chamber-client-ui-mobile')
  if (!existsSync(join(hostDir, 'lib', 'index.js'))) {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: packageDir, stdio: 'ignore' })
  }
  // Every file the package manifest points at must be present (the cordis
  // loader imports the overlay row by package name → `main`/exports["."],
  // and the ClientModuleRegistry serves exports["./client"] — omitting any
  // of them fails the managed dsh boot).
  for (const file of ['package.json', 'dist/index.js', 'lib/index.js', 'lib/client.js', 'lib/client.js.map']) {
    assert.equal(existsSync(join(hostDir, file)), true, `missing seeded file ${file}`)
  }
  const manifest = JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf8'))
  const dot = manifest.exports?.['.'] ?? { default: manifest.main }
  assert.equal(dot.default, './lib/index.js', 'exports["."] must resolve to a seeded file')
  assert.equal(manifest.exports?.['./client'], './lib/client.js', 'exports["./client"] must resolve to a seeded file')
})

// ---- protected-set verifier freshness (design 21 §6.11) ----

test('dist carries the CURRENT protected-set READ projection (a stale bundle silently ships an outdated row classification)', async () => {
  // Every other check in this file survives a stale dist: the banner, the
  // bundled pnpm pin and the public API all look identical in an OLD build —
  // and the gateway's behaviour tests import `src/`, never this bundle — so a
  // stale dist stays invisible until an operator runs the packaged gateway.
  // These markers are operator-facing copy,
  // which minification preserves; reword the copy ⇒ move the marker with it.
  // The user plugin write surface (and with it the post-install verifier's copy)
  // was retired with the 2026-09 C layering ruling; the read projection still
  // derives the protected set from the runtime family facts, so its copy is the
  // freshness marker now.
  const markers = [
    // §6.11.1 second trust criterion: a fact source whose name and version
    // parsers disagree about the same keys is refused.
    'the name and version parsers disagree about the same keys',
    // The gateway's own B₀ ∪ S fallback: an underivable family closure must
    // never be published as an empty protected set.
    'chamber seed registry cannot form a protected set',
  ]
  // A MISSING dist (clean checkout) is built on demand — that is not staleness.
  // An EXISTING dist without the current markers IS staleness and must fail
  // loudly: silently rebuilding it would let an operator (or CI) believe the
  // shipped artifact was checked when the guard actually healed it.
  if (!existsSync(distIndex)) {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: packageDir, stdio: 'ignore' })
  }
  const source = await readFile(distIndex, 'utf8')
  for (const marker of markers) {
    assert.ok(source.includes(marker),
      `the gateway bundle in dist/ is stale: missing ${JSON.stringify(marker)} — rebuild with \`pnpm run build:gateway\``)
  }
})
