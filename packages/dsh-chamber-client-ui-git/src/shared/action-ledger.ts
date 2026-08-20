import type { GitBusyState } from './types.ts'

export interface GitActionLease {
  readonly sourceId: string
  readonly busy: GitBusyState
  readonly token: symbol
}

/**
 * Mutation authority lives outside projection state: disconnect/reconnect may
 * rebuild a source row, but it cannot release an in-flight operation lease.
 */
export class GitActionLedger {
  private readonly leases = new Map<string, GitActionLease>()

  begin(sourceId: string, busy: GitBusyState): GitActionLease | undefined {
    if (this.leases.has(sourceId)) return undefined
    const lease = { sourceId, busy, token: Symbol(sourceId) }
    this.leases.set(sourceId, lease)
    return lease
  }

  current(sourceId: string): GitBusyState | undefined {
    return this.leases.get(sourceId)?.busy
  }

  end(lease: GitActionLease): boolean {
    if (this.leases.get(lease.sourceId)?.token !== lease.token) return false
    this.leases.delete(lease.sourceId)
    return true
  }
}
