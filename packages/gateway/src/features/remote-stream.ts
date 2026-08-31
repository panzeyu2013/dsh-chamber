/**
 * Gateway-side Remote-stream mux client for the 0.1.2 wire.
 *
 * The dsh 0.1.2 host serves all live faces (forwarded `$events`, session
 * control, session follow, workspace follow) over ONE WebSocket at
 * `/api/remote.mux` (upstream `packages/api/gateway/src/stream-protocol.ts` +
 * `stream-server.ts`): the client opens the socket, sends an `open` frame
 * `{type:'open',streamId,endpoint,payload}`, and receives `item` frames whose
 * `value` is one endpoint-specific frame; `error`/`end` frames terminate the
 * logical stream.
 *
 * The protocol constants and message shapes below mirror the upstream
 * stream-protocol.ts (local copy for the same reason the sidebar copies
 * vendor helpers: the vendor tree is source-only and its files do not compile
 * under chamber tsconfigs; see docs/tmp-dsh-v012-migration-plan.md D5).
 * Browser WebSocket is replaced by the `ws` package (server context).
 */

import { randomUUID } from 'node:crypto'
import { authCookieFor } from '@dsh-chamber/control-plane'

/** WebSocket pathname of the multiplexed Remote stream carrier. */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'

/** Gateway-internal logical stream carrying application-selected Cordis events. */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'

/** Client response RPC for one scoped Remote Event delivery. */
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

/** Empty standard Remote payload used to open the forwarded-event stream. */
export const REMOTE_EVENT_STREAM_PAYLOAD = { args: {} } as const

/** One logical stream frame sent from the Host. */
export type RemoteStreamServerMessage =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'error'; readonly streamId: string; readonly error: { readonly code: string; readonly message: string; readonly details: object } }
  | { readonly type: 'end'; readonly streamId: string }

/** Opening item that binds later HTTP results to this active event stream. */
export interface RemoteEventReadyFrame {
  readonly type: 'ready'
  readonly clientId: string
  readonly host: { readonly home: string }
}

/** One Host notification delivered to a Client generation. */
export interface RemoteEventEmitFrame {
  readonly type: 'emit'
  readonly event: string
  readonly args: readonly unknown[]
}

/** One pending Agent-scoped waterfall delivered to a Client generation. */
export interface RemoteEventInvocationFrame {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: string
  readonly agentId: string
  readonly request: Readonly<Record<string, unknown>>
}

/** Cancellation of a pending waterfall previously delivered under the same id. */
export interface RemoteEventCancellationFrame {
  readonly type: 'cancel'
  readonly eventId: string
}

/** Every item carried by the forwarded-event stream. */
export type RemoteEventDownlinkFrame =
  | RemoteEventReadyFrame
  | RemoteEventEmitFrame
  | RemoteEventInvocationFrame
  | RemoteEventCancellationFrame

/** Client response to one scoped Remote Event delivery. */
export interface RemoteEventResult {
  readonly clientId: string
  readonly eventId: string
  readonly outcome:
    | { readonly kind: 'next' }
    | { readonly kind: 'result'; readonly value?: unknown }
    | { readonly kind: 'rejected'; readonly error: { readonly name: string; readonly message: string; readonly code?: string; readonly details?: unknown } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse and validate one Host-to-browser text message (mirror of upstream). */
export function parseRemoteStreamServerMessage(text: string): RemoteStreamServerMessage {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('api gateway: invalid Remote stream server message (bad JSON)')
  }
  if (!isRecord(value)) throw new Error('api gateway: invalid Remote stream server message')
  if (value.type === 'item' && typeof value.streamId === 'string'
    && value.value !== undefined) {
    // Any JSON value is a legal item value (scalars included — the upstream
    // contract is JsonValue; rejecting a scalar would kill the socket on a
    // single primitive frame, review-round6b P2-3).
    return { type: 'item', streamId: value.streamId, value: value.value }
  }
  if (value.type === 'item' && typeof value.streamId === 'string') {
    // An item WITHOUT a value key is legal too (review-round7b P2-3).
    return { type: 'item', streamId: value.streamId }
  }
  if (value.type === 'end' && typeof value.streamId === 'string') {
    return { type: 'end', streamId: value.streamId }
  }
  if (value.type === 'error' && typeof value.streamId === 'string' && isRecord(value.error)
    && typeof value.error.code === 'string' && typeof value.error.message === 'string') {
    return {
      type: 'error',
      streamId: value.streamId,
      error: { code: String(value.error.code), message: String(value.error.message), details: value.error.details ?? {} },
    }
  }
  throw new Error('api gateway: invalid Remote stream server message')
}

/**
 * Open one logical Remote stream over the mux carrier and yield its item
 * values. The connection is owned by the returned iterable: it opens the
 * socket, sends the `open` frame, and closes the socket when the iterable is
 * returned/aborted or the host sends `error`/`end`.
 */
export async function *openRemoteStream(
  baseUrl: string,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const { default: WebSocket } = await import('ws')
  // Hoisted above the socket construction — the ws maxPayload uses it.
  const MAX_BUFFERED_STREAM_BYTES = 8 * 1024 * 1024
  const streamId = randomStreamId()
  const url = new URL(REMOTE_STREAM_MUX_PATH, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  // 0.1.2 browser-auth (review-round4 P1): the mux gate requires the signed
  // cookie the spawn-time token exchange minted — without it every stream
  // upgrade 401s and $events/session-control silently die. Node's ws accepts
  // handshake headers; the browser-side api-gateway fork never opens this
  // path (its WS rides the control-plane proxy, which injects the cookie).
  const authCookie = authCookieFor(baseUrl)
  // maxPayload mirrors the control-plane carrier's frame cap (review-round9b
  // P2-2): a misbehaving host must not be able to balloon ws's receive
  // buffer beyond the bounded queue accounting.
  const socket = authCookie === undefined
    ? new WebSocket(url.href, { maxPayload: MAX_BUFFERED_STREAM_BYTES })
    : new WebSocket(url.href, { headers: { cookie: authCookie }, maxPayload: MAX_BUFFERED_STREAM_BYTES })
  const abort = () => { try { socket.close() } catch { /* already closed */ } }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload })); cleanup(); resolve() }
      const onError = (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))) }
      const onClose = () => { cleanup(); reject(new Error('remote stream socket closed before open')) }
      const cleanup = () => {
        socket.off('open', onOpen)
        socket.off('error', onError)
        socket.off('close', onClose)
      }
      socket.on('open', onOpen)
      socket.on('error', onError)
      socket.on('close', onClose)
    })
    const frames: Array<{ frame: RemoteStreamServerMessage; size: number }> = []
    const MAX_BUFFERED_STREAM_FRAMES = 256
    // UTF-8 byte budget (review-round9c P2-2): text.length is UTF-16 units
    // and would under-count CJK payloads by up to ~3x. Declared above with
    // the socket (the ws maxPayload shares it).
    let bufferedStreamBytes = 0
    let waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
    let socketError: Error | null = null
    let socketClosed = false
    const settle = () => {
      for (const waiter of waiters.splice(0)) waiter.resolve()
    }
    socket.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      let message: RemoteStreamServerMessage
      try {
        message = parseRemoteStreamServerMessage(text)
      } catch (error) {
        socketError = error instanceof Error ? error : new Error(String(error))
        settle()
        return
      }
      if (message.type === 'item') {
        bufferedStreamBytes += Buffer.byteLength(text, 'utf8')
        if (frames.length >= MAX_BUFFERED_STREAM_FRAMES || bufferedStreamBytes > MAX_BUFFERED_STREAM_BYTES) {
          socketError = new Error(`remote stream ${endpoint}: consumer overrun (${MAX_BUFFERED_STREAM_FRAMES} frames / ${MAX_BUFFERED_STREAM_BYTES} bytes)`)
          settle()
          return
        }
        frames.push({ frame: message, size: Buffer.byteLength(text, 'utf8') })
      } else if (message.type === 'error') {
        socketError = new Error(`remote stream ${endpoint} error: ${message.error.code}: ${message.error.message}`)
        settle()
      } else {
        socketClosed = true
        settle()
      }
    })
    socket.on('error', (error: unknown) => {
      socketError = error instanceof Error ? error : new Error(String(error))
      settle()
    })
    socket.on('close', () => {
      socketClosed = true
      settle()
    })
    while (true) {
      while (frames.length > 0) {
        const entry = frames.shift() as { frame: RemoteStreamServerMessage; size: number }
        bufferedStreamBytes = Math.max(0, bufferedStreamBytes - entry.size)
        const frame = entry.frame as { type: 'item'; streamId: string; value?: unknown }
        yield frame.value
      }
      if (socketError !== null) throw socketError
      if (socketClosed) return
      await new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject })
      })
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    try { socket.close() } catch { /* already closed */ }
  }
}

function randomStreamId(): string {
  return randomUUID()
}
