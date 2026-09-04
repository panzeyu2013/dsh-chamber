/**
 * The `http` transport provider (design 17 §2.2/§9.2): a DIRECT ENDPOINT
 * provider — no local tunnel child process. v2 semantics: it serves the
 * `http` TRANSPORT for the GATEWAY target (`dsh`×`http` is DISABLED 2026-09 —
 * direct-attaching a dsh web profile over http is hard-blocked on the 0.1.2
 * line: its host answers 401 without the spawn-time browser-auth launch
 * token, which is unrecoverable remotely; ssh is the only dsh transport.
 * Re-enable point: upstream token retrieval + the connection-form schema +
 * this provider's validateSpec refusal). The
 * "endpoint" is the target's http(s) URL (scheme from `insecureHttp`,
 * default https), reached as-is. The gateway target may be authenticated with
 * a shared bearer token and/or a login password, held in main-process memory
 * (mirrored to `<userData>/gateway-secrets.json`, bound schemaVersion 3, 0600, for
 * restart auto-connect — safeStorage-encrypted blobs with a documented 0600
 * plaintext fallback, design 17 §12). An over-ssh spec (transport 'ssh') is
 * REFUSED here — the ssh tunnel provider machinery is the separate ssh
 * provider (design 17 §9.2) and must never be mis-served as a direct
 * endpoint.
 *
 * Spec mapping: `host` carries the target hostname, `remotePort` the target
 * port (https default 443 / http default 80), and
 * `user`/`sshPort`/`serviceName`/`remoteDshHome` are null. Credentials are
 * NOT part of the spec (never in the registry or any renderer payload): they
 * are held in the credential store keyed by instance id — the same
 * plaintext-file-fallback discipline as the ssh password store
 * (design 05 §8), but without askpass (the bearer token rides the
 * Authorization header, the password becomes a login session Cookie, both
 * injected by the control-plane proxy, §7).
 *
 * Security discipline (design 17 §11 S5/S12/S22): credentials are transient
 * write-only renderer inputs and never return in a projection or enter the
 * registry/logs; the mirror file is 0600 +
 * atomic write; a corrupt file fails loudly (preserved as `.corrupt`), never
 * silently treated as empty. S22 availability flip (P1-1): a value written as
 * an ENCRYPTED blob while crypto was available is CORRUPT when a later
 * startup loads it without working crypto (or when the blob fails to decrypt)
 * — a blob is never silently adopted as the plaintext credential, even when
 * its base64 shape happens to pass the visible-ASCII/length gates.
 */

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { INSTANCE_ID_PATTERN, MAX_INSTANCE_LABEL_CHARS } from './transport-provider.ts'
import { gatewayCredentialBinding, isCredentialBinding } from './credential-binding.ts'
import type {
  TransportInstanceSpec,
  TransportKind,
  TransportProbeEndpoint,
  TransportProvider,
  TransportVerifyResult,
} from './transport-provider.ts'
import { gatewaySessionScopeForConnection } from './gateway-session.ts'
import type { GatewayRegistrationAuthProof, GatewaySessionOrigin, GatewaySessionResult } from './gateway-session.ts'
import { readOwnerOnlySecretFile } from './owner-only-secret-file.ts'
import { parseSpecArg } from './gateway-ipc-shared.ts'
import {
  attachSpkiPinVerifier,
  GATEWAY_PASSWORD_MAX_CHARS,
  GATEWAY_PASSWORD_MIN_CHARS,
  GATEWAY_TOKEN_MAX_CHARS,
  GATEWAY_TOKEN_MIN_CHARS,
  GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN,
  isDeniedPluginName,
  PLUGIN_NAME_PATTERN,
  SPKI_PIN_MISMATCH_CODE,
  SPKI_PIN_PATTERN,
  spkiPinOfPeerCertificate,
} from './control-plane-module.ts'
import { GATEWAY_PLUGIN_VERSION_PATTERN, TARBALL_MAX_ARCHIVE_BYTES } from './plugin-tarball.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

/** Gateway hostname whitelist: a bare hostname/IPv4 (NO colon — the port is
 * carried separately in `remotePort`, never embedded in the host) or a fully
 * bracketed IPv6 literal. This differs from the ssh whitelist: ssh passes the
 * host into argv (where a colon is inert), but the gateway builds URLs from
 * it, so an embedded `host:8443` would silently override/break the URL port. */
export const GATEWAY_HOST_PATTERN = /^(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:.]+\])$/
export const MAX_GATEWAY_HOST_CHARS = 253
// Gateway credential bounds are the shared wire-protocol single source
// (control-plane gateway-session-protocol.ts via control-plane-module.ts) —
// the same values the gateway server (config.ts/auth.ts) and the proxy
// injection gate (instance-proxy.ts) enforce. These local names are kept as
// aliases for the form/validation call sites and their tests.
export const MAX_GATEWAY_TOKEN_CHARS = GATEWAY_TOKEN_MAX_CHARS
export const MIN_GATEWAY_TOKEN_CHARS = GATEWAY_TOKEN_MIN_CHARS
export const MAX_GATEWAY_PASSWORD_CHARS = GATEWAY_PASSWORD_MAX_CHARS
export const MIN_GATEWAY_PASSWORD_CHARS = GATEWAY_PASSWORD_MIN_CHARS
const GATEWAY_CREDENTIAL_HEADER_PATTERN = GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN

// ---------------------------------------------------------------------------
// SPKI certificate pinning (design 17 §13.4.2 / S23): shared single source in
// control-plane spki-pin.ts — re-exported through the dual-path facade. The
// identity probe AND the control-plane proxy forwarding gate import the SAME
// helpers (the former "identical copies in two packages, kept in sync by
// comment" arrangement was removed when the facade made the control plane
// importable from the packaged desktop). Mechanism note: checkServerIdentity
// cannot enforce a pin against an internal CA (see spki-pin.ts), so the pin
// check runs on the TLS socket 'secureConnect' event with
// rejectUnauthorized:false + agent:false — a wrong-key peer sees zero HTTP
// headers, credential bytes, or login body before this gate invokes
// `dispatch`.
// ---------------------------------------------------------------------------

// Re-exported for module consumers (gateway-session.ts login pinning, tests)
// — the implementations above come from the shared single source.
export { attachSpkiPinVerifier, spkiPinOfPeerCertificate, SPKI_PIN_MISMATCH_CODE, SPKI_PIN_PATTERN }

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

/** Validate a login password — mirrors the gateway server/config gate
 * exactly: 12–1024 JavaScript characters. Unlike bearer tokens, passwords
 * are JSON request-body data and may contain Unicode. */
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

/** Default gateway http port (insecureHttp) when the connection form omits
 * it — the form layer uses it for the http origin default (design 17 §9.1:
 * `insecureHttp` origin, 明文 http 直连). */
export const DEFAULT_GATEWAY_HTTP_PORT = 80

/** Timeout of the one-shot gateway-owned runtime identity probe (verifyUp). */
export const GATEWAY_VERIFY_TIMEOUT_MS = 5_000

/** Response-body cap of the gateway identity probe. */
export const GATEWAY_VERIFY_MAX_BODY_BYTES = 1024 * 1024

/** Classify a non-success identity-probe response. Client/protocol mistakes
 * are deterministic, except timeout/early-data/rate-limit statuses whose
 * meaning is explicitly transient. Every 5xx is transient: gateway startup,
 * overload, maintenance, and upstream dsh failures can recover by retry. */
export function gatewayHttpFailureIsTerminal(statusCode: number): boolean {
  if (statusCode === 408 || statusCode === 425 || statusCode === 429) return false
  if (statusCode >= 500 && statusCode < 600) return false
  // Any other actual HTTP answer is deterministic protocol/config evidence:
  // redirects and alternate 2xx statuses are not the required dsh RPC
  // envelope and will not heal through transport retry.
  return statusCode >= 100 && statusCode < 600
}

// ---------------------------------------------------------------------------
// Per-instance gateway credentials (design 17 §2.3/§7/§12): a gateway target
// may carry a shared bearer TOKEN and/or a login PASSWORD (independent, both
// nullable — §2.3). Held in main-process memory, mirrored to
// `<userData>/gateway-secrets.json` (bound schemaVersion 3, 0600, atomic write) so
// a token/password gateway auto-connects after restart. The file carries one
// explicit `storage: safeStorage | plaintext` discriminator: values are
// encrypted via the configured SecretCryptoAdapter when available (Electron
// safeStorage in the shell; base64 blobs), plaintext when not (the documented
// fallback). The discriminator is security-critical — ciphertext is never
// guessed from its characters and can therefore never be sent as plaintext.
// Never in the registry, never logged, never exposed to the renderer. Entries
// are dropped on instance removal / explicit clear (§12 删除实例/显式清除即删).
// ---------------------------------------------------------------------------

/** Encryption boundary for the credential mirror (design 17 §13.4.1):
 * `encrypt`/`decrypt` translate between a plaintext credential and its
 * durable blob. `decrypt` must THROW when given a non-blob: a file explicitly
 * tagged `safeStorage` is then unreadable/corrupt and is never retried as raw
 * plaintext. A file explicitly tagged `plaintext` bypasses decryption. The
 * default adapter reports unavailable and never encrypts. */
export interface SecretCryptoAdapter {
  isAvailable(): boolean
  encrypt(plain: string): string
  decrypt(blob: string): string
}

/** Default adapter: encryption unavailable → the mirror stays plaintext
 * (design 05 §8 / 17 §12 — 既有用户决策延续). */
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

/** The legacy (schemaVersion 1) mirror file name. Non-empty values cannot be
 * auto-bound safely and therefore remain preserved + disabled. */
const LEGACY_TOKEN_FILE_NAME = 'gateway-tokens.json'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function preserveInvalidSecretFile(file: string): string {
  const corruptPath = `${file}.corrupt`
  try {
    renameSync(file, corruptPath)
    return `invalid gateway secrets file preserved at ${corruptPath}`
  } catch (error) {
    return `invalid gateway secrets file at ${file}; preserve failed: ${String(error)}`
  }
}

function preserveUnboundSecretFile(file: string): string {
  const stem = `${file}.unbound-${Date.now()}-${process.pid}`
  let unboundPath = stem
  for (let index = 1; existsSync(unboundPath); index += 1) unboundPath = `${stem}-${index}`
  try {
    renameSync(file, unboundPath)
    return `legacy gateway secrets have no target bindings and were preserved at ${unboundPath}; re-enter credentials to use them`
  } catch (error) {
    return `legacy gateway secrets at ${file} have no target bindings and are disabled; preserve failed: ${String(error)}`
  }
}

type GatewaySecretFileStorage = 'safeStorage' | 'plaintext'

/** Honest durable mode of the currently loaded mirror. This intentionally
 * differs from `secretCrypto.isAvailable()`: a plaintext file remains a
 * plaintext fact until its atomic safeStorage rewrite succeeds. */
let durableSecretStorage: GatewaySecretFileStorage = 'plaintext'

/** A loaded credential must pass its table's gate exactly like a fresh one:
 * tokens are length-bounded visible ASCII, while passwords are length-bounded
 * JavaScript strings and may contain Unicode. '' is invalid in either durable
 * table — nullable entry points reserve it for "no credential". */
function isValidCredentialValue(value: string, minChars: number, maxChars: number, visibleAscii: boolean): boolean {
  return value.length >= minChars && value.length <= maxChars
    && (!visibleAscii || GATEWAY_CREDENTIAL_HEADER_PATTERN.test(value))
}

/** Load and validate ONE credential table into plaintext, or null when any
 * entry is structurally invalid (reserved id / bad id / non-string value), is
 * an UNREADABLE ENCRYPTED BLOB (`resolve` → null), or fails the credential
 * gate. `resolve` maps a stored value to the plaintext credential BEFORE the
 * value gate: discriminator-directed decrypt-or-raw for v2/v3, identity for
 * v1 (schemaVersion 1 values are always plaintext — never encrypted). A null
 * result drives the caller's preserveInvalidSecretFile — the WHOLE file is
 * corrupt (loud, never silently empty). */
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

/** Resolve one v2/v3 stored value according to the FILE'S explicit storage
 * discriminator (S22). A safeStorage file is unreadable when encryption is
 * unavailable or decryption fails; it is never interpreted as plaintext.
 * Conversely, a plaintext-tagged file deliberately uses the documented 0600
 * fallback and never attempts heuristic decryption. */
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
 * Point the gateway credentials store at its mirror file (main.ts, once at
 * startup) and load existing entries. Missing file = empty set (first run),
 * except an EMPTY schemaVersion 1 `gateway-tokens.json` can be converged.
 * Non-empty v1/v2 files have no credential-domain binding, so they are
 * preserved and disabled with a loud re-entry notice. A corrupt file fails
 * LOUDLY (preserved as
 * `<file>.corrupt`), never silently empty — including the S22 availability
 * flip: `storage: "safeStorage"` blobs written while crypto was available are
 * corrupt when loaded without working crypto (or when they fail to decrypt),
 * and are NEVER adopted as plaintext credentials. `crypto` defaults to the
 * plaintext adapter (no encryption — old-test semantics).
 * @returns a loud notice string (corrupt-preserved / migration failure) or null.
 */
export function configureGatewaySecretStore(
  file: string | null,
  crypto?: SecretCryptoAdapter,
  resolveSpec?: (id: string) => TransportInstanceSpec | null,
): string | null {
  secretFile = file
  secretCrypto = crypto ?? plaintextSecretCrypto
  secretSpecResolver = resolveSpec ?? null
  // Missing/memory-only stores will use this on their first write. An
  // existing bound v3 file replaces it below with its explicit durable fact.
  durableSecretStorage = secretCrypto.isAvailable() ? 'safeStorage' : 'plaintext'
  tokens.clear()
  passwords.clear()
  tokenBindings.clear()
  passwordBindings.clear()
  if (file === null) return null
  let text: string
  try {
    text = readOwnerOnlySecretFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return migrateLegacyTokenFile(file)
    return `cannot read ${file}: ${String(error)}`
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return preserveInvalidSecretFile(file)
  }
  if (!isPlainRecord(parsed)) return preserveInvalidSecretFile(file)
  if (parsed.schemaVersion === 1) {
    if (!isPlainRecord(parsed.tokens)) return preserveInvalidSecretFile(file)
    const v1Tokens = loadCredentialTable(parsed.tokens, MIN_GATEWAY_TOKEN_CHARS, MAX_GATEWAY_TOKEN_CHARS, blob => blob)
    if (v1Tokens === null) return preserveInvalidSecretFile(file)
    if (v1Tokens.size > 0) return preserveUnboundSecretFile(file)
    persistGatewaySecrets(new Map(), new Map(), new Map(), new Map())
    return null
  }
  if ((parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3)
    || !isPlainRecord(parsed.tokens) || !isPlainRecord(parsed.passwords)) {
    return preserveInvalidSecretFile(file)
  }
  const storage = parsed.storage
  const emptyLegacyV2 = parsed.schemaVersion === 2 && storage === undefined
    && Object.keys(parsed.tokens).length === 0
    && Object.keys(parsed.passwords).length === 0
  if (storage !== 'safeStorage' && storage !== 'plaintext' && !emptyLegacyV2) {
    return preserveInvalidSecretFile(file)
  }
  const effectiveStorage: GatewaySecretFileStorage = storage === 'safeStorage' ? 'safeStorage' : 'plaintext'
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
  if (loadedTokens === null || loadedPasswords === null) return preserveInvalidSecretFile(file)
  if (parsed.schemaVersion === 2) {
    // No safe automatic adoption exists: this file may be the new-target
    // credential half left by a crash before the registry commit. Empty is
    // harmless; non-empty is preserved for explicit user recovery/re-entry.
    if (loadedTokens.size > 0 || loadedPasswords.size > 0) return preserveUnboundSecretFile(file)
    persistGatewaySecrets(new Map(), new Map(), new Map(), new Map())
    return null
  }
  if (!isPlainRecord(parsed.tokenBindings) || !isPlainRecord(parsed.passwordBindings)) {
    return preserveInvalidSecretFile(file)
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
    return preserveInvalidSecretFile(file)
  }
  // Upgrade a documented plaintext fallback immediately when a keychain is
  // now available. Claim safeStorage only after the atomic rewrite succeeds;
  // on failure the validated plaintext remains usable and visibly plaintext.
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

/** Backward-compatible test/embedding alias for callers that still name the
 * former token-only store. The Electron shell uses
 * `configureGatewaySecretStore(<userData>/gateway-secrets.json)` with its
 * safeStorage adapter and live registry resolver. */
export function configureGatewayTokenStore(
  file: string | null,
  resolveSpec?: (id: string) => TransportInstanceSpec | null,
): string | null {
  return configureGatewaySecretStore(file, undefined, resolveSpec)
}

/** Safely handle a schemaVersion 1 `gateway-tokens.json` beside the bound v3
 * file. Empty legacy state can converge automatically; non-empty values are
 * kept but disabled because no endpoint binding can be inferred safely. */
function migrateLegacyTokenFile(file: string): string | null {
  const legacyPath = join(dirname(file), LEGACY_TOKEN_FILE_NAME)
  // If an embedding deliberately configures the legacy path itself, the v1
  // in-place load above handles it; there is no sibling file to inspect.
  if (legacyPath === file) return null
  let text: string
  try {
    text = readOwnerOnlySecretFile(legacyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return `cannot read legacy gateway token file ${legacyPath}: ${String(error)}; keeping it`
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return `legacy gateway token file ${legacyPath} is corrupt; keeping it (no migration)`
  }
  if (!isPlainRecord(parsed) || parsed.schemaVersion !== 1 || !isPlainRecord(parsed.tokens)) {
    return `legacy gateway token file ${legacyPath} is not a valid schemaVersion 1 token file; keeping it (no migration)`
  }
  // v1 values are always plaintext (schemaVersion 1 never encrypted) — the
  // identity resolver applies, no blob detection.
  const migrated = loadCredentialTable(parsed.tokens, MIN_GATEWAY_TOKEN_CHARS, MAX_GATEWAY_TOKEN_CHARS, blob => blob)
  if (migrated === null) {
    return `legacy gateway token file ${legacyPath} is not a valid schemaVersion 1 token file; keeping it (no migration)`
  }
  if (migrated.size > 0) {
    return `legacy gateway token file ${legacyPath} has no target bindings and is disabled; re-enter credentials to migrate safely`
  }
  try {
    persistGatewaySecrets(new Map(), new Map(), new Map(), new Map())
  } catch (error) {
    return `migrating the empty legacy gateway token file failed: ${String(error)}; the legacy file is kept at ${legacyPath}`
  }
  try {
    rmSync(legacyPath)
  } catch (error) {
    return `migrated gateway tokens to ${file}, but could not remove the legacy file ${legacyPath}: ${String(error)}`
  }
  return null
}

/** Set or clear the token for one instance (null/'' = clear). Persists the
 * durable mirror when configured (write-through: the live state changes only
 * after its durable mirror succeeds). Design 17 §2.3: token and password are
 * INDEPENDENT nullable credentials — a token clear NEVER touches the
 * instance's password. Transactional add/edit/delete flows use the grouped
 * `setInstanceSecrets` primitive to atomically commit or scrub both gateway
 * credential dimensions for a target-domain generation. */
export function setGatewayToken(id: string, token: string | null, spec?: TransportInstanceSpec | null): void {
  if (id === 'local' || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing token for invalid instance id ${JSON.stringify(id)}`)
  }
  const tokenError = gatewayTokenValidationError(token)
  if (tokenError !== null) throw new Error(tokenError)
  // A clear of an id that owns no token is a disk no-op: do not manufacture
  // or rewrite the secrets file (or make an otherwise-valid clear depend on
  // that disk write). The password is deliberately NOT consulted here — the
  // two dimensions are independent.
  if ((token === null || token === '') && !tokens.has(id)) return
  const nextTokens = new Map(tokens)
  const nextPasswords = new Map(passwords)
  const nextTokenBindings = new Map(tokenBindings)
  const nextPasswordBindings = new Map(passwordBindings)
  if (token === null || token === '') {
    nextTokens.delete(id)
    nextTokenBindings.delete(id)
  } else {
    const bindingSpec = spec ?? secretSpecResolver?.(id) ?? null
    const binding = bindingSpec === null ? null : gatewayCredentialBinding(bindingSpec)
    if (binding === null && secretFile !== null) throw new Error('refusing to persist a gateway token without a matching gateway target binding')
    nextTokens.set(id, token)
    if (binding === null) nextTokenBindings.delete(id)
    else nextTokenBindings.set(id, binding)
  }
  persistGatewaySecrets(nextTokens, nextPasswords, nextTokenBindings, nextPasswordBindings)
  commitGatewaySecrets(nextTokens, nextPasswords, nextTokenBindings, nextPasswordBindings)
}

/** Set or clear the login password for one instance (null/'' = clear) —
 * design 17 §2.3: token and password are INDEPENDENT credentials, so an
 * explicit password clear never touches the token. Write-through like the
 * token setter. */
export function setGatewayPassword(id: string, password: string | null, spec?: TransportInstanceSpec | null): void {
  if (id === 'local' || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing password for invalid instance id ${JSON.stringify(id)}`)
  }
  const passwordError = gatewayPasswordValidationError(password)
  if (passwordError !== null) throw new Error(passwordError)
  if ((password === null || password === '') && !passwords.has(id)) return
  const nextTokens = new Map(tokens)
  const nextPasswords = new Map(passwords)
  const nextTokenBindings = new Map(tokenBindings)
  const nextPasswordBindings = new Map(passwordBindings)
  if (password === null || password === '') {
    nextPasswords.delete(id)
    nextPasswordBindings.delete(id)
  } else {
    const bindingSpec = spec ?? secretSpecResolver?.(id) ?? null
    const binding = bindingSpec === null ? null : gatewayCredentialBinding(bindingSpec)
    if (binding === null && secretFile !== null) throw new Error('refusing to persist a gateway password without a matching gateway target binding')
    nextPasswords.set(id, password)
    if (binding === null) nextPasswordBindings.delete(id)
    else nextPasswordBindings.set(id, binding)
  }
  persistGatewaySecrets(nextTokens, nextPasswords, nextTokenBindings, nextPasswordBindings)
  commitGatewaySecrets(nextTokens, nextPasswords, nextTokenBindings, nextPasswordBindings)
}

/** Set or clear BOTH credentials for one instance in a SINGLE atomic persist
 * (null/'' = clear each dimension). Main-owned save/delete transactions use
 * this primitive for target-domain entry, retarget, removal, compensation,
 * and crash-residue scrubbing. The per-dimension explicit-clear setters keep
 * token and password independent (§2.3). Write-through like the single
 * setters; a clear of an id that owns neither credential is a disk no-op. */
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
  // A double clear of an id that owns neither credential must not manufacture
  // or rewrite the secrets file (or make an otherwise-valid clear depend on
  // that disk write).
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

/** Mirror the in-memory credential maps to the durable file (schemaVersion 3,
 * 0600, atomic: tmp → fsync → rename — the repo's atomic-write convention;
 * rename keeps the tmp's 0600). The file-level storage discriminator is
 * written in the same atomic payload as the values, so a later startup never
 * has to infer whether a string is ciphertext. */
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
  const tmpPath = `${secretFile}.tmp`
  mkdirSync(dirname(secretFile), { recursive: true })
  try {
    const fd = openSync(tmpPath, 'w', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, payload)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, secretFile)
    durableSecretStorage = storage
  } catch (error) {
    try { rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Password-login session hooks (design 17 §7.3/§9.3): the provider does NOT
// own the login exchange — the shell composes the gateway-session manager
// (gateway-session.ts) onto the provider via configureGatewaySessionProvider
// (main.ts). verifyUp consults the hooks for password-configured gateway
// targets: ensure a login session exists (exchange the stored password only
// when no live cookie is cached — reconnects must not re-login), probe WITH
// the session Cookie, and on a rejected 401 invalidate + re-login once with
// the stored password before reporting the terminal password-refused state
// (design 17 §7.3 密码被拒 / §9.3 重登一次后仍失败才 terminal). Default = no
// hooks: the password-session flow is INERT and a password-configured target
// probes without auth (the old behavior) until the shell wires the complete
// all-or-none manager surface in; partial hooks are rejected at configuration.
// ---------------------------------------------------------------------------

/** The session hooks surface mirrors GatewaySessionManager. An empty object
 * disables password-session integration; any active configuration must
 * provide the complete set so generation/proof fences cannot silently drop. */
export interface GatewaySessionProviderHooks {
  /** POST /auth/login with the stored password; resolves the header-ready
   * cookie or a classified failure. Absent = the password flow is off. */
  ensureSession?(origin: GatewaySessionOrigin, password: string): Promise<GatewaySessionResult>
  /** Exact-key invalidation generation. When supplied, the verifier fences
   * every post-await network step so a cleared/deleted generation cannot use
   * its captured password, cookie, or bearer after invalidation. */
  generation?(origin: GatewaySessionOrigin): number
  registrationAuthProof?(origin: GatewaySessionOrigin): GatewayRegistrationAuthProof | null
  setRegistrationAuthProof?(origin: GatewaySessionOrigin, proof: GatewayRegistrationAuthProof | null): void
  /** The cached header-ready cookie for the origin, or null. Synchronous —
   * the fast path: a live session (12h − 5min) probes directly. */
  cachedCookie?(origin: GatewaySessionOrigin): string | null
  /** Drop the cached session (called after a cookie-401 probe rejection). */
  invalidate?(origin: GatewaySessionOrigin): void
}

/** The active hooks; default = none (the password flow is inert). */
let sessionHooks: GatewaySessionProviderHooks = {}

/** Wire the shell's gateway-session manager onto the provider (main.ts).
 * An empty argument disables the flow (tests reset between cases). */
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

/** Read access to the active session hooks (design 17 §9.2/§9.3): the ssh
 * provider's tunnel branch (ssh-provider.ts) consults the SAME hooks main.ts
 * wired via configureGatewaySessionProvider — one wiring point serves both
 * transport shapes, so the gateway-over-ssh password flow can never drift
 * from the direct-endpoint flow. */
export function getGatewaySessionHooks(): GatewaySessionProviderHooks {
  return sessionHooks
}

/** The credential mirror's ACTUAL durable storage mode (design 17 §13.4.1 /
 * S22), read from/written with the file-level discriminator. It never claims
 * safeStorage merely because the adapter is currently available: a plaintext
 * mirror stays visibly plaintext until its atomic encryption upgrade succeeds.
 * Read-only, global per store;
 * merged into instances_get as a non-secret projection so the fallback path
 * is visible in the settings UI. Defaults to 'plaintext' (the inert adapter)
 * until main.ts configures a real one. */
export function gatewaySecretStorageMode(): 'safeStorage' | 'plaintext' {
  return durableSecretStorage
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gateway endpoint identity verification (design 17 §7 / design 18 §9.3): a
// gateway transport is serviceable when its authenticated, gateway-owned
// runtime controller answers — independently of the managed dsh lifecycle.
// This distinction keeps /chamber/runtime reachable for recovery while dsh is
// blocked/down. (dsh×http was disabled 2026-09 — a plain dsh target's only
// transport is ssh, whose provider owns the session/list handshake.)
// ---------------------------------------------------------------------------

export const GATEWAY_RUNTIME_IDENTITY = 'dsh-chamber-gateway-runtime'

export function isGatewayRuntimeStatus(value: unknown): value is { kind: typeof GATEWAY_RUNTIME_IDENTITY } {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === GATEWAY_RUNTIME_IDENTITY
}

/**
 * GET /chamber/runtime/status and require the gateway runtime identity marker.
 * The route is gateway-owned and deliberately remains mounted while managed
 * dsh is stopped/blocked, so recovery actions stay reachable. The token may be null: a NO-CREDENTIAL probe is
 * deliberately sent WITHOUT an Authorization header (design 17 §2.3/§9.3 —
 * "都空 → 无认证头直接请求，由 gateway 校验"): a `--no-auth` deployment
 * answers 200 and is ready; an auth-requiring deployment answers 401, which
 * is classified TERMINAL (three-state §7.3) — the user must configure the
 * token or password, retrying cannot change the answer. A wrong token also
 * answers 401 (terminal), with the message split so the two cases are not
 * conflated. `cookie` is the password-session header (design 17 §9.3,
 * gateway-session.ts): when attached, a 401 is a PASSWORD-SESSION rejection
 * (the login succeeded but the cookie was refused — password-refused
 * three-state, the user must re-enter the password), also terminal. The
 * result carries `statusCode` so the caller can act on the raw 401 (the
 * verifyUp session flow invalidates the rejected cookie). Connection
 * failures stay transient. `insecure` selects the http(s) scheme (design 17
 * §9.1: `insecureHttp` origin). `spkiPin` (S23): when the target is https
 * AND a pin is configured, the probe treats the pin as the connection's
 * trust anchor — a peer whose SPKI does not match is rejected TERMINAL
 * (「证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误」); http + pin is
 * impossible (validateSpec refuses it) but the `insecure` guard keeps this
 * function safe regardless.
 */
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
  return new Promise(resolve => {
    const request = insecure ? httpRequest : httpsRequest
    const url = `${insecure ? 'http' : 'https'}://${host}:${port}/chamber/runtime/status`
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (ok: boolean, detail?: string, terminal?: boolean, statusCode?: number) => {
      if (settled) return
      settled = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      req.destroy()
      // P2-5: a SUCCESS is the pure {ok:true} shape (the ssh provider's
      // contract) — `statusCode` rides the result only when a real answer
      // produced it, so the ok form never carries a stray
      // statusCode:undefined key that deep-compare callers would trip on.
      const result: TransportVerifyResult & { statusCode?: number } = ok
        ? { ok: true }
        : { ok: false, detail, terminal }
      if (statusCode !== undefined) result.statusCode = statusCode
      resolve(result)
    }
    const headers: Record<string, string> = {}
    // No credentials → NO Authorization header on the probe (design 17
    // §2.3): the gateway itself is the authority on whether auth is needed.
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (cookie !== null) headers.cookie = cookie
    const req = request(url, {
      method: 'GET',
      headers,
      // S23: with a configured pin the probe opens a FRESH https connection
      // with the pin as its trust anchor (rejectUnauthorized: false — the
      // internal-CA case); request dispatch stays gated until that socket's
      // peer key matches, so even credential headers are never queued early.
      ...(insecure || spkiPin === null ? {} : { rejectUnauthorized: false, agent: false }),
    }, res => {
      res.on('error', () => {})
      // 401 = auth required / rejected; 403 = an origin/Host policy
      // rejection (design 17 §5.3: Host→421, Origin→403) — the credentials
      // may be fine but the gateway refuses this deployment's peer. Split
      // the guidance so a missing-token probe is not misreported as a token
      // problem, a policy misconfiguration is not a token problem, and a
      // session-cookie rejection is reported as the password being refused.
      if (res.statusCode === 401) {
        res.resume()
        if (cookie !== null) {
          done(false, 'the gateway rejected the password authentication (401) — re-enter the password', true, 401)
        } else if (token === null) {
          done(false, 'the gateway requires authentication (401) — configure the shared token or password', true, 401)
        } else {
          done(false, 'the gateway rejected the token (401) — check the shared token', true, 401)
        }
        return
      }
      if (res.statusCode === 403) {
        res.resume()
        done(false, 'the gateway refused the request origin/Host policy (403) — check the gateway deployment origin settings', true)
        return
      }
      if (res.statusCode !== 200) {
        const statusCode = res.statusCode ?? 0
        res.resume()
        // Authentication and deterministic client/protocol mistakes require
        // user action. A gateway/local-dsh startup window, overload, reverse-
        // proxy failure, or maintenance response is time-dependent: every 5xx
        // remains transient so the manager's bounded/slow retry machinery can
        // recover without a manual reconnect.
        const terminal = gatewayHttpFailureIsTerminal(statusCode)
        done(false, `the gateway answered HTTP ${res.statusCode ?? '?'} to the runtime identity probe`, terminal)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', chunk => {
        if (settled) return
        size += chunk.length
        if (size > maxBodyBytes) {
          done(false, 'the gateway answered an oversized runtime identity response', true)
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        let status: unknown = null
        try { status = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { status = null }
        if (!isGatewayRuntimeStatus(status)) {
          done(false, 'the gateway answered an unexpected runtime identity response — it does not appear to be a compatible dsh-chamber gateway', true)
          return
        }
        done(true)
      })
    })
    const dispatch = (): void => { req.end() }
    // S23: the secureConnect pre-write pin gate (see the mechanism note above). A pinned
    // request is deliberately NOT ended until the peer key matches.
    if (!insecure && spkiPin !== null) attachSpkiPinVerifier(req, spkiPin, dispatch)
    timer = setTimeout(() => done(false, `the gateway did not answer the runtime identity probe within ${timeoutMs}ms`), timeoutMs)
    timer.unref?.()
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === SPKI_PIN_MISMATCH_CODE) {
        done(false, '证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误', true)
        return
      }
      done(false, 'the gateway did not answer the runtime identity probe')
    })
    if (insecure || spkiPin === null) dispatch()
  })
}

/**
 * Instance spec validation: id (runtime whitelist) + label + host (gateway
 * hostname whitelist) + remotePort (1..65535). No token here — the token is
 * held in the token store, never in the spec/registry. `user`/`sshPort`/
 * `serviceName`/`remoteDshHome` are accepted-but-ignored (normalized to null)
 * so the form/registry shape stays uniform across kinds. v2 (design 17
 * §2.2): this is the `http` TRANSPORT provider — it accepts the shipped target
 * kinds (`dsh` | `gateway`), gated on `transport === 'http'` only. A
 * transport 'ssh' spec is REFUSED (the tunnel provider is the separate ssh
 * provider, design 17 §9.2; mis-serving it as a direct endpoint would bypass
 * the tunnel). When `transport` is missing it is inferred from the kind
 * (gateway→http, accepted; dsh→ssh and a missing kind → the registry
 * migration default {dsh, ssh}, design 17 §2.2 — not this provider's
 * mechanism, refused). `insecureHttp` defaults to false (https).
 */
function isValidGatewayInstance(instance: unknown): instance is TransportInstanceSpec {
  if (instance === null || typeof instance !== 'object') return false
  const record = instance as Record<string, unknown>
  // v2 kind gating: this provider serves the http TRANSPORT for shipped target
  // kinds. A missing kind defaults to {dsh, ssh} (registry migration, design
  // 17 §2.2) — not this provider's mechanism; a missing transport is
  // inferred from kind (gateway→http; anything else → not ours).
  // The shipped HTTP provider knows exactly the semantics of these two
  // targets. An open-ended future kind must register its own provider rather
  // than reaching ready here and failing later at proxy registration.
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
    // S23 (P2-2): an SPKI pin must be a 64-hex sha256, the target must be
    // https — http 模式无 TLS 层，pin 无意义且不得声称任何 TLS 保护（13.4.2/S23）
    // — AND the kind must be 'gateway': a non-gateway kind over https would
    // HALF-execute (the identity probe pins, the reverse proxy refuses pins
    // for non-gateway transports), so the pin is refused outright instead of
    // claiming protection that never happens.
    && (record.spkiPin === undefined || record.spkiPin === null
      || (typeof record.spkiPin === 'string' && SPKI_PIN_PATTERN.test(record.spkiPin)
        && record.insecureHttp !== true && record.kind === 'gateway'))
}

/** The gateway-session origin for a gateway spec — the http(s) origin the
 * transport proxies to, used as the session manager's per-origin cache key
 * (design 17 §9.3: the cookie is cached per origin and injected only into
 * that origin's transport). Scheme from `insecureHttp`, port explicit
 * (URL.origin elides default ports, so the key matches the registration
 * baseUrl). Mirrors verifyGatewayEndpoint's probe URL. P1-2: the spec's SPKI
 * pin (S23) rides the origin so the password LOGIN is pinned exactly like
 * the identity probe — an internal-CA gateway login can then succeed
 * instead of dying as an untrusted-chain network failure (永不 ready). */
function gatewaySessionOriginFor(spec: TransportInstanceSpec): GatewaySessionOrigin {
  return {
    baseUrl: `${spec.insecureHttp ? 'http' : 'https'}://${spec.host}:${spec.remotePort}`,
    insecureHttp: spec.insecureHttp,
    scope: gatewaySessionScopeForConnection(spec),
    ...(spec.spkiPin === undefined || spec.spkiPin === null ? {} : { spkiPin: spec.spkiPin }),
  }
}

/** Map a login-exchange failure onto the probe's terminal/transient verdict
 * (design 17 §7.3): a refused password is deterministic (terminal — the
 * stored password cannot authenticate this deployment), while
 * rate_limited/auth_busy/network are explicitly transient (429/503 backoff,
 * retry can recover). 'other' (e.g. a redirect without the cookie) is a
 * deterministic protocol answer → terminal. */
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
 * SHARED password-session verifyUp flow (design 17 §7.3/§9.3): ensure a login
 * session exists and probe WITH its Cookie. Fast path: a live cached session
 * (12h − 5min, gateway-session.ts) probes directly — only a missing/expired
 * session is exchanged here, so bounded reconnect cycles never re-login (429
 * backoff discipline). A probe 401 — the session cookie was refused/revoked
 * server-side (design 17 §7.1: a server-side password change rotates
 * jwt-secret, killing old cookies) — invalidates the cached session and
 * re-logs in ONCE with the stored password (§9.3: 「401（12h 过期）→ 用存储密码
 * 自动重登一次（尊重 429 退避）→ 仍失败才 terminal」; a rate-limited/busy/network
 * re-login stays transient for the bounded reconnect cycle). The fresh
 * session's probe landing on 401 again is the terminal password-refused state
 * (§7.3 密码被拒: 「重新输入密码」).
 *
 * `probe` performs the identity probe carrying the given cookie — the ONLY
 * transport-specific part: the direct-endpoint gateway provider probes
 * verifyGatewayEndpoint (https, optional SPKI pin), the ssh provider's
 * tunnel branch probes verifyGatewayEndpointViaTunnel (loopback http). One
 * implementation serves both, so the two transport shapes can never drift.
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
      // Token and password are independent OR-principals (design 17 §2.3 /
      // gateway auth.ts): when both are configured, a refused/unavailable
      // password login must not hide a still-valid bearer token. The caller's
      // fallback probe carries ONLY the bearer; success is authoritative. A
      // failed bearer does not replace the password flow's more actionable
      // classification (invalid password vs transient login service).
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
  // 401 with the session cookie: invalidate, then ONE automatic re-login with
  // the stored password (design 17 §9.3). A refused re-login classifies via
  // gatewaySessionFailureToVerify (invalid_credentials/other → terminal,
  // rate_limited/auth_busy/network → transient — the 429 backoff discipline).
  sessionHooks.invalidate?.(origin)
  // This invalidation is owned by the current verifier (a cookie 401), so its
  // one allowed re-login adopts the new generation. Any later external
  // invalidation will change it again and trip the same post-await fences.
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
  // Even the freshly minted session is refused — the stored password cannot
  // authenticate this deployment; the user must re-enter it (§7.3 密码被拒).
  sessionHooks.invalidate?.(origin)
  return { ok: false, detail: 'the gateway rejected the password authentication (401) — re-enter the password', terminal: true }
}

/** The http transport provider: validate → direct-endpoint (no child) →
 * http(s) probe. Serves the GATEWAY target only — the dsh×http combination
 * is disabled (2026-09 user decision): direct-attaching a dsh web profile
 * over http is hard-blocked on the 0.1.2 line (its host answers 401 without
 * the spawn-time browser-auth launch token, which is unrecoverable remotely;
 * see the connection-form schema comment for the re-enable point). ssh is
 * the only dsh transport. `kind` stays the legacy registry key this provider
 * is registered under (main.ts `providers: { gateway: … }`; transport-keyed
 * `{ http: … }` also works). */
export const gatewayProvider: TransportProvider = {
  kind: 'gateway',

  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (!isValidGatewayInstance(input)) return null
    const record = input as unknown as Record<string, unknown>
    // dsh×http disabled (2026-09): refuse at the registry mutation point so
    // the combination can never be created behind the UI (load drops legacy
    // rows the same way; re-enable together with the form schema when
    // upstream exposes token retrieval).
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

  /** DIRECT ENDPOINT mode (design 05 §7.6): the method is ABSENT (not
   * returning null), so the transport-manager never allocates a throwaway
   * 127.0.0.1 port for a provider that spawns no child. */

  /** The probe target is the gateway host:port (the https origin). The IPv6
   * literal is unbracketed here — net.connect takes `::1`, not `[::1]` (the
   * brackets are URL syntax only). */
  probeTarget(spec: TransportInstanceSpec): { host: string; port: number } {
    return { host: spec.host.replace(/^\[(.*)\]$/, '$1'), port: spec.remotePort }
  },

  /** Ready URL: the target http(s) origin (design 17 §9.1/§13.1 — https
   * default, plaintext only when `insecureHttp` was explicitly set; the
   * default ports 80 (http) / 443 (https) are elided). */
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

  /** Identity verification: the gateway target must answer the authenticated
   * gateway-owned runtime status identity, which remains available while its
   * managed dsh is blocked/down (a dsh target never reaches this provider —
   * dsh×http disabled 2026-09; its ssh transport owns the session/list
   * handshake).
   * A missing
   * token is NOT a pre-flight refusal (design 17 §2.3): the probe is sent
   * WITHOUT an Authorization header and the gateway's own answer is
   * classified (a `--no-auth` deployment is ready; a 401 = terminal "configure
   * the token"). A configured token rides the probe as Bearer. A gateway
   * target with a configured password rides the password login session's
   * Cookie. When both exist the probe carries BOTH independent headers; the
   * gateway accepts either principal, so a rotated token can fall back to a
   * valid session and a refused password login can still fall back to a valid
   * bearer (§2.3). Uses spec.host (BRACKETED IPv6 — URL
   * form), NOT endpoint.host (which probeTarget unbrackets for net.connect):
   * the verify URL needs the bracketed literal. */
  verifyUp(spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint): Promise<TransportVerifyResult> {
    void endpoint
    const token = getGatewayToken(spec.id)
    const password = getGatewayPassword(spec.id)
    // A configured password + wired session hooks: ensure a login session and
    // probe with its Cookie plus the independent Bearer when present (the
    // shared verifyGatewayPasswordSession
    // flow — the ssh provider's tunnel branch uses the same implementation,
    // design 17 §9.2/§9.3). Without hooks the probe stays credential-free
    // (the old no-auth behavior — the flow is inert until main.ts wires the
    // gateway-session manager in).
    if (password !== null && sessionHooks.ensureSession !== undefined) {
      return verifyGatewayPasswordSession(gatewaySessionOriginFor(spec), password, cookie =>
        verifyGatewayEndpoint(spec.host, spec.remotePort, token, spec.insecureHttp, GATEWAY_VERIFY_TIMEOUT_MS, GATEWAY_VERIFY_MAX_BODY_BYTES, cookie, spec.spkiPin ?? null),
      token === null ? undefined : () =>
        verifyGatewayEndpoint(spec.host, spec.remotePort, token, spec.insecureHttp, GATEWAY_VERIFY_TIMEOUT_MS, GATEWAY_VERIFY_MAX_BODY_BYTES, null, spec.spkiPin ?? null))
    }
    return verifyGatewayEndpoint(spec.host, spec.remotePort, token, spec.insecureHttp, GATEWAY_VERIFY_TIMEOUT_MS, GATEWAY_VERIFY_MAX_BODY_BYTES, null, spec.spkiPin ?? null)
  },

  /** No child process → no stderr stream. Never called for direct endpoints,
   * but satisfies the interface with a safe no-op classification. */
  classifyStderr(): { log: string; terminalAuth: boolean; enoent: boolean } {
    return { log: '', terminalAuth: false, enoent: false }
  },
}

// ---------------------------------------------------------------------------
// Desktop-synced chamber host packages (design 17 §9.3, 2026-12 Phase 3):
// the gateway no longer ships the two chamber host packages; a connecting
// desktop uploads its own copies through the authenticated
// `PUT /chamber/plugins` surface. The sync is best-effort and idempotent —
// the client skips packages whose version already matches the gateway's
// projection, the gateway answers 200 {changed:false} for byte-identical
// uploads (no restart asked), and it fires after every gateway transport
// ready registration. When anything was actually changed the desktop asks
// the gateway to restart its managed dsh (design 18 controlled restart) so
// the running profile picks the packages up; a failed restart only warns
// (the next natural spawn re-seeds anyway). Version-lock semantics: a
// rebuilt package must bump its version to re-sync (pre-release iteration
// included). The sync rides the REGISTERED transport origin (tunnel loopback
// for ssh), with the tunnel authority override for the Host header.
// ---------------------------------------------------------------------------

/** One local chamber host package ready to sync (main-process files). */
export interface LocalChamberHostPackage {
  name: string
  packageJson: string
  distIndex: string
}

export interface GatewayPluginSyncResult {
  /** True when at least one package was uploaded (a dsh restart was asked). */
  uploaded: boolean
  /** True when the sync was skipped (no local packages to sync). */
  skipped: boolean
  /**
   * Honesty marker (design 21 review P2-B1): true when the sync did NOT
   * complete — a GET/PUT non-200 or a network failure. The renderer-facing
   * manual-sync IPC maps this to {ok:false} so a failure can never project
   * as "already up to date" (the both-false tuple stays reserved for the
   * genuine all-versions-matched case). The fire-and-forget auto path
   * ignores the marker (its outcome was always warn-only).
   */
  failed?: boolean
  /** First failure detail when failed (already sanitized for IPC). */
  error?: string
}

/** Bounded JSON request to a gateway endpoint with the S23 pin discipline. */
function gatewayJsonRequest(
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
  return new Promise((resolve, reject) => {
    const request = options.insecure ? httpRequest : httpsRequest
    const req = request(url, {
      method: options.method,
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.insecure || options.spkiPin === null ? {} : { rejectUnauthorized: false, agent: false }),
    }, res => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', chunk => {
        size += chunk.length
        if (size > 8 * 1024 * 1024) {
          res.destroy()
          reject(new Error('gateway plugin sync response exceeds the size bound'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        let payload: unknown
        try {
          payload = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          payload = null
        }
        resolve({ status: res.statusCode ?? 0, payload })
      })
      res.on('error', error => reject(error))
    })
    req.on('error', error => reject(error))
    const timer = setTimeout(() => {
      req.destroy(new Error('gateway plugin sync timed out'))
    }, options.timeoutMs)
    timer.unref?.()
    req.on('close', () => clearTimeout(timer))
    const dispatch = (): void => {
      if (options.body === undefined) req.end()
      else req.end(JSON.stringify(options.body))
    }
    if (options.spkiPin === null || options.insecure) dispatch()
    else attachSpkiPinVerifier(req, options.spkiPin, dispatch)
  })
}

/** Sync the local chamber host packages into the gateway seed cache. */
export async function syncGatewayChamberPlugins(options: {
  /** Registered transport origin (the ready URL). For an ssh tunnel this is
   * the loopback endpoint the user actually verified — never the remote
   * host:port, which is typically unreachable from the desktop. */
  origin: string
  /** Tunnel Host-header override: the REMOTE gateway authority. The gateway's
   * request policy requires the authority port to equal its listen port,
   * which the tunnel's local port never satisfies. Undefined for direct
   * http(s) targets. */
  authority?: string
  /** Registration auth headers (Authorization/Cookie) — main-process only.
   * May be EMPTY: a `--no-auth` deployment registers headerless and the sync
   * must still run (an auth-requiring gateway answers 401 → warn). */
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
  // Tunnel Host override (design 17 §9.3): CONNECT to the loopback tunnel
  // endpoint but present the REMOTE gateway authority in the Host header —
  // the gateway's request policy requires the authority port to equal its
  // listen port, which the tunnel's local port can never satisfy.
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
        body: { name: pkg.name, files: { 'package.json': pkg.packageJson, 'dist/index.js': pkg.distIndex } },
        insecure,
        spkiPin: options.spkiPin,
        timeoutMs,
      })
      if (put.status !== 200) {
        options.logger.warn(`[dsh-chamber] gateway plugin sync: uploading ${pkg.name} failed (HTTP ${put.status}); the managed dsh keeps running without it`)
        if (firstFailure === null) firstFailure = `uploading ${pkg.name} failed (HTTP ${put.status})`
        continue
      }
      // Byte-identical upload (same version, same bytes) → nothing to apply;
      // only an actual cache change warrants the controlled restart.
      if ((put.payload as { changed?: unknown })?.changed !== true) continue
      uploaded = true
      options.logger.log(`[dsh-chamber] gateway plugin sync: uploaded ${pkg.name} v${localVersion}`)
    }
    if (uploaded) {
      // The running profile picks the seeded packages up only on the next
      // spawn — ask for the controlled restart; a failure only warns (the
      // next natural spawn re-seeds from the cache anyway).
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
        options.logger.warn(`[dsh-chamber] gateway plugin sync: dsh restart after upload failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (firstFailure !== null) {
      return { uploaded, skipped: false, failed: true, error: firstFailure }
    }
    return { uploaded, skipped: false }
  } catch (error) {
    options.logger.warn(`[dsh-chamber] gateway plugin sync failed: ${error instanceof Error ? error.message : String(error)}`)
    return {
      uploaded: false,
      skipped: false,
      failed: true,
      error: `gateway plugin sync failed: ${sanitizeErrorText(error instanceof Error ? error.message : String(error))}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Gateway plugin batch apply + folder materialize (design 21 §6.5, plan
// Phase 4.6): the /chamber/plugins write surface is 202-async — every
// install/remove submission is accepted onto the gateway's serial executor
// queue (opId) or persisted as a deferred intent (intentId; executed at the
// next ready edge). The batch provider therefore:
//  1. submits removes (POST /chamber/plugins/remove) first, then add specs
//     (PUT /chamber/plugins/install) — decision 5 先 remove 后 add — serial,
//     aborting at the FIRST refusal with the honest partial outcome (prior
//     accepted ops already executed);
//  2. unless deferRestart, waits for its own accepted ops to terminally
//     settle (GET /chamber/plugins/tasks — a restart is REFUSED while any
//     executor lease is held) and only then asks for the controlled restart
//     (POST /chamber/runtime/restart → 202) and polls the runtime status
//     projection until the managed dsh settles (the same decision table as
//     the renderer-side pollGatewayReady: restart ok / failed,
//     connectionState ready|degraded fallback, terminal failure states);
//  3. maps the outcome into a result union — ok:false failures that happen
//     after ops were accepted carry the partial outcome so the caller can
//     show exactly what executed before the failure (restart refusal is a
//     failure, never silently swallowed).
//
// Materialize uploads a desktop-built tgz (folder pick → buildPluginTarball
// in plugin-tarball.ts) with the x-plugin-name/x-plugin-version headers and
// maps the 202/400/409/411/413/500 family honestly.
//
// All requests ride the REGISTERED transport origin + auth headers + SPKI
// pin (the sync discipline above): never a renderer-supplied URL or
// credential; `authority` is the ssh-tunnel Host-header override.
// ---------------------------------------------------------------------------

/** Batch apply request/option surface (main.ts maps the IPC payload here). */
export interface GatewayPluginApplyOptions {
  /** Registry specs (`name@spec` | `name`; `file:` refused — folder pushes
   *  go through gatewayChamberMaterialize). */
  add: string[]
  /** Installed-list names to remove (never deferred by the gateway). */
  remove: string[]
  /** true = only record the change; the restart-to-apply is skipped (the
   *  change applies on the gateway's next dsh restart). */
  deferRestart?: boolean
}

export interface GatewayPluginApplyOutcome {
  /** Names whose install/remove submission the executor ACCEPTED (202 +
   *  opId). Accepted ≠ terminally completed: an op that later fails in the
   *  executor surfaces in the batch error (the batch does not restart over
   *  a failed op). */
  installed: string[]
  removed: string[]
  /** true only after a restart 202 AND the status poll confirmed the
   *  managed dsh settled (restart ok, or ready/degraded on legacy
   *  gateways without the restart-outcome field). */
  restarted: boolean
  /** Names whose submission was persisted as a DEFERRED install intent
   *  (202 + intentId): the gateway executes them — restart included — at
   *  the next ready edge; they are never counted as installed here. */
  deferredOps: string[]
}

export type GatewayChamberApplyBatchResult =
  | { ok: true; outcome: GatewayPluginApplyOutcome }
  | { ok: false; error: string; outcome?: GatewayPluginApplyOutcome }

/** Per-request timeout of the apply/materialize HTTP calls. */
export const GATEWAY_APPLY_REQUEST_TIMEOUT_MS = 15_000
/** Executor-settle poll budget: 1s × 120 (the plan's bounded poll). */
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
  /** Registration auth headers — main-process only, may be empty
   *  (a --no-auth deployment). */
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

  // Pre-validate the WHOLE batch before any submission (a malformed item is
  // a client mistake — nothing executes on its account).
  for (const spec of add) {
    if (parseSpecArg(spec) === null) return { ok: false, error: `invalid add spec: ${JSON.stringify(spec)}` }
  }
  for (const name of remove) {
    if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name) || isDeniedPluginName(name)) {
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
    // Remove-before-add (design 21 decision 5 / §5 table row 5 + §6.2 apply
    // row): the batch applies removals FIRST so an upgrade/swap (remove old
    // + add new) never leaves a window where the new plugin is added while
    // the conflicting old one is still installed; failure stops the batch
    // exactly like the per-row serial contract (installs stay untouched when
    // a removal fails).
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
    const detail = error instanceof Error ? error.message : String(error)
    return partialFailure(`gateway plugin apply request failed: ${detail}`)
  }

  // Restart-to-apply (design 21 §6.3): unless the user deferred, wait for
  // the accepted ops to settle (the restart route REFUSES while the
  // executor holds profile-write leases), then ask for the controlled
  // restart and poll the runtime status projection.
  if (!deferRestart && (outcome.installed.length > 0 || outcome.removed.length > 0)) {
    if (opIds.length > 0) {
      const settled = await waitForOpsToSettle({ request, opIds, signal: params.signal, intervalMs: params.settleIntervalMs ?? GATEWAY_APPLY_POLL_INTERVAL_MS, timeoutMs: params.settleTimeoutMs ?? GATEWAY_APPLY_OP_SETTLE_TIMEOUT_MS })
      if (!settled.ok) return { ok: false, error: settled.error, outcome }
    }
    try {
      const restart = await request('POST', '/chamber/runtime/restart')
      if (restart.status !== 202 && restart.status !== 200) {
        // Honest: the batch executed but the restart was refused — never a
        // silent success. The caller surfaces the partial outcome; the user
        // can restart from the instance later (r0).
        return partialFailure(refusalText('restart of the managed dsh', restart.status, restart.payload))
      }
      const polled = await pollRestartSettled({
        request,
        signal: params.signal,
        intervalMs: params.restartPollIntervalMs ?? GATEWAY_APPLY_POLL_INTERVAL_MS,
        timeoutMs: params.restartPollTimeoutMs ?? GATEWAY_APPLY_RESTART_POLL_TIMEOUT_MS,
      })
      if (!polled.ok) {
        // The restart 202 was accepted; the poll failed to confirm
        // readiness — partial outcome, honest about what executed.
        return { ok: false, error: polled.error, outcome }
      }
      outcome.restarted = true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
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

/** Bound the poll loop with abort sensitivity; mirrors the renderer-side
 *  pollGatewayReady sleep/abort discipline. */
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

/** Wait until every accepted opId has terminally settled in the gateway's
 *  task journal (GET /chamber/plugins/tasks). A terminal failed/blocked op
 *  is a loud {ok:false} — the batch must not restart over a failed op.
 *  401/403/404 fail fast; other transient answers keep polling until the
 *  deadline. */
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
      const detail = error instanceof Error ? error.message : String(error)
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
    // Any other answer (5xx / network hiccup while ops still run) is
    // transient — keep polling until the deadline.
    if (Date.now() >= deadline) break
    await abortableSleep(params.intervalMs, params.signal)
  }
  return { ok: false, error: `the gateway has not finished applying the plugin ops within ${params.timeoutMs}ms; no restart was requested — check the instance plugin task list and restart from the instance when it settles` }
}

/** Poll the runtime status projection after a restart 202 (the same
 *  decision table as the renderer pollGatewayReady): restart 'failed' or a
 *  terminal connection state is a loud failure (never success); 'ok', or
 *  ready/degraded without a pending 'running' outcome (legacy gateways),
 *  settles success; 401/403/404 fail fast; everything else keeps polling
 *  until the bounded deadline. */
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
      // dsh is down/restarting — the status endpoint can be transiently
      // unreachable; keep polling until the deadline.
      if (Date.now() >= deadline) break
      await abortableSleep(params.intervalMs, params.signal)
      continue
    }
    if (response.status === 200) {
      const status = response.payload as { connectionState?: unknown; operationError?: unknown; restart?: unknown } | null
      const operationError = typeof status?.operationError === 'string' ? status.operationError : ''
      // A restart rejected AFTER the 202 (a gate that closed between the
      // route pre-checks and the transaction) sets restart:'failed' while
      // connectionState is still 'ready' — loud failure, never success.
      if (status?.restart === 'failed') return fail(operationError)
      if (status?.connectionState === 'error'
        || status?.connectionState === 'restart-exhausted'
        || status?.connectionState === 'stopped') return fail(operationError)
      if (status?.restart === 'ok') return { ok: true }
      // Backward-compatible fallback for gateways without the restart
      // outcome field: 'degraded' counts as success too (process alive,
      // next probe returns to ready).
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

/** Materialize result: ok:true deferred = the submission was persisted as a
 *  deferred install intent (executed at the next ready edge); deferred
 *  false = accepted onto the executor queue. */
export type GatewayChamberMaterializeResult =
  | { ok: true; deferred: boolean }
  | { ok: false; error: string }

/** Raw-body PUT with the S23 pin discipline: the tarball bytes never leave
 *  the machine before the peer key matches a configured pin. */
function gatewayRawBodyPut(
  url: string,
  options: {
    headers: Record<string, string>
    body: Buffer
    insecure: boolean
    spkiPin: string | null
    timeoutMs: number
  },
): Promise<{ status: number; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const request = options.insecure ? httpRequest : httpsRequest
    const req = request(url, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        ...options.headers,
      },
      ...(options.insecure || options.spkiPin === null ? {} : { rejectUnauthorized: false, agent: false }),
    }, res => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', chunk => {
        size += chunk.length
        if (size > 8 * 1024 * 1024) {
          res.destroy()
          reject(new Error('gateway plugin materialize response exceeds the size bound'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        let payload: unknown
        try {
          payload = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          payload = null
        }
        resolve({ status: res.statusCode ?? 0, payload })
      })
      res.on('error', error => reject(error))
    })
    req.on('error', error => reject(error))
    const timer = setTimeout(() => {
      req.destroy(new Error('gateway plugin materialize timed out'))
    }, options.timeoutMs)
    timer.unref?.()
    req.on('close', () => clearTimeout(timer))
    const dispatch = (): void => { req.end(options.body) }
    if (options.spkiPin === null || options.insecure) dispatch()
    else attachSpkiPinVerifier(req, options.spkiPin, dispatch)
  })
}

/** Upload a desktop-built plugin tarball to PUT /chamber/plugins/materialize
 *  with the x-plugin-name / x-plugin-version headers (both pre-validated
 *  here against the shared whitelists + the route's version grammar). The
 *  archive size is re-checked against TARBALL_MAX_ARCHIVE_BYTES before any
 *  byte is sent. Non-202 answers map their {error, code} body honestly. */
export async function gatewayChamberMaterialize(params: {
  /** Instance id (caller-validated). */
  id: string
  /** Registered transport origin (the ready URL; tunnel loopback for ssh). */
  url: string
  /** Registration auth headers — main-process only, may be empty. */
  headers: Record<string, string>
  /** Registered SPKI pin; null = unpinned. */
  spkiPin: string | null
  /** The gzip plugin archive (buildPluginTarball output). */
  tarball: Buffer
  name: string
  version: string
  /** Tunnel Host-header override (the REMOTE gateway authority). */
  authority?: string
  timeoutMs?: number
}): Promise<GatewayChamberMaterializeResult> {
  const { url } = params
  if (typeof params.name !== 'string' || !PLUGIN_NAME_PATTERN.test(params.name) || isDeniedPluginName(params.name)) {
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
      timeoutMs: params.timeoutMs ?? GATEWAY_MATERIALIZE_TIMEOUT_MS,
    })
    if (response.status !== 202) {
      const record = response.payload as { error?: unknown; code?: unknown } | null
      const bodyError = record !== null && typeof record.error === 'string' && record.error !== '' ? record.error : '(no error body)'
      const code = record !== null && typeof record.code === 'string' && record.code !== '' ? record.code : null
      return { ok: false, error: `materialize of ${params.name}@${params.version} refused (HTTP ${response.status}${code === null ? '' : `, code ${code}`}): ${bodyError}` }
    }
    const accepted = response.payload as { deferred?: unknown } | null
    return { ok: true, deferred: accepted?.deferred === true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `gateway plugin materialize failed: ${detail}` }
  }
}
