/**
 * Gateway persistence (design 17 §10): the gateway's OWN state, physically
 * separate from dsh's $DSH_HOME. All JSON docs go through control-plane
 * `createJsonStore` (backup-first + revision + recovery); secrets (token hash,
 * jwt-secret) go through a 0600 atomic-file discipline (never plaintext in a
 * store doc, S5/S8).
 *
 * The gateway is never authoritative over dsh facts: the worktrees/schedule/
 * index docs are the gateway's own orchestration records, and the session
 * index is a derived cache (§8.2).
 */

import { chmodSync, closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import { createJsonStore, type JsonStore, type JsonStoreDocument } from '@dsh-chamber/control-plane'

export interface GatewayStoreLogger { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }

export interface DeviceRecord {
  id: string
  label: string
  platform: string
  tokenHash: string
  createdAt: number
  revokedAt?: number
}

export interface GatewayDocument {
  schemaVersion?: number
  revision?: number
  channels: unknown[]
  devices?: DeviceRecord[]
}

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

/** A json-store-backed document accessor (load-once + mutate). The domain doc
 * shape `T` is the caller's business; the store layers its own `revision`/
 * `schemaVersion` onto it. */
function docStore<T>(filePath: string, logger: GatewayStoreLogger, initial: T): { load(): T & { revision?: number }; get(): T & { revision?: number }; mutate(mutator: (doc: T) => { next: T; changed: boolean }): Promise<void> } {
  const store: JsonStore = createJsonStore({ filePath, logger, initial: initial as JsonStoreDocument, fileMode: 0o600 })
  store.load()
  return {
    load(): T & { revision?: number } { return store.getDoc() as T & { revision?: number } },
    get(): T & { revision?: number } { return store.getDoc() as T & { revision?: number } },
    async mutate(mutator: (doc: T) => { next: T; changed: boolean }): Promise<void> {
      await store.mutate(doc => {
        const { next, changed } = mutator(doc as unknown as T)
        return { next: next as unknown as JsonStoreDocument, changed }
      })
    },
  }
}

/** Read a 0600 file, or null when absent (never a fake-empty on corrupt). */
function readSecret(file: string): string | null {
  let pathStat
  try {
    pathStat = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`gateway secret path must be a regular file: ${file}`)
  }

  // O_NOFOLLOW closes the lstat/open symlink race. Checking the opened inode
  // additionally rejects a regular-file replacement between those calls.
  const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const openedStat = fstatSync(fd)
    if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error(`gateway secret path changed while opening: ${file}`)
    }
    // Tighten legacy or manually provisioned files before any secret bytes are
    // read into process memory.
    fchmodSync(fd, 0o600)
    const text = readFileSync(fd, 'utf8')
    return text.trim() === '' ? null : text
  } finally {
    closeSync(fd)
  }
}

/** 0600 atomic write (tmp → fchmod 0600 → fsync → rename). */
function writeSecret(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  try {
    const fd = openSync(tmp, 'w', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, value)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

export interface GatewayStore {
  /** gateway.json — channels/devices (devices post-MVP). */
  gateway: { load(): GatewayDocument; get(): GatewayDocument; mutate(m: (d: GatewayDocument) => { next: GatewayDocument; changed: boolean }): Promise<void> }
  /** worktrees.json — the git offload records (§8.1). */
  worktrees: { load(): { items: WorktreeStoreRecord[] }; get(): { items: WorktreeStoreRecord[] }; mutate(m: (d: { items: WorktreeStoreRecord[] }) => { next: { items: WorktreeStoreRecord[] }; changed: boolean }): Promise<void> }
  /** schedule.json — cron jobs (§8.4). */
  schedule: { load(): { items: ScheduleStoreRecord[] }; get(): { items: ScheduleStoreRecord[] }; mutate(m: (d: { items: ScheduleStoreRecord[] }) => { next: { items: ScheduleStoreRecord[] }; changed: boolean }): Promise<void> }
  /** settings.json — the /chamber/settings doc (§8.5). */
  settings: { load(): GatewaySettingsDoc; get(): GatewaySettingsDoc; mutate(m: (d: GatewaySettingsDoc) => { next: GatewaySettingsDoc; changed: boolean }): Promise<void> }
  /** tokens.json — the shared token hash (0600, hash only, S5). */
  getTokenHash(): string | null
  setTokenHash(hash: string | null): void
  /** jwt-secret — the session signing key (0600, rotatable, S13). */
  getJwtSecret(): string
  rotateJwtSecret(): string
  /** Persist a salted password verifier and rotate the JWT key whenever the
   * configured password changes or is removed. */
  syncPasswordCredential(password: string | null): void
}

const SCRYPT_SALT_LEN = 16

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
  const root = join(stateDir, 'gateway')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  chmodSync(stateDir, 0o700)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)

  const gateway = docStore<GatewayDocument>(join(stateDir, 'gateway.json'), logger, { schemaVersion: 1, revision: 0, channels: [] })
  const worktrees = docStore<{ items: WorktreeStoreRecord[] }>(join(root, 'worktrees.json'), logger, { items: [] })
  const schedule = docStore<{ items: ScheduleStoreRecord[] }>(join(root, 'schedule.json'), logger, { items: [] })
  const settings = docStore<GatewaySettingsDoc>(join(root, 'settings.json'), logger, { schemaVersion: 1, revision: 0 })

  const tokensFile = join(stateDir, 'tokens.json')
  const jwtSecretFile = join(stateDir, 'jwt-secret')
  const passwordCredentialFile = join(stateDir, 'password-credential')

  function getTokenHash(): string | null {
    try {
      const text = readSecret(tokensFile)
      if (text === null) return null
      const parsed = JSON.parse(text) as { hash?: unknown }
      return typeof parsed.hash === 'string' && parsed.hash !== '' ? parsed.hash : null
    } catch {
      logger.warn(`gateway-store: cannot read ${tokensFile}`)
      return null
    }
  }

  function setTokenHash(hash: string | null): void {
    if (hash === null) {
      try { rmSync(tokensFile, { force: true }) } catch { /* best effort */ }
      return
    }
    writeSecret(tokensFile, `${JSON.stringify({ hash })}\n`)
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

  function syncPasswordCredential(password: string | null): void {
    const existing = readSecret(passwordCredentialFile)
    const unchanged = password === null ? existing === null : verifyCredential(password, existing)
    if (unchanged) return
    // Rotate first. If persisting the new verifier fails, startup fails with
    // old cookies already invalidated instead of accepting a mixed state.
    rotateJwtSecret()
    if (password === null) {
      rmSync(passwordCredentialFile, { force: true })
      return
    }
    writeSecret(passwordCredentialFile, `${hashCredential(password)}\n`)
  }

  return { gateway, worktrees, schedule, settings, getTokenHash, setTokenHash, getJwtSecret, rotateJwtSecret, syncPasswordCredential }
}
