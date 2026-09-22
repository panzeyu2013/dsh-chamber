/**
 * Shared node ESM resolve-hook factory for the test-only vendor loaders
 * (2026-12 single-sourcing pass).
 *
 * Three package loaders (sidebar, settings-bridge, seed-open-in) and the
 * scripts/dev loaders all carried the same hook body — "table lookup, else
 * nextResolve; short-circuit with the mapped URL" — while differing only in
 * WHICH specifiers they map (a local double, vendor source, or fail-loud
 * stubs). The mapping genuinely belongs to each package; the hook contract
 * (shortCircuit semantics, fallthrough) does not, and now lives here.
 *
 * Test-only: never used by the build, the bundle, or the typecheck.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Build a resolve hook over one specifier table.
 * @param entries - vendor specifier → target path RELATIVE to the loader file.
 * @param baseUrl - the loader's `import.meta.url`.
 * @returns the hook to export as `resolve`.
 */
export function createVendorResolve(entries, baseUrl) {
  const targets = new Map()
  for (const [specifier, relative] of entries) {
    targets.set(specifier, pathToFileURL(fileURLToPath(new URL(relative, baseUrl))).href)
  }
  /** @type {import('node:module').ResolveHook} */
  return async function resolve(specifier, context, nextResolve) {
    const url = targets.get(specifier)
    if (url === undefined) return nextResolve(specifier, context)
    return { url, shortCircuit: true }
  }
}
