/** gateway provider (design 17) unit tests — part 1: the encrypted/plaintext secrets store (0600,
 *  bindings, corruption), token/password validation gates, host/port constants and the direct-http
 *  verifyUp probe (siblings: gateway-session-spki / gateway-chamber-sync / apply-materialize). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureGatewaySecretStore as configureGatewaySecretStoreRaw, configureGatewayTokenStore as configureGatewayTokenStoreRaw, DEFAULT_GATEWAY_HTTP_PORT, DEFAULT_GATEWAY_PORT, GATEWAY_HOST_PATTERN, gatewayHttpFailureIsTerminal, gatewayPasswordValidationError, gatewayProvider, gatewaySecretStorageCrossFlavorUnreadable, gatewaySecretStorageMode, gatewayTokenValidationError, getGatewayPassword, getGatewayToken, setGatewayPassword, setGatewayToken, setInstanceSecrets } from '../../gateway-provider.ts'
import { GATEWAY_RUNTIME_STATUS } from '../../gateway-session-test-hooks.ts'
import type { SecretCryptoAdapter } from '../../gateway-provider.ts'
import { gatewayCredentialBinding } from '../../credential-binding.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'
import { startHttpProbeServer } from '../support/gateway-test-servers.ts'

const TOKEN = '0123456789abcdef0123456789abcdef'
const PASSWORD = 'gateway-login-password-123'
const UNICODE_PASSWORD = '正确的网关密码-安全🔐-2026'
function storedGatewaySpec(id: string): TransportInstanceSpec {
  return {
    id, label: id, kind: 'gateway', transport: 'http', host: 'gw.example.com',
    user: null, sshPort: null, remotePort: 443, serviceName: null,
    remoteDshHome: null, insecureHttp: false,
  }
}

function configureGatewaySecretStore(file: string | null, crypto?: SecretCryptoAdapter): string | null {
  return configureGatewaySecretStoreRaw(file, crypto, id => storedGatewaySpec(id))
}

function configureGatewayTokenStore(file: string | null): string | null {
  return configureGatewayTokenStoreRaw(file, id => storedGatewaySpec(id))
}

function boundPlaintextFile(tokens: Record<string, string>, passwords: Record<string, string>) {
  return {
    schemaVersion: 3,
    storage: 'plaintext',
    tokens,
    passwords,
    tokenBindings: Object.fromEntries(Object.keys(tokens).map(id => [id, gatewayCredentialBinding(storedGatewaySpec(id))])),
    passwordBindings: Object.fromEntries(Object.keys(passwords).map(id => [id, gatewayCredentialBinding(storedGatewaySpec(id))])),
  }
}

test('the gateway secrets store persists to and reloads from the mirror file (0600, atomic)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    assert.equal(configureGatewaySecretStore(file), null, 'missing file = first run, no notice')
    setGatewayToken('t-token-1', TOKEN)
    setGatewayToken('t-token-2', `${TOKEN}2`)
    setGatewayPassword('t-pw-1', PASSWORD)
    setGatewayPassword('t-pw-unicode', UNICODE_PASSWORD)
    assert.ok(existsSync(file), 'file is written on the first set')
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the secrets file is 0600')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(stored.schemaVersion, 3)
    assert.equal(stored.storage, 'plaintext', 'the fallback is explicitly tagged; readers never guess from credential characters')
    assert.equal(stored.tokens['t-token-1'], TOKEN, 'default crypto = plaintext mirror (旧测试语义)')
    assert.equal(stored.passwords['t-pw-1'], PASSWORD)
    assert.equal(stored.passwords['t-pw-unicode'], UNICODE_PASSWORD, 'Unicode survives JSON persistence unchanged')
    assert.equal(stored.passwordBindings['t-pw-unicode'], gatewayCredentialBinding(storedGatewaySpec('t-pw-unicode')))
    // The store reloads the file into memory.
    assert.equal(configureGatewaySecretStore(file), null)
    assert.equal(getGatewayToken('t-token-1'), TOKEN)
    assert.equal(getGatewayToken('t-token-2'), `${TOKEN}2`)
    assert.equal(getGatewayPassword('t-pw-1'), PASSWORD)
    assert.equal(getGatewayPassword('t-pw-unicode'), UNICODE_PASSWORD, 'Unicode password round-trips through reload')
    assert.equal(getGatewayPassword('t-token-1'), null, 'token and password are independent entries')
    // An explicit password clear removes ONLY the password entry (design 17
    // §2.3: independent credentials — the token survives).
    setGatewayPassword('t-pw-1', null)
    assert.equal(getGatewayPassword('t-pw-1'), null)
    assert.equal(getGatewayToken('t-token-1'), TOKEN, 'clearing the password never touches the token')
    const afterPwClear = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(afterPwClear.passwords['t-pw-1'], undefined)
    assert.equal(afterPwClear.tokens['t-token-1'], TOKEN)
    // The whole-instance scrub is the explicit dual-clear primitive used by
    // the main-owned save/delete transactions; per-dimension clear actions
    // remain independent (§2.3).
    setGatewayPassword('t-scrub', PASSWORD)
    assert.equal(getGatewayPassword('t-scrub'), PASSWORD)
    setInstanceSecrets('t-scrub', null, null)
    assert.equal(getGatewayToken('t-scrub'), null)
    assert.equal(getGatewayPassword('t-scrub'), null, 'the explicit dual-clear removes both credentials')
    // Clearing removes the token entry and rewrites the mirror.
    setGatewayToken('t-token-1', null)
    assert.equal(getGatewayToken('t-token-1'), null)
    const afterClear = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(afterClear.tokens['t-token-1'], undefined)
  } finally {
    setInstanceSecrets('t-token-1', null, null)
    setInstanceSecrets('t-token-2', null, null)
    setInstanceSecrets('t-pw-1', null, null)
    setInstanceSecrets('t-pw-unicode', null, null)
    setInstanceSecrets('t-scrub', null, null)
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gateway bindings fail closed across the secret-fsync → registry-fsync crash window and survive transport-only switches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-binding-'))
  const file = join(dir, 'gateway-secrets.json')
  const oldSpec = storedGatewaySpec('crash-gateway')
  const newSpec = { ...oldSpec, host: 'new-gateway.example.com', remotePort: 8443 }
  let current: TransportInstanceSpec | null = oldSpec
  try {
    configureGatewaySecretStoreRaw(file, undefined, () => current)
    setInstanceSecrets(oldSpec.id, TOKEN, UNICODE_PASSWORD, newSpec)
    assert.equal(getGatewayToken(oldSpec.id), null, 'new-target token is hidden under old registry metadata')
    assert.equal(getGatewayPassword(oldSpec.id), null, 'new-target password is hidden under old registry metadata')
    configureGatewaySecretStoreRaw(null)
    configureGatewaySecretStoreRaw(file, undefined, () => current)
    assert.equal(getGatewayToken(oldSpec.id), null, 'restart after the crash remains fail-closed')
    current = { ...newSpec, transport: 'ssh', user: 'alice', sshPort: 22 }
    assert.equal(getGatewayToken(oldSpec.id), TOKEN)
    assert.equal(getGatewayPassword(oldSpec.id), UNICODE_PASSWORD)
    current = { ...newSpec, transport: 'http', user: null, sshPort: null }
    assert.equal(getGatewayToken(oldSpec.id), TOKEN, 'gateway ssh→http in the same domain preserves auth')
    assert.equal(getGatewayPassword(oldSpec.id), UNICODE_PASSWORD)
  } finally {
    configureGatewaySecretStoreRaw(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gateway credential load tightens an existing regular file before reading and refuses symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-load-mode-'))
  const file = join(dir, 'gateway-secrets.json')
  const target = join(dir, 'target.json')
  const link = join(dir, 'linked-secrets.json')
  const payload = JSON.stringify(boundPlaintextFile({ 'mode-token': TOKEN }, {}))
  try {
    writeFileSync(file, payload, { mode: 0o644 })
    chmodSync(file, 0o644)
    assert.equal(configureGatewaySecretStore(file), null)
    assert.equal(statSync(file).mode & 0o777, 0o600, 'mode is tightened before the secret is admitted to memory')
    assert.equal(getGatewayToken('mode-token'), TOKEN)

    // Creating symlinks is privilege-gated on many Windows installations.
    // The production boundary still refuses them there via lstat/inode checks;
    // exercise the concrete link path on platforms where CI can create one.
    if (process.platform !== 'win32') {
      writeFileSync(target, payload, { mode: 0o644 })
      symlinkSync(target, link)
      const notice = configureGatewaySecretStore(link)
      assert.match(notice ?? '', /cannot read|regular file|symlink/)
      assert.equal(getGatewayToken('mode-token'), null, 'a symlink target is never loaded as a credential mirror')
      assert.equal(statSync(target).mode & 0o777, 0o644, 'refusing the link never mutates its target')
    }
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('token and password clears are independent; setInstanceSecrets is the explicit dual-clear (design 17 §2.3/§12)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-independent-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    assert.equal(configureGatewaySecretStore(file), null)
    // Both credentials configured for one instance.
    setGatewayToken('both-1', TOKEN)
    setGatewayPassword('both-1', PASSWORD)
    // A token clear removes ONLY the token — in memory AND in the mirror.
    setGatewayToken('both-1', null)
    assert.equal(getGatewayToken('both-1'), null)
    assert.equal(getGatewayPassword('both-1'), PASSWORD, 'a token clear never touches the password')
    let stored = JSON.parse(readFileSync(file, 'utf8')) as { tokens: Record<string, string>; passwords: Record<string, string> }
    assert.equal(stored.tokens['both-1'], undefined)
    assert.equal(stored.passwords['both-1'], PASSWORD, 'the mirror keeps the password after a token clear')
    // A password clear removes ONLY the password.
    setGatewayPassword('both-1', null)
    assert.equal(getGatewayPassword('both-1'), null)
    assert.equal(getGatewayToken('both-1'), null, 'a password clear never touches the token')
    stored = JSON.parse(readFileSync(file, 'utf8')) as { tokens: Record<string, string>; passwords: Record<string, string> }
    assert.equal(stored.passwords['both-1'], undefined)
    assert.equal(stored.tokens['both-1'], undefined)
    // The explicit dual-clear primitive scrubs BOTH dimensions in one write.
    setGatewayToken('both-2', TOKEN)
    setGatewayPassword('both-2', PASSWORD)
    setInstanceSecrets('both-2', null, null)
    assert.equal(getGatewayToken('both-2'), null)
    assert.equal(getGatewayPassword('both-2'), null)
    stored = JSON.parse(readFileSync(file, 'utf8')) as { tokens: Record<string, string>; passwords: Record<string, string> }
    assert.equal(stored.tokens['both-2'], undefined)
    assert.equal(stored.passwords['both-2'], undefined)
    // A dual-clear of an id owning neither credential is a disk no-op: the
    // mirror is not rewritten.
    const before = readFileSync(file, 'utf8')
    setInstanceSecrets('never-owned', null, null)
    assert.equal(readFileSync(file, 'utf8'), before, 'a never-owned dual clear does not rewrite the mirror')
    // setInstanceSecrets validates BOTH dimensions like the single setters.
    assert.throws(() => setInstanceSecrets('both-1', 'short', PASSWORD), /at least 32/)
    assert.throws(() => setInstanceSecrets('both-1', TOKEN, 'short'), /at least 12/)
    assert.throws(() => setInstanceSecrets('local', null, null), /refusing/)
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt gateway secrets file is preserved as *.corrupt and fails loudly, never silently empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-corrupt-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    writeFileSync(file, 'not json at all')
    const notice = configureGatewaySecretStore(file)
    assert.notEqual(notice, null, 'a corrupt file returns a loud notice')
    assert.match(notice ?? '', /\.corrupt/)
    assert.ok(existsSync(`${file}.corrupt`), 'the corrupt bytes are preserved')
    assert.equal(existsSync(file), false, 'the original is renamed away')
    assert.equal(getGatewayToken('anything'), null, 'the store is empty, but that is loud, not silent')

    // Well-formed files with INVALID entries are equally corrupt — BOTH
    // tables are validated (design 17 §12 corrupt 检测按新 schema 扩展).
    const file2 = join(dir, 'gateway-secrets-2.json')
    writeFileSync(file2, JSON.stringify({ schemaVersion: 2, storage: 'plaintext', tokens: { 't-bad': 'short' }, passwords: {} }))
    assert.notEqual(configureGatewaySecretStore(file2), null)
    assert.ok(existsSync(`${file2}.corrupt`))

    const file3 = join(dir, 'gateway-secrets-3.json')
    writeFileSync(file3, JSON.stringify({ schemaVersion: 2, storage: 'plaintext', tokens: {}, passwords: { 'p-bad': 'short' } }))
    assert.notEqual(configureGatewaySecretStore(file3), null, 'an invalid password entry corrupts the whole file')

    const file4 = join(dir, 'gateway-secrets-4.json')
    writeFileSync(file4, JSON.stringify({ schemaVersion: 2, storage: 'plaintext', tokens: { 't-bad': `${'a'.repeat(32)}中` }, passwords: {} }))
    assert.notEqual(configureGatewaySecretStore(file4), null, 'non-visible-ASCII tokens are refused on load')

    const file5 = join(dir, 'gateway-secrets-5.json')
    writeFileSync(file5, JSON.stringify({ schemaVersion: 2, storage: 'plaintext', tokens: { 't-ok': 'a'.repeat(32) } }))
    assert.notEqual(configureGatewaySecretStore(file5), null, 'a v2 file missing the passwords table is corrupt')

    const file6 = join(dir, 'gateway-secrets-6.json')
    writeFileSync(file6, JSON.stringify({ schemaVersion: 2, storage: 'plaintext', tokens: {}, passwords: { 'local': 'a'.repeat(12) } }))
    assert.notEqual(configureGatewaySecretStore(file6), null, 'the reserved id "local" is refused in the passwords table too')

    const file7 = join(dir, 'gateway-secrets-7.json')
    writeFileSync(file7, JSON.stringify({ schemaVersion: 1, tokens: { 't-bad': 'short' } }))
    assert.notEqual(configureGatewaySecretStore(file7), null, 'an invalid v1 file at the configured path is corrupt too')
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gatewayTokenValidationError / gatewayPasswordValidationError mirror the main-process gates', () => {
  // Token gate (既有门): 32-4096 visible ASCII.
  assert.equal(gatewayTokenValidationError(null), null)
  assert.equal(gatewayTokenValidationError(''), null)
  assert.equal(gatewayTokenValidationError(TOKEN), null)
  assert.match(gatewayTokenValidationError('short') ?? '', /at least 32/)
  assert.match(gatewayTokenValidationError(`${TOKEN}中`) ?? '', /visible ASCII/)
  assert.match(gatewayTokenValidationError('a'.repeat(4097)) ?? '', /limited to 4096/)
  // Password gate mirrors the server: 12-1024 JS characters, Unicode valid.
  assert.equal(gatewayPasswordValidationError(null), null)
  assert.equal(gatewayPasswordValidationError(''), null)
  assert.equal(gatewayPasswordValidationError(PASSWORD), null)
  assert.match(gatewayPasswordValidationError('short') ?? '', /at least 12/)
  assert.equal(gatewayPasswordValidationError(`${PASSWORD}中文😀`), null)
  assert.match(gatewayPasswordValidationError('a'.repeat(1025)) ?? '', /limited to 1024/)
  assert.equal(gatewayPasswordValidationError('a'.repeat(1024)), null, '1024 chars is the upper bound')
  assert.equal(gatewayPasswordValidationError('a'.repeat(12)), null, '12 chars is the lower bound')
})

/** base64-prefix adapter: encrypt = 'enc:' + base64; decrypt THROWS on any
 * non-blob input — the documented trigger for the per-value plaintext
 * fallback (design 17 §12 明文回退). */
function prefixedBase64Crypto(): SecretCryptoAdapter {
  return {
    isAvailable: () => true,
    encrypt: plain => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: blob => {
      if (!blob.startsWith('enc:')) throw new Error('not an encrypted blob')
      return Buffer.from(blob.slice(4), 'base64').toString('utf8')
    },
  }
}

test('an available crypto adapter encrypts the mirror and decrypts both tables on reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-crypto-'))
  const file = join(dir, 'gateway-secrets.json')
  const crypto = prefixedBase64Crypto()
  try {
    assert.equal(configureGatewaySecretStore(file, crypto), null)
    setGatewayToken('c-token-1', TOKEN)
    setGatewayPassword('c-pw-1', UNICODE_PASSWORD)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion: number; storage: string; tokens: Record<string, string>; passwords: Record<string, string> }
    assert.equal(stored.schemaVersion, 3)
    assert.equal(stored.storage, 'safeStorage')
    assert.notEqual(stored.tokens['c-token-1'], TOKEN, 'the token is never persisted in plaintext')
    assert.ok(stored.tokens['c-token-1'].startsWith('enc:'), 'the persisted value is the encrypted blob')
    assert.ok(stored.passwords['c-pw-1'].startsWith('enc:'))
    assert.equal(crypto.decrypt(stored.tokens['c-token-1']), TOKEN, 'the blob round-trips through the adapter')
    assert.equal(crypto.decrypt(stored.passwords['c-pw-1']), UNICODE_PASSWORD)
    // Reload decrypts both tables back to the plaintext credentials.
    assert.equal(configureGatewaySecretStore(file, crypto), null)
    assert.equal(getGatewayToken('c-token-1'), TOKEN)
    assert.equal(getGatewayPassword('c-pw-1'), UNICODE_PASSWORD, 'safeStorage preserves Unicode exactly')
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a plaintext mirror written without crypto still loads when crypto becomes available (明文回退)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-fallback-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    // Written with the default plaintext adapter (no crypto configured).
    assert.equal(configureGatewaySecretStore(file), null)
    setGatewayToken('f-token', TOKEN)
    setGatewayPassword('f-pw', PASSWORD)
    const plaintext = JSON.parse(readFileSync(file, 'utf8')) as { storage: string; tokens: Record<string, string>; passwords: Record<string, string> }
    assert.equal(plaintext.storage, 'plaintext')
    assert.equal(plaintext.tokens['f-token'], TOKEN, 'no crypto → the mirror stays plaintext')
    assert.equal(plaintext.passwords['f-pw'], PASSWORD)
    // Reloaded with an AVAILABLE crypto: the explicit plaintext tag keeps the
    // credentials unambiguous and startup immediately upgrades the complete
    // mirror before projecting safeStorage.
    assert.equal(configureGatewaySecretStore(file, prefixedBase64Crypto()), null)
    assert.equal(getGatewayToken('f-token'), TOKEN)
    assert.equal(getGatewayPassword('f-pw'), PASSWORD)
    const upgraded = JSON.parse(readFileSync(file, 'utf8')) as { storage: string; tokens: Record<string, string>; passwords: Record<string, string> }
    assert.equal(upgraded.storage, 'safeStorage')
    assert.ok(upgraded.tokens['f-token'].startsWith('enc:'), 'the existing token is encrypted during startup convergence')
    assert.ok(upgraded.passwords['f-pw'].startsWith('enc:'), 'the existing password is encrypted during startup convergence')
    // A subsequent write-through keeps the whole payload consistently tagged.
    setGatewayPassword('f-pw2', PASSWORD)
    const mixed = JSON.parse(readFileSync(file, 'utf8')) as { storage: string; tokens: Record<string, string>; passwords: Record<string, string> }
    assert.equal(mixed.storage, 'safeStorage')
    assert.ok(mixed.passwords['f-pw2'].startsWith('enc:'), 'a new value is written encrypted when crypto is available')
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Raw-base64 crypto adapter — the SHAPE the real Electron safeStorage
 * adapter produces (`encryptString(...).toString('base64')`, no test prefix):
 * the S22-flip cases must exercise exactly what the shell writes. */
function rawBase64Crypto(): SecretCryptoAdapter {
  return {
    isAvailable: () => true,
    encrypt: plain => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: blob => Buffer.from(blob, 'base64').toString('utf8'),
  }
}

test('P1-1/S-29: an encrypted mirror loaded without crypto is loud + fail-closed, but is NOT corrupt-renamed (the Electron flavor must still be able to read it)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-flip-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    // Startup 1: crypto AVAILABLE → the mirror holds raw-base64 blobs (the
    // Electron safeStorage shape) — ciphertext that passes the
    // visible-ASCII/length gates exactly like a plaintext credential would.
    assert.equal(configureGatewaySecretStore(file, rawBase64Crypto()), null)
    setGatewayToken('flip-token', TOKEN)
    setGatewayPassword('flip-pw', 'gateway-login-password-1234567890-abcd')
    const storedText = readFileSync(file, 'utf8')
    const stored = JSON.parse(storedText) as { tokens: Record<string, string>; passwords: Record<string, string> }
    assert.notEqual(stored.tokens['flip-token'], TOKEN, 'with crypto available the mirror never holds plaintext')
    assert.match(stored.tokens['flip-token'] ?? '', /^[A-Za-z0-9+/=]+$/, 'the stored value is base64 ciphertext shape')
    assert.equal((stored as { storage?: unknown }).storage, 'safeStorage', 'the explicit discriminator, not blob punctuation, controls decoding')
    // Startup 2: crypto UNAVAILABLE (cross-flavor / safeStorage availability
    // flip) — the blobs must NOT silently load as the plaintext credentials
    // (their base64 passes the ASCII/length gates — the exact violation S22
    // fixes). S-29: this is NOT a corrupt file — it is exactly what the
    // Electron flavor writes; renaming it away would make those credentials
    // unreadable on the other side too.
    const notice = configureGatewaySecretStore(file)
    assert.notEqual(notice, null, 'a crypto-unavailable load of encrypted blobs is LOUD, never silently plaintext')
    assert.match(notice ?? '', /safeStorage-encrypted by the Electron flavor/, 'the notice is precise and actionable (S-29)')
    assert.doesNotMatch(notice ?? '', /\.corrupt/, 'never the generic corrupt-preserved wording')
    assert.equal(existsSync(`${file}.corrupt`), false, 'no corrupt rename — the file is preserved in place')
    assert.equal(existsSync(file), true, 'the encrypted mirror stays exactly where the Electron flavor reads it')
    assert.equal(readFileSync(file, 'utf8'), storedText, 'the on-disk bytes are untouched')
    assert.equal(getGatewayToken('flip-token'), null, 'the blob is NEVER adopted as the token')
    assert.equal(getGatewayPassword('flip-pw'), null, 'the blob is NEVER adopted as the password')
    assert.equal(gatewaySecretStorageMode(), 'plaintext', 'the projection reports the mode this process will actually write')
    assert.equal(gatewaySecretStorageCrossFlavorUnreadable(), true, 'the renderer projection exposes the cross-flavor unreadable fact')
    // The Electron flavor (crypto available again) still reads the preserved
    // file: the credentials were never destroyed by the sidecar start.
    const recovered = configureGatewaySecretStore(file, rawBase64Crypto())
    assert.equal(recovered, null, 'a crypto-capable (Electron) load succeeds on the preserved file')
    assert.equal(getGatewayToken('flip-token'), TOKEN)
    assert.equal(gatewaySecretStorageCrossFlavorUnreadable(), false)
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S22: a pure-alphanumeric safeStorage ciphertext is still never mistaken for plaintext', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-alpha-cipher-'))
  const file = join(dir, 'gateway-secrets.json')
  const alphaCipher = 'A'.repeat(64)
  const crypto: SecretCryptoAdapter = {
    isAvailable: () => true,
    encrypt: () => alphaCipher,
    decrypt: () => TOKEN,
  }
  try {
    assert.equal(configureGatewaySecretStore(file, crypto), null)
    setGatewayToken('alpha-cipher', TOKEN)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { storage: unknown; tokens: Record<string, string> }
    assert.equal(stored.storage, 'safeStorage')
    assert.equal(stored.tokens['alpha-cipher'], alphaCipher)
    assert.doesNotMatch(alphaCipher, /[+/=]/, 'regression fixture defeats the old punctuation heuristic')

    const notice = configureGatewaySecretStore(file)
    assert.notEqual(notice, null, 'crypto unavailable + safeStorage tag fails closed')
    // S-29: precise cross-flavor wording, file preserved in place (no .corrupt).
    assert.match(notice ?? '', /safeStorage-encrypted by the Electron flavor/)
    assert.equal(existsSync(`${file}.corrupt`), false)
    assert.equal(existsSync(file), true)
    assert.equal(gatewaySecretStorageCrossFlavorUnreadable(), true)
    assert.equal(getGatewayToken('alpha-cipher'), null, 'ciphertext never becomes a wire credential')
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S22: a non-empty historical v2 file without a storage discriminator fails closed as ambiguous', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-unlabeled-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, tokens: { ambiguous: TOKEN }, passwords: {} }))
    const notice = configureGatewaySecretStore(file)
    assert.notEqual(notice, null)
    assert.ok(existsSync(`${file}.corrupt`), 'ambiguous legacy bytes are preserved for recovery')
    assert.equal(getGatewayToken('ambiguous'), null)
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-1: a blob-shaped value that fails to decrypt is corrupt (解密尝试失败), never raw-fallbacked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-decryptfail-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    // Written as raw-base64 blobs; the reload uses a crypto that is AVAILABLE
    // but whose decrypt ALWAYS fails (key gone / blob corrupted). The raw blob
    // must never be adopted as the plaintext credential.
    assert.equal(configureGatewaySecretStore(file, rawBase64Crypto()), null)
    setGatewayToken('df-token', TOKEN)
    const failingCrypto: SecretCryptoAdapter = {
      isAvailable: () => true,
      encrypt: plain => Buffer.from(plain, 'utf8').toString('base64'),
      decrypt: () => { throw new Error('cannot decrypt (key unavailable / blob corrupted)') },
    }
    const notice = configureGatewaySecretStore(file, failingCrypto)
    assert.notEqual(notice, null, 'an undecryptable blob is a loud corrupt, never a silent raw fallback')
    assert.match(notice ?? '', /\.corrupt/)
    assert.ok(existsSync(`${file}.corrupt`), 'the unreadable blob file is preserved')
    assert.equal(getGatewayToken('df-token'), null, 'the undecryptable blob is never used as the token')
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gatewaySecretStorageMode projects the active adapter: safeStorage vs the documented plaintext fallback (design 17 §13.4.1 / S22)', () => {
  // Default (no store configured): the inert plaintext adapter.
  assert.equal(gatewaySecretStorageMode(), 'plaintext', 'default = plaintext (nothing configured yet)')
  try {
    // An AVAILABLE crypto adapter → 'safeStorage' (OS keychain semantics).
    configureGatewaySecretStore(null, prefixedBase64Crypto())
    assert.equal(gatewaySecretStorageMode(), 'safeStorage')
    // Reconfigure without crypto → the fallback is reported again — the
    // projection tracks the ACTIVE adapter, never a stale startup decision.
    configureGatewaySecretStore(null)
    assert.equal(gatewaySecretStorageMode(), 'plaintext', 'the plaintext fallback is honestly projected when the OS keychain is unavailable')
  } finally {
    configureGatewaySecretStore(null)
  }
})

test('gatewaySecretStorageMode reports the durable file honestly when a plaintext-to-safeStorage upgrade fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-mode-honesty-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    assert.equal(configureGatewaySecretStore(file), null)
    setGatewayToken('mode-honesty', TOKEN)
    const failingCrypto: SecretCryptoAdapter = {
      isAvailable: () => true,
      encrypt: () => { throw new Error('keychain write unavailable') },
      decrypt: () => { throw new Error('not ciphertext') },
    }
    const notice = configureGatewaySecretStore(file, failingCrypto)
    assert.match(notice ?? '', /safeStorage upgrade failed/)
    assert.equal(gatewaySecretStorageMode(), 'plaintext', 'the UI warning follows the on-disk fact, not adapter capability')
    assert.equal(getGatewayToken('mode-honesty'), TOKEN, 'validated plaintext remains usable after the loud upgrade failure')
    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { storage: unknown }).storage, 'plaintext')
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-empty legacy gateway-tokens.json is preserved and disabled until explicit credential re-entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-migrate-'))
  const dir2 = mkdtempSync(join(tmpdir(), 'dsh-gw-migrate-fail-'))
  const dir3 = mkdtempSync(join(tmpdir(), 'dsh-gw-migrate-invalid-'))
  const legacy = join(dir, 'gateway-tokens.json')
  const file = join(dir, 'gateway-secrets.json')
  const crypto = prefixedBase64Crypto()
  try {
    writeFileSync(legacy, JSON.stringify({ schemaVersion: 1, tokens: { 'm-token-1': TOKEN, 'm-token-2': `${TOKEN}2` } }))
    const unboundNotice = configureGatewaySecretStore(file, crypto)
    assert.match(unboundNotice ?? '', /no target bindings|re-enter/)
    assert.equal(existsSync(file), false, 'no bound credential file is guessed from legacy values')
    assert.equal(existsSync(legacy), true, 'legacy evidence is kept for explicit recovery')
    assert.equal(getGatewayToken('m-token-1'), null, 'unbound legacy values are never live')

    // Migration FAILURE: a corrupt legacy file is KEPT, reported loudly, and
    // never blocks startup (empty store, no current credential file manufactured from garbage).
    const legacy2 = join(dir2, 'gateway-tokens.json')
    const file2 = join(dir2, 'gateway-secrets.json')
    writeFileSync(legacy2, '{broken')
    const notice = configureGatewaySecretStore(file2, crypto)
    assert.notEqual(notice, null, 'a failed migration is loud')
    assert.match(notice ?? '', /legacy gateway token file/)
    assert.ok(existsSync(legacy2), 'the legacy file is kept for a later retry')
    assert.equal(existsSync(file2), false, 'no current credential file is manufactured from garbage')
    assert.equal(getGatewayToken('anything'), null, 'startup continues with an empty store')

    // Migration REFUSAL: a well-formed legacy file with an invalid token
    // entry is also kept (never migrated, never silently dropped).
    const legacy3 = join(dir3, 'gateway-tokens.json')
    writeFileSync(legacy3, JSON.stringify({ schemaVersion: 1, tokens: { 't-bad': 'short' } }))
    const file3 = join(dir3, 'gateway-secrets.json')
    assert.notEqual(configureGatewaySecretStore(file3, crypto), null)
    assert.ok(existsSync(legacy3), 'an invalid legacy file is kept, not renamed or deleted')
    assert.equal(existsSync(file3), false)
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
    rmSync(dir3, { recursive: true, force: true })
  }
})

test('a legacy gateway-tokens.json beside a valid bound v3 file stays preserved and inert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-migrate-retry-'))
  const dir2 = mkdtempSync(join(tmpdir(), 'dsh-gw-migrate-retry-corrupt-'))
  const legacy = join(dir, 'gateway-tokens.json')
  const file = join(dir, 'gateway-secrets.json')
  const crypto = prefixedBase64Crypto()
  try {
    // Simulate the residue of a migration whose current bound write succeeded
    // but whose legacy rmSync failed: BOTH files exist, the v3 file is authoritative.
    // (The store cannot manufacture this state itself — a migration only runs
    // on a MISSING current file, which is exactly the bug being fixed: the leftover
    // was never retried because later startups loaded the bound v3 file directly.)
    writeFileSync(legacy, JSON.stringify({ schemaVersion: 1, tokens: { 'r-token-1': TOKEN } }))
    writeFileSync(file, JSON.stringify(boundPlaintextFile({ 'r-token-2': `${TOKEN}2` }, {})))
    assert.equal(configureGatewaySecretStore(file, crypto), null, 'the bound v3 file remains authoritative')
    assert.equal(existsSync(legacy), true, 'unbound legacy evidence is never overwritten or silently deleted')
    assert.equal(getGatewayToken('r-token-2'), `${TOKEN}2`, 'the bound v3 file is authoritative')
    assert.equal(getGatewayToken('r-token-1'), null, 'legacy-only tokens are not reloaded — already migrated')
    // Idempotent: a second startup still ignores the legacy file.
    assert.equal(configureGatewaySecretStore(file, crypto), null)
    assert.equal(getGatewayToken('r-token-2'), `${TOKEN}2`)
    assert.equal(existsSync(legacy), true)

    // A CORRUPT current file does NOT trigger the legacy cleanup: the legacy tokens
    // are the only recoverable copy and must survive until a clean load.
    const legacy2 = join(dir2, 'gateway-tokens.json')
    const file2 = join(dir2, 'gateway-secrets.json')
    writeFileSync(legacy2, JSON.stringify({ schemaVersion: 1, tokens: { 'r-token-1': TOKEN } }))
    writeFileSync(file2, 'not json at all')
    const notice = configureGatewaySecretStore(file2, crypto)
    assert.notEqual(notice, null, 'the corrupt current file fails loudly')
    assert.ok(existsSync(`${file2}.corrupt`), 'the corrupt current file is preserved')
    assert.ok(existsSync(legacy2), 'a corrupt current file keeps the legacy file (the only recoverable copy)')
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
  }
})

test('configureGatewayTokenStore stays a working plaintext alias and refuses non-empty unbound v1 files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-alias-'))
  const file = join(dir, 'gateway-tokens.json')
  try {
    // Fresh bound v3 write through the backward-compatible plaintext alias.
    assert.equal(configureGatewayTokenStore(file), null)
    setGatewayToken('a-token', TOKEN)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 3, 'the alias persists bound schemaVersion 3')
    assert.equal(configureGatewayTokenStore(file), null)
    assert.equal(getGatewayToken('a-token'), TOKEN)
    // In-place v1 has no endpoint binding and cannot be adopted safely.
    const v1file = join(dir, 'v1-in-place.json')
    writeFileSync(v1file, JSON.stringify({ schemaVersion: 1, tokens: { 'a-legacy': TOKEN } }))
    const notice = configureGatewayTokenStore(v1file)
    assert.match(notice ?? '', /no target bindings|re-enter/)
    assert.equal(getGatewayToken('a-legacy'), null)
    assert.equal(existsSync(v1file), false, 'the unbound file is moved aside under a unique recovery name')
    assert.equal(readdirSync(dir).some(name => name.startsWith('v1-in-place.json.unbound-')), true)
  } finally {
    configureGatewayTokenStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gatewayHttpFailureIsTerminal classifies deterministic vs transient statuses', () => {
  // Deterministic client/protocol evidence: terminal.
  assert.equal(gatewayHttpFailureIsTerminal(401), true)
  assert.equal(gatewayHttpFailureIsTerminal(403), true)
  assert.equal(gatewayHttpFailureIsTerminal(404), true)
  assert.equal(gatewayHttpFailureIsTerminal(200), true, 'a non-probe 2xx is not the required dsh envelope')
  // Explicitly transient statuses.
  assert.equal(gatewayHttpFailureIsTerminal(408), false)
  assert.equal(gatewayHttpFailureIsTerminal(425), false)
  assert.equal(gatewayHttpFailureIsTerminal(429), false)
  assert.equal(gatewayHttpFailureIsTerminal(500), false)
  assert.equal(gatewayHttpFailureIsTerminal(502), false)
  assert.equal(gatewayHttpFailureIsTerminal(503), false)
  // Outside the HTTP status space: not a real answer.
  assert.equal(gatewayHttpFailureIsTerminal(0), false)
  assert.equal(gatewayHttpFailureIsTerminal(700), false)
})

test('GATEWAY_HOST_PATTERN rejects embedded ports and accepts bare/IPv6 hosts', () => {
  assert.equal(GATEWAY_HOST_PATTERN.test('gw.example.com'), true)
  assert.equal(GATEWAY_HOST_PATTERN.test('192.168.1.10'), true)
  assert.equal(GATEWAY_HOST_PATTERN.test('[2001:db8::1]'), true)
  // A colon inside the host would silently override the URL port — refused.
  assert.equal(GATEWAY_HOST_PATTERN.test('gw.example.com:8443'), false)
  assert.equal(GATEWAY_HOST_PATTERN.test(''), false)
  assert.equal(GATEWAY_HOST_PATTERN.test('https://gw.example.com'), false)
})

test('DEFAULT_GATEWAY_PORT is 443 and DEFAULT_GATEWAY_HTTP_PORT is 80', () => {
  assert.equal(DEFAULT_GATEWAY_PORT, 443)
  assert.equal(DEFAULT_GATEWAY_HTTP_PORT, 80)
})

test('gateway validateSpec normalizes http for shipped kinds and refuses future kinds without their own provider', () => {
  // kind 'gateway', transport omitted → inferred http (design 17 §2.2).
  const viaKind = gatewayProvider.validateSpec({ id: 'g1', label: 'g', kind: 'gateway', host: 'gw.example.com', remotePort: 443 })
  assert.ok(viaKind !== null)
  if (viaKind !== null) {
    assert.equal(viaKind.kind, 'gateway')
    assert.equal(viaKind.transport, 'http')
    assert.equal(viaKind.insecureHttp, false)
  }
  // kind 'dsh' over http is REFUSED — the dsh×http combination is disabled
  // (2026-09): direct-attaching a dsh web profile over http is hard-blocked
  // on the 0.1.2 line (browser-auth launch token unrecoverable remotely);
  // ssh is the only dsh transport.
  assert.equal(gatewayProvider.validateSpec({ id: 'g1d', label: 'g', kind: 'dsh', transport: 'http', host: 'dsh.example.com', remotePort: 3080 }), null, 'dsh×http refused')
  // insecureHttp normalized to a strict boolean.
  const insecure = gatewayProvider.validateSpec({ id: 'g2', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 8080, insecureHttp: true })
  assert.ok(insecure !== null)
  if (insecure !== null) assert.equal(insecure.insecureHttp, true)
  assert.equal(gatewayProvider.validateSpec({ id: 'g2b', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 8080, insecureHttp: 'yes' }), null, 'non-boolean insecureHttp is refused')
  // Transport must be http: an over-ssh spec is refused — the tunnel provider
  // is a separate provider split (design 17 §9.2), never mis-served as a
  // direct endpoint.
  assert.equal(gatewayProvider.validateSpec({ id: 'g3', label: 'g', kind: 'gateway', transport: 'ssh', host: 'gw.example.com', remotePort: 443 }), null)
  assert.equal(gatewayProvider.validateSpec({ id: 'g3b', label: 'g', kind: 'dsh', transport: 'ssh', host: 'gw.example.com', remotePort: 3080 }), null)
  // transport omitted + kind 'dsh' → inferred ssh → refused (this provider
  // serves http + gateway only); a missing kind defaults to {dsh, ssh} →
  // refused; an explicit dsh×http is refused by the 2026-09 disable.
  assert.equal(gatewayProvider.validateSpec({ id: 'g4', label: 'g', kind: 'dsh', host: 'dsh.example.com', remotePort: 3080 }), null)
  assert.equal(gatewayProvider.validateSpec({ id: 'g5', label: 'g', host: 'gw.example.com', remotePort: 443 }), null)
  // A future target needs its own provider: accepting it here would let the
  // transport reach ready before proxy registration rejects the unknown kind.
  const futureKind = gatewayProvider.validateSpec({ id: 'g6', label: 'g', kind: 'future-target', transport: 'http', host: 'gw.example.com', remotePort: 443 })
  assert.equal(futureKind, null)
  // endpointUrl honors the origin scheme: https default (443 elided), http
  // plaintext (80 elided), explicit non-default ports kept.
  assert.equal(gatewayProvider.endpointUrl!(viaKind!), 'https://gw.example.com')
  assert.equal(gatewayProvider.endpointUrl!(insecure!), 'http://gw.example.com:8080')
  const http80 = gatewayProvider.validateSpec({ id: 'g7', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 80, insecureHttp: true })
  assert.ok(http80 !== null)
  assert.equal(gatewayProvider.endpointUrl!(http80!), 'http://gw.example.com', 'the default http port 80 is elided')
  const https8443 = gatewayProvider.validateSpec({ id: 'g8', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 8443 })
  assert.ok(https8443 !== null)
  assert.equal(gatewayProvider.endpointUrl!(https8443!), 'https://gw.example.com:8443', 'a non-default https port is kept')
})

test('gateway verifyUp probes WITHOUT auth when no token is configured (design 17 §2.3/§7.3)', async () => {
  let sawAuthorization: string | undefined
  const server = createServer((req, res) => {
    sawAuthorization = req.headers.authorization
    res.writeHead(401)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    // insecureHttp: true → the probe speaks plain http (testable without TLS).
    const spec = gatewayProvider.validateSpec({ id: 'probe-1', label: 'g', kind: 'gateway', transport: 'http', host: '127.0.0.1', remotePort: port, insecureHttp: true })
    assert.ok(spec !== null)
    const noToken = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port })
    assert.equal(sawAuthorization, undefined, 'no credentials → the probe carries no Authorization header (never a pre-flight refusal)')
    assert.equal(noToken.ok, false)
    if (!noToken.ok) {
      assert.equal(noToken.terminal, true, 'a 401 answer is a deterministic three-state terminal failure — retrying cannot change it')
      assert.match(noToken.detail ?? '', /requires authentication/, 'the guidance says to configure the token, not that a token was rejected')
    }
    // With a token configured, the probe carries the Bearer header.
    setGatewayToken('probe-1', TOKEN)
    const withToken = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port })
    assert.equal(sawAuthorization, `Bearer ${TOKEN}`)
    assert.equal(withToken.ok, false)
    if (!withToken.ok) assert.match(withToken.detail ?? '', /rejected the token/, 'a wrong/rejected token keeps the split guidance')
  } finally {
    setGatewayToken('probe-1', null)
    server.close()
  }
})


function httpSpec(id: string, port: number, extra: Record<string, unknown> = {}): ReturnType<typeof gatewayProvider.validateSpec> {
  return gatewayProvider.validateSpec({ id, label: 'g', kind: 'gateway', transport: 'http', host: '127.0.0.1', remotePort: port, insecureHttp: true, ...extra })
}

test('verifyUp: the gateway-owned runtime identity answers ok even while managed dsh is stopped (design 17 §7 / design 18 §9.3)', async () => {
  let seenMethod: string | undefined
  let seenUrl: string | undefined
  const server = await startHttpProbeServer((req, res) => {
    seenMethod = req.method
    seenUrl = req.url
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  try {
    const spec = httpSpec('env-ok', server.port)
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(result.ok, true, 'the gateway boundary remains serviceable independently of managed dsh')
    assert.equal(seenMethod, 'GET')
    assert.equal(seenUrl, '/chamber/runtime/status')
    // P2-5: a direct-probe SUCCESS is the pure {ok:true} shape (the ssh
    // provider's contract) — never a stray statusCode:undefined key that
    // deep-compare callers would trip on.
    assert.deepEqual(result, { ok: true }, 'the success result is exactly {ok:true}')
  } finally {
    await server.close()
  }
})

test('verifyUp: a 200 response without the gateway runtime identity is terminal', async () => {
  const server = await startHttpProbeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hello, this is not dsh')
  })
  try {
    const spec = httpSpec('non-env', server.port)
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.terminal, true, 'a destination that ANSWERED is deterministic: retrying cannot change the answer')
      assert.match(result.detail ?? '', /does not appear to be a compatible dsh-chamber gateway/)
    }
  } finally {
    await server.close()
  }
})

test('verifyUp: 403/421 stay terminal and 5xx stays transient (design 17 §7.3 semantics preserved)', async () => {
  const statuses = [403, 421, 503]
  const server = await startHttpProbeServer((_req, res) => {
    const status = statuses.shift() ?? 503
    res.writeHead(status)
    res.end()
  })
  try {
    for (const [status, terminal, detailRe] of [
      [403, true, /origin\/Host policy \(403\)/],
      [421, true, /HTTP 421/],
      [503, false, /HTTP 503/],
    ] as const) {
      const spec = httpSpec(`status-${status}`, server.port)
      assert.ok(spec !== null)
      const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.terminal, terminal, `HTTP ${status} classified ${terminal ? 'terminal' : 'transient'}`)
        assert.match(result.detail ?? '', detailRe)
        // The direct-endpoint probe carries statusCode only on the raw 401
        // (the verifyUp re-login flow keys on it) — 403/421/5xx stay without
        // one. Pinned so the shared probe core cannot silently flip the shape.
        assert.equal('statusCode' in result, false, `direct probe has no statusCode on HTTP ${status}`)
      }
    }
  } finally {
    await server.close()
  }
})

test('verifyUp is unreachable for dsh-kind targets — validateSpec refuses the dsh×http combination (2026-09)', async () => {
  // The dsh×http combination is disabled at the registry mutation point
  // (direct dsh attach is hard-blocked on the 0.1.2 line: browser-auth
  // launch token unrecoverable remotely), so no dsh-kind spec can exist for
  // this provider — the old probe path (session/list handshake with its 401
  // browser-auth classification) was removed with the combination.
  assert.equal(gatewayProvider.validateSpec({ id: 'dsh-refused', label: 'g', kind: 'dsh', transport: 'http', host: 'dsh.example.com', remotePort: 3080 }), null)
  // The gateway probe itself is unaffected: no auth header is sent without a
  // configured credential, and the gateway's own 401 is the answer.
  let sawAuthorization: string | undefined
  const server = await startHttpProbeServer((req, res) => {
    sawAuthorization = req.headers.authorization
    res.writeHead(401)
    res.end()
  })
  try {
    const spec = gatewayProvider.validateSpec({ id: 'gw-auth-probe', label: 'g', kind: 'gateway', transport: 'http', host: '127.0.0.1', remotePort: server.port, insecureHttp: true })
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(sawAuthorization, undefined, 'no credential configured → the probe carries no Authorization header')
    assert.equal(result.ok, false, 'an auth-requiring gateway answers 401')
    assert.equal(result.terminal, true)
    assert.match(result.detail ?? '', /401/)
  } finally {
    await server.close()
  }
})

test('the secrets store dir has no stray files after a full lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-clean-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    configureGatewaySecretStore(file)
    setGatewayToken('t-clean-1', TOKEN)
    setGatewayPassword('t-clean-1', PASSWORD)
    setInstanceSecrets('t-clean-1', null, null)
    assert.deepEqual(readdirSync(dir), ['gateway-secrets.json'], 'no .tmp residue after write-through clears')
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
