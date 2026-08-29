/**
 * Gateway authentication (design 17 §7; config hard gate §5.1): the pluggable
 * AuthProvider seam.
 *
 *   - `none`    — loopback-only trust (S1 forbids it on a non-loopback bind).
 *   - `token`   — the shared bearer token (design 17 §7.2); only its salted
 *                 scrypt hash is persisted (`tokens.json`, 0600), never the
 *                 plaintext (S5).
 *   - `password`— scrypt password verify → HS256 JWT session cookie (12h),
 *                 `Path=/; HttpOnly; SameSite=Strict; Secure(conditional)`
 *                 (S12), login rate limit (S8), rotate-jwt-secret on revoke
 *                 (S13).
 *
 * Phase 1 — runtime credential management: credentials are SERVER STATE, not
 * deployment config. `createAuth` seeds the persisted store from config via
 * `seedCredentialsFromConfig` (config-asserted only while the persisted source
 * is `'config'`; `'runtime'` credentials are authoritative and config seeding
 * never overwrites them, warn instead). The returned provider is a DYNAMIC
 * facade whose effective kind is computed from the CURRENT persisted state per
 * request; `verify`/`login`/`revoke` dispatch by that state, and
 * `changePassword`/`changeToken` mutate it at runtime (persisted as
 * `source:'runtime'`, jwt-secret rotated first on password changes — S13).
 *
 * Wire contracts (error codes are the dispatch contract):
 *   - `changePassword(input, req)` / `changeToken(input, req)` resolve
 *     `{changed:true, kind, source, removed?|token?}`; errors carry one of
 *     `'bad_request' | 'invalid_credentials' | 'ambient_principal_rejected' |
 *     'last_credential' | 'rate_limited' | 'auth_busy'`.
 *   - Non-ambient proof: the request principal must be a bearer-token
 *     principal (token self-proves) OR the current password must verify (only
 *     while a password exists). A cookie-only principal without a valid
 *     current password is rejected `'ambient_principal_rejected'`; a principal
 *     with a wrong current password is rejected `'invalid_credentials'`
 *     (through the shared login rate limiter → `'rate_limited'`).
 *   - The facade ALWAYS exposes `login`; when no password is configured it
 *     throws `code:'no_password'` (dispatch may surface 404/400 accordingly).
 *
 * Design note — cached presence vs fresh kind: `kind` is a getter that reads
 * the persisted state fresh on every request. `verify` uses a CACHED
 * password/token-presence snapshot (refreshed by every credential mutation)
 * so the bearer wire-bounds check always precedes any persisted-hash read —
 * malformed wire input must reach zero hash reads (regression locked by
 * auth.test.ts). The facade is the sole credential mutator for its store, so
 * the cache cannot go stale in production.
 *
 * Secrets never reach logs/renderer/persistence in plaintext; failed auth logs
 * only the principal kind, never header values.
 */

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { CredentialSource, GatewayStore, GatewayStoreLogger } from './store.ts'
import { hashCredential, verifyCredential } from './store.ts'
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
  /** Runtime password change (Phase 1; wire errors documented in the module
   * docstring). `remove:true` deletes the password; otherwise `newPassword`
   * must be 12–1024 characters. */
  changePassword?(input: ChangePasswordInput, req: AuthRequest): Promise<ChangePasswordResult>
  /** Runtime token change (Phase 1). `remove:true` deletes the token;
   * otherwise `newToken` (optional, 32–4096 visible ASCII) or a CSPRNG
   * generated value is set. The plaintext `token` is returned exactly once
   * when a new value was set. */
  changeToken?(input: ChangeTokenInput, req: AuthRequest): Promise<ChangeTokenResult>
  /** Non-secret projection of the CURRENT persisted credentials (Phase 2, S5):
   * per-dimension provenance and last-write time ONLY — the verifier/hash
   * values never leave the store and never appear in the projection. `null`
   * means the dimension currently has no credential. */
  credentialProjection?(): {
    password: { source: CredentialSource; updatedAt: number } | null
    token: { source: CredentialSource; updatedAt: number } | null
  }
}

export interface AuthConfig {
  kind: 'none' | 'password' | 'token' | 'password+token'
  password?: string
  token?: string
}

export interface ChangePasswordInput {
  newPassword?: string
  remove?: boolean
  currentPassword?: string
}

export interface ChangeTokenInput {
  newToken?: string
  remove?: boolean
  currentPassword?: string
}

export interface ChangePasswordResult {
  changed: true
  kind: 'password'
  /** Provenance of the now-effective credential: `'runtime'` for a normal
   * change; `'config'` when a remove reverted to the deployment-config
   * password (last-credential gate). */
  source: CredentialSource
  removed?: boolean
}

export interface ChangeTokenResult {
  changed: true
  kind: 'token'
  source: CredentialSource
  /** The plaintext token — returned exactly once when a new value was set
   * (never on remove/revert). */
  token?: string
  removed?: boolean
}

/** Build a coded auth error (the `code` field is the wire contract). */
function coded(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

// ---------------------------------------------------------------------------
// JWT (HS256) — the 12h session credential (design §7.1; aligned with
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
  // The MAC below is always recomputed with HS256, so a forged header can
  // never weaken the signature. Reject any non-HS256 alg header explicitly
  // anyway: the verification policy must be self-documenting (defense in
  // depth against a future refactor that keys the MAC off the header).
  let headerValue: unknown
  try {
    headerValue = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (headerValue === null || typeof headerValue !== 'object'
    || (headerValue as { alg?: unknown }).alg !== 'HS256') return null
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
  // Never choose a first value from an ambiguous credential field. The real
  // raw-header duplicate check lives in the shared HTTP/WS request policy;
  // this guard also keeps direct AuthProvider callers fail-closed.
  return typeof v === 'string' ? v : undefined
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

function validSessionExpiry(value: unknown, nowSeconds: number): value is number {
  // NumericDate is an integral epoch-second value. Keeping it inside the
  // issued-session horizon enforces the 12h contract even for a correctly
  // signed but malformed/crafted payload and avoids unsafe multiplication.
  return Number.isSafeInteger(value)
    && (value as number) > nowSeconds
    && (value as number) <= nowSeconds + SESSION_TTL_SECONDS
}

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

const SILENT_LOGGER = { log() {}, warn() {}, error() {} }

// ---------------------------------------------------------------------------
// Config seeding (source-aware)
// ---------------------------------------------------------------------------

/**
 * Seed the persisted credentials from deployment config (called by
 * `createAuth`). The persisted `source` decides whether config is asserted:
 *
 *   password dimension (rotate-first on any write — S13):
 *     1. config provides a password AND (nothing persisted OR source==='config')
 *        → write v2 (source:'config'); rotate jwt-secret first when the value
 *        changed, no-op when unchanged;
 *     2. config provides a password AND source==='runtime' → ignore config,
 *        warn loudly (with the runtime updatedAt + revert guidance);
 *     3. config provides no password AND source==='config' → delete the
 *        persisted verifier (rotate first);
 *     4. config provides no password AND source==='runtime' → keep, no warn.
 *
 *   token dimension: identical rules, no jwt-secret rotation (a token has no
 *   session-cookie association).
 */
export function seedCredentialsFromConfig(config: AuthConfig, store: GatewayStore, logger: GatewayStoreLogger = SILENT_LOGGER): void {
  const configPassword = config.password !== undefined && config.password !== '' ? config.password : null
  const configToken = config.token !== undefined && config.token !== '' ? config.token : null

  const passwordRecord = store.getPasswordCredentialRecord()
  if (configPassword !== null) {
    if (passwordRecord === null || passwordRecord.source === 'config') {
      const unchanged = passwordRecord !== null && verifyCredential(configPassword, passwordRecord.verifier)
      if (!unchanged) {
        store.rotateJwtSecret()
        store.setPasswordCredential(hashCredential(configPassword), 'config')
      }
    } else {
      logger.warn(
        `gateway-auth: config password IGNORED — a runtime-set password is active `
        + `(set ${new Date(passwordRecord.updatedAt).toISOString()}); revert it via the change API, `
        + 'or remove the persisted credential and restart to restore the deployment-config password',
      )
    }
  } else if (passwordRecord !== null && passwordRecord.source === 'config') {
    store.rotateJwtSecret()
    store.setPasswordCredential(null)
  }

  const tokenRecord = store.getTokenCredential()
  if (configToken !== null) {
    if (tokenRecord === null || tokenRecord.source === 'config') {
      const unchanged = tokenRecord !== null && verifyCredential(configToken, tokenRecord.verifier)
      if (!unchanged) store.setTokenHash(hashCredential(configToken), 'config')
    } else {
      logger.warn(
        `gateway-auth: config token IGNORED — a runtime-set token is active `
        + `(set ${new Date(tokenRecord.updatedAt).toISOString()}); revert it via the change API, `
        + 'or remove the persisted credential and restart to restore the deployment-config token',
      )
    }
  } else if (tokenRecord !== null && tokenRecord.source === 'config') {
    store.setTokenHash(null)
  }
}

// ---------------------------------------------------------------------------
// Leaf providers
// ---------------------------------------------------------------------------

/** `token` leaf: the shared bearer token (design 17 §7.2). Only the salted
 * scrypt hash is ever persisted (S5); the plaintext is dropped at seeding.
 * Verify is constant-time, scrypt-work-gated, and re-reads the CURRENT
 * persisted hash on every request so runtime token changes take effect
 * immediately. The wire bounds check runs BEFORE the persisted-hash read or
 * any scrypt work (malformed input must reach zero hash reads). */
function createTokenProvider(store: GatewayStore): AuthProvider {
  const verifyBounded = createPasswordWorkGate()
  return {
    kind: 'token',
    async verify(req: AuthRequest): Promise<AuthPrincipal | null> {
      const value = headerValue(req.headers, 'authorization')
      if (value === undefined) return null
      // Bound and validate the wire credential before reading the persisted
      // verifier or entering the scrypt work gate. One literal SP separates
      // the case-insensitive scheme; the token itself follows the same
      // 32..4096 visible-ASCII contract as configured tokens.
      const prefix = 'Bearer '
      if (value.length < prefix.length + MIN_GATEWAY_TOKEN_CHARS
        || value.length > prefix.length + MAX_GATEWAY_TOKEN_CHARS
        || value.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null
      const candidate = value.slice(prefix.length)
      if (!/^[\x20-\x7e]+$/.test(candidate)) return null
      const stored = store.getTokenHash()
      if (stored === null) return null
      const ok = await verifyBounded(() => verifyCredentialAsync(candidate, stored))
      if (!ok) return null
      return { kind: 'token', id: 'shared-token', issuedAt: Date.now() }
    },
  }
}

/** `password` leaf: scrypt verify → HS256 JWT session cookie (S12), login
 * rate limit (S8) and the bounded scrypt work gate — shared with the
 * credential-change path so brute force on currentPassword costs the same as
 * login. The verifier is re-read from the store on every login (never a
 * closure over config) so runtime password changes take effect immediately. */
function createPasswordProvider(
  store: GatewayStore,
  rateLimit: LoginRateLimiter,
  verifyBounded: (task: () => Promise<boolean>) => Promise<boolean>,
  rateKey: (req: AuthRequest) => string,
): { verify(req: AuthRequest): Promise<AuthPrincipal | null>; login(body: unknown, req: AuthRequest): Promise<{ setCookie?: string; token?: string }> } {
  return {
    async verify(req: AuthRequest): Promise<AuthPrincipal | null> {
      const cookie = parseCookie(headerValue(req.headers, 'cookie'))
      const session = cookie[SESSION_COOKIE]
      if (session === undefined) return null
      const payload = verifyJwt(session, store.getJwtSecret())
      if (payload === null) return null
      const exp = payload.exp
      const nowSeconds = Math.floor(Date.now() / 1000)
      if (!validSessionExpiry(exp, nowSeconds)) return null
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
      const verifier = store.getPasswordCredential()
      if (verifier === null || typeof password !== 'string'
        || !(await verifyBounded(() => verifyCredentialAsync(password, verifier)))) {
        throw new Error('invalid password')
      }
      rateLimit.reset(key)
      const now = Math.floor(Date.now() / 1000)
      const jwt = signJwt({ sub: 'user', iat: now, exp: now + SESSION_TTL_SECONDS }, store.getJwtSecret())
      return {
        setCookie: `${SESSION_COOKIE}=${jwt}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${req.secure === true ? '; Secure' : ''}`,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Dynamic facade
// ---------------------------------------------------------------------------

/** The dynamic AuthProvider facade (Phase 1): effective kind is derived from
 * the CURRENT persisted credentials; verify/login/revoke dispatch by it, and
 * changePassword/changeToken mutate it (serialized by a promise-chain mutex,
 * last-writer-wins). See the module docstring for the presence-cache note. */
function createDynamicAuthProvider(config: AuthConfig, store: GatewayStore): AuthProvider {
  const rateLimit = createLoginRateLimiter()
  const verifyBounded = createPasswordWorkGate()
  function rateKey(req: AuthRequest): string {
    // dispatch always passes decision.clientAddress as a string ('' when the
    // boundary could not derive a client) — `??` would never fall back, so
    // the empty string is handled explicitly (fall back to the socket peer).
    const addr = req.clientAddress
    return addr !== undefined && addr !== '' ? addr : req.socketAddr
  }
  const passwordLeaf = createPasswordProvider(store, rateLimit, verifyBounded, rateKey)
  const tokenLeaf = createTokenProvider(store)

  // Cached credential presence for verify dispatch (see module docstring):
  // refreshed by every credential mutation so the bearer wire bounds check
  // always precedes any persisted-hash read.
  let hasPassword = store.getPasswordCredential() !== null
  let hasToken = store.getTokenHash() !== null
  function refreshCredentialState(): void {
    hasPassword = store.getPasswordCredential() !== null
    hasToken = store.getTokenHash() !== null
  }

  const configPassword = config.password !== undefined && config.password !== '' ? config.password : null
  const configToken = config.token !== undefined && config.token !== '' ? config.token : null

  // Serialize credential changes: concurrent changePassword/changeToken calls
  // run strictly one after another (last-writer-wins, no interleaving).
  let changeChain: Promise<unknown> = Promise.resolve()
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = changeChain.then(task, task)
    changeChain = run.then(() => undefined, () => undefined)
    return run
  }

  let provider: AuthProvider

  /** Non-ambient proof gate shared by changePassword/changeToken: a bearer
   * token principal self-proves; otherwise the current password must verify
   * (bounded work gate + login rate limiter, same key as login). Any other
   * principal kind (e.g. a future passkey leaf) is explicitly fail-closed —
   * never an ambient proof. */
  async function assertChangeProof(input: { currentPassword?: unknown }, req: AuthRequest): Promise<void> {
    const currentPassword = input.currentPassword
    const principal = await provider.verify(req)
    if (principal !== null && principal.kind === 'token') return
    if (principal !== null && principal.kind !== 'password') {
      // Unknown/future principal kinds (passkey, …) are not ambient proof and
      // carry no password session — fail closed rather than silently
      // allowing a cookie-less mutation.
      throw coded('invalid_credentials', 'this principal kind cannot change gateway credentials without the current password')
    }
    if (typeof currentPassword !== 'string') {
      if (principal !== null) {
        throw coded('ambient_principal_rejected', 'a cookie-only principal must supply the current password to change gateway credentials')
      }
      throw coded('invalid_credentials', 'changing gateway credentials requires a bearer-token principal or the current password')
    }
    const verifier = store.getPasswordCredential()
    if (verifier === null) throw coded('invalid_credentials', 'no password is configured; the current password cannot be validated')
    const key = rateKey(req)
    const check = rateLimit.consume(key)
    if (!check.allowed) {
      throw coded('rate_limited', `too many attempts; retry in ${Math.ceil(check.retryAfterMs / 1000)}s`)
    }
    const ok = await verifyBounded(() => verifyCredentialAsync(currentPassword, verifier))
    if (!ok) throw coded('invalid_credentials', 'current password is incorrect')
    rateLimit.reset(key)
  }

  async function changePassword(input: ChangePasswordInput, req: AuthRequest): Promise<ChangePasswordResult> {
    return serialize(async () => {
      if (input === null || typeof input !== 'object') throw coded('bad_request', 'changePassword body must be an object')
      const remove = input.remove === true
      if (input.remove !== undefined && typeof input.remove !== 'boolean') throw coded('bad_request', 'remove must be a boolean')
      if (input.currentPassword !== undefined && typeof input.currentPassword !== 'string') {
        throw coded('bad_request', 'currentPassword must be a string')
      }
      // remove and a new value are mutually exclusive — never silently ignore
      // a conflicting field (honest failure over silent surprise).
      if (remove && input.newPassword !== undefined) {
        throw coded('bad_request', 'newPassword must not be present with remove')
      }
      if (!remove) {
        const newPassword = input.newPassword
        if (typeof newPassword !== 'string'
          || newPassword.length < MIN_GATEWAY_PASSWORD_CHARS || newPassword.length > MAX_GATEWAY_PASSWORD_CHARS) {
          throw coded('bad_request', `new password must be ${MIN_GATEWAY_PASSWORD_CHARS}-${MAX_GATEWAY_PASSWORD_CHARS} characters`)
        }
      }

      await assertChangeProof(input, req)

      // Last-credential gate: removing the final credential is refused unless
      // the deployment config provides a replacement (revert semantics).
      let revertToConfig = false
      if (remove) {
        const tokenExists = store.getTokenHash() !== null
        if (!tokenExists) {
          if (configPassword !== null) revertToConfig = true
          else throw coded('last_credential', 'refusing to remove the last gateway credential; configure a replacement first')
        }
      }

      if (remove) {
        // Rotate FIRST (S13): a failed persistence below leaves old cookies
        // dead instead of accepting a mixed state (never both).
        store.rotateJwtSecret()
        store.setPasswordCredential(revertToConfig ? hashCredential(configPassword!) : null, 'config')
      } else {
        store.rotateJwtSecret()
        store.setPasswordCredential(hashCredential(input.newPassword!), 'runtime')
      }
      refreshCredentialState()
      return {
        changed: true,
        kind: 'password',
        source: revertToConfig ? 'config' : 'runtime',
        ...(remove ? { removed: true } : {}),
      }
    })
  }

  async function changeToken(input: ChangeTokenInput, req: AuthRequest): Promise<ChangeTokenResult> {
    return serialize(async () => {
      if (input === null || typeof input !== 'object') throw coded('bad_request', 'changeToken body must be an object')
      const remove = input.remove === true
      if (input.remove !== undefined && typeof input.remove !== 'boolean') throw coded('bad_request', 'remove must be a boolean')
      if (input.currentPassword !== undefined && typeof input.currentPassword !== 'string') {
        throw coded('bad_request', 'currentPassword must be a string')
      }
      // remove and a new value are mutually exclusive — never silently ignore
      // a conflicting field (honest failure over silent surprise).
      if (remove && input.newToken !== undefined) {
        throw coded('bad_request', 'newToken must not be present with remove')
      }
      let tokenValue: string | null = null
      if (!remove) {
        if (typeof input.newToken === 'string' && input.newToken !== '') {
          tokenValue = input.newToken
        } else if (input.newToken !== undefined) {
          throw coded('bad_request', 'newToken must be a non-empty string')
        } else {
          tokenValue = randomBytes(32).toString('base64url')
        }
        if (tokenValue.length < MIN_GATEWAY_TOKEN_CHARS || tokenValue.length > MAX_GATEWAY_TOKEN_CHARS
          || !/^[\x20-\x7e]+$/.test(tokenValue)) {
          throw coded('bad_request', `new token must be ${MIN_GATEWAY_TOKEN_CHARS}-${MAX_GATEWAY_TOKEN_CHARS} visible ASCII characters`)
        }
      }

      await assertChangeProof(input, req)

      let revertToConfig = false
      if (remove) {
        const passwordExists = store.getPasswordCredential() !== null
        if (!passwordExists) {
          if (configToken !== null) revertToConfig = true
          else throw coded('last_credential', 'refusing to remove the last gateway credential; configure a replacement first')
        }
      }

      if (remove) {
        store.setTokenHash(revertToConfig ? hashCredential(configToken!) : null, 'config')
      } else {
        store.setTokenHash(hashCredential(tokenValue!), 'runtime')
      }
      refreshCredentialState()
      return {
        changed: true,
        kind: 'token',
        source: revertToConfig ? 'config' : 'runtime',
        ...(remove ? { removed: true } : { token: tokenValue! }),
      }
    })
  }

  provider = {
    get kind(): string {
      const hasPwd = store.getPasswordCredential() !== null
      const hasTok = store.getTokenHash() !== null
      return hasPwd && hasTok ? 'password+token' : hasPwd ? 'password' : hasTok ? 'token' : 'none'
    },
    async verify(req: AuthRequest): Promise<AuthPrincipal | null> {
      if (!hasPassword) {
        // Token-only or none. The token leaf's wire bounds check always runs
        // BEFORE any persisted-hash read; the cached hasToken flag decides
        // "wrong/absent bearer on a token deployment" (null) vs "no-auth
        // deployment" (anonymous) without touching the store for malformed
        // input.
        const tokenPrincipal = await tokenLeaf.verify(req)
        if (tokenPrincipal !== null) return tokenPrincipal
        return hasToken ? null : { kind: 'none', id: 'anonymous', issuedAt: Date.now() }
      }
      if (!hasToken) {
        return passwordLeaf.verify(req)
      }
      // password+token OR-principal composition (design 17 §7.3): bearer
      // first, cookie fallback; a saturated bearer gate is not a verdict —
      // preserve auth_busy only when the cookie also cannot authenticate so
      // overload is never disguised as an ordinary 401.
      try {
        return await tokenLeaf.verify(req) ?? await passwordLeaf.verify(req)
      } catch (error) {
        if ((error as Error & { code?: string }).code !== 'auth_busy') throw error
        const cookiePrincipal = await passwordLeaf.verify(req)
        if (cookiePrincipal !== null) return cookiePrincipal
        throw error
      }
    },
    async login(body: unknown, req: AuthRequest): Promise<{ setCookie?: string; token?: string }> {
      // The facade ALWAYS exposes login; without a configured password it
      // throws 'no_password' (documented contract with dispatch).
      if (!hasPassword) throw coded('no_password', 'password login is not configured on this gateway')
      return passwordLeaf.login(body, req)
    },
    async revoke(principal: AuthPrincipal): Promise<void> {
      if (principal.kind === 'password') store.rotateJwtSecret()
    },
    changePassword,
    changeToken,
    // Phase 2 projection: strip the verifier/hash before anything leaves the
    // provider — the wire contract is provenance + updatedAt only (S5).
    credentialProjection() {
      const passwordRecord = store.getPasswordCredentialRecord()
      const tokenRecord = store.getTokenCredential()
      return {
        password: passwordRecord === null ? null : { source: passwordRecord.source, updatedAt: passwordRecord.updatedAt },
        token: tokenRecord === null ? null : { source: tokenRecord.source, updatedAt: tokenRecord.updatedAt },
      }
    },
  }
  return provider
}

export function createAuth(config: AuthConfig, store: GatewayStore, logger: GatewayStoreLogger = SILENT_LOGGER): AuthProvider {
  const hasPassword = config.password !== undefined && config.password !== ''
  const hasToken = config.token !== undefined && config.token !== ''
  if (hasPassword && (config.password!.length < MIN_GATEWAY_PASSWORD_CHARS || config.password!.length > MAX_GATEWAY_PASSWORD_CHARS)) {
    throw new TypeError(`gateway password must be ${MIN_GATEWAY_PASSWORD_CHARS}-${MAX_GATEWAY_PASSWORD_CHARS} characters`)
  }
  if (hasToken && (config.token!.length < MIN_GATEWAY_TOKEN_CHARS || config.token!.length > MAX_GATEWAY_TOKEN_CHARS
    || !/^[\x20-\x7e]+$/.test(config.token!))) {
    throw new TypeError(`gateway token must be ${MIN_GATEWAY_TOKEN_CHARS}-${MAX_GATEWAY_TOKEN_CHARS} visible ASCII characters`)
  }
  seedCredentialsFromConfig(config, store, logger)
  return createDynamicAuthProvider(config, store)
}
