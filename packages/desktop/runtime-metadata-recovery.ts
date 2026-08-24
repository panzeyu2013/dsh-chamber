/**
 * Design 18 corrupt runtime-selection metadata recovery.
 *
 * This module is deliberately Electron/IPC free. The only path inputs are the
 * main-process-owned userData base directory and DSH_HOME; evidence and stash
 * paths are derived below and are never accepted from a renderer payload.
 *
 * Recovery is a durable, one-way transaction:
 *   stop writers -> complete an older restore -> copy/publish DSH_HOME stash
 *   -> rename every selection-metadata byte into evidence -> probe builtin
 *   -> finalize the marker.
 *
 * A published stash is the hard gate for metadata archival. Every phase and
 * evidence rename is restartable; probe failure leaves the marker, stash, and
 * evidence intact for a later retry.
 */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  activationJournalPath,
  currentPointerPath,
  overridePath,
  readActivationJournalState,
  readCurrentPointerState,
  readOverrideState,
  type ActivationJournalState,
  type CurrentPointerState,
  type OverrideState,
} from './dsh-runtime-store.ts'
import { sanitizeErrorText } from './sanitize-error.ts'
import { assertSafeVersion, isSafeVersion } from './version-safety.ts'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const RECOVERY_SCHEMA_VERSION = 1
const RECOVERY_MARKER = 'metadata-recovery.json'
const RECOVERY_DATA_DIR = 'metadata-recovery-data'
const RECOVERY_RESCUE_DATA_DIR = 'metadata-recovery-rescue-data'
const PRIOR_RECOVERY_MARKER_EVIDENCE = 'metadata-recovery.json.prior-corrupt'
/**
 * The snapshot restore marker (`dsh-runtime/restore-in-progress`) is
 * independently authoritative for DSH_HOME transactions. When a restore is
 * permanently stuck ('incomplete' — the journaled snapshot is missing or
 * untrustworthy), the metadata-recovery transaction archives the marker as
 * opaque evidence so the escape can complete; a retryable 'half' restore
 * still blocks metadata recovery before anything is archived.
 */
const RESTORE_MARKER_EVIDENCE = 'restore-in-progress'
const MAX_RECOVERY_MARKER_PARSE_BYTES = 1024 * 1024
const STASH_TMP_DIR = '.dsh-home.stash.tmp'
const STASH_DIR = 'dsh-home.stash'
const STASH_READY = 'stash-ready.json'
const EVIDENCE_DIR = 'evidence'
const FINALIZED_RECEIPT = 'finalized.json'
const RECOVERY_ID = /^\d{13}-[0-9a-f]{16}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const METADATA_BASENAMES = Object.freeze([
  'current',
  'override.json',
  'activation-journal.json',
] as const)

export type RuntimeMetadataRecoveryPhase =
  | 'stashing'
  | 'archiving'
  | 'probe-required'
  | 'finalized'

export type RuntimeMetadataRecoveryStorageKind = 'default' | 'marker-rescue'

export interface PriorRecoveryMarkerEvidence {
  /** Fixed, core-owned basename; callers never supply an evidence path. */
  name: typeof PRIOR_RECOVERY_MARKER_EVIDENCE
  byteLength: number
  sha256: string
}

export interface RuntimeMetadataRecoveryRecord {
  schemaVersion: 1
  /** Generated internally; basename only. */
  id: string
  phase: RuntimeMetadataRecoveryPhase
  /** Selects a core-owned transaction namespace. Old records omit this on disk
   * and are normalized to `default` by the parser. */
  storageKind: RuntimeMetadataRecoveryStorageKind
  builtinVersion: string
  /** Hash of the canonical main-process-owned DSH_HOME path; never the path. */
  dshHomePathHash: string
  /** Missing DSH_HOME is a real, recoverable initial state; its stash is an
   * intentionally empty, completion-marked directory rather than no stash. */
  dshHomeWasMissing: boolean
  /** Basenames only; immutable after transaction creation. */
  evidenceFiles: string[]
  /** Basenames already observed in the evidence directory. */
  archivedEvidence: string[]
  /** Present only for an explicit second-order corrupt-marker rescue. */
  priorRecoveryMarker: PriorRecoveryMarkerEvidence | null
  probeAttempts: number
  startedAt: string
  updatedAt: string
  lastProbeAt: string | null
  lastProbeError: string | null
  finalizedAt: string | null
}

export type RuntimeMetadataRecoveryState =
  | { kind: 'missing' }
  | { kind: 'corrupt'; error: string }
  | { kind: 'valid'; record: RuntimeMetadataRecoveryRecord }

export type RuntimeMetadataHealthStatus =
  | 'healthy'
  | 'selection-corrupt'
  | 'recovery-in-progress'
  | 'recovery-finalized'
  | 'recovery-marker-corrupt'

export interface RuntimeMetadataHealth {
  status: RuntimeMetadataHealthStatus
  current: CurrentPointerState
  override: OverrideState
  activationJournal: ActivationJournalState
  /** Corruption-evidence basenames only; no absolute path leaves this core. */
  corruptEvidence: string[]
  recovery: RuntimeMetadataRecoveryState
}

export type RuntimeMetadataRecoveryCheckpoint =
  | 'stashing'
  | 'archiving'
  | `evidence:${string}`
  | 'probe-required'
  | 'probe-failed'
  | 'marker-rescue-committed'
  | 'finalized'

export type RuntimeMetadataRecoveryRenameKind =
  | 'marker-write'
  | 'marker-rescue-commit'
  | 'stash-publish'
  | 'evidence'
  | 'opaque-marker-publish'
  | 'receipt-write'

/** Fault-injection seam used by node:test; production callers omit it. */
export interface RuntimeMetadataRecoveryOperations {
  copyFile: (
    source: string,
    destination: string,
    constraint: RuntimeMetadataRecoveryCopyConstraint,
  ) => void
  renamePath: (
    source: string,
    destination: string,
    kind: RuntimeMetadataRecoveryRenameKind,
  ) => void
  now: () => Date
  randomHex: () => string
  afterCheckpoint: (
    checkpoint: RuntimeMetadataRecoveryCheckpoint,
    record: RuntimeMetadataRecoveryRecord,
  ) => void
}

export interface ResumeRuntimeMetadataRecoveryOptions {
  baseDir: string
  dshHome: string
  builtinVersion: string
  operations?: Partial<RuntimeMetadataRecoveryOperations>
}

export type ResumeRuntimeMetadataRecoveryResult =
  | { phase: 'not-needed'; record: null }
  | { phase: 'probe-required'; record: RuntimeMetadataRecoveryRecord }
  | { phase: 'finalized'; record: RuntimeMetadataRecoveryRecord }

export type CorruptMetadataRecoveryMarkerCapability =
  | {
    recoverable: true
    /** Opaque marker facts only; no path or content leaves this core. */
    byteLength: number
    sha256: string
  }
  | {
    recoverable: false
    reason: 'marker-missing' | 'marker-valid' | 'marker-unsafe' | 'marker-unreadable'
  }

export type RuntimeMetadataRestoreOutcome = 'none' | 'complete' | 'half' | 'incomplete'

export type RuntimeMetadataProbeOutcome =
  | { ok: true }
  | { ok: false; error: string }

export interface RecoverRuntimeMetadataOptions extends ResumeRuntimeMetadataRecoveryOptions {
  /** Must stop the local host and prove all managed writer processes exited. */
  stopHost: () => Promise<void>
  /** Completes a pre-existing snapshot restore before this transaction stashes data. */
  completeRestore: () => Promise<RuntimeMetadataRestoreOutcome>
  /** Starts/probes the exact builtinVersion while public exposure remains gated. */
  probeBuiltin: () => Promise<RuntimeMetadataProbeOutcome>
}

export type RecoverRuntimeMetadataResult =
  | {
    status: 'not-needed'
    phase: 'not-needed'
    record: null
    restoreOutcome: 'none'
    error: null
  }
  | {
    status: 'already-finalized'
    phase: 'finalized'
    record: RuntimeMetadataRecoveryRecord
    restoreOutcome: 'none' | 'complete' | 'incomplete'
    error: null
  }
  | {
    status: 'restore-blocked'
    phase: 'restore-blocked'
    record: RuntimeMetadataRecoveryRecord | null
    restoreOutcome: 'half' | 'incomplete'
    error: string
  }
  | {
    status: 'probe-failed'
    phase: 'probe-required'
    record: RuntimeMetadataRecoveryRecord
    restoreOutcome: 'none' | 'complete' | 'incomplete'
    error: string
  }
  | {
    status: 'finalized'
    phase: 'finalized'
    record: RuntimeMetadataRecoveryRecord
    restoreOutcome: 'none' | 'complete' | 'incomplete'
    error: null
  }

interface RecoveryPaths {
  runtimeDir: string
  marker: string
  dataRoot: string
  transactionDir: string
  stashTmp: string
  stash: string
  stashReady: string
  evidence: string
  finalizedReceipt: string
}

interface StashReadyRecord {
  schemaVersion: 1
  recoveryId: string
  dshHomePathHash: string
}

interface FileFingerprint {
  byteLength: number
  sha256: string
  device: number
  inode: number
  linkCount: number
  modifiedMs: number
  changedMs: number
}

export interface RuntimeMetadataRecoveryCopyConstraint {
  /** Main-process-owned root used only by the internal fault-injection seam. */
  sourceRoot: string
  sourceRootDevice: number
  sourceRootInode: number
  sourceDevice: number
  sourceInode: number
  sourceByteLength: number
  sourceModifiedMs: number
  sourceChangedMs: number
}

interface SourceTreeIdentity {
  kind: 'file' | 'directory' | 'symlink'
  device: number
  inode: number
  linkCount: number
  byteLength: number
  modifiedMs: number
  changedMs: number
  linkTarget: string | null
  children: string[] | null
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === ''
    || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

function assertContained(root: string, candidate: string, label: string): void {
  if (!isContained(root, candidate)) throw new Error(`${label} escaped its recovery root`)
}

function normalizeOwnedPath(input: string, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0') || !isAbsolute(input)) {
    throw new Error(`${label} must be an absolute, NUL-free main-process path`)
  }
  if (input.split(/[\\/]+/).includes('..')) throw new Error(`${label} must not contain parent traversal`)
  return resolve(input)
}

function assertSafeBasename(value: string, label: string): void {
  if (value.length === 0
    || value.length > 255
    || value.includes('\0')
    || value.includes('/')
    || value.includes('\\')
    || basename(value) !== value
    || value === '.'
    || value === '..') {
    throw new Error(`${label} is not a safe basename`)
  }
}

function isSelectionEvidenceBasename(name: string): boolean {
  try { assertSafeBasename(name, 'metadata evidence') } catch { return false }
  return METADATA_BASENAMES.some(base => name === base || name.startsWith(`${base}.corrupt`))
}

function isEvidenceBasename(name: string): boolean {
  return name === PRIOR_RECOVERY_MARKER_EVIDENCE
    || name === RESTORE_MARKER_EVIDENCE
    || isSelectionEvidenceBasename(name)
}

function assertRecoveryId(id: string): string {
  assertSafeBasename(id, 'metadata recovery id')
  if (!RECOVERY_ID.test(id)) throw new Error('metadata recovery id has an invalid shape')
  return id
}

function assertExistingRealDirectory(path: string, label: string): void {
  let info
  try { info = lstatSync(path) } catch { throw new Error(`${label} does not exist or is unreadable`) }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`)
}

function ensurePrivateDirectory(path: string, parentRoot: string): void {
  assertContained(parentRoot, path, 'private recovery directory')
  if (existsSync(path)) {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`private recovery path is not a real directory: ${basename(path)}`)
    }
  } else {
    mkdirSync(path, { mode: PRIVATE_DIR_MODE })
  }
  chmodSync(path, PRIVATE_DIR_MODE)
}

function fsyncRegularFileNoFollow(path: string, label: string): void {
  const pathInfo = lstatSync(path)
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1) {
    throw new Error(`${label} is not a uniquely linked real file`)
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow)
    const info = fstatSync(descriptor)
    if (!info.isFile()
      || info.nlink !== 1
      || info.dev !== pathInfo.dev
      || info.ino !== pathInfo.ino) {
      throw new Error(`${label} identity changed before sync`)
    }
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function fsyncRealDirectory(path: string, label: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a real directory`)
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const directoryOnly = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow | directoryOnly)
    const opened = fstatSync(descriptor)
    if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error(`${label} identity changed before sync`)
    }
    try {
      fsyncSync(descriptor)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || (code !== 'EINVAL' && code !== 'ENOTSUP')) throw error
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function recoveryRootPaths(
  baseDirInput: string,
  storageKind: RuntimeMetadataRecoveryStorageKind = 'default',
): Pick<RecoveryPaths, 'runtimeDir' | 'marker' | 'dataRoot'> {
  const baseDir = normalizeOwnedPath(baseDirInput, 'baseDir')
  assertExistingRealDirectory(baseDir, 'baseDir')
  const runtimeDir = join(baseDir, 'dsh-runtime')
  assertContained(baseDir, runtimeDir, 'runtime directory')
  if (existsSync(runtimeDir)) assertExistingRealDirectory(runtimeDir, 'runtime directory')
  return {
    runtimeDir,
    marker: join(runtimeDir, RECOVERY_MARKER),
    dataRoot: join(
      runtimeDir,
      storageKind === 'marker-rescue' ? RECOVERY_RESCUE_DATA_DIR : RECOVERY_DATA_DIR,
    ),
  }
}

function recoveryPaths(
  baseDirInput: string,
  id: string,
  storageKind: RuntimeMetadataRecoveryStorageKind = 'default',
): RecoveryPaths {
  const roots = recoveryRootPaths(baseDirInput, storageKind)
  const safeId = assertRecoveryId(id)
  const transactionDir = join(roots.dataRoot, safeId)
  const paths: RecoveryPaths = {
    ...roots,
    transactionDir,
    stashTmp: join(transactionDir, STASH_TMP_DIR),
    stash: join(transactionDir, STASH_DIR),
    stashReady: join(transactionDir, STASH_READY),
    evidence: join(transactionDir, EVIDENCE_DIR),
    finalizedReceipt: join(transactionDir, FINALIZED_RECEIPT),
  }
  for (const candidate of Object.values(paths)) {
    if (candidate !== roots.runtimeDir) assertContained(roots.runtimeDir, candidate, 'metadata recovery path')
  }
  return paths
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function parseStringArray(value: unknown, label: string): string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !isEvidenceBasename(entry)) return null
    result.push(entry)
  }
  const sorted = [...new Set(result)].sort()
  if (!arraysEqual(result, sorted)) return null
  if (label === 'evidenceFiles' && result.length === 0) return null
  return result
}

function parseRecoveryRecord(value: unknown): RuntimeMetadataRecoveryRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== RECOVERY_SCHEMA_VERSION) return null
  if (typeof record.id !== 'string' || !RECOVERY_ID.test(record.id) || basename(record.id) !== record.id) return null
  if (record.phase !== 'stashing'
    && record.phase !== 'archiving'
    && record.phase !== 'probe-required'
    && record.phase !== 'finalized') return null
  if (record.storageKind !== undefined
    && record.storageKind !== 'default'
    && record.storageKind !== 'marker-rescue') return null
  const storageKind: RuntimeMetadataRecoveryStorageKind = record.storageKind === 'marker-rescue'
    ? 'marker-rescue'
    : 'default'
  if (typeof record.builtinVersion !== 'string' || !isSafeVersion(record.builtinVersion)) return null
  if (typeof record.dshHomePathHash !== 'string' || !SHA256_HEX.test(record.dshHomePathHash)) return null
  if (typeof record.dshHomeWasMissing !== 'boolean') return null
  const evidenceFiles = parseStringArray(record.evidenceFiles, 'evidenceFiles')
  const archivedEvidence = parseStringArray(record.archivedEvidence, 'archivedEvidence')
  if (evidenceFiles === null || archivedEvidence === null) return null
  if (!archivedEvidence.every(name => evidenceFiles.includes(name))) return null
  let priorRecoveryMarker: PriorRecoveryMarkerEvidence | null = null
  if (record.priorRecoveryMarker !== undefined && record.priorRecoveryMarker !== null) {
    if (typeof record.priorRecoveryMarker !== 'object' || Array.isArray(record.priorRecoveryMarker)) return null
    const prior = record.priorRecoveryMarker as Record<string, unknown>
    if (prior.name !== PRIOR_RECOVERY_MARKER_EVIDENCE
      || !Number.isSafeInteger(prior.byteLength)
      || (prior.byteLength as number) < 0
      || typeof prior.sha256 !== 'string'
      || !SHA256_HEX.test(prior.sha256)) return null
    priorRecoveryMarker = {
      name: PRIOR_RECOVERY_MARKER_EVIDENCE,
      byteLength: prior.byteLength as number,
      sha256: prior.sha256,
    }
  }
  if (storageKind === 'marker-rescue') {
    if (priorRecoveryMarker === null
      || !evidenceFiles.includes(PRIOR_RECOVERY_MARKER_EVIDENCE)
      || !archivedEvidence.includes(PRIOR_RECOVERY_MARKER_EVIDENCE)) return null
  } else if (priorRecoveryMarker !== null
    || evidenceFiles.includes(PRIOR_RECOVERY_MARKER_EVIDENCE)) return null
  if (!Number.isSafeInteger(record.probeAttempts) || (record.probeAttempts as number) < 0) return null
  if (!isIsoTimestamp(record.startedAt) || !isIsoTimestamp(record.updatedAt)) return null
  if (record.lastProbeAt !== null && !isIsoTimestamp(record.lastProbeAt)) return null
  if (record.lastProbeError !== null
    && (typeof record.lastProbeError !== 'string'
      || record.lastProbeError.length === 0
      || record.lastProbeError.length > 4_000
      || record.lastProbeError.includes('\0'))) return null
  if (record.finalizedAt !== null && !isIsoTimestamp(record.finalizedAt)) return null
  if (record.phase === 'stashing' && archivedEvidence.length !== 0) return null
  if ((record.phase === 'probe-required' || record.phase === 'finalized')
    && !arraysEqual(archivedEvidence, evidenceFiles)) return null
  if ((record.phase === 'finalized') !== (record.finalizedAt !== null)) return null

  return {
    schemaVersion: 1,
    id: record.id,
    phase: record.phase,
    storageKind,
    builtinVersion: record.builtinVersion,
    dshHomePathHash: record.dshHomePathHash,
    dshHomeWasMissing: record.dshHomeWasMissing,
    evidenceFiles,
    archivedEvidence,
    priorRecoveryMarker,
    probeAttempts: record.probeAttempts as number,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    lastProbeAt: record.lastProbeAt,
    lastProbeError: record.lastProbeError,
    finalizedAt: record.finalizedAt,
  }
}

function sameFileIdentity(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.linkCount === right.linkCount
    && left.byteLength === right.byteLength
    && left.modifiedMs === right.modifiedMs
    && left.changedMs === right.changedMs
}

function sameOpaqueBytes(
  left: Pick<FileFingerprint, 'byteLength' | 'sha256'>,
  right: Pick<FileFingerprint, 'byteLength' | 'sha256'>,
): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256
}

/**
 * Reads a regular file through one descriptor and verifies that the pathname
 * still names the same, unchanged inode after hashing it. Rescue evidence
 * requires O_NOFOLLOW; the read-only state reader may use the identity-checked
 * fallback on platforms that lack that flag. Content is retained only for
 * bounded recovery-marker parsing; evidence hashing streams.
 */
function fingerprintRegularFile(
  filePath: string,
  retainContent: boolean,
  requireNoFollow = true,
): { fingerprint: FileFingerprint; content: Buffer | null } {
  if (requireNoFollow && typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('this platform cannot safely open recovery-marker evidence')
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  let descriptor: number | null = null
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | noFollow)
    const before = fstatSync(descriptor)
    if (!before.isFile()
      || before.nlink !== 1
      || !Number.isSafeInteger(before.size)
      || before.size < 0) {
      throw new Error('recovery marker is not a bounded regular file')
    }
    const pathBefore = lstatSync(filePath)
    if (pathBefore.isSymbolicLink()
      || !pathBefore.isFile()
      || pathBefore.dev !== before.dev
      || pathBefore.ino !== before.ino) {
      throw new Error('recovery marker identity changed before it could be read')
    }

    const hash = createHash('sha256')
    const chunks: Buffer[] | null = retainContent && before.size <= MAX_RECOVERY_MARKER_PARSE_BYTES
      ? []
      : null
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)))
    let offset = 0
    while (offset < before.size) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      )
      if (count === 0) throw new Error('recovery marker changed while it was read')
      const bytes = buffer.subarray(0, count)
      hash.update(bytes)
      if (chunks !== null) chunks.push(Buffer.from(bytes))
      offset += count
    }
    const after = fstatSync(descriptor)
    const pathAfter = lstatSync(filePath)
    const beforeIdentity: FileFingerprint = {
      byteLength: before.size,
      sha256: '',
      device: before.dev,
      inode: before.ino,
      linkCount: before.nlink,
      modifiedMs: before.mtimeMs,
      changedMs: before.ctimeMs,
    }
    const afterIdentity: FileFingerprint = {
      byteLength: after.size,
      sha256: '',
      device: after.dev,
      inode: after.ino,
      linkCount: after.nlink,
      modifiedMs: after.mtimeMs,
      changedMs: after.ctimeMs,
    }
    if (!sameFileIdentity(beforeIdentity, afterIdentity)
      || pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino) {
      throw new Error('recovery marker changed while it was read')
    }
    return {
      fingerprint: { ...afterIdentity, sha256: hash.digest('hex') },
      content: chunks === null ? null : Buffer.concat(chunks, offset),
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function assertCopySourceConstraint(
  source: string,
  constraint: RuntimeMetadataRecoveryCopyConstraint,
  openedDevice: number,
  openedInode: number,
): void {
  const rootInfo = lstatSync(constraint.sourceRoot)
  if (rootInfo.isSymbolicLink()
    || !rootInfo.isDirectory()
    || rootInfo.dev !== constraint.sourceRootDevice
    || rootInfo.ino !== constraint.sourceRootInode) {
    throw new Error('copy source root identity changed')
  }
  const sourceInfo = lstatSync(source)
  if (sourceInfo.isSymbolicLink()
    || !sourceInfo.isFile()
    || sourceInfo.nlink !== 1
    || sourceInfo.dev !== constraint.sourceDevice
    || sourceInfo.ino !== constraint.sourceInode
    || sourceInfo.size !== constraint.sourceByteLength
    || sourceInfo.mtimeMs !== constraint.sourceModifiedMs
    || sourceInfo.ctimeMs !== constraint.sourceChangedMs
    || openedDevice !== constraint.sourceDevice
    || openedInode !== constraint.sourceInode) {
    throw new Error('copy source identity changed')
  }
  const realRoot = realpathSync(constraint.sourceRoot)
  const realSource = realpathSync(source)
  if (!isContained(realRoot, realSource)) throw new Error('copy source escaped its pinned root')
}

function defaultCopyFile(
  source: string,
  destination: string,
  constraint: RuntimeMetadataRecoveryCopyConstraint,
): void {
  const noFollow = constants.O_NOFOLLOW ?? 0
  let sourceFd: number | null = null
  let destinationFd: number | null = null
  try {
    sourceFd = openSync(source, constants.O_RDONLY | noFollow)
    const sourceInfo = fstatSync(sourceFd)
    if (!sourceInfo.isFile() || sourceInfo.nlink !== 1) {
      throw new Error('source file is not a uniquely linked regular file')
    }
    if (sourceInfo.size !== constraint.sourceByteLength
      || sourceInfo.mtimeMs !== constraint.sourceModifiedMs
      || sourceInfo.ctimeMs !== constraint.sourceChangedMs) {
      throw new Error('copy source changed before it was read')
    }
    assertCopySourceConstraint(source, constraint, sourceInfo.dev, sourceInfo.ino)
    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE,
    )
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    while (true) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, offset)
      if (count === 0) break
      let written = 0
      while (written < count) {
        written += writeSync(destinationFd, buffer, written, count - written)
      }
      offset += count
    }
    const sourceAfter = fstatSync(sourceFd)
    if (sourceAfter.dev !== sourceInfo.dev
      || sourceAfter.ino !== sourceInfo.ino
      || sourceAfter.nlink !== 1
      || sourceAfter.size !== sourceInfo.size
      || sourceAfter.mtimeMs !== sourceInfo.mtimeMs
      || sourceAfter.ctimeMs !== sourceInfo.ctimeMs) {
      throw new Error('copy source changed while it was read')
    }
    assertCopySourceConstraint(source, constraint, sourceAfter.dev, sourceAfter.ino)
    fsyncSync(destinationFd)
  } catch (error) {
    try { rmSync(destination, { force: true }) } catch { /* best effort inside owned tmp */ }
    throw error
  } finally {
    if (destinationFd !== null) closeSync(destinationFd)
    if (sourceFd !== null) closeSync(sourceFd)
  }
}

const DEFAULT_OPERATIONS: RuntimeMetadataRecoveryOperations = {
  copyFile: defaultCopyFile,
  renamePath: (source, destination) => renameSync(source, destination),
  now: () => new Date(),
  randomHex: () => randomBytes(8).toString('hex'),
  afterCheckpoint: () => undefined,
}

function operations(
  injected: Partial<RuntimeMetadataRecoveryOperations> | undefined,
): RuntimeMetadataRecoveryOperations {
  return { ...DEFAULT_OPERATIONS, ...injected }
}

function nowIso(ops: RuntimeMetadataRecoveryOperations): string {
  const now = ops.now()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('metadata recovery clock is invalid')
  return now.toISOString()
}

function writePrivateJson(
  filePath: string,
  payload: unknown,
  runtimeRoot: string,
  ops: RuntimeMetadataRecoveryOperations,
  kind: 'marker-write' | 'marker-rescue-commit' | 'receipt-write',
): void {
  assertContained(runtimeRoot, filePath, 'metadata recovery JSON')
  const parent = dirname(filePath)
  assertExistingRealDirectory(parent, 'metadata recovery JSON parent')
  const tmp = join(parent, `.${basename(filePath)}.tmp-${randomBytes(4).toString('hex')}`)
  assertContained(parent, tmp, 'metadata recovery JSON temporary file')
  try {
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
      flag: 'wx',
    })
    chmodSync(tmp, PRIVATE_FILE_MODE)
    fsyncRegularFileNoFollow(tmp, 'metadata recovery JSON temporary file')
    ops.renamePath(tmp, filePath, kind)
    const published = lstatSync(filePath)
    if (published.isSymbolicLink() || !published.isFile() || published.nlink !== 1) {
      throw new Error('metadata recovery JSON did not publish as a uniquely linked real file')
    }
    chmodSync(filePath, PRIVATE_FILE_MODE)
    fsyncRegularFileNoFollow(filePath, 'published metadata recovery JSON')
    fsyncRealDirectory(parent, 'metadata recovery JSON parent')
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

function checkpoint(
  paths: RecoveryPaths,
  record: RuntimeMetadataRecoveryRecord,
  checkpointName: RuntimeMetadataRecoveryCheckpoint,
  ops: RuntimeMetadataRecoveryOperations,
  markerKind: 'marker-write' | 'marker-rescue-commit' = 'marker-write',
): RuntimeMetadataRecoveryRecord {
  const parsed = parseRecoveryRecord(record)
  if (parsed === null) throw new Error('refusing to write invalid metadata recovery state')
  writePrivateJson(paths.marker, parsed, paths.runtimeDir, ops, markerKind)
  ops.afterCheckpoint(checkpointName, parsed)
  return parsed
}

function stateForUnsafeExactFile(
  filePath: string,
): 'missing' | 'regular' | 'unsafe' {
  try {
    const info = lstatSync(filePath)
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 ? 'regular' : 'unsafe'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe'
  }
}

function corruptEvidenceBasenames(runtimeDir: string): string[] {
  if (!existsSync(runtimeDir)) return []
  return readdirSync(runtimeDir, { withFileTypes: true })
    .map(entry => entry.name)
    .filter(name => METADATA_BASENAMES.some(base => name.startsWith(`${base}.corrupt`)))
    .filter(name => {
      try { assertSafeBasename(name, 'corrupt metadata evidence'); return true } catch { return false }
    })
    .sort()
}

/** Read the durable recovery marker without interpreting malformed state as absent. */
export function readMetadataRecoveryState(baseDir: string): RuntimeMetadataRecoveryState {
  const { runtimeDir, marker } = recoveryRootPaths(baseDir)
  if (!existsSync(runtimeDir)) return { kind: 'missing' }
  let info
  try { info = lstatSync(marker) } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'corrupt', error: 'metadata recovery marker is unreadable' }
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    return { kind: 'corrupt', error: 'metadata recovery marker is not a uniquely linked real file' }
  }
  try {
    const snapshot = fingerprintRegularFile(marker, true, false)
    const parsed = snapshot.content === null
      ? null
      : parseRecoveryRecord(JSON.parse(snapshot.content.toString('utf8')) as unknown)
    return parsed === null
      ? { kind: 'corrupt', error: 'metadata recovery marker has an invalid shape' }
      : { kind: 'valid', record: parsed }
  } catch {
    return { kind: 'corrupt', error: 'metadata recovery marker is malformed or unreadable' }
  }
}

/**
 * Returns whether an explicit second-order rescue can safely preserve the
 * active marker as opaque evidence. Paths and marker content never leave the
 * core. A symlink, special file, unreadable file, or already-valid marker is
 * deliberately not rescuable through this capability.
 */
export function inspectCorruptMetadataRecoveryMarker(
  baseDir: string,
): CorruptMetadataRecoveryMarkerCapability {
  const { runtimeDir, marker } = recoveryRootPaths(baseDir)
  if (!existsSync(runtimeDir)) return { recoverable: false, reason: 'marker-missing' }
  let info
  try { info = lstatSync(marker) } catch (error) {
    return {
      recoverable: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'marker-missing'
        : 'marker-unreadable',
    }
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    return { recoverable: false, reason: 'marker-unsafe' }
  }
  try {
    const snapshot = fingerprintRegularFile(marker, true)
    if (snapshot.content !== null) {
      try {
        if (parseRecoveryRecord(JSON.parse(snapshot.content.toString('utf8')) as unknown) !== null) {
          return { recoverable: false, reason: 'marker-valid' }
        }
      } catch {
        // Malformed bytes are precisely the explicit rescue case.
      }
    }
    return {
      recoverable: true,
      byteLength: snapshot.fingerprint.byteLength,
      sha256: snapshot.fingerprint.sha256,
    }
  } catch {
    return { recoverable: false, reason: 'marker-unreadable' }
  }
}

/**
 * Detect selection-metadata health using the store's tri-state readers plus
 * every durable *.corrupt* sentinel. This function never accepts or returns a
 * stash/evidence path.
 *
 * A semantically-inconsistent-but-parseable set (e.g. the activation journal's
 * target disagrees with override.pending, or the pre-swap journal is missing
 * while the pointer already advanced to pending) is reported as
 * `selection-corrupt` so the "保留数据并恢复内建" escape stays reachable —
 * otherwise such states hard-block startup with no recovery action.
 */
export function detectRuntimeMetadataHealth(baseDir: string): RuntimeMetadataHealth {
  const { runtimeDir } = recoveryRootPaths(baseDir)
  const currentPath = currentPointerPath(baseDir)
  const current: CurrentPointerState = stateForUnsafeExactFile(currentPath) === 'unsafe'
    ? { kind: 'corrupt' }
    : readCurrentPointerState(baseDir)
  const overrideFile = overridePath(baseDir)
  const override: OverrideState = stateForUnsafeExactFile(overrideFile) === 'unsafe'
    ? { kind: 'corrupt' }
    : readOverrideState(baseDir)
  const journalPath = activationJournalPath(baseDir)
  const activationJournal: ActivationJournalState = stateForUnsafeExactFile(journalPath) === 'unsafe'
    ? { kind: 'corrupt' }
    : readActivationJournalState(baseDir)
  const corruptEvidence = corruptEvidenceBasenames(runtimeDir)
  const recovery = readMetadataRecoveryState(baseDir)
  const selectionCorrupt = current.kind === 'corrupt'
    || override.kind === 'corrupt'
    || activationJournal.kind === 'corrupt'
    || corruptEvidence.length > 0
    || detectSemanticMismatch(current, override, activationJournal)

  let status: RuntimeMetadataHealthStatus
  if (recovery.kind === 'corrupt') status = 'recovery-marker-corrupt'
  else if (recovery.kind === 'valid' && recovery.record.phase !== 'finalized') status = 'recovery-in-progress'
  else if (selectionCorrupt) status = 'selection-corrupt'
  else if (recovery.kind === 'valid') status = 'recovery-finalized'
  else status = 'healthy'
  return { status, current, override, activationJournal, corruptEvidence, recovery }
}

const ROLLBACK_CONTINUATION_PHASES = new Set(['rollback-needed', 'restoring', 'restore-complete', 'fallback-builtin'])

/**
 * A parseable-but-semantically-inconsistent selection-metadata set that the
 * startup replay cannot resolve (its `journal-mismatch` blocked reason).
 * Mirrors runtime-startup.ts's journal-mismatch conditions, conservatively:
 * only when a non-null override.pending signals an in-flight switch, and only
 * for (a) a missing journal with the pointer already advanced to pending, or
 * (b) a valid non-builtin, non-rollback journal whose expected target
 * disagrees with pending.
 */
function detectSemanticMismatch(
  current: CurrentPointerState,
  override: OverrideState,
  journal: ActivationJournalState,
): boolean {
  const pending = override.kind === 'valid' ? override.record.pending : null
  if (pending === null || pending === undefined) return false
  if (journal.kind === 'missing') {
    return current.kind === 'valid' && current.version === pending
  }
  if (journal.kind !== 'valid' || journal.journal.targetIsBuiltin) return false
  if (ROLLBACK_CONTINUATION_PHASES.has(journal.journal.phase)) return false
  const expected = journal.journal.nextIntent !== null && !journal.journal.nextIntent.targetIsBuiltin
    ? journal.journal.nextIntent.targetVersion
    : journal.journal.targetVersion
  return expected !== pending
}

function sourcePathHash(
  dshHomeInput: string,
  runtimeDir: string,
): { dshHome: string; hash: string; missing: boolean } {
  const dshHome = normalizeOwnedPath(dshHomeInput, 'dshHome')
  if (isContained(runtimeDir, dshHome)) throw new Error('dshHome must not be inside the runtime recovery directory')
  let missing = false
  try {
    const info = lstatSync(dshHome)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('dshHome must be a real directory when present')
    const realHome = realpathSync(dshHome)
    const realRuntime = existsSync(runtimeDir) ? realpathSync(runtimeDir) : runtimeDir
    if (isContained(realRuntime, realHome)) throw new Error('dshHome must not resolve inside the runtime recovery directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    missing = true
  }
  return {
    dshHome,
    // Hash the stable expected path so a legitimately missing DSH_HOME can be
    // created by the builtin probe without changing transaction identity.
    hash: createHash('sha256').update(dshHome).digest('hex'),
    missing,
  }
}

function collectEvidence(runtimeDir: string, requireSelectionEvidence = true): string[] {
  const entries = readdirSync(runtimeDir, { withFileTypes: true })
    .filter(entry => isSelectionEvidenceBasename(entry.name) || entry.name === RESTORE_MARKER_EVIDENCE)
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const source = join(runtimeDir, entry.name)
    assertContained(runtimeDir, source, 'metadata evidence source')
    const info = lstatSync(source)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`metadata evidence is not a real file: ${entry.name}`)
    }
  }
  const names = entries.map(entry => entry.name)
  // Only selection evidence satisfies the corrupt-metadata report; a lone
  // restore marker must never manufacture a recovery transaction.
  if (requireSelectionEvidence && !names.some(isSelectionEvidenceBasename)) {
    throw new Error('corrupt metadata was reported but no archivable evidence file exists')
  }
  return names
}

function sourceTreeIdentity(source: string): SourceTreeIdentity {
  const info = lstatSync(source)
  const common = {
    device: info.dev,
    inode: info.ino,
    linkCount: info.nlink,
    byteLength: info.size,
    modifiedMs: info.mtimeMs,
    changedMs: info.ctimeMs,
  }
  if (info.isSymbolicLink()) {
    // Preserve the link text as data. Never resolve or inspect its target.
    return {
      ...common,
      kind: 'symlink',
      linkTarget: readlinkSync(source),
      children: null,
    }
  }
  if (info.isFile()) {
    if (info.nlink !== 1) throw new Error('DSH_HOME contains a multiply linked file')
    return { ...common, kind: 'file', linkTarget: null, children: null }
  }
  if (!info.isDirectory()) throw new Error('DSH_HOME contains a non-file, non-directory entry')
  const children = readdirSync(source, { withFileTypes: true })
    .map(entry => {
      assertSafeBasename(entry.name, 'DSH_HOME entry')
      return entry.name
    })
    .sort()
  return { ...common, kind: 'directory', linkTarget: null, children }
}

function sourceTreeIdentityEqual(left: SourceTreeIdentity, right: SourceTreeIdentity): boolean {
  return left.kind === right.kind
    && left.device === right.device
    && left.inode === right.inode
    && left.linkCount === right.linkCount
    && left.byteLength === right.byteLength
    && left.modifiedMs === right.modifiedMs
    && left.changedMs === right.changedMs
    && left.linkTarget === right.linkTarget
    && ((left.children === null && right.children === null)
      || (left.children !== null
        && right.children !== null
        && arraysEqual(left.children, right.children)))
}

function assertSourceTreeIdentity(
  source: string,
  expected: SourceTreeIdentity,
): void {
  const actual = sourceTreeIdentity(source)
  if (!sourceTreeIdentityEqual(actual, expected)) {
    throw new Error('DSH_HOME entry identity changed while it was stashed')
  }
}

function buildSourceTreeManifest(
  source: string,
  manifest = new Map<string, SourceTreeIdentity>(),
): Map<string, SourceTreeIdentity> {
  const identity = sourceTreeIdentity(source)
  manifest.set(source, identity)
  if (identity.children !== null) {
    for (const child of identity.children) buildSourceTreeManifest(join(source, child), manifest)
    assertSourceTreeIdentity(source, identity)
  }
  return manifest
}

function copySourceTree(
  source: string,
  destination: string,
  destinationRoot: string,
  sourceRoot: string,
  sourceManifest: ReadonlyMap<string, SourceTreeIdentity>,
  ops: RuntimeMetadataRecoveryOperations,
): void {
  const expected = sourceManifest.get(source)
  if (expected === undefined) throw new Error('DSH_HOME source manifest is incomplete')
  assertSourceTreeIdentity(source, expected)
  assertContained(destinationRoot, destination, 'DSH_HOME stash destination')
  if (expected.kind === 'symlink') {
    const target = expected.linkTarget
    if (target === null) throw new Error('DSH_HOME symlink manifest is invalid')
    symlinkSync(target, destination)
    const copied = lstatSync(destination)
    if (!copied.isSymbolicLink() || readlinkSync(destination) !== target) {
      throw new Error('stash copy did not preserve a symbolic link as an opaque link entity')
    }
    assertSourceTreeIdentity(source, expected)
    return
  }
  if (expected.kind === 'file') {
    const rootIdentity = sourceManifest.get(sourceRoot)
    if (rootIdentity === undefined || rootIdentity.kind !== 'directory') {
      throw new Error('DSH_HOME root manifest is invalid')
    }
    ops.copyFile(source, destination, {
      sourceRoot,
      sourceRootDevice: rootIdentity.device,
      sourceRootInode: rootIdentity.inode,
      sourceDevice: expected.device,
      sourceInode: expected.inode,
      sourceByteLength: expected.byteLength,
      sourceModifiedMs: expected.modifiedMs,
      sourceChangedMs: expected.changedMs,
    })
    assertSourceTreeIdentity(source, expected)
    const copied = lstatSync(destination)
    if (copied.isSymbolicLink() || !copied.isFile() || copied.nlink !== 1) {
      throw new Error('stash copy did not create a uniquely linked real file')
    }
    chmodSync(destination, PRIVATE_FILE_MODE)
    fsyncRegularFileNoFollow(destination, 'DSH_HOME stash file')
    return
  }
  ensurePrivateDirectory(destination, destinationRoot)
  if (expected.children === null) throw new Error('DSH_HOME directory manifest is invalid')
  for (const child of expected.children) {
    assertSourceTreeIdentity(source, expected)
    copySourceTree(
      join(source, child),
      join(destination, child),
      destinationRoot,
      sourceRoot,
      sourceManifest,
      ops,
    )
    assertSourceTreeIdentity(source, expected)
  }
  fsyncRealDirectory(destination, 'DSH_HOME stash directory')
}

function assertStashTreeSafe(path: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) {
    // Reading the link itself is safe and does not dereference a possibly
    // dangling, unreadable, absolute, or out-of-tree target.
    readlinkSync(path)
    return
  }
  if (info.isFile()) {
    if (info.nlink !== 1) throw new Error('owned recovery data contains a multiply linked file')
    return
  }
  if (!info.isDirectory()) throw new Error('owned recovery data contains a special filesystem entry')
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    assertSafeBasename(entry.name, 'owned recovery entry')
    assertStashTreeSafe(join(path, entry.name))
  }
}

function removeOwnedPartialTree(path: string, transactionDir: string): void {
  assertContained(transactionDir, path, 'partial stash')
  if (!existsSync(path)) return
  assertExistingRealDirectory(path, 'partial DSH_HOME stash')
  assertStashTreeSafe(path)
  rmSync(path, { recursive: true, force: true })
}

function parseStashReady(path: string, record: RuntimeMetadataRecoveryRecord): boolean {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) return false
    chmodSync(path, PRIVATE_FILE_MODE)
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const ready = value as Record<string, unknown>
    return ready.schemaVersion === 1
      && ready.recoveryId === record.id
      && ready.dshHomePathHash === record.dshHomePathHash
  } catch {
    return false
  }
}

function assertPublishedStash(paths: RecoveryPaths, record: RuntimeMetadataRecoveryRecord): void {
  assertExistingRealDirectory(paths.stash, 'published DSH_HOME stash')
  assertStashTreeSafe(paths.stash)
  if (!parseStashReady(paths.stashReady, record)) throw new Error('published DSH_HOME stash lacks a valid completion record')
}

function ensurePublishedStash(
  paths: RecoveryPaths,
  dshHome: string,
  record: RuntimeMetadataRecoveryRecord,
  ops: RuntimeMetadataRecoveryOperations,
): void {
  if (existsSync(paths.stash)) {
    assertPublishedStash(paths, record)
    if (existsSync(paths.stashTmp)) removeOwnedPartialTree(paths.stashTmp, paths.transactionDir)
    return
  }
  if (existsSync(paths.stashTmp) && parseStashReady(paths.stashReady, record)) {
    assertExistingRealDirectory(paths.stashTmp, 'temporary DSH_HOME stash')
    assertStashTreeSafe(paths.stashTmp)
    fsyncRealDirectory(paths.stashTmp, 'temporary DSH_HOME stash')
    ops.renamePath(paths.stashTmp, paths.stash, 'stash-publish')
    fsyncRealDirectory(paths.transactionDir, 'metadata recovery transaction directory')
    assertPublishedStash(paths, record)
    return
  }

  if (existsSync(paths.stashTmp)) removeOwnedPartialTree(paths.stashTmp, paths.transactionDir)
  if (existsSync(paths.stashReady)) {
    const info = lstatSync(paths.stashReady)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error('stash completion record is unsafe')
    }
    rmSync(paths.stashReady, { force: true })
  }
  let sourceMissing = false
  try {
    const info = lstatSync(dshHome)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('dshHome must be a real directory when present')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    sourceMissing = true
  }
  if (sourceMissing !== record.dshHomeWasMissing) {
    throw new Error('DSH_HOME presence changed before its recovery stash was published')
  }
  const sourceManifest = sourceMissing ? null : buildSourceTreeManifest(dshHome)
  ensurePrivateDirectory(paths.stashTmp, paths.transactionDir)
  if (sourceManifest !== null) {
    copySourceTree(
      dshHome,
      paths.stashTmp,
      paths.stashTmp,
      dshHome,
      sourceManifest,
      ops,
    )
  }
  fsyncRealDirectory(paths.stashTmp, 'temporary DSH_HOME stash')
  const ready: StashReadyRecord = {
    schemaVersion: 1,
    recoveryId: record.id,
    dshHomePathHash: record.dshHomePathHash,
  }
  writePrivateJson(paths.stashReady, ready, paths.runtimeDir, ops, 'receipt-write')
  ops.renamePath(paths.stashTmp, paths.stash, 'stash-publish')
  fsyncRealDirectory(paths.transactionDir, 'metadata recovery transaction directory')
  assertPublishedStash(paths, record)
}

function ensureRecoveryDirectories(paths: RecoveryPaths): void {
  if (!existsSync(paths.runtimeDir)) {
    const baseDir = dirname(paths.runtimeDir)
    ensurePrivateDirectory(paths.runtimeDir, baseDir)
  } else {
    assertExistingRealDirectory(paths.runtimeDir, 'runtime directory')
    chmodSync(paths.runtimeDir, PRIVATE_DIR_MODE)
  }
  ensurePrivateDirectory(paths.dataRoot, paths.runtimeDir)
  ensurePrivateDirectory(paths.transactionDir, paths.dataRoot)
  ensurePrivateDirectory(paths.evidence, paths.transactionDir)
}

function allocateRecoveryRecord(
  baseDir: string,
  builtinVersion: string,
  dshHomePathHash: string,
  dshHomeWasMissing: boolean,
  evidenceFiles: string[],
  ops: RuntimeMetadataRecoveryOperations,
  storageKind: RuntimeMetadataRecoveryStorageKind,
  priorRecoveryMarker: PriorRecoveryMarkerEvidence | null,
): { paths: RecoveryPaths; record: RuntimeMetadataRecoveryRecord } {
  const now = ops.now()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('metadata recovery clock is invalid')
  const timestamp = now.toISOString()
  const random = ops.randomHex()
  if (!/^[0-9a-f]{16}$/.test(random)) throw new Error('metadata recovery random id is invalid')
  const id = `${now.getTime()}-${random}`
  const paths = recoveryPaths(baseDir, id, storageKind)
  if (existsSync(paths.transactionDir)) throw new Error('metadata recovery id collision')
  ensureRecoveryDirectories(paths)
  const record: RuntimeMetadataRecoveryRecord = {
    schemaVersion: 1,
    id,
    phase: 'stashing',
    storageKind,
    builtinVersion,
    dshHomePathHash,
    dshHomeWasMissing,
    evidenceFiles,
    archivedEvidence: [],
    priorRecoveryMarker,
    probeAttempts: 0,
    startedAt: timestamp,
    updatedAt: timestamp,
    lastProbeAt: null,
    lastProbeError: null,
    finalizedAt: null,
  }
  return { paths, record }
}

function newRecoveryRecord(
  baseDir: string,
  builtinVersion: string,
  dshHomePathHash: string,
  dshHomeWasMissing: boolean,
  evidenceFiles: string[],
  ops: RuntimeMetadataRecoveryOperations,
): { paths: RecoveryPaths; record: RuntimeMetadataRecoveryRecord } {
  const allocated = allocateRecoveryRecord(
    baseDir,
    builtinVersion,
    dshHomePathHash,
    dshHomeWasMissing,
    evidenceFiles,
    ops,
    'default',
    null,
  )
  return {
    paths: allocated.paths,
    record: checkpoint(allocated.paths, allocated.record, 'stashing', ops),
  }
}

function archiveEvidenceFile(
  paths: RecoveryPaths,
  name: string,
  ops: RuntimeMetadataRecoveryOperations,
): void {
  assertSafeBasename(name, 'metadata evidence')
  if (!isEvidenceBasename(name)) throw new Error('refusing to archive a non-metadata basename')
  const source = join(paths.runtimeDir, name)
  const destination = join(paths.evidence, name)
  assertContained(paths.runtimeDir, source, 'metadata evidence source')
  assertContained(paths.evidence, destination, 'metadata evidence destination')
  const sourceExists = existsSync(source)
  const destinationExists = existsSync(destination)
  if (sourceExists && destinationExists) throw new Error(`metadata evidence exists at source and destination: ${name}`)
  if (!sourceExists && !destinationExists) throw new Error(`metadata evidence disappeared during recovery: ${name}`)
  if (sourceExists) {
    const info = lstatSync(source)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`metadata evidence is unsafe: ${name}`)
    }
    chmodSync(source, PRIVATE_FILE_MODE)
    ops.renamePath(source, destination, 'evidence')
    fsyncRealDirectory(paths.evidence, 'metadata recovery evidence directory')
    fsyncRealDirectory(paths.runtimeDir, 'runtime metadata directory')
  }
  const archived = lstatSync(destination)
  if (archived.isSymbolicLink() || !archived.isFile() || archived.nlink !== 1) {
    throw new Error(`archived metadata evidence is unsafe: ${name}`)
  }
  chmodSync(destination, PRIVATE_FILE_MODE)
}

function assertNoUnplannedEvidence(paths: RecoveryPaths, record: RuntimeMetadataRecoveryRecord): void {
  const remaining = readdirSync(paths.runtimeDir, { withFileTypes: true })
    .map(entry => entry.name)
    .filter(isEvidenceBasename)
  if (remaining.length > 0) {
    throw new Error(`new runtime metadata appeared during recovery: ${remaining.sort().join(', ')}`)
  }
  for (const name of record.evidenceFiles) {
    const archivedPath = join(paths.evidence, name)
    const info = lstatSync(archivedPath)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`metadata evidence is incomplete: ${name}`)
    }
  }
  if (record.priorRecoveryMarker !== null) {
    const priorPath = join(paths.evidence, PRIOR_RECOVERY_MARKER_EVIDENCE)
    const prior = fingerprintRegularFile(priorPath, false).fingerprint
    if (!sameOpaqueBytes(prior, record.priorRecoveryMarker)) {
      throw new Error('prior corrupt recovery-marker evidence no longer matches its provenance')
    }
  }
}

function corruptMarkerSnapshotForRescue(marker: string): FileFingerprint {
  const snapshot = fingerprintRegularFile(marker, true)
  if (snapshot.content !== null) {
    try {
      if (parseRecoveryRecord(JSON.parse(snapshot.content.toString('utf8')) as unknown) !== null) {
        throw new Error('metadata recovery marker is already valid')
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'metadata recovery marker is already valid') throw error
      // Malformed or invalid-shape bytes are rescued opaquely; never inferred.
    }
  }
  return snapshot.fingerprint
}

/**
 * Explicitly bootstraps a second-order transaction for a corrupt active
 * recovery marker. Callers must have already stopped all writers and completed
 * any older restore. The active marker remains byte-for-byte untouched until a
 * full DSH_HOME stash and an independently verified opaque marker copy exist;
 * one rename then atomically commits the replacement marker.
 */
export function bootstrapCorruptMetadataRecoveryMarker(
  options: ResumeRuntimeMetadataRecoveryOptions,
): ResumeRuntimeMetadataRecoveryResult {
  const ops = operations(options.operations)
  const builtinVersion = assertSafeVersion(options.builtinVersion)
  const roots = recoveryRootPaths(options.baseDir)
  const source = sourcePathHash(options.dshHome, roots.runtimeDir)
  const capability = inspectCorruptMetadataRecoveryMarker(options.baseDir)
  if (!capability.recoverable) {
    throw new Error(`corrupt recovery marker cannot be rescued: ${capability.reason}`)
  }

  const original = corruptMarkerSnapshotForRescue(roots.marker)
  if (!sameOpaqueBytes(original, capability)) {
    throw new Error('recovery marker changed after its rescue capability was checked')
  }
  const selectionEvidence = collectEvidence(roots.runtimeDir, false)
  const evidenceFiles = [...selectionEvidence, PRIOR_RECOVERY_MARKER_EVIDENCE].sort()
  const provenance: PriorRecoveryMarkerEvidence = {
    name: PRIOR_RECOVERY_MARKER_EVIDENCE,
    byteLength: original.byteLength,
    sha256: original.sha256,
  }
  const { paths, record: provisional } = allocateRecoveryRecord(
    options.baseDir,
    builtinVersion,
    source.hash,
    source.missing,
    evidenceFiles,
    ops,
    'marker-rescue',
    provenance,
  )

  // Nothing below may touch the active marker before the final checkpoint.
  ensurePublishedStash(paths, source.dshHome, provisional, ops)
  const opaqueTmp = join(paths.evidence, `.${PRIOR_RECOVERY_MARKER_EVIDENCE}.tmp`)
  const opaqueEvidence = join(paths.evidence, PRIOR_RECOVERY_MARKER_EVIDENCE)
  assertContained(paths.evidence, opaqueTmp, 'opaque recovery-marker temporary evidence')
  assertContained(paths.evidence, opaqueEvidence, 'opaque recovery-marker evidence')
  try {
    const runtimeInfo = lstatSync(roots.runtimeDir)
    if (runtimeInfo.isSymbolicLink() || !runtimeInfo.isDirectory()) {
      throw new Error('runtime metadata directory identity is unsafe')
    }
    ops.copyFile(roots.marker, opaqueTmp, {
      sourceRoot: roots.runtimeDir,
      sourceRootDevice: runtimeInfo.dev,
      sourceRootInode: runtimeInfo.ino,
      sourceDevice: original.device,
      sourceInode: original.inode,
      sourceByteLength: original.byteLength,
      sourceModifiedMs: original.modifiedMs,
      sourceChangedMs: original.changedMs,
    })
    const copiedInfo = lstatSync(opaqueTmp)
    if (copiedInfo.isSymbolicLink() || !copiedInfo.isFile() || copiedInfo.nlink !== 1) {
      throw new Error('opaque recovery-marker copy is not a uniquely linked real file')
    }
    chmodSync(opaqueTmp, PRIVATE_FILE_MODE)
    fsyncRegularFileNoFollow(opaqueTmp, 'opaque recovery-marker temporary evidence')
    const copied = fingerprintRegularFile(opaqueTmp, false).fingerprint
    if (!sameOpaqueBytes(copied, original)) {
      throw new Error('opaque recovery-marker copy does not match its source')
    }
    const sourceAfterCopy = corruptMarkerSnapshotForRescue(roots.marker)
    if (!sameFileIdentity(sourceAfterCopy, original)
      || !sameOpaqueBytes(sourceAfterCopy, original)) {
      throw new Error('recovery marker changed while its evidence was copied')
    }
    ops.renamePath(opaqueTmp, opaqueEvidence, 'opaque-marker-publish')
    fsyncRealDirectory(paths.evidence, 'metadata recovery evidence directory')
  } catch (error) {
    try { rmSync(opaqueTmp, { force: true }) } catch { /* retain fail-closed orphan data */ }
    throw error
  }

  const published = fingerprintRegularFile(opaqueEvidence, false).fingerprint
  if (!sameOpaqueBytes(published, original)) {
    throw new Error('published recovery-marker evidence does not match its source')
  }
  const sourceBeforeCommit = corruptMarkerSnapshotForRescue(roots.marker)
  if (!sameFileIdentity(sourceBeforeCommit, original)
    || !sameOpaqueBytes(sourceBeforeCommit, original)) {
    throw new Error('recovery marker changed before the rescue commit')
  }

  // Make every additive rescue artifact durable before the only destructive
  // namespace operation: replacing the active marker slot.
  fsyncRealDirectory(paths.evidence, 'metadata recovery evidence directory')
  fsyncRealDirectory(paths.transactionDir, 'metadata recovery transaction directory')
  fsyncRealDirectory(paths.dataRoot, 'metadata recovery rescue data root')
  fsyncRealDirectory(paths.runtimeDir, 'runtime metadata directory')

  checkpoint(paths, {
    ...provisional,
    phase: 'archiving',
    archivedEvidence: [PRIOR_RECOVERY_MARKER_EVIDENCE],
    updatedAt: nowIso(ops),
  }, 'marker-rescue-committed', ops, 'marker-rescue-commit')
  return resumeMetadataRecoveryCore({ ...options, operations: ops })
}

/**
 * Resume only the durable filesystem portion. It performs all phase writes
 * internally and returns once the caller must probe the builtin runtime.
 */
export function resumeMetadataRecoveryCore(
  options: ResumeRuntimeMetadataRecoveryOptions,
): ResumeRuntimeMetadataRecoveryResult {
  const ops = operations(options.operations)
  const builtinVersion = assertSafeVersion(options.builtinVersion)
  const roots = recoveryRootPaths(options.baseDir)
  const source = sourcePathHash(options.dshHome, roots.runtimeDir)
  const existing = readMetadataRecoveryState(options.baseDir)
  if (existing.kind === 'corrupt') throw new Error(existing.error)

  let paths: RecoveryPaths
  let record: RuntimeMetadataRecoveryRecord
  if (existing.kind === 'valid' && existing.record.phase !== 'finalized') {
    record = existing.record
    if (record.builtinVersion !== builtinVersion) {
      throw new Error(`metadata recovery is pinned to builtin ${record.builtinVersion}; refusing ${builtinVersion}`)
    }
    if (record.dshHomePathHash !== source.hash) throw new Error('metadata recovery DSH_HOME identity changed')
    paths = recoveryPaths(options.baseDir, record.id, record.storageKind)
    ensureRecoveryDirectories(paths)
  } else {
    const health = detectRuntimeMetadataHealth(options.baseDir)
    const selectionCorrupt = health.current.kind === 'corrupt'
      || health.override.kind === 'corrupt'
      || health.activationJournal.kind === 'corrupt'
      || health.corruptEvidence.length > 0
    if (!selectionCorrupt) {
      return existing.kind === 'valid'
        ? { phase: 'finalized', record: existing.record }
        : { phase: 'not-needed', record: null }
    }
    if (!existsSync(roots.runtimeDir)) throw new Error('runtime metadata directory disappeared')
    const evidenceFiles = collectEvidence(roots.runtimeDir)
    ;({ paths, record } = newRecoveryRecord(
      options.baseDir,
      builtinVersion,
      source.hash,
      source.missing,
      evidenceFiles,
      ops,
    ))
  }

  if (record.phase === 'probe-required') {
    assertPublishedStash(paths, record)
    assertNoUnplannedEvidence(paths, record)
    return { phase: 'probe-required', record }
  }
  if (record.phase === 'finalized') return { phase: 'finalized', record }

  ensurePublishedStash(paths, source.dshHome, record, ops)
  if (record.phase === 'stashing') {
    record = checkpoint(paths, {
      ...record,
      phase: 'archiving',
      updatedAt: nowIso(ops),
    }, 'archiving', ops)
  }
  if (record.phase !== 'archiving') throw new Error(`unsupported metadata recovery phase: ${record.phase}`)

  for (const name of record.evidenceFiles) {
    archiveEvidenceFile(paths, name, ops)
    if (!record.archivedEvidence.includes(name)) {
      record = checkpoint(paths, {
        ...record,
        archivedEvidence: [...record.archivedEvidence, name].sort(),
        updatedAt: nowIso(ops),
      }, `evidence:${name}`, ops)
    }
  }
  assertPublishedStash(paths, record)
  assertNoUnplannedEvidence(paths, record)
  record = checkpoint(paths, {
    ...record,
    phase: 'probe-required',
    archivedEvidence: [...record.evidenceFiles],
    updatedAt: nowIso(ops),
  }, 'probe-required', ops)
  return { phase: 'probe-required', record }
}

function selectionMetadataIsAbsent(baseDir: string): boolean {
  const health = detectRuntimeMetadataHealth(baseDir)
  return health.current.kind === 'missing'
    && health.override.kind === 'missing'
    && health.activationJournal.kind === 'missing'
    && health.corruptEvidence.length === 0
}

export function recordMetadataRecoveryProbeFailure(
  baseDir: string,
  expectedRecoveryId: string,
  error: unknown,
  injected?: Partial<RuntimeMetadataRecoveryOperations>,
): RuntimeMetadataRecoveryRecord {
  const ops = operations(injected)
  const state = readMetadataRecoveryState(baseDir)
  if (state.kind !== 'valid' || state.record.phase !== 'probe-required') {
    throw new Error('metadata recovery is not awaiting a probe')
  }
  if (state.record.id !== assertRecoveryId(expectedRecoveryId)) throw new Error('metadata recovery id changed')
  const paths = recoveryPaths(baseDir, state.record.id, state.record.storageKind)
  assertPublishedStash(paths, state.record)
  assertNoUnplannedEvidence(paths, state.record)
  const timestamp = nowIso(ops)
  const message = sanitizeErrorText(error instanceof Error ? error.message : String(error)).slice(0, 4_000)
    || 'builtin runtime probe failed'
  return checkpoint(paths, {
    ...state.record,
    probeAttempts: state.record.probeAttempts + 1,
    lastProbeAt: timestamp,
    lastProbeError: message,
    updatedAt: timestamp,
  }, 'probe-failed', ops)
}

/** Finalize only after the caller has positively probed the exact builtin. */
export function finalizeMetadataRecovery(
  baseDir: string,
  expectedRecoveryId: string,
  injected?: Partial<RuntimeMetadataRecoveryOperations>,
): RuntimeMetadataRecoveryRecord {
  const ops = operations(injected)
  const state = readMetadataRecoveryState(baseDir)
  if (state.kind !== 'valid' || state.record.phase !== 'probe-required') {
    throw new Error('metadata recovery is not awaiting a successful probe')
  }
  if (state.record.id !== assertRecoveryId(expectedRecoveryId)) throw new Error('metadata recovery id changed')
  const paths = recoveryPaths(baseDir, state.record.id, state.record.storageKind)
  assertPublishedStash(paths, state.record)
  assertNoUnplannedEvidence(paths, state.record)
  if (!selectionMetadataIsAbsent(baseDir)) throw new Error('selection metadata reappeared before recovery finalization')
  const timestamp = nowIso(ops)
  const finalized: RuntimeMetadataRecoveryRecord = {
    ...state.record,
    phase: 'finalized',
    probeAttempts: state.record.probeAttempts + 1,
    lastProbeAt: timestamp,
    lastProbeError: null,
    updatedAt: timestamp,
    finalizedAt: timestamp,
  }
  writePrivateJson(paths.finalizedReceipt, finalized, paths.runtimeDir, ops, 'receipt-write')
  return checkpoint(paths, finalized, 'finalized', ops)
}

function assertRestoreOutcome(
  outcome: unknown,
): asserts outcome is RuntimeMetadataRestoreOutcome {
  if (outcome !== 'none'
    && outcome !== 'complete'
    && outcome !== 'half'
    && outcome !== 'incomplete') {
    throw new Error('completeRestore returned an invalid outcome')
  }
}

function restoreBlockedResult(
  outcome: 'half' | 'incomplete',
  record: RuntimeMetadataRecoveryRecord | null,
): RecoverRuntimeMetadataResult {
  return {
    status: 'restore-blocked',
    phase: 'restore-blocked',
    record,
    restoreOutcome: outcome,
    error: outcome === 'half'
      ? 'an interrupted DSH_HOME restore is only partially complete'
      : 'an interrupted DSH_HOME restore is incomplete',
  }
}

async function probeAndFinalizeMetadataRecovery(
  options: RecoverRuntimeMetadataOptions,
  resumed: ResumeRuntimeMetadataRecoveryResult,
  restoreOutcome: 'none' | 'complete' | 'incomplete',
): Promise<RecoverRuntimeMetadataResult> {
  if (resumed.phase === 'not-needed') {
    return { status: 'not-needed', phase: 'not-needed', record: null, restoreOutcome: 'none', error: null }
  }
  if (resumed.phase === 'finalized') {
    return {
      status: 'already-finalized',
      phase: 'finalized',
      record: resumed.record,
      restoreOutcome,
      error: null,
    }
  }

  let probe: RuntimeMetadataProbeOutcome
  try {
    probe = await options.probeBuiltin()
  } catch (error) {
    probe = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (probe === null || typeof probe !== 'object' || typeof probe.ok !== 'boolean') {
    probe = { ok: false, error: 'probeBuiltin returned an invalid result' }
  }
  if (!probe.ok) {
    const failed = recordMetadataRecoveryProbeFailure(
      options.baseDir,
      resumed.record.id,
      probe.error,
      options.operations,
    )
    let error = failed.lastProbeError ?? 'builtin runtime probe failed'
    try { await options.stopHost() } catch (stopError) {
      error = `${error}; failed to stop rejected builtin: ${sanitizeErrorText(stopError instanceof Error ? stopError.message : String(stopError))}`
    }
    return {
      status: 'probe-failed',
      phase: 'probe-required',
      record: failed,
      restoreOutcome,
      error,
    }
  }

  const finalized = finalizeMetadataRecovery(
    options.baseDir,
    resumed.record.id,
    options.operations,
  )
  return {
    status: 'finalized',
    phase: 'finalized',
    record: finalized,
    restoreOutcome,
    error: null,
  }
}

/**
 * Full lifecycle wrapper for the explicit corrupt-marker rescue. This is the
 * only high-level API that may replace a malformed regular marker. The ordinary
 * recovery orchestrator below intentionally continues to fail closed.
 *
 * A 'half' interrupted restore is transient (retry-restore is the only correct
 * action) and blocks the rescue before anything is archived. An 'incomplete'
 * restore — the journaled snapshot is missing or untrustworthy, so no retry
 * can ever succeed — does not block: the stale restore marker is archived as
 * opaque evidence with the selection metadata, and the transaction proceeds.
 */
export async function rescueCorruptMetadataRecoveryMarker(
  options: RecoverRuntimeMetadataOptions,
): Promise<RecoverRuntimeMetadataResult> {
  assertSafeVersion(options.builtinVersion)
  const capability = inspectCorruptMetadataRecoveryMarker(options.baseDir)
  if (!capability.recoverable) {
    throw new Error(`corrupt recovery marker cannot be rescued: ${capability.reason}`)
  }

  await options.stopHost()
  const restoreOutcome: unknown = await options.completeRestore()
  assertRestoreOutcome(restoreOutcome)
  if (restoreOutcome === 'half') {
    return restoreBlockedResult(restoreOutcome, null)
  }

  const resumed = bootstrapCorruptMetadataRecoveryMarker(options)
  return probeAndFinalizeMetadataRecovery(options, resumed, restoreOutcome)
}

/**
 * Main-process convenience orchestrator. The caller supplies lifecycle/probe
 * callbacks, but this module owns every durable phase transition.
 *
 * A 'half' interrupted restore is transient: the retry-restore action owns the
 * scene and the transaction must NOT be archived over it. An 'incomplete'
 * restore is permanent (the journaled snapshot is missing or untrustworthy, so
 * no retry can succeed); the transaction proceeds, archiving the stale restore
 * marker as opaque evidence alongside the selection metadata before the
 * builtin probe.
 */
export async function recoverRuntimeMetadata(
  options: RecoverRuntimeMetadataOptions,
): Promise<RecoverRuntimeMetadataResult> {
  assertSafeVersion(options.builtinVersion)
  const initial = detectRuntimeMetadataHealth(options.baseDir)
  if (initial.recovery.kind === 'corrupt') throw new Error(initial.recovery.error)
  const selectionCorrupt = initial.current.kind === 'corrupt'
    || initial.override.kind === 'corrupt'
    || initial.activationJournal.kind === 'corrupt'
    || initial.corruptEvidence.length > 0
  if (initial.recovery.kind === 'missing' && !selectionCorrupt) {
    return { status: 'not-needed', phase: 'not-needed', record: null, restoreOutcome: 'none', error: null }
  }
  if (initial.recovery.kind === 'valid'
    && initial.recovery.record.phase === 'finalized'
    && !selectionCorrupt) {
    return {
      status: 'already-finalized',
      phase: 'finalized',
      record: initial.recovery.record,
      restoreOutcome: 'none',
      error: null,
    }
  }

  await options.stopHost()
  const restoreOutcome: unknown = await options.completeRestore()
  assertRestoreOutcome(restoreOutcome)
  if (restoreOutcome === 'half') {
    return restoreBlockedResult(
      restoreOutcome,
      initial.recovery.kind === 'valid' ? initial.recovery.record : null,
    )
  }

  const resumed = resumeMetadataRecoveryCore(options)
  return probeAndFinalizeMetadataRecovery(options, resumed, restoreOutcome)
}
