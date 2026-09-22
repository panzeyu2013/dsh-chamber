#!/usr/bin/env node
/**
 * Post-build guard: the built desktop PAGE bundle must actually carry the SVG
 * resource scoper code.
 *
 * Why a separate, post-build step: `pnpm run build:renderer` runs AFTER the
 * package test suites in ci.yml, so no test-suite guard can see
 * `packages/desktop/dist/web/assets/*.js`. This guard is the only automated
 * check that the BUILD did not drop or tree-shake the scoper out of the page.
 *
 * Usage: node packages/dsh-chamber-client-ui-mobile/scripts/assert-scoper-artifact.mjs [assetsDir]
 * Exits 0 when some built page chunk carries the scoper markers, 1 otherwise.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCOPER_MARKERS, missingScoperMarkers } from './lib/scoper-markers.mjs'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageDir, '..', '..')
const assetsDir = resolve(process.argv[2] ?? join(repoRoot, 'packages', 'desktop', 'dist', 'web', 'assets'))

if (!existsSync(assetsDir)) {
  console.error(`[scoper-artifact] FAIL: ${assetsDir} does not exist — run \`pnpm run build:renderer\` first (this guard is meant to run AFTER the renderer build).`)
  process.exit(1)
}

const chunks = readdirSync(assetsDir).filter(name => name.endsWith('.js'))
if (chunks.length === 0) {
  console.error(`[scoper-artifact] FAIL: no .js chunks under ${assetsDir} — the renderer build produced nothing to inspect.`)
  process.exit(1)
}

const carriers = []
for (const name of chunks) {
  const source = readFileSync(join(assetsDir, name), 'utf8')
  if (missingScoperMarkers(source).length === 0) carriers.push(name)
}

if (carriers.length === 0) {
  const missing = SCOPER_MARKERS.map(marker => JSON.stringify(marker)).join(', ')
  console.error(`[scoper-artifact] FAIL: no built page chunk under ${assetsDir} carries ${missing} — the scoper was dropped by the build; rebuild with \`pnpm run build:renderer\` and investigate the entry wiring.`)
  process.exit(1)
}

console.log(`[scoper-artifact] ok: ${carriers.join(', ')} carries the SVG resource scoper install (${chunks.length} chunk(s) inspected).`)
