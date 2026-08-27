/**
 * Design 18 activation transaction. The pre-swap snapshot and immutable
 * source facts are journaled before the current pointer is touched. Re-entry
 * resumes from that journal instead of creating a second, post-migration
 * snapshot.
 */
import { basename } from 'node:path'
import { decideVerdict, rollbackTarget } from './activation-gate.ts'
import type { ProbeResult } from './activation-gate.ts'
import type { ActivationIntentKind, ActivationJournal, ActivationJournalState, CurrentPointerState } from './dsh-runtime-store.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export interface ManualRollbackPreparation {
  snapshotPath: string | null
  stashPath: string | null
}

export interface ApplyDeps {
  snapshot: (sourceVersion: string) => Promise<string>
  resolveSnapshotName: (snapshotName: string) => Promise<string | null>
  prepareManualRollback: (targetVersion: string) => Promise<ManualRollbackPreparation>
  readCurrentPointerState: () => CurrentPointerState
  validateTarget: (version: string, isBuiltin: boolean) => { ok: true } | { ok: false; error: string }
  switchPointer: (version: string | null) => void
  probe: (version: string, isBuiltin: boolean) => Promise<ProbeResult[]>
  restore: (snapshotPath: string) => Promise<'complete' | 'half' | 'incomplete'>
  stopHost: () => Promise<void>
  waitBeforeRetry?: (delayMs: number) => Promise<void>
  recordProbePass: (version: string) => void
  readActivationJournal?: () => ActivationJournalState
  writeActivationJournal: (journal: ActivationJournal) => void
  now?: () => Date
  /** Monotonic millisecond clock for per-attempt probe-window accounting. */
  nowMs?: () => number
}

export type ApplyStatus = 'applied' | 'rolled-back' | 'failed' | 'snapshot-failed'
export type ApplyRetryAction = 'apply' | 'restore' | null
export type ApplyFailureKind =
  | 'snapshot'
  | 'journal'
  | 'target-invalid'
  | 'initial-switch'
  | 'manual-restore'
  | 'stop-host'
  | 'rollback-switch'
  | 'restore'
  | 'fallback'
  | 'terminal'
  | null

export interface ApplyOutcome {
  status: ApplyStatus
  snapshotPath: string | null
  rollbackTarget: string | null
  restoreOutcome: 'none' | 'complete' | 'half' | 'incomplete'
  swapAttempted: boolean
  error: string | null
  retainPending: boolean
  retryAction: ApplyRetryAction
  runtimeBlocked: boolean
  failureKind: ApplyFailureKind
}

export interface ApplyOptions {
  pendingVersion: string
  /** Exact manifest version of the packaged fallback tree. */
  builtinVersion: string
  targetIsBuiltin?: boolean
  intentKind?: ActivationIntentKind
  sourceVersion: string | null
  sourceIsBuiltin?: boolean
  sourceWasKnownGood?: boolean
  knownGoodVersion: string | null
  journal?: ActivationJournal | null
  manualRollback?: boolean
  retryDelayMs?: number
  deps: ApplyDeps
}

function errorText(error: unknown): string {
  return sanitizeErrorText(error instanceof Error ? error.message : String(error))
}

function currentPointer(deps: ApplyDeps): string | null {
  const state = deps.readCurrentPointerState()
  if (state.kind === 'corrupt') throw new Error('current pointer metadata 损坏；拒绝继续激活事务')
  return state.kind === 'valid' ? state.version : null
}

function makeOutcome(input: Partial<ApplyOutcome> & Pick<ApplyOutcome, 'status'>): ApplyOutcome {
  return {
    status: input.status,
    snapshotPath: input.snapshotPath ?? null,
    rollbackTarget: input.rollbackTarget ?? null,
    restoreOutcome: input.restoreOutcome ?? 'none',
    swapAttempted: input.swapAttempted ?? false,
    error: input.error ?? null,
    retainPending: input.retainPending ?? false,
    retryAction: input.retryAction ?? null,
    runtimeBlocked: input.runtimeBlocked ?? false,
    failureKind: input.failureKind ?? null,
  }
}

async function safeProbe(probe: () => Promise<ProbeResult[]>): Promise<ProbeResult[]> {
  try {
    return await probe()
  } catch (error) {
    return [{ name: 'probe', ok: false, error: errorText(error) }]
  }
}

function advance(
  journal: ActivationJournal,
  phase: ActivationJournal['phase'],
  deps: ApplyDeps,
  patch: Partial<ActivationJournal> = {},
): ActivationJournal {
  let next: ActivationJournal = {
    ...journal,
    ...patch,
    phase,
    updatedAt: (deps.now?.() ?? new Date()).toISOString(),
  }
  const latest = deps.readActivationJournal?.()
  if (latest?.kind === 'valid'
    && latest.journal.startedAt === journal.startedAt
    && latest.journal.targetVersion === journal.targetVersion
    && latest.journal.nextIntent !== null) {
    next = { ...next, nextIntent: latest.journal.nextIntent }
  }
  deps.writeActivationJournal(next)
  return next
}

/**
 * F7 seam: persist rollback intent before stop/pointer/restore. Main must call
 * this first on restart-exhausted, then pass the returned journal back through
 * applyPendingVersion; a crash at any later instruction resumes rollback.
 */
export function beginDelayedRollback(
  journal: ActivationJournal,
  writeJournal: (next: ActivationJournal) => void,
  now = new Date(),
): ActivationJournal {
  if (journal.phase !== 'applied-monitoring') throw new Error('F7 rollback requires applied-monitoring journal')
  const target = rollbackTarget({
    previousVersion: journal.sourceIsBuiltin ? null : journal.sourceVersion,
    previousWasKnownGood: journal.sourceWasKnownGood === true
      || journal.sourceVersion === journal.knownGoodVersion,
    knownGoodVersion: journal.knownGoodVersion,
  })
  const next: ActivationJournal = {
    ...journal,
    phase: 'rollback-needed',
    rollbackTarget: target,
    updatedAt: now.toISOString(),
  }
  writeJournal(next)
  return next
}

async function resolvePreSwap(journal: ActivationJournal, deps: ApplyDeps): Promise<string | null> {
  return journal.preSwapSnapshotName === null ? null : deps.resolveSnapshotName(journal.preSwapSnapshotName)
}

async function prepareJournal(opts: ApplyOptions): Promise<ActivationJournal | ApplyOutcome> {
  const { deps, pendingVersion, sourceVersion } = opts
  const existing = opts.journal ?? null
  if (existing !== null && existing.phase !== 'intent') return existing
  if (existing !== null && existing.targetVersion !== pendingVersion) {
    return makeOutcome({
      status: 'failed', retainPending: true, runtimeBlocked: true,
      failureKind: 'journal', error: 'activation journal target 与 pending 不一致',
    })
  }
  const targetIsBuiltin = existing?.targetIsBuiltin ?? opts.targetIsBuiltin === true
  const intentKind = existing?.intentKind ?? opts.intentKind ?? 'version-switch'
  const manualRollback = existing?.manualRollback ?? opts.manualRollback === true
  const validIntent = intentKind === 'version-switch'
    ? !targetIsBuiltin
    : targetIsBuiltin && !manualRollback
  if (!validIntent) {
    return makeOutcome({
      status: 'failed', retainPending: true, runtimeBlocked: true,
      failureKind: 'journal', error: 'activation intent kind 与 target 不一致',
    })
  }
  if (targetIsBuiltin && pendingVersion !== opts.builtinVersion) {
    return makeOutcome({
      status: 'failed', retainPending: true, runtimeBlocked: true,
      failureKind: 'journal', error: 'builtin activation target 与 packaged manifest version 不一致',
    })
  }
  const targetValidation = deps.validateTarget(pendingVersion, targetIsBuiltin)
  if (!targetValidation.ok) {
    return makeOutcome({
      status: 'failed', retainPending: true, retryAction: 'apply', runtimeBlocked: false,
      failureKind: 'target-invalid', error: `待应用运行时树无效：${targetValidation.error}`,
    })
  }
  if (sourceVersion === null) {
    return makeOutcome({
      status: 'snapshot-failed', retainPending: true, retryAction: 'apply', runtimeBlocked: false,
      failureKind: 'snapshot', error: '无法确定切换前运行时版本；未触碰指针',
    })
  }

  let preSwapSnapshot: string
  let manual: ManualRollbackPreparation = { snapshotPath: null, stashPath: null }
  if (targetIsBuiltin && manualRollback) {
    return makeOutcome({
      status: 'failed', retainPending: true, runtimeBlocked: false,
      failureKind: 'journal', error: 'builtin fallback 不能同时标记 manualRollback',
    })
  }
  try {
    preSwapSnapshot = await deps.snapshot(sourceVersion)
    if (manualRollback) manual = await deps.prepareManualRollback(pendingVersion)
  } catch (error) {
    return makeOutcome({
      status: 'snapshot-failed', retainPending: true, retryAction: 'apply', runtimeBlocked: false,
      failureKind: 'snapshot', error: errorText(error),
    })
  }

  const now = deps.now?.() ?? new Date()
  const prepared: ActivationJournal = {
    schemaVersion: 1,
    phase: 'prepared',
    targetVersion: pendingVersion,
    targetIsBuiltin,
    manualRollback,
    intentKind,
    sourceVersion,
    sourceIsBuiltin: opts.sourceIsBuiltin === true,
    sourceWasKnownGood: opts.sourceWasKnownGood === true,
    knownGoodVersion: opts.knownGoodVersion,
    preSwapSnapshotName: basename(preSwapSnapshot),
    manualDataSnapshotName: manual.snapshotPath === null ? null : basename(manual.snapshotPath),
    preRollbackStashName: manual.stashPath === null ? null : basename(manual.stashPath),
    rollbackTarget: null,
    nextIntent: null,
    startedAt: existing?.startedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  }
  try {
    const latest = deps.readActivationJournal?.()
    const durablePrepared: ActivationJournal = latest?.kind === 'valid'
      && latest.journal.startedAt === prepared.startedAt
      && latest.journal.targetVersion === prepared.targetVersion
      && latest.journal.nextIntent !== null
      ? { ...prepared, nextIntent: latest.journal.nextIntent }
      : prepared
    deps.writeActivationJournal(durablePrepared)
    return durablePrepared
  } catch (error) {
    return makeOutcome({
      status: 'snapshot-failed', snapshotPath: preSwapSnapshot, retainPending: true,
      retryAction: 'apply', runtimeBlocked: false, failureKind: 'journal',
      error: `无法持久化激活事务；未触碰指针：${errorText(error)}`,
    })
  }
}

async function delayedVerdict(opts: ApplyOptions): Promise<'pass' | 'fail'> {
  const nowMs = opts.deps.nowMs ?? Date.now
  const firstStartedAt = nowMs()
  const probeTarget = () => opts.deps.probe(opts.pendingVersion, opts.targetIsBuiltin === true)
  let verdict = decideVerdict(await safeProbe(probeTarget), {
    elapsedMs: nowMs() - firstStartedAt,
    observedOnce: false,
  })
  if (verdict === 'observe') {
    const wait = opts.deps.waitBeforeRetry ?? (delayMs => new Promise<void>(resolve => setTimeout(resolve, delayMs)))
    await wait(opts.retryDelayMs ?? 2_000)
    // The design's timeout bounds one probe attempt. Do not charge the first
    // timeout or observation delay to a healthy confirmation attempt.
    const secondStartedAt = nowMs()
    verdict = decideVerdict(await safeProbe(probeTarget), {
      elapsedMs: nowMs() - secondStartedAt,
      observedOnce: true,
    })
  }
  return verdict === 'pass' ? 'pass' : 'fail'
}

async function restoreJournalSnapshot(
  snapshotName: string | null,
  deps: ApplyDeps,
): Promise<{ path: string | null; restoreOutcome: 'complete' | 'half' | 'incomplete'; error: string | null }> {
  if (snapshotName === null) return { path: null, restoreOutcome: 'incomplete', error: 'journal snapshot 缺失' }
  const snapshotPath = await deps.resolveSnapshotName(snapshotName)
  if (snapshotPath === null) return { path: null, restoreOutcome: 'incomplete', error: `journal snapshot ${snapshotName} 缺失或不可信` }
  try {
    return { path: snapshotPath, restoreOutcome: await deps.restore(snapshotPath), error: null }
  } catch (error) {
    return { path: snapshotPath, restoreOutcome: 'half', error: errorText(error) }
  }
}

async function continueRollback(opts: ApplyOptions, initial: ActivationJournal): Promise<ApplyOutcome> {
  const { deps } = opts
  let journal = initial
  const preSwapPath = await resolvePreSwap(journal, deps)
  if (preSwapPath === null) {
    return makeOutcome({
      status: 'failed', retainPending: true, runtimeBlocked: true, retryAction: 'restore',
      failureKind: 'journal', rollbackTarget: journal.rollbackTarget,
      error: 'pre-swap snapshot 缺失；拒绝继续回退',
    })
  }

  if (journal.phase === 'rollback-needed'
    || journal.phase === 'restoring'
    || journal.phase === 'restore-complete') {
    const fallbackVersion = journal.rollbackTarget ?? opts.builtinVersion
    const fallbackValidation = deps.validateTarget(fallbackVersion, journal.rollbackTarget === null)
    if (!fallbackValidation.ok) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, rollbackTarget: journal.rollbackTarget,
        retainPending: true, retryAction: 'apply', runtimeBlocked: true, swapAttempted: true,
        failureKind: 'target-invalid', error: `回退运行时树无效：${fallbackValidation.error}`,
      })
    }
  }

  if (journal.phase === 'rollback-needed') {
    try {
      await deps.stopHost()
    } catch (error) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, rollbackTarget: journal.rollbackTarget,
        retainPending: true, retryAction: 'apply', runtimeBlocked: true, swapAttempted: true,
        failureKind: 'stop-host', error: `无法停止失败运行时；未触碰数据：${errorText(error)}`,
      })
    }
    try {
      deps.switchPointer(journal.rollbackTarget)
    } catch (error) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, rollbackTarget: journal.rollbackTarget,
        retainPending: true, retryAction: 'apply', runtimeBlocked: true, swapAttempted: true,
        failureKind: 'rollback-switch', error: `回退指针切换失败（失败运行时已停止，数据未恢复）：${errorText(error)}`,
      })
    }
    try {
      journal = advance(journal, 'restoring', deps)
    } catch (error) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, rollbackTarget: journal.rollbackTarget,
        retainPending: true, retryAction: 'restore', runtimeBlocked: true, swapAttempted: true,
        failureKind: 'journal', error: `回退指针已切换但无法记录恢复相位：${errorText(error)}`,
      })
    }
  }

  if (journal.phase === 'restoring') {
    if (currentPointer(deps) !== journal.rollbackTarget) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, rollbackTarget: journal.rollbackTarget,
        retainPending: true, retryAction: 'restore', runtimeBlocked: true, swapAttempted: true,
        failureKind: 'journal', error: 'restoring journal 与 current rollback pointer 不一致',
      })
    }
    const restored = await restoreJournalSnapshot(journal.preSwapSnapshotName, deps)
    if (restored.restoreOutcome !== 'complete') {
      const message = restored.restoreOutcome === 'half'
        ? `数据恢复失败（现场 .old 保留，可重试恢复）：${restored.error ?? 'snapshot restore 未完成'}`
        : `数据恢复未完成（现场保留）：${restored.error ?? 'snapshot restore 未完成'}`
      return makeOutcome({
        status: 'rolled-back', snapshotPath: preSwapPath, rollbackTarget: journal.rollbackTarget,
        restoreOutcome: restored.restoreOutcome, retainPending: true, retryAction: 'restore',
        runtimeBlocked: true, swapAttempted: true, failureKind: 'restore', error: message,
      })
    }
    try {
      journal = advance(journal, 'restore-complete', deps)
    } catch (error) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, rollbackTarget: journal.rollbackTarget,
        restoreOutcome: 'complete', retainPending: true, retryAction: 'apply',
        runtimeBlocked: true, swapAttempted: true, failureKind: 'journal',
        error: `数据已恢复但无法记录完成相位：${errorText(error)}`,
      })
    }
  }

  if (journal.phase === 'restore-complete') {
    if (currentPointer(deps) !== journal.rollbackTarget) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, rollbackTarget: journal.rollbackTarget,
        restoreOutcome: 'complete', retainPending: true, retryAction: 'apply',
        runtimeBlocked: true, swapAttempted: true, failureKind: 'journal',
        error: 'restore-complete journal 与 current rollback pointer 不一致',
      })
    }
    const fallbackVersion = journal.rollbackTarget ?? opts.builtinVersion
    const fallbackVerdict = decideVerdict(
      await safeProbe(() => deps.probe(fallbackVersion, journal.rollbackTarget === null)),
      { elapsedMs: 0, observedOnce: true },
    )
    if (fallbackVerdict === 'pass') {
      return makeOutcome({
        status: 'rolled-back', snapshotPath: preSwapPath, rollbackTarget: journal.rollbackTarget,
        restoreOutcome: 'complete', swapAttempted: true,
      })
    }
    if (journal.rollbackTarget === null) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, restoreOutcome: 'complete', swapAttempted: true,
        runtimeBlocked: true, failureKind: 'terminal', error: '内建回退运行时探针失败',
      })
    }
    try {
      journal = advance(journal, 'fallback-builtin', deps, { rollbackTarget: null })
    } catch (error) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, restoreOutcome: 'complete', retainPending: true,
        retryAction: 'apply', runtimeBlocked: true, swapAttempted: true, failureKind: 'journal',
        error: `回退目标失败且无法记录内建降级：${errorText(error)}`,
      })
    }
  }

  if (journal.phase === 'fallback-builtin') {
    const builtinValidation = deps.validateTarget(opts.builtinVersion, true)
    if (!builtinValidation.ok) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, restoreOutcome: 'complete', retainPending: true,
        retryAction: 'apply', runtimeBlocked: true, swapAttempted: true, failureKind: 'target-invalid',
        error: `内建回退树无效：${builtinValidation.error}`,
      })
    }
    try {
      await deps.stopHost()
      deps.switchPointer(null)
    } catch (error) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, restoreOutcome: 'complete', retainPending: true,
        retryAction: 'apply', runtimeBlocked: true, swapAttempted: true, failureKind: 'fallback',
        error: `回退目标失败，落内建运行时也失败：${errorText(error)}`,
      })
    }
    const builtinVerdict = decideVerdict(
      await safeProbe(() => deps.probe(opts.builtinVersion, true)),
      { elapsedMs: 0, observedOnce: true },
    )
    return makeOutcome({
      status: 'failed', snapshotPath: preSwapPath, restoreOutcome: 'complete', swapAttempted: true,
      retainPending: builtinVerdict !== 'pass',
      retryAction: builtinVerdict !== 'pass' ? 'apply' : null,
      runtimeBlocked: builtinVerdict !== 'pass', failureKind: 'terminal',
      error: builtinVerdict === 'pass'
        ? '可信回退目标探针失败，已落内建运行时'
        : '可信回退目标与内建运行时探针均失败',
    })
  }

  return makeOutcome({
    status: 'failed', snapshotPath: preSwapPath, retainPending: true, runtimeBlocked: true,
    retryAction: 'apply', failureKind: 'journal', error: `无法从 journal phase ${journal.phase} 继续回退`,
  })
}

async function runApplyTransaction(opts: ApplyOptions): Promise<ApplyOutcome> {
  const { deps, pendingVersion } = opts
  const prepared = await prepareJournal(opts)
  if (!('schemaVersion' in prepared)) return prepared
  let journal = prepared

  if (journal.targetVersion !== pendingVersion) {
    return makeOutcome({
      status: 'failed', retainPending: true, runtimeBlocked: true,
      failureKind: 'journal', error: 'activation journal target 与 pending 不一致',
    })
  }
  const preSwapPath = await resolvePreSwap(journal, deps)
  if (preSwapPath === null) {
    return makeOutcome({
      status: 'failed', retainPending: true, runtimeBlocked: journal.phase !== 'prepared',
      retryAction: journal.phase === 'prepared' ? 'apply' : 'restore',
      failureKind: 'journal', error: 'activation journal 的 pre-swap snapshot 缺失',
    })
  }

  if (journal.phase === 'rollback-needed'
    || journal.phase === 'restoring'
    || journal.phase === 'restore-complete'
    || journal.phase === 'fallback-builtin') {
    return continueRollback(opts, journal)
  }

  const targetValidation = deps.validateTarget(pendingVersion, journal.targetIsBuiltin)
  if (!targetValidation.ok) {
    const targetPointer = journal.targetIsBuiltin ? null : pendingVersion
    return makeOutcome({
      status: 'failed', retainPending: true, retryAction: 'apply', runtimeBlocked: currentPointer(deps) === targetPointer,
      failureKind: 'target-invalid', error: `待应用运行时树无效：${targetValidation.error}`,
    })
  }

  if (journal.phase === 'prepared') {
    const current = currentPointer(deps)
    const targetPointer = journal.targetIsBuiltin ? null : pendingVersion
    if (current !== targetPointer) {
      const expectedSourcePointer = journal.sourceIsBuiltin ? null : journal.sourceVersion
      if (current !== expectedSourcePointer) {
        return makeOutcome({
          status: 'failed', snapshotPath: preSwapPath, retainPending: true, runtimeBlocked: true,
          retryAction: 'apply', failureKind: 'journal',
          error: `current pointer 与 journal source 不一致（current=${current ?? 'builtin'}）`,
        })
      }
      try {
        deps.switchPointer(targetPointer)
      } catch (error) {
        return makeOutcome({
          status: 'failed', snapshotPath: preSwapPath, retainPending: true, retryAction: 'apply',
          runtimeBlocked: false, swapAttempted: true, failureKind: 'initial-switch',
          error: `switchPointer 失败：${errorText(error)}`,
        })
      }
    }
    try {
      journal = advance(journal, 'switched', deps)
    } catch (error) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, retainPending: true, retryAction: 'apply',
        runtimeBlocked: true, swapAttempted: current !== targetPointer,
        failureKind: 'journal', error: `指针已切换但无法持久化相位：${errorText(error)}`,
      })
    }
  }

  const targetPointer = journal.targetIsBuiltin ? null : pendingVersion
  if (journal.phase === 'switched' && currentPointer(deps) !== targetPointer) {
    return makeOutcome({
      status: 'failed', snapshotPath: preSwapPath, retainPending: true, retryAction: 'apply',
      runtimeBlocked: true, failureKind: 'journal', error: 'switched journal 与 current pointer 不一致',
    })
  }

  if (journal.phase === 'switched' && journal.manualDataSnapshotName !== null) {
    try {
      journal = advance(journal, 'manual-restoring', deps)
    } catch (error) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, retainPending: true, retryAction: 'restore',
        runtimeBlocked: true, swapAttempted: true, failureKind: 'journal',
        error: `无法记录手动回滚数据恢复相位：${errorText(error)}`,
      })
    }
  }

  if (journal.phase === 'manual-restoring') {
    if (currentPointer(deps) !== targetPointer) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, retainPending: true, retryAction: 'restore',
        runtimeBlocked: true, swapAttempted: true, failureKind: 'journal',
        error: 'manual-restoring journal 与 current target pointer 不一致',
      })
    }
    const restored = await restoreJournalSnapshot(journal.manualDataSnapshotName, deps)
    if (restored.restoreOutcome !== 'complete') {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, restoreOutcome: restored.restoreOutcome,
        retainPending: true, retryAction: 'restore', runtimeBlocked: true, swapAttempted: true,
        failureKind: 'manual-restore', error: restored.restoreOutcome === 'half'
          ? `目标版本数据恢复失败（现场 .old 保留）：${restored.error ?? 'snapshot restore 未完成'}`
          : `目标版本数据恢复未完成（现场保留）：${restored.error ?? 'snapshot restore 未完成'}`,
      })
    }
    try {
      journal = advance(journal, 'manual-restored', deps)
    } catch (error) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, restoreOutcome: 'complete', retainPending: true,
        retryAction: 'apply', runtimeBlocked: true, swapAttempted: true, failureKind: 'journal',
        error: `目标版本数据已恢复但无法记录相位：${errorText(error)}`,
      })
    }
  }

  if (journal.phase !== 'switched' && journal.phase !== 'manual-restored') {
    return makeOutcome({
      status: 'failed', snapshotPath: preSwapPath, retainPending: true, retryAction: 'apply',
      runtimeBlocked: true, failureKind: 'journal', error: `不支持的 activation journal phase: ${journal.phase}`,
    })
  }

  if (await delayedVerdict(opts) === 'pass') {
    if (!journal.targetIsBuiltin) {
      try { deps.recordProbePass(pendingVersion) } catch { /* best effort after actual validated probe */ }
    }
    try {
      journal = advance(journal, 'applied-monitoring', deps, { nextIntent: null })
    } catch (error) {
      return makeOutcome({
        status: 'failed', snapshotPath: preSwapPath, retainPending: true, retryAction: 'apply',
        runtimeBlocked: true, swapAttempted: true, failureKind: 'journal',
        error: `探针通过但无法持久化 F7 监控上下文：${errorText(error)}`,
      })
    }
    return makeOutcome({ status: 'applied', snapshotPath: preSwapPath, swapAttempted: true })
  }

  const target = rollbackTarget({
    previousVersion: journal.sourceIsBuiltin ? null : journal.sourceVersion,
    previousWasKnownGood: journal.sourceWasKnownGood === true
      || journal.sourceVersion === journal.knownGoodVersion,
    knownGoodVersion: journal.knownGoodVersion,
  })
  try {
    journal = advance(journal, 'rollback-needed', deps, { rollbackTarget: target })
  } catch (error) {
    return makeOutcome({
      status: 'failed', snapshotPath: preSwapPath, rollbackTarget: target, retainPending: true,
      retryAction: 'apply', runtimeBlocked: true, swapAttempted: true, failureKind: 'journal',
      error: `探针失败但无法持久化回退意图：${errorText(error)}`,
    })
  }
  return continueRollback(opts, journal)
}

export async function applyPendingVersion(opts: ApplyOptions): Promise<ApplyOutcome> {
  try {
    return await runApplyTransaction(opts)
  } catch (error) {
    return makeOutcome({
      status: 'failed', retainPending: true, runtimeBlocked: true,
      failureKind: 'journal', error: errorText(error),
    })
  }
}
