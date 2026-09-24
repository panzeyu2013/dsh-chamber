/**
 * Gateway authentication: the pluggable AuthProvider seam over the persisted
 * credential store — `none` (loopback-only trust), `token` (shared bearer; only
 * a salted scrypt hash persists), `password` (scrypt → HS256 JWT session cookie).
 *
 * Credentials are SERVER STATE: config seeds the store only while the persisted
 * source is 'config'; 'runtime' credentials are authoritative. Kind and
 * verification share one generation-bound presence snapshot; a password
 * mutation rotates the jwt secret before the store write. Changes resolve
 * {changed:true, kind, source, removed?|token?} and reject with 'bad_request' |
 * 'invalid_credentials' | 'ambient_principal_rejected' | 'last_credential' |
 * 'rate_limited' | 'auth_busy'; non-token principals prove the current password; `login`
 * always exists ('no_password'). Secrets never reach logs or persistence. */

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { CredentialSource, GatewayStore, GatewayStoreLogger } from './store.ts'
import { hashCredential, verifyCredential } from './store.ts'
import {
  MAX_GATEWAY_PASSWORD_CHARS,
  MAX_GATEWAY_TOKEN_CHARS,
  MIN_GATEWAY_PASSWORD_CHARS,
  MIN_GATEWAY_TOKEN_CHARS,
} from './config.ts'
import { GATEWAY_SESSION_COOKIE_NAME, GATEWAY_SESSION_TTL_SECONDS, GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN } from '@dsh-chamber/control-plane'
import { headerValueSingle } from './http-utils.ts'

export interface AuthPrincipal {
  kind: 'password' | 'token' | 'passkey' | 'none'
  id: string
  issuedAt: number
  /** Credential generation captured by verify(); the principal is admitted
   * only while it still equals AuthProvider.generation. Never serialized. */
  generation?: number
}

/** Opaque process-local proof of a principal at one credential generation;
 * validated by identity, so it cannot be forged through this shape. */
export interface AuthChangeProof {
  readonly principal: AuthPrincipal
  readonly generation: number
}

/** The request facts an AuthProvider reads (node:http-compatible). */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>
  socketAddr: string
  /** Boundary-evaluated client IP; forwarded headers are never read by the auth provider. */
  clientAddress?: string
  /** True only for a TLS socket or a trusted proxy's validated https hop. */
  secure?: boolean
}

export interface AuthProvider {
  readonly kind: string
  /** Monotonic process-local epoch, bumped immediately before the first store
   * side effect, fencing old proofs and streams across uncertain publishes. */
  readonly generation?: number
  /** Extract + verify identity; null = unauthenticated. Never logs/replies credentials. */
  verify(req: AuthRequest): Promise<AuthPrincipal | null>
  /** Login endpoint (password providers only); `req` supplies the rate-limit key. */
  login?(body: unknown, req: AuthRequest): Promise<{ setCookie?: string; token?: string }>
  /** Unforgeable generation-bound proof; dispatch reuses it instead of repeating bearer scrypt. */
  captureChangeProof?(principal: AuthPrincipal): AuthChangeProof | null
  /** Runtime password change (wire errors on the module); `remove:true` deletes it. */
  changePassword?(input: ChangePasswordInput, req: AuthRequest, proof?: AuthChangeProof): Promise<ChangePasswordResult>
  /** Runtime token change; `remove:true` deletes it, otherwise a supplied or
   * CSPRNG token is set and returned exactly once. */
  changeToken?(input: ChangeTokenInput, req: AuthRequest, proof?: AuthChangeProof): Promise<ChangeTokenResult>
  /** Non-secret projection of the CURRENT credentials: provenance and
   * last-write time only, never verifier/hash values. */
  credentialProjection?(): {
    password: { source: CredentialSource; updatedAt: number } | null
    token: { source: CredentialSource; updatedAt: number } | null
  }
}

/** Crypto seam; production callers use the bounded asynchronous scrypt verifier. */
export interface AuthDeps {
  verifyCredentialAsync?: (plain: string, stored: string | null) => Promise<boolean>
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
  /** Provenance of the now-effective credential: 'runtime' for a normal
   * change, 'config' when a remove reverted to the deployment-config password. */
  source: CredentialSource
  removed?: boolean
}

export interface ChangeTokenResult {
  changed: true
  kind: 'token'
  source: CredentialSource
  /** Plaintext token — returned exactly once when a new value was set. */
  token?: string
  removed?: boolean
  /** Online verifier exact, durability unconfirmed; the token is still returned
   * once so a generated rotation can never lock the operator out. */
  durability?: 'unknown'
}

/** Build a coded auth error (the `code` field is the wire contract). */
function coded(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

// JWT (HS256), the 12h session credential; hand-rolled to avoid a library dependency.

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
  // The MAC is always recomputed with HS256, but reject a non-HS256 alg
  // explicitly so the policy never depends on keying the MAC off the header.
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

/** Shared wire-protocol single source for the session cookie name. */
export const SESSION_COOKIE = GATEWAY_SESSION_COOKIE_NAME
const SESSION_TTL_SECONDS = GATEWAY_SESSION_TTL_SECONDS

function validSessionExpiry(value: unknown, nowSeconds: number): value is number {
  // NumericDate is an integral epoch second kept inside the issued horizon: it
  // enforces the 12h contract on crafted payloads and avoids unsafe multiplication.
  return Number.isSafeInteger(value)
    && (value as number) > nowSeconds
    && (value as number) <= nowSeconds + SESSION_TTL_SECONDS
}

interface LoginRateLimiter {
  consume(key: string): { allowed: boolean; retryAfterMs: number }
  reset(key: string): void
}

/** Login rate limiter: bounded cardinality and per-client quota. Once the table
 * is full, new addresses share a low-quota overflow bucket. */
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

/** Bounded semaphore around asynchronous scrypt: keeps the event loop
 * responsive and bounds queued memory under distributed guessing. */
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


/**
 * Seed the persisted credentials from deployment config; the persisted `source`
 * decides whether config is asserted:
 *   1. config present AND (nothing persisted OR source==='config') → write
 *      source:'config' (password: rotate the jwt secret first);
 *   2. config present AND source==='runtime' → ignore config, warn;
 *   3. config absent AND source==='config' → delete the persisted verifier;
 *   4. config absent AND source==='runtime' → keep, no warn.
 * Tokens follow the same rules without jwt-secret rotation.
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


/** `token` leaf: shared bearer. Only a salted scrypt hash is persisted. Verify is
 * constant-time, work-gated, and re-reads the CURRENT hash every request; the
 * wire bounds check runs BEFORE the hash read so malformed input reaches zero
 * hash reads. */
function createTokenProvider(
  store: GatewayStore,
  verifyAsync: (plain: string, stored: string | null) => Promise<boolean>,
  generation: () => number,
): AuthProvider {
  const verifyBounded = createPasswordWorkGate()
  return {
    kind: 'token',
    async verify(req: AuthRequest): Promise<AuthPrincipal | null> {
      const value = headerValueSingle(req.headers, 'authorization')
      if (value === undefined) return null
      // Bound and validate the wire credential before reading the stored verifier
      // or entering the scrypt gate. One literal SP separates the case-insensitive
      // scheme; the token follows the same 32..4096 visible-ASCII contract.
      const prefix = 'Bearer '
      if (value.length < prefix.length + MIN_GATEWAY_TOKEN_CHARS
        || value.length > prefix.length + MAX_GATEWAY_TOKEN_CHARS
        || value.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null
      const candidate = value.slice(prefix.length)
      if (!GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN.test(candidate)) return null
      const admittedGeneration = generation()
      const stored = store.getTokenHash()
      if (stored === null) return null
      const ok = await verifyBounded(() => verifyAsync(candidate, stored))
      // A verifier captured before a token rotation is not a live verdict, even
      // when its deferred scrypt work eventually matches the old hash.
      if (!ok || admittedGeneration !== generation()) return null
      return { kind: 'token', id: 'shared-token', issuedAt: Date.now(), generation: admittedGeneration }
    },
  }
}

/** `password` leaf: scrypt verify → HS256 JWT session cookie, login rate limit
 * and the bounded work gate (shared with credential changes, so guessing
 * currentPassword costs the same as login). The verifier is re-read from the
 * store on every login, never a closure over config. */
function createPasswordProvider(
  store: GatewayStore,
  rateLimit: LoginRateLimiter,
  verifyBounded: (task: () => Promise<boolean>) => Promise<boolean>,
  rateKey: (req: AuthRequest) => string,
  verifyAsync: (plain: string, stored: string | null) => Promise<boolean>,
  generation: () => number,
): { verify(req: AuthRequest): Promise<AuthPrincipal | null>; login(body: unknown, req: AuthRequest): Promise<{ setCookie?: string; token?: string }> } {
  return {
    async verify(req: AuthRequest): Promise<AuthPrincipal | null> {
      const admittedGeneration = generation()
      const cookie = parseCookie(headerValueSingle(req.headers, 'cookie'))
      const session = cookie[SESSION_COOKIE]
      if (session === undefined) return null
      const payload = verifyJwt(session, store.getJwtSecret())
      if (payload === null) return null
      const exp = payload.exp
      const nowSeconds = Math.floor(Date.now() / 1000)
      if (!validSessionExpiry(exp, nowSeconds)) return null
      const sub = typeof payload.sub === 'string' ? payload.sub : 'user'
      const iat = typeof payload.iat === 'number' ? payload.iat * 1000 : Date.now()
      return { kind: 'password', id: sub, issuedAt: iat, generation: admittedGeneration }
    },
    async login(body: unknown, req: AuthRequest): Promise<{ setCookie?: string; token?: string }> {
      const key = rateKey(req)
      const check = rateLimit.consume(key)
      if (!check.allowed) {
        const err = new Error(`too many login attempts; retry in ${Math.ceil(check.retryAfterMs / 1000)}s`) as Error & { code?: string; retryAfterMs?: number }
        err.code = 'rate_limited'
        err.retryAfterMs = check.retryAfterMs
        throw err
      }
      const password = (body as { password?: unknown } | null | undefined)?.password
      const admittedGeneration = generation()
      const verifier = store.getPasswordCredential()
      if (verifier === null || typeof password !== 'string'
        || !(await verifyBounded(() => verifyAsync(password, verifier)))) {
        throw new Error('invalid password')
      }
      // Never combine an old password verdict with the new jwt secret: a login
      // begun before rotation must not mint a fresh post-rotation session.
      if (admittedGeneration !== generation()) {
        throw coded('invalid_credentials', 'credentials changed while login was in progress')
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


/** Dynamic AuthProvider facade: effective kind and verify/login dispatch share
 * the current generation-bound presence snapshot; mutations are serialized and
 * reject stale proofs. */
function createDynamicAuthProvider(config: AuthConfig, store: GatewayStore, deps: AuthDeps = {}): AuthProvider {
  const rateLimit = createLoginRateLimiter()
  const verifyBounded = createPasswordWorkGate()
  const verifyAsync = deps.verifyCredentialAsync ?? verifyCredentialAsync
  let credentialGeneration = 0
  const issuedPrincipals = new WeakSet<AuthPrincipal>()
  const issuedChangeProofs = new WeakSet<AuthChangeProof>()
  function issuePrincipal(principal: AuthPrincipal | null): AuthPrincipal | null {
    if (principal !== null) issuedPrincipals.add(principal)
    return principal
  }
  function rateKey(req: AuthRequest): string {
    // dispatch passes clientAddress as a string ('' when the boundary could not
    // derive a client), so `??` would never fall back; handle '' explicitly.
    const addr = req.clientAddress
    return addr !== undefined && addr !== '' ? addr : req.socketAddr
  }
  const passwordLeaf = createPasswordProvider(
    store, rateLimit, verifyBounded, rateKey, verifyAsync, () => credentialGeneration,
  )
  const tokenLeaf = createTokenProvider(store, verifyAsync, () => credentialGeneration)

  // Cached presence for verify dispatch: updated on success, reconciled from the
  // affected file after a failed mutation (a rename may precede a failing parent
  // fsync), so the wire bounds check still precedes persisted-hash reads.
  let hasPassword = store.getPasswordCredential() !== null
  let hasToken = store.getTokenHash() !== null
  function reconcilePresence(read: () => string | null): boolean {
    try { return read() !== null } catch { return true }
  }

  const configPassword = config.password !== undefined && config.password !== '' ? config.password : null
  const configToken = config.token !== undefined && config.token !== '' ? config.token : null

  // Serialize credential changes: a proof captured before an earlier queued
  // commit is generation-stale and fails closed.
  let changeChain: Promise<unknown> = Promise.resolve()
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = changeChain.then(task, task)
    changeChain = run.then(() => undefined, () => undefined)
    return run
  }

  let provider: AuthProvider

  /** Non-ambient proof gate: a bearer token principal self-proves; otherwise the
   * current password must verify (same work gate + rate limiter as login).
   * Unknown principal kinds fail closed. */
  async function assertChangeProof(
    input: { currentPassword?: unknown },
    req: AuthRequest,
    proof?: AuthChangeProof,
  ): Promise<void> {
    const currentPassword = input.currentPassword
    let principal: AuthPrincipal | null
    if (proof === undefined) {
      // Direct-call fallback: callers that did not authenticate through dispatch still verify here.
      principal = await provider.verify(req)
    } else {
      if (!issuedChangeProofs.has(proof)
        || proof.generation !== credentialGeneration
        || proof.principal.generation !== credentialGeneration) {
        throw coded('invalid_credentials', 'authenticated credential proof is stale or invalid')
      }
      principal = proof.principal
    }
    if (principal !== null && principal.kind === 'token'
      && principal.generation === credentialGeneration) return
    if (principal !== null && principal.kind !== 'password') {
      // Cookie-less mutation must fail closed, not silently succeed.
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
    const admittedGeneration = credentialGeneration
    const ok = await verifyBounded(() => verifyAsync(currentPassword, verifier))
    if (admittedGeneration !== credentialGeneration) {
      throw coded('invalid_credentials', 'credentials changed while proof was in progress')
    }
    if (!ok) throw coded('invalid_credentials', 'current password is incorrect')
    rateLimit.reset(key)
  }

  async function changePassword(
    input: ChangePasswordInput,
    req: AuthRequest,
    proof?: AuthChangeProof,
  ): Promise<ChangePasswordResult> {
    return serialize(async () => {
      if (input === null || typeof input !== 'object') throw coded('bad_request', 'changePassword body must be an object')
      const remove = input.remove === true
      if (input.remove !== undefined && typeof input.remove !== 'boolean') throw coded('bad_request', 'remove must be a boolean')
      if (input.currentPassword !== undefined && typeof input.currentPassword !== 'string') {
        throw coded('bad_request', 'currentPassword must be a string')
      }
      // remove and a new value are mutually exclusive — never silently ignore one.
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

      await assertChangeProof(input, req, proof)

      // Last-credential gate: removing the final credential needs a config replacement.
      let revertToConfig = false
      if (remove) {
        const tokenExists = store.getTokenHash() !== null
        if (!tokenExists) {
          if (configPassword !== null) revertToConfig = true
          else throw coded('last_credential', 'refusing to remove the last gateway credential; configure a replacement first')
        }
      }

      // The generation fence precedes the first namespace mutation: a writer can
      // publish its rename and only then report a parent fsync failure, so old
      // streams/proofs must not survive that uncertain commit.
      const nextVerifier = remove
        ? (revertToConfig ? hashCredential(configPassword!) : null)
        : hashCredential(input.newPassword!)
      credentialGeneration += 1
      try {
        // Rotate FIRST: a failed verifier persistence leaves old cookies dead, not a mixed state.
        store.rotateJwtSecret()
        store.setPasswordCredential(nextVerifier, remove && revertToConfig ? 'config' : 'runtime')
      } catch (error) {
        // Reconcile presence with the online namespace: the rename may already
        // have landed. If even that read is unsafe, stay fail-closed as
        // credential-present rather than admitting anonymous.
        hasPassword = reconcilePresence(() => store.getPasswordCredential())
        throw error
      }
      hasPassword = remove ? revertToConfig : true
      return {
        changed: true,
        kind: 'password',
        source: revertToConfig ? 'config' : 'runtime',
        ...(remove ? { removed: true } : {}),
      }
    })
  }

  async function changeToken(
    input: ChangeTokenInput,
    req: AuthRequest,
    proof?: AuthChangeProof,
  ): Promise<ChangeTokenResult> {
    return serialize(async () => {
      if (input === null || typeof input !== 'object') throw coded('bad_request', 'changeToken body must be an object')
      const remove = input.remove === true
      if (input.remove !== undefined && typeof input.remove !== 'boolean') throw coded('bad_request', 'remove must be a boolean')
      if (input.currentPassword !== undefined && typeof input.currentPassword !== 'string') {
        throw coded('bad_request', 'currentPassword must be a string')
      }
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
          || !GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN.test(tokenValue)) {
          throw coded('bad_request', `new token must be ${MIN_GATEWAY_TOKEN_CHARS}-${MAX_GATEWAY_TOKEN_CHARS} visible ASCII characters`)
        }
      }

      await assertChangeProof(input, req, proof)

      let revertToConfig = false
      if (remove) {
        const passwordExists = store.getPasswordCredential() !== null
        if (!passwordExists) {
          if (configToken !== null) revertToConfig = true
          else throw coded('last_credential', 'refusing to remove the last gateway credential; configure a replacement first')
        }
      }

      // Fence before publication for the same rename-then-fsync ambiguity: a
      // failed attempt may force one reconnect, but never preserves old streams
      // after the token namespace actually changed.
      const nextHash = remove
        ? (revertToConfig ? hashCredential(configToken!) : null)
        : hashCredential(tokenValue!)
      credentialGeneration += 1
      let durabilityUnknown = false
      try {
        store.setTokenHash(nextHash, remove && revertToConfig ? 'config' : 'runtime')
      } catch (error) {
        let publishedHash: string | null
        try {
          publishedHash = store.getTokenHash()
          hasToken = publishedHash !== null
        } catch {
          hasToken = true
          throw error
        }
        if (publishedHash !== nextHash) throw error
        // Online publication is exact but the setter reported failure (normally:
        // rename done, parent fsync failed). Treat it as effective, return the
        // token once and mark durability unknown so no gateway becomes unrecoverable.
        durabilityUnknown = true
      }
      hasToken = remove ? revertToConfig : true
      return {
        changed: true,
        kind: 'token',
        source: revertToConfig ? 'config' : 'runtime',
        ...(remove ? { removed: true } : { token: tokenValue! }),
        ...(durabilityUnknown ? { durability: 'unknown' as const } : {}),
      }
    })
  }

  provider = {
    get generation(): number { return credentialGeneration },
    get kind(): string {
      return hasPassword && hasToken ? 'password+token' : hasPassword ? 'password' : hasToken ? 'token' : 'none'
    },
    async verify(req: AuthRequest): Promise<AuthPrincipal | null> {
      if (!hasPassword) {
        // Token-only or none: the leaf's wire bounds check precedes any persisted
        // read; the cached flag separates "wrong/absent bearer" (null) from
        // "no-auth deployment" (anonymous) without touching the store.
        const tokenPrincipal = await tokenLeaf.verify(req)
        if (tokenPrincipal !== null) return issuePrincipal(tokenPrincipal)
        return hasToken ? null : issuePrincipal({
          kind: 'none', id: 'anonymous', issuedAt: Date.now(), generation: credentialGeneration,
        })
      }
      if (!hasToken) {
        return issuePrincipal(await passwordLeaf.verify(req))
      }
      // password+token OR-composition: bearer first, cookie fallback; a saturated
      // bearer gate is not a verdict — keep auth_busy unless the cookie authenticates.
      try {
        return issuePrincipal(await tokenLeaf.verify(req) ?? await passwordLeaf.verify(req))
      } catch (error) {
        if ((error as Error & { code?: string }).code !== 'auth_busy') throw error
        const cookiePrincipal = await passwordLeaf.verify(req)
        if (cookiePrincipal !== null) return issuePrincipal(cookiePrincipal)
        throw error
      }
    },
    async login(body: unknown, req: AuthRequest): Promise<{ setCookie?: string; token?: string }> {
      // Always exposed; without a configured password it throws 'no_password'.
      if (!hasPassword) throw coded('no_password', 'password login is not configured on this gateway')
      return passwordLeaf.login(body, req)
    },
    captureChangeProof(principal: AuthPrincipal): AuthChangeProof | null {
      if (!issuedPrincipals.has(principal) || principal.generation !== credentialGeneration) return null
      const proof: AuthChangeProof = { principal, generation: credentialGeneration }
      issuedChangeProofs.add(proof)
      return proof
    },
    changePassword,
    changeToken,
    // Strip the verifier/hash: the wire contract is provenance + updatedAt only.
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

export function createAuth(
  config: AuthConfig,
  store: GatewayStore,
  logger: GatewayStoreLogger = SILENT_LOGGER,
  deps: AuthDeps = {},
): AuthProvider {
  const hasPassword = config.password !== undefined && config.password !== ''
  const hasToken = config.token !== undefined && config.token !== ''
  if (hasPassword && (config.password!.length < MIN_GATEWAY_PASSWORD_CHARS || config.password!.length > MAX_GATEWAY_PASSWORD_CHARS)) {
    throw new TypeError(`gateway password must be ${MIN_GATEWAY_PASSWORD_CHARS}-${MAX_GATEWAY_PASSWORD_CHARS} characters`)
  }
  if (hasToken && (config.token!.length < MIN_GATEWAY_TOKEN_CHARS || config.token!.length > MAX_GATEWAY_TOKEN_CHARS
    || !GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN.test(config.token!))) {
    throw new TypeError(`gateway token must be ${MIN_GATEWAY_TOKEN_CHARS}-${MAX_GATEWAY_TOKEN_CHARS} visible ASCII characters`)
  }
  seedCredentialsFromConfig(config, store, logger)
  return createDynamicAuthProvider(config, store, deps)
}
