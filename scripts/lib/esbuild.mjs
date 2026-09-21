/**
 * esbuild resolution through the renderer's vite tree — ONE copy of the lookup
 * that used to be pasted in every chamber build script and in the upstream gate
 * (P1-7 of the 13-scripts audit). esbuild is vite's transitive dependency, so it
 * is resolved via `packages/renderer` rather than declared anywhere.
 *
 * The four `dsh-chamber-seed-*` build.mjs keep their own copy on purpose: seed
 * build scripts are a parallel task's scope.
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Absolute path of the esbuild entry, or undefined when the tree is absent
 * (the upstream gate's advisory mode needs the undefined answer).
 */
export function resolveEsbuildPath(repoRoot = REPO_ROOT) {
  try {
    const requireFromRenderer = createRequire(join(repoRoot, 'packages', 'renderer', 'package.json'))
    const viteEntry = requireFromRenderer.resolve('vite')
    return createRequire(viteEntry).resolve('esbuild')
  } catch {
    return undefined
  }
}

/** Load esbuild; throws when it is not installed. */
export async function loadEsbuild(repoRoot = REPO_ROOT) {
  const resolved = resolveEsbuildPath(repoRoot)
  if (resolved === undefined) {
    throw new Error('esbuild not found through packages/renderer — run pnpm install first')
  }
  return import(pathToFileURL(resolved).href)
}
