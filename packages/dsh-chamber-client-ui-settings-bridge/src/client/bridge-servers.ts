/**
 * Settings bridge server roster: the renderer-published chamberBridge
 * projection (design 05 §3) — the same non-secret source the sidebar and
 * the App layer consume (id / kind / label / connected / phase). No tunnel
 * URLs, no SSH material ever cross this module. The chamberBridge face is
 * ambient (vendor-modules.d.ts) — this package bundles independently of the
 * sidebar package's own sources.
 */
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-client-ui-sidebar/shared'

/** One server row the bridge section renders. */
export type BridgeServerRow = ChamberServerAggregate

/** Latest published server projection (non-authoritative; renderer-owned store). */
export function getServers(): BridgeServerRow[] {
  return chamberBridge.getServers()
}

/**
 * Field-level projection of the rendered surface. The renderer re-publishes
 * the projection on every poll tick (updatedAt changes each time), so this
 * canonical form is what the subscription compares against — a pure
 * `updatedAt` refresh must not re-render the whole settings shell.
 */
function projectionOf(servers: readonly BridgeServerRow[]): string {
  return servers.map(server => `${server.id}\u0000${server.kind}\u0000${server.label}\u0000${server.connected}\u0000${server.phase}`).join('\n')
}

/**
 * Subscribe to projection refreshes with a rendered-surface dedup: the
 * listener fires only when the id/kind/label/connected/phase projection
 * actually changed (chamberBridge re-publishes every poll tick, even when
 * nothing moved).
 * @param listener - invoked on meaningful projection changes.
 * @returns unsubscribe.
 */
export function subscribeServers(listener: () => void): () => void {
  let last = projectionOf(getServers())
  return chamberBridge.subscribe(() => {
    const next = projectionOf(getServers())
    if (next === last) return
    last = next
    listener()
  })
}
