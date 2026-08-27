#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
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

// Ship the chamber host packages (module A / git worktree) inside the gateway
// package: the control-plane seeds them into the managed dsh profile
// (ensureHostPackage: package.json + dist/index.js) and the full runtime
// activation probe set verifies their RPC domains — without them the probe
// gate can never pass on a gateway-managed dsh (2026-09 real-machine test
// finding: npm-global install resolved REPO_ROOT to the global node_modules
// and silently skipped the seed). The dist artifacts are committed (gitignore
// negation, same as dsh-runtime), so a clean checkout carries them.
const hostPackagesOut = join(packageDir, 'host-packages')
rmSync(hostPackagesOut, { recursive: true, force: true })
const HOST_PACKAGES = [
  { name: 'dsh-host-client-graph', source: join(packageDir, '..', 'dsh-host-client-graph') },
  { name: 'dsh-chamber-host-git-worktree', source: join(packageDir, '..', 'dsh-chamber-host-git-worktree') },
]
for (const { name, source } of HOST_PACKAGES) {
  const out = join(hostPackagesOut, name)
  mkdirSync(join(out, 'dist'), { recursive: true })
  cpSync(join(source, 'package.json'), join(out, 'package.json'))
  cpSync(join(source, 'dist', 'index.js'), join(out, 'dist', 'index.js'))
}
console.log(`[build-gateway] host packages -> ${hostPackagesOut}`)
