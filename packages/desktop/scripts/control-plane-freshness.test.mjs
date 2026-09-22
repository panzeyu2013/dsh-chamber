/**
 * Packaged control-plane freshness (design 21 §6.11).
 *
 * `dist/control-plane/**` is what the PACKAGED app loads (`main.ts` →
 * `control-plane-module.ts` dual path), while the desktop suite exercises
 * `packages/control-plane/src` through the workspace path, so a stale compile
 * is invisible to every test yet silently ships the previous judgement.
 *
 * The markers below are the operator-facing copy, which
 * the compile preserves verbatim; rewording the copy means moving the marker
 * with it (the same lockstep discipline the corresponding row mirror uses).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const distFile = join(packageDir, 'dist', 'control-plane', 'protected-plugins.js')

const MARKERS = [
  // §6.11.4 version arm: a family member is judged against the version this
  // runtime line provides (rescoped vendored packages keep upstream versions
  // and can never equal the generation string).
  'is not the version this instance runtime provides',
  // §6.11.4 per-name honesty: an arm that never ran is named, never folded
  // into a silent aggregate pass.
  'no runtime-provided version fact exists and the instance runtime version is unknown for',
  // §6.11.1 second trust criterion: a fact source whose name and version
  // parsers disagree about the same keys is refused, instead of silently
  // degrading every later comparison to the generation arm.
  'the name and version parsers disagree about the same keys',
  // §6.11.4 closure walk (dependencies ∪ optionalDependencies).
  'optionalDependencies',
]

test('packaged dist/control-plane carries the CURRENT protected-set verifier', () => {
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
})
