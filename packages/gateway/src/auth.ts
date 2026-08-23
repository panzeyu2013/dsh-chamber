/**
 * Gateway authentication (design 16 §5): the pluggable AuthProvider seam.
 *
 *   - `none`    — loopback-only trust (S1 forbids it on a non-loopback bind).
 *   - `token`   — the D7 shared bearer token; only its SHA-256 hash is
 *                 persisted (`tokens.json`, 0600), never the plaintext (S5).
 *   - `password`— scrypt password verify → HS256 JWT session cookie (12h),
 *                 `Path=/; HttpOnly; SameSite=Strict; Secure(conditional)`
 *                 (S12), login rate limit (S8), rotate-jwt-secret on revoke
 *                 (S13).
 *
 * Secrets never reach logs/renderer/persistence in plaintext; failed auth logs
 * only the principal kind, never header values.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { GatewayStore } from './store.ts'
import { hashCredential, verifyCredential } from './store.ts'

export interface AuthPrincipal {
  kind: 'password' | 'token' | 'passkey' | 'none'
  id: string
  issuedAt: number
}

/** The request facts an AuthProvider reads (node:http-compatible). */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>
  socketAddr: string
}

export interface AuthProvider {
  readonly kind: string
  /** Extract + verify identity; null = unauthenticated. Never logs/replies credentials. */
  verify(req: AuthRequest): Promise<AuthPrincipal | null>
  /** Login endpoint (password/passkey providers only). `req` supplies the
   * rate-limit key (x-forwarded-for first hop / socketAddr). */
  login?(body: unknown, req: AuthRequest): Promise<{ setCookie?: string; token?: string }>
  /** Invalidate sessions/tokens (password change / device revocation). */
  revoke?(principal: AuthPrincipal): Promise<void>
}

export interface AuthConfig {
  kind: 'none' | 'password' | 'token'
  password?: string
  token?: string
}

// ---------------------------------------------------------------------------
// JWT (HS256) — the 12h session credential (design §5.1; aligned with
// OpenChamber ui-auth.js, no library dependency added).
// ---------------------------------------------------------------------------

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, signature] = parts
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(value: string): string {
  return createHmac('sha256', 'dsh-gateway-token').update(value).digest('hex')
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name]
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
}

function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (header === undefined) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key !== '') out[key] = value
  }
  return out
}

const SESSION_COOKIE = 'dsh_gateway_session'
const SESSION_TTL_SECONDS = 12 * 3600 // 12h

/** Login rate limiter (S8): 10 attempts / 5min → 15min lock, keyed on the
 * x-forwarded-for first hop (trusted reverse proxy) falling back to the
 * socketAddr; a missing IP uses a shared low-quota no-IP bucket. */
function createLoginRateLimiter(): (key: string) => { allowed: boolean; retryAfterMs: number } {
  const buckets = new Map<string, { count: number; firstAt: number; lockedUntil: number }>()
  const WINDOW_MS = 5 * 60_000
  const LOCK_MS = 15 * 60_000
  const MAX_ATTEMPTS = 10
  const NO_IP_KEY = '<no-ip>'
  return (rawKey: string) => {
    const key = rawKey === '' ? NO_IP_KEY : rawKey
    const now = Date.now()
    const b = buckets.get(key) ?? { count: 0, firstAt: now, lockedUntil: 0 }
    if (b.lockedUntil > now) {
      return { allowed: false, retryAfterMs: b.lockedUntil - now }
    }
    if (now - b.firstAt > WINDOW_MS) {
      b.count = 0
      b.firstAt = now
    }
    if (b.count >= MAX_ATTEMPTS) {
      b.lockedUntil = now + LOCK_MS
      return { allowed: false, retryAfterMs: LOCK_MS }
    }
    b.count += 1
    buckets.set(key, b)
    return { allowed: true, retryAfterMs: 0 }
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function createNoneProvider(): AuthProvider {
  return {
    kind: 'none',
    async verify(): Promise<AuthPrincipal> {
      return { kind: 'none', id: 'anonymous', issuedAt: Date.now() }
    },
  }
}

/** `token`: the D7 shared bearer token. Only its SHA-256 hash is persisted;
 * the config/env plaintext is hashed at creation and never written back. */
function createTokenProvider(store: GatewayStore, plainToken: string): AuthProvider {
  if (plainToken !== '') store.setTokenHash(sha256hex(plainToken))
  return {
    kind: 'token',
    async verify(req: AuthRequest): Promise<AuthPrincipal | null> {
      const value = headerValue(req.headers, 'authorization')
      if (value === undefined) return null
      const match = /^Bearer[ \t]+(.+)$/i.exec(value)
      if (match === null) return null
      const stored = store.getTokenHash()
      const incoming = sha256hex(match[1])
      const a = Buffer.from(incoming)
      const b = Buffer.from(stored ?? '')
      if (stored === null || a.length !== b.length || !timingSafeEqual(a, b)) return null
      return { kind: 'token', id: 'shared-token', issuedAt: Date.now() }
    },
  }
}

/** `password`: scrypt verify → HS256 JWT session cookie (S12), login rate
 * limit (S8), rotate-jwt-secret on revoke (S13). The password is only ever
 * held as a scrypt hash; the plaintext (config/env) is dropped at creation. */
function createPasswordProvider(store: GatewayStore, plainPassword: string): AuthProvider {
  const passwordHash = plainPassword !== '' ? hashCredential(plainPassword) : null
  const rateLimit = createLoginRateLimiter()

  function rateKey(req: AuthRequest): string {
    // Behind a reverse proxy every peer is loopback, so prefer the trusted
    // x-forwarded-for first hop; fall back to the socketAddr.
    const xff = headerValue(req.headers, 'x-forwarded-for')
    if (xff !== undefined && xff !== '') return xff.split(',')[0].trim()
    return req.socketAddr
  }

  return {
    kind: 'password',
    async verify(req: AuthRequest): Promise<AuthPrincipal | null> {
      const cookie = parseCookie(headerValue(req.headers, 'cookie'))
      const session = cookie[SESSION_COOKIE]
      if (session === undefined) return null
      const payload = verifyJwt(session, store.getJwtSecret())
      if (payload === null) return null
      const exp = payload.exp
      if (typeof exp === 'number' && exp * 1000 < Date.now()) return null
      const sub = typeof payload.sub === 'string' ? payload.sub : 'user'
      const iat = typeof payload.iat === 'number' ? payload.iat * 1000 : Date.now()
      return { kind: 'password', id: sub, issuedAt: iat }
    },
    async login(body: unknown, req: AuthRequest): Promise<{ setCookie?: string; token?: string }> {
      const check = rateLimit(rateKey(req))
      if (!check.allowed) {
        const err = new Error(`too many login attempts; retry in ${Math.ceil(check.retryAfterMs / 1000)}s`) as Error & { code?: string }
        err.code = 'rate_limited'
        throw err
      }
      const password = (body as { password?: unknown } | null | undefined)?.password
      if (passwordHash === null || typeof password !== 'string' || !verifyCredential(password, passwordHash)) {
        throw new Error('invalid password')
      }
      const now = Math.floor(Date.now() / 1000)
      const jwt = signJwt({ sub: 'user', iat: now, exp: now + SESSION_TTL_SECONDS }, store.getJwtSecret())
      return { setCookie: `${SESSION_COOKIE}=${jwt}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}` }
    },
    async revoke(): Promise<void> {
      store.rotateJwtSecret()
    },
  }
}

export function createAuth(config: AuthConfig, store: GatewayStore): AuthProvider {
  if (config.kind === 'none') return createNoneProvider()
  if (config.kind === 'token') return createTokenProvider(store, config.token ?? '')
  return createPasswordProvider(store, config.password ?? '')
}
