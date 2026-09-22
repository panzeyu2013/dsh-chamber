/**
 * Gateway runtime action guards (2026-12 audit F2 split): the mutation fences
 * (pending / ordinary-pending / in-flight writer / profile-write lease) that
 * every transaction body consults, moved out of runtime-manager.ts. All mutable
 * manager state is injected as getters, so each refusal still observes the live
 * writer/lifecycle state at call time (F3 parity semantics unchanged).
 */
import { readOverrideState, shouldInvalidate } from '@dsh-chamber/dsh-runtime'
import type { OverrideRecord } from '@dsh-chamber/dsh-runtime'
import {
  pendingOnlyRefusal,
  recoveryRetryRequiredRefusal,
  refusalError,
  RETRY_APPLY_REASONS,
  RETRY_RESTORE_REASONS,
} from './runtime-refusals.ts'
import { writerBusyRefusal, type RuntimeWriterFlags } from './runtime-gate.ts'
import { codedError } from './http-utils.ts'
import { sanitizeRouteError } from './sanitize-route-error.ts'

export type ProfileWriteRefusalCode = 'runtime_busy' | 'runtime_pending' | 'runtime_recovery_required'

export interface RuntimeActionGuardDeps {
  platform: NodeJS.Platform
  baseDir: string
  shellVersion: string
  getEnvPath(): string | null
  getStartupBlockReason(): string | null
  isDisposed(): boolean
  isActivationInProgress(): boolean
  isInstallInFlight(): boolean
  isRestartInFlight(): boolean
  isApplyNowInFlight(): boolean
  isRestartExhaustedRollbackInFlight(): boolean
  isStartInFlight(): boolean
  isProfileWriteInFlight(): boolean
  getConnectionState(): string
}

export interface RuntimeActionGuards {
  persistedPendingVersion(): string | null
  ordinaryPendingVersion(): string | null
  assertNoOrdinaryPending(): void
  assertNoPending(): void
  assertMutationIdle(): void
  profileWriteRefusal(): { code: ProfileWriteRefusalCode; error: string } | null
}

export function createRuntimeActionGuards(deps: RuntimeActionGuardDeps): RuntimeActionGuards {
  const { platform, baseDir, shellVersion } = deps
  /**
   * ONE authority read per guard call: both the pending projection and the
   * recovery-phase classification below consume the SAME OverrideRecord. The
   * former two-read shape (persistedPendingVersion then a second
   * readOverrideState in ordinaryPendingVersion) let the durable override
   * change between the two reads — a TOCTOU window in which a swapAttempted/
   * lastOutcome transition could be observed by only one of them (B2 residual
   * (b)). Returns null when there is no pending in force; a corrupt/unreadable
   * leaf still throws the coded refusal.
   */
  function readPendingSelection(): { pending: string; record: OverrideRecord } | null {
    if (deps.getEnvPath() !== null || platform === 'win32') return null
    const state = readOverrideState(baseDir)
    if (state.kind === 'corrupt' || state.kind === 'unknown') {
      // Coded refusal (B2 acceptance residual b): the route layer maps
      // runtime_recovery_required to 409; a bare Error would surface as a 500.
      throw Object.assign(
        new Error(state.kind === 'corrupt'
          ? 'gateway runtime override metadata is corrupt'
          : 'gateway runtime override metadata is unreadable: ' + state.detail),
        { code: 'runtime_recovery_required' as const },
      )
    }
    if (state.kind !== 'valid' || shouldInvalidate(state.record, shellVersion) || state.record.pending === null) return null
    return { pending: state.record.pending, record: state.record }
  }

  function persistedPendingVersion(): string | null {
    const selection = readPendingSelection()
    return selection === null ? null : selection.pending
  }

  function ordinaryPendingVersion(): string | null {
    const startupBlockReason = deps.getStartupBlockReason()
    const selection = readPendingSelection()
    if (selection === null) return null
    const { record, pending } = selection
    // These are explicit recovery phases with their own Design 18 actions,
    // not the normal installed/pending terminal state. The recovery-name
    // classification is the route layer's canonical set (audit N2:
    // RETRY_APPLY_REASONS / RETRY_RESTORE_REASONS from runtime-refusals.ts).
    // NOTE: only the interrupted-apply/restore reasons carve the pending out
    // here — a FATAL metadata block does NOT (that suppression lives in
    // status()'s startupBlockReasonOutranksPending, a deliberately wider
    // predicate — see runtime-refusals.ts).
    if (record.swapAttempted === true || record.lastOutcome === 'snapshot-failed'
      || (startupBlockReason !== null
        && (RETRY_APPLY_REASONS.has(startupBlockReason) || RETRY_RESTORE_REASONS.has(startupBlockReason)))) {
      return null
    }
    return pending
  }

  function assertNoOrdinaryPending(): void {
    const pending = ordinaryPendingVersion()
    if (pending !== null) {
      // Same code/message as the route recovery gate and profileWriteRefusal
      // (audit N2: pendingOnlyRefusal).
      throw refusalError(pendingOnlyRefusal(pending))
    }
  }

  function assertNoPending(): void {
    const pending = persistedPendingVersion()
    if (pending !== null) {
      throw refusalError(pendingOnlyRefusal(pending))
    }
  }

  /** One row per writer fence for the shared in-flight matrix (runtime-gate). */
  function writerFlags(): RuntimeWriterFlags {
    return {
      disposed: deps.isDisposed(),
      activation: deps.isActivationInProgress(),
      install: deps.isInstallInFlight(),
      restart: deps.isRestartInFlight(),
      applyNow: deps.isApplyNowInFlight(),
      restartExhaustedRollback: deps.isRestartExhaustedRollbackInFlight(),
      start: deps.isStartInFlight(),
      profileWrite: deps.isProfileWriteInFlight(),
    }
  }

  function assertMutationIdle(): void {
    // Shared in-flight writer matrix (2026-12 audit F3). Its last row is the
    // design 21 §6.3 profile-write fence: a plugin add/remove pnpm child must
    // never interleave a runtime transaction (every runtime writer is a
    // DSH_HOME/profile writer too).
    const refusal = writerBusyRefusal(writerFlags(), 'runtime mutations')
    if (refusal !== null) throw codedError(refusal.code, refusal.error)
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
    const startupBlockReason = deps.getStartupBlockReason()
    // Shared in-flight writer matrix (runtime-gate.ts), historical order. The
    // F7 rollback latch is armed SYNCHRONOUSLY before its async body drains/
    // waits, so its row covers the whole rollback window (including the
    // lease-drain wait): no new lease can start mid-rollback. This surface is
    // the lease itself, so the profile-write flag is deliberately not part of
    // its matrix (a nested acquire stays allowed).
    const busy = writerBusyRefusal(writerFlags(), 'managed profile write')
    if (busy !== null) return busy
    // Recovery states expose only their matching retry (recover-metadata for
    // FATAL); restore-builtin applies to pending/healthy selections only — a
    // plugin write is not on that surface and must not slip past it. Same
    // code/message as start()/applyNowPreflight/restoreBuiltin (audit N2:
    // recoveryRetryRequiredRefusal).
    if (startupBlockReason !== null) {
      return recoveryRetryRequiredRefusal(startupBlockReason)
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
      // Same code/message as assertNoPending/assertNoOrdinaryPending and the
      // route pending gate (audit N2: pendingOnlyRefusal).
      return pendingOnlyRefusal(pending)
    }
    const connectionState = deps.getConnectionState()
    if (connectionState === 'starting' || connectionState === 'restarting') {
      return { code: 'runtime_busy', error: `managed dsh is ${connectionState}; managed profile write refused until it settles` }
    }
    return null
  }
  return {
    persistedPendingVersion,
    ordinaryPendingVersion,
    assertNoOrdinaryPending,
    assertNoPending,
    assertMutationIdle,
    profileWriteRefusal,
  }
}
