/**
 * Runtime refusal / recovery-gate single sources for the /chamber/runtime surface's
 * two defense layers: route pre-gates (synchronous 409/403 from the projected
 * status) and the manager's own assertions (authoritative for direct calls). Both
 * execute; only refusal construction and the shared classification formulas live here.
 *
 * Builders reproduce exact text bytes, codes and {error, code} order. NOT unified
 * on purpose: platform read-only and blocked-startup wordings differ per layer,
 * single-site texts stay inline, and the pending-suppression scope (RETRY_* sets)
 * differs from status()'s block-outranks-pending predicate.
 */
import { codedError } from './http-utils.ts'
import { FATAL_STARTUP_BLOCK_REASONS } from '@dsh-chamber/dsh-runtime'

/** Wire codes emitted by the refusal builders below; single-site codes stay at
 *  their sites. */
export type RuntimeRefusalCode =
  | 'runtime_pending'
  | 'runtime_recovery_required'
  | 'runtime_busy'
  | 'env_override_active'

/** A refusal as it appears on the wire and in the manager's return/throw
 *  surfaces. Field order matters: route bodies serialize `{error, code}`. */
export type RuntimeRefusal<C extends RuntimeRefusalCode = RuntimeRefusalCode> = {
  error: string
  code: C
}

/** The manager's throw shape: an Error carrying the wire `.code` (codedError). */
export function refusalError(refusal: RuntimeRefusal): Error & { code: RuntimeRefusalCode } {
  return codedError(refusal.code, refusal.error) as Error & { code: RuntimeRefusalCode }
}

/** Ordinary-pending terminal refusal (runtime_pending): the route's pending branch
 *  (projected status.pending, else 'unknown') plus the manager's assertNoPending /
 *  assertNoOrdinaryPending / profileWriteRefusal. Restore-builtin / apply-now escapes
 *  are the route gate's decision, not here. */
export function pendingOnlyRefusal(version: string): RuntimeRefusal<'runtime_pending'> {
  return {
    error: `runtime version ${version} is pending; only restore-builtin is allowed until the next startup`,
    code: 'runtime_pending',
  }
}

/** The env-pinned operation refused. Each wording is preserved exactly. */
export type EnvPinnedOperation = 'version mutations' | 'metadata recovery' | 'registry mutation'

/** DSH_GATEWAY_DSH_PATH pin refusal (env_override_active) for version mutations (route
 *  /select + /apply-now and the manager's select/apply/rollback/cleanupVersion/
 *  restoreBuiltin/retryApply/applyNowPreflight), recoverMetadata (restore/retry-restore
 *  data recovery stays allowed) and setRegistry. */
export function envPinnedRefusal(op: EnvPinnedOperation): RuntimeRefusal<'env_override_active'> {
  // The tails differ in verb number; each variant reproduces its exact bytes.
  const error = op === 'version mutations'
    ? 'runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'
    : op === 'metadata recovery'
      ? 'runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); metadata recovery is disabled'
      : 'runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); registry mutation is disabled'
  return { error, code: 'env_override_active' }
}

/** The refused operation's tail of the profile-write lease message. */
export type ProfileWriteRefusedOperation = 'runtime mutations' | 'restart' | 'start'

/** Managed profile-write lease refusal while a lease is held (runtime_busy) for route
 *  /select, /restart, /start pre-gates and manager assertMutationIdle. Each tail is
 *  preserved exactly. */
export function profileWriteBusyRefusal(refused: ProfileWriteRefusedOperation): RuntimeRefusal<'runtime_busy'> {
  const error = refused === 'runtime mutations'
    ? 'managed profile write in flight (plugin mutation); runtime mutations are refused'
    : refused === 'restart'
      ? 'managed profile write in flight (plugin mutation); restart refused'
      : 'managed profile write in flight (plugin mutation); start refused'
  return { error, code: 'runtime_busy' }
}

/** Generic single-flight mutation-busy refusal (runtime_busy) for the route /select,
 *  /apply-now, /cleanup-version, /restore-pre-rollback and /recover-metadata pre-gates
 *  (manager.mutationInProgress()). The manager's per-writer direct-call wording stays
 *  inline and is deliberately not merged. */
export function mutationBusyRefusal(): RuntimeRefusal<'runtime_busy'> {
  return { error: 'another runtime mutation is in flight', code: 'runtime_busy' }
}

/** Apply-now not-running refusal (runtime_busy): the managed dsh never reached ready, so
 *  an in-session switch cannot be applied. Shared by the route /apply-now pre-gate and
 *  the manager applyNowPreflight direct-call parity. */
export function applyNowNotRunningRefusal(connectionState: string): RuntimeRefusal<'runtime_busy'> {
  return {
    error: `managed dsh is not running (${connectionState}); restore the builtin or retry the interrupted apply/restore before applying now`,
    code: 'runtime_busy',
  }
}

/** Start single-flight refusal (runtime_busy) for the route /start pre-gate and
 *  the manager start() head check. */
export function startAlreadyInFlightRefusal(): RuntimeRefusal<'runtime_busy'> {
  return { error: 'a start is already in flight', code: 'runtime_busy' }
}

/**
 * Start-not-a-target refusal (runtime_busy): the managed dsh is already
 * running/starting, so the start window does not apply. Shared by the route
 * /start pre-gate and the manager start() connection gate.
 */
export function startNotApplicableRefusal(connectionState: string): RuntimeRefusal<'runtime_busy'> {
  return {
    error: `managed dsh is running (${connectionState}); start applies to stopped/error/restart-exhausted`,
    code: 'runtime_busy',
  }
}

/** MANAGER wording for an in-memory/durable recovery block
 *  (runtime_recovery_required): it never labels which recovery route is open — the
 *  route gate's own texts do. Use sites (manager only): start(), applyNowPreflight,
 *  profileWriteRefusal and restoreBuiltin's durable pre-guard. */
export function recoveryRetryRequiredRefusal(reason: string): RuntimeRefusal<'runtime_recovery_required'> {
  return {
    error: `runtime recovery ${reason} is required; resume via the matching retry route (restore-builtin applies to pending or healthy selections only)`,
    code: 'runtime_recovery_required',
  }
}

/**
 * Canonical interrupted-apply recovery names — durable override markers
 * (swapAttempted / lastOutcome 'snapshot-failed'), in-memory
 * startupBlockReason values and the projected phase all use these exact
 * strings. Retry-apply is the ONLY recovery surface while one is armed
 * (restore-builtin is not offered inside an interrupted apply/snapshot).
 */
export const RETRY_APPLY_REASONS: ReadonlySet<string> = new Set(['snapshot-failed', 'swap-attempted'])

/** Canonical interrupted-data-restore recovery names (restore-half /
 *  restore-incomplete; projected phase 'restore-blocked'). Retry-restore is the
 *  ONLY recovery surface while one is armed. */
export const RETRY_RESTORE_REASONS: ReadonlySet<string> = new Set(['restore-half', 'restore-incomplete'])

/** Startup-block reasons the recover-metadata route may act on: the shared dsh-runtime
 *  FATAL set (the same constant index.ts and the desktop main block on) plus the two
 *  sentinels the manager sets after a failed builtin recovery probe/start. Everything
 *  else must resume through its own retry first. Kept importable from both layers. */
export const RECOVERABLE_METADATA_BLOCKS: ReadonlySet<string> = new Set([
  ...FATAL_STARTUP_BLOCK_REASONS,
  'metadata-probe-failed',
  'metadata-start-failed',
])

/** "Block outranks pending": a FATAL metadata block or an interrupted apply/restore
 *  reason outranks a lingering durable pending value, so the recovery surface is not
 *  locked behind the pending terminal gate. Manager status() only. NOTE
 *  ordinaryPendingVersion() deliberately covers only the RETRY_* sets — its formula
 *  stays at its site and must not call this predicate. */
export function startupBlockReasonOutranksPending(reason: string | null): boolean {
  if (reason === null) return false
  return RECOVERABLE_METADATA_BLOCKS.has(reason)
    || RETRY_APPLY_REASONS.has(reason)
    || RETRY_RESTORE_REASONS.has(reason)
}
