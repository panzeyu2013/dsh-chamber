/**
 * Runtime disk data plane. Pure Node, baseDir-injected, no Electron.
 *
 * Security/data invariants: metadata writes are atomic (files 0600, containing directories
 * 0700); path-bearing versions are exact semver before use and a directory name alone never
 * proves an installed runtime usable; current / known-good / pending / failure fields and
 * every explicitly installed version survive automatic eviction; corrupt retention metadata
 * fails closed (trees kept, not guessed); deleting a hard-linked tree marks the pnpm store as
 * needing prune, closing the physical-disk loop.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { lstat as lstatP, readdir as readdirP } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { EXACT_SEMVER, assertSafeVersion, isSafeVersion } from './version-safety.ts'
import { PROBE_TEXT_KEEP_TOKENS } from './runtime-probes.ts'
import { sanitizeErrorText } from './sanitize-error.ts'
import {
  CRITICAL_FILE_DIGEST_PATTERN,
  CRITICAL_RUNTIME_FILES,
  openCriticalRuntimeFile,
  sha256FileDigest,
} from './runtime-critical-files.ts'
import { makeOwnedTreeWritable } from './tree-writable.ts'
import {
  atomicWriteRuntimeFileNoFollow,
  ensureRuntimeRootNoFollow,
  isUnreadableFsError,
  quarantineRuntimeFileNoFollow,
  readPrivateFileStateNoFollow,
  removeRuntimeFileNoFollow,
  type ArtifactReadState,
} from './private-fs.ts'

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
  /** Durable distinction for a version selected while builtin (no current pointer) remains
   * active: a selection staged from an active user tree keeps it false so later pointer loss
   * still fails closed; hosts that split select from apply clear it before publishing pending. */
  selectedOnly?: boolean
  invalidatedAt?: string | null
  invalidatedReason?: string | null
  /** Durable user-visible invalidation history that survives a failed builtin probe followed
   *  by automatic reactivation of the old tree. */
  lastInvalidatedAt?: string | null
  lastInvalidatedReason?: string | null
  lastInvalidatedFromVersion?: string | null
  lastInvalidationRecovered?: boolean | null
  lastOutcome?: string | null
  lastError?: string | null
  restoreOutcome?: RestoreOutcomeRecord | null
}

/** Read-failure material is its own state: EACCES/EIO proves neither absence nor corruption,
 *  so it can never alias 'missing' (builtin / no override) or 'corrupt' (quarantine evidence). */
export type CurrentPointerState =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'unknown'; detail: string }
  | { kind: 'valid'; version: string }

export type OverrideState =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'unknown'; detail: string }
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
  /** 'ok' when the failure set is fully known; 'unknown' when a read error made it unknowable. */
  kind: 'ok' | 'unknown'
  /** Failure count; null — never a fabricated 0 — when kind === 'unknown'. */
  count: number | null
  latest: RuntimeFailureRecord | null
  /** Read-failure detail when kind === 'unknown', else null. */
  detail: string | null
}

export type RuntimeSnapshotRetentionState =
  | { kind: 'corrupt'; detail: string }
  | { kind: 'unknown'; detail: string }
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
  /** Deduped bytes inside the runtime root that belong to no known category —
   * stray residue plus the small metadata authority files. */
  unclassifiedBytes: number
  /**
   * Real byte figure: runtime root plus dsh-home.old* backups are walked once and every entry
   * counted by (dev, ino) identity exactly once, so hard-linked entries are never double counted
   * (category fields keep per-path sums). APFS clone/reflink copies are invisible to (dev, ino)
   * dedupe, so on APFS this stays an upper bound of allocated blocks, as with `du`.
   */
  totalBytes: number
  storePruneNeeded: boolean
}

export interface ExplicitRuntimeCleanupResult {
  removed: boolean
  retentionCleared: boolean
  stillProtected: boolean
}

/**
 * Durable activation transaction: `intent` may be written while the selected version is merely
 * pending, and every later phase contains the immutable pre-swap facts and snapshot basename.
 */
const ACTIVATION_JOURNAL_PHASES = [
  'intent',
  'prepared',
  'switched',
  'manual-restoring',
  'manual-restored',
  'rollback-needed',
  'restoring',
  'restore-complete',
  'fallback-builtin',
  'applied-monitoring',
] as const
export type ActivationJournalPhase = (typeof ACTIVATION_JOURNAL_PHASES)[number]

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
  /** A later selection can queue without erasing delayed-rollback monitoring context. */
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
 * The builtin/fallback identity token: an activation intent targeting the builtin anchor may name
 * this sentinel instead of a semver; startup/apply compare targetVersion only for non-builtin targets.
 */
export const BUILTIN_ANCHOR_VERSION_TOKEN = 'builtin-anchor'

function runtimeDirPath(baseDir: string): string {
  return join(baseDir, 'dsh-runtime')
}

/** Atomic JSON write; fixed permissions also tighten an old permissive file. */
function atomicWriteJson(baseDir: string, filePath: string, payload: unknown): void {
  atomicWriteRuntimeFileNoFollow(baseDir, filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

interface FileIdentity {
  dev: number | bigint
  ino: number | bigint
}

type AuthorityRead = ArtifactReadState<{ raw: string; identity: FileIdentity }>

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Read one authority leaf without ever following it: runtime-directory and leaf identities are
 * checked around the operation, the file must have a single link, and tightening goes through the
 * already-verified descriptor rather than a path lookup. An OS-level read failure stays separate
 * from corrupt content.
 */
function readAuthorityMetadata(filePath: string, maxBytes: number): AuthorityRead {
  return readPrivateFileStateNoFollow(filePath, maxBytes)
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

/** Quarantine only the exact single-link inode that was safely read; never chmod the destination
 *  by path — the source fd was already tightened. */
function preserveSafeCorruptAuthority(baseDir: string, filePath: string, expected: FileIdentity): boolean {
  try {
    const preferred = `${filePath}.corrupt`
    const dest = existsSync(preferred)
      ? `${preferred}-${Date.now()}-${randomBytes(3).toString('hex')}`
      : preferred
    quarantineRuntimeFileNoFollow(baseDir, filePath, dest, { expectedIdentity: expected })
    return true
  } catch (error) {
    console.error('[dsh-runtime-store] 保留损坏文件失败：', error)
    return false
  }
}

export function currentPointerPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'current')
}

/** Missing means builtin. Corrupt is deliberately distinct and must block runtime resolution:
 *  treating malformed metadata as builtin loses the only pointer to user data. */
export function readCurrentPointerState(baseDir: string): CurrentPointerState {
  const filePath = currentPointerPath(baseDir)
  const read = readAuthorityMetadata(filePath, MAX_CURRENT_POINTER_BYTES)
  if (read.kind === 'missing') return { kind: 'missing' }
  if (read.kind === 'unknown') return { kind: 'unknown', detail: read.detail }
  if (read.kind === 'corrupt') return { kind: 'corrupt' }
  try {
    const parsed = JSON.parse(read.value.raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt' }
    const version = (parsed as Record<string, unknown>).version
    return typeof version === 'string' && isSafeVersion(version)
      ? { kind: 'valid', version }
      : { kind: 'corrupt' }
  } catch {
    return { kind: 'corrupt' }
  }
}

export function writeCurrentPointer(baseDir: string, version: string): void {
  atomicWriteJson(baseDir, currentPointerPath(baseDir), { version: assertSafeVersion(version) })
}

/** Explicitly fall back to the builtin chain; historical override metadata is untouched and
 *  callers decide separately whether this is reset or invalidation. */
export function clearCurrentPointer(baseDir: string): void {
  removeRuntimeFileNoFollow(baseDir, currentPointerPath(baseDir))
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

/** Corrupt override is preserved and represented as a durable fail-closed state: the .corrupt
 *  sentinel keeps subsequent boots blocked once the first read moves malformed content aside. */
export function readOverrideState(baseDir: string): OverrideState {
  const filePath = overridePath(baseDir)
  const read = readAuthorityMetadata(filePath, MAX_OVERRIDE_BYTES)
  if (read.kind === 'missing') {
    return hasCorruptOverrideSentinel(filePath) ? { kind: 'corrupt' } : { kind: 'missing' }
  }
  if (read.kind === 'unknown') return { kind: 'unknown', detail: read.detail }
  if (read.kind === 'corrupt') return { kind: 'corrupt' }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.value.raw)
  } catch {
    preserveSafeCorruptAuthority(baseDir, filePath, read.value.identity)
    return { kind: 'corrupt' }
  }
  const record = parseOverrideRecord(parsed)
  if (record === null) {
    preserveSafeCorruptAuthority(baseDir, filePath, read.value.identity)
    return { kind: 'corrupt' }
  }
  return { kind: 'valid', record }
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
  for (const [, version] of [
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
  atomicWriteJson(baseDir, overridePath(baseDir), payload)
}

/** Explicit restore-builtin action; the caller must copy invalidated history first if it wants
 *  a separate audit log — this only removes override. */
export function deleteOverride(baseDir: string): void {
  removeRuntimeFileNoFollow(baseDir, overridePath(baseDir))
}

export function activationJournalPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'activation-journal.json')
}

function isActivationJournalPhase(value: unknown): value is ActivationJournalPhase {
  return (ACTIVATION_JOURNAL_PHASES as readonly unknown[]).includes(value)
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
  // Same 13-digit-epoch shape snapshot-store's isStashName enforces, kept in lockstep so the
  // store never accepts a name the resolver rejects.
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
  // Schema-1 journals predate intentKind and were exclusively version switches; never
  // reinterpret them as reset/invalidation.
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
    // Snapshot creation requires an exact real source version; a null/unknown source must fail
    // before a pointer mutation and can never become prepared.
    if (sourceVersion === null || preSwapSnapshotName === null) return null
    if (record.manualRollback) {
      if ((manualDataSnapshotName === null) !== (preRollbackStashName === null)) return null
    } else if (manualDataSnapshotName !== null || preRollbackStashName !== null) {
      return null
    }
    // A privileged action may be queued while any activation phase is in flight; the apply writer
    // preserves this field at every boundary and startup converts it to a fresh intent only after a
    // verified applied/safe-fallback verdict.
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

/** Corruption is a fail-closed state: the journal stays until explicit recovery/reset, so a
 *  second launch cannot reinterpret corruption as "no activation in flight". */
export function readActivationJournalState(baseDir: string): ActivationJournalState {
  const filePath = activationJournalPath(baseDir)
  const read = readAuthorityMetadata(filePath, MAX_ACTIVATION_JOURNAL_BYTES)
  if (read.kind === 'missing') return { kind: 'missing' }
  // The journal has no 'unknown' state on purpose: an unreadable journal is exactly as
  // fail-closed as corruption and must never alias "no journal".
  if (read.kind === 'unknown' || read.kind === 'corrupt') return { kind: 'corrupt' }
  try {
    const journal = parseActivationJournal(JSON.parse(read.value.raw) as unknown)
    return journal === null ? { kind: 'corrupt' } : { kind: 'valid', journal }
  } catch {
    return { kind: 'corrupt' }
  }
}

export function writeActivationJournal(baseDir: string, journal: ActivationJournal): void {
  const parsed = parseActivationJournal(journal)
  if (parsed === null) throw new Error('activation journal 形状无效')
  atomicWriteJson(baseDir, activationJournalPath(baseDir), parsed)
}

/** Create the controller-owned pending intent; an in-flight prepared journal is never
 *  overwritten by a second selection. */
export function writeActivationIntent(
  baseDir: string,
  input: ActivationIntentInput,
  now = new Date(),
): ActivationJournal {
  // Builtin targets may name the exact sentinel token ('builtin-anchor') instead of a semver;
  // anything else must still pass the strict path-safe semver gate.
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

/** Durably enqueue a follow-up action without overwriting the active transaction (used by the
 *  public [恢复内建] escape hatch during applying). */
export function queueActivationIntent(
  baseDir: string,
  input: ActivationIntentInput,
  now = new Date(),
): ActivationJournal {
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
  removeRuntimeFileNoFollow(baseDir, activationJournalPath(baseDir))
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

export type VersionTreeValidation =
  | { ok: true; kind: 'valid'; path: string }
  | { ok: false; kind: 'invalid'; error: string }
  | { ok: false; kind: 'unknown'; error: string }

type TreeValidationFailure = { kind: 'invalid' | 'unknown'; error: string }

function validationFailure(kind: 'invalid' | 'unknown', error: string): TreeValidationFailure {
  return { kind, error }
}

function validateCriticalRuntimeFiles(
  treePath: string,
  version: string,
  dshManifest: Record<string, unknown>,
): TreeValidationFailure | null {
  const critical = dshManifest.criticalFiles
  if (critical === null || typeof critical !== 'object' || Array.isArray(critical)) {
    return validationFailure('invalid', '版本树缺少关键文件摘要')
  }
  let rootReal: string
  try {
    rootReal = realpathSync(treePath)
  } catch (error) {
    return validationFailure(isUnreadableFsError(error) ? 'unknown' : 'invalid', '版本树真实路径不可解析')
  }
  for (const relativePath of CRITICAL_RUNTIME_FILES) {
    const expected = (critical as Record<string, unknown>)[relativePath]
    if (typeof expected !== 'string' || !CRITICAL_FILE_DIGEST_PATTERN.test(expected)) {
      return validationFailure('invalid', '版本树关键文件摘要无效：' + relativePath)
    }
    const candidate = join(treePath, relativePath)
    try {
      const opened = openCriticalRuntimeFile(rootReal, candidate)
      if (opened.kind === 'not-regular-file') return validationFailure('invalid', '版本树关键文件不是实体文件：' + relativePath)
      if (opened.kind === 'escapes-tree') return validationFailure('invalid', '版本树关键文件逃逸目录：' + relativePath)
      if (sha256FileDigest(opened.path) !== expected) return validationFailure('invalid', '版本树关键文件摘要不匹配：' + relativePath)
    } catch (error) {
      // ENOENT and digest/shape drift mean damaged content; EACCES/EIO only means the bytes are
      // unreadable and must be reported as unknown.
      return validationFailure(
        isUnreadableFsError(error) ? 'unknown' : 'invalid',
        '版本树关键文件缺失或不可读：' + relativePath,
      )
    }
  }
  let rawManifest: string
  try {
    rawManifest = readFileSync(join(treePath, CRITICAL_RUNTIME_FILES[0]), 'utf8')
  } catch (error) {
    return validationFailure(
      isUnreadableFsError(error) ? 'unknown' : 'invalid',
      '版本树 dsh package manifest 缺失或不可读',
    )
  }
  let packageManifest: unknown
  try {
    packageManifest = JSON.parse(rawManifest) as unknown
  } catch {
    return validationFailure('invalid', '版本树 dsh package manifest 无效')
  }
  if (packageManifest === null || typeof packageManifest !== 'object' || Array.isArray(packageManifest)) {
    return validationFailure('invalid', '版本树 dsh package manifest 形状无效')
  }
  const pkg = packageManifest as Record<string, unknown>
  if (pkg.name !== '@deepseek-ai/dsh' || pkg.version !== version) {
    return validationFailure('invalid', '版本树 dsh package 身份不匹配')
  }
  return null
}

/** Validate the complete immutable-tree contract, not merely its directory. 'kind' distinguishes
 *  a proven-invalid tree from an unreadable one: invalid may be replaced, unknown never overwritten. */
export function validateVersionTree(
  baseDir: string,
  version: string,
  platform = process.platform + '-' + process.arch,
): VersionTreeValidation {
  if (!isSafeVersion(version)) return { ok: false, kind: 'invalid', error: '版本号不是安全的精确 semver' }
  const treePath = join(runtimeDirPath(baseDir), version)
  try {
    if (!lstatSync(treePath).isDirectory()) return { ok: false, kind: 'invalid', error: '版本树不存在或不是实体目录' }
  } catch (error) {
    return {
      ok: false,
      kind: isUnreadableFsError(error) ? 'unknown' : 'invalid',
      error: '版本树不存在或不可读',
    }
  }
  let rawManifest: string
  try {
    rawManifest = readFileSync(join(treePath, 'package.json'), 'utf8')
  } catch (error) {
    return {
      ok: false,
      kind: isUnreadableFsError(error) ? 'unknown' : 'invalid',
      error: '版本树 package.json 缺失或损坏',
    }
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(rawManifest) as unknown
  } catch {
    return { ok: false, kind: 'invalid', error: '版本树 package.json 缺失或损坏' }
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, kind: 'invalid', error: '版本树 manifest 形状无效' }
  }
  const root = manifest as Record<string, unknown>
  const dependencies = root.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)
    || (dependencies as Record<string, unknown>)['@deepseek-ai/dsh'] !== version) {
    return { ok: false, kind: 'invalid', error: '版本树 manifest 未精确钉住 @deepseek-ai/dsh@' + version }
  }
  const dsh = root.dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)
    || (dsh as Record<string, unknown>).platform !== platform) {
    return { ok: false, kind: 'invalid', error: '版本树平台不匹配（需要 ' + platform + '）' }
  }
  const criticalFailure = validateCriticalRuntimeFiles(treePath, version, dsh as Record<string, unknown>)
  if (criticalFailure !== null) {
    return { ok: false, kind: criticalFailure.kind, error: criticalFailure.error }
  }
  return { ok: true, kind: 'valid', path: treePath }
}

export function listValidVersionTrees(baseDir: string, platform = `${process.platform}-${process.arch}`): string[] {
  return listVersionTrees(baseDir).filter((version) => validateVersionTree(baseDir, version, platform).ok)
}

function explicitInstallsPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'explicit-installs.json')
}

type VersionTimestampMapState =
  | { kind: 'missing'; versions: Record<string, never> }
  | { kind: 'corrupt'; versions: Record<string, never>; identity?: FileIdentity }
  | { kind: 'unknown'; detail: string }
  | { kind: 'valid'; versions: Record<string, string> }

function readVersionTimestampMap(filePath: string): VersionTimestampMapState {
  const read = readAuthorityMetadata(filePath, 256 * 1024)
  if (read.kind === 'missing') return { kind: 'missing', versions: {} }
  if (read.kind === 'unknown') return { kind: 'unknown', detail: read.detail }
  if (read.kind === 'corrupt') return { kind: 'corrupt', versions: {} }
  try {
    const parsed: unknown = JSON.parse(read.value.raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'corrupt', versions: {}, identity: read.value.identity }
    }
    const versions = (parsed as Record<string, unknown>).versions
    if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) {
      return { kind: 'corrupt', versions: {}, identity: read.value.identity }
    }
    const out: Record<string, string> = {}
    for (const [version, timestamp] of Object.entries(versions as Record<string, unknown>)) {
      if (!isSafeVersion(version) || typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
        return { kind: 'corrupt', versions: {}, identity: read.value.identity }
      }
      out[version] = timestamp
    }
    return { kind: 'valid', versions: out }
  } catch {
    return { kind: 'corrupt', versions: {}, identity: read.value.identity }
  }
}

function assertTimestampMapWritable(baseDir: string, filePath: string, state: VersionTimestampMapState): void {
  if (state.kind === 'unknown') {
    // The ledger could not be read: overwriting would destroy bytes never proven illegal (e.g. a
    // transient EIO), so writes fail closed.
    throw new Error('runtime 版本保留元数据不可读，拒绝覆盖：' + basename(filePath))
  }
  if (state.kind !== 'corrupt') return
  if (state.identity === undefined || !preserveSafeCorruptAuthority(baseDir, filePath, state.identity)) {
    throw new Error('runtime 版本保留元数据不安全，拒绝覆盖：' + basename(filePath))
  }
}

function seedExplicitInstalls(baseDir: string, state: VersionTimestampMapState): Record<string, string> {
  if (state.kind === 'valid') return { ...state.versions }
  // With no retention ledger every runtime installation counts as a user action, so a
  // missing/corrupt/unreadable ledger preserves all existing trees.
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
  ensureRuntimeRootNoFollow(baseDir)
  const safe = assertSafeVersion(version)
  const validation = validateVersionTree(baseDir, safe, platform)
  if (!validation.ok) throw new Error(`不能保留无效运行时安装：${validation.error}`)
  if (Number.isNaN(now.getTime())) throw new Error('显式安装时间戳无效')
  const filePath = explicitInstallsPath(baseDir)
  const state = readVersionTimestampMap(filePath)
  assertTimestampMapWritable(baseDir, filePath, state)
  const versions = seedExplicitInstalls(baseDir, state)
  versions[safe] = now.toISOString()
  atomicWriteJson(baseDir, filePath, { versions })
}

/** Explicit cleanup opt-out: the tree is not removed here, but a later eviction may remove it
 *  if no current/known-good/pending/failure protection remains. */
export function forgetExplicitInstall(baseDir: string, version: string): void {
  ensureRuntimeRootNoFollow(baseDir)
  const safe = assertSafeVersion(version)
  const filePath = explicitInstallsPath(baseDir)
  const state = readVersionTimestampMap(filePath)
  assertTimestampMapWritable(baseDir, filePath, state)
  const versions = seedExplicitInstalls(baseDir, state)
  delete versions[safe]
  atomicWriteJson(baseDir, filePath, { versions })
}

function isExplicitInstall(baseDir: string, version: string): boolean {
  const state = readVersionTimestampMap(explicitInstallsPath(baseDir))
  if (state.kind !== 'valid') return listVersionTrees(baseDir).includes(version)
  return Object.prototype.hasOwnProperty.call(state.versions, version)
}

function knownGoodPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'known-good.json')
}

export type KnownGoodVersionsState =
  | { kind: 'ok'; versions: string[] }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'unknown'; detail: string }

/** Retention-facing known-good read: a corrupt or unreadable ledger returns an explicit reason
 *  instead of an empty list, so a prune decision can never read "unknown" as "no protection". */
export function listKnownGoodVersionsState(baseDir: string): KnownGoodVersionsState {
  const state = readVersionTimestampMap(knownGoodPath(baseDir))
  if (state.kind === 'missing') return { kind: 'ok', versions: [] }
  if (state.kind === 'corrupt') return { kind: 'corrupt', detail: 'known-good 元数据损坏' }
  if (state.kind === 'unknown') return { kind: 'unknown', detail: state.detail }
  return {
    kind: 'ok',
    versions: Object.entries(state.versions)
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      .map(([version]) => version),
  }
}

export function markKnownGood(
  baseDir: string,
  version: string,
  now = new Date(),
  platform = `${process.platform}-${process.arch}`,
): void {
  ensureRuntimeRootNoFollow(baseDir)
  const safe = assertSafeVersion(version)
  const validation = validateVersionTree(baseDir, safe, platform)
  if (!validation.ok) throw new Error(`不能标记无效运行时为 known-good：${validation.error}`)
  if (Number.isNaN(now.getTime())) throw new Error('known-good 时间戳无效')
  const filePath = knownGoodPath(baseDir)
  const state = readVersionTimestampMap(filePath)
  assertTimestampMapWritable(baseDir, filePath, state)
  const versions = state.kind === 'valid' ? { ...state.versions } : {}
  versions[safe] = now.toISOString()
  atomicWriteJson(baseDir, filePath, { versions })
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

export type RuntimeFailureState =
  | { kind: 'missing' | 'unsafe' }
  | { kind: 'corrupt'; identity: FileIdentity }
  | { kind: 'unknown'; detail: string }
  | { kind: 'valid'; record: RuntimeFailureRecord }

export function readRuntimeFailureState(baseDir: string, version: string): RuntimeFailureState {
  const safe = assertSafeVersion(version)
  const filePath = failurePath(baseDir, safe)
  const read = readAuthorityMetadata(filePath, 64 * 1024)
  if (read.kind === 'missing') return { kind: 'missing' }
  if (read.kind === 'corrupt') return { kind: 'unsafe' }
  if (read.kind === 'unknown') return { kind: 'unknown', detail: read.detail }
  let parsed: unknown
  try { parsed = JSON.parse(read.value.raw) } catch { parsed = null }
  const record = parseFailureRecord(parsed, safe)
  return record === null
    ? { kind: 'corrupt', identity: read.value.identity }
    : { kind: 'valid', record }
}

export function recordRuntimeFailure(baseDir: string, input: RuntimeFailureInput, now = new Date()): RuntimeFailureRecord {
  ensureRuntimeRootNoFollow(baseDir)
  const version = assertSafeVersion(input.version)
  if (!validFailurePhase(input.phase)) throw new Error('failure.phase 必须是安全的短横线标识符')
  const filePath = failurePath(baseDir, version)
  const previousState = readRuntimeFailureState(baseDir, version)
  if (previousState.kind === 'unknown') {
    throw new Error('runtime failure 元数据不可读，拒绝覆盖：' + basename(filePath))
  }
  if (previousState.kind === 'unsafe') {
    throw new Error('runtime failure 元数据不安全，拒绝覆盖：' + basename(filePath))
  }
  if (previousState.kind === 'corrupt'
    && !preserveSafeCorruptAuthority(baseDir, filePath, previousState.identity)) {
    throw new Error(`runtime failure 损坏元数据无法安全隔离，拒绝覆盖：${basename(filePath)}`)
  }
  const previous = previousState.kind === 'valid' ? previousState.record : null
  const timestamp = now.toISOString()
  const record: RuntimeFailureRecord = {
    version,
    phase: input.phase,
    firstFailedAt: previous?.firstFailedAt ?? timestamp,
    lastFailedAt: timestamp,
    occurrences: (previous?.occurrences ?? 0) + 1,
    error: sanitizeErrorText(input.error instanceof Error ? input.error.message : String(input.error), PROBE_TEXT_KEEP_TOKENS).slice(0, 2_000),
    restoreOutcome: input.restoreOutcome ?? null,
    snapshotName: input.snapshotPath ? basename(input.snapshotPath) : null,
  }
  atomicWriteJson(baseDir, filePath, record)
  return record
}

export type RuntimeFailuresState =
  | { kind: 'ok'; failures: RuntimeFailureRecord[] }
  | { kind: 'unknown'; detail: string }

/** Failure-set material: a non-ENOENT readdir error or an unreadable record makes the whole set
 *  unknowable, never an empty list; corrupt records keep the quarantine-and-skip behavior. */
export function listRuntimeFailuresState(baseDir: string): RuntimeFailuresState {
  const dir = join(runtimeDirPath(baseDir), 'failures')
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'ok', failures: [] }
    return { kind: 'unknown', detail: 'runtime failures 目录不可读：' + String((error as NodeJS.ErrnoException).code ?? 'unknown') }
  }
  const records: RuntimeFailureRecord[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const version = entry.name.slice(0, -'.json'.length)
    if (!isSafeVersion(version)) continue
    const filePath = failurePath(baseDir, version)
    const state = readRuntimeFailureState(baseDir, version)
    if (state.kind === 'unknown') return { kind: 'unknown', detail: state.detail }
    if (state.kind === 'corrupt') {
      preserveSafeCorruptAuthority(baseDir, filePath, state.identity)
      continue
    }
    if (state.kind === 'valid') records.push(state.record)
  }
  return {
    kind: 'ok',
    failures: records.sort((a, b) => Date.parse(b.lastFailedAt) - Date.parse(a.lastFailedAt)),
  }
}

/** Compatibility list projection; an unknown set is empty only here. */
export function listRuntimeFailures(baseDir: string): RuntimeFailureRecord[] {
  const state = listRuntimeFailuresState(baseDir)
  return state.kind === 'ok' ? state.failures : []
}

export function runtimeFailureSummary(baseDir: string): RuntimeFailureSummary {
  const state = listRuntimeFailuresState(baseDir)
  if (state.kind === 'unknown') {
    return { kind: 'unknown', count: null, latest: null, detail: state.detail }
  }
  return { kind: 'ok', count: state.failures.length, latest: state.failures[0] ?? null, detail: null }
}

/** Fail-closed facts for snapshot pruning: every snapshot referenced by recovery/failure metadata
 *  counts, and any unknowable protection class returns corrupt. */
export function runtimeSnapshotRetentionState(baseDir: string): RuntimeSnapshotRetentionState {
  const pointer = readCurrentPointerState(baseDir)
  const override = readOverrideState(baseDir)
  const activation = readActivationJournalState(baseDir)
  const knownGood = readVersionTimestampMap(knownGoodPath(baseDir))
  if (pointer.kind === 'unknown') return { kind: 'unknown', detail: pointer.detail }
  if (override.kind === 'unknown') return { kind: 'unknown', detail: override.detail }
  if (knownGood.kind === 'unknown') return { kind: 'unknown', detail: knownGood.detail }
  if (pointer.kind === 'corrupt'
    || override.kind === 'corrupt'
    || activation.kind === 'corrupt'
    || knownGood.kind === 'corrupt') {
    return { kind: 'corrupt', detail: 'runtime 保留元数据损坏；拒绝 prune' }
  }

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
  try {
    failureEntries = readdirSync(failureDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { kind: 'unknown', detail: 'runtime failures 目录不可读；拒绝 prune' }
    }
  }
  if (failureEntries.some((name) => name.includes('.json.corrupt'))) {
    return { kind: 'corrupt', detail: 'failure evidence 已损坏；拒绝 prune' }
  }
  for (const name of failureEntries) {
    if (!name.endsWith('.json')) continue
    const version = name.slice(0, -'.json'.length)
    if (!isSafeVersion(version)) return { kind: 'corrupt', detail: 'failure evidence 名称非法；拒绝 prune' }
    const failureState = readRuntimeFailureState(baseDir, version)
    if (failureState.kind === 'unknown') return { kind: 'unknown', detail: failureState.detail }
    if (failureState.kind !== 'valid') {
      return { kind: 'corrupt', detail: 'failure evidence 损坏；拒绝 prune' }
    }
    protectedVersions.add(failureState.record.version)
    if (failureState.record.snapshotName !== null) protectedSnapshotNames.add(failureState.record.snapshotName)
  }
  return {
    kind: 'valid',
    protectedVersions: [...protectedVersions].sort(),
    protectedSnapshotNames: [...protectedSnapshotNames].sort(),
  }
}

export function clearRuntimeFailure(baseDir: string, version: string): void {
  removeRuntimeFileNoFollow(baseDir, failurePath(baseDir, version))
}

function isKnownGoodProtected(baseDir: string, version: string): boolean {
  const state = readVersionTimestampMap(knownGoodPath(baseDir))
  // Corruption or an unreadable ledger makes the protected set unknowable: preserve all trees
  // rather than evicting a possibly protected version.
  return state.kind === 'corrupt' || state.kind === 'unknown'
    || (state.kind === 'valid' && Object.prototype.hasOwnProperty.call(state.versions, version))
}

function isKnownGoodCandidateProtected(baseDir: string, version: string): boolean {
  const filePath = join(runtimeDirPath(baseDir), 'known-good-candidates.json')
  const read = readAuthorityMetadata(filePath, 256 * 1024)
  if (read.kind === 'missing') return false
  // Corrupt or unreadable candidate evidence makes the set unknowable: keep every possibly
  // candidate-referenced tree.
  if (read.kind !== 'present') return true
  let parsed: unknown
  try { parsed = JSON.parse(read.value.raw) } catch { return true }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true
  const versions = (parsed as Record<string, unknown>).versions
  if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) return true
  return Object.prototype.hasOwnProperty.call(versions, version)
}

function hasFailureEvidence(baseDir: string, version: string): boolean {
  const prefix = `${version}.json`
  const failureDir = join(runtimeDirPath(baseDir), 'failures')
  try {
    const info = lstatSync(failureDir)
    // A symlink/non-directory is not an empty evidence set: treat the whole protection class as
    // unknowable so cleanup and eviction keep every possibly referenced runtime tree.
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
  // Corrupt recovery metadata makes its protected set unknowable: never evict a possibly unique
  // source/target/rollback tree in that state.
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
  // unknown is as protective as corrupt: bytes never proven absent/illegal must not be deleted.
  if (pointer.kind === 'corrupt' || pointer.kind === 'unknown') return true
  if (pointer.kind === 'valid' && pointer.version === version) return true
  if (isKnownGoodProtected(baseDir, version)) return true
  if (isKnownGoodCandidateProtected(baseDir, version)) return true
  const override = readOverrideState(baseDir)
  if (override.kind === 'corrupt' || override.kind === 'unknown') return true
  if (override.kind === 'valid'
    && (override.record.pending === version
      || override.record.chosenVersion === version
      || override.record.resolvedVersion === version)) return true
  if (hasFailureEvidence(baseDir, version)) return true
  if (existsSync(join(runtimeDir, `${version}.failed`))) return true
  if (options.ignoreExplicitInstall !== true && isExplicitInstall(baseDir, version)) return true
  return false
}

/** User-authorized cleanup of one explicitly retained tree: every recovery, active, pending,
 *  known-good, candidate and failure protection is re-read at the deletion point; a protected tree
 *  is left byte-for-byte intact and keeps its retention record, and a removal failure never drops it. */
export function cleanupExplicitRuntimeVersion(
  baseDir: string,
  version: string,
): ExplicitRuntimeCleanupResult {
  ensureRuntimeRootNoFollow(baseDir)
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
  if (exists) {
    markStorePruneNeeded(baseDir, `explicit-cleanup:${safe}`)
    // Removing a hard-linked tree orphans its package cache entries; ask the store prune to also
    // reclaim the private .pnpm-cache/.xdg-cache content.
    markStorePruneNeeded(baseDir, 'cache-reclaim')
  }
  return { removed: exists, retentionCleared: true, stillProtected: false }
}

function storePruneMarkerPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'store-prune-needed.json')
}

export function readStorePruneRequest(baseDir: string): StorePruneRequest | null {
  const read = readAuthorityMetadata(storePruneMarkerPath(baseDir), 64 * 1024)
  if (read.kind !== 'present') return null
  let parsed: unknown
  try { parsed = JSON.parse(read.value.raw) } catch { return null }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const rec = parsed as Record<string, unknown>
  if (typeof rec.requestedAt !== 'string' || !Array.isArray(rec.reasons) || !rec.reasons.every((v) => typeof v === 'string')) return null
  return { requestedAt: rec.requestedAt, reasons: rec.reasons as string[] }
}

export function markStorePruneNeeded(baseDir: string, reason: string): void {
  ensureRuntimeRootNoFollow(baseDir)
  const previous = readStorePruneRequest(baseDir)
  const reasons = Array.from(new Set([...(previous?.reasons ?? []), reason])).slice(-20)
  atomicWriteJson(baseDir, storePruneMarkerPath(baseDir), { requestedAt: new Date().toISOString(), reasons })
}

export function clearStorePruneRequest(baseDir: string): void {
  removeRuntimeFileNoFollow(baseDir, storePruneMarkerPath(baseDir))
}

function versionTreeMtimeMs(baseDir: string, version: string): number {
  try { return statSync(join(runtimeDirPath(baseDir), version)).mtimeMs } catch { return 0 }
}

/** Evict only unprotected automatic cache trees, oldest first. */
export function evictVersions(baseDir: string, keep = 3): string[] {
  ensureRuntimeRootNoFollow(baseDir)
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
  if (evicted.length > 0) {
    markStorePruneNeeded(baseDir, `evicted:${evicted.join(',')}`)
    // Evicted hard-linked trees orphan package cache entries the same way explicit cleanup does;
    // recycle the private caches after the prune.
    markStorePruneNeeded(baseDir, 'cache-reclaim')
  }
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

/** Read the installer's work-dir lifecycle marker (see runtime-installer.ts). Null when
 *  absent/corrupt is deliberately NOT reclaimable — legacy residue keeps the fail-closed block;
 *  a symlinked marker is never read. */
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
  ensureRuntimeRootNoFollow(baseDir)
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
      // A crash between mkdir(workDir) and any install input is a proven pre-spawn scene and is
      // reclaimable; once content exists a hard crash may have landed between spawn() and the PID
      // write, so evidence is not erased.
      if (pidEvidence === 'missing' && entries.length === 0) {
        rmSync(workDir, { recursive: true, force: true })
        removed.push(entry.name)
        continue
      }
      // The installer persists a `state` marker as its FIRST work-dir file: 'preparing'/'failed'
      // proves no child ever existed, so a crash during the download window must be reclaimable or
      // startup blocks forever; 'spawning'/'spawned'/missing/corrupt markers stay fail-closed.
      const workState = readWorkStateMarker(workDir)
      if (workState === 'preparing' || workState === 'failed') {
        rmSync(workDir, { recursive: true, force: true })
        removed.push(entry.name)
        continue
      }
      throw new Error(`运行时安装现场的 PID/PGID 证据${pidEvidence === 'missing' ? '缺失' : '损坏'}（${entry.name}）；拒绝清理并阻止启动`)
    }
    if (pid !== null && (isPidAlive(pid, true) || isPidAlive(pid))) {
      // A hard-crashed installer may leave a lifecycle descendant after the group leader exits:
      // never delete evidence while the PID or PGID is live.
      throw new Error(`运行时安装现场仍有活动写进程（pid/pgid ${pid}）；拒绝清理并阻止启动`)
    }
    rmSync(workDir, { recursive: true, force: true })
    removed.push(entry.name)
  }
  if (removed.length > 0) markStorePruneNeeded(baseDir, `stale-work:${removed.length}`)
  return removed
}

function isRuntimePublishBackupName(name: string): boolean {
  const match = PUBLISH_BACKUP_NAME.exec(name)
  if (!match) return false
  const version = match[1]
  // Installer-owned backups use the exact, untrimmed version path component; the
  // safe-version predicate keeps lookalike/traversal names out while allowing prereleases.
  return version === version.trim() && isSafeVersion(version)
}

/** Logical runtime disk soft-limit (10 GiB) — shared single source. Both owners
 *  project it as `diskLimitBytes` and gate installs against it; alias exports keep
 *  their public constant names. */
export const RUNTIME_LOGICAL_DISK_LIMIT_BYTES = 10 * 1024 ** 3

/* ============================================================================
 * 磁盘核算：异步分批单遍遍历 + 节流/单飞/终态一次
 *
 * 每个 runtime 根只遍历一遍。类别字段逐路径求和；unclassifiedBytes 在未分类
 * 残渣内去重；totalBytes 跨 runtime 根与 dsh-home.old* 备份共享 identity 集
 * （硬链接字节只计一次）。按 yieldEvery 个节点一批让渡事件循环，超大 store
 * 不冻结 owner；调用方经 coalesced-refresh.ts 叠加节流/单飞/终态一次。
 *
 * 并发残差：嵌套 ENOENT 抛错而非静默低估；非目录 dirent 归 unclassified；
 * 重复目录 inode 逐节点查重（和值恒等，仅多余遍历代价）。
 * ========================================================================== */

export interface RuntimeDiskWalkOptions {
  /** 每处理这么多节点让渡一次事件循环（默认 512）。 */
  yieldEvery?: number
  /** 测试专用进度钩子（已访问节点数）；生产不传。 */
  onVisited?: (visited: number) => void
}

type AsyncWalkTarget =
  | 'versionTree' | 'store' | 'cache' | 'installHome' | 'xdgCache'
  | 'work' | 'failure' | 'snapshot' | 'preRollback' | 'restoreBackup'
  | 'unclassified' | 'none'

interface AsyncDiskAcc {
  versionTreeBytes: number
  storeBytes: number
  cacheBytes: number
  installHomeBytes: number
  xdgCacheBytes: number
  workBytes: number
  failureBytes: number
  snapshotBytes: number
  preRollbackBytes: number
  restoreBackupBytes: number
  unclassifiedBytes: number
  totalBytes: number
  /** totalBytes 的共享 identity 集（遍历顺序 = runtimeEntries 后 restore 备份）。 */
  totalSeen: Set<string>
  /** unclassifiedBytes 的独立 identity 集（仅未分类根之间去重）。 */
  unclassSeen: Set<string>
  visited: number
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function chargeNodeAsync(
  path: string,
  target: AsyncWalkTarget,
  rootMissingIsZero: boolean,
  acc: AsyncDiskAcc,
  opts: Required<Pick<RuntimeDiskWalkOptions, 'yieldEvery' | 'onVisited'>>,
): Promise<void> {
  let info
  try {
    info = await lstatP(path)
  } catch (error) {
    // 根级 ENOENT = 该根不存在；其余（含并发删除的嵌套 ENOENT）一律抛错——绝不静默计 0。
    if (rootMissingIsZero && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  acc.visited += 1
  if (acc.visited % opts.yieldEvery === 0) {
    opts.onVisited?.(acc.visited)
    await yieldToEventLoop()
  }
  const key = `${info.dev}:${info.ino}`
  // 类别逐路径求和：每处出现都计；去重只作用于 unclassified/total identity 集。
  switch (target) {
    case 'versionTree': acc.versionTreeBytes += info.size; break
    case 'store': acc.storeBytes += info.size; break
    case 'cache': acc.cacheBytes += info.size; break
    case 'installHome': acc.installHomeBytes += info.size; break
    case 'xdgCache': acc.xdgCacheBytes += info.size; break
    case 'work': acc.workBytes += info.size; break
    case 'failure': acc.failureBytes += info.size; break
    case 'snapshot': acc.snapshotBytes += info.size; break
    case 'preRollback': acc.preRollbackBytes += info.size; break
    case 'restoreBackup': acc.restoreBackupBytes += info.size; break
    default: break // 'unclassified' / 'none' 无逐路径类别和
  }
  if (target === 'unclassified' && !acc.unclassSeen.has(key)) {
    acc.unclassSeen.add(key)
    acc.unclassifiedBytes += info.size
  }
  if (!acc.totalSeen.has(key)) {
    acc.totalSeen.add(key)
    acc.totalBytes += info.size
  }
  if (!info.isDirectory()) return
  // readdir 竞态（lstat 与 readdir 之间目录消失）让错误直接向上传播：绝不静默计 0。
  const names = await readdirP(path)
  for (const name of names) {
    await chargeNodeAsync(join(path, name), target, false, acc, opts)
  }
}

/** runtimeEntries 顶层条目 → 会计类别规则表。单一来源：known 判定与分类共用同一
 *  有序规则（声明序首个命中；无命中 = unclassified 残渣），新增类别只改这一处，
 *  杜绝「谓词认了而 switch 漏分类」的双份维护陷阱。 */
const ENTRY_TARGET_RULES: ReadonlyArray<{
  test: (name: string, isDirectory: boolean, treeSet: Set<string>) => boolean
  target: AsyncWalkTarget
}> = [
  { test: (name, isDirectory, treeSet) => treeSet.has(name) && isDirectory, target: 'versionTree' },
  { test: (name, isDirectory) => isDirectory && name.startsWith('.work-'), target: 'work' },
  { test: (name, isDirectory) => isDirectory && name.endsWith('.failed'), target: 'failure' },
  { test: name => isRuntimePublishBackupName(name), target: 'failure' },
  {
    test: name => name === 'failures' || name === 'metadata-recovery-data'
      || name === 'metadata-recovery-rescue-data' || name === 'metadata-recovery.json',
    target: 'failure',
  },
  { test: name => name === '.pnpm-store', target: 'store' },
  { test: name => name === '.pnpm-cache', target: 'cache' },
  { test: name => name === '.install-home', target: 'installHome' },
  { test: name => name === '.xdg-cache', target: 'xdgCache' },
  { test: name => name === 'snapshots', target: 'snapshot' },
  { test: name => name === 'pre-rollback', target: 'preRollback' },
]

/** runtimeEntries 顶层条目 → 会计类别（规则表驱动的唯一分类来源）。 */
function asyncTargetForEntry(name: string, isDirectory: boolean, treeSet: Set<string>): AsyncWalkTarget {
  for (const rule of ENTRY_TARGET_RULES) {
    if (rule.test(name, isDirectory, treeSet)) return rule.target
  }
  return 'unclassified'
}

/** 异步单遍磁盘统计——唯一的磁盘核算实现。会计契约与并发残差见上方段注释。 */
export async function runtimeDiskSummaryAsync(
  baseDir: string,
  dshHome: string = join(baseDir, 'state', 'dsh-home'),
  options: RuntimeDiskWalkOptions = {},
): Promise<RuntimeDiskSummary> {
  const opts = {
    // yieldEvery ≤0 会让 visited % yieldEvery 恒为 NaN 而永不让渡（静默退化为阻塞遍历），钳制到 ≥1。
    yieldEvery: Math.max(1, Math.floor(options.yieldEvery ?? 512)),
    onVisited: options.onVisited ?? (() => undefined),
  }
  const runtime = runtimeDirPath(baseDir)
  const trees = listVersionTrees(baseDir)
  const treeSet = new Set(trees)
  const acc: AsyncDiskAcc = {
    versionTreeBytes: 0, storeBytes: 0, cacheBytes: 0, installHomeBytes: 0,
    xdgCacheBytes: 0, workBytes: 0, failureBytes: 0, snapshotBytes: 0,
    preRollbackBytes: 0, restoreBackupBytes: 0, unclassifiedBytes: 0,
    totalBytes: 0,
    totalSeen: new Set(),
    unclassSeen: new Set(),
    visited: 0,
  }
  // restore 备份发现（与同步版相同）：dshHomeParent 下 dsh-home.old* 目录。
  const dshHomeParent = dirname(dshHome)
  const dshHomeName = basename(dshHome)
  let runtimeEntries: Array<{ name: string; isDirectory: boolean }>
  try {
    runtimeEntries = (await readdirP(runtime, { withFileTypes: true }))
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') runtimeEntries = []
    else throw error
  }
  let restoreBackups: string[] = []
  try {
    restoreBackups = (await readdirP(dshHomeParent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()
        && (entry.name === `${dshHomeName}.old` || entry.name.startsWith(`${dshHomeName}.old-`)))
      .map((entry) => join(dshHomeParent, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // 单遍主循环：runtimeEntries（readdir 顺序）→ restore 备份；根级缺失为 0，嵌套并发删除向上抛。
  for (const entry of runtimeEntries) {
    await chargeNodeAsync(
      join(runtime, entry.name),
      asyncTargetForEntry(entry.name, entry.isDirectory, treeSet),
      true,
      acc,
      opts,
    )
  }
  for (const backup of restoreBackups) {
    // backup 已是绝对路径；path.join 对绝对第二参是拼接而非重定基，绝不能再次 join。
    await chargeNodeAsync(backup, 'restoreBackup', true, acc, opts)
  }
  return {
    versionTrees: trees.length,
    versionTreeBytes: acc.versionTreeBytes,
    storeBytes: acc.storeBytes,
    cacheBytes: acc.cacheBytes,
    installHomeBytes: acc.installHomeBytes,
    xdgCacheBytes: acc.xdgCacheBytes,
    workBytes: acc.workBytes,
    failureBytes: acc.failureBytes,
    snapshotBytes: acc.snapshotBytes,
    preRollbackBytes: acc.preRollbackBytes,
    restoreBackupBytes: acc.restoreBackupBytes,
    unclassifiedBytes: acc.unclassifiedBytes,
    totalBytes: acc.totalBytes,
    storePruneNeeded: existsSync(storePruneMarkerPath(baseDir)),
  }
}
