/**
 * Gateway dispatch middleware: the auth gate + surface routing injected into the
 * control-plane shell via `middleware` / `upgradeMiddleware` hooks. A truthy
 * return CLAIMS the request/upgrade; falsy falls through to the default dispatch.
 *
 * Public: /health, /auth/login (password deployments only). Pre-gate claim:
 * /plugins/** pre-warm (GET/HEAD + valid capability cookie). Behind the gate:
 * /auth credential routes, /chamber/runtime/* (not ready-gated), /chamber/* and
 * the opt-in mobile-UA 302; everything else → management API or proxy.
 * Every auth-boundary rejection (HTTP and WS) appends one non-secret `auth_rejected`
 * event (code + client + path CATEGORY); identical refusals in a window collapse.
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
import { DEFAULT_MOBILE_ENTRY_PATH } from './config.ts'
import type { GatewayProxy } from './gateway-proxy.ts'
import type { ChamberSurface } from './routes.ts'
import type { RuntimeRoutes } from './runtime-routes.ts'
import type { GatewayRejectionReason, GatewayRequestDecision, GatewayRequestPolicy } from './middleware.ts'
import { appendAuditEvent } from './audit.ts'
import { LOGIN_PAGE_CSP, detectLoginLang, renderBoundaryErrorPage, renderLoginPage, renderTokenOnlyPage, wantsHtmlLoginResponse } from './login-page.ts'
import { codedError, headerValue, jsonResponse, readBoundedBody } from './http-utils.ts'
import {
  createWarmupController,
  type WarmupDeps,
  type WarmupHttpRequest,
  type WarmupHttpResponse,
  type WarmupLinks,
} from './warmup.ts'

function isPublicRequest(method: string | undefined, pathname: string): boolean {
  // HEAD is the no-body twin of GET, so a monitoring HEAD /health stays public.
  if (pathname === '/health') return method === 'GET' || method === 'HEAD'
  // /plugins/** gets NO blanket public exemption: only a real bundle shape with
  // a valid capability cookie is claimed BEFORE the gate; everything else
  // (stale cookie, disabled warm-up controller, plain plugin route) keeps its
  // 401/session verdict, never an unauthenticated fallthrough.
  return pathname === '/auth/login' && (method === 'GET' || method === 'HEAD' || method === 'POST')
}

/** Mobile-UA sniffing for the opt-in experience shunting. Deliberately broad
 * and forgeable — routing sugar only, never a security boundary. */
const MOBILE_UA_PATTERN = /Mobile|Android|iPhone|iPad|iPod/i

/** Path CATEGORY for audit details: a target may carry a capability token or a
 * session query, so only the coarse class is recorded — never path or query. */
function auditPathCategory(pathname: string): string {
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'api'
  if (pathname === '/plugins' || pathname.startsWith('/plugins/')) return 'plugins'
  if (pathname === '/chamber' || pathname.startsWith('/chamber/')) return 'chamber'
  if (pathname.startsWith('/auth/')) return 'auth'
  return 'root'
}

/** Debounce window (ms) for repeated IDENTICAL auth-boundary rejections. Each
 * `appendAuditEvent` is an append + fsync, so a credential-less burst would pin
 * the event loop on disk I/O; the MECHANISM, not a measurement, motivates it. */
export const AUTH_REJECTION_DEBOUNCE_MS = 1000

/** Cap on simultaneously open debounce windows, keyed by (client, code, path
 * category). Client identities are unbounded, so at the cap the oldest window
 * is published early — its aggregate record still lands. */
export const MAX_AUTH_REJECTION_WINDOWS = 256

/** Seam for the auth-rejection debounce: the window state belongs to ONE
 * `createGatewayDispatch` instance, never a module-global singleton. */
export interface AuthRejectionDebounce {
  /** Milliseconds since epoch (default `Date.now`). */
  now?: () => number
  /** Window override; defaults to `AUTH_REJECTION_DEBOUNCE_MS`. */
  windowMs?: number
  /** One-shot window-end scheduler returning its cancel handle; default is an
   * unref'd `setTimeout` (a flush timer must never hold the process open). */
  schedule?: (flush: () => void, ms: number) => () => void
}

/** The non-secret client identifier for login/credential events: the
 * boundary-derived client address, falling back to the socket peer (both IPs). */
function clientIdent(clientAddress: string | undefined, socketAddr: string | undefined): string {
  return clientAddress !== undefined && clientAddress !== '' ? clientAddress : socketAddr ?? ''
}

function shouldRedirectToLogin(req: ApiRequest, pathname: string, auth: AuthProvider): boolean {
  if (auth.kind !== 'password' && auth.kind !== 'password+token') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!(headerValue(req.headers, 'accept') ?? '').toLowerCase().includes('text/html')) return false
  // Protocol/API surfaces even when a client advertises HTML: /api, /plugins,
  // /auth, and /chamber/<subpath>. Document navigations (/, /chamber, /chamber/)
  // reach the form.
  return pathname !== '/api' && !pathname.startsWith('/api/')
    && pathname !== '/plugins' && !pathname.startsWith('/plugins/')
    && !pathname.startsWith('/auth/')
    && !(pathname.startsWith('/chamber/') && pathname !== '/chamber/')
}

/**
 * CSP for the PROXIED dsh frontend — a gateway-only relaxation of the shell's
 * nonce CSP: dsh's own render output carries inline `__DSH_BOOT__`/loader scripts
 * with no nonce and this process does not backfill nonces for scripts it does not
 * own, so script-src allows `unsafe-inline` rather than white-screening a frontend
 * already behind the auth gate. `base-uri` is `'self'` because upstream injects
 * `<base href="/">`, which `base-uri 'none'` would make the browser refuse; every
 * other directive (incl. `frame-src blob:` for the preview plugin) matches the
 * shell's. The anonymous desktop shape never sees this header.
 */
const GATEWAY_PROXY_CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-src blob:; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:"

/** A browser *document* rejection (GET/HEAD/POST advertising HTML) gets the
 * rendered error page instead of a bare JSON body; JSON/API clients keep the
 * JSON shape (plus the additive `detail`). */
function wantsHtmlBoundaryPage(req: ApiRequest): boolean {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return false
  return (headerValue(req.headers, 'accept') ?? '').toLowerCase().includes('text/html')
}

/** Non-secret one-line detail appended to the JSON boundary errors (the HTML
 * page carries the localized explanation); JSON.stringify-quoted, never logged. */
function rejectionDetail(reason: GatewayRejectionReason): string {
  switch (reason.kind) {
    case 'malformed_headers': return 'malformed or duplicate request headers were rejected'
    case 'host_rejected': return reason.host === undefined
      ? 'the request carried no Host authority accepted by this gateway'
      : `request Host ${JSON.stringify(reason.host)} is not an accepted gateway authority`
    case 'origin_invalid': return `Origin ${JSON.stringify(reason.origin)} is not a valid browser origin`
    case 'origin_mismatch': return `Origin ${JSON.stringify(reason.origin)} does not match the gateway authority ${JSON.stringify(reason.authority)}`
    case 'cross_site_no_origin': return 'a cross-site request without an Origin header was rejected'
  }
}

/** Send the request-policy rejection response: the styled HTML error page
 * (same status, no-script CSP, localized) for browser documents, the JSON
 * shape with the additive `detail` otherwise. */
function sendBoundaryRejection(res: ApiResponse, req: ApiRequest, decision: GatewayRequestDecision): void {
  if (decision.allowed) return // internal contract: only called on rejections
  // Narrowed for the render options: a rejected decision is never 'ok'.
  const code: 'bad_request' | 'misdirected_request' | 'origin_forbidden' =
    decision.code === 'bad_request' ? 'bad_request'
      : decision.code === 'misdirected_request' ? 'misdirected_request'
        : 'origin_forbidden'
  const message = code === 'bad_request' ? 'malformed request headers'
    : code === 'misdirected_request' ? 'misdirected request'
      : 'request origin is not allowed'
  const reason = decision.reason
  if (wantsHtmlBoundaryPage(req) && reason !== undefined) {
    res.setHeader('content-security-policy', LOGIN_PAGE_CSP)
    res.writeHead(decision.status, LOGIN_HTML_HEADERS)
    res.end(req.method === 'HEAD' ? undefined : renderBoundaryErrorPage({
      lang: detectLoginLang(headerValue(req.headers, 'accept-language')),
      status: decision.status,
      code,
      reasonKind: reason.kind,
      ...(reason.kind === 'host_rejected' && reason.host !== undefined ? { host: reason.host } : {}),
      ...(reason.kind === 'origin_invalid' ? { origin: reason.origin } : {}),
      ...(reason.kind === 'origin_mismatch' ? { origin: reason.origin, authority: reason.authority } : {}),
    }))
    return
  }
  jsonResponse(res, decision.status, {
    error: message,
    code: decision.code,
    ...(reason === undefined ? {} : { detail: rejectionDetail(reason) }),
  })
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

/** Uniform response headers for every login-page HTML response (CSP is set
 * separately).
 *
 * `referrer-policy` must NOT be `no-referrer`: per the fetch spec that policy
 * serializes a non-CORS form submission's Origin as `null`, and the request
 * policy fails opaque origins closed, so the login POST would 403 in every
 * compliant browser (curl, which sends no Origin, would still pass).
 * `same-origin` keeps the privacy intent — no cross-site outbound requests
 * (CSP default-src 'none') — while letting the browser send its true Origin. */
const LOGIN_HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
} as const

/** Read a bounded login body (form-urlencoded or JSON); unsupported/malformed
 * media is a 400, never silently treated as an empty credential. */
async function readBody(req: ApiRequest): Promise<unknown> {
  // 16 KiB leaves ample encoding room (a password is capped at 1024 chars)
  // without letting anonymous slow clients reserve a megabyte per connection.
  const MAX = 16 * 1024
  const outcome = await readBoundedBody(req, MAX)
  if (outcome.kind === 'oversize') throw codedError('body_too_large', 'login body too large')
  if (outcome.kind === 'aborted') throw codedError('request_aborted', 'request body aborted')
  if (outcome.kind === 'closed') throw codedError('request_aborted', 'request body closed before completion')
  if (outcome.kind === 'stream-error') throw outcome.error
  const text = outcome.buffer.toString('utf8')
  const contentType = (headerValue(req.headers, 'content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  if (contentType === 'application/x-www-form-urlencoded' || contentType === 'application/json') {
    try {
      if (contentType === 'application/x-www-form-urlencoded') {
        const form = new URLSearchParams(text)
        return { password: form.get('password') ?? undefined }
      }
      return text === '' ? {} : JSON.parse(text)
    } catch {
      // The kernel's oversize/abort rejections above are thrown OUTSIDE this
      // try: a parse failure is a malformed body, never a size/transport one.
      throw codedError('bad_request', 'malformed login body')
    }
  }
  // Deliberately outside the try: never relabeled as a malformed body.
  throw codedError('bad_request', 'unsupported login content type')
}

export interface GatewayDispatch {
  middleware: NonNullable<import('@dsh-chamber/control-plane').ControlPlaneOptions['middleware']>
  upgradeMiddleware: NonNullable<import('@dsh-chamber/control-plane').ControlPlaneOptions['upgradeMiddleware']>
  /** Re-open credential-mutation admission after a fully quiesced stop. */
  resume(): void
  /** Fence new credential mutations, close the authenticated traffic snapshot
   * and drain every mutation past admission before ownership is released. */
  quiesce(): Promise<void>
  /** Post-listener-close drain of the auth-rejection debounce windows, so a
   * refusal accepted after the fence cannot lose its count. Idempotent. */
  flushAuditWindows(): void
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
  getFeatures: () => ChamberSurface,
  getRuntime: () => RuntimeRoutes,
  logger: Logger,
  requestPolicy: GatewayRequestPolicy,
  auditFile?: string | null,
  /** UA experience shunting; default OFF. */
  mobileUaRedirect = false,
  mobileEntryPath = DEFAULT_MOBILE_ENTRY_PATH,
  /** Auth-rejection debounce seam; defaults are production behavior. */
  rejectionDebounce: AuthRejectionDebounce = {},
  /** Login-phase pre-warm deps (default ON from config.warmup). null = the
   * feature is not composed at all (no discovery, no grant mint, no route
   * claim), so every /plugins target keeps its usual 401/session verdict. */
  warmupDeps: WarmupDeps | null = null,
): GatewayDispatch {
  const warmup = warmupDeps === null ? null : createWarmupController(warmupDeps)
  /** warn-once latch for an unexpected warm-up links() rejection: links()
   *  fails soft by contract, so an exception here is a visible contract break. */
  let warmupLinksFailureWarned = false
  // Every request/socket admitted by one credential generation stays tracked
  // until its downstream leg ends; rotation closes the old generation at the
  // dispatch boundary, uniformly covering the proxy, the chamber surface and
  // the anonymous management/instance fallthrough.
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
    // Production sockets are Duplex/EventEmitter; minimal `{destroy,end}`
    // shapes are still tracked, with lifecycle release attached when present.
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
    // The snapshot closes AFTER the synchronous admission fence: a pre-fence
    // request still reading its body is forced into its finally, and one
    // already writing credentials stays tracked until its route tail completes.
    closeAuthenticatedTraffic()
    while (activeCredentialMutations.size > 0) {
      await Promise.allSettled([...activeCredentialMutations])
    }
    // The debounce counts live in memory — publish every open window
    // before ownership is released, or a mid-window stop loses them.
    flushRejectionWindows()
  }
  /** Publish every still-open auth-rejection window after the HTTP listener
   * closes (a rejection arriving between the fence drain and the close opens a
   * window the first drain could not see). Idempotent. */
  function flushAuditWindows(): void {
    flushRejectionWindows()
  }
  function rejectStaleHttp(res: ApiResponse, principal: AuthPrincipal | null): boolean {
    if (principal === null || principalIsCurrent(principal)) return false
    const state = res as ApiResponse & { destroyed?: boolean; writableEnded?: boolean }
    if (state.destroyed !== true && state.writableEnded !== true) {
      jsonResponse(res, 401, { error: 'unauthorized', code: 'unauthorized' })
    }
    return true
  }

  const rejectionWindowMs = rejectionDebounce.windowMs ?? AUTH_REJECTION_DEBOUNCE_MS
  const rejectionNow = rejectionDebounce.now ?? Date.now
  const scheduleRejectionFlush = rejectionDebounce.schedule ?? ((flush: () => void, ms: number) => {
    const timer = setTimeout(flush, ms)
    timer.unref?.()
    return (): void => { clearTimeout(timer) }
  })
  /** One open debounce window: start, identical-refusal count, detail, cancel. */
  interface RejectionWindow { start: number; count: number; detail: string; cancel: () => void }
  /** Open windows keyed by client + code + path category: identical refusals
   * coalesce, different keys never do. Bounded — distinct clients (a proxied or
   * IPv6 source can mint many) must not grow the map without limit, so at the
   * cap the OLDEST window is published early. */
  const rejectionWindows = new Map<string, RejectionWindow>()

  /** Close one window, appending its coalesced record when suppressed refusals
   * exist. `expected` pins the entry so a late timer cannot flush a successor. */
  function closeRejectionWindow(key: string, expected: RejectionWindow): void {
    const open = rejectionWindows.get(key)
    if (open === undefined || open !== expected) return
    rejectionWindows.delete(key)
    open.cancel()
    if (open.count < 2 || auditFile === undefined || auditFile === null) return
    appendAuditEvent(auditFile, {
      ts: new Date(rejectionNow()).toISOString(),
      event: 'auth_rejected',
      kind: 'gateway',
      detail: `${open.detail},count:${open.count}`,
    })
  }

  /** Publish the oldest window when the map is at its cap (Map insertion order;
   * every window lives <= one window width). */
  function evictOldestRejectionWindow(): void {
    for (const [key, open] of rejectionWindows) {
      closeRejectionWindow(key, open)
      return
    }
  }

  /** Close every still-open window (the `quiesce()` fence drain and the
   * post-listener-close `flushAuditWindows`): the counts live in memory. */
  function flushRejectionWindows(): void {
    for (const [key, open] of [...rejectionWindows]) closeRejectionWindow(key, open)
  }

  /**
   * Authentication-face audit: one NON-SECRET event per auth-boundary rejection —
   * machine code, client identifier and a path CATEGORY; never a credential/header
   * value, never the concrete path or query.
   *
   * Each append is one synchronous fsync, so refusals identical in
   * (client, code, path category) coalesce inside `AUTH_REJECTION_DEBOUNCE_MS`: the
   * first lands immediately, the rest are counted and ONE aggregate record carrying
   * `count:<n>` lands at window close (a burst of N writes 2 lines). Client verdicts
   * never change; login_* / credential_* keep one record each; the 302 to the login
   * page, 503 auth_busy and the stale 401 of a revoked generation are NOT audited.
   */
  function auditAuthRejection(
    code: string,
    clientAddress: string | undefined,
    socketAddr: string | undefined,
    pathname?: string,
  ): void {
    if (auditFile === undefined || auditFile === null) return
    const client = `client:${clientIdent(clientAddress, socketAddr)}`
    const category = pathname === undefined ? '' : auditPathCategory(pathname)
    const detail = category === '' ? `code:${code},${client}` : `code:${code},${client},path:${category}`
    const key = `${client}\u0000${code}\u0000${category}`
    const at = rejectionNow()
    const open = rejectionWindows.get(key)
    if (open !== undefined) {
      if (at - open.start < rejectionWindowMs) {
        // In-window duplicate: coalesced into the count, no append.
        open.count += 1
        return
      }
      // Window elapsed but its timer has not run: publish its count first.
      closeRejectionWindow(key, open)
    }
    appendAuditEvent(auditFile, {
      ts: new Date(at).toISOString(),
      event: 'auth_rejected',
      kind: 'gateway',
      detail,
    })
    const entry: RejectionWindow = { start: at, count: 1, detail, cancel: () => {} }
    if (rejectionWindows.size >= MAX_AUTH_REJECTION_WINDOWS) evictOldestRejectionWindow()
    rejectionWindows.set(key, entry)
    entry.cancel = scheduleRejectionFlush(() => closeRejectionWindow(key, entry), rejectionWindowMs)
  }

  const middleware: GatewayDispatch['middleware'] = async (req, res, url, ctx) => {
    const pathname = url.pathname
    let authenticatedPrincipal: AuthPrincipal | null = null
    let authenticatedChangeProof: AuthChangeProof | undefined
    // -1. One authority/origin boundary for every HTTP surface, including
    // public paths and OPTIONS. Its result also supplies sanitized auth facts.
    const decision = requestPolicy.evaluate(req)
    if (!decision.allowed) {
      // The boundary's own rejection (400/421/403) is an authentication-face
      // event: non-secret code + client + path category only.
      auditAuthRejection(decision.code, decision.clientAddress, req.socket?.remoteAddress, pathname)
      sendBoundaryRejection(res, req, decision)
      return true
    }
    res._corsHeaders = decision.headers
    for (const [name, value] of Object.entries(decision.headers)) res.setHeader(name, value)
    // 0. CORS preflight: OPTIONS carries no Authorization and applies to
    // gateway-owned and control-plane paths alike, so claim it here.
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
    // 0.5 Login-phase pre-warm: the ONE pre-auth proxy leg, consulted BEFORE
    // the gate so a valid capability grant can stream a real bundle URL without
    // a session. It claims a GET/HEAD only when the kill switch is on, the target
    // is a real bundle shape, and the short-lived HttpOnly capability cookie
    // (minted on the login-page response) verifies; anything else falls through
    // to the gate. Route-level refusals (405/429) are audited here with the
    // client's code; the cookie value and the URL never enter the trail.
    if (warmup !== null) {
      const outcome = await warmup.handle(
        req as unknown as WarmupHttpRequest,
        res as unknown as WarmupHttpResponse,
        url,
        decision.clientAddress,
      )
      if (outcome.kind === 'rejected') {
        auditAuthRejection(outcome.code, decision.clientAddress, req.socket?.remoteAddress, pathname)
        return true
      }
      if (outcome.kind === 'proxied') return true
    }
    // 1. Auth gate (public paths exempt). The token/password providers do not
    // use socketAddr; the Host authority decision belongs to the request policy.
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
        // answers 503 auth_busy — the login path's code — never a 500 internal.
        const code = (error as Error & { code?: string }).code
        if (code === 'auth_busy') {
          jsonResponse(res, 503, { error: 'authentication service is busy', code: 'auth_busy' })
          return true
        }
        throw error
      }
      if (principal === null) {
        if (shouldRedirectToLogin(req, pathname, auth)) {
          // Invalid session cookie → the expired hint; a first visit stays plain.
          const hadSession = (headerValue(req.headers, 'cookie') ?? '').split(';').some(part => part.trim().startsWith(`${SESSION_COOKIE}=`))
          // Carry the mobile-shunting escape marker through the login round-trip.
          const desktopMarker = url.searchParams.has('desktop') ? (hadSession ? '&desktop=1' : '?desktop=1') : ''
          res.writeHead(302, { location: `${hadSession ? '/auth/login?expired=1' : '/auth/login'}${desktopMarker}`, 'cache-control': 'no-store' })
          res.end()
          return true
        }
        auditAuthRejection('unauthorized', decision.clientAddress, req.socket?.remoteAddress, pathname)
        jsonResponse(res, 401, { error: 'unauthorized', code: 'unauthorized' })
        return true
      }
      // verify() can resolve after a credential mutation: reject that stale
      // verdict and register downstream synchronously, before any route await.
      if (!principalIsCurrent(principal)) {
        auditAuthRejection('unauthorized', decision.clientAddress, req.socket?.remoteAddress, pathname)
        jsonResponse(res, 401, { error: 'unauthorized', code: 'unauthorized' })
        return true
      }
      authenticatedPrincipal = principal
      // Capture synchronously at admission: the opaque proof is accepted only
      // by the same provider/generation, so credential routes can reuse it.
      authenticatedChangeProof = auth.captureChangeProof?.(principal) ?? undefined
      trackHttp(req, res)
    }
    // 2. Auth login (public): POST verifies and sets the session cookie → 302
    // to `/`; GET serves the login page. The route EXISTS only while a password
    // is configured, so a token-only (or none) deployment answers 404 here.
    if (pathname === '/auth/login') {
      res.setHeader('content-security-policy', LOGIN_PAGE_CSP)
      const lang = detectLoginLang(headerValue(req.headers, 'accept-language'))
      // Escape marker: kept through renders so the form action stays on
      // /auth/login?desktop=1 and success lands on /?desktop=1.
      const loginDesktop = url.searchParams.has('desktop')
      if (auth.kind !== 'password' && auth.kind !== 'password+token') {
        // Token-only / no-auth deployment: browsers get a minimal HTML page,
        // API clients keep the JSON 404; the copy varies by auth kind — a
        // `--no-auth` deployment has no token and must not claim one.
        const acceptHtml = (headerValue(req.headers, 'accept') ?? '').toLowerCase().includes('text/html')
        if (wantsHtmlLoginResponse(req.headers)
          || ((req.method === 'GET' || req.method === 'HEAD') && acceptHtml)) {
          res.writeHead(404, LOGIN_HTML_HEADERS)
          res.end(req.method === 'HEAD' ? undefined : renderTokenOnlyPage(lang, auth.kind === 'none' ? 'none' : 'token'))
        } else {
          jsonResponse(res, 404, { error: 'not_found', code: 'not_found' })
        }
        return true
      }
      if (req.method === 'POST') {
        // Audits ONLY the non-secret auth RESULT — never the submitted
        // password, never the session cookie (setCookie is excluded).
        const loginReq = authRequest(req, decision)
        const loginSource = loginReq.clientAddress !== undefined && loginReq.clientAddress !== ''
          ? `client:${loginReq.clientAddress}`
          : `client:${loginReq.socketAddr}`
        try {
          const body = await readBody(req)
          const { setCookie } = await auth.login!(body, loginReq)
          if (setCookie !== undefined) res.setHeader('set-cookie', setCookie)
          // The form action carries ?desktop=1 when the visitor escaped the
          // shunting: land back on the desktop entry, not '/' (shunted again).
          res.writeHead(302, { location: loginDesktop ? '/?desktop=1' : '/', 'cache-control': 'no-store' })
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
          // `no_password` is a race-only fallback: the facade threw it between
          // the kind check and the login call (a concurrent removal) — 404.
          if (code === 'no_password') {
            jsonResponse(res, 404, { error: 'not_found', code: 'not_found' })
          }
          else if (code === 'rate_limited') {
            const retryAfterSec = Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000))
            if (html) {
              res.writeHead(429, { ...LOGIN_HTML_HEADERS, 'retry-after': String(retryAfterSec) })
              res.end(renderLoginPage({ lang, secure: decision.secure, error: 'rate_limited', retryAfterSec, desktop: loginDesktop }))
            } else {
              // jsonResponse() would overwrite retry-after via writeHead; set it first
              // (setHeader values are merged by writeHead in the real server).
              res.setHeader('retry-after', String(retryAfterSec))
              jsonResponse(res, 429, { error: 'too many login attempts', code: 'rate_limited' })
            }
          }
          else if (code === 'auth_busy') {
            if (html) {
              res.writeHead(503, LOGIN_HTML_HEADERS)
              res.end(renderLoginPage({ lang, secure: decision.secure, error: 'busy', desktop: loginDesktop }))
            } else {
              jsonResponse(res, 503, { error: 'authentication service is busy', code: 'auth_busy' })
            }
          }
          else if (code === 'body_too_large') {
            jsonResponse(res, 413, { error: 'request body too large', code })
            // The 413 is written while the oversized body may still stream:
            // destroy the request socket instead of draining it.
            req.destroy?.()
          } else if (code === 'bad_request') jsonResponse(res, 400, { error: 'bad request', code })
          else {
            if (html) {
              res.writeHead(401, LOGIN_HTML_HEADERS)
              res.end(renderLoginPage({ lang, secure: decision.secure, error: 'invalid', desktop: loginDesktop }))
            } else {
              jsonResponse(res, 401, { error: 'invalid credentials', code: 'invalid_credentials' })
            }
          }
        }
        return true
      }
      const expired = url.searchParams.get('expired') === '1'
      // Pre-warm: the REAL bundle hrefs + the short-lived HttpOnly capability
      // cookie that lets the anonymous prefetch through; links() fails soft, so
      // a down dsh leaves the template byte-identical and HEAD is never awaited.
      const warmupLinks: WarmupLinks = warmup === null || req.method !== 'GET'
        ? { urls: [] }
        : await warmup.links({ clientAddress: decision.clientAddress, secure: decision.secure }).catch((error: unknown) => {
            // links() fails soft (warmup.ts owns discovery logging), so this is
            // a defensive catch that must still record the contract break once.
            if (!warmupLinksFailureWarned) {
              warmupLinksFailureWarned = true
              logger.warn(`gateway dispatch: warm-up links unavailable; login page renders without pre-warm links: ${String(error)}`)
            }
            return { urls: [] }
          })
      if (warmupLinks.cookie !== undefined && warmupLinks.cookie !== '') res.setHeader('set-cookie', warmupLinks.cookie)
      res.writeHead(200, LOGIN_HTML_HEADERS)
      res.end(req.method === 'HEAD' ? undefined : renderLoginPage({ lang, secure: decision.secure, error: expired ? 'expired' : null, desktop: loginDesktop, warmupUrls: warmupLinks.urls }))
      return true
    }
    // 2.5 Runtime credential management: the two change endpoints + the
    // non-secret projection, behind the gate and never falling through to the
    // dsh proxy. Bodies use login's 16 KiB bound + 413-destroy discipline.
    if (pathname === '/auth/change-password' || pathname === '/auth/change-token') {
      const dimension = pathname === '/auth/change-password' ? 'password' : 'token'
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'method not allowed', code: 'method_not_allowed' }))
        return true
      }
      const finishCredentialMutation = beginCredentialMutation()
      if (finishCredentialMutation === null) {
        jsonResponse(res, 503, { error: 'gateway is stopping', code: 'gateway_stopping' })
        return true
      }
      const changeReq = authRequest(req, decision)
      const clientSource = changeReq.clientAddress !== undefined && changeReq.clientAddress !== ''
        ? `client:${changeReq.clientAddress}`
        : `client:${changeReq.socketAddr}`
      try {
        const body = await readBody(req)
        if (rejectStaleHttp(res, authenticatedPrincipal)) return true
        // The gate already established the pre-change principal: reuse it for
        // audit instead of another bearer scrypt solely to recover its kind.
        const principalKind = authenticatedPrincipal?.kind ?? 'unauthenticated'
        // The change result may carry the plaintext token exactly once — written
        // to the response body (no-store below), never to the audit trail. The
        // facade validates the wire shape at runtime.
        const result = dimension === 'password'
          ? await auth.changePassword!(body as ChangePasswordInput, changeReq, authenticatedChangeProof)
          : await auth.changeToken!(body as ChangeTokenInput, changeReq, authenticatedChangeProof)
        // The facade fences its generation before the first credential store
        // side effect: revoke every old-generation request/socket BEFORE
        // acknowledging success, sparing this mutation's own response.
        closeAuthenticatedTraffic(res)
        jsonResponse(res, 200, result)
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
        // Password mutation rotates the jwt-secret first: a later credential-
        // file write failure still leaves auth state changed, so revoke older
        // downstreams while preserving this error response.
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
          // fencing admission: no response and no audit for an unread body.
        } else if (code === 'bad_request') jsonResponse(res, 400, { error: 'bad request', code })
        else if (code === 'invalid_credentials') jsonResponse(res, 401, { error: 'invalid credentials', code })
        else if (code === 'ambient_principal_rejected') jsonResponse(res, 403, { error: 'an ambient session must supply the current password to change gateway credentials', code })
        else if (code === 'last_credential') jsonResponse(res, 409, { error: 'refusing to remove the last gateway credential; configure a replacement first', code })
        else if (code === 'rate_limited') jsonResponse(res, 429, { error: 'too many attempts; retry later', code })
        else if (code === 'auth_busy') jsonResponse(res, 503, { error: 'authentication service is busy', code })
        else if (code === 'body_too_large') {
          jsonResponse(res, 413, { error: 'request body too large', code })
          // Same 413 discipline as login: destroy the socket rather than drain.
          req.destroy?.()
        } else {
          jsonResponse(res, 500, { error: 'internal error', code: 'internal_error' })
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
      // Non-secret projection: provenance + updatedAt only — verifier/hash
      // values never leave the auth provider.
      const projection = auth.credentialProjection?.() ?? { password: null, token: null }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end()
        return true
      }
      jsonResponse(res, 200, {
        password: projection.password === null ? null
          : { set: true, source: projection.password.source, updatedAt: projection.password.updatedAt },
        token: projection.token === null ? null
          : { set: true, source: projection.token.source, updatedAt: projection.token.updatedAt },
      })
      return true
    }
    // 3. Management routes → fall through to api.handle (prefix-match, so
    // /api/connections/local PATCH/DELETE and /api/host/* all reach it).
    // /api/i/<id>/* shapes facts here: no instance transports are registered,
    // so every dsh-/gateway-/ssh- id answers a constant 503 'no transport is
    // available for this instance' and only `local` resolves. The "/" proxy
    // applies GATEWAY_PROXY_CSP + the trust declaration; /api/i/local/* keeps
    // the shell's nonce CSP without injection (known divergence).
    if (pathname === '/health') return false
    if (pathname.startsWith('/api/connections') || pathname.startsWith('/api/host/') || pathname.startsWith('/api/i/')) {
      if (rejectStaleHttp(res, authenticatedPrincipal)) return true
      // Claim authenticated management traffic when the real control-plane
      // context is available, removing the promise-resolution gap between a
      // `false` verdict and SSE/local-proxy registration. Fakes may omit ctx.api.
      const api = (ctx as Partial<PlaneMiddlewareContext>).api
      if (api === undefined) return false
      await api.handle(req, res)
      return true
    }
    // /chamber (no trailing slash) → the dashboard's canonical URL.
    if (pathname === '/chamber') {
      if (rejectStaleHttp(res, authenticatedPrincipal)) return true
      res.writeHead(302, { location: '/chamber/', 'cache-control': 'no-store' })
      res.end()
      return true
    }
    // 3.5 Runtime controller: claimed BEFORE the chamber surface — it manages
    // dsh itself and must stay pollable while dsh is down. Exact-prefix match
    // only: /chamber/runtimeevil must NOT be claimed.
    if (pathname === '/chamber/runtime' || pathname.startsWith('/chamber/runtime/')) {
      if (rejectStaleHttp(res, authenticatedPrincipal)) return true
      await getRuntime().handle(req, res, pathname)
      return true
    }
    // 4. Chamber surface: the gateway's own operations surface — channels
    // projection, dashboard assets, the plugin seed cache and the
    // managed-profile plugin read/write routes (writes answer 202; quiesce/
    // dispose accounting lives in index.ts). NOT ready-gated: stays pollable.
    if (pathname.startsWith('/chamber/')) {
      if (rejectStaleHttp(res, authenticatedPrincipal)) return true
      await getFeatures().handle(req, res, pathname)
      return true
    }
    // 4.5 Mobile UA shunting (default off): an authenticated mobile-browser
    // GET/HEAD of the root is a 302 to the mobile entry. UA sniffing is
    // forgeable and carries NO security semantics — the shunting sits AFTER the
    // gate and keeps the fallthrough staleness guard. It ignores Accept
    // (routing sugar, not negotiation); `?desktop=1` is the escape hatch back.
    if (mobileUaRedirect === true
      && (req.method === 'GET' || req.method === 'HEAD')
      && pathname === '/'
      && url.searchParams.get('desktop') === null
      && MOBILE_UA_PATTERN.test(headerValue(req.headers, 'user-agent') ?? '')) {
      if (rejectStaleHttp(res, authenticatedPrincipal)) return true
      res.writeHead(302, { location: mobileEntryPath, 'cache-control': 'no-store' })
      res.end()
      return true
    }
    // 5. Everything else (/api/* rest, /plugins/*, / and assets) → gateway-proxy,
    // with script-src relaxed for dsh's inline scripts (GATEWAY_PROXY_CSP).
    res.setHeader('content-security-policy', GATEWAY_PROXY_CSP)
    if (rejectStaleHttp(res, authenticatedPrincipal)) return true
    try {
      await getProxy().handleHttp(req, res)
    } catch (error) {
      logger.warn(`gateway dispatch: proxy failure: ${String(error)}`)
      if (!res.headersSent) jsonResponse(res, 502, { error: 'upstream_failed', code: 'upstream_failed' })
      else res.destroy()
    }
    return true
  }

  const upgradeMiddleware: GatewayDispatch['upgradeMiddleware'] = async (req, socket, head, ctx) => {
    const rawTarget = req.url ?? '/'
    if (!rawTarget.startsWith('/') || rawTarget.startsWith('//')
      || rawTarget.includes('\\') || rawTarget.includes('#')) {
      // Malformed target: no path category to record — code + client only.
      auditAuthRejection('bad_request', undefined, req.socket?.remoteAddress)
      rejectWs(socket, 400, 'invalid request target', 'bad_request')
      return true
    }
    const pathname = new URL(rawTarget, 'http://localhost').pathname
    // 0. The exact same public boundary applies before every WS route.
    const decision = requestPolicy.evaluate(req)
    if (!decision.allowed) {
      auditAuthRejection(decision.code, decision.clientAddress, req.socket?.remoteAddress, pathname)
      rejectWs(socket, decision.status, decision.code === 'bad_request' ? 'malformed request headers'
        : decision.code === 'misdirected_request' ? 'misdirected request'
          : 'request origin is not allowed', decision.code)
      return true
    }
    // 1. Auth gate (WS == HTTP): a saturated scrypt gate answers 503 auth_busy.
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
      auditAuthRejection('unauthorized', decision.clientAddress, req.socket?.remoteAddress, pathname)
      rejectWs(socket, 401, 'unauthorized')
      return true
    }
    if (!principalIsCurrent(principal)) {
      auditAuthRejection('unauthorized', decision.clientAddress, req.socket?.remoteAddress, pathname)
      rejectWs(socket, 401, 'unauthorized')
      return true
    }
    // Register before dispatch: a generation bump destroys this socket and aborts the upstream leg.
    trackSocket(socket)
    // 2. The dsh Remote-stream mux path → origin fence + gateway-proxy.
    if (pathname === '/api/remote.mux') {
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
    // 4. Everything else → fall through; authenticated sockets stay tracked.
    return false
  }

  return {
    middleware,
    upgradeMiddleware,
    resume(): void { credentialMutationsAccepted = true },
    quiesce,
    flushAuditWindows,
  }
}
