/**
 * gateway-provider unit tests (design 17 §2/§7/§12): the write-only
 * credential store (bound schemaVersion 3 `gateway-secrets.json`, 0600 atomic
 * mirror, safeStorage-adapter encrypt/decrypt + plaintext fallback, legacy
 * non-empty fail-closed preservation,
 * migration, corrupt-preserve fail-loud, never readable by the renderer),
 * token/password validation, host pattern, the HTTP failure classification
 * that drives terminal-vs-transient connect verdicts, the v2 spec
 * normalization (http transport for ANY target kind), and — over a real
 * node:http server with `insecureHttp` — the live identity probe (envelope →
 * ok, 401 → terminal three-state, non-envelope → terminal). The password-
 * session flow (design 17 §7.3/§9.3) is exercised through the injected
 * session hooks: login → probe WITH the Cookie, the cached-session fast path
 * (no re-login on reconnect), probe-401 → invalidate + ONE automatic re-login
 * (§9.3) with terminal password-refused only after the fresh session is
 * refused too, independent Bearer+Cookie coexistence/fallback, and the
 * inert default (no hooks → no credential header).
 *
 * AGENTS.md listed gateway-provider as covered by test:desktop for a long
 * time with no test file — this closes that gap. S23 adds real-TLS probe
 * coverage: embedded self-signed certificate fixtures served by a node:https
 * server exercise the SPKI pin gate (pin match → ok, pin mismatch → terminal
 * 「证书固定不匹配」, no pin → the legacy unpinned behavior). P1-1 adds the
 * S22 availability-flip coverage: an encrypted mirror written while crypto
 * was available is CORRUPT (preserved + loud) when a later startup loads it
 * without working crypto — the blob is never adopted as a plaintext
 * credential. P1-2 adds the pinned-LOGIN coverage: the real session manager
 * over the same fixtures proves a pinned https login succeeds on match and
 * is terminal on mismatch (never the forever-transient 'network').
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, X509Certificate } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureGatewaySecretStore as configureGatewaySecretStoreRaw,
  configureGatewaySessionProvider,
  configureGatewayTokenStore as configureGatewayTokenStoreRaw,
  DEFAULT_GATEWAY_HTTP_PORT,
  DEFAULT_GATEWAY_PORT,
  GATEWAY_RUNTIME_IDENTITY,
  GATEWAY_HOST_PATTERN,
  gatewayHttpFailureIsTerminal,
  gatewayPasswordValidationError,
  gatewayProvider,
  gatewaySecretStorageMode,
  gatewayTokenValidationError,
  getGatewayPassword,
  getGatewaySessionHooks,
  getGatewayToken,
  setGatewayPassword,
  setGatewayToken,
  setInstanceSecrets,
  syncGatewayChamberPlugins,
} from './gateway-provider.ts'
import type { LocalChamberHostPackage } from './gateway-provider.ts'
import type { SecretCryptoAdapter, GatewaySessionProviderHooks } from './gateway-provider.ts'
import type { GatewaySessionOrigin, GatewaySessionResult } from './gateway-session.ts'
import { createGatewaySessionManager } from './gateway-session.ts'
import { gatewayCredentialBinding } from './credential-binding.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

const TOKEN = '0123456789abcdef0123456789abcdef'
const PASSWORD = 'gateway-login-password-123'
const UNICODE_PASSWORD = '正确的网关密码-安全🔐-2026'
const GATEWAY_RUNTIME_STATUS = { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'stopped' }

function completeTestSessionHooks(partial: GatewaySessionProviderHooks): GatewaySessionProviderHooks {
  if (partial.ensureSession === undefined) throw new TypeError('test session hooks require ensureSession')
  let generation = 0
  let proof: import('./gateway-session.ts').GatewayRegistrationAuthProof | null = null
  let cached: string | null = null
  return {
    ensureSession: async (origin, password) => {
      const result = await partial.ensureSession!(origin, password)
      if (result.ok) cached = result.cookie
      return result
    },
    generation: partial.generation ?? (() => generation),
    registrationAuthProof: partial.registrationAuthProof ?? (() => proof),
    setRegistrationAuthProof: partial.setRegistrationAuthProof ?? ((_origin, next) => { proof = next }),
    cachedCookie: origin => partial.cachedCookie?.(origin) ?? cached,
    invalidate: origin => {
      generation += 1
      proof = null
      cached = null
      partial.invalidate?.(origin)
    },
  }
}

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

test('P1-1: an encrypted mirror written while crypto was available is CORRUPT on a later crypto-unavailable load — the blob is never used as a plaintext credential (S22 availability flip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-secret-flip-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    // Startup 1: crypto AVAILABLE → the mirror holds raw-base64 blobs (the
    // Electron safeStorage shape) — ciphertext that passes the
    // visible-ASCII/length gates exactly like a plaintext credential would.
    assert.equal(configureGatewaySecretStore(file, rawBase64Crypto()), null)
    setGatewayToken('flip-token', TOKEN)
    setGatewayPassword('flip-pw', 'gateway-login-password-1234567890-abcd')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { tokens: Record<string, string>; passwords: Record<string, string> }
    assert.notEqual(stored.tokens['flip-token'], TOKEN, 'with crypto available the mirror never holds plaintext')
    assert.match(stored.tokens['flip-token'] ?? '', /^[A-Za-z0-9+/=]+$/, 'the stored value is base64 ciphertext shape')
    assert.equal((stored as { storage?: unknown }).storage, 'safeStorage', 'the explicit discriminator, not blob punctuation, controls decoding')
    // Startup 2: crypto UNAVAILABLE (the safeStorage availability flip) — the
    // blobs must NOT silently load as the plaintext credentials (their base64
    // passes the ASCII/length gates — the exact violation this fixes).
    const notice = configureGatewaySecretStore(file)
    assert.notEqual(notice, null, 'a crypto-unavailable load of encrypted blobs is LOUD, never silently plaintext')
    assert.match(notice ?? '', /\.corrupt/, 'the notice names the preserved corrupt file')
    assert.ok(existsSync(`${file}.corrupt`), 'the encrypted mirror is PRESERVED as .corrupt (现场保留)')
    assert.equal(existsSync(file), false, 'the original is renamed away')
    assert.equal(getGatewayToken('flip-token'), null, 'the blob is NEVER adopted as the token')
    assert.equal(getGatewayPassword('flip-pw'), null, 'the blob is NEVER adopted as the password')
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
    assert.ok(existsSync(`${file}.corrupt`))
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
  // kind 'dsh' over http is equally this provider's spec (one provider per
  // transport, serving both target kinds); kind is returned as-is.
  const dshKind = gatewayProvider.validateSpec({ id: 'g1d', label: 'g', kind: 'dsh', transport: 'http', host: 'dsh.example.com', remotePort: 3080 })
  assert.ok(dshKind !== null)
  if (dshKind !== null) {
    assert.equal(dshKind.kind, 'dsh')
    assert.equal(dshKind.transport, 'http')
  }
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
  // serves http only); a missing kind defaults to {dsh, ssh} → refused.
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

/** Start a node:http server on an ephemeral loopback port; returns the port
 * and a close handle. `insecureHttp: true` makes the probe speak plain http,
 * so the real verifyGatewayEndpoint path is exercised without TLS. */
async function startHttpProbeServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

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
      }
    }
  } finally {
    await server.close()
  }
})

test('verifyUp: a dsh-kind target never carries auth, even with a stored token (design 17 §2.1/§9.3)', async () => {
  let sawAuthorization: string | undefined
  const server = await startHttpProbeServer((req, res) => {
    sawAuthorization = req.headers.authorization
    res.writeHead(401)
    res.end()
  })
  try {
    setGatewayToken('dsh-auth-probe', TOKEN)
    const spec = gatewayProvider.validateSpec({ id: 'dsh-auth-probe', label: 'g', kind: 'dsh', transport: 'http', host: '127.0.0.1', remotePort: server.port, insecureHttp: true })
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(sawAuthorization, undefined, 'a dsh target never injects the Authorization header')
    assert.equal(result.ok, false, 'the 0.1.2 browser-auth 401 gate must reject the probe')
    assert.equal(result.terminal, true)
    // The 401 answer is the 0.1.2 browser-auth gate — the hedged message
    // names it (round5: the signature probe is gated too).
    assert.match(result.detail ?? '', /401/)
  } finally {
    setGatewayToken('dsh-auth-probe', null)
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

// ---------------------------------------------------------------------------
// Password-session flow (design 17 §7.3/§9.3): verifyUp consults the
// injected session hooks (configureGatewaySessionProvider) for a password-
// configured gateway target with no token — login → probe WITH the Cookie,
// cached-session fast path, probe-401 → invalidate + terminal, independent
// Bearer+Cookie coexistence/fallback, inert default.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'dsh_gateway_session=fake-jwt'

/** A real gateway stub answering the gateway runtime identity endpoint,
 * recording the probe's cookie/authorization headers. */
function envelopeHandler(seen: { cookie?: string; authorization?: string }) {
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    seen.cookie = req.headers.cookie
    seen.authorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  }
}

test('verifyUp: a password-configured gateway with session hooks logs in once and probes WITH the Cookie (design 17 §7/§9.3)', async () => {
  const seen: { cookie?: string; authorization?: string } = {}
  const server = await startHttpProbeServer(envelopeHandler(seen))
  const exchanged: Array<{ origin: GatewaySessionOrigin; password: string }> = []
  let cached: string | null = null
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: (origin, password) => { exchanged.push({ origin, password }); return Promise.resolve({ ok: true, cookie: SESSION_COOKIE }) },
    cachedCookie: () => cached,
    invalidate: () => {},
  }
  configureGatewaySessionProvider(completeTestSessionHooks(hooks))
  try {
    setGatewayPassword('pw-probe-1', PASSWORD)
    const spec = httpSpec('pw-probe-1', server.port)
    assert.ok(spec !== null)
    // First verifyUp: no cached session → the stored password is exchanged,
    // the probe rides the session Cookie (never a credential header value).
    const first = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(first.ok, true)
    assert.equal(seen.cookie, SESSION_COOKIE, 'the probe carries the session Cookie')
    assert.equal(seen.authorization, undefined, 'no Authorization when the session authenticates')
    assert.equal(exchanged.length, 1)
    assert.equal(exchanged[0].password, PASSWORD, 'the STORED password is what the login exchanges — never the cookie')
    assert.equal(exchanged[0].origin.baseUrl, `http://127.0.0.1:${server.port}`, 'the session is keyed to the target origin')
    // Second verifyUp with a live cached session: NO re-login — the cookie is
    // reused (bounded reconnect cycles must never hammer the login endpoint,
    // 429 backoff discipline, design 17 §9.3).
    cached = SESSION_COOKIE
    const second = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(second.ok, true)
    assert.equal(seen.cookie, SESSION_COOKIE)
    assert.equal(exchanged.length, 1, 'a live cached session is never re-exchanged')
  } finally {
    setGatewayPassword('pw-probe-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: a probe 401 with the session cookie invalidates, re-logs in ONCE, and reports the terminal password-refused state only after the fresh session is refused too (design 17 §7.3/§9.3)', async () => {
  const invalidated: GatewaySessionOrigin[] = []
  let logins = 0
  const server = await startHttpProbeServer((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: () => { logins += 1; return Promise.resolve({ ok: true, cookie: SESSION_COOKIE }) },
    cachedCookie: () => null,
    invalidate: origin => { invalidated.push(origin) },
  }
  configureGatewaySessionProvider(completeTestSessionHooks(hooks))
  try {
    setGatewayPassword('pw-401-1', PASSWORD)
    const spec = httpSpec('pw-401-1', server.port)
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.terminal, true, 'a session rejected even after the one re-login is deterministic — retrying cannot change the answer')
      assert.match(result.detail ?? '', /rejected the password authentication \(401\) — re-enter the password/)
    }
    assert.equal(logins, 2, 'the 401 triggered exactly ONE automatic re-login (bounded, §9.3 重登一次)')
    assert.equal(invalidated.length, 2, 'both the stale and the freshly minted session are invalidated (the fresh one was refused too)')
    assert.equal(invalidated[0].baseUrl, `http://127.0.0.1:${server.port}`, 'the invalidation targets the probe origin')
  } finally {
    setGatewayPassword('pw-401-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: a probe 401 self-heals through the one automatic re-login — the fresh session probes ok (design 17 §9.3)', async () => {
  // The gateway answers the FIRST probe with 401 (stale/revoked session) and
  // the re-probe with the 200 envelope — the stored password is still valid,
  // so the single re-login recovers without any terminal state.
  let probes = 0
  const server = await startHttpProbeServer((_req, res) => {
    probes += 1
    if (probes === 1) {
      res.writeHead(401)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  const invalidated: GatewaySessionOrigin[] = []
  let logins = 0
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: () => { logins += 1; return Promise.resolve({ ok: true, cookie: SESSION_COOKIE }) },
    cachedCookie: () => null,
    invalidate: origin => { invalidated.push(origin) },
  }
  configureGatewaySessionProvider(completeTestSessionHooks(hooks))
  try {
    setGatewayPassword('pw-relogin-1', PASSWORD)
    const spec = httpSpec('pw-relogin-1', server.port)
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(result.ok, true, 'the fresh session after the one automatic re-login is accepted')
    assert.equal(probes, 2, 'exactly two probes: the stale-cookie probe and the fresh-session re-probe')
    assert.equal(logins, 2, 'the initial login plus exactly ONE automatic re-login')
    assert.equal(invalidated.length, 1, 'only the stale session was invalidated — the fresh one is kept')
  } finally {
    setGatewayPassword('pw-relogin-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: token and password are independent — with both configured the probe carries Bearer AND Cookie (design 17 §2.3)', async () => {
  const seen: { cookie?: string; authorization?: string } = {}
  const server = await startHttpProbeServer((req, res) => {
    seen.cookie = req.headers.cookie
    seen.authorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  let sessionConsulted = 0
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: () => { sessionConsulted += 1; return Promise.resolve({ ok: true, cookie: SESSION_COOKIE }) },
    cachedCookie: () => null,
    invalidate: () => { sessionConsulted += 1 },
  }
  configureGatewaySessionProvider(completeTestSessionHooks(hooks))
  try {
    setGatewayToken('pw-both-1', TOKEN)
    setGatewayPassword('pw-both-1', PASSWORD)
    const spec = httpSpec('pw-both-1', server.port)
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(result.ok, true)
    assert.equal(seen.authorization, `Bearer ${TOKEN}`, 'the Bearer token rides the probe')
    assert.equal(seen.cookie, SESSION_COOKIE, 'the independently configured password session also rides the probe')
    assert.equal(sessionConsulted, 1, 'the password/session flow is not shadowed by the token')
  } finally {
    setGatewayToken('pw-both-1', null)
    setGatewayPassword('pw-both-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: a refused password login still falls back to a valid configured Bearer', async () => {
  let probes = 0
  let sawAuthorization: string | undefined
  let sawCookie: string | undefined
  const server = await startHttpProbeServer((req, res) => {
    probes += 1
    sawAuthorization = req.headers.authorization
    sawCookie = req.headers.cookie
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  configureGatewaySessionProvider(completeTestSessionHooks({
    ensureSession: async () => ({ ok: false, code: 'invalid_credentials', error: 'password rejected' }),
    cachedCookie: () => null,
  }))
  try {
    setGatewayToken('pw-bearer-fallback', TOKEN)
    setGatewayPassword('pw-bearer-fallback', PASSWORD)
    const spec = httpSpec('pw-bearer-fallback', server.port)
    assert.ok(spec !== null)
    assert.deepEqual(await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port }), { ok: true })
    assert.equal(sawAuthorization, `Bearer ${TOKEN}`, 'the bearer fallback probe carries the token')
    assert.equal(sawCookie, undefined, 'no cookie leaks into the bearer fallback probe')
    assert.equal(probes, 1, 'one bearer-only fallback probe is sufficient')
  } finally {
    setGatewayToken('pw-bearer-fallback', null)
    setGatewayPassword('pw-bearer-fallback', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: a refused login is terminal, rate_limited stays transient (design 17 §7.3 three-state)', async () => {
  const failures: Extract<GatewaySessionResult, { ok: false }>[] = [
    { ok: false, code: 'invalid_credentials', error: 'the gateway rejected the password login (HTTP 401) — re-enter the password' },
    { ok: false, code: 'rate_limited', error: 'the gateway is rate-limiting login attempts (429) — back off before retrying' },
  ]
  const server = await startHttpProbeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: () => Promise.resolve(failures.shift() ?? { ok: false, code: 'network', error: 'the gateway did not answer the login request' }),
    cachedCookie: () => null,
  }
  configureGatewaySessionProvider(completeTestSessionHooks(hooks))
  try {
    const spec = httpSpec('pw-fail-1', server.port)
    assert.ok(spec !== null)
    setGatewayPassword('pw-fail-1', PASSWORD)
    // Refused password → terminal (the stored password cannot authenticate;
    // the user must re-enter it — no retry can change the answer).
    const refused = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.equal(refused.terminal, true, 'a refused password is deterministic')
      assert.match(refused.detail ?? '', /rejected the password login \(HTTP 401\)/)
    }
    // Rate-limited login → transient (the bounded reconnect/backoff path
    // applies — retrying after backoff can recover).
    const limited = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(limited.ok, false)
    if (!limited.ok) {
      assert.notEqual(limited.terminal, true, 'a rate-limited login is transient (absent/false = transient)')
      assert.match(limited.detail ?? '', /rate-limiting/)
    }
  } finally {
    setGatewayPassword('pw-fail-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: without session hooks a password-configured target probes WITHOUT auth (inert default, design 17 §2.3)', async () => {
  const seen: { cookie?: string; authorization?: string } = {}
  const server = await startHttpProbeServer((req, res) => {
    seen.cookie = req.headers.cookie
    seen.authorization = req.headers.authorization
    res.writeHead(401)
    res.end()
  })
  configureGatewaySessionProvider({})
  try {
    setGatewayPassword('pw-inert-1', PASSWORD)
    const spec = httpSpec('pw-inert-1', server.port)
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(seen.cookie, undefined, 'no hooks → the probe carries no Cookie')
    assert.equal(seen.authorization, undefined, 'no hooks → the probe carries no Authorization')
    assert.equal(result.ok, false, 'the password-gated endpoint must reject the probe')
    assert.match(result.detail ?? '', /requires authentication/)
  } finally {
    setGatewayPassword('pw-inert-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('configureGatewaySessionProvider accepts only disabled or complete security hooks', async () => {
  const complete = completeTestSessionHooks({
    ensureSession: async () => ({ ok: true, cookie: SESSION_COOKIE }),
  })
  configureGatewaySessionProvider(complete)
  assert.throws(
    () => configureGatewaySessionProvider({ ensureSession: async () => ({ ok: false, code: 'network', error: 'unused' }) }),
    /all-or-none/,
    'a partial hook update cannot silently remove generation/proof fences',
  )
  assert.equal(getGatewaySessionHooks(), complete, 'a rejected partial update leaves the previous complete hooks installed')
  assert.equal(await getGatewaySessionHooks().ensureSession!({ baseUrl: 'http://gw.example.com:3080', insecureHttp: true, scope: 'test:complete-hooks' }, PASSWORD).then(result => result.ok), true,
    'the previously installed complete hooks remain usable after a rejected partial update')
  configureGatewaySessionProvider({})
  assert.deepEqual(getGatewaySessionHooks(), {}, 'an empty hook object explicitly disables integration')
})

// ---------------------------------------------------------------------------
// SPKI certificate pinning (design 17 §13.4.2 / S23): self-signed fixture
// certificates EMBEDDED as test constants (no openssl dependency at test
// time), served by a real node:https server. The pin IS the trust anchor: a
// pinned probe succeeds against the matching certificate without any CA
// trust, fails TERMINAL on mismatch (「证书固定不匹配（SPKI）——gateway 证书已更换
// 或 pin 错误」), and an unpinned probe keeps the legacy behavior — against a
// self-signed chain that is a transient connection failure, proving the pin
// machinery is inert without a configured pin.
// ---------------------------------------------------------------------------

const CERT_A = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJAMuxiI8oRgl7MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCTEyNy4wLjAuMTAeFw0yNjA4MjgwNDM4MDRaFw0zNjA4MjUwNDM4MDRaMBQx
EjAQBgNVBAMMCTEyNy4wLjAuMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBALYDiUAFkzdtkyjr/VrNpyfe3p5c0lLWSy+OtqeRK4db2toYN8aWr+vxFMYT
4HqF/VW0ByfOAl0Mfi3kCZPbAFShUY11oYtoHCIGNyQIP6sf+Uc8a2zjodcm67yG
uS980hNK7e1v19B1L/kIZXncrkS7acXbC905GOihh6U3ZQyAGNva/CRlV4fdn2N2
Ti27Hy2xek9S8guA5/Ck+IEAq1iR0KwVNYcYd1yNBYwOGHCbNoSv+bOS2dKNurB0
SgolQYO7FFHWFCDO1dtPbwZfe8B1ucGCQSrgvSEELMjucaZxKMlRh4odH35Asxo8
ldUIdAwEqMK0rDdVmlDWWcEpQGECAwEAAaMeMBwwGgYDVR0RBBMwEYcEfwAAAYIJ
bG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBAQB1f5w9ld+gR42JDBgqy/UM8eI4
StDLYWNcOrImEV+OiCwhYDs/zXLk4CH9/MGTK3dypCY8nrfRiQ+JRfZf05sWeTyx
vFUu+tfaAKRiNQ39t+//josjJ2CuZeMctPap+F+YwxpxsDdQIEuAELgdWYAVvog4
nYQ7wAd7xngG/RoHv8hoXN7r+ZBk8+hU53YQ4o8xg5gTw6PFG7fVJ4YUxZC8uK72
yld1ntC7f8QDh0iHd9OEz3a+gs1ygsElBO49Rj58JgZLMBsOOOroowhnIsbVR/hN
E0KrcDN2oPfeHsQOarolqSXpNbJJF+Ue+Xlf9RfZNYLc6z2ntclmBAOHr14l
-----END CERTIFICATE-----
`
const KEY_A = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC2A4lABZM3bZMo
6/1azacn3t6eXNJS1ksvjrankSuHW9raGDfGlq/r8RTGE+B6hf1VtAcnzgJdDH4t
5AmT2wBUoVGNdaGLaBwiBjckCD+rH/lHPGts46HXJuu8hrkvfNITSu3tb9fQdS/5
CGV53K5Eu2nF2wvdORjooYelN2UMgBjb2vwkZVeH3Z9jdk4tux8tsXpPUvILgOfw
pPiBAKtYkdCsFTWHGHdcjQWMDhhwmzaEr/mzktnSjbqwdEoKJUGDuxRR1hQgztXb
T28GX3vAdbnBgkEq4L0hBCzI7nGmcSjJUYeKHR9+QLMaPJXVCHQMBKjCtKw3VZpQ
1lnBKUBhAgMBAAECggEAQVaHoInfzRfyqc/9ROlqRe/FbofXoJD4sHvEqeZ8/7xD
leL3srxJLqN+V5SvEoyi4m8b2ngjdQ+VBBhGL+N//OFkCync8dRPtQ8SIEctw9pY
e+/+iDo20KtSGH0sYRWnu/E78+4gRN6sd/NBqjtD+7xjPfliCuoCPRAvR2nZRmDh
/dyg73uq7CFmZb0Xj5E8+sDLsvgEiJ0ZTsxrR197ga72vSVa703iCdXDK1J03ZMd
3TOJAvbOuyn86KADoXkfss6ZL2422/TZ1F8X/gfs4fZs5aRzFoC+cjpzkkptPJxZ
UcDDa9CyxeFotm3E++HRl2xaqwFjpIS6vYr6O2PT+QKBgQDrSG6jh9pStgA9dCXw
3Y0VJyQRbhjEz13rgD7qCvCHRPoM1MYFg2fQ7sFWEq1sByDV0d8qQIKJ/evohlAe
tgw/5fxpW1/9h8LELmTNqP7eqIyVdPikugOmuo7NgdfhfZIr7O9gIOKlntAiKPgG
silO0WEK6WTUUmwcT85gbHo28wKBgQDGClokuhdBla+nBTwndsdrgLux62TLW+/H
OrCud1a7JMfV0PQWCzYQvraWBW132omu7v9Q3pjxuh3kVIafe+qB6SahaIzfA0xL
YMdp4NPnp7qrCK/oA5IliWwPSj5qpoOmBleFUBGkWSMl703LCD8gbXp7tZ6kAwc6
jpqB+kdoWwKBgGRSNhq0SnsJ74BEjgjt7sIeNlrYPudsI/fObwUMNRL4bkYaU3T2
WsXTh8xTmm59e5qwKh+x8fc0teonmvH9XavBPKcPtxY7VOihf4nRjRsTcx4nCf3y
8quc0FcADjSvfiwMkuTCIOHNnaFzJo50WPiqfl5QthVyL3bC8JRcrJ/RAoGBALBs
Infba8JaZdullzwU3XyQdyT97ZIYOdhDGYii+ZnIH1oERp2oqSZrr16gQS/neIZl
lP9m/dtCEUUKY8+J5ZSLroVWDUDSwFHaSmuxBTW2v12EZKiNHdHgxWotmsMJyffK
aIdzl/PQELbHo4a+tvXdcaLpXgUASZ1J0qz92EVHAoGBANabVLiKqQwy4sN4iwT0
5hmnDnsJgOPgydCv8BOXRl7kFu/qVJuv5t+ENERiOrkFbsGGu3ws1HAXPhZckidF
fQQAwvxZjbNVVo4umyxyqUmZyIgLWVxfWABr30wb35RVK+BdAzk1TANpvPTsAt0I
SGO6VATS9KOAchJ/HFfHpRWb
-----END PRIVATE KEY-----
`
/** The hex sha256 of CERT_A's SPKI DER (openssl-generated fixture). */
const PIN_A = '74f9461a9ae839c59a07e0d7639bc2c6daa4e97d104b1c3a3076a0f2fcb30d33'

const CERT_B = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJALk7aVPu4lYVMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCTEyNy4wLjAuMTAeFw0yNjA4MjgwNDQ0MjVaFw0zNjA4MjUwNDQ0MjVaMBQx
EjAQBgNVBAMMCTEyNy4wLjAuMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAL7IlWIk7pbIcXeTVCa3phs9N1BZQMquAgsgfg8yXwqyIioSPvF2K+6PiwxP
7gqbir+vVLDwBcvlShXOmShxz6P714AbmsheBAwyX/Gz7uyOoeRo2v0Z42HFe3I2
qWLtHwwGR2UFgEHpHoUKPhft6pW6d5G82YJxOfE0UtgSYDjUFFwiHdzBLepeo6F7
KN7+qXUEZbOe0m7vsWB0+LoU33kQayLTu/pQUMd0Sg+jdNXAczr2MKhvRpESt6l0
ryvezeNqu2cwCmzkuD6mdMHS8O8WDJoaPcxYOgFlAJasiWnRcw0yQZt9nfNsirSt
KqgHTdO5iZdxY80Xn0FpWF4jZusCAwEAAaMeMBwwGgYDVR0RBBMwEYcEfwAAAYIJ
bG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBAQCJAFkG3Nkf9qdcakZR9q3MLtPI
dElNqw2toAKkgslNEDi68NhI4oHdy/VWUvjv+Io77UR625zXgee4Off+A0Q4+rKC
MSnV+L3vKzVXmQiJe1keSRsJRhHJ5lyCWLQC0cXA8hi2VlhsH3zjsxdss+OkbpVA
cRF/0Zrf8vWmuLvIEHUECDS9FhhK06Ck53MtH4ylUHk1/GYWgxx4fJO5rn5ICGld
GEh/5hgbSIerocTVqopN2wRAwKk6sDi8Mj357LsqBXjOxiG9wM7/970q7HG2wPMD
It601afsP0WIHRkByyugcKQsBIIEPg9XdCP54SymB1Kxa8g9OWzJWNPyCdlg
-----END CERTIFICATE-----
`
/** The hex sha256 of CERT_B's SPKI DER — a real other-key pin for mismatches. */
const PIN_B = '087ee792a02c84ba6e994244a28449d7ece7ab6cd86b8d4c0c50dafa887d3478'

test('the embedded SPKI pin fixtures are self-consistent (cert A/B → pins A/B)', () => {
  const pinOf = (pem: string) =>
    createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  assert.equal(pinOf(CERT_A), PIN_A, 'cert A computes to its pinned digest')
  assert.equal(pinOf(CERT_B), PIN_B, 'cert B computes to its pinned digest')
  assert.notEqual(PIN_A, PIN_B, 'two distinct keys — the mismatch case is a real other-key pin')
})

test('validateSpec: an SPKI pin must be a 64-hex sha256, https-only AND gateway-kind-only (S23/P2-2)', () => {
  // A valid pin is normalized into the spec.
  const valid = gatewayProvider.validateSpec({ id: 'pin-ok', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: PIN_A })
  assert.ok(valid !== null)
  if (valid !== null) assert.equal(valid.spkiPin, PIN_A, 'a valid pin is carried into the normalized spec')
  // Uppercase hex is a valid pin (the verify-time compare is case-insensitive).
  const upper = gatewayProvider.validateSpec({ id: 'pin-upper', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: PIN_A.toUpperCase() })
  assert.ok(upper !== null, 'uppercase hex is accepted')
  if (upper !== null) assert.equal(upper.spkiPin, PIN_A.toUpperCase(), 'the pin is preserved verbatim')
  // Format gate: anything other than ^[0-9a-fA-F]{64}$ is refused.
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-short', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: 'abc' }), null)
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-63', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: 'a'.repeat(63) }), null)
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-65', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: 'a'.repeat(65) }), null)
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-nonhex', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: 'g'.repeat(64) }), null, 'non-hex characters are refused')
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-num', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: 123456 }), null, 'a non-string pin is refused')
  // http mode + pin → refused: TLS 保护不存在时 pin 无意义，不得声称任何 TLS
  // 保护（design 17 §13.4.2 / S23）.
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-http', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 8080, insecureHttp: true, spkiPin: PIN_A }), null)
  // P2-2: the pin is a GATEWAY-kind-only gate — a non-gateway kind over https
  // carrying a pin would HALF-execute (the identity probe pins, the reverse
  // proxy refuses pins for non-gateway transports), so the spec is refused
  // outright instead of claiming protection that never happens.
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-dsh', label: 'g', kind: 'dsh', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: PIN_A }), null, 'a dsh-kind https target never carries a pin (probe-pinned-but-proxy-unpinned would be a false claim)')
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-future', label: 'g', kind: 'future-target', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: PIN_A }), null, 'any non-gateway kind refuses a pin')
})

/** Start a real node:https server with an embedded fixture certificate. */
async function startHttpsProbeServer(
  keyPem: string,
  certPem: string,
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createHttpsServer({ key: keyPem, cert: certPem }, handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

/** An https gateway spec (no insecureHttp → https): the S23 pin probes. */
function httpsSpec(id: string, port: number, extra: Record<string, unknown> = {}): ReturnType<typeof gatewayProvider.validateSpec> {
  return gatewayProvider.validateSpec({ id, label: 'g', kind: 'gateway', transport: 'http', host: '127.0.0.1', remotePort: port, ...extra })
}

test('verifyUp over https: pin match probes ok, pin mismatch is terminal, no pin keeps the legacy path (S23)', async () => {
  let receivedRequests = 0
  const handleEnvelope = envelopeHandler({})
  const server = await startHttpsProbeServer(KEY_A, CERT_A, (req, res) => {
    receivedRequests += 1
    handleEnvelope(req, res)
  })
  try {
    // Pin match: the fixture cert's own pin is the trust anchor — the probe
    // succeeds against the self-signed server with NO CA trust (the Caddy
    // `tls internal` use case: no NODE_EXTRA_CA_CERTS needed).
    const specOk = httpsSpec('tls-pin-ok', server.port, { spkiPin: PIN_A })
    assert.ok(specOk !== null)
    const ok = await gatewayProvider.verifyUp!(specOk!, { host: '127.0.0.1', port: server.port })
    assert.equal(ok.ok, true, 'a peer whose SPKI matches the pin is trusted')
    assert.equal(receivedRequests, 1)

    // Pin mismatch: the server presents cert A, the pin is cert B's — the
    // peer's key is not the pinned key → TERMINAL with the S23 detail.
    const specBad = httpsSpec('tls-pin-bad', server.port, { spkiPin: PIN_B })
    assert.ok(specBad !== null)
    setGatewayToken('tls-pin-bad', TOKEN)
    const bad = await gatewayProvider.verifyUp!(specBad!, { host: '127.0.0.1', port: server.port })
    assert.equal(bad.ok, false)
    if (!bad.ok) {
      assert.equal(bad.terminal, true, 'a pinned mismatch is deterministic — retrying cannot change the answer')
      assert.match(bad.detail ?? '', /证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误/)
    }
    assert.equal(receivedRequests, 1, 'a wrong-key peer receives zero HTTP requests or credential headers')

    // No pin: the pin machinery is inert — the legacy https probe runs, and
    // against this self-signed server the unpinned chain is untrusted →
    // transient connection failure, never the terminal pin verdict.
    const specPlain = httpsSpec('tls-pin-none', server.port)
    assert.ok(specPlain !== null)
    const plain = await gatewayProvider.verifyUp!(specPlain!, { host: '127.0.0.1', port: server.port })
    assert.equal(plain.ok, false)
    if (!plain.ok) {
      assert.notEqual(plain.terminal, true, 'an unpinned untrusted chain is a transient connection failure, not a pin verdict')
      assert.match(plain.detail ?? '', /did not answer/)
    }
  } finally {
    setGatewayToken('tls-pin-bad', null)
    await server.close()
  }
})

test('P1-2: the password LOGIN is SPKI-pinned exactly like the probe — a mismatched peer login is terminal (never forever-network), a matching pin succeeds (design 17 §7.3/§13.4.2/S23)', async () => {
  // A real gateway stub over the self-signed fixture cert: POST /auth/login
  // answers the 3xx + session cookie, everything else (the gateway-owned
  // runtime identity probe) answers 200 — so the whole password flow is real TLS.
  const receivedLoginBodies: string[] = []
  const server = await startHttpsProbeServer(KEY_A, CERT_A, (req, res) => {
    if (req.url === '/auth/login') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
      req.on('end', () => {
        receivedLoginBodies.push(body)
        res.writeHead(302, { 'set-cookie': [`dsh_gateway_session=fake-jwt; HttpOnly; Path=/; SameSite=Strict`] })
        res.end()
      })
      return
    }
    envelopeHandler({})(req, res)
  })
  const mgr = createGatewaySessionManager()
  const origin: GatewaySessionOrigin = { baseUrl: `https://127.0.0.1:${server.port}`, insecureHttp: false, scope: 'test:tls-login' }
  try {
    // Matching pin: the login succeeds against the self-signed server — the
    // pin IS the trust anchor (the internal-CA case that used to fail as
    // 'network' and could never reach ready).
    const match = await mgr.ensureSession({ ...origin, spkiPin: PIN_A }, PASSWORD)
    assert.equal(match.ok, true, 'a login against the pinned peer succeeds')
    if (match.ok) assert.equal(match.cookie, SESSION_COOKIE)
    assert.deepEqual(receivedLoginBodies, [JSON.stringify({ password: PASSWORD })])
    assert.equal(mgr.cachedCookie(origin), SESSION_COOKIE, 'the pinned login caches the session like any other')
    mgr.invalidate(origin)

    // Mismatched pin: the login is destroyed by the socket verifier →
    // classified 'other' (deterministic protocol evidence — the verifyUp flow
    // maps 'other' TERMINAL, so the password flow never spins as 'network').
    const mismatch = await mgr.ensureSession({ ...origin, spkiPin: PIN_B }, PASSWORD)
    assert.equal(mismatch.ok, false)
    if (!mismatch.ok) {
      assert.equal(mismatch.code, 'other', 'a pin mismatch is deterministic protocol evidence, not a transient network failure')
      assert.match(mismatch.error, /证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误/)
    }
    assert.equal(mgr.cachedCookie(origin), null, 'a failed pinned login caches nothing')
    assert.equal(receivedLoginBodies.length, 1, 'a wrong-key peer receives zero login requests or password-body bytes')

    // No pin: the legacy unpinned login runs — against the self-signed server
    // the untrusted chain is a transient network failure (the pin is what
    // enables the internal-CA login).
    const unpinned = await mgr.ensureSession(origin, PASSWORD)
    assert.equal(unpinned.ok, false)
    if (!unpinned.ok) assert.equal(unpinned.code, 'network', 'an unpinned login against an untrusted chain stays the legacy transient network failure')

    // End-to-end verifyUp with the REAL session manager wired as the hooks: a
    // pin-mismatched login is TERMINAL — the connect verdict lands immediately
    // instead of cycling 'network' forever (the 永不 ready bug P1-2 fixes).
    configureGatewaySessionProvider({
      ensureSession: (o, password) => mgr.ensureSession(o, password),
      generation: o => mgr.generation(o),
      registrationAuthProof: o => mgr.registrationAuthProof(o),
      setRegistrationAuthProof: (o, proof) => mgr.setRegistrationAuthProof(o, proof),
      cachedCookie: o => mgr.cachedCookie(o),
      invalidate: o => mgr.invalidate(o),
    })
    setGatewayPassword('tls-login-pin', PASSWORD)
    const specBad = httpsSpec('tls-login-pin', server.port, { spkiPin: PIN_B })
    assert.ok(specBad !== null)
    const verdictBad = await gatewayProvider.verifyUp!(specBad!, { host: '127.0.0.1', port: server.port })
    assert.equal(verdictBad.ok, false)
    if (!verdictBad.ok) {
      assert.equal(verdictBad.terminal, true, 'a pin-mismatched login is terminal — the three-state password flow never spins as network')
      assert.match(verdictBad.detail ?? '', /证书固定不匹配（SPKI）/)
    }
    assert.equal(receivedLoginBodies.length, 1, 'end-to-end mismatch also keeps the stored password behind the pin gate')
    // Matching pin end-to-end: the pinned login mints the session and the
    // pinned probe answers the envelope → ready.
    setGatewayPassword('tls-login-ok', PASSWORD)
    const specOk = httpsSpec('tls-login-ok', server.port, { spkiPin: PIN_A })
    assert.ok(specOk !== null)
    const verdictOk = await gatewayProvider.verifyUp!(specOk!, { host: '127.0.0.1', port: server.port })
    assert.equal(verdictOk.ok, true, 'the pinned login + pinned probe succeed end-to-end')
  } finally {
    setGatewayPassword('tls-login-pin', null)
    setGatewayPassword('tls-login-ok', null)
    configureGatewaySessionProvider({})
    mgr.dispose()
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// Desktop-synced chamber host packages (design 17 §9.3, 2026-12 Phase 3)
// ---------------------------------------------------------------------------

const GRAPH_PACKAGE: LocalChamberHostPackage = {
  name: '@dsh-chamber/dsh-host-client-graph',
  packageJson: JSON.stringify({ name: '@dsh-chamber/dsh-host-client-graph', version: '1.2.3' }),
  distIndex: 'export const graph = 1\n',
}
const GIT_PACKAGE: LocalChamberHostPackage = {
  name: '@dsh-chamber/dsh-host-git-worktree',
  packageJson: JSON.stringify({ name: '@dsh-chamber/dsh-host-git-worktree', version: '2.0.0' }),
  distIndex: 'export const git = 1\n',
}

function syncLog(): { warns: string[]; logs: string[]; logger: { warn(m: string): void; log(m: string): void } } {
  const warns: string[] = []
  const logs: string[] = []
  return {
    warns,
    logs,
    logger: { warn: (message: string) => warns.push(message), log: (message: string) => logs.push(message) },
  }
}

function startSyncHttpServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        port: address.port,
        close: () => new Promise<void>((res, rej) => server.close(err => (err ? rej(err) : res()))),
      })
    })
  })
}

test('syncGatewayChamberPlugins: happy path uploads only the changed package and requests the controlled restart', async () => {
  const seen: Array<{ method: string; url: string; body?: unknown }> = []
  const server = await startSyncHttpServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', ...(body === '' ? {} : { body: JSON.parse(body) }) })
      if (req.url === '/chamber/plugins' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          items: [
            { name: '@dsh-chamber/dsh-host-client-graph', version: '1.0.0' },
            { name: '@dsh-chamber/dsh-host-git-worktree', version: '2.0.0' },
          ],
        }))
        return
      }
      if (req.url === '/chamber/plugins' && req.method === 'PUT') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, changed: true }))
        return
      }
      if (req.url === '/chamber/runtime/restart' && req.method === 'POST') {
        res.writeHead(202)
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  try {
    const { warns, logs, logger } = syncLog()
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      packages: [GRAPH_PACKAGE, GIT_PACKAGE],
      logger,
    })
    assert.equal(result.uploaded, true)
    assert.equal(result.skipped, false)
    assert.deepEqual(seen.map(entry => `${entry.method} ${entry.url}`), [
      'GET /chamber/plugins',
      'PUT /chamber/plugins',
      'POST /chamber/runtime/restart',
    ])
    // Only the version-mismatched package is uploaded, with the exact body.
    const put = seen.find(entry => entry.method === 'PUT')
    assert.ok(put !== undefined)
    assert.equal((put.body as { name: string }).name, '@dsh-chamber/dsh-host-client-graph')
    assert.deepEqual((put.body as { files: Record<string, string> }).files, {
      'package.json': GRAPH_PACKAGE.packageJson,
      'dist/index.js': GRAPH_PACKAGE.distIndex,
    })
    assert.deepEqual(warns, [])
    assert.ok(logs.some(line => line.includes('uploaded @dsh-chamber/dsh-host-client-graph')))
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: version-identical packages skip the upload (idempotent)', async () => {
  const requests: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    requests.push(`${req.method ?? ''} ${req.url ?? ''}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      items: [
        { name: '@dsh-chamber/dsh-host-client-graph', version: '1.2.3' },
        { name: '@dsh-chamber/dsh-host-git-worktree', version: '2.0.0' },
      ],
    }))
  })
  try {
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      packages: [GRAPH_PACKAGE, GIT_PACKAGE],
      logger: syncLog().logger,
    })
    assert.equal(result.uploaded, false)
    assert.equal(result.skipped, false)
    assert.deepEqual(requests, ['GET /chamber/plugins'])
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: a byte-identical PUT answer (changed:false) asks no restart', async () => {
  const requests: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    requests.push(`${req.method ?? ''} ${req.url ?? ''}`)
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ items: [{ name: '@dsh-chamber/dsh-host-client-graph', version: '1.0.0' }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, changed: false }))
  })
  try {
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      packages: [GRAPH_PACKAGE],
      logger: syncLog().logger,
    })
    assert.equal(result.uploaded, false, 'a byte-identical upload must not trigger the controlled restart')
    assert.deepEqual(requests, ['GET /chamber/plugins', 'PUT /chamber/plugins'])
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: a --no-auth gateway (empty headers) still receives the sync', async () => {
  const seenAuth: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? '(none)')
    if (req.method === 'PUT') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, changed: true }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [] }))
  })
  try {
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      headers: {},
      spkiPin: null,
      packages: [GRAPH_PACKAGE],
      logger: syncLog().logger,
    })
    assert.equal(result.uploaded, true, 'a headerless --no-auth deployment must still receive the sync')
    assert.deepEqual(seenAuth, ['(none)', '(none)', '(none)'], 'no Authorization header is invented for the headerless shape')
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: an ssh-tunnel origin presents the remote authority as the Host header', async () => {
  const seenHosts: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    seenHosts.push(req.headers.host ?? '(none)')
    if (req.method === 'PUT') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, changed: true }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [] }))
  })
  try {
    await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      authority: 'gateway.example:443',
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      packages: [GRAPH_PACKAGE],
      logger: syncLog().logger,
    })
    assert.deepEqual(seenHosts, ['gateway.example:443', 'gateway.example:443', 'gateway.example:443'])
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: non-2xx answers and a down gateway resolve with a warn, never reject', async () => {
  const authServer = await startSyncHttpServer((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  try {
    const first = syncLog()
    const denied = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${authServer.port}`,
      headers: { authorization: 'Bearer bad' },
      spkiPin: null,
      packages: [GRAPH_PACKAGE],
      logger: first.logger,
    })
    assert.equal(denied.uploaded, false)
    assert.equal(denied.skipped, false)
    assert.ok(first.warns.some(line => line.includes('HTTP 401')), 'a refused projection warns with the status')
  } finally {
    await authServer.close()
  }

  // Gateway down: the connect error is contained — resolves, never rejects.
  const closed = await startSyncHttpServer((_req, res) => { res.writeHead(200); res.end() })
  const deadPort = closed.port
  await closed.close()
  const second = syncLog()
  const result = await syncGatewayChamberPlugins({
    origin: `http://127.0.0.1:${deadPort}`,
    headers: { authorization: 'Bearer test-token' },
    spkiPin: null,
    packages: [GRAPH_PACKAGE],
    logger: second.logger,
    timeoutMs: 500,
  })
  assert.equal(result.uploaded, false)
  assert.equal(result.skipped, false)
  assert.ok(second.warns.length > 0, 'a down gateway warns and resolves')
})

test('syncGatewayChamberPlugins: an SPKI-pinned https gateway is checked before any application bytes', async () => {
  let receivedRequests = 0
  const server = await startHttpsProbeServer(KEY_A, CERT_A, (_req, res) => {
    receivedRequests += 1
    res.writeHead(200)
    res.end('{}')
  })
  try {
    const { warns, logger } = syncLog()
    const result = await syncGatewayChamberPlugins({
      origin: `https://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: PIN_B,
      packages: [GRAPH_PACKAGE],
      logger,
    })
    assert.equal(result.uploaded, false)
    assert.equal(receivedRequests, 0, 'a wrong-key peer receives zero application bytes')
    assert.ok(warns.length > 0, 'the pin mismatch warns and resolves')
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: an empty package list is a best-effort skip', async () => {
  const result = await syncGatewayChamberPlugins({
    origin: 'http://127.0.0.1:1',
    headers: { authorization: 'Bearer x' },
    spkiPin: null,
    packages: [],
    logger: syncLog().logger,
  })
  assert.deepEqual(result, { uploaded: false, skipped: true })
})
