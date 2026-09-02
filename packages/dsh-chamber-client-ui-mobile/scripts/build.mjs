/**
 * Mobile plugin build (design 17 §18.4.1): two halves, esbuild-based.
 *
 *  - host half  → dist/index.js (ESM): the gateway seed gate requires
 *    `dist/index.js` to exist (control-plane host-graph-seed ensureSeedPackage);
 *    the host apply() is a no-op (browser-only plugin).
 *  - client half → lib/client.js (CJS closure): the loader-row browser
 *    bundle — `window.__ModuleLoader__.load({ id, factory })` with externals
 *    resolved through the loader module table (react, cordis, @deepseek-ai/*,
 *    @dsh-chamber/*). The package's `exports["./client"]` points here and the
 *    gateway seedFiles must carry it (design 17 §18.3).
 *
 * The stylesheet lives in src/client/styles.ts as a plain string (anchors
 * are stable attributes; no CSS-modules hashing needed), so the build needs
 * no CSS toolchain.
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const ID = '@dsh-chamber/dsh-client-ui-mobile'

/** Resolved through the loader module table (never bundled). esbuild
 *  externals are string patterns — `*` wildcards for the scoped packages. */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/*',
  '@dsh-chamber/*',
]

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'dist/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: EXTERNALS,
  logLevel: 'warning',
})

await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: EXTERNALS,
  banner: {
    // The loader module table evaluates the factory in a bare browser
    // scope — `module`/`exports` must be introduced explicitly (the
    // official tsdown client template does the same; without this,
    // `module is not defined` kills the bundle at materialization, P1-B).
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {
var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  sourcemap: true,
  logLevel: 'warning',
})

// The gateway seed copies package.json + dist/index.js (+ extended seedFiles);
// make sure the target layout exists for the copy step and for local checks.
// exports["."] points at lib/index.js (family convention) — the host half is
// byte-identical to dist/index.js, so mirror it.
mkdirSync(join(root, 'lib'), { recursive: true })
mkdirSync(join(root, 'dist'), { recursive: true })
cpSync(join(root, 'dist', 'index.js'), join(root, 'lib', 'index.js'))

// eslint-disable-next-line no-console
console.log(`[${ID}] built dist/index.js + lib/client.js`)
