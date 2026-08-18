#!/usr/bin/env node
/**
 * build.mjs — bundle src/index.ts → dist/index.js with esbuild.
 *
 * esbuild is resolved through the renderer's vite tree (the
 * gen-typert-remotes.mjs pattern): this host plugin ships no runtime build
 * tooling — the control plane seeds dist/index.js directly into the managed
 * profile (zero build at runtime), so the build runs only in the chamber dev
 * tree. `@deepseek-ai/*` imports are left external: at runtime the dsh
 * process resolves them from the dsh install tree / profile node_modules
 * (dual-anchor module resolution), never from this bundle.
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')

// esbuild is vite's transitive dependency — resolve it through vite's tree.
const requireFromRenderer = createRequire(fileURLToPath(new URL('../../renderer/package.json', import.meta.url)))
const viteEntry = requireFromRenderer.resolve('vite')
// import() treats a string specifier as a URL: a POSIX absolute path parses as
// a file: URL, but a Windows absolute path ("D:\…") parses as protocol "d:" and
// fails with ERR_UNSUPPORTED_ESM_URL_SCHEME — always convert to a file URL.
const esbuildModule = await import(pathToFileURL(createRequire(viteEntry).resolve('esbuild')).href)

const result = await esbuildModule.build({
  entryPoints: [join(packageRoot, 'src/index.ts')],
  // Absolute working dir = this package: esbuild renders source comments in
  // the bundle relative to it, so the output is byte-identical regardless of
  // the caller's CWD (a committed artifact — the control plane seeds it with
  // zero build steps; the build must be reproducible from any directory).
  absWorkingDir: packageRoot,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(packageRoot, 'dist/index.js'),
  // Host-side runtime deps resolve from the dsh install tree / profile
  // node_modules (dual-anchor resolution) — never bundled in.
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
})
if (result.errors.length > 0) {
  console.error('build.mjs: esbuild reported errors')
  process.exit(1)
}
console.log(`build.mjs: bundled ${join(packageRoot, 'dist/index.js')}`)
