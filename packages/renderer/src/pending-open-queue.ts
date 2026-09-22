import { waitForCondition } from '@dsh-chamber/dsh-stream-state'

/** The real clock, injected: the package itself imports nothing. */
const WAIT_SCHEDULER = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

interface PendingOpen {
  sessionId: string
  /** Absolute total-wait deadline captured at enqueue; flush must not reset it. */
  deadline: number
  resolve(): void
  reject(error: Error): void
  /** Cancel this entry's own bound. Called by #take: a taken entry must never
   *  settle by its own deadline any more (that is what the hand-written timer's
   *  `clearTimeout` used to do). */
  cancel(): void
}

/** Normalize arbitrary synchronous dispatch failures without letting a
 * hostile thrown value's prototype/message/string traps throw a second time.
 * `flush()` has already removed the queue entry and cancelled its bound, so its
 * catch path must always return a real Error and settle the original promise. */
function safeDispatchError(reason: unknown): Error {
  try {
    if (reason instanceof Error) {
      // Touch message while still inside the guard: an Error subclass or Proxy
      // may expose a throwing accessor even though instanceof itself succeeds.
      if (typeof reason.message === 'string') return reason
    }
  } catch {
  }
  try {
    const text = String(reason)
    return new Error(text === '' ? 'unknown error' : text)
  } catch {
    return new Error('unknown error')
  }
}

/** Deferred session opens whose promises follow the eventual runtime dispatch. */
export class PendingOpenQueue {
  readonly #byInstance = new Map<string, PendingOpen[]>()
  readonly #timeoutMs: number

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs
  }

  enqueue(instanceId: string, sessionId: string): Promise<void> {
    //  (W5): the bound is the shared primitive. One deadline is expressed as
    // pollMs === boundMs (the first inspection equals the whole window), and the
    // cancellation the old #take did with `clearTimeout` is now an AbortSignal -
    // that separation is exactly why waitForCondition is the right primitive here
    // and withDeadline is not: it exposes no cancel handle at all.
    const controller = new AbortController()
    let entry: PendingOpen | undefined
    // The executor runs synchronously, so `entry` is assigned before the wait starts.
    const deferred = new Promise<void>((resolve, reject) => {
      const queued = this.#byInstance.get(instanceId) ?? []
      const pending = {} as PendingOpen
      pending.sessionId = sessionId
      pending.deadline = Date.now() + this.#timeoutMs
      pending.resolve = resolve
      pending.reject = reject
      pending.cancel = () => controller.abort()
      entry = pending
      queued.push(pending)
      this.#byInstance.set(instanceId, queued)
    })
    void waitForCondition(
      {
        pollMs: this.#timeoutMs,
        boundMs: this.#timeoutMs,
        scheduler: WAIT_SCHEDULER,
        isDone: () => false,
      },
      controller.signal,
    ).then((outcome) => {
      // 'aborted' means #take already removed this entry (the caller's own bound
      // settles it); only 'expired' is this queue's business.
      if (outcome !== 'expired') return
      if (entry === undefined) return
      this.#drop(instanceId, entry)
      entry.reject(new Error(`实例 ${instanceId} 启动超时，会话 ${sessionId} 未打开`))
    })
    return deferred
  }

  /** Drop ONE pending entry (the deadline's own bookkeeping). */
  #drop(instanceId: string, entry: PendingOpen): void {
    const current = this.#byInstance.get(instanceId)
    if (current === undefined) return
    const remaining = current.filter(candidate => candidate !== entry)
    if (remaining.length === 0) this.#byInstance.delete(instanceId)
    else this.#byInstance.set(instanceId, remaining)
  }

  flush(instanceId: string, dispatch: (sessionId: string, deadline: number) => Promise<void>): number {
    const queued = this.#take(instanceId)
    for (const pending of queued) {
      try {
        void dispatch(pending.sessionId, pending.deadline).then(pending.resolve, pending.reject)
      } catch (error) {
        // A synchronous throw from dispatch must not strand the pending
        // promise: #take already cancelled its bound, so settle it explicitly.
        pending.reject(safeDispatchError(error))
      }
    }
    return queued.length
  }

  reject(instanceId: string, error: Error): number {
    const queued = this.#take(instanceId)
    for (const pending of queued) pending.reject(error)
    return queued.length
  }

  rejectAll(error: Error): number {
    let count = 0
    for (const instanceId of [...this.#byInstance.keys()]) count += this.reject(instanceId, error)
    return count
  }

  #take(instanceId: string): PendingOpen[] {
    const queued = this.#byInstance.get(instanceId) ?? []
    this.#byInstance.delete(instanceId)
    // A taken entry must not settle by its own deadline: aborting makes the
    // primitive resolve 'aborted' and drop its timer.
    for (const pending of queued) pending.cancel()
    return queued
  }
}
