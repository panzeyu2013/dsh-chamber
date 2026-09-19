/** No-listen composition tests for gateway boundary → auth → route dispatch.
 *
 * P0 split siblings: dispatch-credential-routes.test.ts and
 * boundary-login-page.test.ts; shared helpers live in
 * test/support/dispatch-harness.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import { type AuthProvider } from '../../src/auth.ts'
import { FakeRequest, FakeResponse, gatewayRequest } from '../support/utils.ts'
import { TOKEN, setup, realAuth, readAudit, runHttp } from '../support/dispatch-harness.ts'

test('login page has a self form-action and accepts its form-urlencoded body', async () => {
  let loginBody: unknown
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login(body) { loginBody = body; return { setCookie: 'session=cookie; HttpOnly' } },
  }
  const { dispatch } = setup(auth)
  const get = await runHttp(dispatch, gatewayRequest('GET', '/auth/login'))
  assert.equal(get.status, 200)
  assert.match(String(get.headers['content-security-policy']), /form-action 'self'/)
  assert.doesNotMatch(String(get.headers['content-security-policy']), /script-src/)

  const post = await runHttp(dispatch, gatewayRequest('POST', '/auth/login', { 'content-type': 'application/x-www-form-urlencoded' }), 'password=hunter2')
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
  const req = gatewayRequest('POST', '/auth/login', { 'content-type': 'application/json' })
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

  const unsupported = await runHttp(dispatch, gatewayRequest('PUT', '/auth/login'))
  assert.equal(unsupported.status, 405)
  assert.equal(unsupported.headers.allow, 'GET, HEAD, POST')
  assert.equal(verifyCalls, 0)

  const navigation = await runHttp(dispatch, gatewayRequest('GET', '/', { accept: 'text/html,application/xhtml+xml' }))
  assert.equal(navigation.status, 302)
  assert.equal(navigation.headers.location, '/auth/login')

  const api = await runHttp(dispatch, gatewayRequest('GET', '/api/connections', { accept: 'text/html' }))
  assert.equal(api.status, 401)

  const healthMutation = await runHttp(dispatch, gatewayRequest('POST', '/health'))
  assert.equal(healthMutation.status, 401)

  const asset = await runHttp(dispatch, gatewayRequest('GET', '/assets/app.js', { accept: '*/*' }))
  assert.equal(asset.status, 401)
  assert.equal(verifyCalls, 4)
})

test('gateway claims Authorization preflight before auth on every route family', async () => {
  let verifyCalls = 0
  const auth: AuthProvider = { kind: 'token', async verify() { verifyCalls += 1; return null } }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, gatewayRequest('OPTIONS', '/chamber/settings', { origin: 'capacitor://localhost' }))
  assert.equal(res.status, 204)
  assert.match(String(res.headers['access-control-allow-headers']), /authorization/)
  assert.equal(res.headers['access-control-allow-origin'], 'capacitor://localhost')
  assert.equal(verifyCalls, 0)
})

test('a forbidden external origin is rejected before auth or dsh proxying', async () => {
  let verifyCalls = 0
  const auth: AuthProvider = { kind: 'token', async verify() { verifyCalls += 1; return { kind: 'token', id: 'x', issuedAt: 0 } } }
  const state = setup(auth)
  const res = await runHttp(state.dispatch, gatewayRequest('POST', '/api/session/create', { origin: 'http://attacker.example' }))
  assert.equal(res.status, 403)
  assert.equal(verifyCalls, 0)
  assert.equal(state.httpProxyCalls, 0)
})

test('boundary rejections: browsers get the HTML error page, API clients keep JSON + detail', async () => {
  const auth: AuthProvider = { kind: 'token', async verify() { return null } }
  const { dispatch } = setup(auth)

  // A browser document navigation from another site (no Origin, cross-site
  // sec-fetch) is answered with the rendered HTML page — never raw JSON.
  const html = await runHttp(dispatch, gatewayRequest('GET', '/', { 'sec-fetch-site': 'cross-site', accept: 'text/html,application/xhtml+xml' }))
  assert.equal(html.status, 403)
  assert.match(String(html.headers['content-type']), /^text\/html/)
  assert.match(String(html.headers['content-security-policy']), /form-action 'self'/)
  assert.match(String(html.headers['content-security-policy']), /img-src data:/)
  assert.doesNotMatch(String(html.headers['content-security-policy']), /script-src/)
  const page = String(html.body)
  assert.match(page, /<!doctype html>/i)
  assert.ok(page.includes('Access denied'))
  assert.ok(page.includes('no Origin header'))
  assert.doesNotMatch(page, /<script/i)
  assert.doesNotMatch(page, /value="/)

  // A browser form POST with a mismatched Origin also renders HTML.
  const htmlPost = await runHttp(dispatch, gatewayRequest('POST', '/auth/login', { origin: 'http://attacker.example', accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' }))
  assert.equal(htmlPost.status, 403)
  assert.match(String(htmlPost.headers['content-type']), /^text\/html/)
  assert.ok(String(htmlPost.body).includes('origin'), 'the page explains the failing check')

  // An API client without an HTML Accept keeps the JSON shape + additive detail.
  const api = await runHttp(dispatch, gatewayRequest('POST', '/api/session/create', { origin: 'http://attacker.example', accept: 'application/json' }))
  assert.equal(api.status, 403)
  assert.match(String(api.headers['content-type']), /application\/json/)
  const body = JSON.parse(String(api.body)) as { error: string; code: string; detail?: string }
  assert.equal(body.code, 'origin_forbidden')
  assert.equal(body.error, 'request origin is not allowed')
  assert.ok(body.detail !== undefined && /attacker\.example/.test(body.detail), 'JSON clients get a non-secret detail line')

  // HEAD browsers get the HTML headers and status, no body.
  const head = await runHttp(dispatch, gatewayRequest('HEAD', '/', { 'sec-fetch-site': 'cross-site', accept: 'text/html' }))
  assert.equal(head.status, 403)
  assert.match(String(head.headers['content-type']), /^text\/html/)
  assert.equal(String(head.body), '')
})

test('a host-rejected browser GET renders the 421 page with the offending Host', async () => {
  const auth: AuthProvider = { kind: 'token', async verify() { return null } }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('GET', '/', {
    host: '203.0.113.9:3000',
    accept: 'text/html',
  }))
  assert.equal(res.status, 421)
  const page = String(res.body)
  assert.ok(page.includes('203.0.113.9:3000'), 'the offending Host value is shown')
  assert.ok(page.includes('HTTP 421'))
  assert.match(String(res.headers['content-type']), /^text\/html/)
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
  await state.dispatch.upgradeMiddleware(new FakeRequest('GET', '/api/remote.mux', {
    host: '192.168.1.10:3000',
  }) as unknown as ApiRequest, badSocket as never, Buffer.alloc(0), {} as never)
  assert.match(rejection, /421 Misdirected Request/)
  assert.equal(verifyCalls, 0)

  const goodSocket = { end() {}, destroy() {} }
  await state.dispatch.upgradeMiddleware(gatewayRequest('GET', '/api/remote.mux', { origin: 'http://gateway.example:3000', authorization: 'Bearer secret' }) as unknown as ApiRequest, goodSocket as never, Buffer.alloc(0), {} as never)
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
  await state.dispatch.upgradeMiddleware(gatewayRequest('GET', '/\\\\attacker.example/api/remote.mux', { authorization: 'Bearer secret' }) as unknown as ApiRequest, socket as never, Buffer.alloc(0), {} as never)
  assert.match(rejection, /400 Bad Request/)
  assert.equal(verifyCalls, 0)
  assert.equal(state.upgradeProxyCalls, 0)
})

test('WS auth-boundary rejections are audited as auth_rejected (401/421/400) without the refused credential', async () => {
  const { auth, auditFile, cleanup } = realAuth({ config: { kind: 'token', token: TOKEN } })
  try {
    const { dispatch } = setup(auth, undefined, auditFile)
    const reject = async (req: FakeRequest): Promise<string> => {
      let rejection = ''
      const socket = { end(value: string) { rejection = value }, destroy() {} }
      await dispatch.upgradeMiddleware(req as unknown as ApiRequest, socket as never, Buffer.alloc(0), {} as never)
      return rejection
    }
    const refused = await reject(gatewayRequest('GET', '/api/remote.mux?capability=QUERY-SECRET', { authorization: `Bearer ${'f'.repeat(32)}` }))
    assert.match(refused, /401 Unauthorized/)
    const misdirected = await reject(new FakeRequest('GET', '/api/remote.mux', { host: 'attacker.example' }))
    assert.match(misdirected, /421 Misdirected Request/)
    const badTarget = await reject(gatewayRequest('GET', '/\\\\attacker.example/api/remote.mux'))
    assert.match(badTarget, /400 Bad Request/)

    // The same §13.4.4 projection as the HTTP gate: code + client + path
    // category (the malformed target has no category to record).
    const events = readAudit(auditFile)
    assert.deepEqual(events.map(event => event.event), ['auth_rejected', 'auth_rejected', 'auth_rejected'])
    assert.deepEqual(events.map(event => event.detail), [
      'code:unauthorized,client:203.0.113.8,path:api',
      'code:misdirected_request,client:203.0.113.8,path:api',
      'code:bad_request,client:203.0.113.8',
    ])
    const raw = readFileSync(auditFile, 'utf8')
    assert.equal(raw.includes('f'.repeat(32)), false, 'the refused bearer token never enters the audit log')
    assert.equal(raw.includes('QUERY-SECRET'), false, 'the request query never enters the audit log')
  } finally { cleanup() }
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
  const res = await runHttp(dispatch, gatewayRequest('GET', '/api/connections', { authorization: 'Bearer whatever' }))
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
  await state.dispatch.upgradeMiddleware(gatewayRequest('GET', '/api/remote.mux', { authorization: 'Bearer whatever' }) as unknown as ApiRequest, socket as never, Buffer.alloc(0), {} as never)
  assert.match(rejection, /503 Service Unavailable/)
  assert.match(rejection, /auth_busy/)
  assert.equal(state.upgradeProxyCalls, 0, 'a busy verify never reaches the proxy')
})
