/**
 * Page-level plugin-refresh requests (design 09 §3.7 / design 15 §6).
 *
 * WHY a separate module and not methods on the aggregate store: the settings bridge
 * runs inside the HOSTING source's boot ctx and the settings plugin manager inside the
 * SELECTED source's ctx, so a retry has to name a source id the caller does not own —
 * these requests are page-level, not per-instance facts. They share the aggregate
 * store's ONE fan-out discipline through the exported `createChannel` (never a second
 * bus implementation), and they exist outside aggregate-store.ts so that file's god-file
 * ratchet (scripts/gates/file-budgets.json) is not raised for a stateless request seam.
 *
 * Contract: one-way requests. The App layer relays the request to the mounted shell, which
 * owns the resync and the plugin-refresh reload budget (`document-reload-budget.ts`); this
 * seam carries no budget or fence of its own, and callers never learn the outcome from
 * here (the per-source `pluginDiagnostic` fact is the outcome surface).
 */
import { createChannel } from './aggregate-store.ts'
import { assertSingletonModule } from './singleton.ts'

// Page-level request seam, imported by the renderer shell/hook and the settings panel:
// same singleton discipline as aggregate-store (a duplicated module would silently split
// the request bus).
assertSingletonModule('plugin-refresh-requests')

/** App-layer handler for one source's client-plugin graph resync request. */
type ClientGraphResyncListener = (sourceId: string) => void

const clientGraphResyncChannel = createChannel<Parameters<ClientGraphResyncListener>>(
  () => '[dsh-chamber] client-graph resync request listener threw',
)

/** Live listener count, so a request that can never be answered is loud (the wiring
 *  source-lock is the compile-time guard; this is the runtime one). */
let listenerCount = 0

/**
 * Ask the App layer for one client-plugin graph resync of `sourceId`: the mounted
 * shell re-subscribes its page-channel `pluginGraph` topic so the host re-delivers the
 * whole graph through the existing frame pipeline (a missed frame must not leave the
 * settings surface stale). No-op for an unknown or disarmed source.
 * @param sourceId - proxy source id ('local' | '<kind>-<id>').
 */
export function requestClientGraphResync(sourceId: string): void {
  if (listenerCount === 0) {
    console.warn(`[dsh-chamber] client-graph resync for ${sourceId} has no listener (App relay not mounted?)`)
  }
  clientGraphResyncChannel.emit(sourceId)
}

/**
 * App-layer subscription to graph resync requests; returns the unsubscribe.
 * @param listener - called with the source id whose graph should be re-synced.
 */
export function onClientGraphResyncRequest(listener: ClientGraphResyncListener): () => void {
  listenerCount += 1
  const unsubscribe = clientGraphResyncChannel.subscribe(listener)
  return () => {
    listenerCount -= 1
    unsubscribe()
  }
}
