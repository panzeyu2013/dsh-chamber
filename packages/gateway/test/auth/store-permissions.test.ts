import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayStore, hashCredential, readCredentialProjection } from '../../src/store.ts'

const mode = (path: string): number => statSync(path).mode & 0o777
const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'))

function symlinkOrSkip(t: any, target: string, path: string, type: 'file' | 'dir'): boolean {
  try {
    symlinkSync(target, path, type)
    return true
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return false
    }
    throw error
  }
}

test('gateway state directories and every persisted document are owner-only', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-private-store-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })

  store.setTokenHash('hash-only')
  store.getJwtSecret()
  store.setPasswordCredential(hashCredential('a sufficiently long private password'))

  if (process.platform !== 'win32') {
    assert.equal(mode(stateDir), 0o700)
    assert.equal(mode(join(stateDir, 'gateway')), 0o700)
  }
  for (const file of [
    'tokens.json', 'jwt-secret', 'password-credential',
  ]) assert.equal(mode(join(stateDir, file)), 0o600, file)
})

test('gateway creates a new dedicated stateDir as 0700 on POSIX', { skip: process.platform === 'win32' }, t => {
  const parent = mkdtempSync(join(tmpdir(), 'gateway-new-state-parent-'))
  const stateDir = join(parent, 'state')
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.equal(mode(stateDir), 0o700)
})

test('gateway tightens a loose existing stateDir to 0700 on POSIX', { skip: process.platform === 'win32' }, t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-loose-state-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  chmodSync(stateDir, 0o755)
  const warnings: string[] = []
  const store = createGatewayStore(stateDir, { log() {}, warn: (message: unknown) => warnings.push(String(message)), error() {} })
  assert.equal(mode(stateDir), 0o700)
  assert.equal(mode(join(stateDir, 'gateway')), 0o700)
  assert.equal(warnings.some(message => message.includes('tightening to 0700')), true, 'a loose root must be announced once')
  // Tightening must leave the store fully usable: credentials stay 0600 and
  // values round-trip.
  store.setPasswordCredential(hashCredential('a sufficiently long private password'))
  store.getJwtSecret()
  assert.equal(mode(join(stateDir, 'password-credential')), 0o600)
  assert.equal(mode(join(stateDir, 'jwt-secret')), 0o600)
  assert.notEqual(store.getPasswordCredential(), null)
})

test('gateway tightens a loose pre-existing gateway/ subdirectory to 0700 on POSIX', { skip: process.platform === 'win32' }, t => {
  // The stateDir is already 0700 but the gateway/ child exists as a loose 0755
  // directory (an installer-created layout). This test covers the root call
  // site: existingMode:'require' would NOT be caught by the stateDir-only test
  // above (there the child is freshly created).
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-loose-root-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const root = join(stateDir, 'gateway')
  mkdirSync(root, { mode: 0o755 })
  writeFileSync(join(root, 'tokens.json'), '{"schemaVersion":2,"source":"config","updatedAt":1,"hash":"scrypt$x"}\n', { mode: 0o600 })
  createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.equal(mode(stateDir), 0o700)
  assert.equal(mode(root), 0o700)
  assert.equal(mode(join(root, 'tokens.json')), 0o600, 'pre-existing credential files keep their mode after tightening')
})

test('gateway refuses a stateDir owned by another user on POSIX', { skip: process.platform === 'win32' || process.getuid?.() !== 0 }, t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-foreign-state-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  chmodSync(stateDir, 0o755)
  try {
    chownSync(stateDir, 65534, 65534)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') t.skip('chown unavailable')
    throw error
  }
  assert.throws(
    () => createGatewayStore(stateDir, { log() {}, warn() {}, error() {} }),
    /not owned by the current user/,
  )
  assert.equal(mode(stateDir), 0o755, 'a foreign-owned root must not be touched')
})

test('gateway preserves an existing Windows stateDir ACL/mode projection', { skip: process.platform !== 'win32' }, t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-windows-state-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const beforeMode = mode(stateDir)
  createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.equal(mode(stateDir), beforeMode)
})

test('pre-existing JWT and password verifier files are tightened before reading', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-private-store-existing-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const password = 'a sufficiently long private password'
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  store.setPasswordCredential(hashCredential(password))
  const expectedJwtSecret = store.getJwtSecret()
  const jwtSecretFile = join(stateDir, 'jwt-secret')
  const passwordCredentialFile = join(stateDir, 'password-credential')

  chmodSync(jwtSecretFile, 0o644)
  chmodSync(passwordCredentialFile, 0o644)
  // A later open tightens the loose files before reading them.
  const reloaded = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })

  assert.equal(reloaded.getJwtSecret(), expectedJwtSecret)
  reloaded.setPasswordCredential(hashCredential(password))
  assert.equal(mode(jwtSecretFile), 0o600)
  assert.equal(mode(passwordCredentialFile), 0o600)
})

test('gateway secret reads reject symbolic links without touching their target', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-private-store-symlink-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const target = join(stateDir, 'outside-secret')
  const jwtSecretFile = join(stateDir, 'jwt-secret')
  writeFileSync(target, 'x'.repeat(64))
  chmodSync(target, 0o644)
  try {
    symlinkSync(target, jwtSecretFile, 'file')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }

  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.throws(() => store.getJwtSecret(), /must be a regular file/)
  assert.equal(mode(target), 0o644)
})

test('gateway secret reads reject non-regular files', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-private-store-non-regular-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  mkdirSync(join(stateDir, 'jwt-secret'))

  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.throws(() => store.getJwtSecret(), /must be a regular file/)
})

test('gateway rejects symlinked state roots without modifying their targets', t => {
  const parent = mkdtempSync(join(tmpdir(), 'gateway-private-root-symlink-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const externalState = join(parent, 'external-state')
  const stateLink = join(parent, 'state-link')
  mkdirSync(externalState, { mode: 0o755 })
  if (!symlinkOrSkip(t, externalState, stateLink, 'dir')) return

  assert.throws(() => createGatewayStore(stateLink, { log() {}, warn() {}, error() {} }), /not a real directory/)
  assert.equal(mode(externalState), 0o755)
  assert.deepEqual(readdirSync(externalState), [])

  const stateDir = join(parent, 'real-state')
  const externalGateway = join(parent, 'external-gateway')
  mkdirSync(stateDir, { mode: 0o700 })
  mkdirSync(externalGateway, { mode: 0o755 })
  if (!symlinkOrSkip(t, externalGateway, join(stateDir, 'gateway'), 'dir')) return
  assert.throws(() => createGatewayStore(stateDir, { log() {}, warn() {}, error() {} }), /not a real directory/)
  assert.equal(mode(externalGateway), 0o755)
  assert.deepEqual(readdirSync(externalGateway), [])
})

test('credential files are written as v2 JSON with source and updatedAt (atomic, 0600)', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-credential-v2-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })

  const verifier = hashCredential('a sufficiently long private password')
  const tokenHash = hashCredential('0123456789abcdef0123456789abcdef')
  const before = Date.now()
  store.setPasswordCredential(verifier, 'runtime')
  store.setTokenHash(tokenHash, 'runtime')
  const after = Date.now()

  const passwordDoc = readJson(join(stateDir, 'password-credential'))
  assert.equal(passwordDoc.schemaVersion, 2)
  assert.equal(passwordDoc.source, 'runtime')
  assert.equal(passwordDoc.verifier, verifier)
  assert.ok(Number.isInteger(passwordDoc.updatedAt) && passwordDoc.updatedAt >= before && passwordDoc.updatedAt <= after)
  assert.equal(mode(join(stateDir, 'password-credential')), 0o600)

  const tokenDoc = readJson(join(stateDir, 'tokens.json'))
  assert.equal(tokenDoc.schemaVersion, 2)
  assert.equal(tokenDoc.source, 'runtime')
  assert.equal(tokenDoc.hash, tokenHash)
  assert.ok(Number.isInteger(tokenDoc.updatedAt) && tokenDoc.updatedAt >= before && tokenDoc.updatedAt <= after)
  assert.equal(mode(join(stateDir, 'tokens.json')), 0o600)

  // Atomic write discipline leaves no tmp leftovers (design 17 §12).
  for (const file of ['password-credential.tmp', 'tokens.json.tmp']) {
    assert.equal(existsSync(join(stateDir, file)), false, file)
  }

  // Round-trip reads, and a config-sourced write flips the source.
  assert.equal(store.getPasswordCredential(), verifier)
  assert.deepEqual(store.getPasswordCredentialRecord(), { verifier, source: 'runtime', updatedAt: passwordDoc.updatedAt })
  assert.equal(store.getTokenHash(), tokenHash)
  assert.deepEqual(store.getTokenCredential(), { verifier: tokenHash, source: 'runtime', updatedAt: tokenDoc.updatedAt })
  store.setPasswordCredential(verifier, 'config')
  assert.equal(readJson(join(stateDir, 'password-credential')).source, 'config')
})

test('credential writes ignore predictable temp symlinks and never touch their targets', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-credential-temp-symlink-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  const tokenVictim = join(stateDir, 'token-victim')
  const passwordVictim = join(stateDir, 'password-victim')
  writeFileSync(tokenVictim, 'DO NOT TOUCH TOKEN', { mode: 0o644 })
  writeFileSync(passwordVictim, 'DO NOT TOUCH PASSWORD', { mode: 0o644 })
  if (!symlinkOrSkip(t, tokenVictim, join(stateDir, 'tokens.json.tmp'), 'file')) return
  if (!symlinkOrSkip(t, passwordVictim, join(stateDir, 'password-credential.tmp'), 'file')) return

  store.setTokenHash(hashCredential('0123456789abcdef0123456789abcdef'))
  store.setPasswordCredential(hashCredential('a sufficiently long private password'))
  assert.equal(readFileSync(tokenVictim, 'utf8'), 'DO NOT TOUCH TOKEN')
  assert.equal(readFileSync(passwordVictim, 'utf8'), 'DO NOT TOUCH PASSWORD')
  assert.equal(mode(tokenVictim), 0o644)
  assert.equal(mode(passwordVictim), 0o644)
})

test('legacy v1 credential files read as config-sourced and migrate to v2 on write', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-credential-legacy-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const password = 'a sufficiently long private password'
  const legacyVerifier = hashCredential(password)
  const legacyToken = hashCredential('0123456789abcdef0123456789abcdef')
  // Legacy v1 shapes: a bare `scrypt$salt$hash` string for the password and a
  // plain `{"hash":...}` document for tokens.
  writeFileSync(join(stateDir, 'password-credential'), legacyVerifier, { mode: 0o600 })
  writeFileSync(join(stateDir, 'tokens.json'), JSON.stringify({ hash: legacyToken }), { mode: 0o600 })

  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.equal(store.getPasswordCredential(), legacyVerifier)
  const passwordRecord = store.getPasswordCredentialRecord()
  assert.equal(passwordRecord?.verifier, legacyVerifier)
  assert.equal(passwordRecord?.source, 'config')
  assert.ok(typeof passwordRecord?.updatedAt === 'number' && passwordRecord.updatedAt > 0, 'legacy updatedAt comes from the file mtime')
  assert.equal(store.getTokenHash(), legacyToken)
  const tokenRecord = store.getTokenCredential()
  assert.equal(tokenRecord?.verifier, legacyToken)
  assert.equal(tokenRecord?.source, 'config')

  // The next write migrates both files to v2 JSON.
  const migratedVerifier = hashCredential('a different sufficiently long password')
  store.setPasswordCredential(migratedVerifier)
  store.setTokenHash(hashCredential('abcdef0123456789abcdef0123456789'))
  const passwordDoc = readJson(join(stateDir, 'password-credential'))
  assert.equal(passwordDoc.schemaVersion, 2)
  assert.equal(passwordDoc.source, 'config')
  assert.equal(passwordDoc.verifier, migratedVerifier)
  assert.equal(readJson(join(stateDir, 'tokens.json')).schemaVersion, 2)
})

test('credential deletion is idempotent only for absence and propagates real filesystem failures', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-credential-delete-failure-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })

  assert.doesNotThrow(() => store.setTokenHash(null))
  assert.doesNotThrow(() => store.setPasswordCredential(null))
  mkdirSync(join(stateDir, 'tokens.json'))
  mkdirSync(join(stateDir, 'password-credential'))
  assert.throws(() => store.setTokenHash(null), 'a non-file token path must not be reported as removed')
  assert.throws(() => store.setPasswordCredential(null), 'a non-file password path must not be reported as removed')
})

test('a v2 credential with a garbage verifier shape is corrupt (never silently disables auth)', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-credential-garbage-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  writeFileSync(join(stateDir, 'password-credential'),
    JSON.stringify({ schemaVersion: 2, source: 'runtime', updatedAt: Date.now(), verifier: 'garbage' }),
    { mode: 0o600 })
  writeFileSync(join(stateDir, 'tokens.json'),
    JSON.stringify({ schemaVersion: 2, source: 'runtime', updatedAt: Date.now(), hash: 'not-a-verifier' }),
    { mode: 0o600 })

  const warns: string[] = []
  const store = createGatewayStore(stateDir, { log() {}, warn: (message: unknown) => warns.push(String(message)), error() {} })
  assert.equal(store.getPasswordCredential(), null, 'garbage verifier reads as unconfigured')
  assert.equal(store.getTokenHash(), null, 'garbage hash reads as unconfigured')
  assert.equal(store.getPasswordCredentialRecord(), null)
  assert.equal(store.getTokenCredential(), null)
  // Corrupt files warn once per process (no per-request spam).
  store.getPasswordCredential()
  store.getTokenHash()
  assert.equal(warns.filter(message => message.includes('corrupt v2')).length, 2)
})

test('readCredentialProjection is read-only: it never mutates the credential files', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-projection-readonly-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  store.setPasswordCredential(hashCredential('a sufficiently long private password'))
  store.setTokenHash(hashCredential('0123456789abcdef0123456789abcdef'))
  const safeProjection = readCredentialProjection(stateDir)
  assert.equal(safeProjection.password?.source, 'config')
  assert.equal(safeProjection.token?.source, 'config')
  // A loose legacy mode must survive the projection read (no fchmod on the
  // read-only path), but is rejected rather than trusted as configured.
  chmodSync(join(stateDir, 'password-credential'), 0o644)
  chmodSync(join(stateDir, 'tokens.json'), 0o644)

  const projection = readCredentialProjection(stateDir)
  assert.equal(projection.password, null)
  assert.equal(projection.token, null)
  assert.equal(mode(join(stateDir, 'password-credential')), 0o644)
  assert.equal(mode(join(stateDir, 'tokens.json')), 0o644)
})

test('credential projection refuses oversized private files at a KiB-scale bound', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-projection-bounded-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  writeFileSync(join(stateDir, 'password-credential'), 'x'.repeat(17 * 1024), { mode: 0o600 })
  assert.equal(readCredentialProjection(stateDir).password, null)
})
