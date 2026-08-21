/**
 * Per-instance generic reverse proxy (/api/i/<id>/*, design 03 §3 / 04 §4).
 *
 * The single same-origin entry point for every dsh instance the frontend
 * reaches (05 §1): HTTP passthrough (any method, no whitelist), WS upgrade
 * (events.mux / events.host downlinks) and SSE passthrough. Path mapping:
 *
 *   /api/i/local/*       → the managed local web profile (baseUrl derived
 *                          from the local connection's dshPort)
 *   /api/i/ssh-<id>/*    → the tunnel registered by the desktop main process
 *                          (registerInstanceTransport with connectionId
 *                          `ssh:<id>`, design 05 §3.3)
 *
 * Prefix stripping: the /api/i/<id> prefix is removed and the remaining path
 * is forwarded verbatim — the instance anchors everything under its /api
 * root (dsh's connection node half registers the whole route tree at
 * API_PATH '/api'). The Host header is kept as the instance's own
 * 127.0.0.1:<port> so the instance's --trusted-host fence admits the request
 * (02 §2.1); the login cookie and Authorization are never forwarded.
 *
 * v1 has no authentication boundary: /api/i/* is directly reachable, HTTP
 * and WS upgrade alike, with no session required.
 *
 * Failures are loud and explicit (04 §4.2): unknown id → 404
 * instance_not_found; no tunnel / instance not ready → 503
 * instance_unavailable; upstream connect/timeout → 502/504 upstream_failed
 * (masked, never echoing the upstream host:port); body over 50MiB / response
 * over 100MiB → 413 body_too_large (+ upstream abort).
 *
 * Response headers are converged to a whitelist (03 §3.4): content-type,
 * cache-control, x-next-cursor, x-ratelimit-*; nothing else rides through
 * (hop-by-hop and potential credential surfaces stay server-side).
 *
 * Diagnostics: plain counters (requests / failures / activeStreams) — no
 * sensitive data, no URLs.
 */

import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from './types.ts'
import { startWsHeartbeat } from './ws-heartbeat.ts'

/** Request body cap (design 03 §3.4, same as the v2 runtime proxy). */
export const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024

/** Response body cap for non-SSE responses (design 03 §3.4). */
export const MAX_RESPONSE_BODY_BYTES = 100 * 1024 * 1024

/** Process-wide budgets: bound memory, sockets and pending handshakes. */
export const MAX_BUFFERED_REQUEST_BYTES = 100 * 1024 * 1024
export const MAX_CONCURRENT_HTTP_REQUESTS = 64
export const MAX_CONCURRENT_WS_STREAMS = 64
export const MAX_PENDING_WS_HANDSHAKES = 16

/**
 * Upstream timeout (design 03 §3.3: "上游连接拒绝 / 超时 → 502 / 504"):
 * how long an upstream may take to answer headers, and — for non-SSE
 * responses — how long its body may idle before the proxy gives up with an
 * explicit 504 (upstream_timeout). SSE streams and upgraded WebSockets are
 * long-lived by nature: the timeout only covers reaching the response/101,
 * never the stream lifetime. A hung upstream can no longer stall the request
 * indefinitely.
 */
export const UPSTREAM_TIMEOUT_MS = 10_000

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
  'cache-control',
  'x-next-cursor',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
])

/** WS downlink paths forwarded to the instance (03 §3.1 / 05 §3.1). */
export const WS_STREAM_PATHS = new Set(['/api/events.mux', '/api/events.host'])

/** Hop-by-hop and credential headers never forwarded upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
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
])

/** Only headers required to complete a WebSocket 101 may cross downstream. */
const WS_RESPONSE_HEADER_WHITELIST = new Set([
  'upgrade',
  'connection',
  'sec-websocket-accept',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
])

const STATUS_TEXT: Record<number, string> = {
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

/** A parsed /api/i/<id> path. */
export interface InstancePath {
  id: string
  rest: string
  search: string
}

/** Instance-proxy diagnostics (plain counters, no sensitive data). */
export interface InstanceProxyDiagnostics {
  requests: number
  failures: number
  activeStreams: number
  activeHttpRequests: number
  pendingUpgrades: number
  bufferedRequestBytes: number
  transports: number
}

/** createInstanceProxy deps. */
export interface InstanceProxyDeps {
  logger: Logger
  /** The managed local instance state ('ready' when serviceable). */
  getLocalState(): string
  /** The managed local instance port (null when not ready). */
  getLocalDshPort(): number | null
  /** Injectable outbound request factory (defaults to node:http request). */
  httpRequest?: typeof httpRequest
  /** Upstream timeout in ms (default UPSTREAM_TIMEOUT_MS; tests inject small values). */
  upstreamTimeoutMs?: number
  /** Client upload idle timeout in ms (tests inject small values). */
  clientBodyIdleTimeoutMs?: number
  /** WebSocket heartbeat ping cadence in ms (tests inject small values). */
  wsPingIntervalMs?: number
  /** Consecutive ping cycles without a browser pong before the splice is torn down. */
  wsPingMissesBeforeTeardown?: number
  maxConcurrentHttpRequests?: number
  maxConcurrentWsStreams?: number
  maxPendingWsHandshakes?: number
  maxBufferedRequestBytes?: number
}

/** The instance-proxy surface. */
export interface InstanceProxy {
  handleHttp(req: ProxyRequest, res: ProxyResponse): Promise<void>
  handleUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer): Promise<void>
  registerTransport(connectionId: string, baseUrl: string): void
  unregisterTransport(connectionId: string): void
  getDiagnostics(): InstanceProxyDiagnostics
}

/** Whether an id is a valid /api/i/<id> segment ('local' or 'ssh-<id>'). */
export function parseInstanceId(id: string): 'local' | 'ssh' | null {
  if (id === 'local') return 'local'
  if (/^ssh-[a-zA-Z0-9_-]{1,64}$/.test(id)) return 'ssh'
  return null
}

/** Strip the /api/i/<id> prefix; null when the path is not an instance path.
 * Accepts the raw request target (path + optional query). */
export function parseInstancePath(raw: string): InstancePath | null {
  if (typeof raw !== 'string') return null
  const qIndex = raw.indexOf('?')
  const pathname = qIndex === -1 ? raw : raw.slice(0, qIndex)
  const search = qIndex === -1 ? '' : raw.slice(qIndex)
  const parts = pathname.split('/').filter(segment => segment !== '')
  if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'i') return null
  const id = parts[2]
  if (parseInstanceId(id) === null) return null
  const rest = parts.length === 3 ? '/' : `/${parts.slice(3).join('/')}`
  return { id, rest, search }
}

/**
 * Read the request body up to `cap` bytes; rejects with {code:
 * 'body_too_large'} when the cap is exceeded (design 03 §3.4 — explicit
 * 413, never a silent truncation).
 */
export async function readBody(req: ProxyRequest, cap: number, idleTimeoutMs = CLIENT_BODY_IDLE_TIMEOUT_MS): Promise<Buffer> {
  const chunks: Buffer[] = []
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
    size += chunk.length
    if (size > cap) {
      const error: Error & { code?: string } = new Error(`request body exceeds ${cap} bytes`)
      error.code = 'body_too_large'
      void iterator.return?.()
      throw error
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Wait for the response socket to drain (write-path backpressure). */
function waitForDrain(res: ProxyResponse): Promise<void> {
  return new Promise(resolve => res.once('drain', () => resolve()))
}

/** A request body with a byte budget, for capped forwarding. */
function bodySource(chunks: Buffer[]): { send: (upstream: ClientRequest) => void; size: number } {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  return {
    size,
    send(upstream) {
      for (const chunk of chunks) upstream.write(chunk)
    },
  }
}

/**
 * Create the instance proxy.
 * @param deps - {logger, getLocalState, getLocalDshPort}.
 *   - getLocalState/getLocalDshPort: the managed local instance facts; a
 *     non-ready local instance answers 503.
 * @returns {handleHttp, handleUpgrade, registerTransport,
 *   unregisterTransport, getDiagnostics}.
 */
export function createInstanceProxy(deps: InstanceProxyDeps): InstanceProxy {
  const { logger, getLocalState, getLocalDshPort } = deps
  const request = deps.httpRequest ?? httpRequest
  const upstreamTimeoutMs = deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS
  const clientBodyIdleTimeoutMs = deps.clientBodyIdleTimeoutMs ?? CLIENT_BODY_IDLE_TIMEOUT_MS
  const wsPingIntervalMs = deps.wsPingIntervalMs ?? WS_PING_INTERVAL_MS
  const wsPingMissesBeforeTeardown = deps.wsPingMissesBeforeTeardown ?? WS_PING_MISSES_BEFORE_TEARDOWN
  const maxConcurrentHttpRequests = deps.maxConcurrentHttpRequests ?? MAX_CONCURRENT_HTTP_REQUESTS
  const maxConcurrentWsStreams = deps.maxConcurrentWsStreams ?? MAX_CONCURRENT_WS_STREAMS
  const maxPendingWsHandshakes = deps.maxPendingWsHandshakes ?? MAX_PENDING_WS_HANDSHAKES
  const maxBufferedRequestBytes = deps.maxBufferedRequestBytes ?? MAX_BUFFERED_REQUEST_BYTES
  /** connectionId ('ssh:<id>') → tunnel baseUrl (desktop main-process
   * registration, design 05 §3.3). Local is never registered — its baseUrl
   * is derived from the managed dshPort. */
  const transports = new Map<string, string>()
  const counters = { requests: 0, failures: 0, activeStreams: 0 }
  let activeHttpRequests = 0
  let pendingUpgrades = 0
  let bufferedRequestBytes = 0

  /** Resolve the forward target; returns null + writes the error response
   * when the instance is unknown/unavailable (loud, never silent). */
  function resolveTarget(id: string, res: ProxyResponse | null): { baseUrl: string } | null {
    if (id === 'local') {
      if (getLocalState() === 'ready' && Number.isInteger(getLocalDshPort()) && (getLocalDshPort() ?? 0) > 0) {
        return { baseUrl: `http://127.0.0.1:${getLocalDshPort()}` }
      }
      if (res !== null) writeError(res, 503, 'instance_unavailable', 'the local instance is not ready')
      return null
    }
    const connectionId = `ssh:${id.slice('ssh-'.length)}`
    const baseUrl = transports.get(connectionId)
    if (typeof baseUrl === 'string' && baseUrl !== '') {
      return { baseUrl }
    }
    // An unregistered transport is an instance without a live tunnel —
    // explicit 503, never a silent empty success (AGENTS.md proxy honesty).
    if (res !== null) writeError(res, 503, 'instance_unavailable', 'no tunnel is available for this instance')
    return null
  }

  /** Write a JSON error in the unified shape ({error, code}). */
  function writeError(res: ProxyResponse, status: number, code: string, message: string): void {
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
      logger.warn(`instance-proxy: failed to write error ${status}: ${String(writeError)}`)
    }
  }

  /** Write a JSON error on an upgrade socket (rejections are explicit). */
  function rejectUpgrade(socket: ProxySocket, status: number, code: string, message: string): void {
    const body = JSON.stringify({ error: message, code })
    const head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n`
    try {
      // The client may have already gone (app exit, page reload): an 'error'
      // on this socket must be consumed, never an uncaught exception.
      socket.on('error', () => {})
      socket.write(head + body)
      socket.end()
    } catch (writeError) {
      logger.warn(`instance-proxy: failed to write upgrade rejection ${status}: ${String(writeError)}`)
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
  function armUpstreamTimeout(parsed: InstancePath, onTimeout: () => void): () => void {
    let handle: ReturnType<typeof setTimeout> | null = null
    let fired = false
    handle = setTimeout(() => {
      if (fired) return
      fired = true
      counters.failures += 1
      logger.log(`instance-proxy: upstream ${parsed.id} request timed out (${upstreamTimeoutMs}ms)`)
      onTimeout()
    }, upstreamTimeoutMs)
    return () => {
      if (handle !== null) {
        clearTimeout(handle)
        handle = null
      }
    }
  }

  /** Forward an HTTP request: prefix-stripped path, method/body/query kept. */
  async function forwardHttp(req: ProxyRequest, res: ProxyResponse, parsed: InstancePath, baseUrl: string, releaseRequest: () => void): Promise<void> {
    const target = new URL(`${baseUrl}${parsed.rest}${parsed.search}`)
    const method = typeof req.method === 'string' && req.method !== '' ? req.method : 'GET'
    const hasBody = !(method === 'GET' || method === 'HEAD')
    let body: Buffer | null = null
    if (hasBody) {
      const rawLength = Array.isArray(req.headers['content-length']) ? req.headers['content-length'][0] : req.headers['content-length']
      const declared = rawLength === undefined ? NaN : Number(rawLength)
      if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
        counters.failures += 1
        releaseRequest()
        writeError(res, 413, 'body_too_large', 'request body exceeds the 50MiB cap')
        return
      }
      // Unknown/chunked bodies reserve the full per-request cap. A valid
      // Content-Length reserves its exact byte count; Node's parser enforces
      // that framing, so a caller cannot smuggle additional body bytes.
      const reservation = Number.isFinite(declared) && declared >= 0 ? declared : MAX_REQUEST_BODY_BYTES
      if (bufferedRequestBytes + reservation > maxBufferedRequestBytes) {
        counters.failures += 1
        releaseRequest()
        writeError(res, 503, 'resource_exhausted', 'proxy request-body budget is exhausted')
        return
      }
      bufferedRequestBytes += reservation
      try {
        body = await readBody(req, MAX_REQUEST_BODY_BYTES, clientBodyIdleTimeoutMs)
      } catch (bodyError) {
        bufferedRequestBytes = Math.max(0, bufferedRequestBytes - reservation)
        counters.failures += 1
        releaseRequest()
        const code = (bodyError as Error & { code?: string }).code
        if (code === 'request_timeout') {
          writeError(res, 408, 'request_timeout', 'request body upload timed out')
        } else {
          writeError(res, 413, 'body_too_large', 'request body exceeds the 50MiB cap')
        }
        return
      }
      bufferedRequestBytes = Math.max(0, bufferedRequestBytes - reservation)
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
        headers[name] = `http://${target.host}`
        continue
      }
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    // Forward the bytes we actually accepted, never an untrusted client
    // declaration. This also normalizes chunked uploads into a bounded body.
    if (body !== null) headers['content-length'] = String(body.length)
    const controller = new AbortController()
    const onClientClose = () => {
      controller.abort()
      releaseRequest()
    }
    req.on('close', onClientClose)
    const timeoutAbort = (): void => {
      controller.abort()
      releaseRequest()
      if (!res.headersSent) writeError(res, 504, 'upstream_timeout', 'upstream request timed out')
      else res.destroy()
    }
    // Headers must arrive within upstreamTimeoutMs; a non-SSE body must not
    // idle longer than that either (re-armed after headers arrive). SSE and
    // upgraded WebSockets never re-arm — long-lived by nature.
    let clearUpstreamTimeout = armUpstreamTimeout(parsed, timeoutAbort)
    const clearTimeoutGuards = (): void => {
      clearUpstreamTimeout()
      clearUpstreamTimeout = () => {}
    }
    const source = body === null ? null : bodySource([body])
    const upstream = request(target, {
      method,
      headers,
      signal: controller.signal,
    })
    upstream.on('error', upstreamError => {
      clearTimeoutGuards()
      const abort = (upstreamError as Error & { name?: string }).name === 'AbortError' || controller.signal.aborted
      releaseRequest()
      if (abort) return
      counters.failures += 1
      logger.log(`instance-proxy: upstream ${parsed.id} request failed: ${String(upstreamError)}`)
      if (!res.headersSent) {
        writeError(res, 502, 'upstream_failed', 'upstream request failed')
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
        releaseRequest()
        counters.failures += 1
        writeError(res, 413, 'body_too_large', 'upstream response exceeds the 100MiB cap')
        return
      }
      const headers: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        const lower = name.toLowerCase()
        if (!RESPONSE_HEADER_WHITELIST.has(lower)) continue
        headers[name] = value as string | string[]
      }
      if (!isSse && Number.isFinite(declaredBytes)) headers['content-length'] = String(declaredBytes)
      res.writeHead(upstreamRes.statusCode ?? 502, { ...headers, ...(res._corsHeaders ?? {}) })
      // Headers are out: a stalled non-SSE body gets the same explicit
      // teardown (headersSent=true → destroy, the browser sees the stream cut).
      if (!isSse) clearUpstreamTimeout = armUpstreamTimeout(parsed, timeoutAbort)
      let received = 0
      upstreamRes.on('data', (chunk: Buffer) => {
        // This is an IDLE timeout, not a total-duration deadline. Every body
        // chunk proves progress and starts a fresh idle window.
        if (!isSse) {
          clearUpstreamTimeout()
          clearUpstreamTimeout = armUpstreamTimeout(parsed, timeoutAbort)
        }
        received += chunk.length
        if (!isSse && received > MAX_RESPONSE_BODY_BYTES) {
          // Explicit overflow: abort the upstream stream, never a silent
          // truncation (design 03 §3.4).
          upstreamRes.destroy()
          controller.abort()
          releaseRequest()
          counters.failures += 1
          if (!res.headersSent) writeError(res, 413, 'body_too_large', 'upstream response exceeds the 100MiB cap')
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
        releaseRequest()
        counters.failures += 1
        res.destroy()
      })
      // A client that closed its connection mid-stream (app exit) turns
      // res.write into writeAfterFIN — the resulting EPIPE 'error' must be
      // consumed, and the upstream aborted instead of kept streaming into
      // a dead response (same teardown family as the upgrade splice).
      res.on('error', () => {
        controller.abort()
        releaseRequest()
      })
      upstreamRes.on('end', () => {
        clearTimeoutGuards()
        releaseRequest()
        req.removeListener('close', onClientClose)
        res.end()
      })
    })
    source?.send(upstream)
    upstream.end()
  }

  /** Forward a WS upgrade to the instance (events.mux / events.host). */
  async function forwardUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer, parsed: InstancePath, baseUrl: string, releaseHandshake: () => void): Promise<void> {
    // The upstream request stays on http(s) — node's http.request performs
    // the upgrade handshake internally (it never accepts a ws: URL).
    const wsTarget = new URL(`${baseUrl}${parsed.rest}${parsed.search}`)
    const headers: Record<string, string> = { host: new URL(baseUrl).host }
    const take = new Set(['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'])
    for (const [name, value] of Object.entries(req.headers)) {
      if (!take.has(name.toLowerCase())) continue
      if (value === undefined) continue
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    const controller = new AbortController()
    const onClientClose = () => {
      controller.abort()
      releaseHandshake()
    }
    req.on('close', onClientClose)
    // The upgrade handshake must complete within upstreamTimeoutMs; once the
    // upstream answers 101 the socket is spliced and the timeout is cleared
    // (a live WebSocket is long-lived by nature).
    const clearUpgradeTimeout = armUpstreamTimeout(parsed, () => {
      controller.abort()
      releaseHandshake()
      rejectUpgrade(socket, 504, 'upstream_timeout', 'upstream WebSocket upgrade timed out')
    })
    const upstream = request(wsTarget, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    upstream.on('error', upstreamError => {
      clearUpgradeTimeout()
      releaseHandshake()
      const abort = (upstreamError as Error & { name?: string }).name === 'AbortError' || controller.signal.aborted
      if (abort) return
      counters.failures += 1
      logger.log(`instance-proxy: upstream ${parsed.id} upgrade failed: ${String(upstreamError)}`)
      rejectUpgrade(socket, 503, 'instance_unavailable', 'upstream WebSocket unavailable')
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
      logger.log(`instance-proxy: upstream ${parsed.id} upgrade answered non-101 (${upstreamRes.statusCode ?? '?'}); rejecting`)
      upstreamRes.on('error', () => {})
      upstreamRes.destroy()
      req.removeListener('close', onClientClose)
      rejectUpgrade(socket, 502, 'upstream_failed', 'upstream WebSocket answered non-101')
    })
    upstream.on('upgrade', (upstreamRes: IncomingMessage, upstreamSocket: Duplex, upstreamHead: Buffer) => {
      clearUpgradeTimeout()
      releaseHandshake()
      req.removeListener('close', onClientClose)
      counters.activeStreams += 1
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
        intervalMs: wsPingIntervalMs,
        missesBeforeTeardown: wsPingMissesBeforeTeardown,
        onDead: () => {
          logger.log(`instance-proxy: WebSocket stream ${parsed.id} heartbeat lost (no browser pong for ${wsPingMissesBeforeTeardown} cycle(s)); tearing down`)
          tearDown()
        },
      })
    })
    upstream.end()
  }

  return {
    /**
     * HTTP passthrough handler: path parse → instance resolve → full
     * passthrough with the header whitelist and body caps.
     */
    async handleHttp(req: ProxyRequest, res: ProxyResponse): Promise<void> {
      let parsed: InstancePath | null = null
      try {
        parsed = parseInstancePath(req.url ?? '/')
      } catch {
        parsed = null
      }
      if (parsed === null) {
        writeError(res, 404, 'instance_not_found', 'unknown instance path')
        return
      }
      counters.requests += 1
      if (activeHttpRequests >= maxConcurrentHttpRequests) {
        counters.failures += 1
        writeError(res, 503, 'resource_exhausted', 'too many concurrent proxy requests')
        return
      }
      const target = resolveTarget(parsed.id, res)
      if (target === null) {
        counters.failures += 1
        return
      }
      activeHttpRequests += 1
      let released = false
      const releaseRequest = () => {
        if (released) return
        released = true
        activeHttpRequests = Math.max(0, activeHttpRequests - 1)
      }
      try {
        await forwardHttp(req, res, parsed, target.baseUrl, releaseRequest)
      } catch (error) {
        releaseRequest()
        counters.failures += 1
        logger.warn(`instance-proxy: request setup failed: ${String(error)}`)
        if (!res.headersSent) writeError(res, 502, 'upstream_failed', 'upstream request failed')
        else res.destroy()
      }
    },

    /**
     * WS upgrade handler (registered on the server 'upgrade' event): the
     * same instance resolution as HTTP; only the two downlink stream paths
     * are forwarded (events.mux / events.host), everything else is an
     * explicit 404.
     */
    async handleUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer): Promise<void> {
      let parsed: InstancePath | null = null
      try {
        parsed = parseInstancePath(req.url ?? '/')
      } catch {
        parsed = null
      }
      if (parsed === null) {
        rejectUpgrade(socket, 404, 'instance_not_found', 'unknown instance path')
        return
      }
      if (!WS_STREAM_PATHS.has(parsed.rest)) {
        rejectUpgrade(socket, 404, 'instance_not_found', 'unknown WebSocket path')
        return
      }
      counters.requests += 1
      if (counters.activeStreams >= maxConcurrentWsStreams || pendingUpgrades >= maxPendingWsHandshakes) {
        counters.failures += 1
        rejectUpgrade(socket, 503, 'resource_exhausted', 'too many active proxy streams')
        return
      }
      const target = resolveTarget(parsed.id, null)
      if (target === null) {
        counters.failures += 1
        rejectUpgrade(socket, 503, 'instance_unavailable', 'no tunnel is available for this instance')
        return
      }
      pendingUpgrades += 1
      let released = false
      const releaseHandshake = () => {
        if (released) return
        released = true
        pendingUpgrades = Math.max(0, pendingUpgrades - 1)
      }
      try {
        await forwardUpgrade(req, socket, head, parsed, target.baseUrl, releaseHandshake)
      } catch (error) {
        releaseHandshake()
        counters.failures += 1
        logger.warn(`instance-proxy: upgrade setup failed: ${String(error)}`)
        rejectUpgrade(socket, 502, 'upstream_failed', 'upstream WebSocket setup failed')
      }
    },

    /**
     * Register a remote instance transport (design 05 §3.3): the desktop
     * main process reports a ready tunnel as connectionId `ssh:<id>` with
     * baseUrl `http://127.0.0.1:<tunnel localPort>`. Re-registration
     * replaces the previous baseUrl (tunnel re-established on a new port).
     */
    registerTransport(connectionId: string, baseUrl: string) {
      if (typeof connectionId !== 'string' || connectionId === '' || typeof baseUrl !== 'string' || baseUrl === '') {
        throw new TypeError('registerInstanceTransport: connectionId and baseUrl must be non-empty strings')
      }
      let target: URL
      try {
        target = new URL(baseUrl)
      } catch (urlError) {
        throw new TypeError(`registerInstanceTransport: invalid baseUrl: ${String(urlError)}`)
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new TypeError('registerInstanceTransport: baseUrl must be an http(s) URL')
      }
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname)
        || target.username !== '' || target.password !== '' || target.pathname !== '/'
        || target.search !== '' || target.hash !== '') {
        throw new TypeError('registerInstanceTransport: baseUrl must be a loopback origin')
      }
      transports.set(connectionId, baseUrl)
      logger.log(`instance-proxy: transport registered ${connectionId} -> ${target.host}`)
    },

    /** Unregister a remote instance transport (tunnel torn down). */
    unregisterTransport(connectionId: string) {
      if (transports.delete(connectionId)) {
        logger.log(`instance-proxy: transport unregistered ${connectionId}`)
      }
    },

    /** Plain counters (no URLs, no credentials). */
    getDiagnostics(): InstanceProxyDiagnostics {
      return {
        requests: counters.requests,
        failures: counters.failures,
        activeStreams: counters.activeStreams,
        activeHttpRequests,
        pendingUpgrades,
        bufferedRequestBytes,
        transports: transports.size,
      }
    },
  }
}
