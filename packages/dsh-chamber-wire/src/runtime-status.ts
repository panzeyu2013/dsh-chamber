/**
 * Gateway runtime-status wire identity (design 18 §9.3 status contract,
 * design 17 §3): the `kind` discriminator every gateway runtime status row
 * carries. The Node producer (`packages/gateway`) and the browser consumer
 * contract (`dsh-chamber-client-core`) both re-export this single source; the
 * cross-host lockstep test pins it against the raw-JS/inline payload sites
 * that cannot import it.
 */
export const GATEWAY_RUNTIME_STATUS_KIND = 'dsh-chamber-gateway-runtime' as const
