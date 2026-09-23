/**
 * Gateway dsh runtime version management (design 18 §9.3): composes the
 * shared `@dsh-chamber/dsh-runtime` core through its StartupDeps/ApplyDeps/
 * InstallerDeps seams (RuntimeHostAdapter remains a documented sketch).
 *
 * Storage layout (design 18 §9.3 + design 17 §10): the shared core appends
 * `dsh-runtime` under its `baseDir`, so the gateway passes `stateDir` as
 * baseDir — version trees / current pointer / override / journal / snapshots
 * land in `<stateDir>/dsh-runtime/`, exactly like desktop's `<userData>/
 * dsh-runtime/`. The gateway's own registry.json lives in the same directory
 * (stateRoot == runtimeDirPath(stateDir)).
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
 * Single-writer invariant (R2): one writer per state root. The manager does
 * NOT own a second lock — production adopts the createGateway state-root
 * lease (root/scope check + assertCurrent only, never released here); a
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
// The in-flight writer matrix + mutation/profile-write fences live in
// runtime-actions.ts. Refusal construction + recovery-name classification
// single sources: every code/message this manager shares with the route
// pre-gates in runtime-routes.ts comes from runtime-refusals.ts; canonical
// recovery reason sets (incl. RECOVERABLE_METADATA_BLOCKS) live there and are
// consumed by both runtime layers.
import {
  envPinnedRefusal,
  refusalError,
} from './runtime-refusals.ts'

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
/** 10 GiB logical disk soft-limit — shared core value (dsh-runtime
 * RUNTIME_LOGICAL_DISK_LIMIT_BYTES); the desktop owner projects the same
 * constant as its diskLimitBytes. */
const GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES = RUNTIME_LOGICAL_DISK_LIMIT_BYTES
import { GATEWAY_RUNTIME_STATUS_KIND } from '@dsh-chamber/dsh-chamber-wire/runtime-status'

/** Public re-export of the wire identity (single source:
 * @dsh-chamber/dsh-chamber-wire/runtime-status). */
export { GATEWAY_RUNTIME_STATUS_KIND }

/**
 * Rollback-vs-lease serialization bound (design 21 §6.3 decision 6/17, F7
 * gate): the automatic restart-exhausted rollback waits at most this
 * long for the managed profile-write lease counter to drain before it DEFERS
 * — a DSH_HOME write must never interleave a live plugin pnpm child, and the
 * only lease-aware point inside the rollback transaction (the spawn
 * checkpoint) comes AFTER its restore step writes DSH_HOME.
 */
export const ROLLBACK_LEASE_WAIT_MS = 15 * 60_000

export type { ResolvedWorkspace } from './runtime/workspace-facts.ts'

export type { GatewayRuntimeStatus } from './runtime/projection.ts'

/** Managed profile-write lease refusal codes (design 21 §6.3 decision 6/17).
 * Every code maps to an existing /chamber/runtime 409 family. */
export type { ProfileWriteRefusalCode } from './runtime-actions.ts'

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
  /** Synchronous apply-now gate: every manager refusal
   * (platform / busy / env / target resolution / tree validation / no-op)
   * runs here so the route answers a 409/403 BEFORE any 202 can go out —
   * a preflight throw must never be swallowed into a fake 202 whose status
   * never settles. Returns the resolved target version. */
  applyNowPreflight(): string
  rollback(version: string): Promise<{ accepted: boolean }>
  /** User-authorized cleanup of one explicitly installed version tree
   *  (desktop parity): ledger-gated + protection-set re-read at the
   *  deletion point; consumes the durable store-prune marker afterwards. */
  cleanupVersion(version: string): Promise<{ version: string; removed: boolean }>
  /** Restore the newest pre-rollback stash over DSH_HOME (desktop parity);
   *  half leaves restore-blocked for retry-restore to resume. */
  restorePreRollback(stashName: string): Promise<{ accepted: true }>
  /** Metadata FATAL rescue (desktop parity): archives corrupt
   *  selection metadata with a full DSH_HOME copy and runs the builtin
   *  anchor through the probe gate before restoring access. */
  recoverMetadata(): Promise<{ accepted: true }>
  /** True while a durable metadata-recovery transaction is pending or the
   *  recovery marker is corrupt (boot preflight gate). */
  metadataRecoveryPending(): boolean
  /** Consume the durable store-prune marker if present (boot boundary);
   *  single-flight, marker retained on failure. */
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
  probeCandidate?: ProbeCandidate
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
  /** The state-root writer lease held by createGateway (R2). When supplied the
   * manager adopts it (same root/scope + assertCurrent) and never releases it;
   * when absent (direct constructions/tests) the manager self-acquires one
   * lease and releases it in dispose(). */
  stateLease?: StateRootLease
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
  const builtinVersion = readAnchorVersion(anchor)
  const nowMs = options.nowMs ?? Date.now

  // State-root writer lease (R2). Production adopts the createGateway handle
  // (root/scope check + assertCurrent); a direct construction self-acquires
  // exactly one lease and releases it in dispose(). The old second owner
  // record (<stateDir>/dsh-runtime/owner.json) is gone.
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

  // Projection facts: every runtime module writes through these handles; the
  // manager is their single owner and status() reads them back.
  let startupBlockReason: string | null = null
  /** Last select/restart failure, surfaced in status (async job failures must
   *  stay observable; cleared by the next successful action). */
  let operationError: string | null = null
  let installProgress: RuntimeInstallProgress | null = null
  /** Last restart outcome, projected in status(): the settings
   * poll must be able to distinguish a post-202 entry rejection from success
   * even when connectionState has already returned to 'ready'. */
  let restartOutcome: 'ok' | 'failed' | 'running' | null = null
  /** Decision-12 start primitive outcome (mirrors restart). */
  let startOutcome: 'ok' | 'failed' | 'running' | null = null

  // Every synchronous writer latch (activation quarantine window, writer
  // single-flight flags, managed profile-write lease, internal-spawn latch and
  // the lifecycle writer epoch) lives in one fence module so the counters stay
  // single-sourced and every derived predicate reads the live value.
  const writeFence = createRuntimeWriteFence({
    logger,
    getStartupBlockReason: () => startupBlockReason,
    // The hook is read through `options` at call time, exactly like the
    // original optional call (a host may install it after construction).
    onQuarantineChange: (active) => { options.onActivationQuarantineChange?.(active) },
  })

  // Read-only resolution-chain facts (design 18 §3.5/§9.3).
  const facts = createRuntimeWorkspaceFacts({
    anchor,
    stateRoot,
    baseDir,
    platform,
    shellVersion,
    builtinVersion,
    getEnvPath: () => envPath,
  })

  // Metadata health facts/projection live in their own module; the in-memory
  // recover gate is injected as getters so writer transitions stay immediate.
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

  // Disk stats live in their own module; the cache and the coalesced walk keep
  // the same semantics.
  const diskCacheProjection = createRuntimeDiskProjection({ baseDir, dshHome })

  function invalidateDiskCache(): void {
    diskCacheProjection.invalidate()
    metadataStatus.invalidate()
  }

  // Single source with the plugin executor's PATH shim: pnpm-entry.ts owns the
  // bundled-vs-dev resolution (design 18 §9.2 D1); the shim it generates points
  // at exactly this entry.
  const pnpmEntry = (): string => resolvePnpmEntry()

  // /chamber/runtime actions (design 18 §9.3 route table)

  // Action guards/resolution live in their own module:
  // the pending fences, the in-flight writer matrix and the profile-write lease
  // gates are shared by every transaction body below.
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

  // Startup transaction driver (design 17 §4.1): candidate/env probe spawns,
  // StartupDeps assembly, the F4/blocked projection and the candidate-
  // workspace latch consulted by getDshWorkspacePath.
  // One shared module context: the immutable construction facts plus the
  // two cross-cluster handles (resolution facts, write fence). Every module
  // call spreads this object and adds only its own narrow inputs.
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

  // Lifecycle owner (design 18 §9.3): store prune, known-good observation/
  // promotion, the F7 restart-exhausted rollback, restart/start and dispose.
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
  // Version selection/apply/rollback/cleanup and builtin restore (design 18
  // §9.3). The mutation bodies live in versions.ts; this wiring passes the
  // action guards, resolution facts, fence, startup driver and the manager-
  // owned projection setters.
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

  // Recovery surface (design 18 §3.6/§9.3): metadata rescue, pre-rollback
  // stash restore and the retry-apply/retry-restore resumes.
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


  // Status projection (design 18 §9.3): read-only over every module handle.
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

  // Promotion is based on a live in-process interval, never elapsed offline
  // wall time. observeLocalState closes the window on every unhealthy edge.

  function getRegistry(): { origin: string } {
    writeFence.assertManagerReadable()
    return { origin: platform === 'win32' ? DEFAULT_REGISTRY_ORIGIN : readRegistryOrigin(baseDir) }
  }

  async function setRegistry(origin: string): Promise<{ origin: string }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw refusalError(envPinnedRefusal('registry mutation'))
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
