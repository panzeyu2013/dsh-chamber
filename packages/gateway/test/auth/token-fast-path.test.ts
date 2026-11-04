/**
 * Gateway token verifier fast path (design 17 §7.2/§12; hardening plan P0-4).
 *
 * The persisted token credential is the union `hmac$<64 hex> | scrypt$salt$hash`:
 *   - new writes are O(1) HMAC-SHA256 verifiers keyed by <stateDir>/auth/token-key;
 *   - legacy scrypt records stay readable and are upgraded in place on the first
 *     successful verification (no generation bump, source preserved);
 *   - the startup config replay compares a token against the persisted verifier
 *     by SHAPE, so an hmac record is never rewritten back to scrypt;
 *   - corrupt/unknown verifier or key shapes fail closed.
 *
 * Run with:
 *   node --import ./test/session-state/workspace-loader.mjs --test test/auth/token-fast-path.test.ts
 * (the loader is the documented no-node_modules seam; CI runs it through the
 * package manifest like every other auth suite).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth } from '../../src/auth.ts'
import { gatewayAuthStatus } from '../../src/auth-cli.ts'
import {
  createGatewayStore,
  hashCredential,
  hashToken,
  readCredentialProjection,
  verifyToken,
  type GatewayStore,
} from '../../src/store.ts'

const silentLogger = { log() {}, warn() {}, error() {} }
const TOKEN = 'token-0123456789abcdef0123456789abcdef'
const OTHER_TOKEN = 'other-0123456789abcdef0123456789abcdef'
const CONFIG_TOKEN = 'config-0123456789abcdef0123456789abcdef'
const RUNTIME_TOKEN = 'runtime-0123456789abcdef0123456789abcdef'
const TOKEN_KEY_RE = /^[0-9a-f]{64}$/
const HMAC_RE = /^hmac\$[0-9a-f]{64}$/

function tempStore(): {
  dir: string
  store: GatewayStore
  open: () => GatewayStore
  tokensFile: string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-token-fast-'))
  const open = () => createGatewayStore(dir, silentLogger)
  return {
    dir,
    store: open(),
    open,
    tokensFile: join(dir, 'tokens.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` }, socketAddr: '203.0.113.8' })
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const tokenKeyText = (dir: string): string => readFileSync(join(dir, 'auth', 'token-key'), 'utf8').trim()

test('token-key: 32 bytes, 0600 inside a 0700 auth/ directory, stable across store reopens', () => {
  const { dir, store, open, cleanup } = tempStore()
  try {
    const key = store.ensureTokenKey()
    assert.equal(key.length, 32)
    assert.match(tokenKeyText(dir), TOKEN_KEY_RE)
    assert.deepEqual(readdirSync(join(dir, 'auth')), ['token-key'], 'the atomic write leaves no tmp residue')
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, 'auth')).mode & 0o777, 0o700)
      assert.equal(statSync(join(dir, 'auth', 'token-key')).mode & 0o777, 0o600)
    }
    assert.equal(open().ensureTokenKey().toString('hex'), key.toString('hex'))
    assert.equal(existsSync(join(dir, 'auth', 'token-key')), true)
  } finally { cleanup() }
})

test('an hmac verifier survives a restart: the config replay never rewrites it to scrypt', async () => {
  const { store, open, tokensFile, cleanup } = tempStore()
  try {
    const hmac = hashToken(TOKEN, store.ensureTokenKey())
    store.setTokenHash(hmac, 'config')
    const before = readFileSync(tokensFile, 'utf8')
    assert.equal(readJson(tokensFile).hash, hmac)

    const reopened = open()
    let scryptCalls = 0
    const auth = createAuth({ kind: 'token', token: TOKEN }, reopened, silentLogger, {
      verifyCredentialAsync: async () => { scryptCalls += 1; return false },
    })
    // Byte-identical file: the shape-aware unchanged check recognized the hmac
    // record, so seeding neither rewrote it nor bumped updatedAt.
    assert.equal(readFileSync(tokensFile, 'utf8'), before)
    assert.equal(reopened.getTokenHash(), hmac)
    assert.equal((await auth.verify(bearer(TOKEN)))?.kind, 'token')
    assert.equal(scryptCalls, 0, 'the hmac path never enters the scrypt verifier')
    assert.equal(await auth.verify(bearer(OTHER_TOKEN)), null)
    assert.equal(scryptCalls, 0)
  } finally { cleanup() }
})

test('a legacy scrypt token upgrades to hmac on first success, keeps the generation and survives a restart', async () => {
  const { store, open, tokensFile, cleanup } = tempStore()
  try {
    store.setTokenHash(hashCredential(TOKEN), 'config')
    const legacy = store.getTokenHash()
    assert.match(legacy ?? '', /^scrypt\$/)

    let scryptCalls = 0
    const auth = createAuth({ kind: 'token', token: TOKEN }, store, silentLogger, {
      verifyCredentialAsync: async (plain, stored) => {
        scryptCalls += 1
        return stored !== null && plain === TOKEN
      },
    })
    const generationBefore = auth.generation
    const principal = await auth.verify(bearer(TOKEN))
    // The triggering request is admitted (no generation fence trip) and the
    // migration is invisible to principals already issued.
    assert.equal(principal?.kind, 'token')
    assert.equal(auth.generation, generationBefore)
    assert.notEqual(auth.captureChangeProof!(principal), null)
    assert.equal(scryptCalls, 1)

    const upgraded = store.getTokenHash()
    assert.match(upgraded ?? '', HMAC_RE)
    assert.notEqual(upgraded, legacy)
    assert.equal(store.getTokenCredential()?.source, 'config', 'migration preserves provenance')
    assert.equal(readFileSync(tokensFile, 'utf8').includes(TOKEN), false, 'the plaintext token never persists')

    // The second request takes the O(1) path: no further scrypt work.
    assert.equal((await auth.verify(bearer(TOKEN)))?.kind, 'token')
    assert.equal(scryptCalls, 1)
    assert.equal(await auth.verify(bearer(OTHER_TOKEN)), null)
    assert.equal(scryptCalls, 1)

    // Restart with the same deployment config: still hmac, no scrypt at all.
    const reopened = open()
    let scryptAfterRestart = 0
    const restarted = createAuth({ kind: 'token', token: TOKEN }, reopened, silentLogger, {
      verifyCredentialAsync: async () => { scryptAfterRestart += 1; return false },
    })
    assert.equal(reopened.getTokenHash(), upgraded)
    assert.equal((await restarted.verify(bearer(TOKEN)))?.kind, 'token')
    assert.equal(scryptAfterRestart, 0)
  } finally { cleanup() }
})

test('the upgrade preserves a runtime source and the config replay keeps ignoring that token', async () => {
  const { store, open, cleanup } = tempStore()
  const warns: string[] = []
  try {
    store.setTokenHash(hashCredential(TOKEN), 'runtime')
    const auth = createAuth({ kind: 'none' }, store)
    assert.equal(auth.kind, 'token')
    assert.equal((await auth.verify(bearer(TOKEN)))?.kind, 'token')
    const upgraded = store.getTokenHash()
    assert.match(upgraded ?? '', HMAC_RE)
    assert.equal(store.getTokenCredential()?.source, 'runtime')

    const reopened = open()
    const logger = { log() {}, warn: (message: unknown) => warns.push(String(message)), error() {} }
    const restarted = createAuth({ kind: 'token', token: CONFIG_TOKEN }, reopened, logger)
    assert.equal(warns.some(message => message.includes('config token IGNORED')), true)
    assert.equal(reopened.getTokenHash(), upgraded, 'the runtime hmac record is never overwritten by config')
    assert.equal((await restarted.verify(bearer(TOKEN)))?.kind, 'token')
    assert.equal(await restarted.verify(bearer(CONFIG_TOKEN)), null)
  } finally { cleanup() }
})

test('concurrent legacy verifications migrate exactly once (compare-and-swap, single-flight)', async () => {
  const { store, cleanup } = tempStore()
  try {
    store.setTokenHash(hashCredential(TOKEN), 'config')
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const originalSet = store.setTokenHash.bind(store)
    let writes = 0
    store.setTokenHash = (hash, source) => {
      writes += 1
      originalSet(hash, source)
    }
    const [first, second] = await Promise.all([auth.verify(bearer(TOKEN)), auth.verify(bearer(TOKEN))])
    assert.equal(first?.kind, 'token')
    assert.equal(second?.kind, 'token')
    assert.equal(writes, 1, 'two successful legacy verifies publish one migration write')
    assert.match(store.getTokenHash() ?? '', HMAC_RE)
  } finally { cleanup() }
})

test('a failed legacy verification never migrates the verifier', async () => {
  const { store, cleanup } = tempStore()
  try {
    store.setTokenHash(hashCredential(TOKEN), 'config')
    const legacy = store.getTokenHash()
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    assert.equal(await auth.verify(bearer(OTHER_TOKEN)), null)
    assert.equal(store.getTokenHash(), legacy, 'only a successful proof may rewrite the verifier')
  } finally { cleanup() }
})

test('a rotation queued behind the legacy scrypt work wins over the stale migration', async () => {
  const { store, cleanup } = tempStore()
  try {
    store.setTokenHash(hashCredential(TOKEN), 'config')
    let releaseOld!: () => void
    const gate = new Promise<void>(resolve => { releaseOld = resolve })
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let defer = true
    const auth = createAuth({ kind: 'token', token: TOKEN }, store, silentLogger, {
      verifyCredentialAsync: async (plain, stored) => {
        if (defer) { defer = false; markStarted(); await gate }
        return stored !== null && plain === TOKEN
      },
    })
    const stale = auth.verify(bearer(TOKEN))
    await started
    await auth.changeToken!({ newToken: RUNTIME_TOKEN }, bearer(TOKEN))
    releaseOld()
    assert.equal(await stale, null, 'the pre-rotation verdict is fenced by the credential generation')
    const published = store.getTokenHash()
    assert.match(published ?? '', HMAC_RE)
    assert.equal(verifyToken(RUNTIME_TOKEN, published, store.getTokenKey()), true, 'the live rotation verifier was not overwritten')
    assert.equal(verifyToken(TOKEN, published, store.getTokenKey()), false)
    assert.equal((await auth.verify(bearer(RUNTIME_TOKEN)))?.kind, 'token')
  } finally { cleanup() }
})

test('hmac verification fails closed when the token key disappears and recovers through a config re-seed', async () => {
  const { dir, store, open, cleanup } = tempStore()
  try {
    const hmac = hashToken(TOKEN, store.ensureTokenKey())
    store.setTokenHash(hmac, 'config')
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    rmSync(join(dir, 'auth', 'token-key'))
    assert.equal(store.getTokenKey(), null)
    assert.equal(verifyToken(TOKEN, hmac, null), false)
    assert.equal(await auth.verify(bearer(TOKEN)), null, 'no key means no admitted token, never anonymous fallback')

    const reopened = open()
    const restarted = createAuth({ kind: 'token', token: TOKEN }, reopened)
    assert.notEqual(reopened.getTokenKey(), null, 'the writer path (seeding) provisions a fresh key')
    assert.notEqual(reopened.getTokenHash(), hmac, 'the stale verifier was replaced under the fresh key')
    assert.equal((await restarted.verify(bearer(TOKEN)))?.kind, 'token')
  } finally { cleanup() }
})

test('a corrupt token-key reads as absent and is regenerated only on the writer path', async () => {
  const { dir, store, cleanup } = tempStore()
  try {
    const key = store.ensureTokenKey()
    const hmac = hashToken(TOKEN, key)
    store.setTokenHash(hmac, 'config')
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    writeFileSync(join(dir, 'auth', 'token-key'), 'not-a-key', { mode: 0o600 })

    assert.equal(store.getTokenKey(), null, 'a corrupt key is never trusted')
    assert.equal(await auth.verify(bearer(TOKEN)), null, 'fail closed on the verify path')

    const fresh = store.ensureTokenKey()
    assert.equal(fresh.length, 32)
    assert.match(tokenKeyText(dir), TOKEN_KEY_RE)
    assert.notEqual(fresh.toString('hex'), key.toString('hex'))
    // The old hmac was keyed by the old bytes: it must not verify under the new key.
    assert.equal(verifyToken(TOKEN, hmac, fresh), false)
  } finally { cleanup() }
})

test('setTokenHash rejects an unrecognized verifier shape BEFORE writing and keeps the previous credential', () => {
  const { dir, store, cleanup } = tempStore()
  try {
    const hmac = hashToken(TOKEN, store.ensureTokenKey())
    store.setTokenHash(hmac, 'config')
    const before = readFileSync(join(dir, 'tokens.json'), 'utf8')
    const bad = [
      'garbage',
      `hmac$${'a'.repeat(63)}`,
      `hmac$${'z'.repeat(64)}`,
      `sha256$${'a'.repeat(64)}`,
      `scrypt$${'a'.repeat(31)}$${'a'.repeat(64)}`,
      `scrypt$${'a'.repeat(32)}$${'a'.repeat(63)}`,
    ]
    for (const verifier of bad) {
      assert.throws(() => store.setTokenHash(verifier), TypeError, verifier)
      assert.equal(readFileSync(join(dir, 'tokens.json'), 'utf8'), before, verifier)
    }
    assert.equal(store.getTokenHash(), hmac, 'the previously published credential stays in force')
  } finally { cleanup() }
})

test('legacy token files (v1 {"hash"} and v2 scrypt) stay readable and project correctly', () => {
  const { dir, open, cleanup } = tempStore()
  try {
    const legacy = hashCredential(TOKEN)
    // v2 envelope with the legacy scrypt shape
    writeFileSync(join(dir, 'tokens.json'),
      JSON.stringify({ schemaVersion: 2, source: 'config', updatedAt: 12345, hash: legacy }), { mode: 0o600 })
    const store = open()
    assert.equal(store.getTokenHash(), legacy)
    assert.deepEqual(store.getTokenCredential(), { verifier: legacy, source: 'config', updatedAt: 12345 })
    const projection = readCredentialProjection(dir)
    assert.equal(projection.token?.source, 'config')
    assert.equal(projection.token?.updatedAt, 12345)

    // legacy v1 plain {"hash": …} document
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ hash: legacy }), { mode: 0o600 })
    assert.equal(store.getTokenHash(), legacy)
    assert.equal(store.getTokenCredential()?.source, 'config')
    assert.equal(readCredentialProjection(dir).token?.source, 'config')
  } finally { cleanup() }
})

test('the CLI projection and status accept an hmac verifier and never leak it', () => {
  const { dir, store, cleanup } = tempStore()
  try {
    store.setTokenHash(hashToken(TOKEN, store.ensureTokenKey()), 'runtime')
    const projection = readCredentialProjection(dir)
    assert.equal(projection.token?.source, 'runtime')
    assert.equal(typeof projection.token?.updatedAt, 'number')

    const status = gatewayAuthStatus(dir)
    assert.match(status, /token: configured \(runtime, \d{4}-\d{2}-\d{2}T/)
    assert.equal(status.includes('hmac'), false, 'no verifier material in the status text')
    assert.equal(status.includes('$'), false)
    assert.equal(status.includes(TOKEN), false)
  } finally { cleanup() }
})

test('corrupt / unknown verifier shapes fail closed in the store, the projection and the provider', async () => {
  const { dir, store, open, tokensFile, cleanup } = tempStore()
  try {
    store.setTokenHash(hashToken(TOKEN, store.ensureTokenKey()), 'config')
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const writeRaw = (hash: string): void => {
      writeFileSync(tokensFile, JSON.stringify({ schemaVersion: 2, source: 'config', updatedAt: Date.now(), hash }), { mode: 0o600 })
    }
    for (const hash of [`sha256$${'a'.repeat(64)}`, `hmac$${'Z'.repeat(64)}`, 'not-a-verifier']) {
      writeRaw(hash)
      assert.equal(store.getTokenHash(), null, hash)
      assert.equal(store.getTokenCredential(), null, hash)
      assert.equal(readCredentialProjection(dir).token, null, hash)
      assert.equal(await auth.verify(bearer(TOKEN)), null, hash)
      assert.equal(await auth.verify(bearer(hash)), null, hash)
    }
    // A corrupt record is "unconfigured", not "anonymous": the presence cache
    // keeps the deployment authenticated, so the provider answers null (401).
    assert.equal(auth.kind, 'token')
    // A fresh store (no restart of the provider) still refuses the garbage file.
    assert.equal(open().getTokenHash(), null)
  } finally { cleanup() }
})

test('changeToken publishes an hmac verifier that survives a config-less restart', async () => {
  const { store, open, cleanup } = tempStore()
  try {
    const auth = createAuth({ kind: 'token', token: TOKEN }, store)
    const result = await auth.changeToken!({ newToken: RUNTIME_TOKEN }, bearer(TOKEN))
    assert.deepEqual(result, { changed: true, kind: 'token', source: 'runtime', token: RUNTIME_TOKEN })
    const record = store.getTokenCredential()
    assert.match(record?.verifier ?? '', HMAC_RE)
    assert.equal(record?.source, 'runtime')

    const reopened = open()
    const restarted = createAuth({ kind: 'none' }, reopened)
    assert.match(reopened.getTokenHash() ?? '', HMAC_RE)
    assert.equal((await restarted.verify(bearer(RUNTIME_TOKEN)))?.kind, 'token')
    assert.equal(await restarted.verify(bearer(TOKEN)), null)
  } finally { cleanup() }
})

test('verifyToken is a pure constant-time hmac compare: wrong token, null key and legacy shapes are false', () => {
  const { store, cleanup } = tempStore()
  try {
    const key = store.ensureTokenKey()
    const hmac = hashToken(TOKEN, key)
    assert.equal(verifyToken(TOKEN, hmac, key), true)
    assert.equal(verifyToken(OTHER_TOKEN, hmac, key), false)
    assert.equal(verifyToken(TOKEN, hmac, null), false)
    assert.equal(verifyToken(TOKEN, hashCredential(TOKEN), key), false, 'the hmac comparator never accepts a scrypt record')
    assert.equal(verifyToken(TOKEN, null, key), false)
    assert.equal(verifyToken(TOKEN, 'hmac$' + 'a'.repeat(63), key), false)
  } finally { cleanup() }
})
