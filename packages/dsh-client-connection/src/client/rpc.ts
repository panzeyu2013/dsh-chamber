/** Browser caller for generic Connection unary RPC channels.
 *
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
 *
 * The only dsh source modification next to api-path.ts / connection.ts /
 * client/index.ts: the URL is built as `<instanceBase><channel>/<endpoint>` so
 * every generic RPC call lands under the control-plane's per-instance proxy
 * prefix. The origin resolution stays same-origin (`location.origin`, with the
 * `dsh.internal` fallback for no-location environments). With the stock base
 * path `/api` the URL is byte-identical to upstream. Chamber supplies the
 * explicit option from each entry's private Context; `window.__DSH_BASE_PATH__`
 * remains only as a compatibility fallback for other embedders.
 *
 * merged with the upstream v0.1.2 rewrite: `createWebConnectionRpc(doFetch?,
 * openStream?)` carries the worker-local Gateway stream opener as a second
 * parameter. The chamber options-overload (`WebConnectionRpcOptions | RpcFetch`)
 * is retained as a thin compatibility layer — an options object carrying
 * `basePath`/`doFetch`/`openStream`, or a bare `RpcFetch` function — and the
 * positional upstream form is accepted alongside it.
 */

import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from '../rpc.ts'
import type { ClientConnectionRpc, ConnectionRpcResult } from '../rpc.ts'
import { resolveInstanceBasePath } from '../api-path.ts'
import { randomUuid } from './random-uuid.ts'

const INTERNAL_BASE = 'http://dsh.internal'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** Transport this caller posts through; same signature as the global `fetch`. */
export type RpcFetch = (input: URL, init: RequestInit) => Promise<Response>

/** Worker-local opener for decoded Gateway Remote streams. */
export type RpcStreamOpen = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => AsyncIterable<unknown>

/** chamber patch: generic RPC carrier construction options. */
export interface WebConnectionRpcOptions {
  /** Per-instance api base path: `/api` (stock, no prefix) or `/api/i/<id>`. */
  basePath?: string
  /** Upstream transport override; defaults to the page's global fetch. */
  doFetch?: RpcFetch
  /** Upstream worker-local Gateway stream carrier. */
  openStream?: RpcStreamOpen
}

/**
 * Create the browser-backed generic RPC caller.
 * @param options - chamber patch: optional per-instance base path override (or
 *   upstream transport override function); a bare `RpcFetch` is treated as
 *   `{ doFetch }` for backward compatibility.
 * @param openStream - upstream worker-local Gateway stream carrier (positional
 *   form, passed through verbatim).
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createWebConnectionRpc(
  options: WebConnectionRpcOptions | RpcFetch = {},
  openStream?: RpcStreamOpen,
): ClientConnectionRpc {
  const opts = typeof options === 'function' ? { doFetch: options } : options
  /** chamber patch: resolved prefix injected before the channel path ('' = stock). */
  const basePath = resolveInstanceBasePath(opts.basePath)
  const send: RpcFetch = opts.doFetch ?? ((input, init) => globalThis.fetch(input, init))
  const stream = openStream ?? opts.openStream
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
      const full = parseConnectionResponse(await response.json())
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
    ...stream === undefined ? {} : {
      open(channel, endpoint, payload, signal) {
        assertTarget(channel, endpoint)
        if (channel !== '/api') {
          throw new Error(`connection: worker-local streams require the /api channel, got ${JSON.stringify(channel)}`)
        }
        return stream(endpoint, payload, signal)
      },
    },
  }
}

function parseConnectionResponse(value: unknown): {
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
} {
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string') {
    throw new TypeError('connection: invalid server-response envelope')
  }
  const result = value.result
  if (!isRecord(result)) throw new TypeError('connection: invalid server-response result')
  if (result.ok === true) {
    return {
      rpcId: RpcId(value.rpcId),
      result: { ok: true, value: result.value },
    }
  }
  if (result.ok !== false || !isRecord(result.error)) {
    throw new TypeError('connection: invalid server-response result')
  }
  const error = result.error
  if (typeof error.code !== 'string' || typeof error.message !== 'string' || !isRecord(error.details)) {
    throw new TypeError('connection: invalid server-response failure')
  }
  return {
    rpcId: RpcId(value.rpcId),
    result: {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    },
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
