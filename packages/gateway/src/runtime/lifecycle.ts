/**
 * Gateway runtime lifecycle owner: store-prune consumption, known-good
 * observation/promotion, restart-exhausted automatic rollback, the restart/start
 * primitives and dispose (writer-epoch drain + ownership release).
 *
 * The module owns exactly three pieces of state — the known-good scheduler cancel
 * handle, the store-prune single flight and the dispose promise; every other input
 * is an explicit handle (write fence, workspace facts, startup driver, projection
 * setters, self-lease release hook).
 */
import {
  clearStorePruneRequest,
  disposeRuntimeInstaller,
  noteBoot,
  planRestartExhaustedRollback,
  promoteDueCandidates,
  pruneRuntimeStore,
  runStartupPhase,
  readActivationJournalState,
  readStorePruneRequest,
  removeKnownGoodCandidate,
  resetCandidateHealthWindow,
  sanitizeErrorText,
  writeActivationJournal,
} from '@dsh-chamber/dsh-runtime'
import type { Logger } from '@dsh-chamber/control-plane'
import {
  recoveryRetryRequiredRefusal,
  refusalError,
  startAlreadyInFlightRefusal,
  startNotApplicableRefusal,
} from '../runtime-refusals.ts'
import { sanitizeRouteError } from '../sanitize-route-error.ts'
import type { StartupTransactionRunner } from './startup-transaction.ts'
import type { RuntimeModuleContext } from './context.ts'

export interface RuntimeLifecycleDeps extends RuntimeModuleContext {
  logger: Logger
  nowMs: () => number
  assertMutationIdle(): void
  assertNoPending(): void
  getStartupBlockReason(): string | null
  getRestartOutcome(): 'ok' | 'failed' | 'running' | null
  getStartOutcome(): 'ok' | 'failed' | 'running' | null
  startup: StartupTransactionRunner
  pnpmEntry(): string
  scheduleKnownGoodPromotion?: ((callback: () => void) => () => void) | undefined
  rollbackLeaseWaitMs: number
  releaseSelfLease(): void
  hooks: {
    invalidateDiskCache(): void
    setOperationError(value: string | null): void
    setRestartOutcome(value: 'ok' | 'failed' | 'running' | null): void
    setStartOutcome(value: 'ok' | 'failed' | 'running' | null): void
  }
}

export interface RuntimeLifecycle {
  pruneStoreIfNeeded(): Promise<void>
  observeLocalState(status: string): void
  restart(): Promise<void>
  start(): Promise<void>
  dispose(): Promise<void>
}

export function createRuntimeLifecycle(deps: RuntimeLifecycleDeps): RuntimeLifecycle {
  const {
    plane,
    logger,
    platform,
    baseDir,
    envPath,
    nowMs,
    writeFence,
    facts,
    assertMutationIdle,
    assertNoPending,
    getStartupBlockReason,
    getRestartOutcome,
    getStartOutcome,
    startup,
    pnpmEntry,
    scheduleKnownGoodPromotion,
    rollbackLeaseWaitMs,
    releaseSelfLease,
  } = deps
  const { invalidateDiskCache, setOperationError, setRestartOutcome, setStartOutcome } = deps.hooks
  let disposePromise: Promise<void> | null = null
  /** Store-prune single flight: the durable marker is retained on failure. */
  let storePruneOperation: Promise<void> | null = null

  const runStorePruneIfNeeded = (): Promise<void> => {
    if (storePruneOperation !== null) return storePruneOperation
    if (writeFence.isDisposed() || readStorePruneRequest(baseDir) === null) return Promise.resolve()
    const operation = pruneRuntimeStore({
      baseDir,
      pnpmEntry: pnpmEntry(),
      deps: {
        // The gateway has no Electron-as-node branch: plain node.
        node: () => ({ file: process.execPath, args: [], env: {} }),
      },
    })
      .then(() => { clearStorePruneRequest(baseDir) })
      .catch((error: unknown) => {
        // Retain the marker: the next safe cleanup/startup retries; prune failure is disk hygiene, not permission to block a verified tree.
        logger.warn(`gateway runtime store prune failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`)
      })
      .finally(() => {
        if (storePruneOperation === operation) storePruneOperation = null
      })
    storePruneOperation = operation
    return operation
  }

  /**
   * Arm a synchronous latch, then join the manager's existing writer epoch before
   * re-reading every durable/host authority. The initial microtask matters:
   * restartLocal() can synchronously publish its terminal edge before the public
   * restart promise has reached trackOperation().
   */
  function scheduleRestartExhaustedRollback(): void {
    if (writeFence.isDisposed() || platform === 'win32' || envPath !== null || writeFence.isRestartExhaustedRollbackInFlight()
      || plane.connectionState !== 'restart-exhausted') return

    // Fast path: builtin/env restart exhaustion is a pure host-lifecycle fact with
    // no runtime mutation epoch, so skip the latch and the durable re-read.
    try {
      const observed = facts.resolveWorkspace()
      if (observed.source !== 'override' || observed.version === null) return
    } catch (error) {
      logger.warn(`gateway runtime restart-exhausted observation failed: ${sanitizeErrorText(String(error))}`)
      return
    }

    writeFence.setRestartExhaustedRollbackInFlight(true)
    let operation!: Promise<void>
    let rollbackDurablyLatched = false
    operation = (async () => {
      await Promise.resolve()

      // Drain all OTHER operations to a fixed point while the latch refuses new
      // mutations; exclude this operation to avoid a self-wait deadlock.
      await writeFence.drainOtherOperations(operation)

      // Authority may have changed while an accepted writer settled. F7 is legal
      // only for the still-active override at an authoritative restart-exhausted
      // terminal state; builtin/env never mutate metadata.
      if (writeFence.isDisposed() || writeFence.abortSignal.aborted || envPath !== null
        || plane.connectionState !== 'restart-exhausted') return
      const active = facts.resolveWorkspace()
      if (active.source !== 'override' || active.version === null) return

      // Rollback-vs-lease serialization: the transaction's restore step writes
      // DSH_HOME before the only lease-aware point (the spawn checkpoint inside
      // plane.startLocal), so a live plugin mutation under a held profile-write
      // lease must drain first. New leases cannot start while this latch is armed,
      // so only already-held leases are drained; one that outlives the bound DEFERS
      // the rollback with NO writes (the next restart-exhausted edge re-arms it),
      // and dispose aborts the wait so shutdown never stalls behind a lease.
      if (writeFence.profileWriteInFlight()) {
        const leaseOutcome = await writeFence.waitForProfileWriteIdle(rollbackLeaseWaitMs)
        if (writeFence.isDisposed() || writeFence.abortSignal.aborted) return
        if (leaseOutcome !== 'idle') {
          logger.error('plugin mutation lease held too long; restart-exhausted rollback deferred')
          return
        }
      }

      const failedVersion = active.version
      const plan = planRestartExhaustedRollback({
        restartExhausted: true,
        activeIsOverride: true,
        failedVersion,
        journalState: readActivationJournalState(baseDir),
        now: () => new Date(nowMs()),
      })
      if (plan.status === 'not-triggered') return

      if (plan.status === 'planned') {
        // Exactly-once/crash-recovery: this durable rollback-needed record MUST
        // precede candidate mutation, host stop, pointer switch or DSH_HOME restore.
        writeActivationJournal(baseDir, {
          ...plan.journal,
          nextIntent: plan.deferredIntent,
        })
      }
      // 'already-in-recovery' is itself durable proof; 'planned' reaches here only
      // after the write above. A failed F7 latch must not stop the host.
      rollbackDurablyLatched = true

      setRestartOutcome('failed')
      setOperationError(`dsh v${failedVersion} exhausted managed restarts; automatic rollback in progress`)

      let result: Awaited<ReturnType<typeof runStartupPhase>>
      writeFence.beginActivation()
      try {
        // A version that exhausted the authoritative host restart policy can no
        // longer earn known-good promotion, even if the restore needs an operator retry.
        removeKnownGoodCandidate(baseDir, failedVersion)
        result = await startup.executeStartupTransaction(writeFence.abortSignal)
      } finally {
        writeFence.endActivation()
        invalidateDiskCache()
      }

      if (result.applyOutcome === null) {
        setOperationError(sanitizeRouteError(
          `restart-exhausted rollback did not complete${result.blockedReason === null ? '' : `: ${result.blockedReason}`}`,
        ))
        return
      }

      setOperationError(sanitizeRouteError(
        result.applyOutcome.error
          ?? (result.applyOutcome.status === 'rolled-back'
            ? `dsh v${failedVersion} exhausted managed restarts and was automatically rolled back`
            : `restart-exhausted rollback ended with ${result.applyOutcome.status}`),
      ))

      // Probes may leave a process alive; re-sync host/exposure only after
      // quarantine closed. A dispose race permanently suppresses this start.
      if (!writeFence.isDisposed() && result.blockedReason === null) {
        await plane.startLocal()
        if (!writeFence.isDisposed()) plane.refreshLocalExposure()
      }
    })().catch(async (error) => {
      if (!writeFence.isDisposed()) {
        setOperationError(sanitizeRouteError(error instanceof Error ? error.message : String(error)))
        logger.error(`gateway runtime restart-exhausted rollback failed: ${sanitizeErrorText(String(error))}`)
        if (rollbackDurablyLatched) {
          try {
            await plane.stopLocal()
          } catch (stopError) {
            logger.warn(`gateway runtime restart-exhausted stop failed: ${sanitizeErrorText(String(stopError))}`)
          }
        }
      }
    }).finally(() => {
      writeFence.setRestartExhaustedRollbackInFlight(false)
    })
    writeFence.trackOperation(operation)
  }

  function observeLocalState(status: string): void {
    if (writeFence.isDisposed() || platform === 'win32' || writeFence.activationInProgress()) return
    if (status !== 'ready') {
      if (writeFence.healthWindowOpen()) {
        writeFence.closeHealthWindow()
        try {
          resetCandidateHealthWindow(baseDir, nowMs())
        } catch (error) {
          logger.warn(`gateway runtime known-good health reset failed: ${sanitizeErrorText(String(error))}`)
        }
      }
      if (status === 'restart-exhausted') scheduleRestartExhaustedRollback()
      return
    }
    if (writeFence.healthWindowOpen()) return
    writeFence.openHealthWindow()
    try {
      const active = facts.resolveWorkspace()
      if (active.source === 'override' && active.version !== null) {
        noteBoot(baseDir, active.version, nowMs())
        promoteDueCandidates(baseDir, nowMs())
      }
    } catch (error) {
      logger.warn(`gateway runtime known-good boot observation failed: ${sanitizeErrorText(String(error))}`)
    }
  }

  const runKnownGoodPromotion = () => {
    if (writeFence.isDisposed() || platform === 'win32' || !writeFence.healthWindowOpen() || !plane.localProcessAlive) return
    try {
      promoteDueCandidates(baseDir, nowMs())
    } catch (error) {
      logger.warn(`gateway runtime known-good promotion failed: ${sanitizeErrorText(String(error))}`)
    }
  }

  let cancelKnownGoodPromotion: () => void = () => {}
  try {
    if (platform !== 'win32') {
      cancelKnownGoodPromotion = scheduleKnownGoodPromotion !== undefined
        ? scheduleKnownGoodPromotion(runKnownGoodPromotion)
        : (() => {
            const timer = setInterval(runKnownGoodPromotion, 60 * 60 * 1_000)
            timer.unref()
            return () => { clearInterval(timer) }
          })()
    }
  } catch (error) {
    // A scheduler may retain the callback and then throw before returning its
    // cancel handle; fence this abandoned closure before releasing the self-lease.
    writeFence.markDisposed()
    writeFence.abortLifecycle()
    try {
      releaseSelfLease()
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], 'gateway runtime construction failed and the state-root lease could not be released')
    }
    throw error
  }

  async function restart(): Promise<void> {
    assertMutationIdle()
    assertNoPending()
    writeFence.setRestartInFlight(true)
    setRestartOutcome('running')
    // A fresh restart epoch supersedes any earlier start verdict.
    setStartOutcome(null)
    try {
      await plane.restartLocal()
      // CONTRACT: resolve ≠ success — restartLocal() also resolves from
      // restart-exhausted / error / stopped; project that honestly rather than a
      // false 'ok' (the settings poll must not show restarted for a non-ready run).
      const connectionState = plane.connectionState
      // Whitelist: every non-ready settle (restart-exhausted / error / stopped,
      // or an epoch bail while 'restarting' is live) is a failure; only
      // ready/degraded with a live process counts as success.
      if (connectionState !== 'ready' && connectionState !== 'degraded') {
        const message = `dsh restart did not reach ready (${connectionState})`
        setOperationError(message)
        setRestartOutcome('failed')
        throw new Error(message)
      }
      setOperationError(null)
      setRestartOutcome('ok')
    } catch (error) {
      if (getRestartOutcome() !== 'failed') {
        setOperationError(sanitizeRouteError(error instanceof Error ? error.message : String(error)))
        setRestartOutcome('failed')
      }
      throw error
    } finally {
      writeFence.setRestartInFlight(false)
    }
  }

  /**
   * Start primitive: bring the managed dsh up from stopped/error/restart-exhausted
   * through the plane's guarded startLocal path. Every synchronous refusal runs
   * BEFORE any plane effect: a start already in flight, any runtime mutation or
   * profile write (assertMutationIdle), a recovery block or ordinary pending (the
   * recovery gate is never bypassed), or a connection state outside the start
   * window. The outcome is projected via status().start / operationError
   * (resolve ≠ success: a resolve that did not reach ready is 'failed').
   */
  async function start(): Promise<void> {
    if (writeFence.isStartInFlight()) {
      // Same code/message as the route /start pre-gate.
      throw refusalError(startAlreadyInFlightRefusal())
    }
    assertMutationIdle()
    // Recovery gate: an in-memory startup block is the authoritative recovery
    // verdict — only its matching retry may run, and restore-builtin applies to
    // pending/healthy selections only. F7's auto-rollback tail and gateway-boot
    // blocks land here too, so a raw start cannot skip the probe/restore gate.
    const blockReason = getStartupBlockReason()
    if (blockReason !== null) {
      throw refusalError(recoveryRetryRequiredRefusal(blockReason))
    }
    // Durable ordinary pending: the armed switch is consumed by the startup transaction, not by a bare spawn.
    assertNoPending()
    const connectionState = plane.connectionState
    if (connectionState !== 'stopped' && connectionState !== 'error' && connectionState !== 'restart-exhausted') {
      // Same code/message as the route /start pre-gate.
      throw refusalError(startNotApplicableRefusal(connectionState))
    }
    writeFence.setStartInFlight(true)
    setStartOutcome('running')
    // A fresh start epoch supersedes any earlier restart verdict (e.g. an F7
    // 'failed' marker); the poll must not echo the old verdict mid-recovery.
    setRestartOutcome(null)
    try {
      await plane.startLocal()
      // CONTRACT (restart parity): resolve ≠ success — startLocal() resolves after
      // its spawn settles, but a concurrent stop/epoch bump can land on
      // stopped/error/restart-exhausted; only ready/degraded count as 'ok'.
      const reached = plane.connectionState
      if (reached !== 'ready' && reached !== 'degraded') {
        const message = `dsh start did not reach ready (${reached})`
        setOperationError(message)
        setStartOutcome('failed')
        throw new Error(message)
      }
      setOperationError(null)
      setStartOutcome('ok')
    } catch (error) {
      if (getStartOutcome() !== 'failed') {
        setOperationError(sanitizeRouteError(error instanceof Error ? error.message : String(error)))
        setStartOutcome('failed')
      }
      throw error
    } finally {
      writeFence.setStartInFlight(false)
    }
  }

  function dispose(): Promise<void> {
    if (disposePromise !== null) return disposePromise
    writeFence.markDisposed()
    writeFence.publishQuarantine(true)
    try {
      cancelKnownGoodPromotion()
    } catch (error) {
      // The callback itself is fenced by `disposed`, so a cancellation failure cannot
      // retain runtime writer authority or skip the abort/drain/final-stop proof.
      logger.warn(`gateway runtime known-good scheduler cancellation failed: ${sanitizeErrorText(String(error))}`)
    }
    writeFence.abortLifecycle()
    disposePromise = (async () => {
      // Epoch-fence any startLocal() waiting for readiness; the second stop below
      // is the final process-quiescence proof.
      try {
        await plane.stopLocal()
      } catch (error) {
        logger.warn(`gateway runtime initial stop failed during disposal: ${sanitizeErrorText(String(error))}`)
      }

      let installerError: unknown = null
      try {
        await disposeRuntimeInstaller()
      } catch (error) {
        installerError = error
        logger.warn(`gateway runtime installer disposal failed: ${sanitizeErrorText(String(error))}`)
      }

      await writeFence.drainOperations()

      // Abort can hand an already-started rollback probe a fresh signal: stop once
      // more after every writer settles so no recovery spawn survives ownership release.
      let finalStopError: unknown = null
      try {
        await plane.stopLocal()
      } catch (error) {
        finalStopError = error
      }

      if (installerError !== null || finalStopError !== null) {
        const reasons = [installerError, finalStopError].filter((error): error is {} => error !== null)
        throw new AggregateError(reasons, 'gateway runtime writers could not be proven quiescent; state-root lease retained')
      }

      // Only a directly constructed manager owns a lease; an adopted createGateway
      // handle belongs to the gateway, which releases it after this quiescence proof.
      releaseSelfLease()
    })()
    return disposePromise
  }

  return { pruneStoreIfNeeded: runStorePruneIfNeeded, observeLocalState, restart, start, dispose }
}
