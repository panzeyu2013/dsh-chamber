/**
 * Startup transaction. Reaper has completed and public local-host starts remain
 * gated while this module completes restore/journal recovery.
 *
 * Both entries accept an optional transaction-level AbortSignal: a pre-aborted
 * signal at the apply entry cancels the attempt with zero side effects and leaves
 * the durable journal for the next startup. Hosts that never abort omit it.
 */
import { applyPendingVersion, beginDelayedRollback, type ApplyOutcome } from './apply-phase.ts'
import type { ManualRollbackPreparation } from './apply-phase.ts'
import type {
  ActivationIntentKind,
  ActivationJournal,
  ActivationJournalIntent,
  ActivationJournalState,
  CurrentPointerState,
  OverrideRecord,
  OverrideState,
} from './dsh-runtime-store.ts'
import { ROLLBACK_CONTINUATION_PHASES } from './rollback-facts.ts'
import { effectivePending as readEffectivePending } from './override-lifecycle.ts'
import type { ProbeResult } from './activation-gate.ts'

export interface StartupActivationFacts {
  /** Must come from the startup-time current pointer, never chosen/resolved. */
  sourceVersion: string | null
  sourceIsBuiltin: boolean
  sourceWasKnownGood: boolean
  knownGoodVersion: string | null
}

export interface StartupDeps {
  cleanupStaleInstalls: () => string[]
  evict: () => string[]
  completeInterruptedRestore: () => Promise<'none' | 'complete' | 'half' | 'incomplete'>
  readOverrideState: () => OverrideState
  writeOverride: (record: OverrideRecord) => void
  deleteOverride: () => void
  readCurrentPointerState: () => CurrentPointerState
  readActivationJournal: () => ActivationJournalState
  writeActivationJournal: (journal: ActivationJournal) => void
  clearActivationJournal: () => void
  /** Env runtime outranks persisted activation; pending must remain deferred. */
  envOverrideActive?: () => boolean
  shellVersion: string
  /** Exact version read from the packaged builtin runtime manifest. */
  builtinVersion: string
  activationFacts: () => StartupActivationFacts
  snapshot: (sourceVersion: string) => Promise<string>
  resolveSnapshotName: (snapshotName: string) => Promise<string | null>
  prepareManualRollback: (targetVersion: string) => Promise<ManualRollbackPreparation>
  validateTarget: (version: string, isBuiltin: boolean) => { ok: true } | { ok: false; error: string }
  switchPointer: (version: string | null) => void
  /**
   * Spawn the candidate tree and run the activation probes. `signal` is optional so
   * two-argument implementers keep compiling; the orchestration seam forwards its
   * transaction-level signal here (candidate probes keep it, rollback verification
   * probes null an already-aborted one).
   */
  spawnAndProbe: (version: string, isBuiltin: boolean, signal?: AbortSignal) => Promise<ProbeResult[]>
  /**
   * Forwarded verbatim to apply-phase. It stays a function reference all the way
   * through because the apply phase resolves it only after a probe attempt finished:
   * a host may refresh its seeded-domain table inside `spawnAndProbe`, and capturing
   * an array here would freeze the cold-start empty table and fail the exact-set verdict.
   */
  probeExpectedNames?: () => readonly string[]
  stopHost: () => Promise<void>
  restore: (snapshotPath: string) => Promise<'complete' | 'half' | 'incomplete'>
  recordProbePass: (version: string) => void
  recordFailure: (input: {
    version: string
    phase: string
    error: string
    restoreOutcome: 'none' | 'complete' | 'half' | 'incomplete'
    snapshotPath: string | null
  }) => void
  waitBeforeRetry?: (delayMs: number) => Promise<void>
}

export type StartupBlockedReason =
  | 'restore-half'
  | 'restore-incomplete'
  | 'snapshot-failed'
  | 'swap-attempted'
  | 'env-override'
  | 'journal-corrupt'
  | 'current-corrupt'
  | 'override-corrupt'
  | 'journal-mismatch'

/** The FATAL metadata-corruption blocked reasons (journal/current/override corrupt +
 *  journal-mismatch), shared single source for the desktop main and the gateway
 *  composition boundary so neither can drift its block classification. */
export const FATAL_STARTUP_BLOCK_REASONS: readonly StartupBlockedReason[] = [
  'journal-corrupt',
  'current-corrupt',
  'override-corrupt',
  'journal-mismatch',
]

export interface StartupResult {
  applyOutcome: ApplyOutcome | null
  restored: 'none' | 'complete' | 'half' | 'incomplete'
  blockedReason: StartupBlockedReason | null
  cleanedWorkDirs: string[]
  evicted: string[]
  /** Restart-exhausted context for main's delayed-rollback subscription. */
  monitoringJournal: ActivationJournal | null
}

export type StartupMetadataHealthStatus =
  | 'healthy'
  | 'selection-corrupt'
  | 'recovery-in-progress'
  | 'recovery-finalized'
  | 'recovery-marker-corrupt'

/**
 * An env workspace outranks dormant chamber selection files, but never an unfinished
 * or unreadable metadata-recovery transaction.
 */
export function shouldProbeEnvWithDormantCorruptSelection(
  status: StartupMetadataHealthStatus,
  envOverrideActive: boolean,
): boolean {
  return envOverrideActive && status === 'selection-corrupt'
}

function outcomeError(outcome: ApplyOutcome): string {
  if (outcome.error !== null) return outcome.error
  if (outcome.status === 'rolled-back') return 'activation probe failed; runtime rolled back'
  if (outcome.status === 'snapshot-failed') return 'runtime data snapshot failed'
  return 'runtime activation failed'
}

function reachedSafeFallback(outcome: ApplyOutcome): boolean {
  return outcome.status === 'rolled-back'
    || (outcome.status === 'failed' && outcome.failureKind === 'terminal' && !outcome.runtimeBlocked)
}

function resultBase(
  restored: StartupResult['restored'],
  blockedReason: StartupBlockedReason | null,
  cleanedWorkDirs: string[],
  evicted: string[],
  monitoringJournal: ActivationJournal | null = null,
): StartupResult {
  return { applyOutcome: null, restored, blockedReason, cleanedWorkDirs, evicted, monitoringJournal }
}

function normalizedIntent(input: ActivationJournalIntent): ActivationJournalIntent {
  return {
    targetVersion: input.targetVersion,
    targetIsBuiltin: input.targetIsBuiltin,
    manualRollback: input.manualRollback,
    intentKind: input.intentKind,
  }
}

function convertMonitoringToIntent(_journal: ActivationJournal, intent: ActivationJournalIntent): ActivationJournal {
  return {
    schemaVersion: 1,
    phase: 'intent',
    ...normalizedIntent(intent),
    sourceVersion: null,
    sourceIsBuiltin: null,
    sourceWasKnownGood: null,
    knownGoodVersion: null,
    preSwapSnapshotName: null,
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: null,
    nextIntent: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function resumedRestorePhase(journal: ActivationJournal): ActivationJournal | null {
  const phase = journal.phase === 'restoring'
    ? 'restore-complete'
    : journal.phase === 'manual-restoring'
      ? 'manual-restored'
      : null
  if (phase === null) return null
  return { ...journal, phase, updatedAt: new Date().toISOString() }
}

function safeClearJournal(deps: StartupDeps): void {
  try { deps.clearActivationJournal() } catch { /* stale evidence remains fail-closed */ }
}

function pointerVersion(state: CurrentPointerState): string | null {
  return state.kind === 'valid' ? state.version : null
}

/** Immutable pre-swap facts a non-intent journal contributes to an activation. */
function activationFactsFromJournal(journal: ActivationJournal): StartupActivationFacts {
  return {
    sourceVersion: journal.sourceVersion,
    sourceIsBuiltin: journal.sourceIsBuiltin === true,
    sourceWasKnownGood: journal.sourceWasKnownGood === true,
    knownGoodVersion: journal.knownGoodVersion,
  }
}

function corruptMetadataReason(
  journal: ActivationJournalState,
  pointer: CurrentPointerState,
  override: OverrideState,
): StartupBlockedReason | null {
  if (journal.kind === 'corrupt') return 'journal-corrupt'
  // 'unknown' (EACCES/EIO) is not a lesser state: it proves neither absence nor
  // corruption, so it blocks like corrupt rather than aliasing builtin / no-override.
  if (pointer.kind === 'corrupt' || pointer.kind === 'unknown') return 'current-corrupt'
  if (override.kind === 'corrupt' || override.kind === 'unknown') return 'override-corrupt'
  return null
}

/** The policy dimensions that differ between runStartupPhase (A) and
 *  runDelayedRollback (B), plus the explicit A-only applied-override reachability. */
export interface VerdictPolicy {
  readonly allowBuiltin: boolean
  readonly pendingOnRetain: 'target' | 'current'
  readonly mismatch: 'report' | 'fatal'
  readonly clearJournalWhenApplied: boolean
  readonly clearInvalidationOnBuiltinRollback: boolean
  /** Applied-override commit is A-only: B's verdict input always comes from a
   *  rollback-needed journal whose continuation can only settle rolled-back/failed,
   *  so the shared 'applied' clause is unreachable from B — declared, not assumed. */
  readonly commitAppliedOverride: boolean
}

/** Everything the verdict commit reads; hosts pre-check corrupt journal/override
 *  states and pass only valid-or-null records. */
export interface VerdictInput {
  readonly shellVersion: string
  readonly applyOutcome: ApplyOutcome
  readonly journal: ActivationJournal | null
  readonly queuedIntent: ActivationJournalIntent | null
  readonly current: OverrideRecord | null
  readonly targetVersion: string
  readonly targetIsBuiltin: boolean
  readonly intentKind: ActivationIntentKind
}

/** Declarative result of one verdict commit; shells map it onto StartupResult (A) or
 *  ApplyOutcome (B). */
export interface VerdictCommit {
  readonly override: OverrideRecord | null
  readonly deleteOverride: boolean
  readonly journalAction: 'convert' | 'clear' | 'keep' | 'none'
  readonly mismatch: boolean
  readonly failOutcome?: ApplyOutcome
}

export const STARTUP_VERDICT_POLICY: VerdictPolicy = {
  allowBuiltin: true,
  pendingOnRetain: 'target',
  mismatch: 'report',
  clearJournalWhenApplied: false,
  clearInvalidationOnBuiltinRollback: true,
  commitAppliedOverride: true,
}

export const DELAYED_ROLLBACK_VERDICT_POLICY: VerdictPolicy = {
  allowBuiltin: false,
  pendingOnRetain: 'current',
  mismatch: 'fatal',
  clearJournalWhenApplied: true,
  clearInvalidationOnBuiltinRollback: false,
  commitAppliedOverride: false,
}

/**
 * Pure commit of one apply verdict: all override/journal mutations live here and only
 * the policy dimensions that actually differ between the two entries stay
 * parameterized (see VerdictPolicy.commitAppliedOverride).
 */
export function commitApplyVerdict(input: VerdictInput, policy: VerdictPolicy): VerdictCommit {
  const {
    applyOutcome, journal, queuedIntent, current, targetVersion, targetIsBuiltin, intentKind,
  } = input

  if (targetIsBuiltin && !policy.allowBuiltin) {
    return {
      override: null,
      deleteOverride: false,
      journalAction: 'keep',
      mismatch: false,
      failOutcome: {
        ...applyOutcome,
        status: 'failed',
        retainPending: true,
        runtimeBlocked: true,
        failureKind: 'journal',
        error: 'builtin runtime is not an F7 override target',
      },
    }
  }

  const resetBuiltinApplied = targetIsBuiltin
    && intentKind === 'reset-builtin'
    && applyOutcome.status === 'applied'

  // The applied-override commit is the A-only policy dimension: B's journal is always
  // rollback-needed, so its outcome can never be 'applied'.
  const commitsAppliedOverride = policy.commitAppliedOverride && applyOutcome.status === 'applied'

  let override: OverrideRecord | null = null
  let deleteOverride = false
  if (resetBuiltinApplied) {
    deleteOverride = true
  } else if (current !== null) {
    const next: OverrideRecord = {
      ...current,
      pending: queuedIntent !== null && !queuedIntent.targetIsBuiltin
        ? current.pending
        : targetIsBuiltin
          ? current.pending
          : applyOutcome.retainPending
            ? policy.pendingOnRetain === 'target' ? targetVersion : current.pending
            : null,
      swapAttempted: applyOutcome.retryAction === 'apply' && applyOutcome.status === 'failed',
      lastOutcome: applyOutcome.status,
      lastError: applyOutcome.error,
      restoreOutcome: applyOutcome.restoreOutcome,
    }
    if (!targetIsBuiltin && commitsAppliedOverride) {
      next.chosenVersion = targetVersion
      next.resolvedVersion = targetVersion
      next.swapAttempted = false
    } else if (targetIsBuiltin && commitsAppliedOverride) {
      // shell-invalidation preserves the historical selection; reset-builtin took the
      // deleteOverride branch above.
      next.invalidatedAt = current.invalidatedAt ?? new Date().toISOString()
      next.invalidatedReason = current.invalidatedReason ?? 'shell-version-changed'
      next.lastInvalidatedAt = current.lastInvalidatedAt ?? next.invalidatedAt
      next.lastInvalidatedReason = current.lastInvalidatedReason ?? next.invalidatedReason
      next.lastInvalidatedFromVersion = current.lastInvalidatedFromVersion
        ?? current.resolvedVersion
        ?? current.chosenVersion
      next.lastInvalidationRecovered = false
      next.swapAttempted = false
    } else if (applyOutcome.status === 'rolled-back' && applyOutcome.rollbackTarget !== null) {
      next.chosenVersion = applyOutcome.rollbackTarget
      next.resolvedVersion = applyOutcome.rollbackTarget
    }
    if (policy.clearInvalidationOnBuiltinRollback
      && targetIsBuiltin
      && applyOutcome.status === 'rolled-back'
      && applyOutcome.rollbackTarget !== null) {
      // The startup-time current pointer is the only authoritative old override;
      // reactivation clears persisted invalidation, not history.
      next.shellVersion = input.shellVersion
      next.invalidatedAt = null
      next.invalidatedReason = null
      next.lastInvalidatedAt = current.lastInvalidatedAt ?? current.invalidatedAt ?? new Date().toISOString()
      next.lastInvalidatedReason = current.lastInvalidatedReason
        ?? current.invalidatedReason
        ?? 'shell-version-changed'
      next.lastInvalidatedFromVersion = current.lastInvalidatedFromVersion
        ?? current.resolvedVersion
        ?? current.chosenVersion
      next.lastInvalidationRecovered = true
      next.pending = null
      next.chosenVersion = applyOutcome.rollbackTarget
      next.resolvedVersion = applyOutcome.rollbackTarget
      next.swapAttempted = false
    }
    override = next
  }

  const monitoringRetained = !policy.clearJournalWhenApplied
    && applyOutcome.status === 'applied'
    && !targetIsBuiltin
  let journalAction: VerdictCommit['journalAction'] = 'none'
  let mismatch = false
  let failOutcome: ApplyOutcome | undefined
  if (reachedSafeFallback(applyOutcome) && journal !== null && queuedIntent !== null) {
    if (queuedIntent.targetIsBuiltin || current?.pending === queuedIntent.targetVersion) {
      journalAction = 'convert'
    } else if (current?.pending == null) {
      journalAction = 'clear'
    } else {
      // A different pending cannot be attributed to this journal.
      mismatch = true
      journalAction = 'keep'
      if (policy.mismatch === 'fatal') {
        failOutcome = {
          ...applyOutcome,
          status: 'failed',
          retainPending: true,
          runtimeBlocked: true,
          failureKind: 'journal',
          error: 'F7 queued intent 与 override.pending 不一致；已安全回退但拒绝继续选择',
        }
      }
    }
  } else if (!applyOutcome.retainPending && !monitoringRetained && queuedIntent === null) {
    journalAction = 'clear'
  }

  return {
    override: deleteOverride ? null : override,
    deleteOverride,
    journalAction,
    mismatch,
    ...(failOutcome === undefined ? {} : { failOutcome }),
  }
}

/**
 * Execute recovery and, when safe, exactly one pending/builtin activation. A
 * pre-aborted `signal` cancels at the apply entry with zero side effects and leaves
 * the durable journal for the next startup to resume idempotently.
 */
export async function runStartupPhase(deps: StartupDeps, signal?: AbortSignal): Promise<StartupResult> {
  // Read recovery metadata before cleanup/eviction; the store also protects every
  // journal version, including the fail-closed corrupt state.
  let journalState = deps.readActivationJournal()
  let pointerState = deps.readCurrentPointerState()
  let overrideState = deps.readOverrideState()
  const initialMetadataError = corruptMetadataReason(journalState, pointerState, overrideState)
  if (initialMetadataError !== null) {
    // A data restore marker is independently authoritative and may still be completed,
    // but cleanup/eviction and every spawn path stay closed while selection metadata
    // is unreadable.
    const restored = await deps.completeInterruptedRestore()
    if (restored === 'half' || restored === 'incomplete') {
      return resultBase(restored, restored === 'half' ? 'restore-half' : 'restore-incomplete', [], [])
    }
    // An environment override is an external highest-priority selection: corrupt
    // dormant metadata blocks every chamber mutation but cannot shadow a valid env
    // launch after an authoritative restore marker has been completed.
    if (deps.envOverrideActive?.() === true) {
      return resultBase(restored, 'env-override', [], [])
    }
    return resultBase(restored, initialMetadataError, [], [])
  }
  const cleanedWorkDirs = deps.cleanupStaleInstalls()
  const evicted = deps.evict()
  const restored = await deps.completeInterruptedRestore()
  if (restored === 'half' || restored === 'incomplete') {
    return resultBase(
      restored,
      restored === 'half' ? 'restore-half' : 'restore-incomplete',
      cleanedWorkDirs,
      evicted,
    )
  }

  journalState = deps.readActivationJournal()
  pointerState = deps.readCurrentPointerState()
  overrideState = deps.readOverrideState()
  const metadataError = corruptMetadataReason(journalState, pointerState, overrideState)
  if (metadataError !== null) {
    return resultBase(restored, metadataError, cleanedWorkDirs, evicted)
  }
  if (restored === 'complete' && journalState.kind === 'valid') {
    const resumed = resumedRestorePhase(journalState.journal)
    if (resumed !== null) {
      try {
        deps.writeActivationJournal(resumed)
        journalState = { kind: 'valid', journal: resumed }
      } catch {
        return resultBase(restored, 'journal-corrupt', cleanedWorkDirs, evicted)
      }
    }
  }

  const override = overrideState.kind === 'valid' ? overrideState.record : null
  // Keep the replay gate identical to controller/resolve semantics: an old-shell pending
  // is invalid even when an interrupted invalidation has not populated invalidatedAt yet.
  const effectivePending = readEffectivePending(override, deps.shellVersion)

  // Env wins over every persisted choice; no pointer/snapshot/probe may masquerade as
  // applying pending.
  if (deps.envOverrideActive?.() === true) {
    const monitoring = journalState.kind === 'valid' && journalState.journal.phase === 'applied-monitoring'
      ? journalState.journal
      : null
    return resultBase(restored, 'env-override', cleanedWorkDirs, evicted, monitoring)
  }

  let journal = journalState.kind === 'valid' ? journalState.journal : null
  if (journal?.phase === 'applied-monitoring') {
    const queued = journal.nextIntent
    const expectedPointer = journal.targetIsBuiltin ? null : journal.targetVersion
    if (pointerVersion(pointerState) !== expectedPointer) {
      return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted, journal)
    }
    if (queued === null) {
      if (!journal.targetIsBuiltin && override?.pending === journal.targetVersion) {
        // Crash window: apply durably recorded the probe verdict but died before the
        // single override write that clears pending; re-applying would snapshot the
        // target again and could erase delayed-rollback evidence.
        deps.writeOverride({
          ...override,
          chosenVersion: journal.targetVersion,
          resolvedVersion: journal.targetVersion,
          pending: null,
          swapAttempted: false,
          lastOutcome: 'applied',
          lastError: null,
          restoreOutcome: 'none',
        })
        return resultBase(restored, null, cleanedWorkDirs, evicted, journal)
      }

      if (journal.targetIsBuiltin) {
        if (journal.intentKind === 'version-switch') {
          return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted, journal)
        }
        // Builtin is not restart-exhausted monitored; finish the override verdict
        // (including an interrupted invalidation) before dropping the journal.
        if (journal.intentKind === 'reset-builtin') {
          deps.deleteOverride()
        } else {
          if (override === null) {
            return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted, journal)
          }
          deps.writeOverride({
            ...override,
            swapAttempted: false,
            invalidatedAt: override.invalidatedAt ?? new Date().toISOString(),
            invalidatedReason: override.invalidatedReason ?? 'shell-version-changed',
            lastInvalidatedAt: override.lastInvalidatedAt ?? override.invalidatedAt ?? new Date().toISOString(),
            lastInvalidatedReason: override.lastInvalidatedReason ?? override.invalidatedReason ?? 'shell-version-changed',
            lastInvalidatedFromVersion: override.lastInvalidatedFromVersion
              ?? override.resolvedVersion
              ?? override.chosenVersion,
            lastInvalidationRecovered: false,
            lastOutcome: 'applied',
            lastError: null,
            restoreOutcome: 'none',
          })
        }
        safeClearJournal(deps)
        return resultBase(restored, null, cleanedWorkDirs, evicted)
      }

      if (effectivePending === null) {
        // Normal post-commit boot: keep the durable restart-exhausted context until
        // another selection/reset/rollback supersedes it.
        return resultBase(restored, null, cleanedWorkDirs, evicted, journal)
      }
      return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted, journal)
    }

    if (queued !== null && !queued.targetIsBuiltin && effectivePending === null) {
      // Controller committed the intent but failed before override.pending; drop only
      // the uncommitted next intent.
      const monitoring = { ...journal, nextIntent: null, updatedAt: new Date().toISOString() }
      deps.writeActivationJournal(monitoring)
      return resultBase(restored, null, cleanedWorkDirs, evicted, monitoring)
    }
    const intent = queued
    if (!intent.targetIsBuiltin && effectivePending !== intent.targetVersion) {
      return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted, journal)
    }
    journal = convertMonitoringToIntent(journal, intent)
    deps.writeActivationJournal(journal)
  }

  if (journal?.phase === 'intent') {
    if (journal.targetIsBuiltin && journal.intentKind === 'shell-invalidation' && override === null) {
      return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted)
    }
    if (!journal.targetIsBuiltin && effectivePending === null) {
      // Controller intent was published but override.pending was not; no pointer was
      // touched, so this orphan is safe to discard.
      safeClearJournal(deps)
      return resultBase(restored, null, cleanedWorkDirs, evicted)
    }
    if (!journal.targetIsBuiltin && effectivePending !== journal.targetVersion) {
      return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted)
    }
  }

  const overrideInvalidated = override !== null
    && (override.invalidatedAt != null || override.shellVersion !== deps.shellVersion)
  const journalIsRollbackContinuation = journal !== null && ROLLBACK_CONTINUATION_PHASES.has(journal.phase)
  if (overrideInvalidated
    && journal?.intentKind === 'version-switch'
    && !journalIsRollbackContinuation) {
    // An app update invalidates override and pending; a pre-verdict old-shell
    // transaction may already have touched the pointer, so leave its evidence and block.
    return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted,
      journal.phase === 'applied-monitoring' ? journal : null)
  }

  if (journal !== null && effectivePending !== null && !journal.targetIsBuiltin) {
    const expectedPending = journal.nextIntent !== null && !journal.nextIntent.targetIsBuiltin
      ? journal.nextIntent.targetVersion
      : journal.targetVersion
    if (expectedPending !== effectivePending) {
      return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted,
        journal.phase === 'applied-monitoring' ? journal : null)
    }
  }

  const recoveryInFlight = journal !== null && journal.phase !== 'intent' && journal.phase !== 'applied-monitoring'
  if (!recoveryInFlight && journal === null && effectivePending === null) {
    return resultBase(restored, null, cleanedWorkDirs, evicted)
  }

  // If current already equals pending but the pre-swap journal is missing,
  // re-snapshotting could capture data already migrated by the target.
  if (journal === null && effectivePending !== null && pointerVersion(pointerState) === effectivePending) {
    return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted)
  }

  const targetVersion = journal?.targetVersion ?? effectivePending
  if (targetVersion === null) return resultBase(restored, 'journal-mismatch', cleanedWorkDirs, evicted)
  const targetIsBuiltin = journal?.targetIsBuiltin ?? false
  const intentKind = journal?.intentKind ?? 'version-switch'

  // Explicit retry clears swapAttempted/lastOutcome before entry; restore phases always
  // continue, while an operational pointer/stop failure is not repeated on every launch.
  const restoreRecovery = journal?.phase === 'restoring'
    || journal?.phase === 'restore-complete'
    || journal?.phase === 'manual-restoring'
    || journal?.phase === 'manual-restored'
  if (!restoreRecovery && override !== null) {
    if (override.lastOutcome === 'snapshot-failed') {
      return resultBase(restored, 'snapshot-failed', cleanedWorkDirs, evicted)
    }
    if (override.swapAttempted) {
      return resultBase(restored, 'swap-attempted', cleanedWorkDirs, evicted)
    }
  }

  const facts: StartupActivationFacts = journal !== null && journal.phase !== 'intent'
    ? activationFactsFromJournal(journal)
    : deps.activationFacts()

  const applyOutcome = await applyPendingVersion({
    pendingVersion: targetVersion,
    builtinVersion: deps.builtinVersion,
    targetIsBuiltin,
    intentKind: journal?.intentKind ?? 'version-switch',
    sourceVersion: facts.sourceVersion,
    sourceIsBuiltin: facts.sourceIsBuiltin,
    sourceWasKnownGood: facts.sourceWasKnownGood,
    knownGoodVersion: facts.knownGoodVersion,
    journal,
    manualRollback: journal?.manualRollback ?? false,
    signal,
    deps: {
      snapshot: deps.snapshot,
      resolveSnapshotName: deps.resolveSnapshotName,
      prepareManualRollback: deps.prepareManualRollback,
      readCurrentPointerState: deps.readCurrentPointerState,
      validateTarget: deps.validateTarget,
      switchPointer: deps.switchPointer,
      probe: deps.spawnAndProbe,
      probeExpectedNames: deps.probeExpectedNames,
      stopHost: deps.stopHost,
      restore: deps.restore,
      recordProbePass: deps.recordProbePass,
      readActivationJournal: deps.readActivationJournal,
      writeActivationJournal: deps.writeActivationJournal,
      waitBeforeRetry: deps.waitBeforeRetry,
    },
  })

  const verdictJournalState = deps.readActivationJournal()
  if (verdictJournalState.kind === 'corrupt') {
    return {
      applyOutcome,
      restored,
      blockedReason: 'journal-corrupt',
      cleanedWorkDirs,
      evicted,
      monitoringJournal: null,
    }
  }
  const verdictJournal = verdictJournalState.kind === 'valid' ? verdictJournalState.journal : null
  const queuedIntent = verdictJournal?.nextIntent ?? null
  const currentState = deps.readOverrideState()
  if (currentState.kind === 'corrupt' || currentState.kind === 'unknown') {
    return {
      applyOutcome,
      restored,
      blockedReason: 'override-corrupt',
      cleanedWorkDirs,
      evicted,
      monitoringJournal: null,
    }
  }
  const current = currentState.kind === 'valid' ? currentState.record : null
  const commit = commitApplyVerdict({
    shellVersion: deps.shellVersion,
    applyOutcome,
    journal: verdictJournal,
    queuedIntent,
    current,
    targetVersion,
    targetIsBuiltin,
    intentKind,
  }, STARTUP_VERDICT_POLICY)
  if (commit.deleteOverride) deps.deleteOverride()
  else if (commit.override !== null) deps.writeOverride(commit.override)
  if (commit.journalAction === 'convert' && verdictJournal !== null && queuedIntent !== null) {
    // The delayed rollback may race with a user selection: only after the old activation
    // safely rolled back is the queued durable selection turned into a new transaction.
    deps.writeActivationJournal(convertMonitoringToIntent(verdictJournal, queuedIntent))
  } else if (commit.journalAction === 'clear') {
    // Intent commit gap or fully committed activation: only the pure verdict decides.
    safeClearJournal(deps)
  }
  const postApplyJournalMismatch = commit.mismatch

  if (applyOutcome.status !== 'applied') {
    try {
      deps.recordFailure({
        version: targetVersion,
        phase: applyOutcome.failureKind ?? applyOutcome.status,
        error: outcomeError(applyOutcome),
        restoreOutcome: applyOutcome.restoreOutcome,
        snapshotPath: applyOutcome.snapshotPath,
      })
    } catch {
      // Diagnostic persistence cannot rewrite the activation verdict.
    }
  }

  const latestJournal = deps.readActivationJournal()
  const monitoringJournal = latestJournal.kind === 'valid' && latestJournal.journal.phase === 'applied-monitoring'
    ? latestJournal.journal
    : null
  const blockedReason: StartupBlockedReason | null = latestJournal.kind === 'corrupt'
    ? 'journal-corrupt'
    : postApplyJournalMismatch
    ? 'journal-mismatch'
    : applyOutcome.status === 'snapshot-failed'
      ? 'snapshot-failed'
    : applyOutcome.runtimeBlocked && applyOutcome.restoreOutcome === 'half'
      ? 'restore-half'
      : applyOutcome.runtimeBlocked && applyOutcome.restoreOutcome === 'incomplete'
        ? 'restore-incomplete'
        : applyOutcome.retryAction === 'apply' && applyOutcome.status === 'failed'
          ? 'swap-attempted'
          : null

  return {
    applyOutcome,
    restored,
    blockedReason,
    cleanedWorkDirs,
    evicted,
    monitoringJournal,
  }
}

/**
 * Restart-exhausted entry. `beginDelayedRollback` durably changes the
 * applied-monitoring journal before any side effect; pending may already be null and
 * journal.targetVersion stays authoritative.
 */
export async function runDelayedRollback(
  deps: StartupDeps,
  monitoring: ActivationJournal,
  signal?: AbortSignal,
): Promise<ApplyOutcome> {
  if (deps.envOverrideActive?.() === true) throw new Error('env override active; persisted F7 rollback is deferred')
  const durableState = deps.readActivationJournal()
  if (durableState.kind !== 'valid' || durableState.journal.phase !== 'applied-monitoring') {
    throw new Error('F7 rollback requires a durable applied-monitoring journal')
  }
  if (durableState.journal.startedAt !== monitoring.startedAt
    || durableState.journal.targetVersion !== monitoring.targetVersion) {
    throw new Error('F7 monitoring handle is stale')
  }
  if (durableState.journal.targetIsBuiltin) throw new Error('builtin runtime is not an F7 override target')
  const pointer = deps.readCurrentPointerState()
  if (pointer.kind !== 'valid' || pointer.version !== durableState.journal.targetVersion) {
    throw new Error('F7 current pointer no longer matches the monitored activation')
  }
  const overridePrecheck = deps.readOverrideState()
  if (overridePrecheck.kind === 'corrupt' || overridePrecheck.kind === 'unknown') {
    throw new Error('override metadata 损坏或不可读；拒绝 F7 回退')
  }
  // Use the latest durable record, not the caller's possibly stale copy, so a
  // concurrently queued selection remains attached through rollback.
  const journal = beginDelayedRollback(durableState.journal, deps.writeActivationJournal)
  const targetVersion = journal.targetVersion
  const facts = activationFactsFromJournal(journal)
  const applyOutcome = await applyPendingVersion({
    pendingVersion: targetVersion,
    builtinVersion: deps.builtinVersion,
    targetIsBuiltin: journal.targetIsBuiltin,
    intentKind: journal.intentKind,
    ...facts,
    journal,
    signal,
    deps: {
      snapshot: deps.snapshot,
      resolveSnapshotName: deps.resolveSnapshotName,
      prepareManualRollback: deps.prepareManualRollback,
      readCurrentPointerState: deps.readCurrentPointerState,
      validateTarget: deps.validateTarget,
      switchPointer: deps.switchPointer,
      probe: deps.spawnAndProbe,
      probeExpectedNames: deps.probeExpectedNames,
      stopHost: deps.stopHost,
      restore: deps.restore,
      recordProbePass: deps.recordProbePass,
      readActivationJournal: deps.readActivationJournal,
      writeActivationJournal: deps.writeActivationJournal,
      waitBeforeRetry: deps.waitBeforeRetry,
    },
  })

  const verdictJournalState = deps.readActivationJournal()
  if (verdictJournalState.kind === 'corrupt') {
    return {
      ...applyOutcome,
      status: 'failed',
      retainPending: true,
      runtimeBlocked: true,
      failureKind: 'journal',
      error: 'F7 回退后 activation journal 损坏；拒绝提交裁决',
    }
  }
  const verdictJournal = verdictJournalState.kind === 'valid' ? verdictJournalState.journal : null
  const queuedIntent = verdictJournal?.nextIntent ?? null
  const currentState = deps.readOverrideState()
  if (currentState.kind === 'corrupt' || currentState.kind === 'unknown') {
    return {
      ...applyOutcome,
      status: 'failed',
      retainPending: true,
      runtimeBlocked: true,
      failureKind: 'journal',
      error: 'F7 回退后 override metadata 损坏或不可读；拒绝提交裁决',
    }
  }
  const current = currentState.kind === 'valid' ? currentState.record : null
  const commit = commitApplyVerdict({
    shellVersion: deps.shellVersion,
    applyOutcome,
    journal: verdictJournal,
    queuedIntent,
    current,
    targetVersion,
    targetIsBuiltin: journal.targetIsBuiltin,
    intentKind: journal.intentKind,
  }, DELAYED_ROLLBACK_VERDICT_POLICY)
  if (commit.deleteOverride) deps.deleteOverride()
  else if (commit.override !== null) deps.writeOverride(commit.override)
  if (commit.journalAction === 'convert' && verdictJournal !== null && queuedIntent !== null) {
    deps.writeActivationJournal(convertMonitoringToIntent(verdictJournal, queuedIntent))
  } else if (commit.journalAction === 'clear') {
    safeClearJournal(deps)
  }
  const finalOutcome = commit.failOutcome ?? applyOutcome
  try {
    deps.recordFailure({
      version: targetVersion,
      phase: 'restart-exhausted',
      error: outcomeError(finalOutcome),
      restoreOutcome: finalOutcome.restoreOutcome,
      snapshotPath: finalOutcome.snapshotPath,
    })
  } catch { /* diagnostic only */ }
  return finalOutcome
}
