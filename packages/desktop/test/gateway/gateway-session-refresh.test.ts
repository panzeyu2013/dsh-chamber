/**
 * gateway-session — part 3: gatewaySessionOriginForUrl and the proactive refresh
 * orchestration (arm at expiry − lead, re-login/re-register, dead-cookie
 * recovery, disarm) against fake and real session managers.
 *
 * Sibling parts: gateway-session.test.ts, gateway-session-lifecycle.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGatewaySessionManager, GATEWAY_SESSION_EXPIRY_SKEW_MS, GATEWAY_SESSION_TTL_MS, type GatewaySessionOrigin, type GatewaySessionResult } from '../../gateway-session.ts'
import {
  createGatewaySessionRefresh,
  gatewaySessionOriginForUrl,
  gatewayTunnelAuthority,
  GATEWAY_SESSION_REFRESH_LEAD_MS,
  type GatewaySessionRefreshDeps,
} from '../../gateway-session-refresh.ts'
import { COOKIE, PASSWORD, loginHandler, startGateway, type LoginRecord } from '../support/gateway-session-fixtures.ts'

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
