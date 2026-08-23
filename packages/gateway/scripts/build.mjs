#!/usr/bin/env node

import { chmodSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(packageDir, 'dist')
const indexOut = join(outDir, 'index.js')
const cliOut = join(outDir, 'cli.js')

rmSync(outDir, { recursive: true, force: true })

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
}

// Bundle the control-plane and its runtime dependencies into both outputs.
// Installed Node deliberately refuses type-stripping inside node_modules, so
// shipping workspace .ts sources (the former package shape) was not runnable.
await build({ ...shared, entryPoints: [join(packageDir, 'src', 'index.ts')], outfile: indexOut })
await build({ ...shared, entryPoints: [join(packageDir, 'src', 'cli.ts')], outfile: cliOut })

if (!existsSync(indexOut) || !existsSync(cliOut)) {
  throw new Error('gateway build did not produce dist/index.js and dist/cli.js')
}
chmodSync(cliOut, 0o755)

console.log(`[build-gateway] standalone ESM bundle -> ${outDir}`)
