/**
 * dsh runtime apply-phase orchestrator (design 16 §3.3/§3.4) — the pure
 * activation/rollback flow applied at next startup:
 *
 *   applying → snapshot DSH_HOME (no-snapshot-no-switch) → switch pointer →
 *   spawn (host, outside this module) → probe → verdict →
 *     pass  → mark known-good → 'applied'
 *     fail  → restore snapshot + switch pointer back → 'rolled-back'
 *
 * All side effects (snapshot/switchPointer/probe/restore/markKnownGood) are
 * injected so the flow is unit-testable without a live host. The actual host
 * probe execution and reaper/spawn ordering live in the main-process wiring
 * (real-machine), not here.
 */
import { decideVerdict, rollbackTarget } from './activation-gate.ts'
import type { ProbeResult } from './activation-gate.ts'

export interface ApplyDeps {
  /** Snapshot DSH_HOME; throws on failure (no-snapshot-no-switch). */
  snapshot: (sourceVersion: string) => Promise<string>
  /** Atomically switch the `current` pointer to `version`. */
  switchPointer: (version: string) => void
  /** Run the read-only host probes (§3.4). */
  probe: () => Promise<ProbeResult[]>
  /** Restore a snapshot over DSH_HOME (two-phase, idempotent). */
  restore: (snapshotPath: string) => Promise<'complete' | 'half' | 'incomplete'>
  /** Record a probe-pass for a version as a known-good CANDIDATE (§3.4).
   *  The actual promotion to known-good is the caller's sustained-health
   *  responsibility (24h / N successful boots) — a single probe pass must NOT
   *  immediately become a rollback target (a delayed-crash version would then
   *  be the next rollback target, violating「绝不在坏树间交替」). */
  recordProbePass: (version: string) => void
}

export type ApplyStatus = 'applied' | 'rolled-back' | 'failed'

export interface ApplyOutcome {
  status: ApplyStatus
  /** snapshot path taken before switch (available for the caller's records). */
  snapshotPath: string | null
  /** The version the pointer was rolled back to; null = no trusted target
   *  exists — the caller MUST fall to the builtin tree + loud terminal (§3.4
   *  「都无 → null（落内建树 + 响亮终态）」). Only meaningful for 'rolled-back'. */
  rollbackTarget: string | null
  error: string | null
}

export interface ApplyOptions {
  pendingVersion: string
  /** The version that was active BEFORE the switch (§3.7 snapshot naming). */
  sourceVersion: string | null
  knownGoodVersion: string | null
  deps: ApplyDeps
}

/** Run probes, mapping a thrown probe (host RPC fault) to a failed probe
 *  rather than letting it escape — §3.4「探测失败」is a probe outcome. */
async function safeProbe(probe: () => Promise<ProbeResult[]>): Promise<ProbeResult[]> {
  try {
    return await probe()
  } catch (error) {
    return [{ name: 'probe', ok: false, error: error instanceof Error ? error.message : String(error) }]
  }
}

export async function applyPendingVersion(opts: ApplyOptions): Promise<ApplyOutcome> {
  const { pendingVersion, sourceVersion, knownGoodVersion, deps } = opts

  // No-snapshot-no-switch (§3.7): snapshot failure aborts, the pointer never moves.
  let snapshotPath: string
  try {
    snapshotPath = await deps.snapshot(sourceVersion ?? 'unknown')
  } catch (error) {
    return { status: 'failed', snapshotPath: null, rollbackTarget: null, error: error instanceof Error ? error.message : String(error) }
  }

  // §3.3 switch-pointer failure: keep the existing tree, skip the pending
  // apply, surface a loud failure (the caller records swap-attempted).
  try {
    deps.switchPointer(pendingVersion)
  } catch (error) {
    return { status: 'failed', snapshotPath, rollbackTarget: null, error: `switchPointer 失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // Probe gating: default ≤60s window with a delayed verdict (§3.4).
  const startedAt = Date.now()
  let observedOnce = false
  let verdict = await runProbe(await safeProbe(deps.probe), Date.now() - startedAt, observedOnce)
  if (verdict === 'observe') {
    observedOnce = true
    // Second probe pass for the delayed verdict (慢迁移二次确认窗口).
    verdict = await runProbe(await safeProbe(deps.probe), Date.now() - startedAt, observedOnce)
  }

  if (verdict === 'pass') {
    deps.recordProbePass(pendingVersion)
    return { status: 'applied', snapshotPath, rollbackTarget: null, error: null }
  }

  // Rollback: target = previous version (if known-good) else nearest known-good.
  const target = rollbackTarget({
    previousVersion: sourceVersion,
    previousWasKnownGood: sourceVersion !== null && sourceVersion === knownGoodVersion,
    knownGoodVersion,
  })
  let restoreOutcome: 'complete' | 'half' | 'incomplete'
  let restoreError: string | null = null
  try {
    restoreOutcome = await deps.restore(snapshotPath)
  } catch (error) {
    restoreOutcome = 'half'
    restoreError = error instanceof Error ? error.message : String(error)
  }
  let switchError: string | null = null
  if (target !== null) {
    try {
      deps.switchPointer(target)
    } catch (error) {
      // Rollback switch failure: the pointer stays on the bad tree — surface
      // it loudly (the caller's terminal path must not claim a clean rollback).
      switchError = error instanceof Error ? error.message : String(error)
    }
  }
  // Loud, honest error for every non-complete restore — §3.6 绝不无条件「数据已恢复」。
  const error =
    switchError !== null
      ? `回退指针切换失败（保留当前树）：${switchError}`
      : restoreOutcome === 'complete'
        ? null
        : restoreOutcome === 'half'
          ? `数据恢复失败（现场 .old 保留，可重试恢复）：${restoreError ?? 'snapshot restore 未完成'}`
          : '数据恢复未完成（现场保留）'
  return {
    status: 'rolled-back',
    snapshotPath,
    rollbackTarget: target,
    error,
  }
}

async function runProbe(probes: ProbeResult[], elapsedMs: number, observedOnce: boolean): Promise<'pass' | 'fail' | 'observe'> {
  return decideVerdict(probes, { elapsedMs, observedOnce })
}
