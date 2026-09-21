/**
 * Gateway audit tests (design 17 §13.4.4, S24): the append unit surface
 * (JSONL append, 0600, rotation, whitelist serializer — a credential field
 * can never reach disk) and the dispatch login-branch event classification
 * (success / invalid_credentials / rate_limited / busy), with the guarantee
 * that the submitted password and the issued session cookie never appear in
 * the audit trail.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUDIT_TRAIL_MAX_BYTES, type ApiRequest, type ApiResponse, type AuditTrailEvent } from '@dsh-chamber/control-plane'
import type { AuthProvider } from '../../src/auth.ts'
import { appendAuditEvent } from '../../src/audit.ts'
import { parseGatewayConfig, DEFAULT_MOBILE_ENTRY_PATH } from '../../src/config.ts'
import {
  AUTH_REJECTION_DEBOUNCE_MS,
  MAX_AUTH_REJECTION_WINDOWS,
  createGatewayDispatch,
  type AuthRejectionDebounce,
} from '../../src/dispatch.ts'
import { createGatewayRequestPolicy } from '../../src/middleware.ts'
import { FakeRequest, FakeResponse, gatewayRequest } from '../support/utils.ts'

// ---------------------------------------------------------------------------
// appendAuditEvent unit surface
// ---------------------------------------------------------------------------

const tmpDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

function readEvents(file: string): Array<Record<string, string>> {
  return readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, string>)
}

function captureAuditFailure(operation: () => void): string[] {
  const errors: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    operation()
  } finally {
    console.error = original
  }
  return errors
}

test('gateway audit appends JSONL events in order with the given fields', t => {
  const dir = tmpDir('gateway-audit-append-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  appendAuditEvent(file, { ts: '2026-01-01T00:00:00.000Z', event: 'login_success', kind: 'gateway', detail: 'client:203.0.113.8' })
  appendAuditEvent(file, { ts: '2026-01-01T00:00:01.000Z', event: 'login_invalid_credentials', kind: 'gateway' })
  const events = readEvents(file)
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { ts: '2026-01-01T00:00:00.000Z', event: 'login_success', kind: 'gateway', detail: 'client:203.0.113.8' })
  assert.deepEqual(events[1], { ts: '2026-01-01T00:00:01.000Z', event: 'login_invalid_credentials', kind: 'gateway' })
})

test('gateway audit files are 0600 and a loose legacy mode is tightened on append', t => {
  const dir = tmpDir('gateway-audit-mode-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  appendAuditEvent(file, { ts: '2026-01-01T00:00:00.000Z', event: 'login_success' })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  chmodSync(file, 0o644)
  appendAuditEvent(file, { ts: '2026-01-01T00:00:01.000Z', event: 'login_success' })
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('gateway audit refuses an active symlink without changing its victim content or mode', t => {
  const dir = tmpDir('gateway-audit-active-symlink-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const victim = join(dir, 'active-victim')
  writeFileSync(victim, 'active victim sentinel\n', { mode: 0o640 })
  chmodSync(victim, 0o640)
  symlinkSync(victim, file)
  const before = readFileSync(victim, 'utf8')
  const beforeMode = statSync(victim).mode & 0o777

  const errors = captureAuditFailure(() => {
    appendAuditEvent(file, { ts: '2026-01-01T00:00:00.000Z', event: 'must_not_escape' })
  })

  assert.equal(errors.length, 1, 'unsafe audit evidence is loud but remains non-fatal')
  assert.match(errors[0] ?? '', /append failed/)
  assert.equal(readFileSync(victim, 'utf8'), before)
  assert.equal(statSync(victim).mode & 0o777, beforeMode)
  assert.equal(lstatSync(file).isSymbolicLink(), true, 'the unsafe leaf is preserved as evidence')
})

test('gateway audit refuses a multi-link active inode without modifying the other link', t => {
  const dir = tmpDir('gateway-audit-active-hardlink-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const victim = join(dir, 'hardlink-victim')
  writeFileSync(victim, 'hardlink victim sentinel\n', { mode: 0o640 })
  chmodSync(victim, 0o640)
  linkSync(victim, file)
  const before = readFileSync(victim, 'utf8')
  const beforeMode = statSync(victim).mode & 0o777

  const errors = captureAuditFailure(() => {
    appendAuditEvent(file, { ts: '2026-01-01T00:00:00.000Z', event: 'must_not_escape' })
  })

  assert.equal(errors.length, 1)
  assert.equal(readFileSync(victim, 'utf8'), before)
  assert.equal(statSync(victim).mode & 0o777, beforeMode)
  assert.equal(statSync(victim).nlink, 2)
})

test('gateway audit rotates to <file>.1 past the cap and deletes the old .1', t => {
  const dir = tmpDir('gateway-audit-rotate-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const maxBytes = 120
  const small: AuditTrailEvent = { ts: '2026-01-01T00:00:00.000Z', event: 'a' }
  const big1: AuditTrailEvent = { ts: '2026-01-01T00:00:01.000Z', event: 'b', detail: 'x'.repeat(300) }
  const big2: AuditTrailEvent = { ts: '2026-01-01T00:00:02.000Z', event: 'c', detail: 'y'.repeat(300) }
  const big3: AuditTrailEvent = { ts: '2026-01-01T00:00:03.000Z', event: 'd', detail: 'z'.repeat(300) }
  // Rotation is lazy (checked before the next append): the file may exceed the
  // cap by one event, then the NEXT append rotates it to <file>.1 first.
  appendAuditEvent(file, small, maxBytes)
  appendAuditEvent(file, big1, maxBytes)
  assert.equal(statSync(file).size >= maxBytes, true)
  assert.deepEqual(readEvents(file), [small, big1])
  appendAuditEvent(file, big2, maxBytes)
  assert.deepEqual(readEvents(`${file}.1`), [small, big1], 'the over-cap file moved to <file>.1')
  assert.deepEqual(readEvents(file), [big2])
  appendAuditEvent(file, big3, maxBytes)
  assert.deepEqual(readEvents(`${file}.1`), [big2], 'the old .1 was deleted and replaced by the rotated current file')
  assert.deepEqual(readEvents(file), [big3])
})

test('gateway audit refuses a pre-planted .1 symlink without rotating or changing its victim', t => {
  const dir = tmpDir('gateway-audit-archive-symlink-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const archive = `${file}.1`
  const victim = join(dir, 'archive-victim')
  writeFileSync(file, 'active audit evidence\n', { mode: 0o640 })
  chmodSync(file, 0o640)
  writeFileSync(victim, 'archive victim sentinel\n', { mode: 0o640 })
  chmodSync(victim, 0o640)
  symlinkSync(victim, archive)
  const activeBefore = readFileSync(file, 'utf8')
  const activeMode = statSync(file).mode & 0o777
  const victimBefore = readFileSync(victim, 'utf8')
  const victimMode = statSync(victim).mode & 0o777

  const errors = captureAuditFailure(() => {
    appendAuditEvent(file, { ts: '2026-01-01T00:00:00.000Z', event: 'must_not_rotate' }, 1)
  })

  assert.equal(errors.length, 1, 'unsafe rotation evidence is loud but remains non-fatal')
  assert.equal(readFileSync(file, 'utf8'), activeBefore, 'rotation aborted before touching the active file')
  assert.equal(statSync(file).mode & 0o777, activeMode)
  assert.equal(readFileSync(victim, 'utf8'), victimBefore)
  assert.equal(statSync(victim).mode & 0o777, victimMode)
  assert.equal(lstatSync(archive).isSymbolicLink(), true, 'the unsafe archive is preserved as evidence')
})

test('the gateway audit serializer is a fixed whitelist: credentials never reach disk (S24)', t => {
  const dir = tmpDir('gateway-audit-secret-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const PASSWORD = 'correct horse battery staple'
  const COOKIE = 'dsh_gateway_session=eyJhbGciOiJIUzI1NiJ9.private'
  appendAuditEvent(file, {
    ts: '2026-01-01T00:00:00.000Z',
    event: 'login_success',
    kind: 'gateway',
    password: PASSWORD,
    cookie: COOKIE,
  } as unknown as AuditTrailEvent)
  const events = readEvents(file)
  assert.equal(events.length, 1)
  assert.deepEqual(Object.keys(events[0]).sort(), ['event', 'kind', 'ts'])
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes(PASSWORD), false)
  assert.equal(raw.includes(COOKIE), false)
})

test('the audit rotation cap is 5 MiB per the design contract', _t => {
  // The gateway's default cap IS the shared core constant (audit.ts aliases
  // AUDIT_TRAIL_MAX_BYTES); the gateway entry's own alias was removed with the
  // dead exports (2026-12 audit F23), so the pin targets the single source.
  assert.equal(AUDIT_TRAIL_MAX_BYTES, 5 * 1024 * 1024)
})

// ---------------------------------------------------------------------------
// dispatch login-branch event classification
// ---------------------------------------------------------------------------

const silentLogger = { log() {}, warn() {}, error() {} }

function setup(auth: AuthProvider, auditFile: string, debounce: AuthRejectionDebounce = {}) {
  const config = parseGatewayConfig({
    host: '0.0.0.0',
    port: 3000,
    uiPassword: 'correct-horse-battery',
    publicOrigin: 'http://gateway.example:3000',
    corsOrigins: ['capacitor://localhost'],
  }, '/tmp/gateway-audit-state', '/tmp/dsh')
  const policy = createGatewayRequestPolicy(config)
  const proxy = {
    async handleHttp() {},
    async handleUpgrade() {},
    closeAllStreams() {},
  }
  const features = {
    async handle() { return true },
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
    DEFAULT_MOBILE_ENTRY_PATH,
    debounce,
  )
  return { dispatch }
}

async function runLogin(
  dispatch: ReturnType<typeof setup>['dispatch'],
  password: string,
): Promise<FakeResponse> {
  const req = gatewayRequest('POST', '/auth/login', { 'content-type': 'application/x-www-form-urlencoded' })
  const res = new FakeResponse()
  const pending = dispatch.middleware(req as unknown as ApiRequest, res as unknown as ApiResponse, new URL(req.url, 'http://localhost'), {} as never)
  queueMicrotask(() => {
    req.emit('data', Buffer.from(`password=${encodeURIComponent(password)}`))
    req.emit('end')
  })
  await pending
  return res
}

async function runChange(
  dispatch: ReturnType<typeof setup>['dispatch'],
  path: '/auth/change-password' | '/auth/change-token',
  body: string,
): Promise<FakeResponse> {
  const req = gatewayRequest('POST', path, { 'content-type': 'application/json', authorization: 'Bearer secret' })
  const res = new FakeResponse()
  const pending = dispatch.middleware(req as unknown as ApiRequest, res as unknown as ApiResponse, new URL(req.url, 'http://localhost'), {} as never)
  queueMicrotask(() => {
    req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  await pending
  return res
}

test('login success is audited as login_success without the password or cookie (S24)', async t => {
  const dir = tmpDir('gateway-audit-login-ok-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const PASSWORD = 'correct horse battery staple'
  const COOKIE = 'dsh_gateway_session=eyJhbGciOiJIUzI1NiJ9.private'
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login(_body, req) {
      // A cookie is minted and returned to the response — it must never ride
      // the audit trail.
      assert.equal(req.clientAddress, '203.0.113.8')
      return { setCookie: `${COOKIE}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` }
    },
  }
  const { dispatch } = setup(auth, file)
  const res = await runLogin(dispatch, PASSWORD)
  assert.equal(res.status, 302)
  assert.equal(String(res.headers['set-cookie']).startsWith('dsh_gateway_session='), true)
  const events = readEvents(file)
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'login_success')
  assert.equal(events[0].kind, 'gateway')
  assert.match(events[0].detail ?? '', /client:203\.0\.113\.8/)
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes(PASSWORD), false, 'the submitted password never enters the audit log')
  assert.equal(raw.includes(COOKIE.split('=')[1]), false, 'the session cookie never enters the audit log')
})

test('login failures are audited by classification: invalid_credentials / rate_limited / busy', async t => {
  const dir = tmpDir('gateway-audit-login-fail-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')

  const invalid: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { throw new Error('invalid password') },
  }
  const { dispatch: invalidDispatch } = setup(invalid, file)
  const invalidRes = await runLogin(invalidDispatch, 'wrong-password')
  assert.equal(invalidRes.status, 401)

  const limited: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() {
      const error = new Error('too many login attempts') as Error & { code?: string }
      error.code = 'rate_limited'
      throw error
    },
  }
  const { dispatch: limitedDispatch } = setup(limited, file)
  const limitedRes = await runLogin(limitedDispatch, 'wrong-password')
  assert.equal(limitedRes.status, 429)

  const busy: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() {
      const error = new Error('password verifier is busy') as Error & { code?: string }
      error.code = 'auth_busy'
      throw error
    },
  }
  const { dispatch: busyDispatch } = setup(busy, file)
  const busyRes = await runLogin(busyDispatch, 'wrong-password')
  assert.equal(busyRes.status, 503)

  const events = readEvents(file)
  assert.deepEqual(events.map(event => event.event), [
    'login_invalid_credentials',
    'login_rate_limited',
    'login_busy',
  ])
  assert.equal(events[0].detail, 'client:203.0.113.8,code:invalid_credentials')
  assert.equal(events[1].detail, 'client:203.0.113.8,code:rate_limited')
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes('wrong-password'), false, 'the attempted password never enters the audit log')
})

test('no audit file configured → login still works and nothing is written', async t => {
  const dir = tmpDir('gateway-audit-none-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { return { setCookie: 'dsh_gateway_session=abc; HttpOnly' } },
  }
  const config = parseGatewayConfig({
    host: '0.0.0.0',
    port: 3000,
    uiPassword: 'correct-horse-battery',
    publicOrigin: 'http://gateway.example:3000',
    corsOrigins: ['capacitor://localhost'],
  }, '/tmp/gateway-audit-state-none', '/tmp/dsh')
  const policy = createGatewayRequestPolicy(config)
  const dispatch = createGatewayDispatch(auth, () => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} }) as never, () => ({ async handle() { return true }, start() {}, stop() {} }) as never, (() => ({ async handle() { return false } })) as never, silentLogger, policy)
  const res = await runLogin(dispatch, 'correct-horse-battery')
  assert.equal(res.status, 302)
  assert.throws(() => statSync(file), /ENOENT/)
})

// ---------------------------------------------------------------------------
// auth-gate rejection audit (design 17 §13.4.4: 认证成功/失败（401/403 分类）)
// ---------------------------------------------------------------------------

/** Drive one request through the dispatch middleware (public host authority
 * unless the caller overrides it). */
async function runRequest(
  dispatch: ReturnType<typeof setup>['dispatch'],
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
  remoteAddress = '203.0.113.8',
): Promise<FakeResponse> {
  const req = new FakeRequest(method, path, { host: 'gateway.example:3000', ...headers }, remoteAddress)
  const res = new FakeResponse()
  const pending = dispatch.middleware(req as unknown as ApiRequest, res as unknown as ApiResponse, new URL(req.url, 'http://localhost'), {} as never)
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  await pending
  return res
}

/** Deterministic clock + window-end scheduler for the M3-5 rejection debounce:
 * no real timers, so a window closes exactly when the test says so. */
function debounceHarness(): {
  options: AuthRejectionDebounce
  advance(ms: number): void
  fire(): void
} {
  let at = 1_700_000_000_000
  const scheduled: Array<{ flush: () => void }> = []
  return {
    options: {
      now: () => at,
      windowMs: AUTH_REJECTION_DEBOUNCE_MS,
      schedule: (flush) => {
        const entry = { flush }
        scheduled.push(entry)
        return () => {
          const index = scheduled.indexOf(entry)
          if (index !== -1) scheduled.splice(index, 1)
        }
      },
    },
    advance: (ms) => { at += ms },
    fire: () => {
      while (scheduled.length > 0) scheduled.shift()!.flush()
    },
  }
}

test('auth-gate rejections are audited once each: 400/401/403/421 with code + client + path category only', async t => {
  const dir = tmpDir('gateway-audit-gate-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const BEARER = 'Bearer BEARER-SECRET-VALUE'
  const QUERY = 'capability=QUERY-SECRET-VALUE'
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
  }
  const { dispatch } = setup(auth, file)

  // 401 — no valid credential, on a query-bearing API path: neither the
  // submitted bearer nor the query string may reach the trail.
  const unauthorized = await runRequest(dispatch, 'GET', `/api/connections?${QUERY}`, { authorization: BEARER })
  assert.equal(unauthorized.status, 401)
  // 403 — valid authority, cross-site initiator origin.
  const forbidden = await runRequest(dispatch, 'POST', '/api/i/local/chamber/plugins/installed', { origin: 'https://evil.example' })
  assert.equal(forbidden.status, 403)
  // 421 — an authority this gateway does not answer for.
  const misdirected = await runRequest(dispatch, 'GET', '/api/connections', { host: 'attacker.example' })
  assert.equal(misdirected.status, 421)
  // 400 — duplicate Authorization field lines (raw-header boundary).
  const malformed = gatewayRequest('GET', '/plugins/index.js')
  Object.assign(malformed, { rawHeaders: ['authorization', 'Bearer one', 'authorization', 'Bearer two'] })
  const malformedRes = new FakeResponse()
  const pendingMalformed = dispatch.middleware(
    malformed as unknown as ApiRequest,
    malformedRes as unknown as ApiResponse,
    new URL(malformed.url, 'http://localhost'),
    {} as never,
  )
  queueMicrotask(() => { malformed.emit('end') })
  await pendingMalformed
  assert.equal(malformedRes.status, 400)

  const events = readEvents(file)
  assert.deepEqual(events.map(event => event.event), [
    'auth_rejected', 'auth_rejected', 'auth_rejected', 'auth_rejected',
  ])
  assert.deepEqual(events.map(event => event.detail), [
    'code:unauthorized,client:203.0.113.8,path:api',
    'code:origin_forbidden,client:203.0.113.8,path:api',
    'code:misdirected_request,client:203.0.113.8,path:api',
    'code:bad_request,client:203.0.113.8,path:plugins',
  ])
  assert.deepEqual(events.map(event => event.kind), ['gateway', 'gateway', 'gateway', 'gateway'])
  // The whitelist serializer's field set stays fixed.
  assert.deepEqual(Object.keys(events[0]!).sort(), ['detail', 'event', 'kind', 'ts'])
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes('BEARER-SECRET-VALUE'), false, 'the refused credential never enters the audit log')
  assert.equal(raw.includes('QUERY-SECRET-VALUE'), false, 'the request query never enters the audit log')
  assert.equal(raw.includes('/api/connections'), false, 'the concrete path is replaced by its category')
  assert.equal(raw.includes('evil.example'), false, 'the refused Origin value is not echoed into the audit detail')
})

test('a rejected request writes exactly one event; a successful login adds no gate rejection (no double audit)', async t => {
  const dir = tmpDir('gateway-audit-gate-once-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const auth: AuthProvider = {
    kind: 'password',
    async verify() { return null },
    async login() { return { setCookie: 'dsh_gateway_session=abc; Path=/; HttpOnly' } },
  }
  const clock = debounceHarness()
  const { dispatch } = setup(auth, file, clock.options)

  const rejected = await runRequest(dispatch, 'GET', '/api/connections')
  assert.equal(rejected.status, 401)
  assert.deepEqual(readEvents(file).map(event => event.event), ['auth_rejected'])

  // /auth/login is PUBLIC: the auth gate never runs for it, so a successful
  // login records its own login_success and nothing else.
  const login = await runLogin(dispatch, 'correct horse battery staple')
  assert.equal(login.status, 302)
  assert.deepEqual(readEvents(file).map(event => event.event), ['auth_rejected', 'login_success'])

  // A repeated refusal is still ONE event per window (M3-5 coalescing, not a
  // duplicate from the same request): nothing is appended for the in-window
  // repeat, and the login event above is untouched.
  const second = await runRequest(dispatch, 'GET', '/api/connections')
  assert.equal(second.status, 401)
  assert.deepEqual(readEvents(file).map(event => event.event), ['auth_rejected', 'login_success'])

  // The window closes with exactly one counted record for the two refusals.
  clock.fire()
  const events = readEvents(file)
  assert.deepEqual(events.map(event => event.event), ['auth_rejected', 'login_success', 'auth_rejected'])
  assert.equal(events[2]!.detail, 'code:unauthorized,client:203.0.113.8,path:api,count:2')
})

/** The debounced-audit fixture: a rejected-login provider, a fresh audit file
 *  and a controllable clock; returns the dispatch plus both fixtures. */
function auditFixture(
  t: { after(fn: () => void): void },
  prefix = 'gateway-audit-debounce-',
  auth: AuthProvider = { kind: 'password', async verify() { return null } },
): { file: string; clock: ReturnType<typeof debounceHarness>; dispatch: ReturnType<typeof setup>['dispatch'] } {
  const dir = tmpDir(prefix)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const clock = debounceHarness()
  const { dispatch } = setup(auth, file, clock.options)
  return { file, clock, dispatch }
}

test('in-window duplicate refusals coalesce into one record with count:N; the first lands immediately (M3-5)', async t => {
  const { file, clock, dispatch } = auditFixture(t)

  // The named window constant is the window the dispatch actually uses.
  assert.equal(AUTH_REJECTION_DEBOUNCE_MS, 1000)

  // N identical refusals (same client, code and path category) inside ONE
  // window: every one still answers 401 — the debounce changes the audit
  // write count, never the verdict.
  const N = 5
  for (let attempt = 0; attempt < N; attempt += 1) {
    const res = await runRequest(dispatch, 'GET', '/api/connections')
    assert.equal(res.status, 401)
    clock.advance(100)
  }

  // ③ The FIRST refusal is already on disk — never deferred to the window end.
  const immediate = readEvents(file)
  assert.equal(immediate.length, 1, 'the opening refusal is appended before the window closes')
  assert.equal(immediate[0]!.event, 'auth_rejected')
  assert.equal(immediate[0]!.kind, 'gateway')
  assert.equal(immediate[0]!.detail, 'code:unauthorized,client:203.0.113.8,path:api')

  // ② The window's duplicates collapse into ONE aggregate record whose count is
  // N — a burst of N writes 2 lines (immediate anchor + aggregate), never N.
  clock.fire()
  const events = readEvents(file)
  assert.equal(events.length, 2, 'the in-window duplicates never append per request')
  assert.equal(events[1]!.event, 'auth_rejected')
  assert.equal(events[1]!.kind, 'gateway')
  assert.equal(events[1]!.detail, 'code:unauthorized,client:203.0.113.8,path:api,count:5')
  // The whitelist field set is unchanged and the concrete path never appears.
  assert.deepEqual(Object.keys(events[1]!).sort(), ['detail', 'event', 'kind', 'ts'])
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes('/api/connections'), false, 'the path category stays the only path evidence')

  // The window closes the BURST, not the class: a later identical refusal opens
  // a new window and is again written immediately.
  clock.advance(AUTH_REJECTION_DEBOUNCE_MS)
  const after = await runRequest(dispatch, 'GET', '/api/connections')
  assert.equal(after.status, 401)
  assert.equal(readEvents(file).length, 3, 'a new window starts with its own immediate record')
})

test('the rejection debounce never merges different clients, codes or path categories (M3-5)', async t => {
  const { file, clock, dispatch } = auditFixture(t, 'gateway-audit-debounce-keys-')

  // Same client + code, a DIFFERENT path category.
  assert.equal((await runRequest(dispatch, 'GET', '/api/connections')).status, 401)
  assert.equal((await runRequest(dispatch, 'GET', '/')).status, 401)
  // Same code + category, a DIFFERENT client address.
  assert.equal((await runRequest(dispatch, 'GET', '/api/connections', {}, undefined, '203.0.113.9')).status, 401)
  // Same client + category, a DIFFERENT code.
  const forbidden = await runRequest(dispatch, 'POST', '/api/i/local/chamber/plugins/installed', { origin: 'https://evil.example' })
  assert.equal(forbidden.status, 403)
  clock.advance(50)

  assert.deepEqual(readEvents(file).map(event => event.detail), [
    'code:unauthorized,client:203.0.113.8,path:api',
    'code:unauthorized,client:203.0.113.8,path:root',
    'code:unauthorized,client:203.0.113.9,path:api',
    'code:origin_forbidden,client:203.0.113.8,path:api',
  ])
  // Every window held a single refusal: the window-end flush appends nothing —
  // no false merge across keys and no empty aggregate records.
  clock.fire()
  assert.equal(readEvents(file).length, 4)
})

test('dispatch quiesce drains an open debounce window so its count is not lost (M3-5)', async t => {
  const { file, clock, dispatch } = auditFixture(t, 'gateway-audit-debounce-quiesce-')

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await runRequest(dispatch, 'GET', '/api/connections')).status, 401)
    clock.advance(10)
  }
  assert.equal(readEvents(file).length, 1, 'the burst is still open: only the anchor is on disk')

  // Shutdown publishes the counts held in memory before ownership is released.
  await dispatch.quiesce()
  const events = readEvents(file)
  assert.equal(events.length, 2)
  assert.equal(events[1]!.detail, 'code:unauthorized,client:203.0.113.8,path:api,count:3')
})

test('a refusal after the window elapsed but before its timer publishes the old count first (M3-5)', async t => {
  const { file, clock, dispatch } = auditFixture(t, 'gateway-audit-debounce-elapsed-')

  assert.equal((await runRequest(dispatch, 'GET', '/api/connections')).status, 401)
  clock.advance(10)
  assert.equal((await runRequest(dispatch, 'GET', '/api/connections')).status, 401)
  // The window is over, but its end-of-window timer has NOT run (the fake
  // scheduler only fires when the test says so). The next identical refusal
  // must publish the open count BEFORE it opens the successor window —
  // otherwise the successor would swallow the first window's total.
  clock.advance(AUTH_REJECTION_DEBOUNCE_MS)
  assert.equal((await runRequest(dispatch, 'GET', '/api/connections')).status, 401)
  const events = readEvents(file)
  assert.deepEqual(events.map(event => event.detail), [
    'code:unauthorized,client:203.0.113.8,path:api',
    'code:unauthorized,client:203.0.113.8,path:api,count:2',
    'code:unauthorized,client:203.0.113.8,path:api',
  ])
  // The successor window is still open; the late timer for the closed one must
  // not touch it (entry identity is pinned).
  clock.fire()
  assert.equal(readEvents(file).length, 3)
})

test('flushAuditWindows publishes a window opened after the fence-time drain (M3-5)', async t => {
  const { file, clock, dispatch } = auditFixture(t, 'gateway-audit-debounce-post-close-')

  // Nothing open at the fence: no window existed, so no audit file was written.
  await dispatch.quiesce()
  assert.equal(existsSync(file), false, 'a drain with no open window writes nothing')
  // A refusal accepted between the fence and the listener close still reaches
  // the audit path and opens a window the fence-time drain could not see.
  assert.equal((await runRequest(dispatch, 'GET', '/api/connections')).status, 401)
  clock.advance(10)
  assert.equal((await runRequest(dispatch, 'GET', '/api/connections')).status, 401)
  assert.equal(readEvents(file).length, 1, 'only the anchor is on disk while the window is open')
  // The gateway calls this once the listener is closed; the count lands.
  dispatch.flushAuditWindows()
  const events = readEvents(file)
  assert.equal(events.length, 2)
  assert.equal(events[1]!.detail, 'code:unauthorized,client:203.0.113.8,path:api,count:2')
  // Idempotent: a second call has nothing left to publish.
  dispatch.flushAuditWindows()
  assert.equal(readEvents(file).length, 2)
})

test('the window map is bounded: at the cap the oldest window is published early (M3-5)', async t => {
  const { file, dispatch } = auditFixture(t, 'gateway-audit-debounce-cap-')

  // The oldest key carries two refusals, so its early publication is visible.
  assert.equal((await runRequest(dispatch, 'GET', '/api/connections')).status, 401)
  assert.equal((await runRequest(dispatch, 'GET', '/api/connections')).status, 401)
  assert.equal(readEvents(file).length, 1)
  // Distinct client identities are unbounded in production; fill the map to the
  // cap and then open one more window.
  for (let index = 0; index < MAX_AUTH_REJECTION_WINDOWS; index += 1) {
    const address = `10.0.${Math.floor(index / 250)}.${index % 250}`
    assert.equal((await runRequest(dispatch, 'GET', '/api/connections', {}, undefined, address)).status, 401)
  }
  const events = readEvents(file)
  // Every distinct key wrote its opening anchor; the FIRST key additionally got
  // its aggregate published early, when the cap was reached and the oldest
  // window had to make room (it lands mid-loop, before the newest anchor).
  // Without the cap that aggregate would only land at shutdown — asserting its
  // presence here, before any drain, is the cap's observable effect.
  assert.equal(events.length, MAX_AUTH_REJECTION_WINDOWS + 2)
  const aggregates = events.filter(event => event.detail.includes('count:'))
  assert.deepEqual(aggregates.map(event => event.detail), ['code:unauthorized,client:203.0.113.8,path:api,count:2'])
  // Every remaining window held a single refusal, and the newest key is still
  // open: draining at shutdown publishes nothing more.
  await dispatch.quiesce()
  assert.equal(readEvents(file).length, MAX_AUTH_REJECTION_WINDOWS + 2)
})

test('no audit file configured → gate rejections still answer without writing', async t => {
  const dir = tmpDir('gateway-audit-gate-none-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const auth: AuthProvider = { kind: 'password', async verify() { return null } }
  const config = parseGatewayConfig({
    host: '0.0.0.0',
    port: 3000,
    uiPassword: 'correct-horse-battery',
    publicOrigin: 'http://gateway.example:3000',
    corsOrigins: ['capacitor://localhost'],
  }, '/tmp/gateway-audit-state-gate-none', '/tmp/dsh')
  const dispatch = createGatewayDispatch(
    auth,
    () => ({ async handleHttp() {}, async handleUpgrade() {}, closeAllStreams() {} }) as never,
    () => ({ async handle() { return true }, start() {}, stop() {} }) as never,
    (() => ({ async handle() { return false } })) as never,
    silentLogger,
    createGatewayRequestPolicy(config),
  )
  const res = await runRequest(dispatch, 'GET', '/api/connections')
  assert.equal(res.status, 401)
  assert.throws(() => statSync(file), /ENOENT/)
})

// ---------------------------------------------------------------------------
// credential_changed / credential_change_rejected event shapes (Phase 2)
// ---------------------------------------------------------------------------

test('credential changes are audited as credential_changed with only non-secret detail (S24)', async t => {
  const dir = tmpDir('gateway-audit-change-ok-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const auth: AuthProvider = {
    kind: 'password+token',
    async verify(req) {
      return req.headers.authorization === 'Bearer secret'
        ? { kind: 'token', id: 'x', issuedAt: 0 }
        : null
    },
    async changeToken() {
      return { changed: true, kind: 'token', source: 'runtime', removed: true }
    },
  }
  const { dispatch } = setup(auth, file)
  const removeRes = await runChange(dispatch, '/auth/change-token', JSON.stringify({ remove: true }))
  assert.equal(removeRes.status, 200)

  // The set-password half (detail 'password,set,runtime,…' + raw-secret
  // exclusion) is covered on a real store by
  // dispatch-credential-routes.test.ts:395-427; the remove detail is unique.
  const events = readEvents(file)
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'credential_changed')
  assert.equal(events[0].kind, 'gateway')
  assert.equal(events[0].detail, 'token,remove,runtime,principal:token,client:203.0.113.8')
  // The serializer is a fixed whitelist: no extra fields, no secrets.
  assert.deepEqual(Object.keys(events[0]).sort(), ['detail', 'event', 'kind', 'ts'])
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes('secret'), false, 'the bearer token never enters the audit log')
})

test('credential change failures are audited as credential_change_rejected with the wire code', async t => {
  const dir = tmpDir('gateway-audit-change-fail-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const cases: Array<{ path: '/auth/change-password' | '/auth/change-token'; code: string; status: number; detail: string }> = [
    { path: '/auth/change-password', code: 'invalid_credentials', status: 401, detail: 'password,invalid_credentials,client:203.0.113.8' },
    { path: '/auth/change-password', code: 'last_credential', status: 409, detail: 'password,last_credential,client:203.0.113.8' },
    { path: '/auth/change-token', code: 'rate_limited', status: 429, detail: 'token,rate_limited,client:203.0.113.8' },
  ]
  let index = 0
  const auth: AuthProvider = {
    kind: 'password+token',
    async verify(req) {
      return req.headers.authorization === 'Bearer secret'
        ? { kind: 'token', id: 'x', issuedAt: 0 }
        : null
    },
    async changePassword() {
      const { code } = cases[index]
      const error = new Error(code) as Error & { code?: string }
      error.code = code
      throw error
    },
    async changeToken() {
      const { code } = cases[index]
      const error = new Error(code) as Error & { code?: string }
      error.code = code
      throw error
    },
  }
  const { dispatch } = setup(auth, file)
  for (const entry of cases) {
    const body = entry.code === 'invalid_credentials'
      ? JSON.stringify({ newPassword: 'x'.repeat(12), currentPassword: 'wrong' })
      : JSON.stringify({ remove: true })
    const res = await runChange(dispatch, entry.path, body)
    assert.equal(res.status, entry.status, entry.code)
    assert.equal(JSON.parse(res.body).code, entry.code)
    index += 1
  }
  const events = readEvents(file)
  assert.deepEqual(events.map(event => event.event), ['credential_change_rejected', 'credential_change_rejected', 'credential_change_rejected'])
  assert.deepEqual(events.map(event => event.detail), cases.map(entry => entry.detail))
  assert.deepEqual(events.map(event => event.kind), ['gateway', 'gateway', 'gateway'])
})
