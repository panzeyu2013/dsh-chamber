/**
 * Shared reverse-proxy forwarding core.
 *
 * Shared by instance-proxy.ts and gateway-proxy.ts so both reuse the exact
 * Host/Origin rewrite, header stripping, error semantics, rate limiting,
 * WebSocket splice and heartbeat — no fork, no drift. The two proxies differ
 * only in target resolution, which the caller passes as a fully-resolved URL:
 * instance-proxy resolves `/api/i/<id>/*` and strips the prefix; gateway-proxy
 * resolves every path to `http://127.0.0.1:<localDshPort>` verbatim. Wire
 * behavior is identical; only log lines are parameterized (deps.logPrefix,
 * deps.id).
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Logger } from './types.ts'
import { startWsHeartbeat } from './ws-heartbeat.ts'

/** Request body cap (aligned with the upstream 300MiB request cap / 200MiB image admission). */
export const MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024

// SPKI certificate pinning: single source in spki-pin.ts — the desktop identity
// probe and this proxy core both import it, so the two owners cannot drift.
// Re-exported here for existing importers.

export {
  attachSpkiPinVerifier,
  spkiPinOfPeerCertificate,
  SPKI_PIN_MISMATCH_CODE,
  SPKI_PIN_PATTERN,
} from './spki-pin.ts'
import { attachSpkiPinVerifier } from './spki-pin.ts'

/** Response body cap for non-SSE responses (same upstream 300MiB/200MiB alignment). */
export const MAX_RESPONSE_BODY_BYTES = 300 * 1024 * 1024

/** HTML-document injection budget: an upstream text/html response is buffered
 * for the owner's injector only when it is at most this large. Single source of
 * the 64 KiB budget (the gateway's html-inject.ts consumes this export). */
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
 * Upstream timeout: how long an upstream may take to answer headers, and — for
 * non-SSE responses — how long its body may idle before the proxy gives up with
 * an explicit 504 (upstream_timeout). SSE streams and upgraded WebSockets are
 * long-lived by nature: the timeout only covers reaching the response/101. Kept
 * strictly above the chamber Git host's 30s mutation budget so the host result
 * wins instead of a proxy-side 504 after the mutation commits.
 */
export const UPSTREAM_TIMEOUT_MS = 45_000

/**
 * Long-RPC upstream paths, matched EXACTLY against the RESOLVED target pathname
 * (the /api/i/<id> prefix is stripped first; root-mounted owners keep the path
 * verbatim). Upstream unary RPCs are always `POST /api/<service>/<method>`, so
 * exact matching keeps a future POST sub-resource from being silently exempted.
 *
 * These endpoints may stay silent far beyond the ordinary window: host business
 * has no upstream duration cap and progress arrives out-of-band (session-log
 * events over the WS mux), so the HTTP response is only a completion echo and
 * cutting it would cancel legitimate work. Members: /api/commands/execute and
 * /api/archiveCleanup/purge (unbounded fs deletions); the git worktree domain is
 * deliberately NOT here (hard 30s host cap).
 */
export const LONG_RPC_PATHS: readonly string[] = [
  '/api/commands/execute',
  '/api/archiveCleanup/purge',
]

/**
 * Long-RPC insurance fuse — deliberately generous, NOT an SLA or business
 * deadline: exempted paths keep a bound so a wedged-but-alive handler cannot
 * occupy a request slot forever, while real end conditions stay liveness-driven
 * (client teardown aborts upstream; a dead host surfaces as an upstream
 * failure). Set an order of magnitude above the only measured crossing; the
 * longRpcRequests/longRpcTimeouts counters make trips observable.
 */
export const LONG_RPC_UPSTREAM_TIMEOUT_MS = 30 * 60_000

/** Maximum silence between client request-body chunks. */
export const CLIENT_BODY_IDLE_TIMEOUT_MS = 30_000

/**
 * WebSocket heartbeat: ping cadence for the spliced mux downstream. The host
 * mux pings every socket and terminates after two missed pongs (~6s, see
 * ws-heartbeat.ts), but this proxy-side BROWSER-leg ping remains necessary for
 * OS sleep/wake: the host heartbeat cannot guard the browser leg across sleep,
 * where a half-open leg may fire no 'error'/'close' and the splice would hold
 * forever. After WS_PING_MISSES_BEFORE_TEARDOWN pong-less cycles the splice is
 * torn down so the browser's WebSocket closes and the renderer pump reconnects.
 * Values follow the canonical `ws` README example (30s, one unanswered cycle =
 * dead: the pong round-trip is loopback, so no answer is real death, not noise).
 *
 * The UPSTREAM (host) leg deliberately has no application heartbeat: SSH
 * keepalive, socket 'error'/'close', the host's own send-failure close and — for
 * direct-http targets only — OS-level TCP keepalive (tcpKeepAliveMs) cover it.
 */
export const WS_PING_INTERVAL_MS = 30_000

/** Consecutive ping cycles without a browser pong before the splice is torn down. */
export const WS_PING_MISSES_BEFORE_TEARDOWN = 1

/** Response headers converged through to the browser. */
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

/** WS stream path forwarded to the instance: the Typert Remote stream mux; the set admits exactly /api/remote.mux. */
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
  // the attached dsh instance.
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  // NOTE: accept-encoding is NOT in this always-strip set. Only requests that
  // must stay identity lose it — HTML document navigations (S0 injection) and
  // SSE streams; every other request forwards the client's negotiation so the
  // upstream gzip middleware can compress, and content-encoding/vary ride back
  // through RESPONSE_HEADER_WHITELIST.
])

/** Only headers required to complete a WebSocket 101 may cross downstream. */
export const WS_RESPONSE_HEADER_WHITELIST = new Set([
  'upgrade',
  'connection',
  'sec-websocket-accept',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
])

/**
 * Whether one request is an HTML *document navigation* — the only request class
 * whose accept-encoding must stay identity. Only an unencoded upstream
 * `text/html` response can carry the S0 trust injection, and a document load is
 * the only request that must produce one.
 *
 * Semantics follow the gateway's navigation predicate: GET/HEAD + an `Accept`
 * advertising text/html + a path outside the JSON/SSE surfaces (`/api`,
 * `/plugins`, `/auth/…`, `/chamber/<subpath>`; bare `/auth` is not excluded).
 * Duplicated on purpose: this shared control-plane module must not import
 * gateway code. A content-addressed asset path (isHashedStaticAssetPath) is
 * NEVER a navigation: the pinned upstream serves it from disk or 404s it, so no
 * compression setting can cost the injection.
 *
 * `pathname` is the RESOLVED target pathname (upstream taxonomy). Pure and total.
 */
export function isHtmlDocumentNavigation(method: string | undefined, pathname: string, accept: string | string[] | undefined): boolean {
  const verb = (method ?? '').toUpperCase()
  if (verb !== 'GET' && verb !== 'HEAD') return false
  const acceptValue = Array.isArray(accept) ? accept.join(',') : accept ?? ''
  if (!acceptValue.toLowerCase().includes('text/html')) return false
  if (isHashedStaticAssetPath(pathname)) return false
  return pathname !== '/api' && !pathname.startsWith('/api/')
    && pathname !== '/plugins' && !pathname.startsWith('/plugins/')
    && !pathname.startsWith('/auth/')
    && !(pathname.startsWith('/chamber/') && pathname !== '/chamber/')
}

/**
 * Content-addressed static asset path: Vite's `[name]-[hash][extname]` output
 * under `/assets/`, hash = exactly 8 base64url characters, extension exactly
 * `js | css | woff2 | woff | ttf | svg`, at most ONE nested directory
 * (`assets/fonts/`, `assets/langs/`). The EXACT width keeps an ordinary
 * hyphenated name out: `/assets/my-super-long-file.js` has no 8-character tail
 * after a `-`, whereas a `{8,}` class would read `long-file` as a hash because
 * real hashes may contain `-` (`DIPi6g--`). Unhashed root files are deliberately
 * not matched. A build with a different hash width must widen this. Still a
 * heuristic over the path alone; the caller decides status/caching policy.
 */
const HASHED_STATIC_ASSET_PATTERN = /^\/assets\/(?:[^/]+\/)?[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|ttf|svg)$/

export function isHashedStaticAssetPath(pathname: string): boolean {
  // A build never emits `%` or a dot-segment, while the upstream DECODES the
  // path before resolving it — so `/assets/..%2f..%2fsec-12345678.js` is
  // hash-SHAPED but can name a different file. Refused once here for all three
  // callers (asset compression, static-serving, the gateway cache stamp).
  if (pathname.includes('%') || pathname.includes('..')) return false
  return HASHED_STATIC_ASSET_PATTERN.test(pathname)
}

/**
 * Whether a request advertises a server-sent-event stream. This is TRANSPORT
 * insurance, not a navigation rule: a conformant EventSource sends
 * `Accept: text/event-stream`, and letting an upstream compress that long-lived,
 * latency-critical stream turns it into a buffered one. The pinned upstream's
 * gzip middleware refuses text/event-stream, but this core also serves
 * remote/older instances whose webserver may lack that filter. A fetch-based
 * stream advertising only a wildcard `Accept` cannot be recognized here and
 * stays with the upstream filter.
 */
export function acceptsEventStream(accept: string | string[] | undefined): boolean {
  const acceptValue = Array.isArray(accept) ? accept.join(',') : accept ?? ''
  return acceptValue.toLowerCase().includes('text/event-stream')
}

/**
 * The ONE decision the accept-encoding strip consumes: which requests must reach
 * the upstream with NO compression negotiation. Two disjoint identity-only
 * classes — everything else forwards the client's negotiation:
 *
 *   1. HTML document navigations (isHtmlDocumentNavigation);
 *   2. SSE requests (acceptsEventStream), independent of path and method.
 *
 * forwardHttp calls only this predicate, so strip site and callers agree.
 */
export function requiresIdentityUpstreamEncoding(method: string | undefined, pathname: string, accept: string | string[] | undefined): boolean {
  return isHtmlDocumentNavigation(method, pathname, accept) || acceptsEventStream(accept)
}

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

/** Owner-side registry for downstream sockets whose upstream WebSocket handshake
 * has not reached a terminal verdict: the HTTP server stops tracking a socket once
 * `upgrade` fires, and liveStreams only receives it after the 101, so without
 * this middle state stop() has a gap where neither owner can revoke it. */
export interface PendingUpgradeTracker {
  readonly size: number
  /** Acquire one handshake lease. The returned release is idempotent. */
  acquire(socket: ProxySocket, ownerId?: string): () => void
  /** Destroy every pending downstream; with an ownerId only handshakes
   *  authenticated through that transport. The existing close listener aborts the
   *  upstream request and releases the lease. */
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
        // Delete eagerly so diagnostics and repeated stop() calls converge even for a faulty socket fake.
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
  /** Requests that took the long-RPC window (liveness probe for the exemption list). */
  longRpcRequests: number
  /** Long-RPC requests that hit the insurance fuse (explicit 504 + abort). */
  longRpcTimeouts: number
}

/** One established WS splice. `ownerId` is set by the multi-transport instance
 * proxy so revoking a transport also revokes streams authenticated with it. */
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
  httpRequest?: HttpRequestFactory
  /** Upstream timeout in ms (default UPSTREAM_TIMEOUT_MS). */
  upstreamTimeoutMs: number
  /** Upstream idle window for long-RPC paths. */
  longRpcUpstreamTimeoutMs?: number
  /** Long-RPC paths selecting the exemption (default LONG_RPC_PATHS; `[]` disables it). */
  longRpcPaths?: readonly string[]
  clientBodyIdleTimeoutMs: number
  wsPingIntervalMs: number
  wsPingMissesBeforeTeardown: number
  /**
   * Optional OS-level TCP keepalive for the UPSTREAM leg of a spliced
   * WebSocket, armed before the splice. Only a direct-http target enables it:
   * ssh-tunneled targets have ssh keepalive and local legs are loopback, but a
   * direct http(s) target would otherwise freeze silently on an idle half-open
   * connection (NAT/proxy GC) with no 'error'/'close'. instance-proxy passes it
   * for any NON-loopback resolved target; `undefined` keeps the no-heartbeat
   * design untouched.
   */
  readonly tcpKeepAliveMs?: number
  maxBufferedRequestBytes: number
  /**
   * Browser-visible prefix for an attached instance: same-origin upstream
   * redirects are rewritten through it so `Location: /login` cannot escape
   * `/api/i/<id>`. `''` is valid for the root-mounted gateway (strip the target
   * origin, keep the path verbatim); `undefined` (no rewriting) is the
   * passthrough default for owners without a mounted prefix.
   */
  responseBasePath?: string
  /**
   * Optional HTML-document trust injector: when set, an unencoded `text/html`
   * response no larger than MAX_HTML_INJECTION_BYTES is buffered whole and
   * rewritten through this seam — the gateway uses it to declare the proxied
   * official frontend host-owned. Return the replacement document, or null to
   * forward untouched; `undefined` keeps the plain byte-for-byte passthrough.
   */
  readonly injectHtmlDocument?: (html: string) => string | null
  /**
   * Optional upstream-response header seam: called exactly once per upstream
   * HTTP response (SSE included), after the whitelist and Location rewrite
   * assembled the browser-facing map and before writeHead. It lets an owner add
   * representation metadata the upstream omitted (the gateway gives
   * content-addressed `/assets/<name>-<hash>.<ext>` responses an immutable
   * Cache-Control). Contract: `pathname` is the RESOLVED target pathname,
   * `headers` the mutable whitelisted map — mutate in place, return ignored.
   * Framing stays the proxy's and is ENFORCED: the map is re-filtered against
   * RESPONSE_HEADER_WHITELIST after the callback (so content-length and
   * transfer-encoding never reach the wire) and content-length is re-derived
   * from the upstream declaration; a throwing callback is fail-soft (logged).
   */
  readonly onUpstreamResponseHeaders?: (pathname: string, status: number, headers: Record<string, string | string[]>) => void
  /**
   * Live spliced WS streams (downstream + upstream legs), shared so stop() can
   * force-close them: an upgraded socket leaves the HTTP server's tracking, so a
   * lingering half-open downlink would hang server.close() forever.
   */
  liveStreams: Set<ProxyLiveStream>
  /** Optional transport registry key owning this request/stream. */
  streamOwner?: string
}

/**
 * Read the request body up to `cap` bytes; rejects with {code: 'body_too_large'}
 * when exceeded (explicit 413, never silent truncation).
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
      // Cancel the IncomingMessage iterator too, else a slow client may keep the
      // socket/request parser alive after the proxy already returned 408.
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
  // A declared Content-Length is enforced by Node's parser in production; if an
  // injected request violates it, do not read beyond the cap.
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
 * A request body with a byte budget for capped forwarding: `send()` keeps chunks
 * live only until node:http accepts them and honours writable backpressure
 * instead of queueing the whole body.
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

/** Rewrite only redirects back to the same trusted upstream origin, prepending
 * the mounted prefix when one exists (`''` strips the target origin). */
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
    // The client may have already gone: an 'error' on this socket must be
    // consumed, never an uncaught exception.
    socket.on('error', () => {})
    socket.write(head + body)
    socket.end()
  } catch (writeError) {
    logger.warn(`proxy-forward: failed to write upgrade rejection ${status}: ${String(writeError)}`)
  }
}

/**
 * One-shot upstream silence guard: fires when the upstream produced no socket
 * activity for upstreamTimeoutMs — covering "headers never arrive" and (re-armed
 * after headers) "body idles" for non-SSE responses. SSE/WebSocket streams never
 * re-arm, so their lifetime is unbounded; the returned clear is idempotent.
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

/**
 * Whether one HTTP request takes the long-RPC window: POST on one of the exact
 * `paths`. Pure decision predicate — forwardHttp consumes it so arm sites and
 * counters share the verdict.
 */
export function matchesLongRpcPath(method: string, pathname: string, paths: readonly string[]): boolean {
  return method.toUpperCase() === 'POST' && paths.includes(pathname)
}

/** Forward an HTTP request to a fully-resolved target (method/body/query kept).
 * `extraHeaders` are the per-transport injected headers (already whitelisted by
 * registerTransport); `tls` carries the optional gateway SPKI pin — when set and
 * the target is https, a mismatch surfaces as an upstream 'error' → 502. */
export async function forwardHttp(req: ProxyRequest, res: ProxyResponse, target: URL, releaseRequest: () => void, logger: Logger, counters: ProxyForwardCounters, deps: ProxyForwardDeps, extraHeaders?: Record<string, string>, tls?: { spkiPin?: string }, authority?: string): Promise<void> {
  // Select the http/https request by target protocol (the gateway transport target is https://).
  const request = deps.httpRequest ?? (target.protocol === 'https:' ? httpsRequest : httpRequest)
  const method = typeof req.method === 'string' && req.method !== '' ? req.method : 'GET'
  const rawLength = Array.isArray(req.headers['content-length']) ? req.headers['content-length'][0] : req.headers['content-length']
  const declared = rawLength === undefined ? NaN : Number(rawLength)
  const methodUsuallyHasNoBody = method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD'
  // GET/HEAD do not normally carry a body, but RFC framing permits one. If the
  // client declares positive Content-Length or Transfer-Encoding, silently
  // discarding those bytes desynchronises application-level signatures; keep the
  // cheap no-body path only for genuinely unframed GET/HEAD.
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
    // Unknown/chunked bodies reserve the full per-request cap; a valid
    // Content-Length reserves its exact byte count (Node's parser enforces it).
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
    // Unknown/chunked bodies reserve the full cap while reading; once complete,
    // retain only actually-buffered bytes until `finish`/`close`/`error`.
    if (body.length < bodyReservation) {
      counters.bufferedRequestBytes -= bodyReservation - body.length
      processBufferedRequestBytes -= bodyReservation - body.length
      bodyReservation = body.length
    }
  }
  // The upstream Host is the target's own authority by default; an ssh-tunneled
  // gateway target overrides it with the REMOTE gateway authority (its request
  // policy requires Host port == listen port, which the tunnel's loopback URL
  // cannot satisfy). The Origin rewrite below uses the SAME effective authority.
  const effectiveHost = authority ?? target.host
  const headers: Record<string, string> = { host: effectiveHost }
  // Compression negotiation: stripping accept-encoding on EVERY request would
  // force the whole proxied surface to identity. Strip only for the two
  // identity-only classes (requiresIdentityUpstreamEncoding): HTML document
  // navigations (so S0 injection can rewrite the reply) and text/event-stream
  // requests (transport insurance). Everything else forwards the client's
  // negotiation to the upstream gzip middleware.
  const identityEncoding = requiresIdentityUpstreamEncoding(method, target.pathname, req.headers.accept)
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue
    if (lower === 'accept-encoding' && identityEncoding) continue
    if (value === undefined) continue
    // Same-origin proxy honesty: the page origin is the control plane but the
    // instance's trust fence requires any attached Origin to equal the request's
    // Host authority. Rewrite the origin to the upstream's own authority so the
    // fence sees the same-origin shape it accepts; requests without Origin are
    // untouched.
    if (lower === 'origin') {
      headers[name] = `${target.protocol}//${effectiveHost}`
      continue
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  // Per-transport extra headers (bounded Authorization and/or
  // dsh_gateway_session Cookie) are injected AFTER strip + Origin rewrite so they
  // are never mistaken for browser headers. registerTransport validated the
  // whitelist; this filter is defense-in-depth.
  if (extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      const lower = name.toLowerCase()
      if (lower !== 'authorization' && lower !== 'cookie') continue
      headers[lower] = value
    }
  }
  // Forward the bytes we actually accepted, never an untrusted client declaration.
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
  // IncomingMessage 'close' means parsing completed, not that the peer left;
  // abort only on the explicit 'aborted' signal or an unfinished ServerResponse close.
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
  // Headers must arrive within upstreamTimeoutMs; a non-SSE body must not idle
  // longer (re-armed after headers). SSE/WS never re-arm. Long-RPC paths get the
  // generous fuse instead (LONG_RPC_PATHS); one effective deps object drives every
  // arm, and counters make exemption usage and fuse trips observable.
  const longRpc = matchesLongRpcPath(method, target.pathname, deps.longRpcPaths ?? LONG_RPC_PATHS)
  const longRpcWindowMs = deps.longRpcUpstreamTimeoutMs ?? LONG_RPC_UPSTREAM_TIMEOUT_MS
  const timeoutDeps = !longRpc || deps.upstreamTimeoutMs === longRpcWindowMs
    ? deps
    : { ...deps, upstreamTimeoutMs: longRpcWindowMs }
  if (longRpc) counters.longRpcRequests += 1
  const upstreamTimeout = longRpc
    ? () => {
      counters.longRpcTimeouts += 1
      timeoutAbort()
    }
    : timeoutAbort
  let clearUpstreamTimeout = armUpstreamTimeout(timeoutDeps, counters, logger, upstreamTimeout)
  clearTimeoutGuards = (): void => {
    clearUpstreamTimeout()
    clearUpstreamTimeout = () => {}
  }
  const source = body === null ? null : bodySource([body])
  // A pinned gateway target opens a FRESH https connection with the pin as its
  // trust anchor (rejectUnauthorized: false — the internal-CA case; the pin alone
  // decides trust). http targets never pin (registerTransport refuses http+pin).
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
  // 'finish' means all accepted request bytes have left ClientRequest's writable
  // queue; until then the body stays charged against the process budget.
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
    // Response-header seam (see ProxyForwardDeps.onUpstreamResponseHeaders):
    // fail-soft because it runs inside an event listener, and WHITELIST-BOUNDED —
    // the map is re-filtered after the callback, so content-length/transfer-encoding
    // or any other non-representation header changes nothing on the wire. Framing
    // stays the proxy's; `undefined` = zero-change passthrough.
    const responseStatus = upstreamRes.statusCode ?? 502
    if (deps.onUpstreamResponseHeaders !== undefined) {
      try {
        deps.onUpstreamResponseHeaders(target.pathname, responseStatus, headers)
      } catch (seamError) {
        logger.warn(`${deps.logPrefix}: upstream response header seam failed: ${String(seamError)}`)
      }
      // Case-insensitive: the map keeps the upstream's original header casing.
      for (const name of Object.keys(headers)) {
        if (!RESPONSE_HEADER_WHITELIST.has(name.toLowerCase())) delete headers[name]
      }
    }
    if (!isSse && Number.isFinite(declaredBytes)) headers['content-length'] = String(declaredBytes)
    const corsHeaders = { ...(res._corsHeaders ?? {}) }
    mergeVary(headers, corsHeaders)
    const responseHeaders = { ...headers, ...corsHeaders }
    // HTML trust-injection seam: with an injector configured, a small unencoded
    // text/html response is buffered whole so the document can be rewritten.
    // writeHead is deferred for that case — setHeader after writeHead throws
    // ERR_HTTP_HEADERS_SENT — so every other response keeps the immediate
    // passthrough writeHead below. SSE never enters this path.
    const injectHtmlDocument = deps.injectHtmlDocument
    const contentEncoding = upstreamRes.headers['content-encoding']
    const htmlInjectable = injectHtmlDocument !== undefined && !isSse
      && contentType.startsWith('text/html')
      && (contentEncoding === undefined || String(contentEncoding).toLowerCase() === 'identity')
      && (!Number.isFinite(declaredBytes) || declaredBytes <= MAX_HTML_INJECTION_BYTES)
    if (!htmlInjectable) res.writeHead(responseStatus, responseHeaders)
    // Headers are out (or held back only for a small htmlInjectable body): a
    // stalled non-SSE body gets the same explicit teardown (destroy after headers).
    if (!isSse) clearUpstreamTimeout = armUpstreamTimeout(timeoutDeps, counters, logger, upstreamTimeout)
    let received = 0
    // Buffered htmlInjectable body ([] = accumulating, null = flushed or never
    // eligible), capped at MAX_HTML_INJECTION_BYTES; exceeding it falls back to
    // the byte-exact streaming passthrough.
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
      // Idle timeout, not a total-duration deadline: every chunk starts a fresh window.
      if (!isSse) {
        clearUpstreamTimeout()
        clearUpstreamTimeout = armUpstreamTimeout(timeoutDeps, counters, logger, upstreamTimeout)
      }
      received += chunk.length
      if (!isSse && received > MAX_RESPONSE_BODY_BYTES) {
        // Explicit overflow: abort the upstream stream, never a silent truncation.
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
        // Over budget: the document cannot be rewritten. Send the headers with the
        // upstream content-length (every byte below is forwarded unchanged, so the
        // declaration stays truthful) and fall back to the streaming passthrough.
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
    // A client that closed mid-stream turns res.write into writeAfterFIN; consume
    // the EPIPE 'error' and abort the upstream instead of streaming into a dead
    // response (same teardown family as the upgrade splice).
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
      // The whole small document is buffered: hand it to the injector, then emit
      // final headers + body in one writeHead/end pair so the length matches.
      const buffered = htmlChunks
      htmlChunks = null
      const html = Buffer.concat(buffered, htmlBytes).toString('utf8')
      let injected: string | null = null
      if (injectHtmlDocument !== undefined) {
        try {
          injected = injectHtmlDocument(html)
        } catch (injectError) {
          // Fail-soft: an injector throwing must never break the request (this runs
          // inside an event listener); the original document is forwarded instead.
          logger.warn(`${deps.logPrefix}: html document injection failed: ${String(injectError)}`)
        }
      }
      if (injected !== null) {
        // The declaration is ASCII but the document may not be: use the byte length.
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
  // proves the peer key: constructing ClientRequest starts the TLS handshake, but
  // headers/body are not queued until write()/end(), both kept behind this gate —
  // so Authorization, Cookie, headers and business bytes never reach a wrong peer.
  let requestDispatched = false
  const dispatchRequest = (): void => {
    if (requestDispatched || controller.signal.aborted || upstream.destroyed) return
    requestDispatched = true
    try {
      source?.send(upstream)
      if (source === null) upstream.end()
    } catch (error) {
      // A pinned dispatch runs asynchronously from secureConnect, outside the setup
      // try/catch. Route synchronous write failures through the ordinary
      // ClientRequest error path so cleanup/release and the loud 502 happen once.
      upstream.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  }
  if (tlsSpkiPin !== undefined) attachSpkiPinVerifier(upstream, tlsSpkiPin, dispatchRequest)
  else dispatchRequest()
}

/** Forward a WS upgrade to a fully-resolved target (the /api/remote.mux stream
 * mux). `tls` carries the optional gateway SPKI pin: when set and the target is
 * https, a mismatch surfaces as an upstream 'error' → 502 upstream_failed. */
export async function forwardUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer, target: URL, releaseHandshake: () => void, logger: Logger, counters: ProxyForwardCounters, deps: ProxyForwardDeps, extraHeaders?: Record<string, string>, tls?: { spkiPin?: string }, authority?: string): Promise<void> {
  const request = deps.httpRequest ?? (target.protocol === 'https:' ? httpsRequest : httpRequest)
  // node's http.request performs the upgrade handshake internally (never a ws: URL).
  const headers: Record<string, string> = { host: authority ?? target.host }
  // accept-encoding never rides an upgrade: a 101 has no body to compress, and a
  // non-101 reply is drained and replaced by rejectUpgrade.
  const take = new Set(['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'])
  for (const [name, value] of Object.entries(req.headers)) {
    if (!take.has(name.toLowerCase())) continue
    if (value === undefined) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  // Per-transport extra headers (Authorization and/or dsh_gateway_session Cookie)
  // ride the upgrade handshake too — the gateway's WS auth == HTTP auth.
  if (extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      const lower = name.toLowerCase()
      if (lower !== 'authorization' && lower !== 'cookie') continue
      headers[lower] = value
    }
  }
  const controller = new AbortController()
  const upgradeStartedAt = Date.now()
  const onClientClose = () => {
    // A downstream leg that went away during the upstream handshake left NO trace:
    // the abort path is deliberately silent, so a mux reconnect whose first
    // attempt never reached the host was indistinguishable from a never-requested
    // connection. Only a close BEFORE any terminal branch (timeout / non-101 /
    // upstream error) logs; counters stay untouched (a downstream abandon, not an
    // upstream failure). ATTRIBUTION: "downstream" means THIS socket closed — the
    // control plane's own transport revocation also destroys it, so do not read
    // the line alone as a client-initiated reconnect.
    const premature = !controller.signal.aborted
    controller.abort()
    releaseHandshake()
    if (premature) {
      try {
        logger.log(`${deps.logPrefix}: WebSocket upgrade ${deps.id} abandoned (downstream close before upstream handshake, ${String(Date.now() - upgradeStartedAt)}ms)`)
      } catch { /* logging must never break teardown */ }
    }
  }
  // The downstream socket, not IncomingMessage 'close', owns handshake liveness.
  socket.on('close', onClientClose)
  // The handshake must complete within upstreamTimeoutMs; after the 101 the socket
  // is spliced and the timeout cleared (a live WebSocket is long-lived).
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
      // Pinned dispatch occurs from secureConnect; preserve the ordinary upstream
      // error/rejection path instead of throwing from an event listener.
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
    // An upstream connect refusal is upstream_failed (502) — the same code the HTTP
    // path uses; 503 stays reserved for "no tunnel / not ready".
    rejectUpgrade(socket, 502, 'upstream_failed', 'upstream WebSocket unavailable', logger)
  })
  // A non-101 upstream reply (unknown WS path, unmounted plugin, old dsh, …): the
  // upgrade request must never be left with an unread, unlistened stream — a late
  // RST would be an unhandled socket 'error'. Drain-and-destroy the reply and
  // reject the client upgrade explicitly.
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
    const openedAt = Date.now()
    // Downlink-only WebSocket with no heartbeat from either side: a silently dead
    // (half-open) BROWSER leg after OS sleep/wake fires no 'error'/'close', so
    // without this the splice would hold forever while the pump stays blind. The
    // heartbeat pings the browser; missed pongs tear the splice down. Declared
    // before tearDown (which stops it) and started once the splice is wired.
    let heartbeat: { stop(): void } | null = null
    // One bounded line per stream records which leg ended the splice and how long
    // it lived. Cause strings are stable and greppable: "upstream close" = the dsh
    // host / tunnel dropped the socket, "browser close" = the page's socket went
    // away, "heartbeat lost" = this proxy's browser-leg watchdog.
    const tearDown = (cause: string) => {
      if (tornDown) return
      tornDown = true
      // Logged before the bookkeeping (a throwing logger must not cost us the line)
      // and wrapped: only this statement can throw, and an escaping exception from a
      // socket 'close'/'error' handler would leave the stream latched forever.
      try {
        logger.log(`${deps.logPrefix}: WebSocket stream ${deps.id} closed (${cause}, ${String(Date.now() - openedAt)}ms)`)
      } catch { /* logging must never break teardown */ }
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
    // Error/close listeners on BOTH ends, attached before any write: on app exit one
    // pipe can push into a socket that already got the peer's FIN, and node's
    // writeAfterFIN EPIPE would be uncaught without a listener. Either end failing
    // closes both exactly once.
    socket.on('error', () => { tearDown('browser error') })
    upstreamSocket.on('error', () => { tearDown('upstream error') })
    socket.on('close', () => { tearDown('browser close') })
    upstreamSocket.on('close', () => { tearDown('upstream close') })
    const wireHeaders: string[] = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} Switching Protocols`]
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (!WS_RESPONSE_HEADER_WHITELIST.has(name.toLowerCase())) continue
      if (value === undefined) continue
      const values = Array.isArray(value) ? value : [value]
      for (const entry of values) wireHeaders.push(`${name}: ${entry}`)
    }
    socket.write(wireHeaders.join('\r\n') + '\r\n\r\n')
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    // Client head bytes (RFC 6455 pipelining) flow upstream only after it accepted the upgrade.
    if (head.length > 0) upstreamSocket.write(head)
    // OS-level TCP keepalive for the upstream leg of a direct-http target, armed
    // before the splice. Only opted-in owners hit this: ssh tunnels already have ssh
    // keepalive, so local/ssh splices keep the no-heartbeat design; a direct
    // http(s) leg would otherwise freeze silently on a half-open connection.
    if (deps.tcpKeepAliveMs !== undefined) {
      // setKeepAlive is the net.Socket surface (the upgrade socket is typed Duplex).
      ;(upstreamSocket as Socket).setKeepAlive(true, deps.tcpKeepAliveMs)
    }
    // Socket splice: downstream ↔ upstream; either closing tears both.
    upstreamSocket.pipe(socket as never)
    socket.pipe(upstreamSocket as never)
    // Start the liveness heartbeat after the splice is wired; downstream-only (the
    // upstream leg's liveness belongs to SSH keepalive / socket events).
    heartbeat = startWsHeartbeat({
      downstream: socket,
      intervalMs: deps.wsPingIntervalMs,
      missesBeforeTeardown: deps.wsPingMissesBeforeTeardown,
      onDead: () => {
        // Paren-free cause: every line keeps the parseable shape
        // `closed (<cause>, <ms>ms)`; "heartbeat lost" stays the greppable keyword.
        tearDown(`heartbeat lost after ${String(deps.wsPingMissesBeforeTeardown)} unanswered ping(s)`)
      },
    })
  })
  if (tlsSpkiPin !== undefined) attachSpkiPinVerifier(upstream, tlsSpkiPin, dispatchRequest)
  else dispatchRequest()
}
