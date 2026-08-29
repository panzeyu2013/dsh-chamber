/** No-listen composition tests for gateway boundary → auth → route dispatch. */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import type { AuthProvider } from '../src/auth.ts'
import { parseGatewayConfig } from '../src/config.ts'
import { createGatewayDispatch } from '../src/dispatch.ts'
import { createGatewayRequestPolicy } from '../src/middleware.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

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
  destroy(): void { this.destroyed = true }
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

function setup(
  auth: AuthProvider,
  runtime: () => { handle(req: unknown, res: FakeResponse, pathname: string): Promise<boolean> } = () => ({ async handle() { return false } }),
) {
  const config = parseGatewayConfig({
    host: '0.0.0.0',
    port: 3000,
    uiPassword: 'correct-horse-battery',
    publicOrigin: 'http://gateway.example:3000',
    corsOrigins: ['capacitor://localhost'],
  }, '/tmp/gateway-dispatch-state', '/tmp/dsh')
  const policy = createGatewayRequestPolicy(config)
  let httpProxyCalls = 0
  let upgradeProxyCalls = 0
  const proxy = {
    async handleHttp(_req: unknown, res: FakeResponse) { httpProxyCalls += 1; res.writeHead(200); res.end('proxied') },
    async handleUpgrade() { upgradeProxyCalls += 1 },
    closeAllStreams() {},
  }
  const features = {
    async handle(_req: unknown, res: FakeResponse) { res.writeHead(200); res.end('feature'); return true },
    start() {},
    stop() {},
  }
  const dispatch = createGatewayDispatch(auth, () => proxy as never, () => features as never, runtime as never, silentLogger, policy)
  return { dispatch, get httpProxyCalls() { return httpProxyCalls }, get upgradeProxyCalls() { return upgradeProxyCalls } }
}

async function runHttp(
  dispatch: ReturnType<typeof setup>['dispatch'],
  req: FakeRequest,
  body?: string,
): Promise<FakeResponse> {
  const res = new FakeResponse()
  const pending = dispatch.middleware(req as unknown as ApiRequest, res as unknown as ApiResponse, new URL(req.url, 'http://localhost'), {} as never)
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  await pending
  return res
}

test('login page has a self form-action and accepts its form-urlencoded body', async () => {
  let loginBody: unknown
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login(body) { loginBody = body; return { setCookie: 'session=cookie; HttpOnly' } },
  }
  const { dispatch } = setup(auth)
  const get = await runHttp(dispatch, new FakeRequest('GET', '/auth/login', { host: 'gateway.example:3000' }))
  assert.equal(get.status, 200)
  assert.match(String(get.headers['content-security-policy']), /form-action 'self'/)
  assert.doesNotMatch(String(get.headers['content-security-policy']), /script-src/)

  const post = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/x-www-form-urlencoded',
  }), 'password=hunter2')
  assert.equal(post.status, 302)
  assert.deepEqual(loginBody, { password: 'hunter2' })
  assert.equal(post.headers.location, '/')
})

test('oversized public login bodies enter drain-only mode and never reach auth', async () => {
  let loginCalls = 0
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { loginCalls += 1; return {} },
  }
  const { dispatch } = setup(auth)
  const req = new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/json',
  })
  const res = new FakeResponse()
  const pending = dispatch.middleware(
    req as unknown as ApiRequest,
    res as unknown as ApiResponse,
    new URL(req.url, 'http://localhost'),
    {} as never,
  )
  queueMicrotask(() => {
    req.emit('data', Buffer.alloc(16 * 1024))
    req.emit('data', Buffer.from('x'))
    const poison = Object.defineProperty({}, 'length', {
      get() { throw new Error('post-limit chunk was inspected') },
    })
    req.emit('data', poison)
    req.emit('end')
  })
  await pending
  assert.equal(res.status, 413)
  assert.equal(JSON.parse(res.body).code, 'body_too_large')
  assert.equal(req.destroyed, true, 'the oversized body destroys the request socket after the 413 is written')
  assert.equal(loginCalls, 0)
})

test('login method exposure is narrow and unauthenticated document navigation reaches it', async () => {
  let verifyCalls = 0
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { verifyCalls += 1; return null },
    async login() { return {} },
  }
  const { dispatch } = setup(auth)

  const unsupported = await runHttp(dispatch, new FakeRequest('PUT', '/auth/login', {
    host: 'gateway.example:3000',
  }))
  assert.equal(unsupported.status, 405)
  assert.equal(unsupported.headers.allow, 'GET, HEAD, POST')
  assert.equal(verifyCalls, 0)

  const navigation = await runHttp(dispatch, new FakeRequest('GET', '/', {
    host: 'gateway.example:3000',
    accept: 'text/html,application/xhtml+xml',
  }))
  assert.equal(navigation.status, 302)
  assert.equal(navigation.headers.location, '/auth/login')

  const api = await runHttp(dispatch, new FakeRequest('GET', '/api/connections', {
    host: 'gateway.example:3000',
    accept: 'text/html',
  }))
  assert.equal(api.status, 401)

  const healthMutation = await runHttp(dispatch, new FakeRequest('POST', '/health', {
    host: 'gateway.example:3000',
  }))
  assert.equal(healthMutation.status, 401)

  const asset = await runHttp(dispatch, new FakeRequest('GET', '/assets/app.js', {
    host: 'gateway.example:3000',
    accept: '*/*',
  }))
  assert.equal(asset.status, 401)
  assert.equal(verifyCalls, 4)
})

test('gateway claims Authorization preflight before auth on every route family', async () => {
  let verifyCalls = 0
  const auth: AuthProvider = { kind: 'token', async verify() { verifyCalls += 1; return null } }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('OPTIONS', '/chamber/settings', {
    host: 'gateway.example:3000',
    origin: 'capacitor://localhost',
  }))
  assert.equal(res.status, 204)
  assert.match(String(res.headers['access-control-allow-headers']), /authorization/)
  assert.equal(res.headers['access-control-allow-origin'], 'capacitor://localhost')
  assert.equal(verifyCalls, 0)
})

test('a forbidden external origin is rejected before auth or dsh proxying', async () => {
  let verifyCalls = 0
  const auth: AuthProvider = { kind: 'token', async verify() { verifyCalls += 1; return { kind: 'token', id: 'x', issuedAt: 0 } } }
  const state = setup(auth)
  const res = await runHttp(state.dispatch, new FakeRequest('POST', '/api/session.create', {
    host: 'gateway.example:3000',
    origin: 'http://attacker.example',
  }))
  assert.equal(res.status, 403)
  assert.equal(verifyCalls, 0)
  assert.equal(state.httpProxyCalls, 0)
})

test('WS applies the same Host policy before auth and proxies an allowed authenticated stream', async () => {
  let verifyCalls = 0
  const auth: AuthProvider = {
    kind: 'token',
    async verify(req) {
      verifyCalls += 1
      return req.headers.authorization === 'Bearer secret' ? { kind: 'token', id: 'x', issuedAt: 0 } : null
    },
  }
  const state = setup(auth)
  let rejection = ''
  const badSocket = { end(value: string) { rejection = value }, destroy() {} }
  await state.dispatch.upgradeMiddleware(new FakeRequest('GET', '/api/events.mux', {
    host: '192.168.1.10:3000',
  }) as unknown as ApiRequest, badSocket as never, Buffer.alloc(0), {} as never)
  assert.match(rejection, /421 Misdirected Request/)
  assert.equal(verifyCalls, 0)

  const goodSocket = { end() {}, destroy() {} }
  await state.dispatch.upgradeMiddleware(new FakeRequest('GET', '/api/events.mux', {
    host: 'gateway.example:3000',
    origin: 'http://gateway.example:3000',
    authorization: 'Bearer secret',
  }) as unknown as ApiRequest, goodSocket as never, Buffer.alloc(0), {} as never)
  assert.equal(verifyCalls, 1)
  assert.equal(state.upgradeProxyCalls, 1)
})

test('WS rejects backslash authority request targets before routing or auth', async () => {
  let verifyCalls = 0
  const auth: AuthProvider = {
    kind: 'token',
    async verify() { verifyCalls += 1; return { kind: 'token', id: 'x', issuedAt: 0 } },
  }
  const state = setup(auth)
  let rejection = ''
  const socket = { end(value: string) { rejection = value }, destroy() {} }
  await state.dispatch.upgradeMiddleware(new FakeRequest('GET', '/\\\\attacker.example/api/events.mux', {
    host: 'gateway.example:3000',
    authorization: 'Bearer secret',
  }) as unknown as ApiRequest, socket as never, Buffer.alloc(0), {} as never)
  assert.match(rejection, /400 Bad Request/)
  assert.equal(verifyCalls, 0)
  assert.equal(state.upgradeProxyCalls, 0)
})

test('a saturated scrypt work gate on verify answers 503 auth_busy, never 500', async () => {
  // The login path maps auth_busy → 503; the verify path used to let the
  // rejection fall through to the shell as a generic 500 internal, so an
  // attacker flooding bogus Bearer tokens saw 500s while legitimate clients
  // were squeezed out (design §5.3).
  const auth: AuthProvider = {
    kind: 'token',
    async verify() {
      const error = new Error('password verifier is busy') as Error & { code?: string }
      error.code = 'auth_busy'
      throw error
    },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('GET', '/api/connections', {
    host: 'gateway.example:3000',
    authorization: 'Bearer whatever',
  }))
  assert.equal(res.status, 503)
  assert.equal(JSON.parse(res.body).code, 'auth_busy')
})

test('WS upgrade maps a saturated verify work gate to 503 auth_busy like HTTP', async () => {
  const auth: AuthProvider = {
    kind: 'token',
    async verify() {
      const error = new Error('password verifier is busy') as Error & { code?: string }
      error.code = 'auth_busy'
      throw error
    },
  }
  const state = setup(auth)
  let rejection = ''
  const socket = { end(value: string) { rejection = value }, destroy() {} }
  await state.dispatch.upgradeMiddleware(new FakeRequest('GET', '/api/events.mux', {
    host: 'gateway.example:3000',
    authorization: 'Bearer whatever',
  }) as unknown as ApiRequest, socket as never, Buffer.alloc(0), {} as never)
  assert.match(rejection, /503 Service Unavailable/)
  assert.match(rejection, /auth_busy/)
  assert.equal(state.upgradeProxyCalls, 0, 'a busy verify never reaches the proxy')
})

test('/chamber/runtime requires auth end-to-end (S20): 401 unauthenticated, claimed after auth', async () => {
  const seen: string[] = []
  const runtime = () => ({
    async handle(_req: unknown, res: FakeResponse, pathname: string) {
      seen.push(pathname)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return true
    },
  })
  const auth: AuthProvider = {
    kind: 'token',
    async verify(req) {
      return req.headers.authorization === 'Bearer secret'
        ? { kind: 'token', id: 'test', issuedAt: 0 }
        : null
    },
  }
  const { dispatch } = setup(auth, runtime)
  const denied = await runHttp(dispatch, new FakeRequest('GET', '/chamber/runtime/status', { host: 'gateway.example:3000' }))
  assert.equal(denied.status, 401)
  assert.deepEqual(seen, [])
  const ok = await runHttp(dispatch, new FakeRequest('GET', '/chamber/runtime/status', {
    host: 'gateway.example:3000',
    authorization: 'Bearer secret',
  }))
  assert.equal(ok.status, 200)
  assert.deepEqual(seen, ['/chamber/runtime/status'])
})

// ── Gateway login-page behavior (rendered by src/login-page.ts) ──

/** Every HTML login response must carry the full header set: the no-script
 * login CSP (C1), no-store, no-referrer and nosniff (design 17 §7.1). */
function assertLoginHtmlResponse(res: FakeResponse, status: number): void {
  assert.equal(res.status, status)
  assert.match(String(res.headers['content-type']), /^text\/html/)
  const csp = String(res.headers['content-security-policy'])
  assert.match(csp, /form-action 'self'/)
  assert.match(csp, /img-src data:/)
  assert.doesNotMatch(csp, /script-src/)
  assert.equal(String(res.headers['cache-control']), 'no-store')
  assert.equal(String(res.headers['referrer-policy']), 'no-referrer')
  assert.equal(String(res.headers['x-content-type-options']), 'nosniff')
}

test('document navigation with an expired session cookie redirects to the expired hint', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { return {} },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('GET', '/', {
    host: 'gateway.example:3000',
    accept: 'text/html',
    cookie: 'dsh_gateway_session=eyJ.old',
  }))
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, '/auth/login?expired=1')
})

test('GET /auth/login renders the expired hint only for expired=1', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { return {} },
  }
  const { dispatch } = setup(auth)
  const expired = await runHttp(dispatch, new FakeRequest('GET', '/auth/login?expired=1', {
    host: 'gateway.example:3000',
    accept: 'text/html',
  }))
  assert.equal(expired.status, 200)
  assert.ok(String(expired.body).includes('session expired'))
  const zero = await runHttp(dispatch, new FakeRequest('GET', '/auth/login?expired=0', {
    host: 'gateway.example:3000',
    accept: 'text/html',
  }))
  assert.equal(zero.status, 200)
  assert.ok(!String(zero.body).includes('session expired'))
  const other = await runHttp(dispatch, new FakeRequest('GET', '/auth/login?expired=not1', {
    host: 'gateway.example:3000',
    accept: 'text/html',
  }))
  assert.equal(other.status, 200)
  assert.ok(!String(other.body).includes('session expired'))
})

test('the login page shows the plaintext warning on an unencrypted socket', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { return {} },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('GET', '/auth/login', {
    host: 'gateway.example:3000',
    accept: 'text/html',
  }))
  assert.equal(res.status, 200)
  assert.ok(String(res.body).includes('Unencrypted connection'))
})

test('browser form login failure renders an HTML 401 without echoing the password', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { throw new Error('invalid password') },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html',
  }), 'password=hunter2')
  assertLoginHtmlResponse(res, 401)
  assert.ok(String(res.body).includes('Incorrect password'))
  assert.ok(!String(res.body).includes('hunter2'))
})

test('API login failure keeps the JSON shape', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { throw new Error('invalid password') },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/json',
    accept: 'application/json',
  }), '{"password":"hunter2"}')
  assert.equal(res.status, 401)
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid credentials', code: 'invalid_credentials' })
})

test('form-urlencoded without an Accept header stays JSON (conservative)', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { throw new Error('invalid password') },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/x-www-form-urlencoded',
  }), 'password=hunter2')
  assert.equal(res.status, 401)
  assert.equal(JSON.parse(res.body).code, 'invalid_credentials')
})

test('rate-limited login answers 429 with Retry-After and an HTML wait message', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() {
      throw Object.assign(new Error('too many login attempts'), { code: 'rate_limited', retryAfterMs: 900000 })
    },
  }
  const { dispatch } = setup(auth)

  const html = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html',
  }), 'password=hunter2')
  assertLoginHtmlResponse(html, 429)
  assert.equal(html.headers['retry-after'], '900')
  assert.ok(String(html.body).includes('~900s'))

  const json = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/json',
    accept: 'application/json',
  }), '{"password":"hunter2"}')
  assert.equal(json.status, 429)
  assert.equal(json.headers['retry-after'], '900')
  assert.deepEqual(JSON.parse(json.body), { error: 'too many login attempts', code: 'rate_limited' })
})

test('rate-limited without retryAfterMs still answers 429 with a sane floor', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() {
      throw Object.assign(new Error('too many login attempts'), { code: 'rate_limited' })
    },
  }
  const { dispatch } = setup(auth)
  const html = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html',
  }), 'password=hunter2')
  assertLoginHtmlResponse(html, 429)
  // Math.max(1, …) floors a missing/zero retryAfterMs at one second.
  assert.equal(html.headers['retry-after'], '1')
  assert.ok(String(html.body).includes('~1s'))
})

test('auth_busy login answers 503 HTML for browsers, JSON for API clients', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() {
      throw Object.assign(new Error('busy'), { code: 'auth_busy' })
    },
  }
  const { dispatch } = setup(auth)
  const html = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html',
  }), 'password=hunter2')
  assertLoginHtmlResponse(html, 503)
  assert.ok(String(html.body).includes('Authentication service is busy'))

  const json = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/json',
    accept: 'application/json',
  }), '{"password":"hunter2"}')
  assert.equal(json.status, 503)
  assert.deepEqual(JSON.parse(json.body), { error: 'authentication service is busy', code: 'auth_busy' })
})

test('token-only deployments answer 404: HTML explanation for browsers, JSON for API clients', async () => {
  const auth: AuthProvider = { kind: 'token', async verify() { return null } }
  const { dispatch } = setup(auth)

  const html = await runHttp(dispatch, new FakeRequest('GET', '/auth/login', {
    host: 'gateway.example:3000',
    accept: 'text/html',
  }))
  assertLoginHtmlResponse(html, 404)
  assert.ok(String(html.body).includes('token authentication'))
  assert.ok(!String(html.body).includes('no password login'))

  const json = await runHttp(dispatch, new FakeRequest('GET', '/auth/login', {
    host: 'gateway.example:3000',
    accept: 'application/json',
  }))
  assert.equal(json.status, 404)
  assert.deepEqual(JSON.parse(json.body), { error: 'not_found', code: 'not_found' })
})

test('no-auth deployments answer 404 with the no-password variant, never claiming a token', async () => {
  const auth: AuthProvider = {
    kind: 'none',
    async verify() { return { kind: 'none', id: 'anonymous', issuedAt: 0 } },
  }
  const { dispatch } = setup(auth)
  const html = await runHttp(dispatch, new FakeRequest('GET', '/auth/login', {
    host: 'gateway.example:3000',
    accept: 'text/html',
  }))
  assertLoginHtmlResponse(html, 404)
  assert.ok(String(html.body).includes('no password login'))
  assert.ok(!String(html.body).includes('token'), 'a --no-auth deployment must not claim token auth')
})

test('oversized browser form login stays a JSON 413 and destroys the socket', async () => {
  let loginCalls = 0
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { loginCalls += 1; return {} },
  }
  const { dispatch } = setup(auth)
  const req = new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html',
  })
  const res = new FakeResponse()
  const pending = dispatch.middleware(
    req as unknown as ApiRequest,
    res as unknown as ApiResponse,
    new URL(req.url, 'http://localhost'),
    {} as never,
  )
  queueMicrotask(() => {
    req.emit('data', Buffer.alloc(16 * 1024))
    req.emit('data', Buffer.from('x'))
    const poison = Object.defineProperty({}, 'length', {
      get() { throw new Error('post-limit chunk was inspected') },
    })
    req.emit('data', poison)
    req.emit('end')
  })
  await pending
  assert.equal(res.status, 413)
  assert.equal(JSON.parse(res.body).code, 'body_too_large')
  assert.equal(req.destroyed, true, 'the oversized body destroys the request socket after the 413 is written')
  assert.equal(loginCalls, 0)
})

test('an encrypted socket renders the secure badge and feeds decision.secure to login (C8 wiring)', async () => {
  let loginSecure: boolean | undefined
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login(_body, req) {
      loginSecure = req.secure
      return { setCookie: 'session=cookie; HttpOnly' }
    },
  }
  const { dispatch } = setup(auth)

  // Loopback authority + an encrypted socket → decision.secure === true.
  const get = new FakeRequest('GET', '/auth/login', {
    host: 'localhost:3000',
    accept: 'text/html',
  }, '127.0.0.1')
  get.socket.encrypted = true
  const page = await runHttp(dispatch, get)
  assert.equal(page.status, 200)
  assert.ok(String(page.body).includes('✓ Encrypted connection'))
  assert.ok(!String(page.body).includes('Unencrypted'))

  // The same fact reaches the login provider (the `; Secure` cookie flag).
  const post = new FakeRequest('POST', '/auth/login', {
    host: 'localhost:3000',
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html',
  }, '127.0.0.1')
  post.socket.encrypted = true
  const login = await runHttp(dispatch, post, 'password=hunter2')
  assert.equal(login.status, 302)
  assert.equal(loginSecure, true)
})

test('HEAD /auth/login answers headers without a body (password and token-only modes)', async () => {
  const passwordAuth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { return {} },
  }
  const { dispatch } = setup(passwordAuth)
  const head = await runHttp(dispatch, new FakeRequest('HEAD', '/auth/login', {
    host: 'gateway.example:3000',
    accept: 'text/html',
  }))
  assertLoginHtmlResponse(head, 200)
  assert.equal(head.body, '')

  const tokenAuth: AuthProvider = { kind: 'token', async verify() { return null } }
  const { dispatch: tokenDispatch } = setup(tokenAuth)
  const head404 = await runHttp(tokenDispatch, new FakeRequest('HEAD', '/auth/login', {
    host: 'gateway.example:3000',
    accept: 'text/html',
  }))
  assertLoginHtmlResponse(head404, 404)
  assert.equal(head404.body, '')
})

test('unsupported login media is a JSON 400, never a form render', async () => {
  let loginCalls = 0
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { loginCalls += 1; return {} },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'text/plain',
    accept: 'text/html',
  }), 'password=hunter2')
  assert.equal(res.status, 400)
  assert.match(String(res.headers['content-type']), /^application\/json/)
  assert.deepEqual(JSON.parse(res.body), { error: 'bad request', code: 'bad_request' })
  assert.equal(loginCalls, 0)
})

test('login method exposure is narrow: 405 carries allow and a JSON body', async () => {
  let verifyCalls = 0
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { verifyCalls += 1; return null },
    async login() { return {} },
  }
  const { dispatch } = setup(auth)
  const unsupported = await runHttp(dispatch, new FakeRequest('PUT', '/auth/login', {
    host: 'gateway.example:3000',
  }))
  assert.equal(unsupported.status, 405)
  assert.equal(unsupported.headers.allow, 'GET, HEAD, POST')
  assert.match(String(unsupported.headers['content-type']), /^application\/json/)
  assert.deepEqual(JSON.parse(unsupported.body), { error: 'method not allowed', code: 'method_not_allowed' })
  assert.equal(verifyCalls, 0)
})

test('a cookie with a different name never triggers the expired hint', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { return {} },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('GET', '/', {
    host: 'gateway.example:3000',
    accept: 'text/html',
    cookie: 'other_session=eyJ.x',
  }))
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, '/auth/login')
})

test('GET /auth/login with a valid session cookie still serves the page (public path)', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return { kind: 'password', id: 'user', issuedAt: 0 } },
    async login() { return {} },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('GET', '/auth/login', {
    host: 'gateway.example:3000',
    accept: 'text/html',
    cookie: 'dsh_gateway_session=eyJ.valid',
  }))
  assert.equal(res.status, 200)
  assert.ok(String(res.body).includes('action="/auth/login"'))
})

test('uppercase Accept still negotiates HTML for browser forms', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { throw new Error('invalid password') },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'TEXT/HTML',
  }), 'password=hunter2')
  assertLoginHtmlResponse(res, 401)
  assert.ok(String(res.body).includes('Incorrect password'))
})
