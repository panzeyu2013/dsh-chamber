/**
 * Test-only ESM loader for this package's node unit tests.
 *
 * WHY: `src/client/panel-source.ts` VALUE-imports the dsh store engine
 * (`@deepseek-ai/dsh-client-store` → `createSnapshotStore`, the wiring upstream's
 * ui-sidebar uses), whose vendored package.json points `main` at an unbuilt
 * `lib/`, so a plain `node test/…` run cannot resolve it. This loader maps that
 * specifier to `test/support/vendor-store-double.mjs`, a contract-faithful double
 * (getSnapshot/subscribe/set with sync, change-only notification).
 *
 * WHY NOT THE VENDOR SOURCE: the real
 * module imports bare `zustand`/`immer`, so importing it in a test makes the
 * suite depend on the vendored workspace member's install shape — it resolves
 * only on a machine that happens to have vendor `node_modules` and otherwise
 * fails with `ERR_MODULE_NOT_FOUND: Cannot find package 'zustand'` (both through
 * the raw submodule path and the member path). Production wiring is still
 * proven elsewhere, not by this test: a source lock (test/upstream-alignment
 * test) pins the import and the `set()` write path, and
 * `pnpm run build:renderer` resolves the same specifier to vendor source through
 * vite's deepseekSource alias — a broken import fails the build.
 *
 * The repo's established pattern for a vendor package whose source cannot run
 * under node is a fail-loud stub — see
 * `packages/dsh-chamber-seed-open-in/test/support/vendor-loader.mjs`. Never used by the
 * build, the bundle, or the typecheck.
 */
import { createVendorResolve } from '../../../../scripts/dev/test-support/vendor-resolve.mjs'

/** Vendor specifier → vendor source entry, exactly as vite aliases it. */
export const resolve = createVendorResolve(new Map([
  ['@deepseek-ai/dsh-client-store', './vendor-store-double.mjs'],
]), import.meta.url)
