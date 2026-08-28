/**
 * gateway-session unit tests (design 17 §7.3/§9.3/§13.5): the password →
 * 12h JWT cookie login exchange against a real node:http gateway stub —
 * 302+set-cookie success with attribute-stripped cookie caching, expiry-
 * driven re-login (12h − 5min skew), the 400/413/401 → invalid_credentials /
 * 429 → rate_limited / 503 → auth_busy classification, network failures,
 * redirect-without-cookie, per-origin session isolation, invalidate/
 * dispose lifecycle, and (via an injected request factory) the https-scheme
 * URL construction that plain-http tests cannot reach without TLS. P1-2 adds
 * the SPKI-pinned https login: an https origin with a configured pin
 * requests with rejectUnauthorized:false + agent:false, a peer failing the
 * pin check is classified 'other' (terminal in the verifyUp three-state,
 * never the forever-transient 'network'), and the pin is inert for http
 * origins (the probe guard mirrored). The real-TLS login pin match/mismatch
 * is exercised end-to-end in gateway-provider.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createGatewaySessionManager,
  GATEWAY_SESSION_COOKIE_NAME,
  GATEWAY_SESSION_EXPIRY_SKEW_MS,
  GATEWAY_SESSION_TTL_MS,
  type GatewayHttpRequest,
  type GatewaySessionOrigin,
  type GatewaySessionResult,
} from './gateway-session.ts'
import {
  createGatewaySessionRefresh,
  gatewaySessionOriginForUrl,
  GATEWAY_SESSION_REFRESH_LEAD_MS,
  type GatewaySessionRefreshDeps,
} from './gateway-session-refresh.ts'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZXNzaW9uIn0.signature'
const COOKIE = `${GATEWAY_SESSION_COOKIE_NAME}=${JWT}`
const PASSWORD = 'correct horse battery staple'

interface LoginRecord {
  path: string
  body: string
  headers: IncomingMessage['headers']
}

/** A gateway stub answering `POST /auth/login` with a 3xx + set-cookie (the
 * default happy path), recording every login. */
function loginHandler(logins: LoginRecord[], status = 302, setCookie: string[] | null = [`${COOKIE}; HttpOnly; Path=/; Max-Age=43200; SameSite=Strict`]) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      logins.push({ path: req.url ?? '', body, headers: req.headers })
      res.writeHead(status, setCookie !== null ? { 'set-cookie': setCookie } : {})
      res.end()
    })
  }
}

/** Start a real node:http gateway stub on an ephemeral loopback port. The
 * origin uses `insecureHttp: true` so the module speaks plain http (no TLS
 * fixture needed). */
async function startGateway(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ origin: GatewaySessionOrigin; close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: { baseUrl: `http://127.0.0.1:${port}`, insecureHttp: true },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

/** A fake request factory (`typeof node:http request` shape) for the cases a
 * real socket cannot reach deterministically: https-scheme URL inspection
 * and network errors. */
function stubRequestFactory(opts: { seenUrl?: (url: unknown) => void; status?: number; setCookie?: string[] | null; networkError?: boolean } = {}): GatewayHttpRequest {
  const { seenUrl, status = 302, setCookie = [COOKIE], networkError = false } = opts
  interface StubClientRequest {
    on(event: string, listener: (...args: unknown[]) => void): unknown
    emit(event: string, ...args: unknown[]): boolean
    end(): void
    destroy(): void
  }
  interface StubIncomingMessage {
    statusCode: number
    headers: Record<string, string | string[] | undefined>
    resume(): StubIncomingMessage
    on(event: string, listener: (...args: unknown[]) => void): unknown
  }
  const factory = ((url: unknown, _options: unknown, cb: (res: StubIncomingMessage) => void) => {
    seenUrl?.(url)
    const req = new EventEmitter() as unknown as StubClientRequest
    req.end = () => {}
    req.destroy = () => {}
    if (networkError) {
      setImmediate(() => req.emit('error', new Error('ECONNREFUSED')))
    } else {
      setImmediate(() => {
        const res = new EventEmitter() as unknown as StubIncomingMessage
        res.statusCode = status
        res.headers = setCookie !== null ? { 'set-cookie': setCookie } : {}
        res.resume = () => res
        cb(res)
      })
    }
    return req
  }) as unknown as GatewayHttpRequest
  return factory
}

type FailureCode = Extract<GatewaySessionResult, { ok: false }>['code']

function assertFailure(result: GatewaySessionResult, code: FailureCode): asserts result is Extract<GatewaySessionResult, { ok: false }> {
  assert.equal(result.ok, false, 'expected a failure result')
  assert.equal((result as { code: string }).code, code)
}

test('ensureSession: 302 + set-cookie succeeds, caches the bare cookie value, attributes stripped (design 17 §7.1/§7.3)', async () => {
  const logins: LoginRecord[] = []
  const gw = await startGateway(loginHandler(logins))
  const mgr = createGatewaySessionManager()
  try {
    const result = await mgr.ensureSession(gw.origin, PASSWORD)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.cookie, COOKIE, 'the returned cookie is header-ready dsh_gateway_session=<jwt>, attributes stripped')
    assert.equal(mgr.cachedCookie(gw.origin), COOKIE, 'the cached cookie is the same header-ready value')

    assert.equal(logins.length, 1)
    assert.equal(logins[0].path, '/auth/login', 'login posts to /auth/login')
    assert.equal(logins[0].headers['content-type'], 'application/json')
    assert.equal(JSON.parse(logins[0].body).password, PASSWORD, 'the body is JSON {password}')
    assert.equal(logins[0].headers['content-length'], String(Buffer.byteLength(logins[0].body)))
  } finally {
    mgr.dispose()
    await gw.close()
  }
})

test('the cached cookie expires after 12h − 5min and ensureSession re-logs in (design 17 §7.1/§9.3)', async () => {
  let nowMs = 1_000_000_000
  const logins: LoginRecord[] = []
  const gw = await startGateway(loginHandler(logins))
  const mgr = createGatewaySessionManager({ now: () => nowMs })
  try {
    assert.equal((await mgr.ensureSession(gw.origin, PASSWORD)).ok, true)
    assert.equal(mgr.cachedCookie(gw.origin), COOKIE, 'a fresh cookie is served')

    // Just before the expiry instant the cookie is still served…
    nowMs += GATEWAY_SESSION_TTL_MS - GATEWAY_SESSION_EXPIRY_SKEW_MS - 1
    assert.equal(mgr.cachedCookie(gw.origin), COOKIE)
    // …and at the expiry instant it is gone, so the next login happens anew.
    nowMs += 1
    assert.equal(mgr.cachedCookie(gw.origin), null, 'an expired cookie is never served')

    assert.equal((await mgr.ensureSession(gw.origin, PASSWORD)).ok, true)
    assert.equal(logins.length, 2, 'expiry forced a second login')
    assert.equal(mgr.cachedCookie(gw.origin), COOKIE, 'the re-login refilled the cache')
  } finally {
    mgr.dispose()
    await gw.close()
  }
})

test('401 → invalid_credentials and nothing is cached (design 17 §7.3 three-state)', async () => {
  const gw = await startGateway(loginHandler([], 401, null))
  const mgr = createGatewaySessionManager()
  try {
    const result = await mgr.ensureSession(gw.origin, 'wrong password')
    assertFailure(result, 'invalid_credentials')
    assert.match(result.error, /rejected the password login \(HTTP 401\)/)
    assert.equal(mgr.cachedCookie(gw.origin), null, 'a failed login caches nothing')
  } finally {
    mgr.dispose()
    await gw.close()
  }
})

test('login failure classification: 400/413/401 → invalid_credentials, 429 → rate_limited, 503 → auth_busy', async () => {
  const statuses = [400, 413, 401, 429, 503]
  const gw = await startGateway((_req, res) => {
    res.writeHead(statuses.shift() ?? 500)
    res.end()
  })
  const mgr = createGatewaySessionManager()
  try {
    const expected: Array<[number, 'invalid_credentials' | 'rate_limited' | 'auth_busy']> = [
      [400, 'invalid_credentials'],
      [413, 'invalid_credentials'],
      [401, 'invalid_credentials'],
      [429, 'rate_limited'],
      [503, 'auth_busy'],
    ]
    for (const [status, code] of expected) {
      const result = await mgr.ensureSession(gw.origin, PASSWORD)
      assertFailure(result, code)
      assert.equal(mgr.cachedCookie(gw.origin), null, 'no failure status caches a cookie')
      assert.equal(result.error.includes(String(status)), true, 'the classified message names the status')
    }
    assert.equal(statuses.length, 0, 'every status was consumed')
  } finally {
    mgr.dispose()
    await gw.close()
  }
})

test('a 3xx login answer without the session cookie is an other-failure, never a session', async () => {
  const gw = await startGateway((_req, res) => {
    res.writeHead(302, { location: '/' })
    res.end()
  })
  const mgr = createGatewaySessionManager()
  try {
    const result = await mgr.ensureSession(gw.origin, PASSWORD)
    assertFailure(result, 'other')
    assert.match(result.error, /login redirect without a dsh_gateway_session cookie/)
    assert.equal(mgr.cachedCookie(gw.origin), null)
  } finally {
    mgr.dispose()
    await gw.close()
  }
})

test('a network-level failure classifies as network (unreachable gateway)', async () => {
  const mgr = createGatewaySessionManager({ request: stubRequestFactory({ networkError: true }) })
  try {
    const result = await mgr.ensureSession({ baseUrl: 'http://127.0.0.1:1', insecureHttp: true }, PASSWORD)
    assertFailure(result, 'network')
    assert.equal(mgr.cachedCookie({ baseUrl: 'http://127.0.0.1:1', insecureHttp: true }), null)
  } finally {
    mgr.dispose()
  }
})

test('insecureHttp selects plain http end-to-end; a https origin builds an https login URL (design 17 §13.1)', async () => {
  const logins: LoginRecord[] = []
  const gw = await startGateway(loginHandler(logins))
  const mgr = createGatewaySessionManager()
  try {
    // insecureHttp: true → plain http against the http stub succeeds.
    const result = await mgr.ensureSession(gw.origin, PASSWORD)
    assert.equal(result.ok, true, 'a plain-http gateway login succeeds over insecureHttp')
  } finally {
    mgr.dispose()
    await gw.close()
  }

  // insecureHttp: false → the login URL must be https (verified without TLS
  // through an injected factory that answers with a stub response).
  const seen: string[] = []
  const httpsMgr = createGatewaySessionManager({ request: stubRequestFactory({ seenUrl: url => seen.push(String(url)) }) })
  try {
    const result = await httpsMgr.ensureSession({ baseUrl: 'https://gw.example.com:8443', insecureHttp: false }, PASSWORD)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.cookie, COOKIE)
    assert.deepEqual(seen, ['https://gw.example.com:8443/auth/login'])
  } finally {
    httpsMgr.dispose()
  }
})

// ---------------------------------------------------------------------------
// P1-2: the login request is SPKI-pinned exactly like the identity probe
// (S23) — an https origin with a configured `spkiPin` requests with
// rejectUnauthorized:false + agent:false and the socket verifier, a
// mismatched peer is classified 'other' (terminal in the verifyUp
// three-state, never the forever-transient 'network' that made an
// internal-CA gateway login fail → never ready), and the pin is inert for
// http origins (no TLS layer).
// ---------------------------------------------------------------------------

test('ensureSession: an https origin with an SPKI pin requests with rejectUnauthorized:false + agent:false (the pinned login, S23/P1-2)', async () => {
  const seen: Array<{ url: unknown; options: Record<string, unknown> }> = []
  const factory = stubRequestFactory()
  const wrapped = ((url: unknown, options: unknown, cb: unknown) => {
    seen.push({ url, options: (options ?? {}) as Record<string, unknown> })
    return (factory as unknown as (u: unknown, o: unknown, c: unknown) => unknown)(url, options, cb)
  }) as unknown as GatewayHttpRequest
  const mgr = createGatewaySessionManager({ request: wrapped })
  try {
    const origin: GatewaySessionOrigin = { baseUrl: 'https://gw.example.com:8443', insecureHttp: false, spkiPin: 'a'.repeat(64) }
    const result = await mgr.ensureSession(origin, PASSWORD)
    assert.equal(result.ok, true, 'the pinned login answers the stub redirect')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].options.rejectUnauthorized, false, 'the pin replaces CA trust — the internal-CA case')
    assert.equal(seen[0].options.agent, false, 'agent:false opens a fresh connection so the secureConnect verifier always fires')
  } finally {
    mgr.dispose()
  }
})

test('ensureSession: a peer failing the SPKI pin check is classified other (terminal), never network (S23/P1-2)', async () => {
  // What the socket verifier produces on a mismatch: the request is destroyed
  // with ERR_SPKI_PIN_MISMATCH (the real-TLS path is covered against a real
  // node:https server in gateway-provider.test.ts). The manager must classify
  // that code as deterministic 'other' — the verifyUp flow maps it TERMINAL —
  // never the transient 'network' that would keep the password flow retrying
  // forever (内部 CA 场景登录必失败 → network → 永不 ready).
  const factory = ((_url: unknown, _options: unknown, _cb: unknown) => {
    const req = new EventEmitter() as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): unknown
      emit(event: string, ...args: unknown[]): boolean
      end(): void
      destroy(): void
    }
    req.end = () => {}
    req.destroy = () => {}
    setImmediate(() => {
      const error: NodeJS.ErrnoException = new Error('SPKI pin mismatch')
      error.code = 'ERR_SPKI_PIN_MISMATCH'
      req.emit('error', error)
    })
    return req
  }) as unknown as GatewayHttpRequest
  const mgr = createGatewaySessionManager({ request: factory })
  try {
    const origin: GatewaySessionOrigin = { baseUrl: 'https://gw.example.com:8443', insecureHttp: false, spkiPin: 'b'.repeat(64) }
    const result = await mgr.ensureSession(origin, PASSWORD)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'other', 'a pin mismatch is deterministic protocol evidence — terminal in the verifyUp three-state')
      assert.match(result.error, /证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误/)
    }
    assert.equal(mgr.cachedCookie(origin), null, 'a failed pinned login caches nothing')
  } finally {
    mgr.dispose()
  }
})

test('ensureSession: an http origin with a pin stays unpinned (no TLS layer — the pin is inert, the probe guard mirrored)', async () => {
  const seen: Array<Record<string, unknown>> = []
  const factory = stubRequestFactory()
  const wrapped = ((url: unknown, options: unknown, cb: unknown) => {
    seen.push((options ?? {}) as Record<string, unknown>)
    return (factory as unknown as (u: unknown, o: unknown, c: unknown) => unknown)(url, options, cb)
  }) as unknown as GatewayHttpRequest
  const mgr = createGatewaySessionManager({ request: wrapped })
  try {
    const origin: GatewaySessionOrigin = { baseUrl: 'http://gw.example.com:8080', insecureHttp: true, spkiPin: 'a'.repeat(64) }
    const result = await mgr.ensureSession(origin, PASSWORD)
    assert.equal(result.ok, true, 'an http login with a stray pin still succeeds (the pin cannot apply)')
    assert.equal('rejectUnauthorized' in seen[0], false, 'an http login never requests pin options')
    assert.equal('agent' in seen[0], false)
  } finally {
    mgr.dispose()
  }
})

test('the session cookie is parsed among other set-cookie headers, attributes stripped', async () => {
  const gw = await startGateway((_req, res) => {
    res.writeHead(302, {
      'set-cookie': [
        'other=1; Path=/',
        `${COOKIE}; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=43200; HttpOnly; SameSite=Strict; Secure`,
      ],
    })
    res.end()
  })
  const mgr = createGatewaySessionManager()
  try {
    const result = await mgr.ensureSession(gw.origin, PASSWORD)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.cookie, COOKIE, 'Max-Age/Expires/HttpOnly/… attributes are stripped')
    assert.equal(mgr.cachedCookie(gw.origin), COOKIE)
  } finally {
    mgr.dispose()
    await gw.close()
  }
})

test('invalidate drops the cached cookie so the next proxy request re-logs in (design 17 §9.3 401 flow)', async () => {
  const logins: LoginRecord[] = []
  const gw = await startGateway(loginHandler(logins))
  const mgr = createGatewaySessionManager()
  try {
    assert.equal((await mgr.ensureSession(gw.origin, PASSWORD)).ok, true)
    assert.equal(mgr.cachedCookie(gw.origin), COOKIE)
    mgr.invalidate(gw.origin)
    assert.equal(mgr.cachedCookie(gw.origin), null, 'invalidate removes the session')
    assert.equal((await mgr.ensureSession(gw.origin, PASSWORD)).ok, true)
    assert.equal(logins.length, 2, 'invalidate forces a fresh login on the next ensureSession')
  } finally {
    mgr.dispose()
    await gw.close()
  }
})

test('sessions are cached per origin — one gateway login never leaks to another (design 17 §9.3 per-connection)', async () => {
  const gw1 = await startGateway(loginHandler([]))
  const gw2 = await startGateway(loginHandler([]))
  const mgr = createGatewaySessionManager()
  try {
    assert.equal((await mgr.ensureSession(gw1.origin, PASSWORD)).ok, true)
    assert.equal(mgr.cachedCookie(gw1.origin), COOKIE)
    assert.equal(mgr.cachedCookie(gw2.origin), null, 'a different gateway origin has no cookie')
    mgr.invalidate(gw2.origin)
    assert.equal(mgr.cachedCookie(gw1.origin), COOKIE, 'invalidating another origin leaves this session intact')
  } finally {
    mgr.dispose()
    await gw1.close()
    await gw2.close()
  }
})

test('dispose clears every cached session', async () => {
  const gw = await startGateway(loginHandler([]))
  const mgr = createGatewaySessionManager()
  try {
    assert.equal((await mgr.ensureSession(gw.origin, PASSWORD)).ok, true)
    assert.equal(mgr.cachedCookie(gw.origin), COOKIE)
    mgr.dispose()
    assert.equal(mgr.cachedCookie(gw.origin), null)
  } finally {
    await gw.close()
  }
})

test('a structurally invalid origin is refused with a TypeError (mirrors instance-proxy baseUrl gate)', () => {
  const mgr = createGatewaySessionManager()
  try {
    assert.throws(() => mgr.ensureSession({ baseUrl: 'https://gw.example.com', insecureHttp: true }, PASSWORD), /does not match/)
    assert.throws(() => mgr.ensureSession({ baseUrl: 'http://gw.example.com', insecureHttp: false }, PASSWORD), /does not match/)
    assert.throws(() => mgr.ensureSession({ baseUrl: 'ftp://gw.example.com', insecureHttp: false }, PASSWORD), /http\(s\) origin/)
    assert.throws(() => mgr.ensureSession({ baseUrl: 'https://user:pass@gw.example.com', insecureHttp: false }, PASSWORD), /no credentials/)
    assert.throws(() => mgr.ensureSession({ baseUrl: 'https://gw.example.com/path', insecureHttp: false }, PASSWORD), /no credentials/)
    assert.throws(() => mgr.ensureSession({ baseUrl: 'not a url', insecureHttp: false }, PASSWORD), /invalid gateway baseUrl/)
    assert.throws(() => mgr.cachedCookie({ baseUrl: 'https://gw.example.com', insecureHttp: true }), /does not match/)
  } finally {
    mgr.dispose()
  }
})

test('expiresAt reports the cached session\'s expiry instant and null when absent/expired/invalidated/disposed (design 17 §9.3 refresh scheduler)', async () => {
  let nowMs = 1_000_000_000
  const logins: LoginRecord[] = []
  const gw = await startGateway(loginHandler(logins))
  const mgr = createGatewaySessionManager({ now: () => nowMs })
  const origin = gw.origin
  try {
    assert.equal(mgr.expiresAt(origin), null, 'no session yet → null')
    assert.equal((await mgr.ensureSession(origin, PASSWORD)).ok, true)
    assert.equal(mgr.expiresAt(origin), nowMs + GATEWAY_SESSION_TTL_MS - GATEWAY_SESSION_EXPIRY_SKEW_MS, 'the cached expiry is TTL − skew after login')
    // Just before expiry the instant is still reported; at/after it the entry
    // is dropped (null) — the same boundary the cachedCookie fast path uses.
    nowMs += GATEWAY_SESSION_TTL_MS - GATEWAY_SESSION_EXPIRY_SKEW_MS - 1
    assert.equal(mgr.expiresAt(origin), nowMs + 1)
    nowMs += 1
    assert.equal(mgr.expiresAt(origin), null, 'an expired session reports null and is evicted')
    // invalidate / dispose also clear the expiry instant.
    assert.equal((await mgr.ensureSession(origin, PASSWORD)).ok, true)
    assert.notEqual(mgr.expiresAt(origin), null)
    mgr.invalidate(origin)
    assert.equal(mgr.expiresAt(origin), null, 'invalidate clears the expiry instant')
    assert.equal((await mgr.ensureSession(origin, PASSWORD)).ok, true)
    assert.notEqual(mgr.expiresAt(origin), null)
    mgr.dispose()
    assert.equal(mgr.expiresAt(origin), null, 'dispose clears the expiry instant')
  } finally {
    await gw.close()
  }
})

// ---------------------------------------------------------------------------
// gatewaySessionOriginForUrl (gateway-session-refresh.ts): the session origin
// derivation for a ready transport URL — loopback tunnel http + direct http(s)
// endpoint, used by the registration cookie lookup and the refresh scheduler.
// ---------------------------------------------------------------------------

test('gatewaySessionOriginForUrl derives the session origin from a ready transport URL (design 17 §9.3)', () => {
  assert.deepEqual(
    gatewaySessionOriginForUrl('http://127.0.0.1:40000'),
    { baseUrl: 'http://127.0.0.1:40000', insecureHttp: true },
    'an ssh tunnel endpoint is a loopback http origin (insecureHttp = scheme selector, not a judgement)',
  )
  assert.deepEqual(
    gatewaySessionOriginForUrl('https://gw.example.com:8443'),
    { baseUrl: 'https://gw.example.com:8443', insecureHttp: false },
    'an https direct endpoint keeps insecureHttp false',
  )
  assert.deepEqual(
    gatewaySessionOriginForUrl('http://gw.example.com:8080'),
    { baseUrl: 'http://gw.example.com:8080', insecureHttp: true },
    'an http direct endpoint (explicit insecureHttp) is http',
  )
  // P1-2: a configured SPKI pin rides the derived origin so the refresh login
  // is pinned exactly like the verifyUp login.
  const PIN = 'c'.repeat(64)
  assert.deepEqual(
    gatewaySessionOriginForUrl('https://gw.example.com:8443', PIN),
    { baseUrl: 'https://gw.example.com:8443', insecureHttp: false, spkiPin: PIN },
    'the pin rides the https origin for the pinned refresh login',
  )
  assert.equal(gatewaySessionOriginForUrl('ftp://gw.example.com'), null, 'a non-http(s) scheme is refused')
  assert.equal(gatewaySessionOriginForUrl('http://user:pass@127.0.0.1:1'), null, 'credentials are refused')
  assert.equal(gatewaySessionOriginForUrl('http://127.0.0.1:1/path'), null, 'a path is refused')
  assert.equal(gatewaySessionOriginForUrl('not a url'), null, 'an unparsable URL is refused')
})

// ---------------------------------------------------------------------------
// Live-proxy pre-expiry session refresh (design 17 §9.3,
// gateway-session-refresh.ts): re-login ~60s before the cached session's
// expiry, re-register the transport with the fresh cookie, cancel on disarm,
// and the bounded recovery when a re-login fails after the old cookie died —
// ONE controlled reconnect so verifyUp re-authenticates with the stored
// password (P2-1: a healthy transport must never ride a dead cookie).
// ---------------------------------------------------------------------------

/** A fake session manager slice + a captured schedule/cancel, so the whole
 * refresh orchestration is driven deterministically (no real 12h waits). All
 * mutable state lives in `state` — the deps closures read/write it, and the
 * tests poke it directly (including `failNextLogin` / `holdLogins`). */
function refreshHarness(overrides: Partial<GatewaySessionRefreshDeps> = {}) {
  const state = {
    nowMs: 1_000_000_000,
    TTL: GATEWAY_SESSION_TTL_MS - GATEWAY_SESSION_EXPIRY_SKEW_MS,
    expiries: new Map<string, number>(),
    logins: [] as Array<{ origin: GatewaySessionOrigin; password: string }>,
    registered: [] as Array<{ id: string; url: string; headers: Record<string, string> | undefined; tls: unknown; authority: string | undefined }>,
    warned: [] as string[],
    failNextLogin: null as Extract<GatewaySessionResult, { ok: false }> | null,
    /** When true the next login is HELD until releaseLogin() — tests flip
     * the live facts (a mid-login reconnect) before releasing it. */
    holdLogins: false,
    releaseLogin: null as (() => void) | null,
    scheduled: [] as Array<{ fn: () => void; delayMs: number }>,
    cancelled: [] as unknown[],
    reconnects: [] as string[],
    readyUrls: new Map<string, string>(),
    tokens: new Map<string, string>(),
    passwords: new Map<string, string>(),
    pins: new Map<string, string>(),
    authorities: new Map<string, string>(),
  }
  const keyFor = (origin: GatewaySessionOrigin) => `${origin.insecureHttp ? 'http' : 'https'}|${origin.baseUrl}`
  const deps: GatewaySessionRefreshDeps = {
    sessionManager: {
      ensureSession: (origin, password) => {
        state.logins.push({ origin, password })
        if (state.failNextLogin !== null) {
          const failure = state.failNextLogin
          state.failNextLogin = null
          return Promise.resolve(failure)
        }
        state.expiries.set(keyFor(origin), state.nowMs + state.TTL)
        const result: GatewaySessionResult = { ok: true, cookie: COOKIE }
        if (state.holdLogins) {
          return new Promise(resolve => { state.releaseLogin = () => resolve(result) })
        }
        return Promise.resolve(result)
      },
      expiresAt: origin => {
        // Mirror the REAL manager's boundary: an entry at/past its expiry
        // instant is evicted and reports null (the refresh must never arm
        // against a dead cookie).
        const expiry = state.expiries.get(keyFor(origin))
        if (expiry === undefined || expiry <= state.nowMs) return null
        return expiry
      },
    },
    passwordFor: id => state.passwords.get(id) ?? null,
    tokenFor: id => state.tokens.get(id) ?? null,
    readyUrlFor: id => state.readyUrls.get(id) ?? null,
    tlsPinFor: id => state.pins.get(id) ?? null,
    authorityFor: id => state.authorities.get(id),
    register: (id, url, headers, tls, authority) => state.registered.push({ id, url, headers, tls, authority }),
    reconnect: id => state.reconnects.push(id),
    warn: message => state.warned.push(message),
    now: () => state.nowMs,
    schedule: (fn, delayMs) => { state.scheduled.push({ fn, delayMs }); return state.scheduled.length },
    cancel: timer => state.cancelled.push(timer),
    ...overrides,
  }
  const refresh = createGatewaySessionRefresh(deps)

  /** Advance the clock to the next scheduled fire and invoke it (awaiting the
   * async refresh body via a macrotask flush). */
  async function fireNext(): Promise<void> {
    const entry = state.scheduled.shift()
    assert.ok(entry !== undefined, 'expected a scheduled refresh')
    state.nowMs += entry.delayMs
    entry.fn()
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  return { deps, refresh, state, keyFor, fireNext }
}

test('session refresh: arm schedules the re-login at expiresAt − 60s lead and no-ops without a password session (design 17 §9.3)', () => {
  const h = refreshHarness()
  h.state.readyUrls.set('gw-1', 'http://127.0.0.1:40000')
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.expiries.set(h.keyFor({ baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }), h.state.nowMs + h.state.TTL)
  h.refresh.arm('gw-1')
  assert.equal(h.state.scheduled.length, 1)
  assert.equal(
    h.state.scheduled[0].delayMs,
    h.state.TTL - GATEWAY_SESSION_REFRESH_LEAD_MS,
    'the refresh fires 60s before the cached session expires',
  )
  // No-ops: a token-authenticated target, a no-password target, a not-ready
  // target and a target without a cached session never schedule.
  h.state.tokens.set('gw-2', 'x'.repeat(32))
  h.state.passwords.set('gw-2', PASSWORD)
  h.refresh.arm('gw-2')
  h.state.readyUrls.set('gw-3', 'http://127.0.0.1:40001')
  h.refresh.arm('gw-3') // no password
  h.state.passwords.set('gw-4', PASSWORD)
  h.refresh.arm('gw-4') // not ready
  h.state.readyUrls.set('gw-5', 'http://127.0.0.1:40002')
  h.state.passwords.set('gw-5', PASSWORD)
  h.refresh.arm('gw-5') // no cached session → expiresAt null
  assert.equal(h.state.scheduled.length, 1, 'only the armed-with-session case schedules')
})

test('session refresh: the fired refresh re-logs in with the stored password, re-registers the fresh Cookie, and re-arms for the new expiry (design 17 §9.3)', async () => {
  const h = refreshHarness()
  h.state.readyUrls.set('gw-1', 'http://127.0.0.1:40000')
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.expiries.set(h.keyFor({ baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }), h.state.nowMs + h.state.TTL)
  h.refresh.arm('gw-1')
  await h.fireNext()
  assert.equal(h.state.logins.length, 1, 'the refresh performs exactly one login')
  assert.equal(h.state.logins[0].password, PASSWORD, 'the STORED password is re-exchanged')
  assert.equal(h.state.logins[0].origin.baseUrl, 'http://127.0.0.1:40000', 'the login targets the tunnel origin')
  assert.equal(h.state.registered.length, 1)
  assert.deepEqual(h.state.registered[0], {
    id: 'gw-1', url: 'http://127.0.0.1:40000', headers: { cookie: COOKIE }, tls: undefined, authority: undefined,
  }, 'the transport is re-registered with the fresh header-ready Cookie')
  assert.equal(h.state.scheduled.length, 1, 'a fresh session re-arms the next refresh')
  assert.equal(h.state.scheduled[0].delayMs, h.state.TTL - GATEWAY_SESSION_REFRESH_LEAD_MS, 'the next refresh is 60s before the NEW expiry')
  assert.equal(h.state.warned.length, 0)
  assert.equal(h.state.reconnects.length, 0, 'a successful refresh never triggers the recovery reconnect')
})

test('session refresh: the SPKI pin rides the re-registration AND the refresh login origin (S23/P1-2)', async () => {
  const PIN = 'a'.repeat(64)
  const h = refreshHarness()
  h.state.readyUrls.set('gw-1', 'https://gw.example.com:8443')
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.pins.set('gw-1', PIN)
  h.state.expiries.set(h.keyFor({ baseUrl: 'https://gw.example.com:8443', insecureHttp: false }), h.state.nowMs + h.state.TTL)
  h.refresh.arm('gw-1')
  await h.fireNext()
  assert.deepEqual(h.state.registered[0].tls, { tls: { spkiPin: PIN } })
  // P1-2: the pre-expiry re-login carries the pin too — the session manager
  // pins the https login like verifyUp does (main refresh 透传 spec.spkiPin).
  assert.equal(h.state.logins.length, 1)
  assert.equal(h.state.logins[0].origin.spkiPin, PIN, 'the refresh login origin carries the configured SPKI pin')
})

test('session refresh: a failed pre-expiry re-login keeps the old registration and retries at the old expiry (design 17 §9.3)', async () => {
  const h = refreshHarness()
  h.state.readyUrls.set('gw-1', 'http://127.0.0.1:40000')
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.expiries.set(h.keyFor({ baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }), h.state.nowMs + h.state.TTL)
  h.refresh.arm('gw-1')
  h.state.failNextLogin = { ok: false, code: 'rate_limited', error: 'the gateway is rate-limiting login attempts (429) — back off before retrying' }
  await h.fireNext()
  assert.equal(h.state.registered.length, 0, 'a failed re-login never re-registers (the old cookie stays valid until its expiry)')
  assert.equal(h.state.warned.length, 0, 'no residual-window warning while the old cookie is still live')
  assert.equal(h.state.scheduled.length, 1, 'the retry is re-armed')
  assert.equal(h.state.scheduled[0].delayMs, GATEWAY_SESSION_REFRESH_LEAD_MS, 'the retry fires at the old expiry instant (LEAD after the pre-expiry fire)')
})

test('session refresh: a re-login failing AFTER the old cookie died warns honestly and triggers exactly ONE controlled reconnect (P2-1 bounded recovery)', async () => {
  const h = refreshHarness()
  h.state.readyUrls.set('gw-1', 'http://127.0.0.1:40000')
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.expiries.set(h.keyFor({ baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }), h.state.nowMs - 1) // already past
  h.refresh.arm('gw-1')
  assert.equal(h.state.scheduled.length, 0, 'an already-expired session never arms (verifyUp re-logs in on the next connect)')
  assert.equal(h.state.reconnects.length, 0, 'nothing to recover — no refresh ever fired')
  // The expiry passes between arm and fire: the login fails and the cache
  // entry is gone → honest warning + ONE controlled reconnect (verifyUp
  // re-authenticates with the stored password), no further retry timer.
  const h2 = refreshHarness()
  h2.state.readyUrls.set('gw-1', 'http://127.0.0.1:40000')
  h2.state.passwords.set('gw-1', PASSWORD)
  h2.state.expiries.set(h2.keyFor({ baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }), h2.state.nowMs + h2.state.TTL)
  h2.refresh.arm('gw-1')
  h2.state.failNextLogin = { ok: false, code: 'network', error: 'the gateway did not answer the login request (network error)' }
  // The cache entry dies while the failed login is in flight.
  h2.state.expiries.delete(h2.keyFor({ baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }))
  await h2.fireNext()
  assert.equal(h2.state.registered.length, 0)
  assert.equal(h2.state.warned.length, 1, 'the dead-cookie window is warned, never silent')
  assert.match(h2.state.warned[0], /triggering one controlled reconnect/)
  assert.deepEqual(h2.state.reconnects, ['gw-1'], 'exactly ONE controlled reconnect — bounded recovery, never a storm')
  assert.equal(h2.state.scheduled.length, 0, 'no further retry once the old cookie is dead — the reconnect path recovers')
})

test('session refresh: the dead-cookie recovery does NOT reconnect a transport that already reconnected mid-login (the new ready owns the fresh session)', async () => {
  const h = refreshHarness()
  const origin40000 = { baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }
  h.state.readyUrls.set('gw-1', origin40000.baseUrl)
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.expiries.set(h.keyFor(origin40000), h.state.nowMs + h.state.TTL)
  h.state.failNextLogin = { ok: false, code: 'network', error: 'the gateway did not answer the login request (network error)' }
  h.refresh.arm('gw-1')
  // Fire the timer manually: the refresh captures the 40000 origin and awaits
  // the failing login. While it is in flight the tunnel reconnects on a NEW
  // port — the ready handler already re-logged in and re-registered under it.
  const entry = h.state.scheduled.shift()
  assert.ok(entry !== undefined)
  h.state.nowMs += entry.delayMs
  entry.fn()
  h.state.expiries.delete(h.keyFor(origin40000))
  h.state.readyUrls.set('gw-1', 'http://127.0.0.1:40011')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(h.state.warned.length, 1, 'still warned (the refresh failed on a dead cookie)')
  assert.equal(h.state.reconnects.length, 0, 'no recovery reconnect — the fresh ready already re-authenticated')
  assert.equal(h.state.scheduled.length, 0, 'no re-arm — the ready handler owns the new origin')
})

test('session refresh: the dead-cookie recovery does NOT reconnect a transport that left ready mid-login (nothing to recover)', async () => {
  const h = refreshHarness()
  const origin40000 = { baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }
  h.state.readyUrls.set('gw-1', origin40000.baseUrl)
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.expiries.set(h.keyFor(origin40000), h.state.nowMs + h.state.TTL)
  h.state.failNextLogin = { ok: false, code: 'network', error: 'the gateway did not answer the login request (network error)' }
  h.refresh.arm('gw-1')
  // Fire the timer manually: the refresh captures the 40000 origin and awaits
  // the failing login. While it is in flight the transport drops — the
  // control plane already unregistered and the refresh was disarmed.
  const entry = h.state.scheduled.shift()
  assert.ok(entry !== undefined)
  h.state.nowMs += entry.delayMs
  entry.fn()
  h.state.expiries.delete(h.keyFor(origin40000))
  h.state.readyUrls.delete('gw-1')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(h.state.warned.length, 1, 'still warned (the refresh failed on a dead cookie)')
  assert.equal(h.state.reconnects.length, 0, 'a non-ready transport has nothing for the recovery to reconnect')
  assert.equal(h.state.scheduled.length, 0)
})

test('session refresh: disarm cancels the pending refresh (disconnect / removal / quit)', async () => {
  const h = refreshHarness()
  h.state.readyUrls.set('gw-1', 'http://127.0.0.1:40000')
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.expiries.set(h.keyFor({ baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }), h.state.nowMs + h.state.TTL)
  h.refresh.arm('gw-1')
  h.refresh.disarm('gw-1')
  assert.equal(h.state.cancelled.length, 1, 'disarm cancels the pending timer')
  // A re-arm replaces the previous timer (a reconnect re-arms under the new
  // tunnel origin without leaving the old timer armed) — the schedule LIST
  // keeps every entry (three arms), but only the LAST timer stays uncancelled.
  h.refresh.arm('gw-1')
  h.refresh.arm('gw-1')
  assert.equal(h.state.cancelled.length, 2, 're-arming cancels the previous timer')
  assert.equal(h.state.scheduled.length, 3, 'three arms scheduled three entries')
  h.refresh.dispose()
  assert.equal(h.state.cancelled.length, 3, 'dispose cancels every pending timer')
})

test('session refresh: a reconnect mid-login never re-registers a stale tunnel URL (the ready handler owns the new origin)', async () => {
  const h = refreshHarness()
  const origin40000 = { baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }
  const origin40011 = { baseUrl: 'http://127.0.0.1:40011', insecureHttp: true }
  h.state.readyUrls.set('gw-1', origin40000.baseUrl)
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.expiries.set(h.keyFor(origin40000), h.state.nowMs + h.state.TTL)
  h.state.holdLogins = true
  h.refresh.arm('gw-1')
  // Fire the timer: the refresh captures the 40000 origin and awaits the held
  // login. While it is in flight the tunnel reconnects on a NEW port — the
  // ready handler has already re-logged in (a session minted at reconnect
  // time) and re-registered under it.
  const entry = h.state.scheduled.shift()
  assert.ok(entry !== undefined)
  h.state.nowMs += entry.delayMs
  h.state.expiries.set(h.keyFor(origin40011), h.state.nowMs + h.state.TTL)
  entry.fn()
  h.state.readyUrls.set('gw-1', origin40011.baseUrl)
  h.state.releaseLogin?.()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(h.state.registered.length, 0, 'the stale-URL re-registration is skipped')
  assert.equal(h.state.scheduled.length, 1, 'the refresh is re-armed under the NEW tunnel origin')
  assert.equal(h.state.scheduled[0].delayMs, h.state.TTL - GATEWAY_SESSION_REFRESH_LEAD_MS)
})

test('session refresh: the full cycle against a REAL session manager and gateway stub re-logins pre-expiry and re-registers the fresh cookie', async () => {
  const logins: LoginRecord[] = []
  const gw = await startGateway(loginHandler(logins))
  const mgr = createGatewaySessionManager()
  const readyUrls = new Map<string, string>()
  const registered: Array<{ url: string; headers: Record<string, string> | undefined; authority: string | undefined }> = []
  const scheduled: Array<{ fn: () => void; delayMs: number }> = []
  const refresh = createGatewaySessionRefresh({
    sessionManager: mgr,
    passwordFor: () => PASSWORD,
    tokenFor: () => null,
    readyUrlFor: id => readyUrls.get(id) ?? null,
    tlsPinFor: () => null,
    authorityFor: () => undefined,
    register: (id, url, headers, tls, authority) => registered.push({ url, headers, authority }),
    reconnect: () => assert.fail('the happy path never needs the recovery reconnect'),
    warn: () => assert.fail('no warning expected on the happy path'),
    schedule: (fn, delayMs) => { scheduled.push({ fn, delayMs }); return scheduled.length },
    cancel: () => {},
  })
  try {
    // Establish the session first (the real flow mints it in verifyUp BEFORE
    // the ready registration arms the refresh).
    assert.equal((await mgr.ensureSession(gw.origin, PASSWORD)).ok, true)
    readyUrls.set('gw-1', gw.origin.baseUrl)
    refresh.arm('gw-1')
    assert.equal(scheduled.length, 1, 'armed with a real expiry from the manager')
    // The delay is expiresAt − now() − LEAD, where expiresAt was captured by
    // the REAL manager at login time and now() is read at arm time: any real
    // clock elapsed between those two statements makes the delay shorter by
    // that amount. Assert the 12h-scale intent with a documented skew
    // tolerance instead of an exact value (a 1ms loaded-machine flake).
    const expectedDelay = GATEWAY_SESSION_TTL_MS - GATEWAY_SESSION_EXPIRY_SKEW_MS - GATEWAY_SESSION_REFRESH_LEAD_MS
    assert.ok(
      scheduled[0].delayMs <= expectedDelay && scheduled[0].delayMs >= expectedDelay - 1000,
      `the refresh fires ~60s before the cached session expires (delay ${scheduled[0].delayMs}, expected ${expectedDelay} minus the real-clock skew)`,
    )
    scheduled[0].fn()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(logins.length, 2, 'the setup login plus the pre-expiry refresh login')
    assert.deepEqual(registered, [{ url: gw.origin.baseUrl, headers: { cookie: COOKIE }, authority: undefined }], 'the transport is re-registered with the fresh real cookie')
    assert.equal(scheduled.length, 2, 'the fresh session re-arms the next refresh')
  } finally {
    refresh.dispose()
    mgr.dispose()
    await gw.close()
  }
})
