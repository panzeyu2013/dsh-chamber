/**
 * Design 17 §3.4 F7 planner for a delayed crash (`restart-exhausted`).
 *
 * This module deliberately performs no process, pointer, snapshot, or store
 * effect. It turns the durable `applied-monitoring` journal into a
 * `rollback-needed` journal. The main process MUST persist the returned
 * journal successfully before it stops a host, changes `current`, restores
 * data, removes the failed candidate, or calls `applyPendingVersion`.
 *
 * Once persisted, the journal phase is both the exactly-once latch and the
 * crash-recovery input: duplicate state notifications return
 * `already-in-recovery`, and startup can resume the existing apply-phase
 * rollback transaction even though override.pending has already been cleared.
 */
import { basename } from 'node:path'
import { rollbackTarget, shouldAutoRollback } from './activation-gate.ts'
import type {
  ActivationJournal,
  ActivationJournalIntent,
  ActivationJournalState,
} from './dsh-runtime-store.ts'
import { isSafeVersion } from './version-safety.ts'

export interface RestartExhaustedRollbackPlanOptions {
  restartExhausted: boolean
  activeIsOverride: boolean
  failedVersion: string
  /** Must come from readActivationJournalState(), not renderer input. */
  journalState: ActivationJournalState
  now?: () => Date
}

export type RestartExhaustedNotTriggeredReason =
  | 'not-restart-exhausted'
  | 'active-runtime-not-override'
  | 'failed-version-invalid'
  | 'journal-missing'
  | 'journal-corrupt'
  | 'journal-target-builtin'
  | 'journal-target-mismatch'
  | 'journal-not-monitoring'
  | 'journal-monitoring-invalid'
  | 'clock-invalid'

export type RestartExhaustedRollbackPlan =
  | {
      status: 'not-triggered'
      reason: RestartExhaustedNotTriggeredReason
    }
  | {
      status: 'already-in-recovery'
      /** The already-persisted journal to pass back into applyPendingVersion. */
      journal: ActivationJournal
      rollbackTarget: string | null
    }
  | {
      status: 'planned'
      /** Persist this exact value before ANY rollback side effect. */
      journal: ActivationJournal
      rollbackTarget: string | null
      /**
       * applied-monitoring may carry a later user selection. Current journal
       * validation permits nextIntent only in that phase, so the rollback
       * journal clears it and returns it explicitly for the owner to re-queue
       * after the rollback reaches a safe terminal state.
       */
      deferredIntent: ActivationJournalIntent | null
    }

const RECOVERY_PHASES = new Set<ActivationJournal['phase']>([
  'rollback-needed',
  'restoring',
  'restore-complete',
  'fallback-builtin',
])

function isSafeStoredBasename(value: string | null): value is string {
  return value !== null
    && value.length > 0
    && value.length <= 255
    && basename(value) === value
    && value !== '.'
    && value !== '..'
    && !value.includes('\0')
}

function monitoringFactsAreUsable(journal: ActivationJournal): boolean {
  if (journal.schemaVersion !== 1 || journal.phase !== 'applied-monitoring') return false
  if (!isSafeVersion(journal.targetVersion) || journal.targetIsBuiltin) return false
  if (journal.sourceVersion === null || !isSafeVersion(journal.sourceVersion)) return false
  if (typeof journal.sourceIsBuiltin !== 'boolean' || typeof journal.sourceWasKnownGood !== 'boolean') return false
  if (journal.knownGoodVersion !== null && !isSafeVersion(journal.knownGoodVersion)) return false
  return isSafeStoredBasename(journal.preSwapSnapshotName)
}

function targetForDelayedRollback(journal: ActivationJournal, failedVersion: string): string | null {
  // If builtin was the pre-swap runtime it is the authoritative previous
  // target, represented by clearing `current`, not by writing its semver.
  if (journal.sourceIsBuiltin === true) return null

  const selected = rollbackTarget({
    previousVersion: journal.sourceVersion,
    previousWasKnownGood: journal.sourceWasKnownGood === true
      || journal.sourceVersion === journal.knownGoodVersion,
    knownGoodVersion: journal.knownGoodVersion,
  })

  // Corrupt/stale facts must never bounce back to the version which has just
  // exhausted restarts. Prefer a distinct known-good tree, otherwise builtin.
  if (selected !== failedVersion) return selected
  return journal.knownGoodVersion !== null && journal.knownGoodVersion !== failedVersion
    ? journal.knownGoodVersion
    : null
}

/**
 * Produce the durable F7 rollback intent. This function is pure: it neither
 * mutates the supplied journal nor performs an injected callback.
 */
export function planRestartExhaustedRollback(
  opts: RestartExhaustedRollbackPlanOptions,
): RestartExhaustedRollbackPlan {
  if (!opts.restartExhausted) {
    return { status: 'not-triggered', reason: 'not-restart-exhausted' }
  }
  if (!opts.activeIsOverride || !shouldAutoRollback(true, opts.activeIsOverride)) {
    return { status: 'not-triggered', reason: 'active-runtime-not-override' }
  }
  if (!isSafeVersion(opts.failedVersion)) {
    return { status: 'not-triggered', reason: 'failed-version-invalid' }
  }
  if (opts.journalState.kind === 'missing') {
    return { status: 'not-triggered', reason: 'journal-missing' }
  }
  if (opts.journalState.kind === 'corrupt') {
    return { status: 'not-triggered', reason: 'journal-corrupt' }
  }

  const journal = opts.journalState.journal
  if (journal.targetIsBuiltin) {
    return { status: 'not-triggered', reason: 'journal-target-builtin' }
  }
  if (journal.targetVersion !== opts.failedVersion) {
    return { status: 'not-triggered', reason: 'journal-target-mismatch' }
  }

  if (RECOVERY_PHASES.has(journal.phase)) {
    return {
      status: 'already-in-recovery',
      journal,
      rollbackTarget: journal.rollbackTarget,
    }
  }
  if (journal.phase !== 'applied-monitoring') {
    return { status: 'not-triggered', reason: 'journal-not-monitoring' }
  }
  if (!monitoringFactsAreUsable(journal)) {
    return { status: 'not-triggered', reason: 'journal-monitoring-invalid' }
  }

  const now = opts.now?.() ?? new Date()
  if (Number.isNaN(now.getTime())) {
    return { status: 'not-triggered', reason: 'clock-invalid' }
  }
  const target = targetForDelayedRollback(journal, opts.failedVersion)
  const planned: ActivationJournal = {
    ...journal,
    phase: 'rollback-needed',
    rollbackTarget: target,
    // Store validation currently permits this queue only while monitoring.
    // Return it separately so the owner can re-queue it after safe rollback.
    nextIntent: null,
    updatedAt: now.toISOString(),
  }
  return {
    status: 'planned',
    journal: planned,
    rollbackTarget: target,
    deferredIntent: journal.nextIntent,
  }
}
