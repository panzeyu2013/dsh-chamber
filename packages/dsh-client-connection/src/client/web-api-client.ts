/**
 * Browser API carrier: HTTP upstream plus one WebSocket per downstream event stream.
 *
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
 *
 * The only dsh source modification next to rpc.ts / api-path.ts / connection.ts:
 * the carrier learns a per-instance base path so every HTTP and WebSocket api
 * path lands under the control-plane's same-origin per-instance proxy prefix
 * (`/api/i/<id>`), which strips the prefix and forwards the remainder to the
 * instance (design 03 §3.1: `/api/i/<id>/api/...` → instance `/api/...`).
 * The stock value `/api` means no prefix injection (unchanged behaviour); the
 * per-instance value is resolved at construction from
 * `window.__DSH_BASE_PATH__` (set by the chamber shell before each sequential
 * instance boot) or from an explicit `basePath` option.
 *
 * Unary/respond/SSE all flow through `doFetch`, so prefixing there covers
 * `callUnary` (whose path is built in the unmodifiable apiproxy base class)
 * without re-implementing its envelope/value validation.
 */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH, resolveInstanceBasePath } from '../api-path.ts'

/** chamber patch: carrier construction options (base path parameterization). */
export interface WebApiClientOptions {
  /** Per-instance api base path: `/api` (stock, no prefix) or `/api/i/<id>`. */
  basePath?: string
}

type SocketItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
type Parser<F> = { parse(value: unknown): F }

/** Browser platform subclass: unary/respond use fetch; mux/host use downlink-only WebSockets. */
export class WebApiClient extends AbstractApiClient {
  /** chamber patch: resolved prefix injected before every api path ('' = stock). */
  private readonly basePath: string

  constructor(options: WebApiClientOptions = {}) {
    super()
    this.basePath = resolveInstanceBasePath(options.basePath)
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(this.withInstanceBase(input), init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket(MUX_EVENTS_PATH, signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen)
  }

  /** chamber patch: inject the instance base path in front of the api pathname. */
  private withInstanceBase(input: URL): URL {
    if (this.basePath === '') return input
    const url = new URL(input)
    url.pathname = `${this.basePath}${url.pathname}`
    return url
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = this.withInstanceBase(new URL(path, this.resolveBase()))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (event: MessageEvent): void => {
      let full: ServerRequest
      let frame: F
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
        full = serverRequestSchema.parse(JSON.parse(event.data))
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed WebSocket frame on ${path}:`, error)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      handleAbort()
    }
  }
}
