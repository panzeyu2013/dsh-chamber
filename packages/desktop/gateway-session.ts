/**
 * Gateway password-session manager: the desktop trades the stored UI password
 * for the gateway's 12-hour HS256 JWT cookie (`dsh_gateway_session`) at
 * `POST /auth/login`; callers inject that cookie as the bounded `Cookie`
 * header of a gateway-kind transport, and it only ever reaches its own origin.
 *
 * Password and cookie never enter logs or any file — main-process memory only,
 * keyed by origin/Host plus a stable connection-and-target scope, never seen by
 * the renderer. The 3xx set-cookie answer is handled MANUALLY; an https
 * `spkiPin` pins the login like the identity probe, a mismatch being terminal
 * `other`, never transient `network`.
 */

import { request as nodeHttpRequest } from 'node:http'
import { request as nodeHttpsRequest } from 'node:https'
import { createHash } from 'node:crypto'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { TransportInstanceSpec } from './transport-provider.ts'
import {
  attachSpkiPinVerifier,
  SPKI_PIN_MISMATCH_CODE,
  GATEWAY_SESSION_COOKIE_NAME as PROTO_SESSION_COOKIE_NAME,
  GATEWAY_SESSION_COOKIE_VALUE_MAX_CHARS as PROTO_SESSION_COOKIE_VALUE_MAX_CHARS,
  GATEWAY_SESSION_TTL_SECONDS as PROTO_SESSION_TTL_SECONDS,
} from './control-plane-module.ts'

/** Injectable outbound request factory (defaults to the node:http/https
 *  request chosen by the origin scheme; tests inject a fake/spy). */
export type GatewayHttpRequest = typeof nodeHttpRequest

/** One gateway login target: the http(s) origin the transport proxies to. */
export interface GatewaySessionOrigin {
  /** Gateway origin, e.g. `https://gw.example.com` — origin form, no
   *  credentials/path/query (mirrors instance-proxy's baseUrl gate). */
  baseUrl: string
  /** true = plaintext http (the user's explicit `insecureHttp` choice);
   *  false = https (the default). */
  insecureHttp: boolean
  /** Optional SPKI certificate pin: an https login is pinned like the identity
   *  probe (rejectUnauthorized:false + agent:false + secureConnect verifier), so
   *  an internal-CA login can succeed and a mismatch is a deterministic `other`
   *  (terminal), never transient `network`. http origins never carry a pin. */
  spkiPin?: string
  /** Optional upstream Host override for an ssh-tunneled target: it connects
   *  to the loopback tunnel endpoint but must present the REMOTE gateway
   *  authority, whose port must equal the gateway's listen port. The login POST
   *  and the cache key both carry it, so the minted cookie is exactly the one
   *  later probe/registration reuse. Absent = the URL's own authority. */
  authority?: string
  /** Stable connection/target generation scope used ONLY in the in-memory cache
   *  key (never an HTTP header). Tunnel origins require it: local-port reuse and
   *  the shared remote loopback authority must not leak a cookie across hosts. */
  scope: string
}

/**
 * THE construction point of a session origin (direct provider, ssh tunnel
 * provider and refresh controller all come through here), so login, cache key
 * and proxy registration can never disagree about which fields form an origin.
 * Optional keys stay ABSENT (not undefined/null) — the cache key serializes
 * this object.
 */
export function buildGatewaySessionOrigin(input: {
  baseUrl: string
  insecureHttp: boolean
  scope: string
  spkiPin?: string | null
  authority?: string | undefined
}): GatewaySessionOrigin {
  return {
    baseUrl: input.baseUrl,
    insecureHttp: input.insecureHttp,
    scope: input.scope,
    ...(input.spkiPin === undefined || input.spkiPin === null ? {} : { spkiPin: input.spkiPin }),
    ...(input.authority === undefined ? {} : { authority: input.authority }),
  }
}

/** Stable, non-secret session ownership scope: the id distinguishes parallel
 *  connections, the target digest stops a same-id retarget inheriting a prior
 *  generation's session, and local tunnel ports are excluded so
 *  refresh/registration find the verifyUp cookie for that generation. */
export function gatewaySessionScopeForConnection(
  spec: Pick<TransportInstanceSpec, 'id' | 'transport' | 'host' | 'user' | 'sshPort' | 'remotePort'>,
): string {
  const target = spec.transport === 'ssh'
    ? ['ssh', spec.host, spec.user, spec.sshPort, spec.remotePort]
    : ['http', spec.host, spec.remotePort]
  const digest = createHash('sha256').update(JSON.stringify(target)).digest('hex')
  return `v1:${spec.id}:${digest}`
}

export type GatewayRegistrationAuthDecision =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: 'password_session_missing' }

export type GatewayRegistrationAuthProof = 'cookie' | 'bearer'

/** Fail-closed ready-registration auth decision. Password-only targets may
 *  register only with the exact scoped cookie proven by verifyUp. A configured
 *  bearer is an independent OR-principal, so token+password may intentionally
 *  register bearer-only when password login fell back to the valid token. */
export function gatewayRegistrationAuthHeaders(
  token: string | null,
  passwordConfigured: boolean,
  cookie: string | null,
  proof: GatewayRegistrationAuthProof | null,
): GatewayRegistrationAuthDecision {
  if (passwordConfigured && cookie === null && !(token !== null && proof === 'bearer')) {
    return { ok: false, reason: 'password_session_missing' }
  }
  if (passwordConfigured && cookie !== null && proof !== 'cookie') {
    return { ok: false, reason: 'password_session_missing' }
  }
  const headers: Record<string, string> = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (passwordConfigured && cookie !== null) headers.cookie = cookie
  return { ok: true, headers }
}

/** Outcome of one login attempt: on success `cookie` is the header-ready
 *  `dsh_gateway_session=<value>` string — main-process memory only, never
 *  logged or persisted. */
export type GatewaySessionResult =
  | { ok: true; cookie: string }
  | { ok: false; error: string; code: 'invalid_credentials' | 'rate_limited' | 'auth_busy' | 'network' | 'other' | 'stale' }

/** The session manager surface. */
export interface GatewaySessionManager {
  /** Perform `POST /auth/login` with a JSON `{password}` body: resolves with
   *  the session cookie on a 3xx + `dsh_gateway_session` set-cookie (cached 12h
   *  − 5min), or a classified failure; throws TypeError for a structurally
   *  invalid origin (programmer error, mirroring instance-proxy's baseUrl gate). */
  ensureSession(origin: GatewaySessionOrigin, password: string): Promise<GatewaySessionResult>
  /** Monotonic invalidation generation for the exact session key. Callers that
   *  span awaits use it to stop an old credential flow before any probe, bearer
   *  fallback, or re-login after delete/retarget/clear. */
  generation(origin: GatewaySessionOrigin): number
  /** Exact-key, current-generation non-secret authentication proof produced by
   *  verifyUp: distinguishes a proven bearer fallback from a cookie proof whose
   *  cache entry vanished before registration. */
  registrationAuthProof(origin: GatewaySessionOrigin): GatewayRegistrationAuthProof | null
  setRegistrationAuthProof(origin: GatewaySessionOrigin, proof: GatewayRegistrationAuthProof | null): void
  /** Cached header-ready cookie for the origin, or null when absent or past
   *  expiry. Synchronous — the proxy's fast path. */
  cachedCookie(origin: GatewaySessionOrigin): string | null
  /** Epoch-ms expiry of the cached session (12h TTL − 5min skew), or null when
   *  nothing is cached. The live-proxy self-healing scheduler uses it to fire a
   *  pre-expiry re-login ~60s before the cookie dies, so a REGISTERED transport
   *  never rides an expired cookie. */
  expiresAt(origin: GatewaySessionOrigin): number | null
  /** Drop the cached cookie (called after a proxied 401 → re-login once). */
  invalidate(origin: GatewaySessionOrigin): void
  /** Drop every direct/tunnel origin owned by one exact connection target scope,
   *  across historical local ports. */
  invalidateScope(scope: string): void
  /** Clear every cached session (main-process shutdown). */
  dispose(): void
}

/** Dependency seams (tests inject a fake request factory / a clock). */
export interface GatewaySessionDeps {
  /** Injectable outbound request factory (defaults to the node request per scheme). */
  request?: GatewayHttpRequest
  /** Injectable epoch-ms clock (defaults to `Date.now`); tests advance it to
   *  force cookie expiry. */
  now?: () => number
}

/** Server-side session TTL (12 hours) from the shared wire-protocol source
 *  (seconds there, milliseconds here for Date.now arithmetic). */
export const GATEWAY_SESSION_TTL_MS = PROTO_SESSION_TTL_SECONDS * 1000
/** Client-side expiry skew: re-login before the server rejects the cookie, so a
 *  proxied request never races the 401 → re-login window. */
export const GATEWAY_SESSION_EXPIRY_SKEW_MS = 5 * 60 * 1000
/** Login request timeout — a blackholed gateway must not hang the desktop. */
export const GATEWAY_LOGIN_TIMEOUT_MS = 10_000
/** Client-side backoff after a 429: ensureSession returns the cached
 *  rate_limited failure WITHOUT another request, so a reconnect loop never
 *  hammers /auth/login. The server limiter remains the real authority — this is
 *  a bounded courtesy, not a bypass. */
export const GATEWAY_LOGIN_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000
/** The session cookie name — shared wire-protocol single source with the gateway
 *  server and the proxy injection gate. */
export const GATEWAY_SESSION_COOKIE_NAME = PROTO_SESSION_COOKIE_NAME
/** Defensive bound on the cookie VALUE (name + 4096) — same shared source as the
 *  instance-proxy injection gate and the gateway token cap. */
export const GATEWAY_SESSION_MAX_COOKIE_CHARS = PROTO_SESSION_COOKIE_VALUE_MAX_CHARS

interface CachedSession {
  cookie: string
  expiresAt: number
}

/** Create the per-manager session cache (pure main-process memory). */
export function createGatewaySessionManager(deps: GatewaySessionDeps = {}): GatewaySessionManager {
  const now = deps.now ?? (() => Date.now())
  const cache = new Map<string, CachedSession>()
  /** Per-origin 429 backoff deadline (epoch ms); expired entries clear lazily. */
  const throttledUntil = new Map<string, number>()
  /** Per-key invalidation epochs outlive the cookie/login entry itself: a
   *  deleted connection can never become current again when an old async
   *  verifier resumes after its cache entry was cleared. */
  const generations = new Map<string, number>()
  const registrationProofs = new Map<string, { generation: number; proof: GatewayRegistrationAuthProof }>()
  /** Login attempts whose late result could otherwise repopulate an invalidated
   *  generation: invalidation marks matching attempts stale, and they may still
   *  settle for their caller but cannot mutate shared cookie/backoff state. */
  interface LoginAttempt { invalidated: boolean; generation: number }
  const activeLogins = new Map<string, Set<LoginAttempt>>()
  let disposed = false

  const generationForKey = (key: string): number => generations.get(key) ?? 0

  const staleResult = (): Extract<GatewaySessionResult, { ok: false }> => ({
    ok: false,
    code: 'stale',
    error: 'the gateway session operation was superseded by connection invalidation',
  })

  const invalidateKey = (key: string): void => {
    generations.set(key, generationForKey(key) + 1)
    cache.delete(key)
    throttledUntil.delete(key)
    registrationProofs.delete(key)
    const attempts = activeLogins.get(key)
    if (attempts !== undefined) {
      for (const attempt of attempts) attempt.invalidated = true
    }
  }

  /** Validate the origin and derive the cache key + login URL. Mirrors
   *  instance-proxy's origin gate and the scheme = transport rule. */
  function resolveOrigin(origin: GatewaySessionOrigin): { key: string; url: URL } {
    let parsed: URL
    try {
      parsed = new URL(origin.baseUrl)
    } catch (error) {
      throw new TypeError(`invalid gateway baseUrl: ${(error as Error).message}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError('gateway baseUrl must be an http(s) origin')
    }
    if (parsed.username !== '' || parsed.password !== ''
      || (parsed.pathname !== '/' && parsed.pathname !== '')
      || parsed.search !== '' || parsed.hash !== '') {
      throw new TypeError('gateway baseUrl must be an origin (no credentials/path/query)')
    }
    const expected = origin.insecureHttp ? 'http:' : 'https:'
    if (parsed.protocol !== expected) {
      throw new TypeError(`gateway baseUrl scheme ${parsed.protocol} does not match insecureHttp=${origin.insecureHttp}`)
    }
    if (origin.authority !== undefined) {
      // Host override shape guard (mirrors instance-proxy's authority gate):
      // host[:port], bracketed IPv6 allowed, no path/query/userinfo/fragment.
      if (typeof origin.authority !== 'string' || origin.authority.length > 253
        || !/^(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?$/.test(origin.authority)
        || origin.authority.includes('://')) {
        throw new TypeError('gateway authority must be a host[:port] without path/query/credentials')
      }
    }
    if (typeof origin.scope !== 'string'
      || origin.scope.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(origin.scope)) {
      throw new TypeError('gateway session scope must be a bounded identifier')
    }
    // The key includes network origin/Host and the exact connection scope, so
    // direct same-origin sharing and tunnel local-port/authority reuse cannot
    // cross ids or SSH targets.
    const authorityPart = origin.authority === undefined ? '' : `|host:${origin.authority}`
    const scopePart = `|scope:${origin.scope}`
    return { key: `${parsed.origin}${authorityPart}${scopePart}`, url: new URL('/auth/login', parsed) }
  }

  /** Extract the header-ready `dsh_gateway_session=<value>` cookie from the
   *  response's set-cookie headers, stripping the `;` attributes; null when
   *  absent, empty, or oversized. */
  function parseSessionCookie(setCookie: string[] | undefined): string | null {
    if (setCookie === undefined) return null
    const prefix = `${GATEWAY_SESSION_COOKIE_NAME}=`
    for (const header of setCookie) {
      if (!header.startsWith(prefix)) continue
      const rest = header.slice(prefix.length)
      const end = rest.indexOf(';')
      const value = (end === -1 ? rest : rest.slice(0, end)).trim()
      if (value.length === 0 || value.length > GATEWAY_SESSION_MAX_COOKIE_CHARS) return null
      return `${prefix}${value}`
    }
    return null
  }

  /** Classify a non-success login status; no secret ever appears in these messages. */
  function loginFailure(statusCode: number): Extract<GatewaySessionResult, { ok: false }> {
    if (statusCode === 401 || statusCode === 400 || statusCode === 413) {
      return { ok: false, code: 'invalid_credentials', error: `the gateway rejected the password login (HTTP ${statusCode}) — re-enter the password` }
    }
    if (statusCode === 429) {
      return { ok: false, code: 'rate_limited', error: 'the gateway is rate-limiting login attempts (429) — back off before retrying' }
    }
    if (statusCode === 503) {
      return { ok: false, code: 'auth_busy', error: 'the gateway login service is overloaded (503) — retry shortly' }
    }
    return { ok: false, code: 'other', error: `the gateway answered an unexpected login status (HTTP ${statusCode})` }
  }

  function ensureSession(origin: GatewaySessionOrigin, password: string): Promise<GatewaySessionResult> {
    const { key, url } = resolveOrigin(origin)
    if (disposed) return Promise.resolve(staleResult())
    // 429 courtesy backoff: while throttled the manager answers the cached
    // rate_limited failure WITHOUT touching the network (a loop must not hammer).
    const until = throttledUntil.get(key)
    if (until !== undefined && now() < until) {
      return Promise.resolve({ ok: false, code: 'rate_limited', error: 'the gateway is rate-limiting login attempts (429) — backing off before retrying' })
    }
    if (until !== undefined) throttledUntil.delete(key)
    const request = deps.request ?? (origin.insecureHttp ? nodeHttpRequest : nodeHttpsRequest)
    const body = JSON.stringify({ password })
    const attempt: LoginAttempt = { invalidated: false, generation: generationForKey(key) }
    const attempts = activeLogins.get(key) ?? new Set<LoginAttempt>()
    attempts.add(attempt)
    activeLogins.set(key, attempts)
    const result = new Promise<GatewaySessionResult>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let req: ClientRequest | null = null
      const done = (result: GatewaySessionResult): void => {
        if (settled) return
        settled = true
        if (timer !== null) { clearTimeout(timer); timer = null }
        const mayMutateSharedState = !disposed && !attempt.invalidated
          && generationForKey(key) === attempt.generation
        if (result.ok && mayMutateSharedState) {
          // Cache with the 12h TTL minus a 5-minute skew.
          cache.set(key, { cookie: result.cookie, expiresAt: now() + GATEWAY_SESSION_TTL_MS - GATEWAY_SESSION_EXPIRY_SKEW_MS })
          throttledUntil.delete(key)
        } else if (!result.ok && mayMutateSharedState && result.code === 'rate_limited') {
          throttledUntil.set(key, now() + GATEWAY_LOGIN_RATE_LIMIT_BACKOFF_MS)
        } else if (!result.ok && mayMutateSharedState && result.code === 'invalid_credentials') {
          // A rejected password is deterministic — no backoff, no retry.
          throttledUntil.delete(key)
        }
        req?.destroy()
        // Invalidation is not merely a cache-write fence: the old caller must
        // learn its whole generation is dead, or it would probe, fall back to a
        // captured bearer, or start a fresh login after the clear/delete.
        resolve(mayMutateSharedState ? result : staleResult())
      }
      const onResponse = (res: IncomingMessage): void => {
        // Always drain the body so the socket is released.
        res.resume()
        res.on('error', () => done({ ok: false, code: 'network', error: 'the gateway login response was interrupted (network error)' }))
        const status = res.statusCode ?? 0
        if (status === 0) {
          done({ ok: false, code: 'network', error: 'the gateway login response was interrupted (network error)' })
          return
        }
        if (status >= 300 && status < 400) {
          // Manual redirect handling: the 3xx carries the session cookie — never followed.
          const cookie = parseSessionCookie(res.headers['set-cookie'])
          if (cookie === null) {
            done({ ok: false, code: 'other', error: 'the gateway answered a login redirect without a dsh_gateway_session cookie' })
            return
          }
          done({ ok: true, cookie })
          return
        }
        done(loginFailure(status))
      }
      req = request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          accept: 'application/json',
          // Tunnel Host override: present the REMOTE listener authority so the
          // gateway's request policy (authority port == listen port) accepts it.
          ...(origin.authority === undefined ? {} : { host: origin.authority }),
        },
        // A configured pin turns the login into a PINNED connection exactly like
        // the identity probe: rejectUnauthorized:false (pin replaces CA trust) +
        // agent:false (a fresh socket, so secureConnect always fires); inert for
        // http and pin-less https origins, exactly the probe's guard.
        ...(origin.insecureHttp || origin.spkiPin === undefined ? {} : { rejectUnauthorized: false, agent: false }),
      }, onResponse)
      const dispatch = (): void => { req!.end(body) }
      // The body and its password are not written until the fresh TLS peer key
      // matches the pin; a mismatch destroys the undispatched request ('other').
      if (!origin.insecureHttp && origin.spkiPin !== undefined) {
        attachSpkiPinVerifier(req, origin.spkiPin, dispatch)
      }
      timer = setTimeout(() => done({ ok: false, code: 'network', error: `the gateway did not answer the login request within ${GATEWAY_LOGIN_TIMEOUT_MS}ms` }), GATEWAY_LOGIN_TIMEOUT_MS)
      timer.unref()
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === SPKI_PIN_MISMATCH_CODE) {
          // A mismatched pin is DETERMINISTIC: classified 'other', which the
          // verifyUp flow maps terminal — never transient 'network' (永不 ready).
          done({ ok: false, code: 'other', error: '证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误' })
          return
        }
        done({ ok: false, code: 'network', error: 'the gateway login request failed (network error)' })
      })
      if (origin.insecureHttp || origin.spkiPin === undefined) dispatch()
    })
    return result.finally(() => {
      attempts.delete(attempt)
      if (attempts.size === 0) activeLogins.delete(key)
    })
  }

  return {
    ensureSession,
    generation(origin: GatewaySessionOrigin): number {
      const { key } = resolveOrigin(origin)
      // Materialize the observed key even at generation zero: a verifier may
      // finish a failed login (no cache/throttle/active entry), then await a
      // bearer fallback that invalidateScope must still be able to bump.
      if (!generations.has(key)) generations.set(key, 0)
      return generationForKey(key)
    },
    registrationAuthProof(origin: GatewaySessionOrigin): GatewayRegistrationAuthProof | null {
      const { key } = resolveOrigin(origin)
      const entry = registrationProofs.get(key)
      return entry !== undefined && entry.generation === generationForKey(key) ? entry.proof : null
    },
    setRegistrationAuthProof(origin: GatewaySessionOrigin, proof: GatewayRegistrationAuthProof | null): void {
      const { key } = resolveOrigin(origin)
      if (proof === null) {
        registrationProofs.delete(key)
        return
      }
      registrationProofs.set(key, { generation: generationForKey(key), proof })
    },
    cachedCookie(origin: GatewaySessionOrigin): string | null {
      const { key } = resolveOrigin(origin)
      const entry = cache.get(key)
      if (entry === undefined) return null
      if (now() >= entry.expiresAt) {
        cache.delete(key)
        if (registrationProofs.get(key)?.proof === 'cookie') registrationProofs.delete(key)
        return null
      }
      return entry.cookie
    },
    expiresAt(origin: GatewaySessionOrigin): number | null {
      const { key } = resolveOrigin(origin)
      const entry = cache.get(key)
      if (entry === undefined) return null
      if (now() >= entry.expiresAt) {
        cache.delete(key)
        if (registrationProofs.get(key)?.proof === 'cookie') registrationProofs.delete(key)
        return null
      }
      return entry.expiresAt
    },
    invalidate(origin: GatewaySessionOrigin): void {
      const { key } = resolveOrigin(origin)
      invalidateKey(key)
    },
    invalidateScope(scope: string): void {
      if (typeof scope !== 'string' || scope.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(scope)) {
        throw new TypeError('gateway session scope must be a bounded identifier')
      }
      const suffix = `|scope:${scope}`
      const keys = new Set([...cache.keys(), ...throttledUntil.keys(), ...activeLogins.keys(), ...generations.keys(), ...registrationProofs.keys()])
      for (const key of keys) if (key.endsWith(suffix)) invalidateKey(key)
    },
    dispose(): void {
      disposed = true
      const keys = new Set([...cache.keys(), ...throttledUntil.keys(), ...activeLogins.keys(), ...generations.keys(), ...registrationProofs.keys()])
      for (const key of keys) generations.set(key, generationForKey(key) + 1)
      for (const attempts of activeLogins.values()) {
        for (const attempt of attempts) attempt.invalidated = true
      }
      activeLogins.clear()
      cache.clear()
      throttledUntil.clear()
      registrationProofs.clear()
    },
  }
}
