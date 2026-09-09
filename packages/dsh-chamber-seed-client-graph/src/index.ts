/**
 * Chamber host gateway: expose the instance's client-plugin boot graph.
 *
 * TRUST MODEL — this package runs INSIDE the host: it is a web-profile
 * plugin of each managed dsh instance (the same process that serves the
 * instance's `/api` and `/plugins` routes). It exposes a READ-ONLY projection
 * of the host's composed `dsh.client` boot graph — `clientModules.graph()`,
 * the exact same graph the client-modules node half injects as
 * `window.__DSH_BOOT__` — so the chamber frontend can load bundles the
 * chamber composite entry does not cover. There is NO write, execute, or
 * configuration surface: the gateway only returns a stable in-memory
 * snapshot; it never mutates clientModules, never loads code itself, and
 * never touches the Loader.
 *
 * Endpoint contract (global, fixed — other chamber modules depend on it):
 *   namespace 'clientGraph', method 'graph' → wire endpoint 'clientGraph/graph'
 *   returns the WebBootGraph shape {rev, entries: [{id, url, rev, inject?, immediately?}]}
 *   (the wire shape of `clientModules.graph()`, single-sourced from
 *   @deepseek-ai/dsh-client-modules' client/manifest.ts).
 *
 * Mechanism (verified in the pinned harness commit, adopted as-is): the
 * host-side TypertGatewayService (vendor @deepseek-ai/dsh-api-gateway) SRC-
 * discovers any live TypertRemoteService subclass with @Remote markers —
 * no typert-generated artifacts are required (see vendor
 * packages/host/plugin-inventory, class PluginInventoryGateway). The gateway's
 * collectSrcClaims reads the instance's `typertRemote` binding, so this
 * service must be alive; `static inject = ['clientModules']` orders the
 * plugin after the client-modules node half and guarantees
 * `this.ctx.clientModules` is available when this plugin starts.
 */

import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
// Ambient Cordis augmentation (`ctx.clientModules`) + the WebBootGraph wire
// shape, both from the client-modules node half. Type-only: erased at build,
// so the runtime bundle imports only dsh-typert-protocol; the peer resolves
// from the dsh install tree / profile node_modules at runtime.
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** Remote-only gateway serving the composed client boot graph. */
export class ClientGraphGateway extends TypertRemoteService {
  static inject = ['clientModules']

  constructor(ctx: Context) {
    super(ctx, 'clientGraph')
  }

  /**
   * Read the current composed client-modules boot graph. The graph is a
   * stable object between changes (client-modules recomposes on plugin
   * fiber events), so a plain read on every call is the single source of
   * truth — no local cache to keep synchronized.
   * @returns the WebBootGraph served as `window.__DSH_BOOT__` on this instance.
   */
  @Remote('graph')
  graph(): WebBootGraph {
    return this.ctx.clientModules.graph()
  }
}

export default ClientGraphGateway
