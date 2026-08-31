/**
 * Gateway auth unit tests (design 17 §5/§7): token (hash-stored,
 * constant-time), none, the password provider (scrypt + JWT cookie + login),
 * and Phase 1 runtime credential changes (changePassword/changeToken:
 * proofs, rotate-first, last-credential gate, revert, restart survival).
 * Run with `node packages/gateway/test/auth.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth } from '../src/auth.ts'
import { createGatewayStore, hashCredential, verifyCredential, type GatewayStore } from '../src/store.ts'

const silentLogger = { log() {}, warn() {}, error() {} }
const TOKEN = '0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct-horse-battery'
const NEW_PASSWORD = 'a-new-correct-password'
const RUNTIME_PASSWORD = 'runtime-correct-password'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-auth-'))
  const stores: GatewayStore[] = []
  const open = () => {
    const store = createGatewayStore(dir, silentLogger)
    stores.push(store)
    return store
  }
  const store = open()
  return {
    dir,
    store,
    open,
    cleanup: () => {
      for (const s of stores) s.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
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

test('auth kind shares the generation presence snapshot instead of re-reading disk', () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    store.getPasswordCredential = () => { throw new Error('unexpected password disk read') }
    store.getTokenHash = () => { throw new Error('unexpected token disk read') }
    assert.equal(auth.kind, 'password+token')
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

test('a deferred old-token verification cannot authenticate after token rotation', async () => {
  const { store, cleanup } = tempStore()
  try {
    let releaseOld!: () => void
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let deferOldToken = true
    const auth = createAuth(
      { kind: 'password+token', password: PASSWORD, token: TOKEN },
      store,
      silentLogger,
      {
        verifyCredentialAsync: async (plain, stored) => {
          if (plain === TOKEN && deferOldToken) {
            deferOldToken = false
            markStarted()
            await oldGate
          }
          return stored !== null && verifyCredential(plain, stored)
        },
      },
    )
    const oldVerdict = auth.verify({
      headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8',
    })
    await started
    const nextToken = 'fedcba9876543210fedcba9876543210'
    await auth.changeToken!({ newToken: nextToken, currentPassword: PASSWORD }, {
      headers: {}, socketAddr: '203.0.113.8',
    })
    releaseOld()

    assert.equal(await oldVerdict, null, 'the old scrypt result is fenced by the credential generation')
    assert.equal((await auth.verify({
      headers: { authorization: `Bearer ${nextToken}` }, socketAddr: '203.0.113.8',
    }))?.kind, 'token')
  } finally { cleanup() }
})

test('a deferred old-password login cannot sign a cookie with the post-rotation jwt secret', async () => {
  const { store, cleanup } = tempStore()
  try {
    let releaseLogin!: () => void
    const loginGate = new Promise<void>(resolve => { releaseLogin = resolve })
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let deferOldPassword = true
    const auth = createAuth(
      { kind: 'password+token', password: PASSWORD, token: TOKEN },
      store,
      silentLogger,
      {
        verifyCredentialAsync: async (plain, stored) => {
          if (plain === PASSWORD && deferOldPassword) {
            deferOldPassword = false
            markStarted()
            await loginGate
          }
          return stored !== null && verifyCredential(plain, stored)
        },
      },
    )
    const staleLogin = auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' })
    await started
    await auth.changePassword!({ newPassword: NEW_PASSWORD }, {
      headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8',
    })
    releaseLogin()

    await assert.rejects(
      staleLogin,
      (error: Error & { code?: string }) => error.code === 'invalid_credentials',
      'an old password verdict must never mint a cookie using the new jwt-secret',
    )
    assert.ok((await auth.login!({ password: NEW_PASSWORD }, {
      headers: {}, socketAddr: '203.0.113.8',
    })).setCookie)
  } finally { cleanup() }
})

test('a generated token published before fsync failure is returned once and fences old proofs', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' })
    const cookie = login.setCookie!.split(';', 1)[0]
    const principal = await auth.verify({ headers: { cookie }, socketAddr: '203.0.113.8' })
    assert.ok(principal !== null)
    const staleProof = auth.captureChangeProof!(principal)
    assert.ok(staleProof !== null)

    const originalSetTokenHash = store.setTokenHash.bind(store)
    store.setTokenHash = (hash, source) => {
      originalSetTokenHash(hash, source)
      throw Object.assign(new Error('injected parent fsync failure'), { code: 'EIO' })
    }
    const beforeGeneration = auth.generation
    const result = await auth.changeToken!({ currentPassword: PASSWORD }, {
      headers: { cookie }, socketAddr: '203.0.113.8',
    }, staleProof ?? undefined)

    assert.equal(auth.generation, (beforeGeneration ?? 0) + 1)
    assert.equal(result.durability, 'unknown')
    assert.ok(typeof result.token === 'string' && result.token.length >= 32)
    assert.equal((await auth.verify({
      headers: { authorization: `Bearer ${result.token}` }, socketAddr: '203.0.113.8',
    }))?.kind, 'token', 'the presence cache follows the token already published on disk')
    store.setTokenHash = originalSetTokenHash
    await assert.rejects(
      () => auth.changeToken!({ newToken: 'another-post-publish-token-0123456789abcdef', currentPassword: PASSWORD }, {
        headers: { cookie }, socketAddr: '203.0.113.8',
      }, staleProof ?? undefined),
      (error: Error & { code?: string }) => error.code === 'invalid_credentials',
      'a proof captured before an uncertain commit is never reusable',
    )
  } finally { cleanup() }
})

test('a jwt-secret rename followed by fsync failure revokes the old cookie generation', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' })
    const cookie = login.setCookie!.split(';', 1)[0]
    const originalRotate = store.rotateJwtSecret.bind(store)
    store.rotateJwtSecret = () => {
      const secret = originalRotate()
      throw Object.assign(new Error('injected jwt parent fsync failure'), { code: 'EIO', secret })
    }
    const beforeGeneration = auth.generation
    await assert.rejects(
      () => auth.changePassword!({ newPassword: NEW_PASSWORD }, {
        headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8',
      }),
      /injected jwt parent fsync failure/,
    )

    assert.equal(auth.generation, (beforeGeneration ?? 0) + 1)
    assert.equal(await auth.verify({ headers: { cookie }, socketAddr: '203.0.113.8' }), null)
    assert.ok((await auth.login!({ password: PASSWORD }, {
      headers: {}, socketAddr: '203.0.113.8',
    })).setCookie, 'the unchanged password verifier remains usable with the newly published secret')
  } finally { cleanup() }
})

test('a password-credential rename followed by fsync failure reconciles password presence', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const originalSetPassword = store.setPasswordCredential.bind(store)
    store.setPasswordCredential = (verifier, source) => {
      originalSetPassword(verifier, source)
      throw Object.assign(new Error('injected password parent fsync failure'), { code: 'EIO' })
    }
    await assert.rejects(
      () => auth.changePassword!({ newPassword: NEW_PASSWORD }, {
        headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8',
      }),
      /injected password parent fsync failure/,
    )

    assert.equal(auth.kind, 'password+token')
    assert.ok((await auth.login!({ password: NEW_PASSWORD }, {
      headers: {}, socketAddr: '203.0.113.8',
    })).setCookie, 'the password cache follows the credential already published on disk')
  } finally { cleanup() }
})

test('credential change proofs are provider-issued and cannot cross a generation bump', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    const req = { headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8' }
    const principal = await auth.verify(req)
    assert.ok(principal !== null)
    const proof = auth.captureChangeProof?.(principal)
    assert.ok(proof !== undefined && proof !== null)

    await assert.rejects(
      () => auth.changePassword!({ newPassword: NEW_PASSWORD }, req, {
        principal: proof.principal,
        generation: proof.generation,
      }),
      (error: Error & { code?: string }) => error.code === 'invalid_credentials',
      'a lookalike object is not an issued proof capability',
    )

    await auth.changePassword!({ newPassword: NEW_PASSWORD }, req, proof)
    await assert.rejects(
      () => auth.changeToken!({ newToken: 'next-token-0123456789abcdef0123456789' }, req, proof),
      (error: Error & { code?: string }) => error.code === 'invalid_credentials',
      'a supplied stale proof fails closed instead of falling back to a fresh header verification',
    )
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
  const { dir, store, open, cleanup } = tempStore()
  try {
    const first = createAuth({ kind: 'password', password: PASSWORD }, store)
    const login = await first.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)

    // The stateDir exclusive lock must be released before reopening (Phase 1).
    store.close()
    const restartedStore = open()
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

// ---------------------------------------------------------------------------
// Phase 1: runtime credential changes
// ---------------------------------------------------------------------------

test('login without a configured password throws no_password', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    await assert.rejects(
      () => auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' }),
      (error: Error & { code?: string }) => error.code === 'no_password',
    )
  } finally { cleanup() }
})

test('changePassword: success rotates old cookies, the new password logs in, the old password dies', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)
    const cookieReq = { headers: { cookie: `dsh_gateway_session=${cookie}` }, socketAddr: '127.0.0.1' }

    const result = await auth.changePassword!({ newPassword: NEW_PASSWORD, currentPassword: PASSWORD }, cookieReq)
    assert.deepEqual(result, { changed: true, kind: 'password', source: 'runtime' })

    // jwt-secret was rotated FIRST: the old cookie is immediately dead (S13).
    assert.equal(await auth.verify(cookieReq), null)
    // The new password logs in; the old one is rejected.
    const newLogin = await auth.login!({ password: NEW_PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    assert.ok(newLogin.setCookie !== undefined)
    await assert.rejects(() => auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' }))
  } finally { cleanup() }
})

test('credential changes: a cookie-only principal without the current password is rejected as ambient', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' })
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)
    const cookieReq = { headers: { cookie: `dsh_gateway_session=${cookie}` }, socketAddr: '203.0.113.8' }
    await assert.rejects(
      () => auth.changePassword!({ newPassword: NEW_PASSWORD }, cookieReq),
      (error: Error & { code?: string }) => error.code === 'ambient_principal_rejected',
    )
    await assert.rejects(
      () => auth.changeToken!({ newToken: 'abcdef0123456789abcdef0123456789' }, cookieReq),
      (error: Error & { code?: string }) => error.code === 'ambient_principal_rejected',
    )
  } finally { cleanup() }
})

test('changePassword: a bearer-token principal changes the password without the current password', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    const result = await auth.changePassword!({ newPassword: NEW_PASSWORD }, {
      headers: { authorization: `Bearer ${TOKEN}` },
      socketAddr: '203.0.113.8',
    })
    assert.deepEqual(result, { changed: true, kind: 'password', source: 'runtime' })
    assert.equal(auth.kind, 'password+token')
    const login = await auth.login!({ password: NEW_PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' })
    assert.ok(login.setCookie !== undefined)
    await assert.rejects(() => auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' }))
  } finally { cleanup() }
})

test('changePassword: a wrong current password is rejected and repeated failures rate-limit', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' })
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)
    const req = { headers: { cookie: `dsh_gateway_session=${cookie}` }, socketAddr: '203.0.113.8' }

    let lastCode: string | undefined
    for (let i = 0; i < 11; i += 1) {
      try {
        await auth.changePassword!({ newPassword: NEW_PASSWORD, currentPassword: 'wrong-password' }, req)
      } catch (error) {
        lastCode = (error as Error & { code?: string }).code
      }
    }
    assert.equal(lastCode, 'rate_limited')
    // The correct current password is also refused while the lock is active.
    await assert.rejects(
      () => auth.changePassword!({ newPassword: NEW_PASSWORD, currentPassword: PASSWORD }, req),
      (error: Error & { code?: string }) => error.code === 'rate_limited',
    )
  } finally { cleanup() }
})

test('changePassword: a token-only deployment gains a password through the token principal', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    assert.equal(auth.kind, 'token')
    const result = await auth.changePassword!({ newPassword: PASSWORD }, {
      headers: { authorization: `Bearer ${TOKEN}` },
      socketAddr: '203.0.113.8',
    })
    assert.deepEqual(result, { changed: true, kind: 'password', source: 'runtime' })
    assert.equal(auth.kind, 'password+token')
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' })
    assert.ok(login.setCookie !== undefined)
  } finally { cleanup() }
})

test('changePassword: removing the password while a token remains succeeds and kills old cookies', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' })
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)
    const cookieReq = { headers: { cookie: `dsh_gateway_session=${cookie}` }, socketAddr: '203.0.113.8' }

    const result = await auth.changePassword!({ remove: true, currentPassword: PASSWORD }, cookieReq)
    assert.deepEqual(result, { changed: true, kind: 'password', source: 'runtime', removed: true })
    assert.equal(store.getPasswordCredential(), null)
    assert.equal(auth.kind, 'token')
    assert.equal(await auth.verify(cookieReq), null, 'the old cookie dies with the rotated jwt-secret')
    assert.equal((await auth.verify({ headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8' }))?.kind, 'token')
    await assert.rejects(
      () => auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' }),
      (error: Error & { code?: string }) => error.code === 'no_password',
    )
  } finally { cleanup() }
})

test('changePassword: removing the last credential reverts to the deployment-config password', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)
    const cookieReq = { headers: { cookie: `dsh_gateway_session=${cookie}` }, socketAddr: '127.0.0.1' }

    const result = await auth.changePassword!({ remove: true, currentPassword: PASSWORD }, cookieReq)
    assert.deepEqual(result, { changed: true, kind: 'password', source: 'config', removed: true })
    // The deployment-config password is immediately effective again.
    assert.equal(store.getPasswordCredentialRecord()?.source, 'config')
    const relogin = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    assert.ok(relogin.setCookie !== undefined)
    assert.equal(await auth.verify(cookieReq), null, 'the old runtime-password cookie is dead')
  } finally { cleanup() }
})

test('changePassword: removing the last credential without a config replacement is refused', async () => {
  const { dir, store, open, cleanup } = tempStore()
  try {
    // Build a runtime password with NO config-provided password: the config
    // seeds one first, the runtime change replaces it, then a restart with a
    // password-less config leaves only the runtime credential (source runtime).
    const first = createAuth({ kind: 'password', password: PASSWORD }, store)
    await first.changePassword!({ newPassword: RUNTIME_PASSWORD, currentPassword: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    store.close()
    const restartedStore = open()
    const restarted = createAuth({ kind: 'none' }, restartedStore)
    assert.equal(restarted.kind, 'password', 'the runtime credential survives config seeding')
    const login = await restarted.login!({ password: RUNTIME_PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)

    await assert.rejects(
      () => restarted.changePassword!({ remove: true, currentPassword: RUNTIME_PASSWORD }, {
        headers: { cookie: `dsh_gateway_session=${cookie}` },
        socketAddr: '127.0.0.1',
      }),
      (error: Error & { code?: string }) => error.code === 'last_credential',
    )
    assert.equal(restartedStore.getPasswordCredential() !== null, true, 'the refused removal leaves the credential intact')
  } finally { cleanup() }
})

test('runtime credentials survive a restart: config seeding is ignored with a loud warning', async () => {
  const { dir, store, open, cleanup } = tempStore()
  const warns: string[] = []
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    await auth.changePassword!({ newPassword: RUNTIME_PASSWORD, currentPassword: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    store.close()

    const restartedStore = open()
    const logger = { log() {}, warn: (message: unknown) => warns.push(String(message)), error() {} }
    const restarted = createAuth({ kind: 'password', password: PASSWORD }, restartedStore, logger)
    // The deployment-config password is ignored; the runtime password is
    // authoritative and still works.
    await assert.rejects(() => restarted.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' }))
    const login = await restarted.login!({ password: RUNTIME_PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    assert.ok(login.setCookie !== undefined)
    assert.equal(restartedStore.getPasswordCredentialRecord()?.source, 'runtime')
    assert.equal(warns.some(message => message.includes('config password IGNORED')), true)
  } finally { cleanup() }
})

test('a legacy bare password verifier still authenticates and migrates to v2 on the first write', async () => {
  const { dir, store, cleanup } = tempStore()
  try {
    // Simulate a v1 deployment: a bare `scrypt$salt$hash` file on disk.
    const legacy = hashCredential(PASSWORD)
    writeFileSync(join(dir, 'password-credential'), legacy, { mode: 0o600 })
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    // Seeding found the legacy verifier unchanged (config source) — no write,
    // and the legacy verifier still authenticates.
    const login = await auth.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    assert.ok(login.setCookie !== undefined)
    assert.equal(store.getPasswordCredentialRecord()?.source, 'config')
    // The first credential write migrates the file to v2 JSON.
    await auth.changePassword!({ newPassword: RUNTIME_PASSWORD, currentPassword: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    const doc = JSON.parse(readFileSync(join(dir, 'password-credential'), 'utf8'))
    assert.equal(doc.schemaVersion, 2)
    assert.equal(doc.source, 'runtime')
  } finally { cleanup() }
})

test('changePassword: an out-of-bounds new password is rejected with bad_request', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    const req = { headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8' }
    for (const newPassword of ['short', 'x'.repeat(1025), 42 as unknown as string]) {
      await assert.rejects(
        () => auth.changePassword!({ newPassword }, req),
        (error: Error & { code?: string }) => error.code === 'bad_request',
      )
    }
    await assert.rejects(
      () => auth.changePassword!({}, req),
      (error: Error & { code?: string }) => error.code === 'bad_request',
    )
  } finally { cleanup() }
})

test('changeToken: a new token works, the old token dies, and the plaintext is returned once', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const newToken = 'abcdef0123456789abcdef0123456789'
    const result = await auth.changeToken!({ newToken }, {
      headers: { authorization: `Bearer ${TOKEN}` },
      socketAddr: '203.0.113.8',
    })
    assert.deepEqual(result, { changed: true, kind: 'token', source: 'runtime', token: newToken })
    assert.equal((await auth.verify({ headers: { authorization: `Bearer ${newToken}` }, socketAddr: '203.0.113.8' }))?.kind, 'token')
    assert.equal(await auth.verify({ headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8' }), null)
  } finally { cleanup() }
})

test('changeToken returns the committed one-time token without re-reading the unrelated password state', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    // Model an unrelated password-credential read failure that begins only
    // after provider initialization. The token verifier/write path is healthy.
    // A post-commit cache refresh used to throw here after the new hash and
    // generation were already committed, losing the only plaintext response.
    store.getPasswordCredential = () => { throw new Error('injected password read failure') }
    const newToken = 'committed-token-0123456789abcdef0123456789'
    const result = await auth.changeToken!({ newToken }, {
      headers: { authorization: `Bearer ${TOKEN}` },
      socketAddr: '203.0.113.8',
    })

    assert.deepEqual(result, { changed: true, kind: 'token', source: 'runtime', token: newToken })
    assert.equal((await auth.verify({
      headers: { authorization: `Bearer ${newToken}` }, socketAddr: '203.0.113.8',
    }))?.kind, 'token', 'the deterministic token-presence cache follows the committed write')
    assert.equal(await auth.verify({
      headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8',
    }), null)
  } finally { cleanup() }
})

test('changeToken: a server-generated token meets the 32-4096 visible-ASCII bounds and is returned once', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const result = await auth.changeToken!({}, {
      headers: { authorization: `Bearer ${TOKEN}` },
      socketAddr: '203.0.113.8',
    })
    assert.ok(typeof result.token === 'string' && result.token.length >= 32 && result.token.length <= 4096)
    assert.match(result.token, /^[\x20-\x7e]+$/)
    assert.equal((await auth.verify({ headers: { authorization: `Bearer ${result.token}` }, socketAddr: '203.0.113.8' }))?.kind, 'token')
  } finally { cleanup() }
})

test('changeToken: an invalid new token is rejected with bad_request', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const req = { headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8' }
    for (const newToken of ['short', 'x'.repeat(4097), 'has space', 'bad\u0001control']) {
      await assert.rejects(
        () => auth.changeToken!({ newToken }, req),
        (error: Error & { code?: string }) => error.code === 'bad_request',
      )
    }
  } finally { cleanup() }
})

test('changeToken: removing the token while a password remains succeeds', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    const result = await auth.changeToken!({ remove: true, currentPassword: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' })
    assert.deepEqual(result, { changed: true, kind: 'token', source: 'runtime', removed: true })
    assert.equal(store.getTokenHash(), null)
    assert.equal(auth.kind, 'password')
    assert.equal(await auth.verify({ headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8' }), null)
  } finally { cleanup() }
})

test('changeToken: removing the last credential without a config replacement is refused', async () => {
  const { dir, store, open, cleanup } = tempStore()
  try {
    const first = createAuth({ kind: 'token', token: TOKEN }, store)
    const runtimeToken = 'new-token-0123456789abcdef0123456789'
    await first.changeToken!({ newToken: runtimeToken }, {
      headers: { authorization: `Bearer ${TOKEN}` },
      socketAddr: '203.0.113.8',
    })
    store.close()
    const restartedStore = open()
    const restarted = createAuth({ kind: 'none' }, restartedStore)
    assert.equal(restarted.kind, 'token', 'the runtime token survives config seeding')
    await assert.rejects(
      () => restarted.changeToken!({ remove: true }, {
        headers: { authorization: `Bearer ${runtimeToken}` },
        socketAddr: '203.0.113.8',
      }),
      (error: Error & { code?: string }) => error.code === 'last_credential',
    )
    assert.equal(restartedStore.getTokenHash() !== null, true, 'the refused removal leaves the token intact')
  } finally { cleanup() }
})

test('changeToken: a runtime token survives a restart while the config token is ignored with a warning', async () => {
  const { dir, store, open, cleanup } = tempStore()
  const warns: string[] = []
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const runtimeToken = 'runtime-token-0123456789abcdef0123456789'
    await auth.changeToken!({ newToken: runtimeToken }, {
      headers: { authorization: `Bearer ${TOKEN}` },
      socketAddr: '203.0.113.8',
    })
    store.close()

    const restartedStore = open()
    const logger = { log() {}, warn: (message: unknown) => warns.push(String(message)), error() {} }
    const restarted = createAuth({ kind: 'token', token: TOKEN }, restartedStore, logger)
    assert.equal((await restarted.verify({ headers: { authorization: `Bearer ${runtimeToken}` }, socketAddr: '203.0.113.8' }))?.kind, 'token')
    assert.equal(await restarted.verify({ headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8' }), null)
    assert.equal(restartedStore.getTokenCredential()?.source, 'runtime')
    assert.equal(warns.some(message => message.includes('config token IGNORED')), true)
  } finally { cleanup() }
})

test('changeToken: removing the last credential reverts to the deployment-config token', async () => {
  const { store, cleanup } = tempStore()
  try {
    const configToken = 'config-token-0123456789abcdef0123456789'
    const runtimeToken = 'runtime-token-0123456789abcdef0123456789'
    const auth = createAuth({ kind: 'token', token: configToken }, store)
    await auth.changeToken!({ newToken: runtimeToken }, {
      headers: { authorization: `Bearer ${configToken}` },
      socketAddr: '203.0.113.8',
    })
    // Removing the last credential while config provides a replacement
    // reverts to the config token (mirror of the password-dimension test).
    const result = await auth.changeToken!({ remove: true }, {
      headers: { authorization: `Bearer ${runtimeToken}` },
      socketAddr: '203.0.113.8',
    })
    assert.equal(result.removed, true)
    assert.equal(result.source, 'config')
    assert.equal(store.getTokenCredential()?.source, 'config')
    assert.equal(store.getTokenHash() !== null, true)
    // The config token is immediately effective; the runtime token is dead.
    assert.equal((await auth.verify({ headers: { authorization: `Bearer ${configToken}` }, socketAddr: '203.0.113.8' }))?.kind, 'token')
    assert.equal(await auth.verify({ headers: { authorization: `Bearer ${runtimeToken}` }, socketAddr: '203.0.113.8' }), null)
  } finally { cleanup() }
})

test('seeding rule 3: a config-less restart clears a config-sourced password (rotating the jwt-secret)', async () => {
  const { store, open, cleanup } = tempStore()
  try {
    const first = createAuth({ kind: 'password', password: PASSWORD }, store)
    const login = await first.login!({ password: PASSWORD }, { headers: {}, socketAddr: '127.0.0.1' })
    const cookie = /dsh_gateway_session=([^;]+)/.exec(login.setCookie ?? '')?.[1]
    assert.ok(cookie !== undefined)
    const secretBefore = store.getJwtSecret()
    store.close()

    const restartedStore = open()
    const restarted = createAuth({ kind: 'none' }, restartedStore)
    assert.equal(restartedStore.getPasswordCredential(), null, 'config-less restart removes the persisted password')
    assert.notEqual(restartedStore.getJwtSecret(), secretBefore, 'removing the password rotates the jwt-secret')
    // The old cookie is no longer a password principal (the deployment is
    // anonymous now — verify answers with the none principal, never null).
    assert.equal((await restarted.verify({ headers: { cookie: `dsh_gateway_session=${cookie}` }, socketAddr: '127.0.0.1' }))?.kind, 'none')
  } finally { cleanup() }
})

test('seeding rule 3: a config-less restart clears a config-sourced token (no jwt rotation)', async () => {
  const { store, open, cleanup } = tempStore()
  try {
    createAuth({ kind: 'token', token: TOKEN }, store)
    const secretBefore = store.getJwtSecret()
    store.close()

    const restartedStore = open()
    const restarted = createAuth({ kind: 'none' }, restartedStore)
    assert.equal(restartedStore.getTokenHash(), null, 'config-less restart removes the persisted token')
    assert.equal(restartedStore.getJwtSecret(), secretBefore, 'token removal does not rotate the jwt-secret')
    // A none deployment authenticates everyone anonymously.
    assert.equal((await restarted.verify({ headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '127.0.0.1' }))?.kind, 'none')
  } finally { cleanup() }
})

test('S25: an anonymous (kind none) deployment cannot plant or change credentials via the API', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'none' }, store)
    // No principal proof exists on an anonymous deployment: every change is
    // refused (the none principal is not ambient proof).
    await assert.rejects(
      () => auth.changePassword!({ newPassword: NEW_PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' }),
      (error: Error & { code?: string }) => error.code === 'invalid_credentials',
    )
    await assert.rejects(
      () => auth.changeToken!({}, { headers: {}, socketAddr: '203.0.113.8' }),
      (error: Error & { code?: string }) => error.code === 'invalid_credentials',
    )
    // Even a submitted currentPassword cannot validate — no password exists.
    await assert.rejects(
      () => auth.changePassword!({ newPassword: NEW_PASSWORD, currentPassword: PASSWORD }, { headers: {}, socketAddr: '203.0.113.8' }),
      (error: Error & { code?: string }) => error.code === 'invalid_credentials',
    )
    // Nothing was persisted.
    assert.equal(store.getPasswordCredential(), null)
    assert.equal(store.getTokenHash(), null)
  } finally { cleanup() }
})

test('concurrent credential removals are serialized: never both succeed into a credential-less state', async () => {
  const { store, cleanup } = tempStore()
  try {
    // Seed BOTH dimensions as runtime-managed with NO config replacement, so
    // the last-credential gate is the only protection against a double remove.
    store.setPasswordCredential(hashCredential(RUNTIME_PASSWORD), 'runtime')
    store.setTokenHash(hashCredential(TOKEN), 'runtime')
    const auth = createAuth({ kind: 'none' }, store)
    assert.equal(auth.kind, 'password+token')

    const results = await Promise.allSettled([
      auth.changePassword!({ remove: true }, { headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8' }),
      auth.changeToken!({ remove: true }, { headers: { authorization: `Bearer ${TOKEN}` }, socketAddr: '203.0.113.8' }),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    assert.equal(fulfilled.length, 1, 'exactly one removal succeeds')
    assert.equal(rejected.length, 1)
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error & { code?: string }
    // Depending on order the second removal fails at the proof gate (its
    // bearer died with the token) or at the last-credential gate — either way
    // it must fail.
    assert.ok(reason.code === 'last_credential' || reason.code === 'invalid_credentials', `unexpected code ${String(reason.code)}`)
    // The deployment NEVER ends up with zero credentials.
    assert.equal(store.getPasswordCredential() !== null || store.getTokenHash() !== null, true)
  } finally { cleanup() }
})

test('remove and a new value are mutually exclusive (bad_request, both methods)', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    await assert.rejects(
      () => auth.changePassword!({ remove: true, newPassword: NEW_PASSWORD }, {
        headers: { authorization: `Bearer ${TOKEN}` },
        socketAddr: '203.0.113.8',
      }),
      (error: Error & { code?: string }) => error.code === 'bad_request',
    )
    await assert.rejects(
      () => auth.changeToken!({ remove: true, newToken: 'new-token-0123456789abcdef0123456789' }, {
        headers: { authorization: `Bearer ${TOKEN}` },
        socketAddr: '203.0.113.8',
      }),
      (error: Error & { code?: string }) => error.code === 'bad_request',
    )
    // Both dimensions are still intact.
    assert.equal(store.getPasswordCredential() !== null, true)
    assert.equal(store.getTokenHash() !== null, true)
  } finally { cleanup() }
})

test('a non-string currentPassword is a bad_request, not a missing-proof rejection', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password+token', password: PASSWORD, token: TOKEN }, store)
    await assert.rejects(
      () => auth.changePassword!({ newPassword: NEW_PASSWORD, currentPassword: 42 as unknown as string }, {
        headers: { authorization: `Bearer ${TOKEN}` },
        socketAddr: '203.0.113.8',
      }),
      (error: Error & { code?: string }) => error.code === 'bad_request',
    )
    await assert.rejects(
      () => auth.changeToken!({ currentPassword: 42 as unknown as string }, {
        headers: { authorization: `Bearer ${TOKEN}` },
        socketAddr: '203.0.113.8',
      }),
      (error: Error & { code?: string }) => error.code === 'bad_request',
    )
  } finally { cleanup() }
})

test('rate limiter falls back to the socket peer for an empty boundary clientAddress (F3)', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: PASSWORD }, store)
    // Ten failed currentPassword attempts from peer 203.0.113.8 with an
    // EMPTY boundary clientAddress must lock that peer's bucket only.
    for (let i = 0; i < 10; i += 1) {
      await assert.rejects(
        () => auth.changePassword!({ newPassword: NEW_PASSWORD, currentPassword: 'wrong' }, {
          headers: {},
          socketAddr: '203.0.113.8',
          clientAddress: '',
        }),
        (error: Error & { code?: string }) => error.code === 'invalid_credentials',
      )
    }
    await assert.rejects(
      () => auth.changePassword!({ newPassword: NEW_PASSWORD, currentPassword: 'wrong' }, {
        headers: {},
        socketAddr: '203.0.113.8',
        clientAddress: '',
      }),
      (error: Error & { code?: string }) => error.code === 'rate_limited',
    )
    // A DIFFERENT socket peer has its own bucket: still invalid_credentials,
    // never rate_limited.
    await assert.rejects(
      () => auth.changePassword!({ newPassword: NEW_PASSWORD, currentPassword: 'wrong' }, {
        headers: {},
        socketAddr: '198.51.100.7',
        clientAddress: '',
      }),
      (error: Error & { code?: string }) => error.code === 'invalid_credentials',
    )
  } finally { cleanup() }
})
