/**
 * Test-only ESM loader for this package's node unit tests.
 *
 * WHY: `src/client/panel-source.ts` VALUE-imports the dsh store engine
 * (`@deepseek-ai/dsh-client-store` → `createSnapshotStore`, the wiring upstream's
 * ui-sidebar uses), whose vendored package.json points `main` at an unbuilt
 * `lib/`, so a plain `node test/…` run cannot resolve it. This loader maps that
 * specifier to `test/vendor-store-double.mjs`, a contract-faithful double
 * (getSnapshot/subscribe/set with sync, change-only notification).
 *
 * WHY NOT THE VENDOR SOURCE (2026-09-12 CI fix, run 34667681904): the real
 * module imports bare `zustand`/`immer`, so importing it in a test made the
 * suite depend on the vendored workspace member's install shape — it passed on a
 * machine that happened to have vendor `node_modules` and failed in CI with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'zustand'` (both through the raw
 * submodule path and through the member path). Production wiring is still
 * proven elsewhere, not by this test: a source lock (test/upstream-alignment
 * test, A5) pins the import and the `set()` write path, and
 * `pnpm run build:renderer` resolves the same specifier to vendor source through
 * vite's deepseekSource alias — a broken import fails the build.
 *
 * The repo's established pattern for a vendor package whose source cannot run
 * under node is a fail-loud stub — see
 * `packages/dsh-chamber-seed-open-in/test/vendor-loader.mjs`. Never used by the
 * build, the bundle, or the typecheck.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Vendor specifier → vendor source entry, exactly as vite aliases it. */
const SOURCES = new Map([
  [
    '@deepseek-ai/dsh-client-store',
    './vendor-store-double.mjs',
  ],
])

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  const relative = SOURCES.get(specifier)
  if (relative === undefined) return nextResolve(specifier, context)
  const url = pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href
  return { url, shortCircuit: true }
}
