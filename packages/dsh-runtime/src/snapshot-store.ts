/**
 * dsh runtime snapshot/restore (design 18 §3.7) — the cross-version user-data
 * protection core.
 *
 * Restore is a durable transaction. A snapshot is copied completely to a
 * same-filesystem staging directory before the live DSH_HOME is moved. The
 * marker records every phase and the exact staging/backup paths, so startup
 * recovery never guesses completion from a non-empty directory (a partial
 * copy may also be non-empty). Backups are unique; cleanup is an explicit,
 * writer-fenced operation that preserves the newest completed restore field.
 *
 * Pure node built-ins, baseDir/dshHome injected — no electron, no IPC.
 */
import { cp, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { renameWithWindowsRetry } from './rename-retry.ts'
import { assertSafeVersion, isSafeVersion } from './version-safety.ts'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_RESTORE_MARKER_BYTES = 128 * 1024

interface FileIdentity {
  dev: number | bigint
  ino: number | bigint
}

type RestoreMarkerAuthorityRead =
  | { kind: 'missing' }
  | { kind: 'unsafe' }
  | { kind: 'valid'; raw: string }

export type RestoreMarkerAuthorityStatus = 'missing' | 'present' | 'unsafe'

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileSnapshot(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return sameIdentity(left, right)
    && left.isFile()
    && right.isFile()
    && left.nlink === 1
    && right.nlink === 1
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

/** Read the restore authority without following either its leaf or runtime dir. */
function readRestoreMarkerAuthority(baseDir: string): RestoreMarkerAuthorityRead {
  const markerPath = snapshotPaths(baseDir).restoreMarker
  const parent = dirname(markerPath)
  let parentBefore: ReturnType<typeof lstatSync>
  try {
    parentBefore = lstatSync(parent)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unsafe' }
  }
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) return { kind: 'unsafe' }

  let leafBefore: ReturnType<typeof lstatSync>
  try {
    leafBefore = lstatSync(markerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unsafe' }
    try {
      const parentAfter = lstatSync(parent)
      return parentAfter.isDirectory()
        && !parentAfter.isSymbolicLink()
        && sameIdentity(parentBefore, parentAfter)
        ? { kind: 'missing' }
        : { kind: 'unsafe' }
    } catch {
      return { kind: 'unsafe' }
    }
  }
  if (leafBefore.isSymbolicLink()
    || !leafBefore.isFile()
    || leafBefore.nlink !== 1
    || leafBefore.size < 0
    || leafBefore.size > MAX_RESTORE_MARKER_BYTES) return { kind: 'unsafe' }

  let fd: number | null = null
  try {
    fd = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    const parentOpened = lstatSync(parent)
    if (!opened.isFile()
      || opened.nlink !== 1
      || !sameIdentity(leafBefore, opened)
      || parentOpened.isSymbolicLink()
      || !parentOpened.isDirectory()
      || !sameIdentity(parentBefore, parentOpened)) return { kind: 'unsafe' }

    fchmodSync(fd, PRIVATE_FILE_MODE)
    const beforeRead = fstatSync(fd)
    if (!beforeRead.isFile() || beforeRead.nlink !== 1 || beforeRead.size > MAX_RESTORE_MARKER_BYTES) {
      return { kind: 'unsafe' }
    }
    const buffer = Buffer.allocUnsafe(MAX_RESTORE_MARKER_BYTES + 1)
    let offset = 0
    while (offset <= MAX_RESTORE_MARKER_BYTES) {
      const count = readSync(fd, buffer, offset, MAX_RESTORE_MARKER_BYTES + 1 - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset > MAX_RESTORE_MARKER_BYTES || offset !== beforeRead.size) return { kind: 'unsafe' }

    const afterRead = fstatSync(fd)
    const leafAfter = lstatSync(markerPath)
    const parentAfter = lstatSync(parent)
    if (!sameFileSnapshot(beforeRead, afterRead)
      || leafAfter.isSymbolicLink()
      || !leafAfter.isFile()
      || leafAfter.nlink !== 1
      || !sameIdentity(afterRead, leafAfter)
      || parentAfter.isSymbolicLink()
      || !parentAfter.isDirectory()
      || !sameIdentity(parentBefore, parentAfter)) return { kind: 'unsafe' }
    return { kind: 'valid', raw: buffer.subarray(0, offset).toString('utf8') }
  } catch {
    return { kind: 'unsafe' }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

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
    restoreMarker: join(runtime, 'restore-in-progress'),
  }
}

export type CopyFn = (src: string, dest: string) => Promise<void>
export type RestoreOutcome = 'complete' | 'half' | 'incomplete'
export type RestorePhase = 'copying' | 'staged' | 'backing-up' | 'publishing' | 'published'

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
  // Never chmod through a directory symlink. The descriptor helper pins the
  // final component and its parent before tightening the owned inode.
  if (!tightenOwnedDirectory(dir)) throw new Error(`不安全的私有目录：${basename(dir)}`)
}

async function ensureRuntimeSubdir(baseDir: string, dir: string): Promise<void> {
  const runtimeDir = dirname(snapshotPaths(baseDir).snapshotsDir)
  await ensurePrivateDir(runtimeDir)
  await ensurePrivateDir(dir)
}

async function atomicWriteMarker(filePath: string, marker: RestoreMarker): Promise<void> {
  await ensurePrivateDir(dirname(filePath))
  const tmp = `${filePath}.tmp-${randomBytes(4).toString('hex')}`
  try {
    await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
      flag: 'wx',
    })
    await rename(tmp, filePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
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
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
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
    // `entry.name` comes from a direct readdir of the private root. rm unlinks
    // a symlink itself rather than following it; recursive is needed only for
    // the normal crash-staging directory shape.
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
 * Remove crash-only staging and bound completed restore backups. The caller
 * must hold the same writer fence used for snapshot/restore: this helper does
 * not attempt to stop dsh itself. Any restore marker (valid, corrupt, file, or
 * symlink) blocks the entire cleanup. Without a marker, orphan `.tmp-*`
 * entries are safe to remove; restore backups are pruned only when DSH_HOME is
 * a real directory and every matching sibling is a real directory. Exactly
 * the newest backup is retained.
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

  // Presence alone is authoritative. Parsing a corrupt marker to decide what
  // is disposable would invert the recovery protocol's fail-closed boundary.
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

  // Recheck at the destructive backup boundary. Production calls this under
  // a writer fence, but an unexpected external marker still wins fail closed.
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
    // Never unlink a path an external actor could redirect, and never guess
    // that a same-name file is disposable restore data.
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
 * A pre-rollback stash source must be a real, non-symlink directory directly
 * under the private pre-rollback root with a stash-shaped basename.
 * `ownedDirectoryState` revalidates the parent's identity without following
 * the leaf, so a redirect between readdir and this check fails closed.
 */
async function isPublishedStashPath(baseDir: string, path: string): Promise<boolean> {
  const { preRollbackDir } = snapshotPaths(baseDir)
  if (ownedDirectoryState(preRollbackDir) !== 'directory') return false
  const candidate = resolve(path)
  if (dirname(candidate) !== resolve(preRollbackDir)) return false
  if (!isStashName(basename(candidate))) return false
  return ownedDirectoryState(candidate) === 'directory'
}

/** The restore transaction may copy from a snapshot or a pre-rollback stash.
 *  Each check must be awaited before the fallthrough: an un-awaited promise is
 *  truthy and would short-circuit the `||` and mask the stash path. */
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
    // Directory publish: bounded Windows retry absorbs third-party handle
    // occupancy (Defender/indexer/Explorer); POSIX is a plain rename.
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

  // Legacy markers had no phase and are intrinsically ambiguous. Start a new
  // staged transaction; do not infer completion from dshHome + `.old`.
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
  // A marker may name a snapshot or a pre-rollback stash as its source; both
  // live under the private dsh-runtime root and are re-validated per phase.
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

async function persistPhase(markerPath: string, marker: RestoreMarker, phase: RestorePhase, hooks: RestoreHooks): Promise<void> {
  marker.phase = phase
  marker.updatedAt = Date.now()
  await atomicWriteMarker(markerPath, marker)
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
  await atomicWriteMarker(restoreMarker, marker)
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
): Promise<RestoreOutcome> {
  const markerPath = snapshotPaths(baseDir).restoreMarker
  try {
    if (marker.phase === 'copying') {
      if (!(await isPublishedRestoreSource(baseDir, marker.snapshotPath))) return 'incomplete'
      // Contents in a `copying` staging dir are never trusted, even non-empty.
      await rm(marker.stagingPath, { recursive: true, force: true })
      await ensurePrivateDir(marker.stagingPath)
      try {
        await copyFn(marker.snapshotPath, marker.stagingPath)
      } catch {
        await rm(marker.stagingPath, { recursive: true, force: true }).catch(() => {})
        return 'incomplete'
      }
      if (!tightenOwnedDirectory(marker.stagingPath)) return 'incomplete'
      await persistPhase(markerPath, marker, 'staged', hooks)
    }

    if (marker.phase === 'staged') {
      const stagingState = ownedDirectoryState(marker.stagingPath)
      if (stagingState === 'unsafe') return 'incomplete'
      if (stagingState === 'missing') {
        await persistPhase(markerPath, marker, 'copying', hooks)
        return runRestoreTransaction(baseDir, dshHome, marker, copyFn, hooks)
      }
      if (!tightenOwnedDirectory(marker.stagingPath)) return 'incomplete'
      await persistPhase(markerPath, marker, 'backing-up', hooks)
    }

    if (marker.phase === 'backing-up') {
      let homeState = ownedDirectoryState(dshHome)
      let backupState = ownedDirectoryState(marker.backupPath)
      if (homeState === 'unsafe' || backupState === 'unsafe') return 'incomplete'
      if (marker.hadDshHome) {
        if (homeState === 'directory' && backupState === 'directory') return 'half'
        if (homeState === 'missing' && backupState === 'missing') return 'incomplete'
        if (homeState === 'directory') {
          if (!tightenOwnedDirectory(dshHome)) return 'incomplete'
          await renameWithWindowsRetry(dshHome, marker.backupPath)
          homeState = ownedDirectoryState(dshHome)
          backupState = ownedDirectoryState(marker.backupPath)
          if (homeState !== 'missing' || backupState !== 'directory') return 'incomplete'
        }
        if (!tightenOwnedDirectory(marker.backupPath)) return 'incomplete'
      } else if (homeState !== 'missing' || backupState !== 'missing') {
        // An external path appeared after the transaction began; preserve it.
        return 'half'
      }
      await persistPhase(markerPath, marker, 'publishing', hooks)
    }

    if (marker.phase === 'publishing') {
      let stagingState = ownedDirectoryState(marker.stagingPath)
      let homeState = ownedDirectoryState(dshHome)
      if (stagingState === 'unsafe' || homeState === 'unsafe') return 'incomplete'
      if (stagingState === 'directory' && homeState === 'directory') return 'half'
      if (stagingState === 'missing' && homeState === 'missing') return 'incomplete'
      if (stagingState === 'directory') {
        if (!tightenOwnedDirectory(marker.stagingPath)) return 'incomplete'
        await renameWithWindowsRetry(marker.stagingPath, dshHome)
        stagingState = ownedDirectoryState(marker.stagingPath)
        homeState = ownedDirectoryState(dshHome)
        if (stagingState !== 'missing' || homeState !== 'directory') return 'incomplete'
      }
      if (!tightenOwnedDirectory(dshHome)) return 'incomplete'
      await persistPhase(markerPath, marker, 'published', hooks)
    }

    if (marker.phase === 'published') {
      if (ownedDirectoryState(dshHome) !== 'directory' || !tightenOwnedDirectory(dshHome)) return 'incomplete'
      await rm(markerPath, { force: true })
      return 'complete'
    }
  } catch {
    return interruptedOutcome(marker, dshHome)
  }
  return interruptedOutcome(marker, dshHome)
}

/** Restore a snapshot over DSH_HOME using the durable phase transaction. */
export async function restoreSnapshot(
  baseDir: string,
  dshHome: string,
  snapshotPath: string,
  copyFn: CopyFn = defaultCopy,
  hooks: RestoreHooks = {},
): Promise<RestoreOutcome> {
  const { restoreMarker, snapshotsDir } = snapshotPaths(baseDir)
  let authority = readRestoreMarkerAuthority(baseDir)
  if (authority.kind === 'unsafe') return 'incomplete'
  if (authority.kind === 'missing') {
    await ensurePrivateDir(dirname(restoreMarker))
    // A marker appearing during directory creation is authoritative too.
    authority = readRestoreMarkerAuthority(baseDir)
    if (authority.kind === 'unsafe') return 'incomplete'
  }

  let marker: RestoreMarker
  if (authority.kind === 'valid') {
    const parsed = parseMarker(authority.raw, baseDir, dshHome)
    if (parsed === null) return 'incomplete'
    if ('legacySnapshotPath' in parsed) {
      const legacySnapshot = parsed.legacySnapshotPath
      if (!pathIsInside(legacySnapshot, snapshotsDir) || !(await isPublishedSnapshotPath(baseDir, legacySnapshot))) return 'incomplete'
      try {
        marker = await beginRestore(baseDir, dshHome, legacySnapshot, hooks)
      } catch {
        return 'incomplete'
      }
    } else {
      marker = parsed
    }
  } else {
    if (!pathIsInside(snapshotPath, snapshotsDir) || !(await isPublishedSnapshotPath(baseDir, snapshotPath))) return 'incomplete'
    try {
      marker = await beginRestore(baseDir, dshHome, snapshotPath, hooks)
    } catch {
      return 'incomplete'
    }
  }
  return runRestoreTransaction(baseDir, dshHome, marker, copyFn, hooks)
}

/**
 * Restore a pre-rollback stash over DSH_HOME. The stash is validated as a
 * real, non-symlink directory under the private pre-rollback root (identity
 * re-checked without following either the leaf or its parent) BEFORE the
 * restore marker is written, and again inside the copying phase on resume.
 * The transaction is the same durable two-phase rename used by
 * `restoreSnapshot`: the live DSH_HOME is renamed to `dsh-home.old` and the
 * marker remains authoritative until the published phase completes, so a
 * crash or an unsafe stash always leaves the data recoverable. An existing
 * valid marker (snapshot or stash) wins: recovery continues it.
 */
export async function restorePreRollback(
  baseDir: string,
  dshHome: string,
  stashName: string,
  copyFn: CopyFn = defaultCopy,
  hooks: RestoreHooks = {},
): Promise<RestoreOutcome> {
  const stashPath = await resolveStashPath(baseDir, stashName)
  if (stashPath === null) return 'incomplete'
  const { restoreMarker, snapshotsDir } = snapshotPaths(baseDir)
  let authority = readRestoreMarkerAuthority(baseDir)
  if (authority.kind === 'unsafe') return 'incomplete'
  if (authority.kind === 'missing') {
    await ensurePrivateDir(dirname(restoreMarker))
    // A marker appearing during directory creation is authoritative too.
    authority = readRestoreMarkerAuthority(baseDir)
    if (authority.kind === 'unsafe') return 'incomplete'
  }

  let marker: RestoreMarker
  if (authority.kind === 'valid') {
    const parsed = parseMarker(authority.raw, baseDir, dshHome)
    if (parsed === null) return 'incomplete'
    if ('legacySnapshotPath' in parsed) {
      // Legacy markers predate stashes and can only reference snapshots.
      const legacySnapshot = parsed.legacySnapshotPath
      if (!pathIsInside(legacySnapshot, snapshotsDir) || !(await isPublishedSnapshotPath(baseDir, legacySnapshot))) return 'incomplete'
      try {
        marker = await beginRestore(baseDir, dshHome, legacySnapshot, hooks)
      } catch {
        return 'incomplete'
      }
    } else {
      marker = parsed
    }
  } else {
    try {
      marker = await beginRestore(baseDir, dshHome, stashPath, hooks)
    } catch {
      return 'incomplete'
    }
  }
  const outcome = await runRestoreTransaction(baseDir, dshHome, marker, copyFn, hooks)
  if (outcome === 'complete') {
    // The stash has been consumed: its content now lives in DSH_HOME and the
    // pre-restore data is preserved in dsh-home.old. Remove it so the restore
    // action disappears and the next manual rollback writes a fresh stash. A
    // 'half' outcome keeps the stash (the durable marker resumes from it).
    await rm(stashPath, { recursive: true, force: true }).catch(() => {})
  }
  return outcome
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
 * Safe, non-symlink pre-rollback stash names (basenames only, newest first).
 * Dirent `isDirectory()` never follows a symlink, and only stash-shaped
 * names are surfaced; anything else in the private root is ignored.
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
 * Resolve a stash basename into the private pre-rollback root with a no-follow
 * identity check (parent + leaf revalidated, symlinks/unsafe dirs rejected).
 * Tightening the owned inode also proves the path was not redirected after the
 * lstat, and is the validation the restore caller requires before any marker
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
 * Stash current DSH_HOME before manual rollback. This is a still copy into a
 * temporary directory followed by an atomic publish; the live DSH_HOME is not
 * renamed away before the durable restore marker exists. A crash during this
 * helper therefore leaves the authoritative data untouched.
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
  /** Newest safe stash basename, or null when no stash exists. */
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
  if (authority.kind === 'unsafe') return { kind: 'corrupt' }
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
 * Bound snapshots without guessing recovery ownership. The caller supplies
 * active/known-good versions plus exact failure/journal basenames; invalidly
 * named directories are left untouched (fail closed).
 */
export async function pruneSnapshots(baseDir: string, policy: SnapshotRetentionPolicy): Promise<string[]> {
  const protectedVersions = new Set(policy.protectedVersions.map(assertSafeVersion))
  const protectedNames = new Set<string>()
  for (const name of policy.protectedSnapshotNames ?? []) {
    if (basename(name) !== name || name === '.' || name === '..') throw new Error('protectedSnapshotNames 必须是 basename')
    protectedNames.add(name)
  }
  const restoreProtection = await readRestoreSnapshotProtection(baseDir)
  // A corrupt marker makes the only recovery snapshot unknowable. Preserve
  // the entire set instead of trading bounded storage for data loss.
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
    // Safe enumeration only: crash staging and non-stash entries are neither
    // counted nor surfaced (see listPreRollbackStashes).
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

export async function dirNonEmpty(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0
  } catch {
    return false
  }
}

/** Startup completion entry. Marker snapshot/phase is authoritative. */
export async function completeInterruptedRestore(
  baseDir: string,
  dshHome: string,
  copyFn: CopyFn = defaultCopy,
  hooks: RestoreHooks = {},
): Promise<'none' | RestoreOutcome> {
  if (restoreMarkerAuthorityStatus(baseDir) === 'missing') return 'none'
  return restoreSnapshot(baseDir, dshHome, '', copyFn, hooks)
}
