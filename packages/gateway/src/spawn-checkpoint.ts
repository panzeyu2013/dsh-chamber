/**
 * Design 21 §6.3 (decisions 6/17) — the managed profile-write spawn
 * checkpoint.
 *
 * The control-plane local connection invokes `beforeSpawnCheckpoint` on both
 * spawn paths — the health auto-restart (local-connection.ts restart) and the
 * manual start — immediately before any DSH_HOME seed or process spawn. Every
 * spawn re-seeds the chamber host packages / patch overlay into the web
 * profile, so a spawn during the A1 executor's `dsh plugin` pnpm write would
 * interleave two writers on the same profile.
 *
 * This factory builds the production checkpoint from a lazy manager reference
 * and is a pure unit-testable closure: null/absent manager (plane created
 * before the manager, or a structural lifecycle fake) resolves — no lease can
 * exist yet; a manager reporting profileWriteInFlight() throws, which the
 * local connection treats as a deferred spawn (its restart loop retries with
 * backoff; a manual start fails loud into an honest error state).
 */
import type { GatewayRuntimeManager } from './runtime-manager.ts'

export function createPluginWriteCheckpoint(runtimeManagerRef: {
  current: GatewayRuntimeManager | null
}): () => Promise<void> {
  return async () => {
    const runtimeManager = runtimeManagerRef.current
    // Optional call: structural lifecycle fakes (index.ts gates use the same
    // defensive pattern) may predate the lease API. A missing method means no
    // profile write is possible — the spawn proceeds.
    if (runtimeManager !== null && runtimeManager.profileWriteInFlight?.()) {
      throw new Error('managed profile write in flight (plugin mutation); spawn deferred')
    }
  }
}
