/**
 * Gateway runtime write fence: every synchronous latch a runtime writer shares
 * with the manager — the activation quarantine window, the writer single-flight
 * flags, the managed profile-write lease, the internal-spawn latch and the
 * lifecycle writer epoch (dispose / abort / tracked operations).
 *
 * The manager holds one instance and hands it to the other runtime modules as an
 * explicit handle: the counters and flags are single-sourced here, and every
 * derived predicate (activationInProgress, mutationInProgress,
 * exposureQuarantined, the metadata projection's writer-busy gate) reads the
 * live value. The profile-write REFUSAL matrix stays in runtime-actions.ts.
 */
import type { Logger } from '@dsh-chamber/control-plane'
import { sanitizeErrorText } from '@dsh-chamber/dsh-runtime'

export interface RuntimeWriteFenceDeps {
  logger: Logger
  /** Live in-memory startup verdict: exposureQuarantined() outlives the
   *  activation window on every startup block except snapshot-failed. */
  getStartupBlockReason(): string | null
  /** Host composition hook: detach dsh-derived consumers as soon as a
   *  quarantine opens, and explicitly resync after the verdict. A failure is
   *  logged, never rolled back (see below). */
  onQuarantineChange?: ((active: boolean) => void) | undefined
}

export interface RuntimeWriteFence {
  markDisposed(): void
  isDisposed(): boolean
  abortLifecycle(): void
  readonly abortSignal: AbortSignal
  trackOperation<T>(operation: Promise<T>): Promise<T>
  drainOperations(): Promise<void>
  /** Drain every tracked operation except `operation` to a fixed point (a
   *  rollback drains prior writers while its own latch refuses new ones). */
  drainOtherOperations(operation: Promise<unknown>): Promise<void>
  assertManagerReadable(): void
  publishQuarantine(active: boolean): void
  beginActivation(): void
  endActivation(): void
  activationInProgress(): boolean
  exposureQuarantined(): boolean
  beginInternalSpawn(): void
  endInternalSpawn(): void
  internalSpawnActive(): boolean
  setInstallInFlight(value: boolean): void
  isInstallInFlight(): boolean
  setRestartInFlight(value: boolean): void
  isRestartInFlight(): boolean
  setApplyNowInFlight(value: boolean): void
  isApplyNowInFlight(): boolean
  setRestartExhaustedRollbackInFlight(value: boolean): void
  isRestartExhaustedRollbackInFlight(): boolean
  setStartInFlight(value: boolean): void
  isStartInFlight(): boolean
  mutationInProgress(): boolean
  /** Metadata-projection predicate: the in-flight matrix WITHOUT start. */
  metadataWriterBusy(): boolean
  profileWriteInFlight(): boolean
  /** Increment the lease counter; refusals are the caller's gate, so this never fails. */
  acquireProfileWrite(): { release(): void }
  /** Resolve 'idle' the moment the counter hits zero, 'timeout' when
   *  timeoutMs elapses or the lifecycle abort fires. Never rejects. */
  waitForProfileWriteIdle(timeoutMs: number): Promise<'idle' | 'timeout'>
  openHealthWindow(): void
  closeHealthWindow(): void
  healthWindowOpen(): boolean
}

export function createRuntimeWriteFence(deps: RuntimeWriteFenceDeps): RuntimeWriteFence {
  const { logger } = deps

  // Lifecycle writer epoch: every public mutation is tracked through its complete
  // promise, while the abort signal reaches candidate probes/install children;
  // dispose() keeps the lease until both sets are demonstrably quiescent.
  let disposed = false
  const lifecycleAbort = new AbortController()
  const activeOperations = new Set<Promise<unknown>>()

  let activationDepth = 0
  /** Managed profile-write lease counter. A count (not a bool) lets the executor
   * nest per-operation acquisitions inside a wider queue-drain lease; the barrier
   * opens only at zero. Writers of the two families never interleave: runtime
   * writers refuse while it is non-zero, beginProfileWrite while any is live. */
  let profileWriteCount = 0
  /** Waiters for the rollback-vs-lease drain; release() resolves them at zero. */
  const profileWriteIdleWaiters = new Set<() => void>()

  let internalSpawn = false
  let installInFlight = false
  let restartInFlight = false
  let applyNowInFlight = false
  let restartExhaustedRollbackInFlight = false
  let startInFlight = false
  let localHealthWindowOpen = false

  function publishQuarantine(active: boolean): void {
    try {
      deps.onQuarantineChange?.(active)
    } catch (error) {
      // Runtime safety must not be rolled back because an optional derived feature
      // consumer failed to resync; the next local-state transition can retry.
      logger.warn(`gateway runtime activation resync failed: ${sanitizeErrorText(String(error))}`)
    }
  }

  function beginActivation(): void {
    activationDepth += 1
    if (activationDepth === 1) publishQuarantine(true)
  }

  function endActivation(): void {
    if (activationDepth <= 0) throw new Error('gateway runtime activation gate underflow')
    activationDepth -= 1
    // Disposal is a permanent quarantine. A rollback probe may honestly finish
    // after the lifecycle abort, but its endActivation() must never publish a
    // false "open" edge while the final stop proof is pending.
    if (activationDepth === 0 && !disposed) publishQuarantine(false)
  }

  function activationInProgress(): boolean {
    // `disposed` is intentionally sticky: once lifecycle quiescence starts, this
    // manager can never expose or start the managed runtime again, and exposure
    // stays closed when a rollback probe ends before dispose()'s final barrier.
    return disposed || activationDepth > 0
  }

  function exposureQuarantined(): boolean {
    // Snapshot failure happens before the pointer is touched, so callers may
    // safely restart the unchanged source after the activation window closes;
    // every other startup block stays quarantined until a retry clears it.
    const startupBlockReason = deps.getStartupBlockReason()
    return activationInProgress()
      || (startupBlockReason !== null && startupBlockReason !== 'snapshot-failed')
  }

  function mutationInProgress(): boolean {
    return activationInProgress() || installInFlight || restartInFlight || applyNowInFlight
      || restartExhaustedRollbackInFlight || startInFlight
  }

  function metadataWriterBusy(): boolean {
    return activationInProgress() || installInFlight || restartInFlight || applyNowInFlight
      || restartExhaustedRollbackInFlight
  }

  function profileWriteInFlight(): boolean {
    return profileWriteCount > 0
  }

  function releaseProfileWrite(): void {
    if (profileWriteCount <= 0) throw new Error('gateway runtime profile write lease underflow')
    profileWriteCount -= 1
    // Release only decrements, so a release landing after dispose() still opens
    // the barrier and resolves waiters; dispose() aborts any pending wait.
    if (profileWriteCount === 0 && profileWriteIdleWaiters.size > 0) {
      for (const wake of [...profileWriteIdleWaiters]) wake()
    }
  }

  function waitForProfileWriteIdle(timeoutMs: number): Promise<'idle' | 'timeout'> {
    if (lifecycleAbort.signal.aborted || !profileWriteInFlight()) {
      return Promise.resolve(lifecycleAbort.signal.aborted ? 'timeout' : 'idle')
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      const onAbort = (): void => finish('timeout')
      function finish(outcome: 'idle' | 'timeout'): void {
        clearTimeout(timer)
        profileWriteIdleWaiters.delete(wake)
        lifecycleAbort.signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      function wake(): void {
        if (!profileWriteInFlight()) finish('idle')
      }
      profileWriteIdleWaiters.add(wake)
      lifecycleAbort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  function trackOperation<T>(operation: Promise<T>): Promise<T> {
    activeOperations.add(operation)
    void operation.then(
      () => { activeOperations.delete(operation) },
      () => { activeOperations.delete(operation) },
    )
    return operation
  }

  async function drainOperations(): Promise<void> {
    // A settling operation can enqueue its detached apply-now job before its
    // own promise resolves, so drain to a fixed point rather than one snapshot.
    while (activeOperations.size > 0) {
      await Promise.allSettled([...activeOperations])
    }
  }

  async function drainOtherOperations(operation: Promise<unknown>): Promise<void> {
    // A settling writer may enqueue another tracked tail: drain all OTHER
    // operations to a fixed point (excluding this one, to avoid a self-wait).
    while (true) {
      const blockers = [...activeOperations].filter(candidate => candidate !== operation)
      if (blockers.length === 0) break
      await Promise.allSettled(blockers)
    }
  }

  function assertManagerReadable(): void {
    if (disposed) {
      throw Object.assign(new Error('gateway runtime manager is disposed'), { code: 'runtime_disposed' })
    }
  }

  return {
    markDisposed: () => { disposed = true },
    isDisposed: () => disposed,
    abortLifecycle: () => lifecycleAbort.abort(),
    abortSignal: lifecycleAbort.signal,
    trackOperation,
    drainOperations,
    drainOtherOperations,
    assertManagerReadable,
    publishQuarantine,
    beginActivation,
    endActivation,
    activationInProgress,
    exposureQuarantined,
    beginInternalSpawn: () => { internalSpawn = true },
    endInternalSpawn: () => { internalSpawn = false },
    internalSpawnActive: () => internalSpawn,
    setInstallInFlight: (value) => { installInFlight = value },
    isInstallInFlight: () => installInFlight,
    setRestartInFlight: (value) => { restartInFlight = value },
    isRestartInFlight: () => restartInFlight,
    setApplyNowInFlight: (value) => { applyNowInFlight = value },
    isApplyNowInFlight: () => applyNowInFlight,
    setRestartExhaustedRollbackInFlight: (value) => { restartExhaustedRollbackInFlight = value },
    isRestartExhaustedRollbackInFlight: () => restartExhaustedRollbackInFlight,
    setStartInFlight: (value) => { startInFlight = value },
    isStartInFlight: () => startInFlight,
    mutationInProgress,
    metadataWriterBusy,
    profileWriteInFlight,
    acquireProfileWrite: () => {
      profileWriteCount += 1
      return { release: () => { releaseProfileWrite() } }
    },
    waitForProfileWriteIdle,
    openHealthWindow: () => { localHealthWindowOpen = true },
    closeHealthWindow: () => { localHealthWindowOpen = false },
    healthWindowOpen: () => localHealthWindowOpen,
  }
}
