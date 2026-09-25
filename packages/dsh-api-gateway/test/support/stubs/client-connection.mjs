/**
 * `@deepseek-ai/dsh-client-connection/client` surface for the client-invocation
 * behaviour suite. The fork imports only `recoveryOverridesForTransport` at
 * runtime (the rest are erased type imports); the connection package's barrel
 * points at its unbuilt `lib/`, so the stub re-exports the REAL source policy —
 * a leaf with no further imports — instead of copying its logic.
 */
export { recoveryOverridesForTransport } from '../../../../dsh-client-connection/src/client/recovery-policy.ts'
