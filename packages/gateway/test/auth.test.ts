/**
 * Gateway auth unit tests (design 17 §5): token (hash-stored, constant-time),
 * none, and the password provider (scrypt + JWT cookie + login + revoke).
 * Run with `node packages/gateway/test/auth.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
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
