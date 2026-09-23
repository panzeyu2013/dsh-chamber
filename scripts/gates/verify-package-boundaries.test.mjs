/**
 * Unit lock for the package-boundary gate (R4 P7).
 *
 * The gate is a static step; this file proves its instrumentation can fail
 * (the embedded controls cover every criterion and every false-positive
 * boundary), that the real repository passes both criteria today, and that the
 * allowlist/scan surface keep the documented shape. Without it a comparison
 * that silently did nothing would read as "the boundaries hold".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXPORTS_ALLOWLIST,
  boundaryAVerdict,
  collectPackageManifests,
  collectProductionSourceFiles,
  exportsFaceVerdict,
  runGate,
  runSelfTest,
} from './verify-package-boundaries.mjs'

test('the embedded controls pass: every criterion and false-positive boundary is locked', () => {
  const outcome = runSelfTest()
  assert.deepEqual(outcome.cases.filter((item) => !item.ok), [], 'failed self-test controls')
  assert.equal(outcome.ok, true)
  assert.ok(outcome.cases.length >= 18, 'the control set must not shrink: ' + outcome.cases.length)
})

test('the real repository is clean under both criteria', () => {
  const { failures, a, b, files } = runGate()
  assert.deepEqual(failures, [])
  assert.ok(files > 0, 'the scan surface must be non-empty')
  assert.ok(a.vendorAllowed >= 1, 'the registered vendor row must be exercised (host-graph.ts)')
  assert.ok(b.checkedFaces > 0, 'the exports allowlist must check real faces')
})

test('criterion A is not vacuous: a cross-package escape inside a synthetic package is caught', () => {
  // The same comparison the real run uses, fed a known-bad source.
  const verdict = boundaryAVerdict({
    sources: [{
      file: 'packages/x/src/a.ts',
      packageDir: 'packages/x',
      text: "import { y } from '../../y/src/y.ts'\n",
    }],
    vendorAllowances: new Set(),
  })
  assert.equal(verdict.violations.length, 1)
  assert.match(verdict.violations[0], /packages\/x\/src\/a\.ts:1/)
})

test('criterion B is not vacuous: the allowlist is registered for every real package', () => {
  const manifests = collectPackageManifests()
  assert.ok(manifests.length > 0)
  for (const manifest of manifests) {
    assert.ok(Object.hasOwn(EXPORTS_ALLOWLIST, manifest.dir), 'unregistered package: ' + manifest.dir)
  }
})

test('boundary 1 + 3 + 4: the scan surface is production src only (no test/, vendor/, scripts/, dist/)', () => {
  const files = collectProductionSourceFiles()
  assert.ok(files.length > 0)
  assert.ok(!files.some((file) => file.includes('/test/')), 'test faces must stay outside A')
  assert.ok(!files.some((file) => file.startsWith('vendor/')), 'vendor internals must stay outside A')
  assert.ok(!files.some((file) => file.includes('/dist/') || file.includes('/lib/')), 'build output must stay outside A')
  assert.ok(!files.some((file) => file.includes('/scripts/')), 'tooling scripts must stay outside A')
})

test('the allowlist never carries a wildcard face and pins the renderer single face', () => {
  for (const faces of Object.values(EXPORTS_ALLOWLIST)) {
    for (const face of faces) assert.ok(!face.includes('*'), 'wildcard face in allowlist: ' + face)
  }
  assert.deepEqual(EXPORTS_ALLOWLIST['packages/renderer'], ['./global.d.ts'])
  assert.deepEqual(EXPORTS_ALLOWLIST['packages/cli'], [])
  assert.deepEqual(EXPORTS_ALLOWLIST['packages/desktop'], [])
})

test('criterion B: an unregistered src target fails even when the face is allowed', () => {
  const verdict = exportsFaceVerdict({
    manifests: [{ dir: 'packages/x', path: 'packages/x/package.json', exports: { '.': './src/missing.ts' } }],
    exists: () => false,
    allowlist: { 'packages/x': ['.'] },
  })
  assert.equal(verdict.violations.length, 1)
  assert.match(verdict.violations[0], /does not exist/)
})
