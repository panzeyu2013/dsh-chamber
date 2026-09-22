/**
 * Test-only ESM loader for this package's node unit tests.
 *
 * WHY: the vendored dsh tree (`vendor/harness-packages/@deepseek-ai/*`) is
 * source-only — its `package.json` main/exports point at `lib/`, which exists
 * only after a full workspace build — so the two host adapters the forked
 * resolver imports statically cannot resolve in a plain `node test/…` run.
 * Both are replaced with fail-loud stand-ins (the repo's established pattern:
 * `scripts/dev/test-connection-loader.mjs` + `…/fixtures/schemastery-stub.mjs`),
 * while every other specifier resolves normally. Never used by the build, the
 * bundle, or the typecheck.
 */

import { createVendorResolve } from '../../../../scripts/dev/test-support/vendor-resolve.mjs'

/** Vendor specifier → stand-in module. */
export const resolve = createVendorResolve(new Map([
  ['@deepseek-ai/dsh-native-command', '../fixtures/native-command-stub.mjs'],
  ['@deepseek-ai/dsh-subprocess', '../fixtures/subprocess-stub.mjs'],
]), import.meta.url)
