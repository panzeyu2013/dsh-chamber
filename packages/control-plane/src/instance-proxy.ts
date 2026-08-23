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
 * (masked, never echoing the upstream host:port); body over 300MiB / response
 * over 300MiB → 413 body_too_large (+ upstream abort).
 *
 * Response headers are converged to a whitelist (03 §3.4): content-type,
 * cache-control, x-next-cursor, x-ratelimit-*; nothing else rides through
 * (hop-by-hop and potential credential surfaces stay server-side).
 *
 * Diagnostics: plain counters (requests / failures / activeStreams) — no
 * sensitive data, no URLs.
 *
 * ## proxy-forward.ts split (design 16 §6.2, 方案 A)
 *
 * This module is now the thin shell: prefix parsing (`parseInstanceId` /
 * `parseInstancePath`), target resolution (`resolveTarget`) and the
 * request/upgrade entry points + transport registry. The actual forwarding
 * core (header rewrite, body caps, error semantics, WS splice, heartbeat) is
 * the shared `proxy-forward.ts` module, which `gateway-proxy.ts` reuses for
 * its single-target full passthrough. Wire behavior is unchanged from the
 * pre-split instance-proxy.
 */

import type { Duplex } from 'node:stream'
import {
  CLIENT_BODY_IDLE_TIMEOUT_MS,
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
  forwardHttp,
  forwardUpgrade,
  rejectUpgrade,
  writeError,
} from './proxy-forward.ts'
import type { Logger } from './types.ts'
import type {
  HttpRequestFactory,
  ProxyForwardCounters,
  ProxyForwardDeps,
  ProxyRequest,
  ProxyResponse,
  ProxySocket,
} from './proxy-forward.ts'

// Re-export the public constants/types that historically lived here so the
// module surface stays compatible (the test suite and future importers read
// them from instance-proxy.ts).
export {
  CLIENT_BODY_IDLE_TIMEOUT_MS,
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
  httpRequest?: HttpRequestFactory
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
  registerTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>): void
  unregisterTransport(connectionId: string): void
  getDiagnostics(): InstanceProxyDiagnostics
  /** Force-close every spliced WS stream (control-plane stop): an upgraded
   * socket leaves the HTTP server's connection tracking, so a lingering
   * half-open downlink would otherwise hang server.close() forever. */
  closeAllStreams(): void
}

/** Whether an id is a valid /api/i/<id> segment ('local', 'ssh-<id>' or
 * 'gateway-<id>'; design 16 §6.4 adds the gateway kind). */
export function parseInstanceId(id: string): 'local' | 'ssh' | 'gateway' | null {
  if (id === 'local') return 'local'
  if (/^ssh-[a-zA-Z0-9_-]{1,64}$/.test(id)) return 'ssh'
  if (/^gateway-[a-zA-Z0-9_-]{1,64}$/.test(id)) return 'gateway'
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
 * Create the instance proxy.
 * @param deps - {logger, getLocalState, getLocalDshPort}.
 *   - getLocalState/getLocalDshPort: the managed local instance facts; a
 *     non-ready local instance answers 503.
 * @returns {handleHttp, handleUpgrade, registerTransport,
 *   unregisterTransport, getDiagnostics}.
 */
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
  /** connectionId ('ssh:<id>' / 'gateway:<id>') → target record (design 05
   * §3.3 + design 16 §6.4). Local is never registered — its baseUrl is
   * derived from the managed dshPort. A gateway record carries extra headers
   * (the shared bearer token) injected at forward time, never in the registry. */
  interface TransportRecord { baseUrl: string; headers?: Record<string, string> }
  const transports = new Map<string, TransportRecord>()
  const counters: ProxyForwardCounters = { requests: 0, failures: 0, activeStreams: 0, bufferedRequestBytes: 0 }
  let activeHttpRequests = 0
  let pendingUpgrades = 0
  /** Live spliced WS streams (downstream browser leg + upstream host leg),
   * tracked so control-plane stop() can force-close them: an upgraded socket
   * is removed from the HTTP server's connection tracking, so a lingering
   * half-open downlink (crashed host mid-reconnect) would otherwise hang
   * server.close() forever. */
  const liveStreams = new Set<{ downstream: ProxySocket; upstream: Duplex }>()

  /** The shared forwarding-core config; only the log label differs per
   * request (the /api/i/<id> id), so the per-call deps spread it in. */
  const forwardDeps: Omit<ProxyForwardDeps, 'id'> = {
    logPrefix: 'instance-proxy',
    httpRequest: deps.httpRequest,
    upstreamTimeoutMs,
    clientBodyIdleTimeoutMs,
    wsPingIntervalMs,
    wsPingMissesBeforeTeardown,
    maxBufferedRequestBytes,
    liveStreams,
  }

  /** Resolve the forward target; returns null + writes the error response
   * when the instance is unknown/unavailable (loud, never silent). */
  function resolveTarget(id: string, res: ProxyResponse | null): TransportRecord | null {
    if (id === 'local') {
      if (getLocalState() === 'ready' && Number.isInteger(getLocalDshPort()) && (getLocalDshPort() ?? 0) > 0) {
        return { baseUrl: `http://127.0.0.1:${getLocalDshPort()}` }
      }
      if (res !== null) writeError(res, 503, 'instance_unavailable', 'the local instance is not ready', logger)
      return null
    }
    // ssh-<id> → ssh:<id>; gateway-<id> → gateway:<id>.
    const kind = id.slice(0, id.indexOf('-'))
    const connectionId = `${kind}:${id.slice(kind.length + 1)}`
    const record = transports.get(connectionId)
    if (record !== undefined && record.baseUrl !== '') {
      return record
    }
    // An unregistered transport is an instance without a live tunnel —
    // explicit 503, never a silent empty success (AGENTS.md proxy honesty).
    if (res !== null) writeError(res, 503, 'instance_unavailable', 'no transport is available for this instance', logger)
    return null
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
        writeError(res, 404, 'instance_not_found', 'unknown instance path', logger)
        return
      }
      counters.requests += 1
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
      let released = false
      const releaseRequest = () => {
        if (released) return
        released = true
        activeHttpRequests = Math.max(0, activeHttpRequests - 1)
      }
      try {
        const forwardTarget = new URL(`${target.baseUrl}${parsed.rest}${parsed.search}`)
        await forwardHttp(req, res, forwardTarget, releaseRequest, logger, counters, { ...forwardDeps, id: parsed.id }, target.headers)
      } catch (error) {
        releaseRequest()
        counters.failures += 1
        logger.warn(`instance-proxy: request setup failed: ${String(error)}`)
        if (!res.headersSent) writeError(res, 502, 'upstream_failed', 'upstream request failed', logger)
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
        rejectUpgrade(socket, 404, 'instance_not_found', 'unknown instance path', logger)
        return
      }
      if (!WS_STREAM_PATHS.has(parsed.rest)) {
        rejectUpgrade(socket, 404, 'instance_not_found', 'unknown WebSocket path', logger)
        return
      }
      counters.requests += 1
      if (counters.activeStreams >= maxConcurrentWsStreams || pendingUpgrades >= maxPendingWsHandshakes) {
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
      pendingUpgrades += 1
      let released = false
      const releaseHandshake = () => {
        if (released) return
        released = true
        pendingUpgrades = Math.max(0, pendingUpgrades - 1)
      }
      try {
        const forwardTarget = new URL(`${target.baseUrl}${parsed.rest}${parsed.search}`)
        await forwardUpgrade(req, socket, head, forwardTarget, releaseHandshake, logger, counters, { ...forwardDeps, id: parsed.id }, target.headers)
      } catch (error) {
        releaseHandshake()
        counters.failures += 1
        logger.warn(`instance-proxy: upgrade setup failed: ${String(error)}`)
        rejectUpgrade(socket, 502, 'upstream_failed', 'upstream WebSocket setup failed', logger)
      }
    },

    /**
     * Register a remote instance transport (design 05 §3.3): the desktop
     * main process reports a ready tunnel as connectionId `ssh:<id>` with
     * baseUrl `http://127.0.0.1:<tunnel localPort>`. Re-registration
     * replaces the previous baseUrl (tunnel re-established on a new port).
     */
    registerTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>) {
      if (typeof connectionId !== 'string' || connectionId === '' || typeof baseUrl !== 'string' || baseUrl === '') {
        throw new TypeError('registerInstanceTransport: connectionId and baseUrl must be non-empty strings')
      }
      if (!/^(ssh|gateway):[a-zA-Z0-9_-]{1,64}$/.test(connectionId)) {
        throw new TypeError('registerInstanceTransport: connectionId must be "ssh:<id>" or "gateway:<id>"')
      }
      let target: URL
      try {
        target = new URL(baseUrl)
      } catch (urlError) {
        throw new TypeError(`registerInstanceTransport: invalid baseUrl: ${String(urlError)}`)
      }
      const isGateway = connectionId.startsWith('gateway:')
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new TypeError('registerInstanceTransport: baseUrl must be an http(s) URL')
      }
      if (!isGateway) {
        // ssh tunnel: loopback origin only (design 05 §3.3) — one combined
        // check keeps the historical message (the test asserts /loopback/).
        if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname)
          || target.username !== '' || target.password !== '' || target.pathname !== '/'
          || target.search !== '' || target.hash !== '') {
          throw new TypeError('registerInstanceTransport: ssh baseUrl must be a loopback origin')
        }
      } else {
        // gateway: https origin, non-loopback allowed (design 16 §6.4).
        if (target.protocol !== 'https:') {
          throw new TypeError('registerInstanceTransport: gateway baseUrl must be https')
        }
        if (target.username !== '' || target.password !== '' || target.pathname !== '/'
          || target.search !== '' || target.hash !== '') {
          throw new TypeError('registerInstanceTransport: gateway baseUrl must be an origin (no credentials/path/query)')
        }
      }
      transports.set(connectionId, { baseUrl, ...(extraHeaders !== undefined ? { headers: extraHeaders } : {}) })
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
        bufferedRequestBytes: counters.bufferedRequestBytes,
        transports: transports.size,
      }
    },

    /** Force-close every spliced WS stream (control-plane stop / app quit):
     * destroys both legs exactly once via tearDown's guard. */
    closeAllStreams(): void {
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
