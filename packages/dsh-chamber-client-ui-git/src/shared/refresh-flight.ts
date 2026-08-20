/** Per-key single flight with at most one coalesced forced successor. */
export class SerializedRefreshes<T> {
  private readonly running = new Map<string, Promise<T>>()
  private readonly successors = new Map<string, Promise<T>>()

  run(sourceId: string, force: boolean, task: () => Promise<T>): Promise<T> {
    const current = this.running.get(sourceId)
    if (current === undefined) return this.launch(sourceId, task)
    if (!force) return current

    const queued = this.successors.get(sourceId)
    if (queued !== undefined) return queued
    const startSuccessor = (): Promise<T> => {
      // A regular caller may have occupied the tiny completion→successor
      // window. Its pull is already the desired successor, so join it.
      const latest = this.running.get(sourceId)
      if (latest !== undefined && latest !== current) return latest
      return this.launch(sourceId, task)
    }
    const successor = current.then(startSuccessor, startSuccessor).finally(() => {
      if (this.successors.get(sourceId) === successor) this.successors.delete(sourceId)
    })
    this.successors.set(sourceId, successor)
    return successor
  }

  private launch(sourceId: string, task: () => Promise<T>): Promise<T> {
    const running = task().finally(() => {
      if (this.running.get(sourceId) === running) this.running.delete(sourceId)
    })
    this.running.set(sourceId, running)
    return running
  }
}
