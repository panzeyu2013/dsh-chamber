/**
 * Gateway audit tests (design 17 §13.4.4, S24): the append unit surface
 * (JSONL append, 0600, rotation, whitelist serializer — a credential field
 * can never reach disk) and the dispatch login-branch event classification
 * (success / invalid_credentials / rate_limited / busy), with the guarantee
 * that the submitted password and the issued session cookie never appear in
 * the audit trail.
 */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import type { AuthProvider } from '../src/auth.ts'
import { appendAuditEvent, AUDIT_LOG_MAX_BYTES, type AuditEvent } from '../src/audit.ts'
import { parseGatewayConfig } from '../src/config.ts'
import { createGatewayDispatch } from '../src/dispatch.ts'
import { createGatewayRequestPolicy } from '../src/middleware.ts'

// ---------------------------------------------------------------------------
// appendAuditEvent unit surface
// ---------------------------------------------------------------------------

const tmpDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

function readEvents(file: string): Array<Record<string, string>> {
  return readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, string>)
}

test('gateway audit appends JSONL events in order with the given fields', () => {
  const dir = tmpDir('gateway-audit-append-')
  const file = join(dir, 'audit.log')
  appendAuditEvent(file, { ts: '2026-01-01T00:00:00.000Z', event: 'login_success', kind: 'gateway', detail: 'client:203.0.113.8' })
  appendAuditEvent(file, { ts: '2026-01-01T00:00:01.000Z', event: 'login_invalid_credentials', kind: 'gateway' })
  const events = readEvents(file)
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { ts: '2026-01-01T00:00:00.000Z', event: 'login_success', kind: 'gateway', detail: 'client:203.0.113.8' })
  assert.deepEqual(events[1], { ts: '2026-01-01T00:00:01.000Z', event: 'login_invalid_credentials', kind: 'gateway' })
  rmSync(dir, { recursive: true, force: true })
})

test('gateway audit files are 0600 and a loose legacy mode is tightened on append', () => {
  const dir = tmpDir('gateway-audit-mode-')
  const file = join(dir, 'audit.log')
  appendAuditEvent(file, { ts: '2026-01-01T00:00:00.000Z', event: 'login_success' })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  chmodSync(file, 0o644)
  appendAuditEvent(file, { ts: '2026-01-01T00:00:01.000Z', event: 'login_success' })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  rmSync(dir, { recursive: true, force: true })
})

test('gateway audit rotates to <file>.1 past the cap and deletes the old .1', () => {
  const dir = tmpDir('gateway-audit-rotate-')
  const file = join(dir, 'audit.log')
  const maxBytes = 120
  const small: AuditEvent = { ts: '2026-01-01T00:00:00.000Z', event: 'a' }
  const big1: AuditEvent = { ts: '2026-01-01T00:00:01.000Z', event: 'b', detail: 'x'.repeat(300) }
  const big2: AuditEvent = { ts: '2026-01-01T00:00:02.000Z', event: 'c', detail: 'y'.repeat(300) }
  const big3: AuditEvent = { ts: '2026-01-01T00:00:03.000Z', event: 'd', detail: 'z'.repeat(300) }
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
  rmSync(dir, { recursive: true, force: true })
})

test('the gateway audit serializer is a fixed whitelist: credentials never reach disk (S24)', () => {
  const dir = tmpDir('gateway-audit-secret-')
  const file = join(dir, 'audit.log')
  const PASSWORD = 'correct horse battery staple'
  const COOKIE = 'dsh_gateway_session=eyJhbGciOiJIUzI1NiJ9.private'
  appendAuditEvent(file, {
    ts: '2026-01-01T00:00:00.000Z',
    event: 'login_success',
    kind: 'gateway',
    password: PASSWORD,
    cookie: COOKIE,
  } as unknown as AuditEvent)
  const events = readEvents(file)
  assert.equal(events.length, 1)
  assert.deepEqual(Object.keys(events[0]).sort(), ['event', 'kind', 'ts'])
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes(PASSWORD), false)
  assert.equal(raw.includes(COOKIE), false)
  rmSync(dir, { recursive: true, force: true })
})

test('the exported gateway cap is 5 MiB per the design contract', () => {
  assert.equal(AUDIT_LOG_MAX_BYTES, 5 * 1024 * 1024)
})

// ---------------------------------------------------------------------------
// dispatch login-branch event classification
// ---------------------------------------------------------------------------

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

function setup(auth: AuthProvider, auditFile: string) {
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
  const dispatch = createGatewayDispatch(auth, () => proxy as never, () => features as never, (() => ({ async handle() { return false } })) as never, silentLogger, policy, auditFile)
  return { dispatch }
}

async function runLogin(
  dispatch: ReturnType<typeof setup>['dispatch'],
  password: string,
): Promise<FakeResponse> {
  const req = new FakeRequest('POST', '/auth/login', {
    host: 'gateway.example:3000',
    'content-type': 'application/x-www-form-urlencoded',
  })
  const res = new FakeResponse()
  const pending = dispatch.middleware(req as unknown as ApiRequest, res as unknown as ApiResponse, new URL(req.url, 'http://localhost'), {} as never)
  queueMicrotask(() => {
    req.emit('data', Buffer.from(`password=${encodeURIComponent(password)}`))
    req.emit('end')
  })
  await pending
  return res
}

test('login success is audited as login_success without the password or cookie (S24)', async () => {
  const dir = tmpDir('gateway-audit-login-ok-')
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
  rmSync(dir, { recursive: true, force: true })
})

test('login failures are audited by classification: invalid_credentials / rate_limited / busy', async () => {
  const dir = tmpDir('gateway-audit-login-fail-')
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
  rmSync(dir, { recursive: true, force: true })
})

test('no audit file configured → login still works and nothing is written', async () => {
  const dir = tmpDir('gateway-audit-none-')
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
  rmSync(dir, { recursive: true, force: true })
})
