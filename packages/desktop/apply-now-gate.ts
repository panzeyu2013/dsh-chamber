/**
 * Apply-now gate — the pure decision function behind the desktop
 * RUNTIME_APPLY_NOW IPC handler (main.ts, design 18 addendum §4.1).
 *
 * Extracted from the handler so the full gate matrix is unit-testable with
 * plain node:test (review R2/R5: the handler previously had zero behavioral
 * tests, and the post-confirm re-check was asymmetric with the pre-confirm
 * gate — the second gate omitted the override.pending fallback and neither
 * preflighted the target tree). The gate is deliberately side-effect free:
 * the caller re-reads authoritative state and builds the input; `ok` means
 * the caller may show the native confirm dialog and run the activation
 * transaction (runRuntimeStartup).
 *
 * Semantics (identical to the pre-existing handler, plus the tree preflight):
 *   - operationBusy || fenceBusy                 → 'busy'
 *   - source === 'env'                           → 'env'
 *   - !managementSupported || phase !== 'pending'→ 'not-allowed'
 *   - runtimeBlocked                             → 'blocked'
 *   - connectionState ∉ {ready, degraded}        → 'not-ready'
 *     (the caller projects a null control plane as a non-member value)
 *   - pending ?? journalTarget ?? overridePending is null → 'no-pending' (F5)
 *   - snapshotFailed                             → 'snapshot-failed'
 *   - !treeValid                                 → 'invalid-tree'
 *   - otherwise                                  → ok with the resolved target
 *
 * The caller preflights `treeValid` with
 * `validateVersionTree(runtimeBaseDir, target).ok` when a target resolves: a
 * corrupt target tree must never start a stop/respawn cycle that is doomed to
 * fail (design 18 §2.2 gate list includes "target tree valid").
 */

export type ApplyNowGateInput = {
  /** Runtime state-machine phase (RuntimePhase projected as a string). */
  phase: string
  /** 'bundled' | 'user' | 'env' — env outranks every persisted override. */
  source: string
  /** Authoritative main-process local-spawn gate (state.runtimeBlocked). */
  runtimeBlocked: boolean
  /** Version management is read-only on unsupported platforms. */
  managementSupported: boolean
  /** Persisted override exists (projection; carried for caller parity, not
   *  consulted by the gate — the durable target sources below are what F5
   *  actually requires). */
  hasOverride: boolean
  /** state.pending — the durable pending version from the override record. */
  pending: string | null
  /** selectedJournalIntent(...)?.targetVersion — a durable journal intent. */
  journalTarget: string | null
  /** override.record.pending — the raw override fallback (second-gate parity:
   *  the post-confirm gate must resolve the same three-source target). */
  overridePending: string | null
  /** Control-plane connection state; anything outside ready/degraded rejects
   *  (the handler maps a null control plane to a non-member projection). */
  connectionState: string
  /** A runtime operation (startup/rollback/restore) is in flight. */
  operationBusy: boolean
  /** Another writer holds the runtime writer fence. */
  fenceBusy: boolean
  /** override.lastOutcome === 'snapshot-failed' — retry-apply owns that path. */
  snapshotFailed: boolean
  /** Caller preflight: when a target resolves, validateVersionTree(...).ok. */
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
