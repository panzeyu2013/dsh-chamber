/**
 * Async operation primitives (deadline, retry pacing, bounded wait, single-flight) with
 * the scheduler INJECTED.
 *
 * PURITY CONTRACT: imports NOTHING (not even `node:` builtins) so browser code can
 * consume it; everything ambient arrives on {@link Scheduler}. Reaching for a global
 * clock is a gate failure, not a style nit.
 *
 * SEMANTICS: a deadline settles the operation ONCE and does not cancel behind the
 * caller's back - `onExpire` decides what the timeout MEANS; retry delay is immediate on
 * the first attempt, then doubles to a ceiling per episode; a bounded wait resolves
 * 'expired' instead of throwing; single-flight shares ONE promise and a rejection frees
 * the slot.
 */

export interface Scheduler {
  readonly setTimeout: (run: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export interface DeadlineOptions<T> {
  readonly ms: number
  /** What the deadline MEANS; its return value becomes the result when the deadline
   *  wins. Never called after the operation settled. */
  readonly onExpire: () => T
  readonly scheduler: Scheduler
}

export interface DeadlineResult<T> {
  readonly settled: 'operation' | 'deadline'
  /** Present when `settled === 'operation'`. */
  readonly value?: T
}

/**
 * Race one operation against a deadline. The operation is given no signal: the caller
 * keeps its own cancellation, which is what lets a timeout reopen a stream instead of
 * terminating it. A rejecting operation rejects this call; an expiry resolves with the
 * caller's sentinel. Exactly one timer is armed and always cleared.
 */
export async function withDeadline<T>(
  operation: Promise<T>,
  options: DeadlineOptions<T>,
): Promise<DeadlineResult<T>> {
  // An unusable bound is not a deadline: setTimeout(run, NaN) fires at ~0 ms and would
  // expire immediately, so without a timer the operation itself governs.
  if (!Number.isFinite(options.ms) || options.ms < 0) {
    return operation.then((value) => ({ settled: 'operation' as const, value }))
  }
  let handle: unknown
  const deadline = new Promise<DeadlineResult<T>>((resolve, reject) => {
    try {
      handle = options.scheduler.setTimeout(() => {
        // onExpire decides what the deadline MEANS; its throw settles as a rejection.
        try {
          resolve({ settled: 'deadline', value: options.onExpire() })
        } catch (error) {
          reject(error)
        }
      }, options.ms)
    } catch (error) {
      reject(error)
    }
  })
  try {
    return await Promise.race([
      operation.then((value) => ({ settled: 'operation' as const, value })),
      deadline,
    ])
  } finally {
    // Clearing an already-fired handle is harmless; clearing on the operation path is the point.
    options.scheduler.clearTimeout(handle)
  }
}

export interface BoundedWaitOptions {
  readonly pollMs: number
  /** Absolute bound: expiry resolves 'expired', it never throws. */
  readonly boundMs: number
  readonly scheduler: Scheduler
  readonly isDone: () => boolean
  /**
   * Optional clock. Supplying it makes `boundMs` a WALL-CLOCK budget; omitting it keeps a
   * TICK-COUNTED bound (`pollMs` accumulated per inspection), which overruns in wall-clock
   * terms when the event loop stalls. A bound promised to a user must pass a clock; retry
   * pacing may keep the cheaper default.
   */
  readonly now?: () => number
}

export type WaitOutcome = 'done' | 'expired' | 'aborted'

/**
 * Wait for an external condition, bounded, cancellable and never leaking a timer. The
 * condition is checked BEFORE the first timer is armed: an already-true condition must
 * not pay one poll interval, and arming first while relying on `finish` to clear the
 * timer is easy to get wrong.
 */
export function waitForCondition(options: BoundedWaitOptions, signal?: AbortSignal): Promise<WaitOutcome> {
  // Invalid pacing is a programming error and a silent pass is worse than a throw:
  // setTimeout(run, NaN) hot-loops and a non-finite bound is not a deadline - fail loudly.
  if (!Number.isFinite(options.pollMs) || options.pollMs <= 0) {
    throw new RangeError('waitForCondition: pollMs must be a positive finite number, got ' + String(options.pollMs))
  }
  if (!Number.isFinite(options.boundMs) || options.boundMs < 0) {
    throw new RangeError('waitForCondition: boundMs must be a finite non-negative number, got ' + String(options.boundMs))
  }
  return new Promise<WaitOutcome>((resolve, reject) => {
    let handle: unknown
    let elapsed = 0
    let settled = false
    // With a clock the bound is read from it; otherwise `elapsed` accumulates polls.
    const anchoredAt = options.now?.() ?? 0
    const elapsedMs = (): number => {
      if (options.now === undefined) return elapsed
      const measured = options.now() - anchoredAt
      // A rolled-back or unusable clock must not extend the wait: clamp to 0 and keep inspecting.
      return Number.isFinite(measured) && measured > 0 ? measured : 0
    }
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return
      settled = true
      options.scheduler.clearTimeout(handle)
      signal?.removeEventListener('abort', aborted)
      resolve(outcome)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      options.scheduler.clearTimeout(handle)
      signal?.removeEventListener('abort', aborted)
      reject(error)
    }
    const aborted = (): void => finish('aborted')
    const inspect = (): void => {
      try {
        if (options.isDone()) return finish('done')
      } catch (error) {
        // A predicate that throws must settle the wait, not crash inside a timer callback.
        return fail(error)
      }
      if (elapsedMs() >= options.boundMs) return finish('expired')
      elapsed += options.pollMs
      handle = options.scheduler.setTimeout(inspect, options.pollMs)
    }
    if (signal?.aborted === true) return finish('aborted')
    signal?.addEventListener('abort', aborted, { once: true })
    inspect()
  })
}

