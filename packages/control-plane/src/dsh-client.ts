/**
 * dsh wire protocol layer. The desktop control-plane uses only the unary
 * client, the unified host-identity probe (probeHostIdentity — the
 * session/canOpenWorkspacePath identity contract with its legacy session/list
 * fallback, single-sourced in rpc-envelope.ts) and the generation-scoped
 * abort semantics. The separately invoked authenticated gateway proxies the
 * same unary wire (runtime-manager.ts consumes call()).
 *
 * The retired control-plane interaction/session-runtime domain is DELETED
 * here rather than parked as @deprecated dead code (2026-09-11 review;
 * CONTRIBUTING.md §范围纪律 — a removed domain never flows back):
 * `respond()` (POST /api/respond, client-response envelope) and
 * `openEventStream()` (the old events.mux/events.host downlink consumer) went
 * with their types and stream-limit seam. dsh-v0.1.2-alpha.1 had already
 * deleted both wires upstream, no production caller remained, and the
 * answerable surface is the `$events/result` Remote over /api/remote.mux.
 *
 * Invariants:
 * - rpcId is minted by the initiator (this client) on every unary call and
 *   echoes back in the server-response; a mismatch is a protocol violation.
 * - unary: POST /api/<method>, body {type:'client-request', rpcId, method,
 *   payload}, content-type application/json. Business errors ride the 200
 *   body's result.error branch; non-2xx HTTP statuses express only carrier
 *   failures.
 * - every unary call carries a 30s timeout (DEFAULT_TIMEOUT_MS) merged
 *   with the caller's AbortSignal and the connection generation's signal
 *   (generationSignal); `timeoutMs: null` opts out of the timer entirely
 *   (caller-signal-only policy).
 * - every client-request converges on the rpcId pending table (settle-once):
 *   the `settled` flag + first-writer-wins make response arrival vs timeout
 *   vs caller abort settle each entry exactly once.
 * - every unary response body is read under a per-call byte cap
 *   (UnaryOptions.maxResponseBytes; default MAX_UNARY_RESPONSE_BYTES) so a
 *   damaged/growing host can never grow this process's memory without bound.
 * - probe semantics are decoupled from session-data growth (2026 final
 *   probe-contract plan): the unified identity probe speaks the fixed-size
 *   `session/canOpenWorkspacePath` boolean (HOST_PROBE_MAX_RESPONSE_BYTES)
 *   and only falls back to the session-data-bearing legacy `session/list`
 *   probe (1 MiB default cap) on an HTTP 404 — a runtime tree that predates
 *   the identity method. The old generation-scoped session/list capability
 *   snapshot cache (describeCapabilities) is gone: no production consumer
 *   needed the snapshot, and the periodic health probe now verifies the
 *   fixed-size identity contract instead of re-reading the session list.
 */

// The wire envelope is single-sourced in rpc-envelope.ts (A2 cross-package
// protocol single-sourcing): envelope construction and server-response
// validation are shared with the desktop probes (ssh-provider.ts) — only the
// fetch-carrier orchestration (pending table / settle-once / signal
// composition) stays here.
import {
  buildClientRequest,
  buildHostIdentityProbePayload,
  buildLegacyHostProbePayload,
  HOST_IDENTITY_METHOD,
  HOST_IDENTITY_METHOD_SINCE,
  HOST_PROBE_MAX_RESPONSE_BYTES,
  LEGACY_HOST_PROBE_METHOD,
  mintRpcId,
  parseServerResponse,
} from './rpc-envelope.ts'
import { authCookieFor } from './browser-auth-cookie.ts'

export {
  HOST_IDENTITY_METHOD,
  HOST_IDENTITY_METHOD_SINCE,
  HOST_PROBE_MAX_RESPONSE_BYTES,
  LEGACY_HOST_PROBE_METHOD,
  buildHostIdentityProbePayload,
  buildLegacyHostProbePayload,
} from './rpc-envelope.ts'
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
  /** Per-call response-body cap in bytes (default MAX_UNARY_RESPONSE_BYTES).
   *  The unified identity probe passes HOST_PROBE_MAX_RESPONSE_BYTES (64 KiB)
   *  so an oversized answer can never be mistaken for the fixed-size boolean
   *  identity response. */
  maxResponseBytes?: number
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
 * count remains authoritative when the header is absent or dishonest. The
 * cap is per-call (the caller's UnaryOptions.maxResponseBytes), defaulting
 * to MAX_UNARY_RESPONSE_BYTES. */
async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
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
      if (total > maxBytes) {
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
 *   response_too_large / transport_http_<status> / transport_error
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
 * @param method - the wire path segment, e.g. 'session/canOpenWorkspacePath'
 *   (POST /api/<method>). dsh 0.1.2-alpha.1 requires slash-separated endpoints
 *   (the old dot paths 404).
 * @param payload - the business payload (schema-validated host-side).
 * @param options - {signal?} caller cancellation; {timeoutMs?} override the
 *   default 30s policy (null = caller-signal-only, no timer);
 *   {generationSignal?} the connection generation's AbortSignal — its death
 *   settles this call with connection_offline; {maxResponseBytes?} per-call
 *   response-body cap (default MAX_UNARY_RESPONSE_BYTES).
 * @returns {rpcId, result} — the narrow response form; throws RpcBusinessError
 *   when result.ok is false and RpcTransportError for carrier failures.
 */
export async function call(
  baseUrl: string,
  method: string,
  payload: unknown,
  { signal, timeoutMs, generationSignal, maxResponseBytes }: UnaryOptions = {},
): Promise<UnaryResponse> {
  const maxBytes = maxResponseBytes === undefined ? MAX_UNARY_RESPONSE_BYTES : maxResponseBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RpcTransportError(`dsh unary ${method}: maxResponseBytes must be a positive safe integer`, 0, 'protocol_violation')
  }
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
    envelope = await readBoundedJson(response, maxBytes)
  } catch (error) {
    const cancellation = composed.fired()
    if (cancellation !== null) {
      throw fail(`dsh unary ${method}: request cancelled while reading response`, 0, cancellation)
    }
    if (error instanceof BoundedResponseError && error.kind === 'too-large') {
      throw fail(
        `dsh unary ${method}: response body exceeds ${maxBytes} bytes`,
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

/** Options for probeHostIdentity. */
export interface ProbeHostIdentityOptions {
  signal?: AbortSignal
  generationSignal?: AbortSignal
  /** Per-call unary timeout (default 30s policy). */
  timeoutMs?: number | null
  /** Warning sink for the legacy fallback (required — the fallback must
   *  never be silent; every control-plane caller owns a Logger). */
  logger: { warn(line: string): void }
}

/** Narrow the transport-error surface to the 404 signal that selects the
 *  legacy fallback. Only an HTTP 404 from the host (the runtime tree does
 *  not register the identity method) falls back; every other failure — 401
 *  auth gate, 5xx, timeout, malformed body — fails loud, never silently
 *  downgrades to the session-data probe. */
function isHostIdentityNotFound(error: unknown): boolean {
  return error instanceof RpcTransportError && error.status === 404
}

/** Per-baseUrl throttle for the legacy-fallback warning: the diagnostic is a
 *  property of the HOST (its runtime tree predates the identity method), so
 *  re-announcing it on every 500ms readiness retry or every 30s health cycle
 *  would only spam the log without new information. The marker is added when
 *  a legacy fallback succeeds and REMOVED when the identity method later
 *  answers — the throttle therefore means "once per consecutive legacy
 *  episode per baseUrl": a host that switches runtimes back and forth
 *  (restartLocal / stop→start with a version switch on the same port)
 *  re-announces the warning for each new legacy episode, while a persistent
 *  legacy host stays silent after its first warning. */
const legacyFallbackWarnedBaseUrls = new Set<string>()

/**
 * The unified host-identity probe (single-sourced contract in rpc-envelope.ts:
 * HOST_IDENTITY_METHOD / LEGACY_HOST_PROBE_METHOD / HOST_PROBE_MAX_RESPONSE_BYTES):
 * verify that the host answers the dsh identity wire without ever reading
 * session data.
 *
 *  1. POST the `session/canOpenWorkspacePath` identity Remote (zero-arg →
 *     boolean; response bounded at HOST_PROBE_MAX_RESPONSE_BYTES). The probe
 *     passes when the server-response echoes the rpcId with result.ok ===
 *     true and a BOOLEAN value — value true and value false are equally
 *     healthy: the probe verifies that the method exists, the protocol is
 *     correct and the SessionController is assembled, not the platform
 *     answer itself.
 *  2. HTTP 404 (the runtime tree does not register the identity method) falls
 *     back to the legacy `session/list` probe (default 1 MiB cap). The
 *     caller is warned ONLY when the legacy fallback SUCCEEDS — a successful
 *     legacy answer is the real signal of a pre-identity runtime tree, while
 *     a transient modern-tree 404 (routes still mounting) or a both-404
 *     failure stays quiet. The warning is emitted at most once per
 *     CONSECUTIVE legacy episode per baseUrl (added on fallback success,
 *     cleared on the next identity-method success), so the 30s health cycle
 *     never spams while a host that downgrades again re-announces its state
 *     — upstream identity-method drift stays visible without log spam.
 *  3. Anything else — 401 browser-auth gate, 5xx, timeout, malformed or
 *     non-boolean envelope — fails loud. Failures are never cached.
 *
 * @param baseUrl - origin of the dsh host, e.g. http://127.0.0.1:17510.
 * @param options - {logger} warning sink (required; the fallback must never
 *   be silent), {signal?} caller cancellation, {generationSignal?} the
 *   connection generation's AbortSignal (its death settles with
 *   connection_offline), {timeoutMs?} unary timeout override.
 * @returns true when the host answered the identity handshake (either the
 *   identity method or the legacy fallback) — resolution IS the health
 *   verdict; the host's boolean answer is deliberately not surfaced so no
 *   caller can mistake value false for a probe failure.
 * @throws RpcBusinessError for the result.error branch; RpcTransportError
 *   (connection_offline / aborted / request_timeout / response_too_large /
 *   protocol_violation / transport_http_<status>).
 */
export async function probeHostIdentity(
  baseUrl: string,
  { signal, generationSignal, timeoutMs, logger }: ProbeHostIdentityOptions,
): Promise<boolean> {
  try {
    const { result } = await call(
      baseUrl,
      HOST_IDENTITY_METHOD,
      buildHostIdentityProbePayload(),
      {
        signal,
        generationSignal,
        timeoutMs,
        maxResponseBytes: HOST_PROBE_MAX_RESPONSE_BYTES,
      },
    )
    if (typeof result.value !== 'boolean') {
      throw new RpcTransportError(
        `dsh ${HOST_IDENTITY_METHOD}: malformed value slot (expected boolean)`,
        0,
        'protocol_violation',
      )
    }
    // Both boolean answers are healthy: only the method presence / protocol
    // correctness / controller assembly is under test. The identity method
    // answering also closes the current legacy episode — a later downgrade
    // re-arms the fallback warning (see legacyFallbackWarnedBaseUrls).
    legacyFallbackWarnedBaseUrls.delete(baseUrl)
    return true
  } catch (error) {
    if (isHostIdentityNotFound(error)) {
      // Legacy trees keep answering session/list exactly as before; a 404 on
      // BOTH methods (or any non-404 failure of the fallback) fails loud.
      try {
        const { result } = await call(
          baseUrl,
          LEGACY_HOST_PROBE_METHOD,
          buildLegacyHostProbePayload(),
          { signal, generationSignal, timeoutMs },
        )
        // Legacy-answer shape check: the pre-degrade session/list probe
        // (describeCapabilities) validated the value slot — ok:true with a
        // non-object value was a protocol_violation, never a healthy host.
        // "Bit-identical legacy semantics" includes that check: a damaged
        // legacy host must fail loud, not pass the health probe.
        if (typeof result.value !== 'object' || result.value === null) {
          throw new RpcTransportError(
            `dsh ${LEGACY_HOST_PROBE_METHOD}: malformed value slot`,
            0,
            'protocol_violation',
          )
        }
      } catch (legacyError) {
        if (isHostIdentityNotFound(legacyError)) {
          throw new RpcTransportError(
            `dsh host identity probe: neither ${HOST_IDENTITY_METHOD} nor legacy ${LEGACY_HOST_PROBE_METHOD} is registered (HTTP 404)`,
            404,
            'protocol_violation',
          )
        }
        throw legacyError
      }
      // Warn only after the fallback SUCCEEDED: a successful legacy answer
      // proves the host predates the identity method (or that the method is
      // unavailable while session/list still lives). Transient modern-tree
      // 404s and both-404 failures never reach this line, so the premise of
      // the warning is always the observed fact.
      if (!legacyFallbackWarnedBaseUrls.has(baseUrl)) {
        legacyFallbackWarnedBaseUrls.add(baseUrl)
        logger.warn(
          `dsh host identity probe: ${HOST_IDENTITY_METHOD} answered HTTP 404 while the legacy ${LEGACY_HOST_PROBE_METHOD} probe succeeded — `
          + `the host runtime tree predates the identity method (dsh < ${HOST_IDENTITY_METHOD_SINCE}) or does not register it; `
          + 'the legacy probe response grows with session data (1 MiB cap). '
          + '(reported once per legacy episode — re-armed when the identity method answers again)',
        )
      }
      return true
    }
    throw error
  }
}
