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
  // Pure-ESM output has no ambient `require`. Bundled CJS deps that do a
  // static `require('events')` (ws's websocket.js — the session-index /
  // approval streams' transport) used to hit esbuild's __require fallback:
  // "Dynamic require of 'events' is not supported", which wedged the
  // derived session index in an endless reconnect loop (live finding on
  // Linux + macOS). The banner installs a module-scoped require shim so
  // __require resolves node builtins normally.
  banner: {
    js: `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);`,
  },
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
