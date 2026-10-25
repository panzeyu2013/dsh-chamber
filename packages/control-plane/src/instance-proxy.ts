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
import { isServiceableLocalState } from './local-connection.ts'
import {
  GATEWAY_SESSION_COOKIE_NAME,
  GATEWAY_SESSION_COOKIE_VALUE_MAX_CHARS,
  GATEWAY_TOKEN_MAX_CHARS,
  GATEWAY_TOKEN_MIN_CHARS,
} from './gateway-session-protocol.ts'
import { isLoopbackHostname, isLoopbackUpstreamBaseUrl } from './loopback.ts'
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
  createProxyAgentPair,
  forwardHttp,
  forwardUpgrade,
  rejectUpgrade,
  SPKI_PIN_PATTERN,
  UPSTREAM_BODY_FINISHED,
  writeError,
} from './proxy-forward.ts'
import type { Logger } from './types.ts'
import type {
  HttpRequestFactory,
  ProxyForwardCounters,
  ProxyForwardDeps,
  ProxyLiveStream,
  ProxyAgentPair,
  ProxyRequest,
  ProxyResponse,
  ProxySocket,
} from './proxy-forward.ts'

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
  /** The managed local instance state ('ready'|'degraded' are serviceable, design 02 §3.5). */
  getLocalState(): string
  /** The managed local instance port (null while stopped/spawn-failed). */
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
  /** Upstream request-body idle budget (default UPLOAD_IDLE_TIMEOUT_MS). */
  uploadIdleTimeoutMs?: number
  /** Minimum throughput used to derive the total upload budget. */
  uploadMinBytesPerSec?: number
  /** Hard cap on the total upload budget. */
  uploadMaxBudgetMs?: number
  /** WebSocket heartbeat ping cadence in ms. */
  wsPingIntervalMs?: number
  /** Overrides WS_PING_MISSES_BEFORE_TEARDOWN (see proxy-forward.ts). */
  wsPingMissesBeforeTeardown?: number
  maxConcurrentHttpRequests?: number
  maxConcurrentWsStreams?: number
  maxPendingWsHandshakes?: number
  maxBufferedRequestBytes?: number
  /** Downlink activity window that keeps the link "busy" (default 2s; tests that
   *  must not sleep 2s override it). */
  busyActivityWindowMs?: number
}

/** The instance-proxy surface. */
export interface InstanceProxy {
  handleHttp(req: ProxyRequest, res: ProxyResponse): Promise<void>
  handleUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer): Promise<void>
  /** `opts.transport` preserves the target/transport split: dsh+http may use a direct
   *  non-loopback origin, while dsh+ssh and the legacy spelling stay loopback-only.
   *  `opts.tls.spkiPin` is the optional gateway+http+https certificate pin. */
  registerTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>, opts?: InstanceTransportRegistrationOptions): void
  /** Update the ready-state link health without replacing the transport or revoking
   *  in-flight traffic. `down` makes NEW requests fail fast with the existing
   *  instance_unavailable 503; `suspect` still forwards. */
  setTransportHealth(connectionId: string, health: InstanceTransportHealth): boolean
  unregisterTransport(connectionId: string): void
  /** True while OUR OWN traffic owns this connection: a bulk upload flushing
   *  (request body >= BULK_TRANSFER_BYTES) or a downstream body that delivered
   *  bytes inside the activity window. The transport manager treats a probe
   *  timeout in that window as congestion, never as link death. Takes the
   *  connectionId — the same key every other transport method uses. */
  isLinkBusy(connectionId: string): boolean
  /** Report downstream bytes delivered OUTSIDE this proxy's own forward paths (the
   *  page-channel multiplex) into the same busy window. */
  noteDownlink(connectionId: string, bytes: number): void
  getDiagnostics(): InstanceProxyDiagnostics
  /** Force-close every spliced WS stream (control-plane stop): an upgraded socket
   *  leaves the HTTP server's connection tracking, so a lingering half-open downlink
   *  would hang server.close() forever. */
  closeAllStreams(): void
  /** Resolve one instance id to its forward target WITHOUT writing any HTTP error
   *  (the page channel's per-subscription path has no response to write): the same
   *  local/dsh/gateway resolution as the proxy, `null` where resolveTarget would
   *  answer 503. The returned record is a DEFENSIVE COPY, so a caller cannot mutate
   *  a live transport registration. `connectionId` is the SAME string
   *  revokeTransportTraffic receives ('dsh:<id>' / 'gateway:<id>' / legacy
   *  'ssh:<id>'); it is absent for `local`, which is never registered as a transport
   *  and therefore never revoked. */
  resolveTargetFor(instanceId: string): { baseUrl: string; connectionId?: string; headers?: Record<string, string>; tls?: { spkiPin?: string }; authority?: string; health?: InstanceTransportHealth } | null
  /** Transport replacement/removal notification. Traffic that lives OUTSIDE the
   *  proxy's own tracking (the page channel opens one http.request per subscription)
   *  is invisible to revokeTransportTraffic, so an owner such as the page channel
   *  registers here to fail its subscriptions for the replaced connectionId. */
  onTransportRevoked(listener: (connectionId: string) => void): void
  /** Transport-level upstream failure (no completed HTTP answer) for one
   *  connection: fresh evidence for the failure-driven re-probe. Emits the
   *  connectionId, the transport identity every other method here uses. */
  onUpstreamFailure(listener: (connectionId: string) => void): void
}

/** Main-process-only facts used to validate a ready transport registration. The
 * dimension is explicit because a canonical `dsh:<id>` identifies target semantics,
 * not whether its ready URL came from an SSH tunnel or HTTP direct. */
export type InstanceTransportHealth = 'healthy' | 'suspect' | 'down'

export interface InstanceTransportRegistrationOptions {
  transport?: 'ssh' | 'http'
  tls?: { spkiPin?: string }
  authority?: string
  /** Initial ready-state health; omitted = healthy (old registrations). */
  health?: InstanceTransportHealth
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
  interface TransportRecord {
    baseUrl: string
    headers?: Record<string, string>
    tls?: { spkiPin?: string }
    authority?: string
    health: InstanceTransportHealth
  }
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
  /** Landlords of traffic the proxy does not track itself (the page channel's
   *  per-subscription upstreams); notified from inside revokeTransportTraffic. */
  const transportRevokedListeners = new Set<(connectionId: string) => void>()
  /** Listeners for "the upstream never answered" (see onUpstreamFailure in the
   *  forwarding deps): the desktop turns this into ONE forced identity probe so a
   *  half-open link is detected in ~1s instead of waiting for the 60s heartbeat. */
  const upstreamFailureListeners = new Set<(connectionId: string) => void>()
  /**
   * Per-connection keep-alive pools (design 27 §3.3). A process-wide pool kept
   * every replaced tunnel's sockets forever: each reconnect binds a NEW loopback
   * port, so the old entries could never be reused, and a half-open socket could
   * be handed to the next incarnation. Destroying the pool together with the
   * connection's revocation is exact — those sockets belong to the traffic being
   * torn down anyway.
   */
  const agentPairs = new Map<string, ProxyAgentPair>()
  /**
   * In-flight BULK request bodies per connection. Our own upload owns the single
   * SSH TCP, so a probe that times out inside that window proves congestion, not
   * link loss; the manager only counts probe failures when this is 0. The window
   * is bounded by the upload idle/total budgets, so a stalled upload cannot
   * suppress the verdict forever.
   */
  const bulkTransfers = new Map<string, number>()

  function connectionIdForInstance(id: string): string | null {
    if (id === 'local') return null
    const separator = id.indexOf('-')
    return `${id.slice(0, separator)}:${id.slice(separator + 1)}`
  }

  /**
   * Per-connection incarnation counter. A request captures the generation when it
   * starts; its late progress/failure callbacks must not be attributed to the NEW
   * incarnation after a same-id replacement (the old generation's in-flight chunk
   * would otherwise mark the new link busy, or force a probe on it, for up to the
   * activity window).
   */
  const transportGenerations = new Map<string, number>()
  function generationOf(connectionId: string | null): number {
    return connectionId === null ? 0 : (transportGenerations.get(connectionId) ?? 0)
  }

  function notifyUpstreamFailure(connectionId: string, generation: number): void {
    if (upstreamFailureListeners.size === 0) return
    if (generation !== generationOf(connectionId)) return
    for (const listener of upstreamFailureListeners) {
      try {
        // The connectionId is the transport identity: the owner maps it to its own
        // instance id (a conversion that must never be re-invented per call site).
        listener(connectionId)
      } catch (error) {
        logger.warn(`instance-proxy: upstream-failure listener failed: ${String(error)}`)
      }
    }
  }

  /** A body at or above this size is OUR bulk upload: while it flushes, a probe
   *  timeout is congestion (the probe shares the tunnel's single TCP), never a
   *  link-death verdict. Smaller RPC bodies are too brief to mislead. */
  const BULK_TRANSFER_BYTES = 256 * 1024

  /** A response that delivered bytes within this window means our OWN downlink is
   *  flowing right now (a large download saturates the tunnel exactly like a bulk
   *  upload). A probe timeout in that window is queueing, not death. The window is
   *  short on purpose: a dead link stops delivering bytes within it, so a genuinely
   *  gone link is classified again a couple of seconds after the transfer stalls.
   *  Overridable for the tests that must not sleep 2s. */
  const BUSY_ACTIVITY_WINDOW_MS = 2_000
  const activityWindowMs = deps.busyActivityWindowMs ?? BUSY_ACTIVITY_WINDOW_MS
  /** Epoch-ms of the last downstream byte per connection. */
  const lastDownlinkAt = new Map<string, number>()

  /** The pool key for a request target: registered connections use their
   *  connectionId, the unregistered local instance gets one dedicated pool (it had
   *  keep-alive before the per-connection split and must keep it). */
  const LOCAL_AGENT_POOL = 'local'
  function agentsFor(connectionId: string | null): ProxyAgentPair {
    const key = connectionId ?? LOCAL_AGENT_POOL
    const existing = agentPairs.get(key)
    if (existing !== undefined) return existing
    const created = createProxyAgentPair()
    agentPairs.set(key, created)
    return created
  }

  function releaseConnectionPool(connectionId: string): void {
    bulkTransfers.delete(connectionId)
    lastDownlinkAt.delete(connectionId)
    // The incarnation counter is per LIVE registration; a stale capture must never be
    // able to write after the connection is gone (a re-registration starts from 1).
    transportGenerations.delete(connectionId)
    const pair = agentPairs.get(connectionId)
    if (pair === undefined) return
    agentPairs.delete(connectionId)
    try {
      pair.destroy()
    } catch (error) {
      logger.warn(`instance-proxy: destroying the ${connectionId} upstream pool failed: ${String(error)}`)
    }
  }

  /** Downstream progress is the second busy signal (an upload-only window let a
   *  large download's queueing time out the probe and mark a healthy link down). */
  function trackDownlink(connectionId: string | null, generation: number, bytes: number): void {
    if (connectionId === null || bytes <= 0) return
    // Registered AND same incarnation: a chunk from the replaced generation must not
    // re-seed the map or mark the new link busy.
    if (!transports.has(connectionId) || generation !== generationOf(connectionId)) return
    lastDownlinkAt.set(connectionId, Date.now())
  }

  function trackBulkTransfer(connectionId: string | null, generation: number, delta: 1 | -1, bytes: number): void {
    if (connectionId === null || bytes < BULK_TRANSFER_BYTES) return
    if (generation !== generationOf(connectionId)) return
    const next = Math.max(0, (bulkTransfers.get(connectionId) ?? 0) + delta)
    if (next === 0) bulkTransfers.delete(connectionId)
    else bulkTransfers.set(connectionId, next)
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
      // If the request body already left the writable queue, the host may have
      // applied a mutation. Answer a classified after-body failure before tearing
      // the socket down; a bare destroy would look retryable to the client.
      if (!res.headersSent && (res as ProxyResponse & { [UPSTREAM_BODY_FINISHED]?: boolean })[UPSTREAM_BODY_FINISHED] === true) {
        try {
          writeError(
            res,
            502,
            'upstream_failed',
            'the instance transport was replaced after the request body was sent; the host may have applied it',
            logger,
            { phase: 'after-body' },
          )
          continue
        } catch { /* fall through to destroy */ }
      }
      try { res.destroy() } catch { /* already closed */ }
    }
    pendingUpgrades.closeAll(connectionId)
    for (const stream of [...liveStreams]) {
      if (stream.ownerId !== connectionId) continue
      try { stream.downstream.destroy() } catch { /* already closed */ }
      try { stream.upstream.destroy() } catch { /* already closed */ }
    }
    // Every revocation path (registerTransport replacement, unregisterTransport)
    // goes through here; the listener must never be able to break the others.
    for (const listener of transportRevokedListeners) {
      try {
        listener(connectionId)
      } catch (error) {
        logger.warn(`instance-proxy: transport-revoked listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
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
    ...(deps.uploadIdleTimeoutMs === undefined ? {} : { uploadIdleTimeoutMs: deps.uploadIdleTimeoutMs }),
    ...(deps.uploadMinBytesPerSec === undefined ? {} : { uploadMinBytesPerSec: deps.uploadMinBytesPerSec }),
    ...(deps.uploadMaxBudgetMs === undefined ? {} : { uploadMaxBudgetMs: deps.uploadMaxBudgetMs }),
    wsPingIntervalMs,
    wsPingMissesBeforeTeardown,
    maxBufferedRequestBytes,
    liveStreams,
  }

  /** Resolve the forward target; returns null + writes the error response when the
   *  instance is unknown/unavailable (loud, never silent). */
  function resolveTarget(id: string, res: ProxyResponse | null): TransportRecord | null {
    if (id === 'local') {
      const state = getLocalState()
      // `degraded` still serves (design 02 §3.5): one failed health probe must
      // not black out every request. `restarting` stays refused: it keeps the old
      // port, which may name the dead child, so port liveness never substitutes
      // for the state table (`starting` has already cleared its port).
      const exposed = deps.canExposeLocal?.() ?? true
      if (exposed
        && isServiceableLocalState(state)
        && Number.isInteger(getLocalDshPort())
        && (getLocalDshPort() ?? 0) > 0) {
        return { baseUrl: `http://127.0.0.1:${getLocalDshPort()}`, health: 'healthy' }
      }
      if (res !== null) {
        // While the activation gate is closed the state belongs to a quarantined
        // candidate: that lifecycle is an INTERNAL fact and must not escape the
        // public error face (index.ts keeps /health at 'starting' for it).
        writeError(res, 503, 'instance_unavailable', 'the local instance is not ready', logger, exposed ? { state } : undefined)
      }
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

  /** resolveTargetFor: the read-only twin of resolveTarget (null instead of a 503 write).
   *  The registration record is COPIED field by field (including the header map) so a
   *  caller such as the page channel can never mutate a live transport — a transport is
   *  replaced/revoked underneath at any time. */
  function resolveTargetFor(instanceId: string): (TransportRecord & { connectionId?: string }) | null {
    const record = resolveTarget(instanceId, null)
    if (record === null) return null
    const connectionId = connectionIdForInstance(instanceId)
    return {
      baseUrl: record.baseUrl,
      health: record.health,
      ...(connectionId === null ? {} : { connectionId }),
      ...(record.headers === undefined ? {} : { headers: { ...record.headers } }),
      ...(record.tls === undefined ? {} : { tls: { ...record.tls } }),
      ...(record.authority === undefined ? {} : { authority: record.authority }),
    }
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
      // A DOWN link is fast-failed with the existing instance_unavailable code;
      // suspect still forwards. No new wire code, no in-flight revoke here.
      if (target.health === 'down') {
        counters.failures += 1
        writeError(res, 503, 'instance_unavailable', 'the instance link is down', logger)
        return
      }
      activeHttpRequests += 1
      const connectionId = connectionIdForInstance(parsed.id)
      // Captured at dispatch: late progress/failure callbacks of this request must not
      // be attributed to a replacement incarnation of the same connectionId.
      const generation = generationOf(connectionId)
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
          agents: agentsFor(connectionId),
          ...(connectionId === null ? {} : {
            streamOwner: connectionId,
            onBodyTransfer: (delta: 1 | -1, bytes: number) => trackBulkTransfer(connectionId, generation, delta, bytes),
            onResponseProgress: (bytes: number) => trackDownlink(connectionId, generation, bytes),
            onUpstreamFailure: () => notifyUpstreamFailure(connectionId, generation),
          }),
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
        rejectUpgrade(socket, 503, 'instance_unavailable', parsed.id === 'local' ? 'the local instance is not ready' : 'no tunnel is available for this instance', logger)
        return
      }
      if (target.health === 'down') {
        counters.failures += 1
        rejectUpgrade(socket, 503, 'instance_unavailable', 'the instance link is down', logger)
        return
      }
      const connectionId = connectionIdForInstance(parsed.id)
      const generation = generationOf(connectionId)
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
          agents: agentsFor(connectionId),
          ...(connectionId === null ? {} : {
            streamOwner: connectionId,
            onUpstreamFailure: () => notifyUpstreamFailure(connectionId, generation),
            onResponseProgress: (bytes: number) => trackDownlink(connectionId, generation, bytes),
          }),
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
      // A same-id registration is a NEW incarnation: bump before the record so every
      // in-flight request of the old generation becomes stale for the trackers.
      transportGenerations.set(connectionId, (transportGenerations.get(connectionId) ?? 0) + 1)
      // Clone the sanctioned headers so caller mutation cannot alter a live transport after validation.
      if (transports.has(connectionId)) {
        revokeTransportTraffic(connectionId)
        // The replaced incarnation's pooled upstream sockets belong to traffic that
        // was just revoked; their loopback origin can never be reused.
        releaseConnectionPool(connectionId)
      }
      transports.set(connectionId, {
        baseUrl,
        health: opts?.health ?? 'healthy',
        ...(extraHeaders !== undefined ? { headers: { ...extraHeaders } } : {}),
        ...(tlsSpkiPin === undefined ? {} : { tls: { spkiPin: tlsSpkiPin } }),
        ...(authority === undefined ? {} : { authority }),
      })
      logger.log(`instance-proxy: transport registered ${connectionId}`)
    },

    /** Update ready-state health without touching the registration or in-flight traffic. */
    setTransportHealth(connectionId: string, health: InstanceTransportHealth): boolean {
      const record = transports.get(connectionId)
      if (record === undefined || record.health === health) return false
      record.health = health
      logger.log(`instance-proxy: transport ${connectionId} health ${health}`)
      return true
    },

    /** Unregister a remote instance transport (tunnel torn down). */
    unregisterTransport(connectionId: string) {
      const removed = transports.delete(connectionId)
      revokeTransportTraffic(connectionId)
      releaseConnectionPool(connectionId)
      if (removed) {
        logger.log(`instance-proxy: transport unregistered ${connectionId}`)
      }
    },

    /** Resolve one instance id to its forward target without writing an error response
     *  (see the interface doc); null = unknown/unavailable instance. */
    resolveTargetFor,

    /** Register a revocation listener (see the interface doc). */
    onTransportRevoked(listener: (connectionId: string) => void) {
      transportRevokedListeners.add(listener)
    },

    /** Register the "upstream never answered" listener (see the interface doc). */
    onUpstreamFailure(listener: (connectionId: string) => void) {
      upstreamFailureListeners.add(listener)
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

    /** Downstream bytes from a path outside this proxy (page-channel): same window.
     *  The caller passes no generation: the page channel is not incarnation-scoped and
     *  its subscriptions are failed on revocation, so the CURRENT generation is right. */
    noteDownlink(connectionId: string, bytes: number) {
      trackDownlink(connectionId, generationOf(connectionId), bytes)
    },

    /** True while our own traffic owns this connection: a bulk upload flushing, or a
     *  downstream body that delivered bytes inside the activity window. */
    isLinkBusy(connectionId: string): boolean {
      if ((bulkTransfers.get(connectionId) ?? 0) > 0) return true
      const last = lastDownlinkAt.get(connectionId)
      return last !== undefined && Date.now() - last < activityWindowMs
    },

    /** Force-close every spliced WS stream (control-plane stop / app quit). */
    closeAllStreams(): void {
      for (const connectionId of [...agentPairs.keys()]) releaseConnectionPool(connectionId)
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
