/**
 * Gateway runtime lifecycle owner (design 18 §9.3, design 17 §4.1/§12):
 * store-prune consumption, known-good observation/promotion, the F7
 * restart-exhausted automatic rollback, the restart/start primitives and
 * dispose (writer-epoch drain + ownership release).
 *
 * The module owns exactly three pieces of state — the known-good scheduler
 * cancel handle, the store-prune single flight and the dispose promise. Every
 * other input is an explicit handle: the write fence, the workspace facts, the
 * startup-transaction driver, the projection setters and the self-lease
 * release hook.
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
        // The gateway has no Electron-as-node branch: plain node (design 18
        // §9.2: the gateway install chain is pure node).
        node: () => ({ file: process.execPath, args: [], env: {} }),
      },
    })
      .then(() => { clearStorePruneRequest(baseDir) })
      .catch((error: unknown) => {
        // Retain the marker: the next safe cleanup/startup retries. Prune
        // failure is disk hygiene, not permission to block a verified tree.
        logger.warn(`gateway runtime store prune failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`)
      })
      .finally(() => {
        if (storePruneOperation === operation) storePruneOperation = null
      })
    storePruneOperation = operation
    return operation
  }

  /**
   * Design 18 F7 is emitted by the control-plane restart loop, not by a
   * runtime route. Arm a synchronous latch, then join the manager's existing
   * writer epoch before re-reading every durable/host authority. The initial
   * microtask is intentional: restartLocal() can synchronously publish its
   * terminal edge before the public restart promise has reached
   * trackOperation().
   */
  function scheduleRestartExhaustedRollback(): void {
    if (writeFence.isDisposed() || platform === 'win32' || envPath !== null || writeFence.isRestartExhaustedRollbackInFlight()
      || plane.connectionState !== 'restart-exhausted') return

    // Fast-path non-triggering sources before arming the writer latch. The
    // durable state is still re-read after joining prior operations below;
    // this check only guarantees builtin/env restart exhaustion remains a
    // pure host-lifecycle fact with no runtime mutation epoch at all.
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

      // A settling writer may enqueue another tracked tail. Drain all OTHER
      // operations to a fixed point while the F7 latch refuses new mutations;
      // exclude this operation itself to avoid a self-wait deadlock.
      await writeFence.drainOtherOperations(operation)

      // Authority may have changed while an already-accepted writer settled.
      // F7 is legal only for the still-active override at an authoritative
      // restart-exhausted terminal state; builtin/env never mutate metadata.
      if (writeFence.isDisposed() || writeFence.abortSignal.aborted || envPath !== null
        || plane.connectionState !== 'restart-exhausted') return
      const active = facts.resolveWorkspace()
      if (active.source !== 'override' || active.version === null) return

      // Rollback-vs-lease serialization (design 21 §6.3 decision 6/17, F7
      // gate): the transaction's restore step writes DSH_HOME BEFORE
      // the only lease-aware point (the spawn checkpoint inside
      // plane.startLocal) — a plugin mutation whose pnpm child is live under
      // a held profile-write lease must drain first, or this rollback would
      // write DSH_HOME under a concurrent writer. New leases cannot start
      // while this latch is armed (beginProfileWrite refusal matrix below),
      // so the wait only drains already-held leases. A lease that outlives
      // the bound DEFERS the rollback with NO writes: the instance stays in
      // restart-exhausted with its existing honest projection and
      // start remains available; restore-builtin stays restricted to
      // pending/healthy selections (recovery-marked states
      // expose only their matching retry). The next restart-exhausted
      // edge (or gateway restart) re-arms it. dispose() aborts the wait, so
      // shutdown never stalls behind an undrained lease even though index.ts
      // disposes the manager before the executor releases those leases.
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
        // Exactly-once/crash-recovery latch: this durable rollback-needed
        // record MUST precede candidate mutation, host stop, pointer switch,
        // or DSH_HOME restore. Preserve a concurrently queued next intent so
        // shared startup can re-arm it only after reaching a safe fallback.
        writeActivationJournal(baseDir, {
          ...plan.journal,
          nextIntent: plan.deferredIntent,
        })
      }
      // `already-in-recovery` is itself durable proof; `planned` reaches here
      // only after the write above succeeded. The catch path must not stop a
      // host if creating the F7 latch failed — the shared planner explicitly
      // forbids every rollback side effect before durable rollback-needed.
      rollbackDurablyLatched = true

      setRestartOutcome('failed')
      setOperationError(`dsh v${failedVersion} exhausted managed restarts; automatic rollback in progress`)

      let result: Awaited<ReturnType<typeof runStartupPhase>>
      writeFence.beginActivation()
      try {
        // A version that exhausted the authoritative host restart policy can
        // no longer earn known-good promotion, even if the following restore
        // itself needs an operator retry.
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

      // Candidate/fallback probes may leave a process alive, but the normal
      // host/exposure lifecycle is re-synchronized only after quarantine has
      // closed. A dispose that raced the probe permanently suppresses this
      // recovery start; dispose's final stop is the ownership-release proof.
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
    // cancel handle. Permanently fence this abandoned closure before releasing
    // the self-acquired lease; any later queued tick becomes a pure no-op.
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
      // CONTRACT (design 18 §9.3): resolve ≠ success — restartLocal() also
      // resolves from restart-exhausted / error / stopped (the shared window
      // or a concurrent stop); project that honestly instead of a false 'ok'
      // (the settings poll must not show「已重启」for a restart that never
      // reached ready).
      const connectionState = plane.connectionState
      // Whitelist: restartLocal() resolves from
      // restart-exhausted / error / stopped AND can bail on an epoch bump
      // while 'restarting' is still the live state — every non-ready settle
      // is a failure; only ready/degraded (process alive) count as success.
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
   * Decision-12 start primitive (design 21 §6.3 r1): bring the managed dsh up
   * from stopped/error/restart-exhausted through the plane's guarded
   * startLocal path. Every synchronous refusal runs BEFORE any plane effect:
   * a second start in flight, any runtime mutation/profile write in flight
   * (assertMutationIdle), a recovery block or ordinary pending (the start
   * surface never bypasses the recovery gate: retry / recover-metadata;
   * restore-builtin applies to pending/healthy selections only), and a
   * connection state
   * outside the start window. 202 semantics — the route answers synchronously
   * from these gates and the outcome is projected via status().start /
   * operationError (resolve ≠ success: a resolve that did not reach ready is
   * 'failed', exactly like restart()).
   */
  async function start(): Promise<void> {
    if (writeFence.isStartInFlight()) {
      // Same code/message as the route /start pre-gate
      // (startAlreadyInFlightRefusal).
      throw refusalError(startAlreadyInFlightRefusal())
    }
    assertMutationIdle()
    // Recovery gate (decision 12: "恢复门不可绕过"): an in-memory startup
    // block is the authoritative recovery verdict; only its matching retry
    // (recover-metadata for FATAL) may run — restore-builtin applies to
    // pending/healthy selections only (an armed reset is
    // re-blocked by the shared core against durable recovery markers, so the
    // recovery surface never includes it). F7's auto-rollback tail and
    // gateway-boot blocks all land here, so a raw start can never skip the
    // probe/restore gate.
    const blockReason = getStartupBlockReason()
    if (blockReason !== null) {
      throw refusalError(recoveryRetryRequiredRefusal(blockReason))
    }
    // Durable ordinary pending (mirror restart): the armed switch is consumed
    // by the startup transaction, not by a bare spawn of the old workspace.
    assertNoPending()
    const connectionState = plane.connectionState
    if (connectionState !== 'stopped' && connectionState !== 'error' && connectionState !== 'restart-exhausted') {
      // Same code/message as the route /start pre-gate
      // (startNotApplicableRefusal).
      throw refusalError(startNotApplicableRefusal(connectionState))
    }
    writeFence.setStartInFlight(true)
    setStartOutcome('running')
    // A fresh start epoch supersedes any earlier restart verdict (e.g. an F7
    // auto-rollback 'failed' marker) — the poll must not echo the old verdict
    // while the r1 recovery is in progress.
    setRestartOutcome(null)
    try {
      await plane.startLocal()
      // CONTRACT (restart parity): resolve ≠ success — startLocal() resolves
      // only after its spawn settles, but a concurrent stop/epoch bump can
      // land the machine on stopped/error/restart-exhausted; only a live
      // ready/degraded settle counts as 'ok'.
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
      // The callback itself is fenced by `disposed`, so a scheduler adapter
      // cancellation failure cannot retain runtime writer authority or skip
      // the real abort/drain/final-stop proof.
      logger.warn(`gateway runtime known-good scheduler cancellation failed: ${sanitizeErrorText(String(error))}`)
    }
    writeFence.abortLifecycle()
    disposePromise = (async () => {
      // Epoch-fence any startLocal() that is currently waiting for readiness.
      // A later rollback probe is allowed to finish honestly; the second stop
      // below is the final process-quiescence proof.
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

      // Abort can intentionally hand an already-started rollback probe a fresh
      // signal. Stop once more after every writer settles so no recovery spawn
      // survives ownership release.
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

      // Only a directly constructed manager owns a lease to release; an
      // adopted createGateway handle belongs to the gateway, which releases it
      // in stop() after this dispose proved the runtime writers quiescent.
      releaseSelfLease()
    })()
    return disposePromise
  }

  return { pruneStoreIfNeeded: runStorePruneIfNeeded, observeLocalState, restart, start, dispose }
}
