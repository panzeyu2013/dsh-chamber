/**
 * Gateway runtime recovery actions (design 18 §3.6/§9.3): the metadata FATAL
 * rescue, the pre-rollback stash restore and the retry-apply/retry-restore
 * resumes. The module owns no mutable state; it receives the manager's guards,
 * fence, resolution facts, startup driver (for the shared resume tail) and the
 * projection-fact setters.
 */
import {
  completeInterruptedRestore,
  detectRuntimeMetadataHealth,
  inspectCorruptMetadataRecoveryMarker,
  isSafeVersion,
  listKnownGoodVersionsState,
  listPreRollbackStashes,
  projectMetadataRecoveryGate,
  recoverRuntimeMetadata,
  rescueCorruptMetadataRecoveryMarker,
  restorePreRollback,
  writeOverride,
} from '@dsh-chamber/dsh-runtime'
import { syncedHostDomainProbeNames } from '../plugins.ts'
import {
  RECOVERABLE_METADATA_BLOCKS,
  RETRY_RESTORE_REASONS,
} from '../runtime-refusals.ts'
import { refuseOnEnvPinned, refuseRuntimeMutationOnWindows, readOverrideForDecision } from './guards.ts'
import { sanitizeRouteError } from '../sanitize-route-error.ts'
import type { StartupTransactionRunner } from './startup-transaction.ts'
import type { RuntimeModuleContext } from './context.ts'

export interface RuntimeRecoveryActionsDeps extends RuntimeModuleContext {
  dshHome: string
  shellVersion: string
  assertMutationIdle(): void
  assertNoOrdinaryPending(): void
  getStartupBlockReason(): string | null
  startup: StartupTransactionRunner
  hooks: {
    invalidateDiskCache(): void
    setStartupBlockReason(value: string | null): void
    setOperationError(value: string | null): void
    setRestartOutcome(value: 'ok' | 'failed' | 'running' | null): void
  }
}

export interface RuntimeRecoveryActions {
  metadataRecoveryPending(): boolean | 'unknown'
  recoverMetadata(): Promise<{ accepted: true }>
  restorePreRollbackStash(stashName: string): Promise<{ accepted: true }>
  retryApply(): Promise<{ accepted: boolean; blockedReason: string | null }>
  retryRestore(): Promise<{ accepted: boolean; blockedReason: string | null }>
}

export function createRuntimeRecoveryActions(deps: RuntimeRecoveryActionsDeps): RuntimeRecoveryActions {
  const {
    plane,
    platform,
    baseDir,
    dshHome,
    shellVersion,
    envPath,
    facts,
    writeFence,
    assertMutationIdle,
    assertNoOrdinaryPending,
    getStartupBlockReason,
    startup,
  } = deps
  const { invalidateDiskCache, setStartupBlockReason, setOperationError, setRestartOutcome } = deps.hooks

  /** True while a durable metadata-recovery transaction is
   *  pending (engine record mid-flight) or the recovery marker is corrupt.
   *  The boot path consults this BEFORE starting the managed dsh — an
   *  archived/metadata-cleared state must never serve DSH_HOME through the
   *  builtin anchor without the probe gate.
   *
   *  The predicate is the shared `projectMetadataRecoveryGate().startupMustBlock`
   *  (2026-12 single-sourcing): its `needsRecovery` sibling carries the DIFFERENT
   *  rule the recover-metadata eligibility uses (selection-corrupt and the
   *  marker-rescue conjunction), so the boot gate must not reuse it.
   *  2026-12 review (3.1): the answer is tri-state — a metadata READ failure is
   *  'unknown', never false. The boot path is fail-closed on it (starting the
   *  managed dsh on an unreadable state directory is exactly the fail-open this
   *  gate prevents, and the recover-metadata escape would fail on the same read). */
  function metadataRecoveryPending(): boolean | 'unknown' {
    if (platform === 'win32') return false
    try {
      const health = detectRuntimeMetadataHealth(baseDir, shellVersion)
      const markerRescueAvailable = health.status === 'recovery-marker-corrupt'
        && inspectCorruptMetadataRecoveryMarker(baseDir).recoverable
      if (projectMetadataRecoveryGate(health, { markerRescueAvailable }).startupMustBlock) return true
      // B2 acceptance residual (a): the shared startup transaction refuses to
      // resolve a runtime when the known-good ledger is corrupt/unreadable
      // (workspace-facts.ts activationFacts -> knownGoodMetadataRefusal). Without
      // this preflight the throw would tear the whole gateway down and leave no
      // recovery route; answering 'unknown' keeps the gateway up with the managed
      // dsh stopped and the operator told to fix the state directory.
      if (listKnownGoodVersionsState(baseDir).kind !== 'ok') return 'unknown'
      return false
    } catch {
      return 'unknown'
    }
  }

  /** Metadata FATAL rescue (desktop parity, main.ts executeMetadataRecovery
   *  mirror): archives corrupt selection metadata byte-for-byte while keeping a
   *  full DSH_HOME copy, runs the builtin anchor through the full read-only
   *  probe gate, and only then finalizes access. The shared engine owns the
   *  crash-safe transaction (stash/evidence/probe-required checkpoints). */
  async function recoverMetadata(): Promise<{ accepted: true }> {
    refuseRuntimeMutationOnWindows(platform)
    assertMutationIdle()
    refuseOnEnvPinned(envPath, 'metadata recovery')
    const builtin = facts.requireBuiltinVersion()
    if (builtin === null || !isSafeVersion(builtin)) {
      throw Object.assign(new Error('gateway builtin dsh anchor does not expose a stable version; metadata recovery refused'), { code: 'invalid_target' })
    }
    const blockReason = getStartupBlockReason()
    if (blockReason !== null && !RECOVERABLE_METADATA_BLOCKS.has(blockReason)) {
      throw Object.assign(new Error(`runtime recovery ${blockReason} is required first; only the matching retry applies`), { code: 'runtime_recovery_required' })
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
    if (getStartupBlockReason() === 'metadata-start-failed') {
      // The metadata is healthy behind a failed resume start —
      // recover simply retries the plain start of the builtin anchor.
      if (!writeFence.isDisposed()) {
        await plane.startLocal()
        plane.refreshLocalExposure()
      }
      setStartupBlockReason(null)
      setOperationError(null)
      return { accepted: true }
    }
    if (!needsRecovery) {
      throw Object.assign(new Error('no corrupt metadata to recover'), { code: 'no_retry_target' })
    }
    const hostDomainNames = syncedHostDomainProbeNames(baseDir)
    const engineOptions = {
      baseDir,
      dshHome,
      builtinVersion: builtin,
      shellVersion,
      stopHost: () => plane.stopLocal(),
      completeRestore: () => completeInterruptedRestore(baseDir, dshHome),
      probeBuiltin: async () => {
        const probes = await startup.spawnAndProbeCandidate(builtin, true, hostDomainNames, writeFence.abortSignal)
        const passed = probes.length > 0 && probes.every(probe => probe.ok)
        if (passed) return { ok: true as const }
        const failures = probes.filter(probe => !probe.ok).map(probe => probe.name ?? 'unknown probe').join(', ')
        return { ok: false as const, error: failures === '' ? 'no probe results' : `builtin activation probes failed: ${failures}` }
      },
    }
    let result:
      | Awaited<ReturnType<typeof recoverRuntimeMetadata>>
      | Awaited<ReturnType<typeof rescueCorruptMetadataRecoveryMarker>>
    writeFence.beginActivation()
    try {
      await plane.stopLocal()
      // engine requires failure-free? no: engine handles
      result = health.status === 'recovery-marker-corrupt'
        ? await rescueCorruptMetadataRecoveryMarker(engineOptions)
        : await recoverRuntimeMetadata(engineOptions)
    } catch (error) {
      setOperationError(sanitizeRouteError(error instanceof Error ? error.message : String(error)))
      // Engine invariants throw without a code: keep the failure loud but
      // mapped (409), never a bare 500 — the corrupt state remains readable
      // and the route stays retryable.
      const code = (error as { code?: unknown }).code
      if (typeof code !== 'string') {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'runtime_activation_failed' })
      }
      throw error
    } finally {
      writeFence.endActivation()
      invalidateDiskCache()
    }
    if (result.status === 'finalized') {
      setOperationError(null)
      setRestartOutcome(null)
      if (!writeFence.isDisposed()) {
        try {
          await plane.startLocal()
          plane.refreshLocalExposure()
        } catch (error) {
          // A failed resume start must stay recoverable — the
          // metadata is healthy now, so keep a dedicated sentinel the recover
          // route resolves by retrying the plain start.
          setStartupBlockReason('metadata-start-failed')
          const resumeError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
          setOperationError(resumeError)
          throw Object.assign(
            new Error(`metadata recovery finalized but the managed dsh failed to start: ${resumeError}`),
            { code: 'runtime_activation_failed' },
          )
        }
      }
      setStartupBlockReason(null)
      return { accepted: true }
    }
    if (result.status === 'restore-blocked') {
      // Engine outcome name clash: this is a metadata-recovery transaction
      // blocked on an interrupted SNAPSHOT restore — retry-restore resumes it.
      setStartupBlockReason(result.restoreOutcome === 'half' ? 'restore-half' : 'restore-incomplete')
      setOperationError(result.error)
      return { accepted: true }
    }
    // probe-failed (or unexpected status): keep the durable record and the
    // managed dsh stopped; the recover route stays eligible to resume.
    setStartupBlockReason('metadata-probe-failed')
    setOperationError(sanitizeRouteError(result.error || 'metadata recovery probe failed'))
    return { accepted: true }
  }

  /** Restore the newest pre-rollback stash over DSH_HOME (desktop parity,
   *  main.ts RUNTIME_RESTORE_PRE_ROLLBACK): stash-name whitelist →
   *  stop the managed dsh → shared crash-safe restorePreRollback →
   *  resume/blocked projection. env stays allowed (data recovery is
   *  source-independent, design 18 §3.6); win32 read-only refuses. */
  async function restorePreRollbackStash(stashName: string): Promise<{ accepted: true }> {
    refuseRuntimeMutationOnWindows(platform)
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
    writeFence.beginActivation()
    try {
      await plane.stopLocal()
      try {
        outcome = await restorePreRollback(baseDir, dshHome, stashName)
      } catch (error) {
        restoreError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      writeFence.endActivation()
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
          setStartupBlockReason(null)
          setOperationError(null)
        }
        return { accepted: true }
      }
      case 'half':
        // Desktop parity: the restore left a durable marker — keep the
        // managed dsh down and project restore-blocked so retry-restore
        // resumes the journaled transaction.
        setStartupBlockReason('restore-half')
        setOperationError(null)
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

  /** Shared tail of retry-apply / retry-restore: re-run the startup
   * transaction and, on a clean verdict, bring the managed dsh up — the same
   * pairing the gateway start() path performs after the first transaction.
   * NOTE: if the transaction is clean but startLocal() then throws, the
   * retry target marker was already cleared pre-transaction, so the same
   * retry route answers 409 no_retry_target — recovery is a gateway restart;
   * the state stays honest (operationError set, connectionState not ready). */
  async function resumeAfterBlockedStartup(): Promise<{ blockedReason: string | null }> {
    const result = await startup.startupTransaction()
    if (!writeFence.isDisposed() && result.blockedReason === null) {
      try {
        await plane.startLocal()
        plane.refreshLocalExposure()
      } catch (error) {
        setOperationError(sanitizeRouteError(error instanceof Error ? error.message : String(error)))
        throw error
      }
    }
    return result
  }

  async function retryApply(): Promise<{ accepted: boolean; blockedReason: string | null }> {
    refuseRuntimeMutationOnWindows(platform)
    assertMutationIdle()
    refuseOnEnvPinned(envPath, 'version mutations')
    assertNoOrdinaryPending()
    const record = readOverrideForDecision(baseDir)
    const interrupted = record !== null && (record.swapAttempted === true || record.lastOutcome === 'snapshot-failed')
    if (!interrupted) {
      throw Object.assign(new Error('no interrupted apply to retry (swap-attempted or snapshot-failed)'), { code: 'no_retry_target' })
    }
    // Mirror the desktop retry-apply (design 18 §3.6): clear the interrupted-
    // switch markers, then re-run the startup transaction so the pending switch
    // proceeds (snapshot → pointer switch → spawn → probe gate). snapshot-failed
    // is included: the gateway must have a NON-destructive recovery
    // from a snapshot failure, exactly like the desktop's canRetryApply.
    writeOverride(baseDir, { ...record!, swapAttempted: false, lastOutcome: null, lastError: null })
    const result = await resumeAfterBlockedStartup()
    if (result.blockedReason === null) setOperationError(null)
    return { accepted: true, blockedReason: result.blockedReason }
  }

  async function retryRestore(): Promise<{ accepted: boolean; blockedReason: string | null }> {
    refuseRuntimeMutationOnWindows(platform)
    assertMutationIdle()
    // Interrupted data-restore continuation is source-independent — the desktop
    // never refuses env here, so neither does the gateway (retry-apply stays
    // env-refused: it resumes a VERSION switch).
    assertNoOrdinaryPending()
    const blockReason = getStartupBlockReason()
    if (blockReason === null || !RETRY_RESTORE_REASONS.has(blockReason)) {
      throw Object.assign(new Error('no interrupted restore to retry'), { code: 'no_retry_target' })
    }
    // The startup transaction itself performs the restore completion (its
    // completeInterruptedRestore dep); re-running it continues the durable
    // journal instead of starting a fresh snapshot.
    return { accepted: true, blockedReason: (await resumeAfterBlockedStartup()).blockedReason }
  }  return { metadataRecoveryPending, recoverMetadata, restorePreRollbackStash, retryApply, retryRestore }
}
