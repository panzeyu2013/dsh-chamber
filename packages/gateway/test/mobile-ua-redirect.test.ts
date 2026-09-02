/**
 * UA experience shunting tests (design 17 §18): the optional, default-OFF
 * 302 of an authenticated mobile-browser GET/HEAD of `/` to the mobile entry
 * path. UA sniffing is forgeable routing sugar — these tests lock that the
 * shunting never bypasses the auth gate, never shadows /auth/login, and never
 * claims non-root paths or non-GET/HEAD methods.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import type { AuthProvider } from '../src/auth.ts'
import { DEFAULT_MOBILE_ENTRY_PATH, parseGatewayConfig } from '../src/config.ts'
import { createGatewayDispatch } from '../src/dispatch.ts'
import { createGatewayRequestPolicy } from '../src/middleware.ts'
import { FakeRequest, FakeResponse } from './utils.ts'

const silentLogger = { log() {}, warn() {}, error() {} }
const PASSWORD = 'correct-horse-battery'
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

/** Authenticated token principal (generation-less fake → always current). */
const PRINCIPAL = { kind: 'token' as const, id: 'test', issuedAt: 0 }

function authenticatedAuth(): AuthProvider {
  return { kind: 'token', async verify() { return PRINCIPAL } }
}

/** A provider whose verify() answers with a STALE generation (rotation
 * already advanced past the admitted proof). */
function staleGenerationAuth(): AuthProvider {
  return {
    kind: 'token',
    generation: 2,
    async verify() { return { ...PRINCIPAL, generation: 1 } },
  }
}

function deniedAuth(): AuthProvider {
  return { kind: 'password', async verify() { return null }, async login() { return {} } }
}

function setup(options: { auth: AuthProvider; mobileUaRedirect?: boolean; mobileEntryPath?: string }) {
  const config = parseGatewayConfig({
    host: '0.0.0.0',
    port: 3000,
    uiPassword: PASSWORD,
    publicOrigin: 'http://gateway.example:3000',
    mobileUaRedirect: options.mobileUaRedirect,
    mobileEntryPath: options.mobileEntryPath,
  }, '/tmp/gateway-mobile-ua-state', '/tmp/dsh')
  assert.equal(config.mobileUaRedirect, options.mobileUaRedirect === true)
  assert.equal(config.mobileEntryPath, options.mobileEntryPath ?? DEFAULT_MOBILE_ENTRY_PATH)
  const policy = createGatewayRequestPolicy(config)
  let httpProxyCalls = 0
  const proxy = {
    async handleHttp(_req: unknown, res: FakeResponse) { httpProxyCalls += 1; res.writeHead(200); res.end('proxied') },
    async handleUpgrade() {},
    closeAllStreams() {},
  }
  const features = {
    async handle(_req: unknown, res: FakeResponse, pathname: string) {
      if (pathname === DEFAULT_MOBILE_ENTRY_PATH) { res.writeHead(200); res.end('mobile entry'); return true }
      res.writeHead(200); res.end('feature'); return true
    },
  }
  const dispatch = createGatewayDispatch(
    options.auth,
    () => proxy as never,
    () => features as never,
    (() => ({ async handle() { return false } })) as never,
    silentLogger,
    policy,
    undefined,
    options.mobileUaRedirect === true,
    options.mobileEntryPath,
  )
  return { dispatch, get httpProxyCalls() { return httpProxyCalls } }
}

async function runHttp(
  dispatch: ReturnType<typeof setup>['dispatch'],
  req: FakeRequest,
): Promise<FakeResponse> {
  const res = new FakeResponse()
  await dispatch.middleware(
    req as unknown as ApiRequest,
    res as unknown as ApiResponse,
    new URL(req.url, 'http://localhost'),
    {} as never,
  )
  return res
}

test('enabled: mobile UA GET / answers 302 to the default mobile entry with no-store', async () => {
  const s = setup({ auth: authenticatedAuth(), mobileUaRedirect: true })
  const res = await runHttp(s.dispatch, new FakeRequest('GET', '/', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
  }))
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, DEFAULT_MOBILE_ENTRY_PATH)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(s.httpProxyCalls, 0, 'the shunting claims the request before the proxy')
})

test('enabled: a custom --mobile-entry target is honored', async () => {
  const s = setup({ auth: authenticatedAuth(), mobileUaRedirect: true, mobileEntryPath: '/m' })
  const res = await runHttp(s.dispatch, new FakeRequest('GET', '/', {
    host: 'gateway.example:3000',
    'user-agent': 'iPhone; Mobile/15E148 Safari',
  }))
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, '/m')
})

test('enabled: HEAD / with a mobile UA shunts too (no body)', async () => {
  const s = setup({ auth: authenticatedAuth(), mobileUaRedirect: true })
  const res = await runHttp(s.dispatch, new FakeRequest('HEAD', '/', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
  }))
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, DEFAULT_MOBILE_ENTRY_PATH)
  assert.equal(res.body, '')
})

test('enabled: non-mobile UA GET / is proxied, not shunted', async () => {
  const s = setup({ auth: authenticatedAuth(), mobileUaRedirect: true })
  const res = await runHttp(s.dispatch, new FakeRequest('GET', '/', {
    host: 'gateway.example:3000',
    'user-agent': DESKTOP_UA,
  }))
  assert.equal(res.status, 200)
  assert.equal(res.body, 'proxied')
  assert.equal(s.httpProxyCalls, 1)
})

test('enabled: POST / with a mobile UA is proxied (shunting is GET/HEAD only)', async () => {
  const s = setup({ auth: authenticatedAuth(), mobileUaRedirect: true })
  const res = await runHttp(s.dispatch, new FakeRequest('POST', '/', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
  }))
  assert.equal(res.status, 200)
  assert.equal(s.httpProxyCalls, 1)
})

test('enabled: mobile UA on a non-root path never shunts (chamber surface still wins)', async () => {
  const s = setup({ auth: authenticatedAuth(), mobileUaRedirect: true })
  const res = await runHttp(s.dispatch, new FakeRequest('GET', '/chamber/', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
  }))
  assert.equal(res.status, 200)
  assert.equal(res.body, 'feature')
  assert.equal(s.httpProxyCalls, 0)
})

test('disabled (default): mobile UA GET / is proxied normally', async () => {
  const s = setup({ auth: authenticatedAuth() })
  const res = await runHttp(s.dispatch, new FakeRequest('GET', '/', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
  }))
  assert.equal(res.status, 200)
  assert.equal(res.body, 'proxied')
  assert.equal(s.httpProxyCalls, 1)
})

test('a forged mobile UA cannot bypass the auth gate (401 before any shunting)', async () => {
  const s = setup({ auth: deniedAuth(), mobileUaRedirect: true })
  const res = await runHttp(s.dispatch, new FakeRequest('GET', '/', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
  }))
  // Unauthenticated: the gate answers 401 — never the mobile 302, never the proxy.
  assert.equal(res.status, 401)
  assert.equal(JSON.parse(res.body).code, 'unauthorized')
  assert.equal(res.headers.location, undefined)
  assert.equal(s.httpProxyCalls, 0)
})

test('the login flow wins: mobile UA GET /auth/login still serves the login page', async () => {
  const s = setup({ auth: deniedAuth(), mobileUaRedirect: true })
  const res = await runHttp(s.dispatch, new FakeRequest('GET', '/auth/login', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
    accept: 'text/html',
  }))
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /text\/html/)
  assert.equal(s.httpProxyCalls, 0)
})

test('enabled: the ?desktop=1 escape hatch bypasses the shunting (mobile entry exit)', async () => {
  // The P4 mobile placeholder's "Open the full dsh frontend" link points at
  // /?desktop=1 — without the bypass the mobile UA would be bounced right
  // back into the shunting loop.
  const s = setup({ auth: authenticatedAuth(), mobileUaRedirect: true })
  const res = await runHttp(s.dispatch, new FakeRequest('GET', '/?desktop=1', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
  }))
  assert.equal(res.status, 200)
  assert.equal(res.body, 'proxied')
  assert.equal(res.headers.location, undefined)
  assert.equal(s.httpProxyCalls, 1)
})

test('enabled: a stale principal (rotated generation) is rejected before the shunting answers', async () => {
  const s = setup({ auth: staleGenerationAuth(), mobileUaRedirect: true })
  const res = await runHttp(s.dispatch, new FakeRequest('GET', '/', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
  }))
  assert.equal(res.status, 401)
  assert.equal(res.headers.location, undefined, 'no shunting 302 may answer for a revoked principal')
  assert.equal(s.httpProxyCalls, 0)
})

test('a forged mobile UA with an API Accept header still gets the 401 JSON shape, never a redirect', async () => {
  const s = setup({ auth: deniedAuth(), mobileUaRedirect: true })
  const res = await runHttp(s.dispatch, new FakeRequest('GET', '/', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
    accept: 'application/json',
  }))
  assert.equal(res.status, 401)
  assert.equal(JSON.parse(res.body).code, 'unauthorized')
  assert.equal(res.headers.location, undefined)
  assert.equal(s.httpProxyCalls, 0)
})

test('the desktop escape survives the login round-trip (unauthenticated /?desktop=1 → login → /?desktop=1)', async () => {
  // A mobile visitor on the placeholder clicks "Open the full dsh frontend"
  // (/ ?desktop=1) while unauthenticated: the redirect to the login page must
  // carry the marker, and the POST (form action /auth/login?desktop=1) must
  // land back on /?desktop=1 — not on '/' which would be shunted again.
  const s = setup({ auth: deniedAuth(), mobileUaRedirect: true })
  const pre = await runHttp(s.dispatch, new FakeRequest('GET', '/?desktop=1', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
    accept: 'text/html',
  }))
  assert.equal(pre.status, 302)
  assert.equal(pre.headers.location, '/auth/login?desktop=1')
  assert.equal(s.httpProxyCalls, 0)

  const postReq = new FakeRequest('POST', '/auth/login?desktop=1', {
    host: 'gateway.example:3000',
    'user-agent': MOBILE_UA,
    accept: 'text/html',
    'content-type': 'application/x-www-form-urlencoded',
  })
  // Paused-mode body (test/utils.ts): emitted before the dispatch middleware
  // attaches its 'data' listener, replayed when readBody() subscribes.
  postReq.emit('data', Buffer.from(`password=${encodeURIComponent(PASSWORD)}`))
  postReq.emit('end')
  const post = await runHttp(s.dispatch, postReq)
  assert.equal(post.status, 302)
  assert.equal(post.headers.location, '/?desktop=1', 'the marker must survive the login round-trip')
  assert.equal(s.httpProxyCalls, 0)
})
