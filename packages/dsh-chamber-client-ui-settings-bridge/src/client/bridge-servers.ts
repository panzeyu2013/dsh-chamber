/**
 * Settings bridge server roster: the renderer-published chamberBridge projection —
 * the same non-secret source the sidebar and App layer consume (id / authoritative
 * sourceFingerprint / kind / label / connected / phase). No tunnel URLs, no SSH
 * material ever cross this module. The face resolves the real sidebar `shared`
 * source; no handwritten ambient mirror is kept.
 */
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core'
import { serverProjectionSignature } from './server-selector.ts'

/** One server row the bridge section renders. */
export type BridgeServerRow = ChamberServerAggregate

/** Latest published server projection (non-authoritative; renderer-owned store). */
export function getServers(): BridgeServerRow[] {
  return chamberBridge.getServers()
}

/**
 * Subscribe to projection refreshes with a rendered-surface dedup: the listener fires
 * only when the source owner or a rendered roster/plugin diagnostic field actually
 * changed (timestamp-only publishes stay suppressed). The collision-safe signature
 * includes sourceFingerprint and every diagnostic field the plugin section renders.
 */
export function subscribeServers(listener: () => void): () => void {
  let last = serverProjectionSignature(getServers())
  return chamberBridge.subscribe(() => {
    const next = serverProjectionSignature(getServers())
    if (next === last) return
    last = next
    listener()
  })
}
