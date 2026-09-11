/**
 * Gateway armed-request guards (2026-09-11 review-fix F2).
 *
 * Every destructive gateway action in the runtime section arms the ONE in-app
 * confirmation dialog, and the request it arms carries the guard predicate that
 * allowed the arm. Those predicates used to be render-scope booleans captured at
 * ARM time, while the dialog can stay open across this section's ~3s status
 * poll — so the accept could fire an action the CURRENT facts refuse. The probe:
 * arm `restore-builtin` at `phase=idle`, the poll flips the gate
 * (`restoreBuiltinDisabled=true`, `phase=installing`), the accept still ran
 * `restore-builtin@phase=installing`. Two of the actions additionally carry a
 * target captured at arm time (`cleanup-version` a version,
 * `restore-pre-rollback` a stash name, `apply-now` the pending version), so a
 * stale accept was not even always an honest 409.
 *
 * The fix: one predicate per action, evaluated against a LIVE fact snapshot —
 * the arm-time early return and the accept-time `stillValid` hook call the SAME
 * function, so they can never drift apart. Every gate here is the section's
 * existing pure projection (`remoteRuntimeActionGates`, the shared gateway core)
 * recomputed over the snapshot, never a second copy of the server's matrix.
 *
 * This module is pure and plain-node testable (no DOM, no React): the probe
 * above is replayed in test/runtime-confirm-guards.test.ts.
 */
import {
  remoteRuntimeActionGates,
  type RemoteRuntimeStatus,
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

/**
 * The live facts one armed gateway request is re-validated against. The section
 * mirrors them on every render (React state is not readable synchronously from
 * an event handler's closure of an older render).
 */
export interface GatewayConfirmFacts {
  /** The latest server status projection (the last answer of the ~3s poll). */
  status: RemoteRuntimeStatus | null
  /** The client-side busy window: section action, registry write, restart, user check. */
  busy: boolean
  /** The server's current removable-version list — the cleanup candidates. */
  removableVersions: readonly string[]
}

/**
 * The pure gate projection over one fact snapshot: literally the function the
 * section's render uses, so a re-validation cannot disagree with the buttons.
 * @param facts - the live facts.
 * @returns the action gates for that snapshot.
 */
export function gatewayConfirmGates(facts: GatewayConfirmFacts): ReturnType<typeof remoteRuntimeActionGates> {
  return remoteRuntimeActionGates(facts.status, facts.busy)
}

/** 恢复内建 (restore-builtin) is still offered by the current facts. */
export function restoreBuiltinStillValid(facts: GatewayConfirmFacts): boolean {
  return !gatewayConfirmGates(facts).restoreBuiltinDisabled
}

/** 重试应用 (retry-apply) is still offered by the current facts. */
export function retryApplyStillValid(facts: GatewayConfirmFacts): boolean {
  return !gatewayConfirmGates(facts).retryApplyDisabled
}

/** 重试恢复 (retry-restore) is still offered by the current facts. */
export function retryRestoreStillValid(facts: GatewayConfirmFacts): boolean {
  return !gatewayConfirmGates(facts).retryRestoreDisabled
}

/** 元数据救援 (recover-metadata) is still offered by the current facts. */
export function recoverMetadataStillValid(facts: GatewayConfirmFacts): boolean {
  return !gatewayConfirmGates(facts).recoverMetadataDisabled
}

/**
 * 「立即应用」(apply-now) is still offered AND still targets the version the
 * dialog named (a stale target would apply a different pending version than the
 * one the user confirmed).
 * @param facts - the live facts.
 * @param target - the pending version captured when the dialog was armed.
 */
export function applyNowStillValid(facts: GatewayConfirmFacts, target: string): boolean {
  return !gatewayConfirmGates(facts).applyNowDisabled && facts.status?.pending === target
}

/**
 * 清理已安装版本 (cleanup-version) is still offered AND still targets a version
 * the server currently lists as removable — the captured version may have become
 * the active one (or left the list) while the dialog was open.
 * @param facts - the live facts.
 * @param version - the candidate version captured when the dialog was armed.
 */
export function cleanupVersionStillValid(facts: GatewayConfirmFacts, version: string): boolean {
  return !gatewayConfirmGates(facts).mutationDisabled && facts.removableVersions.includes(version)
}

/**
 * The status projection that makes 恢复回滚前数据 offerable at all (the captured
 * stash excluded): idle, not startup-blocked, at least one stash recorded, and a
 * latest-stash name to name in the dialog. The section's row visibility and this
 * guard's re-validation share this one definition, so they cannot drift.
 *
 * The startup-block test keeps the row's own STRICT `=== null` (the section's
 * other projections treat an empty-string reason as "not blocked" — the shared
 * gate does too). Keeping the strict form here means this row can only ever be
 * HIDDEN in a state the gates would allow, never offered in one they refuse: the
 * conservative direction of the same question.
 * @param status - the live status projection.
 * @returns whether the row may be offered for this status.
 */
export function preRollbackOfferable(status: RemoteRuntimeStatus | null): boolean {
  return status !== null
    && status.phase === 'idle'
    && status.startupBlockedReason === null
    && (status.preRollbackCount ?? 0) > 0
    && status.preRollbackLatestName !== null
}

/**
 * 恢复回滚前数据 (restore-pre-rollback) is still offered AND the captured stash
 * is STILL the latest one — the route restores whatever stash it is handed, so a
 * stale name would restore a different snapshot than the dialog named.
 * @param facts - the live facts.
 * @param stashName - the stash captured when the dialog was armed.
 */
export function restorePreRollbackStillValid(facts: GatewayConfirmFacts, stashName: string): boolean {
  return !gatewayConfirmGates(facts).mutationDisabled
    && preRollbackOfferable(facts.status)
    && facts.status?.preRollbackLatestName === stashName
}
