/**
 * Pure construction policy for the browser connection plugin.
 *
 * This leaf deliberately owns no transport implementation imports: production
 * injects `createWebConnectionRpc` (the generic RPC carrier), while node:test
 * can pin that the SAME resolved per-entry base path reaches it without
 * loading the source-only vendor graph. Keeping the decision here also
 * prevents a future carrier refactor from silently dropping the prefix from
 * the carrier.
 *
 * Rebased for upstream v0.1.2-alpha.1: the WebApiClient/IApiClient half is
 * gone (the upstream API-client surface was deleted with the downlinks), so
 * the assembly now owns the generic RPC carrier only — plus the worker-local
 * stream opener when the page-owned transport provides one. The module shape
 * (resolve one prefix, fan it into every carrier) and the export names are
 * unchanged.
 */
import { resolveInstanceBasePath } from '../api-path.ts'
import type { RpcFetch, RpcStreamOpen } from './rpc.ts'

/** Optional page-owned physical transport (worker preview upstream seam). */
export interface CarrierTransport {
  fetch: RpcFetch
  openStream?: RpcStreamOpen
}

/** Factories supplied by the browser plugin's production implementation. */
export interface ConnectionCarrierFactories<Rpc> {
  /** Construct the generic RPC carrier over the same per-entry prefix. */
  createRpc(options: { basePath: string; doFetch?: RpcFetch; openStream?: RpcStreamOpen }): Rpc
}

/** Complete set of carriers installed into `ctx.connection`. */
export interface ConnectionCarrierAssembly<Rpc> {
  readonly basePath: string
  readonly rpc: Rpc
}

/**
 * Resolve one immutable per-entry prefix and fan it out to the RPC carrier.
 *
 * The page-owned transport keeps its upstream precedence: even when it
 * replaces the fetch/stream halves, the generic RPC factory still receives the
 * same basePath plus that transport's hooks. The upstream browser-fixture
 * carrier branch is gone with `src/client/fixture.ts` (registry dropped).
 */
export function assembleConnectionCarriers<Rpc>(
  explicitBasePath: string | undefined,
  transport: CarrierTransport | undefined,
  factories: ConnectionCarrierFactories<Rpc>,
): ConnectionCarrierAssembly<Rpc> {
  const basePath = resolveInstanceBasePath(explicitBasePath)
  const rpc = factories.createRpc({
    basePath,
    ...(transport === undefined ? {} : {
      doFetch: transport.fetch,
      ...(transport.openStream === undefined ? {} : { openStream: transport.openStream }),
    }),
  })
  return { basePath, rpc }
}
