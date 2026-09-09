/**
 * ESM loader for the dsh-client-connection node unit tests.
 *
 * Upstream v0.1.3-alpha.2 moved the recovery config into
 * `src/recovery-config.ts`, which imports `@deepseek-ai/schemastery` at
 * runtime. The vendored schemastery is source-only with a `lib/` export map,
 * so bare-import resolution fails under plain Node (its source is also not
 * erasable-only and pulls `@deepseek-ai/cosmokit`). The chamber node test
 * files never exercise the schema (no controller/bootstrap construction), so
 * the specifier is replaced with a fail-loud stub: module evaluation
 * succeeds, and any actual schema use throws instead of silently mis-validating.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

const STUB_URL = pathToFileURL(fileURLToPath(new URL(
  '../../packages/dsh-client-connection/test/fixtures/schemastery-stub.mjs',
  import.meta.url,
))).href

const STUB_SPECIFIERS = new Set(['@deepseek-ai/schemastery'])

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (STUB_SPECIFIERS.has(specifier)) {
    return { url: STUB_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
