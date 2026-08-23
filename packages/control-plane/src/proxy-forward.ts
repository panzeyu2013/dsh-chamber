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
import type { Duplex } from 'node:stream'
import type { Logger } from './types.ts'
import { startWsHeartbeat } from './ws-heartbeat.ts'

/** Request body cap (design 03 §3.4, same as the v2 runtime proxy; aligned with the upstream dsh 0.1.1-rc.2 300MiB request cap / 200MiB image admission). */
export const MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024

/** Response body cap for non-SSE responses (design 03 §3.4; aligned with the upstream dsh 0.1.1-rc.2 300MiB request cap / 200MiB image admission). */
export const MAX_RESPONSE_BODY_BYTES = 300 * 1024 * 1024

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
 * fix): ping cadence for the spliced event downlinks. The events streams are
 * downlink-only with no heartbeat from either side, so the BROWSER leg of the
 * splice can silently die (half-open TCP after an OS sleep/wake) without any
 * 'error'/'close' firing — the splice would hold forever while the browser's
 * pump stays "connected" but blind. The proxy pings the browser; after
 * `WS_PING_MISSES_BEFORE_TEARDOWN` cycles without a pong, the splice is torn
 * down so the browser's WebSocket closes and the renderer pump reconnects
 * (fresh stream → host baseline replay → UI re-sync).
 *
 * Values follow the canonical `ws` README heartbeat example (30s interval,
 * one unanswered ping cycle → terminate): the pong round-trip is loopback, so
 * a full cycle without one is a real death, not scheduler noise.
 *
 * The UPSTREAM (host) leg deliberately has no heartbeat: its death is covered
 * by SSH keepalive for remote tunnels (`ServerAliveInterval=30 × CountMax=3`
 * ≈ 90s, ssh-provider), socket 'error'/'close' for local host death/restart,
 * and the host's own send-failure close. A proxy-side upstream ping would
 * only race SSH keepalive into a reconnect flap against a half-open tunnel
 * (strict tolerance) or fire later than it (lenient tolerance — useless).
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

/** WS downlink paths forwarded to the instance (03 §3.1 / 05 §3.1). */
export const WS_STREAM_PATHS = new Set(['/api/events.mux', '/api/events.host'])

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

/** Forward an HTTP request to a fully-resolved target (method/body/query kept). */
export async function forwardHttp(req: ProxyRequest, res: ProxyResponse, target: URL, releaseRequest: () => void, logger: Logger, counters: ProxyForwardCounters, deps: ProxyForwardDeps, extraHeaders?: Record<string, string>): Promise<void> {
  // Select the http/https request by target protocol (design 17 §6.4: the
  // gateway transport target is `https://`, which node:http cannot send).
  const request = deps.httpRequest ?? (target.protocol === 'https:' ? httpsRequest : httpRequest)
  const method = typeof req.method === 'string' && req.method !== '' ? req.method : 'GET'
  const hasBody = !(method === 'GET' || method === 'HEAD')
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
    const rawLength = Array.isArray(req.headers['content-length']) ? req.headers['content-length'][0] : req.headers['content-length']
    const declared = rawLength === undefined ? NaN : Number(rawLength)
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
  const headers: Record<string, string> = { host: target.host }
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
      headers[name] = `${target.protocol}//${target.host}`
      continue
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  // Per-transport extra headers (design 17 §6.4: the gateway's Authorization)
  // are injected AFTER the strip + Origin rewrite so they are never mistaken
  // for a browser header and never stripped.
  if (extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      const lower = name.toLowerCase()
      // Defense-in-depth behind registerTransport(): the sole sanctioned
      // injected header is the gateway bearer credential.
      if (lower !== 'authorization') continue
      headers.authorization = value
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
  let upstream: ClientRequest
  try {
    upstream = request(target, {
      method,
      headers,
      signal: controller.signal,
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
    res.writeHead(upstreamRes.statusCode ?? 502, { ...headers, ...corsHeaders })
    // Headers are out: a stalled non-SSE body gets the same explicit
    // teardown (headersSent=true → destroy, the browser sees the stream cut).
    if (!isSse) clearUpstreamTimeout = armUpstreamTimeout(deps, counters, logger, timeoutAbort)
    let received = 0
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
      if (!res.write(chunk)) {
        upstreamRes.pause()
        void waitForDrain(res).then(() => upstreamRes.resume())
      }
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
      res.end()
    })
  })
  try {
    source?.send(upstream)
    if (source === null) upstream.end()
  } catch (error) {
    stopBodySource()
    clearTimeoutGuards()
    cleanupClientListeners()
    controller.abort()
    throw error
  }
}

/** Forward a WS upgrade to a fully-resolved target (events.mux / events.host). */
export async function forwardUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer, target: URL, releaseHandshake: () => void, logger: Logger, counters: ProxyForwardCounters, deps: ProxyForwardDeps, extraHeaders?: Record<string, string>): Promise<void> {
  const request = deps.httpRequest ?? (target.protocol === 'https:' ? httpsRequest : httpRequest)
  // The upstream request stays on http(s) — node's http.request performs
  // the upgrade handshake internally (it never accepts a ws: URL).
  const headers: Record<string, string> = { host: target.host }
  const take = new Set(['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'])
  for (const [name, value] of Object.entries(req.headers)) {
    if (!take.has(name.toLowerCase())) continue
    if (value === undefined) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  // Per-transport extra headers (design 17 §6.4: Authorization) ride the
  // upgrade handshake too — the gateway's WS auth == HTTP auth (S2).
  if (extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      const lower = name.toLowerCase()
      if (lower !== 'authorization') continue
      headers.authorization = value
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
  const upstream = request(target, {
    method: 'GET',
    headers,
    signal: controller.signal,
  })
  upstream.on('error', upstreamError => {
    clearUpgradeTimeout()
    releaseHandshake()
    socket.removeListener('close', onClientClose)
    const abort = (upstreamError as Error & { name?: string }).name === 'AbortError' || controller.signal.aborted
    if (abort) return
    counters.failures += 1
    logger.log(`${deps.logPrefix}: upstream ${deps.id} upgrade failed: ${String(upstreamError)}`)
    rejectUpgrade(socket, 503, 'instance_unavailable', 'upstream WebSocket unavailable', logger)
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
  upstream.end()
}
