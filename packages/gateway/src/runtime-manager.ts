/**
 * Gateway dsh runtime version management (design 18 §9.3): composes the
 * shared `@dsh-chamber/dsh-runtime` core through its StartupDeps/ApplyDeps/
 * InstallerDeps seams (RuntimeHostAdapter remains a documented sketch).
 *
 * Storage layout (design 18 §9.3 + design 17 §10): the shared core appends
 * `dsh-runtime` under its `baseDir`, so the gateway passes `stateDir` as
 * baseDir — version trees / current pointer / override / journal / snapshots
 * land in `<stateDir>/dsh-runtime/`, exactly like desktop's `<userData>/
 * dsh-runtime/`. The gateway's own files (registry.json / owner.json) live in
 * the same directory (stateRoot == runtimeDirPath(stateDir)).
 *
 * - Resolution chain: DSH_GATEWAY_DSH_PATH (env, always highest) → override
 *   (valid tree) → builtin anchor (`--dsh-path` / findDshWorkspace).
 * - Startup transaction (design 17 §2.1 step 4) runs BEFORE the first
 *   startLocal(): cleanup → eviction → restore completion → (pending)
 *   snapshot → pointer switch → spawn candidate → probe gate → verdict.
 * - The `/chamber/runtime` controller consumes this manager; it stays mounted
 *   while dsh is down (not ready-gated) so restart/applying progress stays
 *   pollable (design 18 §9.3 mounting discipline).
 *
 * Single-process invariant: one gateway per stateDir. The owner record is
 * created with O_EXCL (`wx`): a concurrent second gateway fails loud on
 * EEXIST instead of racing a read-check-write window.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire as nodeCreateRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { call as dshCall, type Logger, type PlaneHandle } from '@dsh-chamber/control-plane'
import { hasSyncedHostSeed } from './plugins.ts'
import {
  bindRuntimeInstallResolution,
  assertRuntimeRootNoFollow,
  atomicWriteRuntimeFileNoFollow,
  buildCachedVersionList,
  buildVersionList,
  canonicalRegistryOrigin,
  cleanupExplicitRuntimeVersion,
  cleanupStaleInstalls,
  clearActivationJournal,
  clearCurrentPointer,
  clearStorePruneRequest,
  compareRuntimeVersions,
  completeInterruptedRestore,
  createRuntimeFileExclusiveNoFollow,
  deleteOverride,
  detectRuntimeMetadataHealth,
  downloadVerifiedRegistryTarball,
  evictVersions,
  ensureRuntimeRootNoFollow,
  fetchRegistryMetadata,
  disposeRuntimeInstaller,
  installRuntimeVersion,
  inspectCorruptMetadataRecoveryMarker,
  invalidate,
  isProtectedVersion,
  isSafeVersion,
  latestKnownGood,
  listExplicitlyInstalledVersions,
  listKnownGoodVersions,
  listPreRollbackStashes,
  listValidVersionTrees,
  noteBoot,
  planRestartExhaustedRollback,
  promoteDueCandidates,
  pruneRuntimeSnapshots,
  pruneRuntimeStore,
  quarantineRuntimeFileNoFollow,
  prepareManualRollbackData,
  RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
  FATAL_STARTUP_BLOCK_REASONS,
  readActivationJournalState,
  readCurrentPointer,
  readCurrentPointerState,
  readOverride,
  readOverrideState,
  readPrivateFileNoFollow,
  readStorePruneRequest,
  recordExplicitInstall,
  recoverRuntimeMetadata,
  rescueCorruptMetadataRecoveryMarker,
  PROBE_NAMES_WITHOUT_HOST_DOMAINS,
  recordProbePass,
  recordRuntimeFailure,
  removeKnownGoodCandidate,
  removeRuntimeFileNoFollow,
  resetCandidateHealthWindow,
  restoreMarkerAuthorityStatus,
  restorePreRollback,
  restoreSnapshot,
  resolveSnapshotName,
  runRuntimeActivationProbes,
  runStartupPhase,
  runtimeDiskSummary,
  runtimeFailureSummary,
  sanitizeErrorText,
  snapshotSummary,
  shouldInvalidate,
  snapshotDshHome,
  writeActivationIntent,
  writeActivationJournal,
  writeCurrentPointer,
  writeOverride,
  type ActivationIntentKind,
  type ActivationJournalState,
  type CurrentPointerState,
  type OverrideRecord,
  type OverrideState,
  type ProbeResult,
  type RuntimeStatusProjection,
  type RuntimeDiskSummary,
  type RuntimeInstallProgress,
  type RuntimeFileIdentity,
  type StartupDeps,
} from '@dsh-chamber/dsh-runtime'
import { sanitizeRouteError } from './sanitize-route-error.ts'
import type { GatewayConfig } from './config.ts'

const gatewayRequire = nodeCreateRequire(import.meta.url)

/**
 * The builtin anchor's real semver (design 18 §9.3 F1): apply-phase snapshots
 * the switching-from source under a semver name, so the anchor workspace must
 * contribute its @deepseek-ai/dsh package version — exactly like desktop's
 * bundledVersion. Unreadable/missing → null (fail-loud at apply time, never a
 * fake snapshot).
 */
export function readBuiltinVersion(anchorPath: string): string | null {
  const candidates = [
    join(anchorPath, 'package.json'),
    join(anchorPath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(anchorPath, 'apps', 'cli', 'package.json'),
  ]
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as {
        version?: unknown
        dependencies?: Record<string, unknown>
      }
      const version = candidate === candidates[0]
        ? manifest.dependencies?.[DSH_PACKAGE_NAME]
        : manifest.version
      if (typeof version === 'string' && isSafeVersion(version)) return version
    } catch {
      // Try the installed-package manifest after a workspace-root miss. A
      // complete miss remains null and is projected/refused honestly.
    }
  }
  return null
}
const GATEWAY_PACKAGE_VERSION: string = gatewayRequire('../package.json').version as string
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
const DEFAULT_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
/** 10 GiB logical disk soft-limit — shared core value (dsh-runtime
 * RUNTIME_LOGICAL_DISK_LIMIT_BYTES); the desktop owner projects the same
 * constant as its diskLimitBytes. */
const GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES = RUNTIME_LOGICAL_DISK_LIMIT_BYTES
export const GATEWAY_RUNTIME_STATUS_KIND = 'dsh-chamber-gateway-runtime' as const

/** FATAL metadata blocks plus the recover-route probe-failed sentinel: the
 *  startup-block reasons the recover-metadata route may act on. Everything
 *  else (restore-half/incomplete, swap-attempted…) must resume through its
 *  own retry first. The four FATAL reasons are the shared core set
 *  (dsh-runtime FATAL_STARTUP_BLOCK_REASONS, the same set index.ts and the
 *  desktop main block on) plus the two sentinels the manager sets after a
 *  failed builtin recovery probe/start. */
export const RECOVERABLE_METADATA_BLOCKS = new Set<string>([
  ...FATAL_STARTUP_BLOCK_REASONS,
  'metadata-probe-failed',
  'metadata-start-failed',
])

/**
 * Rollback-vs-lease serialization bound (design 21 §6.3 decision 6/17 F7
 * review gate): the automatic restart-exhausted rollback waits at most this
 * long for the managed profile-write lease counter to drain before it DEFERS
 * — a DSH_HOME write must never interleave a live plugin pnpm child, and the
 * only lease-aware point inside the rollback transaction (the spawn
 * checkpoint) comes AFTER its restore step writes DSH_HOME.
 */
export const ROLLBACK_LEASE_WAIT_MS = 15 * 60_000

/** Gateway-owned registry source persistence (owner-only 0600; design 18 §9.3). */
function registryFile(baseDir: string): string {
  return join(baseDir, 'dsh-runtime', 'registry.json')
}

function registryCorruptEvidence(baseDir: string): string[] {
  const stateRoot = assertRuntimeRootNoFollow(baseDir)
  try {
    const evidence = readdirSync(stateRoot)
      .filter(name => name.startsWith('registry.json.corrupt-'))
      .sort()
    assertRuntimeRootNoFollow(baseDir)
    return evidence
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function quarantineCorruptRegistry(
  baseDir: string,
  reason: string,
  expectedIdentity?: RuntimeFileIdentity,
): never {
  const file = registryFile(baseDir)
  const destination = `${file}.corrupt-${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    quarantineRuntimeFileNoFollow(baseDir, file, destination, {
      ...(expectedIdentity === undefined ? {} : { expectedIdentity }),
    })
  } catch (error) {
    throw new Error(`gateway runtime registry configuration is corrupt (${reason}) and could not be quarantined: ${sanitizeErrorText(String(error))}`)
  }
  throw new Error(`gateway runtime registry configuration is corrupt (${reason}); original bytes preserved as ${basename(destination)}`)
}

function readRegistryOrigin(baseDir: string): string {
  assertRuntimeRootNoFollow(baseDir)
  const file = registryFile(baseDir)
  const read = readPrivateFileNoFollow(file, 16 * 1024)
  if (read.kind === 'missing') {
    const evidence = registryCorruptEvidence(baseDir)
    if (evidence.length > 0) {
      throw new Error(`gateway runtime registry configuration remains quarantined (${evidence.at(-1)}); set a valid registry origin to recover`)
    }
    return DEFAULT_REGISTRY_ORIGIN
  }
  if (read.kind === 'unsafe') {
    return quarantineCorruptRegistry(baseDir, 'not a bounded single-link regular file')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.raw) as unknown
  } catch {
    return quarantineCorruptRegistry(baseDir, 'invalid JSON', read.identity)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return quarantineCorruptRegistry(baseDir, 'invalid document shape', read.identity)
  }
  const origin = (parsed as Record<string, unknown>).origin
  if (typeof origin !== 'string' || canonicalRegistryOrigin(origin) !== origin) {
    return quarantineCorruptRegistry(baseDir, 'origin is missing or non-canonical', read.identity)
  }
  return origin
}

function writeRegistryOrigin(baseDir: string, origin: string): void {
  atomicWriteRuntimeFileNoFollow(
    baseDir,
    registryFile(baseDir),
    `${JSON.stringify({ origin }, null, 2)}\n`,
  )
}

function ownerFile(stateRoot: string): string {
  return join(stateRoot, 'owner.json')
}

/**
 * Fail-loud single-process guard (design 18 §9.3): one gateway per stateDir.
 * O_EXCL exclusive create closes the read-check-write TOCTOU — a concurrent
 * second owner gets EEXIST; a stale owner whose pid is dead is taken over.
 * A takeover that cannot prove the exact moved bytes and the exact fresh
 * token fails loud. Unique stale evidence is benign and may remain after an
 * ambiguous durability failure.
 */
const processRuntimeOwnerLeases = new Set<string>()

interface RuntimeOwnerLease {
  leaseKey: string
  file: string
  token: string
  payload: string
  identity: RuntimeFileIdentity
}

function verifyFreshRuntimeOwner(file: string, payload: string): RuntimeFileIdentity {
  const proof = readPrivateFileNoFollow(file, 16 * 1024, { tightenMode: false })
  if (proof.kind !== 'valid' || proof.raw !== payload) {
    throw new Error('gateway runtime owner final proof failed; refusing writer authority')
  }
  return proof.identity
}

function restoreMovedRuntimeOwner(file: string, stale: string, movedRaw: string, movedIdentity: RuntimeFileIdentity): void {
  try {
    const current = readPrivateFileNoFollow(file, 16 * 1024, { tightenMode: false })
    if (current.kind !== 'missing') return
    quarantineRuntimeFileNoFollow(dirname(dirname(file)), stale, file, { expectedIdentity: movedIdentity })
    const restored = readPrivateFileNoFollow(file, 16 * 1024, { tightenMode: false })
    if (restored.kind !== 'valid' || restored.raw !== movedRaw) {
      throw new Error('restored owner bytes do not match')
    }
  } catch {
    // Fail-closed: the contender never enters. Exact stale/fresh evidence is
    // retained for the current owner or operator; an unproved restore must
    // never overwrite a third contender.
  }
}

function assertSingleOwner(baseDir: string, beforeStaleRename?: () => void): RuntimeOwnerLease {
  const stateRoot = assertRuntimeRootNoFollow(baseDir)
  const leaseKey = resolve(stateRoot)
  if (processRuntimeOwnerLeases.has(leaseKey)) {
    throw new Error('this process already owns the gateway runtime stateDir; refusing a second manager')
  }
  const file = ownerFile(stateRoot)
  const token = randomBytes(24).toString('hex')
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token })}\n`
  try {
    createRuntimeFileExclusiveNoFollow(baseDir, file, payload)
    const identity = verifyFreshRuntimeOwner(file, payload)
    processRuntimeOwnerLeases.add(leaseKey)
    return { leaseKey, file, token, payload, identity }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // The on-disk record is also authoritative: a same-pid owner is rejected
  // below (covering duplicate loaded copies of this module), a live foreign
  // pid fails loud, and only a dead foreign pid (ESRCH) is taken over.
  let previousPid: number
  const ownerRead = readPrivateFileNoFollow(file, 16 * 1024)
  if (ownerRead.kind !== 'valid') {
    throw new Error('gateway runtime owner record is unsafe or unreadable; refusing to take over without a proven-dead pid')
  }
  try {
    const parsed = JSON.parse(ownerRead.raw) as { pid?: unknown }
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
      throw new Error('invalid pid')
    }
    previousPid = parsed.pid
  } catch {
    throw new Error('gateway runtime owner record is corrupt; refusing to take over without a proven-dead pid')
  }
  if (previousPid === process.pid) {
    // The on-disk record is a second, independent guard. Reject even when a
    // duplicate module/bundle has its own in-memory lease Set; otherwise two
    // managers in one Node process can both write the tree and either dispose
    // can unlink the other's owner record.
    throw new Error(`this process (pid ${process.pid}) already owns the gateway runtime stateDir; refusing a second manager`)
  }
  try {
    process.kill(previousPid, 0)
    throw new Error(`another gateway process (pid ${previousPid}) owns this stateDir; dsh-runtime has no cross-process lock — refusing to start`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('another gateway process')) throw error
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`another gateway process (pid ${previousPid}) owns this stateDir; dsh-runtime has no cross-process lock — refusing to start`)
    }
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    // ESRCH: previous owner is gone — take over below.
  }
  // Atomic takeover: rename the stale record out of the way FIRST — whoever
  // renames wins, and a second taker's rename fails ENOENT (fail-loud) instead
  // of racing an unlink that could remove the winner's fresh file.
  const stale = `${file}.stale-${process.pid}-${randomBytes(8).toString('hex')}`
  let movedIdentity: RuntimeFileIdentity
  try {
    movedIdentity = quarantineRuntimeFileNoFollow(baseDir, file, stale, {
      expectedIdentity: ownerRead.identity,
      ...(beforeStaleRename === undefined ? {} : { beforeRename: beforeStaleRename }),
    })
  } catch (error) {
    const displaced = readPrivateFileNoFollow(stale, 16 * 1024, { tightenMode: false })
    if (displaced.kind === 'valid') {
      restoreMovedRuntimeOwner(file, stale, displaced.raw, displaced.identity)
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('another gateway process is starting concurrently against this stateDir; refusing to start')
    }
    throw new Error(`gateway runtime stale owner could not be durably claimed: ${sanitizeErrorText(String(error))}`)
  }
  const moved = readPrivateFileNoFollow(stale, 16 * 1024, { tightenMode: false })
  if (moved.kind !== 'valid' || moved.raw !== ownerRead.raw
    || moved.identity.dev !== movedIdentity.dev || moved.identity.ino !== movedIdentity.ino) {
    if (moved.kind === 'valid') restoreMovedRuntimeOwner(file, stale, moved.raw, moved.identity)
    throw new Error('another gateway process replaced the owner during stale takeover; refusing to start')
  }

  let freshIdentity: RuntimeFileIdentity
  try {
    createRuntimeFileExclusiveNoFollow(baseDir, file, payload)
    freshIdentity = verifyFreshRuntimeOwner(file, payload)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('another gateway process is starting concurrently against this stateDir; refusing to start')
    }
    // Fail loud (review fix): a takeover that cannot rewrite the owner record
    // must NOT continue without any owner record — that would silently disable
    // the single-process guard for this stateDir (a concurrent second gateway
    // could then run against the same stateRoot).
    throw new Error(`gateway runtime owner record could not be rewritten: ${sanitizeErrorText(String(error))}`)
  }
  try {
    removeRuntimeFileNoFollow(baseDir, stale, { expectedIdentity: moved.identity })
  } catch {
    // Unique stale evidence is non-authoritative. Retain it when cleanup
    // durability is ambiguous; fresh owner authority was already proven.
  }
  processRuntimeOwnerLeases.add(leaseKey)
  return { leaseKey, file, token, payload, identity: freshIdentity }
}

function releaseSingleOwner(baseDir: string, lease: RuntimeOwnerLease): void {
  const current = readPrivateFileNoFollow(lease.file, 16 * 1024, { tightenMode: false })
  if (current.kind !== 'valid' || current.raw !== lease.payload) {
    throw new Error('gateway runtime owner token no longer matches; refusing to release another owner')
  }
  let token: unknown
  try { token = (JSON.parse(current.raw) as { token?: unknown }).token } catch { token = null }
  if (token !== lease.token) {
    throw new Error('gateway runtime owner token no longer matches; refusing to release another owner')
  }
  removeRuntimeFileNoFollow(baseDir, lease.file, { expectedIdentity: current.identity })
}

export interface ResolvedWorkspace {
  path: string
  /** Exact version read from the effective workspace/tree, or null when an
   * external env workspace does not expose a readable exact manifest. */
  version: string | null
  source: 'env' | 'override' | 'builtin'
}

export type GatewayRuntimeStatus = RuntimeStatusProjection & {
  kind: typeof GATEWAY_RUNTIME_STATUS_KIND
  activeVersion: string | null
  builtinVersion: string | null
  currentVersion: string | null
  selectedVersion: string | null
  hasOverride: boolean
  source: 'user-selected' | 'env' | 'builtin-anchor' | null
  phase: 'installing' | 'pending' | 'applying' | 'snapshot-failed' | 'swap-attempted' | 'restore-blocked' | 'idle'
  startupBlockedReason: string | null
  pending: string | null
  connectionState: string
  registry: string | null
  registryError: string | null
  platform: NodeJS.Platform
  mutationsAllowed: boolean
  operationError: string | null
  restart: 'ok' | 'failed' | 'running' | null
  /** Last explicit start outcome (design 21 decision 12 / §6.3), projected
   * exactly like `restart`: 'running' from the moment a start is accepted
   * until it settles; 'ok'/'failed' terminal. The settings poll uses this to
   * distinguish a post-202 entry rejection (operationError set, connectionState
   * still stopped) from a genuine start success. */
  start: 'ok' | 'failed' | 'running' | null
  restoreOutcome: string | null
  snapshotCount: number | null
  latestSnapshotAt: string | null
  snapshotError: string | null
  restoreInProgress: boolean | null
  preRollbackCount: number | null
  preRollbackLatestName: string | null
  failure: { version: string; at: string; reason: string } | null
  diskUsage: RuntimeDiskSummary | null
  diskError: string | null
  diskLimitBytes: number
  diskLimitExceeded: boolean | null
  progress: RuntimeInstallProgress | null
  /** Desktop-shaped metadata health projection (2026-12 recover-metadata). */
  metadataHealth: 'unknown' | 'healthy' | 'selection-corrupt' | 'recovery-in-progress' | 'recovery-finalized' | 'recovery-marker-corrupt'
  metadataComponents: string[]
  canRecoverMetadata: boolean
}

/** Managed profile-write lease refusal codes (design 21 §6.3 decision 6/17).
 * Every code maps to an existing /chamber/runtime 409 family. */
export type ProfileWriteRefusalCode = 'runtime_busy' | 'runtime_pending' | 'runtime_recovery_required'

/** The lease handed out by GatewayRuntimeManager.beginProfileWrite(). The
 * caller holds it across its complete `dsh plugin` write and MUST release it
 * in all paths; release is idempotence-free and underflow-guarded (fail-loud). */
export type ProfileWriteLease =
  | { ok: true; release: () => void }
  | { ok: false; code: ProfileWriteRefusalCode; error: string }

export interface GatewayRuntimeManager {
  stateRoot(): string
  resolveWorkspace(): ResolvedWorkspace
  /** Candidate-tree override consulted by getDshWorkspacePath during activation. */
  transactionWorkspace: string | null
  startupTransaction(): Promise<{ blockedReason: string | null }>
  status(): Promise<GatewayRuntimeStatus>
  activationFacts(): { sourceVersion: string | null; sourceIsBuiltin: boolean; sourceWasKnownGood: boolean; knownGoodVersion: string | null }
  /** All runtime writers are single-flight, but only activation transactions
   * quarantine the already-running dsh from proxy/feature exposure. */
  mutationInProgress(): boolean
  /** Design 21 decision 6/7 execution-window accessor (wired as the A1
   * executor's canRun gate): true while any runtime mutation writer —
   * activation transaction (rollback/restore/retry), apply-now, install,
   * restart, start or the automatic restart-exhausted rollback — is in
   * flight. Same internal flag set as mutationInProgress(). */
  mutationInFlight(): boolean
  activationInProgress(): boolean
  /** Sticky public-exposure fence. Unlike activationInProgress(), this remains
   * true after an unsafe blocked verdict so recovery routes stay reachable
   * without allowing the probe-failed runtime to serve users. */
  exposureQuarantined(): boolean
  internalSpawnActive(): boolean
  /** Feed authoritative local-host state edges into the sustained-health
   * monitor. Candidate edges are ignored while activation is quarantined. */
  observeLocalState(status: string): void
  listVersions(): Promise<unknown>
  select(version: string): Promise<{ accepted: boolean; version: string }>
  apply(): Promise<{ pending: boolean }>
  /** Immediately apply the pending/staged version switch inside the current
   * session (design 18 addendum · apply-now): stop → activation transaction →
   * resume. 202 semantics — the caller receives `{ accepted: true }`
   * synchronously and the outcome is projected via status(). */
  applyNow(): Promise<{ accepted: boolean }>
  /** Synchronous apply-now gate (review fix): every manager refusal
   * (platform / busy / env / target resolution / tree validation / no-op)
   * runs here so the route answers a 409/403 BEFORE any 202 can go out —
   * a preflight throw must never be swallowed into a fake 202 whose status
   * never settles. Returns the resolved target version. */
  applyNowPreflight(): string
  rollback(version: string): Promise<{ accepted: boolean }>
  /** User-authorized cleanup of one explicitly installed version tree
   *  (desktop-parity, 2026-12): ledger-gated + protection-set re-read at the
   *  deletion point; consumes the durable store-prune marker afterwards. */
  cleanupVersion(version: string): Promise<{ version: string; removed: boolean }>
  /** Restore the newest pre-rollback stash over DSH_HOME (desktop-parity,
   *  2026-12); half leaves restore-blocked for retry-restore to resume. */
  restorePreRollback(stashName: string): Promise<{ accepted: true }>
  /** Metadata FATAL rescue (desktop-parity, 2026-12): archives corrupt
   *  selection metadata with a full DSH_HOME copy and runs the builtin
   *  anchor through the probe gate before restoring access. */
  recoverMetadata(): Promise<{ accepted: true }>
  /** True while a durable metadata-recovery transaction is pending or the
   *  recovery marker is corrupt (boot preflight gate, H1 review fix). */
  metadataRecoveryPending(): boolean
  /** Consume the durable store-prune marker if present (boot boundary, L1
   *  review fix); single-flight, marker retained on failure. */
  pruneStoreIfNeeded(): Promise<void>
  restoreBuiltin(): Promise<{ accepted: boolean }>
  /** Resume an interrupted pointer switch (swap-attempted) by re-running the
   * startup transaction; brings the managed dsh up on a clean verdict. */
  retryApply(): Promise<{ accepted: boolean; blockedReason: string | null }>
  /** Resume an interrupted snapshot restore (restore-half / restore-incomplete)
   * by re-running the startup transaction; brings the managed dsh up on a
   * clean verdict. */
  retryRestore(): Promise<{ accepted: boolean; blockedReason: string | null }>
  restart(): Promise<void>
  restartInFlight(): boolean
  /** Explicit start primitive (design 21 decision 12, §6.3 r1): bring the
   * managed dsh up from stopped/error/restart-exhausted through the plane's
   * guarded startLocal path. Refuses while any runtime mutation/profile write
   * is in flight, while a recovery block or ordinary pending is armed, and
   * while the managed dsh is already running. 202 semantics — the route
   * answers synchronously from the refusal gates; the outcome is projected via
   * status().start / operationError (resolve ≠ success). */
  start(): Promise<void>
  startInFlight(): boolean
  /** Design 21 §6.3 lifecycle writer barrier (decision 6/17): true while a
   * managed profile write lease is held. Runtime mutations (assertMutationIdle)
   * and every spawn (beforeSpawnCheckpoint) refuse while a plugin write could
   * interleave DSH_HOME/profile node_modules. */
  profileWriteInFlight(): boolean
  /** Acquire the managed profile-write lease. Synchronous: returns a refusal
   * ({ ok:false }) when a runtime transaction/mutation is in flight, when a
   * durable recovery/pending phase is armed, or while the managed dsh is
   * starting/restarting — mirroring the executor's own 409 family. Success
   * increments the write counter; the returned release() decrements it
   * (underflow-guarded). New acquisitions refuse once dispose() has started. */
  beginProfileWrite(): ProfileWriteLease
  /** True while an apply-now transaction is running (route gate + status). */
  applyNowInFlight(): boolean
  getRegistry(): { origin: string }
  setRegistry(origin: string): Promise<{ origin: string }>
  dispose(): Promise<void>
}

export interface GatewayRuntimeManagerOptions {
  config: GatewayConfig
  plane: PlaneHandle
  logger: Logger
  /** Host-side probe seam. Production executes the complete shared probe
   * list; tests may inject the resulting closed ProbeResult set without
   * opening a real dsh socket. The activation decision remains shared-core. */
  probeCandidate?: (input: {
    version: string
    isBuiltin: boolean
    baseUrl: string
    dshHome: string
    signal?: AbortSignal
  }) => Promise<ProbeResult[]>
  /** Registry fetch seam for deterministic offline/cache tests. */
  fetchMetadata?: typeof fetchRegistryMetadata
  /** Delayed-verdict seam; production keeps the shared two-second delay. */
  waitBeforeRetry?: StartupDeps['waitBeforeRetry']
  /** Sustained-health clock/scheduler seams. Production uses wall clock plus
   * an unref'ed hourly tick; tests can advance the full 24h policy exactly. */
  nowMs?: () => number
  scheduleKnownGoodPromotion?: (callback: () => void) => () => void
  /** Platform adapter seam. Production omits this and uses process.platform;
   * tests use it to prove Windows stays entirely outside POSIX writer paths. */
  platform?: NodeJS.Platform
  /** Rollback-vs-lease drain bound override (tests only; production keeps
   * ROLLBACK_LEASE_WAIT_MS = 15 minutes). */
  rollbackLeaseWaitMs?: number
  /** Deterministic stale-takeover race seam; production callers omit it. */
  ownerTakeoverBeforeRename?: () => void
  /** Host composition hook: detach dsh-derived consumers as soon as an
   * activation quarantine opens, and explicitly resync them after the verdict.
   * Candidate ready edges can otherwise be consumed before the probe decides. */
  onActivationQuarantineChange?: (active: boolean) => void
}

export function createGatewayRuntimeManager(options: GatewayRuntimeManagerOptions): GatewayRuntimeManager {
  const { config, plane, logger } = options
  // baseDir feeds the shared core (which appends `dsh-runtime`); stateRoot is
  // that same directory, used for gateway-owned files and tree paths.
  const baseDir = config.plane.stateDir
  const platform = options.platform ?? process.platform
  // Windows is an explicitly read-only projection. Do not even enter the
  // POSIX O_NOFOLLOW/O_DIRECTORY writer primitives: Node does not expose
  // equivalent open flags there and a read-only manager must still start.
  const stateRoot = platform === 'win32'
    ? join(baseDir, 'dsh-runtime')
    : ensureRuntimeRootNoFollow(baseDir)
  const dshHome = join(baseDir, 'dsh-home')
  const anchor = config.plane.dshWorkspacePath
  const envPath = process.env.DSH_GATEWAY_DSH_PATH?.trim() || null
  const shellVersion = GATEWAY_PACKAGE_VERSION
  const builtinVersion = readBuiltinVersion(anchor)
  const nowMs = options.nowMs ?? Date.now

  const ownerLease = platform === 'win32'
    ? null
    : assertSingleOwner(baseDir, options.ownerTakeoverBeforeRename)

  let internalSpawn = false
  let activationDepth = 0
  let installInFlight = false
  /** Synchronous edge latch for Design 18 F7. It is armed before the
   * detached rollback promise yields, so repeated restart-exhausted
   * notifications cannot enqueue two writers. */
  let restartExhaustedRollbackInFlight = false
  /** Design 21 §6.3 managed profile-write lease counter (decision 6/17). A
   * count (not a bool) lets the A1 executor nest per-operation acquisitions
   * inside a wider queue-drain lease; the barrier opens only at zero. Runtime
   * writers refuse while it is non-zero and beginProfileWrite refuses while
   * any runtime writer is live, so the two write families never interleave. */
  let profileWriteCount = 0
  /** Waiter set for the rollback-vs-lease drain (release() resolves waiters
   * at zero; waiters are removed by their own completion). */
  const profileWriteIdleWaiters = new Set<() => void>()
  /** Lifecycle writer barrier. Every public mutation is tracked through its
   * complete promise (including post-installer metadata writes), while the
   * abort signal reaches candidate probes/install children. dispose() retains
   * owner.json until both sets are demonstrably quiescent. */
  let disposed = false
  const lifecycleAbort = new AbortController()
  const activeOperations = new Set<Promise<unknown>>()
  let disposePromise: Promise<void> | null = null
  let localHealthWindowOpen = false
  /** Last select/restart failure, surfaced in status (R7 review: async job
   *  failures must stay observable; cleared by the next successful action). */
  let operationError: string | null = null
  let installProgress: RuntimeInstallProgress | null = null
  const DISK_CACHE_TTL_MS = 30_000
  let diskCache: {
    checkedAt: number
    usage: RuntimeDiskSummary | null
    error: string | null
  } | null = null

  function invalidateDiskCache(): void {
    diskCache = null
  }

  function diskProjection(force = false): { usage: RuntimeDiskSummary | null; error: string | null } {
    const now = Date.now()
    if (!force && diskCache !== null && now - diskCache.checkedAt < DISK_CACHE_TTL_MS) {
      return { usage: diskCache.usage, error: diskCache.error }
    }
    try {
      const usage = runtimeDiskSummary(baseDir, dshHome)
      diskCache = { checkedAt: now, usage, error: null }
    } catch (error) {
      diskCache = {
        checkedAt: now,
        usage: null,
        error: sanitizeRouteError(error instanceof Error ? error.message : String(error)),
      }
    }
    return { usage: diskCache.usage, error: diskCache.error }
  }

  const pnpmEntry = (): string => {
    // Bundled shape first (design 18 §9.2 D1): the installer's local
    // (default) path unpacks the gateway tarball and NEVER installs gateway
    // dependencies, so `gatewayRequire.resolve('pnpm')` below cannot hit a
    // real node_modules tree there. scripts/build.mjs copies the pinned pnpm
    // into dist/pnpm (dereferenced); prefer it whenever the build carried it
    // (desktop parity: extraResources). NOTE: dist/pnpm sits next to this
    // bundled module, so derive the path with fileURLToPath — path.dirname
    // over a file:// URL would mangle the path.
    const bundledPnpm = join(dirname(fileURLToPath(import.meta.url)), 'pnpm', 'bin', 'pnpm.cjs')
    if (existsSync(bundledPnpm)) return bundledPnpm
    // Dev / npm-installed shape: pnpm is a real runtime dependency of
    // @dsh-chamber/gateway; resolve from the gateway package root (pnpm itself
    // has no install scripts). NOTE: pnpm's package.json `exports` hides
    // `./bin/pnpm.cjs` (subpath not exported — ERR_PACKAGE_PATH_NOT_EXPORTED),
    // so resolve the package entry (…/pnpm/package.json) and join the bin path
    // by hand.
    return join(dirname(gatewayRequire.resolve('pnpm')), 'bin', 'pnpm.cjs')
  }

  let transactionWorkspace: string | null = null

  /** Store-prune executor (2026-12 parity fix): the shared core leaves a
   *  durable `store-prune-needed` marker after explicit cleanup/eviction;
   *  desktop consumes it (main.ts runStorePruneIfNeeded) but the gateway had
   *  no consumer, so the pnpm store only ever grew. Single-flight, marker
   *  retained on failure (retried by the next cleanup/operation). */
  let storePruneOperation: Promise<void> | null = null
  const runStorePruneIfNeeded = (): Promise<void> => {
    if (storePruneOperation !== null) return storePruneOperation
    if (disposed || readStorePruneRequest(baseDir) === null) return Promise.resolve()
    const operation = pruneRuntimeStore({
      baseDir,
      pnpmEntry: pnpmEntry(),
      deps: {
        // The gateway has no Electron-as-node branch: plain node (design 18
        // §9.2: the gateway install chain is pure node).
        node: () => ({ file: process.execPath, args: [], env: {} }),
      },
    })
      .then(() => { clearStorePruneRequest(baseDir) })
      .catch((error: unknown) => {
        // Retain the marker: the next safe cleanup/startup retries. Prune
        // failure is disk hygiene, not permission to block a verified tree.
        logger.warn(`gateway runtime store prune failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`)
      })
      .finally(() => {
        if (storePruneOperation === operation) storePruneOperation = null
      })
    storePruneOperation = operation
    return operation
  }

  function notifyActivationQuarantine(active: boolean): void {
    try {
      options.onActivationQuarantineChange?.(active)
    } catch (error) {
      // Runtime safety must not be rolled back because an optional derived
      // feature consumer failed to resync. The gateway lifecycle logs and can
      // retry attachment on the next authoritative local-state transition.
      logger.warn(`gateway runtime activation resync failed: ${sanitizeErrorText(String(error))}`)
    }
  }

  function beginActivation(): void {
    activationDepth += 1
    if (activationDepth === 1) notifyActivationQuarantine(true)
  }

  function endActivation(): void {
    if (activationDepth <= 0) throw new Error('gateway runtime activation gate underflow')
    activationDepth -= 1
    // Disposal is a permanent quarantine for this manager. A rollback probe
    // may honestly finish after the lifecycle abort, but its endActivation()
    // must never publish a false "open" edge while the final stop proof is
    // still pending (or after an unsafe disposal retained ownership).
    if (activationDepth === 0 && !disposed) notifyActivationQuarantine(false)
  }

  function requireBuiltinVersion(): string {
    const actual = readBuiltinVersion(anchor)
    if (builtinVersion === null || actual !== builtinVersion) {
      throw new Error('gateway builtin dsh anchor does not expose a stable exact @deepseek-ai/dsh version')
    }
    return builtinVersion
  }

  /** env → matching active override/current → builtin anchor (design 18
   * §3.5/§9.3). Corrupt or contradictory selection metadata is never treated
   * as an absent override; callers fail loud instead of spawning builtin over
   * user-migrated DSH_HOME without a transaction. */
  function resolveWorkspace(): ResolvedWorkspace {
    if (envPath !== null) return { path: envPath, version: readBuiltinVersion(envPath), source: 'env' }
    if (platform === 'win32') {
      return { path: anchor, version: builtinVersion, source: 'builtin' }
    }
    const pointerState = readCurrentPointerState(baseDir)
    const overrideState = readOverrideState(baseDir)
    if (pointerState.kind === 'corrupt') throw new Error('gateway runtime current pointer is corrupt')
    if (overrideState.kind === 'corrupt') throw new Error('gateway runtime override metadata is corrupt')
    const pointer = pointerState.kind === 'valid' ? pointerState.version : null
    const override = overrideState.kind === 'valid' ? overrideState.record : null
    const overrideActive = override !== null && !shouldInvalidate(override, shellVersion)
    if (overrideActive && pointer !== null) {
      if (!listValidVersionTrees(baseDir).includes(pointer)) {
        throw new Error(`gateway runtime current tree ${pointer} is invalid`)
      }
      return { path: join(stateRoot, pointer), version: pointer, source: 'override' }
    }
    if (pointer !== null) {
      throw new Error('gateway runtime current pointer has no matching active override')
    }
    if (overrideActive) {
      // Gateway select and apply are separate actions. `selectedOnly` is the
      // crash-durable proof that a valid cached/installed choice is merely
      // staged while builtin remains active. Absence/false stays fail-closed:
      // an applied user override whose current pointer disappeared must never
      // silently boot builtin over potentially migrated DSH_HOME.
      const stagedSelection = override.selectedOnly === true
        && override.pending === null
        && override.chosenVersion !== null
        && override.resolvedVersion !== null
        && override.swapAttempted === false
        && override.lastOutcome == null
      const builtinIsAuthoritative = stagedSelection
        || override.pending !== null
        || override.chosenVersion === null
        || override.resolvedVersion === null
        || override.lastOutcome === 'rolled-back'
        || override.lastOutcome === 'failed'
      if (!builtinIsAuthoritative) {
        throw new Error('gateway user runtime override is missing its authoritative current pointer')
      }
    }
    return { path: anchor, version: builtinVersion, source: 'builtin' }
  }

  async function spawnAndProbeCandidate(version: string, isBuiltin: boolean, hostDomains: boolean, signal?: AbortSignal): Promise<ProbeResult[]> {
    const target = isBuiltin ? anchor : join(stateRoot, version)
    transactionWorkspace = target
    internalSpawn = true
    try {
      await plane.startLocal()
      const port = plane.getLocalDshPort()
      if (port === null || !Number.isInteger(port)) throw new Error('managed dsh did not reach readiness for runtime probes')
      const baseUrl = `http://127.0.0.1:${port}`
      return options.probeCandidate !== undefined
        ? await options.probeCandidate({ version, isBuiltin, baseUrl, dshHome, signal })
        : await runRuntimeActivationProbes({
            baseUrl,
            dshHome,
            signal,
            // 2026-12 Phase 3 shape gate: a gateway whose seed cache holds no
            // synced chamber host packages hosts a plain dsh — the activation
            // probe skips the chamber host domains until a desktop syncs.
            // The shape is snapshot ONCE per startup transaction (see
            // buildStartupDeps): probe set and verdict-expected set must
            // always agree, or an exact-set drift would spuriously fail a
            // healthy activation.
            hostDomains,
            call: async (url, method, payload, opts) => {
              const response = await dshCall(url, method, payload, { signal: opts?.signal, timeoutMs: opts?.timeoutMs })
              return { result: response.result }
            },
          })
    } finally {
      internalSpawn = false
      transactionWorkspace = null
    }
  }

  /** Env-override activation probe (A-U2 desktop parity): spawn the env
   *  workspace through the plane and run the shared activation probe set
   *  against it. Returns null when every probe passed, otherwise a
   *  sanitized failure summary. The probe engine converts transport/timeout
   *  failures into per-probe ok:false results, so the production path does
   *  not throw; only an injected `probeCandidate` seam may throw, and its
   *  callers treat that as a surfaced error (it is a test-only injection).
   *  The probe shape applies the same
   *  hostDomains gate as managed-tree probes (chamber host domains are only
   *  expected once a desktop sync exists), snapshot ONCE per env boot. */
  async function probeEnvOverrideRuntime(signal?: AbortSignal): Promise<string | null> {
    // Env resolution happens through resolveWorkspace(), so the
    // transactionWorkspace override must stay unset for this spawn.
    transactionWorkspace = null
    internalSpawn = true
    try {
      try {
        await plane.startLocal()
      } catch (error) {
        return `managed dsh did not reach readiness for env runtime probes: ${sanitizeErrorText(String(error))}`
      }
      const port = plane.getLocalDshPort()
      if (port === null || !Number.isInteger(port)) {
        return 'managed dsh did not publish a probe port for the env runtime'
      }
      const baseUrl = `http://127.0.0.1:${port}`
      const probes = options.probeCandidate !== undefined
        ? await options.probeCandidate({
            // This branch only runs under env override, so envPath is set;
            // the seam type requires a string, so an empty fallback is a
            // shape-only impossibility.
            version: envPath ?? '',
            isBuiltin: false,
            baseUrl,
            dshHome,
            signal,
          })
        : await runRuntimeActivationProbes({
            baseUrl,
            dshHome,
            signal,
            hostDomains: hasSyncedHostSeed(config.plane.stateDir),
            call: async (url, method, payload, opts) => {
              const response = await dshCall(url, method, payload, { signal: opts?.signal, timeoutMs: opts?.timeoutMs })
              return { result: response.result }
            },
          })
      const failed = probes.filter(probe => !probe.ok)
      return failed.length === 0
        ? null
        : failed.map(probe => `${probe.name}${probe.error === undefined ? '' : `: ${sanitizeErrorText(probe.error)}`}`).join('; ')
    } finally {
      internalSpawn = false
    }
  }

  function activationFacts(): { sourceVersion: string | null; sourceIsBuiltin: boolean; sourceWasKnownGood: boolean; knownGoodVersion: string | null } {
    if (platform === 'win32') {
      return {
        sourceVersion: builtinVersion,
        sourceIsBuiltin: true,
        sourceWasKnownGood: true,
        knownGoodVersion: null,
      }
    }
    const pointer = readCurrentPointer(baseDir)
    const knownGood = listKnownGoodVersions(baseDir)
    const record = readOverride(baseDir)
    return {
      // The builtin anchor contributes its REAL semver as the snapshot source
      // (F1): apply-phase rejects a null sourceVersion as snapshot-failed, so
      // the very first install from the anchor would otherwise never switch.
      sourceVersion: pointer === null ? builtinVersion : pointer,
      sourceIsBuiltin: pointer === null,
      sourceWasKnownGood: pointer === null || knownGood.includes(pointer)
        || (record?.lastOutcome === 'applied' && record.resolvedVersion === pointer),
      knownGoodVersion: latestKnownGood(baseDir, pointer),
    }
  }

  function buildStartupDeps(): StartupDeps {
    // 2026-12 Phase 3 shape gate: the probe shape is snapshot ONCE per
    // startup transaction. A desktop sync landing mid-transaction must not
    // flip one side (hostDomains) while the verdict expects the other set
    // (probeExpectedNames) — exact-set drift would spuriously fail/roll back
    // a healthy activation. The next transaction re-evaluates the cache, so
    // a mid-transaction sync applies on the following activation (bounded,
    // fail-closed false negative).
    const hostSeedSynced = hasSyncedHostSeed(config.plane.stateDir)
    return {
      cleanupStaleInstalls: () => cleanupStaleInstalls(baseDir),
      evict: () => evictVersions(baseDir),
      completeInterruptedRestore: () => completeInterruptedRestore(baseDir, dshHome),
      readOverrideState: (): OverrideState => readOverrideState(baseDir),
      writeOverride: (record) => writeOverride(baseDir, record),
      deleteOverride: () => deleteOverride(baseDir),
      readCurrentPointerState: (): CurrentPointerState => readCurrentPointerState(baseDir),
      readActivationJournal: (): ActivationJournalState => readActivationJournalState(baseDir),
      writeActivationJournal: (journal) => writeActivationJournal(baseDir, journal),
      clearActivationJournal: () => clearActivationJournal(baseDir),
      envOverrideActive: () => envPath !== null,
      shellVersion,
      builtinVersion: requireBuiltinVersion(),
      activationFacts,
      snapshot: (sourceVersion) => snapshotDshHome(baseDir, dshHome, sourceVersion),
      resolveSnapshotName: (snapshotName) => resolveSnapshotName(baseDir, snapshotName),
      prepareManualRollback: (targetVersion) => prepareManualRollbackData(baseDir, dshHome, targetVersion),
      validateTarget: (version, isBuiltin) => {
        if (isBuiltin) {
          return version === builtinVersion && readBuiltinVersion(anchor) === builtinVersion
            ? { ok: true as const }
            : { ok: false as const, error: 'builtin anchor manifest does not match the activation target' }
        }
        return listValidVersionTrees(baseDir).includes(version)
          ? { ok: true as const }
          : { ok: false as const, error: `no valid version tree for ${version}` }
      },
      switchPointer: (version) => {
        if (version === null) {
          clearCurrentPointer(baseDir)
        } else {
          writeCurrentPointer(baseDir, version)
        }
      },
      spawnAndProbe: (version, isBuiltin, signal) => spawnAndProbeCandidate(version, isBuiltin, hostSeedSynced, signal),
      probeExpectedNames: hostSeedSynced ? undefined : PROBE_NAMES_WITHOUT_HOST_DOMAINS,
      stopHost: async () => { await plane.stopLocal() },
      restore: (snapshotPath) => restoreSnapshot(baseDir, dshHome, snapshotPath),
      recordProbePass: (version) => recordProbePass(baseDir, version),
      recordFailure: (input) => recordRuntimeFailure(baseDir, input),
      ...(options.waitBeforeRetry !== undefined ? { waitBeforeRetry: options.waitBeforeRetry } : {}),
    }
  }

  let startupBlockReason: string | null = null

  async function executeStartupTransaction(signal: AbortSignal = lifecycleAbort.signal): Promise<Awaited<ReturnType<typeof runStartupPhase>>> {
    // Persisted wall time is not uptime. Every startup/activation transaction
    // closes the prior process-health window; the first authoritative ready
    // edge after the verdict opens a new boot-qualified window.
    try {
      resetCandidateHealthWindow(baseDir, nowMs())
      localHealthWindowOpen = false
    } catch (error) {
      logger.warn(`gateway runtime known-good health reset failed: ${sanitizeErrorText(String(error))}`)
    }
    // F4 shell-upgrade fallback (design 18 §3.5): a durable invalidation
    // means the fallback verdict already committed; only a newly observed
    // shell-version mismatch starts the shell-invalidation transaction.
    if (envPath === null) {
      const record = readOverride(baseDir)
      const existingJournal = readActivationJournalState(baseDir)
      if (record !== null && record.invalidatedAt == null && record.shellVersion !== shellVersion
        && existingJournal.kind === 'missing') {
        writeActivationIntent(baseDir, {
          targetVersion: requireBuiltinVersion(),
          targetIsBuiltin: true,
          manualRollback: false,
          intentKind: 'shell-invalidation',
        })
        writeOverride(baseDir, invalidate(record, `gateway shell updated to ${shellVersion}`))
      }
    }
    const startup = await runStartupPhase(buildStartupDeps(), signal)
    // The shared core reports `env-override` as a deliberate bypass marker so
    // persisted pending is not touched. For the gateway host this is a healthy
    // startup outcome only AFTER the env runtime has passed the activation
    // probe gate: env is the highest-priority active runtime, but it is also
    // the one selection the core NEVER probes itself (no activation
    // transaction runs for it). Desktop parity (A-U2): the desktop opens an
    // env boot only when the full current-runtime probe set passes; the
    // gateway previously normalized env-override to healthy with no probe at
    // all, so a runtime that answered the control-plane health check but
    // lacked required features was exposed and marked healthy. Probe the env
    // runtime here; a failed probe keeps the managed dsh stopped with an
    // honest blocked verdict (resume: fix the DSH_GATEWAY_DSH_PATH target and
    // restart the gateway — the next startup transaction re-probes).
    if (startup.blockedReason === 'env-override') {
      const probeFailure = await probeEnvOverrideRuntime(signal)
      if (probeFailure !== null) {
        await plane.stopLocal()
        invalidateDiskCache()
        startupBlockReason = 'env-probe-failed'
        operationError = `env runtime activation probes failed: ${probeFailure}`
        logger.error(`gateway env-override runtime activation probes failed: ${probeFailure}`)
        // Synthetic blocked reason outside the shared core's union. The
        // startupTransaction composition boundary (index.ts) treats it as a
        // terminal boot block, but it can also surface through the resume
        // paths that run startup transactions under env (retry-restore and
        // restore-pre-rollback are env-allowed data-restore continuations) —
        // those callers MUST preserve the verdict, never clear it.
        return {
          ...startup,
          blockedReason: 'env-probe-failed',
        } as unknown as Awaited<ReturnType<typeof runStartupPhase>>
      }
    }
    const result = startup.blockedReason === 'env-override'
      ? { ...startup, blockedReason: null }
      : startup
    invalidateDiskCache()
    startupBlockReason = result.blockedReason
    if (result.blockedReason !== null) {
      logger.error(`gateway runtime startup blocked: ${result.blockedReason}`)
    }
    // A probe may leave its candidate/fallback process in `ready` even when
    // the transaction's durable verdict is blocked. Stop it before the owning
    // activation scope calls endActivation(); otherwise that open-quarantine
    // callback can reattach features and the root proxy to a probe-failed
    // runtime. snapshot-failed is the one safe exception: it is decided before
    // pointer mutation and callers intentionally restart the unchanged source.
    if (result.blockedReason !== null && result.blockedReason !== 'snapshot-failed') {
      await plane.stopLocal()
    }
    // Snapshot bounding (desktop parity): the desktop main process runs the
    // shared retention prune after every runtime startup operation; this
    // gateway never did, so every activation/rollback snapshot accumulated
    // without bound against the 10 GiB logical disk limit. Every
    // snapshot-creating transaction funnels through this function (boot,
    // apply-now, restore-builtin and the automatic restart-exhausted
    // rollback), so one call here closes the gap for all of them. It runs
    // INSIDE the activation window (single-flight) and never fails the
    // transaction — a prune error is logged and bounded at the next one.
    await maintenanceSnapshotPrune()
    return result
  }

  /**
   * Run the shared dsh-runtime bounded-maintenance routine (artifact
   * cleanup → retention state → pruneSnapshots; keepRecentUnprotected 3, the
   * same policy as the desktop owner). Fail-closed outcomes (restore marker
   * present, corrupt retention metadata) preserve every snapshot and are
   * logged, never silent. Never throws — transaction tails must not fail
   * because maintenance hiccuped.
   */
  async function maintenanceSnapshotPrune(): Promise<void> {
    try {
      const maintenance = await pruneRuntimeSnapshots(baseDir, dshHome, 3)
      if (maintenance.removedSnapshots.length > 0
        || maintenance.artifactCleanup.removedTemporaryEntries.length > 0
        || maintenance.artifactCleanup.removedRestoreBackups.length > 0) {
        logger.log(
          `gateway runtime snapshot maintenance removed ${maintenance.removedSnapshots.length} snapshot(s), ${maintenance.artifactCleanup.removedTemporaryEntries.length} temporary entr${maintenance.artifactCleanup.removedTemporaryEntries.length === 1 ? 'y' : 'ies'} and ${maintenance.artifactCleanup.removedRestoreBackups.length} restore backup(s)`,
        )
      }
      if (maintenance.artifactCleanup.restoreBackupCleanup !== 'completed') {
        logger.warn(`gateway runtime restore-backup cleanup skipped: ${maintenance.artifactCleanup.restoreBackupCleanup}`)
      } else if (maintenance.skippedReason === 'retention-corrupt') {
        logger.warn('gateway runtime snapshot retention metadata is corrupt; snapshots preserved (fail closed)')
      }
    } catch (error) {
      logger.warn(`gateway runtime snapshot maintenance failed (bounded at the next transaction): ${sanitizeErrorText(String(error))}`)
    }
  }

  async function startupTransaction(): Promise<{ blockedReason: string | null }> {
    assertMutationIdle()
    if (platform === 'win32') {
      startupBlockReason = null
      return { blockedReason: null }
    }
    beginActivation()
    try {
      return { blockedReason: (await executeStartupTransaction()).blockedReason }
    } finally {
      endActivation()
    }
  }

  // ---------------------------------------------------------------------------
  // /chamber/runtime actions (design 18 §9.3 route table)
  // ---------------------------------------------------------------------------

  function activationInProgress(): boolean {
    // `disposed` is intentionally sticky: once lifecycle quiescence starts,
    // this manager can never expose or start the managed runtime again. This
    // also keeps exposure closed when a rollback probe ends before dispose()'s
    // final stopLocal() barrier.
    return disposed || activationDepth > 0
  }

  function exposureQuarantined(): boolean {
    // Snapshot failure happens before the pointer is touched; callers may
    // safely restart the unchanged source after the activation window closes.
    // Every other startup block is an unresolved recovery/authority verdict
    // and must remain quarantined until a retry transaction clears it.
    return activationInProgress()
      || (startupBlockReason !== null && startupBlockReason !== 'snapshot-failed')
  }

  function mutationInProgress(): boolean {
    return activationInProgress() || installInFlight || restartInFlight || applyNowInFlight
      || restartExhaustedRollbackInFlight || startInFlight
  }

  function persistedPendingVersion(): string | null {
    if (envPath !== null || platform === 'win32') return null
    const state = readOverrideState(baseDir)
    if (state.kind === 'corrupt') throw new Error('gateway runtime override metadata is corrupt')
    if (state.kind !== 'valid' || shouldInvalidate(state.record, shellVersion) || state.record.pending === null) return null
    return state.record.pending
  }

  function ordinaryPendingVersion(): string | null {
    const pending = persistedPendingVersion()
    if (pending === null) return null
    const state = readOverrideState(baseDir)
    if (state.kind !== 'valid') return null
    // These are explicit recovery phases with their own Design 18 actions,
    // not the normal installed/pending terminal state.
    if (state.record.swapAttempted === true || state.record.lastOutcome === 'snapshot-failed'
      || startupBlockReason === 'swap-attempted' || startupBlockReason === 'snapshot-failed'
      || startupBlockReason === 'restore-half' || startupBlockReason === 'restore-incomplete') return null
    return pending
  }

  function assertNoOrdinaryPending(): void {
    const pending = ordinaryPendingVersion()
    if (pending !== null) {
      throw Object.assign(new Error(`runtime version ${pending} is pending; only restore-builtin is allowed until the next startup`), {
        code: 'runtime_pending',
      })
    }
  }

  function assertNoPending(): void {
    const pending = persistedPendingVersion()
    if (pending !== null) {
      throw Object.assign(new Error(`runtime version ${pending} is pending; only restore-builtin is allowed until the next startup`), {
        code: 'runtime_pending',
      })
    }
  }

  function assertMutationIdle(): void {
    if (disposed) throw Object.assign(new Error('gateway runtime manager is disposing'), { code: 'runtime_disposed' })
    if (activationInProgress()) throw Object.assign(new Error('runtime activation in progress'), { code: 'runtime_busy' })
    if (installInFlight) throw Object.assign(new Error('a runtime install is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (restartInFlight) throw Object.assign(new Error('a restart is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    // Review fix: apply-now is a full writer fence from the moment it is
    // accepted (applyNowInFlight=true) — before that the fence only existed
    // via activationDepth, which is a timing coincidence, not a contract.
    if (applyNowInFlight) throw Object.assign(new Error('an apply-now transaction is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (restartExhaustedRollbackInFlight) {
      throw Object.assign(new Error('an automatic restart-exhausted rollback is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    }
    if (startInFlight) {
      throw Object.assign(new Error('a start is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    }
    // Design 21 §6.3 (decision 6/17): a managed profile write (plugin add/
    // remove pnpm child) must never interleave a runtime transaction — every
    // runtime writer is a DSH_HOME/profile writer too (snapshot/restore/seed).
    if (profileWriteInFlight()) {
      throw Object.assign(new Error('managed profile write in flight (plugin mutation); runtime mutations are refused'), { code: 'runtime_busy' })
    }
  }

  /**
   * Design 21 §6.3 profile-write gate (decision 6/17): the synchronous refusal
   * matrix beginProfileWrite() answers with. Order mirrors assertMutationIdle
   * (in-flight writers) → durable recovery/pending phases → live plane window,
   * so the executor's 409 family stays consistent with the route table.
   * Corrupt selection metadata is a hard recovery condition, never an
   * acquisition: a plugin write must not land mid-recovery-authority work.
   */
  function profileWriteRefusal(): { code: ProfileWriteRefusalCode; error: string } | null {
    if (disposed) return { code: 'runtime_busy', error: 'gateway runtime manager is disposing; managed profile write refused' }
    if (activationInProgress()) return { code: 'runtime_busy', error: 'runtime activation in progress; managed profile write refused' }
    if (installInFlight) return { code: 'runtime_busy', error: 'a runtime install is in flight; managed profile write refused' }
    if (restartInFlight) return { code: 'runtime_busy', error: 'a restart is in flight; managed profile write refused' }
    if (applyNowInFlight) return { code: 'runtime_busy', error: 'an apply-now transaction is in flight; managed profile write refused' }
    // The F7 latch is armed SYNCHRONOUSLY before its async body drains/
    // waits, so this refusal covers the whole rollback window (including the
    // lease-drain wait): no new lease can ever start mid-rollback.
    if (restartExhaustedRollbackInFlight) {
      return { code: 'runtime_busy', error: 'an automatic restart-exhausted rollback is in flight; managed profile write refused' }
    }
    if (startInFlight) return { code: 'runtime_busy', error: 'a start is in flight; managed profile write refused' }
    // Recovery states expose only their matching retry (recover-metadata for
    // FATAL); restore-builtin applies to pending/healthy selections only — a
    // plugin write is not on that surface and must not slip past it.
    if (startupBlockReason !== null) {
      return {
        code: 'runtime_recovery_required',
        error: `runtime recovery ${startupBlockReason} is required; resume via the matching retry route (restore-builtin applies to pending or healthy selections only)`,
      }
    }
    let pending: string | null = null
    try {
      pending = ordinaryPendingVersion()
    } catch (error) {
      return {
        code: 'runtime_recovery_required',
        error: `runtime selection metadata is corrupt; managed profile write refused until recovery: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`,
      }
    }
    if (pending !== null) {
      return { code: 'runtime_pending', error: `runtime version ${pending} is pending; only restore-builtin is allowed until the next startup` }
    }
    const connectionState = plane.connectionState
    if (connectionState === 'starting' || connectionState === 'restarting') {
      return { code: 'runtime_busy', error: `managed dsh is ${connectionState}; managed profile write refused until it settles` }
    }
    return null
  }

  function profileWriteInFlight(): boolean {
    return profileWriteCount > 0
  }

  function releaseProfileWrite(): void {
    if (profileWriteCount <= 0) throw new Error('gateway runtime profile write lease underflow')
    profileWriteCount -= 1
    // Release only decrements, so a release that lands after dispose() still
    // opens the barrier and resolves waiters — dispose() additionally aborts
    // any pending wait so shutdown never stalls behind an undrained lease.
    if (profileWriteCount === 0 && profileWriteIdleWaiters.size > 0) {
      for (const wake of [...profileWriteIdleWaiters]) wake()
    }
  }

  /**
   * Internal rollback-vs-lease wait: resolves 'idle' the moment the
   * profile-write counter hits zero, 'timeout' when timeoutMs elapses or the
   * lifecycle abort fires. Never rejects. New acquisitions are refused while
   * the F7 latch is armed (profileWriteRefusal), so the count can only fall
   * during this wait.
   */
  function waitForProfileWriteIdle(timeoutMs: number): Promise<'idle' | 'timeout'> {
    if (lifecycleAbort.signal.aborted || !profileWriteInFlight()) {
      return Promise.resolve(lifecycleAbort.signal.aborted ? 'timeout' : 'idle')
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      const onAbort = (): void => finish('timeout')
      function finish(outcome: 'idle' | 'timeout'): void {
        clearTimeout(timer)
        profileWriteIdleWaiters.delete(wake)
        lifecycleAbort.signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      function wake(): void {
        if (!profileWriteInFlight()) finish('idle')
      }
      profileWriteIdleWaiters.add(wake)
      lifecycleAbort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  function beginProfileWrite(): ProfileWriteLease {
    const refusal = profileWriteRefusal()
    if (refusal !== null) return { ok: false, code: refusal.code, error: refusal.error }
    profileWriteCount += 1
    return {
      ok: true,
      release: () => {
        releaseProfileWrite()
      },
    }
  }

  function assertManagerReadable(): void {
    if (disposed) {
      throw Object.assign(new Error('gateway runtime manager is disposed'), { code: 'runtime_disposed' })
    }
  }

  function internalSpawnActive(): boolean {
    return internalSpawn
  }

  /**
   * Design 18 F7 is emitted by the control-plane restart loop, not by a
   * runtime route. Arm a synchronous latch, then join the manager's existing
   * writer epoch before re-reading every durable/host authority. The initial
   * microtask is intentional: restartLocal() can synchronously publish its
   * terminal edge before the public restart promise has reached
   * trackOperation().
   */
  function scheduleRestartExhaustedRollback(): void {
    if (disposed || platform === 'win32' || envPath !== null || restartExhaustedRollbackInFlight
      || plane.connectionState !== 'restart-exhausted') return

    // Fast-path non-triggering sources before arming the writer latch. The
    // durable state is still re-read after joining prior operations below;
    // this check only guarantees builtin/env restart exhaustion remains a
    // pure host-lifecycle fact with no runtime mutation epoch at all.
    try {
      const observed = resolveWorkspace()
      if (observed.source !== 'override' || observed.version === null) return
    } catch (error) {
      logger.warn(`gateway runtime restart-exhausted observation failed: ${sanitizeErrorText(String(error))}`)
      return
    }

    restartExhaustedRollbackInFlight = true
    const rollbackLeaseWaitMs = options.rollbackLeaseWaitMs ?? ROLLBACK_LEASE_WAIT_MS
    let operation!: Promise<void>
    let rollbackDurablyLatched = false
    operation = (async () => {
      await Promise.resolve()

      // A settling writer may enqueue another tracked tail. Drain all OTHER
      // operations to a fixed point while the F7 latch refuses new mutations;
      // exclude this operation itself to avoid a self-wait deadlock.
      while (true) {
        const blockers = [...activeOperations].filter(candidate => candidate !== operation)
        if (blockers.length === 0) break
        await Promise.allSettled(blockers)
      }

      // Authority may have changed while an already-accepted writer settled.
      // F7 is legal only for the still-active override at an authoritative
      // restart-exhausted terminal state; builtin/env never mutate metadata.
      if (disposed || lifecycleAbort.signal.aborted || envPath !== null
        || plane.connectionState !== 'restart-exhausted') return
      const active = resolveWorkspace()
      if (active.source !== 'override' || active.version === null) return

      // Rollback-vs-lease serialization (design 21 §6.3 decision 6/17, F7
      // review gate): the transaction's restore step writes DSH_HOME BEFORE
      // the only lease-aware point (the spawn checkpoint inside
      // plane.startLocal) — a plugin mutation whose pnpm child is live under
      // a held profile-write lease must drain first, or this rollback would
      // write DSH_HOME under a concurrent writer. New leases cannot start
      // while this latch is armed (beginProfileWrite refusal matrix below),
      // so the wait only drains already-held leases. A lease that outlives
      // the bound DEFERS the rollback with NO writes: the instance stays in
      // restart-exhausted with its existing honest projection and
      // start remains available; restore-builtin stays restricted to
      // pending/healthy selections (2026 audit R2 — recovery-marked states
      // expose only their matching retry). The next restart-exhausted
      // edge (or gateway restart) re-arms it. dispose() aborts the wait, so
      // shutdown never stalls behind an undrained lease even though index.ts
      // disposes the manager before the executor releases those leases.
      if (profileWriteInFlight()) {
        const leaseOutcome = await waitForProfileWriteIdle(rollbackLeaseWaitMs)
        if (disposed || lifecycleAbort.signal.aborted) return
        if (leaseOutcome !== 'idle') {
          logger.error('plugin mutation lease held too long; restart-exhausted rollback deferred')
          return
        }
      }

      const failedVersion = active.version
      const plan = planRestartExhaustedRollback({
        restartExhausted: true,
        activeIsOverride: true,
        failedVersion,
        journalState: readActivationJournalState(baseDir),
        now: () => new Date(nowMs()),
      })
      if (plan.status === 'not-triggered') return

      if (plan.status === 'planned') {
        // Exactly-once/crash-recovery latch: this durable rollback-needed
        // record MUST precede candidate mutation, host stop, pointer switch,
        // or DSH_HOME restore. Preserve a concurrently queued next intent so
        // shared startup can re-arm it only after reaching a safe fallback.
        writeActivationJournal(baseDir, {
          ...plan.journal,
          nextIntent: plan.deferredIntent,
        })
      }
      // `already-in-recovery` is itself durable proof; `planned` reaches here
      // only after the write above succeeded. The catch path must not stop a
      // host if creating the F7 latch failed — the shared planner explicitly
      // forbids every rollback side effect before durable rollback-needed.
      rollbackDurablyLatched = true

      restartOutcome = 'failed'
      operationError = `dsh v${failedVersion} exhausted managed restarts; automatic rollback in progress`

      let result: Awaited<ReturnType<typeof runStartupPhase>>
      beginActivation()
      try {
        // A version that exhausted the authoritative host restart policy can
        // no longer earn known-good promotion, even if the following restore
        // itself needs an operator retry.
        removeKnownGoodCandidate(baseDir, failedVersion)
        result = await executeStartupTransaction(lifecycleAbort.signal)
      } finally {
        endActivation()
        invalidateDiskCache()
      }

      if (result.applyOutcome === null) {
        operationError = sanitizeRouteError(
          `restart-exhausted rollback did not complete${result.blockedReason === null ? '' : `: ${result.blockedReason}`}`,
        )
        return
      }

      operationError = sanitizeRouteError(
        result.applyOutcome.error
          ?? (result.applyOutcome.status === 'rolled-back'
            ? `dsh v${failedVersion} exhausted managed restarts and was automatically rolled back`
            : `restart-exhausted rollback ended with ${result.applyOutcome.status}`),
      )

      // Candidate/fallback probes may leave a process alive, but the normal
      // host/exposure lifecycle is re-synchronized only after quarantine has
      // closed. A dispose that raced the probe permanently suppresses this
      // recovery start; dispose's final stop is the ownership-release proof.
      if (!disposed && result.blockedReason === null) {
        await plane.startLocal()
        if (!disposed) plane.refreshLocalExposure()
      }
    })().catch(async (error) => {
      if (!disposed) {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
        logger.error(`gateway runtime restart-exhausted rollback failed: ${sanitizeErrorText(String(error))}`)
        if (rollbackDurablyLatched) {
          try {
            await plane.stopLocal()
          } catch (stopError) {
            logger.warn(`gateway runtime restart-exhausted stop failed: ${sanitizeErrorText(String(stopError))}`)
          }
        }
      }
    }).finally(() => {
      restartExhaustedRollbackInFlight = false
    })
    trackOperation(operation)
  }

  function observeLocalState(status: string): void {
    if (disposed || platform === 'win32' || activationInProgress()) return
    if (status !== 'ready') {
      if (localHealthWindowOpen) {
        localHealthWindowOpen = false
        try {
          resetCandidateHealthWindow(baseDir, nowMs())
        } catch (error) {
          logger.warn(`gateway runtime known-good health reset failed: ${sanitizeErrorText(String(error))}`)
        }
      }
      if (status === 'restart-exhausted') scheduleRestartExhaustedRollback()
      return
    }
    if (localHealthWindowOpen) return
    localHealthWindowOpen = true
    try {
      const active = resolveWorkspace()
      if (active.source === 'override' && active.version !== null) {
        noteBoot(baseDir, active.version, nowMs())
        promoteDueCandidates(baseDir, nowMs())
      }
    } catch (error) {
      logger.warn(`gateway runtime known-good boot observation failed: ${sanitizeErrorText(String(error))}`)
    }
  }

  // Promotion is based on a live in-process interval, never elapsed offline
  // wall time. observeLocalState closes the window on every unhealthy edge.
  const runKnownGoodPromotion = () => {
    if (disposed || platform === 'win32' || !localHealthWindowOpen || !plane.localProcessAlive) return
    try {
      promoteDueCandidates(baseDir, nowMs())
    } catch (error) {
      logger.warn(`gateway runtime known-good promotion failed: ${sanitizeErrorText(String(error))}`)
    }
  }
  let cancelKnownGoodPromotion: () => void = () => {}
  try {
    if (platform !== 'win32') {
      cancelKnownGoodPromotion = options.scheduleKnownGoodPromotion !== undefined
        ? options.scheduleKnownGoodPromotion(runKnownGoodPromotion)
        : (() => {
            const timer = setInterval(runKnownGoodPromotion, 60 * 60 * 1_000)
            timer.unref()
            return () => { clearInterval(timer) }
          })()
    }
  } catch (error) {
    // A scheduler may retain the callback and then throw before returning its
    // cancel handle. Permanently fence this abandoned closure before releasing
    // owner authority; any later queued tick becomes a pure no-op.
    disposed = true
    lifecycleAbort.abort()
    if (ownerLease !== null) {
      try {
        releaseSingleOwner(baseDir, ownerLease)
        processRuntimeOwnerLeases.delete(ownerLease.leaseKey)
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'gateway runtime construction failed and owner could not be released')
      }
    }
    throw error
  }

  async function status(): Promise<GatewayRuntimeStatus> {
    assertManagerReadable()
    // Desktop-shaped metadata health projection (2026-12 recover-metadata
    // parity): category-only components, never paths.
    const metadata = metadataProjection()
    if (platform === 'win32') {
      const resolved = resolveWorkspace()
      return {
        kind: GATEWAY_RUNTIME_STATUS_KIND,
        activeVersion: resolved.version,
        builtinVersion,
        currentVersion: null,
        selectedVersion: null,
        hasOverride: false,
        source: resolved.source === 'env' ? 'env' : 'builtin-anchor',
        phase: 'idle',
        startupBlockedReason: null,
        pending: null,
        connectionState: plane.connectionState,
        registry: DEFAULT_REGISTRY_ORIGIN,
        registryError: null,
        platform,
        mutationsAllowed: false,
        operationError,
        restart: restartOutcome,
        start: startOutcome,
        restoreOutcome: null,
        snapshotCount: null,
        latestSnapshotAt: null,
        snapshotError: null,
        restoreInProgress: null,
        preRollbackCount: null,
        preRollbackLatestName: null,
        failure: null,
        diskUsage: null,
        diskError: null,
        diskLimitBytes: GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
        diskLimitExceeded: null,
        progress: null,
        metadataHealth: metadata.metadataHealth,
        metadataComponents: metadata.metadataComponents,
        canRecoverMetadata: metadata.canRecoverMetadata,
      }
    }
    const overrideState = readOverrideState(baseDir)
    const pointerState = readCurrentPointerState(baseDir)
    const override = overrideState.kind === 'valid' ? overrideState.record : null
    const pointer = pointerState.kind === 'valid' ? pointerState.version : null
    let resolved: ResolvedWorkspace | null = null
    let resolutionError: string | null = null
    try {
      resolved = resolveWorkspace()
    } catch (error) {
      resolutionError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
    }
    let registry: string | null = null
    let registryError: string | null = null
    try {
      registry = readRegistryOrigin(baseDir)
    } catch (error) {
      registryError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
    }
    let snapshotCount: number | null = null
    let latestSnapshotAt: string | null = null
    let restoreInProgress: boolean | null = null
    let preRollbackCount: number | null = null
    let preRollbackLatestName: string | null = null
    let snapshotError: string | null = null
    try {
      const snapshots = await snapshotSummary(baseDir)
      snapshotCount = snapshots.count
      latestSnapshotAt = snapshots.latestAt
      restoreInProgress = snapshots.restoreInProgress
      preRollbackCount = snapshots.preRollbackCount
      preRollbackLatestName = snapshots.latestStashName
    } catch (error) {
      snapshotError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
    }
    if (startupBlockReason === 'snapshot-failed' && snapshotError === null) {
      snapshotError = override?.lastError ?? 'runtime data snapshot failed'
    }
    const failures = runtimeFailureSummary(baseDir)
    const failure = failures.latest === null ? null : {
      version: failures.latest.version,
      at: failures.latest.lastFailedAt,
      reason: failures.latest.error,
    }
    // Full logical accounting is a synchronous tree walk. Cache it so the
    // authenticated 3s UI poll and gateway identity probes never turn status
    // into a hot 10 GiB filesystem walk; mutations invalidate the cache.
    const { usage: diskUsage, error: diskError } = diskProjection()
    const effectiveBlockedReason = startupBlockReason ?? resolutionError
    const effectivePending = envPath === null && override !== null && !shouldInvalidate(override, shellVersion) && override.pending !== null
      ? override.pending : null
    // 2026-12 (H2 review fix): a FATAL/RECOVERABLE metadata block must also
    // suppress the ordinary-pending phase — journal-corrupt + stale pending
    // would otherwise lock the only recovery surface behind the pending gate.
    const blockOutranksPending = startupBlockReason !== null
      && (RECOVERABLE_METADATA_BLOCKS.has(startupBlockReason)
        || startupBlockReason === 'swap-attempted'
        || startupBlockReason === 'snapshot-failed'
        || startupBlockReason === 'restore-half'
        || startupBlockReason === 'restore-incomplete')
    const ordinaryPending = effectivePending !== null
      && override?.swapAttempted !== true
      && override?.lastOutcome !== 'snapshot-failed'
      && !blockOutranksPending
    return {
      kind: GATEWAY_RUNTIME_STATUS_KIND,
      activeVersion: resolved?.version ?? null,
      builtinVersion,
      currentVersion: pointer,
      selectedVersion: override?.chosenVersion ?? null,
      hasOverride: overrideState.kind !== 'missing',
      source: resolved === null
        ? null
        : resolved.source === 'override'
          ? 'user-selected'
          : resolved.source === 'env'
            ? 'env'
            : 'builtin-anchor',
      // apply-now remains applying through its post-quarantine recovery and
      // outcome-projection tail. activationDepth alone opens a false idle/ready
      // poll window after the probe verdict but before startLocal/error state
      // has settled.
      phase: activationInProgress() || applyNowInFlight || restartExhaustedRollbackInFlight ? 'applying'
        : installInFlight ? 'installing'
        : startupBlockReason === 'snapshot-failed' ? 'snapshot-failed'
        : startupBlockReason === 'swap-attempted' ? 'swap-attempted'
        : startupBlockReason === 'restore-half' || startupBlockReason === 'restore-incomplete' ? 'restore-blocked'
        : ordinaryPending ? 'pending'
        : 'idle',
      // Review fix: blocked startups are projected so clients can see WHY the
      // managed dsh is down and which resume route applies.
      startupBlockedReason: effectiveBlockedReason,
      pending: effectivePending,
      connectionState: plane.connectionState,
      registry,
      registryError,
      platform,
      mutationsAllowed: true,
      operationError,
      // Last restart outcome (design 18 §9.3 review fix): 'running' from the
      // moment a restart is accepted until it settles; 'ok'/'failed' terminal.
      // The settings-bridge poll uses this to distinguish a post-202 entry
      // rejection (operationError set, connectionState still 'ready') from a
      // genuine success.
      restart: restartOutcome,
      start: startOutcome,
      restoreOutcome: override?.restoreOutcome ?? null,
      snapshotCount,
      latestSnapshotAt,
      snapshotError,
      restoreInProgress,
      preRollbackCount,
      preRollbackLatestName,
      failure,
      diskUsage,
      diskError,
      diskLimitBytes: GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
      diskLimitExceeded: diskUsage === null
        ? null
        : diskUsage.totalBytes >= GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
      progress: installProgress,
      metadataHealth: metadata.metadataHealth,
      metadataComponents: metadata.metadataComponents,
      canRecoverMetadata: metadata.canRecoverMetadata,
    }
  }

  /** Cleanup candidates for the settings UI (2026-12 desktop parity): the
   *  explicit-install ledger minus everything the deletion-point protection
   *  set would refuse (current/pending/chosen/known-good/failure evidence).
   *  Fail-closed: any read trouble projects an empty list — the cleanup route
   *  stays authoritative and re-validates. */
  function removableCleanupVersions(): string[] {
    if (platform === 'win32') return []
    try {
      return listExplicitlyInstalledVersions(baseDir)
        .filter((version) => !isProtectedVersion(baseDir, version, { ignoreExplicitInstall: true }))
        .sort((a, b) => compareRuntimeVersions(b, a) ?? 0)
    } catch {
      return []
    }
  }

  async function listVersions(): Promise<unknown> {
    assertManagerReadable()
    const origin = platform === 'win32' ? DEFAULT_REGISTRY_ORIGIN : readRegistryOrigin(baseDir)
    const cachedVersions = platform === 'win32' ? [] : listValidVersionTrees(baseDir)
    let active: string | null = null
    try { active = resolveWorkspace().version } catch { /* status carries the loud selection error */ }
    try {
      const meta = await (options.fetchMetadata ?? fetchRegistryMetadata)(DSH_PACKAGE_NAME, {
        origin,
        signal: lifecycleAbort.signal,
      })
      return {
        registryOrigin: meta.origin,
        versions: buildVersionList(meta, {
          active,
          cachedVersions,
          compatibilityBaseline: null,
        }),
        removableVersions: removableCleanupVersions(),
      }
    } catch (error) {
      const versions = buildCachedVersionList(cachedVersions, active).map(entry => (
        entry.version === active && !cachedVersions.includes(entry.version)
          ? { ...entry, cached: false }
          : entry
      ))
      return {
        registryOrigin: origin,
        versions,
        removableVersions: removableCleanupVersions(),
        error: sanitizeErrorText(String(error)),
      }
    }
  }

  /** A fresh user selection cancels any STALE intent journal (e.g. a prior
   * rollback's intent whose target no longer matches the selection). Only an
   * 'intent'-phase journal is cleared — an in-flight transaction
   * (prepared/applying/monitoring) keeps its evidence; writeActivationIntent
   * supersedes intent-phase journals and queues nextIntent onto
   * applied-monitoring ones (round-4 fix: rollback → re-select → apply must
   * not strand a mismatched journal that FATAL-blocks the next boot). */
  function clearStaleIntent(): void {
    const state = readActivationJournalState(baseDir)
    if (state.kind === 'valid' && state.journal.phase === 'intent') {
      clearActivationJournal(baseDir)
    }
  }

  function currentPointerVersion(): string | null {
    return readCurrentPointer(baseDir)
  }

  async function select(version: string): Promise<{ accepted: boolean; version: string }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoPending()

    // The version selector always places the active version first. Selecting
    // the builtin anchor's version is therefore a true no-op even though it is
    // not an installed version tree and must never trigger a registry fetch.
    if (resolveWorkspace().version === version) {
      operationError = null
      restartOutcome = null
      startOutcome = null
      return { accepted: true, version }
    }
    const currentAtSelection = currentPointerVersion()

    // Installed tree: the installer would refuse to overwrite a valid tree, so
    // a re-selection never reaches it. Active version → true no-op (§3.6);
    // installed-but-inactive → record the choice so apply() can arm it.
    if (listValidVersionTrees(baseDir).includes(version)) {
      if (currentAtSelection !== version) {
        const previous: OverrideRecord = readOverride(baseDir) ?? {
          shellVersion,
          chosenVersion: null,
          resolvedVersion: null,
          pending: null,
          swapAttempted: false,
        }
        clearStaleIntent()
        writeOverride(baseDir, {
          ...previous,
          shellVersion,
          chosenVersion: version,
          resolvedVersion: version,
          pending: null,
          swapAttempted: false,
          // Only a builtin-active selection can prove that a missing current
          // pointer is expected. When v1 is active and v2 is merely staged,
          // selectedOnly MUST remain false so losing v1's pointer still
          // quarantines DSH_HOME instead of silently falling back to builtin.
          selectedOnly: currentAtSelection === null,
          // Round-3 fix: a fresh user transaction supersedes a failed
          // snapshot — the durable lastOutcome marker must not re-block the
          // next startup (desktop parity: its install writes a fresh record).
          lastOutcome: null,
          lastError: null,
        })
      }
      operationError = null
      restartOutcome = null
      startOutcome = null
      return { accepted: true, version }
    }
    // Install is a writer single-flight, but NOT an activation quarantine:
    // the current dsh/proxy/features remain authoritative and serviceable for
    // the entire download/pnpm window. Only a later startup/apply transaction
    // may close exposure while probing the candidate.
    installInFlight = true
    try {
      // Design 18's 10 GiB limit gates NEW downloads only. Cached selection,
      // rollback and recovery remain available above the soft ceiling.
      const disk = diskProjection(true)
      if (disk.error !== null || disk.usage === null) {
        throw Object.assign(new Error(`cannot confirm gateway runtime disk usage; refusing a new install: ${disk.error ?? 'unknown accounting failure'}`), {
          code: 'runtime_disk_unavailable',
        })
      }
      if (disk.usage.totalBytes >= GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES) {
        throw Object.assign(new Error(`gateway runtime logical disk usage reached the ${GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES}-byte soft limit; remove an unused version before installing`), {
          code: 'runtime_disk_limit',
        })
      }
      const origin = readRegistryOrigin(baseDir)
      const meta = await (options.fetchMetadata ?? fetchRegistryMetadata)(DSH_PACKAGE_NAME, {
        origin,
        signal: lifecycleAbort.signal,
      })
      const resolution = bindRuntimeInstallResolution(meta, version, origin)
      const result = await installRuntimeVersion({
        baseDir,
        resolution,
        pnpmEntry: pnpmEntry(),
        signal: lifecycleAbort.signal,
        onProgress: (progress) => { installProgress = progress.stage === 'done' ? null : progress },
        deps: {
          // Empty env: the installer applies its own scrub + HOME/XDG/
          // NPM_CONFIG_USERCONFIG injection; gateway secrets never reach the
          // pnpm child (design 18 §4/§6, S19).
          node: () => ({ file: process.execPath, args: [], env: {} }),
          download: async (res, destination, opts) => {
            await downloadVerifiedRegistryTarball(res, destination, {
              signal: opts.signal,
              onProgress: opts.onProgress,
            })
          },
        },
      })
      // select records the choice WITHOUT pending (design 18 §9.3): apply()
      // is the separate action that arms the next-startup switch.
      recordExplicitInstall(baseDir, version)
      const previous: OverrideRecord = readOverride(baseDir) ?? {
        shellVersion,
        chosenVersion: null,
        resolvedVersion: null,
        pending: null,
        swapAttempted: false,
      }
      clearStaleIntent()
      writeOverride(baseDir, {
        ...previous,
        shellVersion,
        chosenVersion: version,
        resolvedVersion: result.resolvedVersion,
        pending: null,
        swapAttempted: false,
        selectedOnly: currentAtSelection === null,
        // Round-3 fix: a fresh user transaction supersedes a failed snapshot.
        lastOutcome: null,
        lastError: null,
      })
      operationError = null
      restartOutcome = null
      startOutcome = null
      invalidateDiskCache()
      return { accepted: true, version }
    } catch (error) {
      operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      installProgress = null
      invalidateDiskCache()
      installInFlight = false
    }
  }

  async function apply(): Promise<{ pending: boolean }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoPending()

    const record: OverrideRecord = readOverride(baseDir) ?? {
      shellVersion,
      chosenVersion: null,
      resolvedVersion: null,
      pending: null,
      swapAttempted: false,
    }
    if (record.chosenVersion === null) throw Object.assign(new Error('no runtime version selected'), { code: 'no_selection' })
    // Round-4 fix: the activation intent must agree with the pending target —
    // a stale intent journal (e.g. from an earlier rollback) would otherwise
    // FATAL-block the next boot on journal-mismatch. writeActivationIntent
    // replaces intent-phase journals and queues onto applied-monitoring ones
    // (desktop parity); an in-flight transaction refuses honestly (409).
    // The downgrade formula uses the EFFECTIVE active version (pointer ??
    // builtin anchor), exactly like the desktop controller's activeVersion():
    // a builtin-active downgrade is still a real data rollback (manualRollback
    // arms the pre-rollback stash + target-data restore, design 18 §3.7), not
    // a plain switch. The raw pointer would silently narrow that semantic.
    const current = currentPointerVersion() ?? builtinVersion
    try {
      writeActivationIntent(baseDir, {
        targetVersion: record.chosenVersion,
        targetIsBuiltin: false,
        manualRollback: current !== null && compareRuntimeVersions(record.chosenVersion, current) === -1,
        intentKind: 'version-switch',
      })
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'runtime_busy' })
    }
    writeOverride(baseDir, {
      ...record,
      shellVersion,
      pending: record.chosenVersion,
      swapAttempted: false,
      selectedOnly: false,
      // Round-3 fix: a fresh apply transaction supersedes a failed snapshot.
      lastOutcome: null,
      lastError: null,
    })
    startupBlockReason = null // round-4: a fresh apply supersedes the in-memory block marker
    operationError = null
    restartOutcome = null
    startOutcome = null
    return { pending: true }
  }

  async function rollback(version: string): Promise<{ accepted: boolean }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoPending()

    if (!listValidVersionTrees(baseDir).includes(version)) {
      throw Object.assign(new Error(`no valid version tree for ${version}`), { code: 'invalid_target' })
    }
    // Direction guard (fail-loud): rollback is the DOWNGRADE path only — a
    // same-as-active or newer target is select+apply's job, and accepting it
    // here would journal a manualRollback intent with upgrade semantics (the
    // UI regression this guard closes: the API/dashboard misusing rollback for
    // an upgrade). The comparison uses the EFFECTIVE active version (pointer
    // ?? builtin anchor), the same formula as apply()/applyNowPreflight() and
    // the desktop controller's activeVersion(): a builtin-active downgrade to
    // an installed tree is a legitimate manual rollback (data restore, design
    // 18 §3.7) and stays accepted. `current === null` (no pointer AND no
    // readable builtin version — a broken anchor) is refused: there is no
    // active version to be older than, and switching to an installed tree is
    // a plain select+apply.
    const current = currentPointerVersion() ?? builtinVersion
    if (current === null || compareRuntimeVersions(version, current) !== -1) {
      throw Object.assign(
        new Error(current === null
          ? 'rollback requires an active installed runtime version to roll back from; use select+apply to switch'
          : `rollback target is not older than the active runtime (v${current}); use select+apply to switch to a newer version`),
        { code: 'invalid_target' },
      )
    }
    // Manual rollback (design 18 §3.7): journal a manualRollback intent and
    // arm the pending switch — the startup transaction's prepareManualRollback
    // dep performs the pre-rollback stash and records it in the journal (an
    // eager stash here would be orphaned and double the work).
    const record: OverrideRecord = readOverride(baseDir) ?? {
      shellVersion,
      chosenVersion: null,
      resolvedVersion: null,
      pending: null,
      swapAttempted: false,
    }
    // Journal FIRST, then the override (round-4 order fix): a crash between
    // the two writes must not strand a pending override without its
    // manualRollback intent — the intent is the durable record of the
    // transaction's kind; the override only arms it.
    writeActivationIntent(baseDir, {
      targetVersion: version,
      targetIsBuiltin: false,
      manualRollback: true,
      intentKind: 'version-switch' as ActivationIntentKind,
    })
    writeOverride(baseDir, {
      ...record,
      shellVersion,
      chosenVersion: version,
      pending: version,
      swapAttempted: false,
      selectedOnly: false,
      // Round-3 fix: a fresh rollback transaction supersedes a failed snapshot.
      lastOutcome: null,
      lastError: null,
    })
    // Round-4 fix: a fresh transaction supersedes the in-memory blocked
    // phase marker (parity with restoreBuiltin); the durable markers above
    // are the authority — the next boot re-derives any real block.
    startupBlockReason = null
    operationError = null
    restartOutcome = null
    startOutcome = null
    return { accepted: true }
  }

  /** User-authorized cleanup of one explicitly retained version tree (2026-12
   *  desktop-parity route): mirrors desktop RUNTIME_CLEANUP_VERSION — ledger
   *  membership is required (never an arbitrary tree), the shared core
   *  re-reads the complete protection set at the deletion point, the durable
   *  store-prune marker is consumed by runStorePruneIfNeeded, and a success
   *  supersedes a stale operation error (desktop resets the disk-gate error
   *  phase the same way). */
  async function cleanupVersion(version: string): Promise<{ version: string; removed: boolean }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoPending()
    if (startupBlockReason !== null) {
      throw Object.assign(new Error(`runtime recovery ${startupBlockReason} is required before cleanup`), { code: 'runtime_recovery_required' })
    }
    const safe = isSafeVersion(version) ? version.trim() : ''
    if (safe === '' || !listExplicitlyInstalledVersions(baseDir).includes(safe)) {
      throw Object.assign(new Error(`no explicitly installed version tree for ${version}`), { code: 'invalid_target' })
    }
    const result = cleanupExplicitRuntimeVersion(baseDir, safe)
    if (result.stillProtected) {
      throw Object.assign(
        new Error(`dsh ${safe} is still protected (active/pending/known-good/recovery/failure evidence); cleanup refused`),
        { code: 'version_still_protected' },
      )
    }
    invalidateDiskCache()
    await runStorePruneIfNeeded()
    operationError = null
    return { version: safe, removed: result.removed }
  }

  /** Restore the newest pre-rollback stash over DSH_HOME (2026-12 desktop
   *  parity, main.ts RUNTIME_RESTORE_PRE_ROLLBACK): stash-name whitelist →
   *  stop the managed dsh → shared crash-safe restorePreRollback →
   *  resume/blocked projection. env stays allowed (data recovery is
   *  source-independent, design 18 §3.6); win32 read-only refuses. */
  async function restorePreRollbackStash(stashName: string): Promise<{ accepted: true }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (!/^\d{13}-[0-9a-f]{8}$/.test(stashName)) {
      throw Object.assign(new Error('invalid pre-rollback stash name'), { code: 'invalid_target' })
    }
    const stashes = await listPreRollbackStashes(baseDir)
    if (!stashes.includes(stashName)) {
      throw Object.assign(new Error('pre-rollback stash no longer exists or is untrustworthy; refused'), { code: 'invalid_target' })
    }
    let outcome: Awaited<ReturnType<typeof restorePreRollback>> | null = null
    let restoreError: string | null = null
    beginActivation()
    try {
      await plane.stopLocal()
      try {
        outcome = await restorePreRollback(baseDir, dshHome, stashName)
      } catch (error) {
        restoreError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      endActivation()
      invalidateDiskCache()
    }
    if (restoreError !== null) {
      // Desktop parity: an errored restore is recorded, not hard-blocked —
      // bring the managed dsh back up and surface the failure loudly.
      await resumeAfterBlockedStartup()
      throw Object.assign(new Error(`pre-rollback restore failed: ${restoreError}`), { code: 'restore_failed' })
    }
    switch (outcome) {
      case 'complete': {
        // Resume the runtime through a full startup transaction. Only a CLEAN
        // verdict may clear the blocked projection: the resume can surface its
        // own terminal state (FATAL metadata discovered at startup, an
        // env-override probe failure on the env boot path, swap-attempted…)
        // and that verdict must stay visible for its own recovery surface —
        // unconditionally clearing it here would leave the managed dsh
        // stopped behind a clean status and re-open an unprobed start.
        const resumed = await resumeAfterBlockedStartup()
        if (resumed.blockedReason === null) {
          startupBlockReason = null
          operationError = null
        }
        return { accepted: true }
      }
      case 'half':
        // Desktop parity: the restore left a durable marker — keep the
        // managed dsh down and project restore-blocked so retry-restore
        // resumes the journaled transaction.
        startupBlockReason = 'restore-half'
        operationError = null
        return { accepted: true }
      case 'incomplete':
      default:
        // Untrustworthy/missing stash or unsupported marker: DSH_HOME was
        // never touched — restart the instance and refuse loudly (desktop
        // incomplete branch semantics).
        await resumeAfterBlockedStartup()
        throw Object.assign(new Error('pre-rollback stash is missing or untrustworthy; restore refused'), { code: 'invalid_target' })
    }
  }

  /** Desktop-shaped metadata health projection (main.ts 3422-3470 mirror) for
   *  /status: category-only components + explicit recover eligibility. */
  function metadataProjection(): {
    metadataHealth: 'unknown' | 'healthy' | 'selection-corrupt' | 'recovery-in-progress' | 'recovery-finalized' | 'recovery-marker-corrupt'
    metadataComponents: string[]
    canRecoverMetadata: boolean
  } {
    if (platform === 'win32') {
      return { metadataHealth: 'unknown', metadataComponents: [], canRecoverMetadata: false }
    }
    try {
      const health = detectRuntimeMetadataHealth(baseDir, shellVersion)
      const components = new Set<string>()
      if (health.current.kind === 'corrupt'
        || health.corruptEvidence.some(name => name.startsWith('current.'))) components.add('current')
      if (health.override.kind === 'corrupt'
        || health.corruptEvidence.some(name => name.startsWith('override.json.'))) components.add('override')
      if (health.activationJournal.kind === 'corrupt'
        || health.corruptEvidence.some(name => name.startsWith('activation-journal.json.'))) components.add('activation-journal')
      if (health.recovery.kind === 'corrupt'
        || (health.recovery.kind === 'valid' && health.recovery.record.phase !== 'finalized')) {
        components.add('recovery-marker')
      }
      if (health.corruptEvidence.length > 0) components.add('retained-evidence')
      const markerRescueAvailable = health.status === 'recovery-marker-corrupt'
        && inspectCorruptMetadataRecoveryMarker(baseDir).recoverable
      const needsRecovery = health.status === 'selection-corrupt'
        || health.status === 'recovery-in-progress'
        || markerRescueAvailable
      // The recover route may act only on a FATAL metadata block (or a
      // recovery attempt whose builtin probe failed and kept its durable
      // record, or a finalized recovery whose resume start failed) —
      // restore/swap recovery phases resume through their retry.
      const recoverableBlock = startupBlockReason === null
        || RECOVERABLE_METADATA_BLOCKS.has(startupBlockReason)
      // L4 review fix: no busy-phase/task gate may advertise recovery while an
      // activation/install/restart owns the writer.
      const writerBusy = activationInProgress() || installInFlight
        || restartInFlight || applyNowInFlight || restartExhaustedRollbackInFlight
      const canRecoverMetadata = (needsRecovery || startupBlockReason === 'metadata-start-failed')
        && recoverableBlock
        && !writerBusy
        && envPath === null
        && builtinVersion !== null
        && isSafeVersion(builtinVersion)
        && !disposed
      return {
        metadataHealth: health.status,
        metadataComponents: [...components],
        canRecoverMetadata,
      }
    } catch {
      return { metadataHealth: 'unknown', metadataComponents: [], canRecoverMetadata: false }
    }
  }

  /** H1 review fix: true while a durable metadata-recovery transaction is
   *  pending (engine record mid-flight) or the recovery marker is corrupt.
   *  The boot path consults this BEFORE starting the managed dsh — an
   *  archived/metadata-cleared state must never serve DSH_HOME through the
   *  builtin anchor without the probe gate. */
  function metadataRecoveryPending(): boolean {
    if (platform === 'win32') return false
    try {
      const health = detectRuntimeMetadataHealth(baseDir, shellVersion)
      return health.status === 'recovery-in-progress'
        || health.status === 'recovery-marker-corrupt'
        || (health.recovery.kind === 'valid' && health.recovery.record.phase !== 'finalized')
    } catch {
      return false
    }
  }

  /** Metadata FATAL rescue (2026-12 desktop parity, main.ts executeMetadataRecovery
   *  mirror): archives corrupt selection metadata byte-for-byte while keeping a
   *  full DSH_HOME copy, runs the builtin anchor through the full read-only
   *  probe gate, and only then finalizes access. The shared engine owns the
   *  crash-safe transaction (stash/evidence/probe-required checkpoints). */
  async function recoverMetadata(): Promise<{ accepted: true }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); metadata recovery is disabled'), { code: 'env_override_active' })
    const builtin = requireBuiltinVersion()
    if (builtin === null || !isSafeVersion(builtin)) {
      throw Object.assign(new Error('gateway builtin dsh anchor does not expose a stable version; metadata recovery refused'), { code: 'invalid_target' })
    }
    if (startupBlockReason !== null && !RECOVERABLE_METADATA_BLOCKS.has(startupBlockReason)) {
      throw Object.assign(new Error(`runtime recovery ${startupBlockReason} is required first; only the matching retry applies`), { code: 'runtime_recovery_required' })
    }
    let health: ReturnType<typeof detectRuntimeMetadataHealth>
    try {
      health = detectRuntimeMetadataHealth(baseDir, shellVersion)
    } catch (error) {
      throw Object.assign(new Error(`cannot read runtime metadata for recovery: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`), { code: 'runtime_recovery_required' })
    }
    const markerRescueAvailable = health.status === 'recovery-marker-corrupt'
      && inspectCorruptMetadataRecoveryMarker(baseDir).recoverable
    const needsRecovery = health.status === 'selection-corrupt'
      || health.status === 'recovery-in-progress'
      || markerRescueAvailable
    if (startupBlockReason === 'metadata-start-failed') {
      // M3 review fix: the metadata is healthy behind a failed resume start —
      // recover simply retries the plain start of the builtin anchor.
      if (!disposed) {
        await plane.startLocal()
        plane.refreshLocalExposure()
      }
      startupBlockReason = null
      operationError = null
      return { accepted: true }
    }
    if (!needsRecovery) {
      throw Object.assign(new Error('no corrupt metadata to recover'), { code: 'no_retry_target' })
    }
    const hostDomains = hasSyncedHostSeed(baseDir)
    const engineOptions = {
      baseDir,
      dshHome,
      builtinVersion: builtin,
      shellVersion,
      stopHost: () => plane.stopLocal(),
      completeRestore: () => completeInterruptedRestore(baseDir, dshHome),
      probeBuiltin: async () => {
        const probes = await spawnAndProbeCandidate(builtin, true, hostDomains, lifecycleAbort.signal)
        const passed = probes.length > 0 && probes.every(probe => probe.ok)
        if (passed) return { ok: true as const }
        const failures = probes.filter(probe => !probe.ok).map(probe => probe.name ?? 'unknown probe').join(', ')
        return { ok: false as const, error: failures === '' ? 'no probe results' : `builtin activation probes failed: ${failures}` }
      },
    }
    let result:
      | Awaited<ReturnType<typeof recoverRuntimeMetadata>>
      | Awaited<ReturnType<typeof rescueCorruptMetadataRecoveryMarker>>
    beginActivation()
    try {
      await plane.stopLocal()
      // engine requires failure-free? no: engine handles
      result = health.status === 'recovery-marker-corrupt'
        ? await rescueCorruptMetadataRecoveryMarker(engineOptions)
        : await recoverRuntimeMetadata(engineOptions)
    } catch (error) {
      operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
      // Engine invariants throw without a code: keep the failure loud but
      // mapped (409), never a bare 500 — the corrupt state remains readable
      // and the route stays retryable.
      const code = (error as { code?: unknown }).code
      if (typeof code !== 'string') {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'runtime_activation_failed' })
      }
      throw error
    } finally {
      endActivation()
      invalidateDiskCache()
    }
    if (result.status === 'finalized') {
      operationError = null
      restartOutcome = null
      if (!disposed) {
        try {
          await plane.startLocal()
          plane.refreshLocalExposure()
        } catch (error) {
          // M3 review fix: a failed resume start must stay recoverable — the
          // metadata is healthy now, so keep a dedicated sentinel the recover
          // route resolves by retrying the plain start.
          startupBlockReason = 'metadata-start-failed'
          operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
          throw Object.assign(
            new Error(`metadata recovery finalized but the managed dsh failed to start: ${operationError}`),
            { code: 'runtime_activation_failed' },
          )
        }
      }
      startupBlockReason = null
      return { accepted: true }
    }
    if (result.status === 'restore-blocked') {
      // Engine outcome name clash: this is a metadata-recovery transaction
      // blocked on an interrupted SNAPSHOT restore — retry-restore resumes it.
      startupBlockReason = result.restoreOutcome === 'half' ? 'restore-half' : 'restore-incomplete'
      operationError = result.error
      return { accepted: true }
    }
    // probe-failed (or unexpected status): keep the durable record and the
    // managed dsh stopped; the recover route stays eligible to resume.
    startupBlockReason = 'metadata-probe-failed'
    operationError = sanitizeRouteError(result.error || 'metadata recovery probe failed')
    return { accepted: true }
  }

  async function restoreBuiltin(): Promise<{ accepted: boolean }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    // Desktop parity (A-U4): reset-builtin without an override is a pointless
    // stop → snapshot → probe cycle (the anchor is already authoritative and
    // there is nothing to clear) — the desktop only offers the action when
    // hasOverride, and a no-override API call must not manufacture downtime.
    const overrideState = readOverrideState(baseDir)
    if (overrideState.kind === 'missing') {
      throw Object.assign(new Error('no override exists — the runtime is already on the builtin anchor; nothing to restore'), { code: 'runtime_no_override' })
    }
    // Desktop parity (A-F5 + 2026 audit R2): reset-builtin only applies to a
    // HEALTHY or ordinary-pending selection. Inside an interrupted apply
    // (durable swapAttempted / lastOutcome snapshot-failed), an interrupted
    // data restore (restore marker), a corrupt override, or any armed memory
    // block, the shared core re-blocks an armed reset intent — running this
    // transaction would stop the managed dsh for nothing and leave the armed
    // reset intent behind, hijacking the later retry-apply/retry-restore
    // semantics. Refuse BEFORE any stop or intent write; the desktop never
    // offers reset-builtin in these states either (only the matching retry
    // and recover-metadata).
    const durable = overrideState.kind === 'valid' ? overrideState.record : null
    const journalState = readActivationJournalState(baseDir)
    const pointerState = readCurrentPointerState(baseDir)
    const recoveryReason = startupBlockReason !== null
      ? startupBlockReason
      : journalState.kind === 'corrupt'
        ? 'journal-corrupt'
        : pointerState.kind === 'corrupt'
          ? 'current-corrupt'
          : overrideState.kind === 'corrupt'
            ? 'override-corrupt'
            : durable !== null && (durable.swapAttempted === true || durable.lastOutcome === 'snapshot-failed')
              ? durable.swapAttempted === true ? 'swap-attempted' : 'snapshot-failed'
              : restoreMarkerAuthorityStatus(baseDir) !== 'missing'
                ? 'restore-half'
                : null
    if (recoveryReason !== null) {
      throw Object.assign(
        new Error(`runtime recovery ${recoveryReason} is required; resume via the matching retry route (restore-builtin applies to pending or healthy selections only)`),
        { code: 'runtime_recovery_required' },
      )
    }

    // Reset-builtin is an activation transaction, not metadata deletion:
    // durable intent → quiesce DSH_HOME → snapshot → atomic pointer clear →
    // full probe gate. Shared startup code deletes the override/journal only
    // after the builtin probe passes; every failure preserves rollback and
    // recovery evidence.
    const targetVersion = requireBuiltinVersion()
    let result: Awaited<ReturnType<typeof runStartupPhase>>
    beginActivation()
    try {
      writeActivationIntent(baseDir, {
        targetVersion,
        targetIsBuiltin: true,
        manualRollback: false,
        intentKind: 'reset-builtin',
      })
      await plane.stopLocal()
      result = await executeStartupTransaction()
    } catch (error) {
      operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      endActivation()
      invalidateDiskCache()
    }

    // Candidate/fallback probes normally leave a host alive. Snapshot failure
    // never spawns, so explicitly resume the untouched source after releasing
    // the activation gate. Hard recovery/metadata blocks intentionally stay
    // stopped and pollable.
    if (!disposed && (result.blockedReason === null || result.blockedReason === 'snapshot-failed')) {
      try {
        await plane.startLocal()
        plane.refreshLocalExposure()
      } catch (error) {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
        throw error
      }
    }

    if (result.applyOutcome?.status !== 'applied') {
      const reason = result.applyOutcome?.error
        ?? (result.applyOutcome?.status === 'rolled-back'
          ? 'builtin activation failed; the previous runtime and data were restored'
          : result.blockedReason ?? 'builtin activation did not commit')
      operationError = sanitizeRouteError(reason)
      throw Object.assign(new Error(reason), { code: 'runtime_activation_failed' })
    }
    startupBlockReason = null
    operationError = null
    restartOutcome = null
    startOutcome = null
    return { accepted: true }
  }

  let restartInFlight = false
  let applyNowInFlight = false
  /** Last restart outcome, projected in status() (review fix): the settings
   * poll must be able to distinguish a post-202 entry rejection from success
   * even when connectionState has already returned to 'ready'. */
  let restartOutcome: 'ok' | 'failed' | 'running' | null = null
  /** Decision-12 start primitive single-flight + outcome (mirrors restart). */
  let startInFlight = false
  let startOutcome: 'ok' | 'failed' | 'running' | null = null

  async function restart(): Promise<void> {
    assertMutationIdle()
    assertNoPending()
    restartInFlight = true
    restartOutcome = 'running'
    // A fresh restart epoch supersedes any earlier start verdict.
    startOutcome = null
    try {
      await plane.restartLocal()
      // CONTRACT (design 18 §9.3): resolve ≠ success — restartLocal() also
      // resolves from restart-exhausted / error / stopped (the shared window
      // or a concurrent stop); project that honestly instead of a false 'ok'
      // (review fix: the settings poll must not show「已重启」for a restart
      // that never reached ready).
      const connectionState = plane.connectionState
      // Whitelist (round-3 fix): restartLocal() resolves from
      // restart-exhausted / error / stopped AND can bail on an epoch bump
      // while 'restarting' is still the live state — every non-ready settle
      // is a failure; only ready/degraded (process alive) count as success.
      if (connectionState !== 'ready' && connectionState !== 'degraded') {
        const message = `dsh restart did not reach ready (${connectionState})`
        operationError = message
        restartOutcome = 'failed'
        throw new Error(message)
      }
      operationError = null
      restartOutcome = 'ok'
    } catch (error) {
      if (restartOutcome !== 'failed') {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
        restartOutcome = 'failed'
      }
      throw error
    } finally {
      restartInFlight = false
    }
  }

  /**
   * Decision-12 start primitive (design 21 §6.3 r1): bring the managed dsh up
   * from stopped/error/restart-exhausted through the plane's guarded
   * startLocal path. Every synchronous refusal runs BEFORE any plane effect:
   * a second start in flight, any runtime mutation/profile write in flight
   * (assertMutationIdle), a recovery block or ordinary pending (the start
   * surface never bypasses the recovery gate: retry / recover-metadata;
   * restore-builtin applies to pending/healthy selections only), and a
   * connection state
   * outside the start window. 202 semantics — the route answers synchronously
   * from these gates and the outcome is projected via status().start /
   * operationError (resolve ≠ success: a resolve that did not reach ready is
   * 'failed', exactly like restart()).
   */
  async function start(): Promise<void> {
    if (startInFlight) {
      throw Object.assign(new Error('a start is already in flight'), { code: 'runtime_busy' })
    }
    assertMutationIdle()
    // Recovery gate (decision 12: "恢复门不可绕过"): an in-memory startup
    // block is the authoritative recovery verdict; only its matching retry
    // (recover-metadata for FATAL) may run — restore-builtin applies to
    // pending/healthy selections only (2026 audit R2: an armed reset is
    // re-blocked by the shared core against durable recovery markers, so the
    // recovery surface never includes it). F7's auto-rollback tail and
    // gateway-boot blocks all land here, so a raw start can never skip the
    // probe/restore gate.
    if (startupBlockReason !== null) {
      throw Object.assign(
        new Error(`runtime recovery ${startupBlockReason} is required; resume via the matching retry route (restore-builtin applies to pending or healthy selections only)`),
        { code: 'runtime_recovery_required' },
      )
    }
    // Durable ordinary pending (mirror restart): the armed switch is consumed
    // by the startup transaction, not by a bare spawn of the old workspace.
    assertNoPending()
    const connectionState = plane.connectionState
    if (connectionState !== 'stopped' && connectionState !== 'error' && connectionState !== 'restart-exhausted') {
      throw Object.assign(
        new Error(`managed dsh is running (${connectionState}); start applies to stopped/error/restart-exhausted`),
        { code: 'runtime_busy' },
      )
    }
    startInFlight = true
    startOutcome = 'running'
    // A fresh start epoch supersedes any earlier restart verdict (e.g. an F7
    // auto-rollback 'failed' marker) — the poll must not echo the old verdict
    // while the r1 recovery is in progress.
    restartOutcome = null
    try {
      await plane.startLocal()
      // CONTRACT (restart parity): resolve ≠ success — startLocal() resolves
      // only after its spawn settles, but a concurrent stop/epoch bump can
      // land the machine on stopped/error/restart-exhausted; only a live
      // ready/degraded settle counts as 'ok'.
      const reached = plane.connectionState
      if (reached !== 'ready' && reached !== 'degraded') {
        const message = `dsh start did not reach ready (${reached})`
        operationError = message
        startOutcome = 'failed'
        throw new Error(message)
      }
      operationError = null
      startOutcome = 'ok'
    } catch (error) {
      if (startOutcome !== 'failed') {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
        startOutcome = 'failed'
      }
      throw error
    } finally {
      startInFlight = false
    }
  }

  /**
   * Synchronous apply-now preflight (review R3/R5): every manager gate that
   * can refuse the action runs here, synchronously, so the route can answer a
   * 409/403 BEFORE any 202 goes out — a preflight throw must never be
   * swallowed into a fake 202 whose status never settles (F3).
   *
   * Order: platform → assertMutationIdle (incl. applyNowInFlight) → env →
   * fail-closed metadata/state gates (P2 review fix: corrupt activation
   * journal / in-memory startup block / managed dsh not ready — each mirrors a
   * route-level refusal so a DIRECT manager call refuses identically) → target
   * resolution (ordinary pending, else a NON-invalidated staged chosenVersion;
   * both empty → no_selection) → installed-tree validation → no-op rejection
   * (target already active with no in-flight transaction to continue) → F2 arm
   * of the pending switch when only a selection is staged (journal-first,
   * apply() ordering; manualRollback mirrors apply() :1084).
   *
   * Returns the resolved target version.
   */
  function applyNowPreflight(): string {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })

    // P2-1 (review fix): a corrupt activation journal must fail closed BEFORE
    // any 202/stop can go out. The startup transaction cannot read it either
    // (runStartupPhase answers journal-corrupt), so proceeding would stop a
    // healthy managed dsh and leave it down. Recovery is the retry/restore
    // surface, never apply-now.
    if (readActivationJournalState(baseDir).kind === 'corrupt') {
      throw Object.assign(new Error('runtime activation journal is corrupt; apply-now refused (recovery required)'), { code: 'runtime_busy' })
    }
    // Direct-call parity with the route's recovery gate: an in-memory startup
    // block (snapshot-failed / swap-attempted / restore-half / restore-
    // incomplete / corrupt metadata) refuses apply-now identically when the
    // manager is called directly, not only through /chamber/runtime/apply-now.
    if (startupBlockReason !== null) {
      throw Object.assign(new Error(`runtime recovery ${startupBlockReason} is required; resume via the matching retry route (restore-builtin applies to pending or healthy selections only)`), { code: 'runtime_recovery_required' })
    }
    // Direct-call parity with the route's connection gate: a managed dsh that
    // never reached ready cannot be switched in-session (mirrors /restart).
    if (plane.connectionState !== 'ready' && plane.connectionState !== 'degraded') {
      throw Object.assign(new Error(`managed dsh is not running (${plane.connectionState}); restore the builtin or retry the interrupted apply/restore before applying now`), { code: 'runtime_busy' })
    }

    // F2: the target is the ordinary pending version when one exists, else the
    // staged chosenVersion (a selectedOnly selection with no pending yet).
    // Both empty → no_selection (never a no-op dsh stop/start cycle). An
    // invalidated record (gateway upgrade, shellVersion mismatch) keeps its
    // chosenVersion but is NOT a valid target — the selection gate must filter
    // it HERE, not at the route's status projection, whose selectedVersion
    // field does not see the invalidation (review R3/R5: a status-based
    // no_selection gate mis-let the stale choice through to a fake 202).
    let target = ordinaryPendingVersion()
    if (target === null) {
      const record = readOverride(baseDir)
      if (record === null || record.chosenVersion === null || shouldInvalidate(record, shellVersion)) {
        throw Object.assign(new Error('no runtime version selected or pending'), { code: 'no_selection' })
      }
      target = record.chosenVersion
    }
    if (!listValidVersionTrees(baseDir).includes(target)) {
      throw Object.assign(new Error(`no valid version tree for ${target}`), { code: 'invalid_target' })
    }

    // No-op rejection: the target is already the active runtime and no
    // transaction is in flight — applying again would run a pointless
    // stop → snapshot → spawn → probe cycle. P2-2 (review fix): the exception
    // was too wide — applied-monitoring (no nextIntent) is the durable end
    // state of every successful apply (pending=null, chosen==active), and the
    // old gate let apply-now through to that empty stop/start loop on the
    // ALREADY-ACTIVE version. Only the crash-continuation phases (prepared /
    // switched / manual-restoring / manual-restored / rollback-needed /
    // restoring / restore-complete / fallback-builtin) still pass — those are
    // real interrupted transactions that apply-now must continue. An
    // applied-monitoring journal WITH nextIntent needs no special case: its
    // nextIntent arms a pending that differs from current, so target !==
    // current above and the transaction proceeds naturally.
    // Effective active version (pointer ?? builtin anchor) — same formula as
    // apply()/rollback() and the desktop controller: a builtin-active staged
    // downgrade arms a real manualRollback below, not a plain switch.
    const current = currentPointerVersion() ?? builtinVersion
    if (target === current) {
      const journal = readActivationJournalState(baseDir)
      if (journal.kind === 'missing'
        || (journal.kind === 'valid'
          && (journal.journal.phase === 'intent' || journal.journal.phase === 'applied-monitoring'))) {
        throw Object.assign(new Error(`dsh v${target} is already the active runtime; apply-now has nothing to do`), { code: 'noop_target' })
      }
    }

    // F2 (continuation): when only the selection is staged (no pending yet),
    // arm the pending switch journal-first — the exact apply() ordering — so
    // runStartupPhase sees effectivePending === targetVersion. assertNoPending
    // is deliberately NOT used: a pending/selection existing is the semantic
    // premise of apply-now.
    if (persistedPendingVersion() === null) {
      const record: OverrideRecord = readOverride(baseDir) ?? {
        shellVersion,
        chosenVersion: null,
        resolvedVersion: null,
        pending: null,
        swapAttempted: false,
      }
      clearStaleIntent()
      try {
        writeActivationIntent(baseDir, {
          targetVersion: target,
          targetIsBuiltin: false,
          // Review fix: mirror apply() :1084's downgrade-aware formula instead
          // of a hardcoded false — a staged downgrade (chosen < current) arms
          // a real manual rollback intent so runStartupPhase prepares the
          // pre-rollback stash, exactly like a rollback()-armed switch.
          manualRollback: current !== null && compareRuntimeVersions(target, current) === -1,
          intentKind: 'version-switch',
        })
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'runtime_busy' })
      }
      writeOverride(baseDir, {
        ...record,
        shellVersion,
        chosenVersion: target,
        resolvedVersion: target,
        pending: target,
        swapAttempted: false,
        selectedOnly: false,
        // Round-3 fix: a fresh apply-now transaction supersedes a failed
        // snapshot's durable lastOutcome marker (desktop parity).
        lastOutcome: null,
        lastError: null,
      })
      // Round-4 fix: a fresh transaction supersedes the in-memory blocked
      // phase marker; the durable writes above are the authority.
      startupBlockReason = null
      operationError = null
      restartOutcome = null
      startOutcome = null
    }
    return target
  }

  /**
   * Immediately apply the pending/staged version switch inside the current
   * session (design 18 addendum · apply-now, §5.1): the version-switch twin of
   * restoreBuiltin — durable intent → quiesce DSH_HOME → snapshot → atomic
   * pointer switch → spawn candidate → full probe gate → verdict/rollback.
   * 202 semantics (F3): the caller receives `{ accepted: true }` synchronously;
   * the async job's outcome is projected into status() (operationError /
   * startupBlockReason), never only into the log. Every synchronous refusal
   * happens in applyNowPreflight() BEFORE applyNowInFlight is armed — the
   * route answers 409/403 from the preflight and never sends a fake 202.
   */
  async function applyNow(): Promise<{ accepted: boolean }> {
    // The preflight arms the pending switch (F2) when only a selection is
    // staged; the transaction body below relies on that persisted pending —
    // runStartupPhase derives effectivePending === targetVersion from the
    // override/journal, so `target` needs no separate plumbing into it.
    // `target` is intentionally not bound: the preflight arms the persisted
    // pending (F2) and the transaction derives the target from override/journal.
    applyNowPreflight()
    applyNowInFlight = true
    const job = (async () => {
      // P0 (review fix): the recovery segment (startLocal + exposure resync)
      // and the F3 projection run AFTER endActivation() closes the quarantine
      // window — restoreBuiltin order (mirror restoreBuiltin :1180-1192). The
      // OLD placement ran the recovery startLocal INSIDE
      // beginActivation()…endActivation(), where index.ts's canStartLocal gate
      // (activationInProgress() && !internalSpawnActive() → connection_busy)
      // refuses every non-internal spawn → every production apply-now recovery
      // threw connection_busy and the operationError was overwritten with the
      // misleading 'dsh runtime activation in progress'.
      let result: Awaited<ReturnType<typeof runStartupPhase>> | null = null
      try {
        // P2-4 (review fix): a new transaction supersedes any stale projection
        // from a previous select/restart/apply-now the moment it is accepted —
        // the 202 window must not keep echoing the last failure's text.
        operationError = null
        beginActivation()
        try {
          await plane.stopLocal()
          result = await executeStartupTransaction(lifecycleAbort.signal)
        } finally {
          endActivation()
          invalidateDiskCache()
        }
        // P2-5 (review fix): stop()/dispose() during the in-flight job must
        // never let the recovery startLocal resurrect the managed dsh.
        if (disposed) return
        if (result.blockedReason === null || result.blockedReason === 'snapshot-failed') {
          await plane.startLocal()
          plane.refreshLocalExposure()
        }
        // F3: the 202 job's failure must project into manager state (restart
        // parity) — the settings poll reads these fields, not the log. Hard
        // recovery/metadata blocks stay stopped and pollable (restoreBuiltin
        // :1180-1192 semantics); executeStartupTransaction already projected
        // startupBlockReason = result.blockedReason.
        if (result.applyOutcome?.status !== 'applied') {
          operationError = sanitizeRouteError(result.applyOutcome?.error ?? result.blockedReason ?? 'runtime apply-now did not commit')
        } else {
          operationError = null
        }
      } catch (error) {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
      } finally {
        applyNowInFlight = false
      }
    })()
    trackOperation(job)
    return { accepted: true }
  }

  /** Shared tail of retry-apply / retry-restore: re-run the startup
   * transaction and, on a clean verdict, bring the managed dsh up — the same
   * pairing the gateway start() path performs after the first transaction.
   * NOTE: if the transaction is clean but startLocal() then throws, the
   * retry target marker was already cleared pre-transaction, so the same
   * retry route answers 409 no_retry_target — recovery is a gateway restart;
   * the state stays honest (operationError set, connectionState not ready). */
  async function resumeAfterBlockedStartup(): Promise<{ blockedReason: string | null }> {
    const result = await startupTransaction()
    if (!disposed && result.blockedReason === null) {
      try {
        await plane.startLocal()
        plane.refreshLocalExposure()
      } catch (error) {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
        throw error
      }
    }
    return result
  }

  async function retryApply(): Promise<{ accepted: boolean; blockedReason: string | null }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoOrdinaryPending()
    const record = readOverride(baseDir)
    const interrupted = record !== null && (record.swapAttempted === true || record.lastOutcome === 'snapshot-failed')
    if (!interrupted) {
      throw Object.assign(new Error('no interrupted apply to retry (swap-attempted or snapshot-failed)'), { code: 'no_retry_target' })
    }
    // Mirror the desktop retry-apply (design 18 §3.6): clear the interrupted-
    // switch markers, then re-run the startup transaction so the pending switch
    // proceeds (snapshot → pointer switch → spawn → probe gate). snapshot-failed
    // is included (review fix): the gateway must have a NON-destructive recovery
    // from a snapshot failure, exactly like the desktop's canRetryApply.
    writeOverride(baseDir, { ...record!, swapAttempted: false, lastOutcome: null, lastError: null })
    const result = await resumeAfterBlockedStartup()
    if (result.blockedReason === null) operationError = null
    return { accepted: true, blockedReason: result.blockedReason }
  }

  async function retryRestore(): Promise<{ accepted: boolean; blockedReason: string | null }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    // 2026-12 parity fix (audit h): interrupted data-restore continuation is
    // source-independent — desktop never refuses env here, so neither does the
    // gateway (retry-apply stays env-refused: it resumes a VERSION switch).
    assertNoOrdinaryPending()
    if (startupBlockReason !== 'restore-half' && startupBlockReason !== 'restore-incomplete') {
      throw Object.assign(new Error('no interrupted restore to retry'), { code: 'no_retry_target' })
    }
    // The startup transaction itself performs the restore completion (its
    // completeInterruptedRestore dep); re-running it continues the durable
    // journal instead of starting a fresh snapshot.
    return { accepted: true, blockedReason: (await resumeAfterBlockedStartup()).blockedReason }
  }

  function getRegistry(): { origin: string } {
    assertManagerReadable()
    return { origin: platform === 'win32' ? DEFAULT_REGISTRY_ORIGIN : readRegistryOrigin(baseDir) }
  }

  async function setRegistry(origin: string): Promise<{ origin: string }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); registry mutation is disabled'), { code: 'env_override_active' })
    assertNoPending()
    const canonical = canonicalRegistryOrigin(origin)
    if (canonical === null) throw Object.assign(new Error('invalid registry origin'), { code: 'bad_registry_origin' })
    writeRegistryOrigin(baseDir, canonical)
    return { origin: canonical }
  }

  function trackOperation<T>(operation: Promise<T>): Promise<T> {
    activeOperations.add(operation)
    void operation.then(
      () => { activeOperations.delete(operation) },
      () => { activeOperations.delete(operation) },
    )
    return operation
  }

  async function drainOperations(): Promise<void> {
    // A settling operation can enqueue its detached apply-now job before its
    // own promise resolves, so drain to a fixed point rather than one snapshot.
    while (activeOperations.size > 0) {
      await Promise.allSettled([...activeOperations])
    }
  }

  function dispose(): Promise<void> {
    if (disposePromise !== null) return disposePromise
    disposed = true
    notifyActivationQuarantine(true)
    try {
      cancelKnownGoodPromotion()
    } catch (error) {
      // The callback itself is fenced by `disposed`, so a scheduler adapter
      // cancellation failure cannot retain runtime writer authority or skip
      // the real abort/drain/final-stop proof.
      logger.warn(`gateway runtime known-good scheduler cancellation failed: ${sanitizeErrorText(String(error))}`)
    }
    lifecycleAbort.abort()
    disposePromise = (async () => {
      // Epoch-fence any startLocal() that is currently waiting for readiness.
      // A later rollback probe is allowed to finish honestly; the second stop
      // below is the final process-quiescence proof.
      try {
        await plane.stopLocal()
      } catch (error) {
        logger.warn(`gateway runtime initial stop failed during disposal: ${sanitizeErrorText(String(error))}`)
      }

      let installerError: unknown = null
      try {
        await disposeRuntimeInstaller()
      } catch (error) {
        installerError = error
        logger.warn(`gateway runtime installer disposal failed: ${sanitizeErrorText(String(error))}`)
      }

      await drainOperations()

      // Abort can intentionally hand an already-started rollback probe a fresh
      // signal. Stop once more after every writer settles so no recovery spawn
      // survives ownership release.
      let finalStopError: unknown = null
      try {
        await plane.stopLocal()
      } catch (error) {
        finalStopError = error
      }

      if (installerError !== null || finalStopError !== null) {
        const reasons = [installerError, finalStopError].filter((error): error is {} => error !== null)
        throw new AggregateError(reasons, 'gateway runtime writers could not be proven quiescent; owner retained')
      }

      if (ownerLease !== null) {
        releaseSingleOwner(baseDir, ownerLease)
        processRuntimeOwnerLeases.delete(ownerLease.leaseKey)
      }
    })()
    return disposePromise
  }

  return {
    stateRoot: () => stateRoot,
    resolveWorkspace: () => {
      assertManagerReadable()
      return resolveWorkspace()
    },
    get transactionWorkspace() { return transactionWorkspace },
    set transactionWorkspace(value: string | null) { transactionWorkspace = value },
    startupTransaction: () => trackOperation(startupTransaction()),
    status,
    activationFacts: () => {
      assertManagerReadable()
      return activationFacts()
    },
    mutationInProgress,
    mutationInFlight: mutationInProgress,
    activationInProgress,
    exposureQuarantined,
    internalSpawnActive,
    observeLocalState,
    listVersions,
    select: (version) => trackOperation(select(version)),
    apply: () => trackOperation(apply()),
    applyNow,
    applyNowPreflight,
    rollback: (version) => trackOperation(rollback(version)),
    cleanupVersion: (version) => trackOperation(cleanupVersion(version)),
    restorePreRollback: (stashName) => trackOperation(restorePreRollbackStash(stashName)),
    recoverMetadata: () => trackOperation(recoverMetadata()),
    metadataRecoveryPending,
    pruneStoreIfNeeded: runStorePruneIfNeeded,
    restoreBuiltin: () => trackOperation(restoreBuiltin()),
    retryApply: () => trackOperation(retryApply()),
    retryRestore: () => trackOperation(retryRestore()),
    restart: () => trackOperation(restart()),
    restartInFlight: () => restartInFlight,
    start: () => trackOperation(start()),
    startInFlight: () => startInFlight,
    profileWriteInFlight,
    beginProfileWrite,
    applyNowInFlight: () => applyNowInFlight,
    getRegistry,
    setRegistry: (origin) => trackOperation(setRegistry(origin)),
    dispose,
  }
}
