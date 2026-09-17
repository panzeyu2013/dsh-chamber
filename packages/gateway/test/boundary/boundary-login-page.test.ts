/**
 * Boundary login page and proxied-frontend CSP: HTML/JSON negotiation, expired
 * hints, rate-limit/auth_busy pages and the login response header set. Split
 * from dispatch-composition.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import { type AuthProvider } from '../../src/auth.ts'
import { FakeRequest, FakeResponse } from '../support/utils.ts'
import { TOKEN, setup, realAuth, runHttp } from '../support/dispatch-harness.ts'

// ── Proxied dsh frontend CSP (M2-4a) ──

test('the proxied frontend CSP keeps base-uri on self so the upstream <base href="/"> survives', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'token', token: TOKEN } })
  try {
    const { dispatch } = setup(auth)
    const res = await runHttp(dispatch, new FakeRequest('GET', '/', {
      host: 'gateway.example:3000',
      authorization: `Bearer ${TOKEN}`,
    }))
    assert.equal(res.status, 200)
    assert.equal(res.body, 'proxied')
    const csp = String(res.headers['content-security-policy'])
    // @deepseek-ai/dsh-host-frontend-static injects <base href="/"> into every
    // document it renders from index.html; `base-uri 'none'` makes the browser
    // refuse that element. Whether that costs a white screen is version-
    // dependent (in the pinned tree serveStatic renders the index only for the
    // dist root and the index path, where relative asset URLs already resolve),
    // so the allowance is recorded as "the element must stay effective", not as
    // "a deep link was once broken". Regression locked here (GATEWAY_PROXY_CSP
    // in packages/gateway/src/dispatch.ts).
    assert.match(csp, /base-uri 'self'/)
    assert.doesNotMatch(csp, /base-uri 'none'/)
    assert.equal(
      csp,
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-src blob:; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:",
    )

    // Cross-package lockstep (2026-12 review): the design claims "every other
    // directive is word-for-word the shell's nonce CSP". The literal above
    // cannot see that — it only restates the gateway constant. Compare against
    // the SHELL CSP the control plane actually emits (read from its source, the
    // same peer-source discipline the other lockstep tests use) and require the
    // two to differ in exactly `base-uri` and `script-src`.
    const shellSource = readFileSync(new URL('../../../control-plane/src/index.ts', import.meta.url), 'utf8')
    const shellCsp: string | undefined = shellSource.match(/`(default-src 'self'; base-uri 'none';[^`]*?)`/)?.[1]
    assert.ok(shellCsp !== undefined, 'the control-plane shell CSP template must stay greppable')
    const directives = (value: string): Map<string, string> => new Map(value.split(';').map(part => {
      const [name = '', ...rest] = part.trim().split(/\s+/)
      return [name, rest.join(' ')] as const
    }))
    const shell = directives(shellCsp.replace(/\$\{cspNonce\}/g, 'NONCE'))
    const gateway = directives(csp)
    assert.deepEqual([...gateway.keys()], [...shell.keys()], 'the directive SETS must match')
    const differing = [...gateway.keys()].filter(name => gateway.get(name) !== shell.get(name))
    assert.deepEqual(differing, ['base-uri', 'script-src'],
      'only the two documented directives may differ from the shell CSP')
    assert.equal(shell.get('base-uri'), "'none'")
    assert.equal(gateway.get('base-uri'), "'self'")
    // script-src keeps every shell source and trades the per-response nonce for
    // 'unsafe-inline' in place (the placeholder compares equal on both sides).
    assert.equal(gateway.get('script-src'), shell.get('script-src')?.replace("'nonce-NONCE'", "'unsafe-inline'"))
  } finally { cleanup() }
})

// ── Gateway login-page behavior (rendered by src/login-page.ts) ──

/** Every HTML login response must carry the full header set: the no-script
 * login CSP (C1), no-store, and nosniff (design 17 §7.1). `referrer-policy`
 * is `same-origin` — never `no-referrer`: per the fetch spec "append a
 * request Origin header" algorithm (2019; Chromium + WebKit r259036/2020),
 * a no-referrer document makes same-origin form POSTs carry `Origin: null`,
 * which the gateway's own origin fence rejects fail-closed (403
 * origin_forbidden — live finding 2026-09, reproduced on Chrome 151; curl
 * without an Origin was never affected, which is why only browsers hit it). */
function assertLoginHtmlResponse(res: FakeResponse, status: number): void {
  assert.equal(res.status, status)
  assert.match(String(res.headers['content-type']), /^text\/html/)
  const csp = String(res.headers['content-security-policy'])
  assert.match(csp, /form-action 'self'/)
  assert.match(csp, /img-src data:/)
  assert.doesNotMatch(csp, /script-src/)
  assert.equal(String(res.headers['cache-control']), 'no-store')
  assert.equal(String(res.headers['referrer-policy']), 'same-origin')
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
