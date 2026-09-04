/**
 * Shared reverse-proxy forwarding core (design 17 §6.2, 方案 A).
 *
 * Extracted from instance-proxy.ts so that gateway-proxy.ts reuses
 * the exact Host/Origin rewrite, header-stripping, error semantics, rate
 * limiting, WebSocket splice and heartbeat — no fork, no drift. The two
 * proxies differ only in target resolution, which the caller passes in as a
 * fully-resolved `URL`:
 *
 *   - instance-proxy resolves `/api/i/<id>/*` → transport/local baseUrl and
 *     strips the prefix;
 *   - gateway-proxy resolves every path → `http://127.0.0.1:<localDshPort>`
 *     and forwards the path verbatim (no prefix stripping).
 *
 * The wire behavior (forwarded headers, JSON error bodies, status codes,
 * body caps, WS splice, heartbeat) stays identical for both owners. Log lines
 * are the only parameterized surface: callers
 * pass `deps.logPrefix` (instance-proxy → 'instance-proxy', gateway-proxy →
 * 'gateway-proxy') and `deps.id` (the /api/i/<id> id, or a fixed label).
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Logger } from './types.ts'
import { startWsHeartbeat } from './ws-heartbeat.ts'

/** Request body cap (design 03 §3.4, same as the v2 runtime proxy; aligned with the upstream dsh 0.1.2-alpha.4 300MiB request cap / 200MiB image admission). */
export const MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024

// ---------------------------------------------------------------------------
// SPKI certificate pinning (design 17 §13.4.2 / S23): shared single source in
// spki-pin.ts — the desktop identity probe (gateway-provider.ts) and this
// proxy core both import it through their own package boundaries, so the two
// owners can never drift again (they used to carry byte-identical copies).
// Re-exported here for the instance-proxy gate and existing importers.
// ---------------------------------------------------------------------------

export {
  attachSpkiPinVerifier,
  spkiPinOfPeerCertificate,
  SPKI_PIN_MISMATCH_CODE,
  SPKI_PIN_PATTERN,
} from './spki-pin.ts'
import { attachSpkiPinVerifier } from './spki-pin.ts'

/** Response body cap for non-SSE responses (design 03 §3.4; aligned with the upstream dsh 0.1.2-alpha.4 300MiB request cap / 200MiB image admission). */
export const MAX_RESPONSE_BODY_BYTES = 300 * 1024 * 1024

/** HTML-document injection budget (S0): an upstream text/html response is
 * buffered for the owner's injector only when it is at most this large
 * (declared or actual). The gateway's html-inject.ts HTML_INJECT_MAX_BYTES
 * must stay equal — control-plane cannot import the gateway package. */
export const MAX_HTML_INJECTION_BYTES = 64 * 1024

/** Shared memory budget plus per-proxy concurrency defaults. The byte budget
 * is enforced process-wide across instance-proxy and gateway-proxy owners. */
export const MAX_BUFFERED_REQUEST_BYTES = 300 * 1024 * 1024
/** Chunked/unknown-length uploads cannot be preallocated without a second
 * full-size concat buffer. Keep that path small; large browser uploads must
 * carry Content-Length and use the single-allocation path below. */
export const MAX_UNDECLARED_REQUEST_BODY_BYTES = 32 * 1024 * 1024
export const MAX_CONCURRENT_HTTP_REQUESTS = 64
export const MAX_CONCURRENT_WS_STREAMS = 64
export const MAX_PENDING_WS_HANDSHAKES = 16

/** Shared by every proxy owner in this process (instance proxy + gateway
 * direct proxy). Per-owner counters remain diagnostic projections only. */
let processBufferedRequestBytes = 0

export function getProcessBufferedRequestBytes(): number {
  return processBufferedRequestBytes
}

/**
 * Upstream timeout (design 03 §3.3: "上游连接拒绝 / 超时 → 502 / 504"):
 * how long an upstream may take to answer headers, and — for non-SSE
 * responses — how long its body may idle before the proxy gives up with an
 * explicit 504 (upstream_timeout). SSE streams and upgraded WebSockets are
 * long-lived by nature: the timeout only covers reaching the response/101,
 * never the stream lifetime. A hung upstream can no longer stall the request
 * indefinitely.
 *
 * The chamber Git host has a 30s mutation budget and may emit no bytes while
 * Git is working. Keep this idle timeout strictly above that domain timeout so
 * the host result wins instead of a proxy-side 504 after the mutation commits.
 */
export const UPSTREAM_TIMEOUT_MS = 45_000

/** Maximum silence between client request-body chunks. */
export const CLIENT_BODY_IDLE_TIMEOUT_MS = 30_000

/**
 * WebSocket heartbeat (design 14 extension — sleep/wake stuck-deep-diving
 * fix): ping cadence for the spliced mux downstream. 0.1.2 FACT CORRECTION:
 * the original motivation was the 0.1.1 events.mux/events.host downlinks
 * (downlink-only, no heartbeat from either side); the 0.1.2 `/api/remote.mux`
 * host pings every downstream every `websocketHeartbeatIntervalMs` (default
 * 2s) and terminates after two missed pongs (~6s, see ws-heartbeat.ts), so
 * this proxy-side BROWSER-leg ping is now a REDUNDANT FALLBACK for the
 * sleep/wake case: the host heartbeat cannot guard the browser leg across an
 * OS sleep/wake (its pings simply fail during sleep), where the half-open
 * browser leg may fire no 'error'/'close' — the splice would hold forever
 * while the browser's pump stays "connected" but blind. The proxy pings the
 * browser; after `WS_PING_MISSES_BEFORE_TEARDOWN` cycles without a pong, the
 * splice is torn down so the browser's WebSocket closes and the renderer
 * pump reconnects (fresh stream → host baseline replay → UI re-sync).
 *
 * Values follow the canonical `ws` README heartbeat example (30s interval,
 * one unanswered ping cycle → terminate): the pong round-trip is loopback, so
 * a full cycle without one is a real death, not scheduler noise.
 *
 * The UPSTREAM (host) leg deliberately has no APPLICATION heartbeat: its
 * death is covered by SSH keepalive for remote tunnels
 * (`ServerAliveInterval=30 × CountMax=3` ≈ 90s, ssh-provider), socket
 * 'error'/'close' for local host death/restart, the host's own send-failure
 * close, and — for direct-http targets only — the S2 OS-level TCP keepalive
 * (instance-proxy passes tcpKeepAliveMs; initial idle 30s, OS-default probes,
 * see instance-proxy.ts). A proxy-side upstream APPLICATION ping would only
 * race SSH keepalive into a reconnect flap against a half-open tunnel
 * (strict tolerance) or fire later than it (lenient tolerance — useless).
 * (The 30s values of TCP keepalive idle / WS_PING / ServerAlive coincide;
 * rationales differ — do not merge them.)
 */
export const WS_PING_INTERVAL_MS = 30_000

/** Consecutive ping cycles without a browser pong before the splice is torn down. */
export const WS_PING_MISSES_BEFORE_TEARDOWN = 1

/** Response headers converged through to the browser (03 §3.4 / 04 §4.3). */
export const RESPONSE_HEADER_WHITELIST = new Set([
  'content-type',
  'content-encoding',
  'content-language',
  'content-range',
  'content-disposition',
  'accept-ranges',
  'cache-control',
  'etag',
  'expires',
  'last-modified',
  'location',
  'vary',
  'x-next-cursor',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
])

/** WS stream path forwarded to the instance (03 §3.1 / 05 §3.1): the Typert
 * Remote stream mux. The old /api/events.mux and /api/events.host downlinks
 * were deleted upstream (dsh 0.1.2-alpha.1), so the set now admits exactly
 * /api/remote.mux. */
export const WS_STREAM_PATHS = new Set(['/api/remote.mux'])

/** Hop-by-hop and credential headers never forwarded upstream. */
export const STRIPPED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'keep-alive',
  'host',
  'cookie',
  'authorization',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Never let a browser/client impersonate reverse-proxy routing identity at
  // the attached dsh instance (main 163622b).
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  // Compression negotiation must not cross the proxy (2026 audit M3b):
  // accept-encoding is stripped upstream so the upstream answers identity;
  // any upstream that still compresses is labeled correctly via the
  // content-encoding response whitelist, so the browser never misparses a
  // compressed body as raw bytes.
  'accept-encoding',
])

/** Only headers required to complete a WebSocket 101 may cross downstream. */
export const WS_RESPONSE_HEADER_WHITELIST = new Set([
  'upgrade',
  'connection',
  'sec-websocket-accept',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
])

export const STATUS_TEXT: Record<number, string> = {
  404: 'Not Found',
  408: 'Request Timeout',
  413: 'Payload Too Large',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

/** The minimal request surface the proxy reads (node:http + test doubles). */
export interface ProxyRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>
}

/** The minimal response surface the proxy writes. */
export interface ProxyResponse {
  writeHead(statusCode: number, headers?: Record<string, string | number | string[] | undefined>): unknown
  end(payload?: unknown): unknown
  write(chunk: unknown): boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  setHeader(name: string, value: unknown): unknown
  destroy(): unknown
  headersSent: boolean
  /** The per-request CORS headers set by the api layer (spread into every response). */
  _corsHeaders?: Record<string, string>
}

/** The upgrade socket surface (net.Socket). */
export interface ProxySocket {
  write(data: unknown, cb?: () => void): unknown
  end(data?: unknown): unknown
  destroy(): unknown
  pipe(destination: unknown): unknown
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}

/** Owner-side registry for downstream sockets whose upstream WebSocket
 * handshake has not reached a terminal verdict yet. Node's HTTP server stops
 * tracking a socket once the `upgrade` event fires, while `liveStreams` only
 * receives it after the upstream answers 101; without this middle-state
 * registry stop() has a gap where neither owner can revoke the socket. */
export interface PendingUpgradeTracker {
  readonly size: number
  /** Acquire one handshake lease. The returned release is idempotent. */
  acquire(socket: ProxySocket, ownerId?: string): () => void
  /** Destroy every pending downstream. Its existing close listener aborts the
   * corresponding upstream ClientRequest and releases the lease. With an
   * ownerId, only handshakes authenticated through that transport are closed. */
  closeAll(ownerId?: string): void
}

export function createPendingUpgradeTracker(): PendingUpgradeTracker {
  const entries = new Set<{ socket: ProxySocket; ownerId?: string }>()
  return {
    get size(): number { return entries.size },
    acquire(socket: ProxySocket, ownerId?: string): () => void {
      const entry = { socket, ...(ownerId === undefined ? {} : { ownerId }) }
      entries.add(entry)
      let released = false
      return () => {
        if (released) return
        released = true
        entries.delete(entry)
      }
    },
    closeAll(ownerId?: string): void {
      for (const entry of [...entries]) {
        if (ownerId !== undefined && entry.ownerId !== ownerId) continue
        // Delete eagerly so diagnostics and repeated stop() calls converge even
        // for a minimal/faulty socket fake that never emits `close`.
        entries.delete(entry)
        try { entry.socket.destroy() } catch { /* already gone */ }
      }
    },
  }
}

/** The injectable outbound request factory (defaults to node:http request). */
export type HttpRequestFactory = typeof httpRequest

/** Shared numeric gauges mutated by the forward functions and read by the owner. */
export interface ProxyForwardCounters {
  requests: number
  failures: number
  activeStreams: number
  /** Bytes currently reserved against the process-wide request-body budget. */
  bufferedRequestBytes: number
}

/** One established WS splice. `ownerId` is set by the multi-transport
 * instance proxy so revoking a transport also revokes streams authenticated
 * with that transport's old credentials. */
export interface ProxyLiveStream {
  downstream: ProxySocket
  upstream: Duplex
  ownerId?: string
}

/** Config + shared state the forward functions need (all resolved by the owner). */
export interface ProxyForwardDeps {
  /** Log label: the /api/i/<id> id, or a fixed gateway label. */
  id: string
  /** Log-line prefix (instance-proxy vs gateway-proxy). */
  logPrefix: string
  /** Injectable outbound request factory (defaults to node:http request). */
  httpRequest?: HttpRequestFactory
  /** Upstream timeout in ms (default UPSTREAM_TIMEOUT_MS; tests inject small values). */
  upstreamTimeoutMs: number
  /** Client upload idle timeout in ms (tests inject small values). */
  clientBodyIdleTimeoutMs: number
  /** WebSocket heartbeat ping cadence in ms (tests inject small values). */
  wsPingIntervalMs: number
  /** Consecutive ping cycles without a browser pong before the splice is torn down. */
  wsPingMissesBeforeTeardown: number
  /**
   * Optional OS-level TCP keepalive for the UPSTREAM leg of a spliced
   * WebSocket, armed before the splice (S2 sidebar-stability patch). Only a
   * direct-http target enables it: the upstream leg deliberately has no
   * application heartbeat (see the WS_PING_* notes) — an ssh-tunneled target
   * is covered by ssh keepalive, but a direct http(s) target has no such
   * coverage, so an idle half-open connection (NAT/proxy GC) would freeze
   * the stream with no 'error'/'close' ever firing. instance-proxy passes
   * the value for any NON-loopback resolved target (the desktop's direct
   * http(s) shape — gateway-kind and dsh-kind alike, discriminated by the
   * upstream host, not the source-id kind);
   * `undefined` (the default — local, ssh-tunneled and gateway-proxy
   * splices) keeps the documented no-heartbeat design untouched.
   */
  readonly tcpKeepAliveMs?: number
  maxBufferedRequestBytes: number
  /**
   * Browser-visible prefix for an attached instance. Same-origin upstream
   * redirects are rewritten through this prefix so a `Location: /login`
   * cannot escape `/api/i/<id>`. `''` is a valid value for the single-target
   * gateway whose managed dsh is mounted at the root: the target origin is
   * stripped and the path is kept verbatim (`http://127.0.0.1:<port>/login`
   * becomes `/login` at the public origin). `undefined` (no rewriting) is the
   * passthrough default for owners without a mounted prefix.
   */
  responseBasePath?: string
  /**
   * Optional HTML-document trust injector (S0): when set, an unencoded
   * `text/html` response no larger than MAX_HTML_INJECTION_BYTES is buffered
   * whole and rewritten through this seam before it reaches the browser —
   * the gateway uses it to declare the proxied official dsh frontend
   * host-owned (`__DSH_TRANSPORT__.ownsHost`, gateway html-inject.ts).
   * Return the replacement document, or null to forward the body untouched.
   * `undefined` (the control-plane default) keeps the plain streaming
   * passthrough byte for byte.
   */
  readonly injectHtmlDocument?: (html: string) => string | null
  /**
   * Live spliced WS streams (downstream browser leg + upstream host leg),
   * shared with the owner so its stop() can force-close them: an upgraded
   * socket leaves the HTTP server's connection tracking, so a lingering
   * half-open downlink would otherwise hang server.close() forever.
   */
  liveStreams: Set<ProxyLiveStream>
  /** Optional transport registry key owning this request/stream. */
  streamOwner?: string
}

/**
 * Read the request body up to `cap` bytes; rejects with {code:
 * 'body_too_large'} when the cap is exceeded (design 03 §3.4 — explicit
 * 413, never a silent truncation).
 */
export async function readBody(
  req: ProxyRequest,
  cap: number,
  idleTimeoutMs = CLIENT_BODY_IDLE_TIMEOUT_MS,
  expectedBytes?: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  const preallocated = expectedBytes !== undefined && Number.isInteger(expectedBytes)
    && expectedBytes >= 0 && expectedBytes <= cap
    ? Buffer.allocUnsafe(expectedBytes)
    : null
  let size = 0
  const iterator = req[Symbol.asyncIterator]()
  while (true) {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const next = iterator.next()
    let result: IteratorResult<Buffer>
    try {
      result = await Promise.race([
        next,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error: Error & { code?: string } = new Error(`request body idle for ${idleTimeoutMs}ms`)
            error.code = 'request_timeout'
            reject(error)
          }, idleTimeoutMs)
        }),
      ])
    } catch (error) {
      // Cancel the underlying IncomingMessage iterator as well as our wait;
      // otherwise a slow client may keep the socket/request parser alive
      // after the proxy already returned 408.
      void iterator.return?.()
      throw error
    } finally {
      if (timeout !== null) clearTimeout(timeout)
    }
    if (result.done) break
    const chunk = result.value
    const nextSize = size + chunk.length
    if (nextSize > cap) {
      const error: Error & { code?: string } = new Error(`request body exceeds ${cap} bytes`)
      error.code = 'body_too_large'
      void iterator.return?.()
      throw error
    }
    const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (preallocated !== null) {
      const available = Math.max(0, preallocated.length - size)
      if (available > 0) normalized.subarray(0, available).copy(preallocated, size)
      if (normalized.length > available) chunks.push(normalized.subarray(available))
    } else chunks.push(normalized)
    size = nextSize
  }
  if (preallocated !== null && chunks.length === 0) return preallocated.subarray(0, size)
  // A declared Content-Length is enforced by Node's parser in production. If
  // an injected/test request violates it, preserve correctness without
  // reading beyond the cap; only that non-production mismatch uses concat.
  if (preallocated !== null && size > preallocated.length) {
    return Buffer.concat([preallocated.subarray(0, preallocated.length), ...chunks], size)
  }
  if (chunks.length === 0) return Buffer.alloc(0)
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size)
}

/** Wait for the response socket to drain (write-path backpressure). */
function waitForDrain(res: ProxyResponse): Promise<void> {
  return new Promise(resolve => res.once('drain', () => resolve()))
}

/**
 * A request body with a byte budget, for capped forwarding. `send()` keeps
 * the chunks live only until node:http accepts them and honours writable
 * backpressure instead of queueing the entire 300MiB body unconditionally.
 */
function bodySource(chunks: Buffer[]): { send: (upstream: ClientRequest) => void; stop: (upstream: ClientRequest) => void; size: number } {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  let index = 0
  let stopped = false
  let drainListener: (() => void) | null = null
  const writeAvailable = (upstream: ClientRequest): void => {
    if (stopped) return
    drainListener = null
    while (index < chunks.length) {
      const accepted = upstream.write(chunks[index])
      index += 1
      if (!accepted) {
        drainListener = () => writeAvailable(upstream)
        upstream.once('drain', drainListener)
        return
      }
    }
    chunks.length = 0
    upstream.end()
  }
  return {
    size,
    send(upstream: ClientRequest) {
      writeAvailable(upstream)
    },
    stop(upstream: ClientRequest) {
      stopped = true
      chunks.length = 0
      if (drainListener !== null) {
        upstream.removeListener('drain', drainListener)
        drainListener = null
      }
    },
  }
}

/** Rewrite only redirects back to the same trusted upstream origin. The
 * mounted prefix is prepended when one exists; `''` (root-mounted owner like
 * the gateway) strips the target origin and keeps the path verbatim. */
export function convergeLocation(value: string, target: URL, responseBasePath: string | undefined): string {
  if (responseBasePath === undefined) return value
  let resolved: URL
  try {
    resolved = new URL(value, target)
  } catch {
    return value
  }
  if (resolved.origin !== target.origin) return value
  return `${responseBasePath}${resolved.pathname}${resolved.search}${resolved.hash}`
}

function mergeVary(headers: Record<string, string | string[]>, corsHeaders: Record<string, string>): void {
  const values = [headers.vary, corsHeaders.vary]
    .flatMap(value => Array.isArray(value) ? value : value === undefined ? [] : [value])
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean)
  if (values.length === 0) return
  const seen = new Set<string>()
  headers.vary = values.filter(value => {
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).join(', ')
  delete corsHeaders.vary
}

/** Write a JSON error in the unified shape ({error, code}). */
export function writeError(res: ProxyResponse, status: number, code: string, message: string, logger: Logger): void {
  const body = JSON.stringify({ error: message, code })
  try {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      connection: 'close',
      ...(res._corsHeaders ?? {}),
    })
    res.end(body)
  } catch (writeError) {
    logger.warn(`proxy-forward: failed to write error ${status}: ${String(writeError)}`)
  }
}

/** Write a JSON error on an upgrade socket (rejections are explicit). */
export function rejectUpgrade(socket: ProxySocket, status: number, code: string, message: string, logger: Logger): void {
  const body = JSON.stringify({ error: message, code })
  const head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n`
  try {
    // The client may have already gone (app exit, page reload): an 'error'
    // on this socket must be consumed, never an uncaught exception.
    socket.on('error', () => {})
    socket.write(head + body)
    socket.end()
  } catch (writeError) {
    logger.warn(`proxy-forward: failed to write upgrade rejection ${status}: ${String(writeError)}`)
  }
}

/**
 * One-shot upstream silence guard (design 03 §3.3): fires the callback when
 * the upstream produced no socket activity for upstreamTimeoutMs. Covers
 * "headers never arrive" and (re-armed after headers) "body idles" for
 * non-SSE responses; SSE/WebSocket streams never re-arm it, so their
 * lifetime is unbounded. The returned clear is idempotent and must be
 * called on response/error/end.
 */
export function armUpstreamTimeout(deps: ProxyForwardDeps, counters: ProxyForwardCounters, logger: Logger, onTimeout: () => void): () => void {
  const { id, logPrefix, upstreamTimeoutMs } = deps
  let handle: ReturnType<typeof setTimeout> | null = null
  let fired = false
  handle = setTimeout(() => {
    if (fired) return
    fired = true
    counters.failures += 1
    logger.log(`${logPrefix}: upstream ${id} request timed out (${upstreamTimeoutMs}ms)`)
    onTimeout()
  }, upstreamTimeoutMs)
  return () => {
    if (handle !== null) {
      clearTimeout(handle)
      handle = null
    }
  }
}

/** Forward an HTTP request to a fully-resolved target (method/body/query kept).
 * `extraHeaders` are the per-transport injected headers (already whitelisted
 * by registerTransport); `tls` carries the optional gateway SPKI pin (S23) —
 * when set and the target is https, the pin gates the connection (see
 * attachSpkiPinVerifier); a mismatch surfaces as an upstream 'error' → the
 * caller's explicit 502 upstream_failed. */
export async function forwardHttp(req: ProxyRequest, res: ProxyResponse, target: URL, releaseRequest: () => void, logger: Logger, counters: ProxyForwardCounters, deps: ProxyForwardDeps, extraHeaders?: Record<string, string>, tls?: { spkiPin?: string }, authority?: string): Promise<void> {
  // Select the http/https request by target protocol (design 17 §6: the
  // gateway transport target is `https://`, which node:http cannot send).
  const request = deps.httpRequest ?? (target.protocol === 'https:' ? httpsRequest : httpRequest)
  const method = typeof req.method === 'string' && req.method !== '' ? req.method : 'GET'
  const rawLength = Array.isArray(req.headers['content-length']) ? req.headers['content-length'][0] : req.headers['content-length']
  const declared = rawLength === undefined ? NaN : Number(rawLength)
  const methodUsuallyHasNoBody = method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD'
  // GET and HEAD do not normally carry a request body, but RFC framing still
  // permits one. Once the client declares positive Content-Length or a
  // Transfer-Encoding, silently discarding those bytes changes the request
  // and can desynchronise application-level signatures. Keep the cheap
  // no-body path only for genuinely unframed GET/HEAD requests.
  const hasBody = !methodUsuallyHasNoBody
    || (Number.isFinite(declared) && declared > 0)
    || req.headers['transfer-encoding'] !== undefined
  let body: Buffer | null = null
  let bodyReservation = 0
  let bodyReservationReleased = false
  const releaseBodyReservation = (): void => {
    if (bodyReservationReleased) return
    bodyReservationReleased = true
    counters.bufferedRequestBytes = Math.max(0, counters.bufferedRequestBytes - bodyReservation)
    processBufferedRequestBytes = Math.max(0, processBufferedRequestBytes - bodyReservation)
  }
  if (hasBody) {
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
      counters.failures += 1
      releaseRequest()
      writeError(res, 413, 'body_too_large', 'request body exceeds the 300MiB cap', logger)
      return
    }
    // Unknown/chunked bodies reserve the full per-request cap. A valid
    // Content-Length reserves its exact byte count; Node's parser enforces
    // that framing, so a caller cannot smuggle additional body bytes.
    const hasDeclaredLength = Number.isFinite(declared) && declared >= 0
    const readCap = hasDeclaredLength ? MAX_REQUEST_BODY_BYTES : MAX_UNDECLARED_REQUEST_BODY_BYTES
    const reservation = hasDeclaredLength ? declared : MAX_UNDECLARED_REQUEST_BODY_BYTES
    if (counters.bufferedRequestBytes + reservation > deps.maxBufferedRequestBytes
      || processBufferedRequestBytes + reservation > MAX_BUFFERED_REQUEST_BYTES) {
      counters.failures += 1
      releaseRequest()
      writeError(res, 503, 'resource_exhausted', 'proxy request-body budget is exhausted', logger)
      return
    }
    bodyReservation = reservation
    counters.bufferedRequestBytes += bodyReservation
    processBufferedRequestBytes += bodyReservation
    try {
      body = await readBody(req, readCap, deps.clientBodyIdleTimeoutMs, hasDeclaredLength ? declared : undefined)
    } catch (bodyError) {
      releaseBodyReservation()
      counters.failures += 1
      releaseRequest()
      const code = (bodyError as Error & { code?: string }).code
      if (code === 'request_timeout') {
        writeError(res, 408, 'request_timeout', 'request body upload timed out', logger)
      } else {
        const capMiB = Math.floor(readCap / (1024 * 1024))
        writeError(res, 413, 'body_too_large', `request body exceeds the ${capMiB}MiB cap`, logger)
      }
      return
    }
    // Unknown/chunked bodies conservatively reserve the full cap while they
    // are being read. Once complete, retain only the bytes that are actually
    // still buffered — and keep that reservation until the upstream request
    // emits `finish`/`close`/`error`.
    if (body.length < bodyReservation) {
      counters.bufferedRequestBytes -= bodyReservation - body.length
      processBufferedRequestBytes -= bodyReservation - body.length
      bodyReservation = body.length
    }
  }
  // The upstream Host is the target's own authority by default (design 17
  // §8); an ssh-tunneled gateway target overrides it with the REMOTE gateway
  // authority (design 17 §9.3 隧道 Host 覆盖 — the gateway's request policy
  // requires the Host port to equal its listen port, and the tunnel's
  // loopback URL can never satisfy that). The Origin rewrite below uses the
  // SAME effective authority so the browser trust fence sees a consistent
  // same-origin shape.
  const effectiveHost = authority ?? target.host
  const headers: Record<string, string> = { host: effectiveHost }
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue
    if (value === undefined) continue
    // Same-origin proxy honesty (design 03 §3.1): the browser's page origin
    // is the CONTROL PLANE (127.0.0.1:17500), but the instance's browser
    // trust fence (dsh-client-connection node half) requires any attached
    // Origin to equal the request's Host authority — it compares
    // `new URL(origin).host === host` regardless of --trusted-host. Rewrite
    // the origin to the upstream's own authority so the fence sees exactly
    // the same-origin shape it accepts in the official deployment (page and
    // api on one host). Requests without an origin header are untouched.
    if (lower === 'origin') {
      headers[name] = `${target.protocol}//${effectiveHost}`
      continue
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  // Per-transport extra headers (design 17 §9.3: the gateway's bounded
  // Authorization and/or dsh_gateway_session Cookie) are injected AFTER the
  // strip + Origin rewrite so they are never mistaken for a browser header
  // and never stripped. registerTransport already validated the whitelist;
  // this filter is defense-in-depth: only the two sanctioned names ever ride
  // upstream.
  if (extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      const lower = name.toLowerCase()
      if (lower !== 'authorization' && lower !== 'cookie') continue
      headers[lower] = value
    }
  }
  // Forward the bytes we actually accepted, never an untrusted client
  // declaration. This also normalizes chunked uploads into a bounded body.
  if (body !== null) headers['content-length'] = String(body.length)
  const controller = new AbortController()
  let responseEnded = false
  let clearTimeoutGuards = (): void => {}
  let stopBodySource = (): void => releaseBodyReservation()
  const cleanupClientListeners = (): void => {
    req.removeListener('aborted', onClientClose)
    res.removeListener('close', onClientClose)
  }
  const onClientClose = () => {
    if (responseEnded) return
    cleanupClientListeners()
    clearTimeoutGuards()
    stopBodySource()
    controller.abort()
    releaseRequest()
  }
  // IncomingMessage `close` means "request parsing completed" on modern
  // Node, not necessarily that the peer disappeared. Abort only on the
  // explicit request `aborted` signal or an unfinished ServerResponse close.
  req.on('aborted', onClientClose)
  res.on('close', onClientClose)
  const timeoutAbort = (): void => {
    cleanupClientListeners()
    stopBodySource()
    controller.abort()
    releaseRequest()
    if (!res.headersSent) writeError(res, 504, 'upstream_timeout', 'upstream request timed out', logger)
    else res.destroy()
  }
  // Headers must arrive within upstreamTimeoutMs; a non-SSE body must not
  // idle longer than that either (re-armed after headers arrive). SSE and
  // upgraded WebSockets never re-arm — long-lived by nature.
  let clearUpstreamTimeout = armUpstreamTimeout(deps, counters, logger, timeoutAbort)
  clearTimeoutGuards = (): void => {
    clearUpstreamTimeout()
    clearUpstreamTimeout = () => {}
  }
  const source = body === null ? null : bodySource([body])
  // S23: a pinned gateway target opens a FRESH https connection with the pin
  // as its trust anchor (rejectUnauthorized: false — the internal-CA case,
  // the pin alone decides trust); the socket verifier destroys the request on
  // mismatch. http targets never pin (registerTransport refuses http + pin,
  // and the https guard here is defense-in-depth).
  const tlsSpkiPin = target.protocol === 'https:' ? tls?.spkiPin : undefined
  let upstream: ClientRequest
  try {
    upstream = request(target, {
      method,
      headers,
      signal: controller.signal,
      ...(tlsSpkiPin === undefined ? {} : { rejectUnauthorized: false, agent: false }),
    })
  } catch (error) {
    cleanupClientListeners()
    clearTimeoutGuards()
    releaseBodyReservation()
    throw error
  }
  stopBodySource = (): void => {
    source?.stop(upstream)
    releaseBodyReservation()
  }
  // `finish` means all accepted request bytes have left ClientRequest's
  // writable queue. Until then the body remains charged against the process
  // budget, including while waiting for `drain`.
  upstream.once('finish', stopBodySource)
  upstream.once('close', stopBodySource)
  upstream.on('error', upstreamError => {
    stopBodySource()
    clearTimeoutGuards()
    cleanupClientListeners()
    const abort = (upstreamError as Error & { name?: string }).name === 'AbortError' || controller.signal.aborted
    releaseRequest()
    if (abort) return
    counters.failures += 1
    logger.log(`${deps.logPrefix}: upstream ${deps.id} request failed: ${String(upstreamError)}`)
    if (!res.headersSent) {
      writeError(res, 502, 'upstream_failed', 'upstream request failed', logger)
    } else {
      res.destroy()
    }
  })
  upstream.on('response', upstreamRes => {
    clearTimeoutGuards()
    const contentType = String(upstreamRes.headers['content-type'] ?? '')
    const isSse = contentType.startsWith('text/event-stream')
    const declaredLength = upstreamRes.headers['content-length']
    const declaredBytes = typeof declaredLength === 'string' ? Number(declaredLength) : NaN
    if (!isSse && Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BODY_BYTES) {
      upstreamRes.destroy()
      stopBodySource()
      cleanupClientListeners()
      releaseRequest()
      counters.failures += 1
      writeError(res, 413, 'body_too_large', 'upstream response exceeds the 300MiB cap', logger)
      return
    }
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      const lower = name.toLowerCase()
      if (!RESPONSE_HEADER_WHITELIST.has(lower)) continue
      if (lower === 'location') {
        if (Array.isArray(value)) {
          headers[name] = value.map(entry => convergeLocation(entry, target, deps.responseBasePath))
        } else if (typeof value === 'string') {
          headers[name] = convergeLocation(value, target, deps.responseBasePath)
        }
        continue
      }
      headers[name] = value as string | string[]
    }
    if (!isSse && Number.isFinite(declaredBytes)) headers['content-length'] = String(declaredBytes)
    const corsHeaders = { ...(res._corsHeaders ?? {}) }
    mergeVary(headers, corsHeaders)
    const responseHeaders = { ...headers, ...corsHeaders }
    const responseStatus = upstreamRes.statusCode ?? 502
    // HTML trust-injection seam (S0, gateway html-inject.ts): when the owner
    // configured an injector, a small unencoded text/html response is
    // buffered whole so the document can be rewritten before it reaches the
    // browser. writeHead is deferred for that case — Node's ServerResponse
    // rejects setHeader() after writeHead() (ERR_HTTP_HEADERS_SENT), so an
    // injected content-length can only go out with the final headers. Every
    // other response (and every response when no injector is configured —
    // the control-plane default) keeps the immediate passthrough writeHead
    // below, byte for byte. SSE never enters this path.
    const injectHtmlDocument = deps.injectHtmlDocument
    const contentEncoding = upstreamRes.headers['content-encoding']
    const htmlInjectable = injectHtmlDocument !== undefined && !isSse
      && contentType.startsWith('text/html')
      && (contentEncoding === undefined || String(contentEncoding).toLowerCase() === 'identity')
      && (!Number.isFinite(declaredBytes) || declaredBytes <= MAX_HTML_INJECTION_BYTES)
    if (!htmlInjectable) res.writeHead(responseStatus, responseHeaders)
    // Headers are out (or held back only for a small htmlInjectable body): a
    // stalled non-SSE body gets the same explicit teardown (headersSent=true
    // → destroy, the browser sees the stream cut).
    if (!isSse) clearUpstreamTimeout = armUpstreamTimeout(deps, counters, logger, timeoutAbort)
    let received = 0
    // Buffered htmlInjectable body ([] = still accumulating, null = flushed
    // or never eligible). The buffer is capped at MAX_HTML_INJECTION_BYTES;
    // exceeding it falls back to the byte-exact streaming passthrough.
    let htmlChunks: Buffer[] | null = htmlInjectable ? [] : null
    let htmlBytes = 0
    let htmlHeadSent = !htmlInjectable
    const sendHtmlHead = (): void => {
      if (htmlHeadSent) return
      htmlHeadSent = true
      res.writeHead(responseStatus, responseHeaders)
    }
    const writeChunk = (chunk: Buffer): void => {
      if (!res.write(chunk)) {
        upstreamRes.pause()
        void waitForDrain(res).then(() => upstreamRes.resume())
      }
    }
    upstreamRes.on('data', (chunk: Buffer) => {
      // This is an IDLE timeout, not a total-duration deadline. Every body
      // chunk proves progress and starts a fresh idle window.
      if (!isSse) {
        clearUpstreamTimeout()
        clearUpstreamTimeout = armUpstreamTimeout(deps, counters, logger, timeoutAbort)
      }
      received += chunk.length
      if (!isSse && received > MAX_RESPONSE_BODY_BYTES) {
        // Explicit overflow: abort the upstream stream, never a silent
        // truncation (design 03 §3.4).
        upstreamRes.destroy()
        stopBodySource()
        cleanupClientListeners()
        controller.abort()
        releaseRequest()
        counters.failures += 1
        if (!res.headersSent) writeError(res, 413, 'body_too_large', 'upstream response exceeds the 300MiB cap', logger)
        else res.destroy()
        return
      }
      if (htmlChunks !== null) {
        if (htmlBytes + chunk.length <= MAX_HTML_INJECTION_BYTES) {
          htmlChunks.push(chunk)
          htmlBytes += chunk.length
          return
        }
        // Over budget: the document cannot be rewritten. Send the headers
        // with the upstream content-length — every byte below is forwarded
        // unchanged, so the declared length stays truthful — and fall back
        // to the plain streaming passthrough for the buffered + remaining
        // bytes.
        sendHtmlHead()
        for (const buffered of htmlChunks) res.write(buffered)
        htmlChunks = null
        htmlBytes = 0
      }
      writeChunk(chunk)
    })
    upstreamRes.on('error', () => {
      clearTimeoutGuards()
      stopBodySource()
      cleanupClientListeners()
      releaseRequest()
      counters.failures += 1
      res.destroy()
    })
    // A client that closed its connection mid-stream (app exit) turns
    // res.write into writeAfterFIN — the resulting EPIPE 'error' must be
    // consumed, and the upstream aborted instead of kept streaming into
    // a dead response (same teardown family as the upgrade splice).
    res.on('error', onClientClose)
    upstreamRes.on('end', () => {
      clearTimeoutGuards()
      stopBodySource()
      releaseRequest()
      responseEnded = true
      cleanupClientListeners()
      if (htmlChunks === null) {
        res.end()
        return
      }
      // The whole small htmlInjectable document is buffered: hand it to the
      // owner's injector, then emit the final headers + body in one
      // writeHead/end pair so content-length matches what is actually sent.
      const buffered = htmlChunks
      htmlChunks = null
      const html = Buffer.concat(buffered, htmlBytes).toString('utf8')
      let injected: string | null = null
      if (injectHtmlDocument !== undefined) {
        try {
          injected = injectHtmlDocument(html)
        } catch (injectError) {
          // Fail-soft: an injector throwing must never break the request
          // (this runs inside an event listener — an uncaught throw would
          // crash the process). The original document is forwarded instead.
          logger.warn(`${deps.logPrefix}: html document injection failed: ${String(injectError)}`)
        }
      }
      if (injected !== null) {
        // The declaration is pure ASCII, but the document may not be: use
        // the byte length for the rewritten content-length.
        if (Number.isFinite(declaredBytes)) responseHeaders['content-length'] = String(Buffer.byteLength(injected))
        sendHtmlHead()
        res.end(injected)
        return
      }
      sendHtmlHead()
      for (const bufferedChunk of buffered) res.write(bufferedChunk)
      res.end()
    })
  })
  // A pinned request must remain completely undispatched until secureConnect
  // proves the peer key. Constructing ClientRequest starts the TLS handshake,
  // but headers/body are not queued until write()/end(); keeping both calls
  // exclusively behind this gate therefore prevents Authorization, Cookie,
  // request headers and business bytes from reaching a mismatched peer.
  let requestDispatched = false
  const dispatchRequest = (): void => {
    if (requestDispatched || controller.signal.aborted || upstream.destroyed) return
    requestDispatched = true
    try {
      source?.send(upstream)
      if (source === null) upstream.end()
    } catch (error) {
      // A pinned dispatch runs asynchronously from secureConnect, outside the
      // forwardHttp setup try/catch. Route synchronous write failures through
      // the ordinary ClientRequest error path so cleanup/release and the loud
      // 502 response still happen exactly once.
      upstream.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  }
  if (tlsSpkiPin !== undefined) attachSpkiPinVerifier(upstream, tlsSpkiPin, dispatchRequest)
  else dispatchRequest()
}

/** Forward a WS upgrade to a fully-resolved target (the /api/remote.mux
 * stream mux; the old events.mux / events.host downlinks were deleted
 * upstream in dsh 0.1.2-alpha.1).
 * `tls` carries the optional gateway SPKI pin (S23) — when set and the target
 * is https, the pin gates the handshake connection exactly like forwardHttp;
 * a mismatch surfaces as an upstream 'error' → 502 upstream_failed. */
export async function forwardUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer, target: URL, releaseHandshake: () => void, logger: Logger, counters: ProxyForwardCounters, deps: ProxyForwardDeps, extraHeaders?: Record<string, string>, tls?: { spkiPin?: string }, authority?: string): Promise<void> {
  const request = deps.httpRequest ?? (target.protocol === 'https:' ? httpsRequest : httpRequest)
  // The upstream request stays on http(s) — node's http.request performs
  // the upgrade handshake internally (it never accepts a ws: URL).
  const headers: Record<string, string> = { host: authority ?? target.host }
  const take = new Set(['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'])
  for (const [name, value] of Object.entries(req.headers)) {
    if (!take.has(name.toLowerCase())) continue
    if (value === undefined) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  // Per-transport extra headers (design 17 §9.3: Authorization and/or
  // dsh_gateway_session Cookie) ride the upgrade handshake too — the
  // gateway's WS auth == HTTP auth (S2).
  if (extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      const lower = name.toLowerCase()
      if (lower !== 'authorization' && lower !== 'cookie') continue
      headers[lower] = value
    }
  }
  const controller = new AbortController()
  const onClientClose = () => {
    controller.abort()
    releaseHandshake()
  }
  // The downstream socket, not IncomingMessage `close`, owns upgrade
  // handshake liveness (the latter may merely mean the HTTP headers parsed).
  socket.on('close', onClientClose)
  // The upgrade handshake must complete within upstreamTimeoutMs; once the
  // upstream answers 101 the socket is spliced and the timeout is cleared
  // (a live WebSocket is long-lived by nature).
  const clearUpgradeTimeout = armUpstreamTimeout(deps, counters, logger, () => {
    controller.abort()
    releaseHandshake()
    rejectUpgrade(socket, 504, 'upstream_timeout', 'upstream WebSocket upgrade timed out', logger)
  })
  // S23: pinned gateway targets gate the handshake connection (see forwardHttp).
  const tlsSpkiPin = target.protocol === 'https:' ? tls?.spkiPin : undefined
  const upstream = request(target, {
    method: 'GET',
    headers,
    signal: controller.signal,
    ...(tlsSpkiPin === undefined ? {} : { rejectUnauthorized: false, agent: false }),
  })
  let requestDispatched = false
  const dispatchRequest = (): void => {
    if (requestDispatched || controller.signal.aborted || upstream.destroyed) return
    requestDispatched = true
    try {
      upstream.end()
    } catch (error) {
      // Pinned dispatch occurs from secureConnect; preserve the ordinary
      // upstream error/rejection path instead of throwing from an event
      // listener into the process.
      upstream.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  }
  upstream.on('error', upstreamError => {
    clearUpgradeTimeout()
    releaseHandshake()
    socket.removeListener('close', onClientClose)
    const abort = (upstreamError as Error & { name?: string }).name === 'AbortError' || controller.signal.aborted
    if (abort) return
    counters.failures += 1
    logger.log(`${deps.logPrefix}: upstream ${deps.id} upgrade failed: ${String(upstreamError)}`)
    // An upstream connect refusal is upstream_failed (502, design 04 §4.2) —
    // the same code the HTTP path uses; 503 stays reserved for "no tunnel /
    // not ready". Regression locked by instance-proxy.ts.
    rejectUpgrade(socket, 502, 'upstream_failed', 'upstream WebSocket unavailable', logger)
  })
  // A non-101 upstream reply (the instance 404s an unknown WS path, its
  // connection plugin is not mounted, an old dsh version, …): the upgrade
  // request must never be left with an unread, unlistened stream — a late
  // RST on that connection is an unhandled socket 'error' (uncaught
  // ECONNRESET in the main process). Drain-and-destroy the reply and
  // reject the client upgrade explicitly instead.
  upstream.on('response', (upstreamRes: IncomingMessage) => {
    clearUpgradeTimeout()
    releaseHandshake()
    counters.failures += 1
    logger.log(`${deps.logPrefix}: upstream ${deps.id} upgrade answered non-101 (${upstreamRes.statusCode ?? '?'}); rejecting`)
    upstreamRes.on('error', () => {})
    upstreamRes.destroy()
    socket.removeListener('close', onClientClose)
    rejectUpgrade(socket, 502, 'upstream_failed', 'upstream WebSocket answered non-101', logger)
  })
  upstream.on('upgrade', (upstreamRes: IncomingMessage, upstreamSocket: Duplex, upstreamHead: Buffer) => {
    clearUpgradeTimeout()
    releaseHandshake()
    socket.removeListener('close', onClientClose)
    counters.activeStreams += 1
    const stream: ProxyLiveStream = {
      downstream: socket,
      upstream: upstreamSocket,
      ...(deps.streamOwner === undefined ? {} : { ownerId: deps.streamOwner }),
    }
    deps.liveStreams.add(stream)
    let tornDown = false
    // chamber patch (design 14 extension): the spliced downlinks are
    // downlink-only WebSockets with no heartbeat from either side — a
    // silently dead (half-open) BROWSER leg after an OS sleep/wake fires no
    // 'error'/'close', so without this the splice would hold forever while
    // the browser's pump stays blind (stuck "Deep diving..." UI, backend
    // still processing). The heartbeat pings the browser; missed pongs tear
    // the splice down so the browser's WebSocket closes and the renderer
    // pump reconnects. Declared before tearDown (which stops it); started
    // once the splice is wired.
    let heartbeat: { stop(): void } | null = null
    const tearDown = () => {
      if (tornDown) return
      tornDown = true
      counters.activeStreams = Math.max(0, counters.activeStreams - 1)
      deps.liveStreams.delete(stream)
      heartbeat?.stop()
      try {
        upstreamSocket.destroy()
      } catch { /* already gone */ }
      try {
        socket.destroy()
      } catch { /* already gone */ }
    }
    // Error/close listeners on BOTH ends, attached before any write: on
    // app exit the browser and the dsh host are torn down at once, so one
    // pipe can push into a socket that already received the peer's FIN —
    // node flips write to writeAfterFIN, which destroys with an EPIPE
    // "ended by the other party" 'error'. Without a listener on that end
    // the error becomes an uncaught exception. Either end failing or
    // closing tears both down exactly once.
    socket.on('error', tearDown)
    upstreamSocket.on('error', tearDown)
    socket.on('close', tearDown)
    upstreamSocket.on('close', tearDown)
    const wireHeaders: string[] = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} Switching Protocols`]
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (!WS_RESPONSE_HEADER_WHITELIST.has(name.toLowerCase())) continue
      if (value === undefined) continue
      const values = Array.isArray(value) ? value : [value]
      for (const entry of values) wireHeaders.push(`${name}: ${entry}`)
    }
    socket.write(wireHeaders.join('\r\n') + '\r\n\r\n')
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    // Client head bytes (pre-sent frame data, RFC 6455 pipelining) flow to
    // the upstream socket only after the upstream accepted the upgrade.
    if (head.length > 0) upstreamSocket.write(head)
    // chamber patch (S2): OS-level TCP keepalive for the upstream leg of a
    // direct-http target, armed before the splice. Only owners that opted in
    // (instance-proxy passes tcpKeepAliveMs for NON-loopback resolved targets
    // — direct http(s), whatever the source-id kind) hit
    // this: ssh tunnels already have ssh keepalive covering the leg, so the
    // local/ssh splices keep the documented no-heartbeat design (see the
    // WS_PING_* comment above) — a direct http(s) leg has no such coverage
    // and would otherwise freeze silently on a half-open connection.
    if (deps.tcpKeepAliveMs !== undefined) {
      // The upgrade socket is a net.Socket at runtime (node:http types it as
      // Duplex); setKeepAlive is the net.Socket surface used here.
      ;(upstreamSocket as Socket).setKeepAlive(true, deps.tcpKeepAliveMs)
    }
    // Socket splice: downstream ↔ upstream; either closing tears both.
    upstreamSocket.pipe(socket as never)
    socket.pipe(upstreamSocket as never)
    // Start the liveness heartbeat after the splice is wired (design 14
    // extension; see the tearDown note above). Downstream-only: the
    // upstream leg's liveness belongs to SSH keepalive / socket events.
    heartbeat = startWsHeartbeat({
      downstream: socket,
      intervalMs: deps.wsPingIntervalMs,
      missesBeforeTeardown: deps.wsPingMissesBeforeTeardown,
      onDead: () => {
        logger.log(`${deps.logPrefix}: WebSocket stream ${deps.id} heartbeat lost (no browser pong for ${deps.wsPingMissesBeforeTeardown} cycle(s)); tearing down`)
        tearDown()
      },
    })
  })
  if (tlsSpkiPin !== undefined) attachSpkiPinVerifier(upstream, tlsSpkiPin, dispatchRequest)
  else dispatchRequest()
}
