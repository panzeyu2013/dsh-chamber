/**
 * Chamber host gateway: read-only projection of the instance's client-plugin
 * boot graph (`clientModules.graph()` — the same graph the client-modules node
 * half injects as `window.__DSH_BOOT__`). Runs INSIDE the host as a web-profile
 * plugin: no write/execute/configuration surface; it never mutates
 * clientModules, loads code, or touches the Loader.
 * Endpoint contract (global, fixed): namespace 'clientGraph', method 'graph' →
 * wire endpoint 'clientGraph/graph', returning the WebBootGraph shape
 * {rev, entries: [{id, url, rev, inject?, immediately?}]}, single-sourced from
 * client-modules' client/manifest.ts.
 * Vendor TypertGatewayService discovers live @Remote-marked subclasses; `static inject` orders after the node half.
 */

import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: erased at build, so the runtime bundle imports only
// dsh-typert-protocol (the `ctx.clientModules` augmentation and WebBootGraph
// shape come from the client-modules node half).
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** Remote-only gateway serving the composed client boot graph. */
export class ClientGraphGateway extends TypertRemoteService {
  static inject = ['clientModules']

  constructor(ctx: Context) {
    super(ctx, 'clientGraph')
  }

  /**
   * Read the current composed boot graph. It is a stable object between changes
   * (client-modules recomposes on plugin fiber events), so a plain read on every
   * call is the single source of truth — no local cache to keep synchronized.
   */
  @Remote('graph')
  graph(): WebBootGraph {
    return this.ctx.clientModules.graph()
  }
}

export default ClientGraphGateway
