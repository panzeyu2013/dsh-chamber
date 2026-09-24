/**
 * The gateway single-target reverse proxy: the browser/desktop entry point for
 * ONE local dsh — forwards `/`, `/plugins/*` and every non-management `/api/*`
 * verbatim to `http://127.0.0.1:<localDshPort>` with the same Host/Origin
 * rewrite, WS splice, limits and error semantics as the control-plane's
 * per-instance proxy (shared `proxy-forward.ts`); no `/api/i/<id>` prefix and
 * no transports table — the target is always the managed local dsh.
 *
 * This mount and the `/api/i/local/*` alias are the SAME dsh: this proxy carries
 * GATEWAY_PROXY_CSP + the trust declaration, /api/i/local/* the nonce CSP.
 */

import type { Duplex } from 'node:stream'
import {
  CLIENT_BODY_IDLE_TIMEOUT_MS,
  MAX_BUFFERED_REQUEST_BYTES,
  MAX_CONCURRENT_HTTP_REQUESTS,
  MAX_CONCURRENT_WS_STREAMS,
  MAX_PENDING_WS_HANDSHAKES,
  UPSTREAM_TIMEOUT_MS,
  WS_PING_INTERVAL_MS,
  WS_PING_MISSES_BEFORE_TEARDOWN,
  WS_STREAM_PATHS,
  createPendingUpgradeTracker,
  forwardHttp,
  forwardUpgrade,
  isHashedStaticAssetPath,
  rejectUpgrade,
  writeError,
  type Logger,
  type HttpRequestFactory,
  type ProxyForwardCounters,
  type ProxyForwardDeps,
  type ProxyRequest,
  type ProxyResponse,
  type ProxySocket,
  authCookieFor,
} from '@dsh-chamber/control-plane'
import { injectTrustDeclaration } from './html-inject.ts'

/**
 * Content types a content-addressed asset of one extension may carry: the path
 * alone is not proof of the payload — an SPA fallback answers an asset URL with
 * the rendered `text/html` index, and an immutable stamp on that answer would
 * cache HTML under a script URL for a year.
 */
const HASHED_ASSET_CONTENT_TYPES: ReadonlyArray<{ readonly extension: string; readonly pattern: RegExp }> = [
  { extension: '.js', pattern: /^(?:text|application)\/(?:javascript|ecmascript)\b/i },
  { extension: '.css', pattern: /^text\/css\b/i },
  { extension: '.woff2', pattern: /^(?:font\/woff2|application\/(?:font-woff2|octet-stream))\b/i },
  { extension: '.woff', pattern: /^(?:font\/woff|application\/(?:font-woff|octet-stream))\b/i },
  { extension: '.ttf', pattern: /^(?:font\/(?:ttf|sfnt)|application\/(?:x-font-ttf|x-font-sfnt|font-sfnt|octet-stream))\b/i },
  { extension: '.svg', pattern: /^image\/svg\+xml\b/i },
]

/**
 * Whether a 200 response for a content-addressed asset path carries a content
 * type the extension can actually produce. `application/octet-stream` is
 * deliberately accepted — a mislabelled font stays a font, while an
 * SPA-fallback `text/html` answer would poison the URL.
 */
export function hashedAssetContentTypeMatches(pathname: string, contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType
  if (typeof value !== 'string') return false
  const entry = HASHED_ASSET_CONTENT_TYPES.find(candidate => pathname.endsWith(candidate.extension))
  return entry !== undefined && entry.pattern.test(value.trim())
}

export interface GatewayProxyDeps {
  logger: Logger
  /** The managed local dsh port; null = not ready (503 instance_unavailable). */
  getLocalDshPort(): number | null
  /** The managed local dsh state ('ready' when serviceable). */
  getLocalState(): string
  /** Activation-aware exposure gate: false while an activation transaction is in
   * flight, so an unverdict-candidate never serves online users (default open). */
  canExposeLocal?: () => boolean
  /** Narrow forwarding seams used by deterministic lifecycle tests. */
  httpRequest?: HttpRequestFactory
  upstreamTimeoutMs?: number
  /** Upstream idle window for long-RPC paths (design 03 §3.4; default LONG_RPC_UPSTREAM_TIMEOUT_MS). */
  longRpcUpstreamTimeoutMs?: number
  longRpcPaths?: readonly string[]
}

export interface GatewayProxyDiagnostics {
  requests: number
  failures: number
  activeStreams: number
  activeHttpRequests: number
  pendingUpgrades: number
  bufferedRequestBytes: number
  longRpcRequests: number
  longRpcTimeouts: number
}

export interface GatewayProxy {
  handleHttp(req: ProxyRequest, res: ProxyResponse): Promise<void>
  handleUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer): Promise<void>
  getDiagnostics(): GatewayProxyDiagnostics
  closeAllStreams(): void
}

export function createGatewayProxy(deps: GatewayProxyDeps): GatewayProxy {
  const { logger, getLocalDshPort, getLocalState } = deps
  const counters: ProxyForwardCounters = {
    requests: 0,
    failures: 0,
    activeStreams: 0,
    bufferedRequestBytes: 0,
    longRpcRequests: 0,
    longRpcTimeouts: 0,
  }
  let activeHttpRequests = 0
  const pendingUpgrades = createPendingUpgradeTracker()
  const liveStreams = new Set<{ downstream: ProxySocket; upstream: Duplex }>()
  // HTTP includes long-lived SSE: keep the downstream response until the shared
  // release callback so credential rotation can revoke it like a WS splice.
  const liveHttpRequests = new Set<{ request: ProxyRequest; response: ProxyResponse }>()

  const forwardDeps: ProxyForwardDeps = {
    id: 'local',
    logPrefix: 'gateway-proxy',
    upstreamTimeoutMs: deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS,
    ...(deps.longRpcUpstreamTimeoutMs === undefined ? {} : { longRpcUpstreamTimeoutMs: deps.longRpcUpstreamTimeoutMs }),
    ...(deps.longRpcPaths === undefined ? {} : { longRpcPaths: deps.longRpcPaths }),
    clientBodyIdleTimeoutMs: CLIENT_BODY_IDLE_TIMEOUT_MS,
    wsPingIntervalMs: WS_PING_INTERVAL_MS,
    wsPingMissesBeforeTeardown: WS_PING_MISSES_BEFORE_TEARDOWN,
    maxBufferedRequestBytes: MAX_BUFFERED_REQUEST_BYTES,
    httpRequest: deps.httpRequest,
    liveStreams,
    // Root-mounted owner: same-origin absolute redirects from the managed dsh
    // are stripped to their path so a Location can never escape the public origin.
    responseBasePath: '',
    // HTML trust injection: the browser-facing official dsh frontend declares
    // its index host-owned to the documented client hook
    // (`__DSH_TRANSPORT__.ownsHost`); null = forward the upstream body untouched.
    injectHtmlDocument: html => {
      const result = injectTrustDeclaration(html)
      return result.injected ? result.html : null
    },
    // Hashed static-asset caching: the official frontend writes ONLY
    // content-type — no Cache-Control/ETag/Last-Modified — so without this stamp
    // the Vite shell is re-downloaded on every visit despite its content-hashed
    // names. The immutable contract covers exactly those names (an EXACT 8-char
    // hash) and only a plain 200. Three guards keep it from outliving its
    // evidence: the upstream's own cache metadata wins; the response must BE an
    // asset of that extension (an SPA-fallback `text/html` 200 would poison the
    // URL for a year); a range response never gets it. The seam re-applies the
    // response whitelist.
    onUpstreamResponseHeaders: (pathname, status, headers) => {
      if (status !== 200 || !isHashedStaticAssetPath(pathname)) return
      // (`%`-escaped and dot-segment paths are refused inside the predicate.)
      if (headers['content-range'] !== undefined) return
      if (headers['cache-control'] !== undefined || headers['etag'] !== undefined || headers['expires'] !== undefined) return
      if (!hashedAssetContentTypeMatches(pathname, headers['content-type'])) return
      headers['cache-control'] = 'public, max-age=31536000, immutable'
    },
  }

  /** Resolve the single target (the local dsh loopback origin): loud 503 when
   * the instance is not ready (never a silent empty success) or an activation
   * transaction is in flight — the candidate tree must not serve online users. */
  function resolveTarget(res: ProxyResponse | null): URL | null {
    const port = getLocalDshPort()
    if (getLocalState() === 'ready' && Number.isInteger(port) && (port ?? 0) > 0 && (deps.canExposeLocal?.() ?? true)) {
      return new URL(`http://127.0.0.1:${port}`)
    }
    if (res !== null) writeError(res, 503, 'instance_unavailable', 'the local dsh instance is not ready', logger)
    return null
  }

  /** Refuse non-origin-form request targets (SSRF guard): Node's parser accepts
   * absolute-form and protocol-relative lines, and `new URL(raw, target)` would
   * discard `target` and forward to the attacker host. Only origin-form is safe. */
  function parsePathTarget(reqUrl: string | undefined, target: URL): URL | null {
    const raw = reqUrl ?? '/'
    // Only origin-form: leading '/' but NOT '//' (protocol-relative), never an
    // absolute-form URL, and no backslash (`/\\evil/x` is an authority switch).
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
    return new URL(raw, target)
  }

  return {
    async handleHttp(req: ProxyRequest, res: ProxyResponse): Promise<void> {
      counters.requests += 1
      if (activeHttpRequests >= MAX_CONCURRENT_HTTP_REQUESTS) {
        counters.failures += 1
        writeError(res, 503, 'resource_exhausted', 'too many concurrent proxy requests', logger)
        return
      }
      const target = resolveTarget(res)
      if (target === null) {
        counters.failures += 1
        return
      }
      // Full passthrough: the target carries the ORIGINAL path+query.
      const fullTarget = parsePathTarget(req.url, target)
      if (fullTarget === null) {
        counters.failures += 1
        writeError(res, 400, 'invalid_request', 'absolute request targets are not allowed', logger)
        return
      }
      activeHttpRequests += 1
      const liveRequest = { request: req, response: res }
      liveHttpRequests.add(liveRequest)
      let released = false
      const releaseRequest = (): void => {
        if (released) return
        released = true
        liveHttpRequests.delete(liveRequest)
        activeHttpRequests = Math.max(0, activeHttpRequests - 1)
      }
      try {
        // Browser-auth cookie: the local-dsh proxy must pass the spawn-minted
        // cookie exactly like the desktop instance proxy, or every /api 401s.
        const authCookie = authCookieFor(fullTarget.origin)
        const extraHeaders = authCookie === undefined ? undefined : { cookie: authCookie }
        await forwardHttp(req, res, fullTarget, releaseRequest, logger, counters, forwardDeps, extraHeaders)
      } catch (error) {
        releaseRequest()
        counters.failures += 1
        logger.warn(`gateway-proxy: request setup failed: ${String(error)}`)
        if (!res.headersSent) writeError(res, 502, 'upstream_failed', 'upstream request failed', logger)
        else res.destroy()
      }
    },

    async handleUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer): Promise<void> {
      // Hoisted SSRF guard (defense in depth): reject absolute-form,
      // protocol-relative and backslash targets BEFORE normalization — `new URL()`
      // would otherwise normalize `/api\events.mux` into a WS_STREAM_PATHS match.
      if (parsePathTarget(req.url, new URL('http://localhost')) === null) {
        counters.failures += 1
        rejectUpgrade(socket, 400, 'invalid_request', 'absolute request targets are not allowed', logger)
        return
      }
      // Only the Remote stream mux path upgrades.
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!WS_STREAM_PATHS.has(pathname)) {
        rejectUpgrade(socket, 404, 'instance_not_found', 'unknown WebSocket path', logger)
        return
      }
      counters.requests += 1
      if (counters.activeStreams >= MAX_CONCURRENT_WS_STREAMS || pendingUpgrades.size >= MAX_PENDING_WS_HANDSHAKES) {
        counters.failures += 1
        rejectUpgrade(socket, 503, 'resource_exhausted', 'too many active proxy streams', logger)
        return
      }
      const target = resolveTarget(null)
      if (target === null) {
        counters.failures += 1
        rejectUpgrade(socket, 503, 'instance_unavailable', 'the local dsh instance is not ready', logger)
        return
      }
      const fullTarget = parsePathTarget(req.url, target)
      if (fullTarget === null) {
        // Unreachable after the hoisted guard — kept as defense in depth.
        counters.failures += 1
        rejectUpgrade(socket, 400, 'invalid_request', 'absolute request targets are not allowed', logger)
        return
      }
      const releaseHandshake = pendingUpgrades.acquire(socket)
      try {
        const authCookie = authCookieFor(fullTarget.origin)
        const extraHeaders = authCookie === undefined ? undefined : { cookie: authCookie }
        await forwardUpgrade(req, socket, head, fullTarget, releaseHandshake, logger, counters, forwardDeps, extraHeaders)
      } catch (error) {
        releaseHandshake()
        counters.failures += 1
        logger.warn(`gateway-proxy: upgrade setup failed: ${String(error)}`)
        rejectUpgrade(socket, 502, 'upstream_failed', 'upstream WebSocket setup failed', logger)
      }
    },

    getDiagnostics(): GatewayProxyDiagnostics {
      return {
        requests: counters.requests,
        failures: counters.failures,
        activeStreams: counters.activeStreams,
        activeHttpRequests,
        pendingUpgrades: pendingUpgrades.size,
        bufferedRequestBytes: counters.bufferedRequestBytes,
        longRpcRequests: counters.longRpcRequests,
        longRpcTimeouts: counters.longRpcTimeouts,
      }
    },

    closeAllStreams(): void {
      pendingUpgrades.closeAll()
      for (const { request, response } of [...liveHttpRequests]) {
        // request.destroy() terminates a still-uploading body; response.destroy()
        // tears down an established downstream/SSE leg (guarded cast: ProxyRequest
        // is transport-minimal).
        try { (request as ProxyRequest & { destroy?: () => unknown }).destroy?.() } catch { /* already gone */ }
        try { response.destroy() } catch { /* already gone */ }
      }
      for (const stream of [...liveStreams]) {
        try { stream.downstream.destroy() } catch { /* already gone */ }
        try { stream.upstream.destroy() } catch { /* already gone */ }
      }
    },
  }
}
