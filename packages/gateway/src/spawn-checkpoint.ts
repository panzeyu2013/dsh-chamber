/**
 * The managed profile-write spawn checkpoint.
 *
 * The control-plane local connection invokes `beforeSpawnCheckpoint` on both
 * spawn paths (health auto-restart and manual start) immediately before any
 * DSH_HOME seed or process spawn. Every spawn re-seeds the chamber host
 * packages / patch overlay into the web profile, so a spawn during the plugin
 * executor's `dsh plugin` pnpm write would interleave two writers.
 *
 * Null/absent manager (plane predates it, or a structural fake) resolves; a
 * manager reporting profileWriteInFlight() throws — a deferred spawn.
 */
import type { GatewayRuntimeManager } from './runtime-manager.ts'

export function createPluginWriteCheckpoint(runtimeManagerRef: {
  current: GatewayRuntimeManager | null
}): () => Promise<void> {
  return async () => {
    const runtimeManager = runtimeManagerRef.current
    // Optional call: a structural fake may predate the lease API; a missing method means no profile write is possible.
    if (runtimeManager !== null && runtimeManager.profileWriteInFlight?.()) {
      throw new Error('managed profile write in flight (plugin mutation); spawn deferred')
    }
  }
}
