/**
 * dsh runtime snapshot/restore — the cross-version user-data protection core.
 *
 * A snapshot is copied completely to a same-filesystem staging directory before the live
 * DSH_HOME is moved; the marker records every phase and the exact staging/backup paths, so
 * startup recovery never guesses completion from a non-empty directory. Backups are unique and
 * cleanup is an explicit, writer-fenced operation that preserves the newest completed restore
 * field. Pure node built-ins, baseDir/dshHome injected — no electron, no IPC.
 */
import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { renameWithWindowsRetry } from './rename-retry.ts'
import { runtimeSnapshotRetentionState } from './dsh-runtime-store.ts'
import { RESTORE_MARKER_BASENAME } from './restore-marker.ts'
import { assertSafeVersion, isSafeVersion } from './version-safety.ts'
import {
  atomicWriteRuntimeFileNoFollow,
  isUnreadableFsError,
  openPrivateNoFollowSync,
  readPrivateFileStateNoFollow,
} from './private-fs.ts'
import { sameIdentity } from './file-identity.ts'

const PRIVATE_DIR_MODE = 0o700
const MAX_RESTORE_MARKER_BYTES = 128 * 1024

type RestoreMarkerAuthorityRead =
  | { kind: 'missing' }
  | { kind: 'unsafe' }
  | { kind: 'unknown'; detail: string }
  | { kind: 'valid'; raw: string }

export type RestoreMarkerAuthorityStatus = 'missing' | 'present' | 'unsafe'


/** Read the restore authority without following its leaf or runtime dir. Delegates to the
 *  private-fs bounded no-follow reader with `tightenMode: false` (no chmod side effects; the
 *  marker is always 0600). That reader is STRICTER (symlinked baseDir / owner-read-stripped
 *  parent reads 'unsafe'; bigint ns double snapshot + single-link checks on both ends), and a
 *  hard link added after the snapshot stays fail-closed because a later write is refused. On
 *  win32 (no NOFOLLOW) readers/writers hard-fail closed — restore recovery is manual there. */
function readRestoreMarkerAuthority(baseDir: string): RestoreMarkerAuthorityRead {
  const state = readPrivateFileStateNoFollow(
    snapshotPaths(baseDir).restoreMarker,
    MAX_RESTORE_MARKER_BYTES,
    { tightenMode: false },
  )
  if (state.kind === 'present') return { kind: 'valid', raw: state.value.raw }
  if (state.kind === 'unknown') return { kind: 'unknown', detail: state.detail }
  return state.kind === 'missing' ? { kind: 'missing' } : { kind: 'unsafe' }
}

/** Public status keeps its historical fail-closed union: an unreadable marker (EACCES/EIO)
 *  reports 'unsafe' here, while restore entries report cause 'io-error' from the richer state. */
export function restoreMarkerAuthorityStatus(baseDir: string): RestoreMarkerAuthorityStatus {
  const state = readRestoreMarkerAuthority(baseDir)
  if (state.kind === 'missing') return 'missing'
  return state.kind === 'valid' ? 'present' : 'unsafe'
}

export interface SnapshotPaths {
  snapshotsDir: string
  preRollbackDir: string
  restoreMarker: string
}

export type RestoreBackupCleanupStatus =
  | 'completed'
  | 'blocked-marker'
  | 'blocked-home-missing'
  | 'blocked-unsafe-entry'

export interface SnapshotArtifactCleanupResult {
  /** Paths relative to dsh-runtime (never absolute userData paths). */
  removedTemporaryEntries: string[]
  /** Basenames beside DSH_HOME (never absolute userData paths). */
  removedRestoreBackups: string[]
  restoreBackupCleanup: RestoreBackupCleanupStatus
}

export function snapshotPaths(baseDir: string): SnapshotPaths {
  const runtime = join(baseDir, 'dsh-runtime')
  return {
    snapshotsDir: join(runtime, 'snapshots'),
    preRollbackDir: join(runtime, 'pre-rollback'),
    restoreMarker: join(runtime, RESTORE_MARKER_BASENAME),
  }
}

export type CopyFn = (src: string, dest: string) => Promise<void>
export type RestoreOutcome = 'complete' | 'half' | 'incomplete'
export type RestorePhase = 'copying' | 'staged' | 'backing-up' | 'publishing' | 'published'

/** Honest restore result: the outcome describes the durable disk state (complete /
 *  resumable-half / resumable-incomplete) while cause/error name the real failure. */
export interface RestoreReport {
  readonly outcome: 'complete' | 'half' | 'incomplete'
  readonly cause: 'copy-failed' | 'io-error' | 'marker-invalid' | 'state-refused' | 'unexpected' | null
  readonly error: string | null
}

function cleanReport(outcome: RestoreOutcome): RestoreReport {
  return { outcome, cause: null, error: null }
}

/** Boolean refusal of an owned-directory state (unsafe symlink/identity, or a failed tighten
 *  re-verification); like marker-invalid this is a validation refusal, not a thrown failure. */
function refusedReport(outcome: RestoreOutcome, error: string): RestoreReport {
  return { outcome, cause: 'state-refused', error }
}

function blockedReport(
  cause: NonNullable<RestoreReport['cause']>,
  error: string,
  outcome: RestoreOutcome = 'incomplete',
): RestoreReport {
  return { outcome, cause, error }
}

function failureReport(
  outcome: RestoreOutcome,
  cause: 'copy-failed' | 'io-error' | 'unexpected',
  error: unknown,
): RestoreReport {
  return { outcome, cause, error: error instanceof Error ? error.message : String(error) }
}

/** EACCES/EIO/unknown OS failures are 'io-error'; a context fallback (copy-failed / unexpected)
 *  covers refusal-style errors without an errno. */
function classifyRestoreFailure(
  error: unknown,
  fallback: 'copy-failed' | 'unexpected',
): 'copy-failed' | 'io-error' | 'unexpected' {
  return isUnreadableFsError(error) ? 'io-error' : fallback
}

/** Legacy outcome projection: a real failure throws with the report attached rather than folding
 *  into 'incomplete'; validation refusals keep the old result. */
function requireOutcome(report: RestoreReport): RestoreOutcome {
  if (report.cause === null || report.cause === 'marker-invalid' || report.cause === 'state-refused') return report.outcome
  const error = new Error('runtime restore failed (' + report.cause + '): ' + (report.error ?? 'unknown error'))
  ;(error as Error & { restoreReport?: RestoreReport }).restoreReport = report
  throw error
}

export interface RestoreMarker {
  schemaVersion: 1
  phase: RestorePhase
  snapshotPath: string
  dshHome: string
  stagingPath: string
  backupPath: string
  hadDshHome: boolean
  startedAt: number
  updatedAt: number
}

/** Throwing simulates a crash after the phase was durably persisted. */
export interface RestoreHooks {
  afterPhase?: (phase: RestorePhase, marker: Readonly<RestoreMarker>) => void | Promise<void>
}

const defaultCopy: CopyFn = async (src, dest) => {
  await cp(src, dest, { recursive: true })
}

async function ensurePrivateDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: false, mode: PRIVATE_DIR_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // Never chmod through a directory symlink: the descriptor helper pins the final component and
  // its parent before tightening the owned inode.
  if (!tightenOwnedDirectory(dir)) throw new Error(`不安全的私有目录：${basename(dir)}`)
}

async function ensureRuntimeSubdir(baseDir: string, dir: string): Promise<void> {
  const runtimeDir = dirname(snapshotPaths(baseDir).snapshotsDir)
  await ensurePrivateDir(runtimeDir)
  await ensurePrivateDir(dir)
}

/** Durable marker write via the shared private-fs atomic writer: no-follow tmp + file fsync +
 *  rename + parent fsync + identity re-verifies — durability, not optimization. */
async function atomicWriteMarker(baseDir: string, filePath: string, marker: RestoreMarker): Promise<void> {
  atomicWriteRuntimeFileNoFollow(baseDir, filePath, `${JSON.stringify(marker, null, 2)}\n`)
}

async function pathIsDirectoryNoFollow(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

type OwnedDirectoryState = 'missing' | 'directory' | 'unsafe'

function ownedDirectoryState(path: string): OwnedDirectoryState {
  const parent = dirname(path)
  let parentBefore: ReturnType<typeof lstatSync>
  try { parentBefore = lstatSync(parent) } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe'
  }
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) return 'unsafe'
  try {
    const info = lstatSync(path)
    const parentAfter = lstatSync(parent)
    return !info.isSymbolicLink()
      && info.isDirectory()
      && parentAfter.isDirectory()
      && !parentAfter.isSymbolicLink()
      && sameIdentity(parentBefore, parentAfter)
      ? 'directory'
      : 'unsafe'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unsafe'
    try {
      const parentAfter = lstatSync(parent)
      return parentAfter.isDirectory()
        && !parentAfter.isSymbolicLink()
        && sameIdentity(parentBefore, parentAfter)
        ? 'missing'
        : 'unsafe'
    } catch {
      return 'unsafe'
    }
  }
}

function entryExistsNoFollow(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return true
  }
}

/** Tighten only an already-opened real directory and revalidate its path. */
function tightenOwnedDirectory(path: string): boolean {
  const parent = dirname(path)
  let parentBefore: ReturnType<typeof lstatSync>
  try { parentBefore = lstatSync(parent) } catch { return false }
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) return false
  let before: ReturnType<typeof lstatSync>
  try { before = lstatSync(path) } catch { return false }
  if (before.isSymbolicLink() || !before.isDirectory()) return false
  let fd: number | null = null
  try {
    // kind 'read' uses POSIX O_RDONLY|O_NOFOLLOW (no O_DIRECTORY here); the win32 fallback
    // re-proves identity around the open instead of following a link.
    const openedDirectory = openPrivateNoFollowSync(path, 'read')
    fd = openedDirectory.fd
    const opened = openedDirectory.stats
    if (!opened.isDirectory() || !sameIdentity(before, opened)) return false
    fchmodSync(fd, PRIVATE_DIR_MODE)
    const afterFd = fstatSync(fd)
    const afterPath = lstatSync(path)
    const parentAfter = lstatSync(parent)
    return afterFd.isDirectory()
      && afterPath.isDirectory()
      && !afterPath.isSymbolicLink()
      && sameIdentity(opened, afterFd)
      && sameIdentity(afterFd, afterPath)
      && parentAfter.isDirectory()
      && !parentAfter.isSymbolicLink()
      && sameIdentity(parentBefore, parentAfter)
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

async function removeCrashTemporaryEntries(
  root: string,
  relativeRoot: 'snapshots' | 'pre-rollback',
): Promise<string[]> {
  const rootState = ownedDirectoryState(root)
  if (rootState === 'missing') return []
  if (rootState === 'unsafe') throw new Error(`${relativeRoot} 根目录不安全，拒绝清理`)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.name.startsWith('.tmp-')) continue
    // `entry.name` comes from a direct readdir of the private root; rm unlinks a symlink itself
    // rather than following it, and recursive covers the staging shape.
    await rm(join(root, entry.name), { recursive: true, force: true })
    removed.push(`${relativeRoot}/${entry.name}`)
  }
  return removed
}

interface RestoreBackupEntry {
  name: string
  path: string
  recencyMs: number
}

function restoreBackupNameMatches(homeName: string, entryName: string): boolean {
  return entryName === `${homeName}.old` || entryName.startsWith(`${homeName}.old-`)
}

function backupNameTimestamp(homeName: string, entryName: string): number {
  if (entryName === `${homeName}.old`) return 0
  const match = /^(\d+)(?:-|$)/.exec(entryName.slice(`${homeName}.old-`.length))
  if (match === null) return 0
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : 0
}

/**
 * Remove crash-only staging and bound completed restore backups. The caller must hold the same
 * writer fence used for snapshot/restore. Any restore marker (valid, corrupt, file, or symlink)
 * blocks the entire cleanup; without one, orphan `.tmp-*` entries are safe to remove and backups
 * are pruned only when DSH_HOME and every matching sibling are real directories, newest kept.
 */
export async function cleanupSnapshotArtifacts(
  baseDir: string,
  dshHome: string,
): Promise<SnapshotArtifactCleanupResult> {
  const paths = snapshotPaths(baseDir)
  const result: SnapshotArtifactCleanupResult = {
    removedTemporaryEntries: [],
    removedRestoreBackups: [],
    restoreBackupCleanup: 'completed',
  }

  // Presence alone is authoritative: parsing a corrupt marker to decide what is disposable would
  // invert the recovery protocol's fail-closed boundary.
  if (restoreMarkerAuthorityStatus(baseDir) !== 'missing') {
    result.restoreBackupCleanup = 'blocked-marker'
    return result
  }

  if (ownedDirectoryState(paths.snapshotsDir) === 'unsafe'
    || ownedDirectoryState(paths.preRollbackDir) === 'unsafe') {
    result.restoreBackupCleanup = 'blocked-unsafe-entry'
    return result
  }

  result.removedTemporaryEntries.push(
    ...await removeCrashTemporaryEntries(paths.snapshotsDir, 'snapshots'),
    ...await removeCrashTemporaryEntries(paths.preRollbackDir, 'pre-rollback'),
  )

  const resolvedHome = resolve(dshHome)
  const homeState = ownedDirectoryState(resolvedHome)
  if (homeState === 'missing') {
    result.restoreBackupCleanup = 'blocked-home-missing'
    return result
  }
  if (homeState === 'unsafe') {
    result.restoreBackupCleanup = 'blocked-unsafe-entry'
    return result
  }

  // Recheck at the destructive backup boundary: production calls this under a writer fence, but
  // an unexpected external marker still wins fail closed.
  if (restoreMarkerAuthorityStatus(baseDir) !== 'missing') {
    result.restoreBackupCleanup = 'blocked-marker'
    return result
  }

  const homeParent = dirname(resolvedHome)
  const homeName = basename(resolvedHome)
  if (ownedDirectoryState(homeParent) !== 'directory') {
    result.restoreBackupCleanup = 'blocked-unsafe-entry'
    return result
  }
  let siblingEntries
  try {
    siblingEntries = await readdir(homeParent, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      result.restoreBackupCleanup = 'blocked-home-missing'
      return result
    }
    throw error
  }
  const backups: RestoreBackupEntry[] = []
  for (const entry of siblingEntries) {
    if (!restoreBackupNameMatches(homeName, entry.name)) continue
    const path = join(homeParent, entry.name)
    let info
    try {
      info = await lstat(path)
    } catch {
      result.restoreBackupCleanup = 'blocked-unsafe-entry'
      return result
    }
    // Never unlink a path an external actor could redirect, and never guess that a same-name
    // file is disposable restore data.
    if (!info.isDirectory() || info.isSymbolicLink()) {
      result.restoreBackupCleanup = 'blocked-unsafe-entry'
      return result
    }
    backups.push({
      name: entry.name,
      path,
      recencyMs: Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs, backupNameTimestamp(homeName, entry.name)),
    })
  }

  backups.sort((a, b) => b.recencyMs - a.recencyMs || b.name.localeCompare(a.name))
  for (const backup of backups.slice(1)) {
    if (ownedDirectoryState(homeParent) !== 'directory'
      || ownedDirectoryState(backup.path) !== 'directory') {
      result.restoreBackupCleanup = 'blocked-unsafe-entry'
      return result
    }
    await rm(backup.path, { recursive: true, force: true })
    result.removedRestoreBackups.push(backup.name)
  }
  return result
}

async function isPublishedSnapshotPath(baseDir: string, path: string): Promise<boolean> {
  const { snapshotsDir } = snapshotPaths(baseDir)
  if (ownedDirectoryState(snapshotsDir) !== 'directory') return false
  const candidate = resolve(path)
  if (dirname(candidate) !== resolve(snapshotsDir)) return false
  if (parseSnapshotEntry(snapshotsDir, basename(candidate)) === null) return false
  return pathIsDirectoryNoFollow(candidate)
}

/**
 * A pre-rollback stash source must be a real, non-symlink directory directly under the private
 * pre-rollback root with a stash-shaped basename; the parent identity is revalidated without
 * following the leaf, so a redirect between readdir and this check fails closed.
 */
async function isPublishedStashPath(baseDir: string, path: string): Promise<boolean> {
  const { preRollbackDir } = snapshotPaths(baseDir)
  if (ownedDirectoryState(preRollbackDir) !== 'directory') return false
  const candidate = resolve(path)
  if (dirname(candidate) !== resolve(preRollbackDir)) return false
  if (!isStashName(basename(candidate))) return false
  return ownedDirectoryState(candidate) === 'directory'
}

/** The restore transaction may copy from a snapshot or a pre-rollback stash; each check must be
 *  awaited, since an un-awaited promise is truthy and would mask the stash path. */
async function isPublishedRestoreSource(baseDir: string, path: string): Promise<boolean> {
  if (await isPublishedSnapshotPath(baseDir, path)) return true
  return isPublishedStashPath(baseDir, path)
}

function pathIsInside(path: string, parent: string): boolean {
  const candidate = resolve(path)
  const root = resolve(parent)
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function safeSnapshotSource(sourceVersion: string): string {
  return assertSafeVersion(sourceVersion)
}

async function nextSnapshotPath(snapshotsDir: string, sourceVersion: string): Promise<string> {
  let timestamp = Date.now()
  let candidate = join(snapshotsDir, `${sourceVersion}-${timestamp}`)
  while (existsSync(candidate)) {
    timestamp += 1
    candidate = join(snapshotsDir, `${sourceVersion}-${timestamp}`)
  }
  return candidate
}

/** Still-copy DSH_HOME and atomically publish the snapshot. */
export async function snapshotDshHome(
  baseDir: string,
  dshHome: string,
  sourceVersion: string,
  copyFn: CopyFn = defaultCopy,
): Promise<string> {
  const paths = snapshotPaths(baseDir)
  const safeSource = safeSnapshotSource(sourceVersion)
  await ensureRuntimeSubdir(baseDir, paths.snapshotsDir)
  const staging = join(paths.snapshotsDir, `.tmp-${randomBytes(6).toString('hex')}`)
  const finalPath = await nextSnapshotPath(paths.snapshotsDir, safeSource)
  await ensurePrivateDir(staging)
  try {
    const sourceState = ownedDirectoryState(dshHome)
    if (sourceState === 'unsafe') throw new Error('DSH_HOME 不是安全的真实目录')
    if (sourceState === 'directory') await copyFn(dshHome, staging)
    if (ownedDirectoryState(paths.snapshotsDir) !== 'directory'
      || !tightenOwnedDirectory(staging)) throw new Error('快照暂存目录身份不再可信')
    // Directory publish: bounded Windows retry absorbs third-party handle occupancy
    // (Defender/indexer/Explorer); POSIX is a plain rename.
    await renameWithWindowsRetry(staging, finalPath)
    if (ownedDirectoryState(paths.snapshotsDir) !== 'directory'
      || !tightenOwnedDirectory(finalPath)) throw new Error('快照发布目录身份不再可信')
    return finalPath
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function newTransactionPaths(dshHome: string): { stagingPath: string; backupPath: string } {
  const id = `${Date.now()}-${randomBytes(5).toString('hex')}`
  const stagingPath = join(dirname(dshHome), `.${basename(dshHome)}.restore-${id}`)
  const preferredBackup = `${dshHome}.old`
  // An old restore field may be the only copy of user data. Never replace it.
  const backupPath = entryExistsNoFollow(preferredBackup) ? `${preferredBackup}-${id}` : preferredBackup
  return { stagingPath, backupPath }
}

function isRestorePhase(value: unknown): value is RestorePhase {
  return value === 'copying' || value === 'staged' || value === 'backing-up' || value === 'publishing' || value === 'published'
}

function parseMarker(raw: string, baseDir: string, dshHome: string): RestoreMarker | { legacySnapshotPath: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>

  // Legacy markers had no phase and are intrinsically ambiguous; start a new staged transaction
  // and do not infer completion from dshHome + `.old`.
  if (record.schemaVersion === undefined) {
    return typeof record.snapshotPath === 'string' && record.snapshotPath !== ''
      ? { legacySnapshotPath: record.snapshotPath }
      : null
  }

  if (record.schemaVersion !== 1 || !isRestorePhase(record.phase)) return null
  if (typeof record.snapshotPath !== 'string' || typeof record.dshHome !== 'string') return null
  if (typeof record.stagingPath !== 'string' || typeof record.backupPath !== 'string') return null
  if (typeof record.hadDshHome !== 'boolean' || typeof record.startedAt !== 'number' || typeof record.updatedAt !== 'number') return null
  if (resolve(record.dshHome) !== resolve(dshHome)) return null
  // A marker may name a snapshot or a pre-rollback stash as its source; both live under the
  // private dsh-runtime root and are re-validated per phase.
  if (!pathIsInside(record.snapshotPath, snapshotPaths(baseDir).snapshotsDir)
    && !pathIsInside(record.snapshotPath, snapshotPaths(baseDir).preRollbackDir)) return null

  const homeParent = dirname(resolve(dshHome))
  const homeName = basename(dshHome)
  if (dirname(resolve(record.stagingPath)) !== homeParent || !basename(record.stagingPath).startsWith(`.${homeName}.restore-`)) return null
  const backupName = basename(record.backupPath)
  if (dirname(resolve(record.backupPath)) !== homeParent || (backupName !== `${homeName}.old` && !backupName.startsWith(`${homeName}.old-`))) return null

  return {
    schemaVersion: 1,
    phase: record.phase,
    snapshotPath: record.snapshotPath,
    dshHome: record.dshHome,
    stagingPath: record.stagingPath,
    backupPath: record.backupPath,
    hadDshHome: record.hadDshHome,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  }
}

async function persistPhase(baseDir: string, markerPath: string, marker: RestoreMarker, phase: RestorePhase, hooks: RestoreHooks): Promise<void> {
  marker.phase = phase
  marker.updatedAt = Date.now()
  await atomicWriteMarker(baseDir, markerPath, marker)
  await hooks.afterPhase?.(phase, marker)
}

async function beginRestore(
  baseDir: string,
  dshHome: string,
  snapshotPath: string,
  hooks: RestoreHooks,
): Promise<RestoreMarker> {
  const { restoreMarker } = snapshotPaths(baseDir)
  const paths = newTransactionPaths(dshHome)
  const legacyBackup = `${dshHome}.old`
  const legacyBackupState = ownedDirectoryState(legacyBackup)
  if (legacyBackupState === 'unsafe') throw new Error('旧恢复备份不是安全的真实目录')
  if (legacyBackupState === 'directory' && !tightenOwnedDirectory(legacyBackup)) {
    throw new Error('无法安全确认旧恢复备份')
  }
  const homeState = ownedDirectoryState(dshHome)
  if (homeState === 'unsafe') throw new Error('DSH_HOME 不是安全的真实目录')
  const now = Date.now()
  const marker: RestoreMarker = {
    schemaVersion: 1,
    phase: 'copying',
    snapshotPath: resolve(snapshotPath),
    dshHome: resolve(dshHome),
    stagingPath: resolve(paths.stagingPath),
    backupPath: resolve(paths.backupPath),
    hadDshHome: homeState === 'directory',
    startedAt: now,
    updatedAt: now,
  }
  await atomicWriteMarker(baseDir, restoreMarker, marker)
  await hooks.afterPhase?.('copying', marker)
  return marker
}

function interruptedOutcome(marker: RestoreMarker, dshHome: string): RestoreOutcome {
  if (entryExistsNoFollow(marker.backupPath)
    || (marker.hadDshHome && !entryExistsNoFollow(dshHome))) return 'half'
  return 'incomplete'
}

async function runRestoreTransaction(
  baseDir: string,
  dshHome: string,
  marker: RestoreMarker,
  copyFn: CopyFn,
  hooks: RestoreHooks,
): Promise<RestoreReport> {
  const markerPath = snapshotPaths(baseDir).restoreMarker
  try {
    if (marker.phase === 'copying') {
      if (!(await isPublishedRestoreSource(baseDir, marker.snapshotPath))) {
        return blockedReport('marker-invalid', '恢复标记指向的 snapshot 不再可发布')
      }
      // Contents in a copying staging dir are never trusted, even non-empty.
      await rm(marker.stagingPath, { recursive: true, force: true })
      await ensurePrivateDir(marker.stagingPath)
      try {
        await copyFn(marker.snapshotPath, marker.stagingPath)
      } catch (error) {
        await rm(marker.stagingPath, { recursive: true, force: true }).catch(() => {})
        // Reported instead of folded: the marker stays durable for a retry, but the caller learns
        // the copy itself failed.
        return failureReport('incomplete', classifyRestoreFailure(error, 'copy-failed'), error)
      }
      if (!tightenOwnedDirectory(marker.stagingPath)) {
        return refusedReport('incomplete', '复制的暂存目录身份无法确认，拒绝发布：' + basename(marker.stagingPath))
      }
      await persistPhase(baseDir, markerPath, marker, 'staged', hooks)
    }

    if (marker.phase === 'staged') {
      const stagingState = ownedDirectoryState(marker.stagingPath)
      if (stagingState === 'unsafe') {
        return refusedReport('incomplete', '暂存目录状态不安全，拒绝继续恢复：' + basename(marker.stagingPath))
      }
      if (stagingState === 'missing') {
        await persistPhase(baseDir, markerPath, marker, 'copying', hooks)
        return runRestoreTransaction(baseDir, dshHome, marker, copyFn, hooks)
      }
      if (!tightenOwnedDirectory(marker.stagingPath)) {
        return refusedReport('incomplete', '暂存目录身份在备份前无法确认：' + basename(marker.stagingPath))
      }
      await persistPhase(baseDir, markerPath, marker, 'backing-up', hooks)
    }

    if (marker.phase === 'backing-up') {
      let homeState = ownedDirectoryState(dshHome)
      let backupState = ownedDirectoryState(marker.backupPath)
      if (homeState === 'unsafe' || backupState === 'unsafe') {
        return refusedReport('incomplete', 'DSH_HOME 或备份目录状态不安全，拒绝备份')
      }
      if (marker.hadDshHome) {
        if (homeState === 'directory' && backupState === 'directory') return cleanReport('half')
        if (homeState === 'missing' && backupState === 'missing') {
          return refusedReport('incomplete', 'DSH_HOME 与其备份同时缺失，恢复无法继续')
        }
        if (homeState === 'directory') {
          if (!tightenOwnedDirectory(dshHome)) {
            return refusedReport('incomplete', 'DSH_HOME 身份无法确认，拒绝备份')
          }
          await renameWithWindowsRetry(dshHome, marker.backupPath)
          homeState = ownedDirectoryState(dshHome)
          backupState = ownedDirectoryState(marker.backupPath)
          if (homeState !== 'missing' || backupState !== 'directory') {
            return refusedReport('incomplete', '备份重命名后目录状态不符合预期（DSH_HOME 未消失或备份不是目录）')
          }
        }
        if (!tightenOwnedDirectory(marker.backupPath)) {
          return refusedReport('incomplete', '备份目录身份无法确认，拒绝发布恢复数据：' + basename(marker.backupPath))
        }
      } else if (homeState !== 'missing' || backupState !== 'missing') {
        // An external path appeared after the transaction began; preserve it.
        return cleanReport('half')
      }
      await persistPhase(baseDir, markerPath, marker, 'publishing', hooks)
    }

    if (marker.phase === 'publishing') {
      let stagingState = ownedDirectoryState(marker.stagingPath)
      let homeState = ownedDirectoryState(dshHome)
      if (stagingState === 'unsafe' || homeState === 'unsafe') {
        return refusedReport('incomplete', '暂存目录或 DSH_HOME 状态不安全，拒绝发布')
      }
      if (stagingState === 'directory' && homeState === 'directory') return cleanReport('half')
      if (stagingState === 'missing' && homeState === 'missing') {
        return refusedReport('incomplete', '暂存目录与 DSH_HOME 同时缺失，发布无法继续')
      }
      if (stagingState === 'directory') {
        if (!tightenOwnedDirectory(marker.stagingPath)) {
          return refusedReport('incomplete', '暂存目录身份无法确认，拒绝重命名发布：' + basename(marker.stagingPath))
        }
        await renameWithWindowsRetry(marker.stagingPath, dshHome)
        stagingState = ownedDirectoryState(marker.stagingPath)
        homeState = ownedDirectoryState(dshHome)
        if (stagingState !== 'missing' || homeState !== 'directory') {
          return refusedReport('incomplete', '发布重命名后目录状态不符合预期（暂存目录未消失或 DSH_HOME 不是目录）')
        }
      }
      if (!tightenOwnedDirectory(dshHome)) {
        return refusedReport('incomplete', '发布后的 DSH_HOME 身份无法确认：' + basename(dshHome))
      }
      await persistPhase(baseDir, markerPath, marker, 'published', hooks)
    }

    if (marker.phase === 'published') {
      if (ownedDirectoryState(dshHome) !== 'directory' || !tightenOwnedDirectory(dshHome)) {
        return refusedReport('incomplete', '已发布状态复核失败：DSH_HOME 不是可信目录')
      }
      await rm(markerPath, { force: true })
      return cleanReport('complete')
    }
  } catch (error) {
    // A real exception no longer masquerades as "the disk state is merely resumable": the outcome
    // describes the durable state while cause/error carry the failure.
    return {
      outcome: interruptedOutcome(marker, dshHome),
      cause: classifyRestoreFailure(error, 'unexpected'),
      error: error instanceof Error ? error.message : String(error),
    }
  }
  return cleanReport(interruptedOutcome(marker, dshHome))
}

export type RestoreMarkerSpawn =
  | { kind: 'snapshot'; path: string }
  | { kind: 'stash'; path: string }
  | { kind: 'resume' }

export type RestoreMarkerSession =
  | { kind: 'marker'; marker: RestoreMarker }
  | { kind: 'none' }
  | { kind: 'blocked'; report: RestoreReport }

/**
 * Shared authority prefix of every restore entry: read the marker, create the private runtime dir
 * when absent, resume any valid marker (legacy included), or begin from the caller's source.
 * spawn.kind === 'resume' never starts a transaction, so completeInterruptedRestore keeps its
 * 'none' short-circuit without touching the filesystem; spawn/hooks are optional.
 */
export async function openOrResumeRestoreMarker(
  baseDir: string,
  dshHome: string,
  spawn: RestoreMarkerSpawn = { kind: 'resume' },
  hooks: RestoreHooks = {},
): Promise<RestoreMarkerSession> {
  const { restoreMarker, snapshotsDir } = snapshotPaths(baseDir)
  let authority = readRestoreMarkerAuthority(baseDir)
  if (authority.kind === 'unknown') {
    return { kind: 'blocked', report: blockedReport('io-error', authority.detail) }
  }
  if (authority.kind === 'unsafe') {
    return { kind: 'blocked', report: blockedReport('marker-invalid', '恢复标记不安全或形状非法') }
  }
  if (authority.kind === 'missing') {
    if (spawn.kind === 'resume') return { kind: 'none' }
    await ensurePrivateDir(dirname(restoreMarker))
    authority = readRestoreMarkerAuthority(baseDir)
    if (authority.kind === 'unknown') {
      return { kind: 'blocked', report: blockedReport('io-error', authority.detail) }
    }
    if (authority.kind === 'unsafe') {
      return { kind: 'blocked', report: blockedReport('marker-invalid', '恢复标记不安全或形状非法') }
    }
  }

  if (authority.kind === 'valid') {
    const parsed = parseMarker(authority.raw, baseDir, dshHome)
    if (parsed === null) {
      return { kind: 'blocked', report: blockedReport('marker-invalid', '恢复标记形状非法') }
    }
    if (!('legacySnapshotPath' in parsed)) return { kind: 'marker', marker: parsed }
    // Legacy markers predate stashes and can only reference snapshots.
    const legacySnapshot = parsed.legacySnapshotPath
    if (!pathIsInside(legacySnapshot, snapshotsDir) || !(await isPublishedSnapshotPath(baseDir, legacySnapshot))) {
      return {
        kind: 'blocked',
        report: blockedReport('marker-invalid', 'legacy 恢复标记指向的 snapshot 不再可发布'),
      }
    }
    return beginRestoreSession(baseDir, dshHome, legacySnapshot, hooks)
  }

  if (spawn.kind === 'snapshot') {
    if (!pathIsInside(spawn.path, snapshotsDir) || !(await isPublishedSnapshotPath(baseDir, spawn.path))) {
      return {
        kind: 'blocked',
        report: blockedReport('marker-invalid', 'snapshot 路径不合法或不再可发布'),
      }
    }
    return beginRestoreSession(baseDir, dshHome, spawn.path, hooks)
  }
  if (spawn.kind === 'stash') return beginRestoreSession(baseDir, dshHome, spawn.path, hooks)
  return { kind: 'none' }
}

/** Begin a fresh marker transaction and map any begin failure to a report. */
async function beginRestoreSession(
  baseDir: string,
  dshHome: string,
  snapshotPath: string,
  hooks: RestoreHooks,
): Promise<RestoreMarkerSession> {
  try {
    return { kind: 'marker', marker: await beginRestore(baseDir, dshHome, snapshotPath, hooks) }
  } catch (error) {
    return {
      kind: 'blocked',
      report: failureReport('incomplete', classifyRestoreFailure(error, 'unexpected'), error),
    }
  }
}

/** Report-returning snapshot restore core. */
export async function restoreSnapshotReport(
  baseDir: string,
  dshHome: string,
  snapshotPath: string,
  copyFn: CopyFn = defaultCopy,
  hooks: RestoreHooks = {},
): Promise<RestoreReport> {
  const session = await openOrResumeRestoreMarker(baseDir, dshHome, { kind: 'snapshot', path: snapshotPath }, hooks)
  if (session.kind === 'blocked') return session.report
  if (session.kind === 'none') {
    return blockedReport('marker-invalid', 'snapshot 路径不合法或不再可发布')
  }
  return runRestoreTransaction(baseDir, dshHome, session.marker, copyFn, hooks)
}

/** Restore a snapshot over DSH_HOME using the durable phase transaction. */
export async function restoreSnapshot(
  baseDir: string,
  dshHome: string,
  snapshotPath: string,
  copyFn: CopyFn = defaultCopy,
  hooks: RestoreHooks = {},
): Promise<RestoreOutcome> {
  return requireOutcome(await restoreSnapshotReport(baseDir, dshHome, snapshotPath, copyFn, hooks))
}

/** Report-returning pre-rollback core. */
export async function restorePreRollbackReport(
  baseDir: string,
  dshHome: string,
  stashName: string,
  copyFn: CopyFn = defaultCopy,
  hooks: RestoreHooks = {},
): Promise<RestoreReport> {
  const stashPath = await resolveStashPath(baseDir, stashName)
  if (stashPath === null) {
    return blockedReport('marker-invalid', '回滚暂存不存在或不可信：' + stashName)
  }
  const session = await openOrResumeRestoreMarker(baseDir, dshHome, { kind: 'stash', path: stashPath }, hooks)
  if (session.kind === 'blocked') return session.report
  if (session.kind === 'none') return blockedReport('marker-invalid', '没有可恢复的回滚暂存')
  const report = await runRestoreTransaction(baseDir, dshHome, session.marker, copyFn, hooks)
  if (report.outcome === 'complete') {
    // The stash has been consumed (content now lives in DSH_HOME, pre-restore data in
    // dsh-home.old): remove it so the rollback action disappears; a 'half' outcome keeps it
    // because the durable marker resumes from it.
    await rm(stashPath, { recursive: true, force: true }).catch(() => {})
  }
  return report
}

/**
 * Restore a pre-rollback stash over DSH_HOME. The stash is validated as a real, non-symlink
 * directory under the private pre-rollback root before the marker is written and again inside
 * the copying phase on resume; an existing valid marker (snapshot or stash) wins.
 */
export async function restorePreRollback(
  baseDir: string,
  dshHome: string,
  stashName: string,
  copyFn: CopyFn = defaultCopy,
  hooks: RestoreHooks = {},
): Promise<RestoreOutcome> {
  return requireOutcome(await restorePreRollbackReport(baseDir, dshHome, stashName, copyFn, hooks))
}

/** Return snapshots for an exact source version, newest first. */
export async function listSnapshotsForVersion(baseDir: string, version: string): Promise<string[]> {
  const safe = assertSafeVersion(version)
  const { snapshotsDir } = snapshotPaths(baseDir)
  const rootState = ownedDirectoryState(snapshotsDir)
  if (rootState === 'missing') return []
  if (rootState === 'unsafe') throw new Error('快照根目录不安全')
  let entries
  try {
    entries = await readdir(snapshotsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const prefix = `${safe}-`
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && /^\d+$/.test(entry.name.slice(prefix.length)))
    .map((entry) => ({ path: join(snapshotsDir, entry.name), timestamp: Number(entry.name.slice(prefix.length)) }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((entry) => entry.path)
}

export async function findLatestSnapshotForVersion(baseDir: string, version: string): Promise<string | null> {
  return (await listSnapshotsForVersion(baseDir, version))[0] ?? null
}

/** Resolve a journal-stored basename back into the private snapshot root. */
export async function resolveSnapshotName(baseDir: string, snapshotName: string): Promise<string | null> {
  if (typeof snapshotName !== 'string'
    || snapshotName.length === 0
    || snapshotName.length > 255
    || basename(snapshotName) !== snapshotName
    || snapshotName === '.'
    || snapshotName === '..') return null
  const { snapshotsDir } = snapshotPaths(baseDir)
  const candidate = join(snapshotsDir, snapshotName)
  return pathIsInside(candidate, snapshotsDir) && await isPublishedSnapshotPath(baseDir, candidate) ? candidate : null
}

/** Exact basename shape written by `stashPreRollback` (`<epochMs>-<hex>`). */
function isStashName(name: string): boolean {
  return name.length <= 255
    && /^\d{13}-[0-9a-f]{8}$/.test(name)
}

function stashTimestamp(name: string): number {
  const match = /^(\d+)-/.exec(name)
  if (match === null) return 0
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : 0
}

/**
 * Safe, non-symlink pre-rollback stash names (basenames only, newest first); dirent
 * `isDirectory()` never follows a symlink and non-stash entries are ignored.
 */
export async function listPreRollbackStashes(baseDir: string): Promise<string[]> {
  const { preRollbackDir } = snapshotPaths(baseDir)
  const rootState = ownedDirectoryState(preRollbackDir)
  if (rootState === 'missing') return []
  if (rootState === 'unsafe') throw new Error('回滚暂存根目录不安全')
  let entries
  try {
    entries = await readdir(preRollbackDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((entry) => entry.isDirectory() && isStashName(entry.name))
    .sort((a, b) => stashTimestamp(b.name) - stashTimestamp(a.name) || b.name.localeCompare(a.name))
    .map((entry) => entry.name)
}

/**
 * Resolve a stash basename into the private pre-rollback root with a no-follow identity check
 * (parent + leaf revalidated, symlinks/unsafe dirs rejected). Tightening the owned inode also
 * proves the path was not redirected after the lstat; the caller requires this before any marker
 * write or rename.
 */
async function resolveStashPath(baseDir: string, stashName: string): Promise<string | null> {
  if (typeof stashName !== 'string' || !isStashName(stashName)) return null
  const { preRollbackDir } = snapshotPaths(baseDir)
  const candidate = join(preRollbackDir, stashName)
  if (!pathIsInside(candidate, preRollbackDir)) return null
  if (ownedDirectoryState(candidate) !== 'directory' || !tightenOwnedDirectory(candidate)) return null
  return candidate
}

/**
 * Stash current DSH_HOME before manual rollback: a still copy into a temporary directory
 * followed by an atomic publish, so the live DSH_HOME is not renamed away before the durable
 * restore marker exists and a crash here leaves the authoritative data untouched.
 */
export async function stashPreRollback(
  baseDir: string,
  dshHome: string,
  copyFn: CopyFn = defaultCopy,
): Promise<string> {
  const { preRollbackDir } = snapshotPaths(baseDir)
  await ensureRuntimeSubdir(baseDir, preRollbackDir)
  const dest = join(preRollbackDir, `${Date.now()}-${randomBytes(4).toString('hex')}`)
  const staging = join(preRollbackDir, `.tmp-${randomBytes(6).toString('hex')}`)
  await ensurePrivateDir(staging)
  try {
    const sourceState = ownedDirectoryState(dshHome)
    if (sourceState === 'unsafe') throw new Error('DSH_HOME 不是安全的真实目录')
    if (sourceState === 'directory') await copyFn(dshHome, staging)
    if (ownedDirectoryState(preRollbackDir) !== 'directory'
      || !tightenOwnedDirectory(staging)) throw new Error('回滚暂存目录身份不再可信')
    await renameWithWindowsRetry(staging, dest)
    if (ownedDirectoryState(preRollbackDir) !== 'directory'
      || !tightenOwnedDirectory(dest)) throw new Error('回滚暂存发布目录身份不再可信')
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  let entries: string[] = []
  try { entries = await readdir(preRollbackDir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return dest
    throw error
  }
  for (const entry of entries) {
    const full = join(preRollbackDir, entry)
    if (full !== dest) {
      if (ownedDirectoryState(preRollbackDir) !== 'directory') throw new Error('回滚暂存根目录不安全')
      await rm(full, { recursive: true, force: true }).catch(() => {})
    }
  }
  return dest
}

export interface ManualRollbackData {
  snapshotPath: string | null
  stashPath: string | null
}

export interface SnapshotSummary {
  count: number
  /** Basename only; renderer-facing summaries never expose userData paths. */
  latestName: string | null
  latestAt: string | null
  restoreInProgress: boolean
  preRollbackCount: number
  latestStashName: string | null
}

export interface SnapshotRetentionPolicy {
  /** Keep the newest snapshot for each authoritative source version. */
  protectedVersions: readonly string[]
  /** Exact failure/journal snapshot basenames that must survive. */
  protectedSnapshotNames?: readonly string[]
  /** Bounded diagnostic tail outside the protected classes. */
  keepRecentUnprotected?: number
}

interface SnapshotEntry {
  name: string
  path: string
  sourceVersion: string
  timestamp: number
}

type RestoreSnapshotProtection =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'valid'; name: string }

function parseSnapshotEntry(snapshotsDir: string, name: string): SnapshotEntry | null {
  const match = /^(.*)-(\d+)$/.exec(name)
  if (match === null || !isSafeVersion(match[1])) return null
  const timestamp = Number(match[2])
  if (!Number.isSafeInteger(timestamp)) return null
  return { name, path: join(snapshotsDir, name), sourceVersion: match[1], timestamp }
}

async function readRestoreSnapshotProtection(baseDir: string): Promise<RestoreSnapshotProtection> {
  const paths = snapshotPaths(baseDir)
  const authority = readRestoreMarkerAuthority(baseDir)
  if (authority.kind === 'missing') return { kind: 'missing' }
  // Unsafe or unreadable marker: the only recovery snapshot is unknowable, so preserve the whole
  // set instead of trading it for bounded storage.
  if (authority.kind === 'unsafe' || authority.kind === 'unknown') return { kind: 'corrupt' }
  try {
    const parsed = JSON.parse(authority.raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt' }
    const snapshotPath = (parsed as Record<string, unknown>).snapshotPath
    if (typeof snapshotPath !== 'string') return { kind: 'corrupt' }
    const resolved = resolve(snapshotPath)
    if (dirname(resolved) !== resolve(paths.snapshotsDir)) return { kind: 'corrupt' }
    const name = basename(resolved)
    return parseSnapshotEntry(paths.snapshotsDir, name) === null
      ? { kind: 'corrupt' }
      : { kind: 'valid', name }
  } catch {
    return { kind: 'corrupt' }
  }
}

/**
 * Bound snapshots without guessing recovery ownership: the caller supplies active/known-good
 * versions plus exact failure/journal basenames; invalidly named directories are left untouched.
 */
export async function pruneSnapshots(baseDir: string, policy: SnapshotRetentionPolicy): Promise<string[]> {
  const protectedVersions = new Set(policy.protectedVersions.map(assertSafeVersion))
  const protectedNames = new Set<string>()
  for (const name of policy.protectedSnapshotNames ?? []) {
    if (basename(name) !== name || name === '.' || name === '..') throw new Error('protectedSnapshotNames 必须是 basename')
    protectedNames.add(name)
  }
  const restoreProtection = await readRestoreSnapshotProtection(baseDir)
  // A corrupt marker makes the only recovery snapshot unknowable: preserve the entire set
  // instead of trading bounded storage for data loss.
  if (restoreProtection.kind === 'corrupt') return []
  if (restoreProtection.kind === 'valid') protectedNames.add(restoreProtection.name)
  const keepRecent = policy.keepRecentUnprotected ?? 3
  if (!Number.isInteger(keepRecent) || keepRecent < 0) throw new Error('keepRecentUnprotected 必须是非负整数')
  const { snapshotsDir } = snapshotPaths(baseDir)
  const rootState = ownedDirectoryState(snapshotsDir)
  if (rootState !== 'directory') return []
  let entries
  try { entries = await readdir(snapshotsDir, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const snapshots = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => parseSnapshotEntry(snapshotsDir, entry.name))
    .filter((entry): entry is SnapshotEntry => entry !== null)
    .sort((a, b) => b.timestamp - a.timestamp)

  // Exactly one newest snapshot per active/known-good source version.
  for (const version of protectedVersions) {
    const newest = snapshots.find((entry) => entry.sourceVersion === version)
    if (newest !== undefined) protectedNames.add(newest.name)
  }
  const unprotectedTail = snapshots.filter((entry) => !protectedNames.has(entry.name)).slice(0, keepRecent)
  for (const entry of unprotectedTail) protectedNames.add(entry.name)

  const removed: string[] = []
  for (const entry of snapshots) {
    if (protectedNames.has(entry.name)) continue
    if (ownedDirectoryState(snapshotsDir) !== 'directory') return removed
    await rm(entry.path, { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

/** Summary of one bounded-maintenance pass (desktop + gateway parity). */
export interface RuntimeSnapshotPruneResult {
  /** Snapshot directories removed by retention pruning. */
  removedSnapshots: string[]
  /** Crash-only staging / restore-backup cleanup outcome. */
  artifactCleanup: SnapshotArtifactCleanupResult
  /** Why pruning was skipped this pass, or null when it ran to completion; fail-closed
   *  conditions, never silent no-ops. */
  skippedReason: 'none' | 'blocked-marker' | 'retention-corrupt'
}

/**
 * The single bounded-maintenance routine every owner runs after a runtime transaction: clean
 * crash-only staging + bound completed restore backups, then prune snapshots to the retention
 * policy. Owners differ only in WHEN they call it and in their own writer serialization — one
 * shared implementation, so no owner can silently stop bounding snapshot growth. Fail-closed: an
 * authoritative restore marker blocks ALL cleanup (its evidence may name the only recovery
 * snapshot), and corrupt retention metadata preserves every snapshot instead of guessing.
 */
export async function pruneRuntimeSnapshots(
  baseDir: string,
  dshHome: string,
  keepRecentUnprotected = 3,
): Promise<RuntimeSnapshotPruneResult> {
  const artifactCleanup = await cleanupSnapshotArtifacts(baseDir, dshHome)
  if (artifactCleanup.restoreBackupCleanup === 'blocked-marker') {
    return { removedSnapshots: [], artifactCleanup, skippedReason: 'blocked-marker' }
  }
  const retention = runtimeSnapshotRetentionState(baseDir)
  if (retention.kind !== 'valid') {
    // corrupt OR unknown (EACCES/EIO) protection set: preserve every snapshot; the wire
    // vocabulary keeps its historical skippedReason value.
    return { removedSnapshots: [], artifactCleanup, skippedReason: 'retention-corrupt' }
  }
  const removedSnapshots = await pruneSnapshots(baseDir, {
    protectedVersions: retention.protectedVersions,
    protectedSnapshotNames: retention.protectedSnapshotNames,
    keepRecentUnprotected,
  })
  return { removedSnapshots, artifactCleanup, skippedReason: 'none' }
}

/** Find target-version data and stash current data only when restore is needed. */
export async function prepareManualRollbackData(
  baseDir: string,
  dshHome: string,
  targetVersion: string,
): Promise<ManualRollbackData> {
  const snapshotPath = await findLatestSnapshotForVersion(baseDir, targetVersion)
  if (snapshotPath === null) return { snapshotPath: null, stashPath: null }
  const stashPath = await stashPreRollback(baseDir, dshHome)
  return { snapshotPath, stashPath }
}

/** Lightweight snapshot/stash projection for settings and failure records. */
export async function snapshotSummary(baseDir: string): Promise<SnapshotSummary> {
  const paths = snapshotPaths(baseDir)
  let snapshots: Array<{ path: string; timestamp: number }> = []
  const snapshotRootState = ownedDirectoryState(paths.snapshotsDir)
  if (snapshotRootState === 'unsafe') throw new Error('快照根目录不安全')
  if (snapshotRootState === 'directory') try {
    snapshots = (await readdir(paths.snapshotsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const match = /-(\d+)$/.exec(entry.name)
        return match === null ? null : { path: join(paths.snapshotsDir, entry.name), timestamp: Number(match[1]) }
      })
      .filter((entry): entry is { path: string; timestamp: number } => entry !== null
        && Number.isSafeInteger(entry.timestamp)
        && !Number.isNaN(new Date(entry.timestamp).getTime()))
      .sort((a, b) => b.timestamp - a.timestamp)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let preRollbackCount = 0
  let latestStashName: string | null = null
  const preRollbackRootState = ownedDirectoryState(paths.preRollbackDir)
  if (preRollbackRootState === 'unsafe') throw new Error('回滚暂存根目录不安全')
  if (preRollbackRootState === 'directory') {
    // Safe enumeration only: crash staging and non-stash entries are neither counted nor surfaced.
    const stashes = await listPreRollbackStashes(baseDir)
    preRollbackCount = stashes.length
    latestStashName = stashes[0] ?? null
  }
  return {
    count: snapshots.length,
    latestName: snapshots[0] === undefined ? null : basename(snapshots[0].path),
    latestAt: snapshots[0] === undefined ? null : new Date(snapshots[0].timestamp).toISOString(),
    restoreInProgress: restoreMarkerAuthorityStatus(baseDir) !== 'missing',
    preRollbackCount,
    latestStashName,
  }
}

/** Startup completion entry: marker snapshot/phase is authoritative; the shared
 *  openOrResumeRestoreMarker prefix is the third consumer of the authority path. */
export async function completeInterruptedRestore(
  baseDir: string,
  dshHome: string,
  copyFn: CopyFn = defaultCopy,
  hooks: RestoreHooks = {},
): Promise<'none' | RestoreOutcome> {
  const session = await openOrResumeRestoreMarker(baseDir, dshHome, { kind: 'resume' }, hooks)
  if (session.kind === 'none') return 'none'
  if (session.kind === 'blocked') return requireOutcome(session.report)
  return requireOutcome(await runRestoreTransaction(baseDir, dshHome, session.marker, copyFn, hooks))
}
