/** Resolver hooks for workspace-loader.mjs (see its header). */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const PACKAGES_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))

/** src/<entry> candidates for a workspace package that has no dist build here. */
function srcEntry (name) {
  const base = join(PACKAGES_ROOT, name, 'src')
  for (const candidate of ['index.ts', 'index.js']) {
    const path = join(base, candidate)
    if (existsSync(path)) return pathToFileURL(path).href
  }
  return null
}

export async function resolve (specifier, context, nextResolve) {
  const match = /^@dsh-chamber\/([a-z0-9-]+)$/.exec(specifier)
  if (match !== null) {
    const entry = srcEntry(match[1])
    if (entry !== null) return { url: entry, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
