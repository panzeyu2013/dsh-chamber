/**
 * ESM loader for the real dsh-client-web boot seam test.
 * It replaces only external source-only workspace packages and CSS loading;
 * `packages/dsh-client-web/src/boot.ts` and every local helper remain real.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

const FIXTURE_URL = pathToFileURL(fileURLToPath(new URL(
  '../../packages/dsh-client-web/test/fixtures/boot-runtime.mjs',
  import.meta.url,
))).href

const FIXTURE_SPECIFIERS = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-client-modules/client',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
])

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (FIXTURE_SPECIFIERS.has(specifier)) {
    return { url: FIXTURE_URL, shortCircuit: true }
  }
  if (specifier.endsWith('.css')) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

/** @type {import('node:module').LoadHook} */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return {
      format: 'module',
      source: 'export default Object.freeze({})',
      shortCircuit: true,
    }
  }
  return nextLoad(url, context)
}
