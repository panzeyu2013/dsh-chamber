/** No-listen composition tests for gateway boundary → auth → route dispatch. */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import { createAuth, type AuthProvider } from '../src/auth.ts'
import { parseGatewayConfig } from '../src/config.ts'
import { createGatewayDispatch } from '../src/dispatch.ts'
import { createGatewayRequestPolicy } from '../src/middleware.ts'
import { createGatewayStore, hashCredential, type GatewayStore } from '../src/store.ts'

const silentLogger = { log() {}, warn() {}, error() {} }
const PASSWORD = 'correct-horse-battery'
const NEW_PASSWORD = 'a-new-correct-password'
const TOKEN = '0123456789abcdef0123456789abcdef'

class FakeRequest extends EventEmitter {
  readonly headers: Record<string, string>
  readonly method: string
  readonly url: string
  readonly socket: { remoteAddress: string; encrypted?: boolean }
  destroyed = false
  // Mirrors Node's paused-mode IncomingMessage: body bytes emitted before a
  // 'data' listener attaches are buffered (the dispatch middleware awaits
  // auth before readBody() on the gated credential routes). Data replays when
  // the first 'data' listener attaches; 'end' replays when an 'end' listener
  // attaches — never inside the 'data' attach (the 'end' listener may not
  // exist yet, and a bare EventEmitter would drop the event).
  private pendingBody: Array<{ type: 'data'; chunk: Buffer } | { type: 'end' }> = []
  constructor(method: string, url: string, headers: Record<string, string>, remoteAddress = '203.0.113.8') {
    super()
    this.method = method
    this.url = url
    this.headers = headers
    this.socket = { remoteAddress }
  }
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener)
    if (event === 'data') {
      for (const entry of this.pendingBody) {
        if (entry.type === 'data') super.emit('data', entry.chunk)
      }
      this.pendingBody = this.pendingBody.filter(entry => entry.type !== 'data')
    }
    if (event === 'end') {
      const endIndex = this.pendingBody.findIndex(entry => entry.type === 'end')
      if (endIndex !== -1) {
        this.pendingBody.splice(endIndex, 1)
        super.emit('end')
      }
    }
    return this
  }
  override emit(event: string | symbol, ...args: any[]): boolean {
    if ((event === 'data' || event === 'end') && this.listenerCount('data') === 0) {
      this.pendingBody.push(event === 'data' ? { type: 'data', chunk: args[0] as Buffer } : { type: 'end' })
      return true
    }
    return super.emit(event, ...args)
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
  auditFile?: string,
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
  const dispatch = createGatewayDispatch(auth, () => proxy as never, () => features as never, runtime as never, silentLogger, policy, auditFile)
  return { dispatch, get httpProxyCalls() { return httpProxyCalls }, get upgradeProxyCalls() { return upgradeProxyCalls } }
}

/** Real-store auth facade on a temp stateDir (with an optional audit file). */
function realAuth(options: { config: Parameters<typeof createAuth>[0]; auditFile?: boolean }): {
  auth: AuthProvider
  store: GatewayStore
  dir: string
  auditFile: string
  cleanup(): void
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-dispatch-'))
  const store = createGatewayStore(dir, silentLogger)
  const auth = createAuth(options.config, store)
  const auditFile = join(dir, 'audit.log')
  return {
    auth,
    store,
    dir,
    auditFile: options.auditFile === false ? '' : auditFile,
    cleanup() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function readAudit(file: string): Array<Record<string, string>> {
  return readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, string>)
}

async function loginCookie(auth: AuthProvider, password: string, address = '203.0.113.8'): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const result = await auth.login!({ password }, { headers: {}, socketAddr: address })
  const cookie = /dsh_gateway_session=([^;]+)/.exec(result.setCookie ?? '')?.[1]
  assert.ok(cookie !== undefined, 'login must issue a session cookie')
  return cookie
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

// ---------------------------------------------------------------------------
// Phase 2: runtime credential management routes (/auth/change-password,
// /auth/change-token, /auth/credentials) — all behind the auth gate.
// ---------------------------------------------------------------------------

test('the credential management routes are authenticated and OPTIONS stays public', async () => {
  let verifyCalls = 0
  const auth: AuthProvider = {
    kind: 'password+token',
    async verify() { verifyCalls += 1; return null },
  }
  const { dispatch } = setup(auth)
  for (const [method, path] of [
    ['GET', '/auth/change-password'],
    ['POST', '/auth/change-password'],
    ['GET', '/auth/change-token'],
    ['POST', '/auth/change-token'],
    ['GET', '/auth/credentials'],
    ['POST', '/auth/credentials'],
  ] as const) {
    const res = await runHttp(dispatch, new FakeRequest(method, path, { host: 'gateway.example:3000' }))
    assert.equal(res.status, 401, `${method} ${path}`)
  }
  const beforePreflight = verifyCalls
  const preflight = await runHttp(dispatch, new FakeRequest('OPTIONS', '/auth/change-password', {
    host: 'gateway.example:3000',
    origin: 'capacitor://localhost',
  }))
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], 'capacitor://localhost')
  assert.equal(verifyCalls, beforePreflight, 'OPTIONS preflight never reaches auth')
})

test('POST /auth/change-password: a bearer-token principal changes the password, kills old cookies, and audits credential_changed', async () => {
  const { auth, auditFile, cleanup } = realAuth({ config: { kind: 'password+token', password: PASSWORD, token: TOKEN } })
  try {
    const cookie = await loginCookie(auth, PASSWORD)
    const state = setup(auth, undefined, auditFile)
    const res = await runHttp(state.dispatch, new FakeRequest('POST', '/auth/change-password', {
      host: 'gateway.example:3000',
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    }), JSON.stringify({ newPassword: NEW_PASSWORD }))
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { changed: true, kind: 'password', source: 'runtime' })
    assert.equal(res.headers['cache-control'], 'no-store')

    // The jwt-secret was rotated FIRST: the old cookie is immediately dead.
    const oldCookie = await runHttp(state.dispatch, new FakeRequest('GET', '/', {
      host: 'gateway.example:3000',
      cookie: `dsh_gateway_session=${cookie}`,
    }))
    assert.equal(oldCookie.status, 401, 'the old session cookie is invalidated by the change')

    // The success audit carries ONLY the non-secret detail (S24).
    const events = readAudit(auditFile)
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'credential_changed')
    assert.equal(events[0].kind, 'gateway')
    assert.equal(events[0].detail, 'password,set,runtime,principal:token,client:203.0.113.8')
    const raw = readFileSync(auditFile, 'utf8')
    assert.equal(raw.includes(TOKEN), false, 'the bearer token never enters the audit log')
    assert.equal(raw.includes(NEW_PASSWORD), false, 'the new password never enters the audit log')

    // The new password logs in through the wire.
    const relogin = await runHttp(state.dispatch, new FakeRequest('POST', '/auth/login', {
      host: 'gateway.example:3000',
      'content-type': 'application/json',
    }), JSON.stringify({ password: NEW_PASSWORD }))
    assert.equal(relogin.status, 302)
    assert.equal(state.httpProxyCalls, 0, 'the change route never falls through to the dsh proxy')
  } finally { cleanup() }
})

test('POST /auth/change-password: a cookie-only principal without the current password is 403 ambient_principal_rejected', async () => {
  const { auth, auditFile, cleanup } = realAuth({ config: { kind: 'password+token', password: PASSWORD, token: TOKEN } })
  try {
    const cookie = await loginCookie(auth, PASSWORD)
    const { dispatch } = setup(auth, undefined, auditFile)
    const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/change-password', {
      host: 'gateway.example:3000',
      'content-type': 'application/json',
      cookie: `dsh_gateway_session=${cookie}`,
    }), JSON.stringify({ newPassword: NEW_PASSWORD }))
    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).code, 'ambient_principal_rejected')
    const events = readAudit(auditFile)
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'credential_change_rejected')
    assert.equal(events[0].detail, 'password,ambient_principal_rejected,client:203.0.113.8')
  } finally { cleanup() }
})

test('POST /auth/change-password: a wrong current password is 401 and repeated failures rate-limit to 429', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'password', password: PASSWORD } })
  try {
    const cookie = await loginCookie(auth, PASSWORD)
    const { dispatch } = setup(auth)
    const headers = {
      host: 'gateway.example:3000',
      'content-type': 'application/json',
      cookie: `dsh_gateway_session=${cookie}`,
    }
    let lastStatus = 0
    let lastBody = ''
    for (let i = 0; i < 11; i += 1) {
      const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/change-password', headers),
        JSON.stringify({ newPassword: NEW_PASSWORD, currentPassword: 'wrong-password' }))
      lastStatus = res.status
      lastBody = res.body
    }
    assert.equal(lastStatus, 429)
    assert.equal(JSON.parse(lastBody).code, 'rate_limited')
    assert.match(JSON.parse(lastBody).error, /retry/)
  } finally { cleanup() }
})

test('POST /auth/change-password: removing the last credential with no config replacement is 409 last_credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-dispatch-last-'))
  let store: GatewayStore | null = null
  try {
    // Seed a runtime-managed password with NO config replacement (source
    // 'runtime'): config seeding never overwrites it, and removing it is the
    // last-credential case (no token, no config password to revert to).
    store = createGatewayStore(dir, silentLogger)
    store.setPasswordCredential(hashCredential(NEW_PASSWORD), 'runtime')
    store.close()
    store = createGatewayStore(dir, silentLogger)
    const auth = createAuth({ kind: 'none' }, store)
    assert.equal(auth.kind, 'password', 'the runtime credential survives config seeding')
    const cookie = await loginCookie(auth, NEW_PASSWORD, '203.0.113.8')
    const { dispatch } = setup(auth)
    const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/change-password', {
      host: 'gateway.example:3000',
      'content-type': 'application/json',
      cookie: `dsh_gateway_session=${cookie}`,
    }), JSON.stringify({ remove: true, currentPassword: NEW_PASSWORD }))
    assert.equal(res.status, 409)
    assert.equal(JSON.parse(res.body).code, 'last_credential')
  } finally {
    store?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('oversized credential-change bodies are 413 and destroy the request socket', async () => {
  let changeCalls = 0
  const auth: AuthProvider = {
    kind: 'password+token',
    async verify() { return { kind: 'token', id: 'x', issuedAt: 0 } },
    async changePassword() { changeCalls += 1; return { changed: true, kind: 'password', source: 'runtime' } },
    async changeToken() { changeCalls += 1; return { changed: true, kind: 'token', source: 'runtime', token: 'x' } },
  }
  const { dispatch } = setup(auth)
  const req = new FakeRequest('POST', '/auth/change-password', {
    host: 'gateway.example:3000',
    'content-type': 'application/json',
    authorization: 'Bearer secret',
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
    req.emit('end')
  })
  await pending
  assert.equal(res.status, 413)
  assert.equal(JSON.parse(res.body).code, 'body_too_large')
  assert.equal(req.destroyed, true, 'the oversized body destroys the request socket after the 413 is written')
  assert.equal(changeCalls, 0, 'the change never runs against an oversized body')
})

test('POST /auth/change-token returns the new plaintext token exactly once and it authenticates', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'token', token: TOKEN } })
  try {
    const { dispatch } = setup(auth)
    const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/change-token', {
      host: 'gateway.example:3000',
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    }), JSON.stringify({}))
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    const body = JSON.parse(res.body) as { changed: true; kind: 'token'; source: 'runtime'; token?: string }
    assert.equal(body.changed, true)
    assert.equal(body.kind, 'token')
    assert.equal(body.source, 'runtime')
    assert.ok(typeof body.token === 'string' && body.token.length >= 32 && body.token.length <= 4096)
    assert.match(body.token, /^[\x20-\x7e]+$/)

    // The old token is dead; the new one authenticates through the wire.
    const oldToken = await runHttp(dispatch, new FakeRequest('GET', '/', {
      host: 'gateway.example:3000',
      authorization: `Bearer ${TOKEN}`,
    }))
    assert.equal(oldToken.status, 401)
    const newToken = await runHttp(dispatch, new FakeRequest('GET', '/', {
      host: 'gateway.example:3000',
      authorization: `Bearer ${body.token}`,
    }))
    assert.equal(newToken.status, 200)
    assert.equal(newToken.body, 'proxied')
  } finally { cleanup() }
})

test('GET /auth/credentials returns the non-secret projection without any secret value (S5)', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'password+token', password: PASSWORD, token: TOKEN } })
  try {
    const { dispatch } = setup(auth)
    const res = await runHttp(dispatch, new FakeRequest('GET', '/auth/credentials', {
      host: 'gateway.example:3000',
      authorization: `Bearer ${TOKEN}`,
    }))
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    const body = JSON.parse(res.body) as {
      password: { set: true; source: string; updatedAt: number } | null
      token: { set: true; source: string; updatedAt: number } | null
    }
    assert.deepEqual(Object.keys(body).sort(), ['password', 'token'])
    assert.equal(body.password?.set, true)
    assert.equal(body.password?.source, 'config')
    assert.equal(typeof body.password?.updatedAt, 'number')
    assert.equal(body.token?.set, true)
    assert.equal(body.token?.source, 'config')
    assert.equal(typeof body.token?.updatedAt, 'number')
    assert.equal(res.body.includes('scrypt'), false, 'the verifier/hash never appears in the projection')
    assert.equal(res.body.includes(TOKEN), false, 'the plaintext token never appears in the projection')

    // The projection is read-only: only GET/HEAD are allowed (405, allow: GET, HEAD).
    const put = await runHttp(dispatch, new FakeRequest('PUT', '/auth/credentials', {
      host: 'gateway.example:3000',
      authorization: `Bearer ${TOKEN}`,
    }))
    assert.equal(put.status, 405)
    assert.equal(put.headers.allow, 'GET, HEAD')
    assert.equal(JSON.parse(put.body).code, 'method_not_allowed')
  } finally { cleanup() }
})

test('GET /auth/credentials reports a null dimension when no credential is configured', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'token', token: TOKEN } })
  try {
    const { dispatch } = setup(auth)
    const res = await runHttp(dispatch, new FakeRequest('GET', '/auth/credentials', {
      host: 'gateway.example:3000',
      authorization: `Bearer ${TOKEN}`,
    }))
    const body = JSON.parse(res.body) as { password: unknown; token: { set: true; source: string } }
    assert.equal(body.password, null)
    assert.equal(body.token.set, true)
    assert.equal(body.token.source, 'config')
  } finally { cleanup() }
})

test('a token-only deployment answers 404 on /auth/login (the route exists only in password form)', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'token', token: TOKEN } })
  try {
    assert.equal(auth.kind, 'token')
    const { dispatch } = setup(auth)
    const post = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
      host: 'gateway.example:3000',
      'content-type': 'application/json',
    }), JSON.stringify({ password: 'whatever' }))
    assert.equal(post.status, 404)
    assert.equal(JSON.parse(post.body).code, 'not_found')
    const get = await runHttp(dispatch, new FakeRequest('GET', '/auth/login', { host: 'gateway.example:3000' }))
    assert.equal(get.status, 404)
  } finally { cleanup() }
})

test('a no_password login error (kind race fallback) maps to 404', async () => {
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() {
      const error = new Error('password login is not configured') as Error & { code?: string }
      error.code = 'no_password'
      throw error
    },
  }
  const { dispatch } = setup(auth)
  const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/json',
  }), JSON.stringify({ password: 'x' }))
  assert.equal(res.status, 404)
  assert.equal(JSON.parse(res.body).code, 'not_found')
})

test('the credential routes are claimed by dispatch and never reach the dsh proxy', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'password+token', password: PASSWORD, token: TOKEN } })
  try {
    const state = setup(auth)
    const change = await runHttp(state.dispatch, new FakeRequest('POST', '/auth/change-password', {
      host: 'gateway.example:3000',
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    }), JSON.stringify({ newPassword: NEW_PASSWORD }))
    assert.equal(change.status, 200)
    assert.equal(state.httpProxyCalls, 0, '/auth/change-password never falls through to the proxy')
    const credentials = await runHttp(state.dispatch, new FakeRequest('GET', '/auth/credentials', {
      host: 'gateway.example:3000',
      authorization: `Bearer ${TOKEN}`,
    }))
    assert.equal(credentials.status, 200)
    assert.equal(state.httpProxyCalls, 0, '/auth/credentials never falls through to the proxy')
  } finally { cleanup() }
})

test('S25 wire: an anonymous (kind none) deployment cannot plant credentials via the API', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'none' } })
  try {
    const { dispatch } = setup(auth)
    // The auth gate passes the anonymous none principal, then the change
    // proof gate refuses — the wire answer is 401 invalid_credentials and
    // nothing is persisted.
    const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/change-password', {
      host: 'gateway.example:3000',
      'content-type': 'application/json',
    }), JSON.stringify({ newPassword: NEW_PASSWORD }))
    assert.equal(res.status, 401)
    assert.equal(JSON.parse(res.body).code, 'invalid_credentials')
    assert.equal(auth.credentialProjection?.().password, null)
  } finally { cleanup() }
})

test('HEAD /auth/credentials is the no-body twin of GET', async () => {
  const { auth, store, cleanup } = realAuth({ config: { kind: 'password', password: PASSWORD } })
  try {
    const cookie = await loginCookie(auth, PASSWORD)
    const { dispatch } = setup(auth)
    const head = await runHttp(dispatch, new FakeRequest('HEAD', '/auth/credentials', {
      host: 'gateway.example:3000',
      cookie: `dsh_gateway_session=${cookie}`,
      accept: 'text/html',
    }))
    assert.equal(head.status, 200)
    assert.equal(head.body, '', 'HEAD carries no body')
    const get = await runHttp(dispatch, new FakeRequest('GET', '/auth/credentials', {
      host: 'gateway.example:3000',
      cookie: `dsh_gateway_session=${cookie}`,
    }))
    assert.equal(get.status, 200)
    assert.equal(JSON.parse(get.body).password.set, true)
  } finally { cleanup() }
})

test('unauthenticated HTML-accept requests to /auth/* answer 401 JSON, not a login redirect', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'password', password: PASSWORD } })
  try {
    const { dispatch } = setup(auth)
    // /auth/* is a JSON API surface: an unauthenticated browser navigation
    // must not be silently redirected to the login page (fix round).
    const res = await runHttp(dispatch, new FakeRequest('GET', '/auth/credentials', {
      host: 'gateway.example:3000',
      accept: 'text/html',
    }))
    assert.equal(res.status, 401)
    assert.equal(JSON.parse(res.body).code, 'unauthorized')
    assert.equal(res.headers.location, undefined, 'no login redirect for /auth/*')
  } finally { cleanup() }
})

test('a failing audit probe records probe-error:<code> without rejecting the change (S24)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-probe-'))
  const auditFile = join(dir, 'audit.log')
  let verifyCalls = 0
  const auth: AuthProvider = {
    kind: 'token',
    async verify() {
      verifyCalls += 1
      // Only the audit PROBE (2nd verify: gate already passed) fails — a
      // saturated work gate must not mislabel the audit as 'unauthenticated'.
      if (verifyCalls === 2) throw Object.assign(new Error('password verifier is busy'), { code: 'auth_busy' })
      return { kind: 'token', id: 'shared-token', issuedAt: Date.now() }
    },
    async changeToken() {
      return { changed: true, kind: 'token', source: 'runtime', token: 'new-token-value' }
    },
  }
  try {
    const { dispatch } = setup(auth, undefined, auditFile)
    const res = await runHttp(dispatch, new FakeRequest('POST', '/auth/change-token', {
      host: 'gateway.example:3000',
      authorization: 'Bearer token-value',
      'content-type': 'application/json',
    }), '{}')
    assert.equal(res.status, 200, 'the change itself is never rejected by a probe failure')
    const events = readAudit(auditFile)
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'credential_changed')
    assert.match(events[0].detail ?? '', /principal:probe-error:auth_busy/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('authenticated non-POST requests to the change routes answer 405 allow: POST', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'token', token: TOKEN } })
  try {
    const { dispatch } = setup(auth)
    const get = await runHttp(dispatch, new FakeRequest('GET', '/auth/change-password', {
      host: 'gateway.example:3000',
      authorization: `Bearer ${TOKEN}`,
    }))
    assert.equal(get.status, 405)
    assert.equal(get.headers.allow, 'POST')
    assert.equal(JSON.parse(get.body).code, 'method_not_allowed')
  } finally { cleanup() }
})

test('HEAD /auth/login is the no-body twin of GET', async () => {
  const { auth, cleanup } = realAuth({ config: { kind: 'password', password: PASSWORD } })
  try {
    const { dispatch } = setup(auth)
    const head = await runHttp(dispatch, new FakeRequest('HEAD', '/auth/login', {
      host: 'gateway.example:3000',
      accept: 'text/html',
    }))
    assert.equal(head.status, 200)
    assert.equal(head.body, '', 'HEAD carries no login-page body')
  } finally { cleanup() }
})
