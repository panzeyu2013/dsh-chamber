/**
 * Durable rollback facts shared by apply-phase, runtime-startup, restart-exhausted-rollback and
 * runtime-metadata-recovery. Deliberately NOT re-exported by index.ts: it gives the four
 * rollback-continuation decision sites one shared source without widening the public export
 * surface (dist-sync lockstep).
 */
import type { ActivationJournal, ActivationJournalPhase } from './dsh-runtime-store.ts'
import { rollbackTarget } from './activation-gate.ts'

/** Phases in which a rollback continuation is already durably decided (`rollback-needed` →
 *  `restoring` → `restore-complete`, or the `fallback-builtin` escape). Single membership source
 *  for the restart-exhausted planner, startup's invalidation gate and apply-phase's resume gate. */
export const ROLLBACK_CONTINUATION_PHASES: ReadonlySet<ActivationJournalPhase> = new Set([
  'rollback-needed',
  'restoring',
  'restore-complete',
  'fallback-builtin',
])

/**
 * Rollback target derived from the journal's immutable pre-swap fields — the single derivation
 * shared by `beginDelayedRollback`, apply-phase's probe-failure rollback path, and the
 * restart-exhausted planner (which adds its own builtin guard and failed-version exclusion).
 */
export function delayedRollbackTarget(journal: ActivationJournal): string | null {
  return rollbackTarget({
    previousVersion: journal.sourceIsBuiltin ? null : journal.sourceVersion,
    previousWasKnownGood: journal.sourceWasKnownGood === true
      || journal.sourceVersion === journal.knownGoodVersion,
    knownGoodVersion: journal.knownGoodVersion,
  })
}
