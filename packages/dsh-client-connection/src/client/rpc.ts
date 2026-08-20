/** Browser caller for generic Connection unary RPC channels.
 *
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
 *
 * The only dsh source modification next to web-api-client.ts / api-path.ts /
 * connection.ts: the URL is built as `<instanceBase><channel>/<endpoint>` so
 * every generic RPC call lands under the control-plane's per-instance proxy
 * prefix. The origin resolution stays same-origin (`location.origin`, with the
 * `dsh.internal` fallback for no-location environments). With the stock base
 * path `/api` the URL is byte-identical to upstream. The base path is resolved
 * at construction from `window.__DSH_BASE_PATH__` (chamber sets it before each
 * sequential instance boot) or from an explicit option.
 */

import {
  RpcId,
  serverResponseSchema,
  type ClientRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientConnectionRpc } from '../rpc.ts'
import { resolveInstanceBasePath } from '../api-path.ts'
import { randomUuid } from './random-uuid.ts'
import { applyCommandsExecuteCompat, COMMANDS_EXECUTE_ENDPOINT } from './rc8-commands-compat.ts'

const INTERNAL_BASE = 'http://dsh.internal'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** chamber patch: generic RPC carrier construction options. */
export interface WebConnectionRpcOptions {
  /** Per-instance api base path: `/api` (stock, no prefix) or `/api/i/<id>`. */
  basePath?: string
  /**
   * chamber patch (rc.8 wire compat bridge, rc8-commands-compat.ts): the
   * AUTHORITATIVE host version getter, read per call. The connection
   * publishes it from the `host.describe` handshake; undefined while not
   * connected (the compat then stays inert).
   */
  hostVersion?: () => string | undefined
}

/**
 * Create the browser-backed generic RPC caller.
 * @param options - chamber patch: optional per-instance base path override
 *   and host-version getter (rc.8 commands wire compat).
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createWebConnectionRpc(options: WebConnectionRpcOptions = {}): ClientConnectionRpc {
  /** chamber patch: resolved prefix injected before the channel path ('' = stock). */
  const basePath = resolveInstanceBasePath(options.basePath)
  const hostVersion = options.hostVersion
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      // chamber patch (rc.8 wire compat bridge): the rc.8 host `commands.execute`
      // requires the `images` argument this rc.7-shaped shell omits — inject it
      // for rc.8+ hosts only, keyed on the authoritative host version (an extra
      // field would be rejected by rc.7-era hosts, so the shim never fires there).
      const body = endpoint === COMMANDS_EXECUTE_ENDPOINT
        ? applyCommandsExecuteCompat(payload, hostVersion?.())
        : payload
      const rpcId = RpcId(randomUuid())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload: body,
      }
      const response = await globalThis.fetch(
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
