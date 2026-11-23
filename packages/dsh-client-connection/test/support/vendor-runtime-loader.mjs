/**
 * ESM resolver shim for the dsh-client-connection node suites.
 *
 * alpha.1's browser client half imports `brandString` from
 * `@deepseek-ai/dsh-brand` at RUNTIME. The vendored tree is source-only and the
 * package's export map points `.` at a `lib/` build that does not exist in this
 * checkout, so the bare specifier fails under plain Node. Map it to the vendor
 * SOURCE (erasable-only TypeScript with no runtime imports) instead of copying the
 * helper: the real module keeps the suite honest across an upstream re-sync.
 *
 * This shim is registered BESIDE scripts/dev/test-loaders/test-connection-register.mjs
 * (which still owns the schemastery / recovery-config replacements); the resolve
 * hooks chain, so this one only names the one specifier it owns.
 */
const BRAND_SOURCE = new URL(
  '../../../../vendor/harness-packages/@deepseek-ai/dsh-brand/src/index.ts',
  import.meta.url,
).href

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-brand') {
    return { url: BRAND_SOURCE, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
