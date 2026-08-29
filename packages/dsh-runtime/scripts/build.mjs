#!/usr/bin/env node
/**
 * Compile the shared dsh runtime core (TS + .mjs data modules) into a plain
 * JS bundle for runtime consumption.
 *
 * Background: Node 22.18+ refuses type-stripping for files under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and electron-builder packs
 * workspace dependencies verbatim. Shipping `dist/index.js` as the package
 * main keeps static `export * from '@dsh-chamber/dsh-runtime'` shims working
 * in BOTH dev and packaged mode; type-checking stays on `src/index.ts` via
 * the package's `types` export.
 */
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(packageDir, 'dist')
const entry = join(packageDir, 'src', 'index.ts')

rmSync(outDir, { recursive: true, force: true })

await build({
  entryPoints: [entry],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  // No createRequire banner: the core uses no CJS `require` — and a banner
  // here would collide with consumer bundles that add their own (gateway).
})

console.log(`[build-dsh-runtime] shared core bundled -> ${outDir}`)
