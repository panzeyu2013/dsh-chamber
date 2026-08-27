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
