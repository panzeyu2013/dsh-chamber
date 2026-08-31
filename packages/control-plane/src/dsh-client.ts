/**
 * dsh wire protocol layer. The desktop control-plane uses only the unary
 * client and generation-scoped capability cache. The separately invoked
 * authenticated gateway consumes the 0.1.2 remote-stream mux carrier
 * (packages/gateway/src/features/remote-stream.ts) — the legacy
 * respond/openEventStream exports below are deprecated and have no
 * production callers (dsh-v0.1.2-alpha.1 deleted the client-response and
 * events.mux wires).
 *
 * Invariants:
 * - rpcId is minted by the initiator (this client) on every unary call and
 *   echoes back in the server-response; a mismatch is a protocol violation.
 * - unary: POST /api/<method>, body {type:'client-request', rpcId, method,
 *   payload}, content-type application/json. Business errors ride the 200
 *   body's result.error branch; non-2xx HTTP statuses express only carrier
 *   failures.
 * - respond: POST /api/respond, body {type:'client-response', rpcId, result};
 *   the response body is an RpcReceipt, idempotent (not-pending on late/duplicate).
 * - downstream: /api/remote.mux is the Typert Remote stream WebSocket (the
 *   old /api/events.mux and /api/events.host downlinks were deleted upstream
 *   in dsh 0.1.2-alpha.1); ordinary GET receives 426 and there is no network
 *   SSE fallback.
 * - every unary/respond call carries a 30s timeout (DEFAULT_TIMEOUT_MS) merged
 *   with the caller's AbortSignal and the connection generation's signal
 *   (generationSignal); `timeoutMs: null` opts out of the timer entirely
 *   (caller-signal-only policy).
 * - every client-request converges on the rpcId pending table (settle-once):
 *   the `settled` flag + first-writer-wins make response arrival vs timeout
 *   vs caller abort settle each entry exactly once.
 * - capability snapshots (the session/list probe) are generation-scoped: the
 *   cache entry dies with its generation's signal; invalidation emits no
 *   events.
 */

// The wire envelope is single-sourced in rpc-envelope.ts (A2 cross-package
// protocol single-sourcing): envelope construction and server-response
// validation are shared with the desktop probes (ssh-provider.ts) — only the
// fetch-carrier orchestration (pending table / settle-once / signal
// composition) stays here.
import { buildClientRequest, mintRpcId, parseServerResponse } from './rpc-envelope.ts'
import { authCookieFor } from './browser-auth-cookie.ts'
import type { RawData } from 'ws'

export { mintRpcId } from './rpc-envelope.ts'

/**
 * The narrow unary response form: the server-response envelope's {rpcId,
 * result} pair. `result.ok` selects the value/error branch; business
 * failures additionally surface as RpcBusinessError throws.
 */
export interface UnaryResponse {
  rpcId: string
  result: {
    ok: boolean
    value?: unknown
    error?: { code: string; message: string; details?: unknown }
  }
}

/** Options for one unary call. */
export interface UnaryOptions {
  /** Caller cancellation signal. */
  signal?: AbortSignal
  /** Override the default 30s policy; null = caller-signal-only (no timer). */
  timeoutMs?: number | null
  /** The connection generation's AbortSignal — its death settles with connection_offline. */
  generationSignal?: AbortSignal
}

/** Options for one respond call. */
export interface RespondOptions {
  signal?: AbortSignal
  timeoutMs?: number | null
  generationSignal?: AbortSignal
}

/** The idempotent receipt returned by /api/respond. */
export interface RpcReceipt {
  accepted: boolean
  reason?: string
}

/** The client-response full form posted to /api/respond. */
export interface ClientResponse {
  rpcId?: string
  result: unknown
}

/** A server-request frame from the /api/remote.mux stream. */
export interface ServerRequest {
  type: 'server-request'
  rpcId: string
  method: string
  payload: Record<string, unknown>
}

/** Default unary transport health deadline (matches the ref client's 30_000). */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Maximum accepted JSON envelope for one unary host response. */
export const MAX_UNARY_RESPONSE_BYTES = 1024 * 1024

class BoundedResponseError extends Error {
  readonly kind: 'too-large' | 'invalid-json'

  constructor(kind: 'too-large' | 'invalid-json') {
    super(kind)
    this.kind = kind
  }
}

/** Read one fetch response without allowing a damaged host to grow memory
 * without bound. Content-Length is only a fast rejection; the streamed byte
 * count remains authoritative when the header is absent or dishonest. */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared)
    && Number(declared) > MAX_UNARY_RESPONSE_BYTES) {
    try { await response.body?.cancel() } catch { /* best-effort carrier cleanup */ }
    throw new BoundedResponseError('too-large')
  }
  if (response.body === null) throw new BoundedResponseError('invalid-json')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_UNARY_RESPONSE_BYTES) {
        try { await reader.cancel() } catch { /* best-effort carrier cleanup */ }
        throw new BoundedResponseError('too-large')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof BoundedResponseError) throw error
    throw new BoundedResponseError('invalid-json')
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new BoundedResponseError('invalid-json')
  }
}

/** One pending-table entry (settle-once row for a unary call). */
interface PendingEntry {
  rpcId: string
  method: string
  controller: AbortController
  timeoutMs: number | null
  settled: boolean
  createdAt: number
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  _cleanup?: () => void
}

/**
 * rpcId → PendingCall table, settle-once only (it serves exactly `call`).
 * Node's single thread makes every access serial (each settle runs inside
 * one microtask/event handler); the only race guard needed is the `settled`
 * flag — the first settle path wins and cleans up the remaining listeners,
 * later paths are no-ops.
 */
const pendingTable = {
  table: new Map<string, PendingEntry>(),
  settled: 0,

  register(entry: PendingEntry) {
    this.table.set(entry.rpcId, entry)
  },

  /** Settle exactly once. Returns false when already settled / unknown. */
  settle(rpcId: string, outcome: unknown) {
    const entry = this.table.get(rpcId)
    if (entry === undefined || entry.settled) return false
    entry.settled = true
    entry._cleanup?.()
    this.table.delete(rpcId)
    this.settled += 1
    if (outcome instanceof Error) entry.reject(outcome)
    else entry.resolve(outcome)
    return true
  },

  size() {
    return this.table.size
  },
}

/** Diagnostic counters for the pending table (settle-once observable in tests). */
export function pendingStats() {
  return { size: pendingTable.size(), settled: pendingTable.settled }
}

/** A business-level RPC failure: the result.error branch of a server-response. */
export class RpcBusinessError extends Error {
  code: string
  details: Record<string, unknown>

  constructor(error: unknown) {
    const branch: Record<string, any> =
      typeof error === 'object' && error !== null ? (error as Record<string, any>) : {}
    super(`dsh rpc error ${branch.code ?? 'unknown'}: ${branch.message ?? ''}`)
    this.name = 'RpcBusinessError'
    this.code = branch.code ?? 'unknown'
    this.message = branch.message ?? ''
    this.details = branch.details ?? {}
  }
}

/**
 * A carrier-level failure. `code` is the control plane's own transport error
 * namespace (never a dsh RpcErrorCode):
 *   connection_offline / request_timeout / aborted / protocol_violation /
 *   response_too_large / stream_frame_too_large / stream_queue_overflow /
 *   transport_http_<status> / transport_error
 */
export class RpcTransportError extends Error {
  code: string
  status: number
  /** Partial byte count attached by download helpers (diagnostics only). */
  bytes?: number

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'RpcTransportError'
    this.status = status
    this.code = code ?? (status > 0 ? `transport_http_${status}` : 'transport_error')
  }
}

/** Hard production ceilings for one raw downstream WebSocket stream. */
const EVENT_STREAM_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
const EVENT_STREAM_MAX_QUEUE_BYTES = 16 * 1024 * 1024
const EVENT_STREAM_MAX_QUEUE_FRAMES = 256

/**
 * Optional limits seam for focused socket regressions. Overrides can only
 * tighten the production ceilings; callers cannot use this surface to widen
 * the amount of unfiltered WebSocket data retained by the process.
 */
export interface EventStreamLimits {
  maxPayloadBytes?: number
  maxQueueBytes?: number
  maxQueueFrames?: number
}

interface NormalizedEventStreamLimits {
  maxPayloadBytes: number
  maxQueueBytes: number
  maxQueueFrames: number
}

function normalizeEventStreamLimit(value: number | undefined, ceiling: number, name: string): number {
  if (value === undefined) return ceiling
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`openEventStream: ${name} must be a positive safe integer`)
  }
  return Math.min(value, ceiling)
}

function normalizeEventStreamLimits(limits: EventStreamLimits | undefined): NormalizedEventStreamLimits {
  return {
    maxPayloadBytes: normalizeEventStreamLimit(
      limits?.maxPayloadBytes,
      EVENT_STREAM_MAX_PAYLOAD_BYTES,
      'maxPayloadBytes',
    ),
    maxQueueBytes: normalizeEventStreamLimit(
      limits?.maxQueueBytes,
      EVENT_STREAM_MAX_QUEUE_BYTES,
      'maxQueueBytes',
    ),
    maxQueueFrames: normalizeEventStreamLimit(
      limits?.maxQueueFrames,
      EVENT_STREAM_MAX_QUEUE_FRAMES,
      'maxQueueFrames',
    ),
  }
}

function rawDataByteLength(data: RawData): number {
  if (!Array.isArray(data)) return data.byteLength
  let bytes = 0
  for (const chunk of data) bytes += chunk.byteLength
  return bytes
}

function isMaxPayloadError(error: Error): boolean {
  return (error as Error & { code?: string }).code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
    || /max payload size exceeded/i.test(error.message)
}

/** Normalize the per-call timeout policy: undefined → default, null → none. */
function normalizeTimeout(timeoutMs: number | null | undefined): number | null {
  return timeoutMs === null ? null : timeoutMs ?? DEFAULT_TIMEOUT_MS
}

/** Inputs to composeSignals (normalized timeout policy). */
interface ComposeSignalsInput {
  signal?: AbortSignal
  generationSignal?: AbortSignal
  timeoutMs: number | null
  controller: AbortController
}

/**
 * Combine the entry controller, the caller signal, the generation signal and
 * the timeout policy into the fetch AbortSignal, and report which component
 * fired first so the transport error code is accurate. The timeout is a
 * plain (ref'd) timer that aborts the entry controller — the loop stays
 * alive while a request is in flight and the timer is cleared on settle (no
 * leak).
 */
function composeSignals({ signal, generationSignal, timeoutMs, controller }: ComposeSignalsInput): {
  signal: AbortSignal
  fired: () => string | null
  cleanup: () => void
} {
  const components: AbortSignal[] = [controller.signal]
  const cleanups: Array<() => void> = []
  let fired: string | null = null
  const track = (candidate: AbortSignal | undefined, code: string) => {
    if (candidate === undefined) return
    components.push(candidate)
    if (candidate.aborted) {
      fired = fired ?? code
      return
    }
    const onAbort = () => {
      fired = fired ?? code
    }
    candidate.addEventListener('abort', onAbort, { once: true })
    cleanups.push(() => candidate.removeEventListener('abort', onAbort))
  }
  track(signal, 'aborted')
  track(generationSignal, 'connection_offline')
  let timeoutTimer: NodeJS.Timeout | null = null
  if (timeoutMs !== null) {
    timeoutTimer = setTimeout(() => {
      fired = fired ?? 'request_timeout'
      controller.abort()
    }, timeoutMs)
    cleanups.push(() => clearTimeout(timeoutTimer ?? undefined))
  }
  return {
    signal: components.length === 1 ? components[0] : AbortSignal.any(components),
    fired: () => fired,
    cleanup: () => {
      for (const cleanup of cleanups) cleanup()
    },
  }
}

/**
 * One unary call: register on the pending table, POST the client-request
 * envelope, validate the echo, and settle the entry.
 * @param baseUrl - origin of the dsh host, e.g. http://127.0.0.1:17510.
 * @param method - the wire path segment, e.g. 'session/list' (POST
 *   /api/<method>). dsh 0.1.2-alpha.1 requires slash-separated endpoints
 *   (the old dot paths 404).
 * @param payload - the business payload (schema-validated host-side).
 * @param options - {signal?} caller cancellation; {timeoutMs?} override the
 *   default 30s policy (null = caller-signal-only, no timer);
 *   {generationSignal?} the connection generation's AbortSignal — its death
 *   settles this call with connection_offline.
 * @returns {rpcId, result} — the narrow response form; throws RpcBusinessError
 *   when result.ok is false and RpcTransportError for carrier failures.
 */
export async function call(
  baseUrl: string,
  method: string,
  payload: unknown,
  { signal, timeoutMs, generationSignal }: UnaryOptions = {},
): Promise<UnaryResponse> {
  const rpcId = mintRpcId()
  const timeout = normalizeTimeout(timeoutMs)
  if (signal?.aborted) {
    throw new RpcTransportError(`dsh unary ${method}: caller cancelled`, 0, 'aborted')
  }
  if (generationSignal?.aborted) {
    throw new RpcTransportError(`dsh unary ${method}: connection is offline`, 0, 'connection_offline')
  }
  const controller = new AbortController()
  const composed = composeSignals({ signal, generationSignal, timeoutMs: timeout, controller })
  const entry: PendingEntry = {
    rpcId,
    method,
    controller,
    timeoutMs: timeout,
    settled: false,
    createdAt: Date.now(),
    resolve: () => {},
    reject: () => {},
    _cleanup: composed.cleanup,
  }
  pendingTable.register(entry)

  const fail = (message: string, status: number, code?: string) => {
    const transportError = new RpcTransportError(message, status, code)
    pendingTable.settle(rpcId, transportError)
    return transportError
  }

  let response: Response
  try {
    const authCookie = authCookieFor(baseUrl)
    response = await fetch(new URL(`/api/${method}`, baseUrl), {
      method: 'POST',
      headers: authCookie === undefined
        ? { 'content-type': 'application/json' }
        : { 'content-type': 'application/json', cookie: authCookie },
      // The client-request envelope is single-sourced in rpc-envelope.ts;
      // JSON.stringify preserves the canonical key order.
      body: JSON.stringify(buildClientRequest(rpcId, method, payload)),
      signal: composed.signal,
    })
  } catch (error) {
    throw fail(`dsh unary ${method} failed: ${String(error)}`, 0, composed.fired() ?? 'transport_error')
  }
  if (!response.ok) {
    throw fail(`dsh unary ${method}: HTTP ${response.status}`, response.status)
  }
  let envelope: any
  try {
    envelope = await readBoundedJson(response)
  } catch (error) {
    const cancellation = composed.fired()
    if (cancellation !== null) {
      throw fail(`dsh unary ${method}: request cancelled while reading response`, 0, cancellation)
    }
    if (error instanceof BoundedResponseError && error.kind === 'too-large') {
      throw fail(
        `dsh unary ${method}: response body exceeds ${MAX_UNARY_RESPONSE_BYTES} bytes`,
        response.status,
        'response_too_large',
      )
    }
    throw fail(`dsh unary ${method}: response body is not JSON: ${String(error)}`, response.status, 'protocol_violation')
  }
  // Fetch can finish buffering at the same edge as a caller/generation abort.
  // Cancellation owns the lifecycle: never accept or cache a response after
  // its connection generation has already died.
  const cancellation = composed.fired()
  if (cancellation !== null) {
    throw fail(`dsh unary ${method}: request cancelled before response settled`, 0, cancellation)
  }
  // The server-response validation is single-sourced in rpc-envelope.ts; the
  // unary client additionally requires result.ok to be a boolean (the desktop
  // probes treat `ok === true` differently and stay lenient).
  const parsed = parseServerResponse(envelope, rpcId)
  if (parsed.kind === 'no-envelope') {
    throw fail(`dsh unary ${method}: missing or mismatched server-response`, response.status, 'protocol_violation')
  }
  if (parsed.kind === 'malformed-result' || typeof parsed.envelope.result.ok !== 'boolean') {
    throw fail(`dsh unary ${method}: malformed result slot`, response.status, 'protocol_violation')
  }
  const result = parsed.envelope.result as UnaryResponse['result']
  if (result.ok) {
    pendingTable.settle(rpcId, { rpcId, result })
    return { rpcId, result }
  }
  const errorBranch = typeof result.error === 'object' && result.error !== null
    ? result.error
    : { code: 'unknown_rpc_code', message: 'malformed error branch', details: {} }
  // Business errors ride the resolve path; the surface-facing throw happens
  // only after the entry settled.
  pendingTable.settle(rpcId, { rpcId, result })
  throw new RpcBusinessError(errorBranch)
}

/**
 * Answer an answerable server-request (approval/question): POST /api/respond.
 * @deprecated 0.1.2 wire: `POST /api/respond` (client-response envelope) was deleted
 * upstream (dsh-v0.1.2-alpha.1) — the answerable surface is now the `$events/result`
 * Remote (see packages/gateway/src/features/remote-stream.ts). Kept only for
 * legacy callers; no production caller remains (review-round3d P2). It does
 * NOT inject the browser-auth cookie (review-round9c P2-3): a legacy caller
 * on the 0.1.2 wire would 401 — acceptable for a dead surface.
 * @param baseUrl - origin of the dsh host.
 * @param message - the ClientResponse full form; rpcId echoes the server-request, never minted.
 * @param options - {signal?} caller cancellation; {timeoutMs?} null = caller-signal-only;
 *   {generationSignal?} the connection generation's AbortSignal.
 * @returns the RpcReceipt ({accepted:true} | {accepted:false, reason}).
 */
export async function respond(
  baseUrl: string,
  message: ClientResponse,
  { signal, timeoutMs, generationSignal }: RespondOptions = {},
): Promise<RpcReceipt> {
  const rpcId = message?.rpcId
  if (typeof rpcId !== 'string' || rpcId.length === 0) {
    throw new RpcTransportError('dsh respond: missing rpcId', 0, 'protocol_violation')
  }
  const timeout = normalizeTimeout(timeoutMs)
  if (signal?.aborted) {
    throw new RpcTransportError('dsh respond: caller cancelled', 0, 'aborted')
  }
  if (generationSignal?.aborted) {
    throw new RpcTransportError('dsh respond: connection is offline', 0, 'connection_offline')
  }
  const controller = new AbortController()
  const composed = composeSignals({ signal, generationSignal, timeoutMs: timeout, controller })

  const fail = (messageText: string, status: number, code?: string) => {
    return new RpcTransportError(messageText, status, code)
  }

  try {
    let response: Response
    try {
      response = await fetch(new URL('/api/respond', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId, result: message.result }),
        signal: composed.signal,
      })
    } catch (error) {
      throw fail(`dsh respond failed: ${String(error)}`, 0, composed.fired() ?? 'transport_error')
    }
    if (!response.ok) {
      throw fail(`dsh respond: HTTP ${response.status}`, response.status)
    }
    let receipt: any
    try {
      receipt = await readBoundedJson(response)
    } catch (error) {
      const cancellation = composed.fired()
      if (cancellation !== null) {
        throw fail('dsh respond: request cancelled while reading response', 0, cancellation)
      }
      if (error instanceof BoundedResponseError && error.kind === 'too-large') {
        throw fail(`dsh respond: response body exceeds ${MAX_UNARY_RESPONSE_BYTES} bytes`, response.status, 'response_too_large')
      }
      throw fail(`dsh respond: response body is not JSON: ${String(error)}`, response.status, 'protocol_violation')
    }
    const cancellation = composed.fired()
    if (cancellation !== null) {
      throw fail('dsh respond: request cancelled before receipt settled', 0, cancellation)
    }
    if (receipt?.accepted !== true && !(receipt?.accepted === false && typeof receipt.reason === 'string')) {
      throw fail('dsh respond: malformed receipt', response.status, 'protocol_violation')
    }
    return receipt
  } finally {
    composed.cleanup()
  }
}

/**
 * Open one downstream stream and yield ServerRequest frames as they arrive.
 * The dsh HTTP bridge answers GET on the event paths with 426 (upgrade
 * required): the downlink is a **WebSocket** carrying one JSON ServerRequest
 * per text frame (client sends no application data). A frame that fails JSON
 * or envelope parsing is dropped without killing the stream (ref client
 * posture). The stream ends when the server closes it or the caller's signal
 * aborts.
 * @param baseUrl - origin of the dsh host (http://127.0.0.1:<port>).
 * @param path - '/api/remote.mux' (the Typert Remote stream mux; the old
 *   '/api/events.mux' / '/api/events.host' downlinks were deleted upstream
 *   in dsh 0.1.2-alpha.1).
 * @param signal - the stream's AbortSignal; aborts the socket and ends iteration.
 * @param onOpen - optional barrier callback fired only after the WebSocket
 *   upgrade has completed and message listeners are installed.
 * @param limits - optional test seam that may only tighten hard production
 *   limits for one raw frame and the pre-parse queue.
 * @returns an async generator of ServerRequest full forms.
 */
/** @deprecated 0.1.2 wire: the events.mux/events.host downlink WS was deleted
 * upstream (dsh-v0.1.2-alpha.1) — live faces ride the `/api/remote.mux` Remote
 * stream mux (open frame handshake; see packages/gateway/src/features/remote-stream.ts).
 * Kept only for legacy callers; no production caller remains (review-round3d P2). */
export async function *openEventStream(
  baseUrl: string,
  path: string,
  signal?: AbortSignal,
  onOpen?: () => void,
  limits?: EventStreamLimits,
): AsyncGenerator<ServerRequest> {
  const { default: WebSocket } = await import('ws')
  const boundedLimits = normalizeEventStreamLimits(limits)
  const wsUrl = baseUrl.replace(/^http/, 'ws') + path
  const socket = new WebSocket(wsUrl, { maxPayload: boundedLimits.maxPayloadBytes })
  let ended = false
  let aborted = signal?.aborted ?? false
  let openError: Error | null = null
  let terminalError: RpcTransportError | null = null
  const queue: Array<{ data: RawData; bytes: number }> = []
  let queuedBytes = 0
  let wake: (() => void) | null = null

  const pump = () => {
    if (wake !== null) {
      const resolve = wake
      wake = null
      resolve()
    }
  }

  const clearQueue = () => {
    queue.length = 0
    queuedBytes = 0
  }
  const terminateSocket = () => {
    try {
      // ws.terminate() is a no-op while CONNECTING; close() is the path that
      // actually aborts an in-flight handshake.
      if (socket.readyState === WebSocket.CONNECTING) socket.close()
      else if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
    } catch {
      try {
        socket.terminate()
      } catch { /* already closed */ }
    }
  }
  const failStream = (error: RpcTransportError, terminate = true) => {
    if (terminalError === null && !aborted) terminalError = error
    ended = true
    clearQueue()
    if (terminate) terminateSocket()
    pump()
  }
  const frameLimitError = () => new RpcTransportError(
    `dsh stream ${path}: WebSocket frame exceeds ${boundedLimits.maxPayloadBytes} bytes`,
    0,
    'stream_frame_too_large',
  )
  const handleMessage = (data: RawData) => {
    if (ended) return
    const bytes = rawDataByteLength(data)
    // This defensive check is intentionally before JSON/envelope filtering;
    // ws's maxPayload is the primary single-frame gate.
    if (bytes > boundedLimits.maxPayloadBytes) {
      failStream(frameLimitError())
      return
    }
    if (
      queue.length >= boundedLimits.maxQueueFrames
      || bytes > boundedLimits.maxQueueBytes - queuedBytes
    ) {
      failStream(new RpcTransportError(
        `dsh stream ${path}: raw queue exceeds ${boundedLimits.maxQueueFrames} frames or ${boundedLimits.maxQueueBytes} bytes`,
        0,
        'stream_queue_overflow',
      ))
      return
    }
    queue.push({ data, bytes })
    queuedBytes += bytes
    pump()
  }
  const handleClose = (code: number) => {
    if (code === 1009 && terminalError === null && !aborted) {
      failStream(frameLimitError(), false)
      return
    }
    ended = true
    pump()
  }
  const handleError = (error: Error) => {
    openError = error
    if (aborted) {
      ended = true
      pump()
      return
    }
    failStream(isMaxPayloadError(error)
      ? frameLimitError()
      : new RpcTransportError(`dsh stream ${path} failed: ${String(error)}`, 0))
  }
  socket.on('message', handleMessage)
  socket.on('close', handleClose)
  socket.on('error', handleError)

  const onAbort = () => {
    aborted = true
    ended = true
    clearQueue()
    terminateSocket()
    pump()
  }
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    try {
      await new Promise<void>((resolve, reject) => {
        const openedListener = () => {
          cleanup()
          resolve()
        }
        const errorListener = (error: Error) => {
          cleanup()
          reject(error)
        }
        const abortListener = () => {
          cleanup()
          reject(new Error('stream aborted before open'))
        }
        const closedListener = () => {
          cleanup()
          reject(openError ?? new Error('stream closed before open'))
        }
        const cleanup = () => {
          socket.off('open', openedListener)
          socket.off('error', errorListener)
          socket.off('close', closedListener)
          signal?.removeEventListener('abort', abortListener)
        }
        socket.once('open', openedListener)
        socket.once('error', errorListener)
        socket.once('close', closedListener)
        signal?.addEventListener('abort', abortListener, { once: true })
        if (ended) errorListener(openError ?? new Error('stream closed before open'))
      })
    } catch (error) {
      if (signal?.aborted) return
      throw terminalError ?? new RpcTransportError(`dsh stream ${path} failed: ${String(error)}`, 0)
    }
    if (signal?.aborted) return
    onOpen?.()
    while (true) {
      if (terminalError !== null) throw terminalError
      if (queue.length > 0) {
        const item = queue.shift()!
        queuedBytes -= item.bytes
        const raw = String(item.data)
        let frame: any
        try {
          frame = JSON.parse(raw)
        } catch {
          continue
        }
        if (frame?.type !== 'server-request' || typeof frame.method !== 'string') continue
        yield frame
        continue
      }
      if (ended) break
      await new Promise<void>(resolve => {
        wake = resolve
      })
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    clearQueue()
    terminateSocket()
    socket.off('message', handleMessage)
    socket.off('close', handleClose)
    socket.off('error', handleError)
    // A close/terminate error can be delivered on a later turn. Keep a
    // closure-free sink until the socket itself is collected.
    socket.on('error', () => {})
  }
}

/** One generation-scoped cache entry. */
interface CapabilityEntry {
  value: Record<string, unknown>
  cachedAt: number
  generationSignal?: AbortSignal
  _unlisten: (() => void) | null
}

/**
 * Generation-scoped session/list probe snapshot cache (the host.describe
 * capability endpoint was deleted upstream in dsh 0.1.2-alpha.1, so the
 * connection-generation probe is now the session/list unary). An entry is
 * valid only while the generation that fetched it is alive: its AbortSignal's
 * abort removes the entry, so a snapshot never outlives its generation (a
 * fresh generation always refetches). `force: true` bypasses the cache;
 * transport failures are never cached. Emits no events — the coordinator
 * wires onReady publication and generation invalidation upstream. Cache
 * entries are keyed by baseUrl (one client per host).
 */
const capabilityCache = new Map<string, CapabilityEntry>()

/** Options for describeCapabilities. */
export interface DescribeCapabilitiesOptions {
  generationSignal?: AbortSignal
  /** Bypass the cache and refetch. */
  force?: boolean
  timeoutMs?: number | null
}

/** The served session/list probe snapshot (treat the value as immutable). */
export interface CapabilitySnapshot {
  value: Record<string, unknown>
  cachedAt: number
}

/**
 * Fetch the session/list probe snapshot once per connection generation and
 * serve subsequent callers from the cache.
 * @param baseUrl - origin of the dsh host, e.g. http://127.0.0.1:17510.
 * @param options - {generationSignal?} the connection generation's
 *   AbortSignal: the cache hit is only valid for the same generation object,
 *   and its abort clears the entry; {force?} bypass the cache and refetch.
 * @returns {value, cachedAt} — the session/list value object (treat as
 *   immutable) and the fetch timestamp in ms.
 * @throws RpcBusinessError for the result.error branch; RpcTransportError
 *   (connection_offline when the generation is already dead, protocol_violation
 *   for a malformed value slot, plus the unary carrier errors).
 */
export async function describeCapabilities(
  baseUrl: string,
  { generationSignal, force = false, timeoutMs }: DescribeCapabilitiesOptions = {},
): Promise<CapabilitySnapshot> {
  if (generationSignal?.aborted) {
    const stale = capabilityCache.get(baseUrl)
    if (stale?.generationSignal === generationSignal) {
      stale._unlisten?.()
      capabilityCache.delete(baseUrl)
    }
    throw new RpcTransportError('dsh session/list: connection is offline', 0, 'connection_offline')
  }
  const cached = capabilityCache.get(baseUrl)
  if (!force && cached !== undefined && cached.generationSignal === generationSignal) {
    return { value: cached.value, cachedAt: cached.cachedAt }
  }
  const { result } = await call(baseUrl, 'session/list', { args: { _request: {} } }, { generationSignal, timeoutMs })
  const value = result.value
  if (typeof value !== 'object' || value === null) {
    throw new RpcTransportError('dsh session/list: malformed value slot', 0, 'protocol_violation')
  }
  cached?._unlisten?.()
  const entry: CapabilityEntry = {
    value: value as Record<string, unknown>,
    cachedAt: Date.now(),
    generationSignal,
    _unlisten: null,
  }
  if (generationSignal !== undefined) {
    const onAbort = () => {
      if (capabilityCache.get(baseUrl) === entry) capabilityCache.delete(baseUrl)
    }
    entry._unlisten = () => generationSignal.removeEventListener('abort', onAbort)
    generationSignal.addEventListener('abort', onAbort, { once: true })
  }
  capabilityCache.set(baseUrl, entry)
  return { value: entry.value, cachedAt: entry.cachedAt }
}
