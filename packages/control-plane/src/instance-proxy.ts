/**
 * Per-instance generic reverse proxy (/api/i/<id>/*): the single same-origin entry
 * point for every dsh instance the frontend reaches — HTTP passthrough (any method),
 * WS upgrade (the /api/remote.mux Typert Remote stream) and SSE. Path mapping:
 * /api/i/local/* → managed local web profile; /api/i/dsh-<id>/* → dsh-kind target
 * (`ssh:<id>` is the legacy spelling); /api/i/gateway-<id>/* → gateway-kind target
 * (http(s) direct, optional bounded Authorization/Cookie).
 *
 * The prefix is stripped and the rest forwarded verbatim; Host stays the target's
 * own authority so the instance's --trusted-host fence admits it, and only a gateway
 * transport's bounded headers ride upstream. v1 has no authentication boundary:
 * /api/i/* is reachable with no session, HTTP and WS alike. Failures are loud
 * (404/503/502/504 masked/413 over-cap) and headers converge to a whitelist; this
 * module is the thin shell — the forwarding core is proxy-forward.ts.
 */

import { authCookieFor } from './browser-auth-cookie.ts'
import {
  GATEWAY_SESSION_COOKIE_NAME,
  GATEWAY_SESSION_COOKIE_VALUE_MAX_CHARS,
  GATEWAY_TOKEN_MAX_CHARS,
  GATEWAY_TOKEN_MIN_CHARS,
} from './gateway-session-protocol.ts'
import { isLoopbackHostname, isLoopbackUpstreamBaseUrl } from './loopback.ts'
import {
  CLIENT_BODY_IDLE_TIMEOUT_MS,
  LONG_RPC_PATHS,
  LONG_RPC_UPSTREAM_TIMEOUT_MS,
  MAX_BUFFERED_REQUEST_BYTES,
  MAX_CONCURRENT_HTTP_REQUESTS,
  MAX_CONCURRENT_WS_STREAMS,
  MAX_PENDING_WS_HANDSHAKES,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  RESPONSE_HEADER_WHITELIST,
  UPSTREAM_TIMEOUT_MS,
  WS_PING_INTERVAL_MS,
  WS_PING_MISSES_BEFORE_TEARDOWN,
  WS_STREAM_PATHS,
  convergeLocation,
  createPendingUpgradeTracker,
  forwardHttp,
  forwardUpgrade,
  getProcessBufferedRequestBytes,
  rejectUpgrade,
  SPKI_PIN_PATTERN,
  writeError,
} from './proxy-forward.ts'
import type { Logger } from './types.ts'
import type {
  HttpRequestFactory,
  ProxyForwardCounters,
  ProxyForwardDeps,
  ProxyLiveStream,
  ProxyRequest,
  ProxyResponse,
  ProxySocket,
} from './proxy-forward.ts'

// Re-export the constants/types that historically lived here so the module surface stays compatible.
export {
  CLIENT_BODY_IDLE_TIMEOUT_MS,
  LONG_RPC_PATHS,
  LONG_RPC_UPSTREAM_TIMEOUT_MS,
  MAX_BUFFERED_REQUEST_BYTES,
  MAX_CONCURRENT_HTTP_REQUESTS,
  MAX_CONCURRENT_WS_STREAMS,
  MAX_PENDING_WS_HANDSHAKES,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  RESPONSE_HEADER_WHITELIST,
  UPSTREAM_TIMEOUT_MS,
  WS_PING_INTERVAL_MS,
  WS_PING_MISSES_BEFORE_TEARDOWN,
  WS_STREAM_PATHS,
  convergeLocation,
  getProcessBufferedRequestBytes,
}
export type { ProxyRequest, ProxyResponse, ProxySocket }

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
  /** Requests that took the long-RPC window, and hits of the insurance fuse (LONG_RPC_PATHS). */
  longRpcRequests: number
  longRpcTimeouts: number
  transports: number
}

/** createInstanceProxy deps. */
export interface InstanceProxyDeps {
  logger: Logger
  /** The managed local instance state ('ready' when serviceable). */
  getLocalState(): string
  /** The managed local instance port (null when not ready). */
  getLocalDshPort(): number | null
  /** False while a newly spawned runtime is quarantined behind activation probes;
   *  internal main-process probes use the direct host port. */
  canExposeLocal?: () => boolean
  /** Injectable outbound request factory (defaults to node:http request). */
  httpRequest?: HttpRequestFactory
  /** Upstream timeout in ms (default UPSTREAM_TIMEOUT_MS). */
  upstreamTimeoutMs?: number
  /** Upstream idle window for long-RPC paths (default LONG_RPC_UPSTREAM_TIMEOUT_MS). */
  longRpcUpstreamTimeoutMs?: number
  /** Long-RPC paths selecting the exemption (default LONG_RPC_PATHS; `[]` disables the exemption). */
  longRpcPaths?: readonly string[]
  /** Client upload idle timeout in ms. */
  clientBodyIdleTimeoutMs?: number
  /** WebSocket heartbeat ping cadence in ms. */
  wsPingIntervalMs?: number
  /** Overrides WS_PING_MISSES_BEFORE_TEARDOWN (see proxy-forward.ts). */
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
  /** `opts.transport` preserves the target/transport split: dsh+http may use a direct
   *  non-loopback origin, while dsh+ssh and the legacy spelling stay loopback-only.
   *  `opts.tls.spkiPin` is the optional gateway+http+https certificate pin. */
  registerTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>, opts?: InstanceTransportRegistrationOptions): void
  unregisterTransport(connectionId: string): void
  getDiagnostics(): InstanceProxyDiagnostics
  /** Force-close every spliced WS stream (control-plane stop): an upgraded socket
   *  leaves the HTTP server's connection tracking, so a lingering half-open downlink
   *  would hang server.close() forever. */
  closeAllStreams(): void
}

/** Main-process-only facts used to validate a ready transport registration. The
 * dimension is explicit because a canonical `dsh:<id>` identifies target semantics,
 * not whether its ready URL came from an SSH tunnel or HTTP direct. */
export interface InstanceTransportRegistrationOptions {
  transport?: 'ssh' | 'http'
  tls?: { spkiPin?: string }
  authority?: string
}

/** Whether an id is a valid /api/i/<id> segment ('local', 'dsh-<id>' or 'gateway-<id>';
 * 'ssh-<id>' is accepted as the legacy spelling of the dsh kind). */
export function parseInstanceId(id: string): 'local' | 'dsh' | 'gateway' | null {
  if (id === 'local') return 'local'
  if (/^dsh-[a-zA-Z0-9_-]{1,64}$/.test(id)) return 'dsh'
  if (/^gateway-[a-zA-Z0-9_-]{1,64}$/.test(id)) return 'gateway'
  if (/^ssh-[a-zA-Z0-9_-]{1,64}$/.test(id)) return 'dsh' // legacy alias
  return null
}

/** TCP keepalive cadence (ms) for the upstream leg of a direct-http target. NOTE: this is
 * the INITIAL-IDLE threshold only — Node's setKeepAlive(true, ms) sets TCP_KEEPIDLE and
 * the probe interval/failure count follow OS defaults, so a half-open leg surfaces on
 * the order of ~10 minutes, never "30s". The 30s value coincides with WS_PING (30s/1miss)
 * and ssh ServerAliveInterval (30×3) — same number, unrelated rationales; do not merge. */
const DIRECT_HTTP_TCP_KEEPALIVE_MS = 30_000

/** The upstream-leg TCP keepalive cadence for one resolved upstream target, or
 * `undefined` to keep the no-heartbeat design. NON-loopback upstreams get OS-level TCP
 * keepalive: they are the desktop's direct-http(s) shape (gateway-kind OR dsh-kind with
 * the http transport — the id prefix cannot see the transport dimension, the resolved
 * target can) and have no ssh keepalive to cover them, so an idle half-open connection
 * would freeze the stream silently. Loopback legs return `undefined`. */
export function tcpKeepAliveMsForUpstream(baseUrl: string): number | undefined {
  if (isLoopbackUpstreamBaseUrl(baseUrl)) return undefined
  return DIRECT_HTTP_TCP_KEEPALIVE_MS
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
  // Preserve the trailing slash: extra-bundle URLs are `/plugins/??…` and the upstream
  // serveBundle keys by the EXACT pathname+search, so without the slash every extra
  // preload 404s and boot fails.
  const trailingSlash = pathname.endsWith('/') && parts.length > 3 ? '/' : ''
  const rest = parts.length === 3 ? '/' : `/${parts.slice(3).join('/')}${trailingSlash}`
  return { id, rest, search }
}

/** The root `/chamber` namespace is reserved for gateway targets. Normalize URL dot
 * segments, backslashes and bounded percent-encoding layers so a dsh target cannot
 * reach it through an alternate spelling that `new URL()` later canonicalizes. */
function targetsChamberNamespace(rawPath: string): boolean {
  let candidate = rawPath
  for (let depth = 0; depth < 4; depth += 1) {
    candidate = candidate.replace(/\\/g, '/')
    let pathname: string
    try {
      // Concatenate under a fixed dummy authority instead of resolving a `//...` path as
      // a protocol-relative URL (repeated/backslash-derived slashes are path syntax here).
      pathname = new URL(`http://instance.invalid${candidate.startsWith('/') ? '' : '/'}${candidate}`).pathname
    } catch {
      return false
    }
    const first = pathname.split('/').find(segment => segment !== '')
    if (first === 'chamber') return true
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return false
    }
    if (decoded === candidate || decoded === pathname) return false
    candidate = decoded
  }
  return false
}

/** Create the instance proxy; returns the handle/registry surface. */
export function createInstanceProxy(deps: InstanceProxyDeps): InstanceProxy {
  const { logger, getLocalState, getLocalDshPort } = deps
  const upstreamTimeoutMs = deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS
  const clientBodyIdleTimeoutMs = deps.clientBodyIdleTimeoutMs ?? CLIENT_BODY_IDLE_TIMEOUT_MS
  const wsPingIntervalMs = deps.wsPingIntervalMs ?? WS_PING_INTERVAL_MS
  const wsPingMissesBeforeTeardown = deps.wsPingMissesBeforeTeardown ?? WS_PING_MISSES_BEFORE_TEARDOWN
  const maxConcurrentHttpRequests = deps.maxConcurrentHttpRequests ?? MAX_CONCURRENT_HTTP_REQUESTS
  const maxConcurrentWsStreams = deps.maxConcurrentWsStreams ?? MAX_CONCURRENT_WS_STREAMS
  const maxPendingWsHandshakes = deps.maxPendingWsHandshakes ?? MAX_PENDING_WS_HANDSHAKES
  const maxBufferedRequestBytes = deps.maxBufferedRequestBytes ?? MAX_BUFFERED_REQUEST_BYTES
  /** connectionId ('dsh:<id>' / 'gateway:<id>'; 'ssh:<id>' legacy alias) → target record.
   *  Local is never registered (its baseUrl derives from the managed dshPort). A gateway
   *  record carries the bounded extra headers injected at forward time and the optional
   *  https SPKI pin applied by proxy-forward. */
  interface TransportRecord { baseUrl: string; headers?: Record<string, string>; tls?: { spkiPin?: string }; authority?: string }
  const transports = new Map<string, TransportRecord>()
  const counters: ProxyForwardCounters = { requests: 0, failures: 0, activeStreams: 0, bufferedRequestBytes: 0, longRpcRequests: 0, longRpcTimeouts: 0 }
  let activeHttpRequests = 0
  const pendingUpgrades = createPendingUpgradeTracker()
  /** Live spliced WS streams tracked so stop() can force-close them: an upgraded
   *  socket leaves the HTTP server's connection tracking, so a lingering half-open
   *  downlink would hang server.close() forever. */
  const liveStreams = new Set<ProxyLiveStream>()
  /** In-flight HTTP/SSE keyed by transport. Pending WS ownership is kept by the shared
   *  pendingUpgrades tracker, established WS ownership on ProxyLiveStream. Revocation must
   *  terminate traffic already authenticated with the old transport/token. */
  const liveHttpByTransport = new Map<string, Set<ProxyResponse>>()

  function connectionIdForInstance(id: string): string | null {
    if (id === 'local') return null
    const separator = id.indexOf('-')
    return `${id.slice(0, separator)}:${id.slice(separator + 1)}`
  }

  function trackHttp(connectionId: string, res: ProxyResponse): void {
    const responses = liveHttpByTransport.get(connectionId) ?? new Set<ProxyResponse>()
    responses.add(res)
    liveHttpByTransport.set(connectionId, responses)
    const release = () => {
      responses.delete(res)
      if (responses.size === 0) liveHttpByTransport.delete(connectionId)
    }
    res.once('finish', release)
    res.once('close', release)
    res.once('error', release)
  }

  function revokeTransportTraffic(connectionId: string): void {
    const responses = liveHttpByTransport.get(connectionId)
    liveHttpByTransport.delete(connectionId)
    for (const res of responses ?? []) {
      try { res.destroy() } catch { /* already closed */ }
    }
    pendingUpgrades.closeAll(connectionId)
    for (const stream of [...liveStreams]) {
      if (stream.ownerId !== connectionId) continue
      try { stream.downstream.destroy() } catch { /* already closed */ }
      try { stream.upstream.destroy() } catch { /* already closed */ }
    }
  }

  /** The shared forwarding-core config; only the per-request log label differs. */
  const forwardDeps: Omit<ProxyForwardDeps, 'id'> = {
    logPrefix: 'instance-proxy',
    httpRequest: deps.httpRequest,
    upstreamTimeoutMs,
    ...(deps.longRpcUpstreamTimeoutMs === undefined ? {} : { longRpcUpstreamTimeoutMs: deps.longRpcUpstreamTimeoutMs }),
    ...(deps.longRpcPaths === undefined ? {} : { longRpcPaths: deps.longRpcPaths }),
    clientBodyIdleTimeoutMs,
    wsPingIntervalMs,
    wsPingMissesBeforeTeardown,
    maxBufferedRequestBytes,
    liveStreams,
  }

  /** Resolve the forward target; returns null + writes the error response when the
   *  instance is unknown/unavailable (loud, never silent). */
  function resolveTarget(id: string, res: ProxyResponse | null): TransportRecord | null {
    if (id === 'local') {
      if ((deps.canExposeLocal?.() ?? true)
        && getLocalState() === 'ready'
        && Number.isInteger(getLocalDshPort())
        && (getLocalDshPort() ?? 0) > 0) {
        return { baseUrl: `http://127.0.0.1:${getLocalDshPort()}` }
      }
      if (res !== null) writeError(res, 503, 'instance_unavailable', 'the local instance is not ready', logger)
      return null
    }
    // dsh-<id> → dsh:<id>; gateway-<id> → gateway:<id>; ssh-<id> → legacy dsh alias.
    const kind = id.slice(0, id.indexOf('-'))
    const connectionId = `${kind}:${id.slice(kind.length + 1)}`
    const record = transports.get(connectionId)
    if (record !== undefined && record.baseUrl !== '') {
      return record
    }
    // An unregistered transport is an instance without a live tunnel — explicit 503.
    if (res !== null) writeError(res, 503, 'instance_unavailable', 'no transport is available for this instance', logger)
    return null
  }

  return {
    /**
     * HTTP passthrough handler: path parse → instance resolve → full passthrough with
     * the header whitelist and body caps.
     */
    async handleHttp(req: ProxyRequest, res: ProxyResponse): Promise<void> {
      let parsed: InstancePath | null = null
      try {
        parsed = parseInstancePath(req.url ?? '/')
      } catch {
        parsed = null
      }
      if (parsed === null) {
        writeError(res, 404, 'instance_not_found', 'unknown instance path', logger)
        return
      }
      counters.requests += 1
      // Target semantics are enforced in the proxy core, not only by hiding settings
      // rows: local/dsh/legacy-ssh sources have no gateway-owned `/chamber/*` capability,
      // so a user-configured dsh+http endpoint cannot smuggle that namespace in.
      if (parseInstanceId(parsed.id) !== 'gateway' && targetsChamberNamespace(parsed.rest)) {
        counters.failures += 1
        writeError(res, 404, 'capability_not_found', 'the dsh target does not expose gateway capabilities', logger)
        return
      }
      if (activeHttpRequests >= maxConcurrentHttpRequests) {
        counters.failures += 1
        writeError(res, 503, 'resource_exhausted', 'too many concurrent proxy requests', logger)
        return
      }
      const target = resolveTarget(parsed.id, res)
      if (target === null) {
        counters.failures += 1
        return
      }
      activeHttpRequests += 1
      const connectionId = connectionIdForInstance(parsed.id)
      if (connectionId !== null) trackHttp(connectionId, res)
      let released = false
      const releaseRequest = () => {
        if (released) return
        released = true
        activeHttpRequests = Math.max(0, activeHttpRequests - 1)
      }
      try {
        const forwardTarget = new URL(`${target.baseUrl}${parsed.rest}${parsed.search}`)
        // browser-auth cookie: inject the control plane's spawn-time cookie into proxied
        // requests. Registered transport extraHeaders never coexist with it; when both
        // exist the local browser-auth cookie wins (the local instance is the only entry).
        const authCookie = authCookieFor(target.baseUrl)
        const extraHeaders = authCookie === undefined
          ? target.headers
          : { ...(target.headers ?? {}), cookie: authCookie }
        await forwardHttp(req, res, forwardTarget, releaseRequest, logger, counters, {
          ...forwardDeps,
          id: parsed.id,
          responseBasePath: `/api/i/${parsed.id}`,
          ...(connectionId === null ? {} : { streamOwner: connectionId }),
        }, extraHeaders, target.tls, target.authority)
      } catch (error) {
        releaseRequest()
        counters.failures += 1
        logger.warn(`instance-proxy: request setup failed: ${String(error)}`)
        if (!res.headersSent) writeError(res, 502, 'upstream_failed', 'upstream request failed', logger)
        else res.destroy()
      }
    },

    /**
     * WS upgrade handler: the same instance resolution as HTTP; only the
     * /api/remote.mux stream path is forwarded, everything else is an explicit 404.
     */
    async handleUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer): Promise<void> {
      let parsed: InstancePath | null = null
      try {
        parsed = parseInstancePath(req.url ?? '/')
      } catch {
        parsed = null
      }
      if (parsed === null) {
        rejectUpgrade(socket, 404, 'instance_not_found', 'unknown instance path', logger)
        return
      }
      if (!WS_STREAM_PATHS.has(parsed.rest)) {
        rejectUpgrade(socket, 404, 'instance_not_found', 'unknown WebSocket path', logger)
        return
      }
      counters.requests += 1
      if (counters.activeStreams >= maxConcurrentWsStreams || pendingUpgrades.size >= maxPendingWsHandshakes) {
        counters.failures += 1
        rejectUpgrade(socket, 503, 'resource_exhausted', 'too many active proxy streams', logger)
        return
      }
      const target = resolveTarget(parsed.id, null)
      if (target === null) {
        counters.failures += 1
        rejectUpgrade(socket, 503, 'instance_unavailable', 'no tunnel is available for this instance', logger)
        return
      }
      const connectionId = connectionIdForInstance(parsed.id)
      const releaseHandshake = pendingUpgrades.acquire(socket, connectionId ?? undefined)
      try {
        const forwardTarget = new URL(`${target.baseUrl}${parsed.rest}${parsed.search}`)
        // browser-auth cookie on the mux upgrade — the stream gate authenticates like unary.
        const authCookie = authCookieFor(target.baseUrl)
        const extraHeaders = authCookie === undefined
          ? target.headers
          : { ...(target.headers ?? {}), cookie: authCookie }
        await forwardUpgrade(req, socket, head, forwardTarget, releaseHandshake, logger, counters, {
          ...forwardDeps,
          id: parsed.id,
          // OS-level TCP keepalive for the upstream leg: non-loopback (direct-http(s))
          // targets arm it; loopback legs keep the no-heartbeat design. The discriminator
          // is the RESOLVED target's host, not the source-id kind. HTTP forwarding never
          // reads this field, so handleHttp's deps stay untouched.
          tcpKeepAliveMs: tcpKeepAliveMsForUpstream(target.baseUrl),
          ...(connectionId === null ? {} : { streamOwner: connectionId }),
        }, extraHeaders, target.tls, target.authority)
      } catch (error) {
        releaseHandshake()
        counters.failures += 1
        logger.warn(`instance-proxy: upgrade setup failed: ${String(error)}`)
        rejectUpgrade(socket, 502, 'upstream_failed', 'upstream WebSocket setup failed', logger)
      }
    },

    /**
     * Register a remote instance transport: the desktop main process reports a ready
     * target as connectionId `dsh:<id>`/`gateway:<id>` plus the independent
     * `opts.transport` (legacy `ssh:<id>` remains SSH-only). Re-registration replaces
     * the previous baseUrl/headers and revokes traffic authenticated through the old record.
     */
    registerTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>, opts?: InstanceTransportRegistrationOptions) {
      if (typeof connectionId !== 'string' || connectionId === '' || typeof baseUrl !== 'string' || baseUrl === '') {
        throw new TypeError('registerInstanceTransport: connectionId and baseUrl must be non-empty strings')
      }
      // dsh:<id> / gateway:<id>; ssh:<id> stays accepted as the legacy spelling of the dsh kind.
      if (!/^(dsh|gateway|ssh):[a-zA-Z0-9_-]{1,64}$/.test(connectionId)) {
        throw new TypeError('registerInstanceTransport: connectionId must be "dsh:<id>", "gateway:<id>" or the legacy "ssh:<id>"')
      }
      let target: URL
      try {
        target = new URL(baseUrl)
      } catch {
        // Never reflect the rejected value: URL parser errors may include userinfo or query credentials.
        throw new TypeError('registerInstanceTransport: invalid baseUrl')
      }
      const isGateway = connectionId.startsWith('gateway:')
      const isLegacySsh = connectionId.startsWith('ssh:')
      const transport = opts?.transport
      if (transport !== undefined && transport !== 'ssh' && transport !== 'http') {
        throw new TypeError('registerInstanceTransport: transport must be "ssh" or "http"')
      }
      if (isLegacySsh && transport === 'http') {
        throw new TypeError('registerInstanceTransport: the legacy "ssh:<id>" spelling cannot register an http transport')
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new TypeError('registerInstanceTransport: baseUrl must be an http(s) URL')
      }
      const isOrigin = target.username === '' && target.password === ''
        && target.pathname === '/' && target.search === '' && target.hash === ''
      if (!isGateway) {
        // Target kind and transport are independent: dsh+http is a direct origin and may be
        // non-loopback; dsh+ssh and the legacy spelling stay a loopback tunnel. Missing
        // transport intentionally keeps the fail-closed SSH interpretation.
        if (!isOrigin) {
          throw new TypeError(transport === 'http'
            ? 'registerInstanceTransport: dsh baseUrl must be an origin (no credentials/path/query)'
            : 'registerInstanceTransport: ssh baseUrl must be a loopback origin')
        }
        if (transport !== 'http' && target.protocol !== 'http:') {
          throw new TypeError('registerInstanceTransport: ssh baseUrl must be an HTTP loopback origin')
        }
        if (transport !== 'http'
          && !isLoopbackHostname(target.hostname)) {
          throw new TypeError('registerInstanceTransport: ssh baseUrl must be a loopback origin')
        }
        // dsh targets never carry credentials: no header injection, ever.
        if (extraHeaders !== undefined) {
          throw new TypeError('registerInstanceTransport: dsh transports cannot inject request headers')
        }
      } else {
        // gateway: http(s) origin, non-loopback allowed (http = explicit insecureHttp, https = default).
        if (!isOrigin) {
          throw new TypeError('registerInstanceTransport: gateway baseUrl must be an origin (no credentials/path/query)')
        }
        if (transport === 'ssh' && target.protocol !== 'http:') {
          throw new TypeError('registerInstanceTransport: an ssh-tunneled gateway baseUrl must be an HTTP loopback origin')
        }
        if (transport === 'ssh'
          && !isLoopbackHostname(target.hostname)) {
          throw new TypeError('registerInstanceTransport: ssh baseUrl must be a loopback origin')
        }
        // 0..2 sanctioned headers, each bounded and whitelist-checked: Authorization (Bearer)
        // and Cookie (dsh_gateway_session) — anything else, duplicates or unbounded values are
        // rejected; the bounds come from gateway-session-protocol.ts.
        const cookiePrefix = `${GATEWAY_SESSION_COOKIE_NAME}=`
        const bearerPattern = new RegExp(`^Bearer [\\x20-\\x7e]{${GATEWAY_TOKEN_MIN_CHARS},${GATEWAY_TOKEN_MAX_CHARS}}$`)
        const entries = extraHeaders === undefined ? [] : Object.entries(extraHeaders)
        const injected: Record<string, string> = {}
        for (const [name, rawValue] of entries) {
          const lower = name.toLowerCase()
          if (lower === 'authorization') {
            if (injected.authorization !== undefined) {
              throw new TypeError('registerInstanceTransport: gateway Authorization may be given at most once')
            }
            if (typeof rawValue !== 'string' || !bearerPattern.test(rawValue)) {
              throw new TypeError(`registerInstanceTransport: gateway Authorization Bearer credential must contain ${GATEWAY_TOKEN_MIN_CHARS}–${GATEWAY_TOKEN_MAX_CHARS} visible-ASCII characters`)
            }
            injected.authorization = rawValue
          } else if (lower === 'cookie') {
            if (injected.cookie !== undefined) {
              throw new TypeError('registerInstanceTransport: gateway Cookie may be given at most once')
            }
            if (typeof rawValue !== 'string' || !rawValue.startsWith(cookiePrefix)
              || rawValue.length <= cookiePrefix.length
              || rawValue.length > cookiePrefix.length + GATEWAY_SESSION_COOKIE_VALUE_MAX_CHARS
              || /[\r\n\0;,]/.test(rawValue)) {
              throw new TypeError('registerInstanceTransport: gateway Cookie must be a bounded dsh_gateway_session credential')
            }
            injected.cookie = rawValue
          } else {
            throw new TypeError(`registerInstanceTransport: gateway transports may only inject Authorization/Cookie headers (got "${lower}")`)
          }
        }
        extraHeaders = Object.keys(injected).length === 0 ? undefined : injected
      }
      // An SPKI certificate pin is a gateway-only, https-only gate — a dsh/ssh target has no
      // TLS trust decision to pin, and http has no TLS layer at all. Format mirrors the spec
      // gate (64-hex sha256, case-insensitive compare at verify time).
      const tlsSpkiPin = opts?.tls?.spkiPin
      if (tlsSpkiPin !== undefined) {
        if (!isGateway) {
          throw new TypeError('registerInstanceTransport: dsh transports cannot use an SPKI certificate pin')
        }
        if (!SPKI_PIN_PATTERN.test(tlsSpkiPin)) {
          throw new TypeError('registerInstanceTransport: spkiPin must be a 64-character hex sha256 of the SPKI DER')
        }
        if (target.protocol !== 'https:') {
          throw new TypeError('registerInstanceTransport: an SPKI pin requires an https gateway origin')
        }
      }
      // Tunnel Host override: an ssh-tunneled gateway target connects to the loopback tunnel
      // endpoint but must present the gateway's REMOTE loopback-listener authority in Host —
      // the gateway's request policy requires the authority port to equal its own listen port,
      // which the tunnel's local port can never satisfy. Gateway-only and shape-bounded
      // (host[:port] without path/query/userinfo/fragment).
      const authority = opts?.authority
      if (isGateway && transport === 'ssh' && authority === undefined) {
        throw new TypeError('registerInstanceTransport: an ssh-tunneled gateway requires its remote loopback authority')
      }
      if (authority !== undefined) {
        if (!isGateway) {
          throw new TypeError('registerInstanceTransport: dsh transports cannot override the upstream Host authority')
        }
        if (transport !== 'ssh') {
          throw new TypeError('registerInstanceTransport: a gateway Host authority override requires an ssh transport')
        }
        const loopback = typeof authority === 'string' ? /^127\.0\.0\.1:(\d{1,5})$/.exec(authority) : null
        const authorityPort = loopback === null ? 0 : Number(loopback[1])
        if (loopback === null || authorityPort < 1 || authorityPort > 65535) {
          throw new TypeError('registerInstanceTransport: an ssh gateway authority must be remote 127.0.0.1:<port>')
        }
      }
      // Clone the sanctioned headers so caller mutation cannot alter a live transport after validation.
      if (transports.has(connectionId)) revokeTransportTraffic(connectionId)
      transports.set(connectionId, {
        baseUrl,
        ...(extraHeaders !== undefined ? { headers: { ...extraHeaders } } : {}),
        ...(tlsSpkiPin === undefined ? {} : { tls: { spkiPin: tlsSpkiPin } }),
        ...(authority === undefined ? {} : { authority }),
      })
      logger.log(`instance-proxy: transport registered ${connectionId}`)
    },

    /** Unregister a remote instance transport (tunnel torn down). */
    unregisterTransport(connectionId: string) {
      const removed = transports.delete(connectionId)
      revokeTransportTraffic(connectionId)
      if (removed) {
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
        pendingUpgrades: pendingUpgrades.size,
        bufferedRequestBytes: counters.bufferedRequestBytes,
        longRpcRequests: counters.longRpcRequests,
        longRpcTimeouts: counters.longRpcTimeouts,
        transports: transports.size,
      }
    },

    /** Force-close every spliced WS stream (control-plane stop / app quit). */
    closeAllStreams(): void {
      pendingUpgrades.closeAll()
      for (const stream of [...liveStreams]) {
        try {
          stream.downstream.destroy()
        } catch { /* already gone */ }
        try {
          stream.upstream.destroy()
        } catch { /* already gone */ }
      }
    },
  }
}
