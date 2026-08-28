interface PendingOpen {
  sessionId: string
  /** Absolute total-wait deadline captured at enqueue; flush must not reset it. */
  deadline: number
  resolve(): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** Normalize arbitrary synchronous dispatch failures without letting a
 * hostile thrown value's prototype/message/string traps throw a second time.
 * `flush()` has already removed the queue entry and cleared its timer, so its
 * catch path must always return a real Error and settle the original promise. */
function safeDispatchError(reason: unknown): Error {
  try {
    if (reason instanceof Error) {
      // Touch message while still inside the guard: an Error subclass or Proxy
      // may expose a throwing accessor even though instanceof itself succeeds.
      if (typeof reason.message === 'string') return reason
    }
  } catch {
    // Fall through to the separately guarded primitive conversion.
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
    return new Promise((resolve, reject) => {
      const queued = this.#byInstance.get(instanceId) ?? []
      const pending = {} as PendingOpen
      pending.sessionId = sessionId
      pending.deadline = Date.now() + this.#timeoutMs
      pending.resolve = resolve
      pending.reject = reject
      pending.timer = setTimeout(() => {
        const current = this.#byInstance.get(instanceId)
        if (current === undefined) return
        const remaining = current.filter(candidate => candidate !== pending)
        if (remaining.length === 0) this.#byInstance.delete(instanceId)
        else this.#byInstance.set(instanceId, remaining)
        reject(new Error(`实例 ${instanceId} 启动超时，会话 ${sessionId} 未打开`))
      }, this.#timeoutMs)
      queued.push(pending)
      this.#byInstance.set(instanceId, queued)
    })
  }

  flush(instanceId: string, dispatch: (sessionId: string, deadline: number) => Promise<void>): number {
    const queued = this.#take(instanceId)
    for (const pending of queued) {
      try {
        void dispatch(pending.sessionId, pending.deadline).then(pending.resolve, pending.reject)
      } catch (error) {
        // A synchronous throw from dispatch must not strand the pending
        // promise: #take already cleared its timer, so settle it explicitly.
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
    for (const pending of queued) clearTimeout(pending.timer)
    return queued
  }
}
