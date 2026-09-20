/**
 * Dispatch-level integration for the login-phase pre-warm (design 17 §10.6,
 * 2026-12 revision): a GET/HEAD bundle-shape request with a valid
 * dsh_gateway_warmup grant is claimed BEFORE the auth gate and proxied with
 * the spawn-minted browser-auth cookie; without the grant (absent, stale,
 * tampered, other client) the same request reaches the gate and keeps its
 * uniform 401 plus the category-only audit; a non-bundle /plugins path stays
 * authenticated even with a grant; non-GET/HEAD is 405 with the route's own
 * audit code; the login GET renders ONLY real /plugins/?? hrefs and sets the
 * HttpOnly/SameSite=Lax/Max-Age cookie; the kill switch removes both and keeps
 * the previous 401 decision with zero feature-surface calls.
 *
 * This file imports src/dispatch.ts and therefore the workspace
 * @dsh-chamber/control-plane graph; it needs the repo's node_modules link
 * (CI), unlike warmup.test.ts / warmup-login-page.test.ts.
 * Run with `node packages/gateway/test/boundary/warmup-dispatch.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthProvider } from '../../src/auth.ts'
import { createGatewayDispatch } from '../../src/dispatch.ts'
import { parseGatewayConfig } from '../../src/config.ts'
import { createGatewayRequestPolicy } from '../../src/middleware.ts'
import { WARMUP_COOKIE_NAME, createWarmupCookie, verifyWarmupCookie } from '../../src/warmup.ts'
import { gatewayRequest } from '../support/utils.ts'
import { readAudit, runHttp, silentLogger } from '../support/dispatch-harness.ts'

const SECRET = 'warmup-dispatch-test-secret'
const NOW_SECONDS = 1_700_000_000
const CLIENT = '203.0.113.8'
const SPAWN_COOKIE = 'browser-auth=spawn-minted'
const BUNDLE = '/plugins/??@dsh-chamber/dsh-client-ui-mobile/client.js&rev=deadbeef'
const SINGLE_BUNDLE = '/plugins/dsh-chamber-mcp/client.js'
const INDEX_HTML = '<script src="' + BUNDLE.replace('&', '&amp;') + '"></script>'

interface WarmupSetupOptions {
  enabled?: boolean
  port?: number | null
  state?: string
  fetchFails?: boolean
  fetchHtml?: string
  authCookie?: string | undefined
  publicOrigin?: string
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function grantCookie(nowSeconds = NOW_SECONDS, client = CLIENT): string {
  return WARMUP_COOKIE_NAME + '=' + createWarmupCookie(SECRET, nowSeconds, client)
}

/** The dispatch harness of dispatch-harness.ts, extended with the warm-up
 * deps and call counters. */
function setupWarmup(auth: AuthProvider, options: WarmupSetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-warmup-'))
  const auditFile = join(dir, 'audit.log')
  const config = parseGatewayConfig({
    host: '0.0.0.0',
    port: 3000,
    uiPassword: 'correct-horse-battery',
    publicOrigin: options.publicOrigin ?? 'http://gateway.example:3000',
  }, dir, '/tmp/dsh')
  const policy = createGatewayRequestPolicy(config)
  let httpProxyCalls = 0
  const proxy = {
    async handleHttp(_req: unknown, res: { writeHead(status: number): void; end(body: string): void }) {
      httpProxyCalls += 1
      res.writeHead(200)
      res.end('proxied')
    },
    async handleUpgrade() {},
    closeAllStreams() {},
  }
  // The chamber surface is a 404-only stub: a fallthrough from /chamber/*
  // must be indistinguishable from "no warm-up route".
  let featureCalls = 0
  const features = {
    async handle(_req: unknown, res: { writeHead(status: number, headers?: Record<string, string>): void; end(body: string): void }) {
      featureCalls += 1
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not_found","code":"not_found"}')
      return true
    },
    start() {},
    stop() {},
  }
  const dispatch = createGatewayDispatch(
    auth,
    () => proxy as never,
    () => features as never,
    (() => ({ async handle() { return false } })) as never,
    silentLogger,
    policy,
    auditFile,
    false,
    undefined,
    undefined,
    {
      enabled: options.enabled ?? true,
      getLocalDshPort: () => options.port ?? null,
      getLocalState: () => options.state ?? 'starting',
      getSecret: () => SECRET,
      getAuthCookie: () => options.authCookie,
      logger: silentLogger,
      fetchIndex: async () => {
        if (options.fetchFails === true) throw Object.assign(new Error('down'), { name: 'TimeoutError' })
        return options.fetchHtml ?? INDEX_HTML
      },
      now: () => NOW_SECONDS * 1000,
    },
  )
  return {
    dispatch,
    auditFile,
    get httpProxyCalls() { return httpProxyCalls },
    get featureCalls() { return featureCalls },
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

function passwordAuth(): { auth: AuthProvider; verifyCalls: () => number } {
  let verifyCalls = 0
  return {
    auth: {
      kind: 'password',
      async verify() { verifyCalls += 1; return null },
      async login() { return {} },
    },
    verifyCalls: () => verifyCalls,
  }
}

function prefetchHref(page: string): string {
  const match = /<link rel="prefetch" as="script" href="([^"]+)">/.exec(page)
  assert.ok(match !== null, 'the login page must carry a prefetch link')
  return match[1].replace(/&amp;/g, '&')
}

test('GET /auth/login mints the capability cookie and renders only real bundle hrefs', async () => {
  const { auth } = passwordAuth()
  const state = setupWarmup(auth, { port: 17510, state: 'ready' })
  try {
    const res = await runHttp(state.dispatch, gatewayRequest('GET', '/auth/login'))
    assert.equal(res.status, 200)
    assert.match(String(res.headers['content-security-policy']), /connect-src 'self'/)
    assert.doesNotMatch(String(res.headers['content-security-policy']), /script-src/)
    const setCookie = String(res.headers['set-cookie'] ?? '')
    const prefix = WARMUP_COOKIE_NAME + '='
    assert.equal(setCookie.startsWith(prefix), true, 'the login response grants the warm-up capability')
    assert.match(setCookie, /; Path=\/; Max-Age=120; HttpOnly; SameSite=Lax$/)
    assert.doesNotMatch(setCookie, /; Secure/, 'a plain-HTTP request gets no Secure attribute')
    const value = setCookie.slice(prefix.length).split(';')[0]
    assert.equal(verifyWarmupCookie(SECRET, value, NOW_SECONDS, CLIENT), true, 'the minted grant round-trips')

    const page = String(res.body)
    assert.doesNotMatch(page, /<script/i, 'the login page stays script-free')
    const hrefs = [...page.matchAll(/<link rel="prefetch" as="script" href="([^"]+)">/g)].map(m => m[1])
    assert.deepEqual(hrefs, [BUNDLE.replace(/&/g, '&amp;')], 'one link per discovered URL, as the REAL href')
    assert.equal(page.includes('/chamber/warmup'), false, 'no token wrapper remains')
    assert.equal(page.includes('?u='), false, 'no capability travels in the URL')
    assert.equal(page.includes('crossorigin'), false, 'no attribute that could split the HTTP cache entry')
    assert.ok(page.indexOf(hrefs[0]) < page.indexOf('</head>'), 'the link lands inside <head>')
  } finally { state.cleanup() }
})

test('the grant cookie is Secure when the request reached the gateway over TLS', async () => {
  const { auth } = passwordAuth()
  const state = setupWarmup(auth, { port: 17510, state: 'ready', publicOrigin: 'https://gateway.example:3000' })
  try {
    const req = gatewayRequest('GET', '/auth/login')
    req.socket.encrypted = true
    const res = await runHttp(state.dispatch, req)
    assert.equal(res.status, 200)
    assert.match(String(res.headers['set-cookie']), /; Secure$/)
  } finally { state.cleanup() }
})

test('login page -> prefetch round-trip: the rendered href and minted cookie drive the route with no session', async () => {
  const { auth, verifyCalls } = passwordAuth()
  const body = Buffer.from('bundle-bytes', 'utf8')
  const seen: Array<{ url: string | undefined; cookie: string | undefined; authorization: string | undefined }> = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization })
    res.writeHead(200, {
      'content-type': 'text/javascript',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': String(body.length),
    })
    res.end(body)
  })
  const port = await listen(server)
  const state = setupWarmup(auth, { port, state: 'ready', authCookie: SPAWN_COOKIE })
  try {
    const page = await runHttp(state.dispatch, gatewayRequest('GET', '/auth/login'))
    const href = prefetchHref(String(page.body))
    const cookiePair = String(page.headers['set-cookie']).split(';')[0]
    const res = await runHttp(state.dispatch, gatewayRequest('GET', href, {
      cookie: cookiePair + '; gateway-session=nope',
      authorization: 'Bearer nope',
      'accept-encoding': 'gzip',
    }))
    assert.equal(res.status, 200, 'the prefetch is served pre-auth')
    assert.equal(res.body, body.toString('utf8'))
    assert.equal(verifyCalls(), 0, 'no auth verdict is computed for the granted prefetch')
    assert.equal(state.httpProxyCalls, 0, 'the gateway proxy is not involved')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, BUNDLE, 'the REAL url is fetched, not a token wrapper')
    assert.equal(seen[0].cookie, SPAWN_COOKIE, 'only the spawn-minted cookie goes upstream')
    assert.equal(seen[0].authorization, undefined, 'the caller authorization never goes upstream')
  } finally { state.cleanup(); await close(server) }
})

test('a bundle shape without the capability cookie is 401 through the auth gate with zero proxy calls', async () => {
  const { auth, verifyCalls } = passwordAuth()
  const state = setupWarmup(auth, { port: 17510, state: 'ready' })
  try {
    for (const target of [SINGLE_BUNDLE, BUNDLE]) {
      const res = await runHttp(state.dispatch, gatewayRequest('GET', target, { accept: '*/*' }))
      assert.equal(res.status, 401, target)
      assert.deepEqual(res.json(), { error: 'unauthorized', code: 'unauthorized' })
    }
    assert.equal(verifyCalls(), 2, 'the gate still decides every bundle shape without a grant')
    assert.equal(state.httpProxyCalls, 0)
    assert.equal(state.featureCalls, 0, 'nothing falls through to the feature surface')
  } finally { state.cleanup() }
})

test('a stale or client-mismatched grant falls through to the auth gate, never a route refusal', async () => {
  const { auth, verifyCalls } = passwordAuth()
  const state = setupWarmup(auth, { port: 17510, state: 'ready' })
  try {
    const stale = grantCookie(NOW_SECONDS - 3600)
    const otherClient = WARMUP_COOKIE_NAME + '=' + createWarmupCookie(SECRET, NOW_SECONDS, '198.51.100.7')
    for (const cookie of [stale, otherClient, WARMUP_COOKIE_NAME + '=tampered.value']) {
      const res = await runHttp(state.dispatch, gatewayRequest('GET', BUNDLE, { accept: '*/*', cookie }))
      assert.equal(res.status, 401)
      assert.deepEqual(res.json(), { error: 'unauthorized', code: 'unauthorized' })
    }
    assert.equal(verifyCalls(), 3)
  } finally { state.cleanup() }
})

test('an existing session still reaches a bundle shape through the auth gate', async () => {
  let verifyCalls = 0
  const auth: AuthProvider = {
    kind: 'password',
    async verify() {
      verifyCalls += 1
      return { kind: 'password', id: 'session-holder', issuedAt: NOW_SECONDS }
    },
    async login() { return {} },
  }
  const state = setupWarmup(auth, { port: 17510, state: 'ready' })
  try {
    const res = await runHttp(state.dispatch, gatewayRequest('GET', SINGLE_BUNDLE, { cookie: 'gateway-session=valid' }))
    assert.equal(res.status, 200, 'a logged-in app fetch of a bundle is not blocked by the warm-up route')
    assert.equal(res.body, 'proxied')
    assert.equal(verifyCalls, 1)
    assert.equal(state.httpProxyCalls, 1)
  } finally { state.cleanup() }
})

test('a valid grant claims the bundle route pre-auth: 503 while the dsh is not ready, no auth verdict', async () => {
  const { auth, verifyCalls } = passwordAuth()
  const state = setupWarmup(auth, { port: 17510, state: 'starting' })
  try {
    const res = await runHttp(state.dispatch, gatewayRequest('GET', BUNDLE, { cookie: grantCookie() }))
    assert.equal(res.status, 503)
    assert.deepEqual(res.json(), { error: 'instance_unavailable', code: 'instance_unavailable' })
    assert.equal(verifyCalls(), 0)
    assert.equal(state.httpProxyCalls, 0)
  } finally { state.cleanup() }
})

test('a non-bundle /plugins path stays authenticated even when the grant cookie is present', async () => {
  const { auth, verifyCalls } = passwordAuth()
  const state = setupWarmup(auth, { port: 17510, state: 'ready' })
  try {
    const res = await runHttp(state.dispatch, gatewayRequest('GET', '/plugins/pkg/api/x', { accept: '*/*', cookie: grantCookie() }))
    assert.equal(res.status, 401)
    assert.deepEqual(res.json(), { error: 'unauthorized', code: 'unauthorized' })
    assert.equal(verifyCalls(), 1)
    assert.equal(state.httpProxyCalls, 0)
    assert.equal(state.featureCalls, 0)
  } finally { state.cleanup() }
})

test('non-GET/HEAD on a bundle shape is 405 before the auth gate and audited with its own code', async () => {
  const { auth, verifyCalls } = passwordAuth()
  const state = setupWarmup(auth, { port: 17510, state: 'ready' })
  try {
    const res = await runHttp(state.dispatch, gatewayRequest('POST', BUNDLE, { cookie: grantCookie() }))
    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET, HEAD')
    assert.equal(verifyCalls(), 0)
    assert.equal(state.httpProxyCalls, 0)
    const raw = readFileSync(state.auditFile, 'utf8')
    assert.match(raw, /code:method_not_allowed,client:203\.0\.113\.8,path:plugins/)
    assert.equal(raw.includes(BUNDLE), false, 'the URL never enters the audit trail')
    assert.equal(raw.includes(grantCookie()), false, 'the cookie value never enters the audit trail')
  } finally { state.cleanup() }
})

test('a bundle-shape refusal is audited with code + client + path category only', async () => {
  const { auth } = passwordAuth()
  const state = setupWarmup(auth, { port: 17510, state: 'ready' })
  try {
    const res = await runHttp(state.dispatch, gatewayRequest('GET', BUNDLE, { accept: '*/*' }))
    assert.equal(res.status, 401)
    const events = readAudit(state.auditFile)
    assert.equal(events.length >= 1, true)
    for (const event of events) {
      assert.equal(event.event, 'auth_rejected')
      assert.match(event.detail, /^code:unauthorized,client:203\.0\.113\.8,path:plugins(,count:\d+)?$/)
    }
    const raw = readFileSync(state.auditFile, 'utf8')
    assert.equal(raw.includes(BUNDLE), false, 'the signed path never enters the audit trail')
    assert.equal(raw.includes(SECRET), false)
  } finally { state.cleanup() }
})

test('the kill switch (enabled:false) keeps the previous 401 decision with zero feature-surface calls', async () => {
  const { auth, verifyCalls } = passwordAuth()
  const state = setupWarmup(auth, { enabled: false, port: 17510, state: 'ready' })
  try {
    const res = await runHttp(state.dispatch, gatewayRequest('GET', SINGLE_BUNDLE, { accept: '*/*' }))
    assert.equal(res.status, 401, 'the disabled route leaves /plugins/** to the gate')
    assert.equal(verifyCalls(), 1)
    assert.equal(state.featureCalls, 0)
    assert.equal(state.httpProxyCalls, 0)

    const page = await runHttp(state.dispatch, gatewayRequest('GET', '/auth/login'))
    assert.equal(page.status, 200)
    assert.doesNotMatch(String(page.body), /prefetch/)
    assert.equal(page.headers['set-cookie'], undefined, 'no grant is minted with the switch off')
    assert.match(String(page.headers['content-security-policy']), /connect-src 'self'/)
    assert.doesNotMatch(String(page.body), /<script/i)
  } finally { state.cleanup() }
})

test('discovery failure keeps the login page pristine (no prefetch link, no grant cookie)', async () => {
  const { auth } = passwordAuth()
  const state = setupWarmup(auth, { port: 17510, state: 'ready', fetchFails: true })
  try {
    const res = await runHttp(state.dispatch, gatewayRequest('GET', '/auth/login'))
    assert.equal(res.status, 200)
    assert.doesNotMatch(String(res.body), /prefetch/)
    assert.equal(res.headers['set-cookie'], undefined)
  } finally { state.cleanup() }
})

test('an existing authenticated path keeps its auth decision (verify is still called)', async () => {
  const { auth, verifyCalls } = passwordAuth()
  const state = setupWarmup(auth)
  try {
    const res = await runHttp(state.dispatch, gatewayRequest('GET', '/api/connections', { accept: 'application/json' }))
    assert.equal(res.status, 401)
    assert.deepEqual(res.json(), { error: 'unauthorized', code: 'unauthorized' })
    assert.equal(verifyCalls(), 1, 'the gate still decides for management paths')
  } finally { state.cleanup() }
})
