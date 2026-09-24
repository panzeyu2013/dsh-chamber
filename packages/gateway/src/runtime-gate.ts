/**
 * Runtime gate decision single source: the pure formulas both /chamber/runtime
 * defense layers share, plus the in-flight writer matrix shared by the manager's
 * throw and return versions.
 *
 * {@link recoveryGateRefusal} is the route pre-gate decision chain (phase →
 * recovery block → pending terminal gate) over the projected /status;
 * {@link writerBusyRefusal} is the in-flight writer matrix for the manager's
 * mutation and managed-profile-write surfaces. Refusal TEXTS stay in
 * runtime-refusals.ts — this module only decides which refusal a (state × operation)
 * cell answers, and its deliberately preserved per-surface differences are NOT collapsed
 * here.
 */
import {
  RECOVERABLE_METADATA_BLOCKS,
  RETRY_APPLY_REASONS,
  RETRY_RESTORE_REASONS,
  pendingOnlyRefusal,
  profileWriteBusyRefusal,
  type RuntimeRefusal,
  type RuntimeRefusalCode,
} from './runtime-refusals.ts'

/** The runtime mutation actions the route pre-gates answer for. */
export type RuntimeMutationAction =
  | 'select'
  | 'apply'
  | 'apply-now'
  | 'rollback'
  | 'cleanup-version'
  | 'restore-pre-rollback'
  | 'recover-metadata'
  | 'retry-apply'
  | 'retry-restore'
  | 'restore-builtin'
  | 'restart'
  | 'start'
  | 'registry'

/** The projected /status subset the route gate classifies. */
export interface RuntimeGateStatus {
  phase?: unknown
  pending?: unknown
  startupBlockedReason?: unknown
  canRecoverMetadata?: unknown
}

/**
 * Route pre-gate decision: null = the action may proceed to the manager; a
 * refusal is answered 409 with its wire code.
 *
 * A retry-apply / retry-restore phase opens only its own retry action; a
 * projected startup block closes every ordinary mutation and opens exactly the
 * recovery route the status advertises, returning BEFORE the pending terminal
 * gate (a block outranks a lingering pending); env-probe-failed has no route;
 * with no block armed, the pending gate refuses all but restore-builtin and
 * apply-now.
 */
export function recoveryGateRefusal(
  status: RuntimeGateStatus,
  action: RuntimeMutationAction,
): RuntimeRefusal<'runtime_pending' | 'runtime_recovery_required'> | null {
  const phase = typeof status.phase === 'string' ? status.phase : 'unknown'
  const retryAction = RETRY_APPLY_REASONS.has(phase)
    ? 'retry-apply'
    : phase === 'restore-blocked'
      ? 'retry-restore'
      : null

  if (retryAction !== null) {
    if (action === retryAction) return null
    return {
      error: `runtime recovery ${phase} is required; only ${retryAction} is allowed`,
      code: 'runtime_recovery_required',
    }
  }

  // Any projected startup block closes every ordinary mutation: only the exact
  // recovery surface stays open (retry routes keep their gates above).
  const blockedReason = typeof status.startupBlockedReason === 'string'
    && status.startupBlockedReason !== ''
    ? status.startupBlockedReason
    : null
  // Authoritative recoverability: derived from durable metadata health, not the blocked reason above.
  const canRecoverMetadata = status.canRecoverMetadata === true
  if (blockedReason !== null) {
    // Recovery-name classification single source: the same constants the
    // manager's pending suppression and block-outranks-pending projection use.
    const swapLike = RETRY_APPLY_REASONS.has(blockedReason)
    const restoreLike = RETRY_RESTORE_REASONS.has(blockedReason)
    const fatalLike = RECOVERABLE_METADATA_BLOCKS.has(blockedReason)
    // An UNRECOGNIZED blockedReason (free-text mid-run drift) must not lock out
    // the recovery route the projection advertises: recover-metadata opens
    // whenever canRecoverMetadata; everything else stays closed.
    const recoverOpen = fatalLike
      || (canRecoverMetadata && !swapLike && !restoreLike && blockedReason !== 'env-probe-failed')
    const allowed = (action === 'retry-apply' && swapLike)
      || (action === 'retry-restore' && restoreLike)
      || (action === 'recover-metadata' && recoverOpen)
    if (allowed) {
      // An allowed recovery action returns HERE: a startup block OUTRANKS a
      // lingering pending, and falling through would lock the recovery surface
      // behind a block only the recovery route can clear (blockOutranksPending
      // only re-labels the projected phase; the gate must honor it).
      return null
    }
    // env-probe-failed has NO matching recovery route (externally pinned runtime), so do not promise one.
    if (blockedReason === 'env-probe-failed') {
      return {
        error: 'runtime startup block env-probe-failed: the DSH_GATEWAY_DSH_PATH runtime failed activation probes; fix the target and restart the gateway (no recovery route applies)',
        code: 'runtime_recovery_required',
      }
    }
    return {
      error: canRecoverMetadata
        ? `runtime startup block ${blockedReason} requires recovery first; only recover-metadata is allowed`
        : `runtime startup block ${blockedReason} requires recovery first; no recovery route matches (restart the gateway if this persists)`,
      code: 'runtime_recovery_required',
    }
  }

  // Same mid-run drift, no projected block text: FATAL metadata corruption
  // beneath an armed pending must not hide recover-metadata behind the pending
  // gate (restore-builtin is refused by the durable guard for corrupt metadata).
  if (action === 'recover-metadata' && canRecoverMetadata) return null

  // The ordinary-pending gate applies only when NO startup block is armed; a stale pending must not relabel refusals.
  if (blockedReason === null
    && ((status.pending !== null && status.pending !== undefined) || phase === 'pending')) {
    if (action === 'restore-builtin') return null
    // apply-now's premise is exactly this pending/selection state — the
    // in-session execution of the armed switch; recovery phases above refuse it.
    if (action === 'apply-now') return null
    const version = typeof status.pending === 'string' && status.pending !== ''
      ? status.pending
      : 'unknown'
    // Same code/message the manager's pending guards emit (single source: pendingOnlyRefusal).
    return pendingOnlyRefusal(version)
  }

  return null
}

/** The manager's in-flight writer flags (one row per writer fence). */
export interface RuntimeWriterFlags {
  disposed: boolean
  activation: boolean
  install: boolean
  restart: boolean
  applyNow: boolean
  restartExhaustedRollback: boolean
  start: boolean
  /** Only consulted for the 'runtime mutations' subject: the profile-write
   * surface IS the lease and must stay reentrant (nested acquisition allowed). */
  profileWrite: boolean
}

/** A refusal plus its code; 'runtime_disposed' is the manager's direct-call
 * disposal code (never routed). */
export type WriterBusyRefusal<C extends string = RuntimeRefusalCode | 'runtime_disposed'> = { error: string; code: C }

/**
 * The in-flight writer matrix both manager surfaces share, in this order:
 * disposal → activation → install → restart → apply-now → restart-exhausted
 * rollback → start → profile-write lease. The first two rows use the mutation
 * surface's suffix-less text; every other row appends the surface's refusal tail,
 * and the profile-write surface never consults the profileWrite flag.
 */
export function writerBusyRefusal(flags: RuntimeWriterFlags, subject: 'runtime mutations'): WriterBusyRefusal | null
export function writerBusyRefusal(flags: RuntimeWriterFlags, subject: 'managed profile write'): RuntimeRefusal<'runtime_busy'> | null
export function writerBusyRefusal(flags: RuntimeWriterFlags, subject: 'runtime mutations' | 'managed profile write'): WriterBusyRefusal | null {
  const mutationSurface = subject === 'runtime mutations'
  // The refused-operation tail: the mutation surface uses the plural wording.
  const tail = mutationSurface ? 'runtime mutations are refused' : 'managed profile write refused'
  if (flags.disposed) {
    return mutationSurface
      ? { code: 'runtime_disposed', error: 'gateway runtime manager is disposing' }
      : { code: 'runtime_busy', error: `gateway runtime manager is disposing; ${tail}` }
  }
  if (flags.activation) {
    return mutationSurface
      ? { code: 'runtime_busy', error: 'runtime activation in progress' }
      : { code: 'runtime_busy', error: `runtime activation in progress; ${tail}` }
  }
  if (flags.install) return { code: 'runtime_busy', error: `a runtime install is in flight; ${tail}` }
  if (flags.restart) return { code: 'runtime_busy', error: `a restart is in flight; ${tail}` }
  if (flags.applyNow) return { code: 'runtime_busy', error: `an apply-now transaction is in flight; ${tail}` }
  if (flags.restartExhaustedRollback) {
    return { code: 'runtime_busy', error: `an automatic restart-exhausted rollback is in flight; ${tail}` }
  }
  if (flags.start) return { code: 'runtime_busy', error: `a start is in flight; ${tail}` }
  if (mutationSurface && flags.profileWrite) return profileWriteBusyRefusal('runtime mutations')
  return null
}
