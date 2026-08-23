/**
 * Fair, process-local exclusive fence for every operation that can mutate
 * DSH_HOME or runtime-selection metadata. Privileged runtime transactions may
 * wait; renderer-triggered plugin mutations use tryAcquire and fail loud.
 */
export interface OperationLease {
  readonly owner: string
  release(): void
}

interface Waiter {
  owner: string
  resolve: (lease: OperationLease) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort?: () => void
}

export class RuntimeOperationFence {
  private activeOwner: string | null = null
  private readonly waiters: Waiter[] = []

  get busy(): boolean {
    return this.activeOwner !== null || this.waiters.length > 0
  }

  get owner(): string | null {
    return this.activeOwner
  }

  tryAcquire(owner: string): OperationLease | null {
    if (owner.length === 0 || this.activeOwner !== null || this.waiters.length > 0) return null
    this.activeOwner = owner
    return this.makeLease(owner)
  }

  acquire(owner: string, signal?: AbortSignal): Promise<OperationLease> {
    if (owner.length === 0) return Promise.reject(new Error('operation owner is required'))
    if (signal?.aborted) return Promise.reject(new Error('operation acquisition aborted'))
    const immediate = this.tryAcquire(owner)
    if (immediate !== null) return Promise.resolve(immediate)
    return new Promise<OperationLease>((resolve, reject) => {
      const waiter: Waiter = { owner, resolve, reject, signal }
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('operation acquisition aborted'))
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  private makeLease(owner: string): OperationLease {
    let released = false
    return {
      owner,
      release: () => {
        if (released) return
        released = true
        if (this.activeOwner !== owner) return
        this.activeOwner = null
        this.wakeNext()
      },
    }
  }

  private wakeNext(): void {
    while (this.activeOwner === null && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (waiter.abort !== undefined) waiter.signal?.removeEventListener('abort', waiter.abort)
      if (waiter.signal?.aborted) {
        waiter.reject(new Error('operation acquisition aborted'))
        continue
      }
      this.activeOwner = waiter.owner
      waiter.resolve(this.makeLease(waiter.owner))
    }
  }
}
