/**
 * Pure construction policy for the browser connection plugin.
 *
 * This leaf deliberately owns no transport implementation imports: production
 * injects `WebApiClient` (the shared HTTP + WebSocket carrier) and
 * `createWebConnectionRpc`, while node:test can pin that the SAME resolved
 * per-entry base path reaches both without loading the source-only vendor
 * graph. Keeping the decision here also prevents a future fixture/transport
 * refactor from silently dropping the prefix from only one carrier.
 */
import { resolveInstanceBasePath } from '../api-path.ts'

/** Optional page-owned physical transport (worker preview upstream seam). */
export interface CarrierTransport<ApiClient, RpcFetch> {
  createApiClient(): ApiClient
  fetch: RpcFetch
}

/** Fixture carrier: the fixture API object also owns its generic RPC face. */
export type FixtureCarrier<ApiClient, Rpc> = ApiClient & { readonly rpc: Rpc }

/** Factories supplied by the browser plugin's production implementation. */
export interface ConnectionCarrierFactories<ApiClient, Rpc, RpcFetch> {
  /** Construct the one carrier used by both unary HTTP and event WebSockets. */
  createHttpAndWebSocketApi(options: { basePath: string }): ApiClient
  /** Construct the generic RPC carrier over the same per-entry prefix. */
  createRpc(options: { basePath: string; doFetch?: RpcFetch }): Rpc
}

/** Complete set of carriers installed into `ctx.connection`. */
export interface ConnectionCarrierAssembly<ApiClient, Rpc> {
  readonly basePath: string
  readonly api: ApiClient
  readonly rpc: Rpc
}

/**
 * Resolve one immutable per-entry prefix and fan it out to every web carrier.
 *
 * Fixture and page-owned transports retain their upstream precedence. Even
 * when a page-owned transport replaces the HTTP/WS API half, the generic RPC
 * factory still receives the same basePath plus that transport's fetch hook.
 */
export function assembleConnectionCarriers<ApiClient, Rpc, RpcFetch>(
  explicitBasePath: string | undefined,
  fixture: FixtureCarrier<ApiClient, Rpc> | undefined,
  transport: CarrierTransport<ApiClient, RpcFetch> | undefined,
  factories: ConnectionCarrierFactories<ApiClient, Rpc, RpcFetch>,
): ConnectionCarrierAssembly<ApiClient, Rpc> {
  const basePath = resolveInstanceBasePath(explicitBasePath)
  const api = fixture
    ?? transport?.createApiClient()
    ?? factories.createHttpAndWebSocketApi({ basePath })
  const rpc = fixture?.rpc ?? factories.createRpc({
    basePath,
    ...(transport === undefined ? {} : { doFetch: transport.fetch }),
  })
  return { basePath, api, rpc }
}
