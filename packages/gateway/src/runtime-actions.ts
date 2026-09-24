/** Gateway runtime action guards: the mutation fences (pending /
 * ordinary-pending / in-flight writer / profile-write lease) every transaction
 * body consults; mutable state arrives as getters, so refusals observe live state. */
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
  /** ONE authority read per guard call: both projections consume the SAME
   *  OverrideRecord, so a durable change cannot reach only one of them; null
   *  means no pending in force. */
  function readPendingSelection(): { pending: string; record: OverrideRecord } | null {
    if (deps.getEnvPath() !== null || platform === 'win32') return null
    const state = readOverrideState(baseDir)
    if (state.kind === 'corrupt' || state.kind === 'unknown') {
      // Coded refusal: runtime_recovery_required maps to 409 (a bare Error would be 500).
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
    // Explicit recovery phases, not the normal installed/pending state: only
    // the interrupted-apply/restore reasons carve the pending out here — a
    // FATAL metadata block does NOT (startupBlockReasonOutranksPending is wider).
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
      // Same code/message as the route recovery gate and profileWriteRefusal.
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
    // Shared in-flight writer matrix; its profileWrite row is the plugin-write
    // fence: every runtime writer is a DSH_HOME/profile writer too.
    const refusal = writerBusyRefusal(writerFlags(), 'runtime mutations')
    if (refusal !== null) throw codedError(refusal.code, refusal.error)
  }

  /** The synchronous refusal matrix beginProfileWrite() answers with, ordered
   *  in-flight writers → recovery/pending → live window, matching the route
   *  table; corrupt selection metadata is a hard recovery condition. */
  function profileWriteRefusal(): { code: ProfileWriteRefusalCode; error: string } | null {
    const startupBlockReason = deps.getStartupBlockReason()
    // Shared in-flight writer matrix. The rollback latch is armed SYNCHRONOUSLY
    // before its async body drains/waits, so its row covers the whole rollback
    // window. This surface IS the lease, so its own flag is deliberately absent.
    const busy = writerBusyRefusal(writerFlags(), 'managed profile write')
    if (busy !== null) return busy
    // Recovery states expose only their matching retry; restore-builtin is for
    // pending/healthy selections only, so a plugin write must not slip past it.
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
      // Same code/message as assertNoPending/assertNoOrdinaryPending.
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
