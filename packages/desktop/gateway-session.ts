/**
 * Gateway password-session manager (design 17 §7.3 / §9.3 / §13.5).
 *
 * A gateway deployment (`packages/gateway`) may require a UI password
 * (design 17 §5.1/§7.1). The desktop main process holds that password in the
 * gateway-secrets store (design 17 §12, bound schema v3) and trades it for the
 * gateway's 12-hour HS256 JWT cookie (`dsh_gateway_session`, HttpOnly;
 * `SameSite=Strict; Path=/`, `Secure` added only once an HTTPS boundary is
 * confirmed — design 17 §7.1) via `POST /auth/login`. This module owns that
 * exchange and the resulting session cookie, which the caller then injects
 * as the bounded `Cookie` header of a gateway-kind transport (design 17
 * §9.3: a gateway target may inject 0..2 headers — `Authorization` Bearer /
 * `Cookie` `dsh_gateway_session`; the cookie only ever reaches its own
 * origin).
 *
 * Login contract (design 17 §7.3): success is a 3xx redirect carrying
 * `set-cookie: dsh_gateway_session=<jwt>`. The redirect is handled MANUALLY
 * — the request factory never follows it; this manager inspects the answer
 * itself and parses the cookie (attributes stripped). Failure statuses
 * classify as: 400/413/401 → invalid_credentials (the password was refused;
 * 400/413 are protocol-evidence variants the client's mirrored password
 * gate cannot produce), 429 → rate_limited, 503 → auth_busy (login
 * overload), any other real status → other; an unreachable/timed-out/
 * interrupted exchange is network.
 *
 * Security discipline (design 17 §7.3/§9.3/§13.5, invariants S5/S24): the
 * password and the session cookie NEVER enter logs and are NEVER written to
 * any file — they live only in this manager's main-process memory, keyed by
 * gateway origin/Host plus a stable connection-and-target scope. The cookie is
 * injected only into that scoped transport and is never visible to the
 * renderer. A 401 (12h expiry / revoked cookie)
 * is reported as invalid_credentials so the caller can retry ONCE with the
 * stored password (respecting 429 backoff); a second failure is terminal
 * (design 17 §7.3 three-state). Audit (S24) records only non-secret events
 * (time/source/auth result) — never credentials or the cookie itself.
 *
 * SPKI pinning (S23, design 17 §13.4.2, P1-2): an https origin may carry an
 * optional `spkiPin`; the login request is then pinned EXACTLY like the
 * identity probe (rejectUnauthorized:false — the pin replaces CA trust for
 * the internal-CA case — + agent:false so the socket verifier always fires),
 * and a peer whose SPKI does not match is classified `other` (deterministic,
 * terminal in the verifyUp three-state), never the transient `network` that
 * would keep the password flow retrying forever against an internal-CA
 * gateway. The shared gateway-provider pre-write gate verifies the peer
 * before the request body (and therefore the password) is dispatched.
 */

import { request as nodeHttpRequest } from 'node:http'
import { request as nodeHttpsRequest } from 'node:https'
import { createHash } from 'node:crypto'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { attachSpkiPinVerifier, SPKI_PIN_MISMATCH_CODE } from './gateway-provider.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'
import {
  GATEWAY_SESSION_COOKIE_NAME as PROTO_SESSION_COOKIE_NAME,
  GATEWAY_SESSION_COOKIE_VALUE_MAX_CHARS as PROTO_SESSION_COOKIE_VALUE_MAX_CHARS,
  GATEWAY_SESSION_TTL_SECONDS as PROTO_SESSION_TTL_SECONDS,
} from './control-plane-module.ts'

/** The injectable outbound request factory — the same shape as
 * proxy-forward's `HttpRequestFactory` (`typeof node:http request`, design
 * 17 §8). Defaults to the node:http/https request chosen by the origin
 * scheme. Tests inject a fake/spy. */
export type GatewayHttpRequest = typeof nodeHttpRequest

/** One gateway login target: the http(s) origin the transport proxies to. */
export interface GatewaySessionOrigin {
  /** The gateway origin, e.g. `https://gw.example.com` or
   * `http://gw.example.com:8080` — origin form, no credentials/path/query
   * (mirrors instance-proxy's baseUrl gate, design 17 §9.3). */
  baseUrl: string
  /** true = plaintext http (the user's explicit `insecureHttp` choice,
   * design 17 §9.1/§13.1); false = https (the default). */
  insecureHttp: boolean
  /** Optional SPKI certificate pin (S23, design 17 §13.4.2; P1-2): an https
   * login is pinned like the identity probe (rejectUnauthorized:false +
   * agent:false + the secureConnect pre-write verifier), so an
   * internal-CA gateway login can succeed and a mismatched peer is a
   * deterministic `other` failure (terminal in the verifyUp three-state),
   * never a forever-transient `network`. http origins never carry a pin (no
   * TLS layer — the pin is inert there, exactly like the probe guard). */
  spkiPin?: string
  /** Optional upstream Host override (design 17 §9.3 隧道 Host 覆盖): an
   * ssh-tunneled gateway target connects to the LOOPBACK tunnel endpoint
   * (`baseUrl` = `http://127.0.0.1:<localPort>`) but must present the REMOTE
   * gateway authority in the Host header — the gateway's request policy
   * requires the authority port to equal its listen port, which the tunnel's
   * local port can never satisfy. The login POST and the session cache key
   * both carry this authority, so the minted cookie is exactly the one the
   * verifyUp probe and the proxy registration reuse. Absent = the URL's own
   * authority (direct http(s) endpoints). */
  authority?: string
  /** Stable connection/target generation scope used ONLY in the in-memory
   * cache key. It is never sent as an HTTP header. Tunnel origins require it:
   * local-port reuse and the shared remote loopback authority must not let a
   * cookie cross SSH hosts or connection ids. */
  scope: string
}

/** Stable, non-secret session ownership scope. The id distinguishes parallel
 * connections; the digest binds the scope to the actual direct/SSH target so
 * a same-id retarget cannot inherit a prior generation's session. Local
 * tunnel ports are deliberately excluded, allowing refresh/registration to
 * find the verifyUp cookie for that one target generation. */
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
 * register only with the exact scoped cookie proven by verifyUp. A configured
 * bearer is an independent OR-principal, so token+password may intentionally
 * register bearer-only when password login fell back to the valid token. */
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

/** Outcome of one login attempt. On success `cookie` is the header-ready
 * `dsh_gateway_session=<value>` string (attributes stripped) — main-process
 * memory only, never logged or persisted. */
export type GatewaySessionResult =
  | { ok: true; cookie: string }
  | { ok: false; error: string; code: 'invalid_credentials' | 'rate_limited' | 'auth_busy' | 'network' | 'other' | 'stale' }

/** The session manager surface (design 17 §2.3 auth slot). */
export interface GatewaySessionManager {
  /** Perform `POST /auth/login` with a JSON `{password}` body. Resolves
   * with the session cookie on a 3xx + `dsh_gateway_session` set-cookie
   * (cached for 12h − 5min), or a classified failure. Throws TypeError for
   * a structurally invalid origin (programmer error, mirroring
   * instance-proxy's baseUrl gate). */
  ensureSession(origin: GatewaySessionOrigin, password: string): Promise<GatewaySessionResult>
  /** Monotonic invalidation generation for the exact session key. Callers
   * that span multiple awaits use it to stop an old credential flow before
   * any probe, bearer fallback, or re-login after delete/retarget/clear. */
  generation(origin: GatewaySessionOrigin): number
  /** Exact-key, current-generation non-secret authentication proof produced
   * by verifyUp. Main consumes it to distinguish a proven bearer fallback
   * from a cookie proof whose cache entry vanished before registration. */
  registrationAuthProof(origin: GatewaySessionOrigin): GatewayRegistrationAuthProof | null
  setRegistrationAuthProof(origin: GatewaySessionOrigin, proof: GatewayRegistrationAuthProof | null): void
  /** The cached header-ready cookie for the origin, or null when absent or
   * past its 12h − 5min expiry. Synchronous — the proxy's fast path. */
  cachedCookie(origin: GatewaySessionOrigin): string | null
  /** The epoch-ms instant the cached session for the origin expires (12h TTL
   * − 5min skew), or null when nothing is cached (absent, expired, invalidated
   * or disposed). The live-proxy self-healing scheduler (main.ts /
   * gateway-session-refresh.ts) uses it to fire a pre-expiry re-login ~60s
   * before the cached cookie dies, so a REGISTERED transport never rides an
   * expired cookie (design 17 §9.3 已注册会话过期后代理持续 401). */
  expiresAt(origin: GatewaySessionOrigin): number | null
  /** Drop the cached cookie (called after a proxied 401, design 17 §9.3:
   * re-login once with the stored password). */
  invalidate(origin: GatewaySessionOrigin): void
  /** Drop every direct/tunnel origin owned by one exact connection target
   * scope, across historical local ports. */
  invalidateScope(scope: string): void
  /** Clear every cached session (main-process shutdown). */
  dispose(): void
}

/** Dependency seams (tests inject a fake request factory / a clock). */
export interface GatewaySessionDeps {
  /** Injectable outbound request factory (defaults to the node:http/https
   * request chosen by the origin scheme). */
  request?: GatewayHttpRequest
  /** Injectable epoch-ms clock (defaults to `Date.now`); tests advance it
   * to force cookie expiry. */
  now?: () => number
}

/** Server-side session TTL (design 17 §7.1: 12 hours) — derived from the
 * shared wire-protocol source (control-plane gateway-session-protocol.ts;
 * seconds there, milliseconds here for Date.now arithmetic). */
export const GATEWAY_SESSION_TTL_MS = PROTO_SESSION_TTL_SECONDS * 1000
/** Client-side expiry skew: re-login before the server actually rejects the
 * cookie, so a proxied request never races the 401 → re-login window. */
export const GATEWAY_SESSION_EXPIRY_SKEW_MS = 5 * 60 * 1000
/** Login request timeout — a blackholed gateway must not hang the desktop. */
export const GATEWAY_LOGIN_TIMEOUT_MS = 10_000
/** Client-side backoff after a 429 rate_limited login failure (design 17
 * §13.5 尊重 429 退避): the server enforces a 10-attempts/5-min sliding
 * window plus a lockout; during the client backoff window ensureSession
 * returns the cached rate_limited failure WITHOUT issuing another request,
 * so a reconnect loop (slow 60s probes) never hammers /auth/login with
 * cheap 429s. The server rate limiter remains the real authority — this is
 * a bounded courtesy, not a bypass. */
export const GATEWAY_LOGIN_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000
/** The session cookie name (design 17 §7.1) — shared wire-protocol single
 * source with the gateway server (auth.ts) and the proxy injection gate. */
export const GATEWAY_SESSION_COOKIE_NAME = PROTO_SESSION_COOKIE_NAME
/** Defensive bound on the cookie VALUE (design 17 §9.3: `Cookie` bounded to
 * the name + 4096) — same shared source as the instance-proxy injection
 * gate and the gateway token cap. */
export const GATEWAY_SESSION_MAX_COOKIE_CHARS = PROTO_SESSION_COOKIE_VALUE_MAX_CHARS

interface CachedSession {
  cookie: string
  expiresAt: number
}

/** Create the per-manager session cache (pure main-process memory). */
export function createGatewaySessionManager(deps: GatewaySessionDeps = {}): GatewaySessionManager {
  const now = deps.now ?? (() => Date.now())
  const cache = new Map<string, CachedSession>()
  /** Per-origin 429 backoff deadline (epoch ms); entries past the deadline
   * are treated as expired and cleared lazily. */
  const throttledUntil = new Map<string, number>()
  /** Per-key invalidation epochs outlive the cookie/login entry itself. A
   * deleted connection can therefore never become current again merely
   * because an old async verifier resumes after its cache entry was cleared. */
  const generations = new Map<string, number>()
  const registrationProofs = new Map<string, { generation: number; proof: GatewayRegistrationAuthProof }>()
  /** Login attempts whose late result could otherwise repopulate an
   * invalidated connection generation. Invalidating an origin/scope marks
   * every matching attempt stale; the request may still settle for its caller,
   * but can no longer mutate the shared cookie/backoff state. */
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
   * instance-proxy's origin gate (design 17 §9.3) and the scheme = transport
   * rule (design 17 §13.1: `insecureHttp` normalized). */
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
      // Host override shape guard (mirrors instance-proxy's authority gate,
      // design 17 §9.3): a host[:port] authority, bracketed IPv6 allowed, no
      // path/query/userinfo/fragment.
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
    // The key includes both network origin/Host and the exact connection
    // scope. The scope prevents direct same-origin sharing and tunnel
    // local-port/authority reuse from crossing ids or SSH targets.
    const authorityPart = origin.authority === undefined ? '' : `|host:${origin.authority}`
    const scopePart = `|scope:${origin.scope}`
    return { key: `${parsed.origin}${authorityPart}${scopePart}`, url: new URL('/auth/login', parsed) }
  }

  /** Extract the header-ready `dsh_gateway_session=<value>` cookie from the
   * response's set-cookie headers, stripping the `;` attributes (design 17
   * §7.1: HttpOnly / SameSite=Strict / Path=/ / optional Secure). Returns
   * null when absent, empty, or oversized. */
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

  /** Classify a non-success login status (design 17 §7.3). No secret ever
   * appears in these messages. */
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
    // 429 courtesy backoff (design 17 §13.5): while the origin is throttled
    // the manager answers the cached rate_limited failure WITHOUT touching
    // the network — a reconnect loop must not hammer /auth/login.
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
          // Cache with the 12h TTL minus a 5-minute skew (design 17 §7.1).
          cache.set(key, { cookie: result.cookie, expiresAt: now() + GATEWAY_SESSION_TTL_MS - GATEWAY_SESSION_EXPIRY_SKEW_MS })
          throttledUntil.delete(key)
        } else if (!result.ok && mayMutateSharedState && result.code === 'rate_limited') {
          throttledUntil.set(key, now() + GATEWAY_LOGIN_RATE_LIMIT_BACKOFF_MS)
        } else if (!result.ok && mayMutateSharedState && result.code === 'invalid_credentials') {
          // A rejected password is deterministic — no backoff, no retry.
          throttledUntil.delete(key)
        }
        req?.destroy()
        // Invalidation is not merely a cache-write fence. The old caller must
        // learn that its whole verification generation is dead; returning a
        // late cookie/failure would let it probe, fall back to a captured
        // bearer, or initiate a fresh password login after the clear/delete.
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
          // Manual redirect handling: the login answer is a 3xx that carries
          // the session cookie (design 17 §7.3) — it is never followed.
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
          // Tunnel Host override (design 17 §9.3): an ssh-tunneled target
          // presents the REMOTE loopback-listener authority so the gateway's request
          // policy (authority port == listen port) accepts the login.
          ...(origin.authority === undefined ? {} : { host: origin.authority }),
        },
        // S23 (P1-2): a configured SPKI pin on an https origin turns the
        // login into a PINNED connection exactly like the identity probe —
        // rejectUnauthorized:false (the pin replaces CA trust for the
        // internal-CA case) + agent:false (a fresh connection, so the
        // secureConnect pre-write verifier always fires). The pin is
        // inert for http origins and pin-less https origins (no options
        // added, exactly the probe's `insecure || spkiPin === null` guard).
        ...(origin.insecureHttp || origin.spkiPin === undefined ? {} : { rejectUnauthorized: false, agent: false }),
      }, onResponse)
      const dispatch = (): void => { req!.end(body) }
      // S23: the request body and its password are not written until the
      // fresh TLS connection's peer key matches the pin. A mismatch destroys
      // the still-undispatched request and is classified below as `other`.
      if (!origin.insecureHttp && origin.spkiPin !== undefined) {
        attachSpkiPinVerifier(req, origin.spkiPin, dispatch)
      }
      timer = setTimeout(() => done({ ok: false, code: 'network', error: `the gateway did not answer the login request within ${GATEWAY_LOGIN_TIMEOUT_MS}ms` }), GATEWAY_LOGIN_TIMEOUT_MS)
      timer.unref()
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === SPKI_PIN_MISMATCH_CODE) {
          // A peer whose SPKI does not match the pin is DETERMINISTIC
          // evidence (S23): classified 'other', which the verifyUp flow maps
          // terminal — never the transient 'network' that would keep the
          // password flow retrying forever (P1-2 永不 ready).
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
      // Materialize the observed key even at generation zero. A verifier may
      // finish a failed password login (leaving no cache/throttle/active
      // entry) and then await a bearer fallback; invalidateScope must still
      // find and bump that observed generation before the fallback returns.
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
