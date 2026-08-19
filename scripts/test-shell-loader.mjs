/**
 * Test-only ESM loader for packages/renderer/src/shell.test.ts.
 *
 * The renderer has no install-tree copy of the dsh workspace packages (their
 * `lib/` types/bundles are not built in the source-only vendor tree), so
 * `@deepseek-ai/dsh-client-web` — which shell.ts imports — cannot resolve on
 * its own. node:test's `mock.module` cannot mock an unresolvable specifier
 * either (it resolves the real module first), so this loader maps the bare
 * specifier to the committed fixture (`packages/renderer/test-fixtures/
 * dsh-client-web.mjs`), which exposes a controllable AppWebEntry face.
 *
 * Registered via `--import` in the test:renderer-shell script (node >= 22:
 * `node --import ./scripts/test-shell-register.mjs ...`). Never used by the
 * build or typecheck.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

const FIXTURE_URL = pathToFileURL(
  fileURLToPath(new URL('../packages/renderer/test-fixtures/dsh-client-web.mjs', import.meta.url)),
).href

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-client-web') {
    return { url: FIXTURE_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
