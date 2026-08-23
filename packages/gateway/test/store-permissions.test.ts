import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayStore } from '../src/store.ts'

const mode = (path: string): number => statSync(path).mode & 0o777

test('gateway state directories and every persisted document are owner-only', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-private-store-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  chmodSync(stateDir, 0o755)
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })

  await store.gateway.mutate(doc => ({ next: { ...doc, channels: [{ id: 'private' }] }, changed: true }))
  await store.worktrees.mutate(() => ({ next: { items: [] }, changed: true }))
  await store.schedule.mutate(() => ({
    next: { items: [{ id: 'job', delayMs: 1_000, intervalMs: null, targetSessionId: 's1', prompt: 'private prompt' }] },
    changed: true,
  }))
  await store.settings.mutate(doc => ({ next: { ...doc, git: { enabled: true } }, changed: true }))
  store.setTokenHash('hash-only')
  store.getJwtSecret()
  store.syncPasswordCredential('a sufficiently long private password')

  assert.equal(mode(stateDir), 0o700)
  assert.equal(mode(join(stateDir, 'gateway')), 0o700)
  for (const file of [
    'gateway.json', 'gateway.json.bak', 'tokens.json', 'jwt-secret', 'password-credential',
    'gateway/worktrees.json', 'gateway/worktrees.json.bak',
    'gateway/schedule.json', 'gateway/schedule.json.bak',
    'gateway/settings.json', 'gateway/settings.json.bak',
  ]) assert.equal(mode(join(stateDir, file)), 0o600, file)
})

test('pre-existing JWT and password verifier files are tightened before reading', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-private-store-existing-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const password = 'a sufficiently long private password'
  const store = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })
  store.syncPasswordCredential(password)
  const expectedJwtSecret = store.getJwtSecret()
  const jwtSecretFile = join(stateDir, 'jwt-secret')
  const passwordCredentialFile = join(stateDir, 'password-credential')

  chmodSync(jwtSecretFile, 0o644)
  chmodSync(passwordCredentialFile, 0o644)
  const reloaded = createGatewayStore(stateDir, { log() {}, warn() {}, error() {} })

  assert.equal(reloaded.getJwtSecret(), expectedJwtSecret)
  reloaded.syncPasswordCredential(password)
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
