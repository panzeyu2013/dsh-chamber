/**
 * Async operation primitives: deadline, retry pacing, bounded wait and
 * single-flight, with the scheduler INJECTED.
 *
 * WHY. The same five waiting shapes are hand-written at least seven times
 * (remote-stream.ts's retry lane, stream-client.ts's opening deadline/handshake,
 * journal-stream.ts's read deadline, pending-open-queue.ts, waitForServing,
 * host-graph.ts's own 10x500ms loop, baseline-harvest's deadlines) - each with its
 * own timer bookkeeping. The most expensive class of bug lives exactly there: a
 * timer that is never armed, a wait whose cancellation path forgets to clear, an
 * abort that resolves instead of rejecting.
 *
 * PURITY CONTRACT. This module imports NOTHING - not even `node:` builtins - so it
 * can be consumed by browser code. Everything ambient arrives on {@link Scheduler}:
 * real callers pass `setTimeout`/`clearTimeout`, tests pass a deterministic fake.
 * A module that reaches for a global clock is a gate failure, not a style nit.
 *
 * SEMANTICS:
 *  - a deadline settles the operation ONCE; the loser of the race is not cancelled
 *    behind the caller's back - the callback decides what the timeout MEANS
 *    (remote-stream's retry lane deliberately fails its inbox rather than aborting
 *    the generation signal, because aborting would settle the lane terminally);
 *  - retry delay is immediate on the first attempt, then doubles to a ceiling,
 *    counted per episode and reset whenever progress is accepted;
 *  - a bounded wait for an external condition resolves 'expired' instead of
 *    throwing: expiry is a recoverable outcome, not an error;
 *  - single-flight shares ONE in-flight promise, and a rejection frees the slot so
 *    the next caller can retry.
 */

export interface Scheduler {
  readonly setTimeout: (run: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export interface DeadlineOptions<T> {
  readonly ms: number
  /** What the deadline MEANS. Its return value becomes the operation's result when
   *  the deadline wins: 'timed-out' style values keep a recoverable outcome distinct
   *  from a thrown error. Never called after the operation settled. */
  readonly onExpire: () => T
  readonly scheduler: Scheduler
}

export interface DeadlineResult<T> {
  readonly settled: 'operation' | 'deadline'
  /** Present when `settled === 'operation'`. */
  readonly value?: T
}

/**
 * Race one operation against a deadline. The operation is given no signal: the
 * caller keeps its own cancellation (that separation is what lets a timeout reopen
 * a stream instead of terminating it). A rejecting operation rejects this call; an
 * expiry resolves with the caller's sentinel. Exactly one timer is armed and always
 * cleared.
 */
export async function withDeadline<T>(
  operation: Promise<T>,
  options: DeadlineOptions<T>,
): Promise<DeadlineResult<T>> {
  let handle: unknown
  let fired = false
  const deadline = new Promise<DeadlineResult<T>>((resolve) => {
    handle = options.scheduler.setTimeout(() => {
      fired = true
      resolve({ settled: 'deadline', value: options.onExpire() })
    }, options.ms)
  })
  try {
    const settled = await Promise.race([
      operation.then((value) => ({ settled: 'operation' as const, value })),
      deadline,
    ])
    return settled
  } finally {
    // The timer can only exist before the race settles; clearing an already-fired
    // handle is harmless, and clearing it on the operation path is the whole point.
    options.scheduler.clearTimeout(handle)
    void fired
  }
}

export interface BoundedWaitOptions {
  /** How often to re-inspect the condition. */
  readonly pollMs: number
  /** Absolute bound: expiry resolves 'expired', it never throws. */
  readonly boundMs: number
  readonly scheduler: Scheduler
  readonly isDone: () => boolean
  /**
   * Optional clock. Supplying it makes `boundMs` a WALL-CLOCK budget; omitting it
   * keeps the original TICK-COUNTED bound (`pollMs` accumulated per inspection).
   *
   * The two are not interchangeable: a tick-counted bound overruns in wall-clock
   * terms whenever the event loop is delayed (one 700ms stall turns a 240-tick,
   * 250ms-poll budget into ~168s of real time). A caller whose bound is a promise
   * to a user - "60s of boot budget" - must therefore pass a clock; a caller whose
   * bound only paces retries may keep the cheaper default. This option exists so
   * that choice is explicit instead of implicit.
   */
  readonly now?: () => number
}

export type WaitOutcome = 'done' | 'expired' | 'aborted'

/**
 * Wait for an external condition, bounded, cancellable and never leaking a timer.
 * 
 * The condition is checked BEFORE the first timer is armed: a condition that is
 * already true must not pay one poll interval — arming the timer first and relying
 * on `finish` to clear it is easy to get wrong.
 */
export function waitForCondition(options: BoundedWaitOptions, signal?: AbortSignal): Promise<WaitOutcome> {
  return new Promise<WaitOutcome>((resolve) => {
    let handle: unknown
    let elapsed = 0
    let settled = false
    // With a clock the bound is read from it; otherwise `elapsed` accumulates polls.
    const anchoredAt = options.now?.() ?? 0
    const elapsedMs = (): number => {
      if (options.now === undefined) return elapsed
      const measured = options.now() - anchoredAt
      // A rolled-back or unusable clock must not extend the wait: clamp to 0 and
      // keep inspecting (the next inspection re-reads it).
      return Number.isFinite(measured) && measured > 0 ? measured : 0
    }
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return
      settled = true
      options.scheduler.clearTimeout(handle)
      signal?.removeEventListener('abort', aborted)
      resolve(outcome)
    }
    const aborted = (): void => finish('aborted')
    const inspect = (): void => {
      if (options.isDone()) return finish('done')
      if (elapsedMs() >= options.boundMs) return finish('expired')
      elapsed += options.pollMs
      handle = options.scheduler.setTimeout(inspect, options.pollMs)
    }
    if (signal?.aborted === true) return finish('aborted')
    signal?.addEventListener('abort', aborted, { once: true })
    inspect()
  })
}

