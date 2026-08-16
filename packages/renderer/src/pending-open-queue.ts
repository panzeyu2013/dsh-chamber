interface PendingOpen {
  sessionId: string
  resolve(): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
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

  flush(instanceId: string, dispatch: (sessionId: string) => Promise<void>): number {
    const queued = this.#take(instanceId)
    for (const pending of queued) {
      try {
        void dispatch(pending.sessionId).then(pending.resolve, pending.reject)
      } catch (error) {
        // A synchronous throw from dispatch must not strand the pending
        // promise: #take already cleared its timer, so settle it explicitly.
        pending.reject(error instanceof Error ? error : new Error(String(error)))
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
