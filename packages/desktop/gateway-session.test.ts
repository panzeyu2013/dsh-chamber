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
  gatewayRegistrationAuthHeaders,
  GATEWAY_LOGIN_RATE_LIMIT_BACKOFF_MS,
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
  gatewayTunnelAuthority,
  GATEWAY_SESSION_REFRESH_LEAD_MS,
  type GatewaySessionRefreshDeps,
} from './gateway-session-refresh.ts'
import {
  configureGatewaySessionProvider,
  verifyGatewayPasswordSession,
} from './gateway-provider.ts'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZXNzaW9uIn0.signature'
const COOKIE = `${GATEWAY_SESSION_COOKIE_NAME}=${JWT}`
const PASSWORD = 'correct horse battery staple'
let gatewayScopeSequence = 0

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
    origin: { baseUrl: `http://127.0.0.1:${port}`, insecureHttp: true, scope: `test:gateway:${gatewayScopeSequence += 1}` },
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

/** Request factory whose responses are released explicitly by the test. */
function deferredLoginFactory(responders: Array<() => void>): GatewayHttpRequest {
  interface StubClientRequest {
    on(event: string, listener: (...args: unknown[]) => void): unknown
    end(): void
    destroy(): void
  }
  interface StubIncomingMessage {
    statusCode: number
    headers: Record<string, string | string[] | undefined>
    resume(): StubIncomingMessage
    on(event: string, listener: (...args: unknown[]) => void): unknown
  }
  return ((_: unknown, _options: unknown, cb: (res: StubIncomingMessage) => void) => {
    const req = new EventEmitter() as unknown as StubClientRequest
    req.end = () => {}
    req.destroy = () => {}
    responders.push(() => {
      const res = new EventEmitter() as unknown as StubIncomingMessage
      res.statusCode = 302
      res.headers = { 'set-cookie': [COOKIE] }
      res.resume = () => res
      cb(res)
    })
    return req
  }) as unknown as GatewayHttpRequest
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
  let nowMs = 1_000_000_000
  const mgr = createGatewaySessionManager({ now: () => nowMs })
  try {
    const expected: Array<[number, 'invalid_credentials' | 'rate_limited' | 'auth_busy']> = [
      [400, 'invalid_credentials'],
      [413, 'invalid_credentials'],
      [401, 'invalid_credentials'],
      [429, 'rate_limited'],
    ]
    for (const [status, code] of expected) {
      const result = await mgr.ensureSession(gw.origin, PASSWORD)
      assertFailure(result, code)
      assert.equal(mgr.cachedCookie(gw.origin), null, 'no failure status caches a cookie')
      assert.equal(result.error.includes(String(status)), true, 'the classified message names the status')
    }
    // The 429 armed a 5-minute courtesy backoff (design 17 §13.5) — advance
    // the clock past it so the 503 classification still reaches the network.
    nowMs += GATEWAY_LOGIN_RATE_LIMIT_BACKOFF_MS + 1000
    const last = await mgr.ensureSession(gw.origin, PASSWORD)
    assertFailure(last, 'auth_busy')
    assert.equal(last.error.includes('503'), true, 'the classified message names the status')
    assert.equal(statuses.length, 0, 'every status was consumed')
  } finally {
    mgr.dispose()
    await gw.close()
  }
})

test('a 429 login failure arms a bounded courtesy backoff that suppresses further login requests (design 17 §13.5)', async () => {
  let nowMs = 1_000_000_000
  let requests = 0
  const gw = await startGateway((_req, res) => {
    requests += 1
    res.writeHead(429)
    res.end()
  })
  const mgr = createGatewaySessionManager({ now: () => nowMs })
  try {
    const first = await mgr.ensureSession(gw.origin, PASSWORD)
    assertFailure(first, 'rate_limited')
    assert.equal(requests, 1)
    // Inside the backoff window the manager answers WITHOUT touching the
    // network — a reconnect loop must not hammer /auth/login with cheap 429s.
    const second = await mgr.ensureSession(gw.origin, PASSWORD)
    assertFailure(second, 'rate_limited')
    assert.equal(requests, 1, 'no request issued while the origin is throttled')
    assert.match(second.error, /backing off/)
    // After the window the manager tries the network again.
    nowMs += GATEWAY_LOGIN_RATE_LIMIT_BACKOFF_MS + 1000
    const third = await mgr.ensureSession(gw.origin, PASSWORD)
    assertFailure(third, 'rate_limited')
    assert.equal(requests, 2, 'the network is tried again after the backoff window')
    // A successful login clears the backoff.
    mgr.dispose()
  } finally {
    await gw.close()
  }
})

test('a successful login clears an armed 429 backoff', async () => {
  let nowMs = 1_000_000_000
  let failNext = true
  const gw = await startGateway((_req, res) => {
    if (failNext) {
      failNext = false
      res.writeHead(429)
      res.end()
      return
    }
    res.writeHead(302, { 'set-cookie': 'dsh_gateway_session=abc.def; Path=/; HttpOnly' })
    res.end()
  })
  const mgr = createGatewaySessionManager({ now: () => nowMs })
  try {
    assertFailure(await mgr.ensureSession(gw.origin, PASSWORD), 'rate_limited')
    const throttled = await mgr.ensureSession(gw.origin, PASSWORD)
    assertFailure(throttled, 'rate_limited')
    assert.match(throttled.error, /backing off/, 'the backoff window answers without a request')
    // Advance past the window; the login succeeds and clears the backoff.
    nowMs += GATEWAY_LOGIN_RATE_LIMIT_BACKOFF_MS + 1000
    const ok = await mgr.ensureSession(gw.origin, PASSWORD)
    assert.equal(ok.ok, true)
    assert.equal(mgr.cachedCookie(gw.origin)?.startsWith('dsh_gateway_session='), true)
    // A fresh failure after a success is a NEW network attempt (no stale
    // backoff): flip the server to 429 again and confirm the request is made.
    failNext = true
    nowMs += 1000
    assertFailure(await mgr.ensureSession(gw.origin, PASSWORD), 'rate_limited')
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
    const result = await mgr.ensureSession({ baseUrl: 'http://127.0.0.1:1', insecureHttp: true, scope: 'test:network' }, PASSWORD)
    assertFailure(result, 'network')
    assert.equal(mgr.cachedCookie({ baseUrl: 'http://127.0.0.1:1', insecureHttp: true, scope: 'test:network' }), null)
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
    const result = await httpsMgr.ensureSession({ baseUrl: 'https://gw.example.com:8443', insecureHttp: false, scope: 'test:https' }, PASSWORD)
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
  // This unit only inspects request options. The real certificate match and
  // pre-write dispatch path is exercised against real TLS below/in
  // gateway-provider.test.ts; emit a network failure so the fake socket need
  // not counterfeit a certificate.
  const factory = stubRequestFactory({ networkError: true })
  const wrapped = ((url: unknown, options: unknown, cb: unknown) => {
    seen.push({ url, options: (options ?? {}) as Record<string, unknown> })
    return (factory as unknown as (u: unknown, o: unknown, c: unknown) => unknown)(url, options, cb)
  }) as unknown as GatewayHttpRequest
  const mgr = createGatewaySessionManager({ request: wrapped })
  try {
    const origin: GatewaySessionOrigin = { baseUrl: 'https://gw.example.com:8443', insecureHttp: false, spkiPin: 'a'.repeat(64), scope: 'test:pin-a' }
    const result = await mgr.ensureSession(origin, PASSWORD)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'network')
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
    const origin: GatewaySessionOrigin = { baseUrl: 'https://gw.example.com:8443', insecureHttp: false, spkiPin: 'b'.repeat(64), scope: 'test:pin-b' }
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
    const origin: GatewaySessionOrigin = { baseUrl: 'http://gw.example.com:8080', insecureHttp: true, spkiPin: 'a'.repeat(64), scope: 'test:http-pin' }
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

test('delete → recreate same id/origin invalidation never reuses the old cookie and logs in with the new password', async () => {
  const logins: LoginRecord[] = []
  const gw = await startGateway(loginHandler(logins))
  const mgr = createGatewaySessionManager()
  try {
    assert.equal((await mgr.ensureSession(gw.origin, PASSWORD)).ok, true)
    assert.equal(mgr.cachedCookie(gw.origin), COOKIE)
    mgr.invalidate(gw.origin)
    assert.equal(mgr.cachedCookie(gw.origin), null, 'invalidate removes the session')
    const newPassword = 'new correct horse battery staple'
    assert.equal((await mgr.ensureSession(gw.origin, newPassword)).ok, true)
    assert.equal(logins.length, 2, 'recreated connection forces a fresh login instead of reusing the deleted cookie')
    assert.deepEqual(logins.map(entry => JSON.parse(entry.body).password), [PASSWORD, newPassword])
  } finally {
    mgr.dispose()
    await gw.close()
  }
})

test('invalidateScope clears every historical tunnel local-port generation for one exact target', async () => {
  const mgr = createGatewaySessionManager({ request: stubRequestFactory() })
  const authority = gatewayTunnelAuthority(30801)
  const scope = 'v1:target-a:' + 'a'.repeat(64)
  const l1 = { baseUrl: 'http://127.0.0.1:40001', insecureHttp: true, authority, scope }
  const l2 = { baseUrl: 'http://127.0.0.1:40002', insecureHttp: true, authority, scope }
  const proofOnly = { baseUrl: 'http://127.0.0.1:40003', insecureHttp: true, authority, scope }
  const unrelated = { ...l1, authority: gatewayTunnelAuthority(30802), scope: 'v1:target-b:' + 'b'.repeat(64) }
  try {
    assert.equal((await mgr.ensureSession(l1, PASSWORD)).ok, true)
    assert.equal((await mgr.ensureSession(l2, PASSWORD)).ok, true)
    assert.equal((await mgr.ensureSession(unrelated, PASSWORD)).ok, true)
    assert.notEqual(mgr.cachedCookie(l1), null)
    assert.notEqual(mgr.cachedCookie(l2), null)
    mgr.setRegistrationAuthProof(l2, 'cookie')
    mgr.setRegistrationAuthProof(proofOnly, 'bearer')
    mgr.invalidateScope(scope)
    assert.equal(mgr.cachedCookie(l1), null, 'deleted connection local port L1 is gone')
    assert.equal(mgr.cachedCookie(l2), null, 'recreated connection local port L2 is gone too')
    assert.equal(mgr.registrationAuthProof(l2), null, 'scope cleanup also removes an exact registration proof')
    assert.equal(mgr.registrationAuthProof(proofOnly), null, 'a proof-only key is included in scope cleanup')
    assert.notEqual(mgr.cachedCookie(unrelated), null, 'another connection scope is isolated')
    assert.throws(() => mgr.invalidateScope('bad/path'), /scope/)
  } finally {
    mgr.dispose()
  }
})

test('scope invalidation makes an old in-flight login unable to repopulate a recreated tunnel generation', async () => {
  const responders: Array<() => void> = []
  const mgr = createGatewaySessionManager({ request: deferredLoginFactory(responders) })
  const authority = gatewayTunnelAuthority(30801)
  const scope = 'v1:target-old:' + 'c'.repeat(64)
  const oldOrigin = { baseUrl: 'http://127.0.0.1:41001', insecureHttp: true, authority, scope }
  const recreatedOrigin = { baseUrl: 'http://127.0.0.1:41002', insecureHttp: true, authority, scope }
  try {
    const oldLogin = mgr.ensureSession(oldOrigin, PASSWORD)
    assert.equal(responders.length, 1)
    mgr.invalidateScope(scope)
    responders.shift()!()
    const oldResult = await oldLogin
    assertFailure(oldResult, 'stale')
    assert.equal(mgr.cachedCookie(oldOrigin), null, 'its late cookie cannot repopulate deleted generation L1')

    const recreatedLogin = mgr.ensureSession(recreatedOrigin, 'new generation password')
    assert.equal(responders.length, 1, 'L2 performs its own login')
    responders.shift()!()
    assert.equal((await recreatedLogin).ok, true)
    assert.equal(mgr.cachedCookie(recreatedOrigin), COOKIE, 'only the recreated L2 generation may cache its cookie')
  } finally {
    mgr.dispose()
  }
})

test('scoped tunnel sessions isolate local-port reuse and exact cleanup across SSH targets sharing one authority', async () => {
  const responders: Array<() => void> = []
  const mgr = createGatewaySessionManager({ request: deferredLoginFactory(responders) })
  const authority = gatewayTunnelAuthority(30801)
  const baseUrl = 'http://127.0.0.1:42001'
  const scopeA = 'v1:connection-a:' + 'd'.repeat(64)
  const scopeB = 'v1:connection-b:' + 'e'.repeat(64)
  const a = { baseUrl, insecureHttp: true, authority, scope: scopeA }
  const b = { baseUrl, insecureHttp: true, authority, scope: scopeB }
  try {
    const loginA = mgr.ensureSession(a, PASSWORD)
    responders.shift()!()
    assert.equal((await loginA).ok, true)
    assert.equal(mgr.cachedCookie(a), COOKIE)
    assert.equal(mgr.cachedCookie(b), null, 'same local port/authority cannot expose A cookie to B scope')

    const loginB = mgr.ensureSession(b, 'password for B target')
    assert.equal(responders.length, 1, 'B must perform its own login after local-port reuse')
    mgr.invalidateScope(scopeA)
    responders.shift()!()
    assert.equal((await loginB).ok, true, 'exact A cleanup cannot stale B in-flight login')
    assert.equal(mgr.cachedCookie(a), null)
    assert.equal(mgr.cachedCookie(b), COOKIE, 'B cookie remains cached under its own target scope')
  } finally {
    mgr.dispose()
  }
})

test('direct sessions at one network origin remain per-connection and exact invalidation does not clear peers', async () => {
  const responders: Array<() => void> = []
  const mgr = createGatewaySessionManager({ request: deferredLoginFactory(responders) })
  const baseUrl = 'https://gateway.example.com'
  const scopeA = 'v1:direct-a:' + '1'.repeat(64)
  const scopeB = 'v1:direct-b:' + '2'.repeat(64)
  const a = { baseUrl, insecureHttp: false, scope: scopeA }
  const b = { baseUrl, insecureHttp: false, scope: scopeB }
  try {
    const loginA = mgr.ensureSession(a, PASSWORD)
    responders.shift()!()
    assert.equal((await loginA).ok, true)
    assert.equal(mgr.cachedCookie(b), null, 'B cannot reuse A cookie at the same direct origin')
    const loginB = mgr.ensureSession(b, 'different B password')
    responders.shift()!()
    assert.equal((await loginB).ok, true)
    mgr.invalidateScope(scopeA)
    assert.equal(mgr.cachedCookie(a), null)
    assert.equal(mgr.cachedCookie(b), COOKIE, 'clearing A does not clear B at the same origin')
  } finally {
    mgr.dispose()
  }
})

test('ready registration auth fails closed only for password-only missing-cookie and preserves bearer fallback', () => {
  assert.deepEqual(gatewayRegistrationAuthHeaders(null, true, null, null), {
    ok: false,
    reason: 'password_session_missing',
  })
  assert.deepEqual(gatewayRegistrationAuthHeaders('token', true, null, 'bearer'), {
    ok: true,
    headers: { authorization: 'Bearer token' },
  }, 'token+password may intentionally register the verified bearer fallback')
  assert.deepEqual(gatewayRegistrationAuthHeaders(null, true, COOKIE, 'cookie'), {
    ok: true,
    headers: { cookie: COOKIE },
  })
  assert.deepEqual(gatewayRegistrationAuthHeaders('token', true, COOKIE, 'cookie'), {
    ok: true,
    headers: { authorization: 'Bearer token', cookie: COOKIE },
  })
  assert.equal(gatewayRegistrationAuthHeaders('unproven-token', true, null, null).ok, false, 'token existence alone is not fallback evidence')
  assert.equal(gatewayRegistrationAuthHeaders('invalid-token', true, null, 'cookie').ok, false, 'a vanished cookie proof cannot silently downgrade to bearer')
})

test('invalidation of a held login returns stale and prevents cookie probe, bearer fallback, and re-login', async () => {
  const responders: Array<() => void> = []
  const mgr = createGatewaySessionManager({ request: deferredLoginFactory(responders) })
  const origin = { baseUrl: 'http://gateway.example.com:30801', insecureHttp: true, scope: 'test:held-login' }
  let probes = 0
  let bearerFallbacks = 0
  configureGatewaySessionProvider({
    ensureSession: (target, password) => mgr.ensureSession(target, password),
    generation: target => mgr.generation(target),
    registrationAuthProof: target => mgr.registrationAuthProof(target),
    setRegistrationAuthProof: (target, proof) => mgr.setRegistrationAuthProof(target, proof),
    cachedCookie: target => mgr.cachedCookie(target),
    invalidate: target => mgr.invalidate(target),
  })
  try {
    const verification = verifyGatewayPasswordSession(
      origin,
      PASSWORD,
      async () => { probes += 1; return { ok: false, statusCode: 401 } },
      async () => { bearerFallbacks += 1; return { ok: true } },
    )
    assert.equal(responders.length, 1, 'one old-generation password login is held')
    mgr.invalidate(origin)
    responders.shift()!()
    const result = await verification
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.detail ?? '', /superseded/)
    assert.equal(probes, 0, 'the invalidated cookie is never sent to the target')
    assert.equal(bearerFallbacks, 0, 'stale is not a password failure and cannot send the captured bearer')
    assert.equal(responders.length, 0, 'the old verifier cannot initiate a second login')
    assert.equal(mgr.cachedCookie(origin), null, 'no stale cookie reaches cache')
  } finally {
    configureGatewaySessionProvider({})
    mgr.dispose()
  }
})

test('scope invalidation during a held bearer fallback supersedes the old captured token proof', async () => {
  const mgr = createGatewaySessionManager({ request: stubRequestFactory({ status: 401, setCookie: null }) })
  const origin = { baseUrl: 'http://gateway.example.com:30804', insecureHttp: true, scope: 'test:held-fallback' }
  configureGatewaySessionProvider({
    ensureSession: (target, password) => mgr.ensureSession(target, password),
    generation: target => mgr.generation(target),
    registrationAuthProof: target => mgr.registrationAuthProof(target),
    setRegistrationAuthProof: (target, proof) => mgr.setRegistrationAuthProof(target, proof),
    cachedCookie: target => mgr.cachedCookie(target),
    invalidate: target => mgr.invalidate(target),
  })
  try {
    let markFallbackStarted!: () => void
    const fallbackStarted = new Promise<void>(resolve => { markFallbackStarted = resolve })
    let finishFallback!: (result: { ok: true }) => void
    const fallbackGate = new Promise<{ ok: true }>(resolve => { finishFallback = resolve })
    const verification = verifyGatewayPasswordSession(
      origin,
      PASSWORD,
      async () => assert.fail('a refused login must not run the cookie probe'),
      async () => { markFallbackStarted(); return fallbackGate },
    )
    await fallbackStarted
    mgr.invalidateScope(origin.scope)
    finishFallback({ ok: true })
    const result = await verification
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.detail ?? '', /superseded/)
  } finally {
    configureGatewaySessionProvider({})
    mgr.dispose()
  }
})

test('external invalidation while the first cookie probe is pending prevents a 401 re-login', async () => {
  const responders: Array<() => void> = []
  const mgr = createGatewaySessionManager({ request: deferredLoginFactory(responders) })
  const origin = { baseUrl: 'http://gateway.example.com:30802', insecureHttp: true, scope: 'test:pending-probe' }
  configureGatewaySessionProvider({
    ensureSession: (target, password) => mgr.ensureSession(target, password),
    generation: target => mgr.generation(target),
    registrationAuthProof: target => mgr.registrationAuthProof(target),
    setRegistrationAuthProof: (target, proof) => mgr.setRegistrationAuthProof(target, proof),
    cachedCookie: target => mgr.cachedCookie(target),
    invalidate: target => mgr.invalidate(target),
  })
  try {
    const initial = mgr.ensureSession(origin, PASSWORD)
    responders.shift()!()
    assert.equal((await initial).ok, true)

    let finishProbe!: (result: { ok: false; statusCode: number }) => void
    const probeGate = new Promise<{ ok: false; statusCode: number }>(resolve => { finishProbe = resolve })
    let probes = 0
    const verification = verifyGatewayPasswordSession(origin, PASSWORD, async () => {
      probes += 1
      return probeGate
    })
    assert.equal(probes, 1)
    mgr.invalidate(origin)
    finishProbe({ ok: false, statusCode: 401 })
    const result = await verification
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.detail ?? '', /superseded/)
    assert.equal(responders.length, 0, 'the old 401 cannot trigger a new password exchange')
    assert.equal(mgr.cachedCookie(origin), null)
  } finally {
    configureGatewaySessionProvider({})
    mgr.dispose()
  }
})

test('a successful cookie probe is not accepted after its scoped cache proof was invalidated', async () => {
  const responders: Array<() => void> = []
  const mgr = createGatewaySessionManager({ request: deferredLoginFactory(responders) })
  const origin = { baseUrl: 'http://gateway.example.com:30803', insecureHttp: true, scope: 'v1:proof:' + '9'.repeat(64) }
  configureGatewaySessionProvider({
    ensureSession: (target, password) => mgr.ensureSession(target, password),
    generation: target => mgr.generation(target),
    registrationAuthProof: target => mgr.registrationAuthProof(target),
    setRegistrationAuthProof: (target, proof) => mgr.setRegistrationAuthProof(target, proof),
    cachedCookie: target => mgr.cachedCookie(target),
    invalidate: target => mgr.invalidate(target),
  })
  try {
    const initial = mgr.ensureSession(origin, PASSWORD)
    responders.shift()!()
    assert.equal((await initial).ok, true)

    let finishProbe!: (result: { ok: true }) => void
    const probeGate = new Promise<{ ok: true }>(resolve => { finishProbe = resolve })
    const verification = verifyGatewayPasswordSession(origin, PASSWORD, async () => probeGate)
    mgr.invalidateScope(origin.scope)
    finishProbe({ ok: true })
    const result = await verification
    assert.equal(result.ok, false, 'ready proof is bound to the still-cached scoped cookie')
    if (!result.ok) assert.match(result.detail ?? '', /superseded/)
  } finally {
    configureGatewaySessionProvider({})
    mgr.dispose()
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
    mgr.setRegistrationAuthProof(gw.origin, 'cookie')
    mgr.dispose()
    assert.equal(mgr.cachedCookie(gw.origin), null)
    assert.equal(mgr.registrationAuthProof(gw.origin), null)
  } finally {
    await gw.close()
  }
})

test('a structurally invalid origin is refused with a TypeError (mirrors instance-proxy baseUrl gate)', () => {
  const mgr = createGatewaySessionManager()
  try {
    const scope = 'test:invalid'
    assert.throws(() => mgr.ensureSession({ baseUrl: 'https://gw.example.com', insecureHttp: true, scope }, PASSWORD), /does not match/)
    assert.throws(() => mgr.ensureSession({ baseUrl: 'http://gw.example.com', insecureHttp: false, scope }, PASSWORD), /does not match/)
    assert.throws(() => mgr.ensureSession({ baseUrl: 'ftp://gw.example.com', insecureHttp: false, scope }, PASSWORD), /http\(s\) origin/)
    assert.throws(() => mgr.ensureSession({ baseUrl: 'https://user:pass@gw.example.com', insecureHttp: false, scope }, PASSWORD), /no credentials/)
    assert.throws(() => mgr.ensureSession({ baseUrl: 'https://gw.example.com/path', insecureHttp: false, scope }, PASSWORD), /no credentials/)
    assert.throws(() => mgr.ensureSession({ baseUrl: 'not a url', insecureHttp: false, scope }, PASSWORD), /invalid gateway baseUrl/)
    assert.throws(() => mgr.cachedCookie({ baseUrl: 'https://gw.example.com', insecureHttp: true, scope }), /does not match/)
    assert.throws(() => mgr.cachedCookie({ baseUrl: 'https://gw.example.com', insecureHttp: false, scope: 'bad/path' }), /scope/)
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
  const DIRECT_SCOPE = 'v1:direct:' + 'd'.repeat(64)
  assert.deepEqual(
    gatewaySessionOriginForUrl('http://127.0.0.1:40000', undefined, undefined, DIRECT_SCOPE),
    { baseUrl: 'http://127.0.0.1:40000', insecureHttp: true, scope: DIRECT_SCOPE },
    'an ssh tunnel endpoint is a loopback http origin (insecureHttp = scheme selector, not a judgement)',
  )
  assert.deepEqual(
    gatewaySessionOriginForUrl('https://gw.example.com:8443', undefined, undefined, DIRECT_SCOPE),
    { baseUrl: 'https://gw.example.com:8443', insecureHttp: false, scope: DIRECT_SCOPE },
    'an https direct endpoint keeps insecureHttp false',
  )
  assert.deepEqual(
    gatewaySessionOriginForUrl('http://gw.example.com:8080', undefined, undefined, DIRECT_SCOPE),
    { baseUrl: 'http://gw.example.com:8080', insecureHttp: true, scope: DIRECT_SCOPE },
    'an http direct endpoint (explicit insecureHttp) is http',
  )
  // P1-2: a configured SPKI pin rides the derived origin so the refresh login
  // is pinned exactly like the verifyUp login.
  const PIN = 'c'.repeat(64)
  assert.deepEqual(
    gatewaySessionOriginForUrl('https://gw.example.com:8443', PIN, undefined, DIRECT_SCOPE),
    { baseUrl: 'https://gw.example.com:8443', insecureHttp: false, spkiPin: PIN, scope: DIRECT_SCOPE },
    'the pin rides the https origin for the pinned refresh login',
  )
  const TUNNEL_SCOPE = 'v1:gw-1:' + 'f'.repeat(64)
  assert.deepEqual(
    gatewaySessionOriginForUrl('http://127.0.0.1:40000', undefined, gatewayTunnelAuthority(30801), TUNNEL_SCOPE),
    { baseUrl: 'http://127.0.0.1:40000', insecureHttp: true, authority: '127.0.0.1:30801', scope: TUNNEL_SCOPE },
    'an ssh tunnel session carries the remote Host authority plus its exact connection scope',
  )
  assert.equal(gatewaySessionOriginForUrl('http://127.0.0.1:40000', undefined, gatewayTunnelAuthority(30801)), null, 'an unscoped tunnel origin fails closed')
  assert.equal(gatewaySessionOriginForUrl('https://gw.example.com:8443'), null, 'an unscoped direct origin also fails closed')
  assert.throws(() => gatewayTunnelAuthority(0), /1\.\.65535/)
  assert.equal(gatewaySessionOriginForUrl('ftp://gw.example.com', undefined, undefined, DIRECT_SCOPE), null, 'a non-http(s) scheme is refused')
  assert.equal(gatewaySessionOriginForUrl('http://user:pass@127.0.0.1:1', undefined, undefined, DIRECT_SCOPE), null, 'credentials are refused')
  assert.equal(gatewaySessionOriginForUrl('http://127.0.0.1:1/path', undefined, undefined, DIRECT_SCOPE), null, 'a path is refused')
  assert.equal(gatewaySessionOriginForUrl('not a url', undefined, undefined, DIRECT_SCOPE), null, 'an unparsable URL is refused')
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
    scopes: new Map<string, string>(),
  }
  const keyFor = (origin: Pick<GatewaySessionOrigin, 'insecureHttp' | 'baseUrl'>) => `${origin.insecureHttp ? 'http' : 'https'}|${origin.baseUrl}`
  const deps: GatewaySessionRefreshDeps = {
    sessionManager: {
      ensureSession: (origin, password) => {
        state.logins.push({ origin, password })
        let result: GatewaySessionResult
        if (state.failNextLogin !== null) {
          result = state.failNextLogin
          state.failNextLogin = null
        } else {
          state.expiries.set(keyFor(origin), state.nowMs + state.TTL)
          result = { ok: true, cookie: COOKIE }
        }
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
    scopeFor: id => state.scopes.get(id) ?? `test:${id}`,
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

test('session refresh: arm schedules the re-login at expiresAt − 60s lead, including when a token coexists (design 17 §9.3)', () => {
  const h = refreshHarness()
  h.state.readyUrls.set('gw-1', 'http://127.0.0.1:40000')
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.tokens.set('gw-1', 'x'.repeat(32))
  h.state.expiries.set(h.keyFor({ baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }), h.state.nowMs + h.state.TTL)
  h.refresh.arm('gw-1')
  assert.equal(h.state.scheduled.length, 1)
  assert.equal(
    h.state.scheduled[0].delayMs,
    h.state.TTL - GATEWAY_SESSION_REFRESH_LEAD_MS,
    'the refresh fires 60s before the cached session expires',
  )
  // Token + password is NOT a no-op: both auth principals coexist and the
  // cookie still needs refresh.
  h.state.tokens.set('gw-2', 'x'.repeat(32))
  h.state.passwords.set('gw-2', PASSWORD)
  h.state.readyUrls.set('gw-2', 'http://127.0.0.1:40003')
  h.state.expiries.set(h.keyFor({ baseUrl: 'http://127.0.0.1:40003', insecureHttp: true }), h.state.nowMs + h.state.TTL)
  h.refresh.arm('gw-2')
  assert.equal(h.state.scheduled.length, 2, 'a bearer never shadows the independent password session')
  // No-ops: a no-password target, a not-ready target and a target without a
  // cached session never schedule.
  h.state.readyUrls.set('gw-3', 'http://127.0.0.1:40001')
  h.refresh.arm('gw-3') // no password
  h.state.passwords.set('gw-4', PASSWORD)
  h.refresh.arm('gw-4') // not ready
  h.state.readyUrls.set('gw-5', 'http://127.0.0.1:40002')
  h.state.passwords.set('gw-5', PASSWORD)
  h.refresh.arm('gw-5') // no cached session → expiresAt null
  assert.equal(h.state.scheduled.length, 2, 'only the two armed-with-session cases schedule')
})

test('session refresh: the fired refresh re-logs in with the stored password, re-registers the fresh Cookie, and re-arms for the new expiry (design 17 §9.3)', async () => {
  const h = refreshHarness()
  h.state.readyUrls.set('gw-1', 'http://127.0.0.1:40000')
  h.state.passwords.set('gw-1', PASSWORD)
  h.state.tokens.set('gw-1', 'x'.repeat(32))
  h.state.expiries.set(h.keyFor({ baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }), h.state.nowMs + h.state.TTL)
  h.refresh.arm('gw-1')
  await h.fireNext()
  assert.equal(h.state.logins.length, 1, 'the refresh performs exactly one login')
  assert.equal(h.state.logins[0].password, PASSWORD, 'the STORED password is re-exchanged')
  assert.equal(h.state.logins[0].origin.baseUrl, 'http://127.0.0.1:40000', 'the login targets the tunnel origin')
  assert.equal(h.state.registered.length, 1)
  assert.deepEqual(h.state.registered[0], {
    id: 'gw-1', url: 'http://127.0.0.1:40000', headers: { authorization: `Bearer ${'x'.repeat(32)}`, cookie: COOKIE }, tls: undefined, authority: undefined,
  }, 'the transport is re-registered with the fresh Cookie and preserves the independent Bearer')
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
  h.state.expiries.set(h.keyFor({ baseUrl: 'http://127.0.0.1:40011', insecureHttp: true }), h.state.nowMs + h.state.TTL)
  h.refresh.arm('gw-1') // the fresh ready handler owns/bump-generates L2
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(h.state.warned.length, 0, 'a stale generation cannot report a failure against the fresh connection')
  assert.equal(h.state.reconnects.length, 0, 'no recovery reconnect — the fresh ready already re-authenticated')
  assert.equal(h.state.scheduled.length, 1, 'only the fresh ready generation remains armed')
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
  h.refresh.disarm('gw-1')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(h.state.warned.length, 0, 'a disarmed generation cannot report a stale failure')
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

test('session refresh: delete/recreate at the same direct URL makes an old held success unable to register', async () => {
  const h = refreshHarness()
  const id = 'gw-same'
  const origin = { baseUrl: 'https://gw.example.com:8443', insecureHttp: false }
  h.state.readyUrls.set(id, origin.baseUrl)
  h.state.passwords.set(id, PASSWORD)
  h.state.expiries.set(h.keyFor(origin), h.state.nowMs + h.state.TTL)
  h.state.holdLogins = true
  h.refresh.arm(id)
  const oldFire = h.state.scheduled.shift()
  assert.ok(oldFire !== undefined)
  h.state.nowMs += oldFire.delayMs
  oldFire.fn()
  assert.equal(typeof h.state.releaseLogin, 'function')

  // Delete/clear then recreate with byte-identical visible facts. URL/fact
  // equality cannot distinguish this; only the disarm+arm epoch can.
  h.refresh.disarm(id)
  h.state.readyUrls.delete(id)
  h.state.passwords.delete(id)
  h.state.readyUrls.set(id, origin.baseUrl)
  h.state.passwords.set(id, PASSWORD)
  h.state.expiries.set(h.keyFor(origin), h.state.nowMs + h.state.TTL)
  h.refresh.arm(id)
  h.state.releaseLogin?.()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(h.state.registered.length, 0, 'the deleted generation cookie never registers on the recreated id')
  assert.equal(h.state.scheduled.length, 1, 'only the recreated generation timer remains')
})

test('session refresh: delete/recreate at the same direct URL makes an old held failure unable to reconnect', async () => {
  const h = refreshHarness()
  const id = 'gw-same'
  const origin = { baseUrl: 'https://gw.example.com:8443', insecureHttp: false }
  h.state.readyUrls.set(id, origin.baseUrl)
  h.state.passwords.set(id, PASSWORD)
  h.state.expiries.set(h.keyFor(origin), h.state.nowMs + h.state.TTL)
  h.state.failNextLogin = { ok: false, code: 'network', error: 'held old-generation network failure' }
  h.state.holdLogins = true
  h.refresh.arm(id)
  const oldFire = h.state.scheduled.shift()
  assert.ok(oldFire !== undefined)
  h.state.nowMs += oldFire.delayMs
  oldFire.fn()
  assert.equal(typeof h.state.releaseLogin, 'function')

  h.refresh.disarm(id)
  h.state.expiries.delete(h.keyFor(origin))
  h.state.readyUrls.set(id, origin.baseUrl)
  h.state.passwords.set(id, PASSWORD)
  h.state.expiries.set(h.keyFor(origin), h.state.nowMs + h.state.TTL)
  h.refresh.arm(id)
  h.state.releaseLogin?.()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(h.state.warned.length, 0, 'the old failure cannot warn against the recreated generation')
  assert.equal(h.state.reconnects.length, 0, 'the old failure cannot reconnect the recreated generation')
  assert.equal(h.state.scheduled.length, 1)
})

test('session refresh: in-flight result is bound to password, token, SPKI pin, tunnel authority, and exact target scope facts', async () => {
  const cases: Array<{ name: string; seed(h: ReturnType<typeof refreshHarness>): void; mutate(h: ReturnType<typeof refreshHarness>): void }> = [
    { name: 'password', seed: () => {}, mutate: h => { h.state.passwords.set('gw-facts', 'replacement password value') } },
    { name: 'token', seed: h => { h.state.tokens.set('gw-facts', 'x'.repeat(32)) }, mutate: h => { h.state.tokens.set('gw-facts', 'y'.repeat(32)) } },
    { name: 'SPKI pin', seed: h => { h.state.pins.set('gw-facts', 'a'.repeat(64)) }, mutate: h => { h.state.pins.set('gw-facts', 'b'.repeat(64)) } },
    { name: 'authority', seed: h => { h.state.authorities.set('gw-facts', '127.0.0.1:30801') }, mutate: h => { h.state.authorities.set('gw-facts', '127.0.0.1:30802') } },
    { name: 'target scope', seed: h => { h.state.scopes.set('gw-facts', 'v1:gw-facts:' + 'a'.repeat(64)) }, mutate: h => { h.state.scopes.set('gw-facts', 'v1:gw-facts:' + 'b'.repeat(64)) } },
  ]
  for (const entry of cases) {
    const h = refreshHarness()
    const origin = { baseUrl: 'http://127.0.0.1:40000', insecureHttp: true }
    h.state.readyUrls.set('gw-facts', origin.baseUrl)
    h.state.passwords.set('gw-facts', PASSWORD)
    entry.seed(h)
    h.state.expiries.set(h.keyFor(origin), h.state.nowMs + h.state.TTL)
    h.state.holdLogins = true
    h.refresh.arm('gw-facts')
    const fire = h.state.scheduled.shift()
    assert.ok(fire !== undefined, `${entry.name}: timer armed`)
    h.state.nowMs += fire.delayMs
    fire.fn()
    entry.mutate(h)
    h.state.releaseLogin?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(h.state.registered.length, 0, `${entry.name}: stale fact-bound login cannot register`)
  }
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
  h.refresh.arm('gw-1') // the new ready status owns its own epoch/timer
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
    scopeFor: () => 'test:gw-1',
    register: (_id, url, headers, _tls, authority) => registered.push({ url, headers, authority }),
    reconnect: () => assert.fail('the happy path never needs the recovery reconnect'),
    warn: () => assert.fail('no warning expected on the happy path'),
    schedule: (fn, delayMs) => { scheduled.push({ fn, delayMs }); return scheduled.length },
    cancel: () => {},
  })
  try {
    // Establish the session first (the real flow mints it in verifyUp BEFORE
    // the ready registration arms the refresh).
    assert.equal((await mgr.ensureSession({ ...gw.origin, scope: 'test:gw-1' }, PASSWORD)).ok, true)
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
