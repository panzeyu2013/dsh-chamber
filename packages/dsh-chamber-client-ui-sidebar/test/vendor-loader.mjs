/**
 * Test-only ESM loader for this package's node unit tests.
 *
 * WHY: the vendored dsh tree (`vendor/harness-packages/@deepseek-ai/*`) is
 * source-only — every vendor `package.json` points its `main`/`exports` at
 * `lib/`, which exists only after a full workspace build — so a src module that
 * VALUE-imports a vendor package cannot resolve in a plain `node test/…` run.
 * The vite composite build resolves the same specifiers to vendor SOURCE
 * (`packages/renderer/vite.config.mjs`, the deepseekSource plugin), so this
 * loader maps them to that same source path: the test then exercises the very
 * factory the bundle compiles, never a stand-in
 * (`src/client/panel-source.ts` rides the store engine's
 * `createSnapshotStore`, 2026-09-11 upstream-alignment A5).
 *
 * RESOLUTION ROOT MATTERS (2026-09-12 CI fix): map through the WORKSPACE MEMBER
 * path (`vendor/harness-packages/@deepseek-ai/…`, the symlink tree
 * `pnpm-workspace.yaml` declares), never the raw submodule path
 * (`vendor/harness-checkout/packages/…`): the mapped module imports bare
 * `zustand`/`immer`, and node resolves those by walking up from the imported
 * file — only the workspace member directory carries the linked dependencies
 * (`…/@deepseek-ai/dsh-client-store/node_modules`). With the submodule path the
 * suite passed on a machine that happened to have a stray
 * `vendor/harness-checkout/node_modules` and failed in CI (run 34667229056,
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'zustand'`). Same form the repo
 * already uses in `packages/renderer/src/host-graph.ts` and
 * `packages/dsh-chamber-client-ui-layout/test/layout-store.test.ts`.
 *
 * The repo's established pattern for the other direction (a vendor package
 * whose source cannot run under node) is a fail-loud stub — see
 * `packages/dsh-chamber-seed-open-in/test/vendor-loader.mjs`. Never used by the
 * build, the bundle, or the typecheck.
 */

import { fileURLToPath, pathToFileURL } from 'node:url'

/** Vendor specifier → vendor source entry, exactly as vite aliases it. */
const SOURCES = new Map([
  [
    '@deepseek-ai/dsh-client-store',
    '../../../vendor/harness-packages/@deepseek-ai/dsh-client-store/src/index.ts',
  ],
])

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  const relative = SOURCES.get(specifier)
  if (relative === undefined) return nextResolve(specifier, context)
  const url = pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href
  return { url, shortCircuit: true }
}
