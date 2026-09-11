/**
 * Test-only ESM loader for this package's node unit tests.
 *
 * WHY (2026-09-11 upstream-alignment A2): `src/client/section-rows.ts` now
 * VALUE-imports the official `resolveSlotLabel` from
 * `@deepseek-ai/dsh-client-ui-slots` — the function upstream's own ledger→row
 * projection uses — instead of keeping a local copy of it. The vendored dsh
 * tree (`vendor/harness-packages/@deepseek-ai/*`) is source-only: every vendor
 * `package.json` points `main`/`exports` at a `lib/` that exists only after a
 * full workspace build, so a src module that value-imports a vendor package
 * cannot resolve in a plain `node test/…` run.
 *
 * The vite composite resolves the same specifier to vendor SOURCE
 * (`packages/renderer/vite.config.mjs`, the deepseekSource plugin), so this
 * loader maps it to that same source path: the tests exercise the very function
 * the bundle compiles, never a stand-in. Same pattern as the sidebar package's
 * `test/vendor-loader.mjs` (2026-09-11 upstream-alignment A5). Never used by
 * the build, the bundle, or the typecheck.
 */

import { fileURLToPath, pathToFileURL } from 'node:url'

/** Vendor specifier → vendor source entry, exactly as vite resolves it. */
const SOURCES = new Map([
  [
    '@deepseek-ai/dsh-client-ui-slots',
    '../../../vendor/harness-checkout/packages/client/ui-slots/src/index.ts',
  ],
])

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  const relative = SOURCES.get(specifier)
  if (relative === undefined) return nextResolve(specifier, context)
  const url = pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href
  return { url, shortCircuit: true }
}
