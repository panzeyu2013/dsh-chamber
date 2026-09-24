/**
 * Pure construction policy for the browser connection plugin: resolve one
 * immutable per-entry prefix and fan it into the generic RPC carrier (plus the
 * worker-local stream opener). Production injects the RPC factory, so the
 * fan-out stays testable without any transport implementation import.
 */
import { resolveInstanceBasePath } from '../api-path.ts'
import type { RpcFetch, RpcStreamOpen } from './rpc.ts'

export interface CarrierTransport {
  fetch: RpcFetch
  openStream?: RpcStreamOpen
}

export interface ConnectionCarrierFactories<Rpc> {
  createRpc(options: { basePath: string; doFetch?: RpcFetch; openStream?: RpcStreamOpen }): Rpc
}

export interface ConnectionCarrierAssembly<Rpc> {
  readonly basePath: string
  readonly rpc: Rpc
}

/**
 * Resolve one immutable per-entry prefix and fan it out to the RPC carrier; a
 * page-owned transport keeps upstream precedence — the factory receives the same
 * basePath plus that transport's fetch/stream hooks.
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
