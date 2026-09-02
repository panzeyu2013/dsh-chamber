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
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import type { AuthProvider } from '../src/auth.ts'
import { appendAuditEvent, AUDIT_LOG_MAX_BYTES, type AuditEvent } from '../src/audit.ts'
import { parseGatewayConfig } from '../src/config.ts'
import { createGatewayDispatch } from '../src/dispatch.ts'
import { createGatewayRequestPolicy } from '../src/middleware.ts'
import { FakeRequest, FakeResponse } from './utils.ts'

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
  } as unknown as AuditEvent)
  const events = readEvents(file)
  assert.equal(events.length, 1)
  assert.deepEqual(Object.keys(events[0]).sort(), ['event', 'kind', 'ts'])
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes(PASSWORD), false)
  assert.equal(raw.includes(COOKIE), false)
})

test('the exported gateway cap is 5 MiB per the design contract', _t => {
  assert.equal(AUDIT_LOG_MAX_BYTES, 5 * 1024 * 1024)
})

// ---------------------------------------------------------------------------
// dispatch login-branch event classification
// ---------------------------------------------------------------------------

const silentLogger = { log() {}, warn() {}, error() {} }

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

async function runChange(
  dispatch: ReturnType<typeof setup>['dispatch'],
  path: '/auth/change-password' | '/auth/change-token',
  body: string,
): Promise<FakeResponse> {
  const req = new FakeRequest('POST', path, {
    host: 'gateway.example:3000',
    'content-type': 'application/json',
    authorization: 'Bearer secret',
  })
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
// credential_changed / credential_change_rejected event shapes (Phase 2)
// ---------------------------------------------------------------------------

test('credential changes are audited as credential_changed with only non-secret detail (S24)', async t => {
  const dir = tmpDir('gateway-audit-change-ok-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.log')
  const NEW_PASSWORD = 'a-new-correct-password'
  const auth: AuthProvider = {
    kind: 'password+token',
    async verify(req) {
      return req.headers.authorization === 'Bearer secret'
        ? { kind: 'token', id: 'x', issuedAt: 0 }
        : null
    },
    async changePassword() {
      return { changed: true, kind: 'password', source: 'runtime' }
    },
    async changeToken() {
      return { changed: true, kind: 'token', source: 'runtime', removed: true }
    },
  }
  const { dispatch } = setup(auth, file)
  const setRes = await runChange(dispatch, '/auth/change-password', JSON.stringify({ newPassword: NEW_PASSWORD }))
  assert.equal(setRes.status, 200)
  const removeRes = await runChange(dispatch, '/auth/change-token', JSON.stringify({ remove: true }))
  assert.equal(removeRes.status, 200)

  const events = readEvents(file)
  assert.equal(events.length, 2)
  assert.equal(events[0].event, 'credential_changed')
  assert.equal(events[0].kind, 'gateway')
  assert.equal(events[0].detail, 'password,set,runtime,principal:token,client:203.0.113.8')
  assert.equal(events[1].event, 'credential_changed')
  assert.equal(events[1].detail, 'token,remove,runtime,principal:token,client:203.0.113.8')
  // The serializer is a fixed whitelist: no extra fields, no secrets.
  assert.deepEqual(Object.keys(events[0]).sort(), ['detail', 'event', 'kind', 'ts'])
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes(NEW_PASSWORD), false, 'the new password never enters the audit log')
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
