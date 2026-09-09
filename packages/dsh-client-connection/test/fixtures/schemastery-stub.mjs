/**
 * Fail-loud schemastery stand-in for node unit tests that import the
 * connection client chain (see scripts/dev/test-connection-loader.mjs).
 * Module evaluation calls `z.object(...)` while building the exported schema
 * constant, so `object()` returns an inert proxy; any real schema use
 * (validation/parse) throws rather than silently accepting input.
 */
function inertSchema() {
  return new Proxy({}, {
    get() {
      throw new Error(
        '@deepseek-ai/schemastery is stubbed in node unit tests (vendor lib is source-only); '
        + 'schema-backed paths run through vite-resolved builds',
      )
    },
  })
}

export default {
  object: () => inertSchema(),
}
