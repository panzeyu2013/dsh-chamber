/**
 * Per-instance generic reverse proxy (/api/i/<id>/*, design 03 §3 / 04 §4).
 *
 * The single same-origin entry point for every dsh instance the frontend
 * reaches (05 §1): HTTP passthrough (any method, no whitelist), WS upgrade
 * (events.mux / events.host downlinks) and SSE passthrough. Path mapping:
 *
 *   /api/i/local/*       → the managed local web profile (baseUrl derived
 *                          from the local connection's dshPort)
 *   /api/i/dsh-<id>/*    → the dsh-kind target registered by the desktop main
 *                          process (registerInstanceTransport with
 *                          connectionId `dsh:<id>`; `ssh:<id>`/`ssh-<id>`
 *                          remain accepted as the legacy spelling of the same
 *                          kind, design 17 §2.2 migration)
 *   /api/i/gateway-<id>/* → the gateway-kind target registered with
 *                          connectionId `gateway:<id>` (design 17 §9.3:
 *                          http(s) direct origin, optional bounded
 *                          Authorization/Cookie injection)
 *
 * Prefix stripping: the /api/i/<id> prefix is removed and the remaining path
 * is forwarded verbatim — the instance anchors everything under its /api
 * root (dsh's connection node half registers the whole route tree at
 * API_PATH '/api'). The Host header is kept as the target's own authority
 * (127.0.0.1:<port> for local/ssh) so the instance's --trusted-host fence
 * admits the request (02 §2.1); browser-supplied login cookie and
 * Authorization are never forwarded — only a gateway transport's bounded
 * registered headers ride upstream (design 17 §9.3).
 *
 * v1 has no authentication boundary: /api/i/* is directly reachable, HTTP
 * and WS upgrade alike, with no session required.
 *
 * Failures are loud and explicit (04 §4.2): unknown id → 404
 * instance_not_found; no tunnel / instance not ready → 503
 * instance_unavailable; upstream connect/timeout → 502/504 upstream_failed
 * (masked, never echoing the upstream host:port); declared body over 300MiB,
 * unknown-length body over 32MiB, or response over 300MiB → 413
 * body_too_large (+ upstream abort).
 *
 * Response headers are converged to the exact 04 §4.2 whitelist (content
 * metadata/ranges, validators, retry/rate-limit hints, location and vary;
 * location is rewritten only when same-origin-safe). Nothing else rides
 * through: hop-by-hop and potential credential surfaces stay server-side.
 *
 * Diagnostics: plain counters (requests / failures / activeStreams) — no
 * sensitive data, no URLs.
 *
 * ## proxy-forward.ts split (design 17 §6.2, 方案 A)
 *
 * This module is now the thin shell: prefix parsing (`parseInstanceId` /
 * `parseInstancePath`), target resolution (`resolveTarget`) and the
 * request/upgrade entry points + transport registry. The actual forwarding
 * core (header rewrite, body caps, error semantics, WS splice, heartbeat) is
 * the shared `proxy-forward.ts` module, which `gateway-proxy.ts` reuses for
 * its single-target full passthrough. Wire behavior is unchanged from the
 * pre-split instance-proxy.
 */

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
  convergeLocation,
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
  transports: number
}

/** createInstanceProxy deps. */
export interface InstanceProxyDeps {
  logger: Logger
  /** The managed local instance state ('ready' when serviceable). */
  getLocalState(): string
  /** The managed local instance port (null when not ready). */
  getLocalDshPort(): number | null
  /** False while a newly spawned runtime is quarantined behind activation
   * probes. Internal main-process probes use the direct host port. */
  canExposeLocal?: () => boolean
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
  /** `opts.transport` preserves the target/transport split from design 17:
   * dsh+http may use a direct non-loopback origin, while dsh+ssh and the
   * legacy ssh spelling stay loopback-only. `opts.tls.spkiPin` (S23) is the
   * optional gateway+http+https certificate pin forwarded to proxy-forward. */
  registerTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>, opts?: InstanceTransportRegistrationOptions): void
  unregisterTransport(connectionId: string): void
  getDiagnostics(): InstanceProxyDiagnostics
  /** Force-close every spliced WS stream (control-plane stop): an upgraded
   * socket leaves the HTTP server's connection tracking, so a lingering
   * half-open downlink would otherwise hang server.close() forever. */
  closeAllStreams(): void
}

/** Main-process-only facts used to validate a ready transport registration.
 * The dimension is explicit because a canonical `dsh:<id>` identifies target
 * semantics, not whether its ready URL came from an SSH tunnel or HTTP direct. */
export interface InstanceTransportRegistrationOptions {
  transport?: 'ssh' | 'http'
  tls?: { spkiPin?: string }
  authority?: string
}

/** Whether an id is a valid /api/i/<id> segment ('local', 'dsh-<id>' or
 * 'gateway-<id>'; 'ssh-<id>' is accepted as the legacy spelling of the dsh
 * kind — design 17 §2.2 keeps the old source ids deep-linkable). */
export function parseInstanceId(id: string): 'local' | 'dsh' | 'gateway' | null {
  if (id === 'local') return 'local'
  if (/^dsh-[a-zA-Z0-9_-]{1,64}$/.test(id)) return 'dsh'
  if (/^gateway-[a-zA-Z0-9_-]{1,64}$/.test(id)) return 'gateway'
  if (/^ssh-[a-zA-Z0-9_-]{1,64}$/.test(id)) return 'dsh' // legacy alias
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

/** Design 17 reserves the root `/chamber` namespace for gateway targets.
 * Normalize URL dot segments, backslashes and a bounded number of percent-
 * encoding layers so a dsh target cannot reach the namespace through an
 * alternate request-target spelling that `new URL()` later canonicalizes. */
function targetsChamberNamespace(rawPath: string): boolean {
  let candidate = rawPath
  for (let depth = 0; depth < 4; depth += 1) {
    candidate = candidate.replace(/\\/g, '/')
    let pathname: string
    try {
      // Concatenate under a fixed dummy authority instead of resolving a
      // `//...` path as a protocol-relative URL (repeated/backslash-derived
      // slashes are path syntax here, never an authority switch).
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
  /** connectionId ('dsh:<id>' / 'gateway:<id>'; 'ssh:<id>' legacy alias of
   * the dsh kind) → target record (design 05 §3.3 + design 17 §9.3). Local
   * is never registered — its baseUrl is derived from the managed dshPort. A
   * gateway record carries the optional bounded extra headers (Authorization
   * Bearer / Cookie dsh_gateway_session) injected at forward time, never in
   * the registry, and the optional https SPKI certificate pin (S23) applied
   * by proxy-forward to every outbound connection to the target. */
  interface TransportRecord { baseUrl: string; headers?: Record<string, string>; tls?: { spkiPin?: string }; authority?: string }
  const transports = new Map<string, TransportRecord>()
  const counters: ProxyForwardCounters = { requests: 0, failures: 0, activeStreams: 0, bufferedRequestBytes: 0 }
  let activeHttpRequests = 0
  let pendingUpgrades = 0
  /** Live spliced WS streams (downstream browser leg + upstream host leg),
   * tracked so control-plane stop() can force-close them: an upgraded socket
   * is removed from the HTTP server's connection tracking, so a lingering
   * half-open downlink (crashed host mid-reconnect) would otherwise hang
   * server.close() forever. */
  const liveStreams = new Set<ProxyLiveStream>()
  /** In-flight HTTP/SSE and WS handshakes keyed by transport. Revocation must
   * terminate traffic already authenticated with the old transport/token;
   * deleting only the routing-table row would leave those channels alive. */
  const liveHttpByTransport = new Map<string, Set<ProxyResponse>>()
  const liveUpgradeByTransport = new Map<string, Set<ProxySocket>>()

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

  function trackUpgrade(connectionId: string, socket: ProxySocket): void {
    const sockets = liveUpgradeByTransport.get(connectionId) ?? new Set<ProxySocket>()
    sockets.add(socket)
    liveUpgradeByTransport.set(connectionId, sockets)
    socket.on('close', () => {
      sockets.delete(socket)
      if (sockets.size === 0) liveUpgradeByTransport.delete(connectionId)
    })
  }

  function revokeTransportTraffic(connectionId: string): void {
    const responses = liveHttpByTransport.get(connectionId)
    liveHttpByTransport.delete(connectionId)
    for (const res of responses ?? []) {
      try { res.destroy() } catch { /* already closed */ }
    }
    const sockets = liveUpgradeByTransport.get(connectionId)
    liveUpgradeByTransport.delete(connectionId)
    for (const socket of sockets ?? []) {
      try { socket.destroy() } catch { /* already closed */ }
    }
    for (const stream of [...liveStreams]) {
      if (stream.ownerId !== connectionId) continue
      try { stream.downstream.destroy() } catch { /* already closed */ }
      try { stream.upstream.destroy() } catch { /* already closed */ }
    }
  }

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
      if ((deps.canExposeLocal?.() ?? true)
        && getLocalState() === 'ready'
        && Number.isInteger(getLocalDshPort())
        && (getLocalDshPort() ?? 0) > 0) {
        return { baseUrl: `http://127.0.0.1:${getLocalDshPort()}` }
      }
      if (res !== null) writeError(res, 503, 'instance_unavailable', 'the local instance is not ready', logger)
      return null
    }
    // dsh-<id> → dsh:<id>; gateway-<id> → gateway:<id>; ssh-<id> → ssh:<id>
    // (legacy alias of the dsh kind, kept for migrated registrations).
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
      // Target semantics are enforced in the proxy core, not only by hiding
      // settings rows (design 17 §2.1/§3): local/dsh/legacy-ssh sources have
      // no gateway-owned `/chamber/*` capability. A user-configured dsh+http
      // endpoint therefore cannot smuggle that namespace into the renderer.
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
        await forwardHttp(req, res, forwardTarget, releaseRequest, logger, counters, {
          ...forwardDeps,
          id: parsed.id,
          responseBasePath: `/api/i/${parsed.id}`,
          ...(connectionId === null ? {} : { streamOwner: connectionId }),
        }, target.headers, target.tls, target.authority)
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
      const connectionId = connectionIdForInstance(parsed.id)
      if (connectionId !== null) trackUpgrade(connectionId, socket)
      let released = false
      const releaseHandshake = () => {
        if (released) return
        released = true
        pendingUpgrades = Math.max(0, pendingUpgrades - 1)
      }
      try {
        const forwardTarget = new URL(`${target.baseUrl}${parsed.rest}${parsed.search}`)
        await forwardUpgrade(req, socket, head, forwardTarget, releaseHandshake, logger, counters, {
          ...forwardDeps,
          id: parsed.id,
          ...(connectionId === null ? {} : { streamOwner: connectionId }),
        }, target.headers, target.tls, target.authority)
      } catch (error) {
        releaseHandshake()
        counters.failures += 1
        logger.warn(`instance-proxy: upgrade setup failed: ${String(error)}`)
        rejectUpgrade(socket, 502, 'upstream_failed', 'upstream WebSocket setup failed', logger)
      }
    },

    /**
     * Register a remote instance transport (design 05 §3.3 + design 17 §9.3):
     * the desktop main process reports a ready target as connectionId
     * `dsh:<id>` or `gateway:<id>` plus the independent `opts.transport`
     * dimension (legacy `ssh:<id>` spelling remains SSH-only). Re-registration
     * replaces the previous baseUrl/headers (tunnel re-established on a new
     * port) and revokes traffic already authenticated through the old record.
     */
    registerTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>, opts?: InstanceTransportRegistrationOptions) {
      if (typeof connectionId !== 'string' || connectionId === '' || typeof baseUrl !== 'string' || baseUrl === '') {
        throw new TypeError('registerInstanceTransport: connectionId and baseUrl must be non-empty strings')
      }
      // dsh:<id> / gateway:<id>; ssh:<id> stays accepted as the legacy
      // spelling of the dsh kind (design 17 §2.2 migration keeps old tunnel
      // connectionIds valid).
      if (!/^(dsh|gateway|ssh):[a-zA-Z0-9_-]{1,64}$/.test(connectionId)) {
        throw new TypeError('registerInstanceTransport: connectionId must be "dsh:<id>", "gateway:<id>" or the legacy "ssh:<id>"')
      }
      let target: URL
      try {
        target = new URL(baseUrl)
      } catch {
        // Never reflect the rejected value: URL parser errors may include
        // userinfo or query credentials verbatim.
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
        // Target kind and transport are independent (design 17 §2.1/§7):
        // dsh+http is a direct origin and may be non-loopback; dsh+ssh and
        // the legacy ssh spelling remain a loopback tunnel. Missing transport
        // intentionally keeps the historical fail-closed SSH interpretation.
        if (!isOrigin) {
          throw new TypeError(transport === 'http'
            ? 'registerInstanceTransport: dsh baseUrl must be an origin (no credentials/path/query)'
            : 'registerInstanceTransport: ssh baseUrl must be a loopback origin')
        }
        if (transport !== 'http' && target.protocol !== 'http:') {
          throw new TypeError('registerInstanceTransport: ssh baseUrl must be an HTTP loopback origin')
        }
        if (transport !== 'http'
          && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname)) {
          throw new TypeError('registerInstanceTransport: ssh baseUrl must be a loopback origin')
        }
        // dsh targets never carry credentials: no header injection, ever
        // (design 17 §2.1 — kind decides target semantics, not transport).
        if (extraHeaders !== undefined) {
          throw new TypeError('registerInstanceTransport: dsh transports cannot inject request headers')
        }
      } else {
        // gateway: http(s) origin, non-loopback allowed (design 17 §9.3; http
        // = the user's explicit insecureHttp choice, https = the default).
        if (!isOrigin) {
          throw new TypeError('registerInstanceTransport: gateway baseUrl must be an origin (no credentials/path/query)')
        }
        if (transport === 'ssh' && target.protocol !== 'http:') {
          throw new TypeError('registerInstanceTransport: an ssh-tunneled gateway baseUrl must be an HTTP loopback origin')
        }
        if (transport === 'ssh'
          && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname)) {
          throw new TypeError('registerInstanceTransport: ssh baseUrl must be a loopback origin')
        }
        // 0..2 sanctioned headers, each bounded and whitelist-checked:
        // Authorization (Bearer) and Cookie (dsh_gateway_session) — anything
        // else, duplicates or unbounded values are rejected.
        const entries = extraHeaders === undefined ? [] : Object.entries(extraHeaders)
        const injected: Record<string, string> = {}
        for (const [name, rawValue] of entries) {
          const lower = name.toLowerCase()
          if (lower === 'authorization') {
            if (injected.authorization !== undefined) {
              throw new TypeError('registerInstanceTransport: gateway Authorization may be given at most once')
            }
            if (typeof rawValue !== 'string' || !/^Bearer [\x20-\x7e]{32,4096}$/.test(rawValue)) {
              throw new TypeError('registerInstanceTransport: gateway Authorization Bearer credential must contain 32–4096 visible-ASCII characters')
            }
            injected.authorization = rawValue
          } else if (lower === 'cookie') {
            if (injected.cookie !== undefined) {
              throw new TypeError('registerInstanceTransport: gateway Cookie may be given at most once')
            }
            if (typeof rawValue !== 'string' || !rawValue.startsWith('dsh_gateway_session=')
              || rawValue.length <= 'dsh_gateway_session='.length
              || rawValue.length > 'dsh_gateway_session='.length + 4096
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
      // S23: an SPKI certificate pin is a gateway-only, https-only gate
      // (design 17 §13.4.2) — a dsh/ssh target has no TLS trust decision to
      // pin, and http 模式无 TLS 层，pin 无意义且不得声称任何 TLS 保护. Format
      // mirrors the spec gate (64-hex sha256, case-insensitive compare at
      // verify time).
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
      // Tunnel Host override (design 17 §9.3 隧道 Host 覆盖): an ssh-tunneled
      // gateway target connects to the loopback tunnel endpoint but must
      // present the gateway's REMOTE loopback-listener authority in Host — the
      // gateway's request policy requires the authority port to equal its own
      // listen port, which the tunnel's local port can never satisfy. The
      // override is gateway-only (a dsh target has no Host policy to satisfy)
      // and shape-bounded: a host[:port] authority without path/query/
      // userinfo/fragment.
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
      // Clone the only sanctioned headers so caller mutation cannot alter a
      // live transport after validation.
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
