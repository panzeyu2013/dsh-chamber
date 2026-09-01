#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
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

// Ship the packaged chamber seed entries inside the gateway package
// (2026-12): the two host packages (dsh-host-client-graph / git-worktree) are
// now DESKTOP-SYNCED (PUT /chamber/plugins → chamber-plugins cache) and no
// longer ship here; only packaged entries ride this directory. Today that is
// the mobile client-plugin slot (dsh-chamber-client-ui-mobile, kind 'client'):
// mobile access is bound to the gateway and has no desktop in the chain, so
// its seed MUST ship inside this package — the package lands on the mobile
// branch; until then the entry is a warned stub skip in the control-plane
// seed orchestration and this loop copies nothing.
const hostPackagesOut = join(packageDir, 'host-packages')
rmSync(hostPackagesOut, { recursive: true, force: true })
const HOST_PACKAGES = [
  // { name: 'dsh-chamber-client-ui-mobile', source: join(packageDir, '..', 'dsh-chamber-client-ui-mobile') },
]
for (const { name, source } of HOST_PACKAGES) {
  const out = join(hostPackagesOut, name)
  mkdirSync(join(out, 'dist'), { recursive: true })
  cpSync(join(source, 'package.json'), join(out, 'package.json'))
  cpSync(join(source, 'dist', 'index.js'), join(out, 'dist', 'index.js'))
}
console.log(`[build-gateway] packaged seed entries -> ${hostPackagesOut}`)

// Bundle the pinned pnpm next to the esbuild outputs (design 18 §9.2 D1).
// The installer's local (default) path unpacks the gateway tarball and NEVER
// installs gateway dependencies (stage_local_version: bare tar
// --strip-components=1; the launcher execs `node current/dist/cli.js`), so at
// runtime `pnpmEntry()` cannot resolve pnpm from a node_modules tree there —
// this bundled copy IS the dependency. Desktop parity: packages/desktop ships
// the same pinned pnpm via extraResources (package.json files +
// bundle-dsh.mjs BUNDLE_PNPM_VERSION).
// pnpm's isolated linker stores node_modules/pnpm as a symlink into
// .pnpm/pnpm@<version>/node_modules/pnpm, so the copy MUST dereference: a
// link-as-link copy would ship a dangling symlink and the installer's very
// first pnpm spawn would fail.
const pnpmSource = join(packageDir, 'node_modules', 'pnpm')
const pnpmOut = join(outDir, 'pnpm')
if (!existsSync(pnpmSource)) {
  throw new Error(`gateway build cannot bundle pnpm: ${pnpmSource} is missing (run pnpm install first)`)
}
cpSync(realpathSync(pnpmSource), pnpmOut, { recursive: true, dereference: true })
const gatewayPkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const bundledPnpm = JSON.parse(readFileSync(join(pnpmOut, 'package.json'), 'utf8'))
// Version guard reads dependencies.pnpm from the gateway manifest at build
// time (single source of truth — desktop's BUNDLE_PNPM_VERSION hardcodes the
// same 11.21.0 pin): a package.json bump without a matching installed tree
// fails loud here instead of silently shipping a mismatched pair.
if (bundledPnpm.name !== 'pnpm' || bundledPnpm.version !== gatewayPkg.dependencies?.pnpm) {
  throw new Error(
    `gateway build pnpm mismatch: bundled ${bundledPnpm.name ?? '?'}@${bundledPnpm.version ?? '?'}, ` +
      `expected pnpm@${gatewayPkg.dependencies?.pnpm ?? '?'} (package.json dependencies.pnpm)`,
  )
}
const bundledPnpmBin = join(pnpmOut, 'bin', 'pnpm.cjs')
if (!existsSync(bundledPnpmBin)) {
  throw new Error(`gateway build pnpm bundle is missing its entry: ${bundledPnpmBin}`)
}
console.log(`[build-gateway] bundled pnpm@${bundledPnpm.version} -> ${pnpmOut}`)
