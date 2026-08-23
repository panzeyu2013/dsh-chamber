/**
 * dsh wire protocol layer (four-quadrant RPC over the fetch carrier), mirroring
 * @deepseek-ai/dsh-host-apiproxy/src/fetch/client.ts + handler.ts.
 *
 * Invariants:
 * - rpcId is minted by the initiator (this client) on every unary call and echoes
 *   back in the server-response; a mismatch is a protocol violation.
 * - unary: POST /api/<method>, body {type:'client-request', rpcId, method, payload},
 *   content-type application/json. Business errors ride the 200 body's
 *   result.error branch; non-2xx HTTP statuses express only carrier failures.
 * - respond: POST /api/respond, body {type:'client-response', rpcId, result};
 *   the response body is an RpcReceipt, idempotent (not-pending on late/duplicate).
 * - downstream: /api/events.mux and /api/events.host are downlink-only
 *   WebSockets carrying one JSON ServerRequest full form per text message;
 *   ordinary GET receives 426 and there is no network SSE fallback.
 * - every client-request converges on the rpcId pending table (design 02 §3.3):
 *   the `settled` flag + first-writer-wins make response arrival vs timeout vs
 *   generation abort vs caller abort settle each entry exactly once.
 * - every unary/respond call carries a 30s timeout (DEFAULT_TIMEOUT_MS) merged
 *   with the caller's AbortSignal and the connection generation's signal
 *   (generationSignal); `timeoutMs: null` opts out of the timer entirely
 *   (caller-signal-only policy). On generation death the table settles in-flight
 *   calls with a connection_offline transport error (design 02 §3.4).
 * - capability snapshots (host.describe) are generation-scoped: the cache
 *   entry dies with its generation's signal; invalidation emits no events
 *   (design 02 §3.11 / D8).
 * - per-session pending soft cap (design 02 §3.3): unary calls whose payload
 *   addresses one session (payload.sessionId) count against that session;
 *   at the cap (default 64, configurable per call, null disables) the next
 *   call is rejected up front with PendingCapExceededError — a UI storm must
 *   never flood the host inbox.
 * - envelope observation (design 02 §3.3): pendingEnvelope(listener) is a
 *   microtask-batched snapshot subscription (ref AbstractApiClient
 *   subscribeEnvelopes semantics — a frame storm never costs one notification
 *   per frame; a listener throw is isolated, observation never breaks the
 *   carrier). Each flushed batch is the current pending list (state
 *   'pending') plus the entries settled since the previous flush (state
 *   'settled').
 */

import { randomUUID } from 'node:crypto'
import type { RawData } from 'ws'

/**
 * The narrow unary response form (design 02 §3.3): the server-response
 * envelope's {rpcId, result} pair. `result.ok` selects the value/error
 * branch; business failures additionally surface as RpcBusinessError throws.
 */
export interface UnaryResponse {
  rpcId: string
  result: {
    ok: boolean
    value?: unknown
    error?: { code: string; message: string; details?: unknown }
  }
}

/** Options for one unary call (design 02 §3.3/§3.4). */
export interface UnaryOptions {
  /** Caller cancellation signal. */
  signal?: AbortSignal
  /** Override the default 30s policy; null = caller-signal-only (no timer). */
  timeoutMs?: number | null
  /** The connection generation's AbortSignal — its death settles with connection_offline. */
  generationSignal?: AbortSignal
  /** Per-session pending soft cap; undefined = default (64), null disables. */
  pendingCap?: number | null
}

/** Options for one respond call (design 02 §3.3/§3.4). */
export interface RespondOptions {
  signal?: AbortSignal
  timeoutMs?: number | null
  generationSignal?: AbortSignal
}

/** One envelope observation row (design 02 §3.3). */
export interface EnvelopeRow {
  rpcId: string
  method: string
  /** Undefined for entries that do not address a session (respond receipts). */
  sessionId?: string
  state: 'pending' | 'settled'
  startedAt: number
}

/** Receives the microtask-batched snapshot rows (design 02 §3.3). */
export type EnvelopeListener = (batch: EnvelopeRow[]) => void

/** The RpcReceipt of /api/respond: idempotent (not-pending on late/duplicate). */
export interface RpcReceipt {
  accepted: boolean
  reason?: string
}

/** The ClientResponse full form posted to /api/respond. */
export interface ClientResponse {
  rpcId?: string
  result: unknown
}

/** A ServerRequest frame from the downstream streams (/api/events.mux|host). */
export interface ServerRequest {
  type: 'server-request'
  rpcId: string
  method: string
  payload: Record<string, unknown>
}

/** Default unary transport health deadline (matches the ref client's 30_000). */
export const DEFAULT_TIMEOUT_MS = 30_000

/** A damaged or hostile runtime must not make the desktop buffer an
 * unbounded unary envelope before the activation probe can reject it. */
export const MAX_UNARY_RESPONSE_BYTES = 1024 * 1024

class BoundedJsonError extends Error {
  readonly kind: 'too-large' | 'invalid-json'

  constructor(kind: 'too-large' | 'invalid-json') {
    super(kind)
    this.kind = kind
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared)
    && Number(declared) > MAX_UNARY_RESPONSE_BYTES) {
    try { await response.body?.cancel() } catch { /* best-effort carrier cleanup */ }
    throw new BoundedJsonError('too-large')
  }
  if (response.body === null) throw new BoundedJsonError('invalid-json')

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
        throw new BoundedJsonError('too-large')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof BoundedJsonError) throw error
    throw new BoundedJsonError('invalid-json')
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
    throw new BoundedJsonError('invalid-json')
  }
}

/**
 * Default per-session pending soft cap (design 02 §3.3): at most this many
 * in-flight unary calls may address one session before new calls are rejected
 * with PendingCapExceededError. Configurable per call via `pendingCap`;
 * `pendingCap: null` disables the cap entirely.
 */
export const DEFAULT_PENDING_CAP_PER_SESSION = 64

/** One pending-table entry (design 02 §3.3). */
interface PendingEntry {
  rpcId: string
  method: string
  sessionId?: string
  payload?: unknown
  controller: AbortController
  timeoutMs: number | null
  settled: boolean
  createdAt: number
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  _cleanup?: () => void
}

/**
 * rpcId → PendingCall table (design 02 §3.3). Node's single thread makes every
 * access serial (each settle runs inside one microtask/event handler); the only
 * race guard needed is the `settled` flag — the first settle path wins and
 * cleans up the remaining listeners, later paths are no-ops.
 *
 * The table also keeps the per-session pending counters (soft cap, design
 * 02 §3.3) and the envelope observation batch (design 02 §3.3): a
 * microtask-batched snapshot subscription where each flush emits the current
 * pending rows plus the entries settled since the previous flush.
 */
const pendingTable = {
  table: new Map<string, PendingEntry>(),
  settled: 0,
  /** sessionId → in-flight unary count (soft-cap input, design 02 §3.3). */
  sessionCounts: new Map<string, number>(),
  /** Envelope observation listeners; throws are isolated per listener. */
  envelopeListeners: new Set<EnvelopeListener>(),
  /** Rows accumulated since the last flush (register/settle, arrival order). */
  envelopeBatch: [] as EnvelopeRow[],
  envelopeScheduled: false,

  register(entry: PendingEntry) {
    this.table.set(entry.rpcId, entry)
    if (entry.sessionId !== undefined) {
      this.sessionCounts.set(entry.sessionId, (this.sessionCounts.get(entry.sessionId) ?? 0) + 1)
    }
    this.noteEnvelope(entry, 'pending')
  },

  /** Settle exactly once. Returns false when already settled / unknown. */
  settle(rpcId: string, outcome: unknown) {
    const entry = this.table.get(rpcId)
    if (entry === undefined || entry.settled) return false
    entry.settled = true
    entry._cleanup?.()
    this.table.delete(rpcId)
    this.settled += 1
    if (entry.sessionId !== undefined) {
      const count = (this.sessionCounts.get(entry.sessionId) ?? 1) - 1
      if (count <= 0) this.sessionCounts.delete(entry.sessionId)
      else this.sessionCounts.set(entry.sessionId, count)
    }
    this.noteEnvelope(entry, 'settled')
    if (outcome instanceof Error) entry.reject(outcome)
    else entry.resolve(outcome)
    return true
  },

  /** Batch-settle every pending call (generation death / stop). */
  abortAll(reason: unknown) {
    for (const rpcId of [...this.table.keys()]) {
      const entry = this.table.get(rpcId)
      if (entry === undefined || entry.settled) continue
      this.settle(rpcId, reason)
      entry.controller.abort(reason)
    }
  },

  /**
   * Enqueue one envelope row and schedule a single microtask flush (ref
   * subscribeEnvelopes batching semantics: a frame storm never costs one
   * notification per frame). Rows carry {rpcId, method, sessionId?, state,
   * startedAt}; `sessionId` is undefined for entries that do not address a
   * session (respond receipts).
   */
  noteEnvelope(entry: PendingEntry, state: EnvelopeRow['state']) {
    if (this.envelopeListeners.size === 0) return
    this.envelopeBatch.push({
      rpcId: entry.rpcId,
      method: entry.method,
      sessionId: entry.sessionId,
      state,
      startedAt: entry.createdAt,
    })
    if (this.envelopeScheduled) return
    this.envelopeScheduled = true
    queueMicrotask(() => {
      this.envelopeScheduled = false
      const batch = this.envelopeBatch
      this.envelopeBatch = []
      for (const listener of this.envelopeListeners) {
        try {
          listener(batch)
        } catch { /* observation never breaks the carrier */ }
      }
    })
  },

  size() {
    return this.table.size
  },
}

/** Diagnostic counters for the pending table (settle-once observable in tests). */
export function pendingStats() {
  return { size: pendingTable.size(), settled: pendingTable.settled }
}

/**
 * Subscribe to batched envelope observation (design 02 §3.3, ref
 * AbstractApiClient.subscribeEnvelopes semantics): each flushed batch is the
 * current pending list (state 'pending') plus the entries settled since the
 * previous flush (state 'settled'), in arrival order, one flush per microtask
 * boundary. Listener throws are isolated (observation never breaks the
 * carrier).
 * @param listener - receives the batch array of
 *   {rpcId, method, sessionId?, state, startedAt} rows.
 * @returns the unsubscribe function.
 */
export function pendingEnvelope(listener: EnvelopeListener): () => void {
  if (typeof listener !== 'function') {
    throw new TypeError('pendingEnvelope: listener must be a function')
  }
  pendingTable.envelopeListeners.add(listener)
  return () => {
    pendingTable.envelopeListeners.delete(listener)
  }
}

/**
 * The session a pending entry addresses, when it addresses one (design 02
 * §3.3 soft cap + envelope rows): legacy unary payloads carry sessionId
 * top-level; the Typert endpoint carries it as args.agentId. Any other
 * payload shape is not session-scoped.
 */
function sessionIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (typeof record.sessionId === 'string') return record.sessionId
  const args = record.args as Record<string, unknown> | undefined
  if (typeof args?.agentId === 'string') return args.agentId
  return undefined
}

/**
 * Local policy rejection: the per-session pending soft cap was exceeded
 * (design 02 §3.3). Thrown synchronously before any fetch — nothing was
 * registered, so no envelope row is produced for the rejection itself.
 * This is a control-plane-local policy error, not a transport or business
 * error of the dsh wire.
 */
export class PendingCapExceededError extends Error {
  readonly code = 'pending_session_cap_exceeded'
  readonly sessionId: string
  readonly cap: number

  constructor(sessionId: string, cap: number) {
    super(`dsh call: pending cap ${cap} exceeded for session ${sessionId}`)
    this.name = 'PendingCapExceededError'
    this.sessionId = sessionId
    this.cap = cap
  }
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
 * namespace (never a dsh RpcErrorCode, design 02 §3.10):
 *   connection_offline / request_timeout / aborted / protocol_violation /
 *   stream_frame_too_large / stream_queue_overflow /
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

/** Mint a fresh correlation id (the initiator's job per the dsh contract). */
export function mintRpcId(): string {
  return randomUUID()
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
 * Combine the entry controller (abortAll handle), the caller signal, the
 * generation signal and the timeout policy into the fetch AbortSignal, and
 * report which component fired first so the transport error code is accurate.
 * The timeout is a plain (ref'd) timer that aborts the entry controller — the
 * loop stays alive while a request is in flight and the timer is cleared on
 * settle (no leak).
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
 * @param method - the wire path segment, e.g. 'session.list' (POST /api/<method>).
 * @param payload - the business payload (schema-validated host-side).
 * @param options - {signal?} caller cancellation; {timeoutMs?} override the
 *   default 30s policy (null = caller-signal-only, no timer);
 *   {generationSignal?} the connection generation's AbortSignal — its death
 *   settles this call with connection_offline; {pendingCap?} the per-session
 *   pending soft cap (design 02 §3.3), defaults to
 *   DEFAULT_PENDING_CAP_PER_SESSION (64), null disables.
 * @returns {rpcId, result} — the narrow response form; throws RpcBusinessError
 *   when result.ok is false and RpcTransportError for carrier failures.
 */
export async function call(
  baseUrl: string,
  method: string,
  payload: unknown,
  { signal, timeoutMs, generationSignal, pendingCap }: UnaryOptions = {},
): Promise<UnaryResponse> {
  const rpcId = mintRpcId()
  const timeout = normalizeTimeout(timeoutMs)
  if (signal?.aborted) {
    throw new RpcTransportError(`dsh unary ${method}: caller cancelled`, 0, 'aborted')
  }
  if (generationSignal?.aborted) {
    throw new RpcTransportError(`dsh unary ${method}: connection is offline`, 0, 'connection_offline')
  }
  const sessionId = sessionIdOf(payload)
  const cap = pendingCap === undefined ? DEFAULT_PENDING_CAP_PER_SESSION : pendingCap
  if (sessionId !== undefined && cap !== null && (pendingTable.sessionCounts.get(sessionId) ?? 0) >= cap) {
    throw new PendingCapExceededError(sessionId, cap)
  }
  const controller = new AbortController()
  const composed = composeSignals({ signal, generationSignal, timeoutMs: timeout, controller })
  const entry: PendingEntry = {
    rpcId,
    method,
    sessionId,
    payload,
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
    response = await fetch(new URL(`/api/${method}`, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
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
    if (error instanceof BoundedJsonError && error.kind === 'too-large') {
      throw fail(`dsh unary ${method}: response body exceeds ${MAX_UNARY_RESPONSE_BYTES} bytes`, response.status, 'response_too_large')
    }
    throw fail(`dsh unary ${method}: response body is not valid bounded JSON`, response.status, 'protocol_violation')
  }
  if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) {
    throw fail(`dsh unary ${method}: missing or mismatched server-response`, response.status, 'protocol_violation')
  }
  const result = envelope.result
  if (typeof result !== 'object' || result === null || typeof result.ok !== 'boolean') {
    throw fail(`dsh unary ${method}: malformed result slot`, response.status, 'protocol_violation')
  }
  if (result.ok) {
    pendingTable.settle(rpcId, { rpcId, result })
    return { rpcId, result }
  }
  const errorBranch = typeof result.error === 'object' && result.error !== null
    ? result.error
    : { code: 'unknown_rpc_code', message: 'malformed error branch', details: {} }
  // Business errors ride the resolve path (design 02 §3.10); the surface-facing
  // throw happens only after the entry settled.
  pendingTable.settle(rpcId, { rpcId, result })
  throw new RpcBusinessError(errorBranch)
}

/**
 * Answer an answerable server-request (approval/question): POST /api/respond.
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
  const timeout = normalizeTimeout(timeoutMs)
  if (signal?.aborted) {
    throw new RpcTransportError('dsh respond: caller cancelled', 0, 'aborted')
  }
  if (generationSignal?.aborted) {
    throw new RpcTransportError('dsh respond: connection is offline', 0, 'connection_offline')
  }
  const controller = new AbortController()
  const composed = composeSignals({ signal, generationSignal, timeoutMs: timeout, controller })
  const entry: PendingEntry = {
    rpcId: typeof rpcId === 'string' ? rpcId : '',
    method: 'respond',
    payload: message?.result,
    controller,
    timeoutMs: timeout,
    settled: false,
    createdAt: Date.now(),
    resolve: () => {},
    reject: () => {},
    _cleanup: composed.cleanup,
  }
  if (typeof rpcId === 'string') pendingTable.register(entry)

  const fail = (messageText: string, status: number, code?: string) => {
    const transportError = new RpcTransportError(messageText, status, code)
    if (typeof rpcId === 'string') pendingTable.settle(rpcId, transportError)
    return transportError
  }

  let response: Response
  try {
    response = await fetch(new URL('/api/respond', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId: message.rpcId, result: message.result }),
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
    if (error instanceof BoundedJsonError && error.kind === 'too-large') {
      throw fail(`dsh respond: response body exceeds ${MAX_UNARY_RESPONSE_BYTES} bytes`, response.status, 'response_too_large')
    }
    throw fail('dsh respond: response body is not valid bounded JSON', response.status, 'protocol_violation')
  }
  if (receipt?.accepted !== true && !(receipt?.accepted === false && typeof receipt.reason === 'string')) {
    throw fail('dsh respond: malformed receipt', response.status, 'protocol_violation')
  }
  if (typeof rpcId === 'string') pendingTable.settle(rpcId, receipt)
  return receipt
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
 * @param path - '/api/events.mux' or '/api/events.host'.
 * @param signal - the stream's AbortSignal; aborts the socket and ends iteration.
 * @param onOpen - optional barrier callback fired only after the WebSocket
 *   upgrade has completed and message listeners are installed.
 * @param limits - optional test seam that may only tighten hard production
 *   limits for one raw frame and the pre-parse queue.
 * @returns an async generator of ServerRequest full forms.
 */
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

/** One generation-scoped cache entry (design 02 §3.11 / D8). */
interface CapabilityEntry {
  value: Record<string, unknown>
  cachedAt: number
  generationSignal?: AbortSignal
  _unlisten: (() => void) | null
}

/**
 * Generation-scoped host.describe snapshot cache (design 02 §3.11 / D8).
 * An entry is valid only while the generation that fetched it is alive: its
 * AbortSignal's abort removes the entry, so a snapshot never outlives its
 * generation (a fresh generation always refetches — "旧但稳定,绝不跨代残留").
 * `force: true` bypasses the cache; transport failures are never cached.
 * Emits no events — the coordinator wires onReady publication and generation
 * invalidation upstream. Cache entries are keyed by baseUrl (one DshClient
 * instance per host).
 */
const capabilityCache = new Map<string, CapabilityEntry>()

/**
 * Drop every cached capability snapshot (generation death / explicit stop).
 */
export function invalidateCapabilities() {
  for (const entry of capabilityCache.values()) entry._unlisten?.()
  capabilityCache.clear()
}

/** Options for describeCapabilities (design 02 §3.11 / D8). */
export interface DescribeCapabilitiesOptions {
  generationSignal?: AbortSignal
  /** Bypass the cache and refetch. */
  force?: boolean
  timeoutMs?: number | null
}

/** The served host.describe snapshot (treat the value as immutable). */
export interface CapabilitySnapshot {
  value: Record<string, unknown>
  cachedAt: number
}

/**
 * Fetch the host.describe snapshot once per connection generation and serve
 * subsequent callers from the cache.
 * @param baseUrl - origin of the dsh host, e.g. http://127.0.0.1:17510.
 * @param options - {generationSignal?} the connection generation's
 *   AbortSignal: the cache hit is only valid for the same generation object,
 *   and its abort clears the entry; {force?} bypass the cache and refetch.
 * @returns {value, cachedAt} — the host.describe value object (treat as
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
    throw new RpcTransportError('dsh host.describe: connection is offline', 0, 'connection_offline')
  }
  const cached = capabilityCache.get(baseUrl)
  if (!force && cached !== undefined && cached.generationSignal === generationSignal) {
    return { value: cached.value, cachedAt: cached.cachedAt }
  }
  const { result } = await call(baseUrl, 'host.describe', {}, { generationSignal, timeoutMs })
  const value = result.value
  if (typeof value !== 'object' || value === null) {
    throw new RpcTransportError('dsh host.describe: malformed value slot', 0, 'protocol_violation')
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
