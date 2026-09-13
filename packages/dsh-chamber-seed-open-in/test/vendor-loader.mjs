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

import { fileURLToPath, pathToFileURL } from 'node:url'

/** @param {string} relative - path relative to this file. */
function stubUrl(relative) {
  return pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href
}

/** Vendor specifier → stand-in module. */
const STUBS = new Map([
  ['@deepseek-ai/dsh-native-command', stubUrl('./fixtures/native-command-stub.mjs')],
  ['@deepseek-ai/dsh-subprocess', stubUrl('./fixtures/subprocess-stub.mjs')],
])

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS.get(specifier)
  if (stub !== undefined) return { url: stub, shortCircuit: true }
  return nextResolve(specifier, context)
}
