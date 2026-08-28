/**
 * Settings bridge server roster: the renderer-published chamberBridge
 * projection (design 05 §3) — the same non-secret source the sidebar and
 * the App layer consume (id / authoritative sourceFingerprint / kind / label /
 * connected / phase). No tunnel URLs, no SSH material ever cross this
 * module. The chamberBridge face is ambient (vendor-modules.d.ts) — this
 * package bundles independently of the sidebar package's own sources.
 */
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import { serverProjectionSignature } from './server-selector.ts'

/** One server row the bridge section renders. */
export type BridgeServerRow = ChamberServerAggregate

/** Latest published server projection (non-authoritative; renderer-owned store). */
export function getServers(): BridgeServerRow[] {
  return chamberBridge.getServers()
}

/**
 * Subscribe to projection refreshes with a rendered-surface dedup: the
 * listener fires only when the source owner or a rendered roster/plugin
 * diagnostic field actually changed. Timestamp-only publishes stay
 * suppressed; the collision-safe signature includes sourceFingerprint and
 * every diagnostic field the plugin section renders, including pluginId.
 * @param listener - invoked on meaningful projection changes.
 * @returns unsubscribe.
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
