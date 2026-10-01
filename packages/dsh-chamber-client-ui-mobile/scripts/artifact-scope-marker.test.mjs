/**
 * Built mobile client bundle × SVG resource scoper marker (design 05 §4.2).
 *
 * `lib/client.js` is a BUILD-TIME artifact (lib/ is gitignored; ensure-artifacts
 * builds it from src and the gateway seed copies the built file verbatim:
 * packages/gateway/scripts/build.mjs:62-77), and the gateway-hosted official
 * shell only receives the document-level SVG resource-id scoper when THIS file
 * carries it: the desktop page has the renderer
 * suite + the manual probe (scripts/dev/svg-resource-probe.mjs), while a mobile
 * source edit without a rebuild would ship the old bundle silently.
 *
 * Shape follows packages/desktop/scripts/control-plane-freshness.test.mjs:
 * markers are read out of the built artifact, staleness fails loudly with the
 * rebuild command, and the check logic is exported so the negative controls can
 * prove the assertion actually fires. Two deliberate differences:
 *   - the artifact is a build output, so a MISSING file after the test preflight (ensure-artifacts
 *     builds it on a clean checkout) is a defect and the guard does NOT rebuild on demand;
 *   - the guard also pins the host half as scoper-free (the scoper is
 *     browser-half only: dist/index.js is loaded by the cordis host loader and
 *     never runs in a document).
 *
 * Coverage boundary (which artifacts are NOT guarded here, and why):
 *   - packages/desktop/dist/web/assets/chamber-*.js (the desktop page bundle) is
 *     a build output of `pnpm run build:renderer`, not an artifact of
 *     this package; its scoper module face is asserted by
 *     packages/renderer/test/svg-resource/svg-resource-scope.test.ts and its
 *     built form by the manual probe (`--expect-artifact`).
 *   - packages/gateway/host-packages/dsh-chamber-client-ui-mobile/lib/client.js
 *     is generated per gateway build as a byte copy of the guarded file
 *     (packages/gateway/scripts/build.mjs:74-77), and its presence is already
 *     asserted by packages/gateway/test/packaging/build-smoke.test.ts:76-94.
 *   - the gateway's "direct official shell" deployment loads no chamber code at
 *     all (design 17 §10 audience), so there is nothing to install into there.
 *   - dist/index.js + lib/index.js (host half) carry no scoper by design — the
 *     boundary lock below asserts that rather than a marker.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientArtifact = join(packageDir, 'lib', 'client.js')
const hostArtifact = join(packageDir, 'dist', 'index.js')

export { CLIENT_BUNDLE_MARKER, SCOPER_CALL_MARKER_NAME, SCOPER_LITERAL_MARKERS, SCOPER_MARKERS, missingScoperMarkers } from './lib/scoper-markers.mjs'
import {
  CLIENT_BUNDLE_MARKER, SCOPER_CALL_MARKER_NAME, SCOPER_LITERAL_MARKERS, SCOPER_MARKERS, missingScoperMarkers,
} from './lib/scoper-markers.mjs'

/** The package's declared client-plugin dependencies (`dsh.client.inject`). */
const PACKAGE_MANIFEST = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const DECLARED_INJECT = new Set(PACKAGE_MANIFEST.dsh?.client?.inject ?? [])

/**
 * The platform seed words the official shell materializes for every client
 * bundle before any factory runs (dsh-web-frontend's `staticModules`: react /
 * react-dom, cordis, the shared store / slots / primitives). A bundle may
 * require those WITHOUT declaring them in `dsh.client.inject` — the official
 * `dsh-client-ui-sidebar` requires `@deepseek-ai/dsh-client-ui-primitives`
 * exactly this way, and the mobile bundle's own MobileNavToggle does too.
 */
const PLATFORM_SEED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** Every module reference the built factory makes, package-local chunk
 *  requests excluded. */
export function requiredModules(source) {
  const found = new Set()
  for (const match of source.matchAll(/(?:^|[^\w$.])require\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = match[1]
    if (spec.startsWith('./') || spec.startsWith('../')) continue
    found.add(spec)
  }
  return [...found].sort()
}

/**
 * Every module the factory requires must arrive before it runs: either a
 * declared `dsh.client.inject` dependency or a platform seed word. A new
 * import that slips past the manifest fails at runtime with the loader's
 * "require(...) missed the module table" in the gateway-hosted shell, so it is
 * a hard failure here.
 */
export function assertBundleRequiresAreDeclared(source) {
  const required = requiredModules(source)
  const undeclared = required.filter(spec => !DECLARED_INJECT.has(spec) && !PLATFORM_SEED_MODULES.has(spec))
  if (undeclared.length > 0) {
    throw new Error(
      `${undeclared.map(spec => JSON.stringify(spec)).join(', ')} required by the client bundle but `
      + 'neither declared in package.json dsh.client.inject nor a platform seed module — add the '
      + 'dependency to dsh.client.inject (or prove the platform seeds it)',
    )
  }
  return required
}

/**
 * Assert one client bundle file carries the scoper install.
 * @param {string} file - absolute path to a built client bundle.
 * @returns {string} the artifact text when it passes.
 */
export function assertClientBundleCarriesScoper(file) {
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing: the mobile client bundle is a build-time artifact (ensure-artifacts builds it) — `
      + 'rebuild with `pnpm run build:artifacts` (lib/ is gitignored, never committed)',
    )
  }
  const source = readFileSync(file, 'utf8')
  if (!source.includes(CLIENT_BUNDLE_MARKER)) {
    throw new Error(`${file} is not the client bundle (no ${JSON.stringify(CLIENT_BUNDLE_MARKER)} wrapper)`)
  }
  const missing = missingScoperMarkers(source)
  if (missing.length > 0) {
    throw new Error(
      `${file} is stale: missing ${missing.map(marker => JSON.stringify(marker)).join(', ')} — `
      + 'rebuild with `pnpm run build:artifacts` (lib/ is gitignored, never committed)',
    )
  }
  return source
}

// The real artifact: the seeded client bundle must carry the install.
test('the built mobile client bundle carries the SVG resource scoper install', () => {
  const source = assertClientBundleCarriesScoper(clientArtifact)
  assert.ok(source.length > 0)
  // Anti-vacuity: the file must really be bigger than the three marker strings,
  // i.e. the guard read a bundle, not a stub a future refactor left behind.
  assert.ok(source.length > 10_000, 'lib/client.js is suspiciously small for the built plugin')
})

// Negative control: the same check the real artifact goes through must REFUSE a
// bundle that lacks the install. A guard that cannot fail is not a guard.
test('the marker guard fires on a client bundle without the scoper (negative control)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mobile-scope-marker-'))
  try {
    const stub = join(dir, 'client.js')
    writeFileSync(stub, CLIENT_BUNDLE_MARKER + '({ id: "@dsh-chamber/dsh-client-ui-mobile", factory: () => {} });\n')
    assert.throws(() => assertClientBundleCarriesScoper(stub), /is stale: missing "data-chamber-svg-scope"/)
    assert.deepEqual(missingScoperMarkers(readFileSync(stub, 'utf8')), SCOPER_MARKERS)

    // A dropped CALL (anchor kept, RHS no longer a call) is still stale: the
    // anchored assignment is what proves the installer RUNS, not that the name
    // exists somewhere in the file.
    const noCall = join(dir, 'no-call.js')
    writeFileSync(noCall, CLIENT_BUNDLE_MARKER + '\ndata-chamber-svg-scope chamber-csvg globalThis.' + SCOPER_CALL_MARKER_NAME + ' = null\n')
    assert.deepEqual(missingScoperMarkers(readFileSync(noCall, 'utf8')), ['__chamberSvgScopeInstalled=<call>'])

    // Not the client bundle at all: refused before any marker talk.
    const alien = join(dir, 'alien.js')
    writeFileSync(alien, 'export const apply = () => {}\n')
    assert.throws(() => assertClientBundleCarriesScoper(alien), /is not the client bundle/)

    // Missing file: a build-time artifact that vanished after the preflight is a defect, never a skip.
    assert.throws(() => assertClientBundleCarriesScoper(join(dir, 'absent.js')), /is missing/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every module the bundle requires is declared in dsh.client.inject or platform-seeded', () => {
  const required = assertBundleRequiresAreDeclared(readFileSync(clientArtifact, 'utf8'))
  // Anti-vacuity: the real bundle really does require react + the shared
  // primitives (both platform seed words, neither in dsh.client.inject).
  assert.ok(required.includes('react'), `react must be required by the real bundle (got ${required.join(', ')})`)
  assert.ok(required.includes('@deepseek-ai/dsh-client-ui-primitives'),
    'the MobileNavToggle primitives import must appear as a require')
  assert.ok(!required.includes('@deepseek-ai/dsh-client-ui-mobile'), 'the package never requires itself')
})

test('the inject/require check fires on an undeclared module (negative control)', () => {
  const undeclared = CLIENT_BUNDLE_MARKER
    + '({ id: "x", factory: (require) => { require("@deepseek-ai/dsh-client-unknown") } });\n'
  assert.throws(() => assertBundleRequiresAreDeclared(undeclared),
    /neither declared in package\.json dsh\.client\.inject/)
  // A declared inject dependency and a platform seed word both pass.
  assert.doesNotThrow(() => assertBundleRequiresAreDeclared(
    CLIENT_BUNDLE_MARKER
    + '({ id: "x", factory: (require) => { require("@deepseek-ai/dsh-client-locale"); require("react"); } });\n',
  ))
  // Relative chunk requests are not module-table lookups.
  assert.deepEqual(
    requiredModules(CLIENT_BUNDLE_MARKER + '({ id: "x", factory: (require) => { require("./client.chunk.js") } });\n'),
    [],
  )
})

test('the markers are satisfied by marker text, not by the file path (positive control)', () => {
  // 两种真实形态都要过：未压缩（mobile build-time bundle）与压缩（页面 chunk）。
  const pretty = [CLIENT_BUNDLE_MARKER, ...SCOPER_LITERAL_MARKERS, 'globalThis.' + SCOPER_CALL_MARKER_NAME + ' = installSvgResourceScope()'].join('\n')
  assert.deepEqual(missingScoperMarkers(pretty), [])
  const minified = [CLIENT_BUNDLE_MARKER, ...SCOPER_LITERAL_MARKERS, 'globalThis.' + SCOPER_CALL_MARKER_NAME + '=Aw()'].join('\n')
  assert.deepEqual(missingScoperMarkers(minified), [], '压缩产物（点号名保留、调用被改名）必须照样通过')
})

// Boundary lock: the scoper is a browser-half concern. dist/index.js is the
// cordis host half (apply() is a no-op run in the dsh process, no document), so
// scoper code landing there would mean the import was put in the wrong entry.
test('the built host half (dist/index.js) stays free of scoper code', () => {
  assert.ok(existsSync(hostArtifact), `${hostArtifact} is missing: run node packages/dsh-chamber-client-ui-mobile/scripts/build.mjs`)
  const source = readFileSync(hostArtifact, 'utf8')
  for (const marker of [...SCOPER_LITERAL_MARKERS, SCOPER_CALL_MARKER_NAME]) {
    assert.ok(!source.includes(marker), `dist/index.js is the host half and must not carry ${JSON.stringify(marker)}`)
  }
})
