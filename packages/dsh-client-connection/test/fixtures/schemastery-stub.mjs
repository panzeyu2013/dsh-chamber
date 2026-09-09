/**
 * Fail-loud schemastery stand-in for node unit tests that import the
 * connection client chain (see scripts/dev/test-connection-loader.mjs).
 *
 * Module evaluation builds the exported schema constants (`src/index.ts`
 * Config, `src/recovery-config.ts` ConnectionRecoveryConfigSchema,
 * `src/rpc-schema.ts`), so the DSL's construction entry points and their
 * chainable builder methods are inert and return the same inert schema. Any
 * REAL schema use — calling the schema, or reading any property outside the
 * construction/builder vocabulary (parse/safeParse/… ) — throws instead of
 * silently accepting input.
 *
 * Vocabulary note: an incomplete whitelist fails loud at module evaluation
 * (the throw below), never silently — extend it when a replayed upstream file
 * starts using another DSL entry point.
 */
const STUB_MESSAGE = '@deepseek-ai/schemastery is stubbed in node unit tests (vendor lib is source-only); '
  + 'schema-backed paths run through vite-resolved builds'

/** Construction entry points used while building the module-level schemas. */
const CONSTRUCTORS = new Set([
  'object', 'array', 'natural', 'number', 'string', 'boolean', 'literal', 'union', 'record', 'unknown',
])
/** Chainable builder methods of those constructions. */
const BUILDERS = new Set(['min', 'max', 'default', 'optional', 'required', 'description', 'comment'])

function inertSchema() {
  const schema = () => { throw new Error(STUB_MESSAGE) }
  const proxy = new Proxy(schema, {
    get(_target, property) {
      if (typeof property === 'symbol') return undefined
      if (BUILDERS.has(property)) return () => proxy
      throw new Error(`${STUB_MESSAGE} (unsupported property ${JSON.stringify(property)})`)
    },
    apply() {
      throw new Error(STUB_MESSAGE)
    },
  })
  return proxy
}

export default new Proxy({}, {
  get(_target, property) {
    if (typeof property === 'symbol') return undefined
    if (CONSTRUCTORS.has(property)) return () => inertSchema()
    throw new Error(`${STUB_MESSAGE} (unsupported constructor ${JSON.stringify(property)})`)
  },
})
