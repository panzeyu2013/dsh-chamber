/**
 * Gateway persistence (design 17 §12): the gateway's OWN state, physically
 * separate from dsh's $DSH_HOME. All JSON docs go through control-plane
 * `createJsonStore` (backup-first + revision + recovery); secrets (token hash,
 * jwt-secret, password verifier) go through a 0600 atomic-file discipline
 * (never plaintext in a store doc, S5/S8/S15).
 *
 * Credential model (Phase 1 — runtime credential management):
 *
 *  - Credentials are SERVER STATE, not deployment config: config seeds them at
 *    startup, the runtime change API mutates them, and they persist across
 *    restarts. Each credential file is a schemaVersion-2 JSON envelope:
 *    `{schemaVersion:2, source:'config'|'runtime', updatedAt:<epoch ms>,
 *    verifier|hash:'scrypt$salt$hash'}`.
 *  - `source:'config'` records are re-asserted (or removed) by config seeding
 *    on every startup; `source:'runtime'` records are authoritative and config
 *    seeding never overwrites them (design 17 §7). The write primitives below
 *    never decide that policy — seeding/rotation policy lives in auth.ts
 *    (`seedCredentialsFromConfig`, rotate-first discipline). Legacy v1 files
 *    (bare `scrypt$salt$hash` for `password-credential`, `{"hash":...}` for
 *    `tokens.json`) read as `source:'config'` (updatedAt = file mtime) and
 *    migrate to v2 on the next write.
 *  - `createGatewayStore` holds an exclusive `<stateDir>/.gateway.lock`
 *    (O_EXCL-first, 0600, `{"pid":...,"createdAt":...}`): a live-owner lock
 *    fails startup loudly (error code 'gateway_locked' + owner pid); a stale
 *    (dead-pid) lock is taken over via rename-claim + moved-content
 *    verification (the moved file must be the exact stale lock we read; a
 *    fresh live lock is renamed back and the contender fails loudly), and a
 *    post-create ownership verification fails any acquirer whose fresh lock
 *    was displaced concurrently — the two-process case is provably
 *    double-hold-free (pair stress test), a three-process interleaving keeps
 *    the same documented residual every pidfile lock has without kernel
 *    flock; releaseLock verifies the on-disk owner is still us before
 *    removing, the exit listener is registered only after a successful
 *    acquisition, and `close()` / process exit release it best-effort.
 *    `reacquire()` re-takes the lock after a close (gateway start() retry
 *    path). All same-stateDir reopen tests must `close()` before reopening.
 *
 * The gateway is never authoritative over dsh facts: the worktrees/schedule/
 * index docs are the gateway's own orchestration records, and the session
 * index is a derived cache (§8.2).
 */

import { closeSync, fchmodSync, fstatSync, fsyncSync, openSync, realpathSync, renameSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import {
  atomicWritePrivateFileNoFollow,
  createJsonStore,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
  removePrivateFileNoFollow,
  syncPrivateDirectoryNoFollow,
  type JsonStore,
  type JsonStoreDocument,
  type PrivateFileIdentity,
} from '@dsh-chamber/control-plane'

export interface GatewayStoreLogger { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }

export interface WorktreeStoreRecord {
  id: string
  workspaceId: string
  sessionId?: string
  /** Canonical main-workspace repository; server-derived at create time. */
  repo?: string
  path: string
  branch: string
  /** Only `owned` rows may authorize deletion. Missing legacy values and
   * `unverified` transport-ambiguity rows are observability-only. */
  ownership?: 'owned' | 'unverified'
  state: 'creating' | 'ready' | 'deleting' | 'failed'
  error?: string
  createdAt: number
}

export interface ScheduleStoreRecord {
  id: string
  delayMs: number
  intervalMs: number | null
  targetSessionId: string
  prompt: string
}

export interface GatewaySettingsDoc {
  schemaVersion?: number
  revision?: number
  git?: { enabled: boolean }
  notifications?: { enabled: boolean }
  schedule?: { enabled: boolean }
}

/** Where the current credential came from: deployment-config seeding vs a
 * runtime API change. `config`-sourced credentials are re-asserted (or
 * removed) by seeding on every restart; `runtime`-sourced credentials are
 * authoritative server state that seeding never overwrites. */
export type CredentialSource = 'config' | 'runtime'

/** A persisted credential: the salted scrypt verifier plus its provenance and
 * last-write time (epoch ms). `verifier` is the raw `scrypt$salt$hash` value
 * for both the password-credential and tokens.json files. */
export interface CredentialRecord {
  verifier: string
  source: CredentialSource
  updatedAt: number
}

/** Non-secret per-dimension credential projection (Phase 3, S5): provenance +
 * last-write time ONLY — the verifier/hash never leaves the file. `null`
 * means the dimension currently has no credential. */
export interface CredentialProjection {
  password: { set: true; source: CredentialSource; updatedAt: number } | null
  token: { set: true; source: CredentialSource; updatedAt: number } | null
}

interface DomainValidation<T> {
  doc: T
  droppedRows: number
}

type DomainValidator<T> = (value: unknown) => DomainValidation<T>

/** A json-store-backed document accessor (load-once + mutate). JSON syntax is
 * only the outer envelope: each gateway domain supplies a root validator so
 * a syntactically-valid wrong document falls through to `.bak`. Invalid rows
 * inside a valid collection root are isolated without reconstructing (and
 * accidentally truncating) complete valid rows. */
function docStore<T>(
  filePath: string,
  label: string,
  logger: GatewayStoreLogger,
  initial: T,
  validate: DomainValidator<T>,
): { get(): T & { revision?: number }; mutate(mutator: (doc: T) => { next: T; changed: boolean }): Promise<void> } {
  const store: JsonStore = createJsonStore({
    filePath,
    logger,
    initial: initial as JsonStoreDocument,
    fileMode: 0o600,
    onLoadValidate(value) {
      const validated = validate(value)
      if (validated.droppedRows > 0) {
        logger.warn(`gateway-store: ignored ${validated.droppedRows} invalid persisted ${label} row(s) in ${filePath}`)
      }
      // JsonStore's historical counters are catalog-domain-specific. Gateway
      // reports its own honest row count above instead of misclassifying a
      // worktree/schedule row as a connection or project.
      return {
        doc: validated.doc as unknown as JsonStoreDocument,
        dropped: { connections: 0, projects: 0 },
      }
    },
  })
  store.load()
  const recovery = store.getStatus().recoveryState
  if (recovery?.source === 'backup') {
    logger.warn(`gateway-store: recovered ${label} document from ${filePath}.bak`)
  }
  return {
    get(): T & { revision?: number } { return store.getDoc() as T & { revision?: number } },
    async mutate(mutator: (doc: T) => { next: T; changed: boolean }): Promise<void> {
      await store.mutate(doc => {
        const { next, changed } = mutator(doc as unknown as T)
        return { next: next as unknown as JsonStoreDocument, changed }
      })
    },
  }
}

const WORKTREE_STATES = new Set(['creating', 'ready', 'deleting', 'failed'])
const SAFE_PERSISTED_ID = /^[a-zA-Z0-9_-]+$/
const MAX_PERSISTED_TIMER_DELAY_MS = 2_147_483_647
const MAX_PERSISTED_SCHEDULE_TARGET_CHARS = 512
const MAX_PERSISTED_SCHEDULE_PROMPT_CHARS = 10_000
const MAX_PRIVATE_CREDENTIAL_BYTES = 16 * 1024

function comparablePath(path: string): string {
  const absolute = resolve(path)
  let canonical = absolute
  try { canonical = realpathSync.native(absolute) } catch { /* a new stateDir has no realpath yet */ }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/** Reject ambient, broad filesystem roots before createGatewayStore performs
 * any mkdir/chmod. Gateway state must always be an explicitly dedicated
 * directory, never the filesystem root, the account home, or the system temp
 * directory itself (children of those locations remain valid). */
export function validateGatewayStateDirPath(stateDir: string): void {
  const absolute = resolve(stateDir)
  const candidateKeys = new Set([
    process.platform === 'win32' ? absolute.toLowerCase() : absolute,
    comparablePath(absolute),
  ])
  const forbidden: Array<[string, string]> = [
    ['filesystem root', parse(absolute).root],
    ['user home', homedir()],
    ['system temp root', tmpdir()],
  ]
  for (const [label, path] of forbidden) {
    const forbiddenAbsolute = resolve(path)
    const forbiddenKeys = [
      process.platform === 'win32' ? forbiddenAbsolute.toLowerCase() : forbiddenAbsolute,
      comparablePath(forbiddenAbsolute),
    ]
    if (forbiddenKeys.some(key => candidateKeys.has(key))) {
      throw new Error(`gateway stateDir must be a dedicated child directory; refusing ${label}`)
    }
  }
}

function documentRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} document root must be an object`)
  }
  return value as Record<string, unknown>
}

function validateDocumentMetadata(
  doc: Record<string, unknown>,
  label: string,
  schema: 'required-v1' | 'optional-v1',
): void {
  if ((schema === 'required-v1' && doc.schemaVersion !== 1)
    || (schema === 'optional-v1' && doc.schemaVersion !== undefined && doc.schemaVersion !== 1)) {
    throw new Error(`${label} document has an unsupported schemaVersion`)
  }
  if (doc.revision !== undefined
    && (typeof doc.revision !== 'number' || !Number.isInteger(doc.revision) || doc.revision < 0)) {
    throw new Error(`${label} document has an invalid revision`)
  }
}

function isWorktreeStoreRecord(value: unknown): value is WorktreeStoreRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && SAFE_PERSISTED_ID.test(row.id)
    && typeof row.workspaceId === 'string' && SAFE_PERSISTED_ID.test(row.workspaceId)
    && (row.sessionId === undefined || (typeof row.sessionId === 'string' && row.sessionId !== ''))
    && (row.repo === undefined || (typeof row.repo === 'string' && row.repo !== '' && !row.repo.includes('\0')))
    && typeof row.path === 'string' && row.path !== '' && !row.path.includes('\0')
    && typeof row.branch === 'string' && row.branch !== ''
    && (row.ownership === undefined || row.ownership === 'owned' || row.ownership === 'unverified')
    && typeof row.state === 'string' && WORKTREE_STATES.has(row.state)
    && (row.error === undefined || typeof row.error === 'string')
    && typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) && row.createdAt >= 0
}

function validateWorktreesDocument(value: unknown): DomainValidation<{ items: WorktreeStoreRecord[] }> {
  const doc = documentRecord(value, 'worktrees')
  validateDocumentMetadata(doc, 'worktrees', 'optional-v1')
  if (!Array.isArray(doc.items)) throw new Error('worktrees document items must be an array')
  const items = doc.items.filter(isWorktreeStoreRecord)
  return {
    doc: { ...doc, items } as { items: WorktreeStoreRecord[] },
    droppedRows: doc.items.length - items.length,
  }
}

function isScheduleStoreRecord(value: unknown): value is ScheduleStoreRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && SAFE_PERSISTED_ID.test(row.id)
    && typeof row.delayMs === 'number' && Number.isFinite(row.delayMs)
    && row.delayMs >= 0 && row.delayMs <= MAX_PERSISTED_TIMER_DELAY_MS
    && (row.intervalMs === null || (typeof row.intervalMs === 'number' && Number.isFinite(row.intervalMs)
      && row.intervalMs >= 1_000 && row.intervalMs <= MAX_PERSISTED_TIMER_DELAY_MS))
    && typeof row.targetSessionId === 'string' && row.targetSessionId.length > 0
    && row.targetSessionId.length <= MAX_PERSISTED_SCHEDULE_TARGET_CHARS
    && typeof row.prompt === 'string' && row.prompt.length > 0
    && row.prompt.length <= MAX_PERSISTED_SCHEDULE_PROMPT_CHARS
}

function validateScheduleDocument(value: unknown): DomainValidation<{ items: ScheduleStoreRecord[] }> {
  const doc = documentRecord(value, 'schedule')
  validateDocumentMetadata(doc, 'schedule', 'optional-v1')
  if (!Array.isArray(doc.items)) throw new Error('schedule document items must be an array')
  const items = doc.items.filter(isScheduleStoreRecord)
  return {
    doc: { ...doc, items } as { items: ScheduleStoreRecord[] },
    droppedRows: doc.items.length - items.length,
  }
}

function isFeatureSetting(value: unknown): value is { enabled: boolean } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const section = value as Record<string, unknown>
  return typeof section.enabled === 'boolean'
}

function validateSettingsDocument(value: unknown): DomainValidation<GatewaySettingsDoc> {
  const doc = documentRecord(value, 'settings')
  validateDocumentMetadata(doc, 'settings', 'required-v1')
  for (const key of ['git', 'notifications', 'schedule'] as const) {
    if (doc[key] !== undefined && !isFeatureSetting(doc[key])) {
      throw new Error(`settings document has an invalid ${key} section`)
    }
  }
  return { doc: doc as GatewaySettingsDoc, droppedRows: 0 }
}

/** Read a 0600 file, or null when absent (never a fake-empty on corrupt). */
function readSecret(file: string): string | null {
  return readSecretFile(file).value
}

/** `readSecret` plus the stat mtime of the opened file (used to timestamp
 * legacy v1 credentials whose files carry no `updatedAt`). With
 * `migrateMode:false` skips the explicit legacy fchmod but still requires
 * 0600 — the lock-free auth-status projection is genuinely read-only and a
 * loose credential file is rejected rather than silently accepted. */
function readSecretFile(file: string, migrateMode = true): { value: string | null; mtimeMs: number; identity: PrivateFileIdentity | null } {
  try {
    const read = readPrivateFileNoFollow(file, {
      requiredMode: 0o600,
      ...(migrateMode ? { tightenMode: 0o600 } : {}),
      maxBytes: MAX_PRIVATE_CREDENTIAL_BYTES,
    })
    return {
      value: read.value.trim() === '' ? null : read.value,
      mtimeMs: read.mtimeMs,
      identity: read.identity,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: null, mtimeMs: 0, identity: null }
    throw new Error(`gateway private file must be a regular file and remain stable: ${file}`, { cause: error })
  }
}

/**
 * Read-only, LOCK-FREE credential projection for CLI/ops use (`gateway auth
 * status`): reads `password-credential` and `tokens.json` with the same
 * no-follow/inode/0600 read discipline as the store internals, but never
 * acquires the stateDir exclusive lock and never writes or migrates any
 * credential state. Legacy v1 files (bare `scrypt$…` password / `{"hash":…}`
 * token) project as `source:'config'` with the file mtime, exactly like the
 * store's own reads. Corrupt, unreadable, or missing files project as `null`
 * — this function never throws (a CLI status must not fail on a damaged
 * stateDir).
 */
export function readCredentialProjection(stateDir: string): CredentialProjection {
  return {
    password: readProjectionRecord(join(stateDir, 'password-credential'), 'verifier'),
    token: readProjectionRecord(join(stateDir, 'tokens.json'), 'hash'),
  }
}

/** Parse one credential file into its non-secret projection; mirrors the
 * store's v2-envelope + legacy-v1 semantics (see `readCredentialProjection`).
 * Returns null for missing/corrupt/unreadable files — never throws. */
function readProjectionRecord(file: string, field: 'verifier' | 'hash'): CredentialProjection['password'] {
  let text: string | null
  let mtimeMs: number
  try {
    // migrateMode:false — the projection is a READ-ONLY path (`gateway auth
    // status` never chmods; a non-0600 credential is rejected as unsafe).
    const result = readSecretFile(file, false)
    text = result.value
    mtimeMs = result.mtimeMs
  } catch {
    return null // missing / non-regular / symlink / inode race → not configured
  }
  if (text === null) return null
  if (text.startsWith('{')) {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return null }
    if (parsed === null || typeof parsed !== 'object') return null
    const doc = parsed as { schemaVersion?: unknown; source?: unknown; updatedAt?: unknown; verifier?: unknown; hash?: unknown }
    if (doc.schemaVersion === 2) {
      const value = field === 'verifier' ? doc.verifier : doc.hash
      // Mirror the store's corrupt-v2 rule (parseV2Credential): a shape-valid
      // envelope whose verifier is not a real scrypt value projects as
      // unconfigured, never as a configured credential.
      if (typeof value !== 'string' || !CREDENTIAL_VERIFIER_RE.test(value)
        || (doc.source !== 'config' && doc.source !== 'runtime')
        || typeof doc.updatedAt !== 'number' || !Number.isFinite(doc.updatedAt)) return null
      return { set: true, source: doc.source, updatedAt: doc.updatedAt }
    }
    // Legacy v1 tokens.json `{"hash": …}` (no schemaVersion) → config-sourced.
    if (field === 'hash') {
      const hash = (parsed as { hash?: unknown }).hash
      if (typeof hash === 'string' && hash !== '') return { set: true, source: 'config', updatedAt: mtimeMs }
    }
    return null
  }
  // Legacy v1 password-credential: a bare `scrypt$salt$hash` string.
  if (field === 'verifier' && /^scrypt\$/.test(text)) return { set: true, source: 'config', updatedAt: mtimeMs }
  return null
}

/** 0600 atomic write through a random exclusive no-follow temp + parent fsync. */
function writeSecret(file: string, value: string): void {
  atomicWritePrivateFileNoFollow(file, value, { mode: 0o600 })
}

/** Delete one credential file. Absence is idempotent; every other failure
 * must surface to the credential mutation so an API/CLI caller can never be
 * told that a still-present credential was removed. */
function removeSecret(file: string): void {
  removePrivateFileNoFollow(file)
}

export interface GatewayStore {
  /** worktrees.json — the git offload records (§8.1). */
  worktrees: { get(): { items: WorktreeStoreRecord[] }; mutate(m: (d: { items: WorktreeStoreRecord[] }) => { next: { items: WorktreeStoreRecord[] }; changed: boolean }): Promise<void> }
  /** schedule.json — cron jobs (§8.4). */
  schedule: { get(): { items: ScheduleStoreRecord[] }; mutate(m: (d: { items: ScheduleStoreRecord[] }) => { next: { items: ScheduleStoreRecord[] }; changed: boolean }): Promise<void> }
  /** settings.json — the /chamber/settings doc (§8.5). */
  settings: { get(): GatewaySettingsDoc; mutate(m: (d: GatewaySettingsDoc) => { next: GatewaySettingsDoc; changed: boolean }): Promise<void> }
  /** tokens.json (0600, hash only, S5): the current token verifier hash, or
   * null when no token is configured. Re-read from disk on every call so
   * runtime changes take effect immediately. */
  getTokenHash(): string | null
  /** tokens.json full record (verifier/source/updatedAt) for seeding
   * decisions; null when no token is configured. */
  getTokenCredential(): CredentialRecord | null
  /** Persist the token hash as a v2 tokens.json document (source defaults to
   * `'config'` for deployment seeding; runtime changes pass `'runtime'`), or
   * delete the file when hash is null. Never rotates jwt-secret (token has no
   * session-cookie association). */
  setTokenHash(hash: string | null, source?: CredentialSource): void
  /** jwt-secret — the session signing key (0600, rotatable, S13). */
  getJwtSecret(): string
  rotateJwtSecret(): string
  /** password-credential (v2, 0600): the current password verifier hash, or
   * null when no password is configured. Re-read from disk on every call so
   * runtime changes take effect immediately. */
  getPasswordCredential(): string | null
  /** password-credential full record (verifier/source/updatedAt) for seeding
   * decisions; null when no password is configured. */
  getPasswordCredentialRecord(): CredentialRecord | null
  /** Persist the password verifier as a v2 password-credential document
   * (source defaults to `'config'` for deployment seeding; runtime changes
   * pass `'runtime'`), or delete the file when verifier is null. Never
   * rotates jwt-secret — the rotate-first discipline is auth.ts's policy
   * (rotate before persisting so a failed write never leaves a mixed state). */
  setPasswordCredential(verifier: string | null, source?: CredentialSource): void
  /** Release the stateDir exclusive lock (idempotent). */
  close(): void
  /** Re-take the stateDir exclusive lock after a close() (gateway start()
   * retry path, design 17 §4.1). No-op while the lock is still held. */
  reacquire(): void
}

const SCRYPT_SALT_LEN = 16

/** Canonical scrypt verifier shape produced by hashCredential (16-byte salt +
 * 32-byte derived key, hex). v2 envelopes must match it — anything else is
 * treated as corrupt so a garbage verifier can never silently disable
 * authentication. */
const CREDENTIAL_VERIFIER_RE = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/i

/** Corrupt/unreadable credential files are warned ONCE per process (they are
 * re-read on every request; a per-request warn would spam the log). */
const CREDENTIAL_WARN_ONCE = new Set<string>()
function warnOnce(key: string, message: string, logger: GatewayStoreLogger): void {
  if (CREDENTIAL_WARN_ONCE.has(key)) return
  CREDENTIAL_WARN_ONCE.add(key)
  logger.warn(message)
}

/** Hash a plaintext token/password (scrypt, per design §5.1). */
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

export function createGatewayStore(stateDir: string, logger: GatewayStoreLogger): GatewayStore {
  validateGatewayStateDirPath(stateDir)
  const root = join(stateDir, 'gateway')
  ensurePrivateDirectoryNoFollow(stateDir, 0o700, { existingMode: 'require' })
  ensurePrivateDirectoryNoFollow(root, 0o700)

  // -------------------------------------------------------------------------
  // Exclusive stateDir lock (Phase 1, fix round). O_EXCL-first acquisition;
  // a stale (dead-pid) lock is taken over via rename-claim + moved-content
  // verification (the moved file must be the exact stale lock we read; a
  // fresh live lock is renamed back and the contender fails loudly), and a
  // post-create ownership verification fails any acquirer whose fresh lock
  // was displaced concurrently — the two-process case is provably
  // double-hold-free. A live owner fails startup loudly (structured error
  // code 'gateway_locked' + owner pid); an UNREADABLE lock file (non-regular
  // / symlink / inode race) fails loudly; a readable but pid-less/corrupt
  // lock file is treated as a crashed leftover and taken over with a
  // warning. The process-exit listener is registered ONLY after a successful
  // acquisition, and releaseLock double-checks both (a) that THIS store
  // actually holds the lock and (b) that the on-disk owner pid is still ours
  // — a failed acquisition can never delete another process's lock.
  // close() releases; reacquire() re-takes it (gateway start() retry path,
  // design 17 §4.1).
  // -------------------------------------------------------------------------
  const lockFile = join(stateDir, '.gateway.lock')

  /** Locks are not credential documents: preserve empty/corrupt bytes so a
   * dead pid-less lock can be claimed, never chmod while inspecting another
   * owner, and cap the tiny pidfile to prevent an unbounded startup read. */
  function readLockFile(file: string): { value: string; identity: PrivateFileIdentity } | null {
    try {
      const read = readPrivateFileNoFollow(file, { maxBytes: 4 * 1024 })
      return { value: read.value, identity: read.identity }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM means the process exists but belongs to another user — still
      // alive as far as lock ownership is concerned.
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  function lockedError(message: string, pid?: number): Error & { code: string; pid?: number } {
    const error = new Error(message) as Error & { code: string; pid?: number }
    error.code = 'gateway_locked'
    if (pid !== undefined) error.pid = pid
    return error
  }

  let held = false
  let heldOwner: { raw: string; identity: PrivateFileIdentity } | null = null
  let exitListenerRegistered = false
  function onProcessExit(): void {
    releaseLock()
  }

  function acquireLock(): void {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let fd: number
      try {
        fd = openSync(lockFile, 'wx', 0o600) // O_CREAT | O_EXCL
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new Error(`gateway state directory lock could not be created (${lockFile}): ${String(error)}`)
        }
        // EEXIST: inspect the existing lock before deciding takeover.
        let existingRecord: NonNullable<ReturnType<typeof readLockFile>>
        try {
          const found = readLockFile(lockFile)
          if (found === null) continue
          existingRecord = found
        } catch (readError) {
          throw new Error(`gateway state directory lock is not a readable regular file (${lockFile}): ${String(readError)}`)
        }
        const existing = existingRecord.value
        let pid: number | null = null
        try {
          const parsed = JSON.parse(existing) as { pid?: unknown }
          pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null
        } catch { pid = null }
        if (pid !== null && isProcessAlive(pid)) {
          throw lockedError(
            `gateway state directory is already locked by running process ${pid} (${lockFile}); close that gateway or remove a stale lock`,
            pid,
          )
        }
        // Atomic claim: rename whatever is at the path aside, then VERIFY the
        // moved file is the exact stale lock we read. Between our read and
        // this rename another contender may have completed its own takeover
        // and left a FRESH live lock at the path — renaming THAT away and
        // deleting it would displace a live owner (double-hold). On a
        // mismatch we restore the displaced lock by renaming it back
        // (clobbering any lock a third contender created in the gap — the
        // FIRST claimant wins, and the third contender's own final
        // ownership verification below detects the displacement and fails
        // closed).
        const staleName = `${lockFile}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
        try {
          renameSync(lockFile, staleName)
          syncPrivateDirectoryNoFollow(stateDir)
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue // another contender took it
          throw new Error(`gateway state directory lock takeover failed (${lockFile}): ${String(renameError)}`)
        }
        let movedRecord: ReturnType<typeof readLockFile> = null
        try {
          movedRecord = readLockFile(staleName)
        } catch { movedRecord = null }
        const movedIsExact = movedRecord?.value === existing
          && movedRecord.identity.dev === existingRecord.identity.dev
          && movedRecord.identity.ino === existingRecord.identity.ino
        if (!movedIsExact) {
          // We moved a fresh lock (a live owner's) — restore it, then fail
          // loudly ourselves. The owner's final verification below confirms
          // its lock is back in place.
          try {
            renameSync(staleName, lockFile)
            syncPrivateDirectoryNoFollow(stateDir)
          } catch { /* best effort */ }
          throw lockedError(`gateway state directory lock takeover race: another process acquired the lock concurrently (${lockFile})`)
        }
        logger.warn(`gateway-store: taking over a stale state lock at ${lockFile}${pid === null ? ' (owner pid unreadable)' : ` (owner pid ${pid} is not running)`}`)
        try { removePrivateFileNoFollow(staleName, movedRecord?.identity ?? undefined) } catch { /* best effort */ }
        continue // retry the create
      }
      let writtenCreatedAt = 0
      let createdIdentity: PrivateFileIdentity | null = null
      let writeError: unknown = null
      try {
        const created = fstatSync(fd)
        if (!created.isFile() || created.nlink !== 1) throw new Error('new gateway lock is not a single-link regular file')
        createdIdentity = { dev: created.dev, ino: created.ino }
        fchmodSync(fd, 0o600)
        writtenCreatedAt = Date.now()
        const lockBytes = Buffer.from(`${JSON.stringify({ pid: process.pid, createdAt: writtenCreatedAt })}\n`)
        let offset = 0
        while (offset < lockBytes.length) {
          const written = writeSync(fd, lockBytes, offset, lockBytes.length - offset)
          if (written === 0) throw new Error('gateway state directory lock write made no progress')
          offset += written
        }
        fsyncSync(fd)
      } catch (error) {
        writeError = error
      } finally {
        closeSync(fd)
      }
      if (writeError !== null) {
        if (createdIdentity !== null) {
          try { removePrivateFileNoFollow(lockFile, createdIdentity) } catch { /* preserve ambiguous leaf */ }
        }
        throw writeError
      }
      try {
        syncPrivateDirectoryNoFollow(stateDir)
      } catch (error) {
        // The caller must never observe a failed acquisition while a live-pid
        // lock created by this attempt remains behind.
        if (createdIdentity !== null) {
          try { removePrivateFileNoFollow(lockFile, createdIdentity) } catch { /* preserve ambiguous leaf */ }
        }
        throw error
      }
      // FINAL ownership verification: a concurrent takeover may have displaced
      // our fresh lock between the create and here (its own verification
      // restores it or fails). Never run on a directory we do not actually
      // own — fail closed and let the caller retry.
      let verify: ReturnType<typeof readLockFile> = null
      try {
        verify = readLockFile(lockFile)
      } catch { verify = null }
      const expected = `${JSON.stringify({ pid: process.pid, createdAt: writtenCreatedAt })}\n`
      if (verify?.value !== expected || createdIdentity === null
        || verify.identity.dev !== createdIdentity.dev || verify.identity.ino !== createdIdentity.ino) {
        if (createdIdentity !== null) {
          try { removePrivateFileNoFollow(lockFile, createdIdentity) } catch { /* never remove a successor */ }
        }
        throw lockedError(`gateway state directory lock ownership lost during acquisition (${lockFile}); retry`)
      }
      held = true
      heldOwner = { raw: expected, identity: createdIdentity }
      // Register the exit release ONLY now that we actually hold the lock: a
      // failed acquisition must never delete a live owner's lock on exit.
      if (!exitListenerRegistered) {
        process.on('exit', onProcessExit)
        exitListenerRegistered = true
      }
      return
    }
    throw lockedError(`gateway state directory lock could not be acquired after concurrent takeovers (${lockFile})`)
  }

  function releaseLock(): void {
    // Never touch the lock file unless THIS store actually holds the lock.
    if (!held) return
    // Verify the on-disk owner is still us before removing (prevents
    // cascading deletion of a successor's lock after a takeover). On any
    // mismatch we no longer hold the lock — clear `held` so a later
    // reacquire() re-takes it (fail-closed: the gateway must never keep
    // running on a directory it does not actually own).
    let owner: ReturnType<typeof readLockFile> = null
    try {
      owner = readLockFile(lockFile)
    } catch { owner = null }
    const ownerToRelease = heldOwner
    const stillExactOwner = ownerToRelease !== null
      && owner?.value === ownerToRelease.raw
      && owner.identity.dev === ownerToRelease.identity.dev
      && owner.identity.ino === ownerToRelease.identity.ino
    if (!stillExactOwner) {
      held = false
      heldOwner = null
      logger.warn(`gateway-store: refusing to remove state lock ${lockFile} (owner token/identity changed); lock ownership released`)
      return
    }
    try { removePrivateFileNoFollow(lockFile, ownerToRelease.identity) } catch (error) {
      // The on-disk lock is still ours — keep held=true so a later
      // reacquire() does not deadlock against our own live pid.
      logger.warn(`gateway-store: failed to remove state lock ${lockFile}: ${String(error)}; ownership retained`)
      return
    }
    held = false
    heldOwner = null
  }

  function close(): void {
    releaseLock()
    // A failed precise unlink deliberately retains ownership. Keep the exit
    // retry registered in that case; removing it first would turn a transient
    // close failure into a guaranteed live-pid lock leak.
    if (!held && exitListenerRegistered) {
      process.removeListener('exit', onProcessExit)
      exitListenerRegistered = false
    }
  }

  /** Re-take the lock after a close() (the gateway start() retry path,
   * design 17 §4.1). No-op while the lock is still held. */
  function reacquire(): void {
    if (held) return
    acquireLock()
  }

  acquireLock()

  // Loading a corrupt/unreadable JSON document is a loud construction
  // failure, but it must not strand the already-acquired stateDir lock in this
  // process. createGateway() cannot close a store whose assignment never
  // completed, so this transaction owns its own rollback.
  const documents = (() => {
    try {
      return {
        worktrees: docStore<{ items: WorktreeStoreRecord[] }>(
          join(root, 'worktrees.json'), 'worktrees', logger, { items: [] }, validateWorktreesDocument,
        ),
        schedule: docStore<{ items: ScheduleStoreRecord[] }>(
          join(root, 'schedule.json'), 'schedule', logger, { items: [] }, validateScheduleDocument,
        ),
        settings: docStore<GatewaySettingsDoc>(
          join(root, 'settings.json'), 'settings', logger,
          { schemaVersion: 1, revision: 0 }, validateSettingsDocument,
        ),
      }
    } catch (error) {
      close()
      throw error
    }
  })()
  const { worktrees, schedule, settings } = documents

  const tokensFile = join(stateDir, 'tokens.json')
  const jwtSecretFile = join(stateDir, 'jwt-secret')
  const passwordCredentialFile = join(stateDir, 'password-credential')

  /** Parse a schemaVersion-2 credential envelope. `found:false` means the text
   * is not a v2 document (legacy v1); `record:null` means a corrupt v2 doc
   * (including a shape-valid envelope whose verifier is not a real
   * `scrypt$salt$hash` value — treated as corrupt so a garbage verifier can
   * never silently disable authentication). */
  function parseV2Credential(text: string, field: 'verifier' | 'hash'): { found: boolean; record: CredentialRecord | null } {
    if (!text.startsWith('{')) return { found: false, record: null }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return { found: true, record: null } }
    if (parsed === null || typeof parsed !== 'object') return { found: true, record: null }
    const doc = parsed as { schemaVersion?: unknown; source?: unknown; updatedAt?: unknown; verifier?: unknown; hash?: unknown }
    if (doc.schemaVersion !== 2) return { found: false, record: null }
    const verifier = field === 'verifier' ? doc.verifier : doc.hash
    if (typeof verifier !== 'string' || !CREDENTIAL_VERIFIER_RE.test(verifier)
      || (doc.source !== 'config' && doc.source !== 'runtime')
      || typeof doc.updatedAt !== 'number' || !Number.isFinite(doc.updatedAt)) {
      return { found: true, record: null }
    }
    return { found: true, record: { verifier, source: doc.source, updatedAt: doc.updatedAt } }
  }

  function readTokenCredential(): CredentialRecord | null {
    const { value, mtimeMs } = readSecretFile(tokensFile)
    if (value === null) return null
    const v2 = parseV2Credential(value, 'hash')
    if (v2.found) {
      if (v2.record === null) warnOnce(tokensFile, `gateway-store: corrupt v2 tokens.json (${tokensFile})`, logger)
      return v2.record
    }
    // Legacy v1 `{"hash": ...}` without schemaVersion → config-sourced; the
    // next write migrates it to v2.
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch {
      warnOnce(tokensFile, `gateway-store: cannot read ${tokensFile}`, logger)
      return null
    }
    const hash = (parsed as { hash?: unknown } | null)?.hash
    if (typeof hash === 'string' && hash !== '') return { verifier: hash, source: 'config', updatedAt: mtimeMs }
    warnOnce(tokensFile, `gateway-store: cannot read ${tokensFile}`, logger)
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
    if (value === null) return null
    const v2 = parseV2Credential(value, 'verifier')
    if (v2.found) {
      if (v2.record === null) warnOnce(passwordCredentialFile, `gateway-store: corrupt v2 password-credential (${passwordCredentialFile})`, logger)
      return v2.record
    }
    // Legacy v1: a bare `scrypt$salt$hash` string → config-sourced, write time
    // = file mtime; the next write migrates it to v2.
    if (!value.startsWith('{')) {
      if (/^scrypt\$/.test(value)) return { verifier: value, source: 'config', updatedAt: mtimeMs }
      warnOnce(passwordCredentialFile, `gateway-store: unrecognized password-credential file (${passwordCredentialFile})`, logger)
      return null
    }
    warnOnce(passwordCredentialFile, `gateway-store: unrecognized password-credential file (${passwordCredentialFile})`, logger)
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
    worktrees, schedule, settings,
    getTokenHash, getTokenCredential: readTokenCredential, setTokenHash,
    getJwtSecret, rotateJwtSecret,
    getPasswordCredential, getPasswordCredentialRecord: readPasswordCredential, setPasswordCredential,
    close, reacquire,
  }
}
