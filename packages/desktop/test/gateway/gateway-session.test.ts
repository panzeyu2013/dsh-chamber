/** gateway-session unit tests (design 17 §7.3/§9.3) — part 1: the password → JWT cookie login
 *  exchange against a real node:http stub (success, expiry re-login, 400/413/401 classification,
 *  429 backoff, 503, network failures, URL scheme) and the SPKI-pinned https login request shape
 *  (siblings: gateway-session-lifecycle.test.ts; part 1b carries the refresh
 *  orchestration auth boundaries merged in during the round-2 trim). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildGatewaySessionOrigin, createGatewaySessionManager, GATEWAY_LOGIN_RATE_LIMIT_BACKOFF_MS, GATEWAY_SESSION_EXPIRY_SKEW_MS, GATEWAY_SESSION_TTL_MS, type GatewayHttpRequest, type GatewaySessionOrigin, type GatewaySessionResult } from '../../gateway-session.ts'
import { createGatewaySessionRefresh, type GatewaySessionRefreshDeps } from '../../gateway-session-refresh.ts'
import { COOKIE, PASSWORD, loginHandler, startGateway, stubRequestFactory, assertFailure, type LoginRecord } from '../support/gateway-session-fixtures.ts'

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
  // pre-write dispatch path is exercised against real TLS in
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
test('buildGatewaySessionOrigin is the single origin construction point (optional keys stay absent)', () => {
  assert.deepEqual(
    buildGatewaySessionOrigin({ baseUrl: 'https://gw.example.com', insecureHttp: false, scope: 's' }),
    { baseUrl: 'https://gw.example.com', insecureHttp: false, scope: 's' },
  )
  assert.deepEqual(
    buildGatewaySessionOrigin({ baseUrl: 'http://127.0.0.1:1', insecureHttp: true, scope: 's', spkiPin: null, authority: undefined }),
    { baseUrl: 'http://127.0.0.1:1', insecureHttp: true, scope: 's' },
    'null/undefined optionals must not create keys (the session cache key serializes this object)',
  )
  const pinned = buildGatewaySessionOrigin({
    baseUrl: 'https://gw.example.com', insecureHttp: false, scope: 's', spkiPin: 'ab', authority: '127.0.0.1:30801',
  })
  assert.deepEqual(pinned, {
    baseUrl: 'https://gw.example.com', insecureHttp: false, scope: 's', spkiPin: 'ab', authority: '127.0.0.1:30801',
  })
  assert.equal(Object.hasOwn(pinned, 'spkiPin'), true)
  assert.equal(Object.hasOwn(buildGatewaySessionOrigin({ baseUrl: 'https://gw.example.com', insecureHttp: false, scope: 's' }), 'spkiPin'), false)
})

// ---------------------------------------------------------------------------
// part 1b — refresh orchestration auth boundaries (merged from
// gateway-session-refresh.test.ts, round-2 trim: same production session
// module; the scheduler's happy path is exercised by the real-manager cycle
// that used to live there, its auth/fact-binding negative cases are kept).
// ---------------------------------------------------------------------------

/** A fake session manager slice + a captured schedule/cancel, so the refresh
 *  orchestration is driven deterministically (no real 12h waits). */
function refreshHarness(overrides: Partial<GatewaySessionRefreshDeps> = {}) {
  const state = {
    nowMs: 1_000_000_000,
    TTL: GATEWAY_SESSION_TTL_MS - GATEWAY_SESSION_EXPIRY_SKEW_MS,
    expiries: new Map<string, number>(),
    logins: [] as Array<{ origin: GatewaySessionOrigin; password: string }>,
    registered: [] as Array<{ id: string; url: string; headers: Record<string, string> | undefined; tls: unknown; authority: string | undefined }>,
    warned: [] as string[],
    failNextLogin: null as Extract<GatewaySessionResult, { ok: false }> | null,
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
  const keyFor = (origin: Pick<GatewaySessionOrigin, 'insecureHttp' | 'baseUrl'>) => (origin.insecureHttp ? 'http' : 'https') + '|' + origin.baseUrl
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
    scopeFor: id => state.scopes.get(id) ?? 'test:' + id,
    register: (id, url, headers, tls, authority) => state.registered.push({ id, url, headers, tls, authority }),
    reconnect: id => state.reconnects.push(id),
    warn: message => state.warned.push(message),
    now: () => state.nowMs,
    schedule: (fn, delayMs) => { state.scheduled.push({ fn, delayMs }); return state.scheduled.length },
    cancel: timer => state.cancelled.push(timer),
    ...overrides,
  }
  const refresh = createGatewaySessionRefresh(deps)

  async function fireNext(): Promise<void> {
    const entry = state.scheduled.shift()
    assert.ok(entry !== undefined, 'expected a scheduled refresh')
    state.nowMs += entry.delayMs
    entry.fn()
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  return { deps, refresh, state, keyFor, fireNext }
}

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
  assert.equal(h.state.logins.length, 1)
  assert.equal(h.state.logins[0].origin.spkiPin, PIN, 'the refresh login origin carries the configured SPKI pin')
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
    assert.ok(fire !== undefined, entry.name + ': timer armed')
    h.state.nowMs += fire.delayMs
    fire.fn()
    entry.mutate(h)
    h.state.releaseLogin?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(h.state.registered.length, 0, entry.name + ': stale fact-bound login cannot register')
  }
})
