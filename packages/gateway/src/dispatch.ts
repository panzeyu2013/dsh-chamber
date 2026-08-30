/**
 * Gateway dispatch middleware (design 17 §4): the auth gate + surface routing
 * injected into the control-plane's server shell via the `middleware` /
 * `upgradeMiddleware` hooks (design 17 §2.1 改动③). A truthy return CLAIMS the
 * request/upgrade; falsy falls through to the control-plane default dispatch
 * (management REST + per-instance proxy).
 *
 * Routing (all under the auth gate except the two public paths):
 *   /health                  → fall through (management probe, public)
 *   /auth/login              → auth login (public; route exists only while a
 *                              password is configured — design 17 §6)
 *   /auth/change-password    → auth.changePassword (Phase 2, runtime credentials)
 *   /auth/change-token       → auth.changeToken (Phase 2)
 *   /auth/credentials        → auth.credentialProjection (Phase 2, non-secret)
 *   /api/connections, /api/host/*, /api/i/* → fall through (management)
 *   /chamber/runtime/*       → runtime controller (design 18 §9.3; NOT ready-gated)
 *   /chamber/*               → feature host (design 17 §8.5, fully implemented)
 *   /plugins/*, /, /api/*(rest) → gateway-proxy → dsh
 */

import {
  type ApiRequest,
  type ApiResponse,
  type Logger,
  type PlaneMiddlewareContext,
} from '@dsh-chamber/control-plane'
import type { Duplex } from 'node:stream'
import type { AuthChangeProof, AuthPrincipal, AuthProvider, ChangePasswordInput, ChangeTokenInput } from './auth.ts'
import { SESSION_COOKIE } from './auth.ts'
import type { GatewayProxy } from './gateway-proxy.ts'
import type { FeatureHost } from './routes.ts'
import type { RuntimeRoutes } from './runtime-routes.ts'
import type { GatewayRequestDecision, GatewayRequestPolicy } from './middleware.ts'
import { appendAuditEvent } from './audit.ts'
import { LOGIN_PAGE_CSP, detectLoginLang, renderLoginPage, renderTokenOnlyPage, wantsHtmlLoginResponse } from './login-page.ts'

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
  // advertise HTML: /api, /plugins, /auth (credential management is JSON),
  // and the /chamber/<subpath> JSON/SSE endpoints. Document navigations
  // (/, /chamber, /chamber/) reach the form.
  return pathname !== '/api' && !pathname.startsWith('/api/')
    && pathname !== '/plugins' && !pathname.startsWith('/plugins/')
    && !pathname.startsWith('/auth/')
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

/** Uniform response headers for every login-page HTML response (design 21 §6.2):
 * the rendered page itself comes from login-page.ts; CSP is set separately. */
const LOGIN_HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const

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
    req.on('aborted', () => fail(codedError('request_aborted', 'request body aborted')))
    req.on('close', () => {
      if (!finished && (req as ApiRequest & { complete?: boolean }).complete !== true) {
        fail(codedError('request_aborted', 'request body closed before completion'))
      }
    })
  })
}

export interface GatewayDispatch {
  middleware: NonNullable<import('@dsh-chamber/control-plane').ControlPlaneOptions['middleware']>
  upgradeMiddleware: NonNullable<import('@dsh-chamber/control-plane').ControlPlaneOptions['upgradeMiddleware']>
  /** Re-open credential-mutation admission after a fully quiesced stop. */
  resume(): void
  /** Fence new credential mutations, close the authenticated traffic
   * snapshot (which settles incomplete bodies), and drain every mutation that
   * already crossed admission before gateway ownership can be released. */
  quiesce(): Promise<void>
}

function authRequest(req: ApiRequest, decision: GatewayRequestDecision) {
  return {
    headers: req.headers,
    socketAddr: req.socket?.remoteAddress ?? '',
    clientAddress: decision.clientAddress,
    secure: decision.secure,
  }
}

export function createGatewayDispatch(
  auth: AuthProvider,
  getProxy: () => GatewayProxy,
  getFeatures: () => FeatureHost,
  getRuntime: () => RuntimeRoutes,
  logger: Logger,
  requestPolicy: GatewayRequestPolicy,
  auditFile?: string | null,
): GatewayDispatch {
  // Every request/socket admitted by one credential generation stays tracked
  // until its downstream leg ends. Rotation closes the old generation at the
  // dispatch boundary, which covers gateway-proxy, feature SSE and the
  // control-plane management/instance fallthrough uniformly without teaching
  // those anonymous internals about authentication.
  const authenticatedHttp = new Set<{ request: ApiRequest; response: ApiResponse }>()
  const authenticatedSockets = new Set<Duplex>()
  let credentialMutationsAccepted = true
  const activeCredentialMutations = new Set<Promise<void>>()
  function principalIsCurrent(principal: AuthPrincipal): boolean {
    return auth.generation === undefined || principal.generation === auth.generation
  }
  function trackHttp(request: ApiRequest, response: ApiResponse): void {
    const entry = { request, response }
    authenticatedHttp.add(entry)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      authenticatedHttp.delete(entry)
    }
    response.once('finish', release)
    response.once('close', release)
    response.once('error', release)
  }
  function trackSocket(socket: Duplex): void {
    authenticatedSockets.add(socket)
    const release = (): void => { authenticatedSockets.delete(socket) }
    // Production sockets are Duplex/EventEmitter. Some no-listen boundary
    // tests use the minimal `{destroy,end}` structural shape; tracking still
    // revokes those, while lifecycle auto-release is attached when present.
    const evented = socket as Duplex & { once?: (event: string, listener: () => void) => unknown }
    evented.once?.('close', release)
    evented.once?.('error', release)
  }
  function closeAuthenticatedTraffic(exceptResponse?: ApiResponse): void {
    for (const entry of [...authenticatedHttp]) {
      if (entry.response === exceptResponse) continue
      authenticatedHttp.delete(entry)
      try { entry.request.destroy?.() } catch { /* already closed */ }
      try {
        const response = entry.response as ApiResponse & { destroy?: () => unknown }
        if (typeof response.destroy === 'function') response.destroy()
        else response.end()
      } catch { /* already closed */ }
    }
    for (const socket of [...authenticatedSockets]) {
      authenticatedSockets.delete(socket)
      try { socket.destroy() } catch { /* already closed */ }
    }
  }
  function beginCredentialMutation(): (() => void) | null {
    if (!credentialMutationsAccepted) return null
    let settle!: () => void
    const operation = new Promise<void>(resolve => { settle = resolve })
    activeCredentialMutations.add(operation)
    let settled = false
    return (): void => {
      if (settled) return
      settled = true
      activeCredentialMutations.delete(operation)
      settle()
    }
  }
  async function quiesce(): Promise<void> {
    credentialMutationsAccepted = false
    // Closing the snapshot comes after the synchronous admission fence. A
    // pre-fence request still reading its body is forced into its finally;
    // one already writing credentials remains tracked until its route tail
    // (including generation revocation and audit append) has completed.
    closeAuthenticatedTraffic()
    while (activeCredentialMutations.size > 0) {
      await Promise.allSettled([...activeCredentialMutations])
    }
  }
  function rejectStaleHttp(res: ApiResponse, principal: AuthPrincipal | null): boolean {
    if (principal === null || principalIsCurrent(principal)) return false
    const state = res as ApiResponse & { destroyed?: boolean; writableEnded?: boolean }
    if (state.destroyed !== true && state.writableEnded !== true) {
      json(res, 401, { error: 'unauthorized', code: 'unauthorized' })
    }
    return true
  }

  const middleware: GatewayDispatch['middleware'] = async (req, res, url, ctx) => {
    const pathname = url.pathname
    let authenticatedPrincipal: AuthPrincipal | null = null
    let authenticatedChangeProof: AuthChangeProof | undefined
    // -1. One authority/origin boundary for every HTTP surface, including
    // public paths and OPTIONS. Its result also supplies sanitized auth facts.
    const decision = requestPolicy.evaluate(req)
    if (!decision.allowed) {
      json(res, decision.status, {
        error: decision.code === 'bad_request' ? 'malformed request headers'
          : decision.code === 'misdirected_request' ? 'misdirected request'
            : 'request origin is not allowed',
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
          // A present-but-invalid session cookie means the visitor had a
          // session that verification just failed (design 21 §6.3): point at
          // the expired hint. No cookie (first visit) keeps the plain location.
          const hadSession = (headerValue(req.headers, 'cookie') ?? '').split(';').some(part => part.trim().startsWith(`${SESSION_COOKIE}=`))
          res.writeHead(302, { location: hadSession ? '/auth/login?expired=1' : '/auth/login', 'cache-control': 'no-store' })
          res.end()
          return true
        }
        json(res, 401, { error: 'unauthorized', code: 'unauthorized' })
        return true
      }
      // verify() can resolve in a later microtask than a credential mutation.
      // Reject that stale verdict and register the downstream synchronously
      // before any route-specific await creates another rotation window.
      if (!principalIsCurrent(principal)) {
        json(res, 401, { error: 'unauthorized', code: 'unauthorized' })
        return true
      }
      authenticatedPrincipal = principal
      // Capture synchronously at the admission boundary. The opaque proof is
      // accepted only by the same provider and generation, so credential
      // routes can reuse the bearer/password principal without another
      // verifier pass after reading the body.
      authenticatedChangeProof = auth.captureChangeProof?.(principal) ?? undefined
      trackHttp(req, res)
    }
    // 2. Auth login (public, design 17 §5.1 / 21): POST verifies the password
    // and sets the session cookie → 302 to `/`; GET serves the rendered login
    // page. The route EXISTS only while a password is configured (design 17
    // §6: "仅 password 形态存在") — the dynamic facade always exposes `login`
    // (throwing `no_password` when no password is configured), so the
    // effective `kind` getter decides: a token-only (or none) deployment
    // answers 404 here.
    if (pathname === '/auth/login') {
      res.setHeader('content-security-policy', LOGIN_PAGE_CSP)
      const lang = detectLoginLang(headerValue(req.headers, 'accept-language'))
      if (auth.kind !== 'password' && auth.kind !== 'password+token') {
        // Token-only / no-auth deployment: browsers get a minimal HTML
        // explanation page (design 21 §5.3); API clients keep the JSON 404.
        // GET/HEAD carries no content-type, so an HTML Accept alone selects
        // the page (design 21 §10.3); POST still negotiates via the
        // form-urlencoded + HTML rule (design 21 §6.1). The copy varies by
        // auth kind: a `--no-auth` deployment has no token and must not claim
        // one (honest posture, design 17 §13.1).
        const acceptHtml = (headerValue(req.headers, 'accept') ?? '').toLowerCase().includes('text/html')
        if (wantsHtmlLoginResponse(req.headers)
          || ((req.method === 'GET' || req.method === 'HEAD') && acceptHtml)) {
          res.writeHead(404, LOGIN_HTML_HEADERS)
          res.end(req.method === 'HEAD' ? undefined : renderTokenOnlyPage(lang, auth.kind === 'none' ? 'none' : 'token'))
        } else {
          json(res, 404, { error: 'not_found', code: 'not_found' })
        }
        return true
      }
      if (req.method === 'POST') {
        // S24 (design 17 §13.4.4): the login branch audits ONLY the non-secret
        // auth RESULT — never the submitted password, never the session cookie
        // (setCookie stays out of the audit event by construction).
        const loginReq = authRequest(req, decision)
        const loginSource = loginReq.clientAddress !== undefined && loginReq.clientAddress !== ''
          ? `client:${loginReq.clientAddress}`
          : `client:${loginReq.socketAddr}`
        try {
          const body = await readBody(req)
          const { setCookie } = await auth.login!(body, loginReq)
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
                : code === 'body_too_large' || code === 'bad_request' || code === 'no_password' ? 'login_rejected'
                : 'login_invalid_credentials',
              kind: 'gateway',
              detail: `${loginSource},code:${code ?? 'invalid_credentials'}`,
            })
          }
          const html = wantsHtmlLoginResponse(req.headers)
          const retryAfterMs = (error as Error & { retryAfterMs?: number }).retryAfterMs
          // `no_password` is the race-only fallback: the facade threw it
          // between the kind check above and the login call (a concurrent
          // credential removal). The route no longer exists — 404.
          if (code === 'no_password') {
            json(res, 404, { error: 'not_found', code: 'not_found' })
          }
          else if (code === 'rate_limited') {
            const retryAfterSec = Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000))
            if (html) {
              res.writeHead(429, { ...LOGIN_HTML_HEADERS, 'retry-after': String(retryAfterSec) })
              res.end(renderLoginPage({ lang, secure: decision.secure, error: 'rate_limited', retryAfterSec }))
            } else {
              // json() would overwrite retry-after via writeHead; set it first
              // (setHeader values are merged by writeHead in the real server).
              res.setHeader('retry-after', String(retryAfterSec))
              json(res, 429, { error: 'too many login attempts', code: 'rate_limited' })
            }
          }
          else if (code === 'auth_busy') {
            if (html) {
              res.writeHead(503, LOGIN_HTML_HEADERS)
              res.end(renderLoginPage({ lang, secure: decision.secure, error: 'busy' }))
            } else {
              json(res, 503, { error: 'authentication service is busy', code: 'auth_busy' })
            }
          }
          else if (code === 'body_too_large') {
            json(res, 413, { error: 'request body too large', code })
            // The 413 is written; the oversized body may still be streaming.
            // Destroy the request socket instead of draining it, so a slow
            // anonymous upload cannot pin the connection.
            req.destroy?.()
          } else if (code === 'bad_request') json(res, 400, { error: 'bad request', code })
          else {
            if (html) {
              res.writeHead(401, LOGIN_HTML_HEADERS)
              res.end(renderLoginPage({ lang, secure: decision.secure, error: 'invalid' }))
            } else {
              json(res, 401, { error: 'invalid credentials', code: 'invalid_credentials' })
            }
          }
        }
        return true
      }
      const expired = url.searchParams.get('expired') === '1'
      res.writeHead(200, LOGIN_HTML_HEADERS)
      res.end(req.method === 'HEAD' ? undefined : renderLoginPage({ lang, secure: decision.secure, error: expired ? 'expired' : null }))
      return true
    }
    // 2.5 Runtime credential management (Phase 2, design 17 §7): the two
    // change endpoints + the non-secret projection. All sit behind the auth
    // gate (never public) and never fall through to the dsh proxy. Bodies are
    // read with the same 16 KiB bound + 413-destroy discipline as login, then
    // passed to the auth facade verbatim (the facade validates the shape).
    if (pathname === '/auth/change-password' || pathname === '/auth/change-token') {
      const dimension = pathname === '/auth/change-password' ? 'password' : 'token'
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'method not allowed', code: 'method_not_allowed' }))
        return true
      }
      const finishCredentialMutation = beginCredentialMutation()
      if (finishCredentialMutation === null) {
        json(res, 503, { error: 'gateway is stopping', code: 'gateway_stopping' })
        return true
      }
      const changeReq = authRequest(req, decision)
      const clientSource = changeReq.clientAddress !== undefined && changeReq.clientAddress !== ''
        ? `client:${changeReq.clientAddress}`
        : `client:${changeReq.socketAddr}`
      try {
        const body = await readBody(req)
        if (rejectStaleHttp(res, authenticatedPrincipal)) return true
        // S24: the auth gate already established the pre-change principal.
        // Reuse it for audit instead of doing another bearer scrypt solely to
        // recover the same kind.
        const principalKind = authenticatedPrincipal?.kind ?? 'unauthenticated'
        // The change result may carry the plaintext token exactly once — it
        // is written to the response body (no-store below) but never to the
        // audit trail, which carries only the non-secret detail.
        // The body shape is the facade's contract: it validates at runtime
        // (bad_request on a non-object/out-of-bounds field), so the wire
        // `unknown` is passed through as the documented input type.
        const result = dimension === 'password'
          ? await auth.changePassword!(body as ChangePasswordInput, changeReq, authenticatedChangeProof)
          : await auth.changeToken!(body as ChangeTokenInput, changeReq, authenticatedChangeProof)
        // The auth facade fences its generation before the first credential
        // store side effect. Revoke every request/socket admitted by the old
        // generation BEFORE acknowledging success, but explicitly spare this
        // mutation's own response so its one-time token/200 can never be
        // truncated (including online-published/durability-unknown results).
        closeAuthenticatedTraffic(res)
        json(res, 200, result)
        if (auditFile !== undefined && auditFile !== null) {
          appendAuditEvent(auditFile, {
            ts: new Date().toISOString(),
            event: 'credential_changed',
            kind: 'gateway',
            detail: `${result.kind},${result.removed === true ? 'remove' : 'set'},${result.source},principal:${principalKind},${clientSource}`,
          })
        }
      } catch (error) {
        const code = (error as Error & { code?: string }).code
        // Password mutation rotates the jwt-secret first. If a later
        // credential-file write fails, the route is rejected but auth state
        // still changed; honor that generation transition and revoke every
        // older downstream while preserving this error response.
        if (authenticatedPrincipal !== null && !principalIsCurrent(authenticatedPrincipal)) {
          closeAuthenticatedTraffic(res)
        }
        if (code !== 'request_aborted' && auditFile !== undefined && auditFile !== null) {
          appendAuditEvent(auditFile, {
            ts: new Date().toISOString(),
            event: 'credential_change_rejected',
            kind: 'gateway',
            detail: `${dimension},${code ?? 'internal_error'},${clientSource}`,
          })
        }
        if (code === 'request_aborted') {
          // Gateway quiescence deliberately destroyed this downstream after
          // fencing admission. The lifecycle barrier still waits for this
          // finally, but there is no response or rejected-mutation audit to
          // publish for a body that never reached the credential facade.
        } else if (code === 'bad_request') json(res, 400, { error: 'bad request', code })
        else if (code === 'invalid_credentials') json(res, 401, { error: 'invalid credentials', code })
        else if (code === 'ambient_principal_rejected') json(res, 403, { error: 'an ambient session must supply the current password to change gateway credentials', code })
        else if (code === 'last_credential') json(res, 409, { error: 'refusing to remove the last gateway credential; configure a replacement first', code })
        else if (code === 'rate_limited') json(res, 429, { error: 'too many attempts; retry later', code })
        else if (code === 'auth_busy') json(res, 503, { error: 'authentication service is busy', code })
        else if (code === 'body_too_large') {
          json(res, 413, { error: 'request body too large', code })
          // Same 413 discipline as login: the oversized body may still be
          // streaming, so destroy the request socket instead of draining it.
          req.destroy?.()
        } else {
          json(res, 500, { error: 'internal error', code: 'internal_error' })
        }
      } finally {
        finishCredentialMutation()
      }
      return true
    }
    if (pathname === '/auth/credentials') {
      if (rejectStaleHttp(res, authenticatedPrincipal)) return true
      // HEAD is the no-body twin of GET, matching /health and /auth/login.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'method not allowed', code: 'method_not_allowed' }))
        return true
      }
      // Non-secret projection (S5): provenance + updatedAt only — the
      // verifier/hash values never leave the auth provider.
      const projection = auth.credentialProjection?.() ?? { password: null, token: null }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end()
        return true
      }
      json(res, 200, {
        password: projection.password === null ? null
          : { set: true, source: projection.password.source, updatedAt: projection.password.updatedAt },
        token: projection.token === null ? null
          : { set: true, source: projection.token.source, updatedAt: projection.token.updatedAt },
      })
      return true
    }
    // 3. Management routes → fall through to api.handle (prefix-match so
    // `/api/connections/local` PATCH/DELETE and `/api/host/*` all reach it).
    if (pathname === '/health') return false
    if (pathname.startsWith('/api/connections') || pathname.startsWith('/api/host/') || pathname.startsWith('/api/i/')) {
      if (rejectStaleHttp(res, authenticatedPrincipal)) return true
      // Claim authenticated management traffic when the real control-plane
      // context is available. This invokes the authoritative API surface
      // directly and removes the promise-resolution gap between a `false`
      // middleware verdict and SSE/local-proxy registration. Narrow unit
      // fakes may omit ctx.api and retain the historical fallthrough behavior.
      const api = (ctx as Partial<PlaneMiddlewareContext>).api
      if (api === undefined) return false
      await api.handle(req, res)
      return true
    }
    // /chamber (no trailing slash) → redirect to the dashboard's canonical URL
    // (otherwise it falls through to the dsh proxy and 404s).
    if (pathname === '/chamber') {
      if (rejectStaleHttp(res, authenticatedPrincipal)) return true
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
      if (rejectStaleHttp(res, authenticatedPrincipal)) return true
      await getRuntime().handle(req, res, pathname)
      return true
    }
    // 4. Feature host (design 17 §8.5): /chamber/* is the gateway's own
    // orchestration surface (git worktrees, approvals, cron, settings).
    if (pathname.startsWith('/chamber/')) {
      if (rejectStaleHttp(res, authenticatedPrincipal)) return true
      await getFeatures().handle(req, res, pathname)
      return true
    }
    // 5. Everything else (/api/* rest, /plugins/*, / and assets) → gateway-proxy.
    // Relax the shell's nonce CSP for the proxied dsh HTML (S14): the proxy
    // cannot backfill the nonce, so script-src must allow dsh's inline scripts.
    res.setHeader('content-security-policy', GATEWAY_PROXY_CSP)
    if (rejectStaleHttp(res, authenticatedPrincipal)) return true
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
      rejectWs(socket, decision.status, decision.code === 'bad_request' ? 'malformed request headers'
        : decision.code === 'misdirected_request' ? 'misdirected request'
          : 'request origin is not allowed', decision.code)
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
    if (!principalIsCurrent(principal)) {
      rejectWs(socket, 401, 'unauthorized')
      return true
    }
    // Register before route dispatch. A generation bump while an upstream
    // handshake is pending destroys this downstream socket; the existing
    // proxy close listener then aborts the upstream leg as well.
    trackSocket(socket)
    // 2. The two dsh downlink stream paths → origin fence + gateway-proxy.
    if (pathname === '/api/events.mux' || pathname === '/api/events.host') {
      if (!principalIsCurrent(principal)) {
        rejectWs(socket, 401, 'unauthorized')
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
    // 3. Instance streams use the authoritative control-plane proxy directly
    // when its context is available, avoiding a post-middleware rotation gap.
    if (pathname.startsWith('/api/i/')) {
      if (!principalIsCurrent(principal)) {
        rejectWs(socket, 401, 'unauthorized')
        return true
      }
      const instanceProxy = (ctx as Partial<PlaneMiddlewareContext>).instanceProxy
      if (instanceProxy !== undefined) {
        try {
          await instanceProxy.handleUpgrade(req as never, socket as never, head)
        } catch (error) {
          logger.warn(`gateway dispatch: instance upgrade failure: ${String(error)}`)
          socket.destroy()
        }
        return true
      }
    }
    // 4. Everything else → fall through (the default proxy rejects unknown
    // paths; authenticated sockets remain generation-tracked until close).
    return false
  }

  return {
    middleware,
    upgradeMiddleware,
    resume(): void { credentialMutationsAccepted = true },
    quiesce,
  }
}
