/**
 * Gateway runtime status projection: the read-only `GET /chamber/runtime/status`
 * shape, projected over the manager's live handles. The module owns no state — every
 * fact is read through a getter, so a writer transition shows on the next poll.
 */
import {
  DEFAULT_REGISTRY_ORIGIN,
  runtimeFailureSummary,
  readCurrentPointerState,
  readOverrideState,
  shouldInvalidate,
  snapshotSummary,
  type RuntimeDiskSummary,
  type RuntimeInstallProgress,
  type RuntimeStatusProjection,
} from '@dsh-chamber/dsh-runtime'
import { GATEWAY_RUNTIME_STATUS_KIND } from '@dsh-chamber/dsh-chamber-wire/runtime-status'
import type { RuntimeDiskProjection } from '../runtime-disk-projection.ts'
import type { MetadataStatusProjection } from '../runtime-status-projection.ts'
import { startupBlockReasonOutranksPending } from '../runtime-refusals.ts'
import { sanitizeRouteError } from '../sanitize-route-error.ts'
import { readRegistryOrigin } from './registry-source.ts'
import type { ResolvedWorkspace } from './workspace-facts.ts'
import type { RuntimeModuleContext } from './context.ts'

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
  /** Last explicit start outcome, projected like `restart`: 'running' from
   * acceptance until it settles, then 'ok'/'failed'. The settings poll uses it to tell
   * a post-entry rejection (operationError set, connectionState stopped) from a
   * genuine success. */
  start: 'ok' | 'failed' | 'running' | null
  restoreOutcome: string | null
  snapshotCount: number | null
  latestSnapshotAt: string | null
  snapshotError: string | null
  restoreInProgress: boolean | null
  preRollbackCount: number | null
  preRollbackLatestName: string | null
  failure: { version: string; at: string; reason: string } | null
  /** Non-null exactly when the failure set could not be read; `failure` is then null because a fabricated 0 is not a fact. */
  failureError: string | null
  diskUsage: RuntimeDiskSummary | null
  diskError: string | null
  diskLimitBytes: number
  diskLimitExceeded: boolean | null
  progress: RuntimeInstallProgress | null
  /** Desktop-shaped metadata health projection (recover-metadata). */
  metadataHealth: 'unknown' | 'healthy' | 'selection-corrupt' | 'recovery-in-progress' | 'recovery-finalized' | 'recovery-marker-corrupt'
  metadataComponents: string[]
  canRecoverMetadata: boolean
}

export interface RuntimeStatusProjectionDeps extends RuntimeModuleContext {
  shellVersion: string
  builtinVersion: string | null
  diskLimitBytes: number
  metadataStatus: MetadataStatusProjection
  diskCacheProjection: RuntimeDiskProjection
  getStartupBlockReason(): string | null
  getOperationError(): string | null
  getRestartOutcome(): 'ok' | 'failed' | 'running' | null
  getStartOutcome(): 'ok' | 'failed' | 'running' | null
  getInstallProgress(): RuntimeInstallProgress | null
}

export interface RuntimeStatusProjectionApi {
  status(): Promise<GatewayRuntimeStatus>
}

export function createRuntimeStatusProjection(deps: RuntimeStatusProjectionDeps): RuntimeStatusProjectionApi {
  const {
    plane,
    platform,
    baseDir,
    shellVersion,
    builtinVersion,
    envPath,
    diskLimitBytes,
    metadataStatus,
    diskCacheProjection,
    facts,
    writeFence,
    getStartupBlockReason,
    getOperationError,
    getRestartOutcome,
    getStartOutcome,
    getInstallProgress,
  } = deps

  async function status(): Promise<GatewayRuntimeStatus> {
    writeFence.assertManagerReadable()
    // Desktop-shaped metadata health projection (recover-metadata parity): category-only components, never paths.
    const metadata = metadataStatus.projection()
    if (platform === 'win32') {
      const resolved = facts.resolveWorkspace()
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
        operationError: getOperationError(),
        restart: getRestartOutcome(),
        start: getStartOutcome(),
        restoreOutcome: null,
        snapshotCount: null,
        latestSnapshotAt: null,
        snapshotError: null,
        restoreInProgress: null,
        preRollbackCount: null,
        preRollbackLatestName: null,
        failure: null,
        failureError: null,
        diskUsage: null,
        diskError: null,
        diskLimitBytes: diskLimitBytes,
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
      resolved = facts.resolveWorkspace()
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
    if (getStartupBlockReason() === 'snapshot-failed' && snapshotError === null) {
      snapshotError = override?.lastError ?? 'runtime data snapshot failed'
    }
    const failures = runtimeFailureSummary(baseDir)
    const failure = failures.latest === null ? null : {
      version: failures.latest.version,
      at: failures.latest.lastFailedAt,
      reason: failures.latest.error,
    }
    const failureError = failures.kind === 'unknown' ? failures.detail : null
    // Full logical accounting is a batched async tree walk; cache it so the 3s UI poll
    // and identity probes never turn status into a hot 10 GiB filesystem walk
    // (mutations invalidate the cache).
    const { usage: diskUsage, error: diskError } = await diskCacheProjection.projection()
    const effectiveBlockedReason = getStartupBlockReason() ?? resolutionError
    const effectivePending = envPath === null && override !== null && !shouldInvalidate(override, shellVersion) && override.pending !== null
      ? override.pending : null
    // A FATAL/RECOVERABLE metadata block must also suppress the ordinary-pending
    // phase: journal-corrupt + stale pending would otherwise lock the only recovery
    // surface behind the pending gate (block-outranks-pending single source).
    const blockOutranksPending = startupBlockReasonOutranksPending(getStartupBlockReason())
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
      // apply-now remains applying through its post-quarantine recovery tail:
      // activationDepth alone would open a false idle window after the probe
      // verdict but before startLocal/error state settles.
      phase: writeFence.activationInProgress() || writeFence.isApplyNowInFlight() || writeFence.isRestartExhaustedRollbackInFlight() ? 'applying'
        : writeFence.isInstallInFlight() ? 'installing'
        : getStartupBlockReason() === 'snapshot-failed' ? 'snapshot-failed'
        : getStartupBlockReason() === 'swap-attempted' ? 'swap-attempted'
        : getStartupBlockReason() === 'restore-half' || getStartupBlockReason() === 'restore-incomplete' ? 'restore-blocked'
        : ordinaryPending ? 'pending'
        : 'idle',
      // Projected so clients can see WHY the managed dsh is down and which resume route applies.
      startupBlockedReason: effectiveBlockedReason,
      pending: effectivePending,
      connectionState: plane.connectionState,
      registry,
      registryError,
      platform,
      mutationsAllowed: true,
      operationError: getOperationError(),
      // Last restart outcome: 'running' from acceptance until it settles, then
      // 'ok'/'failed'. The settings-bridge poll uses it to tell a post-entry
      // rejection (operationError set, connectionState ready) from a genuine success.
      restart: getRestartOutcome(),
      start: getStartOutcome(),
      restoreOutcome: override?.restoreOutcome ?? null,
      snapshotCount,
      latestSnapshotAt,
      snapshotError,
      restoreInProgress,
      preRollbackCount,
      preRollbackLatestName,
      failure,
      failureError,
      diskUsage,
      diskError,
      diskLimitBytes: diskLimitBytes,
      diskLimitExceeded: diskUsage === null
        ? null
        : diskUsage.totalBytes >= diskLimitBytes,
      progress: getInstallProgress(),
      metadataHealth: metadata.metadataHealth,
      metadataComponents: metadata.metadataComponents,
      canRecoverMetadata: metadata.canRecoverMetadata,
    }
  }

  return { status }
}
