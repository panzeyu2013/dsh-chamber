/**
 * ESM loader for the dsh-client-connection node unit tests.
 *
 * Two vendor-source-only seams are stubbed so the chamber node tests can load
 * the real plugin chain without the source-only vendor graph:
 *
 *  1. `@deepseek-ai/schemastery` — upstream v0.1.3-alpha.2 moved the recovery
 *     config into `src/recovery-config.ts`, which imports schemastery at
 *     runtime. The vendored schemastery is source-only with a `lib/` export
 *     map, so bare-import resolution fails under plain Node (its source is also
 *     not erasable-only and pulls `@deepseek-ai/cosmokit`).
 *  2. `src/client/fixture.ts` — pulled in by `src/client/index.ts` (the apply
 *     seam test) and itself importing the built vendor graph
 *     (`@deepseek-ai/dsh-llm/lib/...`), which does not exist in a source
 *     checkout. The apply-seam test also replaces `src/recovery-config.ts`
 *     (whose schema cannot run under the schemastery stub) with a resolved
 *     defaults stub.
 *
 * Both replacements are fail-loud: module evaluation succeeds, and any actual
 * use throws instead of silently returning a wrong value.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

function stubUrl(relative) {
  return pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href
}

const STUB_SPECIFIERS = new Map([
  ['@deepseek-ai/schemastery', stubUrl('../../packages/dsh-client-connection/test/fixtures/schemastery-stub.mjs')],
])
const STUB_PATH_SUFFIXES = new Map([
  ['/src/client/fixture.ts', stubUrl('../../packages/dsh-client-connection/test/fixtures/fixture-rpc-stub.mjs')],
  ['/src/recovery-config.ts', stubUrl('../../packages/dsh-client-connection/test/fixtures/recovery-config-stub.mjs')],
])

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  const stubbed = STUB_SPECIFIERS.get(specifier)
  if (stubbed !== undefined) {
    return { url: stubbed, shortCircuit: true }
  }
  const resolved = await nextResolve(specifier, context)
  for (const [suffix, url] of STUB_PATH_SUFFIXES) {
    if (resolved.url.endsWith(suffix)) return { url, shortCircuit: true }
  }
  return resolved
}
