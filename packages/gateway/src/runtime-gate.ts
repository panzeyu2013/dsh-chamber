/**
 * Runtime gate decision single source (2026-12 audit F3): the pure formulas
 * both /chamber/runtime defense layers share, plus the in-flight writer matrix
 * the manager used to carry twice (throw version + return version).
 *
 *  - {@link recoveryGateRefusal}: the route pre-gate decision chain (phase →
 *    recovery block → pending terminal gate) over the projected /status. Moved
 *    verbatim out of runtime-routes.ts so the matrix is unit-testable; the
 *    engine of the chain (R2/R3/R4/H2/A-U2 semantics) is unchanged.
 *  - {@link writerBusyRefusal}: the in-flight writer matrix for the manager's
 *    two surfaces — mutation (assertMutationIdle) and managed profile write
 *    (profileWriteRefusal). Every message reproduces the pre-refactor inline
 *    bytes for its surface.
 *
 * Refusal TEXTS stay in runtime-refusals.ts (audit N2 single source); this
 * module only decides which refusal a (state × operation) cell answers.
 * Deliberately preserved differences are documented in runtime-refusals.ts
 * (platform read-only wording, blocked-startup wording, pending-suppression
 * scope) and are NOT collapsed here.
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
 * Route pre-gate decision (2026-12 audit F3): null means the action may
 * proceed to the manager; a refusal is answered 409 with its wire code.
 *
 * The chain preserves the historical semantics exactly: a retry-apply /
 * retry-restore phase only opens its own retry action; any projected startup
 * block closes every ordinary mutation and opens exactly the recovery route the
 * status advertises (recover-metadata whenever canRecoverMetadata, for
 * canonical FATAL sentinels and drifted free-text reasons alike); an allowed
 * recovery action returns BEFORE the pending terminal gate (a block outranks a
 * lingering pending — R3/H2); env-probe-failed says no route applies (A-U2);
 * with no block armed, the pending terminal gate refuses everything except its
 * two escapes (restore-builtin, apply-now).
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

  // 2026-12 (M1 review fix): any projected startup block (FATAL metadata or
  // a swap/restore recovery phase projected through startupBlockedReason)
  // closes every ordinary mutation — desktop parity: only the exact recovery
  // surface stays open. Retry routes keep their phase-driven gates above.
  const blockedReason = typeof status.startupBlockedReason === 'string'
    && status.startupBlockedReason !== ''
    ? status.startupBlockedReason
    : null
  // Authoritative recoverability: the status projection derives this from
  // the durable metadata health, not from the (possibly free-text) blocked
  // reason above (R4 mid-run drift classification).
  const canRecoverMetadata = status.canRecoverMetadata === true
  if (blockedReason !== null) {
    // Recovery-name classification single source (audit N2): the reason-token
    // sets are the same constants the manager's pending suppression and
    // status() block-outranks-pending projection classify with.
    const swapLike = RETRY_APPLY_REASONS.has(blockedReason)
    const restoreLike = RETRY_RESTORE_REASONS.has(blockedReason)
    const fatalLike = RECOVERABLE_METADATA_BLOCKS.has(blockedReason)
    // An UNRECOGNIZED blockedReason (free-text resolution error from
    // mid-run metadata drift) must not lock out the very recovery route the
    // projection advertises — recover-metadata opens whenever the status
    // reports canRecoverMetadata, for canonical FATAL sentinels and for
    // drifted free-text reasons alike. Everything else stays closed.
    const recoverOpen = fatalLike
      || (canRecoverMetadata && !swapLike && !restoreLike && blockedReason !== 'env-probe-failed')
    const allowed = (action === 'retry-apply' && swapLike)
      || (action === 'retry-restore' && restoreLike)
      || (action === 'recover-metadata' && recoverOpen)
    if (allowed) {
      // 2026 audit R3 (FATAL + stale pending deadlock): an allowed recovery
      // action returns HERE — a startup block OUTRANKS a lingering pending
      // value. Falling through to the pending terminal gate below would
      // refuse recover-metadata with runtime_pending while restore-builtin
      // (pending's own escape) is simultaneously refused by this block
      // branch — the recovery surface would be fully locked behind a block
      // that only the recovery route can clear (H2: blockOutranksPending
      // only re-labels the projected phase; the gate itself must honor it).
      return null
    }
    // env-probe-failed has NO matching recovery route (the runtime is
    // externally pinned) — say so instead of promising a route that does
    // not exist (A-U2 review): the operator must fix the
    // DSH_GATEWAY_DSH_PATH target and restart the gateway.
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

  // Same mid-run drift with no projected block text: FATAL metadata
  // corruption beneath an armed pending must not hide recover-metadata
  // behind the pending terminal gate (the pending escape restore-builtin is
  // refused by the manager's durable guard for corrupt metadata —
  // recover-metadata is the actual recovery surface; R4).
  if (action === 'recover-metadata' && canRecoverMetadata) return null

  // The ordinary-pending terminal gate applies only when NO startup block is
  // armed — a blocked startup projects its own recovery surface above and a
  // stale pending must not relabel refusals (H2/2026 audit R3).
  if (blockedReason === null
    && ((status.pending !== null && status.pending !== undefined) || phase === 'pending')) {
    if (action === 'restore-builtin') return null
    // apply-now's semantic premise is exactly this pending/selection state —
    // it is the in-session execution of the armed switch, not a competing
    // mutation (design 18 addendum §5.1). Recovery phases above still refuse it.
    if (action === 'apply-now') return null
    const version = typeof status.pending === 'string' && status.pending !== ''
      ? status.pending
      : 'unknown'
    // Same code/message the manager's assertNoPending/assertNoOrdinaryPending
    // and profileWriteRefusal emit (audit N2 single source: pendingOnlyRefusal).
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
   * surface IS the lease and must stay reentrant (a nested acquire is not
   * refused), matching the pre-refactor profileWriteRefusal. */
  profileWrite: boolean
}

/** A refusal plus its code; 'runtime_disposed' is the manager's direct-call
 * disposal code (never routed). */
export type WriterBusyRefusal<C extends string = RuntimeRefusalCode | 'runtime_disposed'> = { error: string; code: C }

/**
 * The in-flight writer matrix both manager surfaces share, in the historical
 * order: disposal → activation → install → restart → apply-now →
 * restart-exhausted rollback → start → profile-write lease.
 *
 * The first two rows keep the mutation surface's suffix-less historical text
 * ('gateway runtime manager is disposing' / 'runtime activation in progress');
 * every other row appends the surface's refusal tail. The profile-write
 * surface never consults the profileWrite flag (see RuntimeWriterFlags).
 */
export function writerBusyRefusal(flags: RuntimeWriterFlags, subject: 'runtime mutations'): WriterBusyRefusal | null
export function writerBusyRefusal(flags: RuntimeWriterFlags, subject: 'managed profile write'): RuntimeRefusal<'runtime_busy'> | null
export function writerBusyRefusal(flags: RuntimeWriterFlags, subject: 'runtime mutations' | 'managed profile write'): WriterBusyRefusal | null {
  const mutationSurface = subject === 'runtime mutations'
  // The refused-operation tail (verb included): the mutation surface keeps its
  // historical "runtime mutations are refused" plural.
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
