/**
 * seed-build.mjs — the single esbuild bundler for the chamber seed host packages.
 *
 * The four seed packages (client-graph / git-worktree / archive-cleanup /
 * open-in) each ship a build-time `dist/index.js` that the control plane seeds
 * into managed profiles with zero build steps at runtime (design 09 §3.5,
 * design 20 §6.2). This module owns the whole bundle policy — esbuild resolution
 * through the renderer's vite tree, the fixed node/esm/target shape, the
 * `@deepseek-ai/*` external boundary and the built-artifact existence
 * check — so a package's `scripts/build.mjs` carries only its own
 * entry/outfile/external configuration.
 *
 * Determinism: `absWorkingDir` is the package root (esbuild renders source
 * comments relative to it), so the built artifact is byte-identical from
 * any caller CWD. C8 in scripts/upstream/verify-upstream-touchpoints.mjs
 * rebuilds and byte-compares the four artifacts.
 *
 * esbuild is resolved through the renderer's vite tree (the
 * gen-typert-remotes.mjs pattern): the seed packages ship no runtime build
 * tooling of their own.
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/** Repository root, derived from this file's own location (never the caller CWD). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Bundle one seed package's host entry into its build-time dist artifact.
 * @param args - package root + the package-specific bundle configuration.
 * @param args.packageRoot - absolute package root (the esbuild absWorkingDir).
 * @param args.entry - entry path relative to the package root.
 * @param args.outfile - output path relative to the package root.
 * @param args.external - external specifier patterns (never bundled).
 * @param args.target - esbuild target string.
 * @returns nothing; exits non-zero when the artifact is missing afterwards.
 */
export async function buildSeedBundle({
  packageRoot,
  entry = 'src/index.ts',
  outfile = 'dist/index.js',
  external = ['@deepseek-ai/*'],
  target = 'node22',
}) {
  const requireFromRenderer = createRequire(join(REPO_ROOT, 'packages/renderer/package.json'))
  const viteEntry = requireFromRenderer.resolve('vite')
  const esbuildModule = await import(pathToFileURL(createRequire(viteEntry).resolve('esbuild')).href)
  const resolvedOutfile = join(packageRoot, outfile)

  await esbuildModule.build({
    entryPoints: [join(packageRoot, entry)],
    absWorkingDir: packageRoot,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target,
    outfile: resolvedOutfile,
    external,
    logLevel: 'info',
  })

  // The built artifact must exist after a successful build.
  if (!existsSync(resolvedOutfile)) {
    console.error(`seed-build: esbuild reported success but ${resolvedOutfile} is missing`)
    process.exit(1)
  }
  console.log(`seed-build: bundled ${resolvedOutfile}`)
}
