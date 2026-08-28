/**
 * The `http` transport provider (design 17 §2.2/§9.2): a DIRECT ENDPOINT
 * provider — no local tunnel child process. v2 semantics: it serves the
 * `http` TRANSPORT for ANY target kind (`dsh` | `gateway`, returned as-is —
 * design 17 §2.2: one provider per transport, serving both target kinds; the
 * kind decides target semantics, auth-header injection etc., §2.1). The
 * "endpoint" is the target's http(s) URL (scheme from `insecureHttp`,
 * default https), reached as-is. A gateway target may be authenticated with
 * a shared bearer token and/or a login password, held in main-process memory
 * (mirrored to `<userData>/gateway-secrets.json`, schemaVersion 2, 0600, for
 * restart auto-connect — safeStorage-encrypted blobs with a documented 0600
 * plaintext fallback, design 17 §12); a dsh target NEVER injects auth
 * headers (design 17 §2.1/§9.3). An over-ssh spec (transport 'ssh') is
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
 * Security discipline (design 17 §11 S5/S12/S22): credentials never enter the
 * registry, logs, or any renderer projection; the mirror file is 0600 +
 * atomic write; a corrupt file fails loudly (preserved as `.corrupt`), never
 * silently treated as empty. S22 availability flip (P1-1): a value written as
 * an ENCRYPTED blob while crypto was available is CORRUPT when a later
 * startup loads it without working crypto (or when the blob fails to decrypt)
 * — a blob is never silently adopted as the plaintext credential, even when
 * its base64 shape happens to pass the visible-ASCII/length gates.
 */

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { ClientRequest } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { INSTANCE_ID_PATTERN, MAX_INSTANCE_LABEL_CHARS } from './transport-provider.ts'
import type {
  TransportInstanceSpec,
  TransportKind,
  TransportProbeEndpoint,
  TransportProvider,
  TransportVerifyResult,
} from './transport-provider.ts'
import type { GatewaySessionOrigin, GatewaySessionResult } from './gateway-session.ts'

/** Gateway hostname whitelist: a bare hostname/IPv4 (NO colon — the port is
 * carried separately in `remotePort`, never embedded in the host) or a fully
 * bracketed IPv6 literal. This differs from the ssh whitelist: ssh passes the
 * host into argv (where a colon is inert), but the gateway builds URLs from
 * it, so an embedded `host:8443` would silently override/break the URL port. */
export const GATEWAY_HOST_PATTERN = /^(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:.]+\])$/
export const MAX_GATEWAY_HOST_CHARS = 253
export const MAX_GATEWAY_TOKEN_CHARS = 4096
export const MIN_GATEWAY_TOKEN_CHARS = 32
export const MAX_GATEWAY_PASSWORD_CHARS = 1024
export const MIN_GATEWAY_PASSWORD_CHARS = 12
const GATEWAY_CREDENTIAL_HEADER_PATTERN = /^[\x20-\x7e]+$/

// ---------------------------------------------------------------------------
// SPKI certificate pinning (design 17 §13.4.2 / S23): an https-only optional
// gate — the user pins the expected server certificate's SPKI fingerprint;
// the identity probe AND the reverse proxy reject any peer whose public key
// does not match. This directly solves the internal-CA trust pain: a Caddy
// `tls internal` gateway needs no NODE_EXTRA_CA_CERTS injection — the pin IS
// the trust anchor for that single connection.
//
// Mechanism note (verified on Node 22.22.3): checkServerIdentity's error
// return is silently IGNORED when `rejectUnauthorized: false`, and with
// `rejectUnauthorized: true` an untrusted (internal-CA) chain fails BEFORE
// checkServerIdentity runs — so neither combination can enforce a pin against
// an internal CA. The pin check therefore runs on the TLS socket's
// 'secureConnect' event with `rejectUnauthorized: false` (the pin alone
// decides trust) and `agent: false` (every pinned request opens a fresh
// connection, so 'secureConnect' always fires): a mismatch destroys the
// request with SPKI_PIN_MISMATCH_CODE, which the caller classifies (probe →
// terminal, proxy → 502 upstream_failed).
// ---------------------------------------------------------------------------

/** A valid SPKI pin: exactly 64 hex chars (hex sha256 of the SPKI DER). */
export const SPKI_PIN_PATTERN = /^[0-9a-fA-F]{64}$/

/** Error code attached to the destroy() error of a rejected pin. */
export const SPKI_PIN_MISMATCH_CODE = 'ERR_SPKI_PIN_MISMATCH'

/** The hex sha256 of a peer certificate's SPKI DER (S23) — the digest the
 * user pins. `rawDer` is the peer certificate's DER (TLSSocket
 * getPeerCertificate().raw): X509Certificate exposes the KeyObject whose
 * SPKI export is the canonical fingerprint. */
export function spkiPinOfPeerCertificate(rawDer: Buffer): string {
  return createHash('sha256')
    .update(new X509Certificate(rawDer).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
}

/** Attach the SPKI pin gate to an outbound https request (S23): on TLS
 * handshake completion the peer certificate's SPKI digest is compared
 * case-insensitively with the pinned value; a mismatch destroys the request
 * with SPKI_PIN_MISMATCH_CODE. Callers must ALSO pass `rejectUnauthorized:
 * false` (the pin replaces CA trust for this connection — the internal-CA use
 * case) and `agent: false` (so 'secureConnect' always fires). MUST stay
 * byte-for-byte consistent with proxy-forward.ts's copy of this helper — the
 * packaged desktop cannot import the control plane (workspace TS sources are
 * excluded from the asar), so the two files keep identical implementations. */
export function attachSpkiPinVerifier(req: ClientRequest, pin: string): void {
  req.on('socket', (socket: NodeJS.Socket) => {
    ;(socket as TLSSocket).once('secureConnect', () => {
      let digest: string
      try {
        digest = spkiPinOfPeerCertificate((socket as TLSSocket).getPeerCertificate().raw)
      } catch {
        const error: NodeJS.ErrnoException = new Error('the gateway certificate could not be read for the SPKI pin check')
        error.code = SPKI_PIN_MISMATCH_CODE
        req.destroy(error)
        return
      }
      if (digest.toLowerCase() !== pin.toLowerCase()) {
        const error: NodeJS.ErrnoException = new Error('SPKI pin mismatch')
        error.code = SPKI_PIN_MISMATCH_CODE
        req.destroy(error)
      }
    })
  })
}

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

/** Validate a login password — mirrors the gateway config gate (design 17
 * §5.1: 密码长度 12–1024，visible ASCII). */
export function gatewayPasswordValidationError(password: string | null): string | null {
  if (password === null || password === '') return null
  if (!GATEWAY_CREDENTIAL_HEADER_PATTERN.test(password)) {
    return 'gateway password must contain visible ASCII characters only'
  }
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

/** Timeout of the one-shot gateway dsh identity probe (verifyUp). */
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
// `<userData>/gateway-secrets.json` (schemaVersion 2, 0600, atomic write) so
// a token/password gateway auto-connects after restart. Values are encrypted
// via the configured SecretCryptoAdapter when available (Electron safeStorage
// in the shell; base64 blobs), plaintext when not (the documented fallback).
// Never in the registry, never logged, never exposed to the renderer. Entries
// are dropped on instance removal / explicit clear (§12 删除实例/显式清除即删).
// ---------------------------------------------------------------------------

/** Encryption boundary for the credential mirror (design 17 §13.4.1):
 * `encrypt`/`decrypt` translate between a plaintext credential and its
 * durable blob. `decrypt` must THROW when given a non-blob: the store reads
 * a throwing decrypt as "this value was written while encryption was
 * unavailable" and falls back to the raw value — the documented plaintext
 * fallback, never a silent failure or a false corrupt. The default adapter
 * reports unavailable and never encrypts. */
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

/** The credentials mirror path; null = memory-only (tests). */
let secretFile: string | null = null
/** The active crypto adapter (defaults to plaintext). */
let secretCrypto: SecretCryptoAdapter = plaintextSecretCrypto

/** The legacy (schemaVersion 1) mirror file name, migrated from on first
 * load (design 17 §12): `<userData>/gateway-tokens.json` → the new file. */
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

/** A loaded credential must pass its table's gate exactly like a fresh one
 * (length + visible ASCII). '' is INVALID here — the null-able validation
 * entry points treat '' as "no credential", but an empty stored value is
 * corrupt. */
function isValidCredentialValue(value: string, minChars: number, maxChars: number): boolean {
  return value.length >= minChars && value.length <= maxChars && GATEWAY_CREDENTIAL_HEADER_PATTERN.test(value)
}

/**
 * Does a stored value have the SHAPE of an encrypted blob rather than a
 * plaintext credential (S22, P1-1)? The Electron safeStorage mirror stores
 * `base64(encryptString(plain))` — a long, pure-base64 string carrying at
 * least one base64-only punctuation char (`+` `/` `=`): ciphertext is uniform
 * random bytes, so a real blob almost always contains `+`/`/`, and any
 * ciphertext length not divisible by 3 adds `=` padding. Typical plaintext
 * credentials (hex, alphanumeric, `-` `_` `.` — the shapes the credential
 * gate is designed for) never trip this. Deliberately CONSERVATIVE: a false
 * positive turns the whole file corrupt (loud, preserved, the user re-enters
 * the credential), while a false negative would silently hand a blob to the
 * login as the token/password — the S22 violation this exists to prevent.
 *
 * Length floor: the shortest REAL ciphertext (safeStorage of the minimum
 * 12-char password — AES-GCM iv+ciphertext+tag overhead) is ~56 base64
 * chars, so anything below the floor cannot be a genuine blob and short
 * plaintext credentials are never at risk.
 */
function looksLikeEncryptedBlob(value: string): boolean {
  if (value.length < 32) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  return /[+/=]/.test(value)
}

/** Load and validate ONE credential table into plaintext, or null when any
 * entry is structurally invalid (reserved id / bad id / non-string value), is
 * an UNREADABLE ENCRYPTED BLOB (`resolve` → null), or fails the credential
 * gate. `resolve` maps a stored value to the plaintext credential BEFORE the
 * value gate: decrypt-or-raw for v2 (S22 flip detection), identity for v1
 * (schemaVersion 1 values are always plaintext — never encrypted). A null
 * result drives the caller's preserveInvalidSecretFile — the WHOLE file is
 * corrupt (loud, never silently empty). */
function loadCredentialTable(
  table: Record<string, unknown>,
  minChars: number,
  maxChars: number,
  resolve: (blob: string) => string | null,
): Map<string, string> | null {
  const out = new Map<string, string>()
  for (const [id, value] of Object.entries(table)) {
    if (id === 'local' || !INSTANCE_ID_PATTERN.test(id) || typeof value !== 'string') return null
    const plaintext = resolve(value)
    if (plaintext === null || !isValidCredentialValue(plaintext, minChars, maxChars)) return null
    out.set(id, plaintext)
  }
  return out
}

/** Resolve a stored value to the plaintext credential, or null when the value
 * is an UNREADABLE ENCRYPTED BLOB — the corrupt-file signal (S22, P1-1). The
 * documented plaintext fallback (design 17 §12) stays EXACTLY as designed for
 * values written while encryption was unavailable: with a working crypto a
 * NON-blob-shaped value that fails to decrypt is that fallback, and with
 * crypto unavailable a non-blob-shaped value IS the fallback text. A
 * BLOB-SHAPED value is never returned raw: when crypto is available it must
 * decrypt (a throwing decrypt on a blob is a corrupted/unreadable blob, not
 * plaintext), and when crypto is unavailable it is the residue of an
 * encrypted write that can no longer be read (the safeStorage availability
 * flip) — using either as a plaintext credential would silently send
 * ciphertext as the token/password. */
function resolveStoredValue(blob: string): string | null {
  if (secretCrypto.isAvailable()) {
    try {
      return secretCrypto.decrypt(blob)
    } catch {
      // Decrypt failed: a plaintext value written while encryption was
      // unavailable is the documented fallback; a blob-shaped value that
      // cannot be decrypted is CORRUPT (解密尝试失败, S22).
      return looksLikeEncryptedBlob(blob) ? null : blob
    }
  }
  // Crypto unavailable: plaintext values (written in fallback mode) load
  // as-is; a blob-shaped value (written while crypto WAS available — the
  // availability flip) is CORRUPT, never a plaintext credential (S22).
  return looksLikeEncryptedBlob(blob) ? null : blob
}

/**
 * Point the gateway credentials store at its mirror file (main.ts, once at
 * startup) and load existing entries. Missing file = empty set (first run),
 * except a schemaVersion 1 `gateway-tokens.json` beside the target file is
 * MIGRATED (design 17 §12): tokens read → v2 written (encrypted via `crypto`)
 * → legacy file deleted; a migration failure is LOUD but never blocks startup
 * (the legacy file is kept — and once the v2 write succeeded, every later
 * startup with a valid v2 file present retries the leftover unlink, see
 * `retryLegacyTokenFileRemoval`). A corrupt file fails LOUDLY (preserved as
 * `<file>.corrupt`), never silently empty — including the S22 availability
 * flip: encrypted blobs written while crypto was available are corrupt when
 * loaded without working crypto (or when they fail to decrypt), and are
 * NEVER adopted as plaintext credentials (P1-1). `crypto` defaults to the
 * plaintext adapter (no encryption — old-test semantics).
 * @returns a loud notice string (corrupt-preserved / migration failure) or null.
 */
export function configureGatewaySecretStore(file: string | null, crypto?: SecretCryptoAdapter): string | null {
  secretFile = file
  secretCrypto = crypto ?? plaintextSecretCrypto
  tokens.clear()
  passwords.clear()
  if (file === null) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
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
    // Legacy schemaVersion 1 file AT the configured path (main.ts still
    // points at <userData>/gateway-tokens.json today): load the tokens in
    // place — restart auto-connect keeps working; the next persist rewrites
    // the mirror as schemaVersion 2. v1 values are always plaintext (never
    // encrypted), so the identity resolver applies — no blob detection.
    if (!isPlainRecord(parsed.tokens)) return preserveInvalidSecretFile(file)
    const v1Tokens = loadCredentialTable(parsed.tokens, MIN_GATEWAY_TOKEN_CHARS, MAX_GATEWAY_TOKEN_CHARS, blob => blob)
    if (v1Tokens === null) return preserveInvalidSecretFile(file)
    for (const [id, value] of v1Tokens) tokens.set(id, value)
    return null
  }
  // schemaVersion 2: BOTH tables are required and validated (design 17 §12
  // corrupt 检测按新 schema 扩展 — tokens AND passwords). Each stored value is
  // resolved to plaintext (decrypt-or-raw with the S22 flip detection)
  // before the value gate.
  if (parsed.schemaVersion !== 2 || !isPlainRecord(parsed.tokens) || !isPlainRecord(parsed.passwords)) {
    return preserveInvalidSecretFile(file)
  }
  const loadedTokens = loadCredentialTable(parsed.tokens, MIN_GATEWAY_TOKEN_CHARS, MAX_GATEWAY_TOKEN_CHARS, resolveStoredValue)
  const loadedPasswords = loadCredentialTable(parsed.passwords, MIN_GATEWAY_PASSWORD_CHARS, MAX_GATEWAY_PASSWORD_CHARS, resolveStoredValue)
  if (loadedTokens === null || loadedPasswords === null) return preserveInvalidSecretFile(file)
  for (const [id, value] of loadedTokens) tokens.set(id, value)
  for (const [id, value] of loadedPasswords) passwords.set(id, value)
  // A legacy file left behind by a migration whose v2 write succeeded but
  // whose unlink failed is retried on every startup that loads a VALID v2
  // file (design 17 §12: idempotent, failure kept silent — the v2 file is
  // authoritative). NOT run for a corrupt v2 file: the legacy tokens are the
  // only recoverable copy and must survive until a clean load.
  retryLegacyTokenFileRemoval(file)
  return null
}

/** Backward-compatible alias for the shell's current call site (main.ts and
 * the transport-manager tests still name the token store): the credentials
 * store with the default plaintext adapter. Remove once main.ts switches to
 * `configureGatewaySecretStore(<userData>/gateway-secrets.json)`. */
export function configureGatewayTokenStore(file: string | null): string | null {
  return configureGatewaySecretStore(file, undefined)
}

/** Migrate a schemaVersion 1 `gateway-tokens.json` beside the configured v2
 * file (design 17 §12): tokens → v2 (encrypted via the active crypto) →
 * delete the legacy file. Any failure is LOUD and non-blocking: the legacy
 * file is KEPT (never renamed, never silently ignored — the next startup
 * retries). */
function migrateLegacyTokenFile(file: string): string | null {
  const legacyPath = join(dirname(file), LEGACY_TOKEN_FILE_NAME)
  // The configured path IS the legacy file (current main.ts wiring): the v1
  // in-place load above handles it; nothing separate to migrate.
  if (legacyPath === file) return null
  let text: string
  try {
    text = readFileSync(legacyPath, 'utf8')
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
  try {
    persistGatewaySecrets(migrated, new Map())
  } catch (error) {
    return `migrating the legacy gateway token file failed: ${String(error)}; the legacy file is kept at ${legacyPath}`
  }
  for (const [id, value] of migrated) tokens.set(id, value)
  try {
    rmSync(legacyPath)
  } catch (error) {
    return `migrated gateway tokens to ${file}, but could not remove the legacy file ${legacyPath}: ${String(error)}`
  }
  return null
}

/** Retry the legacy v1 file deletion (design 17 §12): when a migration's v2
 * write succeeded but its `rmSync` failed, the legacy file survives (loud
 * notice, non-blocking) — and `configureGatewaySecretStore` only ran the
 * migration on a MISSING v2 file, so that failure was never retried. Every
 * later startup that loads a valid v2 file calls this: a leftover legacy file
 * is unlinked again. Idempotent and best-effort — a missing legacy file is a
 * no-op and a persistent removal failure is SILENT (the v2 file is
 * authoritative; the retry must not spam or block startup). Only runs on a
 * VALID v2 load: a corrupt v2 file keeps the legacy tokens as the only
 * recoverable copy. */
function retryLegacyTokenFileRemoval(file: string): void {
  const legacyPath = join(dirname(file), LEGACY_TOKEN_FILE_NAME)
  // The configured path IS the legacy file (the in-place v1 load path): there
  // is no separate file beside it to remove.
  if (legacyPath === file) return
  if (!existsSync(legacyPath)) return
  try {
    rmSync(legacyPath)
  } catch {
    // Best-effort, silent — the v2 file is authoritative.
  }
}

/** Set or clear the token for one instance (null/'' = clear). Persists the
 * durable mirror when configured (write-through: the live state changes only
 * after its durable mirror succeeds). Design 17 §2.3: token and password are
 * INDEPENDENT nullable credentials — a token clear NEVER touches the
 * instance's password. The whole-instance scrub (instance removal /
 * same-kind retarget, design 17 §12 删除实例/显式清除即删) is the explicit
 * `setInstanceSecrets(id, null, null)` primitive, used by main.ts's
 * `clearStoredSecrets`. */
export function setGatewayToken(id: string, token: string | null): void {
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
  if (token === null || token === '') nextTokens.delete(id)
  else nextTokens.set(id, token)
  persistGatewaySecrets(nextTokens, nextPasswords)
  commitGatewaySecrets(nextTokens, nextPasswords)
}

/** Set or clear the login password for one instance (null/'' = clear) —
 * design 17 §2.3: token and password are INDEPENDENT credentials, so an
 * explicit password clear never touches the token. Write-through like the
 * token setter. */
export function setGatewayPassword(id: string, password: string | null): void {
  if (id === 'local' || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing password for invalid instance id ${JSON.stringify(id)}`)
  }
  const passwordError = gatewayPasswordValidationError(password)
  if (passwordError !== null) throw new Error(passwordError)
  if ((password === null || password === '') && !passwords.has(id)) return
  const nextTokens = new Map(tokens)
  const nextPasswords = new Map(passwords)
  if (password === null || password === '') nextPasswords.delete(id)
  else nextPasswords.set(id, password)
  persistGatewaySecrets(nextTokens, nextPasswords)
  commitGatewaySecrets(nextTokens, nextPasswords)
}

/** Set or clear BOTH credentials for one instance in a SINGLE atomic persist
 * (null/'' = clear each dimension) — the whole-instance scrub primitive for
 * main.ts's `clearStoredSecrets` (instance removal / same-kind retarget,
 * design 17 §12 删除实例/显式清除即删). The per-dimension setters keep token
 * and password independent (§2.3); this explicit dual-set/clear is the ONLY
 * path that writes both at once. Write-through like the single setters; a
 * clear of an id that owns neither credential is a disk no-op. */
export function setInstanceSecrets(id: string, token: string | null, password: string | null): void {
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
  if (token === null || token === '') nextTokens.delete(id)
  else nextTokens.set(id, token)
  if (password === null || password === '') nextPasswords.delete(id)
  else nextPasswords.set(id, password)
  persistGatewaySecrets(nextTokens, nextPasswords)
  commitGatewaySecrets(nextTokens, nextPasswords)
}

/** The stored token for one instance, or null. */
export function getGatewayToken(id: string): string | null {
  return tokens.get(id) ?? null
}

/** The stored login password for one instance, or null. */
export function getGatewayPassword(id: string): string | null {
  return passwords.get(id) ?? null
}

function commitGatewaySecrets(nextTokens: ReadonlyMap<string, string>, nextPasswords: ReadonlyMap<string, string>): void {
  tokens.clear()
  for (const [entryId, entryToken] of nextTokens) tokens.set(entryId, entryToken)
  passwords.clear()
  for (const [entryId, entryPassword] of nextPasswords) passwords.set(entryId, entryPassword)
}

/** Mirror the in-memory credential maps to the durable file (schemaVersion 2,
 * 0600, atomic: tmp → fsync → rename — the repo's atomic-write convention;
 * rename keeps the tmp's 0600). Values are encrypted when the active crypto
 * is available, plaintext otherwise (the documented fallback). */
function persistGatewaySecrets(nextTokens: ReadonlyMap<string, string>, nextPasswords: ReadonlyMap<string, string>): void {
  if (secretFile === null) return
  const encode = (value: string): string => secretCrypto.isAvailable() ? secretCrypto.encrypt(value) : value
  const payload = `${JSON.stringify({
    schemaVersion: 2,
    tokens: Object.fromEntries([...nextTokens].map(([id, value]) => [id, encode(value)])),
    passwords: Object.fromEntries([...nextPasswords].map(([id, value]) => [id, encode(value)])),
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
// probes without auth (the old behavior) until the shell wires the manager
// in.
// ---------------------------------------------------------------------------

/** The session hooks surface (mirrors GatewaySessionManager's three
 * operations, gateway-session.ts). Each method is optional: a partially
 * wired provider degrades to what it has. */
export interface GatewaySessionProviderHooks {
  /** POST /auth/login with the stored password; resolves the header-ready
   * cookie or a classified failure. Absent = the password flow is off. */
  ensureSession?(origin: GatewaySessionOrigin, password: string): Promise<GatewaySessionResult>
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
  sessionHooks = hooks ?? {}
}

/** Read access to the active session hooks (design 17 §9.2/§9.3): the ssh
 * provider's tunnel branch (ssh-provider.ts) consults the SAME hooks main.ts
 * wired via configureGatewaySessionProvider — one wiring point serves both
 * transport shapes, so the gateway-over-ssh password flow can never drift
 * from the direct-endpoint flow. */
export function getGatewaySessionHooks(): GatewaySessionProviderHooks {
  return sessionHooks
}

/** The credential mirror's storage mode (design 17 §13.4.1 / S22): whether
 * the active crypto adapter is available — values are written as safeStorage-
 * encrypted blobs ('safeStorage') or as the documented 0600 plaintext
 * fallback ('plaintext'). Read-only, global per store, never persisted;
 * merged into instances_get as a non-secret projection so the fallback path
 * is visible in the settings UI. Defaults to 'plaintext' (the inert adapter)
 * until main.ts configures a real one. */
export function gatewaySecretStorageMode(): 'safeStorage' | 'plaintext' {
  return secretCrypto.isAvailable() ? 'safeStorage' : 'plaintext'
}

// ---------------------------------------------------------------------------
// Gateway endpoint identity verification (design 17 §7 step 4): the gateway
// URL must answer the dsh host.describe wire handshake WITH the bearer token
// before the runtime may declare the instance ready. Mirrors ssh-provider's
// verifyDshEndpoint, but over https and with an Authorization header.
// ---------------------------------------------------------------------------

/**
 * POST /api/host.describe to the gateway and require a valid server-response
 * echo (result.ok === true). The token may be null: a NO-CREDENTIAL probe is
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
    const url = `${insecure ? 'http' : 'https'}://${host}:${port}/api/host.describe`
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
    const rpcId = randomUUID()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // No credentials → NO Authorization header on the probe (design 17
    // §2.3): the gateway itself is the authority on whether auth is needed.
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (cookie !== null) headers.cookie = cookie
    const req = request(url, {
      method: 'POST',
      headers,
      // S23: with a configured pin the probe opens a FRESH https connection
      // with the pin as its trust anchor (rejectUnauthorized: false — the
      // internal-CA case) and the socket verifier destroys it on mismatch.
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
        done(false, `the gateway answered HTTP ${res.statusCode ?? '?'} to the dsh identity probe`, terminal)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', chunk => {
        if (settled) return
        size += chunk.length
        if (size > maxBodyBytes) {
          done(false, 'the gateway answered an oversized dsh identity probe response', true)
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        let envelope: { type?: unknown; rpcId?: unknown; result?: { ok?: unknown } } | null = null
        try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { envelope = null }
        if (envelope?.type !== 'server-response'
          || envelope.rpcId !== rpcId
          || typeof envelope.result !== 'object' || envelope.result === null
          || envelope.result.ok !== true) {
          done(false, 'the gateway answered an unexpected dsh identity probe response — it does not appear to be a dsh-gateway', true)
          return
        }
        done(true)
      })
    })
    // S23: the socket-level pin gate (see the mechanism note above). Attached
    // synchronously after request() so the mismatch destroy is observed below.
    if (!insecure && spkiPin !== null) attachSpkiPinVerifier(req, spkiPin)
    timer = setTimeout(() => done(false, `the gateway did not answer the dsh identity probe within ${timeoutMs}ms`), timeoutMs)
    timer.unref?.()
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === SPKI_PIN_MISMATCH_CODE) {
        done(false, '证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误', true)
        return
      }
      done(false, 'the gateway did not answer the dsh identity probe')
    })
    req.end(JSON.stringify({ type: 'client-request', rpcId, method: 'host.describe', payload: {} }))
  })
}

/**
 * Instance spec validation: id (runtime whitelist) + label + host (gateway
 * hostname whitelist) + remotePort (1..65535). No token here — the token is
 * held in the token store, never in the spec/registry. `user`/`sshPort`/
 * `serviceName`/`remoteDshHome` are accepted-but-ignored (normalized to null)
 * so the form/registry shape stays uniform across kinds. v2 (design 17
 * §2.2): this is the `http` TRANSPORT provider — it accepts ANY target kind
 * (`dsh` | `gateway`, kept as-is), gated on `transport === 'http'` only. A
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
  // v2 kind gating: this provider serves the http TRANSPORT for any target
  // kind. A missing kind defaults to {dsh, ssh} (registry migration, design
  // 17 §2.2) — not this provider's mechanism; a missing transport is
  // inferred from kind (gateway→http; anything else → not ours).
  if (typeof record.kind !== 'string') return false
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
): Promise<TransportVerifyResult> {
  const cached = sessionHooks.cachedCookie !== undefined ? sessionHooks.cachedCookie(origin) : null
  let cookie: string
  if (cached !== null) {
    cookie = cached
  } else {
    const login = await sessionHooks.ensureSession!(origin, password)
    if (!login.ok) return gatewaySessionFailureToVerify(login)
    cookie = login.cookie
  }
  const first = await probe(cookie)
  if (first.ok || first.statusCode !== 401) return first
  // 401 with the session cookie: invalidate, then ONE automatic re-login with
  // the stored password (design 17 §9.3). A refused re-login classifies via
  // gatewaySessionFailureToVerify (invalid_credentials/other → terminal,
  // rate_limited/auth_busy/network → transient — the 429 backoff discipline).
  sessionHooks.invalidate?.(origin)
  const relogin = await sessionHooks.ensureSession!(origin, password)
  if (!relogin.ok) return gatewaySessionFailureToVerify(relogin)
  const reprobe = await probe(relogin.cookie)
  if (reprobe.ok || reprobe.statusCode !== 401) return reprobe
  // Even the freshly minted session is refused — the stored password cannot
  // authenticate this deployment; the user must re-enter it (§7.3 密码被拒).
  sessionHooks.invalidate?.(origin)
  return { ok: false, detail: 'the gateway rejected the password authentication (401) — re-enter the password', terminal: true }
}

/** The http transport provider: validate → direct-endpoint (no child) →
 * http(s) probe. Serves both target kinds (design 17 §2.2); `kind` stays the
 * legacy registry key this provider is registered under (main.ts
 * `providers: { gateway: … }`; transport-keyed `{ http: … }` also works). */
export const gatewayProvider: TransportProvider = {
  kind: 'gateway',

  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (!isValidGatewayInstance(input)) return null
    const record = input as unknown as Record<string, unknown>
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

  /** Identity verification: the target must answer host.describe. A missing
   * token is NOT a pre-flight refusal (design 17 §2.3): the probe is sent
   * WITHOUT an Authorization header and the gateway's own answer is
   * classified (a `--no-auth` deployment is ready; a 401 = terminal "configure
   * the token"). A configured token rides the probe as Bearer. Kind decides
   * whether auth applies (dsh target: never; gateway target: optional,
   * design 17 §2.1) — the token store is keyed by instance id, so a dsh
   * target with a stale token entry still probes without auth. A gateway
   * target with a configured password (and no token) rides the password
   * login session's Cookie instead (token priority: when both exist the
   * Bearer authenticates alone, §2.3). Uses spec.host (BRACKETED IPv6 — URL
   * form), NOT endpoint.host (which probeTarget unbrackets for net.connect):
   * the verify URL needs the bracketed literal. */
  verifyUp(spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint): Promise<TransportVerifyResult> {
    void endpoint
    const token = spec.kind === 'gateway' ? getGatewayToken(spec.id) : null
    // Token priority (design 17 §2.3): when both credentials are configured
    // the Bearer token authenticates alone — the password/session flow is
    // skipped entirely.
    if (token !== null) {
      return verifyGatewayEndpoint(spec.host, spec.remotePort, token, spec.insecureHttp, GATEWAY_VERIFY_TIMEOUT_MS, GATEWAY_VERIFY_MAX_BODY_BYTES, null, spec.spkiPin ?? null)
    }
    const password = spec.kind === 'gateway' ? getGatewayPassword(spec.id) : null
    // No token + a configured password + wired session hooks: ensure a login
    // session and probe with its Cookie (the shared verifyGatewayPasswordSession
    // flow — the ssh provider's tunnel branch uses the same implementation,
    // design 17 §9.2/§9.3). Without hooks the probe stays credential-free
    // (the old no-auth behavior — the flow is inert until main.ts wires the
    // gateway-session manager in).
    if (password !== null && sessionHooks.ensureSession !== undefined) {
      return verifyGatewayPasswordSession(gatewaySessionOriginFor(spec), password, cookie =>
        verifyGatewayEndpoint(spec.host, spec.remotePort, null, spec.insecureHttp, GATEWAY_VERIFY_TIMEOUT_MS, GATEWAY_VERIFY_MAX_BODY_BYTES, cookie, spec.spkiPin ?? null))
    }
    return verifyGatewayEndpoint(spec.host, spec.remotePort, null, spec.insecureHttp, GATEWAY_VERIFY_TIMEOUT_MS, GATEWAY_VERIFY_MAX_BODY_BYTES, null, spec.spkiPin ?? null)
  },

  /** No child process → no stderr stream. Never called for direct endpoints,
   * but satisfies the interface with a safe no-op classification. */
  classifyStderr(): { log: string; terminalAuth: boolean; enoent: boolean } {
    return { log: '', terminalAuth: false, enoent: false }
  },
}
