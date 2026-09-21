/**
 * Shared test fixtures for the gateway-session surface of the two provider
 * suites (test/transport/ssh-provider-endpoint-auth.test.ts — gateway reached through the ssh tunnel —
 * and test/gateway/gateway-provider.test.ts — direct http). The former byte-identical
 * local twins (completeTestGatewaySessionHooks / completeTestSessionHooks +
 * GATEWAY_RUNTIME_STATUS) were unified here — dedupe audit N7. Bare helper
 * file, not a test: the desktop test script enumerates suites explicitly.
 * Packaging: lives under test/support/ (2026-12 cleanup), so the root
 * `*.ts` collection glob never picks it up — no build.files negate needed.
 */
import { GATEWAY_RUNTIME_IDENTITY } from '../../gateway-provider.ts'
import type { GatewaySessionProviderHooks } from '../../gateway-provider.ts'
import type { GatewayRegistrationAuthProof } from '../../gateway-session.ts'

export const GATEWAY_RUNTIME_STATUS = { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'stopped' }

/** Complete a partial gateway-session hooks object with a per-test closure
 *  state machine (generation / auth proof / cached cookie / invalidation). */
export function completeGatewaySessionHooks(partial: GatewaySessionProviderHooks): GatewaySessionProviderHooks {
  if (partial.ensureSession === undefined) throw new TypeError('test session hooks require ensureSession')
  let generation = 0
  let proof: GatewayRegistrationAuthProof | null = null
  let cached: string | null = null
  return {
    ensureSession: async (origin, password) => {
      const result = await partial.ensureSession!(origin, password)
      if (result.ok) cached = result.cookie
      return result
    },
    generation: partial.generation ?? (() => generation),
    registrationAuthProof: partial.registrationAuthProof ?? (() => proof),
    setRegistrationAuthProof: partial.setRegistrationAuthProof ?? ((_origin, next) => { proof = next }),
    cachedCookie: origin => partial.cachedCookie?.(origin) ?? cached,
    invalidate: origin => {
      generation += 1
      proof = null
      cached = null
      partial.invalidate?.(origin)
    },
  }
}
