/**
 * Gateway runtime-status wire identity (design 18): the `kind` discriminator
 * every gateway runtime status row carries. Node producer and browser consumer
 * re-export this single source; the cross-host lockstep test pins it against the
 * raw-JS/inline payload sites that cannot import it.
 */
export const GATEWAY_RUNTIME_STATUS_KIND = 'dsh-chamber-gateway-runtime' as const
