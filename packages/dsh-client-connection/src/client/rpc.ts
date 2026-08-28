/** Browser caller for generic Connection unary RPC channels.
 *
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
 *
 * The only dsh source modification next to web-api-client.ts / api-path.ts /
 * connection.ts: the URL is built as `<instanceBase><channel>/<endpoint>` so
 * every generic RPC call lands under the control-plane's per-instance proxy
 * prefix. The origin resolution stays same-origin (`location.origin`, with the
 * `dsh.internal` fallback for no-location environments). With the stock base
 * path `/api` the URL is byte-identical to upstream. Chamber supplies the
 * explicit option from each entry's private Context; `window.__DSH_BASE_PATH__`
 * remains only as a compatibility fallback for other embedders.
 *
 * merged with upstream rc.2 transport override（RpcFetch/doFetch）.
 */

import {
  RpcId,
  serverResponseSchema,
  type ClientRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientConnectionRpc } from '../rpc.ts'
import { resolveInstanceBasePath } from '../api-path.ts'
import { randomUuid } from './random-uuid.ts'

const INTERNAL_BASE = 'http://dsh.internal'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** Transport this caller posts through; same signature as the global `fetch`. */
export type RpcFetch = (input: URL, init: RequestInit) => Promise<Response>

/** chamber patch: generic RPC carrier construction options. */
export interface WebConnectionRpcOptions {
  /** Per-instance api base path: `/api` (stock, no prefix) or `/api/i/<id>`. */
  basePath?: string
  /** Upstream rc.2 transport override; defaults to the page's global fetch. */
  doFetch?: RpcFetch
}

/**
 * Create the browser-backed generic RPC caller.
 * @param options - chamber patch: optional per-instance base path override, or
 *   upstream rc.2 transport override function.
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createWebConnectionRpc(options: WebConnectionRpcOptions | RpcFetch = {}): ClientConnectionRpc {
  const opts = typeof options === 'function' ? { doFetch: options } : options
  /** chamber patch: resolved prefix injected before the channel path ('' = stock). */
  const basePath = resolveInstanceBasePath(opts.basePath)
  const send: RpcFetch = opts.doFetch ?? ((input, init) => globalThis.fetch(input, init))
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(randomUuid())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }
      const response = await send(
        new URL(`${basePath}${channel}/${endpoint}`, resolveBase()),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          ...signal === undefined ? {} : { signal },
        },
      )
      if (!response.ok) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      const full = serverResponseSchema.parse(await response.json())
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }
}

function resolveBase(): string {
  const location = (globalThis as { location?: { origin?: string } }).location
  return location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel)
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
