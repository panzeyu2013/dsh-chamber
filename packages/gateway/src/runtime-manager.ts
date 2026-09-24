/**
 * Gateway dsh runtime version management: composes the shared
 * `@dsh-chamber/dsh-runtime` core through its StartupDeps/ApplyDeps/
 * InstallerDeps seams, with runtime trees / pointer / override / journal /
 * snapshots under `<stateDir>/dsh-runtime/` (and the gateway registry.json).
 * Resolution chain: DSH_GATEWAY_DSH_PATH (highest) → override (valid tree) →
 * builtin anchor (`--dsh-path`). Single-writer: one writer per state root; no
 * second lock — production adopts the createGateway state-root lease
 * (root/scope check + assertCurrent, never released here); a
 * directly constructed manager self-acquires the one
 * `<stateDir>/owner.json` lease and releases it on dispose.
 */
import { createRequire as nodeCreateRequire } from 'node:module'
import { join, resolve } from 'node:path'
import {
  acquireStateRootLease,
  type Logger,
  type PlaneHandle,
  type StateRootLease,
} from '@dsh-chamber/control-plane'
import {
  canonicalRegistryOrigin,
  DEFAULT_REGISTRY_ORIGIN,
  ensureRuntimeRootNoFollow,
  fetchRegistryMetadata,
  RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
  readAnchorVersion,
  type RuntimeInstallProgress,
  type StartupDeps,
} from '@dsh-chamber/dsh-runtime'
import { createRuntimeDiskProjection } from './runtime-disk-projection.ts'
import { createRuntimeActionGuards, type ProfileWriteRefusalCode } from './runtime-actions.ts'
import { createMetadataStatusProjection } from './runtime-status-projection.ts'
import { resolvePnpmEntry } from './pnpm-entry.ts'
import type { GatewayConfig } from './config.ts'
// Single sources: the in-flight writer matrix + mutation/profile-write fences
// live in runtime-actions.ts; every refusal code/message shared with the route
// pre-gates comes from runtime-refusals.ts (recovery reason sets included).
import { refuseOnEnvPinned, refuseRuntimeMutationOnWindows } from './runtime/guards.ts'

import { readRegistryOrigin, writeRegistryOrigin } from './runtime/registry-source.ts'
import { createRuntimeWorkspaceFacts, type ResolvedWorkspace } from './runtime/workspace-facts.ts'
import { createRuntimeWriteFence } from './runtime/write-fence.ts'
import { createStartupTransactionRunner, type ProbeCandidate } from './runtime/startup-transaction.ts'
import { createRuntimeVersionActions } from './runtime/versions.ts'
import { createRuntimeLifecycle } from './runtime/lifecycle.ts'
import { createRuntimeStatusProjection, type GatewayRuntimeStatus } from './runtime/projection.ts'
import type { RuntimeModuleContext } from './runtime/context.ts'
import { createRuntimeRecoveryActions } from './runtime/recovery.ts'

const gatewayRequire = nodeCreateRequire(import.meta.url)

const GATEWAY_PACKAGE_VERSION: string = gatewayRequire('../package.json').version as string
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
/** 10 GiB logical disk soft-limit — the shared core value; desktop projects the same constant. */
const GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES = RUNTIME_LOGICAL_DISK_LIMIT_BYTES
import { GATEWAY_RUNTIME_STATUS_KIND } from '@dsh-chamber/dsh-chamber-wire/runtime-status'

/** Public re-export of the wire identity. */
export { GATEWAY_RUNTIME_STATUS_KIND }

/** Rollback-vs-lease serialization bound: the restart-exhausted rollback waits
 * at most this long for the profile-write lease to drain, then DEFERS — a
 * DSH_HOME write must never interleave a live plugin pnpm child, and the
 * transaction's only lease-aware point comes AFTER its restore step. */
export const ROLLBACK_LEASE_WAIT_MS = 15 * 60_000

export type { ResolvedWorkspace } from './runtime/workspace-facts.ts'

export type { GatewayRuntimeStatus } from './runtime/projection.ts'

/** Managed profile-write lease refusal codes; every code maps to an existing /chamber/runtime 409 family. */
export type { ProfileWriteRefusalCode } from './runtime-actions.ts'

/** The lease from beginProfileWrite(): held across the caller's complete
 * `dsh plugin` write, released on all paths, underflow-guarded (fail-loud). */
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
  /** Execution-window accessor (the plugin executor's canRun gate): true while
   * any runtime mutation writer is in flight — same internal flag set as
   * mutationInProgress(). */
  mutationInFlight(): boolean
  activationInProgress(): boolean
  /** Sticky public-exposure fence: stays true after an unsafe blocked verdict so
   * recovery routes stay reachable without letting the failed runtime serve. */
  exposureQuarantined(): boolean
  internalSpawnActive(): boolean
  /** Feed authoritative local-host state edges into the sustained-health
   * monitor. Candidate edges are ignored while activation is quarantined. */
  observeLocalState(status: string): void
  listVersions(): Promise<unknown>
  select(version: string): Promise<{ accepted: boolean; version: string }>
  apply(): Promise<{ pending: boolean }>
  /** Immediately apply the pending/staged switch in the current session:
   * stop → activation transaction → resume; 202 semantics via status(). */
  applyNow(): Promise<{ accepted: boolean }>
  /** Synchronous apply-now gate: every manager refusal runs here so the route
   * answers a 409/403 BEFORE any 202 — a preflight throw must never become a
   * fake 202. Returns the resolved target version. */
  applyNowPreflight(): string
  rollback(version: string): Promise<{ accepted: boolean }>
  /** User-authorized cleanup of one installed version tree: ledger-gated +
   *  protection-set re-read at the deletion point; consumes the store-prune marker. */
  cleanupVersion(version: string): Promise<{ version: string; removed: boolean }>
  /** Restore the newest pre-rollback stash over DSH_HOME; a half restore leaves
   *  restore-blocked for retry-restore to resume. */
  restorePreRollback(stashName: string): Promise<{ accepted: true }>
  /** Metadata FATAL rescue: archives corrupt selection metadata with a full
   *  DSH_HOME copy and runs the builtin anchor through the probe gate. */
  recoverMetadata(): Promise<{ accepted: true }>
  /** True while a metadata-recovery transaction is pending or the marker is
   *  corrupt. The tri-state `'unknown'` is the fail-closed answer when the
   *  metadata cannot be READ; the boot path treats it exactly like `true`. */
  metadataRecoveryPending(): boolean | 'unknown'
  /** Consume the durable store-prune marker if present; single-flight, marker retained on failure. */
  pruneStoreIfNeeded(): Promise<void>
  restoreBuiltin(): Promise<{ accepted: boolean }>
  /** Resume an interrupted pointer switch by re-running the startup transaction. */
  retryApply(): Promise<{ accepted: boolean; blockedReason: string | null }>
  /** Resume an interrupted snapshot restore by re-running the startup transaction. */
  retryRestore(): Promise<{ accepted: boolean; blockedReason: string | null }>
  restart(): Promise<void>
  restartInFlight(): boolean
  /** Explicit start primitive: bring the managed dsh up from stopped/error/
   * restart-exhausted through the plane's guarded startLocal path; the refusal
   * gates mirror the route. 202 semantics — outcome projected via status(). */
  start(): Promise<void>
  startInFlight(): boolean
  /** Lifecycle writer barrier: true while a profile-write lease is held — runtime
   * mutations and every spawn refuse while a plugin write could interleave. */
  profileWriteInFlight(): boolean
  /** Acquire the managed profile-write lease. Synchronous refusal ({ ok:false })
   * while a runtime mutation, durable recovery/pending phase or start/restart is
   * active. Success increments the counter; release() decrements it. */
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
  /** Host-side probe seam; production executes the complete shared probe list. */
  probeCandidate?: ProbeCandidate
  /** Registry fetch seam for deterministic offline/cache tests. */
  fetchMetadata?: typeof fetchRegistryMetadata
  /** Delayed-verdict seam; production keeps the shared two-second delay. */
  waitBeforeRetry?: StartupDeps['waitBeforeRetry']
  /** Sustained-health clock/scheduler seams (production: wall clock + unref'ed hourly tick). */
  nowMs?: () => number
  scheduleKnownGoodPromotion?: (callback: () => void) => () => void
  /** Platform adapter seam. Windows stays entirely outside POSIX writer paths;
   * production omits this and uses process.platform. */
  platform?: NodeJS.Platform
  /** Rollback-vs-lease drain bound override (tests only). */
  rollbackLeaseWaitMs?: number
  /** The state-root writer lease held by createGateway. When supplied the manager
   * adopts it (assertCurrent) and never releases it; absent, it self-acquires. */
  stateLease?: StateRootLease
  /** Host composition hook: detach dsh-derived consumers as a quarantine opens
   * and resync them after the verdict (ready edges race the probe otherwise). */
  onActivationQuarantineChange?: (active: boolean) => void
}

export function createGatewayRuntimeManager(options: GatewayRuntimeManagerOptions): GatewayRuntimeManager {
  const { config, plane, logger } = options
  // baseDir feeds the shared core (which appends `dsh-runtime`); stateRoot is it.
  const baseDir = config.plane.stateDir
  const platform = options.platform ?? process.platform
  // Windows is an explicitly read-only projection: do not enter the POSIX
  // O_NOFOLLOW/O_DIRECTORY writer primitives (no equivalent Node open flags).
  const stateRoot = platform === 'win32'
    ? join(baseDir, 'dsh-runtime')
    : ensureRuntimeRootNoFollow(baseDir)
  const dshHome = join(baseDir, 'dsh-home')
  const anchor = config.plane.dshWorkspacePath
  const envPath = process.env.DSH_GATEWAY_DSH_PATH?.trim() || null
  const shellVersion = GATEWAY_PACKAGE_VERSION
  const builtinVersion = readAnchorVersion(anchor)
  const nowMs = options.nowMs ?? Date.now

  // State-root writer lease: production adopts the createGateway handle
  // (root/scope check + assertCurrent); a direct construction self-acquires.
  const adoptedLease = options.stateLease
  if (adoptedLease !== undefined) {
    if (adoptedLease.scope !== 'state-root' || adoptedLease.stateRoot !== resolve(baseDir)) {
      throw new Error(`gateway runtime manager stateDir does not match the state-root lease: ${adoptedLease.stateRoot}`)
    }
    adoptedLease.assertCurrent()
  }
  const selfLease = adoptedLease === undefined && platform !== 'win32'
    ? acquireStateRootLease(baseDir, { scope: 'state-root', flavor: 'gateway', logger })
    : null

  // Projection facts: runtime modules write through these handles; status() reads them back.
  let startupBlockReason: string | null = null
  /** Last select/restart failure, surfaced in status; cleared by the next success. */
  let operationError: string | null = null
  let installProgress: RuntimeInstallProgress | null = null
  /** Last restart outcome, projected in status(): the settings poll must tell a
   * post-202 rejection from success even when connectionState is 'ready'. */
  let restartOutcome: 'ok' | 'failed' | 'running' | null = null
  /** Start primitive outcome (mirrors restart). */
  let startOutcome: 'ok' | 'failed' | 'running' | null = null

  // Every synchronous writer latch (quarantine, single-flight flags, lease,
  // internal-spawn, lifecycle epoch) lives in one fence module.
  const writeFence = createRuntimeWriteFence({
    logger,
    getStartupBlockReason: () => startupBlockReason,
    // Read through `options` at call time: a host may install the hook after construction.
    onQuarantineChange: (active) => { options.onActivationQuarantineChange?.(active) },
  })

  const facts = createRuntimeWorkspaceFacts({
    anchor,
    stateRoot,
    baseDir,
    platform,
    shellVersion,
    builtinVersion,
    getEnvPath: () => envPath,
  })

  // Injected as getters so writer transitions stay immediate.
  const metadataStatus = createMetadataStatusProjection({
    platform,
    baseDir,
    shellVersion,
    getStartupBlockReason: () => startupBlockReason,
    getEnvPath: () => envPath,
    getBuiltinVersion: () => builtinVersion,
    isWriterBusy: () => writeFence.metadataWriterBusy(),
    isDisposed: () => writeFence.isDisposed(),
  })

  const diskCacheProjection = createRuntimeDiskProjection({ baseDir, dshHome })

  function invalidateDiskCache(): void {
    diskCacheProjection.invalidate()
    metadataStatus.invalidate()
  }

  // Single source with the executor's PATH shim: pnpm-entry.ts owns the resolution.
  const pnpmEntry = (): string => resolvePnpmEntry()

  // /chamber/runtime actions

  // The pending fences, writer matrix and lease gates are shared by every body below.
  const actionGuards = createRuntimeActionGuards({
    platform,
    baseDir,
    shellVersion,
    getEnvPath: () => envPath,
    getStartupBlockReason: () => startupBlockReason,
    isDisposed: () => writeFence.isDisposed(),
    isActivationInProgress: () => writeFence.activationInProgress(),
    isInstallInFlight: () => writeFence.isInstallInFlight(),
    isRestartInFlight: () => writeFence.isRestartInFlight(),
    isApplyNowInFlight: () => writeFence.isApplyNowInFlight(),
    isRestartExhaustedRollbackInFlight: () => writeFence.isRestartExhaustedRollbackInFlight(),
    isStartInFlight: () => writeFence.isStartInFlight(),
    isProfileWriteInFlight: () => writeFence.profileWriteInFlight(),
    getConnectionState: () => plane.connectionState,
  })
  const {
    persistedPendingVersion,
    ordinaryPendingVersion,
    assertNoOrdinaryPending,
    assertNoPending,
    assertMutationIdle,
    profileWriteRefusal,
  } = actionGuards

  // Startup transaction driver: candidate/env probe spawns, StartupDeps assembly,
  // the blocked projection and the candidate-workspace latch; the shared module
  // context is spread into every call, which adds only its own inputs.
  const runtimeContext: RuntimeModuleContext = { plane, platform, baseDir, envPath, facts, writeFence }

  const startup = createStartupTransactionRunner({
    ...runtimeContext,
    logger,
    stateRoot,
    dshHome,
    anchor,
    shellVersion,
    builtinVersion,
    nowMs,
    probeCandidate: options.probeCandidate,
    waitBeforeRetry: options.waitBeforeRetry,
    assertMutationIdle,
    hooks: {
      invalidateDiskCache,
      setStartupBlockReason: (value) => { startupBlockReason = value },
      setOperationError: (value) => { operationError = value },
    },
  })

  // Lifecycle owner: store prune, known-good promotion, rollback, restart/start, dispose.
  const lifecycle = createRuntimeLifecycle({
    ...runtimeContext,
    logger,
    nowMs,
    assertMutationIdle,
    assertNoPending,
    getStartupBlockReason: () => startupBlockReason,
    getRestartOutcome: () => restartOutcome,
    getStartOutcome: () => startOutcome,
    startup,
    pnpmEntry,
    scheduleKnownGoodPromotion: options.scheduleKnownGoodPromotion,
    rollbackLeaseWaitMs: options.rollbackLeaseWaitMs ?? ROLLBACK_LEASE_WAIT_MS,
    releaseSelfLease: () => { selfLease?.release() },
    hooks: {
      invalidateDiskCache,
      setOperationError: (value) => { operationError = value },
      setRestartOutcome: (value) => { restartOutcome = value },
      setStartOutcome: (value) => { startOutcome = value },
    },
  })
  // Version selection/apply/rollback/cleanup and builtin restore: mutation bodies
  // live in versions.ts; this wiring passes the guards, facts, fence and setters.
  const versions = createRuntimeVersionActions({
    ...runtimeContext,
    shellVersion,
    builtinVersion,
    diskLimitBytes: GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
    dshPackageName: DSH_PACKAGE_NAME,
    fetchMetadata: options.fetchMetadata,
    pnpmEntry,
    diskCacheProjection,
    assertMutationIdle,
    assertNoPending,
    getStartupBlockReason: () => startupBlockReason,
    ordinaryPendingVersion,
    persistedPendingVersion,
    startup,
    hooks: {
      invalidateDiskCache,
      runStorePruneIfNeeded: lifecycle.pruneStoreIfNeeded,
      setStartupBlockReason: (value) => { startupBlockReason = value },
      setOperationError: (value) => { operationError = value },
      setRestartOutcome: (value) => { restartOutcome = value },
      setStartOutcome: (value) => { startOutcome = value },
      setInstallProgress: (value) => { installProgress = value },
    },
  })

  // Recovery surface: metadata rescue, pre-rollback stash restore, retries.
  const recovery = createRuntimeRecoveryActions({
    ...runtimeContext,
    dshHome,
    shellVersion,
    assertMutationIdle,
    assertNoOrdinaryPending,
    getStartupBlockReason: () => startupBlockReason,
    startup,
    hooks: {
      invalidateDiskCache,
      setStartupBlockReason: (value) => { startupBlockReason = value },
      setOperationError: (value) => { operationError = value },
      setRestartOutcome: (value) => { restartOutcome = value },
    },
  })


  // Status projection: read-only over every module handle.
  const projection = createRuntimeStatusProjection({
    ...runtimeContext,
    shellVersion,
    builtinVersion,
    diskLimitBytes: GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
    metadataStatus,
    diskCacheProjection,
    getStartupBlockReason: () => startupBlockReason,
    getOperationError: () => operationError,
    getRestartOutcome: () => restartOutcome,
    getStartOutcome: () => startOutcome,
    getInstallProgress: () => installProgress,
  })

  function beginProfileWrite(): ProfileWriteLease {
    const refusal = profileWriteRefusal()
    if (refusal !== null) return { ok: false, code: refusal.code, error: refusal.error }
    return { ok: true, release: writeFence.acquireProfileWrite().release }
  }

  // Promotion uses a live in-process interval, never elapsed offline wall time.

  function getRegistry(): { origin: string } {
    writeFence.assertManagerReadable()
    return { origin: platform === 'win32' ? DEFAULT_REGISTRY_ORIGIN : readRegistryOrigin(baseDir) }
  }

  async function setRegistry(origin: string): Promise<{ origin: string }> {
    refuseRuntimeMutationOnWindows(platform)
    assertMutationIdle()
    refuseOnEnvPinned(envPath, 'registry mutation')
    assertNoPending()
    const canonical = canonicalRegistryOrigin(origin)
    if (canonical === null) throw Object.assign(new Error('invalid registry origin'), { code: 'bad_registry_origin' })
    writeRegistryOrigin(baseDir, canonical)
    return { origin: canonical }
  }

  return {
    stateRoot: () => stateRoot,
    resolveWorkspace: () => {
      writeFence.assertManagerReadable()
      return facts.resolveWorkspace()
    },
    get transactionWorkspace() { return startup.transactionWorkspace() },
    set transactionWorkspace(value: string | null) { startup.setTransactionWorkspace(value) },
    startupTransaction: () => writeFence.trackOperation(startup.startupTransaction()),
    status: projection.status,
    activationFacts: () => {
      writeFence.assertManagerReadable()
      return facts.activationFacts()
    },
    mutationInProgress: writeFence.mutationInProgress,
    mutationInFlight: writeFence.mutationInProgress,
    activationInProgress: writeFence.activationInProgress,
    exposureQuarantined: writeFence.exposureQuarantined,
    internalSpawnActive: writeFence.internalSpawnActive,
    observeLocalState: lifecycle.observeLocalState,
    listVersions: versions.listVersions,
    select: (version) => writeFence.trackOperation(versions.select(version)),
    apply: () => writeFence.trackOperation(versions.apply()),
    applyNow: versions.applyNow,
    applyNowPreflight: versions.applyNowPreflight,
    rollback: (version) => writeFence.trackOperation(versions.rollback(version)),
    cleanupVersion: (version) => writeFence.trackOperation(versions.cleanupVersion(version)),
    restorePreRollback: (stashName) => writeFence.trackOperation(recovery.restorePreRollbackStash(stashName)),
    recoverMetadata: () => writeFence.trackOperation(recovery.recoverMetadata()),
    metadataRecoveryPending: recovery.metadataRecoveryPending,
    pruneStoreIfNeeded: lifecycle.pruneStoreIfNeeded,
    restoreBuiltin: () => writeFence.trackOperation(versions.restoreBuiltin()),
    retryApply: () => writeFence.trackOperation(recovery.retryApply()),
    retryRestore: () => writeFence.trackOperation(recovery.retryRestore()),
    restart: () => writeFence.trackOperation(lifecycle.restart()),
    restartInFlight: () => writeFence.isRestartInFlight(),
    start: () => writeFence.trackOperation(lifecycle.start()),
    startInFlight: () => writeFence.isStartInFlight(),
    profileWriteInFlight: writeFence.profileWriteInFlight,
    beginProfileWrite,
    applyNowInFlight: () => writeFence.isApplyNowInFlight(),
    getRegistry,
    setRegistry: (origin) => writeFence.trackOperation(setRegistry(origin)),
    dispose: lifecycle.dispose,
  }
}
