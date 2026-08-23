/**
 * Gateway dispatch middleware (design 16 §4): the auth gate + surface routing
 * injected into the control-plane's server shell via the `middleware` /
 * `upgradeMiddleware` hooks (design 16 §2.1 改动③). A truthy return CLAIMS the
 * request/upgrade; falsy falls through to the control-plane default dispatch
 * (management REST + per-instance proxy).
 *
 * Routing (all under the auth gate except the two public paths):
 *   /health                  → fall through (management probe, public)
 *   /auth/login              → auth login (public)
 *   /api/connections, /api/host/*, /api/i/* → fall through (management)
 *   /chamber/*               → feature host (P3; MVP answers 404)
 *   /plugins/*, /, /api/*(rest) → gateway-proxy → dsh
 */

import {
  type ApiRequest,
  type ApiResponse,
  type Logger,
  type PlaneMiddlewareContext,
} from '@dsh-chamber/control-plane'
import type { AuthProvider } from './auth.ts'
import type { GatewayProxy } from './gateway-proxy.ts'
import type { FeatureHost } from './routes.ts'

/** The two public paths (no auth). */
const PUBLIC_PATHS = new Set(['/health', '/auth/login'])

/**
 * CSP for the PROXIED dsh frontend (design 16 §11 S14): the control-plane
 * shell sets a per-response nonce CSP with `unsafe-inline` closed, but the
 * gateway cannot backfill that nonce into dsh's streamed HTML (its inline
 * `__DSH_BOOT__`/loader scripts). Rather than white-screen the frontend, the
 * proxy path relaxes script-src to `unsafe-inline` — the frontend is dsh's own
 * and already behind the auth gate. Every other directive stays identical.
 */
const GATEWAY_PROXY_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:"

function json(res: ApiResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name]
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
}

/** S11 (design 16 §11): the gateway Host authority decision. When the operator
 * configured a publicOrigin, an unrecognized Host is rejected 421 (misdirected
 * request) — only the public origin, loopback, and private-network peers are
 * legitimate authorities. No publicOrigin = no public authority configured,
 * so any Host is accepted (loopback-only operators). */
function isAuthorizedHost(hostHeader: string | undefined, publicOrigin: string | undefined): boolean {
  if (publicOrigin === undefined) return true
  if (hostHeader === undefined || hostHeader === '') return false
  const host = hostHeader
  try {
    if (host === new URL(publicOrigin).host) return true
  } catch { /* invalid publicOrigin → fail closed below */ }
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return true
  return /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)
}

function rejectWs(socket: { end(data: string): unknown }, status: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n`
    + 'Content-Type: application/json\r\n'
    + 'Connection: close\r\n'
    + '\r\n'
    + JSON.stringify({ error: message, code: status === 401 ? 'unauthorized' : 'origin_forbidden' }),
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

/** Read + parse a JSON request body (bounded). */
function readBody(req: ApiRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const MAX = 1024 * 1024
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX) { reject(new Error('body too large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

export interface GatewayDispatch {
  middleware: NonNullable<import('@dsh-chamber/control-plane').ControlPlaneOptions['middleware']>
  upgradeMiddleware: NonNullable<import('@dsh-chamber/control-plane').ControlPlaneOptions['upgradeMiddleware']>
}

export function createGatewayDispatch(auth: AuthProvider, getProxy: () => GatewayProxy, getFeatures: () => FeatureHost, logger: Logger, publicOrigin?: string): GatewayDispatch {
  const middleware: GatewayDispatch['middleware'] = async (req, res, url) => {
    const pathname = url.pathname
    // -1. Host authority (S11): reject a misdirected request before any
    // auth/routing (the authority check is the outermost gate).
    if (!isAuthorizedHost(headerValue(req.headers, 'host'), publicOrigin)) {
      json(res, 421, { error: 'misdirected request', code: 'misdirected_request' })
      return true
    }
    // 0. CORS preflight (design 16 §5): OPTIONS carries no Authorization, so it
    // must bypass the auth gate and fall through to the shell's CORS handler.
    if (req.method === 'OPTIONS') return false
    // 1. Auth gate (public paths exempt). socketAddr is not available through
    // the middleware ctx — the token/password providers do not use it (S11's
    // Host authority decision is a post-MVP hardening).
    if (!PUBLIC_PATHS.has(pathname)) {
      const principal = await auth.verify({ headers: req.headers, socketAddr: '' })
      if (principal === null) {
        json(res, 401, { error: 'unauthorized', code: 'unauthorized' })
        return true
      }
    }
    // 2. Auth login (public, design §5.1): POST verifies the password and sets
    // the session cookie → 302 to `/`; GET serves the minimal login page.
    if (pathname === '/auth/login') {
      if (req.method === 'POST' && auth.login !== undefined) {
        try {
          const body = await readBody(req)
          const { setCookie } = await auth.login(body, { headers: req.headers, socketAddr: '' })
          if (setCookie !== undefined) res.setHeader('set-cookie', setCookie)
          res.writeHead(302, { location: '/', 'cache-control': 'no-store' })
          res.end()
        } catch (error) {
          const code = (error as Error & { code?: string }).code
          if (code === 'rate_limited') json(res, 429, { error: 'too many login attempts', code: 'rate_limited' })
          else json(res, 401, { error: 'invalid credentials', code: 'invalid_credentials' })
        }
        return true
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(LOGIN_PAGE_HTML)
      return true
    }
    // 3. Management routes → fall through to api.handle (prefix-match so
    // `/api/connections/local` PATCH/DELETE and `/api/host/*` all reach it).
    if (pathname === '/health' || pathname.startsWith('/api/connections') || pathname.startsWith('/api/host/') || pathname.startsWith('/api/i/')) {
      return false
    }
    // 4. Feature host (design 16 §8.5): /chamber/* is the gateway's own
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

  const upgradeMiddleware: GatewayDispatch['upgradeMiddleware'] = async (req, socket, head, ctx) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    // 1. Auth gate (WS auth == HTTP auth, S2).
    const principal = await auth.verify({ headers: req.headers, socketAddr: '' })
    if (principal === null) {
      rejectWs(socket, 401, 'unauthorized')
      return true
    }
    // 2. The two dsh downlink stream paths → origin fence + gateway-proxy.
    if (pathname === '/api/events.mux' || pathname === '/api/events.host') {
      const cors = (ctx as PlaneMiddlewareContext).api.getCorsHeaders(req)
      if (!cors.allowed) {
        rejectWs(socket, 403, 'request origin is not allowed')
        return true
      }
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
