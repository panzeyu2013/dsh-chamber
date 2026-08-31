import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { parse, resolve, join } from 'node:path'
import { createGatewayStore, hashCredential, readCredentialProjection, validateGatewayStateDirPath } from '../src/store.ts'

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

  await store.worktrees.mutate(() => ({ next: { items: [] }, changed: true }))
  await store.schedule.mutate(() => ({
    next: { items: [{ id: 'job', delayMs: 1_000, intervalMs: null, targetSessionId: 's1', prompt: 'private prompt' }] },
    changed: true,
  }))
  await store.settings.mutate(doc => ({ next: { ...doc, git: { enabled: true } }, changed: true }))
  store.setTokenHash('hash-only')
  store.getJwtSecret()
  store.setPasswordCredential(hashCredential('a sufficiently long private password'))

  if (process.platform !== 'win32') {
    assert.equal(mode(stateDir), 0o700)
    assert.equal(mode(join(stateDir, 'gateway')), 0o700)
  }
  for (const file of [
    'tokens.json', 'jwt-secret', 'password-credential', '.gateway.lock',
    'gateway/worktrees.json', 'gateway/worktrees.json.bak',
    'gateway/schedule.json', 'gateway/schedule.json.bak',
    'gateway/settings.json', 'gateway/settings.json.bak',
  ]) assert.equal(mode(join(stateDir, file)), 0o600, file)
  store.close()
})

test('gateway creates a new dedicated stateDir as 0700 on POSIX', { skip: process.platform === 'win32' }, t => {
  const parent = mkdtempSync(join(tmpdir(), 'gateway-new-state-parent-'))
  const stateDir = join(parent, 'state')
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.equal(mode(stateDir), 0o700)
  store.close()
})

test('gateway rejects a loose existing stateDir without changing its mode on POSIX', { skip: process.platform === 'win32' }, t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-loose-state-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  chmodSync(stateDir, 0o755)
  assert.throws(
    () => createGatewayStore(stateDir, { log() {}, warn() {}, error() {} }),
    /must already have mode 0700/,
  )
  assert.equal(mode(stateDir), 0o755)
  assert.equal(existsSync(join(stateDir, 'gateway')), false, 'validation happens before child creation')
})

test('gateway preserves an existing Windows stateDir ACL/mode projection', { skip: process.platform !== 'win32' }, t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-windows-state-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const beforeMode = mode(stateDir)
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.equal(mode(stateDir), beforeMode)
  store.close()
})

test('gateway rejects exact broad filesystem roots', () => {
  for (const broadRoot of [parse(resolve('/')).root, homedir(), tmpdir()]) {
    assert.throws(() => validateGatewayStateDirPath(broadRoot), /dedicated child directory/)
  }
})

test('domain-invalid JSON main documents recover from valid backups', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-domain-backup-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const root = join(stateDir, 'gateway')
  mkdirSync(root)

  const worktree = {
    id: 'ws-recovered', workspaceId: 'ws-recovered', sessionId: 'session-recovered',
    repo: '/srv/repo', path: '/srv/recovered', branch: 'feature/recovered',
    ownership: 'owned', state: 'ready', createdAt: 123,
  }
  const scheduled = {
    id: 'job-recovered', delayMs: 1_000, intervalMs: null,
    targetSessionId: 'session-recovered', prompt: 'continue',
  }
  writeFileSync(join(root, 'worktrees.json'), '{}\n', { mode: 0o600 })
  writeFileSync(join(root, 'worktrees.json.bak'), `${JSON.stringify({ items: [worktree] })}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'schedule.json'), `${JSON.stringify({ schemaVersion: 99, items: [] })}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'schedule.json.bak'), `${JSON.stringify({ items: [scheduled] })}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'settings.json'), '{}\n', { mode: 0o600 })
  writeFileSync(join(root, 'settings.json.bak'), `${JSON.stringify({
    schemaVersion: 1, revision: 4, git: { enabled: true },
  })}\n`, { mode: 0o600 })

  const warnings: string[] = []
  const store = createGatewayStore(stateDir, {
    log() {}, warn: (message: unknown) => warnings.push(String(message)), error() {},
  })
  assert.deepEqual(store.worktrees.get().items, [worktree])
  assert.deepEqual(store.schedule.get().items, [scheduled])
  assert.deepEqual(store.settings.get(), { schemaVersion: 1, revision: 4, git: { enabled: true } })
  assert.equal(warnings.filter(message => message.includes('recovered') && message.includes('.bak')).length, 3)
  assert.deepEqual(readJson(join(root, 'worktrees.json')), {}, 'backup recovery must not rewrite the invalid main')
  store.close()
})

test('invalid collection rows are isolated without truncating complete valid rows or falling back', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-domain-row-isolation-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const root = join(stateDir, 'gateway')
  mkdirSync(root)

  const completeWorktree = {
    id: 'ws-current', workspaceId: 'ws-current', sessionId: 'session-current',
    repo: '/srv/repo', path: '/srv/current', branch: 'feature/current', ownership: 'owned',
    state: 'deleting', error: 'retryable failure', createdAt: 456,
    futureMetadata: { retained: true },
  }
  const backupWorktree = {
    id: 'ws-old', workspaceId: 'ws-old', path: '/srv/old', branch: 'feature/old',
    ownership: 'owned', state: 'ready', createdAt: 1,
  }
  writeFileSync(join(root, 'worktrees.json'), `${JSON.stringify({
    items: [completeWorktree, { id: 42, workspaceId: 'broken' }],
  })}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'worktrees.json.bak'), `${JSON.stringify({ items: [backupWorktree] })}\n`, { mode: 0o600 })

  const completeSchedule = {
    id: 'job-current', delayMs: 2_000, intervalMs: 5_000,
    targetSessionId: 'session-current', prompt: 'continue safely',
    futureMetadata: { retained: true },
  }
  const backupSchedule = {
    id: 'job-old', delayMs: 1_000, intervalMs: null,
    targetSessionId: 'session-old', prompt: 'old',
  }
  writeFileSync(join(root, 'schedule.json'), `${JSON.stringify({
    items: [completeSchedule, { id: 'job-broken', delayMs: -1 }],
  })}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'schedule.json.bak'), `${JSON.stringify({ items: [backupSchedule] })}\n`, { mode: 0o600 })

  const warnings: string[] = []
  const store = createGatewayStore(stateDir, {
    log() {}, warn: (message: unknown) => warnings.push(String(message)), error() {},
  })
  assert.deepEqual(store.worktrees.get().items, [completeWorktree],
    'a bad row is dropped without reconstructing or truncating its complete sibling')
  assert.deepEqual(store.schedule.get().items, [completeSchedule],
    'a bad row is dropped without replacing valid main rows with an older backup')
  assert.equal(warnings.some(message => message.includes('1 invalid persisted worktrees row')), true)
  assert.equal(warnings.some(message => message.includes('1 invalid persisted schedule row')), true)
  assert.equal(warnings.some(message => message.includes('recovered worktrees document')), false)
  assert.equal(warnings.some(message => message.includes('recovered schedule document')), false)
  store.close()
})

test('known-schema documents preserve unknown future root and settings-section fields', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-domain-forward-compatible-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const root = join(stateDir, 'gateway')
  mkdirSync(root)
  writeFileSync(join(root, 'worktrees.json'), `${JSON.stringify({
    schemaVersion: 1,
    items: [],
    futureRoot: { retained: true },
  })}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'settings.json'), `${JSON.stringify({
    schemaVersion: 1,
    revision: 2,
    git: { enabled: true, futureOption: 'retain-me' },
    futureSection: { enabled: false },
  })}\n`, { mode: 0o600 })

  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.deepEqual((store.worktrees.get() as unknown as { futureRoot: unknown }).futureRoot, { retained: true })
  const settings = store.settings.get() as unknown as Record<string, unknown>
  assert.deepEqual(settings.git, { enabled: true, futureOption: 'retain-me' })
  assert.deepEqual(settings.futureSection, { enabled: false })
  store.close()
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
  // The stateDir exclusive lock must be released before reopening (Phase 1).
  store.close()
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
  store.close()
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

test('stateDir exclusive lock is acquired on open and released by close', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lock-close-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  const lockFile = join(stateDir, '.gateway.lock')

  assert.equal(existsSync(lockFile), true)
  assert.equal(mode(lockFile), 0o600)
  const lock = readJson(lockFile)
  assert.equal(lock.pid, process.pid)
  assert.ok(Number.isInteger(lock.createdAt) && lock.createdAt > 0)

  store.close()
  assert.equal(existsSync(lockFile), false)
  store.close() // close is idempotent
  assert.equal(existsSync(lockFile), false)
})

test('document initialization failure releases the already-acquired stateDir lock', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lock-init-failure-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  mkdirSync(join(stateDir, 'gateway'))
  const corruptPath = join(stateDir, 'gateway', 'worktrees.json')
  mkdirSync(corruptPath)

  assert.throws(
    () => createGatewayStore(stateDir, { log() {}, warn() {}, error() {} }),
    /is corrupt and no valid backup/,
  )
  assert.equal(existsSync(join(stateDir, '.gateway.lock')), false, 'failed construction must release its lock')

  rmSync(corruptPath, { recursive: true })
  const reopened = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  reopened.close()
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
  store.close()
})

test('stateDir exclusive lock rejects a live owner loudly', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lock-live-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.throws(
    () => createGatewayStore(stateDir, { log() {}, warn() {}, error() {} }),
    /already locked by running process/,
  )
  store.close()
  // After release the same directory can be reopened.
  const reopened = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  reopened.close()
})

test('stateDir exclusive lock takes over a stale lock from a dead pid with a warning', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lock-stale-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  // A crashed owner left a lock behind; pid 99999999 is not running.
  writeFileSync(join(stateDir, '.gateway.lock'), JSON.stringify({ pid: 99_999_999, createdAt: 1 }), { mode: 0o600 })
  const warns: string[] = []
  const store = createGatewayStore(stateDir, { log() {}, warn: (message: unknown) => warns.push(String(message)), error() {} })
  const lock = readJson(join(stateDir, '.gateway.lock'))
  assert.equal(lock.pid, process.pid)
  assert.equal(warns.some(message => message.includes('taking over a stale state lock')), true)
  store.close()
  assert.equal(existsSync(join(stateDir, '.gateway.lock')), false)

  // A crash can leave an O_EXCL-created lock before its JSON write. Empty is
  // corrupt evidence, not absence; it must be claimable rather than wedging
  // every future start behind repeated EEXIST.
  writeFileSync(join(stateDir, '.gateway.lock'), '', { mode: 0o600 })
  const afterTornCreate = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.equal(readJson(join(stateDir, '.gateway.lock')).pid, process.pid)
  afterTornCreate.close()
})

test('stateDir exclusive lock is released on process exit (best-effort)', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lock-exit-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const lockFile = join(stateDir, '.gateway.lock')
  // A child process opens the store and exits normally; its exit handler must
  // remove the lock so the next process can start without manual cleanup.
  const script = [
    `import { createGatewayStore } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};`,
    `createGatewayStore(${JSON.stringify(stateDir)}, console);`,
  ].join('')
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' })
  assert.equal(existsSync(lockFile), false)
})

test('a FAILED lock acquisition never deletes the live owner lock on process exit', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lock-failed-exit-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const lockFile = join(stateDir, '.gateway.lock')
  const owner = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  assert.equal(existsSync(lockFile), true)

  // A child process attempts to open the same directory (live lock → throws),
  // then exits normally. Its failure path must NOT register an exit listener
  // that removes the owner's lock (M2 fix round regression).
  const script = [
    `import { createGatewayStore } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};`,
    `try { createGatewayStore(${JSON.stringify(stateDir)}, console); process.exit(3); } catch (error) { process.exit(1); }`,
  ].join('')
  let childExitCode = 0
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' })
  } catch (error) {
    childExitCode = (error as { status?: number }).status ?? -1
  }
  assert.equal(childExitCode, 1, 'child exited 1 after the refused acquisition')
  assert.equal(existsSync(lockFile), true, 'the live owner lock must survive the failed child acquisition')

  owner.close()
})

test('live-lock errors carry the structured gateway_locked code and owner pid', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lock-structured-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const owner = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  try {
    const error = (() => {
      try {
        createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
        return null
      } catch (caught) {
        return caught as Error & { code?: string; pid?: number }
      }
    })()
    assert.ok(error !== null)
    assert.equal(error.code, 'gateway_locked')
    assert.equal(error.pid, process.pid)
  } finally {
    owner.close()
  }
})

test('releaseLock only removes a lock still owned by this process', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lock-foreign-release-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const lockFile = join(stateDir, '.gateway.lock')
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  // Simulate a takeover successor with a distinct inode (same-process tests
  // must prove identity, not merely changed JSON content).
  const successor = join(stateDir, '.gateway.lock.successor')
  const successorText = JSON.stringify({ pid: 99_999_999, createdAt: Date.now() })
  writeFileSync(successor, successorText, { mode: 0o644 })
  renameSync(successor, lockFile)
  store.close()
  assert.equal(existsSync(lockFile), true, 'close() must refuse to delete a foreign-owned lock')
  assert.equal(readFileSync(lockFile, 'utf8'), successorText)
  assert.equal(mode(lockFile), 0o644, 'an obsolete owner must not chmod its successor while inspecting it')
  // Ownership was released by the refusal (fail-closed): reacquire re-takes
  // the lock — the foreign pid is dead, so the stale takeover applies and the
  // lock becomes ours again.
  store.reacquire()
  assert.equal(readJson(lockFile).pid, process.pid, 'reacquire re-takes the directory after the refused release')
  store.close()
  assert.equal(existsSync(lockFile), false)
})

test('reacquire re-takes the lock after close and stays a no-op while held', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lock-reacquire-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const lockFile = join(stateDir, '.gateway.lock')
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })

  // While held, reacquire is a no-op.
  store.reacquire()
  assert.equal(readJson(lockFile).pid, process.pid)

  store.close()
  assert.equal(existsSync(lockFile), false)
  // After close, reacquire re-takes the lock (gateway start() retry path).
  store.reacquire()
  assert.equal(existsSync(lockFile), true)
  assert.equal(readJson(lockFile).pid, process.pid)
  assert.throws(
    () => createGatewayStore(stateDir, { log() {}, warn() {}, error() {} }),
    /already locked by running process/,
  )
  store.close()
  assert.equal(existsSync(lockFile), false)
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
  store.close()
})

test('concurrent stale-lock takeovers never double-hold the directory (pair stress)', async t => {
  // The takeover scheme (rename-claim + moved-content verification +
  // restore + final ownership verification) PROVABLY closes the two-process
  // case: with exactly two contenders, the loser's restore always finds an
  // empty path (no third process can occupy it), so a fresh live lock is
  // never destroyed and at most one contender can ever hold. A 3-process
  // interleaving (a third process creating in the restore gap) retains a
  // documented residual — the same class every pidfile lock accepts without
  // kernel flock. This test asserts the provable property under repeated
  // real multi-process races (0 winners is legal — both contenders can
  // fail closed; 2 winners is the regression).
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-lock-stress-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const lockFile = join(stateDir, '.gateway.lock')
  const childScript = [
    `import { createGatewayStore } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};`,
    `import { writeFileSync } from 'node:fs';`,
    `const stateDir = ${JSON.stringify(stateDir)};`,
    `try {`,
    `  const store = createGatewayStore(stateDir, console);`,
    `  writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid }));`,
    // Hold the lock long enough that a slightly delayed second contender
    // (slow node startup under CI load) still sees the live lock instead of
    // legitimately taking over after our release — a 100ms hold made the
    // "at most one winner" assertion flaky (scanner A finding).
    `  setTimeout(() => { store.close(); process.exit(0); }, 1000);`,
    `} catch { process.exit(1); }`,
  ].join('\n')

  for (let round = 0; round < 15; round += 1) {
    // Fresh stale lock (dead pid) for every round.
    writeFileSync(lockFile, JSON.stringify({ pid: 99_999_999, createdAt: round }), { mode: 0o600 })
    const children: Array<{ child: import('node:child_process').ChildProcess; won: string }> = []
    for (let i = 0; i < 2; i += 1) {
      const won = join(stateDir, `won-${round}-${i}`)
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, won], { stdio: 'ignore' })
      children.push({ child, won })
      // Watchdog: a wedged child must not hang the suite forever.
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 20_000)
      child.on('exit', () => clearTimeout(watchdog))
    }
    await Promise.all(children.map(({ child }) => new Promise<void>(resolve => child.on('exit', () => resolve()))))
    const winners = children.filter(({ won }) => existsSync(won))
    assert.ok(winners.length <= 1, `round ${round}: at most one contender may hold the directory (got ${winners.length})`)
    for (const { won } of children) rmSync(won, { force: true })
  }
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
  store.close()
})

test('credential projection refuses oversized private files at a KiB-scale bound', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-projection-bounded-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  writeFileSync(join(stateDir, 'password-credential'), 'x'.repeat(17 * 1024), { mode: 0o600 })
  assert.equal(readCredentialProjection(stateDir).password, null)
})
