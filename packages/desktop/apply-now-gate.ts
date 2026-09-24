/**
 * Apply-now gate — pure decision function behind RUNTIME_APPLY_NOW (design 18
 * addendum §4.1): `ok` lets the caller confirm-dialog and run the activation
 * transaction (runRuntimeStartup) from authoritative state it re-read itself.
 *
 * First hit wins: busy (operation/fence) → env → not-allowed (unsupported
 * management or non-pending phase) → blocked → not-ready (connectionState ∉
 * {ready, degraded}; null control plane projects as non-member) → no-pending
 * (pending ?? journalTarget ?? overridePending all null) → snapshot-failed →
 * invalid-tree → ok(target). `treeValid` is the caller's validateVersionTree(...).ok
 * preflight: a corrupt target must never start a doomed stop/respawn cycle.
 */

export type ApplyNowGateInput = {
  /** RuntimePhase projected as a string. */
  phase: string
  /** 'bundled' | 'user' | 'env'; env outranks every persisted override. */
  source: string
  runtimeBlocked: boolean
  /** Version management is read-only on unsupported platforms. */
  managementSupported: boolean
  /** Carried for caller parity; the gate does not consult it. */
  hasOverride: boolean
  /** Durable pending version from the override record. */
  pending: string | null
  /** A durable journal intent target. */
  journalTarget: string | null
  /** Raw override fallback; the post-confirm gate must resolve the same three sources. */
  overridePending: string | null
  /** Non-member values (a null control plane) reject alongside anything outside ready/degraded. */
  connectionState: string
  operationBusy: boolean
  fenceBusy: boolean
  /** retry-apply owns that path. */
  snapshotFailed: boolean
  /** Caller preflight via validateVersionTree(...).ok. */
  treeValid: boolean
}

export type ApplyNowGateResult =
  | { ok: true; target: string }
  | { ok: false; reason: 'busy' | 'env' | 'not-allowed' | 'blocked' | 'not-ready' | 'no-pending' | 'snapshot-failed' | 'invalid-tree' }

const APPLY_NOW_CONNECTION_STATES = new Set(['ready', 'degraded'])

export function evaluateApplyNowGate(input: ApplyNowGateInput): ApplyNowGateResult {
  if (input.operationBusy || input.fenceBusy) return { ok: false, reason: 'busy' }
  if (input.source === 'env') return { ok: false, reason: 'env' }
  if (!input.managementSupported || input.phase !== 'pending') return { ok: false, reason: 'not-allowed' }
  if (input.runtimeBlocked) return { ok: false, reason: 'blocked' }
  if (!APPLY_NOW_CONNECTION_STATES.has(input.connectionState)) return { ok: false, reason: 'not-ready' }
  const target = input.pending ?? input.journalTarget ?? input.overridePending
  if (target === null) return { ok: false, reason: 'no-pending' }
  if (input.snapshotFailed) return { ok: false, reason: 'snapshot-failed' }
  if (!input.treeValid) return { ok: false, reason: 'invalid-tree' }
  return { ok: true, target }
}
