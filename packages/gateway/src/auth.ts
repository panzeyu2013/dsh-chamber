/**
 * Gateway authentication (design 17 §5): the pluggable AuthProvider seam.
 *
 *   - `none`    — loopback-only trust (S1 forbids it on a non-loopback bind).
 *   - `token`   — the shared bearer token (design 17 §5.2); only its salted
 *                 scrypt hash is persisted (`tokens.json`, 0600), never the
 *                 plaintext (S5).
 *   - `password`— scrypt password verify → HS256 JWT session cookie (12h),
 *                 `Path=/; HttpOnly; SameSite=Strict; Secure(conditional)`
 *                 (S12), login rate limit (S8), rotate-jwt-secret on revoke
 *                 (S13).
 *
 * Secrets never reach logs/renderer/persistence in plaintext; failed auth logs
 * only the principal kind, never header values.
 */

import { createHmac, scrypt, timingSafeEqual } from 'node:crypto'
import type { GatewayStore } from './store.ts'
import { hashCredential } from './store.ts'
import {
  MAX_GATEWAY_PASSWORD_CHARS,
  MAX_GATEWAY_TOKEN_CHARS,
  MIN_GATEWAY_PASSWORD_CHARS,
  MIN_GATEWAY_TOKEN_CHARS,
} from './config.ts'

export interface AuthPrincipal {
  kind: 'password' | 'token' | 'passkey' | 'none'
  id: string
  issuedAt: number
}

/** The request facts an AuthProvider reads (node:http-compatible). */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>
  socketAddr: string
  /** Boundary-evaluated client IP. Forwarded headers are interpreted only by
   * the gateway request policy, never by the auth provider itself. */
  clientAddress?: string
  /** True only for a TLS socket or a trusted proxy's validated https hop. */
  secure?: boolean
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
  kind: 'none' | 'password' | 'token' | 'password+token'
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

interface LoginRateLimiter {
  consume(key: string): { allowed: boolean; retryAfterMs: number }
  reset(key: string): void
}

/** Login rate limiter (S8): bounded cardinality as well as per-client quota.
 * Once the table is full, new addresses share a low-quota overflow bucket
 * instead of allocating attacker-controlled keys forever. */
function createLoginRateLimiter(): LoginRateLimiter {
  const buckets = new Map<string, { count: number; firstAt: number; lockedUntil: number }>()
  const WINDOW_MS = 5 * 60_000
  const LOCK_MS = 15 * 60_000
  const MAX_ATTEMPTS = 10
  const MAX_BUCKETS = 4096
  const NO_IP_KEY = '<no-ip>'
  const OVERFLOW_KEY = '<overflow>'
  let calls = 0
  function normalizeKey(rawKey: string): string {
    const candidate = rawKey === '' ? NO_IP_KEY : rawKey.slice(0, 128)
    return buckets.has(candidate) || buckets.size < MAX_BUCKETS ? candidate : OVERFLOW_KEY
  }
  function prune(now: number): void {
    for (const [key, bucket] of buckets) {
      if (key === OVERFLOW_KEY) continue
      if (bucket.lockedUntil <= now && now - bucket.firstAt > WINDOW_MS) buckets.delete(key)
    }
  }
  return {
    consume(rawKey: string) {
      const now = Date.now()
      calls += 1
      if (calls % 64 === 0) prune(now)
      const key = normalizeKey(rawKey)
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
    },
    reset(rawKey: string) {
      buckets.delete(normalizeKey(rawKey))
    },
  }
}

/** Small process-local semaphore around asynchronous scrypt. It keeps the
 * event loop responsive and bounds queued memory under distributed guessing. */
function createPasswordWorkGate(maxActive = 2, maxQueued = 32) {
  let active = 0
  const waiters: Array<() => void> = []
  async function acquire(): Promise<void> {
    if (active < maxActive) {
      active += 1
      return
    }
    if (waiters.length >= maxQueued) {
      const error = new Error('password verifier is busy') as Error & { code?: string }
      error.code = 'auth_busy'
      throw error
    }
    await new Promise<void>(resolve => waiters.push(resolve))
  }
  function release(): void {
    const next = waiters.shift()
    if (next !== undefined) next()
    else active = Math.max(0, active - 1)
  }
  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire()
    try { return await task() } finally { release() }
  }
}

function verifyCredentialAsync(plain: string, stored: string | null): Promise<boolean> {
  if (stored === null) return Promise.resolve(false)
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return Promise.resolve(false)
  const [, salt, expectedHex] = parts
  if (!/^[a-f0-9]{64}$/i.test(expectedHex)) return Promise.resolve(false)
  const expected = Buffer.from(expectedHex, 'hex')
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, expected.length, (error, derived) => {
      if (error !== null) {
        reject(error)
        return
      }
      const actual = Buffer.from(derived)
      resolve(actual.length === expected.length && timingSafeEqual(actual, expected))
    })
  })
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

/** `token`: the shared bearer token (design 17 §5.2). Persisted only as a salted scrypt
 * hash (S5) — never the plaintext; the config/env plaintext is dropped at
 * creation. Verify is constant-time and scrypt-work-gated, like the password
 * path. (Migration: a legacy fixed-key HMAC hash fails verify and must be
 * re-provisioned.) */
function createTokenProvider(store: GatewayStore, plainToken: string): AuthProvider {
  const tokenHash = plainToken !== '' ? hashCredential(plainToken) : null
  if (tokenHash !== null) store.setTokenHash(tokenHash)
  const verifyBounded = createPasswordWorkGate()
  return {
    kind: 'token',
    async verify(req: AuthRequest): Promise<AuthPrincipal | null> {
      const value = headerValue(req.headers, 'authorization')
      if (value === undefined) return null
      const match = /^Bearer[ \t]+(.+)$/i.exec(value)
      if (match === null) return null
      const stored = store.getTokenHash()
      if (stored === null) return null
      const ok = await verifyBounded(() => verifyCredentialAsync(match[1], stored))
      if (!ok) return null
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
  const verifyBounded = createPasswordWorkGate()

  function rateKey(req: AuthRequest): string {
    return req.clientAddress ?? req.socketAddr
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
      const key = rateKey(req)
      const check = rateLimit.consume(key)
      if (!check.allowed) {
        const err = new Error(`too many login attempts; retry in ${Math.ceil(check.retryAfterMs / 1000)}s`) as Error & { code?: string }
        err.code = 'rate_limited'
        throw err
      }
      const password = (body as { password?: unknown } | null | undefined)?.password
      if (passwordHash === null || typeof password !== 'string'
        || !(await verifyBounded(() => verifyCredentialAsync(password, passwordHash)))) {
        throw new Error('invalid password')
      }
      rateLimit.reset(key)
      const now = Math.floor(Date.now() / 1000)
      const jwt = signJwt({ sub: 'user', iat: now, exp: now + SESSION_TTL_SECONDS }, store.getJwtSecret())
      return {
        setCookie: `${SESSION_COOKIE}=${jwt}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${req.secure === true ? '; Secure' : ''}`,
      }
    },
    async revoke(): Promise<void> {
      store.rotateJwtSecret()
    },
  }
}

export function createAuth(config: AuthConfig, store: GatewayStore): AuthProvider {
  const hasPassword = config.password !== undefined && config.password !== ''
  const hasToken = config.token !== undefined && config.token !== ''
  if (hasPassword && (config.password!.length < MIN_GATEWAY_PASSWORD_CHARS || config.password!.length > MAX_GATEWAY_PASSWORD_CHARS)) {
    throw new TypeError(`gateway password must be ${MIN_GATEWAY_PASSWORD_CHARS}-${MAX_GATEWAY_PASSWORD_CHARS} characters`)
  }
  if (hasToken && (config.token!.length < MIN_GATEWAY_TOKEN_CHARS || config.token!.length > MAX_GATEWAY_TOKEN_CHARS
    || !/^[\x20-\x7e]+$/.test(config.token!))) {
    throw new TypeError(`gateway token must be ${MIN_GATEWAY_TOKEN_CHARS}-${MAX_GATEWAY_TOKEN_CHARS} visible ASCII characters`)
  }
  store.syncPasswordCredential(hasPassword ? config.password! : null)
  if (!hasPassword && !hasToken) return createNoneProvider()
  const password = hasPassword ? createPasswordProvider(store, config.password!) : null
  const token = hasToken ? createTokenProvider(store, config.token!) : null
  if (password === null) return token!
  if (token === null) return password
  return {
    kind: 'password+token',
    async verify(req): Promise<AuthPrincipal | null> {
      // Authorization is explicit machine intent; check it before the ambient
      // browser cookie so a valid bearer retains its token principal.
      return await token.verify(req) ?? await password.verify(req)
    },
    login: (body, req) => password.login!(body, req),
    async revoke(principal): Promise<void> {
      if (principal.kind === 'password') await password.revoke?.(principal)
      else await token.revoke?.(principal)
    },
  }
}
