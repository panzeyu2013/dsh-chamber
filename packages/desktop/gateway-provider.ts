/**
 * The `http` transport provider (design 17 §2.2/§9.2): a DIRECT ENDPOINT — no
 * local tunnel child. It serves the `http` transport for the GATEWAY target
 * only; `dsh`×`http` is DISABLED (a dsh web profile answers 401 without the
 * unrecoverable spawn-time browser-auth token), ssh is the only dsh transport,
 * and an over-ssh spec is REFUSED here.
 * Credentials are NOT in the spec or any renderer payload: they live in the
 * credential store keyed by instance id, mirrored to `<userData>/gateway-secrets.json`
 * (0600, atomic, safeStorage blobs with a documented plaintext fallback) so a
 * configured gateway auto-connects after restart; corrupt mirror → loud preserve
 * as `.corrupt`; an encrypted blob a later startup cannot decrypt is CORRUPT — never adopted as plaintext.
 */

import { dirname } from 'node:path'
import { INSTANCE_ID_PATTERN, MAX_INSTANCE_LABEL_CHARS } from './transport-provider.ts'
import { gatewayCredentialBinding, isCredentialBinding } from './credential-binding.ts'
// Shared corrupt preserve + legacy-`.tmp` sweep mechanics for the owner-only
// store files (single source, used by the providers/ssh-plugin-journal/
// chamber-settings).
import { isPlainRecord, preserveInvalidCredentialFile, removeLegacyTmpResidue } from './store-file-hygiene.ts'
import type {
  TransportInstanceSpec,
  TransportKind,
  TransportProbeEndpoint,
  TransportProvider,
  TransportVerifyResult,
} from './transport-provider.ts'
import { buildGatewaySessionOrigin, gatewaySessionScopeForConnection } from './gateway-session.ts'
import type { GatewayRegistrationAuthProof, GatewaySessionOrigin, GatewaySessionResult } from './gateway-session.ts'
import { readOwnerOnlySecretFile } from './owner-only-secret-file.ts'
import { parseSpecArg } from './gateway-ipc-shared.ts'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  GATEWAY_PASSWORD_MAX_CHARS,
  GATEWAY_PASSWORD_MIN_CHARS,
  GATEWAY_TOKEN_MAX_CHARS,
  GATEWAY_TOKEN_MIN_CHARS,
  GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN,
  HOST_PACKAGE_SEED_FILES,
  PLUGIN_NAME_PATTERN,
  SPKI_PIN_PATTERN,
  type HostPackageSeedFile,
} from './control-plane-module.ts'
import { GATEWAY_PLUGIN_VERSION_PATTERN, TARBALL_MAX_ARCHIVE_BYTES } from './plugin-tarball.ts'
import { sanitizeErrorText } from './sanitize-error.ts'
import { describeError } from './describe-error.ts'
// The shared bounded-request core: both plugin-sync request forms and the identity probe map its BoundedHttpOutcome.
import { boundedGatewayRequest } from './gateway-http-core.ts'

/** Gateway hostname whitelist: a bare hostname/IPv4 (NO colon — the port is
 * carried separately in `remotePort`) or a fully bracketed IPv6 literal. Unlike
 * ssh's, the gateway builds URLs from it, so `host:8443` would break the port. */
export const GATEWAY_HOST_PATTERN = /^(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:.]+\])$/
export const MAX_GATEWAY_HOST_CHARS = 253
// Gateway credential bounds are the shared wire-protocol single source
// (control-plane-module.ts): the same values the gateway server and the proxy
// injection gate enforce; local names are aliases for form/validation call sites.
export const MAX_GATEWAY_TOKEN_CHARS = GATEWAY_TOKEN_MAX_CHARS
export const MIN_GATEWAY_TOKEN_CHARS = GATEWAY_TOKEN_MIN_CHARS
export const MAX_GATEWAY_PASSWORD_CHARS = GATEWAY_PASSWORD_MAX_CHARS
export const MIN_GATEWAY_PASSWORD_CHARS = GATEWAY_PASSWORD_MIN_CHARS
const GATEWAY_CREDENTIAL_HEADER_PATTERN = GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN

// SPKI certificate pinning (design 17 §13.4.2 / S23): single-sourced in
// control-plane spki-pin.ts and re-exported through the dual-path facade; the
// identity probe AND the proxy forwarding gate import the SAME helpers. The pin
// is enforced on TLS 'secureConnect' (checkServerIdentity cannot pin an internal
// CA), so a wrong-key peer sees zero headers, credential bytes, or login body.


/** Validate a token before any live transport is disconnected. */
export function gatewayTokenValidationError(token: string | null): string | null {
  if (token === null || token === '') return null
  if (!GATEWAY_CREDENTIAL_HEADER_PATTERN.test(token)) {
    return 'gateway token must contain visible ASCII characters only'
  }
  if (token.length < MIN_GATEWAY_TOKEN_CHARS) {
    return `gateway token must contain at least ${MIN_GATEWAY_TOKEN_CHARS} characters`
  }
  if (token.length > MAX_GATEWAY_TOKEN_CHARS) {
    return `gateway token is limited to ${MAX_GATEWAY_TOKEN_CHARS} characters`
  }
  return null
}

/** Validate a login password — mirrors the gateway server/config gate exactly:
 *  12–1024 JavaScript characters; passwords are JSON body data and may be Unicode. */
export function gatewayPasswordValidationError(password: string | null): string | null {
  if (password === null || password === '') return null
  if (password.length < MIN_GATEWAY_PASSWORD_CHARS) {
    return `gateway password must contain at least ${MIN_GATEWAY_PASSWORD_CHARS} characters`
  }
  if (password.length > MAX_GATEWAY_PASSWORD_CHARS) {
    return `gateway password is limited to ${MAX_GATEWAY_PASSWORD_CHARS} characters`
  }
  return null
}

/** Default gateway https port when the connection form omits it. */
export const DEFAULT_GATEWAY_PORT = 443

/** Default gateway http port (insecureHttp) when the form omits it; the form
 *  layer uses it for the plaintext-http origin default (design 17 §9.1). */
export const DEFAULT_GATEWAY_HTTP_PORT = 80

/** Timeout of the one-shot gateway-owned runtime identity probe (verifyUp). */
export const GATEWAY_VERIFY_TIMEOUT_MS = 5_000

/** Response-body cap of the gateway identity probe. */
export const GATEWAY_VERIFY_MAX_BODY_BYTES = 1024 * 1024

/** Classify a non-success identity-probe response: client/protocol mistakes are
 * deterministic, except timeout/early-data/rate-limit statuses, and every 5xx is
 * transient (gateway startup, overload, maintenance, upstream dsh failures). */
export function gatewayHttpFailureIsTerminal(statusCode: number): boolean {
  if (statusCode === 408 || statusCode === 425 || statusCode === 429) return false
  if (statusCode >= 500 && statusCode < 600) return false
  // Any other actual HTTP answer is deterministic protocol/config evidence:
  // redirects and alternate 2xx statuses are not the required dsh RPC
  // envelope and will not heal through transport retry.
  return statusCode >= 100 && statusCode < 600
}

// Per-instance gateway credentials: an instance may carry a shared bearer TOKEN
// and/or a login PASSWORD (independent, both nullable), held in main-process memory
// and mirrored to `<userData>/gateway-secrets.json` (schemaVersion 3, 0600, atomic).
// One explicit `storage: safeStorage | plaintext` discriminator: ciphertext is never
// guessed from its characters, so it can never be sent as plaintext; never in the
// registry, never logged, never exposed to the renderer; entries drop on removal/clear.
/** Encryption boundary for the mirror: `decrypt` must THROW on a non-blob — a
 * `safeStorage`-tagged file that cannot be decrypted is corrupt (preserved as `.corrupt`),
 * never retried as plaintext; adapter UNAVAILABLE is the cross-flavor case instead
 * (preserved in place). */
export interface SecretCryptoAdapter {
  isAvailable(): boolean
  encrypt(plain: string): string
  decrypt(blob: string): string
}

/** Default adapter: encryption unavailable → the mirror stays plaintext (design 05 §8 / 17 §12). */
const plaintextSecretCrypto: SecretCryptoAdapter = {
  isAvailable: () => false,
  encrypt: plain => plain,
  decrypt: blob => blob,
}

const tokens = new Map<string, string>()
const passwords = new Map<string, string>()
const tokenBindings = new Map<string, string>()
const passwordBindings = new Map<string, string>()

/** The credentials mirror path; null = memory-only (tests). */
let secretFile: string | null = null
/** The active crypto adapter (defaults to plaintext). */
let secretCrypto: SecretCryptoAdapter = plaintextSecretCrypto
let secretSpecResolver: ((id: string) => TransportInstanceSpec | null) | null = null


type GatewaySecretFileStorage = 'safeStorage' | 'plaintext'

/** Honest durable mode of the loaded mirror — intentionally not
 *  `secretCrypto.isAvailable()`: a plaintext file stays plaintext until the rewrite succeeds. */
let durableSecretStorage: GatewaySecretFileStorage = 'plaintext'

/** 当前镜像文件是 Electron flavor 以 safeStorage 写出的密文，而本进程（Electron-free
 *  sidecar）没有壳 Keychain 适配器 ⇒ 无法解密。文件**不是损坏**（Electron flavor 仍可读
 *  它），不得走 .corrupt 改名路径；条目 fail closed（store 空），渲染面显示精确文案。 */
export const CROSS_FLAVOR_SAFESTORAGE_NOTICE =
  'gateway credentials mirror is safeStorage-encrypted by the Electron flavor; '
  + 'this Electron-free Swift sidecar has no shell keychain crypto adapter and cannot decrypt it '
  + '— the file is preserved unchanged (reopen the Electron flavor to keep using those credentials, '
  + 'or re-enter them here; the next save writes the documented 0600 plaintext fallback)'
let crossFlavorSafeStorageUnreadable = false

/** renderer projection input (non-secret boolean): the loaded mirror is a cross-flavor
 *  safeStorage file this process cannot decrypt (merged into instances_get rows). */
export function gatewaySecretStorageCrossFlavorUnreadable(): boolean {
  return crossFlavorSafeStorageUnreadable
}

/** A loaded credential must pass its table's gate exactly like a fresh one:
 *  tokens are length-bounded visible ASCII; passwords may be Unicode; '' is invalid. */
function isValidCredentialValue(value: string, minChars: number, maxChars: number, visibleAscii: boolean): boolean {
  return value.length >= minChars && value.length <= maxChars
    && (!visibleAscii || GATEWAY_CREDENTIAL_HEADER_PATTERN.test(value))
}

/** Load and validate ONE credential table into plaintext, or null when any entry is
 *  structurally invalid, an unreadable encrypted blob (`resolve` → null), or fails the
 *  credential gate. `resolve` maps stored value → plaintext BEFORE the gate
 *  (discriminator-directed for v2/v3, identity for always-plaintext v1). Null drives the
 *  caller's preserveInvalidCredentialFile: the WHOLE file is loud-corrupt, never silently empty. */
function loadCredentialTable(
  table: Record<string, unknown>,
  minChars: number,
  maxChars: number,
  resolve: (blob: string) => string | null,
  visibleAscii = true,
): Map<string, string> | null {
  const out = new Map<string, string>()
  for (const [id, value] of Object.entries(table)) {
    if (id === 'local' || !INSTANCE_ID_PATTERN.test(id) || typeof value !== 'string') return null
    const plaintext = resolve(value)
    if (plaintext === null || !isValidCredentialValue(plaintext, minChars, maxChars, visibleAscii)) return null
    out.set(id, plaintext)
  }
  return out
}

/** Resolve one v2/v3 stored value per the FILE'S explicit discriminator (S22): a
 *  safeStorage file is unreadable when encryption is unavailable or decryption fails
 *  (never interpreted as plaintext); a plaintext-tagged file never decrypts. */
function resolveStoredValue(blob: string, storage: GatewaySecretFileStorage): string | null {
  if (storage === 'plaintext') return blob
  if (!secretCrypto.isAvailable()) return null
  try {
    return secretCrypto.decrypt(blob)
  } catch {
    return null
  }
}

/**
 * Point the gateway credentials store at its mirror file (once at startup) and
 * load existing entries. Missing = empty set (first run) except an empty
 * schemaVersion 1 file, which converges; non-empty v1/v2 files have no
 * credential-domain binding and stay preserved + disabled with a loud re-entry
 * notice. A corrupt file fails LOUDLY (`<file>.corrupt`), never silently empty —
 * including the S22 flip: safeStorage blobs written while crypto worked are
 * corrupt when loaded without it, never adopted as plaintext credentials.
 */
export function configureGatewaySecretStore(
  file: string | null,
  crypto?: SecretCryptoAdapter,
  resolveSpec?: (id: string) => TransportInstanceSpec | null,
): string | null {
  secretFile = file
  secretCrypto = crypto ?? plaintextSecretCrypto
  secretSpecResolver = resolveSpec ?? null
  // Missing/memory-only stores use this on their first write; an existing bound v3 file replaces it below.
  durableSecretStorage = secretCrypto.isAvailable() ? 'safeStorage' : 'plaintext'
  crossFlavorSafeStorageUnreadable = false
  tokens.clear()
  passwords.clear()
  tokenBindings.clear()
  passwordBindings.clear()
  if (file === null) return null
  // One-time crash-residue sweep of the legacy persist's fixed `${file}.tmp` residue.
  removeLegacyTmpResidue(file)
  let text: string
  try {
    text = readOwnerOnlySecretFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return `cannot read ${file}: ${String(error)}`
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return preserveInvalidCredentialFile(file, 'gateway secrets file')
  }
  if (!isPlainRecord(parsed)) return preserveInvalidCredentialFile(file, 'gateway secrets file')
  if (parsed.schemaVersion !== 3
    || !isPlainRecord(parsed.tokens) || !isPlainRecord(parsed.passwords)) {
    return preserveInvalidCredentialFile(file, 'gateway secrets file')
  }
  const storage = parsed.storage
  if (storage !== 'safeStorage' && storage !== 'plaintext') {
    return preserveInvalidCredentialFile(file, 'gateway secrets file')
  }
  const effectiveStorage: GatewaySecretFileStorage = storage === 'safeStorage' ? 'safeStorage' : 'plaintext'
  // 跨 flavor 凭据不可读：文件带 safeStorage 判别符且本进程无 Keychain 适配器 ⇒
  // 密文无法解密。**不是损坏**——绝不 rename 成 .corrupt（Electron flavor 仍需这些
  // 凭据）：原文件原地保留、条目 fail closed、loud 文案 + secretStorageUnreadable 投影。
  if (effectiveStorage === 'safeStorage' && !secretCrypto.isAvailable()) {
    const hasEntries = Object.keys(parsed.tokens).length > 0 || Object.keys(parsed.passwords).length > 0
    if (hasEntries) {
      crossFlavorSafeStorageUnreadable = true
      durableSecretStorage = 'plaintext'
      return CROSS_FLAVOR_SAFESTORAGE_NOTICE
    }
    persistGatewaySecrets(new Map(), new Map(), new Map(), new Map())
    return null
  }
  durableSecretStorage = effectiveStorage
  const loadedTokens = loadCredentialTable(
    parsed.tokens,
    MIN_GATEWAY_TOKEN_CHARS,
    MAX_GATEWAY_TOKEN_CHARS,
    blob => resolveStoredValue(blob, effectiveStorage),
  )
  const loadedPasswords = loadCredentialTable(
    parsed.passwords,
    MIN_GATEWAY_PASSWORD_CHARS,
    MAX_GATEWAY_PASSWORD_CHARS,
    blob => resolveStoredValue(blob, effectiveStorage),
    false,
  )
  if (loadedTokens === null || loadedPasswords === null) return preserveInvalidCredentialFile(file, 'gateway secrets file')

  if (!isPlainRecord(parsed.tokenBindings) || !isPlainRecord(parsed.passwordBindings)) {
    return preserveInvalidCredentialFile(file, 'gateway secrets file')
  }
  const loadedTokenBindings = new Map<string, string>()
  const loadedPasswordBindings = new Map<string, string>()
  const loadBindings = (
    values: ReadonlyMap<string, string>,
    table: Record<string, unknown>,
    out: Map<string, string>,
  ): boolean => {
    const entries = Object.entries(table)
    if (entries.length !== values.size) return false
    for (const [id, binding] of entries) {
      if (!values.has(id) || !isCredentialBinding(binding)) return false
      out.set(id, binding)
    }
    return true
  }
  if (!loadBindings(loadedTokens, parsed.tokenBindings, loadedTokenBindings)
    || !loadBindings(loadedPasswords, parsed.passwordBindings, loadedPasswordBindings)) {
    return preserveInvalidCredentialFile(file, 'gateway secrets file')
  }
  // Upgrade a documented plaintext fallback when a keychain is now available; claim
  // safeStorage only after the atomic rewrite succeeds (on failure it stays visibly plaintext).
  if (effectiveStorage === 'plaintext' && secretCrypto.isAvailable()) {
    try {
      persistGatewaySecrets(loadedTokens, loadedPasswords, loadedTokenBindings, loadedPasswordBindings)
    } catch (error) {
      for (const [id, value] of loadedTokens) tokens.set(id, value)
      for (const [id, value] of loadedPasswords) passwords.set(id, value)
      for (const [id, value] of loadedTokenBindings) tokenBindings.set(id, value)
      for (const [id, value] of loadedPasswordBindings) passwordBindings.set(id, value)
      return `loaded plaintext gateway credentials, but safeStorage upgrade failed: ${String(error)}; the mirror remains plaintext`
    }
  }
  for (const [id, value] of loadedTokens) tokens.set(id, value)
  for (const [id, value] of loadedPasswords) passwords.set(id, value)
  for (const [id, value] of loadedTokenBindings) tokenBindings.set(id, value)
  for (const [id, value] of loadedPasswordBindings) passwordBindings.set(id, value)
  return null
}

/** Set/clear one instance's token or password (null/'' = clear): write-through, the
 *  live state changes only after its durable mirror succeeds. Design 17 §2.3: token and
 *  password are INDEPENDENT nullable credentials — clearing one never touches the other.
 *  Transactional add/edit/delete flows use the grouped `setInstanceSecrets` primitive. */
/** 一个 gateway 凭据维度自己的写入面（design 17 §2.3：token 与 password 相互独立）：
 *  没有布尔开关、没有 kind 分派——每个维度显式给出自己的校验、表操作与文案。 */
interface GatewayCredentialDimension {
  /** 仅用于错误文案（`refusing <label> for ...` / `refusing to persist a gateway <label> ...`）。 */
  label: 'token' | 'password'
  /** 该维度的取值校验（返回错误文案或 null）。 */
  validate: (value: string | null) => string | null
  /** 该维度当前是否持有 id 的值（清除不存在的维度 = 磁盘 no-op）。 */
  has: (id: string) => boolean
  /** 把值写进本次事务副本（含绑定）。 */
  write: (next: GatewaySecretMaps, id: string, value: string, binding: string | null) => void
  /** 从本次事务副本移除该维度的值与绑定。 */
  clear: (next: GatewaySecretMaps, id: string) => void
}

/** 一次写入的事务副本（四张表全部浅拷贝，成功才整体提交）。 */
interface GatewaySecretMaps {
  tokens: Map<string, string>
  passwords: Map<string, string>
  tokenBindings: Map<string, string>
  passwordBindings: Map<string, string>
}

const GATEWAY_TOKEN_DIMENSION: GatewayCredentialDimension = {
  label: 'token',
  validate: gatewayTokenValidationError,
  has: id => tokens.has(id),
  write: (next, id, value, binding) => {
    next.tokens.set(id, value)
    if (binding === null) next.tokenBindings.delete(id)
    else next.tokenBindings.set(id, binding)
  },
  clear: (next, id) => {
    next.tokens.delete(id)
    next.tokenBindings.delete(id)
  },
}

const GATEWAY_PASSWORD_DIMENSION: GatewayCredentialDimension = {
  label: 'password',
  validate: gatewayPasswordValidationError,
  has: id => passwords.has(id),
  write: (next, id, value, binding) => {
    next.passwords.set(id, value)
    if (binding === null) next.passwordBindings.delete(id)
    else next.passwordBindings.set(id, binding)
  },
  clear: (next, id) => {
    next.passwords.delete(id)
    next.passwordBindings.delete(id)
  },
}

/** 两个维度共用的写入驱动：校验 →（清除本维不存在的 id 即 no-op）→ 目标绑定 → 单次持久化 + 提交。
 *  **另一维度永不被读取或写入**：清除 token 永不触碰 password（反向同理）。 */
function setGatewayCredential(
  dimension: GatewayCredentialDimension,
  id: string,
  value: string | null,
  spec?: TransportInstanceSpec | null,
): void {
  if (id === 'local' || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing ${dimension.label} for invalid instance id ${JSON.stringify(id)}`)
  }
  const error = dimension.validate(value)
  if (error !== null) throw new Error(error)
  // A clear of an id that owns nothing in THIS dimension is a disk no-op — do not
  // manufacture or rewrite the file; the other dimension is independent (design 17 §2.3).
  if ((value === null || value === '') && !dimension.has(id)) return
  const next: GatewaySecretMaps = {
    tokens: new Map(tokens),
    passwords: new Map(passwords),
    tokenBindings: new Map(tokenBindings),
    passwordBindings: new Map(passwordBindings),
  }
  if (value === null || value === '') {
    dimension.clear(next, id)
  } else {
    const bindingSpec = spec ?? secretSpecResolver?.(id) ?? null
    const binding = bindingSpec === null ? null : gatewayCredentialBinding(bindingSpec)
    if (binding === null && secretFile !== null) {
      throw new Error(`refusing to persist a gateway ${dimension.label} without a matching gateway target binding`)
    }
    dimension.write(next, id, value, binding)
  }
  persistGatewaySecrets(next.tokens, next.passwords, next.tokenBindings, next.passwordBindings)
  commitGatewaySecrets(next.tokens, next.passwords, next.tokenBindings, next.passwordBindings)
}
export function setGatewayToken(id: string, token: string | null, spec?: TransportInstanceSpec | null): void {
  setGatewayCredential(GATEWAY_TOKEN_DIMENSION, id, token, spec)
}

/** Set or clear the login password (null/'' = clear) — design 17 §2.3: independent from
 *  the token, so an explicit password clear never touches it; write-through like the setter. */
export function setGatewayPassword(id: string, password: string | null, spec?: TransportInstanceSpec | null): void {
  setGatewayCredential(GATEWAY_PASSWORD_DIMENSION, id, password, spec)
}

/** Set or clear BOTH credentials in a SINGLE atomic persist (null/'' = clear each).
 *  Main-owned save/delete transactions use this for target-domain entry, retarget,
 *  removal, compensation and crash-residue scrubbing; write-through like the setters. */
export function setInstanceSecrets(
  id: string,
  token: string | null,
  password: string | null,
  spec?: TransportInstanceSpec | null,
): void {
  if (id === 'local' || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing secrets for invalid instance id ${JSON.stringify(id)}`)
  }
  const tokenError = gatewayTokenValidationError(token)
  if (tokenError !== null) throw new Error(tokenError)
  const passwordError = gatewayPasswordValidationError(password)
  if (passwordError !== null) throw new Error(passwordError)
  // A double clear of an id that owns neither credential must not rewrite the file
  // (or make an otherwise-valid clear depend on that disk write).
  if ((token === null || token === '') && !tokens.has(id)
    && (password === null || password === '') && !passwords.has(id)) return
  const nextTokens = new Map(tokens)
  const nextPasswords = new Map(passwords)
  const nextTokenBindings = new Map(tokenBindings)
  const nextPasswordBindings = new Map(passwordBindings)
  const bindingSpec = spec ?? secretSpecResolver?.(id) ?? null
  const binding = bindingSpec === null ? null : gatewayCredentialBinding(bindingSpec)
  if ((token !== null && token !== '' || password !== null && password !== '') && binding === null && secretFile !== null) {
    throw new Error('refusing to persist gateway credentials without a matching gateway target binding')
  }
  if (token === null || token === '') {
    nextTokens.delete(id)
    nextTokenBindings.delete(id)
  } else {
    nextTokens.set(id, token)
    if (binding === null) nextTokenBindings.delete(id)
    else nextTokenBindings.set(id, binding)
  }
  if (password === null || password === '') {
    nextPasswords.delete(id)
    nextPasswordBindings.delete(id)
  } else {
    nextPasswords.set(id, password)
    if (binding === null) nextPasswordBindings.delete(id)
    else nextPasswordBindings.set(id, binding)
  }
  persistGatewaySecrets(nextTokens, nextPasswords, nextTokenBindings, nextPasswordBindings)
  commitGatewaySecrets(nextTokens, nextPasswords, nextTokenBindings, nextPasswordBindings)
}

/** The stored token for one instance, or null. */
export function getGatewayToken(id: string): string | null {
  const token = tokens.get(id)
  if (token === undefined) return null
  const binding = tokenBindings.get(id)
  if (binding === undefined) return secretFile === null ? token : null
  const current = secretSpecResolver?.(id) ?? null
  return current !== null && gatewayCredentialBinding(current) === binding ? token : null
}

/** The stored login password for one instance, or null. */
export function getGatewayPassword(id: string): string | null {
  const password = passwords.get(id)
  if (password === undefined) return null
  const binding = passwordBindings.get(id)
  if (binding === undefined) return secretFile === null ? password : null
  const current = secretSpecResolver?.(id) ?? null
  return current !== null && gatewayCredentialBinding(current) === binding ? password : null
}

function commitGatewaySecrets(
  nextTokens: ReadonlyMap<string, string>,
  nextPasswords: ReadonlyMap<string, string>,
  nextTokenBindings: ReadonlyMap<string, string>,
  nextPasswordBindings: ReadonlyMap<string, string>,
): void {
  tokens.clear()
  for (const [entryId, entryToken] of nextTokens) tokens.set(entryId, entryToken)
  passwords.clear()
  for (const [entryId, entryPassword] of nextPasswords) passwords.set(entryId, entryPassword)
  tokenBindings.clear()
  for (const [entryId, binding] of nextTokenBindings) tokenBindings.set(entryId, binding)
  passwordBindings.clear()
  for (const [entryId, binding] of nextPasswordBindings) passwordBindings.set(entryId, binding)
}

/** Mirror the in-memory maps to the durable file (schemaVersion 3, 0600, atomic — random
 *  O_EXCL tmp with explicit mode 0600 → fsync → rename → parent fsync; a planted symlink /
 *  multi-link leaf is refused fail-closed). The file-level storage discriminator is written
 *  in the same atomic payload as the values, so a later startup never infers ciphertext. */
function persistGatewaySecrets(
  nextTokens: ReadonlyMap<string, string>,
  nextPasswords: ReadonlyMap<string, string>,
  nextTokenBindings: ReadonlyMap<string, string>,
  nextPasswordBindings: ReadonlyMap<string, string>,
): void {
  if (secretFile === null) return
  const storage: GatewaySecretFileStorage = secretCrypto.isAvailable() ? 'safeStorage' : 'plaintext'
  const encode = (value: string): string => storage === 'safeStorage' ? secretCrypto.encrypt(value) : value
  const payload = `${JSON.stringify({
    schemaVersion: 3,
    storage,
    tokens: Object.fromEntries([...nextTokens].map(([id, value]) => [id, encode(value)])),
    passwords: Object.fromEntries([...nextPasswords].map(([id, value]) => [id, encode(value)])),
    tokenBindings: Object.fromEntries(nextTokenBindings),
    passwordBindings: Object.fromEntries(nextPasswordBindings),
  }, undefined, 2)}\n`
  ensurePrivateDirectoryNoFollow(dirname(secretFile), 0o700)
  atomicWritePrivateFileNoFollow(secretFile, payload, { mode: 0o600 })
  durableSecretStorage = storage
}

// Password-login session hooks (design 17 §7.3/§9.3): the provider does NOT own the
// login exchange — the shell composes the gateway-session manager onto it via
// configureGatewaySessionProvider. verifyUp consults the hooks for password-configured
// targets: ensure a session, probe WITH its Cookie, and on a 401 invalidate + re-login
// once before reporting the terminal password-refused state. Default = no hooks (the
// flow is INERT); partial hooks are rejected at configuration.

/** The session hooks surface mirrors GatewaySessionManager; an empty object disables
 *  password-session integration and any active configuration must provide the full set. */
export interface GatewaySessionProviderHooks {
  /** POST /auth/login with the stored password; resolves the header-ready cookie or a classified failure. */
  ensureSession?(origin: GatewaySessionOrigin, password: string): Promise<GatewaySessionResult>
  /** Exact-key invalidation generation: when supplied, the verifier fences every
   *  post-await network step so a cleared generation cannot use its captured credential. */
  generation?(origin: GatewaySessionOrigin): number
  registrationAuthProof?(origin: GatewaySessionOrigin): GatewayRegistrationAuthProof | null
  setRegistrationAuthProof?(origin: GatewaySessionOrigin, proof: GatewayRegistrationAuthProof | null): void
  /** The cached header-ready cookie for the origin, or null (synchronous fast path). */
  cachedCookie?(origin: GatewaySessionOrigin): string | null
  /** Drop the cached session (called after a cookie-401 probe rejection). */
  invalidate?(origin: GatewaySessionOrigin): void
}

/** The active hooks; default = none (the password flow is inert). */
let sessionHooks: GatewaySessionProviderHooks = {}

/** Wire the shell's gateway-session manager onto the provider; an empty argument disables the flow. */
export function configureGatewaySessionProvider(hooks: GatewaySessionProviderHooks): void {
  const candidate = hooks ?? {}
  const methods: Array<keyof GatewaySessionProviderHooks> = [
    'ensureSession',
    'generation',
    'registrationAuthProof',
    'setRegistrationAuthProof',
    'cachedCookie',
    'invalidate',
  ]
  const present = methods.filter(method => typeof candidate[method] === 'function')
  if (present.length !== 0 && present.length !== methods.length) {
    throw new TypeError('gateway session provider hooks must be configured all-or-none')
  }
  sessionHooks = candidate
}

/** Read access to the active hooks: the ssh provider's tunnel branch consults the SAME
 *  hooks, so the gateway-over-ssh password flow can never drift from direct-endpoint. */
export function getGatewaySessionHooks(): GatewaySessionProviderHooks {
  return sessionHooks
}

/** The credential mirror's ACTUAL durable storage mode (design 17 §13.4.1 / S22): never
 *  claims safeStorage merely because the adapter is available — a plaintext mirror stays
 *  visibly plaintext until its atomic encryption upgrade succeeds. Non-secret projection. */
export function gatewaySecretStorageMode(): 'safeStorage' | 'plaintext' {
  return durableSecretStorage
}


// Gateway endpoint identity verification (design 17 §7): a gateway transport is serviceable
// when its authenticated, gateway-owned runtime controller answers, independently of the
// managed dsh lifecycle — /chamber/runtime stays reachable for recovery while dsh is
// blocked/down. (dsh×http is disabled; a plain dsh target's only transport is ssh, whose
// provider owns the dsh host-identity handshake.)

export const GATEWAY_RUNTIME_IDENTITY = 'dsh-chamber-gateway-runtime'

export function isGatewayRuntimeStatus(value: unknown): value is { kind: typeof GATEWAY_RUNTIME_IDENTITY } {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === GATEWAY_RUNTIME_IDENTITY
}

/**
 * GET /chamber/runtime/status and require the gateway runtime identity marker. The route
 * stays mounted while managed dsh is stopped/blocked, so recovery stays reachable. A null
 * token means a NO-CREDENTIAL probe (no Authorization header, design 17 §2.3/§9.3): a
 * `--no-auth` deployment answers 200 and is ready; an auth-requiring one or a wrong token
 * answers 401, classified TERMINAL, with the message split so the two are not conflated;
 * a rejected session cookie is the terminal password-refused state. `statusCode` rides the
 * result so the caller can act on the raw 401; connection failures stay transient. A
 * configured SPKI pin (https only) makes a mismatching peer terminal.
 */
export interface GatewayIdentityProbeOptions {
  host: string
  port: number
  token: string | null
  /** http(s) scheme selection (design 17 §9.1 `insecureHttp` origin). */
  insecure: boolean
  timeoutMs: number
  maxBodyBytes: number
  cookie: string | null
  /** Tunnel Host-header override (design 17 §9.3): CONNECT to the loopback tunnel
   *  endpoint but present the REMOTE gateway authority (the tunnel port fails its policy). */
  authority?: string
  /** SPKI trust anchor (S23) — https only; http + pin is refused by validateSpec. */
  spkiPin?: string | null
  /** Carry `statusCode` on 403/non-200 results; 401 always carries it (the verifyUp flow keys on it). */
  carryStatusCodes?: boolean
}

/** The single gateway runtime-identity probe core shared by the direct-http provider
 *  and the ssh tunnel branch: both probe the SAME /chamber/runtime/status contract, so a
 *  fix on one side can never drift from the other. */
export async function verifyGatewayRuntimeIdentity(
  options: GatewayIdentityProbeOptions,
): Promise<TransportVerifyResult & { statusCode?: number }> {
  const {
    host, port, token, insecure, timeoutMs, maxBodyBytes, cookie,
    authority, spkiPin, carryStatusCodes = false,
  } = options
  const pin = spkiPin ?? null
  const headers: Record<string, string> = {}
  if (authority !== undefined) headers.host = authority
  // No credentials → NO Authorization header on the probe (design 17 §2.3): the gateway itself is the auth authority.
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (cookie !== null) headers.cookie = cookie
  const url = `${insecure ? 'http' : 'https'}://${host}:${port}/chamber/runtime/status`
  // The bounded request mechanics (including the S23 pre-write SPKI dispatch gate)
  // live in gateway-http-core.ts; this core keeps the CLASSIFICATION both callers share.
  const outcome = await boundedGatewayRequest(url, {
    method: 'GET',
    headers,
    insecure,
    spkiPin: pin,
    timeoutMs,
    maxBodyBytes,
    // 401/403/non-200 classification keys on the status alone: settle from the status line and drain the body.
    readBodyForStatus: status => status === 200,
    // A probe never reused a keep-alive socket: destroy the request once settled.
    destroyOnSettle: true,
  })
  if (outcome.kind === 'oversize') {
    return { ok: false, detail: 'the gateway answered an oversized runtime identity response', terminal: true }
  }
  if (outcome.kind === 'network') {
    if (outcome.spkiMismatch) {
      return { ok: false, detail: '证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误', terminal: true }
    }
    if (outcome.timedOut) {
      return { ok: false, detail: `the gateway did not answer the runtime identity probe within ${timeoutMs}ms` }
    }
    return { ok: false, detail: 'the gateway did not answer the runtime identity probe' }
  }
  const statusCode = outcome.status
  // 401 = auth required/rejected; 403 = an origin/Host policy rejection (design 17 §7.3:
  // Host→421, Origin→403). Split the guidance so a missing-token probe, a policy
  // misconfiguration and a session-cookie rejection are not conflated.
  if (statusCode === 401) {
    const detail = cookie !== null
      ? 'the gateway rejected the password authentication (401) — re-enter the password'
      : token === null
        ? 'the gateway requires authentication (401) — configure the shared token or password'
        : 'the gateway rejected the token (401) — check the shared token'
    return { ok: false, detail, terminal: true, statusCode: 401 }
  }
  if (statusCode === 403) {
    const detail = 'the gateway refused the request origin/Host policy (403) — check the gateway deployment origin settings'
    return carryStatusCodes
      ? { ok: false, detail, terminal: true, statusCode: 403 }
      : { ok: false, detail, terminal: true }
  }
  if (statusCode !== 200) {
    // Authentication and deterministic client/protocol mistakes require user action;
    // every 5xx is time-dependent and stays transient for the bounded retry machinery.
    const terminal = gatewayHttpFailureIsTerminal(statusCode)
    const detail = `the gateway answered HTTP ${statusCode} to the runtime identity probe`
    return carryStatusCodes
      ? { ok: false, detail, terminal, statusCode }
      : { ok: false, detail, terminal }
  }
  if (!isGatewayRuntimeStatus(outcome.payload)) {
    return { ok: false, detail: 'the gateway answered an unexpected runtime identity response — it does not appear to be a compatible dsh-chamber gateway', terminal: true }
  }
  // A SUCCESS is the pure {ok:true} shape: `statusCode` rides only a real answer, so the
  // ok form never carries a stray statusCode:undefined key that deep compares trip on.
  return { ok: true }
}

/** Direct-endpoint wrapper (design 17 §2): https by default, http when `insecure`;
 *  optional SPKI pin; `statusCode` on the raw 401 only. */
function verifyGatewayEndpoint(
  host: string,
  port: number,
  token: string | null,
  insecure: boolean,
  timeoutMs = GATEWAY_VERIFY_TIMEOUT_MS,
  maxBodyBytes = GATEWAY_VERIFY_MAX_BODY_BYTES,
  cookie: string | null = null,
  spkiPin: string | null = null,
): Promise<TransportVerifyResult & { statusCode?: number }> {
  return verifyGatewayRuntimeIdentity({ host, port, token, insecure, timeoutMs, maxBodyBytes, cookie, spkiPin })
}

/**
 * Instance spec validation: id (runtime whitelist) + label + host (gateway hostname
 * whitelist) + remotePort (1..65535). No token here — the token is held in the token
 * store, never in the spec/registry; user/sshPort/serviceName/remoteDshHome are
 * accepted-but-ignored so the registry shape stays uniform. v2: this is the `http`
 * TRANSPORT provider for the shipped kinds (`dsh` | `gateway`), gated on
 * `transport === 'http'`; a transport 'ssh' spec is REFUSED (mis-serving it as a direct
 * endpoint would bypass the tunnel), and a missing transport is inferred from kind
 * (gateway→http; anything else is not ours). `insecureHttp` defaults false (https).
 */
function isValidGatewayInstance(instance: unknown): instance is TransportInstanceSpec {
  if (instance === null || typeof instance !== 'object') return false
  const record = instance as Record<string, unknown>
  // v2 kind gating: this provider serves the shipped target kinds; a missing kind
  // defaults to {dsh, ssh} (registry migration) and is not ours. A future kind must
  // register its own provider rather than reach ready here and fail later at proxy registration.
  if (record.kind !== 'dsh' && record.kind !== 'gateway') return false
  const transport = record.transport
  if (transport !== undefined && transport !== null && transport !== 'http') return false
  if ((transport === undefined || transport === null) && record.kind !== 'gateway') return false
  return typeof record.id === 'string' && INSTANCE_ID_PATTERN.test(record.id)
    && typeof record.label === 'string' && record.label.length >= 1 && record.label.length <= MAX_INSTANCE_LABEL_CHARS
    && typeof record.host === 'string' && record.host.length <= MAX_GATEWAY_HOST_CHARS && GATEWAY_HOST_PATTERN.test(record.host)
    && typeof record.remotePort === 'number' && Number.isInteger(record.remotePort)
    && record.remotePort >= 1 && record.remotePort <= 65535
    && (record.insecureHttp === undefined || record.insecureHttp === null || typeof record.insecureHttp === 'boolean')
    // S23: the pin must be 64-hex sha256, the target https AND the kind 'gateway' — a
    // non-gateway kind over https would HALF-execute (probe pins, proxy refuses), so the
    // pin is refused outright instead of claiming protection that never happens.
    && (record.spkiPin === undefined || record.spkiPin === null
      || (typeof record.spkiPin === 'string' && SPKI_PIN_PATTERN.test(record.spkiPin)
        && record.insecureHttp !== true && record.kind === 'gateway'))
}

/** The gateway-session origin for a spec — the http(s) origin the transport proxies to,
 *  used as the session manager's per-origin cache key (scheme from `insecureHttp`,
 *  explicit port so it matches the registration baseUrl). The spec's SPKI pin (S23) rides
 *  the origin so password LOGIN is pinned exactly like the identity probe. */
function gatewaySessionOriginFor(spec: TransportInstanceSpec): GatewaySessionOrigin {
  return buildGatewaySessionOrigin({
    baseUrl: `${spec.insecureHttp ? 'http' : 'https'}://${spec.host}:${spec.remotePort}`,
    insecureHttp: spec.insecureHttp,
    scope: gatewaySessionScopeForConnection(spec),
    spkiPin: spec.spkiPin,
  })
}

/** Map a login-exchange failure onto the probe verdict (design 17 §7.3): a refused
 *  password and 'other' protocol answers are terminal; rate_limited/auth_busy/network transient. */
function gatewaySessionFailureToVerify(result: Extract<GatewaySessionResult, { ok: false }>): TransportVerifyResult {
  if (result.code === 'invalid_credentials' || result.code === 'other') {
    return { ok: false, detail: result.error, terminal: true }
  }
  return { ok: false, detail: result.error }
}

function gatewaySessionSuperseded(): TransportVerifyResult {
  return { ok: false, detail: 'gateway session verification superseded by connection invalidation' }
}

/**
 * SHARED password-session verifyUp flow (design 17 §7.3/§9.3): ensure a login session
 * exists and probe WITH its Cookie. Fast path: a live cached session (12h − 5min) probes
 * directly, so reconnect cycles never re-login. A probe 401 (the cookie was refused/
 * revoked server-side) invalidates the session and re-logs in ONCE with the stored
 * password; a rate-limited/busy/network re-login stays transient, and a fresh session
 * landing on 401 again is the terminal password-refused state. `probe` is the only
 * transport-specific part, so the two transport shapes can never drift.
 */
export async function verifyGatewayPasswordSession(
  origin: GatewaySessionOrigin,
  password: string,
  probe: (cookie: string | null) => Promise<TransportVerifyResult & { statusCode?: number }>,
  fallbackProbe?: () => Promise<TransportVerifyResult & { statusCode?: number }>,
): Promise<TransportVerifyResult> {
  sessionHooks.setRegistrationAuthProof?.(origin, null)
  let generation = sessionHooks.generation?.(origin)
  const generationIsCurrent = (): boolean => generation === undefined
    || sessionHooks.generation?.(origin) === generation
  const verifiedCookieIsCurrent = (cookie: string): boolean => generation === undefined
    || (generationIsCurrent() && sessionHooks.cachedCookie?.(origin) === cookie)
  const adoptCurrentGeneration = (): void => {
    generation = sessionHooks.generation?.(origin)
  }
  const cached = sessionHooks.cachedCookie !== undefined ? sessionHooks.cachedCookie(origin) : null
  let cookie: string
  if (cached !== null) {
    cookie = cached
  } else {
    const login = await sessionHooks.ensureSession!(origin, password)
    if (!generationIsCurrent() || (!login.ok && login.code === 'stale')) {
      return gatewaySessionSuperseded()
    }
    if (!login.ok) {
      // Token and password are independent OR-principals (design 17 §2.3): when both are
      // configured, a refused password login must not hide a still-valid bearer. The
      // fallback carries ONLY the bearer; a failed bearer does not replace the password
      // flow's more actionable classification.
      if (fallbackProbe !== undefined) {
        if (!generationIsCurrent()) return gatewaySessionSuperseded()
        const fallback = await fallbackProbe()
        if (!generationIsCurrent()) return gatewaySessionSuperseded()
        if (fallback.ok) {
          sessionHooks.setRegistrationAuthProof?.(origin, 'bearer')
          return fallback
        }
      }
      return gatewaySessionFailureToVerify(login)
    }
    cookie = login.cookie
  }
  if (!generationIsCurrent()) return gatewaySessionSuperseded()
  const first = await probe(cookie)
  if (!generationIsCurrent()) return gatewaySessionSuperseded()
  if (first.ok && !verifiedCookieIsCurrent(cookie)) return gatewaySessionSuperseded()
  if (first.ok) sessionHooks.setRegistrationAuthProof?.(origin, 'cookie')
  if (first.ok || first.statusCode !== 401) return first
  // 401 with the session cookie: invalidate, then ONE automatic re-login with the stored
  // password (design 17 §9.3); a refused re-login classifies as terminal or transient.
  sessionHooks.invalidate?.(origin)
  // This invalidation is owned by the current verifier, so its one allowed re-login adopts
  // the new generation; a later external invalidation trips the same post-await fences.
  adoptCurrentGeneration()
  if (!generationIsCurrent()) return gatewaySessionSuperseded()
  const relogin = await sessionHooks.ensureSession!(origin, password)
  if (!generationIsCurrent() || (!relogin.ok && relogin.code === 'stale')) {
    return gatewaySessionSuperseded()
  }
  if (!relogin.ok) return gatewaySessionFailureToVerify(relogin)
  if (!generationIsCurrent()) return gatewaySessionSuperseded()
  const reprobe = await probe(relogin.cookie)
  if (!generationIsCurrent()) return gatewaySessionSuperseded()
  if (reprobe.ok && !verifiedCookieIsCurrent(relogin.cookie)) return gatewaySessionSuperseded()
  if (reprobe.ok) sessionHooks.setRegistrationAuthProof?.(origin, 'cookie')
  if (reprobe.ok || reprobe.statusCode !== 401) return reprobe
  // Even the freshly minted session is refused — the stored password cannot authenticate this deployment.
  sessionHooks.invalidate?.(origin)
  return { ok: false, detail: 'the gateway rejected the password authentication (401) — re-enter the password', terminal: true }
}

/** The http transport provider: validate → direct-endpoint (no child) →
 * http(s) probe. Serves the GATEWAY target only — the dsh×http combination
 * is disabled: direct-attaching a dsh web profile
 * over http is hard-blocked on the 0.1.2 line (its host answers 401 without
 * the spawn-time browser-auth launch token, which is unrecoverable remotely;
 * see the connection-form schema comment for the re-enable point). ssh is
 * the only dsh transport. `kind` is the target dimension of a spec; provider
 * lookup is transport-keyed only (main.ts `providers: { http: … }`). */
export const gatewayProvider: TransportProvider = {
  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (!isValidGatewayInstance(input)) return null
    const record = input as unknown as Record<string, unknown>
    // dsh×http disabled: refuse at the registry mutation point so the combination can
    // never be created behind the UI (load drops legacy rows the same way).
    if (record.kind !== 'gateway') return null
    return {
      id: record.id as string,
      label: record.label as string,
      kind: record.kind as TransportKind,
      transport: 'http',
      host: record.host as string,
      user: null,
      sshPort: null,
      remotePort: record.remotePort as number,
      serviceName: null,
      remoteDshHome: null,
      insecureHttp: record.insecureHttp === true,
      ...(record.spkiPin === undefined || record.spkiPin === null ? {} : { spkiPin: record.spkiPin as string }),
    }
  },

  /** DIRECT ENDPOINT mode (design 05 §7.6): the method is ABSENT (not returning null), so
   *  the transport-manager never allocates a throwaway 127.0.0.1 port for a provider with no child. */

  /** The probe target is the gateway host:port. The IPv6 literal is unbracketed here —
   *  net.connect takes `::1`, not `[::1]` (brackets are URL syntax only). */
  probeTarget(spec: TransportInstanceSpec): { host: string; port: number } {
    return { host: spec.host.replace(/^\[(.*)\]$/, '$1'), port: spec.remotePort }
  },

  /** Ready URL: the target http(s) origin (design 17 §9.1/§13.1 — https default,
   *  plaintext only when `insecureHttp` was set; default ports 80/443 are elided). */
  endpointUrl(spec: TransportInstanceSpec): string | null {
    if (spec.insecureHttp) {
      return spec.remotePort === DEFAULT_GATEWAY_HTTP_PORT
        ? `http://${spec.host}`
        : `http://${spec.host}:${spec.remotePort}`
    }
    return spec.remotePort === DEFAULT_GATEWAY_PORT
      ? `https://${spec.host}`
      : `https://${spec.host}:${spec.remotePort}`
  },

  /** Identity verification: the gateway target must answer the authenticated,
   *  gateway-owned runtime status identity (available while managed dsh is blocked).
   *  A missing token is NOT a pre-flight refusal (design 17 §2.3): the probe goes out
   *  WITHOUT an Authorization header and the gateway's own answer is classified; a
   *  configured token rides as Bearer and a configured password as the session Cookie
   *  (both independent, either principal accepted). Uses spec.host (BRACKETED IPv6 —
   *  URL form), NOT endpoint.host (unbracketed for net.connect). */
  verifyUp(spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint): Promise<TransportVerifyResult> {
    void endpoint
    const password = getGatewayPassword(spec.id)
    // A configured password + wired session hooks: share verifyGatewayPasswordSession
    // with the ssh tunnel branch (design 17 §9.2/§9.3). The Bearer is read live at every
    // network exchange (a credential rotated inside a verify cycle takes effect), with at
    // most one fallback per cycle and generation fences re-checked after each await;
    // a cleared token yields a non-ok result, never a credential-free probe taken as success.
    // Without hooks the probe stays credential-free (main.ts has not wired the manager).
    if (password !== null && sessionHooks.ensureSession !== undefined) {
      return verifyGatewayPasswordSession(
        gatewaySessionOriginFor(spec),
        password,
        cookie => {
          const token = getGatewayToken(spec.id)
          return verifyGatewayEndpoint(spec.host, spec.remotePort, token, spec.insecureHttp, GATEWAY_VERIFY_TIMEOUT_MS, GATEWAY_VERIFY_MAX_BODY_BYTES, cookie, spec.spkiPin ?? null)
        },
        () => {
          const token = getGatewayToken(spec.id)
          if (token === null) {
            return Promise.resolve({ ok: false, detail: 'no gateway bearer token configured', terminal: false })
          }
          return verifyGatewayEndpoint(spec.host, spec.remotePort, token, spec.insecureHttp, GATEWAY_VERIFY_TIMEOUT_MS, GATEWAY_VERIFY_MAX_BODY_BYTES, null, spec.spkiPin ?? null)
        },
      )
    }
    // 无会话钩子（无密码 / 未接线）：同样在使用点实时读 token。
    return verifyGatewayEndpoint(spec.host, spec.remotePort, getGatewayToken(spec.id), spec.insecureHttp, GATEWAY_VERIFY_TIMEOUT_MS, GATEWAY_VERIFY_MAX_BODY_BYTES, null, spec.spkiPin ?? null)
  },

  /** No child process → no stderr stream: a safe no-op classification for the interface. */
  classifyStderr(): { log: string; terminalAuth: boolean; enoent: boolean } {
    return { log: '', terminalAuth: false, enoent: false }
  },
}

// Desktop-synced chamber host packages (design 17 §9.3): the gateway does not ship them;
// a connecting desktop uploads its own copies through the authenticated
// `PUT /chamber/plugins` surface. Best-effort and idempotent — matching versions are
// skipped and byte-identical uploads answer 200 {changed:false}; a real change asks for
// the gateway's controlled dsh restart (a failed restart only warns — the next natural
// spawn re-seeds). Version-lock: a rebuilt package must bump its version to re-sync.
// Requests ride the REGISTERED transport origin with the tunnel authority Host override.

/** One local chamber host package ready to sync (main-process files). */
export interface LocalChamberHostPackage {
  name: string
  packageJson: string
  distIndex: string
}

/**
 * Where each declared seed file's bytes live in the source shape above, keyed by the
 * SHARED seed file set (control-plane `HOST_PACKAGE_SEED_FILES`), so a file added or
 * removed there is a compile error instead of a PUT payload that silently omits it.
 */
const SYNC_UPLOAD_BYTES: Record<HostPackageSeedFile, (pkg: LocalChamberHostPackage) => string> = {
  'package.json': pkg => pkg.packageJson,
  'dist/index.js': pkg => pkg.distIndex,
}

/** The `files` record of one `PUT /chamber/plugins` upload: every declared seed file
 *  keyed by package-relative path, built BY ITERATING the shared set and failing loud for
 *  a declared file this build has no local byte source for. */
export function syncedPluginUploadFiles(pkg: LocalChamberHostPackage): Record<string, string> {
  const files: Record<string, string> = {}
  for (const relative of HOST_PACKAGE_SEED_FILES) {
    const resolve = SYNC_UPLOAD_BYTES[relative] as ((pkg: LocalChamberHostPackage) => string) | undefined
    const bytes = resolve?.(pkg)
    if (typeof bytes !== 'string') {
      throw new Error(`gateway plugin sync: no local byte source for seed file ${JSON.stringify(relative)}`)
    }
    files[relative] = bytes
  }
  return files
}

export interface GatewayPluginSyncResult {
  /** True when at least one package was uploaded (a dsh restart was asked). */
  uploaded: boolean
  /** True when the sync was skipped (no local packages to sync). */
  skipped: boolean
  /** Honesty marker: true when the sync did NOT complete (non-200 or network failure),
   *  so a failure never projects as "already up to date"; the auto path ignores it. */
  failed?: boolean
  /** First failure detail when failed (already sanitized for IPC). */
  error?: string
}

/** Response bound for the plugin-sync exchanges (one value shared by both adapters). */
const GATEWAY_PLUGIN_RESPONSE_MAX_BODY_BYTES = 8 * 1024 * 1024

/** Bounded JSON request to a gateway endpoint with the S23 pin discipline; a thin adapter
 *  over gateway-http-core.ts whose oversize/transport failures keep the reject semantics. */
async function gatewayJsonRequest(
  url: string,
  options: {
    method: 'GET' | 'PUT' | 'POST'
    headers: Record<string, string>
    body?: unknown
    insecure: boolean
    spkiPin: string | null
    timeoutMs: number
  },
): Promise<{ status: number; payload: unknown }> {
  const outcome = await boundedGatewayRequest(url, {
    method: options.method,
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: options.body,
    insecure: options.insecure,
    spkiPin: options.spkiPin,
    timeoutMs: options.timeoutMs,
    maxBodyBytes: GATEWAY_PLUGIN_RESPONSE_MAX_BODY_BYTES,
    timeoutMessage: 'gateway plugin sync timed out',
  })
  if (outcome.kind === 'response') return { status: outcome.status, payload: outcome.payload }
  throw outcome.kind === 'oversize'
    ? new Error('gateway plugin sync response exceeds the size bound')
    : outcome.error
}

/** Sync the local chamber host packages into the gateway seed cache. */
export async function syncGatewayChamberPlugins(options: {
  /** Registered transport origin (the ready URL). For an ssh tunnel this is the loopback
   *  endpoint the user actually verified — never the remote host:port. */
  origin: string
  /** Tunnel Host-header override: the REMOTE gateway authority (its policy requires the
   *  authority port to equal its listen port); undefined for direct http(s) targets. */
  authority?: string
  /** Registration auth headers — main-process only. May be EMPTY: a `--no-auth`
   *  deployment registers headerless and the sync must still run (401 → warn). */
  headers: Record<string, string>
  spkiPin: string | null
  packages: LocalChamberHostPackage[]
  logger: { warn(message: string): void; log(message: string): void }
  timeoutMs?: number
}): Promise<GatewayPluginSyncResult> {
  const timeoutMs = options.timeoutMs ?? 10_000
  if (options.packages.length === 0) return { uploaded: false, skipped: true }
  let firstFailure: string | null = null
  const origin = options.origin
  const insecure = !origin.startsWith('https://')
  const requestHeaders = { ...options.headers }
  // Tunnel Host override (design 17 §9.3): CONNECT to the loopback endpoint but present
  // the REMOTE authority — the tunnel's local port can never satisfy the gateway policy.
  if (options.authority !== undefined) requestHeaders.host = options.authority

  try {
    const status = await gatewayJsonRequest(`${origin}/chamber/plugins`, {
      method: 'GET',
      headers: requestHeaders,
      insecure,
      spkiPin: options.spkiPin,
      timeoutMs,
    })
    if (status.status !== 200) {
      options.logger.warn(`[dsh-chamber] gateway plugin sync: status projection failed (HTTP ${status.status}); skipped`)
      return { uploaded: false, skipped: false, failed: true, error: `gateway plugin status projection failed (HTTP ${status.status})` }
    }
    const rows = (status.payload as { items?: Array<{ name?: unknown; version?: unknown }> })?.items ?? []
    const cached = new Map(rows
      .filter(row => typeof row?.name === 'string' && typeof row?.version === 'string')
      .map(row => [row.name as string, row.version as string]))

    let uploaded = false
    for (const pkg of options.packages) {
      let localVersion: string | null = null
      try {
        const parsed = JSON.parse(pkg.packageJson) as { version?: unknown }
        localVersion = typeof parsed?.version === 'string' ? parsed.version : null
      } catch {
        options.logger.warn(`[dsh-chamber] gateway plugin sync: local ${pkg.name} package.json is unreadable; skipped`)
        continue
      }
      if (localVersion === null) {
        options.logger.warn(`[dsh-chamber] gateway plugin sync: local ${pkg.name} package.json has no string version; skipped`)
        continue
      }
      if (cached.get(pkg.name) === localVersion) continue
      const put = await gatewayJsonRequest(`${origin}/chamber/plugins`, {
        method: 'PUT',
        headers: requestHeaders,
        body: { name: pkg.name, files: syncedPluginUploadFiles(pkg) },
        insecure,
        spkiPin: options.spkiPin,
        timeoutMs,
      })
      if (put.status !== 200) {
        // Carry the gateway's own refusal reason when it sent one (a bare "HTTP 400"
        // leaves no remediation); it is re-sanitized before reaching any renderer.
        const refused = put.payload as { error?: unknown } | null
        const reason = refused !== null && typeof refused.error === 'string' && refused.error !== ''
          ? sanitizeErrorText(refused.error).slice(0, 300)
          : null
        const failure = `uploading ${pkg.name} failed (HTTP ${put.status}${reason === null ? '' : `: ${reason}`})`
        options.logger.warn(`[dsh-chamber] gateway plugin sync: ${failure}; the managed dsh keeps running without it`)
        if (firstFailure === null) firstFailure = failure
        continue
      }
      // Byte-identical upload → nothing to apply; only an actual cache change warrants a restart.
      if ((put.payload as { changed?: unknown })?.changed !== true) continue
      uploaded = true
      options.logger.log(`[dsh-chamber] gateway plugin sync: uploaded ${pkg.name} v${localVersion}`)
    }
    if (uploaded) {
      // The running profile picks the packages up only on the next spawn — ask for the
      // controlled restart; a failure only warns (the next natural spawn re-seeds anyway).
      try {
        const restart = await gatewayJsonRequest(`${origin}/chamber/runtime/restart`, {
          method: 'POST',
          headers: requestHeaders,
          insecure,
          spkiPin: options.spkiPin,
          timeoutMs,
        })
        if (restart.status !== 202 && restart.status !== 200) {
          options.logger.warn(`[dsh-chamber] gateway plugin sync: dsh restart after upload returned HTTP ${restart.status}; packages apply on the next natural spawn`)
        }
      } catch (error) {
        options.logger.warn(`[dsh-chamber] gateway plugin sync: dsh restart after upload failed: ${describeError(error)}`)
      }
    }
    if (firstFailure !== null) {
      return { uploaded, skipped: false, failed: true, error: firstFailure }
    }
    return { uploaded, skipped: false }
  } catch (error) {
    options.logger.warn(`[dsh-chamber] gateway plugin sync failed: ${describeError(error)}`)
    return {
      uploaded: false,
      skipped: false,
      failed: true,
      error: `gateway plugin sync failed: ${sanitizeErrorText(describeError(error))}`,
    }
  }
}

// Gateway plugin batch apply + folder materialize (design 21 §6.5): the
// /chamber/plugins write surface is 202-async — every submission is accepted onto the
// gateway's serial executor queue (opId) or persisted as a deferred intent (executed
// at the next ready edge). The batch submits removes first, then add specs (decision 5
// 先 remove 后 add), aborting at the FIRST refusal with the honest partial outcome;
// unless deferRestart it waits for its ops to terminate (a restart is REFUSED while an
// executor lease is held), then asks the controlled restart and polls the runtime
// status; post-acceptance failures carry the partial outcome. Materialize uploads a
// desktop-built tgz with x-plugin-name/x-plugin-version and maps the 202/400/409/411/
// 413/500 family honestly. All requests ride the REGISTERED origin + auth headers +
// SPKI pin; never a renderer-supplied URL or credential.

/** Batch apply request/option surface (main.ts maps the IPC payload here). */
export interface GatewayPluginApplyOptions {
  /** Registry specs (`name@spec` | `name`; `file:` refused — folder pushes go through materialize). */
  add: string[]
  /** Installed-list names to remove (never deferred by the gateway). */
  remove: string[]
  /** true = only record the change; restart-to-apply is skipped (applies on the next dsh restart). */
  deferRestart?: boolean
}

export interface GatewayPluginApplyOutcome {
  /** Names whose submission the executor ACCEPTED (202 + opId); accepted ≠ terminally
   *  completed — a later executor failure surfaces in the batch error. */
  installed: string[]
  removed: string[]
  /** true only after a restart 202 AND the status poll confirmed the managed dsh settled
   *  (restart ok, or ready/degraded on legacy gateways without the outcome field). */
  restarted: boolean
  /** Names persisted as a DEFERRED install intent (202 + intentId): executed at the next
   *  ready edge, restart included; never counted as installed here. */
  deferredOps: string[]
}

export type GatewayChamberApplyBatchResult =
  | { ok: true; outcome: GatewayPluginApplyOutcome }
  | { ok: false; error: string; outcome?: GatewayPluginApplyOutcome }

/** Per-request timeout of the apply/materialize HTTP calls. */
export const GATEWAY_APPLY_REQUEST_TIMEOUT_MS = 15_000
/** Executor-settle poll budget: 1s × 120. */
export const GATEWAY_APPLY_OP_SETTLE_TIMEOUT_MS = 120_000
/** Restart readiness poll budget: 1s × 120. */
export const GATEWAY_APPLY_RESTART_POLL_TIMEOUT_MS = 120_000
/** Poll interval shared by the settle + restart loops. */
export const GATEWAY_APPLY_POLL_INTERVAL_MS = 1_000
/** Materialize upload request timeout (a 32 MiB body over a tunnel). */
export const GATEWAY_MATERIALIZE_TIMEOUT_MS = 60_000

export async function gatewayChamberApplyBatch(params: {
  /** Instance id (caller-validated). */
  id: string
  /** Registered transport origin (the ready URL; tunnel loopback for ssh). */
  url: string
  /** Registration auth headers — main-process only, may be empty (a --no-auth deployment). */
  headers: Record<string, string>
  /** Registered SPKI pin; null = unpinned. */
  spkiPin: string | null
  options: GatewayPluginApplyOptions
  /** Tunnel Host-header override (the REMOTE gateway authority). */
  authority?: string
  signal?: AbortSignal
  requestTimeoutMs?: number
  settleIntervalMs?: number
  settleTimeoutMs?: number
  restartPollIntervalMs?: number
  restartPollTimeoutMs?: number
}): Promise<GatewayChamberApplyBatchResult> {
  const { url } = params
  const timeoutMs = params.requestTimeoutMs ?? GATEWAY_APPLY_REQUEST_TIMEOUT_MS
  const insecure = !url.startsWith('https://')
  const requestHeaders = { ...params.headers }
  if (params.authority !== undefined) requestHeaders.host = params.authority
  const request = (
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; payload: unknown }> => gatewayJsonRequest(`${url}${path}`, {
    method,
    headers: requestHeaders,
    body,
    insecure,
    spkiPin: params.spkiPin,
    timeoutMs,
  })

  const outcome: GatewayPluginApplyOutcome = { installed: [], removed: [], restarted: false, deferredOps: [] }
  const opIds: string[] = []
  const add = Array.isArray(params.options.add) ? params.options.add : []
  const remove = Array.isArray(params.options.remove) ? params.options.remove : []
  const deferRestart = params.options.deferRestart === true

  // Pre-validate the WHOLE batch before any submission: a malformed item is a client mistake.
  for (const spec of add) {
    if (parseSpecArg(spec) === null) return { ok: false, error: `invalid add spec: ${JSON.stringify(spec)}` }
  }
  for (const name of remove) {
    // Shape only: whether a name MAY be removed is the gateway's protected-set judgement
    // (design 21 §6.11, server-side family facts); a malformed item is a client mistake.
    if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name)) {
      return { ok: false, error: `invalid remove name: ${JSON.stringify(name)}` }
    }
  }
  if (add.length === 0 && remove.length === 0) {
    return { ok: false, error: 'nothing to apply: add and remove are both empty' }
  }

  const aborted = (): boolean => params.signal?.aborted === true
  const refusalText = (op: string, status: number, payload: unknown): string => {
    const record = payload as { error?: unknown; code?: unknown } | null
    const bodyError = record !== null && typeof record.error === 'string' && record.error !== '' ? record.error : '(no error body)'
    const code = record !== null && typeof record.code === 'string' && record.code !== '' ? record.code : null
    return `${op} refused (HTTP ${status}${code === null ? '' : `, code ${code}`}): ${bodyError}`
  }
  const partialFailure = (message: string): GatewayChamberApplyBatchResult => {
    const executed = outcome.installed.length + outcome.removed.length
    const text = executed > 0
      ? `${message} — ops already executed before the failure: ${executed}`
      : message
    return executed > 0 ? { ok: false, error: text, outcome } : { ok: false, error: text }
  }

  try {
    // Remove-before-add (design 21 decision 5): removals apply FIRST so an upgrade/swap
    // never leaves a window where the new plugin is added while the conflicting old one
    // is still installed; failure stops the batch like the per-row serial contract.
    for (const name of remove) {
      if (aborted()) return { ok: false, error: 'gateway plugin apply cancelled', outcome }
      const response = await request('POST', '/chamber/plugins/remove', { name })
      if (response.status !== 202) {
        return partialFailure(refusalText(`remove of ${name}`, response.status, response.payload))
      }
      outcome.removed.push(name)
      const accepted = response.payload as { opId?: unknown } | null
      if (typeof accepted?.opId === 'string' && accepted.opId !== '') opIds.push(accepted.opId)
    }
    for (const spec of add) {
      if (aborted()) return { ok: false, error: 'gateway plugin apply cancelled', ...(outcome.installed.length + outcome.removed.length > 0 ? { outcome } : {}) }
      const parsed = parseSpecArg(spec)
      if (parsed === null) return partialFailure(`invalid add spec: ${JSON.stringify(spec)}`)
      const response = await request('PUT', '/chamber/plugins/install', { name: parsed.name, spec })
      if (response.status !== 202) {
        return partialFailure(refusalText(`install of ${parsed.name}`, response.status, response.payload))
      }
      const accepted = response.payload as { deferred?: unknown; opId?: unknown; intentId?: unknown } | null
      if (accepted?.deferred === true) {
        outcome.deferredOps.push(parsed.name)
      } else {
        outcome.installed.push(parsed.name)
        if (typeof accepted?.opId === 'string' && accepted.opId !== '') opIds.push(accepted.opId)
      }
    }
  } catch (error) {
    const detail = describeError(error)
    return partialFailure(`gateway plugin apply request failed: ${detail}`)
  }

  // Restart-to-apply (design 21 §6.3): unless deferred, wait for the accepted ops to settle
  // (the restart route REFUSES while a profile-write lease is held), then restart and poll.
  if (!deferRestart && (outcome.installed.length > 0 || outcome.removed.length > 0)) {
    if (opIds.length > 0) {
      const settled = await waitForOpsToSettle({ request, opIds, signal: params.signal, intervalMs: params.settleIntervalMs ?? GATEWAY_APPLY_POLL_INTERVAL_MS, timeoutMs: params.settleTimeoutMs ?? GATEWAY_APPLY_OP_SETTLE_TIMEOUT_MS })
      if (!settled.ok) return { ok: false, error: settled.error, outcome }
    }
    try {
      const restart = await request('POST', '/chamber/runtime/restart')
      if (restart.status !== 202 && restart.status !== 200) {
        // Honest: the batch executed but the restart was refused — never a silent success;
        // the caller surfaces the partial outcome and the user can restart later.
        return partialFailure(refusalText('restart of the managed dsh', restart.status, restart.payload))
      }
      const polled = await pollRestartSettled({
        request,
        signal: params.signal,
        intervalMs: params.restartPollIntervalMs ?? GATEWAY_APPLY_POLL_INTERVAL_MS,
        timeoutMs: params.restartPollTimeoutMs ?? GATEWAY_APPLY_RESTART_POLL_TIMEOUT_MS,
      })
      if (!polled.ok) {
        // The restart 202 was accepted; the poll could not confirm readiness — partial, honest.
        return { ok: false, error: polled.error, outcome }
      }
      outcome.restarted = true
    } catch (error) {
      const detail = describeError(error)
      return partialFailure(`gateway restart request failed: ${detail}`)
    }
  }
  return { ok: true, outcome }
}

/** Journal entry subset the settle poll reads (plugins-journal.ts shape). */
interface SettleJournalEntry {
  id?: unknown
  kind?: unknown
  name?: unknown
  status?: unknown
  error?: unknown
}

type GatewayJsonFn = (method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown) => Promise<{ status: number; payload: unknown }>

const TERMINAL_JOURNAL_STATUSES = new Set(['ok', 'failed', 'blocked'])

/** Bound the poll loop with abort sensitivity, mirroring the renderer-side pollGatewayReady discipline. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return new Promise(resolve => setTimeout(resolve, ms))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)
    const handleAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('gateway plugin apply cancelled'))
    }
    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

/** Wait until every accepted opId terminally settles in the gateway's task journal
 *  (GET /chamber/plugins/tasks); a terminal failed/blocked op is a loud {ok:false} — the
 *  batch must not restart over it. 401/403/404 fail fast; other transient answers keep
 *  polling until the deadline. */
async function waitForOpsToSettle(params: {
  request: GatewayJsonFn
  opIds: string[]
  signal?: AbortSignal
  intervalMs: number
  timeoutMs: number
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (params.opIds.length === 0) return { ok: true }
  const deadline = Date.now() + params.timeoutMs
  for (;;) {
    if (params.signal?.aborted === true) return { ok: false, error: 'gateway plugin apply cancelled' }
    let response: { status: number; payload: unknown }
    try {
      response = await params.request('GET', '/chamber/plugins/tasks')
    } catch (error) {
      const detail = describeError(error)
      return { ok: false, error: `gateway plugin task projection failed: ${detail}` }
    }
    if (response.status === 200) {
      const tasks = ((response.payload as { tasks?: unknown } | null)?.tasks ?? []) as SettleJournalEntry[]
      const ours = tasks.filter(entry => typeof entry.id === 'string' && params.opIds.includes(entry.id))
      const terminal = ours.filter(entry => typeof entry.status === 'string' && TERMINAL_JOURNAL_STATUSES.has(entry.status as string))
      const failed = terminal.filter(entry => entry.status !== 'ok')
      if (failed.length > 0) {
        const detail = failed.map(entry => {
          const kind = typeof entry.kind === 'string' ? entry.kind : 'op'
          const name = typeof entry.name === 'string' ? entry.name : String(entry.id ?? '?')
          const reason = typeof entry.error === 'string' && entry.error !== '' ? entry.error : '(no detail)'
          return `${kind} of ${name} failed on the gateway: ${reason}`
        }).join('; ')
        return { ok: false, error: detail }
      }
      if (terminal.length === params.opIds.length) return { ok: true }
    } else if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { ok: false, error: `gateway refused the plugin task projection (HTTP ${response.status}); cannot confirm the accepted ops settled` }
    }
    // Any other answer (5xx / network hiccup while ops still run) is transient — keep polling.
    if (Date.now() >= deadline) break
    await abortableSleep(params.intervalMs, params.signal)
  }
  return { ok: false, error: `the gateway has not finished applying the plugin ops within ${params.timeoutMs}ms; no restart was requested — check the instance plugin task list and restart from the instance when it settles` }
}

/** Poll the runtime status projection after a restart 202 (the same decision table as the
 *  renderer pollGatewayReady): restart 'failed' or a terminal connection state is a loud
 *  failure (never success); 'ok', or ready/degraded without a pending 'running' outcome,
 *  settles success; 401/403/404 fail fast; else poll until the bounded deadline. */
async function pollRestartSettled(params: {
  request: GatewayJsonFn
  signal?: AbortSignal
  intervalMs: number
  timeoutMs: number
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const deadline = Date.now() + params.timeoutMs
  const fail = (detail: string): { ok: false; error: string } => {
    const reason = detail !== '' ? detail : 'unknown restart failure'
    return { ok: false, error: `restart failed: ${reason}` }
  }
  for (;;) {
    if (params.signal?.aborted === true) return { ok: false, error: 'gateway plugin apply cancelled' }
    let response: { status: number; payload: unknown }
    try {
      response = await params.request('GET', '/chamber/runtime/status')
    } catch {
      // dsh is down/restarting — the status endpoint can be transiently unreachable; keep polling.
      if (Date.now() >= deadline) break
      await abortableSleep(params.intervalMs, params.signal)
      continue
    }
    if (response.status === 200) {
      const status = response.payload as { connectionState?: unknown; operationError?: unknown; restart?: unknown } | null
      const operationError = typeof status?.operationError === 'string' ? status.operationError : ''
      // A restart rejected AFTER the 202 sets restart:'failed' while connectionState is
      // still 'ready' — loud failure, never success.
      if (status?.restart === 'failed') return fail(operationError)
      if (status?.connectionState === 'error'
        || status?.connectionState === 'restart-exhausted'
        || status?.connectionState === 'stopped') return fail(operationError)
      if (status?.restart === 'ok') return { ok: true }
      // Legacy gateways without the outcome field: 'degraded' counts as success too
      // (process alive, next probe returns to ready).
      if ((status?.connectionState === 'ready' || status?.connectionState === 'degraded') && status?.restart !== 'running') {
        return { ok: true }
      }
    } else if (response.status === 401 || response.status === 403 || response.status === 404) {
      const detail = response.status === 401
        ? 'unauthorized (401) — check the gateway token'
        : response.status === 404
          ? 'gateway does not expose /chamber/runtime (404)'
          : 'forbidden (403)'
      return fail(detail)
    }
    if (Date.now() >= deadline) break
    await abortableSleep(params.intervalMs, params.signal)
  }
  return { ok: false, error: 'restart accepted but the gateway did not reach ready in time' }
}

/** Materialize outcome after the desktop waited for the executor op: the profile mutation
 *  terminally succeeded (`executed`) and the controlled restart was accepted AND settled. */
export interface GatewayMaterializeOutcome {
  executed: boolean
  restarted: boolean
}

/** Materialize result: ok:true deferred = persisted as a deferred intent (executed at the
 *  next ready edge, nothing more to do); ok:true outcome = the op terminally succeeded and
 *  the restart settled; ok:false is loud (refusal / op failure / settle or restart failure)
 *  with an optional outcome telling exactly how far the install got. */
export type GatewayChamberMaterializeResult =
  | { ok: true; deferred: true }
  | { ok: true; outcome: GatewayMaterializeOutcome }
  | { ok: false; error: string; outcome?: GatewayMaterializeOutcome }

/** Raw-body PUT with the S23 pin discipline (tar bytes never leave before the peer key
 *  matches); a thin adapter over gateway-http-core.ts with the same reject mapping. */
async function gatewayRawBodyPut(
  url: string,
  options: {
    headers: Record<string, string>
    body: Buffer
    insecure: boolean
    spkiPin: string | null
    timeoutMs: number
  },
): Promise<{ status: number; payload: unknown }> {
  const outcome = await boundedGatewayRequest(url, {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      ...options.headers,
    },
    body: options.body,
    insecure: options.insecure,
    spkiPin: options.spkiPin,
    timeoutMs: options.timeoutMs,
    maxBodyBytes: GATEWAY_PLUGIN_RESPONSE_MAX_BODY_BYTES,
    timeoutMessage: 'gateway plugin materialize timed out',
  })
  if (outcome.kind === 'response') return { status: outcome.status, payload: outcome.payload }
  throw outcome.kind === 'oversize'
    ? new Error('gateway plugin materialize response exceeds the size bound')
    : outcome.error
}

/** Upload a desktop-built plugin tarball to PUT /chamber/plugins/materialize with the
 *  x-plugin-name / x-plugin-version headers (pre-validated against the shared whitelists)
 *  and the archive size re-checked before any byte is sent. Non-202 answers map their
 *  {error, code} body honestly; after a 202 the desktop waits for the op to settle, then
 *  restarts and polls — the apply-batch parity. A deferred answer returns immediately. */
export async function gatewayChamberMaterialize(params: {
  id: string
  url: string
  /** Registration auth headers — main-process only, may be empty. */
  headers: Record<string, string>
  spkiPin: string | null
  /** The gzip plugin archive (buildPluginTarball output). */
  tarball: Buffer
  name: string
  version: string
  authority?: string
  /** Per-request timeout for the upload and the settle/status JSON calls. */
  requestTimeoutMs?: number
  settleIntervalMs?: number
  settleTimeoutMs?: number
  restartPollIntervalMs?: number
  restartPollTimeoutMs?: number
}): Promise<GatewayChamberMaterializeResult> {
  const { url } = params
  const timeoutMs = params.requestTimeoutMs ?? GATEWAY_MATERIALIZE_TIMEOUT_MS
  if (typeof params.name !== 'string' || !PLUGIN_NAME_PATTERN.test(params.name)) {
    return { ok: false, error: 'invalid plugin name for the materialize upload' }
  }
  if (typeof params.version !== 'string' || !GATEWAY_PLUGIN_VERSION_PATTERN.test(params.version)) {
    return { ok: false, error: 'invalid plugin version for the materialize upload (exact semver required)' }
  }
  if (!Buffer.isBuffer(params.tarball) || params.tarball.length === 0) {
    return { ok: false, error: 'no plugin archive to upload' }
  }
  if (params.tarball.length > TARBALL_MAX_ARCHIVE_BYTES) {
    return { ok: false, error: `the plugin archive is ${params.tarball.length} bytes, beyond the ${TARBALL_MAX_ARCHIVE_BYTES}-byte upload cap` }
  }
  const insecure = !url.startsWith('https://')
  const requestHeaders: Record<string, string> = {
    ...params.headers,
    'x-plugin-name': params.name,
    'x-plugin-version': params.version,
    'content-type': 'application/gzip',
    'content-length': String(params.tarball.length),
  }
  if (params.authority !== undefined) requestHeaders.host = params.authority
  try {
    const response = await gatewayRawBodyPut(`${url}/chamber/plugins/materialize`, {
      headers: requestHeaders,
      body: params.tarball,
      insecure,
      spkiPin: params.spkiPin,
      timeoutMs,
    })
    if (response.status !== 202) {
      const record = response.payload as { error?: unknown; code?: unknown } | null
      const bodyError = record !== null && typeof record.error === 'string' && record.error !== '' ? record.error : '(no error body)'
      const code = record !== null && typeof record.code === 'string' && record.code !== '' ? record.code : null
      return { ok: false, error: `materialize of ${params.name}@${params.version} refused (HTTP ${response.status}${code === null ? '' : `, code ${code}`}): ${bodyError}` }
    }
    const accepted = response.payload as { deferred?: unknown; opId?: unknown } | null
    // Deferred intent: the gateway persists the install and drains it —
    // restart included — at the next ready edge. Nothing to settle here.
    if (accepted?.deferred === true) return { ok: true, deferred: true }
    const opId = typeof accepted?.opId === 'string' && accepted.opId !== '' ? accepted.opId : null
    if (opId === null) {
      return { ok: false, error: 'the gateway accepted the materialize upload but answered no opId; the install outcome cannot be confirmed — refresh the plugin list later' }
    }
    const request = (
      method: 'GET' | 'PUT' | 'POST',
      path: string,
      body?: unknown,
    ): Promise<{ status: number; payload: unknown }> => {
      // Auth-only JSON headers — NEVER the upload headers: a stale content-length on a
      // GET would make the gateway wait for a body that never comes.
      const jsonHeaders: Record<string, string> = { ...params.headers }
      if (params.authority !== undefined) jsonHeaders.host = params.authority
      return gatewayJsonRequest(`${url}${path}`, {
        method,
        headers: jsonHeaders,
        body,
        insecure,
        spkiPin: params.spkiPin,
        timeoutMs,
      })
    }
    // Settle the executor op first: the controlled restart is REFUSED while a profile-write lease is held.
    const settled = await waitForOpsToSettle({
      request,
      opIds: [opId],
      intervalMs: params.settleIntervalMs ?? GATEWAY_APPLY_POLL_INTERVAL_MS,
      timeoutMs: params.settleTimeoutMs ?? GATEWAY_APPLY_OP_SETTLE_TIMEOUT_MS,
    })
    if (!settled.ok) return { ok: false, error: settled.error }
    const restart = await request('POST', '/chamber/runtime/restart')
    if (restart.status !== 202 && restart.status !== 200) {
      // Honest partial: the plugin IS installed but the dsh did not restart — it mounts at
      // the next natural spawn; the user can restart from the instance or retry here.
      const record = restart.payload as { error?: unknown; code?: unknown } | null
      const bodyError = record !== null && typeof record.error === 'string' && record.error !== '' ? record.error : '(no error body)'
      const code = record !== null && typeof record.code === 'string' && record.code !== '' ? record.code : null
      return {
        ok: false,
        error: `restart of the managed dsh refused after the plugin was installed (HTTP ${restart.status}${code === null ? '' : `, code ${code}`}): ${bodyError}`,
        outcome: { executed: true, restarted: false },
      }
    }
    const polled = await pollRestartSettled({
      request,
      intervalMs: params.restartPollIntervalMs ?? GATEWAY_APPLY_POLL_INTERVAL_MS,
      timeoutMs: params.restartPollTimeoutMs ?? GATEWAY_APPLY_RESTART_POLL_TIMEOUT_MS,
    })
    if (!polled.ok) {
      // The restart was accepted; the poll could not confirm readiness — loud, with the executed fact.
      return { ok: false, error: polled.error, outcome: { executed: true, restarted: false } }
    }
    return { ok: true, outcome: { executed: true, restarted: true } }
  } catch (error) {
    const detail = describeError(error)
    return { ok: false, error: `gateway plugin materialize failed: ${detail}` }
  }
}
