/**
 * UA experience shunting tests (design 17 §18): the optional, default-OFF
 * 302 of an authenticated mobile-browser GET/HEAD of `/` to the mobile entry
 * path. UA sniffing is forgeable routing sugar — these tests lock that the
 * shunting never bypasses the auth gate, never shadows /auth/login, and never
 * claims non-root paths or non-GET/HEAD methods.
 */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import type { AuthProvider } from '../src/auth.ts'
import { DEFAULT_MOBILE_ENTRY_PATH, parseGatewayConfig } from '../src/config.ts'
import { createGatewayDispatch } from '../src/dispatch.ts'
import { createGatewayRequestPolicy } from '../src/middleware.ts'

const silentLogger = { log() {}, warn() {}, error() {} }
const PASSWORD = 'correct-horse-battery'
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

class FakeRequest extends EventEmitter {
  readonly headers: Record<string, string>
  readonly method: string
  readonly url: string
  readonly socket: { remoteAddress: string; encrypted?: boolean }
  destroyed = false
  constructor(method: string, url: string, headers: Record<string, string>, remoteAddress = '203.0.113.8') {
    super()
    this.method = method
    this.url = url
    this.headers = headers
    this.socket = { remoteAddress }
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('aborted')
    this.emit('close')
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {}
}

class FakeResponse extends EventEmitter {
  status = 0
  headersSent = false
  headers: Record<string, unknown> = {}
  body = ''
  destroyed = false
  _corsHeaders?: Record<string, string>
  setHeader(name: string, value: unknown): void { this.headers[name.toLowerCase()] = value }
  writeHead(status: number, headers: Record<string, unknown> = {}): void {
    this.status = status
    this.headersSent = true
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
  }
  write(chunk: unknown): boolean { this.body += String(chunk); return true }
  end(chunk?: unknown): void { if (chunk !== undefined) this.body += String(chunk) }
  destroy(): void { this.destroyed = true }
}

/** Authenticated token principal (generation-less fake → always current). */
const PRINCIPAL = { kind: 'token' as const, id: 'test', issuedAt: 0 }

function authenticatedAuth(): AuthProvider {
  return { kind: 'token', async verify() { return PRINCIPAL } }
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
