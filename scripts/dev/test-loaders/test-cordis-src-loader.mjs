/**
 * Test-only ESM loader for the real Cordis source used by the N-ctx base-path
 * contract test (design 09 §4).
 *
 * The vendored Cordis/cosmokit tree is source-only (no lib build), so the bare
 * package specifiers cannot resolve under plain Node. This loader maps the two
 * runtime specifiers to their pinned vendor sources; Node's
 * --experimental-transform-types handles the upstream parameter-property syntax.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

const SOURCE_URLS = new Map([
  ['@deepseek-ai/cordis', pathToFileURL(fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/cordis/src/index.ts', import.meta.url))).href],
  ['@deepseek-ai/cosmokit', pathToFileURL(fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/cosmokit/src/index.ts', import.meta.url))).href],
])

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  const mapped = SOURCE_URLS.get(specifier)
  if (mapped !== undefined) return { url: mapped, shortCircuit: true }
  return nextResolve(specifier, context)
}
