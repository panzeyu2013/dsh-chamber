/**
 * Runtime refusal / recovery-gate single sources (audit N2, 2026-09 P3): the
 * `/chamber/runtime` surface is two defense layers — the route pre-gates in
 * runtime-routes.ts (answering 409/403 synchronously from the projected
 * /status) and the manager's own refusals in runtime-manager.ts (assertMutationIdle
 * and the per-action guards, authoritative for DIRECT manager calls). Both
 * layers answer the same operation × state matrix cells and used to carry two
 * byte-identical copies of the same refusal text/code. This module is the
 * single home for:
 *
 *  - every refusal TEXT that is shared by two or more sites across the two
 *    files (each builder documents its exact use sites), and
 *  - the canonical recovery-state name sets and the block-outranks-pending
 *    predicate both layers classify with.
 *
 * Both layers keep executing (defense in depth is the point — the route gate
 * still runs BEFORE the manager call); only the refusal construction and the
 * classification formulas come from here. Wire behavior at every cell is
 * unchanged: builders reproduce the pre-refactor text byte for byte, codes and
 * the {error, code} serialization order are unchanged, and every decision
 * formula that differs between the layers (see "Preserved intentional
 * differences") is deliberately NOT unified.
 *
 * Preserved intentional differences (each documented at its site too):
 *  - platform read-only texts: the route answers `runtime mutations are
 *    read-only on this platform` while the manager throws `windows runtime
 *    mutations are read-only` — two wordings of the same 403 platform_read_only
 *    cell, both pinned by the suites; no builder unifies them.
 *  - blocked-startup wording: the ROUTE gate answers `runtime startup block
 *    <reason> requires recovery first; …` (it knows which recovery route is
 *    open, incl. the canRecoverMetadata drift classification), while the
 *    MANAGER surfaces answer `runtime recovery <reason> is required; resume via
 *    the matching retry route (restore-builtin applies to pending or healthy
 *    selections only)` — the manager's wording is shared across its own four
 *    sites via recoveryRetryRequiredRefusal below and is NOT the route's text.
 *  - cleanup-version / recover-metadata / apply-now preflight journal-corrupt
 *    and the route-only env-probe-failed / retry-gate messages are single-site
 *    texts (one layer only) and stay inline at their single consumer.
 *  - pending suppression scope: the durable-pending carve-outs in
 *    ordinaryPendingVersion() cover ONLY the recovery-phase reasons
 *    (RETRY_APPLY_REASONS ∪ RETRY_RESTORE_REASONS), while status()'s
 *    blockOutranksPending predicate additionally covers the FATAL
 *    RECOVERABLE_METADATA_BLOCKS. Both consume the shared name sets below, but
 *    the two formulas remain distinct — do not collapse them into one.
 *
 * R2/R3/R4 gate semantics (2026 audit; see STATUS.md) are NOT owned here: the
 * block-branch-allowed early return (block outranks pending), the pending
 * branch applying only when blockedReason === null, and the recover-metadata
 * admission set all live in the route gate / manager projections and are
 * preserved by the consumers of this module.
 */
import { codedError } from './http-utils.ts'
import { FATAL_STARTUP_BLOCK_REASONS } from '@dsh-chamber/dsh-runtime'

/** Wire codes emitted by the refusal builders below (a subset of the route
 *  codeToStatus table; single-site codes stay at their sites). */
export type RuntimeRefusalCode =
  | 'runtime_pending'
  | 'runtime_recovery_required'
  | 'runtime_busy'
  | 'env_override_active'

/** A refusal as it appears on the wire and in the manager's return/throw
 *  surfaces. Field order matters: route bodies have always serialized
 *  `{error, code}` — builders keep that order so the JSON bytes are unchanged. */
export type RuntimeRefusal<C extends RuntimeRefusalCode = RuntimeRefusalCode> = {
  error: string
  code: C
}

/** The manager's throw shape: an Error carrying the wire `.code`, built
 *  exactly like the historical inline `Object.assign(new Error(text), {code})`
 *  (codedError, http-utils N1). */
export function refusalError(refusal: RuntimeRefusal): Error & { code: RuntimeRefusalCode } {
  return codedError(refusal.code, refusal.error) as Error & { code: RuntimeRefusalCode }
}

/**
 * Ordinary-pending terminal refusal (runtime_pending). Use sites:
 *  - runtime-routes.ts recoveryGateRefusal pending branch (version = the
 *    projected status.pending, else 'unknown' — interpolation unchanged),
 *  - runtime-manager.ts assertNoPending / assertNoOrdinaryPending throws,
 *  - runtime-manager.ts profileWriteRefusal pending branch.
 * Restore-builtin / apply-now remain the pending branch's escapes — that
 * decision lives in the route gate, not here.
 */
export function pendingOnlyRefusal(version: string): RuntimeRefusal<'runtime_pending'> {
  return {
    error: `runtime version ${version} is pending; only restore-builtin is allowed until the next startup`,
    code: 'runtime_pending',
  }
}

/** The env-pinned operation refused. Each wording is historic and preserved. */
export type EnvPinnedOperation = 'version mutations' | 'metadata recovery' | 'registry mutation'

/**
 * DSH_GATEWAY_DSH_PATH pin refusal (env_override_active). Use sites:
 *  - 'version mutations': route /select + /apply-now pre-gates; manager
 *    select / apply / rollback / cleanupVersion / restoreBuiltin / retryApply /
 *    applyNowPreflight,
 *  - 'metadata recovery': manager recoverMetadata (env is refused for the
 *    recovery transaction but never for restore/retry-restore data recovery),
 *  - 'registry mutation': manager setRegistry.
 */
export function envPinnedRefusal(op: EnvPinnedOperation): RuntimeRefusal<'env_override_active'> {
  // Historic tails differ in verb number ('version mutations ARE disabled'
  // vs the singular 'metadata recovery IS disabled' / 'registry mutation IS
  // disabled') — each variant reproduces its exact pre-refactor bytes.
  const error = op === 'version mutations'
    ? 'runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'
    : op === 'metadata recovery'
      ? 'runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); metadata recovery is disabled'
      : 'runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); registry mutation is disabled'
  return { error, code: 'env_override_active' }
}

/** The refused operation's tail of the profile-write lease message. */
export type ProfileWriteRefusedOperation = 'runtime mutations' | 'restart' | 'start'

/**
 * Managed profile-write lease refusal while a lease is held (runtime_busy).
 * Use sites: route /select pre-gate ('runtime mutations'), route /restart and
 * /start pre-gates ('restart' / 'start'), and manager assertMutationIdle
 * ('runtime mutations'). The route /restart + /start wordings differ from the
 * route /select wording by their tail and are preserved exactly.
 */
export function profileWriteBusyRefusal(refused: ProfileWriteRefusedOperation): RuntimeRefusal<'runtime_busy'> {
  const error = refused === 'runtime mutations'
    ? 'managed profile write in flight (plugin mutation); runtime mutations are refused'
    : refused === 'restart'
      ? 'managed profile write in flight (plugin mutation); restart refused'
      : 'managed profile write in flight (plugin mutation); start refused'
  return { error, code: 'runtime_busy' }
}

/**
 * Generic single-flight mutation-busy refusal (runtime_busy). Use sites: the
 * route /select / /apply-now / /cleanup-version / /restore-pre-rollback /
 * /recover-metadata pre-gates answering on manager.mutationInProgress().
 * The manager's DIRECT-call wording is per-writer (assertMutationIdle) and
 * stays inline there — this route text is deliberately not merged into it.
 */
export function mutationBusyRefusal(): RuntimeRefusal<'runtime_busy'> {
  return { error: 'another runtime mutation is in flight', code: 'runtime_busy' }
}

/**
 * Apply-now not-running refusal (runtime_busy): the managed dsh never reached
 * ready, so an in-session switch cannot be applied. Use sites: the route
 * /apply-now pre-gate (projected status.connectionState) and the manager
 * applyNowPreflight direct-call parity (plane.connectionState).
 */
export function applyNowNotRunningRefusal(connectionState: string): RuntimeRefusal<'runtime_busy'> {
  return {
    error: `managed dsh is not running (${connectionState}); restore the builtin or retry the interrupted apply/restore before applying now`,
    code: 'runtime_busy',
  }
}

/**
 * Start single-flight refusal (runtime_busy). Use sites: the route /start
 * pre-gate and the manager start() head check.
 */
export function startAlreadyInFlightRefusal(): RuntimeRefusal<'runtime_busy'> {
  return { error: 'a start is already in flight', code: 'runtime_busy' }
}

/**
 * Start-not-a-target refusal (runtime_busy): the managed dsh is already
 * running/starting, so the decision-12 start window does not apply. Use sites:
 * the route /start pre-gate and the manager start() connection gate.
 */
export function startNotApplicableRefusal(connectionState: string): RuntimeRefusal<'runtime_busy'> {
  return {
    error: `managed dsh is running (${connectionState}); start applies to stopped/error/restart-exhausted`,
    code: 'runtime_busy',
  }
}

/**
 * In-memory/durable recovery-block refusal (runtime_recovery_required) in the
 * MANAGER's wording — the manager never labels which recovery route is open
 * (the route gate's `runtime startup block … requires recovery first` /
 * `only <retry-action> is allowed` texts do that and stay in the gate). Use
 * sites (manager only): start(), applyNowPreflight, profileWriteRefusal and
 * restoreBuiltin's durable pre-guard.
 */
export function recoveryRetryRequiredRefusal(reason: string): RuntimeRefusal<'runtime_recovery_required'> {
  return {
    error: `runtime recovery ${reason} is required; resume via the matching retry route (restore-builtin applies to pending or healthy selections only)`,
    code: 'runtime_recovery_required',
  }
}

/**
 * Canonical interrupted-apply recovery names — durable override markers
 * (swapAttempted / lastOutcome 'snapshot-failed'), the in-memory
 * startupBlockReason values, and the projected status phase all use these
 * exact strings. Retry-apply is the ONLY recovery surface when one of these
 * is armed (2026 audit R2/R3/R4; restore-builtin is not offered inside an
 * interrupted apply/snapshot). Consumers: the route gate phase/reason
 * classification and the manager's pending-suppression + status projection.
 */
export const RETRY_APPLY_REASONS: ReadonlySet<string> = new Set(['snapshot-failed', 'swap-attempted'])

/** Canonical interrupted-data-restore recovery names (restore-half /
 *  restore-incomplete; the projected phase is 'restore-blocked'). Retry-restore
 *  is the ONLY recovery surface when one of these is armed. */
export const RETRY_RESTORE_REASONS: ReadonlySet<string> = new Set(['restore-half', 'restore-incomplete'])

/** FATAL metadata blocks plus the recover-route probe-failed sentinels: the
 *  startup-block reasons the recover-metadata route may act on (the four FATAL
 *  reasons are the shared dsh-runtime set — dsh-runtime
 *  FATAL_STARTUP_BLOCK_REASONS, the same set index.ts and the desktop main
 *  block on — plus the two sentinels the manager sets after a failed builtin
 *  recovery probe/start). Everything else (restore-half/incomplete,
 *  swap-attempted…) must resume through its own retry first. Formerly declared
 *  in runtime-manager.ts; kept importable from both runtime layers. */
export const RECOVERABLE_METADATA_BLOCKS: ReadonlySet<string> = new Set([
  ...FATAL_STARTUP_BLOCK_REASONS,
  'metadata-probe-failed',
  'metadata-start-failed',
])

/**
 * 2026 audit R3/H2 "block outranks pending": a FATAL metadata block or an
 * interrupted apply/restore reason outranks a lingering durable pending value
 * (the recovery surface must not be locked behind the pending terminal gate).
 * Consumers: manager status() blockOutranksPending. NOTE the durable-pending
 * carve-outs in ordinaryPendingVersion() deliberately cover only
 * RETRY_APPLY_REASONS ∪ RETRY_RESTORE_REASONS (not the FATAL set) — that
 * formula stays at its site and must not call this predicate.
 */
export function startupBlockReasonOutranksPending(reason: string | null): boolean {
  if (reason === null) return false
  return RECOVERABLE_METADATA_BLOCKS.has(reason)
    || RETRY_APPLY_REASONS.has(reason)
    || RETRY_RESTORE_REASONS.has(reason)
}
