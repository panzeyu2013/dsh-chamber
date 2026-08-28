/**
 * Gateway dispatch middleware (design 17 §4): the auth gate + surface routing
 * injected into the control-plane's server shell via the `middleware` /
 * `upgradeMiddleware` hooks (design 17 §2.1 改动③). A truthy return CLAIMS the
 * request/upgrade; falsy falls through to the control-plane default dispatch
 * (management REST + per-instance proxy).
 *
 * Routing (all under the auth gate except the two public paths):
 *   /health                  → fall through (management probe, public)
 *   /auth/login              → auth login (public)
 *   /api/connections, /api/host/*, /api/i/* → fall through (management)
 *   /chamber/runtime/*       → runtime controller (design 18 §9.3; NOT ready-gated)
 *   /chamber/*               → feature host (design 17 §8.5, fully implemented)
 *   /plugins/*, /, /api/*(rest) → gateway-proxy → dsh
 */

import {
  type ApiRequest,
  type ApiResponse,
  type Logger,
} from '@dsh-chamber/control-plane'
import type { AuthPrincipal, AuthProvider } from './auth.ts'
import type { GatewayProxy } from './gateway-proxy.ts'
import type { FeatureHost } from './routes.ts'
import type { RuntimeRoutes } from './runtime-routes.ts'
import type { GatewayRequestDecision, GatewayRequestPolicy } from './middleware.ts'
import { appendAuditEvent } from './audit.ts'

function isPublicRequest(method: string | undefined, pathname: string): boolean {
  // HEAD is the no-body twin of GET; a monitoring HEAD /health must not be
  // forced through the auth gate while GET /health is public.
  if (pathname === '/health') return method === 'GET' || method === 'HEAD'
  return pathname === '/auth/login' && (method === 'GET' || method === 'HEAD' || method === 'POST')
}

function shouldRedirectToLogin(req: ApiRequest, pathname: string, auth: AuthProvider): boolean {
  if (auth.kind !== 'password' && auth.kind !== 'password+token') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!(headerValue(req.headers, 'accept') ?? '').toLowerCase().includes('text/html')) return false
  // These prefixes are protocol/API surfaces even when a client happens to
  // advertise HTML: /api, /plugins, and the /chamber/<subpath> JSON/SSE
  // endpoints. Document navigations (/, /chamber, /chamber/) reach the form.
  return pathname !== '/api' && !pathname.startsWith('/api/')
    && pathname !== '/plugins' && !pathname.startsWith('/plugins/')
    && !(pathname.startsWith('/chamber/') && pathname !== '/chamber/')
}

/**
 * CSP for the PROXIED dsh frontend (design 17 §11 S14): the control-plane
 * shell sets a per-response nonce CSP with `unsafe-inline` closed, but the
 * gateway cannot backfill that nonce into dsh's streamed HTML (its inline
 * `__DSH_BOOT__`/loader scripts). Rather than white-screen the frontend, the
 * proxy path relaxes script-src to `unsafe-inline` — the frontend is dsh's own
 * and already behind the auth gate. Every other directive stays identical.
 */
const GATEWAY_PROXY_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:"
const LOGIN_PAGE_CSP = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'"

function json(res: ApiResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name]
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
}

function rejectWs(socket: { end(data: string): unknown }, status: number, message: string, code?: string): void {
  const reason = status === 400 ? 'Bad Request'
    : status === 401 ? 'Unauthorized'
      : status === 421 ? 'Misdirected Request'
        : status === 503 ? 'Service Unavailable' : 'Forbidden'
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + 'Content-Type: application/json\r\n'
    + 'Connection: close\r\n'
    + '\r\n'
    + JSON.stringify({ error: message, code: code ?? (status === 401 ? 'unauthorized' : 'origin_forbidden') }),
  )
}

/** The minimal gateway login page (design §5.1): the ONLY gateway-owned frontend
 * asset besides /chamber/*. POSTs the password to /auth/login. */
const LOGIN_PAGE_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh gateway</title>
<form method="post" action="/auth/login" style="font-family:system-ui;max-width:20rem;margin:4rem auto">
  <h1>dsh gateway</h1>
  <label>Password <input type="password" name="password" autofocus style="width:100%;box-sizing:border-box"></label>
  <button type="submit" style="margin-top:0.5rem">Sign in</button>
</form>
`

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/** Read a bounded login body. The static HTML uses form-urlencoded; JSON is
 * retained for API clients and tests. Unsupported/malformed media is a 400,
 * never silently treated as an empty credential. */
function readBody(req: ApiRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let finished = false
    // A configured password is capped at 1024 characters. 16 KiB leaves ample
    // room for UTF-8/JSON or form encoding without letting anonymous slow
    // clients reserve a megabyte on every accepted connection.
    const MAX = 16 * 1024
    const fail = (error: unknown): void => {
      if (finished) return
      finished = true
      // The request may continue to drain until Node's request timeout. Drop
      // every retained byte immediately and make all later events no-ops so an
      // unauthenticated slow upload cannot pin one body per connection.
      chunks.length = 0
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      if (finished) return
      size += chunk.length
      if (size > MAX) {
        fail(codedError('body_too_large', 'login body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (finished) return
      finished = true
      const text = Buffer.concat(chunks).toString('utf8')
      chunks.length = 0
      const contentType = (headerValue(req.headers, 'content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
      try {
        if (contentType === 'application/x-www-form-urlencoded') {
          const form = new URLSearchParams(text)
          resolve({ password: form.get('password') ?? undefined })
          return
        }
        if (contentType === 'application/json') {
          resolve(text === '' ? {} : JSON.parse(text))
          return
        }
        reject(codedError('bad_request', 'unsupported login content type'))
      } catch {
        reject(codedError('bad_request', 'malformed login body'))
      }
    })
    req.on('error', fail)
  })
}

export interface GatewayDispatch {
  middleware: NonNullable<import('@dsh-chamber/control-plane').ControlPlaneOptions['middleware']>
  upgradeMiddleware: NonNullable<import('@dsh-chamber/control-plane').ControlPlaneOptions['upgradeMiddleware']>
}

function authRequest(req: ApiRequest, decision: GatewayRequestDecision) {
  return {
    headers: req.headers,
    socketAddr: req.socket?.remoteAddress ?? '',
    clientAddress: decision.clientAddress,
    secure: decision.secure,
  }
}

export function createGatewayDispatch(auth: AuthProvider, getProxy: () => GatewayProxy, getFeatures: () => FeatureHost, getRuntime: () => RuntimeRoutes, logger: Logger, requestPolicy: GatewayRequestPolicy, auditFile?: string | null): GatewayDispatch {
  const middleware: GatewayDispatch['middleware'] = async (req, res, url) => {
    const pathname = url.pathname
    // -1. One authority/origin boundary for every HTTP surface, including
    // public paths and OPTIONS. Its result also supplies sanitized auth facts.
    const decision = requestPolicy.evaluate(req)
    if (!decision.allowed) {
      json(res, decision.status, {
        error: decision.code === 'misdirected_request' ? 'misdirected request' : 'request origin is not allowed',
        code: decision.code,
      })
      return true
    }
    res._corsHeaders = decision.headers
    for (const [name, value] of Object.entries(decision.headers)) res.setHeader(name, value)
    // 0. CORS preflight (design 17 §5): OPTIONS carries no Authorization and
    // applies to gateway-owned as well as control-plane paths, so claim it
    // here instead of relying on the management router's path dispatch.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...decision.headers,
        'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '600',
      })
      res.end()
      return true
    }
    // 1. Auth gate (public paths exempt). socketAddr is not available through
    // the middleware ctx — the token/password providers do not use it (the
    // Host authority decision belongs to the request policy, design 17 §6 /
    // S3 族, already evaluated at step −1).
    if (pathname === '/auth/login'
      && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      res.writeHead(405, {
        allow: 'GET, HEAD, POST',
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({ error: 'method not allowed', code: 'method_not_allowed' }))
      return true
    }
    if (!isPublicRequest(req.method, pathname)) {
      let principal: AuthPrincipal | null
      try {
        principal = await auth.verify(authRequest(req, decision))
      } catch (error) {
        // The scrypt work gate saturates under abuse: an overloaded verify
        // must answer 503 auth_busy — the same code the login path uses —
        // never fall through as a generic 500 internal (design §5.3).
        // Regression locked by auth.test.ts.
        const code = (error as Error & { code?: string }).code
        if (code === 'auth_busy') {
          json(res, 503, { error: 'authentication service is busy', code: 'auth_busy' })
          return true
        }
        throw error
      }
      if (principal === null) {
        if (shouldRedirectToLogin(req, pathname, auth)) {
          res.writeHead(302, { location: '/auth/login', 'cache-control': 'no-store' })
          res.end()
          return true
        }
        json(res, 401, { error: 'unauthorized', code: 'unauthorized' })
        return true
      }
    }
    // 2. Auth login (public, design §5.1): POST verifies the password and sets
    // the session cookie → 302 to `/`; GET serves the minimal login page.
    if (pathname === '/auth/login') {
      res.setHeader('content-security-policy', LOGIN_PAGE_CSP)
      if (auth.login === undefined) {
        json(res, 404, { error: 'not_found', code: 'not_found' })
        return true
      }
      if (req.method === 'POST' && auth.login !== undefined) {
        // S24 (design 17 §13.4.4): the login branch audits ONLY the non-secret
        // auth RESULT — never the submitted password, never the session cookie
        // (setCookie stays out of the audit event by construction).
        const loginReq = authRequest(req, decision)
        const loginSource = loginReq.clientAddress !== undefined && loginReq.clientAddress !== ''
          ? `client:${loginReq.clientAddress}`
          : `client:${loginReq.socketAddr}`
        try {
          const body = await readBody(req)
          const { setCookie } = await auth.login(body, loginReq)
          if (setCookie !== undefined) res.setHeader('set-cookie', setCookie)
          res.writeHead(302, { location: '/', 'cache-control': 'no-store' })
          res.end()
          if (auditFile !== undefined && auditFile !== null) {
            appendAuditEvent(auditFile, { ts: new Date().toISOString(), event: 'login_success', kind: 'gateway', detail: loginSource })
          }
        } catch (error) {
          const code = (error as Error & { code?: string }).code
          if (auditFile !== undefined && auditFile !== null) {
            appendAuditEvent(auditFile, {
              ts: new Date().toISOString(),
              event: code === 'rate_limited' ? 'login_rate_limited'
                : code === 'auth_busy' ? 'login_busy'
                : code === 'body_too_large' || code === 'bad_request' ? 'login_rejected'
                : 'login_invalid_credentials',
              kind: 'gateway',
              detail: `${loginSource},code:${code ?? 'invalid_credentials'}`,
            })
          }
          if (code === 'rate_limited') json(res, 429, { error: 'too many login attempts', code: 'rate_limited' })
          else if (code === 'auth_busy') json(res, 503, { error: 'authentication service is busy', code: 'auth_busy' })
          else if (code === 'body_too_large') {
            json(res, 413, { error: 'request body too large', code })
            // The 413 is written; the oversized body may still be streaming.
            // Destroy the request socket instead of draining it, so a slow
            // anonymous upload cannot pin the connection.
            req.destroy?.()
          } else if (code === 'bad_request') json(res, 400, { error: 'bad request', code })
          else json(res, 401, { error: 'invalid credentials', code: 'invalid_credentials' })
        }
        return true
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : LOGIN_PAGE_HTML)
      return true
    }
    // 3. Management routes → fall through to api.handle (prefix-match so
    // `/api/connections/local` PATCH/DELETE and `/api/host/*` all reach it).
    if (pathname === '/health' || pathname.startsWith('/api/connections') || pathname.startsWith('/api/host/') || pathname.startsWith('/api/i/')) {
      return false
    }
    // /chamber (no trailing slash) → redirect to the dashboard's canonical URL
    // (otherwise it falls through to the dsh proxy and 404s).
    if (pathname === '/chamber') {
      res.writeHead(302, { location: '/chamber/', 'cache-control': 'no-store' })
      res.end()
      return true
    }
    // 3.5 Runtime controller (design 18 §9.3): /chamber/runtime/* is claimed
    // here, BEFORE the ready-gated feature host — the runtime surface manages
    // dsh itself and must stay pollable while dsh is down (restart/applying).
    // Exact-prefix match only: /chamber/runtime and /chamber/runtime/<suffix>
    // belong to the controller; /chamber/runtimeevil must NOT be claimed.
    if (pathname === '/chamber/runtime' || pathname.startsWith('/chamber/runtime/')) {
      await getRuntime().handle(req, res, pathname)
      return true
    }
    // 4. Feature host (design 17 §8.5): /chamber/* is the gateway's own
    // orchestration surface (git worktrees, approvals, cron, settings).
    if (pathname.startsWith('/chamber/')) {
      await getFeatures().handle(req, res, pathname)
      return true
    }
    // 5. Everything else (/api/* rest, /plugins/*, / and assets) → gateway-proxy.
    // Relax the shell's nonce CSP for the proxied dsh HTML (S14): the proxy
    // cannot backfill the nonce, so script-src must allow dsh's inline scripts.
    res.setHeader('content-security-policy', GATEWAY_PROXY_CSP)
    try {
      await getProxy().handleHttp(req, res)
    } catch (error) {
      logger.warn(`gateway dispatch: proxy failure: ${String(error)}`)
      if (!res.headersSent) json(res, 502, { error: 'upstream_failed', code: 'upstream_failed' })
      else res.destroy()
    }
    return true
  }

  const upgradeMiddleware: GatewayDispatch['upgradeMiddleware'] = async (req, socket, head) => {
    const rawTarget = req.url ?? '/'
    if (!rawTarget.startsWith('/') || rawTarget.startsWith('//')
      || rawTarget.includes('\\') || rawTarget.includes('#')) {
      rejectWs(socket, 400, 'invalid request target', 'bad_request')
      return true
    }
    const pathname = new URL(rawTarget, 'http://localhost').pathname
    // 0. The exact same public boundary applies before every WS route.
    const decision = requestPolicy.evaluate(req)
    if (!decision.allowed) {
      rejectWs(socket, decision.status, decision.code === 'misdirected_request' ? 'misdirected request' : 'request origin is not allowed', decision.code)
      return true
    }
    // 1. Auth gate (WS auth == HTTP auth, S2). A saturated scrypt work gate
    // must answer 503 auth_busy here too — never a generic 500 internal —
    // mirroring the HTTP verify path (regression locked in
    // dispatch-composition.test.ts).
    let principal: AuthPrincipal | null
    try {
      principal = await auth.verify(authRequest(req, decision))
    } catch (error) {
      const code = (error as Error & { code?: string }).code
      if (code === 'auth_busy') {
        rejectWs(socket, 503, 'authentication service is busy', 'auth_busy')
        return true
      }
      throw error
    }
    if (principal === null) {
      rejectWs(socket, 401, 'unauthorized')
      return true
    }
    // 2. The two dsh downlink stream paths → origin fence + gateway-proxy.
    if (pathname === '/api/events.mux' || pathname === '/api/events.host') {
      try {
        await getProxy().handleUpgrade(req, socket as never, head)
      } catch (error) {
        logger.warn(`gateway dispatch: upgrade failure: ${String(error)}`)
        socket.destroy()
      }
      return true
    }
    // 3. Everything else → fall through (instance-proxy handles /api/i/*).
    return false
  }

  return { middleware, upgradeMiddleware }
}
