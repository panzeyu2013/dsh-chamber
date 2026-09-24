/**
 * Gateway persistence: the gateway's OWN state, physically separate from dsh's
 * $DSH_HOME; credentials follow a 0600 atomic-file discipline — never plaintext
 * in a store doc.
 *
 * Credentials are SERVER STATE, not deployment config: each file is a
 * schemaVersion-2 JSON envelope
 *    `{schemaVersion:2, source:'config'|'runtime', updatedAt:<epoch ms>,
 *    verifier|hash:'scrypt$salt$hash'}`.
 * `source:'config'` records are re-asserted by seeding on every startup;
 * `source:'runtime'` records are authoritative and never overwritten (legacy v1
 * files read as config-sourced and migrate on write). The state ROOT is the caller's
 * writer lease — this module only asserts its root/scope. */

import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  removePrivateFileNoFollow,
  type PrivateFileIdentity,
  type StateRootLease,
} from '@dsh-chamber/control-plane'
import { readPrivateEntryOrNull } from './private-read.ts'

export interface GatewayStoreLogger { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }

/** Credential provenance: `config` records are re-asserted by seeding; `runtime` records stay authoritative. */
export type CredentialSource = 'config' | 'runtime'

/** A persisted credential: the raw `scrypt$salt$hash` verifier plus provenance and epoch-ms write time. */
export interface CredentialRecord {
  verifier: string
  source: CredentialSource
  updatedAt: number
}

/** Non-secret projection: provenance + last-write time ONLY; `null` means unset. The verifier/hash never leaves the file. */
export interface CredentialProjection {
  password: { set: true; source: CredentialSource; updatedAt: number } | null
  token: { set: true; source: CredentialSource; updatedAt: number } | null
}

const MAX_PRIVATE_CREDENTIAL_BYTES = 16 * 1024

/** Read a 0600 file, or null when absent (never a fake-empty on corrupt). */
function readSecret(file: string): string | null {
  return readSecretFile(file).value
}

/** `readSecret` plus the opened file's mtime (legacy v1 credentials carry no
 * `updatedAt`). `migrateMode:false` skips the fchmod but still requires 0600 —
 * a loose credential file is rejected, never silently accepted. */
function readSecretFile(file: string, migrateMode = true): { value: string | null; mtimeMs: number; identity: PrivateFileIdentity | null } {
  let read: { value: string; mtimeMs: number; identity: PrivateFileIdentity } | null
  try {
    read = readPrivateEntryOrNull(file, {
      requiredMode: 0o600,
      ...(migrateMode ? { tightenMode: 0o600 } : {}),
      maxBytes: MAX_PRIVATE_CREDENTIAL_BYTES,
    })
  } catch (error) {
    throw new Error(`gateway private file must be a regular file and remain stable: ${file}`, { cause: error })
  }
  if (read === null) return { value: null, mtimeMs: 0, identity: null }
  return {
    value: read.value.trim() === '' ? null : read.value,
    mtimeMs: read.mtimeMs,
    identity: read.identity,
  }
}

/** The single v2-envelope + legacy-v1 parse shared by the runtime readers and the CLI projection. */
type CredentialParse =
  | { kind: 'record'; record: CredentialRecord }
  | { kind: 'absent' }
  | { kind: 'corrupt-v2' }
  /** tokens.json: neither a valid v2 envelope nor a usable legacy `{"hash"}`. */
  | { kind: 'legacy-unreadable' }
  /** password-credential: neither a v2 envelope nor a bare legacy `scrypt$…`. */
  | { kind: 'unrecognized' }

function parseCredential(text: string | null, field: 'verifier' | 'hash', mtimeMs: number): CredentialParse {
  if (text === null) return { kind: 'absent' }
  if (!text.startsWith('{')) {
    if (field === 'verifier') {
      return /^scrypt\$/.test(text)
        ? { kind: 'record', record: { verifier: text, source: 'config', updatedAt: mtimeMs } }
        : { kind: 'unrecognized' }
    }
    return { kind: 'legacy-unreadable' }
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { kind: 'corrupt-v2' } }
  if (parsed === null || typeof parsed !== 'object') return { kind: 'corrupt-v2' }
  const doc = parsed as { schemaVersion?: unknown; source?: unknown; updatedAt?: unknown; verifier?: unknown; hash?: unknown }
  if (doc.schemaVersion !== 2) {
    // Legacy v1 tokens.json `{"hash": …}` → config-sourced, mtime as write time.
    if (field === 'hash') {
      const hash = doc.hash
      if (typeof hash === 'string' && hash !== '') {
        return { kind: 'record', record: { verifier: hash, source: 'config', updatedAt: mtimeMs } }
      }
      return { kind: 'legacy-unreadable' }
    }
    return { kind: 'unrecognized' }
  }
  const verifier = field === 'verifier' ? doc.verifier : doc.hash
  if (typeof verifier !== 'string' || !CREDENTIAL_VERIFIER_RE.test(verifier)
    || (doc.source !== 'config' && doc.source !== 'runtime')
    || typeof doc.updatedAt !== 'number' || !Number.isFinite(doc.updatedAt)) {
    return { kind: 'corrupt-v2' }
  }
  return { kind: 'record', record: { verifier, source: doc.source, updatedAt: doc.updatedAt } }
}

/**
 * Read-only, LOCK-FREE credential projection for CLI/ops use: the same
 * no-follow/inode/0600 read discipline as the store internals, but no stateDir
 * lock and no write or migration. Corrupt, unreadable or missing files project
 * as `null` — this function never throws (a CLI status must not fail on a
 * damaged stateDir).
 */
export function readCredentialProjection(stateDir: string): CredentialProjection {
  return {
    password: readProjectionRecord(join(stateDir, 'password-credential'), 'verifier'),
    token: readProjectionRecord(join(stateDir, 'tokens.json'), 'hash'),
  }
}

/** Parse one credential file into its non-secret projection via the shared {@link parseCredential}; never throws. */
function readProjectionRecord(file: string, field: 'verifier' | 'hash'): CredentialProjection['password'] {
  let text: string | null
  let mtimeMs: number
  try {
    // migrateMode:false — the projection is READ-ONLY (never chmods; non-0600 → rejected).
    const result = readSecretFile(file, false)
    text = result.value
    mtimeMs = result.mtimeMs
  } catch {
    return null // missing / non-regular / symlink / inode race → not configured
  }
  const parsed = parseCredential(text, field, mtimeMs)
  if (parsed.kind !== 'record') return null
  return { set: true, source: parsed.record.source, updatedAt: parsed.record.updatedAt }
}

/** 0600 atomic write through a random exclusive no-follow temp + parent fsync. */
function writeSecret(file: string, value: string): void {
  atomicWritePrivateFileNoFollow(file, value, { mode: 0o600 })
}

/** Delete one credential file. Absence is idempotent; any other failure must
 * surface so a caller is never told a still-present credential was removed. */
function removeSecret(file: string): void {
  removePrivateFileNoFollow(file)
}

export interface GatewayStore {
  /** tokens.json (0600, hash only): the current token verifier hash, or null.
   * Re-read from disk on every call so runtime changes take effect immediately. */
  getTokenHash(): string | null
  /** tokens.json full record for seeding decisions; null when no token is configured. */
  getTokenCredential(): CredentialRecord | null
  /** Persist the token hash as a v2 document (source defaults to `'config'`;
   * runtime changes pass `'runtime'`), or delete the file when null. Never
   * rotates jwt-secret. */
  setTokenHash(hash: string | null, source?: CredentialSource): void
  /** jwt-secret — the session signing key (0600, rotatable). */
  getJwtSecret(): string
  rotateJwtSecret(): string
  /** password-credential (v2, 0600): the current verifier hash, or null. Re-read
   * from disk on every call so runtime changes take effect immediately. */
  getPasswordCredential(): string | null
  /** password-credential full record for seeding decisions; null when unset. */
  getPasswordCredentialRecord(): CredentialRecord | null
  /** Persist the password verifier as a v2 document (source defaults to
   * `'config'`; runtime changes pass `'runtime'`), or delete when null. Never
   * rotates jwt-secret — rotate-first discipline lives in auth.ts. */
  setPasswordCredential(verifier: string | null, source?: CredentialSource): void
}

const SCRYPT_SALT_LEN = 16

/** Canonical verifier shape produced by hashCredential (16-byte salt + 32-byte
 * key, hex); anything else reads as corrupt, so a garbage verifier can never
 * silently disable authentication. */
const CREDENTIAL_VERIFIER_RE = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/i

/** Corrupt/unreadable credential files are warned ONCE per process (re-read on every request). */
const CREDENTIAL_WARN_ONCE = new Set<string>()
function warnOnce(key: string, message: string, logger: GatewayStoreLogger): void {
  if (CREDENTIAL_WARN_ONCE.has(key)) return
  CREDENTIAL_WARN_ONCE.add(key)
  logger.warn(message)
}

/** Hash a plaintext token/password (scrypt). */
export function hashCredential(plain: string): string {
  const salt = randomBytes(SCRYPT_SALT_LEN).toString('hex')
  const derived = scryptSync(plain, salt, 32).toString('hex')
  return `scrypt$${salt}$${derived}`
}

/** Constant-time compare a plaintext against a stored `scrypt$salt$hash`. */
export function verifyCredential(plain: string, stored: string | null): boolean {
  if (stored === null) return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, salt, expectedHex] = parts
  const derived = scryptSync(plain, salt, 32)
  const expected = Buffer.from(expectedHex, 'hex')
  if (derived.length !== expected.length) return false
  return derived.equals(expected) // Buffer.equals is constant-time
}

export function createGatewayStore(
  stateDir: string,
  logger: GatewayStoreLogger,
  options: { stateLease?: StateRootLease } = {},
): GatewayStore {
  const root = join(stateDir, 'gateway')
  // The state-root writer lease is the caller's handle: assert the same
  // root/scope and that it is current; the store never acquires or releases one.
  if (options.stateLease !== undefined) {
    if (options.stateLease.scope !== 'state-root' || options.stateLease.stateRoot !== resolve(stateDir)) {
      throw new Error(`gateway store stateDir does not match the state-root lease: ${options.stateLease.stateRoot}`)
    }
    options.stateLease.assertCurrent()
  }
  // State root converges to 0700 on POSIX: fresh directories are created 0700,
  // a pre-existing one is tightened via its pinned no-follow descriptor
  // (installers/upgrades must not crash-loop on a legacy 0755 root). One loud
  // warning per process — silent permission mutation confuses audits.
  try {
    const stat = lstatSync(stateDir)
    if (stat.isDirectory() && (stat.mode & 0o777) !== 0o700) {
      warnOnce('state-root-tighten', `gateway state root ${stateDir} exists with mode ${(stat.mode & 0o777).toString(8)}; tightening to 0700`, logger)
    }
  } catch {
    // ENOENT: the store creates it 0700 below.
  }
  ensurePrivateDirectoryNoFollow(stateDir, 0o700)
  ensurePrivateDirectoryNoFollow(root, 0o700)

  const tokensFile = join(stateDir, 'tokens.json')
  const jwtSecretFile = join(stateDir, 'jwt-secret')
  const passwordCredentialFile = join(stateDir, 'password-credential')

  function readTokenCredential(): CredentialRecord | null {
    const { value, mtimeMs } = readSecretFile(tokensFile)
    const parsed = parseCredential(value, 'hash', mtimeMs)
    if (parsed.kind === 'record') return parsed.record
    if (parsed.kind === 'corrupt-v2') {
      warnOnce(tokensFile, `gateway-store: corrupt v2 tokens.json (${tokensFile})`, logger)
    } else if (parsed.kind !== 'absent') {
      warnOnce(tokensFile, `gateway-store: cannot read ${tokensFile}`, logger)
    }
    return null
  }

  function getTokenHash(): string | null {
    return readTokenCredential()?.verifier ?? null
  }

  function setTokenHash(hash: string | null, source: CredentialSource = 'config'): void {
    if (hash === null) {
      removeSecret(tokensFile)
      return
    }
    writeSecret(tokensFile, `${JSON.stringify({ schemaVersion: 2, source, updatedAt: Date.now(), hash })}\n`)
  }

  function readPasswordCredential(): CredentialRecord | null {
    const { value, mtimeMs } = readSecretFile(passwordCredentialFile)
    const parsed = parseCredential(value, 'verifier', mtimeMs)
    if (parsed.kind === 'record') return parsed.record
    if (parsed.kind === 'corrupt-v2') {
      warnOnce(passwordCredentialFile, `gateway-store: corrupt v2 password-credential (${passwordCredentialFile})`, logger)
    } else if (parsed.kind !== 'absent') {
      warnOnce(passwordCredentialFile, `gateway-store: unrecognized password-credential file (${passwordCredentialFile})`, logger)
    }
    return null
  }

  function getPasswordCredential(): string | null {
    return readPasswordCredential()?.verifier ?? null
  }

  function setPasswordCredential(verifier: string | null, source: CredentialSource = 'config'): void {
    if (verifier === null) {
      removeSecret(passwordCredentialFile)
      return
    }
    writeSecret(passwordCredentialFile, `${JSON.stringify({ schemaVersion: 2, source, updatedAt: Date.now(), verifier })}\n`)
  }

  function getJwtSecret(): string {
    const existing = readSecret(jwtSecretFile)
    if (existing !== null && existing.length >= 32) return existing
    const fresh = randomBytes(32).toString('hex')
    writeSecret(jwtSecretFile, fresh)
    return fresh
  }

  function rotateJwtSecret(): string {
    const fresh = randomBytes(32).toString('hex')
    writeSecret(jwtSecretFile, fresh)
    return fresh
  }

  return {
    getTokenHash, getTokenCredential: readTokenCredential, setTokenHash,
    getJwtSecret, rotateJwtSecret,
    getPasswordCredential, getPasswordCredentialRecord: readPasswordCredential, setPasswordCredential,
  }
}
