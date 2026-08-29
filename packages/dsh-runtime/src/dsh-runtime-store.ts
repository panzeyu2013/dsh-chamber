/**
 * Design 18 runtime disk data plane. Pure Node, baseDir-injected, no Electron.
 *
 * Security/data invariants:
 * - metadata writes are atomic, files 0600 and containing directories 0700;
 * - path-bearing versions are exact semver before use;
 * - a directory name alone never proves an installed runtime is usable;
 * - current / known-good / pending / failure fields and every explicitly
 *   installed version survive automatic eviction;
 * - corrupt retention metadata fails closed (trees are kept, not guessed);
 * - deleting hard-linked trees marks the pnpm store as needing prune, so the
 *   process runner can close the physical-disk loop.
 */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { EXACT_SEMVER, assertSafeVersion, isSafeVersion } from './version-safety.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_CURRENT_POINTER_BYTES = 16 * 1024
const MAX_OVERRIDE_BYTES = 64 * 1024
const MAX_ACTIVATION_JOURNAL_BYTES = 128 * 1024
const PUBLISH_BACKUP_NAME = /^\.(.+)\.publish-backup-[0-9a-f]{8}$/

export type RestoreOutcomeRecord = 'none' | 'complete' | 'half' | 'incomplete'

/** Old five-field records remain valid; new lifecycle evidence is optional. */
export interface OverrideRecord {
  shellVersion: string
  chosenVersion: string | null
  resolvedVersion: string | null
  pending: string | null
  swapAttempted: boolean
  /** Durable distinction for a version selected while builtin (no current
   * pointer) remains active. Hosts that split select from apply (the gateway)
   * may set this true only when selection started from builtin, and clear it
   * before publishing pending. A selection staged from an active user tree
   * must keep this false so later pointer loss still fails closed. Older
   * five-field records remain valid but intentionally cannot weaken that
   * pointer-loss check. */
  selectedOnly?: boolean
  invalidatedAt?: string | null
  invalidatedReason?: string | null
  /** Durable user-visible F4 history. Unlike invalidatedAt, this survives a
   * failed builtin probe followed by automatic reactivation of the old tree. */
  lastInvalidatedAt?: string | null
  lastInvalidatedReason?: string | null
  lastInvalidatedFromVersion?: string | null
  lastInvalidationRecovered?: boolean | null
  lastOutcome?: string | null
  lastError?: string | null
  restoreOutcome?: RestoreOutcomeRecord | null
}

export type CurrentPointerState =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'valid'; version: string }

export type OverrideState =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'valid'; record: OverrideRecord }

export interface RuntimeFailureRecord {
  version: string
  phase: string
  firstFailedAt: string
  lastFailedAt: string
  occurrences: number
  error: string
  restoreOutcome: RestoreOutcomeRecord | null
  /** Basename only — absolute user paths never enter diagnostics. */
  snapshotName: string | null
}

export interface RuntimeFailureInput {
  version: string
  phase: string
  error: unknown
  restoreOutcome?: RestoreOutcomeRecord | null
  snapshotPath?: string | null
}

export interface RuntimeFailureSummary {
  count: number
  latest: RuntimeFailureRecord | null
}

export type RuntimeSnapshotRetentionState =
  | { kind: 'corrupt' }
  | { kind: 'valid'; protectedVersions: string[]; protectedSnapshotNames: string[] }

export interface StorePruneRequest {
  requestedAt: string
  reasons: string[]
}

export interface RuntimeDiskSummary {
  versionTrees: number
  versionTreeBytes: number
  storeBytes: number
  /** pnpm metadata cache only; kept stable for existing callers. */
  cacheBytes: number
  installHomeBytes: number
  xdgCacheBytes: number
  workBytes: number
  failureBytes: number
  snapshotBytes: number
  preRollbackBytes: number
  restoreBackupBytes: number
  /** Logical category sum; hard-linked tree/store bytes may be counted twice. */
  totalBytes: number
  storePruneNeeded: boolean
}

export interface ExplicitRuntimeCleanupResult {
  removed: boolean
  retentionCleared: boolean
  stillProtected: boolean
}

/**
 * Durable activation transaction. `intent` may be written by the controller
 * while the selected version is merely pending. Every later phase contains
 * the immutable pre-swap facts and snapshot basename captured before the
 * current pointer is touched.
 */
export type ActivationJournalPhase =
  | 'intent'
  | 'prepared'
  | 'switched'
  | 'manual-restoring'
  | 'manual-restored'
  | 'rollback-needed'
  | 'restoring'
  | 'restore-complete'
  | 'fallback-builtin'
  | 'applied-monitoring'

export type ActivationIntentKind = 'version-switch' | 'reset-builtin' | 'shell-invalidation'

export interface ActivationJournalIntent {
  targetVersion: string
  targetIsBuiltin: boolean
  manualRollback: boolean
  intentKind: ActivationIntentKind
}

export interface ActivationJournal {
  schemaVersion: 1
  phase: ActivationJournalPhase
  targetVersion: string
  /** Builtin activation clears current but still records its manifest version. */
  targetIsBuiltin: boolean
  manualRollback: boolean
  intentKind: ActivationIntentKind
  /** null is allowed only while phase === 'intent'. */
  sourceVersion: string | null
  sourceIsBuiltin: boolean | null
  sourceWasKnownGood: boolean | null
  knownGoodVersion: string | null
  /** Basenames only. Absolute userData paths never enter this metadata. */
  preSwapSnapshotName: string | null
  manualDataSnapshotName: string | null
  preRollbackStashName: string | null
  /** null is also the explicit builtin rollback target. */
  rollbackTarget: string | null
  /** A later selection can queue without erasing F7 monitoring context. */
  nextIntent: ActivationJournalIntent | null
  startedAt: string
  updatedAt: string
}

export type ActivationJournalState =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'valid'; journal: ActivationJournal }

export interface ActivationIntentInput {
  targetVersion: string
  targetIsBuiltin?: boolean
  manualRollback: boolean
  intentKind: ActivationIntentKind
}

/**
 * The builtin/fallback identity token (gateway status/override terminology):
 * an activation intent targeting the builtin anchor may name exactly this
 * sentinel instead of a semver — the startup/apply phases only compare
 * targetVersion for non-builtin targets.
 */
export const BUILTIN_ANCHOR_VERSION_TOKEN = 'builtin-anchor'

function runtimeDirPath(baseDir: string): string {
  return join(baseDir, 'dsh-runtime')
}

function ensurePrivateDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  chmodSync(dir, PRIVATE_DIR_MODE)
}

/** Atomic JSON write; fixed permissions also tighten an old permissive file. */
function atomicWriteJson(filePath: string, payload: unknown): void {
  const tmpPath = `${filePath}.tmp-${randomBytes(4).toString('hex')}`
  ensurePrivateDirSync(dirname(filePath))
  try {
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
    })
    chmodSync(tmpPath, PRIVATE_FILE_MODE)
    renameSync(tmpPath, filePath)
    chmodSync(filePath, PRIVATE_FILE_MODE)
  } catch (error) {
    try { rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

interface FileIdentity {
  dev: number | bigint
  ino: number | bigint
}

interface StableAuthorityRead {
  kind: 'valid'
  raw: string
  identity: FileIdentity
}

type AuthorityRead = StableAuthorityRead | { kind: 'missing' } | { kind: 'unsafe' }

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

/**
 * Read one authority leaf without ever following the leaf itself. The runtime
 * directory and leaf identities are checked around the operation, the file is
 * required to have a single link, and permission tightening happens through
 * the already-verified descriptor rather than a path lookup.
 */
function readAuthorityMetadata(filePath: string, maxBytes: number): AuthorityRead {
  const parent = dirname(filePath)
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
    leafBefore = lstatSync(filePath)
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
  if (leafBefore.isSymbolicLink() || !leafBefore.isFile() || leafBefore.nlink !== 1) {
    return { kind: 'unsafe' }
  }
  if (leafBefore.size < 0 || leafBefore.size > maxBytes) return { kind: 'unsafe' }

  let fd: number | null = null
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(leafBefore, opened)) {
      return { kind: 'unsafe' }
    }

    const parentOpened = lstatSync(parent)
    if (parentOpened.isSymbolicLink()
      || !parentOpened.isDirectory()
      || !sameIdentity(parentBefore, parentOpened)) {
      return { kind: 'unsafe' }
    }

    // Tighten only the inode pinned by fd. A path chmod here would re-open the
    // symlink/parent-swap race that this reader is intended to close.
    fchmodSync(fd, PRIVATE_FILE_MODE)
    const beforeRead = fstatSync(fd)
    if (!beforeRead.isFile() || beforeRead.nlink !== 1 || beforeRead.size > maxBytes) {
      return { kind: 'unsafe' }
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset <= maxBytes) {
      const count = readSync(fd, buffer, offset, maxBytes + 1 - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset > maxBytes || offset !== beforeRead.size) return { kind: 'unsafe' }

    const afterRead = fstatSync(fd)
    let leafAfter: ReturnType<typeof lstatSync>
    let parentAfter: ReturnType<typeof lstatSync>
    try {
      leafAfter = lstatSync(filePath)
      parentAfter = lstatSync(parent)
    } catch {
      return { kind: 'unsafe' }
    }
    if (!sameFileSnapshot(beforeRead, afterRead)
      || leafAfter.isSymbolicLink()
      || !leafAfter.isFile()
      || leafAfter.nlink !== 1
      || !sameIdentity(afterRead, leafAfter)
      || parentAfter.isSymbolicLink()
      || !parentAfter.isDirectory()
      || !sameIdentity(parentBefore, parentAfter)) {
      return { kind: 'unsafe' }
    }
    return {
      kind: 'valid',
      raw: buffer.subarray(0, offset).toString('utf8'),
      identity: { dev: afterRead.dev, ino: afterRead.ino },
    }
  } catch {
    return { kind: 'unsafe' }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

function hasCorruptOverrideSentinel(filePath: string): boolean {
  const parent = dirname(filePath)
  let parentBefore: ReturnType<typeof lstatSync>
  try { parentBefore = lstatSync(parent) } catch { return false }
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) return false
  try { lstatSync(`${filePath}.corrupt`) } catch { return false }
  try {
    const parentAfter = lstatSync(parent)
    return parentAfter.isDirectory()
      && !parentAfter.isSymbolicLink()
      && sameIdentity(parentBefore, parentAfter)
  } catch {
    return false
  }
}

/** Quarantine only the exact single-link inode that was safely read. Never
 * chmod the destination by path: the source fd was already tightened. */
function preserveSafeCorruptAuthority(filePath: string, expected: FileIdentity): void {
  try {
    const parent = dirname(filePath)
    const parentBefore = lstatSync(parent)
    const sourceBefore = lstatSync(filePath)
    if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()
      || sourceBefore.isSymbolicLink() || !sourceBefore.isFile()
      || sourceBefore.nlink !== 1 || !sameIdentity(sourceBefore, expected)) return
    const preferred = `${filePath}.corrupt`
    const dest = existsSync(preferred)
      ? `${preferred}-${Date.now()}-${randomBytes(3).toString('hex')}`
      : preferred
    renameSync(filePath, dest)
    const parentAfter = lstatSync(parent)
    const destAfter = lstatSync(dest)
    if (parentAfter.isSymbolicLink() || !parentAfter.isDirectory()
      || !sameIdentity(parentBefore, parentAfter)
      || destAfter.isSymbolicLink() || !destAfter.isFile()
      || destAfter.nlink !== 1 || !sameIdentity(destAfter, expected)) {
      console.error('[dsh-runtime-store] 损坏文件隔离后的身份复验失败')
    }
  } catch (error) {
    console.error('[dsh-runtime-store] 保留损坏文件失败：', error)
  }
}

/** Preserve invalid metadata without replacing an earlier corruption field. */
function preserveCorrupt(filePath: string): void {
  try {
    const preferred = `${filePath}.corrupt`
    const dest = existsSync(preferred)
      ? `${preferred}-${Date.now()}-${randomBytes(3).toString('hex')}`
      : preferred
    renameSync(filePath, dest)
    chmodSync(dest, PRIVATE_FILE_MODE)
  } catch (error) {
    console.error('[dsh-runtime-store] 保留损坏文件失败：', error)
  }
}

function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch {
    return null
  }
}

export function currentPointerPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'current')
}

/** Missing means builtin. Corrupt is deliberately distinct and must block
 * runtime resolution; treating malformed metadata as builtin loses the only
 * pointer to user data without a snapshot transaction. */
export function readCurrentPointerState(baseDir: string): CurrentPointerState {
  const filePath = currentPointerPath(baseDir)
  const read = readAuthorityMetadata(filePath, MAX_CURRENT_POINTER_BYTES)
  if (read.kind === 'missing') return { kind: 'missing' }
  if (read.kind === 'unsafe') return { kind: 'corrupt' }
  try {
    const parsed = JSON.parse(read.raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt' }
    const version = (parsed as Record<string, unknown>).version
    return typeof version === 'string' && isSafeVersion(version)
      ? { kind: 'valid', version }
      : { kind: 'corrupt' }
  } catch {
    return { kind: 'corrupt' }
  }
}

/** Compatibility projection. Security-sensitive startup/resolution code must
 * consume readCurrentPointerState so corrupt never aliases builtin. */
export function readCurrentPointer(baseDir: string): string | null {
  const state = readCurrentPointerState(baseDir)
  return state.kind === 'valid' ? state.version : null
}

export function writeCurrentPointer(baseDir: string, version: string): void {
  atomicWriteJson(currentPointerPath(baseDir), { version: assertSafeVersion(version) })
}

/** Explicitly fall back to the builtin chain. Historical override metadata is
 * untouched; callers decide separately whether this is reset or invalidation. */
export function clearCurrentPointer(baseDir: string): void {
  rmSync(currentPointerPath(baseDir), { force: true })
}

export function overridePath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'override.json')
}

function nullableString(record: Record<string, unknown>, field: string): string | null | undefined {
  const value = record[field]
  return value === undefined || value === null || typeof value === 'string' ? value : undefined
}

function parseOverrideRecord(parsed: unknown): OverrideRecord | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.shellVersion !== 'string' || !isSafeVersion(record.shellVersion)) return null
  if (!Object.prototype.hasOwnProperty.call(record, 'chosenVersion') || !Object.prototype.hasOwnProperty.call(record, 'resolvedVersion') || !Object.prototype.hasOwnProperty.call(record, 'pending')) return null
  const chosenVersion = nullableString(record, 'chosenVersion')
  const resolvedVersion = nullableString(record, 'resolvedVersion')
  const pending = nullableString(record, 'pending')
  if (chosenVersion === undefined || resolvedVersion === undefined || pending === undefined) return null
  if (typeof record.swapAttempted !== 'boolean') return null
  for (const version of [chosenVersion, resolvedVersion, pending]) {
    if (version !== null && !isSafeVersion(version)) return null
  }

  const out: OverrideRecord = {
    shellVersion: record.shellVersion,
    chosenVersion,
    resolvedVersion,
    pending,
    swapAttempted: record.swapAttempted,
  }
  if (record.selectedOnly !== undefined) {
    if (typeof record.selectedOnly !== 'boolean') return null
    out.selectedOnly = record.selectedOnly
  }
  for (const field of [
    'invalidatedAt',
    'invalidatedReason',
    'lastInvalidatedAt',
    'lastInvalidatedReason',
    'lastInvalidatedFromVersion',
    'lastOutcome',
    'lastError',
  ] as const) {
    if (record[field] !== undefined) {
      if (record[field] !== null && typeof record[field] !== 'string') return null
      out[field] = record[field] as string | null
    }
  }
  if (record.lastInvalidationRecovered !== undefined) {
    if (record.lastInvalidationRecovered !== null && typeof record.lastInvalidationRecovered !== 'boolean') return null
    out.lastInvalidationRecovered = record.lastInvalidationRecovered as boolean | null
  }
  if (record.restoreOutcome !== undefined) {
    if (record.restoreOutcome !== null && record.restoreOutcome !== 'none' && record.restoreOutcome !== 'complete' && record.restoreOutcome !== 'half' && record.restoreOutcome !== 'incomplete') return null
    out.restoreOutcome = record.restoreOutcome as RestoreOutcomeRecord | null
  }
  return out
}

/** Corrupt override is preserved and represented as a durable fail-closed
 * state. The .corrupt sentinel keeps subsequent boots blocked after the first
 * read moves malformed content out of the active path. */
export function readOverrideState(baseDir: string): OverrideState {
  const filePath = overridePath(baseDir)
  const read = readAuthorityMetadata(filePath, MAX_OVERRIDE_BYTES)
  if (read.kind === 'missing') {
    return hasCorruptOverrideSentinel(filePath) ? { kind: 'corrupt' } : { kind: 'missing' }
  }
  if (read.kind === 'unsafe') return { kind: 'corrupt' }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.raw)
  } catch {
    preserveSafeCorruptAuthority(filePath, read.identity)
    return { kind: 'corrupt' }
  }
  const record = parseOverrideRecord(parsed)
  if (record === null) {
    preserveSafeCorruptAuthority(filePath, read.identity)
    return { kind: 'corrupt' }
  }
  return { kind: 'valid', record }
}

/** Compatibility projection. Security-sensitive startup/resolution code must
 * consume readOverrideState so corruption never aliases no override. */
export function readOverride(baseDir: string): OverrideRecord | null {
  const state = readOverrideState(baseDir)
  return state.kind === 'valid' ? state.record : null
}

function assertOptionalText(value: string | null | undefined, field: string): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || value.length > 4_000 || /[\u0000]/.test(value)) {
    throw new Error(`override.${field} 必须是至多 4000 字符且不含 NUL 的字符串或 null`)
  }
}

export function writeOverride(baseDir: string, record: OverrideRecord): void {
  if (typeof record.shellVersion !== 'string' || !isSafeVersion(record.shellVersion)) {
    throw new Error(`override.shellVersion 必须是精确 semver，收到 ${JSON.stringify(record.shellVersion)}`)
  }
  for (const [field, version] of [
    ['chosenVersion', record.chosenVersion],
    ['resolvedVersion', record.resolvedVersion],
    ['pending', record.pending],
  ] as const) {
    if (version !== null) assertSafeVersion(version)
  }
  if (typeof record.swapAttempted !== 'boolean') throw new Error('override.swapAttempted 必须是 boolean')
  if (record.selectedOnly !== undefined && typeof record.selectedOnly !== 'boolean') {
    throw new Error('override.selectedOnly 必须是 boolean')
  }
  assertOptionalText(record.invalidatedAt, 'invalidatedAt')
  assertOptionalText(record.invalidatedReason, 'invalidatedReason')
  assertOptionalText(record.lastInvalidatedAt, 'lastInvalidatedAt')
  assertOptionalText(record.lastInvalidatedReason, 'lastInvalidatedReason')
  assertOptionalText(record.lastInvalidatedFromVersion, 'lastInvalidatedFromVersion')
  if (record.lastInvalidatedFromVersion != null) assertSafeVersion(record.lastInvalidatedFromVersion)
  if (record.lastInvalidationRecovered !== undefined
    && record.lastInvalidationRecovered !== null
    && typeof record.lastInvalidationRecovered !== 'boolean') {
    throw new Error('override.lastInvalidationRecovered 必须是 boolean 或 null')
  }
  assertOptionalText(record.lastOutcome, 'lastOutcome')
  assertOptionalText(record.lastError, 'lastError')
  if (record.restoreOutcome !== undefined && record.restoreOutcome !== null && !['none', 'complete', 'half', 'incomplete'].includes(record.restoreOutcome)) {
    throw new Error('override.restoreOutcome 非法')
  }

  const payload: Record<string, unknown> = {
    shellVersion: record.shellVersion,
    chosenVersion: record.chosenVersion,
    resolvedVersion: record.resolvedVersion,
    pending: record.pending,
    swapAttempted: record.swapAttempted,
  }
  if (record.selectedOnly !== undefined) payload.selectedOnly = record.selectedOnly
  for (const field of [
    'invalidatedAt',
    'invalidatedReason',
    'lastInvalidatedAt',
    'lastInvalidatedReason',
    'lastInvalidatedFromVersion',
    'lastInvalidationRecovered',
    'lastOutcome',
    'lastError',
    'restoreOutcome',
  ] as const) {
    if (record[field] !== undefined) payload[field] = record[field]
  }
  atomicWriteJson(overridePath(baseDir), payload)
}

/** Explicit restore-builtin action. Invalidated history should be copied by the
 * caller first if it wants a separate audit log; this only removes override. */
export function deleteOverride(baseDir: string): void {
  rmSync(overridePath(baseDir), { force: true })
}

export function activationJournalPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'activation-journal.json')
}

function isActivationJournalPhase(value: unknown): value is ActivationJournalPhase {
  return value === 'intent'
    || value === 'prepared'
    || value === 'switched'
    || value === 'manual-restoring'
    || value === 'manual-restored'
    || value === 'rollback-needed'
    || value === 'restoring'
    || value === 'restore-complete'
    || value === 'fallback-builtin'
    || value === 'applied-monitoring'
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function isSafeStoredBasename(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && basename(value) === value
    && value !== '.'
    && value !== '..'
    && !value.includes('\0')
}

function parseNullableSafeVersion(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' && isSafeVersion(value) ? value : undefined
}

function parseNullableSnapshotName(value: unknown): string | null | undefined {
  if (value === null) return null
  if (!isSafeStoredBasename(value)) return undefined
  const separator = value.lastIndexOf('-')
  if (separator <= 0) return undefined
  const version = value.slice(0, separator)
  const timestamp = value.slice(separator + 1)
  return isSafeVersion(version) && /^\d+$/.test(timestamp) ? value : undefined
}

function parseNullablePreRollbackName(value: unknown): string | null | undefined {
  if (value === null) return null
  // Same 13-digit-epoch shape snapshot-store's isStashName enforces (stashes
  // are only ever created there); keeping the two patterns in lockstep
  // prevents a drift where the store accepts a name the resolver rejects.
  return isSafeStoredBasename(value) && /^\d{13}-[0-9a-f]{8}$/.test(value) ? value : undefined
}

function parseJournalIntent(value: unknown): ActivationJournalIntent | null | undefined {
  if (value === null) return null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.targetIsBuiltin !== 'boolean' || typeof record.manualRollback !== 'boolean') return undefined
  if (typeof record.targetVersion !== 'string'
    || (!(record.targetIsBuiltin && record.targetVersion === BUILTIN_ANCHOR_VERSION_TOKEN) && !isSafeVersion(record.targetVersion))) return undefined
  const intentKind = parseIntentKind(record.intentKind)
  if (intentKind === null || !validIntentShape(intentKind, record.targetIsBuiltin, record.manualRollback)) return undefined
  return {
    targetVersion: record.targetVersion,
    targetIsBuiltin: record.targetIsBuiltin,
    manualRollback: record.manualRollback,
    intentKind,
  }
}

function parseIntentKind(value: unknown): ActivationIntentKind | null {
  // Schema-1 journals written before intentKind existed were exclusively
  // ordinary version switches. Never reinterpret them as reset/invalidation.
  if (value === undefined) return 'version-switch'
  return value === 'version-switch' || value === 'reset-builtin' || value === 'shell-invalidation'
    ? value
    : null
}

function validIntentShape(kind: ActivationIntentKind, targetIsBuiltin: boolean, manualRollback: boolean): boolean {
  if (kind === 'version-switch') return !targetIsBuiltin
  return targetIsBuiltin && !manualRollback
}

function parseActivationJournal(parsed: unknown): ActivationJournal | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== 1 || !isActivationJournalPhase(record.phase)) return null
  if (typeof record.targetIsBuiltin !== 'boolean') return null
  if (typeof record.targetVersion !== 'string'
    || (!(record.targetIsBuiltin && record.targetVersion === BUILTIN_ANCHOR_VERSION_TOKEN) && !isSafeVersion(record.targetVersion))) return null
  if (typeof record.manualRollback !== 'boolean') return null
  const intentKind = parseIntentKind(record.intentKind)
  if (intentKind === null || !validIntentShape(intentKind, record.targetIsBuiltin, record.manualRollback)) return null
  const sourceVersion = parseNullableSafeVersion(record.sourceVersion)
  const knownGoodVersion = parseNullableSafeVersion(record.knownGoodVersion)
  const rollbackTarget = parseNullableSafeVersion(record.rollbackTarget)
  const preSwapSnapshotName = parseNullableSnapshotName(record.preSwapSnapshotName)
  const manualDataSnapshotName = parseNullableSnapshotName(record.manualDataSnapshotName)
  const preRollbackStashName = parseNullablePreRollbackName(record.preRollbackStashName)
  const nextIntent = parseJournalIntent(record.nextIntent)
  if (sourceVersion === undefined || knownGoodVersion === undefined || rollbackTarget === undefined) return null
  if (preSwapSnapshotName === undefined || manualDataSnapshotName === undefined || preRollbackStashName === undefined) return null
  if (nextIntent === undefined) return null
  if (!isIsoTimestamp(record.startedAt) || !isIsoTimestamp(record.updatedAt)) return null

  if (record.phase === 'intent') {
    if (record.sourceIsBuiltin !== null || record.sourceWasKnownGood !== null) return null
    if (sourceVersion !== null || preSwapSnapshotName !== null || manualDataSnapshotName !== null || preRollbackStashName !== null) return null
    if (knownGoodVersion !== null || rollbackTarget !== null) return null
  } else {
    if (typeof record.sourceIsBuiltin !== 'boolean' || typeof record.sourceWasKnownGood !== 'boolean') return null
    // Snapshot creation requires an exact real source version. A null/unknown
    // source must fail before a pointer mutation and can never become prepared.
    if (sourceVersion === null || preSwapSnapshotName === null) return null
    if (record.manualRollback) {
      if ((manualDataSnapshotName === null) !== (preRollbackStashName === null)) return null
    } else if (manualDataSnapshotName !== null || preRollbackStashName !== null) {
      return null
    }
    // A privileged action may be queued while any activation phase is in
    // flight. The apply writer preserves this field at every phase boundary;
    // startup converts it to a fresh intent only after the current transaction
    // reaches a verified applied/safe-fallback verdict.
  }

  return {
    schemaVersion: 1,
    phase: record.phase,
    targetVersion: record.targetVersion,
    targetIsBuiltin: record.targetIsBuiltin,
    manualRollback: record.manualRollback,
    intentKind,
    sourceVersion,
    sourceIsBuiltin: record.sourceIsBuiltin as boolean | null,
    sourceWasKnownGood: record.sourceWasKnownGood as boolean | null,
    knownGoodVersion,
    preSwapSnapshotName,
    manualDataSnapshotName,
    preRollbackStashName,
    rollbackTarget,
    nextIntent,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  }
}

/** Corruption is a fail-closed state. Unlike non-transactional metadata, the
 * journal is deliberately left in place until explicit recovery/reset so a
 * second launch cannot reinterpret corruption as "no activation in flight". */
export function readActivationJournalState(baseDir: string): ActivationJournalState {
  const filePath = activationJournalPath(baseDir)
  const read = readAuthorityMetadata(filePath, MAX_ACTIVATION_JOURNAL_BYTES)
  if (read.kind === 'missing') return { kind: 'missing' }
  if (read.kind === 'unsafe') return { kind: 'corrupt' }
  try {
    const journal = parseActivationJournal(JSON.parse(read.raw) as unknown)
    return journal === null ? { kind: 'corrupt' } : { kind: 'valid', journal }
  } catch {
    return { kind: 'corrupt' }
  }
}

export function writeActivationJournal(baseDir: string, journal: ActivationJournal): void {
  const parsed = parseActivationJournal(journal)
  if (parsed === null) throw new Error('activation journal 形状无效')
  atomicWriteJson(activationJournalPath(baseDir), parsed)
}

/** Create the controller-owned pending intent. An in-flight prepared journal
 * is never overwritten by a second selection. */
export function writeActivationIntent(
  baseDir: string,
  input: ActivationIntentInput,
  now = new Date(),
): ActivationJournal {
  // Builtin targets may name the exact sentinel token ('builtin-anchor',
  // the gateway's builtin/fallback identity) instead of a semver — the
  // startup/apply phases only compare targetVersion for non-builtin targets.
  // Anything else must still pass the strict path-safe semver gate
  // (2026-09 release gate: F4 shell-invalidation with an existing override
  // crashed the gateway on the builtin-anchor token).
  const targetVersion = input.targetIsBuiltin
    ? (input.targetVersion === BUILTIN_ANCHOR_VERSION_TOKEN
      ? input.targetVersion
      : assertSafeVersion(input.targetVersion))
    : assertSafeVersion(input.targetVersion)
  const targetIsBuiltin = input.targetIsBuiltin ?? false
  if (typeof targetIsBuiltin !== 'boolean') throw new Error('targetIsBuiltin 必须是 boolean')
  if (typeof input.manualRollback !== 'boolean') throw new Error('manualRollback 必须是 boolean')
  if (input.intentKind !== 'version-switch'
    && input.intentKind !== 'reset-builtin'
    && input.intentKind !== 'shell-invalidation') {
    throw new Error('intentKind 非法')
  }
  if (!validIntentShape(input.intentKind, targetIsBuiltin, input.manualRollback)) {
    throw new Error('activation intent kind/target/manualRollback 组合无效')
  }
  if (Number.isNaN(now.getTime())) throw new Error('activation intent 时间戳无效')
  const existing = readActivationJournalState(baseDir)
  if (existing.kind === 'corrupt') throw new Error('activation journal 损坏；拒绝覆盖恢复证据')
  if (existing.kind === 'valid' && existing.journal.phase === 'applied-monitoring') {
    if (existing.journal.nextIntent !== null) {
      const queued = existing.journal.nextIntent
      if (queued.targetVersion !== targetVersion
        || queued.targetIsBuiltin !== targetIsBuiltin
        || queued.manualRollback !== input.manualRollback
        || queued.intentKind !== input.intentKind) {
        throw new Error('已有 queued activation intent，拒绝覆盖用户选择')
      }
      return existing.journal
    }
    const journal: ActivationJournal = {
      ...existing.journal,
      nextIntent: { targetVersion, targetIsBuiltin, manualRollback: input.manualRollback, intentKind: input.intentKind },
      updatedAt: now.toISOString(),
    }
    writeActivationJournal(baseDir, journal)
    return journal
  }
  if (existing.kind === 'valid' && existing.journal.phase !== 'intent') {
    throw new Error('已有运行时激活事务，拒绝覆盖')
  }
  const timestamp = now.toISOString()
  const journal: ActivationJournal = {
    schemaVersion: 1,
    phase: 'intent',
    targetVersion,
    targetIsBuiltin,
    manualRollback: input.manualRollback,
    intentKind: input.intentKind,
    sourceVersion: null,
    sourceIsBuiltin: null,
    sourceWasKnownGood: null,
    knownGoodVersion: null,
    preSwapSnapshotName: null,
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: null,
    nextIntent: null,
    startedAt: timestamp,
    updatedAt: timestamp,
  }
  writeActivationJournal(baseDir, journal)
  return journal
}

/** Durably enqueue a follow-up action without overwriting the active
 * transaction. Used by the public [恢复内建] escape hatch during applying. */
export function queueActivationIntent(
  baseDir: string,
  input: ActivationIntentInput,
  now = new Date(),
): ActivationJournal {
  // Builtin targets may name the exact sentinel token ('builtin-anchor',
  // the gateway's builtin/fallback identity) instead of a semver — the
  // startup/apply phases only compare targetVersion for non-builtin targets.
  // Anything else must still pass the strict path-safe semver gate
  // (2026-09 release gate: F4 shell-invalidation with an existing override
  // crashed the gateway on the builtin-anchor token).
  const targetVersion = input.targetIsBuiltin
    ? (input.targetVersion === BUILTIN_ANCHOR_VERSION_TOKEN
      ? input.targetVersion
      : assertSafeVersion(input.targetVersion))
    : assertSafeVersion(input.targetVersion)
  const targetIsBuiltin = input.targetIsBuiltin ?? false
  if (typeof targetIsBuiltin !== 'boolean' || typeof input.manualRollback !== 'boolean') {
    throw new Error('queued activation intent 形状无效')
  }
  if (input.intentKind !== 'version-switch'
    && input.intentKind !== 'reset-builtin'
    && input.intentKind !== 'shell-invalidation') throw new Error('queued activation intent kind 非法')
  if (!validIntentShape(input.intentKind, targetIsBuiltin, input.manualRollback)) {
    throw new Error('queued activation intent kind/target/manualRollback 组合无效')
  }
  if (Number.isNaN(now.getTime())) throw new Error('queued activation intent 时间戳无效')
  const existing = readActivationJournalState(baseDir)
  if (existing.kind !== 'valid') throw new Error('没有可安全排队的运行时激活事务')
  const queued: ActivationJournalIntent = {
    targetVersion,
    targetIsBuiltin,
    manualRollback: input.manualRollback,
    intentKind: input.intentKind,
  }
  if (existing.journal.nextIntent !== null) {
    const current = existing.journal.nextIntent
    if (current.targetVersion === queued.targetVersion
      && current.targetIsBuiltin === queued.targetIsBuiltin
      && current.manualRollback === queued.manualRollback
      && current.intentKind === queued.intentKind) return existing.journal
    throw new Error('已有 queued activation intent，拒绝覆盖用户选择')
  }
  const journal: ActivationJournal = {
    ...existing.journal,
    nextIntent: queued,
    updatedAt: now.toISOString(),
  }
  writeActivationJournal(baseDir, journal)
  return journal
}

export function clearActivationJournal(baseDir: string): void {
  rmSync(activationJournalPath(baseDir), { force: true })
}

export function listVersionTrees(baseDir: string): string[] {
  let entries
  try {
    entries = readdirSync(runtimeDirPath(baseDir), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && EXACT_SEMVER.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

export type VersionTreeValidation = { ok: true; path: string } | { ok: false; error: string }

const CRITICAL_RUNTIME_FILES = [
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
] as const

function validateCriticalRuntimeFiles(
  treePath: string,
  version: string,
  dshManifest: Record<string, unknown>,
): string | null {
  const critical = dshManifest.criticalFiles
  if (critical === null || typeof critical !== 'object' || Array.isArray(critical)) {
    return '版本树缺少关键文件摘要'
  }
  let rootReal: string
  try { rootReal = realpathSync(treePath) } catch { return '版本树真实路径不可解析' }
  for (const relativePath of CRITICAL_RUNTIME_FILES) {
    const expected = (critical as Record<string, unknown>)[relativePath]
    if (typeof expected !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(expected)) {
      return `版本树关键文件摘要无效：${relativePath}`
    }
    const candidate = join(treePath, relativePath)
    try {
      const info = lstatSync(candidate)
      if (!info.isFile() || info.isSymbolicLink()) return `版本树关键文件不是实体文件：${relativePath}`
      const candidateReal = realpathSync(candidate)
      const fromRoot = relative(rootReal, candidateReal)
      if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
        return `版本树关键文件逃逸目录：${relativePath}`
      }
      const actual = `sha256-${createHash('sha256').update(readFileSync(candidate)).digest('base64')}`
      if (actual !== expected) return `版本树关键文件摘要不匹配：${relativePath}`
    } catch {
      return `版本树关键文件缺失或不可读：${relativePath}`
    }
  }
  try {
    const packageManifest = JSON.parse(readFileSync(join(treePath, CRITICAL_RUNTIME_FILES[0]), 'utf8')) as unknown
    if (packageManifest === null || typeof packageManifest !== 'object' || Array.isArray(packageManifest)) {
      return '版本树 dsh package manifest 形状无效'
    }
    const pkg = packageManifest as Record<string, unknown>
    if (pkg.name !== '@deepseek-ai/dsh' || pkg.version !== version) return '版本树 dsh package 身份不匹配'
  } catch {
    return '版本树 dsh package manifest 无效'
  }
  return null
}

/** Validate the complete immutable-tree contract, not merely its directory. */
export function validateVersionTree(
  baseDir: string,
  version: string,
  platform = `${process.platform}-${process.arch}`,
): VersionTreeValidation {
  if (!isSafeVersion(version)) return { ok: false, error: '版本号不是安全的精确 semver' }
  const treePath = join(runtimeDirPath(baseDir), version)
  try {
    if (!lstatSync(treePath).isDirectory()) return { ok: false, error: '版本树不存在或不是实体目录' }
  } catch {
    return { ok: false, error: '版本树不存在或不可读' }
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(treePath, 'package.json'), 'utf8')) as unknown
  } catch {
    return { ok: false, error: '版本树 package.json 缺失或损坏' }
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, error: '版本树 manifest 形状无效' }
  const root = manifest as Record<string, unknown>
  const dependencies = root.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies) || (dependencies as Record<string, unknown>)['@deepseek-ai/dsh'] !== version) {
    return { ok: false, error: `版本树 manifest 未精确钉住 @deepseek-ai/dsh@${version}` }
  }
  const dsh = root.dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh) || (dsh as Record<string, unknown>).platform !== platform) {
    return { ok: false, error: `版本树平台不匹配（需要 ${platform}）` }
  }
  const criticalError = validateCriticalRuntimeFiles(treePath, version, dsh as Record<string, unknown>)
  if (criticalError !== null) return { ok: false, error: criticalError }
  return { ok: true, path: treePath }
}

export function listValidVersionTrees(baseDir: string, platform = `${process.platform}-${process.arch}`): string[] {
  return listVersionTrees(baseDir).filter((version) => validateVersionTree(baseDir, version, platform).ok)
}

function explicitInstallsPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'explicit-installs.json')
}

type VersionTimestampMapState = { kind: 'missing' | 'corrupt' | 'valid'; versions: Record<string, string> }

function readVersionTimestampMap(filePath: string): VersionTimestampMapState {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt', versions: {} }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt', versions: {} }
    const versions = (parsed as Record<string, unknown>).versions
    if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) return { kind: 'corrupt', versions: {} }
    const out: Record<string, string> = {}
    for (const [version, timestamp] of Object.entries(versions as Record<string, unknown>)) {
      if (!isSafeVersion(version) || typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) return { kind: 'corrupt', versions: {} }
      out[version] = timestamp
    }
    return { kind: 'valid', versions: out }
  } catch {
    return { kind: 'corrupt', versions: {} }
  }
}

function seedExplicitInstalls(baseDir: string, state: VersionTimestampMapState): Record<string, string> {
  if (state.kind === 'valid') return { ...state.versions }
  // Before the retention ledger existed every runtime installation was a user
  // action. Missing/corrupt ledger therefore preserves all existing trees.
  const timestamp = new Date().toISOString()
  return Object.fromEntries(listVersionTrees(baseDir).map((version) => [version, timestamp]))
}

export function listExplicitlyInstalledVersions(baseDir: string): string[] {
  const state = readVersionTimestampMap(explicitInstallsPath(baseDir))
  return Object.keys(seedExplicitInstalls(baseDir, state)).sort()
}

export function recordExplicitInstall(
  baseDir: string,
  version: string,
  now = new Date(),
  platform = `${process.platform}-${process.arch}`,
): void {
  const safe = assertSafeVersion(version)
  const validation = validateVersionTree(baseDir, safe, platform)
  if (!validation.ok) throw new Error(`不能保留无效运行时安装：${validation.error}`)
  if (Number.isNaN(now.getTime())) throw new Error('显式安装时间戳无效')
  const filePath = explicitInstallsPath(baseDir)
  const state = readVersionTimestampMap(filePath)
  if (state.kind === 'corrupt' && existsSync(filePath)) preserveCorrupt(filePath)
  const versions = seedExplicitInstalls(baseDir, state)
  versions[safe] = now.toISOString()
  atomicWriteJson(filePath, { versions })
}

/** Explicit cleanup opt-out. The tree is not removed here; a later eviction
 * may remove it if no current/known-good/pending/failure protection remains. */
export function forgetExplicitInstall(baseDir: string, version: string): void {
  const safe = assertSafeVersion(version)
  const filePath = explicitInstallsPath(baseDir)
  const state = readVersionTimestampMap(filePath)
  if (state.kind === 'corrupt' && existsSync(filePath)) preserveCorrupt(filePath)
  const versions = seedExplicitInstalls(baseDir, state)
  delete versions[safe]
  atomicWriteJson(filePath, { versions })
}

function isExplicitInstall(baseDir: string, version: string): boolean {
  const state = readVersionTimestampMap(explicitInstallsPath(baseDir))
  if (state.kind !== 'valid') return listVersionTrees(baseDir).includes(version)
  return Object.prototype.hasOwnProperty.call(state.versions, version)
}

function knownGoodPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'known-good.json')
}

export function listKnownGoodVersions(baseDir: string): string[] {
  const state = readVersionTimestampMap(knownGoodPath(baseDir))
  if (state.kind !== 'valid') return []
  return Object.entries(state.versions)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .map(([version]) => version)
}

export function latestKnownGood(
  baseDir: string,
  excludeVersion: string | null = null,
  platform = `${process.platform}-${process.arch}`,
): string | null {
  return listKnownGoodVersions(baseDir)
    .find((version) => version !== excludeVersion && validateVersionTree(baseDir, version, platform).ok) ?? null
}

export function markKnownGood(
  baseDir: string,
  version: string,
  now = new Date(),
  platform = `${process.platform}-${process.arch}`,
): void {
  const safe = assertSafeVersion(version)
  const validation = validateVersionTree(baseDir, safe, platform)
  if (!validation.ok) throw new Error(`不能标记无效运行时为 known-good：${validation.error}`)
  if (Number.isNaN(now.getTime())) throw new Error('known-good 时间戳无效')
  const filePath = knownGoodPath(baseDir)
  const state = readVersionTimestampMap(filePath)
  if (state.kind === 'corrupt' && existsSync(filePath)) preserveCorrupt(filePath)
  const versions = state.kind === 'valid' ? { ...state.versions } : {}
  versions[safe] = now.toISOString()
  atomicWriteJson(filePath, { versions })
}

export function forgetKnownGood(baseDir: string, version: string): void {
  const safe = assertSafeVersion(version)
  const filePath = knownGoodPath(baseDir)
  const state = readVersionTimestampMap(filePath)
  if (state.kind !== 'valid') return
  const versions = { ...state.versions }
  delete versions[safe]
  atomicWriteJson(filePath, { versions })
}

function failurePath(baseDir: string, version: string): string {
  return join(runtimeDirPath(baseDir), 'failures', `${assertSafeVersion(version)}.json`)
}

function validFailurePhase(phase: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(phase)
}

function parseFailureRecord(parsed: unknown, expectedVersion?: string): RuntimeFailureRecord | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.version !== 'string' || !isSafeVersion(record.version) || (expectedVersion !== undefined && record.version !== expectedVersion)) return null
  if (typeof record.phase !== 'string' || !validFailurePhase(record.phase)) return null
  if (typeof record.firstFailedAt !== 'string' || Number.isNaN(Date.parse(record.firstFailedAt))) return null
  if (typeof record.lastFailedAt !== 'string' || Number.isNaN(Date.parse(record.lastFailedAt))) return null
  if (typeof record.occurrences !== 'number' || !Number.isInteger(record.occurrences) || record.occurrences < 1) return null
  if (typeof record.error !== 'string') return null
  if (record.restoreOutcome !== null && record.restoreOutcome !== 'none' && record.restoreOutcome !== 'complete' && record.restoreOutcome !== 'half' && record.restoreOutcome !== 'incomplete') return null
  const snapshotName = parseNullableSnapshotName(record.snapshotName)
  if (snapshotName === undefined) return null
  return {
    version: record.version,
    phase: record.phase,
    firstFailedAt: record.firstFailedAt,
    lastFailedAt: record.lastFailedAt,
    occurrences: record.occurrences,
    error: record.error,
    restoreOutcome: record.restoreOutcome as RestoreOutcomeRecord | null,
    snapshotName,
  }
}

export function readRuntimeFailure(baseDir: string, version: string): RuntimeFailureRecord | null {
  const safe = assertSafeVersion(version)
  const filePath = failurePath(baseDir, safe)
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  const record = parseFailureRecord(parsed, safe)
  if (record === null) preserveCorrupt(filePath)
  return record
}

export function recordRuntimeFailure(baseDir: string, input: RuntimeFailureInput, now = new Date()): RuntimeFailureRecord {
  const version = assertSafeVersion(input.version)
  if (!validFailurePhase(input.phase)) throw new Error('failure.phase 必须是安全的短横线标识符')
  const previous = readRuntimeFailure(baseDir, version)
  const timestamp = now.toISOString()
  const record: RuntimeFailureRecord = {
    version,
    phase: input.phase,
    firstFailedAt: previous?.firstFailedAt ?? timestamp,
    lastFailedAt: timestamp,
    occurrences: (previous?.occurrences ?? 0) + 1,
    error: sanitizeErrorText(input.error instanceof Error ? input.error.message : String(input.error)).slice(0, 2_000),
    restoreOutcome: input.restoreOutcome ?? null,
    snapshotName: input.snapshotPath ? basename(input.snapshotPath) : null,
  }
  atomicWriteJson(failurePath(baseDir, version), record)
  return record
}

export function listRuntimeFailures(baseDir: string): RuntimeFailureRecord[] {
  const dir = join(runtimeDirPath(baseDir), 'failures')
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const records: RuntimeFailureRecord[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const version = entry.name.slice(0, -'.json'.length)
    if (!isSafeVersion(version)) continue
    const record = readRuntimeFailure(baseDir, version)
    if (record !== null) records.push(record)
  }
  return records.sort((a, b) => Date.parse(b.lastFailedAt) - Date.parse(a.lastFailedAt))
}

export function runtimeFailureSummary(baseDir: string): RuntimeFailureSummary {
  const failures = listRuntimeFailures(baseDir)
  return { count: failures.length, latest: failures[0] ?? null }
}

/** Fail-closed facts for snapshot pruning. This deliberately includes every
 * snapshot referenced by recovery/failure metadata and returns corrupt when
 * any protection class is unknowable. */
export function runtimeSnapshotRetentionState(baseDir: string): RuntimeSnapshotRetentionState {
  const pointer = readCurrentPointerState(baseDir)
  const override = readOverrideState(baseDir)
  const activation = readActivationJournalState(baseDir)
  const knownGood = readVersionTimestampMap(knownGoodPath(baseDir))
  if (pointer.kind === 'corrupt'
    || override.kind === 'corrupt'
    || activation.kind === 'corrupt'
    || knownGood.kind === 'corrupt') return { kind: 'corrupt' }

  const protectedVersions = new Set<string>()
  const protectedSnapshotNames = new Set<string>()
  if (pointer.kind === 'valid') protectedVersions.add(pointer.version)
  if (override.kind === 'valid') {
    for (const version of [override.record.chosenVersion, override.record.resolvedVersion, override.record.pending]) {
      if (version !== null) protectedVersions.add(version)
    }
  }
  if (knownGood.kind === 'valid') {
    for (const version of Object.keys(knownGood.versions)) protectedVersions.add(version)
  }
  if (activation.kind === 'valid') {
    const journal = activation.journal
    for (const version of [
      journal.targetVersion,
      journal.sourceVersion,
      journal.rollbackTarget,
      journal.knownGoodVersion,
      journal.nextIntent?.targetVersion ?? null,
    ]) {
      if (version !== null) protectedVersions.add(version)
    }
    for (const name of [journal.preSwapSnapshotName, journal.manualDataSnapshotName]) {
      if (name !== null) protectedSnapshotNames.add(name)
    }
  }

  const failureDir = join(runtimeDirPath(baseDir), 'failures')
  let failureEntries: string[] = []
  try { failureEntries = readdirSync(failureDir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'corrupt' }
  }
  if (failureEntries.some((name) => name.includes('.json.corrupt'))) return { kind: 'corrupt' }
  for (const name of failureEntries) {
    if (!name.endsWith('.json')) continue
    const version = name.slice(0, -'.json'.length)
    if (!isSafeVersion(version)) return { kind: 'corrupt' }
    const failure = readRuntimeFailure(baseDir, version)
    if (failure === null) return { kind: 'corrupt' }
    protectedVersions.add(failure.version)
    if (failure.snapshotName !== null) protectedSnapshotNames.add(failure.snapshotName)
  }
  return {
    kind: 'valid',
    protectedVersions: [...protectedVersions].sort(),
    protectedSnapshotNames: [...protectedSnapshotNames].sort(),
  }
}

export function clearRuntimeFailure(baseDir: string, version: string): void {
  rmSync(failurePath(baseDir, version), { force: true })
}

function isKnownGoodProtected(baseDir: string, version: string): boolean {
  const state = readVersionTimestampMap(knownGoodPath(baseDir))
  // Corruption makes the protected set unknowable. Preserve all trees.
  return state.kind === 'corrupt' || (state.kind === 'valid' && Object.prototype.hasOwnProperty.call(state.versions, version))
}

function isKnownGoodCandidateProtected(baseDir: string, version: string): boolean {
  const filePath = join(runtimeDirPath(baseDir), 'known-good-candidates.json')
  const parsed = readJson(filePath)
  if (parsed === null) return existsSync(filePath)
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return true
  const versions = (parsed as Record<string, unknown>).versions
  if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) return true
  return Object.prototype.hasOwnProperty.call(versions, version)
}

function hasFailureEvidence(baseDir: string, version: string): boolean {
  const prefix = `${version}.json`
  const failureDir = join(runtimeDirPath(baseDir), 'failures')
  try {
    const info = lstatSync(failureDir)
    // A symlink/non-directory is not an empty evidence set. Treat the whole
    // protection class as unknowable so cleanup and automatic eviction keep
    // every possibly referenced runtime tree.
    if (info.isSymbolicLink() || !info.isDirectory()) return true
    return readdirSync(failureDir)
      .some((name) => name === prefix || name.startsWith(`${prefix}.corrupt`))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** Every automatic-eviction protection class, including explicit installs. */
export function isProtectedVersion(
  baseDir: string,
  version: string,
  options: { ignoreExplicitInstall?: boolean } = {},
): boolean {
  if (!isSafeVersion(version)) return false
  const runtimeDir = runtimeDirPath(baseDir)
  const activation = readActivationJournalState(baseDir)
  // Corrupt recovery metadata makes its protected set unknowable. Never evict
  // a possibly unique source/target/rollback tree in that state.
  if (activation.kind === 'corrupt') return true
  if (activation.kind === 'valid') {
    const journal = activation.journal
    if (journal.targetVersion === version
      || journal.sourceVersion === version
      || journal.rollbackTarget === version
      || journal.knownGoodVersion === version
      || journal.nextIntent?.targetVersion === version) return true
  }
  const pointer = readCurrentPointerState(baseDir)
  if (pointer.kind === 'corrupt') return true
  if (pointer.kind === 'valid' && pointer.version === version) return true
  if (isKnownGoodProtected(baseDir, version)) return true
  if (isKnownGoodCandidateProtected(baseDir, version)) return true
  const override = readOverrideState(baseDir)
  if (override.kind === 'corrupt') return true
  if (override.kind === 'valid'
    && (override.record.pending === version
      || override.record.chosenVersion === version
      || override.record.resolvedVersion === version)) return true
  if (hasFailureEvidence(baseDir, version)) return true
  if (existsSync(join(runtimeDir, `${version}.failed`))) return true
  if (options.ignoreExplicitInstall !== true && isExplicitInstall(baseDir, version)) return true
  return false
}

/** User-authorized cleanup of one explicitly retained tree. Every recovery,
 * active, pending, known-good, candidate, and failure protection is re-read
 * at the deletion point. A protected tree is left byte-for-byte intact and
 * keeps its explicit retention record; a removal failure likewise never
 * silently drops that record. */
export function cleanupExplicitRuntimeVersion(
  baseDir: string,
  version: string,
): ExplicitRuntimeCleanupResult {
  const safe = assertSafeVersion(version)
  if (isProtectedVersion(baseDir, safe, { ignoreExplicitInstall: true })) {
    return { removed: false, retentionCleared: false, stillProtected: true }
  }
  const treePath = join(runtimeDirPath(baseDir), safe)
  const exists = existsSync(treePath)
  if (exists) {
    makeOwnedTreeWritable(treePath)
    rmSync(treePath, { recursive: true, force: true })
  }
  forgetExplicitInstall(baseDir, safe)
  if (exists) markStorePruneNeeded(baseDir, `explicit-cleanup:${safe}`)
  return { removed: exists, retentionCleared: true, stillProtected: false }
}

function storePruneMarkerPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'store-prune-needed.json')
}

export function readStorePruneRequest(baseDir: string): StorePruneRequest | null {
  const parsed = readJson(storePruneMarkerPath(baseDir))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const rec = parsed as Record<string, unknown>
  if (typeof rec.requestedAt !== 'string' || !Array.isArray(rec.reasons) || !rec.reasons.every((v) => typeof v === 'string')) return null
  return { requestedAt: rec.requestedAt, reasons: rec.reasons as string[] }
}

export function markStorePruneNeeded(baseDir: string, reason: string): void {
  const previous = readStorePruneRequest(baseDir)
  const reasons = Array.from(new Set([...(previous?.reasons ?? []), reason])).slice(-20)
  atomicWriteJson(storePruneMarkerPath(baseDir), { requestedAt: new Date().toISOString(), reasons })
}

export function clearStorePruneRequest(baseDir: string): void {
  rmSync(storePruneMarkerPath(baseDir), { force: true })
}

function versionTreeMtimeMs(baseDir: string, version: string): number {
  try { return statSync(join(runtimeDirPath(baseDir), version)).mtimeMs } catch { return 0 }
}

/** Evict only unprotected automatic cache trees, oldest first. */
function makeOwnedTreeWritable(treePath: string): void {
  const visit = (entryPath: string): void => {
    const info = lstatSync(entryPath)
    if (info.isSymbolicLink()) return
    if (info.isDirectory()) {
      chmodSync(entryPath, info.mode | 0o700)
      for (const entry of readdirSync(entryPath, { withFileTypes: true })) {
        visit(join(entryPath, entry.name))
      }
      return
    }
    if (info.isFile()) chmodSync(entryPath, info.mode | 0o600)
  }
  visit(treePath)
}

export function evictVersions(baseDir: string, keep = 3): string[] {
  if (!Number.isInteger(keep) || keep < 0) throw new Error('keep 必须是非负整数')
  const trees = listVersionTrees(baseDir)
  if (trees.length <= keep) return []
  const removable = trees
    .filter((version) => !isProtectedVersion(baseDir, version))
    .sort((a, b) => versionTreeMtimeMs(baseDir, a) - versionTreeMtimeMs(baseDir, b))
  const evicted: string[] = []
  let total = trees.length
  for (const version of removable) {
    if (total <= keep) break
    const treePath = join(runtimeDirPath(baseDir), version)
    makeOwnedTreeWritable(treePath)
    rmSync(treePath, { recursive: true, force: true })
    evicted.push(version)
    total -= 1
  }
  if (evicted.length > 0) markStorePruneNeeded(baseDir, `evicted:${evicted.join(',')}`)
  return evicted
}

function isPidAlive(pid: number, group = false): boolean {
  try {
    process.kill(group && process.platform !== 'win32' ? -pid : pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Read the installer's work-dir lifecycle marker (see runtime-installer.ts).
 * Returns one of the known states, or null when absent/corrupt — null is
 * deliberately NOT reclaimable (legacy residue without the marker keeps the
 * fail-closed block). No-follow: a symlinked marker is never read. */
function readWorkStateMarker(workDir: string): 'preparing' | 'spawning' | 'spawned' | 'failed' | null {
  try {
    const info = lstatSync(join(workDir, 'state'))
    if (info.isSymbolicLink() || !info.isFile() || info.size > 32) return null
    const value = readFileSync(join(workDir, 'state'), 'utf8').trim()
    return value === 'preparing' || value === 'spawning' || value === 'spawned' || value === 'failed' ? value : null
  } catch {
    return null
  }
}

export function cleanupStaleInstalls(baseDir: string): string[] {
  let entries
  try {
    entries = readdirSync(runtimeDirPath(baseDir), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.work-')) continue
    const workDir = join(runtimeDirPath(baseDir), entry.name)
    const pidPath = join(workDir, 'pid')
    let pid: number | null = null
    let pidEvidence: 'missing' | 'corrupt' | 'valid' = 'missing'
    try {
      const info = lstatSync(pidPath)
      if (info.isSymbolicLink() || !info.isFile() || info.size > 64) {
        pidEvidence = 'corrupt'
      } else {
        const parsed = Number(readFileSync(pidPath, 'utf8').trim())
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          pid = parsed
          pidEvidence = 'valid'
        } else {
          pidEvidence = 'corrupt'
        }
      }
    } catch (error) {
      pidEvidence = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt'
    }
    if (pid === null) {
      const entries = readdirSync(workDir)
      // A crash between mkdir(workDir) and publishing any install input is a
      // proven pre-spawn scene and can be reclaimed. Once the directory has
      // content, however, a hard crash may have landed between spawn() and the
      // synchronous PID write. Missing/malformed evidence must not be erased.
      if (pidEvidence === 'missing' && entries.length === 0) {
        rmSync(workDir, { recursive: true, force: true })
        removed.push(entry.name)
        continue
      }
      // The installer persists a `state` marker as its FIRST work-dir file:
      // 'preparing' (or 'failed') proves no child ever existed — a crash
      // during the (up-to-minutes) download window leaves exactly this scene
      // and MUST be reclaimable, or startup blocks forever with no UI exit.
      // 'spawning'/'spawned'/missing/corrupt markers stay fail-closed (a
      // child may exist without PID evidence). Legacy work dirs without a
      // marker keep the conservative block.
      const workState = readWorkStateMarker(workDir)
      if (workState === 'preparing' || workState === 'failed') {
        rmSync(workDir, { recursive: true, force: true })
        removed.push(entry.name)
        continue
      }
      throw new Error(`运行时安装现场的 PID/PGID 证据${pidEvidence === 'missing' ? '缺失' : '损坏'}（${entry.name}）；拒绝清理并阻止启动`)
    }
    if (pid !== null && (isPidAlive(pid, true) || isPidAlive(pid))) {
      // A hard-crashed installer may leave a lifecycle descendant after the
      // recorded group leader exits. Never delete its work/PID evidence or
      // let startup touch DSH_HOME while either the PID or PGID is live.
      throw new Error(`运行时安装现场仍有活动写进程（pid/pgid ${pid}）；拒绝清理并阻止启动`)
    }
    rmSync(workDir, { recursive: true, force: true })
    removed.push(entry.name)
  }
  if (removed.length > 0) markStorePruneNeeded(baseDir, `stale-work:${removed.length}`)
  return removed
}

function measurePathBytes(path: string): number {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  // Do not follow links outside the owned runtime root, but account for the
  // directory entry itself rather than silently treating it as no usage.
  if (info.isSymbolicLink()) return info.size
  if (!info.isDirectory()) return info.size
  let total = info.size
  for (const entry of readdirSync(path)) total += measurePathBytes(join(path, entry))
  return total
}

function isRuntimePublishBackupName(name: string): boolean {
  const match = PUBLISH_BACKUP_NAME.exec(name)
  if (!match) return false
  const version = match[1]
  // Installer-owned backups use the exact, untrimmed version path component.
  // Reusing the path safety predicate keeps lookalike/traversal names out of
  // the owned category while still accounting prerelease/build versions.
  return version === version.trim() && isSafeVersion(version)
}

/** On-demand disk accounting. It performs a full tree walk and is not for a
 * hot UI loop; callers should run it only after install/cleanup or on demand.
 * `dshHome` defaults to the desktop owner layout; the separately invoked
 * gateway passes its sibling `<stateDir>/dsh-home` explicitly so interrupted
 * restore backups are charged to the same logical runtime quota. */
export function runtimeDiskSummary(
  baseDir: string,
  dshHome: string = join(baseDir, 'state', 'dsh-home'),
): RuntimeDiskSummary {
  const runtime = runtimeDirPath(baseDir)
  const trees = listVersionTrees(baseDir)
  const runtimeEntries = (() => {
    try {
      return readdirSync(runtime, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  })()
  const workDirs = runtimeEntries.filter((entry) => entry.isDirectory() && entry.name.startsWith('.work-')).map((entry) => join(runtime, entry.name))
  const failedTrees = runtimeEntries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.failed')).map((entry) => join(runtime, entry.name))
  const publishBackups = runtimeEntries
    .filter((entry) => isRuntimePublishBackupName(entry.name))
    .map((entry) => join(runtime, entry.name))
  const dshHomeParent = dirname(dshHome)
  const dshHomeName = basename(dshHome)
  const restoreBackups = (() => {
    try {
      return readdirSync(dshHomeParent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()
          && (entry.name === `${dshHomeName}.old` || entry.name.startsWith(`${dshHomeName}.old-`)))
        .map((entry) => join(dshHomeParent, entry.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  })()
  const versionTreeBytes = trees.reduce((sum, version) => sum + measurePathBytes(join(runtime, version)), 0)
  const storeBytes = measurePathBytes(join(runtime, '.pnpm-store'))
  const cacheBytes = measurePathBytes(join(runtime, '.pnpm-cache'))
  const installHomeBytes = measurePathBytes(join(runtime, '.install-home'))
  const xdgCacheBytes = measurePathBytes(join(runtime, '.xdg-cache'))
  const workBytes = workDirs.reduce((sum, dir) => sum + measurePathBytes(dir), 0)
  // Recovery stashes/evidence are failure-scene bytes as well: keeping them
  // outside the quota would let the safest corruption path grow invisible to
  // both the UI and the fresh-install soft gate.
  const failureBytes = measurePathBytes(join(runtime, 'failures'))
    + failedTrees.reduce((sum, tree) => sum + measurePathBytes(tree), 0)
    + publishBackups.reduce((sum, backup) => sum + measurePathBytes(backup), 0)
    + measurePathBytes(join(runtime, 'metadata-recovery-data'))
    + measurePathBytes(join(runtime, 'metadata-recovery-rescue-data'))
    + measurePathBytes(join(runtime, 'metadata-recovery.json'))
  const snapshotBytes = measurePathBytes(join(runtime, 'snapshots'))
  const preRollbackBytes = measurePathBytes(join(runtime, 'pre-rollback'))
  const restoreBackupBytes = restoreBackups.reduce((sum, backup) => sum + measurePathBytes(backup), 0)
  const totalBytes = versionTreeBytes + storeBytes + cacheBytes + installHomeBytes
    + xdgCacheBytes + workBytes + failureBytes + snapshotBytes
    + preRollbackBytes + restoreBackupBytes
  return {
    versionTrees: trees.length,
    versionTreeBytes,
    storeBytes,
    cacheBytes,
    installHomeBytes,
    xdgCacheBytes,
    workBytes,
    failureBytes,
    snapshotBytes,
    preRollbackBytes,
    restoreBackupBytes,
    totalBytes,
    storePruneNeeded: existsSync(storePruneMarkerPath(baseDir)),
  }
}
