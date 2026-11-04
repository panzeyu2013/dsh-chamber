/** gateway-session — part 2: cookie parsing among multiple set-cookie headers, per-origin session
 *  isolation, invalidate/invalidateScope races, held logins and fallbacks, dispose and expiresAt
 *  (siblings: gateway-session.test.ts, whose part 1b carries the folded-in refresh suite; shared fixtures in support). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createGatewaySessionManager, gatewayRegistrationAuthHeaders, gatewaySessionKeyFor, GATEWAY_SESSION_EXPIRY_SKEW_MS, GATEWAY_SESSION_TTL_MS, type GatewayHttpRequest } from '../../gateway-session.ts'
import { gatewayTunnelAuthority } from '../../gateway-session-refresh.ts'
import {
  configureGatewaySessionProvider,
  verifyGatewayPasswordSession,
} from '../../gateway-provider.ts'
import { COOKIE, PASSWORD, bindSessionManager, loginHandler, startGateway, stubRequestFactory, assertFailure, type LoginRecord } from '../support/gateway-session-fixtures.ts'

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
  // The suffix must match EXACTLY: a scope that merely starts with the invalidated
  // one is a different target and must survive.
  const prefixNeighbor = { ...l1, scope: scope + '-x' }
  const unrelated = { ...l1, authority: gatewayTunnelAuthority(30802), scope: 'v1:target-b:' + 'b'.repeat(64) }
  try {
    assert.equal((await mgr.ensureSession(l1, PASSWORD)).ok, true)
    assert.equal((await mgr.ensureSession(prefixNeighbor, PASSWORD)).ok, true)
    assert.equal((await mgr.ensureSession(unrelated, PASSWORD)).ok, true)
    assert.equal(mgr.cachedCookie(l1), COOKIE)
    // P2-3: one session key covers every local-port generation of the same target, so
    // a reconnected tunnel's fresh port reads the very same cookie entry.
    assert.equal(mgr.cachedCookie(l2), COOKIE, 'the reconnected local port L2 reuses the L1 session')
    mgr.setRegistrationAuthProof(l2, 'cookie')
    mgr.setRegistrationAuthProof(proofOnly, 'bearer')
    mgr.invalidateScope(scope)
    assert.equal(mgr.cachedCookie(l1), null, 'deleted connection local port L1 is gone')
    assert.equal(mgr.cachedCookie(l2), null, 'recreated connection local port L2 is gone too')
    assert.equal(mgr.registrationAuthProof(l2), null, 'scope cleanup also removes an exact registration proof')
    assert.equal(mgr.registrationAuthProof(proofOnly), null, 'a proof-only key is included in scope cleanup')
    assert.equal(mgr.cachedCookie(prefixNeighbor), COOKIE, 'the suffix match is exact, never a prefix match')
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
  bindSessionManager(mgr)
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
  bindSessionManager(mgr)
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
  bindSessionManager(mgr)
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
  bindSessionManager(mgr)
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

test('a tunnel reconnect on the same SSH target reuses the session across the new local port (no second login)', async () => {
  // An ssh -L reconnect allocates a NEW loopback port for the SAME gateway target. The
  // session identity is the connection/target scope (+ scheme/authority), never the
  // network origin, so verifyUp's fast path must find the cookie instead of logging in.
  const logins: LoginRecord[] = []
  const gw = await startGateway(loginHandler(logins))
  const mgr = createGatewaySessionManager()
  const authority = gatewayTunnelAuthority(30801)
  const scope = 'v1:reconnect:' + '7'.repeat(64)
  const first = { ...gw.origin, authority, scope }
  // The reconnected tunnel's new local port; deliberately unreachable: a cache miss
  // would try to log in against it and fail instead of silently succeeding.
  const reconnected = { baseUrl: 'http://127.0.0.1:9', insecureHttp: true, authority, scope }
  const resetProvider = bindSessionManager(mgr)
  try {
    assert.equal((await mgr.ensureSession(first, PASSWORD)).ok, true)
    assert.equal(logins.length, 1)
    assert.equal(mgr.cachedCookie(reconnected), COOKIE, 'the new local port finds the same scoped session')
    let probedCookie: string | null = null
    const verification = await verifyGatewayPasswordSession(reconnected, PASSWORD, async cookie => {
      probedCookie = cookie
      return { ok: true }
    })
    assert.equal(verification.ok, true)
    assert.equal(probedCookie, COOKIE, 'the verify probe rides the cached cookie')
    assert.equal(logins.length, 1, 'the reconnect must not log in again')
    assert.equal(mgr.registrationAuthProof(reconnected), 'cookie', 'the reused session proves cookie auth for registration')
  } finally {
    resetProvider()
    mgr.dispose()
    await gw.close()
  }
})

test('different SSH targets sharing one tunnel authority never share a session (design 05 §8 negative control)', async () => {
  const logins: LoginRecord[] = []
  const gw = await startGateway(loginHandler(logins))
  const mgr = createGatewaySessionManager()
  const authority = gatewayTunnelAuthority(30801)
  const targetA = { ...gw.origin, authority, scope: 'v1:target-a:' + 'a'.repeat(64) }
  const targetB = { ...gw.origin, authority, scope: 'v1:target-b:' + 'b'.repeat(64) }
  try {
    assert.equal((await mgr.ensureSession(targetA, PASSWORD)).ok, true)
    assert.equal(mgr.cachedCookie(targetB), null, 'the authority is routing, not ownership: B cannot read A')
    assert.equal((await mgr.ensureSession(targetB, 'password for B target')).ok, true)
    assert.equal(logins.length, 2, 'B performs its own login')
    assert.notEqual(mgr.cachedCookie(targetA), null)
  } finally {
    mgr.dispose()
    await gw.close()
  }
})

test('the session-key constructor is stable across tunnel ports and qualified by scheme/authority/scope', () => {
  const scope = 'v1:key:' + '0'.repeat(64)
  const origin = { baseUrl: 'http://127.0.0.1:40001', insecureHttp: true, authority: '127.0.0.1:30801', scope }
  const key = gatewaySessionKeyFor(origin, 'http:')
  assert.equal(gatewaySessionKeyFor({ ...origin, baseUrl: 'http://127.0.0.1:40002' }, 'http:'), key, 'the local port is transport detail, not identity')
  assert.ok(key.endsWith('|scope:' + scope), 'invalidateScope still matches the exact scope suffix')
  assert.notEqual(gatewaySessionKeyFor({ ...origin, scope: scope + '-x' }, 'http:'), key, 'a different scope is a different session')
  assert.notEqual(gatewaySessionKeyFor({ ...origin, authority: '127.0.0.1:30802' }, 'http:'), key, 'a different Host authority is a different session')
  assert.notEqual(gatewaySessionKeyFor(origin, 'https:'), key, 'the scheme qualifies the key')
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

test('a transient probe failure restores the registration proof (the ready push stays health-only)', async () => {
  const origin = { baseUrl: 'http://gateway.example.com:30809', insecureHttp: true, scope: 'test:proof-restore' }
  let proof: 'cookie' | 'bearer' | null = 'cookie'
  configureGatewaySessionProvider({
    ensureSession: async () => ({ ok: true, cookie: 'sid=2' }),
    generation: () => 1,
    registrationAuthProof: () => proof,
    setRegistrationAuthProof: (_origin, next) => { proof = next },
    cachedCookie: () => 'sid=1',
    invalidate: () => { proof = null },
  })
  try {
    // Network failure on the cookie probe: not a credential verdict.
    const transient = await verifyGatewayPasswordSession(origin, PASSWORD, async () => ({
      ok: false, failureKind: 'network', detail: 'blackhole',
    }) as never)
    assert.equal(transient.ok, false)
    assert.equal(proof, 'cookie', 'the proof comes back so the fail-closed gate does not revoke the registration')
    // A reachable 5xx is the same kind of evidence (the destination answered, credential untested).
    const busy = await verifyGatewayPasswordSession(origin, PASSWORD, async () => ({
      ok: false, failureKind: 'server', detail: 'busy', statusCode: 503,
    }) as never)
    assert.equal(busy.ok, false)
    assert.equal(proof, 'cookie')
    // 401 is a CREDENTIAL verdict: invalidate + one re-login; a refused fresh session is
    // terminal and no proof is resurrected.
    const refused = await verifyGatewayPasswordSession(origin, PASSWORD, async () => ({
      ok: false, statusCode: 401,
    }) as never)
    assert.equal(refused.ok, false)
    assert.equal(proof, null, 'a 401 never restores the old proof')
  } finally {
    configureGatewaySessionProvider({})
  }
})

