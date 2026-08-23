/**
 * Gateway auth unit tests (design 16 §5): token (hash-stored, constant-time),
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

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-auth-'))
  const store = createGatewayStore(dir, silentLogger)
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('token provider accepts a matching bearer (hash-stored)', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: 'secret' }, store)
    const principal = await auth.verify({ headers: { authorization: 'Bearer secret' }, socketAddr: '' })
    assert.equal(principal?.kind, 'token')
    // The plaintext token is never persisted — only its hash.
    assert.notEqual(store.getTokenHash(), 'secret')
  } finally { cleanup() }
})

test('token provider rejects a wrong bearer', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: 'secret' }, store)
    const principal = await auth.verify({ headers: { authorization: 'Bearer wrong' }, socketAddr: '' })
    assert.equal(principal, null)
  } finally { cleanup() }
})

test('token provider accepts a case-insensitive scheme', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: 'secret' }, store)
    const principal = await auth.verify({ headers: { authorization: 'bearer secret' }, socketAddr: '' })
    assert.equal(principal?.kind, 'token')
  } finally { cleanup() }
})

test('token provider rejects a missing header', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: 'secret' }, store)
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
    const auth = createAuth({ kind: 'password', password: 'hunter2' }, store)
    const req = { headers: {}, socketAddr: '127.0.0.1' }
    const result = await auth.login!({ password: 'hunter2' }, req)
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
    const auth = createAuth({ kind: 'password', password: 'hunter2' }, store)
    await assert.rejects(() => auth.login!({ password: 'wrong' }, { headers: {}, socketAddr: '127.0.0.1' }))
  } finally { cleanup() }
})

test('password: revoke rotates the secret and invalidates the session', async () => {
  const { store, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'password', password: 'hunter2' }, store)
    const result = await auth.login!({ password: 'hunter2' }, { headers: {}, socketAddr: '127.0.0.1' })
    const cookieValue = /dsh_gateway_session=([^;]+)/.exec(result.setCookie ?? '')?.[1]
    assert.ok(cookieValue !== undefined)
    const before = await auth.verify({ headers: { cookie: `dsh_gateway_session=${cookieValue}` }, socketAddr: '' })
    assert.equal(before?.kind, 'password')
    await auth.revoke!({ kind: 'password', id: 'user', issuedAt: Date.now() })
    const after = await auth.verify({ headers: { cookie: `dsh_gateway_session=${cookieValue}` }, socketAddr: '' })
    assert.equal(after, null)
  } finally { cleanup() }
})
