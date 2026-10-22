/** Browser caller for generic Connection unary RPC channels.
 *
 * chamber patch: `createWebConnectionRpc` takes a per-instance `basePath` option
 * (`/api/i/<id>`, never a page global) that leads the route; the stock base keeps
 * upstream's document-relative `api/<endpoint>` form. */

import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from '../rpc.ts'
import type { ClientConnectionRpc, ConnectionRpcResult } from '../rpc.ts'
import { resolveInstanceBasePath } from '../api-path.ts'
import { randomUuid } from './random-uuid.ts'

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Transport this caller posts through; same signature as the global `fetch`.
 * Receives the document-relative route so a carrier resolves it against its own base.
 */
export type RpcFetch = (input: string | URL, init: RequestInit) => Promise<Response>

/** Worker-local opener for decoded Gateway Remote streams; `uplink` carries the Client's items for the stream. */
export type RpcStreamOpen = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  uplink?: AsyncIterable<unknown>,
) => AsyncIterable<unknown>

export interface WebConnectionRpcOptions {
  /** Per-instance api base path: `/api` (stock, no prefix) or `/api/i/<id>`. */
  basePath?: string
  /** Upstream transport override; defaults to the page's global fetch. */
  doFetch?: RpcFetch
  /** Upstream worker-local Gateway stream carrier. */
  openStream?: RpcStreamOpen
}

/** The proxy's after-body marker, read with a hard byte cap WHILE streaming (a
 *  hostile/oversized error body is cancelled, never buffered). */
async function hasAfterBodyMarker(response: Response): Promise<boolean> {
  const body = response.body
  if (body === null) return false
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > 4096) {
        void reader.cancel().catch(() => {})
        return false
      }
      chunks.push(value)
    }
  } catch {
    return false
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { details?: { phase?: unknown } } | null
    return parsed?.details?.phase === 'after-body'
  } catch {
    return false
  }
}

/** Create the browser-backed generic RPC caller: per-instance base path plus
 *  the upstream transport overrides. Owns request correlation and envelope validation. */
export function createWebConnectionRpc(options: WebConnectionRpcOptions = {}): ClientConnectionRpc {
  /** chamber patch: resolved prefix injected before the channel path ('' = stock). */
  const basePath = resolveInstanceBasePath(options.basePath)
  const send: RpcFetch = options.doFetch ?? ((input, init) => globalThis.fetch(input, init))
  const openStream = options.openStream
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
      // The channel key is absolute; a page posts the document-relative form, and
      // a carrier that resolves against the Host root accepts the same form.
      // chamber patch: an explicit per-instance prefix leads the route as an
      // origin-absolute path; the stock base keeps upstream's relative form.
      const route = basePath === ''
        ? `${channel}/${endpoint}`.slice(1)
        : `${basePath}${channel}/${endpoint}`
      const response = await send(
        route,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          ...signal === undefined ? {} : { signal },
        },
      )
      if (!response.ok) {
        // chamber patch (design 27 §3.5): the control-plane proxy marks a 502/504
        // whose request body already reached the host with `details.phase='after-body'`.
        // An unary RPC has no safe automatic retry, so the error must say the call may
        // have applied instead of a bare status the UI would invite the user to retry.
        // Bounded (4096-byte cap while READING, not after) and fail-soft: anything
        // unexpected keeps the plain transport error.
        let lostAfterBody = false
        if (response.status === 502 || response.status === 504) {
          const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
          if (mediaType === 'application/json') {
            lostAfterBody = await hasAfterBodyMarker(response)
          }
        }
        // The error-body read may have raced the caller's abort: an aborted call must
        // surface as an abort, never as a transport failure it did not observe.
        signal?.throwIfAborted()
        throw new Error(lostAfterBody
          ? `the host did not answer ${channel}/${endpoint} after the request was sent; the call may have applied — refresh before retrying`
          : `transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      const full = mediaType === 'multipart/form-data'
        ? await parseBinaryResponse(response)
        : parseConnectionResponse(await response.json())
      signal?.throwIfAborted()
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
    ...openStream === undefined ? {} : {
      open(channel, endpoint, payload, signal, uplink) {
        assertTarget(channel, endpoint)
        if (channel !== '/api') {
          throw new Error(`connection: worker-local streams require the /api channel, got ${JSON.stringify(channel)}`)
        }
        return openStream(endpoint, payload, signal, uplink)
      },
    },
  }
}

async function parseBinaryResponse(response: Response): Promise<ReturnType<typeof parseConnectionResponse>> {
  const body = await response.formData()
  const fields = new Map<string, string | Blob>()
  for (const [name, value] of body) {
    if (fields.has(name)) throw new TypeError('connection: invalid binary response fields')
    fields.set(name, value)
  }
  const metadata = fields.get('metadata')
  fields.delete('metadata')
  if (typeof metadata !== 'string') {
    throw new TypeError('connection: invalid binary response fields')
  }
  const envelope: unknown = JSON.parse(metadata)
  const full = parseConnectionResponse(envelope)
  if (!full.result.ok || !isRecord(envelope) || !Array.isArray(envelope.attachments) || envelope.attachments.length === 0) {
    throw new TypeError('connection: invalid binary response result')
  }
  const root = { value: full.result.value }
  for (const attachment of envelope.attachments) {
    if (!isRecord(attachment) || attachment.codec !== 'bytes' || typeof attachment.part !== 'string'
      || !Array.isArray(attachment.path)) {
      throw new TypeError('connection: invalid binary response attachment')
    }
    const data = fields.get(attachment.part)
    fields.delete(attachment.part)
    if (!(data instanceof Blob)) {
      throw new TypeError('connection: invalid binary response fields')
    }
    let parent: object = root
    let key: string | number = 'value'
    for (const segment of attachment.path) {
      const value: unknown = Reflect.get(parent, key)
      if (typeof value !== 'object' || value === null) {
        throw new TypeError('connection: invalid binary response path')
      }
      if (Array.isArray(value)) {
        if (typeof segment !== 'number' || !Number.isSafeInteger(segment) || segment < 0 || segment >= value.length) {
          throw new TypeError('connection: invalid binary response path')
        }
      } else if (typeof segment !== 'string') {
        throw new TypeError('connection: invalid binary response path')
      }
      if (!Object.hasOwn(value, segment)) throw new TypeError('connection: invalid binary response path')
      parent = value
      key = segment
    }
    if (Reflect.get(parent, key) !== null) throw new TypeError('connection: invalid binary response placeholder')
    Object.defineProperty(parent, key, {
      value: new Uint8Array(await data.arrayBuffer()), enumerable: true, writable: true, configurable: true,
    })
  }
  if (fields.size !== 0) throw new TypeError('connection: invalid binary response fields')
  return {
    rpcId: full.rpcId,
    result: { ok: true, value: root.value },
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

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel)
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
