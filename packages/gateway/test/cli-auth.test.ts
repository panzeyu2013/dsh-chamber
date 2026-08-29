/**
 * Gateway auth CLI tests (design 17 §7 / Phase 3): the offline `gateway auth`
 * operations (status / reset-password / clear) — v2 runtime envelope writes,
 * rotate-first, live-gateway rejection via the stateDir exclusive lock, usage
 * validation, legacy v1 projections, and the non-secret status output.
 * Run with `node packages/gateway/test/cli-auth.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayStore, hashCredential, verifyCredential } from '../src/store.ts'
import {
  GatewayAuthUsageError,
  gatewayAuthClear,
  gatewayAuthResetPassword,
  gatewayAuthStatus,
} from '../src/auth-cli.ts'

const silentLogger = { log() {}, warn() {}, error() {} }
const NEW_PASSWORD = 'cli-new-password-123'
const OLD_PASSWORD = 'cli-old-password-123'
const TOKEN = '0123456789abcdef0123456789abcdef'

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-cli-auth-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'))
const jwtSecret = (stateDir: string): string => readFileSync(join(stateDir, 'jwt-secret'), 'utf8').trim()

test('gateway auth reset-password writes a v2 runtime credential, rotates the secret, and releases the lock', async () => {
  const { dir, cleanup } = tempDir()
  try {
    // Seed a config-sourced password + an old session secret first.
    const seed = createGatewayStore(dir, silentLogger)
    seed.setPasswordCredential(hashCredential(OLD_PASSWORD), 'config')
    const oldSecret = seed.getJwtSecret()
    seed.close()

    const logs: string[] = []
    await gatewayAuthResetPassword(dir, NEW_PASSWORD, {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      warn() {},
      error() {},
    })

    const doc = readJson(join(dir, 'password-credential'))
    assert.equal(doc.schemaVersion, 2)
    assert.equal(doc.source, 'runtime')
    assert.ok(Number.isInteger(doc.updatedAt) && doc.updatedAt > 0)
    assert.match(doc.verifier, /^scrypt\$[a-f0-9]+\$[a-f0-9]{64}$/i)
    assert.equal(verifyCredential(NEW_PASSWORD, doc.verifier), true)
    assert.equal(verifyCredential(OLD_PASSWORD, doc.verifier), false)
    // Rotate-first (S13): the old session secret is dead.
    assert.notEqual(jwtSecret(dir), oldSecret)
    // The lock was released: the same stateDir can be reopened immediately.
    const reopened = createGatewayStore(dir, silentLogger)
    reopened.close()
    assert.ok(logs.some(line => line.includes('runtime-managed')), 'reset prints the runtime-managed notice')
  } finally { cleanup() }
})

test('gateway auth reset-password refuses while the gateway holds the state lock', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const store = createGatewayStore(dir, silentLogger) // lock held, NOT closed
    try {
      await assert.rejects(
        () => gatewayAuthResetPassword(dir, NEW_PASSWORD, silentLogger),
        /gateway is running \(pid \d+\); use the web UI \/auth\/change-password instead/,
      )
    } finally {
      store.close()
    }
  } finally { cleanup() }
})

test('gateway auth reset-password rejects an out-of-bounds password with a usage error', async () => {
  const { dir, cleanup } = tempDir()
  try {
    await assert.rejects(
      () => gatewayAuthResetPassword(dir, 'too-short', silentLogger),
      (error: unknown) => error instanceof GatewayAuthUsageError
        && /12-1024 characters/.test((error as Error).message),
    )
    await assert.rejects(
      () => gatewayAuthResetPassword(dir, 'x'.repeat(1025), silentLogger),
      (error: unknown) => error instanceof GatewayAuthUsageError,
    )
    // The lock was never touched: the stateDir stays free for a normal open.
    const store = createGatewayStore(dir, silentLogger)
    store.close()
  } finally { cleanup() }
})

test('gateway auth clear removes both credentials, rotates the secret, and releases the lock', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const seed = createGatewayStore(dir, silentLogger)
    seed.setPasswordCredential(hashCredential(OLD_PASSWORD), 'runtime')
    seed.setTokenHash(hashCredential(TOKEN), 'runtime')
    const oldSecret = seed.getJwtSecret()
    seed.close()

    const warns: string[] = []
    await gatewayAuthClear(dir, {
      log() {},
      warn: (...args: unknown[]) => warns.push(args.map(String).join(' ')),
      error() {},
    })

    assert.equal(existsSync(join(dir, 'password-credential')), false)
    assert.equal(existsSync(join(dir, 'tokens.json')), false)
    assert.notEqual(jwtSecret(dir), oldSecret)
    assert.ok(warns.some(line => line.includes('NO authentication')), 'clear prints the S1 warning for --no-auth deployments')
    // Lock released: the same stateDir can be reopened immediately.
    const reopened = createGatewayStore(dir, silentLogger)
    reopened.close()
  } finally { cleanup() }
})

test('gateway auth clear refuses while the gateway holds the state lock', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const store = createGatewayStore(dir, silentLogger)
    try {
      await assert.rejects(
        () => gatewayAuthClear(dir, silentLogger),
        /gateway is running \(pid \d+\); stop the gateway first/,
      )
    } finally {
      store.close()
    }
  } finally { cleanup() }
})

test('gateway auth status reports source and time, never the secret values', () => {
  const { dir, cleanup } = tempDir()
  try {
    const store = createGatewayStore(dir, silentLogger)
    store.setPasswordCredential(hashCredential(OLD_PASSWORD), 'runtime')
    store.setTokenHash(hashCredential(TOKEN), 'config')
    store.close()

    const text = gatewayAuthStatus(dir)
    assert.match(text, /password: configured \(runtime, \d{4}-\d{2}-\d{2}T/)
    assert.match(text, /token: configured \(config, \d{4}-\d{2}-\d{2}T/)
    assert.equal(/not configured/.test(text), false)
    // No secret material ever reaches the status output (S5).
    assert.equal(text.includes('scrypt'), false)
    assert.equal(text.includes('verifier'), false)
    assert.equal(text.includes('$'), false)
  } finally { cleanup() }
})

test('gateway auth status on an empty state dir reports not configured without throwing', () => {
  const { dir, cleanup } = tempDir()
  try {
    const text = gatewayAuthStatus(dir)
    assert.match(text, /password: not configured/)
    assert.match(text, /token: not configured/)
  } finally { cleanup() }
})

test('gateway auth status projects legacy v1 credential files as config-sourced', () => {
  const { dir, cleanup } = tempDir()
  try {
    // Legacy v1 shapes: a bare `scrypt$salt$hash` string and `{"hash": …}`.
    writeFileSync(join(dir, 'password-credential'), hashCredential(OLD_PASSWORD), { mode: 0o600 })
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ hash: hashCredential(TOKEN) }), { mode: 0o600 })

    const text = gatewayAuthStatus(dir)
    assert.match(text, /password: configured \(config, \d{4}-\d{2}-\d{2}T/)
    assert.match(text, /token: configured \(config, \d{4}-\d{2}-\d{2}T/)
    assert.equal(text.includes('scrypt'), false)
  } finally { cleanup() }
})
