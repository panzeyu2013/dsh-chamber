/**
 * Test-only ESM loader shared by the packages/renderer/test/lifecycle/shell*.test.ts
 * split.
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
 * `node --import ./scripts/dev/test-shell-register.mjs ...`). Never used by the
 * build or typecheck.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

const FIXTURE_URL = pathToFileURL(
  fileURLToPath(new URL('../../packages/renderer/test-fixtures/dsh-client-web.mjs', import.meta.url)),
).href
/** shell.ts 的 sidebar-shared 消费面（chamberBridge + describeThrown）：重导出真实实现的
 *  最小 shim，避免整桶把 source-only 的 dsh 包拖进隔离测试。 */
const SIDEBAR_SHARED_URL = pathToFileURL(
  fileURLToPath(new URL('../../packages/renderer/test-fixtures/sidebar-shared.mjs', import.meta.url)),
).href

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-client-web') {
    return { url: FIXTURE_URL, shortCircuit: true }
  }
  // Resolve to the two-symbol shim instead of the package's shared barrel: the
  // barrel also links the source-only dsh connection/runtime packages that this
  // isolated Node test intentionally does not install or execute.
  if (specifier === '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared') {
    return { url: SIDEBAR_SHARED_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
