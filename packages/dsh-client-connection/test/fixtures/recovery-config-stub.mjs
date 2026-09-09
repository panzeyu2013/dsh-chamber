/**
 * Recovery-config stand-in for the dsh-client-connection apply-seam test (see
 * scripts/dev/test-connection-loader.mjs).
 *
 * The real `src/recovery-config.ts` builds a schemastery schema at module load
 * and validates through it; the vendored schemastery is source-only, so the
 * node unit tests cannot run the real schema. The apply seam under test needs
 * only the RESOLVED recovery timing (upstream `apply` resolves it eagerly from
 * the page global), so this stub returns the schema defaults merged with the
 * input. The schema export is fail-loud: a test that actually validates must
 * run through the vite-resolved build instead.
 */
const DEFAULTS = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10_000,
  generationReadyWarnMs: 3_000,
  generationReadyTimeoutMs: 15_000,
}

export const ConnectionRecoveryConfigSchema = () => {
  throw new Error(
    'dsh-client-connection recovery-config is stubbed in node unit tests (schemastery is source-only); '
    + 'schema-backed paths run through vite-resolved builds',
  )
}

export function resolveConnectionConfig(config = {}) {
  return { ...DEFAULTS, ...config }
}
