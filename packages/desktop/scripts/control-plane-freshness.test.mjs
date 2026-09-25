/**
 * Packaged control-plane freshness + self-containment (design 21 §6.11; R6
 * phase 2 must-fix).
 *
 * `dist/control-plane/index.js` is what the PACKAGED app loads (`main.ts` →
 * `control-plane-module.ts` dual path) and what `build:sidecar` copies into
 * the Swift assembly, while the desktop suite exercises
 * `packages/control-plane/src` through the workspace path, so a stale bundle
 * is invisible to every test yet silently ships the previous judgement.
 *
 * Two facts are pinned on the REAL artifact:
 *   - the bundle carries the CURRENT protected-set READ-face copy (markers
 *     below; the esbuild bundle preserves the operator-facing strings); the
 *     user plugin write-face verifier was retired with the 2026-09 C layering
 *     ruling, so the markers pin the derivation/resolution facts only;
 *   - the bundle is SELF-CONTAINED: every import/export specifier is a `node:`
 *     builtin. A bare workspace specifier (`@dsh-chamber/dsh-chamber-wire`,
 *     whose source ships as .ts under node_modules) or a relative hop resolves
 *     in the repo tree but not in the packaged asar / sidecar assembly — Node
 *     refuses type stripping under node_modules
 *     (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). The scanner is the build
 *     script's own exported ruler, so the test and the builder cannot drift.
 *
 * The markers below are the operator-facing copy, which the bundle preserves
 * verbatim; rewording the copy means moving the marker with it (the same
 * lockstep discipline the corresponding row mirror uses).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nonBuiltinSpecifiers, residualBundleInputs, runtimeImportSpecifiers } from './build-control-plane.mjs'
import { loadEsbuild } from '../../../scripts/lib/esbuild.mjs'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const distFile = join(packageDir, 'dist', 'control-plane', 'index.js')

const MARKERS = [
  // §6.11.1 second trust criterion: a fact source whose name and version
  // parsers disagree about the same keys is refused, instead of silently
  // degrading every later comparison to the generation arm.
  'the name and version parsers disagree about the same keys',
  // §6.11.1 the resolver's loud failure when no trustworthy family facts exist
  // (never a silent "no protection").
  'no trustworthy runtime family facts',
  // §6.11 core-anchor judge (runtime-family leaf, re-used by the read face):
  // a closure missing the core anchors is not F.
  'runtime family closure is missing the core anchor',
  // deriveProtectedSet fail-closed guard: an all-empty fact set is never
  // answered as "nothing is protected".
  'protected set derived empty (installation/seed/family facts all empty)',
]

test('packaged dist/control-plane carries the CURRENT protected-set read-face facts', () => {
  // A MISSING dist (clean checkout) is built on demand — that is not staleness.
  // An EXISTING dist without the current markers IS staleness and must fail
  // loudly: silently rebuilding it would let an operator (or a packaging run)
  // believe the artifact was checked when the guard actually healed it. A
  // guard that heals the artifact cannot catch the drift it exists for, so
  // both guards fail on staleness.
  if (!existsSync(distFile)) {
    execFileSync(process.execPath, ['scripts/build-control-plane.mjs'], { cwd: packageDir, stdio: 'ignore' })
  }
  const source = readFileSync(distFile, 'utf8')
  for (const marker of MARKERS) {
    assert.ok(source.includes(marker),
      `dist/control-plane is stale: missing ${JSON.stringify(marker)} — rebuild with \`pnpm run build:desktop\``)
  }
  // The shared wire read algorithm is INLINED, not resolved at runtime
  // (design 21 §6.2/decision 18): the mask constant must be in the bundle.
  assert.ok(
    source.includes('"file:<hidden>"') || source.includes("'file:<hidden>'"),
    'dist/control-plane must inline the shared wire PLUGIN_MATERIALIZED_VALUE_MASK',
  )
})

test('packaged dist/control-plane is self-contained: only node: builtins are imported', async () => {
  if (!existsSync(distFile)) {
    execFileSync(process.execPath, ['scripts/build-control-plane.mjs'], { cwd: packageDir, stdio: 'ignore' })
  }
  const source = readFileSync(distFile, 'utf8')
  const specifiers = runtimeImportSpecifiers(source)
  // Sanity floor: the bundle imports node builtins (http/fs/path/...). A parser
  // regression that finds zero specifiers must not read as a clean bundle.
  assert.ok(specifiers.length >= 5, `expected the bundle to import node builtins, found ${JSON.stringify(specifiers)}`)
  assert.deepEqual(
    nonBuiltinSpecifiers(specifiers),
    [],
    'a packaged control-plane may only import node: builtins — bare workspace specifiers and relative hops are unresolvable in the asar/sidecar tree',
  )
  // Authoritative check (same ruler as the builder): re-bundle the emitted
  // entry with esbuild and require that it resolves to itself alone. A
  // surviving bare/relative import becomes a second metafile input; this is
  // parser-based, so multi-line imports or string content cannot fool it.
  const esbuild = await loadEsbuild()
  const inputs = await residualBundleInputs(esbuild, distFile, packageDir)
  const expected = join('dist', 'control-plane', 'index.js').split('\\').join('/')
  assert.deepEqual(
    inputs,
    [expected],
    're-bundling the packaged entry must resolve to the entry itself alone (no workspace/relative import survives)',
  )
})
