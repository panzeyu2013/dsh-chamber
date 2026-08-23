/**
 * The gateway single-target reverse proxy (design 17 §6): the browser/desktop
 * entry point for ONE local dsh — forwards `/`, `/plugins/*` and every
 * non-management `/api/*` verbatim to `http://127.0.0.1:<localDshPort>` with
 * the SAME Host/Origin rewrite, WS splice, limits and error semantics as the
 * control-plane's per-instance proxy (shared `proxy-forward.ts`, design 17
 * §6.2 方案 A). Unlike instance-proxy, there is no `/api/i/<id>` prefix and no
 * transports table: the target is always the managed local dsh.
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
  forwardHttp,
  forwardUpgrade,
  rejectUpgrade,
  writeError,
  type Logger,
  type ProxyForwardCounters,
  type ProxyForwardDeps,
  type ProxyRequest,
  type ProxyResponse,
  type ProxySocket,
} from '@dsh-chamber/control-plane'

export interface GatewayProxyDeps {
  logger: Logger
  /** The managed local dsh port; null = not ready (503 instance_unavailable). */
  getLocalDshPort(): number | null
  /** The managed local dsh state ('ready' when serviceable). */
  getLocalState(): string
}

export interface GatewayProxyDiagnostics {
  requests: number
  failures: number
  activeStreams: number
  activeHttpRequests: number
  pendingUpgrades: number
  bufferedRequestBytes: number
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
  }
  let activeHttpRequests = 0
  let pendingUpgrades = 0
  const liveStreams = new Set<{ downstream: ProxySocket; upstream: Duplex }>()

  const forwardDeps: ProxyForwardDeps = {
    id: 'local',
    logPrefix: 'gateway-proxy',
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    clientBodyIdleTimeoutMs: CLIENT_BODY_IDLE_TIMEOUT_MS,
    wsPingIntervalMs: WS_PING_INTERVAL_MS,
    wsPingMissesBeforeTeardown: WS_PING_MISSES_BEFORE_TEARDOWN,
    maxBufferedRequestBytes: MAX_BUFFERED_REQUEST_BYTES,
    liveStreams,
    // Root-mounted owner (design 17 §6): same-origin absolute redirects from
    // the managed dsh are stripped to their path so a `Location:
    // http://127.0.0.1:<port>/…` can never escape the public origin.
    responseBasePath: '',
  }

  /** Resolve the single target (the local dsh loopback origin). Loud 503 when
   * the instance is not ready (proxy honesty — never a silent empty success). */
  function resolveTarget(res: ProxyResponse | null): URL | null {
    const port = getLocalDshPort()
    if (getLocalState() === 'ready' && Number.isInteger(port) && (port ?? 0) > 0) {
      return new URL(`http://127.0.0.1:${port}`)
    }
    if (res !== null) writeError(res, 503, 'instance_unavailable', 'the local dsh instance is not ready', logger)
    return null
  }

  /** Refuse non-origin-form request targets (SSRF guard): Node's parser
   * accepts absolute-form (`GET http://evil/x`) and protocol-relative
   * (`//evil/x`) request lines; `new URL(raw, target)` would silently discard
   * `target` and forward to the attacker host. Only origin-form (leading `/`)
   * may be forwarded. */
  function parsePathTarget(reqUrl: string | undefined, target: URL): URL | null {
    const raw = reqUrl ?? '/'
    // Only origin-form may be forwarded: leading '/' but NOT '//' (a
    // protocol-relative URL `//evil/x` starts with '/' yet resolves to
    // `http://evil/x`), never an absolute-form `http://evil/x`, and no
    // backslash. WHATWG treats `/\\evil/x` as an authority switch too.
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
      // Full passthrough: the target carries the ORIGINAL path+query (no
      // /api/i/<id> prefix to strip — single instance).
      const fullTarget = parsePathTarget(req.url, target)
      if (fullTarget === null) {
        counters.failures += 1
        writeError(res, 400, 'invalid_request', 'absolute request targets are not allowed', logger)
        return
      }
      activeHttpRequests += 1
      let released = false
      const releaseRequest = (): void => {
        if (released) return
        released = true
        activeHttpRequests = Math.max(0, activeHttpRequests - 1)
      }
      try {
        await forwardHttp(req, res, fullTarget, releaseRequest, logger, counters, forwardDeps)
      } catch (error) {
        releaseRequest()
        counters.failures += 1
        logger.warn(`gateway-proxy: request setup failed: ${String(error)}`)
        if (!res.headersSent) writeError(res, 502, 'upstream_failed', 'upstream request failed', logger)
        else res.destroy()
      }
    },

    async handleUpgrade(req: ProxyRequest, socket: ProxySocket, head: Buffer): Promise<void> {
      // Only the two dsh downlink stream paths upgrade (design 03 §3.1).
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!WS_STREAM_PATHS.has(pathname)) {
        rejectUpgrade(socket, 404, 'instance_not_found', 'unknown WebSocket path', logger)
        return
      }
      counters.requests += 1
      if (counters.activeStreams >= MAX_CONCURRENT_WS_STREAMS || pendingUpgrades >= MAX_PENDING_WS_HANDSHAKES) {
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
        counters.failures += 1
        rejectUpgrade(socket, 400, 'invalid_request', 'absolute request targets are not allowed', logger)
        return
      }
      pendingUpgrades += 1
      let released = false
      const releaseHandshake = (): void => {
        if (released) return
        released = true
        pendingUpgrades = Math.max(0, pendingUpgrades - 1)
      }
      try {
        await forwardUpgrade(req, socket, head, fullTarget, releaseHandshake, logger, counters, forwardDeps)
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
        pendingUpgrades,
        bufferedRequestBytes: counters.bufferedRequestBytes,
      }
    },

    closeAllStreams(): void {
      for (const stream of [...liveStreams]) {
        try { stream.downstream.destroy() } catch { /* already gone */ }
        try { stream.upstream.destroy() } catch { /* already gone */ }
      }
    },
  }
}
