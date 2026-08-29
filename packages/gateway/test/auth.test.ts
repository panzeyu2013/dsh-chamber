/**
 * Gateway auth unit tests (design 17 §5): token (hash-stored, constant-time),
 * none, and the password provider (scrypt + JWT cookie + login + revoke).
 * Run with `node packages/gateway/test/auth.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth } from '../src/auth.ts'
import { createGatewayStore } from '../src/store.ts'

const silentLogger = { log() {}, warn() {}, error() {} }
const TOKEN = '0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct-horse-battery'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-auth-'))
  const store = createGatewayStore(dir, silentLogger)
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function signSessionPayload(secret: string, payloadJson: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(payloadJson).toString('base64url')
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

test('token provider accepts a matching bearer (hash-stored)', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const principal = await auth.verify({ headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '' })
    assert.equal(principal?.kind, 'token')
    // The plaintext token is never persisted — only its salted scrypt hash.
    assert.notEqual(store.getTokenHash(), TOKEN)
    assert.match(store.getTokenHash() ?? '', /^scrypt\$[a-f0-9]+\$[a-f0-9]{64}$/i)
  } finally { cleanup() }
})

test('token provider rejects a wrong bearer', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const principal = await auth.verify({ headers: { authorization: 'Bearer wrong' }, socketAddr: '' })
    assert.equal(principal, null)
  } finally { cleanup() }
})

test('token provider accepts a case-insensitive scheme', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const principal = await auth.verify({ headers: { authorization: `bearer ${TOKEN}` }, socketAddr: '' })
    assert.equal(principal?.kind, 'token')
  } finally { cleanup() }
})

test('token provider rejects a missing header', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const principal = await auth.verify({ headers: {}, socketAddr: '' })
    assert.equal(principal, null)
  } finally { cleanup() }
})

test('token provider enforces the inbound Bearer bounds before persisted-hash or scrypt work', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const originalGetTokenHash = store.getTokenHash.bind(store)
    let hashReads = 0
    store.getTokenHash = () => {
      hashReads += 1
      return originalGetTokenHash()
    }

    const malformed: Array<string | string[]> = [
      `Bearer ${'x'.repeat(31)}`,
      `Bearer ${'x'.repeat(4097)}`,
      `Bearer ${'x'.repeat(31)}\x7f`,
      `Bearer\t${TOKEN}`,
      [`Bearer ${TOKEN}`, 'Bearer attacker-controlled-second-value'],
    ]
    for (const authorization of malformed) {
      assert.equal(await auth.verify({ headers: { authorization }, socketAddr: '' }), null)
    }
    assert.equal(hashReads, 0, 'malformed wire credentials must not reach the verifier/scrypt path')
  } finally { cleanup() }
})

test('token provider accepts the exact 4096-character inbound maximum', async () => {
  const { store, cleanup } = tempStore()
  try {
    const token = 'x'.repeat(4096)
    const auth = createAuth({ kind: 'token', token }, store)
    const principal = await auth.verify({ headers: { authorization: `Bearer ${token}` }, socketAddr: '' })
    assert.equal(principal?.kind, 'token')
  } finally { cleanup() }
})

test('none provider always authenticates', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'none' }, store)
    const principal = await auth.verify({ headers: {}, socketAddr: '' })
    assert.equal(principal?.kind, 'none')
  } finally { cleanup() }
})

test('password: login with the correct password yields a verifiable session cookie', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    const req = { headers: {}, socketAddr: '127.0.0.1' }
    const result = await auth.login!({ password: PASSWORD }, req)
    assert.ok(result.setCookie !== undefined)
    const cookieValue = /dsh_gateway_session=([^;]+)/.exec(result.setCookie)?.[1]
    assert.ok(cookieValue !== undefined)
    const principal = await auth.verify({ headers: { cookie: `dsh_gateway_session=${cookieValue}` }, socketAddr: '' })
    assert.equal(principal?.kind, 'password')
  } finally { cleanup() }
})

test('password: login with a wrong password rejects', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    await assert.rejects(() => auth.login!({ password: 'wrong' }, { headers: {}, socketAddr: '127.0.0.1' }))
  } finally { cleanup() }
})

test('password: revoke rotates the secret and invalidates the session', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    const result = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    const cookieValue = /dsh_gateway_session=([^;]+)/.exec(result.setCookie ?? '')?.[1]
    assert.ok(cookieValue !== undefined)
    const before = await auth.verify({ headers: { cookie: `dsh_gateway_session=${cookieValue}` }, socketAddr: '' })
    assert.equal(before?.kind, 'password')
    await auth.revoke!({ kind: 'password', id: 'user', issuedAt: Date.now() })
    const after = await auth.verify({ headers: { cookie: `dsh_gateway_session=${cookieValue}` }, socketAddr: '' })
    assert.equal(after, null)
  } finally { cleanup() }
})

test('password: crafted signed sessions require an integral finite exp inside the 12h horizon', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    const now = Math.floor(Date.now() / 1000)
    const invalidPayloads: Array<[string, string]> = [
      ['missing exp', JSON.stringify({ sub: 'user', iat: now })],
      ['string exp', JSON.stringify({ sub: 'user', iat: now, exp: String(now + 60) })],
      ['null exp', JSON.stringify({ sub: 'user', iat: now, exp: null })],
      ['non-finite exp', `{"sub":"user","iat":${now},"exp":1e400}`],
      ['fractional exp', JSON.stringify({ sub: 'user', iat: now, exp: now + 60.5 })],
      ['unsafe exp', JSON.stringify({ sub: 'user', iat: now, exp: Number.MAX_SAFE_INTEGER + 1 })],
      ['expired exp', JSON.stringify({ sub: 'user', iat: now, exp: now })],
      ['negative exp', JSON.stringify({ sub: 'user', iat: now, exp: -1 })],
      ['beyond 12h exp', JSON.stringify({ sub: 'user', iat: now, exp: now + 12 * 3600 + 1 })],
    ]
    for (const [label, payload] of invalidPayloads) {
      const jwt = signSessionPayload(store.getJwtSecret(), payload)
      const principal = await auth.verify({
        headers: { cookie: `dsh_gateway_session=${jwt}` },
        socketAddr: '',
      })
      assert.equal(principal, null, label)
    }

    const boundaryJwt = signSessionPayload(store.getJwtSecret(), JSON.stringify({
      sub: 'user',
      iat: now,
      exp: now + 12 * 3600,
    }))
    assert.equal((await auth.verify({
      headers: { cookie: `dsh_gateway_session=${boundaryJwt}` },
      socketAddr: '',
    }))?.kind, 'password')
  } finally { cleanup() }
})

test('password: changing configuration across restart invalidates old cookies', async () => {
  const { dir, store, cleanup } = tempStore()
  try {
    const first = createAuth({ kind: 'password', password: PASSWORD }, store)
    const login = await first.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)

    const restartedStore = createGatewayStore(dir, silentLogger)
    const second = createAuth({ kind: 'password', password: 'different-correct-password' }, restartedStore)
    assert.equal(await second.verify({
      headers: { cookie: `dsh_gateway_session=${cookie}` },
      socketAddr: '127.0.0.1',
    }), null)
  } finally { cleanup() }
})

test('password+token composition accepts both bearer and cookie principals', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    assert.equal(auth.kind, 'password+token')
    const bearer = await auth.verify({ headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8' })
    assert.equal(bearer?.kind, 'token')
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8', secure: true })
    assert.match(login.setCookie ?? '', /; Secure(?:;|$)/)
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)
    const browser = await auth.verify({ headers: { cookie: `dsh_gateway_session=${cookie}` }, socketAddr: '203.0.113.8' })
    assert.equal(browser?.kind, 'password')
  } finally { cleanup() }
})

test('password+token composition preserves a valid cookie when the bearer verifier is saturated', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' })
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)

    const wrongToken = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('x') ? 'y' : 'x'}`
    // The provider owns a 2-active + 32-queued scrypt gate. Invoke all 34
    // blockers before yielding so the following request deterministically
    // reaches auth_busy without timing assumptions about scrypt completion.
    const blockers = Array.from({ length: 34 }, () => auth.verify({
      headers: { authorization: `Bearer ${wrongToken}` },
      socketAddr: '203.0.113.9',
    }))

    const cookieFallback = await auth.verify({
      headers: {
        authorization: `Bearer ${TOKEN}`,
        cookie: `dsh_gateway_session=${cookie}`,
      },
      socketAddr: '203.0.113.8',
    })
    assert.equal(cookieFallback?.kind, 'password')

    await assert.rejects(
      auth.verify({
        headers: {
          authorization: `Bearer ${TOKEN}`,
          cookie: 'dsh_gateway_session=invalid',
        },
        socketAddr: '203.0.113.8',
      }),
      (error: Error & { code?: string }) => error.code === 'auth_busy',
    )
    await Promise.all(blockers)
  } finally { cleanup() }
})

test('password limiter ignores caller-supplied XFF unless the boundary validated it', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    let lastCode: string | undefined
    for (let i = 0; i < 11; i += 1) {
      try {
        await auth.login!({ password: 'wrong' }, {
          headers: { 'x-forwarded-for': `198.51.100.${i}` },
          socketAddr: '203.0.113.8',
        })
      } catch (error) {
        lastCode = (error as Error & { code?: string }).code
      }
    }
    assert.equal(lastCode, 'rate_limited')
  } finally { cleanup() }
})
