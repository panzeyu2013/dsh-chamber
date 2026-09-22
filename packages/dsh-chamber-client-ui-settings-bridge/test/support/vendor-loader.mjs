/**
 * Test-only ESM loader for this package's node unit tests.
 *
 * WHY: `src/client/section-rows.ts` VALUE-imports the official
 * `resolveSlotLabel` from `@deepseek-ai/dsh-client-ui-slots` — the function
 * upstream's own ledger→row projection uses. The vendored dsh
 * tree (`vendor/harness-packages/@deepseek-ai/*`) is source-only: every vendor
 * `package.json` points `main`/`exports` at a `lib/` that exists only after a
 * full workspace build, so a src module that value-imports a vendor package
 * cannot resolve in a plain `node test/…` run.
 *
 * The vite composite resolves the same specifier to vendor SOURCE
 * (`packages/renderer/vite.config.mjs`, the deepseekSource plugin), so this
 * loader maps it to that same source path: the tests exercise the very function
 * the bundle compiles, never a stand-in. Same pattern as the sidebar package's
 * `test/support/vendor-loader.mjs`.
 *
 * RESOLUTION ROOT: mapped through the WORKSPACE MEMBER path
 * (`vendor/harness-packages/@deepseek-ai/…`) rather than the raw submodule path
 * — the member is the tree `pnpm-workspace.yaml` declares and the one
 * `packages/renderer/src/host-graph.ts` uses. This mapping is safe here because
 * the mapped module graph carries NO bare runtime specifier (every non-relative
 * import in `ui-slots/src/index.ts`, `./renderer.ts` and `./contract.ts` is
 * `import type`, erased before resolution); verified with the member's
 * `node_modules` hidden. The sidebar package's loader (same day) maps to a local
 * double instead, because ITS target imports bare `zustand`/`immer`.
 *
 * Never used by the build, the bundle, or the typecheck.
 */

import { createVendorResolve } from '../../../../scripts/dev/test-support/vendor-resolve.mjs'

/** Vendor specifier → vendor source entry, exactly as vite resolves it. */
export const resolve = createVendorResolve(new Map([
  ['@deepseek-ai/dsh-client-ui-slots', '../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-slots/src/index.ts'],
]), import.meta.url)
