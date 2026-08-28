/**
 * REST HTTP surface for renderer/desktop clients (v4 management plane).
 *
 * Contract (04-control-plane-api-data.md §3, verbatim for renderer/desktop):
 * - GET /health → {ok:true, dsh:{status:'stopped'|'starting'|'ready'|'degraded'|
 *   'restarting'|'restart-exhausted'|'error', port, error?}}
 * - GET /api/connections → {connection:{id:'local', label?, accentColor?,
 *   status, dshPort?}} — the single local connection row projection
 * - POST /api/connections {kind:'local', label?, accentColor?} → idempotent
 *   start {connection, spawned:boolean}; 400 connection_kind_unsupported
 *   for any other kind (remote instances live in the desktop registry, 04
 *   §2.2); 503 dsh_not_ready when the spawn failed
 * - PATCH /api/connections/local {label?, accentColor?} → {connection};
 *   400 connection_invalid_input; 404 when the row is absent
 * - DELETE /api/connections/local → {stopped:true} (graceful stop, the row
 *   stays); 409 connection_busy while restarting
 * - GET /api/host/logs?port=&limit=&offset= → {port, lines, truncated}
 *   (the managed-host rolling log, 02 §3.8)
 * - /api/i/<id>/* — per-instance reverse proxy (03 §3 / 04 §4), mounted
 *   here, directly reachable without any session.
 *
 * v1 has no authentication surface: every /api/* route and /health are
 * anonymous (no cookie/bearer gate, no passkey/audit routes — the v2-era
 * auth family is gone). The CORS decision is the only cross-origin control.
 *
 * Deleted with the thin-shell architecture (05 §3.2): sessions/projects/
 * session/interactions/events(SSE)/config/external/project-sessions routes —
 * session business belongs to the dsh frontend runtime, consumed through the
 * instance proxy.
 *
 * Browser-origin fence (same-origin + explicit allowlist — the only
 * cross-origin control in v1): an Origin-bearing request must match this
 * request's own loopback authority or the configured `corsOrigins` allowlist.
 * Merely being another localhost port grants no authority. Opaque origins
 * (`Origin: null`) are always rejected because
 * they can be produced by untrusted sandboxed/file documents; every
 * other origin is rejected with 403 before routing (blocking reads and
 * simple-request side effects). Unknown
 * paths answer 404 {error:'not_found'}; a body that is not JSON answers 400
 * {error:'bad_request'}.
 */

import type { InstanceProxy } from './instance-proxy.ts'
import type { Logger } from './types.ts'

/** Body read cap for POST payloads (10 MiB; the instance proxy has its own 300MiB cap). */
const MAX_BODY_BYTES = 10 * 1024 * 1024
/** Management body per-chunk idle timeout (2026 review). */
const BODY_IDLE_TIMEOUT_MS = 10_000
const MAX_HEALTH_EVENT_STREAMS = 32
/** Per-client frames retained while its SSE socket is backpressured. */
const MAX_HEALTH_EVENT_PENDING_FRAMES = 32

/** Hostnames treated as loopback for CORS (any port). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * The minimal request surface the HTTP layer reads. Structural on purpose:
 * both the node:http IncomingMessage (the real server) and the test doubles
 * satisfy it.
 */
export interface ApiRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, fn: () => void): unknown
  off(event: string, fn: () => void): unknown
  /** Abort the request stream (IncomingMessage.destroy); optional for fakes. */
  destroy?(): unknown
}

/**
 * The minimal response surface the HTTP layer writes. Structural on purpose:
 * both the node:http ServerResponse and the test doubles satisfy it.
 * `_corsHeaders` is this module's private per-request channel: the handle
 * entry stores the CORS decision and every write site spreads it.
 */
export interface ApiResponse {
  writeHead(statusCode: number, headers?: Record<string, string | number | string[] | undefined>): unknown
  end(payload?: unknown): unknown
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  write(chunk: unknown): boolean
  setHeader(name: string, value: unknown): unknown
  destroy(): unknown
  headersSent: boolean
  /** True once end() has been called (Node's ServerResponse; distinguishes a
   *  normal end from a mid-stream client disconnect on 'close'). */
  writableEnded: boolean
  _corsHeaders?: Record<string, string>
  /** Per-response CSP nonce minted by the owning HTTP server. */
  _cspNonce?: string
}

/**
 * The thrown-error shape the surface reads: plain Errors carrying optional
 * wire fields (code/statusCode/httpStatus/status/details) or a structured
 * {error: {status, code, message}} result object. Casts from `unknown`
 * catch blocks are runtime no-ops.
 */
export interface ApiError extends Error {
  code?: string
  statusCode?: number
  httpStatus?: number
  status?: number
  details?: unknown
  error?: { status?: number; code?: string; message?: string }
}

/** The connection-row projection on the wire (04 §3.2). */
export interface ConnectionRowView {
  id: string
  label?: string
  accentColor?: string
  status: string
  dshPort?: number
  error?: string
}

/** One matched route handler; `ownBody` opts out of the carrier 10MiB reader. */
interface RouteHandler {
  (body: any): Promise<void>
  ownBody?: boolean
}

/**
 * The createApi dependency contract. Fields are optional exactly where the
 * surface guards them with `=== undefined` — a missing dep is a 404 route,
 * never a crash.
 */
export interface ApiDeps {
  logger: Logger
  corsOrigins?: string[]
  getHealth(): { ok: boolean; dsh: { status: string; port: number; error?: string } }
  getConnectionRow(): ConnectionRowView | null
  startConnection(input: { kind: string; label?: string; accentColor?: string }): Promise<{ connection: ConnectionRowView | null; spawned: boolean }>
  updateConnectionProfile(input: { connectionId: string; label?: string; accentColor?: string }): Promise<ConnectionRowView | null>
  stopConnection(connectionId: string): Promise<unknown>
  hostLogs?(query: { port?: number; limit?: number; offset?: number }): Promise<unknown>
  instanceProxy?: InstanceProxy
  /**
   * Health-event subscription (GET /api/host/health-events, design 05 §3):
   * the renderer never polls for local status — every machine transition is
   * pushed as the /health `dsh` snapshot. Returns the unsubscribe.
   */
  subscribeHealthEvents?(listener: (snapshot: { status: string; port: number | null; error: string | null }) => void): () => void
}

/** The createApi return value: the HTTP surface handle. */
export interface ApiSurface {
  handle(req: ApiRequest, res: ApiResponse): Promise<void>
  getCorsHeaders(req: ApiRequest): { allowed: boolean; headers: Record<string, string> }
}

/**
 * The per-request CORS decision: {allowed, headers?}. Same-origin/CLI requests
 * (no Origin) need no CORS headers at all; allowed cross-origin requests get
 * the reflected origin + credentials; disallowed origins get neither and
 * are rejected by handle() before routing.
 * @param req - the request carrying the Origin header.
 * @param allowlist - configured explicit origins (deps.corsOrigins).
 */
function corsFor(req: ApiRequest, allowlist: string[]) {
  // Bind the browser-visible authority to this loopback service as well as
  // the initiator Origin. A DNS-rebound page is same-origin from the
  // browser's perspective and may omit Origin on reads, but its Host still
  // names the attacker's domain and cannot be forged by page script.
  const host = req.headers.host
  if (typeof host !== 'string') return { allowed: false }
  let requestOrigin: string
  try {
    const authority = new URL(`http://${host}`)
    if (!LOOPBACK_HOSTNAMES.has(authority.hostname)) return { allowed: false }
    if (authority.username !== '' || authority.password !== '' || authority.pathname !== '/'
      || authority.search !== '' || authority.hash !== '' || authority.host !== host.toLowerCase()) return { allowed: false }
    requestOrigin = authority.origin
  } catch {
    return { allowed: false }
  }
  const origin = req.headers.origin
  if (origin === undefined) return { allowed: true }
  // A single Origin value in practice; a malformed multi-value header is
  // treated as disallowed (never reflected).
  const originValue = typeof origin === 'string' ? origin : ''
  let allowed = false
  try {
    const parsed = new URL(originValue)
    // Origin is an origin, not an arbitrary URL whose `.origin` happens to
    // match. Reject paths, credentials and non-canonical spellings instead
    // of reflecting them into Access-Control-Allow-Origin.
    allowed = originValue === parsed.origin
      && (parsed.origin === requestOrigin || allowlist.includes(parsed.origin))
  } catch {
    allowed = false
  }
  if (!allowed) return { allowed: false }
  return {
    allowed: true,
    headers: {
      'access-control-allow-origin': originValue,
      'access-control-allow-credentials': 'true',
    },
  }
}

/**
 * Create the HTTP surface.
 * @param deps - {logger, getHealth, getConnectionRow, startConnection,
 *   updateConnectionProfile, stopConnection, hostLogs?, instanceProxy?,
 *   corsOrigins?}. `corsOrigins` is the explicit cross-origin allowlist;
 *   every route is anonymous (v1 has no authentication surface).
 * @returns {handle(req, res), getCorsHeaders(req)}.
 */
export function createApi(deps: ApiDeps) {
  const { logger } = deps
  const corsOrigins = Array.isArray(deps.corsOrigins) ? deps.corsOrigins : []
  let activeHealthEventStreams = 0

  /** The per-request CORS headers (explicit-origin discipline). */
  function corsHeaders(req: ApiRequest) {
    const decision = corsFor(req, corsOrigins)
    return { allowed: decision.allowed, headers: decision.headers ?? {} }
  }

  /** Send a JSON response with CORS headers. */
  function json(res: ApiResponse, status: number, body: unknown, extraHeaders?: Record<string, string>) {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', ...(res._corsHeaders ?? {}), ...(extraHeaders ?? {}) })
    res.end(payload)
  }

  /**
   * Send a plain-error body in the unified wire shape (design 04 D1):
   * `{error: string, code?: string}` — 4xx carries a displayable message;
   * 5xx never echoes upstream details (masked) except the safe dsh_not_ready.
   */
  function jsonError(res: ApiResponse, status: number, errorBody: string | { code?: string; message?: string }) {
    let message: string
    let code: string | undefined
    if (typeof errorBody === 'string') {
      message = errorBody
    } else if (errorBody != null && typeof errorBody.message === 'string') {
      message = errorBody.message
      if (typeof errorBody.code === 'string') code = errorBody.code
    } else {
      message = 'Internal server error'
      code = 'internal'
    }
    if (status >= 500 && status !== 503) {
      message = 'Internal server error'
      if (code === undefined) code = 'internal'
    }
    json(res, status, code !== undefined ? { error: message, code } : { error: message })
  }

  /** Read and parse a JSON request body; null on any parse failure. */
  async function readJson(req: ApiRequest): Promise<any> {
    const chunks = []
    let size = 0
    let oversize = false
    let idleTimer: NodeJS.Timeout | undefined
    let idleExpired = false
    // Per-chunk idle timeout (2026 review): a slow body must not hold a
    // connection slot for the whole 35s requestTimeout — management bodies
    // are small JSON, 10s of silence means the client is gone.
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleExpired = true
        req.destroy?.()
      }, BODY_IDLE_TIMEOUT_MS)
      idleTimer.unref?.()
    }
    armIdle()
    try {
      for await (const chunk of req) {
        if (idleExpired) return null
        armIdle()
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          // Keep draining the remainder so a keep-alive socket
          // (maxRequestsPerSocket=1000) is not left with unread body bytes
          // that would be misparsed as the next request line.
          oversize = true
          continue
        }
        chunks.push(chunk)
      }
    } catch {
      return null
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
    }
    if (oversize || chunks.length === 0) return null
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return null
    }
  }

  /** Resolve a route from {pathname, method}; returns {handler} or null. */
  function route(method: string | undefined, segments: string[], res: ApiResponse, req: ApiRequest): RouteHandler | null {
    if (segments[0] === 'health' && segments.length === 1 && method === 'GET') return async () => json(res, 200, deps.getHealth())
    if (segments[0] === 'api') {
      const [a, b] = [segments[1], segments[2]]
      if (a === 'host' && b === 'health-events' && segments.length === 3 && method === 'GET' && deps.subscribeHealthEvents !== undefined) {
        return async () => {
          if (activeHealthEventStreams >= MAX_HEALTH_EVENT_STREAMS) {
            return jsonError(res, 503, { code: 'resource_exhausted', message: 'too many health-event streams' })
          }
          activeHealthEventStreams += 1
          // SSE push channel (design 05 §3): current snapshot first, then
          // every machine transition; keepalive keeps the stream alive
          // through idle browsers. Backpressure is bounded per client and
          // drained in order; write failures, overflow, or client close tear
          // the subscription down (a slow/dead socket must never escape into
          // the state machine or grow memory without bound).
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            ...(res._corsHeaders ?? {}),
          })
          let tornDown = false
          let backpressured = false
          let keepalive: ReturnType<typeof setInterval> | null = null
          let unsubscribe: (() => void) | null = null
          const pendingFrames: string[] = []
          const releaseSubscription = () => {
            const release = unsubscribe
            unsubscribe = null
            try {
              release?.()
            } catch { /* subscriber cleanup is isolated from stream cleanup */ }
          }
          const teardown = () => {
            if (tornDown) return
            tornDown = true
            activeHealthEventStreams = Math.max(0, activeHealthEventStreams - 1)
            if (keepalive !== null) clearInterval(keepalive)
            pendingFrames.length = 0
            res.removeListener('drain', flushPending)
            releaseSubscription()
            try {
              res.end()
            } catch { /* already gone */ }
          }
          const writeFrame = (frame: string) => {
            if (tornDown) return
            if (backpressured) {
              if (pendingFrames.length >= MAX_HEALTH_EVENT_PENDING_FRAMES) {
                teardown()
              } else {
                pendingFrames.push(frame)
              }
              return
            }
            try {
              // Node accepted this frame even when write() returns false; do
              // not enqueue it twice. Pause only subsequent frames until the
              // socket drains.
              if (!res.write(frame)) {
                backpressured = true
                res.once('drain', flushPending)
              }
            } catch {
              teardown()
            }
          }
          function flushPending() {
            if (tornDown) return
            backpressured = false
            while (!tornDown && !backpressured && pendingFrames.length > 0) {
              writeFrame(pendingFrames.shift()!)
            }
          }
          const send = (snapshot: { status: string; port: number | null; error: string | null }) => {
            if (tornDown) return
            const payload = {
              ok: true,
              dsh: { status: snapshot.status, port: snapshot.port ?? 0, error: snapshot.error ?? undefined },
            }
            writeFrame(`data: ${JSON.stringify(payload)}\n\n`)
          }
          // Node 16+: IncomingMessage 'close' fires as soon as the request
          // body is consumed (immediately for a bodyless GET) — not on client
          // disconnect — so a req listener would tear this SSE stream down
          // right after it opens. Detect real disconnects on the response
          // leg: 'close' fires on connection teardown, and writableEnded
          // separates a normal end() from an aborted one (teardown is
          // idempotent via tornDown).
          res.on('close', () => { if (!res.writableEnded) teardown() })
          const health = deps.getHealth()
          send({ status: health.dsh.status, port: health.dsh.port, error: health.dsh.error ?? null })
          if (tornDown) return
          try {
            unsubscribe = deps.subscribeHealthEvents!(send)
          } catch {
            teardown()
            return
          }
          // A custom subscription seam may synchronously close the request.
          // Do not strand a listener when teardown ran before assignment.
          if (tornDown) {
            releaseSubscription()
            return
          }
          keepalive = setInterval(() => {
            // A keepalive has no state value and must not consume the bounded
            // queue while real state frames are waiting for drain.
            if (!tornDown && !backpressured) writeFrame(': keepalive\n\n')
          }, 20_000)
        }
      }
      if (a === 'connections') {
        if (b === undefined && method === 'GET') {
          return async () => {
            const row = deps.getConnectionRow()
            if (row === null) return jsonError(res, 404, { code: 'connection_not_found', message: 'no connection row' })
            return json(res, 200, { connection: row })
          }
        }
        if (b === undefined && method === 'POST') {
          return async (body: any) => {
            if (body === null || typeof body !== 'object') return jsonError(res, 400, 'bad_request')
            // Design 04 §3.2: only kind:'local' is managed on this surface —
            // remote instances live in the desktop main-process registry.
            if (body.kind !== 'local') {
              return jsonError(res, 400, { code: 'connection_kind_unsupported', message: 'only kind "local" is supported on this surface' })
            }
            if (body.label !== undefined && (typeof body.label !== 'string' || body.label === '')) {
              return jsonError(res, 400, { code: 'connection_invalid_input', message: 'label must be a non-empty string' })
            }
            if (body.accentColor !== undefined && typeof body.accentColor !== 'string') {
              return jsonError(res, 400, { code: 'connection_invalid_input', message: 'accentColor must be a string' })
            }
            try {
              const outcome = await deps.startConnection({ kind: body.kind, label: body.label, accentColor: body.accentColor })
              return json(res, 200, outcome)
            } catch (error) {
              const err = error as ApiError
              if (err.code === 'connection_busy') return jsonError(res, 409, { code: err.code, message: err.message })
              return jsonError(res, 503, { code: 'dsh_not_ready', message: 'dsh is not ready' })
            }
          }
        }
        if (b === 'local' && segments.length === 3 && method === 'DELETE') {
          return async () => {
            try {
              await deps.stopConnection(b)
              return json(res, 200, { stopped: true })
            } catch (error) {
              const err = error as ApiError
              if (err.code === 'connection_busy') return jsonError(res, 409, { code: err.code, message: err.message })
              if (err.code === 'not_found') return jsonError(res, 404, 'not_found')
              return jsonError(res, 500, 'internal')
            }
          }
        }
        if (b === 'local' && segments.length === 3 && method === 'PATCH') {
          return async (body: any) => {
            if (body === null || typeof body !== 'object') return jsonError(res, 400, 'bad_request')
            try {
              const updated = await deps.updateConnectionProfile({ connectionId: b, ...body })
              if (updated === null) return jsonError(res, 404, 'not_found')
              return json(res, 200, { connection: updated })
            } catch (error) {
              const err = error as ApiError
              if (err.code === 'not_found') return jsonError(res, 404, 'not_found')
              if (err.code === 'catalog_invalid_input' || err.code === 'connection_invalid_input') {
                return jsonError(res, 400, { code: err.code, message: err.message })
              }
              return jsonError(res, 500, 'internal')
            }
          }
        }
        return null
      }
      if (a === 'i' && typeof b === 'string') {
        // Per-instance reverse proxy (03 §3 / 04 §4): raw body passthrough
        // (ownBody — the carrier 10MiB reader is bypassed; the proxy enforces
        // its own 300MiB cap), reachable without any session (v1).
        if (deps.instanceProxy === undefined) return null
        const proxy = deps.instanceProxy
        const instanceHandler: RouteHandler = async () => {
          await proxy.handleHttp(req, res)
        }
        instanceHandler.ownBody = true
        return instanceHandler
      }
      if (a === 'host' && b === 'logs' && segments.length === 3 && method === 'GET') {
        // Managed-host rolling logs (design 02 §3.8 read side).
        return async () => {
          if (deps.hostLogs === undefined) return jsonError(res, 404, 'not_found')
          const params = new URL(req.url!, `http://${req.headers.host ?? 'localhost'}`).searchParams
          const query: { port?: number; limit?: number; offset?: number } = {}
          const portParam = params.get('port')
          if (portParam !== null && portParam !== '') {
            const port = Number(portParam)
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              return jsonError(res, 400, { code: 'invalid_argument', message: 'invalid port' })
            }
            query.port = port
          }
          const limitParam = params.get('limit')
          if (limitParam !== null && limitParam !== '') {
            const limit = Number(limitParam)
            if (!Number.isInteger(limit) || limit <= 0) {
              return jsonError(res, 400, { code: 'invalid_argument', message: 'invalid limit' })
            }
            query.limit = limit
          }
          const offsetParam = params.get('offset')
          if (offsetParam !== null && offsetParam !== '') {
            const offset = Number(offsetParam)
            if (!Number.isInteger(offset) || offset < 0) {
              return jsonError(res, 400, { code: 'invalid_argument', message: 'invalid offset' })
            }
            query.offset = offset
          }
          try {
            return json(res, 200, await deps.hostLogs(query))
          } catch (error) {
            const err = error as ApiError
            if (err.code === 'not_found') return jsonError(res, 404, 'not_found')
            if (err.code === 'invalid_argument') return jsonError(res, 400, { code: err.code, message: err.message })
            return jsonError(res, 500, 'internal')
          }
        }
      }
    }
    return null
  }

  /** The request handler: CORS, routing, and carrier-level codes. */
  async function handle(req: ApiRequest, res: ApiResponse) {
    const url = new URL(req.url!, `http://${req.headers.host ?? 'localhost'}`)
    const segments = url.pathname.split('/').filter(Boolean)
    const cors = corsHeaders(req)
    res._corsHeaders = cors.headers
    // Missing CORS response headers only prevents a hostile page from
    // reading the result; it does not stop a safelisted POST from mutating
    // the anonymous loopback API. Enforce the decision before routing/body
    // handling so it is a trust boundary rather than a presentation hint.
    if (!cors.allowed) {
      jsonError(res, 403, { code: 'origin_forbidden', message: 'request origin is not allowed' })
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...res._corsHeaders,
        'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      res.end()
      return
    }
    const matched = route(req.method, segments, res, req)
    if (matched === null) {
      jsonError(res, 404, 'not_found')
      return
    }
    const body = (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT')
      && matched.ownBody !== true
      ? await readJson(req)
      : null
    await matched(body)
  }

  return {
    handle,
    /** The per-request CORS header decision. */
    getCorsHeaders: corsHeaders,
  } satisfies ApiSurface
}
